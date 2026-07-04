import { clamp01 } from "../../shared/src/clamp.ts";
import type {
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings
} from "../../shared/src/types.ts";
import { collectEvidence, fuseSignals } from "./fuseSignals.ts";
import { deepScanStatusForScore } from "./deepScan/deepScanPolicy.ts";
import { userFacingReasonForCategory } from "./policy/defaultPolicy.ts";
import {
  comedySatireScore,
  factualIntentScore,
  inferContentIntent,
  isComedyProtectedIntent
} from "./policy/contentIntent.ts";
import { normalizeSettings } from "./settings.ts";
import { contentIntentSignal } from "./signals/contentIntentSignal.ts";
import { communityReactionSignal } from "./signals/communityReactionSignal.ts";
import { metadataRulesSignal } from "./signals/metadataRulesSignal.ts";
import { platformAiLabelSignal } from "./signals/platformAiLabelSignal.ts";
import { transcriptRulesSignal } from "./signals/transcriptRulesSignal.ts";
import { userPreferenceSignal } from "./signals/userPreferenceSignal.ts";
import { actionFromProbability, getThresholds } from "./thresholds.ts";
import type { ScoreVideoOptions, SignalResult } from "./types.ts";
import { sourceVerificationSummaryForScore } from "./verification/sourceVerification.ts";

