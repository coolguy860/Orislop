import {
  isRecord,
  nowIso,
  readJsonFile,
  resolveStorageFile,
  writeJsonFile
} from "./jsonFileStore.ts";
import {
  cacheKeyForVideo
} from "./cacheStore.ts";
import type {
  CacheLookupInput,
  SkipHistoryInput,
  SkipHistoryRecord,
  SkipHistoryStoreOptions
} from "./types.ts";

const SKIP_HISTORY_FILE = "skip-history.json";
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_SESSION_ID = "default-session";

type SkipHistoryFile = {
  version: 1;
  records: SkipHistoryRecord[];
};

export class SkipHistoryStore {
  private readonly filePath: string;
  private readonly sessionId: string;
  private readonly maxRecords: number;
  private readonly now?: () => Date;

  constructor(options: SkipHistoryStoreOptions) {
    this.filePath = resolveStorageFile(options, SKIP_HISTORY_FILE);
    this.sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now;
  }

  async recordSkip(input: SkipHistoryInput): Promise<SkipHistoryRecord> {
    const file = await this.loadFile();
    const record: SkipHistoryRecord = {
      cacheKey: cacheKeyForVideo(input),
      videoId: input.videoId,
      url: input.url,
      reason: input.reason,
      timestamp: input.timestamp ?? nowIso(this.now),
      action: input.action,
      scrolledBack: input.scrolledBack ?? false,
      watchedAnyway: input.watchedAnyway ?? false,
      sessionId: input.sessionId ?? this.sessionId
    };

    file.records.push(record);
    file.records = file.records.slice(-this.maxRecords);
    await writeJsonFile(this.filePath, file);
    return record;
  }

  async markScrolledBack(video: CacheLookupInput, sessionId = this.sessionId): Promise<SkipHistoryRecord | null> {
    return this.updateLatest(video, sessionId, { scrolledBack: true });
  }

  async markWatchedAnyway(video: CacheLookupInput, sessionId = this.sessionId): Promise<SkipHistoryRecord | null> {
    return this.updateLatest(video, sessionId, { watchedAnyway: true });
  }

  async shouldAvoidImmediateReskip(
    video: CacheLookupInput,
    sessionId = this.sessionId
  ): Promise<boolean> {
    const latest = await this.latestFor(video, sessionId);
    return Boolean(latest?.scrolledBack || latest?.watchedAnyway);
  }

  async list(): Promise<SkipHistoryRecord[]> {
    return (await this.loadFile()).records;
  }

  async clear(): Promise<void> {
    await writeJsonFile(this.filePath, emptySkipHistoryFile());
  }

  private async updateLatest(
    video: CacheLookupInput,
    sessionId: string,
    patch: Partial<Pick<SkipHistoryRecord, "scrolledBack" | "watchedAnyway">>
  ): Promise<SkipHistoryRecord | null> {
    const file = await this.loadFile();
    const key = cacheKeyForVideo(video);

    for (let index = file.records.length - 1; index >= 0; index -= 1) {
      const record = file.records[index];
      if (record.cacheKey === key && record.sessionId === sessionId) {
        file.records[index] = {
          ...record,
          ...patch
        };
        await writeJsonFile(this.filePath, file);
        return file.records[index];
      }
    }

    return null;
  }

  private async latestFor(
    video: CacheLookupInput,
    sessionId: string
  ): Promise<SkipHistoryRecord | null> {
    const key = cacheKeyForVideo(video);
    const records = (await this.loadFile()).records;

    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.cacheKey === key && record.sessionId === sessionId) {
        return record;
      }
    }

    return null;
  }

  private async loadFile(): Promise<SkipHistoryFile> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status !== "valid" || !isRecord(read.value) || !Array.isArray(read.value.records)) {
      const empty = emptySkipHistoryFile();
      await writeJsonFile(this.filePath, empty);
      return empty;
    }

    return {
      version: 1,
      records: read.value.records.filter(isSkipHistoryRecord).slice(-this.maxRecords)
    };
  }
}

function emptySkipHistoryFile(): SkipHistoryFile {
  return {
    version: 1,
    records: []
  };
}

function isSkipHistoryRecord(value: unknown): value is SkipHistoryRecord {
  return isRecord(value)
    && typeof value.cacheKey === "string"
    && typeof value.url === "string"
    && typeof value.timestamp === "string"
    && typeof value.action === "string"
    && typeof value.scrolledBack === "boolean"
    && typeof value.watchedAnyway === "boolean"
    && typeof value.sessionId === "string";
}
