from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping


class TemporalPackageError(RuntimeError):
    """Raised when the promoted temporal package is absent or inconsistent."""


@dataclass(frozen=True)
class ResolvedTemporalPackage:
    root: Path
    weights_path: Path
    config: dict[str, Any]
    metrics: dict[str, Any]
    threshold_payload: dict[str, Any]
    threshold: float
    weights_sha256: str
    source: str
    repo_id: str | None
    revision: str | None
    integrity_verified: bool

    def public_status(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "repoId": self.repo_id,
            "revision": self.revision,
            "weightsSha256": self.weights_sha256,
            "integrityVerified": self.integrity_verified,
            "threshold": self.threshold,
            "root": str(self.root),
        }


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path, required: bool = True) -> dict[str, Any]:
    if not path.is_file():
        if required:
            raise TemporalPackageError(f"Required temporal package file is missing: {path.name}")
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise TemporalPackageError(f"Could not parse {path.name}: {error}") from error
    if not isinstance(payload, dict):
        raise TemporalPackageError(f"{path.name} must contain a JSON object")
    return payload


def _extract_threshold(payload: Mapping[str, Any], default: float) -> float:
    candidates = (
        "threshold",
        "selected_threshold",
        "selectedThreshold",
        "decision_threshold",
        "decisionThreshold",
        "value",
    )
    queue: list[Mapping[str, Any]] = [payload]
    visited: set[int] = set()
    while queue:
        current = queue.pop(0)
        if id(current) in visited:
            continue
        visited.add(id(current))
        for key in candidates:
            try:
                value = float(current[key])
            except (KeyError, TypeError, ValueError):
                continue
            if 0.0 < value < 1.0:
                return value
        for value in current.values():
            if isinstance(value, Mapping):
                queue.append(value)
    if not 0.0 < float(default) < 1.0:
        raise TemporalPackageError("The configured temporal threshold must be between zero and one")
    return float(default)


def _validate_manifest(root: Path, manifest: Mapping[str, Any]) -> bool:
    files = manifest.get("files")
    if not isinstance(files, Mapping) or not files:
        return False
    for relative, expected in files.items():
        relative_path = Path(str(relative))
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise TemporalPackageError(f"Unsafe path in artifact_manifest.json: {relative}")
        target = root / relative_path
        expected_text = str(expected).strip().lower()
        if not target.is_file() or len(expected_text) != 64:
            raise TemporalPackageError(f"Invalid manifest entry for {relative}")
        actual = sha256_file(target)
        if actual != expected_text:
            raise TemporalPackageError(
                f"Temporal package integrity check failed for {relative}: expected {expected_text}, got {actual}"
            )
    return True


def resolve_temporal_package(
    cache_root: str | Path,
    *,
    local_path: str = "",
    repo_id: str = "",
    revision: str = "",
    subdir: str = "final_model_package",
    token: str | None = None,
    expected_weights_sha256: str = "",
    default_threshold: float = 0.5,
    require_pinned_remote: bool = False,
) -> ResolvedTemporalPackage:
    cache_root = Path(cache_root).expanduser().resolve()
    local_value = local_path.strip()
    repo_value = repo_id.strip()
    revision_value = revision.strip()
    subdir_value = subdir.strip().strip("/")

    if local_value:
        root = Path(local_value).expanduser().resolve()
        source = "local"
        resolved_repo: str | None = None
        resolved_revision: str | None = None
    elif repo_value:
        if require_pinned_remote and not re.fullmatch(r"[0-9a-fA-F]{40,64}", revision_value):
            raise TemporalPackageError(
                "ORISLOP_TEMPORAL_HF_REVISION must pin a 40-64 character hexadecimal commit in cloud mode"
            )
        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise TemporalPackageError("huggingface-hub is required to download the temporal package") from error
        allow_patterns = [f"{subdir_value}/**"] if subdir_value else None
        snapshot = Path(
            snapshot_download(
                repo_id=repo_value,
                revision=revision_value or None,
                token=token or os.environ.get("HF_TOKEN") or None,
                cache_dir=str(cache_root / "huggingface"),
                allow_patterns=allow_patterns,
            )
        )
        root = snapshot / subdir_value if subdir_value else snapshot
        source = "huggingface"
        resolved_repo = repo_value
        resolved_revision = revision_value or snapshot.name
    else:
        raise TemporalPackageError(
            "Configure ORISLOP_TEMPORAL_PACKAGE_PATH or ORISLOP_TEMPORAL_HF_REPO_ID"
        )

    if not root.is_dir():
        raise TemporalPackageError(f"Temporal package directory does not exist: {root}")
    weights_candidates = [root / "final_model.safetensors", root / "final_model.pt"]
    weights_path = next((candidate for candidate in weights_candidates if candidate.is_file()), None)
    if weights_path is None:
        raise TemporalPackageError(
            f"Temporal package has no final_model.safetensors or final_model.pt: {root}"
        )

    config = _read_json(root / "config.json")
    metrics = _read_json(root / "metrics.json")
    threshold_payload = _read_json(root / "threshold.json", required=False)
    manifest = _read_json(root / "artifact_manifest.json", required=False)
    weights_sha256 = sha256_file(weights_path)
    expected = expected_weights_sha256.strip().lower()
    expected_verified = False
    if expected:
        if len(expected) != 64:
            raise TemporalPackageError("ORISLOP_TEMPORAL_MODEL_SHA256 must contain 64 hexadecimal characters")
        if weights_sha256 != expected:
            raise TemporalPackageError(
                f"Temporal weights SHA-256 mismatch: expected {expected}, got {weights_sha256}"
            )
        expected_verified = True
    manifest_verified = _validate_manifest(root, manifest) if manifest else False
    threshold = _extract_threshold(threshold_payload, default_threshold)

    return ResolvedTemporalPackage(
        root=root,
        weights_path=weights_path,
        config=config,
        metrics=metrics,
        threshold_payload=threshold_payload,
        threshold=threshold,
        weights_sha256=weights_sha256,
        source=source,
        repo_id=resolved_repo,
        revision=resolved_revision,
        integrity_verified=bool(expected_verified or manifest_verified),
    )


