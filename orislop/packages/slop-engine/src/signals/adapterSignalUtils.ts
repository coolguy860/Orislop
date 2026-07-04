import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { SignalResult } from "../../../shared/src/types.ts";

export function adapterResultToSignal(input: {
  name: string;
  result: LocalInferenceResult;
  enabled: boolean;
  disabledReason: string;
  defaultCategories?: string[];
}): SignalResult {
  const { result } = input;

  if (!input.enabled) {
    return {
      name: input.name,
      score: null,
      confidence: 0,
      applicable: false,
      categories: [],
      evidence: [],
      reason: input.disabledReason,
      runtimeMs: result.runtimeMs,
      error: null
    };
  }

  if (!result.applicable || result.score === null) {
    return {
      name: input.name,
      score: null,
      confidence: 0,
      applicable: false,
      categories: [],
      evidence: [],
      reason: result.reason,
      runtimeMs: result.runtimeMs,
      error: result.error
    };
  }

  return {
    name: input.name,
    score: result.score,
    confidence: result.confidence,
    applicable: true,
    categories: result.categories.length > 0 ? result.categories : (input.defaultCategories ?? []),
    evidence: result.evidence,
    reason: result.reason,
    runtimeMs: result.runtimeMs,
    error: result.error
  };
}
