import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeSteps = [
  ["Release configuration", "scripts/checkReleaseConfiguration.mjs"],
  ["Cloud deployment", "scripts/checkCloudDeployment.mjs"],
  ["AI artifact integrity", "scripts/syncAiClassifierArtifacts.mjs", "--check"],
  ["TypeScript", "scripts/runTsc.mjs", "--noEmit"],
  ["Web product", "apps/web/tests/runWebChecks.mjs"],
  ["AI classifier", "apps/web/tests/runAiClassifierChecks.mjs"],
  ["Extension", "apps/extension/tests/runExtensionChecks.mjs"],
  ["Product telemetry and request policy", "apps/extension/tests/runProductTelemetryChecks.mjs"],
  ["Cross-platform 128-item launch corpus", "scripts/auditCrossPlatformLaunchCorpus.mjs"],
  ["Cross-platform DOM adapters", "apps/extension/tests/runPlatformDomChecks.mjs"],
  ["Inference adapters", "packages/local-inference/tests/runAdapterChecks.mjs"],
  ["Calibration", "packages/slop-engine/tests/runCalibrationChecks.mjs"],
  ["Claim-aware scoring", "packages/slop-engine/tests/runClaimAwareChecks.mjs"],
  ["Fixtures", "packages/slop-engine/tests/runFixtures.mjs"],
  ["Storage", "packages/storage/tests/runStorageChecks.mjs"],
  ["Desktop", "apps/desktop/tests/runDesktopChecks.mjs"],
  ["Lookahead", "apps/desktop/tests/runLookaheadChecks.mjs"],
  ["Skip controls", "apps/desktop/tests/runSkipControllerChecks.mjs"],
  ["YouTube extraction", "apps/desktop/tests/runYoutubeExtractorChecks.mjs"]
];

for (const [label, script, ...args] of nodeSteps) run(label, process.execPath, [path.join(repoRoot, script), ...args]);

const localPython = path.join(repoRoot, ".venv-detector", "Scripts", "python.exe");
const configuredPython = String(process.env.ORISLOP_PYTHON_PATH || "").trim();
const python = configuredPython || (existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");
run("Detector bridge", python, [
  "-m", "unittest", "discover",
  "-s", path.join(repoRoot, "apps", "detector-bridge", "tests"),
  "-p", "test_*.py"
]);
run("Temporal Colab pipeline", python, [path.join(repoRoot, "training", "orislop_temporal_retrain", "tests", "test_cached_fusion_pipeline.py")]);

run("Production web build", process.execPath, [path.join(repoRoot, "scripts", "buildWebStatic.mjs")]);
run("Chrome Web Store package", process.execPath, [path.join(repoRoot, "scripts", "createExtensionZip.mjs")]);
run("Chrome Web Store assets", process.execPath, [path.join(repoRoot, "scripts", "verifyWebStoreAssets.mjs")]);
run("Static deploy package", process.execPath, [path.join(repoRoot, "scripts", "createNamecheapZip.mjs")]);
run("Release integrity manifest", process.execPath, [path.join(repoRoot, "scripts", "createReleaseManifest.mjs")]);
run("Release verification", process.execPath, [path.join(repoRoot, "scripts", "verifyReleaseArtifacts.mjs")]);

const manifest = JSON.parse(readFileSync(path.join(repoRoot, "apps", "extension", "manifest.json"), "utf8"));
if (manifest.version !== "1.3.0" || manifest.name !== "Orislop Shield") throw new Error("Production extension identity is not locked");
if (Object.hasOwn(manifest, "key")) throw new Error('Production extension manifest contains forbidden "key" field');
if (Object.values(manifest.icons).some((value) => !value.endsWith(".png"))) throw new Error("Chrome manifest still references a non-raster icon");

console.log("\nOrislop production readiness checks passed.");

function run(label, executable, args) {
  console.log(`\n[production] ${label}`);
  execFileSync(executable, args, { cwd: repoRoot, stdio: "inherit" });
}
