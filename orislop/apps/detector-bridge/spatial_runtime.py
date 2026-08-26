from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import math
import hashlib
import os
from pathlib import Path
import threading
from typing import Any

import cv2
import numpy as np
from PIL import Image
import torch
from torch import nn
from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor, pipeline
from huggingface_hub import hf_hub_download


SPATIAL_REPO_ID = os.environ.get("ORISLOP_SPATIAL_REPO_ID", "gonnerthetooner/orislop-fusion")
SPATIAL_CHECKPOINT = os.environ.get("ORISLOP_SPATIAL_CHECKPOINT", "fusion_model_cls_v2.pt")
SPATIAL_ENCODER_CONTRACT = "vit_cls_v2"
SPATIAL_CHECKPOINT_FORMAT = 2
PACKAGED_SPATIAL_CHECKPOINT = Path(__file__).resolve().parents[2] / "models" / "spatial" / SPATIAL_CHECKPOINT
PACKAGED_SPATIAL_SHA256 = "10a8d878f8cbd767c73014666bf19bf51f30fac485e2e33358da23b563f149df"
VISION_MODEL_ID = "google/vit-base-patch16-224"
VISION_MODEL_REVISION = "3f49326eb077187dfe1c2a2bb15fbd74e6ab91e3"
AI_MODEL_ID = "umm-maybe/AI-image-detector"
AI_MODEL_REVISION = "c7e223baf11bc40528af364ba7bdea030ef42f9e"
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
CLIP_MODEL_REVISION = "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"
VISION_MODEL_SOURCE = os.environ.get("ORISLOP_VISION_MODEL_SOURCE", VISION_MODEL_ID).strip() or VISION_MODEL_ID
AI_MODEL_SOURCE = os.environ.get("ORISLOP_AI_MODEL_SOURCE", AI_MODEL_ID).strip() or AI_MODEL_ID
CLIP_MODEL_SOURCE = os.environ.get("ORISLOP_CLIP_MODEL_SOURCE", CLIP_MODEL_ID).strip() or CLIP_MODEL_ID
TEXT_PROMPTS = ["a real photograph", "an AI generated image"]


def _pretrained_options(source: str, revision: str) -> dict[str, str]:
    """Pin remote models while allowing an integrity-verified local snapshot."""

    return {} if Path(source).expanduser().is_dir() else {"revision": revision}


def classifier_ai_probability(results: list[dict[str, Any]]) -> float:
    result = results[0] if results else {}
    score = float(result.get("score", 0.5))
    label = str(result.get("label", "")).lower()
    synthetic = any(token in label for token in ("fake", "ai", "synthetic", "generated", "artificial"))
    return float(np.clip(score if synthetic else 1.0 - score, 0.0, 1.0))


class LightweightSpatialDetector:
    """Fast provisional frame detector reused by the heavyweight spatial model."""

    def __init__(self, cache_dir: str | Path) -> None:
        self.cache_dir = str(Path(cache_dir).expanduser().resolve())
        self.ai_classifier = pipeline(
            "image-classification",
            model=AI_MODEL_SOURCE,
            device=-1,
            **_pretrained_options(AI_MODEL_SOURCE, AI_MODEL_REVISION),
        )
        self.ai_classifier_lock = threading.Lock()

    def analyze_video(self, video_path: str | Path, max_frames: int = 3) -> dict[str, Any]:
        images = sample_video_frames(video_path, max_frames=max_frames)
        if not images:
            raise RuntimeError("Lightweight detector could not decode any video frames")
        probabilities = [self.analyze_image(image) for image in images]
        probability = float(sum(probabilities) / len(probabilities))
        return {
            "available": True,
            "repo_id": AI_MODEL_ID,
            "ai_probability": probability,
            "confidence": probability if probability >= 0.5 else 1.0 - probability,
            "frames_analyzed": len(probabilities),
            "frame_probabilities": probabilities,
            "device": "cpu",
            "provisional": True,
        }

    def analyze_image(self, image: Image.Image) -> float:
        with self.ai_classifier_lock:
            return classifier_ai_probability(self.ai_classifier(image.convert("RGB")))


