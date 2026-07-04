import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function embeddingSimilaritySignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "embedding_similarity",
    result,
    enabled: settings.enableDeepScan,
    disabledReason: "Embedding similarity adapter is disabled.",
    defaultCategories: ["template_brainrot"]
  });
}
