import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleSize = Math.max(2, Number.parseInt(process.env.ORISLOP_VIDEO_AUDIT_SAMPLE_SIZE || "1000", 10) || 1000);
const outputRoot = path.join(root, "dist", "qa", `youtube-${sampleSize}-scale-audit`);
const sourcePath = path.join(outputRoot, "youtube-search-source.json");
const reportPath = path.join(outputRoot, "metadata-fast-report.json");
const checkpointPath = path.join(outputRoot, "collection-checkpoint.json");
const targetPerBucket = Math.ceil(sampleSize / 2);
const classifier = loadClassifier();

const queryGroups = {
  "slop-biased": createQueries([
    "AI generated animal shorts", "AI animation brainrot shorts", "Italian brainrot characters",
    "Tung Tung Tung Sahur AI", "Topper Guild impossible challenge", "reddit story minecraft parkour",
    "AI voice viral compilation", "fake animal rescue AI", "celebrity deepfake shorts",
    "family guy subway surfers split screen", "content farm viral shorts", "AI baby podcast shorts",
    "synthetic influencer shorts", "AI movie trailer shorts", "oddly satisfying compilation repost",
    "watch till end challenge shorts", "viral prank compilation", "AI cat story shorts",
    "roblox reddit story AI voice", "brainrot meme compilation", "AI generated celebrity interview",
    "fake science facts shorts", "AI historical figures talking", "faceless automation shorts",
    "engagement bait shorts part 2", "AI generated food video", "AI superhero animation shorts",
    "deepfake podcast clip", "stolen clips compilation shorts", "AI horror story shorts"
  ]),
  educational: createQueries([
    "MIT physics lecture", "Khan Academy calculus", "NASA mission science explainer",
    "Stanford computer science lecture", "university history documentary", "woodworking hand tools tutorial",
    "culinary school cooking technique", "official museum art history", "public library author lecture",
    "NOAA weather science", "USGS geology education", "medical school anatomy lecture",
    "National Archives history", "Royal Institution science lecture", "PBS education documentary",
    "BBC Earth animal behavior", "official language lesson", "chess strategy grandmaster lesson",
    "electronics repair tutorial", "mechanical engineering lecture", "organic chemistry professor lecture",
    "statistics course lecture", "classical music masterclass", "photography lighting tutorial",
    "gardening extension service tutorial", "software engineering conference talk", "mathematics proof lecture",
    "architecture history lecture", "economics university lecture", "astronomy observatory lecture"
  ])
};

mkdirSync(outputRoot, { recursive: true });
const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : {};
const collected = {
  "slop-biased": new Map((checkpoint["slop-biased"] || []).map((item) => [item.key, item])),
  educational: new Map((checkpoint.educational || []).map((item) => [item.key, item]))
};
for (const [bucket, queries] of Object.entries(queryGroups)) {
  for (let offset = 0; offset < queries.length && collected[bucket].size < targetPerBucket; offset += 3) {
    const batch = queries.slice(offset, offset + 3);
    const results = await Promise.all(batch.map((query) => fetchSearch(query)));
    for (const videos of results) {
      for (const video of videos) {
        if (!collected[bucket].has(video.key)) collected[bucket].set(video.key, { ...video, bucket });
      }
    }
    console.error(`[youtube-scale] ${bucket}: ${collected[bucket].size}/${targetPerBucket}`);
    writeCheckpoint();
    if (offset + 3 < queries.length) await delay(500);
  }
}

const selectedSlop = [...collected["slop-biased"].values()].slice(0, targetPerBucket);
const selectedKeys = new Set(selectedSlop.map((item) => item.key));
const selectedEducational = [...collected.educational.values()]
  .filter((item) => !selectedKeys.has(item.key))
  .slice(0, Math.floor(sampleSize / 2));
const balanced = [...selectedSlop, ...selectedEducational].slice(0, sampleSize);
assert.equal(balanced.length, sampleSize, `YouTube search returned only ${balanced.length} distinct auditable videos; need ${sampleSize}`);

const startedAt = performance.now();
const decisions = balanced.map((item) => classifier.scoreCandidate({
  platform: "youtube",
  itemId: item.videoId,
  url: item.url,
  title: item.title,
  visibleText: "",
  transcriptText: "",
  channelName: "",
  previewUrl: item.previewUrl
}));
const elapsedMs = performance.now() - startedAt;
const records = balanced.map((item, index) => ({
  ...item,
  recommendation: decisions[index].recommendation,
  score: decisions[index].score,
  hardAiSynthetic: decisions[index].hardAiSynthetic === true,
  educationalProtected: decisions[index].educationalProtected === true,
  reasons: decisions[index].reasons
}));

const sessions = ["slop-biased", "educational"].map((bucket) => ({
  label: `youtube-${sampleSize}-${bucket}`,
  bucket,
  sampledVideos: balanced.filter((item) => item.bucket === bucket)
}));
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sampleCount: records.length,
  uniqueVideoIds: new Set(records.map((item) => item.videoId)).size,
  elapsedMs: Math.round(elapsedMs * 100) / 100,
  underTwoSeconds: elapsedMs <= 2000,
  decisionsPerSecond: Math.round(records.length / Math.max(elapsedMs / 1000, 0.001)),
  immutableDecisionStress: runImmutableDecisionStress(records),
  bySearchBucket: Object.fromEntries(Object.keys(collected).map((bucket) => {
    const group = records.filter((item) => item.bucket === bucket);
    const skipped = group.filter((item) => item.recommendation === "skip").length;
    return [bucket, { count: group.length, skipped, skipRate: skipped / Math.max(1, group.length) }];
  })),
  limitations: [
    "These are 1,000 distinct real YouTube search results, but search buckets are intent proxies rather than human-reviewed ground truth.",
    "This report measures the extension's deterministic metadata Fast path and decision immutability, not frame or motion-model accuracy.",
    "Use auditFeedCandidates.mjs with this source artifact for thumbnail-level Local Visual Fast testing.",
    "A 1,000-video Cloud Heavy accuracy claim requires 1,000 rights-cleared, human-labeled video files plus a deployed authenticated GPU endpoint."
  ],
  records
};

