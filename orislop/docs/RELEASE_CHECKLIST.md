# Release checklist

## Code and model integrity

- [ ] Working tree reviewed; unrelated user changes preserved
- [ ] `pnpm install --frozen-lockfile` succeeds on a clean machine
- [ ] `pnpm production:check` passes
- [ ] `pnpm audit:cross-platform-128` reports 128 deterministic items and 112 video-shaped candidates
- [ ] `pnpm extension:test:live` passes with the required Qwen model
- [ ] `pnpm extension:test:platforms-live` injects on all four platforms with no extension runtime errors
- [ ] Detector health reports version 1.3.0, expected repositories, thresholds, scheduler/autotune telemetry, and no last error
- [ ] `dist/release-manifest.json` hashes match both release ZIPs

## Browser acceptance

- [ ] Fresh install and upgrade tested in Chrome and Brave
- [ ] Toolbar, extension manager, and store candidate display the PNG icon correctly
- [ ] Master pause restores hidden items and removes covers
- [ ] Don't skip overrides a current decision without navigation
- [ ] Skip removes the intended video surface and never the viewport
- [ ] A decided item never flips when Heavy becomes ready or returns a different result
- [ ] New items move from Fast ownership to Heavy ownership only after the Heavy bundle reports ready
- [ ] Ten-item scoring batches do not scroll, lock, or duplicate history
- [ ] YouTube home, watch, and Shorts layouts tested
- [ ] Instagram home video, Reel page, and Reel-dialog candidate discovery tested
- [ ] Instagram creator/caption extraction excludes Like, Follow, Share, counts, and timestamps
- [ ] TikTok For You, direct video, browse, and search-card candidate discovery tested
- [ ] TikTok creator/video IDs remain stable when tracking query parameters change
- [ ] Instagram/TikTok current covers stay inside the media surface and future Skip items hide without navigation
- [ ] Informational Instagram Reels and TikToks enter the same source-backed fact-check path as YouTube Shorts
- [ ] LinkedIn scans at most 100 already-loaded items, never auto-scrolls, and never auto-hides posts or profiles
- [ ] LinkedIn image text enters bounded OCR and source checking
- [ ] LinkedIn video analysis stays deferred until open/play and then uses the normal detector pipeline
- [ ] LinkedIn post/profile explanations and grounded chat pass live Qwen checks
- [ ] Offline Ollama and offline detector states fail open and show useful guidance

## Model acceptance

- [ ] Cloud Heavy calibration uses at least 1,000 unique, human-reviewed full videos: at least 500 genuine and 500 synthetic
- [ ] Validation provenance is approved and every retained score maps to a rights-cleared video identifier
- [ ] Synthetic recall is at least 90% and the public genuine-hide rate is at most 0.1%
- [ ] At least 10,000 online shadow decisions are reviewed before automatic Cloud Heavy hides are enabled

## Privacy and security

- [ ] Published extension origin is the only value in `ORISLOP_ALLOWED_EXTENSION_ORIGINS`
- [ ] Originless POST override is disabled
- [ ] Local port 4317 is not exposed beyond loopback; cloud port is reachable only through managed TLS ingress
- [ ] Cloud mode requires bearer auth and rejects wrong/missing tokens
- [ ] `api.orislop.com` capacity, alerts, quotas, cache expiry, and rollback tested
- [ ] Store privacy disclosure matches actual host permissions and selected local/cloud processing
- [ ] No `.env`, token, model checkpoint, activity history, log, or temporary media is packaged
- [ ] Copied diagnostics contain no activity title or URL

## Distribution

- [ ] Extension manifest and release info both report 1.3.0
- [ ] Chrome Web Store ZIP uploaded from `dist/orislop-browser-extension.zip`
- [ ] Vercel production deployment uses the verified commit and `apps/web/dist`
- [ ] `orislop.com` TLS, canonical domain, privacy page, and download link checked
- [ ] Rollback ZIP and previous Vercel deployment retained
- [ ] Release notes include behavior changes, model changes, permissions, known limits, and rollback instructions
