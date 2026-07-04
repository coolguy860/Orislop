import type { OrislopSettings } from "./types.ts";

export const ORISLOP_APP_NAME = "Orislop Browser";

export const ORISLOP_MVP_SCOPE = {
  platform: "youtube_desktop",
  localFirst: true,
  defaultBehavior: "auto_scroll",
  unsupportedTargets: [
    "general_browser",
    "chrome_extension",
    "mobile",
    "tiktok",
    "cloud_service",
    "truth_engine"
  ]
} as const;

export const CAUTIOUS_REASON_LABELS = {
  aiBlocked: "Skipped: AI content blocked by your settings",
  possibleAi: "Skipped: possible AI-generated content",
  lowValue: "Skipped: likely low-value content",
  engagementBait: "Skipped: possible engagement bait",
  templateRepost: "Skipped: possible template/repost format",
  greenScreenReaction: "Skipped: green-screen/reaction format with low added value",
  lowOriginalityRepost: "Skipped: likely repost or derivative clip with little added value",
  redditTts: "Skipped: Reddit/TTS story format",
  fakeChat: "Skipped: fake chat/story format",
  lowInformation: "Skipped: low-information repetitive format",
  repetitiveFormat: "Skipped: repetitive low-originality format",
  communityReaction: "Skipped: visible community reaction matched your settings",
  scamFinance: "Skipped: possible scam finance content",
  highRiskClaim: "Skipped: possible high-risk unsupported claim",
  flagged: "Orislop flagged this because:"
} as const;

export const DEFAULT_ORISLOP_SETTINGS: OrislopSettings = {
  autoSkip: true,
  skipMode: "auto_scroll_with_banner",
  allowScrollBack: true,
  showSkippedBanner: true,
  showFlaggedBannerOnScrollBack: true,
  hideFlaggedCurrentVideo: true,
  observePlaybackBeforeScoring: true,
  maxConsecutiveSkips: 5,

  enableLookaheadScan: true,
  lookaheadCount: 2,
  hideFlaggedRecommendations: true,
  enableLocalOriginalityIndex: true,

  strictness: "balanced",

  skipAllAiLabeled: true,
  skipPossibleUnlabeledAi: true,
  skipUsefulAiExplainers: true,
  skipAiSlop: true,

  skipAllSlop: true,
  skipEngagementBait: true,
  skipTemplateBrainrot: true,
  skipRedditTtsStories: true,
  skipFakeTextStories: true,
  skipLowInformation: true,
  skipRepetitiveFormats: true,
  skipRepostLike: true,
  skipGreenScreenReactions: true,
  skipLowOriginalityReposts: true,

  skipScamFinance: true,
  skipMiracleHealthClaims: true,
  skipHighRiskUnsupportedClaims: true,
  skipUnsupportedClaims: false,

  doNotSkipComedyForFactualWrongness: true,
  doNotClaimTruthVerification: true,

  enableDeepScan: false,
  enableLocalLlm: false,
  enableOcr: false,
  enableOpenClip: false,
  enableWhisper: false,
  enableExistingAiDetector: false,
  enableTemporalDetector: false,
  enableSpatialDetector: false,
  enableFusionDetector: false,
  deepScanPolicy: "manual_only",
  deepScanMaxRuntimeMs: 1500,

  enableClaimVerification: true,
  autoVerifyHighRiskClaims: true,

  useCommunityReactionSignal: false,
  communitySignalWeight: 0.2,
  maxVisibleCommentsToInspect: 24,

  showRawDebugSignals: false,

  forceRescan: false
};
