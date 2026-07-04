import { clamp01 } from "../../../shared/src/clamp.ts";

export type SlopPatternMatch = {
  reasonId: string;
  label: string;
  detail: string;
  category: string;
  weight: number;
  confidence: number;
};

type PhraseRule = {
  id: string;
  label: string;
  detail: string;
  category: string;
  weight: number;
  phrases?: readonly string[];
  patterns?: readonly RegExp[];
};

type RepetitionMatchOptions = {
  category?: "low_information" | "repetitive_format";
  label?: string;
};

export const STRONG_SLOP_PATTERN_RULES: readonly PhraseRule[] = [
  {
    id: "repetitive_hook",
    label: "Template-style engagement bait",
    detail: "Uses a repeated Shorts hook.",
    category: "engagement_bait",
    weight: 0.63,
    phrases: [
      "wait for it",
      "you won't believe",
      "you wont believe",
      "part 2",
      "story time",
      "storytime",
      "only legends will understand",
      "only boys will understand",
      "only girls will understand",
      "only gen z will understand",
      "watch till the end",
      "watch until the end",
      "i found this",
      "this changed everything",
      "this changes everything",
      "nobody talks about this",
      "bro thinks"
    ],
    patterns: [
      /\bonly\s+\d+%?\s+(?:of\s+)?(?:people|viewers|fans)\s+(?:will|can)\s+(?:understand|see|notice)\b/i,
      /\b(?:this|that)\s+(?:one\s+)?(?:trick|secret|hack)\s+(?:changed|changes)\s+everything\b/i
    ]
  },
  {
    id: "engagement_prompt",
    label: "Template-style engagement bait",
    detail: "Prompts viewers to comment, follow, or watch for a reveal.",
    category: "engagement_bait",
    weight: 0.58,
    phrases: [
      "comment below",
      "like and follow",
      "subscribe for more",
      "follow for part",
      "follow for more",
      "tag someone",
      "share this with",
      "what happens next",
      "did you notice"
    ],
    patterns: [
      /\bcomment\s+(?:your|if|for|below)\b/i,
      /\b(?:like|follow|subscribe)\s+(?:for|to)\s+(?:part|more|see)\b/i
    ]
  },
  {
    id: "reddit_tts_story",
    label: "Reddit/TTS story format",
    detail: "Uses Reddit or text-to-speech story framing.",
    category: "reddit_tts_story",
    weight: 0.69,
    phrases: [
      "ask reddit",
      "askreddit",
      "reddit story",
      "reddit stories",
      "aita",
      "am i the asshole",
      "tifu",
      "relationship advice",
      "subreddit",
      "r/",
      "upvote",
      "text to speech",
      "tts",
      "ai voice",
      "ai narrator",
      "ai voiceover",
      "robot voice",
      "voiceover story"
    ],
    patterns: [
      /\b(?:reddit|askreddit)\s+(?:story|stories|thread)\b/i,
      /\br\/[a-z0-9_]+\b/i
    ]
  },
  {
    id: "fake_chat_story",
    label: "Fake text/chat story format",
    detail: "Looks like a staged chat or role-labeled text story.",
    category: "fake_text_story",
    weight: 0.68,
    phrases: [
      "fake text",
      "text story",
      "text conversation",
      "chat story",
      "my mom texted",
      "my crush texted",
      "teacher:",
      "mom:",
      "dad:",
      "boss:",
      "girlfriend:",
      "boyfriend:"
    ],
    patterns: [
      /(?:^|\s)(?:me|mom|dad|bro|girl|boyfriend|girlfriend|teacher|boss|friend)\s*:\s+/i,
      /\b(?:pov|storytime):\s+(?:your|you|my)\b/i
    ]
  },
  {
    id: "background_game",
    label: "Template background-video format",
    detail: "Mentions common background gameplay/satisfying footage formats.",
    category: "template_brainrot",
    weight: 0.65,
    phrases: [
      "minecraft parkour",
      "minecraft background",
      "subway surfers",
      "satisfying background",
      "mobile game background",
      "slime video",
      "kinetic sand",
      "soap cutting",
      "gta gameplay",
      "fortnite background"
    ]
  },
  {
    id: "repost_like",
    label: "Likely repost/compilation format",
    detail: "Caption suggests reposted, copied, or compilation-style content.",
    category: "repost_like",
    weight: 0.61,
    phrases: [
      "credit unknown",
      "credits unknown",
      "not mine",
      "repost",
      "re-upload",
      "reupload",
      "compilation",
      "clip compilation",
      "clips compilation",
      "viral clips",
      "try not to laugh compilation",
      "best clips",
      "stolen clips",
      "borrowed clips",
      "found this",
      "stolen clip",
      "via tiktok",
      "source unknown"
    ]
  },
  {
    id: "ai_presented",
    label: "AI-generated or AI-presented content",
    detail: "Visible text suggests AI voice, AI image, or synthetic presentation.",
    category: "possible_unlabeled_ai",
    weight: 0.62,
    phrases: [
      "ai voice",
      "fake voice",
      "ai generated",
      "ai-generated",
      "generated with ai",
      "made with ai",
      "ai image",
      "ai video",
      "sora generated",
      "deepfake",
      "synthetic voice",
      "voice clone"
    ]
  },
  {
    id: "slop_channel_title",
    label: "Template-style channel/title pattern",
    detail: "Title or channel uses common content-farm wording.",
    category: "template_brainrot",
    weight: 0.55,
    phrases: [
      "daily facts",
      "random facts",
      "facts you didn't know",
      "viral clips",
      "brainrot",
      "story recap",
      "reddit recap",
      "ai stories",
      "text stories"
    ]
  }
];

