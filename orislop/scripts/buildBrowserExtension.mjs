import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "apps", "extension");
const sourceRoot = path.join(extensionRoot, "src");
const distRoot = path.join(extensionRoot, "dist");
const testReleasePath = path.join(repoRoot, "PINNED_TEST_RELEASE.json");
const releaseId = "orislop-extension-1.4.0-2026-08-25";
const oauthClientId = String(process.env.ORISLOP_GOOGLE_OAUTH_CLIENT_ID || "").trim();
if (oauthClientId && !/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(oauthClientId)) {
  throw new Error("ORISLOP_GOOGLE_OAUTH_CLIENT_ID is not a valid Google OAuth client ID");
}
if (process.argv.includes("--cloud-beta") && !oauthClientId) {
  throw new Error("Cloud Heavy beta builds require ORISLOP_GOOGLE_OAUTH_CLIENT_ID");
}

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });
mkdirSync(path.join(distRoot, "icons"), { recursive: true });

const files = [
  ["manifest.json", "manifest.json"],
  ["src/slopPreferences.js", "slopPreferences.js"],
  ["src/aiClassifierModel.generated.js", "aiClassifierModel.generated.js"],
  ["src/oauthConfig.generated.js", "oauthConfig.generated.js"],
  ["src/classifier.js", "classifier.js"],
  ["src/platformAdapters.js", "platformAdapters.js"],
  ["src/controlCore.js", "controlCore.js"],
  ["src/background.js", "background.js"],
  ["src/contentScript.js", "contentScript.js"],
  ["src/contentStyles.css", "contentStyles.css"],
  ["src/popup.html", "popup.html"],
  ["src/popup.css", "popup.css"],
  ["src/popup.js", "popup.js"],
  ["src/icons/icon16.png", "icons/icon16.png"],
  ["src/icons/icon32.png", "icons/icon32.png"],
  ["src/icons/icon48.png", "icons/icon48.png"],
  ["src/icons/icon128.png", "icons/icon128.png"],
  ["src/icons/icon256.png", "icons/icon256.png"]
];

for (const [from, to] of files) {
  const source = path.join(extensionRoot, from);
  if (!existsSync(source)) {
    throw new Error(`Missing extension source file: ${source}`);
  }
  copyFileSync(source, path.join(distRoot, to));
}

if (existsSync(testReleasePath)) {
  copyFileSync(testReleasePath, path.join(distRoot, "test-release.json"));
}

const oauthConfigPath = path.join(distRoot, "oauthConfig.generated.js");
const oauthConfig = readFileSync(oauthConfigPath, "utf8").replace(
  "__ORISLOP_GOOGLE_OAUTH_CLIENT_ID__",
  oauthClientId
);
writeFileSync(oauthConfigPath, oauthConfig);

writeFileSync(path.join(distRoot, "release-info.json"), `${JSON.stringify({
  releaseId,
  builtAt: new Date().toISOString(),
  app: "orislop-browser-extension",
  version: "1.4.0",
  distributionProfile: oauthClientId ? "hybrid-cloud-beta" : "local-only",
  cloudHeavyOAuthConfigured: Boolean(oauthClientId),
  requiredQaFixes: [
    "manifest declares 16/32/48/128/256 icons",
    "the manifest and content script are limited to YouTube and YouTube Shorts",
    "unused Instagram, TikTok, LinkedIn, cloud API, and identity permissions are removed",
    "filtering is enabled by default and begins without onboarding or a Start filtering action",
    "the Explain video and Ask Orislop controls are removed from the YouTube experience",
    "filtered content is reversible through clear Show and Hide actions",
    "candidate scanning prioritizes the current YouTube item",
    "current and nearby loaded candidates receive immediate Fast screening before progressive refinement",
    "high-risk media is temporarily shielded inside its own video surface while required inference finishes",
    "Skip never emits keyboard navigation; an active YouTube Short advances with one semantic Next-button click or one feed scroll",
    "every uniquely skipped video counts as a fixed 20 seconds saved instead of its full runtime",
    "explicit AI/synthetic disclosures and synthetic narration trigger a non-vetoable 100/100 Skip",
    "all non-AI verdicts come from the required Ollama classifier",
    "uncorroborated Ollama Skip verdicts cannot override protected educational context",
    "gonnerthetooner/orislop-fusion inspects sampled video frames through the local detector bridge",
    "cloud-heavy-v1 combines orislop-fusion and the pinned public frame model into one spatial-family probability",
    "the pinned AEGIS motion-only branch is the independent temporal vote and the legacy Temporal MoE cannot vote online",
    "corroborated spatial-family and motion results trigger a reversible 100/100 Skip while isolated model spikes fail open",
    "uncached visual scans are queued locally and polled without blocking or scrolling the feed",
    "current-video visual scans preempt background lookahead work in both lightweight and heavyweight queues",
    "a strict lightweight frame detector returns reversible provisional decisions while heavyweight models load",
    "the MVP forces every eligible video through Heavy analysis",
    "first-run Heavy autotuning rejects OOM, missing-expert, and output-changing layouts before persisting the fastest valid strategy",
    "the canonical 11-category slop taxonomy defaults to filtering all categories",
    "the same user choices gate local heuristics, Qwen categories, synthetic-media auto-skips, and contradicted-claim auto-skips",
    "decisions are cached by stable platform item id for consistent behavior",
    "the yellow decision cover is absolutely constrained to the video or Short surface",
    "Apache-2.0 Qwen2.5 1.5B Ollama classification uses structured local output",
    "localhost Ollama access is a required host permission rather than an optional toggle",
    "localhost detector bridge access is a required host permission",
    "background and content scoring share the same classifier implementation",
    "the popup exposes one primary filtering control and moves activity, preferences, and diagnostics into intentional secondary views",
    "the popup keeps one stable protected state and hides engine and model controls behind the diagnostics payload",
    "in-feed and activity decisions use short human reasons instead of raw detector output",
    "unchanged decision covers are reused across rescans so buttons and visual state do not flicker",
    "toolbar ON/OFF/alert badges and a quiet feed indicator make filtering state visible without exposing pipeline internals",
    "popup loading preserves visual stability and never flashes a false disabled, offline, or zero state",
    "the supplied Orislop Feed Cut identity ships as optimized 16/32/48/128/256 Chrome icons",
    "Chrome Web Store-compatible raster icons ship at 16/32/48/128/256 sizes",
    "Ollama work is concurrency-limited, time-budgeted, cached, and partially recoverable",
    "resource-aware Heavy execution overlaps temporal AV and visual motion branches with an automatic OOM circuit breaker",
    "capable clients increase local context preparation and lookahead concurrency without weakening Heavy model coverage",
    "detector bridge exposes versioned health, readiness, metrics, rate limits, and security headers",
    "informational Shorts use asynchronous source-backed fact checking with conservative fail-open decisions",
    "fact-check Skip requires at least 0.88 confidence and two independent trusted source domains",
    "ClaimReview rating direction and claim relevance are deterministically checked after Qwen adjudication",
    "evidence provider keys stay in the local bridge and are never embedded in the extension"
  ]
}, null, 2)}\n`);

console.log(`Browser extension build ready: ${distRoot}`);
