import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZipFromDirectoryContents, readZipEntries } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDist = path.join(repoRoot, "apps", "extension", "dist");
const rootDist = path.join(repoRoot, "dist");
const zipPath = path.join(rootDist, "orislop-browser-extension.zip");
const webStoreZipPath = path.join(rootDist, "orislop-browser-extension-webstore.zip");
const manifestPath = path.join(extensionDist, "manifest.json");

if (!existsSync(manifestPath)) {
  throw new Error("apps/extension/dist/manifest.json is missing. Run pnpm run extension:build first.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (Object.hasOwn(manifest, "key")) {
  throw new Error('Chrome Web Store packages must not include the forbidden manifest "key" field.');
}
if (manifest.manifest_version !== 3) {
  throw new Error("Chrome Web Store packages must use Manifest V3.");
}
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(String(manifest.version || ""))) {
  throw new Error("Extension manifest version must be a Chrome-compatible numeric version.");
}

mkdirSync(rootDist, { recursive: true });
rmSync(zipPath, { force: true });
rmSync(webStoreZipPath, { force: true });
createZipFromDirectoryContents(extensionDist, zipPath);

const entries = readZipEntries(zipPath);
const requiredEntries = [
  "manifest.json",
  "slopPreferences.js",
  "aiClassifierModel.generated.js",
  "background.js",
  "platformAdapters.js",
  "contentScript.js",
  "contentStyles.css",
  "popup.html",
  "popup.css",
  "popup.js",
  "release-info.json",
  "test-release.json",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "icons/icon256.png"
];

for (const requiredEntry of requiredEntries) {
  if (!entries.includes(requiredEntry)) {
    throw new Error(`Extension ZIP must contain ${requiredEntry}.`);
  }
}

copyFileSync(zipPath, webStoreZipPath);

console.log(`Browser extension ZIP ready: ${zipPath}`);
console.log(`Chrome Web Store upload ZIP ready: ${webStoreZipPath}`);
