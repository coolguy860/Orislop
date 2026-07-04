import type { OrislopScoreResult } from "../../../../packages/shared/src/types.ts";

export function renderFeedbackPanel(result: OrislopScoreResult | null): string {
  const disabled = result ? "" : "disabled";

  return `
    <section class="panel feedback-panel">
      <h2>Feedback</h2>
      <div class="feedback-actions">
        <button type="button" data-feedback="correct" ${disabled}>Correct</button>
        <button type="button" data-feedback="not_slop" ${disabled}>Not slop</button>
        <button type="button" data-feedback="always_allow_channel" ${disabled}>Always allow this channel</button>
        <button type="button" data-feedback="always_block_channel" ${disabled}>Always block this channel</button>
        <button type="button" data-feedback="always_block_format" ${disabled}>Always block this format</button>
        <button type="button" data-feedback="watch_anyway" ${disabled}>Watch anyway</button>
      </div>
    </section>
  `;
}
