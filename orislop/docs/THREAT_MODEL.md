# Orislop Shield threat model

## Protected assets

- Browsing activity, feed metadata, captions, and local decision history
- Downloaded video frames and temporary media
- Local model weights and detector checkpoints
- Confidential evidence-provider API keys and extracted search claims
- Extension integrity and user overrides
- Host CPU, GPU, memory, disk, and network capacity

## Trust boundaries

1. Supported feed pages are untrusted and may change DOM structure or supply adversarial text.
2. The extension content script runs beside untrusted page content but communicates through Manifest V3 extension messaging.
3. Local Ollama and the detector bridge are separate loopback services; cloud mode adds authenticated TLS ingress and a GPU container trust boundary.
4. Media hosts and redirects are untrusted until allowlist checks pass.
5. Model outputs are probabilistic evidence, not factual or identity verification.
6. The Orislop cloud API receives disclosed supported-feed fields when cloud mode is selected.
7. Configured evidence providers are remote trust boundaries that receive extracted claim search queries and return untrusted source metadata.

## Implemented controls

- Minimal extension permissions and no remote script execution
- Loopback-only local binding; public binding fails startup unless bearer auth and exact production origins are configured
- Constant-time bearer validation and token-keyed rate limiting for cloud inference
- Chrome-extension origin checks with an exact production allowlist
- Originless detector POST requests disabled by default
- Request-size, batch-size, queue, rate, media-size, and inference-time limits
- Exact supported page hosts and suffix-constrained media CDN hosts
- Redirect revalidation and media content-type validation
- Temporary-directory cleanup after every completed or failed scan
- Structured Ollama output with strict verdict validation
- Prompt-injection isolation for source snippets and evidence-only adjudication
- Grounded explanation prompts that treat captions, transcripts, and evidence as untrusted data and prohibit adding facts from model memory
- HTTPS source validation, explicit source-authority allowlists, and no arbitrary page fetching
- Provider keys kept in an ignored companion environment or cloud secret manager and omitted from health, diagnostics, and extension storage
- Two independent trusted domains plus 0.88 confidence required for an automatic fact-check Skip
- Deterministic ClaimReview rating-direction checks and claim/evidence relevance filtering prevent false ratings or unrelated sources from being counted as support
- Fail-open behavior when required inference is unavailable
- Reversible user reveal/undo with immutable automatic decisions
- No URLs or activity titles in copied diagnostics
- Live scanner telemetry stores only platform, state, counts, errors, and timestamp; it does not duplicate captions, titles, or URLs
- Product analytics is separately opt-in and schema-allowlisted; the client strips and server rejects URLs, titles, captions, transcripts, page text, identity, credentials, and arbitrary free-form attributes
- Product-event installation and session identifiers are random pseudonyms, HMAC-hashed before persistence, retained for 30 days by default, and deletable by the originating installation
- Inference, explanation, authentication, and write routes use endpoint-specific burst and sustained identity limits plus a secondary IP limit; 429 responses include `Retry-After`
- No real secrets, tokens, checkpoints, temporary media, or build output committed to Git or copied into the cloud image context
- SHA-256 release integrity manifest and byte-for-byte archive verification

## Known boundaries

- Development mode permits any installed Chrome extension origin. Public builds must set `ORISLOP_ALLOWED_EXTENSION_ORIGINS` to the published extension origin.
- A malicious process already running as the same operating-system user can access loopback services. OS account security remains a prerequisite.
- Platform DOM and media delivery changes can reduce coverage. Adapter checks and manual store-candidate testing are release requirements.
- Detection and evidence adjudication can produce false positives and false negatives. Fact checking is a conservative source assessment, not a guarantee of truth, ownership, authorship, or identity.
- Closed-beta cloud bearer tokens are stored in extension-local storage. They must be per tester, revocable, and replaced with short-lived signed-in user credentials before an unrestricted public rollout.
- The raw bridge and Ollama ports must never be exposed directly. Cloud traffic must terminate TLS at `api.orislop.com`.

## Cloud deployment gate

The repository now includes an authenticated API, exact origin allowlisting, bounded queues and payloads, SSRF-resistant media acquisition, an Ollama/Python GPU container, persistent model caches, privacy disclosure, and a real authenticated smoke test. Public launch still requires per-user short-lived authentication, tenant-aware quotas, managed TLS, abuse monitoring, deletion operations, regional retention policy, GPU capacity tests, alerting, and incident response. A long-lived shared credential must never be embedded in the shipped extension.

## Reporting

Security issues should include the Orislop version, browser version, companion health report, reproduction steps, and impact. Diagnostics copied from the popup intentionally omit activity titles and URLs.
