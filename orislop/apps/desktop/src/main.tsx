const root = document.getElementById("app");
const desktopWindow = window as Window & { orislop?: unknown };

if (!hasPreloadBridge()) {
  renderBootFallback("Orislop preload bridge is unavailable. Restart the desktop app after rebuilding.");
} else {
  import("./App.js").catch((error: unknown) => {
    renderBootFallback(error instanceof Error ? error.message : "Unable to load Orislop renderer.");
  });
}

function hasPreloadBridge(): boolean {
  return typeof desktopWindow === "object"
    && "orislop" in desktopWindow
    && typeof desktopWindow.orislop === "object"
    && desktopWindow.orislop !== null;
}

function renderBootFallback(message: string): void {
  if (!root) {
    return;
  }

  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div>
          <h1>Orislop Browser</h1>
          <p>Desktop boot issue</p>
        </div>
        <span class="app-status">Preload unavailable</span>
      </header>
      <section class="panel boot-fallback">
        <h2>Unable to start renderer</h2>
        <p class="caution">${escapeHtml(message)}</p>
      </section>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
