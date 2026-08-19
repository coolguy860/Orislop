import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";
import {
  extractHashtags,
  findAiDisclosure
} from "./youtubeShortsExtractor.ts";
import {
  extractShortsVideoId,
  normalizeShortsUrl,
  normalizeWatchUrl,
  parseYouTubeShortsUrl
} from "./youtubeUrl.ts";
import type {
  LookaheadContainerSnapshot,
  LookaheadPosition,
  LookaheadScanOptions,
  LookaheadShortCandidate
} from "./lookaheadTypes.ts";

export function scanLookaheadFromSnapshots(
  snapshots: LookaheadContainerSnapshot[],
  options: LookaheadScanOptions
): LookaheadShortCandidate[] {
  if (options.limit <= 0 || snapshots.length === 0) {
    return [];
  }

  const currentVideoId = options.currentUrl ? extractShortsVideoId(options.currentUrl) : null;
  const candidates = snapshots
    .map((snapshot, index) => candidateFromSnapshot(snapshot, index, currentVideoId))
    .filter((candidate): candidate is LookaheadShortCandidate => candidate !== null);

  return limitLookaheadCandidates(dedupeLookaheadCandidates(candidates), options.limit);
}

export function candidateToExtractedShort(candidate: LookaheadShortCandidate): ExtractedShort {
  const text = [candidate.title, candidate.visiblePageText].filter(Boolean).join(" ");
  const disclosure = findAiDisclosure(candidate.platformAiLabelText ?? "");
  const parsed = parseYouTubeShortsUrl(candidate.url ?? "");

  return {
    platform: "youtube",
    videoKind: parsed.videoKind,
    url: candidate.url ?? candidateUrlFallback(candidate),
    videoId: candidate.videoId ?? parsed.videoId,
    title: candidate.title,
    channelName: candidate.channelName,
    channelUrl: candidate.channelUrl,
    description: null,
    hashtags: extractHashtags(text),
    visiblePageText: candidate.visiblePageText,
    hasPlatformAiLabel: disclosure !== null,
    platformAiLabelText: disclosure,
    transcript: null,
    audioTrackTitle: null,
    audioIsSong: false,
    isLikelyAd: false,
    adNoticeText: null
  };
}

