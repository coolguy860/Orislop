const FLAGGED_KEY = "orislop.extension.flaggedLog";
const SKIPPED_KEY = "orislop.extension.skippedLog";
const SETTINGS_KEY = "orislop.extension.settings";
const OLLAMA_STATUS_KEY = "orislop.extension.ollamaStatus";
const DETECTOR_STATUS_KEY = "orislop.extension.detectorStatus";
const FACT_CHECK_STATUS_KEY = "orislop.extension.factCheckStatus";
const SCAN_STATUS_KEY = "orislop.extension.scanStatus";
const SLOP_PREFERENCE_API = globalThis.OrislopSlopPreferences;
const DEFAULT_SLOP_PREFERENCES = SLOP_PREFERENCE_API?.defaultIds || [];
const LEGACY_OLLAMA_MODEL = "qwen2.5:1.5b-instruct";
const ORISLOP_OLLAMA_MODEL = "orislop-qwen2.5:1.5b-instruct";
const DEFAULT_SETTINGS = {
  enabled: true,
  hideSkipped: true,
  ollamaModel: ORISLOP_OLLAMA_MODEL,
  inferenceMode: "local",
  performanceMode: "heavy",
  cloudApiUrl: "https://api.orislop.com",
  watchIntentComplete: true,
  slopPreferences: [...DEFAULT_SLOP_PREFERENCES]
};
const CLOUD_BETA_CONFIGURED = Boolean(
  globalThis.OrislopOAuthConfig?.googleClientId
  && !String(globalThis.OrislopOAuthConfig.googleClientId).startsWith("__")
);
const storage = createStorageAdapter();
let runtimeHealth = null;
let cloudAccount = { signedIn: false };
let currentSettings = { ...DEFAULT_SETTINGS };
let currentView = "home";
let pendingClear = "";
let renderTimer = 0;
let toastTimer = 0;
let preferenceSaveTimer = 0;

initializePreferenceControls();
initializeNavigation();
initializeActions();
void boot();

async function boot() {
  try {
    await render();
    finishLoading();
    if (storage.isExtensionStorage && chrome.runtime?.sendMessage) {
      await refreshCloudAccount(true);
      void requestPageScan(true);
      await refreshRuntimeHealth(true);
    }
  } catch (error) {
    console.warn("Orislop popup could not restore its state", error);
    finishLoading();
    renderFallbackState();
  }
}

function finishLoading() {
  document.body.classList.remove("is-loading");
  document.getElementById("appShell").setAttribute("aria-busy", "false");
}

async function render() {
  const [flagged, skipped, settings, ollamaStored, detectorStored, factCheckStored, scanStored] = await Promise.all([
    readList(FLAGGED_KEY),
    readList(SKIPPED_KEY),
    readSettings(),
    storage.get(OLLAMA_STATUS_KEY),
    storage.get(DETECTOR_STATUS_KEY),
    storage.get(FACT_CHECK_STATUS_KEY),
    storage.get(SCAN_STATUS_KEY)
  ]);
  void flagged;
  currentSettings = settings;
  const ollama = runtimeHealth?.ollama || ollamaStored[OLLAMA_STATUS_KEY] || null;
  const detector = runtimeHealth?.detector || detectorStored[DETECTOR_STATUS_KEY] || null;
  const factChecker = runtimeHealth?.factChecker || detector?.factChecker || factCheckStored[FACT_CHECK_STATUS_KEY] || null;
  const scanStatus = scanStored[SCAN_STATUS_KEY] || null;

  renderPrimaryState(settings, ollama, detector, scanStatus);
  renderOutcome(skipped);
  renderActivity(skipped);
  renderPreferences(settings);
  renderAdvanced(settings, ollama, detector, factChecker);
}

