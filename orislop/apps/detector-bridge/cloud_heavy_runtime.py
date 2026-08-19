from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any, Iterable

import cv2
import numpy as np
from PIL import Image
import torch
from torch import nn
from huggingface_hub import hf_hub_download, snapshot_download
from resource_scheduler import AdaptiveExecutionScheduler, is_cuda_oom


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = ROOT / "configs" / "cloud_heavy_v1.json"


def _clamp_probability(value: float) -> float:
    return min(max(float(value), 1e-6), 1.0 - 1e-6)


def _logit(value: float) -> float:
    probability = _clamp_probability(value)
    return math.log(probability / (1.0 - probability))


def _sigmoid(value: float) -> float:
    if value >= 0:
        exp_value = math.exp(-value)
        return 1.0 / (1.0 + exp_value)
    exp_value = math.exp(value)
    return exp_value / (1.0 + exp_value)


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: str | Path, expected_sha256: str) -> None:
    actual = sha256_file(path)
    if not expected_sha256 or actual.lower() != expected_sha256.lower():
        raise RuntimeError(f"Model integrity check failed for {Path(path).name}")


@dataclass(frozen=True)
class FrameBundle:
    rgb_frames: tuple[np.ndarray, ...]
    spatial_images: tuple[Image.Image, ...]
    frame_indices: tuple[int, ...]
    spatial_indices: tuple[int, ...]
    source_fps: float
    duration_seconds: float
    window_start_seconds: float
    window_end_seconds: float


class CloudHeavyPreempted(RuntimeError):
    pass


def _even_indices(count: int, requested: int) -> list[int]:
    if count <= 0 or requested <= 0:
        return []
    if count == 1:
        return [0] * requested
    return [int(round(value)) for value in np.linspace(0, count - 1, requested)]


def decode_frame_bundle(
    video_path: str | Path,
    *,
    frame_count: int = 16,
    spatial_frame_count: int = 5,
    window_seconds: float = 4.0,
) -> FrameBundle:
    """Decode one deterministic centered window shared by every heavyweight model."""

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Cloud Heavy could not open the media file")
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if fps <= 0.0:
            fps = 25.0
        duration = total_frames / fps if total_frames > 0 else 0.0
        effective_window = min(max(duration, 1.0 / fps), window_seconds) if duration > 0 else window_seconds
        start = max(0.0, (duration - effective_window) / 2.0) if duration > 0 else 0.0
        end = start + effective_window
        start_frame = max(0, int(round(start * fps)))
        if total_frames > 0:
            end_frame = min(total_frames - 1, max(start_frame, int(round(end * fps)) - 1))
        else:
            end_frame = start_frame + max(frame_count - 1, int(round(effective_window * fps)) - 1)
        indices = tuple(int(round(value)) for value in np.linspace(start_frame, end_frame, frame_count))
        frames: list[np.ndarray] = []
        previous: np.ndarray | None = None
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, bgr = capture.read()
            if ok and bgr is not None:
                previous = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            if previous is None:
                raise RuntimeError("Cloud Heavy could not decode the deterministic frame window")
            frames.append(previous.copy())
    finally:
        capture.release()
    spatial_indices = tuple(_even_indices(len(frames), spatial_frame_count))
    images = tuple(Image.fromarray(frames[index], mode="RGB") for index in spatial_indices)
    return FrameBundle(
        rgb_frames=tuple(frames),
        spatial_images=images,
        frame_indices=indices,
        spatial_indices=spatial_indices,
        source_fps=fps,
        duration_seconds=duration,
        window_start_seconds=start,
        window_end_seconds=end,
    )


def _fake_label_index(id2label: dict[Any, Any]) -> int:
    fake_tokens = ("deepfake", "fake", "synthetic", "artificial", "generated", "ai")
    for raw_index, raw_label in id2label.items():
        label = str(raw_label).lower()
        if any(token in label for token in fake_tokens):
            return int(raw_index)
    raise RuntimeError("Pinned public frame detector exposes no recognizable synthetic label")


