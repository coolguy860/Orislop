import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";
import type { ScoredLookaheadCandidate } from "../youtube/lookaheadTypes.ts";

export type ShortsWebViewState = {
  shortsUrl: string;
  extractedShort: ExtractedShort | null;
  webviewReady: boolean;
  lookaheadResults: ScoredLookaheadCandidate[];
};

export function renderShortsWebView(state: ShortsWebViewState): string {
  return `
    <section class="shorts-shell panel" aria-label="YouTube mode">
      <div class="panel__header">
        <div>
          <h2>YouTube</h2>
          <p class="muted">Shorts and regular watch pages use the same local scoring loop.</p>
        </div>
        <button type="button" data-action="analyze-current-short">Analyze current video</button>
      </div>
      <div class="youtube-limit-notice">
        <strong>Embedded YouTube limits</strong>
        <span>Google may block sign-in inside Electron. Orislop cannot bypass that, cannot block ads, and only warns on ad/sponsored content when YouTube exposes enough text.</span>
      </div>
      <div class="shorts-controls">
        <input
          id="shorts-url-input"
          type="url"
          value="${escapeHtml(state.shortsUrl)}"
          placeholder="https://www.youtube.com/shorts/... or https://www.youtube.com/watch?v=..."
          aria-label="YouTube URL"
        />
        <button type="button" data-action="open-shorts-url">Open YouTube</button>
      </div>
      ${renderCurrentVideoSummary(state.extractedShort)}
      <webview
        id="shorts-webview"
        class="shorts-webview"
        src="${escapeHtml(state.shortsUrl)}"
        partition="persist:orislop-youtube-shorts"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      ></webview>
      <p class="shorts-load-status" data-shorts-load-status>Loading YouTube...</p>
      <div id="extract-debug-region">${renderExtractedShortDebug(state.extractedShort)}</div>
      <div id="lookahead-region">${renderLookaheadDebug(state.lookaheadResults)}</div>
    </section>
  `;
}

function renderCurrentVideoSummary(extractedShort: ExtractedShort | null): string {
  if (!extractedShort) {
    return `
      <div class="current-video-summary current-video-summary--empty">
        <span>Current title and channel will appear here after analysis.</span>
      </div>
    `;
  }

  const kind = extractedShort.videoKind === "watch" ? "YouTube video" : "YouTube Short";
  const audio = extractedShort.audioTrackTitle
    ? `<span>Audio: ${escapeHtml(extractedShort.audioTrackTitle)}</span>`
    : "";
  const playback = renderPlaybackSummary(extractedShort);
  const ad = extractedShort.isLikelyAd
    ? `<span class="summary-warning">Sponsored/ad surface: Orislop will warn, not auto-block.</span>`
    : "";

  return `
    <div class="current-video-summary">
      <div>
        <strong>${escapeHtml(extractedShort.title ?? "Untitled video")}</strong>
        <span>${escapeHtml(extractedShort.channelName ?? "Unknown channel")} - ${escapeHtml(kind)}</span>
      </div>
      <div class="summary-meta">
        ${audio}
        ${playback}
        ${ad}
      </div>
    </div>
  `;
}

function renderPlaybackSummary(extractedShort: ExtractedShort): string {
  if (extractedShort.videoDurationSec === null || extractedShort.videoDurationSec === undefined) {
    return "<span>Player observation: unavailable</span>";
  }

  const current = extractedShort.playbackCurrentTimeSec ?? 0;
  const duration = extractedShort.videoDurationSec;
  const state = extractedShort.playbackPaused === true
    ? "paused"
    : extractedShort.playbackPaused === false
      ? "playing"
      : "unknown";
  return `<span>Observed: ${formatSeconds(current)} / ${formatSeconds(duration)} (${state})</span>`;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function renderExtractedShortDebug(extractedShort: ExtractedShort | null): string {
  return `
    <details class="extract-debug" ${extractedShort ? "open" : ""}>
      <summary>Extracted video debug</summary>
      <pre>${escapeHtml(JSON.stringify(extractedShort, null, 2))}</pre>
    </details>
  `;
}

export function renderLookaheadDebug(lookaheadResults: ScoredLookaheadCandidate[]): string {
  return `
    <details class="extract-debug" ${lookaheadResults.length > 0 ? "open" : ""}>
      <summary>Lookahead candidates (${lookaheadResults.length})</summary>
      <p class="muted">Shorts lookahead and watch-page recommendations are scored from visible metadata. Flagged non-ad recommendations can be hidden when the setting is enabled.</p>
      <ol class="lookahead-list">
        ${lookaheadResults.map((item) => `
          <li>
            <strong>${escapeHtml(item.candidate.title ?? item.candidate.videoId ?? item.candidate.extractionId)}</strong>
            <span>${escapeHtml(item.candidate.position)} - ${item.preSkip ? "pre_skip" : item.scoreResult.action} - ${item.cacheHit ? "cache" : "fresh"}</span>
          </li>
        `).join("") || "<li>No lookahead candidates scored.</li>"}
      </ol>
    </details>
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
