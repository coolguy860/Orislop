const FLAGGED_KEY = "orislop.extension.flaggedLog";
const SKIPPED_KEY = "orislop.extension.skippedLog";
const SETTINGS_KEY = "orislop.extension.settings";
const OLLAMA_STATUS_KEY = "orislop.extension.ollamaStatus";
const DETECTOR_STATUS_KEY = "orislop.extension.detectorStatus";
const FACT_CHECK_STATUS_KEY = "orislop.extension.factCheckStatus";
const SCAN_STATUS_KEY = "orislop.extension.scanStatus";
const TELEMETRY_QUEUE_KEY = "orislop.productTelemetry.queueV1";
const TELEMETRY_IDENTITY_KEY = "orislop.productTelemetry.installationV1";
const TELEMETRY_STATUS_KEY = "orislop.productTelemetry.statusV1";
const ATTENTION_STATE_KEY = "orislop.productTelemetry.attentionV1";
const SLOP_PREFERENCE_API = globalThis.OrislopSlopPreferences;
const DEFAULT_SLOP_PREFERENCES = SLOP_PREFERENCE_API?.defaultIds || [];
const FILTER_BOT_PRESETS = Object.freeze({
  real_stuff: {
    label: "Keep originals",
    ids: ["fake_stories", "misleading_synthetic_media", "engagement_bait", "low_originality", "repetitive_templates", "reposted_stolen"],
    message: "Hiding bad claims, reposts, thin edits, and bait."
  },
  no_ai: {
    label: "Hide AI voices",
    ids: ["fully_ai_generated_video", "ai_voice_tts", "misleading_synthetic_media"],
    message: "Hiding AI video, fake voices, and misleading media."
  },
  brainrot_free: {
    label: "Cut filler",
    ids: ["brainrot", "engagement_bait", "repetitive_templates", "sidecar_satisfying_asmr", "low_originality"],
    message: "Hiding bait, templates, sidecar videos, and thin edits."
  },
  creator_mode: {
    label: "Creators first",
    ids: ["reposted_stolen", "compilations", "low_originality", "repetitive_templates"],
    message: "Hiding reposts, clip dumps, copy-paste posts, and thin edits."
  },
  chaos: {
    label: "Show all",
    ids: [],
    message: "All filters cleared. Labels can still show."
  }
});
const DEFAULT_SETTINGS = {
  enabled: true,
  hideSkipped: true,
  ollamaModel: "qwen2.5:1.5b-instruct",
  inferenceMode: "local",
  performanceMode: "heavy",
  cloudApiUrl: "https://api.orislop.com",
  productAnalyticsEnabled: false,
  attentionLogEnabled: false,
  watchIntentComplete: false,
  slopPreferences: [...DEFAULT_SLOP_PREFERENCES]
};
const CLOUD_BETA_CONFIGURED = Boolean(
  globalThis.OrislopOAuthConfig?.googleClientId
  && !String(globalThis.OrislopOAuthConfig.googleClientId).startsWith("__")
);
const storage = createStorageAdapter();
let pendingClear = "";
let runtimeHealth = null;
let cloudAccount = { signedIn: false };
let renderTimer = 0;

initializePreferenceControls();
initializeFilterBotControls();
void boot();

async function boot() {
  await render();
  if (storage.isExtensionStorage && chrome.runtime?.sendMessage) {
    await refreshCloudAccount(true);
    void requestPageScan(true);
    await refreshRuntimeHealth(true);
  }
}

async function render() {
  const [flagged, skipped, settings, ollamaStatus, detectorStatus, factCheckStatus, scanStatus, telemetryStatus] = await Promise.all([
    readList(FLAGGED_KEY),
    readList(SKIPPED_KEY),
    readSettings(),
    storage.get(OLLAMA_STATUS_KEY),
    storage.get(DETECTOR_STATUS_KEY),
    storage.get(FACT_CHECK_STATUS_KEY),
    storage.get(SCAN_STATUS_KEY),
    readTelemetryStatus()
  ]);
  document.getElementById("flaggedCount").textContent = compactNumber(flagged.length);
  document.getElementById("skippedCount").textContent = compactNumber(skipped.length);
  document.getElementById("minutesSaved").textContent = formatSavedTime(calculateSavedSeconds(skipped));
  setToggle("protectionToggle", settings.enabled);
  setToggle("hideSkippedToggle", settings.hideSkipped);
  setToggle("productAnalyticsToggle", settings.productAnalyticsEnabled);
  setToggle("attentionLogToggle", settings.attentionLogEnabled);
  renderProductPrivacy(settings, telemetryStatus);
  renderWatchIntent(settings);
  document.getElementById("ollamaModel").value = settings.ollamaModel;
  const inferenceMode = document.getElementById("inferenceMode");
  const hybridOption = inferenceMode.querySelector('option[value="hybrid"]');
  if (hybridOption) hybridOption.disabled = !CLOUD_BETA_CONFIGURED;
  inferenceMode.title = CLOUD_BETA_CONFIGURED ? "" : "Cloud Heavy is not configured in this local-only build.";
  inferenceMode.value = settings.inferenceMode;
  document.getElementById("performanceMode").value = settings.performanceMode;
  document.getElementById("performanceMode").disabled = settings.inferenceMode !== "local";
  document.getElementById("cloudApiUrl").value = settings.cloudApiUrl;
  document.getElementById("cloudSettings").hidden = settings.inferenceMode === "local";
  document.getElementById("cloudDisclosure").hidden = cloudAccount.signedIn === true;
  document.getElementById("cloudAccount").hidden = cloudAccount.signedIn !== true;
  if (cloudAccount.signedIn) {
    document.getElementById("cloudAccountName").textContent = cloudAccount.user?.name || "Google account";
    document.getElementById("cloudAccountEmail").textContent = cloudAccount.user?.email || "";
    const minute = Number(cloudAccount.quota?.minuteRemaining);
    const day = Number(cloudAccount.quota?.dayRemaining);
    document.getElementById("cloudQuotaStatus").textContent = Number.isFinite(minute) && Number.isFinite(day)
      ? `${minute} scans left this minute · ${day} today`
      : "Cloud Heavy account ready";
  }
  document.getElementById("localSetupNote").hidden = settings.inferenceMode === "cloud";
  document.getElementById("inferenceLocation").textContent = settings.inferenceMode === "cloud"
    ? "Cloud inference · no local engines"
    : settings.inferenceMode === "hybrid"
      ? "Hybrid · Fast first + selective Heavy"
      : "Local inference · private source keys";
  renderPerformanceNote(settings);
  renderActivity(skipped);
  renderScanStatus(scanStatus[SCAN_STATUS_KEY], settings);
  renderHealth(settings, ollamaStatus[OLLAMA_STATUS_KEY], detectorStatus[DETECTOR_STATUS_KEY], factCheckStatus[FACT_CHECK_STATUS_KEY]);
}

