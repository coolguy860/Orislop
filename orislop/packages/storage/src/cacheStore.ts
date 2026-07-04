import {
  isRecord,
  nowIso,
  readJsonFile,
  resolveStorageFile,
  writeJsonFile
} from "./jsonFileStore.ts";
import type { OrislopScoreResult, OrislopSettings } from "../../shared/src/types.ts";
import type {
  CacheLookupInput,
  ScoreCacheRecord,
  ScoreCacheStoreOptions
} from "./types.ts";

const CACHE_FILE = "score-cache.json";
const DEFAULT_RETENTION_DAYS = 30;

type CacheFile = {
  version: 1;
  records: Record<string, ScoreCacheRecord>;
};

export class CacheStore {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly now?: () => Date;

  constructor(options: ScoreCacheStoreOptions) {
    this.filePath = resolveStorageFile(options, CACHE_FILE);
    this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    this.now = options.now;
  }

  async getScore(
    video: CacheLookupInput,
    settings: OrislopSettings
  ): Promise<OrislopScoreResult | null> {
    if (settings.forceRescan) {
      return null;
    }

    const file = await this.loadPrunedFile();
    const record = file.records[cacheKeyForVideo(video)];
    if (!record || record.settingsHash !== settingsHash(settings)) {
      return null;
    }

    return record.scoreResult;
  }

  async saveScore(
    scoreResult: OrislopScoreResult,
    settings: OrislopSettings,
    timestamp = nowIso(this.now)
  ): Promise<ScoreCacheRecord> {
    const file = await this.loadPrunedFile();
    const record: ScoreCacheRecord = {
      cacheKey: cacheKeyForVideo(scoreResult),
      videoId: scoreResult.videoId,
      url: scoreResult.url,
      scoreResult,
      timestamp,
      settingsHash: settingsHash(settings)
    };

    file.records[record.cacheKey] = record;
    await writeJsonFile(this.filePath, file);
    return record;
  }

  async clear(): Promise<void> {
    await writeJsonFile(this.filePath, emptyCacheFile());
  }

  private async loadPrunedFile(): Promise<CacheFile> {
    const file = await this.loadFile();
    const pruned: CacheFile = {
      version: 1,
      records: {}
    };

    for (const [key, record] of Object.entries(file.records)) {
      if (!isExpired(record.timestamp, this.retentionMs, this.now)) {
        pruned.records[key] = record;
      }
    }

    if (Object.keys(pruned.records).length !== Object.keys(file.records).length) {
      await writeJsonFile(this.filePath, pruned);
    }

    return pruned;
  }

  private async loadFile(): Promise<CacheFile> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status !== "valid" || !isRecord(read.value) || !isRecord(read.value.records)) {
      const empty = emptyCacheFile();
      await writeJsonFile(this.filePath, empty);
      return empty;
    }

    const records: Record<string, ScoreCacheRecord> = {};
    for (const [key, value] of Object.entries(read.value.records)) {
      if (isScoreCacheRecord(value)) {
        records[key] = value;
      }
    }

    return {
      version: 1,
      records
    };
  }
}

export function cacheKeyForVideo(video: CacheLookupInput): string {
  return video.videoId ? `video:${video.videoId}` : `url:${video.url}`;
}

export function settingsHash(settings: OrislopSettings): string {
  const { forceRescan: _forceRescan, ...cacheRelevantSettings } = settings;
  return `settings-v1:${stableStringify(cacheRelevantSettings)}`;
}

function emptyCacheFile(): CacheFile {
  return {
    version: 1,
    records: {}
  };
}

function isScoreCacheRecord(value: unknown): value is ScoreCacheRecord {
  return isRecord(value)
    && typeof value.cacheKey === "string"
    && typeof value.url === "string"
    && typeof value.timestamp === "string"
    && typeof value.settingsHash === "string"
    && isRecord(value.scoreResult);
}

function isExpired(timestamp: string, retentionMs: number, now?: () => Date): boolean {
  const savedAt = Date.parse(timestamp);
  if (Number.isNaN(savedAt)) {
    return true;
  }

  return (now?.() ?? new Date()).getTime() - savedAt > retentionMs;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
