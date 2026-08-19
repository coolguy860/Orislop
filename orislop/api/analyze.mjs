import { callOrislop, cleanText, publicFailure, readJson, sameOriginRequest, sendJson, setApiHeaders } from "./_shared.mjs";

export default async function handler(request, response) {
  setApiHeaders(response, "POST, OPTIONS");
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }
  if (request.method !== "POST") {
    return sendJson(response, 405, { ok: false, message: "Use the analyzer form to start a check." });
  }
  if (!sameOriginRequest(request)) {
    return sendJson(response, 403, { ok: false, message: "Open the analyzer on Orislop.com to start a live check." });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  if (JSON.stringify(body).length > 16_000) {
    return sendJson(response, 413, { ok: false, message: "That entry is too long for the preview. Shorten the transcript and try again." });
  }
  const url = cleanText(body.url, 2000);
  const title = cleanText(body.title, 400);
  const description = cleanText(body.description, 1600);
  const transcript = cleanText(body.transcript, 2200);
  const channelName = cleanText(body.channelName, 240);
  if (!/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    return sendJson(response, 400, { ok: false, message: "Paste a valid YouTube link to continue." });
  }
  if (`${title} ${description} ${transcript}`.trim().length < 12) {
    return sendJson(response, 400, { ok: false, message: "Add a title, description, or transcript so the live AI has enough context to review." });
  }

  try {
    const upstream = await callOrislop("/v1/text-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        performanceProfile: "heavy",
        candidates: [{
          id: "website-preview",
          platform: "youtube",
          url,
          title,
          channelName,
          visibleText: description,
          transcriptText: transcript
        }]
      })
    });
    const payload = await readJson(upstream);
    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : upstream.status === 401 || upstream.status === 403 ? 503 : 502;
      return sendJson(response, status, {
        ok: false,
        message: status === 429 ? "The live checker is busy right now. Try again shortly." : "The live checker is warming up. Try again in a moment."
      });
    }
    const result = Array.isArray(payload.results) ? payload.results[0] : null;
    if (!result || result.available !== true) {
      return sendJson(response, 503, { ok: false, message: "The live checker is warming up. Your instant result is still ready." });
    }
    return sendJson(response, 200, {
      ok: true,
      result: {
        available: true,
        verdict: result.verdict === "skip" ? "skip" : "dont_skip",
        confidence: Number.isFinite(Number(result.confidence)) ? Math.max(0, Math.min(1, Number(result.confidence))) : null,
        category: cleanText(result.category, 80) || null,
        reason: cleanText(result.reason, 240) || "Live context check completed.",
        requestId: cleanText(payload.requestId, 80) || null
      }
    });
  } catch (error) {
    const failure = publicFailure(error);
    return sendJson(response, failure.status, { ok: false, message: failure.message });
  }
}