function initializePreferenceControls() {
  const host = document.getElementById("slopPreferenceGrid");
  if (!host || !SLOP_PREFERENCE_API) return;
  const categories = new Map((SLOP_PREFERENCE_API.categories || []).map((category) => [category.id, category]));
  const groups = new Map();
  for (const option of SLOP_PREFERENCE_API.definitions) {
    const categoryId = option.category || "other";
    if (!groups.has(categoryId)) groups.set(categoryId, []);
    groups.get(categoryId).push(option);
  }
  for (const [categoryId, options] of groups) {
    const category = categories.get(categoryId) || { label: "Additional Filters", detail: "More content types Orislop can filter." };
    const section = document.createElement("section");
    section.className = "slop-category";
    section.setAttribute("aria-label", category.label);
    const heading = document.createElement("div");
    heading.className = "slop-category-heading";
    const title = document.createElement("strong");
    title.textContent = category.label;
    const detail = document.createElement("small");
    detail.textContent = category.detail;
    heading.append(title, detail);
    const optionGrid = document.createElement("div");
    optionGrid.className = "slop-category-options";
    for (const option of options) {
      optionGrid.append(createPreferenceChoice(option));
    }
    section.append(heading, optionGrid);
    host.append(section);
  }
}

function createPreferenceChoice(option) {
  const label = document.createElement("label");
  label.className = "slop-choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = option.id;
  input.setAttribute("aria-label", option.label);
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = option.label;
  const detail = document.createElement("small");
  detail.textContent = option.detail;
  copy.append(title, detail);
  label.append(input, copy);
  return label;
}

function initializeFilterBotControls() {
  const applyButton = document.getElementById("applyFilterBotButton");
  const input = document.getElementById("filterBotInput");
  if (!applyButton || !input || !SLOP_PREFERENCE_API) return;
  for (const button of document.querySelectorAll("[data-filter-preset]")) {
    button.addEventListener("click", () => {
      const preset = FILTER_BOT_PRESETS[button.dataset.filterPreset];
      if (!preset) return;
      writeCheckedPreferences(preset.ids);
      setFilterBotReply(preset.message);
      previewWatchIntentCount();
      input.value = preset.label;
    });
  }
  applyButton.addEventListener("click", () => {
    const result = inferFilterBotPreferences(input.value);
    writeCheckedPreferences(result.ids);
    setFilterBotReply(result.message);
    previewWatchIntentCount();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyButton.click();
    }
  });
}

function inferFilterBotPreferences(value) {
  const text = String(value || "").trim().toLowerCase();
  const allIds = SLOP_PREFERENCE_API.definitions.map(({ id }) => id);
  if (!text) {
    return {
      ids: readCheckedPreferences(),
      message: "Type a sentence first."
    };
  }
  const includes = (...needles) => needles.some((needle) => text.includes(needle));
  if (includes("let chaos", "chaos", "unfiltered", "show everything", "filter nothing", "block nothing")) {
    return { ids: [], message: "All filters cleared. Labels can still show up." };
  }
  if (includes("strict", "block all", "filter all", "clean feed", "no slop", "everything bad")) {
    return { ids: allIds, message: `All ${allIds.length} filters on.` };
  }

  const selected = new Set();
  const reasons = [];
  const add = (reason, ids) => {
    for (const id of ids) selected.add(id);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (includes("ai", "synthetic", "deepfake", "fake video", "robot", "tts", "text to speech", "voice clone", "voiceover")) {
    add("AI media", ["fully_ai_generated_video", "ai_voice_tts", "misleading_synthetic_media"]);
  }
  if (includes("real", "news", "facts", "source", "sources", "receipt", "claim", "claims", "misinfo", "misinformation", "fake story", "storytime", "texting story", "reddit story", "lie", "proof", "blown out of proportion")) {
    add("claims and stories", ["fake_stories", "misleading_synthetic_media", "engagement_bait"]);
  }
  if (includes("original", "creator", "creators", "credit", "stolen", "repost", "reposted", "compilation", "clip dump", "remix", "movie clip", "cartoon clip", "twitter post", "tweet", "x post")) {
    add("reposts", ["reposted_stolen", "compilations", "low_originality", "repetitive_templates"]);
  }
  if (includes("brainrot", "sludge", "doomscroll", "parkour", "minecraft", "gameplay", "subway", "asmr", "satisfying", "split screen", "bottom video", "video at the bottom", "actual thing at the top", "phonk", "funk", "tier list", "ranking funniest")) {
    add("filler formats", ["brainrot", "sidecar_satisfying_asmr", "repetitive_templates", "engagement_bait", "low_originality"]);
  }
  if (includes("bait", "rage", "ragebait", "rage bait", "drama", "follow", "comment", "comments", "like and", "watch time", "viral")) {
    add("bait", ["engagement_bait", "fake_stories", "repetitive_templates"]);
  }
  if (includes("tutorial", "tutorials", "learn", "learning", "education", "educational", "useful", "explain", "explainer", "quality")) {
    add("low-effort videos", ["low_originality", "reposted_stolen", "compilations", "repetitive_templates"]);
  }
  if (selected.size === 0) {
    return {
      ids: readCheckedPreferences(),
      message: "No matching filter yet. Try AI voices, creators, or reposted clips."
    };
  }
  return {
    ids: [...selected],
    message: `${selected.size} filter${selected.size === 1 ? "" : "s"} on: ${reasons.slice(0, 3).join(", ")}.`
  };
}

function readCheckedPreferences() {
  return Array.from(
    document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]:checked'),
    (input) => input.value
  );
}

function writeCheckedPreferences(ids) {
  const selected = new Set(SLOP_PREFERENCE_API?.normalize(ids) || []);
  for (const input of document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]')) {
    input.checked = selected.has(input.value);
  }
}

function setFilterBotReply(message) {
  const host = document.getElementById("filterBotReply");
  if (host) host.textContent = message;
}

