# Validation report

Validation date: 2026-08-17

## Passed in the packaging workspace

- Python compilation passed for `vast_supervisor.py` and `materialize_complete_stack.py`.
- All 16 Vast supervisor unit tests passed, including minimal direct-test configuration, loopback enforcement, production tunnel enforcement, artifact hashing, full-stack requirements, and Ollama device placement.
- The complete extension contract suite passed after a clean rebuild.
- Chromium DOM checks passed for Instagram, TikTok, LinkedIn, and the explanation panel.
- PowerShell syntax parsing passed for the SSH-tunnel and bridge-smoke scripts.
- The standalone extension ZIP was rebuilt from `apps/extension/dist` and its required entry inventory passed.
- The package verifier recomputed the deterministic Chrome extension ID, matched it to the allowlisted origin, matched the exact model revision, and byte-compared the embedded pin receipt.

## Intentionally not claimed

- A live NVIDIA/Vast inference was not run from this Windows packaging sandbox.
- The full bridge contract suite could not import here because this host Python does not have the pinned GPU/runtime dependencies (`torch` and `opencv-python-headless`). The Vast launcher installs the exact `requirements.txt` set before startup; this local dependency gap is not reported as a passing test.
- Bash syntax validation was unavailable because this Windows host has no Bash executable. The launcher uses standard Bash syntax and is exercised indirectly by the existing deployment structure, but the first real shell execution remains on Vast.
- Published validation AUC is not a measurement of browser-feed accuracy. Live tests should log model states, latency, false positives, and false negatives.

## Live acceptance gate

Do not call a Vast session test-ready until `scripts/test-extension-bridge.ps1` reports `PASS`, the response says `loopback-only`, and every required entry under `modelStates` is ready. Then confirm the unpacked extension ID is `nhkffdhagjignajnmlgkgekpkfljhfdd` before browsing test feeds.
