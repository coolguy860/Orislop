import type { FlaggedOnScrollBackBannerView } from "../youtube/skipController.ts";

export function renderFlaggedOnScrollBackBanner(
  banner: FlaggedOnScrollBackBannerView | null
): string {
  if (!banner) {
    return "";
  }

  return `
    <aside class="flagged-banner" role="status">
      <div class="flagged-banner__copy">
        <strong>${escapeHtml(banner.message)}</strong>
      </div>
      <div class="flagged-banner__actions">
        <button type="button" data-feedback="watch_anyway">Watch anyway</button>
        <button type="button" data-feedback="not_slop">Not slop</button>
        <button type="button" data-feedback="always_allow_channel">Always allow this channel</button>
      </div>
    </aside>
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
