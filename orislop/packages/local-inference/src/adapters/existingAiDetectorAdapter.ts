import type {
  AdapterConfig,
  LocalInferenceRequest,
  LocalModelAdapter
} from "../types.ts";
import {
  ensureEnabled,
  normalizeAdapterConfig,
  requireAnyReadablePath,
  requireReadablePath,
  unavailableAdapterResult
} from "./adapterUtils.ts";

export function createExistingAiDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "existing_ai_detector",
    kind: "existing_ai_detector",
    mode: "subprocess",
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

      if (!request.mediaPath && !request.framePaths?.length) {
        return unavailableAdapterResult(normalized, "Existing AI detector requires local media or frames.", started, "No detector input was provided.");
      }

      return requireReadablePath(normalized, "scriptPath", "Existing AI detector script path", started)
        ?? requireAnyReadablePath(normalized, ["modelPath", "checkpointPath"], "Existing AI detector model/checkpoint path", started)
        ?? unavailableAdapterResult(
          normalized,
          "Existing AI detector has no safe JSON subprocess entrypoint configured in Phase 9.",
          started,
          "Existing AI detector wrapper is not runnable yet."
        );
    }
  };
}
