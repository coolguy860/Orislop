import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Browser debugging connection closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to ${url}`));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  receive(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Browser may already be closed.
    }
  }
}

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, "..", "..", "..");
const VIDEO_AUDIT_SAMPLE_SIZE = Math.max(1, Number.parseInt(process.env.ORISLOP_VIDEO_AUDIT_SAMPLE_SIZE || "150", 10) || 150);
const extensionRoot = path.join(repoRoot, "apps", "extension", "dist");
const artifactRoot = path.join(repoRoot, "dist", "qa", "youtube-live-audit");
const browser = findBrowser();
const profile = mkdtempSync(path.join(os.tmpdir(), "orislop-youtube-live-"));
const port = 9320 + Math.floor(Math.random() * 300);
const firstUrl = searchUrl("Tung Tung Tung Sahur AIAnimation AIVideo shorts");
const detectorRegressionShortUrl = "https://www.youtube.com/shorts/64_J02ACvaw";
const browserProcess = spawn(browser, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
  "--use-gl=disabled",
  "--disable-features=Vulkan,Dawn,Graphite,UseSkiaRenderer,VizDisplayCompositor",
  "--disable-component-update",
  "--disable-sync",
  "--no-default-browser-check",
  "--no-first-run",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1440,1100",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`,
  firstUrl
], { stdio: "ignore", windowsHide: true });

let page;
let worker;
let browserConnection;
const runtimeErrors = [];
const audit = {
  checkedAt: new Date().toISOString(),
  browser,
  extensionRoot,
  extensionId: "",
  sessions: [],
  storage: {},
  runtimeErrors,
  assertions: {}
};

