import type {
  CalibrationUserLabel,
  CommunityKeywordCategory,
  CommunityReactionStrength,
  CommunityReactionSummary,
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import type { UserFeedbackAction } from "../../../packages/storage/src/types.ts";
import type {
  LookaheadPosition,
  LookaheadShortCandidate,
  ScoreLookaheadPayload
} from "../src/youtube/lookaheadTypes.ts";

export type ScoreRequestPayload = {
  fixtureId?: string;
  short?: ExtractedShort;
  forceRescan?: boolean;
};

export type FeedbackPayload = {
  fixtureId?: string;
  short?: ExtractedShort;
  scoreResult: OrislopScoreResult;
  userFeedback: UserFeedbackAction;
};

export type CalibrationLabelPayload = {
  fixtureId?: string;
  short?: ExtractedShort;
  scoreResult: OrislopScoreResult;
  userLabel: CalibrationUserLabel;
  userFeedback?: UserFeedbackAction | null;
};

const FEEDBACK_ACTIONS = new Set<UserFeedbackAction>([
  "correct",
  "wrong",
  "not_slop",
  "always_allow_channel",
  "always_block_channel",
  "always_block_format",
  "watch_anyway",
  "show_anyway"
]);

const LOOKAHEAD_POSITIONS = new Set<LookaheadPosition>([
  "current",
  "next",
  "nearby",
  "unknown"
]);

const CALIBRATION_LABELS = new Set<CalibrationUserLabel>([
  "slop",
  "not_slop",
  "unclear",
  "ai_generated",
  "claim_risk"
]);

const COMMUNITY_STATUSES = new Set<CommunityReactionSummary["status"]>([
  "disabled",
  "unavailable",
  "available"
]);

const COMMUNITY_STRENGTHS = new Set<CommunityReactionStrength>([
  "none",
  "weak",
  "medium",
  "strong"
]);

const COMMUNITY_CATEGORIES = new Set<CommunityKeywordCategory>([
  "slop",
  "fake_repost",
  "ai",
  "scam_claim_risk"
]);

export function readScorePayload(payload: unknown): ScoreRequestPayload {
  if (!isRecord(payload)) {
    throw new Error("Score payload must be an object.");
  }

  const fixtureId = optionalString(payload.fixtureId, "fixtureId");
  const short = payload.short === undefined ? undefined : readExtractedShort(payload.short);
  const forceRescan = optionalBoolean(payload.forceRescan, "forceRescan");

  if (!fixtureId && !short) {
    throw new Error("Score payload requires fixtureId or short.");
  }

  return {
    fixtureId,
    short,
    forceRescan
  };
}

export function readFeedbackPayload(payload: unknown): FeedbackPayload {
  if (!isRecord(payload)) {
    throw new Error("Feedback payload must be an object.");
  }

  const userFeedback = payload.userFeedback;
  if (typeof userFeedback !== "string" || !FEEDBACK_ACTIONS.has(userFeedback as UserFeedbackAction)) {
    throw new Error("Feedback payload has an invalid userFeedback value.");
  }

  if (!isScoreResult(payload.scoreResult)) {
    throw new Error("Feedback payload requires a scoreResult.");
  }

  return {
    fixtureId: optionalString(payload.fixtureId, "fixtureId"),
    short: payload.short === undefined ? undefined : readExtractedShort(payload.short),
    scoreResult: payload.scoreResult,
    userFeedback: userFeedback as UserFeedbackAction
  };
}

export function readCalibrationLabelPayload(payload: unknown): CalibrationLabelPayload {
  if (!isRecord(payload)) {
    throw new Error("Calibration label payload must be an object.");
  }

  const userLabel = payload.userLabel;
  if (typeof userLabel !== "string" || !CALIBRATION_LABELS.has(userLabel as CalibrationUserLabel)) {
    throw new Error("Calibration label payload has an invalid userLabel value.");
  }

  if (!isScoreResult(payload.scoreResult)) {
    throw new Error("Calibration label payload requires a scoreResult.");
  }

  const fixtureId = optionalString(payload.fixtureId, "fixtureId");
  const short = payload.short === undefined ? undefined : readExtractedShort(payload.short);
  if (!fixtureId && !short) {
    throw new Error("Calibration label payload requires fixtureId or short.");
  }

  return {
    fixtureId,
    short,
    scoreResult: payload.scoreResult,
    userLabel: userLabel as CalibrationUserLabel,
    userFeedback: payload.userFeedback === undefined || payload.userFeedback === null
      ? null
      : readFeedbackAction(payload.userFeedback)
  };
}

export function readCalibrationImportPayload(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) {
    throw new Error("Calibration import payload must be an array.");
  }

  return payload.slice(0, 5000);
}

