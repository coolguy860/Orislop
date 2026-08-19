#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_DIR = REPO_ROOT / "training" / "orislop_dataset"
sys.path.insert(0, str(DATASET_DIR))
try:
    import build_dataset as builder
    import rolling_pipeline as rolling
finally:
    sys.path.pop(0)


EXPERTS = ("micro", "mid", "long", "extra_long")


def write_cache(root: Path, prefix: str, rows_by_split: dict[str, int]) -> None:
    manifest = []
    fingerprints = {name: f"checkpoint-{name}" for name in EXPERTS}
    for split, count in rows_by_split.items():
        if count <= 0:
            continue
        directory = root / split
        directory.mkdir(parents=True, exist_ok=True)
        labels = np.asarray([index % 2 for index in range(count)], dtype=np.int8)
        sample_ids = np.asarray([f"{prefix}-{split}-{index}" for index in range(count)], dtype=np.str_)
        datasets = np.asarray(["fixture"] * count, dtype=np.str_)
        embeddings = np.zeros((count, len(EXPERTS), 8), dtype=np.float16)
        logits = np.zeros((count, len(EXPERTS)), dtype=np.float32)
        probabilities = np.full((count, len(EXPERTS)), 0.5, dtype=np.float32)
        np.savez_compressed(
            directory / "cache-00000.npz",
            sample_ids=sample_ids,
            labels=labels,
            datasets=datasets,
            expert_names=np.asarray(EXPERTS, dtype=np.str_),
            embeddings=embeddings,
            logits=logits,
            probabilities=probabilities,
        )
        sidecar = []
        for index in range(count):
            row = {
                "sample_id": str(sample_ids[index]),
                "record_hash": str(sample_ids[index]),
                "label": int(labels[index]),
                "dataset": "fixture",
                "split": split,
                "shard_path": f"{split}/cache-00000.npz",
                "row_index": index,
            }
            sidecar.append(row)
            manifest.append(row)
        builder.write_jsonl(directory / "cache-00000.jsonl", sidecar)
    builder.write_jsonl(root / "cache_manifest.jsonl", manifest)
    builder.atomic_json(root / "cache_meta.json", {
        "schema_version": 1,
        "expert_names": list(EXPERTS),
        "embedding_dim": 8,
        "expert_checkpoint_specs": {name: name for name in EXPERTS},
        "expert_checkpoint_fingerprints": fingerprints,
        "counts": rows_by_split,
        "source_manifests": {split: f"{prefix}-{split}" for split in rows_by_split},
        "source_manifest_fingerprints": {split: f"fingerprint-{prefix}-{split}" for split in rows_by_split},
    })
    builder.atomic_write_text(root / "READY", "ready\n")


