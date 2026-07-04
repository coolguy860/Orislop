# Load The Orislop Browser Extension

This is the browser version that can run directly on YouTube pages. It is still a local prototype, but unlike the static website it can inspect visible YouTube cards and hide videos inside the page.

## Build

1. Run `pnpm install`.
2. Run `pnpm run extension:build`.
3. Confirm the loadable folder exists at `apps/extension/dist`.

## Load In Chrome Or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `apps/extension/dist`.
5. Open `https://www.youtube.com`.

## What It Does

- Runs only on YouTube pages.
- Scores visible YouTube cards and Shorts containers locally.
- Replaces Skip-scored videos with an Orislop hidden-card shield.
- Outlines Questionable videos.
- Attempts best-effort autoskip for the current flagged Short/watch video when enabled.
- Saves a local flagged log in browser extension storage.
- Saves a local skipped/hidden cache showing which videos were hidden or auto-skipped.
- Adds a popup showing flagged count, skipped count, autoskip toggles, detector status, and clear-log buttons.

## What It Does Not Do

- It does not use a YouTube API key.
- It does not download videos.
- It does not scrape comments.
- It does not run PyTorch or local model checkpoints.
- It does not run the spatial or temporal Hugging Face detectors inside the browser extension.
- Spatial/temporal detector execution requires a local companion/Electron process that can run model code safely.
- It does not send data to a server.
- It does not block ads at the network level.

## ZIP

Run `pnpm run extension:zip` to create `dist/orislop-browser-extension.zip`.
