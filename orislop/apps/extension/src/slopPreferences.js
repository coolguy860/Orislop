(() => {
  "use strict";

  const DEFINITIONS = Object.freeze([
    {
      id: "fully_ai_generated_video",
      category: "ai_fakeouts",
      label: "AI video",
      detail: "AI-made or edited video passed off as real."
    },
    {
      id: "ai_voice_tts",
      category: "ai_fakeouts",
      label: "AI voices",
      detail: "Text-to-speech, cloned voices, and fake narration."
    },
    {
      id: "reposted_stolen",
      category: "repost_jail",
      label: "Reposted clips",
      detail: "Movie, cartoon, or social reposts with almost no original take."
    },
    {
      id: "brainrot",
      category: "brainrot_bait",
      label: "Hook-only formats",
      detail: "Videos that only work as a hook, not an actual watch."
    },
    {
      id: "compilations",
      category: "repost_jail",
      label: "Clip dumps",
      detail: "Clip collections with no commentary. Stream highlights still pass."
    },
    {
      id: "engagement_bait",
      category: "brainrot_bait",
      label: "Ragebait and rankings",
      detail: "Ragebait, funniest-ranking posts, like begging, and fake urgency."
    },
    {
      id: "fake_stories",
      category: "receipt_check",
      label: "Texting and Reddit stories",
      detail: "Story formats built from text-message or Reddit-style screenshots."
    },
    {
      id: "repetitive_templates",
      category: "brainrot_bait",
      label: "Copy-paste posts",
      detail: "Same script, layout, challenge, or formula again and again."
    },
    {
      id: "sidecar_satisfying_asmr",
      category: "brainrot_bait",
      label: "Split-screen ASMR",
      detail: "ASMR, bottom videos, gameplay, or random clips attached to unrelated text."
    },
    {
      id: "low_originality",
      category: "repost_jail",
      label: "Thin edits",
      detail: "Text-over-clips, low-quality edits, phonk/funk edits, and thin remixes."
    },
    {
      id: "misleading_synthetic_media",
      category: "receipt_check",
      label: "Misleading claims",
      detail: "Misinformation, exaggerated claims, or media used as weak proof."
    },
    {
      id: "finance_schemes",
      category: "receipt_check",
      label: "Get-rich-quick schemes",
      detail: "Dropshipping, passive-income, and finance funnels built around implausible earnings claims."
    }
  ]);
  const CATEGORY_DEFINITIONS = Object.freeze([
    {
      id: "ai_fakeouts",
      label: "AI and Fake Media",
      detail: "AI visuals, cloned voices, and manipulated media."
    },
    {
      id: "repost_jail",
      label: "Reposts and Clip Farms",
      detail: "Movie/cartoon clips, social screenshots, clip dumps, and thin remixes."
    },
    {
      id: "brainrot_bait",
      label: "Filler Formats",
      detail: "Tier lists, ragebait, phonk/funk edits, templates, sidecars, and split-screen formats."
    },
    {
      id: "receipt_check",
      label: "Claims and Stories",
      detail: "Texting stories, Reddit stories, unsupported claims, and exaggeration."
    }
  ]);
  const ID_SET = new Set(DEFINITIONS.map(({ id }) => id));
  const DEFAULT_IDS = Object.freeze(DEFINITIONS.map(({ id }) => id));
  const VISUAL_IDS = Object.freeze(["fully_ai_generated_video", "misleading_synthetic_media"]);

  const OLLAMA_CATEGORY_MAP = Object.freeze({
    recycled: ["reposted_stolen", "low_originality"],
    story_gameplay: ["fake_stories", "repetitive_templates", "sidecar_satisfying_asmr"],
    compilation: ["compilations", "reposted_stolen", "low_originality"],
    content_farm: ["brainrot", "repetitive_templates", "low_originality"],
    viral_challenge: ["brainrot", "engagement_bait", "repetitive_templates"],
    scam: ["fake_stories", "engagement_bait", "finance_schemes"],
    finance_scheme: ["finance_schemes", "engagement_bait", "misleading_synthetic_media"],
    empty_reaction: ["low_originality"],
    engagement_bait: ["engagement_bait"],
    tier_ranking: ["brainrot", "engagement_bait", "repetitive_templates"],
    phonk_edit: ["low_originality", "repetitive_templates", "sidecar_satisfying_asmr"],
    movie_text: ["reposted_stolen", "low_originality", "sidecar_satisfying_asmr"],
    social_screenshot: ["reposted_stolen", "low_originality"],
    ragebait: ["engagement_bait"],
    misinfo_hype: ["fake_stories", "engagement_bait", "misleading_synthetic_media"],
    core_format: [],
    stream_clip: [],
    creator_persona: []
  });

  function normalize(value) {
    if (!Array.isArray(value)) return [...DEFAULT_IDS];
    return [...new Set(value.filter((id) => ID_SET.has(id)))];
  }

  function includesAny(selectedValue, categoryValue) {
    const selected = new Set(normalize(selectedValue));
    const categories = Array.isArray(categoryValue) ? categoryValue : [categoryValue];
    return categories.some((id) => selected.has(id));
  }

  function selectedMatches(selectedValue, categoryValue) {
    const selected = new Set(normalize(selectedValue));
    const categories = Array.isArray(categoryValue) ? categoryValue : [categoryValue];
    return [...new Set(categories.filter((id) => ID_SET.has(id) && selected.has(id)))];
  }

  function categoriesForOllama(category) {
    return [...(OLLAMA_CATEGORY_MAP[String(category || "")] || [])];
  }

  globalThis.OrislopSlopPreferences = Object.freeze({
    definitions: DEFINITIONS,
    categories: CATEGORY_DEFINITIONS,
    defaultIds: DEFAULT_IDS,
    visualIds: VISUAL_IDS,
    normalize,
    includesAny,
    selectedMatches,
    categoriesForOllama
  });
})();