function renderPrimaryState(settings, ollama, detector, scanStatus) {
  const stage = document.getElementById("filteringStage");
  const kicker = document.getElementById("overallStatus");
  const title = document.getElementById("protectionTitle");
  const detail = document.getElementById("protectionDetail");
  const notice = document.getElementById("homeNotice");
  const selectedCount = SLOP_PREFERENCE_API?.normalize(settings.slopPreferences).length || 0;
  const ollamaKnownUnavailable = ollama && !["available", "degraded", "bypassed_hard_ai"].includes(ollama.state) && ollama.installed !== true;
  const detectorKnownUnavailable = detector && detector.available !== true && !["available", "idle", "provisional", "pending", "heavyweight_loading", "heavyweight_analyzing"].includes(detector.state);
  const scanError = scanStatus?.state === "error";

  setToggle("protectionToggle", settings.enabled);
  if (!settings.enabled) {
    stage.dataset.state = "paused";
    kicker.textContent = "Paused";
    title.textContent = "Filtering paused";
    detail.textContent = "Your feed is unchanged.";
    notice.hidden = true;
    return;
  }
  if (selectedCount === 0) {
    stage.dataset.state = "limited";
    kicker.textContent = "On";
    title.textContent = "No filters selected";
    detail.textContent = "Choose what Orislop should remove.";
    notice.hidden = false;
    notice.textContent = "Choose filtering preferences →";
    return;
  }

  stage.dataset.state = ollamaKnownUnavailable && detectorKnownUnavailable ? "limited" : "active";
  kicker.textContent = "On";
  title.textContent = "Your feed is protected";
  detail.textContent = "Orislop is working quietly.";
  if (ollamaKnownUnavailable && detectorKnownUnavailable) {
    notice.hidden = false;
    notice.textContent = "Orislop needs attention. Open Help →";
  } else if (scanError) {
    notice.hidden = false;
    notice.textContent = "This page could not be checked. Try again →";
  } else {
    notice.hidden = true;
  }
}

function renderFallbackState() {
  const stage = document.getElementById("filteringStage");
  stage.dataset.state = "limited";
  document.getElementById("overallStatus").textContent = "Unavailable";
  document.getElementById("protectionTitle").textContent = "Couldn’t load settings";
  document.getElementById("protectionDetail").textContent = "Close Orislop and try again.";
}

function renderOutcome(records) {
  const unique = uniqueActivityRecords(records);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = unique.filter((record) => {
    const timestamp = Date.parse(record?.createdAt || "");
    return Number.isFinite(timestamp) && timestamp >= startOfToday.getTime();
  });
  document.getElementById("todayCount").textContent = compactNumber(today.length);
  document.getElementById("todayLabel").textContent = today.length === 1 ? "distraction removed today" : "distractions removed today";
  document.getElementById("lifetimeRemovedCount").textContent = compactNumber(unique.length);
  document.getElementById("minutesSaved").textContent = formatSavedTime(calculateSavedSeconds(records));
}

function renderActivity(records) {
  const host = document.getElementById("skippedList");
  host.replaceChildren();
  const unique = uniqueActivityRecords(records).slice(0, 20);
  if (unique.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "Nothing filtered yet.";
    const detail = document.createElement("span");
    detail.textContent = "Activity will appear here as Orislop cleans your feed.";
    empty.append(title, detail);
    host.append(empty);
    return;
  }

  for (const record of unique) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const mark = document.createElement("i");
    mark.className = "activity-mark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "activity-copy";
    const title = document.createElement("strong");
    title.textContent = record.title || "Feed item";
    title.title = title.textContent;
    const detail = document.createElement("small");
    detail.textContent = `${capitalize(record.platform || "feed")} · ${formatRelativeTime(record.createdAt)} · ${activityReason(record)}`;
    copy.append(title, detail);
    item.append(mark, copy);
    const safeUrl = trustedHttpsUrl(record.url);
    if (safeUrl) {
      const link = document.createElement("a");
      link.className = "activity-open";
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open";
      link.setAttribute("aria-label", `Open ${record.title || "filtered item"}`);
      item.append(link);
    }
    host.append(item);
  }
}

function activityReason(record) {
  const raw = [
    ...(Array.isArray(record?.reasons) ? record.reasons : []),
    record?.detectorDecision?.reason,
    record?.ollamaDecision?.reason
  ].filter(Boolean).join(" ").toLowerCase();
  if (record?.hardEngagementBait === true || /subscriber solicitation|engagement bait|subscribe|like begging|follow for/.test(raw)) {
    return "Asked for likes or subscribers";
  }
  if (record?.hardFinanceSlop === true || /dropshipping|get-rich|finance funnel|passive income|money fast/.test(raw)) {
    return "Get-rich-quick pitch";
  }
  if (record?.hardAiSynthetic === true || /ai.generated|synthetic|deepfake|ai video|ai voice|cloned voice/.test(raw)) {
    return "Looked AI-generated";
  }
  if (record?.hardMovieSceneRepost === true || /repost|recycled|stolen|low originality|movie.*scene|clip dump/.test(raw)) {
    return "Reused or low-originality";
  }
  if (/reddit|text.story|story farm/.test(raw)) return "Recycled story format";
  if (record?.hardFactContradiction === true || /misleading|contradict|unsupported claim|exaggerat/.test(raw)) {
    return "Possibly misleading";
  }
  if (["unavailable", "error"].includes(record?.detectorStatus)
    || /failed|unavailable|no direct media|could not|timed out|not enough evidence/.test(raw)) {
    return "Could not verify the video";
  }
  return "Matched your filters";
}

