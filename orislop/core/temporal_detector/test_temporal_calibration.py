from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile
import unittest

import temporal_deepfake_moe_hf_colab as temporal


class TemporalCalibrationTests(unittest.TestCase):
    def test_validation_and_test_overlap_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            validation = root / "validation.jsonl"
            test = root / "test.jsonl"
            validation.write_text(
                json.dumps({"split": "val", "video_path": "same.npz", "label": 0}) + "\n",
                encoding="utf-8",
            )
            test.write_text(
                json.dumps({"split": "test", "video_path": "same.npz", "label": 0}) + "\n",
                encoding="utf-8",
            )
            args = argparse.Namespace(validation_manifest=str(validation), test_manifest=str(test))
            with self.assertRaisesRegex(RuntimeError, "Calibration leakage"):
                temporal.assert_validation_test_disjoint(args, validation)

    def test_disjoint_validation_and_test_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            validation = root / "validation.jsonl"
            test = root / "test.jsonl"
            validation.write_text(
                json.dumps({"split": "val", "video_path": "validation.npz", "label": 0}) + "\n",
                encoding="utf-8",
            )
            test.write_text(
                json.dumps({"split": "test", "video_path": "test.npz", "label": 1}) + "\n",
                encoding="utf-8",
            )
            args = argparse.Namespace(validation_manifest=str(validation), test_manifest=str(test))
            temporal.assert_validation_test_disjoint(args, validation)


if __name__ == "__main__":
    unittest.main()
