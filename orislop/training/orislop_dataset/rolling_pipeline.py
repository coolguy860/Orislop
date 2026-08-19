#!/usr/bin/env python3
"""Run Orislop's bounded-storage, four-worker dataset/cache pipeline.

Workers acquire and preprocess disjoint catalog batches, cache the frozen
Temporal MoE experts, persist verified caches, and only then remove ephemeral
raw media. Fusion training happens once on the merged cache.
"""

from __future__ import annotations

import argparse
import collections
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Sequence

import build_dataset as dataset


SCHEMA_VERSION = 1
GIB = 1024**3
PHASES = ("acquire", "precompute", "pack", "cache", "durable")
REPO_ROOT = Path(__file__).resolve().parents[2]
COLAB_RETRAIN = REPO_ROOT / "training" / "orislop_temporal_retrain" / "colab_retrain.py"
CORE_TEMPORAL = REPO_ROOT / "core" / "temporal_detector"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise dataset.CatalogError(f"expected a JSON object: {path}")
    return value


def file_size_for_row(row: dict[str, Any], source_root: Path, default_bytes: int) -> tuple[int, bool]:
    for field in ("estimated_bytes", "source_bytes", "filesize", "size_bytes"):
        value = row.get(field)
        if value not in (None, ""):
            try:
                size = int(value)
            except (TypeError, ValueError) as error:
                raise dataset.CatalogError(f"{row.get('sample_id')}: {field} must be an integer") from error
            if size > 0:
                return size, False
    source_value = str(row.get("source_path", row.get("media_path", ""))).strip()
    if source_value:
        source = Path(source_value)
        if not source.is_absolute():
            source = source_root / source
        if source.is_file():
            return source.stat().st_size, False
    return default_bytes, True


