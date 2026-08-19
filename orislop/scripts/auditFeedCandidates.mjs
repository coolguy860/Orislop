import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(root, options.source);
const outputPath = path.resolve(root, options.output);
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const candidates = selectCandidates(source, options.sampleSize);
assert.equal(candidates.length, options.sampleSize, `Need ${options.sampleSize} distinct candidates; found ${candidates.length}`);

const classifier = loadClassifier();
const startedAt = performance.now();
const metadataRecords = candidates.map((candidate) => ({
  key: candidate.key,
  bucket: candidate.bucket,
  title: candidate.title,
  decision: classifier.scoreCandidate({
    platform: "youtube",
    itemId: candidate.key.replace(/^youtube:/, ""),
    url: candidate.url,
    title: candidate.title,
    visibleText: "",
    transcriptText: "",
    channelName: "",
    previewUrl: candidate.previewUrl
  })
}));
const metadataElapsedMs = performance.now() - startedAt;

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sourceArtifact: path.relative(root, sourcePath).replaceAll("\\", "/"),
  sampleCount: candidates.length,
  metadataFast: summarizeMetadata(metadataRecords, metadataElapsedMs),
  localVisualFast: { requested: options.visualLimit, executed: 0, status: "not_requested", records: [] },
  cloudHeavy: await probeCloud(options.cloudUrl),
  limitations: [
    "Search buckets are intent proxies, not human-reviewed ground truth.",
    "Metadata Fast scores titles and URLs; it is not frame-level authenticity inference.",
    "Local Visual Fast scores thumbnails; it is not full-video or motion inference.",
    "Cloud Heavy counts as executed only when the deployed authenticated GPU endpoint returns model decisions."
  ]
};

if (options.visualLimit > 0) {
  try {
    report.localVisualFast = await auditVisual(candidates.slice(0, options.visualLimit), options);
  } catch (error) {
    report.localVisualFast.status = "error";
    report.localVisualFast.error = error instanceof Error ? error.message : String(error);
  }
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output: outputPath,
  sampleCount: report.sampleCount,
  metadataFast: omitRecords(report.metadataFast),
  localVisualFast: omitRecords(report.localVisualFast),
  cloudHeavy: report.cloudHeavy
}, null, 2));

function parseArgs(args) {
  args = args.filter((value) => value !== "--");
  const result = {
    sampleSize: 150,
    visualLimit: 0,
    source: "dist/qa/youtube-live-audit/youtube-live-audit.json",
    output: "dist/qa/video-150-audit/feed-candidate-audit.json",
    bridgeUrl: "http://127.0.0.1:4317",
    origin: "chrome-extension://nhkffdhagjignajnmlgkgekpkfljhfdd",
    cloudUrl: "https://api.orislop.com",
    pollMs: 1000,
    timeoutMs: 180000
  };
  const keys = {
    "--sample-size": ["sampleSize", number],
    "--visual-limit": ["visualLimit", number],
    "--source": ["source", String],
    "--output": ["output", String],
    "--bridge-url": ["bridgeUrl", String],
    "--extension-origin": ["origin", String],
    "--cloud-url": ["cloudUrl", String],
    "--poll-ms": ["pollMs", number],
    "--batch-timeout-ms": ["timeoutMs", number]
  };
  for (let index = 0; index < args.length; index += 2) {
    const spec = keys[args[index]];
    if (!spec || args[index + 1] == null) throw new Error(`Invalid argument: ${args[index]}`);
    result[spec[0]] = spec[1](args[index + 1]);
  }
  if (result.sampleSize < 1 || result.visualLimit < 0) throw new Error("Sample sizes are invalid");
  result.bridgeUrl = result.bridgeUrl.replace(/\/$/, "");
  result.cloudUrl = result.cloudUrl.replace(/\/$/, "");
  result.origin = result.origin.replace(/\/$/, "");
  return result;
}

