import { DEFAULT_ORISLOP_SETTINGS } from "../../shared/src/constants.ts";
import { clamp } from "../../shared/src/clamp.ts";
import type { OrislopSettings, SkipMode } from "../../shared/src/types.ts";
import {
  isRecord,
  readJsonFile,
  resolveStorageFile,
  writeJsonFile
} from "./jsonFileStore.ts";
import type { LocalStorageOptions, SettingsStoreResult } from "./types.ts";

const SETTINGS_FILE = "settings.json";

const BOOLEAN_SETTING_KEYS: Array<keyof OrislopSettings> = [
  "autoSkip",
  "allowScrollBack",
  "showSkippedBanner",
  "showFlaggedBannerOnScrollBack",
  "hideFlaggedCurrentVideo",
  "observePlaybackBeforeScoring",
  "enableLookaheadScan",
  "hideFlaggedRecommendations",
  "enableLocalOriginalityIndex",
  "skipAllAiLabeled",
  "skipPossibleUnlabeledAi",
  "skipUsefulAiExplainers",
  "skipAiSlop",
  "skipAllSlop",
  "skipEngagementBait",
  "skipTemplateBrainrot",
  "skipRedditTtsStories",
  "skipFakeTextStories",
  "skipLowInformation",
  "skipRepetitiveFormats",
  "skipRepostLike",
  "skipGreenScreenReactions",
  "skipLowOriginalityReposts",
  "skipScamFinance",
  "skipMiracleHealthClaims",
  "skipHighRiskUnsupportedClaims",
  "skipUnsupportedClaims",
  "doNotSkipComedyForFactualWrongness",
  "doNotClaimTruthVerification",
  "enableDeepScan",
  "enableLocalLlm",
  "enableOcr",
  "enableOpenClip",
  "enableWhisper",
  "enableExistingAiDetector",
  "enableTemporalDetector",
  "enableSpatialDetector",
  "enableFusionDetector",
  "enableClaimVerification",
  "autoVerifyHighRiskClaims",
  "useCommunityReactionSignal",
  "showRawDebugSignals",
  "forceRescan"
];

const SKIP_MODES: SkipMode[] = [
  "off",
  "warn_only",
  "auto_scroll_with_banner",
  "auto_scroll_silent"
];

const STRICTNESS_VALUES: Array<OrislopSettings["strictness"]> = [
  "lenient",
  "balanced",
  "strict",
  "nuclear"
];

const DEEP_SCAN_POLICIES: Array<OrislopSettings["deepScanPolicy"]> = [
  "manual_only",
  "suspicious_only",
  "fast_detector_all",
  "all_videos"
];

export class UserSettingsStore {
  private readonly filePath: string;

  constructor(options: LocalStorageOptions) {
    this.filePath = resolveStorageFile(options, SETTINGS_FILE);
  }

  async load(): Promise<OrislopSettings> {
    return (await this.loadWithRepairStatus()).settings;
  }

  async loadWithRepairStatus(): Promise<SettingsStoreResult> {
    const read = await readJsonFile<unknown>(this.filePath);

    if (read.status === "missing" || read.status === "malformed") {
      const defaults = defaultSettingsCopy();
      await this.persist(defaults);
      return {
        settings: defaults,
        repaired: read.status === "malformed"
      };
    }

    const repaired = repairSettings(read.value);
    const repairedFile = JSON.stringify(repaired) !== JSON.stringify(read.value);
    if (repairedFile) {
      await this.persist(repaired);
    }

    return {
      settings: repaired,
      repaired: repairedFile
    };
  }

  async save(settingsPatch: Partial<OrislopSettings>): Promise<OrislopSettings> {
    const current = await this.load();
    const repaired = repairSettings({
      ...current,
      ...settingsPatch
    });
    await this.persist(repaired);
    return repaired;
  }

  async resetToDefaults(): Promise<OrislopSettings> {
    const defaults = defaultSettingsCopy();
    await this.persist(defaults);
    return defaults;
  }

  private async persist(settings: OrislopSettings): Promise<void> {
    await writeJsonFile(this.filePath, settings);
  }
}

export function repairSettings(value: unknown): OrislopSettings {
  const raw = isRecord(value) ? value : {};
  const repaired: Record<string, unknown> = defaultSettingsCopy();

  for (const key of BOOLEAN_SETTING_KEYS) {
    const candidate = raw[key];
    if (typeof candidate === "boolean") {
      repaired[key] = candidate;
    }
  }

  const skipMode = raw.skipMode;
  if (typeof skipMode === "string" && SKIP_MODES.includes(skipMode as SkipMode)) {
    repaired.skipMode = skipMode;
  }

  const strictness = raw.strictness;
  if (typeof strictness === "string" && STRICTNESS_VALUES.includes(strictness as OrislopSettings["strictness"])) {
    repaired.strictness = strictness;
  } else if (strictness === "medium") {
    repaired.strictness = "balanced";
  }

  const deepScanPolicy = raw.deepScanPolicy;
  if (typeof deepScanPolicy === "string" && DEEP_SCAN_POLICIES.includes(deepScanPolicy as OrislopSettings["deepScanPolicy"])) {
    repaired.deepScanPolicy = deepScanPolicy;
  }

  if (typeof raw.maxConsecutiveSkips === "number" && Number.isFinite(raw.maxConsecutiveSkips)) {
    repaired.maxConsecutiveSkips = Math.round(clamp(raw.maxConsecutiveSkips, 0, 25));
  }

  if (typeof raw.lookaheadCount === "number" && Number.isFinite(raw.lookaheadCount)) {
    repaired.lookaheadCount = Math.round(clamp(raw.lookaheadCount, 0, 10));
  }

  if (typeof raw.communitySignalWeight === "number" && Number.isFinite(raw.communitySignalWeight)) {
    repaired.communitySignalWeight = clamp(raw.communitySignalWeight, 0, 1);
  }

  if (typeof raw.maxVisibleCommentsToInspect === "number" && Number.isFinite(raw.maxVisibleCommentsToInspect)) {
    repaired.maxVisibleCommentsToInspect = Math.round(clamp(raw.maxVisibleCommentsToInspect, 0, 50));
  }

  if (typeof raw.deepScanMaxRuntimeMs === "number" && Number.isFinite(raw.deepScanMaxRuntimeMs)) {
    repaired.deepScanMaxRuntimeMs = Math.round(clamp(raw.deepScanMaxRuntimeMs, 250, 30000));
  }

  return repaired as OrislopSettings;
}

function defaultSettingsCopy(): OrislopSettings {
  return {
    ...DEFAULT_ORISLOP_SETTINGS
  };
}
