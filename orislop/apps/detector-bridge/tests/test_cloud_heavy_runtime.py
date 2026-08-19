from __future__ import annotations

import json
import importlib.util
import math
import numpy as np
from pathlib import Path
import sys
import unittest
from unittest import mock
import threading
from types import SimpleNamespace
from PIL import Image


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BRIDGE_ROOT.parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import torch
from cloud_heavy_runtime import (
    AegisMotionDetector,
    CloudHeavyRuntime,
    FrameBundle,
    calibrate_motion,
    combine_spatial_family,
    consensus_decision,
)


class CloudHeavyRuntimeContractTests(unittest.TestCase):
    def test_independent_visual_components_run_concurrently(self) -> None:
        barrier = threading.Barrier(3, timeout=2)

        class Scheduler:
            def plan(self):
                return SimpleNamespace(component_workers=3)

            def record_run(self, _parallel):
                return None

            def record_oom(self):
                raise AssertionError("unexpected OOM")

        class Custom:
            def analyze_images(self, images):
                barrier.wait()
                return [0.8 for _ in images]

        class Public:
            def analyze(self, images):
                barrier.wait()
                return {"ai_probability": 0.8, "frame_probabilities": [0.8 for _ in images]}

        class Motion:
            def analyze(self, frames):
                barrier.wait()
                return {"raw_logit": math.log(0.8 / 0.2), "raw_probability": 0.8}

        runtime = CloudHeavyRuntime.__new__(CloudHeavyRuntime)
        runtime.config = json.loads((REPO_ROOT / "configs" / "cloud_heavy_v1.json").read_text(encoding="utf-8"))
        runtime.custom_spatial = Custom()
        runtime.public_detector = Public()
        runtime.motion_detector = Motion()
        runtime.device = torch.device("cpu")
        runtime.scheduler = Scheduler()
        runtime.rollout_mode = "shadow"
        frame = np.zeros((32, 32, 3), dtype=np.uint8)
        bundle = FrameBundle(
            rgb_frames=tuple(frame.copy() for _ in range(16)),
            spatial_images=tuple(Image.fromarray(frame) for _ in range(5)),
            frame_indices=tuple(range(16)),
            spatial_indices=tuple(range(5)),
            source_fps=25.0,
            duration_seconds=4.0,
            window_start_seconds=0.0,
            window_end_seconds=4.0,
        )
        with mock.patch("cloud_heavy_runtime.decode_frame_bundle", return_value=bundle):
            result = runtime.analyze_video("unused.mp4", component_workers=3)
        self.assertEqual(result["execution"]["mode"], "concurrent")
        self.assertEqual(result["execution"]["componentWorkers"], 3)
        self.assertAlmostEqual(result["spatialFamilyProbability"], 0.8, places=6)

    def test_spatial_calibration_treats_frame_models_as_one_family(self) -> None:
        combined = combine_spatial_family(0.8, 0.8, {
            "intercept": 0.0,
            "customCoefficient": 0.5,
            "publicCoefficient": 0.5,
        })
        self.assertAlmostEqual(combined, 0.8, places=6)

    def test_motion_temperature_operates_on_logit(self) -> None:
        raw_logit = math.log(0.8 / 0.2)
        self.assertAlmostEqual(calibrate_motion(raw_logit, 1.0), 0.8, places=6)
        self.assertLess(calibrate_motion(raw_logit, 2.0), 0.8)

    def test_single_detector_spike_always_fails_open(self) -> None:
        spatial_only = consensus_decision(0.99, 0.2, 0.8, 0.8, rollout_mode="aggressive", language="en")
        motion_only = consensus_decision(0.2, 0.99, 0.8, 0.8, rollout_mode="aggressive", language="en")
        self.assertFalse(spatial_only["automaticSkipEligible"])
        self.assertFalse(motion_only["automaticSkipEligible"])
        self.assertTrue(spatial_only["consensusBasis"]["singleDetectorSpikeFailsOpen"])

    def test_non_english_and_shadow_mode_never_auto_hide(self) -> None:
        shadow = consensus_decision(0.99, 0.99, 0.8, 0.8, rollout_mode="shadow", language="en")
        non_english = consensus_decision(0.99, 0.99, 0.8, 0.8, rollout_mode="aggressive", language="es")
        self.assertTrue(shadow["synthetic"])
        self.assertFalse(shadow["automaticSkipEligible"])
        self.assertFalse(non_english["automaticSkipEligible"])

    def test_pins_and_uncalibrated_shadow_default_are_committed(self) -> None:
        config = json.loads((REPO_ROOT / "configs" / "cloud_heavy_v1.json").read_text(encoding="utf-8"))
        self.assertEqual(config["models"]["publicFrame"]["revision"], "adf169cf452ea42f80d8cdca1302c8c9d09d1725")
        self.assertEqual(config["models"]["motion"]["revision"], "95b71346cec650165e6ad3fb20ed9e80f4b6702a")
        self.assertEqual(config["models"]["motion"]["frames"], 16)
        self.assertEqual(config["latencyTargets"]["warmHeavyP95Ms"], 2000)
        self.assertFalse(config["calibrated"])
        self.assertFalse(config["betaGatePassed"])

    def test_vendored_motion_wrapper_matches_pinned_upstream_contract(self) -> None:
        upstream_path = REPO_ROOT / ".cache" / "open-source-eval" / "aegis-code" / "src" / "branches" / "motion_branch.py"
        if not upstream_path.is_file():
            self.skipTest("local upstream parity fixture is unavailable")
        vendored_path = BRIDGE_ROOT / "third_party" / "aegis" / "src" / "branches" / "motion_branch.py"
        upstream = load_module("aegis_upstream_parity", upstream_path)
        vendored = load_module("aegis_vendored_parity", vendored_path)
        upstream_state = upstream.MotionBranch(output_dim=512).state_dict()
        vendored_state = vendored.MotionBranch(output_dim=512).state_dict()
        self.assertEqual(list(upstream_state), list(vendored_state))
        self.assertEqual(
            {key: tuple(value.shape) for key, value in upstream_state.items()},
            {key: tuple(value.shape) for key, value in vendored_state.items()},
        )

    def test_motion_preprocessing_matches_benchmark_imagenet_contract(self) -> None:
        class CaptureBranch:
            def __init__(self):
                self.frames = None

            def __call__(self, frames):
                self.frames = frames.detach().clone()
                return {"motion_features": torch.zeros((1, 512))}

        detector = AegisMotionDetector.__new__(AegisMotionDetector)
        detector.config = {"frames": 16, "repoId": "aegis", "revision": "pinned"}
        detector.device = torch.device("cpu")
        detector.motion_branch = CaptureBranch()
        detector.motion_head = lambda _features: torch.zeros((1, 1))
        detector.analyze([np.zeros((32, 32, 3), dtype=np.uint8) for _ in range(16)])
        expected = torch.tensor([-0.485 / 0.229, -0.456 / 0.224, -0.406 / 0.225])
        self.assertTrue(torch.allclose(detector.motion_branch.frames[0, 0, :, 0, 0], expected, atol=1e-6))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    unittest.main()
