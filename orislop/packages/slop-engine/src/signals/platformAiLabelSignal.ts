import type { EvidenceItem, ExtractedShort, OrislopSettings, SignalResult } from "../../../shared/src/types.ts";

export function platformAiLabelSignal(
  short: ExtractedShort,
  settings: OrislopSettings
): SignalResult {
  const started = Date.now();

  if (!short.hasPlatformAiLabel) {
    return {
      name: "platform_ai_label",
      score: null,
      confidence: 0,
      applicable: false,
      categories: [],
      evidence: [],
      reason: "No platform AI label was detected.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  const labelText = short.platformAiLabelText ?? "The platform displayed an AI content label.";
  const evidence: EvidenceItem = {
    reasonId: "platform_ai_label",
    label: "Platform AI label",
    detail: labelText,
    weight: 1,
    confidence: 1,
    source: "youtube_page"
  };

  return {
    name: "platform_ai_label",
    score: settings.skipAllAiLabeled ? 1 : 0.4,
    confidence: 1,
    applicable: true,
    categories: ["ai_labeled"],
    evidence: [evidence],
    reason: "The platform labeled this content as AI-generated or altered.",
    runtimeMs: Date.now() - started,
    error: null
  };
}
