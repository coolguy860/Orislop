import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopMockService } from "../electron/desktopService.ts";
import { assertTrustedIpcSender, registerOrislopIpcHandlers } from "../electron/ipcHandlers.ts";

const TRUSTED_IPC_EVENT = { senderFrame: { url: "file:///orislop/index.html" } };

const REQUIRED_IPC_CHANNELS = [
  "orislop:scoreShort",
  "orislop:getSettings",
  "orislop:updateSettings",
  "orislop:resetSettings",
  "orislop:saveFeedback",
  "orislop:saveCalibrationLabel",
  "orislop:listCalibrationLabels",
  "orislop:exportCalibrationLabels",
  "orislop:importCalibrationLabels",
  "orislop:getCachedScore",
  "orislop:scoreLookaheadCandidates",
  "orislop:clearCache",
  "orislop:forceRescan",
  "orislop:getSkipHistory",
  "orislop:markScrolledBack",
  "orislop:markWatchedAnyway"
];

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-desktop-"));

try {
  await runDesktopChecks(tempRoot);
  console.log("Phase 5 desktop mock checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runDesktopChecks(storagePath) {
  const service = createDesktopMockService({ storagePath });
  const fixtures = service.listFixtures();
  assert(fixtures.length >= 5, "mock fixture selector data exists");
  const ipcHandlers = registerHandlersForTest(service);

  const obviousFixture = fixtures.find((fixture) => fixture.id === "obvious-brainrot");
  const normalFixture = fixtures.find((fixture) => fixture.id === "normal-comedy");
  if (!obviousFixture || !normalFixture) {
    throw new Error("Expected mock fixtures were not found.");
  }

  const settings = await service.getSettings();
  assertEqual("settings default autoSkip", settings.autoSkip, true);
  assertEqual("settings default hide flagged current video", settings.hideFlaggedCurrentVideo, true);
  assertEqual("settings default observe playback", settings.observePlaybackBeforeScoring, true);
  const updatedSettings = await service.updateSettings({ autoSkip: false });
  assertEqual("settings persist through desktop service", updatedSettings.autoSkip, false);
  await service.updateSettings({ autoSkip: true });

  const firstScore = await service.scoreShort({ fixtureId: obviousFixture.id });
  assertEqual("scoreVideo runs through app flow", firstScore.result.action, "skip");
  assertEqual("first score is fresh", firstScore.cacheHit, false);
  assert((await service.getSkipHistory()).length >= 1, "skip history records skipped score");

  const cachedScore = await service.scoreShort({ fixtureId: obviousFixture.id });
  assertEqual("repeated fixture uses cache", cachedScore.cacheHit, true);

  const forcedScore = await service.forceRescan({ fixtureId: obviousFixture.id });
  assertEqual("force rescan bypasses cache", forcedScore.cacheHit, false);

  const feedback = await service.saveFeedback({
    fixtureId: obviousFixture.id,
    scoreResult: forcedScore.result,
    userFeedback: "always_allow_channel"
  });
  assertEqual("feedback saves locally", feedback.record.userFeedback, "always_allow_channel");
  assertEqual("preference-changing feedback is tracked", feedback.preferencesChanged, true);

  const calibration = await service.saveCalibrationLabel({
    fixtureId: obviousFixture.id,
    scoreResult: forcedScore.result,
    userLabel: "slop",
    userFeedback: "correct"
  });
  assertEqual("calibration label saves locally", calibration.record.userLabel, "slop");
  assertEqual("calibration feedback saves locally", calibration.record.userFeedback, "correct");
  assertEqual("calibration label count updates", calibration.totalLabels, 1);
  assertEqual("calibration export returns records", (await service.exportCalibrationLabels()).length, 1);

  const notSlopCalibration = await service.saveCalibrationLabel({
    fixtureId: obviousFixture.id,
    scoreResult: forcedScore.result,
    userLabel: "not_slop",
    userFeedback: "always_allow_channel"
  });
  assertEqual("unified always-allow label saves", notSlopCalibration.record.userFeedback, "always_allow_channel");

  const allowedScore = await service.scoreShort({ fixtureId: obviousFixture.id });
  assertEqual("always allow channel affects future scoring", allowedScore.result.action, "allow");

  const normalScore = await service.scoreShort({ fixtureId: normalFixture.id });
  await service.saveFeedback({
    fixtureId: normalFixture.id,
    scoreResult: normalScore.result,
    userFeedback: "watch_anyway"
  });
  const cachedAfterWatchAnyway = await service.scoreShort({ fixtureId: normalFixture.id });
  assertEqual("non-preference feedback keeps cache usable", cachedAfterWatchAnyway.cacheHit, true);

  const seedOriginal = await service.scoreShort({
    short: {
      ...obviousFixture.short,
      videoId: "desktop-originality-seed",
      url: "https://www.youtube.com/shorts/desktop-originality-seed",
      title: "AI voice viral clips compilation",
      visiblePageText: "ai voice compilation viral clips source unknown"
    }
  });
  assert(seedOriginal.result, "local originality seed scores");
  const similarOriginality = await service.scoreShort({
    short: {
      ...obviousFixture.short,
      videoId: "desktop-originality-copy",
      url: "https://www.youtube.com/shorts/desktop-originality-copy",
      title: "AI voice viral clips compilation repost",
      visiblePageText: "ai voice compilation viral clips source unknown not mine"
    },
    forceRescan: true
  });
  assert(
    similarOriginality.result.categories.includes("local_duplicate_repost"),
    "desktop service applies local originality similarity"
  );

  const markScrolledBack = await service.markScrolledBack({ fixtureId: obviousFixture.id });
  assert(markScrolledBack?.scrolledBack, "scroll-back marker updates skip history");
  const markWatchedAnyway = await service.markWatchedAnyway({ fixtureId: obviousFixture.id });
  assert(markWatchedAnyway?.watchedAnyway, "watch-anyway marker updates skip history");

  await service.clearCache();
  const afterClear = await service.getCachedScore({ fixtureId: obviousFixture.id });
  assertEqual("clear cache removes cached score", afterClear, null);

  await service.resetSettings();

  for (const channel of REQUIRED_IPC_CHANNELS) {
    assert(ipcHandlers.has(channel), `IPC channel registered: ${channel}`);
  }
  const ipcScore = await ipcHandlers.get("orislop:scoreShort")(TRUSTED_IPC_EVENT, { fixtureId: obviousFixture.id });
  assert(ipcScore.result, "IPC scoreShort returns a result");
  await assertRejects(
    () => ipcHandlers.get("orislop:scoreShort")(TRUSTED_IPC_EVENT, { fixtureId: 42 }),
    "IPC validation rejects invalid score payload"
  );
  await assertRejects(
    () => ipcHandlers.get("orislop:saveCalibrationLabel")(TRUSTED_IPC_EVENT, {
      fixtureId: obviousFixture.id,
      scoreResult: forcedScore.result,
      userLabel: "wild"
    }),
    "IPC validation rejects invalid calibration label"
  );
  assertTrustedIpcSender(TRUSTED_IPC_EVENT);
  await assertRejects(
    () => ipcHandlers.get("orislop:getSettings")({ senderFrame: { url: "https://evil.example/" } }),
    "IPC rejects remote renderer origins"
  );
}

function registerHandlersForTest(service) {
  const handlers = new Map();
  registerOrislopIpcHandlers({
    handle(channel, listener) {
      handlers.set(channel, listener);
    }
  }, service);
  return handlers;
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(`${label}: assertion failed.`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}.`);
  }
}

async function assertRejects(callback, label) {
  try {
    await callback();
  } catch {
    return;
  }

  throw new Error(`${label}: expected rejection.`);
}
