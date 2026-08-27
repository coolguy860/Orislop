import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRoot = path.join(repoRoot, "apps", "extension", "dist");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], { cwd: repoRoot, stdio: "inherit" });

const requiredFiles = [
  "manifest.json", "oauthConfig.generated.js", "slopPreferences.js", "aiClassifierModel.generated.js", "classifier.js", "platformAdapters.js", "controlCore.js", "background.js",
  "contentScript.js", "contentStyles.css", "popup.html", "popup.css", "popup.js", "release-info.json",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png", "icons/icon256.png"
];
for (const file of requiredFiles) assert.ok(existsSync(path.join(distRoot, file)), `Expected ${file} in extension dist`);

const manifest = readJson("manifest.json");
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.4.0");
assert.equal(manifest.name, "Orislop");
assert.ok(Object.values(manifest.icons).every((icon) => icon.endsWith(".png")), "manifest icons must be Chrome-compatible raster files");
assert.deepEqual(manifest.permissions, ["storage", "webRequest"]);
assert.deepEqual(manifest.content_scripts[0].matches, ["https://www.youtube.com/*", "https://m.youtube.com/*"]);
assert.deepEqual(manifest.host_permissions, [
  "https://www.youtube.com/*",
  "https://m.youtube.com/*",
  "https://*.googlevideo.com/*",
  "http://127.0.0.1:4317/*",
  "http://localhost:4317/*"
]);
assert.ok(manifest.host_permissions.includes("http://127.0.0.1:4317/*"));
assert.ok(!manifest.host_permissions.some((origin) => origin.includes(":11434")), "the extension must reach Ollama only through the origin-locked companion");
assert.ok(!manifest.host_permissions.some((origin) => /instagram|tiktok|linkedin|api\.orislop/i.test(origin)), "the YouTube MVP must not request dropped-platform or cloud API access");
assert.equal(manifest.optional_host_permissions, undefined);
assert.deepEqual(manifest.content_scripts[0].js, ["slopPreferences.js", "aiClassifierModel.generated.js", "classifier.js", "platformAdapters.js", "controlCore.js", "contentScript.js"]);

const slopPreferencesSource = read("slopPreferences.js");
const generatedModel = read("aiClassifierModel.generated.js");
const classifierSource = read("classifier.js");
const platformAdaptersSource = read("platformAdapters.js");
const controlCoreSource = read("controlCore.js");
const contentSource = read("contentScript.js");
const styles = read("contentStyles.css");
const background = read("background.js");
const popupHtml = read("popup.html");
const popupJs = read("popup.js");

assert.ok(background.includes('inferenceMode === "hybrid"'), "background must support Hybrid local Fast plus Cloud Heavy");
assert.ok(background.includes("FORCE_HEAVY_FOR_ALL_MEDIA = true"), "every eligible media item must be forced through Heavy analysis");
assert.ok(background.includes('performanceProfile = FORCE_HEAVY_FOR_ALL_MEDIA'), "forced Heavy must control the detector request profile");
assert.ok(!contentSource.includes("showExplainControl"), "the YouTube content path must not render an Explain video control");
assert.ok(!contentSource.includes('className = "orislop-cover-explain-button"'), "filtered covers must not render an Ask action");
assert.ok(contentSource.includes("actions.append(keepButton, skipButton)"), "filtered covers must expose only Show and Hide actions");
assert.ok(background.includes("/v2/auth/google"), "cloud beta must use Google account authentication");
assert.ok(background.includes("code_challenge_method: \"S256\""), "Google authorization must use PKCE S256");
assert.ok(background.includes("CLOUD_ACCESS_KEY") && background.includes("chrome.storage.session"), "short-lived access tokens must use session storage");
assert.ok(background.includes("/v2/auth/refresh") && background.includes("/v2/auth/logout"), "cloud sessions must rotate and support sign-out");
assert.ok(background.includes("Account deletion was not confirmed"), "account deletion must not clear retry credentials without server confirmation");
assert.ok(popupJs.includes("response?.ok && response?.deleted === true"), "the popup must keep signed-in state when account deletion fails");
assert.ok(background.includes('setBadgeText({ text: enabled ? "ON" : "OFF" })'), "toolbar badge must always show whether protection is on");
assert.ok(background.includes("updateBadgeFromHealth"), "toolbar badge must reflect real core-engine health");
assert.ok(popupHtml.includes('id="inferenceMode"'), "popup must expose the local/hybrid inference selector");
assert.ok(popupHtml.includes('value="hybrid"'), "popup must expose Hybrid local Fast plus cloud Heavy mode");
assert.ok(popupHtml.indexOf('oauthConfig.generated.js') < popupHtml.indexOf('popup.js'), "popup must load the build-specific cloud configuration before rendering controls");
assert.ok(popupJs.includes("CLOUD_BETA_CONFIGURED") && popupJs.includes("hybridOption.disabled"), "local-only builds must disable unavailable Hybrid controls");
assert.ok(popupHtml.includes('id="performanceMode" disabled'), "the forced-Heavy build must lock its performance selector");
assert.ok(popupHtml.includes("Heavy · always on"), "the popup must disclose that Heavy analysis is always active");
assert.ok(background.includes("hardwareConcurrency"), "automatic mode must inspect the browser CPU hint");
assert.ok(background.includes("deviceMemory"), "automatic mode must inspect the browser memory hint when available");
assert.ok(background.includes("performanceProfile,"), "the resolved profile must reach the detector bridge");
assert.ok(background.includes("classifyWithHybridDetector"), "background must coordinate Local Fast and Cloud Heavy");
assert.ok(background.includes("HYBRID_HEAVY_DECISION_BUDGET_MS = 120000"), "private Heavy scans must have enough time to finish the full GPU stack");
assert.ok(background.includes("forceHeavyAnalysis"), "short-form videos must force the Heavy detector path");
assert.ok(background.includes("chrome.webRequest?.onBeforeRequest"), "the service worker must observe actual browser video requests");
assert.ok(background.includes("/v1/media-upload"), "the browser must upload captured video bytes before Heavy inference");
assert.ok(background.includes("mediaUploadId:"), "Heavy candidates must carry the verified browser upload id");
assert.ok(contentSource.includes("findRecentDirectMediaResource"), "blob-backed social players must recover their signed direct media resource for Heavy scanning");
assert.ok(background.includes('executionPath: heavyEscalated ? "local_fast_after_heavy_fallback_locked" : "local_fast_decisive_locked"'), "clear Local Fast decisions must avoid Heavy and become immutable");
assert.ok(background.includes('"cloud_heavy_parallel_local_preprocess_locked" : "cloud_heavy_after_fast_locked"'), "Cloud Heavy must support both selective Fast-first and capable-client parallel execution");
assert.ok(background.includes("heavyEscalationReason"), "Hybrid routing must record why an item consumed Heavy compute");
assert.ok(background.includes('cloudEffective: "heavy"'), "Hybrid mode must reserve full Heavy inference for the cloud");
assert.ok(contentSource.includes('performanceMode: "heavy"'), "The private test release must exercise Heavy by default");
assert.ok(contentSource.includes('orislop.extension.scanStatus'), "content script must publish visible live-scanner status");
assert.ok(contentSource.includes('message?.type !== "orislop.scanNow"'), "users must be able to trigger a fresh scan from the popup");
assert.ok(!contentSource.includes('button.textContent = "Ask Orislop"'), "YouTube must not show an Ask Orislop button");
assert.ok(styles.includes(".orislop-live-indicator"), "supported pages must visibly confirm live scanning");
assert.ok(!popupJs.includes("cloudApiToken"), "manually pasted cloud tokens must be removed");
assert.ok(popupHtml.includes("Sign in with Google and enable Cloud Heavy"), "first-run cloud transmission must require an affirmative disclosure action");
assert.ok(popupHtml.includes('id="cloudDeleteAccountButton"'), "signed-in users must be able to delete their beta account");

const weakPerformance = resolveBackgroundPerformance(background, { cores: 4, memoryGiB: 4 }, { performanceMode: "auto", inferenceMode: "local" });
const strongPerformance = resolveBackgroundPerformance(background, { cores: 16, memoryGiB: 8 }, { performanceMode: "auto", inferenceMode: "local" });
const ambiguousPerformance = resolveBackgroundPerformance(background, { cores: 6, memoryGiB: 0 }, { performanceMode: "auto", inferenceMode: "local" });
const manualHeavyPerformance = resolveBackgroundPerformance(background, { cores: 4, memoryGiB: 4 }, { performanceMode: "heavy", inferenceMode: "local" });
const hybridPerformance = resolveBackgroundPerformance(background, { cores: 16, memoryGiB: 16 }, { performanceMode: "heavy", inferenceMode: "hybrid" });
const automaticCpuPerformance = await resolveBackgroundDetectorPerformance(background, { cores: 16, memoryGiB: 16 }, { performanceMode: "auto", inferenceMode: "local" }, "cpu");
const automaticGpuPerformance = await resolveBackgroundDetectorPerformance(background, { cores: 16, memoryGiB: 16 }, { performanceMode: "auto", inferenceMode: "local" }, "cuda");
assert.equal(weakPerformance.effective, "heavy", "forced Heavy must override weak hardware hints");
assert.equal(strongPerformance.effective, "heavy", "Automatic must choose Heavy for strong hardware hints");
assert.equal(ambiguousPerformance.effective, "heavy", "forced Heavy must override ambiguous hardware hints");
assert.equal(manualHeavyPerformance.effective, "heavy", "manual Heavy must override weak local hardware hints");
assert.equal(hybridPerformance.effective, "heavy", "forced Heavy must bypass Hybrid Fast-first routing");
assert.equal(hybridPerformance.cloudEffective, "heavy", "Hybrid compatibility metadata must still identify Heavy");
assert.equal(automaticCpuPerformance.effective, "heavy", "forced Heavy must remain active even when the companion reports CPU");
assert.equal(automaticGpuPerformance.effective, "heavy", "Automatic may use local Heavy when the companion confirms an accelerator");
assert.ok(background.includes("requestCloudHeavyBatch"), "Hybrid refinement must use the v2 Cloud Heavy contract");
assert.ok(background.includes("/v2/analyze/batch"), "loaded feed refinement must coalesce new Cloud Heavy submissions");
assert.ok(background.includes("batchResponse.status === 404"), "cloud batching must remain compatible with an older single-item deployment");
assert.ok(background.includes("requestLocalDetectorBatch"), "progressive lookahead must coalesce local detector work");
assert.ok(background.includes("LOCAL_DETECTOR_COALESCE_MS = 20"), "local detector coalescing must stay fast enough for lookahead");
assert.ok(background.includes("offset += MAX_BATCH_SIZE"), "coalesced detector work must remain bounded by the bridge batch limit");
assert.ok(background.includes("/v2/analyze/"), "pending Cloud Heavy decisions must be polled by decision ID");
assert.ok(background.includes("directMediaUrl"), "cloud analysis must send only the direct media stream exposed by the media element");

