import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function temporalDetectorSignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "temporal_detector",
    result,
    enabled: settings.enableTemporalDetector,
    disabledReason: "Temporal detector adapter is disabled.",
    defaultCategories: ["possible_unlabeled_ai"]
  });
}