function renderWatchIntent(settings) {
  const panel = document.getElementById("watchIntentPanel");
  if (!panel) return;
  const selected = new Set(SLOP_PREFERENCE_API?.normalize(settings.slopPreferences) || []);
  for (const input of panel.querySelectorAll('input[type="checkbox"]')) input.checked = selected.has(input.value);
  const total = SLOP_PREFERENCE_API?.definitions.length || 0;
  const summary = document.getElementById("watchIntentSummary");
  summary.textContent = selected.size === 0
    ? "No filters on"
    : selected.size === total
      ? `All ${total} filters on`
      : `${selected.size}/${total} filters on`;
  panel.dataset.state = settings.watchIntentComplete ? "saved" : "onboarding";
  if (!settings.watchIntentComplete) panel.open = true;
  document.getElementById("saveWatchIntentButton").textContent = settings.watchIntentComplete
    ? "Save"
    : "Save";
}

function renderScanStatus(status, settings) {
  const host = document.getElementById("liveScan");
  const title = document.getElementById("scanStatusTitle");
  const detail = document.getElementById("scanStatusDetail");
  const count = document.getElementById("scanCheckedCount");
  const fastProgress = document.getElementById("fastScanProgress");
  const fastBar = document.getElementById("fastScanBar");
  const fastLatency = document.getElementById("fastScanLatency");
  const deepLabel = document.getElementById("deepScanLabel");
  const heavyProgress = document.getElementById("heavyScanProgress");
  const heavyBar = document.getElementById("heavyScanBar");
  const heavyLatency = document.getElementById("heavyScanLatency");
  const state = settings.enabled ? status?.state || "starting" : "paused";
  const platform = status?.platform;
  const platformName = platform === "youtube" ? "YouTube"
    : platform === "instagram" ? "Instagram"
      : platform === "tiktok" ? "TikTok"
        : platform === "linkedin" ? "LinkedIn"
          : "supported feed";
  const checkedCount = Math.max(0, Number(status?.checkedCount) || 0);
  const loadedCount = Math.max(0, Number(status?.loadedCount) || 0);
  const visibleCount = Math.max(0, Number(status?.visibleCount) || 0);
  const fastCheckedCount = Math.max(0, Number(status?.fastCheckedCount) || 0);
  const fastElapsedMs = Math.max(0, Number(status?.fastElapsedMs) || 0);
  const deepQueuedCount = Math.max(0, Number(status?.deepQueuedCount) || 0);
  const deepProcessedCount = Math.max(0, Number(status?.deepProcessedCount) || 0);
  const deepReadyCount = Math.max(0, Number(status?.deepReadyCount) || 0);
  const heavyEscalatedCount = Math.max(0, Number(status?.heavyEscalatedCount) || 0);
  const deepPendingCount = Math.max(0, Number(status?.deepPendingCount) || 0);
  const heavyP95Ms = Math.max(0, Number(status?.heavyP95Ms) || 0);
  const cloudPipeline = settings.inferenceMode === "hybrid" || settings.inferenceMode === "cloud";
  const localRefinedCount = Math.max(deepProcessedCount, deepReadyCount);
  host.dataset.state = state;
  count.textContent = `${compactNumber(checkedCount)} checked`;
  fastProgress.textContent = `${compactNumber(fastCheckedCount)} / ${compactNumber(loadedCount)}`;
  fastBar.style.width = `${progressPercent(fastCheckedCount, loadedCount)}%`;
  fastLatency.textContent = fastElapsedMs > 0
    ? `${formatLatency(fastElapsedMs)} fast pass${status?.fastWithinTarget === true ? " | under 2s target" : ""}`
    : "Waiting for feed items";
  deepLabel.textContent = settings.inferenceMode === "hybrid"
    ? "Second look"
    : cloudPipeline ? "Cloud check" : "Local check";
  heavyProgress.textContent = cloudPipeline
    ? settings.inferenceMode === "hybrid"
      ? `${compactNumber(deepReadyCount)} / ${compactNumber(heavyEscalatedCount)} verified`
      : `${compactNumber(deepReadyCount)} / ${compactNumber(deepQueuedCount)} ready`
    : `${compactNumber(localRefinedCount)} / ${compactNumber(deepQueuedCount)}`;
  const heavyTargetCount = settings.inferenceMode === "hybrid" ? heavyEscalatedCount : deepQueuedCount;
  heavyBar.style.width = `${progressPercent(cloudPipeline ? deepReadyCount : localRefinedCount, heavyTargetCount)}%`;
  heavyLatency.textContent = heavyP95Ms > 0
    ? `${formatLatency(heavyP95Ms)} measured P95 this sweep`
    : settings.inferenceMode === "hybrid" && heavyEscalatedCount === 0
      ? "Fast pass cleared these items"
    : deepPendingCount > 0
      ? `${compactNumber(deepPendingCount)} pending | playback stays responsive`
      : cloudPipeline
        ? "Second look only runs when needed"
        : "One final decision per item";
  if (state === "paused") {
    title.textContent = "Scanner paused";
    detail.textContent = "Turn it back on to keep checking your feed.";
  } else if (state === "scanning") {
    title.textContent = `Checking ${platformName}`;
    detail.textContent = loadedCount > 0
      ? `Fast pass checked ${loadedCount}; ${settings.inferenceMode === "hybrid" ? "uncertain results get a second look" : cloudPipeline ? "cloud check" : "local check"} handles the rest.`
      : platform === "linkedin"
        ? "Reading loaded posts, images, profiles, and video previews without leaving the page."
        : "Reading the current video and every feed item already loaded.";
  } else if (state === "active") {
    title.textContent = `${platformName} is covered`;
    detail.textContent = loadedCount > 0
      ? `${loadedCount} loaded item${loadedCount === 1 ? "" : "s"} checked${visibleCount > 0 ? ` | ${visibleCount} visible` : ""}${status?.phase === "refining" ? " | second look still running" : ""}.`
      : platform === "linkedin" ? "Watching for the next LinkedIn item." : "Watching for the next video.";
  } else if (state === "error") {
    title.textContent = "Scanner needs attention";
    detail.textContent = friendlyProblem(status?.error, "scan");
  } else {
    title.textContent = "Ready when you open a feed";
    detail.textContent = "YouTube, Instagram, TikTok, or LinkedIn starts the scanner automatically.";
  }
}

