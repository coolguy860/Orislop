import type {
  CalibrationUserLabel,
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import type { CalibrationRecord } from "../../../packages/storage/src/types.ts";
import type { UserFeedbackAction } from "../../../packages/storage/src/types.ts";
import { renderCalibrationPanel } from "./components/CalibrationPanel.tsx";
import { renderFlaggedOnScrollBackBanner } from "./components/FlaggedOnScrollBackBanner.tsx";
import { renderMockShortPanel } from "./components/MockShortPanel.tsx";
import { renderOrislopOverlay } from "./components/OrislopOverlay.tsx";
import { renderSettingsPanel } from "./components/SettingsPanel.tsx";
import {
  renderExtractedShortDebug,
  renderLookaheadDebug,
  renderShortsWebView
} from "./components/ShortsWebView.tsx";
import { renderSkippedBanner } from "./components/SkippedBanner.tsx";
import type { MockShortFixture } from "./mockFixtures.ts";
import type {
  ScoredLookaheadCandidate,
  ScoreLookaheadPayload
} from "./youtube/lookaheadTypes.ts";
import {
  applyScrollAttemptResult,
  createSkipSessionState,
  decideSkipForCurrent,
  rememberLookaheadPreSkips,
  rememberWatchAnyway,
  type FlaggedOnScrollBackBannerView,
  type SkippedBannerView
} from "./youtube/skipController.ts";
import {
  createScrollController,
  type SafeScrollTarget
} from "./youtube/scrollController.ts";
import {
  attachShortsWebViewNavigationObserver
} from "./youtube/youtubeNavigationObserver.ts";
import {
  getYouTubeLookaheadScannerScript,
  getYouTubeRecommendationFilterScript
} from "./youtube/youtubeLookaheadScanner.ts";
import {
  getYouTubeClearCurrentVideoShieldScript,
  getYouTubeCurrentVideoShieldScript
} from "./youtube/youtubeCurrentVideoShield.ts";
import {
  getYouTubeShortsExtractorScript
} from "./youtube/youtubeShortsExtractor.ts";
import {
  parseYouTubeShortsUrl,
  YOUTUBE_SHORTS_HOME_URL
} from "./youtube/youtubeUrl.ts";

type ScoreShortResponse = {
  result: OrislopScoreResult;
  cacheHit: boolean;
};

type ScorePayload = {
  fixtureId?: string;
  short?: ExtractedShort;
};

type OrislopApi = {
  listFixtures: () => Promise<MockShortFixture[]>;
  scoreShort: (payload: ScorePayload) => Promise<ScoreShortResponse>;
  scoreExtractedShort: (short: ExtractedShort) => Promise<ScoreShortResponse>;
  getSettings: () => Promise<OrislopSettings>;
  updateSettings: (payload: Partial<OrislopSettings>) => Promise<OrislopSettings>;
  resetSettings: () => Promise<OrislopSettings>;
  saveFeedback: (payload: {
    fixtureId?: string;
    short?: ExtractedShort;
    scoreResult: OrislopScoreResult;
    userFeedback: UserFeedbackAction;
  }) => Promise<unknown>;
  saveCalibrationLabel: (payload: {
    fixtureId?: string;
    short?: ExtractedShort;
    scoreResult: OrislopScoreResult;
    userLabel: CalibrationUserLabel;
    userFeedback?: UserFeedbackAction | null;
  }) => Promise<{ record: CalibrationRecord; totalLabels: number }>;
  listCalibrationLabels: () => Promise<CalibrationRecord[]>;
  exportCalibrationLabels: () => Promise<CalibrationRecord[]>;
  importCalibrationLabels: (payload: unknown[]) => Promise<unknown>;
  getCachedScore: (payload: ScorePayload) => Promise<OrislopScoreResult | null>;
  getCachedExtractedShort: (short: ExtractedShort) => Promise<OrislopScoreResult | null>;
  scoreLookaheadCandidates: (payload: ScoreLookaheadPayload) => Promise<ScoredLookaheadCandidate[]>;
  clearCache: () => Promise<unknown>;
  forceRescan: (payload: ScorePayload) => Promise<ScoreShortResponse>;
  forceRescanExtractedShort: (short: ExtractedShort) => Promise<ScoreShortResponse>;
  getSkipHistory: () => Promise<unknown[]>;
  markScrolledBack: (payload: ScorePayload) => Promise<unknown>;
  markWatchedAnyway: (payload: ScorePayload) => Promise<unknown>;
};

declare global {
  interface Window {
    orislop: OrislopApi;
  }
}

type AppMode = "mock" | "youtube";

type AppState = {
  mode: AppMode;
  fixtures: MockShortFixture[];
  selectedFixtureId: string | null;
  settings: OrislopSettings | null;
  scoreResponse: ScoreShortResponse | null;
  skipBanner: SkippedBannerView | null;
  flaggedBanner: FlaggedOnScrollBackBannerView | null;
  bannerDismissed: boolean;
  status: string;
  skipHistoryCount: number;
  calibrationLabelCount: number;
  shortsUrl: string;
  extractedShort: ExtractedShort | null;
  lookaheadResults: ScoredLookaheadCandidate[];
};

type WebViewLoadEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
  validatedURL?: string;
};

