import { scoreVideo } from "../src/scoreVideo.ts";
import {
  chooseDeepScanPolicyFromBenchmarks
} from "../src/deepScan/deepScanPolicy.ts";
import {
  buildVerificationQuery,
  summarizeMockSourceResults
} from "../src/verification/sourceVerification.ts";
import { fuseSignals } from "../src/fuseSignals.ts";
import { normalizeSettings } from "../src/settings.ts";

runChecks();
console.log("Claim-aware deep scan checks passed.");

function runChecks() {
  const hashtagTitle = scoreVideo({
    ...baseShort("hashtags"),
    title: "#fyp #viral #shorts #trending",
    visiblePageText: "#fyp #viral #shorts #trending"
  });
  assert(hashtagTitle.categories.includes("low_information"), "hashtag-only title is low-information");
  assert(hashtagTitle.evidence.some((item) => item.reasonId === "metadata_title_only_hashtags"), "hashtag-only title evidence is present");
  assert(hashtagTitle.action === "skip" || hashtagTitle.action === "warn", "hashtag-only title is actionable");

  const songLoop = scoreVideo({
    ...baseShort("song-loop"),
    title: "Summer Nights official audio lyrics",
    description: "Song lyrics and original audio.",
    hashtags: ["music", "lyrics"],
    audioTrackTitle: "Summer Nights - Original Audio",
    audioIsSong: true,
    transcript: "love love love love love love love love love love love love love love love love love love love love"
  });
  assert(!songLoop.categories.includes("low_information"), "song repetition does not become low-information slop by itself");
  assertEqual("song repetition stays allowed", songLoop.action, "allow");

  const entertainmentLoop = scoreVideo({
    ...baseShort("entertainment-loop"),
    title: "Dance challenge loop",
    description: "A non-informational dance clip.",
    hashtags: ["dance", "fun"],
    visiblePageText: "dance challenge loop",
    transcript: "jump spin jump spin jump spin jump spin jump spin jump spin jump spin jump spin jump spin jump spin"
  });
  assert(entertainmentLoop.categories.includes("repetitive_format"), "entertainment repetition is classified separately");
  assert(!entertainmentLoop.categories.includes("low_information"), "entertainment repetition is not low-information");
  assert(entertainmentLoop.action !== "skip", "entertainment repetition does not auto-skip by itself");
  assert(entertainmentLoop.entertainmentScore > 0, "entertainment score is exposed");

  const aiVoiceCompilation = scoreVideo({
    ...baseShort("ai-voice-compilation"),
    title: "AI voice viral clips compilation",
    description: "Repost compilation, credit unknown.",
    visiblePageText: "ai voice compilation viral clips source unknown not mine",
    transcript: null
  });
  assert(aiVoiceCompilation.categories.includes("ai_slop"), "AI voice compilation is classified as AI slop");
  assertEqual("AI voice compilation skips", aiVoiceCompilation.action, "skip");
  assert(aiVoiceCompilation.slopEvidenceScore >= 0.86, "AI voice compilation gets strong slop evidence");
  assertEqual("AI voice compilation severe band", aiVoiceCompilation.riskBand, "severe");

  const greenScreenLowValue = scoreVideo({
    ...baseShort("green-screen-reaction"),
    title: "Green screen reaction to the original clip",
    description: "Original video credit to owner.",
    hashtags: ["greenscreen", "reaction"],
    visiblePageText: "green screen reaction original video full clip credit to owner",
    transcript: null
  });
  assert(greenScreenLowValue.categories.includes("green_screen_reaction"), "green-screen reaction category is present");
  assertEqual("green-screen low-value skips", greenScreenLowValue.action, "skip");

  const noCommentaryRepost = scoreVideo({
    ...baseShort("no-commentary-repost"),
    title: "Viral clips compilation",
    description: "No commentary, source unknown.",
    visiblePageText: "repost compilation viral clips no commentary source unknown",
    transcript: null
  });
  assert(noCommentaryRepost.categories.includes("low_originality_repost"), "low-originality repost category is present");
  assert(noCommentaryRepost.originalityRiskScore >= 0.78, "low-originality repost contributes originality risk");
  assert(noCommentaryRepost.evidenceScore >= noCommentaryRepost.originalityRiskScore, "evidence score includes originality risk");

  const adSurface = scoreVideo({
    ...baseShort("sponsored-ai-ad"),
    title: "Sponsored AI voice crypto signal ad",
    description: "Paid promotion. Copy my trades for guaranteed returns.",
    visiblePageText: "sponsored visit advertiser skip ad ai voice telegram guaranteed returns",
    isLikelyAd: true,
    adNoticeText: "Sponsored"
  });
  assertEqual("ad surface is warn only", adSurface.action, "warn");
  assertEqual("ad safety status", adSurface.adSafetyStatus, "visible_ad_limited");

  const neutral = scoreVideo({
    ...baseShort("neutral"),
    title: "Making tea after school",
    description: "A quiet vlog clip.",
    visiblePageText: "tea kettle desk afternoon routine",
    transcript: "I made tea after school and cleaned my desk."
  });
  assertEqual("neutral video action", neutral.action, "allow");
  assertEqual("neutral slop evidence", neutral.slopEvidenceScore, 0);
  assertEqual("neutral risk band", neutral.riskBand, "none");
  assert(neutral.skipProbability < 0.2, "neutral video does not show scary 50 percent decision score");

  const scam = scoreVideo({
    ...baseShort("claim-risk"),
    title: "Guaranteed returns from this crypto signal group",
    description: "Copy my trades in Telegram.",
    visiblePageText: "risk free profit crypto signals",
    transcript: "DM me for guaranteed returns and copy my trades."
  });
  assertEqual("high-risk claim verification status", scam.verificationStatus, "unavailable");
  assert(
    scam.verificationSummary?.notes.some((note) => note.includes("no production source verifier")),
    "claim verification accurately reports the disconnected verifier"
  );
  assert(buildVerificationQuery(scamShort()).includes("source evidence"), "verification query is built");

  const disabledCategoryFusion = fuseSignals([{
    name: "mixed_category_probe",
    score: 0.9,
    confidence: 1,
    applicable: true,
    categories: ["scam_finance", "engagement_bait"],
    evidence: [
      {
        reasonId: "probe_scam",
        label: "Scam probe",
        detail: "High disabled-category evidence",
        weight: 0.9,
        confidence: 1,
        source: "regression",
        category: "scam_finance"
      },
      {
        reasonId: "probe_bait",
        label: "Bait probe",
        detail: "Weak enabled-category evidence",
        weight: 0.2,
        confidence: 1,
        source: "regression",
        category: "engagement_bait"
      }
    ],
    reason: "Regression probe"
  }], normalizeSettings({
    skipScamFinance: false,
    skipEngagementBait: true
  }));
  assert(
    disabledCategoryFusion.skipProbability < 0.4,
    "disabled scam evidence does not leak through an enabled engagement category"
  );

  const mixed = summarizeMockSourceResults("crypto signal guaranteed returns source evidence", [
    { host: "investor.gov", stance: "contradicts" },
    { host: "example.edu", stance: "mixed" },
    { host: "finance.example", stance: "supports" }
  ], "2026-06-26T00:00:00.000Z");
  assertEqual("mock source status", mixed.status, "mixed");
  assertEqual("mock source count", mixed.sourceCount, 3);

  const suspiciousDeepScan = scoreVideo(scamShort(), {
    enableDeepScan: true,
    enableExistingAiDetector: true,
    deepScanPolicy: "suspicious_only"
  });
  assertEqual("suspicious deep scan pending", suspiciousDeepScan.deepScanStatus, "pending");

  const neutralDeepScan = scoreVideo(baseShort("neutral-deep"), {
    enableDeepScan: true,
    enableExistingAiDetector: true,
    deepScanPolicy: "suspicious_only"
  });
  assertEqual("neutral deep scan not needed", neutralDeepScan.deepScanStatus, "not_needed");

  const unavailableDeepScan = scoreVideo(scamShort(), {
    enableDeepScan: true,
    deepScanPolicy: "suspicious_only"
  });
  assertEqual("deep scan without enabled detectors is unavailable", unavailableDeepScan.deepScanStatus, "unavailable");

  const policyFast = chooseDeepScanPolicyFromBenchmarks([
    { detectorId: "spatial_detector", available: true, runtimeMs: 900 },
    { detectorId: "temporal_detector", available: true, runtimeMs: 1100 }
  ], 1500);
  assertEqual("fast detectors all videos", policyFast.policy, "all_videos");

  const policySlow = chooseDeepScanPolicyFromBenchmarks([
    { detectorId: "spatial_detector", available: true, runtimeMs: 4000 }
  ], 1500);
  assertEqual("slow detectors suspicious only", policySlow.policy, "suspicious_only");

  const policyNone = chooseDeepScanPolicyFromBenchmarks([], 1500);
  assertEqual("missing detectors manual only", policyNone.policy, "manual_only");
}

function scamShort() {
  return {
    ...baseShort("claim-risk"),
    title: "Guaranteed returns from this crypto signal group",
    description: "Copy my trades in Telegram.",
    visiblePageText: "risk free profit crypto signals",
    transcript: "DM me for guaranteed returns and copy my trades."
  };
}

function baseShort(id) {
  return {
    platform: "youtube",
    videoKind: "short",
    url: `https://www.youtube.com/shorts/${id}`,
    videoId: id,
    title: "Simple video",
    channelName: "Claim Aware Test",
    channelUrl: "https://www.youtube.com/@claimaware",
    description: null,
    hashtags: [],
    visiblePageText: "",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: null,
    audioTrackTitle: null,
    audioIsSong: false
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
