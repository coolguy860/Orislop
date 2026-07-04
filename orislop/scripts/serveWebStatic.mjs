import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shouldBuild = process.argv.includes("--dev") || !existsSync(path.join(repoRoot, "apps", "web", "dist", "index.html"));

if (shouldBuild) {
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "buildWebStatic.mjs")], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

const distRoot = path.join(repoRoot, "apps", "web", "dist");
const port = Number(process.env.ORISLOP_WEB_PORT ?? "4173");

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(distRoot, relativePath);

  if (!resolvedPath.startsWith(distRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const filePath = existsSync(resolvedPath) && statSync(resolvedPath).isFile()
    ? resolvedPath
    : path.join(distRoot, "index.html");

  response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Orislop static web preview: http://127.0.0.1:${port}`);
});

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
