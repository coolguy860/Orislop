import type { StaticScoreResult } from "./staticSlopScore";
import { AI_CLASSIFIER_MODEL } from "./aiClassifierModel.generated";

export type AiClassifierInput = {
  url?: string;
  title?: string;
  description?: string;
  channelName?: string;
  transcript?: string;
  durationSeconds?: number | null;
  isShort?: boolean;
  heuristicScore?: number | null;
  matchedSignals?: string[];
};

export type AiClassifierResult = {
  available: boolean;
  modelId: string;
  artifactHash: string;
  slopProbability: number;
  score: number;
  predictedLabel: string;
  confidence: "low" | "medium" | "high";
  topFeatures: Array<{
    term: string;
    contribution: number;
  }>;
  reason: string;
};

type ModelFeature = [term: string, idf: number, weight: number];

const MODEL_ID = AI_CLASSIFIER_MODEL.modelId;
const MODEL_INTERCEPT = AI_CLASSIFIER_MODEL.intercept;
const MODEL_THRESHOLD = AI_CLASSIFIER_MODEL.slopThreshold;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
  "you",
  "your"
]);

const LEGACY_MODEL_FEATURES: ModelFeature[] = [
  ["explains", 3.319114, -4.752464],
  ["test", 3.72458, -4.196035],
  ["basics", 3.72458, -4.114705],
  ["rain", 4.012262, -3.97708],
  ["explain", 3.72458, -3.419734],
  ["review", 4.012262, -3.283733],
  ["animation", 3.72458, -3.121577],
  ["educational", 3.72458, -2.977973],
  ["noodles", 4.012262, -2.953147],
  ["tutorial", 3.72458, -2.828244],
  ["science", 3.501436, -2.757886],
  ["background", 3.72458, 2.627166],
  ["ranking", 4.012262, 2.595117],
  ["creator", 3.164964, -2.528861],
  ["why", 4.012262, -2.496602],
  ["reddit", 3.164964, 2.475899],
  ["process", 3.72458, -2.454523],
  ["rainfall", 4.012262, -2.361012],
  ["original", 2.545925, -2.358964],
  ["studio", 4.012262, -2.331145],
  ["shadows", 4.012262, -2.261628],
  ["pacing", 4.012262, -2.258498],
  ["useful", 3.72458, -2.252229],
  ["repeated", 4.012262, -2.215536],
  ["notes", 3.319114, -2.174748],
  ["no_commentary", 3.319114, 2.153224],
  ["long_low-originality", 4.012262, 2.071008],
  ["hour", 4.012262, 2.071008],
  ["compilation_no", 3.72458, 2.061271],
  ["long", 3.72458, 2.033163],
  ["ai", 2.913649, 2.005379],
  ["kitchen", 4.012262, -1.988432],
  ["no", 2.913649, 1.971864],
  ["repost", 3.031432, 1.939984],
  ["voice", 3.164964, 1.928963],
  ["signal", 3.031432, -1.924866],
  ["shorts_format", 3.031432, -1.924866],
  ["format_signal", 3.031432, -1.924866],
  ["__signal_shorts_format_signal__", 3.031432, -1.924866],
  ["vlog", 4.012262, -1.898203],
  ["truth", 3.501436, 1.889031],
  ["performance", 3.72458, -1.886313],
  ["more", 4.012262, 1.854348],
  ["surfers", 3.72458, 1.80336],
  ["subway_surfers", 3.72458, 1.80336],
  ["subway", 3.72458, 1.80336],
  ["secret", 3.72458, 1.793265],
  ["room", 4.012262, -1.791483],
  ["through", 4.012262, -1.783986],
  ["song", 4.012262, -1.762627],
  ["music", 4.012262, -1.762627],
  ["terms", 3.501436, 1.752652],
  ["content_terms", 3.501436, 1.752652],
  ["content", 3.501436, 1.752652],
  ["ai-generated_content", 3.501436, 1.752652],
  ["ai-generated", 3.501436, 1.752652],
  ["__signal_ai_generated_content_terms__", 3.501436, 1.752652],
  ["generated", 3.72458, 1.751265],
  ["compilation", 2.545925, 1.735657],
  ["brainrot", 3.031432, 1.726563],
  ["cure", 3.72458, 1.724642],
  ["__heuristic_medium__", 2.545925, 1.720155],
  ["steps", 4.012262, -1.707736],
  ["__heuristic_low__", 1.743578, -1.700083],
  ["viral", 3.164964, 1.659316],
  ["walk", 4.012262, -1.636557],
  ["trick", 4.012262, 1.636529],
  ["truth_about", 4.012262, 1.614553],
  ["split", 4.012262, 1.584171],
  ["doctors", 3.72458, 1.554265],
  ["engagement_bait", 3.501436, 1.546376],
  ["engagement", 3.501436, 1.546376],
  ["bait_language", 3.501436, 1.546376],
  ["__signal_engagement_bait_language__", 3.501436, 1.546376],
  ["vault_repost", 4.012262, 1.534428],
  ["vault", 4.012262, 1.534428],
  ["sensory-list_format", 4.012262, 1.52335],
  ["sensory-list", 4.012262, 1.52335],
  ["ranked_sensory-list", 4.012262, 1.52335],
  ["ranked", 4.012262, 1.52335],
  ["oddly_satisfying", 4.012262, 1.52335],
  ["oddly", 4.012262, 1.52335],
  ["best_moments", 3.72458, 1.508912],
  ["best", 3.72458, 1.508912],
  ["no_source", 4.012262, 1.476255],
  ["unknown", 3.319114, 1.456309],
  ["loop", 3.72458, 1.454857],
  ["screen_reaction", 4.012262, 1.442491],
  ["reaction", 4.012262, 1.442491],
  ["low-originality_compilation", 2.808289, 1.400018]
];

