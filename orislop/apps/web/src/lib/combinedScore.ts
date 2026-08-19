import {
  inputFromHeuristic,
  runAiClassifier,
  type AiClassifierInput,
  type AiClassifierResult
} from "./aiClassifier";
import type { StaticScoreResult } from "./staticSlopScore";

export type OptionalDetectorScore = {
  available: boolean;
  score: number | null;
  reason: string;
};

export type CombinedScoreInput = AiClassifierInput & {
  heuristic: StaticScoreResult;
  aiClassifier?: AiClassifierResult | null;
  spatiotemporalScore?: OptionalDetectorScore | null;
};

export type CombinedScoreResult = StaticScoreResult & {
  heuristicResult: StaticScoreResult;
  aiClassifier: AiClassifierResult;
  finalScore: number;
  verdict: "Watch" | "Questionable" | "Skip";
  sourceScores: {
    heuristic: number;
    aiClassifier: number | null;
    transcript: number | null;
    channelRisk: number;
    spatiotemporal: number | null;
  };
  explanationBreakdown: Array<{
    source: string;
    score: number | null;
    weight: number;
    used: boolean;
    reason: string;
  }>;
  aiClassifierUsed: boolean;
  spatiotemporalUsed: boolean;
  fallbackReasons: string[];
};

const THRESHOLDS = {
  questionable: 30,
  skip: 60
};

export function scoreWithAiClassifier(input: CombinedScoreInput): CombinedScoreResult {
  const aiClassifier = input.aiClassifier ?? runAiClassifier(inputFromHeuristic(input, input.heuristic));
  const transcriptScore = scoreTranscript(input.transcript ?? "");
  const channelRiskScore = scoreChannelRisk(input.channelName ?? "");
  const spatiotemporal = input.spatiotemporalScore ?? null;
  const aiClassifierUsed = aiClassifier.available;
  const spatiotemporalUsed = Boolean(spatiotemporal?.available && spatiotemporal.score !== null);

  const fallbackReasons: string[] = [];
  if (!aiClassifierUsed) {
    fallbackReasons.push(aiClassifier.reason);
  }
  if (!spatiotemporalUsed) {
    fallbackReasons.push(spatiotemporal?.reason ?? "Spatiotemporal detector was not run in this browser/static path.");
  }
  if (transcriptScore === null) {
    fallbackReasons.push("Transcript score unavailable because no transcript text was provided.");
  }

  const weighted = combineScores({
    heuristic: input.heuristic.score,
    aiClassifier: aiClassifierUsed ? aiClassifier.score : null,
    transcript: transcriptScore,
    channelRisk: channelRiskScore,
    spatiotemporal: spatiotemporalUsed ? spatiotemporal?.score ?? null : null
  });

  const finalScore = clampScore(weighted.score);
  const recommendation = finalScore >= THRESHOLDS.skip
    ? "skip"
    : finalScore >= THRESHOLDS.questionable
      ? "questionable"
      : "watch";
  const reasons = buildReasons(input.heuristic, aiClassifier, weighted.breakdown, fallbackReasons);
  const confidence = confidenceFor(input.heuristic, aiClassifier, finalScore);

  return {
    ...input.heuristic,
    score: finalScore,
    finalScore,
    recommendation,
    verdict: verdictLabel(recommendation),
    reasons,
    confidence,
    heuristicResult: input.heuristic,
    aiClassifier,
    sourceScores: {
      heuristic: input.heuristic.score,
      aiClassifier: aiClassifierUsed ? aiClassifier.score : null,
      transcript: transcriptScore,
      channelRisk: channelRiskScore,
      spatiotemporal: spatiotemporalUsed ? spatiotemporal?.score ?? null : null
    },
    explanationBreakdown: weighted.breakdown,
    aiClassifierUsed,
    spatiotemporalUsed,
    fallbackReasons
  };
}

