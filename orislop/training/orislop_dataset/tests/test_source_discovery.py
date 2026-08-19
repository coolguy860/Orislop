#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_DIR = REPO_ROOT / "training" / "orislop_dataset"
sys.path.insert(0, str(DATASET_DIR))
try:
    import build_dataset as builder
    import discover_sources as discovery
finally:
    sys.path.pop(0)


def commons_page(license_name: str) -> dict:
    return {
        "pageid": 12345,
        "title": "File:Fixture interview.webm",
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/fixture.webm",
            "size": 123456,
            "mime": "video/webm",
            "mediatype": "VIDEO",
            "sha1": "abc123",
            "extmetadata": {
                "LicenseShortName": {"value": license_name},
                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by/4.0/"},
                "Artist": {"value": "<b>Fixture Author</b>"},
                "ObjectName": {"value": "Fixture interview"},
            },
        }],
    }


class SourceDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = discovery.registry(DATASET_DIR / "source_registry.json")
        self.commons_source = discovery.registry_source(self.registry, "wikimedia_commons")

    def test_commons_cc_by_is_rights_approved_but_not_training_approved(self) -> None:
        row = discovery.commons_record(commons_page("CC BY 4.0"), self.commons_source, "Videos of interviews")
        assert row is not None
        self.assertEqual(row["rights_status"], "approved")
        self.assertEqual(row["usage"], "reference_only")
        self.assertEqual(row["label_status"], "provisional")
        self.assertTrue(row["requires_personality_rights_review"])
        report = builder.validate_catalog([row])
        self.assertTrue(report["valid"])
        self.assertEqual(report["training_eligible"], 0)

    def test_commons_sharealike_stays_rights_review_required(self) -> None:
        row = discovery.commons_record(commons_page("CC BY-SA 4.0"), self.commons_source, "Videos of interviews")
        assert row is not None
        self.assertEqual(row["rights_status"], "review_required")

    def test_nasa_asset_urls_escape_spaces(self) -> None:
        value = discovery.escaped_url("http://example.test/video/Interview Soundbites~orig.mp4")
        self.assertEqual(value, "http://example.test/video/Interview%20Soundbites~orig.mp4")

    def test_permission_url_requires_every_scope(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-permission-") as temporary:
            ledger = Path(temporary) / "ledger.jsonl"
            builder.write_jsonl(ledger, [{
                "sample_id": "permission-test",
                "label": 0,
                "reference_url": "https://www.youtube.com/watch?v=abc123",
                "authorized_media_path": "creator-master.mp4",
                "authenticity_label": "genuine",
                "media_origin": "camera_capture",
                "transformation_types": ["none"],
                "sync_status": "synchronized",
                "group_id": "permission-test",
                "creator_id": "owner",
                "license_id": "owner-license",
                "rights_evidence": {
                    "download_permitted": True,
                    "commercial_ml_training": True,
                    "derivatives_permitted": True,
                    "trained_model_distribution_permitted": True,
                },
                "rights_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "rights-permission"},
                "label_status": "verified",
                "label_evidence": [{"type": "creator_attestation", "reference": "owner.json"}],
                "provenance_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "provenance-permission"},
                "contains_identifiable_people": False,
                "content_profile": "general_video",
                "permission_scopes": ["download_or_copy", "commercial_use", "model_training"],
            }])
            with self.assertRaises(builder.CatalogError):
                discovery.import_permission_urls(ledger)

    def test_review_promotion_requires_personality_clearance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-review-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.jsonl"
            decisions = root / "decisions.jsonl"
            row = discovery.commons_record(commons_page("CC BY 4.0"), self.commons_source, "Videos of interviews")
            assert row is not None
            builder.write_jsonl(catalog, [row])
            decision = {
                "sample_id": row["sample_id"],
                "approved": True,
                "label": 0,
                "authenticity_label": "genuine",
                "media_origin": "camera_capture",
                "transformation_types": ["none"],
                "sync_status": "synchronized",
                "contains_identifiable_people": False,
                "rights_approved": True,
                "rights_evidence": {
                    "download_permitted": True,
                    "commercial_ml_training": True,
                    "derivatives_permitted": True,
                    "trained_model_distribution_permitted": True,
                },
                "rights_review": {"reviewer": "rights-reviewer", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "rights-review" , "status": "approved"},
                "label_evidence": [{"type": "open_archive_provenance", "reference": row["source_page_url"]}],
                "provenance_review": {"reviewer": "reviewer-1", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "provenance-review"},
            }
            builder.write_jsonl(decisions, [decision])
            with self.assertRaises(builder.CatalogError):
                discovery.apply_reviews(catalog, decisions)
            decision["personality_clearance"] = True
            builder.write_jsonl(decisions, [decision])
            promoted, report = discovery.apply_reviews(catalog, decisions)
            self.assertEqual(report["promoted"], 1)
            self.assertEqual(builder.training_exclusion_reasons(promoted[0]), [])

    def test_generated_outputs_keep_parent_leakage_group(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orislop-generated-") as temporary:
            root = Path(temporary)
            parent_catalog = root / "parents.jsonl"
            generation_log = root / "generation.jsonl"
            output_video = root / "fake.mp4"
            output_video.write_bytes(b"fixture")
            parent = {
                "sample_id": "real-1",
                "label": 0,
                "authenticity_label": "genuine",
                "media_origin": "camera_capture",
                "transformation_types": ["none"],
                "sync_status": "synchronized",
                "platform": "local",
                "source_path": str(output_video),
                "acquisition_method": "local_owned_master",
                "content_profile": "general_video",
                "source_asset_id": "asset-1",
                "group_id": "asset-1",
                "creator_id": "creator-1",
                "usage": "training",
                "rights_status": "approved",
                "license_id": "owned",
                "rights_evidence": {
                    "download_permitted": True,
                    "commercial_ml_training": True,
                    "derivatives_permitted": True,
                    "trained_model_distribution_permitted": True,
                },
                "rights_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "rights-real"},
                "label_status": "verified",
                "label_evidence": [{"type": "capture_provenance", "reference": "capture.json"}],
                "provenance_review": {"reviewer": "fixture", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "provenance-real"},
                "contains_identifiable_people": False,
            }
            parent.update({
                "content_profile": "short_form_feed",
                "primary_feed_context": "instagram_reels",
                "visual_format": "vertical",
                "content_styles": ["talking_head"],
                "clip_duration_seconds": 15,
            })
            builder.write_jsonl(parent_catalog, [parent])
            builder.write_jsonl(generation_log, [{
                "sample_id": "fake-1",
                "source_sample_id": "real-1",
                "output_path": str(output_video),
                "generator_id": "generator-1",
                "generator_family_id": "generator-family-1",
                "generator_registry_id": "deepfacelab",
                "generator_license_id": "generator-commercial",
                "generator_rights_evidence": "generator-license.pdf",
                "generator_commercial_approved": True,
                "provider_terms_snapshot": "generator-terms-2026-07-15.txt",
                "generator_review": {"reviewer": "generator-reviewer", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "generator-review", "status": "approved"},
                "output_rights_review": {"reviewer": "rights-reviewer", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "output-review", "status": "approved"},
                "provenance_review": {"reviewer": "provenance-reviewer", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": "fake-provenance"},
                "checkpoint_sha256": "a" * 64,
                "authenticity_label": "manipulated",
                "media_origin": "hybrid",
                "transformation_types": ["face_swap"],
                "sync_status": "manipulated_sync",
            }])
            generated = discovery.import_generated_outputs(parent_catalog, generation_log, require_media=True)
            self.assertEqual(generated[0]["group_id"], parent["group_id"])
            self.assertEqual(generated[0]["source_asset_id"], parent["source_asset_id"])
            self.assertEqual(generated[0]["primary_feed_context"], "instagram_reels")
            self.assertEqual(generated[0]["content_styles"], ["talking_head"])
            self.assertEqual(builder.training_exclusion_reasons(generated[0]), [])

    def test_noncommercial_generator_registry_entry_is_blocked(self) -> None:
        values = discovery.generator_registry(DATASET_DIR / "generator_registry.json")
        with self.assertRaises(builder.CatalogError):
            discovery.admitted_generator(values, "wav2lip-open")


if __name__ == "__main__":
    unittest.main(verbosity=2)
