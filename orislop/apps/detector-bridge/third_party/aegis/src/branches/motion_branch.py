"""Pinned AEGIS motion branch (MIT), isolated for Orislop cloud-heavy-v1."""

import torch
import torch.nn as nn
import torch.nn.functional as F
from einops import rearrange


class LightFlowNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Conv2d(6, 32, 7, padding=3, stride=2), nn.BatchNorm2d(32), nn.GELU(),
            nn.Conv2d(32, 64, 5, padding=2, stride=2), nn.BatchNorm2d(64), nn.GELU(),
            nn.Conv2d(64, 128, 3, padding=1, stride=2), nn.BatchNorm2d(128), nn.GELU(),
            nn.Conv2d(128, 128, 3, padding=1), nn.BatchNorm2d(128), nn.GELU(),
        )
        self.decoder = nn.Sequential(
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.Conv2d(128, 64, 3, padding=1), nn.BatchNorm2d(64), nn.GELU(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.Conv2d(64, 32, 3, padding=1), nn.BatchNorm2d(32), nn.GELU(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.Conv2d(32, 2, 3, padding=1),
        )

    def forward(self, frame1, frame2):
        return self.decoder(self.encoder(torch.cat([frame1, frame2], dim=1)))


def compute_flow_maps(frames, flow_net):
    flow_mags, occlusions, boundaries = [], [], []
    for index in range(frames.shape[1] - 1):
        first, second = frames[:, index], frames[:, index + 1]
        flow = flow_net(first, second)
        magnitude = torch.sqrt(flow[:, 0] ** 2 + flow[:, 1] ** 2 + 1e-8).unsqueeze(1)
        backward = flow_net(second, first)
        occlusion = torch.sqrt(
            (flow[:, 0] + backward[:, 0]) ** 2 + (flow[:, 1] + backward[:, 1]) ** 2 + 1e-8
        ).unsqueeze(1)
        occlusion = (occlusion / occlusion.amax(dim=(-2, -1), keepdim=True).clamp(min=1e-8)).clamp(0, 1)
        flow_dx = F.pad(torch.abs(flow[:, :, :, 1:] - flow[:, :, :, :-1]), (0, 1))
        flow_dy = F.pad(torch.abs(flow[:, :, 1:, :] - flow[:, :, :-1, :]), (0, 0, 0, 1))
        boundary = (flow_dx + flow_dy).sum(dim=1, keepdim=True)
        boundary = (boundary / boundary.amax(dim=(-2, -1), keepdim=True).clamp(min=1e-8)).clamp(0, 1)
        flow_mags.append(magnitude)
        occlusions.append(occlusion)
        boundaries.append(boundary)
    return torch.stack(flow_mags, dim=1), torch.stack(occlusions, dim=1), torch.stack(boundaries, dim=1)


class FlowSmoothnessAnalyzer(nn.Module):
    def __init__(self, output_dim=64):
        super().__init__()
        self.proj = nn.Sequential(nn.Linear(4, 32), nn.GELU(), nn.Linear(32, output_dim))

    def forward(self, flow_magnitude):
        flat = flow_magnitude.flatten(2)
        mean_flow = flat.mean(dim=-1)
        var_flow = flat.var(dim=-1)
        stats = torch.cat([
            mean_flow.mean(dim=-1, keepdim=True),
            mean_flow.var(dim=-1, keepdim=True),
            var_flow.mean(dim=-1, keepdim=True),
            var_flow.var(dim=-1, keepdim=True),
        ], dim=-1)
        return self.proj(stats)


class TemporalTransformerEncoder(nn.Module):
    def __init__(self, in_channels=4, d_model=256, n_heads=8, n_layers=4, output_dim=512, img_size=224):
        super().__init__()
        self.frame_encoder = nn.Sequential(
            nn.Conv2d(in_channels, 32, 3, padding=1, stride=2), nn.BatchNorm2d(32), nn.GELU(),
            nn.Conv2d(32, 64, 3, padding=1, stride=2), nn.BatchNorm2d(64), nn.GELU(),
            nn.Conv2d(64, 128, 3, padding=1, stride=2), nn.BatchNorm2d(128), nn.GELU(),
            nn.Conv2d(128, d_model, 3, padding=1, stride=2), nn.BatchNorm2d(d_model), nn.GELU(),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
        )
        self.pos_embed = nn.Parameter(torch.randn(1, 32, d_model) * 0.02)
        layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=n_heads, dim_feedforward=d_model * 4,
            dropout=0.1, batch_first=True, norm_first=True,
        )
        self.transformer = nn.TransformerEncoder(layer, num_layers=n_layers)
        self.cls_token = nn.Parameter(torch.randn(1, 1, d_model) * 0.02)
        self.proj = nn.Sequential(nn.Linear(d_model, output_dim), nn.LayerNorm(output_dim))

    def forward(self, value):
        batch, frames = value.shape[:2]
        flat = rearrange(value, "b t c h w -> (b t) c h w")
        features = rearrange(self.frame_encoder(flat), "(b t) d -> b t d", b=batch, t=frames)
        features = features + self.pos_embed[:, :frames, :]
        tokens = torch.cat([self.cls_token.expand(batch, -1, -1), features], dim=1)
        output = self.transformer(tokens)
        return self.proj(output[:, 0]), output[:, 1:]


class MotionBranch(nn.Module):
    def __init__(self, output_dim=512):
        super().__init__()
        self.flow_net = LightFlowNet()
        self.temporal_encoder = TemporalTransformerEncoder(
            in_channels=4, d_model=256, n_heads=8, n_layers=4, output_dim=output_dim - 64,
        )
        self.smoothness = FlowSmoothnessAnalyzer(output_dim=64)
        self.final_proj = nn.Sequential(nn.Linear(output_dim, output_dim), nn.LayerNorm(output_dim))

    def _build_4ch_input(self, frames, flow_magnitude, occlusion_map, boundary_map):
        gray = (
            0.299 * frames[:, :, 0] + 0.587 * frames[:, :, 1] + 0.114 * frames[:, :, 2]
        ).unsqueeze(2)
        flow = torch.cat([flow_magnitude, flow_magnitude[:, -1:, ...]], dim=1)
        occlusion = torch.cat([occlusion_map, occlusion_map[:, -1:, ...]], dim=1)
        boundary = torch.cat([boundary_map, boundary_map[:, -1:, ...]], dim=1)
        return torch.cat([gray, flow, occlusion, boundary], dim=2)

    def forward(self, frames):
        flow, occlusion, boundary = compute_flow_maps(frames, self.flow_net)
        temporal, _ = self.temporal_encoder(self._build_4ch_input(frames, flow, occlusion, boundary))
        features = self.final_proj(torch.cat([temporal, self.smoothness(flow)], dim=-1))
        with torch.no_grad():
            smoothness = 1.0 - flow.flatten(1).var(dim=-1).clamp(0, 1)
        return {"motion_features": features, "flow_magnitude": flow, "smoothness_score": smoothness}
