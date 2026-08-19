import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopMockService } from "../electron/desktopService.ts";
import { registerOrislopIpcHandlers } from "../electron/ipcHandlers.ts";
import {
  candidateToExtractedShort,
  dedupeLookaheadCandidates,
  getYouTubeLookaheadScannerScript,
  getYouTubeRecommendationFilterScript,
  limitLookaheadCandidates,
  scanLookaheadFromSnapshots
} from "../src/youtube/youtubeLookaheadScanner.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-lookahead-"));

try {
  await runLookaheadChecks(tempRoot);
  console.log("Phase 7 lookahead checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runLookaheadChecks(storagePath) {
  const snapshots = [
    {
      url: "https://www.youtube.com/shorts/current",
      title: "Current calm short",
      channelName: "Bench Notes",
      channelUrl: "https://www.youtube.com/@benchnotes",
      visiblePageText: "normal entertainment vlog",
      platformAiLabelText: null,
      isActive: true
    },
    {
      url: "https://www.youtube.com/shorts/skip-me",
      title: "You won't believe this minecraft parkour trick",
      channelName: "ClipsMax",
      channelUrl: "https://www.youtube.com/@clipsmax",
      visiblePageText: "watch till the end satisfying background like and follow",
      platformAiLabelText: null,
      position: "next"
    },
    {
      url: "https://www.youtube.com/shorts/skip-me",
      title: "Duplicate copy",
      visiblePageText: "duplicate loaded renderer",
      platformAiLabelText: null,
      position: "nearby"
    },
    {
      title: "Nearby no URL but enough text",
      visiblePageText: "reddit story text to speech over minecraft parkour",
      platformAiLabelText: null,
      position: "nearby"
    }
  ];

  const candidates = scanLookaheadFromSnapshots(snapshots, {
    currentUrl: "https://www.youtube.com/shorts/current",
    limit: 3
  });
  assertEqual("lookahead returns limited candidates", candidates.length, 3);
  assertEqual("current position inferred", candidates[0].position, "current");
  assertEqual("video id parsed", candidates[1].videoId, "skip-me");
  assertEqual("duplicate candidate suppressed", dedupeLookaheadCandidates(candidates).length, 3);
  assertEqual("manual limit helper works", limitLookaheadCandidates(candidates, 1).length, 1);
  assertEqual("empty result is safe", scanLookaheadFromSnapshots([], { limit: 2 }).length, 0);

  const partialShort = candidateToExtractedShort(candidates[2]);
  assert(partialShort.url.length > 0, "candidate converts to ExtractedShort URL fallback");
  assertEqual("candidate transcript remains null", partialShort.transcript, null);

  const watchCandidates = scanLookaheadFromSnapshots([{
    url: "https://www.youtube.com/watch?v=watch-next&list=ignored",
    title: "AI voice viral clips compilation",
    channelName: "Clip Mill",
    visiblePageText: "repost compilation source unknown",
    platformAiLabelText: null,
    position: "nearby"
  }], {
    currentUrl: "https://www.youtube.com/watch?v=current",
    limit: 2
  });
  assertEqual("watch recommendation video id parsed", watchCandidates[0].videoId, "watch-next");
  assertEqual("watch recommendation converts as watch", candidateToExtractedShort(watchCandidates[0]).videoKind, "watch");

  const script = getYouTubeLookaheadScannerScript(2);
  assert(script.includes("browserScanLookahead"), "webview lookahead script generated");
  const filterScript = getYouTubeRecommendationFilterScript(["watch-next", "bad id"]);
  assert(filterScript.includes("browserFilterFlaggedRecommendations"), "recommendation filter script generated");
  assert(!filterScript.includes("bad id"), "recommendation filter sanitizes video IDs");

  const service = createDesktopMockService({ storagePath });
  await service.updateSettings({
    lookaheadCount: 2,
    enableLookaheadScan: true
  });
  const firstScores = await service.scoreLookaheadCandidates({ candidates });
  assertEqual("service respects lookaheadCount", firstScores.length, 2);
  assertEqual("skippable candidate marked pre_skip", firstScores[1].scoreResult.action, "pre_skip");
  assertEqual("preSkip flag set", firstScores[1].preSkip, true);
  assertEqual("first lookahead score fresh", firstScores[1].cacheHit, false);

  const cachedScores = await service.scoreLookaheadCandidates({ candidates });
  assertEqual("lookahead score reuses cache", cachedScores[1].cacheHit, true);

  await service.updateSettings({ enableLookaheadScan: false });
  assertEqual("disabled lookahead returns empty", (await service.scoreLookaheadCandidates({ candidates })).length, 0);

  const handlers = registerHandlersForTest(service);
  assert(handlers.has("orislop:scoreLookaheadCandidates"), "lookahead IPC registered");
  await assertRejects(
    () => handlers.get("orislop:scoreLookaheadCandidates")({ senderFrame: { url: "file:///orislop/index.html" } }, { candidates: [{ extractionId: "bad" }] }),
    "lookahead IPC rejects invalid candidate"
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
