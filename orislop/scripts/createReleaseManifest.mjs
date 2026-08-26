import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "dist");
const artifactNames = ["orislop-browser-extension.zip", "orislop-namecheap-static.zip"];

const artifacts = artifactNames.map((name) => {
  const filePath = path.join(distRoot, name);
  const bytes = readFileSync(filePath);
  return {
    name,
    bytes: statSync(filePath).size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
});

const manifest = {
  schemaVersion: 1,
  product: "Orislop",
  version: "1.4.0",
  createdAt: new Date().toISOString(),
  artifacts
};

const outputPath = path.join(distRoot, "release-manifest.json");
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Release integrity manifest ready: ${outputPath}`);