class RollingPipelineTests(unittest.TestCase):
    def test_four_worker_notebook_contract(self) -> None:
        notebook = json.loads((DATASET_DIR / "orislop_four_worker_rolling_colab.ipynb").read_text(encoding="utf-8"))
        self.assertEqual(notebook["nbformat"], 4)
        source = "\n".join("".join(cell.get("source", [])) for cell in notebook["cells"])
        self.assertIn("WORKER_ID = 0", source)
        self.assertIn("run-worker", source)
        self.assertIn("merge-run", source)
        self.assertIn("--start-at', 'train", source)

    def test_worker_caches_merge_into_valid_training_cache(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-cache-merge-") as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            write_cache(first, "first", {"train": 4, "val": 2, "test": 2})
            write_cache(second, "second", {"train": 3, "val": 1, "test": 1})
            output = root / "merged"
            report = rolling.merge_expert_caches([first, second], output)
            self.assertEqual(report["counts"], {"train": 7, "val": 3, "test": 3})
            self.assertEqual(report["validation"]["total"], 13)
            self.assertTrue((output / "READY").is_file())
            self.assertEqual(len(builder.read_jsonl(output / "cache_manifest.jsonl")), 13)

    def test_batch_runs_from_owned_media_through_temporal_packaging(self) -> None:
        try:
            import cv2
        except ImportError:
            self.skipTest("opencv-python is not installed")
        with tempfile.TemporaryDirectory(prefix="orislop-rolling-video-") as temporary:
            root = Path(temporary)
            media_root = root / "owned-media"
            media_root.mkdir()
            splits = root / "splits"
            for split_index, split in enumerate(builder.SPLITS):
                video = media_root / f"{split}.avi"
                writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (48, 48))
                if not writer.isOpened():
                    self.skipTest("OpenCV MJPG writer is unavailable")
                try:
                    for frame_index in range(20):
                        frame = np.zeros((48, 48, 3), dtype=np.uint8)
                        frame[:, :, split_index] = 40 + frame_index * 5
                        writer.write(frame)
                finally:
                    writer.release()
                label = split_index % 2
                row = {
                    "sample_id": f"rolling-video-{split}",
                    "label": label,
                    "authenticity_label": "manipulated" if label else "genuine",
                    "media_origin": "hybrid" if label else "camera_capture",
                    "transformation_types": ["face_swap"] if label else ["none"],
                    "sync_status": "manipulated_sync" if label else "synchronized",
                    "platform": "local",
                    "source_path": str(video),
                    "acquisition_method": "controlled_generation" if label else "local_owned_master",
                    "content_profile": "general_video",
                    "source_asset_id": f"rolling-video-{split}",
                    "group_id": f"rolling-video-{split}",
                    "creator_id": f"creator-{split}",
                    "generator_id": "fixture-generator" if label else "",
                    "generator_family_id": "fixture-generator-family" if label else "",
                    "usage": "training",
                    "rights_status": "approved",
                    "license_id": "owned-fixture",
                    "rights_evidence": {
                        "download_permitted": True,
                        "commercial_ml_training": True,
                        "derivatives_permitted": True,
                        "trained_model_distribution_permitted": True,
                        "license_or_contract_id": "owned-fixture",
                    },
                    "rights_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"rights-{split}"},
                    "label_status": "verified",
                    "label_evidence": [{"type": "generation_log" if label else "capture_provenance", "reference": "fixture"}],
                    "provenance_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"provenance-{split}"},
                    "contains_identifiable_people": False,
                    "split": split,
                }
                builder.write_jsonl(splits / builder.SPLIT_FILES[split], [row])
            plan_root = root / "plan"
            plan = rolling.build_plan(
                splits,
                plan_root,
                workers=4,
                max_batch_bytes=1024 * 1024 * 100,
                default_item_bytes=1024 * 1024,
                working_set_multiplier=1.2,
                run_id="fixture-run",
            )
            self.assertEqual(len(plan["batches"]), 1)
            status = rolling.run_batch(
                plan_root,
                plan["batches"][0]["batch_id"],
                root / "stage",
                None,
                None,
                stop_after="pack",
                execute=True,
                confirm_rights=True,
                cleanup=False,
            )
            self.assertEqual(status["phase"], "packed")
            packaged = root / "stage" / "fixture-run" / plan["batches"][0]["batch_id"] / "packaged"
            package_report = rolling.read_json(packaged / "package_report.json")
            self.assertEqual(package_report["counts"], {"train": 1, "val": 1, "test": 1})

    def test_merge_rejects_changed_expert_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-cache-reject-") as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            write_cache(first, "first", {"train": 2, "val": 1, "test": 1})
            write_cache(second, "second", {"train": 2, "val": 1, "test": 1})
            meta = rolling.read_json(second / "cache_meta.json")
            meta["expert_checkpoint_fingerprints"]["micro"] = "different"
            builder.atomic_json(second / "cache_meta.json", meta)
            with self.assertRaises(builder.CatalogError):
                rolling.merge_expert_caches([first, second], root / "merged")


if __name__ == "__main__":
    unittest.main(verbosity=2)