class VisionEncoder(nn.Module):
    """Frozen ViT encoder with a deterministic, versioned CLS-token contract."""

    def __init__(
        self,
        pretrained_id: str = VISION_MODEL_SOURCE,
        *,
        revision: str | None = VISION_MODEL_REVISION,
        processor: Any = None,
        backbone: nn.Module | None = None,
    ) -> None:
        super().__init__()
        load_options = _pretrained_options(pretrained_id, str(revision or VISION_MODEL_REVISION))
        self.processor = processor or AutoImageProcessor.from_pretrained(pretrained_id, **load_options)
        # The v1 runtime read pooler_output from a classifier checkpoint that did
        # not contain pooler weights. Transformers initialized that layer at
        # random on every process start. v2 removes the pooler entirely and uses
        # the pretrained CLS token, which is stable across runs.
        self.backbone = backbone or AutoModel.from_pretrained(
            pretrained_id,
            add_pooling_layer=False,
            **load_options,
        )
        for parameter in self.backbone.parameters():
            parameter.requires_grad = False
        self.backbone.eval()
        self.embedding_dim = int(getattr(self.backbone.config, "hidden_size", 768))

    @torch.no_grad()
    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        output = self.backbone(pixel_values=pixel_values)
        return output.last_hidden_state[:, 0, :]


class FusionDetector(nn.Module):
    def __init__(self, vision_dim: int, aux_dim: int = 3) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(vision_dim + aux_dim, 512),
            nn.LayerNorm(512),
            nn.GELU(),
            nn.Dropout(0.3),
            nn.Linear(512, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(256, 128),
            nn.LayerNorm(128),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(128, 1),
        )

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.net(features)


def _safe_torch_load(path: str | Path, device: torch.device) -> dict[str, Any]:
    try:
        return torch.load(path, map_location=device, weights_only=True)
    except TypeError:
        return torch.load(path, map_location=device)


def validate_spatial_checkpoint(payload: dict[str, Any]) -> tuple[dict[str, torch.Tensor], dict[str, Any]]:
    """Validate the deterministic v2 checkpoint contract before loading weights."""

    metadata = payload.get("metadata")
    state = payload.get("fusion_state_dict")
    if not isinstance(metadata, dict) or not isinstance(state, dict):
        raise RuntimeError(
            "Unsafe legacy spatial checkpoint rejected: it has no deterministic encoder contract. "
            "Train/export fusion_model_cls_v2.pt before enabling the heavyweight spatial detector."
        )
    if int(metadata.get("format_version", 0)) != SPATIAL_CHECKPOINT_FORMAT:
        raise RuntimeError(f"Unsupported spatial checkpoint format: {metadata.get('format_version')!r}")
    if metadata.get("encoder_contract") != SPATIAL_ENCODER_CONTRACT:
        raise RuntimeError(
            "Spatial checkpoint encoder mismatch: "
            f"expected {SPATIAL_ENCODER_CONTRACT!r}, got {metadata.get('encoder_contract')!r}"
        )
    if metadata.get("vision_model_id") != VISION_MODEL_ID:
        raise RuntimeError(
            f"Spatial checkpoint ViT mismatch: expected {VISION_MODEL_ID!r}, "
            f"got {metadata.get('vision_model_id')!r}"
        )
    expected_revisions = {
        "vision_model_revision": VISION_MODEL_REVISION,
        "ai_model_revision": AI_MODEL_REVISION,
        "clip_model_revision": CLIP_MODEL_REVISION,
    }
    for name, expected in expected_revisions.items():
        if metadata.get(name) != expected:
            raise RuntimeError(
                f"Spatial checkpoint backbone revision mismatch for {name}: "
                f"expected {expected!r}, got {metadata.get(name)!r}"
            )
    if not state or not all(isinstance(key, str) and torch.is_tensor(value) for key, value in state.items()):
        raise RuntimeError("Spatial checkpoint fusion_state_dict is empty or malformed")
    return state, metadata


