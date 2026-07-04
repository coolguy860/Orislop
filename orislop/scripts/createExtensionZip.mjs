import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDist = path.join(repoRoot, "apps", "extension", "dist");
const rootDist = path.join(repoRoot, "dist");
const zipPath = path.join(rootDist, "orislop-browser-extension.zip");
const manifestPath = path.join(extensionDist, "manifest.json");

if (!existsSync(manifestPath)) {
  throw new Error("apps/extension/dist/manifest.json is missing. Run pnpm run extension:build first.");
}

mkdirSync(rootDist, { recursive: true });
if (existsSync(zipPath)) {
  rmSync(zipPath, { force: true });
}

const escapedSource = extensionDist.replaceAll("'", "''");
const escapedZip = zipPath.replaceAll("'", "''");
const compressScript = [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$source = '${escapedSource}'`,
  `$zip = '${escapedZip}'`,
  "$items = Get-ChildItem -LiteralPath $source",
  "Compress-Archive -LiteralPath $items.FullName -DestinationPath $zip -Force"
].join("; ");

execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", compressScript], {
  cwd: repoRoot,
  stdio: "inherit"
});

console.log(`Browser extension ZIP ready: ${zipPath}`);
