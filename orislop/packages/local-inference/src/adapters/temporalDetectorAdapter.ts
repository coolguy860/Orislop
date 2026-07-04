import type {
  AdapterConfig,
  LocalInferenceRequest,
  LocalModelAdapter
} from "../types.ts";
import {
  ensureEnabled,
  normalizeAdapterConfig,
  requireAllCheckpointPaths,
  requireFilesUnderRoot,
  requireReadablePath,
  unavailableAdapterResult
} from "./adapterUtils.ts";

export function createTemporalDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "temporal_detector",
    kind: "temporal_detector",
    mode: "subprocess",
    requiredFiles: [
      "temporal_deepfake_moe_hf_colab.py",
      "final_pipeline_core.py",
      "full_pipeline_utils.py"
    ],
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

      if (!request.mediaPath) {
        return unavailableAdapterResult(normalized, "Temporal detector requires a local media path.", started, "No video input was provided.");
      }

      return requireFilesUnderRoot(normalized, started)
        ?? requireReadablePath(normalized, "scriptPath", "Temporal detector script path", started, normalized.detectorRoot)
        ?? requireAllCheckpointPaths(normalized, started, normalized.detectorRoot)
        ?? unavailableAdapterResult(
          normalized,
          "Temporal detector has no safe JSON subprocess entrypoint configured in Phase 9.",
          started,
          "Temporal detector wrapper is not runnable yet."
        );
    }
  };
}