export function dedupeLookaheadCandidates(
  candidates: LookaheadShortCandidate[]
): LookaheadShortCandidate[] {
  const seen = new Set<string>();
  const deduped: LookaheadShortCandidate[] = [];

  for (const candidate of candidates) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

export function limitLookaheadCandidates(
  candidates: LookaheadShortCandidate[],
  lookaheadCount: number
): LookaheadShortCandidate[] {
  return candidates.slice(0, Math.max(0, Math.floor(lookaheadCount)));
}

export function getYouTubeLookaheadScannerScript(limit: number): string {
  const safeLimit = Math.max(0, Math.min(10, Math.floor(limit)));
  return `(${browserScanLookahead.toString()})(${safeLimit});`;
}

export function getYouTubeRecommendationFilterScript(videoIds: string[]): string {
  const safeIds = Array.from(new Set(videoIds
    .filter((videoId) => /^[a-zA-Z0-9_-]{3,128}$/.test(videoId))
    .slice(0, 20)));
  return `(${browserFilterFlaggedRecommendations.toString()})(${JSON.stringify(safeIds)});`;
}

function candidateFromSnapshot(
  snapshot: LookaheadContainerSnapshot,
  index: number,
  currentVideoId: string | null
): LookaheadShortCandidate | null {
  const url = normalizeNullable(snapshot.url);
  const parsedUrl = url ? parseYouTubeShortsUrl(url) : null;
  const videoId = normalizeNullable(snapshot.videoId) ?? parsedUrl?.videoId ?? (url ? extractShortsVideoId(url) : null);
  const visiblePageText = normalizeWhitespace(snapshot.visiblePageText ?? "");
  const title = normalizeNullable(snapshot.title);
  const platformAiLabelText = findAiDisclosure(normalizeWhitespace(snapshot.platformAiLabelText ?? ""));

  if (!url && !videoId && !title && !visiblePageText) {
    return null;
  }

  const position = snapshot.position
    ?? inferPosition(snapshot, index, videoId, currentVideoId);
  const normalizedUrl = url ?? (videoId ? normalizeShortsUrl(videoId) : null);

  return {
    extractionId: extractionIdFor({
      url: normalizedUrl,
      videoId,
      title,
      visiblePageText
    }, index),
    url: normalizedUrl,
    videoId,
    title,
    channelName: normalizeNullable(snapshot.channelName),
    channelUrl: normalizeNullable(snapshot.channelUrl),
    visiblePageText,
    platformAiLabelText,
    position,
    confidence: confidenceForCandidate({
      url: normalizedUrl,
      videoId,
      title,
      channelName: snapshot.channelName,
      visiblePageText,
      position
    })
  };
}

function inferPosition(
  snapshot: LookaheadContainerSnapshot,
  index: number,
  videoId: string | null,
  currentVideoId: string | null
): LookaheadShortCandidate["position"] {
  if (snapshot.isActive || (videoId && videoId === currentVideoId)) {
    return "current";
  }

  if (index === 1) {
    return "next";
  }

  return index > 1 ? "nearby" : "unknown";
}

function extractionIdFor(
  input: Pick<LookaheadShortCandidate, "url" | "videoId" | "title" | "visiblePageText">,
  index: number
): string {
  if (input.videoId) {
    return `video:${input.videoId}`;
  }

  if (input.url) {
    return `url:${input.url}`;
  }

  return `text:${smallHash(`${input.title ?? ""}:${input.visiblePageText}`)}:${index}`;
}

function confidenceForCandidate(input: {
  url: string | null;
  videoId: string | null;
  title: string | null;
  channelName: string | null | undefined;
  visiblePageText: string;
  position: LookaheadShortCandidate["position"];
}): number {
  let score = 0.2;
  if (input.url) score += 0.2;
  if (input.videoId) score += 0.3;
  if (input.title) score += 0.15;
  if (input.channelName) score += 0.05;
  if (input.visiblePageText) score += 0.05;
  if (input.position === "current" || input.position === "next") score += 0.05;
  return Math.min(1, Number(score.toFixed(2)));
}

function dedupeKey(candidate: LookaheadShortCandidate): string {
  return candidate.videoId
    ? `video:${candidate.videoId}`
    : candidate.url
      ? `url:${candidate.url}`
      : candidate.extractionId;
}

function candidateUrlFallback(candidate: LookaheadShortCandidate): string {
  if (!candidate.videoId) {
    return `orislop://lookahead/${encodeURIComponent(candidate.extractionId)}`;
  }

  return candidate.url && parseYouTubeShortsUrl(candidate.url).isWatchUrl
    ? normalizeWatchUrl(candidate.videoId)
    : normalizeShortsUrl(candidate.videoId);
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value ?? "");
  return normalized || null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function smallHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function browserScanLookahead(limit: number): LookaheadShortCandidate[] {
  try {
    if (limit <= 0) {
      return [];
    }

    const containers = Array.from(document.querySelectorAll<HTMLElement>(
      "ytd-reel-video-renderer, ytd-shorts ytd-reel-video-renderer, #shorts-container ytd-reel-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer, ytd-video-renderer, [data-orislop-short]"
    ));
    if (containers.length === 0) {
      return [];
    }

    const activeIndexRaw = containers.findIndex((node) => (
      node.hasAttribute("is-active")
      || node.getAttribute("is-active") === "true"
      || node.getAttribute("aria-current") === "true"
    ));
    const activeIndex = Math.max(0, activeIndexRaw);
    const nearby = containers
      .slice(Math.max(0, activeIndex - 1), activeIndex + limit + 3)
      .map((container, index) => containerToCandidate(container, index, activeIndex, activeIndexRaw >= 0))
      .filter((candidate): candidate is LookaheadShortCandidate => Boolean(candidate));

    return dedupePlain(nearby).slice(0, limit);
  } catch {
    return [];
  }

  function containerToCandidate(
    container: HTMLElement,
    index: number,
    activeIndex: number,
    hasActiveContainer: boolean
  ): LookaheadShortCandidate | null {
    const anchor = container.querySelector<HTMLAnchorElement>("a[href*='/shorts/'], a[href*='/watch?v='], a[href^='https://youtu.be/']");
    const channel = container.querySelector<HTMLAnchorElement>("ytd-channel-name a[href], #channel-name a[href], a[href^='/@'], a[href*='youtube.com/@']");
    const url = anchor?.href ?? null;
    const videoId = plainVideoIdFromUrl(url);
    const title = firstText([
      container.querySelector("h1")?.textContent,
      container.querySelector("[id='title']")?.textContent,
      anchor?.getAttribute("title"),
      anchor?.textContent
    ]);
    const visiblePageText = visibleTextWithoutComments(container).slice(0, 4000);
    const platformAiLabelText = platformAiDisclosureText(container);
    const position = hasActiveContainer && (container.hasAttribute("is-active") || index === activeIndex)
      ? "current"
      : (!hasActiveContainer && index === 0) || index === activeIndex + 1
        ? "next"
        : "nearby";

    if (!url && !videoId && !title && !visiblePageText) {
      return null;
    }

    return {
      extractionId: videoId ? `video:${videoId}` : url ? `url:${url}` : `text:${plainHash(`${title ?? ""}:${visiblePageText}`)}:${index}`,
      url,
      videoId,
      title,
      channelName: normalizePlain(channel?.textContent ?? "") || null,
      channelUrl: channel?.href ?? null,
      visiblePageText,
      platformAiLabelText,
      position,
      confidence: confidence({
        url,
        videoId,
        title,
        visiblePageText,
        channelName: channel?.textContent ?? null,
        position
      })
    };
  }

  function firstText(values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const normalized = normalizePlain(value ?? "");
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function visibleTextWithoutComments(container: HTMLElement): string {
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("ytd-comments, #comments, [id*='comment'], [class*='comment']").forEach((node) => node.remove());
    return normalizePlain(clone.innerText || clone.textContent || "");
  }

  function platformAiDisclosureText(container: HTMLElement): string | null {
    const selectors = [
      "[aria-label*='altered or synthetic content' i]",
      "[title*='altered or synthetic content' i]",
      "[aria-label*='how this content was made' i]",
      "ytd-info-panel-content-renderer",
      "yt-factoid-renderer"
    ];
    for (const selector of selectors) {
      for (const node of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
        const text = normalizePlain([
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.innerText,
          node.textContent
        ].filter(Boolean).join(" "));
        const match = text.match(/(?:altered or synthetic content|includes? altered or synthetic content|created or altered with ai|generated or altered with ai|how this content was made)/i);
        if (match) {
          return match[0];
        }
      }
    }
    return null;
  }

  function plainVideoIdFromUrl(value: string | null): string | null {
    if (!value) return null;
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" && parts[1]) {
        return decodeURIComponent(parts[1]);
      }
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }
      if (url.hostname.toLowerCase() === "youtu.be" && parts[0]) {
        return decodeURIComponent(parts[0]);
      }
      return null;
    } catch {
      return null;
    }
  }

  function confidence(input: {
    url: string | null;
    videoId: string | null;
    title: string | null;
    visiblePageText: string;
    channelName: string | null;
    position: LookaheadPosition;
  }): number {
    let score = 0.2;
    if (input.url) score += 0.2;
    if (input.videoId) score += 0.3;
    if (input.title) score += 0.15;
    if (input.channelName) score += 0.05;
    if (input.visiblePageText) score += 0.05;
    if (input.position === "current" || input.position === "next") score += 0.05;
    return Math.min(1, Number(score.toFixed(2)));
  }

  function dedupePlain(candidates: LookaheadShortCandidate[]): LookaheadShortCandidate[] {
    const seen = new Set<string>();
    const deduped: LookaheadShortCandidate[] = [];
    for (const candidate of candidates) {
      const key = candidate.videoId ? `video:${candidate.videoId}` : candidate.url ? `url:${candidate.url}` : candidate.extractionId;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }

  function normalizePlain(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function plainHash(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}

function browserFilterFlaggedRecommendations(videoIds: string[]): number {
  try {
    const ids = new Set(videoIds);
    if (ids.size === 0) {
      return 0;
    }

    const containers = Array.from(document.querySelectorAll<HTMLElement>(
      "ytd-compact-video-renderer, ytd-rich-item-renderer, ytd-video-renderer"
    ));
    let hiddenCount = 0;

    for (const container of containers) {
      const anchor = container.querySelector<HTMLAnchorElement>("a[href*='/watch?v='], a[href*='/shorts/']");
      const id = plainVideoIdFromUrl(anchor?.href ?? null);
      const text = normalizePlain(container.innerText || container.textContent || "");
      if (!id || !ids.has(id) || isAdLikeRecommendation(text)) {
        continue;
      }

      container.hidden = true;
      container.setAttribute("data-orislop-filtered", "true");
      hiddenCount += 1;
    }

    return hiddenCount;
  } catch {
    return 0;
  }

  function plainVideoIdFromUrl(value: string | null): string | null {
    if (!value) return null;
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" && parts[1]) {
        return decodeURIComponent(parts[1]);
      }
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }
      return null;
    } catch {
      return null;
    }
  }

  function isAdLikeRecommendation(text: string): boolean {
    return /\b(?:sponsored|paid promotion|visit advertiser|why this ad|skip ad|ad\s+\d+\s+of\s+\d+)\b/i.test(text);
  }

  function normalizePlain(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }
}
