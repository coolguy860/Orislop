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

export function createSpatialDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "spatial_detector",
    kind: "spatial_detector",
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

      if (!request.mediaPath && !request.framePaths?.length && !request.framesDirectory) {
        return unavailableAdapterResult(normalized, "Spatial detector requires local media or frames.", started, "No detector input was provided.");
      }

      return requireReadablePath(normalized, "scriptPath", "Spatial detector script path", started)
        ?? requireAnyReadablePath(normalized, ["modelPath", "checkpointPath"], "Spatial detector model/checkpoint path", started)
        ?? unavailableAdapterResult(
          normalized,
          "Spatial detector is preserved behind an optional wrapper and has no safe JSON subprocess entrypoint configured in Phase 9.",
          started,
          "Spatial detector wrapper is not runnable yet."
        );
    }
  };
}
