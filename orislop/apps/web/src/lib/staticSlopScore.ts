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
  confidence: "low" | "medium" | "high";
  videoId: string | null;
  videoKind: "short" | "watch" | "unknown";
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
  "part 2"
];

const BRAINROT = [
  "brainrot",
  "minecraft parkour",
  "subway surfers",
  "satisfying background",
  "mobile game background",
  "reddit story",
  "askreddit",
  "text to speech",
  "tts",
  "ai voice",
  "viral clips",
  "compilation",
  "green screen",
  "greenscreen",
  "repost",
  "not mine",
  "credit unknown",
  "source unknown"
];

const AI_TERMS = [
  "ai generated",
  "ai-generated",
  "generated with ai",
  "made with ai",
  "synthetic voice",
  "voice clone",
  "deepfake",
  "sora generated",
  "ai image",
  "ai video"
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
    label: "Clickbait wording",
    weight: 18,
    test: (text) => includesAny(text, CLICKBAIT)
  },
  {
    label: "Brainrot/slop format keywords",
    weight: 22,
    test: (text) => includesAny(text, BRAINROT)
  },
  {
    label: "Engagement bait language",
    weight: 16,
    test: (text) => includesAny(text, ENGAGEMENT_BAIT)
  },
  {
    label: "AI-generated content terms",
    weight: 18,
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
    test: (text) => /[!?]{3,}/.test(text) || allCapsWordCount(text) >= 3
  },
  {
    label: "Repetitive title/caption",
    weight: 14,
    test: (text) => hasRepetition(text)
  },
  {
    label: "Low-information title",
    weight: 14,
    test: (_text, input) => isLowInformationTitle(input.title ?? "")
  },
  {
    label: "Shorts format signal",
    weight: 8,
    test: (_text, input) => parseYouTubeUrl(input.url).videoKind === "short"
  }
];

const STRICTNESS_MULTIPLIER: Record<StaticStrictness, number> = {
  relaxed: 0.78,
  balanced: 1,
  strict: 1.22
};

export function scoreStaticSlop(input: StaticScoreInput): StaticScoreResult {
  const parsed = parseYouTubeUrl(input.url);
  const text = normalize([
    input.title,
    input.description,
    parsed.videoKind === "short" ? "youtube shorts" : ""
  ].filter(Boolean).join(" "));
  const reasons: string[] = [];
  let rawScore = 0;

  for (const rule of RULES) {
    if (rule.test(text, input)) {
      rawScore += rule.weight;
      reasons.push(rule.label);
    }
  }

  const stackedSignalBoost = Math.max(0, reasons.length - 2) * 4;
  const score = clampScore((rawScore + stackedSignalBoost) * STRICTNESS_MULTIPLIER[input.strictness]);
  const recommendation = score >= 68 ? "skip" : score >= 36 ? "questionable" : "watch";
  const confidence = reasons.length >= 4 ? "high" : reasons.length >= 2 ? "medium" : "low";

  return {
    score,
    recommendation,
    reasons: reasons.length > 0 ? reasons : ["No strong static slop signals found"],
    confidence,
    videoId: parsed.videoId,
    videoKind: parsed.videoKind
  };
}

function includesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
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
