# Orislop 1.1.0 launch audit

Audit date: 2026-07-20
Audited product: Orislop Shield 1.1.0
Platforms: YouTube, Instagram, TikTok, and LinkedIn

## Executive decision

The Orislop 1.1.0 codebase is a verified release candidate. The exact audited source passes the deterministic production gate, builds reproducible web and browser-extension archives, verifies their SHA-256 integrity, injects on live public pages for all four target platforms, and completes the live local-Qwen explanation and chatbot flow.

Public Cloud Heavy automatic hiding is **not approved for general launch yet**. The checked-in release configuration correctly keeps that path in shadow/beta mode because the required human-reviewed visual validation, provenance approval, production credentials, and online shadow-decision gate have not been supplied. Fact checking also requires a configured Brave Search or Google Fact Check provider.

This distinction is intentional: the local Fast path, conservative fail-open behavior, explanations, and advisory features are release-candidate ready; uncalibrated visual-model certainty is not being claimed.

## Evidence summary

| Area | Result | Evidence |
| --- | --- | --- |
| Full production gate | Pass | Release configuration, cloud contract, model hashes, TypeScript, web, extension, adapters, scoring, storage, desktop, lookahead, skip controls, extraction, bridge, temporal pipeline, builds, manifest, and archive verification |
| Detector bridge | Pass | 78 automated tests passed; one optional environment-dependent test skipped |
| Cross-platform corpus | Pass | 128 deterministic items, including 112 video-shaped candidates; deterministic replay passed in 35.17 ms |
| Real YouTube audit | Pass | 120 distinct rendered YouTube video IDs; 15/15 explicitly AI-titled samples hard-skipped; educational false-hide gate passed; no automatic viewport jump; no extension runtime exceptions |
| Live public-page smoke | Pass with anonymous-layout limits | Extension injected on YouTube, Instagram, TikTok, and LinkedIn; zero service-worker runtime errors |
| Live popup | Pass | Version 1.1.0 and LinkedIn coverage visible; 18 interactive controls rendered |
| Live local Qwen | Pass | Classification, explanation, “why wrong,” grounded fact chat, LinkedIn profile explanation, LinkedIn post chat, and empty-question validation passed |
| Dependency health | Pass | `pnpm audit --audit-level=high` reported no known vulnerabilities; Python `pip check` reported no broken requirements |
| Release archives | Pass | Static website and extension ZIPs were rebuilt, hashed, and verified against `dist/release-manifest.json` |

## What “tested on over 100 videos” means

Two complementary launch audits were used:

1. The real YouTube browser audit collected and scored 120 distinct video IDs from 15 rendered YouTube sessions in an isolated Microsoft Edge profile with the unpacked production extension.
2. The deterministic four-platform corpus evaluated 128 feed items, 112 of which were video-shaped candidates, across YouTube, Instagram, TikTok, and LinkedIn.

The 120-video live audit validates real DOM discovery, Fast metadata decisions, hide/allow behavior, scrolling safety, playback blocking, and extension stability. It does **not** claim that 120 entire videos were downloaded and fully evaluated by the GPU visual ensemble. Orislop intentionally defers full visual video analysis until a user opens or plays a video.

## Platform acceptance

### YouTube

- Live search, feed, watch, and Shorts behavior exercised.
- 120 distinct rendered video IDs scored.
- Explicit AI-title hard override passed for all 15 matching samples.
- Educational-content hard-hide rate stayed below the launch ceiling.
- Manual scrolling worked and Orislop never moved the viewport automatically.
- Hidden media left the layout and could not continue playing.

### Instagram

- Reels/feed/dialog selectors, caption extraction, stable identity, bounded scanning, covers, and fail-open behavior passed in isolated Chromium DOM fixtures.
- The clean anonymous live profile received Instagram's authentication-limited layout, so it provided injection and runtime-stability evidence but no live feed candidates.

### TikTok

- For You/direct-video/browse/search-card selectors, stable IDs, bounded scanning, covers, and fail-open behavior passed in isolated Chromium DOM fixtures.
- The live public direct-video page injected successfully and processed rendered candidates with no extension runtime errors.

### LinkedIn

- Post, article, profile, image, text, and opened-video handling passed in isolated Chromium DOM fixtures.
- The feed scan is bounded to the next 100 already-loaded items and does not auto-scroll.
- AI-writing signals are advisory and never auto-hide a LinkedIn post.
- Image-text OCR and factual-claim routing are bounded and fail open.
- Video AI analysis remains deferred until open/play, then uses the normal Orislop video pipeline.
- Profile/post explanations and grounded chat passed the live local-Qwen check.
- A broken-image dimension bug found during audit was fixed by considering intrinsic, rendered, and declared dimensions before rejecting an image candidate.
- The clean anonymous live page displayed LinkedIn's sign-in overlay; extension injection and runtime stability passed, while authenticated-feed acceptance remains a manual release check.

## Error handling and security

- Offline/unavailable Heavy and text-model paths fail open and present actionable status instead of hiding uncertain content.
- Malformed candidates, authentication failures, capacity/quota errors, timeouts, invalid chat questions, cache behavior, and unsupported media are covered by automated bridge and extension tests.
- Dynamic user-facing strings are escaped or assigned via `textContent`; constrained static templates do not interpolate arbitrary page text.
- The release scanner rejects packaged secrets, environment files, model checkpoints, activity history, temporary media, and unsupported host permissions.
- Cloud public mode requires managed TLS ingress, bearer authentication, an explicit extension-origin allowlist, database-backed quota state, encrypted diagnostics storage, and originless POSTs disabled.
- The model artifacts used by runtime checks are pinned and hash-verified.

## Required public-launch gates

These are deployment or evidence requirements, not silently assumed credentials:

- Supply the production Google OAuth client ID, token/content-HMAC secrets, database URL, managed ingress, encrypted diagnostic storage, quotas, alerts, and rollback configuration.
- Configure Brave Search or Google Fact Check credentials if factual source checking is advertised as active.
- Replace or formally approve the unresolved proprietary spatial-checkpoint dataset provenance.
- Validate at least 1,000 unique human-reviewed full videos: at least 500 genuine and 500 synthetic.
- Demonstrate at least 90% synthetic recall and no more than a 0.1% genuine-video automatic-hide rate.
- Review at least 10,000 online shadow decisions before enabling Cloud Heavy automatic hides.
- Complete authenticated manual acceptance on current Instagram, TikTok, and LinkedIn feeds.
- Complete fresh-install and upgrade acceptance in Chrome and Brave.
- Publish the verified extension ZIP and web build, configure the final extension origin, verify production TLS/privacy/download pages, and retain a rollback release.

Until those gates are recorded, launch the extension as a conservative local/advisory release candidate with Cloud Heavy automatic hiding disabled.

## Audited artifact hashes

The production gate generated these hashes before final delivery packaging:

- Browser extension ZIP: `437f035faaa49ad34153273a6a67f7e1b2b95378ce8677cfab1124b0bd295a17`
- Static website ZIP: `1c68284f8b3d67a165525e59cb9b66eb3b4389361b0db6b478c01452aec614fa`

The final delivery directory also includes the machine-readable launch evidence and screenshots used in this audit.
