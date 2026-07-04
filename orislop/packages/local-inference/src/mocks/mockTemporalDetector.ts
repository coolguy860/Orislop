import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockTemporalDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_temporal_detector",
    kind: "temporal_detector",
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
      const possibleTemporalAi = /deepfake|face swap|synthetic motion|generated video/i.test(`${request.short.title ?? ""} ${request.short.visiblePageText}`);
      return availableAdapterResult({
        config: normalized,
        score: possibleTemporalAi ? 0.9 : 0.28,
        confidence: 0.8,
        categories: possibleTemporalAi ? ["possible_unlabeled_ai"] : [],
        evidence: possibleTemporalAi
          ? [evidenceForAdapter({
            reasonId: "mock_temporal_possible_ai",
            label: "Mock temporal detector",
            detail: "Mock temporal detector indicated possible generated or manipulated video motion.",
            weight: 0.75,
            confidence: 0.8,
            source: "temporal_detector"
          })]
          : [],
        reason: possibleTemporalAi ? "Mock temporal detector found possible generated video motion." : "Mock temporal detector found no temporal AI signal.",
        started
      });
    }
  };
}
