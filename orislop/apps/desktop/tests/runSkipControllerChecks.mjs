import assert from "node:assert/strict";
import { DEFAULT_ORISLOP_SETTINGS } from "../../../packages/shared/src/constants.ts";
import {
  applyScrollAttemptResult,
  createSkipSessionState,
  decideSkipForCurrent,
  rememberLookaheadPreSkips,
  rememberWatchAnyway,
  videoKeyForShort
} from "../src/youtube/skipController.ts";
import { createScrollController } from "../src/youtube/scrollController.ts";

await runSkipControllerChecks();
console.log("Phase 8 skip controller checks passed.");

async function runSkipControllerChecks() {
  const short = makeShort("skip-current");
  const skipResult = makeScoreResult(short, "skip");
  const settings = {
    ...DEFAULT_ORISLOP_SETTINGS,
    autoSkip: true,
    skipMode: "auto_scroll_with_banner",
    allowScrollBack: true,
    showSkippedBanner: true,
    showFlaggedBannerOnScrollBack: true,
    maxConsecutiveSkips: 2
  };

  const session = createSkipSessionState();
  const decision = decideSkipForCurrent({ short, result: skipResult, settings, session });
  assert.equal(decision.shouldAttemptScroll, true, "skip score attempts auto-scroll");
  assert.equal(decision.skippedBanner?.kind, "skipped", "skipped banner is shown when enabled");

  const scrollEvents = [];
  let now = 1000;
  const scrollController = createScrollController({ debounceMs: 500, now: () => now });
  const successOutcome = await scrollController.attemptNextShort({
    focus() {
      scrollEvents.push("focus");
    },
    sendInputEvent(event) {
      scrollEvents.push(event.type);
    }
  });
  assert.equal(successOutcome.succeeded, true, "mock webview ArrowDown succeeds");
  assert.deepEqual(scrollEvents, ["focus", "keyDown", "keyUp"], "safe ArrowDown sequence is used");

  const postScrollBanner = applyScrollAttemptResult(session, decision, successOutcome);
  assert.equal(postScrollBanner?.kind, "skipped", "successful scroll keeps skipped banner");
  assert.equal(session.consecutiveSkips, 1, "successful scroll increments consecutive skip count");
  assert.equal(session.skippedKeys.has(videoKeyForShort(short)), true, "successful scroll records session skipped key");

  const scrollBackDecision = decideSkipForCurrent({ short, result: skipResult, settings, session });
  assert.equal(scrollBackDecision.shouldAttemptScroll, false, "same-session scroll-back is not immediately skipped");
  assert.match(scrollBackDecision.flaggedBanner?.message ?? "", /Orislop flagged this because:/, "scroll-back flagged banner is shown");

  const watchAnywaySession = createSkipSessionState();
  rememberWatchAnyway(watchAnywaySession, short);
  const watchAnywayDecision = decideSkipForCurrent({ short, result: skipResult, settings, session: watchAnywaySession });
  assert.equal(watchAnywayDecision.shouldAttemptScroll, false, "watch-anyway exemption prevents immediate re-skip");
  assert(watchAnywayDecision.flaggedBanner, "watch-anyway exemption still allows flagged context");

  assertNoScroll({ ...settings, autoSkip: false }, short, skipResult, "autoSkip false prevents auto-scroll");
  assertNoScroll({ ...settings, skipMode: "warn_only" }, short, skipResult, "warn_only prevents auto-scroll");
  assertNoScroll({ ...settings, skipMode: "off" }, short, skipResult, "off prevents auto-scroll");

  const guardSession = createSkipSessionState();
  guardSession.consecutiveSkips = settings.maxConsecutiveSkips;
  const guardDecision = decideSkipForCurrent({ short: makeShort("guard"), result: makeScoreResult(makeShort("guard"), "skip"), settings, session: guardSession });
  assert.equal(guardDecision.shouldAttemptScroll, false, "maxConsecutiveSkips pauses auto-scroll");
  assert.equal(guardDecision.skippedBanner?.kind, "paused", "maxConsecutiveSkips shows paused banner");

  const failShort = makeShort("failed-scroll");
  const failSession = createSkipSessionState();
  const failDecision = decideSkipForCurrent({
    short: failShort,
    result: makeScoreResult(failShort, "skip"),
    settings,
    session: failSession
  });
  const failedOutcome = await createScrollController({ debounceMs: 500, now: () => 5000 }).attemptNextShort(null);
  const failedBanner = applyScrollAttemptResult(failSession, failDecision, failedOutcome);
  assert.equal(failedBanner?.kind, "warning", "failed scroll downgrades to warning banner");
  assert.equal(failSession.consecutiveSkips, 0, "failed scroll does not advance skip streak");

  const preSkipShort = makeShort("pre-skip");
  const preSkipSession = createSkipSessionState();
  rememberLookaheadPreSkips(preSkipSession, [{
    candidate: {
      extractionId: "pre-skip",
      url: preSkipShort.url,
      videoId: preSkipShort.videoId,
      title: preSkipShort.title,
      channelName: preSkipShort.channelName,
      channelUrl: preSkipShort.channelUrl,
      visiblePageText: preSkipShort.visiblePageText,
      position: "next",
      confidence: 0.9
    },
    short: preSkipShort,
    scoreResult: makeScoreResult(preSkipShort, "pre_skip"),
    cacheHit: false,
    preSkip: true
  }]);
  assert.equal(preSkipSession.preSkipKeys.has(videoKeyForShort(preSkipShort)), true, "lookahead pre_skip is remembered");
  const preSkipDecision = decideSkipForCurrent({
    short: preSkipShort,
    result: makeScoreResult(preSkipShort, "pre_skip"),
    settings,
    session: preSkipSession
  });
  assert.equal(preSkipDecision.effectiveAction, "skip", "pre_skip promotes to current skip");
  assert.equal(preSkipDecision.shouldAttemptScroll, true, "pre_skip current Short can skip immediately");

  const debounced = await scrollController.attemptNextShort({
    sendInputEvent() {}
  });
  assert.equal(debounced.method, "debounced", "rapid repeated scroll attempts are debounced");
}