function progressPercent(value, total) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatLatency(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

function renderPerformanceNote(settings) {
  const host = document.getElementById("performanceNote");
  const profile = runtimeHealth?.performance;
  const localOnlySuffix = CLOUD_BETA_CONFIGURED ? "" : " Cloud Heavy is not configured in this local-only build.";
  if (settings.inferenceMode === "cloud") {
    host.textContent = "Cloud mode always runs full Heavy detection on the server.";
    return;
  }
  if (settings.inferenceMode === "hybrid") {
    const cloud = runtimeHealth?.cloudHeavy;
    const cloudState = cloud?.available === true
      ? ` Cloud Heavy is ready on ${cloud.accelerator || "the server"}.`
      : cloud ? " Cloud Heavy is offline, so local Fast is the safe fallback." : "";
    host.textContent = `Local Fast runs first on every eligible item. Only uncertain, missing-evidence, or suspicious results escalate to Cloud Heavy; a clear Fast result avoids the GPU round trip.${cloudState}`;
    return;
  }
  if (!profile) {
    host.textContent = settings.performanceMode === "auto"
      ? `Automatic checks this PC and chooses the safer performance level.${localOnlySuffix}`
      : settings.performanceMode === "fast"
        ? `Fast keeps the large spatial and temporal models off.${localOnlySuffix}`
        : `Heavy uses the complete spatial and temporal pipeline.${localOnlySuffix}`;
    return;
  }
  const hardware = [
    profile.cores ? `${profile.cores} threads` : "",
    profile.memoryGiB ? `${profile.memoryGiB} GB memory hint` : ""
  ].filter(Boolean).join(" / ");
  const prefix = settings.performanceMode === "auto"
    ? `Automatic selected ${capitalize(profile.effective)}.`
    : `${capitalize(profile.effective)} mode active.`;
  host.textContent = `${prefix}${hardware ? ` ${hardware}.` : ""} ${profile.effective === "fast" ? "Large visual models stay off." : "Full visual detection is enabled."}${localOnlySuffix}`;
}

function renderHealth(settings, storedOllama, storedDetector, storedFactChecker) {
  const ollama = runtimeHealth?.ollama || storedOllama || { state: "checking" };
  const detector = runtimeHealth?.detector || storedDetector || { state: "checking" };
  const factChecker = runtimeHealth?.factChecker || detector.factChecker || storedFactChecker || { state: "checking" };
  const ollamaAvailable = ollama.state === "available" || ollama.installed === true;
  const detectorAvailable = detector.available === true || ["available", "provisional", "pending", "idle", "heavyweight_loading", "heavyweight_analyzing"].includes(detector.state);
  const factCheckerAvailable = factChecker.configured === true && !["unavailable", "error", "unconfigured"].includes(factChecker.state);
  const coreChecking = [ollama.state, detector.state].some((state) => !state || state === "checking");

  renderEngineCard("language", ollamaAvailable ? "available" : ollama.state === "checking" ? "checking" : "unavailable", {
    state: ollamaAvailable ? "Ready" : ollama.state === "model_missing" ? "Model needed" : ollama.state === "checking" ? "Checking" : "Offline",
    detail: ollamaAvailable
      ? `Understands titles and captions${settings.inferenceMode === "cloud" ? " · cloud" : ""}`
      : settings.inferenceMode === "cloud" ? "The cloud context check is waking up" : "Open Orislop Companion to turn this on"
  });
  const visualWarming = detectorAvailable && detector.state !== "available" && detector.state !== "idle";
  renderEngineCard("visual", detectorAvailable ? "available" : detector.state === "checking" ? "checking" : "unavailable", {
    state: detectorAvailable ? visualWarming ? "Verifying" : "Ready" : detector.state === "checking" ? "Checking" : "Offline",
    detail: detectorAvailable
      ? `${detector.accelerator || (settings.inferenceMode === "cloud" ? "cloud" : "local")}${Number(detector.queueDepth || detector.queue_depth) ? ` · ${Number(detector.queueDepth || detector.queue_depth)} queued` : ""}`
      : settings.inferenceMode === "cloud" ? "The cloud media check is waking up" : "Open Orislop Companion to turn this on"
  });
  renderEngineCard("evidence", factCheckerAvailable ? "available" : factChecker.state === "checking" ? "checking" : "limited", {
    state: factCheckerAvailable ? factChecker.state === "checking" ? "Verifying" : "Ready" : factChecker.state === "checking" ? "Checking" : "Optional setup",
    detail: factCheckerAvailable
      ? `${readyProviderNames(factChecker).join(" + ") || "Trusted sources"}${Number(factChecker.queue_depth || factChecker.queueDepth) ? ` · ${Number(factChecker.queue_depth || factChecker.queueDepth)} queued` : ""}`
      : settings.inferenceMode === "cloud" ? "The cloud evidence check is waking up" : "Optional: connect a source provider"
  });

  const overall = document.getElementById("overallStatus");
  const title = document.getElementById("protectionTitle");
  const detail = document.getElementById("protectionDetail");
  if (!settings.enabled) {
    overall.dataset.state = "paused";
    overall.innerHTML = '<i aria-hidden="true"></i>Paused';
    title.textContent = "Paused for now";
    detail.textContent = "Your feed is unchanged until Orislop is turned on again.";
  } else if (coreChecking) {
    overall.dataset.state = "checking";
    overall.innerHTML = '<i aria-hidden="true"></i>Checking';
    title.textContent = "Checking your feed setup";
    detail.textContent = "Confirming that text, media, and evidence checks are available.";
  } else if (ollamaAvailable && detectorAvailable) {
    overall.dataset.state = "active";
    overall.innerHTML = '<i aria-hidden="true"></i>Active';
    title.textContent = visualWarming ? "Second look is loading" : "Your feed is covered";
    detail.textContent = visualWarming
      ? "Fast checks are active while the second look finishes loading."
      : factCheckerAvailable
        ? "Text, media, and evidence checks are online."
        : "Text and media checks are online. Evidence checks need a provider key.";
  } else {
    overall.dataset.state = "attention";
    overall.innerHTML = '<i aria-hidden="true"></i>Attention';
    title.textContent = ollamaAvailable || detectorAvailable ? "Almost ready" : "Finish setup";
    detail.textContent = settings.inferenceMode === "cloud"
      ? "The deeper cloud check needs attention. Fast protection is still active."
      : !ollamaAvailable && !detectorAvailable
        ? "Open Orislop Companion for full coverage. Fast protection is still active."
        : !ollamaAvailable ? "Media checks are ready; open Orislop Companion for caption context."
          : !detectorAvailable ? "Caption context is ready; open Orislop Companion for media checks."
            : "Optional source verification is not connected yet.";
  }

  renderOllamaStatus(settings, ollama);
  renderDetectorStatus(detector);
  renderFactCheckStatus(factChecker);
}

function renderEngineCard(prefix, state, copy) {
  const card = document.getElementById(`${prefix}EngineCard`);
  card.dataset.state = state;
  document.getElementById(`${prefix}EngineState`).textContent = copy.state;
  document.getElementById(`${prefix}EngineDetail`).textContent = copy.detail;
}

function renderActivity(records) {
  const host = document.getElementById("skippedList");
  host.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No hidden items yet.";
    host.append(empty);
    return;
  }
  for (const record of records.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const mark = document.createElement("span");
    mark.className = "activity-mark";
    mark.textContent = "O";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = record.title || "Feed item";
    const detail = document.createElement("small");
    const saved = normalizeSavedSeconds(record);
    detail.textContent = `${capitalize(record.platform || "feed")} · ${formatRelativeTime(record.createdAt)}${saved > 0 ? ` · ${formatSavedTime(saved)} saved` : ""}`;
    const score = document.createElement("span");
    score.className = "activity-score";
    score.textContent = `${Number(record.score) || 100}`;
    copy.append(title, detail);
    const avJoint = record.detectorDecision?.avJoint;
    if (avJoint?.available === true) {
      const diagnostics = document.createElement("details");
      diagnostics.className = "activity-diagnostics";
      const summary = document.createElement("summary");
      summary.textContent = avJoint.state === "ready" ? "Audio-visual check" : "Why AV abstained";
      const explanation = document.createElement("small");
      const scores = avJoint.state === "ready"
        ? `Forgery ${formatProbability(avJoint.jointForgeryProbability)} · sync ${formatProbability(avJoint.syncMismatchProbability)} · uncertainty ${formatProbability(avJoint.uncertainty)}`
        : (avJoint.gateReasons || []).join(", ").replaceAll("_", " ") || "No reliable visible speaker";
      explanation.textContent = `${avJoint.summary || "Joint AV analysis"} · ${scores} · ${avJoint.rolloutMode || "shadow"} mode`;
      diagnostics.append(summary, explanation);
      copy.append(diagnostics);
    }
    item.append(mark, copy, score);
    host.append(item);
  }
}