class SpatialDetector:
    """Deterministic v2 spatial fusion runtime with legacy-checkpoint protection."""

    def __init__(
        self,
        cache_dir: str | Path,
        ai_classifier: Any = None,
        ai_classifier_lock: threading.Lock | None = None,
        checkpoint_path: str | Path | None = None,
    ) -> None:
        requested_device = os.environ.get("ORISLOP_SPATIAL_DEVICE", "cpu").strip().lower()
        if requested_device == "cuda" and torch.cuda.is_available():
            self.device = torch.device("cuda")
        else:
            self.device = torch.device("cpu")
        self.cache_dir = str(Path(cache_dir).expanduser().resolve())
        local_checkpoint = checkpoint_path or os.environ.get("ORISLOP_SPATIAL_CHECKPOINT_PATH")
        if not local_checkpoint and PACKAGED_SPATIAL_CHECKPOINT.is_file():
            local_checkpoint = PACKAGED_SPATIAL_CHECKPOINT
        if local_checkpoint:
            checkpoint = str(Path(local_checkpoint).expanduser().resolve())
            if not Path(checkpoint).is_file():
                raise FileNotFoundError(f"Spatial checkpoint does not exist: {checkpoint}")
            if Path(checkpoint) == PACKAGED_SPATIAL_CHECKPOINT.resolve():
                actual = hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest()
                if actual != PACKAGED_SPATIAL_SHA256:
                    raise RuntimeError("Packaged Orislop spatial checkpoint failed SHA-256 verification")
        else:
            checkpoint = hf_hub_download(
                repo_id=SPATIAL_REPO_ID,
                filename=SPATIAL_CHECKPOINT,
                cache_dir=self.cache_dir,
            )
        checkpoint_state, self.checkpoint_metadata = validate_spatial_checkpoint(
            _safe_torch_load(checkpoint, self.device)
        )
        self.vision = VisionEncoder().to(self.device).eval()
        self.fusion = FusionDetector(self.vision.embedding_dim, aux_dim=3).to(self.device).eval()
        self.fusion.load_state_dict(checkpoint_state, strict=True)
        self.temperature = max(0.05, float(self.checkpoint_metadata.get("temperature", 1.0)))
        self.recommended_threshold = float(self.checkpoint_metadata.get("threshold", 0.5))
        auxiliary_device = os.environ.get("ORISLOP_SPATIAL_AUX_DEVICE", "cpu").strip().lower()
        pipeline_device = 0 if auxiliary_device == "cuda" and self.device.type == "cuda" else -1
        # Local Heavy keeps this auxiliary model on CPU. The visual-only cloud image
        # opts into CUDA because no Temporal MoE competes for accelerator memory.
        self.ai_classifier = ai_classifier or pipeline(
            "image-classification",
            model=AI_MODEL_SOURCE,
            device=pipeline_device,
            **_pretrained_options(AI_MODEL_SOURCE, AI_MODEL_REVISION),
        )
        self.ai_classifier_lock = ai_classifier_lock or threading.Lock()
        self.cpu_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="orislop-spatial-cpu")
        self.clip_processor = CLIPProcessor.from_pretrained(
            CLIP_MODEL_SOURCE,
            cache_dir=self.cache_dir,
            **_pretrained_options(CLIP_MODEL_SOURCE, CLIP_MODEL_REVISION),
        )
        self.clip = CLIPModel.from_pretrained(
            CLIP_MODEL_SOURCE,
            cache_dir=self.cache_dir,
            **_pretrained_options(CLIP_MODEL_SOURCE, CLIP_MODEL_REVISION),
        ).to(self.device).eval()

    @torch.no_grad()
    def analyze_video(self, video_path: str | Path, max_frames: int = 5) -> dict[str, Any]:
        images = sample_video_frames(video_path, max_frames=max_frames)
        if not images:
            raise RuntimeError("Spatial detector could not decode any video frames")
        probabilities = self.analyze_images(images)
        probability = float(sum(probabilities) / len(probabilities))
        return {
            "available": True,
            "repo_id": SPATIAL_REPO_ID,
            "ai_probability": probability,
            "confidence": probability if probability >= 0.5 else 1.0 - probability,
            "frames_analyzed": len(probabilities),
            "frame_probabilities": probabilities,
            "device": str(self.device),
            "encoder_contract": SPATIAL_ENCODER_CONTRACT,
            "recommended_threshold": self.recommended_threshold,
            "calibrated": True,
        }

    @torch.no_grad()
    def analyze_image(self, image: Image.Image) -> float:
        return self.analyze_images([image])[0]

    @torch.no_grad()
    def analyze_images(self, images: list[Image.Image] | tuple[Image.Image, ...]) -> list[float]:
        converted = [image.convert("RGB") for image in images]
        if not converted:
            return []

        def classify_auxiliary() -> list[float]:
            with self.ai_classifier_lock:
                raw_outputs = self.ai_classifier(converted)
            if len(converted) == 1 and raw_outputs and isinstance(raw_outputs[0], dict):
                raw_outputs = [raw_outputs]
            if len(raw_outputs) != len(converted):
                raise RuntimeError("Auxiliary spatial classifier returned the wrong batch size")
            return [classifier_ai_probability(output) for output in raw_outputs]

        ai_future = self.cpu_pool.submit(classify_auxiliary)
        texture_future = self.cpu_pool.submit(
            lambda: [self._texture_score(image) for image in converted]
        )

        clip_inputs = self.clip_processor(
            text=TEXT_PROMPTS,
            images=converted,
            return_tensors="pt",
            padding=True,
        ).to(self.device)
        clip_probabilities = self.clip(**clip_inputs).logits_per_image.softmax(dim=1)[:, 1]
        clip_scores = clip_probabilities.detach().cpu().tolist()

        pixels = self.vision.processor(images=converted, return_tensors="pt")["pixel_values"].to(self.device)
        embedding = self.vision(pixels).to(dtype=torch.float32)
        ai_scores = ai_future.result()
        texture_scores = texture_future.result()
        auxiliary = torch.tensor(
            list(zip(ai_scores, clip_scores, texture_scores)),
            dtype=torch.float32,
            device=self.device,
        )
        logit = self.fusion(torch.cat([embedding, auxiliary], dim=1)) / self.temperature
        return [float(value) for value in torch.sigmoid(logit).reshape(-1).detach().cpu().tolist()]

    def _ai_score(self, image: Image.Image) -> float:
        with self.ai_classifier_lock:
            return classifier_ai_probability(self.ai_classifier(image))

    @torch.no_grad()
    def _clip_score(self, image: Image.Image) -> float:
        inputs = self.clip_processor(
            text=TEXT_PROMPTS,
            images=image,
            return_tensors="pt",
            padding=True,
        ).to(self.device)
        probabilities = self.clip(**inputs).logits_per_image.softmax(dim=1)
        return float(probabilities[0, 1].detach().cpu())

    @staticmethod
    def _texture_score(image: Image.Image) -> float:
        grayscale = np.array(image.convert("L"))
        variance = float(np.var(cv2.Laplacian(grayscale, cv2.CV_64F)))
        return float(np.clip(variance / 500.0, 0.0, 1.0))


def sample_video_frames(video_path: str | Path, max_frames: int) -> list[Image.Image]:
    media_path = Path(video_path)
    if media_path.name == "preview.image" or media_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
        return load_static_image(media_path)
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        capture.release()
        return load_static_image(media_path)
    try:
        frame_count = max(0, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        if frame_count > 0:
            count = min(max_frames, frame_count)
            positions = np.linspace(0, frame_count - 1, num=count, dtype=int).tolist()
        else:
            positions = list(range(max_frames))
        images: list[Image.Image] = []
        for position in positions:
            if frame_count > 0:
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(position))
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            images.append(Image.fromarray(rgb))
        return images or load_static_image(media_path)
    finally:
        capture.release()


def load_static_image(path: str | Path) -> list[Image.Image]:
    try:
        with Image.open(path) as image:
            return [image.convert("RGB")]
    except Exception:
        return []
