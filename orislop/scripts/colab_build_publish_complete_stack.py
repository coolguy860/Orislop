#!/usr/bin/env python3
"""Build one coherent, copy-only Orislop model repository from Drive.

The script never writes to or deletes from ``--drive-root``.  It selects the
promoted temporal run, proves that the temporal spatial and joint-AV artifacts
match the fingerprints used to train its fusion layer, stages a new release in
ephemeral storage, adds redistributable pinned upstream weights, verifies every
file, and uploads the result to one private Hugging Face model repository.

OpenAI CLIP weights are deliberately not re-hosted because their Hugging Face
repository has no explicit weight-license tag.  They remain an immutable,
automatic runtime dependency and are listed in EXTERNAL_DEPENDENCIES.json.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import traceback
from typing import Any, Mapping, Sequence


SCRIPT_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = SCRIPT_ROOT.parent
BASE_PUBLISHER_PATH = SCRIPT_ROOT / "colab_find_and_publish_drive_models.py"
IMMUTABLE_REVISION = re.compile(r"^[0-9a-f]{40}$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")

STANDALONE_SPATIAL = SOURCE_ROOT / "models" / "spatial" / "fusion_model_cls_v2.pt"
TRAINING_BUNDLE = SOURCE_ROOT / "training" / "bundles" / "orislop_retrain_sigkill_safe_v8.pyz"
TRAINING_DATASET_REPO = "gonnerthetooner/orislop-youtube-prepared-v2"
YUNET_GITHUB_COMMIT = "f12e12798e8314f7c074a6656816c048dcc95b7a"
YUNET_FILENAME = "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
YUNET_BYTES = 232_589
YUNET_URL = (
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/"
    f"{YUNET_GITHUB_COMMIT}/{YUNET_FILENAME}"
)

UPSTREAM_MODELS: tuple[dict[str, Any], ...] = (
    {
        "name": "lightweight_ai_image_detector",
        "repo": "umm-maybe/AI-image-detector",
        "revision": "c7e223baf11bc40528af364ba7bdea030ef42f9e",
        "license": "CC-BY-4.0",
        "destination": "upstream/lightweight-ai-image-detector",
        "files": ("README.md", "config.json", "preprocessor_config.json", "pytorch_model.bin"),
    },
    {
        "name": "standalone_spatial_vit",
        "repo": "google/vit-base-patch16-224",
        "revision": "3f49326eb077187dfe1c2a2bb15fbd74e6ab91e3",
        "license": "Apache-2.0",
        "destination": "upstream/vit-base-patch16-224",
        "files": ("README.md", "config.json", "preprocessor_config.json", "model.safetensors"),
    },
    {
        "name": "public_frame_detector",
        "repo": "prithivMLmods/Deepfake-Detection-Exp-02-21",
        "revision": "adf169cf452ea42f80d8cdca1302c8c9d09d1725",
        "license": "Apache-2.0",
        "destination": "upstream/public-frame-detector",
        "files": ("README.md", "config.json", "preprocessor_config.json", "model.safetensors"),
    },
    {
        "name": "aegis_motion",
        "repo": "MusapYildiz/aegis-video-detector",
        "revision": "95b71346cec650165e6ad3fb20ed9e80f4b6702a",
        "license": "MIT",
        "destination": "upstream/aegis-motion",
        "files": ("README.md", "checkpoint_best.pt"),
    },
    {
        "name": "faster_whisper_tiny",
        "repo": "Systran/faster-whisper-tiny",
        "revision": "d90ca5fe260221311c53c58e660288d3deb8d356",
        "license": "MIT",
        "destination": "upstream/faster-whisper-tiny",
        "files": ("README.md", "config.json", "model.bin", "tokenizer.json", "vocabulary.txt"),
    },
    {
        "name": "ollama_qwen_gguf",
        "repo": "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        # Resolve this known commit prefix to the full immutable SHA and record it.
        "revision": "91cad51",
        "license": "Apache-2.0",
        "destination": "upstream/qwen2.5-1.5b-instruct-gguf",
        "files": ("README.md", "LICENSE", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    },
)

EXTERNAL_MODELS: tuple[dict[str, str], ...] = (
    {
        "name": "openai_clip_vit_b32",
        "repo": "openai/clip-vit-base-patch32",
        "revision": "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268",
        "reason": "Public upstream is pinned, but its HF weight license is not explicit; do not re-host it.",
        "usedBy": "standalone spatial fusion and Temporal MoE frozen frame encoder",
    },
)


class CompleteStackError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def import_base_publisher() -> Any:
    if not BASE_PUBLISHER_PATH.is_file():
        raise CompleteStackError(f"Base publisher is missing: {BASE_PUBLISHER_PATH}")
    spec = importlib.util.spec_from_file_location("orislop_base_publisher", BASE_PUBLISHER_PATH)
    if spec is None or spec.loader is None:
        raise CompleteStackError("Could not import the base Orislop publisher")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def safe_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def fingerprint_map(metrics: Mapping[str, Any]) -> dict[str, str]:
    cache = metrics.get("cache")
    raw = cache.get("expert_checkpoint_fingerprints") if isinstance(cache, Mapping) else None
    if not isinstance(raw, Mapping):
        raise CompleteStackError("Promoted metrics have no expert_checkpoint_fingerprints")
    result = {str(name): str(value).lower() for name, value in raw.items()}
    invalid = [name for name, value in result.items() if HASH_RE.fullmatch(value) is None]
    if invalid:
        raise CompleteStackError("Invalid expert fingerprints: " + ", ".join(sorted(invalid)))
    return result


def find_required_artifact(run_root: Path, relatives: Sequence[str], label: str) -> Path:
    for relative in relatives:
        candidate = run_root / relative
        if candidate.is_file():
            return candidate
    names = {Path(relative).name for relative in relatives}
    matches = [path for path in run_root.rglob("*") if path.is_file() and path.name in names]
    if matches:
        return max(matches, key=lambda path: path.stat().st_mtime)
    raise CompleteStackError(f"Selected promoted run has no {label}; searched {list(relatives)!r}")


def checkpoint_payload(path: Path) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:
        raise CompleteStackError("PyTorch is required to verify the trained checkpoints") from error
    try:
        payload = torch.load(str(path), map_location="cpu", weights_only=True, mmap=True)
    except TypeError:
        payload = torch.load(str(path), map_location="cpu", weights_only=True)
    if not isinstance(payload, Mapping):
        raise CompleteStackError(f"Checkpoint is not a mapping: {path}")
    return payload


def model_state(path: Path) -> dict[str, Any]:
    import torch

    payload: Mapping[str, Any] = checkpoint_payload(path)
    for key in ("model_state", "model", "state_dict"):
        nested = payload.get(key)
        if isinstance(nested, Mapping):
            payload = nested
            break
    state = {str(key): value for key, value in payload.items() if torch.is_tensor(value)}
    if not state:
        raise CompleteStackError(f"Checkpoint contains no model tensors: {path}")
    return state


def assert_state_equal(expected: Mapping[str, Any], actual: Mapping[str, Any], label: str) -> None:
    import torch

    if set(expected) != set(actual):
        missing = sorted(set(expected) - set(actual))[:8]
        extra = sorted(set(actual) - set(expected))[:8]
        raise CompleteStackError(f"{label} state keys differ; missing={missing}, extra={extra}")
    for key in expected:
        left, right = expected[key], actual[key]
        if left.shape != right.shape or left.dtype != right.dtype or not torch.equal(left.cpu(), right.cpu()):
            raise CompleteStackError(f"{label} tensor differs from promoted final state: {key}")


def refresh_temporal_manifest(base: Any, package: Path, composition: Mapping[str, Any]) -> None:
    files = {
        path.relative_to(package).as_posix(): sha256_file(path)
        for path in package.rglob("*")
        if path.is_file() and path.name != "artifact_manifest.json"
    }
    weights = next(
        (package / name for name in base.TEMPORAL_WEIGHTS if (package / name).is_file()),
        None,
    )
    if weights is None:
        raise CompleteStackError("Staged temporal package has no weights")
    components = base.temporal_component_status(weights)
    components["spatial"] = any(
        key.startswith("spatial.") for key in base.selected_final_state(weights)
    )
    write_json(package / "artifact_manifest.json", {
        "schemaVersion": 2,
        "artifactType": "orislop-complete-temporal-moe",
        "createdAt": utc_now(),
        "components": components,
        "composition": composition,
        "files": dict(sorted(files.items())),
    })


def augment_temporal_spatial(
    base: Any,
    package: Path,
    spatial_checkpoint: Path,
    expected_sha256: str,
) -> dict[str, Any]:
    import torch
    from safetensors.torch import save_file

    actual = sha256_file(spatial_checkpoint)
    if actual != expected_sha256:
        raise CompleteStackError(
            f"Temporal spatial expert does not match fusion cache: expected={expected_sha256} actual={actual}"
        )
    weights = next((package / name for name in base.TEMPORAL_WEIGHTS if (package / name).is_file()), None)
    if weights is None:
        raise CompleteStackError("Cannot add spatial expert: staged temporal weights are missing")
    state = base.selected_final_state(weights)
    spatial_state = model_state(spatial_checkpoint)
    additions = {f"spatial.stub.{key}": value for key, value in spatial_state.items()}
    collisions = sorted(set(state) & set(additions))
    if collisions:
        raise CompleteStackError(f"Temporal package already has conflicting spatial tensors: {collisions[:8]}")
    state.update(additions)
    state = {
        key: value.detach().cpu().contiguous()
        for key, value in state.items()
        if torch.is_tensor(value)
    }
    output = package / "final_model.safetensors"
    temporary = output.with_suffix(output.suffix + ".tmp")
    save_file(state, str(temporary))
    os.replace(temporary, output)
    old_pt = package / "final_model.pt"
    if old_pt.is_file():
        old_pt.unlink()
    config_path = package / "config.json"
    config = base.read_json(config_path)
    config["use_spatial"] = True
    config["spatial_stub"] = False
    config["spatial_checkpoint"] = None
    config["complete_stack_contract"] = {
        "temporalSpatialExpert": "embedded as spatial.stub.*",
        "sourceSha256": actual,
        "fusionFingerprintMatched": True,
    }
    write_json(config_path, config)
    receipt = {
        "mode": "promoted-temporal-plus-fingerprint-matched-spatial-expert",
        "source": str(spatial_checkpoint),
        "sourceSha256": actual,
        "tensorCount": len(spatial_state),
        "outputSha256": sha256_file(output),
    }
    write_json(package / "SPATIAL_COMPOSITION_RECEIPT.json", receipt)
    refresh_temporal_manifest(base, package, receipt)
    return receipt


def prove_phase2_matches_promoted(base: Any, package: Path, fusion: Path, calibration: Path) -> str:
    weights = next((package / name for name in base.TEMPORAL_WEIGHTS if (package / name).is_file()), None)
    if weights is None:
        raise CompleteStackError("Cannot verify AV phase two without temporal weights")
    final_state = base.selected_final_state(weights)
    final_fusion = {key[len("fusion."):]: value for key, value in final_state.items() if key.startswith("fusion.")}
    final_temperature = {
        key[len("temperature."):]: value
        for key, value in final_state.items()
        if key.startswith("temperature.")
    }
    assert_state_equal(final_fusion, model_state(fusion), "AV-aware fusion")
    assert_state_equal(final_temperature, model_state(calibration), "AV-aware calibration")
    target = str(checkpoint_payload(calibration).get("expert") or "")
    if not target:
        raise CompleteStackError("Calibration checkpoint has no expert target contract")
    return target


def copy_verified(source: Path, destination: Path, expected: str | None = None) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    digest = sha256_file(destination)
    if expected and digest != expected:
        raise CompleteStackError(
            f"Copied artifact hash mismatch: {source} expected={expected} actual={digest}"
        )
    return digest


def download_yunet(destination: Path) -> tuple[str, dict[str, Any]]:
    """Download the canonical YuNet LFS object and verify it before use."""
    from urllib.request import Request, urlopen

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    print(f"[yunet] downloading OpenCV Zoo@{YUNET_GITHUB_COMMIT}", flush=True)
    try:
        request = Request(YUNET_URL, headers={"User-Agent": "orislop-complete-stack/9"})
        digest = hashlib.sha256()
        total = 0
        with urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                output.write(block)
                digest.update(block)
                total += len(block)
        actual = digest.hexdigest()
        if total != YUNET_BYTES or actual != YUNET_SHA256:
            raise CompleteStackError(
                "YuNet integrity mismatch: "
                f"expected_bytes={YUNET_BYTES} actual_bytes={total} "
                f"expected_sha256={YUNET_SHA256} actual_sha256={actual}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"[yunet] verified bytes={YUNET_BYTES} sha256={YUNET_SHA256}", flush=True)
    return YUNET_SHA256, {
        "source": YUNET_URL,
        "sourceRevision": YUNET_GITHUB_COMMIT,
        "sourceSha256": YUNET_SHA256,
        "sourceBytes": YUNET_BYTES,
        "license": "MIT",
    }


def stage_orislop_models(
    base: Any,
    selected: Any,
    stage: Path,
) -> dict[str, Any]:
    run_root = selected.path.parent.parent
    fingerprints = fingerprint_map(selected.metrics)
    for required in ("spatial", "lip_sync"):
        if required not in fingerprints:
            raise CompleteStackError(f"Fusion cache does not fingerprint required expert: {required}")

    spatial_temporal = find_required_artifact(
        run_root,
        ("spatial/spatial_best.pt", "retrain_attempts/spatial/spatial_best.pt"),
        "temporal spatial expert",
    )
    av_model = find_required_artifact(
        run_root,
        (
            "av_joint/export/orislop_av_joint_v1.ts",
            "retrain_attempts/lip_sync/export/orislop_av_joint_v1.ts",
            "retrain_attempts/lip_sync/av_joint/export/orislop_av_joint_v1.ts",
        ),
        "joint AV TorchScript model",
    )
    av_metadata = find_required_artifact(
        run_root,
        (
            "av_joint/export/orislop_av_joint_v1.json",
            "retrain_attempts/lip_sync/export/orislop_av_joint_v1.json",
            "retrain_attempts/lip_sync/av_joint/export/orislop_av_joint_v1.json",
        ),
        "joint AV metadata",
    )
    phase2_fusion = find_required_artifact(
        run_root,
        ("temporal/checkpoints/stage2_fusion_best.pt",),
        "stage-two fusion checkpoint",
    )
    phase2_calibration = find_required_artifact(
        run_root,
        ("temporal/checkpoints/stage3_calibration.pt",),
        "stage-three calibration checkpoint",
    )
    drive_inputs = {
        path.resolve()
        for path in (
            *selected.path.rglob("*"),
            *(selected.path.parent / "checkpoints").glob("stage1_*_best.pt"),
            spatial_temporal,
            av_model,
            av_metadata,
            phase2_fusion,
            phase2_calibration,
        )
        if path.is_file()
    }
    drive_hashes_before = {str(path): sha256_file(path) for path in sorted(drive_inputs)}
    if sha256_file(av_model) != fingerprints["lip_sync"]:
        raise CompleteStackError("Joint AV artifact does not match the lip_sync fingerprint used by fusion")

    temporal_root = stage / "orislop" / "temporal"
    package, _, temporal_components = base.copy_temporal_stage(selected, temporal_root)
    # The base delta composer keeps raw copied checkpoints two directories above
    # the package. In this nested all-in-one layout that scratch directory would
    # otherwise land inside the upload tree. Remove only this ephemeral local
    # composition cache; the Drive originals are never a deletion target.
    composition_inputs = stage / "orislop" / ".composition-inputs"
    if composition_inputs.is_dir():
        shutil.rmtree(composition_inputs)
    spatial_receipt = augment_temporal_spatial(
        base,
        package,
        spatial_temporal,
        fingerprints["spatial"],
    )
    calibration_target = prove_phase2_matches_promoted(
        base,
        package,
        phase2_fusion,
        phase2_calibration,
    )

    yunet_path = stage / "orislop" / "av" / "face_detection_yunet_2023mar.onnx"
    yunet_sha, yunet_source = download_yunet(yunet_path)
    av_dir = stage / "orislop" / "av"
    phase2_dir = temporal_root / "phase2_av"
    staged_av = av_dir / "orislop_av_joint_v1.ts"
    staged_metadata = av_dir / "orislop_av_joint_v1.json"
    staged_fusion = phase2_dir / "stage2_temporal_av_fusion.pt"
    staged_calibration = phase2_dir / "stage3_temporal_av_calibration.pt"
    hashes = {
        "model": copy_verified(av_model, staged_av, fingerprints["lip_sync"]),
        "yunet": yunet_sha,
        "phase2Fusion": copy_verified(phase2_fusion, staged_fusion),
        "phase2Calibration": copy_verified(phase2_calibration, staged_calibration),
    }
    metadata = base.read_json(av_metadata)
    metadata.update({
        "sha256": hashes["model"],
        "yunetSha256": hashes["yunet"],
        "phase2FusionSha256": hashes["phase2Fusion"],
        "phase2CalibrationSha256": hashes["phase2Calibration"],
        "phase2CalibrationTarget": calibration_target,
        "integrityVerified": True,
        "completeStackProof": {
            "fusionStateEqualsPromotedPackage": True,
            "calibrationStateEqualsPromotedPackage": True,
            "lipSyncFingerprintMatched": True,
            "spatialFingerprintMatched": True,
        },
        "yunetSource": yunet_source,
    })
    write_json(staged_metadata, metadata)

    if not STANDALONE_SPATIAL.is_file():
        raise CompleteStackError(f"Standalone spatial checkpoint is missing: {STANDALONE_SPATIAL}")
    standalone_destination = stage / "orislop" / "spatial" / "standalone" / STANDALONE_SPATIAL.name
    standalone_sha = copy_verified(STANDALONE_SPATIAL, standalone_destination)
    metrics_source = STANDALONE_SPATIAL.with_suffix(".metrics.json")
    if metrics_source.is_file():
        copy_verified(metrics_source, standalone_destination.with_suffix(".metrics.json"))

    if not TRAINING_BUNDLE.is_file():
        raise CompleteStackError(f"v8 training bundle is missing: {TRAINING_BUNDLE}")
    training_sha = copy_verified(
        TRAINING_BUNDLE,
        stage / "training" / "orislop_retrain_sigkill_safe_v8.pyz",
    )
    return {
        "selected": selected.public(),
        "runRoot": str(run_root),
        "temporalComponentsBeforeSpatial": temporal_components,
        "spatialComposition": spatial_receipt,
        "av": {
            "sourceModel": safe_relative(av_model, run_root),
            "sourceMetadata": safe_relative(av_metadata, run_root),
            "phase2Fusion": safe_relative(phase2_fusion, run_root),
            "phase2Calibration": safe_relative(phase2_calibration, run_root),
            "calibrationTarget": calibration_target,
            "hashes": hashes,
        },
        "standaloneSpatialSha256": standalone_sha,
        "trainingBundleSha256": training_sha,
        "driveSourceHashesBefore": drive_hashes_before,
    }


def copy_runtime_source(stage: Path) -> None:
    destination = stage / "runtime" / "source"
    ignored = shutil.ignore_patterns(
        ".git",
        ".cache",
        ".ipynb_checkpoints",
        "__pycache__",
        "*.pyc",
        "node_modules",
    )
    shutil.copytree(SOURCE_ROOT, destination, ignore=ignored)


def resolve_upstream_revisions(api: Any) -> dict[str, str]:
    """Resolve and inventory every upstream file before large downloads begin."""
    resolved_revisions: dict[str, str] = {}
    print(f"[preflight] checking {len(UPSTREAM_MODELS)} pinned upstream repositories", flush=True)
    for model in UPSTREAM_MODELS:
        info = api.model_info(repo_id=model["repo"], revision=model["revision"])
        resolved = str(getattr(info, "sha", "") or "").lower()
        if IMMUTABLE_REVISION.fullmatch(resolved) is None:
            raise CompleteStackError(f"Could not resolve immutable revision for {model['repo']}")
        available = {
            str(getattr(item, "rfilename", "") or "")
            for item in (getattr(info, "siblings", None) or ())
        }
        missing = sorted(set(model["files"]) - available)
        if missing:
            raise CompleteStackError(
                f"Pinned upstream repository {model['repo']}@{resolved} is missing files: {missing}"
            )
        resolved_revisions[str(model["repo"])] = resolved
        print(
            f"[preflight] verified {model['repo']}@{resolved}; files={len(model['files'])}",
            flush=True,
        )
    return resolved_revisions


def download_upstream(
    stage: Path,
    token: str | None,
    resolved_revisions: Mapping[str, str],
) -> list[dict[str, Any]]:
    from huggingface_hub import hf_hub_download

    inventory: list[dict[str, Any]] = []
    cache = stage.parent / ".hf-download-cache"
    for model in UPSTREAM_MODELS:
        resolved = str(resolved_revisions.get(str(model["repo"])) or "")
        if IMMUTABLE_REVISION.fullmatch(resolved) is None:
            raise CompleteStackError(f"Missing preflight revision for {model['repo']}")
        destination = stage / str(model["destination"])
        files: dict[str, dict[str, Any]] = {}
        print(f"[upstream] {model['repo']}@{resolved}", flush=True)
        for filename in model["files"]:
            cached = Path(hf_hub_download(
                repo_id=model["repo"],
                filename=filename,
                revision=resolved,
                token=token,
                cache_dir=str(cache),
            ))
            target = destination / filename
            digest = copy_verified(cached, target)
            files[filename] = {"sha256": digest, "bytes": target.stat().st_size}
        inventory.append({
            "name": model["name"],
            "repo": model["repo"],
            "requestedRevision": model["revision"],
            "resolvedRevision": resolved,
            "license": model["license"],
            "destination": model["destination"],
            "files": files,
        })
    return inventory


def build_manifest(stage: Path, inventory: Mapping[str, Any]) -> dict[str, Any]:
    write_json(stage / "MODEL_INVENTORY.json", inventory)
    write_json(stage / "EXTERNAL_DEPENDENCIES.json", {
        "schemaVersion": 1,
        "dependencies": list(EXTERNAL_MODELS),
    })
    files = {
        path.relative_to(stage).as_posix(): {
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }
        for path in stage.rglob("*")
        if path.is_file() and path.name != "artifact_manifest.json"
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "orislop-complete-runnable-stack",
        "createdAt": utc_now(),
        "completeOffline": False,
        "externalRuntimeDependencies": [item["name"] for item in EXTERNAL_MODELS],
        "fileCount": len(files),
        "totalBytes": sum(item["bytes"] for item in files.values()),
        "files": dict(sorted(files.items())),
    }
    write_json(stage / "artifact_manifest.json", payload)
    return payload


def verify_manifest(stage: Path) -> None:
    payload = json.loads((stage / "artifact_manifest.json").read_text(encoding="utf-8"))
    for relative, record in payload["files"].items():
        candidate = (stage / relative).resolve()
        if not candidate.is_relative_to(stage.resolve()) or not candidate.is_file():
            raise CompleteStackError(f"Manifest file is missing or unsafe: {relative}")
        actual = sha256_file(candidate)
        if actual != record["sha256"] or candidate.stat().st_size != int(record["bytes"]):
            raise CompleteStackError(f"Release verification failed: {relative}")


def write_readme(stage: Path, repo_id: str) -> None:
    (stage / "README.md").write_text(
        f"""---
