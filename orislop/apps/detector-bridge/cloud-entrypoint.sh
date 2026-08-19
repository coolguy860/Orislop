#!/bin/sh
set -eu

MODEL="${ORISLOP_OLLAMA_MODEL:-qwen2.5:1.5b-instruct}"
case "$MODEL" in
  *[!a-zA-Z0-9._:/-]*|'')
    echo "ORISLOP_OLLAMA_MODEL contains invalid characters" >&2
    exit 1
    ;;
esac

ollama serve &
OLLAMA_PID=$!
TUNNEL_PID=""
cleanup() {
  kill "$OLLAMA_PID" 2>/dev/null || true
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

attempt=0
until curl --fail --silent http://127.0.0.1:11434/api/tags >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Ollama did not become ready within 120 seconds" >&2
    exit 1
  fi
  sleep 2
done

if ! ollama show "$MODEL" >/dev/null 2>&1; then
  ollama pull "$MODEL"
fi
curl --fail --silent \
  --header "Content-Type: application/json" \
  --data "{\"model\":\"$MODEL\",\"keep_alive\":\"30m\"}" \
  http://127.0.0.1:11434/api/generate >/dev/null

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
  TUNNEL_PID=$!
fi

exec python /app/apps/detector-bridge/server.py
