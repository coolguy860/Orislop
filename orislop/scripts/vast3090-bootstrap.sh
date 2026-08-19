#!/usr/bin/env bash
set -Eeuo pipefail

# Immediate-use path for a Vast NVIDIA CUDA SSH/Jupyter instance. This installs
# Orislop directly into the existing Vast container; it does not attempt nested
# Docker. Run from the extracted repository root.

ROOT="${1:-$(pwd)}"
ROOT="$(cd "$ROOT" && pwd)"
REQUIREMENTS="$ROOT/apps/detector-bridge/requirements.txt"
SUPERVISOR="$ROOT/apps/detector-bridge/vast_supervisor.py"
VENV="${ORISLOP_VENV:-/opt/orislop-venv}"
OLLAMA_VERSION="${ORISLOP_OLLAMA_VERSION:-0.32.5}"
CLOUDFLARED_VERSION="${ORISLOP_CLOUDFLARED_VERSION:-2026.7.0}"
CLOUDFLARED_SHA256="${ORISLOP_CLOUDFLARED_SHA256:-434a04eb237e07d3d4146fc44acdbb411260a94fcb01764f454abe38a09503f3}"

if [[ ! -f "$REQUIREMENTS" || ! -f "$SUPERVISOR" ]]; then
  echo "[vast-bootstrap] Run this script from the extracted Orislop Vast folder." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "[vast-bootstrap] Root or sudo is required to install system packages." >&2
  exit 1
fi

echo "[vast-bootstrap] root=$ROOT"
echo "[vast-bootstrap] installing OS dependencies"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y --no-install-recommends \
  ca-certificates curl ffmpeg python3 python3-pip python3-venv tesseract-ocr zstd

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[vast-bootstrap] installing cloudflared $CLOUDFLARED_VERSION"
  TEMP_CLOUDFLARED="$(mktemp)"
  curl --fail --location --silent --show-error \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    --output "$TEMP_CLOUDFLARED"
  echo "$CLOUDFLARED_SHA256  $TEMP_CLOUDFLARED" | sha256sum --check --strict
  "${SUDO[@]}" install -m 0755 "$TEMP_CLOUDFLARED" /usr/local/bin/cloudflared
  rm -f "$TEMP_CLOUDFLARED"
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "[vast-bootstrap] installing Ollama $OLLAMA_VERSION from the official installer"
  TEMP_OLLAMA_INSTALL="$(mktemp)"
  curl --fail --location --silent --show-error https://ollama.com/install.sh \
    --output "$TEMP_OLLAMA_INSTALL"
  "${SUDO[@]}" env OLLAMA_VERSION="$OLLAMA_VERSION" sh "$TEMP_OLLAMA_INSTALL"
  rm -f "$TEMP_OLLAMA_INSTALL"
fi

echo "[vast-bootstrap] preparing Python environment"
if [[ ! -x "$VENV/bin/python" ]]; then
  "${SUDO[@]}" python3 -m venv "$VENV"
fi
REQ_SHA="$(sha256sum "$REQUIREMENTS" | awk '{print $1}')"
STAMP="$VENV/.orislop-requirements-$REQ_SHA"
if [[ ! -f "$STAMP" ]]; then
  "${SUDO[@]}" "$VENV/bin/pip" install --no-cache-dir --upgrade pip
  "${SUDO[@]}" "$VENV/bin/pip" install --no-cache-dir -r "$REQUIREMENTS"
  "${SUDO[@]}" touch "$STAMP"
fi

"${SUDO[@]}" mkdir -p /models /run/orislop-vast /run/orislop-media
"${SUDO[@]}" chmod 0700 /run/orislop-vast /run/orislop-media
if [[ "$(id -u)" -ne 0 ]]; then
  "${SUDO[@]}" chown -R "$(id -u):$(id -g)" /models /run/orislop-vast /run/orislop-media
fi

if [[ -n "${ORISLOP_ENV_FILE:-}" ]]; then
  if [[ ! -f "$ORISLOP_ENV_FILE" ]]; then
    echo "[vast-bootstrap] ORISLOP_ENV_FILE is missing: $ORISLOP_ENV_FILE" >&2
    exit 1
  fi
  ENV_MODE="$(stat -c '%a' "$ORISLOP_ENV_FILE")"
  if [[ "$ENV_MODE" != "600" && "$ENV_MODE" != "400" ]]; then
    echo "[vast-bootstrap] Refusing environment file mode $ENV_MODE; use chmod 600." >&2
    exit 1
  fi
  echo "[vast-bootstrap] loading private environment after installation"
  set -a
  # shellcheck disable=SC1090 -- the operator supplies this private file.
  source "$ORISLOP_ENV_FILE"
  set +a
fi

export ORISLOP_APP_ROOT="$ROOT"
export ORISLOP_MODEL_ROOT="${ORISLOP_MODEL_ROOT:-/models}"
export ORISLOP_STATUS_ROOT="${ORISLOP_STATUS_ROOT:-/run/orislop-vast}"

if [[ "${ORISLOP_BOOTSTRAP_INSTALL_ONLY:-0}" == "1" ]]; then
  echo "[vast-bootstrap] installation complete; start with:"
  echo "  $VENV/bin/python $SUPERVISOR"
  exit 0
fi

echo "[vast-bootstrap] installation complete; starting strict preflight and services"
exec "$VENV/bin/python" "$SUPERVISOR"
