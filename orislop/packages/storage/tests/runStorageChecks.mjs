import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreVideo } from "../../slop-engine/src/scoreVideo.ts";
import {
  CacheStore,
  ChannelPreferenceStore,
  LocalOriginalityStore,
  LocalFeedbackStore,
  SkipHistoryStore,
  UserSettingsStore
} from "../src/index.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-storage-"));

try {
  await runStorageChecks(tempRoot);
  console.log("Phase 4 storage checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runStorageChecks(basePath) {
  const settingsStore = new UserSettingsStore({ basePath });
  const defaults = await settingsStore.load();
  assertEqual("settings default autoSkip", defaults.autoSkip, true);

  await settingsStore.save({
    autoSkip: false,
    maxConsecutiveSkips: 3,
    strictness: "strict"
  });
  const persisted = await new UserSettingsStore({ basePath }).load();
  assertEqual("settings persist autoSkip", persisted.autoSkip, false);
  assertEqual("settings persist maxConsecutiveSkips", persisted.maxConsecutiveSkips, 3);
  assertEqual("settings persist strictness", persisted.strictness, "strict");

  const settingsPath = join(basePath, "settings.json");
  await writeFile(settingsPath, '{"autoSkip":"nope","maxConsecutiveSkips":"many","strictness":"wild"}', "utf8");
  const repairedShape = await settingsStore.loadWithRepairStatus();
  assertEqual("invalid settings repaired flag", repairedShape.repaired, true);
  assertEqual("invalid settings repaired autoSkip", repairedShape.settings.autoSkip, true);
  assertEqual("invalid settings repaired strictness", repairedShape.settings.strictness, "balanced");

  await writeFile(settingsPath, "{not-json", "utf8");
  const repairedMalformed = await settingsStore.loadWithRepairStatus();
  assertEqual("malformed settings repaired flag", repairedMalformed.repaired, true);
  JSON.parse(await readFile(settingsPath, "utf8"));

  const settings = repairedMalformed.settings;
  const obviousSlop = makeObviousSlopShort();
  const scam = makeScamShort();
  const normal = makeNormalShort();
  const slopScore = scoreVideo(obviousSlop, settings);

  const feedbackStore = new LocalFeedbackStore({ basePath });
  await feedbackStore.append({
    videoId: obviousSlop.videoId,
    url: obviousSlop.url,
    title: obviousSlop.title,
    channelName: obviousSlop.channelName,
    channelUrl: obviousSlop.channelUrl,
    scoreResult: slopScore,
    actionTaken: slopScore.action,
    userFeedback: "not_slop"
  });
  assertEqual("feedback saves locally", (await feedbackStore.list()).length, 1);

  const originalityStore = new LocalOriginalityStore({ basePath, vectorDimensions: 32 });
  await originalityStore.upsert({
    ...obviousSlop,
    videoId: "original-viral-clip",
    url: "https://www.youtube.com/shorts/original-viral-clip",
    title: "AI voice viral clips compilation",
    visiblePageText: "ai voice compilation viral clips source unknown"
  });
  const originalityMatches = await originalityStore.findSimilar({
    ...obviousSlop,
    videoId: "reposted-viral-clip",
    url: "https://www.youtube.com/shorts/reposted-viral-clip",
    title: "AI voice viral clips compilation repost",
    visiblePageText: "ai voice compilation viral clips source unknown not mine"
  }, {
    minSimilarity: 0.5
  });
  assertEqual("local originality index finds similar metadata", originalityMatches.length > 0, true);
  assertEqual("local originality index stores compact records", (await originalityStore.list()).length, 1);

  const cacheStore = new CacheStore({ basePath });
  await cacheStore.saveScore(slopScore, settings, obviousSlop);
  const cached = await cacheStore.getScore(obviousSlop, settings);
  assertEqual("cache retrieves score", cached?.url, obviousSlop.url);
  const staleMetadata = await cacheStore.getScore({
    ...obviousSlop,
    title: "Metadata changed after YouTube hydrated the card"
  }, settings);
  assertEqual("cache invalidates when extracted metadata changes", staleMetadata, null);
  const bypassed = await cacheStore.getScore(obviousSlop, {
    ...settings,
    forceRescan: true
  });
  assertEqual("forceRescan bypasses cache", bypassed, null);

  const skipHistoryStore = new SkipHistoryStore({ basePath, sessionId: "phase4-session" });
  await skipHistoryStore.recordSkip({
    videoId: obviousSlop.videoId,
    url: obviousSlop.url,
    reason: slopScore.skipReason,
    action: slopScore.action
  });
  assertEqual("skip history saves item", (await skipHistoryStore.list()).length, 1);
  await skipHistoryStore.markScrolledBack(obviousSlop);
  assertEqual(
    "skip history avoids immediate same-session reskip",
    await skipHistoryStore.shouldAvoidImmediateReskip(obviousSlop),
    true
  );

  const channelPreferenceStore = new ChannelPreferenceStore({ basePath });
  await channelPreferenceStore.alwaysAllowChannel({
    channelName: obviousSlop.channelName,
    channelUrl: obviousSlop.channelUrl
  });
  let userPreferenceRules = await channelPreferenceStore.toUserPreferenceRules();
  const allowedSlop = scoreVideo(obviousSlop, settings, { userPreferences: userPreferenceRules });
  assertEqual("always allow channel affects userPreferenceSignal", allowedSlop.action, "allow");

  await channelPreferenceStore.alwaysBlockChannel({
    channelName: normal.channelName,
    channelUrl: normal.channelUrl
  });
  userPreferenceRules = await channelPreferenceStore.toUserPreferenceRules();
  const blockedNormal = scoreVideo(normal, settings, { userPreferences: userPreferenceRules });
  assertEqual("always block channel forces skip", blockedNormal.action, "skip");

  await channelPreferenceStore.alwaysAllowChannel({
    channelName: scam.channelName,
    channelUrl: scam.channelUrl
  });
  userPreferenceRules = await channelPreferenceStore.toUserPreferenceRules();
  const highRiskAllowedChannel = scoreVideo(scam, settings, { userPreferences: userPreferenceRules });
  assertEqual("always allow channel does not override strict scam setting", highRiskAllowedChannel.action, "skip");
}

function makeObviousSlopShort() {
  return {
    url: "https://www.youtube.com/shorts/phase4-obvious-slop",
    videoId: "phase4-obvious-slop",
    title: "You won't believe this minecraft parkour secret trick!!!",
    channelName: "Phase4 Slop Channel",
    channelUrl: "https://www.youtube.com/@phase4slop",
    description: "Watch till the end before they take this down. Like and follow for part 2.",
    hashtags: ["brainrot"],
    visiblePageText: "satisfying background mobile game background",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "Watch till the end wait for it. Like and follow, subscribe for more."
  };
}

function makeScamShort() {
  return {
    url: "https://www.youtube.com/shorts/phase4-scam",
    videoId: "phase4-scam",
    title: "Guaranteed returns with my crypto signals",
    channelName: "Phase4 Scam Channel",
    channelUrl: "https://www.youtube.com/@phase4scam",
    description: "Limited spots in my telegram group. DM me for guaranteed profit.",
    hashtags: ["crypto"],
    visiblePageText: "copy my trades risk free",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "Copy my trades in my telegram group. Guaranteed returns are waiting."
  };
}

function makeNormalShort() {
  return {
    url: "https://www.youtube.com/shorts/phase4-normal",
    videoId: "phase4-normal",
    title: "Weekend dance practice",
    channelName: "Phase4 Normal Channel",
    channelUrl: "https://www.youtube.com/@phase4normal",
    description: "Music and dance vlog.",
    hashtags: ["dance"],
    visiblePageText: "dance practice music vlog",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "We practiced the new dance routine in the studio."
  };
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}.`);
  }
}