library_name: pytorch
tags:
- deepfake-detection
- video-classification
- audio-visual
- mixture-of-experts
---

# Orislop complete runnable stack

This private release combines the promoted Temporal MoE, its fingerprint-matched
temporal spatial expert, the joint AV TorchScript expert, the exact AV-aware
fusion and calibration states, YuNet, the deterministic standalone spatial
detector, redistributable pinned public model weights, the full runtime source,
and the exact v8 retraining bundle.

The release is coherent, but it is intentionally not described as fully
offline: OpenAI CLIP stays pinned to its original upstream repository because
the Hugging Face weight repository does not state an explicit weight license.
`EXTERNAL_DEPENDENCIES.json` records that immutable dependency.

Repository: `{repo_id}`

Run `runtime/source/scripts/materialize_complete_stack.py` to download and
verify the release and generate the model-only environment file. Automatic
actions remain disabled unless the AV and cloud-heavy release gates genuinely
pass; packaging files does not invent missing commercial validation.
""",
        encoding="utf-8",
    )


def upload_release(api: Any, repo_id: str, stage: Path, private: bool) -> str:
    if re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo_id) is None:
        raise CompleteStackError(f"Invalid Hugging Face repo ID: {repo_id}")
    print(f"[upload] creating/verifying {'private' if private else 'public'} repo {repo_id}", flush=True)
    api.create_repo(repo_id=repo_id, repo_type="model", private=private, exist_ok=True)
    print("[upload] streaming verified release; rerunning resumes/deduplicates committed files", flush=True)
    api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=str(stage),
        commit_message="Publish coherent Orislop complete stack",
        ignore_patterns=[".cache/**", "**/__pycache__/**", "**/*.pyc"],
    )
    print("[upload] transfer complete; resolving immutable model revision", flush=True)
    info = api.model_info(repo_id=repo_id)
    revision = str(info.sha or "").lower()
    if IMMUTABLE_REVISION.fullmatch(revision) is None:
        raise CompleteStackError("HF upload completed but no immutable revision was returned")
    return revision


def resolve_training_dataset(api: Any) -> dict[str, Any]:
    """Best-effort dataset pinning that must not block model publication.

    The prepared dataset is provenance metadata, not an inference dependency.
    Try both public Hugging Face API entrypoints because notebook runtimes can
    have different huggingface_hub versions.  The HfApi instance already owns
    the token, so method-level token arguments are intentionally unnecessary.
    """
    print(f"[dataset] resolving {TRAINING_DATASET_REPO}", flush=True)
    attempts = (
        ("dataset_info", lambda: api.dataset_info(repo_id=TRAINING_DATASET_REPO, timeout=30)),
        (
            "repo_info(dataset)",
            lambda: api.repo_info(
                repo_id=TRAINING_DATASET_REPO,
                repo_type="dataset",
                timeout=30,
            ),
        ),
    )
    errors: list[str] = []
    for label, lookup in attempts:
        try:
            info = lookup()
        except Exception as error:  # Network/auth/API drift: preserve diagnostics.
            message = f"{label}: {type(error).__name__}: {error}"
            errors.append(message)
            print(f"[dataset] {message}", flush=True)
            continue
        revision = str(getattr(info, "sha", "") or "").lower()
        if IMMUTABLE_REVISION.fullmatch(revision):
            print(f"[dataset] pinned {TRAINING_DATASET_REPO}@{revision}", flush=True)
            return {
                "repo": TRAINING_DATASET_REPO,
                "revision": revision,
                "revisionResolved": True,
                "resolutionMethod": label,
                "resolutionErrors": errors,
            }
        message = f"{label}: response did not include a full 40-character commit SHA"
        errors.append(message)
        print(f"[dataset] {message}", flush=True)

    print(
        "[dataset] WARNING: dataset revision could not be pinned; "
        "continuing because training data is not copied into or required by the inference release",
        flush=True,
    )
    return {
        "repo": TRAINING_DATASET_REPO,
        "revision": None,
        "revisionResolved": False,
        "resolutionMethod": None,
        "resolutionErrors": errors,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive-root", default="/content/drive/MyDrive/orislop-checkpoints")
    parser.add_argument("--repo", default="gonnerthetooner/orislop-complete-stack-v1")
    parser.add_argument("--candidate-index", type=int, default=None)
    parser.add_argument("--public", action="store_true", help="Create a public repo; private is the safe default")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-upstream", action="store_true", help="Developer test only; release stays incomplete")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    drive_root = Path(args.drive_root).expanduser().resolve()
    if not drive_root.is_dir():
        raise CompleteStackError(f"Drive checkpoint root does not exist: {drive_root}")
    if not args.yes and not args.dry_run:
        answer = input(f"Build and upload complete private stack to {args.repo}? [y/N]: ").strip().lower()
        if answer not in {"y", "yes"}:
            raise CompleteStackError("Cancelled")
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise CompleteStackError("Install huggingface-hub before running the publisher") from error
    token = os.environ.get("HF_TOKEN") or None
    api = HfApi(token=token)
    base = import_base_publisher()
    print(f"[discover] scanning Drive read-only: {drive_root}", flush=True)
    candidates, _, receipts = base.discover_models(drive_root)
    selected = base.choose_candidate(candidates, args.candidate_index, True)
    print(f"[select] {selected.path}", flush=True)
    training_dataset = resolve_training_dataset(api)
    upstream_revisions = {} if args.skip_upstream else resolve_upstream_revisions(api)

    with tempfile.TemporaryDirectory(prefix="orislop-complete-stack-") as temporary:
        temp_root = Path(temporary)
        stage = temp_root / "release"
        stage.mkdir()
        orislop = stage_orislop_models(base, selected, stage)
        drive_before = orislop.pop("driveSourceHashesBefore")
        copy_runtime_source(stage)
        upstream = (
            []
            if args.skip_upstream
            else download_upstream(stage, token, upstream_revisions)
        )
        inventory = {
            "schemaVersion": 1,
            "createdAt": utc_now(),
            "orislop": orislop,
            "trainingDataset": {
                **training_dataset,
                "format": "prepared NPZ members in tar shards",
                "copiedIntoModelRepo": False,
                "reason": "Training data is already a versioned HF dataset and is not required for inference.",
            },
            "upstream": upstream,
            "external": list(EXTERNAL_MODELS),
            "promotionReceiptsDiscovered": [str(path) for path in receipts],
            "safety": {
                "driveReadOnly": True,
                "driveFilesDeleted": 0,
                "driveFilesModified": 0,
            },
        }
        write_readme(stage, args.repo)
        manifest = build_manifest(stage, inventory)
        verify_manifest(stage)
        drive_after = {path: sha256_file(Path(path)) for path in drive_before}
        if drive_before != drive_after:
            raise CompleteStackError("A Drive source artifact changed while the copy-only release was built")
        print(json.dumps({
            "status": "verified-local-release",
            "files": manifest["fileCount"],
            "bytes": manifest["totalBytes"],
            "gib": round(manifest["totalBytes"] / 1024**3, 3),
            "external": [item["name"] for item in EXTERNAL_MODELS],
        }, indent=2), flush=True)
        if args.dry_run:
            print("[dry-run] upload skipped", flush=True)
            return 0
        revision = upload_release(api, args.repo, stage, private=not args.public)
        result = {
            "status": "uploaded-and-pinned",
            "repo": args.repo,
            "revision": revision,
            "private": not args.public,
            "manifestSha256": sha256_file(stage / "artifact_manifest.json"),
            "files": manifest["fileCount"],
            "bytes": manifest["totalBytes"],
            "driveReadOnlyVerified": drive_before == drive_after,
        }
        print(json.dumps(result, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as error:
        print(
            f"[fatal] {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
        traceback.print_exc()
        print(
            "[fatal] No Drive file was intentionally modified or deleted; "
            "the publisher only reads and hashes Drive sources.",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1)
