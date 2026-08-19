# Orislop on Vast.ai: single RTX 3090

This copy converts the Cloud Heavy deployment from two Docker Compose services
into one Vast-compatible container. Vast instances are containers already, so
the original `docker-compose.cloud.yml` remains present for ordinary cloud
hosts but is not used on Vast.

## Selected offer snapshot

The August 17, 2026 shortlist favored Vast offer `#46971453`: one verified RTX
3090 in Quebec at the then-listed `$0.158/hour`, 99.85% host reliability, 22 CPU
cores, 32 GB assigned RAM, fast NVMe, and roughly 2 Gbps networking. Offers are
ephemeral. If it disappears, use these minimum filters instead:

- exactly one RTX 3090 with 24 GB VRAM;
- on-demand for a live demonstration;
- verified host with at least 99.5% current reliability;
- at least 8 CPU cores and 24 GB RAM (32 GB preferred);
- at least 100 GB allocatable disk and 500 MB/s disk bandwidth;
- at least 500 Mbps upload and download;
- enough direct ports for SSH; do not expose raw Orislop or Ollama ports.

Set the Vast container disk to **100 GB**, not the 8 GB default. Storage and
bandwidth are billed separately, and storage remains billable while an instance
is stopped.

## What this deployment runs

One container starts three supervised sibling processes and loads the complete
detector ensemble:

1. Ollama with `qwen2.5:1.5b-instruct`;
2. the authenticated Orislop detector bridge with the lightweight scan, custom
   Orislop spatial model, pinned public frame model, AEGIS motion model, promoted
   Temporal MoE (`micro`, `mid`, `long`, `extra_long`, fusion, and calibration),
   and the real joint AV/lip-sync expert plus its AV-specific fusion/calibration;
3. an optional but production-required Cloudflare named tunnel.

This copy pins Ollama 0.32.5 instead of the original Compose deployment's
0.32.0. Ollama remains bound to loopback and is never published as a Vast port.

On a 24 GB RTX 3090, `ORISLOP_OLLAMA_DEVICE=auto` keeps Ollama on CPU and reserves
the GPU for the visual ensemble. Spatial auxiliary classification and
Faster-Whisper also default to CPU. This is deliberate: filling VRAM is not a
performance goal, and an out-of-memory failure would take down the entire demo.

The supervisor refuses to start when secrets, any full-stack artifact or hash,
the promoted model package, GPU, RAM, CPU, or disk are missing. It waits for real
`/ready` success and terminates the whole process group if any required service
exits. `/ready` now requires every model and Ollama, not merely Cloud Heavy.

## Required artifacts before deployment

The promoted temporal checkpoint is not embedded in this source ZIP. Before the
service can become ready, use exactly one of these options:

If the newly retrained releases are in Google Drive, run the single Colab cell
in `scripts/COLAB_ONE_CELL_PUBLISH_DRIVE_MODELS.py`. It discovers the promoted
package, verifies the full MoE and joint-AV contracts, uploads private pinned HF
releases, and prints the exact environment values below. Full details are in
`docs/PUBLISH_DRIVE_MODELS_TO_HF.md`.

### Local package

Upload the complete promoted `final_model_package` directory to:

```text
/models/temporal/final_model_package
```

Keep:

```text
ORISLOP_TEMPORAL_PACKAGE_PATH=/models/temporal/final_model_package
ORISLOP_TEMPORAL_HF_REPO_ID=
```

### Private Hugging Face model repository

Upload the promoted package to a private model repository, then set:

```text
ORISLOP_TEMPORAL_PACKAGE_PATH=
ORISLOP_TEMPORAL_HF_REPO_ID=owner/private-repository
ORISLOP_TEMPORAL_HF_REVISION=full_immutable_commit_hash
ORISLOP_TEMPORAL_HF_SUBDIR=final_model_package
ORISLOP_TEMPORAL_MODEL_SHA256=expected_model_file_sha256
HF_TOKEN=private_read_token
```

An unpinned repository is intentionally rejected.

### Joint AV/lip-sync release package

Full-stack mode is enabled in this copy. Supply all five reviewed files:

```text
/models/av/orislop_av_joint_v1.ts
/models/av/orislop_av_joint_v1.json
/models/av/face_detection_yunet_2023mar.onnx
/models/temporal/stage2_temporal_av_fusion.pt
/models/temporal/stage3_temporal_av_calibration.pt
```

The JSON metadata must contain valid `sha256`, `yunetSha256`,
`phase2FusionSha256`, and `phase2CalibrationSha256` values matching those exact
files. `ORISLOP_YUNET_MODEL_SHA256` may supply the YuNet hash if the metadata does
not contain it.

Alternatively, place all five files in one private Hugging Face model repository
and configure `ORISLOP_AV_JOINT_HF_REPO_ID`, a full immutable 40-character
`ORISLOP_AV_JOINT_HF_REVISION`, and the five `ORISLOP_AV_JOINT_HF_*_FILE`
variables shown in `apps/detector-bridge/vast.env.example`. The supervisor
downloads each pinned file and performs the same hash verification before it
starts the detector.

