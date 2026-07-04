import type { EvidenceItem, OrislopSettings, SignalResult } from "../../../shared/src/types.ts";

export type LocalOriginalityMatch = {
  videoId: string | null;
  url: string;
  title: string | null;
  channelName: string | null;
  similarity: number;
};

export function localOriginalitySignal(
  matches: LocalOriginalityMatch[],
  settings: OrislopSettings
): SignalResult {
  const started = Date.now();

  if (!settings.enableLocalOriginalityIndex) {
    return {
      name: "local_originality",
      score: null,
      confidence: 0,
      applicable: false,
      categories: [],
      evidence: [],
      reason: "Local originality index is disabled.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  const strongMatches = matches
    .filter((match) => match.similarity >= 0.86)
    .slice(0, 3);

  if (strongMatches.length === 0) {
    return {
      name: "local_originality",
      score: 0,
      confidence: 0.45,
      applicable: true,
      categories: [],
      evidence: [],
      reason: "No close local originality matches found.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  const best = strongMatches[0];
  const evidence: EvidenceItem[] = strongMatches.map((match, index) => ({
    reasonId: `local_originality_match_${index + 1}`,
    label: "Local duplicate/repost similarity",
    detail: `Similar to a previously seen item (${Math.round(match.similarity * 100)}% metadata similarity): ${match.title ?? match.url}.`,
    weight: match.similarity >= 0.94 ? 0.74 : 0.62,
    confidence: Math.min(0.88, match.similarity),
    source: "local_originality_index",
    category: "local_duplicate_repost"
  }));

  return {
    name: "local_originality",
    score: best.similarity >= 0.94 ? 0.74 : 0.62,
    confidence: Math.min(0.88, best.similarity),
    applicable: true,
    categories: ["local_duplicate_repost"],
    evidence,
    reason: "Matched a similar previously seen item in the local originality index.",
    runtimeMs: Date.now() - started,
    error: null
  };
}
