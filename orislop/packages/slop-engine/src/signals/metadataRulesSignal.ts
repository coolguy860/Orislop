import { clamp01 } from "../../../shared/src/clamp.ts";
import type { EvidenceItem, ExtractedShort, SignalResult } from "../../../shared/src/types.ts";
import { BAIT_PHRASES, FAKE_URGENCY_PHRASES } from "../rules/baitPhrases.ts";
import { CLAIM_RISK_TERMS, CONSPIRACY_FRAMING_TERMS } from "../rules/claimRiskTerms.ts";
import { SCAM_TERMS } from "../rules/scamTerms.ts";
import {
  collectLowInformationMatches,
  collectStrongSlopPatternMatches,
  hasInformationalContext,
  hasSongOrLyricsContext,
  titleHashtagSpamMatch,
  type SlopPatternMatch
} from "../rules/slopPatterns.ts";
import { LOW_INFORMATION_TERMS, TEMPLATE_TERMS } from "../rules/templateTerms.ts";

type Hit = {
  reasonId: string;
  label: string;
  detail: string;
  weight: number;
  confidence: number;
  category: string;
};

export function metadataRulesSignal(short: ExtractedShort): SignalResult {
  const started = Date.now();
  const text = metadataText(short);
  const hits: Hit[] = [];

  collectPhraseHits(text, BAIT_PHRASES, "engagement_bait", "Engagement bait", 0.62, hits);
  collectPhraseHits(text, FAKE_URGENCY_PHRASES, "engagement_bait", "Fake urgency", 0.58, hits);
  collectPhraseHits(text, TEMPLATE_TERMS, "template_brainrot", "Template format", 0.64, hits);
  collectPhraseHits(text, LOW_INFORMATION_TERMS, "low_information", "Low-information prompt", 0.5, hits);
  collectPhraseHits(text, SCAM_TERMS, "scammy", "Possible scam language", 0.8, hits);
  collectPhraseHits(text, CLAIM_RISK_TERMS, "unsupported_claims", "Unsupported claim language", 0.72, hits);
  collectPhraseHits(text, CONSPIRACY_FRAMING_TERMS, "unsupported_claims", "Conspiracy framing", 0.68, hits);
  collectSlopPatternHits(text, "metadata", hits, short);
  const titleSpam = titleHashtagSpamMatch(short.title, "metadata");
  if (titleSpam) {
    hits.push(hitFromPatternMatch(titleSpam));
  }

  if (hasHighRiskFinancePattern(text)) {
    hits.push(makeHit(
      "metadata_high_risk_finance_claim",
      "High-risk unsupported finance claim",
      "Metadata uses guaranteed-return or copy-trading language.",
      "scam_finance",
      0.84
    ));
  }

  if (hasHighRiskHealthPattern(text)) {
    hits.push(makeHit(
      "metadata_high_risk_health_claim",
      "High-risk unsupported finance/health claim",
      "Metadata uses miracle-cure or urgent health-advice wording.",
      "miracle_health_claim",
      0.84
    ));
  }

  if (/[!?]{3,}/.test(text)) {
    hits.push(makeHit("metadata_excessive_punctuation", "Excessive punctuation", "Repeated punctuation appears in metadata.", "engagement_bait", 0.46));
  }

  if (emojiCount(text) >= 3) {
    hits.push(makeHit("metadata_excessive_emoji", "Excessive emoji", "Metadata uses repeated emoji as a hook.", "engagement_bait", 0.46));
  }

  if (hasAllCapsSpam(text)) {
    hits.push(makeHit("metadata_all_caps_spam", "All-caps spam", "Metadata contains all-caps promotional wording.", "engagement_bait", 0.5));
  }

  if (/\b(ai generated|synthetic content|made with ai|altered content)\b/i.test(text) && !short.hasPlatformAiLabel) {
    hits.push(makeHit("metadata_ai_label_like_text", "AI label-like text", "Metadata suggests AI-generated or synthetic content.", "possible_unlabeled_ai", 0.66));
  }

  if (hits.length === 0) {
    return {
      name: "metadata_rules",
      score: 0,
      confidence: 0.45,
      applicable: true,
      categories: [],
      evidence: [],
      reason: "No Tier 1 metadata rules matched.",
      runtimeMs: Date.now() - started,
      error: null
    };
  }

  return {
    name: "metadata_rules",
    score: scoreHits(hits),
    confidence: confidenceHits(hits),
    applicable: true,
    categories: categoriesFromHits(hits),
    evidence: evidenceFromHits(hits, "metadata"),
    reason: "Tier 1 metadata rules matched.",
    runtimeMs: Date.now() - started,
    error: null
  };
}

