import type { OrislopSettings } from "../../../../packages/shared/src/types.ts";

export function renderSettingsPanel(settings: OrislopSettings | null): string {
  if (!settings) {
    return `
      <section class="panel">
        <h2>Settings</h2>
        <p class="muted">Loading settings.</p>
      </section>
    `;
  }

  return `
    <section class="panel settings-panel">
      <div class="panel__header">
        <h2>Settings</h2>
        <button type="button" data-action="reset-settings">Reset</button>
      </div>
      ${toggle("autoSkip", "Auto skip", settings.autoSkip)}
      ${toggle("hideFlaggedCurrentVideo", "Hide flagged current video", settings.hideFlaggedCurrentVideo)}
      ${toggle("observePlaybackBeforeScoring", "Watch briefly before scoring", settings.observePlaybackBeforeScoring)}
      ${toggle("hideFlaggedRecommendations", "Hide flagged recommendations", settings.hideFlaggedRecommendations)}
      ${toggle("enableLocalOriginalityIndex", "Local originality index", settings.enableLocalOriginalityIndex)}
      ${toggle("skipAllAiLabeled", "Skip AI-labeled", settings.skipAllAiLabeled)}
      ${toggle("skipEngagementBait", "Skip engagement bait", settings.skipEngagementBait)}
      ${toggle("skipTemplateBrainrot", "Skip template formats", settings.skipTemplateBrainrot)}
      ${toggle("skipRepetitiveFormats", "Skip repetitive formats", settings.skipRepetitiveFormats)}
      ${toggle("skipGreenScreenReactions", "Skip green-screen reactions", settings.skipGreenScreenReactions)}
      ${toggle("skipLowOriginalityReposts", "Skip low-originality reposts", settings.skipLowOriginalityReposts)}
      ${toggle("skipScamFinance", "Skip scam finance", settings.skipScamFinance)}
      ${toggle("skipHighRiskUnsupportedClaims", "Skip high-risk claims", settings.skipHighRiskUnsupportedClaims)}
      ${toggle("useCommunityReactionSignal", "Use visible comment signal", settings.useCommunityReactionSignal)}
      ${toggle("enableClaimVerification", "Verify high-risk claims", settings.enableClaimVerification)}
      ${toggle("autoVerifyHighRiskClaims", "Auto-check claim risk", settings.autoVerifyHighRiskClaims)}
      ${toggle("enableDeepScan", "Enable local deep scan", settings.enableDeepScan)}
      <label class="field-row">
        <span>Strictness</span>
        <select data-setting="strictness">
          ${option("lenient", settings.strictness)}
          ${option("balanced", settings.strictness)}
          ${option("strict", settings.strictness)}
          ${option("nuclear", settings.strictness)}
        </select>
      </label>
      <label class="field-row">
        <span>Deep scan policy</span>
        <select data-setting="deepScanPolicy">
          ${policyOption("manual_only", settings.deepScanPolicy)}
          ${policyOption("suspicious_only", settings.deepScanPolicy)}
          ${policyOption("fast_detector_all", settings.deepScanPolicy)}
          ${policyOption("all_videos", settings.deepScanPolicy)}
        </select>
      </label>
      <label class="field-row">
        <span>Deep scan target ms</span>
        <input type="number" min="250" max="30000" step="250" data-setting="deepScanMaxRuntimeMs" value="${settings.deepScanMaxRuntimeMs}" />
      </label>
      <label class="field-row">
        <span>Comment weight</span>
        <input type="number" min="0" max="1" step="0.05" data-setting="communitySignalWeight" value="${settings.communitySignalWeight}" />
      </label>
      <label class="field-row">
        <span>Visible comments max</span>
        <input type="number" min="0" max="50" step="1" data-setting="maxVisibleCommentsToInspect" value="${settings.maxVisibleCommentsToInspect}" />
      </label>
    </section>
  `;
}

function toggle(key: keyof OrislopSettings, label: string, value: boolean): string {
  return `
    <label class="field-row">
      <span>${label}</span>
      <input type="checkbox" data-setting="${key}" ${value ? "checked" : ""} />
    </label>
  `;
}

function option(value: OrislopSettings["strictness"], current: OrislopSettings["strictness"]): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${value}</option>`;
}

function policyOption(value: OrislopSettings["deepScanPolicy"], current: OrislopSettings["deepScanPolicy"]): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${value}</option>`;
}