class PublicFrameDetector:
    def __init__(self, config: dict[str, Any], cache_dir: str | Path, device: torch.device) -> None:
        from transformers import AutoImageProcessor, AutoModelForImageClassification

        self.config = config
        self.device = device
        repo_id = config["repoId"]
        revision = config["revision"]
        local_override = os.environ.get("ORISLOP_PUBLIC_FRAME_MODEL_DIR", "").strip()
        snapshot = Path(local_override).expanduser() if local_override else Path(snapshot_download(
            repo_id=repo_id,
            revision=revision,
            cache_dir=str(cache_dir),
            allow_patterns=list(config.get("files", {}).keys()),
        ))
        if not snapshot.is_dir():
            raise RuntimeError(f"Pinned public frame model directory is missing: {snapshot}")
        for name, expected in config.get("files", {}).items():
            verify_file(snapshot / name, expected)
        self.processor = AutoImageProcessor.from_pretrained(snapshot, local_files_only=True)
        self.model = AutoModelForImageClassification.from_pretrained(snapshot, local_files_only=True).to(device).eval()
        self.fake_index = _fake_label_index(dict(self.model.config.id2label))

    @torch.inference_mode()
    def analyze(self, images: Iterable[Image.Image]) -> dict[str, Any]:
        image_list = [image.convert("RGB") for image in images]
        if not image_list:
            raise RuntimeError("Public frame detector received no frames")
        inputs = self.processor(images=image_list, return_tensors="pt")
        inputs = {name: value.to(self.device) for name, value in inputs.items()}
        probabilities = torch.softmax(self.model(**inputs).logits, dim=-1)[:, self.fake_index]
        scores = [float(value) for value in probabilities.detach().cpu().tolist()]
        return {
            "available": True,
            "ai_probability": float(sum(scores) / len(scores)),
            "frame_probabilities": scores,
            "frames_analyzed": len(scores),
            "repo_id": self.config["repoId"],
            "revision": self.config["revision"],
        }


def _load_motion_branch(source_root: Path) -> type[nn.Module]:
    module_path = source_root / "src" / "branches" / "motion_branch.py"
    if not module_path.is_file():
        raise RuntimeError("Pinned AEGIS source checkout is missing motion_branch.py")
    spec = importlib.util.spec_from_file_location("orislop_aegis_motion_branch", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the pinned AEGIS motion branch")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.MotionBranch


def _checkpoint_state(payload: Any) -> dict[str, torch.Tensor]:
    if isinstance(payload, dict):
        state = payload.get("model_state") or payload.get("state_dict") or payload
        if isinstance(state, dict):
            return state
    raise RuntimeError("AEGIS checkpoint has an unsupported format")


def _prefixed_state(state: dict[str, torch.Tensor], prefix: str) -> dict[str, torch.Tensor]:
    return {key[len(prefix):]: value for key, value in state.items() if key.startswith(prefix)}


class AegisMotionDetector:
    """AEGIS motion branch only. Pixel, consistency, and full-fusion weights never load."""

    def __init__(self, config: dict[str, Any], cache_dir: str | Path, device: torch.device) -> None:
        self.config = config
        self.device = device
        source_root = Path(os.environ.get(
            "ORISLOP_AEGIS_SOURCE_DIR",
            Path(__file__).with_name("third_party") / "aegis",
        ))
        checkpoint_override = os.environ.get("ORISLOP_AEGIS_CHECKPOINT_PATH", "").strip()
        checkpoint_path = Path(checkpoint_override).expanduser() if checkpoint_override else Path(hf_hub_download(
            repo_id=config["repoId"],
            revision=config["revision"],
            filename=config["checkpointFile"],
            cache_dir=str(cache_dir),
        ))
        verify_file(checkpoint_path, config["checkpointSha256"])
        MotionBranch = _load_motion_branch(source_root)
        self.motion_branch = MotionBranch(output_dim=512).to(device).eval()
        self.motion_head = nn.Sequential(nn.Linear(512, 64), nn.GELU(), nn.Linear(64, 1)).to(device).eval()
        try:
            payload = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        except TypeError:
            payload = torch.load(checkpoint_path, map_location="cpu")
        state = _checkpoint_state(payload)
        motion_state = _prefixed_state(state, "motion_branch.")
        head_state = _prefixed_state(state, "fusion.motion_head.")
        if not motion_state or not head_state:
            raise RuntimeError("AEGIS checkpoint is missing the motion-only weights")
        self.motion_branch.load_state_dict(motion_state, strict=True)
        self.motion_head.load_state_dict(head_state, strict=True)

    @torch.inference_mode()
    def analyze(self, rgb_frames: Iterable[np.ndarray]) -> dict[str, Any]:
        tensors: list[torch.Tensor] = []
        for frame in rgb_frames:
            resized = cv2.resize(frame, (224, 224), interpolation=cv2.INTER_AREA)
            tensor = torch.from_numpy(np.ascontiguousarray(resized)).permute(2, 0, 1).float() / 255.0
            tensors.append(tensor)
        if len(tensors) != int(self.config.get("frames", 16)):
            raise RuntimeError("AEGIS motion branch requires the pinned 16-frame contract")
        frames = torch.stack(tensors).unsqueeze(0).to(self.device)
        mean = torch.tensor([0.485, 0.456, 0.406], device=self.device).view(1, 1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225], device=self.device).view(1, 1, 3, 1, 1)
        frames = (frames - mean) / std
        features = self.motion_branch(frames)["motion_features"]
        raw_logit = float(self.motion_head(features).squeeze().detach().cpu())
        return {
            "available": True,
            "raw_logit": raw_logit,
            "raw_probability": _sigmoid(raw_logit),
            "frames_analyzed": len(tensors),
            "repo_id": self.config["repoId"],
            "revision": self.config["revision"],
            "branch": "motion-only",
        }


