# Orislop Vast production deployment v4

This runbook deploys the pinned complete stack privately on Vast. The detector
defaults to `127.0.0.1:4317`; do not map detector port `4317` or Ollama port
`11434` publicly. The Windows extension reaches the detector through the SSH
tunnel below.

For the easiest Windows path, use [ONE_COMMAND_START.md](ONE_COMMAND_START.md).
Its single PowerShell command uploads/extracts this package, starts or resumes
the detached GPU runtime, waits for real readiness, and opens the tunnel. The
only command-line values are the current Vast SSH connection details and the
private-key path; `HF_TOKEN` remains in the Vast private environment.

## Exact rental settings

In the Vast UI select the recommended **PyTorch** template based on
`vastai/pytorch`. Vast documents PyTorch as its ready-to-use deep-learning
template and documents `vastai/pytorch` as a recommended base image. Choose
**Jupyter + SSH** for a first deployment or **SSH** for a headless runtime.

Use these instance settings:

- rental: on-demand;
- GPUs: exactly 1 NVIDIA GPU;
- supported targets: RTX 3090 (24 GiB) or RTX 5090 (32 GiB);
- VRAM: 20 GiB minimum;
- CUDA: a PyTorch image whose `torch.cuda.is_available()` is true and whose
  device capability is at least 7.0; CUDA 12.8 is preferred for current cards;
- CPU: 8 cores minimum;
- system RAM: 24 GiB minimum, 32 GiB preferred;
- disk: **100 GB**; 80 GB is the minimum recommendation;
- host reliability: 99.5% or higher;
- network: direct SSH enabled; do not request public mappings for `4317` or
  `11434`.