try {
  assert.ok(existsSync(path.join(extensionRoot, "manifest.json")), "Build the unpacked extension before the live audit");
  const targets = await waitForTargets(port, (items) => {
    const hasYoutube = items.some((item) => item.type === "page" && item.url.includes("youtube.com"));
    return hasYoutube ? items : null;
  }, 30000, "YouTube did not open in the isolated browser");
  const pageTarget = targets.find((item) => item.type === "page" && item.url.includes("youtube.com"));
  page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
  page.on("Runtime.exceptionThrown", (params) => rememberRuntimeError("page", params?.exceptionDetails?.text || "Runtime exception", params));
  page.on("Log.entryAdded", (params) => {
    if (params?.entry?.level === "error") rememberRuntimeError("page", params.entry.text, params.entry);
  });
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  await page.call("Log.enable");

  await dismissConsentIfPresent(page);
  worker = await connectExtensionWorker(port);
  audit.extensionId = extensionIdFromUrl(worker.target.url);
  worker.connection.on("Runtime.exceptionThrown", (params) => rememberRuntimeError("extension-worker", params?.exceptionDetails?.text || "Runtime exception", params));
  await worker.connection.call("Runtime.enable");
  const slopBiased = await auditSearchSession({
    page,
    worker: worker.connection,
    label: "slop-biased",
    bucket: "slop-biased",
    url: firstUrl,
    scrolls: 8,
    measureKnownAi: true
  });
  audit.sessions.push(slopBiased);
  audit.storage.afterSlopBiased = summarizeStorage(await readExtensionStorage(worker.connection));

  const educational = await auditSearchSession({
    page,
    worker: worker.connection,
    label: "educational",
    bucket: "educational",
    url: searchUrl("MIT physics lecture black holes gravity explained"),
    scrolls: 7,
    settleTimeoutMs: 180000
  });
  audit.sessions.push(educational);
  audit.storage.afterEducational = summarizeStorage(await readExtensionStorage(worker.connection));

  const supplementalSearches = [
    { label: "slop-animals", bucket: "slop-biased", query: "AI generated animal shorts synthetic" },
    { label: "slop-animation", bucket: "slop-biased", query: "AI animation brainrot characters shorts" },
    { label: "slop-challenges", bucket: "slop-biased", query: "Topper Guild impossible challenge shorts" },
    { label: "slop-reddit", bucket: "slop-biased", query: "reddit story minecraft parkour AI voice shorts" },
    { label: "slop-brainrot", bucket: "slop-biased", query: "Italian brainrot animation compilation shorts" },
    { label: "slop-rescue", bucket: "slop-biased", query: "AI generated animal rescue viral shorts" },
    { label: "slop-split-screen", bucket: "slop-biased", query: "Family Guy clips subway surfers reddit story shorts" },
    { label: "slop-deepfake", bucket: "slop-biased", query: "AI generated celebrity deepfake shorts" },
    { label: "education-math", bucket: "educational", query: "Khan Academy calculus lesson" },
    { label: "education-woodworking", bucket: "educational", query: "woodworking hand tools tutorial" },
    { label: "education-cooking", bucket: "educational", query: "culinary school cooking technique lesson" },
    { label: "education-history", bucket: "educational", query: "university history documentary lecture" }
  ];
  for (const spec of supplementalSearches) {
    const session = await auditSearchSession({
      page,
      worker: worker.connection,
      label: spec.label,
      bucket: spec.bucket,
      url: searchUrl(spec.query),
      scrolls: 5,
      settleTimeoutMs: 90000
    });
    audit.sessions.push(session);
  }

  const sampledVideos = uniqueVideoSample([
    ...audit.sessions.flatMap((session) => session.sampledVideos || [])
  ], VIDEO_AUDIT_SAMPLE_SIZE);
  audit.videoAudit = await scoreVideoMetadata(worker.connection, sampledVideos, VIDEO_AUDIT_SAMPLE_SIZE);

  const shorts = await auditShortsSession(page, detectorRegressionShortUrl, worker.connection);
  audit.sessions.push(shorts);
  audit.storage.afterShorts = summarizeStorage(await readExtensionStorage(worker.connection));
  audit.detectorRegression = await replayDetectorDecision(audit.extensionId, detectorRegressionShortUrl);

  const finalProbe = await pageValue(page, pageProbeExpression());
  audit.assertions = {
    extensionWorkerLoaded: Boolean(audit.extensionId),
    contentScriptInjected: audit.sessions.every((session) => session.indicatorInjected),
    youtubeRendered: audit.sessions.slice(0, 2).every((session) => session.maxCandidateCount > 0),
    requestedDistinctYoutubeVideosChecked: audit.videoAudit.sampleCount === VIDEO_AUDIT_SAMPLE_SIZE,
    videoMetadataFastPathUnderTwoSeconds: audit.videoAudit.elapsedMs <= 2000,
    knownAiTitlesSkippedInVideoSample: audit.videoAudit.knownAiTitleCount > 0
      && audit.videoAudit.knownAiTitleSkipped === audit.videoAudit.knownAiTitleCount,
    educationalSampleHardSkipRateBelowFivePercent: audit.videoAudit.byBucket.educational.hardSkipRate <= 0.05,
    observedKnownAiTitleHiddenUnderTwoSeconds: slopBiased.knownAiFastHide?.hidden === true
      && slopBiased.knownAiFastHide.latencyMs <= 2000,
    manualScrollingWorked: audit.sessions.slice(0, 2).every((session) => session.manualScrollDistance > 300),
    noAutomaticViewportJump: audit.sessions.every((session) => session.noAutomaticViewportJump !== false),
    scannerObservedItems: Number(audit.storage.afterEducational?.scanStatus?.checkedCount || 0) > 0,
    scannerNotErrored: audit.storage.afterEducational?.scanStatus?.state !== "error",
    qwenHealthyAcrossSessions: [
      audit.storage.afterSlopBiased?.ollamaStatus,
      audit.storage.afterEducational?.ollamaStatus,
      audit.storage.afterShorts?.ollamaStatus
    ].every((status) => ["available", "bypassed_hard_ai", "pending"].includes(status?.state) && !status?.error),
    skipAndHidePathObserved: audit.storage.afterSlopBiased?.skippedCount > 0,
    educationalFeedHadZeroHiddenItems: educational.hiddenCount === 0,
    everyEducationalSearchHadZeroHiddenItems: audit.sessions
      .filter((session) => session.label === "educational" || session.label.startsWith("education-"))
      .every((session) => session.hiddenCount === 0),
    educationalRegressionShortStayedVisible: shorts.coverCount === 0 && shorts.blockedMediaCount === 0,
    visualRegressionStayedVisible: audit.detectorRegression?.synthetic === false
      && audit.detectorRegression?.automaticSkipEligible !== true
      && (!audit.detectorRegression?.consensus
        || ["disagreement_fail_open", "isolated_signal_fail_open", "no_signal"].includes(audit.detectorRegression.consensus.basis)),
    hiddenItemsAreAbsentFromLayout: finalProbe.hiddenLayoutLeaks === 0,
    blockedMediaCannotKeepPlaying: finalProbe.playingBlockedMedia === 0,
    normalItemsRemainVisible: audit.sessions.slice(0, 2).some((session) => session.visibleCandidateCount > 0)
  };

  for (const [name, passed] of Object.entries(audit.assertions)) {
    assert.equal(passed, true, `Live YouTube assertion failed: ${name}`);
  }

  mkdirSync(artifactRoot, { recursive: true });
  const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(artifactRoot, "youtube-final.png"), Buffer.from(screenshot.data, "base64"));
  writeFileSync(path.join(artifactRoot, "youtube-live-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);

  console.log(JSON.stringify(audit, null, 2));
  console.log("Real YouTube extension scroll audit passed");
} catch (error) {
  audit.failure = error instanceof Error ? error.message : String(error);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(path.join(artifactRoot, "youtube-live-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  if (page) {
    try {
      const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(path.join(artifactRoot, "youtube-final.png"), Buffer.from(screenshot.data, "base64"));
    } catch {
      // Preserve the original audit failure.
    }
  }
  throw error;
} finally {
  page?.close();
  worker?.connection?.close();
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (version?.webSocketDebuggerUrl) {
      browserConnection = await Cdp.connect(version.webSocketDebuggerUrl);
      await browserConnection.call("Browser.close");
    }
  } catch {
    browserProcess.kill();
  }
  browserConnection?.close();
  await delay(1800);
  if (browserProcess.exitCode === null) browserProcess.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  } catch (error) {
    console.warn(`[live-youtube] Could not remove isolated browser profile immediately: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function auditSearchSession({ page: connection, worker: workerConnection, label, bucket = label, url, scrolls, settleTimeoutMs = 130000, measureKnownAi = false }) {
  if ((await pageValue(connection, "location.href")) !== url) {
    await connection.call("Page.navigate", { url });
  }
  await waitForPage(connection, () => pageProbeExpression(), (value) => value.readyState === "complete" && value.candidateCount > 0, 30000, `${label} YouTube feed did not render`);
  await dismissConsentIfPresent(connection);
  const initial = await pageValue(connection, pageProbeExpression());
  const snapshots = [initial];
  const sampledVideos = new Map();
  rememberSampledVideos(sampledVideos, initial.candidateItems, bucket);
  const knownAiFastHide = measureKnownAi ? await waitForKnownAiHide(connection, 3000) : null;
  console.log(`[live-youtube] ${label}: ${initial.candidateCount} candidates; indicator=${initial.indicatorText || "missing"}`);

  for (let index = 0; index < scrolls; index += 1) {
    await pageValue(connection, `(() => { window.scrollBy({ top: Math.max(700, window.innerHeight * 0.82), behavior: "instant" }); return window.scrollY; })()`);
    await delay(1500);
    const snapshot = await pageValue(connection, pageProbeExpression());
    snapshots.push(snapshot);
    rememberSampledVideos(sampledVideos, snapshot.candidateItems, bucket);
    console.log(`[live-youtube] ${label}: scroll ${index + 1}/${scrolls}; y=${Math.round(snapshot.scrollY)} checked=${snapshot.processedCount} hidden=${snapshot.hiddenCount}`);
  }

  const idleStart = await pageValue(connection, "({ scrollY: window.scrollY, innerHeight: window.innerHeight })");
  await delay(5000);
  const idleEnd = await pageValue(connection, "({ scrollY: window.scrollY, innerHeight: window.innerHeight })");
  const idleDelta = Math.abs(idleEnd.scrollY - idleStart.scrollY);
  const settledStorage = await waitForScanSettled(workerConnection, settleTimeoutMs, label);
  const final = await pageValue(connection, pageProbeExpression());
  rememberSampledVideos(sampledVideos, final.candidateItems, bucket);
  const maxCandidateCount = Math.max(...snapshots.map((item) => item.candidateCount), final.candidateCount);
  const manualScrollDistance = Math.max(...snapshots.map((item) => item.scrollY)) - initial.scrollY;
  return {
    label,
    url: final.url,
    title: final.title,
    candidateTitles: final.candidateTitles,
    sampledVideos: [...sampledVideos.values()],
    knownAiFastHide,
    indicatorInjected: final.indicatorInjected,
    indicatorText: final.indicatorText,
    maxCandidateCount,
    visibleCandidateCount: final.visibleCandidateCount,
    processedCount: final.processedCount,
    hiddenCount: final.hiddenCount,
    hiddenTitles: final.hiddenTitles,
    coverCount: final.coverCount,
    blockedMediaCount: final.blockedMediaCount,
    playingBlockedMedia: final.playingBlockedMedia,
    manualScrollDistance,
    idleScrollDelta: idleDelta,
    noAutomaticViewportJump: idleDelta < Math.max(250, idleEnd.innerHeight * 0.55),
    settledScanStatus: settledStorage["orislop.extension.scanStatus"] || null
  };
}

async function auditShortsSession(connection, url, workerConnection) {
  const beforeStorage = await readExtensionStorage(workerConnection);
  const previousDetectorCheck = beforeStorage["orislop.extension.detectorStatus"]?.checkedAt || "";
  await connection.call("Page.navigate", { url });
  await waitForPage(connection, () => pageProbeExpression(), (value) => value.readyState === "complete" && value.videoCount > 0, 30000, "YouTube Shorts player did not render");
  await delay(3000);
  const initial = await pageValue(connection, pageProbeExpression());
  const before = await pageValue(connection, "({ scrollY: window.scrollY, innerHeight: window.innerHeight })");
  await pageValue(connection, "(() => { window.scrollBy({ top: Math.max(700, window.innerHeight * 0.9), behavior: 'instant' }); return window.scrollY; })()");
  await delay(2500);
  const afterManual = await pageValue(connection, "({ scrollY: window.scrollY, innerHeight: window.innerHeight })");
  await delay(5000);
  const afterIdle = await pageValue(connection, "({ scrollY: window.scrollY, innerHeight: window.innerHeight })");
  const settledStorage = await waitForDetectorReady(workerConnection, previousDetectorCheck, 180000);
  const final = await pageValue(connection, pageProbeExpression());
  const idleDelta = Math.abs(afterIdle.scrollY - afterManual.scrollY);
  return {
    label: "shorts-player",
    url: final.url,
    title: final.title,
    candidateTitles: final.candidateTitles,
    indicatorInjected: final.indicatorInjected,
    indicatorText: final.indicatorText,
    maxCandidateCount: Math.max(initial.candidateCount, final.candidateCount),
    visibleCandidateCount: final.visibleCandidateCount,
    processedCount: final.processedCount,
    hiddenCount: final.hiddenCount,
    hiddenTitles: final.hiddenTitles,
    coverCount: final.coverCount,
    blockedMediaCount: final.blockedMediaCount,
    playingBlockedMedia: final.playingBlockedMedia,
    manualScrollDistance: Math.abs(afterManual.scrollY - before.scrollY),
    idleScrollDelta: idleDelta,
    noAutomaticViewportJump: idleDelta < Math.max(250, afterIdle.innerHeight * 0.55),
    settledScanStatus: settledStorage["orislop.extension.scanStatus"] || null,
    settledDetectorStatus: settledStorage["orislop.extension.detectorStatus"] || null
  };
}

function rememberSampledVideos(target, items, bucket) {
  for (const item of Array.isArray(items) ? items : []) {
    try {
      const parsed = new URL(item.url);
      const shortId = parsed.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || "";
      const videoId = parsed.searchParams.get("v") || shortId;
      if (!videoId || !/^(?:www\.)?youtube\.com$/i.test(parsed.hostname)) continue;
      const key = `youtube:${videoId}`;
      if (!target.has(key)) target.set(key, {
        key,
        bucket,
        title: String(item.title || "").slice(0, 400),
        url: shortId ? `https://www.youtube.com/shorts/${shortId}` : `https://www.youtube.com/watch?v=${videoId}`,
        previewUrl: String(item.previewUrl || "").slice(0, 2000)
      });
    } catch {
      // Ignore navigation and malformed links in YouTube's surrounding UI.
    }
  }
}

