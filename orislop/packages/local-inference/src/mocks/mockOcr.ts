import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockOcrAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_ocr",
    kind: "ocr",
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
      const textStory = /text message|reddit|aita|storytime/i.test(request.short.visiblePageText);
      return availableAdapterResult({
        config: normalized,
        score: textStory ? 0.76 : 0.2,
        confidence: 0.68,
        categories: textStory ? ["fake_text_story", "reddit_tts_story"] : [],
        evidence: textStory
          ? [evidenceForAdapter({
            reasonId: "mock_ocr_text_story",
            label: "Mock OCR text story",
            detail: "Mock OCR found text-story style screen content.",
            weight: 0.55,
            confidence: 0.68,
            source: "ocr"
          })]
          : [],
        reason: textStory ? "Mock OCR found text-story content." : "Mock OCR found no text-story content.",
        started
      });
    }
  };
}
