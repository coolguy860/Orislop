# Orislop product intelligence and production hardening audit

Audit date: 2026-08-20
Scope: browser extension, detector bridge, cloud beta API, product UI, storage, privacy, observability, and test/deployment contracts.
Explicitly out of scope: model architectures, weights, thresholds, calibration, training code, and datasets.

## Executive assessment

Orislop already has a stronger production base than a prototype: scans are bounded and coalesced, slow model work is fail-open, detector jobs use bounded priority queues, cached work is reused, cloud calls are authenticated, and the popup already explains degraded states in plain language. The remaining launch risk is concentrated in product operations rather than model quality: corrections are only partially recorded, product events are not governed by a consented schema, rate limiting is coarse, and request retry/deduplication behavior is not standardized or observable.

The implementation following this audit keeps Fast Scan lightweight and does not alter any detector behavior. It adds only bounded, privacy-preserving product infrastructure and defensive request handling.

## Status inventory

| Area | Status before this hardening pass | Evidence and gap |
| --- | --- | --- |
| Bounded feed scanning | PRESENT AND GOOD | Content scanning is debounced, permits one in-flight pass plus one queued follow-up, uses 10-item batches, and bounds observed-item memory. |
| Client decision cache | PRESENT AND GOOD | Stable item decisions are reused through a bounded cache; explicit user restores override later automatic hiding. |
| Server work queue and backpressure | PRESENT AND GOOD | Lightweight and Heavy work use bounded priority queues and return a safe queue-full result instead of blocking the feed. |
| Fail-open behavior | PRESENT AND GOOD | Local classification remains available when Ollama, visual detection, fact checking, or Cloud Heavy is unavailable. |
| Request and payload validation | PRESENT BUT NEEDS IMPROVEMENT | JSON body size, candidate count, supported origins, URLs, and auth are checked; endpoint-specific schemas and consistent request lifecycle metadata need strengthening. |
| Cache lifecycle | PRESENT BUT NEEDS IMPROVEMENT | Detector and explanation caches are bounded and time-limited; product-facing cache version traceability and hit/miss instrumentation are incomplete. |
| Client request deduplication | PRESENT BUT NEEDS IMPROVEMENT | The page-level scan lock and detector queues suppress many duplicates, but identical background scoring messages can still create parallel work. |
| Retry policy | PRESENT BUT NEEDS IMPROVEMENT | Timeouts and friendly failures exist; there is no shared policy for bounded retry, jitter, `Retry-After`, and non-retryable client errors. |
| API rate limiting | PRESENT BUT NEEDS IMPROVEMENT | A fixed per-minute limit exists for v1 work and beta candidate quotas exist; burst plus sustained limits, endpoint costs, IP secondary limits, and `Retry-After` are missing. |
| Product telemetry | MISSING | No versioned allowlist schema, opt-in queue, batching, retention contract, or upload endpoint exists. |
| User correction signals | PRESENT BUT NEEDS IMPROVEMENT | Cloud decisions accept reveal/undo feedback, but local corrections and correction context are not represented in a common privacy-safe event schema. |
| Attention/session feedback | MISSING | There is no optional, dismissible, rate-limited session-satisfaction prompt. |
| Privacy controls | PRESENT BUT NEEDS IMPROVEMENT | Cloud transmission has disclosure/consent and local data can be cleared; product analytics needs a separate off-by-default control, bounded collection, retention, and deletion semantics. |
| Human-readable errors | PRESENT AND GOOD | The popup and in-feed UI already translate auth, timeout, rate-limit, network, and setup failures into actionable product language. |
| Evidence-backed explanations | PRESENT AND GOOD | Explanation and fact-check surfaces distinguish generated transcripts and available sources; they fail open when evidence is missing. |
| Operational metrics | PRESENT BUT NEEDS IMPROVEMENT | The bridge exposes queue, latency, failure, cache, and model readiness state; retry, dedupe, rate-limit, request volume, and telemetry queue signals are incomplete. |
| Feature flags/platform health | PRESENT BUT NEEDS IMPROVEMENT | Mode/settings and adapter isolation exist; there is no small explicit product-feature flag contract or summarized adapter health state. |
| Automated regression coverage | PRESENT BUT NEEDS IMPROVEMENT | Extension, DOM, bridge, web, release, and production suites exist; product telemetry and request-policy boundary cases are missing. |

## Priorities

### P0 - required for a trustworthy public beta

1. Add a versioned, allowlisted event schema that rejects URLs, page text, titles, tokens, email addresses, and other free-form private data.
2. Make product analytics explicitly opt-in, bounded locally, transparent in the popup, and independently clearable.
3. Capture local and cloud user corrections without changing detector decisions.
4. Add background request coalescing and a shared bounded retry policy that honors `Retry-After` and never retries invalid requests.
5. Replace the single fixed-window limiter with endpoint-specific burst and sustained controls, including a secondary IP limit and standard 429 headers.
6. Add server-side event validation, bounded persistence, retention, and deletion with account deletion where applicable.

### P1 - required for useful operations and iteration

1. Instrument request volume, latency, cache hits, retries, dedupe hits, queue pressure, and rate-limit outcomes without inventing infrastructure costs.
2. Add an optional Attention Log prompt after a meaningful session; it must be off by default, dismissible, and rate-limited.
3. Expose plain-language privacy and diagnostics status, including queued-event count and last delivery state.
4. Add focused tests for success, timeout, 429, 500, malformed payloads, retry, dedupe, queue bounds, schema redaction, and server rate limits.

### P2 - inexpensive launch polish

1. Add small data-only feature flags and a platform-adapter health summary.
2. Document event purposes, retention, environment configuration, incident-safe defaults, and a release QA checklist.
3. Add request IDs and model/version fields to product events where already available; do not infer or fabricate them.

### P3 - intentionally deferred

1. Large-scale recommendation systems, social features, creator marketplaces, or a new microservice estate.
2. Raw browsing histories, full page text, media, or cross-site identity graphs.
3. Cost estimates before hosting invoices and measured infrastructure counters exist.
4. Any model, threshold, calibration, training, or dataset changes.

## Privacy and safety boundary

The minimum useful remote dataset is aggregate product behavior: coarse platform, mode, latency bucket, outcome, model/version identifiers already returned by the runtime, reason codes, and explicit correction or satisfaction choices. Raw URLs, video IDs, titles, captions, transcripts, page text, account identity, refresh/access tokens, and media never belong in product telemetry. Detailed protected/skipped activity remains a bounded local feature and is not silently promoted into analytics.

## Acceptance gate

The pass is complete only when the extension build, focused extension tests, detector bridge contract tests, web checks, release verification, and the repository production-readiness command run from a clean D:-drive checkout; the final report must separate fresh passes from checks that could not run in the local environment.
