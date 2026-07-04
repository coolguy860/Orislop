import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRoot = path.join(repoRoot, "apps", "extension", "dist");

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

const requiredFiles = [
  "manifest.json",
  "background.js",
  "contentScript.js",
  "contentStyles.css",
  "popup.html",
  "popup.css",
  "popup.js"
];

for (const file of requiredFiles) {
  assert.ok(existsSync(path.join(distRoot, file)), `Expected ${file} in extension dist`);
}

const manifest = JSON.parse(readFileSync(path.join(distRoot, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.ok(manifest.host_permissions.includes("https://www.youtube.com/*"));
assert.ok(manifest.content_scripts[0].matches.includes("https://www.youtube.com/*"));
assert.ok(manifest.content_scripts[0].js.includes("contentScript.js"));
assert.ok(manifest.content_scripts[0].css.includes("contentStyles.css"));
assert.equal(manifest.background.service_worker, "background.js");

const contentScript = readFileSync(path.join(distRoot, "contentScript.js"), "utf8");
assert.doesNotThrow(() => new Function(contentScript), "content script should parse as JavaScript");
assert.ok(contentScript.includes("MutationObserver"));
assert.ok(contentScript.includes("orislop-hidden-card"));
assert.ok(contentScript.includes("orislop-callout-card"));
assert.ok(contentScript.includes("orislop-status-pill"));
assert.ok(contentScript.includes("orislop-autoskip-toast"));
assert.ok(contentScript.includes("chrome.storage.local"));
assert.ok(contentScript.includes("scoreStaticSlop"));
assert.ok(contentScript.includes("orislop.extension.skippedLog"));
assert.ok(contentScript.includes("orislop.extension.settings"));
assert.ok(contentScript.includes("attemptAutoSkip"));
assert.ok(contentScript.includes("auto_skipped_short"));
assert.ok(contentScript.includes("auto_skipped_watch"));
assert.ok(contentScript.includes("hidden_card"));
assert.ok(contentScript.includes("LOOKAHEAD_LIMIT"));
assert.ok(contentScript.includes("WORKER_POOL_SIZE"));
assert.ok(contentScript.includes("WORKER_POOL_SIZE = 10"));
assert.ok(contentScript.includes("findLookaheadCandidateElements"));
assert.ok(contentScript.includes("scoreWithWorkers"));
assert.ok(contentScript.includes("orislop.scoreBatch"));
assert.ok(contentScript.includes("sendScoreBatchToBackground"));
assert.ok(!contentScript.includes("new Worker"), "content scripts should not create page-origin workers on YouTube");
assert.ok(contentScript.includes("scanQueued"), "scan events during active worker scoring should be queued");
assert.ok(contentScript.includes("isCurrentVideoCandidate"), "current videos should skip instead of being hidden in place");
assert.ok(contentScript.includes("preSkipScores"), "nearby Shorts should be pre-marked instead of hidden before they become current");
assert.ok(contentScript.includes("pre_skip"));
assert.ok(contentScript.includes("isActiveShortsScrollerCandidate"));
assert.ok(contentScript.includes("Orislop flagged this video. Skipping now."));
assert.ok(contentScript.includes("ArrowDown"));
assert.ok(contentScript.includes(".ytp-next-button"));
assert.ok(contentScript.includes("SIGNATURE_ATTR"), "cards must be rescored when YouTube loads metadata late");
assert.ok(contentScript.includes("yt-page-data-updated"), "YouTube navigation/data updates should trigger rescans");
assert.ok(contentScript.includes("altered or synthetic content"), "platform AI disclosure text should be detected");
assert.ok(contentScript.includes("ytd-rich-grid-media"), "newer YouTube rich-grid cards should be scanned");
assert.ok(!contentScript.includes("fetch("), "Extension must not call remote APIs");

const background = readFileSync(path.join(distRoot, "background.js"), "utf8");
assert.doesNotThrow(() => new Function(background), "background script should parse as JavaScript");
assert.ok(background.includes("chrome.runtime.onMessage"));
assert.ok(background.includes("WORKER_POOL_SIZE = 10"));
assert.ok(background.includes("orislop.scoreBatch"));
assert.ok(background.includes("scoreBatch"));
assert.ok(background.includes("altered or synthetic content"));
assert.ok(!background.includes("fetch("), "Background scorer must not call remote APIs");

const popupHtml = readFileSync(path.join(distRoot, "popup.html"), "utf8");
assert.ok(popupHtml.includes("autoSkipToggle"));
assert.ok(popupHtml.includes("hideFeedCardsToggle"));
assert.ok(popupHtml.includes("skippedList"));
assert.ok(popupHtml.includes("orislop-fusion"));
assert.ok(popupHtml.includes("deepfake-temporal-moe"));

const popupJs = readFileSync(path.join(distRoot, "popup.js"), "utf8");
assert.doesNotThrow(() => new Function(popupJs), "popup script should parse as JavaScript");
assert.ok(popupJs.includes("orislop.extension.skippedLog"));
assert.ok(popupJs.includes("orislop.extension.settings"));

console.log("extension checks passed");