def load_split_rows(split_root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for split in dataset.SPLITS:
        path = split_root / dataset.SPLIT_FILES[split]
        if not path.is_file():
            raise FileNotFoundError(path)
        for original in dataset.read_jsonl(path):
            row = dataset.clean_record(original)
            declared = dataset.normalize_split(row.get("split") or split)
            if declared != split:
                raise dataset.CatalogError(f"{row.get('sample_id')}: row split {declared!r} is in {path.name}")
            row["split"] = split
            rows.append(row)
    report = dataset.validate_catalog(rows)
    dataset.require_valid(report)
    excluded = [(row.get("sample_id"), dataset.dataset_inclusion_reasons(row)) for row in rows if dataset.dataset_inclusion_reasons(row)]
    if excluded:
        raise dataset.CatalogError(f"split manifests contain rows not approved for training or safety evaluation: {excluded[:5]}")
    return rows


def catalog_digest(rows: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted((dataset.clean_record(item) for item in rows), key=lambda item: str(item.get("sample_id"))):
        digest.update(json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def grouped_records(rows: Sequence[dict[str, Any]], source_root: Path, default_bytes: int) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in rows:
        identity = str(row.get("source_asset_id") or row.get("group_id") or row["sample_id"])
        groups[identity].append(row)
    items: list[dict[str, Any]] = []
    for identity, members in sorted(groups.items()):
        size = 0
        estimates = 0
        for row in members:
            item_size, estimated = file_size_for_row(row, source_root, default_bytes)
            row["estimated_bytes"] = item_size
            size += item_size
            estimates += int(estimated)
        items.append({"group": identity, "records": members, "bytes": size, "estimated_records": estimates})
    return items


def pack_groups(items: Sequence[dict[str, Any]], max_batch_bytes: int) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda value: (-int(value["bytes"]), str(value["group"]))):
        if int(item["bytes"]) > max_batch_bytes:
            raise dataset.CatalogError(
                f"linked source group {item['group']!r} is {item['bytes'] / GIB:.2f} GiB, above the batch ceiling"
            )
        destination = next(
            (batch for batch in batches if int(batch["expected_raw_bytes"]) + int(item["bytes"]) <= max_batch_bytes),
            None,
        )
        if destination is None:
            destination = {"groups": [], "records": [], "expected_raw_bytes": 0, "estimated_records": 0}
            batches.append(destination)
        destination["groups"].append(str(item["group"]))
        destination["records"].extend(item["records"])
        destination["expected_raw_bytes"] += int(item["bytes"])
        destination["estimated_records"] += int(item["estimated_records"])
    return batches


def assign_workers(batches: list[dict[str, Any]], workers: int) -> None:
    loads = [0 for _ in range(workers)]
    counts = [0 for _ in range(workers)]
    for batch in sorted(batches, key=lambda value: (-int(value["expected_raw_bytes"]), str(value["batch_id"]))):
        worker = min(range(workers), key=lambda index: (loads[index], counts[index], index))
        batch["worker_id"] = worker
        loads[worker] += int(batch["expected_raw_bytes"])
        counts[worker] += 1


def build_plan(
    split_root: Path,
    output_root: Path,
    *,
    workers: int,
    max_batch_bytes: int,
    default_item_bytes: int,
    working_set_multiplier: float,
    run_id: str | None,
) -> dict[str, Any]:
    if workers < 1:
        raise dataset.CatalogError("workers must be positive")
    if max_batch_bytes < 1 or default_item_bytes < 1:
        raise dataset.CatalogError("batch and default item sizes must be positive")
    if working_set_multiplier < 1.0:
        raise dataset.CatalogError("working_set_multiplier must be at least 1")
    if output_root.exists() and any(output_root.iterdir()):
        raise dataset.CatalogError(f"plan output must be empty: {output_root}")
    rows = load_split_rows(split_root)
    digest = catalog_digest(rows)
    selected_run_id = run_id or f"orislop-{digest[:12]}"
    batches = pack_groups(grouped_records(rows, split_root, default_item_bytes), max_batch_bytes)
    output_root.mkdir(parents=True, exist_ok=True)
    batch_root = output_root / "batches"
    batch_root.mkdir()
    for index, batch in enumerate(batches):
        batch_id = f"batch-{index:05d}"
        batch["batch_id"] = batch_id
        batch["records_file"] = f"batches/{batch_id}.jsonl"
        batch["sample_count"] = len(batch.pop("records"))
    assign_workers(batches, workers)

    # Write after worker assignment, preserving the deterministic FFD batch contents.
    packed_again = pack_groups(grouped_records(rows, split_root, default_item_bytes), max_batch_bytes)
    for summary, contents in zip(batches, packed_again):
        records = sorted(contents["records"], key=lambda row: str(row["sample_id"]))
        dataset.write_jsonl(output_root / str(summary["records_file"]), records)
        summary["catalog_sha256"] = catalog_digest(records)
        summary["split_counts"] = dict(sorted(collections.Counter(str(row["split"]) for row in records).items()))
        summary["label_counts"] = dict(sorted(collections.Counter(str(int(row["label"])) for row in records).items()))
        summary["estimated_peak_working_bytes"] = int(int(summary["expected_raw_bytes"]) * working_set_multiplier)

    worker_loads = {
        str(worker): {
            "batches": [batch["batch_id"] for batch in batches if int(batch["worker_id"]) == worker],
            "expected_raw_bytes": sum(int(batch["expected_raw_bytes"]) for batch in batches if int(batch["worker_id"]) == worker),
            "samples": sum(int(batch["sample_count"]) for batch in batches if int(batch["worker_id"]) == worker),
        }
        for worker in range(workers)
    }
    plan = {
        "schema_version": SCHEMA_VERSION,
        "created_at": utc_now(),
        "run_id": selected_run_id,
        "source_split_root": str(split_root.resolve()),
        "catalog_sha256": digest,
        "records": len(rows),
        "workers": workers,
        "max_batch_bytes": max_batch_bytes,
        "max_batch_gib": max_batch_bytes / GIB,
        "working_set_multiplier": working_set_multiplier,
        "default_item_bytes": default_item_bytes,
        "estimated_raw_bytes": sum(int(batch["expected_raw_bytes"]) for batch in batches),
        "batches": batches,
        "worker_assignments": worker_loads,
        "execution_model": "parallel_acquire_precompute_and_frozen_expert_cache_then_single_merged_fusion_training",
    }
    dataset.atomic_json(output_root / "plan.json", plan)
    return plan


def load_plan(plan_root: Path) -> dict[str, Any]:
    plan = read_json(plan_root / "plan.json")
    if int(plan.get("schema_version", 0)) != SCHEMA_VERSION:
        raise dataset.CatalogError("unsupported rolling plan schema")
    return plan


def find_batch(plan: dict[str, Any], batch_id: str) -> dict[str, Any]:
    for batch in plan.get("batches", []):
        if batch.get("batch_id") == batch_id:
            return batch
    raise dataset.CatalogError(f"unknown batch_id: {batch_id}")


def phase_reached(stop_after: str, phase: str) -> bool:
    return PHASES.index(stop_after) >= PHASES.index(phase)


def batch_status(path: Path, phase: str, **extra: Any) -> None:
    dataset.atomic_json(path, {"schema_version": SCHEMA_VERSION, "updated_at": utc_now(), "phase": phase, **extra})


def write_fixed_splits(acquired_rows: Sequence[dict[str, Any]], split_root: Path) -> None:
    by_split: dict[str, list[dict[str, Any]]] = {split: [] for split in dataset.SPLITS}
    for original in acquired_rows:
        row = dataset.clean_record(original)
        split = dataset.normalize_split(row.get("split"))
        if split not in by_split:
            raise dataset.CatalogError(f"{row.get('sample_id')}: acquired row has no valid fixed split")
        row["split"] = split
        by_split[split].append(row)
    for split in dataset.SPLITS:
        dataset.write_jsonl(split_root / dataset.SPLIT_FILES[split], by_split[split])
    dataset.write_jsonl(split_root / "reference.jsonl", [])
    dataset.atomic_json(split_root / "split_report.json", {
        "schema_version": SCHEMA_VERSION,
        "fixed_from_global_leakage_safe_plan": True,
        "counts": {split: len(by_split[split]) for split in dataset.SPLITS},
    })


def make_batch_config(base_config: Path, work_root: Path, packaged_root: Path) -> dict[str, Any]:
    config = read_json(base_config)
    config["run_root"] = str((work_root / "temporal_run").resolve())
    config["expert_cache_root"] = str((work_root / "expert_cache").resolve())
    config["upload_bundle"] = False
    config.setdefault("data", {})
    config["data"].update({
        "local_root": str(packaged_root.resolve()),
        "dataset_repo": "",
        "smoke_shards": 1,
        "manifests": {
            "train": "manifests/train.jsonl",
            "validation": "manifests/validation.jsonl",
            "test": "manifests/test.jsonl",
        },
    })
    return config


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): dataset.sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.name.endswith(".partial")
    }


