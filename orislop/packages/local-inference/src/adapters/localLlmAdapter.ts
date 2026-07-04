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

export function createLocalLlmAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "local_llm",
    kind: "local_llm",
    ...config
  });

  return {
    id: normalized.id,
    kind: normalized.kind,
    config: normalized,
    async analyze(_request: LocalInferenceRequest) {
      const started = Date.now();
      return ensureEnabled(normalized, started)
        ?? requireReadablePath(normalized, "modelPath", "Local LLM model path", started)
        ?? unavailableAdapterResult(
          normalized,
          "Local LLM adapter has no local inference runtime wired in Phase 9.",
          started,
          "Local LLM adapter is not runnable yet."
        );
    }
  };
}
