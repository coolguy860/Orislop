#!/usr/bin/env bash
set -Eeuo pipefail

# Test-only launcher: runs the complete pinned stack on a Vast GPU while the
# detector remains bound to loopback. The browser reaches it only through the
# companion SSH tunnel. No database, S3, OAuth, or Cloudflare account is used.

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT="$(cd "$ROOT" && pwd)"
BASE_BOOTSTRAP="$ROOT/scripts/vast3090-bootstrap.sh"
MATERIALIZER="$ROOT/scripts/materialize_complete_stack.py"
SUPERVISOR="$ROOT/apps/detector-bridge/vast_supervisor.py"
VENV="${ORISLOP_VENV:-/opt/orislop-venv}"
MODEL_ROOT="${ORISLOP_COMPLETE_STACK_ROOT:-/models/orislop-complete-stack}"
MODEL_ENV="$MODEL_ROOT/model.env"
PINNED_REPO="gonnerthetooner/orislop-complete-stack-v1"
PINNED_REVISION="09f0510580de5a8c11393adc7d7905ab40b200ab"
PINNED_MANIFEST_SHA256="f64fecb421f435cdd7e7e46374a965ea4708ae509a19c761a64e7314fef5c7dc"
EXTENSION_ORIGIN="chrome-extension://nhkffdhagjignajnmlgkgekpkfljhfdd"
DIRECT_ACK="I_UNDERSTAND_PORT_4317_MUST_NOT_BE_PUBLIC"

if [[ ! -f "$BASE_BOOTSTRAP" || ! -f "$MATERIALIZER" || ! -f "$SUPERVISOR" ]]; then
  echo "[test-launcher] This package is incomplete; required launch files are missing." >&2
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[test-launcher] No NVIDIA runtime was detected. Start a Vast GPU instance first." >&2
  exit 1
fi
if [[ -z "${HF_TOKEN:-}" ]]; then
  read -r -s -p "Hugging Face read token for the private model repository: " HF_TOKEN
  echo
  export HF_TOKEN
fi
if [[ -z "$HF_TOKEN" ]]; then
  echo "[test-launcher] HF_TOKEN is required for the private pinned repository." >&2
  exit 1
fi

echo "[test-launcher] source=$ROOT"
echo "[test-launcher] model=$PINNED_REPO@$PINNED_REVISION"
echo "[test-launcher] detector=127.0.0.1:4317 (loopback only)"
echo "[test-launcher] installing verified runtime dependencies"
ORISLOP_BOOTSTRAP_INSTALL_ONLY=1 bash "$BASE_BOOTSTRAP" "$ROOT"

echo "[test-launcher] checking GPU, CPU, RAM, and disk before the model download"
ORISLOP_ALLOWED_EXTENSION_ORIGINS="$EXTENSION_ORIGIN" \
ORISLOP_REQUIRE_CLOUDFLARE="0" \
ORISLOP_VAST_DIRECT_TESTING_ACK="$DIRECT_ACK" \
ORISLOP_DETECTOR_HOST="127.0.0.1" \
ORISLOP_TEMPORAL_ENABLED="0" \
ORISLOP_REQUIRE_FULL_MODEL_STACK="0" \
"$VENV/bin/python" -u "$SUPERVISOR" --preflight-only

echo "[test-launcher] downloading and hashing the pinned complete stack"
"$VENV/bin/python" "$MATERIALIZER" \
  --repo "$PINNED_REPO" \
  --revision "$PINNED_REVISION" \
  --destination "$MODEL_ROOT" \
  --env-output "$MODEL_ENV"
ACTUAL_MANIFEST_SHA256="$(sha256sum "$MODEL_ROOT/artifact_manifest.json" | awk '{print $1}')"
if [[ "$ACTUAL_MANIFEST_SHA256" != "$PINNED_MANIFEST_SHA256" ]]; then
  echo "[test-launcher] Complete-stack manifest receipt does not match the published release." >&2
  exit 1
fi
echo "[test-launcher] manifest receipt verified: $ACTUAL_MANIFEST_SHA256"

set -a
# Generated locally by the verified materializer and contains no secrets.
# shellcheck disable=SC1090
source "$MODEL_ENV"
set +a

# Apply test-only runtime settings after model.env so shadow production defaults
# cannot accidentally prevent the complete Heavy path from being exercised.
export ORISLOP_APP_ROOT="$ROOT"
export ORISLOP_MODEL_ROOT="${ORISLOP_MODEL_ROOT:-/models}"
export ORISLOP_STATUS_ROOT="${ORISLOP_STATUS_ROOT:-/run/orislop-vast}"
export ORISLOP_ALLOWED_EXTENSION_ORIGINS="$EXTENSION_ORIGIN"
export ORISLOP_DETECTOR_HOST="127.0.0.1"
export ORISLOP_DETECTOR_PORT="4317"
export ORISLOP_REQUIRE_CLOUDFLARE="0"
export ORISLOP_VAST_DIRECT_TESTING_ACK="$DIRECT_ACK"
export ORISLOP_REQUIRE_API_AUTH="0"
export ORISLOP_ALLOW_ORIGINLESS_POSTS="0"
export ORISLOP_CLOUD_HEAVY_ENABLED="1"
export ORISLOP_CLOUD_HEAVY_DEVICE="cuda"
export ORISLOP_PRELOAD_HEAVY_MODE="1"
export ORISLOP_CLOUD_HEAVY_ROLLOUT="aggressive"
export ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES="1"
export ORISLOP_VISUAL_ROLLOUT_MODE="testing"
export ORISLOP_TEMPORAL_ROLLOUT="corroborated"
export ORISLOP_OLLAMA_DEVICE="${ORISLOP_OLLAMA_DEVICE:-auto}"
export ORISLOP_STARTUP_TIMEOUT_SECONDS="${ORISLOP_STARTUP_TIMEOUT_SECONDS:-3600}"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

echo "[test-launcher] starting Ollama plus the complete detector stack"
echo "[test-launcher] keep this process running; stop it with Ctrl+C"
exec "$VENV/bin/python" -u "$SUPERVISOR"
