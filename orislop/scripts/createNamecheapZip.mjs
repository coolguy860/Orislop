import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const rootDist = path.join(repoRoot, "dist");
const zipPath = path.join(rootDist, "orislop-namecheap-static.zip");
const indexPath = path.join(webDist, "index.html");

if (!existsSync(indexPath)) {
  throw new Error("apps/web/dist/index.html is missing. Run pnpm run web:build first.");
}

mkdirSync(rootDist, { recursive: true });
if (existsSync(zipPath)) {
  rmSync(zipPath, { force: true });
}

const escapedSource = webDist.replaceAll("'", "''");
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

const listScript = [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$zip = '${escapedZip}'`,
  "$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)",
  "try { $archive.Entries | ForEach-Object { $_.FullName } } finally { $archive.Dispose() }"
].join("; ");

const entries = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", listScript], {
  cwd: repoRoot,
  encoding: "utf8"
}).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);

if (!entries.includes("index.html")) {
  throw new Error("Deploy ZIP must contain index.html at the archive root.");
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