def copy_verified_tree(source: Path, destination: Path) -> dict[str, str]:
    expected = tree_hashes(source)
    for relative in expected:
        source_file = source / relative
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target)
    actual = tree_hashes(destination)
    mismatches = [name for name, digest in expected.items() if actual.get(name) != digest]
    extras = sorted(set(actual) - set(expected))
    if mismatches or extras:
        raise RuntimeError(f"durable copy verification failed; mismatches={mismatches[:8]} extras={extras[:8]}")
    return expected


def is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([str(path.resolve()), str(root.resolve())]) == str(root.resolve())
    except ValueError:
        return False


def cleanup_ephemeral(work_root: Path, stage_root: Path, durable_marker: Path) -> None:
    if not durable_marker.is_file():
        raise RuntimeError("refusing cleanup before durable completion marker exists")
    if not is_within(work_root, stage_root) or work_root.resolve() == stage_root.resolve():
        raise RuntimeError(f"refusing cleanup outside the batch stage root: {work_root}")
    for name in ("acquired", "splits", "prepared", "packaged", "expert_cache", "temporal_run"):
        target = (work_root / name).resolve()
        if target.exists():
            if not is_within(target, work_root):
                raise RuntimeError(f"refusing unsafe cleanup target: {target}")
            shutil.rmtree(target)