function uniqueActivityRecords(records) {
  const unique = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = String(record?.itemKey || record?.itemId || record?.id || "");
    if (!key || unique.has(key)) continue;
    unique.set(key, record);
  }
  return [...unique.values()].sort((left, right) => Date.parse(right?.createdAt || "") - Date.parse(left?.createdAt || ""));
}

function initializePreferenceControls() {
  if (!SLOP_PREFERENCE_API) return;
  const groupHost = document.getElementById("filterGroupList");
  const detailHost = document.getElementById("slopPreferenceGrid");
  const definitionsByCategory = new Map();
  for (const option of SLOP_PREFERENCE_API.definitions) {
    if (!definitionsByCategory.has(option.category)) definitionsByCategory.set(option.category, []);
    definitionsByCategory.get(option.category).push(option);
  }

  for (const category of SLOP_PREFERENCE_API.categories) {
    const options = definitionsByCategory.get(category.id) || [];
    groupHost.append(createFilterGroup(category, options));
    const section = document.createElement("section");
    section.className = "slop-category";
    section.dataset.category = category.id;
    const heading = document.createElement("div");
    heading.className = "slop-category-heading";
    const title = document.createElement("strong");
    title.textContent = category.label;
    const detail = document.createElement("small");
    detail.textContent = category.detail;
    heading.append(title, detail);
    section.append(heading);
    for (const option of options) section.append(createPreferenceChoice(option));
    detailHost.append(section);
  }

  detailHost.addEventListener("change", () => {
    syncGroupToggles(readCheckedPreferences());
    schedulePreferenceSave();
  });
}

function createFilterGroup(category, options) {
  const label = document.createElement("label");
  label.className = "group-row";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = category.label;
  const detail = document.createElement("small");
  detail.textContent = category.detail;
  copy.append(title, detail);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.category = category.id;
  input.dataset.optionIds = options.map(({ id }) => id).join(",");
  input.setAttribute("aria-label", `Filter ${category.label}`);
  const toggle = document.createElement("i");
  toggle.className = "row-switch";
  toggle.setAttribute("aria-hidden", "true");
  input.addEventListener("change", () => {
    const optionIds = input.dataset.optionIds.split(",").filter(Boolean);
    const selected = new Set(readCheckedPreferences());
    for (const id of optionIds) {
      if (input.checked) selected.add(id);
      else selected.delete(id);
    }
    writeCheckedPreferences([...selected]);
    syncGroupToggles([...selected]);
    schedulePreferenceSave();
  });
  label.append(copy, input, toggle);
  return label;
}

function createPreferenceChoice(option) {
  const label = document.createElement("label");
  label.className = "slop-choice";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = option.label;
  const detail = document.createElement("small");
  detail.textContent = option.detail;
  copy.append(title, detail);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = option.id;
  input.dataset.category = option.category;
  input.setAttribute("aria-label", option.label);
  const toggle = document.createElement("i");
  toggle.className = "row-switch";
  toggle.setAttribute("aria-hidden", "true");
  label.append(copy, input, toggle);
  return label;
}

function renderPreferences(settings) {
  setToggle("hideSkippedToggle", settings.hideSkipped);
  writeCheckedPreferences(settings.slopPreferences);
  syncGroupToggles(settings.slopPreferences);
  renderPreferenceCount(settings.slopPreferences);
}

function readCheckedPreferences() {
  return Array.from(document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]:checked'), (input) => input.value);
}

function writeCheckedPreferences(ids) {
  const selected = new Set(SLOP_PREFERENCE_API?.normalize(ids) || []);
  for (const input of document.querySelectorAll('#slopPreferenceGrid input[type="checkbox"]')) input.checked = selected.has(input.value);
}

