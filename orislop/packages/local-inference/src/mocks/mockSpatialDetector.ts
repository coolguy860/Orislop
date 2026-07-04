import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockSpatialDetectorAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_spatial_detector",
    kind: "spatial_detector",
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
      const possibleAiVisual = /smooth animation|ai art|generated/i.test(`${request.short.title ?? ""} ${request.short.visiblePageText}`);
      return availableAdapterResult({
        config: normalized,
        score: possibleAiVisual ? 0.81 : 0.24,
        confidence: 0.69,
        categories: possibleAiVisual ? ["possible_unlabeled_ai"] : [],
        evidence: possibleAiVisual
          ? [evidenceForAdapter({
            reasonId: "mock_spatial_possible_ai",
            label: "Mock spatial detector",
            detail: "Mock spatial detector found possible generated visual patterns.",
            weight: 0.62,
            confidence: 0.69,
            source: "spatial_detector"
          })]
          : [],
        reason: possibleAiVisual ? "Mock spatial detector found possible generated visuals." : "Mock spatial detector found no AI visual signal.",
        started
      });
    }
  };
}
