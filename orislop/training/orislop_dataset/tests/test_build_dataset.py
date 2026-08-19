#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = REPO_ROOT / "training" / "orislop_dataset" / "build_dataset.py"
SPEC = importlib.util.spec_from_file_location("orislop_dataset_builder", MODULE_PATH)
assert SPEC and SPEC.loader
builder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = builder
SPEC.loader.exec_module(builder)


def catalog_row(index: int, *, label: int | None = None) -> dict[str, object]:
    chosen_label = index % 2 if label is None else label
    return {
        "sample_id": f"fixture-{index:03d}",
        "label": chosen_label,
        "authenticity_label": "manipulated" if chosen_label else "genuine",
        "media_origin": "hybrid" if chosen_label else "camera_capture",
        "transformation_types": ["face_swap"] if chosen_label else ["none"],
        "sync_status": "manipulated_sync" if chosen_label else "synchronized",
        "platform": ("youtube", "tiktok", "instagram")[index % 3],
        "source_path": f"media/fixture-{index:03d}.mp4",
        "acquisition_method": "controlled_generation" if chosen_label else "local_owned_master",
        "content_profile": "general_video",
        "source_asset_id": f"asset-{index // 2:03d}",
        "group_id": f"asset-{index // 2:03d}",
        "creator_id": f"creator-{index // 4:03d}",
        "generator_id": f"generator-{index % 7}" if chosen_label else "",
        "generator_family_id": f"generator-family-{index % 7}" if chosen_label else "",
        "usage": "training",
        "rights_status": "approved",
        "license_id": "fixture-license",
        "rights_evidence": {
            "download_permitted": True,
            "commercial_ml_training": True,
            "derivatives_permitted": True,
            "trained_model_distribution_permitted": True,
            "license_or_contract_id": "fixture-license",
        },
        "rights_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"rights-{index}"},
        "label_status": "verified",
        "label_evidence": [{
            "type": "generation_log" if chosen_label else "capture_provenance",
            "reference": "fixture evidence",
        }],
        "provenance_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"provenance-{index}"},
        "contains_identifiable_people": False,
    }