function assertNoScroll(settings, short, result, label) {
  const decision = decideSkipForCurrent({
    short,
    result,
    settings,
    session: createSkipSessionState()
  });
  assert.equal(decision.shouldAttemptScroll, false, label);
}

function makeShort(videoId) {
  return {
    url: `https://www.youtube.com/shorts/${videoId}`,
    videoId,
    title: "Miracle money trick nobody wants you to know",
    channelName: "Questionable Channel",
    channelUrl: "https://www.youtube.com/@questionable",
    description: null,
    hashtags: ["#finance", "#hack"],
    visiblePageText: "Miracle money trick nobody wants you to know",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: null
  };
}

function makeScoreResult(short, action) {
  return {
    videoId: short.videoId,
    url: short.url,
    slopScore: 0.92,
    claimRiskScore: 0.72,
    aiGeneratedScore: null,
    possibleUnlabeledAiScore: null,
    contentIntent: "finance_advice",
    factualIntentScore: 0.8,
    comedySatireScore: 0,
    skipProbability: 0.94,
    confidence: 0.86,
    categories: ["scam_finance"],
    evidence: [{
      reasonId: "test-scam",
      label: "Possible scam finance content",
      detail: "Fixture uses bait language.",
      weight: 0.8,
      confidence: 0.9,
      source: "test"
    }],
    action,
    skipReason: "possible scam finance content",
    userFacingReason: "Skipped: possible scam finance content",
    thresholdUsed: 0.7,
    settingsApplied: ["skipScamFinance"],
    signals: [],
    createdAt: "2026-06-25T00:00:00.000Z"
  };
}
