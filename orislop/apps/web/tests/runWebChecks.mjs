import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const staticScoreModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "staticSlopScore.js");
const youtubeModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "youtube.js");
const feedFilterModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "feedFilter.js");
const extensionDownload = path.join(repoRoot, "apps", "web", "dist", "downloads", "orislop-browser-extension.zip");
const appBundle = path.join(repoRoot, "apps", "web", "dist", "assets", "App.js");
const combinedScoreBundle = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "combinedScore.js");
const privacyPage = path.join(repoRoot, "apps", "web", "dist", "privacy.html");
const releaseInfoPage = path.join(repoRoot, "apps", "web", "dist", "release-info.json");
const deployZip = path.join(repoRoot, "dist", "orislop-namecheap-static.zip");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildWebStatic.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});
assert.ok(existsSync(extensionDownload), "Expected web build to include downloadable browser extension ZIP");
assert.ok(existsSync(privacyPage), "Expected web build to include privacy.html");
assert.ok(existsSync(releaseInfoPage), "Expected web build to include release-info.json");

const { scoreStaticSlop } = await import(pathToFileURL(staticScoreModule).href);
const { parseYouTubeUrl } = await import(pathToFileURL(youtubeModule).href);
const { FEED_SCAN_LIMIT, parseFeedCandidates, scanFeedCandidates } = await import(pathToFileURL(feedFilterModule).href);
const { readZipEntries } = await import(pathToFileURL(path.join(repoRoot, "scripts", "lib", "zip.mjs")).href);

const urlCases = [
  ["https://www.youtube.com/watch?v=abc123", "abc123", "watch"],
  ["https://youtu.be/abc123", "abc123", "watch"],
  ["https://www.youtube.com/shorts/abc123", "abc123", "short"],
  ["https://www.youtube.com/watch?v=abc123&t=42s&feature=share", "abc123", "watch"],
  ["https://www.youtube.com/shorts/abc123?si=test", "abc123", "short"]
];

for (const [url, expectedId, expectedKind] of urlCases) {
  const parsed = parseYouTubeUrl(url);
  assert.equal(parsed.videoId, expectedId, `Expected ${url} to parse video ID ${expectedId}`);
  assert.equal(parsed.videoKind, expectedKind, `Expected ${url} to parse as ${expectedKind}`);
  assert.ok(parsed.embedUrl?.includes(`/embed/${expectedId}`), `Expected ${url} to produce an embed URL`);
}

const invalid = parseYouTubeUrl("https://example.com/watch?v=abc123");
assert.equal(invalid.isYouTubeUrl, false);
assert.equal(invalid.videoId, null);

const invalidScore = scoreStaticSlop({
  url: "not-a-url",
  title: "AI voice viral clips compilation",
  description: "Watch till the end.",
  strictness: "balanced"
});
assert.equal(invalidScore.score, 0);
assert.equal(invalidScore.recommendation, "watch");
assert.ok(invalidScore.reasons.includes("Enter a valid YouTube URL to score this item"));

const neutralScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=abc123",
  title: "How rainfall forms in mountain regions",
  description: "A calm explanation of evaporation, condensation, and local weather patterns.",
  strictness: "balanced"
});
assert.equal(neutralScore.recommendation, "watch");
assert.ok(neutralScore.score < 36, "Neutral educational content should not default to a scary score");
assert.ok(Array.isArray(neutralScore.reasons));
assert.ok(Array.isArray(neutralScore.signalBreakdown));
assert.equal(neutralScore.videoId, "abc123");

const skipScore = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/abc123",
  title: "AI voice viral clips compilation!!!",
  description: "Watch till the end. Like and follow for part 2. Source unknown. #viral #fyp",
  strictness: "strict"
});
assert.equal(skipScore.recommendation, "skip");
assert.ok(skipScore.score >= 68);
assert.ok(skipScore.reasons.length >= 3);

