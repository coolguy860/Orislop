import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "apps", "extension");
const sourceRoot = path.join(extensionRoot, "src");
const distRoot = path.join(extensionRoot, "dist");
const testReleasePath = path.join(repoRoot, "PINNED_TEST_RELEASE.json");
const releaseId = "orislop-shield-autotune-1.3.0-2026-08-18";
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
  ["src/productTelemetry.js", "productTelemetry.js"],
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
  version: "1.3.0",
  distributionProfile: oauthClientId ? "hybrid-cloud-beta" : "local-only",
  cloudHeavyOAuthConfigured: Boolean(oauthClientId),
  requiredQaFixes: [
    "manifest declares 16/32/48/128/256 icons",
    "verdicts are binary: Don't skip or Skip",
    "candidate scanning covers every loaded feed item in bounded 10-item batches",
    "current, visible, nearby, and remaining loaded candidates receive immediate Fast screening before progressive refinement",
    "high-risk media is temporarily shielded inside its own video surface while required inference finishes",
    "Skip never emits scrolling or keyboard navigation; an active Short/Reel/TikTok advances with at most one semantic Next-button click",
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
    "Automatic performance selects Fast for weak or ambiguous local hardware hints and Heavy for capable PCs",
    "first-run Heavy autotuning rejects OOM, missing-expert, and output-changing layouts before persisting the fastest valid strategy",
    "Fast finalizes with the strict lightweight detector and never queues the large spatial or temporal models",
    "first-run feed choices cover the canonical 11-category slop taxonomy and default to filtering all categories",
    "the same user choices gate local heuristics, Qwen categories, synthetic-media auto-skips, and contradicted-claim auto-skips",
    "Hybrid keeps selective Fast-first escalation in Automatic mode and overlaps local preparation with Cloud Heavy in explicit Heavy mode on capable clients",
    "clear Local Fast results never consume a Cloud Heavy request",
    "Google authorization-code PKCE sign-in replaces manually pasted cloud tokens",
    "first-run disclosure and affirmative consent occur before any cloud media transmission",
    "decisions are cached by stable platform item id for consistent behavior",
    "the yellow decision cover is absolutely constrained to the video or Short surface",
    "YouTube, Instagram Reels, and TikTok adapters are isolated by host",
    "LinkedIn posts and profiles use annotation-first trust labels instead of automatic hiding",
    "LinkedIn lookahead is bounded to the next 100 loaded items in ten-item batches",
    "LinkedIn video thumbnails never produce an AI-video verdict; full visual analysis starts only after open or play",
    "LinkedIn image text is OCR-extracted on the companion and routed through the same source-backed claim checks",
    "AI-writing labels are advisory high-confidence style estimates and never claim proof of authorship or intent",
    "LinkedIn post and profile explanations include a grounded follow-up chatbot",
    "Instagram Reels and TikTok use semantic selectors plus video-root fallbacks for resilient feed discovery",
    "Instagram and TikTok captions exclude social controls before Ollama and fact-check scoring",
    "Apache-2.0 Qwen2.5 1.5B Ollama classification uses structured local output",
    "localhost Ollama access is a required host permission rather than an optional toggle",
    "localhost detector bridge access is a required host permission",
    "background and content scoring share the same classifier implementation",
    "production dashboard auto-checks engine health and supports a master protection pause",
    "toolbar ON/OFF/alert badges and live feed scanner status make active protection visible",
    "popup health loading never falsely reports setup failure before engine checks finish",
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