function uniqueVideoSample(items, limit) {
  const unique = new Map();
  for (const item of items) if (item?.key && !unique.has(item.key)) unique.set(item.key, item);
  const values = [...unique.values()];
  const perBucket = Math.floor(limit / 2);
  const selected = [
    ...values.filter((item) => item.bucket === "slop-biased").slice(0, perBucket),
    ...values.filter((item) => item.bucket === "educational").slice(0, perBucket)
  ];
  const selectedKeys = new Set(selected.map((item) => item.key));
  for (const item of values) {
    if (selected.length >= limit) break;
    if (!selectedKeys.has(item.key)) {
      selected.push(item);
      selectedKeys.add(item.key);
    }
  }
  return selected.slice(0, limit);
}

async function scoreVideoMetadata(workerConnection, sample, requiredSampleSize) {
  assert.equal(sample.length, requiredSampleSize, `YouTube rendered only ${sample.length} distinct auditable videos; need ${requiredSampleSize}`);
  const inputs = sample.map((item) => ({
    platform: "youtube",
    itemId: item.key.split(":").slice(1).join(":"),
    url: item.url,
    title: item.title,
    visibleText: "",
    transcriptText: "",
    channelName: "",
    previewUrl: item.previewUrl
  }));
  const startedAt = Date.now();
  const decisions = await pageValue(workerConnection, `(() => {
    const inputs = ${JSON.stringify(inputs)};
    return inputs.map((candidate) => {
      const decision = globalThis.OrislopClassifier.scoreCandidate(candidate);
      return {
        recommendation: decision.recommendation,
        score: decision.score,
        hardAiSynthetic: decision.hardAiSynthetic === true,
        educationalProtected: decision.educationalProtected === true,
        reasons: decision.reasons
      };
    });
  })()`);
  const elapsedMs = Date.now() - startedAt;
  const records = sample.map((item, index) => ({ ...item, ...decisions[index] }));
  const knownPattern = /\b(?:tung\s+tung\s+tung\s+sahur|tralalero\s+tralala|bombardir[oi]\s+crocodilo|ballerina\s+cappuccina|cappuccino\s+assassino)\b|#(?:aivideo|aianimation|aigenerated)\b/i;
  const known = records.filter((item) => knownPattern.test(item.title));
  const byBucket = Object.fromEntries(["slop-biased", "educational"].map((bucket) => {
    const bucketItems = records.filter((item) => item.bucket === bucket);
    const hardSkips = bucketItems.filter((item) => item.hardAiSynthetic).length;
    return [bucket, {
      count: bucketItems.length,
      hardSkips,
      hardSkipRate: bucketItems.length ? hardSkips / bucketItems.length : 0
    }];
  }));
  return {
    sampleCount: records.length,
    elapsedMs,
    knownAiTitleCount: known.length,
    knownAiTitleSkipped: known.filter((item) => item.hardAiSynthetic && item.recommendation === "skip").length,
    byBucket,
    records
  };
}

