export type YouTubeShortsUrlInfo = {
  input: string;
  isYouTubeUrl: boolean;
  isShortsUrl: boolean;
  isWatchUrl: boolean;
  normalizedUrl: string | null;
  videoId: string | null;
  videoKind: "short" | "watch" | "unknown";
};

export const YOUTUBE_SHORTS_HOME_URL = "https://www.youtube.com/shorts";
export const YOUTUBE_HOME_URL = "https://www.youtube.com";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be"
]);

export function parseYouTubeShortsUrl(input: string): YouTubeShortsUrlInfo {
  const trimmed = input.trim();
  if (!trimmed) {
    return emptyUrlInfo(input);
  }

  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    const isYouTubeUrl = YOUTUBE_HOSTS.has(host);
    const shortsVideoId = isYouTubeUrl ? extractShortsVideoIdFromPath(parsed.pathname) : null;
    const watchVideoId = isYouTubeUrl ? extractWatchVideoId(parsed) : null;
    const youtuBeVideoId = host === "youtu.be" ? extractYoutuBeVideoId(parsed.pathname) : null;
    const videoId = shortsVideoId ?? watchVideoId ?? youtuBeVideoId;
    const isShortsHome = isYouTubeUrl && parsed.pathname === "/shorts";
    const isShortsUrl = isShortsHome || Boolean(shortsVideoId);
    const isWatchUrl = Boolean(watchVideoId || youtuBeVideoId);
    const videoKind = isShortsUrl ? "short" : isWatchUrl ? "watch" : "unknown";

    return {
      input,
      isYouTubeUrl,
      isShortsUrl,
      isWatchUrl,
      normalizedUrl: isShortsUrl
        ? normalizeShortsUrl(videoId)
        : isWatchUrl && videoId
          ? normalizeWatchUrl(videoId)
          : null,
      videoId,
      videoKind
    };
  } catch {
    return emptyUrlInfo(input);
  }
}

export function normalizeShortsUrl(videoId: string | null): string {
  return videoId ? `${YOUTUBE_SHORTS_HOME_URL}/${encodeURIComponent(videoId)}` : YOUTUBE_SHORTS_HOME_URL;
}

export function normalizeWatchUrl(videoId: string): string {
  return `${YOUTUBE_HOME_URL}/watch?v=${encodeURIComponent(videoId)}`;
}

export function isYouTubeShortsUrl(input: string): boolean {
  return parseYouTubeShortsUrl(input).isShortsUrl;
}

export function isSupportedYouTubeVideoUrl(input: string): boolean {
  const parsed = parseYouTubeShortsUrl(input);
  return parsed.isShortsUrl || parsed.isWatchUrl;
}

export function extractShortsVideoId(input: string): string | null {
  return parseYouTubeShortsUrl(input).videoId;
}

function extractShortsVideoIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "shorts") {
    return null;
  }

  return parts[1] ? decodeURIComponent(parts[1]) : null;
}

function extractWatchVideoId(url: URL): string | null {
  if (url.pathname !== "/watch") {
    return null;
  }

  const videoId = url.searchParams.get("v");
  return videoId ? decodeURIComponent(videoId) : null;
}

function extractYoutuBeVideoId(pathname: string): string | null {
  const [videoId] = pathname.split("/").filter(Boolean);
  return videoId ? decodeURIComponent(videoId) : null;
}

function emptyUrlInfo(input: string): YouTubeShortsUrlInfo {
  return {
    input,
    isYouTubeUrl: false,
    isShortsUrl: false,
    isWatchUrl: false,
    normalizedUrl: null,
    videoId: null,
    videoKind: "unknown"
  };
}
