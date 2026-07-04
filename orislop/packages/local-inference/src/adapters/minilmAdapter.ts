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

export function createMiniLmAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "minilm",
    kind: "embedding",
    ...config
  });

  return {
    id: normalized.id,
    kind: normalized.kind,
    config: normalized,
    async analyze(_request: LocalInferenceRequest) {
      const started = Date.now();
      return ensureEnabled(normalized, started)
        ?? requireReadablePath(normalized, "modelPath", "MiniLM model path", started)
        ?? unavailableAdapterResult(
          normalized,
          "MiniLM adapter has no local inference runtime wired in Phase 9.",
          started,
          "Embedding adapter is not runnable yet."
        );
    }
  };
}
