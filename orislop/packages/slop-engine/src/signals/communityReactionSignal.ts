import { clamp01 } from "../../../shared/src/clamp.ts";
import type {
  CommunityReactionSummary,
  EvidenceItem,
  OrislopSettings,
  SignalResult
} from "../../../shared/src/types.ts";

const STRENGTH_SCORE: Record<CommunityReactionSummary["strength"], number> = {
  none: 0,
  weak: 0.34,
  medium: 0.47,
  strong: 0.58
};

export function communityReactionSignal(
  summary: CommunityReactionSummary | null | undefined,
  settings: OrislopSettings
): SignalResult {
  const started = Date.now();

  if (!settings.useCommunityReactionSignal) {
    return unavailable("Community reaction signal is disabled.", started);
  }

  if (!summary || summary.status !== "available") {
    return unavailable("Visible community reactions are unavailable.", started);
  }

  if (summary.inspectedCount <= 0 || summary.strength === "none" || summary.matchedCategories.length === 0) {
    return {
      name: "community_reaction",
      score: 0,
      confidence: 0.3,
      applicable: true,
      categories: [],
      evidence: [],
      reason: "No visible community reaction heuristic matched.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  const baseScore = STRENGTH_SCORE[summary.strength];
  const score = clamp01(baseScore * (0.75 + settings.communitySignalWeight * 0.5));
  const evidence: EvidenceItem[] = summary.matchedCategories.map((category) => ({
    reasonId: `community_reaction_${category}`,
    label: "Visible community reaction",
    detail: communityDetail(category, summary),
    weight: score,
    confidence: confidenceForSummary(summary),
    source: "youtube_visible_comments_aggregate",
    category: "community_reaction"
  }));

  return {
    name: "community_reaction",
    score,
    confidence: confidenceForSummary(summary),
    applicable: true,
    categories: ["community_reaction"],
    evidence,
    reason: `Inspected ${summary.inspectedCount} visible comments; community reaction was ${summary.strength}.`,
    runtimeMs: Date.now() - started,
    error: null
  };
}

function unavailable(reason: string, started: number): SignalResult {
  return {
    name: "community_reaction",
    score: null,
    confidence: 0,
    applicable: false,
    categories: [],
    evidence: [],
    reason,
    runtimeMs: Date.now() - started,
    error: null
  };
}

function communityDetail(
  category: CommunityReactionSummary["matchedCategories"][number],
  summary: CommunityReactionSummary
): string {
  const count = summary.matchCounts[category] ?? 0;
  const label = category.replaceAll("_", " ");
  return `${count} of ${summary.inspectedCount} visible comments matched ${label} keywords; raw comments were not stored.`;
}

function confidenceForSummary(summary: CommunityReactionSummary): number {
  if (summary.inspectedCount >= 16) {
    return 0.62;
  }

  if (summary.inspectedCount >= 6) {
    return 0.5;
  }

  return 0.38;
}
