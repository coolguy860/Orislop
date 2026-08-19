import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries, readZipEntry } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinPath = path.join(root, "PINNED_TEST_RELEASE.json");
const manifestPath = path.join(root, "apps", "extension", "dist", "manifest.json");
const zipPath = path.join(root, "dist", "orislop-browser-extension.zip");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

assert.equal(pin.modelRevision, "09f0510580de5a8c11393adc7d7905ab40b200ab");
assert.equal(pin.modelManifestSha256, "f64fecb421f435cdd7e7e46374a965ea4708ae509a19c761a64e7314fef5c7dc");
assert.equal(pin.modelBytes, 2794404210);
assert.ok(existsSync(zipPath) && statSync(zipPath).size > 0, "Extension ZIP is missing");

const der = Buffer.from(manifest.key, "base64");
const idHex = createHash("sha256").update(der).digest("hex").slice(0, 32);
const extensionId = [...idHex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
assert.equal(extensionId, pin.extensionId, "Manifest key does not produce the pinned extension ID");
assert.equal(pin.extensionOrigin, `chrome-extension://${extensionId}`);

const entries = readZipEntries(zipPath);
for (const required of ["manifest.json", "background.js", "popup.html", "release-info.json", "test-release.json"]) {
  assert.ok(entries.includes(required), `Extension ZIP is missing ${required}`);
}
const embeddedPin = JSON.parse(readZipEntry(zipPath, "test-release.json").toString("utf8"));
assert.deepEqual(embeddedPin, pin, "Extension ZIP pin receipt differs from the package receipt");
assert.equal(
  createHash("sha256").update(readFileSync(pinPath)).digest("hex"),
  createHash("sha256").update(readZipEntry(zipPath, "test-release.json")).digest("hex"),
  "Pinned test receipt bytes differ"
);

console.log(JSON.stringify({
  status: "test-package-verified",
  extensionId,
  modelRepository: pin.modelRepository,
  modelRevision: pin.modelRevision,
  extensionZip: zipPath,
  extensionZipBytes: statSync(zipPath).size
}, null, 2));
