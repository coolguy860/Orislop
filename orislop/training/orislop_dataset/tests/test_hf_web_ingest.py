#!/usr/bin/env python3
from __future__ import annotations

import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_DIR = REPO_ROOT / "training" / "orislop_dataset"
sys.path.insert(0, str(DATASET_DIR))
try:
    import build_dataset as builder
    import hf_web_ingest as ingest
finally:
    sys.path.pop(0)


def quarantine_row(index: int, *, source_url: str | None = None) -> dict[str, object]:
    return {
        "sample_id": f"web-fixture-{index:03d}",
        "label": 0,
        "platform": "open_dataset",
        "source_url": source_url or f"https://media.example.test/{index}.mp4",
        "source_asset_id": f"asset-{index:03d}",
        "group_id": f"asset-{index:03d}",
        "usage": "reference_only",
        "rights_status": "approved",
        "license_id": "fixture-license",
        "rights_evidence": "fixture-evidence",
        "label_status": "provisional",
        "estimated_bytes": (index + 1) * 1024,
    }


class HfWebIngestTests(unittest.TestCase):
    def test_colab_notebook_uses_hf_and_never_mounts_drive(self) -> None:
        notebook_path = DATASET_DIR / "orislop_hf_web_ingest_colab.ipynb"
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        source = "\n".join("".join(cell.get("source", [])) for cell in notebook["cells"])
        self.assertIn("hf_web_ingest.py", source)
        self.assertIn("HF_TOKEN", source)
        self.assertIn("publish-plan", source)
        self.assertIn("run-worker", source)
        self.assertNotIn("drive.mount", source)
        self.assertNotIn("/content/drive", source)

    def test_plan_is_bounded_and_assigned_across_four_workers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-hf-plan-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.jsonl"
            builder.write_jsonl(catalog, [quarantine_row(index) for index in range(24)])
            plan = ingest.build_plan(
                [catalog],
                root / "plan",
                repo_id="fixture/private-dataset",
                revision="fixture-run",
                mode="quarantine",
                workers=4,
                max_batch_bytes=64 * 1024,
                max_files=6,
                default_item_bytes=1024,
                run_id="fixture",
            )
            self.assertEqual(plan["records"], 24)
            self.assertTrue(all(batch["sample_count"] <= 6 for batch in plan["batches"]))
            self.assertTrue(all(batch["expected_bytes"] <= 64 * 1024 for batch in plan["batches"]))
            assigned = [batch_id for worker in plan["worker_assignments"].values() for batch_id in worker["batches"]]
            self.assertCountEqual(assigned, [batch["batch_id"] for batch in plan["batches"]])

    def test_social_media_page_is_never_a_download_source(self) -> None:
        row = quarantine_row(1, source_url="https://www.youtube.com/watch?v=blocked")
        with self.assertRaises(builder.CatalogError):
            ingest.select_rows([row], "quarantine")

    def test_completed_remote_marker_makes_worker_resume_without_download(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-hf-resume-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.jsonl"
            builder.write_jsonl(catalog, [quarantine_row(1)])
            plan_root = root / "plan"
            plan = ingest.build_plan(
                [catalog],
                plan_root,
                repo_id="fixture/private-dataset",
                revision="fixture-run",
                mode="quarantine",
                workers=1,
                max_batch_bytes=64 * 1024,
                max_files=6,
                default_item_bytes=1024,
                run_id="fixture",
            )
            batch = plan["batches"][0]
            marker = {"catalog_sha256": batch["catalog_sha256"], "status": "complete"}
            with mock.patch.object(ingest, "hf_api", return_value=object()), mock.patch.object(
                ingest, "remote_marker", return_value=marker
            ):
                result = ingest.run_batch(
                    plan_root,
                    batch["batch_id"],
                    root / "stage",
                    download_threads=2,
                    max_file_bytes=1024**3,
                    cleanup=True,
                )
            self.assertEqual(result["status"], "already_complete")
            self.assertFalse((root / "stage").exists())

    def test_cleanup_cannot_remove_stage_root_or_outside_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-hf-cleanup-") as temporary:
            root = Path(temporary)
            stage = root / "stage"
            child = stage / "run" / "batch"
            child.mkdir(parents=True)
            ingest.safe_remove_tree(child, stage)
            self.assertFalse(child.exists())
            with self.assertRaises(RuntimeError):
                ingest.safe_remove_tree(stage, stage)
            outside = root / "outside"
            outside.mkdir()
            with self.assertRaises(RuntimeError):
                ingest.safe_remove_tree(outside, stage)


if __name__ == "__main__":
    unittest.main(verbosity=2)
