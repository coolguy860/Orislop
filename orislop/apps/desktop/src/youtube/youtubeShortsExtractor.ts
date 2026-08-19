import type {
  CommunityKeywordCategory,
  CommunityReactionSummary,
  ExtractedShort
} from "../../../../packages/shared/src/types.ts";
import { extractShortsVideoId, parseYouTubeShortsUrl } from "./youtubeUrl.ts";

export type YouTubeShortsExtractionSnapshot = {
  url: string;
  titleCandidates?: Array<string | null | undefined>;
  channelCandidates?: Array<{
    name: string | null;
    url: string | null;
  }>;
  descriptionCandidates?: Array<string | null | undefined>;
  visibleText?: string | null;
  aiDisclosureCandidates?: Array<string | null | undefined>;
  transcriptCandidates?: Array<string | null | undefined>;
  audioCandidates?: Array<string | null | undefined>;
  videoDurationSec?: number | null;
  playbackCurrentTimeSec?: number | null;
  playbackPaused?: boolean | null;
  playbackReadyState?: number | null;
  playerStateText?: string | null;
  commentCandidates?: Array<string | null | undefined>;
};

export type YouTubeShortsExtractorOptions = {
  includeCommunityReaction?: boolean;
  maxVisibleCommentsToInspect?: number;
  sampledAt?: string | null;
};

const COMMUNITY_KEYWORDS: Record<CommunityKeywordCategory, readonly string[]> = {
  slop: [
    "slop",
    "brainrot",
    "ai slop",
    "content farm",
    "low effort",
    "npc",
    "engagement bait"
  ],
  fake_repost: [
    "fake",
    "staged",
    "stolen",
    "repost",
    "bot",
    "copied"
  ],
  ai: [
    "ai",
    "generated",
    "sora",
    "fake voice",
    "ai voice",
    "deepfake"
  ],
  scam_claim_risk: [
    "scam",
    "fake guru",
    "misinformation",
    "cap",
    "source?",
    "proof?"
  ]
};

export function extractShortFromSnapshot(
  snapshot: YouTubeShortsExtractionSnapshot,
  options: YouTubeShortsExtractorOptions = {}
): ExtractedShort {
  const title = firstText(snapshot.titleCandidates ?? []);
  const description = firstText(snapshot.descriptionCandidates ?? []);
  const visiblePageText = normalizeWhitespace(snapshot.visibleText ?? "");
  const channel = firstChannel(snapshot.channelCandidates ?? []);
  const transcript = firstText(snapshot.transcriptCandidates ?? []);
  const audioTrackTitle = firstText(snapshot.audioCandidates ?? []);
  const playerStateText = firstText([snapshot.playerStateText]);
  const joinedText = [title, description, visiblePageText].filter(Boolean).join(" ");
  const disclosureText = findAiDisclosure(firstText(snapshot.aiDisclosureCandidates ?? []) ?? "");
  const adNoticeText = findAdNotice(joinedText);
  const parsed = parseYouTubeShortsUrl(snapshot.url);
  const communityReactionSummary = summarizeVisibleCommunityReactions(
    snapshot.commentCandidates ?? [],
    options
  );

  return {
    platform: "youtube",
    videoKind: parsed.videoKind,
    url: snapshot.url,
    videoId: extractShortsVideoId(snapshot.url),
    title,
    channelName: channel.name,
    channelUrl: channel.url,
    description,
    hashtags: extractHashtags([title, description, visiblePageText].filter(Boolean).join(" ")),
    visiblePageText,
    hasPlatformAiLabel: disclosureText !== null,
    platformAiLabelText: disclosureText,
    transcript,
    audioTrackTitle,
    audioIsSong: isSongOrAudioText(audioTrackTitle),
    videoDurationSec: finiteNumberOrNull(snapshot.videoDurationSec),
    playbackCurrentTimeSec: finiteNumberOrNull(snapshot.playbackCurrentTimeSec),
    playbackPaused: typeof snapshot.playbackPaused === "boolean" ? snapshot.playbackPaused : null,
    playbackReadyState: finiteNumberOrNull(snapshot.playbackReadyState),
    playerStateText,
    isLikelyAd: adNoticeText !== null,
    adNoticeText,
    communityReactionSummary
  };
}

