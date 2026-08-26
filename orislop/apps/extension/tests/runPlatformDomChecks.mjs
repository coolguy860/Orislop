import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testRoot, "fixtures", "youtube.html");
const browsers = findBrowsers();
const result = runFixture();

assert.equal(result.platform, "youtube");
assert.equal(result.itemId, "youtubeShort123");
assert.equal(result.itemKind, "short");
assert.match(result.title, /AI voice compilation/i);
assert.equal(result.channelName, "examplecreator");
assert.equal(result.coverInsideMedia, true, "YouTube filtered covers must stay inside the video surface");
assert.deepEqual(result.coverActions, ["Show", "Hide"], "YouTube covers must expose only Show and Hide");
assert.equal(result.explainControlPresent, false, "the removed Explain video option must not render");
assert.equal(result.askControlPresent, false, "the removed Ask Orislop option must not render");
assert.match(result.liveIndicatorText, /Filtering 1 video/);
assert.equal(result.liveIndicatorVisible, true, "YouTube must visibly confirm that Orislop is scanning");

console.log("YouTube-only DOM checks passed");

function runFixture() {
  const failures = [];
  for (const browser of browsers) {
    const profile = mkdtempSync(path.join(os.tmpdir(), "orislop-youtube-dom-"));
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
      if (!encoded) throw new Error("YouTube fixture did not publish a result");
      return JSON.parse(decodeURIComponent(encoded.replaceAll("&amp;", "&")));
    } catch (error) {
      failures.push(`${path.basename(browser)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
  }
  throw new Error(`Every installed Chromium browser failed the YouTube fixture: ${failures.join(" | ")}`);
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
  if (found.length === 0) throw new Error("A Chromium browser is required for YouTube DOM checks");
  return found;
}
