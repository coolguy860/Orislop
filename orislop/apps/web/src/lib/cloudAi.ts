export type CloudAiStatus = "checking" | "online" | "offline" | "not_configured";

export type CloudAiResult = {
  available: boolean;
  verdict: "skip" | "dont_skip" | null;
  confidence: number | null;
  category: string | null;
  reason: string;
  requestId: string | null;
};

export type CloudAiInput = {
  url: string;
  title: string;
  description: string;
  channelName: string;
  transcript: string;
};

type ApiStatusPayload = {
  ok?: boolean;
  status?: CloudAiStatus;
};

type ApiAnalyzePayload = {
  ok?: boolean;
  result?: Partial<CloudAiResult>;
  message?: string;
};

export async function getCloudAiStatus(): Promise<CloudAiStatus> {
  try {
    const response = await fetchWithTimeout("/api/status", { headers: { Accept: "application/json" } }, 6000);
    const payload = await safeJson<ApiStatusPayload>(response);
    if (payload.status === "online" || payload.status === "not_configured") {
      return payload.status;
    }
    return "offline";
  } catch {
    return "offline";
  }
}

export async function analyzeWithCloudAi(input: CloudAiInput): Promise<CloudAiResult> {
  const response = await fetchWithTimeout("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input)
  }, 18000);
  const payload = await safeJson<ApiAnalyzePayload>(response);

  if (!response.ok || payload.ok !== true || !payload.result) {
    throw new Error(friendlyCloudMessage(response.status, payload.message));
  }

  const verdict = payload.result.verdict;
  return {
    available: payload.result.available === true,
    verdict: verdict === "skip" || verdict === "dont_skip" ? verdict : null,
    confidence: typeof payload.result.confidence === "number" ? payload.result.confidence : null,
    category: typeof payload.result.category === "string" ? payload.result.category : null,
    reason: typeof payload.result.reason === "string" ? payload.result.reason : "Live context check completed.",
    requestId: typeof payload.result.requestId === "string" ? payload.result.requestId : null
  };
}

export function friendlyCloudMessage(status: number, detail?: string): string {
  if (status === 429) {
    return "The live checker is busy right now. Your instant on-device result is still ready.";
  }
  if (status === 401 || status === 403) {
    return "The live checker needs a quick setup update. Your instant on-device result is still ready.";
  }
  if (status === 400) {
    return detail || "Add a title, description, or transcript so the live AI has enough context to review.";
  }
  if (status === 503) {
    return "The deeper checker is waking up. Your instant on-device result is still ready.";
  }
  return "The live checker could not be reached. Your instant on-device result is still ready.";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, credentials: "same-origin" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The live checker took too long. Your instant on-device result is still ready.");
    }
    throw new Error("The live checker could not be reached. Your instant on-device result is still ready.");
  } finally {
    window.clearTimeout(timeout);
  }
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
