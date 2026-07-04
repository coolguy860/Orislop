export type {
  AdapterConfig,
  AdapterKind,
  AdapterMode,
  LocalInferenceRequest,
  LocalInferenceResult,
  LocalModelAdapter,
  ModelAdaptersConfig
} from "./types.ts";

export {
  availableAdapterResult,
  disabledAdapterResult,
  evidenceForAdapter,
  normalizeAdapterConfig,
  unavailableAdapterResult
} from "./adapters/adapterUtils.ts";

export { createMiniLmAdapter } from "./adapters/minilmAdapter.ts";
export { createOpenClipAdapter } from "./adapters/openclipAdapter.ts";
export { createOcrAdapter } from "./adapters/ocrAdapter.ts";
export { createLocalLlmAdapter } from "./adapters/localLlmAdapter.ts";
export { createWhisperAdapter } from "./adapters/whisperAdapter.ts";
export { createExistingAiDetectorAdapter } from "./adapters/existingAiDetectorAdapter.ts";
export { createSpatialDetectorAdapter } from "./adapters/spatialDetectorAdapter.ts";
export { createTemporalDetectorAdapter } from "./adapters/temporalDetectorAdapter.ts";

export { createMockEmbeddingAdapter } from "./mocks/mockEmbedding.ts";
export { createMockOpenClipAdapter } from "./mocks/mockOpenClip.ts";
export { createMockOcrAdapter } from "./mocks/mockOcr.ts";
export { createMockLocalLlmAdapter } from "./mocks/mockLocalLlm.ts";
export { createMockWhisperAdapter } from "./mocks/mockWhisper.ts";
export { createMockExistingAiDetectorAdapter } from "./mocks/mockExistingAiDetector.ts";
export { createMockSpatialDetectorAdapter } from "./mocks/mockSpatialDetector.ts";
export { createMockTemporalDetectorAdapter } from "./mocks/mockTemporalDetector.ts";
