import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function existingAiDetectorSignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "existing_ai_detector",
    result,
    enabled: settings.enableExistingAiDetector,
    disabledReason: "Existing AI detector adapter is disabled.",
    defaultCategories: ["possible_unlabeled_ai"]
  });
}
