from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "vast_supervisor.py"
SPEC = importlib.util.spec_from_file_location("orislop_vast_supervisor", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
vast = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vast)


def valid_environment(package_path: str) -> dict[str, str]:
    return {
        "ORISLOP_API_TOKENS": "a" * 40,
        "ORISLOP_ALLOWED_EXTENSION_ORIGINS": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "ORISLOP_GOOGLE_OAUTH_CLIENT_ID": "client.apps.googleusercontent.com",
        "ORISLOP_TOKEN_SECRET": "b" * 40,
        "ORISLOP_CONTENT_HMAC_SECRET": "c" * 40,
        "DATABASE_URL": "postgresql://example.invalid/orislop",
        "ORISLOP_DIAGNOSTIC_BUCKET": "orislop-diagnostics",
        "ORISLOP_S3_ENDPOINT": "https://s3.example.invalid",
        "ORISLOP_S3_ACCESS_KEY_ID": "access",
        "ORISLOP_S3_SECRET_ACCESS_KEY": "secret",
        "ORISLOP_REQUIRE_CLOUDFLARE": "1",
        "CLOUDFLARE_TUNNEL_TOKEN": "tunnel-token",
        "ORISLOP_TEMPORAL_ENABLED": "1",
        "ORISLOP_TEMPORAL_PACKAGE_PATH": package_path,
        "ORISLOP_TEMPORAL_HF_REPO_ID": "",
        "ORISLOP_OLLAMA_DEVICE": "auto",
        "ORISLOP_REQUIRE_FULL_MODEL_STACK": "0",
    }


def add_local_full_stack(environment: dict[str, str], root: Path) -> None:
    artifacts = {
        "ORISLOP_AV_JOINT_MODEL_PATH": root / "orislop_av_joint.ts",
        "ORISLOP_YUNET_MODEL_PATH": root / "face_detection_yunet.onnx",
        "ORISLOP_TEMPORAL_AV_FUSION_PATH": root / "stage2_av_fusion.pt",
        "ORISLOP_TEMPORAL_AV_CALIBRATION_PATH": root / "stage3_av_calibration.pt",
    }
    for index, (name, path) in enumerate(artifacts.items(), start=1):
        path.write_bytes(f"artifact-{index}".encode("ascii"))
        environment[name] = str(path)
    metadata = {
        "sha256": hashlib.sha256(artifacts["ORISLOP_AV_JOINT_MODEL_PATH"].read_bytes()).hexdigest(),
        "yunetSha256": hashlib.sha256(artifacts["ORISLOP_YUNET_MODEL_PATH"].read_bytes()).hexdigest(),
        "phase2FusionSha256": hashlib.sha256(
            artifacts["ORISLOP_TEMPORAL_AV_FUSION_PATH"].read_bytes()
        ).hexdigest(),
        "phase2CalibrationSha256": hashlib.sha256(
            artifacts["ORISLOP_TEMPORAL_AV_CALIBRATION_PATH"].read_bytes()
        ).hexdigest(),
    }
    metadata_path = root / "metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    environment["ORISLOP_AV_JOINT_METADATA_PATH"] = str(metadata_path)
    environment["ORISLOP_AV_JOINT_ENABLED"] = "1"
    environment["ORISLOP_REQUIRE_FULL_MODEL_STACK"] = "1"


