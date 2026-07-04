import {
  isRecord,
  nowIso,
  readJsonFile,
  resolveStorageFile,
  uniqueStrings,
  writeJsonFile
} from "./jsonFileStore.ts";
import type {
  ChannelIdentity,
  ChannelPreferenceKind,
  ChannelPreferenceRecord,
  ChannelPreferenceRules,
  StoreOptions
} from "./types.ts";

const CHANNEL_PREFERENCES_FILE = "channel-preferences.json";

type ChannelPreferenceFile = {
  version: 1;
  records: ChannelPreferenceRecord[];
};

export class ChannelPreferenceStore {
  private readonly filePath: string;
  private readonly now?: () => Date;

  constructor(options: StoreOptions) {
    this.filePath = resolveStorageFile(options, CHANNEL_PREFERENCES_FILE);
    this.now = options.now;
  }

  async alwaysAllowChannel(channel: ChannelIdentity): Promise<ChannelPreferenceRecord> {
    return this.setPreference("always_allow_channel", channel);
  }

  async alwaysBlockChannel(channel: ChannelIdentity): Promise<ChannelPreferenceRecord> {
    return this.setPreference("always_block_channel", channel);
  }

  async removeChannelPreference(channel: ChannelIdentity): Promise<boolean> {
    const file = await this.loadFile();
    const key = channelKey(channel);
    const nextRecords = file.records.filter((record) => channelKey(record) !== key);
    const removed = nextRecords.length !== file.records.length;

    if (removed) {
      await writeJsonFile(this.filePath, {
        ...file,
        records: nextRecords
      });
    }

    return removed;
  }

  async preferenceForChannel(channel: ChannelIdentity): Promise<ChannelPreferenceRecord | null> {
    const key = channelKey(channel);
    const records = (await this.loadFile()).records;
    return records.find((record) => channelKey(record) === key) ?? null;
  }

  async toUserPreferenceRules(): Promise<ChannelPreferenceRules> {
    const records = (await this.loadFile()).records;
    return channelPreferencesToUserPreferenceRules(records);
  }

  async list(): Promise<ChannelPreferenceRecord[]> {
    return (await this.loadFile()).records;
  }

  async clear(): Promise<void> {
    await writeJsonFile(this.filePath, emptyChannelPreferenceFile());
  }

  private async setPreference(
    preference: ChannelPreferenceKind,
    channel: ChannelIdentity
  ): Promise<ChannelPreferenceRecord> {
    const file = await this.loadFile();
    const key = channelKey(channel);
    const existing = file.records.find((record) => channelKey(record) === key);
    const timestamp = nowIso(this.now);
    const record: ChannelPreferenceRecord = {
      channelName: normalizeNullable(channel.channelName),
      channelUrl: normalizeNullable(channel.channelUrl),
      preference,
      matchValue: exactMatchValue(channel),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    file.records = [
      ...file.records.filter((item) => channelKey(item) !== key),
      record
    ];
    await writeJsonFile(this.filePath, file);
    return record;
  }

  private async loadFile(): Promise<ChannelPreferenceFile> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status !== "valid" || !isRecord(read.value) || !Array.isArray(read.value.records)) {
      const empty = emptyChannelPreferenceFile();
      await writeJsonFile(this.filePath, empty);
      return empty;
    }

    return {
      version: 1,
      records: read.value.records.filter(isChannelPreferenceRecord)
    };
  }
}

export function channelPreferencesToUserPreferenceRules(
  records: ChannelPreferenceRecord[]
): ChannelPreferenceRules {
  return {
    alwaysAllowChannels: uniqueStrings(records
      .filter((record) => record.preference === "always_allow_channel")
      .map((record) => record.matchValue)),
    alwaysBlockChannels: uniqueStrings(records
      .filter((record) => record.preference === "always_block_channel")
      .map((record) => record.matchValue))
  };
}

export function channelKey(channel: ChannelIdentity): string {
  return exactMatchValue(channel).toLowerCase();
}

function exactMatchValue(channel: ChannelIdentity): string {
  const value = normalizeNullable(channel.channelUrl) ?? normalizeNullable(channel.channelName);
  if (!value) {
    throw new Error("Channel preference requires a channelUrl or channelName.");
  }

  return value;
}

function emptyChannelPreferenceFile(): ChannelPreferenceFile {
  return {
    version: 1,
    records: []
  };
}

function normalizeNullable(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isChannelPreferenceRecord(value: unknown): value is ChannelPreferenceRecord {
  return isRecord(value)
    && (value.preference === "always_allow_channel" || value.preference === "always_block_channel")
    && typeof value.matchValue === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}