def combine_spatial_family(custom_probability: float, public_probability: float, calibration: dict[str, Any]) -> float:
    return _sigmoid(
        float(calibration.get("intercept", 0.0))
        + float(calibration.get("customCoefficient", 1.0)) * _logit(custom_probability)
        + float(calibration.get("publicCoefficient", 1.0)) * _logit(public_probability)
    )


def calibrate_motion(raw_logit: float, temperature: float) -> float:
    return _sigmoid(float(raw_logit) / max(float(temperature), 0.05))


def consensus_decision(
    spatial_probability: float,
    motion_probability: float,
    spatial_threshold: float,
    motion_threshold: float,
    *,
    rollout_mode: str,
    language: str = "unknown",
) -> dict[str, Any]:
    spatial_vote = spatial_probability >= spatial_threshold
    motion_vote = motion_probability >= motion_threshold
    consensus = spatial_vote and motion_vote
    english = language.lower().split("-", 1)[0] in {"en", "eng"}
    automatic = consensus and rollout_mode == "aggressive" and english
    return {
        "synthetic": consensus,
        "automaticSkipEligible": automatic,
        "consensusBasis": {
            "spatialFamily": spatial_vote,
            "motion": motion_vote,
            "independentVotes": 2 if consensus else int(spatial_vote) + int(motion_vote),
            "singleDetectorSpikeFailsOpen": True,
        },
        "reason": (
            "Independent spatial-family and motion detectors agree"
            if consensus else "Cloud Heavy failed open because independent spatial and motion evidence did not agree"
        ),
    }


