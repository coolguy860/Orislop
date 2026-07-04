export { scoreVideo, actionAllowsAutoScroll } from "./scoreVideo.ts";
export { fuseSignals, collectEvidence, isCategoryEnabled } from "./fuseSignals.ts";
export { defaultSettings, normalizeSettings } from "./settings.ts";
export {
  STRICTNESS_THRESHOLDS,
  actionFromProbability,
  getThresholds
} from "./thresholds.ts";
export {
  STRICTNESS_PROFILES,
  applyProfileMultiplier,
  categoryMultiplierForProfile,
  getStrictnessProfile
} from "./calibration/strictnessProfiles.ts";
export {
  evaluateCalibrationRecords,
  formatCalibrationReport
} from "./calibration/evaluateCalibration.ts";
export {
  chooseDeepScanPolicyFromBenchmarks,
  deepScanStatusForScore,
  isSuspiciousEnoughForDeepScan
} from "./deepScan/deepScanPolicy.ts";
export {
  buildVerificationQuery,
  shouldAutoVerifyClaim,
  sourceVerificationSummaryForScore,
  summarizeMockSourceResults
} from "./verification/sourceVerification.ts";
export {
  comedySatireScore,
  factualIntentScore,
  inferContentIntent,
  isComedyProtectedIntent
} from "./policy/contentIntent.ts";
export {
  POLICY_CATEGORY_SETTINGS,
  userFacingReasonForCategory
} from "./policy/defaultPolicy.ts";
export { contentIntentSignal } from "./signals/contentIntentSignal.ts";
export { communityReactionSignal } from "./signals/communityReactionSignal.ts";
export { metadataRulesSignal } from "./signals/metadataRulesSignal.ts";
export { platformAiLabelSignal } from "./signals/platformAiLabelSignal.ts";
export { transcriptRulesSignal } from "./signals/transcriptRulesSignal.ts";
export { userPreferenceSignal } from "./signals/userPreferenceSignal.ts";
export { embeddingSimilaritySignal } from "./signals/embeddingSimilaritySignal.ts";
export { visualTemplateSignal } from "./signals/visualTemplateSignal.ts";
export { ocrSignal } from "./signals/ocrSignal.ts";
export { claimRiskSignal } from "./signals/claimRiskSignal.ts";
export { existingAiDetectorSignal } from "./signals/existingAiDetectorSignal.ts";
export { localOriginalitySignal } from "./signals/localOriginalitySignal.ts";
export { temporalDetectorSignal } from "./signals/temporalDetectorSignal.ts";
export type {
  ContentIntent,
  EvidenceItem,
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings,
  ScoreVideoOptions,
  ScoreBreakdown,
  SignalResult,
  SkipMode,
  UserPreferenceRules
} from "./types.ts";
