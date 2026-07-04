import type {
  CalibrationUserLabel,
  OrislopScoreResult,
  OrislopSettings
} from "../../../../packages/shared/src/types.ts";

const LABELS: Array<[CalibrationUserLabel, string]> = [
  ["slop", "Slop"],
  ["not_slop", "Not slop"],
  ["unclear", "Unsure"],
  ["ai_generated", "AI-generated"],
  ["claim_risk", "Scam/claim-risk"]
];

export function renderCalibrationPanel(
  result: OrislopScoreResult | null,
  settings: OrislopSettings | null,
  labelCount: number
): string {
  const disabled = result ? "" : "disabled";
  const topReasons = result?.evidence.slice(0, 4) ?? [];
  const rawDebug = settings?.showRawDebugSignals && result
    ? `<pre>${escapeHtml(JSON.stringify(result.signals, null, 2))}</pre>`
    : "";

  return `
    <section class="panel calibration-panel">
      <div class="panel__header">
        <h2>Is this slop?</h2>
        <span class="label-count">${labelCount} labels</span>
      </div>
      <label class="field-row">
        <span>Strictness</span>
        <select data-setting="strictness" ${settings ? "" : "disabled"}>
          ${option("lenient", settings?.strictness)}
          ${option("balanced", settings?.strictness)}
          ${option("strict", settings?.strictness)}
          ${option("nuclear", settings?.strictness)}
        </select>
      </label>
      <dl class="calibration-summary">
        <div><dt>Action</dt><dd>${escapeHtml(result?.action ?? "n/a")}</dd></div>
        <div><dt>Risk band</dt><dd>${escapeHtml(result?.riskBand ?? "none")}</dd></div>
        <div><dt>Evidence score</dt><dd>${formatScore(result?.evidenceScore ?? null)}</dd></div>
        <div><dt>Slop evidence</dt><dd>${formatScore(result?.slopEvidenceScore ?? result?.slopScore ?? null)}</dd></div>
        <div><dt>AI/deepfake</dt><dd>${formatScore(result?.aiEvidenceScore ?? result?.aiGeneratedScore ?? null)}</dd></div>
        <div><dt>Claim risk</dt><dd>${formatScore(result?.claimRiskScore ?? null)}</dd></div>
        <div><dt>Originality</dt><dd>${formatScore(result?.originalityRiskScore ?? null)}</dd></div>
        <div><dt>Entertainment</dt><dd>${formatScore(result?.entertainmentScore ?? null)}</dd></div>
        <div><dt>Automation</dt><dd>${formatScore(result?.skipProbability ?? null)}</dd></div>
        <div><dt>Ad handling</dt><dd>${escapeHtml(result?.adSafetyStatus === "visible_ad_limited" ? "warn_only" : "normal")}</dd></div>
        <div><dt>Source check</dt><dd>${escapeHtml(result?.verificationStatus ?? "not_checked")}</dd></div>
        <div><dt>Deep scan</dt><dd>${escapeHtml(result?.deepScanStatus ?? "disabled")}</dd></div>
        <div><dt>Community</dt><dd>${escapeHtml(communityStatus(result, settings))}</dd></div>
      </dl>
      <h3>Why</h3>
      <ol class="reason-list calibration-reasons">
        ${topReasons.map((reason) => `
          <li>
            <strong>${escapeHtml(reason.label)}</strong>
            <span>${escapeHtml(reason.detail)}</span>
          </li>
        `).join("") || "<li><span>No current scoring evidence.</span></li>"}
      </ol>
      ${renderVerificationSummary(result)}
      <div class="calibration-labels">
        ${LABELS.map(([label, text]) => `
          <button type="button" data-calibration-label="${label}" ${disabled}>${text}</button>
        `).join("")}
      </div>
      <div class="calibration-feedback">
        <button type="button" data-calibration-smart="correct" ${disabled}>Correct</button>
        <button type="button" data-calibration-smart="wrong" ${disabled}>Wrong</button>
        <button type="button" data-calibration-smart="watch_anyway" ${disabled}>Watch anyway</button>
        <button type="button" data-calibration-smart="always_allow_channel" ${disabled}>Always allow channel</button>
      </div>
      <div class="calibration-tools">
        <button type="button" data-action="export-calibration-labels">Export JSON</button>
        <button type="button" data-action="import-calibration-labels">Import JSON</button>
      </div>
      <label class="field-row">
        <span>Show raw debug signals</span>
        <input type="checkbox" data-setting="showRawDebugSignals" ${settings?.showRawDebugSignals ? "checked" : ""} ${settings ? "" : "disabled"} />
      </label>
      <div class="raw-debug">${rawDebug}</div>
    </section>
  `;
}

function renderVerificationSummary(result: OrislopScoreResult | null): string {
  if (!result?.verificationSummary) {
    return "";
  }

  const summary = result.verificationSummary;
  return `
    <div class="verification-summary">
      <strong>Source check: ${escapeHtml(summary.status)}</strong>
      <span>${escapeHtml(summary.query ? `Query: ${summary.query}` : "No source query built.")}</span>
      ${summary.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}
    </div>
  `;
}

function communityStatus(
  result: OrislopScoreResult | null,
  settings: OrislopSettings | null
): string {
  if (!settings?.useCommunityReactionSignal) {
    return "disabled";
  }

  const signal = result?.signals.find((item) => item.name === "community_reaction");
  if (!signal || !signal.applicable) {
    return "unavailable";
  }

  return signal.reason;
}

function option(value: OrislopSettings["strictness"], current: OrislopSettings["strictness"] | undefined): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${value}</option>`;
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
