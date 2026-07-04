import type {
  ExtractedShort,
  OrislopScoreResult
} from "../../../../packages/shared/src/types.ts";

export type LookaheadPosition =
  | "current"
  | "next"
  | "nearby"
  | "unknown";

export type LookaheadShortCandidate = {
  extractionId: string;
  url: string | null;
  videoId: string | null;
  title: string | null;
  channelName: string | null;
  channelUrl: string | null;
  visiblePageText: string;
  position: LookaheadPosition;
  confidence: number;
};

export type LookaheadContainerSnapshot = {
  url?: string | null;
  videoId?: string | null;
  title?: string | null;
  channelName?: string | null;
  channelUrl?: string | null;
  visiblePageText?: string | null;
  position?: LookaheadPosition;
  isActive?: boolean;
};

export type LookaheadScanOptions = {
  currentUrl?: string | null;
  limit: number;
};

export type ScoreLookaheadPayload = {
  candidates: LookaheadShortCandidate[];
};

export type ScoredLookaheadCandidate = {
  candidate: LookaheadShortCandidate;
  short: ExtractedShort;
  scoreResult: OrislopScoreResult;
  cacheHit: boolean;
  preSkip: boolean;
};