function syncGroupToggles(ids) {
  const selected = new Set(SLOP_PREFERENCE_API?.normalize(ids) || []);
  for (const input of document.querySelectorAll('#filterGroupList input[type="checkbox"]')) {
    const optionIds = input.dataset.optionIds.split(",").filter(Boolean);
    const count = optionIds.filter((id) => selected.has(id)).length;
    input.checked = optionIds.length > 0 && count === optionIds.length;
    input.indeterminate = count > 0 && count < optionIds.length;
    input.setAttribute("aria-checked", input.indeterminate ? "mixed" : String(input.checked));
  }
}

function renderPreferenceCount(ids) {
  const selected = SLOP_PREFERENCE_API?.normalize(ids) || [];
  const total = SLOP_PREFERENCE_API?.definitions.length || 0;
  const text = selected.length === 0 ? "No content types selected"
    : selected.length === total ? "All filtering categories are on"
      : `${selected.length} of ${total} content types are on`;
  document.getElementById("preferenceCount").textContent = text;
}

function schedulePreferenceSave() {
  window.clearTimeout(preferenceSaveTimer);
  renderPreferenceCount(readCheckedPreferences());
  preferenceSaveTimer = window.setTimeout(() => void savePreferenceSelection(), 220);
}

async function savePreferenceSelection() {
  const slopPreferences = readCheckedPreferences();
  const settings = await readSettings();
  await saveSettings({ ...settings, watchIntentComplete: true, slopPreferences });
  currentSettings = { ...settings, watchIntentComplete: true, slopPreferences };
  setStatus("Preferences saved.");
  void requestPageScan(true);
  await render();
}

function renderAdvanced(settings, ollama, detector, factChecker) {
  document.getElementById("ollamaModel").value = settings.ollamaModel;
  const inferenceMode = document.getElementById("inferenceMode");
  const hybridOption = inferenceMode.querySelector('option[value="hybrid"]');
  if (hybridOption) hybridOption.disabled = !CLOUD_BETA_CONFIGURED;
  inferenceMode.title = CLOUD_BETA_CONFIGURED ? "" : "Cloud filtering is not configured in this build.";
  inferenceMode.value = settings.inferenceMode;
  document.getElementById("performanceMode").value = "heavy";
  document.getElementById("performanceMode").disabled = true;
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
      ? `${minute} left this minute · ${day} today`
      : "Cloud analysis is ready";
  }
  document.getElementById("inferenceLocation").textContent = settings.inferenceMode === "hybrid" ? "Local first · cloud when needed" : "Local filtering";
  renderPerformanceNote(settings);
  renderOllamaStatus(ollama);
  renderDetectorStatus(detector);
  renderFactCheckStatus(factChecker);
}

function renderPerformanceNote() {
  const host = document.getElementById("performanceNote");
  host.textContent = "Every eligible media item uses the full GPU detector stack.";
}

function renderOllamaStatus(status) {
  const host = document.getElementById("ollamaStatus");
  const state = status?.state || "checking";
  host.dataset.state = ["available", "degraded", "bypassed_hard_ai"].includes(state) || status?.installed === true ? "ready" : state === "checking" ? "checking" : "limited";
  host.textContent = host.dataset.state === "ready" ? "Ready" : host.dataset.state === "checking" ? "Checking…" : state === "model_missing" ? "Needs setup" : "Unavailable";
}

function renderDetectorStatus(status) {
  const host = document.getElementById("detectorStatus");
  const state = status?.state || "checking";
  const ready = status?.available === true || ["available", "idle", "provisional", "pending", "heavyweight_loading", "heavyweight_analyzing"].includes(state);
  host.dataset.state = ready ? "ready" : state === "checking" ? "checking" : "limited";
  host.textContent = ready ? (state.includes("loading") ? "Warming up" : "Ready") : state === "checking" ? "Checking…" : "Unavailable";
}

function renderFactCheckStatus(status) {
  const host = document.getElementById("factCheckStatus");
  const state = status?.state || "checking";
  const ready = status?.configured === true && !["unavailable", "error", "unconfigured"].includes(state);
  host.dataset.state = ready ? "ready" : state === "checking" ? "checking" : "limited";
  host.textContent = ready ? "Ready" : state === "checking" ? "Checking…" : "Optional";
}

