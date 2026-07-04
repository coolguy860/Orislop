import type {
  ExtractedShort,
  OrislopAction,
  OrislopScoreResult,
  OrislopSettings
} from "../../../../packages/shared/src/types.ts";
import type { ScoredLookaheadCandidate } from "./lookaheadTypes.ts";

export type SkipSessionState = {
  consecutiveSkips: number;
  skippedKeys: Set<string>;
  exemptKeys: Set<string>;
  preSkipKeys: Set<string>;
  lastAttemptedKey: string | null;
};

export type SkippedBannerView = {
  kind: "skipped" | "warning" | "paused";
  message: string;
  detail: string | null;
  videoKey: string | null;
};

export type FlaggedOnScrollBackBannerView = {
  message: string;
  reason: string | null;
  videoKey: string;
};

export type SkipDecision = {
  videoKey: string;
  effectiveAction: OrislopAction;
  shouldAttemptScroll: boolean;
  skippedBanner: SkippedBannerView | null;
  flaggedBanner: FlaggedOnScrollBackBannerView | null;
  pauseAutoSkipping: boolean;
  reason: string | null;
};

export type ScrollOutcomeLike = {
  attempted: boolean;
  succeeded: boolean;
  reason: string | null;
};

const MANY_SKIPS_MESSAGE = "Skipped several Shorts based on your settings.";

export function createSkipSessionState(): SkipSessionState {
  return {
    consecutiveSkips: 0,
    skippedKeys: new Set(),
    exemptKeys: new Set(),
    preSkipKeys: new Set(),
    lastAttemptedKey: null
  };
}

export function rememberLookaheadPreSkips(
  session: SkipSessionState,
  lookaheadResults: ScoredLookaheadCandidate[]
): void {
  for (const item of lookaheadResults) {
    if (item.preSkip) {
      session.preSkipKeys.add(videoKeyFromParts(item.short.videoId, item.short.url));
    }
  }
}

export function rememberWatchAnyway(session: SkipSessionState, short: ExtractedShort): void {
  session.exemptKeys.add(videoKeyForShort(short));
  session.consecutiveSkips = 0;
}

export function decideSkipForCurrent(input: {
  short: ExtractedShort;
  result: OrislopScoreResult;
  settings: OrislopSettings;
  session: SkipSessionState;
}): SkipDecision {
  const videoKey = videoKeyForShort(input.short);
  const reason = input.result.userFacingReason ?? input.result.skipReason;
  const wasPreSkipped = input.result.action === "pre_skip" || input.session.preSkipKeys.has(videoKey);
  const effectiveAction: OrislopAction = input.result.action === "pre_skip" ? "skip" : input.result.action;

  if (input.settings.allowScrollBack && (input.session.exemptKeys.has(videoKey) || input.session.skippedKeys.has(videoKey))) {
    input.session.exemptKeys.add(videoKey);
    input.session.consecutiveSkips = 0;
    return {
      videoKey,
      effectiveAction,
      shouldAttemptScroll: false,
      skippedBanner: null,
      flaggedBanner: input.settings.showFlaggedBannerOnScrollBack
        ? {
          message: `Orislop flagged this because: ${reason ?? "matched your settings"}`,
          reason,
          videoKey
        }
        : null,
      pauseAutoSkipping: false,
      reason
    };
  }

  if (effectiveAction !== "skip") {
    input.session.consecutiveSkips = 0;
    return noSkipDecision(videoKey, effectiveAction, reason);
  }

  const maxConsecutiveSkips = Math.max(0, input.settings.maxConsecutiveSkips);
  if (maxConsecutiveSkips > 0 && input.session.consecutiveSkips >= maxConsecutiveSkips) {
    return {
      videoKey,
      effectiveAction,
      shouldAttemptScroll: false,
      skippedBanner: {
        kind: "paused",
        message: MANY_SKIPS_MESSAGE,
        detail: "Auto-skipping is paused until you continue manually.",
        videoKey
      },
      flaggedBanner: null,
      pauseAutoSkipping: true,
      reason
    };
  }

  if (input.session.lastAttemptedKey === videoKey) {
    return {
      videoKey,
      effectiveAction,
      shouldAttemptScroll: false,
      skippedBanner: warningBanner(videoKey, reason, "Already attempted to skip this Short."),
      flaggedBanner: null,
      pauseAutoSkipping: false,
      reason
    };
  }

  if (!settingsAllowAutoScroll(input.settings)) {
    return {
      videoKey,
      effectiveAction,
      shouldAttemptScroll: false,
      skippedBanner: input.settings.showSkippedBanner
        ? warningBanner(videoKey, reason, input.settings.skipMode === "off" ? "Skipping is off." : "Auto-scroll is disabled by settings.")
        : null,
      flaggedBanner: null,
      pauseAutoSkipping: false,
      reason
    };
  }

  return {
    videoKey,
    effectiveAction,
    shouldAttemptScroll: true,
    skippedBanner: shouldShowSkipBanner(input.settings)
      ? skippedBanner(videoKey, reason, wasPreSkipped)
      : null,
    flaggedBanner: null,
    pauseAutoSkipping: false,
    reason
  };
}

export function applyScrollAttemptResult(
  session: SkipSessionState,
  decision: SkipDecision,
  outcome: ScrollOutcomeLike
): SkippedBannerView | null {
  if (!decision.shouldAttemptScroll) {
    return decision.skippedBanner;
  }

  session.lastAttemptedKey = decision.videoKey;

  if (outcome.succeeded) {
    session.consecutiveSkips += 1;
    session.skippedKeys.add(decision.videoKey);
    return decision.skippedBanner;
  }

  session.consecutiveSkips = 0;
  return warningBanner(
    decision.videoKey,
    decision.reason,
    outcome.reason ?? "Auto-scroll failed; showing a warning instead."
  );
}

export function videoKeyForShort(short: ExtractedShort): string {
  return videoKeyFromParts(short.videoId, short.url);
}

export function videoKeyFromParts(videoId: string | null, url: string): string {
  return videoId ? `video:${videoId}` : `url:${url}`;
}

export function settingsAllowAutoScroll(settings: OrislopSettings): boolean {
  return settings.autoSkip
    && settings.skipMode !== "off"
    && settings.skipMode !== "warn_only";
}

function shouldShowSkipBanner(settings: OrislopSettings): boolean {
  return settings.showSkippedBanner && settings.skipMode !== "auto_scroll_silent";
}

function noSkipDecision(
  videoKey: string,
  action: OrislopAction,
  reason: string | null
): SkipDecision {
  return {
    videoKey,
    effectiveAction: action,
    shouldAttemptScroll: false,
    skippedBanner: null,
    flaggedBanner: null,
    pauseAutoSkipping: false,
    reason
  };
}

function skippedBanner(
  videoKey: string,
  reason: string | null,
  wasPreSkipped: boolean
): SkippedBannerView {
  return {
    kind: "skipped",
    message: reason ?? "Skipped: likely low-value content",
    detail: wasPreSkipped
      ? "Pre-scanned by lookahead; auto-scrolled to the next Short."
      : "Auto-scrolled to the next Short.",
    videoKey
  };
}

function warningBanner(
  videoKey: string,
  reason: string | null,
  detail: string
): SkippedBannerView {
  return {
    kind: "warning",
    message: reason ?? "Orislop flagged this because: matched your settings",
    detail,
    videoKey
  };
}
