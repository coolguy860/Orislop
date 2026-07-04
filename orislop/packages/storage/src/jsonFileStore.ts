import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LocalStorageOptions } from "./types.ts";

export type JsonReadResult<T> =
  | { status: "missing" }
  | { status: "valid"; value: T }
  | { status: "malformed"; error: unknown };

export function resolveStorageFile(
  options: LocalStorageOptions,
  fileName: string
): string {
  const basePath = options.basePath?.trim();
  if (!basePath) {
    throw new Error("Storage basePath is required.");
  }

  return join(resolve(basePath), fileName);
}

export async function readJsonFile<T>(filePath: string): Promise<JsonReadResult<T>> {
  try {
    const text = await readFile(filePath, "utf8");
    return {
      status: "valid",
      value: JSON.parse(text) as T
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }

    return {
      status: "malformed",
      error
    };
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())));
}

function isNodeError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
