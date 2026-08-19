import { parseYouTubeUrl } from "./youtube";

export type StaticStrictness = "relaxed" | "balanced" | "strict";

export type StaticScoreInput = {
  url: string;
  title?: string;
  description?: string;
  strictness: StaticStrictness;
};

export type StaticScoreResult = {
  score: number;
  recommendation: "watch" | "questionable" | "skip";
  reasons: string[];
  signalBreakdown: Array<{
    label: string;
    points: number;
  }>;
  confidence: "low" | "medium" | "high";
  videoId: string | null;
  videoKind: "short" | "watch" | "unknown";
  baseScore: number;
  stackedSignalBoost: number;
  strictnessMultiplier: number;
  thresholds: {
    questionable: number;
    skip: number;
  };
};

type Rule = {
  label: string;
  weight: number;
  test: (text: string, input: StaticScoreInput) => boolean;
};

const CLICKBAIT = [
  "you won't believe",
  "you wont believe",
  "wait for it",
  "watch till the end",
  "watch until the end",
  "this changed everything",
  "nobody talks about this",
  "before they delete this",
  "do not skip",
  "shocking",
  "insane ending",
  "the truth about",
  "part 2"
];

const BRAINROT = [
  "brainrot",
  "minecraft parkour",
  "subway surfers",
  "mobile game background",
  "mobile gameplay",
  "parkour gameplay",
  "minecraft gameplay",
  "reddit story",
  "reddit stories",
  "reddit thread",
  "askreddit",
  "aita",
  "story narration",
  "silent minecraft parkour",
  "cozy sleep",
  "coziest sleep",
  "text to speech",
  "tts",
  "ai voice",
  "robot voice",
  "split screen",
  "family guy clips",
  "viral clips",
  "green screen",
  "greenscreen",
  "repost",
  "not mine",
  "credit unknown",
  "source unknown"
];

const SENSORY_FILLER = [
  "satisfying background",
  "satisfying video",
  "satisfying videos",
  "satisfying compilation",
  "satisfying compilations",
  "most satisfying",
  "ranking the most satisfying",
  "oddly satisfying",
  "asmr compilation",
  "asmr",
  "cozy sleep",
  "coziest sleep"
];

const AI_TERMS = [
  "ai generated",
  "ai-generated",
  "ai voice",
  "ai voiceover",
  "ai voice over",
  "generated with ai",
  "made with ai",
  "synthetic voice",
  "text to speech",
  "tts",
  "voice clone",
  "deepfake",
  "sora generated",
  "ai image",
  "ai video"
];

const REPOST_LOW_ORIGINALITY = [
  "compilation",
  "clips compilation",
  "viral clips",
  "best moments",
  "no commentary",
  "source unknown",
  "credit unknown",
  "not mine",
  "reupload",
  "re-upload",
  "reposted",
  "green screen",
  "greenscreen"
];

const SCAM_OR_CLAIM_BAIT = [
  "banks hate",
  "guaranteed passive income",
  "guaranteed income",
  "secret trick",
  "they don't want you to know",
  "before they delete this",
  "make money fast",
  "financial freedom",
  "cure",
  "miracle cure",
  "doctors hate"
];

const ENGAGEMENT_BAIT = [
  "like and follow",
  "subscribe for more",
  "follow for more",
  "follow for part",
  "comment below",
  "tag someone",
  "share this with"
];

