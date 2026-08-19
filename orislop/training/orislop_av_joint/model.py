from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, List, Tuple

import torch
from torch import Tensor, nn
from torch.nn import functional as F


QUALITY_FEATURES = (
    "face_coverage",
    "speech_ratio",
    "mouth_motion",
    "snr_db_scaled",
    "occlusion_ratio",
    "usable_seconds_scaled",
)


@dataclass(frozen=True)
class AVJointConfig:
    sample_rate: int = 16_000
    target_fps: int = 25
    initial_seconds: int = 2
    maximum_seconds: int = 8
    mouth_size: int = 112
    max_faces: int = 4
    embedding_dim: int = 256
    transformer_layers: int = 4
    transformer_heads: int = 8
    max_offset_frames: int = 10
    n_fft: int = 400
    hop_length: int = 160
    win_length: int = 400
    quality_features: int = len(QUALITY_FEATURES)

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


class OrislopAVJointV1(nn.Module):
    """Multitask active-speaker, synchronization, and AV-forgery model.

    Inputs are batched videos with a bounded face dimension. Every output is a
    Tensor so that the module can be wrapped and exported through TorchScript.
    Applicability gates intentionally live before this model.
    """

    def __init__(self, config: AVJointConfig) -> None:
        super().__init__()
        self.embedding_dim = int(config.embedding_dim)
        self.max_offset_frames = int(config.max_offset_frames)
        self.n_fft = int(config.n_fft)
        self.hop_length = int(config.hop_length)
        self.win_length = int(config.win_length)

        self.visual_encoder = nn.Sequential(
            # A 4x spatial stem keeps the four-face, eight-second escalation
            # window bounded without changing the 25 fps temporal semantics.
            nn.Conv3d(3, 32, kernel_size=(3, 7, 7), stride=(1, 4, 4), padding=(1, 3, 3), bias=False),
            nn.BatchNorm3d(32),
            nn.GELU(),
            nn.MaxPool3d((1, 2, 2)),
            nn.Conv3d(32, 64, kernel_size=3, stride=(1, 2, 2), padding=1, bias=False),
            nn.BatchNorm3d(64),
            nn.GELU(),
            nn.Conv3d(64, 128, kernel_size=3, stride=1, padding=1, bias=False),
            nn.BatchNorm3d(128),
            nn.GELU(),
        )
        self.audio_encoder = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=5, stride=(2, 2), padding=2, bias=False),
            nn.BatchNorm2d(32),
            nn.GELU(),
            nn.Conv2d(32, 64, kernel_size=3, stride=(2, 2), padding=1, bias=False),
            nn.BatchNorm2d(64),
            nn.GELU(),
            nn.Conv2d(64, 128, kernel_size=3, stride=(2, 1), padding=1, bias=False),
            nn.BatchNorm2d(128),
            nn.GELU(),
        )
        self.visual_projection = nn.Sequential(nn.Linear(128, config.embedding_dim), nn.LayerNorm(config.embedding_dim))
        self.audio_projection = nn.Sequential(nn.Linear(128, config.embedding_dim), nn.LayerNorm(config.embedding_dim))
        self.quality_projection = nn.Sequential(
            nn.Linear(config.quality_features, config.embedding_dim),
            nn.GELU(),
            nn.LayerNorm(config.embedding_dim),
        )
        fusion_layer = nn.TransformerEncoderLayer(
            d_model=config.embedding_dim,
            nhead=config.transformer_heads,
            dim_feedforward=config.embedding_dim * 4,
            dropout=0.15,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.cross_modal = nn.TransformerEncoder(fusion_layer, num_layers=config.transformer_layers)
        self.fusion_norm = nn.LayerNorm(config.embedding_dim)

        correlation_width = config.max_offset_frames * 2 + 1
        self.active_speaker_head = binary_head(config.embedding_dim * 2)
        self.sync_head = binary_head(config.embedding_dim * 3 + correlation_width)
        self.audio_spoof_head = binary_head(config.embedding_dim)
        self.visual_forgery_head = binary_head(config.embedding_dim)
        self.joint_forgery_head = binary_head(config.embedding_dim * 4 + correlation_width)
        self.segment_forgery_head = nn.Sequential(nn.LayerNorm(config.embedding_dim), nn.Linear(config.embedding_dim, 1))
        self.uncertainty_head = nn.Sequential(
            nn.Linear(config.embedding_dim * 2, 64),
            nn.GELU(),
            nn.Linear(64, 1),
            nn.Softplus(),
        )
        self.offset_scale = nn.Parameter(torch.tensor(10.0))
        self.register_buffer("hann_window", torch.hann_window(config.win_length), persistent=False)

    def audio_spectrogram(self, waveform: Tensor) -> Tensor:
        centered = waveform - waveform.mean(dim=1, keepdim=True)
        rms = centered.square().mean(dim=1, keepdim=True).sqrt().clamp_min(0.05)
        normalized = centered / rms
        spectrum = torch.stft(
            normalized,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.hann_window.to(device=waveform.device, dtype=waveform.dtype),
            center=True,
            return_complex=True,
        ).abs()
        return torch.log1p(spectrum)

    def encode(self, mouth_tracks: Tensor, waveform: Tensor) -> Tuple[Tensor, Tensor]:
        batch, faces, channels, frames, height, width = mouth_tracks.shape
        flattened = mouth_tracks.reshape(batch * faces, channels, frames, height, width)
        visual = self.visual_encoder(flattened).mean(dim=(-1, -2)).transpose(1, 2)
        visual = F.normalize(self.visual_projection(visual), dim=-1)

        audio = self.audio_encoder(self.audio_spectrogram(waveform).unsqueeze(1)).mean(dim=2).transpose(1, 2)
        audio = F.interpolate(audio.transpose(1, 2), size=visual.size(1), mode="linear", align_corners=False).transpose(1, 2)
        audio = F.normalize(self.audio_projection(audio), dim=-1)
        audio = audio[:, None].expand(batch, faces, audio.size(1), audio.size(2)).reshape(batch * faces, audio.size(1), audio.size(2))
        return visual, audio

    def correlation_curve(self, visual: Tensor, audio: Tensor) -> Tensor:
        correlations = torch.jit.annotate(List[Tensor], [])
        for offset in range(-self.max_offset_frames, self.max_offset_frames + 1):
            if offset < 0:
                visual_slice = visual[:, :offset]
                audio_slice = audio[:, -offset:]
            elif offset > 0:
                visual_slice = visual[:, offset:]
                audio_slice = audio[:, :-offset]
            else:
                visual_slice = visual
                audio_slice = audio
            correlations.append((visual_slice * audio_slice).sum(dim=-1).mean(dim=-1))
        return torch.stack(correlations, dim=1)

    def forward(
        self,
        mouth_tracks: Tensor,
        waveform: Tensor,
        track_mask: Tensor,
        quality: Tensor,
    ) -> Dict[str, Tensor]:
        batch, faces = mouth_tracks.size(0), mouth_tracks.size(1)
        visual, audio = self.encode(mouth_tracks, waveform)
        frames = visual.size(1)
        correlation = self.correlation_curve(visual, audio)
        visual_pool = visual.mean(dim=1)
        audio_pool = audio.mean(dim=1)
        quality_flat = quality.reshape(batch * faces, quality.size(-1))
        quality_embedding = self.quality_projection(quality_flat)

        fused_tokens = visual + audio + quality_embedding[:, None, :]
        flattened_mask = track_mask.reshape(batch * faces, track_mask.size(-1)).to(dtype=torch.bool)
        if flattened_mask.size(1) != frames:
            flattened_mask = F.interpolate(flattened_mask.float().unsqueeze(1), size=frames, mode="nearest").squeeze(1).to(dtype=torch.bool)
        safe_mask = flattened_mask.clone()
        empty_tracks = ~safe_mask.any(dim=1)
        safe_mask[empty_tracks, 0] = True
        fused_tokens = self.cross_modal(fused_tokens, src_key_padding_mask=~safe_mask)
        fused_tokens = self.fusion_norm(fused_tokens)
        weights = safe_mask.float().unsqueeze(-1)
        fused_pool = (fused_tokens * weights).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)

        active_speaker_logit = self.active_speaker_head(torch.cat((visual_pool, audio_pool), dim=1)).squeeze(1)
        sync_features = torch.cat((visual_pool, audio_pool, torch.abs(visual_pool - audio_pool), correlation), dim=1)
        sync_mismatch_logit = self.sync_head(sync_features).squeeze(1)
        audio_spoof_logit_batch = self.audio_spoof_head(audio.reshape(batch, faces, frames, -1)[:, 0].mean(dim=1)).squeeze(1)
        audio_spoof_logit = audio_spoof_logit_batch[:, None].expand(batch, faces).reshape(batch * faces)
        visual_forgery_logit = self.visual_forgery_head(visual_pool).squeeze(1)
        joint_features = torch.cat((fused_pool, visual_pool, audio_pool, quality_embedding, correlation), dim=1)
        joint_forgery_logit = self.joint_forgery_head(joint_features).squeeze(1)
        segment_forgery_logits = self.segment_forgery_head(fused_tokens).squeeze(-1)
        uncertainty = self.uncertainty_head(torch.cat((fused_pool, quality_embedding), dim=1)).squeeze(1).clamp_max(10.0)
        embedding = F.normalize(fused_pool, dim=-1)
        offset_logits = correlation * self.offset_scale.clamp(1.0, 30.0)

        shape = (batch, faces)
        return {
            "embedding": embedding.reshape(batch, faces, -1),
            "active_speaker_logit": active_speaker_logit.reshape(shape),
            "sync_mismatch_logit": sync_mismatch_logit.reshape(shape),
            "offset_logits": offset_logits.reshape(batch, faces, -1),
            "audio_spoof_logit": audio_spoof_logit.reshape(shape),
            "visual_forgery_logit": visual_forgery_logit.reshape(shape),
            "joint_forgery_logit": joint_forgery_logit.reshape(shape),
            "segment_forgery_logits": segment_forgery_logits.reshape(batch, faces, -1),
            "uncertainty": uncertainty.reshape(shape),
        }