The checked-in source does not contain these trained AV/phase-two artifacts and
does not know the immutable revision of a private HF repository. Those values
must come from the actual release upload; the launcher will not guess them or
substitute a stub.

## Option A: custom image (recommended after the first test)

Build and push the single-container image from this folder:

```powershell
docker build -f apps/detector-bridge/Dockerfile.vast -t ghcr.io/YOUR_ACCOUNT/orislop-vast:rtx3090 .
docker push ghcr.io/YOUR_ACCOUNT/orislop-vast:rtx3090
```

The included manual GitHub Actions workflow can perform the same build and push
to GHCR. Keep the image private if the code or weights are private, and configure
the registry credentials in Vast.

Create a private Vast template with:

- image: `ghcr.io/YOUR_ACCOUNT/orislop-vast:rtx3090`;
- launch mode: **docker ENTRYPOINT** for headless production;
- disk: **100 GB**;
- no public mapping for ports `4317` or `11434`;
- the values from `apps/detector-bridge/vast.env.example` stored privately.

The image entrypoint starts the supervisor automatically. For the first debug
run, SSH/Jupyter mode is acceptable, but Vast replaces the image entrypoint in
those modes. Put this in the private template's on-start script:

```bash
nohup /opt/orislop-venv/bin/python /app/apps/detector-bridge/vast_supervisor.py \
  >/var/log/orislop-vast.log 2>&1 &
```

## Option B: upload this ZIP to a CUDA instance

For an immediate private test without publishing a custom image:

1. Start an NVIDIA CUDA 12.8 Ubuntu 24.04 Vast template in Jupyter + SSH mode.
2. Upload and extract this ZIP under `/workspace`.
3. Copy the variables from `apps/detector-bridge/vast.env.example` into a private
   `/workspace/orislop-vast.env`, replacing every placeholder.
4. Restrict it and load it, then run the idempotent bootstrap:

```bash
cd /workspace/orislop_launch_ready_vast_3090
chmod 600 /workspace/orislop-vast.env
ORISLOP_ENV_FILE=/workspace/orislop-vast.env \
  bash scripts/vast3090-bootstrap.sh "$PWD"
```

Do not place the completed environment file back inside this source directory
or a ZIP. The bootstrap deliberately loads it only after system installation so
package installers do not inherit deployment secrets. It installs dependencies
into `/opt/orislop-venv`, performs strict preflight, downloads missing models,
warms Ollama, starts all services, and waits for actual readiness.

## Prove the flow

Startup phase and elapsed time are printed live and saved to:

```text
/run/orislop-vast/status.json
```

In a second SSH terminal:

```bash
export ORISLOP_SMOKE_API_TOKEN='the_first_ORISLOP_API_TOKENS_value'
/opt/orislop-venv/bin/python scripts/vast3090-smoke.py
```

A pass requires all of the following evidence:

- `/ready` returns HTTP 200 with `ok: true`;
- the bridge reports CUDA acceleration;
- lightweight, custom spatial, public-frame Cloud Heavy, and AEGIS motion are ready;
- promoted Temporal MoE micro/mid/long/extra-long/fusion/calibration are ready;
- the external joint AV/lip-sync model and verified AV fusion/calibration are ready;
- Ollama is available;
- `nvidia-smi` is readable and reports memory utilization.

Monitor startup with:

```bash
watch -n 2 nvidia-smi
cat /run/orislop-vast/status.json
tail -f /var/log/orislop-vast.log
```

The bootstrap foregrounds the supervisor unless started through the SSH-mode
on-start command. A model download can take several minutes. The default strict
startup deadline is 30 minutes and can be changed with
`ORISLOP_STARTUP_TIMEOUT_SECONDS`.

## Security and rollout state

- Never expose Ollama port `11434`.
- Never expose raw detector port `4317` to the public internet.
- Use a named Cloudflare tunnel terminating TLS and routing only to
  `http://127.0.0.1:4317`.
- Keep bearer authentication, exact extension-origin checks, and originless POST
  rejection enabled.
- Every model now runs. Temporal is a strict corroborating vote: it may confirm
  an existing spatial+motion detection but cannot manufacture one by itself.
- A quality-gated, hash-verified AV score participates in the testing temporal
  probability. Automatic filtering remains unavailable until the signed AV and
  Cloud Heavy release gates pass. The launcher deliberately does not rewrite
  `calibrated`, `betaGatePassed`, corpus, latency, or 10,000-shadow-decision
  evidence just to make a dashboard say “aggressive.”
- Vast hosts can technically access files on their machines. Use a verified
  datacenter or another controlled provider for sensitive customer media and
  irreplaceable model IP.
- Copy important artifacts off the instance before destruction. Destroying a
  Vast instance deletes its container storage.

For a temporary SSH-tunneled test without Cloudflare, set all three values below
and do **not** map port 4317 publicly:

```text
ORISLOP_REQUIRE_CLOUDFLARE=0
CLOUDFLARE_TUNNEL_TOKEN=
ORISLOP_VAST_DIRECT_TESTING_ACK=I_UNDERSTAND_PORT_4317_MUST_NOT_BE_PUBLIC
```

Then forward `127.0.0.1:4317` through SSH. This mode is deliberately awkward so
it cannot be enabled accidentally for a public investor demo.
