#!/usr/bin/env python3
"""Synthetic end-to-end contract test for the Colab AV-sync workflow."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[3]
TRAINER = ROOT / "training" / "orislop_avsync" / "train_avsync.py"
SAMPLE_RATE = 16_000
TARGET_FPS = 25
MOUTH_SIZE = 48
FRAMES = 30


def write_cache(path: Path, label: str, seed: int) -> None:
    rng = np.random.default_rng(seed)
    seconds = FRAMES / TARGET_FPS
    audio_samples = int(seconds * SAMPLE_RATE)
    time = np.arange(audio_samples, dtype=np.float32) / SAMPLE_RATE
    envelope_time = np.arange(FRAMES, dtype=np.float32) / TARGET_FPS
    envelope = 0.45 + 0.35 * np.sin(2 * np.pi * 3.0 * envelope_time)
    if label == "mismatched":
        envelope = np.roll(envelope, 6)
    sample_positions = np.minimum((time * TARGET_FPS).astype(np.int64), FRAMES - 1)
    audio = (0.20 * envelope[sample_positions] * np.sin(2 * np.pi * 180.0 * time)).astype(np.float32)

    mouths = np.zeros((FRAMES, MOUTH_SIZE, MOUTH_SIZE, 3), dtype=np.uint8)
    for frame_index, openness in enumerate(0.45 + 0.35 * np.sin(2 * np.pi * 3.0 * envelope_time)):
        center = MOUTH_SIZE // 2
        radius = max(2, int(3 + openness * 8))
        mouths[frame_index, center - radius:center + radius, 8:-8] = 210
        mouths[frame_index] = np.clip(mouths[frame_index] + rng.integers(0, 8, mouths[frame_index].shape), 0, 255)
    quality = {
        "face_coverage": 1.0,
        "speech_ratio": 0.8,
        "snr_db": 24.0,
        "mouth_motion": 0.04,
        "usable_seconds": seconds,
        "valid_frames": FRAMES,
        "total_frames": FRAMES,
    }
    np.savez_compressed(
        path,
        mouths=mouths,
        valid=np.ones(FRAMES, dtype=np.bool_),
        audio=audio,
        sample_rate=np.asarray(SAMPLE_RATE, dtype=np.int32),
        target_fps=np.asarray(TARGET_FPS, dtype=np.int32),
        quality_json=np.asarray(json.dumps(quality)),
    )


def run(*arguments: object) -> None:
    command = [sys.executable, str(TRAINER), *[str(argument) for argument in arguments]]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise AssertionError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
        )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="orislop-avsync-e2e-") as temporary:
        work = Path(temporary)
        caches = work / "cache"
        caches.mkdir()
        manifest = work / "prepared.jsonl"
        records = []
        index = 0
        for split in ("train", "val", "test"):
            for label in ("aligned", "mismatched"):
                for sample in range(2):
                    cache = caches / f"{split}-{label}-{sample}.npz"
                    write_cache(cache, label, seed=index + 100)
                    records.append(
                        {
                            "id": f"{split}-{label}-{sample}",
                            "video_path": f"fixture/{split}-{label}-{sample}.mp4",
                            "cache_path": str(cache),
                            "label": label,
                            "split": split,
                            "quality": {"fixture": True},
                        }
                    )
                    index += 1
        manifest.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

        run(
            "train",
            "--prepared-manifest", manifest,
            "--output-dir", work / "run",
            "--epochs", 1,
            "--batch-size", 2,
            "--workers", 0,
            "--max-train-steps", 1,
            "--max-eval-steps", 1,
            "--mouth-size", MOUTH_SIZE,
            "--clip-frames", 12,
            "--embedding-dim", 64,
            "--max-offset-frames", 3,
            "--device", "cpu",
            "--no-amp",
        )
        checkpoint = work / "run" / "best.pt"
        validation = work / "run" / "validation.json"
        test = work / "run" / "test.json"
        run(
            "evaluate",
            "--checkpoint", checkpoint,
            "--prepared-manifest", manifest,
            "--split", "val",
            "--output", validation,
            "--batch-size", 2,
            "--workers", 0,
            "--device", "cpu",
            "--no-amp",
        )
        run(
            "evaluate",
            "--checkpoint", checkpoint,
            "--prepared-manifest", manifest,
            "--split", "test",
            "--thresholds-in", validation,
            "--output", test,
            "--batch-size", 2,
            "--workers", 0,
            "--device", "cpu",
            "--no-amp",
        )
        run(
            "export",
            "--checkpoint", checkpoint,
            "--thresholds", validation,
            "--output-dir", work / "export",
        )
        artifact = work / "export" / "orislop_avsync.ts"
        metadata_path = work / "export" / "orislop_avsync.json"
        assert artifact.is_file() and metadata_path.is_file() and test.is_file()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        assert metadata["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
        scripted = torch.jit.load(str(artifact))
        mouth = torch.rand(1, 3, 12, MOUTH_SIZE, MOUTH_SIZE)
        audio = torch.rand(1, int(12 / TARGET_FPS * SAMPLE_RATE))
        probability, offsets, embedding = scripted(mouth, audio)
        assert probability.shape == (1,)
        assert offsets.shape == (1, 7)
        assert embedding.shape == (1, 64)
    print("Orislop AV-sync synthetic Colab pipeline passed.")


if __name__ == "__main__":
    main()
