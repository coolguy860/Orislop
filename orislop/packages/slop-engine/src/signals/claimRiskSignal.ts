import type { LocalInferenceResult } from "../../../local-inference/src/types.ts";
import type { OrislopSettings, SignalResult } from "../../../shared/src/types.ts";
import { adapterResultToSignal } from "./adapterSignalUtils.ts";

export function claimRiskSignal(
  result: LocalInferenceResult,
  settings: OrislopSettings
): SignalResult {
  return adapterResultToSignal({
    name: "claim_risk_adapter",
    result,
    enabled: settings.enableLocalLlm || settings.enableDeepScan,
    disabledReason: "Claim-risk adapter is disabled.",
    defaultCategories: ["high_risk_unsupported_claim"]
  });
}