function initializeNavigation() {
  document.getElementById("activityButton").addEventListener("click", () => showView("activity"));
  document.getElementById("openPreferencesButton").addEventListener("click", () => showView("preferences"));
  document.getElementById("activityBackButton").addEventListener("click", () => showView("home"));
  document.getElementById("preferencesBackButton").addEventListener("click", () => showView("home"));
  document.getElementById("homeNotice").addEventListener("click", () => {
    showView("preferences");
    document.getElementById("advancedSettingsPanel").open = true;
  });
}

function showView(name, focus = true) {
  currentView = ["home", "activity", "preferences"].includes(name) ? name : "home";
  for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== currentView;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  if (!focus) return;
  const target = currentView === "home" ? document.getElementById("openPreferencesButton")
    : currentView === "activity" ? document.getElementById("activityBackButton")
      : document.getElementById("preferencesBackButton");
  target?.focus({ preventScroll: true });
}

function initializeActions() {
  document.getElementById("protectionToggle").addEventListener("change", async (event) => {
    const settings = await readSettings();
    await saveSettings({ ...settings, enabled: event.target.checked });
    setStatus(event.target.checked ? "Filtering resumed." : "Filtering paused.");
    await render();
    if (event.target.checked) void requestPageScan(true);
  });

  document.getElementById("hideSkippedToggle").addEventListener("change", async (event) => {
    const settings = await readSettings();
    await saveSettings({ ...settings, hideSkipped: event.target.checked, watchIntentComplete: true });
    setStatus(event.target.checked ? "Filtered items will be hidden." : "Filtered items will stay covered.");
    await render();
  });

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
      setStatus("Cloud filtering is not configured in this build.");
      return;
    }
    const inferenceMode = event.target.value === "hybrid" ? "hybrid" : "local";
    await saveSettings({ ...settings, inferenceMode });
    runtimeHealth = null;
    setStatus(inferenceMode === "hybrid" ? "Hybrid filtering selected." : "Local filtering selected.");
    await render();
    await refreshRuntimeHealth(true);
  });

  document.getElementById("performanceMode").addEventListener("change", async (event) => {
    const settings = await readSettings();
    const performanceMode = ["fast", "heavy"].includes(event.target.value) ? event.target.value : "auto";
    await saveSettings({ ...settings, performanceMode });
    runtimeHealth = null;
    setStatus(`${capitalize(performanceMode)} performance selected.`);
    await refreshRuntimeHealth(true);
  });

  document.getElementById("cloudApiUrl").addEventListener("change", saveCloudSettings);
  document.getElementById("cloudSignInButton").addEventListener("click", signInToCloud);
  document.getElementById("cloudSignOutButton").addEventListener("click", signOutOfCloud);
  document.getElementById("cloudDeleteAccountButton").addEventListener("click", deleteCloudAccount);
  document.getElementById("testOllamaButton").addEventListener("click", testOllama);
  document.getElementById("testDetectorButton").addEventListener("click", testDetector);
  document.getElementById("testFactCheckerButton").addEventListener("click", testFactChecker);
  document.getElementById("scanNowButton").addEventListener("click", () => requestPageScan(false));
  document.getElementById("copyDiagnosticsButton").addEventListener("click", copyDiagnostics);
  document.getElementById("clearSkippedButton").addEventListener("click", () => requestClear("skipped"));
  document.getElementById("clearAllDataButton").addEventListener("click", () => requestClear("all"));
  document.getElementById("cancelClearButton").addEventListener("click", closeClear);
  document.getElementById("confirmClearButton").addEventListener("click", confirmClear);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (pendingClear) {
      closeClear();
      return;
    }
    if (currentView !== "home") showView("home");
  });
}

async function refreshRuntimeHealth(quiet = false) {
  const settings = await readSettings();
  if (!quiet) setStatus("Checking Orislop…");
  const response = await sendMessage({ type: "orislop.runtimeHealth", model: settings.ollamaModel });
  if (response?.ollama && response?.detector) {
    runtimeHealth = response;
    await storage.set({
      [OLLAMA_STATUS_KEY]: { ...response.ollama, checkedAt: response.checkedAt },
      [DETECTOR_STATUS_KEY]: { ...response.detector, checkedAt: response.checkedAt },
      [FACT_CHECK_STATUS_KEY]: { ...response.factChecker, checkedAt: response.checkedAt }
    });
  } else if (!quiet) {
    console.warn("Orislop runtime health check failed", response?.error || response);
    setStatus("Engine status is temporarily unavailable.");
  }
  await render();
}

