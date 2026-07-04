import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createExistingAiDetectorAdapter,
  createMockEmbeddingAdapter,
  createMockExistingAiDetectorAdapter,
  createMockLocalLlmAdapter,
  createMockOpenClipAdapter,
  createMockOcrAdapter,
  createMockSpatialDetectorAdapter,
  createMockTemporalDetectorAdapter,
  createMockWhisperAdapter,
  createSpatialDetectorAdapter,
  createTemporalDetectorAdapter
} from "../src/index.ts";
import { DEFAULT_ORISLOP_SETTINGS } from "../../shared/src/constants.ts";
import { scoreVideo } from "../../slop-engine/src/scoreVideo.ts";
import { existingAiDetectorSignal } from "../../slop-engine/src/signals/existingAiDetectorSignal.ts";
import { temporalDetectorSignal } from "../../slop-engine/src/signals/temporalDetectorSignal.ts";
import { visualTemplateSignal } from "../../slop-engine/src/signals/visualTemplateSignal.ts";
import { ocrSignal } from "../../slop-engine/src/signals/ocrSignal.ts";
import { claimRiskSignal } from "../../slop-engine/src/signals/claimRiskSignal.ts";
import { embeddingSimilaritySignal } from "../../slop-engine/src/signals/embeddingSimilaritySignal.ts";

await runAdapterChecks();
console.log("Phase 9 local inference adapter checks passed.");