class DatasetBuilderTests(unittest.TestCase):
    def test_youtube_asset_id_survives_url_normalization(self) -> None:
        first = builder.canonical_url("https://www.youtube.com/watch?v=AAA&utm_source=x")
        second = builder.canonical_url("https://youtube.com/watch?feature=share&v=BBB")
        self.assertEqual(first, "https://youtube.com/watch?v=AAA")
        self.assertEqual(second, "https://youtube.com/watch?v=BBB")
        self.assertNotEqual(first, second)

    def test_training_requires_verified_label_and_approved_rights(self) -> None:
        row = catalog_row(1)
        row["rights_status"] = "reference_only"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("unsafe_training_rights", {issue["code"] for issue in report["errors"]})

    def test_invalid_label_returns_validation_error_instead_of_crashing(self) -> None:
        row = catalog_row(1)
        row["label"] = "not-a-label"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("invalid_label", {issue["code"] for issue in report["errors"]})

    def test_invalid_segment_returns_validation_error_instead_of_crashing(self) -> None:
        row = catalog_row(2)
        row["start_seconds"] = "not-a-number"
        row["end_seconds"] = 10
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("invalid_segment", {issue["code"] for issue in report["errors"]})

    def test_training_rejects_shallow_rights_string(self) -> None:
        row = catalog_row(10, label=0)
        row["rights_evidence"] = "contract.pdf"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("incomplete_training_rights", {issue["code"] for issue in report["errors"]})

    def test_benign_edits_stay_genuine_but_face_swap_cannot(self) -> None:
        row = catalog_row(12, label=0)
        row["transformation_types"] = ["crop", "caption_overlay", "benign_compression"]
        self.assertTrue(builder.validate_catalog([row])["valid"])
        row["transformation_types"] = ["face_swap", "benign_compression"]
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("genuine_has_synthetic_transformation", {issue["code"] for issue in report["errors"]})

    def test_synthetic_label_requires_a_synthetic_transformation(self) -> None:
        row = catalog_row(13, label=1)
        row["transformation_types"] = ["crop", "benign_compression"]
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("synthetic_missing_transformation", {issue["code"] for issue in report["errors"]})

    def test_short_form_feed_rows_require_scrolling_feed_metadata(self) -> None:
        row = catalog_row(13, label=1)
        row["content_profile"] = "short_form_feed"
        report = builder.validate_catalog([row])
        codes = {issue["code"] for issue in report["errors"]}
        self.assertIn("invalid_feed_context", codes)
        self.assertIn("invalid_visual_format", codes)
        self.assertIn("missing_content_styles", codes)
        self.assertIn("invalid_short_form_duration", codes)
        row.update({
            "primary_feed_context": "tiktok_feed",
            "visual_format": "vertical",
            "content_styles": ["reaction", "meme_caption"],
            "clip_duration_seconds": 12,
        })
        self.assertTrue(builder.validate_catalog([row])["valid"])

    def test_training_rejects_social_platform_media_url(self) -> None:
        row = catalog_row(14, label=0)
        row.pop("source_path")
        row["source_url"] = "https://www.youtube.com/watch?v=not-a-master"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("platform_media_not_authorized_for_acquisition", {issue["code"] for issue in report["errors"]})

    def test_training_rejects_ambiguous_source_mechanisms(self) -> None:
        row = catalog_row(14, label=0)
        row["source_url"] = "https://media.example.test/fixture.mp4"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("multiple_source_mechanisms", {issue["code"] for issue in report["errors"]})

    def test_rejected_rights_review_cannot_enter_training(self) -> None:
        row = catalog_row(14, label=0)
        row["rights_review"]["status"] = "rejected"
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("rights_review_not_approved", {issue["code"] for issue in report["errors"]})

    def test_identifiable_synthetic_performer_needs_specific_consent(self) -> None:
        row = catalog_row(15, label=1)
        row["contains_identifiable_people"] = True
        row["performer_consent"] = {
            "consent_id": "performer-15",
            "adult_confirmed": True,
            "biometric_processing": True,
            "commercial_ml_training": True,
            "retention": True,
            "trained_model_distribution": True,
            "synthetic_media": True,
        }
        report = builder.validate_catalog([row])
        self.assertFalse(report["valid"])
        self.assertIn("missing_face_manipulation_consent", {issue["code"] for issue in report["errors"]})

    def test_safety_genuine_is_evaluation_only_and_forced_to_test(self) -> None:
        row = catalog_row(16, label=0)
        row["usage"] = "safety_eval_only"
        row["evaluation_role"] = "safety_genuine"
        report = builder.validate_catalog([row])
        self.assertTrue(report["valid"], report["errors"])
        self.assertEqual(report["training_eligible"], 0)
        self.assertEqual(report["evaluation_eligible"], 1)
        splits, reference, _ = builder.split_catalog([row], builder.load_policy(None))
        self.assertFalse(reference)
        self.assertEqual([member["sample_id"] for member in splits["test"]], [row["sample_id"]])

    def test_safety_rows_do_not_change_core_balance_targets(self) -> None:
        core = catalog_row(18, label=0)
        safety = catalog_row(20, label=0)
        safety["usage"] = "safety_eval_only"
        safety["evaluation_role"] = "safety_genuine"
        counts = builder.group_counts([core, safety])
        self.assertEqual(counts["total"], 1)
        self.assertEqual(counts["label:0"], 1)

    def test_licensed_hugging_face_file_is_a_valid_source_contract(self) -> None:
        row = catalog_row(2, label=0)
        row.pop("source_path")
        row["hf_repo_id"] = "owner/licensed-dataset"
        row["hf_path"] = "videos/clip.mp4"
        row["hf_revision"] = "0123456789abcdef"
        report = builder.validate_catalog([row])
        self.assertTrue(report["valid"], report["errors"])
        self.assertEqual(report["training_eligible"], 1)

    def test_cross_platform_shadow_seed_is_quarantined(self) -> None:
        path = REPO_ROOT / "training" / "orislop_dataset" / "catalogs" / "cross_platform_shadow_seed.jsonl"
        report = builder.validate_catalog(builder.read_jsonl(path), catalog_path=path)
        self.assertTrue(report["valid"])
        self.assertEqual(report["records"], 13)
        self.assertEqual(report["training_eligible"], 0)

    def test_combine_normalizes_relative_local_media_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-combine-") as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            clip = media / "clip.mp4"
            clip.write_bytes(b"fixture")
            catalog = root / "catalog.jsonl"
            row = catalog_row(400, label=0)
            row.pop("source_path", None)
            row["media_path"] = "media/clip.mp4"
            builder.write_jsonl(catalog, [row])
            output = root / "combined.jsonl"
            result = builder.command_combine(type("Args", (), {"catalog": [str(catalog)], "output": str(output)})())
            self.assertEqual(result, 0)
            combined = builder.read_jsonl(output)
            self.assertTrue(Path(combined[0]["media_path"]).is_absolute())
            self.assertEqual(Path(combined[0]["media_path"]), clip.resolve())

    def test_connected_sources_and_creators_never_cross_splits(self) -> None:
        rows = [catalog_row(index) for index in range(96)]
        report = builder.validate_catalog(rows)
        self.assertTrue(report["valid"], report["errors"])
        splits, reference, _ = builder.split_catalog(rows, builder.load_policy(None))
        self.assertFalse(reference)
        owners: dict[str, str] = {}
        for split, members in splits.items():
            for row in members:
                for token in builder.linkage_tokens(row):
                    self.assertEqual(owners.setdefault(token, split), split)
        self.assertEqual(sum(map(len, splits.values())), len(rows))

    def test_heldout_generator_is_forced_to_test(self) -> None:
        rows = [catalog_row(index) for index in range(60)]
        policy = builder.load_policy(None)
        policy["heldout_generator_ids"] = ["generator-1"]
        splits, _, _ = builder.split_catalog(rows, policy)
        heldout = [row for members in splits.values() for row in members if row.get("generator_id") == "generator-1"]
        self.assertTrue(heldout)
        self.assertTrue(all(row["split"] == "test" for row in heldout))

    def test_heldout_generator_family_is_forced_to_test(self) -> None:
        rows = [catalog_row(index + 500) for index in range(60)]
        family = str(next(row["generator_family_id"] for row in rows if row.get("generator_family_id")))
        policy = builder.load_policy(None)
        policy["heldout_generator_family_ids"] = [family]
        splits, _, _ = builder.split_catalog(rows, policy)
        heldout = [row for members in splits.values() for row in members if row.get("generator_family_id") == family]
        self.assertTrue(heldout)
        self.assertTrue(all(row["split"] == "test" for row in heldout))

    def test_video_precompute_emits_all_temporal_views(self) -> None:
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("opencv-python and numpy are not installed")

        with tempfile.TemporaryDirectory(prefix="orislop-precompute-test-") as temporary:
            root = Path(temporary)
            media_root = root / "media"
            media_root.mkdir()
            video = media_root / "fixture.avi"
            writer = cv2.VideoWriter(
                str(video),
                cv2.VideoWriter_fourcc(*"MJPG"),
                10.0,
                (64, 64),
            )
            if not writer.isOpened():
                self.skipTest("OpenCV MJPG writer is unavailable")
            try:
                for index in range(40):
                    frame = np.zeros((64, 64, 3), dtype=np.uint8)
                    frame[:, :, index % 3] = min(255, 25 + index * 5)
                    writer.write(frame)
            finally:
                writer.release()

            split_root = root / "splits"
            for split, filename in builder.SPLIT_FILES.items():
                builder.write_jsonl(split_root / filename, [{
                    **catalog_row({"train": 200, "val": 201, "test": 202}[split]),
                    "sample_id": f"decode-{split}",
                    "media_path": "fixture.avi",
                    "split": split,
                }])

            output = root / "prepared"
            counts = {"micro": 6, "mid": 5, "long": 4, "extra_long": 3}
            report = builder.precompute_splits(
                split_root,
                media_root,
                output,
                image_size=32,
                view_counts=counts,
            )
            self.assertEqual(report["prepared"], 3)
            self.assertEqual(report["failed"], 0)
            with np.load(output / "views" / "test" / "decode-test.npz") as arrays:
                self.assertEqual(set(arrays.files), set(counts))
                for view, count in counts.items():
                    self.assertEqual(arrays[view].shape, (count, 32, 32, 3))
                    self.assertEqual(arrays[view].dtype, np.uint8)

    def test_pack_emits_temporal_moe_archive_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-pack-test-") as temporary:
            root = Path(temporary)
            prepared = root / "prepared"
            output = root / "packaged"
            relative = Path("views") / "train" / "sample.npz"
            source = prepared / relative
            source.parent.mkdir(parents=True)
            source.write_bytes(b"fixture-npz")
            manifests = prepared / "manifests"
            builder.write_jsonl(manifests / "train.jsonl", [{
                "sample_id": "sample",
                "label": 1,
                "dataset": "fixture",
                "split": "train",
                "video_path": relative.as_posix(),
            }])
            builder.write_jsonl(manifests / "validation.jsonl", [])
            builder.write_jsonl(manifests / "test.jsonl", [])

            report = builder.pack_prepared(prepared, output, max_shard_bytes=1024)
            self.assertEqual(report["counts"], {"train": 1, "val": 0, "test": 0})
            manifest = json.loads((output / "manifests" / "train.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(manifest["member_path"], relative.as_posix())
            archive = output / manifest["archive_path"]
            with tarfile.open(archive, "r") as handle:
                self.assertEqual(handle.getnames(), [relative.as_posix()])


if __name__ == "__main__":
    unittest.main(verbosity=2)
