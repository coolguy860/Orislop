import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(readText(relativePath));

const packageJson = readJson("package.json");
const extensionManifest = readJson("apps/extension/manifest.json");
const vercel = readJson("vercel.json");
const provenance = readJson("configs/model_provenance.json");
const cloudHeavy = readJson("configs/cloud_heavy_v1.json");
const spatialMetrics = readJson("models/spatial/fusion_model_cls_v2.metrics.json");
const workflow = readText(".github/workflows/production.yml");
const cloudDockerfile = readText("apps/detector-bridge/Dockerfile.cloud");
const cloudCompose = readText("docker-compose.cloud.yml");
const companionInstaller = readText("apps/windows-companion/OrislopBootstrapper.iss");
const companionConfigure = readText("apps/windows-companion/configure-companion.ps1");
const companionBuild = readText("scripts/buildWindowsCompanion.ps1");
const vercelIgnore = readText(".vercelignore");
const lockfile = readText("pnpm-lock.yaml");
const requirements = readText("apps/detector-bridge/requirements.txt")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

assert.equal(packageJson.version, "1.3.0", "Root package version must match the 1.3.0 release");
assert.equal(packageJson.packageManager, "pnpm@11.9.0", "pnpm must be pinned for reproducible local, CI, and Vercel installs");
assert.equal(packageJson.engines?.node, ">=22.12 <25", "Supported Node range must be explicit");
assert.equal(packageJson.engines?.pnpm, "11.9.0", "pnpm engine must match packageManager");
assert.match(lockfile, /^lockfileVersion: '9\.0'/m, "Unexpected pnpm lockfile format");
assert.match(workflow, /version:\s*11\.9\.0/, "CI pnpm version must match packageManager");
assert.match(workflow, /python-version:\s*"3\.12"/, "CI Python must match the cloud runtime family");
assert.ok(
  workflow.includes("python -m pip install -r apps/detector-bridge/requirements.txt"),
  "CI must install the exact pinned detector dependency set before running Python contracts"
);
assert.match(
  workflow,
  /if:\s*success\(\)\s*&&\s*hashFiles\('dist\/release-manifest\.json'\)/,
  "CI must publish release artifacts only after the complete production gate succeeds"
);
assert.ok(!workflow.includes("if: always()"), "Failed production gates must never publish release candidates");

