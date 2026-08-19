import { execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.ORISLOP_TSC_PATH,
  path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"),
  path.join(repoRoot, "node_modules", ".pnpm", "typescript@6.0.3", "node_modules", "typescript", "lib", "tsc.js"),
  path.join(repoRoot, ".cache", "tsc-fallback", "package", "lib", "tsc.js")
];
const tscPath = candidates.filter(Boolean).find((candidate) => {
  if (!existsSync(candidate)) return false;
  try {
    const descriptor = openSync(candidate, "r");
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
});

if (!tscPath) {
  throw new Error("TypeScript compiler not found. Run pnpm install after fixing registry certificate access.");
}

execFileSync(process.execPath, [tscPath, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit"
});
