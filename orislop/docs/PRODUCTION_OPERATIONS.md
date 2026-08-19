# Production operations

## Runtime topology

```text
Supported feed page
  -> Orislop Manifest V3 content script
  -> Extension service worker
     -> Local Fast: Ollama, fact checking, explanations, lightweight detector
     -> signed-in Cloud Heavy: https://api.orislop.com
        -> custom + public frame scores -> one calibrated spatial family
        -> AEGIS motion-only branch -> independent calibrated motion score
        -> two-modality reversible consensus
```

Hybrid mode uses both branches without changing a visible result. Local Fast owns items while `api.orislop.com` is unknown or warming. Once Cloud Heavy reports ready, new items are assigned to Heavy; its result must finish inside the bounded background decision window or the concurrently computed Local Fast result is locked instead. Previously decided items are never rescored for a different recommendation. The old Temporal MoE, AEGIS pixel/full fusion, and AV model cannot vote online.

Fast mode returns a final decision from the strict lightweight detector and never enters the heavyweight queue. It prefers an allowlisted, size-bounded platform thumbnail/poster so look-ahead does not download whole videos. Heavy mode may use provisional entries internally while its queue reuses downloaded media, but the extension waits inside a bounded decision window and exposes only one immutable result. Temporary media is deleted after completion. Fast and Heavy use separate service cache keys.

Automatic is the default local profile. It selects Fast when the browser reports 4 GiB memory or less, four logical threads or less, or ambiguous hardware. It selects Heavy when at least 12 logical threads and the browser's 8-GiB-or-higher memory bucket are reported; when the browser withholds the memory hint, at least 12 logical threads select Heavy. The Device Memory API is intentionally approximate and privacy-clamped, so Orislop treats its highest common bucket as "8 GiB or more" rather than exact RAM. A manual Fast or Heavy choice always overrides local detection. Hybrid fixes local work to Fast and cloud work to Heavy; full Cloud always resolves to Heavy.

Cloud packaging and rollout are documented in `docs/CLOUD_DEPLOYMENT.md`. Vercel hosts the static product site only; it does not run the GPU service.

## Startup and shutdown

```powershell
pnpm extension-origin:setup
pnpm orislop:start
pnpm orislop:doctor
pnpm orislop:stop
pnpm orislop:autostart:install
```

`extension-origin:setup` persistently locks the loopback bridge to the installed extension ID and disables originless POSTs. `orislop:start` launches missing companion services hidden, records only the process IDs it created, and waits for readiness. `orislop:stop` stops only recorded companion processes and never closes browser windows. Pass `-IncludeOllama` directly to `scripts/stopOrislop.ps1` when Ollama should also stop.

`orislop:autostart:install` registers a limited, per-user Windows logon task that calls the same startup script in hidden mode. It never starts, closes, or controls a browser. Remove it with `pnpm orislop:autostart:remove` after cloud-only mode is enabled.

## Health endpoints

- `GET /health`: version, uptime, accelerator, model states, thresholds, queue capacity, cache size, counters, and security mode
- `GET /ready`: dependency and queue-capacity readiness for service supervision
- `POST /v1/fact-check`: asynchronous claim submission and cached result polling
- `POST /v1/text-score`: protected Qwen context classification for cloud clients
- `POST /v1/explain`: grounded plain-language video and fact-check decision explanations
- `POST /v1/analyze`: visual analysis; accepts `performanceProfile: "fast" | "heavy"`
- `POST /v2/auth/google`, `/v2/auth/refresh`, `/v2/auth/logout`: Google PKCE exchange and rotating Orislop sessions
- `GET /v2/me`: signed-in user, quota, and Cloud Heavy readiness
- `POST /v2/analyze`, `GET /v2/analyze/{decisionId}`: submit/poll direct-media Cloud Heavy decisions
- `POST /v2/feedback`: reversible-hide feedback and optional report-only diagnostic retention