def run_batch(
    plan_root: Path,
    batch_id: str,
    stage_root: Path,
    durable_root: Path | None,
    base_config: Path | None,
    *,
    stop_after: str,
    execute: bool,
    confirm_rights: bool,
    cleanup: bool,
) -> dict[str, Any]:
    if stop_after not in PHASES:
        raise dataset.CatalogError(f"invalid stop phase: {stop_after}")
    if not execute or not confirm_rights:
        raise dataset.CatalogError("batch execution requires --execute and --confirm-rights")
    if phase_reached(stop_after, "cache") and base_config is None:
        raise dataset.CatalogError("--base-config is required for cache generation")
    if phase_reached(stop_after, "durable") and durable_root is None:
        raise dataset.CatalogError("--durable-root is required for durable completion")
    if cleanup and stop_after != "durable":
        raise dataset.CatalogError("cleanup is only allowed after durable completion")

    plan = load_plan(plan_root)
    batch = find_batch(plan, batch_id)
    catalog_path = plan_root / str(batch["records_file"])
    rows = dataset.read_jsonl(catalog_path)
    if catalog_digest(rows) != str(batch["catalog_sha256"]):
        raise dataset.CatalogError(f"batch catalog fingerprint changed: {batch_id}")
    validation = dataset.validate_catalog(rows, catalog_path=catalog_path)
    dataset.require_valid(validation)
    if any(dataset.dataset_inclusion_reasons(row) for row in rows):
        raise dataset.CatalogError("batch contains a row that is not approved for training or safety evaluation")

    stage_root.mkdir(parents=True, exist_ok=True)
    peak = int(batch.get("estimated_peak_working_bytes") or batch["expected_raw_bytes"])
    free = shutil.disk_usage(stage_root).free
    if free < peak:
        raise RuntimeError(f"insufficient staging disk: need about {peak / GIB:.1f} GiB, have {free / GIB:.1f} GiB")
    work_root = stage_root / str(plan["run_id"]) / batch_id
    work_root.mkdir(parents=True, exist_ok=True)
    status_path = work_root / "batch_status.json"

    acquired_root = work_root / "acquired"
    batch_status(status_path, "acquire_started", batch_id=batch_id, worker_id=batch["worker_id"])
    acquisition = dataset.acquire_catalog(
        catalog_path,
        rows,
        acquired_root,
        execute=True,
        confirm_rights=True,
        max_height=720,
        max_filesize_mb=max(250, int(batch["expected_raw_bytes"] / (1024 * 1024))),
    )
    if acquisition["failed"] or acquisition["acquired"] != len(rows):
        raise RuntimeError(f"batch acquisition incomplete: {acquisition['acquired']}/{len(rows)}")
    batch_status(status_path, "acquired", batch_id=batch_id, acquired=acquisition["acquired"])
    if stop_after == "acquire":
        return read_json(status_path)

    acquired_rows = dataset.read_jsonl(acquired_root / "acquired_catalog.jsonl")
    split_root = work_root / "splits"
    write_fixed_splits(acquired_rows, split_root)
    prepared_root = work_root / "prepared"
    precompute = dataset.precompute_splits(
        split_root,
        acquired_root,
        prepared_root,
        image_size=224,
        view_counts={"micro": 32, "mid": 16, "long": 8, "extra_long": 16},
    )
    if precompute["failed"]:
        raise RuntimeError(f"batch precompute failed for {precompute['failed']} record(s)")
    batch_status(status_path, "precomputed", batch_id=batch_id, prepared=precompute["prepared"])
    if stop_after == "precompute":
        return read_json(status_path)

    packaged_root = work_root / "packaged"
    package = dataset.pack_prepared(prepared_root, packaged_root, max_shard_bytes=1024 * 1024 * 1024)
    batch_status(status_path, "packed", batch_id=batch_id, package=package)
    if stop_after == "pack":
        return read_json(status_path)

    assert base_config is not None
    config = make_batch_config(base_config, work_root, packaged_root)
    config_path = work_root / "batch_temporal_config.json"
    dataset.atomic_json(config_path, config)
    batch_status(status_path, "cache_started", batch_id=batch_id)
    subprocess.run(
        [sys.executable, str(COLAB_RETRAIN), "run", "--config", str(config_path), "--start-at", "cache", "--stop-after", "cache"],
        cwd=REPO_ROOT,
        check=True,
    )
    cache_root = work_root / "expert_cache"
    if not (cache_root / "READY").is_file():
        raise RuntimeError("expert cache did not produce READY marker")
    batch_status(status_path, "cached", batch_id=batch_id, cache_hashes=tree_hashes(cache_root))
    if stop_after == "cache":
        return read_json(status_path)

    assert durable_root is not None
    durable_batch = durable_root / str(plan["run_id"]) / f"worker-{int(batch['worker_id'])}" / batch_id
    durable_cache = durable_batch / "expert_cache"
    hashes = copy_verified_tree(cache_root, durable_cache)
    shutil.copy2(config_path, durable_batch / "batch_temporal_config.json")
    marker = durable_batch / "BATCH_COMPLETE.json"
    dataset.atomic_json(marker, {
        "schema_version": SCHEMA_VERSION,
        "completed_at": utc_now(),
        "run_id": plan["run_id"],
        "batch_id": batch_id,
        "worker_id": batch["worker_id"],
        "catalog_sha256": batch["catalog_sha256"],
        "sample_count": batch["sample_count"],
        "cache_files": hashes,
    })
    batch_status(status_path, "durable", batch_id=batch_id, durable_marker=str(marker))
    if cleanup:
        cleanup_ephemeral(work_root, stage_root, marker)
        tombstone = work_root / "batch_status.json"
        batch_status(tombstone, "cleaned", batch_id=batch_id, durable_marker=str(marker))
    return read_json(work_root / "batch_status.json")