function formatProbability(value) {
  const probability = Number(value);
  return Number.isFinite(probability) ? `${Math.round(Math.max(0, Math.min(1, probability)) * 100)}%` : "n/a";
}

function calculateSavedSeconds(records) {
  const byItem = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = String(record?.itemKey || record?.itemId || record?.id || "");
    if (!key) continue;
    byItem.set(key, Math.max(byItem.get(key) || 0, normalizeSavedSeconds(record)));
  }
  return Array.from(byItem.values()).reduce((total, seconds) => total + seconds, 0);
}

function normalizeSavedSeconds(record) {
  const explicit = Number(record?.savedSeconds);
  const fallback = Number(record?.durationSeconds);
  const seconds = Number.isFinite(explicit) && explicit >= 0 ? explicit : fallback;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(12 * 60 * 60, Math.round(seconds)) : 0;
}

function formatSavedTime(secondsInput) {
  const seconds = Math.max(0, Number(secondsInput) || 0);
  if (seconds === 0) return "0m";
  const minutes = seconds / 60;
  if (minutes < 1) return `${Math.max(0.1, Math.round(minutes * 10) / 10)}m`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function renderOllamaStatus(settings, status) {
  const host = document.getElementById("ollamaStatus");
  const state = status?.state || "checking";
  host.dataset.state = state;
  if (state === "available" || status?.installed === true) host.textContent = "Ready to understand titles and captions.";
  else if (state === "degraded") host.textContent = friendlyProblem(status?.error, "context");
  else if (state === "model_missing") host.textContent = "The local context helper still needs to finish setup.";
  else if (state === "bypassed_hard_ai") host.textContent = "A synthetic-media rule handled the latest item.";
  else host.textContent = friendlyProblem(status?.error, "context");
}

function renderDetectorStatus(status) {
  const host = document.getElementById("detectorStatus");
  const state = status?.state || "checking";
  host.dataset.state = state;
  if (status?.available === true || state === "available" || state === "idle") host.textContent = `Ready to inspect media${status?.accelerator ? ` on ${status.accelerator}` : ""}.`;
  else if (state === "provisional" || String(state).includes("loading")) host.textContent = "Fast checks are on; second look is loading.";
  else if (state === "pending" || String(state).includes("analyzing")) host.textContent = "Visual check is working through the queue.";
  else host.textContent = friendlyProblem(status?.error, "visual");
}

function renderFactCheckStatus(status) {
  const host = document.getElementById("factCheckStatus");
  const state = status?.state || "checking";
  host.dataset.state = state;
  if (status?.configured === true) {
    const providers = readyProviderNames(status);
    host.textContent = `${providers.join(" and ") || "Source check"} is ready.`;
  } else if (state === "checking") host.textContent = "Checking source provider configuration.";
  else host.textContent = friendlyProblem(status?.error, "evidence");
}

function readyProviderNames(status) {
  const providers = status?.providers || {};
  const labels = { brave_search: "Brave Search", google_fact_check: "Google Fact Check" };
  return Object.entries(providers).filter(([, state]) => state === "ready").map(([name]) => labels[name] || name);
}

async function refreshRuntimeHealth(quiet = false) {
  const settings = await readSettings();
  if (!quiet) setStatus("Refreshing the scanners...");
  const response = await sendMessage({ type: "orislop.runtimeHealth", model: settings.ollamaModel });
  if (response?.ollama && response?.detector) {
    runtimeHealth = response;
    await storage.set({
      [OLLAMA_STATUS_KEY]: { ...response.ollama, checkedAt: response.checkedAt },
      [DETECTOR_STATUS_KEY]: { ...response.detector, checkedAt: response.checkedAt },
      [FACT_CHECK_STATUS_KEY]: { ...response.factChecker, checkedAt: response.checkedAt }
    });
  }
  const coreReady = response?.ollama?.state === "available" && response?.detector?.available === true;
  if (!quiet) setStatus(coreReady ? "Orislop is ready." : "Some checks need attention.");
  await render();
}

document.getElementById("scanNowButton").addEventListener("click", () => requestPageScan(false));

async function requestPageScan(quiet = false) {
  if (!storage.isExtensionStorage || !globalThis.chrome?.tabs?.query || !globalThis.chrome?.tabs?.sendMessage) {
    if (!quiet) setStatus("Open YouTube, Instagram, TikTok, or LinkedIn, then run the scan.");
    return;
  }
  if (!quiet) setStatus("Starting a scan...");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!Number.isInteger(tabId)) {
    if (!quiet) setStatus("No active supported feed was found.");
    return;
  }
  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "orislop.scanNow" }, (value) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : value);
    });
  });
  if (!quiet) {
    setStatus(response?.ok ? "Scan started." : "Open YouTube, Instagram, TikTok, or LinkedIn, then try again.");
  }
  window.setTimeout(() => void render(), 450);
}

