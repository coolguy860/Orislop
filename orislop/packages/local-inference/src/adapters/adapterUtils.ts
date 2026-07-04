import { existsSync } from "node:fs";
import path from "node:path";
import { clamp01 } from "../../../shared/src/clamp.ts";
import type { EvidenceItem } from "../../../shared/src/types.ts";
import type {
  AdapterConfig,
  AdapterKind,
  LocalInferenceResult
} from "../types.ts";

export function disabledAdapterResult(config: AdapterConfig, started = Date.now()): LocalInferenceResult {
  return unavailableAdapterResult(
    config,
    `${config.id} is disabled in model adapter config.`,
    started,
    "disabled"
  );
}

export function unavailableAdapterResult(
  config: Pick<AdapterConfig, "id" | "kind">,
  error: string,
  started = Date.now(),
  reason = "Adapter unavailable."
): LocalInferenceResult {
  return {
    adapterId: config.id,
    adapterKind: config.kind,
    applicable: false,
    score: null,
    confidence: 0,
    categories: [],
    evidence: [],
    reason,
    error,
    runtimeMs: Date.now() - started
  };
}

export function availableAdapterResult(input: {
  config: Pick<AdapterConfig, "id" | "kind">;
  score: number;
  confidence?: number;
  categories: string[];
  evidence: EvidenceItem[];
  reason: string;
  metadata?: Record<string, unknown>;
  started?: number;
}): LocalInferenceResult {
  return {
    adapterId: input.config.id,
    adapterKind: input.config.kind,
    applicable: true,
    score: clamp01(input.score),
    confidence: clamp01(input.confidence ?? 0.75),
    categories: input.categories,
    evidence: input.evidence,
    reason: input.reason,
    error: null,
    metadata: input.metadata,
    runtimeMs: Date.now() - (input.started ?? Date.now())
  };
}

export function normalizeAdapterConfig(
  config: Partial<AdapterConfig> & Pick<AdapterConfig, "id" | "kind">
): AdapterConfig {
  return {
    enabled: false,
    mode: "disabled",
    ...config
  };
}

export function ensureEnabled(config: AdapterConfig, started: number): LocalInferenceResult | null {
  if (!config.enabled || config.mode === "disabled") {
    return disabledAdapterResult(config, started);
  }

  return null;
}

export function requireReadablePath(
  config: AdapterConfig,
  field: keyof Pick<
    AdapterConfig,
    "modelPath" | "checkpointPath" | "configPath" | "detectorRoot" | "scriptPath" | "thresholdPath"
  >,
  label: string,
  started: number,
  basePath?: string | null
): LocalInferenceResult | null {
  const value = config[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return unavailableAdapterResult(config, `${label} is not configured.`, started, "Missing configured path.");
  }

  const resolved = resolveConfiguredPath(value, basePath);
  if (!existsSync(resolved)) {
    return unavailableAdapterResult(config, `${label} does not exist: ${value}`, started, "Configured path is unavailable.");
  }

  return null;
}

export function requireAnyReadablePath(
  config: AdapterConfig,
  fields: Array<keyof Pick<AdapterConfig, "modelPath" | "checkpointPath" | "configPath">>,
  label: string,
  started: number,
  basePath?: string | null
): LocalInferenceResult | null {
  const configured = fields
    .map((field) => config[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (configured.length === 0) {
    return unavailableAdapterResult(config, `${label} is not configured.`, started, "Missing configured path.");
  }

  const hasExistingPath = configured.some((value) => existsSync(resolveConfiguredPath(value, basePath)));
  if (!hasExistingPath) {
    return unavailableAdapterResult(config, `${label} does not exist: ${configured.join(", ")}`, started, "Configured path is unavailable.");
  }

  return null;
}

export function requireAllCheckpointPaths(
  config: AdapterConfig,
  started: number,
  basePath?: string | null
): LocalInferenceResult | null {
  const paths = [
    ...(config.checkpointPath ? [config.checkpointPath] : []),
    ...(config.checkpointPaths ?? [])
  ].filter((value) => value.trim().length > 0);

  if (paths.length === 0) {
    return unavailableAdapterResult(config, "No checkpoint path is configured.", started, "Missing configured checkpoint.");
  }

  const missing = paths.filter((value) => !existsSync(resolveConfiguredPath(value, basePath)));
  if (missing.length > 0) {
    return unavailableAdapterResult(config, `Checkpoint path does not exist: ${missing.join(", ")}`, started, "Configured checkpoint is unavailable.");
  }

  return null;
}

export function requireFilesUnderRoot(
  config: AdapterConfig,
  started: number
): LocalInferenceResult | null {
  const root = config.detectorRoot;
  if (typeof root !== "string" || root.trim().length === 0) {
    return unavailableAdapterResult(config, "Detector root is not configured.", started, "Missing detector root.");
  }

  const resolvedRoot = resolveConfiguredPath(root);
  if (!existsSync(resolvedRoot)) {
    return unavailableAdapterResult(config, `Detector root does not exist: ${root}`, started, "Configured detector root is unavailable.");
  }

  const missing = (config.requiredFiles ?? [])
    .map((fileName) => path.join(resolvedRoot, fileName))
    .filter((filePath) => !existsSync(filePath));

  if (missing.length > 0) {
    return unavailableAdapterResult(
      config,
      `Required detector files are missing: ${missing.map((filePath) => path.basename(filePath)).join(", ")}`,
      started,
      "Required detector files are unavailable."
    );
  }

  return null;
}

export function resolveConfiguredPath(value: string, basePath?: string | null): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(basePath ?? process.cwd(), value);
}

export function evidenceForAdapter(input: {
  reasonId: string;
  label: string;
  detail: string;
  weight: number;
  confidence: number;
  source: AdapterKind | string;
}): EvidenceItem {
  return {
    reasonId: input.reasonId,
    label: input.label,
    detail: input.detail,
    weight: clamp01(input.weight),
    confidence: clamp01(input.confidence),
    source: input.source
  };
}