export function collectStrongSlopPatternMatches(text: string, prefix: string): SlopPatternMatch[] {
  const normalized = normalizeText(text);
  const matches: SlopPatternMatch[] = [];

  for (const rule of STRONG_SLOP_PATTERN_RULES) {
    const phrase = rule.phrases?.find((candidate) => normalized.includes(candidate.toLowerCase()));
    const pattern = phrase ? null : rule.patterns?.find((candidate) => candidate.test(text));
    if (!phrase && !pattern) {
      continue;
    }

    const detail = phrase ? `${rule.detail} Matched "${phrase}".` : rule.detail;
    matches.push({
      reasonId: `${prefix}_${rule.id}`,
      label: rule.label,
      detail,
      category: rule.category,
      weight: rule.weight,
      confidence: clamp01(rule.weight + 0.12)
    });
  }

  if (hasAiVoiceCompilationPattern(normalized)) {
    matches.push({
      reasonId: `${prefix}_ai_voice_compilation`,
      label: "AI-voice compilation format",
      detail: "Combines AI/TTS voice cues with reposted or compilation-style clips.",
      category: "ai_slop",
      weight: 0.88,
      confidence: 0.86
    });
  }

  if (hasGreenScreenLowValuePattern(normalized)) {
    matches.push({
      reasonId: `${prefix}_green_screen_low_value`,
      label: "Green-screen/reaction format",
      detail: "Looks like a green-screen, stitch, duet, or reaction layer over someone else's clip with little visible added value.",
      category: "green_screen_reaction",
      weight: 0.72,
      confidence: 0.76
    });
  }

  if (hasLowOriginalityRepostPattern(normalized)) {
    matches.push({
      reasonId: `${prefix}_low_originality_repost`,
      label: "Low-originality repost/derivative clip",
      detail: "Visible wording suggests reposted or derivative footage with minimal added commentary or source value.",
      category: "low_originality_repost",
      weight: 0.78,
      confidence: 0.8
    });
  }

  return matches;
}

export function collectLowInformationMatches(
  text: string,
  prefix: string,
  options: RepetitionMatchOptions = {}
): SlopPatternMatch[] {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 18) {
    return [];
  }

  const category = options.category ?? "low_information";
  const label = options.label ?? (category === "repetitive_format"
    ? "Repetitive low-originality format"
    : "Low-information informational format");
  const uniqueRatio = new Set(words).size / words.length;
  const repeatedBigram = mostRepeatedNgram(words, 2);
  const repeatedTrigram = mostRepeatedNgram(words, 3);
  const matches: SlopPatternMatch[] = [];

  if (words.length >= 28 && uniqueRatio < 0.42) {
    matches.push({
      reasonId: `${prefix}_low_information_density`,
      label,
      detail: `Text repeats a small vocabulary (${Math.round(uniqueRatio * 100)}% unique words).`,
      category,
      weight: uniqueRatio < 0.32 ? 0.62 : 0.54,
      confidence: uniqueRatio < 0.32 ? 0.78 : 0.68
    });
  }

  if (repeatedBigram.count >= 4 || repeatedTrigram.count >= 3) {
    const ngram = repeatedTrigram.count >= 3 ? repeatedTrigram : repeatedBigram;
    matches.push({
      reasonId: `${prefix}_repeated_phrase_loop`,
      label,
      detail: `Repeats "${ngram.text}" ${ngram.count} times.`,
      category,
      weight: category === "repetitive_format" ? 0.52 : 0.6,
      confidence: 0.74
    });
  }

  return matches;
}

