import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockEmbeddingAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_embedding",
    kind: "embedding",
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
      const matchedTemplate = /reddit|text story|parkour|subway surfers/i.test(request.short.visiblePageText);
      return availableAdapterResult({
        config: normalized,
        score: matchedTemplate ? 0.78 : 0.22,
        confidence: 0.7,
        categories: matchedTemplate ? ["template_brainrot"] : [],
        evidence: matchedTemplate
          ? [evidenceForAdapter({
            reasonId: "mock_embedding_template_match",
            label: "Mock embedding template match",
            detail: "Mock embedding similarity matched a known repetitive Shorts format.",
            weight: 0.55,
            confidence: 0.7,
            source: "embedding"
          })]
          : [],
        reason: matchedTemplate ? "Mock embedding found a repetitive template." : "Mock embedding found no template match.",
        started
      });
    }
  };
}