document.getElementById("protectionToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, enabled: event.target.checked });
  setStatus(event.target.checked ? "Back on." : "Paused. Hidden items came back.");
  await render();
});

document.getElementById("hideSkippedToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, hideSkipped: event.target.checked });
  setStatus(event.target.checked ? "Auto-hide is on." : "Auto-hide is off.");
  await render();
});

document.getElementById("productAnalyticsToggle").addEventListener("change", async (event) => {
  const enabled = event.target.checked === true;
  const settings = await readSettings();
  await saveSettings({ ...settings, productAnalyticsEnabled: enabled });
  await sendMessage({ type: "orislop.telemetryPrivacyUpdate", enabled });
  setStatus(enabled ? "Anonymous product insights are on. Feed content is never included." : "Anonymous product insights are off and local telemetry was cleared.");
  await render();
});

document.getElementById("attentionLogToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, attentionLogEnabled: event.target.checked === true });
  setStatus(event.target.checked ? "Optional session check-ins are on." : "Optional session check-ins are off.");
  await render();
});

document.getElementById("sendTelemetryNowButton").addEventListener("click", async () => {
  setStatus("Sending queued product insights...");
  const result = await sendMessage({ type: "orislop.telemetryFlush" });
  setStatus(result?.ok ? "Queued product insights sent." : "Could not send them yet. Orislop will retry later.");
  await render();
});

for (const button of document.querySelectorAll("[data-attention-response]")) {
  button.addEventListener("click", async () => {
    const response = button.dataset.attentionResponse;
    const result = await sendMessage({ type: "orislop.attentionResponse", response });
    document.getElementById("attentionLogCard").hidden = true;
    setStatus(result?.saved ? "Thanks. That check-in was saved without feed content." : "Check-in dismissed.");
  });
}

document.getElementById("selectAllSlopButton").addEventListener("click", () => {
  for (const input of document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]')) input.checked = true;
  previewWatchIntentCount();
});

document.getElementById("clearSlopButton").addEventListener("click", () => {
  for (const input of document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]')) input.checked = false;
  previewWatchIntentCount();
});

document.getElementById("slopPreferenceGrid").addEventListener("change", previewWatchIntentCount);

document.getElementById("saveWatchIntentButton").addEventListener("click", async () => {
  const settings = await readSettings();
  const slopPreferences = Array.from(
    document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]:checked'),
    (input) => input.value
  );
  await saveSettings({ ...settings, watchIntentComplete: true, slopPreferences });
  document.getElementById("watchIntentPanel").open = false;
  setStatus(slopPreferences.length > 0
    ? `Saved. ${slopPreferences.length} filter${slopPreferences.length === 1 ? "" : "s"} on.`
    : "Saved. No filters are on.");
  await requestPageScan(true);
  await render();
});

function previewWatchIntentCount() {
  const selected = document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]:checked').length;
  const total = SLOP_PREFERENCE_API?.definitions.length || 0;
  document.getElementById("watchIntentSummary").textContent = selected === 0
    ? "No filters on"
    : selected === total
      ? `All ${total} filters on`
      : `${selected}/${total} filters on`;
}

document.getElementById("ollamaModel").addEventListener("change", async () => {
  const settings = await readSettings();
  await saveSettings({ ...settings, ollamaModel: readModelInput() });
  runtimeHealth = null;
  setStatus("Context model saved.");
  await refreshRuntimeHealth(true);
});

document.getElementById("inferenceMode").addEventListener("change", async (event) => {
  const settings = await readSettings();
  if (event.target.value === "hybrid" && !CLOUD_BETA_CONFIGURED) {
    event.target.value = "local";
    setStatus("Cloud Heavy is not configured in this local-only build.");
    return;
  }
  const inferenceMode = event.target.value === "hybrid" ? "hybrid" : "local";
  await saveSettings({ ...settings, inferenceMode });
  runtimeHealth = null;
  setStatus(inferenceMode === "hybrid"
    ? cloudAccount.signedIn ? "Hybrid mode on." : "Review the disclosure and sign in to enable Cloud Heavy."
    : "Local mode selected.");
  await render();
  await refreshRuntimeHealth(true);
});

document.getElementById("performanceMode").addEventListener("change", async (event) => {
  const settings = await readSettings();
  const performanceMode = ["fast", "heavy"].includes(event.target.value) ? event.target.value : "auto";
  await saveSettings({ ...settings, performanceMode });
  runtimeHealth = null;
  setStatus(performanceMode === "auto" ? "Automatic performance on." : `${capitalize(performanceMode)} mode selected.`);
  await refreshRuntimeHealth(true);
});

document.getElementById("cloudApiUrl").addEventListener("change", saveCloudSettings);

async function saveCloudSettings() {
  const settings = await readSettings();
  await saveSettings({
    ...settings,
    cloudApiUrl: readCloudApiUrl()
  });
  runtimeHealth = null;
  setStatus("Cloud connection settings saved.");
  await refreshRuntimeHealth(true);
}

document.getElementById("cloudSignInButton").addEventListener("click", async () => {
  setStatus("Opening Google sign-in...");
  const response = await sendMessage({ type: "orislop.cloudSignIn" });
  if (response?.ok) {
    cloudAccount = response;
    setStatus("Cloud Heavy enabled. Local Fast remains the immediate fallback.");
    await refreshCloudAccount(true);
    runtimeHealth = null;
    await refreshRuntimeHealth(true);
  } else {
    setStatus(friendlyProblem(response?.error, "signin"));
    await render();
  }
});

document.getElementById("cloudSignOutButton").addEventListener("click", async () => {
  const response = await sendMessage({ type: "orislop.cloudSignOut" });
  if (response?.ok) cloudAccount = { signedIn: false };
  setStatus(response?.ok ? "Signed out. Local Fast is still active." : friendlyProblem(response?.error, "signout"));
  await render();
});

