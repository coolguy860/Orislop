import type {
  CalibrationUserLabel,
  CommunityKeywordCategory,
  CommunityReactionStrength,
  CommunityReactionSummary
} from "../../shared/src/types.ts";
import {
  isRecord,
  nowIso,
  readJsonFile,
  resolveStorageFile,
  uniqueStrings,
  writeJsonFile
} from "./jsonFileStore.ts";
import type {
  CalibrationImportResult,
  CalibrationRecord,
  CalibrationRecordInput,
  LocalStorageOptions,
  UserFeedbackAction
} from "./types.ts";

const CALIBRATION_FILE = "calibration-labels.json";
const MAX_CALIBRATION_RECORDS = 1000;
const VALID_LABELS = new Set<CalibrationUserLabel>([
  "slop",
  "not_slop",
  "unclear",
  "ai_generated",
  "claim_risk"
]);
const VALID_FEEDBACK = new Set<UserFeedbackAction>([
  "correct",
  "wrong",
  "not_slop",
  "always_allow_channel",
  "always_block_channel",
  "always_block_format",
  "watch_anyway",
  "show_anyway"
]);

export class CalibrationStore {
  private readonly filePath: string;

  constructor(options: LocalStorageOptions) {
    this.filePath = resolveStorageFile(options, CALIBRATION_FILE);
  }

  async list(): Promise<CalibrationRecord[]> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status === "missing") {
      await this.persist([]);
      return [];
    }

    if (read.status === "malformed") {
      await this.persist([]);
      return [];
    }

    const records = repairCalibrationRecords(read.value);
    if (JSON.stringify(records) !== JSON.stringify(read.value)) {
      await this.persist(records);
    }

    return records;
  }

  async append(input: CalibrationRecordInput): Promise<CalibrationRecord> {
    const records = await this.list();
    const timestamp = input.timestamp ?? nowIso();
    const record: CalibrationRecord = {
      id: calibrationRecordId(input.short.videoId, input.short.url, timestamp),
      videoId: input.short.videoId,
      url: input.short.url,
      platform: input.platform ?? platformForUrl(input.short.url),
      videoKind: input.short.videoKind ?? "unknown",
      title: input.short.title,
      channelName: input.short.channelName,
      channelUrl: input.short.channelUrl,
      hashtags: uniqueStrings(input.short.hashtags),
      visiblePageText: input.short.visiblePageText,
      communityReactionSummary: sanitizeCommunityReactionSummary(input.short.communityReactionSummary),
      extractedSignals: input.scoreResult.signals,
      scoreResult: input.scoreResult,
      userLabel: input.userLabel,
      userFeedback: input.userFeedback ?? null,
      timestamp
    };

    records.push(record);
    await this.persist(records.slice(-MAX_CALIBRATION_RECORDS));
    return record;
  }

  async exportRecords(): Promise<CalibrationRecord[]> {
    return this.list();
  }

  async importRecords(recordsInput: unknown): Promise<CalibrationImportResult> {
    const incoming = repairCalibrationRecords(recordsInput);
    const existing = await this.list();
    const existingIds = new Set(existing.map((record) => record.id));
    const imported = incoming.filter((record) => !existingIds.has(record.id));
    await this.persist([...existing, ...imported].slice(-MAX_CALIBRATION_RECORDS));

    return {
      imported: imported.length,
      skipped: incoming.length - imported.length
    };
  }

  async replaceAll(recordsInput: unknown): Promise<CalibrationImportResult> {
    const records = repairCalibrationRecords(recordsInput);
    await this.persist(records.slice(-MAX_CALIBRATION_RECORDS));
    return {
      imported: records.length,
      skipped: 0
    };
  }

  private async persist(records: CalibrationRecord[]): Promise<void> {
    await writeJsonFile(this.filePath, records);
  }
}

export function repairCalibrationRecords(value: unknown): CalibrationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(repairCalibrationRecord)
    .filter((record): record is CalibrationRecord => record !== null);
}