class CalibratedAVJointExport(nn.Module):
    """Stable TorchScript contract consumed by the Temporal MoE wrapper."""

    def __init__(self, model: OrislopAVJointV1, temperatures: Dict[str, float]) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("joint_temperature", torch.tensor(max(0.05, temperatures.get("joint", 1.0))))
        self.register_buffer("sync_temperature", torch.tensor(max(0.05, temperatures.get("sync", 1.0))))
        self.register_buffer("audio_temperature", torch.tensor(max(0.05, temperatures.get("audio", 1.0))))
        self.register_buffer("visual_temperature", torch.tensor(max(0.05, temperatures.get("visual", 1.0))))
        self.register_buffer("speaker_temperature", torch.tensor(max(0.05, temperatures.get("active_speaker", 1.0))))
        self.register_buffer("uncertainty_scale", torch.tensor(max(0.05, temperatures.get("uncertainty", 1.0))))

    def forward(
        self,
        mouth_tracks: Tensor,
        waveform: Tensor,
        track_mask: Tensor,
        quality: Tensor,
    ) -> Dict[str, Tensor]:
        raw = self.model(mouth_tracks, waveform, track_mask, quality)
        joint_logit = raw["joint_forgery_logit"] / self.joint_temperature
        return {
            "embedding": raw["embedding"],
            "logit": joint_logit,
            "joint_fake_probability": torch.sigmoid(joint_logit),
            "active_speaker_probability": torch.sigmoid(raw["active_speaker_logit"] / self.speaker_temperature),
            "sync_mismatch_probability": torch.sigmoid(raw["sync_mismatch_logit"] / self.sync_temperature),
            "offset_probabilities": torch.softmax(raw["offset_logits"], dim=-1),
            "audio_spoof_probability": torch.sigmoid(raw["audio_spoof_logit"] / self.audio_temperature),
            "visual_forgery_probability": torch.sigmoid(raw["visual_forgery_logit"] / self.visual_temperature),
            "segment_forgery_probabilities": torch.sigmoid(raw["segment_forgery_logits"] / self.joint_temperature),
            "uncertainty": (1.0 - torch.exp(-raw["uncertainty"] / self.uncertainty_scale)).clamp(0.0, 1.0),
        }


def binary_head(input_dim: int) -> nn.Sequential:
    hidden = max(64, min(256, input_dim // 2))
    return nn.Sequential(
        nn.Linear(input_dim, hidden),
        nn.GELU(),
        nn.Dropout(0.15),
        nn.Linear(hidden, 1),
    )
