import type {
  ExtractedShort,
  OrislopSettings,
  SourceVerificationSummary,
  VerificationStatus
} from "../../../shared/src/types.ts";
import { inferContentIntent } from "../policy/contentIntent.ts";

const HIGH_RISK_CATEGORIES = new Set([
  "scammy",
  "scam_finance",
  "risky_educational",
  "miracle_health_claim",
  "high_risk_unsupported_claim",
  "unsupported_claims",
  "unsupported_claim",
  "serious_claim"
]);

export type MockSourceResult = {
  host: string;
  stance: "supports" | "contradicts" | "mixed" | "unclear";
};

export function shouldAutoVerifyClaim(
  short: ExtractedShort,
  categories: string[],
  settings: OrislopSettings
): boolean {
  if (!settings.enableClaimVerification || !settings.autoVerifyHighRiskClaims) {
    return false;
  }

  const intent = inferContentIntent(short);
  const highRiskIntent = intent === "health_advice"
    || intent === "finance_advice"
    || intent === "legal_advice"
    || intent === "political_claim"
    || intent === "news_current_events"
    || intent === "science_claim"
    || intent === "history_claim"
    || intent === "scam_promo";

  return highRiskIntent || categories.some((category) => HIGH_RISK_CATEGORIES.has(category));
}

export function buildVerificationQuery(short: ExtractedShort): string | null {
  const title = cleanText(short.title ?? "");
  const description = cleanText(short.description ?? "");
  const visibleText = cleanText(short.visiblePageText ?? "");
  const basis = title || description || visibleText;

  if (!basis) {
    return null;
  }

  const claimWords = basis
    .replace(/#[\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 14)
    .join(" ");

  return claimWords ? `${claimWords} source evidence` : null;
}

export function sourceVerificationSummaryForScore(
  short: ExtractedShort,
  categories: string[],
  settings: OrislopSettings,
  checkedAt: string | null = null
): SourceVerificationSummary {
  const query = buildVerificationQuery(short);

  if (!settings.enableClaimVerification) {
    return emptySummary("not_checked", query, checkedAt, ["Source verification is disabled."]);
  }

  if (!query) {
    return emptySummary("unavailable", null, checkedAt, ["Not enough extracted text to build a verification query."]);
  }

  if (!shouldAutoVerifyClaim(short, categories, settings)) {
    return emptySummary("not_checked", query, checkedAt, ["No high-risk factual claim signal required source checking."]);
  }

  return emptySummary("unavailable", query, checkedAt, [
    "High-risk claim detected, but no production source verifier is connected. A manual verification query is ready."
  ]);
}

export function summarizeMockSourceResults(
  query: string,
  sources: MockSourceResult[],
  checkedAt: string
): SourceVerificationSummary {
  if (sources.length === 0) {
    return emptySummary("not_enough_evidence", query, checkedAt, ["No source results were available."]);
  }

  const supports = sources.filter((source) => source.stance === "supports").length;
  const contradicts = sources.filter((source) => source.stance === "contradicts").length;
  const mixed = sources.filter((source) => source.stance === "mixed").length;
  let status: VerificationStatus = "not_enough_evidence";

  if (supports >= 2 && contradicts === 0 && mixed === 0) {
    status = "corroborated";
  } else if (contradicts >= 2 && supports === 0) {
    status = "contradicted";
  } else if (supports > 0 || contradicts > 0 || mixed > 0) {
    status = "mixed";
  }

  return {
    status,
    query,
    checkedAt,
    sourceCount: sources.length,
    sourceHosts: Array.from(new Set(sources.map((source) => source.host))).slice(0, 8),
    notes: [`Mock source check returned ${supports} supporting, ${contradicts} contradicting, and ${mixed} mixed sources.`]
  };
}

function emptySummary(
  status: VerificationStatus,
  query: string | null,
  checkedAt: string | null,
  notes: string[]
): SourceVerificationSummary {
  return {
    status,
    query,
    checkedAt,
    sourceCount: 0,
    sourceHosts: [],
    notes
  };
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