function metadataText(short: ExtractedShort): string {
  return [
    short.title,
    short.description,
    short.channelName,
    short.visiblePageText,
    short.hashtags.join(" ")
  ].filter(Boolean).join(" ");
}

function collectPhraseHits(
  text: string,
  phrases: readonly string[],
  category: string,
  label: string,
  weight: number,
  hits: Hit[]
): void {
  for (const phrase of phrases) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      hits.push(makeHit(`metadata_${slug(phrase)}`, label, phrase, category, weight));
    }
  }
}

function collectSlopPatternHits(
  text: string,
  prefix: string,
  hits: Hit[],
  short: ExtractedShort
): void {
  const songContext = short.audioIsSong === true || hasSongOrLyricsContext(text);
  const informationalContext = hasInformationalContext(text);
  const repetitionMatches = songContext
    ? []
    : collectLowInformationMatches(text, prefix, {
      category: informationalContext ? "low_information" : "repetitive_format",
      label: informationalContext
        ? "Low-information informational format"
        : "Repetitive low-originality format"
    });

  for (const match of [
    ...collectStrongSlopPatternMatches(text, prefix),
    ...repetitionMatches
  ]) {
    if (short.hasPlatformAiLabel && match.category === "possible_unlabeled_ai") {
      continue;
    }

    hits.push(hitFromPatternMatch(match));
  }
}

function hitFromPatternMatch(match: SlopPatternMatch): Hit {
  return {
    reasonId: match.reasonId,
    label: match.label,
    detail: match.detail,
    weight: match.weight,
    confidence: match.confidence,
    category: match.category
  };
}

function makeHit(reasonId: string, label: string, detail: string, category: string, weight: number): Hit {
  return {
    reasonId,
    label,
    detail,
    weight,
    confidence: clamp01(weight + 0.1),
    category
  };
}

function scoreHits(hits: Hit[]): number {
  const max = Math.max(...hits.map((hit) => hit.weight));
  return clamp01(max + Math.max(0, hits.length - 1) * 0.05);
}

function confidenceHits(hits: Hit[]): number {
  return clamp01(hits.reduce((sum, hit) => sum + hit.confidence, 0) / hits.length);
}

function categoriesFromHits(hits: Hit[]): string[] {
  return Array.from(new Set(hits.map((hit) => hit.category)));
}

function evidenceFromHits(hits: Hit[], source: string): EvidenceItem[] {
  return hits.map((hit) => ({
    reasonId: hit.reasonId,
    label: hit.label,
    detail: hit.detail,
    weight: hit.weight,
    confidence: hit.confidence,
    source,
    category: hit.category
  }));
}

function emojiCount(text: string): number {
  return Array.from(text).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
}

function hasAllCapsSpam(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => /^[A-Z]{4,}$/.test(word));
  return words.length >= 3;
}

function hasHighRiskFinancePattern(text: string): boolean {
  return /\b(?:guaranteed|risk[-\s]?free|100%\s+win|copy\s+my\s+trades|signals?|telegram|whatsapp|dm\s+me)\b/i.test(text)
    && /\b(?:crypto|forex|stock|trading|profit|returns?|passive\s+income|course|mentorship)\b/i.test(text);
}

function hasHighRiskHealthPattern(text: string): boolean {
  return /\b(?:miracle|cure|detox|doctors?\s+hate|never\s+eat|big\s+pharma|weight\s+loss|supplement)\b/i.test(text)
    && /\b(?:health|doctor|disease|cancer|diabetes|fat|body|symptom|eat|cures?)\b/i.test(text);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
