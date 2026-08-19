import type {
  CalibrationUserLabel,
  CommunityReactionSummary,
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings,
  SignalResult
} from "../../shared/src/types.ts";
import type { UserPreferenceRules } from "../../slop-engine/src/types.ts";

export type LocalStorageOptions = {
  basePath: string;
};

export type ClockOptions = {
  now?: () => Date;
};

export type StoreOptions = LocalStorageOptions & ClockOptions;

export type UserFeedbackAction =
  | "correct"
  | "wrong"
  | "not_slop"
  | "always_allow_channel"
  | "always_block_channel"
  | "always_block_format"
  | "watch_anyway"
  | "show_anyway";

export type FeedbackRecord = {
  videoId: string | null;
  url: string;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  scoreResult: OrislopScoreResult;
  actionTaken: OrislopAction;
  userFeedback: UserFeedbackAction;
  timestamp: string;
};

export type FeedbackRecordInput = Omit<FeedbackRecord, "timestamp"> & {
  timestamp?: string;
};

export type CacheLookupInput = Pick<ExtractedShort, "videoId" | "url"> & Partial<Pick<ExtractedShort,
  | "title"
  | "channelName"
  | "channelUrl"
  | "description"
  | "hashtags"
  | "visiblePageText"
  | "hasPlatformAiLabel"
  | "platformAiLabelText"
  | "transcript"
  | "audioTrackTitle"
  | "audioIsSong"
  | "videoDurationSec"
  | "isLikelyAd"
  | "adNoticeText"
>>;

export type ScoreCacheRecord = {
  cacheKey: string;
  videoId: string | null;
  url: string;
  scoreResult: OrislopScoreResult;
  timestamp: string;
  settingsHash: string;
  extractionHash: string;
};

export type ScoreCacheStoreOptions = StoreOptions & {
  retentionDays?: number;
};

export type OriginalityVectorRecord = {
  cacheKey: string;
  videoId: string | null;
  url: string;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  metadataFingerprint: string;
  vector: number[];
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type OriginalityMatchRecord = {
  videoId: string | null;
  url: string;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  similarity: number;
};

export type OriginalityStoreOptions = StoreOptions & {
  maxRecords?: number;
  vectorDimensions?: number;
};

export type SkipHistoryRecord = {
  cacheKey: string;
  videoId: string | null;
  url: string;
  reason: string | null;
  timestamp: string;
  action: OrislopAction;
  scrolledBack: boolean;
  watchedAnyway: boolean;
  sessionId: string;
};

export type SkipHistoryInput = CacheLookupInput & {
  reason: string | null;
  action: OrislopAction;
  timestamp?: string;
  scrolledBack?: boolean;
  watchedAnyway?: boolean;
  sessionId?: string;
};

export type SkipHistoryStoreOptions = StoreOptions & {
  sessionId?: string;
  maxRecords?: number;
};

export type ChannelPreferenceKind =
  | "always_allow_channel"
  | "always_block_channel";

export type ChannelIdentity = {
  channelName: string | null;
  channelUrl: string | null;
};

export type ChannelPreferenceRecord = ChannelIdentity & {
  preference: ChannelPreferenceKind;
  matchValue: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelPreferenceRules = UserPreferenceRules;

export type SettingsStoreResult = {
  settings: OrislopSettings;
  repaired: boolean;
};

export type CalibrationRecord = {
  id: string;
  videoId: string | null;
  url: string;
  platform: "youtube_shorts" | "youtube_video" | "mock_fixture" | "unknown";
  videoKind: ExtractedShort["videoKind"];
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  hashtags: string[];
  visiblePageText: string;
  communityReactionSummary: CommunityReactionSummary | null;
  extractedSignals: SignalResult[];
  scoreResult: OrislopScoreResult;
  userLabel: CalibrationUserLabel;
  userFeedback: UserFeedbackAction | null;
  timestamp: string;
};

export type CalibrationRecordInput = {
  short: ExtractedShort;
  platform?: CalibrationRecord["platform"];
  scoreResult: OrislopScoreResult;
  userLabel: CalibrationUserLabel;
  userFeedback?: UserFeedbackAction | null;
  timestamp?: string;
};

export type CalibrationImportResult = {
  imported: number;
  skipped: number;
};
