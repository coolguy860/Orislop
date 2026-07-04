import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "apps", "web");
const sourceRoot = path.join(webRoot, "src");
const distRoot = path.join(webRoot, "dist");
const assetRoot = path.join(distRoot, "assets");
const downloadsRoot = path.join(distRoot, "downloads");
const tscPath = findTscPath();

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(assetRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });

execFileSync(process.execPath, [tscPath, "-p", path.join(webRoot, "tsconfig.json")], {
  cwd: repoRoot,
  stdio: "inherit"
});

rewriteModuleImports(assetRoot);

const css = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
writeFileSync(path.join(assetRoot, "styles.css"), css);
buildExtensionDownload();

writeFileSync(path.join(distRoot, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Orislop is an early static browser prototype for detecting online slop before it wastes your time." />
    <title>Orislop</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <div id="root">
      <noscript>
        <div class="no-script">Orislop needs JavaScript enabled for the static analyzer demo.</div>
      </noscript>
    </div>
    <script type="module" src="./assets/main.js"></script>
  </body>
</html>
`);

console.log(`Static web build ready: ${distRoot}`);

function rewriteModuleImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteModuleImports(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const original = readFileSync(fullPath, "utf8");
    const rewritten = original
      .replace(/from "(\.{1,2}\/[^"]+)(?<!\.js)";/g, 'from "$1.js";')
      .replace(/import\("(\.{1,2}\/[^"]+)(?<!\.js)"\)/g, 'import("$1.js")');
    if (rewritten !== original) {
      writeFileSync(fullPath, rewritten);
    }
  }
}

function buildExtensionDownload() {
  const extensionDist = path.join(repoRoot, "apps", "extension", "dist");
  const zipPath = path.join(downloadsRoot, "orislop-browser-extension.zip");

  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], {
    cwd: repoRoot,
    stdio: "inherit"
  });

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
}

function findTscPath() {
  const candidates = [
    path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"),
    path.join(repoRoot, "node_modules", ".pnpm", "typescript@6.0.3", "node_modules", "typescript", "lib", "tsc.js")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("TypeScript is not installed. Run pnpm install or restore node_modules/typescript.");
  }
  return found;
}
