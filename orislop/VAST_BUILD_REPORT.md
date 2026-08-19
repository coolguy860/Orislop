# Vast RTX 3090 build report

Built: 2026-08-17

## Isolation

- Source folder: `outputs/orislop_launch_ready`
- Edited copy: `outputs/orislop_launch_ready_vast_3090`
- Source files before work: 1,545
- Source bytes before work: 64,837,485
- Source tree SHA-256 before work:
  `f792e417c346f059a9f71217d750232d866c2f2a0a82b716075c72d4ee95cfaf`
- Final source tree SHA-256 after implementation:
  `f792e417c346f059a9f71217d750232d866c2f2a0a82b716075c72d4ee95cfaf`
- Result: **matched exactly; the original folder was not changed.**

## Added Vast deployment files

- `apps/detector-bridge/Dockerfile.vast`
- `apps/detector-bridge/vast_supervisor.py`
- `apps/detector-bridge/vast.env.example`
- `apps/detector-bridge/tests/test_vast_supervisor.py`
- `scripts/vast3090-bootstrap.sh`
- `scripts/vast3090-smoke.py`
- `.github/workflows/build-vast-image.yml`
- `VAST_RTX3090_DEPLOY.md`

## Full-stack enablement changes

- `server.py`: requires the complete model stack, preloads lightweight even
  alongside Cloud Heavy, attaches the real external AV TorchScript model to a
  promoted package, actually loads verified AV fusion/calibration, requires
  extra-long temporal, and makes temporal/quality-gated AV strict corroboration.
- `temporal_package.py`: rebuilds optional extra-long, spatial, and lip experts
  when their weights exist in a promoted package.
- `vast_supervisor.py`: supports pinned HF download or local AV artifacts,
  verifies every SHA-256, and fails preflight on missing/tampered files.
- `/ready` and `vast3090-smoke.py`: require lightweight, spatial, public-frame,
  motion, every temporal component, real AV/lip-sync, YuNet, AV fusion and
  calibration, CUDA, and Ollama.
- Vast/Compose environment examples and documentation now enable full-stack
  inference by default. Automatic hides remain protected by factual release
  gates rather than forged by configuration.

## Validation completed locally

- Python bytecode compilation passed for the supervisor, smoke test, and new
  unit test.
- 31 dependency-available unit tests passed:
  - 12 Cloud Beta authentication, quota, persistence, and rollout tests;
  - 6 temporal package integrity and immutable-revision tests;
  - 13 Vast supervisor full-stack hashing, artifact-source, configuration,
    placement, parsing, redaction, and environment-isolation tests.
- All eight expected Vast deployment files exist in the copy.
- A source-to-copy file comparison found no unexpected source changes after
  ignoring generated Python bytecode and the intentionally changed root README.
- The clean ZIP excluded `node_modules`, `.cache`, Python bytecode, and real
  `.env` files. All archive content streams were opened and read successfully;
  every required Vast deployment file was present.

## Validation that remains mandatory

This Windows sandbox has no Docker daemon, Linux Bash runtime, NVIDIA GPU,
PyTorch, or OpenCV. Therefore the following are **not** claimed as passing:

- building and starting `Dockerfile.vast`;
- executing the Bash bootstrap on a Vast CUDA image;
- the three existing detector test modules that import PyTorch/OpenCV;
- downloading the hosted models;
- loading the promoted temporal package on an RTX 3090;
- real `/ready`, `nvidia-smi`, and end-to-end media inference evidence.

Run `scripts/vast3090-smoke.py` on the rented instance. A green result from that
script, followed by a representative extension-to-video request, is the release
evidence. Static checks on this machine are not a substitute for that GPU smoke
test.

## Known deployment prerequisite

The promoted `final_model_package` is not present in this source copy. Upload it
to `/models/temporal/final_model_package`, or publish it to a private Hugging
Face model repository pinned to an immutable commit and expected SHA-256. The
supervisor intentionally refuses to start without exactly one valid source.

The trained AV TorchScript artifact, its metadata, reviewed YuNet model, and
AV-specific Phase 2 fusion/calibration are also not embedded. Upload the five
local files documented in `VAST_RTX3090_DEPLOY.md`, or put them in one pinned HF
release repo. Full-stack `/ready` intentionally remains red until all five exist
and match their recorded hashes.
