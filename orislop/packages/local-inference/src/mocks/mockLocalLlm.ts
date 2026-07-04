import type {
  AdapterConfig,
  LocalModelAdapter
} from "../types.ts";
import {
  availableAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig
} from "../adapters/adapterUtils.ts";

export function createMockLocalLlmAdapter(config: Partial<AdapterConfig> = {}): LocalModelAdapter {
  const normalized = normalizeAdapterConfig({
    id: "mock_local_llm",
    kind: "local_llm",
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
      const highRiskClaim = /miracle|guaranteed|secret cure|double your money/i.test(request.short.visiblePageText);
      return availableAdapterResult({
        config: normalized,
        score: highRiskClaim ? 0.86 : 0.25,
        confidence: 0.74,
        categories: highRiskClaim ? ["high_risk_unsupported_claim"] : [],
        evidence: highRiskClaim
          ? [evidenceForAdapter({
            reasonId: "mock_llm_high_risk_claim",
            label: "Mock claim-risk classifier",
            detail: "Mock local LLM found high-risk unsupported-claim language.",
            weight: 0.65,
            confidence: 0.74,
            source: "local_llm"
          })]
          : [],
        reason: highRiskClaim ? "Mock local LLM found a high-risk claim." : "Mock local LLM found no high-risk claim.",
        started
      });
    }
  };
}
