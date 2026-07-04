const SETTINGS_KEY = "orislop.web.settings";
const FEEDBACK_KEY = "orislop.web.feedback";
const FLAGGED_KEY = "orislop.web.flaggedLog";
export const DEFAULT_WEB_SETTINGS = {
    strictness: "balanced"
};
export function loadWebSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) {
            return DEFAULT_WEB_SETTINGS;
        }
        const parsed = JSON.parse(raw);
        return {
            strictness: parsed.strictness === "relaxed" || parsed.strictness === "strict"
                ? parsed.strictness
                : "balanced"
        };
    }
    catch {
        return DEFAULT_WEB_SETTINGS;
    }
}
export function saveWebSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
export function loadFeedbackRecords() {
    try {
        const raw = localStorage.getItem(FEEDBACK_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isFeedbackRecord) : [];
    }
    catch {
        return [];
    }
}
export function saveFeedbackRecord(record) {
    const records = [record, ...loadFeedbackRecords()].slice(0, 200);
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(records));
    return records;
}
export function loadFlaggedRecords() {
    try {
        const raw = localStorage.getItem(FLAGGED_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isFlaggedRecord) : [];
    }
    catch {
        return [];
    }
}
export function saveFlaggedRecords(records) {
    const limited = dedupeFlaggedRecords(records).slice(0, 300);
    localStorage.setItem(FLAGGED_KEY, JSON.stringify(limited));
    return limited;
}
export function clearFlaggedRecords() {
    localStorage.removeItem(FLAGGED_KEY);
    return [];
}
function isFeedbackRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.videoId === "string" || record.videoId === null)
        && typeof record.recommendation === "string"
        && (record.label === "accurate" || record.label === "wrong")
        && typeof record.createdAt === "string";
}
function isFlaggedRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value;
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
function dedupeFlaggedRecords(records) {
    const seen = new Set();
    const deduped = [];
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
