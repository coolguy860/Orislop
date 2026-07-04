import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const staticScoreModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "staticSlopScore.js");
const youtubeModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "youtube.js");
const feedFilterModule = path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "feedFilter.js");
const extensionDownload = path.join(repoRoot, "apps", "web", "dist", "downloads", "orislop-browser-extension.zip");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildWebStatic.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});
assert.ok(existsSync(extensionDownload), "Expected web build to include downloadable browser extension ZIP");

const { scoreStaticSlop } = await import(pathToFileURL(staticScoreModule).href);
const { parseYouTubeUrl } = await import(pathToFileURL(youtubeModule).href);
const { FEED_SCAN_LIMIT, parseFeedCandidates, scanFeedCandidates } = await import(pathToFileURL(feedFilterModule).href);

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

const neutralScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=abc123",
  title: "How rainfall forms in mountain regions",
  description: "A calm explanation of evaporation, condensation, and local weather patterns.",
  strictness: "balanced"
});
assert.equal(neutralScore.recommendation, "watch");
assert.ok(neutralScore.score < 36, "Neutral educational content should not default to a scary score");
assert.ok(Array.isArray(neutralScore.reasons));
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

const hashtagScore = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=abc123",
  title: "#viral #fyp #shorts #ai",
  description: "",
  strictness: "balanced"
});
assert.ok(hashtagScore.reasons.includes("Low-information title"));

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

console.log("web checks passed");
