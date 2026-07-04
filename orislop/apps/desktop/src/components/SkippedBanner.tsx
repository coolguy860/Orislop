import type { OrislopScoreResult } from "../../../../packages/shared/src/types.ts";
import type { SkippedBannerView } from "../youtube/skipController.ts";

export function renderSkippedBanner(
  input: OrislopScoreResult | SkippedBannerView | null,
  dismissed: boolean
): string {
  if (!input || dismissed) {
    return "";
  }

  const banner = "kind" in input ? input : scoreResultToBanner(input);
  if (!banner) {
    return "";
  }

  return `
    <aside class="skipped-banner skipped-banner--${banner.kind}" role="status">
      <strong>${escapeHtml(banner.message)}</strong>
      ${banner.detail ? `<span>${escapeHtml(banner.detail)}</span>` : ""}
    </aside>
  `;
}

function scoreResultToBanner(result: OrislopScoreResult): SkippedBannerView | null {
  if (result.action !== "skip" && result.action !== "pre_skip") {
    return null;
  }

  return {
    kind: "skipped",
    message: result.userFacingReason ?? "Skipped: likely low-value content",
    detail: `Orislop flagged this because: ${result.skipReason ?? "matched local rules"}`,
    videoKey: result.videoId ? `video:${result.videoId}` : `url:${result.url}`
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
