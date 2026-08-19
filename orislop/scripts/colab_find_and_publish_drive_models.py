#!/usr/bin/env python3
"""Find promoted Orislop models in Google Drive and publish pinned HF releases.

Designed for Google Colab after Drive is mounted. Discovery is read-only. Only a
small allowlist of deployment artifacts is copied to ephemeral local staging and
uploaded; datasets, optimizer checkpoints, caches, logs, and Drive credentials
are never uploaded.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import traceback
from typing import Any, Iterable, Mapping, Sequence


TEMPORAL_WEIGHTS = ("final_model.safetensors", "final_model.pt")
TEMPORAL_REQUIRED = ("config.json", "metrics.json")
TEMPORAL_OPTIONAL = (
    "threshold.json",
    "PROMOTION_RECEIPT.json",
    "promotion_receipt.json",
)
TEMPORAL_EXPERTS = ("micro", "mid", "long", "extra_long")
TEMPORAL_COMPONENTS = ("micro", "mid", "long", "extra_long", "fusion", "temperature")
AV_MODEL_NAME = "orislop_av_joint_v1.ts"
AV_METADATA_NAME = "orislop_av_joint_v1.json"
YUNET_NAMES = ("face_detection_yunet_2023mar.onnx", "face_detection_yunet.onnx")
AV_FUSION_NAMES = ("stage2_temporal_av_fusion.pt", "stage2_av_fusion.pt")
AV_CALIBRATION_NAMES = ("stage3_temporal_av_calibration.pt", "stage3_av_calibration.pt")
PROMOTION_NAMES = {
    "PROMOTION_RECEIPT.json",
    "promotion_receipt.json",
    "promotion.json",
    "promotion_result.json",
}
PRUNE_DIR_NAMES = {
    ".git",
    ".cache",
    ".ipynb_checkpoints",
    "__pycache__",
    "node_modules",
    "wandb",
    "datasets",
    "dataset",
    "shards",
    "archives",
    "videos",
    "frames",
}
IMMUTABLE_REVISION_RE = re.compile(r"^[0-9a-fA-F]{40,64}$")


class PublishError(RuntimeError):
    pass


@dataclass(frozen=True)
class TemporalCandidate:
    path: Path
    weights: Path
    metrics: dict[str, Any]
    validation_auc: float | None
    promoted: bool
    promotion_receipt: Path | None
    modified_epoch: float
    rank_score: float

    def public(self) -> dict[str, Any]:
        # Keep notebook output and receipts compact. Full metrics remain in the
        # allowlisted metrics.json uploaded with the selected package.
        return {
            "path": str(self.path),
            "weights": str(self.weights),
            "metricsFile": str(self.path / "metrics.json"),
            "validation_auc": self.validation_auc,
            "promoted": self.promoted,
            "promotion_receipt": str(self.promotion_receipt) if self.promotion_receipt else None,
            "modified_epoch": self.modified_epoch,
            "rank_score": self.rank_score,
        }


@dataclass(frozen=True)
class AVBundle:
    model: Path | None
    metadata: Path | None
    yunet: Path | None
    phase2_fusion: Path | None
    phase2_calibration: Path | None

    def complete(self) -> bool:
        return all((self.model, self.metadata, self.yunet, self.phase2_fusion, self.phase2_calibration))

    def missing(self) -> list[str]:
        return [
            name
            for name, value in (
                (AV_MODEL_NAME, self.model),
                (AV_METADATA_NAME, self.metadata),
                (YUNET_NAMES[0], self.yunet),
                (AV_FUSION_NAMES[0], self.phase2_fusion),
                (AV_CALIBRATION_NAMES[0], self.phase2_calibration),
            )
            if value is None
        ]

    def public(self) -> dict[str, str | None]:
        return {
            "model": str(self.model) if self.model else None,
            "metadata": str(self.metadata) if self.metadata else None,
            "yunet": str(self.yunet) if self.yunet else None,
            "phase2_fusion": str(self.phase2_fusion) if self.phase2_fusion else None,
            "phase2_calibration": str(self.phase2_calibration) if self.phase2_calibration else None,
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, required: bool = True) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if required:
            raise PublishError(f"Required JSON file is missing: {path}")
        return {}
    except (OSError, json.JSONDecodeError) as error:
        if required:
            raise PublishError(f"Invalid JSON file {path}: {error}") from error
        return {}
    if not isinstance(payload, dict):
        if required:
            raise PublishError(f"Expected a JSON object: {path}")
        return {}
    return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_new_json(path: Path, payload: Any) -> None:
    """Create a receipt without overwriting any existing Drive object."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file_with_sha256(source: Path, destination: Path) -> str:
    """Copy once from Drive while computing the digest used for provenance."""
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as reader, destination.open("xb") as writer:
        for chunk in iter(lambda: reader.read(16 * 1024 * 1024), b""):
            writer.write(chunk)
            digest.update(chunk)
    shutil.copystat(source, destination)
    return digest.hexdigest()


