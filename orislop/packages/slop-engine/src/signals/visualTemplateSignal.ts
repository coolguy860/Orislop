import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function visualTemplateSignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "visual_template",
    result,
    enabled: settings.enableOpenClip || settings.enableDeepScan,
    disabledReason: "Visual template adapter is disabled.",
    defaultCategories: ["template_brainrot"]
  });
}
