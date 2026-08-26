# Legacy RTX 3090 deployment note

Use [VAST_PRODUCTION_DEPLOY.md](VAST_PRODUCTION_DEPLOY.md) for the hardened v4
launcher, exact Vast settings, RTX 3090 and RTX 5090 support, lifecycle commands,
private SSH tunnel, token handling, readiness states, and storage calculation.

The older fixed 25 GiB guard, foreground-only start, product-name GPU allowlist,
and automatic CPU-only Ollama rule are intentionally retired. Do not use an old
v3 command copied from this file's previous version.
