# Launching the promoted Orislop pipeline

This source tree is prepared to launch the v1.1 extension, detector bridge, Cloud Heavy visual ensemble, the promoted temporal MoE package, and the required Qwen model through Ollama. It does not deploy itself or silently enable automatic hiding.

## What is wired together

1. The browser extension collects bounded platform metadata, preview images, and direct media URLs.
2. Qwen `qwen2.5:1.5b-instruct` runs through Ollama for text scoring, explanations, grounded chat, and the synthesis stage of fact checking.
3. Local Heavy runs the custom spatial detector and the promoted temporal package.
4. Hosted Cloud Heavy runs the custom spatial branch, the pinned public frame detector, the independent AEGIS motion branch, and the promoted temporal package.
5. The promoted temporal model starts in `shadow`. It is returned in diagnostics but cannot create an automatic Skip. `corroborated` can only veto an existing aggressive Cloud Heavy decision; it still cannot create a skip by itself.

The old public temporal checkpoints remain available only behind the explicit `ORISLOP_TEMPORAL_LEGACY_FALLBACK=1` escape hatch. The launcher sets it to `0`.

## First publish the trained package

A hosted GPU cannot read the package at this Google Drive path:

```text
/content/drive/MyDrive/orislop-checkpoints/orislop-a100-full-v2-retrain-v2-aggressive/temporal/final_model_package
```

Publish it once to a private Hugging Face **model** repo. In Colab, mount Drive, upload this source bundle, and run:

```python
from google.colab import drive
drive.mount("/content/drive")
!pip -q install "huggingface_hub>=0.34,<2"

import os, subprocess, sys
os.environ["HF_TOKEN"] = "hf_YOUR_WRITE_TOKEN"
os.environ["ORISLOP_TEMPORAL_TARGET_REPO"] = "gonnerthetooner/orislop-promoted-temporal"
subprocess.run([
    sys.executable,
    "/content/orislop_launch_ready/scripts/publish_promoted_temporal.py",
], check=True)
```

The publisher stages a copy, creates `artifact_manifest.json`, uploads privately, and prints the exact commit and weights SHA-256. Record those two outputs. Do not deploy `main` or another mutable branch name.

## Local Windows bootstrap

For a local package:

```powershell
pnpm orislop:bootstrap -- -TemporalPackagePath "D:\models\orislop\final_model_package" -Start
```

For the private Hugging Face package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrapOrislop.ps1 `
  -TemporalHfRepoId "gonnerthetooner/orislop-promoted-temporal" `
  -TemporalHfRevision "THE_40_CHARACTER_COMMIT" `
  -TemporalModelSha256 "THE_64_CHARACTER_SHA256" `
  -Start
```

The bootstrap installs the JavaScript workspace and Python bridge, writes only the ignored bridge `.env.local`, verifies or creates the model manifest, pulls Qwen through Ollama, runs package and extension tests, builds the extension, launches both local services, and performs a live readiness check.

Load `apps/extension/dist` from `chrome://extensions` after the build. Then run `pnpm extension-origin:setup` with the final extension ID so the bridge stops accepting arbitrary development extension origins.

## Hosted Cloud Heavy

Copy `deploy/orislop-cloud.env.example` into the provider's secret manager and replace every placeholder. Then validate the resolved Compose configuration and start it:

```bash
docker compose --env-file /secure/orislop-cloud.env -f docker-compose.cloud.yml config
docker compose --env-file /secure/orislop-cloud.env -f docker-compose.cloud.yml up --build -d
docker compose --env-file /secure/orislop-cloud.env -f docker-compose.cloud.yml ps
curl --fail http://127.0.0.1:4317/health
```

The Compose stack starts a pinned Ollama container, pulls Qwen once into a persistent volume, warms it, downloads the immutable temporal snapshot into the model cache, verifies its SHA/manifest, preloads the heavy detectors, and only then reports ready. Cloudflare, Postgres, the private object store, Google OAuth, and exact extension origin remain required production dependencies.

Build the extension that talks to the protected API only after the final origin and cloud URL are configured:

```powershell
pnpm extension:zip:cloud
```

## Release policy

The promoted run's reported test metrics are AUC `0.9757298422`, accuracy `0.9232099620`, and F1 `0.9264900662`. Those numbers are promising but are not a public-safety certificate: the training labels were scraper-derived proxies, YouTube/data rights are unresolved, and there is no independently labeled, source-disjoint external evaluation yet.

Keep both visual rollouts on `shadow` until the recorded gates in `configs/model_provenance.json` are satisfied. In particular, do not set `ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES=1` merely because the offline AUC is high.

## Verification commands

```powershell
pnpm temporal:package:test
pnpm detector:test
pnpm extension:test
pnpm extension:build
pnpm orislop:launch-check
pnpm orislop:start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\orislopLaunchCheck.ps1 -Live
```

`orislop:launch-check` proves configuration and artifact integrity. The `-Live` check additionally proves that Ollama has Qwen loaded, the bridge is reachable, and the promoted temporal package reached `ready` state. A real known-video smoke test is still required on the final GPU host before inviting users.