def completed_marker(durable_root: Path, run_id: str, batch: dict[str, Any]) -> Path:
    return durable_root / run_id / f"worker-{int(batch['worker_id'])}" / str(batch["batch_id"]) / "BATCH_COMPLETE.json"


def worker_batches(plan: dict[str, Any], worker_id: int) -> list[dict[str, Any]]:
    if worker_id < 0 or worker_id >= int(plan["workers"]):
        raise dataset.CatalogError(f"worker_id must be between 0 and {int(plan['workers']) - 1}")
    return [batch for batch in plan["batches"] if int(batch["worker_id"]) == worker_id]


def merge_expert_caches(cache_roots: Sequence[Path], output_root: Path) -> dict[str, Any]:
    if len(cache_roots) < 1:
        raise dataset.CatalogError("at least one component cache is required")
    if output_root.exists() and any(output_root.iterdir()):
        raise dataset.CatalogError(f"merged cache output must be empty: {output_root}")
    metas: list[dict[str, Any]] = []
    manifests: list[list[dict[str, Any]]] = []
    for root in cache_roots:
        for required in ("READY", "cache_meta.json", "cache_manifest.jsonl"):
            if not (root / required).is_file():
                raise FileNotFoundError(root / required)
        metas.append(read_json(root / "cache_meta.json"))
        manifests.append(dataset.read_jsonl(root / "cache_manifest.jsonl"))
    baseline = metas[0]
    for index, meta in enumerate(metas[1:], 1):
        for field in ("expert_names", "embedding_dim", "expert_checkpoint_fingerprints"):
            if meta.get(field) != baseline.get(field):
                raise dataset.CatalogError(f"component cache {index} disagrees on {field}")

    output_root.mkdir(parents=True, exist_ok=True)
    all_rows: list[dict[str, Any]] = []
    sample_ids: set[str] = set()
    next_shard = collections.Counter()
    counts = collections.Counter()
    components: list[dict[str, Any]] = []
    source_fingerprints: dict[str, str] = {}

    for component_index, (root, meta, rows) in enumerate(zip(cache_roots, metas, manifests)):
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
        for original in rows:
            row = dataset.clean_record(original)
            sample_id = str(row.get("sample_id") or row.get("record_hash") or "")
            if not sample_id:
                raise dataset.CatalogError(f"component {component_index} contains a cache row without sample_id")
            if sample_id in sample_ids:
                raise dataset.CatalogError(f"duplicate sample_id across component caches: {sample_id}")
            sample_ids.add(sample_id)
            split = dataset.normalize_split(row.get("split"))
            if split not in dataset.SPLITS:
                raise dataset.CatalogError(f"{sample_id}: invalid cache split {split!r}")
            grouped[(split, str(row.get("shard_path") or ""))].append(row)
        for (split, source_relative), shard_rows in sorted(grouped.items()):
            if not source_relative:
                raise dataset.CatalogError(f"component {component_index} cache row is missing shard_path")
            source = root / source_relative
            if not source.is_file():
                raise FileNotFoundError(source)
            index = int(next_shard[split])
            next_shard[split] += 1
            target_relative = f"{split}/cache-{index:05d}.npz"
            target = output_root / target_relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            if dataset.sha256_file(source) != dataset.sha256_file(target):
                raise RuntimeError(f"cache shard copy verification failed: {source}")
            updated_rows = []
            for row in sorted(shard_rows, key=lambda value: int(value.get("row_index", -1))):
                row["split"] = split
                row["shard_path"] = target_relative
                updated_rows.append(row)
                all_rows.append(row)
                counts[split] += 1
            dataset.write_jsonl(output_root / f"{split}/cache-{index:05d}.jsonl", updated_rows)
        component_key = f"component-{component_index:04d}"
        for split, fingerprint in sorted((meta.get("source_manifest_fingerprints") or {}).items()):
            source_fingerprints[f"{component_key}:{split}"] = str(fingerprint)
        components.append({
            "id": component_key,
            "root": str(root.resolve()),
            "cache_meta_sha256": dataset.sha256_file(root / "cache_meta.json"),
            "records": len(rows),
        })

    all_rows.sort(key=lambda row: (dataset.SPLITS.index(str(row["split"])), str(row["shard_path"]), int(row["row_index"])))
    dataset.write_jsonl(output_root / "cache_manifest.jsonl", all_rows)
    merged_meta = {
        "schema_version": 1,
        "created_at": utc_now(),
        "expert_names": baseline.get("expert_names"),
        "embedding_dim": baseline.get("embedding_dim"),
        "expert_checkpoint_specs": baseline.get("expert_checkpoint_specs", {}),
        "expert_checkpoint_fingerprints": baseline.get("expert_checkpoint_fingerprints"),
        "counts": {split: int(counts[split]) for split in dataset.SPLITS},
        "source_manifests": {"components": [item["root"] for item in components]},
        "source_manifest_fingerprints": source_fingerprints,
        "component_caches": components,
    }
    dataset.atomic_json(output_root / "cache_meta.json", merged_meta)
    dataset.atomic_write_text(output_root / "READY", json.dumps(merged_meta["expert_checkpoint_fingerprints"], sort_keys=True) + "\n")

    sys.path.insert(0, str(CORE_TEMPORAL))
    try:
        from full_pipeline_utils import validate_expert_cache  # type: ignore

        validation = validate_expert_cache(
            output_root,
            expected_split_counts=merged_meta["counts"],
            required_experts=tuple(merged_meta["expert_names"]),
            verify_arrays=True,
        )
    finally:
        if sys.path and sys.path[0] == str(CORE_TEMPORAL):
            sys.path.pop(0)
    dataset.atomic_json(output_root / "cache_validation.json", validation)
    return {"components": len(cache_roots), "counts": merged_meta["counts"], "validation": validation}


