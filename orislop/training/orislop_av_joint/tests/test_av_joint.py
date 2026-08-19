from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from core.av_joint.media import AVMediaContext, GateThresholds, applicability_reasons, mouth_motion_score
from core.av_joint.rollout import AVRolloutGuard
from training.orislop_av_joint.model import AVJointConfig, CalibratedAVJointExport, OrislopAVJointV1
from training.orislop_av_joint.train import PreparedAVDataset, multitask_loss, rights_report, write_synthetic_cache


ROOT = Path(__file__).resolve().parents[3]


class AVJointTests(unittest.TestCase):
    def test_multitask_forward_backward_and_torchscript_contract(self) -> None:
        config = AVJointConfig(embedding_dim=48, transformer_layers=1, transformer_heads=4, max_faces=2)
        model = OrislopAVJointV1(config)
        mouth = torch.rand(1, 2, 3, 20, 32, 32)
        waveform = torch.rand(1, 16_000)
        mask = torch.ones(1, 2, 20)
        quality = torch.rand(1, 2, 6)
        output = model(mouth, waveform, mask, quality)
        batch = {}
        for name in ("active_speaker", "sync_mismatch", "audio_spoof", "visual_forgery", "joint_forgery"):
            batch[name] = torch.ones(1, 2)
            batch[f"{name}_mask"] = torch.ones(1, 2)
        batch.update({
            "offset": torch.zeros(1, 2, dtype=torch.long),
            "offset_mask": torch.ones(1, 2),
            "segment_forgery": torch.ones(1, 2, 20),
            "segment_forgery_mask": torch.ones(1, 2, 20),
        })
        loss, parts = multitask_loss(output, batch, config.max_offset_frames)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertIn("joint_forgery", parts)
        scripted = torch.jit.script(CalibratedAVJointExport(model.eval(), {}).eval())
        prediction = scripted(mouth, waveform, mask, quality)
        self.assertEqual(tuple(prediction["embedding"].shape), (1, 2, 48))
        self.assertIn("segment_forgery_probabilities", prediction)

    def test_closed_lips_and_missing_audio_are_not_applicable(self) -> None:
        quality = np.asarray([[0.9, 0.8, 0.001, 0.8, 0.1, 0.5]], dtype=np.float32)
        reasons = applicability_reasons(quality, True, GateThresholds())
        self.assertIn("insufficient_mouth_motion", reasons)
        self.assertEqual(applicability_reasons(quality, False, GateThresholds()), ["audio_missing"])
        static_track = np.zeros((3, 10, 16, 16), dtype=np.float32)
        self.assertEqual(mouth_motion_score(static_track, np.ones(10, dtype=np.float32)), 0.0)

    def test_tensor_context_keeps_face_audio_mask_and_quality_contract(self) -> None:
        context = AVMediaContext(
            mouth_tracks=np.zeros((4, 3, 50, 112, 112), dtype=np.float32),
            waveform=np.zeros(32_000, dtype=np.float32),
            track_mask=np.ones((4, 50), dtype=np.float32),
            quality=np.ones((4, 6), dtype=np.float32),
            applicable=True,
        )
        tensors = context.as_tensor_inputs(torch, torch.device("cpu"))
        self.assertEqual(tuple(tensors["mouth_tracks"].shape), (1, 4, 3, 50, 112, 112))
        self.assertEqual(tuple(tensors["waveform"].shape), (1, 32_000))

    def test_prepared_dataset_contract_loads_all_multitask_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "sample.npz"
            write_synthetic_cache(cache, fake=1.0)
            manifest = root / "manifest.jsonl"
            manifest.write_text(json.dumps({
                "preparedPath": cache.name,
                "split": "train",
                "releaseEligible": True,
            }) + "\n", encoding="utf-8")
            sample = PreparedAVDataset(manifest, "train")[0]
            self.assertEqual(tuple(sample["mouth_tracks"].shape), (2, 3, 20, 32, 32))
            self.assertTrue(torch.equal(sample["joint_forgery"], torch.ones(2)))
            self.assertEqual(tuple(sample["segment_forgery"].shape), (2, 20))

    def test_rights_ledger_requires_every_commercial_permission(self) -> None:
        manifest = [{
            "rightsSourceId": "corpus",
            "releaseEligible": True,
            "speakerId": "speaker-1",
            "durationSeconds": 3600,
        }]
        source = {
            "license": "commercial-contract-v1",
            "evidenceUri": "gs://private/contracts/1.pdf",
            "commercialUse": True,
            "modelTraining": True,
            "derivatives": True,
            "documentedConsent": True,
            "approved": True,
            "revoked": False,
        }
        self.assertTrue(rights_report(manifest, {"version": 1, "sources": {"corpus": source}})["passed"])
        source["commercialUse"] = False
        report = rights_report(manifest, {"version": 1, "sources": {"corpus": source}})
        self.assertFalse(report["passed"])
        self.assertTrue(any("commercialUse" in failure for failure in report["failures"]))

    def test_rollout_needs_all_offline_and_shadow_gates(self) -> None:
        config = json.loads((ROOT / "configs" / "av_joint_v1.json").read_text(encoding="utf-8"))
        metadata = {
            "promoted": True,
            "integrityVerified": True,
            "releaseGate": {"passed": True, "metrics": {
                "commercialSpeakers": 100,
                "commercialHours": 50,
                "shadowDecisions": 10_000,
                "avRecall": 0.95,
                "endToEndRecall": 0.90,
                "genuineHideRate": 0.001,
                "expectedCalibrationError": 0.02,
                "initialLatencyP95Ms": 1500,
                "escalatedLatencyP95Ms": 4000,
            }},
        }
        guard = AVRolloutGuard(config, metadata)
        self.assertTrue(guard.permits_auto_skip("en"))
        self.assertFalse(guard.permits_auto_skip("es"))
        guard.record_decision(latency_ms=5000, escalated=True)
        self.assertFalse(guard.permits_auto_skip("en"))


if __name__ == "__main__":
    unittest.main()
