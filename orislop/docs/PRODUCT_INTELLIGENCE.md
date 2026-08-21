# Product intelligence, privacy, and request operations

This contract covers product behavior only. It does not change Orislop models, weights, thresholds, calibration, training, or datasets.

## User controls

Two separate settings appear under **Settings & help**:

- **Share anonymous product insights** is off by default. When off, no product-event queue is created and disabling it clears the local queue, its pseudonymous installation identifier, and requests deletion of events previously associated with that identifier.
- **Attention Log** is off by default. When enabled, a dismissible popup check-in becomes eligible only after at least five minutes and 20 newly observed feed items. It appears at most once every seven days. Its answer uploads only when anonymous product insights are also enabled.

Cloud Heavy consent is separate. Enabling product insights does not enable cloud media analysis, and enabling Cloud Heavy does not enable product insights.

## Event schema v1

Every uploaded event contains only:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `eventId` | Random idempotency identifier |
| `eventName` | One allowlisted product event name |
| `occurredAt` | UTC timestamp within the accepted seven-day window |
| `installationId` | Random per-install pseudonym; HMAC-hashed before persistence |
| `sessionId` | Random service-worker-session pseudonym; HMAC-hashed before persistence |
| `extensionVersion` | Packaged extension version |
| `attributes` | Allowlisted coarse strings, bounded counters, and model identifiers already returned by the runtime |

Allowlisted events are `scan_batch_started`, `scan_batch_completed`, `request_failed`, `request_retried`, `request_deduplicated`, `decision_presented`, `correction_submitted`, `manual_skip`, `attention_response`, `feature_toggled`, and `adapter_health`.

The client strips and the server rejects unsupported fields. URLs, media URLs, video or item identifiers, titles, captions, transcripts, page text, prompts, questions, answers, email/name fields, cookies, authorization data, tokens, secrets, and passwords are not accepted. Full local hidden-item history remains a bounded browser feature and is never silently converted into analytics.

## Collection purpose

| Signal | Product question |
| --- | --- |
| Batch start/completion and duration bucket | Is protection completing reliably and within a usable latency range? |
| Request failure/retry/dedupe | Are networks, backends, or duplicate callers wasting time or capacity? |
| Decision presented and explicit correction | Which coarse decision paths create reversible user disagreement? |
| Manual skip | Are users still doing work the product intended to remove? |
| Optional Attention Log response | Did a meaningful session feel better, unchanged, or worse? |
| Model/runtime identifiers | Which deployed runtime produced the aggregate outcome? |
| Adapter health | Which supported platform adapter is operating or degraded? |

Do not infer demographics, interests, identity, ideology, medical status, or cross-site browsing behavior from these events.

## Queue, delivery, and retention

- The browser queue is deduplicated by event id and bounded to 200 events.
- Uploads contain at most 20 events and never block feed scanning.
- Network errors, 408, 425, 429, and 5xx responses receive at most two retries for idempotent requests. Invalid 4xx requests and non-idempotent writes are not retried.
- `Retry-After` is honored with a bounded delay. Repeated telemetry delivery failure uses background backoff up to 15 minutes and preserves the bounded queue.
- The cloud persists only HMAC-hashed installation/session identifiers and validated fields. Default retention is 30 days; operators may configure 1-90 days with `ORISLOP_PRODUCT_EVENT_RETENTION_DAYS`.
- POST is idempotent by `eventId`. DELETE `/v2/telemetry` removes all retained events for the presented random installation identifier.

## Server protection

Inference, explanation, authentication, and write endpoints use separate burst and sustained per-identity limits. A secondary IP limit reduces identifier rotation abuse. Every 429 response includes `Retry-After`. Request bodies remain capped at 64 KiB, telemetry batches at 20 events, inference batches at 10 items, and detector queues at their existing bounded capacities.

Production telemetry is accepted only when `ORISLOP_PRODUCT_TELEMETRY_ENABLED=1`, the cloud beta store is configured, and the request Origin matches the exact extension allowlist. Local companion mode defaults telemetry ingestion off.

## Operational measurements

`GET /health` exposes counters for request volume, detector cache hits/misses, completed/failed work, queue depth/capacity, rate-limited requests, accepted telemetry events, and the configured rate/cache/event schema. Extension-local status shows queued, delivered, dropped, and last-delivery state without content.

These are capacity and reliability measurements, not cost claims. Compute, storage, and egress costs must come from hosting invoices joined to measured request/GPU/storage usage; the product must not fabricate per-scan economics.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `ORISLOP_RATE_LIMIT_PER_MINUTE` | `120` | Sustained inference requests per identity |
| `ORISLOP_RATE_LIMIT_BURST` | `20` | Short inference burst |
| `ORISLOP_RATE_LIMIT_BURST_SECONDS` | `10` | Burst window |
| `ORISLOP_RATE_LIMIT_EXPLAIN_PER_MINUTE` | `20` | Stricter explanation ceiling |
| `ORISLOP_RATE_LIMIT_WRITE_PER_MINUTE` | `30` | Feedback/telemetry write ceiling |
| `ORISLOP_RATE_LIMIT_IP_PER_MINUTE` | `300` | Secondary IP ceiling |
| `ORISLOP_PRODUCT_TELEMETRY_ENABLED` | local `0`, cloud `1` | Server ingestion kill switch |
| `ORISLOP_PRODUCT_EVENT_RETENTION_DAYS` | `30` | Valid range 1-90 days |
| `ORISLOP_DETECTOR_CACHE_SCHEMA_VERSION` | `v2` | Explicit decision-cache namespace |

## Release QA checklist

1. Confirm both product-insight settings are off in a fresh profile.
2. Confirm enabling/disabling analytics changes only the documented local keys and deletion request.
3. Attempt events containing URL, title, caption, token, unknown field, mixed installation ids, stale timestamp, oversized batch, and duplicate event id.
4. Exercise success, timeout, network failure, 400, 429 with `Retry-After`, 500, and malformed JSON paths.
5. Verify identical score batches coalesce and user `Don't skip` remains immediate and reversible.
6. Confirm Attention Log is hidden before eligibility, dismisses immediately, and remains hidden for seven days.
7. Inspect `/health` request/cache/queue/rate-limit counters under bounded load; do not use a production account for destructive testing.
8. Run `pnpm extension:test`, detector/cloud/request-policy tests, web tests, release checks, and `pnpm production:check` in the supported detector environment.
