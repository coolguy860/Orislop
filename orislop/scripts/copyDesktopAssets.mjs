import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const desktopSource = join(root, "apps", "desktop");
const desktopBuild = join(root, "build", "apps", "desktop");

await mkdir(join(desktopBuild, "src", "styles"), { recursive: true });
await cp(join(desktopSource, "index.html"), join(desktopBuild, "index.html"));
await cp(
  join(desktopSource, "src", "styles", "app.css"),
  join(desktopBuild, "src", "styles", "app.css")
);
