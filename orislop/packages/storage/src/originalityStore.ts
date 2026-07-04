import type { ExtractedShort } from "../../shared/src/types.ts";
import {
  nowIso,
  readJsonFile,
  resolveStorageFile,
  writeJsonFile
} from "./jsonFileStore.ts";
import type {
  OriginalityMatchRecord,
  OriginalityStoreOptions,
  OriginalityVectorRecord
} from "./types.ts";

const ORIGINALITY_INDEX_FILE = "originality_index.json";
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_VECTOR_DIMENSIONS = 48;

export class LocalOriginalityStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private readonly vectorDimensions: number;
  private readonly now?: () => Date;

  constructor(options: OriginalityStoreOptions) {
    this.filePath = resolveStorageFile(options, ORIGINALITY_INDEX_FILE);
    this.maxRecords = Math.max(100, Math.min(50000, Math.round(options.maxRecords ?? DEFAULT_MAX_RECORDS)));
    this.vectorDimensions = Math.max(16, Math.min(256, Math.round(options.vectorDimensions ?? DEFAULT_VECTOR_DIMENSIONS)));
    this.now = options.now;
  }

  async list(): Promise<OriginalityVectorRecord[]> {
    return this.load();
  }

  async upsert(short: ExtractedShort): Promise<OriginalityVectorRecord> {
    const records = await this.load();
    const cacheKey = originalityKey(short);
    const timestamp = nowIso(this.now);
    const existingIndex = records.findIndex((record) => record.cacheKey === cacheKey);
    const next: OriginalityVectorRecord = {
      cacheKey,
      videoId: short.videoId,
      url: short.url,
      title: short.title,
      channelName: short.channelName,
      channelUrl: short.channelUrl,
      metadataFingerprint: metadataFingerprintForShort(short),
      vector: metadataVectorForShort(short, this.vectorDimensions),
      seenCount: existingIndex >= 0 ? records[existingIndex].seenCount + 1 : 1,
      firstSeenAt: existingIndex >= 0 ? records[existingIndex].firstSeenAt : timestamp,
      lastSeenAt: timestamp
    };

    if (existingIndex >= 0) {
      records[existingIndex] = next;
    } else {
      records.push(next);
    }

    await this.persist(pruneRecords(records, this.maxRecords));
    return next;
  }

  async findSimilar(
    short: ExtractedShort,
    options: { limit?: number; minSimilarity?: number } = {}
  ): Promise<OriginalityMatchRecord[]> {
    const limit = Math.max(1, Math.min(20, Math.round(options.limit ?? 5)));
    const minSimilarity = Math.max(0, Math.min(1, options.minSimilarity ?? 0.86));
    const records = await this.load();
    const currentKey = originalityKey(short);
    const vector = metadataVectorForShort(short, this.vectorDimensions);

    return records
      .filter((record) => record.cacheKey !== currentKey && record.videoId !== short.videoId)
      .map((record) => ({
        videoId: record.videoId,
        url: record.url,
        title: record.title,
        channelName: record.channelName,
        channelUrl: record.channelUrl,
        similarity: Number(cosineSimilarity(vector, record.vector).toFixed(4))
      }))
      .filter((match) => match.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  private async load(): Promise<OriginalityVectorRecord[]> {
    const read = await readJsonFile<unknown>(this.filePath);
    if (read.status !== "valid" || !Array.isArray(read.value)) {
      if (read.status === "malformed") {
        await this.persist([]);
      }
      return [];
    }

    return read.value
      .filter(isOriginalityRecord)
      .slice(-this.maxRecords);
  }

  private async persist(records: OriginalityVectorRecord[]): Promise<void> {
    await writeJsonFile(this.filePath, records);
  }
}

export function metadataFingerprintForShort(short: ExtractedShort): string {
  return tokenizeShort(short)
    .slice(0, 80)
    .join(" ");
}

export function metadataVectorForShort(
  short: ExtractedShort,
  dimensions = DEFAULT_VECTOR_DIMENSIONS
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenizeShort(short);

  for (const token of tokens) {
    const index = stableHash(token) % dimensions;
    vector[index] += 1;
  }

  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0
    ? vector
    : vector.map((value) => Number((value / length).toFixed(6)));
}

function tokenizeShort(short: ExtractedShort): string[] {
  const text = [
    short.title,
    short.channelName,
    short.description,
    short.visiblePageText,
    short.transcript,
    short.hashtags.join(" ")
  ].filter(Boolean).join(" ").toLowerCase();

  return text
    .replace(/https?:\/\/\S+/g, " ")
    .match(/[a-z0-9_#'-]{3,}/g)
    ?.filter((token) => !STOP_WORDS.has(token))
    .slice(0, 600) ?? [];
}

function originalityKey(short: ExtractedShort): string {
  return short.videoId
    ? `video:${short.videoId}`
    : `url:${short.url}`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function pruneRecords(records: OriginalityVectorRecord[], maxRecords: number): OriginalityVectorRecord[] {
  return records
    .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
    .slice(-maxRecords);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isOriginalityRecord(value: unknown): value is OriginalityVectorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.cacheKey === "string"
    && (typeof record.videoId === "string" || record.videoId === null)
    && typeof record.url === "string"
    && (typeof record.title === "string" || record.title === null)
    && (typeof record.channelName === "string" || record.channelName === null)
    && (typeof record.channelUrl === "string" || record.channelUrl === null)
    && typeof record.metadataFingerprint === "string"
    && Array.isArray(record.vector)
    && record.vector.every((item) => typeof item === "number" && Number.isFinite(item))
    && typeof record.seenCount === "number"
    && typeof record.firstSeenAt === "string"
    && typeof record.lastSeenAt === "string";
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "but",
  "not",
  "your",
  "our",
  "their",
  "shorts",
  "youtube"
]);
