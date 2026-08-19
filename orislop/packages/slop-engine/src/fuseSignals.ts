import { clamp01 } from "../../shared/src/clamp.ts";
import type { EvidenceItem, OrislopSettings, SignalResult } from "../../shared/src/types.ts";
import { applyProfileMultiplier } from "./calibration/strictnessProfiles.ts";
import { POLICY_CATEGORY_SETTINGS } from "./policy/defaultPolicy.ts";
import type { ScoreBreakdown } from "./types.ts";

function scoreForCategory(signals: SignalResult[], categories: string[]): number | null {
  const scores = signals
    .filter((signal) => signal.applicable && signal.score !== null)
    .filter((signal) => signal.categories.some((category) => categories.includes(category)))
    .map((signal) => scoreSignalForCategory(signal, categories));

  if (scores.length === 0) {
    return null;
  }

  return Math.max(...scores);
}

function scoreSignalForCategory(signal: SignalResult, categories: string[]): number {
  const categoryEvidence = signal.evidence
    .filter((item) => item.category && categories.includes(item.category))
    .map((item) => clamp01(item.weight));

  if (categoryEvidence.length > 0) {
    return Math.max(...categoryEvidence);
  }

  return clamp01(signal.score ?? 0);
}

export function fuseSignals(signals: SignalResult[], settings: OrislopSettings): ScoreBreakdown {
  const usableSignals = signals.filter((signal) => signal.applicable && signal.score !== null);
  const evidence: EvidenceItem[] = usableSignals.flatMap((signal) => signal.evidence);
  const categories = Array.from(new Set(usableSignals.flatMap((signal) => signal.categories)));
  const settingsApplied = categories
    .map((category) => POLICY_CATEGORY_SETTINGS[category])
    .filter((setting): setting is string => Boolean(setting));

  const slopScore = scoreForCategory(usableSignals, [
    "slop",
    "ai_slop",
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
    "community_reaction"
  ]);

  const claimRiskScore = scoreForCategory(usableSignals, [
    "scammy",
    "scam_finance",
    "risky_educational",
    "miracle_health_claim",
    "high_risk_unsupported_claim",
    "unsupported_claims",
    "unsupported_claim",
    "serious_claim"
  ]);

  const aiGeneratedScore = scoreForCategory(usableSignals, [
    "ai_labeled",
    "platform_ai_labeled",
    "ai_slop",
    "ai_explainer",
    "useful_ai"
  ]);

  const possibleUnlabeledAiScore = scoreForCategory(usableSignals, [
    "possible_unlabeled_ai"
  ]);

  const originalityRiskScore = scoreForCategory(usableSignals, [
    "repost_like",
    "green_screen_reaction",
    "low_originality_repost",
    "local_duplicate_repost"
  ]);

  const enabledScores = usableSignals
    .map((signal) => scoreEnabledCategories(signal, settings))
    .filter((score): score is number => score !== null);

  const mediumHighEnabledEvidenceCount = evidence
    .filter((item) => item.category && isCategoryEnabled(item.category, settings))
    .filter((item) => item.weight >= 0.46)
    .length;
  const stackedEvidenceBoost = enabledScores.length > 0
    ? Math.min(0.2, Math.max(0, mediumHighEnabledEvidenceCount - 1) * 0.055)
    : 0;
  const skipProbability = enabledScores.length > 0
    ? clamp01(Math.max(...enabledScores) + stackedEvidenceBoost)
    : 0;
  const confidence = usableSignals.length > 0
    ? usableSignals.reduce((sum, signal) => sum + clamp01(signal.confidence), 0) / usableSignals.length
    : 0;

  return {
    slopScore: slopScore ?? 0,
    claimRiskScore: claimRiskScore ?? 0,
    aiGeneratedScore,
    possibleUnlabeledAiScore,
    originalityRiskScore,
    skipProbability,
    confidence,
    categories,
    settingsApplied
  };
}

function scoreEnabledCategories(signal: SignalResult, settings: OrislopSettings): number | null {
  const enabledCategories = signal.categories.filter((category) => isCategoryEnabled(category, settings));
  if (enabledCategories.length === 0) {
    return null;
  }

  const categorizedEvidence = signal.evidence.filter((item) => Boolean(item.category));
  const enabledEvidence = categorizedEvidence
    .filter((item) => item.category && enabledCategories.includes(item.category))
    .map((item) => clamp01(item.weight));

  // Multi-category rule signals carry per-category evidence. Use only evidence
  // belonging to enabled categories so a disabled high-risk category cannot
  // leak its score through a weaker enabled category on the same signal.
  const enabledScore = categorizedEvidence.length > 0
    ? Math.max(0, ...enabledEvidence)
    : clamp01(signal.score ?? 0);

  return applyProfileMultiplier(enabledScore, enabledCategories, settings);
}

export function collectEvidence(signals: SignalResult[]): EvidenceItem[] {
  return signals
    .filter((signal) => signal.applicable)
    .flatMap((signal) => signal.evidence)
    .sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence));
}

export function isCategoryEnabled(category: string, settings: OrislopSettings): boolean {
  const settingName = POLICY_CATEGORY_SETTINGS[category] as keyof OrislopSettings | undefined;
  if (!settingName) {
    return false;
  }

  return settings[settingName] === true;
}