const hybridRuntime = createHybridBackgroundRuntime(background);
const hybridSettings = { inferenceMode: "hybrid", performanceMode: "auto", cloudApiUrl: "https://api.orislop.com" };
const firstHybrid = await hybridRuntime.classify([
  { index: 0, candidate: { itemKey: "youtube:first", itemId: "first", url: "https://www.youtube.com/watch?v=first", previewUrl: "https://i.ytimg.com/vi/first/hqdefault.jpg" } }
], [{ recommendation: "watch" }], hybridSettings);
assert.equal(firstHybrid.decisions.get(0).executionPath, "local_fast_decisive_locked", "a clear Fast result must lock without consuming Heavy compute");
assert.equal(firstHybrid.decisions.get(0).decisionLocked, true);
hybridRuntime.markCloudReady(hybridSettings);
hybridRuntime.setLocalDecision({ status: "ready", synthetic: false, score: 58, reason: "Borderline Local Fast result", lightweight: { available: true, status: "ready", ai_probability: 0.58 } });
const secondHybrid = await hybridRuntime.classify([
  { index: 0, candidate: { itemKey: "youtube:second", itemId: "second", url: "https://www.youtube.com/watch?v=second", mediaUrl: "https://example.com/video.mp4" } }
], [{ recommendation: "watch" }], hybridSettings);
assert.equal(secondHybrid.decisions.get(0).executionPath, "cloud_heavy_after_fast_locked", "Heavy must take ownership only after Fast identifies a reason to escalate");
assert.equal(secondHybrid.decisions.get(0).decisionLocked, true);
assert.deepEqual(hybridRuntime.analysisOrder().slice(-2), ["local_fast", "cloud_heavy"], "Hybrid must finish Fast before it submits Heavy analysis");
assert.equal(hybridRuntime.cloudAuthorization(), "Bearer test-access", "Heavy requests must remain authenticated");
const cloudRequestsAfterEscalation = hybridRuntime.cloudRequestCount();
hybridRuntime.setLocalDecision({ status: "ready", synthetic: false, score: 8, reason: "Clear Local Fast result", lightweight: { available: true, status: "ready", ai_probability: 0.08 } });
const clearHybrid = await hybridRuntime.classify([
  { index: 0, candidate: { itemKey: "youtube:third", itemId: "third", url: "https://www.youtube.com/watch?v=third", mediaUrl: "https://example.com/third.mp4" } }
], [{ recommendation: "watch" }], hybridSettings);
assert.equal(clearHybrid.decisions.get(0).executionPath, "local_fast_decisive_locked");
assert.equal(clearHybrid.decisions.get(0).cloudHeavyStatus, "not_needed");
assert.equal(hybridRuntime.cloudRequestCount(), cloudRequestsAfterEscalation, "clear Fast results must not consume Cloud Heavy requests");
hybridRuntime.setLocalDecision({ status: "ready", synthetic: false, score: 8, reason: "Parallel local context", lightweight: { available: true, status: "ready", ai_probability: 0.08 } });
const explicitHeavyStart = hybridRuntime.analysisOrder().length;
const explicitHeavy = await hybridRuntime.classify([
  { index: 0, candidate: { itemKey: "youtube:heavy", itemId: "heavy", url: "https://www.youtube.com/watch?v=heavy", mediaUrl: "https://example.com/heavy.mp4" } }
], [{ recommendation: "watch" }], { ...hybridSettings, performanceMode: "heavy" });
assert.equal(explicitHeavy.decisions.get(0).executionPath, "cloud_heavy_parallel_local_preprocess_locked", "explicit Heavy must use the full cloud stack while capable clients prepare context locally");
assert.deepEqual(hybridRuntime.analysisOrder().slice(explicitHeavyStart, explicitHeavyStart + 2), ["cloud_heavy", "local_fast"], "capable clients must submit Heavy without waiting for local context preparation");

for (const [name, source] of [["slop preferences", slopPreferencesSource], ["classifier", classifierSource], ["platform adapters", platformAdaptersSource], ["control core", controlCoreSource], ["content script", contentSource], ["background", background], ["popup", popupJs]]) {
  assert.doesNotThrow(() => new Function(source), `${name} should parse as JavaScript`);
}

const classifier = createClassifierRuntime(slopPreferencesSource, generatedModel, classifierSource);
const slopPreferences = createSlopPreferenceRuntime(slopPreferencesSource);
const platformAdapters = createPlatformAdapterRuntime(platformAdaptersSource);
const contentRuntime = createContentRuntime(contentSource);
assert.equal(slopPreferences.definitions.length, 12, "the shipping taxonomy must contain all 12 filtering choices");
assert.deepEqual(
  Array.from(slopPreferences.defaultIds),
  Array.from(slopPreferences.definitions, ({ id }) => id),
  "a new install must enable every shipping filter"
);
assert.deepEqual(
  Array.from(slopPreferences.normalize(undefined)),
  Array.from(slopPreferences.defaultIds),
  "missing preferences must normalize to all filters"
);
const filterDefaultsMigration = await createFilterDefaultsMigrationRuntime(background, Array.from(slopPreferences.defaultIds));
assert.equal(filterDefaultsMigration.storage["orislop.extension.settings"].enabled, false, "the migration must preserve the existing master toggle");
assert.deepEqual(
  Array.from(filterDefaultsMigration.storage["orislop.extension.settings"].slopPreferences),
  Array.from(slopPreferences.defaultIds),
  "the first upgraded run must replace an older subset with every filter"
);
assert.equal(filterDefaultsMigration.storage["orislop.extension.filterDefaultsVersion"], 1, "the migration must record its schema version");
filterDefaultsMigration.storage["orislop.extension.settings"].slopPreferences = ["compilations"];
await filterDefaultsMigration.ensure();
assert.deepEqual(
  Array.from(filterDefaultsMigration.storage["orislop.extension.settings"].slopPreferences),
  ["compilations"],
  "later user choices must not be overwritten after the one-time migration"
);
assert.equal(
  contentRuntime.api.normalizeSettings({ ollamaModel: "qwen2.5:1.5b-instruct" }).ollamaModel,
  "orislop-qwen2.5:1.5b-instruct",
  "persisted legacy model settings must migrate to the companion-installed Vast model"
);
assert.equal(
  contentRuntime.api.findRecentDirectMediaResource("youtube"),
  "https://r1---sn-test.googlevideo.com/videoplayback?mime=video%2Fmp4&id=video",
  "YouTube blob playback must recover the signed video resource and ignore a newer audio-only stream"
);
assert.equal(contentRuntime.api.isSponsoredCandidate({
  matches: () => true,
  closest: () => null,
  querySelectorAll: () => []
}), true, "known platform ad roots must never consume inference capacity");
assert.equal(contentRuntime.api.isSponsoredCandidate({
  matches: () => false,
  closest: () => null,
  querySelectorAll: () => [{ textContent: "Sponsored", getAttribute: () => null }]
}), true, "visible sponsored badges must exclude an ad from scanning");
assert.equal(contentRuntime.api.isSponsoredCandidate({
  matches: () => false,
  closest: () => null,
  querySelectorAll: () => [{ textContent: "How sponsorships work", getAttribute: () => null }]
}), false, "ordinary editorial discussion of sponsorships must remain scannable");
assert.equal(contentRuntime.api.isSponsoredCandidate({
  matches: () => false,
  closest: () => null,
  querySelectorAll: () => []
}, {
  title: "Made effortless for home cooks.SponsoredGozneyWatch",
  visibleText: ""
}), true, "concatenated YouTube sponsored metadata must not enter inference queues");
assert.equal(contentRuntime.api.explanationModeForDecision({ recommendation: "watch" }), "explain");
assert.equal(contentRuntime.api.explanationModeForDecision({ hardFactContradiction: true }), "why_wrong");
assert.equal(contentRuntime.api.explanationModeForDecision({ factCheckDecision: { verdict: "contradicted" } }), "why_wrong");
assert.equal(contentRuntime.api.isDecisionTerminal({
  detectorStatus: "provisional",
  ollamaStatus: "available",
  factCheckEligible: false
}, { title: "Current video", transcriptText: "A complete transcript is available." }), false, "provisional Heavy results must never become permanently locked");
assert.equal(contentRuntime.api.isDecisionTerminal({
  detectorStatus: "ready",
  ollamaStatus: "available",
  factCheckEligible: false
}, { title: "Current video", transcriptText: "A complete transcript is available." }), true, "fully settled video decisions should be cached");
const refreshNow = 1_000_000;
assert.equal(contentRuntime.api.shouldRefreshDecision({
  hardAiSynthetic: false,
  transcriptChecked: true,
  detectorStatus: "available",
  detectorCheckedAt: refreshNow,
  factCheckEligible: true,
  factCheckStatus: "pending",
  factCheckedAt: refreshNow - 9_000
}, { transcriptText: "" }, refreshNow), true, "pending fact checks must be polled after their retry interval");
assert.equal(contentRuntime.api.shouldRefreshDecision({
  hardAiSynthetic: false,
  transcriptChecked: true,
  detectorStatus: "pending",
  detectorCheckedAt: refreshNow - 5_000,
  factCheckEligible: false,
  factCheckStatus: "not_applicable",
  factCheckedAt: refreshNow
}, { transcriptText: "" }, refreshNow), true, "pending visual decisions must be polled after their retry interval");
assert.equal(contentRuntime.api.shouldRefreshDecision({
  hardAiSynthetic: false,
  transcriptChecked: true,
  detectorStatus: "available",
  detectorCheckedAt: refreshNow,
  factCheckEligible: true,
  factCheckStatus: "available",
  factCheckedAt: refreshNow
}, { transcriptText: "" }, refreshNow), false, "settled decisions must remain cached");
assert.equal(contentRuntime.api.shouldRefreshDecision({
  decisionLocked: true,
  detectorStatus: "provisional",
  detectorCheckedAt: refreshNow - 60_000,
  factCheckEligible: true,
  factCheckStatus: "pending",
  factCheckedAt: refreshNow - 60_000
}, { transcriptText: "a newly available transcript" }, refreshNow), false, "visible decisions must never flip after Local Fast locks them");
const scoringBatches = contentRuntime.api.createScoringBatches([
  { id: "future-1", current: false },
  { id: "current", current: true },
  { id: "future-2", current: false },
  { id: "future-3", current: false },
  { id: "future-4", current: false }
]);
assert.equal(JSON.stringify(scoringBatches.map((batch) => Array.from(batch, (item) => item.id))), JSON.stringify([["current"], ["future-1", "future-2", "future-3", "future-4"]]), "loaded candidates must share bounded fast batches");
const allLoadedJobs = [
  { id: "current", current: true, scanPriority: 0 },
  ...Array.from({ length: 27 }, (_, index) => ({ id: `loaded-${index + 1}`, current: false, scanPriority: index < 5 ? 1 : 10 + index }))
];
const allLoadedBatches = contentRuntime.api.createScoringBatches(allLoadedJobs);
assert.deepEqual(allLoadedBatches.map((batch) => batch.length), [1, 10, 10, 7], "every loaded item must be retained across bounded batches");
assert.equal(allLoadedBatches.flat().length, 28, "all-loaded scanning must not silently drop off-screen feed items");
const concurrencyOrder = [];
await contentRuntime.api.runBatchesWithConcurrency([[1], [2], [3]], async (batch) => concurrencyOrder.push(batch[0]), 2);
assert.deepEqual([...concurrencyOrder].sort(), [1, 2, 3], "bounded background lanes must process every batch exactly once");
assert.equal(contentRuntime.api.shouldShieldCandidate({
  hardAiSynthetic: false,
  educationalProtected: false,
  hardStackedFormat: false,
  strongEvidenceCount: 2,
  sourceScores: { heuristic: 62 }
}), true, "strong local risk must be shielded while Qwen verifies it");
assert.equal(contentRuntime.api.shouldShieldCandidate({
  hardAiSynthetic: false,
  educationalProtected: true,
  hardStackedFormat: true,
  strongEvidenceCount: 3,
  sourceScores: { heuristic: 90 }
}), false, "educational context must never receive a speculative pre-scan shield");
assert.equal(contentRuntime.api.shouldShieldCandidate({
  hardAiSynthetic: false,
  educationalProtected: false,
  hardStackedFormat: false,
  strongEvidenceCount: 0,
  sourceScores: { heuristic: 12 }
}), false, "ordinary low-risk content must remain visible during refinement");
assert.equal(contentRuntime.api.calculateSavedSeconds({ durationSeconds: 125, playbackPositionSeconds: 20 }, "user_skip"), 20);
assert.equal(contentRuntime.api.calculateSavedSeconds({ durationSeconds: 125, playbackPositionSeconds: 20 }, "hidden_before_view"), 20);
const playback = contentRuntime.createPlaybackFixture();
contentRuntime.api.suppressPlayback(playback.root, "youtube:blocked");
assert.equal(playback.media.muted, true);
assert.equal(playback.media.volume, 0);
assert.equal(playback.media.paused, true);
playback.media.paused = false;
contentRuntime.api.enforcePlaybackSuppression({ target: playback.media });
assert.equal(playback.media.paused, true, "sites must not be able to restart blocked media behind the cover");
contentRuntime.api.releaseSuppressedPlayback("youtube:blocked", true);
assert.equal(playback.media.muted, false);
assert.equal(playback.media.volume, 0.75);
assert.equal(playback.media.playCalls, 1, "Show must restore playback that Orislop interrupted");
const reusedPlayback = contentRuntime.createPlaybackFixture();
contentRuntime.api.suppressPlayback(reusedPlayback.root, "youtube:old-item");
contentRuntime.api.suppressPlayback(reusedPlayback.root, "youtube:new-item");
contentRuntime.api.releaseSuppressedPlayback("youtube:old-item", false);
assert.equal(reusedPlayback.media.muted, true, "releasing a stale item must not unlock media owned by a newer decision");
contentRuntime.api.releaseSuppressedPlayback("youtube:new-item", true);
assert.equal(reusedPlayback.media.muted, false);
assert.equal(reusedPlayback.media.volume, 0.75);
  assert.deepEqual(Array.from(platformAdapters.supportedPlatforms), ["youtube", "instagram", "tiktok", "linkedin"]);