async function runAdapterChecks() {
  const short = makeShort();
  const request = { short };

  const config = JSON.parse(await readFile("configs/model_adapters.json", "utf8"));
  assert.equal(config.version, 1, "model adapter config version is present");
  for (const adapter of Object.values(config.adapters)) {
    assert.equal(adapter.enabled, false, `${adapter.id} is disabled by default`);
    assert(!hasAbsolutePath(adapter), `${adapter.id} config avoids hardcoded absolute paths`);
  }

  const disabledExisting = await createExistingAiDetectorAdapter().analyze(request);
  assertUnavailable(disabledExisting, "disabled existing AI detector is unavailable");
  assert.match(disabledExisting.error, /disabled/i, "disabled existing AI detector explains disabled state");

  const disabledTemporal = await createTemporalDetectorAdapter().analyze(request);
  assertUnavailable(disabledTemporal, "disabled temporal detector is unavailable");
  assert.match(disabledTemporal.error, /disabled/i, "disabled temporal detector explains disabled state");

  const missingExisting = await createExistingAiDetectorAdapter({
    enabled: true,
    mode: "subprocess",
    scriptPath: "missing/existing-ai-detector.py",
    checkpointPath: "missing/existing-ai-detector.ckpt"
  }).analyze({ ...request, mediaPath: "missing/video.mp4" });
  assertUnavailable(missingExisting, "missing existing AI detector paths are unavailable");
  assert.match(missingExisting.error, /does not exist|not configured/i, "missing existing AI detector returns useful error");

  const missingSpatial = await createSpatialDetectorAdapter({
    enabled: true,
    mode: "subprocess",
    scriptPath: "core/spatial.py",
    checkpointPath: "missing/spatial.ckpt"
  }).analyze({ ...request, mediaPath: "missing/video.mp4" });
  assertUnavailable(missingSpatial, "missing spatial model path is unavailable");
  assert.match(missingSpatial.error, /model\/checkpoint|does not exist/i, "missing spatial detector returns useful error");

  const missingTemporal = await createTemporalDetectorAdapter({
    enabled: true,
    mode: "subprocess",
    detectorRoot: "missing/temporal-root",
    scriptPath: "temporal_deepfake_moe_hf_colab.py",
    checkpointPath: "missing-temporal.ckpt"
  }).analyze({ ...request, mediaPath: "missing/video.mp4" });
  assertUnavailable(missingTemporal, "missing temporal detector paths are unavailable");
  assert.match(missingTemporal.error, /Detector root|does not exist|checkpoint/i, "missing temporal detector returns useful error");

  const mockExisting = await createMockExistingAiDetectorAdapter().analyze(request);
  assert.equal(mockExisting.applicable, true, "mock existing AI detector is applicable");
  assert(mockExisting.categories.includes("possible_unlabeled_ai"), "mock existing AI detector emits possible_unlabeled_ai");

  const disabledExistingSignal = existingAiDetectorSignal(mockExisting, DEFAULT_ORISLOP_SETTINGS);
  assert.equal(disabledExistingSignal.applicable, false, "existing AI signal is disabled by default settings");

  const enabledExistingSettings = {
    ...DEFAULT_ORISLOP_SETTINGS,
    enableExistingAiDetector: true
  };
  const enabledExistingSignal = existingAiDetectorSignal(mockExisting, enabledExistingSettings);
  assert.equal(enabledExistingSignal.applicable, true, "existing AI signal can be enabled");
  const scoredWithExistingAi = scoreVideo(short, enabledExistingSettings, {
    adapterSignals: [enabledExistingSignal],
    createdAt: "2026-06-25T00:00:00.000Z"
  });
  assert.equal(scoredWithExistingAi.possibleUnlabeledAiScore, mockExisting.score, "existing AI adapter can set possibleUnlabeledAiScore when enabled");
  assert.equal(scoredWithExistingAi.action, "skip", "enabled possible AI adapter can affect scoring");

  const mockTemporal = await createMockTemporalDetectorAdapter().analyze(request);
  const temporalDisabledSignal = temporalDetectorSignal(mockTemporal, DEFAULT_ORISLOP_SETTINGS);
  assert.equal(temporalDisabledSignal.applicable, false, "temporal signal is disabled by default settings");
  const temporalEnabledSignal = temporalDetectorSignal(mockTemporal, {
    ...DEFAULT_ORISLOP_SETTINGS,
    enableTemporalDetector: true
  });
  assert.equal(temporalEnabledSignal.applicable, true, "temporal signal can be enabled");

  const optionalSignals = [
    embeddingSimilaritySignal(await createMockEmbeddingAdapter().analyze(request), { ...DEFAULT_ORISLOP_SETTINGS, enableDeepScan: true }),
    visualTemplateSignal(await createMockOpenClipAdapter().analyze(request), { ...DEFAULT_ORISLOP_SETTINGS, enableOpenClip: true }),
    ocrSignal(await createMockOcrAdapter().analyze(request), { ...DEFAULT_ORISLOP_SETTINGS, enableOcr: true }),
    claimRiskSignal(await createMockLocalLlmAdapter().analyze(request), { ...DEFAULT_ORISLOP_SETTINGS, enableLocalLlm: true }),
    visualTemplateSignal(await createMockSpatialDetectorAdapter().analyze(request), { ...DEFAULT_ORISLOP_SETTINGS, enableOpenClip: true }),
    temporalEnabledSignal
  ];
  assert(optionalSignals.some((signal) => signal.applicable), "mock adapter signals can be converted for scoring");

  const whisperDisabled = ocrSignal(await createMockWhisperAdapter().analyze(request), DEFAULT_ORISLOP_SETTINGS);
  assert.equal(whisperDisabled.applicable, false, "mock outputs stay inert when passed through a disabled setting");

  const baseline = scoreVideo(short, DEFAULT_ORISLOP_SETTINGS, {
    createdAt: "2026-06-25T00:00:00.000Z"
  });
  const disabledAdapterScore = scoreVideo(short, DEFAULT_ORISLOP_SETTINGS, {
    adapterSignals: [disabledExistingSignal, temporalDisabledSignal],
    createdAt: "2026-06-25T00:00:00.000Z"
  });
  assert.equal(disabledAdapterScore.possibleUnlabeledAiScore, baseline.possibleUnlabeledAiScore, "disabled adapters do not change score output");
  assert.equal(disabledAdapterScore.action, baseline.action, "disabled adapters do not change action");
}

function assertUnavailable(result, label) {
  assert.equal(result.applicable, false, label);
  assert.equal(result.score, null, `${label}: score is null`);
  assert.equal(typeof result.error, "string", `${label}: error is useful`);
}

function hasAbsolutePath(adapter) {
  return [
    adapter.modelPath,
    adapter.checkpointPath,
    adapter.configPath,
    adapter.detectorRoot,
    adapter.scriptPath,
    adapter.thresholdPath,
    ...(adapter.checkpointPaths ?? [])
  ].some((value) => typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value));
}

function makeShort() {
  return {
    url: "https://www.youtube.com/shorts/mock-ai-deepfake",
    videoId: "mock-ai-deepfake",
    title: "Synthetic AI deepfake money trick over Minecraft gameplay",
    channelName: "Mock Channel",
    channelUrl: "https://www.youtube.com/@mock",
    description: null,
    hashtags: ["#ai", "#deepfake"],
    visiblePageText: "Generated video says a guaranteed secret cure can double your money. AITA story time part 2 with text message overlay.",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: "Ask Reddit story time part 2 about a generated video."
  };
}
