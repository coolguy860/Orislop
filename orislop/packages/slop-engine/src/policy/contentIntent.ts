import type { ContentIntent, ExtractedShort } from "../../../shared/src/types.ts";
import { COMEDY_SATIRE_TERMS, FICTION_TERMS } from "../rules/comedySatireTerms.ts";
import { SCAM_TERMS } from "../rules/scamTerms.ts";
import { EDUCATIONAL_TERMS, SERIOUS_CLAIM_TERMS } from "../rules/seriousClaimTerms.ts";

const INTENT_PATTERNS: Array<[ContentIntent, RegExp]> = [
  ["comedy_satire", /\b(comedy|comedian|satire|satirical|parody|skit|joke|meme|pov|when you|me after|punchline)\b/i],
  ["fiction_story", /\b(fiction|storytime|short story|roleplay|creepypasta|imagine if)\b/i],
  ["finance_advice", /\b(stock|crypto|forex|dividend|passive income|trading|investment)\b/i],
  ["health_advice", /\b(cure|detox|supplement|symptom|doctor|health|weight loss)\b/i],
  ["legal_advice", /\b(lawsuit|lawyer|attorney|legal rights|court)\b/i],
  ["political_claim", /\b(election|president|senate|congress|policy|politician)\b/i],
  ["news_current_events", /\b(breaking|news|today|current events|update)\b/i],
  ["science_claim", /\b(study|scientists|researchers|climate|physics|biology)\b/i],
  ["history_claim", /\b(history|historian|ancient|century|war)\b/i],
  ["scam_promo", /\b(guaranteed profit|guaranteed returns|limited spots|dm me|telegram|whatsapp|copy my trades|forex signals|crypto signals|make money fast|fake guru|mentorship)\b/i],
  ["serious_education", /\b(tutorial|explained|lesson|learn|education|guide)\b/i],
  ["normal_entertainment", /\b(dance|music|vlog|gameplay|reaction|challenge)\b/i]
];

export function inferContentIntent(short: ExtractedShort): ContentIntent {
  const text = [
    short.title,
    short.description,
    short.visiblePageText,
    short.transcript,
    short.hashtags.join(" ")
  ]
    .filter(Boolean)
    .join(" ");

  if (hasAny(text, COMEDY_SATIRE_TERMS)) {
    return "comedy_satire";
  }

  if (hasAny(text, FICTION_TERMS)) {
    return "fiction_story";
  }

  if (hasAny(text, SCAM_TERMS)) {
    return "scam_promo";
  }

  if (hasAny(text, SERIOUS_CLAIM_TERMS)) {
    const lower = text.toLowerCase();
    if (/\b(stock|crypto|forex|returns|trades)\b/i.test(lower)) {
      return "finance_advice";
    }
    if (/\b(cures|doctor|doctors|health|eat|detox)\b/i.test(lower)) {
      return "health_advice";
    }
    return "science_claim";
  }

  if (hasAny(text, EDUCATIONAL_TERMS)) {
    return "serious_education";
  }

  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      return intent;
    }
  }

  return "unknown";
}

export function isComedyProtectedIntent(intent: ContentIntent): boolean {
  return intent === "comedy_satire" || intent === "fiction_story" || intent === "normal_entertainment";
}

export function factualIntentScore(intent: ContentIntent): number {
  switch (intent) {
    case "health_advice":
    case "finance_advice":
    case "legal_advice":
    case "political_claim":
    case "science_claim":
    case "history_claim":
    case "news_current_events":
      return 1;
    case "serious_education":
      return 0.75;
    case "scam_promo":
      return 0.6;
    case "unknown":
      return 0.35;
    default:
      return 0;
  }
}

export function comedySatireScore(intent: ContentIntent): number {
  if (intent === "comedy_satire") {
    return 1;
  }

  if (intent === "fiction_story" || intent === "normal_entertainment") {
    return 0.75;
  }

  return 0;
}

function hasAny(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}