async function waitForKnownAiHide(connection, timeoutMs) {
  const pattern = /\b(?:tung\s+tung\s+tung\s+sahur|tralalero\s+tralala|bombardir[oi]\s+crocodilo|ballerina\s+cappuccina|cappuccino\s+assassino)\b|#(?:aivideo|aianimation|aigenerated)\b/i;
  const deadline = Date.now() + timeoutMs;
  let firstSeenAt = 0;
  let observed = null;
  while (Date.now() < deadline) {
    const probe = await pageValue(connection, pageProbeExpression());
    const item = (probe.candidateItems || []).find((candidate) => pattern.test(candidate.title));
    if (item) {
      observed = item;
      if (!firstSeenAt) firstSeenAt = Date.now();
      if (item.hidden) return { observed: true, hidden: true, latencyMs: Date.now() - firstSeenAt, title: item.title, url: item.url };
    }
    await delay(100);
  }
  return {
    observed: Boolean(observed),
    hidden: false,
    latencyMs: firstSeenAt ? Date.now() - firstSeenAt : null,
    title: observed?.title || "",
    url: observed?.url || ""
  };
}

function pageProbeExpression() {
  return `(() => {
    const candidateSelector = [
      "ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
      "ytd-compact-video-renderer", "ytd-reel-item-renderer", "ytd-reel-video-renderer",
      "yt-lockup-view-model", "ytd-watch-metadata"
    ].join(",");
    const candidates = Array.from(document.querySelectorAll(candidateSelector));
    const hidden = Array.from(document.querySelectorAll(".orislop-skip-hidden"));
    const titleOf = (element) => (element.querySelector("#video-title, a[title], h1, h2, h3")?.getAttribute("title")
      || element.querySelector("#video-title, a[title], h1, h2, h3")?.textContent
      || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 180);
    const itemOf = (element) => {
      const link = element.querySelector("a#video-title, a#video-title-link, a[href*='/watch?v='], a[href*='/shorts/']");
      const href = link?.href || "";
      const image = element.querySelector("img");
      return {
        title: titleOf(element),
        url: href,
        previewUrl: image?.currentSrc || image?.src || "",
        hidden: element.classList.contains("orislop-skip-hidden") || Boolean(element.closest(".orislop-skip-hidden"))
      };
    };
    const indicator = document.querySelector(".orislop-live-indicator");
    const blocked = Array.from(document.querySelectorAll("video[data-orislop-playback-blocked], audio[data-orislop-playback-blocked]"));
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      candidateCount: candidates.length,
      candidateTitles: candidates.slice(0, 20).map(titleOf).filter(Boolean),
      candidateItems: candidates.map(itemOf).filter((item) => item.title && item.url),
      visibleCandidateCount: candidates.filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).length,
      processedCount: document.querySelectorAll("[data-orislop-processed]").length,
      hiddenCount: hidden.length,
      hiddenTitles: hidden.slice(0, 15).map(titleOf).filter(Boolean),
      hiddenLayoutLeaks: hidden.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && getComputedStyle(element).display !== "none";
      }).length,
      coverCount: document.querySelectorAll(".orislop-decision-cover").length,
      indicatorInjected: Boolean(indicator),
      indicatorText: indicator?.textContent?.replace(/\\s+/g, " ").trim() || "",
      blockedMediaCount: blocked.length,
      playingBlockedMedia: blocked.filter((media) => !media.paused || !media.muted || Number(media.volume) !== 0).length,
      videoCount: document.querySelectorAll("video").length,
      shortUrls: Array.from(document.querySelectorAll("a[href*='/shorts/']"), (link) => link.href).filter(Boolean).slice(0, 20)
    };
  })()`;
}