async function requestPageScan(quiet = false) {
  if (!storage.isExtensionStorage || !globalThis.chrome?.tabs?.query || !globalThis.chrome?.tabs?.sendMessage) {
    if (!quiet) setStatus("Open a supported feed, then try again.");
    return;
  }
  if (!quiet) setStatus("Checking this page…");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!Number.isInteger(tabId)) {
    if (!quiet) setStatus("No supported feed is open.");
    return;
  }
  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "orislop.scanNow" }, (value) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : value);
    });
  });
  if (!quiet) setStatus(response?.ok ? "Page check started." : "This page is not supported yet.");
  window.setTimeout(() => void render(), 450);
}

async function saveCloudSettings() {
  const settings = await readSettings();
  await saveSettings({ ...settings, cloudApiUrl: readCloudApiUrl() });
  runtimeHealth = null;
  setStatus("Cloud service saved.");
  await refreshRuntimeHealth(true);
}

async function signInToCloud() {
  setStatus("Opening Google sign-in…");
  const response = await sendMessage({ type: "orislop.cloudSignIn" });
  if (response?.ok) {
    cloudAccount = response;
    setStatus("Cloud analysis enabled.");
    await refreshCloudAccount(true);
    runtimeHealth = null;
    await refreshRuntimeHealth(true);
  } else {
    console.warn("Orislop cloud sign-in failed", response?.error || response);
    setStatus("Google sign-in could not be completed.");
    await render();
  }
}

async function signOutOfCloud() {
  const response = await sendMessage({ type: "orislop.cloudSignOut" });
  if (response?.ok) cloudAccount = { signedIn: false };
  else console.warn("Orislop cloud sign-out failed", response?.error || response);
  setStatus(response?.ok ? "Signed out. Local filtering stays on." : "Sign-out could not be completed.");
  await render();
}

async function deleteCloudAccount() {
  if (!window.confirm("Delete your Orislop beta account and revoke every session?")) return;
  const response = await sendMessage({ type: "orislop.cloudDeleteAccount" });
  if (response?.ok && response?.deleted === true) cloudAccount = { signedIn: false };
  else console.warn("Orislop cloud account deletion failed", response?.error || response);
  setStatus(response?.ok ? "Account deleted." : "Account deletion could not be completed.");
  await render();
}

async function refreshCloudAccount(quiet = false) {
  const response = await sendMessage({ type: "orislop.cloudAccount" });
  cloudAccount = response?.signedIn ? response : { signedIn: false, error: response?.error || "" };
  if (!quiet && !response?.signedIn) setStatus("Sign in to use cloud analysis.");
  return cloudAccount;
}

async function testOllama() {
  setStatus("Testing context…");
  const response = await sendMessage({ type: "orislop.testOllama", model: readModelInput() });
  await storage.set({
    [OLLAMA_STATUS_KEY]: response?.ok
      ? { state: "available", model: response.model || readModelInput(), installed: true, error: "", checkedAt: Date.now() }
      : { state: "unavailable", model: readModelInput(), installed: false, error: response?.error || response?.message || "Context test failed.", checkedAt: Date.now() }
  });
  runtimeHealth = null;
  if (!response?.ok) console.warn("Orislop context test failed", response?.error || response);
  setStatus(response?.ok ? "Context is ready." : "Context is unavailable.");
  await render();
}

async function testDetector() {
  setStatus("Testing media checks…");
  const response = await sendMessage({ type: "orislop.testDetector" });
  await storage.set({
    [DETECTOR_STATUS_KEY]: response?.ok
      ? { state: response.state || "available", available: true, version: response.version, modelStates: response.modelStates, queueDepth: response.queueDepth, error: "", checkedAt: Date.now() }
      : { state: "unavailable", available: false, error: response?.error || response?.message || "Media test failed.", checkedAt: Date.now() }
  });
  runtimeHealth = null;
  if (!response?.ok) console.warn("Orislop media test failed", response?.error || response);
  setStatus(response?.ok ? "Media checks are ready." : "Media checks are unavailable.");
  await render();
}

async function testFactChecker() {
  setStatus("Testing evidence…");
  const response = await sendMessage({ type: "orislop.testFactChecker" });
  await storage.set({
    [FACT_CHECK_STATUS_KEY]: response?.ok
      ? { state: response.state || "idle", configured: true, providers: response.providers || {}, queueDepth: response.queueDepth, error: "", checkedAt: Date.now() }
      : { state: response?.state || "unconfigured", configured: false, providers: response?.providers || {}, error: response?.error || response?.message || "Evidence setup is incomplete.", checkedAt: Date.now() }
  });
  runtimeHealth = null;
  if (!response?.ok) console.warn("Orislop evidence test failed", response?.error || response);
  setStatus(response?.ok ? "Evidence checks are ready." : "Evidence checks are optional and unavailable.");
  await render();
}