def render_final_config(base_config: Path, merged_cache: Path, run_root: Path, output: Path) -> dict[str, Any]:
    config = read_json(base_config)
    config["run_root"] = str(run_root.resolve())
    config["expert_cache_root"] = str(merged_cache.resolve())
    config["upload_bundle"] = True
    config["output_subdir"] = f"rolling_{merged_cache.parent.name}_fusion"
    dataset.atomic_json(output, config)
    meta = read_json(merged_cache / "cache_meta.json")
    report = {
        "schema_version": 1,
        "generated_from_merged_expert_cache": True,
        "splits": {split: {"total": int(meta.get("counts", {}).get(split, 0))} for split in dataset.SPLITS},
        "component_caches": meta.get("component_caches", []),
        "production_data_gate_passed": False,
        "warnings": ["Final production sign-off still requires the global rights ledger and split readiness report."],
    }
    dataset.atomic_json(run_root / "split_validation_report.json", report)
    return config


def plan_status(plan_root: Path, durable_root: Path) -> dict[str, Any]:
    plan = load_plan(plan_root)
    batches = []
    for batch in plan["batches"]:
        marker = completed_marker(durable_root, str(plan["run_id"]), batch)
        batches.append({
            "batch_id": batch["batch_id"],
            "worker_id": batch["worker_id"],
            "samples": batch["sample_count"],
            "complete": marker.is_file(),
            "marker": str(marker),
        })
    return {
        "run_id": plan["run_id"],
        "total_batches": len(batches),
        "complete_batches": sum(item["complete"] for item in batches),
        "ready_to_merge": bool(batches) and all(item["complete"] for item in batches),
        "batches": batches,
    }


def command_plan(args: argparse.Namespace) -> int:
    plan = build_plan(
        Path(args.split_root).resolve(),
        Path(args.output_root).resolve(),
        workers=args.workers,
        max_batch_bytes=int(args.max_batch_gib * GIB),
        default_item_bytes=int(args.default_item_mb * 1024 * 1024),
        working_set_multiplier=args.working_set_multiplier,
        run_id=args.run_id,
    )
    print(json.dumps(plan, indent=2, sort_keys=True))
    return 0


