import type { StaticStrictness } from "./staticSlopScore";

export type WebSettings = {
  strictness: StaticStrictness;
};

export type WebFeedbackRecord = {
  videoId: string | null;
  recommendation: string;
  label: "accurate" | "wrong";
  createdAt: string;
};

export type WebFlaggedRecord = {
  id: string;
  videoId: string | null;
  url: string;
  title: string;
  recommendation: "questionable" | "skip";
  score: number;
  reasons: string[];
  createdAt: string;
};

const SETTINGS_KEY = "orislop.web.settings";
const FEEDBACK_KEY = "orislop.web.feedback";
const FLAGGED_KEY = "orislop.web.flaggedLog";

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  strictness: "balanced"
};

export function loadWebSettings(): WebSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_WEB_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    return {
      strictness: parsed.strictness === "relaxed" || parsed.strictness === "strict"
        ? parsed.strictness
        : "balanced"
    };
  } catch {
    return DEFAULT_WEB_SETTINGS;
  }
}

export function saveWebSettings(settings: WebSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadFeedbackRecords(): WebFeedbackRecord[] {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isFeedbackRecord) : [];
  } catch {
    return [];
  }
}

export function saveFeedbackRecord(record: WebFeedbackRecord): WebFeedbackRecord[] {
  const records = [
    record,
    ...loadFeedbackRecords().filter((existing) => !(
      existing.videoId === record.videoId
      && existing.recommendation === record.recommendation
    ))
  ].slice(0, 200);
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(records));
  return records;
}

export function loadFlaggedRecords(): WebFlaggedRecord[] {
  try {
    const raw = localStorage.getItem(FLAGGED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isFlaggedRecord) : [];
  } catch {
    return [];
  }
}

export function saveFlaggedRecords(records: WebFlaggedRecord[]): WebFlaggedRecord[] {
  const limited = dedupeFlaggedRecords(records).slice(0, 300);
  localStorage.setItem(FLAGGED_KEY, JSON.stringify(limited));
  return limited;
}

export function clearFlaggedRecords(): WebFlaggedRecord[] {
  localStorage.removeItem(FLAGGED_KEY);
  return [];
}

function isFeedbackRecord(value: unknown): value is WebFeedbackRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (typeof record.videoId === "string" || record.videoId === null)
    && typeof record.recommendation === "string"
    && (record.label === "accurate" || record.label === "wrong")
    && typeof record.createdAt === "string";
}

function isFlaggedRecord(value: unknown): value is WebFlaggedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (typeof record.videoId === "string" || record.videoId === null)
    && typeof record.url === "string"
    && typeof record.title === "string"
    && (record.recommendation === "questionable" || record.recommendation === "skip")
    && typeof record.score === "number"
    && Array.isArray(record.reasons)
    && record.reasons.every((reason) => typeof reason === "string")
    && typeof record.createdAt === "string";
}

function dedupeFlaggedRecords(records: WebFlaggedRecord[]): WebFlaggedRecord[] {
  const seen = new Set<string>();
  const deduped: WebFlaggedRecord[] = [];
  for (const record of records) {
    const key = `${record.videoId ?? record.url}:${record.recommendation}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(record);
  }
  return deduped;
}
