import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopMockService } from "../electron/desktopService.ts";
import {
  createShortsNavigationObserver
} from "../src/youtube/youtubeNavigationObserver.ts";
import {
  getYouTubeClearCurrentVideoShieldScript,
  getYouTubeCurrentVideoShieldScript
} from "../src/youtube/youtubeCurrentVideoShield.ts";
import {
  extractHashtags,
  extractShortFromSnapshot,
  findAdNotice,
  findAiDisclosure,
  getYouTubeShortsExtractorScript,
  summarizeVisibleCommunityReactions
} from "../src/youtube/youtubeShortsExtractor.ts";
import {
  parseYouTubeShortsUrl,
  YOUTUBE_SHORTS_HOME_URL
} from "../src/youtube/youtubeUrl.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-youtube-"));

try {
  await runChecks(tempRoot);
  console.log("Phase 6 YouTube extractor checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runChecks(storagePath) {
  const parsed = parseYouTubeShortsUrl("https://www.youtube.com/shorts/abc_123-XYZ?feature=share");
  assertEqual("Shorts URL detected", parsed.isShortsUrl, true);
  assertEqual("Shorts videoId parsed", parsed.videoId, "abc_123-XYZ");
  assertEqual("Shorts URL normalized", parsed.normalizedUrl, "https://www.youtube.com/shorts/abc_123-XYZ");
  assertEqual("Shorts home is allowed", parseYouTubeShortsUrl(YOUTUBE_SHORTS_HOME_URL).isShortsUrl, true);
  assertEqual("General watch URL rejected", parseYouTubeShortsUrl("https://www.youtube.com/watch?v=abc").isShortsUrl, false);
  const watch = parseYouTubeShortsUrl("https://www.youtube.com/watch?v=watch_123&list=nope");
  assertEqual("Watch URL detected", watch.isWatchUrl, true);
  assertEqual("Watch videoId parsed", watch.videoId, "watch_123");
  assertEqual("Watch URL normalized", watch.normalizedUrl, "https://www.youtube.com/watch?v=watch_123");
  const youtuBe = parseYouTubeShortsUrl("https://youtu.be/shortlink123?t=4");
  assertEqual("youtu.be URL detected", youtuBe.isWatchUrl, true);
  assertEqual("youtu.be videoId parsed", youtuBe.videoId, "shortlink123");

  const extracted = extractShortFromSnapshot({
    url: "https://www.youtube.com/shorts/ai-explainer",
    titleCandidates: [null, "AI-generated explainer #Transformers"],
    channelCandidates: [{
      name: "Model Notes",
      url: "https://www.youtube.com/@modelnotes"
    }],
    descriptionCandidates: ["Made with AI. A compact lesson. #Education"],
    visibleText: "Altered or synthetic content visible on page #Learn",
    aiDisclosureCandidates: ["Altered or synthetic content"],
    transcriptCandidates: []
  });
  assertEqual("Extracted videoId", extracted.videoId, "ai-explainer");
  assertEqual("Extracted video kind", extracted.videoKind, "short");
  assertEqual("Extracted title", extracted.title, "AI-generated explainer #Transformers");
  assertEqual("Extracted channel", extracted.channelName, "Model Notes");
  assertEqual("AI disclosure detected", extracted.hasPlatformAiLabel, true);
  assert(extracted.hashtags.includes("transformers"), "Hashtag from title extracted");
  assert(extracted.hashtags.includes("education"), "Hashtag from description extracted");
  assert(extracted.hashtags.includes("learn"), "Hashtag from visible text extracted");

  const watchExtracted = extractShortFromSnapshot({
    url: "https://www.youtube.com/watch?v=watch-song",
    titleCandidates: ["Summer Nights official audio #Music"],
    channelCandidates: [{
      name: "Song Channel",
      url: "https://www.youtube.com/@songchannel"
    }],
    descriptionCandidates: ["Official audio and lyrics."],
    visibleText: "music video page",
    audioCandidates: ["Summer Nights - Original Audio"],
    videoDurationSec: 83.2,
    playbackCurrentTimeSec: 3.4,
    playbackPaused: false,
    playbackReadyState: 4,
    playerStateText: "video playing 0:03 1:23"
  });
  assertEqual("Watch extraction video kind", watchExtracted.videoKind, "watch");
  assertEqual("Watch extraction videoId", watchExtracted.videoId, "watch-song");
  assertEqual("Watch extraction audio song", watchExtracted.audioIsSong, true);
  assertEqual("Watch extraction observes duration", watchExtracted.videoDurationSec, 83.2);
  assertEqual("Watch extraction observes playback state", watchExtracted.playbackPaused, false);

  const adExtracted = extractShortFromSnapshot({
    url: "https://www.youtube.com/watch?v=ad-test",
    titleCandidates: ["Sponsored AI voice finance clip"],
    visibleText: "Paid promotion Visit advertiser skip ad",
    descriptionCandidates: ["Sponsored"]
  });
  assertEqual("Ad surface detected", adExtracted.isLikelyAd, true);
  assertEqual("Ad notice helper", findAdNotice("Paid promotion"), "Paid promotion");

  const partial = extractShortFromSnapshot({
    url: "https://www.youtube.com/shorts/missing-fields",
    visibleText: ""
  });
  assertEqual("Partial extraction title is null", partial.title, null);
  assertEqual("Partial extraction channel is null", partial.channelName, null);
  assertEqual("Partial extraction transcript is null", partial.transcript, null);
  assertEqual("Partial extraction visible text is safe", partial.visiblePageText, "");

  assert(extractHashtags("#One #two #One").length === 2, "Hashtags are deduplicated");
  assertEqual("AI disclosure helper", findAiDisclosure("Altered or synthetic content"), "Altered or synthetic content");
  assertEqual("Generic AI education title is not a platform disclosure", findAiDisclosure("How to detect AI-generated content"), null);
  const ordinaryAiText = extractShortFromSnapshot({
    url: "https://www.youtube.com/watch?v=ai-education",
    titleCandidates: ["How to detect AI-generated content"],
    descriptionCandidates: ["A tutorial about synthetic media."],
    visibleText: "Up next: AI-generated Reddit story over Minecraft parkour",
    aiDisclosureCandidates: []
  });
  assertEqual("Creator and recommendation text do not become a platform label", ordinaryAiText.hasPlatformAiLabel, false);
  assert(getYouTubeShortsExtractorScript().includes("browserExtractCurrentShort"), "Webview extractor script is generated");
  assert(getYouTubeShortsExtractorScript({
    includeCommunityReaction: true,
    maxVisibleCommentsToInspect: 4
  }).includes("maxVisibleCommentsToInspect"), "Webview extractor accepts community options");
  assert(getYouTubeCurrentVideoShieldScript("reason").includes("browserShieldCurrentVideo"), "Current video shield script is generated");
  assert(getYouTubeClearCurrentVideoShieldScript().includes("browserClearCurrentVideoShield"), "Current video clear script is generated");

  const disabledCommunity = summarizeVisibleCommunityReactions(["this is slop"]);
  assertEqual("Community signal disabled by default", disabledCommunity.status, "disabled");
  const community = summarizeVisibleCommunityReactions([
    "ai slop",
    "repost",
    "this is fake",
    "normal comment"
  ], {
    includeCommunityReaction: true,
    maxVisibleCommentsToInspect: 4,
    sampledAt: "2026-06-26T00:00:00.000Z"
  });
  assertEqual("Community comments inspected", community.inspectedCount, 4);
  assert(community.matchedCategories.includes("slop"), "Community slop category counted");
  assertEqual("Community raw comments flag", community.usedRawComments, false);

  await assertNavigationObserver();

  const service = createDesktopMockService({ storagePath });
  const firstScore = await service.scoreShort({ short: extracted });
  assertEqual("Extracted Short scores through service", firstScore.cacheHit, false);
  assert(firstScore.result.action === "skip" || firstScore.result.action === "warn", "Extracted Short produces an action");
  const cachedScore = await service.scoreShort({ short: extracted });
  assertEqual("Extracted Short reuses cache", cachedScore.cacheHit, true);
  const forcedScore = await service.forceRescan({ short: extracted });
  assertEqual("Extracted Short forceRescan bypasses cache", forcedScore.cacheHit, false);
}

async function assertNavigationObserver() {
  const events = [];
  let currentUrl = "https://www.youtube.com/shorts/first";
  const observer = createShortsNavigationObserver({
    debounceMs: 5,
    getCurrentUrl: () => currentUrl,
    onSettledShortChange: (event) => {
      events.push(event);
    }
  });

  observer.notifyNavigation();
  observer.notifyNavigation();
  await wait(20);
  assertEqual("Debounced navigation fires once", events.length, 1);
  assertEqual("First navigation videoId", events[0].videoId, "first");

  observer.notifyNavigation();
  await wait(20);
  assertEqual("Same video is not rescored endlessly", events.length, 1);

  currentUrl = "https://www.youtube.com/shorts/second";
  observer.notifyNavigation();
  await wait(20);
  assertEqual("New video triggers observer", events.length, 2);
  assertEqual("Second navigation videoId", events[1].videoId, "second");

  observer.analyzeCurrent();
  await wait(20);
  assertEqual("Manual analyze fallback can rescore same video", events.length, 3);
  observer.dispose();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
