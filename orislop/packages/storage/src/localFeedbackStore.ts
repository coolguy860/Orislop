import {
  isRecord,
  nowIso,
  readJsonFile,
  resolveStorageFile,
  writeJsonFile
} from "./jsonFileStore.ts";
import type {
  FeedbackRecord,
  FeedbackRecordInput,
  StoreOptions
} from "./types.ts";

const FEEDBACK_FILE = "feedback.json";

type FeedbackFile = {
  version: 1;
  records: FeedbackRecord[];
};

export class LocalFeedbackStore {
  private readonly filePath: string;
  private readonly now?: () => Date;

  constructor(options: StoreOptions) {
    this.filePath = resolveStorageFile(options, FEEDBACK_FILE);
    this.now = options.now;
  }

  async append(input: FeedbackRecordInput): Promise<FeedbackRecord> {
    const file = await this.loadFile();
    const record: FeedbackRecord = {
      ...input,
      timestamp: input.timestamp ?? nowIso(this.now)
    };

    file.records.push(record);
    await writeJsonFile(this.filePath, file);
    return record;
  }

  async list(): Promise<FeedbackRecord[]> {
    return (await this.loadFile()).records;
  }

  async clear(): Promise<void> {
    await writeJsonFile(this.filePath, emptyFeedbackFile());
  }

  private async loadFile(): Promise<FeedbackFile> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status !== "valid") {
      const empty = emptyFeedbackFile();
      await writeJsonFile(this.filePath, empty);
      return empty;
    }

    if (Array.isArray(read.value)) {
      const migrated: FeedbackFile = {
        version: 1,
        records: read.value.filter(isFeedbackRecord)
      };
      await writeJsonFile(this.filePath, migrated);
      return migrated;
    }

    if (!isRecord(read.value) || !Array.isArray(read.value.records)) {
      const empty = emptyFeedbackFile();
      await writeJsonFile(this.filePath, empty);
      return empty;
    }

    return {
      version: 1,
      records: read.value.records.filter(isFeedbackRecord)
    };
  }
}

function emptyFeedbackFile(): FeedbackFile {
  return {
    version: 1,
    records: []
  };
}

function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  return isRecord(value)
    && typeof value.url === "string"
    && typeof value.timestamp === "string"
    && typeof value.userFeedback === "string"
    && isRecord(value.scoreResult);
}
