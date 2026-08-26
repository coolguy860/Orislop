import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const dockerfile = read("apps/detector-bridge/Dockerfile.cloud");
const entrypoint = read("apps/detector-bridge/cloud-heavy-entrypoint.sh");
const compose = read("docker-compose.cloud.yml");
const dockerignore = read(".dockerignore");
const server = read("apps/detector-bridge/server.py");
const manifest = JSON.parse(read("apps/extension/manifest.json"));
const workflow = read(".github/workflows/cloud-image.yml");
const deploymentGuide = read("docs/CLOUD_DEPLOYMENT.md");

assert.match(dockerfile, /^FROM nvidia\/cuda:12\.8\.1-cudnn-runtime-ubuntu24\.04$/m, "Cloud Heavy must use the pinned CUDA runtime");
assert.ok(!dockerfile.includes(":latest"), "Cloud image must not use an unpinned latest tag");
assert.ok(!dockerfile.toLowerCase().includes("ollama"), "visual-only Cloud Heavy image must not install Ollama");
assert.ok(dockerfile.includes("ORISLOP_REQUIRE_API_AUTH=1"));
assert.ok(dockerfile.includes("ORISLOP_CLOUD_HEAVY_ENABLED=1"));
assert.ok(dockerfile.includes("ORISLOP_SPATIAL_DEVICE=cuda"), "the custom spatial detector must run on the cloud GPU");
assert.ok(dockerfile.includes("ORISLOP_SPATIAL_AUX_DEVICE=cuda"), "cloud spatial auxiliary encoders must not fall back to CPU");
assert.ok(dockerfile.includes("CLOUDFLARED_VERSION=2026.7.0"), "Cloudflare Tunnel client must be version-pinned");
assert.ok(dockerfile.includes("434a04eb237e07d3d4146fc44acdbb411260a94fcb01764f454abe38a09503f3"), "cloudflared download must be checksum verified");
assert.ok(entrypoint.includes("exec python"));
assert.ok(entrypoint.includes("CLOUDFLARE_TUNNEL_TOKEN"));
assert.ok(entrypoint.includes("ORISLOP_DIAGNOSTIC_BUCKET"));
assert.ok(entrypoint.includes("ORISLOP_S3_ACCESS_KEY_ID"));
assert.ok(entrypoint.includes("ORISLOP_GOOGLE_OAUTH_CLIENT_ID"));
assert.ok(entrypoint.includes("DATABASE_URL"));
assert.ok(compose.includes("ORISLOP_API_TOKENS: ${ORISLOP_API_TOKENS:?"));
assert.ok(compose.includes("ORISLOP_ALLOWED_EXTENSION_ORIGINS: ${ORISLOP_ALLOWED_EXTENSION_ORIGINS:?"));
assert.ok(compose.includes("ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES"));
assert.ok(compose.includes("CLOUDFLARE_TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?"));
assert.ok(compose.includes('"127.0.0.1:4317:4317"'), "Compose must expect TLS termination in front of the API");
for (const exclusion of [".env", ".env.*", "**/.env", ".git", ".venv*", "node_modules"]) {
  assert.ok(dockerignore.split(/\r?\n/).includes(exclusion), `Docker context must exclude ${exclusion}`);
}
assert.ok(server.includes("api_token_valid"));
assert.ok(server.includes('"/v1/text-score"'));
assert.ok(server.includes('"/v1/explain"'), "cloud bridge must expose authenticated grounded explanations");
for (const endpoint of ["/v2/auth/google", "/v2/auth/refresh", "/v2/auth/logout", "/v2/me", "/v2/analyze", "/v2/analyze/batch", "/v2/feedback"]) {
  assert.ok(server.includes(endpoint), `cloud beta endpoint missing: ${endpoint}`);
}
assert.ok(server.includes("Cloud Heavy does not scrape platform pages"));
assert.ok(server.includes('HOST = os.environ.get("ORISLOP_DETECTOR_HOST"'));
assert.ok(manifest.host_permissions.includes("https://api.orislop.com/*"));
assert.ok(workflow.includes("ghcr.io"));
assert.ok(workflow.includes("apps/detector-bridge/Dockerfile.cloud"));
assert.ok(workflow.includes("node scripts/checkCloudDeployment.mjs"), "cloud images must run deployment contract checks before publishing");
assert.ok(workflow.includes("python3 apps/detector-bridge/tests/test_cloud_beta.py"), "cloud images must run auth, quota, privacy, and rollout tests before publishing");
assert.ok(deploymentGuide.includes("Hybrid"));
assert.ok(deploymentGuide.includes("Runpod"));
assert.ok(deploymentGuide.includes("every candidate currently loaded"));
assert.ok(deploymentGuide.includes("Warm Heavy also targets a measured P95 below two seconds"));

console.log("cloud deployment checks passed");
