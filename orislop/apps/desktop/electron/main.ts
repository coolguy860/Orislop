import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDesktopMockService } from "./desktopService.ts";
import { registerOrislopIpcHandlers } from "./ipcHandlers.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));

function storagePath(): string {
  return process.env.ORISLOP_STORAGE_PATH ?? app.getPath("userData");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Orislop Browser",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join(currentDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedInitialWebViewSrc(params.src)) {
      event.preventDefault();
      return;
    }

    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.partition = "persist:orislop-youtube-shorts";
  });
  window.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    secureGuestWebContents(guestWebContents);
  });
  if (!app.isPackaged && process.env.ORISLOP_OPEN_DEVTOOLS !== "0") {
    window.webContents.openDevTools({ mode: "detach" });
  }
  window.loadFile(join(currentDir, "../index.html"));
  return window;
}

function secureGuestWebContents(guestWebContents: WebContents): void {
  guestWebContents.setWindowOpenHandler(({ url }) => (
    isAllowedYouTubeGuestUrl(url) ? { action: "allow" } : { action: "deny" }
  ));
  guestWebContents.on("will-navigate", (event, url) => {
    if (!isAllowedYouTubeGuestUrl(url)) {
      event.preventDefault();
    }
  });
}

function isAllowedInitialWebViewSrc(input: string | undefined): boolean {
  return !input || input === "about:blank" || isAllowedYouTubeGuestUrl(input);
}

function isAllowedYouTubeGuestUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && ALLOWED_YOUTUBE_GUEST_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const ALLOWED_YOUTUBE_GUEST_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "consent.youtube.com",
  "accounts.google.com"
]);

app.whenReady().then(() => {
  configureYouTubeCompatibleUserAgent();
  const service = createDesktopMockService({
    storagePath: storagePath()
  });
  registerOrislopIpcHandlers(ipcMain, service);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function configureYouTubeCompatibleUserAgent(): void {
  app.userAgentFallback = app.userAgentFallback
    .replace(/\sElectron\/\S+/i, "")
    .replace(/\sOrislop\/\S+/i, "");
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
