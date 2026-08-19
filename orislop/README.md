# Orislop Shield

> **First-run autotune 1.3:** the first representative Heavy video benchmarks
> every VRAM-safe execution layout, rejects OOM or output-changing plans, and
> persists the fastest winner for the exact hardware/model fingerprint. See
> [AUTOTUNE_README.md](AUTOTUNE_README.md).

> **Adaptive full-stack 1.2:** independent Heavy experts now execute concurrently
> when live GPU headroom permits, with CUDA-OOM circuit breaking and capability-
> gated local context preparation. See [TURBO_EXECUTION.md](TURBO_EXECUTION.md).

> **Complete-stack v7:** See [COMPLETE_STACK_README.md](COMPLETE_STACK_README.md)
> for the coherent Drive-to-HF model assembler and verified Vast launcher.

> **Vast RTX 3090 copy:** This folder is the isolated Vast.ai deployment copy.
> Start with [VAST_RTX3090_DEPLOY.md](VAST_RTX3090_DEPLOY.md). The original
> `orislop_launch_ready` folder is intentionally unchanged. Vast instances do
> not support nested Docker Compose; this copy adds a single-container image,
> supervisor, strict full-model preflight, bootstrap, and hosted smoke test.
> It refuses readiness unless lightweight, spatial, public-frame, motion,
> promoted temporal (including extra-long), joint AV/lip-sync, and Ollama are
> all genuinely loaded.

> **Models currently in Google Drive:** run the one-cell Colab publisher at
> `scripts/COLAB_ONE_CELL_PUBLISH_DRIVE_MODELS.py`. It selects the promoted
> retrain, rejects incomplete model structures, uploads private immutable HF
> releases, and produces the exact pinned Vast configuration. See
> `docs/PUBLISH_DRIVE_MODELS_TO_HF.md`.

Version 1.3 adds first-run full-stack benchmarking and persistent hardware/model-specific strategy selection. Version 1.2 added resource-aware concurrent Heavy execution without removing any detector branch. Version 1.1 added annotation-first LinkedIn protection for posts, profiles, image-text claims, likely AI-written prose, on-open video analysis, explanations, and grounded follow-up chat. See [docs/LINKEDIN_PROTECTION.md](docs/LINKEDIN_PROTECTION.md).

Orislop Shield is a privacy-conscious feed protection suite for YouTube, Instagram Reels, TikTok, and LinkedIn. It looks ahead without scrolling, combines language context with lightweight and heavyweight visual verification, and removes Skip-rated short-form items before they reach the user. LinkedIn is annotation-first and does not automatically hide professional content. The unlisted beta is Windows-first Hybrid: Local Fast owns new items while Cloud Heavy warms, then ready Cloud Heavy owns only items that have not been decided yet.

The suite includes:

- A Manifest V3 browser extension with a production protection dashboard.
- Required Qwen 2.5 1.5B inference through local Ollama or the protected cloud service.
- A local Fast bridge plus Cloud Heavy: custom `orislop-fusion`, a pinned public frame detector, the pinned AEGIS motion branch, and the promoted temporal MoE in a guarded shadow rollout.
- Source-backed fact checking for informational Shorts through private Brave Search and/or Google Fact Check provider keys.
- A static product site and extension download artifact for Vercel or conventional static hosting.
- Desktop, scoring, storage, calibration, and model-adapter packages used by the shared evaluation suite.
- A Colab-ready AV-sync training pipeline with quality gating, abstention calibration, TorchScript export, and private Hugging Face upload.
- Automated production gates, release integrity hashes, operational diagnostics, and release runbooks.

## Product behavior