export function readSettingsPatch(payload: unknown): Partial<OrislopSettings> {
  if (!isRecord(payload)) {
    throw new Error("Settings patch must be an object.");
  }

  const patch: Partial<OrislopSettings> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      (patch as Record<string, unknown>)[key] = value;
    }
  }

  return patch;
}

export function readScoreLookaheadPayload(payload: unknown): ScoreLookaheadPayload {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Lookahead payload requires a candidates array.");
  }

  return {
    candidates: payload.candidates.slice(0, 10).map(readLookaheadCandidate)
  };
}

function readExtractedShort(value: unknown): ExtractedShort {
  if (!isRecord(value)) {
    throw new Error("short must be an object.");
  }

  return {
    platform: readOptionalEnum(value.platform, "short.platform", ["youtube", "mock", "unknown"]),
    videoKind: readOptionalEnum(value.videoKind, "short.videoKind", ["short", "watch", "unknown"]),
    url: requiredString(value.url, "short.url"),
    videoId: nullableString(value.videoId, "short.videoId"),
    title: nullableString(value.title, "short.title"),
    channelName: nullableString(value.channelName, "short.channelName"),
    channelUrl: nullableString(value.channelUrl, "short.channelUrl"),
    description: nullableString(value.description, "short.description"),
    hashtags: readStringArray(value.hashtags, "short.hashtags"),
    visiblePageText: requiredString(value.visiblePageText, "short.visiblePageText"),
    hasPlatformAiLabel: requiredBoolean(value.hasPlatformAiLabel, "short.hasPlatformAiLabel"),
    platformAiLabelText: nullableString(value.platformAiLabelText, "short.platformAiLabelText"),
    transcript: nullableString(value.transcript, "short.transcript"),
    audioTrackTitle: value.audioTrackTitle === undefined ? undefined : nullableString(value.audioTrackTitle, "short.audioTrackTitle"),
    audioIsSong: value.audioIsSong === undefined ? undefined : requiredBoolean(value.audioIsSong, "short.audioIsSong"),
    videoDurationSec: value.videoDurationSec === undefined ? undefined : nullableFiniteNumber(value.videoDurationSec, "short.videoDurationSec"),
    playbackCurrentTimeSec: value.playbackCurrentTimeSec === undefined ? undefined : nullableFiniteNumber(value.playbackCurrentTimeSec, "short.playbackCurrentTimeSec"),
    playbackPaused: value.playbackPaused === undefined ? undefined : nullableBoolean(value.playbackPaused, "short.playbackPaused"),
    playbackReadyState: value.playbackReadyState === undefined ? undefined : nullableFiniteNumber(value.playbackReadyState, "short.playbackReadyState"),
    playerStateText: value.playerStateText === undefined ? undefined : nullableString(value.playerStateText, "short.playerStateText"),
    isLikelyAd: value.isLikelyAd === undefined ? undefined : requiredBoolean(value.isLikelyAd, "short.isLikelyAd"),
    adNoticeText: value.adNoticeText === undefined ? undefined : nullableString(value.adNoticeText, "short.adNoticeText"),
    communityReactionSummary: value.communityReactionSummary === undefined || value.communityReactionSummary === null
      ? null
      : readCommunityReactionSummary(value.communityReactionSummary)
  };
}

