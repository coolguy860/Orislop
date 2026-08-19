#!/usr/bin/env python3
"""Testable utilities for the one-session A100 pipeline."""

from __future__ import annotations

import hashlib
import json
import math
import os
import contextlib
import codecs
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:
    from .final_pipeline_core import PackError, atomic_write_json, iter_jsonl, utc_now
except ImportError:  # Direct execution keeps this directory on sys.path.
    from final_pipeline_core import PackError, atomic_write_json, iter_jsonl, utc_now


class ProcessStallError(TimeoutError):
    """Raised after a supervised process makes no observable progress."""

    def __init__(self, message: str, report: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.report = dict(report)


def redact_command(command: Sequence[str]) -> List[str]:
    """Redact common secret flags and embedded Hugging Face tokens."""
    sensitive = {"--hf-token", "--token", "--api-key", "--access-token"}
    result: List[str] = []
    redact_next = False
    for raw in command:
        value = str(raw)
        if redact_next:
            result.append("***REDACTED***")
            redact_next = False
            continue
        lowered = value.lower()
        if lowered in sensitive:
            result.append(value)
            redact_next = True
            continue
        if any(lowered.startswith(flag + "=") for flag in sensitive):
            result.append(value.split("=", 1)[0] + "=***REDACTED***")
            continue
        result.append(re.sub(r"hf_[A-Za-z0-9]{12,}", "hf_***REDACTED***", value))
    return result


def _process_activity_snapshot(pid: int) -> Dict[str, Any]:
    """Return cumulative process-tree work counters, with a safe fallback."""
    try:
        import psutil

        root = psutil.Process(int(pid))
        processes = [root] + root.children(recursive=True)
        cpu_seconds = 0.0
        io_bytes = 0
        rss_bytes = 0
        live_pids: List[int] = []
        for process in processes:
            try:
                cpu = process.cpu_times()
                io = process.io_counters()
                cpu_seconds += float(cpu.user) + float(cpu.system)
                io_bytes += int(io.read_bytes) + int(io.write_bytes)
                rss_bytes += int(process.memory_info().rss)
                live_pids.append(int(process.pid))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        return {
            "available": True,
            "cpu_seconds": cpu_seconds,
            "io_bytes": io_bytes,
            "rss_bytes": rss_bytes,
            "pids": sorted(live_pids),
        }
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def _gpu_utilization() -> Optional[float]:
    """Read utilization on the single-user Colab GPU without importing torch."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        values = [float(line.strip()) for line in result.stdout.splitlines() if line.strip()]
        return max(values) if values else None
    except Exception:
        return None


def _terminate_process_tree(process: subprocess.Popen[bytes], grace_seconds: float = 20.0) -> None:
    """Terminate a child and its descendants, then force-kill only if needed."""
    if os.name == "posix":
        # The process-group ID remains usable when the direct child has exited
        # but a DataLoader descendant still holds stdout or memory.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
    else:
        if process.poll() is not None:
            return
        with contextlib.suppress(Exception):
            process.terminate()
    if process.poll() is None:
        try:
            process.wait(timeout=max(0.1, float(grace_seconds)))
            return
        except subprocess.TimeoutExpired:
            pass
    else:
        time.sleep(min(1.0, max(0.1, float(grace_seconds))))
    if os.name == "posix":
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    else:
        with contextlib.suppress(Exception):
            process.kill()
    with contextlib.suppress(Exception):
        process.wait(timeout=10)


def run_with_watchdog(
    command: Sequence[str],
    *,
    cwd: Optional[str | Path] = None,
    env: Optional[Mapping[str, str]] = None,
    label: str = "command",
    log_path: Optional[str | Path] = None,
    report_path: Optional[str | Path] = None,
    stall_timeout_seconds: float = 600.0,
    heartbeat_seconds: float = 60.0,
    hard_timeout_seconds: Optional[float] = None,
    sample_seconds: float = 5.0,
) -> Path:
    """Run a child with streamed logs and a process-tree progress watchdog.

    Output, cumulative CPU time, disk I/O, child creation, and active GPU work
    all count as progress. Supervisor heartbeat lines never reset the timer.
    This avoids killing a quiet but healthy download/training operation while
    still stopping dead sockets, blocked workers, and wedged subprocess trees.
    """
    if stall_timeout_seconds <= 0 or heartbeat_seconds <= 0 or sample_seconds <= 0:
        raise ValueError("watchdog timing values must be positive")
    command_list = [str(part) for part in command]
    safe_command = redact_command(command_list)
    started_wall = utc_now()
    started = time.monotonic()
    destination = Path(log_path).resolve() if log_path else Path.cwd() / f"{label}.log"
    destination.parent.mkdir(parents=True, exist_ok=True)
    report_destination = (
        Path(report_path).resolve()
        if report_path
        else destination.with_suffix(destination.suffix + ".watchdog.json")
    )
    report_destination.parent.mkdir(parents=True, exist_ok=True)
    creationflags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags = int(subprocess.CREATE_NEW_PROCESS_GROUP)
    process = subprocess.Popen(
        command_list,
        cwd=str(cwd) if cwd is not None else None,
        env=dict(env) if env is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=os.name == "posix",
        creationflags=creationflags,
    )
    chunks: "queue.Queue[Optional[bytes]]" = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        try:
            while True:
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    break
                chunks.put(chunk)
        finally:
            chunks.put(None)

    reader = threading.Thread(target=read_output, name=f"watchdog-output-{label}", daemon=True)
    reader.start()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    last_progress = started
    last_output = started
    last_heartbeat = started
    last_sample = started
    previous_activity = _process_activity_snapshot(process.pid)
    latest_activity = previous_activity
    latest_gpu: Optional[float] = None
    stop_reason: Optional[str] = None
    output_closed = False
    parent_exited_at: Optional[float] = None

    def make_report(reason: str, return_code: Optional[int]) -> Dict[str, Any]:
        now = time.monotonic()
        return {
            "schema_version": 1,
            "label": label,
            "command": safe_command,
            "cwd": str(Path(cwd).resolve()) if cwd is not None else str(Path.cwd()),
            "pid": process.pid,
            "started_at": started_wall,
            "reported_at": utc_now(),
            "elapsed_seconds": round(now - started, 3),
            "seconds_since_progress": round(now - last_progress, 3),
            "seconds_since_output": round(now - last_output, 3),
            "stall_timeout_seconds": float(stall_timeout_seconds),
            "hard_timeout_seconds": hard_timeout_seconds,
            "reason": reason,
            "return_code": return_code,
            "activity": latest_activity,
            "gpu_utilization_percent": latest_gpu,
            "log_path": str(destination),
        }

    try:
        with destination.open("wb", buffering=0) as log:
            header = ("$ " + subprocess.list2cmdline(safe_command) + "\n").encode("utf-8")
            log.write(header)
            while True:
                now = time.monotonic()
                if hard_timeout_seconds is not None and now - started >= float(hard_timeout_seconds):
                    stop_reason = "hard_timeout"
                    raise TimeoutError(f"{label} exceeded its hard timeout")
                try:
                    chunk = chunks.get(timeout=min(1.0, float(sample_seconds)))
                except queue.Empty:
                    chunk = b""
                if chunk is None:
                    output_closed = True
                elif chunk:
                    log.write(chunk)
                    decoded = decoder.decode(chunk)
                    if decoded:
                        sys.stdout.write(decoded)
                        sys.stdout.flush()
                    last_output = now
                    last_progress = now

                now = time.monotonic()
                if now - last_sample >= float(sample_seconds):
                    latest_activity = _process_activity_snapshot(process.pid)
                    if latest_activity.get("available") and previous_activity.get("available"):
                        cpu_delta = float(latest_activity["cpu_seconds"]) - float(previous_activity["cpu_seconds"])
                        io_delta = int(latest_activity["io_bytes"]) - int(previous_activity["io_bytes"])
                        pids_changed = latest_activity.get("pids") != previous_activity.get("pids")
                        if cpu_delta >= 0.05 or io_delta >= 64 * 1024 or pids_changed:
                            last_progress = now
                    previous_activity = latest_activity
                    latest_gpu = _gpu_utilization()
                    if latest_gpu is not None and latest_gpu >= 5.0:
                        last_progress = now
                    last_sample = now

                return_code = process.poll()
                if return_code is not None:
                    if parent_exited_at is None:
                        parent_exited_at = now
                    if output_closed and chunks.empty():
                        break
                    if now - parent_exited_at >= 5.0:
                        stop_reason = "orphaned_output_pipe"
                        _terminate_process_tree(process, grace_seconds=1.0)
                        if process.stdout is not None:
                            with contextlib.suppress(Exception):
                                process.stdout.close()
                        break
                idle = now - last_progress
                if idle >= float(stall_timeout_seconds):
                    stop_reason = "stalled"
                    report = make_report(stop_reason, process.poll())
                    atomic_write_json(report_destination, report)
                    raise ProcessStallError(
                        f"{label} made no observable progress for {idle / 60.0:.1f} minutes",
                        report,
                    )
                if now - last_heartbeat >= float(heartbeat_seconds):
                    print(
                        f"\n[watchdog] {label}: alive pid={process.pid} "
                        f"elapsed={(now - started) / 60.0:.1f}m "
                        f"no-progress={idle:.0f}s no-output={now - last_output:.0f}s "
                        f"gpu={latest_gpu if latest_gpu is not None else 'n/a'}%",
                        flush=True,
                    )
                    last_heartbeat = now
            tail = decoder.decode(b"", final=True)
            if tail:
                sys.stdout.write(tail)
                sys.stdout.flush()
        return_code = process.wait(timeout=30)
        report = make_report("completed" if return_code == 0 else "nonzero_exit", return_code)
        atomic_write_json(report_destination, report)
        if return_code != 0:
            raise subprocess.CalledProcessError(return_code, safe_command)
        return destination
    except BaseException:
        _terminate_process_tree(process)
        if not report_destination.is_file():
            atomic_write_json(report_destination, make_report(stop_reason or "exception", process.poll()))
        raise
    finally:
        if process.stdout is not None:
            with contextlib.suppress(Exception):
                process.stdout.close()
        reader.join(timeout=1.0)


def optimizer_resume_policy(kind: str) -> Dict[str, Any]:
    """Describe exactly what state is restored for a resume boundary."""
    if kind == "crash":
        return {
            "load_model": True,
            "load_optimizer": True,
            "load_scheduler": True,
            "load_scaler": True,
            "load_epoch_and_step": True,
            "intentional_optimizer_reset": False,
        }
    if kind == "phase_transition":
        return {
            "load_model": True,
            "load_optimizer": False,
            "load_scheduler": False,
            "load_scaler": False,
            "load_epoch_and_step": False,
            "intentional_optimizer_reset": True,
        }
    if kind == "fresh":
        return {
            "load_model": False,
            "load_optimizer": False,
            "load_scheduler": False,
            "load_scaler": False,
            "load_epoch_and_step": False,
            "intentional_optimizer_reset": True,
        }
    raise ValueError(f"unknown optimizer resume policy: {kind}")


def choose_loader_config(
    results: Sequence[Mapping[str, Any]],
    *,
    target_gpu_util: float = 80.0,
    max_cpu_ram_percent: float = 85.0,
    workload: str = "expert",
    allow_under_target: bool = False,
) -> Dict[str, Any]:
    """Choose the fastest stable trial while enforcing safety constraints."""
    safe: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    def number(value: Any, default: float = 0.0) -> float:
        return default if value is None else float(value)

    for raw in results:
        result = dict(raw)
        reasons = []
        if result.get("oom"):
            reasons.append("oom")
        if result.get("crashed") or int(result.get("worker_crashes", 0)) > 0:
            reasons.append("crash")
        if number(result.get("cpu_ram_percent_max")) > float(max_cpu_ram_percent):
            reasons.append("cpu_ram")
        if number(result.get("samples_per_second")) <= 0:
            reasons.append("no_throughput")
        if reasons:
            result["rejected_reasons"] = reasons
            rejected.append(result)
        else:
            safe.append(result)
    if not safe:
        raise RuntimeError(f"all DataLoader autotune configurations were unsafe: {rejected}")

    reason: str
    candidates = safe
    if workload == "expert":
        utilization_candidates = [
            result
            for result in safe
            if number(result.get("gpu_util_avg")) >= float(target_gpu_util)
        ]
        if utilization_candidates:
            candidates = utilization_candidates
            reason = (
                f"fastest safe expert configuration meeting average GPU utilization >= {target_gpu_util:.1f}%"
            )
        else:
            if not allow_under_target:
                raise RuntimeError(
                    f"no safe expert configuration met average GPU utilization >= {target_gpu_util:.1f}%"
                )
            reason = "GPU utilization target was explicitly relaxed; selected fastest safe configuration"
    else:
        reason = "fastest safe cached-fusion configuration; GPU utilization is informational"
    best = max(
        candidates,
        key=lambda result: (
            number(result.get("samples_per_second")),
            -number(result.get("step_time_p95"), float("inf")),
        ),
    )
    return {
        "best": best,
        "results": [dict(result) for result in results],
        "rejected": rejected,
        "chosen_reason": reason,
        "timestamp": utc_now(),
        "constraints": {
            "target_gpu_util": float(target_gpu_util),
            "max_cpu_ram_percent": float(max_cpu_ram_percent),
            "workload": workload,
        },
    }


def _auc_rank(labels: Sequence[int], probabilities: Sequence[float]) -> Optional[float]:
    positives = sum(int(label == 1) for label in labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return None
    ordered = sorted(enumerate(probabilities), key=lambda pair: pair[1])
    rank_sum = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][1] == ordered[index][1]:
            end += 1
        average_rank = (index + 1 + end) / 2.0
        rank_sum += average_rank * sum(labels[ordered[pos][0]] == 1 for pos in range(index, end))
        index = end
    return (rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def _threshold_counts(
    labels: Sequence[int], probabilities: Sequence[float], threshold: float
) -> Tuple[int, int, int, int]:
    tp = fp = tn = fn = 0
    for label, probability in zip(labels, probabilities):
        predicted = int(float(probability) >= float(threshold))
        if label == 1 and predicted == 1:
            tp += 1
        elif label == 0 and predicted == 1:
            fp += 1
        elif label == 0:
            tn += 1
        else:
            fn += 1
    return tn, fp, fn, tp


def threshold_curve(labels: Sequence[int], probabilities: Sequence[float]) -> List[Dict[str, float]]:
    thresholds = [float("inf")] + sorted({float(value) for value in probabilities}, reverse=True) + [float("-inf")]
    curve = []
    for threshold in thresholds:
        tn, fp, fn, tp = _threshold_counts(labels, probabilities, threshold)
        curve.append(
            {
                "threshold": threshold,
                "real_fpr": fp / max(1, fp + tn),
                "fake_recall": tp / max(1, tp + fn),
            }
        )
    return curve


def select_threshold(
    labels: Sequence[int],
    probabilities: Sequence[float],
    *,
    method: str = "max_f1",
    target_real_fpr: float = 0.01,
    target_fake_recall: float = 0.95,
) -> Dict[str, Any]:
    if len(labels) != len(probabilities) or not labels:
        raise ValueError("threshold selection requires non-empty aligned labels/probabilities")
    curve = threshold_curve(labels, probabilities)
    if method == "target_real_fpr":
        eligible = [point for point in curve if point["real_fpr"] <= target_real_fpr]
        chosen = max(eligible, key=lambda point: (point["fake_recall"], -point["real_fpr"]))
    elif method == "target_fake_recall":
        eligible = [point for point in curve if point["fake_recall"] >= target_fake_recall]
        chosen = min(eligible, key=lambda point: (point["real_fpr"], -point["fake_recall"]))
    elif method == "max_f1":
        def f1(point: Mapping[str, float]) -> float:
            threshold = float(point["threshold"])
            _, fp, fn, tp = _threshold_counts(labels, probabilities, threshold)
            precision = tp / max(1, tp + fp)
            recall = tp / max(1, tp + fn)
            return 2 * precision * recall / max(1e-12, precision + recall)

        chosen = max(curve, key=lambda point: (f1(point), -abs(float(point["threshold"]) - 0.5)))
    else:
        raise ValueError(f"unsupported threshold method: {method}")
    threshold = float(chosen["threshold"])
    if not math.isfinite(threshold):
        threshold = 1.0 if threshold > 0 else 0.0
    return {
        "threshold": threshold,
        "method": method,
        "target_real_fpr": float(target_real_fpr),
        "target_fake_recall": float(target_fake_recall),
        "validation_operating_point": dict(chosen),
        "selected_at": utc_now(),
    }


def compute_binary_metrics(
    labels: Sequence[int],
    probabilities: Sequence[float],
    *,
    threshold: float = 0.5,
    datasets: Optional[Sequence[str]] = None,
    ece_bins: int = 15,
    include_per_dataset: bool = True,
) -> Dict[str, Any]:
    if len(labels) != len(probabilities):
        raise ValueError("labels/probabilities length mismatch")
    if not labels:
        return {"n": 0, "threshold": float(threshold)}
    y = [int(value) for value in labels]
    p = [min(1.0, max(0.0, float(value))) for value in probabilities]
    tn, fp, fn, tp = _threshold_counts(y, p, threshold)
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    accuracy = (tp + tn) / len(y)
    f1 = 2 * precision * recall / max(1e-12, precision + recall)
    brier = sum((prob - label) ** 2 for label, prob in zip(y, p)) / len(y)
    ece = 0.0
    bin_rows = []
    for index in range(int(ece_bins)):
        lower = index / ece_bins
        upper = (index + 1) / ece_bins
        members = [pos for pos, prob in enumerate(p) if lower <= prob < upper or (index == ece_bins - 1 and prob == 1.0)]
        if not members:
            bin_rows.append({"lower": lower, "upper": upper, "count": 0})
            continue
        avg_confidence = sum(p[pos] for pos in members) / len(members)
        fake_rate = sum(y[pos] for pos in members) / len(members)
        ece += len(members) / len(y) * abs(avg_confidence - fake_rate)
        bin_rows.append(
            {
                "lower": lower,
                "upper": upper,
                "count": len(members),
                "avg_probability": avg_confidence,
                "fake_rate": fake_rate,
            }
        )
    curve = threshold_curve(y, p)
    fixed_fpr = {}
    for target in (0.001, 0.01, 0.05):
        eligible = [point for point in curve if point["real_fpr"] <= target]
        fixed_fpr[str(target)] = max((point["fake_recall"] for point in eligible), default=0.0)
    fixed_recall = {}
    for target in (0.90, 0.95, 0.99):
        eligible = [point for point in curve if point["fake_recall"] >= target]
        fixed_recall[str(target)] = min((point["real_fpr"] for point in eligible), default=None)
    metrics: Dict[str, Any] = {
        "n": len(y),
        "auc": _auc_rank(y, p),
        "roc_auc": _auc_rank(y, p),
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "real_fpr": fp / max(1, fp + tn),
        "fake_fnr": fn / max(1, fn + tp),
        "brier_score": brier,
        "ece": ece,
        "confusion_matrix": [[tn, fp], [fn, tp]],
        "threshold": float(threshold),
        "fake_recall_at_fixed_real_fpr": fixed_fpr,
        "real_fpr_at_fixed_fake_recall": fixed_recall,
        "confidence_histogram": bin_rows,
        "sample_counts": {"real": sum(label == 0 for label in y), "fake": sum(label == 1 for label in y)},
    }
    if datasets is not None:
        if len(datasets) != len(y):
            raise ValueError("datasets length mismatch")
        metrics["per_source_sample_counts"] = dict(sorted(Counter(str(value) for value in datasets).items()))
        if include_per_dataset:
            grouped: Dict[str, List[int]] = defaultdict(list)
            for index, name in enumerate(datasets):
                grouped[str(name)].append(index)
            metrics["per_dataset"] = {
                name: compute_binary_metrics(
                    [y[index] for index in indices],
                    [p[index] for index in indices],
                    threshold=threshold,
                    datasets=None,
                    ece_bins=ece_bins,
                    include_per_dataset=False,
                )
                for name, indices in sorted(grouped.items())
            }
    return metrics


def estimate_full_runtime(
    *,
    record_counts: Mapping[str, int],
    expert_benchmarks: Mapping[str, Mapping[str, float]],
    fusion_benchmark: Mapping[str, float],
    expert_epochs: int = 1,
    fusion_epochs: int = 4,
    measured_overheads_seconds: Optional[Mapping[str, float]] = None,
    safety_buffer_fraction: float = 0.15,
) -> Dict[str, Any]:
    correction_records = int(record_counts["real_correction_train"])
    fusion_records = int(record_counts["balanced_core_train"])
    components: Dict[str, float] = {}
    expert_details = {}
    for expert, benchmark in expert_benchmarks.items():
        effective_batch = max(1, int(benchmark.get("effective_batch_size", 1)))
        steps = math.ceil(correction_records / effective_batch)
        step_seconds = float(benchmark.get("avg_total_seconds_per_step") or benchmark["avg_seconds_per_step"])
        seconds = steps * step_seconds * int(expert_epochs)
        components[f"expert_{expert}"] = seconds
        expert_details[expert] = {"steps_per_epoch": steps, "seconds": seconds, "epochs": int(expert_epochs)}
    fusion_batch = max(1, int(fusion_benchmark.get("effective_batch_size", 1)))
    fusion_steps = math.ceil(fusion_records / fusion_batch)
    fusion_seconds = fusion_steps * float(fusion_benchmark["avg_seconds_per_step"]) * int(fusion_epochs)
    components["fusion_train"] = fusion_seconds
    for name, seconds in (measured_overheads_seconds or {}).items():
        components[str(name)] = float(seconds)
    subtotal = sum(components.values())
    safety = subtotal * float(safety_buffer_fraction)
    total = subtotal + safety
    return {
        "created_at": utc_now(),
        "record_counts": dict(record_counts),
        "expert_details": expert_details,
        "fusion_details": {
            "steps_per_epoch": fusion_steps,
            "seconds": fusion_seconds,
            "epochs": int(fusion_epochs),
        },
        "components_seconds": components,
        "subtotal_seconds": subtotal,
        "safety_buffer_fraction": float(safety_buffer_fraction),
        "safety_buffer_seconds": safety,
        "total_seconds": total,
        "total_hours": total / 3600.0,
    }


def enforce_runtime_cap(estimate: Mapping[str, Any], max_hours: float, allow_over_cap: bool = False) -> None:
    total = float(estimate["total_hours"])
    if total > float(max_hours) and not allow_over_cap:
        raise RuntimeError(f"measured runtime estimate {total:.2f}h exceeds cap {float(max_hours):.2f}h")


def checkpoint_fingerprint(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_expert_cache(
    root: str | Path,
    *,
    expected_split_counts: Optional[Mapping[str, int]] = None,
    required_experts: Sequence[str] = ("micro", "mid", "long", "extra_long"),
    exact_expert_order: Optional[Sequence[str]] = None,
    verify_arrays: bool = True,
) -> Dict[str, Any]:
    cache_root = Path(root)
    manifest = cache_root / "cache_manifest.jsonl"
    meta_path = cache_root / "cache_meta.json"
    if not manifest.is_file() or not meta_path.is_file() or not (cache_root / "READY").is_file():
        raise PackError(f"expert cache is incomplete: {cache_root}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    metadata_experts = [str(value) for value in meta.get("expert_names", [])]
    if exact_expert_order is not None and metadata_experts != [str(value) for value in exact_expert_order]:
        raise PackError(
            "expert cache order mismatch: "
            f"expected={list(exact_expert_order)} actual={metadata_experts}"
        )
    fingerprints = meta.get("expert_checkpoint_fingerprints", {})
    missing_fingerprints = [name for name in required_experts if not fingerprints.get(name)]
    if missing_fingerprints:
        raise PackError(f"expert cache is missing checkpoint fingerprints: {missing_fingerprints}")
    source_fingerprints = meta.get("source_manifest_fingerprints", {})
    if not source_fingerprints:
        raise PackError("expert cache is missing source manifest fingerprints")
    counts = Counter()
    sample_ids = set()
    shards: Dict[str, Dict[str, Any]] = {}
    with manifest.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            sample_id = str(row.get("sample_id") or row.get("record_hash") or "")
            if not sample_id:
                raise PackError(f"cache manifest line {line_no} is missing sample_id")
            if sample_id in sample_ids:
                raise PackError(f"duplicate cache sample_id: {sample_id}")
            sample_ids.add(sample_id)
            if row.get("label") not in (0, 1):
                raise PackError(f"cache manifest line {line_no} has invalid label")
            if not row.get("dataset"):
                raise PackError(f"cache manifest line {line_no} is missing source dataset")
            split = str(row.get("split"))
            counts[split] += 1
            shard = str(row.get("shard_path", ""))
            if not shard:
                raise PackError(f"cache manifest line {line_no} is missing shard_path")
            row_index = int(row.get("row_index", -1))
            shard_stats = shards.setdefault(
                shard,
                {"min": row_index, "max": row_index, "count": 0, "sum": 0, "sum_sq": 0, "rows": []},
            )
            shard_stats["min"] = min(shard_stats["min"], row_index)
            shard_stats["max"] = max(shard_stats["max"], row_index)
            shard_stats["count"] += 1
            shard_stats["sum"] += row_index
            shard_stats["sum_sq"] += row_index * row_index
            shard_stats["rows"].append(
                (row_index, sample_id, int(row["label"]), str(row["dataset"]))
            )
    if expected_split_counts:
        for split, expected in expected_split_counts.items():
            if counts[split] != int(expected):
                raise PackError(f"cache split {split} count mismatch: expected={expected} actual={counts[split]}")
    if verify_arrays:
        import numpy as np

        for shard, index_stats in shards.items():
            path = cache_root / shard
            if not path.is_file():
                raise PackError(f"cache shard is missing: {path}")
            with np.load(path, allow_pickle=False) as data:
                for field in ("labels", "sample_ids", "datasets", "expert_names", "embeddings", "logits", "probabilities"):
                    if field not in data.files:
                        raise PackError(f"cache shard {shard} is missing {field}")
                names = [str(value) for value in data["expert_names"].tolist()]
                if exact_expert_order is not None and names != [str(value) for value in exact_expert_order]:
                    raise PackError(
                        f"cache shard {shard} expert order mismatch: "
                        f"expected={list(exact_expert_order)} actual={names}"
                    )
                missing = [name for name in required_experts if name not in names]
                if missing:
                    raise PackError(f"cache shard {shard} is missing experts: {missing}")
                rows = int(data["labels"].shape[0])
                expected_sum = rows * (rows - 1) // 2
                expected_sum_sq = rows * (rows - 1) * (2 * rows - 1) // 6
                if (
                    index_stats["min"] < 0
                    or index_stats["max"] >= rows
                    or index_stats["count"] != rows
                    or index_stats["sum"] != expected_sum
                    or index_stats["sum_sq"] != expected_sum_sq
                ):
                    raise PackError(f"cache manifest has out-of-range row index for {shard}")
                if data["embeddings"].shape[:2] != (rows, len(names)):
                    raise PackError(f"cache embedding shape mismatch in {shard}")
                if data["logits"].shape != (rows, len(names)):
                    raise PackError(f"cache logit shape mismatch in {shard}")
                if data["probabilities"].shape != (rows, len(names)):
                    raise PackError(f"cache probability shape mismatch in {shard}")
                ordered = sorted(index_stats["rows"], key=lambda value: value[0])
                manifest_ids = [value[1] for value in ordered]
                manifest_labels = [value[2] for value in ordered]
                manifest_datasets = [value[3] for value in ordered]
                if [str(value) for value in data["sample_ids"].tolist()] != manifest_ids:
                    raise PackError(f"cache sample IDs do not match the manifest in {shard}")
                if [int(value) for value in data["labels"].tolist()] != manifest_labels:
                    raise PackError(f"cache labels do not match the manifest in {shard}")
                if [str(value) for value in data["datasets"].tolist()] != manifest_datasets:
                    raise PackError(f"cache datasets do not match the manifest in {shard}")
                for field in ("embeddings", "logits", "probabilities"):
                    if not np.isfinite(data[field]).all():
                        raise PackError(f"cache shard {shard} contains non-finite {field}")
                probabilities = data["probabilities"]
                if bool(((probabilities < 0.0) | (probabilities > 1.0)).any()):
                    raise PackError(f"cache shard {shard} has probabilities outside [0, 1]")
    return {
        "root": str(cache_root.resolve()),
        "counts": dict(sorted(counts.items())),
        "total": sum(counts.values()),
        "shards": len(shards),
        "expert_checkpoint_fingerprints": fingerprints,
        "source_manifest_fingerprints": source_fingerprints,
        "validated_at": utc_now(),
    }


def repeat_cached_probe_batch(
    batch: Mapping[str, Any],
    batch_size: int,
    repeat_tree: Any,
) -> Dict[str, Any]:
    """Repeat sample tensors while preserving expert-axis metadata once.

    ``expert_names`` describes tensor dimension 1, not batch dimension 0. A
    generic tree repeat therefore must not multiply this list as it does the
    per-sample ``datasets`` list.
    """

    repeated = dict(repeat_tree(dict(batch), int(batch_size)))
    names = [str(value) for value in batch.get("expert_names", [])]
    if not names:
        raise PackError("cached fusion probe batch has no expert_names")
    repeated["expert_names"] = names
    return repeated


def recover_completed_cache_shards(
    split_dir: str | Path,
    *,
    required_experts: Sequence[str],
) -> Dict[str, Any]:
    """Return only complete, internally consistent cache shard pairs.

    A runtime can disappear between mirroring a JSONL sidecar and its NPZ
    payload. Treating that sidecar as completed would skip source samples and
    later poison the global cache manifest. This audit verifies both halves of
    every restored shard and ignores incomplete/corrupt pairs without deleting
    them; the skipped samples are regenerated into a new shard number.
    """

    import numpy as np

    root = Path(split_dir)
    sidecars = sorted(root.glob("cache-*.jsonl"))
    all_indices: List[int] = []
    for path in [*sidecars, *root.glob("cache-*.npz")]:
        try:
            all_indices.append(int(path.stem.split("-")[-1]))
        except (TypeError, ValueError):
            continue

    valid_sidecars: List[Path] = []
    completed_ids: set[str] = set()
    ignored: List[Dict[str, str]] = []
    for sidecar in sidecars:
        shard_path = sidecar.with_suffix(".npz")
        try:
            rows = [json.loads(line) for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
            if not rows:
                raise PackError("empty sidecar")
            row_ids = [str(row.get("sample_id") or "") for row in rows]
            if any(not sample_id for sample_id in row_ids):
                raise PackError("sidecar row is missing sample_id")
            if len(set(row_ids)) != len(row_ids):
                raise PackError("sidecar contains duplicate sample IDs")
            duplicates = completed_ids.intersection(row_ids)
            if duplicates:
                raise PackError(f"sample IDs duplicate an earlier shard: {sorted(duplicates)[:3]}")
            row_indices = [int(row.get("row_index", -1)) for row in rows]
            if row_indices != list(range(len(rows))):
                raise PackError("sidecar row indexes are not contiguous")
            expected_relative = f"{root.name}/{shard_path.name}"
            if any(str(row.get("shard_path", "")) != expected_relative for row in rows):
                raise PackError(f"sidecar shard_path does not match {expected_relative}")
            if not shard_path.is_file():
                raise PackError(f"NPZ payload is missing: {shard_path.name}")
            with np.load(shard_path, allow_pickle=False) as data:
                required_fields = (
                    "labels",
                    "sample_ids",
                    "datasets",
                    "expert_names",
                    "embeddings",
                    "logits",
                    "probabilities",
                )
                missing = [field for field in required_fields if field not in data.files]
                if missing:
                    raise PackError(f"NPZ is missing fields: {missing}")
                names = [str(value) for value in data["expert_names"].tolist()]
                missing_experts = [name for name in required_experts if name not in names]
                if missing_experts:
                    raise PackError(f"NPZ is missing experts: {missing_experts}")
                npz_ids = [str(value) for value in data["sample_ids"].tolist()]
                if npz_ids != row_ids:
                    raise PackError("NPZ sample IDs do not match the sidecar")
                labels = data["labels"]
                if int(labels.shape[0]) != len(rows):
                    raise PackError("NPZ row count does not match the sidecar")
                if [int(value) for value in labels.tolist()] != [int(row["label"]) for row in rows]:
                    raise PackError("NPZ labels do not match the sidecar")
                if [str(value) for value in data["datasets"].tolist()] != [str(row["dataset"]) for row in rows]:
                    raise PackError("NPZ datasets do not match the sidecar")
                if data["embeddings"].shape[:2] != (len(rows), len(names)):
                    raise PackError("NPZ embedding shape is inconsistent")
                if data["logits"].shape != (len(rows), len(names)):
                    raise PackError("NPZ logit shape is inconsistent")
                if data["probabilities"].shape != (len(rows), len(names)):
                    raise PackError("NPZ probability shape is inconsistent")
                for field in ("embeddings", "logits", "probabilities"):
                    if not np.isfinite(data[field]).all():
                        raise PackError(f"NPZ contains non-finite {field}")
                probabilities = data["probabilities"]
                if bool(((probabilities < 0.0) | (probabilities > 1.0)).any()):
                    raise PackError("NPZ probabilities are outside [0, 1]")
            completed_ids.update(row_ids)
            valid_sidecars.append(sidecar)
        except Exception as exc:
            ignored.append(
                {
                    "sidecar": str(sidecar),
                    "payload": str(shard_path),
                    "reason": f"{type(exc).__name__}: {exc}",
                }
            )

    return {
        "valid_sidecars": valid_sidecars,
        "completed_ids": completed_ids,
        "next_shard": max(all_indices, default=-1) + 1,
        "ignored": ignored,
    }
