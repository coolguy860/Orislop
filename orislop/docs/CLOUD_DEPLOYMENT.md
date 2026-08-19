# Orislop Hybrid Cloud Heavy beta

This beta is Hybrid-only. Local Fast and local Qwen start the user experience immediately. Items decided during warmup remain permanently owned by Fast; once the signed-in Cloud Heavy bundle reports ready, only new items are assigned to it. Playback remains responsive and a visible decision never flips. Vercel hosts `orislop.com`; it does not host this persistent GPU API.

The extension progressively scans every candidate currently loaded in the feed DOM. It runs the metadata/title Fast sweep first, then prioritizes deeper work as current item, visible items, nearby items, and the remaining loaded feed. Deeper work stays in bounded ten-item batches with one local lane or two Hybrid submission lanes, so infinite feeds cannot freeze the page or flood the GPU.

Cloud Heavy loads exactly three signals:

- `gonnerthetooner/orislop-fusion`, five shared sampled frames.
- `prithivMLmods/Deepfake-Detection-Exp-02-21` at revision `adf169cf452ea42f80d8cdca1302c8c9d09d1725`, five-frame mean.
- the motion branch only from `MusapYildiz/aegis-video-detector` at revision `95b71346cec650165e6ad3fb20ed9e80f4b6702a`, using 16 frames from one deterministic centered four-second window.

The two frame models are calibrated into one spatial-family probability. A reversible visual hide requires that family and the independent motion branch to cross their calibrated thresholds. The old Temporal MoE, AEGIS pixel/full-fusion branches, and AV/lip-sync cannot vote in this runtime.

## Release state

`configs/cloud_heavy_v1.json` intentionally ships with `calibrated: false` and `betaGatePassed: false`. Therefore every cloud decision is shadow-only even if an environment variable requests aggressive mode. Do not change those booleans by hand. Fit the calibration artifact from approved validation scores:

```powershell
.\.venv-detector\Scripts\python.exe scripts\fit_cloud_heavy_calibration.py `
  --scores-jsonl C:\approved-data\cloud-heavy-validation.jsonl `
  --provenance-approved
```

Each JSONL row needs `split` (`calibration` or `validation`), `label`, `customSpatialProbability`, `publicFrameProbability`, and `motionRawLogit`. Calibration is fit only on the calibration split; thresholds and gates are measured only on validation. The script maximizes consensus F2 subject to at least 90% synthetic recall and enables the beta gate only when provenance is explicitly approved. The separate public gate also requires at most 0.1% genuine hides.

## 1. Establish the stable extension identity

1. Create the unlisted Chrome Web Store item and copy its 32-character extension ID.
2. Create the Google Chrome Extension OAuth client for that exact item.
3. Build the upload ZIP with the public client ID:

```powershell
$env:ORISLOP_GOOGLE_OAUTH_CLIENT_ID = '<client-id>.apps.googleusercontent.com'
pnpm extension:zip
```

The popup shows the full cloud-transmission disclosure before its only enable action. OAuth requests only `openid`, `email`, and `profile`. Access tokens last 15 minutes in `chrome.storage.session`; rotating refresh tokens last 30 days and reuse revokes the session.

## 2. Provision managed services

Create:

- one persistent Runpod Secure Cloud Pod with a 24 GB NVIDIA GPU;
- managed Postgres;
- a dedicated S3-compatible diagnostic bucket;
- a Cloudflare Tunnel hostname `api.orislop.com -> http://localhost:4317`.

Configure the diagnostic bucket lifecycle to permanently delete objects tagged `orislop-retention=7d` after seven days. Orislop uploads only an explicit report's maximum eight-second, 360p clip with server-side encryption. Ordinary media lives only in the container tmpfs and is destroyed within 60 seconds.

## 3. Publish and run an immutable image

The GitHub workflow publishes only a commit-addressed tag:

```text
ghcr.io/coolguy860/orislop-cloud:sha-<commit>
```

Run `pnpm cloud:check` first. Configure the Runpod Pod with that exact SHA tag, a persistent `/models` volume, GPU access, and the variables shown in `docker-compose.cloud.yml`. Required secrets are:

```text
ORISLOP_API_TOKENS
ORISLOP_ALLOWED_EXTENSION_ORIGINS=chrome-extension://<stable-id>
ORISLOP_GOOGLE_OAUTH_CLIENT_ID
ORISLOP_TOKEN_SECRET
ORISLOP_CONTENT_HMAC_SECRET
DATABASE_URL
ORISLOP_DIAGNOSTIC_BUCKET
ORISLOP_S3_ENDPOINT
ORISLOP_S3_ACCESS_KEY_ID
ORISLOP_S3_SECRET_ACCESS_KEY
CLOUDFLARE_TUNNEL_TOKEN
HF_TOKEN                       # only if a custom model repo is private
```

The GPU image is visual-only and contains no Ollama. It verifies pinned model hashes before readiness. A single bounded heavyweight worker gives current items priority over lookahead work.

New feed candidates are submitted through `POST /v2/analyze/batch` in groups of at most ten. The endpoint charges quota per candidate, returns a `clientId` mapping for each item, and fails open per item. Polling remains `GET /v2/analyze/{decisionId}`. Older cloud deployments that do not expose the batch endpoint automatically fall back to `POST /v2/analyze` until the image is upgraded.

The initial Fast sweep has a two-second UI target and reports its measured duration. Warm Heavy also targets a measured P95 below two seconds, but that is not a correctness guarantee: queue depth, media download time, and GPU type can move it above the target. The popup reports actual Heavy P95. A Heavy-owned item has one bounded decision window and fails open to its concurrent Local Fast result instead of changing later. The existing five-second P95 rollout guard remains the automatic shadow fallback until production measurements justify tightening it.

## 4. Validate in order

1. Keep `ORISLOP_CLOUD_HEAVY_ROLLOUT=shadow` and `ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES=0`.
2. Run offline wrapper parity, preprocessing, calibration, and GPU cold/warm smoke tests.
3. Sign in as the owner and collect shadow decisions.
4. Verify exact-origin CORS, expired direct URLs, queue preemption, temporary deletion, object lifecycle, refresh replay, quotas, account deletion, and Cloudflare TLS.
5. After the calibration file has `betaGatePassed: true`, set both rollout variables to aggressive for the unlisted beta.
6. Review at least 10,000 online decisions before public calibration.

Cloud Heavy automatically falls back to shadow when more than 5% of 100 jobs fail/OOM, warm P95 exceeds five seconds, more than 20% of 100 hides are revealed, or five confirmed wrong-hide reports arrive in 24 hours. Local Fast and explicit synthetic-text rules stay active.

## Media and policy boundary

Cloud mode accepts only an expiring direct CDN media URL already exposed by the playing element. It never runs `yt-dlp` or scrapes a platform page. Missing, expired, or unsupported media fails open to Local Fast. Complete platform-policy review remains required before public distribution.

Therefore “every loaded item” means every item receives the Fast metadata/context sweep. Cloud Heavy can run only for loaded items whose media element exposes an approved direct stream; thumbnail-only cards remain protected by Fast until the platform exposes media during playback or preview.
