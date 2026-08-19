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
        <div class="app-brand">
          <span class="app-brand__mark" aria-hidden="true">
            <svg viewBox="0 0 512 512" focusable="false">
              <path class="app-brand__orange app-brand__row-1" d="M90 82h241l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
              <path class="app-brand__blue app-brand__row-1" d="M361 82h45a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24h-81l36-70Z" />
              <path class="app-brand__orange app-brand__row-2" d="M90 202h185l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
              <path class="app-brand__blue app-brand__row-2" d="M305 202h65a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24H269l36-70Z" />
              <path class="app-brand__orange app-brand__row-3" d="M90 322h129l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
              <path class="app-brand__blue app-brand__row-3" d="M249 322h85a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24H213l36-70Z" />
            </svg>
          </span>
          <div>
            <h1>ORISLOP</h1>
            <p>Browser · Desktop boot issue</p>
          </div>
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