assert.equal(platformAdapters.isItemHref("instagram", "/reel/C123abc/"), true);
assert.equal(platformAdapters.isItemHref("instagram", "/explore/"), false);
assert.equal(platformAdapters.isItemHref("tiktok", "https://www.tiktok.com/@creator/video/741234567890"), true);
  assert.equal(platformAdapters.isItemHref("tiktok", "https://www.tiktok.com/explore"), false);
  assert.equal(platformAdapters.isItemHref("linkedin", "https://www.linkedin.com/feed/update/urn:li:activity:123456789/"), true);
  assert.equal(platformAdapters.isItemHref("linkedin", "https://www.linkedin.com/jobs/view/123456789/"), false);
assert.ok(platformAdaptersSource.includes("function advanceOne"), "short-form adapters must expose one-item advancement");
assert.equal((platformAdaptersSource.match(/button\.click\(\)/g) || []).length, 1, "the adapter may issue only one semantic next-button click");
assert.equal(platformAdapters.profileNameFromHref("instagram", "/science.lab/"), "science.lab");
assert.equal(platformAdapters.profileNameFromHref("instagram", "/explore/"), "");
  assert.equal(platformAdapters.profileNameFromHref("tiktok", "/@historyteacher"), "historyteacher");
  assert.equal(platformAdapters.profileNameFromHref("linkedin", "/in/alex-example/"), "alex-example");
assert.equal(
  platformAdapters.chooseCaption(["12.4K", "Like", "science.lab", "A new study explains why the sky appears blue."], "science.lab"),
  "A new study explains why the sky appears blue."
);
const obviousSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "slop123",
  url: "https://www.youtube.com/shorts/slop123",
  title: "AI voice Reddit story over Minecraft parkour",
  visibleText: "Text to speech over looping gameplay. Follow for part 2.",
  channelName: "Story Bot"
});
assert.equal(obviousSlop.recommendation, "skip");
assert.equal(obviousSlop.score, 100);
assert.equal(obviousSlop.hardAiSynthetic, true);
assert.ok(obviousSlop.strongEvidenceCount >= 2);

const recycledAiClips = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "clips123",
  url: "https://www.tiktok.com/@farm/video/clips123",
  title: "Viral clips compilation",
  visibleText: "AI voice narration. Reposted clips with no commentary.",
  channelName: "Viral Vault"
});
assert.equal(recycledAiClips.recommendation, "skip");

const educationalShort = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "edu123",
  url: "https://www.youtube.com/shorts/edu123",
  title: "How black holes bend light",
  visibleText: "A physics professor explains gravitational lensing with evidence and a classroom diagram.",
  channelName: "Minute Science Lab"
});
assert.equal(educationalShort.recommendation, "watch");
assert.equal(educationalShort.educationalProtected, true);
assert.equal(educationalShort.factCheckEligible, true, "informational Shorts should enter source verification");

const technicalCourseWithoutTutorialWord = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "php-food-order",
  url: "https://www.youtube.com/watch?v=php-food-order",
  title: "Complete Food Order Website [ PHP and MySQL ]",
  visibleText: "Build a database-backed project from start to finish.",
  transcriptText: "We create the schema, connect PHP to MySQL, and implement each page.",
  channelName: "Web Development School"
});
assert.equal(technicalCourseWithoutTutorialWord.educationalProtected, true, "technical course titles must receive the educational safety guard");
const guardedTechnicalCourse = classifier.mergeOllamaDecision(technicalCourseWithoutTutorialWord, {
  available: true,
  verdict: "skip",
  category: "low_quality",
  confidence: 0.93,
  reason: "The model judged the project video low value"
});
assert.equal(guardedTechnicalCourse.recommendation, "watch", "an uncorroborated Qwen false positive must not hide a technical course");

const academicGravityLecture = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "gravity-course",
  url: "https://www.youtube.com/watch?v=gravity-course",
  title: "1. Emergence of Gravity",
  visibleText: "MIT OpenCourseWare",
  channelName: "MIT OpenCourseWare"
});
assert.equal(academicGravityLecture.educationalProtected, true);

const gravityVisualization = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "gravity-visualized",
  url: "https://www.youtube.com/watch?v=gravity-visualized",
  title: "Gravity Visualized",
  visibleText: "A visualization of gravitational motion.",
  channelName: "Science Lab"
});
assert.equal(gravityVisualization.educationalProtected, true);

const aiDisclosureOnly = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "art123",
  url: "https://www.youtube.com/shorts/art123",
  title: "Animating a watercolor landscape",
  visibleText: "Created or altered with AI. Original artist process and commentary.",
  channelName: "Mira Studio"
});
assert.equal(aiDisclosureOnly.recommendation, "skip", "AI disclosure must trigger the hard Skip override");
assert.equal(aiDisclosureOnly.score, 100);
assert.equal(aiDisclosureOnly.hardAiSynthetic, true);

const explicitAiGenerated = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "aicat123",
  url: "https://www.tiktok.com/@farm/video/aicat123",
  title: "AI generated cat video",
  visibleText: "Made with AI",
  channelName: "Cat Factory"
});
assert.equal(explicitAiGenerated.recommendation, "skip");
assert.equal(explicitAiGenerated.score, 100);

const aiAllowedByFeedChoices = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "allowed-ai-cat",
  url: "https://www.tiktok.com/@artist/video/allowed-ai-cat",
  title: "AI generated cat video",
  visibleText: "Made with AI",
  channelName: "Cat Studio",
  slopPreferences: []
});
assert.equal(aiAllowedByFeedChoices.recommendation, "watch", "an explicitly unselected slop category must stay visible");
assert.equal(aiAllowedByFeedChoices.hardAiSynthetic, false);
assert.ok(aiAllowedByFeedChoices.slopCategories.includes("fully_ai_generated_video"), "allowed content should retain an advisory category");

const compilationPreferenceOnly = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "compilation-only",
  url: "https://www.youtube.com/shorts/compilation-only",
  title: "Top 10 viral clips compilation",
  visibleText: "A clip collection with no commentary.",
  channelName: "Clip Vault",
  slopPreferences: ["compilations"]
});
const compilationPreferenceSkip = classifier.mergeOllamaDecision(compilationPreferenceOnly, {
  available: true,
  verdict: "skip",
  category: "compilation",
  confidence: 0.91,
  reason: "Low-originality clip compilation"
});
assert.equal(compilationPreferenceSkip.recommendation, "skip", "a selected compilation preference must drive the final Skip");
assert.deepEqual(Array.from(compilationPreferenceSkip.matchedSlopPreferences), ["compilations"]);

const compilationAllowed = classifier.mergeOllamaDecision(classifier.scoreCandidate({
  platform: "youtube",
  itemId: "compilation-allowed",
  url: "https://www.youtube.com/shorts/compilation-allowed",
  title: "Top 10 viral clips compilation",
  visibleText: "A clip collection with no commentary.",
  channelName: "Clip Vault",
  slopPreferences: []
}), {
  available: true,
  verdict: "skip",
  category: "compilation",
  confidence: 0.91,
  reason: "Low-originality clip compilation"
});
assert.equal(compilationAllowed.recommendation, "watch", "an unselected compilation category must be preference-guarded");
assert.equal(compilationAllowed.ollamaDecision.preferenceGuardApplied, true);

const tierRankingSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "tier-ranking",
  url: "https://www.youtube.com/shorts/tier-ranking",
  title: "Ranking the funniest cartoon moments tier list",
  visibleText: "Which clip is funniest?",
  channelName: "Ranking Hub"
});
assert.ok(tierRankingSlop.signalBreakdown.some((signal) => signal.label === "Tier-list ranking bait"));
assert.equal(classifier.mergeOllamaDecision(tierRankingSlop, {
  available: true,
  verdict: "skip",
  category: "tier_ranking",
  confidence: 0.93,
  reason: "Tier-list ranking bait"
}).recommendation, "skip", "funniest-thing tier/ranking formats should be filtered when corroborated");

const phonkMovieEdit = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "phonk-edit",
  url: "https://www.tiktok.com/@edits/video/phonk-edit",
  title: "Low quality Spider-Man edit with phonk background",
  visibleText: "Different movie clips, mostly one scene, phonk audio in the background.",
  channelName: "Scene Edits"
});
assert.ok(phonkMovieEdit.signalBreakdown.some((signal) => signal.label === "Low-quality phonk/funk edit format"));
assert.equal(classifier.mergeOllamaDecision(phonkMovieEdit, {
  available: true,
  verdict: "skip",
  category: "phonk_edit",
  confidence: 0.94,
  reason: "Low-effort phonk edit"
}).recommendation, "skip", "phonk/funk movie edits should be filtered");

