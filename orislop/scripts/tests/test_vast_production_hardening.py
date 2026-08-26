from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deployment = load_module(
    "orislop_deployment_runtime",
    ROOT / "apps" / "detector-bridge" / "deployment_runtime.py",
)
materializer = load_module("orislop_materializer", ROOT / "scripts" / "materialize_complete_stack.py")
manager = load_module("orislop_vast_manager", ROOT / "scripts" / "orislop_vast_manager.py")


class ProductionHardeningTests(unittest.TestCase):
    def test_token_propagates_without_prompt_contract(self) -> None:
        pin = json.loads((ROOT / "PINNED_TEST_RELEASE.json").read_text(encoding="utf-8"))
        child = manager.build_child_environment({"HF_TOKEN": "new-rotated-read-token"}, ROOT, pin)
        self.assertEqual(child["HF_TOKEN"], "new-rotated-read-token")
        launcher = (ROOT / "scripts" / "start-vast-extension-test.sh").read_text(encoding="utf-8")
        self.assertNotIn("read -r", launcher)
        self.assertNotIn("getpass", launcher)
        self.assertIn("never prompts", launcher)

    def test_missing_token_has_friendly_noninteractive_failure(self) -> None:
        with self.assertRaisesRegex(manager.FriendlyError, "never opens a hidden prompt"):
            manager.require_new_hf_token({})

    def test_disk_plan_allows_24_point_3_gib_for_pinned_release(self) -> None:
        plan = deployment.calculate_storage_plan(release_bytes=2_794_404_210)
        self.assertLess(plan["required_free_bytes"] / deployment.GIB, 24.3)
        self.assertGreater(plan["temporary_materialization_bytes"], 0)
        self.assertGreater(plan["video_scratch_bytes"], 0)
        self.assertGreater(plan["safety_reserve_bytes"], 0)
        resumed = deployment.calculate_storage_plan(
            release_bytes=2_794_404_210,
            verified_bytes=2_000_000_000,
            dependencies_bytes=0,
        )
        self.assertLess(resumed["required_free_bytes"], plan["required_free_bytes"])

    def test_3090_and_5090_are_recognized_from_cuda_capability(self) -> None:
        cases = [
            ({"name": "NVIDIA GeForce RTX 3090", "memory_mib": 24 * 1024, "free_memory_mib": 23 * 1024}, (8, 6)),
            ({"name": "NVIDIA GeForce RTX 5090", "memory_mib": 32 * 1024, "free_memory_mib": 31 * 1024}, (12, 0)),
            ({"name": "Future NVIDIA GPU", "memory_mib": 48 * 1024, "free_memory_mib": 47 * 1024}, (12, 1)),
        ]
        for gpu, capability in cases:
            with self.subTest(gpu=gpu["name"]):
                support = deployment.classify_cuda_gpu(
                    gpu,
                    {"available": True, "device_count": 1, "capability": capability},
                )
                self.assertTrue(support["supported"], support)

    def test_ollama_gpu_capacity_and_cpu_reason(self) -> None:
        supported = {
            "supported": True,
            "memory_mib": 24 * 1024,
            "free_memory_mib": 24 * 1024,
        }
        placement = deployment.choose_ollama_placement("auto", supported)
        self.assertEqual(placement["device"], "gpu")
        self.assertIn("covers", placement["reason"])
        constrained = deployment.choose_ollama_placement(
            "auto",
            {**supported, "free_memory_mib": 20 * 1024},
        )
        self.assertEqual(constrained["device"], "cpu")
        self.assertIn("reserved", constrained["reason"])

    def test_duplicate_launch_and_stale_pid_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            pid_file = Path(temporary) / "manager.pid"
            pid_file.write_text(f"{os.getpid()}\n", encoding="ascii")
            pid, recovered = manager.recover_stale_pid(pid_file)
            self.assertEqual(pid, os.getpid())
            self.assertFalse(recovered)
            pid, recovered = manager.recover_stale_pid(
                pid_file,
                alive=lambda _pid: True,
                owned=lambda _pid: False,
            )
            self.assertIsNone(pid)
            self.assertTrue(recovered)
            pid_file.write_text("99999999\n", encoding="ascii")
            pid, recovered = manager.recover_stale_pid(pid_file, alive=lambda _pid: False)
            self.assertIsNone(pid)
            self.assertTrue(recovered)
            self.assertFalse(pid_file.exists())

    def test_resumable_download_reuses_verified_and_repairs_only_corrupt(self) -> None:
        with tempfile.TemporaryDirectory() as source_temp, tempfile.TemporaryDirectory() as destination_temp:
            source = Path(source_temp)
            destination = Path(destination_temp)
            files = {"weights/a.bin": b"alpha", "weights/b.bin": b"bravo"}
            manifest = {
                "artifactType": "orislop-complete-runnable-stack",
                "files": {
                    name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    for name, data in files.items()
                },
            }
            manifest_bytes = json.dumps(manifest, sort_keys=True).encode("utf-8")
            (source / "artifact_manifest.json").write_bytes(manifest_bytes)
            for name, data in files.items():
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            calls: list[tuple[str, bool]] = []

            def fake_download(**kwargs):
                filename = kwargs["filename"]
                calls.append((filename, bool(kwargs["force_download"])))
                target = Path(kwargs["local_dir"]) / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((source / filename).read_bytes())
                return str(target)

            common = {
                "downloader": fake_download,
                "repo": "owner/repo",
                "revision": "1" * 40,
                "destination": destination,
                "token": "not-printed",
                "expected_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "expected_release_bytes": sum(len(value) for value in files.values()),
            }
            first = materializer.materialize_release(**common)
            self.assertEqual(first["downloadedFiles"], 2)
            calls.clear()
            second = materializer.materialize_release(**common)
            self.assertEqual(second["downloadedFiles"], 0)
            self.assertEqual(calls, [])
            (destination / "weights" / "b.bin").write_bytes(b"corrupt")
            calls.clear()
            repaired = materializer.materialize_release(**common)
            self.assertEqual(repaired["downloadedFiles"], 1)
            self.assertEqual(calls, [("weights/b.bin", True)])

    def test_tunnel_command_uses_dynamic_values_and_noninteractive_ssh(self) -> None:
        command = manager.tunnel_command(
            dynamic_ip="203.0.113.7",
            ssh_port=45678,
            username="root",
            identity_file="D:\\keys\\vast.key",
        )
        self.assertIn("203.0.113.7", command)
        self.assertIn("45678", command)
        tunnel_script = (ROOT / "scripts" / "start-extension-test-tunnel.ps1").read_text(encoding="utf-8")
        self.assertIn("BatchMode=yes", tunnel_script)
        self.assertIn("StrictHostKeyChecking=accept-new", tunnel_script)
        self.assertIn("127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}", tunnel_script)

    def test_windows_one_command_launcher_is_private_and_noninteractive(self) -> None:
        launcher = (ROOT / "START_ORISLOP_VAST.ps1").read_text(encoding="utf-8")
        bootstrap = (ROOT / "scripts" / "bootstrap-vast-from-windows.sh").read_text(encoding="utf-8")
        self.assertIn('string]$DynamicIP', launcher)
        self.assertIn('int]$SshPort', launcher)
        self.assertIn('string]$IdentityFile', launcher)
        self.assertIn("BatchMode=yes", launcher)
        self.assertIn("StrictHostKeyChecking=accept-new", launcher)
        self.assertNotIn("Read-Host", launcher)
        self.assertNotIn("Get-Credential", launcher)
        self.assertNotIn("hf_", launcher)
        self.assertIn('[[ -z "${HF_TOKEN:-}" ]]', bootstrap)
        self.assertNotIn("read -r", bootstrap)
        self.assertNotIn("getpass", bootstrap)
        self.assertIn("relative_to(workspace)", bootstrap)
        self.assertIn(".orislop-source-archive.sha256", bootstrap)

    def test_readiness_states_are_distinct(self) -> None:
        health = {
            "service": "orislop-detector-bridge",
            "version": "1.3.0",
            "dependencies": "available",
            "queue_depth": 0,
            "queue_capacity": 10,
            "last_error": "",
            "model_states": {
                "lightweight": "not_loaded",
                "spatial": "not_loaded",
                "temporal": "not_loaded",
                "cloud_heavy": "not_loaded",
                "av_joint": {"state": "not_loaded"},
            },
            "text_model": {"state": "unavailable"},
        }
        report = deployment.readiness_report(
            health,
            full_model_stack_required=True,
            cloud_heavy_enabled=True,
        )
        self.assertEqual(report["state"], "starting")
        ready_health = json.loads(json.dumps(health))
        for key in ("lightweight", "spatial", "temporal", "cloud_heavy"):
            ready_health["model_states"][key] = "ready"
        ready_health["model_states"]["av_joint"] = {"state": "ready"}
        ready_health["text_model"] = {"state": "available"}
        ready = deployment.readiness_report(
            ready_health,
            full_model_stack_required=True,
            cloud_heavy_enabled=True,
        )
        self.assertEqual(ready["state"], "ready")
        failed_health = json.loads(json.dumps(health))
        failed_health["dependencies"] = "missing"
        failed = deployment.readiness_report(
            failed_health,
            full_model_stack_required=True,
            cloud_heavy_enabled=True,
        )
        self.assertEqual(failed["state"], "failed")
        degraded_health = json.loads(json.dumps(health))
        degraded_health["last_error"] = "one optional model is unavailable"
        degraded = deployment.readiness_report(
            degraded_health,
            full_model_stack_required=True,
            cloud_heavy_enabled=True,
        )
        self.assertEqual(degraded["state"], "degraded")

    def test_public_mode_is_optional_and_requires_authentication(self) -> None:
        pin = json.loads((ROOT / "PINNED_TEST_RELEASE.json").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(manager.FriendlyError, "requires ORISLOP_PUBLIC_MAPPED_ACK"):
            manager.build_child_environment(
                {"HF_TOKEN": "new-token", "ORISLOP_PUBLIC_MAPPED_MODE": "1"},
                ROOT,
                pin,
            )
        public = manager.build_child_environment(
            {
                "HF_TOKEN": "new-token",
                "ORISLOP_PUBLIC_MAPPED_MODE": "1",
                "ORISLOP_PUBLIC_MAPPED_ACK": manager.PUBLIC_ACK,
                "ORISLOP_API_TOKENS": "a" * 40,
            },
            ROOT,
            pin,
        )
        self.assertEqual(public["ORISLOP_REQUIRE_API_AUTH"], "1")
        self.assertEqual(public["ORISLOP_DETECTOR_HOST"], "0.0.0.0")


if __name__ == "__main__":
    unittest.main()
