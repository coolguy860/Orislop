import type { DeepScanStatus, OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import type { ScoreBreakdown } from "../types.ts";

const DEEP_SCAN_SIGNAL_NAMES = new Set([
  "existing_ai_detector",
  "temporal_detector",
  "visual_template",
  "ocr",
  "claim_risk",
  "embedding_similarity"
]);

export type DetectorBenchmarkResult = {
  detectorId: string;
  available: boolean;
  runtimeMs: number | null;
};

export type DeepScanRuntimePolicy = {
  policy: OrislopSettings["deepScanPolicy"];
  reason: string;
};

export function deepScanStatusForScore(
  settings: OrislopSettings,
  signals: SignalResult[],
  fused: ScoreBreakdown
): DeepScanStatus {
  if (!settings.enableDeepScan) {
    return "disabled";
  }

  if (
    !settings.enableExistingAiDetector
    && !settings.enableTemporalDetector
    && !settings.enableSpatialDetector
    && !settings.enableFusionDetector
    && !settings.enableOpenClip
    && !settings.enableOcr
    && !settings.enableLocalLlm
  ) {
    return settings.deepScanPolicy === "manual_only" ? "manual_only" : "unavailable";
  }

  const deepSignals = signals.filter((signal) => DEEP_SCAN_SIGNAL_NAMES.has(signal.name));
  if (deepSignals.some((signal) => signal.applicable && signal.score !== null)) {
    return "completed";
  }

  if (deepSignals.length > 0 && deepSignals.every((signal) => signal.applicable === false && signal.error)) {
    return "unavailable";
  }

  if (settings.deepScanPolicy === "manual_only") {
    return "manual_only";
  }

  if (settings.deepScanPolicy === "all_videos" || settings.deepScanPolicy === "fast_detector_all") {
    return "pending";
  }

  return isSuspiciousEnoughForDeepScan(fused) ? "pending" : "not_needed";
}

export function isSuspiciousEnoughForDeepScan(fused: ScoreBreakdown): boolean {
  return fused.slopScore >= 0.35
    || fused.claimRiskScore >= 0.35
    || (fused.aiGeneratedScore ?? 0) >= 0.35
    || (fused.possibleUnlabeledAiScore ?? 0) >= 0.35
    || fused.categories.some((category) => (
      category === "possible_unlabeled_ai"
      || category === "scam_finance"
      || category === "miracle_health_claim"
      || category === "high_risk_unsupported_claim"
      || category === "repost_like"
      || category === "template_brainrot"
    ));
}

export function chooseDeepScanPolicyFromBenchmarks(
  results: DetectorBenchmarkResult[],
  maxRuntimeMs: number
): DeepScanRuntimePolicy {
  const available = results.filter((result) => result.available && result.runtimeMs !== null);
  const fast = available.filter((result) => (result.runtimeMs ?? Infinity) <= maxRuntimeMs);

  if (fast.length >= 2) {
    return {
      policy: "all_videos",
      reason: "At least two detectors benchmarked within the runtime target."
    };
  }

  if (fast.length === 1) {
    return {
      policy: "fast_detector_all",
      reason: `${fast[0].detectorId} benchmarked within the runtime target; slower detectors should stay suspicious-only.`
    };
  }

  if (available.length > 0) {
    return {
      policy: "suspicious_only",
      reason: "Detectors are available but slower than the runtime target."
    };
  }

  return {
    policy: "manual_only",
    reason: "No usable local detector benchmark was available."
  };
}