// Runtime inference is generated from the canonical JSON artifact. The
// legacy constant remains temporarily as a source-history reference but is
// deliberately not used for inference.
void LEGACY_MODEL_FEATURES;
const MODEL_FEATURES: ModelFeature[] = AI_CLASSIFIER_MODEL.features
  .map((feature) => [feature.term, feature.idf, feature.weight]);

const FEATURE_MAP = new Map(MODEL_FEATURES.map(([term, idf, weight]) => [term, { idf, weight }]));

export function runAiClassifier(input: AiClassifierInput): AiClassifierResult {
  if (MODEL_FEATURES.length === 0) {
    return unavailableAiResult("No AI classifier model artifact is bundled.");
  }

  const terms = extractTerms(input);
  const counts = new Map<string, number>();
  for (const term of terms) {
    if (FEATURE_MAP.has(term)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return {
      available: true,
      modelId: MODEL_ID,
      artifactHash: AI_CLASSIFIER_MODEL.artifactHash,
      slopProbability: sigmoid(MODEL_INTERCEPT),
      score: Math.round(sigmoid(MODEL_INTERCEPT) * 100),
      predictedLabel: "not_slop",
      confidence: "low",
      topFeatures: [],
      reason: "AI classifier found no known weighted features in the provided metadata."
    };
  }

  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  const tfidf = new Map<string, number>();
  for (const [term, count] of counts) {
    const feature = FEATURE_MAP.get(term);
    if (!feature) {
      continue;
    }
    tfidf.set(term, (count / total) * feature.idf);
  }

  const norm = Math.sqrt(Array.from(tfidf.values()).reduce((sum, value) => sum + value * value, 0)) || 1;
  const contributions = Array.from(tfidf.entries()).map(([term, value]) => {
    const feature = FEATURE_MAP.get(term);
    return {
      term,
      contribution: ((feature?.weight ?? 0) * value) / norm
    };
  });
  const linear = MODEL_INTERCEPT + contributions.reduce((sum, item) => sum + item.contribution, 0);
  const probability = sigmoid(linear);
  const topFeatures = contributions
    .filter((item) => Math.abs(item.contribution) > 0.001)
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    .slice(0, 5)
    .map((item) => ({
      term: item.term,
      contribution: Number(item.contribution.toFixed(3))
    }));

  return {
    available: true,
    modelId: MODEL_ID,
    artifactHash: AI_CLASSIFIER_MODEL.artifactHash,
    slopProbability: Number(probability.toFixed(4)),
    score: Math.round(probability * 100),
    predictedLabel: predictLabel(input, topFeatures, probability),
    confidence: confidenceForProbability(probability, topFeatures.length),
    topFeatures,
    reason: `Local ${MODEL_ID} TF-IDF logistic classifier ran on available text/metadata.`
  };
}

export function inputFromHeuristic(
  source: AiClassifierInput,
  heuristic: StaticScoreResult
): AiClassifierInput {
  return {
    ...source,
    // Transcript rules are fused as a separate source. Excluding transcript
    // here keeps the same words from contributing under two score weights.
    transcript: "",
    isShort: heuristic.videoKind === "short",
    // The heuristic is fused as its own source. Feeding its score and reason
    // labels back into the classifier would make the same evidence appear to
    // corroborate itself under the separate "AI classifier" weight.
    heuristicScore: null,
    matchedSignals: []
  };
}

export function unavailableAiResult(reason: string): AiClassifierResult {
  return {
    available: false,
    modelId: MODEL_ID,
    artifactHash: AI_CLASSIFIER_MODEL.artifactHash,
    slopProbability: 0,
    score: 0,
    predictedLabel: "unavailable",
    confidence: "low",
    topFeatures: [],
    reason
  };
}

function extractTerms(input: AiClassifierInput): string[] {
  const text = [
    input.title,
    input.description,
    input.channelName,
    input.transcript,
    ...(input.matchedSignals ?? [])
  ].filter(Boolean).join(" ");
  const tokens = tokenize(text);
  const bigrams = tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1]}`);
  const terms = [...tokens, ...bigrams];

  terms.push(input.isShort ? "__short__" : "__watch__");
  const durationSeconds = input.durationSeconds ?? 0;
  if (durationSeconds >= 1800) {
    terms.push("__duration_long__");
  } else if (durationSeconds > 0 && durationSeconds <= 75) {
    terms.push("__duration_short__");
  } else if (durationSeconds > 0) {
    terms.push("__duration_medium__");
  }

  const heuristicScore = input.heuristicScore ?? null;
  if (heuristicScore !== null) {
    if (heuristicScore >= 70) {
      terms.push("__heuristic_high__");
    } else if (heuristicScore >= 35) {
      terms.push("__heuristic_medium__");
    } else if (heuristicScore <= 8) {
      terms.push("__heuristic_low__");
    }
  }

  for (const signal of input.matchedSignals ?? []) {
    const clean = signal.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (clean) {
      terms.push(`__signal_${clean}__`);
    }
  }

  return terms;
}

function tokenize(value: string): string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9_'-]*/g) ?? [];
  return tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function confidenceForProbability(probability: number, featureCount: number): "low" | "medium" | "high" {
  const distance = Math.abs(probability - MODEL_THRESHOLD);
  if (featureCount >= 3 && distance >= 0.28) {
    return "high";
  }
  if (featureCount >= 2 && distance >= 0.13) {
    return "medium";
  }
  return "low";
}

function predictLabel(input: AiClassifierInput, topFeatures: Array<{ term: string }>, probability: number): string {
  const text = [
    input.title,
    input.description,
    input.channelName,
    input.transcript,
    ...(input.matchedSignals ?? []),
    ...topFeatures.map((feature) => feature.term)
  ].join(" ").toLowerCase();

  if (probability < MODEL_THRESHOLD) {
    if (/\b(science|explains|tutorial|lesson|history|math|educational)\b/.test(text)) {
      return "normal_educational";
    }
    if (/\b(original|creator|recipe|repair|commentary|vlog|studio)\b/.test(text)) {
      return "normal_creator";
    }
    return "not_slop";
  }

  if (/\b(reddit|aita|story|stories|minecraft|parkour|text_to|tts)\b/.test(text)) {
    return "reddit_story";
  }
  if (/\b(ai|voice|synthetic|deepfake|generated)\b/.test(text)) {
    return "ai_voice";
  }
  if (/\b(guaranteed|banks|doctors|cure|miracle|secret|trick)\b/.test(text)) {
    return "scam_bait";
  }
  if (/\b(repost|compilation|clips|source|unknown|credit|no_commentary)\b/.test(text)) {
    return "repost_compilation";
  }
  if (/\b(brainrot|subway|surfers|split|screen|viral|ranking)\b/.test(text)) {
    return "brainrot_format";
  }
  return "slop";
}