async function dismissConsentIfPresent(connection) {
  await pageValue(connection, `(() => {
    const wanted = /^(accept all|reject all|i agree)$/i;
    const button = Array.from(document.querySelectorAll("button, tp-yt-paper-button"))
      .find((item) => wanted.test((item.textContent || "").replace(/\\s+/g, " ").trim()));
    if (button) button.click();
    return Boolean(button);
  })()`);
  await delay(800);
}

async function connectExtensionWorker(portNumber) {
  const targets = await waitForTargets(portNumber, (items) => {
    const target = items.find((item) => item.type === "service_worker" && /^chrome-extension:\/\//.test(item.url) && item.url.endsWith("/background.js"));
    return target || null;
  }, 120000, "Orislop service worker did not start while scanning YouTube");
  const connection = await Cdp.connect(targets.webSocketDebuggerUrl);
  return { target: targets, connection };
}

async function readExtensionStorage(connection) {
  return pageValue(connection, `(async () => chrome.storage.local.get(null))()`);
}

async function waitForScanSettled(connection, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = {};
  while (Date.now() < deadline) {
    latest = await readExtensionStorage(connection);
    const status = latest["orislop.extension.scanStatus"] || {};
    if (status.state === "error") throw new Error(`${label} scan failed: ${status.error || "unknown scanner error"}`);
    if (status.state === "active" && Number(status.checkedCount) > 0) {
      console.log(`[live-youtube] ${label}: scan settled; checked=${status.checkedCount}`);
      return latest;
    }
    await delay(750);
  }
  throw new Error(`${label} scan did not settle; latest=${JSON.stringify(latest["orislop.extension.scanStatus"] || null)}`);
}

async function waitForDetectorReady(connection, previousCheckedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = {};
  while (Date.now() < deadline) {
    latest = await readExtensionStorage(connection);
    const scan = latest["orislop.extension.scanStatus"] || {};
    const detector = latest["orislop.extension.detectorStatus"] || {};
    if (scan.state === "error") throw new Error(`Shorts scan failed: ${scan.error || "unknown scanner error"}`);
    if (scan.state === "active"
      && Number(scan.checkedCount) > 0
      && detector.state === "available"
      && detector.checkedAt
      && detector.checkedAt !== previousCheckedAt) {
      console.log(`[live-youtube] shorts-player: visual detector settled; checked=${scan.checkedCount}`);
      return latest;
    }
    await delay(750);
  }
  throw new Error(`Shorts heavyweight detector did not settle; latest=${JSON.stringify({
    scan: latest["orislop.extension.scanStatus"] || null,
    detector: latest["orislop.extension.detectorStatus"] || null
  })}`);
}

async function replayDetectorDecision(extensionId, url) {
  const response = await fetch("http://127.0.0.1:4317/v1/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `chrome-extension://${extensionId}`
    },
    body: JSON.stringify({
      performanceProfile: "fast",
      candidates: [{ id: "0", url, mediaUrl: "", previewUrl: "" }]
    })
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || !payload.results?.[0]) {
    throw new Error(`Could not replay detector regression decision: ${payload?.error || response.status}`);
  }
  return payload.results[0];
}

