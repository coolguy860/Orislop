from __future__ import annotations

import ast
from pathlib import Path
import sys
import threading
import time
import types
import unittest


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

from resource_scheduler import ExecutionStrategy, is_cuda_oom


METHODS = {
    "_heavy_output_signature",
    "_heavy_signatures_match",
    "_visual_used_oom_retry",
    "_autotune_heavy_execution",
}


def load_orchestration_class():
    tree = ast.parse((BRIDGE_ROOT / "server.py").read_text(encoding="utf-8"))
    detector = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "DetectorService"
    )
    selected = [node for node in detector.body if isinstance(node, ast.FunctionDef) and node.name in METHODS]
    if {node.name for node in selected} != METHODS:
        raise AssertionError("Could not extract every autotune orchestration method from server.py")
    harness = ast.ClassDef(
        name="ExtractedAutotuneHarness",
        bases=[],
        keywords=[],
        body=selected,
        decorator_list=[],
    )
    module = ast.fix_missing_locations(ast.Module(body=[harness], type_ignores=[]))
    namespace = {
        "Any": object,
        "Path": Path,
        "ExecutionStrategy": ExecutionStrategy,
        "clean_text": lambda value, limit: str(value)[:limit],
        "is_cuda_oom": is_cuda_oom,
        "time": time,
    }
    exec(compile(module, str(BRIDGE_ROOT / "server.py"), "exec"), namespace)
    return namespace["ExtractedAutotuneHarness"]


ExtractedAutotuneHarness = load_orchestration_class()


class FakeScheduler:
    autotune_max_seconds = 240
    autotune_warmup = False
    autotune_repeats = 2
    autotune_output_tolerance = 0.002

    def __init__(self) -> None:
        self.tuned = False
        self.ooms = 0
        self.observations = []
        self.lock = threading.Lock()

    def begin_autotune(self):
        return self.lock

    def needs_autotune(self):
        return not self.tuned

    def mark_autotune_running(self):
        return None

    def mark_autotune_skipped(self, _message):
        self.tuned = True

    def candidate_strategies(self):
        return (
            ExecutionStrategy("sequential", False, 1, 0.0),
            ExecutionStrategy("temporal_visual_overlap", True, 1, 4.0),
            ExecutionStrategy("visual_components_2", False, 2, 3.0),
            ExecutionStrategy("full_overlap_2", True, 2, 6.0),
        )

    def record_oom(self):
        self.ooms += 1

    def commit_autotune(self, observations):
        self.tuned = True
        self.observations = observations
        valid = [item for item in observations if item["accepted"] and item["samplesMs"]]
        selected = min(valid, key=lambda item: sum(item["samplesMs"]) / len(item["samplesMs"]))
        return next(strategy for strategy in self.candidate_strategies() if strategy.name == selected["strategy"])


class OrchestrationTests(unittest.TestCase):
    def harness(self):
        instance = ExtractedAutotuneHarness()
        instance.scheduler = FakeScheduler()
        instance.cloud_preempt_exception = None
        instance._reset_cuda_peak_memory = lambda: None
        instance._cuda_peak_memory_gib = lambda: {"allocated": 4.0, "reserved": 5.0}
        instance._clear_cuda_after_failure = lambda: None
        return instance

    @staticmethod
    def result_for(strategy, *, changed=False):
        temporal_probability = 0.42 if not changed else 0.47
        temporal = {
            "available": True,
            "fake_probability": temporal_probability,
            "temporal_probability": 0.41,
            "temporal_av_probability": 0.42,
            "escalation_stage": 0,
        }
        visual = {
            "available": True,
            "spatialFamilyProbability": 0.31,
            "motionProbability": 0.27,
            "synthetic": False,
            "automaticSkipEligible": False,
            "execution": {"componentMs": {}},
        }
        latency = {
            "sequential": 100,
            "temporal_visual_overlap": 60,
            "visual_components_2": 75,
            "full_overlap_2": 45,
        }[strategy.name]
        return temporal, visual, {"wallMs": latency, "strategy": strategy.name}

    def test_fastest_output_equivalent_strategy_wins(self):
        instance = self.harness()
        final_calls = []

        def execute(_self, _path, _language, _priority, strategy, *, benchmark=False):
            final_calls.append((strategy.name, benchmark))
            return self.result_for(strategy, changed=strategy.name == "full_overlap_2")

        instance._execute_heavy_strategy = types.MethodType(execute, instance)
        _temporal, _visual, execution = instance._autotune_heavy_execution(Path("sample.mp4"), "en", 0)
        self.assertEqual(execution["autotune"]["selectedStrategy"], "temporal_visual_overlap")
        rejected = next(item for item in instance.scheduler.observations if item["strategy"] == "full_overlap_2")
        self.assertFalse(rejected["accepted"])
        self.assertIn("output changed", rejected["reason"])
        self.assertEqual(final_calls[-1], ("temporal_visual_overlap", False))

    def test_oom_layout_is_rejected_without_stopping_remaining_benchmarks(self):
        instance = self.harness()

        def execute(_self, _path, _language, _priority, strategy, *, benchmark=False):
            if strategy.name == "full_overlap_2" and benchmark:
                raise RuntimeError("CUDA out of memory")
            return self.result_for(strategy)

        instance._execute_heavy_strategy = types.MethodType(execute, instance)
        _temporal, _visual, execution = instance._autotune_heavy_execution(Path("sample.mp4"), "en", 0)
        self.assertEqual(execution["autotune"]["selectedStrategy"], "temporal_visual_overlap")
        self.assertEqual(instance.scheduler.ooms, 1)
        rejected = next(item for item in instance.scheduler.observations if item["strategy"] == "full_overlap_2")
        self.assertFalse(rejected["accepted"])


if __name__ == "__main__":
    unittest.main()
