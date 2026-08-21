import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(testRoot, "..", "dist", ".runtime-profiles");
mkdirSync(profileRoot, { recursive: true });
const browsers = findBrowsers();

{
  const youtubeWatch = runFixture("youtube-watch.html");
  assert.equal(youtubeWatch.platform, "youtube");
  assert.equal(youtubeWatch.itemId, "AbCdEf123_-");
  assert.equal(youtubeWatch.itemKind, "video");
  assert.equal(youtubeWatch.mediaType, "image", "Fast should analyze the bounded watch-page thumbnail");
  assert.equal(youtubeWatch.mediaUrl, "", "Fast watch-page coverage must not require the full video");
  assert.equal(youtubeWatch.previewUrl, "https://i.ytimg.com/vi/AbCdEf123_-/hqdefault.jpg");

  const instagram = runFixture("instagram.html");
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

  const tiktok = runFixture("tiktok.html");
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

  const linkedin = runFixture("linkedin.html");
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

  const linkedinVideo = runFixture("linkedin-video.html");
  assert.equal(linkedinVideo.mediaType, "video");
  assert.equal(linkedinVideo.fullVideoAnalysisRequested, false);
  assert.equal(linkedinVideo.trustLabel, "Video check on open");

  const explanation = runFixture("explanation.html");
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

function runFixture(name) {
  const fixture = path.join(testRoot, "fixtures", name);
  const failures = [];
  for (const browser of browsers) {
    const profile = mkdtempSync(path.join(profileRoot, "orislop-platform-dom-"));
    try {
      const output = execFileSync(browser, [
        "--headless=new",
        "--no-sandbox",
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
        `--user-data-dir=${profile}`,
        "--dump-dom",
        pathToFileURL(fixture).href
      ], { encoding: "utf8", timeout: 20000, windowsHide: true });
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
