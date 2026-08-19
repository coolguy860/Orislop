"""Measured resource tuning for high-memory Orislop training and inference hosts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import gc
import json
import os
from pathlib import Path
from typing import Any, Callable


GIB = 1024 ** 3


@dataclass(frozen=True)
class HostResources:
    logical_cpus: int
    physical_cpus: int
    ram_total_bytes: int
    ram_available_bytes: int
    gpu_name: str | None
    gpu_total_bytes: int
    gpu_free_bytes: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ResourcePlan:
    profile: str
    loader_workers: int
    sync_initial_workers: int
    sync_max_workers: int
    prefetch_factor: int
    tar_cache_size: int
    target_ram_fraction: float
    ram_reserve_gib: float
    target_vram_fraction: float
    vram_reserve_gib: float
    host: HostResources

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["host"] = self.host.to_dict()
        return value


def _ram_snapshot() -> tuple[int, int]:
    try:
        import psutil  # type: ignore

        memory = psutil.virtual_memory()
        return int(memory.total), int(memory.available)
    except Exception:
        if os.name == "posix" and hasattr(os, "sysconf"):
            try:
                page = int(os.sysconf("SC_PAGE_SIZE"))
                total = page * int(os.sysconf("SC_PHYS_PAGES"))
                available = page * int(os.sysconf("SC_AVPHYS_PAGES"))
                return total, available
            except (OSError, ValueError):
                pass
    return 0, 0


def detect_host_resources() -> HostResources:
    logical = max(1, int(os.cpu_count() or 1))
    try:
        import psutil  # type: ignore

        physical = int(psutil.cpu_count(logical=False) or logical)
    except Exception:
        physical = logical
    ram_total, ram_available = _ram_snapshot()
    gpu_name: str | None = None
    gpu_total = 0
    gpu_free = 0
    try:
        import torch

        if torch.cuda.is_available():
            device = torch.cuda.current_device()
            gpu_name = str(torch.cuda.get_device_name(device))
            gpu_free, gpu_total = (int(value) for value in torch.cuda.mem_get_info(device))
    except Exception:
        pass
    return HostResources(
        logical_cpus=logical,
        physical_cpus=max(1, physical),
        ram_total_bytes=ram_total,
        ram_available_bytes=ram_available,
        gpu_name=gpu_name,
        gpu_total_bytes=gpu_total,
        gpu_free_bytes=gpu_free,
    )


def build_auto_max_plan(
    *,
    target_ram_fraction: float = 0.92,
    ram_reserve_gib: float = 12.0,
    target_vram_fraction: float = 0.94,
    vram_reserve_gib: float = 4.0,
) -> ResourcePlan:
    host = detect_host_resources()
    loader_workers = min(48, max(4, host.logical_cpus - 2))
    sync_max = min(128, max(16, host.logical_cpus * 4))
    sync_initial = min(sync_max, max(4, host.physical_cpus // 2))
    return ResourcePlan(
        profile="auto-max",
        loader_workers=loader_workers,
        sync_initial_workers=sync_initial,
        sync_max_workers=sync_max,
        prefetch_factor=2,
        tar_cache_size=max(4, min(16, host.ram_total_bytes // (16 * GIB) if host.ram_total_bytes else 4)),
        target_ram_fraction=float(target_ram_fraction),
        ram_reserve_gib=float(ram_reserve_gib),
        target_vram_fraction=float(target_vram_fraction),
        vram_reserve_gib=float(vram_reserve_gib),
        host=host,
    )


def write_resource_plan(path: str | Path, plan: ResourcePlan) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(plan.to_dict(), indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def configure_torch_for_throughput() -> None:
    try:
        import torch

        if not torch.cuda.is_available():
            return
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        if hasattr(torch, "set_float32_matmul_precision"):
            torch.set_float32_matmul_precision("high")
    except Exception:
        return


def tensor_tree_nbytes(value: Any) -> int:
    try:
        import numpy as np
        import torch

        if isinstance(value, torch.Tensor):
            return int(value.numel() * value.element_size())
        if isinstance(value, np.ndarray):
            return int(value.nbytes)
    except Exception:
        pass
    if isinstance(value, dict):
        return sum(tensor_tree_nbytes(item) for item in value.values())
    if isinstance(value, (tuple, list)):
        return sum(tensor_tree_nbytes(item) for item in value)
    return 0


def ram_budgeted_prefetch(
    *,
    sample_bytes: int,
    batch_size: int,
    workers: int,
    target_fraction: float,
    reserve_gib: float,
    minimum: int = 2,
    maximum: int = 16,
) -> int:
    if workers <= 0 or sample_bytes <= 0:
        return minimum
    total, available = _ram_snapshot()
    if total <= 0 or available <= 0:
        return minimum
    used = max(0, total - available)
    ceiling = min(int(total * float(target_fraction)), total - int(reserve_gib * GIB))
    usable = max(0, ceiling - used)
    bytes_per_factor = max(1, int(sample_bytes * batch_size * workers * 2.5))
    factor = usable // bytes_per_factor
    return max(minimum, min(maximum, int(factor)))


def ram_limited_batch_cap(
    *,
    sample_bytes: int,
    configured_max: int,
    target_fraction: float,
    reserve_gib: float,
    minimum: int = 1,
) -> int:
    total, available = _ram_snapshot()
    if total <= 0 or available <= 0 or sample_bytes <= 0:
        return max(minimum, int(configured_max))
    used = max(0, total - available)
    ceiling = min(int(total * float(target_fraction)), total - int(float(reserve_gib) * GIB))
    usable = max(0, ceiling - used)
    measured_cap = usable // max(1, int(sample_bytes * 3.0))
    return max(minimum, min(int(configured_max), int(measured_cap)))


def repeat_batch_tree(value: Any, batch_size: int) -> Any:
    try:
        import torch

        if isinstance(value, torch.Tensor):
            if value.ndim == 0:
                return value.repeat(batch_size)
            multiples = (batch_size,) + (1,) * (value.ndim - 1)
            return value.repeat(multiples)
    except Exception:
        pass
    if isinstance(value, dict):
        return {key: repeat_batch_tree(item, batch_size) for key, item in value.items()}
    if isinstance(value, list):
        return value * batch_size
    if isinstance(value, tuple):
        return tuple(value * batch_size)
    return value


def autotune_cuda_batch_size(
    probe: Callable[[int], None],
    *,
    initial_batch_size: int,
    max_batch_size: int,
    target_vram_fraction: float,
    vram_reserve_gib: float,
    label: str,
) -> tuple[int, dict[str, Any]]:
    import torch

    initial = max(1, int(initial_batch_size))
    maximum = max(initial, int(max_batch_size))
    if not torch.cuda.is_available():
        return initial, {"label": label, "selected_batch_size": initial, "reason": "cuda_unavailable", "probes": []}
    device = torch.cuda.current_device()
    free_at_start, total = (int(value) for value in torch.cuda.mem_get_info(device))
    reserve = int(float(vram_reserve_gib) * GIB)
    baseline_reserved = int(torch.cuda.memory_reserved(device))
    target_peak = min(
        int(total * float(target_vram_fraction)),
        baseline_reserved + max(0, free_at_start - reserve),
    )
    attempts: list[dict[str, Any]] = []
    best = 0
    first_unsafe: int | None = None

    def attempt(candidate: int) -> bool:
        nonlocal best, first_unsafe
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device)
        try:
            probe(candidate)
            torch.cuda.synchronize(device)
            peak_allocated = int(torch.cuda.max_memory_allocated(device))
            peak_reserved = int(torch.cuda.max_memory_reserved(device))
            safe = peak_reserved <= target_peak
            attempts.append({
                "batch_size": candidate,
                "status": "safe" if safe else "over_target",
                "peak_allocated_bytes": peak_allocated,
                "peak_reserved_bytes": peak_reserved,
            })
            if safe:
                best = max(best, candidate)
            else:
                first_unsafe = candidate if first_unsafe is None else min(first_unsafe, candidate)
            return safe
        except RuntimeError as exc:
            if "out of memory" not in str(exc).lower():
                raise
            attempts.append({"batch_size": candidate, "status": "oom", "error": str(exc)[:500]})
            first_unsafe = candidate if first_unsafe is None else min(first_unsafe, candidate)
            return False
        finally:
            gc.collect()
            torch.cuda.empty_cache()

    candidate = initial
    while candidate <= maximum:
        if not attempt(candidate):
            break
        if candidate == maximum:
            break
        candidate = min(maximum, candidate * 2)

    if best == 0:
        best = initial
    upper = min(maximum, (first_unsafe or (maximum + 1)) - 1)
    lower = best + 1
    while lower <= upper:
        candidate = (lower + upper) // 2
        if attempt(candidate):
            lower = candidate + 1
        else:
            upper = candidate - 1

    report = {
        "label": label,
        "gpu_name": str(torch.cuda.get_device_name(device)),
        "gpu_total_bytes": total,
        "gpu_free_bytes_at_start": free_at_start,
        "target_vram_fraction": float(target_vram_fraction),
        "vram_reserve_gib": float(vram_reserve_gib),
        "target_peak_reserved_bytes": target_peak,
        "selected_batch_size": best,
        "probes": attempts,
    }
    print("[auto-max] " + json.dumps(report, indent=2), flush=True)
    return best, report
