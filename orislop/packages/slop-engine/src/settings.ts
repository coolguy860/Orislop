import { DEFAULT_ORISLOP_SETTINGS } from "../../shared/src/constants.ts";
import { clamp } from "../../shared/src/clamp.ts";
import type { OrislopSettings } from "../../shared/src/types.ts";

export const defaultSettings: OrislopSettings = DEFAULT_ORISLOP_SETTINGS;

export function normalizeSettings(settings?: Partial<OrislopSettings>): OrislopSettings {
  const merged: OrislopSettings = {
    ...DEFAULT_ORISLOP_SETTINGS,
    ...settings
  };
  const rawStrictness = (settings as Record<string, unknown> | undefined)?.strictness;
  const strictness = rawStrictness === "medium"
    ? "balanced"
    : merged.strictness;

  return {
    ...merged,
    strictness,
    maxConsecutiveSkips: Math.round(clamp(merged.maxConsecutiveSkips, 0, 25)),
    lookaheadCount: Math.round(clamp(merged.lookaheadCount, 0, 10)),
    communitySignalWeight: clamp(merged.communitySignalWeight, 0, 1),
    maxVisibleCommentsToInspect: Math.round(clamp(merged.maxVisibleCommentsToInspect, 0, 50)),
    deepScanMaxRuntimeMs: Math.round(clamp(merged.deepScanMaxRuntimeMs, 250, 30000))
  };
}
