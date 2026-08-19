import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createExistingAiDetectorAdapter,
  createSpatialDetectorAdapter,
  createTemporalDetectorAdapter,
  type AdapterConfig,
  type ModelAdaptersConfig
} from "../../../packages/local-inference/src/index.ts";
import { scoreVideo } from "../../../packages/slop-engine/src/scoreVideo.ts";
import { existingAiDetectorSignal } from "../../../packages/slop-engine/src/signals/existingAiDetectorSignal.ts";
import { localOriginalitySignal } from "../../../packages/slop-engine/src/signals/localOriginalitySignal.ts";
import { temporalDetectorSignal } from "../../../packages/slop-engine/src/signals/temporalDetectorSignal.ts";
import { visualTemplateSignal } from "../../../packages/slop-engine/src/signals/visualTemplateSignal.ts";
import type { ScoreVideoOptions, UserPreferenceRules } from "../../../packages/slop-engine/src/types.ts";
import type {
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import {
  CacheStore,
  CalibrationStore,
  ChannelPreferenceStore,
  LocalFeedbackStore,
  LocalOriginalityStore,
  SkipHistoryStore,
  UserSettingsStore
} from "../../../packages/storage/src/index.ts";
import type {
  CalibrationRecord,
  FeedbackRecord,
  SkipHistoryRecord,
  UserFeedbackAction
} from "../../../packages/storage/src/types.ts";
import { MOCK_SHORT_FIXTURES, type MockShortFixture } from "../src/mockFixtures.ts";
import type {
  ScoredLookaheadCandidate,
  ScoreLookaheadPayload
} from "../src/youtube/lookaheadTypes.ts";
import {
  candidateToExtractedShort,
  dedupeLookaheadCandidates,
  limitLookaheadCandidates
} from "../src/youtube/youtubeLookaheadScanner.ts";
import type {
  FeedbackPayload,
  CalibrationLabelPayload,
  ScoreRequestPayload
} from "./ipcValidation.ts";

export type DesktopMockServiceOptions = {
  storagePath: string;
};

export type ScoreShortResponse = {
  result: OrislopScoreResult;
  cacheHit: boolean;
};

export type FeedbackResponse = {
  record: FeedbackRecord;
  preferencesChanged: boolean;
};

export type CalibrationLabelResponse = {
  record: CalibrationRecord;
  totalLabels: number;
};

export type DesktopMockService = ReturnType<typeof createDesktopMockService>;

export function createDesktopMockService(options: DesktopMockServiceOptions) {
  const settingsStore = new UserSettingsStore({ basePath: options.storagePath });
  const feedbackStore = new LocalFeedbackStore({ basePath: options.storagePath });
  const calibrationStore = new CalibrationStore({ basePath: options.storagePath });
  const cacheStore = new CacheStore({ basePath: options.storagePath });
  const skipHistoryStore = new SkipHistoryStore({ basePath: options.storagePath });
  const channelPreferenceStore = new ChannelPreferenceStore({ basePath: options.storagePath });
  const originalityStore = new LocalOriginalityStore({ basePath: options.storagePath });

  return {
    listFixtures(): MockShortFixture[] {
      return MOCK_SHORT_FIXTURES;
    },

    async getSettings(): Promise<OrislopSettings> {
      return settingsStore.load();
    },

    async updateSettings(settingsPatch: Partial<OrislopSettings>): Promise<OrislopSettings> {
      const settings = await settingsStore.save(settingsPatch);
      await cacheStore.clear();
      return settings;
    },

    async resetSettings(): Promise<OrislopSettings> {
      const settings = await settingsStore.resetToDefaults();
      await cacheStore.clear();
      return settings;
    },

    async scoreShort(payload: ScoreRequestPayload): Promise<ScoreShortResponse> {
      return scoreShortWithStores(
        payload,
        settingsStore,
        cacheStore,
        feedbackStore,
        skipHistoryStore,
        channelPreferenceStore,
        originalityStore
      );
    },

    async getCachedScore(payload: ScoreRequestPayload): Promise<OrislopScoreResult | null> {
      const settings = await settingsStore.load();
      return cacheStore.getScore(resolveShort(payload), settings);
    },

    async clearCache(): Promise<{ cleared: true }> {
      await cacheStore.clear();
      return { cleared: true };
    },

    async forceRescan(payload: ScoreRequestPayload): Promise<ScoreShortResponse> {
      return this.scoreShort({
        ...payload,
        forceRescan: true
      });
    },

    async scoreLookaheadCandidates(payload: ScoreLookaheadPayload): Promise<ScoredLookaheadCandidate[]> {
      return scoreLookaheadWithStores(
        payload,
        settingsStore,
        cacheStore,
        feedbackStore,
        channelPreferenceStore,
        originalityStore
      );
    },

    async saveFeedback(payload: FeedbackPayload): Promise<FeedbackResponse> {
      const short = payload.short ?? resolveShort(payload);
      const preferencesChanged = await applyFeedbackPreference(
        payload.userFeedback,
        payload.scoreResult,
        short,
        channelPreferenceStore
      );
      const record = await feedbackStore.append({
        videoId: short.videoId,
        url: short.url,
        title: short.title,
        channelName: short.channelName,
        channelUrl: short.channelUrl,
        scoreResult: payload.scoreResult,
        actionTaken: payload.scoreResult.action,
        userFeedback: payload.userFeedback
      });

      if (preferencesChanged) {
        await cacheStore.clear();
      }

      return {
        record,
        preferencesChanged
      };
    },

    async saveCalibrationLabel(payload: CalibrationLabelPayload): Promise<CalibrationLabelResponse> {
      const short = payload.short ?? resolveShort(payload);
      const preferencesChanged = payload.userFeedback
        ? await applyFeedbackPreference(payload.userFeedback, payload.scoreResult, short, channelPreferenceStore)
        : false;
      const record = await calibrationStore.append({
        short,
        platform: payload.fixtureId ? "mock_fixture" : undefined,
        scoreResult: payload.scoreResult,
        userLabel: payload.userLabel,
        userFeedback: payload.userFeedback ?? null
      });
      if (payload.userFeedback) {
        await feedbackStore.append({
          videoId: short.videoId,
          url: short.url,
          title: short.title,
          channelName: short.channelName,
          channelUrl: short.channelUrl,
          scoreResult: payload.scoreResult,
          actionTaken: payload.scoreResult.action,
          userFeedback: payload.userFeedback
        });
      }

      if (preferencesChanged) {
        await cacheStore.clear();
      }

      return {
        record,
        totalLabels: (await calibrationStore.list()).length
      };
    },

    async listCalibrationLabels(): Promise<CalibrationRecord[]> {
      return calibrationStore.list();
    },

    async exportCalibrationLabels(): Promise<CalibrationRecord[]> {
      return calibrationStore.exportRecords();
    },

    async importCalibrationLabels(payload: unknown) {
      return calibrationStore.importRecords(payload);
    },

    async getSkipHistory(): Promise<SkipHistoryRecord[]> {
      return skipHistoryStore.list();
    },

    async markScrolledBack(payload: ScoreRequestPayload): Promise<SkipHistoryRecord | null> {
      return skipHistoryStore.markScrolledBack(resolveShort(payload));
    },

    async markWatchedAnyway(payload: ScoreRequestPayload): Promise<SkipHistoryRecord | null> {
      return skipHistoryStore.markWatchedAnyway(resolveShort(payload));
    }
  };
}

async function scoreLookaheadWithStores(
  payload: ScoreLookaheadPayload,
  settingsStore: UserSettingsStore,
  cacheStore: CacheStore,
  feedbackStore: LocalFeedbackStore,
  channelPreferenceStore: ChannelPreferenceStore,
  originalityStore: LocalOriginalityStore
): Promise<ScoredLookaheadCandidate[]> {
  const settings = await settingsStore.load();
  if (!settings.enableLookaheadScan || settings.lookaheadCount <= 0) {
    return [];
  }

  const candidates = limitLookaheadCandidates(
    dedupeLookaheadCandidates(payload.candidates),
    settings.lookaheadCount
  );
  const scoreOptions: ScoreVideoOptions = {
    userPreferences: await buildUserPreferenceRules(feedbackStore, channelPreferenceStore)
  };
  const scored: ScoredLookaheadCandidate[] = [];

  for (const candidate of candidates) {
    const short = candidateToExtractedShort(candidate);
    const cached = await cacheStore.getScore(short, settings);
    const localOriginalitySignals = cached
      ? []
      : await buildLocalOriginalitySignals(short, settings, originalityStore);
    const baseResult = cached ?? scoreVideo(short, settings, {
      ...scoreOptions,
      adapterSignals: localOriginalitySignals
    });

    if (!cached) {
      if (hasCacheableMetadata(short)) {
        await cacheStore.saveScore(baseResult, settings, short);
      }
    }
    await rememberOriginality(short, settings, originalityStore);

    const preSkip = baseResult.action === "skip";
    scored.push({
      candidate,
      short,
      scoreResult: preSkip
        ? {
          ...baseResult,
          action: "pre_skip"
        }
        : baseResult,
      cacheHit: Boolean(cached),
      preSkip
    });
  }

  return scored;
}

async function scoreShortWithStores(
  payload: ScoreRequestPayload,
  settingsStore: UserSettingsStore,
  cacheStore: CacheStore,
  feedbackStore: LocalFeedbackStore,
  skipHistoryStore: SkipHistoryStore,
  channelPreferenceStore: ChannelPreferenceStore,
  originalityStore: LocalOriginalityStore
): Promise<ScoreShortResponse> {
  const short = resolveShort(payload);
  const persistedSettings = await settingsStore.load();
  const settings = payload.forceRescan
    ? { ...persistedSettings, forceRescan: true }
    : persistedSettings;
  const cached = await cacheStore.getScore(short, settings);

  if (cached) {
    await rememberOriginality(short, persistedSettings, originalityStore);
    await recordSkipResult(cached, short, skipHistoryStore);
    return {
      result: cached,
      cacheHit: true
    };
  }

  const scoreOptions: ScoreVideoOptions = {
    userPreferences: await buildUserPreferenceRules(feedbackStore, channelPreferenceStore),
    adapterSignals: await buildLocalOriginalitySignals(short, settings, originalityStore)
  };
  let result = scoreVideo(short, settings, scoreOptions);
  if (result.deepScanStatus === "pending") {
    const adapterSignals = await buildOptionalDeepScanSignals(short, settings);
    if (adapterSignals.length > 0) {
      result = scoreVideo(short, settings, {
        ...scoreOptions,
        adapterSignals: [
          ...(scoreOptions.adapterSignals ?? []),
          ...adapterSignals
        ]
      });
    }
  }
  if (hasCacheableMetadata(short)) {
    await cacheStore.saveScore(result, persistedSettings, short);
  }
  await rememberOriginality(short, persistedSettings, originalityStore);
  await recordSkipResult(result, short, skipHistoryStore);

  return {
    result,
    cacheHit: false
  };
}

function hasCacheableMetadata(short: ExtractedShort): boolean {
  return Boolean(
    short.title?.trim()
    || short.description?.trim()
    || short.visiblePageText.trim()
    || short.transcript?.trim()
    || short.platformAiLabelText?.trim()
  );
}

async function buildLocalOriginalitySignals(
  short: ExtractedShort,
  settings: OrislopSettings,
  originalityStore: LocalOriginalityStore
): Promise<NonNullable<ScoreVideoOptions["adapterSignals"]>> {
  if (!settings.enableLocalOriginalityIndex) {
    return [];
  }

  const matches = await originalityStore.findSimilar(short, {
    limit: 3,
    minSimilarity: 0.86
  });

  return [localOriginalitySignal(matches, settings)];
}

async function rememberOriginality(
  short: ExtractedShort,
  settings: OrislopSettings,
  originalityStore: LocalOriginalityStore
): Promise<void> {
  if (settings.enableLocalOriginalityIndex) {
    await originalityStore.upsert(short);
  }
}

async function buildOptionalDeepScanSignals(
  short: ExtractedShort,
  settings: OrislopSettings
): Promise<NonNullable<ScoreVideoOptions["adapterSignals"]>> {
  if (!settings.enableDeepScan) {
    return [];
  }

  const config = await readModelAdaptersConfig().catch(() => null);
  const adapters = config?.adapters ?? {};
  const signals: NonNullable<ScoreVideoOptions["adapterSignals"]> = [];

  if (settings.enableExistingAiDetector) {
    const result = await createExistingAiDetectorAdapter(adapterConfig(adapters.existing_ai_detector)).analyze({ short });
    signals.push(existingAiDetectorSignal(result, settings));
  }

  if (settings.enableSpatialDetector) {
    const result = await createSpatialDetectorAdapter(adapterConfig(adapters.spatial_detector)).analyze({ short });
    signals.push(visualTemplateSignal(result, settings));
  }

  if (settings.enableTemporalDetector) {
    const result = await createTemporalDetectorAdapter(adapterConfig(adapters.temporal_detector)).analyze({ short });
    signals.push(temporalDetectorSignal(result, settings));
  }

  return signals;
}

async function readModelAdaptersConfig(): Promise<ModelAdaptersConfig> {
  const configPath = join(process.cwd(), "configs", "model_adapters.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ModelAdaptersConfig;
}

function adapterConfig(config: AdapterConfig | undefined): Partial<AdapterConfig> {
  return config ?? { enabled: false, mode: "disabled" };
}

async function recordSkipResult(
  result: OrislopScoreResult,
  short: ExtractedShort,
  skipHistoryStore: SkipHistoryStore
): Promise<void> {
  if (result.action === "skip" || result.action === "pre_skip") {
    await skipHistoryStore.recordSkip({
      videoId: short.videoId,
      url: short.url,
      reason: result.skipReason,
      action: result.action
    });
  }
}

async function buildUserPreferenceRules(
  feedbackStore: LocalFeedbackStore,
  channelPreferenceStore: ChannelPreferenceStore
): Promise<UserPreferenceRules> {
  const channelRules = await channelPreferenceStore.toUserPreferenceRules();
  const alwaysBlockCategories = (await feedbackStore.list())
    .filter((record) => record.userFeedback === "always_block_format")
    .map((record) => record.scoreResult.categories[0])
    .filter((category): category is string => Boolean(category));

  return {
    alwaysAllowChannels: channelRules.alwaysAllowChannels ?? [],
    alwaysBlockChannels: channelRules.alwaysBlockChannels ?? [],
    alwaysBlockCategories: Array.from(new Set(alwaysBlockCategories))
  };
}

async function applyFeedbackPreference(
  userFeedback: UserFeedbackAction,
  scoreResult: OrislopScoreResult,
  short: ExtractedShort,
  channelPreferenceStore: ChannelPreferenceStore
): Promise<boolean> {
  if (userFeedback === "always_allow_channel") {
    await channelPreferenceStore.alwaysAllowChannel(short);
    return true;
  }

  if (userFeedback === "always_block_channel") {
    await channelPreferenceStore.alwaysBlockChannel(short);
    return true;
  }

  return userFeedback === "always_block_format" && scoreResult.categories.length > 0;
}

function resolveShort(payload: ScoreRequestPayload | FeedbackPayload | CalibrationLabelPayload): ExtractedShort {
  if (payload.short) {
    return payload.short;
  }

  const fixtureId = payload.fixtureId;
  const fixture = MOCK_SHORT_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) {
    throw new Error(`Unknown mock fixture: ${fixtureId ?? "none"}.`);
  }

  return fixture.short;
}