class VastSupervisorTests(unittest.TestCase):
    def test_valid_local_package_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            self.assertEqual(vast.validate_configuration(valid_environment(package)), [])

    def test_rejects_missing_tunnel(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            environment["CLOUDFLARE_TUNNEL_TOKEN"] = ""
            errors = vast.validate_configuration(environment)
        self.assertTrue(any("CLOUDFLARE_TUNNEL_TOKEN" in error for error in errors))

    def test_direct_testing_requires_explicit_acknowledgement(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            environment["ORISLOP_REQUIRE_CLOUDFLARE"] = "0"
            environment["CLOUDFLARE_TUNNEL_TOKEN"] = ""
            errors = vast.validate_configuration(environment)
            environment["ORISLOP_VAST_DIRECT_TESTING_ACK"] = (
                "I_UNDERSTAND_PORT_4317_MUST_NOT_BE_PUBLIC"
            )
            acknowledged_errors = vast.validate_configuration(environment)
        self.assertTrue(any("Direct testing" in error for error in errors))
        self.assertFalse(any("Direct testing" in error for error in acknowledged_errors))

    def test_direct_testing_does_not_require_unused_cloud_services(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            for name in vast.REQUIRED_CLOUD_SETTINGS:
                environment.pop(name, None)
            environment.update({
                "ORISLOP_ALLOWED_EXTENSION_ORIGINS": (
                    "chrome-extension://nhkffdhagjignajnmlgkgekpkfljhfdd"
                ),
                "ORISLOP_REQUIRE_CLOUDFLARE": "0",
                "ORISLOP_VAST_DIRECT_TESTING_ACK": vast.DIRECT_TESTING_ACK,
                "ORISLOP_DETECTOR_HOST": "127.0.0.1",
            })
            errors = vast.validate_configuration(environment)
        self.assertEqual(errors, [])

    def test_direct_testing_rejects_public_detector_binding(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            environment.update({
                "ORISLOP_REQUIRE_CLOUDFLARE": "0",
                "ORISLOP_VAST_DIRECT_TESTING_ACK": vast.DIRECT_TESTING_ACK,
                "ORISLOP_DETECTOR_HOST": "0.0.0.0",
            })
            errors = vast.validate_configuration(environment)
        self.assertTrue(any("loopback only" in error for error in errors))

    def test_direct_testing_child_keeps_full_stack_on_loopback(self) -> None:
        child = vast.child_environment(
            {
                "ORISLOP_REQUIRE_CLOUDFLARE": "0",
                "ORISLOP_TEMP_MEDIA_ROOT": tempfile.gettempdir(),
                "ORISLOP_DETECTOR_CACHE": tempfile.gettempdir(),
                "OLLAMA_MODELS": tempfile.gettempdir(),
                "HF_HOME": tempfile.gettempdir(),
                "TRANSFORMERS_CACHE": tempfile.gettempdir(),
                "TORCH_HOME": tempfile.gettempdir(),
            },
            {"ollama_device": "cpu"},
        )
        self.assertEqual(child["ORISLOP_DETECTOR_HOST"], "127.0.0.1")
        self.assertEqual(child["ORISLOP_REQUIRE_API_AUTH"], "0")
        self.assertEqual(child["ORISLOP_CLOUD_HEAVY_ENABLED"], "1")

    def test_remote_temporal_package_must_be_pinned_and_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            environment["ORISLOP_TEMPORAL_PACKAGE_PATH"] = ""
            environment["ORISLOP_TEMPORAL_HF_REPO_ID"] = "owner/private-model"
            errors = vast.validate_configuration(environment)
            environment["ORISLOP_TEMPORAL_HF_REVISION"] = "1" * 40
            environment["ORISLOP_TEMPORAL_MODEL_SHA256"] = "2" * 64
            pinned_errors = vast.validate_configuration(environment)
        self.assertTrue(any("REVISION" in error for error in errors))
        self.assertTrue(any("SHA256" in error for error in errors))
        self.assertFalse(any("REVISION" in error or "SHA256" in error for error in pinned_errors))

    def test_valid_local_full_stack_verifies_every_artifact_hash(self) -> None:
        with tempfile.TemporaryDirectory() as package, tempfile.TemporaryDirectory() as artifacts:
            environment = valid_environment(package)
            add_local_full_stack(environment, Path(artifacts))
            self.assertEqual(vast.validate_configuration(environment), [])

    def test_full_stack_rejects_tampered_av_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as package, tempfile.TemporaryDirectory() as artifacts:
            environment = valid_environment(package)
            add_local_full_stack(environment, Path(artifacts))
            Path(environment["ORISLOP_AV_JOINT_MODEL_PATH"]).write_bytes(b"tampered")
            errors = vast.validate_configuration(environment)
        self.assertTrue(any("joint AV TorchScript model SHA-256 mismatch" in error for error in errors))

    def test_full_stack_remote_package_requires_pinned_revision_and_filenames(self) -> None:
        with tempfile.TemporaryDirectory() as package:
            environment = valid_environment(package)
            environment.update({
                "ORISLOP_REQUIRE_FULL_MODEL_STACK": "1",
                "ORISLOP_AV_JOINT_ENABLED": "1",
                "ORISLOP_AV_JOINT_HF_REPO_ID": "owner/private-av-release",
                "ORISLOP_AV_JOINT_HF_REVISION": "main",
            })
            errors = vast.validate_configuration(environment, check_model_path=False)
            environment["ORISLOP_AV_JOINT_HF_REVISION"] = "1" * 40
            for file_name_var in vast.FULL_STACK_HF_FILES.values():
                environment[file_name_var] = "release/" + file_name_var.lower() + ".bin"
            pinned_errors = vast.validate_configuration(environment, check_model_path=False)
        self.assertTrue(any("40-character commit" in error for error in errors))
        self.assertTrue(any("HF_MODEL_FILE" in error for error in errors))
        self.assertFalse(any("40-character commit" in error for error in pinned_errors))
        self.assertFalse(any("full-stack HF artifact package" in error for error in pinned_errors))

    def test_3090_auto_placement_reserves_gpu_for_detectors(self) -> None:
        self.assertEqual(vast.choose_ollama_device("auto", 24 * 1024), "cpu")
        self.assertEqual(vast.choose_ollama_device("auto", 48 * 1024), "gpu")
        self.assertEqual(vast.choose_ollama_device("gpu", 24 * 1024), "gpu")

    def test_runtime_defaults_enable_full_stack_and_temporal_corroboration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = vast.child_environment(
                {
                    "ORISLOP_TEMP_MEDIA_ROOT": str(root / "media"),
                    "ORISLOP_DETECTOR_CACHE": str(root / "cache"),
                    "OLLAMA_MODELS": str(root / "ollama"),
                    "HF_HOME": str(root / "hf"),
                    "TRANSFORMERS_CACHE": str(root / "transformers"),
                    "TORCH_HOME": str(root / "torch"),
                },
                {"ollama_device": "cpu"},
            )
            self.assertEqual(child["ORISLOP_REQUIRE_FULL_MODEL_STACK"], "1")
            self.assertEqual(child["ORISLOP_AV_JOINT_ENABLED"], "1")
            self.assertEqual(child["ORISLOP_TEMPORAL_ENABLED"], "1")
            self.assertEqual(child["ORISLOP_TEMPORAL_ROLLOUT"], "corroborated")

    def test_parses_nvidia_smi_csv(self) -> None:
        parsed = vast.parse_gpu_csv("NVIDIA GeForce RTX 3090, 24576, 580.95")
        self.assertEqual(parsed["name"], "NVIDIA GeForce RTX 3090")
        self.assertEqual(parsed["memory_mib"], 24576)
        self.assertEqual(parsed["driver"], "580.95")

    def test_redacts_tunnel_token_from_process_log_command(self) -> None:
        command = ["cloudflared", "tunnel", "run", "--token", "top-secret"]
        self.assertEqual(
            vast.redacted_command(command),
            ["cloudflared", "tunnel", "run", "--token", "***REDACTED***"],
        )
        self.assertEqual(command[-1], "top-secret")

    def test_ollama_runtime_environment_does_not_inherit_cloud_secrets(self) -> None:
        environment = {
            "PATH": "/usr/bin",
            "HOME": "/root",
            "HTTPS_PROXY": "http://proxy.invalid",
            "ORISLOP_API_TOKENS": "secret-api-token",
            "CLOUDFLARE_TUNNEL_TOKEN": "secret-tunnel-token",
            "HF_TOKEN": "secret-hf-token",
        }
        minimal = vast.minimal_runtime_environment(environment)
        self.assertEqual(
            minimal,
            {
                "PATH": "/usr/bin",
                "HOME": "/root",
                "HTTPS_PROXY": "http://proxy.invalid",
            },
        )

    def test_detector_gets_only_its_required_secrets(self) -> None:
        environment = {
            "PATH": "/usr/bin",
            "ORISLOP_API_TOKENS": "api-token",
            "ORISLOP_S3_SECRET_ACCESS_KEY": "s3-secret",
            "CLOUDFLARE_TUNNEL_TOKEN": "tunnel-secret",
            "HF_TOKEN": "hf-secret",
            "DATABASE_URL": "postgresql://example.invalid/db",
            "VAST_CONTAINER_API_KEY": "must-not-leak",
        }
        child = vast.detector_environment(environment)
        self.assertEqual(child["ORISLOP_API_TOKENS"], "api-token")
        self.assertEqual(child["ORISLOP_S3_SECRET_ACCESS_KEY"], "s3-secret")
        self.assertEqual(child["HF_TOKEN"], "hf-secret")
        self.assertNotIn("CLOUDFLARE_TUNNEL_TOKEN", child)
        self.assertNotIn("VAST_CONTAINER_API_KEY", child)


if __name__ == "__main__":
    unittest.main()
