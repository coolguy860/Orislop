import type { MockShortFixture } from "../mockFixtures.ts";

export function renderMockShortPanel(fixture: MockShortFixture): string {
  const short = fixture.short;

  return `
    <section class="mock-short" aria-label="Mock Short display">
      <div class="mock-short__screen">
        <div class="mock-short__badge">Shorts mock</div>
        <h2>${escapeHtml(short.title ?? "Untitled Short")}</h2>
        <p class="mock-short__channel">${escapeHtml(short.channelName ?? "Unknown channel")}</p>
        <p>${escapeHtml(short.description ?? fixture.description)}</p>
        <div class="mock-short__hashtags">
          ${short.hashtags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
      <div class="mock-short__meta">
        <span>${short.hasPlatformAiLabel ? "Platform AI label present" : "No platform AI label"}</span>
        <span>${short.transcript ? "Transcript available" : "Transcript missing"}</span>
      </div>
    </section>
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
