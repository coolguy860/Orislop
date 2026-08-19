(() => {
  "use strict";

  const SOCIAL_UI_PATTERN = /^(?:like|likes|comment|comments|share|shares|follow|following|more|reply|replies|save|saved|send|play|pause|mute|unmute|audio|original audio|sponsored|see translation|view all comments|log in|sign up)(?:\s+\d[\d,.kmb]*)?$/i;
  const RESERVED_INSTAGRAM_PATHS = new Set(["about", "accounts", "developer", "direct", "directory", "explore", "legal", "p", "privacy", "reel", "reels", "stories", "terms", "web"]);
  const RESERVED_LINKEDIN_PATHS = new Set(["about", "advice", "business", "company", "events", "feed", "help", "hiring", "jobs", "learning", "legal", "messaging", "mynetwork", "news", "notifications", "posts", "premium", "pulse", "sales", "search"]);

  const adapters = Object.freeze({
    youtube: freezeAdapter({
      candidateSelectors: [
        "ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
        "ytd-compact-video-renderer", "ytd-playlist-panel-video-renderer",
        "ytd-reel-item-renderer", "ytd-reel-video-renderer", "yt-lockup-view-model",
        "ytm-rich-item-renderer", "ytm-video-with-context-renderer",
        "ytm-shorts-lockup-view-model", "ytd-watch-metadata"
      ],
      itemLinkSelectors: ["a[href*='/watch?v=']", "a[href*='/shorts/']"],
      titleSelectors: ["#video-title", "yt-formatted-string#video-title", "yt-shorts-video-title-view-model h2", "h1", "h2", "h3", "a[title]", "[aria-label][role='link']"],
      creatorSelectors: ["#channel-name", "ytd-channel-name", "a[href^='/@']", ".ytd-channel-name"],
      textSelectors: ["#description", "#metadata-line", "yt-formatted-string#video-title", "yt-shorts-video-title-view-model", "ytd-channel-name", "ytd-badge-supported-renderer", "[aria-label*='synthetic']", "[aria-label*='AI']"],
      transcriptSelectors: [".ytp-caption-segment", "ytd-transcript-segment-renderer .segment-text", "yt-formatted-string.ytd-transcript-segment-renderer"],
      videoSelectors: ["video"],
      nextSelectors: ["#navigation-button-down button", "button[aria-label='Next video']", "button[aria-label='Next Short']"]
    }),
    instagram: freezeAdapter({
      candidateSelectors: [
        "main article", "div[role='dialog'] article", "main [role='presentation'] article"
      ],
      itemLinkSelectors: ["a[href*='/reel/']", "a[href*='/p/']"],
      titleSelectors: ["h1", "h2", "ul li span[dir='auto']", "span[dir='auto']", "img[alt]", "video[aria-label]"],
      creatorSelectors: ["header a[href]", "a[role='link'][href]", "a[href]"],
      textSelectors: ["h1", "h2", "ul li span[dir='auto']", "span[dir='auto']", "img[alt]", "video[aria-label]"],
      transcriptSelectors: ["[aria-live='polite'] span", "[aria-live='assertive'] span", "video + div span[dir='auto']"],
      videoSelectors: ["main video", "div[role='dialog'] video"],
      nextSelectors: ["button[aria-label='Next']", "div[role='button'][aria-label='Next']"]
    }),
    tiktok: freezeAdapter({
      candidateSelectors: [
        "div[data-e2e='recommend-list-item-container']", "div[data-e2e='feed-item']",
        "div[data-e2e='browse-video']", "article[data-e2e]", "article:has(a[href*='/video/'])"
      ],
      itemLinkSelectors: ["a[href*='/video/']"],
      titleSelectors: ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']", "[data-e2e='search-card-desc']", "h1"],
      creatorSelectors: ["[data-e2e='video-author-uniqueid']", "[data-e2e='browse-username']", "a[href^='/@']"],
      textSelectors: ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']", "[data-e2e='search-card-desc']", "[data-e2e='video-music']", "[data-e2e='browse-music']", "video[aria-label]"],
      transcriptSelectors: ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']", "[data-e2e='search-card-desc']", "[class*='DivSubtitle']", "[class*='Caption']"],
      videoSelectors: ["main video", "div[role='main'] video", "video"],
      nextSelectors: ["button[data-e2e='arrow-right']", "button[aria-label='Next video']", "button[aria-label='Next']"]
    }),
    linkedin: freezeAdapter({
      candidateSelectors: [
        "main div[data-urn^='urn:li:activity:']",
        "main div[data-id^='urn:li:activity:']",
        "main article",
        "main .feed-shared-update-v2",
        "main .occludable-update"
      ],
      itemLinkSelectors: [
        "a[href*='/posts/']",
        "a[href*='/feed/update/urn:li:activity:']",
        "a[href*='/video/live/']",
        "a[href*='/pulse/']"
      ],
      titleSelectors: [
        ".update-components-text",
        ".feed-shared-inline-show-more-text",
        "[data-test-id='main-feed-activity-card__commentary']",
        ".break-words",
        "h1",
        "h2"
      ],
      creatorSelectors: [
        ".update-components-actor__name",
        ".feed-shared-actor__name",
        "a[href*='/in/']",
        "a[href*='/company/']",
        "h1"
      ],
      textSelectors: [
        ".update-components-text",
        ".feed-shared-inline-show-more-text",
        "[data-test-id='main-feed-activity-card__commentary']",
        ".feed-shared-actor__description",
        ".update-components-actor__description",
        ".feed-shared-image__description",
        "img[alt]",
        "h1",
        "h2",
        "section"
      ],
      transcriptSelectors: [
        ".vjs-text-track-display",
        "[class*='captions']",
        "[aria-live='polite']"
      ],
      videoSelectors: ["main video", "video"],
      nextSelectors: []
    })
  });

  function freezeAdapter(value) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entries]) => [key, Object.freeze([...entries])])));
  }

  function get(platform) {
    return adapters[platform] || null;
  }

  function isItemHref(platform, value) {
    let url;
    try {
      url = new URL(String(value || ""), `https://www.${platform === "tiktok" ? "tiktok.com" : platform === "instagram" ? "instagram.com" : "youtube.com"}/`);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (platform === "instagram") return host.endsWith("instagram.com") && /^\/(?:reel|p)\/[^/]+\/?/i.test(url.pathname);
    if (platform === "tiktok") return host.endsWith("tiktok.com") && /^\/@[^/]+\/video\/[^/]+\/?/i.test(url.pathname);
    if (platform === "linkedin") {
      return host.endsWith("linkedin.com")
        && (/^\/posts\/[^/]+/i.test(url.pathname)
          || /^\/feed\/update\/urn:li:activity:[^/?#]+/i.test(url.pathname)
          || /^\/video\/live\/[^/]+/i.test(url.pathname)
          || /^\/pulse\/[^/]+/i.test(url.pathname));
    }
    if (platform === "youtube") return host.endsWith("youtube.com") || host === "youtu.be";
    return false;
  }

  function profileNameFromHref(platform, value) {
    let url;
    try {
      url = new URL(String(value || ""), `https://www.${platform === "tiktok" ? "tiktok.com" : "instagram.com"}/`);
    } catch {
      return "";
    }
    const first = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "").trim();
    if (platform === "tiktok") return first.startsWith("@") ? first.slice(1, 81) : "";
    if (platform === "linkedin") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (!["in", "company"].includes(parts[0]?.toLowerCase())) return "";
      const normalized = clean(parts[1], 80).replace(/^@/, "");
      return normalized && !RESERVED_LINKEDIN_PATHS.has(normalized.toLowerCase()) ? normalized : "";
    }
    if (platform === "instagram") {
      const normalized = first.replace(/^@/, "");
      return normalized && !RESERVED_INSTAGRAM_PATHS.has(normalized.toLowerCase()) ? normalized.slice(0, 80) : "";
    }
    return first.startsWith("@") ? first.slice(1, 81) : "";
  }

  function isSocialUiText(value) {
    const text = clean(value, 180);
    return !text || SOCIAL_UI_PATTERN.test(text) || /^[\d,.]+[kmb]?$/i.test(text) || /^\d+[smhdw]$/i.test(text);
  }

  function chooseCaption(values, creator = "") {
    const normalizedCreator = clean(creator, 120).toLowerCase().replace(/^@/, "");
    const ranked = Array.from(new Set(values.map((value) => clean(value, 500)).filter(Boolean)))
      .filter((value) => !isSocialUiText(value))
      .filter((value) => value.toLowerCase().replace(/^@/, "") !== normalizedCreator)
      .map((value) => ({ value, score: captionScore(value) }))
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.value || "";
  }

  function advanceOne(platform, root = document) {
    const adapter = get(platform);
    if (!adapter || !root?.querySelector) return false;
    for (const selector of adapter.nextSelectors) {
      const button = root.querySelector(selector);
      if (!(button instanceof HTMLElement) || button.getAttribute("aria-disabled") === "true" || button.disabled) continue;
      button.click();
      return true;
    }
    return false;
  }

  function captionScore(value) {
    const words = value.split(/\s+/).filter(Boolean).length;
    let score = Math.min(value.length, 240) + Math.min(words, 30) * 8;
    if (/[.!?]/.test(value)) score += 18;
    if (/#[\p{L}\p{N}_]+/u.test(value)) score += 6;
    if (/^(?:photo|video) by\b/i.test(value)) score -= 45;
    if (/^@?[a-z0-9._]{2,32}$/i.test(value)) score -= 80;
    return score;
  }

  function clean(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  globalThis.OrislopPlatformAdapters = Object.freeze({
    advanceOne,
    chooseCaption,
    get,
    isItemHref,
    isSocialUiText,
    profileNameFromHref,
    supportedPlatforms: Object.freeze(Object.keys(adapters))
  });
})();