function number(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, got ${value}`);
  return parsed;
}

function selectCandidates(audit, limit) {
  const unique = new Map();
  for (const session of audit.sessions || []) {
    for (const item of session.sampledVideos || []) {
      if (!item?.key || unique.has(item.key)) continue;
      const bucket = item.bucket === "educational" ? "educational" : item.bucket === "slop-biased" ? "slop-biased" : "other";
      const videoId = String(item.key).replace(/^youtube:/, "");
      const fallbackPreview = /^[A-Za-z0-9_-]{6,20}$/.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
      unique.set(item.key, {
        key: String(item.key),
        bucket,
        title: String(item.title || "").slice(0, 500),
        url: String(item.url || "").slice(0, 2000),
        previewUrl: /^https:\/\/i\.ytimg\.com\//i.test(String(item.previewUrl || "")) ? String(item.previewUrl) : fallbackPreview
      });
    }
  }
  const values = [...unique.values()];
  const selected = [
    ...values.filter((item) => item.bucket === "slop-biased").slice(0, Math.ceil(limit / 2)),
    ...values.filter((item) => item.bucket === "educational").slice(0, Math.floor(limit / 2))
  ];
  const selectedKeys = new Set(selected.map((item) => item.key));
  for (const item of values) {
    if (selected.length >= limit) break;
    if (!selectedKeys.has(item.key)) selected.push(item);
  }
  return selected.slice(0, limit);
}

function loadClassifier() {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  for (const file of ["aiClassifierModel.generated.js", "classifier.js"]) {
    vm.runInContext(readFileSync(path.join(root, "apps", "extension", "src", file), "utf8"), context, { filename: file });
  }
  return context.OrislopClassifier;
}

function summarizeMetadata(records, elapsedMs) {
  const byBucket = {};
  for (const bucket of ["slop-biased", "educational", "other"]) {
    const group = records.filter((record) => record.bucket === bucket);
    if (!group.length) continue;
    const hardSkips = group.filter((record) => record.decision.recommendation === "skip").length;
    byBucket[bucket] = { count: group.length, hardSkips, hardSkipRate: hardSkips / group.length };
  }
  const knownAi = records.filter((record) => /\b(ai|brain\s*rot|tung\s+tung|tralalero|synthetic|deepfake)\b/i.test(record.title));
  return {
    executed: records.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    underTwoSeconds: elapsedMs <= 2000,
    decisionsPerSecond: Math.round(records.length / Math.max(elapsedMs / 1000, 0.001)),
    skipped: records.filter((record) => record.decision.recommendation === "skip").length,
    watched: records.filter((record) => record.decision.recommendation !== "skip").length,
    knownAiTitleCount: knownAi.length,
    knownAiTitleSkipped: knownAi.filter((record) => record.decision.recommendation === "skip").length,
    byBucket,
    records
  };
}

async function auditVisual(candidates, auditOptions) {
  const records = [];
  const batches = chunk(candidates, 10);
  const runId = Date.now().toString(36);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const startedAt = performance.now();
    let pending = batches[batchIndex].map((candidate, index) => ({
      candidate,
      request: {
        id: `audit-${runId}-${batchIndex}-${index}-${candidate.key.replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 180),
        url: candidate.url,
        mediaUrl: "",
        previewUrl: candidate.previewUrl,
        language: "en",
        priority: batchIndex ? 10 : 0
      }
    }));
    const deadline = Date.now() + auditOptions.timeoutMs;
    while (pending.length && Date.now() < deadline) {
      const payload = await bridgeRequest(auditOptions, pending.map((entry) => entry.request));
      const resultById = new Map(payload.results.map((result) => [result.id, result]));
      pending = pending.filter((entry) => {
        const result = resultById.get(entry.request.id);
        if (!result || ["pending", "provisional"].includes(result.status)) return true;
        records.push({
          key: entry.candidate.key,
          bucket: entry.candidate.bucket,
          status: result.status,
          latencyMs: Math.round(performance.now() - startedAt),
          available: result.lightweight?.available === true,
          lightweightStatus: String(result.lightweight?.status || ""),
          lightweightError: String(result.lightweight?.error || ""),
          synthetic: result.synthetic === true,
          automaticSkipEligible: result.automaticSkipEligible === true,
          score: Number.isFinite(result.score) ? result.score : null,
          reason: String(result.reason || result.error || ""),
          framesAnalyzed: result.lightweight?.frames_analyzed ?? 0
        });
        return false;
      });
      if (pending.length) await delay(auditOptions.pollMs);
    }
    for (const entry of pending) records.push({ key: entry.candidate.key, bucket: entry.candidate.bucket, status: "timeout", latencyMs: auditOptions.timeoutMs });
    console.error(`[feed-audit] Visual batch ${batchIndex + 1}/${batches.length}: ${records.length}/${candidates.length}`);
  }
  const ready = records.filter((record) => record.status === "ready");
  const available = ready.filter((record) => record.available);
  const latencies = ready.map((record) => record.latencyMs).sort((a, b) => a - b);
  return {
    requested: candidates.length,
    executed: ready.length,
    status: ready.length === candidates.length ? "complete" : "partial",
    errors: records.filter((record) => record.status === "error").length,
    timeouts: records.filter((record) => record.status === "timeout").length,
    available: available.length,
    unavailable: ready.length - available.length,
    synthetic: ready.filter((record) => record.synthetic).length,
    automaticSkipEligible: ready.filter((record) => record.automaticSkipEligible).length,
    underTwoSeconds: ready.filter((record) => record.latencyMs <= 2000).length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null },
    records
  };
}

async function bridgeRequest(auditOptions, candidates) {
  const response = await fetch(`${auditOptions.bridgeUrl}/v1/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: auditOptions.origin },
    body: JSON.stringify({ performanceProfile: "fast", candidates })
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.results)) throw new Error(payload.error || `Bridge returned ${response.status}`);
  return payload;
}

async function probeCloud(baseUrl) {
  const config = JSON.parse(readFileSync(path.join(root, "configs", "cloud_heavy_v1.json"), "utf8"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/ready`, { signal: controller.signal });
    return {
      endpoint: baseUrl,
      reachable: response.ok,
      httpStatus: response.status,
      analyzeExecuted: 0,
      reason: response.ok ? "Reachable; authenticated analysis was not run by this local audit." : (await response.text()).slice(0, 300),
      modelBundleVersion: config.modelBundleVersion,
      calibrated: config.calibrated === true,
      betaGatePassed: config.betaGatePassed === true,
      releaseGatePassed: config.releaseGatePassed === true
    };
  } catch (error) {
    return {
      endpoint: baseUrl,
      reachable: false,
      analyzeExecuted: 0,
      reason: error instanceof Error ? error.message : String(error),
      modelBundleVersion: config.modelBundleVersion,
      calibrated: config.calibrated === true,
      betaGatePassed: config.betaGatePassed === true,
      releaseGatePassed: config.releaseGatePassed === true
    };
  } finally {
    clearTimeout(timeout);
  }
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
}

function omitRecords(value) {
  const { records: _records, ...summary } = value;
  return summary;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
