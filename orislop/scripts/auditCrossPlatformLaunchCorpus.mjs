import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "dist", "qa", "cross-platform-128", "cross-platform-launch-audit.json");
const classifier = loadClassifier();
const platforms = ["youtube", "instagram", "tiktok", "linkedin"];
const records = [];

const startedAt = performance.now();
for (const platform of platforms) {
  for (let index = 0; index < 32; index += 1) {
    const spec = candidateSpec(platform, index);
    const first = classifier.scoreCandidate(spec.candidate);
    const second = classifier.scoreCandidate(spec.candidate);
    assert.deepEqual(second, first, `${platform}:${index} produced a non-deterministic decision`);
    records.push({
      platform,
      group: spec.group,
      mediaType: spec.candidate.mediaType,
      url: spec.candidate.url,
      title: spec.candidate.title,
      decision: summarizeDecision(first)
    });
  }
}
const elapsedMs = performance.now() - startedAt;

assert.equal(records.length, 128);
assert.equal(new Set(records.map((record) => `${record.platform}:${record.decision.itemId}`)).size, 128);
assert.equal(records.filter((record) => record.mediaType === "video").length, 112);
for (const platform of platforms) {
  const platformRecords = records.filter((record) => record.platform === platform);
  assert.equal(platformRecords.length, 32);
  assert.equal(platformRecords.filter((record) => record.group === "explicit-ai").length, 8);
  assert.ok(platformRecords.filter((record) => record.group === "explicit-ai")
    .every((record) => record.decision.hardAiSynthetic
      && record.decision.hardLocalSkip
      && record.decision.recommendation === "skip"
      && record.decision.score === 100));
  assert.ok(platformRecords.filter((record) => record.group === "educational")
    .every((record) => record.decision.educationalProtected
      && record.decision.recommendation === "watch"
      && !record.decision.hardLocalSkip));
  assert.ok(platformRecords.filter((record) => ["factual-claim", "professional-claim"].includes(record.group))
    .every((record) => record.decision.factCheckEligible));
}
assert.ok(elapsedMs <= 2_000, `Cross-platform Fast audit exceeded two seconds (${elapsedMs.toFixed(2)} ms)`);

const linkedInWriting = classifier.mergeOllamaDecision(
  classifier.scoreCandidate(candidateSpec("linkedin", 24).candidate),
  {
    available: true,
    verdict: "dont_skip",
    confidence: 0.91,
    category: "ordinary",
    reason: "Professional profile text remains visible.",
    writingVerdict: "likely_ai",
    writingConfidence: 0.87,
    writingReason: "Repeated templated transitions and uniform sentence rhythm."
  }
);
assert.equal(linkedInWriting.aiWritingLikely, true);
assert.equal(linkedInWriting.recommendation, "watch", "AI-writing style must not hide a LinkedIn profile");

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sampleCount: records.length,
  videoCount: records.filter((record) => record.mediaType === "video").length,
  elapsedMs: Math.round(elapsedMs * 100) / 100,
  underTwoSeconds: elapsedMs <= 2_000,
  deterministicReplayPassed: true,
  linkedInAiWritingAdvisoryPassed: true,
  byPlatform: Object.fromEntries(platforms.map((platform) => {
    const group = records.filter((record) => record.platform === platform);
    return [platform, {
      items: group.length,
      videos: group.filter((record) => record.mediaType === "video").length,
      hardAiOverrides: group.filter((record) => record.decision.hardAiSynthetic).length,
      educationalProtected: group.filter((record) => record.decision.educationalProtected).length,
      factCheckEligible: group.filter((record) => record.decision.factCheckEligible).length
    }];
  })),
  limitations: [
    "This corpus is deterministic metadata and URL coverage for the extension Fast path; it is not a human-labeled visual-accuracy benchmark.",
    "The separate live YouTube audit covers real rendered platform results and extension behavior.",
    "Instagram, TikTok, and LinkedIn authentication walls are covered by live smoke checks plus isolated DOM adapter fixtures."
  ],
  records
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, records: undefined, outputPath }, null, 2));

function candidateSpec(platform, index) {
  const padded = String(index).padStart(2, "0");
  const group = index < 8
    ? "explicit-ai"
    : index < 16
      ? "educational"
      : index < 24
        ? "factual-claim"
        : "professional-claim";
  const mediaType = platform === "linkedin" && index >= 16 ? (index < 24 ? "image" : "text") : "video";
  const url = candidateUrl(platform, index);
  const common = {
    platform,
    itemId: `launch-${platform}-${padded}`,
    itemKey: `${platform}:launch-${padded}`,
    url,
    channelName: `Launch QA ${platform}`,
    mediaType,
    previewUrl: previewUrl(platform, index),
    transcriptText: ""
  };
  if (group === "explicit-ai") {
    return {
      group,
      candidate: {
        ...common,
        title: `Fully AI-generated video experiment ${padded}`,
        visibleText: "This synthetic content was generated with AI. #aivideo"
      }
    };
  }
  if (group === "educational") {
    return {
      group,
      candidate: {
        ...common,
        title: `University physics lesson ${padded}: how gravity works`,
        visibleText: "A professor explains the experiment, evidence, assumptions, and original demonstration."
      }
    };
  }
  if (group === "factual-claim") {
    return {
      group,
      candidate: {
        ...common,
        title: `Research update ${padded}: measured retention change`,
        visibleText: "A 2025 study reports that customer retention increased by 42 percent after the program.",
        imageText: mediaType === "image" ? "Chart: retention increased 42 percent in 2025." : ""
      }
    };
  }
  return {
    group,
    candidate: {
      ...common,
      title: platform === "linkedin" ? `Launch QA Professional ${padded}` : `Company growth report ${padded}`,
      visibleText: "Led a documented product launch, managed 25 employees, and grew revenue by 30 percent in 2025."
    }
  };
}

function candidateUrl(platform, index) {
  const id = String(7_410_000_000_000_000_000n + BigInt(index));
  if (platform === "youtube") return `https://www.youtube.com/shorts/launch${String(index).padStart(4, "0")}`;
  if (platform === "instagram") return `https://www.instagram.com/reel/Launch${String(index).padStart(3, "0")}/`;
  if (platform === "tiktok") return `https://www.tiktok.com/@orislop-launch/video/${id}`;
  if (index < 24) return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  return `https://www.linkedin.com/in/orislop-launch-profile-${index}/`;
}

function previewUrl(platform, index) {
  if (platform === "youtube") return `https://i.ytimg.com/vi/launch${String(index).padStart(4, "0")}/hqdefault.jpg`;
  if (platform === "instagram") return `https://scontent.cdninstagram.com/launch-${index}.jpg`;
  if (platform === "tiktok") return `https://p16.tiktokcdn.com/launch-${index}.jpg`;
  return index < 24 ? `https://media.licdn.com/dms/image/launch-${index}` : "";
}

function summarizeDecision(decision) {
  return {
    platform: decision.platform,
    itemId: decision.itemId,
    itemKind: decision.itemKind,
    recommendation: decision.recommendation,
    score: decision.score,
    hardAiSynthetic: decision.hardAiSynthetic === true,
    hardLocalSkip: decision.hardLocalSkip === true,
    educationalProtected: decision.educationalProtected === true,
    factCheckEligible: decision.factCheckEligible === true,
    reasons: decision.reasons
  };
}

function loadClassifier() {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  for (const file of ["aiClassifierModel.generated.js", "classifier.js"]) {
    vm.runInContext(
      readFileSync(path.join(repoRoot, "apps", "extension", "src", file), "utf8"),
      context,
      { filename: file }
    );
  }
  return context.OrislopClassifier;
}
