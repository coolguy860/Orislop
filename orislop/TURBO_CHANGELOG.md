# Orislop Shield 1.2 turbo copy

This release descends from the isolated `orislop_extension_test_ready_v2_turbo` copy. The v1 and v2 folders were not edited while building v3.

## Version 1.3 addition

- Benchmarks every live-VRAM-safe Heavy execution layout on the first representative video.
- Validates expert availability and output equivalence before accepting a timing.
- Persists the fastest median strategy against a hardware/software/model fingerprint.
- Automatically re-benchmarks after a relevant fingerprint change or explicit reset.
- Exposes settings, samples, peak VRAM, rejection reasons, and winner through health telemetry.

## Runtime changes

- Added `apps/detector-bridge/resource_scheduler.py` for live CPU/RAM/VRAM planning.
- Overlapped promoted temporal+AV and visual Heavy branches with separate CUDA streams when safe.
- Overlapped custom spatial, public-frame, and AEGIS motion components when headroom permits.
- Overlapped spatial CPU auxiliaries with its GPU branch and the minimum AV preprocessing window with temporal inference.
- Added automatic media/download worker selection and TF32/cuDNN tuning.
- Added CUDA OOM circuit breaking, cache cleanup, and same-input sequential retry.
- Added execution mode, timings, current resources, and fallback counters to API results/health.
- Added capability-gated browser lookahead and local context preparation.
- Explicit Hybrid Heavy now starts the full cloud job without waiting for capable-client local preparation; Automatic remains selectively Fast-first.

## Packaging changes

- Bumped bridge, extension, web release metadata, and manifests to 1.2.0.
- Updated the Vast and cloud images with adaptive defaults and a larger temporary-media memory filesystem.
- Rebuilt and integrity-verified the standalone browser extension and static-site ZIPs in `dist/`.

## Verification performed on the packaging machine

- Extension behavior/build checks: passed.
- Web behavior/build checks: passed.
- TypeScript no-emit check: passed.
- Scheduler and extracted server-orchestration tests, including persistence, fingerprint invalidation, 32 GB layouts, output mismatch, and OOM continuation: 10 passed.
- Local inference, storage, slop calibration, claim-aware, fixtures, desktop, lookahead, skip-controller, YouTube extractor, and four-platform DOM suites: passed.
- Python syntax compilation for the modified bridge modules: passed.
- Release ZIP SHA-256 verification: passed.

The packaging machine does not have Docker, the heavyweight Python dependency set, or an NVIDIA GPU. Therefore the complete Python bridge suite and a real-CUDA model/video benchmark remain required on the rented instance. The new telemetry makes that check observable; do not treat the static checks as measured latency or production accuracy.