function readCommunityReactionSummary(value: unknown): CommunityReactionSummary {
  if (!isRecord(value)) {
    throw new Error("communityReactionSummary must be an object.");
  }

  const status = value.status;
  if (typeof status !== "string" || !COMMUNITY_STATUSES.has(status as CommunityReactionSummary["status"])) {
    throw new Error("communityReactionSummary.status is invalid.");
  }

  const strength = value.strength;
  if (typeof strength !== "string" || !COMMUNITY_STRENGTHS.has(strength as CommunityReactionStrength)) {
    throw new Error("communityReactionSummary.strength is invalid.");
  }

  const matchCounts = readCommunityMatchCounts(value.matchCounts);
  const matchedCategories = readCommunityCategories(value.matchedCategories);

  if (value.usedRawComments !== false) {
    throw new Error("communityReactionSummary.usedRawComments must be false.");
  }

  return {
    status: status as CommunityReactionSummary["status"],
    inspectedCount: finiteNumber(value.inspectedCount, "communityReactionSummary.inspectedCount", 0, 50),
    matchCounts,
    matchedCategories,
    strength: strength as CommunityReactionStrength,
    usedRawComments: false,
    sampledAt: nullableString(value.sampledAt, "communityReactionSummary.sampledAt")
  };
}

function readFeedbackAction(value: unknown): UserFeedbackAction {
  if (typeof value !== "string" || !FEEDBACK_ACTIONS.has(value as UserFeedbackAction)) {
    throw new Error("Feedback action is invalid.");
  }

  return value as UserFeedbackAction;
}

function isScoreResult(value: unknown): value is OrislopScoreResult {
  return isRecord(value)
    && typeof value.url === "string"
    && "action" in value
    && Array.isArray(value.evidence)
    && Array.isArray(value.categories);
}

function readLookaheadCandidate(value: unknown): LookaheadShortCandidate {
  if (!isRecord(value)) {
    throw new Error("Lookahead candidate must be an object.");
  }

  const position = value.position;
  if (typeof position !== "string" || !LOOKAHEAD_POSITIONS.has(position as LookaheadPosition)) {
    throw new Error("Lookahead candidate has invalid position.");
  }

  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0;

  return {
    extractionId: requiredString(value.extractionId, "candidate.extractionId"),
    url: nullableString(value.url, "candidate.url"),
    videoId: nullableString(value.videoId, "candidate.videoId"),
    title: nullableString(value.title, "candidate.title"),
    channelName: nullableString(value.channelName, "candidate.channelName"),
    channelUrl: nullableString(value.channelUrl, "candidate.channelUrl"),
    visiblePageText: requiredString(value.visiblePageText, "candidate.visiblePageText"),
    platformAiLabelText: value.platformAiLabelText === undefined
      ? null
      : nullableString(value.platformAiLabelText, "candidate.platformAiLabelText"),
    position: position as LookaheadPosition,
    confidence
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }

  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }

  return value;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null) {
    return null;
  }

  return requiredBoolean(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredBoolean(value, field);
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array.`);
  }

  return value;
}

function readOptionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} is invalid.`);
  }

  return value as T;
}

function readCommunityMatchCounts(value: unknown): Record<CommunityKeywordCategory, number> {
  if (!isRecord(value)) {
    throw new Error("communityReactionSummary.matchCounts must be an object.");
  }

  return {
    slop: finiteNumber(value.slop, "matchCounts.slop", 0, 50),
    fake_repost: finiteNumber(value.fake_repost, "matchCounts.fake_repost", 0, 50),
    ai: finiteNumber(value.ai, "matchCounts.ai", 0, 50),
    scam_claim_risk: finiteNumber(value.scam_claim_risk, "matchCounts.scam_claim_risk", 0, 50)
  };
}

function readCommunityCategories(value: unknown): CommunityKeywordCategory[] {
  if (!Array.isArray(value)) {
    throw new Error("communityReactionSummary.matchedCategories must be an array.");
  }

  return value
    .filter((item): item is CommunityKeywordCategory => typeof item === "string" && COMMUNITY_CATEGORIES.has(item as CommunityKeywordCategory))
    .slice(0, 4);
}

function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }

  return Math.max(min, Math.min(max, value));
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number or null.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
