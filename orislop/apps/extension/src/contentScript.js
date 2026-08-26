(() => {
  "use strict";

  const FLAGGED_KEY = "orislop.extension.flaggedLog";
  const SKIPPED_KEY = "orislop.extension.skippedLog";
  const SETTINGS_KEY = "orislop.extension.settings";
  const OLLAMA_STATUS_KEY = "orislop.extension.ollamaStatus";
  const DETECTOR_STATUS_KEY = "orislop.extension.detectorStatus";
  const FACT_CHECK_STATUS_KEY = "orislop.extension.factCheckStatus";
  const SCAN_STATUS_KEY = "orislop.extension.scanStatus";
  const LEARNED_BRAINROT_KEY = "orislop.extension.learnedBrainrotV1";
  const PROCESSED_ATTR = "data-orislop-processed";
  const SIGNATURE_ATTR = "data-orislop-signature";
  const ITEM_KEY_ATTR = "data-orislop-item-key";
  const SCORE_BATCH_SIZE = 10;
  const LINKEDIN_LOOKAHEAD_LIMIT = 100;
  const SHORT_FORM_LOOKAHEAD_LIMIT = 6;
  const SAVED_SECONDS_PER_SKIP = 20;
  const MAX_LOCAL_BACKGROUND_CONCURRENCY = 2;
  const MAX_CLOUD_BACKGROUND_CONCURRENCY = 4;
  const BACKGROUND_BATCH_YIELD_MS = 24;
  const SCAN_DEBOUNCE_MS = 120;
  const SCAN_FOLLOWUP_DELAY_MS = 600;
  const FAST_DECISION_WINDOW_MS = 2000;
  const DETECTOR_PENDING_POLL_MS = 350;
  const DETECTOR_PROVISIONAL_POLL_MS = 700;
  const CONTEXT_PENDING_POLL_MS = 600;
  const OLLAMA_RESPONSE_TIMEOUT_MS = 185000;
  const ORISLOP_UI_SELECTOR = ".orislop-live-indicator, .orislop-prescan-cover, .orislop-decision-cover, .orislop-explain-button, .orislop-linkedin-trust-button, .orislop-explanation-panel, .orislop-fact-sources";
  const LEGACY_OLLAMA_MODEL = "qwen2.5:1.5b-instruct";
  const ORISLOP_OLLAMA_MODEL = "orislop-qwen2.5:1.5b-instruct";
  const SLOP_PREFERENCE_API = globalThis.OrislopSlopPreferences;
  const DEFAULT_SLOP_PREFERENCES = SLOP_PREFERENCE_API?.defaultIds || [];
  const DEFAULT_SETTINGS = {
    enabled: true,
    hideSkipped: true,
    ollamaModel: ORISLOP_OLLAMA_MODEL,
    inferenceMode: "local",
    performanceMode: "heavy",
    watchIntentComplete: true,
    slopPreferences: [...DEFAULT_SLOP_PREFERENCES]
  };

  let settingsCache = { ...DEFAULT_SETTINGS };
  let explanationPanelSequence = 0;
  let scanTimer = 0;
  let scanInFlight = false;
  let scanQueued = false;
  let scanNotBefore = 0;
  let lastHref = window.location.href;
  let decisionCache = null;
  let historyWriter = null;
  const loggedSkipKeys = new Set();
  const observedItemKeys = new Set();
  const advancedItemKeys = new Set();
  const openedLinkedInVideoKeys = new Set();
  const suppressedMediaByItem = new Map();
  const originalPlaybackState = new WeakMap();
  const learnedBrainrotTerms = new Set();
  const learnedBrainrotEvidence = new Map();
  let lastScanStatusFingerprint = "";
  let scanIndicatorTimer = 0;
  let latestScanProgress = emptyScanProgress();

  if (globalThis.__ORISLOP_TEST__ === true) {
    globalThis.__ORISLOP_EXTENSION_TEST_API__ = Object.freeze({
      normalizeSettings,
      parsePlatformUrl: globalThis.OrislopClassifier?.parsePlatformUrl,
      scoreOneCandidate,
      isSponsoredCandidate,
      platformAdapters: globalThis.OrislopPlatformAdapters,
      extractCandidate: (element, platform) => extractCandidate(element, platform),
      findRecentDirectMediaResource,
      findMediaHost,
      calculateSavedSeconds,
      createScoringBatches,
      runBatchesWithConcurrency,
      adaptiveBackgroundConcurrency,
      scanPriorityForElement,
      shouldShieldCandidate,
      shouldRefreshDecision,
      isDecisionTerminal,
      explanationModeForDecision,
      linkedInTrustLabel,
      renderPageScanIndicator,
      restoreReusedCandidateElements,
      findCandidateRootForVideo,
      findVisibleVideo,
      showDecisionCover,
      suppressPlayback,
      releaseSuppressedPlayback,
      enforcePlaybackSuppression,
      extractLearnableBrainrotTerms
    });
  } else {
    boot();
  }

  function boot() {
    if (!globalThis.OrislopExtensionCore || !globalThis.OrislopClassifier || !globalThis.OrislopPlatformAdapters) return;
    decisionCache = globalThis.OrislopExtensionCore.createDecisionCache({ limit: 600 });
    historyWriter = globalThis.OrislopExtensionCore.createHistoryWriter({
      readList,
      writeList: (key, records) => chrome.storage.local.set({ [key]: records })
    });
    void loadLearnedBrainrotState();

    void loadSettings().then((settings) => {
      settingsCache = settings;
      void publishScanStatus({ state: settings.enabled ? "starting" : "paused", visibleCount: 0 }, true);
      scheduleScan();
    });

    new MutationObserver((records) => {
      if (records.some(hasExternalMutation)) scheduleScan();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "poster", "data-e2e", "data-video-id", "aria-label"]
    });
    window.addEventListener("scroll", scheduleScan, { passive: true });
    window.addEventListener("popstate", scheduleScan, { passive: true });
    window.addEventListener("yt-navigate-finish", scheduleScan, { passive: true });
    window.addEventListener("yt-page-data-updated", scheduleScan, { passive: true });
    window.addEventListener("pageshow", scheduleScan, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleScan();
    }, { passive: true });
    document.addEventListener("play", enforcePlaybackSuppression, true);
    document.addEventListener("play", rememberOpenedLinkedInVideo, true);
    for (const mediaEvent of ["loadedmetadata", "emptied", "durationchange", "playing"]) {
      document.addEventListener(mediaEvent, scheduleScan, true);
    }
    document.addEventListener("click", rememberOpenedLinkedInVideoClick, true);
    document.addEventListener("volumechange", enforcePlaybackSuppression, true);
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "orislop.scanNow") return false;
      resetProcessedState();
      void publishScanStatus({ state: settingsCache.enabled ? "scanning" : "paused", visibleCount: 0 }, true);
      scanNotBefore = 0;
      scheduleScan();
      sendResponse({ ok: true, enabled: settingsCache.enabled, platform: currentPlatform() });
      return false;
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[LEARNED_BRAINROT_KEY]) {
        applyLearnedBrainrotState(changes[LEARNED_BRAINROT_KEY].newValue);
        decisionCache.clear();
        resetProcessedState();
        scheduleScan();
      }
      if (!changes[SETTINGS_KEY]) return;
      const previous = settingsCache;
      settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
      if (previous.enabled && !settingsCache.enabled) {
        restoreAllOrislopUi();
        void publishScanStatus({ state: "paused", visibleCount: 0 }, true);
        return;
      }
      if (!previous.enabled && settingsCache.enabled) {
        void publishScanStatus({ state: "starting", visibleCount: 0 }, true);
      }
      if (previous.ollamaModel !== settingsCache.ollamaModel
        || previous.inferenceMode !== settingsCache.inferenceMode
        || previous.performanceMode !== settingsCache.performanceMode
        || previous.slopPreferences.join("|") !== settingsCache.slopPreferences.join("|")) {
        decisionCache.clear();
        resetProcessedState();
      }
      if (previous.hideSkipped && !settingsCache.hideSkipped) restoreAutomaticallyHiddenItems();
      if (!previous.hideSkipped && settingsCache.hideSkipped) resetProcessedState();
      scheduleScan();
    });
  }

  function scheduleScan(delayInput = SCAN_DEBOUNCE_MS) {
    const requestedDelay = Number.isFinite(delayInput) ? Math.max(0, delayInput) : SCAN_DEBOUNCE_MS;
    const cooldownDelay = Math.max(0, scanNotBefore - Date.now());
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanLookahead, Math.max(requestedDelay, cooldownDelay));
  }

  function rememberOpenedLinkedInVideo(event) {
    if (currentPlatform() !== "linkedin" || !(event.target instanceof HTMLVideoElement)) return;
    const adapter = OrislopPlatformAdapters.get("linkedin");
    const root = findCandidateRootForVideo(event.target, "linkedin", adapter);
    markLinkedInVideoOpened(root);
  }

  function rememberOpenedLinkedInVideoClick(event) {
    if (currentPlatform() !== "linkedin" || !(event.target instanceof Element)) return;
    const control = event.target.closest("video, a[href*='/posts/'], a[href*='/feed/update/urn:li:activity:'], button[aria-label*='play' i], button[aria-label*='open' i], button[aria-label*='fullscreen' i]");
    if (!(control instanceof Element)) return;
    const adapter = OrislopPlatformAdapters.get("linkedin");
    const video = control instanceof HTMLVideoElement ? control : control.closest("article, [data-urn^='urn:li:activity:'], [data-id^='urn:li:activity:']")?.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) return;
    const root = findCandidateRootForVideo(video, "linkedin", adapter);
    markLinkedInVideoOpened(root);
  }

  function markLinkedInVideoOpened(root) {
    if (!(root instanceof HTMLElement)) return;
    const candidate = extractCandidate(root, "linkedin");
    if (!candidate.itemKey) return;
    openedLinkedInVideoKeys.add(candidate.itemKey);
    while (openedLinkedInVideoKeys.size > 200) {
      openedLinkedInVideoKeys.delete(openedLinkedInVideoKeys.values().next().value);
    }
    decisionCache?.delete?.(candidate.itemKey);
    root.removeAttribute(PROCESSED_ATTR);
    root.removeAttribute(SIGNATURE_ATTR);
    scheduleScan(0);
  }

  async function scanLookahead() {
    if (!settingsCache.enabled) {
      restoreAllOrislopUi();
      void publishScanStatus({ state: "paused", visibleCount: 0 });
      return;
    }
    if (scanInFlight) {
      scanQueued = true;
      return;
    }
    scanNotBefore = 0;
    scanInFlight = true;
    try {
      syncLocation();
      const fastStartedAt = performance.now();
      const jobs = [];
      const scanEntries = [];
      const loadedCandidates = findLookaheadCandidates();
      const visibleCount = loadedCandidates.filter(({ element }) => isInViewport(element)).length;
      for (const { element, candidate, current, scanPriority } of loadedCandidates) {
        if (!(element instanceof HTMLElement) || element.getAttribute(PROCESSED_ATTR) === "allowed") continue;
        if (!candidate.itemKey || (!current && !candidate.title && candidate.visibleText.length < 20)) continue;
        scanEntries.push({ element, candidate, current, scanPriority });
        observedItemKeys.add(candidate.itemKey);
        while (observedItemKeys.size > 1000) observedItemKeys.delete(observedItemKeys.values().next().value);
        element.setAttribute(ITEM_KEY_ATTR, candidate.itemKey);
        const signature = createSignature(candidate);
        const cached = decisionCache.get(candidate.itemKey);
        const shouldRefreshCached = shouldRefreshDecision(cached, candidate);
        if (cached && !shouldRefreshCached) {
          applyDecision(element, candidate, cached);
          element.setAttribute(PROCESSED_ATTR, "true");
          element.setAttribute(SIGNATURE_ATTR, signature);
          continue;
        }
        if (!cached && element.getAttribute(SIGNATURE_ATTR) === signature) continue;
        element.setAttribute(PROCESSED_ATTR, "true");
        element.setAttribute(SIGNATURE_ATTR, signature);
        const instantDecision = scoreOneCandidate(candidate);
        if (candidate.platform !== "linkedin"
          && (instantDecision.hardLocalSkip === true || instantDecision.hardAiSynthetic === true)) {
          applyScoredJobs([{ element, candidate, current, scanPriority }], [instantDecision]);
          continue;
        }
        if (shouldShieldCandidate(instantDecision)) showPreScanCover(element, candidate, current);
        jobs.push({ element, candidate, current, scanPriority });
      }

      const fastElapsedMs = Math.max(0, Math.round(performance.now() - fastStartedAt));
      const initialCoverage = summarizeRefinementCoverage(scanEntries);
      const refinementTargetCount = jobs.length + initialCoverage.ready + initialCoverage.pending;
      await publishScanStatus({
        state: jobs.length > 0 ? "scanning" : "active",
        phase: jobs.length > 0 ? "refining" : "complete",
        loadedCount: scanEntries.length,
        visibleCount,
        fastCheckedCount: scanEntries.length,
        fastElapsedMs,
        fastWithinTarget: fastElapsedMs <= FAST_DECISION_WINDOW_MS,
        deepQueuedCount: refinementTargetCount,
        deepProcessedCount: 0,
        deepReadyCount: settingsCache.inferenceMode === "hybrid" ? initialCoverage.heavyReady : initialCoverage.ready,
        heavyEscalatedCount: initialCoverage.heavyEscalated,
        deepPendingCount: jobs.length + initialCoverage.pending,
        heavyP95Ms: 0,
        error: ""
      }, true);
      const batches = createScoringBatches(jobs);
      const currentBatches = batches.filter((batch) => batch[0]?.current === true);
      const lookaheadBatches = batches.filter((batch) => batch[0]?.current !== true);
      let deepProcessedCount = 0;
      const heavyLatencySamples = [];
      const processBatch = async (batch) => {
        const results = await scoreCandidates(batch.map((job) => ({
          ...job.candidate,
          scanPriority: job.scanPriority
        })));
        applyScoredJobs(batch, results);
        deepProcessedCount += batch.length;
        for (const result of results) {
          const detector = result?.detectorDecision;
          const latency = Number(detector?.latency?.completionMs);
          if (String(detector?.executionPath || "").startsWith("cloud_heavy")
            && Number.isFinite(latency) && latency >= 0) heavyLatencySamples.push(latency);
        }
        const coverage = summarizeRefinementCoverage(scanEntries);
        await publishScanStatus({
          state: deepProcessedCount < jobs.length || coverage.pending > 0 ? "scanning" : "active",
          phase: deepProcessedCount < jobs.length || coverage.pending > 0 ? "refining" : "complete",
          deepProcessedCount,
          deepReadyCount: settingsCache.inferenceMode === "hybrid" ? coverage.heavyReady : coverage.ready,
          heavyEscalatedCount: coverage.heavyEscalated,
          deepPendingCount: Math.max(0, jobs.length - deepProcessedCount) + coverage.pending,
          heavyP95Ms: percentile95(heavyLatencySamples)
        });
      };
      for (const batch of currentBatches) {
        await processBatch(batch);
      }
      const backgroundConcurrency = adaptiveBackgroundConcurrency(settingsCache);
      await runBatchesWithConcurrency(lookaheadBatches, processBatch, backgroundConcurrency);
      const finalCoverage = summarizeRefinementCoverage(scanEntries);
      await publishScanStatus({
        state: "active",
        phase: finalCoverage.pending > 0 ? "refining" : "complete",
        deepProcessedCount,
        deepReadyCount: settingsCache.inferenceMode === "hybrid" ? finalCoverage.heavyReady : finalCoverage.ready,
        heavyEscalatedCount: finalCoverage.heavyEscalated,
        deepPendingCount: finalCoverage.pending,
        heavyP95Ms: percentile95(heavyLatencySamples)
      });
    } catch (error) {
      void publishScanStatus({
        state: "error",
        visibleCount: 0,
        error: cleanText(error instanceof Error ? error.message : String(error), 180)
      }, true);
    } finally {
      scanInFlight = false;
      if (scanQueued) {
        scanQueued = false;
        scanNotBefore = Date.now() + SCAN_FOLLOWUP_DELAY_MS;
        scheduleScan(SCAN_FOLLOWUP_DELAY_MS);
      }
    }
  }

  function createScoringBatches(jobs) {
    const current = jobs.filter((job) => job.current === true).map((job) => [job]);
    const background = jobs
      .filter((job) => job.current !== true)
      .sort((left, right) => Number(left.scanPriority || 10) - Number(right.scanPriority || 10));
    for (let offset = 0; offset < background.length; offset += SCORE_BATCH_SIZE) {
      current.push(background.slice(offset, offset + SCORE_BATCH_SIZE));
    }
    return current;
  }

  async function runBatchesWithConcurrency(batches, worker, concurrency = 1) {
    const queue = Array.isArray(batches) ? batches : [];
    const laneCount = Math.max(1, Math.min(Number(concurrency) || 1, queue.length || 1));
    let cursor = 0;
    const lanes = Array.from({ length: laneCount }, async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        await worker(queue[index], index);
        if (cursor < queue.length) await new Promise((resolve) => setTimeout(resolve, BACKGROUND_BATCH_YIELD_MS));
      }
    });
    await Promise.all(lanes);
  }

  function adaptiveBackgroundConcurrency(settings = {}, hardware = navigator) {
    const cores = Math.max(1, Number(hardware?.hardwareConcurrency) || 1);
    const memoryGiB = Math.max(0, Number(hardware?.deviceMemory) || 0);
    const connection = hardware?.connection || hardware?.mozConnection || hardware?.webkitConnection || {};
    const constrainedNetwork = connection.saveData === true
      || /(?:^|-)2g$/i.test(String(connection.effectiveType || ""));
    if (globalThis.document?.hidden === true || constrainedNetwork || cores <= 4 || (memoryGiB > 0 && memoryGiB <= 4)) return 1;
    const cloud = settings.inferenceMode === "hybrid" || settings.inferenceMode === "cloud";
    if (cloud) {
      if (cores >= 12 && (memoryGiB === 0 || memoryGiB >= 8)) return MAX_CLOUD_BACKGROUND_CONCURRENCY;
      return 2;
    }
    return cores >= 16 && (memoryGiB === 0 || memoryGiB >= 8)
      ? MAX_LOCAL_BACKGROUND_CONCURRENCY
      : 1;
  }

  function summarizeRefinementCoverage(entries) {
    let ready = 0;
    let heavyReady = 0;
    let heavyEscalated = 0;
    let pending = 0;
    for (const { candidate } of entries) {
      const decision = decisionCache.get(candidate.itemKey);
      const detector = decision?.detectorDecision;
      const state = detector?.status || decision?.detectorStatus || "";
      if (state === "ready" || state === "available") {
        ready += 1;
        if (String(detector?.executionPath || "").startsWith("cloud_heavy")) heavyReady += 1;
      }
      if (detector?.heavyEscalated === true) heavyEscalated += 1;
      if (state === "pending" || state === "provisional") pending += 1;
    }
    return { ready, heavyReady, heavyEscalated, pending };
  }

  function percentile95(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]);
  }

  function shouldShieldCandidate(decision) {
    if (!decision || decision.hardAiSynthetic === true || decision.educationalProtected === true) return false;
    const heuristicScore = Number(decision.sourceScores?.heuristic) || 0;
    return decision.hardStackedFormat === true
      || Number(decision.strongEvidenceCount || 0) >= 2
      || heuristicScore >= 60;
  }

  function shouldRefreshDecision(cached, candidate, now = Date.now()) {
    if (!cached || cached.hardAiSynthetic === true) return false;
    if (cached.detectorStatus === "deferred_until_open" && candidate.fullVideoAnalysisRequested === true) return true;
    if (cached.decisionLocked === true) return false;
    const decisionAge = now - Number(cached.firstCheckedAt || cached.detectorCheckedAt || 0);
    const insideFastWindow = decisionAge < FAST_DECISION_WINDOW_MS;
    const contextAge = now - Number(cached.contextCheckedAt || 0);
    const shouldRefreshForOllama = cached.transcriptChecked !== true
      && hasTranscriptForOllama(candidate)
      && contextAge >= (insideFastWindow ? CONTEXT_PENDING_POLL_MS : 4000);
    const detectorAge = now - Number(cached.detectorCheckedAt || 0);
    const shouldRefreshForDetector = (cached.detectorStatus === "provisional"
        && detectorAge >= (insideFastWindow ? DETECTOR_PROVISIONAL_POLL_MS : 4000))
      || (cached.detectorStatus === "pending"
        && detectorAge >= (insideFastWindow ? DETECTOR_PENDING_POLL_MS : 4000))
      || (cached.detectorDecision?.executionPath === "local_fast_fallback" && Boolean(candidate.mediaUrl) && detectorAge >= 4000)
      || (cached.detectorStatus === "unavailable" && detectorAge >= 30000);
    const factCheckAge = now - Number(cached.factCheckedAt || 0);
    const shouldRefreshForFactCheck = cached.factCheckEligible === true
      && ((cached.factCheckStatus === "pending" && factCheckAge >= 8000)
        || (["unavailable", "unconfigured", "degraded"].includes(cached.factCheckStatus) && factCheckAge >= 60000));
    return shouldRefreshForOllama || shouldRefreshForDetector || shouldRefreshForFactCheck;
  }

  function isDecisionTerminal(decision, candidate) {
    if (decision?.hardLocalSkip === true || decision?.hardAiSynthetic === true) return true;
    const detectorSettled = !["pending", "provisional"].includes(decision?.detectorStatus);
    const contextSettled = !hasTranscriptForOllama(candidate)
      || ["available", "bypassed_hard_ai", "bypassed_hard_preference", "no_text"].includes(decision?.ollamaStatus);
    const factCheckSettled = decision?.factCheckEligible !== true || decision?.factCheckStatus !== "pending";
    return detectorSettled && contextSettled && factCheckSettled;
  }

  function hasExternalMutation(record) {
    if (record?.type === "attributes") return !isOrislopUiNode(record.target);
    const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return changed.some((node) => !isOrislopUiNode(node));
  }

  function isOrislopUiNode(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!(element instanceof Element)) return true;
    return element.matches(ORISLOP_UI_SELECTOR) || Boolean(element.closest(ORISLOP_UI_SELECTOR));
  }

  function applyScoredJobs(jobs, results) {
    for (let index = 0; index < jobs.length; index += 1) {
      const { element, candidate } = jobs[index];
      if (!element.isConnected || decisionCache.isAllowed(candidate.itemKey)) continue;
      const decision = results[index] || scoreOneCandidate(candidate);
      const previous = decisionCache.get(candidate.itemKey);
      if (previous?.decisionLocked === true) {
        applyDecision(element, candidate, previous);
        continue;
      }
      const contextComplete = ["available", "bypassed_hard_ai", "bypassed_hard_preference", "no_text"].includes(decision.ollamaStatus);
      const now = Date.now();
      const stableDecision = {
        ...decision,
        decisionLocked: isDecisionTerminal(decision, candidate),
        decisionOwner: cleanText(
          decision.detectorDecision?.decisionOwner
            || (decision.hardAiSynthetic === true ? "explicit_ai_or_fast_policy" : "local_fast"),
          80
        ),
        transcriptChecked: !hasTranscriptForOllama(candidate) || contextComplete,
        firstCheckedAt: previous?.firstCheckedAt || now,
        contextCheckedAt: now,
        detectorCheckedAt: now,
        factCheckedAt: now
      };
      decisionCache.set(candidate.itemKey, stableDecision);
      applyDecision(element, candidate, stableDecision);
    }
  }

  function syncLocation() {
    if (window.location.href === lastHref) return;
    const previousHref = lastHref;
    lastHref = window.location.href;
    releaseAllSuppressedPlayback(true);
    const preserveShortsLookahead = isAdjacentYouTubeShortNavigation(previousHref, lastHref);
    if (preserveShortsLookahead) {
      for (const element of document.querySelectorAll(".orislop-current-item-hidden")) {
        element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      }
    } else {
      restoreAutomaticallyHiddenItems();
    }
    for (const cover of document.querySelectorAll(".orislop-decision-cover, .orislop-prescan-cover")) cover.remove();
    for (const host of document.querySelectorAll(".orislop-decision-host")) host.classList.remove("orislop-decision-host");
    clearExplanationUi();
    observedItemKeys.clear();
    lastScanStatusFingerprint = "";
    resetProcessedState();
  }

  function isAdjacentYouTubeShortNavigation(previousHref, currentHref) {
    try {
      const previous = new URL(previousHref);
      const current = new URL(currentHref);
      return previous.hostname === current.hostname
        && /^\/shorts\/[^/]+/.test(previous.pathname)
        && /^\/shorts\/[^/]+/.test(current.pathname);
    } catch {
      return false;
    }
  }

  async function publishScanStatus(update, force = false) {
    const platform = currentPlatform();
    const supported = platform === "youtube";
    const merged = { ...latestScanProgress, ...update };
    const status = {
      state: settingsCache.enabled ? (merged.state || "active") : "paused",
      platform: supported ? platform : "unsupported",
      checkedCount: observedItemKeys.size,
      phase: cleanText(merged.phase, 24) || "idle",
      loadedCount: Math.max(0, Number(merged.loadedCount) || 0),
      visibleCount: Math.max(0, Number(merged.visibleCount) || 0),
      fastCheckedCount: Math.max(0, Number(merged.fastCheckedCount) || 0),
      fastElapsedMs: Math.max(0, Number(merged.fastElapsedMs) || 0),
      fastWithinTarget: merged.fastWithinTarget === true,
      deepQueuedCount: Math.max(0, Number(merged.deepQueuedCount) || 0),
      deepProcessedCount: Math.max(0, Number(merged.deepProcessedCount) || 0),
      deepReadyCount: Math.max(0, Number(merged.deepReadyCount) || 0),
      deepPendingCount: Math.max(0, Number(merged.deepPendingCount) || 0),
      heavyP95Ms: Math.max(0, Number(merged.heavyP95Ms) || 0),
      error: cleanText(merged.error, 180),
      updatedAt: new Date().toISOString()
    };
    latestScanProgress = status;
    const fingerprint = JSON.stringify({ ...status, updatedAt: undefined });
    if (!force && fingerprint === lastScanStatusFingerprint) return;
    lastScanStatusFingerprint = fingerprint;
    renderPageScanIndicator(status);
    try {
      await chrome.storage.local.set({ [SCAN_STATUS_KEY]: status });
    } catch {
      // Status reporting must never interrupt feed protection.
    }
  }

  function renderPageScanIndicator(status) {
    window.clearTimeout(scanIndicatorTimer);
    let host = document.querySelector(".orislop-live-indicator");
    if (status?.state === "paused") {
      host?.remove();
      return;
    }
    if (!(host instanceof HTMLElement)) {
      host = document.createElement("div");
      host.className = "orislop-live-indicator";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      const mark = document.createElement("span");
      mark.className = "orislop-live-indicator-mark";
      mark.textContent = "O";
      const text = document.createElement("span");
      text.className = "orislop-live-indicator-copy";
      host.append(mark, text);
      document.documentElement.append(host);
    }
    host.dataset.state = status?.state || "starting";
    const copy = host.querySelector(".orislop-live-indicator-copy");
    if (copy) {
      const legacyChecked = Math.max(0, Number(status?.checkedCount) || 0);
      const loadedCount = Math.max(legacyChecked, Number(status?.loadedCount) || Number(status?.visibleCount) || 0);
      const fastCheckedCount = Math.max(legacyChecked, Number(status?.fastCheckedCount) || 0);
      const deepProcessedCount = Math.max(0, Number(status?.deepProcessedCount) || 0);
      const deepQueuedCount = Math.max(deepProcessedCount, Number(status?.deepQueuedCount) || 0);
      const hasPipelineProgress = status?.fastCheckedCount !== undefined
        || status?.loadedCount !== undefined
        || status?.deepQueuedCount !== undefined;
      void fastCheckedCount;
      void deepProcessedCount;
      void deepQueuedCount;
      void hasPipelineProgress;
      copy.textContent = status?.state === "scanning"
        ? loadedCount > 0
          ? `Filtering ${loadedCount} ${platformItemNoun(currentPlatform(), loadedCount)}`
          : "Filtering"
        : status?.state === "error"
          ? "Filtering needs attention"
          : "Filtering";
    }
    host.classList.add("orislop-live-indicator-visible");
    const visibleFor = status?.state === "scanning" ? 2200 : status?.state === "error" ? 6000 : 1800;
    scanIndicatorTimer = window.setTimeout(() => host?.classList.remove("orislop-live-indicator-visible"), visibleFor);
  }

  function findLookaheadCandidates() {
    const platform = currentPlatform();
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return [];
    const roots = collectCandidateRoots(platform, adapter);
    const currentVideo = findVisibleVideo(document, true);
    let currentRoot = currentVideo ? findCandidateRootForVideo(currentVideo, platform, adapter) : null;
    if (platform === "youtube" && window.location.pathname === "/watch") {
      currentRoot = document.querySelector("ytd-watch-metadata") || currentRoot;
    }
    if (currentRoot instanceof HTMLElement && !roots.includes(currentRoot)) roots.unshift(currentRoot);
    restoreReusedCandidateElements(roots);
    const platformRoots = roots
      .filter((element) => element instanceof HTMLElement)
      .filter(isPlatformCandidate);
    const preferredVideoRoots = new Set();
    if (platform !== "youtube" || window.location.pathname.startsWith("/shorts/")) {
      for (const video of safeQueryAll(document, adapter.videoSelectors)) {
        const preferredRoot = findCandidateRootForVideo(video, platform, adapter);
        if (preferredRoot instanceof HTMLElement) preferredVideoRoots.add(preferredRoot);
      }
    }
    const platformRootSet = new Set(platformRoots);
    const containerRoots = new Set();
    for (const element of platformRoots) {
      let ancestor = element.parentElement;
      while (ancestor instanceof HTMLElement) {
        if (platformRootSet.has(ancestor)) containerRoots.add(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
    let all = platformRoots.filter((element) => {
      const enclosedByPreferredRoot = Array.from(preferredVideoRoots)
        .some((root) => root !== element && root.contains(element));
      if (enclosedByPreferredRoot) return false;
      return preferredVideoRoots.has(element) || !containerRoots.has(element);
    });
    if (currentRoot instanceof HTMLElement) {
      all = all.filter((element) => element !== currentRoot && !element.contains(currentVideo));
      all.unshift(currentRoot);
    }
    const unique = [];
    const seen = new Set();
    for (const element of all) {
      const current = Boolean(currentVideo && (element === currentRoot || element === currentVideo || element.contains(currentVideo)))
        || (!currentVideo && isLikelyCurrentElement(element));
      const candidate = extractCandidate(element, "", current);
      if (isSponsoredCandidate(element, candidate)) {
        restoreSponsoredCandidate(element, candidate.itemKey);
        continue;
      }
      if (element.classList.contains("orislop-skip-hidden")) continue;
      const key = candidate.itemKey || `node:${unique.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ element, candidate, current });
    }
    const ordered = unique
      .map((entry) => ({ ...entry, scanPriority: scanPriorityForElement(entry.element, entry.current) }))
      .sort((left, right) => {
        const priority = left.scanPriority - right.scanPriority;
        if (priority !== 0) return priority;
        return left.element.getBoundingClientRect().top - right.element.getBoundingClientRect().top;
      });
    if (platform === "linkedin") return ordered.slice(0, LINKEDIN_LOOKAHEAD_LIMIT);
    if (["instagram", "tiktok"].includes(platform)) return ordered.slice(0, SHORT_FORM_LOOKAHEAD_LIMIT);
    return ordered;
  }

  function isSponsoredCandidate(element, candidate = {}) {
    if (!element) return false;
    const sponsoredRoots = [
      "ytd-promoted-video-renderer",
      "ytd-display-ad-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "ytd-ad-slot-renderer",
      "ytm-promoted-sparkles-web-renderer",
      '[data-e2e="feed-ad"]',
      '[data-ad-preview]'
    ].join(",");
    try {
      if (element.matches?.(sponsoredRoots) || element.closest?.(sponsoredRoots)) return true;
    } catch {
      // Platform DOM changes must fail open and leave the card visible.
    }
    const labels = safeQueryAll(element, [
      "[aria-label]",
      "[data-content]",
      '[data-e2e="feed-ad-label"]',
      ".badge-shape-wiz__text",
      "yt-formatted-string",
      "span"
    ]).slice(0, 80);
    const sponsoredLabels = new Set(["ad", "advertisement", "promoted", "sponsored"]);
    if (labels.some((node) => [
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("data-content"),
      node.textContent
    ].some((value) => sponsoredLabels.has(cleanText(value, 40).toLowerCase())))) return true;
    const candidateText = `${cleanText(candidate.title, 1000)} ${cleanText(candidate.visibleText, 2000)}`;
    return candidateText.includes("Sponsored") || candidateText.includes("Promoted");
  }

  function restoreSponsoredCandidate(element, itemKey) {
    releaseSuppressedPlayback(itemKey, false);
    clearDecisionUi(element, itemKey);
    clearExplanationUi(itemKey);
    element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
    delete element.dataset.orislopAutoHidden;
    element.removeAttribute(ITEM_KEY_ATTR);
    element.removeAttribute(PROCESSED_ATTR);
    element.removeAttribute(SIGNATURE_ATTR);
  }

  function restoreReusedCandidateElements(elements) {
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      const previousItemKey = element.getAttribute(ITEM_KEY_ATTR) || "";
      if (!previousItemKey) continue;
      const currentItemKey = extractCandidate(element).itemKey || "";
      if (!currentItemKey || currentItemKey === previousItemKey) continue;
      releaseSuppressedPlayback(previousItemKey, false);
      clearDecisionUi(element, previousItemKey);
      clearExplanationUi(previousItemKey);
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      delete element.dataset.orislopAutoHidden;
      element.removeAttribute(ITEM_KEY_ATTR);
      element.removeAttribute(PROCESSED_ATTR);
      element.removeAttribute(SIGNATURE_ATTR);
    }
  }

  function collectCandidateRoots(platform, adapter) {
    const roots = new Set(safeQueryAll(document, adapter.candidateSelectors));
    if (platform === "linkedin" && isLinkedInProfilePage()) {
      const profile = document.querySelector("main");
      if (profile instanceof HTMLElement) roots.add(profile);
    }
    if (platform !== "youtube" || window.location.pathname.startsWith("/shorts/")) {
      for (const video of safeQueryAll(document, adapter.videoSelectors)) {
        const root = findCandidateRootForVideo(video, platform, adapter);
        if (root) roots.add(root);
      }
    }
    return Array.from(roots);
  }

  function findCandidateRootForVideo(video, platform, adapter) {
    if (!(video instanceof HTMLElement)) return null;
    let node = video;
    let best = video.parentElement;
    let bestScore = -Infinity;
    const itemSelector = adapter.itemLinkSelectors.join(",");
    const metadataSelector = [...adapter.titleSelectors, ...adapter.creatorSelectors, ...adapter.textSelectors].join(",");
    const strongRootSelector = "article, ytd-watch-metadata, yt-shorts-video-renderer, ytd-reel-video-renderer, [data-urn^='urn:li:activity:'], [data-id^='urn:li:activity:'], .feed-shared-update-v2, .occludable-update, [data-e2e='recommend-list-item-container'], [data-e2e='feed-item'], [data-e2e='browse-video']";
    for (let depth = 0; node instanceof HTMLElement && depth < 10; depth += 1) {
      if (node.matches("main, body, html")) break;
      let matchesCandidate = false;
      try {
        matchesCandidate = node.matches(adapter.candidateSelectors.join(","));
      } catch {
        matchesCandidate = false;
      }
      const strongRoot = node.matches(strongRootSelector);
      const hasItemLink = Boolean(itemSelector && node.querySelector(itemSelector));
      const hasMetadata = Boolean(metadataSelector && node.querySelector(metadataSelector));
      const isNarrowPlayer = node.matches("[data-e2e='video-player'], #player, #movie_player");
      const score = (strongRoot ? 120 : 0)
        + (matchesCandidate ? 50 : 0)
        + (hasItemLink ? 35 : 0)
        + (hasMetadata ? 20 : 0)
        - (isNarrowPlayer ? 90 : 0)
        - depth;
      if (score > bestScore && (matchesCandidate || strongRoot || hasItemLink || hasMetadata)) {
        best = node;
        bestScore = score;
      }
      node = node.parentElement;
    }
    if (best instanceof HTMLElement && best !== document.body && best !== document.documentElement) return best;
    if (OrislopPlatformAdapters.isItemHref(platform, window.location.href)) {
      let currentRoot = video.parentElement;
      let currentNode = video.parentElement;
      for (let depth = 0; currentNode instanceof HTMLElement && depth < 6; depth += 1) {
        if (currentNode.matches("main, body, html")) break;
        const rect = currentNode.getBoundingClientRect();
        const bounded = rect.width <= window.innerWidth * 1.25 && rect.height <= window.innerHeight * 1.8;
        if (bounded && cleanText(currentNode.textContent, 600).length >= 20) currentRoot = currentNode;
        currentNode = currentNode.parentElement;
      }
      return currentRoot || video.parentElement;
    }
    return video.parentElement;
  }

  function safeQueryAll(root, selectors) {
    if (!root?.querySelectorAll || !Array.isArray(selectors) || selectors.length === 0) return [];
    try {
      return Array.from(root.querySelectorAll(selectors.join(",")));
    } catch {
      return [];
    }
  }

  function isPlatformCandidate(element) {
    const platform = currentPlatform();
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return false;
    const hasItemLink = safeQueryAll(element, adapter.itemLinkSelectors)
      .some((link) => OrislopPlatformAdapters.isItemHref(platform, link.getAttribute?.("href")));
    return platform === "youtube"
      || (platform === "linkedin" && isLinkedInProfilePage() && element.matches("main"))
      || hasItemLink
      || Boolean(element.querySelector("video"));
  }

  function isInViewport(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 40 && rect.height > 30 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function scanPriorityForElement(element, current = false) {
    if (current) return 0;
    if (!(element instanceof HTMLElement)) return 100;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 40 || rect.height <= 30) return 90;
    if (rect.bottom > 0 && rect.top < window.innerHeight) return 1;
    const viewport = Math.max(1, window.innerHeight || 1);
    const distance = rect.top >= viewport ? rect.top - viewport : Math.abs(rect.bottom);
    return 10 + Math.min(70, Math.floor(distance / viewport) * 10);
  }

  function extractCandidate(element, platformOverride = "", forceCurrent = false) {
    const platform = platformOverride || currentPlatform();
    const activeVideo = forceCurrent ? findVisibleVideo(document, true) : null;
    const link = findItemLink(element, platform);
    const currentElement = forceCurrent || isLikelyCurrentElement(element);
    const fallbackUrl = currentElement
      || (platform === "linkedin" && isLinkedInProfilePage() && element.matches("main"))
      ? window.location.href
      : "";
    const currentItemUrl = forceCurrent && OrislopPlatformAdapters.isItemHref(platform, window.location.href)
      ? window.location.href
      : "";
    const parsed = OrislopClassifier.parsePlatformUrl(currentItemUrl || link || fallbackUrl, platform, element.dataset.videoId || element.getAttribute("data-video-id") || "");
    const channelName = findCreator(element, platform);
    const title = findTitle(element, platform, channelName);
    const visibleText = collectScopedText(element, platform, title, channelName);
    const transcriptText = collectTranscriptText(element, platform);
    const mediaUrl = findMediaUrl(element, platform, currentElement);
    const previewUrl = findPreviewUrl(element, platform);
    const visibleVideo = activeVideo || findVisibleVideo(element) || (currentElement ? findVisibleVideo(document, true) : null);
    const mediaIdentity = [
      link,
      fallbackUrl,
      mediaUrl,
      visibleVideo?.currentSrc,
      visibleVideo?.src,
      visibleVideo?.poster,
      previewUrl,
      title,
      channelName,
      visibleText
    ].map((value) => cleanText(value, 4000)).filter(Boolean).join("|");
    const itemId = parsed.itemId || stableHash(mediaIdentity);
    const itemKey = `${platform}:${itemId}`;
    const mediaType = visibleVideo ? "video" : previewUrl ? "image" : "text";
    const imageText = collectImageText(element, platform);
    const fullVideoAnalysisRequested = platform !== "linkedin"
      || mediaType !== "video"
      || openedLinkedInVideoKeys.has(itemKey)
      || (visibleVideo && (!visibleVideo.paused || Number(visibleVideo.currentTime) > 0));
    const forceHeavyAnalysis = mediaType === "video";
    return {
      platform,
      itemId,
      itemKey,
      url: parsed.normalizedUrl || link || fallbackUrl || window.location.href,
      title,
      channelName,
      visibleText,
      transcriptText,
      imageText,
      language: String(document.documentElement.lang || navigator.language || "unknown").toLowerCase().slice(0, 20),
      mediaUrl,
      previewUrl,
      mediaType,
      fullVideoAnalysisRequested,
      forceHeavyAnalysis,
      learnedBrainrotTerms: [...learnedBrainrotTerms].slice(0, 64),
      durationSeconds: findDurationSeconds(element, visibleVideo),
      playbackPositionSeconds: readPlaybackPosition(visibleVideo),
      itemKind: parsed.itemKind
    };
  }

  function collectImageText(element, platform) {
    if (platform !== "linkedin") return "";
    const values = [];
    for (const image of safeQueryAll(element, ["img[alt]", "figure [aria-label]", "[data-test-id*='image'] [aria-label]"]).slice(0, 12)) {
      for (const value of [image.getAttribute?.("alt"), image.getAttribute?.("aria-label")]) {
        const text = cleanText(value, 700);
        if (text && !/^(?:image|photo|profile photo|view image)$/i.test(text)) values.push(text);
      }
    }
    return cleanText(Array.from(new Set(values)).join(" "), 1800);
  }

  function findMediaUrl(element, platform = currentPlatform(), forceCurrent = false) {
    const currentElement = forceCurrent || isLikelyCurrentElement(element);
    const currentVideo = currentElement ? findVisibleVideo(document, true) : null;
    const localVideo = findVisibleVideo(element);
    for (const video of [currentVideo, localVideo]) {
      if (!video) continue;
      const candidates = [
        video.currentSrc,
        video.src,
        video.getAttribute("src"),
        video.getAttribute("data-src"),
        video.querySelector("source[src]")?.src,
        video.querySelector("source[src]")?.getAttribute("src")
      ];
      for (const value of candidates) {
        const direct = cleanText(value, 4000);
        if (isSupportedDirectMediaUrl(direct)) return direct;
      }
    }
    return currentElement ? findRecentDirectMediaResource(platform) : "";
  }

  function findRecentDirectMediaResource(platform) {
    if (typeof globalThis.performance?.getEntriesByType !== "function") return "";
    const expectedHost = platform === "youtube" ? ".googlevideo.com"
      : platform === "instagram" ? [".cdninstagram.com", ".fbcdn.net"]
        : platform === "tiktok" ? [".tiktokcdn.com", ".tiktokv.com", ".muscdn.com", ".akamaized.net"]
          : [];
    const allowedHosts = Array.isArray(expectedHost) ? expectedHost : [expectedHost];
    return globalThis.performance.getEntriesByType("resource")
      .slice(-500)
      .map((entry) => {
        const direct = cleanText(entry?.name, 4000);
        if (!isSupportedDirectMediaUrl(direct)) return null;
        try {
          const url = new URL(direct);
          if (allowedHosts.length > 0 && !allowedHosts.some((suffix) => url.hostname.toLowerCase().endsWith(suffix))) return null;
          const mime = decodeURIComponent(url.searchParams.get("mime") || "").toLowerCase();
          if (mime.startsWith("audio/")) return null;
          const initiator = String(entry?.initiatorType || "").toLowerCase();
          let score = Number(entry?.startTime || 0) / 1000000;
          if (mime.startsWith("video/")) score += 1000;
          if (/\.(?:mp4|webm)(?:$|[?#])/i.test(url.pathname + url.search)) score += 500;
          if (["video", "media"].includes(initiator)) score += 250;
          if (/\/videoplayback(?:$|[?#])/i.test(url.pathname + url.search)) score += 100;
          return { direct, score };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)[0]?.direct || "";
  }

  function isSupportedDirectMediaUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && [
        ".googlevideo.com", ".cdninstagram.com", ".fbcdn.net", ".tiktokcdn.com",
        ".tiktokv.com", ".muscdn.com", ".akamaized.net", ".licdn.com"
      ].some((suffix) => host.endsWith(suffix));
    } catch {
      return false;
    }
  }

  function findPreviewUrl(element, platform = currentPlatform()) {
    const visibleVideo = findVisibleVideo(element);
    const values = [
      visibleVideo?.poster,
      visibleVideo?.getAttribute?.("poster")
    ];
    const imageSelectors = platform === "linkedin"
      ? [
        ".update-components-image__image[src]",
        ".feed-shared-image__image[src]",
        "[data-test-id*='image'] img[src]",
        "figure img[src]",
        "img[src]"
      ]
      : ["img[src]", "img[data-src]"];
    const images = safeQueryAll(element, imageSelectors)
      .filter((image) => {
        if (platform !== "linkedin") return true;
        const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
        const width = Math.max(
          Number(image.naturalWidth) || 0,
          Number(rect.width) || 0,
          Number(image.getAttribute?.("width")) || 0
        );
        const height = Math.max(
          Number(image.naturalHeight) || 0,
          Number(rect.height) || 0,
          Number(image.getAttribute?.("height")) || 0
        );
        const alt = cleanText(image.getAttribute?.("alt"), 200);
        return width >= 240 && height >= 120 && !/profile photo|avatar/i.test(alt);
      })
      .slice(0, 12);
    for (const image of images) {
      values.push(image.currentSrc, image.src, image.getAttribute("src"), image.getAttribute("data-src"));
    }
    for (const value of values) {
      const preview = cleanText(value, 4000);
      if (isSupportedPreviewUrl(preview)) return preview;
    }
    return "";
  }

  function isSupportedPreviewUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && [
        ".ytimg.com", ".cdninstagram.com", ".fbcdn.net", ".tiktokcdn.com",
        ".tiktokcdn-us.com", ".tiktokcdn-eu.com", ".byteimg.com", ".muscdn.com",
        ".akamaized.net", ".licdn.com"
      ].some((suffix) => host.endsWith(suffix));
    } catch {
      return false;
    }
  }

  function findItemLink(element, platform) {
    const adapter = OrislopPlatformAdapters.get(platform);
    const anchor = safeQueryAll(element, adapter?.itemLinkSelectors || [])
      .find((item) => OrislopPlatformAdapters.isItemHref(platform, item.getAttribute?.("href")));
    if (!anchor && platform === "linkedin") {
      const urn = cleanText(
        element.getAttribute?.("data-urn")
          || element.getAttribute?.("data-id")
          || element.querySelector?.("[data-urn^='urn:li:activity:']")?.getAttribute?.("data-urn")
          || element.querySelector?.("[data-id^='urn:li:activity:']")?.getAttribute?.("data-id"),
        180
      );
      const activity = urn.match(/urn:li:activity:([a-zA-Z0-9_-]+)/)?.[1];
      if (activity) return `https://www.linkedin.com/feed/update/urn:li:activity:${activity}/`;
    }
    if (!anchor) return "";
    try {
      return new URL(anchor.getAttribute("href") || "", window.location.origin).href;
    } catch {
      return "";
    }
  }

  function findTitle(element, platform, channelName = "") {
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return "";
    if (platform === "youtube") {
      for (const selector of adapter.titleSelectors) {
        const node = element.querySelector(selector);
        const text = cleanText(node?.getAttribute?.("title") || node?.textContent || "", 400);
        if (text.length >= 2) return text;
      }
      return cleanText(element.getAttribute("aria-label") || "", 400);
    }
    if (platform === "linkedin" && isLinkedInProfilePage() && element.matches("main")) {
      return cleanText(element.querySelector("h1")?.textContent || channelName || "LinkedIn profile", 400);
    }
    const values = [];
    for (const selector of adapter.titleSelectors) {
      for (const node of safeQueryAll(element, [selector]).slice(0, 12)) {
        values.push(node.textContent, node.getAttribute?.("title"), node.getAttribute?.("alt"), node.getAttribute?.("aria-label"));
      }
    }
    return OrislopPlatformAdapters.chooseCaption(values, channelName);
  }

  function findCreator(element, platform) {
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return "";
    const scopes = [element];
    if (platform === "youtube" && isLikelyCurrentElement(element)) scopes.push(document);
    for (const selector of adapter.creatorSelectors) {
      for (const scope of scopes) {
        for (const node of safeQueryAll(scope, [selector]).slice(0, 16)) {
          const text = cleanText(node?.textContent || node?.getAttribute?.("aria-label") || node?.getAttribute?.("content") || "", 240);
          const profile = OrislopPlatformAdapters.profileNameFromHref(platform, node?.getAttribute?.("href"));
          if (platform === "youtube" && text) return text;
          if (platform === "tiktok" && text && node.hasAttribute?.("data-e2e") && !OrislopPlatformAdapters.isSocialUiText(text)) {
            return text.replace(/^@/, "");
          }
          if (profile && text && !OrislopPlatformAdapters.isSocialUiText(text)) return text.replace(/^@/, "");
          if (profile) return profile;
        }
      }
    }
    return "";
  }

  function collectScopedText(element, platform, title, channelName) {
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return cleanText([title, channelName].filter(Boolean).join(" "), 1800);
    const pieces = [title, channelName];
    for (const node of safeQueryAll(element, adapter.textSelectors).slice(0, 32)) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest("nav, .orislop-decision-cover")) continue;
      for (const value of [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt")]) {
        const text = cleanText(value, 500);
        if (text && (platform === "youtube" || !OrislopPlatformAdapters.isSocialUiText(text))) pieces.push(text);
      }
    }
    return cleanText(Array.from(new Set(pieces)).join(" "), platform === "linkedin" ? 3600 : 1800);
  }

  function collectTranscriptText(element, platform) {
    const adapter = OrislopPlatformAdapters.get(platform);
    if (!adapter) return "";
    const local = safeQueryAll(element, adapter.transcriptSelectors).slice(0, 30);
    const globalCurrent = isLikelyCurrentElement(element) && platform === "youtube"
      ? Array.from(document.querySelectorAll(".ytp-caption-segment")).slice(0, 20)
      : [];
    return cleanText([...local, ...globalCurrent]
      .map((node) => cleanText(node.textContent || node.getAttribute?.("aria-label") || "", 400))
      .filter((text) => text && (platform === "youtube" || !OrislopPlatformAdapters.isSocialUiText(text)))
      .join(" "), 1800);
  }

  function findDurationSeconds(element, visibleVideo = findVisibleVideo(element)) {
    const videoDuration = Number(visibleVideo?.duration);
    if (Number.isFinite(videoDuration) && videoDuration > 0) return Math.round(videoDuration);
    const node = element.querySelector("ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text, [aria-label*='minute'], [aria-label*='second']");
    const value = cleanText(node?.textContent || node?.getAttribute?.("aria-label") || "", 80);
    const clock = value.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0);
    return null;
  }

  function readPlaybackPosition(video) {
    const currentTime = Number(video?.currentTime);
    return Number.isFinite(currentTime) && currentTime >= 0 ? Math.round(currentTime) : 0;
  }

  function createSignature(candidate) {
    return stableHash([
      candidate.itemKey,
      candidate.title,
      candidate.channelName,
      candidate.visibleText,
      candidate.transcriptText,
      candidate.imageText,
      candidate.mediaType,
      candidate.fullVideoAnalysisRequested ? "opened" : "preview",
      candidate.forceHeavyAnalysis ? "forced-heavy" : "normal-scan"
    ].join("|"));
  }

  async function scoreCandidates(candidates) {
    if (candidates.length === 0) return [];
    const results = candidates.map(scoreOneCandidate);
    const ollamaJobs = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => results[index].hardAiSynthetic !== true);
    if (ollamaJobs.length === 0) return results;
    try {
      const response = await sendRuntimeMessage({
        type: "orislop.scoreBatch",
        candidates: ollamaJobs.map(({ candidate }) => candidate).slice(0, SCORE_BATCH_SIZE),
        settings: {
          ollamaModel: settingsCache.ollamaModel,
          inferenceMode: settingsCache.inferenceMode,
          performanceMode: settingsCache.performanceMode,
          slopPreferences: settingsCache.slopPreferences
        }
      }, OLLAMA_RESPONSE_TIMEOUT_MS);
      if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || "Background scoring unavailable");
      void chrome.storage.local.set({
        [OLLAMA_STATUS_KEY]: {
          state: response.ollamaStatus || "unavailable",
          error: response.ollamaError || "",
          model: response.model || settingsCache.ollamaModel,
          checkedAt: new Date().toISOString()
        },
        [DETECTOR_STATUS_KEY]: {
          state: response.detectorStatus || "unavailable",
          error: response.detectorError || "",
          spatialModel: "gonnerthetooner/orislop-fusion",
          cloudMotionModel: "MusapYildiz/aegis-video-detector:motion-only",
          checkedAt: new Date().toISOString()
        },
        [FACT_CHECK_STATUS_KEY]: {
          state: response.factCheckStatus || "unavailable",
          error: response.factCheckError || "",
          checkedAt: new Date().toISOString()
        }
      });
      for (let index = 0; index < ollamaJobs.length; index += 1) {
        results[ollamaJobs[index].index] = response.results[index] || results[ollamaJobs[index].index];
      }
      return results;
    } catch (error) {
      void chrome.storage.local.set({
        [OLLAMA_STATUS_KEY]: {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          model: settingsCache.ollamaModel,
          checkedAt: new Date().toISOString()
        },
        [DETECTOR_STATUS_KEY]: {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          spatialModel: "gonnerthetooner/orislop-fusion",
          cloudMotionModel: "MusapYildiz/aegis-video-detector:motion-only",
          checkedAt: new Date().toISOString()
        },
        [FACT_CHECK_STATUS_KEY]: {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString()
        }
      });
      return results;
    }
  }

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Required inference scoring timed out"));
      }, timeoutMs);
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  function scoreOneCandidate(candidate) {
    const decision = OrislopClassifier.scoreCandidate({
      ...candidate,
      slopPreferences: settingsCache.slopPreferences
    });
    if (decision.hardAiSynthetic === true) void learnFromExplicitBrainrotTitle(candidate);
    return decision;
  }

  async function loadLearnedBrainrotState() {
    try {
      const result = await chrome.storage.local.get(LEARNED_BRAINROT_KEY);
      applyLearnedBrainrotState(result[LEARNED_BRAINROT_KEY]);
    } catch {
      // Learning is a fail-open enhancement and never blocks scanning.
    }
  }

  function applyLearnedBrainrotState(value) {
    learnedBrainrotTerms.clear();
    learnedBrainrotEvidence.clear();
    for (const term of Array.isArray(value?.terms) ? value.terms.slice(0, 64) : []) {
      const cleanTerm = normalizeLearnedTerm(term);
      if (cleanTerm) learnedBrainrotTerms.add(cleanTerm);
    }
    const evidence = value?.evidence && typeof value.evidence === "object" ? value.evidence : {};
    for (const [term, hashes] of Object.entries(evidence).slice(0, 128)) {
      const cleanTerm = normalizeLearnedTerm(term);
      if (!cleanTerm) continue;
      learnedBrainrotEvidence.set(cleanTerm, new Set((Array.isArray(hashes) ? hashes : [])
        .map((hash) => cleanText(hash, 32))
        .filter(Boolean)
        .slice(0, 6)));
    }
  }

  async function learnFromExplicitBrainrotTitle(candidate) {
    const terms = extractLearnableBrainrotTerms(candidate?.title);
    if (terms.length === 0 || !candidate?.itemKey) return;
    const evidenceHash = stableHash(candidate.itemKey);
    let changed = false;
    for (const term of terms) {
      const hashes = learnedBrainrotEvidence.get(term) || new Set();
      if (hashes.has(evidenceHash)) continue;
      hashes.add(evidenceHash);
      while (hashes.size > 6) hashes.delete(hashes.values().next().value);
      learnedBrainrotEvidence.set(term, hashes);
      if (hashes.size >= 2 && !learnedBrainrotTerms.has(term)) learnedBrainrotTerms.add(term);
      changed = true;
    }
    if (!changed) return;
    const evidence = Object.fromEntries([...learnedBrainrotEvidence.entries()]
      .slice(-128)
      .map(([term, hashes]) => [term, [...hashes]]));
    await chrome.storage.local.set({
      [LEARNED_BRAINROT_KEY]: {
        version: 1,
        terms: [...learnedBrainrotTerms].slice(-64),
        evidence,
        updatedAt: new Date().toISOString()
      }
    });
  }

  function extractLearnableBrainrotTerms(title) {
    const normalized = cleanText(title, 400).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    if (!/\b(?:italian\s+)?brain\s*ro+t\b|#italianbrainro+t\b/.test(normalized)) return [];
    if (/\b(?:what\s+is|why|explains?|explained|analysis|history|science|research|documentary|essay|critique|meaning|study)\b/.test(normalized)) return [];
    const ignored = new Set(["italian", "brainrot", "brainroot", "animation", "animations", "generated", "character", "characters", "stories", "compilation", "tutorial", "youtube", "shorts", "official", "emotional"]);
    return Array.from(new Set((normalized.match(/[a-z]{8,32}/g) || [])
      .map(normalizeLearnedTerm)
      .filter((term) => term && !ignored.has(term)))).slice(0, 6);
  }

  function normalizeLearnedTerm(value) {
    const term = cleanText(value, 40).toLowerCase().replace(/[^a-z]/g, "");
    return /^[a-z]{8,32}$/.test(term) ? term : "";
  }

  function showPreScanCover(element, candidate, current = isCurrentCandidate(element, candidate)) {
    const host = findMediaHost(element, candidate);
    if (!(host instanceof HTMLElement) || host.querySelector(":scope > .orislop-decision-cover")) return;
    const existing = host.querySelector(":scope > .orislop-prescan-cover");
    if (existing?.dataset.itemKey === candidate.itemKey) return;
    if (existing?.dataset.itemKey) releaseSuppressedPlayback(existing.dataset.itemKey, false);
    existing?.remove();
    host.classList.add("orislop-decision-host");
    const cover = document.createElement("section");
    cover.className = "orislop-prescan-cover";
    cover.dataset.itemKey = candidate.itemKey;
    cover.setAttribute("role", "status");
    cover.setAttribute("aria-live", "polite");
    const label = document.createElement("strong");
    label.textContent = "Checking…";
    const detail = document.createElement("small");
    detail.textContent = "One moment.";
    cover.append(label, detail);
    host.prepend(cover);
  }

  function hasTranscriptForOllama(candidate) {
    const text = [
      candidate.title,
      candidate.channelName,
      candidate.visibleText,
      candidate.transcriptText,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return text.length >= 12;
  }

  function applyDecision(element, candidate, decision) {
    if (candidate.platform === "linkedin") {
      clearDecisionUi(element, candidate.itemKey);
      restoreAutomaticallyHiddenItem(element, candidate);
      releaseSuppressedPlayback(candidate.itemKey, true);
      if (decision.recommendation === "skip" && decision.detectorStatus !== "provisional") {
        void saveFlaggedRecord(candidate, decision);
      }
      showLinkedInTrustControl(element, candidate, decision);
      return;
    }
    if (decision.recommendation !== "skip" || decisionCache.isAllowed(candidate.itemKey)) {
      clearDecisionUi(element, candidate.itemKey);
      restoreAutomaticallyHiddenItem(element, candidate);
      releaseSuppressedPlayback(candidate.itemKey, true);
      return;
    }

    if (decision.detectorStatus !== "provisional") void saveFlaggedRecord(candidate, decision);
    if (isCurrentCandidate(element, candidate)) {
      const finalShortFormSkip = settingsCache.hideSkipped
        && decision.detectorStatus !== "provisional"
        && decision.hardFactContradiction !== true
        && decision.factCheckDecision?.verdict !== "contradicted"
        && (candidate.platform !== "youtube" || candidate.itemKind === "short" || /\/shorts\//.test(candidate.url));
      if (finalShortFormSkip && !advancedItemKeys.has(candidate.itemKey)) {
        const advanced = OrislopPlatformAdapters.advanceOne(candidate.platform, document, element);
        if (advanced) {
          advancedItemKeys.add(candidate.itemKey);
          clearDecisionUi(element, candidate.itemKey);
          clearExplanationUi(candidate.itemKey);
          releaseSuppressedPlayback(candidate.itemKey, false);
          void saveSkippedRecord(candidate, decision, "hidden_before_view");
        } else {
          showDecisionCover(element, candidate, decision);
          void saveSkippedRecord(candidate, decision, "blocked_current");
        }
      } else {
        if (advancedItemKeys.has(candidate.itemKey)) restoreAutomaticallyHiddenItem(element, candidate);
        showDecisionCover(element, candidate, decision);
      }
    } else if (settingsCache.hideSkipped) {
      hideElement(element, candidate, decision, false);
    } else {
      showDecisionCover(element, candidate, decision);
    }
  }

  function simpleDecisionReason(decision = {}) {
    const raw = [
      ...(Array.isArray(decision.reasons) ? decision.reasons : []),
      decision.detectorDecision?.reason,
      decision.ollamaDecision?.reason,
      decision.factCheckDecision?.reason
    ].filter(Boolean).join(" ").toLowerCase();

    if (decision.hardEngagementBait === true
      || /subscriber solicitation|engagement bait|subscribe|like begging|follow for/.test(raw)) {
      return "Asks for likes, follows, or subscribers.";
    }
    if (decision.hardFinanceSlop === true
      || /dropshipping|get-rich|finance funnel|passive income|money fast/.test(raw)) {
      return "Promotes a get-rich-quick scheme.";
    }
    if (decision.hardAiSynthetic === true
      || decision.visualAiSynthetic === true
      || /ai.generated|synthetic|deepfake|ai video|ai voice|cloned voice/.test(raw)) {
      return "Looks AI-generated.";
    }
    if (decision.hardMovieSceneRepost === true
      || /repost|recycled|stolen|low originality|movie.*scene|clip dump/.test(raw)) {
      return "Looks reused or low-originality.";
    }
    if (/reddit|text.story|story farm/.test(raw)) return "Looks like a recycled story format.";
    if (decision.hardFactContradiction === true
      || /misleading|contradict|unsupported claim|exaggerat/.test(raw)) {
      return "May contain a misleading claim.";
    }
    if (["unavailable", "error"].includes(decision.detectorStatus)
      || /failed|unavailable|no direct media|could not|timed out|not enough evidence/.test(raw)) {
      return "Could not verify this video.";
    }
    return "Matches your filters.";
  }

  function showDecisionCover(element, candidate, decision) {
    const host = findMediaHost(element, candidate);
    if (!(host instanceof HTMLElement)) return;
    suppressPlayback(host, candidate.itemKey);
    const existing = host.querySelector(":scope > .orislop-decision-cover, :scope > .orislop-prescan-cover");
    const state = decision.detectorStatus === "provisional" ? "verifying" : "hidden";
    const reasonText = state === "verifying" ? "Giving it a closer look." : simpleDecisionReason(decision);
    const renderKey = JSON.stringify([state, candidate.title || "", reasonText]);
    if (existing?.classList.contains("orislop-decision-cover")
      && existing.dataset.itemKey === candidate.itemKey
      && existing.dataset.renderKey === renderKey) return;
    if (existing?.dataset.itemKey && existing.dataset.itemKey !== candidate.itemKey) {
      releaseSuppressedPlayback(existing.dataset.itemKey, false);
    }
    existing?.remove();
    clearExplanationUi(candidate.itemKey);
    host.classList.add("orislop-decision-host");

    const cover = document.createElement("section");
    cover.className = "orislop-decision-cover";
    cover.dataset.itemKey = candidate.itemKey;
    cover.dataset.state = state;
    cover.dataset.renderKey = renderKey;
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-label", "Content filtered by Orislop");
    cover.setAttribute("aria-live", "polite");

    const verdict = document.createElement("strong");
    verdict.textContent = state === "verifying" ? "Checking…" : "Filtered";
    const title = document.createElement("p");
    title.textContent = candidate.title || `${capitalize(candidate.platform)} video`;
    const reason = document.createElement("small");
    reason.textContent = reasonText;
    const actions = document.createElement("div");
    const sourceLinks = createFactSourceLinks(decision);
    const keepButton = document.createElement("button");
    keepButton.type = "button";
    keepButton.textContent = "Show";
    keepButton.dataset.variant = "primary";
    keepButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      decisionCache.allow(candidate.itemKey);
      advancedItemKeys.delete(candidate.itemKey);
      element.setAttribute(PROCESSED_ATTR, "allowed");
      clearDecisionUi(element, candidate.itemKey);
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      releaseSuppressedPlayback(candidate.itemKey, true);
      const cloudDecisionId = decision?.detectorDecision?.decisionId || decision?.decisionId;
      if (cloudDecisionId) {
        void sendRuntimeMessage({
          type: "orislop.cloudFeedback",
          decisionId: cloudDecisionId,
          kind: "reveal",
          note: "User selected Show from the reversible filtered-content cover"
        }, 8000).catch(() => {});
      }
    });
    const skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.textContent = "Hide";
    skipButton.dataset.variant = "quiet";
    skipButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cover.remove();
      hideElement(element, candidate, decision, true);
    });
    actions.append(keepButton, skipButton);
    cover.append(verdict, title, reason);
    if (sourceLinks) cover.append(sourceLinks);
    cover.append(actions);
    host.prepend(cover);
  }

  function explanationModeForDecision(decision) {
    return decision?.hardFactContradiction === true || decision?.factCheckDecision?.verdict === "contradicted"
      ? "why_wrong"
      : "explain";
  }

  function showLinkedInTrustControl(element, candidate, decision) {
    if (!(element instanceof HTMLElement)) return;
    for (const existing of element.querySelectorAll(":scope > .orislop-linkedin-trust-button")) existing.remove();
    element.classList.add("orislop-linkedin-trust-host");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "orislop-linkedin-trust-button";
    button.dataset.itemKey = candidate.itemKey;
    button.dataset.verdict = linkedInTrustState(candidate, decision);
    button.textContent = linkedInTrustLabel(candidate, decision);
    button.setAttribute("aria-label", `${button.textContent}. Open Orislop analysis.`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestVideoExplanation(element, candidate, decision, explanationModeForDecision(decision));
    });
    element.append(button);
  }

  function linkedInTrustState(candidate, decision) {
    if (decision?.factCheckDecision?.verdict === "contradicted") return "contradicted";
    if (candidate?.mediaType === "video"
      && candidate?.fullVideoAnalysisRequested !== true
      && decision?.detectorStatus === "deferred_until_open") return "video-deferred";
    if (decision?.aiWritingLikely === true) return "ai-writing";
    if (candidate?.mediaType === "image" && decision?.visualAiSynthetic === true) return "synthetic-image";
    if (decision?.hardAiSynthetic === true) return "ai-content";
    if (decision?.factCheckDecision?.verdict === "supported") return "supported";
    if (decision?.factCheckStatus === "pending") return "checking";
    return "ready";
  }

  function linkedInTrustLabel(candidate, decision) {
    const state = linkedInTrustState(candidate, decision);
    if (state === "contradicted") return "Claim contradicted";
    if (state === "ai-writing") return "Likely AI-written";
    if (state === "synthetic-image") return "Likely synthetic image";
    if (state === "ai-content") return "AI-generated content";
    if (state === "video-deferred") return "Video check on open";
    if (state === "supported") return "Claims supported";
    if (state === "checking") return "Checking claims…";
    return candidate?.itemKind === "profile" ? "Check profile claims" : "Explain & check post";
  }

  async function requestVideoExplanation(host, candidate, decision, mode) {
    if (!(host instanceof HTMLElement)) return;
    for (const existing of host.querySelectorAll(":scope > .orislop-explanation-panel")) existing.remove();
    host.classList.add("orislop-explain-host");

    const panel = document.createElement("section");
    panel.className = "orislop-explanation-panel";
    panel.dataset.itemKey = candidate.itemKey;
    panel.setAttribute("role", "dialog");
    const contentLabel = candidate.platform === "linkedin"
      ? candidate.itemKind === "profile" ? "profile" : "post"
      : "video";
    panel.setAttribute("aria-label", mode === "why_wrong" ? "Why Orislop says this claim is wrong" : `${capitalize(contentLabel)} explanation`);
    panel.setAttribute("aria-live", "polite");
    panel.tabIndex = -1;
    installExplanationDismissal(panel, host);
    if (candidate.platform !== "linkedin") {
      renderExplanationHeader(panel, "Chat about this video", host);
      appendTranscriptNotice(panel, {
        source: candidate.transcriptText ? "platform_captions" : "none",
        generated: false
      });
      appendVideoContext(
        panel,
        cleanText([candidate.title, candidate.visibleText, candidate.transcriptText].filter(Boolean).join(" — "), 1800)
          || "Only limited context is available for this video."
      );
      const sourceLinks = createExplanationSourceLinks(decision?.factCheckDecision?.sources);
      if (sourceLinks) panel.append(sourceLinks);
      appendFactCheckChat(panel, candidate, decision, false, true);
      host.append(panel);
      return;
    }
    renderExplanationHeader(panel, mode === "why_wrong" ? "Checking the evidence..." : "Explaining this video...", host);
    const loading = document.createElement("p");
    loading.className = "orislop-explanation-loading";
      loading.textContent = candidate.platform === "linkedin"
        ? "Reading the available post and source context…"
        : "Reading the available video context…";
    panel.append(loading);
    host.append(panel);

    try {
      const response = await sendRuntimeMessage({
        type: "orislop.explainVideo",
        candidate,
        decision,
        mode,
        settings: {
          ollamaModel: settingsCache.ollamaModel,
          inferenceMode: settingsCache.inferenceMode,
          performanceMode: settingsCache.performanceMode
        }
      }, 185000);
      if (!panel.isConnected) return;
      if (!response?.ok) throw new Error(response?.error || "Explanation is temporarily unavailable.");
      renderExplanationResult(panel, response, host, candidate, decision);
    } catch (error) {
      if (!panel.isConnected) return;
      console.warn("Orislop explanation failed", error);
      renderExplanationHeader(panel, "Explanation unavailable", host);
      const message = document.createElement("p");
      message.className = "orislop-explanation-error";
      message.textContent = "Explanation is temporarily unavailable. Try again in a moment.";
      panel.append(message);
    }
  }

  function renderExplanationResult(panel, response, host, candidate, decision) {
    panel.replaceChildren();
    renderExplanationHeader(panel, response.heading || "Plain-language explanation", host);
    if (candidate.platform !== "linkedin") appendTranscriptNotice(panel, response.transcript);
    appendExplanationSection(
      panel,
      candidate.platform === "linkedin"
        ? candidate.itemKind === "profile" ? "What this profile claims" : "What this post is saying"
        : "What the video is saying",
      response.explanation
    );
    if (candidate.platform === "linkedin" && (response.imageText || candidate.imageText)) {
      appendExplanationSection(panel, "Text read from the image", response.imageText || candidate.imageText);
    }
    if (candidate.platform === "linkedin" && decision?.aiWritingDecision) {
      const writing = decision.aiWritingDecision;
      const verdict = writing.verdict === "likely_ai"
        ? `Likely AI-assisted (${Math.round(writing.confidence * 100)}% signal confidence).`
        : writing.verdict === "likely_human"
          ? "More consistent with human-authored writing."
          : "Writing origin is inconclusive.";
      appendExplanationSection(
        panel,
        "Writing-origin signal",
        `${verdict} ${writing.reason} This is a style estimate, not proof of who wrote it.`
      );
    }
    appendExplanationSection(
      panel,
      response.mode === "why_wrong" ? "Why Orislop says it is wrong" : "How Orislop judged it",
      response.decisionExplanation
    );
    appendExplanationSection(panel, "What Orislop cannot confirm", response.uncertainty);
    const sourceLinks = createExplanationSourceLinks(response.sources);
    if (sourceLinks) panel.append(sourceLinks);
    if ((response.mode === "why_wrong" && decision?.factCheckDecision?.verdict === "contradicted")
      || candidate.platform === "linkedin") {
      appendFactCheckChat(panel, candidate, decision, candidate.platform === "linkedin");
    }
  }

  function appendTranscriptNotice(panel, transcript) {
    const source = transcript?.source || "none";
    const notice = document.createElement("p");
    notice.className = `orislop-transcript-notice${transcript?.generated === true ? " is-generated" : ""}`;
    if (transcript?.generated === true) {
      const seconds = Number(transcript.analyzedSeconds) > 0 ? ` from ${Math.round(Number(transcript.analyzedSeconds))} seconds of audio` : " from the audio";
      const location = source === "generated_cloud_audio" ? "in Cloud Heavy" : "on this computer";
      notice.textContent = `Transcript generated ${location}${seconds}. It may contain speech-recognition mistakes.`;
    } else if (source === "platform_captions") {
      notice.textContent = "Explanation uses the available platform captions.";
    } else {
      notice.textContent = "No transcript was available; this explanation uses the title, on-screen text, and Orislop evidence.";
    }
    panel.append(notice);
  }

  function appendFactCheckChat(panel, candidate, decision, generalLinkedIn = false, generalVideo = false) {
    const section = document.createElement("section");
    section.className = "orislop-fact-chat";
    section.dataset.itemKey = candidate.itemKey;
    section.addEventListener("click", (event) => event.stopPropagation());
    section.addEventListener("keydown", (event) => event.stopPropagation());

    const heading = document.createElement("h4");
    heading.textContent = generalVideo ? "Ask about this video" : generalLinkedIn ? "Ask Orislop about this" : "Ask about this fact check";
    const helper = document.createElement("p");
    helper.className = "orislop-fact-chat-helper";
    helper.textContent = generalVideo
      ? "Answers stay grounded in the available video context."
      : generalLinkedIn
      ? "Answers stay grounded in this post or profile and the sources shown above."
      : "Answers use only the video text and the trusted sources shown above.";
    const messages = document.createElement("div");
    messages.className = "orislop-fact-chat-messages";
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");
    appendFactChatMessage(
      messages,
      "assistant",
      generalVideo
        ? "Ask for a summary or about a specific point."
        : generalLinkedIn
        ? "Ask for a simpler explanation, which claims are verified, or what remains unsupported."
        : "Ask what the sources say, what the video got wrong, or what remains uncertain."
    );

    const form = document.createElement("form");
    form.className = "orislop-fact-chat-form";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 400;
    input.autocomplete = "off";
    input.placeholder = generalVideo ? "Ask about this video..." : "Ask a follow-up question...";
    input.setAttribute("aria-label", generalVideo ? "Ask Orislop about this video" : "Ask Orislop about this fact check");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Ask";
    form.append(input, submit);
    section.append(heading, helper, messages, form);
    panel.append(section);
    panel.dataset.chatEnabled = "true";

    const history = [];
    let pending = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const question = cleanText(input.value, 400);
      if (pending || question.length < 2) return;
      pending = true;
      input.value = "";
      input.disabled = true;
      submit.disabled = true;
      submit.textContent = "Thinking...";
      appendFactChatMessage(messages, "user", question);
      const waiting = appendFactChatMessage(
        messages,
        "assistant",
        generalVideo ? "Reading the available video context..." : "Checking the cited evidence...",
        "",
        true
      );
      try {
        const response = await sendRuntimeMessage({
          type: generalLinkedIn ? "orislop.chatItem" : "orislop.chatVideo",
          candidate,
          decision,
          question,
          history,
          settings: {
            ollamaModel: settingsCache.ollamaModel,
            inferenceMode: settingsCache.inferenceMode,
            performanceMode: settingsCache.performanceMode
          }
        }, 185000);
        waiting.remove();
        if (!response?.ok) throw new Error(response?.error || "Chat is temporarily unavailable.");
        appendFactChatMessage(messages, "assistant", response.answer, response.uncertainty);
        history.push(
          { role: "user", content: question },
          { role: "assistant", content: cleanText(`${response.answer || ""} ${response.uncertainty || ""}`, 800) }
        );
        while (history.length > 6) history.shift();
      } catch (error) {
        waiting.remove();
        input.value = question;
        console.warn("Orislop chat failed", error);
        appendFactChatMessage(messages, "assistant", "Chat is temporarily unavailable. Try again in a moment.", "", true);
      } finally {
        pending = false;
        input.disabled = false;
        submit.disabled = false;
        submit.textContent = "Ask";
        input.focus();
        panel.scrollTop = panel.scrollHeight;
      }
    });
  }

  function appendFactChatMessage(host, role, text, uncertainty = "", temporary = false) {
    const message = document.createElement("article");
    message.className = `orislop-fact-chat-message orislop-fact-chat-message-${role}`;
    if (temporary) message.dataset.temporary = "true";
    const label = document.createElement("strong");
    label.textContent = role === "user" ? "You" : "Orislop";
    const body = document.createElement("p");
    body.textContent = cleanText(text, 1600);
    message.append(label, body);
    if (uncertainty) {
      const note = document.createElement("small");
      note.textContent = cleanText(uncertainty, 600);
      message.append(note);
    }
    host.append(message);
    host.scrollTop = host.scrollHeight;
    return message;
  }

  function renderExplanationHeader(panel, headingText, host) {
    panel.replaceChildren();
    const header = document.createElement("header");
    const brand = document.createElement("span");
    brand.textContent = "Orislop";
    const heading = document.createElement("strong");
    heading.textContent = headingText;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "orislop-explanation-close";
    close.textContent = "×";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close video chat");
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissExplanationPanel(panel, host);
    });
    header.append(brand, heading, close);
    panel.append(header);
  }

  function installExplanationDismissal(panel, host) {
    panel.dataset.openSequence = String(++explanationPanelSequence);
    const dismiss = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      panel.remove();
      cleanExplanationHost(host);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      const topmostPanel = [...document.querySelectorAll(".orislop-explanation-panel[data-open-sequence]")]
        .filter((candidate) => candidate.isConnected)
        .sort((left, right) => Number(right.dataset.openSequence) - Number(left.dataset.openSequence))[0];
      if (topmostPanel && topmostPanel !== panel) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    const onPointerDown = (event) => {
      const target = event.target;
      if (panel.contains(target)) return;
      if (target instanceof Element && target.closest(".orislop-explain-button, .orislop-cover-explain-button, .orislop-linkedin-trust-button")) return;
      dismiss();
    };
    panel.__orislopDismiss = dismiss;
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
  }

  function dismissExplanationPanel(panel, host) {
    if (typeof panel?.__orislopDismiss === "function") {
      panel.__orislopDismiss();
      return;
    }
    panel?.remove();
    cleanExplanationHost(host);
  }

  function appendVideoContext(panel, bodyText) {
    if (!bodyText) return;
    const details = document.createElement("details");
    details.className = "orislop-video-context";
    const summary = document.createElement("summary");
    summary.textContent = "Video context";
    const body = document.createElement("p");
    body.textContent = bodyText;
    details.append(summary, body);
    panel.append(details);
  }

  function appendExplanationSection(panel, labelText, bodyText) {
    if (!bodyText) return;
    const section = document.createElement("div");
    section.className = "orislop-explanation-section";
    const label = document.createElement("h4");
    label.textContent = labelText;
    const body = document.createElement("p");
    body.textContent = bodyText;
    section.append(label, body);
    panel.append(section);
  }

  function createExplanationSourceLinks(sources) {
    if (!Array.isArray(sources)) return null;
    const trusted = sources
      .map((source) => ({ ...source, safeUrl: trustedHttpsUrl(source?.url) }))
      .filter((source) => source?.trusted === true && source.safeUrl)
      .slice(0, 4);
    if (trusted.length === 0) return null;
    const section = document.createElement("div");
    section.className = "orislop-explanation-sources";
    const label = document.createElement("h4");
    label.textContent = "Sources checked";
    section.append(label);
    for (const source of trusted) {
      const link = document.createElement("a");
      link.href = source.safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.publisher || source.domain || source.title || "Source";
      link.addEventListener("click", (event) => event.stopPropagation());
      section.append(link);
    }
    return section;
  }

  function trustedHttpsUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function clearExplanationUi(itemKey = "") {
    for (const node of document.querySelectorAll(".orislop-explain-button, .orislop-linkedin-trust-button, .orislop-explanation-panel")) {
      if (itemKey && node.dataset.itemKey !== itemKey) continue;
      const host = node.parentElement;
      if (node.classList.contains("orislop-explanation-panel")) dismissExplanationPanel(node, host);
      else {
        node.remove();
        cleanExplanationHost(host);
      }
    }
  }

  function cleanExplanationHost(host) {
    if (host instanceof HTMLElement
      && !host.querySelector(":scope > .orislop-explain-button, :scope > .orislop-linkedin-trust-button, :scope > .orislop-explanation-panel")) {
      host.classList.remove("orislop-explain-host");
      host.classList.remove("orislop-linkedin-trust-host");
    }
  }

  function createFactSourceLinks(decision) {
    const sources = decision.factCheckDecision?.sources;
    if (!decision.factCheckUsed || !Array.isArray(sources) || sources.length === 0) return null;
    const host = document.createElement("div");
    host.className = "orislop-fact-sources";
    const label = document.createElement("span");
    const verdictLabels = {
      supported: "Sources support",
      contradicted: "Sources contradict",
      mixed: "Mixed evidence",
      insufficient: "Sources checked"
    };
    label.textContent = verdictLabels[decision.factCheckDecision?.verdict] || "Evidence";
    host.append(label);
    for (const source of sources.filter((item) => item?.trusted === true).slice(0, 3)) {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.publisher || source.domain || source.title || "Source";
      link.addEventListener("click", (event) => event.stopPropagation());
      host.append(link);
    }
    return host.childElementCount > 1 ? host : null;
  }

  function findMediaHost(element, candidate) {
    const current = isCurrentCandidate(element, candidate);
    if (current && candidate.platform === "youtube" && window.location.pathname === "/watch") {
      return document.querySelector("#movie_player, ytd-player") || element;
    }
    const video = (current ? findVisibleVideo(document, true) : null) || findVisibleVideo(element);
    if (video?.parentElement instanceof HTMLElement) {
      let host = video.parentElement;
      const videoRect = video.getBoundingClientRect();
      for (let depth = 0; host.parentElement instanceof HTMLElement && depth < 2; depth += 1) {
        const parent = host.parentElement;
        const parentRect = parent.getBoundingClientRect();
        const closeToVideo = parentRect.width <= Math.max(videoRect.width * 1.35, videoRect.width + 80)
          && parentRect.height <= Math.max(videoRect.height * 1.35, videoRect.height + 80);
        if (!closeToVideo || parent === element) break;
        host = parent;
      }
      return host;
    }
    const player = element.querySelector("#shorts-player, #player-container, ytd-player, [data-e2e='video-player']");
    if (player instanceof HTMLElement) return player;
    const thumbnail = element.querySelector("ytd-thumbnail, #thumbnail, a#thumbnail, [data-e2e='video-cover'], picture, img");
    if (thumbnail instanceof HTMLImageElement && thumbnail.parentElement instanceof HTMLElement) return thumbnail.parentElement;
    return thumbnail instanceof HTMLElement ? thumbnail : element;
  }

  function findVisibleVideo(root, requireVisible = false) {
    const videos = Array.from(root?.querySelectorAll?.("video") || []).filter((video) => video instanceof HTMLVideoElement);
    if (root instanceof HTMLVideoElement) videos.unshift(root);
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        const visibleArea = visibleWidth * visibleHeight;
        const area = Math.max(0, rect.width * rect.height);
        const centerDistance = Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2);
        const activeScore = !video.paused && !video.ended ? 2 : Number(video.currentTime) > 0 ? 1 : 0;
        return { video, visibleArea, area, centerDistance, activeScore, width: rect.width, height: rect.height };
      })
      .filter(({ video, visibleArea, width, height }) => !requireVisible
        || (video.isConnected !== false && visibleArea >= 10000 && width >= 120 && height >= 80))
      .sort((left, right) => right.activeScore - left.activeScore
        || right.visibleArea - left.visibleArea
        || left.centerDistance - right.centerDistance
        || right.area - left.area)[0]?.video || null;
  }

  function hideElement(element, candidate, decision, explicit) {
    clearDecisionUi(element, candidate.itemKey);
    clearExplanationUi(candidate.itemKey);
    const target = isCurrentCandidate(element, candidate) && candidate.platform === "youtube" && window.location.pathname === "/watch"
      ? findMediaHost(element, candidate)
      : element;
    if (!(target instanceof HTMLElement)) return;
    target.setAttribute(ITEM_KEY_ATTR, candidate.itemKey);
    target.classList.add("orislop-skip-hidden");
    target.dataset.orislopAutoHidden = explicit ? "false" : "true";
    if (isCurrentCandidate(element, candidate)) target.classList.add("orislop-current-item-hidden");
    suppressPlayback(target, candidate.itemKey);
    if (explicit || decision.detectorStatus !== "provisional") {
      void saveSkippedRecord(candidate, decision, explicit ? "user_skip" : "hidden_before_view");
    }
  }

  function restoreAutomaticallyHiddenItem(element, candidate) {
    const target = isCurrentCandidate(element, candidate) && candidate.platform === "youtube" && window.location.pathname === "/watch"
      ? findMediaHost(element, candidate)
      : element;
    if (!(target instanceof HTMLElement) || target.dataset.orislopAutoHidden !== "true") return;
    target.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
    delete target.dataset.orislopAutoHidden;
    releaseSuppressedPlayback(candidate.itemKey, true);
  }

  function clearDecisionUi(element, itemKey) {
    for (const cover of document.querySelectorAll(".orislop-decision-cover, .orislop-prescan-cover")) {
      if (!itemKey || cover.dataset.itemKey === itemKey) {
        const host = cover.parentElement;
        cover.remove();
        if (host && !host.querySelector(":scope > .orislop-decision-cover, :scope > .orislop-prescan-cover")) host.classList.remove("orislop-decision-host");
      }
    }
    if (element.classList.contains("orislop-decision-host") && !element.querySelector(":scope > .orislop-decision-cover, :scope > .orislop-prescan-cover")) {
      element.classList.remove("orislop-decision-host");
    }
  }

  function restoreAutomaticallyHiddenItems() {
    for (const element of document.querySelectorAll(".orislop-skip-hidden[data-orislop-auto-hidden='true']")) {
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      const itemKey = element.getAttribute(ITEM_KEY_ATTR);
      if (itemKey) releaseSuppressedPlayback(itemKey, true);
      delete element.dataset.orislopAutoHidden;
      element.removeAttribute(PROCESSED_ATTR);
      element.removeAttribute(SIGNATURE_ATTR);
    }
  }

  function restoreAllOrislopUi() {
    clearExplanationUi();
    for (const element of document.querySelectorAll(".orislop-skip-hidden")) {
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      const itemKey = element.getAttribute(ITEM_KEY_ATTR);
      if (itemKey) releaseSuppressedPlayback(itemKey, true);
      delete element.dataset.orislopAutoHidden;
    }
    for (const cover of document.querySelectorAll(".orislop-decision-cover, .orislop-prescan-cover")) {
      const host = cover.parentElement;
      if (cover.dataset.itemKey) releaseSuppressedPlayback(cover.dataset.itemKey, true);
      cover.remove();
      host?.classList.remove("orislop-decision-host");
    }
    releaseAllSuppressedPlayback(true);
    resetProcessedState();
  }

  function suppressPlayback(root, itemKey) {
    if (!itemKey) return;
    const tracked = suppressedMediaByItem.get(itemKey) || new Set();
    for (const media of collectMediaElements(root)) {
      if (!originalPlaybackState.has(media)) {
        originalPlaybackState.set(media, {
          muted: media.muted,
          volume: Number.isFinite(Number(media.volume)) ? Number(media.volume) : 1,
          wasPlaying: !media.paused && !media.ended
        });
      }
      media.dataset.orislopPlaybackBlocked = itemKey;
      tracked.add(media);
      media.muted = true;
      if (Number(media.volume) !== 0) media.volume = 0;
      media.pause?.();
    }
    if (tracked.size > 0) suppressedMediaByItem.set(itemKey, tracked);
  }

  function releaseSuppressedPlayback(itemKey, resume) {
    const tracked = suppressedMediaByItem.get(itemKey);
    if (!tracked) return;
    suppressedMediaByItem.delete(itemKey);
    for (const media of tracked) {
      const state = originalPlaybackState.get(media);
      if (!media?.isConnected || media.dataset.orislopPlaybackBlocked !== itemKey) continue;
      originalPlaybackState.delete(media);
      delete media.dataset.orislopPlaybackBlocked;
      media.muted = state?.muted ?? false;
      media.volume = state?.volume ?? 1;
      if (resume && state?.wasPlaying) void media.play?.().catch?.(() => {});
    }
  }

  function releaseAllSuppressedPlayback(resume) {
    for (const itemKey of Array.from(suppressedMediaByItem.keys())) releaseSuppressedPlayback(itemKey, resume);
  }

  function collectMediaElements(root) {
    const media = Array.from(root?.querySelectorAll?.("video, audio") || []);
    if (root instanceof HTMLMediaElement) media.unshift(root);
    return Array.from(new Set(media.filter((item) => item instanceof HTMLMediaElement)));
  }

  function enforcePlaybackSuppression(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || !media.dataset.orislopPlaybackBlocked) return;
    media.muted = true;
    if (Number(media.volume) !== 0) media.volume = 0;
    if (!media.paused) media.pause?.();
  }

  function resetProcessedState() {
    for (const element of document.querySelectorAll(`[${PROCESSED_ATTR}], [${SIGNATURE_ATTR}]`)) {
      if (element.getAttribute(PROCESSED_ATTR) === "allowed") continue;
      element.removeAttribute(PROCESSED_ATTR);
      element.removeAttribute(SIGNATURE_ATTR);
    }
  }

  function isCurrentCandidate(element, candidate) {
    const current = OrislopClassifier.parsePlatformUrl(window.location.href, currentPlatform());
    if (current.itemId && candidate.itemId === current.itemId) return true;
    return isLikelyCurrentElement(element);
  }

  function isLikelyCurrentElement(element) {
    if (element.matches("ytd-watch-metadata")) return window.location.pathname === "/watch";
    const platform = currentPlatform();
    const current = OrislopClassifier.parsePlatformUrl(window.location.href, platform);
    const linked = OrislopClassifier.parsePlatformUrl(findItemLink(element, platform), platform);
    if (current.itemId && linked.itemId && current.itemId === linked.itemId) return true;
    const rect = element.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const currentVideo = findVisibleVideo(document, true);
    if (currentVideo && (element === currentVideo || element.contains(currentVideo))) return true;
    const video = findVisibleVideo(element, true);
    const videoRect = video?.getBoundingClientRect();
    const videoCenter = videoRect ? videoRect.top + videoRect.height / 2 : center;
    return Boolean(video)
      && Math.max(rect.height, videoRect?.height || 0) >= window.innerHeight * 0.5
      && Math.abs(videoCenter - window.innerHeight / 2) < window.innerHeight * 0.38;
  }

  async function saveFlaggedRecord(candidate, decision) {
    if (!historyWriter) return;
    const id = `${candidate.itemKey}:skip`;
    await historyWriter.append(FLAGGED_KEY, {
      id,
      itemKey: candidate.itemKey,
      itemId: candidate.itemId,
      platform: candidate.platform,
      url: candidate.url,
      title: candidate.title || `${capitalize(candidate.platform)} video`,
      recommendation: "skip",
      score: decision.score,
      reasons: decision.reasons,
      sourceScores: decision.sourceScores || null,
      detectorDecision: decision.detectorDecision || null,
      factCheck: decision.factCheckDecision || null,
      createdAt: new Date().toISOString()
    }, (record) => record.id || `${record.itemKey}:skip`);
  }

  async function saveSkippedRecord(candidate, decision, mode) {
    if (!historyWriter) return;
    const id = `${candidate.itemKey}:${mode}`;
    if (loggedSkipKeys.has(id)) return;
    loggedSkipKeys.add(id);
    await historyWriter.append(SKIPPED_KEY, {
      id,
      itemKey: candidate.itemKey,
      itemId: candidate.itemId,
      platform: candidate.platform,
      url: candidate.url,
      title: candidate.title || `${capitalize(candidate.platform)} video`,
      mode,
      score: decision.score,
      reasons: decision.reasons,
      sourceScores: decision.sourceScores || null,
      detectorDecision: decision.detectorDecision || null,
      factCheck: decision.factCheckDecision || null,
      durationSeconds: normalizeDuration(candidate.durationSeconds),
      savedSeconds: calculateSavedSeconds(candidate, mode),
      createdAt: new Date().toISOString()
    }, (record) => record.id || `${record.itemKey}:${record.mode}`);
  }

  function calculateSavedSeconds(candidate, mode) {
    void candidate;
    void mode;
    return SAVED_SECONDS_PER_SKIP;
  }

  function normalizeDuration(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(12 * 60 * 60, Math.round(seconds)) : 0;
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      return normalizeSettings(result[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function normalizeSettings(value) {
    if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
      hideSkipped: typeof value.hideSkipped === "boolean"
        ? value.hideSkipped
        : typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideSkipped,
      ollamaModel: normalizeModelName(value.ollamaModel),
      inferenceMode: ["local", "hybrid", "cloud"].includes(value.inferenceMode) ? value.inferenceMode : DEFAULT_SETTINGS.inferenceMode,
      performanceMode: ["fast", "heavy"].includes(value.performanceMode) ? value.performanceMode : "auto",
      watchIntentComplete: true,
      slopPreferences: SLOP_PREFERENCE_API?.normalize(value.slopPreferences) || [...DEFAULT_SLOP_PREFERENCES]
    };
  }

  function normalizeModelName(value) {
    const model = String(value || "").trim();
    if (!model || model === LEGACY_OLLAMA_MODEL) return ORISLOP_OLLAMA_MODEL;
    return /^[a-zA-Z0-9._:/-]{1,100}$/.test(model) ? model : DEFAULT_SETTINGS.ollamaModel;
  }

  async function readList(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return Array.isArray(result[key]) ? result[key] : [];
    } catch {
      return [];
    }
  }

  function currentPlatform() {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    if (host.endsWith("tiktok.com")) return "tiktok";
    if (host.endsWith("linkedin.com")) return "linkedin";
    return "unknown";
  }

  function isLinkedInProfilePage() {
    return currentPlatform() === "linkedin" && /^\/(?:in|company)\/[^/?#]+/i.test(window.location.pathname);
  }

  function platformItemNoun(platform, count) {
    if (platform === "linkedin") return count === 1 ? "item" : "items";
    return count === 1 ? "video" : "videos";
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `generated-${(hash >>> 0).toString(36)}`;
  }

  function cleanText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function emptyScanProgress() {
    return {
      state: "starting",
      phase: "idle",
      loadedCount: 0,
      visibleCount: 0,
      fastCheckedCount: 0,
      fastElapsedMs: 0,
      fastWithinTarget: false,
      deepQueuedCount: 0,
      deepProcessedCount: 0,
      deepReadyCount: 0,
      deepPendingCount: 0,
      heavyP95Ms: 0,
      error: ""
    };
  }

  function capitalize(value) {
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Video";
  }
})();
