from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(BRIDGE_ROOT))

from temporal_package import TemporalPackageError, resolve_temporal_package


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


class TemporalPackageTests(unittest.TestCase):
    def make_package(self, root: Path, threshold: float = 0.61) -> tuple[Path, str]:
        package = root / "final_model_package"
        package.mkdir(parents=True)
        weights = package / "final_model.safetensors"
        weights.write_bytes(b"deterministic-temporal-test-weights")
        digest = hashlib.sha256(weights.read_bytes()).hexdigest()
        write_json(package / "config.json", {"embedding_dim": 256, "fusion_dim": 256})
        write_json(package / "metrics.json", {"auc": 0.9757})
        write_json(package / "threshold.json", {"selection": {"selected_threshold": threshold}})
        return package, digest

    def test_resolves_local_package_and_nested_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package, digest = self.make_package(Path(temporary))
            resolved = resolve_temporal_package(
                Path(temporary) / "cache",
                local_path=str(package),
                expected_weights_sha256=digest,
            )
            self.assertEqual(resolved.threshold, 0.61)
            self.assertEqual(resolved.weights_sha256, digest)
            self.assertTrue(resolved.integrity_verified)
            self.assertEqual(resolved.source, "local")

    def test_manifest_verifies_every_declared_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package, digest = self.make_package(Path(temporary))
            files = {
                name: hashlib.sha256((package / name).read_bytes()).hexdigest()
                for name in ("final_model.safetensors", "config.json", "metrics.json", "threshold.json")
            }
            write_json(package / "artifact_manifest.json", {"schemaVersion": 1, "files": files})
            resolved = resolve_temporal_package(Path(temporary) / "cache", local_path=str(package))
            self.assertEqual(resolved.weights_sha256, digest)
            self.assertTrue(resolved.integrity_verified)

    def test_rejects_wrong_expected_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package, _ = self.make_package(Path(temporary))
            with self.assertRaisesRegex(TemporalPackageError, "SHA-256 mismatch"):
                resolve_temporal_package(
                    Path(temporary) / "cache",
                    local_path=str(package),
                    expected_weights_sha256="0" * 64,
                )

    def test_rejects_manifest_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package, _ = self.make_package(Path(temporary))
            write_json(
                package / "artifact_manifest.json",
                {"schemaVersion": 1, "files": {"../outside": "0" * 64}},
            )
            with self.assertRaisesRegex(TemporalPackageError, "Unsafe path"):
                resolve_temporal_package(Path(temporary) / "cache", local_path=str(package))

    def test_remote_cloud_configuration_requires_revision(self) -> None:
        with self.assertRaisesRegex(TemporalPackageError, "must pin"):
            resolve_temporal_package(
                Path(tempfile.gettempdir()) / "orislop-temporal-test-cache",
                repo_id="example/private-model",
                require_pinned_remote=True,
            )

    def test_remote_cloud_configuration_rejects_mutable_tag(self) -> None:
        with self.assertRaisesRegex(TemporalPackageError, "must pin"):
            resolve_temporal_package(
                Path(tempfile.gettempdir()) / "orislop-temporal-test-cache",
                repo_id="example/private-model",
                revision="main",
                require_pinned_remote=True,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