const redditParkourScore = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/reddit001",
  title: "Reddit story Minecraft parkour text to speech",
  description: "AI voice story over mobile game background.",
  strictness: "balanced"
});
assert.equal(redditParkourScore.recommendation, "skip");
assert.ok(redditParkourScore.reasons.includes("Reddit/TTS background-video format"));
assert.ok(redditParkourScore.reasons.includes("AI voice or synthetic narration"));

const longRedditSleepScore = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/sleep001",
  title: "1 Hour Reddit Stories for the Coziest Sleep + Silent Minecraft Parkour",
  description: "",
  strictness: "balanced"
});
assert.equal(longRedditSleepScore.recommendation, "skip");
assert.equal(longRedditSleepScore.score, 100);
assert.ok(longRedditSleepScore.reasons.includes("Stacked slop-format pattern"));
assert.ok(longRedditSleepScore.reasons.includes("Long low-originality compilation"));

const singleBrainrotSignal = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/parkour001",
  title: "Minecraft parkour reddit story",
  description: "",
  strictness: "balanced"
});
assert.notEqual(singleBrainrotSignal.recommendation, "watch");

const financeClaimBait = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/finance001",
  title: "This finance trick banks hate",
  description: "",
  strictness: "strict"
});
assert.equal(financeClaimBait.recommendation, "questionable");
assert.ok(financeClaimBait.reasons.includes("Scam or high-risk claim bait"));

const satisfyingClickbait = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/satisfy001",
  title: "You won't believe this satisfying background",
  description: "Follow for more.",
  strictness: "balanced"
});
assert.equal(satisfyingClickbait.recommendation, "questionable");
assert.ok(satisfyingClickbait.score < satisfyingClickbait.thresholds.skip, "Single satisfying/ASMR context should not become Skip without stronger stacked slop signals");
assert.ok(satisfyingClickbait.reasons.includes("Satisfying/ASMR filler context"));

const rankedSatisfying = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/satisfy002",
  title: "Ranking the most satisfying videos",
  description: "",
  strictness: "balanced"
});
assert.equal(rankedSatisfying.recommendation, "questionable");
assert.ok(rankedSatisfying.reasons.includes("Ranked sensory-list format"));

const hashtagScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=abc123",
  title: "#viral #fyp #shorts #ai",
  description: "",
  strictness: "balanced"
});
assert.ok(hashtagScore.reasons.includes("Low-information title"));

const repeatedSongScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=song001",
  title: "Chorus practice la la la la la la la la",
  description: "Song demo with repeated lyrics, hook practice, and performance notes.",
  strictness: "strict"
});
assert.ok(!repeatedSongScore.reasons.includes("Repetitive title/caption"), "Song or lyrics repetition should not be treated as low-information slop by itself");

const allCapsScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=caps001",
  title: "THIS SECRET CHANGES EVERYTHING",
  description: "",
  strictness: "balanced"
});
assert.ok(allCapsScore.reasons.includes("Spammy capitalization or punctuation"), "Original-case all-caps wording should trigger the capitalization signal");

const feedInput = [
  "https://www.youtube.com/watch?v=ok001 | Useful repair tutorial | Clear steps and useful details.",
  "https://www.youtube.com/shorts/bad001 | AI voice viral clips compilation!!! | Watch till the end. Like and follow. Source unknown.",
  "https://youtu.be/ok002 | Mountain weather explained | Educational context.",
  "https://www.youtube.com/shorts/hash001 | #viral #fyp #shorts #ai |",
  "https://youtu.be/ok003 | Piano practice | Repeated chorus in a song demo.",
  "https://youtu.be/ok004 | Cooking basics | Useful food prep.",
  "https://youtu.be/ok005 | Bike brake setup | Practical repair.",
  "https://youtu.be/ok006 | Telescope alignment | Practical science.",
  "https://youtu.be/ok007 | History of roads | Educational history.",
  "https://youtu.be/ok008 | Garden watering | Useful gardening.",
  "https://youtu.be/extra999 | This item should not be scanned | Extra item past limit."
].join("\n");
const candidates = parseFeedCandidates(feedInput);
const feedResults = scanFeedCandidates(candidates, "strict", FEED_SCAN_LIMIT);
assert.equal(candidates.length, 11);
assert.equal(feedResults.length, FEED_SCAN_LIMIT);
assert.ok(feedResults.some((result) => result.hidden), "At least one slop candidate should be hidden");
assert.ok(feedResults.every((result) => result.candidate.id !== "extra999"), "Only next 10 candidates should be scanned");

