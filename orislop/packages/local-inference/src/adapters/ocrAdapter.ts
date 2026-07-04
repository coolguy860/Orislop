import type {
  AdapterConfig,
  LocalInferenceRequest,
  LocalModelAdapter
} from "../types.ts";
import {
  ensureEnabled,
  normalizeAdapterConfig,
  unavailableAdapterResult
} from "./adapterUtils.ts";

export function createOcrAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "ocr",
    kind: "ocr",
    ...config
  });

  return {
    id: normalized.id,
    kind: normalized.kind,
    config: normalized,
    async analyze(request: LocalInferenceRequest) {
      const started = Date.now();
      const disabled = ensureEnabled(normalized, started);
      if (disabled) {
        return disabled;
      }

      if (!request.framePaths?.length && !request.framesDirectory) {
        return unavailableAdapterResult(normalized, "OCR requires configured local frames.", started, "No frame input was provided.");
      }

      return unavailableAdapterResult(
          normalized,
          "OCR adapter has no local OCR runtime wired in Phase 9.",
          started,
          "OCR adapter is not runnable yet."
        );
    }
  };
}