Vast states that the disk size selected at instance creation cannot be changed.
If the disk is too small, a new instance is required. Official references:
[Choosing a Template](https://docs.vast.ai/guides/instances/choosing/templates),
[Quickstart](https://docs.vast.ai/guides/get-started/quickstart), and
[Template Settings](https://docs.vast.ai/guides/templates/template-settings).

The runtime does not recognize GPUs by a short product-name list. It requires
one visible NVIDIA GPU, working PyTorch CUDA, at least 20 GiB VRAM, and a
supported compute capability. This recognizes both 3090 and 5090 when the
selected image/driver actually supports the card.

## Token handling

Revoke the previously exposed token. Create a new least-privilege Hugging Face
read token for `gonnerthetooner/orislop-complete-stack-v1` and provide it to the
instance as the private environment variable `HF_TOKEN`. Do not paste the token
into this folder, a ZIP, `model.env`, an on-start script, a command argument, or
a log. The launcher never asks for a token; if the environment variable is not
exported, it exits immediately before doing expensive work.

The token is inherited by the detached materializer, used only for read-only
downloads, and removed before the detector supervisor starts. No upload,
repository write, Google Drive write, or model deletion code is used.

## Upload

Upload and extract `orislop_extension_test_ready_v4_production.zip` so the
project root is:

```text
/workspace/orislop_extension_test_ready_v4_production
```

## Fresh runtime: one command

After `HF_TOKEN` is already present in the private instance environment, copy
and run this one line:

```bash
cd /workspace/orislop_extension_test_ready_v4_production && bash scripts/start-vast-extension-test.sh "$PWD"
```

The command validates the environment and storage plan, installs only missing
dependencies, reuses verified model files, redownloads only missing/corrupt
files, verifies every manifest SHA-256, writes a secret-free `model.env`, starts
the supervisor detached from the terminal, waits for real `/ready` state, and
prints the local endpoint plus a configurable Windows tunnel command.

## Resume after an instance restart: one command

Make the new `HF_TOKEN` available to the restarted instance, then run the same
idempotent command:

```bash
cd /workspace/orislop_extension_test_ready_v4_production && bash scripts/start-vast-extension-test.sh "$PWD"
```

Installed dependency receipts and verified model files are reused. A live PID
blocks a duplicate start; an invalid or dead PID receipt is recovered. A second
launcher never starts a parallel installer or server.

## Lifecycle and monitoring

Run these from the project root:

```bash
python3 scripts/orislop_vast_manager.py --root "$PWD" start
python3 scripts/orislop_vast_manager.py --root "$PWD" stop
python3 scripts/orislop_vast_manager.py --root "$PWD" restart
python3 scripts/orislop_vast_manager.py --root "$PWD" status
python3 scripts/orislop_vast_manager.py --root "$PWD" logs --lines 100
python3 scripts/orislop_vast_manager.py --root "$PWD" logs --follow
python3 scripts/orislop_vast_manager.py --root "$PWD" readiness
```

`status`, `logs`, and `readiness` are read-only monitors. They never terminate
the detector. If the initial readiness wait times out, the background process
is left running and the command tells you how to continue monitoring it.

The status/log phases are `environment-validation`, `dependencies`, `download`,
`verification`, `materialization`, `benchmark`, `model-loading`, `ready`, and
`failed`. The first media-dependent autotune benchmark is honestly reported as
deferred until a real Heavy request; startup does not invent a fake video.

`/ready` returns one of `starting`, `ready`, `degraded`, or `failed`. Only
`ready` returns HTTP 200; the other states return HTTP 503 with a friendly detail.

## Manifest-aware storage

The fixed 25 GiB guard is gone. Before the expensive work, v4 computes current
incremental free space from:

- 2,794,404,210 release bytes minus already verified manifest files;
- temporary/resumable materialization allowance;
- missing dependency allowance (zero when the exact receipt exists);
- configurable video scratch space;
- a safety reserve.

With a fresh pinned release, defaults reserve about 18.9 GiB, so a machine with
24.3 GiB free is not rejected solely by an obsolete 25 GiB constant. This does
not change the rental recommendation: choose 100 GB because the disk cannot be
expanded and caches/scratch space grow during actual use.

Overrides, in GiB:

```text
ORISLOP_STORAGE_DEPENDENCIES_GIB=6
ORISLOP_VIDEO_SCRATCH_GIB=4
ORISLOP_STORAGE_SAFETY_GIB=5
```

The launcher never frees space by deleting models, project files, Hugging Face
caches, environments, or media. If storage is insufficient, it stops and asks
for a larger instance before downloading the release.

## Ollama GPU placement

`ORISLOP_OLLAMA_DEVICE=auto` uses the GPU only when CUDA is supported and live
GPU capacity covers the detector reserve plus the Ollama budget. Otherwise it
selects CPU and records the reason. If automatic GPU warmup fails, it retries
Ollama on CPU and records that fallback without killing the detector startup.

Defaults:

```text
ORISLOP_DETECTOR_VRAM_RESERVE_GIB=18
ORISLOP_OLLAMA_VRAM_BUDGET_GIB=3
```

## Windows private SSH tunnel

The dynamic IP, mapped SSH port, username, and key are operator inputs. Generate
a command on the Vast instance without hardcoding an offer address:

```bash
python3 scripts/orislop_vast_manager.py --root "$PWD" tunnel-command --ip VAST_DYNAMIC_IP --ssh-port VAST_SSH_PORT --username root --identity-file 'C:\path\to\vast-private-key'
```

Or run this directly in Windows PowerShell from the extracted project:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-extension-test-tunnel.ps1 -DynamicIP 'VAST_DYNAMIC_IP' -SshPort VAST_SSH_PORT -Username 'root' -IdentityFile 'C:\path\to\vast-private-key' -LocalPort 4317 -RemotePort 4317
```

The script uses `BatchMode=yes`, `StrictHostKeyChecking=accept-new`, and
`ExitOnForwardFailure=yes`. It cannot ask for a password or host confirmation.
The private mapping is always:

```text
127.0.0.1:4317 -> remote 127.0.0.1:4317
```

## Optional public mapped-port mode

Private SSH tunneling is the default and recommended mode. Public mapped-port
mode is deliberately opt-in and rejected unless all of these are set:

```text
ORISLOP_PUBLIC_MAPPED_MODE=1
ORISLOP_PUBLIC_MAPPED_ACK=I_UNDERSTAND_PUBLIC_PORT_REQUIRES_AUTH
ORISLOP_API_TOKENS=a_random_secret_of_at_least_32_characters
```

Public mode binds `0.0.0.0`, forces bearer authentication, rejects originless
POST requests, and keeps the exact extension-origin allowlist. Never expose an
unauthenticated inference API or Ollama.