const textOverMovieClip = classifier.scoreCandidate({
  platform: "instagram",
  itemId: "text-movie",
  url: "https://www.instagram.com/reel/text-movie/",
  title: "Tweet comment over a movie clip",
  visibleText: "Just text on top of a cartoon scene and nothing else.",
  channelName: "Post Clips"
});
assert.ok(textOverMovieClip.signalBreakdown.some((signal) => signal.label === "Text over unrelated movie/cartoon clip"));
assert.ok(textOverMovieClip.signalBreakdown.some((signal) => signal.label === "Social screenshot plus comment format"));
assert.equal(classifier.mergeOllamaDecision(textOverMovieClip, {
  available: true,
  verdict: "skip",
  category: "movie_text",
  confidence: 0.95,
  reason: "Text over unrelated movie/cartoon clip"
}).recommendation, "skip", "text-only posts over movie/cartoon clips should be filtered");

const rawMovieScene = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "raw-movie-scene",
  url: "https://www.youtube.com/shorts/raw-movie-scene",
  title: "The Dark Knight interrogation fight scene 4K",
  visibleText: "Full movie clip part 2.",
  channelName: "MovieClips Vault"
});
assert.equal(rawMovieScene.recommendation, "skip", "raw movie and TV scene reposts must skip on every video feed");
assert.equal(rawMovieScene.hardMovieSceneRepost, true);
assert.equal(rawMovieScene.hardLocalSkip, true);

const movieSceneReview = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "movie-scene-review",
  url: "https://www.youtube.com/watch?v=movie-scene-review",
  title: "Why The Dark Knight interrogation scene works",
  visibleText: "A film review and scene breakdown with original commentary and analysis.",
  channelName: "Cinema Analysis"
});
assert.equal(movieSceneReview.hardMovieSceneRepost, undefined, "reviews and commentary must not be mistaken for raw scene reposts");
assert.equal(movieSceneReview.recommendation, "watch");

const hashtagOnlyVideo = classifier.scoreCandidate({
  platform: "instagram",
  itemId: "hashtags-only",
  url: "https://www.instagram.com/reel/hashtags-only/",
  title: "#fyp #viral #trending 🎬",
  visibleText: "#fyp #viral #trending",
  channelName: "clipdump"
});
assert.equal(hashtagOnlyVideo.recommendation, "skip", "hashtag-only video titles must skip across supported video feeds");
assert.equal(hashtagOnlyVideo.hardHashtagOnlyTitle, true);

const titledHashtagVideo = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "hashtags-with-title",
  url: "https://www.tiktok.com/@cinema/video/hashtags-with-title",
  title: "A director explains practical lighting #film #cinema",
  visibleText: "An educational interview about lighting a night scene.",
  channelName: "Cinema Class"
});
assert.equal(titledHashtagVideo.hardHashtagOnlyTitle, undefined, "normal titles that also contain hashtags must stay eligible for ordinary scoring");
assert.equal(titledHashtagVideo.recommendation, "watch");

const asmrBottomStory = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "asmr-bottom-story",
  url: "https://www.youtube.com/shorts/asmr-bottom-story",
  title: "Texting story with ASMR on the side",
  visibleText: "Actual thing at the top, satisfying video at the bottom, Reddit story text messages.",
  channelName: "Story Screen"
});
assert.ok(asmrBottomStory.signalBreakdown.some((signal) => signal.label === "ASMR or bottom-video sidecar"));
assert.equal(classifier.mergeOllamaDecision(asmrBottomStory, {
  available: true,
  verdict: "skip",
  category: "story_gameplay",
  confidence: 0.96,
  reason: "Story narration over unrelated side video"
}).recommendation, "skip", "texting/Reddit stories with ASMR or bottom video sidecars should be filtered");

const ragebaitSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "ragebait",
  url: "https://www.youtube.com/shorts/ragebait",
  title: "Ragebait hot take trying to make you mad",
  visibleText: "This controversial take will make you mad.",
  channelName: "Anger Farm"
});
assert.ok(ragebaitSlop.signalBreakdown.some((signal) => signal.label === "Ragebait hook"));
assert.equal(classifier.mergeOllamaDecision(ragebaitSlop, {
  available: true,
  verdict: "skip",
  category: "ragebait",
  confidence: 0.92,
  reason: "Ragebait hook"
}).recommendation, "skip", "ragebait should be filtered");

const misinfoHype = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "misinfo-hype",
  url: "https://www.tiktok.com/@claims/video/misinfo-hype",
  title: "The truth about vaccines nobody is talking about",
  visibleText: "This health study proves what they are hiding and changes everything.",
  channelName: "Health Truth Daily"
});
assert.equal(misinfoHype.factCheckEligible, true);
assert.ok(misinfoHype.signalBreakdown.some((signal) => signal.label === "Information blown out of proportion"));
assert.equal(classifier.mergeOllamaDecision(misinfoHype, {
  available: true,
  verdict: "skip",
  category: "misinfo_hype",
  confidence: 0.91,
  reason: "Information blown out of proportion"
}).recommendation, "skip", "misinformation hype should be filtered");

const familyGuyCore = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "family-guy-core",
  url: "https://www.youtube.com/shorts/family-guy-core",
  title: "Family Guy core",
  visibleText: "Funny cutaway moments.",
  channelName: "Core Vault"
});
assert.equal(familyGuyCore.protectedFormatKind, "core");
const familyGuyCoreGuarded = classifier.mergeOllamaDecision(familyGuyCore, {
  available: true,
  verdict: "skip",
  category: "recycled",
  confidence: 0.93,
  reason: "Recycled clip"
});
assert.equal(familyGuyCoreGuarded.recommendation, "watch", "core formats such as Family Guy core should stay visible");
assert.equal(familyGuyCoreGuarded.ollamaDecision.preferredFormatGuardApplied, true);

const streamClipShow = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "stream-clips",
  url: "https://www.youtube.com/shorts/stream-clips",
  title: "Kai Cenat stream clips highlights",
  visibleText: "Different clips from a stream with live reactions.",
  channelName: "Stream Moments"
});
assert.equal(streamClipShow.protectedFormatKind, "stream_clip");
assert.equal(classifier.mergeOllamaDecision(streamClipShow, {
  available: true,
  verdict: "skip",
  category: "compilation",
  confidence: 0.9,
  reason: "Compilation without original analysis"
}).recommendation, "watch", "different clips from a stream should stay visible");

const creatorPersonaShow = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "creator-persona",
  url: "https://www.youtube.com/watch?v=creator-persona",
  title: "CarterPCs built a tiny gaming PC",
  visibleText: "I built and tested the setup with commentary.",
  channelName: "CarterPCs"
});
assert.equal(creatorPersonaShow.protectedFormatKind, "creator_persona");
assert.equal(classifier.mergeOllamaDecision(creatorPersonaShow, {
  available: true,
  verdict: "skip",
  category: "content_farm",
  confidence: 0.9,
  reason: "Low-value content-farm format"
}).recommendation, "watch", "distinct creator-persona videos should be boosted toward watch");

const knownBrainrotAi = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "tung-sahur",
  url: "https://www.youtube.com/shorts/tung-sahur",
  title: "Tung Tung Tung Sahur #AIVideo",
  visibleText: "#AIAnimation",
  channelName: "Brainrot Universe"
});
assert.equal(knownBrainrotAi.recommendation, "skip", "known AI-brainrot titles must skip immediately");
assert.equal(knownBrainrotAi.score, 100);
assert.equal(knownBrainrotAi.hardAiSynthetic, true);

const newlyObservedBrainrotFamily = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "odindindindun",
  url: "https://www.youtube.com/shorts/odindindindun",
  title: "ODINDINDINDUN SAD ORIGIN STORY! Italian Brainrot Animation",
  visibleText: "",
  channelName: "Viral Animation"
});
assert.equal(newlyObservedBrainrotFamily.recommendation, "skip", "new brainrot-family names and explicit media formats must use the instant block path");
assert.equal(newlyObservedBrainrotFamily.hardAiSynthetic, true);

const locallyLearnedBrainrot = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "learned-character",
  url: "https://www.youtube.com/shorts/learned-character",
  title: "Zambalungo returns for revenge",
  learnedBrainrotTerms: ["zambalungo"]
});
assert.equal(locallyLearnedBrainrot.recommendation, "watch", "a locally learned token must wait for independent context corroboration");
assert.equal(locallyLearnedBrainrot.hardAiSynthetic, false, "learned tokens must not become permanent hard-AI overrides");
assert.ok(locallyLearnedBrainrot.signalBreakdown.some((signal) => signal.label === "Locally learned brainrot character title"));
const corroboratedLearnedBrainrot = classifier.mergeOllamaDecision(locallyLearnedBrainrot, {
  available: true,
  verdict: "skip",
  category: "content_farm",
  confidence: 0.94,
  reason: "Low-value content-farm format"
});
assert.equal(corroboratedLearnedBrainrot.recommendation, "skip", "Qwen can corroborate a learned brainrot hint");

const learnedCommonWordCourse = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "learned-common-word-course",
  url: "https://www.youtube.com/watch?v=learned-common-word-course",
  title: "Complete Food Order Website [ PHP and MySQL ]",
  visibleText: "Build a database-backed project from start to finish.",
  learnedBrainrotTerms: ["complete"]
});
assert.equal(learnedCommonWordCourse.recommendation, "watch", "a poisoned common learned token must not hard-hide a real course");
assert.equal(learnedCommonWordCourse.educationalProtected, true);

assert.deepEqual(Array.from(contentRuntime.api.extractLearnableBrainrotTerms("Zambalungo and Odindindindun | Italian Brainrot Animation")), ["zambalungo", "odindindindun"]);
assert.deepEqual(Array.from(contentRuntime.api.extractLearnableBrainrotTerms("Why Italian brainrot matters: a documentary analysis")), []);

const knownBrainrotAnalysis = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "tung-analysis",
  url: "https://www.youtube.com/watch?v=tung-analysis",
  title: "Why Tung Tung Tung Sahur became a meme: history and analysis",
  visibleText: "A documentary essay about the origin and cultural meaning of the trend.",
  channelName: "Internet History Lab"
});
assert.equal(knownBrainrotAnalysis.recommendation, "watch", "analysis of a brainrot trend must remain visible");
assert.equal(knownBrainrotAnalysis.hardAiSynthetic, false);
assert.equal(knownBrainrotAnalysis.educationalProtected, true);

const aiVideoLesson = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "ai-video-lesson",
  url: "https://www.youtube.com/watch?v=ai-video-lesson",
  title: "How AI video generators work",
  visibleText: "A university lecture explaining diffusion and transformer research.",
  channelName: "Computer Science Lab"
});
assert.equal(aiVideoLesson.recommendation, "watch", "educational AI analysis must not be mistaken for an AI-media disclosure");
assert.equal(aiVideoLesson.hardAiSynthetic, false);

const normalPersonalShort = classifier.scoreCandidate({
  platform: "instagram",
  itemId: "normal123",
  url: "https://www.instagram.com/reel/normal123/",
  title: "Morning run",
  visibleText: "A quick clip from my trail run before work.",
  channelName: "maya"
});
assert.equal(normalPersonalShort.recommendation, "watch", "short or ordinary titles must stay visible");

const subscriberBeggingShort = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "xO-tteTugWk",
  url: "https://www.youtube.com/shorts/xO-tteTugWk",
  title: "No Shame in asking",
  visibleText: "Best Fortnite Weapon #fortnite #fnclip #subscribe #trending #heartbroken",
  channelName: "emiyomichell",
  durationSeconds: 9
});
assert.equal(subscriberBeggingShort.recommendation, "skip", "explicit #subscribe begging must be removed immediately");
assert.equal(subscriberBeggingShort.hardEngagementBait, true);
assert.ok(subscriberBeggingShort.reasons.some((reason) => /subscriber solicitation/i.test(reason)));

