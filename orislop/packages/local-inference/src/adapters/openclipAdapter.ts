import type {
  AdapterConfig,
  LocalInferenceRequest,
  LocalModelAdapter
} from "../types.ts";
import {
  ensureEnabled,
  normalizeAdapterConfig,
  requireReadablePath,
  unavailableAdapterResult
} from "./adapterUtils.ts";

export function createOpenClipAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "openclip",
    kind: "openclip",
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
        return unavailableAdapterResult(normalized, "OpenCLIP requires configured local frames.", started, "No frame input was provided.");
      }

      return requireReadablePath(normalized, "modelPath", "OpenCLIP model path", started)
        ?? unavailableAdapterResult(
          normalized,
          "OpenCLIP adapter has no local inference runtime wired in Phase 9.",
          started,
          "Visual template adapter is not runnable yet."
        );
    }
  };
}