def command_run_batch(args: argparse.Namespace) -> int:
    result = run_batch(
        Path(args.plan_root).resolve(),
        args.batch_id,
        Path(args.stage_root).resolve(),
        Path(args.durable_root).resolve() if args.durable_root else None,
        Path(args.base_config).resolve() if args.base_config else None,
        stop_after=args.stop_after,
        execute=args.execute,
        confirm_rights=args.confirm_rights,
        cleanup=args.cleanup,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_run_worker(args: argparse.Namespace) -> int:
    plan_root = Path(args.plan_root).resolve()
    durable_root = Path(args.durable_root).resolve()
    plan = load_plan(plan_root)
    results = []
    for batch in worker_batches(plan, args.worker_id):
        marker = completed_marker(durable_root, str(plan["run_id"]), batch)
        if marker.is_file():
            results.append({"batch_id": batch["batch_id"], "status": "already_complete"})
            continue
        run_batch(
            plan_root,
            str(batch["batch_id"]),
            Path(args.stage_root).resolve(),
            durable_root,
            Path(args.base_config).resolve(),
            stop_after="durable",
            execute=args.execute,
            confirm_rights=args.confirm_rights,
            cleanup=args.cleanup,
        )
        results.append({"batch_id": batch["batch_id"], "status": "complete"})
    print(json.dumps({"worker_id": args.worker_id, "results": results}, indent=2, sort_keys=True))
    return 0


def command_status(args: argparse.Namespace) -> int:
    report = plan_status(Path(args.plan_root).resolve(), Path(args.durable_root).resolve())
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ready_to_merge"] else 1


def command_merge(args: argparse.Namespace) -> int:
    roots = [Path(value).resolve() for value in args.cache_root]
    report = merge_expert_caches(roots, Path(args.output_root).resolve())
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def command_merge_run(args: argparse.Namespace) -> int:
    plan_root = Path(args.plan_root).resolve()
    durable_root = Path(args.durable_root).resolve()
    plan = load_plan(plan_root)
    status = plan_status(plan_root, durable_root)
    if not status["ready_to_merge"]:
        raise dataset.CatalogError(
            f"cannot merge before every durable batch completes: {status['complete_batches']}/{status['total_batches']}"
        )
    roots = [
        completed_marker(durable_root, str(plan["run_id"]), batch).parent / "expert_cache"
        for batch in plan["batches"]
    ]
    report = merge_expert_caches(roots, Path(args.output_root).resolve())
    report["run_id"] = plan["run_id"]
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def command_render_final(args: argparse.Namespace) -> int:
    config = render_final_config(
        Path(args.base_config).resolve(),
        Path(args.merged_cache).resolve(),
        Path(args.run_root).resolve(),
        Path(args.output).resolve(),
    )
    print(json.dumps({"output": str(Path(args.output).resolve()), "run_root": config["run_root"]}, indent=2))
    return 0


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="orislop-rolling-") as temporary:
        root = Path(temporary)
        splits = root / "splits"
        for split in dataset.SPLITS:
            rows = []
            for index in range(12):
                label = index % 2
                absolute = index + dataset.SPLITS.index(split) * 12
                rows.append({
                    "sample_id": f"rolling-{split}-{index:03d}",
                    "label": label,
                    "authenticity_label": "manipulated" if label else "genuine",
                    "media_origin": "hybrid" if label else "camera_capture",
                    "transformation_types": ["face_swap"] if label else ["none"],
                    "sync_status": "manipulated_sync" if label else "synchronized",
                    "platform": ("youtube", "tiktok", "instagram")[absolute % 3],
                    "source_url": f"https://example.invalid/{split}/{index}.mp4",
                    "acquisition_method": "controlled_generation" if label else "rights_holder_direct_download",
                    "content_profile": "general_video",
                    "source_asset_id": f"asset-{split}-{index // 2}",
                    "group_id": f"asset-{split}-{index // 2}",
                    "creator_id": f"creator-{split}-{index // 4}",
                    "generator_id": f"generator-{index % 3}" if label else "",
                    "generator_family_id": f"generator-family-{index % 3}" if label else "",
                    "usage": "training",
                    "rights_status": "approved",
                    "license_id": "self-test",
                    "rights_evidence": {
                        "download_permitted": True,
                        "commercial_ml_training": True,
                        "derivatives_permitted": True,
                        "trained_model_distribution_permitted": True,
                        "license_or_contract_id": "self-test",
                    },
                    "rights_review": {
                        "reviewer": "self-test",
                        "reviewed_at": "2026-07-15T00:00:00Z",
                        "approval_id": f"rights-{split}-{index}",
                    },
                    "label_status": "verified",
                    "label_evidence": [{"type": "generation_log" if label else "capture_provenance", "reference": "self-test"}],
                    "provenance_review": {
                        "reviewer": "self-test",
                        "reviewed_at": "2026-07-15T00:00:00Z",
                        "approval_id": f"provenance-{split}-{index}",
                    },
                    "contains_identifiable_people": False,
                    "estimated_bytes": (index + 1) * 1024,
                    "split": split,
                })
            dataset.write_jsonl(splits / dataset.SPLIT_FILES[split], rows)
        plan = build_plan(
            splits,
            root / "plan",
            workers=4,
            max_batch_bytes=32 * 1024,
            default_item_bytes=1024,
            working_set_multiplier=1.5,
            run_id="self-test",
        )
        assert int(plan["records"]) == 36
        assert int(plan["workers"]) == 4
        assert all(int(batch["expected_raw_bytes"]) <= 32 * 1024 for batch in plan["batches"])
        assigned = [batch_id for worker in plan["worker_assignments"].values() for batch_id in worker["batches"]]
        assert sorted(assigned) == sorted(batch["batch_id"] for batch in plan["batches"])
    print("Orislop rolling dataset pipeline self-test passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="create <=50 GiB batches and balance them across workers")
    plan.add_argument("--split-root", required=True)
    plan.add_argument("--output-root", required=True)
    plan.add_argument("--workers", type=int, default=4)
    plan.add_argument("--max-batch-gib", type=float, default=50.0)
    plan.add_argument("--default-item-mb", type=float, default=64.0)
    plan.add_argument("--working-set-multiplier", type=float, default=1.5)
    plan.add_argument("--run-id")
    plan.set_defaults(func=command_plan)

    run_batch_parser = subparsers.add_parser("run-batch", help="acquire, precompute, cache, persist, and optionally clean one batch")
    run_batch_parser.add_argument("--plan-root", required=True)
    run_batch_parser.add_argument("--batch-id", required=True)
    run_batch_parser.add_argument("--stage-root", required=True)
    run_batch_parser.add_argument("--durable-root")
    run_batch_parser.add_argument("--base-config")
    run_batch_parser.add_argument("--stop-after", choices=PHASES, default="durable")
    run_batch_parser.add_argument("--execute", action="store_true")
    run_batch_parser.add_argument("--confirm-rights", action="store_true")
    run_batch_parser.add_argument("--cleanup", action="store_true")
    run_batch_parser.set_defaults(func=command_run_batch)

    worker = subparsers.add_parser("run-worker", help="run every batch assigned to one worker")
    worker.add_argument("--plan-root", required=True)
    worker.add_argument("--worker-id", type=int, required=True)
    worker.add_argument("--stage-root", required=True)
    worker.add_argument("--durable-root", required=True)
    worker.add_argument("--base-config", required=True)
    worker.add_argument("--execute", action="store_true")
    worker.add_argument("--confirm-rights", action="store_true")
    worker.add_argument("--cleanup", action="store_true")
    worker.set_defaults(func=command_run_worker)

    status = subparsers.add_parser("status", help="report durable completion across all workers")
    status.add_argument("--plan-root", required=True)
    status.add_argument("--durable-root", required=True)
    status.set_defaults(func=command_status)

    merge = subparsers.add_parser("merge-caches", help="merge verified worker caches for one synchronized fusion run")
    merge.add_argument("--cache-root", action="append", required=True)
    merge.add_argument("--output-root", required=True)
    merge.set_defaults(func=command_merge)

    merge_run = subparsers.add_parser("merge-run", help="collect and merge every completed cache in a rolling plan")
    merge_run.add_argument("--plan-root", required=True)
    merge_run.add_argument("--durable-root", required=True)
    merge_run.add_argument("--output-root", required=True)
    merge_run.set_defaults(func=command_merge_run)

    final = subparsers.add_parser("render-final-config", help="point the final fusion/calibration run at the merged cache")
    final.add_argument("--base-config", required=True)
    final.add_argument("--merged-cache", required=True)
    final.add_argument("--run-root", required=True)
    final.add_argument("--output", required=True)
    final.set_defaults(func=command_render_final)

    subparsers.add_parser("self-test", help="run the dependency-free batching contract test").set_defaults(func=lambda _args: self_test())
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (dataset.CatalogError, FileNotFoundError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