const ordinarySubscriberDiscussion = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "subscription-explainer",
  url: "https://www.youtube.com/watch?v=subscription-explainer",
  title: "How YouTube subscriptions work",
  visibleText: "A tutorial explaining notifications and subscription settings.",
  channelName: "Creator Support"
});
assert.equal(ordinarySubscriberDiscussion.hardEngagementBait, false, "ordinary discussion of subscriptions must remain visible");

const dropshippingFinanceSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "vgzeMMA4cIk",
  url: "https://www.youtube.com/watch?v=vgzeMMA4cIk",
  title: "How I Made $32,000 in 30 Days Dropshipping With NO MONEY",
  visibleText: "Get Shopify For $1 For 3 Months. DM me YOUTUBE on Instagram for my training.",
  channelName: "Straight Ecom",
  durationSeconds: 43
});
assert.equal(dropshippingFinanceSlop.recommendation, "skip", "get-rich-quick dropshipping funnels must be removed immediately");
assert.equal(dropshippingFinanceSlop.hardFinanceSlop, true);
assert.ok(dropshippingFinanceSlop.reasons.some((reason) => /dropshipping funnel/i.test(reason)));

const dropshippingCritique = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "dropshipping-case-study",
  url: "https://www.youtube.com/watch?v=dropshipping-case-study",
  title: "Why dropshipping fails: a documented case study",
  visibleText: "An investigation of advertising costs, chargebacks, risks, and business failure rates.",
  channelName: "Business Research Lab"
});
assert.equal(dropshippingCritique.hardFinanceSlop, false, "documented criticism of dropshipping must remain visible");

const explicitBrainrotTitle = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "brainrot-title",
  url: "https://www.youtube.com/shorts/brainrot-title",
  title: "ULTIMATE BRAINROT",
  visibleText: "Watch until the end and follow for more clips.",
  channelName: "Viral Loop"
});
assert.equal(explicitBrainrotTitle.recommendation, "watch", "non-AI brainrot still waits for required Ollama");
assert.ok(explicitBrainrotTitle.signalBreakdown.some((signal) => signal.label === "Title explicitly labels itself brainrot"));
const brainrotSkipped = classifier.mergeOllamaDecision(explicitBrainrotTitle, {
  available: true,
  verdict: "skip",
  category: "content_farm",
  confidence: 0.96,
  reason: "Low-value content-farm format"
});
assert.equal(brainrotSkipped.recommendation, "skip");

const brainrotAnalysis = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "brainrot-analysis",
  url: "https://www.youtube.com/watch?v=brainrot-analysis",
  title: "The psychology of brainrot: a research analysis",
  visibleText: "A professor explains current research about attention and media habits.",
  channelName: "Media Studies Lab"
});
assert.equal(brainrotAnalysis.educationalProtected, true);
assert.ok(!brainrotAnalysis.signalBreakdown.some((signal) => signal.label === "Title explicitly labels itself brainrot"));

const topperStyleChallenge = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "secret-rooms",
  url: "https://www.youtube.com/watch?v=secret-rooms",
  title: "I Built 5 SECRET Rooms For Ronaldo!",
  visibleText: "I survived the impossible hidden room challenge.",
  channelName: "Challenge Factory"
});
assert.equal(topperStyleChallenge.recommendation, "watch", "viral challenge metadata must still wait for Ollama");
assert.ok(topperStyleChallenge.signalBreakdown.some((signal) => signal.label === "Manufactured viral challenge format"));
const challengeSkipped = classifier.mergeOllamaDecision(topperStyleChallenge, {
  available: true,
  verdict: "skip",
  category: "viral_challenge",
  confidence: 0.91,
  reason: "Manufactured viral challenge format"
});
assert.equal(challengeSkipped.recommendation, "skip");

const filteredTopperGuild = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "topper-guild-filter",
  url: "https://www.youtube.com/watch?v=topper-guild-filter",
  title: "Extreme Challenges That Pushed Limits! | Topper Guild",
  visibleText: "",
  channelName: "Topper Guild"
});
assert.equal(filteredTopperGuild.recommendation, "skip", "the explicitly requested Topper Guild filter must resolve locally");
assert.equal(filteredTopperGuild.hardAiSynthetic, false, "creator preference skips must not be mislabeled as synthetic media");
assert.equal(filteredTopperGuild.hardLocalSkip, true);
assert.equal(classifier.mergeOllamaDecision(filteredTopperGuild, { available: false }).recommendation, "skip");

const topperGuildAnalysis = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "topper-guild-analysis",
  url: "https://www.youtube.com/watch?v=topper-guild-analysis",
  title: "Why Topper Guild videos work: a media analysis",
  visibleText: "A documentary essay examining viral challenge editing.",
  channelName: "Media Studies Lab"
});
assert.equal(topperGuildAnalysis.recommendation, "watch", "analysis of a filtered creator must remain visible");
assert.equal(topperGuildAnalysis.hardLocalSkip, false);

const longFormClaim = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "claim-video",
  url: "https://www.youtube.com/watch?v=claim-video",
  title: "NASA data shows the Moon is moving away from Earth",
  visibleText: "Scientists report that the measured distance increases every year according to lunar ranging data.",
  channelName: "Space Briefing"
});
assert.equal(longFormClaim.itemKind, "video");
assert.equal(longFormClaim.factCheckEligible, true, "checkable long-form video claims should reach the evidence engine");

const instagramInformational = classifier.scoreCandidate({
  platform: "instagram",
  itemId: "igfacts123",
  url: "https://www.instagram.com/reel/igfacts123/",
  title: "What the latest climate study found",
  visibleText: "Researchers report that ocean temperatures increased during the measured period.",
  channelName: "climate.lab"
});
const tiktokInformational = classifier.scoreCandidate({
  platform: "tiktok",
  itemId: "741234567891",
  url: "https://www.tiktok.com/@historyteacher/video/741234567891",
  title: "A historian explains the 1918 public health response",
  visibleText: "Historical records show how city policy changed during the epidemic.",
  channelName: "historyteacher"
});
assert.equal(instagramInformational.itemKind, "short");
assert.equal(instagramInformational.factCheckEligible, true);
assert.equal(tiktokInformational.itemKind, "short");
  assert.equal(tiktokInformational.factCheckEligible, true);

  const linkedinPost = classifier.scoreCandidate({
    platform: "linkedin",
    itemId: "123456789",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
    title: "We increased verified customer retention by 42 percent in 2025",
    visibleText: "Our team launched the program in January and increased verified customer retention by 42 percent in 2025."
  });
  const linkedinProfile = classifier.parsePlatformUrl("https://www.linkedin.com/in/alex-example/", "linkedin");
  assert.equal(linkedinPost.itemKind, "post");
  assert.equal(linkedinPost.factCheckEligible, true);
  assert.equal(linkedinProfile.itemKind, "profile");
  assert.equal(linkedinProfile.itemId, "alex-example");

const protectedByOllama = classifier.mergeOllamaDecision(obviousSlop, {
  available: true, verdict: "dont_skip", confidence: 0.9, reason: "Original educational commentary was detected"
});
assert.equal(protectedByOllama.recommendation, "skip", "Ollama cannot veto the hard AI/synthetic rule");
assert.equal(protectedByOllama.score, 100);
assert.equal(protectedByOllama.ollamaUsed, false);

const nonAiSlop = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "farm123",
  url: "https://www.youtube.com/shorts/farm123",
  title: "Reddit story over Minecraft parkour",
  visibleText: "Follow for part two. Wait for the ending.",
  channelName: "Story Vault"
});
assert.equal(nonAiSlop.recommendation, "skip", "selected Reddit/text-story formats must skip immediately");

const trueRedditDiaries = classifier.scoreCandidate({
  platform: "youtube",
  url: "https://www.youtube.com/shorts/L1FivTJkiHY",
  title: "What's the coldest bet someone made that actually changed everything forever?",
  channelName: "True Reddit Diaries"
});
assert.equal(trueRedditDiaries.recommendation, "skip", "the reported True Reddit Diaries Short must be blocked immediately");
assert.equal(nonAiSlop.hardLocalSkip, true);
const ollamaSkipped = classifier.mergeOllamaDecision(nonAiSlop, {
  available: true, verdict: "skip", confidence: 0.82, reason: "Recycled story over unrelated gameplay"
});
assert.equal(ollamaSkipped.recommendation, "skip");
assert.equal(ollamaSkipped.ollamaUsed, false, "hard Reddit/text-story skips must not wait for Ollama");

const redditAnalysis = classifier.scoreCandidate({
  platform: "youtube",
  itemId: "analysis123",
  url: "https://www.youtube.com/watch?v=analysis123",
  title: "Why Reddit stories over Minecraft gameplay became popular",
  visibleText: "A media researcher explains the history of the format.",
  channelName: "Media Studies"
});
assert.equal(redditAnalysis.recommendation, "watch", "educational analysis of the format must stay visible");

const guardedEducationalSkip = classifier.mergeOllamaDecision(educationalShort, {
  available: true,
  verdict: "skip",
  confidence: 0.95,
  reason: "The short format looked low-value"
});
assert.equal(guardedEducationalSkip.recommendation, "watch", "an uncorroborated Ollama false positive must not hide educational content");
assert.equal(guardedEducationalSkip.ollamaUsed, true, "Ollama remains required even when the safety guard resolves its verdict");
assert.equal(guardedEducationalSkip.ollamaDecision.verdict, "skip");
assert.equal(guardedEducationalSkip.ollamaDecision.effectiveVerdict, "dont_skip");
assert.equal(guardedEducationalSkip.ollamaDecision.educationalGuardApplied, true);
assert.equal(guardedEducationalSkip.sourceScores.ollamaRaw, 95);
assert.equal(guardedEducationalSkip.sourceScores.ollama, 0);

const contradictoryEducationalReason = classifier.mergeOllamaDecision(normalPersonalShort, {
  available: true,
  verdict: "skip",
  confidence: 0.95,
  reason: "This appears to be educational content from an MIT course"
});
assert.equal(contradictoryEducationalReason.recommendation, "watch", "Ollama cannot describe an item as educational and then hide it without corroboration");
assert.equal(contradictoryEducationalReason.ollamaDecision.educationalGuardApplied, true);

const inconsistentLowSignalSkip = classifier.mergeOllamaDecision(normalPersonalShort, {
  available: true,
  verdict: "skip",
  rawVerdict: "skip",
  category: "original",
  categoryConsistent: false,
  confidence: 0.95,
  reason: "Original commentary or creative work"
});
assert.equal(inconsistentLowSignalSkip.recommendation, "watch", "an inconsistent Qwen category must fail open without independent slop evidence");

const inconsistentButCorroboratedSkip = classifier.mergeOllamaDecision(nonAiSlop, {
  available: true,
  verdict: "skip",
  rawVerdict: "skip",
  category: "original",
  categoryConsistent: false,
  confidence: 0.95,
  reason: "Original commentary or creative work"
});
assert.equal(inconsistentButCorroboratedSkip.recommendation, "skip", "strong independent slop evidence may resolve an inconsistent Qwen category");