assert.equal(extensionManifest.version, packageJson.version, "Extension and root package versions differ");
const stableExtensionId = createHash("sha256")
  .update(Buffer.from(extensionManifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (character) => "abcdefghijklmnop"[Number.parseInt(character, 16)]);
assert.equal(stableExtensionId, "nhkffdhagjignajnmlgkgekpkfljhfdd", "Manifest key no longer matches the Chrome Web Store item");
assert.deepEqual(extensionManifest.permissions, ["storage", "identity"], "Extension permissions must remain limited to session state and Google sign-in");
assert.ok(!extensionManifest.host_permissions.includes("<all_urls>"), "Extension must not request <all_urls>");
for (const requiredHost of [
  "https://www.youtube.com/*",
  "https://www.instagram.com/*",
  "https://www.tiktok.com/*",
  "https://www.linkedin.com/*",
  "http://127.0.0.1:4317/*"
]) {
  assert.ok(extensionManifest.host_permissions.includes(requiredHost), `Missing required host permission: ${requiredHost}`);
}
assert.ok(!extensionManifest.host_permissions.some((origin) => origin.includes(":11434")), "Published extension must not expose Ollama directly");

assert.ok(!companionInstaller.includes("Tasks: configure"), "Companion security/runtime configuration must not be optional");
assert.match(companionInstaller, /Flags:\s*runhidden waituntilterminated/, "Installer must wait for companion configuration to finish");
assert.ok(companionConfigure.includes("$ollama.FullName"), "Installer must support a newly installed Ollama executable before PATH refresh");
assert.ok(companionConfigure.includes("$LASTEXITCODE -ne 0"), "Installer must fail when the required Qwen model cannot be installed");
assert.ok(companionBuild.indexOf("Get-Command signtool.exe") < companionBuild.indexOf("pip install"), "Companion builds must fail fast before installing packaging dependencies");
assert.ok(companionBuild.includes("HasPrivateKey") && companionBuild.includes("NotAfter"), "Companion builds must validate the signing certificate");

assert.equal(vercel.installCommand, "pnpm install --frozen-lockfile");
assert.equal(vercel.buildCommand, "pnpm run web:build");
assert.equal(vercel.outputDirectory, "apps/web/dist");
for (const excludedPath of [
  ".venv-detector/",
  ".cache/",
  "node_modules/",
  "training/",
  "apps/detector-bridge/",
  "apps/windows-companion/"
]) {
  assert.ok(vercelIgnore.includes(excludedPath), `Vercel upload boundary must exclude ${excludedPath}`);
}
for (const requiredBuildInput of ["apps/web/", "apps/extension/", "models/orislop_ai_classifier_v1.json", "scripts/*.mjs"]) {
  assert.ok(!vercelIgnore.includes(requiredBuildInput), `Vercel upload boundary must retain ${requiredBuildInput}`);
}
const globalHeaders = vercel.headers?.find((entry) => entry.source === "/(.*)")?.headers ?? [];
const headerNames = new Set(globalHeaders.map((header) => header.key.toLowerCase()));
for (const header of ["content-security-policy", "permissions-policy", "referrer-policy", "x-content-type-options", "x-frame-options"]) {
  assert.ok(headerNames.has(header), `Vercel is missing ${header}`);
}

assert.ok(requirements.length >= 10, "Detector dependency lock is unexpectedly small");
for (const requirement of requirements) {
  assert.match(requirement, /^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?==[^\s]+$/, `Python dependency is not exactly pinned: ${requirement}`);
}
assert.ok(requirements.some((requirement) => requirement.startsWith("truststore==")), "Windows trust-store support must be pinned");

assert.equal(provenance.schemaVersion, 1, "Unexpected model provenance schema");
const componentById = new Map(provenance.components.map((component) => [component.id, component]));
for (const [id, revision, license] of [
  [spatialMetrics.vision_model_id, spatialMetrics.vision_model_revision, "Apache-2.0"],
  [spatialMetrics.ai_model_id, spatialMetrics.ai_model_revision, "CC-BY-4.0"],
  [spatialMetrics.clip_model_id, spatialMetrics.clip_model_revision, "MIT"]
]) {
  const component = componentById.get(id);
  assert.ok(component, `Missing provenance record for ${id}`);
  assert.equal(component.revision, revision, `Pinned revision differs from trained spatial checkpoint for ${id}`);
  assert.equal(component.license, license, `Recorded license changed for ${id}; perform a fresh license review`);
  assert.equal(component.commercialUseApproved, true, `${id} has not been approved for commercial use`);
}
const unresolvedComponents = provenance.components.filter((component) => component.commercialUseApproved !== true);
if (unresolvedComponents.length > 0) {
  assert.equal(
    provenance.releaseGates?.automaticVisualFilteringEligible,
    false,
    "Automatic visual filtering cannot be release-eligible while model/data provenance is unresolved"
  );
  assert.match(cloudDockerfile, /ORISLOP_CLOUD_HEAVY_ROLLOUT=shadow/, "Cloud image must default to Cloud Heavy shadow mode");
  assert.match(cloudDockerfile, /ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES=0/, "Cloud image must disable beta hides by default");
  assert.match(cloudCompose, /ORISLOP_CLOUD_HEAVY_ROLLOUT:\s*\$\{ORISLOP_CLOUD_HEAVY_ROLLOUT:-shadow\}/, "Cloud Compose must default to Cloud Heavy shadow mode");
}
assert.equal(provenance.releaseGates?.requiredShadowDecisions, 10_000);
assert.equal(provenance.releaseGates?.maximumGenuineHideRate, 0.001);
assert.equal(provenance.releaseGates?.minimumEndToEndRecall, 0.9);
assert.equal(cloudHeavy.thresholds?.minimumValidationVideos, 1_000);
assert.equal(cloudHeavy.thresholds?.minimumValidationGenuineVideos, 500);
assert.equal(cloudHeavy.thresholds?.minimumValidationSyntheticVideos, 500);
assert.equal(cloudHeavy.thresholds?.requireHumanReviewedVideoLabels, true);
if (cloudHeavy.betaGatePassed === true || cloudHeavy.releaseGatePassed === true) {
  assert.ok(cloudHeavy.validation?.sampleGatePassed === true, "Heavy rollout requires the 1,000-video labeled sample gate");
  assert.ok(cloudHeavy.validation?.uniqueVideoSamples >= 1_000, "Heavy rollout validation must contain 1,000 unique videos");
  assert.equal(cloudHeavy.validation?.humanReviewedVideoSamples, cloudHeavy.validation?.validationSamples);
}

const tracked = listAuditedSourceFiles();
for (const forbidden of [".env", ".env.local", "apps/detector-bridge/.env.local"]) {
  assert.ok(!tracked.includes(forbidden), `Secret-bearing file is tracked: ${forbidden}`);
  if (isGitWorktree()) {
    execFileSync("git", ["check-ignore", "--no-index", "--quiet", forbidden], { cwd: repoRoot });
  } else {
    const ignoreRules = readText(".gitignore").split(/\r?\n/);
    assert.ok(
      ignoreRules.includes(forbidden) || ignoreRules.includes(path.posix.basename(forbidden)),
      `Exported source must ignore ${forbidden}`
    );
  }
}

const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[0-9A-Za-z_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /VERCEL_OIDC_TOKEN\s*=\s*[^\s#]+/
];
for (const relativePath of tracked) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
  const source = readText(relativePath);
  const matched = secretPatterns.find((pattern) => pattern.test(source));
  assert.equal(matched, undefined, `Tracked source appears to contain a secret: ${relativePath}`);
}

console.log("Release configuration, dependency pins, permissions, headers, and source-secret checks passed.");

function isGitWorktree() {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

function listAuditedSourceFiles() {
  if (isGitWorktree()) {
    return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  }
  const excludedDirectories = new Set([
    ".cache", ".git", ".venv-detector", ".vercel", "__pycache__",
    "build", "dist", "node_modules", "out"
  ]);
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(repoRoot);
  assert.ok(files.length >= 100, "Exported-source audit found too few files; the release tree may be incomplete");
  return files;
}
