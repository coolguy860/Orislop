import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "apps", "extension");
const sourceRoot = path.join(extensionRoot, "src");
const distRoot = path.join(extensionRoot, "dist");

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

const files = [
  ["manifest.json", "manifest.json"],
  ["src/background.js", "background.js"],
  ["src/contentScript.js", "contentScript.js"],
  ["src/contentStyles.css", "contentStyles.css"],
  ["src/popup.html", "popup.html"],
  ["src/popup.css", "popup.css"],
  ["src/popup.js", "popup.js"]
];

for (const [from, to] of files) {
  const source = path.join(extensionRoot, from);
  if (!existsSync(source)) {
    throw new Error(`Missing extension source file: ${source}`);
  }
  copyFileSync(source, path.join(distRoot, to));
}

console.log(`Browser extension build ready: ${distRoot}`);