const detectorSkipped = classifier.mergeDetectorDecision(educationalShort, {
  status: "ready",
  synthetic: true,
  automaticSkipEligible: true,
  rolloutMode: "corroborated",
  score: 84,
  reason: "Temporal detector found synthetic video patterns",
  spatial: { available: true, ai_probability: 0.71 },
  temporal: {
    available: true,
    fake_probability: 0.84,
    av_joint: {
      available: true,
      state: "ready",
      jointForgeryProbability: 0.91,
      syncMismatchProbability: 0.73,
      audioSpoofProbability: 0.81,
      visualForgeryProbability: 0.88,
      uncertainty: 0.12,
      rolloutMode: "corroborated"
    }
  },
  consensus: { policyVersion: 4, basis: "spatial_temporal_av" }
});
assert.equal(detectorSkipped.recommendation, "skip", "visual synthetic detection must override educational/text protection");
assert.equal(detectorSkipped.score, 100);
assert.equal(detectorSkipped.hardAiSynthetic, true);
assert.equal(detectorSkipped.visualAiSynthetic, true);
assert.equal(detectorSkipped.sourceScores.avJoint, 91);
assert.equal(detectorSkipped.sourceScores.avAudio, 81);
assert.equal(detectorSkipped.detectorDecision.avJoint.rolloutMode, "corroborated");

const lightweightEducationalHeld = classifier.mergeDetectorDecision(classifier.scoreCandidate({
  platform: "youtube",
  itemId: "kip-thorne",
  url: "https://www.youtube.com/shorts/kip-thorne",
  title: "Theoretical Physicist Kip Thorne talks about black holes",
  visibleText: "An academic interview about astrophysics."
}), {
  status: "ready",
  synthetic: true,
  automaticSkipEligible: true,
  performanceProfile: "fast",
  rolloutMode: "testing",
  score: 98,
  reason: "Fast mode found a strong synthetic-frame signal",
  lightweight: { available: true, ai_probability: 0.98 },
  spatial: { available: false, status: "disabled_fast_mode" },
  temporal: { available: false, status: "disabled_fast_mode" }
});
assert.equal(lightweightEducationalHeld.recommendation, "watch", "one Fast thumbnail spike cannot hide academic content");
assert.equal(lightweightEducationalHeld.detectorDecision.consensus.basis, "educational_fast_guard");
assert.equal(lightweightEducationalHeld.detectorDecision.automaticSkipEligible, false);

const detectorKept = classifier.mergeDetectorDecision(ollamaSkipped, {
  status: "ready",
  synthetic: false,
  score: 18,
  reason: "No strong synthetic-media signal",
  spatial: { available: true, ai_probability: 0.15 },
  temporal: { available: true, fake_probability: 0.2 }
});
assert.equal(detectorKept.recommendation, "skip", "visual detector must not veto an Ollama slop verdict");
assert.equal(detectorKept.detectorUsed, true);

const detectorPending = classifier.mergeDetectorDecision(normalPersonalShort, { status: "pending" });
assert.equal(detectorPending.recommendation, "watch");
assert.equal(detectorPending.detectorStatus, "pending");

const lightweightSkipped = classifier.mergeDetectorDecision(educationalShort, {
  status: "provisional",
  synthetic: true,
  score: 97,
  reason: "Lightweight detector found a strong synthetic-frame signal",
  lightweight: { available: true, ai_probability: 0.97 }
});
assert.equal(lightweightSkipped.recommendation, "watch", "provisional lightweight evidence must fail open");
assert.equal(lightweightSkipped.detectorStatus, "provisional");
assert.equal(lightweightSkipped.detectorDecision.provisional, true);
assert.equal(lightweightSkipped.detectorDecision.wouldSkip, true);
assert.equal(lightweightSkipped.detectorDecision.automaticSkipEligible, false);

const shadowDetected = classifier.mergeDetectorDecision(educationalShort, {
  status: "ready",
  synthetic: true,
  automaticSkipEligible: false,
  rolloutMode: "shadow",
  score: 99,
  reason: "Independent spatial and temporal detectors agreed",
  spatial: { available: true, ai_probability: 0.99 },
  temporal: { available: true, fake_probability: 0.99 },
  consensus: { policyVersion: 4, basis: "spatial_temporal" }
});
assert.equal(shadowDetected.recommendation, "watch", "shadow detections must remain visible");
assert.equal(shadowDetected.detectorStatus, "shadow");
assert.equal(shadowDetected.detectorDecision.wouldSkip, true);

const syntheticAllowed = classifier.mergeDetectorDecision(classifier.scoreCandidate({
  platform: "youtube",
  itemId: "synthetic-allowed",
  url: "https://www.youtube.com/watch?v=synthetic-allowed",
  title: "A short film",
  visibleText: "An original short film.",
  slopPreferences: []
}), {
  status: "ready",
  synthetic: true,
  automaticSkipEligible: true,
  score: 96,
  reason: "Independent visual detectors found synthetic-media signals",
  spatial: { available: true, ai_probability: 0.97 },
  temporal: { available: true, fake_probability: 0.94 }
});
assert.equal(syntheticAllowed.recommendation, "watch", "unselected synthetic categories must stay visible");
assert.equal(syntheticAllowed.visualAiSynthetic, true, "allowed synthetic media may still carry an advisory annotation");
assert.equal(syntheticAllowed.detectorDecision.rolloutMode, "preference_allow");

const lightweightKept = classifier.mergeDetectorDecision(normalPersonalShort, {
  status: "provisional",
  synthetic: false,
  score: 21,
  lightweight: { available: true, ai_probability: 0.21 }
});
assert.equal(lightweightKept.recommendation, "watch");
assert.equal(lightweightKept.detectorStatus, "provisional");

const factCheckedSkip = classifier.mergeFactCheckDecision(educationalShort, {
  status: "ready",
  verdict: "contradicted",
  confidence: 0.94,
  automaticSkip: true,
  trustedSourceCount: 2,
  claim: "The short makes a checkable scientific claim.",
  summary: "Two authoritative sources directly refute this claim.",
  checkedAt: "2026-07-13T18:00:00Z",
  sources: [
    { title: "Agency evidence", url: "https://www.cdc.gov/evidence", domain: "cdc.gov", publisher: "CDC", authority: "primary", trusted: true },
    { title: "International evidence", url: "https://www.who.int/evidence", domain: "who.int", publisher: "WHO", authority: "primary", trusted: true }
  ]
});
assert.equal(factCheckedSkip.recommendation, "skip");
assert.equal(factCheckedSkip.score, 100);
assert.equal(factCheckedSkip.hardFactContradiction, true);
assert.equal(factCheckedSkip.factCheckDecision.sources.length, 2);

const contradictedAllowed = classifier.mergeFactCheckDecision(classifier.scoreCandidate({
  platform: "linkedin",
  itemId: "contradicted-allowed",
  url: "https://www.linkedin.com/feed/update/urn:li:activity:contradicted-allowed/",
  title: "A checkable company claim",
  visibleText: "Our study proves this result increased by 90 percent.",
  slopPreferences: []
}), {
  status: "ready",
  verdict: "contradicted",
  confidence: 0.96,
  automaticSkip: true,
  trustedSourceCount: 3,
  summary: "Independent primary sources contradict the claim.",
  sources: [
    { title: "Primary source", url: "https://www.cdc.gov/source", trusted: true },
    { title: "Second source", url: "https://www.who.int/source", trusted: true }
  ]
});
assert.equal(contradictedAllowed.recommendation, "watch", "unselected fake-story filtering must not auto-hide a contradicted claim");
assert.equal(contradictedAllowed.factCheckDecision.preferenceAllowed, true);
assert.equal(contradictedAllowed.factCheckDecision.verdict, "contradicted", "the contradiction annotation must remain available");

for (const weakFactCheck of [
  { status: "ready", verdict: "contradicted", confidence: 0.94, automaticSkip: true, trustedSourceCount: 1 },
  { status: "ready", verdict: "mixed", confidence: 0.99, automaticSkip: true, trustedSourceCount: 3 },
  { status: "ready", verdict: "insufficient", confidence: 0.99, automaticSkip: false, trustedSourceCount: 3 }
]) {
  const result = classifier.mergeFactCheckDecision(educationalShort, weakFactCheck);
  assert.equal(result.recommendation, "watch", "uncertain or weakly sourced fact checks must fail open");
}

const parsedInstagram = classifier.parsePlatformUrl("https://www.instagram.com/reel/C123abc/", "instagram");
const parsedTikTok = classifier.parsePlatformUrl("https://www.tiktok.com/@person/video/741234567890", "tiktok");
assert.equal(parsedInstagram.itemId, "C123abc");
assert.equal(parsedInstagram.itemKind, "short");
assert.equal(parsedTikTok.itemId, "741234567890");

const core = createCoreRuntime(controlCoreSource);
const cache = core.createDecisionCache({ limit: 2 });
cache.set("youtube:a", obviousSlop);
assert.equal(cache.get("youtube:a").recommendation, "skip");
cache.allow("youtube:a");
assert.equal(cache.get("youtube:a"), null);
assert.equal(cache.isAllowed("youtube:a"), true);

assert.ok(contentSource.includes("SCORE_BATCH_SIZE = 10"));
  assert.ok(contentSource.includes("runBatchesWithConcurrency(lookaheadBatches"), "all loaded candidates must refine through bounded background lanes");
  assert.ok(contentSource.includes("LINKEDIN_LOOKAHEAD_LIMIT = 100"), "LinkedIn lookahead must be bounded to the next 100 loaded items");
  assert.ok(contentSource.includes("fullVideoAnalysisRequested"), "LinkedIn videos must expose explicit open/play gating");
  assert.ok(background.includes('"deferred_until_open"'), "unopened LinkedIn videos must not receive a synthetic-video verdict");
  assert.ok(background.includes('message?.type === "orislop.chatItem"'), "LinkedIn explanations must expose the grounded chatbot");