async function copyDiagnostics() {
  const settings = await readSettings();
  const values = await storage.get([OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY, FACT_CHECK_STATUS_KEY, SCAN_STATUS_KEY]);
  const report = {
    product: "Orislop",
    version: "1.4.0",
    generatedAt: new Date().toISOString(),
    filteringEnabled: settings.enabled,
    hideFiltered: settings.hideSkipped,
    inferenceMode: settings.inferenceMode,
    performanceMode: settings.performanceMode,
    preferenceCount: settings.slopPreferences.length,
    performance: runtimeHealth?.performance || null,
    cloudApiUrl: settings.inferenceMode !== "local" ? settings.cloudApiUrl : null,
    ollamaModel: settings.ollamaModel,
    context: values[OLLAMA_STATUS_KEY] || null,
    detector: values[DETECTOR_STATUS_KEY] || null,
    evidence: values[FACT_CHECK_STATUS_KEY] || null,
    scanner: values[SCAN_STATUS_KEY] || null
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setStatus("Diagnostics copied. Activity titles and URLs were not included.");
  } catch {
    setStatus("Clipboard access was blocked. Reopen Orislop and try again.");
  }
}

function requestClear(action) {
  pendingClear = action;
  document.getElementById("clearConfirmationText").textContent = action === "all" ? "Clear local data?" : "Clear activity?";
  document.getElementById("clearConfirmation").hidden = false;
  document.getElementById("confirmClearButton").focus();
}

function closeClear() {
  pendingClear = "";
  document.getElementById("clearConfirmation").hidden = true;
}

async function confirmClear() {
  const action = pendingClear;
  if (!action) return;
  await storage.remove(action === "all"
    ? [FLAGGED_KEY, SKIPPED_KEY, SETTINGS_KEY, OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY, FACT_CHECK_STATUS_KEY, SCAN_STATUS_KEY]
    : [SKIPPED_KEY]);
  runtimeHealth = null;
  closeClear();
  setStatus(action === "all" ? "Local data cleared." : "Activity cleared.");
  await render();
  if (action === "all") showFirstRun();
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
  return record && typeof record === "object" ? 20 : 0;
}

function formatSavedTime(secondsInput) {
  const seconds = Math.max(0, Math.round(Number(secondsInput) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

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
    ollamaModel: normalizeModelName(value.ollamaModel),
    inferenceMode: CLOUD_BETA_CONFIGURED && value.inferenceMode === "hybrid" ? "hybrid" : "local",
    performanceMode: "heavy",
    cloudApiUrl: sanitizeCloudApiUrl(value.cloudApiUrl),
    watchIntentComplete: true,
    slopPreferences: SLOP_PREFERENCE_API?.normalize(value.slopPreferences) || [...DEFAULT_SLOP_PREFERENCES]
  };
}

async function saveSettings(settings) {
  await storage.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

function setToggle(id, checked) {
  const element = document.getElementById(id);
  element.checked = checked;
  element.setAttribute("aria-checked", String(checked));
}

function sendMessage(message) {
  if (!storage.isExtensionStorage || !globalThis.chrome?.runtime?.sendMessage) return Promise.resolve({ ok: false, error: "Extension messaging is unavailable." });
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response));
  });
}

function readModelInput() {
  return normalizeModelName(document.getElementById("ollamaModel").value.trim());
}

function normalizeModelName(value) {
  const model = String(value || "").trim();
  if (!model || model === LEGACY_OLLAMA_MODEL) return ORISLOP_OLLAMA_MODEL;
  return /^[a-zA-Z0-9._:/-]{1,100}$/.test(model) ? model : DEFAULT_SETTINGS.ollamaModel;
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

function trustedHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function setStatus(message) {
  const host = document.getElementById("popupStatus");
  window.clearTimeout(toastTimer);
  host.textContent = message;
  host.classList.toggle("is-visible", Boolean(message));
  if (message) toastTimer = window.setTimeout(() => host.classList.remove("is-visible"), 2600);
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
