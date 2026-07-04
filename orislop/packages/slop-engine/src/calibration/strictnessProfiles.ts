import { clamp01 } from "../../../shared/src/clamp.ts";
import type { OrislopSettings, StrictnessProfile } from "../../../shared/src/types.ts";

export type StrictnessProfileConfig = {
  id: StrictnessProfile;
  label: string;
  description: string;
  allowBelow: number;
  warnAt: number;
  skipAt: number;
  categoryMultipliers: Record<string, number>;
  commentOnlyCanSkip: boolean;
};

export const STRICTNESS_PROFILES: Record<StrictnessProfile, StrictnessProfileConfig> = {
  lenient: {
    id: "lenient",
    label: "Lenient",
    description: "Warns on suspicious formats but avoids most automatic skips.",
    allowBelow: 0.48,
    warnAt: 0.48,
    skipAt: 0.76,
    categoryMultipliers: {
      engagement_bait: 0.85,
      template_brainrot: 0.86,
      reddit_story: 0.84,
      reddit_tts_story: 0.84,
      tts_story: 0.84,
      fake_text_story: 0.86,
      low_information: 0.78,
      repetitive_format: 0.62,
      repost_like: 0.82,
      green_screen_reaction: 0.86,
      low_originality_repost: 0.9,
      local_duplicate_repost: 0.88,
      possible_unlabeled_ai: 0.78,
      ai_slop: 0.92,
      community_reaction: 0.55,
      high_risk_unsupported_claim: 0.92,
      miracle_health_claim: 0.96,
      scammy: 0.98,
      scam_finance: 1
    },
    commentOnlyCanSkip: false
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Default profile: catches common slop while keeping normal entertainment safer.",
    allowBelow: 0.38,
    warnAt: 0.38,
    skipAt: 0.6,
    categoryMultipliers: {
      engagement_bait: 1,
      template_brainrot: 1,
      reddit_story: 1,
      reddit_tts_story: 1,
      tts_story: 1,
      fake_text_story: 1,
      low_information: 0.92,
      repetitive_format: 0.8,
      repost_like: 0.96,
      green_screen_reaction: 1,
      low_originality_repost: 1,
      local_duplicate_repost: 1,
      possible_unlabeled_ai: 0.94,
      ai_slop: 1,
      community_reaction: 0.72,
      high_risk_unsupported_claim: 1,
      miracle_health_claim: 1,
      scammy: 1,
      scam_finance: 1
    },
    commentOnlyCanSkip: false
  },
  strict: {
    id: "strict",
    label: "Strict",
    description: "Skips more template, repost, TTS, and low-information formats.",
    allowBelow: 0.28,
    warnAt: 0.28,
    skipAt: 0.5,
    categoryMultipliers: {
      engagement_bait: 1.12,
      template_brainrot: 1.14,
      reddit_story: 1.16,
      reddit_tts_story: 1.18,
      tts_story: 1.14,
      fake_text_story: 1.14,
      low_information: 1.12,
      repetitive_format: 1,
      repost_like: 1.12,
      green_screen_reaction: 1.12,
      low_originality_repost: 1.14,
      local_duplicate_repost: 1.12,
      possible_unlabeled_ai: 1.08,
      ai_slop: 1.12,
      community_reaction: 1,
      high_risk_unsupported_claim: 1.08,
      miracle_health_claim: 1.08,
      scammy: 1.08,
      scam_finance: 1.08
    },
    commentOnlyCanSkip: true
  },
  nuclear: {
    id: "nuclear",
    label: "Nuclear",
    description: "Aggressive filtering for heavy Shorts cleanup; false positives are more likely.",
    allowBelow: 0.18,
    warnAt: 0.18,
    skipAt: 0.38,
    categoryMultipliers: {
      engagement_bait: 1.32,
      template_brainrot: 1.35,
      reddit_story: 1.38,
      reddit_tts_story: 1.42,
      tts_story: 1.35,
      fake_text_story: 1.35,
      low_information: 1.3,
      repetitive_format: 1.16,
      repost_like: 1.28,
      green_screen_reaction: 1.32,
      low_originality_repost: 1.35,
      local_duplicate_repost: 1.34,
      possible_unlabeled_ai: 1.22,
      ai_slop: 1.32,
      community_reaction: 1.18,
      high_risk_unsupported_claim: 1.15,
      miracle_health_claim: 1.15,
      scammy: 1.15,
      scam_finance: 1.15
    },
    commentOnlyCanSkip: true
  }
};

export function getStrictnessProfile(
  strictness: OrislopSettings["strictness"] | "medium" | unknown
): StrictnessProfileConfig {
  if (strictness === "medium") {
    return STRICTNESS_PROFILES.balanced;
  }

  if (
    strictness === "lenient"
    || strictness === "balanced"
    || strictness === "strict"
    || strictness === "nuclear"
  ) {
    return STRICTNESS_PROFILES[strictness];
  }

  return STRICTNESS_PROFILES.balanced;
}

export function categoryMultiplierForProfile(
  categories: string[],
  settings: OrislopSettings
): number {
  const profile = getStrictnessProfile(settings.strictness);
  const multipliers = categories.map((category) => profile.categoryMultipliers[category] ?? 1);
  return multipliers.length > 0 ? Math.max(...multipliers) : 1;
}

export function applyProfileMultiplier(
  score: number,
  categories: string[],
  settings: OrislopSettings
): number {
  return clamp01(score * categoryMultiplierForProfile(categories, settings));
}