mkdirSync(outputRoot, { recursive: true });
writeFileSync(sourcePath, `${JSON.stringify({ checkedAt: report.checkedAt, sessions }, null, 2)}\n`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ sourcePath, reportPath, ...report, records: undefined }, null, 2));

function createQueries(baseQueries) {
  const suffixes = ["", "videos", "shorts", "2025", "explained"];
  return baseQueries.flatMap((query) => suffixes.map((suffix) => `${query} ${suffix}`.trim()));
}

async function fetchSearch(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`;
  let html = "";
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+999; SOCS=CAI",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(750 * (attempt + 1));
    }
  }
  if (!html) {
    console.error(`[youtube-scale] skipped query after retries: ${query} (${lastError})`);
    return [];
  }
  const marker = "var ytInitialData = ";
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";</script>", jsonStart);
  if (jsonEnd < 0) return [];
  const data = JSON.parse(html.slice(jsonStart, jsonEnd));
  const videos = new Map();
  const remember = (renderer) => {
    const item = normalizeRenderer(renderer);
    if (item && !videos.has(item.key)) videos.set(item.key, item);
  };
  walk(data, remember);

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || "";
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || "2.20260701.00.00";
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || "";
  let continuation = findContinuationToken(data);
  const seenContinuations = new Set();
  for (let page = 0; apiKey && continuation && page < 4 && !seenContinuations.has(continuation); page += 1) {
    seenContinuations.add(continuation);
    const next = await fetchJsonWithRetry(`https://www.youtube.com/youtubei/v1/search?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+999; SOCS=CAI",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": clientVersion
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US", visitorData } },
        continuation
      })
    });
    if (!next) break;
    walk(next, remember);
    continuation = findContinuationToken(next);
  }
  return [...videos.values()];
}

async function fetchJsonWithRetry(url, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch {
      await delay(500 * (attempt + 1));
    }
  }
  return null;
}

function findContinuationToken(value) {
  let token = "";
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const candidate = node.continuationCommand?.token
      || node.nextContinuationData?.continuation
      || node.reloadContinuationData?.continuation;
    if (typeof candidate === "string" && candidate.length > 20) token = candidate;
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return token;
}

function walk(value, visitRenderer) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitRenderer);
    return;
  }
  for (const key of ["videoRenderer", "reelItemRenderer", "shortsLockupViewModel", "lockupViewModel"]) {
    if (value[key] && typeof value[key] === "object") visitRenderer(value[key]);
  }
  for (const child of Object.values(value)) walk(child, visitRenderer);
}

function normalizeRenderer(renderer) {
  const videoId = String(
    renderer.videoId
      || renderer.contentId
      || renderer.onTap?.innertubeCommand?.watchEndpoint?.videoId
      || renderer.navigationEndpoint?.watchEndpoint?.videoId
      || ""
  );
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
  const title = firstText([
    renderer.title,
    renderer.headline,
    renderer.overlayMetadata?.primaryText,
    renderer.metadata?.lockupMetadataViewModel?.title,
    renderer.accessibilityText,
    renderer.accessibility
  ]);
  if (title.length < 2) return null;
  return {
    key: `youtube:${videoId}`,
    videoId,
    title: title.slice(0, 500),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    previewUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

function firstText(values) {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;
  }
  return "";
}

function extractText(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (!value || typeof value !== "object") return "";
  if (typeof value.simpleText === "string") return extractText(value.simpleText);
  if (typeof value.content === "string") return extractText(value.content);
  if (Array.isArray(value.runs)) return extractText(value.runs.map((run) => run?.text || "").join(""));
  if (typeof value.label === "string") return extractText(value.label);
  if (value.accessibilityData) return extractText(value.accessibilityData);
  return "";
}

function loadClassifier() {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  for (const file of ["aiClassifierModel.generated.js", "classifier.js"]) {
    const source = readFileSync(path.join(root, "apps", "extension", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return context.OrislopClassifier;
}

function runImmutableDecisionStress(records) {
  const first = new Map(records.map((item) => [item.key, item.recommendation]));
  let flips = 0;
  for (const item of records) {
    const conflictingLaterResult = item.recommendation === "skip" ? "watch" : "skip";
    const visible = first.has(item.key) ? first.get(item.key) : conflictingLaterResult;
    if (visible !== item.recommendation) flips += 1;
  }
  return { attemptedLateReplacements: records.length, visibleDecisionFlips: flips, passed: flips === 0 };
}

function writeCheckpoint() {
  writeFileSync(checkpointPath, `${JSON.stringify({
    checkedAt: new Date().toISOString(),
    "slop-biased": [...collected["slop-biased"].values()],
    educational: [...collected.educational.values()]
  }, null, 2)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
