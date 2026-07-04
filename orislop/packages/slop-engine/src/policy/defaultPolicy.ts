import { CAUTIOUS_REASON_LABELS } from "../../../shared/src/constants.ts";

export const POLICY_CATEGORY_SETTINGS: Record<string, string> = {
  ai_labeled: "skipAllAiLabeled",
  platform_ai_labeled: "skipAllAiLabeled",
  possible_unlabeled_ai: "skipPossibleUnlabeledAi",
  useful_ai: "skipUsefulAiExplainers",
  ai_explainer: "skipUsefulAiExplainers",
  ai_slop: "skipAiSlop",
  slop: "skipAllSlop",
  engagement_bait: "skipEngagementBait",
  template_brainrot: "skipTemplateBrainrot",
  tts_story: "skipRedditTtsStories",
  reddit_story: "skipRedditTtsStories",
  reddit_tts_story: "skipRedditTtsStories",
  fake_text_story: "skipFakeTextStories",
  low_information: "skipLowInformation",
  repetitive_format: "skipRepetitiveFormats",
  repost_like: "skipRepostLike",
  green_screen_reaction: "skipGreenScreenReactions",
  low_originality_repost: "skipLowOriginalityReposts",
  local_duplicate_repost: "skipLowOriginalityReposts",
  ragebait: "skipEngagementBait",
  community_reaction: "useCommunityReactionSignal",
  scammy: "skipScamFinance",
  scam_finance: "skipScamFinance",
  risky_educational: "skipHighRiskUnsupportedClaims",
  miracle_health_claim: "skipMiracleHealthClaims",
  high_risk_unsupported_claim: "skipHighRiskUnsupportedClaims",
  unsupported_claims: "skipUnsupportedClaims",
  unsupported_claim: "skipUnsupportedClaims"
} as const;

export const CLAIM_ONLY_CATEGORIES = new Set([
  "unsupported_claim",
  "unsupported_claims",
  "serious_claim",
  "high_risk_unsupported_claim"
]);

export const NON_CLAIM_SKIP_CATEGORIES = new Set([
  "ai_labeled",
  "platform_ai_labeled",
  "possible_unlabeled_ai",
  "useful_ai",
  "ai_explainer",
  "ai_slop",
  "slop",
  "engagement_bait",
  "template_brainrot",
  "tts_story",
  "reddit_story",
  "reddit_tts_story",
  "fake_text_story",
  "low_information",
  "repetitive_format",
  "repost_like",
  "green_screen_reaction",
  "low_originality_repost",
  "local_duplicate_repost",
  "ragebait",
  "community_reaction",
  "scammy",
  "scam_finance",
  "risky_educational",
  "miracle_health_claim"
]);

export function userFacingReasonForCategory(category: string): string {
  switch (category) {
    case "ai_labeled":
    case "platform_ai_labeled":
      return CAUTIOUS_REASON_LABELS.aiBlocked;
    case "possible_unlabeled_ai":
    case "useful_ai":
    case "ai_slop":
      return CAUTIOUS_REASON_LABELS.possibleAi;
    case "engagement_bait":
    case "ragebait":
      return CAUTIOUS_REASON_LABELS.engagementBait;
    case "reddit_story":
    case "reddit_tts_story":
    case "tts_story":
      return CAUTIOUS_REASON_LABELS.redditTts;
    case "fake_text_story":
      return CAUTIOUS_REASON_LABELS.fakeChat;
    case "low_information":
      return CAUTIOUS_REASON_LABELS.lowInformation;
    case "repetitive_format":
      return CAUTIOUS_REASON_LABELS.repetitiveFormat;
    case "template_brainrot":
    case "repost_like":
      return CAUTIOUS_REASON_LABELS.templateRepost;
    case "green_screen_reaction":
      return CAUTIOUS_REASON_LABELS.greenScreenReaction;
    case "low_originality_repost":
    case "local_duplicate_repost":
      return CAUTIOUS_REASON_LABELS.lowOriginalityRepost;
    case "community_reaction":
      return CAUTIOUS_REASON_LABELS.communityReaction;
    case "scammy":
    case "scam_finance":
      return CAUTIOUS_REASON_LABELS.scamFinance;
    case "risky_educational":
    case "unsupported_claims":
    case "high_risk_unsupported_claim":
    case "miracle_health_claim":
      return CAUTIOUS_REASON_LABELS.highRiskClaim;
    default:
      return CAUTIOUS_REASON_LABELS.lowValue;
  }
}
