import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockOpenClipAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_openclip",
    kind: "openclip",
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
      const text = `${request.short.title ?? ""} ${request.short.visiblePageText}`;
      const visualTemplate = /minecraft|subway surfers|gameplay|split screen/i.test(text);
      return availableAdapterResult({
        config: normalized,
        score: visualTemplate ? 0.83 : 0.18,
        confidence: 0.72,
        categories: visualTemplate ? ["template_brainrot", "repost_like"] : [],
        evidence: visualTemplate
          ? [evidenceForAdapter({
            reasonId: "mock_openclip_visual_template",
            label: "Mock visual template",
            detail: "Mock OpenCLIP matched common background-gameplay Shorts visuals.",
            weight: 0.6,
            confidence: 0.72,
            source: "openclip"
          })]
          : [],
        reason: visualTemplate ? "Mock OpenCLIP found a visual template." : "Mock OpenCLIP found no visual template.",
        started
      });
    }
  };
}
