import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZipFromDirectoryContents, readZipEntries } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "apps", "web");
const sourceRoot = path.join(webRoot, "src");
const distRoot = path.join(webRoot, "dist");
const assetRoot = path.join(distRoot, "assets");
const downloadsRoot = path.join(distRoot, "downloads");
const brandRoot = path.join(repoRoot, "assets", "brand");
const tscPath = findTscPath();
const releaseId = "orislop-shield-web-1.3.0-2026-08-18";
const modelSource = readFileSync(path.join(repoRoot, "models", "orislop_ai_classifier_v1.json"), "utf8").replace(/\r\n?/g, "\n");
const modelArtifactHash = createHash("sha256").update(modelSource).digest("hex");
const modelFeatureCount = JSON.parse(modelSource).features.length;

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(assetRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "syncAiClassifierArtifacts.mjs"), "--check"], {
  cwd: repoRoot,
  stdio: "inherit"
});

execFileSync(process.execPath, [tscPath, "-p", path.join(webRoot, "tsconfig.json")], {
  cwd: repoRoot,
  stdio: "inherit"
});

rewriteModuleImports(assetRoot);

const css = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
writeFileSync(path.join(assetRoot, "styles.css"), css);
cpSync(brandRoot, path.join(assetRoot, "brand"), { recursive: true });
buildExtensionDownload();
writeReleaseInfo();