function combineScores(scores: {
  heuristic: number;
  aiClassifier: number | null;
  transcript: number | null;
  channelRisk: number;
  spatiotemporal: number | null;
}): {
  score: number;
  breakdown: CombinedScoreResult["explanationBreakdown"];
} {
  const hasAi = scores.aiClassifier !== null;
  const hasTranscript = scores.transcript !== null;
  const hasSpatiotemporal = scores.spatiotemporal !== null;
  const weights = hasSpatiotemporal
    ? {
      heuristic: 0.25,
      aiClassifier: 0.35,
      transcript: 0.15,
      channelRisk: 0.0,
      spatiotemporal: 0.25
    }
    : {
      heuristic: 0.35,
      aiClassifier: 0.45,
      transcript: 0.15,
      channelRisk: 0.05,
      spatiotemporal: 0
    };

  if (!hasAi) {
    weights.heuristic += weights.aiClassifier;
    weights.aiClassifier = 0;
  }
  if (!hasTranscript) {
    weights.heuristic += weights.transcript;
    weights.transcript = 0;
  }

  const entries = [
    ["Heuristic rules", scores.heuristic, weights.heuristic, true, "Existing explainable rule score."],
    ["AI classifier v1", scores.aiClassifier, weights.aiClassifier, hasAi, hasAi ? "Local TF-IDF logistic classifier score." : "AI classifier unavailable."],
    ["Transcript", scores.transcript, weights.transcript, hasTranscript, hasTranscript ? "Transcript text contributed extra evidence." : "No transcript text was available."],
    ["Channel risk", scores.channelRisk, weights.channelRisk, weights.channelRisk > 0, "Lightweight channel-name risk cues."],
    ["Spatiotemporal", scores.spatiotemporal, weights.spatiotemporal, hasSpatiotemporal, hasSpatiotemporal ? "Optional video-level detector score." : "Not run in this path."]
  ] as const;

  const score = entries.reduce((sum, [, sourceScore, weight]) => sum + (sourceScore ?? 0) * weight, 0);
  return {
    score,
    breakdown: entries.map(([source, sourceScore, weight, used, reason]) => ({
      source,
      score: sourceScore,
      weight,
      used,
      reason
    }))
  };
}

function scoreTranscript(transcript: string): number | null {
  const text = transcript.toLowerCase().trim();
  if (text.length < 24) {
    return null;
  }

  let score = 0;
  if (/\b(ai voice|text to speech|tts|robot voice|synthetic voice)\b/.test(text)) {
    score += 35;
  }
  if (/\b(reddit|aita|storytime|askreddit)\b/.test(text)) {
    score += 22;
  }
  if (/\b(guaranteed|miracle|doctors hate|banks hate|secret trick|make money fast)\b/.test(text)) {
    score += 34;
  }
  if (hasRepeatedPhrases(text)) {
    score += 16;
  }

  return clampScore(score);
}

function scoreChannelRisk(channelName: string): number {
  const text = channelName.toLowerCase();
  let score = 0;
  if (/\b(bot|repost|vault|clips|compilation|viral loop|story bot|shortcut|secret)\b/.test(text)) {
    score += 45;
  }
  if (/\b(lab|class|tutor|science|history|repair|kitchen|studio|notes)\b/.test(text)) {
    score -= 24;
  }
  return clampScore(score);
}

function hasRepeatedPhrases(text: string): boolean {
  const words = text.match(/[a-z0-9']+/g) ?? [];
  if (words.length < 18) {
    return false;
  }
  const seen = new Map<string, number>();
  for (let index = 0; index < words.length - 2; index += 1) {
    const phrase = `${words[index]} ${words[index + 1]} ${words[index + 2]}`;
    seen.set(phrase, (seen.get(phrase) ?? 0) + 1);
  }
  return Array.from(seen.values()).some((count) => count >= 3);
}

function buildReasons(
  heuristic: StaticScoreResult,
  aiClassifier: AiClassifierResult,
  breakdown: CombinedScoreResult["explanationBreakdown"],
  fallbackReasons: string[]
): string[] {
  const reasons = [
    ...heuristic.reasons.filter((reason) => reason !== "No strong static slop signals found").slice(0, 3)
  ];
  if (aiClassifier.available) {
    reasons.push(`AI classifier: ${aiClassifier.predictedLabel} (${aiClassifier.score}/100)`);
    for (const feature of aiClassifier.topFeatures.slice(0, 2)) {
      reasons.push(`AI feature: ${feature.term} ${feature.contribution >= 0 ? "+" : ""}${feature.contribution}`);
    }
  }
  const transcript = breakdown.find((item) => item.source === "Transcript");
  if (transcript?.used && transcript.score !== null && transcript.score > 0) {
    reasons.push(`Transcript signal: ${transcript.score}/100`);
  }
  if (reasons.length === 0) {
    reasons.push("No strong combined slop signals found");
  }
  if (!aiClassifier.available || fallbackReasons.length > 0) {
    reasons.push(...fallbackReasons.slice(0, 2));
  }
  return reasons;
}

function confidenceFor(
  heuristic: StaticScoreResult,
  aiClassifier: AiClassifierResult,
  finalScore: number
): "low" | "medium" | "high" {
  const agreeingHigh = heuristic.score >= 60 && aiClassifier.available && aiClassifier.score >= 60;
  const agreeingLow = heuristic.score < 30 && aiClassifier.available && aiClassifier.score < 30;
  if ((agreeingHigh || agreeingLow) && Math.abs(finalScore - 45) >= 25) {
    return "high";
  }
  if (aiClassifier.available && aiClassifier.confidence !== "low") {
    return "medium";
  }
  return heuristic.confidence;
}

function verdictLabel(recommendation: StaticScoreResult["recommendation"]): "Watch" | "Questionable" | "Skip" {
  switch (recommendation) {
    case "skip":
      return "Skip";
    case "questionable":
      return "Questionable";
    default:
      return "Watch";
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
