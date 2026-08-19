# Orislop detector bridge 1.3

The detector bridge is a versioned inference service for Orislop Shield. It runs loopback-only for local mode or as an authenticated, origin-locked API in the cloud container. It connects the browser extension to:

- `umm-maybe/AI-image-detector` for strict, fast provisional frame decisions
- `gonnerthetooner/orislop-fusion` for spatial frame analysis
- `gonnerthetooner/deepfake-temporal-moe` for temporal consistency analysis
- Qwen plus configured evidence providers for asynchronous informational-claim verification
- platform captions, with on-demand Faster-Whisper transcription for Explain when captions are missing

Fast scans move through `pending` to `ready`, inspect only a platform-provided preview image, and use a strict 0.94 synthetic threshold without loading the large models. Fast never downloads a page or full video; a missing preview fails open while metadata protection remains active. Fast visual results are advisory and never hide on their own; explicit AI/brainrot text rules remain immediate, while visual-only hiding waits for independent Heavy corroboration. Heavy scans move through `pending` to `provisional` to `ready`; spatial and temporal inference continues on a priority queue and replaces the provisional result. The video currently on screen preempts background lookahead work. Heavy automatic Skip requires cross-model corroboration: both heavy signals, a weighted heavy consensus with neither model below the corroboration floor, or the strict lightweight signal plus one strong heavy signal. An isolated model spike fails open. Profile-specific cache keys prevent a Fast result from satisfying a Heavy request. A provisional automatic hide is reversible and is not written to permanent history.

The required Qwen context classifier is also fail-open for protected educational material: a Qwen `skip` must be supported by independent strong slop signals before it can hide an item. Hard AI/synthetic disclosures, corroborated visual synthetic decisions, and sufficiently sourced fact-check contradictions keep their existing non-vetoable rules.

## Start

From the repository root:

```powershell
pnpm detector:setup
pnpm extension-origin:setup
pnpm orislop:start
pnpm orislop:doctor
```

## HTTP contract

```text
GET  http://127.0.0.1:4317/health
GET  http://127.0.0.1:4317/ready
POST http://127.0.0.1:4317/v1/analyze
POST http://127.0.0.1:4317/v1/fact-check
POST http://127.0.0.1:4317/v1/text-score
POST http://127.0.0.1:4317/v1/explain
```

`/v1/explain` prefers the transcript already exposed by the platform. Only after
the viewer explicitly asks for an explanation may it generate a temporary,
bounded audio transcript. Generated speech text is labeled as uncertain, is
deleted with the temporary media, and is never an automatic Skip or fact-check
vote by itself.

`/health` exposes version, uptime, accelerator, model states, fact-check provider state, text-model state, thresholds, queue capacity, cache entries, counters, and security mode. `/ready` is intended for process supervision. Inference endpoints accept at most 10 candidates. `/v1/analyze` accepts `performanceProfile` as `fast` or `heavy`; unknown values fail safe to Heavy.

## Security

- Local mode binds to `127.0.0.1`. Public binding refuses to start without bearer tokens, exact extension origins, and originless POSTs disabled.
- Analyze requests require a Chrome-extension origin by default.
- Set `ORISLOP_ALLOWED_EXTENSION_ORIGINS` to the exact published extension origin in production.
- Originless POST requests are disabled unless explicitly enabled for local development.
- Media URLs, redirects, MIME types, request sizes, download sizes, queues, and request rates are bounded.
- Temporary media is deleted after analysis.
- Evidence provider keys are loaded only from the companion/cloud environment and never returned by health or API responses.

Never expose raw port 4317 or Ollama port 11434 to the internet. Cloud mode must sit behind TLS ingress. See `docs/CLOUD_DEPLOYMENT.md` and `docs/THREAT_MODEL.md` before distribution.

## Environment

- `ORISLOP_DETECTOR_PORT`
- `ORISLOP_DETECTOR_HOST`
- `ORISLOP_DETECTOR_CACHE`
- `ORISLOP_ALLOWED_EXTENSION_ORIGINS`
- `ORISLOP_ALLOW_ORIGINLESS_POSTS`
- `ORISLOP_RATE_LIMIT_PER_MINUTE`
- `ORISLOP_LIGHTWEIGHT_WORKERS` (`auto` or 1-32; auto uses CPU/RAM headroom)
- `ORISLOP_EXECUTION_MODE` (`auto`, `concurrent`, or `sequential`)
- `ORISLOP_AUTOTUNE_MODE` (`first-run`, `always`, or `off`; default first-run)
- `ORISLOP_AUTOTUNE_REPEATS` (1-3; default 2)
- `ORISLOP_AUTOTUNE_MAX_SECONDS` (default 240)
- `ORISLOP_AUTOTUNE_WARMUP` (default 1)
- `ORISLOP_AUTOTUNE_OUTPUT_TOLERANCE` (default 0.002)
- `ORISLOP_AUTOTUNE_RESET` (set to 1 for one launch to replace the cached result)
- `ORISLOP_AUTOTUNE_CACHE` (optional explicit persistent JSON path)
- `ORISLOP_GPU_RESERVE_GIB` (default 3.5)
- `ORISLOP_GPU_RESERVE_FRACTION` (default 0.12)
- `ORISLOP_OOM_COOLDOWN_SECONDS` (default 300)
- `ORISLOP_RESULT_CACHE_TTL_SECONDS`
- `ORISLOP_REQUIRE_API_AUTH`
- `ORISLOP_API_TOKENS`
- `ORISLOP_OLLAMA_URL`
- `ORISLOP_TEXT_OLLAMA_TIMEOUT_SECONDS`
- `ORISLOP_TRANSCRIPTION_ENABLED=0|1`
- `ORISLOP_TRANSCRIPTION_MODEL`
- `ORISLOP_TRANSCRIPTION_DEVICE=cpu|cuda|auto`
- `ORISLOP_TRANSCRIPTION_COMPUTE_TYPE`
- `ORISLOP_TRANSCRIPTION_MAX_SECONDS`
- `ORISLOP_TRANSCRIPTION_MIN_PLATFORM_CHARS`
- `ORISLOP_SPATIAL_DEVICE=cpu|cuda`
- `ORISLOP_LIGHTWEIGHT_THRESHOLD`
- `ORISLOP_SPATIAL_THRESHOLD`
- `ORISLOP_TEMPORAL_THRESHOLD`
- `ORISLOP_VISUAL_THRESHOLD`
- `ORISLOP_VISUAL_MIN_CORROBORATION`
- `ORISLOP_DETECTOR_VERBOSE=1`
- `BRAVE_SEARCH_API_KEY`
- `GOOGLE_FACT_CHECK_API_KEY`
- `ORISLOP_FACT_CHECK_CACHE_TTL_SECONDS`
- `ORISLOP_FACT_CHECK_AUTO_SKIP_CONFIDENCE`
- `ORISLOP_FACT_CHECK_MIN_TRUSTED_SOURCES`
- `ORISLOP_FACT_CHECK_OLLAMA_TIMEOUT_SECONDS`

See `.env.example` and `docs/PRODUCTION_OPERATIONS.md` for deployment guidance.
