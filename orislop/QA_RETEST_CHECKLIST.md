# Orislop QA Retest Checklist

Use this checklist for the fixed static website and extension artifacts.

## Required Artifact Identity

- Static ZIP: `dist/orislop-namecheap-static.zip`
- Extension ZIP: `dist/orislop-browser-extension.zip`
- Static release ID: `orislop-shield-web-1.3.0-2026-08-18`
- Extension release ID: `orislop-shield-autotune-1.3.0-2026-08-18`
- Extension manifest version: `1.3.0`

Run:

```powershell
pnpm run web:deploy:zip
pnpm run extension:zip
pnpm run audit:cross-platform-128
pnpm run extension:test:platforms
pnpm run extension:test:platforms-live
pnpm run release:verify
```

Do not retest browser-renamed stale files such as `orislop-namecheap-static(1).zip`,
`orislop-namecheap-static(2).zip`, or `orislop-browser-extension(1).zip` unless their
release info matches the IDs above.

## Website Must-Pass Checks

- `/release-info.json` exists and contains `orislop-shield-web-1.3.0-2026-08-18`.
- `/privacy.html` exists.
- Analyzer starts with an empty URL field.
- Blank, whitespace, malformed, or non-YouTube URLs keep Analyze disabled.
- Optional title/description fields cannot produce a score without a valid YouTube URL.
- Watch, Questionable, and Skip definitions are visible.
- Strictness explanation and multipliers are visible.
- The compact source breakdown is visible after analysis; base points, stacked bonus, multiplier, thresholds, and per-signal points are available under `How Orislop made this score`.
- AI classifier source score is visible after analysis.
- Spatiotemporal status clearly says not used when unavailable.
- If `index.html` is opened through `file://`, a visible fallback explains to run `pnpm run web:preview` instead of showing a blank page.

## Expected Static Scoring Examples

Use Strict mode unless noted:

- `1 Hour Reddit Stories for the Coziest Sleep + Silent Minecraft Parkour` -> `Skip 100/100`
- `Minecraft Parkour Reddit story` -> `Skip 100/100`
- `This finance trick banks hate` -> `Questionable`, about `44/100`
- `Ranking the most satisfying videos` -> `Questionable`, about `30/100`
- `You won't believe this satisfying background` plus `Follow for more` -> `Questionable`, not `Skip`
- `How rainfall forms in mountain regions` -> `Watch`, about `8/100` for Shorts
- `Chorus practice la la la la la la la la` with song/lyrics context should not trigger `Repetitive title/caption`

## Extension Must-Pass Checks

- Manifest version is `1.3.0`.
- Toolbar badge reads `ON` after reload, `OFF` when protection is paused, and `!` only when a core text/video engine is unavailable.
- YouTube, Instagram, TikTok, and LinkedIn show the brief Orislop-on/scanning pill, and the popup Live Scanner updates its checked count.
- **Scan now** starts a fresh scan on the current supported tab without scrolling or navigation.
- Popup and Chrome icon sizes use the orange/navy shield artwork and remain legible at 16 px.
- Icons exist at `16`, `32`, `48`, `128`, and `256`.
- `release-info.json` exists in the ZIP.
- Popup opens and shows local storage controls.
- Current Skip-rated videos show an Orislop cover constrained to the media surface.
- Orislop never emits next-video, ArrowDown, PageDown, wheel, or scroll actions.
- Visible YouTube AI/synthetic disclosure text scores as `Skip 100`.
- Feed/list cards with visible AI/synthetic disclosure text are hidden and logged as protected activity.
- The old worker/debug status bar is not visible on YouTube.
- Verdicts are binary: Don't skip or Skip. Uncertain content stays visible.
- Scan loop uses the local fast scoring path first.
- Scan loop is throttled, uses IntersectionObserver where available, and scores in bounded ten-item batches.
- LinkedIn scans at most the next 100 already-loaded items without scrolling or manufacturing engagement.
- Popup switches expose accessible labels and `aria-checked`.
- Orislop AI Classifier v1 runs locally in extension scoring.
- Extension content/background paths load `aiClassifierModel.generated.js`; removing it produces an honest heuristic-only fallback.
- The popup honestly reports lightweight, spatial, temporal, Ollama, and fact-check engine health.
- A matching ClaimReview rated False/incorrect/not true cannot be displayed as supporting the reviewed claim, and unrelated sources cannot count toward auto-skip.
- Instagram Reels and TikTok feed/direct-video adapters discover stable IDs and exclude social-control text from scoring.
- Instagram/TikTok Skip covers stay on the video surface and future items hide without scrolling.
- LinkedIn posts and profiles remain annotation-first and are never automatically hidden.
- LinkedIn still-image OCR enters the source-backed claim-check path.
- An unopened LinkedIn video shows **Video check on open** and cannot receive an AI-video verdict from its poster frame.
- Opening or playing a LinkedIn video invalidates the deferred result and enables the normal full-video detector path.
- LinkedIn AI-writing output remains an advisory style estimate and cannot hide a post or prove authorship.
- Post/profile explanations and follow-up chat stay grounded in visible content and supplied evidence.
- YouTube scanning can only be fully verified in an unrestricted Chrome, Edge, or Brave profile where `chrome://extensions` is not blocked.
