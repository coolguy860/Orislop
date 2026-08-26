#!/usr/bin/env bash
set -Eeuo pipefail

# Backward-compatible name for the hardened noninteractive production launcher.
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT="$(cd "$ROOT" && pwd)"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "[orislop-vast] Export a newly rotated HF_TOKEN before launching. This launcher never prompts." >&2
  exit 2
fi
export HF_TOKEN
exec python3 "$ROOT/scripts/orislop_vast_manager.py" --root "$ROOT" start
