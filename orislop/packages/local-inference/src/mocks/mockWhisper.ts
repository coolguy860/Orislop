import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockWhisperAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_whisper",
    kind: "whisper",
    enabled: true,
    mode: "mock",
    ...config
  });

  return {
    id: normalized.id,
    kind: normalized.kind,
    config: normalized,
    async analyze(request) {
      const started = Date.now();
      const transcriptLike = request.short.transcript ?? request.short.visiblePageText;
      const ttsStory = /ask reddit|aita|story time|part \d+/i.test(transcriptLike);
      return availableAdapterResult({
        config: normalized,
        score: ttsStory ? 0.74 : 0.19,
        confidence: 0.64,
        categories: ttsStory ? ["reddit_tts_story"] : [],
        evidence: ttsStory
          ? [evidenceForAdapter({
            reasonId: "mock_whisper_tts_story",
            label: "Mock Whisper transcript",
            detail: "Mock transcript contains common TTS story phrasing.",
            weight: 0.5,
            confidence: 0.64,
            source: "whisper"
          })]
          : [],
        reason: ttsStory ? "Mock Whisper found TTS story phrasing." : "Mock Whisper found no TTS story phrasing.",
        started
      });
    }
  };
}
