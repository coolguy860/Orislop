(() => {
  "use strict";

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
    "artificial intelligence",
    "generative ai",
    "generated with ai",
    "made with ai",
    "created with ai",
    "synthetic voice",
    "synthetic content",
    "voice clone",
    "ai voiceover",
    "ai voice over",
    "ai cover",
    "ai song",
    "ai music",
    "deepfake",
    "sora generated",
    "ai image",
    "ai video"
  ];
  const PLATFORM_AI_DISCLOSURES = [
    "altered or synthetic content",
    "altered or synthetic",
    "includes altered or synthetic content",
    "this content is altered or synthetic",
    "created or altered with ai",
    "generated or altered with ai",
    "made with artificial intelligence",
    "synthetic content",
    "ai-generated content",
    "ai generated content"
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

  const RULES = [
    { label: "YouTube AI/synthetic disclosure", weight: 74, test: (text) => includesAny(text, PLATFORM_AI_DISCLOSURES) },
    { label: "Clickbait wording", weight: 18, test: (text) => includesAny(text, CLICKBAIT) },
    { label: "Brainrot/slop format keywords", weight: 22, test: (text) => includesAny(text, BRAINROT) },
    { label: "Engagement bait language", weight: 16, test: (text) => includesAny(text, ENGAGEMENT_BAIT) },
    { label: "AI-generated content terms", weight: 34, test: (text) => hasAiSignal(text) },
    { label: "Excessive emoji pattern", weight: 10, test: (text) => emojiCount(text) >= 3 },
    { label: "Spammy capitalization or punctuation", weight: 12, test: (text) => /[!?]{3,}/.test(text) || allCapsWordCount(text) >= 3 },
    { label: "Repetitive title/caption", weight: 14, test: (text) => hasRepetition(text) },
    { label: "Low-information title", weight: 14, test: (_text, input) => isLowInformationTitle(input.title || "") },
    { label: "Shorts format signal", weight: 8, test: (_text, input) => parseYouTubeUrl(input.url).videoKind === "short" }
  ];

  self.addEventListener("message", (event) => {
    if (event.data?.type !== "scoreCandidate") {
      return;
    }

    const candidate = event.data.candidate || {};
    const result = scoreStaticSlop({
      url: candidate.url || "",
      title: candidate.title || "",
      description: candidate.visibleText || "",
      strictness: "balanced"
    });
    self.postMessage({
      jobId: event.data.jobId,
      result
    });
  });

  function scoreStaticSlop(input) {
    const parsed = parseYouTubeUrl(input.url);
    const text = normalize([
      input.title,
      input.description,
      parsed.videoKind === "short" ? "youtube shorts" : ""
    ].filter(Boolean).join(" "));
    const reasons = [];
    let rawScore = 0;

    for (const rule of RULES) {
      if (rule.test(text, input)) {
        rawScore += rule.weight;
        reasons.push(rule.label);
      }
    }

    const stackedSignalBoost = Math.max(0, reasons.length - 2) * 4;
    const score = clampScore(rawScore + stackedSignalBoost);
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

  function parseYouTubeUrl(input) {
    const trimmed = String(input || "").trim();
    if (!trimmed) {
      return emptyParsedResult();
    }

    try {
      const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      const host = url.hostname.toLowerCase();
      if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
        return emptyParsedResult();
      }

      const pathParts = url.pathname.split("/").filter(Boolean);
      const shortsId = pathParts[0] === "shorts" && pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
      const watchId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
      const shortLinkId = host === "youtu.be" && pathParts[0] ? decodeURIComponent(pathParts[0]) : null;
      const videoId = sanitizeVideoId(shortsId || watchId || shortLinkId);
      const videoKind = shortsId ? "short" : videoId ? "watch" : "unknown";

      return {
        videoId,
        videoKind
      };
    } catch {
      return emptyParsedResult();
    }
  }

  function sanitizeVideoId(value) {
    if (!value) {
      return null;
    }
    const clean = value.trim();
    return /^[a-zA-Z0-9_-]{3,128}$/.test(clean) ? clean : null;
  }

  function emptyParsedResult() {
    return {
      videoId: null,
      videoKind: "unknown"
    };
  }

  function includesAny(text, phrases) {
    return phrases.some((phrase) => text.includes(phrase));
  }

  function hasAiSignal(text) {
    if (includesAny(text, PLATFORM_AI_DISCLOSURES)) {
      return true;
    }
    if (includesAny(text, AI_TERMS)) {
      return true;
    }
    return /\bai\b/.test(text)
      && /\b(voice|generated|synthetic|deepfake|clone|cover|song|music|video|image|art|made|created|altered)\b/.test(text);
  }

  function emojiCount(text) {
    return Array.from(text).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
  }

  function allCapsWordCount(text) {
    return text.split(/\s+/).filter((word) => /^[A-Z]{4,}$/.test(word)).length;
  }

  function hasRepetition(text) {
    const words = text.match(/[a-z0-9']+/gi)?.map((word) => word.toLowerCase()) || [];
    if (words.length < 10) {
      return false;
    }

    const uniqueRatio = new Set(words).size / words.length;
    const counts = new Map();
    for (let index = 0; index < words.length - 1; index += 1) {
      const key = `${words[index]} ${words[index + 1]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    return uniqueRatio < 0.45 || Array.from(counts.values()).some((count) => count >= 3);
  }

  function isLowInformationTitle(title) {
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

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
})();
