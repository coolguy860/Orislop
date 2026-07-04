export type YouTubeVideoKind =
  | "short"
  | "watch"
  | "unknown";

export type ExtractedShort = {
  platform?: "youtube" | "mock" | "unknown";
  videoKind?: YouTubeVideoKind;
  url: string;
  videoId: string | null;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  description: string | null;
  hashtags: string[];
  visiblePageText: string;
  hasPlatformAiLabel: boolean;
  platformAiLabelText: string | null;
  transcript: string | null;
  audioTrackTitle?: string | null;
  audioIsSong?: boolean;
  videoDurationSec?: number | null;
  playbackCurrentTimeSec?: number | null;
  playbackPaused?: boolean | null;
  playbackReadyState?: number | null;
  playerStateText?: string | null;
  isLikelyAd?: boolean;
  adNoticeText?: string | null;
  communityReactionSummary?: CommunityReactionSummary | null;
};

export type EvidenceItem = {
  reasonId: string;
  label: string;
  detail: string;
  weight: number;
  confidence: number;
  source: string;
  category?: string;
};

export type SignalResult = {
  name: string;
  score: number | null;
  confidence: number;
  applicable: boolean;
  categories: string[];
  evidence: EvidenceItem[];
  reason: string;
  runtimeMs?: number;
  error?: string | null;
};

export type ContentIntent =
  | "comedy_satire"
  | "fiction_story"
  | "normal_entertainment"
  | "serious_education"
  | "news_current_events"
  | "health_advice"
  | "finance_advice"
  | "legal_advice"
  | "political_claim"
  | "science_claim"
  | "history_claim"
  | "scam_promo"
  | "unknown";

export type OrislopAction =
  | "allow"
  | "warn"
  | "skip"
  | "pre_skip";

export type SkipMode =
  | "off"
  | "warn_only"
  | "auto_scroll_with_banner"
  | "auto_scroll_silent";

export type StrictnessProfile =
  | "lenient"
  | "balanced"
  | "strict"
  | "nuclear";

export type CommunityKeywordCategory =
  | "slop"
  | "fake_repost"
  | "ai"
  | "scam_claim_risk";

export type CommunityReactionStrength =
  | "none"
  | "weak"
  | "medium"
  | "strong";

export type CommunityReactionSummary = {
  status: "disabled" | "unavailable" | "available";
  inspectedCount: number;
  matchCounts: Record<CommunityKeywordCategory, number>;
  matchedCategories: CommunityKeywordCategory[];
  strength: CommunityReactionStrength;
  usedRawComments: false;
  sampledAt: string | null;
};

export type CalibrationUserLabel =
  | "slop"
  | "not_slop"
  | "unclear"
  | "ai_generated"
  | "claim_risk";

export type VerificationStatus =
  | "not_checked"
  | "checking"
  | "corroborated"
  | "mixed"
  | "not_enough_evidence"
  | "contradicted"
  | "unavailable";

export type SourceVerificationSummary = {
  status: VerificationStatus;
  query: string | null;
  checkedAt: string | null;
  sourceCount: number;
  sourceHosts: string[];
  notes: string[];
};

export type DeepScanStatus =
  | "disabled"
  | "not_needed"
  | "manual_only"
  | "pending"
  | "completed"
  | "unavailable"
  | "error";

export type OrislopSettings = {
  autoSkip: boolean;
  skipMode: SkipMode;
  allowScrollBack: boolean;
  showSkippedBanner: boolean;
  showFlaggedBannerOnScrollBack: boolean;
  hideFlaggedCurrentVideo: boolean;
  observePlaybackBeforeScoring: boolean;
  maxConsecutiveSkips: number;

  enableLookaheadScan: boolean;
  lookaheadCount: number;
  hideFlaggedRecommendations: boolean;
  enableLocalOriginalityIndex: boolean;

  strictness: StrictnessProfile;

  skipAllAiLabeled: boolean;
  skipPossibleUnlabeledAi: boolean;
  skipUsefulAiExplainers: boolean;
  skipAiSlop: boolean;

  skipAllSlop: boolean;
  skipEngagementBait: boolean;
  skipTemplateBrainrot: boolean;
  skipRedditTtsStories: boolean;
  skipFakeTextStories: boolean;
  skipLowInformation: boolean;
  skipRepetitiveFormats: boolean;
  skipRepostLike: boolean;
  skipGreenScreenReactions: boolean;
  skipLowOriginalityReposts: boolean;

  skipScamFinance: boolean;
  skipMiracleHealthClaims: boolean;
  skipHighRiskUnsupportedClaims: boolean;
  skipUnsupportedClaims: boolean;

  doNotSkipComedyForFactualWrongness: boolean;
  doNotClaimTruthVerification: boolean;

  enableDeepScan: boolean;
  enableLocalLlm: boolean;
  enableOcr: boolean;
  enableOpenClip: boolean;
  enableWhisper: boolean;
  enableExistingAiDetector: boolean;
  enableTemporalDetector: boolean;
  enableSpatialDetector: boolean;
  enableFusionDetector: boolean;
  deepScanPolicy: "manual_only" | "suspicious_only" | "fast_detector_all" | "all_videos";
  deepScanMaxRuntimeMs: number;

  enableClaimVerification: boolean;
  autoVerifyHighRiskClaims: boolean;

  useCommunityReactionSignal: boolean;
  communitySignalWeight: number;
  maxVisibleCommentsToInspect: number;

  showRawDebugSignals: boolean;

  forceRescan: boolean;
};

export type OrislopScoreResult = {
  videoId: string | null;
  url: string;

  slopScore: number;
  claimRiskScore: number;
  aiGeneratedScore: number | null;
  possibleUnlabeledAiScore: number | null;
  slopEvidenceScore: number;
  aiEvidenceScore: number | null;
  entertainmentScore: number;
  originalityRiskScore: number | null;
  evidenceScore: number;
  riskBand: "none" | "low" | "medium" | "high" | "severe";

  contentIntent: ContentIntent;
  factualIntentScore: number;
  comedySatireScore: number;

  skipProbability: number;
  confidence: number;

  categories: string[];
  evidence: EvidenceItem[];

  action: OrislopAction;
  skipReason: string | null;
  userFacingReason: string | null;
  verificationStatus: VerificationStatus;
  verificationSummary: SourceVerificationSummary | null;
  deepScanStatus: DeepScanStatus;
  adSafetyStatus: "not_ad" | "visible_ad_limited";

  thresholdUsed: number;
  settingsApplied: string[];
  signals: SignalResult[];
  createdAt: string;
};