document.getElementById("cloudDeleteAccountButton").addEventListener("click", async () => {
  if (!window.confirm("Delete your Orislop beta account and revoke every session?")) return;
  const response = await sendMessage({ type: "orislop.cloudDeleteAccount" });
  if (response?.ok && response?.deleted === true) cloudAccount = { signedIn: false };
  setStatus(response?.ok ? "Orislop beta account deleted." : friendlyProblem(response?.error, "account"));
  await render();
});

async function refreshCloudAccount(quiet = false) {
  const response = await sendMessage({ type: "orislop.cloudAccount" });
  cloudAccount = response?.signedIn ? response : { signedIn: false, error: response?.error || "" };
  if (!quiet && !response?.signedIn) setStatus(response?.error ? friendlyProblem(response.error, "signin") : "Sign in to enable Cloud Heavy.");
  return cloudAccount;
}

document.getElementById("testOllamaButton").addEventListener("click", testOllama);
document.getElementById("testDetectorButton").addEventListener("click", testDetector);
document.getElementById("testFactCheckerButton").addEventListener("click", testFactChecker);
document.getElementById("copyDiagnosticsButton").addEventListener("click", copyDiagnostics);

async function testOllama() {
  setStatus("Running a live context check...");
  const response = await sendMessage({ type: "orislop.testOllama", model: readModelInput() });
  await storage.set({
    [OLLAMA_STATUS_KEY]: response?.ok
      ? { state: "available", model: response.model || readModelInput(), installed: true, error: "", checkedAt: Date.now() }
      : { state: "unavailable", model: readModelInput(), installed: false, error: friendlyProblem(response?.error || response?.message, "context"), checkedAt: Date.now() }
  });
  runtimeHealth = null;
  setStatus(response?.ok ? (response?.message || "Context check passed.") : friendlyProblem(response?.error || response?.message, "context"));
  await render();
}

async function testDetector() {
  setStatus("Checking the visual scanner...");
  const response = await sendMessage({ type: "orislop.testDetector" });
  await storage.set({
    [DETECTOR_STATUS_KEY]: response?.ok
      ? { state: response.state || "available", available: true, version: response.version, modelStates: response.modelStates, queueDepth: response.queueDepth, error: "", checkedAt: Date.now() }
      : { state: "unavailable", available: false, error: friendlyProblem(response?.error || response?.message, "visual"), checkedAt: Date.now() }
  });
  runtimeHealth = null;
  setStatus(response?.ok ? (response?.message || "Media check passed.") : friendlyProblem(response?.error || response?.message, "visual"));
  await render();
}

async function testFactChecker() {
  setStatus("Checking evidence provider configuration...");
  const response = await sendMessage({ type: "orislop.testFactChecker" });
  await storage.set({
    [FACT_CHECK_STATUS_KEY]: response?.ok
      ? { state: response.state || "idle", configured: true, providers: response.providers || {}, queueDepth: response.queueDepth, error: "", checkedAt: Date.now() }
      : { state: response?.state || "unconfigured", configured: false, providers: response?.providers || {}, error: friendlyProblem(response?.error || response?.message, "evidence"), checkedAt: Date.now() }
  });
  runtimeHealth = null;
  setStatus(response?.ok ? (response?.message || "Evidence check passed.") : friendlyProblem(response?.error || response?.message, "evidence"));
  await render();
}

async function copyDiagnostics() {
  const settings = await readSettings();
  const values = await storage.get([OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY, FACT_CHECK_STATUS_KEY, SCAN_STATUS_KEY]);
  const report = {
    product: "Orislop Shield",
      version: "1.3.0",
    generatedAt: new Date().toISOString(),
    protectionEnabled: settings.enabled,
    hideSkipped: settings.hideSkipped,
    inferenceMode: settings.inferenceMode,
    performanceMode: settings.performanceMode,
    watchIntentComplete: settings.watchIntentComplete,
    slopPreferenceCount: settings.slopPreferences.length,
    performance: runtimeHealth?.performance || null,
    cloudApiUrl: settings.inferenceMode !== "local" ? settings.cloudApiUrl : null,
    ollamaModel: settings.ollamaModel,
    ollama: values[OLLAMA_STATUS_KEY] || null,
    detector: values[DETECTOR_STATUS_KEY] || null,
    factChecker: values[FACT_CHECK_STATUS_KEY] || null,
    scanner: values[SCAN_STATUS_KEY] || null
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setStatus("Diagnostics copied. Activity titles and URLs were not included.");
  } catch {
    setStatus("Clipboard access was blocked. Reopen the popup and try again.");
  }
}

document.getElementById("clearSkippedButton").addEventListener("click", () => requestClear("skipped"));
document.getElementById("clearAllDataButton").addEventListener("click", () => requestClear("all"));
document.getElementById("cancelClearButton").addEventListener("click", closeClear);
document.getElementById("confirmClearButton").addEventListener("click", async () => {
  const action = pendingClear;
  if (action === "all") await sendMessage({ type: "orislop.telemetryPrivacyUpdate", enabled: false });
  await storage.remove(action === "all" ? [FLAGGED_KEY, SKIPPED_KEY, SETTINGS_KEY, OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY, FACT_CHECK_STATUS_KEY, SCAN_STATUS_KEY, TELEMETRY_QUEUE_KEY, TELEMETRY_IDENTITY_KEY, TELEMETRY_STATUS_KEY, ATTENTION_STATE_KEY] : [SKIPPED_KEY]);
  runtimeHealth = null;
  closeClear();
  setStatus(action === "all" ? "Local Orislop data cleared." : "Protected activity cleared.");
  await render();
});

function requestClear(action) {
  pendingClear = action;
  document.getElementById("clearConfirmation").hidden = false;
  document.getElementById("confirmClearButton").focus();
}

function closeClear() {
  pendingClear = "";
  document.getElementById("clearConfirmation").hidden = true;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingClear) closeClear();
});

