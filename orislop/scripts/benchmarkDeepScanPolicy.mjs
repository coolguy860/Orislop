import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseDeepScanPolicyFromBenchmarks } from "../packages/slop-engine/src/deepScan/deepScanPolicy.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = join(root, "configs", "model_adapters.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const maxRuntimeMs = Number(process.env.ORISLOP_DEEP_SCAN_MAX_RUNTIME_MS ?? 1500);
const tokenPresent = Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN);

const detectorIds = [
  "existing_ai_detector",
  "spatial_detector",
  "temporal_detector",
  "fusion_detector"
];

const benchmarks = [];
for (const detectorId of detectorIds) {
  const adapter = config.adapters?.[detectorId];
  if (!adapter) {
    continue;
  }

  const localPath = adapter.localModelDirectory ?? adapter.modelPath ?? adapter.checkpointPath ?? adapter.detectorRoot ?? null;
  const exists = localPath ? await pathExists(resolve(root, localPath)) : false;
  const runtimeEnv = process.env[`ORISLOP_${detectorId.toUpperCase()}_RUNTIME_MS`];
  const runtimeMs = runtimeEnv ? Number(runtimeEnv) : null;
  benchmarks.push({
    detectorId,
    available: exists && runtimeMs !== null && Number.isFinite(runtimeMs),
    runtimeMs: runtimeMs !== null && Number.isFinite(runtimeMs) ? runtimeMs : null
  });
}

const policy = chooseDeepScanPolicyFromBenchmarks(benchmarks, maxRuntimeMs);
console.log(JSON.stringify({
  tokenPresent,
  note: "No models were downloaded. Configure full Hugging Face repo IDs and run a separate explicit setup step before enabling app deep scan.",
  maxRuntimeMs,
  benchmarks,
  recommendedPolicy: policy
}, null, 2));

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