writeFileSync(path.join(distRoot, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Orislop Shield is privacy-conscious feed intelligence for YouTube, Instagram Reels, TikTok, and LinkedIn." />
    <meta name="theme-color" content="#080c12" />
    <meta name="robots" content="index,follow" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Orislop Shield · Your attention deserves a firewall" />
    <meta property="og:description" content="Clean up repetitive, synthetic, and low-value feed content while useful and uncertain posts stay visible." />
    <meta property="og:url" content="https://orislop.com" />
    <meta name="orislop-release" content="${releaseId}" />
    <link rel="canonical" href="https://orislop.com" />
    <link rel="icon" href="./assets/brand/orislop_feedcut_icon.svg" type="image/svg+xml" />
    <link rel="icon" href="./assets/brand/icon_32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="./assets/brand/icon_256.png" />
    <title>Orislop Shield · A calmer feed without the guesswork</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <div id="root">
      <noscript>
        <div class="no-script">Orislop Shield needs JavaScript enabled for the analyzer.</div>
      </noscript>
      <section class="static-load-fallback" aria-live="polite">
        <p class="eyebrow">Orislop Shield</p>
        <h1>Serve this build over HTTP.</h1>
        <p>
          If this message stays on screen, the JavaScript module did not load. Do not open
          <code>index.html</code> directly with <code>file://</code>. Run
          <code>pnpm run web:preview</code> and open the printed local URL, or upload the
          build to normal HTTPS hosting.
        </p>
      </section>
    </div>
    <script type="module" src="./assets/main.js"></script>
  </body>
</html>
`);

writeFileSync(path.join(distRoot, "privacy.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Orislop Shield privacy policy for the website, browser extension, local companion, and optional cloud inference." />
    <meta name="orislop-release" content="${releaseId}" />
    <title>Orislop Privacy Policy</title>
    <link rel="icon" href="./assets/brand/orislop_feedcut_icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <main class="site-shell">
      <section class="panel">
        <p class="eyebrow">Orislop</p>
        <h1>Privacy Policy</h1>
        <p>
          Orislop Shield's website remains local-first. The extension supports a local companion and an optional
          authenticated cloud inference mode. The website does not require an account, does not include a secret
          YouTube API key, does not scrape comments, and does not upload local video files.
        </p>
        <h2>Static Website</h2>
        <p>
          The analyzer scores YouTube URLs, optional titles, optional descriptions, and decision-lab rows in
          your browser. When the live context checker is connected, the YouTube URL and text you entered are sent
          through an Orislop server-side proxy for a Qwen second opinion. The API credential never reaches your
          browser. Local file selections, feedback, settings, and decision-lab logs are not sent by that request.
          Feedback such as Accurate or Wrong is stored in your browser's local storage on your device.
        </p>
        <h2>Browser Extension</h2>
        <p>
          The extension stores settings, skipped items, and flagged items in Chrome or Edge extension
          storage. These records are local to your browser profile. They are used to show counts and recent
          reasons in the popup.
        </p>
        <p>
        In local mode, extension 1.3.0 sends supported YouTube, Instagram, TikTok, and LinkedIn page or public
          media URLs to the Orislop detector companion on your own device at 127.0.0.1. The companion may download
          public media temporarily for analysis and deletes the temporary file after the scan. A LinkedIn video is
          not sent for visual analysis from its feed preview; that analysis begins only after you open or play it.
        </p>
        <p>
          In cloud mode, the extension sends the supported page URL, public media URL when available, title,
          creator name, visible caption or metadata, and an extracted transcript excerpt to
          <code>https://api.orislop.com</code>. The service uses that data for Qwen context scoring, visual
          authenticity analysis, and source-backed fact checking. It does not receive browser cookies, account
          credentials, private messages, or general browsing history. Media working files are temporary; detector
          decisions may remain in bounded in-memory caches for up to six hours and fact-check results for up to
          twelve hours to reduce repeated GPU and evidence requests. Request bodies are not written by Orislop's
          application logger.
        </p>
        <h2>Source-Backed Fact Checking</h2>
        <p>
          When fact checking is enabled, Qwen extracts checkable informational claims in the selected inference
          environment. The local companion or Orislop cloud service sends those claim search queries to the selected
          Brave Search or Google Fact Check provider. Provider keys remain in the companion or cloud secret manager
          and are not exposed to the extension. Returned source titles, URLs, snippets, ratings, and the evidence
          decision may be cached in service memory and stored with local extension activity. Media, account cookies,
          and browsing credentials are not sent with source searches.
        </p>
        <h2>Local Frame Lab</h2>
        <p>
          The optional local frame lab samples a file selected from your device with browser video and
          canvas APIs. It reports simple frame-change, repetition, and pacing metrics locally. It is not the
          full PyTorch temporal detector and does not upload the selected file.
        </p>
        <h2>Deleting Data</h2>
        <p>
          On the website, clear browser site data for the Orislop domain to remove locally stored settings
          and feedback. In the extension popup, use Clear flagged, Clear skipped, or Clear all local Orislop data
          to remove extension logs.
        </p>
        <p>
          Cloud inference caches expire automatically. During the closed beta, contact the address published on
          orislop.com with the request identifier and approximate request time for operational deletion assistance.
        </p>
        <h2>Detection Limits</h2>
        <p>
          The web demo combines transparent local scoring with an optional live text-context second opinion. It can
          be wrong and does not run the full spatial or temporal PyTorch model on a pasted YouTube URL. Full media
          analysis requires the extension to access supported media. Source-assisted fact checking can also be
          incomplete or wrong and should not be treated as a guarantee of truth or a factual deepfake verdict.
        </p>
        <p><a class="primary-link" href="./index.html">Back to Orislop</a></p>
      </section>
    </main>
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
  const standaloneZipPath = path.join(repoRoot, "dist", "orislop-browser-extension.zip");

  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildBrowserExtension.mjs")], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  const extensionManifest = JSON.parse(readFileSync(path.join(extensionDist, "manifest.json"), "utf8"));
  if (Object.hasOwn(extensionManifest, "key")) {
    throw new Error('The downloadable extension cannot include the forbidden manifest "key" field.');
  }

  createZipFromDirectoryContents(extensionDist, zipPath);
  mkdirSync(path.dirname(standaloneZipPath), { recursive: true });
  copyFileSync(zipPath, standaloneZipPath);

  const entries = readZipEntries(zipPath);
  const requiredEntries = [
    "manifest.json",
    "aiClassifierModel.generated.js",
    "background.js",
    "contentScript.js",
    "contentStyles.css",
    "popup.html",
    "popup.css",
    "popup.js",
    "release-info.json"
  ];

  for (const requiredEntry of requiredEntries) {
    if (!entries.includes(requiredEntry)) {
      throw new Error(`Embedded extension ZIP is missing ${requiredEntry}.`);
    }
  }
  if (entries.some((entry) => entry.startsWith("dist/"))) {
    throw new Error("Embedded extension ZIP must contain extension files at the archive root, not under dist/.");
  }

  console.log(`Embedded and standalone browser extension ZIPs ready: ${zipPath} (${entries.length} files)`);
}

function writeReleaseInfo() {
  writeFileSync(path.join(distRoot, "release-info.json"), `${JSON.stringify({
    releaseId,
    builtAt: new Date().toISOString(),
    app: "orislop-static-web",
    aiClassifierArtifactHash: modelArtifactHash,
    aiClassifierFeatureCount: modelFeatureCount,
    requiredQaFixes: [
      "fail-closed analyzer validation",
      "visible Don't skip/Skip definitions",
      "visible strictness thresholds and multipliers",
      "score breakdown with base points, stacked boost, multiplier, and thresholds",
      "privacy.html included at archive root",
      "downloadable browser extension zip included under downloads/",
      "extension icons include Chrome-compatible 16/32/48/128/256 PNG sizes",
      "file:// fallback explains that the static app must be served over HTTP",
      "satisfying/ASMR content is calibrated as weaker evidence unless stacked with low-originality signals",
      "Orislop AI Classifier v1 runs locally over text/metadata",
      "AI classifier training excludes heuristic labels so fusion sources remain independent",
      "combined score reports heuristic, AI classifier, transcript, channel, and spatiotemporal source status",
      "primary result stays compact while technical evidence remains available on demand",
      "feedback shows a persistent local selected state",
      "placeholder sample IDs do not issue thumbnail or embed requests",
      "production metadata and Vercel security headers are configured",
      "same-origin live context AI uses a server-side token and friendly local fallback",
      "Chrome Web Store package rejects the forbidden manifest key field"
    ]
  }, null, 2)}\n`);
}

function findTscPath() {
  const candidates = [
    process.env.ORISLOP_TSC_PATH,
    path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"),
    path.join(repoRoot, "node_modules", ".pnpm", "typescript@6.0.3", "node_modules", "typescript", "lib", "tsc.js"),
    path.join(repoRoot, ".cache", "tsc-fallback", "package", "lib", "tsc.js")
  ];
  const found = candidates.filter(Boolean).find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      const descriptor = openSync(candidate, "r");
      closeSync(descriptor);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error("No readable TypeScript compiler was found. Run pnpm install after fixing registry or antivirus access.");
  }
  return found;
}
