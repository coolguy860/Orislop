(() => {
  "use strict";

  const FLAGGED_KEY = "orislop.extension.flaggedLog";
  const SKIPPED_KEY = "orislop.extension.skippedLog";
  const SETTINGS_KEY = "orislop.extension.settings";
  const PROCESSED_ATTR = "data-orislop-processed";
  const SIGNATURE_ATTR = "data-orislop-signature";
  const ORIGINAL_DISPLAY_ATTR = "data-orislop-original-display";
  const STATUS_ID = "orislop-status-pill";
  const TOAST_ID = "orislop-autoskip-toast";
  const MAX_SCAN_PER_PASS = 90;
  const SCAN_DEBOUNCE_MS = 450;
  const AUTOSKIP_COOLDOWN_MS = 3200;
  const AUTOSKIP_DELAY_MS = 140;
  const LOOKAHEAD_LIMIT = 10;
  const WORKER_POOL_SIZE = 10;

  const DEFAULT_SETTINGS = {
    autoSkip: true,
    hideFeedCards: true
  };

  const CLICKBAIT = [
    "you won't believe",
    "you wont believe",
    "wait for it",
    "watch till the end",
    "watch until the end",
    "this changed everything",
    "nobody talks about this",
    "before they delete this",
    "do not skip",
    "part 2"
  ];
  const BRAINROT = [
    "brainrot",
    "minecraft parkour",
    "subway surfers",
    "satisfying background",
    "mobile game background",
    "reddit story",
    "askreddit",
    "text to speech",
    "tts",
    "ai voice",
    "viral clips",
    "compilation",
    "green screen",
    "greenscreen",
    "repost",
    "not mine",
    "credit unknown",
    "source unknown"
  ];
  const AI_TERMS = [
    "ai",
    "ai generated",
    "ai-generated",
    "artificial intelligence",
    "generative ai",
    "generated with ai",
    "made with ai",
    "created with ai",
    "synthetic voice",
    "synthetic content",
    "voice clone",
    "ai voiceover",
    "ai voice over",
    "ai cover",
    "ai song",
    "ai music",
    "deepfake",
    "sora generated",
    "ai image",
    "ai video"
  ];
  const PLATFORM_AI_DISCLOSURES = [
    "altered or synthetic content",
    "altered or synthetic",
    "includes altered or synthetic content",
    "this content is altered or synthetic",
    "created or altered with ai",
    "generated or altered with ai",
    "made with artificial intelligence",
    "synthetic content",
    "ai-generated content",
    "ai generated content"
  ];
  const ENGAGEMENT_BAIT = [
    "like and follow",
    "subscribe for more",
    "follow for more",
    "follow for part",
    "comment below",
    "tag someone",
    "share this with"
  ];

  const RULES = [
    { label: "YouTube AI/synthetic disclosure", weight: 74, test: (text) => includesAny(text, PLATFORM_AI_DISCLOSURES) },
    { label: "Clickbait wording", weight: 18, test: (text) => includesAny(text, CLICKBAIT) },
    { label: "Brainrot/slop format keywords", weight: 22, test: (text) => includesAny(text, BRAINROT) },
    { label: "Engagement bait language", weight: 16, test: (text) => includesAny(text, ENGAGEMENT_BAIT) },
    { label: "AI-generated content terms", weight: 34, test: (text) => hasAiSignal(text) },
    { label: "Excessive emoji pattern", weight: 10, test: (text) => emojiCount(text) >= 3 },
    { label: "Spammy capitalization or punctuation", weight: 12, test: (text) => /[!?]{3,}/.test(text) || allCapsWordCount(text) >= 3 },
    { label: "Repetitive title/caption", weight: 14, test: (text) => hasRepetition(text) },
    { label: "Low-information title", weight: 14, test: (_text, input) => isLowInformationTitle(input.title || "") },
    { label: "Shorts format signal", weight: 8, test: (_text, input) => parseYouTubeUrl(input.url).videoKind === "short" }
  ];

  let scanTimer = 0;
  let scanInFlight = false;
  let scanQueued = false;
  let backgroundScoringAvailable = true;
  let lastStatusText = "";
  const preSkipScores = new Map();
  let status = {
    seen: 0,
    rescored: 0,
    flagged: 0,
    hidden: 0,
    skipped: 0,
    workers: 0
  };
  let settingsCache = { ...DEFAULT_SETTINGS };
  let lastAutoSkip = {
    videoId: null,
    at: 0
  };

  boot();

  function boot() {
    ensureStatusPill();
    status.workers = WORKER_POOL_SIZE;
    void loadSettings().then((settings) => {
      settingsCache = settings;
      scheduleScan();
    });
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.addEventListener("yt-navigate-finish", scheduleScan, { passive: true });
    window.addEventListener("yt-page-data-updated", scheduleScan, { passive: true });
    window.addEventListener("scroll", scheduleScan, { passive: true });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[SETTINGS_KEY]) {
        settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
        scheduleScan();
      }
    });
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanVisibleYouTubeItems, SCAN_DEBOUNCE_MS);
  }

  async function scanVisibleYouTubeItems() {
    if (scanInFlight) {
      scanQueued = true;
      return;
    }

    scanInFlight = true;
    const candidates = findLookaheadCandidateElements();

    let rescoredThisPass = 0;
    let flaggedThisPass = 0;
    let hiddenThisPass = 0;
    const jobs = [];

    try {
      for (const element of candidates) {
        if (element.getAttribute(PROCESSED_ATTR) === "revealed") {
          continue;
        }

        const extracted = extractCandidate(element);
        if (!extracted.videoId && !extracted.title && extracted.visibleText.length < 12) {
          continue;
        }

        const pendingPreSkip = getCurrentPreSkipScore(element, extracted);
        if (pendingPreSkip) {
          preSkipScores.delete(extracted.videoId);
          element.setAttribute(PROCESSED_ATTR, "true");
          void saveFlaggedRecord(extracted, pendingPreSkip);
          void attemptAutoSkip(extracted, pendingPreSkip);
          flaggedThisPass += 1;
          continue;
        }

        const signature = createSignature(extracted);
        if (element.getAttribute(SIGNATURE_ATTR) === signature) {
          continue;
        }

        element.setAttribute(SIGNATURE_ATTR, signature);
        element.setAttribute(PROCESSED_ATTR, "true");
        rescoredThisPass += 1;
        jobs.push({ element, extracted });
      }

      const scores = await scoreWithWorkers(jobs.map((job) => job.extracted));

      for (let index = 0; index < jobs.length; index += 1) {
        const { element, extracted } = jobs[index];
        if (!element.isConnected || element.getAttribute(PROCESSED_ATTR) === "revealed") {
          continue;
        }
        const score = scores[index] || scoreOneCandidate(extracted);

        if (score.recommendation === "skip") {
          const isCurrentVideo = isCurrentVideoCandidate(element, extracted);
          if (isCurrentVideo && settingsCache.autoSkip) {
            showAutoSkipToast(extracted, score, "Orislop flagged this video. Skipping now.");
            void saveFlaggedRecord(extracted, score);
            void attemptAutoSkip(extracted, score);
          } else if (isCurrentVideo) {
            markQuestionable(element, extracted, score);
            void saveFlaggedRecord(extracted, score);
          } else if (isActiveShortsScrollerCandidate(element, extracted)) {
            rememberPreSkip(extracted, score);
            void saveFlaggedRecord(extracted, score);
            void saveSkippedRecord(extracted, score, "pre_skip");
          } else if (settingsCache.hideFeedCards) {
            hideWithShield(element, extracted, score);
            void saveSkippedRecord(extracted, score, "hidden_card");
            hiddenThisPass += 1;
          } else {
            markQuestionable(element, extracted, score);
          }
          flaggedThisPass += 1;
        } else if (score.recommendation === "questionable") {
          markQuestionable(element, extracted, score);
          void saveFlaggedRecord(extracted, score);
          flaggedThisPass += 1;
        } else {
          clearOrislopCallout(element);
        }
      }

      status = {
        seen: candidates.length,
        rescored: status.rescored + rescoredThisPass,
        flagged: status.flagged + flaggedThisPass,
        hidden: status.hidden + hiddenThisPass,
        skipped: status.skipped,
        workers: WORKER_POOL_SIZE
      };
    } finally {
      const shouldRescan = scanQueued;
      scanQueued = false;
      scanInFlight = false;
      renderStatusPill();
      if (shouldRescan) {
        scheduleScan();
      }
    }
  }

  function findCandidateElements() {
    const selectors = [
      "ytd-rich-item-renderer",
      "ytd-rich-grid-media",
      "ytd-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-playlist-panel-video-renderer",
      "ytd-reel-item-renderer",
      "ytd-reel-video-renderer",
      "yt-lockup-view-model",
      "yt-lockup-metadata-view-model",
      "ytm-rich-item-renderer",
      "ytm-video-with-context-renderer",
      "ytm-compact-video-renderer",
      "ytm-shorts-lockup-view-model",
      "ytd-watch-metadata",
      "ytd-shorts"
    ];
    const elements = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element) => element instanceof HTMLElement);
    return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
  }

  function findLookaheadCandidateElements() {
    const elements = findCandidateElements()
      .filter(isLookaheadCandidate)
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .slice(0, MAX_SCAN_PER_PASS);

    const current = parseYouTubeUrl(window.location.href);
    const currentElement = current.videoId
      ? elements.find((element) => extractCandidate(element).videoId === current.videoId)
      : null;
    const ordered = currentElement
      ? [currentElement, ...elements.filter((element) => element !== currentElement)]
      : elements;

    return ordered.slice(0, LOOKAHEAD_LIMIT);
  }

  function isLookaheadCandidate(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 40
      && rect.height > 30
      && rect.bottom >= -500
      && rect.top <= window.innerHeight + 4200;
  }

  async function scoreWithWorkers(candidates) {
    if (candidates.length === 0) {
      return [];
    }

    if (!backgroundScoringAvailable) {
      return candidates.map(scoreOneCandidate);
    }

    try {
      const response = await sendScoreBatchToBackground(candidates);
      if (!response?.ok || !Array.isArray(response.results)) {
        throw new Error(response?.error || "background scoring unavailable");
      }
      status.workers = Number.isFinite(response.workerCount) ? response.workerCount : WORKER_POOL_SIZE;
      backgroundScoringAvailable = true;
      return candidates.map((candidate, index) => response.results[index] || scoreOneCandidate(candidate));
    } catch {
      backgroundScoringAvailable = false;
      window.setTimeout(() => {
        backgroundScoringAvailable = true;
      }, 5000);
      status.workers = WORKER_POOL_SIZE;
      return candidates.map(scoreOneCandidate);
    }
  }

  function sendScoreBatchToBackground(candidates) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "orislop.scoreBatch",
        workerCount: WORKER_POOL_SIZE,
        candidates: candidates.slice(0, LOOKAHEAD_LIMIT)
      }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function scoreOneCandidate(candidate) {
    return scoreStaticSlop({
      url: candidate.url,
      title: candidate.title,
      description: candidate.visibleText,
      strictness: "balanced"
    });
  }

  function extractCandidate(element) {
    const link = findBestVideoLink(element);
    const title = findTitle(element, link);
    const visibleText = normalizeWhitespace(element.innerText || element.textContent || "");
    const parsed = parseYouTubeUrl(link || window.location.href);

    return {
      videoId: parsed.videoId,
      url: parsed.normalizedUrl || link || window.location.href,
      title,
      visibleText
    };
  }

  function findBestVideoLink(element) {
    const anchors = Array.from(element.querySelectorAll("a[href]"));
    const link = anchors.find((anchor) => {
      const href = anchor.getAttribute("href") || "";
      return href.includes("/watch?v=") || href.includes("/shorts/");
    });
    if (!link) {
      return null;
    }

    const href = link.getAttribute("href") || "";
    try {
      return new URL(href, window.location.origin).href;
    } catch {
      return null;
    }
  }

  function findTitle(element, link) {
    const titleElement = element.querySelector([
      "#video-title",
      "yt-formatted-string#video-title",
      "h3",
      "a[title]",
      "[aria-label][role='link']",
      "yt-lockup-metadata-view-model a"
    ].join(","));
    const title = titleElement?.getAttribute("title") || titleElement?.textContent || "";
    if (title.trim()) {
      return normalizeWhitespace(title);
    }

    const linkedAnchor = link
      ? Array.from(element.querySelectorAll("a[href]")).find((anchor) => {
        try {
          return new URL(anchor.getAttribute("href") || "", window.location.origin).href === link;
        } catch {
          return false;
        }
      })
      : null;
    return normalizeWhitespace(linkedAnchor?.textContent || element.getAttribute("aria-label") || "");
  }

  function createSignature(extracted) {
    return [
      extracted.videoId || "",
      extracted.title || "",
      extracted.visibleText.slice(0, 500)
    ].join("|");
  }

  function hideWithShield(element, extracted, score) {
    if (!element.hasAttribute(ORIGINAL_DISPLAY_ATTR)) {
      element.setAttribute(ORIGINAL_DISPLAY_ATTR, element.style.display || "");
    }

    clearOrislopCallout(element);

    Array.from(element.children).forEach((child) => {
      if (child instanceof HTMLElement) {
        child.style.display = "none";
      }
    });

    const existingShield = element.querySelector(":scope > .orislop-hidden-card");
    if (existingShield) {
      return;
    }

    const shield = document.createElement("section");
    shield.className = "orislop-hidden-card";
    shield.innerHTML = "";

    const top = document.createElement("div");
    top.className = "orislop-hidden-card__top";
    const badge = document.createElement("span");
    badge.className = "orislop-hidden-card__badge";
    badge.textContent = "Hidden by Orislop";
    const scoreLabel = document.createElement("span");
    scoreLabel.className = "orislop-hidden-card__score";
    scoreLabel.textContent = `${score.score}/100`;
    top.append(badge, scoreLabel);

    const title = document.createElement("p");
    title.className = "orislop-hidden-card__title";
    title.textContent = extracted.title || "YouTube video";

    const reason = document.createElement("p");
    reason.className = "orislop-hidden-card__reason";
    reason.textContent = score.reasons.slice(0, 3).join(", ");

    const actions = document.createElement("div");
    actions.className = "orislop-hidden-card__actions";
    const revealButton = document.createElement("button");
    revealButton.type = "button";
    revealButton.textContent = "Show this video";
    revealButton.addEventListener("click", () => revealElement(element, shield));
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open anyway";
    openButton.addEventListener("click", () => window.open(extracted.url, "_blank", "noopener,noreferrer"));
    actions.append(revealButton, openButton);

    shield.append(top, title, reason, actions);
    element.prepend(shield);
  }

  function markQuestionable(element, extracted, score) {
    element.classList.add("orislop-flagged-outline");
    const existing = element.querySelector(":scope > .orislop-callout-card");
    if (existing) {
      existing.remove();
    }

    const callout = document.createElement("section");
    callout.className = "orislop-callout-card";

    const label = document.createElement("strong");
    label.textContent = score.reasons.includes("YouTube AI/synthetic disclosure")
      ? "Orislop detected an AI/synthetic disclosure"
      : "Orislop flagged this video";

    const detail = document.createElement("span");
    detail.textContent = `${score.score}/100 - ${score.reasons.slice(0, 2).join(", ")}`;

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.textContent = "Hide";
    hideButton.addEventListener("click", () => hideWithShield(element, extracted, { ...score, recommendation: "skip" }));

    callout.append(label, detail, hideButton);
    element.prepend(callout);
  }

  function clearOrislopCallout(element) {
    element.classList.remove("orislop-flagged-outline");
    const existing = element.querySelector(":scope > .orislop-callout-card");
    if (existing) {
      existing.remove();
    }
  }

  function ensureStatusPill() {
    if (document.getElementById(STATUS_ID)) {
      return;
    }

    const pill = document.createElement("aside");
    pill.id = STATUS_ID;
    pill.className = "orislop-status-pill";
    pill.setAttribute("aria-live", "polite");
    document.documentElement.append(pill);
    renderStatusPill();
  }

  function renderStatusPill() {
    const pill = document.getElementById(STATUS_ID);
    if (!pill) {
      return;
    }

    const text = `Orislop - next ${LOOKAHEAD_LIMIT} - workers ${status.workers} - flagged ${status.flagged} - skipped ${status.skipped}`;
    if (text !== lastStatusText) {
      lastStatusText = text;
      pill.textContent = text;
    }
  }

  function revealElement(element, shield) {
    shield.remove();
    Array.from(element.children).forEach((child) => {
      if (child instanceof HTMLElement) {
        child.style.display = "";
      }
    });
    element.setAttribute(PROCESSED_ATTR, "revealed");
  }

  function shouldAutoSkip(element, extracted) {
    if (!settingsCache.autoSkip || !extracted.videoId) {
      return false;
    }

    return isCurrentVideoCandidate(element, extracted);
  }

  function rememberPreSkip(extracted, score) {
    if (!settingsCache.autoSkip || !extracted.videoId) {
      return;
    }

    preSkipScores.set(extracted.videoId, {
      ...score,
      preSkippedAt: Date.now()
    });

    if (preSkipScores.size > LOOKAHEAD_LIMIT * 2) {
      const oldestKey = preSkipScores.keys().next().value;
      preSkipScores.delete(oldestKey);
    }
  }

  function getCurrentPreSkipScore(element, extracted) {
    if (!settingsCache.autoSkip || !isCurrentVideoCandidate(element, extracted) || !extracted.videoId) {
      return null;
    }

    return preSkipScores.get(extracted.videoId) || null;
  }

  function isActiveShortsScrollerCandidate(_element, extracted) {
    return window.location.pathname.startsWith("/shorts/")
      && extracted.videoId
      && !isCurrentVideoCandidate(_element, extracted);
  }

  function isCurrentVideoCandidate(element, extracted) {
    if (!extracted.videoId) {
      return false;
    }

    const current = parseYouTubeUrl(window.location.href);
    if (current.videoId && current.videoId === extracted.videoId) {
      return true;
    }

    return element.matches("ytd-shorts, ytd-watch-metadata")
      && (window.location.pathname.startsWith("/shorts/") || window.location.pathname === "/watch");
  }

  async function attemptAutoSkip(extracted, score) {
    const now = Date.now();
    if (lastAutoSkip.videoId === extracted.videoId && now - lastAutoSkip.at < AUTOSKIP_COOLDOWN_MS) {
      return;
    }

    lastAutoSkip = {
      videoId: extracted.videoId,
      at: now
    };
    status.skipped += 1;
    renderStatusPill();
    showAutoSkipToast(extracted, score);
    await saveSkippedRecord(extracted, score, currentVideoKind() === "short" ? "auto_skipped_short" : "auto_skipped_watch");

    window.setTimeout(() => {
      const didNavigate = currentVideoKind() === "short"
        ? tryNextShortNavigation()
        : tryNextWatchNavigation();

      if (!didNavigate) {
        showAutoSkipToast(extracted, score, "Flagged this video. Could not safely advance, so it was logged instead.");
      }
    }, AUTOSKIP_DELAY_MS);
  }

  function tryNextShortNavigation() {
    const selectors = [
      "#navigation-button-down button",
      "button[aria-label='Next video']",
      "button[aria-label='Next Short']",
      "button[aria-label='Next']",
      "ytd-button-renderer[aria-label='Next video'] button"
    ];
    if (clickFirst(selectors)) {
      return true;
    }

    const eventOptions = {
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      which: 40,
      cancelable: true,
      bubbles: true
    };
    for (const target of [document.activeElement, document.body, document.documentElement, document, window]) {
      target?.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
    }
    window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: "smooth" });
    return true;
  }

  function tryNextWatchNavigation() {
    return clickFirst([
      ".ytp-next-button",
      "a.ytp-next-button",
      "button.ytp-next-button",
      "a[aria-label='Next']",
      "button[aria-label='Next']"
    ]);
  }

  function clickFirst(selectors) {
    for (const selector of selectors) {
      const target = document.querySelector(selector);
      if (target instanceof HTMLElement && !target.hasAttribute("disabled") && isProbablyVisible(target)) {
        target.click();
        return true;
      }
    }
    return false;
  }

  function showAutoSkipToast(extracted, score, overrideMessage) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("aside");
      toast.id = TOAST_ID;
      toast.className = "orislop-autoskip-toast";
      document.documentElement.append(toast);
    }

    toast.textContent = overrideMessage
      || `Orislop auto-skipped: ${extracted.title || "YouTube video"} (${score.score}/100)`;
    window.clearTimeout(showAutoSkipToast.timeoutId);
    showAutoSkipToast.timeoutId = window.setTimeout(() => {
      toast?.remove();
    }, 4200);
  }

  function currentVideoKind() {
    return window.location.pathname.startsWith("/shorts/") ? "short" : "watch";
  }

  async function saveFlaggedRecord(extracted, score) {
    const record = {
      id: `${extracted.videoId || extracted.url}:${score.recommendation}`,
      videoId: extracted.videoId,
      url: extracted.url,
      title: extracted.title || "YouTube video",
      recommendation: score.recommendation,
      score: score.score,
      reasons: score.reasons,
      createdAt: new Date().toISOString()
    };

    const current = await readFlaggedLog();
    const next = dedupeFlaggedRecords([record, ...current]).slice(0, 300);
    await chrome.storage.local.set({ [FLAGGED_KEY]: next });
  }

  async function readFlaggedLog() {
    return readList(FLAGGED_KEY);
  }

  async function saveSkippedRecord(extracted, score, mode) {
    const record = {
      id: `${extracted.videoId || extracted.url}:${mode}`,
      videoId: extracted.videoId,
      url: extracted.url,
      title: extracted.title || "YouTube video",
      mode,
      score: score.score,
      reasons: score.reasons,
      createdAt: new Date().toISOString()
    };

    const current = await readList(SKIPPED_KEY);
    const next = dedupeRecords([record, ...current], (item) => `${item.videoId || item.url}:${item.mode}`).slice(0, 300);
    await chrome.storage.local.set({ [SKIPPED_KEY]: next });
  }

  function dedupeFlaggedRecords(records) {
    return dedupeRecords(records, (record) => `${record.videoId || record.url}:${record.recommendation}`);
  }

  async function readList(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return Array.isArray(result[key]) ? result[key] : [];
    } catch {
      return [];
    }
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
    if (!value || typeof value !== "object") {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      autoSkip: typeof value.autoSkip === "boolean" ? value.autoSkip : DEFAULT_SETTINGS.autoSkip,
      hideFeedCards: typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideFeedCards
    };
  }

  function dedupeRecords(records, keyFor) {
    const seen = new Set();
    const deduped = [];
    for (const record of records) {
      const key = keyFor(record);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(record);
    }
    return deduped;
  }

  function scoreStaticSlop(input) {
    const parsed = parseYouTubeUrl(input.url);
    const text = normalize([
      input.title,
      input.description,
      parsed.videoKind === "short" ? "youtube shorts" : ""
    ].filter(Boolean).join(" "));
    const reasons = [];
    let rawScore = 0;

    for (const rule of RULES) {
      if (rule.test(text, input)) {
        rawScore += rule.weight;
        reasons.push(rule.label);
      }
    }

    const stackedSignalBoost = Math.max(0, reasons.length - 2) * 4;
    const score = clampScore(rawScore + stackedSignalBoost);
    const recommendation = score >= 68 ? "skip" : score >= 36 ? "questionable" : "watch";
    const confidence = reasons.length >= 4 ? "high" : reasons.length >= 2 ? "medium" : "low";

    return {
      score,
      recommendation,
      reasons: reasons.length > 0 ? reasons : ["No strong static slop signals found"],
      confidence,
      videoId: parsed.videoId,
      videoKind: parsed.videoKind
    };
  }

  function parseYouTubeUrl(input) {
    const trimmed = String(input || "").trim();
    if (!trimmed) {
      return emptyParsedResult(input);
    }

    try {
      const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      const host = url.hostname.toLowerCase();
      const isYouTubeUrl = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host);
      if (!isYouTubeUrl) {
        return emptyParsedResult(input);
      }

      const pathParts = url.pathname.split("/").filter(Boolean);
      const shortsId = pathParts[0] === "shorts" && pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
      const watchId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
      const shortLinkId = host === "youtu.be" && pathParts[0] ? decodeURIComponent(pathParts[0]) : null;
      const videoId = sanitizeVideoId(shortsId || watchId || shortLinkId);
      const videoKind = shortsId ? "short" : videoId ? "watch" : "unknown";

      return {
        isYouTubeUrl: true,
        videoId,
        videoKind,
        normalizedUrl: videoId
          ? videoKind === "short"
            ? `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`
            : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
          : null
      };
    } catch {
      return emptyParsedResult(input);
    }
  }

  function sanitizeVideoId(value) {
    if (!value) {
      return null;
    }
    const clean = value.trim();
    return /^[a-zA-Z0-9_-]{3,128}$/.test(clean) ? clean : null;
  }

  function emptyParsedResult() {
    return {
      isYouTubeUrl: false,
      videoId: null,
      videoKind: "unknown",
      normalizedUrl: null
    };
  }

  function includesAny(text, phrases) {
    return phrases.some((phrase) => text.includes(phrase));
  }

  function hasAiSignal(text) {
    if (includesAny(text, PLATFORM_AI_DISCLOSURES)) {
      return true;
    }
    if (includesAny(text, AI_TERMS.filter((term) => term !== "ai"))) {
      return true;
    }
    return /\bai\b/.test(text)
      && /\b(voice|generated|synthetic|deepfake|clone|cover|song|music|video|image|art|made|created|altered)\b/.test(text);
  }

  function emojiCount(text) {
    return Array.from(text).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
  }

  function allCapsWordCount(text) {
    return text.split(/\s+/).filter((word) => /^[A-Z]{4,}$/.test(word)).length;
  }

  function hasRepetition(text) {
    const words = text.match(/[a-z0-9']+/gi)?.map((word) => word.toLowerCase()) || [];
    if (words.length < 10) {
      return false;
    }

    const uniqueRatio = new Set(words).size / words.length;
    const counts = new Map();
    for (let index = 0; index < words.length - 1; index += 1) {
      const key = `${words[index]} ${words[index + 1]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    return uniqueRatio < 0.45 || Array.from(counts.values()).some((count) => count >= 3);
  }

  function isLowInformationTitle(title) {
    const trimmed = title.trim();
    if (!trimmed) {
      return false;
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const hashtagTokens = tokens.filter((token) => /^#[a-zA-Z0-9_-]+$/.test(token));
    return trimmed.length < 12
      || (tokens.length >= 2 && hashtagTokens.length === tokens.length)
      || (tokens.length >= 4 && hashtagTokens.length / tokens.length >= 0.75);
  }

  function isProbablyVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 40
      && rect.height > 30
      && rect.bottom >= -300
      && rect.top <= window.innerHeight + 900;
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
})();
