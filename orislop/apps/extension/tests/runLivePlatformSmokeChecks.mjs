import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 10_000);
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
      // Browser may already be closing.
    }
  }
}

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, "..", "..", "..");
const extensionRoot = path.join(repoRoot, "apps", "extension", "dist");
const artifactRoot = path.join(repoRoot, "dist", "qa", "live-platform-smoke");
const browser = findBrowser();
const profile = mkdtempSync(path.join(os.tmpdir(), "orislop-platform-live-"));
const port = 9700 + Math.floor(Math.random() * 200);
const platforms = [
  {
    platform: "youtube",
    url: "https://www.youtube.com/results?search_query=NASA+science+explainer",
    candidateSelector: "ytd-video-renderer, ytd-rich-item-renderer, ytd-reel-item-renderer"
  },
  {
    platform: "instagram",
    url: "https://www.instagram.com/instagram/reels/",
    candidateSelector: "main article, div[role='dialog'] article"
  },
  {
    platform: "tiktok",
    url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
    candidateSelector: "[data-e2e='recommend-list-item-container'], [data-e2e='browse-video'], article[data-e2e]"
  },
  {
    platform: "linkedin",
    url: "https://www.linkedin.com/posts/gyanda_as-ive-shared-with-all-of-you-before-video-activity-7306006866877145088-yIdl",
    candidateSelector: "main [data-urn^='urn:li:activity:'], main [data-id^='urn:li:activity:'], main article, main .feed-shared-update-v2"
  }
];
const processHandle = spawn(browser, [
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
  "--window-size=1440,1100",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`,
  platforms[0].url
], { stdio: "ignore", windowsHide: true });

let page;
let worker;
let browserConnection;
let popup;
const extensionErrors = [];
const results = [];

try {
  assert.ok(existsSync(path.join(extensionRoot, "manifest.json")), "Build the unpacked extension before live platform checks");
  mkdirSync(artifactRoot, { recursive: true });
  const targets = await waitForTargets(port, (items) => {
    const target = items.find((item) => item.type === "page" && /^https:\/\/www\.youtube\.com\//.test(item.url));
    return target || null;
  }, 45_000, "Initial YouTube page did not open");
  page = await Cdp.connect(targets.webSocketDebuggerUrl);
  await page.call("Page.enable");
  await page.call("Runtime.enable");

  worker = await connectExtensionWorker(port);
  worker.connection.on("Runtime.exceptionThrown", (params) => {
    extensionErrors.push(cleanError(params?.exceptionDetails?.text || "Extension runtime exception"));
  });
  await worker.connection.call("Runtime.enable");

  for (const spec of platforms) {
    await page.call("Page.navigate", { url: spec.url });
    await waitForDocument(page, spec.platform, 45_000);
    await dismissCommonConsent(page);
    await waitForIndicator(page, 20_000);
    await waitForScanEvidence(page, spec, 20_000);
    const snapshot = await pageValue(page, probeExpression(spec));
    const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(artifactRoot, `${spec.platform}.png`), Buffer.from(screenshot.data, "base64"));
    results.push(snapshot);
    assert.equal(snapshot.platform, spec.platform);
    assert.equal(snapshot.indicatorInjected, true, `${spec.platform} did not show the OriSlop live indicator`);
    assert.equal(snapshot.readyState, "complete", `${spec.platform} did not finish loading`);
    assert.ok(snapshot.title.length > 0, `${spec.platform} returned an empty page title`);
  }

  assert.equal(extensionErrors.length, 0, `Extension service worker errors: ${extensionErrors.join(" | ")}`);
  assert.ok(results.some((result) => result.candidateCount > 0), "No live platform returned a candidate");
  const popupSnapshot = await auditPopup(extensionIdFromUrl(worker.target.url));
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    browser,
    extensionId: extensionIdFromUrl(worker.target.url),
    allContentScriptsInjected: results.every((result) => result.indicatorInjected),
    extensionRuntimeErrors: extensionErrors,
    popup: popupSnapshot,
    results,
    limitations: [
      "Anonymous Instagram, TikTok, and LinkedIn pages may present authentication or regional interstitials.",
      "A zero live candidate count behind an authentication wall is not treated as selector proof; isolated DOM adapter tests remain the deterministic selector gate.",
      "No credentials or user browser profile are used by this smoke test."
    ]
  };
  writeFileSync(path.join(artifactRoot, "live-platform-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log("Live YouTube, Instagram, TikTok, and LinkedIn extension smoke checks passed");
} finally {
  page?.close();
  popup?.close();
  worker?.connection?.close();
  try {
    if (!browserConnection) {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (version?.webSocketDebuggerUrl) browserConnection = await Cdp.connect(version.webSocketDebuggerUrl);
    }
    if (browserConnection) await browserConnection.call("Browser.close");
  } catch {
    processHandle.kill();
  }
  browserConnection?.close();
  await delay(1_500);
  if (processHandle.exitCode === null) processHandle.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // A late browser utility process may briefly retain the isolated profile.
  }
}

async function auditPopup(extensionId) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  browserConnection = await Cdp.connect(version.webSocketDebuggerUrl);
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await browserConnection.call("Target.createTarget", { url: popupUrl });
  const target = await waitForTargets(port, (items) => (
    items.find((item) => item.type === "page" && item.url === popupUrl) || null
  ), 20_000, "OriSlop popup target did not open");
  popup = await Cdp.connect(target.webSocketDebuggerUrl);
  await popup.call("Page.enable");
  await popup.call("Runtime.enable");
  await popup.call("Emulation.setDeviceMetricsOverride", {
    width: 440,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false
  });
  const deadline = Date.now() + 20_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await pageValue(popup, `(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.body?.innerText || "").replace(/\\s+/g, " ").trim(),
      interactiveControls: document.querySelectorAll("button, input, select, [role='switch']").length
    }))()`);
    if (snapshot.readyState === "complete" && /LinkedIn/i.test(snapshot.bodyText) && snapshot.interactiveControls >= 4) break;
    await delay(300);
  }
  assert.equal(snapshot?.readyState, "complete", "OriSlop popup did not finish loading");
  assert.match(snapshot.bodyText, /LinkedIn/i, "OriSlop popup did not advertise LinkedIn coverage");
  assert.match(snapshot.bodyText, /1\.1\.0/, "OriSlop popup version is missing");
  assert.ok(snapshot.interactiveControls >= 4, "OriSlop popup controls did not render");
  const screenshot = await popup.call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true
  });
  writeFileSync(path.join(artifactRoot, "popup.png"), Buffer.from(screenshot.data, "base64"));
  return {
    title: snapshot.title,
    readyState: snapshot.readyState,
    linkedInCoverageVisible: /LinkedIn/i.test(snapshot.bodyText),
    versionVisible: /1\.1\.0/.test(snapshot.bodyText),
    interactiveControls: snapshot.interactiveControls,
    bodyTextLength: snapshot.bodyText.length
  };
}

function probeExpression(spec) {
  return `(() => {
    const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    const indicator = document.querySelector(".orislop-live-indicator");
    return {
      platform: ${JSON.stringify(spec.platform)},
      requestedUrl: ${JSON.stringify(spec.url)},
      finalUrl: location.href,
      host: location.hostname,
      title: document.title,
      readyState: document.readyState,
      indicatorInjected: Boolean(indicator),
      indicatorText: (indicator?.textContent || "").replace(/\\s+/g, " ").trim(),
      candidateCount: document.querySelectorAll(${JSON.stringify(spec.candidateSelector)}).length,
      processedCount: document.querySelectorAll("[data-orislop-processed]").length,
      trustButtonCount: document.querySelectorAll(".orislop-linkedin-trust-button").length,
      videoCount: document.querySelectorAll("video").length,
      authenticationPromptVisible: /log in|sign in|join linkedin|continue with google|create account/i.test(text.slice(0, 3000)),
      bodyTextLength: text.length
    };
  })()`;
}

async function waitForDocument(connection, platform, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await pageValue(connection, "({ readyState: document.readyState, host: location.hostname })");
    if (snapshot.readyState === "complete" && snapshot.host.includes(platform === "youtube" ? "youtube" : platform)) return;
    await delay(350);
  }
  throw new Error(`${platform} did not reach document.complete`);
}

async function waitForIndicator(connection, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageValue(connection, "Boolean(document.querySelector('.orislop-live-indicator'))")) return;
    await delay(350);
  }
}

async function waitForScanEvidence(connection, spec, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawNoCandidateAt = 0;
  while (Date.now() < deadline) {
    const snapshot = await pageValue(connection, probeExpression(spec));
    if (snapshot.candidateCount > 0 && (snapshot.processedCount > 0 || snapshot.trustButtonCount > 0)) return;
    if (snapshot.candidateCount === 0) {
      if (!sawNoCandidateAt) sawNoCandidateAt = Date.now();
      if (Date.now() - sawNoCandidateAt >= 2_000) return;
    }
    await delay(350);
  }
}

async function dismissCommonConsent(connection) {
  await pageValue(connection, `(() => {
    const wanted = /^(accept all|reject all|allow all cookies|decline optional cookies|continue without accepting)$/i;
    const button = Array.from(document.querySelectorAll("button, [role='button']"))
      .find((item) => wanted.test((item.textContent || "").replace(/\\s+/g, " ").trim()));
    if (button) button.click();
    return Boolean(button);
  })()`);
  await delay(600);
}

async function connectExtensionWorker(portNumber) {
  const target = await waitForTargets(portNumber, (items) => (
    items.find((item) => item.type === "service_worker"
      && /^chrome-extension:\/\//.test(item.url)
      && item.url.endsWith("/background.js")) || null
  ), 90_000, "OriSlop service worker did not start");
  return { target, connection: await Cdp.connect(target.webSocketDebuggerUrl) };
}

async function waitForTargets(portNumber, select, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${portNumber}/json`);
      const selected = Array.isArray(targets) ? select(targets) : null;
      if (selected) return selected;
    } catch {
      // Browser debugging endpoint may still be starting.
    }
    await delay(250);
  }
  throw new Error(errorMessage);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function pageValue(connection, expression) {
  const result = await connection.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

function extensionIdFromUrl(url) {
  return new URL(url).hostname;
}

function cleanError(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function findBrowser() {
  const override = process.env.ORISLOP_TEST_BROWSER;
  if (override && existsSync(override)) return override;
  const candidates = process.platform === "win32" ? [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/brave-browser"];
  const browserPath = candidates.find(existsSync);
  if (!browserPath) throw new Error("A Chromium browser is required for live platform checks");
  return browserPath;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
