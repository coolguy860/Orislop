import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockExistingAiDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_existing_ai_detector",
    kind: "existing_ai_detector",
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
      const possibleAi = /ai|synthetic|generated|sora|runway|kling/i.test(`${request.short.title ?? ""} ${request.short.visiblePageText}`);
      return availableAdapterResult({
        config: normalized,
        score: possibleAi ? 0.88 : 0.3,
        confidence: 0.78,
        categories: possibleAi ? ["possible_unlabeled_ai"] : [],
        evidence: possibleAi
          ? [evidenceForAdapter({
            reasonId: "mock_existing_ai_detector_possible_ai",
            label: "Mock existing AI detector",
            detail: "Mock existing detector indicated possible unlabeled AI content.",
            weight: 0.7,
            confidence: 0.78,
            source: "existing_ai_detector"
          })]
          : [],
        reason: possibleAi ? "Mock existing detector found possible AI content." : "Mock existing detector found no AI signal.",
        started
      });
    }
  };
}
