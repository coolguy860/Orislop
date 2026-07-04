import type { SignalResult } from "../../shared/src/types";

export type {
  ContentIntent,
  CalibrationUserLabel,
  CommunityKeywordCategory,
  CommunityReactionStrength,
  CommunityReactionSummary,
  DeepScanStatus,
  EvidenceItem,
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings,
  SignalResult,
  SkipMode,
  SourceVerificationSummary,
  StrictnessProfile,
  VerificationStatus,
  YouTubeVideoKind
} from "../../shared/src/types.ts";

export type ScoreBreakdown = {
  slopScore: number;
  claimRiskScore: number;
  aiGeneratedScore: number | null;
  possibleUnlabeledAiScore: number | null;
  originalityRiskScore: number | null;
  skipProbability: number;
  confidence: number;
  categories: string[];
  settingsApplied: string[];
};

export type UserPreferenceRules = {
  alwaysAllowChannels?: string[];
  alwaysBlockChannels?: string[];
  alwaysBlockCategories?: string[];
};

export type ScoreVideoOptions = {
  userPreferences?: UserPreferenceRules;
  adapterSignals?: SignalResult[];
  createdAt?: string;
};
