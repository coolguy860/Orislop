# Chrome Web Store listing

## Product name

Orislop Shield

## Summary

Privacy-conscious local or cloud intelligence that removes low-value and synthetic content before it reaches your feed.

## Detailed description

Orislop Shield protects your attention across YouTube, Instagram Reels, TikTok, and LinkedIn. It quietly examines upcoming feed items without scrolling, uses context intelligence to distinguish useful content from empty slop, and verifies visual authenticity with a lightweight-first detector pipeline. Users can choose the local companion or the authenticated Orislop Cloud service.

What Orislop does:

- Keeps education, tutorials, reporting, original analysis, art, music, comedy, and ordinary personal videos visible.
- Removes recycled clips, content farms, unrelated-gameplay narration, empty compilations, scams, and engagement bait when the selected inference service identifies them as slop.
- Treats explicit or strongly detected synthetic media as a Skip decision.
- Starts with a fast fixed decision while deeper models load; ready Heavy applies only to new items, so cards never flip.
- Defaults to Automatic performance selection: weaker local PCs use Fast lightweight detection, powerful PCs use the full Heavy pipeline, and either choice can be overridden.
- Checks informational claims against current trusted sources and published fact-check records when a private provider key is configured.
- Explains the current video from its available captions and transcript, and explains source-backed contradiction decisions with direct evidence links.
- Annotates LinkedIn posts and profiles with claim, image-text, and advisory AI-writing checks plus grounded follow-up chat.
- Defers LinkedIn AI-video detection until the user opens or plays the video; a thumbnail alone never becomes an AI-video verdict.
- Never auto-scrolls your feed.
- Lets you override any current decision with Don't skip.
- Blocks both picture and audio behind a Skip cover until the user overrides it.
- Shows an ON/OFF toolbar badge, a brief in-page scan confirmation, and a Live Scanner in the popup so users can tell that protection is running.
- Stores settings, protected activity, and known skipped runtime only in your browser profile, then displays the resulting time saved.

Local mode requires the free Ollama runtime and Orislop detector companion. Cloud mode requires no local models and sends disclosed feed text plus supported public page/media references to `api.orislop.com` for inference. Orislop does not use behavioral advertising or sell user data. Configured fact checks send extracted claim queries to the selected evidence provider.

## Permission justifications

### Storage

Stores the protection toggle, selected local model name, performance preference, local engine status, non-sensitive scanner counts/state, user overrides, recent protected activity, and video duration/time-saved values in the user's browser profile. Scanner state includes the supported platform, visible-item count, unique checked-item count, and timestamp—not captions or titles. Automatic performance selection reads only coarse browser-provided logical-thread and memory hints; it does not benchmark or fingerprint the device.

### YouTube, Instagram, TikTok, and LinkedIn hosts

Reads only visible feed metadata, captions, post/profile text, image alt text, media URLs, and media containers needed to score or annotate supported feed items. Orislop does not read unrelated websites.

### 127.0.0.1 and localhost on port 4317

Connects only to the local Orislop companion. The companion brokers local Ollama context scoring and visual detection on loopback, so the extension never grants browser-level access to Ollama's port. This permission does not grant access to remote internet hosts.

### api.orislop.com

When the user selects Orislop Cloud, sends supported page/media references, titles, creator names, visible captions or metadata, and transcript excerpts to the authenticated Orislop inference API. The permission is not used in local mode.

## Privacy disclosure

- No sale or transfer of user data
- No advertising or behavioral analytics
- No remote code execution
- No collection of site cookies, site passwords, private messages, or general browsing history
- Local mode keeps feed metadata and temporary media on the user's device
- Cloud mode sends only the disclosed supported-feed fields to `api.orislop.com`; bounded in-memory caches expire automatically
- Extracted informational claims are sent to the configured search provider only when source verification is enabled
- Evidence-provider API keys stay in the local companion or cloud secret manager and are never exposed to the extension
- Temporary detector media is deleted after analysis
- Activity history can be cleared from the popup

## Store media checklist

- 128 × 128 store icon from `apps/extension/src/icons/icon128.png`
- At least one 1280 × 800 or 640 × 400 screenshot
- Recommended screenshots: protected dashboard, hidden-video cover, Fast-to-Heavy readiness handoff, activity and diagnostics panel
- Optional 1400 × 560 promotional tile using the black/gold Orislop Shield visual system

Do not submit screenshots containing another user's account name, private recommendations, or browsing history.
