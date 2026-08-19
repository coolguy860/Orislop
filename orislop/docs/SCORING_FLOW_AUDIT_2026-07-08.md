# Orislop Scoring Flow Audit Before AI Classifier v1

Date: 2026-07-08

## Existing Heuristic Scoring Engine

- Static web analyzer: `apps/web/src/lib/staticSlopScore.ts`
- Static clean-feed demo: `apps/web/src/lib/feedFilter.ts`
- Browser extension content script scorer: `apps/extension/src/contentScript.js`
- Browser extension background batch scorer: `apps/extension/src/background.js`
- Desktop/prototype slop engine: `packages/slop-engine/src/scoreVideo.ts` plus signal modules under `packages/slop-engine/src/signals/`

Before AI Classifier v1, the public static website and browser extension relied on explainable text/metadata heuristics. The web and extension scoring paths were duplicated rather than imported from one shared runtime package, because the extension is a plain MV3 JavaScript build and the static website is compiled into `apps/web/dist`.

## Web Analyzer Path

1. User enters a YouTube URL and optional title/description.
2. `apps/web/src/lib/youtube.ts` parses the video ID and kind.
3. `scoreStaticSlop` computes a 0-100 heuristic score and reasons.
4. `App.tsx` displays Watch / Questionable / Skip, reasons, score math, and feedback buttons.

No frame, audio, model checkpoint, or PyTorch detector ran in the static web analyzer.

## Browser Extension Path

1. `apps/extension/src/contentScript.js` scans visible YouTube cards/current video containers.
2. It extracts URL/video ID, title, visible text, AI/synthetic disclosure text, and limited page/card metadata.
3. It scores candidates locally first.
4. The background scorer can score batches through the `orislop.scoreBatch` message path.
5. Skip-scored cards are hidden/logged; Skip or Questionable current videos can be auto-skipped when settings allow.

Before AI Classifier v1, this was heuristic-only. The extension did not download videos or call remote APIs.

## Spatiotemporal Detector Status

Existing local detector wrappers are present under `packages/local-inference/src/adapters/`:

- `spatialDetectorAdapter.ts`
- `temporalDetectorAdapter.ts`
- `existingAiDetectorAdapter.ts`

The preserved spatial prototype is `core/spatial.py`. Temporal detector paths are represented by optional config in `configs/model_adapters.json`.

These adapters are optional/unavailable-safe. They are not called by the static web app or browser extension. They require local media paths and a safe local companion/subprocess path. The public static web build and MV3 extension must not claim spatiotemporal inference is active unless that product path is explicitly wired later.
