(() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_QUEUE_SIZE = 200;
  const MAX_BATCH_SIZE = 20;
  const EVENT_NAMES = new Set([
    "scan_batch_started",
    "scan_batch_completed",
    "request_failed",
    "request_retried",
    "request_deduplicated",
    "decision_presented",
    "correction_submitted",
    "manual_skip",
    "attention_response",
    "feature_toggled",
    "adapter_health"
  ]);
  const ATTRIBUTE_FIELDS = new Set([
    "platform",
    "inferenceMode",
    "performanceMode",
    "outcome",
    "status",
    "verdict",
    "reasonCode",
    "requestKind",
    "correction",
    "satisfaction",
    "feature",
    "adapterState",
    "cacheState",
    "durationBucket",
    "retryAfterBucket",
    "modelIds",
    "batchSize",
    "itemCount",
    "hiddenCount",
    "retryCount",
    "dedupeCount",
    "queueDepthBucket"
  ]);
  const SENSITIVE_FIELD = /(url|uri|title|text|caption|transcript|prompt|question|answer|email|name|token|secret|password|cookie|authorization|media|videoid|itemid)/i;
  const TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,119}$/;
  const ID_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/;
  const MODES = new Set(["local", "hybrid", "cloud", "unknown"]);
  const PERFORMANCE_MODES = new Set(["auto", "fast", "heavy", "unknown"]);
  const PLATFORMS = new Set(["youtube", "instagram", "tiktok", "linkedin", "other", "unknown"]);

  function sanitizeEvent(input, defaults = {}) {
    if (!isPlainObject(input) || !EVENT_NAMES.has(input.eventName)) return null;
    const eventId = cleanId(input.eventId || defaults.eventId);
    const installationId = cleanId(input.installationId || defaults.installationId);
    const sessionId = cleanId(input.sessionId || defaults.sessionId);
    if (!eventId || !installationId || !sessionId) return null;
    const occurredAt = normalizeIso(input.occurredAt || defaults.occurredAt);
    if (!occurredAt) return null;
    const attributes = sanitizeAttributes(input.attributes);
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      eventName: input.eventName,
      occurredAt,
      installationId,
      sessionId,
      extensionVersion: cleanVersion(input.extensionVersion || defaults.extensionVersion),
      attributes
    };
  }

  function sanitizeAttributes(input) {
    if (!isPlainObject(input)) return {};
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (!ATTRIBUTE_FIELDS.has(key) || SENSITIVE_FIELD.test(key)) continue;
      if (key === "platform") {
        output[key] = PLATFORMS.has(value) ? value : "unknown";
      } else if (key === "inferenceMode") {
        output[key] = MODES.has(value) ? value : "unknown";
      } else if (key === "performanceMode") {
        output[key] = PERFORMANCE_MODES.has(value) ? value : "unknown";
      } else if (key === "modelIds") {
        const models = Array.isArray(value) ? value : [];
        output[key] = [...new Set(models.map(cleanToken).filter(Boolean))].slice(0, 8);
      } else if (["batchSize", "itemCount", "hiddenCount", "retryCount", "dedupeCount", "queueDepthBucket"].includes(key)) {
        output[key] = boundedInteger(value, 0, 10000);
      } else {
        const token = cleanToken(value);
        if (token) output[key] = token;
      }
    }
    return output;
  }

  function containsSensitiveMaterial(value) {
    if (!isPlainObject(value)) return false;
    return Object.keys(value).some((key) => SENSITIVE_FIELD.test(key));
  }

  function normalizeQueue(input, limit = MAX_QUEUE_SIZE) {
    const byId = new Map();
    for (const event of Array.isArray(input) ? input : []) {
      const normalized = sanitizeEvent(event);
      if (!normalized) continue;
      byId.delete(normalized.eventId);
      byId.set(normalized.eventId, normalized);
    }
    return Array.from(byId.values()).slice(-boundedInteger(limit, 1, MAX_QUEUE_SIZE));
  }

  function appendBounded(queue, event, limit = MAX_QUEUE_SIZE) {
    const normalized = sanitizeEvent(event);
    if (!normalized) return normalizeQueue(queue, limit);
    return normalizeQueue([...(Array.isArray(queue) ? queue : []), normalized], limit);
  }

  function retryAfterMilliseconds(headers, now = Date.now()) {
    const raw = headers?.get?.("Retry-After");
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.min(60000, Math.max(0, Math.ceil(seconds * 1000)));
    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp) ? Math.min(60000, Math.max(0, timestamp - now)) : 0;
  }

  function shouldRetryRequest({ method = "GET", status = 0, attempt = 0, maxRetries = 2, idempotent = false } = {}) {
    if (attempt >= maxRetries) return false;
    const normalizedMethod = String(method).toUpperCase();
    if (!(idempotent || ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod))) return false;
    const code = Number(status) || 0;
    return code === 0 || code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599);
  }

  function retryDelayMilliseconds({ attempt = 0, headers, random = Math.random } = {}) {
    const explicit = retryAfterMilliseconds(headers);
    if (explicit > 0) return explicit;
    const base = Math.min(4000, 300 * (2 ** Math.max(0, attempt)));
    return Math.round(base + Math.max(0, Math.min(1, Number(random()) || 0)) * 200);
  }

  async function executeWithRetry(execute, {
    method = "GET",
    idempotent = false,
    maxRetries = 2,
    onRetry = () => {},
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random
  } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      let failure;
      try {
        response = await execute(attempt);
      } catch (error) {
        failure = error;
      }
      const status = response?.status || 0;
      const retry = shouldRetryRequest({ method, status, attempt, maxRetries, idempotent });
      if (!retry) {
        if (failure) throw failure;
        return response;
      }
      const delay = retryDelayMilliseconds({ attempt, headers: response?.headers, random });
      await onRetry({ attempt: attempt + 1, delay, status, failure });
      await sleep(delay);
    }
  }

  function cleanId(value) {
    const text = String(value || "").trim();
    return ID_PATTERN.test(text) ? text : "";
  }

  function cleanVersion(value) {
    const text = String(value || "unknown").trim();
    return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,31}$/.test(text) ? text : "unknown";
  }

  function cleanToken(value) {
    if (!["string", "number", "boolean"].includes(typeof value)) return "";
    const text = String(value).trim();
    return TOKEN_PATTERN.test(text) ? text : "";
  }

  function normalizeIso(value) {
    const timestamp = Date.parse(String(value || ""));
    if (!Number.isFinite(timestamp)) return "";
    const now = Date.now();
    if (timestamp < now - 7 * 24 * 60 * 60 * 1000 || timestamp > now + 5 * 60 * 1000) return "";
    return new Date(timestamp).toISOString();
  }

  function boundedInteger(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  globalThis.OrislopProductTelemetry = Object.freeze({
    SCHEMA_VERSION,
    MAX_QUEUE_SIZE,
    MAX_BATCH_SIZE,
    eventNames: Object.freeze([...EVENT_NAMES]),
    sanitizeEvent,
    sanitizeAttributes,
    containsSensitiveMaterial,
    normalizeQueue,
    appendBounded,
    retryAfterMilliseconds,
    retryDelayMilliseconds,
    executeWithRetry,
    shouldRetryRequest
  });
})();