assert.ok(contentSource.includes("loadedCandidates.filter(({ element }) => isInViewport(element))"), "the scanner must distinguish visible priority from the rest of the loaded feed");
assert.ok(contentSource.includes("orislop-prescan-cover"), "high-risk media must be shielded during slow-model verification");
assert.ok(styles.includes(".orislop-prescan-cover"), "the pre-scan shield must stay scoped to the media surface");
assert.ok(contentSource.includes("decisionCache.get"));
assert.ok(contentSource.includes("DETECTOR_STATUS_KEY"));
assert.ok(contentSource.includes("FACT_CHECK_STATUS_KEY"));
assert.ok(contentSource.includes('detectorStatus === "provisional"'));
assert.ok(contentSource.includes("restoreAutomaticallyHiddenItem"));
assert.ok(contentSource.includes("restoreReusedCandidateElements(roots)"), "recycled feed DOM must not carry a hidden decision onto a different video");
assert.ok(!contentSource.includes('!element.classList.contains("orislop-skip-hidden")'), "allowed recycled feed roots must also be rescanned when their media identity changes");
assert.ok(contentSource.includes('attributeFilter: ["src", "href", "poster", "data-e2e", "data-video-id", "aria-label"]'), "reused Instagram and TikTok players must rescan when their media attributes change");
assert.ok(contentSource.includes("const currentVideo = findVisibleVideo(document, true)"), "candidate metadata must be anchored to the actually visible player");
assert.ok(contentSource.includes("currentItemUrl || link || fallbackUrl"), "the active YouTube item URL must outrank a stale link left in recycled Shorts metadata");
assert.ok(contentSource.includes("preferredVideoRoots"), "lookahead must retain metadata-bearing Instagram and TikTok roots instead of their narrow player children");
assert.ok(contentSource.includes("visibleVideo?.currentSrc") && contentSource.includes("visibleVideo?.poster"), "linkless short-form videos must get distinct media-backed identities");
assert.ok(contentSource.includes("isAdjacentYouTubeShortNavigation(previousHref, lastHref)"), "feed navigation must restore hidden cards while adjacent Shorts retain lookahead decisions");
assert.ok(contentSource.includes("restoreAllOrislopUi"));
assert.ok(contentSource.includes("hasExternalMutation"), "Orislop-owned DOM updates must not trigger recursive scans");
assert.ok(contentSource.includes("SCAN_FOLLOWUP_DELAY_MS = 600") && contentSource.includes("scanNotBefore"), "coalesced mutation scans must rescan inside the two-second fast window");
assert.ok(contentSource.includes("FAST_DECISION_WINDOW_MS = 2000"), "the initial decision deadline must be two seconds");
assert.ok(background.includes("DETECTOR_SETTLE_POLL_MS = 80"), "the background must settle Fast inference inside one decision window before the result becomes visible");
assert.ok(contentSource.includes("previous?.decisionLocked === true"), "parallel or repeated scans must preserve the first visible decision");
assert.ok(background.includes("FAST_CONTEXT_BUDGET_MS = 250"), "Qwen must refine asynchronously instead of blocking Fast visual decisions");
assert.ok(background.includes("LOCAL_LOOKAHEAD_CONTEXT_DELAY_MS = 8000"), "local visual lookahead must get CPU priority before Qwen refinement");
assert.ok(background.includes("MAX_LOCAL_CONTEXT_ITEMS_PER_PASS = 4"), "strong clients may prepare a bounded local context batch");
assert.ok(background.includes("clientCapabilityProfile"), "client preprocessing must be gated by coarse capability hints");
assert.ok(contentSource.includes("adaptiveBackgroundConcurrency"), "lookahead concurrency must adapt to client resources");
assert.ok(contentSource.includes("enforcePlaybackSuppression"), "Skip decisions must continuously block video and audio playback");
assert.ok(contentSource.includes("data.orislopPlaybackBlocked") || contentSource.includes("dataset.orislopPlaybackBlocked"));
assert.ok(contentSource.includes("savedSeconds: calculateSavedSeconds"), "skipped records must store saved runtime");
assert.ok(contentSource.includes("enabled: true"));
assert.ok(contentSource.includes("mediaUrl"));
assert.ok(contentSource.includes("previewUrl"), "Fast visual scans must use bounded preview images when available");
assert.ok(contentSource.includes("orislop-skip-hidden"));
assert.ok(contentSource.includes('keepButton.textContent = "Show"'), "filtered content must have a clear reveal action");
assert.ok(contentSource.includes("orislop-fact-sources"));
assert.ok(contentSource.includes("Ask about this fact check"), "contradicted facts must offer a source-grounded follow-up chat");
assert.ok(contentSource.includes('"orislop.chatVideo"') && contentSource.includes('"orislop.chatItem"'));
assert.ok(contentSource.includes('"Ask about this video"'), "ordinary videos must expose general video chat");
assert.ok(contentSource.includes('decision.factCheckDecision?.verdict !== "contradicted"'), "contradicted active videos must pause for evidence instead of auto-advancing");
assert.ok(platformAdaptersSource.includes("instagram"));
assert.ok(platformAdaptersSource.includes("tiktok"));
assert.ok(platformAdaptersSource.includes("linkedin"));
assert.ok(contentSource.includes("collectCandidateRoots"));
assert.ok(contentSource.includes("findCandidateRootForVideo"));
assert.ok(contentSource.includes("findVisibleVideo"));
assert.ok(contentSource.includes("current ? findVisibleVideo(document, true) : null"), "current Shorts/Reels/TikTok controls must bind to the actually visible global player when metadata lives elsewhere");
assert.ok(contentSource.includes('saveSkippedRecord(candidate, decision, "blocked_current")'), "a blocked current video must count as skipped when the platform exposes no advance control");
assert.ok(contentSource.includes("isDecisionTerminal(decision, candidate)"), "provisional Heavy results must remain refreshable until the GPU result settles");
assert.ok(contentSource.includes("OrislopPlatformAdapters.chooseCaption"));
assert.ok(!contentSource.includes("WheelEvent"));
assert.ok(!contentSource.includes("PageDown"));
assert.ok(!contentSource.includes("ArrowDown"));
assert.ok(platformAdaptersSource.includes("scrollIntoView"), "TikTok and Instagram must advance through vertical feeds when no Next button exists");
assert.ok(!contentSource.includes("attemptAutoSkip"));
assert.ok(!contentSource.includes("questionable"));
assert.ok(!contentSource.includes("ollamaEnabled"));

assert.ok(styles.includes(".orislop-decision-cover"));
  assert.ok(styles.includes(".orislop-fact-chat"));
  assert.ok(styles.includes(".orislop-linkedin-trust-button"));
assert.ok(styles.includes("position: absolute"));
assert.ok(styles.includes("inset: 0"));
const decisionCoverRule = styles.match(/\.orislop-decision-cover\s*\{[^}]+\}/s)?.[0] || "";
assert.ok(decisionCoverRule.includes("position: absolute"), "the yellow cover must be constrained to its media host");
assert.ok(!decisionCoverRule.includes("position: fixed"), "the yellow cover must never cover the viewport");

assert.ok(background.includes('http://127.0.0.1:4317'));
assert.ok(!background.includes('http://127.0.0.1:11434'), "Chrome must not contact Ollama directly");
assert.ok(background.includes('payload.text_model'), "popup health must use the companion-proxied Ollama status");
assert.ok(background.includes('mergeDetectorDecision'));
assert.ok(background.includes('mergeFactCheckDecision'));
assert.ok(background.includes('message?.type === "orislop.chatVideo"'));
assert.ok(background.includes('"chat_video"'), "ordinary video chat must use a dedicated backend mode");
assert.ok(background.includes('/v1/fact-check'));
assert.ok(background.includes('"story_gameplay"'));
assert.ok(!background.includes("classifyOneWithOllama"), "all local Qwen inference must be brokered by the companion");
assert.ok(background.includes("classifyWithContextBridge"), "local Qwen scoring must use the companion's serialized inference lane");
assert.ok(background.includes("/v1/text-score"), "local Qwen scoring must use the companion context endpoint");
assert.ok(!background.includes("classifyOllamaMicroBatch"), "Qwen 1.5B must not use batch prompts that collapse to one verdict");
assert.ok(background.includes("OLLAMA_TIMEOUT_MS = 60000"));
assert.ok(background.includes("OLLAMA_BATCH_BUDGET_MS = 90000"));
assert.ok(background.includes("dont_skip"));
assert.ok(background.includes("OLLAMA_BATCH_BUDGET_MS"));
assert.ok(background.includes("OLLAMA_CONCURRENCY = 1"));
assert.ok(background.includes("runOnOllamaRequestLane"), "progressive Qwen work must not exhaust the localhost connection pool");
assert.ok(background.includes("ollamaRequestLane = pending.then"), "the Qwen request lane must recover after individual failures");
assert.ok(background.includes("orislop.runtimeHealth"));
assert.ok(contentSource.includes("OLLAMA_RESPONSE_TIMEOUT_MS = 185000"));
assert.deepEqual(
  Array.from(new Set(background.match(/https:\/\/[^\"'\s]+/g) || [])),
  [
    "https://api.orislop.com",
    "https://*.googlevideo.com/*",
    "https://*.cdninstagram.com/*",
    "https://*.fbcdn.net/*",
    "https://*.tiktokcdn.com/*",
    "https://*.tiktokv.com/*",
    "https://*.muscdn.com/*",
    "https://*.akamaized.net/*",
    "https://accounts.google.com/o/oauth2/v2/auth"
  ],
  "background remote access must remain pinned to Orislop, Google OAuth, and approved social video CDNs"
);

assert.ok(popupHtml.includes('id="protectionToggle"'), "the primary view must expose one master filtering control");
assert.ok(popupHtml.includes('id="filteringStage"') && popupHtml.includes('id="todayCount"'), "the primary view must contain only filtering state and one outcome metric");
assert.ok(popupHtml.includes('data-view="activity"') && popupHtml.includes('data-view="preferences"'), "activity and preferences must live on separate secondary views");
assert.ok(popupHtml.includes('id="hideSkippedToggle"'), "automatic hiding must remain configurable");
assert.ok(popupHtml.includes('id="filterGroupList"') && popupHtml.includes('id="slopPreferenceGrid"'), "grouped and granular filtering preferences must both remain available");
assert.ok(!popupHtml.includes('id="firstRunPanel"') && !popupHtml.includes("Start filtering"), "filtering must begin without onboarding or a start action");
assert.ok(!popupHtml.includes('id="liveScan"') && !popupHtml.includes('id="fastScanProgress"'), "scanner pipeline internals must not appear in the consumer-facing view");
assert.ok(!popupHtml.includes("Orislop Shield"), "legacy Shield branding must be removed from the popup");
assert.ok(
  popupHtml.includes("brand-mark__orange") && popupHtml.includes("brand-mark__blue"),
  "popup must retain the supplied split Orislop identity"
);
assert.ok(popupHtml.includes('id="scanNowButton"'), "manual rescanning must remain available under Advanced");
for (const label of [
  "AI video",
  "AI voices",
  "Reposted clips",
  "Hook-only formats",
  "Clip dumps",
  "Ragebait and rankings",
  "Texting and Reddit stories",
  "Copy-paste posts",
  "Split-screen ASMR",
  "Thin edits",
  "Misleading claims"
]) {
  assert.ok(slopPreferencesSource.includes(label), `slop taxonomy is missing: ${label}`);
}
for (const label of ["AI and Fake Media", "Reposts and Clip Farms", "Filler Formats", "Claims and Stories"]) {
  assert.ok(slopPreferencesSource.includes(label), `slop category is missing: ${label}`);
}
assert.ok(popupJs.includes("watchIntentComplete: true") && popupJs.includes("slopPreferences"), "the YouTube MVP must default to filtering immediately while preserving selected categories");
assert.ok(popupJs.includes('type: "orislop.ensureFilterDefaults"'), "the popup must finish the one-time all-filter migration before it renders preferences");
assert.ok(background.includes("FILTER_DEFAULTS_VERSION_KEY") && background.includes("ensureInitialFilterDefaults"), "older saved subsets must migrate to all filters once");
assert.ok(background.includes("OrislopSlopPreferences.defaultIds"), "the migration must use the canonical complete filter list");
assert.ok(popupJs.includes("syncGroupToggles") && popupJs.includes("savePreferenceSelection"), "human-readable groups must preserve the underlying granular preference ids");
assert.ok(!popupJs.includes("FILTER_BOT_PRESETS"), "the old filter bot must not add configuration clutter");
assert.ok(contentSource.includes("slopPreferences: settingsCache.slopPreferences"), "content scoring must send feed choices across the background boundary");
assert.ok(background.includes("shouldRunVisualDetector(candidate, settings)"), "disabled visual slop categories must avoid unnecessary detector work");
assert.ok(popupHtml.includes('id="advancedSettingsPanel"') && popupHtml.includes("<strong>Help</strong>"), "troubleshooting must remain available behind a simple Help disclosure");
assert.ok(popupHtml.includes("gonnerthetooner/orislop-fusion"));
assert.ok(popupHtml.includes("prithivMLmods/Deepfake-Detection-Exp-02-21"));
assert.ok(popupHtml.includes("MusapYildiz/aegis-video-detector"));
assert.ok(!popupHtml.includes("deepfake-temporal-moe"), "legacy Temporal MoE must not be advertised as an online beta voter");
assert.ok(popupHtml.includes("umm-maybe/AI-image-detector"));
assert.ok(popupHtml.includes("testDetectorButton"));
assert.ok(popupHtml.includes("testFactCheckerButton"));
assert.ok(popupHtml.includes("Evidence"));
assert.ok(popupHtml.includes("copyDiagnosticsButton"));
assert.ok(popupHtml.includes('id="minutesSaved"'), "activity must preserve the existing time-saved outcome");
assert.ok(popupJs.includes("calculateSavedSeconds"), "popup must total saved runtime");
assert.ok(popupJs.includes('typeof record === "object" ? 20 : 0'), "every unique skipped video must count as exactly 20 seconds saved");
assert.ok(!popupJs.includes("activity-diagnostics"), "technical AV diagnostics must not clutter the activity view");
assert.ok(popupJs.includes('return "Looked AI-generated"') && popupJs.includes('return "Could not verify the video"'), "activity must use short human reasons");
assert.ok(contentSource.includes("function simpleDecisionReason") && !contentSource.includes('reason.textContent = cleanText(decision.reasons?.[0]'), "in-feed covers must not expose raw detector reasons");
assert.ok(contentSource.includes("existing.dataset.renderKey === renderKey"), "unchanged decision covers must not be rebuilt during rescans");
assert.ok(!popupHtml.includes("ollamaToggle"));
assert.ok(popupHtml.includes("qwen2.5:1.5b-instruct"));
assert.ok(popupHtml.includes("orislop-qwen2.5:1.5b-instruct"), "the popup must default to the model installed by the Vast supervisor");
assert.ok(background.includes("if (model === LEGACY_MODEL) return DEFAULT_MODEL"), "the service worker must migrate legacy model settings before chat requests");
assert.ok(!popupHtml.toLowerCase().includes("questionable"));
assert.ok(!popupHtml.includes("autoSkipToggle"));
assert.ok(!popupJs.includes("chrome.permissions.request"));
assert.ok(popupJs.includes("checkedAt: Date.now()"), "engine tests should replace stale popup status");
assert.ok(popupJs.includes("refreshRuntimeHealth"));
assert.ok(popupJs.includes('title.textContent = "Your feed is protected"') && popupJs.includes('detail.textContent = "Orislop is working quietly."'), "the main view must communicate one stable product state without engine-label churn");
assert.ok(popupHtml.includes('body class="is-loading"') && popupJs.includes("finishLoading"), "saved state must load without flashing false zero, offline, or paused values");
assert.ok(popupJs.includes("Activity titles and URLs were not included"));

const releaseInfo = readJson("release-info.json");
assert.equal(releaseInfo.version, "1.4.0");
assert.equal(releaseInfo.cloudHeavyOAuthConfigured, Boolean(process.env.ORISLOP_GOOGLE_OAUTH_CLIENT_ID));
assert.equal(releaseInfo.distributionProfile, releaseInfo.cloudHeavyOAuthConfigured ? "hybrid-cloud-beta" : "local-only");
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("limited to YouTube and YouTube Shorts")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("identity permissions are removed")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("without onboarding or a Start filtering action")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("Ask Orislop controls are removed")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("one feed scroll")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("fixed 20 seconds saved")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("required Ollama classifier")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("100/100 Skip")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("orislop-fusion")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("legacy Temporal MoE cannot vote")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("lightweight frame detector")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("forces every eligible video through Heavy")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("first-run Heavy autotuning")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("canonical 12-category slop taxonomy")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("source-backed fact checking")));
assert.ok(releaseInfo.requiredQaFixes.some((item) => item.includes("two independent trusted source")));

console.log("extension checks passed");

function read(file) {
  return readFileSync(path.join(distRoot, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function createClassifierRuntime(slopSource, modelSource, source) {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  vm.runInContext(slopSource, context, { filename: "slopPreferences.js" });
  vm.runInContext(modelSource, context, { filename: "aiClassifierModel.generated.js" });
  vm.runInContext(source, context, { filename: "classifier.js" });
  return context.OrislopClassifier;
}

function createSlopPreferenceRuntime(source) {
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "slopPreferences.js" });
  return context.OrislopSlopPreferences;
}

async function createFilterDefaultsMigrationRuntime(source, defaultIds) {
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "filter-default migration test hook requires the production IIFE");
  const instrumented = `${source.slice(0, closureEnd)}globalThis.__ensureOrislopFilterDefaults = ensureInitialFilterDefaults;\n${source.slice(closureEnd)}`;
  const storage = {
    "orislop.extension.settings": { enabled: false, hideSkipped: true, slopPreferences: ["compilations"] }
  };
  const context = vm.createContext({
    URL,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {},
    OrislopSlopPreferences: { defaultIds },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        onChanged: { addListener() {} },
        local: {
          async get(keys) {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
          async set(values) { Object.assign(storage, values); }
        }
      },
      action: null
    }
  });
  context.globalThis = context;
  vm.runInContext(instrumented, context, { filename: "background.js" });
  await context.__ensureOrislopFilterDefaults();
  return { storage, ensure: context.__ensureOrislopFilterDefaults };
}

function createCoreRuntime(source) {
  const context = vm.createContext({ console, setTimeout, clearTimeout });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "controlCore.js" });
  return context.OrislopExtensionCore;
}

