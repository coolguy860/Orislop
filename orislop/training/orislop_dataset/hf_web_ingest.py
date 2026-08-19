#!/usr/bin/env python3
"""Stream rights-reviewed web media into a private Hugging Face dataset.

The plan is deterministic and can be shared through the Hub, so independent
Colab runtimes can process disjoint batches without Google Drive. Each worker
downloads a bounded batch, uploads media plus its catalog and hash manifest,
verifies the remote objects, writes a completion marker last, and only then
removes the ephemeral batch.

This tool never extracts audiovisual media from YouTube, TikTok, Instagram, or
Facebook pages. Those services may supply reference metadata through their
official APIs. Media acquisition requires a local rights-holder master, a
licensed Hub file, an official open-media API URL, or an authorized direct
non-platform URL.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any, Iterable, Sequence

import build_dataset as dataset


SCHEMA_VERSION = 1
GIB = 1024**3
DEFAULT_REPO_ID = "gonnerthetooner/orislop-web-corpus"
DEFAULT_REMOTE_ROOT = "orislop-ingest"
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv", ".mpeg", ".mpg"}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def atomic_json(path: Path, value: Any) -> None:
    dataset.atomic_json(path, value)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise dataset.CatalogError(f"expected a JSON object: {path}")
    return value


def catalog_digest(rows: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted((dataset.clean_record(item) for item in rows), key=lambda item: str(item.get("sample_id"))):
        digest.update(json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def hf_token() -> str:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        raise dataset.CatalogError("set HF_TOKEN (use a write token stored as a Colab secret)")
    return token


def hf_api() -> Any:
    try:
        from huggingface_hub import HfApi  # type: ignore
    except ImportError as error:
        raise RuntimeError("huggingface-hub is required; install training/orislop_dataset/requirements.txt") from error
    return HfApi(token=hf_token())


def row_size(row: dict[str, Any], default_bytes: int) -> tuple[int, bool]:
    for field in ("estimated_bytes", "source_bytes", "filesize", "size_bytes"):
        if row.get(field) not in (None, ""):
            try:
                value = int(row[field])
            except (TypeError, ValueError) as error:
                raise dataset.CatalogError(f"{row.get('sample_id')}: {field} must be an integer") from error
            if value > 0:
                return value, False
    source = str(row.get("source_path", row.get("media_path", ""))).strip()
    if source and Path(source).is_file():
        return Path(source).stat().st_size, False
    return default_bytes, True


def quarantine_eligible(row: dict[str, Any]) -> bool:
    """Allow acquisition for review without promoting a training label."""
    source_url = str(row.get("source_url") or "").strip()
    source_path = str(row.get("source_path", row.get("media_path", ""))).strip()
    hub_source = bool(row.get("hf_repo_id") and row.get("hf_path"))
    has_source = bool(source_url or source_path or hub_source)
    return (
        row.get("rights_status") == "approved"
        and has_source
        and not (source_url and dataset.is_social_media_url(source_url))
    )


def select_rows(rows: Sequence[dict[str, Any]], mode: str) -> list[dict[str, Any]]:
    if mode == "production":
        report = dataset.validate_catalog(rows)
        dataset.require_valid(report)
        selected = [dataset.clean_record(row) for row in rows if not dataset.dataset_inclusion_reasons(row)]
    elif mode == "quarantine":
        selected = [dataset.clean_record(row) for row in rows if quarantine_eligible(row)]
    else:
        raise dataset.CatalogError(f"unsupported mode: {mode}")
    if not selected:
        raise dataset.CatalogError(f"catalog has no {mode}-eligible rows")
    ids = [str(row.get("sample_id") or "") for row in selected]
    duplicates = sorted(sample_id for sample_id, count in collections.Counter(ids).items() if not sample_id or count > 1)
    if duplicates:
        raise dataset.CatalogError(f"selected catalog has missing or duplicate sample IDs: {duplicates[:8]}")
    blocked = [str(row.get("sample_id")) for row in selected if dataset.is_social_media_url(str(row.get("source_url") or ""))]
    if blocked:
        raise dataset.CatalogError(f"social-platform media URLs are blocked: {blocked[:8]}")
    return selected


def grouped_items(rows: Sequence[dict[str, Any]], default_bytes: int) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in rows:
        identity = str(row.get("source_asset_id") or row.get("group_id") or row["sample_id"])
        groups[identity].append(row)
    items: list[dict[str, Any]] = []
    for identity, members in sorted(groups.items()):
        total = 0
        estimated = 0
        for row in members:
            size, is_estimated = row_size(row, default_bytes)
            row["estimated_bytes"] = size
            total += size
            estimated += int(is_estimated)
        items.append({"group": identity, "records": members, "bytes": total, "estimated_records": estimated})
    return items


def pack_items(items: Sequence[dict[str, Any]], max_bytes: int, max_files: int) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda value: (-int(value["bytes"]), str(value["group"]))):
        count = len(item["records"])
        if int(item["bytes"]) > max_bytes or count > max_files:
            raise dataset.CatalogError(
                f"linked group {item['group']!r} exceeds a batch limit: "
                f"{int(item['bytes']) / GIB:.2f} GiB, {count} files"
            )
        destination = next(
            (
                batch
                for batch in batches
                if int(batch["expected_bytes"]) + int(item["bytes"]) <= max_bytes
                and int(batch["sample_count"]) + count <= max_files
            ),
            None,
        )
        if destination is None:
            destination = {"groups": [], "records": [], "expected_bytes": 0, "sample_count": 0, "estimated_records": 0}
            batches.append(destination)
        destination["groups"].append(str(item["group"]))
        destination["records"].extend(item["records"])
        destination["expected_bytes"] += int(item["bytes"])
        destination["sample_count"] += count
        destination["estimated_records"] += int(item["estimated_records"])
    return batches


def assign_workers(batches: list[dict[str, Any]], workers: int) -> None:
    loads = [0] * workers
    counts = [0] * workers
    for batch in sorted(batches, key=lambda value: (-int(value["expected_bytes"]), str(value["batch_id"]))):
        worker = min(range(workers), key=lambda value: (loads[value], counts[value], value))
        batch["worker_id"] = worker
        loads[worker] += int(batch["expected_bytes"])
        counts[worker] += 1


def build_plan(
    catalogs: Sequence[Path],
    output_root: Path,
    *,
    repo_id: str,
    revision: str,
    mode: str,
    workers: int,
    max_batch_bytes: int,
    max_files: int,
    default_item_bytes: int,
    run_id: str | None,
) -> dict[str, Any]:
    if workers < 1 or max_batch_bytes < 1 or max_files < 1 or default_item_bytes < 1:
        raise dataset.CatalogError("worker and batch limits must be positive")
    if output_root.exists() and any(output_root.iterdir()):
        raise dataset.CatalogError(f"plan output must be empty: {output_root}")
    rows: list[dict[str, Any]] = []
    inputs: list[dict[str, Any]] = []
    for path in catalogs:
        members = dataset.read_jsonl(path)
        rows.extend(members)
        inputs.append({"path": str(path.resolve()), "records": len(members), "sha256": dataset.sha256_file(path)})
    selected = select_rows(rows, mode)
    digest = catalog_digest(selected)
    chosen_run_id = run_id or f"web-{digest[:12]}"
    items = grouped_items(selected, default_item_bytes)
    estimated_total = sum(int(item["bytes"]) for item in items)
    largest_group = max(int(item["bytes"]) for item in items)
    balanced_target = min(max_batch_bytes, max(largest_group, math.ceil(estimated_total / workers)))
    raw_batches = pack_items(items, balanced_target, max_files)
    output_root.mkdir(parents=True, exist_ok=True)
    batch_root = output_root / "batches"
    batch_root.mkdir()
    summaries: list[dict[str, Any]] = []
    for index, batch in enumerate(raw_batches):
        batch_id = f"batch-{index:05d}"
        records = sorted(batch.pop("records"), key=lambda row: str(row["sample_id"]))
        records_file = f"batches/{batch_id}.jsonl"
        dataset.write_jsonl(output_root / records_file, records)
        summaries.append({
            **batch,
            "batch_id": batch_id,
            "records_file": records_file,
            "catalog_sha256": catalog_digest(records),
        })
    assign_workers(summaries, workers)
    worker_assignments = {
        str(worker): {
            "batches": [batch["batch_id"] for batch in summaries if int(batch["worker_id"]) == worker],
            "expected_bytes": sum(int(batch["expected_bytes"]) for batch in summaries if int(batch["worker_id"]) == worker),
            "samples": sum(int(batch["sample_count"]) for batch in summaries if int(batch["worker_id"]) == worker),
        }
        for worker in range(workers)
    }
    plan = {
        "schema_version": SCHEMA_VERSION,
        "created_at": utc_now(),
        "run_id": chosen_run_id,
        "mode": mode,
        "repo_id": repo_id,
        "revision": revision,
        "private": True,
        "remote_root": f"{DEFAULT_REMOTE_ROOT}/{chosen_run_id}",
        "catalog_sha256": digest,
        "records": len(selected),
        "workers": workers,
        "max_batch_bytes": max_batch_bytes,
        "balanced_batch_target_bytes": balanced_target,
        "max_files_per_batch": max_files,
        "estimated_bytes": estimated_total,
        "inputs": inputs,
        "batches": summaries,
        "worker_assignments": worker_assignments,
        "safety": {
            "social_media_downloads": "blocked",
            "completion_marker_uploaded_last": True,
            "ephemeral_cleanup_requires_verified_marker": True,
        },
    }
    atomic_json(output_root / "plan.json", plan)
    return plan


def load_plan(plan_root: Path) -> dict[str, Any]:
    plan = read_json(plan_root / "plan.json")
    if int(plan.get("schema_version", 0)) != SCHEMA_VERSION:
        raise dataset.CatalogError("unsupported HF ingest plan schema")
    return plan


def ensure_repo(api: Any, repo_id: str, private: bool) -> None:
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)


def ensure_branch(api: Any, repo_id: str, revision: str, base_revision: str | None = None) -> None:
    if revision == "main":
        return
    info = api.repo_info(repo_id=repo_id, repo_type="dataset")
    if not str(getattr(info, "sha", "") or ""):
        api.upload_file(
            repo_id=repo_id,
            repo_type="dataset",
            revision="main",
            path_or_fileobj=b"# Orislop private web corpus\n",
            path_in_repo="README.md",
            commit_message="Initialize private Orislop dataset",
        )
    api.create_branch(
        repo_id=repo_id,
        repo_type="dataset",
        branch=revision,
        revision=base_revision,
        exist_ok=True,
    )


def worker_revision(plan: dict[str, Any], worker_id: int) -> str:
    return f"{plan['revision']}-worker-{worker_id}"


def publish_plan(plan_root: Path) -> Any:
    plan = load_plan(plan_root)
    api = hf_api()
    repo_id = str(plan["repo_id"])
    revision = str(plan["revision"])
    ensure_repo(api, repo_id, bool(plan.get("private", True)))
    ensure_branch(api, repo_id, revision)
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    return api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        folder_path=str(plan_root),
        path_in_repo=f"{plan['remote_root']}/plan",
        commit_message=f"Publish Orislop ingest plan {plan['run_id']}",
    )


def fetch_plan(repo_id: str, revision: str, run_id: str, output_root: Path) -> Path:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except ImportError as error:
        raise RuntimeError("huggingface-hub is required") from error
    downloaded = Path(snapshot_download(
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        token=hf_token(),
        allow_patterns=[f"{DEFAULT_REMOTE_ROOT}/{run_id}/plan/**"],
    ))
    source = downloaded / DEFAULT_REMOTE_ROOT / run_id / "plan"
    if not (source / "plan.json").is_file():
        raise FileNotFoundError(source / "plan.json")
    if output_root.exists() and any(output_root.iterdir()):
        raise dataset.CatalogError(f"fetch output must be empty: {output_root}")
    shutil.copytree(source, output_root, dirs_exist_ok=True)
    return output_root


def suffix_for_row(row: dict[str, Any]) -> str:
    value = str(row.get("source_path", row.get("media_path", row.get("hf_path", "")))).strip()
    if not value:
        value = urllib.parse.urlsplit(str(row.get("source_url") or "")).path
    suffix = Path(value).suffix.lower()
    return suffix if suffix in VIDEO_SUFFIXES else ".mp4"


def acquire_one(row: dict[str, Any], catalog_path: Path, media_root: Path, max_file_bytes: int) -> tuple[dict[str, Any], Path]:
    sample_id = str(row["sample_id"])
    destination = media_root / f"{sample_id}{suffix_for_row(row)}"
    source_path = str(row.get("source_path", row.get("media_path", ""))).strip()
    if source_path:
        source = Path(source_path)
        if not source.is_absolute():
            source = catalog_path.parent / source
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copy2(source, destination)
    elif row.get("hf_repo_id") and row.get("hf_path"):
        try:
            from huggingface_hub import hf_hub_download  # type: ignore
        except ImportError as error:
            raise RuntimeError("huggingface-hub is required") from error
        source = Path(hf_hub_download(
            repo_id=str(row["hf_repo_id"]),
            filename=str(row["hf_path"]),
            repo_type="dataset",
            revision=str(row.get("hf_revision") or "main"),
            token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"),
        ))
        shutil.copy2(source, destination)
    else:
        source_url = str(row.get("source_url") or "").strip()
        if not source_url:
            raise dataset.CatalogError(f"{sample_id}: no supported media source")
        dataset.download_direct_media(source_url, destination, max_file_bytes)
    if destination.stat().st_size > max_file_bytes:
        destination.unlink(missing_ok=True)
        raise dataset.CatalogError(f"{sample_id}: file exceeds max-file limit")
    digest = dataset.sha256_file(destination)
    expected = str(row.get("source_sha256") or row.get("content_sha256") or "").strip().lower()
    if expected and expected != digest:
        destination.unlink(missing_ok=True)
        raise dataset.CatalogError(f"{sample_id}: SHA-256 mismatch")
    result = dataset.clean_record(row)
    result["content_sha256"] = digest
    result["content_bytes"] = destination.stat().st_size
    return result, destination


def safe_remove_tree(path: Path, root: Path) -> None:
    resolved_path = path.resolve()
    resolved_root = root.resolve()
    if resolved_path == resolved_root or resolved_root not in resolved_path.parents:
        raise RuntimeError(f"refusing cleanup outside stage root: {resolved_path}")
    shutil.rmtree(resolved_path)


def remote_marker(api: Any, plan: dict[str, Any], batch_id: str) -> dict[str, Any] | None:
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
        from huggingface_hub.errors import EntryNotFoundError  # type: ignore
    except ImportError as error:
        raise RuntimeError("huggingface-hub is required") from error
    path = f"{plan['remote_root']}/worker-{batch_worker(plan, batch_id)}/{batch_id}/BATCH_COMPLETE.json"
    try:
        downloaded = hf_hub_download(
            repo_id=str(plan["repo_id"]),
            filename=path,
            repo_type="dataset",
            revision=worker_revision(plan, batch_worker(plan, batch_id)),
            token=hf_token(),
            force_download=True,
        )
    except EntryNotFoundError:
        return None
    return read_json(Path(downloaded))


def find_batch(plan: dict[str, Any], batch_id: str) -> dict[str, Any]:
    for batch in plan.get("batches", []):
        if str(batch.get("batch_id")) == batch_id:
            return batch
    raise dataset.CatalogError(f"unknown batch: {batch_id}")


def batch_worker(plan: dict[str, Any], batch_id: str) -> int:
    return int(find_batch(plan, batch_id)["worker_id"])


def verify_remote_files(api: Any, plan: dict[str, Any], commit_oid: str, expected: dict[str, int]) -> None:
    infos = api.get_paths_info(
        repo_id=str(plan["repo_id"]),
        paths=list(expected),
        repo_type="dataset",
        revision=commit_oid,
    )
    actual = {str(info.path): int(info.size) for info in infos}
    missing = sorted(set(expected) - set(actual))
    mismatched = sorted(path for path, size in expected.items() if actual.get(path) != size)
    if missing or mismatched:
        raise RuntimeError(f"HF verification failed; missing={missing[:8]} mismatched={mismatched[:8]}")


def run_batch(
    plan_root: Path,
    batch_id: str,
    stage_root: Path,
    *,
    download_threads: int,
    max_file_bytes: int,
    cleanup: bool,
) -> dict[str, Any]:
    plan = load_plan(plan_root)
    batch = find_batch(plan, batch_id)
    existing = remote_marker(hf_api(), plan, batch_id)
    if existing:
        if str(existing.get("catalog_sha256")) != str(batch["catalog_sha256"]):
            raise RuntimeError(f"remote marker for {batch_id} belongs to a different catalog")
        return {"batch_id": batch_id, "status": "already_complete", "marker": existing}
    batch_stage = stage_root / str(plan["run_id"]) / f"worker-{int(batch['worker_id'])}" / batch_id
    if batch_stage.exists():
        safe_remove_tree(batch_stage, stage_root)
    media_root = batch_stage / "media"
    media_root.mkdir(parents=True)
    catalog_path = plan_root / str(batch["records_file"])
    rows = [dataset.clean_record(row) for row in dataset.read_jsonl(catalog_path)]
    acquired: list[tuple[dict[str, Any], Path]] = []
    failures: list[dict[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, download_threads)) as executor:
        futures = {
            executor.submit(acquire_one, row, catalog_path, media_root, max_file_bytes): row
            for row in rows
        }
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            try:
                acquired.append(future.result())
            except Exception as error:
                failures.append({"sample_id": str(row.get("sample_id")), "error": str(error)[:500]})
    if failures:
        atomic_json(batch_stage / "FAILED.json", {"batch_id": batch_id, "failures": failures})
        raise RuntimeError(f"{batch_id}: acquisition failed for {len(failures)} sample(s): {failures[:3]}")
    acquired.sort(key=lambda value: str(value[0]["sample_id"]))
    remote_batch = f"{plan['remote_root']}/worker-{int(batch['worker_id'])}/{batch_id}"
    remote_rows: list[dict[str, Any]] = []
    file_manifest: list[dict[str, Any]] = []
    expected_remote_sizes: dict[str, int] = {}
    for row, local_path in acquired:
        remote_path = f"{remote_batch}/media/{local_path.name}"
        normalized = dataset.clean_record(row)
        for field in ("source_url", "source_path", "media_path"):
            normalized.pop(field, None)
        normalized["hf_repo_id"] = str(plan["repo_id"])
        normalized["hf_path"] = remote_path
        normalized["hf_revision"] = worker_revision(plan, int(batch["worker_id"]))
        remote_rows.append(normalized)
        file_manifest.append({
            "sample_id": str(row["sample_id"]),
            "path": remote_path,
            "bytes": local_path.stat().st_size,
            "sha256": str(row["content_sha256"]),
        })
        expected_remote_sizes[remote_path] = local_path.stat().st_size
    dataset.write_jsonl(batch_stage / "catalog.jsonl", remote_rows)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": plan["run_id"],
        "batch_id": batch_id,
        "worker_id": int(batch["worker_id"]),
        "catalog_sha256": str(batch["catalog_sha256"]),
        "created_at": utc_now(),
        "files": file_manifest,
    }
    atomic_json(batch_stage / "manifest.json", manifest)
    expected_remote_sizes[f"{remote_batch}/catalog.jsonl"] = (batch_stage / "catalog.jsonl").stat().st_size
    expected_remote_sizes[f"{remote_batch}/manifest.json"] = (batch_stage / "manifest.json").stat().st_size
    api = hf_api()
    ensure_repo(api, str(plan["repo_id"]), bool(plan.get("private", True)))
    batch_revision = worker_revision(plan, int(batch["worker_id"]))
    ensure_branch(api, str(plan["repo_id"]), batch_revision, base_revision=str(plan["revision"]))
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    commit = api.upload_folder(
        repo_id=str(plan["repo_id"]),
        repo_type="dataset",
        revision=batch_revision,
        folder_path=str(batch_stage),
        path_in_repo=remote_batch,
        commit_message=f"Upload Orislop {plan['run_id']} {batch_id}",
        ignore_patterns=["FAILED.json", "BATCH_COMPLETE.json"],
    )
    commit_oid = str(getattr(commit, "oid", "") or getattr(commit, "commit_id", ""))
    if not commit_oid:
        raise RuntimeError("Hugging Face upload did not return a commit ID")
    verify_remote_files(api, plan, commit_oid, expected_remote_sizes)
    marker = {
        "schema_version": SCHEMA_VERSION,
        "status": "complete",
        "run_id": plan["run_id"],
        "batch_id": batch_id,
        "worker_id": int(batch["worker_id"]),
        "catalog_sha256": str(batch["catalog_sha256"]),
        "media_commit_oid": commit_oid,
        "records": len(remote_rows),
        "bytes": sum(item["bytes"] for item in file_manifest),
        "completed_at": utc_now(),
    }
    marker_path = batch_stage / "BATCH_COMPLETE.json"
    atomic_json(marker_path, marker)
    marker_commit = api.upload_file(
        repo_id=str(plan["repo_id"]),
        repo_type="dataset",
        revision=batch_revision,
        path_or_fileobj=str(marker_path),
        path_in_repo=f"{remote_batch}/BATCH_COMPLETE.json",
        commit_message=f"Complete Orislop {plan['run_id']} {batch_id}",
    )
    confirmed = remote_marker(api, plan, batch_id)
    if not confirmed or str(confirmed.get("media_commit_oid")) != commit_oid:
        raise RuntimeError("remote completion marker could not be verified")
    if cleanup:
        safe_remove_tree(batch_stage, stage_root)
    return {
        "batch_id": batch_id,
        "status": "complete",
        "media_commit_oid": commit_oid,
        "marker_commit_oid": str(getattr(marker_commit, "oid", "") or getattr(marker_commit, "commit_id", "")),
        "records": len(remote_rows),
        "bytes": marker["bytes"],
        "cleaned": cleanup,
    }


def run_worker(
    plan_root: Path,
    worker_id: int,
    stage_root: Path,
    *,
    download_threads: int,
    max_file_bytes: int,
    cleanup: bool,
) -> dict[str, Any]:
    plan = load_plan(plan_root)
    if worker_id < 0 or worker_id >= int(plan["workers"]):
        raise dataset.CatalogError(f"worker-id must be 0..{int(plan['workers']) - 1}")
    batches = [batch for batch in plan["batches"] if int(batch["worker_id"]) == worker_id]
    results = [
        run_batch(
            plan_root,
            str(batch["batch_id"]),
            stage_root,
            download_threads=download_threads,
            max_file_bytes=max_file_bytes,
            cleanup=cleanup,
        )
        for batch in batches
    ]
    return {"run_id": plan["run_id"], "worker_id": worker_id, "batches": results}


def ingest_status(plan_root: Path) -> dict[str, Any]:
    plan = load_plan(plan_root)
    api = hf_api()
    complete: list[str] = []
    remaining: list[str] = []
    for batch in plan["batches"]:
        batch_id = str(batch["batch_id"])
        marker = remote_marker(api, plan, batch_id)
        if marker and str(marker.get("catalog_sha256")) == str(batch["catalog_sha256"]):
            complete.append(batch_id)
        else:
            remaining.append(batch_id)
    return {
        "run_id": plan["run_id"],
        "repo_id": plan["repo_id"],
        "revision": plan["revision"],
        "complete_batches": len(complete),
        "total_batches": len(plan["batches"]),
        "remaining_batches": remaining,
        "ready_to_finalize": not remaining,
    }


def finalize_ingest(plan_root: Path) -> dict[str, Any]:
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
    except ImportError as error:
        raise RuntimeError("huggingface-hub is required") from error
    plan = load_plan(plan_root)
    status = ingest_status(plan_root)
    if not status["ready_to_finalize"]:
        raise RuntimeError(
            f"cannot finalize before all batches complete: "
            f"{status['complete_batches']}/{status['total_batches']}"
        )
    api = hf_api()
    rows: list[dict[str, Any]] = []
    batch_commits: dict[str, str] = {}
    token = hf_token()
    for batch in plan["batches"]:
        batch_id = str(batch["batch_id"])
        worker = int(batch["worker_id"])
        marker = remote_marker(api, plan, batch_id)
        assert marker is not None
        media_commit = str(marker["media_commit_oid"])
        batch_commits[batch_id] = media_commit
        catalog_path = f"{plan['remote_root']}/worker-{worker}/{batch_id}/catalog.jsonl"
        downloaded = Path(hf_hub_download(
            repo_id=str(plan["repo_id"]),
            filename=catalog_path,
            repo_type="dataset",
            revision=media_commit,
            token=token,
        ))
        for original in dataset.read_jsonl(downloaded):
            row = dataset.clean_record(original)
            row["hf_revision"] = media_commit
            rows.append(row)
    if len(rows) != int(plan["records"]):
        raise RuntimeError(f"final catalog record mismatch: {len(rows)} != {plan['records']}")
    if catalog_digest(rows) == "":
        raise RuntimeError("final catalog digest could not be computed")
    validation = dataset.validate_catalog(rows)
    if str(plan["mode"]) == "production":
        dataset.require_valid(validation)
    with tempfile.TemporaryDirectory(prefix="orislop-hf-final-") as temporary:
        root = Path(temporary)
        catalog = root / "catalog.jsonl"
        report_path = root / "report.json"
        dataset.write_jsonl(catalog, rows)
        report = {
            "schema_version": SCHEMA_VERSION,
            "run_id": plan["run_id"],
            "mode": plan["mode"],
            "records": len(rows),
            "catalog_sha256": dataset.sha256_file(catalog),
            "batch_media_commits": batch_commits,
            "validation": validation,
            "finalized_at": utc_now(),
        }
        atomic_json(report_path, report)
        final_root = f"{plan['remote_root']}/final"
        commit = api.upload_folder(
            repo_id=str(plan["repo_id"]),
            repo_type="dataset",
            revision=str(plan["revision"]),
            folder_path=str(root),
            path_in_repo=final_root,
            commit_message=f"Finalize Orislop ingest {plan['run_id']}",
        )
        final_commit = str(getattr(commit, "oid", "") or getattr(commit, "commit_id", ""))
        expected = {
            f"{final_root}/catalog.jsonl": catalog.stat().st_size,
            f"{final_root}/report.json": report_path.stat().st_size,
        }
        verify_remote_files(api, plan, final_commit, expected)
        marker = {
            "schema_version": SCHEMA_VERSION,
            "status": "complete",
            "run_id": plan["run_id"],
            "catalog_sha256": report["catalog_sha256"],
            "records": len(rows),
            "final_commit_oid": final_commit,
            "completed_at": utc_now(),
        }
        marker_path = root / "DATASET_COMPLETE.json"
        atomic_json(marker_path, marker)
        marker_commit = api.upload_file(
            repo_id=str(plan["repo_id"]),
            repo_type="dataset",
            revision=str(plan["revision"]),
            path_or_fileobj=str(marker_path),
            path_in_repo=f"{final_root}/DATASET_COMPLETE.json",
            commit_message=f"Complete Orislop ingest {plan['run_id']}",
        )
    return {
        **marker,
        "marker_commit_oid": str(getattr(marker_commit, "oid", "") or getattr(marker_commit, "commit_id", "")),
        "catalog_path": f"{plan['remote_root']}/final/catalog.jsonl",
    }


def command_plan(args: argparse.Namespace) -> int:
    plan = build_plan(
        [Path(value).resolve() for value in args.catalog],
        Path(args.output_root).resolve(),
        repo_id=args.repo_id,
        revision=args.revision,
        mode=args.mode,
        workers=args.workers,
        max_batch_bytes=int(args.max_batch_gib * GIB),
        max_files=args.max_files,
        default_item_bytes=int(args.default_item_mb * 1024**2),
        run_id=args.run_id,
    )
    print(json.dumps(plan, indent=2, sort_keys=True))
    return 0


def command_publish(args: argparse.Namespace) -> int:
    result = publish_plan(Path(args.plan_root).resolve())
    print(json.dumps({"status": "published", "commit_oid": str(getattr(result, "oid", ""))}, indent=2))
    return 0


def command_fetch(args: argparse.Namespace) -> int:
    output = fetch_plan(args.repo_id, args.revision, args.run_id, Path(args.output_root).resolve())
    print(json.dumps({"status": "fetched", "output_root": str(output)}, indent=2))
    return 0


def command_worker(args: argparse.Namespace) -> int:
    result = run_worker(
        Path(args.plan_root).resolve(),
        args.worker_id,
        Path(args.stage_root).resolve(),
        download_threads=args.download_threads,
        max_file_bytes=int(args.max_file_gib * GIB),
        cleanup=not args.keep_local,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_status(args: argparse.Namespace) -> int:
    result = ingest_status(Path(args.plan_root).resolve())
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ready_to_finalize"] else 1


def command_finalize(args: argparse.Namespace) -> int:
    result = finalize_ingest(Path(args.plan_root).resolve())
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="orislop-hf-ingest-") as temporary:
        root = Path(temporary)
        catalog = root / "catalog.jsonl"
        rows = []
        for index in range(24):
            rows.append({
                "sample_id": f"hf-self-test-{index:03d}",
                "label": index % 2,
                "platform": "open_dataset",
                "source_url": f"https://media.example.test/{index}.mp4",
                "source_asset_id": f"asset-{index:03d}",
                "group_id": f"asset-{index:03d}",
                "usage": "reference_only",
                "rights_status": "approved",
                "license_id": "self-test",
                "rights_evidence": "self-test",
                "label_status": "provisional",
                "estimated_bytes": (index + 1) * 1024,
            })
        dataset.write_jsonl(catalog, rows)
        plan = build_plan(
            [catalog],
            root / "plan",
            repo_id=DEFAULT_REPO_ID,
            revision="ingest-self-test",
            mode="quarantine",
            workers=4,
            max_batch_bytes=64 * 1024,
            max_files=8,
            default_item_bytes=1024,
            run_id="self-test",
        )
        assert int(plan["records"]) == 24
        assert int(plan["workers"]) == 4
        assert all(int(batch["sample_count"]) <= 8 for batch in plan["batches"])
        assert all(int(batch["expected_bytes"]) <= 64 * 1024 for batch in plan["batches"])
        assigned = [batch_id for value in plan["worker_assignments"].values() for batch_id in value["batches"]]
        assert sorted(assigned) == sorted(batch["batch_id"] for batch in plan["batches"])
    print("Orislop HF web ingest self-test passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="create deterministic bounded batches for independent workers")
    plan.add_argument("--catalog", action="append", required=True)
    plan.add_argument("--output-root", required=True)
    plan.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    plan.add_argument("--revision", default="orislop-ingest-v1")
    plan.add_argument("--run-id")
    plan.add_argument("--mode", choices=("production", "quarantine"), default="production")
    plan.add_argument("--workers", type=int, default=4)
    plan.add_argument("--max-batch-gib", type=float, default=50.0)
    plan.add_argument("--max-files", type=int, default=80)
    plan.add_argument("--default-item-mb", type=float, default=64.0)
    plan.set_defaults(func=command_plan)

    publish = subparsers.add_parser("publish-plan", help="create a private dataset repo and upload the plan")
    publish.add_argument("--plan-root", required=True)
    publish.set_defaults(func=command_publish)

    fetch = subparsers.add_parser("fetch-plan", help="download a published plan from the private dataset repo")
    fetch.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    fetch.add_argument("--revision", default="orislop-ingest-v1")
    fetch.add_argument("--run-id", required=True)
    fetch.add_argument("--output-root", required=True)
    fetch.set_defaults(func=command_fetch)

    worker = subparsers.add_parser("run-worker", help="download, upload, verify, and clean this worker's batches")
    worker.add_argument("--plan-root", required=True)
    worker.add_argument("--worker-id", type=int, required=True)
    worker.add_argument("--stage-root", default="/content/orislop-hf-stage")
    worker.add_argument("--download-threads", type=int, default=4)
    worker.add_argument("--max-file-gib", type=float, default=8.0)
    worker.add_argument("--keep-local", action="store_true")
    worker.set_defaults(func=command_worker)

    status = subparsers.add_parser("status", help="check completion markers for every published batch")
    status.add_argument("--plan-root", required=True)
    status.set_defaults(func=command_status)

    finalize = subparsers.add_parser("finalize", help="merge batch catalogs and publish a pinned final catalog")
    finalize.add_argument("--plan-root", required=True)
    finalize.set_defaults(func=command_finalize)

    subparsers.add_parser("self-test", help="run the dependency-free planning test").set_defaults(func=lambda _args: self_test())
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    dataset.inject_system_trust()
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (dataset.CatalogError, FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