function summarizeStorage(storage) {
  const scanStatus = storage["orislop.extension.scanStatus"] || null;
  const ollamaStatus = storage["orislop.extension.ollamaStatus"] || null;
  const detectorStatus = storage["orislop.extension.detectorStatus"] || null;
  const factCheckStatus = storage["orislop.extension.factCheckStatus"] || null;
  const skipped = Array.isArray(storage["orislop.extension.skippedLog"]) ? storage["orislop.extension.skippedLog"] : [];
  const flagged = Array.isArray(storage["orislop.extension.flaggedLog"]) ? storage["orislop.extension.flaggedLog"] : [];
  return {
    settings: storage["orislop.extension.settings"] || null,
    scanStatus,
    ollamaStatus,
    detectorStatus,
    factCheckStatus,
    skippedCount: skipped.length,
    skippedSeconds: skipped.reduce((total, item) => total + (Number(item.savedSeconds) || 0), 0),
    skipped: skipped.slice(-20).map(compactHistoryRecord),
    flaggedCount: flagged.length,
    flagged: flagged.slice(-20).map(compactHistoryRecord)
  };
}

function compactHistoryRecord(record) {
  return {
    platform: record.platform,
    title: record.title,
    mode: record.mode,
    score: record.score,
    reasons: Array.isArray(record.reasons) ? record.reasons.slice(0, 3) : [],
    sourceScores: record.sourceScores || null,
    detectorDecision: record.detectorDecision || null,
    savedSeconds: Number(record.savedSeconds) || 0
  };
}

