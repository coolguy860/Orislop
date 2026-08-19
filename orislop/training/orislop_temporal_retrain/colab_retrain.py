#!/usr/bin/env python3
"""One-command Colab retraining for Orislop Temporal MoE fusion.

The default path freezes the four existing temporal experts, caches their outputs
once, trains a fresh Stage 2 router/fusion model, calibrates Stage 3 on validation
only, evaluates exactly once on test, and builds a deployment bundle. An optional
AV path uses the uncached trainer because each row must carry prepared AV tensors.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
import sys
import tempfile
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
TRAINER = REPO_ROOT / "core" / "temporal_detector" / "temporal_deepfake_moe_hf_colab.py"
STAGES = ("prepare", "validate", "cache", "train", "calibrate", "evaluate", "package")
DEFAULT_DATASET_REPO = "gonnerthetooner/deepfake-frame-views-balanced-fusion-v1"
DEFAULT_MODEL_REPO = "gonnerthetooner/deepfake-temporal-moe"
DEFAULT_EXPERT_DIR = "a100_high_vram_60gb_v1"


def load_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).expanduser().read_text(encoding="utf-8"))


def atomic_json(path: str | Path, value: Any) -> None:
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, target)


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolved_paths(config: dict[str, Any]) -> dict[str, Path]:
    run_root = Path(config["run_root"]).expanduser().resolve()
    data_root = Path(config["data"]["local_root"]).expanduser().resolve()
    manifests = config["data"].get("manifests") or {}
    manifest_root = data_root / "manifests"

    def manifest_path(key: str, default: Path) -> Path:
        supplied = manifests.get(key)
        candidate = Path(supplied).expanduser() if supplied else default
        if not candidate.is_absolute():
            candidate = data_root / candidate
        return candidate.resolve()

    return {
        "run_root": run_root,
        "data_root": data_root,
        "expert_cache": Path(config.get("expert_cache_root") or run_root / "expert_cache").expanduser().resolve(),
        "train_manifest": manifest_path("train", manifest_root / "train.jsonl"),
        "validation_manifest": manifest_path("validation", manifest_root / "validation.jsonl"),
        "test_manifest": manifest_path("test", manifest_root / "test.jsonl"),
    }


def validate_config(config: dict[str, Any]) -> None:
    for key in ("run_root", "data", "model_repo", "output_subdir", "experts", "training", "gates"):
        if key not in config:
            raise ValueError(f"configuration is missing {key!r}")
    if not str(config["model_repo"]).count("/") == 1:
        raise ValueError("model_repo must be USER/REPO")
    dataset_repo = str(config["data"].get("dataset_repo", ""))
    manifests = config["data"].get("manifests") or {}
    if dataset_repo and dataset_repo.count("/") != 1:
        raise ValueError("data.dataset_repo must be USER/REPO")
    if not dataset_repo and not all(manifests.get(split) for split in ("train", "validation", "test")):
        raise ValueError("Set data.dataset_repo or provide train, validation, and test data.manifests paths")
    if bool(config.get("av", {}).get("enabled")) and not config["av"].get("lip_checkpoint"):
        raise ValueError("AV fusion requires av.lip_checkpoint")
    if int(config["training"].get("fusion_epochs", 0)) < 1:
        raise ValueError("training.fusion_epochs must be positive")


def safe_member(value: str) -> str:
    member = PurePosixPath(str(value).replace("\\", "/"))
    if member.is_absolute() or ".." in member.parts or not member.parts:
        raise ValueError(f"unsafe tar member path: {value!r}")
    return member.as_posix()


def prepare_dataset(config: dict[str, Any], paths: dict[str, Path]) -> dict[str, Any]:
    data = config["data"]
    if data.get("manifests") and not data.get("dataset_repo"):
        return {"downloaded": False, "reason": "using caller-supplied manifests"}
    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError as error:
        raise RuntimeError("Install training/orislop_temporal_retrain/requirements-colab.txt first") from error

    repo_id = str(data.get("dataset_repo") or DEFAULT_DATASET_REPO)
    revision = str(data.get("revision") or "main")
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    api = HfApi(token=token)
    info = api.dataset_info(repo_id, revision=revision, files_metadata=True)
    available_shards = sorted(
        sibling.rfilename
        for sibling in info.siblings
        if sibling.rfilename.startswith("shards/") and sibling.rfilename.endswith(".tar")
    )
    smoke_shards = int(data.get("smoke_shards") or 0)
    selected_shards = available_shards[:smoke_shards] if smoke_shards else available_shards
    if not selected_shards:
        raise RuntimeError(f"No tar shards found in {repo_id}")
    selected_stems = {Path(name).stem for name in selected_shards}
    selected_parts = [f"manifest_parts/{stem}.jsonl" for stem in sorted(selected_stems)]
    expected_bytes = sum(
        int(sibling.size or 0)
        for sibling in info.siblings
        if sibling.rfilename in selected_shards
    )
    paths["data_root"].mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(paths["data_root"].parent).free
    required_bytes = int(expected_bytes * 1.12) + 2 * 1024**3
    if free_bytes < required_bytes:
        raise RuntimeError(
            f"Dataset needs about {required_bytes / 1024**3:.1f} GiB free, "
            f"but only {free_bytes / 1024**3:.1f} GiB is available"
        )
    allow_patterns = [
        "README.md",
        "*.json",
        *selected_shards,
        *selected_parts,
    ]
    snapshot_download(
        repo_id=repo_id,
        repo_type="dataset",
        revision=revision,
        local_dir=str(paths["data_root"]),
        allow_patterns=allow_patterns,
        token=token,
    )

    rows_by_split: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    for part_name in selected_parts:
        part_path = paths["data_root"] / part_name
        stem = part_path.stem
        archive_relative = f"shards/{stem}.tar"
        archive_path = paths["data_root"] / archive_relative
        if not archive_path.is_file():
            raise FileNotFoundError(f"Dataset shard is missing: {archive_path}")
        for line_number, line in enumerate(part_path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            split = "val" if str(row.get("split")).lower() == "validation" else str(row.get("split", "train")).lower()
            if split not in rows_by_split:
                raise ValueError(f"Unexpected split {split!r} in {part_path}:{line_number}")
            member = safe_member(str(row.get("member_path") or row.get("video_path") or ""))
            sample_id = str(
                row.get("sample_id")
                or row.get("content_sha256")
                or row.get("source_record_id")
                or hashlib.sha256(f"{archive_relative}:{member}".encode()).hexdigest()
            )
            rows_by_split[split].append({
                **row,
                "split": split,
                "archive_path": archive_relative,
                "member_path": member,
                "sample_id": sample_id,
                "source": "precomputed_colab_tar",
            })

    output_paths = {
        "train": paths["train_manifest"],
        "val": paths["validation_manifest"],
        "test": paths["test_manifest"],
    }
    for split, rows in rows_by_split.items():
        target = output_paths[split]
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".jsonl.partial")
        temporary.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
        os.replace(temporary, target)
    report = {
        "dataset_repo": repo_id,
        "revision": revision,
        "shards": len(selected_shards),
        "download_bytes": expected_bytes,
        "smoke_only": bool(smoke_shards),
        "counts": {split: len(rows) for split, rows in rows_by_split.items()},
    }
    atomic_json(paths["run_root"] / "dataset_prepare_report.json", report)
    return report


def row_identity(row: dict[str, Any], manifest: Path) -> str:
    identity = row.get("content_sha256") or row.get("sample_id") or row.get("source_record_id")
    if identity:
        return str(identity).lower()
    archive = row.get("archive_path")
    member = row.get("member_path") or row.get("video_path")
    if archive and member:
        return f"{archive}:{member}".lower()
    return str((manifest.parent / str(row.get("video_path", ""))).resolve()).lower()


def validate_manifests(config: dict[str, Any], paths: dict[str, Path]) -> dict[str, Any]:
    split_files = {
        "train": paths["train_manifest"],
        "val": paths["validation_manifest"],
        "test": paths["test_manifest"],
    }
    identities: dict[str, set[str]] = {}
    report: dict[str, Any] = {"splits": {}, "warnings": []}
    group_fields_seen = 0
    for split, manifest in split_files.items():
        if not manifest.is_file():
            raise FileNotFoundError(f"Missing {split} manifest: {manifest}")
        label_counts = {0: 0, 1: 0}
        datasets: dict[str, int] = {}
        split_ids: set[str] = set()
        for line_number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            row_split = "val" if str(row.get("split")).lower() == "validation" else str(row.get("split", split)).lower()
            if row_split != split:
                raise ValueError(f"{manifest}:{line_number} is {row_split}, expected {split}")
            label = int(row["label"])
            if label not in label_counts:
                raise ValueError(f"{manifest}:{line_number} has invalid label {label}")
            label_counts[label] += 1
            dataset = str(row.get("dataset") or "unknown")
            datasets[dataset] = datasets.get(dataset, 0) + 1
            identity = row_identity(row, manifest)
            if identity in split_ids:
                raise ValueError(f"Duplicate sample identity in {split}: {identity}")
            split_ids.add(identity)
            archive = row.get("archive_path")
            member = row.get("member_path")
            if archive or member:
                if not archive or not member:
                    raise ValueError(f"{manifest}:{line_number} must provide both archive_path and member_path")
                archive_relative = safe_member(str(archive))
                safe_member(str(member))
                if not (paths["data_root"] / archive_relative).is_file():
                    raise FileNotFoundError(f"Missing archive referenced by {manifest}:{line_number}: {archive_relative}")
            if any(row.get(field) for field in ("subject_id", "person_id", "identity_id", "generator_id", "group_id")):
                group_fields_seen += 1
            if bool(config.get("av", {}).get("enabled")) and not row.get("av_prepared_path"):
                raise ValueError(f"AV mode requires av_prepared_path on every row ({manifest}:{line_number})")
        minimum = int(config["training"].get(f"minimum_{split}_per_class", 1))
        if min(label_counts.values()) < minimum and not config["data"].get("smoke_shards"):
            raise RuntimeError(f"{split} requires at least {minimum} records per class; found {label_counts}")
        identities[split] = split_ids
        report["splits"][split] = {"total": sum(label_counts.values()), "labels": label_counts, "datasets": datasets}
    for left, right in (("train", "val"), ("train", "test"), ("val", "test")):
        overlap = identities[left] & identities[right]
        if overlap:
            raise RuntimeError(f"Data leakage: {left} and {right} share {len(overlap)} sample identities")
    if group_fields_seen == 0:
        report["warnings"].append(
            "No subject/person/generator group identifier is present; sample-level disjointness passed, "
            "but identity/generator-level leakage cannot be ruled out."
        )
    report["av_enabled"] = bool(config.get("av", {}).get("enabled"))
    report["production_data_gate_passed"] = not report["warnings"] and not bool(config["data"].get("smoke_shards"))
    atomic_json(paths["run_root"] / "split_validation_report.json", report)
    return report


def bool_text(value: Any) -> str:
    return "true" if bool(value) else "false"


def common_args(config: dict[str, Any], paths: dict[str, Path]) -> list[str]:
    training = config["training"]
    return [
        "--hf-repo-id", str(config["model_repo"]),
        "--hf-private", bool_text(config.get("hf_private", False)),
        "--hf-checkpoint-dir", str(config["output_subdir"]),
        "--local-cache-dir", str(paths["run_root"]),
        "--strict-hf-upload", "true",
        "--precision", str(training.get("precision", "fp16")),
        "--embedding-dim", str(training.get("embedding_dim", 256)),
        "--fusion-dim", str(training.get("fusion_dim", 256)),
        "--fusion-layers", str(training.get("fusion_layers", 4)),
        "--fusion-heads", str(training.get("fusion_heads", 4)),
        "--fusion-dropout", str(training.get("fusion_dropout", 0.1)),
        "--fusion-lr", str(training.get("fusion_lr", 0.0001)),
        "--fusion-weight-decay", str(training.get("fusion_weight_decay", 0.0001)),
        "--fusion-epochs", str(training.get("fusion_epochs", 20)),
        "--fusion-early-stopping-patience", str(training.get("early_stopping_patience", 4)),
        "--fusion-early-stopping-min-delta", str(training.get("early_stopping_min_delta", 0.0005)),
        "--fusion-expert-dropout", str(training.get("expert_dropout", 0.1)),
        "--class-balanced-loss", "true",
        "--fusion-use-disagreement-features", "true",
        "--fusion-use-dataset-embedding", "false",
        "--seed", str(training.get("seed", 1337)),
        "--num-workers", str(training.get("num_workers", 0)),
        "--batch-size", str(training.get("batch_size", 1)),
        "--grad-accum-steps", str(training.get("grad_accum_steps", 4)),
        "--clip-frame-chunk-size", str(training.get("clip_frame_chunk_size", 2)),
        "--auto-resume", "true",
        "--hf-auto-resume", "true",
        "--resume-policy", "full",
        "--upload-best-to-hf", "true",
        "--upload-latest-to-hf", "true",
        "--hf-upload-every-epoch", "true",
    ]


def data_args(paths: dict[str, Path]) -> list[str]:
    return [
        "--precomputed-manifest", str(paths["train_manifest"]),
        "--precomputed-root", str(paths["data_root"]),
        "--validation-manifest", str(paths["validation_manifest"]),
        "--validation-root", str(paths["data_root"]),
        "--test-manifest", str(paths["test_manifest"]),
        "--test-root", str(paths["data_root"]),
        "--strict-local-data", "true",
    ]


def expert_args(config: dict[str, Any]) -> list[str]:
    experts = config["experts"]
    return [
        "--micro-checkpoint", str(experts["micro"]),
        "--mid-checkpoint", str(experts["mid"]),
        "--long-checkpoint", str(experts["long"]),
        "--extra-long-checkpoint", str(experts["extra_long"]),
        "--use-extra-long-in-fusion-training", "true",
    ]


def run_trainer(mode: str, arguments: list[str], paths: dict[str, Path]) -> None:
    command = [sys.executable, str(TRAINER), "--mode", mode, *arguments]
    print("\n[colab-pipeline] " + shlex.join(command), flush=True)
    subprocess.run(command, cwd=REPO_ROOT, check=True)
    atomic_json(paths["run_root"] / "last_completed_stage.json", {"mode": mode})


def run_cache(config: dict[str, Any], paths: dict[str, Path]) -> None:
    args = common_args(config, paths) + data_args(paths) + expert_args(config) + [
        "--expert-cache-root", str(paths["expert_cache"]),
        "--cache-splits", "train", "val", "test",
        "--cache-shard-records", str(config["training"].get("cache_shard_records", 1024)),
        "--verify-cache-arrays", "true",
    ]
    run_trainer("cache_experts", args, paths)


def run_train(config: dict[str, Any], paths: dict[str, Path]) -> None:
    if bool(config.get("av", {}).get("enabled")):
        args = common_args(config, paths) + data_args(paths) + expert_args(config) + [
            "--use-lip", "true",
            "--lip-checkpoint", str(config["av"]["lip_checkpoint"]),
            "--require-av-context", "true",
            "--use-spatial", "false",
        ]
        run_trainer("train_stage2", args, paths)
        return
    args = common_args(config, paths) + [
        "--expert-cache-root", str(paths["expert_cache"]),
        "--cached-fusion-batch-size", str(config["training"].get("cached_fusion_batch_size", 256)),
        "--verify-cache-arrays", "true",
    ]
    run_trainer("train_cached_fusion", args, paths)


def run_calibrate(config: dict[str, Any], paths: dict[str, Path]) -> None:
    checkpoint = paths["run_root"] / "checkpoints" / "stage2_fusion_best.pt"
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Stage 2 best checkpoint is missing: {checkpoint}")
    gates = config["gates"]
    calibration_args = common_args(config, paths) + [
        "--fusion-checkpoint", str(checkpoint),
        "--eval-split", "val",
        "--threshold-method", str(gates.get("threshold_method", "target_real_fpr")),
        "--threshold-target-real-fpr", str(gates.get("maximum_genuine_hide_rate", 0.001)),
        "--threshold-target-fake-recall", str(gates.get("minimum_recall", 0.9)),
    ]
    if bool(config.get("av", {}).get("enabled")):
        calibration_args += data_args(paths) + expert_args(config) + [
            "--use-lip", "true",
            "--lip-checkpoint", str(config["av"]["lip_checkpoint"]),
            "--require-av-context", "true",
            "--use-spatial", "false",
        ]
        run_trainer("calibrate", calibration_args, paths)
        # The direct AV calibration path historically used the generic metrics.json
        # filename. Normalize it so cached and AV bundles have the same contract.
        calibration_metrics = paths["run_root"] / "checkpoints" / "metrics.json"
        if calibration_metrics.is_file():
            shutil.copy2(
                calibration_metrics,
                paths["run_root"] / "checkpoints" / "metrics_calibration.json",
            )
    else:
        calibration_args += [
            "--expert-cache-root", str(paths["expert_cache"]),
            "--cached-fusion-batch-size", str(config["training"].get("cached_fusion_batch_size", 256)),
        ]
        run_trainer("calibrate_cached_fusion", calibration_args, paths)


def run_evaluate(config: dict[str, Any], paths: dict[str, Path]) -> None:
    checkpoint_dir = paths["run_root"] / "checkpoints"
    fusion = checkpoint_dir / "stage2_fusion_best.pt"
    calibration = checkpoint_dir / "stage3_calibration.pt"
    threshold = checkpoint_dir / "threshold.json"
    for artifact in (fusion, calibration, threshold):
        if not artifact.is_file():
            raise FileNotFoundError(f"Required evaluation artifact is missing: {artifact}")
    args = common_args(config, paths) + [
        "--fusion-checkpoint", str(fusion),
        "--calibration-checkpoint", str(calibration),
        "--threshold-checkpoint", str(threshold),
        "--eval-split", "test",
    ]
    if bool(config.get("av", {}).get("enabled")):
        args += data_args(paths) + expert_args(config) + [
            "--eval-include-extra-long", "true",
            "--use-lip", "true",
            "--lip-checkpoint", str(config["av"]["lip_checkpoint"]),
            "--require-av-context", "true",
            "--use-spatial", "false",
        ]
        run_trainer("eval", args, paths)
    else:
        args += [
            "--expert-cache-root", str(paths["expert_cache"]),
            "--cached-fusion-batch-size", str(config["training"].get("cached_fusion_batch_size", 256)),
        ]
        run_trainer("eval_cached_fusion", args, paths)


def package_bundle(config: dict[str, Any], paths: dict[str, Path]) -> dict[str, Any]:
    checkpoint_dir = paths["run_root"] / "checkpoints"
    bundle = paths["run_root"] / "deployment_bundle"
    bundle.mkdir(parents=True, exist_ok=True)
    sources = {
        "stage2_fusion_best.pt": checkpoint_dir / "stage2_fusion_best.pt",
        "stage3_calibration.pt": checkpoint_dir / "stage3_calibration.pt",
        "threshold.json": checkpoint_dir / "threshold.json",
        "metrics_calibration.json": checkpoint_dir / "metrics_calibration.json",
        "metrics_test.json": checkpoint_dir / "metrics_test.json",
        "split_validation_report.json": paths["run_root"] / "split_validation_report.json",
    }
    for name, source in sources.items():
        if not source.is_file():
            raise FileNotFoundError(f"Cannot package missing artifact: {source}")
        shutil.copy2(source, bundle / name)
    metrics = load_json(bundle / "metrics_test.json")
    gates = config["gates"]
    offline_gate = bool(
        int(metrics.get("n", 0)) >= int(gates.get("minimum_test_records", 1000))
        and float(metrics.get("real_fpr", 1.0)) <= float(gates.get("maximum_genuine_hide_rate", 0.001))
        and float(metrics.get("recall", 0.0)) >= float(gates.get("minimum_recall", 0.9))
        and float(metrics.get("ece", 1.0)) <= float(gates.get("maximum_ece", 0.03))
    )
    release = {
        "schemaVersion": 1,
        "model": "Orislop Temporal MoE",
        "outputSubdir": config["output_subdir"],
        "avEnabled": bool(config.get("av", {}).get("enabled")),
        "offlineGatePassed": offline_gate,
        "productionEligible": False,
        "productionBlockers": [
            "10,000 representative shadow decisions have not been reviewed.",
            "Training-data commercial rights and subject/generator grouping require sign-off.",
        ],
        "testMetrics": metrics,
    }
    atomic_json(bundle / "release_candidate.json", release)
    safe_config = json.loads(json.dumps(config))
    atomic_json(bundle / "training_config.json", safe_config)
    hashes = {
        path.name: {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
        for path in sorted(bundle.iterdir()) if path.is_file()
    }
    atomic_json(bundle / "SHA256SUMS.json", hashes)
    archive = shutil.make_archive(str(paths["run_root"] / "orislop-temporal-deployment-bundle"), "zip", bundle)
    if bool(config.get("upload_bundle", True)):
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        if not token:
            raise RuntimeError("HF_TOKEN is required to upload the deployment bundle")
        from huggingface_hub import HfApi
        HfApi(token=token).upload_folder(
            repo_id=str(config["model_repo"]),
            repo_type="model",
            folder_path=str(bundle),
            path_in_repo=f"{config['output_subdir']}/deployment_bundle",
            commit_message=f"Add {config['output_subdir']} calibrated deployment bundle",
        )
    result = {"bundle": str(bundle), "archive": archive, "release": release, "hashes": hashes}
    atomic_json(paths["run_root"] / "pipeline_result.json", result)
    return result


def run_pipeline(config: dict[str, Any], start_at: str, stop_after: str) -> None:
    validate_config(config)
    paths = resolved_paths(config)
    paths["run_root"].mkdir(parents=True, exist_ok=True)
    start_index = STAGES.index(start_at)
    stop_index = STAGES.index(stop_after)
    if stop_index < start_index:
        raise ValueError("--stop-after must not come before --start-at")
    for stage in STAGES[start_index : stop_index + 1]:
        print(f"\n========== ORISLOP TEMPORAL: {stage.upper()} ==========", flush=True)
        if stage == "prepare":
            prepare_dataset(config, paths)
        elif stage == "validate":
            print(json.dumps(validate_manifests(config, paths), indent=2), flush=True)
        elif stage == "cache":
            if bool(config.get("av", {}).get("enabled")):
                print("[colab-pipeline] AV mode uses direct frozen-expert fusion; skipping four-expert cache.", flush=True)
            else:
                run_cache(config, paths)
        elif stage == "train":
            run_train(config, paths)
        elif stage == "calibrate":
            run_calibrate(config, paths)
        elif stage == "evaluate":
            run_evaluate(config, paths)
        elif stage == "package":
            print(json.dumps(package_bundle(config, paths), indent=2), flush=True)


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="orislop-temporal-colab-") as temporary:
        root = Path(temporary)
        data = root / "data"
        (data / "shards").mkdir(parents=True)
        (data / "shards" / "frame_views_balanced_00000.tar").write_bytes(b"test")
        manifests = data / "manifests"
        manifests.mkdir()
        for split in ("train", "val", "test"):
            rows = []
            for label in (0, 1):
                rows.append({
                    "sample_id": f"{split}-{label}",
                    "label": label,
                    "dataset": "self-test",
                    "split": split,
                    "archive_path": "shards/frame_views_balanced_00000.tar",
                    "member_path": f"views/{split}-{label}.npz",
                })
            (manifests / f"{'validation' if split == 'val' else split}.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )
        prefix = f"hf:{DEFAULT_MODEL_REPO}/{DEFAULT_EXPERT_DIR}"
        config = {
            "run_root": str(root / "run"),
            "expert_cache_root": str(root / "run" / "cache"),
            "data": {
                "local_root": str(data),
                "dataset_repo": "",
                "smoke_shards": 1,
                "manifests": {
                    "train": "manifests/train.jsonl",
                    "validation": "manifests/validation.jsonl",
                    "test": "manifests/test.jsonl",
                },
            },
            "model_repo": DEFAULT_MODEL_REPO,
            "output_subdir": "self_test",
            "hf_private": False,
            "upload_bundle": False,
            "experts": {name: f"{prefix}/stage1_{name}_best.pt" for name in ("micro", "mid", "long", "extra_long")},
            "training": {"fusion_epochs": 1},
            "gates": {},
            "av": {"enabled": False, "lip_checkpoint": ""},
        }
        validate_config(config)
        paths = resolved_paths(config)
        report = validate_manifests(config, paths)
        assert report["splits"]["train"]["total"] == 2
        assert "cache_experts" not in common_args(config, paths)
        assert "--micro-checkpoint" in expert_args(config)
    print("Orislop Temporal Colab orchestrator self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Orislop Temporal MoE Colab retraining orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--config", required=True)
    run_parser.add_argument("--start-at", choices=STAGES, default="prepare")
    run_parser.add_argument("--stop-after", choices=STAGES, default="package")
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--config", required=True)
    subparsers.add_parser("self-test")
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return
    config = load_json(args.config)
    validate_config(config)
    if args.command == "validate":
        print(json.dumps(validate_manifests(config, resolved_paths(config)), indent=2))
        return
    if not (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")):
        raise RuntimeError("Add an HF_TOKEN Colab secret with write access before starting training")
    run_pipeline(config, args.start_at, args.stop_after)


if __name__ == "__main__":
    main()