class CloudHeavyRuntime:
    def __init__(
        self,
        custom_spatial: Any,
        cache_dir: str | Path,
        *,
        config_path: str | Path = DEFAULT_CONFIG_PATH,
        public_detector: Any = None,
        motion_detector: Any = None,
        scheduler: AdaptiveExecutionScheduler | None = None,
    ) -> None:
        self.config_path = Path(config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.custom_spatial = custom_spatial
        requested_device = os.environ.get("ORISLOP_CLOUD_HEAVY_DEVICE", "cuda").lower()
        if requested_device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("Cloud Heavy requires a CUDA GPU")
        self.device = torch.device("cuda" if requested_device == "cuda" else "cpu")
        self.scheduler = scheduler or AdaptiveExecutionScheduler()
        self.scheduler.configure_torch()
        models = self.config["models"]
        self.public_detector = public_detector or PublicFrameDetector(models["publicFrame"], Path(cache_dir) / "public-frame", self.device)
        self.motion_detector = motion_detector or AegisMotionDetector(models["motion"], Path(cache_dir) / "aegis-motion", self.device)
        configured_mode = os.environ.get("ORISLOP_CLOUD_HEAVY_ROLLOUT", self.config["rollout"]["defaultMode"]).lower()
        integrity_ready = bool(self.config.get("calibrated") and self.config.get("betaGatePassed"))
        explicitly_enabled = os.environ.get("ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES", "0") == "1"
        self.rollout_mode = "aggressive" if configured_mode == "aggressive" and integrity_ready and explicitly_enabled else "shadow"

    def _run_component(self, name: str, operation: Any) -> tuple[Any, int]:
        started_at = time.monotonic()
        if self.device.type != "cuda":
            return operation(), round((time.monotonic() - started_at) * 1000)
        stream = torch.cuda.Stream(device=self.device)
        with torch.cuda.stream(stream):
            value = operation()
        stream.synchronize()
        return value, round((time.monotonic() - started_at) * 1000)

    def _analyze_components(
        self,
        bundle: FrameBundle,
        *,
        workers: int,
    ) -> tuple[list[float], dict[str, Any], dict[str, Any], dict[str, int]]:
        operations = {
            "customSpatial": lambda: (
                [float(value) for value in self.custom_spatial.analyze_images(bundle.spatial_images)]
                if hasattr(self.custom_spatial, "analyze_images")
                else [float(self.custom_spatial.analyze_image(image)) for image in bundle.spatial_images]
            ),
            "publicFrame": lambda: self.public_detector.analyze(bundle.spatial_images),
            "motion": lambda: self.motion_detector.analyze(bundle.rgb_frames),
        }
        if workers <= 1:
            values: dict[str, Any] = {}
            timings: dict[str, int] = {}
            for name, operation in operations.items():
                values[name], timings[name] = self._run_component(name, operation)
            return values["customSpatial"], values["publicFrame"], values["motion"], timings

        values = {}
        timings = {}
        try:
            with ThreadPoolExecutor(max_workers=min(workers, len(operations)), thread_name_prefix="orislop-visual") as pool:
                futures = {
                    name: pool.submit(self._run_component, name, operation)
                    for name, operation in operations.items()
                }
                for name, future in futures.items():
                    values[name], timings[name] = future.result()
        except RuntimeError as error:
            if not is_cuda_oom(error):
                raise
            self.scheduler.record_oom()
            if torch.cuda.is_available():
                torch.cuda.synchronize(self.device)
                torch.cuda.empty_cache()
            values = {}
            timings = {}
            for name, operation in operations.items():
                values[name], timings[name] = self._run_component(name, operation)
            timings["oomSequentialRetry"] = 1
        return values["customSpatial"], values["publicFrame"], values["motion"], timings

    def analyze_video(
        self,
        video_path: str | Path,
        language: str = "unknown",
        should_preempt: Any = None,
        component_workers: int | None = None,
    ) -> dict[str, Any]:
        analysis_started_at = time.monotonic()
        motion_config = self.config["models"]["motion"]
        decode_started_at = time.monotonic()
        bundle = decode_frame_bundle(
            video_path,
            frame_count=int(motion_config["frames"]),
            spatial_frame_count=int(self.config["models"]["customSpatial"]["frames"]),
            window_seconds=float(motion_config["windowSeconds"]),
        )
        decode_ms = round((time.monotonic() - decode_started_at) * 1000)
        if callable(should_preempt) and should_preempt():
            raise CloudHeavyPreempted("Lookahead inference yielded to a current video")
        plan = self.scheduler.plan()
        workers = max(1, min(3, int(component_workers or plan.component_workers)))
        self.scheduler.record_run(workers > 1)
        custom_scores, public, motion, component_timings = self._analyze_components(bundle, workers=workers)
        custom_probability = float(sum(custom_scores) / len(custom_scores))
        if callable(should_preempt) and should_preempt():
            raise CloudHeavyPreempted("Lookahead inference yielded after the visual component bundle")
        calibration = self.config["calibration"]
        spatial_family = combine_spatial_family(custom_probability, public["ai_probability"], calibration["spatialLogistic"])
        motion_probability = calibrate_motion(motion["raw_logit"], calibration["motionTemperature"])
        thresholds = self.config["thresholds"]
        decision = consensus_decision(
            spatial_family,
            motion_probability,
            float(thresholds["aggressiveSpatial"]),
            float(thresholds["aggressiveMotion"]),
            rollout_mode=self.rollout_mode,
            language=language,
        )
        return {
            "available": True,
            "modelBundleVersion": self.config["modelBundleVersion"],
            "spatialFamilyProbability": spatial_family,
            "componentSpatialScores": {
                "custom": custom_probability,
                "customFrames": custom_scores,
                "publicFrame": public["ai_probability"],
                "publicFrames": public["frame_probabilities"],
            },
            "motionProbability": motion_probability,
            "motionRawProbability": motion["raw_probability"],
            "thresholds": {
                "aggressiveSpatial": float(thresholds["aggressiveSpatial"]),
                "aggressiveMotion": float(thresholds["aggressiveMotion"]),
            },
            "rolloutMode": self.rollout_mode,
            "frameBundle": {
                "frames": len(bundle.rgb_frames),
                "windowStartSeconds": round(bundle.window_start_seconds, 3),
                "windowEndSeconds": round(bundle.window_end_seconds, 3),
                "sourceFps": round(bundle.source_fps, 3),
            },
            "execution": {
                "mode": "concurrent" if workers > 1 else "sequential",
                "componentWorkers": workers,
                "decodeMs": decode_ms,
                "componentMs": component_timings,
                "totalMs": round((time.monotonic() - analysis_started_at) * 1000),
            },
            **decision,
        }
