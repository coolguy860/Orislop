#!/usr/bin/env python3
"""Discover rights-reviewable media and promote reviewed catalog decisions.

This intentionally does not search, scrape, or download from social platforms.
A separate command imports creator-supplied masters or authorized direct media
files while retaining the social post only as a reference URL.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Sequence

import build_dataset as dataset


COMMONS_API = "https://commons.wikimedia.org/w/api.php"
NASA_API = "https://images-api.nasa.gov"
USER_AGENT = "OrislopDatasetBuilder/1.0 (rights-aware research; contact via project repository)"
VIDEO_SUFFIXES = (".mp4", ".mov", ".m4v", ".webm", ".ogv", ".mpeg", ".mpg")
REQUIRED_PERMISSION_SCOPES = {
    "download_or_copy",
    "commercial_use",
    "model_training",
    "derivatives",
    "trained_model_distribution",
}
TAG_RE = re.compile(r"<[^>]+>")
LAST_REQUEST_AT = 0.0
MIN_REQUEST_INTERVAL_SECONDS = 0.35


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def registry(path: Path | None = None) -> dict[str, Any]:
    target = path or Path(__file__).with_name("source_registry.json")
    value = read_json(target)
    if int(value.get("schema_version", 0)) != 1:
        raise dataset.CatalogError("unsupported source registry schema")
    return value


def registry_source(value: dict[str, Any], source_id: str) -> dict[str, Any]:
    for source in value.get("sources", []):
        if source.get("id") == source_id:
            return source
    raise dataset.CatalogError(f"source registry has no {source_id!r} entry")


def generator_registry(path: Path | None = None) -> dict[str, Any]:
    target = path or Path(__file__).with_name("generator_registry.json")
    value = read_json(target)
    if int(value.get("schema_version", 0)) != 1 or not isinstance(value.get("generators"), list):
        raise dataset.CatalogError("unsupported generator registry schema")
    return value


def admitted_generator(value: dict[str, Any], registry_id: str) -> dict[str, Any]:
    entry = next((item for item in value.get("generators", []) if str(item.get("id")) == registry_id), None)
    if not isinstance(entry, dict):
        raise dataset.CatalogError(f"generator registry has no {registry_id!r} entry")
    status = str(entry.get("status") or "").strip().lower()
    allowed = status == "approved" or status == "contract_required" or status.startswith("conditional_")
    if not allowed:
        raise dataset.CatalogError(f"generator registry blocks {registry_id!r} with status {status or 'missing'}")
    return entry


def clean_metadata(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value", "")
    return " ".join(html.unescape(TAG_RE.sub(" ", str(value or ""))).split())


def slug(value: str, *, fallback: str) -> str:
    result = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._").lower()
    return (result[:90] or fallback).strip("-._")


def stable_creator(value: str, prefix: str) -> str:
    cleaned = clean_metadata(value)
    if not cleaned:
        return f"{prefix}-unknown"
    digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def fetch_json(url: str, *, timeout: int = 45, retries: int = 6) -> dict[str, Any]:
    global LAST_REQUEST_AT
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last: Exception | None = None
    for attempt in range(retries):
        remaining = MIN_REQUEST_INTERVAL_SECONDS - (time.monotonic() - LAST_REQUEST_AT)
        if remaining > 0:
            time.sleep(remaining)
        try:
            LAST_REQUEST_AT = time.monotonic()
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = error
            if attempt + 1 < retries:
                retry_after = 0.0
                if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                    try:
                        retry_after = float(error.headers.get("Retry-After") or 0)
                    except (TypeError, ValueError):
                        retry_after = 0.0
                time.sleep(max(retry_after, min(60.0, 2.0 * (2**attempt))))
    raise RuntimeError(f"request failed after {retries} attempts: {url}: {last}")


def escaped_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    path = urllib.parse.quote(urllib.parse.unquote(parsed.path), safe="/%:@!$&'()*+,;=-._~")
    query = urllib.parse.quote(urllib.parse.unquote(parsed.query), safe="=&;%:@/?+,$-_.!~*'()")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, query, parsed.fragment))


def remote_size(url: str, timeout: int = 25) -> int:
    request = urllib.request.Request(escaped_url(url), method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.headers.get("Content-Length") or 0)
    except (urllib.error.URLError, ValueError, TimeoutError):
        return 0


def metadata_value(metadata: dict[str, Any], name: str) -> str:
    return clean_metadata(metadata.get(name))


def commons_allowed_licenses(source: dict[str, Any]) -> set[str]:
    return {str(item).strip().lower() for item in source.get("approved_license_ids", [])}


def commons_query(category: str, continuation: dict[str, Any] | None, limit: int) -> dict[str, Any]:
    params: dict[str, Any] = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "categorymembers",
        "gcmtitle": category if category.lower().startswith("category:") else f"Category:{category}",
        "gcmtype": "file",
        "gcmlimit": min(50, max(1, limit)),
        "prop": "imageinfo",
        "iiprop": "url|size|mime|mediatype|sha1|extmetadata",
        "iiextmetadatalanguage": "en",
    }
    if continuation:
        params.update(continuation)
    return fetch_json(f"{COMMONS_API}?{urllib.parse.urlencode(params)}")


def commons_subcategories(category: str, max_categories: int) -> list[str]:
    title = category if category.lower().startswith("category:") else f"Category:{category}"
    continuation: dict[str, Any] | None = None
    results: list[str] = []
    while len(results) < max_categories:
        params: dict[str, Any] = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "list": "categorymembers",
            "cmtitle": title,
            "cmtype": "subcat",
            "cmlimit": min(500, max_categories - len(results)),
        }
        if continuation:
            params.update(continuation)
        response = fetch_json(f"{COMMONS_API}?{urllib.parse.urlencode(params)}")
        results.extend(str(item.get("title")) for item in response.get("query", {}).get("categorymembers", []) if item.get("title"))
        continuation = response.get("continue")
        if not continuation:
            break
        time.sleep(0.1)
    return results[:max_categories]


def commons_record(page: dict[str, Any], source: dict[str, Any], category: str) -> dict[str, Any] | None:
    infos = page.get("imageinfo") or []
    if not infos:
        return None
    info = infos[0]
    url = str(info.get("url") or "")
    mime = str(info.get("mime") or "").lower()
    mediatype = str(info.get("mediatype") or "").upper()
    if not url or not (mime.startswith("video/") or mediatype == "VIDEO" or url.lower().endswith(VIDEO_SUFFIXES)):
        return None
    metadata = info.get("extmetadata") or {}
    license_name = metadata_value(metadata, "LicenseShortName") or metadata_value(metadata, "UsageTerms")
    license_url = metadata_value(metadata, "LicenseUrl")
    page_id = str(page.get("pageid") or hashlib.sha256(url.encode("utf-8")).hexdigest()[:16])
    title = str(page.get("title") or f"File:{page_id}")
    page_url = f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'), safe=':()_-')}"
    license_allowed = license_name.lower() in commons_allowed_licenses(source)
    author = metadata_value(metadata, "Artist") or metadata_value(metadata, "Credit")
    return {
        "sample_id": f"commons-{slug(page_id, fallback='asset')}",
        "label": 0,
        "platform": "open_dataset",
        "source_dataset": "wikimedia_commons",
        "source_url": url,
        "source_page_url": page_url,
        "source_title": metadata_value(metadata, "ObjectName") or title.removeprefix("File:"),
        "source_asset_id": f"commons:{page_id}",
        "group_id": f"commons:{page_id}",
        "creator_id": stable_creator(author, "commons-creator"),
        "usage": "reference_only",
        "rights_status": "approved" if license_allowed else "review_required",
        "license_id": license_name or "wikimedia-license-missing",
        "license_url": license_url,
        "rights_evidence": page_url,
        "attribution": metadata_value(metadata, "Attribution") or author,
        "label_status": "provisional",
        "label_evidence": [{"type": "dataset_ground_truth", "reference": page_url}],
        "estimated_bytes": int(info.get("size") or 0),
        "content_sha1": str(info.get("sha1") or ""),
        "discovery_category": category,
        "requires_human_authenticity_review": True,
        "requires_personality_rights_review": True,
        "notes": "Discovery candidate only. Copyright permission does not establish authenticity, consent, or publicity clearance.",
    }


def discover_commons(
    categories: Sequence[str],
    limit: int,
    source_registry: dict[str, Any],
    *,
    category_depth: int = 2,
    max_categories_per_root: int = 200,
) -> list[dict[str, Any]]:
    source = registry_source(source_registry, "wikimedia_commons")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root_category in categories:
        queue: list[tuple[str, int]] = [(root_category, 0)]
        visited: set[str] = set()
        root_count = 0
        while queue and root_count < limit and len(visited) < max_categories_per_root:
            category, depth = queue.pop(0)
            canonical = category if category.lower().startswith("category:") else f"Category:{category}"
            if canonical in visited:
                continue
            visited.add(canonical)
            continuation: dict[str, Any] | None = None
            while root_count < limit:
                result = commons_query(canonical, continuation, limit - root_count)
                for page in result.get("query", {}).get("pages", []):
                    record = commons_record(page, source, canonical)
                    if record and record["sample_id"] not in seen:
                        seen.add(str(record["sample_id"]))
                        records.append(record)
                        root_count += 1
                        if root_count >= limit:
                            break
                continuation = result.get("continue")
                if not continuation:
                    break
                time.sleep(0.1)
            if depth < category_depth and root_count < limit:
                remaining_categories = max_categories_per_root - len(visited) - len(queue)
                if remaining_categories > 0:
                    queue.extend((name, depth + 1) for name in commons_subcategories(canonical, remaining_categories))
            if root_count >= limit:
                break
    return records


def nasa_asset_url(nasa_id: str) -> tuple[str, int]:
    result = fetch_json(f"{NASA_API}/asset/{urllib.parse.quote(nasa_id)}")
    urls = [str(item.get("href") or "") for item in result.get("collection", {}).get("items", [])]
    candidates = [url for url in urls if url.lower().split("?", 1)[0].endswith(VIDEO_SUFFIXES)]
    candidates.sort(key=lambda value: (not value.lower().split("?", 1)[0].endswith(".mp4"), len(value)))
    if not candidates:
        return "", 0
    selected = escaped_url(candidates[0])
    parsed = urllib.parse.urlsplit(selected)
    if parsed.scheme == "http" and (parsed.hostname or "").lower() == "images-assets.nasa.gov":
        selected = urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    return selected, remote_size(selected)


def discover_nasa(query: str, limit: int, max_pages: int) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(1, max_pages + 1):
        params = urllib.parse.urlencode({"q": query, "media_type": "video", "page": page, "page_size": 100})
        result = fetch_json(f"{NASA_API}/search?{params}")
        items = result.get("collection", {}).get("items", [])
        if not items:
            break
        for item in items:
            data_rows = item.get("data") or []
            if not data_rows:
                continue
            metadata = data_rows[0]
            nasa_id = str(metadata.get("nasa_id") or "").strip()
            if not nasa_id or nasa_id in seen:
                continue
            source_url, size = nasa_asset_url(nasa_id)
            if not source_url:
                continue
            seen.add(nasa_id)
            page_url = str(item.get("href") or f"https://images.nasa.gov/details/{nasa_id}")
            records.append({
                "sample_id": f"nasa-{slug(nasa_id, fallback='asset')}",
                "label": 0,
                "platform": "open_dataset",
                "source_dataset": "nasa_image_video_library",
                "source_url": source_url,
                "source_page_url": page_url,
                "source_title": str(metadata.get("title") or nasa_id),
                "source_asset_id": f"nasa:{nasa_id}",
                "group_id": f"nasa:{nasa_id}",
                "creator_id": "nasa",
                "usage": "reference_only",
                "rights_status": "review_required",
                "license_id": "US-GOV-NASA-media-guidelines",
                "license_url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
                "rights_evidence": page_url,
                "attribution": "NASA",
                "label_status": "provisional",
                "label_evidence": [{"type": "trusted_publisher", "reference": page_url}],
                "estimated_bytes": size,
                "keywords": metadata.get("keywords") or [],
                "requires_human_authenticity_review": True,
                "requires_personality_rights_review": True,
                "notes": "NASA candidate only; check third-party credits, logos, endorsement, and identifiable-person publicity rights.",
            })
            if len(records) >= limit:
                return records
        time.sleep(0.1)
    return records


def permission_scopes(row: dict[str, Any]) -> set[str]:
    value = row.get("permission_scopes") or []
    return {str(item).strip().lower() for item in value if str(item).strip()} if isinstance(value, list) else set()


def import_permission_urls(path: Path) -> list[dict[str, Any]]:
    rows = dataset.read_jsonl(path)
    output: list[dict[str, Any]] = []
    for original in rows:
        row = dataset.clean_record(original)
        reference_url = str(row.get("reference_url") or row.get("source_platform_url") or "").strip()
        reference_host = (urllib.parse.urlsplit(reference_url).hostname or "").lower()
        if reference_host.startswith("www."):
            reference_host = reference_host[4:]
        if reference_host not in {"youtube.com", "m.youtube.com", "youtu.be", "tiktok.com", "instagram.com"}:
            raise dataset.CatalogError(f"{row.get('sample_id')}: a supported social reference_url is required")
        missing = REQUIRED_PERMISSION_SCOPES - permission_scopes(row)
        if missing:
            raise dataset.CatalogError(f"{row.get('sample_id')}: permission ledger is missing {sorted(missing)}")
        if not isinstance(row.get("rights_evidence"), dict) or not row.get("license_id"):
            raise dataset.CatalogError(f"{row.get('sample_id')}: rights_evidence and license_id are required")
        local_master = str(row.pop("authorized_media_path", row.get("source_path") or row.get("media_path") or "")).strip()
        direct_url = str(row.pop("authorized_download_url", "")).strip()
        if bool(local_master) == bool(direct_url):
            raise dataset.CatalogError(f"{row.get('sample_id')}: provide exactly one authorized_media_path or authorized_download_url")
        row.pop("source_platform_url", None)
        row.pop("media_path", None)
        row.pop("source_url", None)
        row["reference_url"] = reference_url
        if local_master:
            row["source_path"] = local_master
            row["acquisition_method"] = "local_owned_master"
        else:
            if dataset.is_social_media_url(direct_url):
                raise dataset.CatalogError(f"{row.get('sample_id')}: authorized_download_url cannot point to a social platform")
            row["source_url"] = direct_url
            row["acquisition_method"] = "rights_holder_direct_download"
        row.setdefault("platform", "youtube" if "youtu" in reference_host else "tiktok" if "tiktok" in reference_host else "instagram")
        row["usage"] = "training"
        row["rights_status"] = "approved"
        output.append(row)
    report = dataset.validate_catalog(output, catalog_path=path)
    dataset.require_valid(report)
    return output


def import_generated_outputs(
    source_catalog_path: Path,
    generation_log_path: Path,
    require_media: bool,
    generator_registry_path: Path | None = None,
) -> list[dict[str, Any]]:
    source_rows = [dataset.clean_record(row) for row in dataset.read_jsonl(source_catalog_path)]
    source_report = dataset.validate_catalog(source_rows, catalog_path=source_catalog_path, require_media=require_media)
    dataset.require_valid(source_report)
    sources = {str(row.get("sample_id")): row for row in source_rows}
    generators = generator_registry(generator_registry_path)
    output: list[dict[str, Any]] = []
    for original in dataset.read_jsonl(generation_log_path):
        entry = dataset.clean_record(original)
        sample_id = str(entry.get("sample_id") or "").strip()
        parent_id = str(entry.get("source_sample_id") or "").strip()
        authenticity = str(entry.get("authenticity_label") or "manipulated").strip().lower()
        parent = sources.get(parent_id) if parent_id else None
        if not sample_id:
            raise dataset.CatalogError("generation row requires sample_id")
        if parent_id and parent is None:
            raise dataset.CatalogError(f"{sample_id}: unknown source_sample_id {parent_id}")
        if parent is None and authenticity != "fully_synthetic":
            raise dataset.CatalogError(f"{sample_id}: manipulated outputs require a known source_sample_id")
        if parent is not None:
            parent_exclusions = dataset.training_exclusion_reasons(parent)
            if parent_exclusions:
                raise dataset.CatalogError(f"{sample_id}: parent {parent_id} is not training eligible: {parent_exclusions}")
        generator_id = str(entry.get("generator_id") or "").strip()
        generator_family_id = str(entry.get("generator_family_id") or "").strip()
        generator_registry_id = str(entry.get("generator_registry_id") or generator_id).strip()
        generator_license = str(entry.get("generator_license_id") or "").strip()
        generator_evidence = str(entry.get("generator_rights_evidence") or "").strip()
        terms_snapshot = str(entry.get("provider_terms_snapshot") or "").strip()
        if not generator_id or not generator_family_id or not generator_license or not generator_evidence or not terms_snapshot:
            raise dataset.CatalogError(
                f"{sample_id}: generator_id, generator_family_id, generator_license_id, "
                "generator_rights_evidence, and provider_terms_snapshot are required"
            )
        registry_entry = admitted_generator(generators, generator_registry_id)
        if not bool(entry.get("generator_commercial_approved")):
            raise dataset.CatalogError(f"{sample_id}: generator_commercial_approved must be true")
        generator_review = entry.get("generator_review")
        if not dataset.review_is_complete(generator_review) or str(generator_review.get("status", "")).lower() != "approved":
            raise dataset.CatalogError(f"{sample_id}: generator_review must be complete and approved")
        output_rights_review = entry.get("output_rights_review")
        if not dataset.review_is_complete(output_rights_review) or str(output_rights_review.get("status", "")).lower() != "approved":
            raise dataset.CatalogError(f"{sample_id}: output_rights_review must be complete and approved")
        provenance_review = entry.get("provenance_review")
        if not dataset.review_is_complete(provenance_review):
            raise dataset.CatalogError(f"{sample_id}: provenance_review is required")
        checkpoint_hash = str(entry.get("checkpoint_sha256") or "").strip()
        service_version = str(entry.get("service_model_version") or "").strip()
        request_id = str(entry.get("request_id") or "").strip()
        if not checkpoint_hash and not (service_version and request_id):
            raise dataset.CatalogError(f"{sample_id}: provide checkpoint_sha256 or both service_model_version and request_id")
        if checkpoint_hash and not re.fullmatch(r"[0-9a-fA-F]{64}", checkpoint_hash):
            raise dataset.CatalogError(f"{sample_id}: checkpoint_sha256 must be a 64-character hexadecimal digest")
        output_value = str(entry.get("output_path") or entry.get("source_path") or "").strip()
        if not output_value:
            raise dataset.CatalogError(f"{sample_id}: output_path is required")
        output_path = Path(output_value)
        if not output_path.is_absolute():
            output_path = (generation_log_path.parent / output_path).resolve()
        if require_media and not output_path.is_file():
            raise FileNotFoundError(output_path)
        parent_rights = parent.get("rights_evidence") if parent is not None else entry.get("input_rights_evidence")
        if not isinstance(parent_rights, dict) or parent_rights.get("derivatives_permitted") is not True:
            raise dataset.CatalogError(f"{sample_id}: input/source rights do not explicitly permit derivatives")
        applied_transformations = entry.get("transformation_types") or entry.get("transformation_type") or []
        if isinstance(applied_transformations, str):
            applied_transformations = [applied_transformations]
        row = {
            "sample_id": sample_id,
            "label": 1,
            "authenticity_label": authenticity,
            "media_origin": str(entry.get("media_origin") or ("ai_generated" if authenticity == "fully_synthetic" else "hybrid")),
            "transformation_types": applied_transformations,
            "sync_status": str(entry.get("sync_status") or "not_applicable"),
            "platform": "generated",
            "source_path": str(output_path),
            "acquisition_method": "controlled_generation",
            "source_asset_id": str(parent.get("source_asset_id") or parent.get("group_id") or parent_id) if parent is not None else "",
            "group_id": str(parent.get("group_id") or parent.get("source_asset_id") or parent_id) if parent is not None else str(entry.get("group_id") or f"synthetic:{sample_id}"),
            "creator_id": str(parent.get("creator_id") or "unknown-creator") if parent is not None else str(entry.get("creator_id") or f"generator:{generator_family_id}"),
            "subject_id": parent.get("subject_id", "") if parent is not None else entry.get("subject_id", ""),
            "voice_id": parent.get("voice_id", "") if parent is not None else entry.get("voice_id", ""),
            "scene_id": parent.get("scene_id", "") if parent is not None else entry.get("scene_id", ""),
            "parent_sample_id": parent_id,
            "generator_id": generator_id,
            "generator_family_id": generator_family_id,
            "generator_registry_id": generator_registry_id,
            "generator_registry_status": str(registry_entry.get("status") or ""),
            "generator_license_id": generator_license,
            "usage": "training",
            "rights_status": "approved",
            "license_id": f"{parent.get('license_id')} + {generator_license}" if parent is not None else generator_license,
            "rights_evidence": {
                "download_permitted": True,
                "commercial_ml_training": True,
                "derivatives_permitted": True,
                "trained_model_distribution_permitted": True,
                "license_or_contract_id": f"{parent.get('license_id')} + {generator_license}" if parent is not None else generator_license,
                "source_rights_evidence": parent_rights,
                "generator_rights_evidence": generator_evidence,
                "provider_terms_snapshot": terms_snapshot,
            },
            "rights_review": output_rights_review,
            "label_status": "verified",
            "label_evidence": [{
                "type": "generation_log",
                "reference": f"{generation_log_path.resolve()}#{sample_id}",
            }],
            "provenance_review": provenance_review,
            "contains_identifiable_people": bool(parent.get("contains_identifiable_people")) if parent is not None else bool(entry.get("contains_identifiable_people")),
            "performer_consent": parent.get("performer_consent") if parent is not None else entry.get("performer_consent"),
            "content_profile": parent.get("content_profile", "general_video") if parent is not None else entry.get("content_profile", "general_video"),
            "primary_feed_context": parent.get("primary_feed_context", "") if parent is not None else entry.get("primary_feed_context", ""),
            "visual_format": parent.get("visual_format", "") if parent is not None else entry.get("visual_format", ""),
            "content_styles": parent.get("content_styles", []) if parent is not None else entry.get("content_styles", []),
            "clip_duration_seconds": parent.get("clip_duration_seconds", "") if parent is not None else entry.get("clip_duration_seconds", ""),
            "generation_parameters": entry.get("generation_parameters") or {},
            "generator_artifact": {
                "checkpoint_sha256": checkpoint_hash,
                "service_model_version": service_version,
                "request_id": request_id,
            },
            "generator_review": generator_review,
            "language": parent.get("language", "") if parent is not None else entry.get("language", ""),
            "category": parent.get("category", "") if parent is not None else entry.get("category", ""),
        }
        output.append(row)
    report = dataset.validate_catalog(output, catalog_path=generation_log_path, require_media=require_media)
    dataset.require_valid(report)
    return output


def apply_reviews(catalog_path: Path, decision_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows = dataset.read_jsonl(catalog_path)
    decisions = {str(row.get("sample_id")): row for row in dataset.read_jsonl(decision_path)}
    unknown = sorted(set(decisions) - {str(row.get("sample_id")) for row in rows})
    if unknown:
        raise dataset.CatalogError(f"review decisions contain unknown sample IDs: {unknown[:8]}")
    promoted = rejected = pending = 0
    output: list[dict[str, Any]] = []
    for original in rows:
        row = dataset.clean_record(original)
        decision = decisions.get(str(row.get("sample_id")))
        if not decision:
            pending += 1
            output.append(row)
            continue
        provenance_review = decision.get("provenance_review")
        if not dataset.review_is_complete(provenance_review):
            raise dataset.CatalogError(f"{row.get('sample_id')}: complete provenance_review is required")
        reviewer = str(provenance_review["reviewer"])
        reviewed_at = str(provenance_review["reviewed_at"])
        if not bool(decision.get("approved")):
            row["usage"] = "reference_only"
            row["label_status"] = "provisional"
            row["review_rejection"] = str(decision.get("notes") or "rejected by reviewer")
            rejected += 1
            output.append(row)
            continue
        if bool(row.get("requires_personality_rights_review")) and not bool(decision.get("personality_clearance")):
            raise dataset.CatalogError(f"{row.get('sample_id')}: personality_clearance is required")
        if not bool(decision.get("rights_approved")):
            raise dataset.CatalogError(f"{row.get('sample_id')}: explicit rights_approved decision is required")
        rights_review = decision.get("rights_review")
        if not dataset.review_is_complete(rights_review) or str(rights_review.get("status", "")).lower() != "approved":
            raise dataset.CatalogError(f"{row.get('sample_id')}: complete approved rights_review is required")
        rights_evidence = decision.get("rights_evidence")
        if not isinstance(rights_evidence, dict):
            raise dataset.CatalogError(f"{row.get('sample_id')}: structured rights_evidence is required")
        missing_scopes = dataset.REQUIRED_TRAINING_RIGHTS - dataset.approved_rights_scopes({"rights_evidence": rights_evidence})
        if missing_scopes:
            raise dataset.CatalogError(f"{row.get('sample_id')}: rights_evidence is missing {sorted(missing_scopes)}")
        row["rights_status"] = "approved"
        row["license_id"] = str(decision.get("license_id") or row.get("license_id") or "")
        row["rights_evidence"] = rights_evidence
        row["rights_review"] = rights_review
        row["label"] = int(decision.get("label", row.get("label", 0)))
        if row["label"] == 1:
            row["generator_id"] = str(decision.get("generator_id") or row.get("generator_id") or "")
            row["generator_family_id"] = str(decision.get("generator_family_id") or row.get("generator_family_id") or "")
        label_evidence = decision.get("label_evidence")
        if not isinstance(label_evidence, list) or not label_evidence:
            raise dataset.CatalogError(f"{row.get('sample_id')}: verified label_evidence is required; human visual judgment alone is not ground truth")
        row["usage"] = "safety_eval_only" if decision.get("evaluation_role") == "safety_genuine" else "training"
        row["evaluation_role"] = str(decision.get("evaluation_role") or row.get("evaluation_role") or "")
        row["label_status"] = "verified"
        row["label_evidence"] = label_evidence
        row["provenance_review"] = provenance_review
        row["authenticity_label"] = str(decision.get("authenticity_label") or ("genuine" if row["label"] == 0 else "manipulated"))
        row["media_origin"] = str(decision.get("media_origin") or "camera_capture")
        row["transformation_types"] = decision.get("transformation_types") or ["none"]
        row["sync_status"] = str(decision.get("sync_status") or "synchronized")
        if not isinstance(decision.get("contains_identifiable_people"), bool):
            raise dataset.CatalogError(f"{row.get('sample_id')}: contains_identifiable_people must be reviewed explicitly")
        row["contains_identifiable_people"] = bool(decision["contains_identifiable_people"])
        row["performer_consent"] = decision.get("performer_consent")
        row["acquisition_method"] = str(decision.get("acquisition_method") or "official_open_media_api")
        row["content_profile"] = str(decision.get("content_profile") or "general_video")
        row["primary_feed_context"] = str(decision.get("primary_feed_context") or "")
        row["visual_format"] = str(decision.get("visual_format") or "")
        row["content_styles"] = decision.get("content_styles") or []
        row["clip_duration_seconds"] = decision.get("clip_duration_seconds", "")
        row["review"] = {"reviewer": reviewer, "reviewed_at": reviewed_at, "notes": str(decision.get("notes") or "")}
        promoted += 1
        output.append(row)
    report = dataset.validate_catalog(output, catalog_path=catalog_path)
    dataset.require_valid(report)
    return output, {"records": len(output), "promoted": promoted, "rejected": rejected, "pending": pending, "validation": report}


def write_result(path: Path, rows: Iterable[dict[str, Any]], report: dict[str, Any]) -> None:
    dataset.write_jsonl(path, rows)
    dataset.atomic_json(path.with_suffix(".report.json"), report)


def command_commons(args: argparse.Namespace) -> int:
    values = registry(Path(args.registry).resolve() if args.registry else None)
    rows = discover_commons(
        args.category,
        args.limit_per_category,
        values,
        category_depth=args.category_depth,
        max_categories_per_root=args.max_categories_per_root,
    )
    report = dataset.validate_catalog(rows)
    write_result(Path(args.output).resolve(), rows, {"source": "wikimedia_commons", "categories": args.category, **report})
    print(json.dumps({"output": str(Path(args.output).resolve()), **report}, indent=2, sort_keys=True))
    return 0


def command_nasa(args: argparse.Namespace) -> int:
    rows = discover_nasa(args.query, args.limit, args.max_pages)
    report = dataset.validate_catalog(rows)
    write_result(Path(args.output).resolve(), rows, {"source": "nasa_image_video_library", "query": args.query, **report})
    print(json.dumps({"output": str(Path(args.output).resolve()), **report}, indent=2, sort_keys=True))
    return 0


def command_permission_urls(args: argparse.Namespace) -> int:
    rows = import_permission_urls(Path(args.ledger).resolve())
    report = dataset.validate_catalog(rows)
    write_result(Path(args.output).resolve(), rows, {"source": "permission_backed_creator_media", **report})
    print(json.dumps({"output": str(Path(args.output).resolve()), **report}, indent=2, sort_keys=True))
    return 0


def command_generated(args: argparse.Namespace) -> int:
    rows = import_generated_outputs(
        Path(args.source_catalog).resolve(),
        Path(args.generation_log).resolve(),
        args.require_media,
        Path(args.generator_registry).resolve() if args.generator_registry else None,
    )
    report = dataset.validate_catalog(rows, require_media=args.require_media)
    write_result(Path(args.output).resolve(), rows, {"source": "approved_generator_outputs", **report})
    print(json.dumps({"output": str(Path(args.output).resolve()), **report}, indent=2, sort_keys=True))
    return 0


def command_apply_reviews(args: argparse.Namespace) -> int:
    rows, report = apply_reviews(Path(args.catalog).resolve(), Path(args.decisions).resolve())
    write_result(Path(args.output).resolve(), rows, report)
    print(json.dumps({"output": str(Path(args.output).resolve()), **report}, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    commons = subparsers.add_parser("wikimedia", help="discover video candidates through the official Wikimedia API")
    commons.add_argument("--category", action="append", required=True)
    commons.add_argument("--limit-per-category", type=int, default=100)
    commons.add_argument("--category-depth", type=int, default=2)
    commons.add_argument("--max-categories-per-root", type=int, default=200)
    commons.add_argument("--registry")
    commons.add_argument("--output", required=True)
    commons.set_defaults(func=command_commons)

    nasa = subparsers.add_parser("nasa", help="discover NASA video candidates through the official API")
    nasa.add_argument("--query", default="interview")
    nasa.add_argument("--limit", type=int, default=100)
    nasa.add_argument("--max-pages", type=int, default=10)
    nasa.add_argument("--output", required=True)
    nasa.set_defaults(func=command_nasa)

    permission = subparsers.add_parser("permission-urls", help="import creator masters/direct files with YouTube, TikTok, or Instagram reference URLs")
    permission.add_argument("--ledger", required=True)
    permission.add_argument("--output", required=True)
    permission.set_defaults(func=command_permission_urls)

    generated = subparsers.add_parser("generated-outputs", help="turn approved generator logs into paired synthetic catalog rows")
    generated.add_argument("--source-catalog", required=True)
    generated.add_argument("--generation-log", required=True)
    generated.add_argument("--output", required=True)
    generated.add_argument("--require-media", action="store_true")
    generated.add_argument("--generator-registry", help="reviewed generator admission registry (defaults to generator_registry.json)")
    generated.set_defaults(func=command_generated)

    reviews = subparsers.add_parser("apply-reviews", help="promote human-reviewed candidates into training eligibility")
    reviews.add_argument("--catalog", required=True)
    reviews.add_argument("--decisions", required=True)
    reviews.add_argument("--output", required=True)
    reviews.set_defaults(func=command_apply_reviews)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    dataset.inject_system_trust()
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (dataset.CatalogError, FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
