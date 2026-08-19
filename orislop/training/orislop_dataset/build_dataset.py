#!/usr/bin/env python3
"""Build leakage-safe, rights-aware datasets for Orislop's visual detectors.

The catalog is the source of truth. Platform URLs may be useful for shadow
evaluation, but a row only enters model-training splits when its label and
commercial-use rights are explicitly approved. The prepared output matches the
JSONL + NPZ contract consumed by ``temporal_deepfake_moe_hf_colab.py``.
"""

from __future__ import annotations

import argparse
import collections
import contextlib
import dataclasses
import hashlib
import json
import math
import os
import random
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence


SCHEMA_VERSION = 2
LABELS = {0: "genuine", 1: "synthetic"}
PLATFORMS = {"youtube", "tiktok", "instagram", "local", "open_dataset", "generated"}
USAGES = {"training", "safety_eval_only", "shadow_eval_only", "reference_only"}
RIGHTS_STATUSES = {"approved", "review_required", "reference_only", "rejected"}
LABEL_STATUSES = {"verified", "provisional", "unverified"}
SPLITS = ("train", "val", "test")
SPLIT_FILES = {"train": "train.jsonl", "val": "validation.jsonl", "test": "test.jsonl"}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$")

AUTHENTICITY_LABELS = {"genuine", "manipulated", "fully_synthetic"}
MEDIA_ORIGINS = {
    "camera_capture",
    "traditional_animation",
    "conventional_cgi",
    "conventional_vfx",
    "ai_generated",
    "hybrid",
}
SYNC_STATUSES = {"synchronized", "legitimate_dub", "accidental_delay", "manipulated_sync", "not_applicable"}
BENIGN_TRANSFORMATIONS = {
    "none",
    "benign_compression",
    "crop",
    "resize",
    "color_filter",
    "caption_overlay",
    "screen_recording",
    "audio_compression",
    "audio_replacement",
}
SYNTHETIC_TRANSFORMATIONS = {
    "face_swap",
    "reenactment",
    "lip_sync",
    "voice_clone",
    "temporal_ai_edit",
    "ai_style_transfer",
    "generative_composite",
    "ai_generated",
}
TRANSFORMATION_TYPES = BENIGN_TRANSFORMATIONS | SYNTHETIC_TRANSFORMATIONS
CONTENT_PROFILES = {"short_form_feed", "general_video", "negative_control"}
FEED_CONTEXTS = {"youtube_shorts", "tiktok_feed", "instagram_reels"}
VISUAL_FORMATS = {"vertical", "square", "horizontal"}
CONTENT_STYLES = {
    "talking_head",
    "podcast_clip",
    "tutorial_explainer",
    "comedy_sketch",
    "gaming_commentary",
    "reaction",
    "news_current_events",
    "lifestyle_vlog",
    "sports",
    "music_performance",
    "meme_caption",
    "animation",
    "product_demo",
    "other",
}
ACQUISITION_METHODS = {
    "local_owned_master",
    "rights_holder_direct_download",
    "official_open_media_api",
    "licensed_dataset_download",
    "controlled_generation",
}
REQUIRED_TRAINING_RIGHTS = {
    "download_permitted",
    "commercial_ml_training",
    "derivatives_permitted",
    "trained_model_distribution_permitted",
}
SOCIAL_MEDIA_HOSTS = {
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
}

TRUSTED_GENUINE_EVIDENCE = {
    "capture_provenance",
    "creator_attestation",
    "controlled_capture_record",
    "dataset_ground_truth",
    "government_archive_record",
    "open_archive_provenance",
    "benign_transformation_log",
}
TRUSTED_SYNTHETIC_EVIDENCE = {
    "creator_disclosure",
    "dataset_ground_truth",
    "generation_log",
    "independent_fact_check",
    "platform_label",
}

DEFAULT_POLICY: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "seed": 1337,
    "split_ratios": {"train": 0.70, "val": 0.15, "test": 0.15},
    "heldout_generator_ids": [],
    "heldout_generator_family_ids": [],
    "production_minimums": {
        "core_train_per_class": 3500,
        "core_val_per_class": 750,
        "core_test_per_class": 750,
        "safety_genuine_test": 10000,
        "heldout_generator_families": 2,
    },
    "short_form_minimums": {
        "core_genuine": 3500,
        "core_synthetic": 3500,
        "safety_genuine": 7000,
        "core_genuine_vertical": 3000,
        "core_synthetic_vertical": 3000,
        "safety_genuine_vertical": 6000,
        "core_per_context_per_class": 750,
        "safety_per_context": 1500,
        "distinct_content_styles": 10,
    },
}


class CatalogError(ValueError):
    """Raised when a catalog cannot safely be used."""


