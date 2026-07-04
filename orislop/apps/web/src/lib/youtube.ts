export type ParsedYouTubeUrl = {
  input: string;
  isYouTubeUrl: boolean;
  videoId: string | null;
  videoKind: "short" | "watch" | "unknown";
  normalizedUrl: string | null;
  embedUrl: string | null;
};

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be"
]);

export function parseYouTubeUrl(input: string): ParsedYouTubeUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    return emptyResult(input);
  }

  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    const isYouTubeUrl = YOUTUBE_HOSTS.has(host);
    if (!isYouTubeUrl) {
      return emptyResult(input);
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    const shortsId = pathParts[0] === "shorts" && pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
    const watchId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
    const shortLinkId = host === "youtu.be" && pathParts[0] ? decodeURIComponent(pathParts[0]) : null;
    const videoId = sanitizeVideoId(shortsId ?? watchId ?? shortLinkId);
    const videoKind = shortsId ? "short" : videoId ? "watch" : "unknown";

    return {
      input,
      isYouTubeUrl: true,
      videoId,
      videoKind,
      normalizedUrl: videoId
        ? videoKind === "short"
          ? `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`
          : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
        : null,
      embedUrl: videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` : null
    };
  } catch {
    return emptyResult(input);
  }
}

function sanitizeVideoId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const clean = value.trim();
  return /^[a-zA-Z0-9_-]{3,128}$/.test(clean) ? clean : null;
}

function emptyResult(input: string): ParsedYouTubeUrl {
  return {
    input,
    isYouTubeUrl: false,
    videoId: null,
    videoKind: "unknown",
    normalizedUrl: null,
    embedUrl: null
  };
}
