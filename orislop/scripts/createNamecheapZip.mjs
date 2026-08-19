import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZipFromDirectoryContents, readZipEntries } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const rootDist = path.join(repoRoot, "dist");
const zipPath = path.join(rootDist, "orislop-namecheap-static.zip");
const indexPath = path.join(webDist, "index.html");

if (!existsSync(indexPath)) {
  throw new Error("apps/web/dist/index.html is missing. Run pnpm run web:build first.");
}

mkdirSync(rootDist, { recursive: true });
rmSync(zipPath, { force: true });
createZipFromDirectoryContents(webDist, zipPath);

const entries = readZipEntries(zipPath);

const requiredEntries = [
  "index.html",
  "privacy.html",
  "release-info.json",
  "assets/App.js",
  "assets/styles.css",
  "downloads/orislop-browser-extension.zip"
];

for (const requiredEntry of requiredEntries) {
  if (!entries.includes(requiredEntry)) {
    throw new Error(`Deploy ZIP must contain ${requiredEntry} at the expected path.`);
  }
}

const forbiddenPatterns = [
  /^node_modules\//i,
  /^\.git\//i,
  /\.env($|\.)/i,
  /\.map$/i,
  /^apps\//i,
  /^packages\//i,
  /^core\//i,
  /^configs\//i,
  /^scripts\//i,
  /electron/i,
  /checkpoint/i,
  /model\.safetensors/i,
  /pytorch_model/i
];

const forbiddenEntry = entries.find((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry.replaceAll("\\", "/"))));
if (forbiddenEntry) {
  throw new Error(`Deploy ZIP contains forbidden entry: ${forbiddenEntry}`);
}

console.log(`Namecheap deploy ZIP ready: ${zipPath}`);
