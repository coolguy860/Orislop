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

export function createWhisperAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "whisper",
    kind: "whisper",
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

      if (!request.audioPath && !request.mediaPath) {
        return unavailableAdapterResult(normalized, "Whisper requires a local audio or media path.", started, "No audio input was provided.");
      }

      return requireReadablePath(normalized, "modelPath", "Whisper model path", started)
        ?? unavailableAdapterResult(
          normalized,
          "Whisper adapter has no local transcription runtime wired in Phase 9.",
          started,
          "Whisper adapter is not runnable yet."
        );
    }
  };
}