function createPlatformAdapterRuntime(source) {
  const context = vm.createContext({ URL, console });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "platformAdapters.js" });
  return context.OrislopPlatformAdapters;
}

function createContentRuntime(source) {
  class FakeElement {
    constructor() {
      this.dataset = {};
      this.isConnected = true;
    }
  }
  class FakeMediaElement extends FakeElement {
    constructor() {
      super();
      this.muted = false;
      this.volume = 0.75;
      this.paused = false;
      this.ended = false;
      this.playCalls = 0;
    }
    pause() { this.paused = true; }
    play() {
      this.paused = false;
      this.playCalls += 1;
      return Promise.resolve();
    }
    querySelectorAll() { return []; }
  }
  class FakeVideoElement extends FakeMediaElement {}
  const context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    HTMLElement: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    HTMLVideoElement: FakeVideoElement,
    window: {
      location: { href: "https://www.youtube.com/shorts/test", hostname: "www.youtube.com", pathname: "/shorts/test" },
      innerWidth: 1280,
      innerHeight: 720
    },
    performance: {
      getEntriesByType() {
        return [
          { name: "https://r1---sn-test.googlevideo.com/videoplayback?mime=video%2Fmp4&id=video", initiatorType: "video", startTime: 20 },
          { name: "https://r1---sn-test.googlevideo.com/videoplayback?mime=audio%2Fwebm&id=audio", initiatorType: "video", startTime: 30 }
        ];
      }
    },
    document: {},
    __ORISLOP_TEST__: true,
    OrislopClassifier: {},
    OrislopPlatformAdapters: {}
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "contentScript.js" });
  return {
    api: context.__ORISLOP_EXTENSION_TEST_API__,
    createPlaybackFixture() {
      const media = new FakeVideoElement();
      const root = new FakeElement();
      root.querySelectorAll = () => [media];
      return { media, root };
    }
  };
}

function createHybridBackgroundRuntime(source) {
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "hybrid background test hook requires the production IIFE");
  const instrumented = `${source.slice(0, closureEnd)}globalThis.__classifyOrislopHybrid = classifyWithHybridDetector;\nglobalThis.__rememberCloudHeavyReadiness = rememberCloudHeavyReadiness;\n${source.slice(closureEnd)}`;
  let cloudReady = false;
  let authorization = "";
  let cloudRequests = 0;
  const analysisOrder = [];
  let localDecision = {
    status: "ready",
    synthetic: false,
    score: 16,
    reason: "Local Fast result",
    lightweight: { available: true, status: "ready", ai_probability: 0.16 }
  };
  const response = (payload) => ({ ok: true, json: async () => payload });
  const context = vm.createContext({
    URL,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
    importScripts() {},
    fetch: async (url, options = {}) => {
      if (String(url).startsWith("https://api.orislop.com")) {
        authorization = options.headers?.Authorization || "";
        if (String(url).endsWith("/v2/me")) {
          return response({ ok: true, cloudHeavy: { ready: cloudReady }, user: { email: "test@example.com" } });
        }
        cloudRequests += 1;
        analysisOrder.push("cloud_heavy");
        return response({
          ok: true,
          state: cloudReady ? "available" : "pending",
          results: [{ clientId: "0", id: "0", status: cloudReady ? "ready" : "pending", synthetic: false, score: 8, reason: "Cloud Heavy result" }]
        });
      }
      analysisOrder.push("local_fast");
      return response({
        ok: true,
        state: "available",
        results: [{ id: "0", ...localDecision }]
      });
    },
    OrislopClassifier: {
      mergeDetectorDecision(base, decision) {
        return { ...base, detectorStatus: decision.status, detectorDecision: decision };
      }
    },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} }
      },
      storage: {
        session: {
          async get() { return { "orislop.cloud.access": { token: "test-access", expiresAt: Date.now() + 60000 } }; },
          async set() {},
          async remove() {}
        },
        local: {
          async get() { return {}; },
          async set() {},
          async remove() {},
          onChanged: { addListener() {} }
        }
      },
      action: null
    }
  });
  context.globalThis = context;
  vm.runInContext(instrumented, context, { filename: "background.js" });
  return {
    classify: context.__classifyOrislopHybrid,
    setCloudReady(value) { cloudReady = value; },
    markCloudReady(settings) {
      cloudReady = true;
      context.__rememberCloudHeavyReadiness(settings, true, "ready");
    },
    setLocalDecision(value) { localDecision = { ...value }; },
    cloudAuthorization() { return authorization; },
    cloudRequestCount() { return cloudRequests; },
    analysisOrder() { return [...analysisOrder]; }
  };
}

function resolveBackgroundPerformance(source, hardware, settings) {
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "background performance test hook requires the production IIFE");
  const instrumented = `${source.slice(0, closureEnd)}globalThis.__resolveOrislopPerformance = getPerformanceProfile;\n${source.slice(closureEnd)}`;
  const context = vm.createContext({
    URL,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    navigator: {
      hardwareConcurrency: hardware.cores,
      deviceMemory: hardware.memoryGiB || undefined
    },
    importScripts() {},
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      action: null
    }
  });
  context.globalThis = context;
  vm.runInContext(instrumented, context, { filename: "background.js" });
  return context.__resolveOrislopPerformance(settings);
}

async function resolveBackgroundDetectorPerformance(source, hardware, settings, accelerator) {
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "background detector performance test hook requires the production IIFE");
  const instrumented = `${source.slice(0, closureEnd)}globalThis.__resolveOrislopDetectorPerformance = resolveDetectorPerformance;\n${source.slice(closureEnd)}`;
  const context = vm.createContext({
    URL,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, async json() { return { accelerator }; } }),
    navigator: {
      hardwareConcurrency: hardware.cores,
      deviceMemory: hardware.memoryGiB || undefined
    },
    importScripts() {},
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      action: null
    }
  });
  context.globalThis = context;
  vm.runInContext(instrumented, context, { filename: "background.js" });
  return context.__resolveOrislopDetectorPerformance(settings);
}
