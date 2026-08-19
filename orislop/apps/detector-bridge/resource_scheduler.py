"""Resource-aware execution planning for the Orislop inference service.

The scheduler is intentionally conservative about accelerator memory.  It
uses concurrency only when the currently free VRAM can cover a fixed reserve
plus transient activations, and it opens a cooldown circuit after any CUDA
OOM.  CPU/network work can still scale independently while the GPU circuit is
open.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import statistics
import threading
import time
from typing import Any


GIB = 1024 ** 3


def _positive_int(value: str | None, fallback: int, *, minimum: int = 1, maximum: int = 64) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _bounded_float(value: str | None, fallback: float, *, minimum: float, maximum: float) -> float:
    try:
        parsed = float(str(value or "").strip())
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _ram_snapshot() -> tuple[int, int]:
    """Return total and currently available RAM without a hard psutil dependency."""

    try:
        import psutil  # type: ignore

        memory = psutil.virtual_memory()
        return int(memory.total), int(memory.available)
    except Exception:
        pass
    if os.name == "posix" and hasattr(os, "sysconf"):
        try:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            return (
                page_size * int(os.sysconf("SC_PHYS_PAGES")),
                page_size * int(os.sysconf("SC_AVPHYS_PAGES")),
            )
        except (OSError, TypeError, ValueError):
            pass
    return 0, 0


def recommended_download_workers() -> int:
    """Tune media-prefetch workers for CPU/RAM without flooding temp storage."""

    explicit = os.environ.get("ORISLOP_DOWNLOAD_WORKERS") or os.environ.get("ORISLOP_LIGHTWEIGHT_WORKERS")
    logical_cpus = max(1, int(os.cpu_count() or 1))
    total_ram, _ = _ram_snapshot()
    ram_gib = total_ram / GIB if total_ram else 0.0
    if explicit and explicit.strip().lower() != "auto":
        return _positive_int(explicit, 4, maximum=24)
    cpu_cap = max(2, logical_cpus // 4)
    ram_cap = max(2, int(ram_gib // 6)) if ram_gib else 4
    return min(12, cpu_cap, ram_cap)


@dataclass(frozen=True)
class ResourceSnapshot:
    logical_cpus: int
    ram_total_gib: float
    ram_available_gib: float
    cuda_available: bool
    gpu_name: str
    vram_total_gib: float
    vram_free_gib: float

    def public(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ExecutionPlan:
    mode: str
    download_workers: int
    cpu_preprocess_workers: int
    top_level_parallel: bool
    component_workers: int
    vram_reserve_gib: float
    reason: str

    def public(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ExecutionStrategy:
    name: str
    top_level_parallel: bool
    visual_workers: int
    required_headroom_gib: float

    def public(self) -> dict[str, Any]:
        return asdict(self)


STRATEGIES = (
    ExecutionStrategy("sequential", False, 1, 0.0),
    ExecutionStrategy("temporal_visual_overlap", True, 1, 4.0),
    ExecutionStrategy("visual_components_2", False, 2, 3.0),
    ExecutionStrategy("full_overlap_2", True, 2, 6.0),
    ExecutionStrategy("visual_components_3", False, 3, 8.0),
    ExecutionStrategy("full_overlap_3", True, 3, 10.0),
)
STRATEGY_BY_NAME = {strategy.name: strategy for strategy in STRATEGIES}
AUTOTUNE_SCHEMA = 1


class AdaptiveExecutionScheduler:
    """Continuously chooses safe concurrency from live RAM and VRAM headroom."""

    def __init__(self, cache_dir: str | Path | None = None, model_signature: str = "") -> None:
        self.mode = os.environ.get("ORISLOP_EXECUTION_MODE", "auto").strip().lower()
        if self.mode not in {"auto", "concurrent", "sequential"}:
            raise ValueError("ORISLOP_EXECUTION_MODE must be auto, concurrent, or sequential")
        self.autotune_mode = os.environ.get("ORISLOP_AUTOTUNE_MODE", "first-run").strip().lower()
        if self.autotune_mode not in {"off", "first-run", "always"}:
            raise ValueError("ORISLOP_AUTOTUNE_MODE must be off, first-run, or always")
        self.autotune_repeats = _positive_int(
            os.environ.get("ORISLOP_AUTOTUNE_REPEATS"), 2, minimum=1, maximum=3
        )
        self.autotune_max_seconds = _positive_int(
            os.environ.get("ORISLOP_AUTOTUNE_MAX_SECONDS"), 240, minimum=30, maximum=1800
        )
        self.autotune_output_tolerance = _bounded_float(
            os.environ.get("ORISLOP_AUTOTUNE_OUTPUT_TOLERANCE"),
            0.002,
            minimum=0.00001,
            maximum=0.05,
        )
        self.autotune_warmup = os.environ.get("ORISLOP_AUTOTUNE_WARMUP", "1") == "1"
        self.autotune_reset = os.environ.get("ORISLOP_AUTOTUNE_RESET", "0") == "1"
        explicit_cache = os.environ.get("ORISLOP_AUTOTUNE_CACHE", "").strip()
        self.autotune_cache_path = (
            Path(explicit_cache).expanduser().resolve()
            if explicit_cache
            else Path(cache_dir).expanduser().resolve() / "execution-autotune-v1.json"
            if cache_dir is not None
            else None
        )
        self.model_signature = str(model_signature)
        self.download_workers = recommended_download_workers()
        self.oom_cooldown_seconds = _positive_int(
            os.environ.get("ORISLOP_OOM_COOLDOWN_SECONDS"),
            300,
            minimum=30,
            maximum=3600,
        )
        self.minimum_vram_reserve_gib = _bounded_float(
            os.environ.get("ORISLOP_GPU_RESERVE_GIB")
            or os.environ.get("ORISLOP_MIN_VRAM_RESERVE_GIB"),
            3.5,
            minimum=2.0,
            maximum=32.0,
        )
        self.vram_reserve_fraction = _bounded_float(
            os.environ.get("ORISLOP_GPU_RESERVE_FRACTION"),
            0.12,
            minimum=0.05,
            maximum=0.5,
        )
        self._lock = threading.Lock()
        self._parallel_disabled_until = 0.0
        self._oom_fallbacks = 0
        self._parallel_runs = 0
        self._sequential_runs = 0
        self._autotune_lock = threading.Lock()
        self._autotuned_this_process = False
        self._autotune_state = "disabled" if self.autotune_mode == "off" else "pending"
        self._autotune_message = ""
        self._cached_autotune: dict[str, Any] | None = None
        self._load_autotune_cache()

    @staticmethod
    def configure_torch() -> None:
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

    @staticmethod
    def snapshot() -> ResourceSnapshot:
        logical_cpus = max(1, int(os.cpu_count() or 1))
        total_ram, available_ram = _ram_snapshot()
        cuda_available = False
        gpu_name = ""
        vram_total = 0
        vram_free = 0
        try:
            import torch

            cuda_available = bool(torch.cuda.is_available())
            if cuda_available:
                device = torch.cuda.current_device()
                gpu_name = str(torch.cuda.get_device_name(device))
                vram_free, vram_total = (int(value) for value in torch.cuda.mem_get_info(device))
        except Exception:
            cuda_available = False
        return ResourceSnapshot(
            logical_cpus=logical_cpus,
            ram_total_gib=round(total_ram / GIB, 2) if total_ram else 0.0,
            ram_available_gib=round(available_ram / GIB, 2) if available_ram else 0.0,
            cuda_available=cuda_available,
            gpu_name=gpu_name,
            vram_total_gib=round(vram_total / GIB, 2) if vram_total else 0.0,
            vram_free_gib=round(vram_free / GIB, 2) if vram_free else 0.0,
        )

    def plan(self) -> ExecutionPlan:
        snapshot = self.snapshot()
        reserve = max(self.minimum_vram_reserve_gib, snapshot.vram_total_gib * self.vram_reserve_fraction)
        usable_free = max(0.0, snapshot.vram_free_gib - reserve)
        cpu_workers = min(8, max(2, snapshot.logical_cpus // 6))
        if snapshot.ram_available_gib > 0:
            cpu_workers = min(cpu_workers, max(2, int(snapshot.ram_available_gib // 4)))

        with self._lock:
            circuit_open = time.monotonic() < self._parallel_disabled_until

        if self.mode == "sequential":
            parallel = False
            component_workers = 1
            reason = "sequential mode was explicitly selected"
        elif not snapshot.cuda_available:
            parallel = False
            component_workers = 1
            reason = "CUDA is unavailable"
        elif circuit_open:
            parallel = False
            component_workers = 1
            reason = "parallel CUDA circuit is cooling down after an OOM"
        else:
            # Two top-level branches need approximately 4 GiB of transient
            # headroom after the reserve.  Three component streams are used
            # only on cards with materially more than 32 GiB.
            automatic_parallel = snapshot.vram_total_gib >= 28.0 and usable_free >= 4.0
            parallel = self.mode == "concurrent" or automatic_parallel
            if not parallel:
                component_workers = 1
                reason = "live VRAM headroom is below the concurrent threshold"
            elif snapshot.vram_total_gib >= 44.0 and usable_free >= 8.0:
                component_workers = 3
                reason = "high-memory GPU has headroom for temporal and three visual lanes"
            else:
                component_workers = 2
                reason = "GPU has headroom for two controlled CUDA lanes"

        return ExecutionPlan(
            mode=self.mode,
            download_workers=self.download_workers,
            cpu_preprocess_workers=cpu_workers,
            top_level_parallel=parallel,
            component_workers=component_workers,
            vram_reserve_gib=round(reserve, 2),
            reason=reason,
        )

    def _fingerprint_payload(self, snapshot: ResourceSnapshot | None = None) -> dict[str, Any]:
        snapshot = snapshot or self.snapshot()
        torch_version = "unavailable"
        cuda_version = "unavailable"
        capability: list[int] = []
        try:
            import torch

            torch_version = str(torch.__version__)
            cuda_version = str(torch.version.cuda)
            if snapshot.cuda_available:
                capability = [int(value) for value in torch.cuda.get_device_capability(torch.cuda.current_device())]
        except Exception:
            pass
        return {
            "gpuName": snapshot.gpu_name,
            "vramTotalGiB": snapshot.vram_total_gib,
            "logicalCpus": snapshot.logical_cpus,
            "ramTotalGiB": snapshot.ram_total_gib,
            "torch": torch_version,
            "cuda": cuda_version,
            "computeCapability": capability,
            "modelSignature": self.model_signature,
        }

    def fingerprint(self, snapshot: ResourceSnapshot | None = None) -> str:
        payload = json.dumps(self._fingerprint_payload(snapshot), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _load_autotune_cache(self) -> None:
        if self.autotune_mode == "off" or self.autotune_reset or self.autotune_cache_path is None:
            if self.autotune_reset:
                self._autotune_message = "cached benchmark ignored because reset was requested"
            return
        try:
            payload = json.loads(self.autotune_cache_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except Exception as error:
            self._autotune_state = "cache-invalid"
            self._autotune_message = f"could not read benchmark cache: {error}"
            return
        selected = str(payload.get("selectedStrategy", ""))
        if (
            payload.get("schema") != AUTOTUNE_SCHEMA
            or payload.get("fingerprint") != self.fingerprint()
            or selected not in STRATEGY_BY_NAME
        ):
            self._autotune_state = "cache-stale"
            self._autotune_message = "hardware, software, or model fingerprint changed"
            return
        self._cached_autotune = payload
        self._autotune_state = "cached"

    def needs_autotune(self) -> bool:
        if self.mode != "auto" or self.autotune_mode == "off" or self._autotuned_this_process:
            return False
        snapshot = self.snapshot()
        if not snapshot.cuda_available:
            return False
        if self.autotune_mode == "first-run" and self._cached_autotune is not None:
            return False
        return True

    def candidate_strategies(self) -> tuple[ExecutionStrategy, ...]:
        snapshot = self.snapshot()
        reserve = max(self.minimum_vram_reserve_gib, snapshot.vram_total_gib * self.vram_reserve_fraction)
        headroom = max(0.0, snapshot.vram_free_gib - reserve)
        candidates = [STRATEGY_BY_NAME["sequential"]]
        if snapshot.cuda_available:
            candidates.extend(
                strategy
                for strategy in STRATEGIES[1:4]
                if headroom >= strategy.required_headroom_gib
            )
            if snapshot.vram_total_gib >= 44.0:
                candidates.extend(
                    strategy
                    for strategy in STRATEGIES[4:]
                    if headroom >= strategy.required_headroom_gib
                )
        return tuple(candidates)

    def begin_autotune(self) -> threading.Lock:
        return self._autotune_lock

    def mark_autotune_running(self) -> None:
        self._autotune_state = "running"
        self._autotune_message = "benchmarking valid execution layouts on the first Heavy video"

    def _strategy_is_safe(self, strategy: ExecutionStrategy) -> bool:
        snapshot = self.snapshot()
        reserve = max(self.minimum_vram_reserve_gib, snapshot.vram_total_gib * self.vram_reserve_fraction)
        headroom = max(0.0, snapshot.vram_free_gib - reserve)
        with self._lock:
            circuit_open = time.monotonic() < self._parallel_disabled_until
        if strategy.name == "sequential":
            return True
        return snapshot.cuda_available and not circuit_open and headroom >= strategy.required_headroom_gib

    def selected_strategy(self, plan: ExecutionPlan | None = None) -> ExecutionStrategy:
        plan = plan or self.plan()
        if self.mode == "sequential" or not self.snapshot().cuda_available:
            return STRATEGY_BY_NAME["sequential"]
        if self.mode == "auto" and self._cached_autotune is not None:
            cached = STRATEGY_BY_NAME.get(str(self._cached_autotune.get("selectedStrategy", "")))
            if cached is not None and self._strategy_is_safe(cached):
                return cached
            return STRATEGY_BY_NAME["sequential"]
        if not plan.top_level_parallel:
            return STRATEGY_BY_NAME["sequential"]
        if plan.component_workers >= 3:
            candidate = STRATEGY_BY_NAME["full_overlap_2"]
            return candidate if self._strategy_is_safe(candidate) else STRATEGY_BY_NAME["temporal_visual_overlap"]
        return STRATEGY_BY_NAME["temporal_visual_overlap"]

    def commit_autotune(self, observations: list[dict[str, Any]]) -> ExecutionStrategy:
        accepted = [
            observation
            for observation in observations
            if observation.get("accepted") is True
            and str(observation.get("strategy", "")) in STRATEGY_BY_NAME
            and observation.get("samplesMs")
        ]
        for observation in accepted:
            samples = [float(value) for value in observation["samplesMs"]]
            observation["medianMs"] = round(float(statistics.median(samples)), 2)
        if accepted:
            winner = min(accepted, key=lambda observation: float(observation["medianMs"]))
            selected = STRATEGY_BY_NAME[str(winner["strategy"])]
            state = "complete"
            message = f"selected {selected.name} from {len(accepted)} valid layouts"
        else:
            selected = STRATEGY_BY_NAME["sequential"]
            state = "failed-safe"
            message = "no benchmark layout passed; using sequential execution"
        payload = {
            "schema": AUTOTUNE_SCHEMA,
            "fingerprint": self.fingerprint(),
            "fingerprintDetails": self._fingerprint_payload(),
            "completedAtEpoch": int(time.time()),
            "selectedStrategy": selected.name,
            "repeats": self.autotune_repeats,
            "outputTolerance": self.autotune_output_tolerance,
            "observations": observations,
        }
        self._cached_autotune = payload
        self._autotuned_this_process = True
        self._autotune_state = state
        self._autotune_message = message
        if self.autotune_cache_path is not None:
            try:
                self.autotune_cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.autotune_cache_path.with_suffix(self.autotune_cache_path.suffix + ".tmp")
                temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                temporary.replace(self.autotune_cache_path)
            except Exception as error:
                self._autotune_message += f"; cache write failed: {error}"
        return selected

    def mark_autotune_skipped(self, message: str) -> None:
        self._autotuned_this_process = True
        self._autotune_state = "skipped"
        self._autotune_message = message

    def record_run(self, parallel: bool) -> None:
        with self._lock:
            if parallel:
                self._parallel_runs += 1
            else:
                self._sequential_runs += 1

    def record_oom(self) -> None:
        with self._lock:
            self._oom_fallbacks += 1
            self._parallel_disabled_until = max(
                self._parallel_disabled_until,
                time.monotonic() + self.oom_cooldown_seconds,
            )

    def status(self) -> dict[str, Any]:
        snapshot = self.snapshot()
        plan = self.plan()
        with self._lock:
            cooldown = max(0, round(self._parallel_disabled_until - time.monotonic()))
            counters = {
                "parallelRuns": self._parallel_runs,
                "sequentialRuns": self._sequential_runs,
                "oomFallbacks": self._oom_fallbacks,
                "cooldownSecondsRemaining": cooldown,
            }
        chosen = self.selected_strategy(plan)
        cached = self._cached_autotune or {}
        return {
            "snapshot": snapshot.public(),
            "plan": plan.public(),
            "selectedStrategy": chosen.public(),
            "autotune": {
                "mode": self.autotune_mode,
                "state": self._autotune_state,
                "message": self._autotune_message,
                "cachePath": str(self.autotune_cache_path or ""),
                "fingerprint": self.fingerprint(snapshot),
                "selectedStrategy": cached.get("selectedStrategy", ""),
                "completedAtEpoch": cached.get("completedAtEpoch"),
                "repeats": self.autotune_repeats,
                "maxSeconds": self.autotune_max_seconds,
                "outputTolerance": self.autotune_output_tolerance,
                "observations": cached.get("observations", []),
            },
            "counters": counters,
        }


def is_cuda_oom(error: BaseException) -> bool:
    message = str(error).lower()
    return "out of memory" in message or "cuda error: out of memory" in message