def load_package_state(package: ResolvedTemporalPackage, module: Any, device: Any) -> dict[str, Any]:
    if package.weights_path.suffix == ".safetensors":
        try:
            from safetensors.torch import load_file
        except ImportError as error:
            raise TemporalPackageError("safetensors is required to load final_model.safetensors") from error
        state = load_file(str(package.weights_path), device=str(device))
    else:
        state = module.safe_torch_load(package.weights_path, map_location=device)
        if isinstance(state, Mapping) and isinstance(state.get("model"), Mapping):
            state = state["model"]
        elif isinstance(state, Mapping) and isinstance(state.get("state_dict"), Mapping):
            state = state["state_dict"]
    if not isinstance(state, Mapping) or not state:
        raise TemporalPackageError("The temporal final model contains no state dictionary")
    return {str(key): value for key, value in state.items()}


def build_bundle_from_package(
    package: ResolvedTemporalPackage,
    module: Any,
    cache_dir: str | Path,
) -> tuple[Any, Any, Any, Any]:
    state = load_package_state(package, module, "cpu")
    arguments = [
        "--mode", "predict",
        "--predict-video", "bridge-placeholder.mp4",
        "--local-cache-dir", str(cache_dir),
        "--precision", "auto",
        "--clip-frame-chunk-size", "auto",
        "--allow-untrained-experts", "true",
    ]
    args = module.build_arg_parser().parse_args(arguments)
    blocked_config = {
        "mode", "predict_video", "hf_token", "hf_repo_id", "hf_checkpoint_dir",
        "micro_checkpoint", "mid_checkpoint", "long_checkpoint", "extra_long_checkpoint",
        "fusion_checkpoint", "calibration_checkpoint", "spatial_checkpoint", "lip_checkpoint",
        "local_cache_dir", "output_dir", "runtime",
        "precomputed_manifest", "precomputed_root",
        "validation_manifest", "validation_root",
        "test_manifest", "test_root", "data_roots",
        "expert_cache_root", "av_prepared_npz", "av_yunet_model",
    }
    for key, value in package.config.items():
        if key in blocked_config or value is None or not hasattr(args, key):
            continue
        setattr(args, key, value)
    args.mode = "predict"
    args.predict_video = "bridge-placeholder.mp4"
    args.local_cache_dir = str(cache_dir)
    args.hf_repo_id = None
    args.hf_checkpoint_dir = "."
    args.micro_checkpoint = None
    args.mid_checkpoint = None
    args.long_checkpoint = None
    args.extra_long_checkpoint = None
    args.fusion_checkpoint = None
    args.calibration_checkpoint = None
    args.predict_use_extra_long = any(key.startswith("extra_long.") for key in state)
    args.use_spatial = bool(args.use_spatial or any(key.startswith("spatial.") for key in state))
    args.use_lip = bool(args.use_lip or any(key.startswith("lip_sync.") for key in state))
    args.allow_untrained_experts = True

    runtime = module.detect_runtime()
    args = module.apply_device_safe_defaults(args, runtime)
    module.validate_args(args, runtime)
    module.set_seed(int(args.seed))
    module.ensure_dir(args.local_cache_dir)
    module.configure_cache_environment(args.local_cache_dir)
    hf = module.HFStore(
        repo_id=None,
        token=None,
        private=False,
        checkpoint_dir=".",
        local_cache_dir=args.local_cache_dir,
        strict_upload=False,
    )
    device = module.torch.device(runtime.device)
    bundle = module.build_fusion_bundle(args, hf, device, load_experts=False)

    modules = {
        "micro": bundle.micro,
        "mid": bundle.mid,
        "long": bundle.long,
        "extra_long": bundle.extra_long,
        "spatial": bundle.spatial,
        "lip_sync": bundle.lip_sync,
        "fusion": bundle.fusion,
        "temperature": bundle.temperature,
    }
    required = {"micro", "mid", "long", "fusion", "temperature"}
    for name, target in modules.items():
        prefix = f"{name}."
        subset = {key[len(prefix):]: value for key, value in state.items() if key.startswith(prefix)}
        if not subset:
            if name in required:
                raise TemporalPackageError(f"Temporal final model is missing the {name} component")
            continue
        if target is None:
            raise TemporalPackageError(f"Temporal final model contains {name} weights but the configured model did not build it")
        incompatible = target.load_state_dict(subset, strict=False)
        unexpected = list(getattr(incompatible, "unexpected_keys", ()))
        missing = [
            key for key in getattr(incompatible, "missing_keys", ())
            if not key.startswith("clip_encoder.model.") and not key.startswith("clip_encoder.visual.")
        ]
        if unexpected or missing:
            raise TemporalPackageError(
                f"Temporal {name} checkpoint is incompatible; missing={missing[:8]}, unexpected={unexpected[:8]}"
            )

    module.freeze_bundle_experts(bundle)
    for target in bundle.modules():
        target.eval()
    return args, runtime, device, bundle
