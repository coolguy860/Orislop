from __future__ import annotations

import importlib.util
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

try:
    import torch
    from safetensors.torch import load_file, save_file
except ImportError:
    torch = None
    load_file = None
    save_file = None


SCRIPTS = Path(__file__).resolve().parents[1]


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


publisher = load_script("complete_stack_publisher_test", "colab_build_publish_complete_stack.py")
materializer = load_script("complete_stack_materializer_test", "materialize_complete_stack.py")
base = publisher.import_base_publisher()


class CompleteStackPackagingTests(unittest.TestCase):
    def test_upstream_preflight_resolves_full_revision_and_all_files(self) -> None:
        revision = "c" * 40
        models = ({"repo": "owner/upstream", "revision": "short", "files": ("a", "b")},)

        class Api:
            def model_info(self, **kwargs):
                self.kwargs = kwargs
                return SimpleNamespace(
                    sha=revision,
                    siblings=(SimpleNamespace(rfilename="a"), SimpleNamespace(rfilename="b")),
                )

        api = Api()
        with patch.object(publisher, "UPSTREAM_MODELS", models):
            resolved = publisher.resolve_upstream_revisions(api)
        self.assertEqual(resolved, {"owner/upstream": revision})
        self.assertEqual(api.kwargs["revision"], "short")

    def test_upstream_preflight_rejects_missing_file(self) -> None:
        models = ({"repo": "owner/upstream", "revision": "short", "files": ("a", "b")},)

        class Api:
            def model_info(self, **_kwargs):
                return SimpleNamespace(
                    sha="d" * 40,
                    siblings=(SimpleNamespace(rfilename="a"),),
                )

        with patch.object(publisher, "UPSTREAM_MODELS", models):
            with self.assertRaisesRegex(publisher.CompleteStackError, "missing files.*b"):
                publisher.resolve_upstream_revisions(Api())

    def test_yunet_download_requires_pinned_size_and_hash(self) -> None:
        payload = b"synthetic-onnx-for-integrity-test"
        expected = hashlib.sha256(payload).hexdigest()

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "yunet.onnx"
            with (
                patch.object(publisher, "YUNET_BYTES", len(payload)),
                patch.object(publisher, "YUNET_SHA256", expected),
                patch("urllib.request.urlopen", return_value=Response(payload)),
            ):
                digest, receipt = publisher.download_yunet(destination)
            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(digest, expected)
            self.assertEqual(receipt["sourceRevision"], publisher.YUNET_GITHUB_COMMIT)

    def test_yunet_download_rejects_and_removes_bad_payload(self) -> None:
        payload = b"not-the-model"

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "yunet.onnx"
            with patch("urllib.request.urlopen", return_value=Response(payload)):
                with self.assertRaises(publisher.CompleteStackError):
                    publisher.download_yunet(destination)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name(destination.name + ".part").exists())

    def test_upload_uses_resumable_folder_api_and_returns_commit(self) -> None:
        revision = "b" * 40

        class Api:
            def create_repo(self, **kwargs):
                self.create_kwargs = kwargs

            def upload_folder(self, **kwargs):
                self.upload_kwargs = kwargs

            def model_info(self, **kwargs):
                self.model_info_kwargs = kwargs
                return SimpleNamespace(sha=revision)

        with tempfile.TemporaryDirectory() as temporary:
            api = Api()
            result = publisher.upload_release(api, "owner/model", Path(temporary), private=True)
        self.assertEqual(result, revision)
        self.assertTrue(api.create_kwargs["private"])
        self.assertEqual(api.upload_kwargs["repo_type"], "model")
        self.assertIn("**/*.pyc", api.upload_kwargs["ignore_patterns"])

    def test_dataset_revision_uses_fallback_api(self) -> None:
        revision = "a" * 40

        class Api:
            def dataset_info(self, **_kwargs):
                raise RuntimeError("primary unavailable")

            def repo_info(self, **kwargs):
                self.repo_info_kwargs = kwargs
                return SimpleNamespace(sha=revision)

        api = Api()
        result = publisher.resolve_training_dataset(api)
        self.assertTrue(result["revisionResolved"])
        self.assertEqual(result["revision"], revision)
        self.assertEqual(result["resolutionMethod"], "repo_info(dataset)")
        self.assertEqual(api.repo_info_kwargs["repo_type"], "dataset")
        self.assertEqual(len(result["resolutionErrors"]), 1)

    def test_dataset_revision_failure_is_recorded_without_aborting(self) -> None:
        class Api:
            def dataset_info(self, **_kwargs):
                raise PermissionError("private or inaccessible")

            def repo_info(self, **_kwargs):
                raise ConnectionError("network unavailable")

        result = publisher.resolve_training_dataset(Api())
        self.assertFalse(result["revisionResolved"])
        self.assertIsNone(result["revision"])
        self.assertEqual(len(result["resolutionErrors"]), 2)

    @unittest.skipUnless(torch is not None and save_file is not None, "PyTorch+safetensors required")
    def test_temporal_spatial_expert_is_embedded_under_wrapper_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "final_model_package"
            package.mkdir()
            weights = package / "final_model.safetensors"
            save_file({
                "micro.weight": torch.ones(1),
                "mid.weight": torch.ones(1),
                "long.weight": torch.ones(1),
                "extra_long.weight": torch.ones(1),
                "fusion.weight": torch.ones(1),
                "temperature.temperature": torch.ones(1),
            }, str(weights))
            (package / "config.json").write_text("{}\n", encoding="utf-8")
            spatial = root / "spatial_best.pt"
            torch.save({"model_state": {"cnn.0.weight": torch.arange(3)}}, spatial)
            expected = publisher.sha256_file(spatial)

            receipt = publisher.augment_temporal_spatial(base, package, spatial, expected)

            state = load_file(str(weights), device="cpu")
            self.assertIn("spatial.stub.cnn.0.weight", state)
            self.assertEqual(receipt["sourceSha256"], expected)
            config = json.loads((package / "config.json").read_text(encoding="utf-8"))
            self.assertTrue(config["use_spatial"])
            manifest = json.loads((package / "artifact_manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["components"]["spatial"])

    @unittest.skipUnless(torch is not None and save_file is not None, "PyTorch+safetensors required")
    def test_phase2_proof_requires_tensor_identity_and_uses_real_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary)
            save_file({
                "fusion.weight": torch.tensor([1.0, 2.0]),
                "temperature.temperature": torch.tensor([0.75]),
            }, str(package / "final_model.safetensors"))
            fusion = package / "stage2_fusion_best.pt"
            calibration = package / "stage3_calibration.pt"
            torch.save({"model_state": {"weight": torch.tensor([1.0, 2.0])}}, fusion)
            torch.save({
                "expert": "temperature",
                "model_state": {"temperature": torch.tensor([0.75])},
            }, calibration)

            target = publisher.prove_phase2_matches_promoted(base, package, fusion, calibration)
            self.assertEqual(target, "temperature")

            torch.save({"model_state": {"weight": torch.tensor([9.0, 2.0])}}, fusion)
            with self.assertRaises(publisher.CompleteStackError):
                publisher.prove_phase2_matches_promoted(base, package, fusion, calibration)

    def test_materializer_rejects_tampered_manifest_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "artifact.bin"
            artifact.write_bytes(b"verified")
            manifest = {
                "artifactType": "orislop-complete-runnable-stack",
                "files": {
                    "artifact.bin": {
                        "sha256": materializer.sha256_file(artifact),
                        "bytes": artifact.stat().st_size,
                    }
                },
            }
            materializer.verify(root, manifest)
            artifact.write_bytes(b"tampered")
            with self.assertRaises(materializer.MaterializeError):
                materializer.verify(root, manifest)

    def test_materializer_generates_every_local_runtime_binding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = (
                "orislop/temporal/final_model_package/final_model.safetensors",
                "orislop/av/orislop_av_joint_v1.ts",
                "orislop/av/orislop_av_joint_v1.json",
                "orislop/av/face_detection_yunet_2023mar.onnx",
                "orislop/temporal/phase2_av/stage2_temporal_av_fusion.pt",
                "orislop/temporal/phase2_av/stage3_temporal_av_calibration.pt",
                "orislop/spatial/standalone/fusion_model_cls_v2.pt",
                "upstream/aegis-motion/checkpoint_best.pt",
                "upstream/qwen2.5-1.5b-instruct-gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            )
            directories = (
                "upstream/lightweight-ai-image-detector",
                "upstream/vit-base-patch16-224",
                "upstream/public-frame-detector",
                "upstream/faster-whisper-tiny",
            )
            for relative in directories:
                (root / relative).mkdir(parents=True)
            manifest_files = {}
            for relative in files:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(relative.encode("utf-8"))
                manifest_files[relative] = {
                    "sha256": materializer.sha256_file(target),
                    "bytes": target.stat().st_size,
                }
            lines = materializer.env_lines(
                root,
                {"files": manifest_files},
                "owner/repo",
                "a" * 40,
            )
            generated = "\n".join(lines)
            for name in (
                "ORISLOP_TEMPORAL_PACKAGE_PATH=",
                "ORISLOP_AV_JOINT_MODEL_PATH=",
                "ORISLOP_SPATIAL_CHECKPOINT_PATH=",
                "ORISLOP_PUBLIC_FRAME_MODEL_DIR=",
                "ORISLOP_AEGIS_CHECKPOINT_PATH=",
                "ORISLOP_OLLAMA_GGUF_PATH=",
            ):
                self.assertIn(name, generated)


if __name__ == "__main__":
    unittest.main()
