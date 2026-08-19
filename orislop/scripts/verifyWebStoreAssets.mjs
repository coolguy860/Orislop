import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntry } from "./lib/zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.join(repoRoot, "assets", "chrome-web-store");
const assetManifest = JSON.parse(readFileSync(path.join(assetRoot, "ASSET_MANIFEST.json"), "utf8"));
const sourceManifest = JSON.parse(readFileSync(path.join(repoRoot, "apps", "extension", "manifest.json"), "utf8"));
const webStoreZip = path.join(repoRoot, "dist", "orislop-browser-extension-webstore.zip");

assert.equal(sourceManifest.manifest_version, 3, "Store source must use Manifest V3");
assert.equal(sourceManifest.version, "1.3.0", "Store source version must match the release");
assert.equal(Object.hasOwn(sourceManifest, "key"), false, 'Store source manifest must not contain "key"');
assert.ok(Array.isArray(assetManifest.assets) && assetManifest.assets.length >= 3, "Store asset manifest is incomplete");

for (const asset of assetManifest.assets) {
  const assetPath = path.join(assetRoot, asset.file);
  assert.ok(existsSync(assetPath), `Missing Web Store asset: ${asset.file}`);
  assert.ok(statSync(assetPath).size > 10_000, `Web Store asset is unexpectedly small: ${asset.file}`);
  const dimensions = pngDimensions(readFileSync(assetPath));
  assert.deepEqual(dimensions, { width: asset.width, height: asset.height }, `${asset.file} dimensions differ from the asset manifest`);
}

assert.ok(existsSync(webStoreZip), "Chrome Web Store ZIP is missing");
const packagedManifest = JSON.parse(readZipEntry(webStoreZip, "manifest.json").toString("utf8"));
assert.equal(packagedManifest.manifest_version, 3);
assert.equal(packagedManifest.version, sourceManifest.version);
assert.equal(Object.hasOwn(packagedManifest, "key"), false, 'Packaged manifest must not contain "key"');

const storeGuide = readFileSync(path.join(repoRoot, "docs", "CHROME_WEB_STORE.md"), "utf8");
assert.ok(storeGuide.includes("Permission disclosure"));
assert.ok(storeGuide.includes("Store approval is still an external review"));

console.log(`Chrome Web Store package and ${assetManifest.assets.length} listing assets passed verification.`);

function pngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a", "Expected a PNG file");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", "PNG is missing IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
