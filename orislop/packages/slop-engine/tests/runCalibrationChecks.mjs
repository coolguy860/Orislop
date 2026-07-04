import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../../storage/src/index.ts";
import {
  evaluateCalibrationRecords,
  formatCalibrationReport
} from "../src/calibration/evaluateCalibration.ts";
import { scoreVideo } from "../src/scoreVideo.ts";
import {
  getStrictnessProfile,
  STRICTNESS_PROFILES
} from "../src/calibration/strictnessProfiles.ts";

const tempRoot = await mkdtemp(join(tmpdir(), "orislop-calibration-"));

try {
  await runCalibrationChecks(tempRoot);
  console.log("Phase 12 calibration checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runCalibrationChecks(basePath) {
  assertEqual("legacy medium maps to balanced", getStrictnessProfile("medium").id, "balanced");
  assert(STRICTNESS_PROFILES.nuclear.skipAt < STRICTNESS_PROFILES.strict.skipAt, "nuclear has lower skip threshold");

  const brainrot = makeBrainrotShort();
  const normal = makeNormalEducationalShort();
  const scam = makeScamClaimShort();
  const communityOnly = makeCommunityOnlyShort();

  const brainrotScore = scoreVideo(brainrot);
  assertEqual("non-emoji brainrot skips", brainrotScore.action, "skip");
  assert(brainrotScore.categories.includes("reddit_tts_story"), "reddit/TTS category is present");
  assert(brainrotScore.evidence.some((item) => item.label === "Reddit/TTS story format"), "reddit/TTS reason is visible");

  const normalScore = scoreVideo(normal);
  assertEqual("normal educational content allowed", normalScore.action, "allow");

  const scamScore = scoreVideo(scam);
  assertEqual("finance scam/claim risk skips", scamScore.action, "skip");
  assert(scamScore.claimRiskScore >= 0.8, "claim risk score is high");
  assert(scamScore.categories.includes("scam_finance"), "finance scam category is present");

  const communityDefault = scoreVideo(communityOnly);
  const defaultCommunitySignal = communityDefault.signals.find((signal) => signal.name === "community_reaction");
  assertEqual("community signal disabled by default", defaultCommunitySignal?.applicable, false);

  const communityNuclear = scoreVideo(communityOnly, {
    strictness: "nuclear",
    useCommunityReactionSignal: true,
    communitySignalWeight: 0.5
  });
  assert(communityNuclear.categories.includes("community_reaction"), "community category is present when enabled");
  assertEqual("strong community reaction can skip in nuclear", communityNuclear.action, "skip");
  assertEqual("community summary does not use raw comments", communityOnly.communityReactionSummary.usedRawComments, false);

  const calibrationStore = new CalibrationStore({ basePath });
  await calibrationStore.append({
    short: brainrot,
    scoreResult: brainrotScore,
    userLabel: "slop"
  });
  await calibrationStore.append({
    short: normal,
    platform: "mock_fixture",
    scoreResult: normalScore,
    userLabel: "not_slop"
  });
  await calibrationStore.append({
    short: scam,
    scoreResult: scamScore,
    userLabel: "claim_risk"
  });

  const records = await calibrationStore.list();
  assertEqual("calibration labels persist", records.length, 3);
  assertEqual("record stores extracted signals", records[0].extractedSignals.length > 0, true);
  assertEqual("record strips raw comments flag", records[0].communityReactionSummary?.usedRawComments ?? false, false);

  const exported = await calibrationStore.exportRecords();
  const importResult = await calibrationStore.importRecords(exported);
  assertEqual("duplicate import skips existing records", importResult.imported, 0);
  assertEqual("duplicate import reports skipped", importResult.skipped, 3);

  const report = evaluateCalibrationRecords(records);
  console.log(formatCalibrationReport(report));
  assertEqual("evaluation total labels", report.totalLabels, 3);
  assertEqual("evaluation slop/not_slop labels", report.evaluatedSlopVsNotSlop, 2);
  assertEqual("evaluation true positives", report.slopVsNotSlop.truePositives, 1);
  assertEqual("evaluation true negatives", report.slopVsNotSlop.trueNegatives, 1);
  assert(formatCalibrationReport(report).includes("Total labels: 3"), "formatted report includes totals");
}

function makeBrainrotShort() {
  return {
    url: "https://www.youtube.com/shorts/cal-brainrot",
    videoId: "cal-brainrot",
    title: "Story time POV: only 1% will understand part 2",
    channelName: "Daily Reddit Recap",
    channelUrl: "https://www.youtube.com/@dailyredditrecap",
    description: "AskReddit story over minecraft parkour. Watch till the end.",
    hashtags: ["storytime"],
    visiblePageText: "minecraft parkour background reddit story text to speech",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "Ask Reddit story. AITA for leaving? Text to speech voiceover story. Wait for it wait for it."
  };
}

function makeNormalEducationalShort() {
  return {
    url: "https://www.youtube.com/shorts/cal-normal",
    videoId: "cal-normal",
    title: "How a bicycle derailleur works",
    channelName: "Workshop Notes",
    channelUrl: "https://www.youtube.com/@workshopnotes",
    description: "A compact mechanical explanation with a real repair demo.",
    hashtags: ["education"],
    visiblePageText: "tutorial guide learn how it works repair demo",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "This tutorial explains how the spring and cable move the derailleur across the cassette."
  };
}

function makeScamClaimShort() {
  return {
    url: "https://www.youtube.com/shorts/cal-scam",
    videoId: "cal-scam",
    title: "Guaranteed returns from this crypto signal group",
    channelName: "Profit Mentor",
    channelUrl: "https://www.youtube.com/@profitmentor",
    description: "Copy my trades. Limited spots in my telegram group.",
    hashtags: ["crypto"],
    visiblePageText: "risk free profit join my paid group",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "DM me for crypto signals and guaranteed returns. Copy my trades in Telegram."
  };
}

function makeCommunityOnlyShort() {
  return {
    url: "https://www.youtube.com/shorts/cal-community",
    videoId: "cal-community",
    title: "A quiet clip",
    channelName: "Clip Shelf",
    channelUrl: "https://www.youtube.com/@clipshelf",
    description: "A short clip.",
    hashtags: [],
    visiblePageText: "short clip",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: null,
    communityReactionSummary: {
      status: "available",
      inspectedCount: 12,
      matchCounts: {
        slop: 4,
        fake_repost: 2,
        ai: 1,
        scam_claim_risk: 0
      },
      matchedCategories: ["slop", "fake_repost", "ai"],
      strength: "strong",
      usedRawComments: false,
      sampledAt: "2026-06-26T00:00:00.000Z"
    }
  };
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