async function waitForPage(connection, expressionFactory, predicate, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await pageValue(connection, expressionFactory());
    if (predicate(latest)) return latest;
    await delay(500);
  }
  throw new Error(`${errorMessage}; latest=${JSON.stringify(latest)}`);
}

async function waitForTargets(portNumber, predicate, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    try {
      latest = await fetchJson(`http://127.0.0.1:${portNumber}/json/list`);
      const match = predicate(latest);
      if (match) return match;
    } catch {
      // Browser debugging endpoint may not be ready yet.
    }
    await delay(250);
  }
  throw new Error(`${errorMessage}; targets=${JSON.stringify(latest.map(({ type, url }) => ({ type, url })))}`);
}

async function pageValue(connection, expression) {
  const response = await connection.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Browser evaluation failed");
  }
  return response.result?.value;
}

function rememberRuntimeError(source, message, details) {
  const text = String(message || "").slice(0, 500);
  const url = String(details?.url || details?.exception?.description || "").slice(0, 500);
  if (runtimeErrors.some((item) => item.source === source && item.message === text && item.url === url)) return;
  runtimeErrors.push({ source, message: text, url });
  if (runtimeErrors.length > 50) runtimeErrors.shift();
}

function extensionIdFromUrl(value) {
  return String(value || "").match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1] || "";
}

function searchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findBrowser() {
  const candidates = process.platform === "win32" ? [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/microsoft-edge"
  ] : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Microsoft Edge or Google Chrome is required for the live YouTube audit");
  return found;
}
