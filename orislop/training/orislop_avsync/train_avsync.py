#!/usr/bin/env python3
"""Train, evaluate, and export Orislop's audio-visual synchronization expert.

The model answers one narrow question: when a visible person is speaking, does
the audio line up with the tracked mouth motion? Applicability is deliberately
handled outside the neural network so that silence, voice-over, closed lips,
noise, missing faces, and occlusion cannot be mislabeled as synthetic media.

This file is intentionally self-contained for Google Colab. Run ``--help`` or
read ``training/orislop_avsync/README.md`` for the complete workflow.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
from typing import Any, Iterable, Sequence
import wave

import cv2
import numpy as np
import torch
from torch import Tensor, nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm

try:
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        f1_score,
        precision_recall_fscore_support,
        roc_auc_score,
    )
except ImportError:  # pragma: no cover - self-test still works without sklearn.
    accuracy_score = confusion_matrix = f1_score = None
    precision_recall_fscore_support = roc_auc_score = None


LABELS = {"aligned": 0, "mismatched": 1}
STATE_LABELS = ("aligned", "mismatched", "uncertain", "not_applicable")
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
SCHEMA_VERSION = 1
MODEL_VERSION = "orislop-avsync-0.1.0"


@dataclass(frozen=True)
class ModelConfig:
    sample_rate: int = 16_000
    target_fps: int = 25
    clip_frames: int = 25
    mouth_size: int = 96
    embedding_dim: int = 128
    max_offset_frames: int = 7
    n_fft: int = 400
    hop_length: int = 160
    win_length: int = 400


@dataclass(frozen=True)
class GateConfig:
    minimum_face_coverage: float = 0.65
    minimum_speech_ratio: float = 0.15
    minimum_mouth_motion: float = 0.008
    minimum_snr_db: float = 4.0
    minimum_usable_seconds: float = 1.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=json_default) + "\n", encoding="utf-8")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON on {path}:{line_number}: {exc}") from exc
        records.append(record)
    return records


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, default=json_default) + "\n")


def resolve_record_path(value: str, data_root: Path) -> Path:
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (data_root / path).resolve()


def stable_fraction(value: str) -> float:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64 - 1)


def assigned_split(value: str, train_fraction: float, val_fraction: float) -> str:
    point = stable_fraction(value)
    if point < train_fraction:
        return "train"
    if point < train_fraction + val_fraction:
        return "val"
    return "test"


def command_build_manifest(args: argparse.Namespace) -> None:
    root = Path(args.data_root).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Dataset root does not exist: {root}")
    if args.train_fraction <= 0 or args.val_fraction <= 0 or args.train_fraction + args.val_fraction >= 1:
        raise ValueError("Split fractions must leave non-zero train, validation, and test sets")

    records: list[dict[str, Any]] = []
    for label in ("aligned", "mismatched", "uncertain", "not_applicable"):
        folder = root / label
        if not folder.is_dir():
            continue
        for video_path in sorted(path for path in folder.rglob("*") if path.suffix.lower() in VIDEO_SUFFIXES):
            relative = video_path.relative_to(root).as_posix()
            within_label = video_path.relative_to(folder)
            # Put every clip for the same speaker/identity into one split. Use
            # data/<label>/<speaker-id>/<clip>.mp4 for reliable leakage control.
            group = within_label.parts[0] if len(within_label.parts) > 1 else within_label.stem.split("__", 1)[0]
            identity = f"{label}:{relative}"
            records.append(
                {
                    "id": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20],
                    "video_path": relative,
                    "label": label,
                    "group": group,
                    "split": assigned_split(group, args.train_fraction, args.val_fraction),
                }
            )

    if not records:
        raise RuntimeError(
            f"No videos found. Create {root / 'aligned'} and {root / 'mismatched'} and place clips inside."
        )
    output = Path(args.output).expanduser().resolve()
    write_jsonl(output, records)
    counts: dict[str, int] = {}
    for record in records:
        key = f"{record['split']}:{record['label']}"
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({"manifest": str(output), "records": len(records), "counts": counts}, indent=2))


def require_ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise RuntimeError("ffmpeg is required. Colab already includes it; locally install ffmpeg and retry.")
    return executable


def extract_audio(source: Path, output_wav: Path, sample_rate: int) -> None:
    command = [
        require_ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_s16le",
        str(output_wav),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        message = completed.stderr.strip()[-800:]
        raise RuntimeError(f"ffmpeg could not extract audio from {source}: {message}")


def read_pcm16_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"Expected 16-bit WAV, got sample width {width}")
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sample_rate


def largest_centered_face(faces: Sequence[Sequence[int]], frame_width: int, frame_height: int) -> tuple[int, int, int, int] | None:
    if len(faces) == 0:
        return None
    cx, cy = frame_width / 2.0, frame_height / 2.0

    def score(face: Sequence[int]) -> float:
        x, y, w, h = [float(value) for value in face]
        distance = math.hypot((x + w / 2 - cx) / max(frame_width, 1), (y + h / 2 - cy) / max(frame_height, 1))
        return w * h * max(0.25, 1.0 - 0.6 * distance)

    x, y, w, h = max(faces, key=score)
    return int(x), int(y), int(w), int(h)


def expanded_face_box(box: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = box
    pad_x, pad_y = int(w * 0.08), int(h * 0.08)
    return max(0, x - pad_x), max(0, y - pad_y), min(width, x + w + pad_x), min(height, y + h + pad_y)


def mouth_crop(frame: np.ndarray, box: tuple[int, int, int, int], size: int) -> np.ndarray | None:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = expanded_face_box(box, width, height)
    face_width, face_height = x2 - x1, y2 - y1
    mx1 = int(x1 + face_width * 0.08)
    mx2 = int(x1 + face_width * 0.92)
    my1 = int(y1 + face_height * 0.48)
    my2 = int(y1 + face_height * 0.98)
    if mx2 - mx1 < 12 or my2 - my1 < 8:
        return None
    crop = frame[max(0, my1):min(height, my2), max(0, mx1):min(width, mx2)]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


def decode_mouth_track(
    video_path: Path,
    target_fps: int,
    mouth_size: int,
    max_seconds: float,
    detect_every: int,
) -> tuple[np.ndarray, np.ndarray, float]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open {video_path}")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or target_fps)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / source_fps if frame_count > 0 and source_fps > 0 else max_seconds
    start_seconds = max(0.0, (duration - max_seconds) / 2.0) if duration > max_seconds else 0.0
    capture.set(cv2.CAP_PROP_POS_MSEC, start_seconds * 1000.0)

    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(str(cascade_path))
    if detector.empty():
        raise RuntimeError(f"OpenCV face cascade unavailable: {cascade_path}")

    mouths: list[np.ndarray] = []
    valid: list[bool] = []
    last_box: tuple[int, int, int, int] | None = None
    sampled_index = 0
    next_sample_seconds = start_seconds
    end_seconds = min(duration, start_seconds + max_seconds)

    while len(mouths) < int(max_seconds * target_fps):
        ok, frame = capture.read()
        if not ok:
            break
        timestamp = float(capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000.0
        if timestamp + 1e-4 < next_sample_seconds:
            continue
        if timestamp > end_seconds + 1.0 / target_fps:
            break
        height, width = frame.shape[:2]
        if sampled_index % max(1, detect_every) == 0 or last_box is None:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detector.detectMultiScale(
                gray,
                scaleFactor=1.12,
                minNeighbors=5,
                minSize=(max(36, width // 12), max(36, height // 12)),
            )
            detected = largest_centered_face(faces, width, height)
            last_box = detected
        crop = mouth_crop(frame, last_box, mouth_size) if last_box is not None else None
        if crop is None:
            mouths.append(np.zeros((mouth_size, mouth_size, 3), dtype=np.uint8))
            valid.append(False)
        else:
            mouths.append(crop)
            valid.append(True)
        sampled_index += 1
        next_sample_seconds += 1.0 / target_fps

    capture.release()
    if not mouths:
        raise RuntimeError(f"No frames decoded from {video_path}")
    return np.stack(mouths), np.asarray(valid, dtype=np.bool_), start_seconds


def audio_quality(audio: np.ndarray, sample_rate: int) -> tuple[float, float]:
    frame_size = max(1, int(sample_rate * 0.02))
    usable = len(audio) // frame_size * frame_size
    if usable == 0:
        return 0.0, -20.0
    frames = audio[:usable].reshape(-1, frame_size)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-10)
    noise = float(np.percentile(rms, 20)) + 1e-6
    signal = float(np.percentile(rms, 80)) + 1e-6
    threshold = max(noise * 2.5, 0.003)
    speech_ratio = float(np.mean(rms > threshold))
    snr_db = float(np.clip(20.0 * np.log10(signal / noise), -20.0, 60.0))
    return speech_ratio, snr_db


def mouth_motion_score(mouths: np.ndarray, valid: np.ndarray) -> float:
    if len(mouths) < 2:
        return 0.0
    gray = np.mean(mouths.astype(np.float32), axis=3) / 255.0
    pair_valid = valid[1:] & valid[:-1]
    if not np.any(pair_valid):
        return 0.0
    differences = np.mean(np.abs(gray[1:] - gray[:-1]), axis=(1, 2))
    return float(np.median(differences[pair_valid]))


def cache_key(record: dict[str, Any], config: ModelConfig) -> str:
    identity = json.dumps(
        {
            "id": record.get("id"),
            "video_path": record.get("video_path"),
            "audio_path": record.get("audio_path"),
            "sample_rate": config.sample_rate,
            "target_fps": config.target_fps,
            "mouth_size": config.mouth_size,
        },
        sort_keys=True,
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def preprocess_record(
    record: dict[str, Any],
    data_root: Path,
    cache_dir: Path,
    config: ModelConfig,
    max_seconds: float,
    detect_every: int,
    overwrite: bool,
) -> dict[str, Any]:
    if record.get("label") not in STATE_LABELS:
        raise ValueError(f"Unsupported label {record.get('label')!r}; expected one of {STATE_LABELS}")
    video_path = resolve_record_path(str(record["video_path"]), data_root)
    if not video_path.is_file():
        raise FileNotFoundError(video_path)
    output_path = cache_dir / f"{cache_key(record, config)}.npz"
    if output_path.exists() and not overwrite:
        with np.load(output_path, allow_pickle=False) as cached:
            quality = json.loads(str(cached["quality_json"].item()))
        return {**record, "cache_path": str(output_path), "quality": quality}

    mouths, valid, start_seconds = decode_mouth_track(
        video_path,
        target_fps=config.target_fps,
        mouth_size=config.mouth_size,
        max_seconds=max_seconds,
        detect_every=detect_every,
    )
    audio_source = resolve_record_path(str(record.get("audio_path", record["video_path"])), data_root)
    with tempfile.TemporaryDirectory(prefix="orislop-avsync-") as temporary:
        wav_path = Path(temporary) / "audio.wav"
        extract_audio(audio_source, wav_path, config.sample_rate)
        audio, sample_rate = read_pcm16_wav(wav_path)
    if sample_rate != config.sample_rate:
        raise RuntimeError(f"ffmpeg returned {sample_rate} Hz instead of {config.sample_rate} Hz")
    audio_start = int(round(start_seconds * sample_rate))
    audio_length = int(round(len(mouths) / config.target_fps * sample_rate))
    audio = slice_with_padding(audio, audio_start, audio_length)

    speech_ratio, snr_db = audio_quality(audio, sample_rate)
    quality = {
        "face_coverage": float(np.mean(valid)),
        "speech_ratio": speech_ratio,
        "snr_db": snr_db,
        "mouth_motion": mouth_motion_score(mouths, valid),
        "usable_seconds": float(len(mouths) / config.target_fps),
        "valid_frames": int(np.sum(valid)),
        "total_frames": int(len(valid)),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        output_path,
        mouths=mouths,
        valid=valid,
        audio=audio.astype(np.float32),
        sample_rate=np.asarray(config.sample_rate, dtype=np.int32),
        target_fps=np.asarray(config.target_fps, dtype=np.int32),
        quality_json=np.asarray(json.dumps(quality)),
    )
    return {**record, "cache_path": str(output_path), "quality": quality}


def command_prepare(args: argparse.Namespace) -> None:
    config = config_from_args(args)
    manifest_path = Path(args.manifest).expanduser().resolve()
    data_root = Path(args.data_root).expanduser().resolve()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    records = read_jsonl(manifest_path)
    prepared: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for record in tqdm(records, desc="Preparing mouth/audio caches"):
        try:
            prepared.append(
                preprocess_record(
                    record,
                    data_root,
                    cache_dir,
                    config,
                    max_seconds=args.max_seconds,
                    detect_every=args.detect_every,
                    overwrite=args.overwrite,
                )
            )
        except Exception as exc:
            failures.append({"id": str(record.get("id", "unknown")), "error": str(exc)})
            if args.fail_fast:
                raise
    output = Path(args.output_manifest).expanduser().resolve()
    write_jsonl(output, prepared)
    write_json(output.with_suffix(".failures.json"), failures)
    if not prepared:
        raise RuntimeError("Preprocessing produced zero usable records")
    print(json.dumps({"prepared_manifest": str(output), "prepared": len(prepared), "failed": len(failures)}, indent=2))


def slice_with_padding(array: np.ndarray, start: int, length: int) -> np.ndarray:
    output = np.zeros(length, dtype=array.dtype)
    source_start = max(0, start)
    source_end = min(len(array), start + length)
    if source_end <= source_start:
        return output
    target_start = source_start - start
    output[target_start:target_start + source_end - source_start] = array[source_start:source_end]
    return output


class CachedAVDataset(Dataset[dict[str, Tensor]]):
    def __init__(
        self,
        records: Sequence[dict[str, Any]],
        split: str,
        config: ModelConfig,
        training: bool,
        synthetic_mismatch_probability: float = 0.45,
        swapped_audio_probability: float = 0.10,
        minimum_shift_frames: int = 3,
        seed: int = 860,
    ) -> None:
        self.records = [record for record in records if record.get("split") == split and record.get("label") in LABELS]
        self.config = config
        self.training = training
        self.synthetic_mismatch_probability = synthetic_mismatch_probability
        self.swapped_audio_probability = swapped_audio_probability
        self.minimum_shift_frames = max(1, minimum_shift_frames)
        self.rng = random.Random(seed + (0 if split == "train" else 1))
        if not self.records:
            raise RuntimeError(f"No aligned/mismatched records found for split={split!r}")

    def __len__(self) -> int:
        return len(self.records)

    @staticmethod
    def load_cache(record: dict[str, Any]) -> dict[str, np.ndarray]:
        path = Path(record["cache_path"])
        if not path.is_file():
            raise FileNotFoundError(f"Prepared cache is missing: {path}")
        with np.load(path, allow_pickle=False) as cache:
            return {name: cache[name].copy() for name in ("mouths", "valid", "audio")}

    def __getitem__(self, index: int) -> dict[str, Tensor]:
        record = self.records[index]
        cache = self.load_cache(record)
        mouths = cache["mouths"]
        valid = cache["valid"]
        clip_frames = self.config.clip_frames
        max_start = max(0, len(mouths) - clip_frames)
        start_frame = self.rng.randint(0, max_start) if self.training and max_start else max_start // 2
        mouth_clip = mouths[start_frame:start_frame + clip_frames]
        valid_clip = valid[start_frame:start_frame + clip_frames]
        if len(mouth_clip) < clip_frames:
            missing = clip_frames - len(mouth_clip)
            mouth_clip = np.concatenate(
                [mouth_clip, np.zeros((missing, self.config.mouth_size, self.config.mouth_size, 3), dtype=np.uint8)]
            )
            valid_clip = np.concatenate([valid_clip, np.zeros(missing, dtype=np.bool_)])

        label = int(LABELS[str(record["label"])])
        shift_frames = 0
        audio_cache = cache["audio"]
        if self.training and record["label"] == "aligned" and self.rng.random() < self.swapped_audio_probability:
            other_index = self.rng.randrange(len(self.records))
            if other_index == index and len(self.records) > 1:
                other_index = (other_index + 1) % len(self.records)
            audio_cache = self.load_cache(self.records[other_index])["audio"]
            label = 1
            known_offset = -100
        elif self.training and record["label"] == "aligned" and self.rng.random() < self.synthetic_mismatch_probability:
            magnitude = self.rng.randint(self.minimum_shift_frames, self.config.max_offset_frames)
            shift_frames = magnitude if self.rng.random() < 0.5 else -magnitude
            label = 1
            known_offset = shift_frames + self.config.max_offset_frames
        else:
            known_offset = self.config.max_offset_frames if label == 0 else -100

        samples_per_frame = self.config.sample_rate / self.config.target_fps
        audio_start = int(round((start_frame + shift_frames) * samples_per_frame))
        audio_length = int(round(clip_frames * samples_per_frame))
        waveform = slice_with_padding(audio_cache, audio_start, audio_length).astype(np.float32)
        waveform -= float(np.mean(waveform))
        peak = float(np.max(np.abs(waveform)))
        if peak > 1e-4:
            waveform /= max(peak, 0.1)

        mouth_tensor = torch.from_numpy(mouth_clip).permute(3, 0, 1, 2).float().div_(255.0)
        if self.training:
            mouth_tensor = self.augment_video(mouth_tensor)
            waveform = self.augment_audio(waveform)
        return {
            "mouth": mouth_tensor,
            "audio": torch.from_numpy(np.ascontiguousarray(waveform)),
            "label": torch.tensor(float(label), dtype=torch.float32),
            "offset_target": torch.tensor(known_offset, dtype=torch.long),
            "valid_ratio": torch.tensor(float(np.mean(valid_clip)), dtype=torch.float32),
        }

    def augment_video(self, clip: Tensor) -> Tensor:
        if self.rng.random() < 0.5:
            clip = torch.flip(clip, dims=(3,))
        if self.rng.random() < 0.35:
            brightness = self.rng.uniform(0.82, 1.18)
            contrast = self.rng.uniform(0.85, 1.15)
            mean = clip.mean(dim=(1, 2, 3), keepdim=True)
            clip = ((clip - mean) * contrast + mean) * brightness
        if self.rng.random() < 0.20:
            noise = torch.randn_like(clip) * self.rng.uniform(0.005, 0.025)
            clip = clip + noise
        return clip.clamp_(0.0, 1.0)

    def augment_audio(self, waveform: np.ndarray) -> np.ndarray:
        waveform = waveform.copy()
        if self.rng.random() < 0.45:
            target_snr_db = self.rng.uniform(8.0, 30.0)
            signal_rms = float(np.sqrt(np.mean(waveform * waveform) + 1e-8))
            noise_rms = signal_rms / (10.0 ** (target_snr_db / 20.0))
            waveform += np.random.normal(0.0, noise_rms, size=waveform.shape).astype(np.float32)
        if self.rng.random() < 0.20:
            waveform *= self.rng.uniform(0.5, 1.25)
        return np.clip(waveform, -1.0, 1.0).astype(np.float32)


class AudioVisualSyncNet(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.max_offset_frames = config.max_offset_frames
        self.n_fft = config.n_fft
        self.hop_length = config.hop_length
        self.win_length = config.win_length
        self.video_encoder = nn.Sequential(
            nn.Conv3d(3, 32, kernel_size=(3, 5, 5), stride=(1, 2, 2), padding=(1, 2, 2), bias=False),
            nn.BatchNorm3d(32),
            nn.GELU(),
            nn.MaxPool3d(kernel_size=(1, 2, 2)),
            nn.Conv3d(32, 64, kernel_size=3, stride=(1, 2, 2), padding=1, bias=False),
            nn.BatchNorm3d(64),
            nn.GELU(),
            nn.Conv3d(64, 96, kernel_size=3, stride=1, padding=1, bias=False),
            nn.BatchNorm3d(96),
            nn.GELU(),
        )
        self.audio_encoder = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=5, stride=(2, 2), padding=2, bias=False),
            nn.BatchNorm2d(32),
            nn.GELU(),
            nn.Conv2d(32, 64, kernel_size=3, stride=(2, 2), padding=1, bias=False),
            nn.BatchNorm2d(64),
            nn.GELU(),
            nn.Conv2d(64, 96, kernel_size=3, stride=(2, 1), padding=1, bias=False),
            nn.BatchNorm2d(96),
            nn.GELU(),
        )
        self.video_projection = nn.Sequential(nn.Linear(96, config.embedding_dim), nn.LayerNorm(config.embedding_dim))
        self.audio_projection = nn.Sequential(nn.Linear(96, config.embedding_dim), nn.LayerNorm(config.embedding_dim))
        correlation_width = 2 * config.max_offset_frames + 1
        classifier_width = config.embedding_dim * 3 + correlation_width
        self.mismatch_head = nn.Sequential(
            nn.Linear(classifier_width, 256),
            nn.GELU(),
            nn.Dropout(0.20),
            nn.Linear(256, 64),
            nn.GELU(),
            nn.Linear(64, 1),
        )
        self.offset_scale = nn.Parameter(torch.tensor(10.0))
        self.register_buffer("hann_window", torch.hann_window(config.win_length), persistent=False)

    def audio_spectrogram(self, waveform: Tensor) -> Tensor:
        waveform = waveform - waveform.mean(dim=1, keepdim=True)
        rms = waveform.square().mean(dim=1, keepdim=True).sqrt().clamp_min(1e-4)
        waveform = waveform / rms.clamp_min(0.05)
        spectrum = torch.stft(
            waveform,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.hann_window.to(device=waveform.device, dtype=waveform.dtype),
            center=True,
            return_complex=True,
        ).abs()
        return torch.log1p(spectrum)

    def encode(self, mouth: Tensor, waveform: Tensor) -> tuple[Tensor, Tensor]:
        video = self.video_encoder(mouth).mean(dim=(-1, -2)).transpose(1, 2)
        audio = self.audio_encoder(self.audio_spectrogram(waveform).unsqueeze(1)).mean(dim=2).transpose(1, 2)
        audio = F.interpolate(audio.transpose(1, 2), size=video.size(1), mode="linear", align_corners=False).transpose(1, 2)
        video = F.normalize(self.video_projection(video), dim=-1)
        audio = F.normalize(self.audio_projection(audio), dim=-1)
        return video, audio

    def correlation_curve(self, video: Tensor, audio: Tensor) -> Tensor:
        correlations: list[Tensor] = []
        for offset in range(-self.max_offset_frames, self.max_offset_frames + 1):
            if offset < 0:
                video_slice = video[:, :offset]
                audio_slice = audio[:, -offset:]
            elif offset > 0:
                video_slice = video[:, offset:]
                audio_slice = audio[:, :-offset]
            else:
                video_slice = video
                audio_slice = audio
            correlations.append((video_slice * audio_slice).sum(dim=-1).mean(dim=-1))
        return torch.stack(correlations, dim=1)

    def forward(self, mouth: Tensor, waveform: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        video, audio = self.encode(mouth, waveform)
        correlation = self.correlation_curve(video, audio)
        video_pool = video.mean(dim=1)
        audio_pool = audio.mean(dim=1)
        features = torch.cat((video_pool, audio_pool, torch.abs(video_pool - audio_pool), correlation), dim=1)
        mismatch_logit = self.mismatch_head(features).squeeze(1)
        offset_logits = correlation * self.offset_scale.clamp(1.0, 30.0)
        embedding = F.normalize((video_pool + audio_pool) * 0.5, dim=-1)
        return mismatch_logit, offset_logits, embedding


class ExportedAVSync(nn.Module):
    def __init__(self, model: AudioVisualSyncNet, temperature: float) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("temperature", torch.tensor(max(temperature, 0.05), dtype=torch.float32))

    def forward(self, mouth: Tensor, waveform: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        mismatch_logit, offset_logits, embedding = self.model(mouth, waveform)
        probability = torch.sigmoid(mismatch_logit / self.temperature)
        return probability, torch.softmax(offset_logits, dim=1), embedding


def config_from_args(args: argparse.Namespace) -> ModelConfig:
    return ModelConfig(
        sample_rate=int(getattr(args, "sample_rate", 16_000)),
        target_fps=int(getattr(args, "target_fps", 25)),
        clip_frames=int(getattr(args, "clip_frames", 25)),
        mouth_size=int(getattr(args, "mouth_size", 96)),
        embedding_dim=int(getattr(args, "embedding_dim", 128)),
        max_offset_frames=int(getattr(args, "max_offset_frames", 7)),
    )


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def choose_device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable. In Colab choose Runtime > Change runtime type > GPU.")
    return torch.device(requested)


def load_prepared_datasets(
    manifest_path: Path,
    config: ModelConfig,
    args: argparse.Namespace,
) -> tuple[CachedAVDataset, CachedAVDataset]:
    records = read_jsonl(manifest_path)
    train = CachedAVDataset(
        records,
        "train",
        config,
        training=True,
        synthetic_mismatch_probability=args.synthetic_mismatch_probability,
        swapped_audio_probability=args.swapped_audio_probability,
        minimum_shift_frames=args.minimum_shift_frames,
        seed=args.seed,
    )
    validation = CachedAVDataset(records, "val", config, training=False, seed=args.seed)
    return train, validation


def make_loader(dataset: Dataset[dict[str, Tensor]], args: argparse.Namespace, shuffle: bool) -> DataLoader:
    return DataLoader(
        dataset,
        batch_size=args.batch_size,
        shuffle=shuffle,
        num_workers=args.workers,
        pin_memory=torch.cuda.is_available(),
        persistent_workers=args.workers > 0,
        drop_last=shuffle and len(dataset) >= args.batch_size,
    )


def amp_context(device: torch.device, enabled: bool):
    return torch.autocast(device_type=device.type, dtype=torch.float16, enabled=enabled and device.type == "cuda")


def run_epoch(
    model: AudioVisualSyncNet,
    loader: DataLoader,
    device: torch.device,
    optimizer: torch.optim.Optimizer | None,
    scaler: Any,
    offset_loss_weight: float,
    amp: bool,
    max_steps: int | None,
) -> dict[str, Any]:
    training = optimizer is not None
    model.train(training)
    losses: list[float] = []
    probabilities: list[float] = []
    labels: list[int] = []
    offset_correct = 0
    offset_count = 0
    for step, batch in enumerate(tqdm(loader, desc="train" if training else "evaluate", leave=False)):
        if max_steps is not None and step >= max_steps:
            break
        mouth = batch["mouth"].to(device, non_blocking=True)
        audio = batch["audio"].to(device, non_blocking=True)
        target = batch["label"].to(device, non_blocking=True)
        offset_target = batch["offset_target"].to(device, non_blocking=True)
        if training:
            optimizer.zero_grad(set_to_none=True)
        with torch.set_grad_enabled(training), amp_context(device, amp):
            mismatch_logit, offset_logits, _ = model(mouth, audio)
            binary_loss = F.binary_cross_entropy_with_logits(mismatch_logit, target)
            known = offset_target >= 0
            offset_loss = F.cross_entropy(offset_logits[known], offset_target[known]) if torch.any(known) else binary_loss.new_zeros(())
            loss = binary_loss + offset_loss_weight * offset_loss
        if training:
            if scaler is not None and scaler.is_enabled():
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                optimizer.step()
        losses.append(float(loss.detach().cpu()))
        probabilities.extend(torch.sigmoid(mismatch_logit.detach()).cpu().tolist())
        labels.extend(target.detach().int().cpu().tolist())
        if torch.any(known):
            offset_correct += int((offset_logits[known].argmax(dim=1) == offset_target[known]).sum().detach().cpu())
            offset_count += int(known.sum().detach().cpu())
    return compute_metrics(labels, probabilities, losses, offset_correct, offset_count)


def compute_metrics(
    labels: Sequence[int],
    probabilities: Sequence[float],
    losses: Sequence[float] = (),
    offset_correct: int = 0,
    offset_count: int = 0,
) -> dict[str, Any]:
    y = np.asarray(labels, dtype=np.int64)
    p = np.asarray(probabilities, dtype=np.float64)
    predictions = (p >= 0.5).astype(np.int64)
    result: dict[str, Any] = {
        "n": int(len(y)),
        "loss": float(np.mean(losses)) if losses else None,
        "offset_accuracy": float(offset_correct / offset_count) if offset_count else None,
    }
    if len(y) == 0:
        return result
    result["accuracy"] = float(np.mean(predictions == y))
    if len(np.unique(y)) == 2 and roc_auc_score is not None:
        result["roc_auc"] = float(roc_auc_score(y, p))
    if precision_recall_fscore_support is not None:
        precision, recall, f1, _ = precision_recall_fscore_support(y, predictions, average="binary", zero_division=0)
        result.update({"precision": float(precision), "recall": float(recall), "f1": float(f1)})
        result["confusion_matrix"] = confusion_matrix(y, predictions).tolist()
    result["labels"] = y.tolist()
    result["probabilities"] = p.tolist()
    return result


def compact_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in metrics.items() if key not in {"labels", "probabilities"}}


def command_train(args: argparse.Namespace) -> None:
    seed_everything(args.seed)
    config = config_from_args(args)
    device = choose_device(args.device)
    manifest = Path(args.prepared_manifest).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    train_dataset, validation_dataset = load_prepared_datasets(manifest, config, args)
    train_loader = make_loader(train_dataset, args, shuffle=True)
    validation_loader = make_loader(validation_dataset, args, shuffle=False)
    model = AudioVisualSyncNet(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs))
    try:
        scaler = torch.amp.GradScaler("cuda", enabled=args.amp and device.type == "cuda")
    except (AttributeError, TypeError):  # PyTorch versions used by older Colab runtimes.
        scaler = torch.cuda.amp.GradScaler(enabled=args.amp and device.type == "cuda")
    best_auc = -math.inf
    history: list[dict[str, Any]] = []
    print(json.dumps({"device": str(device), "train_records": len(train_dataset), "val_records": len(validation_dataset), "config": asdict(config)}, indent=2))

    for epoch in range(1, args.epochs + 1):
        train_metrics = run_epoch(
            model,
            train_loader,
            device,
            optimizer,
            scaler,
            args.offset_loss_weight,
            args.amp,
            args.max_train_steps,
        )
        validation_metrics = run_epoch(
            model,
            validation_loader,
            device,
            None,
            None,
            args.offset_loss_weight,
            args.amp,
            args.max_eval_steps,
        )
        scheduler.step()
        score = float(validation_metrics.get("roc_auc", validation_metrics.get("accuracy", 0.0)))
        summary = {
            "epoch": epoch,
            "learning_rate": float(optimizer.param_groups[0]["lr"]),
            "train": compact_metrics(train_metrics),
            "validation": compact_metrics(validation_metrics),
        }
        history.append(summary)
        print(json.dumps(summary, indent=2))
        payload = {
            "schema_version": SCHEMA_VERSION,
            "model_version": MODEL_VERSION,
            "created_at": utc_now(),
            "epoch": epoch,
            "model_config": asdict(config),
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "metrics": summary,
            "history": history,
        }
        torch.save(payload, output_dir / "latest.pt")
        if score > best_auc:
            best_auc = score
            torch.save(payload, output_dir / "best.pt")
    write_json(output_dir / "training_history.json", history)
    print(f"Best checkpoint: {output_dir / 'best.pt'}")


def safe_torch_load(path: Path, device: torch.device) -> dict[str, Any]:
    try:
        return torch.load(path, map_location=device, weights_only=False)
    except TypeError:  # Older Colab PyTorch.
        return torch.load(path, map_location=device)


def load_checkpoint(path: Path, device: torch.device) -> tuple[AudioVisualSyncNet, ModelConfig, dict[str, Any]]:
    payload = safe_torch_load(path, device)
    config = ModelConfig(**payload["model_config"])
    model = AudioVisualSyncNet(config).to(device)
    model.load_state_dict(payload["model_state"], strict=True)
    model.eval()
    return model, config, payload


@torch.no_grad()
def collect_predictions(model: AudioVisualSyncNet, loader: DataLoader, device: torch.device, amp: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    logits: list[float] = []
    labels: list[int] = []
    for batch in tqdm(loader, desc="Collect predictions", leave=False):
        with amp_context(device, amp):
            mismatch_logit, _, _ = model(batch["mouth"].to(device), batch["audio"].to(device))
        logits.extend(mismatch_logit.float().cpu().tolist())
        labels.extend(batch["label"].int().tolist())
    raw = np.asarray(logits, dtype=np.float64)
    return raw, 1.0 / (1.0 + np.exp(-np.clip(raw, -40.0, 40.0))), np.asarray(labels, dtype=np.int64)


def calibrate_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    if len(logits) < 4 or len(np.unique(labels)) < 2:
        return 1.0
    log_temperature = torch.zeros((), dtype=torch.float64, requires_grad=True)
    logits_tensor = torch.from_numpy(logits)
    labels_tensor = torch.from_numpy(labels.astype(np.float64))
    optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=60, line_search_fn="strong_wolfe")

    def closure() -> Tensor:
        optimizer.zero_grad()
        temperature = log_temperature.exp().clamp(0.05, 20.0)
        loss = F.binary_cross_entropy_with_logits(logits_tensor / temperature, labels_tensor)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_temperature.detach().exp().clamp(0.05, 20.0))


def choose_state_thresholds(probabilities: np.ndarray, labels: np.ndarray, target_precision: float) -> dict[str, float]:
    aligned = probabilities[labels == 0]
    mismatched = probabilities[labels == 1]
    if len(aligned) == 0 or len(mismatched) == 0:
        return {"aligned_max": 0.35, "mismatched_min": 0.80, "target_mismatch_precision": target_precision}
    aligned_max = float(np.quantile(aligned, 0.95))
    candidates = sorted(set(float(value) for value in probabilities))
    acceptable: list[tuple[float, float, float]] = []
    for threshold in candidates:
        predicted = probabilities >= threshold
        true_positive = int(np.sum(predicted & (labels == 1)))
        false_positive = int(np.sum(predicted & (labels == 0)))
        precision = true_positive / max(1, true_positive + false_positive)
        recall = true_positive / max(1, int(np.sum(labels == 1)))
        if precision >= target_precision and true_positive > 0:
            acceptable.append((recall, -threshold, threshold))
    mismatch_min = max(acceptable)[2] if acceptable else float(np.quantile(mismatched, 0.75))
    if mismatch_min <= aligned_max:
        midpoint = float((np.median(aligned) + np.median(mismatched)) / 2.0)
        aligned_max = min(aligned_max, midpoint - 0.05)
        mismatch_min = max(mismatch_min, midpoint + 0.05)
    return {
        "aligned_max": float(np.clip(aligned_max, 0.01, 0.95)),
        "mismatched_min": float(np.clip(mismatch_min, 0.05, 0.99)),
        "target_mismatch_precision": target_precision,
    }


def evaluate_and_calibrate(
    model: AudioVisualSyncNet,
    records: list[dict[str, Any]],
    split: str,
    config: ModelConfig,
    args: argparse.Namespace,
    device: torch.device,
) -> tuple[dict[str, Any], dict[str, Any]]:
    dataset = CachedAVDataset(records, split, config, training=False, seed=args.seed)
    loader = make_loader(dataset, args, shuffle=False)
    logits, _, labels = collect_predictions(model, loader, device, args.amp)
    temperature = calibrate_temperature(logits, labels)
    probabilities = 1.0 / (1.0 + np.exp(-np.clip(logits / temperature, -40.0, 40.0)))
    metrics = compute_metrics(labels.tolist(), probabilities.tolist())
    thresholds = {
        "schema_version": SCHEMA_VERSION,
        "temperature": temperature,
        "states": choose_state_thresholds(probabilities, labels, args.target_precision),
        "gates": asdict(GateConfig()),
        "calibrated_split": split,
        "calibrated_records": int(len(labels)),
    }
    return compact_metrics(metrics), thresholds


def command_evaluate(args: argparse.Namespace) -> None:
    device = choose_device(args.device)
    checkpoint = Path(args.checkpoint).expanduser().resolve()
    model, config, _ = load_checkpoint(checkpoint, device)
    records = read_jsonl(Path(args.prepared_manifest).expanduser().resolve())
    if args.thresholds_in:
        thresholds_payload = json.loads(Path(args.thresholds_in).expanduser().resolve().read_text(encoding="utf-8"))
        thresholds = thresholds_payload.get("thresholds", thresholds_payload)
        dataset = CachedAVDataset(records, args.split, config, training=False, seed=args.seed)
        loader = make_loader(dataset, args, shuffle=False)
        logits, _, labels = collect_predictions(model, loader, device, args.amp)
        temperature = float(thresholds.get("temperature", 1.0))
        probabilities = 1.0 / (1.0 + np.exp(-np.clip(logits / temperature, -40.0, 40.0)))
        metrics = compact_metrics(compute_metrics(labels.tolist(), probabilities.tolist()))
        state_thresholds = thresholds["states"]
        decided = (probabilities <= float(state_thresholds["aligned_max"])) | (
            probabilities >= float(state_thresholds["mismatched_min"])
        )
        predicted_mismatch = probabilities >= float(state_thresholds["mismatched_min"])
        metrics["decision_coverage"] = float(np.mean(decided))
        metrics["mismatch_precision_at_policy"] = float(
            np.sum(predicted_mismatch & (labels == 1)) / max(1, int(np.sum(predicted_mismatch)))
        )
    else:
        if args.split == "test":
            raise ValueError("Do not calibrate on the test set. Pass validation output with --thresholds-in.")
        metrics, thresholds = evaluate_and_calibrate(model, records, args.split, config, args, device)
    output = Path(args.output).expanduser().resolve()
    write_json(output, {"checkpoint": str(checkpoint), "metrics": metrics, "thresholds": thresholds})
    print(json.dumps({"metrics": metrics, "thresholds": thresholds, "output": str(output)}, indent=2))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command_export(args: argparse.Namespace) -> None:
    device = torch.device("cpu")
    checkpoint = Path(args.checkpoint).expanduser().resolve()
    model, config, payload = load_checkpoint(checkpoint, device)
    thresholds_path = Path(args.thresholds).expanduser().resolve()
    thresholds_payload = json.loads(thresholds_path.read_text(encoding="utf-8"))
    thresholds = thresholds_payload.get("thresholds", thresholds_payload)
    temperature = float(thresholds.get("temperature", 1.0))
    exported = ExportedAVSync(model, temperature).eval()
    scripted = torch.jit.script(exported)
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "orislop_avsync.ts"
    scripted.save(str(model_path))
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "created_at": utc_now(),
        "artifact": model_path.name,
        "sha256": sha256_file(model_path),
        "states": list(STATE_LABELS),
        "model_config": asdict(config),
        "thresholds": thresholds,
        "training_metrics": payload.get("metrics", {}),
        "input_contract": {
            "mouth": ["batch", 3, config.clip_frames, config.mouth_size, config.mouth_size],
            "waveform": ["batch", int(round(config.clip_frames / config.target_fps * config.sample_rate))],
            "mouth_range": [0.0, 1.0],
            "sample_rate": config.sample_rate,
            "target_fps": config.target_fps,
        },
        "output_contract": ["mismatch_probability", "offset_probabilities", "embedding"],
        "safety": "A mismatch is evidence only. Orislop fusion must require corroboration before automatic Skip.",
    }
    metadata_path = output_dir / "orislop_avsync.json"
    write_json(metadata_path, metadata)
    (output_dir / "README.md").write_text(
        "# Orislop AV-sync export\n\n"
        "Load `orislop_avsync.ts` with `torch.jit.load`. Apply the gates and calibrated thresholds "
        "from `orislop_avsync.json`. Never treat this model as a standalone deepfake verdict.\n",
        encoding="utf-8",
    )
    if args.push_to_hub:
        if not args.hf_repo_id:
            raise ValueError("--hf-repo-id is required with --push-to-hub")
        from huggingface_hub import HfApi

        token = os.environ.get("HF_TOKEN") or None
        api = HfApi(token=token)
        api.create_repo(args.hf_repo_id, repo_type="model", private=args.private, exist_ok=True)
        api.upload_folder(repo_id=args.hf_repo_id, repo_type="model", folder_path=str(output_dir))
    print(json.dumps({"model": str(model_path), "metadata": str(metadata_path), "sha256": metadata["sha256"]}, indent=2))


def applicability_state(quality: dict[str, float], gates: GateConfig) -> tuple[str | None, list[str]]:
    reasons: list[str] = []
    if quality["face_coverage"] < gates.minimum_face_coverage:
        reasons.append("insufficient_visible_face")
    if quality["speech_ratio"] < gates.minimum_speech_ratio:
        reasons.append("insufficient_speech")
    if quality["mouth_motion"] < gates.minimum_mouth_motion:
        reasons.append("lips_not_moving_enough")
    if quality["usable_seconds"] < gates.minimum_usable_seconds:
        reasons.append("clip_too_short")
    if reasons:
        return "not_applicable", reasons
    if quality["snr_db"] < gates.minimum_snr_db:
        return "uncertain", ["audio_too_noisy"]
    return None, []


def tensor_windows(cache_path: Path, config: ModelConfig) -> list[tuple[Tensor, Tensor]]:
    with np.load(cache_path, allow_pickle=False) as cache:
        mouths = cache["mouths"].copy()
        audio = cache["audio"].copy()
    windows: list[tuple[Tensor, Tensor]] = []
    stride = max(1, config.clip_frames // 2)
    starts = list(range(0, max(1, len(mouths) - config.clip_frames + 1), stride))
    if len(mouths) >= config.clip_frames and starts[-1] != len(mouths) - config.clip_frames:
        starts.append(len(mouths) - config.clip_frames)
    for start in starts:
        clip = mouths[start:start + config.clip_frames]
        if len(clip) < config.clip_frames:
            continue
        samples_per_frame = config.sample_rate / config.target_fps
        waveform = slice_with_padding(audio, int(round(start * samples_per_frame)), int(round(config.clip_frames * samples_per_frame)))
        waveform = waveform.astype(np.float32)
        waveform -= float(np.mean(waveform))
        peak = float(np.max(np.abs(waveform)))
        if peak > 1e-4:
            waveform /= max(peak, 0.1)
        mouth_tensor = torch.from_numpy(clip).permute(3, 0, 1, 2).float().div_(255.0).unsqueeze(0)
        windows.append((mouth_tensor, torch.from_numpy(waveform).unsqueeze(0)))
    return windows


def command_predict(args: argparse.Namespace) -> None:
    device = choose_device(args.device)
    checkpoint = Path(args.checkpoint).expanduser().resolve()
    model, config, _ = load_checkpoint(checkpoint, device)
    thresholds_payload = json.loads(Path(args.thresholds).expanduser().resolve().read_text(encoding="utf-8"))
    thresholds = thresholds_payload.get("thresholds", thresholds_payload)
    temperature = float(thresholds.get("temperature", 1.0))
    gates = GateConfig(**thresholds.get("gates", asdict(GateConfig())))
    record = {"id": "prediction", "video_path": str(Path(args.video).expanduser().resolve()), "label": "uncertain", "split": "predict"}
    with tempfile.TemporaryDirectory(prefix="orislop-avsync-predict-") as temporary:
        prepared = preprocess_record(
            record,
            Path.cwd(),
            Path(temporary),
            config,
            max_seconds=args.max_seconds,
            detect_every=args.detect_every,
            overwrite=True,
        )
        quality = prepared["quality"]
        state, reasons = applicability_state(quality, gates)
        probabilities: list[float] = []
        if state is None:
            with torch.no_grad():
                for mouth, audio in tensor_windows(Path(prepared["cache_path"]), config):
                    logit, _, _ = model(mouth.to(device), audio.to(device))
                    probabilities.append(float(torch.sigmoid(logit / temperature).cpu().item()))
            if not probabilities:
                state, reasons = "not_applicable", ["no_complete_analysis_window"]
            else:
                probability = float(np.median(probabilities))
                state_thresholds = thresholds["states"]
                if probability >= float(state_thresholds["mismatched_min"]):
                    state = "mismatched"
                elif probability <= float(state_thresholds["aligned_max"]):
                    state = "aligned"
                else:
                    state, reasons = "uncertain", ["model_probability_in_abstention_band"]
        result = {
            "video": str(Path(args.video).expanduser().resolve()),
            "state": state,
            "mismatch_probability": float(np.median(probabilities)) if probabilities else None,
            "window_probabilities": probabilities,
            "quality": quality,
            "reasons": reasons,
            "warning": "This is one fusion signal, not a standalone deepfake verdict.",
        }
        print(json.dumps(result, indent=2))


def command_self_test(args: argparse.Namespace) -> None:
    seed_everything(860)
    config = ModelConfig(clip_frames=12, mouth_size=48, embedding_dim=64, max_offset_frames=3)
    model = AudioVisualSyncNet(config)
    mouth = torch.rand(2, 3, config.clip_frames, config.mouth_size, config.mouth_size)
    waveform_length = int(round(config.clip_frames / config.target_fps * config.sample_rate))
    waveform = torch.randn(2, waveform_length) * 0.05
    mismatch_logit, offset_logits, embedding = model(mouth, waveform)
    assert mismatch_logit.shape == (2,)
    assert offset_logits.shape == (2, 2 * config.max_offset_frames + 1)
    assert embedding.shape == (2, config.embedding_dim)
    loss = F.binary_cross_entropy_with_logits(mismatch_logit, torch.tensor([0.0, 1.0]))
    loss.backward()

    gate_state, gate_reasons = applicability_state(
        {"face_coverage": 1.0, "speech_ratio": 0.8, "mouth_motion": 0.0, "snr_db": 20.0, "usable_seconds": 2.0},
        GateConfig(),
    )
    assert gate_state == "not_applicable" and "lips_not_moving_enough" in gate_reasons
    with tempfile.TemporaryDirectory(prefix="orislop-avsync-self-test-") as temporary:
        artifact = Path(temporary) / "model.ts"
        scripted = torch.jit.script(ExportedAVSync(model.eval(), 1.0))
        scripted.save(str(artifact))
        loaded = torch.jit.load(str(artifact))
        probability, offsets, loaded_embedding = loaded(mouth, waveform)
        assert probability.shape == (2,) and torch.all((probability >= 0) & (probability <= 1))
        assert offsets.shape == offset_logits.shape
        assert loaded_embedding.shape == embedding.shape
    print(json.dumps({"self_test": "passed", "model_version": MODEL_VERSION, "torch": torch.__version__}, indent=2))


def add_model_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--sample-rate", type=int, default=16_000)
    parser.add_argument("--target-fps", type=int, default=25)
    parser.add_argument("--clip-frames", type=int, default=25)
    parser.add_argument("--mouth-size", type=int, default=96)
    parser.add_argument("--embedding-dim", type=int, default=128)
    parser.add_argument("--max-offset-frames", type=int, default=7)


def add_runtime_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--amp", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--seed", type=int, default=860)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    manifest = subparsers.add_parser("build-manifest", help="Create JSONL from aligned/mismatched dataset folders")
    manifest.add_argument("--data-root", required=True)
    manifest.add_argument("--output", required=True)
    manifest.add_argument("--train-fraction", type=float, default=0.80)
    manifest.add_argument("--val-fraction", type=float, default=0.10)
    manifest.set_defaults(handler=command_build_manifest)

    prepare = subparsers.add_parser("prepare", help="Extract normalized mouth tracks and 16 kHz audio caches")
    prepare.add_argument("--manifest", required=True)
    prepare.add_argument("--data-root", required=True)
    prepare.add_argument("--cache-dir", required=True)
    prepare.add_argument("--output-manifest", required=True)
    prepare.add_argument("--max-seconds", type=float, default=12.0)
    prepare.add_argument("--detect-every", type=int, default=5)
    prepare.add_argument("--overwrite", action="store_true")
    prepare.add_argument("--fail-fast", action="store_true")
    add_model_arguments(prepare)
    prepare.set_defaults(handler=command_prepare)

    train = subparsers.add_parser("train", help="Train the audio-visual correlation network")
    train.add_argument("--prepared-manifest", required=True)
    train.add_argument("--output-dir", required=True)
    train.add_argument("--epochs", type=int, default=20)
    train.add_argument("--learning-rate", type=float, default=3e-4)
    train.add_argument("--weight-decay", type=float, default=1e-4)
    train.add_argument("--offset-loss-weight", type=float, default=0.25)
    train.add_argument("--synthetic-mismatch-probability", type=float, default=0.45)
    train.add_argument("--swapped-audio-probability", type=float, default=0.10)
    train.add_argument("--minimum-shift-frames", type=int, default=3)
    train.add_argument("--max-train-steps", type=int)
    train.add_argument("--max-eval-steps", type=int)
    add_model_arguments(train)
    add_runtime_arguments(train)
    train.set_defaults(handler=command_train)

    evaluate = subparsers.add_parser("evaluate", help="Evaluate and calibrate the abstaining four-state policy")
    evaluate.add_argument("--checkpoint", required=True)
    evaluate.add_argument("--prepared-manifest", required=True)
    evaluate.add_argument("--split", choices=("val", "test"), default="val")
    evaluate.add_argument("--target-precision", type=float, default=0.98)
    evaluate.add_argument("--thresholds-in", help="Validation calibration JSON; required for an untouched test evaluation")
    evaluate.add_argument("--output", required=True)
    add_runtime_arguments(evaluate)
    evaluate.set_defaults(handler=command_evaluate)

    export = subparsers.add_parser("export", help="Export TorchScript, metadata, thresholds, and optionally upload to Hugging Face")
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--thresholds", required=True)
    export.add_argument("--output-dir", required=True)
    export.add_argument("--push-to-hub", action="store_true")
    export.add_argument("--hf-repo-id")
    export.add_argument("--private", action=argparse.BooleanOptionalAction, default=True)
    export.set_defaults(handler=command_export)

    predict = subparsers.add_parser("predict", help="Run gated AV-sync analysis on one local video")
    predict.add_argument("--video", required=True)
    predict.add_argument("--checkpoint", required=True)
    predict.add_argument("--thresholds", required=True)
    predict.add_argument("--max-seconds", type=float, default=12.0)
    predict.add_argument("--detect-every", type=int, default=5)
    predict.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    predict.set_defaults(handler=command_predict)

    self_test = subparsers.add_parser("self-test", help="Exercise model, gating, gradients, TorchScript export, and reload")
    self_test.set_defaults(handler=command_self_test)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