@dataclasses.dataclass(frozen=True)
class Issue:
    level: str
    code: str
    message: str
    sample_id: str = ""
    line: int = 0

    def to_json(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


class UnionFind:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            keep, merge = sorted((left_root, right_root))
            self.parent[merge] = keep


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def atomic_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    text = "".join(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n" for row in rows)
    atomic_write_text(path, text)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise CatalogError(f"{path}:{line_number}: invalid JSON: {error}") from error
        if not isinstance(row, dict):
            raise CatalogError(f"{path}:{line_number}: every row must be a JSON object")
        row = dict(row)
        row["_catalog_line"] = line_number
        rows.append(row)
    return rows


def clean_record(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.startswith("_")}


def canonical_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(str(value).strip())
    host = parsed.hostname.lower() if parsed.hostname else ""
    if host.startswith("www."):
        host = host[4:]
    path = urllib.parse.unquote(parsed.path).rstrip("/")
    # Tracking parameters must not create duplicate samples, but the YouTube
    # `v` parameter is the asset identity and cannot be discarded.
    query = ""
    if host in {"youtube.com", "m.youtube.com", "music.youtube.com"} and path == "/watch":
        video_id = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
        if video_id:
            query = urllib.parse.urlencode({"v": video_id})
    return urllib.parse.urlunsplit((parsed.scheme.lower(), host, path, query, ""))


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def stable_number(value: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}:{value}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64 - 1)


def evidence_types(row: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    evidence = row.get("label_evidence")
    if not isinstance(evidence, list):
        return result
    for entry in evidence:
        if isinstance(entry, dict) and str(entry.get("type", "")).strip():
            result.add(str(entry["type"]).strip().lower())
    return result


def transformations(row: dict[str, Any]) -> set[str]:
    value = row.get("transformation_types")
    if value is None:
        value = row.get("transformation_type")
    if isinstance(value, str):
        return {value.strip().lower()} if value.strip() else set()
    if isinstance(value, list):
        return {str(item).strip().lower() for item in value if str(item).strip()}
    return set()


def approved_rights_scopes(row: dict[str, Any]) -> set[str]:
    evidence = row.get("rights_evidence")
    if not isinstance(evidence, dict):
        return set()
    return {scope for scope in REQUIRED_TRAINING_RIGHTS if evidence.get(scope) is True}


def review_is_complete(value: Any) -> bool:
    return isinstance(value, dict) and all(str(value.get(field, "")).strip() for field in ("reviewer", "reviewed_at", "approval_id"))


def is_social_media_url(value: str) -> bool:
    host = (urllib.parse.urlsplit(str(value)).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return any(host == candidate or host.endswith(f".{candidate}") for candidate in SOCIAL_MEDIA_HOSTS)


def approved_data_reasons(row: dict[str, Any], allowed_usages: set[str]) -> list[str]:
    reasons: list[str] = []
    if row.get("usage") not in allowed_usages:
        reasons.append("usage_not_approved_for_dataset")
    if row.get("rights_status") != "approved":
        reasons.append("rights_not_approved")
    if row.get("label_status") != "verified":
        reasons.append("label_not_verified")
    if not row.get("group_id"):
        reasons.append("missing_group_id")
    try:
        label = int(row.get("label", -1))
    except (TypeError, ValueError):
        label = -1
    if label == 1 and not row.get("generator_id"):
        reasons.append("missing_generator_id")
    return reasons


def training_exclusion_reasons(row: dict[str, Any]) -> list[str]:
    reasons = approved_data_reasons(row, {"training"})
    return ["usage_not_training" if reason == "usage_not_approved_for_dataset" else reason for reason in reasons]


def dataset_inclusion_reasons(row: dict[str, Any]) -> list[str]:
    return approved_data_reasons(row, {"training", "safety_eval_only"})


def validate_catalog(
    rows: Sequence[dict[str, Any]],
    *,
    catalog_path: Path | None = None,
    require_media: bool = False,
) -> dict[str, Any]:
    issues: list[Issue] = []
    seen_ids: dict[str, int] = {}
    seen_sources: dict[str, str] = {}
    counts: dict[str, collections.Counter[Any]] = {
        "label": collections.Counter(),
        "platform": collections.Counter(),
        "usage": collections.Counter(),
        "rights_status": collections.Counter(),
        "label_status": collections.Counter(),
    }

    def add(level: str, code: str, message: str, row: dict[str, Any]) -> None:
        issues.append(Issue(level, code, message, str(row.get("sample_id", "")), int(row.get("_catalog_line", 0))))

    for row in rows:
        sample_id = str(row.get("sample_id", "")).strip()
        if not SAFE_ID.fullmatch(sample_id):
            add("error", "invalid_sample_id", "sample_id must be 2-128 URL/file-safe characters", row)
        elif sample_id in seen_ids:
            add("error", "duplicate_sample_id", f"sample_id duplicates line {seen_ids[sample_id]}", row)
        else:
            seen_ids[sample_id] = int(row.get("_catalog_line", 0))

        try:
            label = int(row.get("label"))
        except (TypeError, ValueError):
            label = -1
        if label not in LABELS:
            add("error", "invalid_label", "label must be 0 (genuine) or 1 (synthetic)", row)
        else:
            counts["label"][str(label)] += 1

        platform = str(row.get("platform", "")).lower()
        if platform not in PLATFORMS:
            add("error", "invalid_platform", f"platform must be one of {sorted(PLATFORMS)}", row)
        counts["platform"][platform or "missing"] += 1

        usage = str(row.get("usage", ""))
        if usage not in USAGES:
            add("error", "invalid_usage", f"usage must be one of {sorted(USAGES)}", row)
        counts["usage"][usage or "missing"] += 1

        rights_status = str(row.get("rights_status", ""))
        if rights_status not in RIGHTS_STATUSES:
            add("error", "invalid_rights_status", f"rights_status must be one of {sorted(RIGHTS_STATUSES)}", row)
        counts["rights_status"][rights_status or "missing"] += 1

        label_status = str(row.get("label_status", ""))
        if label_status not in LABEL_STATUSES:
            add("error", "invalid_label_status", f"label_status must be one of {sorted(LABEL_STATUSES)}", row)
        counts["label_status"][label_status or "missing"] += 1

        dataset_use = usage in {"training", "safety_eval_only"}
        authenticity = str(row.get("authenticity_label", "")).strip().lower()
        media_origin = str(row.get("media_origin", "")).strip().lower()
        sync_status = str(row.get("sync_status", "")).strip().lower()
        applied_transformations = transformations(row)
        if dataset_use:
            if authenticity not in AUTHENTICITY_LABELS:
                add("error", "invalid_authenticity_label", f"dataset rows require authenticity_label in {sorted(AUTHENTICITY_LABELS)}", row)
            elif label == 0 and authenticity != "genuine":
                add("error", "binary_authenticity_mismatch", "binary label 0 must have authenticity_label=genuine", row)
            elif label == 1 and authenticity not in {"manipulated", "fully_synthetic"}:
                add("error", "binary_authenticity_mismatch", "binary label 1 must be manipulated or fully_synthetic", row)
            if media_origin not in MEDIA_ORIGINS:
                add("error", "invalid_media_origin", f"dataset rows require media_origin in {sorted(MEDIA_ORIGINS)}", row)
            if sync_status not in SYNC_STATUSES:
                add("error", "invalid_sync_status", f"dataset rows require sync_status in {sorted(SYNC_STATUSES)}", row)
            if not applied_transformations:
                add("error", "missing_transformation_types", "dataset rows require transformation_types (use ['none'] when untouched)", row)
            unknown_transformations = applied_transformations - TRANSFORMATION_TYPES
            if unknown_transformations:
                add("error", "invalid_transformation_type", f"unknown transformation types: {sorted(unknown_transformations)}", row)
            if label == 0 and applied_transformations.intersection(SYNTHETIC_TRANSFORMATIONS):
                add("error", "genuine_has_synthetic_transformation", "genuine rows cannot carry synthetic transformation types", row)
            if label == 1 and not applied_transformations.intersection(SYNTHETIC_TRANSFORMATIONS):
                add("error", "synthetic_missing_transformation", "synthetic/manipulated rows require at least one synthetic transformation type", row)
            if label == 0 and sync_status == "manipulated_sync":
                add("error", "genuine_has_manipulated_sync", "genuine rows cannot have sync_status=manipulated_sync", row)
            if label == 0 and media_origin == "ai_generated":
                add("error", "genuine_ai_origin_mismatch", "genuine rows cannot have media_origin=ai_generated", row)
            if authenticity == "fully_synthetic" and media_origin not in {"ai_generated", "hybrid"}:
                add("error", "fully_synthetic_origin_mismatch", "fully_synthetic rows require media_origin=ai_generated or hybrid", row)
            if not isinstance(row.get("contains_identifiable_people"), bool):
                add("error", "missing_people_classification", "dataset rows require boolean contains_identifiable_people", row)
            if not review_is_complete(row.get("provenance_review")):
                add("error", "missing_provenance_review", "dataset rows require a complete provenance_review", row)
            acquisition_method = str(row.get("acquisition_method", "")).strip()
            if acquisition_method not in ACQUISITION_METHODS:
                add("error", "invalid_acquisition_method", f"dataset rows require acquisition_method in {sorted(ACQUISITION_METHODS)}", row)
            content_profile = str(row.get("content_profile", "")).strip().lower()
            if content_profile not in CONTENT_PROFILES:
                add("error", "invalid_content_profile", f"dataset rows require content_profile in {sorted(CONTENT_PROFILES)}", row)
            if content_profile == "short_form_feed":
                feed_context = str(row.get("primary_feed_context", "")).strip().lower()
                visual_format = str(row.get("visual_format", "")).strip().lower()
                content_styles_value = row.get("content_styles")
                content_styles = {
                    str(value).strip().lower()
                    for value in content_styles_value
                    if str(value).strip()
                } if isinstance(content_styles_value, list) else set()
                if feed_context not in FEED_CONTEXTS:
                    add("error", "invalid_feed_context", f"short-form rows require primary_feed_context in {sorted(FEED_CONTEXTS)}", row)
                if visual_format not in VISUAL_FORMATS:
                    add("error", "invalid_visual_format", f"short-form rows require visual_format in {sorted(VISUAL_FORMATS)}", row)
                if not content_styles:
                    add("error", "missing_content_styles", "short-form rows require at least one content_styles tag", row)
                unknown_styles = content_styles - CONTENT_STYLES
                if unknown_styles:
                    add("error", "invalid_content_style", f"unknown content styles: {sorted(unknown_styles)}", row)
                try:
                    clip_duration = float(row.get("clip_duration_seconds"))
                except (TypeError, ValueError):
                    clip_duration = -1
                if not 2 <= clip_duration <= 30:
                    add("error", "invalid_short_form_duration", "short-form training clips must be 2-30 seconds", row)

        if not str(row.get("group_id", "")).strip():
            add("error", "missing_group_id", "group_id is required for leakage-safe splitting", row)

        source_url = str(row.get("source_url", "")).strip()
        source_path = str(row.get("source_path", row.get("media_path", ""))).strip()
        hf_repo_id = str(row.get("hf_repo_id", "")).strip()
        hf_path = str(row.get("hf_path", "")).strip()
        if bool(hf_repo_id) != bool(hf_path):
            add("error", "incomplete_hf_source", "hf_repo_id and hf_path must be provided together", row)
        if not source_url and not source_path and not (hf_repo_id and hf_path):
            add("error", "missing_source", "source_url, source_path/media_path, or hf_repo_id+hf_path is required", row)
        if sum((bool(source_url), bool(source_path), bool(hf_repo_id and hf_path))) > 1:
            add("error", "multiple_source_mechanisms", "use exactly one acquisition source: direct URL, local path, or licensed Hub file", row)
        if source_url:
            parsed = urllib.parse.urlsplit(source_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                add("error", "invalid_source_url", "source_url must be an absolute HTTP(S) URL", row)
            if dataset_use and is_social_media_url(source_url):
                add("error", "platform_media_not_authorized_for_acquisition", "training and safety media must come from a local master, licensed dataset, or direct non-platform download; keep social URLs in reference_url", row)
            segment = f"{row.get('start_seconds', '')}:{row.get('end_seconds', '')}"
            key = f"{canonical_url(source_url)}:{segment}"
            previous = seen_sources.get(key)
            if previous and previous != sample_id:
                add("error", "duplicate_source_segment", f"same canonical source segment as {previous}", row)
            else:
                seen_sources[key] = sample_id
        if hf_repo_id and hf_path:
            segment = f"{row.get('start_seconds', '')}:{row.get('end_seconds', '')}"
            key = f"hf://datasets/{hf_repo_id}@{row.get('hf_revision', 'main')}/{hf_path}:{segment}"
            previous = seen_sources.get(key)
            if previous and previous != sample_id:
                add("error", "duplicate_source_segment", f"same Hugging Face source segment as {previous}", row)
            else:
                seen_sources[key] = sample_id

        if require_media and source_path:
            candidate = Path(source_path)
            if catalog_path is not None and not candidate.is_absolute():
                candidate = catalog_path.parent / candidate
            if not candidate.is_file():
                add("error", "missing_media", f"media file does not exist: {candidate}", row)

        evidence = evidence_types(row)
        if label_status == "verified":
            trusted = TRUSTED_SYNTHETIC_EVIDENCE if label == 1 else TRUSTED_GENUINE_EVIDENCE
            if not evidence.intersection(trusted):
                add("error", "weak_label_provenance", f"verified label needs one of {sorted(trusted)}", row)
        if "model_prediction" in evidence:
            add("warning", "model_prediction_not_ground_truth", "model output may be stored as metadata but never counts as label evidence", row)

        if label == 1 and label_status == "verified":
            if not str(row.get("generator_id", "")).strip():
                add("error", "missing_generator_id", "verified synthetic samples require generator_id", row)
            if dataset_use and not str(row.get("generator_family_id", "")).strip():
                add("error", "missing_generator_family_id", "synthetic dataset rows require generator_family_id", row)

        if rights_status == "approved":
            if not str(row.get("license_id", "")).strip():
                add("error", "missing_license_id", "approved rights require license_id", row)
            if not str(row.get("rights_evidence", "")).strip():
                add("error", "missing_rights_evidence", "approved rights require rights_evidence", row)

        if dataset_use and rights_status != "approved":
            add("error", "unsafe_training_rights", "training and safety rows must have approved rights", row)
        if dataset_use and label_status != "verified":
            add("error", "unsafe_training_label", "training and safety rows must have verified labels", row)
        if dataset_use:
            missing_rights = REQUIRED_TRAINING_RIGHTS - approved_rights_scopes(row)
            if missing_rights:
                add("error", "incomplete_training_rights", f"structured rights_evidence must explicitly approve {sorted(missing_rights)}", row)
            if not review_is_complete(row.get("rights_review")):
                add("error", "missing_rights_review", "every training and safety row requires a complete rights_review", row)
            elif str(row["rights_review"].get("status", "")).strip() and str(row["rights_review"].get("status")).lower() != "approved":
                add("error", "rights_review_not_approved", "rights_review status must be approved", row)
            if isinstance(row.get("provenance_review"), dict):
                provenance_status = str(row["provenance_review"].get("status", "")).strip().lower()
                if provenance_status and provenance_status not in {"approved", "verified"}:
                    add("error", "provenance_review_not_approved", "provenance_review status must be approved or verified", row)
            if row.get("contains_identifiable_people") is True:
                consent = row.get("performer_consent")
                required_consent = {
                    "adult_confirmed",
                    "biometric_processing",
                    "commercial_ml_training",
                    "retention",
                    "trained_model_distribution",
                }
                missing_consent = (
                    required_consent
                    if not isinstance(consent, dict)
                    else {field for field in required_consent if consent.get(field) is not True}
                )
                if not isinstance(consent, dict) or not str(consent.get("consent_id", "")).strip() or missing_consent:
                    add("error", "missing_performer_consent", f"identifiable adults require consent_id and explicit approval for {sorted(required_consent)}", row)
                elif label == 1:
                    if consent.get("synthetic_media") is not True:
                        add("error", "missing_synthetic_media_consent", "synthetic use of an identifiable performer requires explicit synthetic_media consent", row)
                    if applied_transformations.intersection({"face_swap", "reenactment", "lip_sync"}) and consent.get("face_manipulation") is not True:
                        add("error", "missing_face_manipulation_consent", "face manipulation requires explicit performer consent", row)
                    if "voice_clone" in applied_transformations and consent.get("voice_clone") is not True:
                        add("error", "missing_voice_clone_consent", "voice cloning requires explicit performer consent", row)

        evaluation_role = str(row.get("evaluation_role", "")).strip()
        if usage == "safety_eval_only":
            if label != 0 or authenticity != "genuine":
                add("error", "invalid_safety_sample", "safety_eval_only rows must be verified genuine media", row)
            if evaluation_role != "safety_genuine":
                add("error", "missing_safety_role", "safety_eval_only rows require evaluation_role=safety_genuine", row)
            if normalize_split(row.get("split_hint")) not in {"", "test"}:
                add("error", "safety_split_leak", "safety rows may only be assigned to test", row)

        split_hint = str(row.get("split_hint", "")).lower()
        if split_hint == "validation":
            split_hint = "val"
        if split_hint and split_hint not in SPLITS:
            add("error", "invalid_split_hint", f"split_hint must be one of {SPLITS}", row)

        for field in ("start_seconds", "end_seconds"):
            if row.get(field) not in (None, ""):
                try:
                    value = float(row[field])
                    if value < 0:
                        raise ValueError
                except (TypeError, ValueError):
                    add("error", "invalid_segment", f"{field} must be a non-negative number", row)
        if row.get("start_seconds") not in (None, "") and row.get("end_seconds") not in (None, ""):
            try:
                if float(row["end_seconds"]) <= float(row["start_seconds"]):
                    add("error", "invalid_segment", "end_seconds must be greater than start_seconds", row)
            except (TypeError, ValueError):
                # The field-level checks above already record the malformed
                # value. Validation must still return a complete report.
                pass

    eligible = [row for row in rows if not training_exclusion_reasons(row)]
    evaluation_eligible = [row for row in rows if row.get("usage") == "safety_eval_only" and not dataset_inclusion_reasons(row)]
    errors = [issue for issue in issues if issue.level == "error"]
    warnings = [issue for issue in issues if issue.level == "warning"]
    return {
        "schema_version": SCHEMA_VERSION,
        "catalog": str(catalog_path) if catalog_path else "",
        "records": len(rows),
        "training_eligible": len(eligible),
        "evaluation_eligible": len(evaluation_eligible),
        "reference_or_quarantined": len(rows) - len(eligible) - len(evaluation_eligible),
        "counts": {name: dict(sorted(counter.items())) for name, counter in counts.items()},
        "valid": not errors,
        "errors": [issue.to_json() for issue in errors],
        "warnings": [issue.to_json() for issue in warnings],
    }


def require_valid(report: dict[str, Any]) -> None:
    if report["valid"]:
        return
    preview = "; ".join(f"{item['code']}({item.get('sample_id') or item.get('line')}): {item['message']}" for item in report["errors"][:8])
    raise CatalogError(f"catalog validation failed with {len(report['errors'])} error(s): {preview}")


def load_policy(path: Path | None) -> dict[str, Any]:
    policy = json.loads(json.dumps(DEFAULT_POLICY))
    if path is None:
        return policy
    supplied = json.loads(path.read_text(encoding="utf-8"))
    for key, value in supplied.items():
        if isinstance(value, dict) and isinstance(policy.get(key), dict):
            policy[key].update(value)
        else:
            policy[key] = value
    ratios = policy["split_ratios"]
    if set(ratios) != set(SPLITS) or not math.isclose(sum(float(ratios[name]) for name in SPLITS), 1.0, abs_tol=1e-8):
        raise CatalogError("policy split_ratios must define train/val/test and sum to 1")
    return policy


def linkage_tokens(row: dict[str, Any]) -> list[str]:
    tokens = [f"group:{row['group_id']}"]
    for field in ("source_asset_id", "creator_id", "subject_id", "person_id", "identity_id", "voice_id", "scene_id"):
        value = str(row.get(field, "")).strip()
        if value:
            tokens.append(f"{field}:{value}")
    return tokens


def linked_components(rows: Sequence[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    ids = [str(row["sample_id"]) for row in rows]
    union = UnionFind(ids)
    owner: dict[str, str] = {}
    for row in rows:
        sample_id = str(row["sample_id"])
        for token in linkage_tokens(row):
            previous = owner.setdefault(token, sample_id)
            union.union(sample_id, previous)
    components: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in rows:
        components[union.find(str(row["sample_id"]))].append(row)
    return list(components.values())


def normalize_split(value: Any) -> str:
    result = str(value or "").strip().lower()
    return "val" if result == "validation" else result


def group_forced_split(
    group: Sequence[dict[str, Any]],
    heldout_generators: set[str],
    heldout_generator_families: set[str],
) -> str | None:
    forced: set[str] = set()
    for row in group:
        hint = normalize_split(row.get("split_hint"))
        if hint:
            forced.add(hint)
        if str(row.get("generator_id", "")) in heldout_generators:
            forced.add("test")
        if str(row.get("generator_family_id", "")) in heldout_generator_families:
            forced.add("test")
        if str(row.get("evaluation_role", "")) == "heldout_generator":
            forced.add("test")
        if row.get("usage") == "safety_eval_only" or str(row.get("evaluation_role", "")) == "safety_genuine":
            forced.add("test")
    if len(forced) > 1:
        ids = ", ".join(str(row["sample_id"]) for row in group[:5])
        raise CatalogError(f"linked group has conflicting split requirements {sorted(forced)}: {ids}")
    return next(iter(forced), None)


def group_counts(group: Sequence[dict[str, Any]]) -> collections.Counter[str]:
    counter: collections.Counter[str] = collections.Counter()
    for row in group:
        # The independent safety corpus is forced to test and must not distort
        # the 70/15/15 allocation targets for the 10,000-sample core corpus.
        if row.get("usage") != "training":
            continue
        counter[f"label:{int(row['label'])}"] += 1
        counter[f"platform:{row['platform']}:label:{int(row['label'])}"] += 1
        counter["total"] += 1
    return counter


def choose_split(
    group: Sequence[dict[str, Any]],
    current: dict[str, collections.Counter[str]],
    targets: dict[str, dict[str, float]],
    ratios: dict[str, float],
    seed: int,
) -> str:
    addition = group_counts(group)
    identity = ",".join(sorted(str(row["sample_id"]) for row in group))
    best: tuple[float, float, str] | None = None
    for split in SPLITS:
        if float(ratios[split]) <= 0:
            continue
        score = 0.0
        for key, target in targets[split].items():
            projected = current[split][key] + addition[key]
            denominator = max(1.0, target)
            score += ((projected - target) / denominator) ** 2
            if projected > target:
                score += 0.35 * ((projected - target) / denominator) ** 2
        tie = stable_number(f"{identity}:{split}", seed)
        candidate = (score, tie, split)
        if best is None or candidate < best:
            best = candidate
    if best is None:
        raise CatalogError("no split has a positive allocation ratio")
    return best[2]


def readiness_report(split_rows: dict[str, list[dict[str, Any]]], policy: dict[str, Any]) -> dict[str, Any]:
    minimums = policy.get("production_minimums", {})
    failures: list[str] = []
    counts: dict[str, Any] = {}
    for split in SPLITS:
        core_rows = [row for row in split_rows[split] if row.get("usage") == "training"]
        safety_rows = [row for row in split_rows[split] if row.get("usage") == "safety_eval_only"]
        label_counts = collections.Counter(int(row["label"]) for row in core_rows)
        counts[split] = {
            "total": len(split_rows[split]),
            "core_total": len(core_rows),
            "core_labels": {str(label): label_counts[label] for label in LABELS},
            "safety_genuine": sum(int(row["label"]) == 0 for row in safety_rows),
        }
    for label in LABELS:
        if counts["train"]["core_labels"][str(label)] < int(minimums.get("core_train_per_class", 0)):
            failures.append(f"core_train_label_{label}_below_minimum")
        if counts["val"]["core_labels"][str(label)] < int(minimums.get("core_val_per_class", 0)):
            failures.append(f"core_val_label_{label}_below_minimum")
        if counts["test"]["core_labels"][str(label)] < int(minimums.get("core_test_per_class", 0)):
            failures.append(f"core_test_label_{label}_below_minimum")
    if counts["test"]["safety_genuine"] < int(minimums.get("safety_genuine_test", 0)):
        failures.append("safety_genuine_test_below_minimum")

    configured_families = {str(value) for value in policy.get("heldout_generator_family_ids", []) if str(value)}
    required_family_count = int(minimums.get("heldout_generator_families", 0))
    if len(configured_families) < required_family_count:
        failures.append("heldout_generator_families_below_minimum")
    family_splits: dict[str, set[str]] = collections.defaultdict(set)
    for split, members in split_rows.items():
        for row in members:
            family = str(row.get("generator_family_id", "")).strip()
            if family:
                family_splits[family].add(split)
    for family in sorted(configured_families):
        if family_splits.get(family, set()) != {"test"}:
            failures.append(f"heldout_generator_family_not_test_only:{family}")

    all_rows = [row for split in SPLITS for row in split_rows[split]]
    core_rows = [row for row in all_rows if row.get("usage") == "training"]
    safety_rows = [row for row in all_rows if row.get("usage") == "safety_eval_only"]
    short_core = [row for row in core_rows if row.get("content_profile") == "short_form_feed"]
    short_safety = [row for row in safety_rows if row.get("content_profile") == "short_form_feed"]
    short_minimums = policy.get("short_form_minimums", {})
    short_counts: dict[str, Any] = {
        "core_genuine": sum(int(row["label"]) == 0 for row in short_core),
        "core_synthetic": sum(int(row["label"]) == 1 for row in short_core),
        "safety_genuine": sum(int(row["label"]) == 0 for row in short_safety),
        "core_genuine_vertical": sum(int(row["label"]) == 0 and row.get("visual_format") == "vertical" for row in short_core),
        "core_synthetic_vertical": sum(int(row["label"]) == 1 and row.get("visual_format") == "vertical" for row in short_core),
        "safety_genuine_vertical": sum(int(row["label"]) == 0 and row.get("visual_format") == "vertical" for row in short_safety),
    }
    context_counts: dict[str, dict[str, int]] = {}
    for context in sorted(FEED_CONTEXTS):
        context_counts[context] = {
            "core_genuine": sum(int(row["label"]) == 0 and row.get("primary_feed_context") == context for row in short_core),
            "core_synthetic": sum(int(row["label"]) == 1 and row.get("primary_feed_context") == context for row in short_core),
            "safety_genuine": sum(int(row["label"]) == 0 and row.get("primary_feed_context") == context for row in short_safety),
        }
    distinct_styles = {
        str(style).strip().lower()
        for row in short_core + short_safety
        for style in (row.get("content_styles") if isinstance(row.get("content_styles"), list) else [])
        if str(style).strip()
    }
    short_counts["distinct_content_styles"] = len(distinct_styles)
    for metric in (
        "core_genuine",
        "core_synthetic",
        "safety_genuine",
        "core_genuine_vertical",
        "core_synthetic_vertical",
        "safety_genuine_vertical",
        "distinct_content_styles",
    ):
        if short_counts[metric] < int(short_minimums.get(metric, 0)):
            failures.append(f"short_form_{metric}_below_minimum")
    core_context_minimum = int(short_minimums.get("core_per_context_per_class", 0))
    safety_context_minimum = int(short_minimums.get("safety_per_context", 0))
    for context, values in context_counts.items():
        for class_name in ("core_genuine", "core_synthetic"):
            if values[class_name] < core_context_minimum:
                failures.append(f"short_form_{context}_{class_name}_below_minimum")
        if values["safety_genuine"] < safety_context_minimum:
            failures.append(f"short_form_{context}_safety_genuine_below_minimum")
    return {
        "production_ready": not failures,
        "failures": failures,
        "counts": counts,
        "minimums": minimums,
        "heldout_generator_family_ids": sorted(configured_families),
        "short_form_coverage": {
            "counts": short_counts,
            "contexts": context_counts,
            "minimums": short_minimums,
            "styles": sorted(distinct_styles),
        },
    }


def split_catalog(rows: Sequence[dict[str, Any]], policy: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]], dict[str, Any]]:
    eligible = [row for row in rows if not dataset_inclusion_reasons(row)]
    reference = []
    for row in rows:
        reasons = dataset_inclusion_reasons(row)
        if reasons:
            clean = clean_record(row)
            clean["training_exclusion_reasons"] = reasons
            reference.append(clean)

    ratios = {split: float(policy["split_ratios"][split]) for split in SPLITS}
    seed = int(policy.get("seed", 1337))
    groups = linked_components(eligible)
    totals = collections.Counter()
    for row in eligible:
        totals.update(group_counts([row]))
    targets = {
        split: {key: value * ratios[split] for key, value in totals.items()}
        for split in SPLITS
    }
    assigned: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    current = {split: collections.Counter() for split in SPLITS}
    heldout = {str(value) for value in policy.get("heldout_generator_ids", [])}
    heldout_families = {str(value) for value in policy.get("heldout_generator_family_ids", [])}
    forced: list[tuple[list[dict[str, Any]], str]] = []
    free: list[list[dict[str, Any]]] = []
    for group in groups:
        destination = group_forced_split(group, heldout, heldout_families)
        if destination:
            forced.append((group, destination))
        else:
            free.append(group)

    for group, destination in forced:
        assigned[destination].extend(group)
        current[destination].update(group_counts(group))

    free.sort(key=lambda group: (-len(group), stable_number(",".join(sorted(str(row["sample_id"]) for row in group)), seed)))
    for group in free:
        destination = choose_split(group, current, targets, ratios, seed)
        assigned[destination].extend(group)
        current[destination].update(group_counts(group))

    for split in SPLITS:
        for row in assigned[split]:
            row["split"] = split
        assigned[split].sort(key=lambda row: str(row["sample_id"]))

    audit: dict[str, dict[str, str]] = {}
    for split in SPLITS:
        for row in assigned[split]:
            for token in linkage_tokens(row):
                previous = audit.setdefault(token, {"split": split, "sample_id": str(row["sample_id"])})
                if previous["split"] != split:
                    raise CatalogError(f"leakage audit failed for {token}: {previous['split']} and {split}")

    report = {
        "schema_version": SCHEMA_VERSION,
        "seed": seed,
        "split_ratios": ratios,
        "eligible_records": len(eligible),
        "reference_records": len(reference),
        "linked_groups": len(groups),
        "heldout_generator_ids": sorted(heldout),
        "heldout_generator_family_ids": sorted(heldout_families),
        "leakage_tokens_checked": len(audit),
        **readiness_report(assigned, policy),
    }
    return assigned, reference, report


def save_split_artifact(output_root: Path, splits: dict[str, list[dict[str, Any]]], reference: list[dict[str, Any]], report: dict[str, Any]) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        write_jsonl(output_root / SPLIT_FILES[split], (clean_record(row) for row in splits[split]))
    write_jsonl(output_root / "reference.jsonl", reference)
    atomic_json(output_root / "split_report.json", report)


def inject_system_trust() -> None:
    with contextlib.suppress(Exception):
        import truststore  # type: ignore

        truststore.inject_into_ssl()


def download_direct_media(url: str, destination: Path, max_bytes: int) -> None:
    if is_social_media_url(url):
        raise CatalogError("platform media URLs cannot be downloaded; obtain the creator master or an authorized direct file")
    request = urllib.request.Request(url, headers={"User-Agent": "OrislopRightsReviewedDatasetBuilder/1.0"})
    partial = destination.with_suffix(destination.suffix + ".partial")
    written = 0
    try:
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as target:
            final_url = str(response.geturl())
            if is_social_media_url(final_url):
                raise CatalogError("direct media URL redirected to a blocked social-media host")
            declared = int(response.headers.get("Content-Length") or 0)
            if declared and declared > max_bytes:
                raise RuntimeError(f"direct media exceeds max size ({declared} > {max_bytes})")
            while chunk := response.read(1024 * 1024):
                written += len(chunk)
                if written > max_bytes:
                    raise RuntimeError(f"direct media exceeds max size ({written} > {max_bytes})")
                target.write(chunk)
        os.replace(partial, destination)
    finally:
        with contextlib.suppress(FileNotFoundError):
            partial.unlink()


def acquire_catalog(
    catalog_path: Path,
    rows: Sequence[dict[str, Any]],
    output_root: Path,
    *,
    execute: bool,
    confirm_rights: bool,
    max_height: int,
    max_filesize_mb: int,
) -> dict[str, Any]:
    eligible = [row for row in rows if not dataset_inclusion_reasons(row)]
    if execute and not confirm_rights:
        raise CatalogError("--execute requires --confirm-rights")
    media_root = output_root / "media"
    acquired_rows: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    if execute:
        media_root.mkdir(parents=True, exist_ok=True)
        inject_system_trust()

    for original in eligible:
        row = clean_record(original)
        sample_id = str(row["sample_id"])
        result: dict[str, Any] = {"sample_id": sample_id, "status": "planned" if not execute else "pending"}
        try:
            if not execute:
                acquired_rows.append(row)
                results.append(result)
                continue
            source_path = str(row.get("source_path", row.get("media_path", ""))).strip()
            if source_path:
                source = Path(source_path)
                if not source.is_absolute():
                    source = catalog_path.parent / source
                if not source.is_file():
                    raise FileNotFoundError(source)
                suffix = source.suffix.lower() or ".mp4"
                destination = media_root / f"{sample_id}{suffix}"
                shutil.copy2(source, destination)
            elif row.get("hf_repo_id") and row.get("hf_path"):
                try:
                    from huggingface_hub import hf_hub_download  # type: ignore
                except ImportError as error:
                    raise RuntimeError("huggingface-hub is required for hf_repo_id/hf_path sources") from error
                downloaded = Path(hf_hub_download(
                    repo_id=str(row["hf_repo_id"]),
                    filename=str(row["hf_path"]),
                    repo_type="dataset",
                    revision=str(row.get("hf_revision") or "main"),
                    token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"),
                ))
                suffix = Path(str(row["hf_path"])).suffix.lower() or ".mp4"
                destination = media_root / f"{sample_id}{suffix}"
                shutil.copy2(downloaded, destination)
            else:
                source_url = str(row.get("source_url") or "").strip()
                if not source_url:
                    raise CatalogError("approved row has no local, licensed Hub, or direct media source")
                suffix = Path(urllib.parse.urlsplit(source_url).path).suffix.lower()
                if suffix not in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}:
                    suffix = ".mp4"
                destination = media_root / f"{sample_id}{suffix}"
                download_direct_media(source_url, destination, max_filesize_mb * 1024 * 1024)
            row["media_path"] = destination.relative_to(output_root).as_posix()
            row["content_sha256"] = sha256_file(destination)
            result.update({"status": "acquired", "media_path": row["media_path"], "bytes": destination.stat().st_size})
            acquired_rows.append(row)
        except Exception as error:  # Keep the batch going and make failures reviewable.
            result.update({"status": "error", "error": str(error)[:500]})
        results.append(result)

    output_root.mkdir(parents=True, exist_ok=True)
    if execute:
        write_jsonl(output_root / "acquired_catalog.jsonl", acquired_rows)
    report = {
        "schema_version": SCHEMA_VERSION,
        "execute": execute,
        "eligible_records": len(eligible),
        "acquired": sum(item["status"] == "acquired" for item in results),
        "failed": sum(item["status"] == "error" for item in results),
        "results": results,
    }
    atomic_json(output_root / "acquisition_report.json", report)
    return report


def frame_indices(start: int, stop: int, view: str, count: int) -> list[int]:
    available = max(1, stop - start)
    if view == "micro":
        window = min(available, count)
        first = start + max(0, (available - window) // 2)
        return [min(stop - 1, first + index) for index in range(count)]
    if count <= 1:
        return [start + available // 2]
    return [min(stop - 1, start + round(index * (available - 1) / (count - 1))) for index in range(count)]


def decode_views(
    video_path: Path,
    *,
    image_size: int,
    view_counts: dict[str, int],
    start_seconds: float | None,
    end_seconds: float | None,
) -> tuple[dict[str, Any], float]:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as error:
        raise RuntimeError("opencv-python and numpy are required for precompute") from error
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"could not open video: {video_path}")
    try:
        total_frames = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 1))
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0:
            fps = 30.0
        start = max(0, min(total_frames - 1, int((start_seconds or 0.0) * fps)))
        stop = total_frames
        if end_seconds is not None:
            stop = max(start + 1, min(total_frames, int(end_seconds * fps)))
        indices_by_view = {view: frame_indices(start, stop, view, count) for view, count in view_counts.items()}
        cache: dict[int, Any] = {}
        last_good: Any = None
        for index in sorted({item for indices in indices_by_view.values() for item in indices}):
            frame = None
            for offset in (0, -1, 1, -2, 2):
                candidate = max(start, min(stop - 1, index + offset))
                capture.set(cv2.CAP_PROP_POS_FRAMES, candidate)
                ok, value = capture.read()
                if ok and value is not None:
                    frame = value
                    break
            if frame is None:
                if last_good is None:
                    raise RuntimeError(f"failed to decode frame {index} from {video_path}")
                rgb = last_good.copy()
            else:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb = cv2.resize(rgb, (image_size, image_size), interpolation=cv2.INTER_AREA)
                rgb = np.asarray(rgb, dtype=np.uint8)
                last_good = rgb
            cache[index] = rgb
        arrays = {view: np.stack([cache[index] for index in indices], axis=0) for view, indices in indices_by_view.items()}
        return arrays, (stop - start) / fps
    finally:
        capture.release()


def atomic_npz(path: Path, arrays: dict[str, Any]) -> None:
    import numpy as np  # type: ignore

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    with temporary.open("wb") as handle:
        np.savez_compressed(handle, **arrays)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_split_catalogs(split_root: Path) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for split in SPLITS:
        path = split_root / SPLIT_FILES[split]
        if not path.is_file():
            raise FileNotFoundError(path)
        result[split] = read_jsonl(path)
    return result


def resolve_media_path(row: dict[str, Any], media_root: Path) -> Path:
    value = str(row.get("media_path", row.get("source_path", ""))).strip()
    if not value:
        raise CatalogError(f"{row.get('sample_id')}: media_path/source_path is missing")
    path = Path(value)
    return path if path.is_absolute() else media_root / path


def precompute_splits(
    split_root: Path,
    media_root: Path,
    output_root: Path,
    *,
    image_size: int,
    view_counts: dict[str, int],
) -> dict[str, Any]:
    split_rows = read_split_catalogs(split_root)
    prepared: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    results: list[dict[str, Any]] = []
    for split in SPLITS:
        for original in split_rows[split]:
            row = clean_record(original)
            sample_id = str(row["sample_id"])
            result: dict[str, Any] = {"sample_id": sample_id, "split": split, "status": "pending"}
            try:
                media_path = resolve_media_path(row, media_root)
                if not media_path.is_file():
                    raise FileNotFoundError(media_path)
                arrays, duration = decode_views(
                    media_path,
                    image_size=image_size,
                    view_counts=view_counts,
                    start_seconds=float(row["start_seconds"]) if row.get("start_seconds") not in (None, "") else None,
                    end_seconds=float(row["end_seconds"]) if row.get("end_seconds") not in (None, "") else None,
                )
                relative = Path("views") / split / f"{sample_id}.npz"
                atomic_npz(output_root / relative, arrays)
                prepared_row = {
                    **row,
                    "video_path": relative.as_posix(),
                    "label": int(row["label"]),
                    "dataset": f"orislop-cross-platform-{row['platform']}",
                    "split": split,
                    "source": "precomputed_cross_platform_v1",
                    "duration": duration,
                    "content_sha256": row.get("content_sha256") or sha256_file(media_path),
                }
                prepared[split].append(prepared_row)
                result.update({"status": "prepared", "video_path": relative.as_posix(), "duration": duration})
            except Exception as error:
                result.update({"status": "error", "error": str(error)[:500]})
            results.append(result)

    manifest_root = output_root / "manifests"
    for split in SPLITS:
        write_jsonl(manifest_root / SPLIT_FILES[split], prepared[split])
    report = {
        "schema_version": SCHEMA_VERSION,
        "image_size": image_size,
        "view_counts": view_counts,
        "prepared": sum(item["status"] == "prepared" for item in results),
        "failed": sum(item["status"] == "error" for item in results),
        "by_split": {split: len(prepared[split]) for split in SPLITS},
        "results": results,
    }
    atomic_json(output_root / "precompute_report.json", report)
    return report


def add_tar_member(archive: tarfile.TarFile, source: Path, member_name: str) -> None:
    info = archive.gettarinfo(str(source), arcname=member_name)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    with source.open("rb") as handle:
        archive.addfile(info, handle)


def pack_prepared(prepared_root: Path, output_root: Path, max_shard_bytes: int) -> dict[str, Any]:
    manifests = read_split_catalogs(prepared_root / "manifests")
    packaged: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    shards: list[dict[str, Any]] = []
    shard_root = output_root / "shards"
    shard_root.mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        current_archive: tarfile.TarFile | None = None
        current_temp: Path | None = None
        current_final: Path | None = None
        current_size = 0
        shard_index = -1

        def close_current() -> None:
            nonlocal current_archive, current_temp, current_final, current_size
            if current_archive is None or current_temp is None or current_final is None:
                return
            current_archive.close()
            os.replace(current_temp, current_final)
            shards.append({
                "path": current_final.relative_to(output_root).as_posix(),
                "bytes": current_final.stat().st_size,
                "sha256": sha256_file(current_final),
                "split": split,
            })
            current_archive = None
            current_temp = None
            current_final = None
            current_size = 0

        for original in manifests[split]:
            row = clean_record(original)
            source = prepared_root / str(row["video_path"])
            if not source.is_file():
                raise FileNotFoundError(source)
            size = source.stat().st_size
            if current_archive is None or (current_size and current_size + size > max_shard_bytes):
                close_current()
                shard_index += 1
                current_final = shard_root / f"frame_views_cross_platform_{split}_{shard_index:05d}.tar"
                current_temp = current_final.with_suffix(".tar.partial")
                current_archive = tarfile.open(current_temp, mode="w")
            assert current_archive is not None and current_final is not None
            member = str(row["video_path"])
            add_tar_member(current_archive, source, member)
            current_size += size
            packaged_row = dict(row)
            packaged_row["archive_path"] = current_final.relative_to(output_root).as_posix()
            packaged_row["member_path"] = member
            packaged_row["source"] = "precomputed_cross_platform_tar_v1"
            packaged[split].append(packaged_row)
        close_current()

    manifest_root = output_root / "manifests"
    for split in SPLITS:
        write_jsonl(manifest_root / SPLIT_FILES[split], packaged[split])
    report = {
        "schema_version": SCHEMA_VERSION,
        "max_shard_bytes": max_shard_bytes,
        "shards": shards,
        "counts": {split: len(packaged[split]) for split in SPLITS},
    }
    atomic_json(output_root / "package_report.json", report)
    return report


def command_validate(args: argparse.Namespace) -> int:
    catalog = Path(args.catalog).resolve()
    rows = read_jsonl(catalog)
    report = validate_catalog(rows, catalog_path=catalog, require_media=args.require_media)
    if args.report:
        atomic_json(Path(args.report).resolve(), report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["valid"] else 1


def command_combine(args: argparse.Namespace) -> int:
    rows: list[dict[str, Any]] = []
    inputs: list[dict[str, Any]] = []
    for value in args.catalog:
        path = Path(value).resolve()
        current = read_jsonl(path)
        normalized: list[dict[str, Any]] = []
        for original in current:
            row = clean_record(original)
            for field in ("source_path", "media_path"):
                source_value = str(row.get(field, "")).strip()
                if source_value and not Path(source_value).is_absolute():
                    row[field] = str((path.parent / source_value).resolve())
            normalized.append(row)
        rows.extend(normalized)
        inputs.append({"path": str(path), "records": len(normalized), "sha256": sha256_file(path)})
    report = validate_catalog(rows)
    require_valid(report)
    output = Path(args.output).resolve()
    write_jsonl(output, rows)
    combined_report = {"schema_version": SCHEMA_VERSION, "inputs": inputs, "output": str(output), **report}
    atomic_json(output.with_suffix(".report.json"), combined_report)
    print(json.dumps(combined_report, indent=2, sort_keys=True))
    return 0


def command_split(args: argparse.Namespace) -> int:
    catalog = Path(args.catalog).resolve()
    rows = read_jsonl(catalog)
    validation = validate_catalog(rows, catalog_path=catalog, require_media=args.require_media)
    require_valid(validation)
    policy = load_policy(Path(args.policy).resolve() if args.policy else None)
    splits, reference, report = split_catalog(rows, policy)
    report["catalog_validation"] = validation
    output_root = Path(args.output_root).resolve()
    save_split_artifact(output_root, splits, reference, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def command_acquire(args: argparse.Namespace) -> int:
    catalog = Path(args.catalog).resolve()
    rows = read_jsonl(catalog)
    validation = validate_catalog(rows, catalog_path=catalog)
    require_valid(validation)
    report = acquire_catalog(
        catalog,
        rows,
        Path(args.output_root).resolve(),
        execute=args.execute,
        confirm_rights=args.confirm_rights,
        max_height=args.max_height,
        max_filesize_mb=args.max_filesize_mb,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if not report["failed"] else 2


def command_precompute(args: argparse.Namespace) -> int:
    counts = {
        "micro": args.micro_frames,
        "mid": args.mid_frames,
        "long": args.long_frames,
        "extra_long": args.extra_long_frames,
    }
    report = precompute_splits(
        Path(args.split_root).resolve(),
        Path(args.media_root).resolve(),
        Path(args.output_root).resolve(),
        image_size=args.image_size,
        view_counts=counts,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if not report["failed"] else 2


def command_pack(args: argparse.Namespace) -> int:
    report = pack_prepared(
        Path(args.prepared_root).resolve(),
        Path(args.output_root).resolve(),
        max_shard_bytes=args.shard_size_mb * 1024 * 1024,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="orislop-dataset-") as temporary:
        root = Path(temporary)
        rows: list[dict[str, Any]] = []
        for index in range(60):
            label = index % 2
            rows.append({
                "sample_id": f"sample-{index:03d}",
                "label": label,
                "authenticity_label": "manipulated" if label else "genuine",
                "media_origin": "hybrid" if label else "camera_capture",
                "transformation_types": ["face_swap"] if label else ["none"],
                "sync_status": "manipulated_sync" if label else "synchronized",
                "platform": ("youtube", "tiktok", "instagram")[index % 3],
                "source_path": f"media/sample-{index:03d}.mp4",
                "acquisition_method": "controlled_generation" if label else "local_owned_master",
                "content_profile": "general_video",
                "source_asset_id": f"source-{index // 2:03d}",
                "group_id": f"source-{index // 2:03d}",
                "creator_id": f"creator-{index // 4:03d}",
                "generator_id": f"generator-{index % 5}" if label else "",
                "generator_family_id": f"family-{index % 5}" if label else "",
                "usage": "training",
                "rights_status": "approved",
                "license_id": "self-test-license",
                "rights_evidence": {
                    "download_permitted": True,
                    "commercial_ml_training": True,
                    "derivatives_permitted": True,
                    "trained_model_distribution_permitted": True,
                    "license_or_contract_id": "self-test-license",
                },
                "rights_review": {"reviewer": "self-test", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"rights-{index}"},
                "label_status": "verified",
                "label_evidence": [{"type": "generation_log" if label else "capture_provenance", "reference": "self-test"}],
                "provenance_review": {"reviewer": "self-test", "reviewed_at": "2026-07-15T00:00:00Z", "approval_id": f"provenance-{index}"},
                "contains_identifiable_people": False,
            })
        validation = validate_catalog(rows)
        require_valid(validation)
        first, reference, report = split_catalog(rows, load_policy(None))
        second, _, _ = split_catalog(rows, load_policy(None))
        assert not reference
        assert [[row["sample_id"] for row in first[split]] for split in SPLITS] == [[row["sample_id"] for row in second[split]] for split in SPLITS]
        seen: dict[str, str] = {}
        for split in SPLITS:
            for row in first[split]:
                creator = str(row["creator_id"])
                assert creator not in seen or seen[creator] == split
                seen[creator] = split
        save_split_artifact(root / "splits", first, reference, report)
        assert (root / "splits" / "split_report.json").is_file()
    print("Orislop cross-platform dataset builder self-test passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate provenance, labels, rights, and duplicate identities")
    validate.add_argument("--catalog", required=True)
    validate.add_argument("--report")
    validate.add_argument("--require-media", action="store_true")
    validate.set_defaults(func=command_validate)

    combine = subparsers.add_parser("combine", help="merge validated catalogs and preserve local path identities")
    combine.add_argument("--catalog", action="append", required=True)
    combine.add_argument("--output", required=True)
    combine.set_defaults(func=command_combine)

    split = subparsers.add_parser("split", help="create linked, leakage-safe train/validation/test catalogs")
    split.add_argument("--catalog", required=True)
    split.add_argument("--output-root", required=True)
    split.add_argument("--policy")
    split.add_argument("--require-media", action="store_true")
    split.set_defaults(func=command_split)

    acquire = subparsers.add_parser("acquire", help="copy/download approved training media; defaults to a dry run")
    acquire.add_argument("--catalog", required=True)
    acquire.add_argument("--output-root", required=True)
    acquire.add_argument("--execute", action="store_true")
    acquire.add_argument("--confirm-rights", action="store_true")
    acquire.add_argument("--max-height", type=int, default=720)
    acquire.add_argument("--max-filesize-mb", type=int, default=250)
    acquire.set_defaults(func=command_acquire)

    precompute = subparsers.add_parser("precompute", help="convert local videos into Temporal MoE NPZ frame views")
    precompute.add_argument("--split-root", required=True)
    precompute.add_argument("--media-root", required=True)
    precompute.add_argument("--output-root", required=True)
    precompute.add_argument("--image-size", type=int, default=224)
    precompute.add_argument("--micro-frames", type=int, default=32)
    precompute.add_argument("--mid-frames", type=int, default=16)
    precompute.add_argument("--long-frames", type=int, default=8)
    precompute.add_argument("--extra-long-frames", type=int, default=16)
    precompute.set_defaults(func=command_precompute)

    pack = subparsers.add_parser("pack", help="pack prepared NPZ views into deterministic Colab/Hugging Face tar shards")
    pack.add_argument("--prepared-root", required=True)
    pack.add_argument("--output-root", required=True)
    pack.add_argument("--shard-size-mb", type=int, default=1024)
    pack.set_defaults(func=command_pack)

    subparsers.add_parser("self-test", help="run the dependency-free catalog/split contract test").set_defaults(func=lambda _args: self_test())
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (CatalogError, FileNotFoundError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
