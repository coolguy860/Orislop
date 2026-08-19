from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

from resource_scheduler import AdaptiveExecutionScheduler, ResourceSnapshot


def snapshot(*, total: float, free: float, cpus: int = 32, ram: float = 64.0) -> ResourceSnapshot:
    return ResourceSnapshot(
        logical_cpus=cpus,
        ram_total_gib=ram,
        ram_available_gib=ram * 0.75,
        cuda_available=True,
        gpu_name="test-gpu",
        vram_total_gib=total,
        vram_free_gib=free,
    )


class AdaptiveExecutionSchedulerTests(unittest.TestCase):
    def test_public_vram_reserve_environment_names_are_honored(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"ORISLOP_GPU_RESERVE_GIB": "5.25", "ORISLOP_GPU_RESERVE_FRACTION": "0.2"},
            clear=False,
        ):
            scheduler = AdaptiveExecutionScheduler()
        self.assertEqual(scheduler.minimum_vram_reserve_gib, 5.25)
        self.assertEqual(scheduler.vram_reserve_fraction, 0.2)

    def build(self, mode: str = "auto", cache_dir: str | Path | None = None) -> AdaptiveExecutionScheduler:
        environment = {
            "ORISLOP_EXECUTION_MODE": mode,
            "ORISLOP_LIGHTWEIGHT_WORKERS": "auto",
            "ORISLOP_OOM_COOLDOWN_SECONDS": "30",
            "ORISLOP_AUTOTUNE_MODE": "first-run",
            "ORISLOP_AUTOTUNE_RESET": "0",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            return AdaptiveExecutionScheduler(cache_dir, model_signature="test-model-v1")

    def test_32_gib_gpu_uses_two_controlled_lanes_when_headroom_is_available(self) -> None:
        scheduler = self.build()
        with mock.patch.object(scheduler, "snapshot", return_value=snapshot(total=32.0, free=10.0)):
            plan = scheduler.plan()
        self.assertTrue(plan.top_level_parallel)
        self.assertEqual(plan.component_workers, 2)

    def test_low_live_vram_forces_sequential_even_on_a_32_gib_gpu(self) -> None:
        scheduler = self.build()
        with mock.patch.object(scheduler, "snapshot", return_value=snapshot(total=32.0, free=6.0)):
            plan = scheduler.plan()
        self.assertFalse(plan.top_level_parallel)
        self.assertEqual(plan.component_workers, 1)

    def test_oom_opens_a_parallel_cooldown_circuit(self) -> None:
        scheduler = self.build()
        scheduler.record_oom()
        with mock.patch.object(scheduler, "snapshot", return_value=snapshot(total=48.0, free=20.0)):
            plan = scheduler.plan()
            status = scheduler.status()
        self.assertFalse(plan.top_level_parallel)
        self.assertGreater(status["counters"]["cooldownSecondsRemaining"], 0)
        self.assertEqual(status["counters"]["oomFallbacks"], 1)

    def test_explicit_sequential_mode_never_parallelizes(self) -> None:
        scheduler = self.build("sequential")
        with mock.patch.object(scheduler, "snapshot", return_value=snapshot(total=96.0, free=80.0)):
            plan = scheduler.plan()
        self.assertFalse(plan.top_level_parallel)
        self.assertEqual(plan.component_workers, 1)

    def test_first_run_benchmarks_every_safe_32_gib_layout(self) -> None:
        scheduler = self.build()
        with mock.patch.object(scheduler, "snapshot", return_value=snapshot(total=32.0, free=12.0)):
            names = [strategy.name for strategy in scheduler.candidate_strategies()]
        self.assertEqual(
            names,
            ["sequential", "temporal_visual_overlap", "visual_components_2", "full_overlap_2"],
        )

    def test_autotune_selects_and_persists_the_fastest_valid_layout(self) -> None:
        hardware = snapshot(total=32.0, free=12.0)
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(AdaptiveExecutionScheduler, "snapshot", return_value=hardware):
                scheduler = self.build(cache_dir=directory)
                winner = scheduler.commit_autotune([
                    {"strategy": "sequential", "accepted": True, "samplesMs": [100, 102]},
                    {"strategy": "temporal_visual_overlap", "accepted": True, "samplesMs": [71, 69]},
                    {"strategy": "visual_components_2", "accepted": True, "samplesMs": [84, 82]},
                    {"strategy": "full_overlap_2", "accepted": False, "samplesMs": [], "reason": "oom"},
                ])
                self.assertEqual(winner.name, "temporal_visual_overlap")
                self.assertTrue((Path(directory) / "execution-autotune-v1.json").is_file())

                restored = self.build(cache_dir=directory)
                self.assertFalse(restored.needs_autotune())
                self.assertEqual(restored.selected_strategy().name, "temporal_visual_overlap")
                self.assertEqual(restored.status()["autotune"]["state"], "cached")

    def test_changed_model_signature_invalidates_cached_benchmark(self) -> None:
        hardware = snapshot(total=32.0, free=12.0)
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(AdaptiveExecutionScheduler, "snapshot", return_value=hardware):
                scheduler = self.build(cache_dir=directory)
                scheduler.commit_autotune([
                    {"strategy": "sequential", "accepted": True, "samplesMs": [100, 101]},
                ])
                with mock.patch.dict(os.environ, {"ORISLOP_AUTOTUNE_MODE": "first-run"}, clear=False):
                    changed = AdaptiveExecutionScheduler(directory, model_signature="test-model-v2")
                self.assertTrue(changed.needs_autotune())
                self.assertEqual(changed.status()["autotune"]["state"], "cache-stale")


if __name__ == "__main__":
    unittest.main()