export function hasSongOrLyricsContext(text: string): boolean {
  return /\b(song|music|lyrics|lyric video|official audio|audio|sound|remix|cover|verse|chorus|sped up|slowed|instrumental|soundtrack)\b/i.test(text)
    || /(?:^|\s)#(?:song|music|lyrics|audio|remix|cover|soundtrack)\b/i.test(text);
}

export function hasInformationalContext(text: string): boolean {
  return /\b(?:learn|lesson|education|educational|explained|explainer|facts?|did you know|tutorial|guide|how to|why|study|research|scientists?|history|news|breaking|health|doctor|finance|crypto|stocks?|law|legal|proof|evidence|source)\b/i.test(text);
}

export function titleHashtagSpamMatch(title: string | null | undefined, prefix: string): SlopPatternMatch | null {
  const normalized = (title ?? "").trim();
  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const hashtagTokens = tokens.filter((token) => /^#[\p{L}\p{N}_-]+$/u.test(token));
  const plainText = normalized.replace(/#[\p{L}\p{N}_-]+/gu, "").trim();

  if (tokens.length >= 2 && hashtagTokens.length === tokens.length) {
    return {
      reasonId: `${prefix}_title_only_hashtags`,
      label: "Hashtag-only title",
      detail: "The title is made entirely of hashtags.",
      category: "low_information",
      weight: 0.68,
      confidence: 0.82
    };
  }

  if (tokens.length >= 4 && hashtagTokens.length / tokens.length >= 0.75 && plainText.length < 12) {
    return {
      reasonId: `${prefix}_title_mostly_hashtags`,
      label: "Hashtag-heavy title",
      detail: "The title is mostly hashtags with very little readable context.",
      category: "low_information",
      weight: 0.58,
      confidence: 0.72
    };
  }

  return null;
}

function mostRepeatedNgram(words: string[], size: number): { text: string; count: number } {
  const counts = new Map<string, number>();
  for (let index = 0; index <= words.length - size; index += 1) {
    const text = words.slice(index, index + size).join(" ");
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  let best = { text: "", count: 0 };
  for (const [text, count] of counts) {
    if (count > best.count) {
      best = { text, count };
    }
  }

  return best;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasAiVoiceCompilationPattern(normalized: string): boolean {
  const hasAiVoice = /\b(?:ai|synthetic|robot|tts|text to speech|generated|fake)\s+(?:voice|voiceover|narrator|narration)\b/i.test(normalized)
    || /\b(?:voice|voiceover|narrator|narration)\s+(?:made with|by|from)\s+(?:ai|tts)\b/i.test(normalized);
  const hasCompilation = /\b(?:compilation|clips?|repost|reupload|credit unknown|credits unknown|not mine|source unknown|viral clips?|best clips?|found this|stolen)\b/i.test(normalized);

  return hasAiVoice && hasCompilation;
}

function hasGreenScreenLowValuePattern(normalized: string): boolean {
  const hasGreenScreenOrReaction = /\b(?:green\s*screen|greenscreen|green-screen|stitch|duet|react(?:ing|ion|s)?|reaction overlay|watch me react|i reacted|reacting to)\b/i.test(normalized)
    || /(?:^|\s)#(?:greenscreen|stitch|duet|reaction)\b/i.test(normalized);
  const hasBorrowedClipContext = /\b(?:original video|original clip|clip|video|repost|not mine|credit|credits|source|creator|compilation|full video)\b/i.test(normalized);
  const hasAddedValueCue = /\b(?:analysis|explained|breakdown|context|source-backed|source backed|research|lesson|tutorial|why this matters|commentary)\b/i.test(normalized);

  return hasGreenScreenOrReaction && hasBorrowedClipContext && !hasAddedValueCue;
}

function hasLowOriginalityRepostPattern(normalized: string): boolean {
  const hasRepostCue = /\b(?:repost|re-upload|reupload|not mine|credit unknown|credits unknown|source unknown|stolen clip|stolen clips|borrowed clip|borrowed clips|found this|compilation|clip dump|viral clips?)\b/i.test(normalized);
  const hasMinimalContributionCue = /\b(?:no commentary|without commentary|just watching|just reposting|nothing added|full clip|raw clip|original below|credit to owner|all credits|ctto)\b/i.test(normalized);
  const hasTransformativeCue = /\b(?:analysis|breakdown|critique|commentary|explained|educational|context|review|source-backed|source backed)\b/i.test(normalized);

  return (hasRepostCue && hasMinimalContributionCue && !hasTransformativeCue)
    || (hasRepostCue && /\b(?:compilation|viral clips?|clip dump|source unknown|credit unknown|credits unknown)\b/i.test(normalized));
}
