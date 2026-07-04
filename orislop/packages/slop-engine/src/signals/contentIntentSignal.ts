import type { ContentIntent, EvidenceItem, ExtractedShort, SignalResult } from "../../../shared/src/types.ts";
import {
  comedySatireScore,
  factualIntentScore,
  inferContentIntent
} from "../policy/contentIntent.ts";

export function contentIntentSignal(short: ExtractedShort): SignalResult {
  const started = Date.now();
  const intent = inferContentIntent(short);
  const categories = categoriesForIntent(intent);
  const score = scoreForIntent(intent);
  const evidence: EvidenceItem[] = [{
    reasonId: `content_intent_${intent}`,
    label: "Content intent",
    detail: intent,
    weight: score,
    confidence: confidenceForIntent(intent),
    source: "metadata_transcript_rules"
  }];

  return {
    name: "content_intent",
    score,
    confidence: confidenceForIntent(intent),
    applicable: true,
    categories,
    evidence,
    reason: `Classified content intent as ${intent}.`,
    runtimeMs: Date.now() - started,
    error: null
  };
}

function categoriesForIntent(intent: ContentIntent): string[] {
  switch (intent) {
    case "comedy_satire":
      return ["entertainment_safe", "comedy_satire"];
    case "normal_entertainment":
    case "fiction_story":
      return ["entertainment_safe", "normal_entertainment"];
    case "serious_education":
      return ["high_value_content"];
    case "scam_promo":
      return ["scammy", "serious_claim"];
    case "health_advice":
      return ["risky_educational", "serious_claim"];
    case "finance_advice":
    case "legal_advice":
    case "political_claim":
    case "science_claim":
    case "history_claim":
    case "news_current_events":
      return ["serious_claim"];
    default:
      return [];
  }
}

function scoreForIntent(intent: ContentIntent): number {
  if (intent === "scam_promo") {
    return 0.72;
  }

  if (intent === "health_advice") {
    return 0.58;
  }

  return Math.max(0.1, factualIntentScore(intent), comedySatireScore(intent) * 0.2);
}

function confidenceForIntent(intent: ContentIntent): number {
  return intent === "unknown" ? 0.3 : 0.68;
}