export function getYouTubeShortsExtractorScript(options: YouTubeShortsExtractorOptions = {}): string {
  const safeOptions = {
    includeCommunityReaction: options.includeCommunityReaction === true,
    maxVisibleCommentsToInspect: clampCommentLimit(options.maxVisibleCommentsToInspect),
    sampledAt: typeof options.sampledAt === "string" ? options.sampledAt : null
  };
  return `(${browserExtractCurrentShort.toString()})(${JSON.stringify(safeOptions)});`;
}

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  return Array.from(new Set(matches.map((tag) => tag.slice(1).toLowerCase())));
}

export function findAiDisclosure(text: string): string | null {
  const match = text.match(/(?:altered or synthetic content|includes? altered or synthetic content|created or altered with ai|generated or altered with ai|how this content was made)/i);
  return match ? match[0] : null;
}

export function findAdNotice(text: string): string | null {
  const match = text.match(/(?:sponsored|paid promotion|includes paid promotion|promoted|visit advertiser|why this ad|skip ad|ad\s+\d+\s+of\s+\d+)/i);
  return match ? match[0] : null;
}

export function summarizeVisibleCommunityReactions(
  comments: Array<string | null | undefined>,
  options: YouTubeShortsExtractorOptions = {}
): CommunityReactionSummary {
  if (options.includeCommunityReaction !== true) {
    return emptyCommunitySummary("disabled", options.sampledAt ?? null);
  }

  const limit = clampCommentLimit(options.maxVisibleCommentsToInspect);
  const visibleComments = comments
    .map((comment) => normalizeWhitespace(comment ?? ""))
    .filter((comment) => comment.length > 0)
    .slice(0, limit);

  if (visibleComments.length === 0) {
    return emptyCommunitySummary("unavailable", options.sampledAt ?? null);
  }

  const matchCounts: Record<CommunityKeywordCategory, number> = {
    slop: 0,
    fake_repost: 0,
    ai: 0,
    scam_claim_risk: 0
  };

  for (const comment of visibleComments) {
    const lower = comment.toLowerCase();
    for (const [category, keywords] of Object.entries(COMMUNITY_KEYWORDS) as Array<[CommunityKeywordCategory, readonly string[]]>) {
      if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
        matchCounts[category] += 1;
      }
    }
  }

  const matchedCategories = (Object.keys(matchCounts) as CommunityKeywordCategory[])
    .filter((category) => matchCounts[category] > 0);
  const totalMatches = Object.values(matchCounts).reduce((sum, count) => sum + count, 0);
  const ratio = totalMatches / visibleComments.length;

  return {
    status: "available",
    inspectedCount: visibleComments.length,
    matchCounts,
    matchedCategories,
    strength: communityStrength(ratio, totalMatches),
    usedRawComments: false,
    sampledAt: options.sampledAt ?? null
  };
}

