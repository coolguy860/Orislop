#!/usr/bin/env python3
"""Verify the hosted Orislop process, promoted temporal model, and GPU state."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def get_json(url: str, token: str = "") -> tuple[int, object]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4317")
    parser.add_argument("--token", default=os.environ.get("ORISLOP_SMOKE_API_TOKEN", ""))
    args = parser.parse_args()

    ready_status, ready = get_json(f"{args.url.rstrip('/')}/ready")
    health_status, health = get_json(f"{args.url.rstrip('/')}/health", args.token)
    try:
        gpu = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
    except Exception as error:
        gpu = f"unavailable: {error}"

    report = {
        "ready_http": ready_status,
        "ready": ready,
        "health_http": health_status,
        "gpu": gpu,
        "accelerator": health.get("accelerator") if isinstance(health, dict) else None,
        "model_states": health.get("model_states") if isinstance(health, dict) else None,
        "text_model": health.get("text_model") if isinstance(health, dict) else None,
        "last_error": health.get("last_error") if isinstance(health, dict) else None,
    }
    print(json.dumps(report, indent=2, sort_keys=True))

    failures: list[str] = []
    if ready_status != 200 or not isinstance(ready, dict) or ready.get("ok") is not True:
        failures.append("/ready did not report ok")
    if health_status != 200 or not isinstance(health, dict):
        failures.append("authenticated /health failed")
    elif health.get("accelerator") != "cuda":
        failures.append("detector bridge is not using CUDA")
    else:
        states = health.get("model_states", {})
        if not isinstance(states, dict):
            failures.append("model_states is missing")
            states = {}
        for model_name in ("lightweight", "spatial", "cloud_heavy", "temporal"):
            if states.get(model_name) != "ready":
                failures.append(f"{model_name} is not ready")
        av = states.get("av_joint", {})
        if not isinstance(av, dict) or av.get("state") != "ready":
            failures.append("joint AV/lip-sync detector is not ready")
        elif not av.get("phase2FusionLoaded") or not av.get("phase2IntegrityVerified") or not av.get("yunetIntegrityVerified"):
            failures.append("joint AV phase-two fusion/calibration or YuNet is not loaded and verified")
        else:
            components = av.get("components", {})
            required = ("micro", "mid", "long", "extra_long", "fusion", "temperature", "lip_sync", "joint_av_external")
            missing = [name for name in required if not isinstance(components, dict) or components.get(name) is not True]
            if missing:
                failures.append("full temporal/AV components missing: " + ", ".join(missing))
        text_model = health.get("text_model", {})
        if not isinstance(text_model, dict) or text_model.get("state") != "available":
            failures.append("Ollama text model is not available")
    if failures:
        print("SMOKE FAILED: " + "; ".join(failures), file=sys.stderr)
        return 1
    print("SMOKE PASSED: every spatial, frame, motion, temporal, AV/lip-sync, lightweight, GPU, and Ollama component is ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
