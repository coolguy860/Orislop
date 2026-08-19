const DEFAULT_TIMEOUT_MS = 15_000;

export function setApiHeaders(response, methods = "GET, OPTIONS") {
  response.setHeader("Allow", methods);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

export function sameOriginRequest(request) {
  const expected = String(process.env.ORISLOP_WEB_ORIGIN || "https://orislop.com").trim().replace(/\/+$/, "");
  const deployment = process.env.VERCEL_URL ? `https://${String(process.env.VERCEL_URL).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "";
  const origin = String(request?.headers?.origin || request?.headers?.Origin || "").trim().replace(/\/+$/, "");
  if (origin) {
    return origin === expected || Boolean(deployment && origin === deployment);
  }
  const fetchSite = String(request?.headers?.["sec-fetch-site"] || "").toLowerCase();
  return fetchSite === "same-origin" || process.env.VERCEL_ENV !== "production";
}

export function sendJson(response, status, payload) {
  response.status(status).json(payload);
}

export function configuredService() {
  const baseUrl = String(process.env.ORISLOP_AI_API_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.ORISLOP_WEB_API_TOKEN || "").trim();
  if (!baseUrl || !token) {
    return null;
  }
  const parsed = new URL(baseUrl);
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && process.env.VERCEL_ENV !== "production")) {
    throw new Error("ORISLOP_AI_API_URL must use HTTPS in production");
  }
  return {
    baseUrl,
    token,
    origin: String(process.env.ORISLOP_WEB_ORIGIN || "https://orislop.com").trim().replace(/\/+$/, "")
  };
}

export async function callOrislop(path, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const service = configuredService();
  if (!service) {
    const error = new Error("not_configured");
    error.code = "NOT_CONFIGURED";
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${service.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${service.token}`,
        Origin: service.origin,
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function cleanText(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function publicFailure(error) {
  if (error?.code === "NOT_CONFIGURED") {
    return { status: 503, code: "not_configured", message: "Live AI is not connected yet. The instant on-device checker is still available." };
  }
  if (error?.name === "AbortError") {
    return { status: 504, code: "timeout", message: "The live checker took too long. Try again in a moment." };
  }
  return { status: 503, code: "unavailable", message: "The live checker is waking up. Try again in a moment." };
}
