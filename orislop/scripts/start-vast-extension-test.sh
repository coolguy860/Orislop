#!/usr/bin/env bash
set -Eeuo pipefail

# Noninteractive one-command Vast launcher. It intentionally never reads from
# stdin: a missing token fails before installers, downloads, or servers start.

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT="$(cd "$ROOT" && pwd)"
MANAGER="$ROOT/scripts/orislop_vast_manager.py"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "[orislop-vast] Hugging Face access is not configured." >&2
  echo "[orislop-vast] Export a newly rotated HF_TOKEN and run again. This launcher never prompts." >&2
  exit 2
fi
export HF_TOKEN

if [[ ! -f "$MANAGER" ]]; then
  echo "[orislop-vast] This package is incomplete; scripts/orislop_vast_manager.py is missing." >&2
  exit 2
fi

exec python3 "$MANAGER" --root "$ROOT" start
