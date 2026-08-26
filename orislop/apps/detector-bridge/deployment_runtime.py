"""Pure deployment decisions shared by the Vast launcher and detector.

This module deliberately has no third-party imports so storage, GPU placement,
and readiness decisions can be validated before installing the runtime.
"""

from __future__ import annotations

from typing import Any, Mapping


GIB = 1024**3


def calculate_storage_plan(
    *,
    release_bytes: int,
    verified_bytes: int = 0,
    dependencies_bytes: int = 6 * GIB,
    scratch_bytes: int = 4 * GIB,
    safety_reserve_bytes: int = 5 * GIB,
) -> dict[str, int]:
    """Return a conservative manifest-aware incremental free-space plan."""

    release = max(0, int(release_bytes))
    verified = min(release, max(0, int(verified_bytes)))
    download = release - verified
    # Hugging Face writes resumable temporary parts before atomic promotion.
    # Reserve half the outstanding bytes, bounded to 0.5-1.5 GiB. When every
    # file is verified, only a small receipt/model.env allowance is needed.
    if download:
        temporary = min(int(1.5 * GIB), max(int(0.5 * GIB), download // 2))
    else:
        temporary = int(0.25 * GIB)
    components = {
        "release_bytes": release,
        "verified_reusable_bytes": verified,
        "download_bytes": download,
        "temporary_materialization_bytes": temporary,
        "dependencies_bytes": max(0, int(dependencies_bytes)),
        "video_scratch_bytes": max(0, int(scratch_bytes)),
        "safety_reserve_bytes": max(0, int(safety_reserve_bytes)),
    }
    components["required_free_bytes"] = sum(
        components[name]
        for name in (
            "download_bytes",
            "temporary_materialization_bytes",
            "dependencies_bytes",
            "video_scratch_bytes",
            "safety_reserve_bytes",
        )
    )
    return components


def classify_cuda_gpu(
    gpu: Mapping[str, Any],
    cuda: Mapping[str, Any],
    *,
    minimum_vram_mib: int = 20 * 1024,
    minimum_capability: tuple[int, int] = (7, 0),
) -> dict[str, Any]:
    """Classify NVIDIA support from CUDA truth, not a product-name allowlist."""

    capability_value = cuda.get("capability")
    capability = tuple(capability_value) if capability_value is not None else None
    reasons: list[str] = []
    if not bool(cuda.get("available")):
        reasons.append("PyTorch cannot use CUDA in this runtime")
    if int(cuda.get("device_count", 0)) != 1:
        reasons.append(f"expected one visible CUDA GPU, found {int(cuda.get('device_count', 0))}")
    if int(gpu.get("memory_mib", 0)) < int(minimum_vram_mib):
        reasons.append(
            f"GPU VRAM is {int(gpu.get('memory_mib', 0)) / 1024:.1f} GiB; "
            f"{int(minimum_vram_mib) / 1024:.1f} GiB is required"
        )
    if capability is None:
        reasons.append("CUDA compute capability could not be determined")
    elif capability < minimum_capability:
        reasons.append(
            f"CUDA capability {capability[0]}.{capability[1]} is below "
            f"{minimum_capability[0]}.{minimum_capability[1]}"
        )
    return {
        "supported": not reasons,
        "reasons": reasons,
        "capability": list(capability) if capability is not None else None,
        "cuda_available": bool(cuda.get("available")),
        "device_count": int(cuda.get("device_count", 0)),
        "name": str(gpu.get("name", "unknown")),
        "memory_mib": int(gpu.get("memory_mib", 0)),
        "free_memory_mib": int(gpu.get("free_memory_mib", 0)),
    }


def choose_ollama_placement(
    requested: str,
    gpu_support: Mapping[str, Any],
    *,
    detector_reserve_mib: int = 18 * 1024,
    ollama_budget_mib: int = 3 * 1024,
) -> dict[str, str]:
    """Choose Ollama placement with an explicit, user-visible reason."""

    normalized = requested.strip().lower()
    if normalized not in {"auto", "cpu", "gpu"}:
        raise ValueError("ORISLOP_OLLAMA_DEVICE must be auto, cpu, or gpu")
    supported = bool(gpu_support.get("supported"))
    total = int(gpu_support.get("memory_mib", 0))
    free = int(gpu_support.get("free_memory_mib", total)) or total
    required = max(0, int(detector_reserve_mib)) + max(0, int(ollama_budget_mib))
    capacity = min(total, free)
    if normalized == "cpu":
        return {"device": "cpu", "reason": "CPU was explicitly requested"}
    if normalized == "gpu":
        if not supported:
            return {
                "device": "cpu",
                "reason": "GPU was requested but CUDA support checks failed; using CPU safely",
            }
        return {"device": "gpu", "reason": "GPU was explicitly requested and CUDA is usable"}
    if not supported:
        return {"device": "cpu", "reason": "CUDA is unavailable or unsupported; using CPU safely"}
    if capacity < required:
        return {
            "device": "cpu",
            "reason": (
                f"Only {capacity / 1024:.1f} GiB GPU capacity is available; "
                f"{required / 1024:.1f} GiB is reserved for detectors plus Ollama"
            ),
        }
    return {
        "device": "gpu",
        "reason": (
            f"CUDA is usable and {capacity / 1024:.1f} GiB capacity covers the "
            f"{required / 1024:.1f} GiB detector-plus-Ollama budget"
        ),
    }


def readiness_report(
    health: Mapping[str, Any],
    *,
    full_model_stack_required: bool,
    cloud_heavy_enabled: bool,
) -> dict[str, Any]:
    """Map detailed health into starting/ready/degraded/failed readiness."""

    states = health.get("model_states") if isinstance(health.get("model_states"), Mapping) else {}
    av = states.get("av_joint") if isinstance(states.get("av_joint"), Mapping) else {}
    dependencies_ok = health.get("dependencies") == "available"
    queue_ok = int(health.get("queue_depth", 0)) < int(health.get("queue_capacity", 1))
    text = health.get("text_model") if isinstance(health.get("text_model"), Mapping) else {}
    base_model_ready = (
        states.get("cloud_heavy") == "ready"
        if cloud_heavy_enabled
        else text.get("state") == "available"
    )
    required_states = [states.get("lightweight"), states.get("spatial"), states.get("temporal"), states.get("cloud_heavy")]
    if full_model_stack_required:
        required_ready = all(state == "ready" for state in required_states) and av.get("state") == "ready"
        required_ready = required_ready and text.get("state") == "available"
    else:
        required_ready = base_model_ready
    ready = bool(dependencies_ok and queue_ok and base_model_ready and required_ready)
    error = str(health.get("last_error") or "").strip()
    explicit_failure = not dependencies_ok or any(
        str(state).lower() in {"error", "failed", "unavailable"} for state in required_states
    )
    loading_states = {"not_loaded", "loading", "analyzing", "idle", None}
    still_loading = any(state in loading_states for state in required_states)
    if ready:
        state = "ready"
    elif explicit_failure or (error and not still_loading):
        state = "failed"
    elif still_loading and not error:
        state = "starting"
    else:
        state = "degraded"
    return {
        "ok": ready,
        "state": state,
        "service": health.get("service", "orislop-detector-bridge"),
        "version": health.get("version", "unknown"),
        "phase": "ready" if ready else "model-loading" if state == "starting" else state,
        "detail": (
            error
            if error
            else "All required models are loading"
            if state == "starting"
            else "One or more required services are unavailable"
            if state in {"degraded", "failed"}
            else ""
        ),
    }
