#!/bin/sh
set -eu

required="ORISLOP_API_TOKENS ORISLOP_ALLOWED_EXTENSION_ORIGINS ORISLOP_GOOGLE_OAUTH_CLIENT_ID ORISLOP_TOKEN_SECRET ORISLOP_CONTENT_HMAC_SECRET DATABASE_URL ORISLOP_DIAGNOSTIC_BUCKET ORISLOP_S3_ENDPOINT ORISLOP_S3_ACCESS_KEY_ID ORISLOP_S3_SECRET_ACCESS_KEY CLOUDFLARE_TUNNEL_TOKEN"
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is required for Cloud Heavy" >&2
    exit 1
  fi
done

OLLAMA_URL="${ORISLOP_OLLAMA_URL:-http://ollama:11434}"
OLLAMA_MODEL="${ORISLOP_OLLAMA_MODEL:-qwen2.5:1.5b-instruct}"
case "$OLLAMA_MODEL" in
  *[!a-zA-Z0-9._:/-]*|'')
    echo "ORISLOP_OLLAMA_MODEL contains invalid characters" >&2
    exit 1
    ;;
esac
attempt=0
until curl --fail --silent "$OLLAMA_URL/api/tags" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Ollama did not become ready within 120 seconds" >&2
    exit 1
  fi
  sleep 2
done
curl --fail --silent \
  --header "Content-Type: application/json" \
  --data "{\"model\":\"$OLLAMA_MODEL\",\"prompt\":\"Reply only with OK.\",\"stream\":false,\"keep_alive\":\"${ORISLOP_OLLAMA_KEEP_ALIVE:-24h}\",\"options\":{\"num_predict\":4,\"temperature\":0}}" \
  "$OLLAMA_URL/api/generate" >/dev/null

TUNNEL_PID=""
cleanup() {
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
TUNNEL_PID=$!

exec python /app/apps/detector-bridge/server.py
