import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildWebStatic.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

const { runAiClassifier, unavailableAiResult } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "aiClassifier.js")).href);
const { AI_CLASSIFIER_MODEL } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "aiClassifierModel.generated.js")).href);
const { scoreWithAiClassifier } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "combinedScore.js")).href);
const { scoreStaticSlop } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "staticSlopScore.js")).href);
const { parseFeedCandidates, scanFeedCandidates } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "dist", "assets", "lib", "feedFilter.js")).href);

const canonicalModelSource = readFileSync(path.join(repoRoot, "models", "orislop_ai_classifier_v1.json"), "utf8");
const canonicalModel = JSON.parse(canonicalModelSource);
assert.equal(AI_CLASSIFIER_MODEL.features.length, canonicalModel.features.length, "Web runtime uses every canonical model feature");
assert.ok(AI_CLASSIFIER_MODEL.features.length >= 150, "Model retains a useful text/metadata vocabulary");
assert.equal(
  AI_CLASSIFIER_MODEL.artifactHash,
  createHash("sha256").update(canonicalModelSource).digest("hex"),
  "Web runtime model hash matches the canonical artifact"
);

const slopAi = runAiClassifier({
  title: "AI voice Reddit story Minecraft parkour text to speech",
  description: "Robot voice over mobile gameplay. Follow for part 2.",
  channelName: "Story Bot",
  durationSeconds: 58,
  isShort: true,
  heuristicScore: 88,
  matchedSignals: ["AI voice or synthetic narration", "Reddit/TTS background-video format"]
});
assert.equal(slopAi.available, true);
assert.ok(slopAi.slopProbability >= 0 && slopAi.slopProbability <= 1);
assert.ok(slopAi.score >= 60, `Expected slop AI score >= 60, got ${slopAi.score}`);
assert.ok(["reddit_story", "ai_voice", "brainrot_format", "slop"].includes(slopAi.predictedLabel));
assert.ok(slopAi.topFeatures.length > 0);

const normalAi = runAiClassifier({
  title: "How rainfall forms in mountain regions",
  description: "A calm explanation of evaporation and condensation.",
  channelName: "Earth Science Lab",
  durationSeconds: 480,
  isShort: false,
  heuristicScore: 0,
  matchedSignals: []
});
assert.equal(normalAi.available, true);
assert.ok(normalAi.score < 45, `Expected normal AI score < 45, got ${normalAi.score}`);

const heuristic = scoreStaticSlop({
  url: "https://www.youtube.com/shorts/reddit001",
  title: "Reddit story Minecraft parkour text to speech",
  description: "AI voice story over mobile game background.",
  strictness: "balanced"
});
const combined = scoreWithAiClassifier({
  heuristic,
  url: "https://www.youtube.com/shorts/reddit001",
  title: "Reddit story Minecraft parkour text to speech",
  description: "AI voice story over mobile game background.",
  channelName: "Story Bot",
  durationSeconds: 58,
  isShort: true
});
assert.equal(combined.aiClassifierUsed, true);
assert.equal(combined.spatiotemporalUsed, false);
assert.equal(combined.recommendation, "skip");
assert.ok(combined.sourceScores.aiClassifier !== null);
assert.ok(combined.fallbackReasons.some((reason) => reason.includes("Spatiotemporal")));

const unavailableCombined = scoreWithAiClassifier({
  heuristic,
  aiClassifier: unavailableAiResult("Test model unavailable."),
  url: "https://www.youtube.com/shorts/reddit001",
  title: "Reddit story Minecraft parkour text to speech",
  description: "AI voice story over mobile game background.",
  isShort: true
});
assert.equal(unavailableCombined.aiClassifierUsed, false);
assert.equal(unavailableCombined.sourceScores.aiClassifier, null);
assert.ok(unavailableCombined.fallbackReasons.includes("Test model unavailable."));
assert.ok(unavailableCombined.score >= 0 && unavailableCombined.score <= 100);

const lowHeuristic = scoreStaticSlop({
  url: "https://www.youtube.com/watch?v=rain001",
  title: "How rainfall forms in mountain regions",
  description: "A calm explanation of evaporation and condensation.",
  strictness: "balanced"
});
const watchCombined = scoreWithAiClassifier({
  heuristic: lowHeuristic,
  url: "https://www.youtube.com/watch?v=rain001",
  title: "How rainfall forms in mountain regions",
  description: "A calm explanation of evaporation and condensation.",
  channelName: "Earth Science Lab",
  durationSeconds: 480,
  isShort: false
});
assert.equal(watchCombined.recommendation, "watch");

const heuristicOnlyCombined = scoreWithAiClassifier({
  heuristic: {
    ...lowHeuristic,
    score: 88,
    finalScore: 88,
    recommendation: "skip",
    reasons: ["AI-generated content terms"],
    signalBreakdown: [{ label: "AI-generated content terms", points: 34 }]
  },
  url: "https://www.youtube.com/watch?v=neutral001",
  title: "Neutral footage",
  description: "",
  channelName: "",
  durationSeconds: 480,
  isShort: false
});
assert.ok(
  (heuristicOnlyCombined.sourceScores.aiClassifier ?? 100) < 60,
  "Heuristic reasons must not be double-counted as independent AI classifier evidence"
);

const unavailableAiWithVideoDetector = scoreWithAiClassifier({
  heuristic: {
    ...lowHeuristic,
    score: 50,
    finalScore: 50,
    recommendation: "questionable"
  },
  aiClassifier: unavailableAiResult("Test model unavailable."),
  spatiotemporalScore: {
    available: true,
    score: 50,
    reason: "Regression probe"
  },
  url: "https://www.youtube.com/watch?v=weights001",
  title: "Neutral footage",
  description: "",
  transcript: "",
  isShort: false
});
const usedWeightTotal = unavailableAiWithVideoDetector.explanationBreakdown
  .filter((source) => source.used)
  .reduce((sum, source) => sum + source.weight, 0);
assert.ok(Math.abs(usedWeightTotal - 1) < 1e-9, `Expected used source weights to total 1, got ${usedWeightTotal}`);
assert.equal(unavailableAiWithVideoDetector.score, 50, "Equal source scores should remain equal after normalized fusion");

const feedInput = [
  "https://www.youtube.com/shorts/a100 | Reddit story Minecraft parkour | AI voice over gameplay",
  "https://youtu.be/b200 | Useful repair walkthrough |",
  "https://www.youtube.com/watch?v=c300 | |",
  "https://www.youtube.com/shorts/d400 | AI voice viral clips compilation | Source unknown"
].join("\n");
const feedResults = scanFeedCandidates(parseFeedCandidates(feedInput), "balanced", 10);
assert.equal(feedResults.length, 4);
assert.ok(feedResults.every((result) => result.score.aiClassifierUsed === true));
assert.ok(feedResults.every((result) => result.score.score >= 0 && result.score.score <= 100));

console.log("AI classifier checks passed");
