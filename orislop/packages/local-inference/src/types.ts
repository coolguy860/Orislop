import type {
  EvidenceItem,
  ExtractedShort
} from "../../shared/src/types.ts";

export type AdapterKind =
  | "embedding"
  | "openclip"
  | "ocr"
  | "local_llm"
  | "whisper"
  | "existing_ai_detector"
  | "spatial_detector"
  | "temporal_detector"
  | "fusion_detector";

export type AdapterMode =
  | "disabled"
  | "mock"
  | "subprocess"
  | "localhost";

export type AdapterConfig = {
  id: string;
  kind: AdapterKind;
  enabled: boolean;
  mode?: AdapterMode;
  modelPath?: string | null;
  checkpointPath?: string | null;
  checkpointPaths?: string[];
  configPath?: string | null;
  detectorRoot?: string | null;
  scriptPath?: string | null;
  thresholdPath?: string | null;
  requiredFiles?: string[];
  pythonPath?: string | null;
  timeoutMs?: number;
  notes?: string;
  hfRepoId?: string | null;
  localModelDirectory?: string | null;
  endpoint?: string | null;
};

export type ModelAdaptersConfig = {
  version: 1;
  adapters: Record<string, AdapterConfig>;
};

export type LocalInferenceRequest = {
  short: ExtractedShort;
  mediaPath?: string | null;
  framePaths?: string[];
  framesDirectory?: string | null;
  audioPath?: string | null;
};

export type LocalInferenceResult = {
  adapterId: string;
  adapterKind: AdapterKind;
  applicable: boolean;
  score: number | null;
  confidence: number;
  categories: string[];
  evidence: EvidenceItem[];
  reason: string;
  error: string | null;
  metadata?: Record<string, unknown>;
  runtimeMs?: number;
};

export type LocalModelAdapter = {
  id: string;
  kind: AdapterKind;
  config: AdapterConfig;
  analyze: (request: LocalInferenceRequest) => Promise<LocalInferenceResult>;
};
