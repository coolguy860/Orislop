# Orislop Vast production v4 validation report

Validation date: 2026-08-22

## Release identity

- model repository: `gonnerthetooner/orislop-complete-stack-v1`
- immutable revision: `09f0510580de5a8c11393adc7d7905ab40b200ab`
- manifest SHA-256: `f64fecb421f435cdd7e7e46374a965ea4708ae509a19c761a64e7314fef5c7dc`
- release bytes/files: 2,794,404,210 bytes / 494 files
- extension ID: `nhkffdhagjignajnmlgkgekpkfljhfdd`
- private detector endpoint: `http://127.0.0.1:4317`

## Validation completed

- harmless D: directory listing: passed;
- Python AST syntax checks for every changed Python deployment/test file: passed;
- Git Bash `bash -n` for the Vast shell entrypoints, including the Windows-to-Vast bootstrap: passed;
- PowerShell parser checks for the Windows SSH tunnel and one-command launcher: passed;
- one-command Windows launcher `-DryRun`: passed with dynamic placeholder values and no network access;
- missing-token launcher smoke: passed (noninteractive exit code 2 with a friendly message);
- production hardening suite: 11/11 passed;
- focused Vast supervisor suite: 16/16 passed;
- complete detector bridge suite: 113 passed, 1 skipped because the local upstream parity fixture is not shipped;
- extension contract checks: passed;
- Chromium platform DOM fixtures: passed (Windows OS-crypt/registry warnings were non-fatal browser-environment noise);
- pinned extension/model test-package verification: passed;
- full `scripts/runProductionReadinessChecks.mjs`: passed, including TypeScript, web/extension builds, 128-item deterministic launch corpus, adapter/calibration/scoring/storage/desktop/lookahead/skip/YouTube checks, detector suite, temporal cached-fusion pipeline, static ZIPs, release manifest, and release verification;
- v4 static package validator: passed with no token-like secret detected.

The detector test environment and Node dev dependencies were installed only in
D:-drive build locations. `node_modules`, test virtual environments, Python
bytecode caches, and package-manager caches are excluded from the final v4 ZIP.

## Safe live Vast check

The supplied dynamic host's mapped SSH port accepted a TCP connection and
completed the SSH protocol handshake. Noninteractive public-key authentication
then failed (`Permission denied (publickey)`), so no command executed on the
Vast instance. The check used `BatchMode=yes`, did not request a password, did
not persist a host key, and made no remote changes.

## Honest runtime boundary

A real RTX GPU startup, 2.602 GiB private Hugging Face materialization, model
load, Ollama GPU placement, detector inference, and `/ready=ready` response were
not executed in this validation session. Doing that safely requires both:

1. SSH authentication with the private key registered to the Vast account; and
2. a newly rotated Hugging Face read token supplied privately as exported
   `HF_TOKEN`.

The previously exposed token was not used. No Hugging Face or Google Drive
write operation was attempted. The package should therefore be described as
syntax-, unit-, integration-, build-, and package-validated, but not as having
completed a live GPU/model smoke test on the current instance.

## First operator command

After the new token is present in the private instance environment:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Users\aarush\Downloads\orislop_extension_test_ready_v4_production\START_ORISLOP_VAST.ps1" -DynamicIP "YOUR_VAST_DYNAMIC_IP" -SshPort YOUR_22_TCP_MAPPED_PORT -IdentityFile "C:\PATH\TO\YOUR\VAST_PRIVATE_KEY"
```

The same command uploads/extracts, safely resumes after a restart, waits for the
real GPU readiness state, and opens the private loopback tunnel. A live run is
still blocked until the registered SSH private key and new Vast-side token are
available.
