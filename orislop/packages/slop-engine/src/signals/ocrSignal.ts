import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function ocrSignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "ocr",
    result,
    enabled: settings.enableOcr,
    disabledReason: "OCR adapter is disabled.",
    defaultCategories: ["fake_text_story"]
  });
}
