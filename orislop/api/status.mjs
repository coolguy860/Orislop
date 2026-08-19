import { callOrislop, configuredService, publicFailure, readJson, sendJson, setApiHeaders } from "./_shared.mjs";

export default async function handler(request, response) {
  setApiHeaders(response, "GET, OPTIONS");
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }
  if (request.method !== "GET") {
    return sendJson(response, 405, { ok: false, status: "offline", message: "This check only supports GET." });
  }

  try {
    if (!configuredService()) {
      return sendJson(response, 200, { ok: true, status: "not_configured" });
    }
    const upstream = await callOrislop("/health", {}, 5000);
    const payload = await readJson(upstream);
    const ready = upstream.ok && payload?.ok !== false;
    return sendJson(response, 200, { ok: true, status: ready ? "online" : "offline" });
  } catch (error) {
    const failure = publicFailure(error);
    return sendJson(response, 200, { ok: true, status: failure.code === "not_configured" ? "not_configured" : "offline" });
  }
}
