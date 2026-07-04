import type { CalibrationRecord } from "../../../storage/src/types.ts";
import type {
  CalibrationUserLabel,
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../shared/src/types.ts";
import { scoreVideo } from "../scoreVideo.ts";

export type CalibrationDisagreement = {
  id: string;
  videoId: string | null;
  title: string | null;
  userLabel: CalibrationUserLabel;
  predictedLabel: "slop" | "not_slop" | "claim_risk" | "ai_generated" | "unclear";
  action: OrislopScoreResult["action"];
  skipProbability: number;
  topReasons: string[];
};

export type CalibrationEvaluationReport = {
  totalLabels: number;
  evaluatedSlopVsNotSlop: number;
  slopVsNotSlop: {
    truePositives: number;
    trueNegatives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number | null;
    recall: number | null;
  };
  labelCounts: Record<CalibrationUserLabel, number>;
  disagreements: CalibrationDisagreement[];
  suggestedAdjustments: string[];
};

export function evaluateCalibrationRecords(
  records: CalibrationRecord[],
  settings?: Partial<OrislopSettings>
): CalibrationEvaluationReport {
  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let evaluatedSlopVsNotSlop = 0;
  const labelCounts: Record<CalibrationUserLabel, number> = {
    slop: 0,
    not_slop: 0,
    unclear: 0,
    ai_generated: 0,
    claim_risk: 0
  };
  const disagreements: CalibrationDisagreement[] = [];

  for (const record of records) {
    labelCounts[record.userLabel] += 1;
    const result = scoreVideo(shortFromCalibrationRecord(record), settings);
    const predictedLabel = predictedLabelFromScore(result);
    const positivePrediction = predictedLabel === "slop" || predictedLabel === "ai_generated";

    if (record.userLabel === "slop" || record.userLabel === "not_slop") {
      evaluatedSlopVsNotSlop += 1;
      if (record.userLabel === "slop" && positivePrediction) {
        truePositives += 1;
      } else if (record.userLabel === "slop") {
        falseNegatives += 1;
        disagreements.push(disagreement(record, result, predictedLabel));
      } else if (record.userLabel === "not_slop" && positivePrediction) {
        falsePositives += 1;
        disagreements.push(disagreement(record, result, predictedLabel));
      } else {
        trueNegatives += 1;
      }
    } else if (record.userLabel !== predictedLabel && shouldTrackSpecialDisagreement(record.userLabel, predictedLabel)) {
      disagreements.push(disagreement(record, result, predictedLabel));
    }
  }

  return {
    totalLabels: records.length,
    evaluatedSlopVsNotSlop,
    slopVsNotSlop: {
      truePositives,
      trueNegatives,
      falsePositives,
      falseNegatives,
      precision: ratioOrNull(truePositives, truePositives + falsePositives),
      recall: ratioOrNull(truePositives, truePositives + falseNegatives)
    },
    labelCounts,
    disagreements,
    suggestedAdjustments: suggestedAdjustments(falsePositives, falseNegatives, disagreements)
  };
}

export function formatCalibrationReport(report: CalibrationEvaluationReport): string {
  const precision = report.slopVsNotSlop.precision === null
    ? "n/a"
    : `${Math.round(report.slopVsNotSlop.precision * 100)}%`;
  const recall = report.slopVsNotSlop.recall === null
    ? "n/a"
    : `${Math.round(report.slopVsNotSlop.recall * 100)}%`;
  const lines = [
    `Total labels: ${report.totalLabels}`,
    `Evaluated slop/not_slop labels: ${report.evaluatedSlopVsNotSlop}`,
    `True positives: ${report.slopVsNotSlop.truePositives}`,
    `True negatives: ${report.slopVsNotSlop.trueNegatives}`,
    `False positives: ${report.slopVsNotSlop.falsePositives}`,
    `False negatives: ${report.slopVsNotSlop.falseNegatives}`,
    `Precision-ish: ${precision}`,
    `Recall-ish: ${recall}`,
    `Disagreements: ${report.disagreements.length}`
  ];

  if (report.suggestedAdjustments.length > 0) {
    lines.push("Suggested adjustments:");
    lines.push(...report.suggestedAdjustments.map((suggestion) => `- ${suggestion}`));
  }

  return lines.join("\n");
}

function shortFromCalibrationRecord(record: CalibrationRecord): ExtractedShort {
  return {
    url: record.url,
    videoId: record.videoId,
    title: record.title,
    channelName: record.channelName,
    channelUrl: record.channelUrl,
    description: null,
    hashtags: record.hashtags,
    visiblePageText: record.visiblePageText,
    hasPlatformAiLabel: record.scoreResult.categories.includes("platform_ai_labeled")
      || record.scoreResult.categories.includes("ai_labeled"),
    platformAiLabelText: null,
    transcript: null,
    communityReactionSummary: record.communityReactionSummary
  };
}

function predictedLabelFromScore(result: OrislopScoreResult): CalibrationDisagreement["predictedLabel"] {
  if (result.claimRiskScore >= 0.6 && result.categories.some((category) => (
    category === "scammy"
    || category === "scam_finance"
    || category === "miracle_health_claim"
    || category === "high_risk_unsupported_claim"
    || category === "risky_educational"
  ))) {
    return "claim_risk";
  }

  if ((result.aiGeneratedScore ?? 0) >= 0.6 || result.categories.includes("possible_unlabeled_ai")) {
    return "ai_generated";
  }

  if (result.action === "skip" || result.action === "warn" || result.action === "pre_skip") {
    return "slop";
  }

  return "not_slop";
}

function disagreement(
  record: CalibrationRecord,
  result: OrislopScoreResult,
  predictedLabel: CalibrationDisagreement["predictedLabel"]
): CalibrationDisagreement {
  return {
    id: record.id,
    videoId: record.videoId,
    title: record.title,
    userLabel: record.userLabel,
    predictedLabel,
    action: result.action,
    skipProbability: result.skipProbability,
    topReasons: result.evidence.slice(0, 4).map((item) => item.label)
  };
}

function shouldTrackSpecialDisagreement(
  userLabel: CalibrationUserLabel,
  predictedLabel: CalibrationDisagreement["predictedLabel"]
): boolean {
  if (userLabel === "unclear") {
    return false;
  }

  return userLabel !== predictedLabel;
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function suggestedAdjustments(
  falsePositives: number,
  falseNegatives: number,
  disagreements: CalibrationDisagreement[]
): string[] {
  const suggestions: string[] = [];

  if (falseNegatives > falsePositives) {
    suggestions.push("Consider testing the strict profile or slightly increasing template/TTS/repost weights.");
  }

  if (falsePositives > falseNegatives) {
    suggestions.push("Consider testing the lenient profile or raising the skip threshold for template/engagement categories.");
  }

  if (disagreements.some((item) => item.userLabel === "claim_risk" && item.predictedLabel !== "claim_risk")) {
    suggestions.push("Review finance/health claim-risk phrases; some user-labeled claim-risk examples are not being separated from generic slop.");
  }

  if (suggestions.length === 0 && disagreements.length === 0) {
    suggestions.push("No threshold adjustment suggested from the current labeled sample.");
  }

  return suggestions;
}