const state: AppState = {
  mode: "mock",
  fixtures: [],
  selectedFixtureId: null,
  settings: null,
  scoreResponse: null,
  skipBanner: null,
  flaggedBanner: null,
  bannerDismissed: false,
  status: "Loading mock fixtures.",
  skipHistoryCount: 0,
  calibrationLabelCount: 0,
  shortsUrl: YOUTUBE_SHORTS_HOME_URL,
  extractedShort: null,
  lookaheadResults: []
};

let detachShortsObserver: (() => void) | null = null;
const skipSession = createSkipSessionState();
const scrollController = createScrollController();
const root = document.getElementById("app");

bootstrap().catch((error: unknown) => {
  state.status = error instanceof Error ? error.message : "Unable to start Orislop Browser.";
  render();
});

async function bootstrap(): Promise<void> {
  state.fixtures = await window.orislop.listFixtures();
  state.selectedFixtureId = state.fixtures[0]?.id ?? null;
  state.settings = await window.orislop.getSettings();
  state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
  state.calibrationLabelCount = (await window.orislop.listCalibrationLabels()).length;
  state.status = "Ready.";
  render();
}

function render(): void {
  if (!root) {
    return;
  }

  const fixture = selectedFixture();
  const result = state.scoreResponse?.result ?? null;

  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div>
          <h1>Orislop Browser</h1>
          <p>${state.mode === "mock" ? "Mock fixture mode" : "YouTube mode"}</p>
        </div>
        <span class="app-status">${escapeHtml(state.status)}</span>
      </header>

      <div id="banner-region">
        ${renderBannerRegion(result)}
      </div>

      <section class="toolbar" aria-label="Fixture and Shorts controls">
        <button type="button" data-action="open-mock-mode" ${state.mode === "mock" ? "disabled" : ""}>Mock fixtures</button>
        <button type="button" data-action="open-youtube-mode" ${state.mode === "youtube" ? "disabled" : ""}>Open YouTube</button>
        ${state.mode === "mock" ? renderMockToolbar() : renderYouTubeToolbar()}
        <button type="button" data-action="clear-cache">Clear cache</button>
        <span class="history-count">Skip history: ${state.skipHistoryCount}</span>
      </section>

      <div class="content-grid ${state.mode === "youtube" ? "content-grid--youtube" : ""}">
        <div id="primary-region">
          ${state.mode === "mock"
            ? (fixture ? renderMockShortPanel(fixture) : "<section class=\"panel\">No fixtures found.</section>")
            : renderShortsWebView({
            shortsUrl: state.shortsUrl,
            extractedShort: state.extractedShort,
            webviewReady: true,
            lookaheadResults: state.lookaheadResults
          })}
        </div>
        <div id="score-region">${renderOrislopOverlay(result, Boolean(state.scoreResponse?.cacheHit))}</div>
        <div id="settings-region">${renderSettingsPanel(state.settings)}</div>
        <div id="calibration-region">${renderCalibrationPanel(result, state.settings, state.calibrationLabelCount)}</div>
      </div>
    </div>
  `;

  bindEvents();
}

function renderBannerRegion(result: OrislopScoreResult | null): string {
  return `
    ${renderSkippedBanner(state.skipBanner ?? result, state.bannerDismissed)}
    ${renderFlaggedOnScrollBackBanner(state.flaggedBanner)}
  `;
}

function renderPreservingYouTubeWebView(): void {
  if (state.mode === "youtube" && document.getElementById("shorts-webview")) {
    refreshDynamicRegions();
    return;
  }

  render();
}

function refreshDynamicRegions(): void {
  const result = state.scoreResponse?.result ?? null;
  setInlineStatus(state.status);
  setText(".history-count", `Skip history: ${state.skipHistoryCount}`);
  replaceRegion("banner-region", renderBannerRegion(result));
  replaceRegion("score-region", renderOrislopOverlay(result, Boolean(state.scoreResponse?.cacheHit)));
  replaceRegion("settings-region", renderSettingsPanel(state.settings));
  replaceRegion("calibration-region", renderCalibrationPanel(result, state.settings, state.calibrationLabelCount));
  replaceRegion("extract-debug-region", renderExtractedShortDebug(state.extractedShort));
  replaceRegion("lookahead-region", renderLookaheadDebug(state.lookaheadResults));
  syncShortsUrlInput();
  bindPanelEvents();
}

function replaceRegion(id: string, html: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = html;
  }
}

function setText(selector: string, text: string): void {
  const element = document.querySelector(selector);
  if (element) {
    element.textContent = text;
  }
}

function syncShortsUrlInput(): void {
  const input = document.getElementById("shorts-url-input") as HTMLInputElement | null;
  if (input && document.activeElement !== input) {
    input.value = state.shortsUrl;
  }
}

function renderMockToolbar(): string {
  return `
    <label>
      <span>Fixture</span>
      <select id="fixture-select">
        ${state.fixtures.map((item) => `
          <option value="${item.id}" ${item.id === state.selectedFixtureId ? "selected" : ""}>
            ${escapeHtml(item.label)}
          </option>
        `).join("")}
      </select>
    </label>
    <button type="button" data-action="score">Score fixture</button>
    <button type="button" data-action="force-rescan">Force rescan</button>
  `;
}

function renderYouTubeToolbar(): string {
  return `
    <span class="toolbar-note">Current Short extraction runs after navigation settles or by manual analyze.</span>
    <button type="button" data-action="force-rescan">Force rescan</button>
  `;
}

function bindEvents(): void {
  document.querySelector("[data-action='open-mock-mode']")?.addEventListener("click", () => {
    state.mode = "mock";
    state.scoreResponse = null;
    state.extractedShort = null;
    state.lookaheadResults = [];
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.bannerDismissed = false;
    state.status = "Mock fixture mode.";
    render();
  });

  document.querySelector("[data-action='open-youtube-mode']")?.addEventListener("click", () => {
    state.mode = "youtube";
    state.scoreResponse = null;
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.bannerDismissed = false;
    state.lookaheadResults = [];
    state.status = "YouTube mode.";
    render();
  });

  document.getElementById("fixture-select")?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    state.selectedFixtureId = target.value;
    state.scoreResponse = null;
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.bannerDismissed = false;
    state.status = "Fixture selected.";
    render();
  });

  document.querySelector("[data-action='score']")?.addEventListener("click", () => {
    void scoreSelected(false);
  });
  document.querySelector("[data-action='force-rescan']")?.addEventListener("click", () => {
    void scoreSelected(true);
  });
  document.querySelector("[data-action='clear-cache']")?.addEventListener("click", async () => {
    await window.orislop.clearCache();
    state.status = "Cache cleared.";
    renderPreservingYouTubeWebView();
  });
  document.querySelector("[data-action='open-shorts-url']")?.addEventListener("click", () => {
    openShortsUrl();
  });
  document.querySelector("[data-action='analyze-current-short']")?.addEventListener("click", () => {
    void analyzeCurrentShort(true);
  });

  bindPanelEvents();
  bindShortsObserver();
}

function bindPanelEvents(): void {
  document.querySelector("[data-action='reset-settings']")?.addEventListener("click", async () => {
    state.settings = await window.orislop.resetSettings();
    state.scoreResponse = null;
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.status = "Settings reset.";
    renderPreservingYouTubeWebView();
  });

  document.querySelectorAll("[data-setting]").forEach((element) => {
    element.addEventListener("change", (event) => {
      void updateSetting(event.target as HTMLInputElement | HTMLSelectElement);
    });
  });

  document.querySelectorAll("[data-feedback]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const target = event.target as HTMLButtonElement;
      void saveFeedback(target.dataset.feedback as UserFeedbackAction);
    });
  });

  document.querySelectorAll("[data-calibration-label]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const target = event.target as HTMLButtonElement;
      void saveCalibrationLabel(target.dataset.calibrationLabel as CalibrationUserLabel, defaultFeedbackForLabel(target.dataset.calibrationLabel as CalibrationUserLabel));
    });
  });

  document.querySelectorAll("[data-calibration-smart]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const target = event.target as HTMLButtonElement;
      const feedback = target.dataset.calibrationSmart as UserFeedbackAction;
      void saveCalibrationLabel(labelForFeedback(feedback), feedback);
    });
  });

  document.querySelector("[data-action='export-calibration-labels']")?.addEventListener("click", () => {
    void exportCalibrationLabels();
  });

  document.querySelector("[data-action='import-calibration-labels']")?.addEventListener("click", () => {
    void importCalibrationLabels();
  });
}

async function scoreSelected(forceRescan: boolean): Promise<void> {
  if (state.mode === "youtube") {
    await analyzeCurrentShort(forceRescan);
    return;
  }

  if (!state.selectedFixtureId) {
    return;
  }

  state.scoreResponse = forceRescan
    ? await window.orislop.forceRescan({ fixtureId: state.selectedFixtureId })
    : await window.orislop.scoreShort({ fixtureId: state.selectedFixtureId });
  state.lookaheadResults = [];
  state.skipBanner = null;
  state.flaggedBanner = null;
  state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
  state.bannerDismissed = false;
  state.status = state.scoreResponse.cacheHit ? "Loaded cached score." : "Scored fixture.";
  render();
}

async function analyzeCurrentShort(forceRescan: boolean): Promise<void> {
  if (state.mode !== "youtube") {
    return;
  }

  const previousLookaheadResults = state.lookaheadResults;
  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<ExtractedShort>;
    getURL?: () => string;
  } | null;

  try {
    if (state.settings?.observePlaybackBeforeScoring && webview?.executeJavaScript) {
      setInlineStatus("Watching the page briefly before analysis.");
      await sleep(1800);
    }

    const extracted = webview?.executeJavaScript
      ? await webview.executeJavaScript(getYouTubeShortsExtractorScript({
        includeCommunityReaction: state.settings?.useCommunityReactionSignal === true,
        maxVisibleCommentsToInspect: state.settings?.maxVisibleCommentsToInspect ?? 24,
        sampledAt: new Date().toISOString()
      }), true)
      : fallbackExtractedShort(webview?.getURL?.() ?? state.shortsUrl);

    state.extractedShort = extracted;
    state.shortsUrl = extracted.url;
    state.scoreResponse = forceRescan
      ? await window.orislop.forceRescanExtractedShort(extracted)
      : await window.orislop.scoreExtractedShort(extracted);
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.bannerDismissed = false;
    state.status = state.scoreResponse.cacheHit ? "Loaded cached extracted video." : "Analyzed current video.";
    rememberLookaheadPreSkips(skipSession, previousLookaheadResults);
    await applySkipControl(extracted, state.scoreResponse.result);
    state.lookaheadResults = await scanLookaheadCandidates();
    await applyRecommendationFiltering(state.lookaheadResults);
    rememberLookaheadPreSkips(skipSession, state.lookaheadResults);
    state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Unable to analyze current Short.";
  }

  renderPreservingYouTubeWebView();
}

async function applySkipControl(
  short: ExtractedShort,
  result: OrislopScoreResult
): Promise<void> {
  if (!state.settings) {
    return;
  }

  const decision = decideSkipForCurrent({
    short,
    result,
    settings: state.settings,
    session: skipSession
  });

  state.skipBanner = decision.skippedBanner;
  state.flaggedBanner = decision.flaggedBanner;

  if (decision.flaggedBanner) {
    await window.orislop.markScrolledBack({ short }).catch(() => undefined);
    state.status = "Returned to a flagged Short.";
    return;
  }

  if (short.videoKind === "watch") {
    if (decision.skippedBanner && state.settings.hideFlaggedCurrentVideo) {
      const shielded = await shieldCurrentYouTubeVideo(result.userFacingReason ?? "Orislop hid this video based on your settings.");
      state.status = shielded
        ? "Flagged and hid current YouTube video."
        : "Flagged current YouTube video; could not hide player.";
    } else {
      state.status = decision.skippedBanner ? "Flagged current YouTube video." : state.status;
    }
    return;
  }

  if (!decision.shouldAttemptScroll || state.mode !== "youtube") {
    if (decision.pauseAutoSkipping) {
      state.status = "Auto-skipping paused.";
    }
    return;
  }

  const webview = document.getElementById("shorts-webview") as unknown as SafeScrollTarget | null;
  const scrollOutcome = await scrollController.attemptNextShort(webview);
  state.skipBanner = applyScrollAttemptResult(skipSession, decision, scrollOutcome);
  state.status = scrollOutcome.succeeded
    ? "Skipped current Short."
    : "Could not auto-scroll; showing a warning.";
}

function openShortsUrl(): void {
  const input = document.getElementById("shorts-url-input") as HTMLInputElement | null;
  const parsed = parseYouTubeShortsUrl(input?.value ?? "");

  if ((!parsed.isShortsUrl && !parsed.isWatchUrl) || !parsed.normalizedUrl) {
    state.status = "Enter a YouTube Shorts or watch URL.";
    renderPreservingYouTubeWebView();
    return;
  }

  state.shortsUrl = parsed.normalizedUrl;
  state.extractedShort = null;
  state.scoreResponse = null;
  state.lookaheadResults = [];
  state.skipBanner = null;
  state.flaggedBanner = null;
  state.bannerDismissed = false;
  state.status = parsed.isWatchUrl ? "YouTube video loaded." : parsed.videoId ? "Shorts URL loaded." : "Shorts home loaded.";
  const webview = document.getElementById("shorts-webview") as unknown as {
    loadURL?: (url: string) => void;
    setAttribute?: (name: string, value: string) => void;
  } | null;
  if (webview) {
    setShortsLoadStatus("Loading YouTube...");
    if (webview.loadURL) {
      webview.loadURL(state.shortsUrl);
    } else {
      webview.setAttribute?.("src", state.shortsUrl);
    }
    renderPreservingYouTubeWebView();
    return;
  }

  render();
}

function bindShortsObserver(): void {
  detachShortsObserver?.();
  detachShortsObserver = null;

  if (state.mode !== "youtube") {
    return;
  }

  const webview = document.getElementById("shorts-webview") as unknown as EventTarget & { getURL?: () => string } | null;
  if (!webview) {
    return;
  }

  webview.addEventListener("did-attach", () => {
    setShortsLoadStatus("YouTube webview attached.");
  });
  webview.addEventListener("did-start-loading", () => {
    setShortsLoadStatus("Loading YouTube...");
  });
  webview.addEventListener("did-stop-loading", () => {
    setShortsLoadStatus("YouTube finished loading.");
  });
  webview.addEventListener("did-navigate", () => {
    setShortsLoadStatus("YouTube navigated.");
  });
  webview.addEventListener("did-navigate-in-page", () => {
    setShortsLoadStatus("YouTube navigation updated.");
  });
  webview.addEventListener("dom-ready", () => {
    setShortsLoadStatus("YouTube page is ready.");
  });
  webview.addEventListener("did-fail-load", (event) => {
    const loadEvent = event as WebViewLoadEvent;
    if (loadEvent.errorCode === -3 || loadEvent.isMainFrame === false) {
      return;
    }

    const message = loadEvent.errorDescription
      ? `YouTube failed to load: ${loadEvent.errorDescription}`
      : "YouTube failed to load.";
    setInlineStatus(message);
    setShortsLoadStatus(message);
  });

  detachShortsObserver = attachShortsWebViewNavigationObserver(webview, {
    debounceMs: 800,
    onSettledShortChange: async () => {
      await analyzeCurrentShort(false);
    }
  });
}

function setInlineStatus(message: string): void {
  state.status = message;
  const status = document.querySelector(".app-status");
  if (status) {
    status.textContent = message;
  }
}

function setShortsLoadStatus(message: string): void {
  const status = document.querySelector("[data-shorts-load-status]");
  if (status) {
    status.textContent = message;
  }
}

async function scanLookaheadCandidates(): Promise<ScoredLookaheadCandidate[]> {
  if (!state.settings?.enableLookaheadScan || state.settings.lookaheadCount <= 0) {
    return [];
  }

  if (!parseYouTubeShortsUrl(state.shortsUrl).isYouTubeUrl) {
    return [];
  }

  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<ScoreLookaheadPayload["candidates"]>;
  } | null;

  if (!webview?.executeJavaScript) {
    return [];
  }

  try {
    const candidates = await webview.executeJavaScript(
      getYouTubeLookaheadScannerScript(state.settings.lookaheadCount),
      true
    );
    return window.orislop.scoreLookaheadCandidates({ candidates });
  } catch {
    return [];
  }
}

async function applyRecommendationFiltering(results: ScoredLookaheadCandidate[]): Promise<void> {
  if (!state.settings?.hideFlaggedRecommendations || !parseYouTubeShortsUrl(state.shortsUrl).isWatchUrl) {
    return;
  }

  const videoIds = results
    .filter((item) => item.preSkip || item.scoreResult.action === "skip")
    .map((item) => item.candidate.videoId)
    .filter((videoId): videoId is string => typeof videoId === "string" && videoId.length > 0);

  if (videoIds.length === 0) {
    return;
  }

  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<number>;
  } | null;

  if (!webview?.executeJavaScript) {
    return;
  }

  try {
    const hiddenCount = await webview.executeJavaScript(
      getYouTubeRecommendationFilterScript(videoIds),
      true
    );
    if (hiddenCount > 0) {
      state.status = `Filtered ${hiddenCount} flagged recommendation${hiddenCount === 1 ? "" : "s"}.`;
    }
  } catch {
    state.status = "Recommendation filtering was unavailable on this page.";
  }
}

async function updateSetting(target: HTMLInputElement | HTMLSelectElement): Promise<void> {
  const key = target.dataset.setting;
  if (!key) {
    return;
  }

  const value = target instanceof HTMLInputElement && target.type === "checkbox"
    ? target.checked
    : target instanceof HTMLInputElement && target.type === "number"
      ? Number(target.value)
      : target.value;
  state.settings = await window.orislop.updateSettings({ [key]: value });
  state.scoreResponse = null;
  state.skipBanner = null;
  state.flaggedBanner = null;
  state.status = "Settings saved.";
  renderPreservingYouTubeWebView();
}

async function shieldCurrentYouTubeVideo(reason: string): Promise<boolean> {
  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<boolean>;
  } | null;

  if (!webview?.executeJavaScript) {
    return false;
  }

  return webview.executeJavaScript(getYouTubeCurrentVideoShieldScript(reason), true)
    .catch(() => false);
}

async function clearCurrentYouTubeVideoShield(): Promise<void> {
  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<boolean>;
  } | null;

  if (!webview?.executeJavaScript) {
    return;
  }

  await webview.executeJavaScript(getYouTubeClearCurrentVideoShieldScript(), true)
    .catch(() => false);
}

async function saveCalibrationLabel(
  userLabel: CalibrationUserLabel,
  userFeedback: UserFeedbackAction | null = null
): Promise<void> {
  if (!state.scoreResponse) {
    return;
  }

  const payload = state.mode === "mock" && state.selectedFixtureId
    ? {
      fixtureId: state.selectedFixtureId,
      scoreResult: state.scoreResponse.result,
      userLabel,
      userFeedback
    }
    : state.mode === "youtube" && state.extractedShort
      ? {
        short: state.extractedShort,
        scoreResult: state.scoreResponse.result,
        userLabel,
        userFeedback
      }
      : null;

  if (!payload) {
    return;
  }

  const response = await window.orislop.saveCalibrationLabel(payload);
  state.calibrationLabelCount = response.totalLabels;
  if (userFeedback && keepsCurrentShortVisible(userFeedback) && state.extractedShort) {
    rememberWatchAnyway(skipSession, state.extractedShort);
    await window.orislop.markWatchedAnyway({ short: state.extractedShort }).catch(() => undefined);
    await clearCurrentYouTubeVideoShield();
    state.skipBanner = null;
    state.flaggedBanner = null;
    state.bannerDismissed = true;
  }
  state.status = `Saved ${labelText(userLabel)} calibration label locally.`;
  renderPreservingYouTubeWebView();
}

async function exportCalibrationLabels(): Promise<void> {
  const records = await window.orislop.exportCalibrationLabels();
  const json = JSON.stringify(records, null, 2);

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(json);
    state.status = "Calibration labels copied as JSON.";
  } else {
    state.status = "Calibration export is ready in DevTools console.";
    console.log("Orislop calibration labels", json);
  }

  renderPreservingYouTubeWebView();
}

async function importCalibrationLabels(): Promise<void> {
  const text = window.prompt("Paste Orislop calibration label JSON");
  if (!text) {
    return;
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      state.status = "Calibration import must be a JSON array.";
      renderPreservingYouTubeWebView();
      return;
    }

    await window.orislop.importCalibrationLabels(parsed);
    state.calibrationLabelCount = (await window.orislop.listCalibrationLabels()).length;
    state.status = "Calibration labels imported locally.";
  } catch {
    state.status = "Could not import calibration JSON.";
  }

  renderPreservingYouTubeWebView();
}

async function saveFeedback(userFeedback: UserFeedbackAction): Promise<void> {
  if (!state.scoreResponse) {
    return;
  }

  if (state.mode === "mock" && state.selectedFixtureId) {
    await window.orislop.saveFeedback({
      fixtureId: state.selectedFixtureId,
      scoreResult: state.scoreResponse.result,
      userFeedback
    });
  } else if (state.mode === "youtube" && state.extractedShort) {
    await window.orislop.saveFeedback({
      short: state.extractedShort,
      scoreResult: state.scoreResponse.result,
      userFeedback
    });

    if (keepsCurrentShortVisible(userFeedback)) {
      rememberWatchAnyway(skipSession, state.extractedShort);
      await window.orislop.markWatchedAnyway({ short: state.extractedShort }).catch(() => undefined);
      await clearCurrentYouTubeVideoShield();
      state.skipBanner = null;
      state.flaggedBanner = null;
    }
  }

  if (keepsCurrentShortVisible(userFeedback)) {
    state.bannerDismissed = true;
  }

  state.status = "Feedback saved locally.";
  renderPreservingYouTubeWebView();
}

function keepsCurrentShortVisible(userFeedback: UserFeedbackAction): boolean {
  return userFeedback === "watch_anyway"
    || userFeedback === "show_anyway"
    || userFeedback === "wrong"
    || userFeedback === "not_slop"
    || userFeedback === "always_allow_channel";
}

function fallbackExtractedShort(url: string): ExtractedShort {
  const parsed = parseYouTubeShortsUrl(url);
  return {
    url: parsed.normalizedUrl ?? url,
    videoId: parsed.videoId,
    platform: "youtube",
    videoKind: parsed.videoKind,
    title: null,
    channelName: null,
    channelUrl: null,
    description: null,
    hashtags: [],
    visiblePageText: "",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: null,
    audioTrackTitle: null,
    audioIsSong: false,
    videoDurationSec: null,
    playbackCurrentTimeSec: null,
    playbackPaused: null,
    playbackReadyState: null,
    playerStateText: null,
    isLikelyAd: false,
    adNoticeText: null,
    communityReactionSummary: {
      status: state.settings?.useCommunityReactionSignal ? "unavailable" : "disabled",
      inspectedCount: 0,
      matchCounts: {
        slop: 0,
        fake_repost: 0,
        ai: 0,
        scam_claim_risk: 0
      },
      matchedCategories: [],
      strength: "none",
      usedRawComments: false,
      sampledAt: null
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelText(label: CalibrationUserLabel): string {
  switch (label) {
    case "not_slop":
      return "not slop";
    case "ai_generated":
      return "AI-generated";
    case "claim_risk":
      return "scam/claim-risk";
    case "unclear":
      return "unsure";
    default:
      return label;
  }
}

function defaultFeedbackForLabel(label: CalibrationUserLabel): UserFeedbackAction | null {
  if (label === "not_slop") {
    return "not_slop";
  }

  return label === "unclear" ? null : "correct";
}

function labelForFeedback(feedback: UserFeedbackAction): CalibrationUserLabel {
  if (!state.scoreResponse) {
    return "unclear";
  }

  if (feedback === "wrong") {
    return state.scoreResponse.result.action === "allow" ? "slop" : "not_slop";
  }

  if (feedback === "not_slop" || feedback === "watch_anyway" || feedback === "always_allow_channel") {
    return "not_slop";
  }

  if (feedback === "correct") {
    if (state.scoreResponse.result.categories.includes("possible_unlabeled_ai") || (state.scoreResponse.result.aiEvidenceScore ?? 0) >= 0.6) {
      return "ai_generated";
    }

    if (state.scoreResponse.result.claimRiskScore >= 0.6) {
      return "claim_risk";
    }

    return state.scoreResponse.result.action === "allow" ? "not_slop" : "slop";
  }

  return "unclear";
}

function selectedFixture(): MockShortFixture | null {
  return state.fixtures.find((fixture) => fixture.id === state.selectedFixtureId) ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