export function scoreVideo(
  short: ExtractedShort,
  settingsInput?: Partial<OrislopSettings>,
  options: ScoreVideoOptions = {}
): OrislopScoreResult {
  const settings = normalizeSettings(settingsInput);
  const baseSignals = [
    platformAiLabelSignal(short, settings),
    metadataRulesSignal(short),
    transcriptRulesSignal(short),
    contentIntentSignal(short),
    communityReactionSignal(short.communityReactionSummary, settings),
    ...(options.adapterSignals ?? [])
  ];
  const preliminary = fuseSignals(baseSignals, settings);
  const preferenceSignal = userPreferenceSignal(
    short,
    options.userPreferences,
    preliminary.categories
  );
  const signals = preferenceSignal.applicable
    ? [preferenceSignal, ...baseSignals]
    : baseSignals;
  const fused = fuseSignals(signals, settings);
  const contentIntent = inferContentIntent(short);
  const thresholds = getThresholds(settings.strictness);
  const verificationSummary = sourceVerificationSummaryForScore(
    short,
    fused.categories,
    settings,
    options.createdAt ?? null
  );
  const aiEvidenceScore = maxNullable([
    fused.aiGeneratedScore,
    fused.possibleUnlabeledAiScore
  ]);
  const evidenceScore = maxNullable([
    fused.slopScore,
    fused.claimRiskScore,
    aiEvidenceScore,
    fused.originalityRiskScore,
    fused.skipProbability
  ]) ?? 0;
  const preferenceOverride = getPreferenceOverride(signals, fused.categories, settings);
  const protectedFromClaimOnlySkip = shouldProtectFromClaimOnlySkip(
    contentIntent,
    fused.categories,
    settings
  );
  const protectedFromEntertainmentOnlySkip = shouldProtectFromEntertainmentOnlySkip(
    contentIntent,
    fused.categories
  );
  const shouldAvoidAdAutoSkip = short.isLikelyAd === true;

  const effectiveSkipProbability = protectedFromClaimOnlySkip
    || protectedFromEntertainmentOnlySkip
    || shouldAvoidAdAutoSkip
    ? Math.min(fused.skipProbability, Math.max(0, thresholds.skipAt - 0.01))
    : fused.skipProbability;

  const rawAction = actionFromPreferenceOrProbability(
    preferenceOverride,
    effectiveSkipProbability,
    settings
  );
  const action = shouldAvoidAdAutoSkip && rawAction === "skip" ? "warn" : rawAction;
  const primaryCategory = fused.categories[0] ?? null;
  const userFacingReason = action === "allow" || primaryCategory === null
    ? null
    : userFacingReasonForCategory(primaryCategory);

  return {
    videoId: short.videoId,
    url: short.url,

    slopScore: clamp01(fused.slopScore),
    claimRiskScore: clamp01(fused.claimRiskScore),
    aiGeneratedScore: fused.aiGeneratedScore === null ? null : clamp01(fused.aiGeneratedScore),
    possibleUnlabeledAiScore: fused.possibleUnlabeledAiScore === null
      ? null
      : clamp01(fused.possibleUnlabeledAiScore),
    slopEvidenceScore: clamp01(fused.slopScore),
    aiEvidenceScore: aiEvidenceScore === null ? null : clamp01(aiEvidenceScore),
    entertainmentScore: clamp01(comedySatireScore(contentIntent)),
    originalityRiskScore: fused.originalityRiskScore === null ? null : clamp01(fused.originalityRiskScore),
    evidenceScore: clamp01(evidenceScore),
    riskBand: riskBandForEvidence(evidenceScore),

    contentIntent,
    factualIntentScore: factualIntentScore(contentIntent),
    comedySatireScore: comedySatireScore(contentIntent),

    skipProbability: clamp01(effectiveSkipProbability),
    confidence: clamp01(fused.confidence),

    categories: fused.categories,
    evidence: collectEvidence(signals),

    action,
    skipReason: action === "allow" ? null : primaryCategory,
    userFacingReason,
    verificationStatus: verificationSummary.status,
    verificationSummary,
    deepScanStatus: deepScanStatusForScore(settings, signals, fused),
    adSafetyStatus: shouldAvoidAdAutoSkip ? "visible_ad_limited" : "not_ad",

    thresholdUsed: thresholds.skipAt,
    settingsApplied: fused.settingsApplied,
    signals,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

function riskBandForEvidence(evidenceScore: number): OrislopScoreResult["riskBand"] {
  if (evidenceScore >= 0.78) {
    return "severe";
  }
  if (evidenceScore >= 0.62) {
    return "high";
  }
  if (evidenceScore >= 0.46) {
    return "medium";
  }
  if (evidenceScore > 0) {
    return "low";
  }
  return "none";
}

function maxNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function shouldProtectFromClaimOnlySkip(
  contentIntent: ReturnType<typeof inferContentIntent>,
  categories: string[],
  settings: OrislopSettings
): boolean {
  if (!settings.doNotSkipComedyForFactualWrongness || !isComedyProtectedIntent(contentIntent)) {
    return false;
  }

  if (categories.length === 0) {
    return false;
  }

  return categories.every((category) => (
    category === "unsupported_claim"
    || category === "unsupported_claims"
    || category === "serious_claim"
    || category === "high_risk_unsupported_claim"
  ));
}

function shouldProtectFromEntertainmentOnlySkip(
  contentIntent: ReturnType<typeof inferContentIntent>,
  categories: string[]
): boolean {
  if (!isComedyProtectedIntent(contentIntent) || categories.length === 0) {
    return false;
  }

  const entertainmentOnlyCategories = new Set([
    "entertainment_safe",
    "normal_entertainment",
    "comedy_satire",
    "repetitive_format",
    "low_information"
  ]);

  return categories.every((category) => entertainmentOnlyCategories.has(category));
}

export function actionAllowsAutoScroll(action: OrislopAction): boolean {
  return action === "skip" || action === "pre_skip";
}

function getPreferenceOverride(
  signals: SignalResult[],
  categories: string[],
  settings: OrislopSettings
): "allow" | "block" | null {
  const preferenceSignal = signals.find((signal) => signal.name === "user_preference");
  const reasonIds = preferenceSignal?.evidence.map((item) => item.reasonId) ?? [];

  if (reasonIds.some((reasonId) => reasonId.includes("always_allow"))) {
    if (hasStrictHighRiskChannelAllowException(categories, settings)) {
      return null;
    }

    return "allow";
  }

  if (reasonIds.some((reasonId) => reasonId.includes("always_block"))) {
    return "block";
  }

  return null;
}

function hasStrictHighRiskChannelAllowException(
  categories: string[],
  settings: OrislopSettings
): boolean {
  const exceptions: Array<[string, keyof OrislopSettings]> = [
    ["scammy", "skipScamFinance"],
    ["scam_finance", "skipScamFinance"],
    ["risky_educational", "skipHighRiskUnsupportedClaims"],
    ["miracle_health_claim", "skipMiracleHealthClaims"],
    ["high_risk_unsupported_claim", "skipHighRiskUnsupportedClaims"]
  ];

  return exceptions.some(([category, setting]) => categories.includes(category) && settings[setting] === true);
}

function actionFromPreferenceOrProbability(
  preferenceOverride: "allow" | "block" | null,
  probability: number,
  settings: OrislopSettings
): OrislopAction {
  if (preferenceOverride === "allow") {
    return "allow";
  }

  if (preferenceOverride === "block") {
    return actionFromProbability(1, settings);
  }

  return actionFromProbability(probability, settings);
}
