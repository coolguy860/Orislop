import type { EvidenceItem, ExtractedShort, SignalResult } from "../../../shared/src/types.ts";
import type { UserPreferenceRules } from "../types.ts";

export function userPreferenceSignal(
  short: ExtractedShort,
  preferences: UserPreferenceRules | undefined,
  observedCategories: string[]
): SignalResult {
  const started = Date.now();

  if (!preferences) {
    return unavailable(started, "No user preference rules were provided.");
  }

  const channelFields = [short.channelName, short.channelUrl]
    .filter((value): value is string => Boolean(value))
    .map(normalize);

  const allowMatch = preferences.alwaysAllowChannels?.find((channel) => channelFields.includes(normalize(channel)));
  if (allowMatch) {
    return preferenceResult(
      started,
      "user_preference_always_allow_channel",
      "Always allow channel",
      allowMatch,
      ["high_value_content"],
      0,
      "allow"
    );
  }

  const blockMatch = preferences.alwaysBlockChannels?.find((channel) => channelFields.includes(normalize(channel)));
  if (blockMatch) {
    return preferenceResult(
      started,
      "user_preference_always_block_channel",
      "Always block channel",
      blockMatch,
      ["user_blocked"],
      1,
      "block"
    );
  }

  const blockedCategory = preferences.alwaysBlockCategories?.find((category) => observedCategories.includes(category));
  if (blockedCategory) {
    return preferenceResult(
      started,
      "user_preference_always_block_category",
      "Always block category",
      blockedCategory,
      [blockedCategory],
      1,
      "block"
    );
  }

  return unavailable(started, "No user preference rule matched.");
}

function preferenceResult(
  started: number,
  reasonId: string,
  label: string,
  detail: string,
  categories: string[],
  score: number,
  source: "allow" | "block"
): SignalResult {
  const evidence: EvidenceItem = {
    reasonId,
    label,
    detail,
    weight: score,
    confidence: 1,
    source: `user_preference_${source}`
  };

  return {
    name: "user_preference",
    score,
    confidence: 1,
    applicable: true,
    categories,
    evidence: [evidence],
    reason: `${label}: ${detail}`,
    runtimeMs: Date.now() - started,
    error: null
  };
}

function unavailable(started: number, reason: string): SignalResult {
  return {
    name: "user_preference",
    score: null,
    confidence: 0,
    applicable: false,
    categories: [],
    evidence: [],
    reason,
    runtimeMs: Date.now() - started,
    error: null
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