def flatten_numbers(payload: Any, prefix: str = "") -> dict[str, float]:
    found: dict[str, float] = {}
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            found.update(flatten_numbers(value, name))
    elif isinstance(payload, (int, float)) and not isinstance(payload, bool):
        found[prefix.lower()] = float(payload)
    return found


def validation_auc(metrics: Mapping[str, Any]) -> float | None:
    flattened = flatten_numbers(metrics)
    preferred = (
        "candidate_validation_auc",
        "validation_auc",
        "val_auc",
        "best_validation_auc",
        "selection.validation_auc",
        "auc",
        "test_auc",
    )
    for suffix in preferred:
        candidates = [value for key, value in flattened.items() if key == suffix or key.endswith("." + suffix)]
        for value in candidates:
            if 0.0 <= value <= 1.0:
                return value
    return None


def receipt_target(payload: Mapping[str, Any]) -> str:
    for key in ("model_package", "modelPackage", "candidate", "promoted_package", "promotedPackage"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().replace("\\", "/")
    return ""


def is_promoted_receipt(payload: Mapping[str, Any]) -> bool:
    status = str(payload.get("status") or "").lower()
    return bool(
        status in {"candidate_promoted", "promoted", "complete"}
        or payload.get("promoted") is True
        or payload.get("candidatePromoted") is True
    )


def safe_walk(root: Path, max_directories: int = 200_000) -> tuple[list[Path], list[Path]]:
    """Return interesting files and package directories without reading datasets."""
    interesting_names = {
        *TEMPORAL_WEIGHTS,
        *TEMPORAL_REQUIRED,
        *TEMPORAL_OPTIONAL,
        *PROMOTION_NAMES,
        AV_MODEL_NAME,
        AV_METADATA_NAME,
        *YUNET_NAMES,
        *AV_FUSION_NAMES,
        *AV_CALIBRATION_NAMES,
    }
    interesting_files: list[Path] = []
    package_dirs: list[Path] = []
    visited = 0
    for current, directories, files in os.walk(root, followlinks=False):
        visited += 1
        if visited > max_directories:
            raise PublishError(f"Drive scan exceeded {max_directories:,} directories under {root}")
        directories[:] = [
            name
            for name in directories
            if name not in PRUNE_DIR_NAMES and not name.startswith(".")
        ]
        current_path = Path(current)
        file_names = set(files)
        if (
            current_path.name == "final_model_package"
            or (file_names.intersection(TEMPORAL_WEIGHTS) and set(TEMPORAL_REQUIRED).issubset(file_names))
        ):
            package_dirs.append(current_path)
        interesting_files.extend(current_path / name for name in file_names.intersection(interesting_names))
        if visited % 2_000 == 0:
            print(f"[discover] scanned {visited:,} directories; packages={len(package_dirs)}", flush=True)
    print(f"[discover] finished {root}; directories={visited:,}, packages={len(package_dirs)}", flush=True)
    return interesting_files, package_dirs


def path_matches_receipt(candidate: Path, target: str) -> bool:
    if not target:
        return False
    normalized = candidate.as_posix().rstrip("/")
    target = target.rstrip("/")
    return normalized == target or normalized.endswith(target) or target.endswith(normalized)


def discover_models(root: Path) -> tuple[list[TemporalCandidate], AVBundle, list[Path]]:
    files, package_dirs = safe_walk(root)
    receipts: list[tuple[Path, dict[str, Any]]] = []
    for path in files:
        if path.name in PROMOTION_NAMES:
            payload = read_json(path, required=False)
            if payload:
                receipts.append((path, payload))

    temporal: list[TemporalCandidate] = []
    seen: set[Path] = set()
    for package in package_dirs:
        package = package.resolve()
        if package in seen:
            continue
        seen.add(package)
        if not all((package / name).is_file() for name in TEMPORAL_REQUIRED):
            continue
        weights = next((package / name for name in TEMPORAL_WEIGHTS if (package / name).is_file()), None)
        if weights is None:
            continue
        metrics = read_json(package / "metrics.json", required=False)
        auc = validation_auc(metrics)
        matching_receipts = [
            path
            for path, payload in receipts
            if is_promoted_receipt(payload) and path_matches_receipt(package, receipt_target(payload))
        ]
        embedded_receipt = next(
            (package / name for name in TEMPORAL_OPTIONAL if "receipt" in name.lower() and (package / name).is_file()),
            None,
        )
        receipt = matching_receipts[0] if matching_receipts else embedded_receipt
        path_text = package.as_posix().lower()
        promoted = bool(receipt or "retrain-v2-aggressive" in path_text or "promoted" in path_text)
        modified = max(weights.stat().st_mtime, (package / "metrics.json").stat().st_mtime)
        rank = (10_000.0 if promoted else 0.0) + (auc or 0.0) * 1_000.0 + modified / 1e10
        temporal.append(TemporalCandidate(package, weights, metrics, auc, promoted, receipt, modified, rank))
    temporal.sort(key=lambda item: item.rank_score, reverse=True)

    by_name: dict[str, list[Path]] = {}
    for path in files:
        by_name.setdefault(path.name, []).append(path.resolve())

    newest_av = max(by_name.get(AV_MODEL_NAME, []), key=lambda path: path.stat().st_mtime, default=None)
    anchor = temporal[0].path if temporal else newest_av or root

    def common_depth(path: Path) -> int:
        try:
            common = Path(os.path.commonpath([str(anchor), str(path)]))
            return len(common.parts)
        except ValueError:
            return 0

    def closest(names: Iterable[str]) -> Path | None:
        candidates = [path for name in names for path in by_name.get(name, [])]
        return max(candidates, key=lambda path: (common_depth(path), path.stat().st_mtime)) if candidates else None

    av_model = closest((AV_MODEL_NAME,))
    av_metadata = av_model.with_name(AV_METADATA_NAME) if av_model and av_model.with_name(AV_METADATA_NAME).is_file() else None
    if av_metadata is None:
        av_metadata = closest((AV_METADATA_NAME,))
    bundle = AVBundle(
        model=av_model,
        metadata=av_metadata,
        yunet=closest(YUNET_NAMES),
        phase2_fusion=closest(AV_FUSION_NAMES),
        phase2_calibration=closest(AV_CALIBRATION_NAMES),
    )
    return temporal, bundle, [path for path, _ in receipts]


def temporal_component_keys(weights: Path) -> set[str]:
    if weights.suffix == ".safetensors":
        # Safetensors keeps a length-prefixed JSON index before tensor bytes. We
        # only need names here, so parsing the bounded header avoids allocating
        # hundreds of megabytes of tensors just to prove component presence.
        with weights.open("rb") as source:
            header_size_bytes = source.read(8)
            if len(header_size_bytes) != 8:
                raise PublishError(f"Truncated Safetensors header: {weights}")
            header_size = int.from_bytes(header_size_bytes, byteorder="little", signed=False)
            if header_size < 2 or header_size > 128 * 1024 * 1024:
                raise PublishError(f"Invalid Safetensors header size {header_size}: {weights}")
            raw_header = source.read(header_size)
            if len(raw_header) != header_size:
                raise PublishError(f"Truncated Safetensors index: {weights}")
        try:
            header = json.loads(raw_header.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PublishError(f"Invalid Safetensors index {weights}: {error}") from error
        if not isinstance(header, Mapping):
            raise PublishError(f"Safetensors index is not an object: {weights}")
        data_size = weights.stat().st_size - 8 - header_size
        keys: set[str] = set()
        for key, metadata in header.items():
            if key == "__metadata__":
                continue
            if not isinstance(metadata, Mapping):
                raise PublishError(f"Invalid Safetensors tensor metadata for {key}: {weights}")
            offsets = metadata.get("data_offsets")
            if (
                not isinstance(offsets, Sequence)
                or isinstance(offsets, (str, bytes))
                or len(offsets) != 2
                or not all(isinstance(value, int) for value in offsets)
                or offsets[0] < 0
                or offsets[1] < offsets[0]
                or offsets[1] > data_size
            ):
                raise PublishError(f"Invalid Safetensors offsets for {key}: {weights}")
            keys.add(str(key))
        if not keys:
            raise PublishError(f"Safetensors package contains no tensor keys: {weights}")
        return keys
    try:
        import torch
    except ImportError as error:
        raise PublishError("PyTorch is required to inspect final_model.pt") from error
    try:
        payload = torch.load(str(weights), map_location="cpu", weights_only=True, mmap=True)
    except TypeError:
        payload = torch.load(str(weights), map_location="cpu", weights_only=True)
    if isinstance(payload, Mapping) and isinstance(payload.get("model"), Mapping):
        payload = payload["model"]
    elif isinstance(payload, Mapping) and isinstance(payload.get("state_dict"), Mapping):
        payload = payload["state_dict"]
    if not isinstance(payload, Mapping):
        raise PublishError(f"Temporal weights do not contain a state dictionary: {weights}")
    return {str(key) for key in payload}


def temporal_component_status(weights: Path) -> dict[str, bool]:
    keys = temporal_component_keys(weights)
    status = {name: any(key.startswith(name + ".") for key in keys) for name in TEMPORAL_COMPONENTS}
    return status


def verify_temporal_components(candidate: TemporalCandidate) -> dict[str, bool]:
    status = temporal_component_status(candidate.weights)
    missing = [name for name, present in status.items() if not present]
    if missing:
        raise PublishError(
            f"Selected temporal package is not the full promoted MoE; missing components: {', '.join(missing)}"
        )
    return status


def expected_expert_fingerprints(candidate: TemporalCandidate) -> dict[str, str]:
    cache = candidate.metrics.get("cache")
    fingerprints = cache.get("expert_checkpoint_fingerprints") if isinstance(cache, Mapping) else None
    if not isinstance(fingerprints, Mapping):
        raise PublishError(
            "The promoted fusion package is a delta but metrics.json has no cache expert fingerprints"
        )
    result = {name: str(fingerprints.get(name) or "").lower() for name in TEMPORAL_EXPERTS}
    invalid = [name for name, value in result.items() if re.fullmatch(r"[0-9a-f]{64}", value) is None]
    if invalid:
        raise PublishError(
            "The promoted fusion package lacks valid operational checkpoint fingerprints for: "
            + ", ".join(invalid)
        )
    return result


def torch_state_dict(path: Path, *, state_key: str | None = None) -> dict[str, Any]:
    try:
        import torch
    except ImportError as error:
        raise PublishError("PyTorch is required to compose the promoted Temporal MoE") from error
    try:
        payload = torch.load(str(path), map_location="cpu", weights_only=True, mmap=True)
    except TypeError:
        payload = torch.load(str(path), map_location="cpu", weights_only=True)
    if state_key is not None:
        if not isinstance(payload, Mapping) or not isinstance(payload.get(state_key), Mapping):
            raise PublishError(f"Checkpoint has no {state_key!r} state dictionary: {path}")
        payload = payload[state_key]
    elif isinstance(payload, Mapping) and isinstance(payload.get("model"), Mapping):
        payload = payload["model"]
    elif isinstance(payload, Mapping) and isinstance(payload.get("state_dict"), Mapping):
        payload = payload["state_dict"]
    if not isinstance(payload, Mapping) or not payload:
        raise PublishError(f"Checkpoint contains no state dictionary: {path}")
    tensors = {str(key): value for key, value in payload.items() if torch.is_tensor(value)}
    if not tensors:
        raise PublishError(f"Checkpoint state dictionary contains no tensors: {path}")
    return tensors


def selected_final_state(path: Path) -> dict[str, Any]:
    if path.suffix == ".safetensors":
        try:
            from safetensors.torch import load_file
        except ImportError as error:
            raise PublishError("Install safetensors before composing the temporal release") from error
        return {str(key): value for key, value in load_file(str(path), device="cpu").items()}
    return torch_state_dict(path)


def compose_promoted_temporal_delta(
    candidate: TemporalCandidate,
    package: Path,
) -> tuple[Path, dict[str, Any]]:
    """Compose the promoted fusion delta with its exact operational experts.

    The weakest-first retrainer intentionally writes only fusion+temperature to
    final_model_package after cached-fusion calibration. Its four operational
    stage-one checkpoints live beside that package. The cache metrics pin their
    SHA-256 values, allowing a deterministic release without mixing baselines.
    """
    selected_status = temporal_component_status(candidate.weights)
    if not selected_status["fusion"] or not selected_status["temperature"]:
        raise PublishError(
            "The promoted delta must contain both fusion and temperature before experts can be composed"
        )
    unexpected_missing = [
        name for name in TEMPORAL_COMPONENTS
        if not selected_status[name] and name not in TEMPORAL_EXPERTS
    ]
    if unexpected_missing:
        raise PublishError("Promoted temporal delta is missing: " + ", ".join(unexpected_missing))

    run_root = candidate.path.parent.parent
    if package.resolve().is_relative_to(run_root.resolve()):
        raise PublishError(
            "Safety invariant failed: composed output staging resolved inside the Drive training run"
        )
    checkpoint_root = candidate.path.parent / "checkpoints"
    expected = expected_expert_fingerprints(candidate)
    # Keep raw composition inputs outside the repository upload tree. The
    # enclosing TemporaryDirectory removes them after the run; Drive is never a
    # cleanup target.
    local_checkpoints = package.parent.parent / ".composition-inputs"
    state = {
        key: value
        for key, value in selected_final_state(candidate.weights).items()
        if key.startswith("fusion.") or key.startswith("temperature.")
    }
    sources: dict[str, Any] = {}
    for expert in TEMPORAL_EXPERTS:
        source = checkpoint_root / f"stage1_{expert}_best.pt"
        if not source.is_file():
            raise PublishError(f"Promoted operational checkpoint is missing: {source}")
        local = local_checkpoints / source.name
        actual = copy_file_with_sha256(source, local)
        if actual != expected[expert]:
            raise PublishError(
                f"Operational {expert} checkpoint fingerprint mismatch: "
                f"expected={expected[expert]} actual={actual} path={source}"
            )
        expert_state = torch_state_dict(local, state_key="model_state")
        collisions = [f"{expert}.{key}" for key in expert_state if f"{expert}.{key}" in state]
        if collisions:
            raise PublishError(f"Duplicate {expert} tensor keys while composing: {collisions[:8]}")
        state.update({f"{expert}.{key}": value for key, value in expert_state.items()})
        sources[expert] = {
            "checkpoint": source.relative_to(run_root).as_posix(),
            "sha256": actual,
            "tensorCount": len(expert_state),
        }

    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:
        raise PublishError("PyTorch and safetensors are required to save the composed release") from error
    state = {key: value.detach().cpu().contiguous() for key, value in state.items() if torch.is_tensor(value)}
    output = package / "final_model.safetensors"
    temporary = output.with_suffix(output.suffix + f".{os.getpid()}.tmp")
    try:
        save_file(state, str(temporary))
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    components = temporal_component_status(output)
    missing = [name for name, present in components.items() if not present]
    if missing:
        raise PublishError("Composed Temporal MoE is still incomplete: " + ", ".join(missing))
    composition = {
        "schemaVersion": 1,
        "mode": "promoted-fusion-delta-plus-fingerprint-matched-operational-experts",
        "createdAt": utc_now(),
        "selectedDelta": {
            "file": candidate.weights.name,
            "sha256": sha256_file(candidate.weights),
            "components": selected_status,
        },
        "expertSources": sources,
        "output": {
            "file": output.name,
            "sha256": sha256_file(output),
            "tensorCount": len(state),
            "components": components,
        },
    }
    write_json(package / "COMPOSITION_RECEIPT.json", composition)
    return output, composition


def verify_av_contract(bundle: AVBundle) -> None:
    if not bundle.complete():
        raise PublishError("AV release is incomplete: " + ", ".join(bundle.missing()))
    assert bundle.model is not None
    try:
        import torch
    except ImportError as error:
        raise PublishError("PyTorch is required to verify the joint AV TorchScript model") from error
    module = torch.jit.load(str(bundle.model), map_location="cpu")
    if "mouth_tracks" not in str(module.forward.schema):
        raise PublishError("Joint AV TorchScript file lacks the required mouth_tracks input contract")
    for label, checkpoint in (
        ("phase-two fusion", bundle.phase2_fusion),
        ("phase-three calibration", bundle.phase2_calibration),
    ):
        assert checkpoint is not None
        try:
            payload = torch.load(str(checkpoint), map_location="cpu", weights_only=True, mmap=True)
        except TypeError:
            payload = torch.load(str(checkpoint), map_location="cpu", weights_only=True)
        if not isinstance(payload, Mapping) or not payload:
            raise PublishError(f"The {label} checkpoint is empty or malformed: {checkpoint}")


def copy_temporal_stage(candidate: TemporalCandidate, stage_root: Path) -> tuple[Path, str, dict[str, bool]]:
    selected_components = temporal_component_status(candidate.weights)
    package = stage_root / "final_model_package"
    package.mkdir(parents=True, exist_ok=True)
    selected = [*TEMPORAL_REQUIRED]
    selected.extend(name for name in TEMPORAL_OPTIONAL if (candidate.path / name).is_file())
    for name in dict.fromkeys(selected):
        source = candidate.path / name
        if source.is_file():
            shutil.copy2(source, package / ("PROMOTION_RECEIPT.json" if "receipt" in name.lower() else name))
    if candidate.promotion_receipt and candidate.promotion_receipt.is_file():
        shutil.copy2(candidate.promotion_receipt, package / "PROMOTION_RECEIPT.json")
    if all(selected_components.values()):
        output_weights = package / candidate.weights.name
        shutil.copy2(candidate.weights, output_weights)
        components = selected_components
        composition: dict[str, Any] = {
            "mode": "selected-package-already-self-contained",
            "selectedComponents": selected_components,
        }
    else:
        print(
            "[compose] promoted package is a fusion delta; verifying and adding exact operational experts",
            flush=True,
        )
        output_weights, composition = compose_promoted_temporal_delta(candidate, package)
        components = temporal_component_status(output_weights)
    files = {
        path.relative_to(package).as_posix(): sha256_file(path)
        for path in package.rglob("*")
        if path.is_file() and path.name != "artifact_manifest.json"
    }
    write_json(package / "artifact_manifest.json", {
        "schemaVersion": 1,
        "artifactType": "orislop-promoted-temporal-package",
        "createdAt": utc_now(),
        "components": components,
        "composition": composition,
        "files": dict(sorted(files.items())),
    })
    (stage_root / "README.md").write_text(
        "---\nlibrary_name: pytorch\ntags:\n- deepfake-detection\n- video-classification\n---\n\n"
        "# Orislop promoted Temporal MoE\n\nPinned deployment package containing the promoted "
        "micro, mid, long, extra-long, fusion, and calibration components.\n",
        encoding="utf-8",
    )
    return package, files[output_weights.name], components


def copy_av_stage(bundle: AVBundle, stage_root: Path) -> tuple[dict[str, str], dict[str, Any]]:
    verify_av_contract(bundle)
    assert bundle.model and bundle.metadata and bundle.yunet and bundle.phase2_fusion and bundle.phase2_calibration
    av_dir = stage_root / "av"
    temporal_dir = stage_root / "temporal"
    av_dir.mkdir(parents=True, exist_ok=True)
    temporal_dir.mkdir(parents=True, exist_ok=True)
    staged = {
        "model": av_dir / AV_MODEL_NAME,
        "metadata": av_dir / AV_METADATA_NAME,
        "yunet": av_dir / YUNET_NAMES[0],
        "phase2_fusion": temporal_dir / AV_FUSION_NAMES[0],
        "phase2_calibration": temporal_dir / AV_CALIBRATION_NAMES[0],
    }
    shutil.copy2(bundle.model, staged["model"])
    shutil.copy2(bundle.yunet, staged["yunet"])
    shutil.copy2(bundle.phase2_fusion, staged["phase2_fusion"])
    shutil.copy2(bundle.phase2_calibration, staged["phase2_calibration"])
    hashes = {name: sha256_file(path) for name, path in staged.items() if name != "metadata"}
    metadata = read_json(bundle.metadata)
    metadata.update({
        "sha256": hashes["model"],
        "yunetSha256": hashes["yunet"],
        "phase2FusionSha256": hashes["phase2_fusion"],
        "phase2CalibrationSha256": hashes["phase2_calibration"],
        "phase2CalibrationTarget": str(metadata.get("phase2CalibrationTarget") or "fusion"),
        "integrityVerified": True,
    })
    write_json(staged["metadata"], metadata)
    files = {
        path.relative_to(stage_root).as_posix(): sha256_file(path)
        for path in stage_root.rglob("*")
        if path.is_file() and path.name not in {"artifact_manifest.json", "README.md"}
    }
    write_json(stage_root / "artifact_manifest.json", {
        "schemaVersion": 1,
        "artifactType": "orislop-joint-av-release",
        "createdAt": utc_now(),
        "files": dict(sorted(files.items())),
    })
    (stage_root / "README.md").write_text(
        "---\nlibrary_name: pytorch\ntags:\n- audio-visual\n- deepfake-detection\n---\n\n"
        "# Orislop joint AV deployment release\n\nTorchScript AV model, YuNet, and matching "
        "Temporal MoE phase-two fusion/calibration. Promotion and automatic-action gates remain "
        "defined by `av/orislop_av_joint_v1.json`.\n",
        encoding="utf-8",
    )
    return files, metadata


def upload_stage(api: Any, repo_id: str, stage: Path, *, private: bool, message: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo_id):
        raise PublishError(f"Invalid Hugging Face model repo ID: {repo_id!r}")
    api.create_repo(repo_id=repo_id, repo_type="model", private=private, exist_ok=True)
    staged_files = {
        path.relative_to(stage).as_posix()
        for path in stage.rglob("*")
        if path.is_file()
    }
    remote_files = set(api.list_repo_files(repo_id=repo_id, repo_type="model"))
    temporal_weight_paths = {f"final_model_package/{name}" for name in TEMPORAL_WEIGHTS}
    stale_weight_variants = (remote_files & temporal_weight_paths) - staged_files
    if stale_weight_variants:
        raise PublishError(
            "The target repo contains a conflicting old temporal weight format: "
            + ", ".join(sorted(stale_weight_variants))
            + ". Use a fresh repo ID so deployment cannot select stale weights."
        )
    info = api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=str(stage),
        commit_message=message,
    )
    revision = str(getattr(info, "oid", "") or "")
    if not IMMUTABLE_REVISION_RE.fullmatch(revision):
        raise PublishError(f"Hugging Face upload returned no immutable commit: {info!r}")
    remote = api.model_info(repo_id=repo_id, revision=revision)
    remote_sha = str(getattr(remote, "sha", "") or "")
    if remote_sha and remote_sha != revision:
        raise PublishError(f"HF commit verification mismatch: upload={revision}, model_info={remote_sha}")
    return revision


def choose_candidate(candidates: Sequence[TemporalCandidate], index: int | None, assume_yes: bool) -> TemporalCandidate:
    if not candidates:
        raise PublishError("No valid final_model_package directories were found")
    print("\nTemporal candidates:")
    for position, candidate in enumerate(candidates, start=1):
        print(
            f"  [{position}] promoted={candidate.promoted} val_auc={candidate.validation_auc} "
            f"modified={datetime.fromtimestamp(candidate.modified_epoch).isoformat()}\n"
            f"      {candidate.path}"
        )
    if index is not None:
        if index < 1 or index > len(candidates):
            raise PublishError(f"--candidate-index must be between 1 and {len(candidates)}")
        return candidates[index - 1]
    selected = candidates[0]
    if not assume_yes:
        answer = input(f"\nUpload candidate [1] {selected.path}? [y/N]: ").strip().lower()
        if answer not in {"y", "yes"}:
            raise PublishError("Upload cancelled; rerun with --candidate-index N or --yes")
    return selected


def run_self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="orislop-drive-self-test-") as temporary:
        root = Path(temporary)
        package = root / "orislop-checkpoints" / "candidate" / "temporal" / "final_model_package"
        package.mkdir(parents=True)
        tensors: dict[str, Any] = {}
        data = bytearray()
        for name in TEMPORAL_COMPONENTS:
            start = len(data)
            data.extend(b"\x00\x00\x00\x00")
            tensors[f"{name}.weight"] = {
                "dtype": "F32",
                "shape": [1],
                "data_offsets": [start, len(data)],
            }
        header = json.dumps(tensors, separators=(",", ":")).encode("utf-8")
        (package / "final_model.safetensors").write_bytes(
            len(header).to_bytes(8, byteorder="little") + header + data
        )
        write_json(package / "config.json", {"embedding_dim": 256})
        write_json(package / "metrics.json", {"validation_auc": 0.97})
        write_json(root / "orislop-checkpoints" / "promotion.json", {
            "status": "candidate_promoted",
            "model_package": str(package),
        })
        av = root / "orislop-checkpoints" / "av"
        temporal = root / "orislop-checkpoints" / "av-temporal"
        av.mkdir(parents=True)
        temporal.mkdir(parents=True)
        (av / AV_MODEL_NAME).write_bytes(b"torchscript-placeholder")
        write_json(av / AV_METADATA_NAME, {"promoted": False})
        (av / YUNET_NAMES[0]).write_bytes(b"yunet-placeholder")
        (temporal / AV_FUSION_NAMES[0]).write_bytes(b"fusion-placeholder")
        (temporal / AV_CALIBRATION_NAMES[0]).write_bytes(b"calibration-placeholder")
        candidates, bundle, receipts = discover_models(root / "orislop-checkpoints")
        assert len(candidates) == 1 and candidates[0].promoted
        assert bundle.complete()
        assert len(receipts) == 1
        components = verify_temporal_components(candidates[0])
        assert all(components.values())
        candidate_run = package.parent.parent
        source_before = {
            path.relative_to(candidate_run).as_posix(): sha256_file(path)
            for path in candidate_run.rglob("*")
            if path.is_file()
        }
        stage = root / "stage"
        stage.mkdir()
        copy_temporal_stage(candidates[0], stage)
        source_after = {
            path.relative_to(candidate_run).as_posix(): sha256_file(path)
            for path in candidate_run.rglob("*")
            if path.is_file()
        }
        assert source_after == source_before

        class Result:
            oid = "a" * 40

        class FakeApi:
            def __init__(self) -> None:
                self.uploaded = False

            def create_repo(self, **_: Any) -> None:
                return None

            def list_repo_files(self, **_: Any) -> list[str]:
                return []

            def upload_folder(self, **_: Any) -> Result:
                self.uploaded = True
                return Result()

            def model_info(self, **_: Any) -> Result:
                result = Result()
                result.sha = result.oid
                return result

        fake_api = FakeApi()
        revision = upload_stage(
            fake_api,
            "gonnerthetooner/self-test",
            stage,
            private=True,
            message="self-test",
        )
        assert fake_api.uploaded and revision == "a" * 40
        print(json.dumps({
            "self_test": "passed",
            "drive_source_immutability": "passed",
            "temporal_component_validation": components,
            "mock_upload_revision": revision,
            "candidate": candidates[0].public(),
            "av_bundle": bundle.public(),
        }, indent=2, default=str))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive-root", type=Path, default=Path("/content/drive/MyDrive/orislop-checkpoints"))
    parser.add_argument("--temporal-repo", default="gonnerthetooner/orislop-temporal-moe-promoted-v2")
    parser.add_argument("--av-repo", default="gonnerthetooner/orislop-av-joint")
    parser.add_argument("--candidate-index", type=int, default=None, help="1-based candidate from discovery output")
    parser.add_argument("--public", action="store_true", help="Publish public repos; private is the default")
    parser.add_argument("--yes", action="store_true", help="Select the top promotion-aware candidate without prompting")
    parser.add_argument("--dry-run", action="store_true", help="Discover and validate paths without reading weights or uploading")
    parser.add_argument("--skip-av", action="store_true", help="Publish temporal only even if an AV release is found")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        run_self_test()
        return 0
    print(
        f"[publisher] starting; python={sys.version.split()[0]}; "
        f"drive_root={args.drive_root}; dry_run={args.dry_run}",
        flush=True,
    )
    root = args.drive_root.expanduser().resolve()
    if not root.is_dir():
        raise PublishError(f"Google Drive model root is missing: {root}")
    print(f"[publisher] Drive root resolved and readable: {root}", flush=True)
    candidates, av_bundle, receipts = discover_models(root)
    selected = choose_candidate(candidates, args.candidate_index, args.yes or args.dry_run)
    discovery = {
        "drive_root": str(root),
        "selected_temporal": selected.public(),
        "all_temporal_candidates": [candidate.public() for candidate in candidates],
        "av_bundle": av_bundle.public(),
        "av_complete": av_bundle.complete(),
        "av_missing": av_bundle.missing(),
        "promotion_receipts": [str(path) for path in receipts],
    }
    print("\nDiscovery result:")
    print(json.dumps(discovery, indent=2, default=str))
    if args.dry_run:
        print("\nDRY RUN COMPLETE: nothing was uploaded.")
        return 0

    token = os.environ.get("HF_TOKEN", "").strip() or getpass.getpass("Hugging Face write token: ").strip()
    if not token:
        raise PublishError("A Hugging Face write token is required")
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise PublishError("Install huggingface-hub first") from error
    api = HfApi(token=token)
    identity = api.whoami()
    print(f"[hf] authenticated as {identity.get('name') or identity.get('fullname') or 'unknown'}")
    private = not args.public
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "publishedAt": utc_now(),
        "private": private,
        "driveDiscovery": discovery,
        "temporal": None,
        "av": None,
    }
    receipt_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    receipt_path = root / f"HF_PUBLISH_RECEIPT_{receipt_stamp}.json"

    with tempfile.TemporaryDirectory(prefix="orislop-hf-publish-") as temporary:
        stage_root = Path(temporary)
        temporal_stage = stage_root / "temporal-repo"
        temporal_stage.mkdir()
        _, weights_sha, components = copy_temporal_stage(selected, temporal_stage)
        av_stage: Path | None = None
        av_files: dict[str, str] | None = None
        av_metadata: dict[str, Any] | None = None
        if not args.skip_av and av_bundle.complete():
            # Validate and stage both releases before the first network write.
            av_stage = stage_root / "av-repo"
            av_stage.mkdir()
            av_files, av_metadata = copy_av_stage(av_bundle, av_stage)
        print(f"[hf] uploading promoted temporal package to {args.temporal_repo}")
        temporal_revision = upload_stage(
            api,
            args.temporal_repo,
            temporal_stage,
            private=private,
            message="Publish promotion-selected Orislop Temporal MoE",
        )
        receipt["temporal"] = {
            "repoId": args.temporal_repo,
            "revision": temporal_revision,
            "subdirectory": "final_model_package",
            "weightsFile": selected.weights.name,
            "weightsSha256": weights_sha,
            "components": components,
            "env": {
                "ORISLOP_TEMPORAL_HF_REPO_ID": args.temporal_repo,
                "ORISLOP_TEMPORAL_HF_REVISION": temporal_revision,
                "ORISLOP_TEMPORAL_HF_SUBDIR": "final_model_package",
                "ORISLOP_TEMPORAL_MODEL_SHA256": weights_sha,
                "ORISLOP_TEMPORAL_ROLLOUT": "corroborated",
            },
        }
        temporal_receipt_path = root / f"HF_PUBLISH_TEMPORAL_RECEIPT_{receipt_stamp}.json"
        write_new_json(temporal_receipt_path, receipt)

        if av_stage is not None and av_files is not None and av_metadata is not None:
            print(f"[hf] uploading complete AV release to {args.av_repo}")
            av_revision = upload_stage(
                api,
                args.av_repo,
                av_stage,
                private=private,
                message="Publish complete Orislop joint AV deployment release",
            )
            receipt["av"] = {
                "repoId": args.av_repo,
                "revision": av_revision,
                "files": av_files,
                "releaseGatePassed": bool((av_metadata.get("releaseGate") or {}).get("passed")),
                "env": {
                    "ORISLOP_AV_JOINT_HF_REPO_ID": args.av_repo,
                    "ORISLOP_AV_JOINT_HF_REVISION": av_revision,
                    "ORISLOP_AV_JOINT_HF_MODEL_FILE": "av/orislop_av_joint_v1.ts",
                    "ORISLOP_AV_JOINT_HF_METADATA_FILE": "av/orislop_av_joint_v1.json",
                    "ORISLOP_AV_JOINT_HF_YUNET_FILE": "av/face_detection_yunet_2023mar.onnx",
                    "ORISLOP_AV_JOINT_HF_PHASE2_FUSION_FILE": "temporal/stage2_temporal_av_fusion.pt",
                    "ORISLOP_AV_JOINT_HF_PHASE2_CALIBRATION_FILE": "temporal/stage3_temporal_av_calibration.pt",
                },
            }
        elif not args.skip_av:
            print("[av] complete AV release not found; temporal was published, AV upload was skipped")
            print("[av] missing: " + ", ".join(av_bundle.missing()))

    write_new_json(receipt_path, receipt)
    print("\nPUBLISH COMPLETE")
    print(json.dumps(receipt, indent=2, default=str))
    print(f"\nReceipt saved to Google Drive: {receipt_path}")
    print("Keep the repos private and copy the printed env values into the Vast secret file.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PublishError, OSError, ValueError) as error:
        print(f"FATAL [{type(error).__name__}]: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
    except Exception as error:
        print(f"FATAL UNEXPECTED [{type(error).__name__}]: {error}", file=sys.stderr, flush=True)
        traceback.print_exc()
        raise SystemExit(1)