async function readList(key) {
  const result = await storage.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function readSettings() {
  const result = await storage.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    hideSkipped: typeof value.hideSkipped === "boolean" ? value.hideSkipped : typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideSkipped,
    ollamaModel: /^[a-zA-Z0-9._:/-]{1,100}$/.test(String(value.ollamaModel || "")) ? String(value.ollamaModel) : DEFAULT_SETTINGS.ollamaModel,
    inferenceMode: CLOUD_BETA_CONFIGURED && value.inferenceMode === "hybrid" ? "hybrid" : "local",
    performanceMode: ["auto", "fast", "heavy"].includes(value.performanceMode) ? value.performanceMode : DEFAULT_SETTINGS.performanceMode,
    cloudApiUrl: sanitizeCloudApiUrl(value.cloudApiUrl),
    productAnalyticsEnabled: value.productAnalyticsEnabled === true,
    attentionLogEnabled: value.attentionLogEnabled === true,
    watchIntentComplete: value.watchIntentComplete === true,
    slopPreferences: SLOP_PREFERENCE_API?.normalize(value.slopPreferences) || [...DEFAULT_SLOP_PREFERENCES]
  };
}

async function saveSettings(settings) {
  await storage.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

async function readTelemetryStatus() {
  if (!storage.isExtensionStorage) return { ok: true, enabled: false, queued: 0, attentionEligible: false };
  return sendMessage({ type: "orislop.telemetryStatus" });
}

function renderProductPrivacy(settings, status) {
  const queued = Math.max(0, Number(status?.queued) || 0);
  const sent = Math.max(0, Number(status?.sent) || 0);
  const host = document.getElementById("telemetryStatus");
  if (!settings.productAnalyticsEnabled) {
    host.textContent = "No product insights are being shared.";
  } else if (status?.lastErrorCode) {
    host.textContent = `${queued} anonymous insight${queued === 1 ? "" : "s"} waiting. Orislop will retry safely.`;
  } else if (queued > 0) {
    host.textContent = `${queued} anonymous insight${queued === 1 ? "" : "s"} queued; ${sent} delivered from this browser.`;
  } else {
    host.textContent = `Anonymous insights are on; ${sent} delivered from this browser.`;
  }
  document.getElementById("sendTelemetryNowButton").hidden = !settings.productAnalyticsEnabled || queued === 0;
  document.getElementById("attentionLogCard").hidden = !(settings.attentionLogEnabled && status?.attentionEligible === true);
}

function setToggle(id, checked) {
  const element = document.getElementById(id);
  element.checked = checked;
  element.setAttribute("aria-checked", String(checked));
}

function sendMessage(message) {
  if (!storage.isExtensionStorage || !globalThis.chrome?.runtime?.sendMessage) return Promise.resolve({ ok: false, error: "Load Orislop as an extension to run diagnostics." });
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response));
  });
}

function friendlyProblem(value, area = "general") {
  const text = String(value || "").toLowerCase();
  if (/429|rate limit|too many|quota/.test(text)) {
    return "That service is busy right now. Fast protection is still working, so try again shortly.";
  }
  if (/401|403|unauthor|forbidden|token|session|expired/.test(text)) {
    return area === "signin"
      ? "Sign-in did not finish. Close the Google window, then try once more."
      : "Your secure connection expired. Sign in again to restore deeper checks.";
  }
  if (/timeout|timed out|abort/.test(text)) {
    return "That check took too long, so Orislop left the item visible. Try again in a moment.";
  }
  if (/model_missing|not installed|pull model|no model/.test(text)) {
    return "The local AI is still being installed. Fast protection is already working.";
  }
  if (/loading|warming|starting|503|service unavailable/.test(text)) {
    return "The deeper checker is warming up. Fast protection is already working.";
  }
  if (/fetch|network|econn|refused|reachable|offline|failed to connect|receiving end does not exist/.test(text)) {
    return area === "scan"
      ? "Open a supported feed and refresh the page, then choose Scan now."
      : area === "context" || area === "visual"
        ? "Orislop Companion is not running yet. Open it on this computer, then try again."
        : "Orislop cannot reach that service right now. Your feed stays visible and Fast protection stays on.";
  }
  if (/not configured|missing|api key|provider/.test(text)) {
    return area === "evidence"
      ? "Source checking is optional and has not been connected yet."
      : "Finish the short setup to turn on this deeper check.";
  }
  const fallback = {
    scan: "The last scan did not finish. Refresh the feed, then choose Scan now.",
    context: "The context checker needs attention. Fast protection is still working.",
    visual: "The media checker needs attention. Fast protection is still working.",
    evidence: "Source checking is optional and is not available right now.",
    signin: "Sign-in did not finish. Try again, or keep using private local protection.",
    signout: "Sign-out did not finish. Check your connection and try again.",
    account: "Your account could not be removed right now. Try again in a moment."
  };
  return fallback[area] || "Something interrupted that check. Your feed was left unchanged; try again in a moment.";
}

function readModelInput() {
  const value = document.getElementById("ollamaModel").value.trim();
  return /^[a-zA-Z0-9._:/-]{1,100}$/.test(value) ? value : DEFAULT_SETTINGS.ollamaModel;
}

function readCloudApiUrl() {
  return sanitizeCloudApiUrl(document.getElementById("cloudApiUrl").value);
}

function sanitizeCloudApiUrl(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_SETTINGS.cloudApiUrl));
    const localDevelopment = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
    const productionCloud = parsed.protocol === "https:" && parsed.hostname === "api.orislop.com";
    if (!productionCloud && !localDevelopment) return DEFAULT_SETTINGS.cloudApiUrl;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return DEFAULT_SETTINGS.cloudApiUrl;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return DEFAULT_SETTINGS.cloudApiUrl;
  }
}

function setStatus(message) {
  document.getElementById("popupStatus").textContent = message;
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Feed";
}

function formatRelativeTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "recently";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function createStorageAdapter() {
  const isExtensionStorage = Boolean(globalThis.chrome?.storage?.local);
  if (isExtensionStorage) {
    return {
      isExtensionStorage: true,
      get: (keys) => chrome.storage.local.get(keys),
      set: (value) => chrome.storage.local.set(value),
      remove: (keys) => chrome.storage.local.remove(keys)
    };
  }
  return {
    isExtensionStorage: false,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, JSON.parse(localStorage.getItem(key) || "null")]));
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) localStorage.setItem(key, JSON.stringify(item));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(key);
    }
  };
}

globalThis.chrome?.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local") return;
  const relevant = [FLAGGED_KEY, SKIPPED_KEY, SETTINGS_KEY, OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY, FACT_CHECK_STATUS_KEY, SCAN_STATUS_KEY];
  if (!relevant.some((key) => changes[key])) return;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void render(), 80);
});
