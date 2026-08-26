#!/usr/bin/env python3
"""Static package validation for the hardened Vast production copy."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "modelRepository": "gonnerthetooner/orislop-complete-stack-v1",
    "modelRevision": "09f0510580de5a8c11393adc7d7905ab40b200ab",
    "modelManifestSha256": "f64fecb421f435cdd7e7e46374a965ea4708ae509a19c761a64e7314fef5c7dc",
    "modelBytes": 2_794_404_210,
    "modelFiles": 494,
    "extensionId": "nhkffdhagjignajnmlgkgekpkfljhfdd",
    "detectorUrl": "http://127.0.0.1:4317",
}
REQUIRED = [
    "README.md",
    "ONE_COMMAND_START.md",
    "START_ORISLOP_VAST.ps1",
    "VAST_PRODUCTION_DEPLOY.md",
    "V4_VALIDATION_REPORT.md",
    "PINNED_TEST_RELEASE.json",
    "scripts/start-vast-extension-test.sh",
    "scripts/bootstrap-vast-from-windows.sh",
    "scripts/vast-production-run.sh",
    "scripts/orislop_vast_manager.py",
    "scripts/materialize_complete_stack.py",
    "scripts/start-extension-test-tunnel.ps1",
    "apps/detector-bridge/deployment_runtime.py",
    "apps/detector-bridge/vast_supervisor.py",
    "apps/detector-bridge/server.py",
    "scripts/tests/test_vast_production_hardening.py",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"PACKAGE_VALIDATION_FAILED: {message}")


def main() -> int:
    require(ROOT.name == "orislop_extension_test_ready_v4_production", "unexpected package folder name")
    for relative in REQUIRED:
        require((ROOT / relative).is_file(), f"missing required file: {relative}")
    pin_bytes = (ROOT / "PINNED_TEST_RELEASE.json").read_bytes()
    pin = json.loads(pin_bytes)
    for key, expected in EXPECTED.items():
        require(pin.get(key) == expected, f"pinned receipt mismatch: {key}")

    launcher = (ROOT / "scripts" / "start-vast-extension-test.sh").read_text(encoding="utf-8")
    complete = (ROOT / "scripts" / "vast3090-complete-bootstrap.sh").read_text(encoding="utf-8")
    manager = (ROOT / "scripts" / "orislop_vast_manager.py").read_text(encoding="utf-8")
    materializer = (ROOT / "scripts" / "materialize_complete_stack.py").read_text(encoding="utf-8")
    tunnel = (ROOT / "scripts" / "start-extension-test-tunnel.ps1").read_text(encoding="utf-8")
    windows_launcher = (ROOT / "START_ORISLOP_VAST.ps1").read_text(encoding="utf-8")
    remote_bootstrap = (ROOT / "scripts" / "bootstrap-vast-from-windows.sh").read_text(encoding="utf-8")
    supervisor = (ROOT / "apps" / "detector-bridge" / "vast_supervisor.py").read_text(encoding="utf-8")
    server = (ROOT / "apps" / "detector-bridge" / "server.py").read_text(encoding="utf-8")

    for name, text in {"launcher": launcher, "complete launcher": complete}.items():
        require("read -r" not in text and "getpass" not in text and "input(" not in text, f"{name} may prompt")
        require("HF_TOKEN" in text and "never prompt" in text.lower(), f"{name} lacks no-prompt token failure")
    require("start_new_session=True" in manager, "detached process launch is missing")
    require("exclusive_lock" in manager and "manager.pid" in manager, "lock/PID lifecycle is missing")
    require("force_download=target.exists()" in materializer, "corrupt-file repair path is missing")
    require("verifiedFiles" in materializer and "expected-manifest-sha256" in materializer, "manifest verification is missing")
    require("upload_file" not in materializer and "delete_repo" not in materializer, "materializer is not read-only")
    require("BatchMode=yes" in tunnel and "StrictHostKeyChecking=accept-new" in tunnel, "SSH tunnel may prompt")
    require("BatchMode=yes" in windows_launcher and "StrictHostKeyChecking=accept-new" in windows_launcher, "Windows launcher may prompt")
    require("Machine Copy Port" in windows_launcher, "Windows launcher does not explain the mapped SSH port")
    require("extractall(workspace)" in remote_bootstrap and "relative_to(workspace)" in remote_bootstrap, "remote ZIP extraction is not traversal-checked")
    require("HF_TOKEN" in remote_bootstrap and "never prompts" in remote_bootstrap, "remote launcher lacks no-prompt token failure")
    require("ORISLOP_PUBLIC_MAPPED_MODE" in supervisor and "PUBLIC_MAPPED_ACK" in supervisor, "public auth gate is missing")
    require("readiness_report" in server, "four-state /ready mapping is missing")

    package_files = [
        path
        for path in ROOT.rglob("*")
        if path.is_file() and "node_modules" not in path.parts
    ]
    secret_pattern = re.compile(r"(?<![A-Za-z0-9])hf_[A-Za-z0-9]{24,}")
    secret_hits: list[str] = []
    for path in package_files:
        if path.suffix.lower() not in {".py", ".sh", ".ps1", ".js", ".mjs", ".json", ".md", ".txt"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if secret_pattern.search(text):
            secret_hits.append(str(path.relative_to(ROOT)))
    require(not secret_hits, "possible Hugging Face token material found: " + ", ".join(secret_hits))

    phases = {
        "dependencies",
        "download",
        "verification",
        "materialization",
        "benchmark",
        "model-loading",
        "ready",
        "failed",
    }
    combined = manager + materializer + (ROOT / "scripts" / "vast-production-run.sh").read_text(encoding="utf-8") + supervisor
    require(all(phase in combined for phase in phases), "one or more required status phases are missing")

    print(json.dumps({
        "status": "vast-production-package-valid",
        "root": str(ROOT),
        "files": len(package_files),
        "pinnedReceiptSha256": hashlib.sha256(pin_bytes).hexdigest(),
        "modelRevision": pin["modelRevision"],
        "manifestSha256": pin["modelManifestSha256"],
        "detectorUrl": pin["detectorUrl"],
        "tokenLikeSecretsFound": 0,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