- Decisions are binary: **Don't skip** or **Skip**.
- The extension examines at most the next 10 visible candidates and never scrolls the feed.
- Dedicated Instagram and TikTok adapters use semantic fields plus bounded video-root fallbacks instead of page-wide scanning.
- Performance mode defaults to **Automatic**. Browser CPU and memory hints select Fast on weaker or uncertain local hardware and Heavy on clearly capable hardware; users can override either choice.
- **Fast** keeps Qwen and the strict lightweight visual detector active without loading the large spatial or temporal models; when a platform preview is available, it analyzes that bounded image instead of downloading the full video.
- **Heavy** runs the complete pinned stack. The promoted Temporal MoE is package-integrity checked and acts as strict corroboration, the real joint AV expert is required, and the old public Temporal checkpoints cannot vote. Independent branches overlap only when live VRAM headroom says that is safe.
- **Hybrid** gives every item one immutable visible decision. Automatic stays Fast-first and selectively escalates. Explicit Heavy sends every item with a usable media stream to Cloud Heavy; capable clients overlap bounded local context preparation with that request. A cloud miss still fails open to Local Fast.
- A strict lightweight visual model responds first while spatial and temporal models load.
- Reveal/undo remains reversible, but an automatic Fast/Heavy result never flips after it becomes visible.
- Explicit synthetic disclosures and strong model evidence remain non-vetoable Skip decisions.
- When a required engine is unavailable, uncertain content fails open and stays visible.
- Local mode keeps model inference and temporary media on the device. After explicit consent, Hybrid may send item metadata and an expiring direct media URL to `api.orislop.com`; browser cookies and site credentials are never sent, the URL is never persisted, and ordinary media is deleted within 60 seconds.
- Skip covers continuously pause and mute their media until the user chooses Don't skip, and the popup totals known skipped runtime as time saved.
- The toolbar badge always shows `ON`, `OFF`, an alert, or the latest hidden-item count. A brief on-page confirmation and the popup's Live Scanner show when Orislop is actively checking the current feed, with a one-click fresh scan.
- **Explain video** asks Qwen for a plain-language account grounded in the captured title, captions, and transcript. A source-contradicted Skip instead offers **Why is this wrong?**, which explains Orislop's decision from the retained trusted evidence and links directly to those sources.

## Requirements

- Windows 10/11 for the current companion-service launcher
- Node.js 22.12 through 24.x
- pnpm 11.9.0 (pinned by `packageManager`)
- Ollama with `qwen2.5:1.5b-instruct`
- Python 3.11 or newer
- NVIDIA GPU recommended for heavyweight temporal inference

Install the JavaScript workspace and detector environment:

```powershell
pnpm install --frozen-lockfile
pnpm detector:setup
ollama pull qwen2.5:1.5b-instruct
pnpm fact-check:setup
```

For the complete promoted-model setup, use the guarded bootstrap instead. It requires either the local `final_model_package` directory or a private Hugging Face model repo pinned by commit and weights SHA-256:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrapOrislop.ps1 `
  -TemporalPackagePath "D:\models\orislop\final_model_package" `
  -Start
```

See [the promoted-pipeline launch guide](docs/LAUNCH_PROMOTED_PIPELINE.md) for the private-Hugging-Face and hosted Cloud Heavy paths.

After loading the unpacked extension, copy its 32-letter ID from `chrome://extensions` or `brave://extensions` and lock the local bridge to it:

```powershell
pnpm extension-origin:setup
```

## Daily use

Start the complete local runtime:

```powershell
pnpm orislop:start
```

Run a health report at any time:

```powershell
pnpm orislop:doctor
```

Stop only the companion processes launched by Orislop; browser windows are never touched:

```powershell
pnpm orislop:stop
```

Install or remove the reversible per-user logon task for zero-click local fallback startup:

```powershell
pnpm orislop:autostart:install
pnpm orislop:autostart:remove
```

After the one-time install, Automatic performance mode and the logon task require no daily setup. Browser hardware values are approximate privacy-preserving hints, so ambiguous PCs default to Fast and the popup always shows the effective choice.

For a one-run production extension origin override (the persistent setup command above is preferred):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/startOrislop.ps1 `
  -ExtensionOrigin chrome-extension://YOUR_32_CHARACTER_EXTENSION_ID
```

## Browser extension

Build the load-unpacked directory:

```powershell
pnpm extension:build
```

