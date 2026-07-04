import type { OrislopAction, OrislopSettings } from "../../shared/src/types.ts";
import { getStrictnessProfile, STRICTNESS_PROFILES } from "./calibration/strictnessProfiles.ts";

export type Strictness = OrislopSettings["strictness"];

export type StrictnessThresholds = {
  allowBelow: number;
  warnAt: number;
  skipAt: number;
};

export const STRICTNESS_THRESHOLDS: Record<Strictness, StrictnessThresholds> = {
  lenient: pickThresholds(STRICTNESS_PROFILES.lenient),
  balanced: pickThresholds(STRICTNESS_PROFILES.balanced),
  strict: pickThresholds(STRICTNESS_PROFILES.strict),
  nuclear: pickThresholds(STRICTNESS_PROFILES.nuclear)
};

export function getThresholds(strictness: Strictness | "medium" | unknown): StrictnessThresholds {
  return pickThresholds(getStrictnessProfile(strictness));
}

export function actionFromProbability(
  probability: number,
  settings: OrislopSettings
): OrislopAction {
  const thresholds = getThresholds(settings.strictness);

  if (probability < thresholds.warnAt) {
    return "allow";
  }

  if (probability < thresholds.skipAt) {
    return "warn";
  }

  if (!settings.autoSkip || settings.skipMode === "off" || settings.skipMode === "warn_only") {
    return "warn";
  }

  return "skip";
}

function pickThresholds(profile: StrictnessThresholds): StrictnessThresholds {
  return {
    allowBelow: profile.allowBelow,
    warnAt: profile.warnAt,
    skipAt: profile.skipAt
  };
}
