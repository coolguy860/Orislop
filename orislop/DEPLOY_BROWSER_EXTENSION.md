# Build and distribute Orislop Shield 1.3.0

Orislop is a Manifest V3 extension for YouTube, Instagram Reels, TikTok, and LinkedIn. It supports two inference modes. Local mode uses:

- Ollama with `qwen2.5:1.5b-instruct` for transcript and metadata slop decisions.
- The Orislop detector bridge for `gonnerthetooner/orislop-fusion` and `gonnerthetooner/deepfake-temporal-moe`.

Chrome cannot run Python or PyTorch inside an extension, so local visual models run in a companion bound only to `127.0.0.1:4317`. Cloud mode instead calls the authenticated `https://api.orislop.com` GPU service. Both modes queue scans and the extension polls for results without scrolling the page.

## First-time local setup

Install and start Ollama:

```powershell
ollama run qwen2.5:1.5b-instruct
```

Install the detector environment once:

```powershell
Set-Location "C:\path\to\orislop"
pnpm detector:setup
pnpm fact-check:setup
```

The first detector scan downloads the public Hugging Face weights and base vision models. This is a large one-time download. An NVIDIA GPU is strongly recommended for the temporal model; CPU inference is supported by the runtime but can be very slow.

The visual bridge:

- Uses a strict lightweight frame detector first and returns a provisional result while the heavyweight models load.
- Accepts only YouTube, Instagram, TikTok, and LinkedIn page URLs or approved media-CDN URLs.
- OCR-reads bounded LinkedIn-hosted images with Tesseract for source-backed image-claim checks.
- Listens on loopback only.
- Rejects normal website origins.
- Keeps model inference and decisions local.
- Sends only extracted claim search queries to the configured evidence provider; provider keys remain in the local bridge.
- Deletes temporary media after each scan and caches only the decision in memory.

For a cloud-only tester, skip local setup after the cloud API is deployed. Open **Setup & diagnostics**, select **Orislop Cloud**, and configure the per-tester access token. See `docs/CLOUD_DEPLOYMENT.md`.

## Build

```powershell
pnpm install
pnpm production:check
```

The loadable folder is `apps/extension/dist`. The Chrome Web Store upload is `dist/orislop-browser-extension.zip`.

Confirm that `manifest.json` and `release-info.json` both report version `1.3.0`, and retain `dist/release-manifest.json` with the release artifacts.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `apps/extension/dist`.
5. Copy the 32-letter extension ID shown on the extensions page.
6. Run `pnpm extension-origin:setup`, paste that ID, then run `pnpm orislop:start`.
7. Open the extension popup and confirm the header reads **Protected**.
8. Run `pnpm orislop:doctor` for a full local health report.

## Decision behavior

- The only user-facing verdicts are **Don't skip** and **Skip**.
- Explicit AI/synthetic text is a non-vetoable 100/100 Skip.
- A strong spatial, temporal, or combined visual synthetic signal is also a non-vetoable 100/100 Skip.
- A lightweight score at or above 0.94 can provisionally hide an item; heavyweight verification replaces that result and can restore it.
- Ollama decides whether remaining transcript/metadata feels like low-value slop.
- A visual “real” result never vetoes an Ollama slop decision.
- Skip-rated future feed items are hidden instead of auto-scrolled.
- Current videos receive a yellow cover constrained to the media surface.
- Unavailable models fail open: the item remains visible and the popup reports the missing engine.
- Informational Shorts are source-checked; only a high-confidence contradiction backed by two independent trusted domains can create a fact-check Skip.
- LinkedIn posts and profiles are annotated instead of automatically hidden. Writing-origin labels are advisory, and unopened LinkedIn videos remain deferred until open/play.

## Model configuration

Visual thresholds live in `configs/detector_thresholds.json`. Production checkpoint paths live in `configs/model_adapters.json`.

The temporal runtime uses:

- Stage-1 micro, mid, long, and extra-long experts from `a100_high_vram_60gb_v1`.
- Fusion and calibration from `a100_balanced_fusion_v4`.

Do not commit downloaded `.pt` files, the detector virtual environment, caches, ZIPs, or temporary videos.

## Production hardening

Persist the exact published extension origin:

```powershell
pnpm extension-origin:setup
pnpm orislop:start
```

Before Chrome Web Store submission, complete `docs/RELEASE_CHECKLIST.md`. The extension ships raster PNG icons because Chrome does not support SVG files declared as manifest icons.