Load `apps/extension/dist` from `chrome://extensions`, `brave://extensions`, or `edge://extensions`. The Chrome Web Store upload artifact is produced at `dist/orislop-browser-extension.zip`.

## Cloud inference

Hybrid is the only cloud beta mode: local Fast remains available while protected Cloud Heavy, the promoted temporal shadow detector, Qwen, explanations, and fact checking can run in the GPU stack. Google PKCE sign-in replaces pasted API tokens. The immutable image workflow, calibration tool, and deployment runbook are included:

```powershell
pnpm cloud:check
pnpm cloud:test:local
pnpm cloud:token
```

See [cloud deployment](docs/CLOUD_DEPLOYMENT.md). Cloud Heavy remains shadow-only until approved calibration sets the beta gate; public promotion separately requires at most 0.1% genuine hides.

## AV-sync model training

The newer staged joint audio-visual detector, Temporal MoE integration,
independent spatial corroboration, and guarded Phase 3 experiment are documented
in [`docs/AV_JOINT_ROLLOUT.md`](docs/AV_JOINT_ROLLOUT.md). Joint AV stays disabled
and shadow-only until commercially trained weights and every release gate exist.

The experimental lip/audio synchronization expert can be trained on Google Colab without changing the extension build. Open [the AV-sync Colab notebook](training/orislop_avsync/orislop_avsync_colab.ipynb) and follow [the dataset and safety guide](training/orislop_avsync/README.md). The exported model abstains when speech, mouth motion, face coverage, duration, or audio quality are insufficient; its mismatch probability must be corroborated by Orislop fusion before automatic Skip.

The frozen-expert Temporal MoE v5 retrain is also Colab-ready. Open [the T4 Temporal fusion notebook](training/orislop_temporal_retrain/orislop_temporal_fusion_v5_colab.ipynb) and follow [the resumable training guide](training/orislop_temporal_retrain/README.md). It caches the four existing experts once, retrains Stage 2 fusion, calibrates Stage 3 on validation, and evaluates once on an untouched test cache. Spatial stays independent in this phase.

Run its lightweight local contract check with:

```powershell
.\.venv-detector\Scripts\python.exe training\orislop_avsync\train_avsync.py self-test
```

## Product site and Vercel

```powershell
pnpm web:build
pnpm web:preview
```

Vercel uses `vercel.json`, builds with `pnpm run web:build`, and publishes `apps/web/dist`. The same build embeds the exact verified extension ZIP offered by the product site.

## Production gate

Run the complete local release gate:

```powershell
pnpm production:check
```

The gate runs TypeScript validation, model-artifact integrity, extension, web, scoring, storage, adapter, desktop, and detector contract tests. It then rebuilds both release ZIPs, generates SHA-256 checksums in `dist/release-manifest.json`, and verifies that every archived byte matches the live build output.

GitHub Actions runs the same gate for pull requests and `main` pushes.

## Security and privacy

- Local mode binds only to `127.0.0.1`; Cloud Heavy requires TLS, Google account sessions, quotas, and an exact extension-origin allowlist.
- Inference POST requests require an approved Chrome-extension origin.
- Production can restrict requests to exact extension origins.
- Media acquisition uses exact page-host and media-CDN allowlists, safe redirect validation, response type checks, and a 120 MB limit.
- Cloud ordinary media stays in tmpfs for no more than 60 seconds. Only an explicit report may retain an encrypted eight-second 360p clip for seven days.
- The extension requests storage, Chrome Identity, supported-feed, `api.orislop.com`, Ollama loopback, and detector loopback access.
- No secret keys or remote analytics are included in the extension.
- Fact-check provider keys stay in the ignored companion environment or cloud secret manager; they are never embedded in browser code.

Read [cloud deployment](docs/CLOUD_DEPLOYMENT.md), [fact-checking policy](docs/FACT_CHECKING.md), [the threat model](docs/THREAT_MODEL.md), [production operations](docs/PRODUCTION_OPERATIONS.md), and [the release checklist](docs/RELEASE_CHECKLIST.md) before public distribution.