Normal request logging is disabled. Set `ORISLOP_DETECTOR_VERBOSE=1` only during diagnosis and avoid sharing logs without review.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `ORISLOP_DETECTOR_PORT` | `4317` | Loopback port |
| `ORISLOP_DETECTOR_HOST` | `127.0.0.1` | Bind address; the cloud container uses `0.0.0.0` |
| `ORISLOP_ALLOWED_EXTENSION_ORIGINS` | empty | Comma-separated exact production extension origins |
| `ORISLOP_ALLOWED_WEB_ORIGINS` | empty | Comma-separated exact website server-proxy origins; never use a wildcard |
| `ORISLOP_ALLOW_ORIGINLESS_POSTS` | `0` | Local API development override; never enable in production |
| `ORISLOP_REQUIRE_API_AUTH` | local: `0`, public: `1` | Require bearer authorization |
| `ORISLOP_API_TOKENS` | empty | Comma-separated closed-beta tokens; store only in a secret manager |
| `ORISLOP_GOOGLE_OAUTH_CLIENT_ID` | empty | Stable unlisted Chrome Extension OAuth client |
| `ORISLOP_TOKEN_SECRET` | empty | 32-byte-or-longer Orislop access-token signing secret |
| `ORISLOP_CONTENT_HMAC_SECRET` | empty | Separate secret for URL-free content keys |
| `DATABASE_URL` | empty | Managed Postgres for users, sessions, decisions, and feedback |
| `ORISLOP_CLOUD_HEAVY_ROLLOUT` | `shadow` | Cloud Heavy rollout request; calibration gates still override it |
| `ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES` | `0` | Explicit aggressive-beta enable after the beta calibration gate |
| `ORISLOP_RATE_LIMIT_PER_MINUTE` | `120` | Analyze-request ceiling per origin |
| `ORISLOP_RESULT_CACHE_TTL_SECONDS` | `21600` | In-memory decision lifetime |
| `ORISLOP_DETECTOR_CACHE` | repo cache | Model cache location |
| `ORISLOP_LIGHTWEIGHT_THRESHOLD` | `0.94` | Strict lightweight synthetic threshold |
| `ORISLOP_OLLAMA_KEEP_ALIVE` | `24h` | Keep the warmed local Qwen model resident for the companion session |
| `ORISLOP_SPATIAL_THRESHOLD` | config | Spatial synthetic threshold |
| `ORISLOP_TEMPORAL_THRESHOLD` | config | Temporal synthetic threshold |
| `ORISLOP_VISUAL_THRESHOLD` | config | Combined synthetic threshold |
| `ORISLOP_VISUAL_MIN_CORROBORATION` | `0.55` | Minimum second-model probability for weighted Heavy consensus |
| `BRAVE_SEARCH_API_KEY` | empty | Confidential Brave Web Search subscription token |
| `GOOGLE_FACT_CHECK_API_KEY` | empty | Confidential Google Fact Check Tools API key |
| `ORISLOP_FACT_CHECK_CACHE_TTL_SECONDS` | `43200` | In-memory evidence result lifetime |
| `ORISLOP_FACT_CHECK_AUTO_SKIP_CONFIDENCE` | `0.88` | Minimum contradiction confidence |
| `ORISLOP_FACT_CHECK_MIN_TRUSTED_SOURCES` | `2` | Independent trusted domains required for Skip |
| `ORISLOP_FACT_CHECK_OLLAMA_TIMEOUT_SECONDS` | `180` | Bounded cold-start Qwen worker timeout |
| `ORISLOP_TEXT_OLLAMA_TIMEOUT_SECONDS` | `90` | Bounded Qwen context-classification timeout |

## Capacity and recovery

- Startup preloads Qwen and keeps it resident for 30 minutes. Ollama uses one serialized local-model lane, a 90-second batch budget, 60-second per-item timeouts, partial-result recovery, and six-hour decision caching. Serial execution avoids CPU/GPU contention observed with concurrent local generations.
- The detector accepts at most 10 candidates per request, queues 100 lightweight jobs and 25 heavyweight jobs, and caches 500 profile-isolated decisions. Fast jobs never consume heavyweight queue capacity.
- Fact checking uses one background worker, a 50-job bounded queue, at most two claims per Short, a bounded 180-second cold-start Qwen timeout, and 12-hour in-memory caching.
- A full queue returns explicit per-item errors; it never silently drops work.
- If one heavyweight detector fails, the available detector still contributes. If both fail, the strict lightweight result remains and the error is visible in health.
- Restarting the service clears decisions but does not delete model weights.

## Incident checklist

1. Run `pnpm orislop:doctor`.
2. Confirm Ollama contains `qwen2.5:1.5b-instruct`.
3. Inspect `/health` model states, queue depth, failure counter, and last error.
4. Confirm the extension origin allowlist matches the installed extension ID.
5. Review `.cache/runtime/detector.err.log` locally.
6. Restart recorded services with `pnpm orislop:stop` and `pnpm orislop:start`.
7. Re-run extension, detector, and live Ollama checks before restoring distribution.

## SLO candidates for the managed cloud edition

These are design targets, not claims for the local runtime:

- 99.9% authenticated API availability
- P95 job acceptance below 500 ms
- P95 lightweight result below 10 seconds after media availability
- P95 heavyweight completion below 60 seconds on supported GPU workers
- 100% temporary-media deletion within the documented retention window
- Zero cross-tenant access to media, results, or logs