const appSource = readFileSync(appBundle, "utf8");
const shippedWebSource = `${appSource}\n${readFileSync(combinedScoreBundle, "utf8")}`;
assert.ok(appSource.includes("Enter a YouTube URL before analyzing."));
assert.ok(appSource.includes("Enter a valid YouTube URL first"));
assert.ok(appSource.includes("lower and uncertain scores stay visible"));
assert.ok(appSource.includes("Base points"));
assert.ok(appSource.includes("AI classifier predicted"));
assert.ok(shippedWebSource.includes("Spatiotemporal detector was not run"));
assert.ok(appSource.includes("Optional channel name"));
assert.ok(appSource.includes("Optional transcript"));
assert.ok(appSource.includes("Fails closed"));
assert.ok(appSource.includes("Low-value videos that look repetitive"));
assert.ok(appSource.includes("Orislop 1.4"));
assert.ok(appSource.includes("Open YouTube. Keep the good stuff."));
assert.ok(appSource.includes("No setup screens"));
assert.ok(appSource.includes("YouTube and YouTube Shorts only"));
assert.ok(appSource.includes("Does this result feel right?"));
assert.ok(appSource.includes("How Orislop made this score"));
assert.ok(appSource.includes("weighted features, local inference"));
assert.ok(appSource.includes("Supported: MP4, WebM, MOV, M4V, or OGV"));
assert.ok(appSource.includes("privacy.html"));

const privacySource = readFileSync(privacyPage, "utf8");
assert.ok(privacySource.includes("Privacy Policy"));
assert.ok(privacySource.includes("does not upload local video files"));
assert.ok(privacySource.includes("Clear all local Orislop data"));
assert.ok(privacySource.includes("Source-Backed Fact Checking"));
assert.ok(privacySource.includes("claim search queries"));
assert.ok(!privacySource.includes("https://api.orislop.com"));
assert.ok(privacySource.includes("does not receive browser cookies"));
assert.ok(privacySource.includes("Temporary companion media is deleted after analysis"));
assert.ok(privacySource.includes("Extension 1.4.0 runs only on YouTube and YouTube Shorts"));

const releaseInfo = JSON.parse(readFileSync(releaseInfoPage, "utf8"));
assert.equal(releaseInfo.releaseId, "orislop-youtube-web-1.4.0-2026-08-25");
assert.ok(appSource.includes("Install once. Open YouTube."));
assert.ok(releaseInfo.requiredQaFixes.includes("privacy.html included at archive root"));
assert.ok(releaseInfo.requiredQaFixes.includes("file:// fallback explains that the static app must be served over HTTP"));
assert.ok(releaseInfo.requiredQaFixes.includes("Orislop AI Classifier v1 runs locally over text/metadata"));
assert.ok(releaseInfo.requiredQaFixes.includes("AI classifier training excludes heuristic labels so fusion sources remain independent"));

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "createNamecheapZip.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});
const deployEntries = readZipEntries(deployZip);
assert.ok(deployEntries.includes("index.html"));
assert.ok(deployEntries.includes("privacy.html"));
assert.ok(deployEntries.includes("release-info.json"));
assert.ok(deployEntries.includes("downloads/orislop-browser-extension.zip"));
const extensionEntries = readZipEntries(extensionDownload);
assert.ok(extensionEntries.includes("icons/icon128.png"));
assert.ok(extensionEntries.includes("icons/icon256.png"));
assert.ok(extensionEntries.includes("release-info.json"));

const indexHtml = readFileSync(path.join(repoRoot, "apps", "web", "dist", "index.html"), "utf8");
assert.ok(indexHtml.includes("Serve this build over HTTP."));
assert.ok(indexHtml.includes("pnpm run web:preview"));

console.log("web checks passed");