function repairCalibrationRecord(value: unknown): CalibrationRecord | null {
  if (!isRecord(value) || !isValidLabel(value.userLabel)) {
    return null;
  }

  if (!isRecord(value.scoreResult) || !Array.isArray(value.extractedSignals)) {
    return null;
  }

  const url = typeof value.url === "string" ? value.url : null;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
  if (!url || !timestamp) {
    return null;
  }

  const videoId = typeof value.videoId === "string" || value.videoId === null ? value.videoId : null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : calibrationRecordId(videoId, url, timestamp),
    videoId,
    url,
    platform: readPlatform(value.platform, url),
    videoKind: value.videoKind === "short" || value.videoKind === "watch" || value.videoKind === "unknown"
      ? value.videoKind
      : "unknown",
    title: nullableString(value.title),
    channelName: nullableString(value.channelName),
    channelUrl: nullableString(value.channelUrl),
    hashtags: Array.isArray(value.hashtags)
      ? uniqueStrings(value.hashtags.filter((item): item is string => typeof item === "string"))
      : [],
    visiblePageText: typeof value.visiblePageText === "string" ? value.visiblePageText : "",
    communityReactionSummary: sanitizeCommunityReactionSummary(value.communityReactionSummary),
    extractedSignals: value.extractedSignals as CalibrationRecord["extractedSignals"],
    scoreResult: value.scoreResult as CalibrationRecord["scoreResult"],
    userLabel: value.userLabel,
    userFeedback: isValidFeedback(value.userFeedback) ? value.userFeedback : null,
    timestamp
  };
}

function calibrationRecordId(videoId: string | null, url: string, timestamp: string): string {
  const base = videoId ?? url;
  return `${slug(base)}_${slug(timestamp)}`;
}

function platformForUrl(url: string): CalibrationRecord["platform"] {
  if (/youtube\.com\/shorts\//i.test(url)) {
    return "youtube_shorts";
  }

  if (/youtube\.com\/watch\?/i.test(url) || /youtu\.be\//i.test(url)) {
    return "youtube_video";
  }

  return "unknown";
}

function readPlatform(value: unknown, url: string): CalibrationRecord["platform"] {
  if (value === "youtube_shorts" || value === "youtube_video" || value === "mock_fixture" || value === "unknown") {
    return value;
  }

  return platformForUrl(url);
}

function isValidLabel(value: unknown): value is CalibrationUserLabel {
  return typeof value === "string" && VALID_LABELS.has(value as CalibrationUserLabel);
}

function isValidFeedback(value: unknown): value is UserFeedbackAction {
  return typeof value === "string" && VALID_FEEDBACK.has(value as UserFeedbackAction);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeCommunityReactionSummary(value: unknown): CommunityReactionSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status === "disabled" || value.status === "unavailable" || value.status === "available"
    ? value.status
    : "unavailable";
  const strength = isCommunityStrength(value.strength) ? value.strength : "none";

  return {
    status,
    inspectedCount: boundedNumber(value.inspectedCount, 0, 50),
    matchCounts: {
      slop: boundedNumber(isRecord(value.matchCounts) ? value.matchCounts.slop : 0, 0, 50),
      fake_repost: boundedNumber(isRecord(value.matchCounts) ? value.matchCounts.fake_repost : 0, 0, 50),
      ai: boundedNumber(isRecord(value.matchCounts) ? value.matchCounts.ai : 0, 0, 50),
      scam_claim_risk: boundedNumber(isRecord(value.matchCounts) ? value.matchCounts.scam_claim_risk : 0, 0, 50)
    },
    matchedCategories: Array.isArray(value.matchedCategories)
      ? value.matchedCategories.filter(isCommunityCategory).slice(0, 4)
      : [],
    strength,
    usedRawComments: false,
    sampledAt: nullableString(value.sampledAt)
  };
}

function isCommunityCategory(value: unknown): value is CommunityKeywordCategory {
  return value === "slop" || value === "fake_repost" || value === "ai" || value === "scam_claim_risk";
}

function isCommunityStrength(value: unknown): value is CommunityReactionStrength {
  return value === "none" || value === "weak" || value === "medium" || value === "strong";
}

function boundedNumber(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, numeric));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "record";
}