const RULES: Rule[] = [
  {
    label: "Stacked slop-format pattern",
    weight: 42,
    test: (text) => hasStackedSlopFormat(text)
  },
  {
    label: "Reddit/TTS background-video format",
    weight: 38,
    test: (text) => isRedditTtsBackgroundFormat(text)
  },
  {
    label: "Long low-originality compilation",
    weight: 30,
    test: (text) => isLongLowOriginalityCompilation(text)
  },
  {
    label: "AI voice or synthetic narration",
    weight: 32,
    test: (text) => isAiNarration(text)
  },
  {
    label: "Repost or low-originality compilation",
    weight: 28,
    test: (text) => includesAny(text, REPOST_LOW_ORIGINALITY)
  },
  {
    label: "Scam or high-risk claim bait",
    weight: 28,
    test: (text) => includesAny(text, SCAM_OR_CLAIM_BAIT)
  },
  {
    label: "Clickbait wording",
    weight: 24,
    test: (text) => includesAny(text, CLICKBAIT)
  },
  {
    label: "Brainrot/slop format keywords",
    weight: 32,
    test: (text) => includesAny(text, BRAINROT)
  },
  {
    label: "Satisfying/ASMR filler context",
    weight: 8,
    test: (text) => isSensoryFiller(text)
  },
  {
    label: "Ranked sensory-list format",
    weight: 22,
    test: (text) => isRankedSensoryList(text)
  },
  {
    label: "Engagement bait language",
    weight: 20,
    test: (text) => includesAny(text, ENGAGEMENT_BAIT)
  },
  {
    label: "AI-generated content terms",
    weight: 24,
    test: (text) => includesAny(text, AI_TERMS)
  },
  {
    label: "Excessive emoji pattern",
    weight: 10,
    test: (text) => emojiCount(text) >= 3
  },
  {
    label: "Spammy capitalization or punctuation",
    weight: 12,
    test: (_text, input) => {
      const originalText = [input.title, input.description].filter(Boolean).join(" ");
      return /[!?]{3,}/.test(originalText) || allCapsWordCount(originalText) >= 3;
    }
  },
  {
    label: "Repetitive title/caption",
    weight: 14,
    test: (text) => !isSongOrLyricsContext(text) && hasRepetition(text)
  },
  {
    label: "Low-information title",
    weight: 22,
    test: (_text, input) => isLowInformationTitle(input.title ?? "")
  },
  {
    label: "Shorts format signal",
    weight: 6,
    test: (_text, input) => parseYouTubeUrl(input.url).videoKind === "short"
  }
];

const STRICTNESS_MULTIPLIER: Record<StaticStrictness, number> = {
  relaxed: 0.72,
  balanced: 1,
  strict: 1.28
};

const THRESHOLDS = {
  questionable: 30,
  skip: 60
};

export function scoreStaticSlop(input: StaticScoreInput): StaticScoreResult {
  const parsed = parseYouTubeUrl(input.url);
  const multiplier = STRICTNESS_MULTIPLIER[input.strictness];
  if (!parsed.isYouTubeUrl || !parsed.videoId) {
    return {
      score: 0,
      recommendation: "watch",
      reasons: ["Enter a valid YouTube URL to score this item"],
      signalBreakdown: [],
      confidence: "low",
      videoId: null,
      videoKind: "unknown",
      baseScore: 0,
      stackedSignalBoost: 0,
      strictnessMultiplier: multiplier,
      thresholds: THRESHOLDS
    };
  }

  const text = normalize([
    input.title,
    input.description,
    parsed.videoKind === "short" ? "youtube shorts" : ""
  ].filter(Boolean).join(" "));
  const reasons: string[] = [];
  const signalBreakdown: StaticScoreResult["signalBreakdown"] = [];
  let rawScore = 0;

  for (const rule of RULES) {
    if (rule.test(text, input)) {
      rawScore += rule.weight;
      reasons.push(rule.label);
      signalBreakdown.push({
        label: rule.label,
        points: rule.weight
      });
    }
  }

  const boostableSignalCount = reasons.filter((reason) => ![
    "Shorts format signal",
    "Satisfying/ASMR filler context"
  ].includes(reason)).length;
  const stackedSignalBoost = Math.max(0, boostableSignalCount - 2) * 4;
  const score = clampScore((rawScore + stackedSignalBoost) * multiplier);
  const recommendation = score >= THRESHOLDS.skip ? "skip" : score >= THRESHOLDS.questionable ? "questionable" : "watch";
  const confidence = reasons.length >= 4 ? "high" : reasons.length >= 2 ? "medium" : "low";

  return {
    score,
    recommendation,
    reasons: reasons.length > 0 ? reasons : ["No strong static slop signals found"],
    signalBreakdown,
    confidence,
    videoId: parsed.videoId,
    videoKind: parsed.videoKind,
    baseScore: rawScore,
    stackedSignalBoost,
    strictnessMultiplier: multiplier,
    thresholds: THRESHOLDS
  };
}

function includesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function isRedditTtsBackgroundFormat(text: string): boolean {
  const hasStorySource = /\b(reddit|askreddit|aita|storytime|story|stories|thread)\b/.test(text);
  const hasBackgroundVideo = /\b(minecraft|parkour|subway surfers|mobile game|gameplay|satisfying background|silent minecraft parkour)\b/.test(text);
  const hasSyntheticNarration = /\b(text to speech|tts|ai voice|robot voice|voiceover)\b/.test(text);
  return hasStorySource && (hasBackgroundVideo || hasSyntheticNarration);
}

function isAiNarration(text: string): boolean {
  return /\b(ai voice|ai voiceover|ai voice over|text to speech|tts|robot voice|synthetic voice|voice clone)\b/.test(text);
}

function hasStackedSlopFormat(text: string): boolean {
  const hasStory = /\b(reddit|askreddit|aita|story|stories|thread)\b/.test(text);
  const hasBackground = /\b(minecraft|parkour|subway surfers|mobile game|gameplay)\b/.test(text);
  const hasSyntheticNarration = /\b(text to speech|tts|ai voice|robot voice|voiceover|narration)\b/.test(text);
  const hasLowOriginalitySource = /\b(viral clips|clips compilation|family guy clips|repost|reuploaded|re-upload|source unknown|credit unknown|not mine|no commentary|green screen|greenscreen)\b/.test(text);
  const hardSignalCount = [hasStory, hasBackground, hasSyntheticNarration, hasLowOriginalitySource].filter(Boolean).length;

  return hardSignalCount >= 2;
}

function isLongLowOriginalityCompilation(text: string): boolean {
  const hasLongDuration = /\b([1-9]|1[0-2])\s*(hour|hours|hr|hrs)\b/.test(text);
  const hasLowOriginalityTopic = /\b(reddit|stories|story|minecraft|parkour|subway surfers|viral clips|clips compilation|source unknown|credit unknown|not mine|repost|reupload|text to speech|tts|ai voice|robot voice)\b/.test(text)
    || (/\b(compilation|clips)\b/.test(text) && /\b(no commentary|source unknown|credit unknown|viral|ai voice|tts|repost|reupload)\b/.test(text));
  return hasLongDuration && hasLowOriginalityTopic;
}

function isSensoryFiller(text: string): boolean {
  return includesAny(text, SENSORY_FILLER) && !isSongOrLyricsContext(text);
}

function isRankedSensoryList(text: string): boolean {
  return isSensoryFiller(text)
    && /\b(ranking|ranked|top\s*\d+|most satisfying|best satisfying|satisfying compilation|asmr compilation)\b/.test(text);
}

function emojiCount(text: string): number {
  return Array.from(text).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
}

function allCapsWordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /^[A-Z]{4,}$/.test(word)).length;
}

function hasRepetition(text: string): boolean {
  const words = text.match(/[a-z0-9']+/gi)?.map((word) => word.toLowerCase()) ?? [];
  if (words.length < 10) {
    return false;
  }

  const uniqueRatio = new Set(words).size / words.length;
  const counts = new Map<string, number>();
  for (let index = 0; index < words.length - 1; index += 1) {
    const key = `${words[index]} ${words[index + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return uniqueRatio < 0.45 || Array.from(counts.values()).some((count) => count >= 3);
}

function isSongOrLyricsContext(text: string): boolean {
  return /\b(song|songs|lyrics|chorus|verse|hook|music|track|cover|remix|karaoke|performance|practice)\b/.test(text);
}

function isLowInformationTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) {
    return false;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const hashtagTokens = tokens.filter((token) => /^#[a-zA-Z0-9_-]+$/.test(token));
  return trimmed.length < 12
    || (tokens.length >= 2 && hashtagTokens.length === tokens.length)
    || (tokens.length >= 4 && hashtagTokens.length / tokens.length >= 0.75);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
