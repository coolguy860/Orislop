import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(testRoot, "..", "..", "..", ".cache", "extension-test-profiles");
mkdirSync(profileRoot, { recursive: true });
const browsers = findBrowsers();

{
  const youtubeWatch = await runFixture("youtube-watch.html");
  assert.equal(youtubeWatch.platform, "youtube");
  assert.equal(youtubeWatch.itemId, "AbCdEf123_-");
  assert.equal(youtubeWatch.itemKind, "video");
  assert.equal(youtubeWatch.mediaType, "image", "Fast should analyze the bounded watch-page thumbnail");
  assert.equal(youtubeWatch.mediaUrl, "", "Fast watch-page coverage must not require the full video");
  assert.equal(youtubeWatch.previewUrl, "https://i.ytimg.com/vi/AbCdEf123_-/hqdefault.jpg");

  const instagram = await runFixture("instagram.html");
  assert.equal(instagram.platform, "instagram");
  assert.equal(instagram.itemId, "C123abc");
  assert.equal(instagram.itemKind, "short");
  assert.equal(instagram.creator, "climate.lab");
  assert.match(instagram.title, /climate study/i);
  assert.doesNotMatch(instagram.visibleText, /12\.4K/);
  assert.equal(instagram.mediaUrl, "https://scontent.cdninstagram.com/video.mp4");
  assert.equal(instagram.previewUrl, "https://scontent.cdninstagram.com/preview.jpg");
  assert.equal(instagram.mediaHost, "media");
  assert.equal(instagram.factCheckEligible, true);

  const tiktok = await runFixture("tiktok.html");
  assert.equal(tiktok.platform, "tiktok");
  assert.equal(tiktok.itemId, "741234567891");
  assert.equal(tiktok.itemKind, "short");
  assert.equal(tiktok.creator, "historyteacher");
  assert.match(tiktok.title, /historian explains/i);
  assert.doesNotMatch(tiktok.visibleText, /Like 8\.2K|Share/);
  assert.equal(tiktok.mediaUrl, "https://v16m-default.akamaized.net/video.mp4");
  assert.equal(tiktok.previewUrl, "https://p16.tiktokcdn.com/preview.jpg");
  assert.equal(tiktok.mediaHost, "media");
  assert.equal(tiktok.factCheckEligible, true);

  const linkedin = await runFixture("linkedin.html");
  assert.equal(linkedin.platform, "linkedin");
  assert.equal(linkedin.itemId, "123456789");
  assert.equal(linkedin.itemKind, "post");
  assert.equal(linkedin.creator, "Alex Example");
  assert.match(linkedin.title, /retention increased/i);
  assert.match(linkedin.imageText, /retention rose 42 percent/i);
  assert.equal(linkedin.previewUrl, "https://media.licdn.com/dms/image/example");
  assert.equal(linkedin.mediaType, "image");
  assert.equal(linkedin.fullVideoAnalysisRequested, true);
  assert.equal(linkedin.factCheckEligible, true);

  const linkedinVideo = await runFixture("linkedin-video.html");
  assert.equal(linkedinVideo.mediaType, "video");
  assert.equal(linkedinVideo.fullVideoAnalysisRequested, false);
  assert.equal(linkedinVideo.trustLabel, "Video check on open");

  const explanation = await runFixture("explanation.html");
  assert.equal(explanation.explainButton, "Explain video");
  assert.equal(explanation.panelInsideMedia, true, "explanation panel must stay inside the video surface");
  assert.match(explanation.panelText, /How rainbows form/);
  assert.match(explanation.panelText, /What Orislop cannot confirm/);
  assert.equal(explanation.sourceHref, "https://www.cdc.gov/example");
  assert.equal(explanation.sourceRel, "noopener noreferrer");
  assert.equal(explanation.contradictedAction, "Why is this wrong?");
  assert.equal(explanation.coverInsideMedia, true, "Skip cover must stay inside the video surface");
  assert.equal(explanation.chatEnabled, true, "contradicted fact checks must expose grounded follow-up questions");
  assert.equal(explanation.chatInsideMedia, true, "fact-check chat must stay inside the video surface");
  assert.equal(explanation.chatPlaceholder, "Ask a follow-up question...");
  assert.match(explanation.chatText, /checked CDC evidence does not support/i);
  assert.match(explanation.chatText, /does not answer unrelated medical questions/i);
  assert.match(explanation.liveIndicatorText, /Orislop is checking 3 videos/);
  assert.equal(explanation.liveIndicatorVisible, true, "supported feeds must visibly confirm that Orislop is scanning");

  console.log("YouTube watch, Instagram, TikTok, LinkedIn, and explanation Chromium DOM checks passed");
}

async function runFixture(name) {
  const fixture = path.join(testRoot, "fixtures", name);
  const failures = [];
  for (const browser of browsers) {
    const profile = mkdtempSync(path.join(profileRoot, "orislop-platform-dom-"));
    try {
      const output = await runBrowser(browser, [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-gpu-compositing",
        "--use-gl=disabled",
        "--disable-features=Vulkan,Dawn,Graphite,UseSkiaRenderer,VizDisplayCompositor",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-default-browser-check",
        "--no-proxy-server",
        "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost",
        "--allow-file-access-from-files",
        "--no-first-run",
        "--virtual-time-budget=8000",
        `--user-data-dir=${profile}`,
        "--dump-dom",
        pathToFileURL(fixture).href
      ]);
      const encoded = output.match(/data-result="([^"]+)"/)?.[1];
      if (!encoded) throw new Error(`Browser fixture ${name} did not publish a result`);
      return JSON.parse(decodeURIComponent(encoded.replaceAll("&amp;", "&")));
    } catch (error) {
      failures.push(`${path.basename(browser)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
  }
  throw new Error(`Every installed Chromium browser failed fixture ${name}: ${failures.join(" | ")}`);
}

function runBrowser(browser, arguments_) {
  if (process.platform === "win32") {
    return Promise.resolve(execFileSync(browser, arguments_, {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true
    }));
  }

  const maxOutputBytes = 4 * 1024 * 1024;
  const timeoutMs = 30000;
  return new Promise((resolve, reject) => {
    const child = spawn(browser, arguments_, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;

    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const capture = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminateBrowserTree(child);
        finish(new Error(`Browser output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      terminateBrowserTree(child);
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        finish(null, output);
        return;
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8").slice(-2000);
      finish(new Error(`Browser exited with code ${code ?? "none"} signal ${signal ?? "none"}: ${diagnostic}`));
    });

    timer = setTimeout(() => {
      terminateBrowserTree(child);
      const diagnostic = Buffer.concat(stderr).toString("utf8").slice(-2000);
      finish(new Error(`Browser exceeded ${timeoutMs}ms and was terminated: ${diagnostic}`));
    }, timeoutMs);
    timer.unref();
  });
}

function terminateBrowserTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process may have exited between the timeout and tree termination.
  }
}

function findBrowsers() {
  const override = process.env.ORISLOP_TEST_BROWSER;
  if (override && existsSync(override)) return [override];
  const candidates = process.platform === "win32" ? [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  ] : ["/usr/bin/brave-browser", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const found = candidates.filter(existsSync);
  if (found.length === 0) throw new Error("A Chromium browser is required for platform DOM checks");
  return found;
}
