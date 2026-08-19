from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import threading
from typing import Any


@dataclass(frozen=True)
class ReleaseGateReport:
    passed: bool
    mode: str
    failures: tuple[str, ...]
    metrics: dict[str, float | int | bool]


class AVRolloutGuard:
    """Fail-closed promotion gate and automatic shadow-mode circuit breaker."""

    def __init__(self, config: dict[str, Any], metadata: dict[str, Any] | None = None) -> None:
        self.rollout = dict(config.get("rollout") or {})
        self.metadata = metadata or {}
        self.lock = threading.RLock()
        self.runtime_decisions = 0
        self.runtime_false_hides = 0
        self.runtime_latency_breaches = 0
        self.integrity_ok = bool(self.metadata.get("integrityVerified", False))
        self.report = self.evaluate()

    @classmethod
    def from_paths(cls, config_path: str | Path, metadata_path: str | Path | None) -> "AVRolloutGuard":
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        metadata: dict[str, Any] = {}
        if metadata_path and Path(metadata_path).is_file():
            metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
        return cls(config, metadata)

    def evaluate(self) -> ReleaseGateReport:
        release = dict(self.metadata.get("releaseGate") or {})
        measured = dict(release.get("metrics") or self.metadata.get("metrics") or {})
        failures: list[str] = []
        if self.metadata.get("promoted") is not True:
            failures.append("artifact_not_promoted")
        if release.get("passed") is not True:
            failures.append("release_gate_not_signed_off")
        if not self.integrity_ok:
            failures.append("artifact_integrity_unverified")
        checks = (
            ("commercialSpeakers", int(self.rollout.get("minimumCommercialSpeakers", 100)), ">="),
            ("commercialHours", float(self.rollout.get("minimumCommercialHours", 50)), ">="),
            ("shadowDecisions", int(self.rollout.get("minimumShadowDecisions", 10_000)), ">="),
            ("avRecall", float(self.rollout.get("minimumAvRecall", 0.95)), ">="),
            ("endToEndRecall", float(self.rollout.get("minimumEndToEndRecall", 0.90)), ">="),
            ("genuineHideRate", float(self.rollout.get("maximumGenuineHideRate", 0.001)), "<="),
            ("expectedCalibrationError", float(self.rollout.get("maximumExpectedCalibrationError", 0.03)), "<="),
            ("initialLatencyP95Ms", float(self.rollout.get("initialLatencyP95Ms", 1500)), "<="),
            ("escalatedLatencyP95Ms", float(self.rollout.get("escalatedLatencyP95Ms", 4000)), "<="),
        )
        for name, boundary, operator in checks:
            value = measured.get(name)
            if not isinstance(value, (int, float)):
                failures.append(f"missing_{name}")
            elif operator == ">=" and float(value) < boundary:
                failures.append(f"{name}_below_gate")
            elif operator == "<=" and float(value) > boundary:
                failures.append(f"{name}_above_gate")
        passed = not failures
        return ReleaseGateReport(passed, "corroborated" if passed else "shadow", tuple(failures), measured)

    def permits_auto_skip(self, language: str = "unknown") -> bool:
        if self.rollout.get("englishOnlyAutoSkip", True) and language not in {"en", "eng", "english"}:
            return False
        with self.lock:
            runtime_bad = self.runtime_false_hide_rate() > float(self.rollout.get("maximumGenuineHideRate", 0.001))
            runtime_bad = runtime_bad or self.runtime_latency_breaches > 0 or not self.integrity_ok
            return self.report.passed and not runtime_bad

    def record_decision(self, *, latency_ms: float, escalated: bool, false_hide: bool = False) -> None:
        boundary_name = "escalatedLatencyP95Ms" if escalated else "initialLatencyP95Ms"
        boundary = float(self.rollout.get(boundary_name, 4000 if escalated else 1500))
        with self.lock:
            self.runtime_decisions += 1
            self.runtime_false_hides += int(false_hide)
            self.runtime_latency_breaches += int(latency_ms > boundary)

    def runtime_false_hide_rate(self) -> float:
        return self.runtime_false_hides / max(1, self.runtime_decisions)

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "mode": "corroborated" if self.permits_auto_skip("en") else "shadow",
                "releaseGatePassed": self.report.passed,
                "failures": list(self.report.failures),
                "runtimeDecisions": self.runtime_decisions,
                "runtimeFalseHideRate": round(self.runtime_false_hide_rate(), 7),
                "runtimeLatencyBreaches": self.runtime_latency_breaches,
                "englishOnlyAutoSkip": bool(self.rollout.get("englishOnlyAutoSkip", True)),
            }
