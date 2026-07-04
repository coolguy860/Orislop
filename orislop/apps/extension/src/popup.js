const FLAGGED_KEY = "orislop.extension.flaggedLog";
const SKIPPED_KEY = "orislop.extension.skippedLog";
const SETTINGS_KEY = "orislop.extension.settings";
const DEFAULT_SETTINGS = {
  autoSkip: true,
  hideFeedCards: true
};

async function readList(key) {
  const result = await chrome.storage.local.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function readSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const value = result[SETTINGS_KEY];
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    autoSkip: typeof value.autoSkip === "boolean" ? value.autoSkip : DEFAULT_SETTINGS.autoSkip,
    hideFeedCards: typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideFeedCards
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function render() {
  const [flaggedRecords, skippedRecords, settings] = await Promise.all([
    readList(FLAGGED_KEY),
    readList(SKIPPED_KEY),
    readSettings()
  ]);

  document.getElementById("flaggedCount").textContent = String(flaggedRecords.length);
  document.getElementById("skippedCount").textContent = String(skippedRecords.length);
  document.getElementById("autoSkipToggle").checked = settings.autoSkip;
  document.getElementById("hideFeedCardsToggle").checked = settings.hideFeedCards;
  renderSkippedList(skippedRecords);
}

function renderSkippedList(records) {
  const host = document.getElementById("skippedList");
  host.innerHTML = "";
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No skipped videos yet.";
    host.append(empty);
    return;
  }

  for (const record of records.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "skipped-item";
    const title = document.createElement("strong");
    title.textContent = record.title || "YouTube video";
    const detail = document.createElement("span");
    detail.textContent = `${record.mode || "skipped"} - ${record.score}/100`;
    item.append(title, detail);
    host.append(item);
  }
}

document.getElementById("clearLogButton").addEventListener("click", async () => {
  await chrome.storage.local.set({ [FLAGGED_KEY]: [] });
  await render();
});

document.getElementById("clearSkippedButton").addEventListener("click", async () => {
  await chrome.storage.local.set({ [SKIPPED_KEY]: [] });
  await render();
});

document.getElementById("autoSkipToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, autoSkip: event.target.checked });
  await render();
});

document.getElementById("hideFeedCardsToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, hideFeedCards: event.target.checked });
  await render();
});

void render();
