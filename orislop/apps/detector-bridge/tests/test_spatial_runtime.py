from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np
from PIL import Image
import torch
from torch import nn


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

from spatial_runtime import (  # noqa: E402
    AI_MODEL_REVISION,
    CLIP_MODEL_REVISION,
    SPATIAL_CHECKPOINT_FORMAT,
    SPATIAL_ENCODER_CONTRACT,
    VISION_MODEL_ID,
    VISION_MODEL_REVISION,
    SpatialDetector,
    VisionEncoder,
    sample_video_frames,
    validate_spatial_checkpoint,
)


class FakeBackbone(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.config = SimpleNamespace(hidden_size=3)

    def forward(self, pixel_values: torch.Tensor) -> SimpleNamespace:
        batch = pixel_values.shape[0]
        hidden = torch.tensor([[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]]).repeat(batch, 1, 1)
        return SimpleNamespace(last_hidden_state=hidden, pooler_output=torch.full((batch, 3), 999.0))


class SpatialRuntimeTests(unittest.TestCase):
    def test_preview_images_bypass_video_capture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            preview = Path(directory) / "preview.image"
            Image.new("RGB", (16, 16), color=(20, 40, 60)).save(preview, format="JPEG")
            with mock.patch("spatial_runtime.cv2.VideoCapture") as video_capture:
                images = sample_video_frames(preview, max_frames=3)
            video_capture.assert_not_called()
            self.assertEqual(len(images), 1)
            self.assertEqual(images[0].size, (16, 16))

    def test_failed_video_open_releases_capture_handle(self) -> None:
        capture = mock.Mock()
        capture.isOpened.return_value = False
        with mock.patch("spatial_runtime.cv2.VideoCapture", return_value=capture):
            self.assertEqual(sample_video_frames("missing-video.bin", max_frames=3), [])
        capture.release.assert_called_once_with()

    def test_v2_encoder_always_uses_pretrained_cls_token(self) -> None:
        encoder = VisionEncoder(processor=object(), backbone=FakeBackbone())
        result = encoder(torch.zeros(2, 3, 8, 8))
        torch.testing.assert_close(result, torch.tensor([[1.0, 2.0, 3.0], [1.0, 2.0, 3.0]]))

    def test_legacy_unversioned_checkpoint_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Unsafe legacy spatial checkpoint"):
            validate_spatial_checkpoint({"net.0.weight": torch.zeros(1)})

    def test_v2_checkpoint_contract_is_accepted(self) -> None:
        state = {"net.0.weight": torch.zeros(1)}
        payload = {
            "metadata": {
                "format_version": SPATIAL_CHECKPOINT_FORMAT,
                "encoder_contract": SPATIAL_ENCODER_CONTRACT,
                "vision_model_id": VISION_MODEL_ID,
                "vision_model_revision": VISION_MODEL_REVISION,
                "ai_model_revision": AI_MODEL_REVISION,
                "clip_model_revision": CLIP_MODEL_REVISION,
            },
            "fusion_state_dict": state,
        }
        loaded, metadata = validate_spatial_checkpoint(payload)
        self.assertIs(loaded, state)
        self.assertEqual(metadata["encoder_contract"], SPATIAL_ENCODER_CONTRACT)

    def test_spatial_frames_are_batched_through_each_encoder(self) -> None:
        class Batch(dict):
            def to(self, device):
                return Batch({key: value.to(device) for key, value in self.items()})

        class FakeClassifier:
            def __init__(self) -> None:
                self.calls = 0

            def __call__(self, images):
                self.calls += 1
                return [[{"label": "AI generated", "score": 0.8}] for _ in images]

        class FakeClip:
            def __call__(self, **inputs):
                count = inputs["pixel_values"].shape[0]
                return SimpleNamespace(logits_per_image=torch.tensor([[0.0, 1.0]]).repeat(count, 1))

        class FakeVision:
            embedding_dim = 2

            def __init__(self) -> None:
                self.processor = lambda images, return_tensors: {
                    "pixel_values": torch.zeros((len(images), 3, 2, 2))
                }

            def __call__(self, pixels):
                return torch.zeros((pixels.shape[0], 2))

        classifier = FakeClassifier()
        detector = SpatialDetector.__new__(SpatialDetector)
        detector.device = torch.device("cpu")
        detector.ai_classifier = classifier
        detector.ai_classifier_lock = threading.Lock()
        detector.clip_processor = lambda text, images, return_tensors, padding: Batch({
            "pixel_values": torch.zeros((len(images), 3, 2, 2))
        })
        detector.clip = FakeClip()
        detector.vision = FakeVision()
        detector.fusion = lambda features: features[:, -3:-2]
        detector.temperature = 1.0
        detector.cpu_pool = ThreadPoolExecutor(max_workers=2)
        images = [Image.fromarray(np.full((8, 8, 3), index * 20, dtype=np.uint8)) for index in range(5)]
        try:
            probabilities = detector.analyze_images(images)
        finally:
            detector.cpu_pool.shutdown(wait=True)
        self.assertEqual(len(probabilities), 5)
        self.assertEqual(classifier.calls, 1)
        self.assertTrue(all(abs(value - torch.sigmoid(torch.tensor(0.8)).item()) < 1e-6 for value in probabilities))


if __name__ == "__main__":
    unittest.main()