function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeWhitespace(value ?? "");
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function firstChannel(channels: NonNullable<YouTubeShortsExtractionSnapshot["channelCandidates"]>[number][]): {
  name: string | null;
  url: string | null;
} {
  for (const channel of channels) {
    const name = normalizeWhitespace(channel.name ?? "");
    const url = normalizeWhitespace(channel.url ?? "");
    if (name || url) {
      return {
        name: name || null,
        url: url || null
      };
    }
  }

  return {
    name: null,
    url: null
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function browserExtractCurrentShort(options: YouTubeShortsExtractorOptions = {}): ExtractedShort {
  try {
    const url = window.location.href;
    const titleCandidates = [
      textFromSelector("h1"),
      textFromSelector("h1 yt-formatted-string"),
      textFromSelector("#title"),
      textFromSelector("[id='title']"),
      textFromSelector("ytd-watch-metadata h1"),
      document.querySelector("meta[name='title']")?.getAttribute("content"),
      document.title?.replace(/ - YouTube$/i, "")
    ];
    const descriptionCandidates = [
      textFromSelector("#description"),
      textFromSelector("ytd-expander"),
      textFromSelector("ytd-text-inline-expander"),
      textFromSelector("yt-formatted-string.content"),
      document.querySelector("meta[name='description']")?.getAttribute("content")
    ];
    const channelElement = document.querySelector<HTMLAnchorElement>(
      "ytd-channel-name a[href], #channel-name a[href], a[href^='/@'], a[href*='youtube.com/@']"
    );
    const visibleText = visibleTextWithoutComments();
    const aiDisclosureCandidates = platformAiDisclosureTexts();
    const audioCandidates = [
      textFromSelector("a[href*='/watch?v='][aria-label*='song' i]"),
      textFromSelector("a[href*='/watch?v='][title*='song' i]"),
      textFromSelector("yt-formatted-string[title*='Original audio' i]"),
      textFromSelector("[aria-label*='Original audio' i]"),
      textFromSelector("[aria-label*='song' i]")
    ];
    const video = document.querySelector<HTMLVideoElement>("video");
    const playerStateText = [
      video ? `video ${video.paused ? "paused" : "playing"}` : null,
      textFromSelector(".ytp-time-current"),
      textFromSelector(".ytp-time-duration"),
      textFromSelector(".ytp-play-button"),
      textFromSelector(".ytp-ad-player-overlay")
    ].filter(Boolean).join(" ");
    const commentCandidates = options.includeCommunityReaction
      ? visibleCommentTexts(options.maxVisibleCommentsToInspect)
      : [];
    const snapshot = {
      url,
      titleCandidates,
      descriptionCandidates,
      channelCandidates: [{
        name: channelElement?.textContent ?? null,
        url: channelElement?.href ?? null
      }],
      visibleText,
      aiDisclosureCandidates,
      transcriptCandidates: [],
      audioCandidates,
      videoDurationSec: video ? finitePlainNumber(video.duration) : null,
      playbackCurrentTimeSec: video ? finitePlainNumber(video.currentTime) : null,
      playbackPaused: video ? video.paused : null,
      playbackReadyState: video ? video.readyState : null,
      playerStateText,
      commentCandidates
    };

    return extractFromPlainSnapshot(snapshot, options);
  } catch {
    return {
      url: window.location.href,
      videoId: plainVideoIdFromUrl(window.location.href),
      platform: "youtube",
      videoKind: plainVideoKindFromUrl(window.location.href),
      title: null,
      channelName: null,
      channelUrl: null,
      description: null,
      hashtags: [],
      visiblePageText: "",
      hasPlatformAiLabel: false,
      platformAiLabelText: null,
      transcript: null,
      audioTrackTitle: null,
      audioIsSong: false,
      videoDurationSec: null,
      playbackCurrentTimeSec: null,
      playbackPaused: null,
      playbackReadyState: null,
      playerStateText: null,
      isLikelyAd: false,
      adNoticeText: null,
      communityReactionSummary: plainEmptyCommunitySummary(
        options.includeCommunityReaction ? "unavailable" : "disabled",
        options.sampledAt ?? null
      )
    };
  }

  function textFromSelector(selector: string): string | null {
    return document.querySelector(selector)?.textContent ?? null;
  }

  function visibleTextWithoutComments(): string {
    const root = document.querySelector(
      "ytd-reel-video-renderer[is-active], ytd-reel-video-renderer[is-active='true'], ytd-watch-flexy, ytd-shorts, #shorts-container"
    ) ?? document.body;
    const clone = root?.cloneNode(true) as HTMLElement | null;
    if (!clone) {
      return "";
    }

    clone.querySelectorAll("ytd-comments, #comments, [id*='comment'], [class*='comment']").forEach((node) => node.remove());
    return normalizePlain(clone.innerText || clone.textContent || "").slice(0, 12000);
  }

  function platformAiDisclosureTexts(): string[] {
    const selectors = [
      "[aria-label*='altered or synthetic content' i]",
      "[title*='altered or synthetic content' i]",
      "[aria-label*='how this content was made' i]",
      "ytd-info-panel-content-renderer",
      "yt-factoid-renderer"
    ];
    const values: string[] = [];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const value = [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.innerText,
          node.textContent
        ].map((item) => normalizePlain(item ?? "")).find((item) => plainAiDisclosure(item));
        if (value && !values.includes(value)) {
          values.push(value);
        }
      }
    }
    return values;
  }

  function visibleCommentTexts(limitInput?: number): string[] {
    const limit = plainClampCommentLimit(limitInput);
    const selectors = [
      "ytd-comment-thread-renderer #content-text",
      "ytd-comment-view-model #content-text",
      "#comments #content-text",
      "[id='comments'] yt-attributed-string",
      "[aria-label*='Comment']"
    ];
    const seen = new Set<string>();
    const comments: string[] = [];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const text = normalizePlain((node as HTMLElement).innerText || node.textContent || "");
        if (!text || seen.has(text)) {
          continue;
        }

        seen.add(text);
        comments.push(text);
        if (comments.length >= limit) {
          return comments;
        }
      }
    }

    return comments;
  }

  function extractFromPlainSnapshot(snapshot: {
    url: string;
    titleCandidates: Array<string | null | undefined>;
    channelCandidates: Array<{ name: string | null | undefined; url: string | null | undefined }>;
    descriptionCandidates: Array<string | null | undefined>;
    visibleText: string | null;
    aiDisclosureCandidates: Array<string | null | undefined>;
    transcriptCandidates: Array<string | null | undefined>;
    audioCandidates: Array<string | null | undefined>;
    videoDurationSec: number | null;
    playbackCurrentTimeSec: number | null;
    playbackPaused: boolean | null;
    playbackReadyState: number | null;
    playerStateText: string | null;
    commentCandidates: Array<string | null | undefined>;
  }, plainOptions: YouTubeShortsExtractorOptions): ExtractedShort {
    const title = firstPlainText(snapshot.titleCandidates);
    const description = firstPlainText(snapshot.descriptionCandidates);
    const visiblePageText = normalizePlain(snapshot.visibleText ?? "");
    const channel = firstPlainChannel(snapshot.channelCandidates);
    const audioTrackTitle = firstPlainText(snapshot.audioCandidates);
    const playerStateText = firstPlainText([snapshot.playerStateText]);
    const joined = [title, description, visiblePageText].filter(Boolean).join(" ");
    const disclosure = plainAiDisclosure(firstPlainText(snapshot.aiDisclosureCandidates) ?? "");
    const adNoticeText = plainAdNotice(joined);
    const communityReactionSummary = plainSummarizeVisibleCommunityReactions(
      snapshot.commentCandidates,
      plainOptions
    );

    return {
      platform: "youtube",
      videoKind: plainVideoKindFromUrl(snapshot.url),
      url: snapshot.url,
      videoId: plainVideoIdFromUrl(snapshot.url),
      title,
      channelName: channel.name,
      channelUrl: channel.url,
      description,
      hashtags: plainHashtags(joined),
      visiblePageText,
      hasPlatformAiLabel: disclosure !== null,
      platformAiLabelText: disclosure,
      transcript: firstPlainText(snapshot.transcriptCandidates),
      audioTrackTitle,
      audioIsSong: plainIsSongOrAudioText(audioTrackTitle),
      videoDurationSec: snapshot.videoDurationSec,
      playbackCurrentTimeSec: snapshot.playbackCurrentTimeSec,
      playbackPaused: snapshot.playbackPaused,
      playbackReadyState: snapshot.playbackReadyState,
      playerStateText,
      isLikelyAd: adNoticeText !== null,
      adNoticeText,
      communityReactionSummary
    };
  }

  function firstPlainText(values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const normalized = normalizePlain(value ?? "");
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function firstPlainChannel(channels: Array<{ name: string | null | undefined; url: string | null | undefined }>): {
    name: string | null;
    url: string | null;
  } {
    for (const channel of channels) {
      const name = normalizePlain(channel.name ?? "");
      const channelUrl = normalizePlain(channel.url ?? "");
      if (name || channelUrl) {
        return {
          name: name || null,
          url: channelUrl || null
        };
      }
    }

    return {
      name: null,
      url: null
    };
  }

  function plainVideoIdFromUrl(value: string): string | null {
    try {
      const urlValue = new URL(value);
      const parts = urlValue.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" && parts[1]) {
        return decodeURIComponent(parts[1]);
      }
      if (urlValue.pathname === "/watch") {
        return urlValue.searchParams.get("v");
      }
      if (urlValue.hostname.toLowerCase() === "youtu.be" && parts[0]) {
        return decodeURIComponent(parts[0]);
      }
      return null;
    } catch {
      return null;
    }
  }

  function plainVideoKindFromUrl(value: string): ExtractedShort["videoKind"] {
    try {
      const urlValue = new URL(value);
      if (urlValue.pathname.startsWith("/shorts")) {
        return "short";
      }
      if (urlValue.pathname === "/watch" || urlValue.hostname.toLowerCase() === "youtu.be") {
        return "watch";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  function plainHashtags(value: string): string[] {
    const matches = value.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
    return Array.from(new Set(matches.map((tag) => tag.slice(1).toLowerCase())));
  }

  function plainAiDisclosure(value: string): string | null {
    const match = value.match(/(?:altered or synthetic content|includes? altered or synthetic content|created or altered with ai|generated or altered with ai|how this content was made)/i);
    return match ? match[0] : null;
  }

  function plainAdNotice(value: string): string | null {
    const match = value.match(/(?:sponsored|paid promotion|includes paid promotion|promoted|visit advertiser|why this ad|skip ad|ad\s+\d+\s+of\s+\d+)/i);
    return match ? match[0] : null;
  }

  function normalizePlain(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function finitePlainNumber(value: number): number | null {
    return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
  }

  function plainIsSongOrAudioText(value: string | null): boolean {
    return value !== null && /\b(song|music|audio|lyrics|remix|cover|sound|original audio)\b/i.test(value);
  }

  function plainSummarizeVisibleCommunityReactions(
    comments: Array<string | null | undefined>,
    plainOptions: YouTubeShortsExtractorOptions
  ): CommunityReactionSummary {
    if (plainOptions.includeCommunityReaction !== true) {
      return plainEmptyCommunitySummary("disabled", plainOptions.sampledAt ?? null);
    }

    const limit = plainClampCommentLimit(plainOptions.maxVisibleCommentsToInspect);
    const visibleComments = comments
      .map((comment) => normalizePlain(comment ?? ""))
      .filter((comment) => comment.length > 0)
      .slice(0, limit);

    if (visibleComments.length === 0) {
      return plainEmptyCommunitySummary("unavailable", plainOptions.sampledAt ?? null);
    }

    const matchCounts: Record<CommunityKeywordCategory, number> = {
      slop: 0,
      fake_repost: 0,
      ai: 0,
      scam_claim_risk: 0
    };
    const keywords: Record<CommunityKeywordCategory, readonly string[]> = {
      slop: ["slop", "brainrot", "ai slop", "content farm", "low effort", "npc", "engagement bait"],
      fake_repost: ["fake", "staged", "stolen", "repost", "bot", "copied"],
      ai: ["ai", "generated", "sora", "fake voice", "ai voice", "deepfake"],
      scam_claim_risk: ["scam", "fake guru", "misinformation", "cap", "source?", "proof?"]
    };

    for (const comment of visibleComments) {
      const lower = comment.toLowerCase();
      for (const category of Object.keys(keywords) as CommunityKeywordCategory[]) {
        if (keywords[category].some((keyword) => lower.includes(keyword.toLowerCase()))) {
          matchCounts[category] += 1;
        }
      }
    }

    const matchedCategories = (Object.keys(matchCounts) as CommunityKeywordCategory[])
      .filter((category) => matchCounts[category] > 0);
    const totalMatches = Object.values(matchCounts).reduce((sum, count) => sum + count, 0);
    const ratio = totalMatches / visibleComments.length;

    return {
      status: "available",
      inspectedCount: visibleComments.length,
      matchCounts,
      matchedCategories,
      strength: plainCommunityStrength(ratio, totalMatches),
      usedRawComments: false,
      sampledAt: plainOptions.sampledAt ?? null
    };
  }

  function plainEmptyCommunitySummary(
    status: CommunityReactionSummary["status"],
    sampledAt: string | null
  ): CommunityReactionSummary {
    return {
      status,
      inspectedCount: 0,
      matchCounts: {
        slop: 0,
        fake_repost: 0,
        ai: 0,
        scam_claim_risk: 0
      },
      matchedCategories: [],
      strength: "none",
      usedRawComments: false,
      sampledAt
    };
  }

  function plainCommunityStrength(ratio: number, totalMatches: number): CommunityReactionSummary["strength"] {
    if (totalMatches >= 8 || ratio >= 0.45) {
      return "strong";
    }

    if (totalMatches >= 4 || ratio >= 0.25) {
      return "medium";
    }

    if (totalMatches >= 1 || ratio > 0) {
      return "weak";
    }

    return "none";
  }

  function plainClampCommentLimit(value: number | undefined): number {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : 24;
    return Math.max(0, Math.min(50, Math.round(numeric)));
  }
}

function emptyCommunitySummary(
  status: CommunityReactionSummary["status"],
  sampledAt: string | null
): CommunityReactionSummary {
  return {
    status,
    inspectedCount: 0,
    matchCounts: {
      slop: 0,
      fake_repost: 0,
      ai: 0,
      scam_claim_risk: 0
    },
    matchedCategories: [],
    strength: "none",
    usedRawComments: false,
    sampledAt
  };
}

function communityStrength(ratio: number, totalMatches: number): CommunityReactionSummary["strength"] {
  if (totalMatches >= 8 || ratio >= 0.45) {
    return "strong";
  }

  if (totalMatches >= 4 || ratio >= 0.25) {
    return "medium";
  }

  if (totalMatches >= 1 || ratio > 0) {
    return "weak";
  }

  return "none";
}

function clampCommentLimit(value: number | undefined): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 24;
  return Math.max(0, Math.min(50, Math.round(numeric)));
}

function isSongOrAudioText(value: string | null): boolean {
  return value !== null && /\b(song|music|audio|lyrics|remix|cover|sound|original audio)\b/i.test(value);
}
