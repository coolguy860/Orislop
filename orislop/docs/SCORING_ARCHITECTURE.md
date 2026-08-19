# Orislop Scoring Architecture

## Product Principle

Orislop combines multiple evidence sources without hiding what ran. The UI and logs must distinguish:

- heuristic evidence
- lightweight AI text/metadata classifier evidence
- required Qwen transcript/metadata evidence through the selected inference mode
- strict lightweight video evidence, plus spatial and temporal evidence when Heavy or cloud mode is active

If a detector is unavailable or not wired into the active product path, Orislop reports that plainly.

## Current Public Static Web Path

The static website runs entirely in the browser:

1. Parse YouTube URL with `apps/web/src/lib/youtube.ts`.
2. Run heuristic rules with `apps/web/src/lib/staticSlopScore.ts`.
3. Run Orislop AI Classifier v1 with `apps/web/src/lib/aiClassifier.ts`.
4. Combine sources with `apps/web/src/lib/combinedScore.ts`.
5. Display final score, verdict, source scores, AI classifier features, and unavailable spatiotemporal status in `apps/web/src/App.tsx`.

The static website does not run PyTorch, Hugging Face checkpoints, temporal video inference, spatial frame inference, YouTube scraping, or paid APIs.

The classifier artifact is trained from text and metadata only. Heuristic score columns and matched rule names remain in the seed CSV for audit but are excluded from model features. During combined scoring, transcript text is evaluated by the transcript source and is not also fed into the AI source. These boundaries keep the weighted sources independent.

## Current Browser Extension Path

Orislop Shield 1.1 runs on YouTube, Instagram Reels, TikTok, and LinkedIn:

1. `apps/extension/src/contentScript.js` extracts visible card/current-video metadata.
2. It extracts the item URL/ID, visible metadata/transcript, and a direct approved CDN URL when the page exposes one.
3. It scores up to the next 10 candidates with heuristics and Orislop AI Classifier v1.
4. `apps/extension/src/background.js` sends every non-hard-AI item to local Ollama/loopback bridge or the authenticated Orislop Cloud API.
5. In Fast mode, the bridge finalizes with the strict lightweight visual model. In local Heavy mode, it runs the configured spatial and temporal pipeline and exposes one bounded result. Automatic resolves to one mode from coarse browser hardware hints. Hybrid locks Fast decisions during Cloud Heavy warmup; once Heavy reports ready, only new items are assigned to it, with concurrent Fast as the fixed fail-open result. No decided item is upgraded or replaced later.
6. Skip hides future feed items; current-item covers continuously pause and mute their media, and Orislop never scrolls or navigates to the next item.
7. On request, Qwen explains the current video from its captured text. For a source-contradicted claim, it also explains the Skip from the fact-check record and exposes only the retained trusted HTTPS sources. Explanations do not create another verdict or change the decision.

The Chrome process does not execute PyTorch. Local mode binds the companion to `127.0.0.1:4317`. Cloud mode calls only `https://api.orislop.com` with bearer authorization and an exact extension origin. The selected bridge may download supported public media into a temporary directory, deletes it after inference, and keeps only bounded in-memory detector and fact-check caches. When fact checking is configured, the bridge sends extracted claim queries to the selected evidence provider; public model weights are downloaded into the selected local or cloud model cache.

## Combined Score Formula

Without spatiotemporal score:

```text
finalScore =
  0.35 * heuristicScore
  0.45 * aiClassifierScore
  0.15 * transcriptScore
  0.05 * channelRiskScore
```

If transcript is missing, its weight is assigned to the heuristic score. If the AI classifier is unavailable, its weight is assigned to the heuristic score. Channel risk remains lightweight and low-weight.

The extension uses binary decision fusion instead of the static website formula. Ollama determines Skip/Don't skip for slop. A visual synthetic result overrides either text verdict and sets the final score to 100. A visual real result never vetoes an Ollama Skip.

## Verdict Thresholds

- `Don't skip`: keep the item visible.
- `Skip`: hide the item or cover the current media surface.

Explicit AI/synthetic disclosure text and strong spatial/temporal synthetic results are non-vetoable 100/100 Skip decisions. Thresholds are versioned in `configs/detector_thresholds.json`.

## Spatiotemporal Detector Status

The static website still reports spatiotemporal inference as unavailable. The extension requires a selected inference service and reports `pending`, `available`, or `unavailable` in its popup. Unavailable local or cloud models fail open so a missing service cannot hide normal content.
