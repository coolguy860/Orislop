import { extractShortsVideoId, parseYouTubeShortsUrl } from "./youtubeUrl.ts";

export type ShortsNavigationObserverOptions = {
  getCurrentUrl: () => string;
  onSettledShortChange: (event: ShortsNavigationEvent) => void | Promise<void>;
  debounceMs?: number;
};

export type ShortsNavigationEvent = {
  url: string;
  videoId: string | null;
  reason: "url_change" | "manual";
};

export type ShortsNavigationObserver = {
  notifyNavigation: (url?: string) => void;
  analyzeCurrent: () => void;
  dispose: () => void;
  lastVideoId: () => string | null;
};

export function createShortsNavigationObserver(
  options: ShortsNavigationObserverOptions
): ShortsNavigationObserver {
  const debounceMs = options.debounceMs ?? 650;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastScoredKey: string | null = null;
  let pendingUrl: string | null = null;

  function schedule(url: string, reason: "url_change" | "manual"): void {
    pendingUrl = url;
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      timeout = null;
      const settledUrl = pendingUrl ?? options.getCurrentUrl();
      const parsed = parseYouTubeShortsUrl(settledUrl);
      if (!parsed.isShortsUrl && !parsed.isWatchUrl) {
        return;
      }

      const key = parsed.videoId ?? parsed.normalizedUrl ?? settledUrl;
      if (reason !== "manual" && key === lastScoredKey) {
        return;
      }

      lastScoredKey = key;
      void options.onSettledShortChange({
        url: parsed.normalizedUrl ?? settledUrl,
        videoId: parsed.videoId,
        reason
      });
    }, debounceMs);
  }

  return {
    notifyNavigation(url = options.getCurrentUrl()): void {
      schedule(url, "url_change");
    },

    analyzeCurrent(): void {
      schedule(options.getCurrentUrl(), "manual");
    },

    dispose(): void {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = null;
    },

    lastVideoId(): string | null {
      return lastScoredKey ? extractShortsVideoId(lastScoredKey) ?? lastScoredKey : null;
    }
  };
}

export function attachShortsWebViewNavigationObserver(
  webview: EventTarget & { getURL?: () => string },
  options: Omit<ShortsNavigationObserverOptions, "getCurrentUrl">
): () => void {
  const observer = createShortsNavigationObserver({
    ...options,
    getCurrentUrl: () => webview.getURL?.() ?? ""
  });
  const handler = () => observer.notifyNavigation();
  const events = [
    "did-navigate",
    "did-navigate-in-page",
    "dom-ready",
    "page-title-updated"
  ];

  for (const eventName of events) {
    webview.addEventListener(eventName, handler);
  }

  return () => {
    observer.dispose();
    for (const eventName of events) {
      webview.removeEventListener(eventName, handler);
    }
  };
}
