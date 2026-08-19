#!/usr/bin/env python3
"""Offline synthetic test for cached Stage 2 training and Stage 3 calibration."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np


ROOT = Path(__file__).resolve().parents[3]
TRAINER = ROOT / "core" / "temporal_detector" / "temporal_deepfake_moe_hf_colab.py"
ORCHESTRATOR = ROOT / "training" / "orislop_temporal_retrain" / "colab_retrain.py"
NOTEBOOK = ROOT / "training" / "orislop_temporal_retrain" / "orislop_temporal_fusion_v5_colab.ipynb"
EXAMPLE_CONFIG = ROOT / "training" / "orislop_temporal_retrain" / "temporal_fusion_v5_config.example.json"
EXPERTS = ("micro", "mid", "long", "extra_long", "spatial", "lip_sync")
EMBEDDING_DIM = 16


def run(*arguments: object) -> None:
    command = [sys.executable, str(TRAINER), *[str(argument) for argument in arguments]]
    environment = os.environ.copy()
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_HUB_TOKEN"):
        environment.pop(name, None)
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\n"
            f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
        )


def write_cache(cache: Path) -> None:
    rng = np.random.default_rng(1337)
    manifest_rows = []
    split_sizes = {"train": 16, "val": 8, "test": 8}
    for split, count in split_sizes.items():
        split_dir = cache / split
        split_dir.mkdir(parents=True)
        labels = np.asarray([index % 2 for index in range(count)], dtype=np.int8)
        sample_ids = np.asarray([f"{split}-{index}" for index in range(count)], dtype=np.str_)
        datasets = np.asarray(["synthetic"] * count, dtype=np.str_)
        signal = labels.astype(np.float32) * 2.0 - 1.0
        embeddings = rng.normal(0.0, 0.15, (count, len(EXPERTS), EMBEDDING_DIM)).astype(np.float32)
        embeddings[:, :, 0] += signal[:, None] * 1.5
        logits = signal[:, None] * np.asarray([1.5, 1.8, 2.0, 2.2, 1.7, 1.6], dtype=np.float32)[None, :]
        logits += rng.normal(0.0, 0.1, logits.shape).astype(np.float32)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        shard_relative = f"{split}/cache-00000.npz"
        np.savez_compressed(
            cache / shard_relative,
            sample_ids=sample_ids,
            labels=labels,
            datasets=datasets,
            expert_names=np.asarray(EXPERTS, dtype=np.str_),
            embeddings=embeddings.astype(np.float16),
            logits=logits,
            probabilities=probabilities,
        )
        sidecar_rows = []
        for index in range(count):
            row = {
                "sample_id": str(sample_ids[index]),
                "record_hash": str(sample_ids[index]),
                "label": int(labels[index]),
                "dataset": "synthetic",
                "split": split,
                "shard_path": shard_relative,
                "row_index": index,
            }
            sidecar_rows.append(row)
            manifest_rows.append(row)
        (split_dir / "cache-00000.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in sidecar_rows),
            encoding="utf-8",
        )
    (cache / "cache_manifest.jsonl").write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in manifest_rows),
        encoding="utf-8",
    )
    (cache / "cache_meta.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "expert_names": list(EXPERTS),
                "embedding_dim": EMBEDDING_DIM,
                "expert_checkpoint_fingerprints": {name: f"synthetic-{name}" for name in EXPERTS},
                "source_manifest_fingerprints": {split: f"synthetic-{split}" for split in split_sizes},
                "counts": split_sizes,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (cache / "READY").write_text("synthetic\n", encoding="utf-8")


def common(cache: Path, output: Path) -> list[object]:
    return [
        "--expert-cache-root", cache,
        "--local-cache-dir", output,
        "--allow-cpu-train", "true",
        "--precision", "fp32",
        "--embedding-dim", EMBEDDING_DIM,
        "--fusion-dim", 16,
        "--fusion-layers", 1,
        "--fusion-heads", 4,
        "--fusion-dropout", 0.0,
        "--fusion-use-disagreement-features", "true",
        "--cached-fusion-batch-size", 8,
        "--num-workers", 0,
        "--verify-cache-arrays", "true",
        "--auto-resume", "false",
        "--hf-auto-resume", "false",
        "--resume-policy", "fresh",
        "--upload-best-to-hf", "false",
        "--upload-latest-to-hf", "false",
        "--hf-upload-every-epoch", "false",
        "--disable-tqdm",
    ]


def main() -> None:
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    assert notebook["nbformat"] == 4 and len(notebook["cells"]) >= 8
    example = json.loads(EXAMPLE_CONFIG.read_text(encoding="utf-8"))
    assert example["data"]["smoke_shards"] == 0
    assert example["av"]["enabled"] is False
    subprocess.run([sys.executable, str(ORCHESTRATOR), "self-test"], cwd=ROOT, check=True)

    with tempfile.TemporaryDirectory(prefix="orislop-temporal-cached-") as temporary:
        work = Path(temporary)
        cache = work / "expert-cache"
        output = work / "run"
        cache.mkdir()
        write_cache(cache)
        base = common(cache, output)
        run(
            "--mode", "train_cached_fusion",
            *base,
            "--fusion-epochs", 1,
            "--fusion-early-stopping-patience", 0,
            "--fusion-expert-dropout", 0.0,
        )
        checkpoint_dir = output / "checkpoints"
        fusion = checkpoint_dir / "stage2_fusion_best.pt"
        assert fusion.is_file()
        run(
            "--mode", "calibrate_cached_fusion",
            *base,
            "--fusion-checkpoint", fusion,
            "--eval-split", "val",
            "--threshold-method", "target_real_fpr",
            "--threshold-target-real-fpr", 0.001,
        )
        calibration = checkpoint_dir / "stage3_calibration.pt"
        threshold = checkpoint_dir / "threshold.json"
        assert calibration.is_file() and threshold.is_file()
        run(
            "--mode", "eval_cached_fusion",
            *base,
            "--fusion-checkpoint", fusion,
            "--calibration-checkpoint", calibration,
            "--threshold-checkpoint", threshold,
            "--eval-split", "test",
        )
        metrics = json.loads((checkpoint_dir / "metrics_test.json").read_text(encoding="utf-8"))
        assert metrics["n"] == 8
        assert metrics["split"] == "test"
        assert "real_fpr" in metrics and "recall" in metrics and "ece" in metrics
    print("Orislop cached Temporal fusion train/calibrate/test pipeline passed.")


if __name__ == "__main__":
    main()
