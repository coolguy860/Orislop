(() => {
  "use strict";

  const SKIP_THRESHOLD = 72;
  const SLOP_PREFERENCE_API = globalThis.OrislopSlopPreferences;
  const EDUCATIONAL_PATTERN = /\b(explain|explains|explained|explaining|lesson|lecture|tutorial|course|courseware|open\s*courseware|classroom|university|college|institute|academic|science|scientific|scientist|physicist|historian|history|historical|math|mathematics|physics|chemistry|biology|astronomy|astrophysics|cosmology|gravity|relativity|quantum|engineering|programming|coding|php|mysql|postgres(?:ql)?|sql|javascript|typescript|python|java|c\+\+|react(?:\.js)?|node(?:\.js)?|database|web\s+(?:development|application)|software\s+(?:development|engineering)|documentary|analysis|research|experiment|demonstration|visuali[sz](?:e|ed|ation)|how\s+to|learn|educational|education|professor|teacher|study|evidence|source|sourced)\b/;
  const STORY_PATTERN = /\b(reddit|askreddit|aita|storytime|reddit\s+story|reddit\s+stories|reddit\s+thread|texting\s+stor(?:y|ies)|text\s+message\s+stor(?:y|ies)|chat\s+stor(?:y|ies)|pov\s+text(?:ing)?\s+stor(?:y|ies))\b/;
  const BACKGROUND_PATTERN = /\b(minecraft\s+parkour|subway\s+surfers|mobile\s+game(?:play)?|parkour\s+gameplay|minecraft\s+gameplay|satisfying\s+background|split\s+screen|bottom\s+video|video\s+(?:at|on)\s+the\s+bottom|asmr\s+(?:on\s+the\s+)?side|asmr\s+sidecar)\b/;
  const SYNTHETIC_NARRATION_PATTERN = /\b(ai\s+voice(?:over)?|text\s+to\s+speech|tts|robot\s+voice|synthetic\s+voice|voice\s+clone)\b/;
  const RECYCLED_PATTERN = /\b(repost(?:ed)?|re-?upload(?:ed)?|clips?\s+compilation|viral\s+clips|family\s+guy\s+clips|no\s+commentary|source\s+unknown|credit\s+unknown|not\s+mine|green\s*screen)\b/;
  const COMPILATION_PATTERN = /\b(compilation|clip\s+collection|best\s+of|viral\s+clips|top\s+\d+\s+clips)\b/;
  const EXPLICIT_SLOP_PATTERN = /\b(brainrot|content\s+farm|ai\s+slop|subway\s+surfers|family\s+guy\s+clips)\b/;
  const BRAINROT_TITLE_PATTERN = /\bbrain\s*rot\b/;
  const BRAINROT_ANALYSIS_PATTERN = /\b(what\s+is|why|explains?|explained|analysis|history|science|psychology|research|documentary|essay|critique|meaning|effect(?:s)?|study)\b/;
  const KNOWN_BRAINROT_CHARACTER_PATTERN = /\b(?:tung(?:\s+tung){1,3}\s+sahur|tralalero\s+tralala|bombardir[oi]\s+crocodilo|ballerina\s+cappuccina|cappuccino\s+assassino|lirili\s+larila|brr\s+brr\s+patapim|chimpanzini\s+bananini|frigo\s+camelo|boneca\s+ambalabu|ta\s+ta\s+ta\s+sahur|odindindindun|bombombini\s+gusini|trippi\s+troppi|la\s+vaca\s+saturno\s+saturnita|bobrito\s+bandito|glorbo\s+fruttodrillo|cocofanto\s+elefanto|orangutini\s+ananasini)\b/;
  const BRAINROT_MEDIA_TITLE_PATTERN = /\b(?:italian\s+)?brain\s*ro+t\b.{0,70}\b(?:animations?|stories|story|shorts?|edits?|videos?|memes?|compilations?|music)\b|\b(?:animations?|stories|story|shorts?|edits?|videos?|memes?|compilations?)\b.{0,70}\b(?:italian\s+)?brain\s*ro+t\b/;
  const MONEY_CONTRAST_PATTERN = /(?:\$\s*[\d,.]+|one\s+dollar)\s+(?:vs\.?|versus)\s+(?:\$\s*[\d,.]+|\d+\s*(?:million|billion)\s+dollars?)/;
  const SECRET_BUILD_PATTERN = /\b(?:built?|made|found|hid(?:den|ing)?)\b.{0,24}\b(?:secret|hidden)\b.{0,18}\b(?:rooms?|houses?|bases?|bunkers?|tunnels?|cars?|islands?)\b/;
  const SURVIVAL_CHALLENGE_PATTERN = /\b(?:i\s+)?(?:surviv(?:e|ed|ing)|last\s+to\s+(?:leave|stop)|spent\s+\d+\s+hours?|extreme\s+challenge|impossible\s+challenge|don'?t\s+go\s+to\s+prison)\b/;
  const MANUFACTURED_STAKES_PATTERN = /\b(?:world'?s\s+(?:most|strictest|worst|craziest)|evil\s+(?:babysitter|teacher|kid|parent)|who\s+stole|is\s+missing|squid\s+game\s+(?:in\s+real\s+life|irl)|find\s+\w+.{0,18}\bdon'?t)\b/;
  const CELEBRITY_BAIT_PATTERN = /\b(?:ronaldo|mr\s*beast|brent\s+rivera|sssniperwolf)\b/;
  const FILTERED_CREATOR_PATTERN = /\btopper\s+guild\b/;
  const SCAM_PATTERN = /\b(guaranteed\s+(?:passive\s+)?income|make\s+money\s+fast|miracle\s+cure|doctors\s+hate|banks\s+hate|they\s+don'?t\s+want\s+you\s+to\s+know|secret\s+trick|claim\s+your\s+prize)\b/;
  const CLICKBAIT_PATTERN = /\b(you\s+won'?t\s+believe|wait\s+for\s+it|watch\s+(?:till|until)\s+the\s+end|this\s+changed\s+everything|before\s+they\s+delete\s+this|insane\s+ending|shocking)\b/;
  const ENGAGEMENT_PATTERN = /\b(like\s+and\s+follow|subscribe\s+for\s+more|follow\s+for\s+(?:more|part)|comment\s+below|tag\s+someone|share\s+this\s+with)\b/;
  const SENSORY_PATTERN = /\b(oddly\s+satisfying|satisfying\s+(?:video|compilation|background)|asmr\s+compilation|ranking\s+the\s+most\s+satisfying)\b/;
  const TIER_RANKING_PATTERN = /\b(?:tier\s*list|ranking|rank(?:ing|ed)?|top\s+\d+)\b.{0,70}\b(?:funniest|funny|memes?|clips?|moments?|things?|characters?|cartoons?)\b|\b(?:funniest|funny)\b.{0,50}\b(?:tier\s*list|ranking|ranked)\b/;
  const PHONK_BACKGROUND_PATTERN = /\b(?:phonk|funk)\b.{0,60}\b(?:background|noise|audio|song|music|edit|clips?|movie|cartoon|scene|reddit|story)\b|\b(?:background|noise|audio|song|music|edit|clips?|movie|cartoon|scene)\b.{0,60}\b(?:phonk|funk)\b/;
  const MOVIE_CARTOON_CLIP_PATTERN = /\b(?:movie|film|cartoon|anime|family\s+guy|south\s+park|sponge\s*bob|simpsons?|rick\s+and\s+morty|disney|pixar)\b.{0,55}\b(?:clips?|scenes?|moments?|background|footage)\b|\b(?:clips?|scenes?|moments?)\b.{0,55}\b(?:movie|film|cartoon|anime|family\s+guy|south\s+park|sponge\s*bob|simpsons?|rick\s+and\s+morty|disney|pixar)\b/;
  const TEXT_OVER_CLIP_PATTERN = /\b(?:text|caption|subtitles?|quote|tweet|twitter\s+post|x\s+post|reddit\s+post|comment)\b.{0,70}\b(?:over|on\s+top\s+of|above|with)\b.{0,70}\b(?:movie|film|cartoon|anime|clip|scene|family\s+guy|south\s+park|sponge\s*bob|simpsons?)\b|\b(?:movie|film|cartoon|anime|clip|scene|family\s+guy|south\s+park|sponge\s*bob|simpsons?)\b.{0,70}\b(?:text|caption|subtitles?|quote|tweet|twitter\s+post|x\s+post|comment)\b/;
  const LOW_QUALITY_EDIT_PATTERN = /\b(?:low\s+quality|lazy|trash|sloppy)\s+edit\b|\b(?:phonk|funk|sigma)\s+edit\b|\b(?:movie|cartoon|anime|clips?|scenes?)\b.{0,45}\bedit\b|\bedit\b.{0,45}\b(?:different\s+clips?|scene\s+pack|movie|cartoon|anime|phonk|funk)\b/;
  const SOCIAL_SCREENSHOT_PATTERN = /\b(?:twitter|x)\s+(?:post|tweet|screenshot|comment|reply)\b|\btweet\b.{0,45}\b(?:comment|reply|screenshot)\b|\b(?:post|screenshot)\b.{0,45}\b(?:with|and)\s+(?:a\s+)?(?:comment|reply)\b/;
  const RAGEBAIT_PATTERN = /\b(rage\s*bait|ragebait|baiting\s+you|trying\s+to\s+make\s+you\s+mad|this\s+will\s+make\s+you\s+mad|hot\s+take|controversial\s+take|triggered|cope\s+and\s+seethe)\b/;
  const EXAGGERATED_INFO_PATTERN = /\b(blown\s+out\s+of\s+proportion|nobody\s+is\s+talking\s+about|media\s+won'?t\s+tell\s+you|they\s+don'?t\s+want\s+you\s+to\s+know|this\s+changes\s+everything|shocking\s+truth|secret\s+truth|the\s+truth\s+about|what\s+they\s+are\s+hiding|insane\s+new\s+study|exposed)\b/;
  const SPLIT_ASMR_SIDECAR_PATTERN = /\b(?:asmr|satisfying|slime|soap\s+cutting|kinetic\s+sand|gameplay|movie\s+clip|cartoon\s+clip)\b.{0,70}\b(?:side|bottom|top|split\s*screen|below|under|background)\b|\b(?:video|clip|gameplay|asmr)\s+(?:at|on)\s+the\s+(?:bottom|side)\b|\bactual\s+(?:thing|story|content|post)\s+(?:at|on)\s+the\s+top\b/;
  const CORE_FORMAT_PATTERN = /\b[a-z0-9][a-z0-9'-]*(?:\s+[a-z0-9][a-z0-9'-]*){0,3}\s+core\b/;
  const STREAM_CLIP_PROTECTED_PATTERN = /\b(?:stream(?:er)?\s+(?:clips?|moments?|highlights?)|twitch\s+(?:clips?|moments?|highlights?)|live\s+stream\s+(?:clips?|moments?|highlights?)|clips?\s+from\s+(?:a\s+)?stream|stream\s+vod\s+clips?|stream\s+highlights?)\b/;
  const CREATOR_PERSONA_PATTERN = /\b(?:h1t1|carter\s*pcs?|carterpcs|actual\s+person|distinct\s+persona|creator\s+persona|original\s+creator|original\s+commentary|my\s+(?:setup|pc|build|desk|room|day)|i\s+(?:built|made|tried|tested|reviewed|fixed|explained|ranked?))\b/;
  const AI_DISCLOSURE_PATTERN = /\b(altered\s+or\s+synthetic(?:\s+content)?|created\s+or\s+altered\s+with\s+ai|generated\s+by\s+ai|generated\s+with\s+ai|made\s+with\s+ai|created\s+with\s+ai|fully\s+ai[-\s]+generated|ai[-\s]+generated(?:\s+(?:content|images?|visuals?|characters?|animation|videos?|voice(?:over)?s?))?|artificial\s+intelligence[-\s]+generated|artificially\s+generated|synthetic\s+content|digitally\s+generated|deepfake|sora\s+generated)\b/;
  const AI_MEDIA_TITLE_PATTERN = /\bai\s+(?:animation|videos?|images?|visuals?|characters?|cover|song|music)\b/;
  const AI_ANALYSIS_PATTERN = /\b(?:how|why|what\s+is|explains?|explained|analysis|history|science|research|documentary|essay|critique|tutorial|lesson|lecture|course|review|comparison|news|report)\b/;
  const AI_DISCLOSURE_HASHTAG_PATTERN = /(?:^|\s)#(?:aigenerated|aivideo|aianimation|aiart|aivoice|syntheticmedia)\b/;
  const INFORMATIONAL_TOPIC_PATTERN = /\b(news|report(?:ed|ing)?|politic(?:s|al)?|election|government|law|legal|court|health|medical|medicine|disease|vaccine|nutrition|science|scientific|research|study|history|historical|economy|economic|finance|financial|climate|environment|technology|data|statistics|evidence|fact|documentary|analysis)\b/;
  const CHECKABLE_CLAIM_PATTERN = /(?:\b\d+(?:\.\d+)?\s*(?:%|percent|million|billion|years?|times?)\b|\b(?:is|are|was|were|causes?|prevents?|increases?|decreases?|proves?|found|shows?|explains?|according\s+to|researchers?|scientists?|study)\b)/;
  const CLAIM_ROUTING_PATTERN = /\b(?:fact(?:s)?|myth|true|false|truth|actually|according\s+to|research(?:ers?)?|scientists?|experts?|study|data|statistics?|causes?|prevents?|cures?|proves?|found|shows?|never|always|nasa|cdc|fda|who|government|president|election|vaccine|disease|climate|earth|moon|space|economy|tax)\b/;
  const PROFESSIONAL_CLAIM_PATTERN = /\b(?:founded|co-?founded|built|launched|grew|increased|reduced|managed|led|generated|raised|revenue|users?|customers?|employees?|patents?|awards?|certified|certification|degree|graduated|worked\s+at|employed\s+by|years?\s+of\s+experience|top\s+\d+\s*%|fortune\s+\d+|million|billion)\b/;

  const AI_MODEL = globalThis.ORISLOP_AI_CLASSIFIER_V1;
  const AI_MODEL_AVAILABLE = Boolean(AI_MODEL && Array.isArray(AI_MODEL.features) && AI_MODEL.features.length > 0);
  const AI_MODEL_INTERCEPT = Number.isFinite(AI_MODEL?.intercept) ? AI_MODEL.intercept : 0;
  const AI_FEATURE_MAP = new Map((AI_MODEL?.features || []).map(({ term, idf, weight }) => [term, { idf, weight }]));
  const AI_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "the", "this", "to", "with", "you", "your"]);

  function scoreCandidate(input = {}) {
    const parsed = parsePlatformUrl(input.url, input.platform, input.itemId);
    const title = cleanText(input.title, 400);
    const description = cleanText([
      input.visibleText || input.description,
      input.imageText
    ].filter(Boolean).join(" "), 2400);
    const transcript = cleanText(input.transcriptText, 1800);
    const channelName = cleanText(input.channelName, 240);
    const text = normalize([title, description, transcript, channelName].filter(Boolean).join(" "));
    const normalizedTitle = normalize(title);
    const signals = [];
    const strongCategories = new Set();
    const detectedSlopCategories = new Set();
    const selectedSlopPreferences = SLOP_PREFERENCE_API?.normalize(input.slopPreferences) || [];
    const preferenceEnabled = (...categories) => SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.includesAny(selectedSlopPreferences, categories)
      : true;

    const add = (label, points, category = null, slopCategories = []) => {
      const mappedCategories = Array.isArray(slopCategories) ? slopCategories : [slopCategories];
      for (const slopCategory of mappedCategories) {
        if (slopCategory) detectedSlopCategories.add(slopCategory);
      }
      if (mappedCategories.length > 0 && !preferenceEnabled(...mappedCategories)) return;
      signals.push({ label, points });
      if (category) strongCategories.add(category);
    };

    const hasStory = STORY_PATTERN.test(text);
    const hasBackground = BACKGROUND_PATTERN.test(text);
    const hasSyntheticNarration = SYNTHETIC_NARRATION_PATTERN.test(text);
    const hasRecycledContent = RECYCLED_PATTERN.test(text);
    const hasCompilation = COMPILATION_PATTERN.test(text);
    const hasEngagementBait = ENGAGEMENT_PATTERN.test(text);
    const hasSensorySidecar = SENSORY_PATTERN.test(text) && !isMusicContext(text);
    const hasTierRanking = TIER_RANKING_PATTERN.test(text);
    const hasMovieCartoonClip = MOVIE_CARTOON_CLIP_PATTERN.test(text);
    const hasTextOverClip = TEXT_OVER_CLIP_PATTERN.test(text);
    const hasLowQualityEdit = LOW_QUALITY_EDIT_PATTERN.test(text);
    const hasSocialScreenshot = SOCIAL_SCREENSHOT_PATTERN.test(text);
    const hasRagebait = RAGEBAIT_PATTERN.test(text);
    const hasExaggeratedInfo = EXAGGERATED_INFO_PATTERN.test(text);
    const hasSplitAsmrSidecar = SPLIT_ASMR_SIDECAR_PATTERN.test(text) && !isMusicContext(text);
    const hasPhonkBackground = PHONK_BACKGROUND_PATTERN.test(text)
      && (hasMovieCartoonClip || hasTextOverClip || hasLowQualityEdit || hasStory || hasBackground || hasSplitAsmrSidecar);
    const coreFormatProtected = CORE_FORMAT_PATTERN.test(text);
    const streamClipProtected = STREAM_CLIP_PROTECTED_PATTERN.test(text);
    const creatorPersonaProtected = CREATOR_PERSONA_PATTERN.test(text);
    const preferredFormatProtected = coreFormatProtected || streamClipProtected || creatorPersonaProtected;
    const recycledClipProtected = coreFormatProtected || streamClipProtected || creatorPersonaProtected;
    const normalizedBody = normalize([description, transcript, channelName].filter(Boolean).join(" "));
    const titleAiDisclosure = (AI_DISCLOSURE_PATTERN.test(normalizedTitle) || AI_MEDIA_TITLE_PATTERN.test(normalizedTitle))
      && !AI_ANALYSIS_PATTERN.test(normalizedTitle);
    const hasAiDisclosure = titleAiDisclosure
      || AI_DISCLOSURE_PATTERN.test(normalizedBody)
      || AI_DISCLOSURE_HASHTAG_PATTERN.test(text);
    const learnedBrainrotTokens = new Set((Array.isArray(input.learnedBrainrotTerms) ? input.learnedBrainrotTerms : [])
      .map((value) => normalize(cleanText(value, 40)))
      .filter((value) => /^[a-z]{8,32}$/.test(value)));
    const titleTokens = new Set(normalizedTitle.split(/[^a-z]+/).filter(Boolean));
    const learnedBrainrotTitle = [...learnedBrainrotTokens].some((value) => titleTokens.has(value));
    const knownBrainrotTitle = (KNOWN_BRAINROT_CHARACTER_PATTERN.test(normalizedTitle)
      || BRAINROT_MEDIA_TITLE_PATTERN.test(normalizedTitle))
      && !BRAINROT_ANALYSIS_PATTERN.test(normalizedTitle);
    const filteredCreatorTitle = FILTERED_CREATOR_PATTERN.test(normalize([title, channelName].join(" ")))
      && !BRAINROT_ANALYSIS_PATTERN.test(normalizedTitle);
    const hardSyntheticNarration = hasSyntheticNarration && preferenceEnabled("ai_voice_tts");
    const hardAiDisclosure = hasAiDisclosure && preferenceEnabled("fully_ai_generated_video");
    const hardKnownBrainrot = knownBrainrotTitle
      && preferenceEnabled("brainrot", "fully_ai_generated_video");
    const hardAiSynthetic = hardSyntheticNarration || hardAiDisclosure || hardKnownBrainrot;
    const hardFilteredCreator = filteredCreatorTitle && preferenceEnabled("brainrot", "low_originality");
    const hardLocalSkip = hardAiSynthetic || hardFilteredCreator;
    const stackedParts = [hasStory, hasBackground, hasSyntheticNarration].filter(Boolean).length;
    const hardStackedFormat = stackedParts >= 2
      && preferenceEnabled("fake_stories", "repetitive_templates", "sidecar_satisfying_asmr", "ai_voice_tts");
    const explicitBrainrotTitle = BRAINROT_TITLE_PATTERN.test(normalizedTitle)
      && !BRAINROT_ANALYSIS_PATTERN.test(normalizedTitle);
    const viralChallengeSignals = [
      MONEY_CONTRAST_PATTERN.test(normalizedTitle),
      SECRET_BUILD_PATTERN.test(normalizedTitle),
      SURVIVAL_CHALLENGE_PATTERN.test(normalizedTitle),
      MANUFACTURED_STAKES_PATTERN.test(normalizedTitle),
      CELEBRITY_BAIT_PATTERN.test(normalizedTitle)
    ].filter(Boolean).length;
    const viralChallengeFactory = MONEY_CONTRAST_PATTERN.test(normalizedTitle) || viralChallengeSignals >= 2;

    if (hardStackedFormat) add("Stacked story/background format", stackedParts === 3 ? 46 : 38, "stacked_format", ["fake_stories", "repetitive_templates", "sidecar_satisfying_asmr"]);
    if (hasStory) add("Story-farm source", 14, "story_farm", ["fake_stories", "repetitive_templates"]);
    if (hasBackground) add("Unrelated looping gameplay", 16, "background_gameplay", ["sidecar_satisfying_asmr", "repetitive_templates"]);
    if (hasSyntheticNarration) add("Synthetic narration", 22, "synthetic_narration", ["ai_voice_tts"]);
    if (hasRecycledContent && !recycledClipProtected) add("Repost-like or low-originality clips", 25, "recycled_content", ["reposted_stolen", "low_originality"]);
    if (hasCompilation && !streamClipProtected) add("Compilation without original analysis", 24, "compilation", ["compilations", "low_originality"]);
    if (hasTierRanking) add("Tier-list ranking bait", 24, "tier_ranking", ["brainrot", "engagement_bait", "repetitive_templates"]);
    if (hasMovieCartoonClip && !recycledClipProtected) add("Movie/cartoon clip repost", 30, "movie_cartoon_clip", ["reposted_stolen", "low_originality"]);
    if (hasTextOverClip && !coreFormatProtected) add("Text over unrelated movie/cartoon clip", 35, "text_over_clip", ["low_originality", "sidecar_satisfying_asmr", "reposted_stolen"]);
    if (hasLowQualityEdit && !coreFormatProtected) add("Low-quality phonk/funk edit format", 26, "low_quality_edit", ["low_originality", "repetitive_templates"]);
    if (hasPhonkBackground && !coreFormatProtected) add("Phonk/funk background filler", 22, "phonk_background", ["low_originality", "sidecar_satisfying_asmr"]);
    if (hasSocialScreenshot) add("Social screenshot plus comment format", 28, "social_screenshot", ["low_originality", "reposted_stolen"]);
    if (hasRagebait) add("Ragebait hook", 34, "ragebait", ["engagement_bait"]);
    if (hasExaggeratedInfo) add("Information blown out of proportion", 28, "exaggerated_info", ["fake_stories", "engagement_bait", "misleading_synthetic_media"]);
    if (hasSplitAsmrSidecar) add("ASMR or bottom-video sidecar", 22, "split_asmr_sidecar", ["sidecar_satisfying_asmr", "repetitive_templates"]);
    if (EXPLICIT_SLOP_PATTERN.test(text)) add("Explicit slop/content-farm format", 28, "explicit_slop", ["brainrot", "low_originality"]);
    if (explicitBrainrotTitle) add("Title explicitly labels itself brainrot", 46, "explicit_brainrot_title", ["brainrot"]);
    if (knownBrainrotTitle) add("Known AI-brainrot character title", 100, "known_brainrot_title", ["brainrot", "fully_ai_generated_video"]);
    if (filteredCreatorTitle) add("Filtered creator or format", 100, "filtered_creator", ["brainrot", "low_originality"]);
    if (learnedBrainrotTitle && !knownBrainrotTitle) add("Locally learned brainrot character title", 46, "learned_brainrot_title", ["brainrot", "repetitive_templates"]);
    if (viralChallengeFactory) add("Manufactured viral challenge format", 34, "viral_challenge_factory", ["brainrot", "engagement_bait", "repetitive_templates"]);
    if (SCAM_PATTERN.test(text)) add("Scam or extreme claim bait", 34, "scam_bait", ["fake_stories", "engagement_bait"]);
    if (CLICKBAIT_PATTERN.test(text)) add("Clickbait wording", 9, null, ["engagement_bait"]);
    if (hasEngagementBait) add("Engagement bait", 10, null, ["engagement_bait"]);
    if (hasSensorySidecar) add("Sensory filler format", 10, null, ["sidecar_satisfying_asmr"]);
    if (hasAiDisclosure) add("AI/synthetic disclosure", 5, null, ["fully_ai_generated_video"]);
    if (emojiCount(text) >= 5) add("Heavy emoji pattern", 5, null, ["engagement_bait", "repetitive_templates"]);
    if (/[!?]{4,}/.test(text)) add("Spammy punctuation", 5, null, ["engagement_bait"]);
    const slopCategories = [...detectedSlopCategories];
    const matchedSlopPreferences = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.selectedMatches(selectedSlopPreferences, slopCategories)
      : [...slopCategories];

    const educational = EDUCATIONAL_PATTERN.test(normalize([title, description, transcript].join(" ")))
      && !hasRagebait
      && !hasExaggeratedInfo;
    const informationalText = normalize([title, description, transcript].join(" "));
    const factCheckEligible = ["short", "video"].includes(parsed.itemKind)
      || ["post", "profile", "image"].includes(parsed.itemKind)
        ? informationalText.length >= 40
          && (INFORMATIONAL_TOPIC_PATTERN.test(informationalText)
            || CLAIM_ROUTING_PATTERN.test(informationalText)
            || PROFESSIONAL_CLAIM_PATTERN.test(informationalText))
          && (CHECKABLE_CLAIM_PATTERN.test(informationalText)
            || PROFESSIONAL_CLAIM_PATTERN.test(informationalText))
        : false;
    const metadataAi = runMetadataModel({
      title,
      description: [description, transcript].filter(Boolean).join(" "),
      channelName,
      isShort: parsed.itemKind === "short",
      durationSeconds: Number(input.durationSeconds) || 0
    });

    if (hardLocalSkip) {
      const hardReason = hardFilteredCreator
        ? "Filtered creator preference matched"
        : hardKnownBrainrot
          ? "Known AI-brainrot title detected"
          : hardAiDisclosure ? "AI/synthetic content detected" : "Synthetic narration detected";
      return {
        score: 100,
        recommendation: "skip",
        reasons: [hardReason],
        confidence: "high",
        platform: parsed.platform,
        itemId: parsed.itemId,
        itemKind: parsed.itemKind,
        normalizedUrl: parsed.normalizedUrl,
        educationalProtected: false,
        factCheckEligible,
        hardAiSynthetic,
        hardLocalSkip: true,
        hardStackedFormat,
        preferredFormatProtected,
        protectedFormatKind: protectedFormatKind({ coreFormatProtected, streamClipProtected, creatorPersonaProtected }),
        aiDisclosureDetected: hasAiDisclosure,
        slopCategories,
        matchedSlopPreferences,
        selectedSlopPreferences,
        strongEvidenceCount: strongCategories.size,
        signalBreakdown: [...signals, { label: hardAiSynthetic ? "Hard AI/synthetic override" : "Hard local preference override", points: 100 }],
        aiClassifierUsed: metadataAi.available,
        aiClassifier: metadataAi,
        ollamaUsed: false,
        sourceScores: {
          heuristic: 100,
          metadataModel: metadataAi.available ? metadataAi.score : null,
          ollama: null,
          spatial: null,
          temporal: null
        },
        thresholds: { skip: SKIP_THRESHOLD }
      };
    }
    const metadataAdjustment = metadataAi.available
      ? metadataAi.score >= 82 ? 10 : metadataAi.score <= 25 ? -8 : 0
      : 0;
    if (metadataAdjustment > 0) add("Local metadata model support", metadataAdjustment);

    const strongEvidenceCount = strongCategories.size;
    const stackedBoost = strongEvidenceCount >= 3 ? 15 : strongEvidenceCount >= 2 ? 25 : 0;
    const educationProtection = educational && !hardStackedFormat && !strongCategories.has("scam_bait") ? 34 : 0;
    const formatProtection = preferredFormatProtected && !hasRagebait && !hasExaggeratedInfo ? 28 : 0;
    const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0) + stackedBoost + Math.min(0, metadataAdjustment);
    const score = clampScore(rawScore - educationProtection - formatProtection);
    const enoughEvidence = hardStackedFormat || strongEvidenceCount >= 2;
    const recommendation = "watch";
    const positiveReasons = signals.filter((signal) => signal.points > 0).map((signal) => signal.label);
    const preferredReason = preferredFormatProtected
      ? coreFormatProtected ? "Core format allowed"
        : streamClipProtected ? "Stream clips allowed"
          : "Creator-persona content protected"
      : "";
    const reasons = educational
        ? ["Educational/useful context protected", ...positiveReasons.slice(0, 2)]
        : preferredReason && positiveReasons.length === 0
          ? [preferredReason]
        : enoughEvidence && score >= SKIP_THRESHOLD
          ? ["Strong local slop signals; awaiting Ollama verdict", ...positiveReasons.slice(0, 3)]
          : positiveReasons.length > 0
            ? ["Awaiting Ollama verdict", ...positiveReasons.slice(0, 2)]
            : ["Awaiting Ollama verdict"];

    return {
      score,
      recommendation,
      reasons,
      confidence: recommendation === "skip" && (hardStackedFormat || strongEvidenceCount >= 3) ? "high" : score <= 30 ? "high" : "medium",
      platform: parsed.platform,
      itemId: parsed.itemId,
      itemKind: parsed.itemKind,
      normalizedUrl: parsed.normalizedUrl,
      educationalProtected: educationProtection > 0,
      factCheckEligible,
      hardAiSynthetic: false,
      hardLocalSkip: false,
      hardStackedFormat,
      preferredFormatProtected,
      protectedFormatKind: protectedFormatKind({ coreFormatProtected, streamClipProtected, creatorPersonaProtected }),
      aiDisclosureDetected: hasAiDisclosure,
      slopCategories,
      matchedSlopPreferences,
      selectedSlopPreferences,
      strongEvidenceCount,
      signalBreakdown: signals,
      aiClassifierUsed: metadataAi.available,
      aiClassifier: metadataAi,
      ollamaUsed: false,
      sourceScores: {
        heuristic: clampScore(rawScore),
        metadataModel: metadataAi.available ? metadataAi.score : null,
        ollama: null,
        spatial: null,
        temporal: null
      },
      thresholds: { skip: SKIP_THRESHOLD }
    };
  }

  function mergeOllamaDecision(localDecision, ollamaDecision) {
    if (localDecision.hardLocalSkip === true || localDecision.hardAiSynthetic === true) {
      const aiWritingDecision = normalizeAiWritingDecision(ollamaDecision, localDecision.platform);
      return {
        ...localDecision,
        score: 100,
        recommendation: "skip",
        ollamaUsed: localDecision.platform === "linkedin" && ollamaDecision?.available === true,
        ollamaStatus: localDecision.platform === "linkedin" && ollamaDecision?.available === true
          ? "available"
          : localDecision.hardAiSynthetic === true ? "bypassed_hard_ai" : "bypassed_hard_preference",
        aiWritingDecision,
        aiWritingLikely: aiWritingDecision?.verdict === "likely_ai"
          && aiWritingDecision.confidence >= 0.8
      };
    }

    if (!ollamaDecision || ollamaDecision.available !== true) {
      return {
        ...localDecision,
        recommendation: "watch",
        ollamaUsed: false,
        ollamaStatus: ollamaDecision?.status || "unavailable"
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(ollamaDecision.confidence) || 0));
    const verdict = ollamaDecision.verdict === "skip" ? "skip" : "dont_skip";
    const heuristicScore = Number(localDecision.sourceScores?.heuristic) || 0;
    const category = cleanText(ollamaDecision.category, 40);
    const aiWritingDecision = normalizeAiWritingDecision(ollamaDecision, localDecision.platform);
    const ollamaSlopCategories = SLOP_PREFERENCE_API?.categoriesForOllama(category) || [];
    const slopCategories = [...new Set([...(localDecision.slopCategories || []), ...ollamaSlopCategories])];
    const matchedSlopPreferences = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.selectedMatches(localDecision.selectedSlopPreferences, slopCategories)
      : [...slopCategories];
    const preferenceGuardedSkip = verdict === "skip" && matchedSlopPreferences.length === 0;
    const categoryInconsistent = verdict === "skip"
      && (["educational", "original", "ordinary"].includes(category) || ollamaDecision.categoryConsistent === false);
    const rawModelReason = cleanText(ollamaDecision.reason, 180) || (verdict === "skip" ? "Local transcript model detected slop" : "Local transcript model protected this item");
    const modelReason = categoryInconsistent
      ? "Ollama Skip supported by independent slop evidence"
      : rawModelReason;
    const modelAcknowledgedEducation = EDUCATIONAL_PATTERN.test(normalize(modelReason));
    const insufficientEvidenceForInconsistentCategory = categoryInconsistent
      && Number(localDecision.strongEvidenceCount || 0) < 1
      && heuristicScore < 15;
    const guardedEducationalSkip = verdict === "skip"
      && (localDecision.educationalProtected === true
        || modelAcknowledgedEducation
        || insufficientEvidenceForInconsistentCategory)
      && localDecision.hardStackedFormat !== true
      && Number(localDecision.strongEvidenceCount || 0) < 2
      && heuristicScore < 55;
    const preferredFormatGuardedSkip = verdict === "skip"
      && localDecision.preferredFormatProtected === true
      && !["scam", "engagement_bait", "ragebait", "viral_challenge"].includes(category)
      && localDecision.hardStackedFormat !== true
      && Number(localDecision.strongEvidenceCount || 0) < 2;
    const effectiveVerdict = guardedEducationalSkip || preferredFormatGuardedSkip || preferenceGuardedSkip ? "dont_skip" : verdict;
    const recommendation = effectiveVerdict === "skip" ? "skip" : "watch";
    const score = effectiveVerdict === "skip"
      ? Math.max(SKIP_THRESHOLD, Math.round(72 + confidence * 28))
      : Math.min(localDecision.score, Math.round((1 - confidence) * 44));

    const reason = preferenceGuardedSkip
      ? "This format is allowed by your feed choices"
      : preferredFormatGuardedSkip
        ? "Preferred core/stream/creator-persona format retained"
      : guardedEducationalSkip
      ? "Educational context retained: Ollama Skip lacked independent slop evidence"
      : modelReason;
    const resolvedLocalReasons = (localDecision.reasons || []).filter((item) => !/awaiting ollama verdict/i.test(item));
    return {
      ...localDecision,
      score,
      recommendation,
      reasons: [reason, ...resolvedLocalReasons].slice(0, 4),
      ollamaUsed: true,
      ollamaStatus: "available",
      slopCategories,
      matchedSlopPreferences,
      ollamaDecision: {
        verdict,
        rawVerdict: cleanText(ollamaDecision.rawVerdict, 20) || verdict,
        category,
        categoryConsistent: ollamaDecision.categoryConsistent !== false,
        effectiveVerdict,
        confidence,
        reason: modelReason,
        educationalGuardApplied: guardedEducationalSkip,
        preferredFormatGuardApplied: preferredFormatGuardedSkip,
        preferenceGuardApplied: preferenceGuardedSkip,
        slopCategories: ollamaSlopCategories
      },
      aiWritingDecision,
      aiWritingLikely: aiWritingDecision?.verdict === "likely_ai"
        && aiWritingDecision.confidence >= 0.8,
      sourceScores: {
        ...localDecision.sourceScores,
        ollama: guardedEducationalSkip || preferenceGuardedSkip ? 0 : Math.round(confidence * 100) * (verdict === "skip" ? 1 : -1),
        ollamaRaw: Math.round(confidence * 100) * (verdict === "skip" ? 1 : -1)
      }
    };
  }

  function normalizeAiWritingDecision(value, platform) {
    if (platform !== "linkedin") return null;
    const verdict = ["likely_ai", "likely_human", "uncertain"].includes(value?.writingVerdict)
      ? value.writingVerdict
      : "uncertain";
    const confidence = clampProbability(value?.writingConfidence);
    return {
      verdict,
      confidence,
      reason: cleanText(value?.writingReason, 240)
        || "Writing-origin signals are inconclusive and are not proof of authorship.",
      advisoryOnly: true
    };
  }

  function mergeDetectorDecision(textDecision, detectorDecision) {
    const status = cleanText(detectorDecision?.status, 40) || "unavailable";
    const detectorSlopCategories = detectorDecision?.synthetic === true
      ? [
        "fully_ai_generated_video",
        ...(textDecision.aiDisclosureDetected === true ? [] : ["misleading_synthetic_media"])
      ]
      : [];
    const slopCategories = [...new Set([...(textDecision.slopCategories || []), ...detectorSlopCategories])];
    const matchedSlopPreferences = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.selectedMatches(textDecision.selectedSlopPreferences, slopCategories)
      : [...slopCategories];
    const detectorPreferenceSelected = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.includesAny(textDecision.selectedSlopPreferences, detectorSlopCategories)
      : detectorSlopCategories.length > 0;
    const routingMetadata = {
      executionPath: cleanText(detectorDecision?.executionPath, 80),
      cloudHeavyStatus: cleanText(detectorDecision?.cloudHeavyStatus, 40),
      decisionOwner: cleanText(detectorDecision?.decisionOwner, 40),
      decisionLocked: detectorDecision?.decisionLocked === true,
      heavyEscalated: detectorDecision?.heavyEscalated === true,
      heavyEscalationReason: cleanText(detectorDecision?.heavyEscalationReason, 120),
      fastStageStatus: cleanText(detectorDecision?.fastStageStatus, 40),
      latency: detectorDecision?.latency || null
    };
    if (status === "provisional") {
      const lightweightProbability = detectorDecision?.lightweight?.available === true
        ? clampProbability(detectorDecision.lightweight.ai_probability)
        : null;
      const detectorScore = clampScore(detectorDecision.score);
      const sourceScores = {
        ...textDecision.sourceScores,
        lightweight: lightweightProbability === null ? null : Math.round(lightweightProbability * 100)
      };
      const provisionalReason = detectorDecision.synthetic === true
        ? "Possible synthetic media detected; waiting for independent heavyweight verification"
        : cleanText(detectorDecision.reason, 180) || "Lightweight scan complete; heavyweight verification is running";
      return {
        ...textDecision,
        detectorUsed: true,
        detectorStatus: "provisional",
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          decisionId: cleanText(detectorDecision.decisionId, 80),
          ...routingMetadata,
          score: detectorScore,
          reason: provisionalReason,
          provisional: true,
          wouldSkip: detectorDecision.synthetic === true && detectorPreferenceSelected,
          automaticSkipEligible: false
        },
        sourceScores
      };
    }
    if (status !== "ready") {
      return {
        ...textDecision,
        detectorUsed: false,
        detectorStatus: status,
        detectorError: cleanText(detectorDecision?.error, 240),
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          ...routingMetadata,
          status,
          error: cleanText(detectorDecision?.error, 240),
          automaticSkipEligible: false
        }
      };
    }

    const spatialProbability = detectorDecision?.spatial?.available === true
      ? clampProbability(detectorDecision.spatial.ai_probability)
      : null;
    const temporalProbability = detectorDecision?.temporal?.available === true
      ? clampProbability(detectorDecision.temporal.fake_probability)
      : null;
    const spatialFamilyProbability = Number.isFinite(Number(detectorDecision?.spatialFamilyProbability))
      ? clampProbability(detectorDecision.spatialFamilyProbability)
      : null;
    const motionProbability = Number.isFinite(Number(detectorDecision?.motionProbability))
      ? clampProbability(detectorDecision.motionProbability)
      : null;
    const avJoint = detectorDecision?.avJoint || detectorDecision?.temporal?.av_joint || null;
    const avJointProbability = avJoint?.available === true && avJoint?.state === "ready"
      ? clampProbability(avJoint.jointForgeryProbability)
      : null;
    const detectorScore = clampScore(detectorDecision.score);
    const sourceScores = {
      ...textDecision.sourceScores,
      spatial: spatialFamilyProbability !== null ? Math.round(spatialFamilyProbability * 100)
        : spatialProbability === null ? null : Math.round(spatialProbability * 100),
      temporal: motionProbability !== null ? Math.round(motionProbability * 100)
        : temporalProbability === null ? null : Math.round(temporalProbability * 100),
      avJoint: avJointProbability === null ? null : Math.round(avJointProbability * 100),
      avSync: avJoint?.available === true ? Math.round(clampProbability(avJoint.syncMismatchProbability) * 100) : null,
      avAudio: avJoint?.available === true ? Math.round(clampProbability(avJoint.audioSpoofProbability) * 100) : null,
      avVisual: avJoint?.available === true ? Math.round(clampProbability(avJoint.visualForgeryProbability) * 100) : null
    };
    const automaticSkipEligible = detectorDecision?.automaticSkipEligible === true
      && detectorPreferenceSelected;
    const fastSingleFrameOnly = detectorDecision?.performanceProfile === "fast"
      || (detectorDecision?.spatial?.status === "disabled_fast_mode"
        && detectorDecision?.temporal?.status === "disabled_fast_mode");
    if (detectorDecision.synthetic === true
      && automaticSkipEligible
      && fastSingleFrameOnly
      && textDecision.educationalProtected === true) {
      const reason = cleanText(detectorDecision.reason, 180) || "Fast visual detector found a possible synthetic frame";
      return {
        ...textDecision,
        detectorUsed: true,
        detectorStatus: "shadow",
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          decisionId: cleanText(detectorDecision.decisionId, 80),
          ...routingMetadata,
          score: detectorScore,
          reason: `${reason}; academic-content guard requires corroboration`,
          consensus: { policyVersion: 5, basis: "educational_fast_guard" },
          wouldSkip: true,
          automaticSkipEligible: false,
          rolloutMode: "safety_hold"
        },
        sourceScores
      };
    }
    if (detectorDecision.synthetic === true && !detectorPreferenceSelected) {
      const reason = cleanText(detectorDecision.reason, 180) || "Synthetic-media signals were detected";
      return {
        ...textDecision,
        detectorUsed: true,
        detectorStatus: "available",
        visualAiSynthetic: true,
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          decisionId: cleanText(detectorDecision.decisionId, 80),
          ...routingMetadata,
          score: detectorScore,
          reason: `${reason}; your feed choices keep this format visible`,
          consensus: detectorDecision.consensus || detectorDecision.consensusBasis || null,
          modelBundleVersion: cleanText(detectorDecision.modelBundleVersion, 100),
          componentSpatialScores: detectorDecision.componentSpatialScores || null,
          motionProbability,
          avJoint,
          wouldSkip: false,
          automaticSkipEligible: false,
          rolloutMode: "preference_allow"
        },
        sourceScores
      };
    }
    if (detectorDecision.synthetic === true && automaticSkipEligible) {
      const reason = cleanText(detectorDecision.reason, 180) || "Spatiotemporal detector found synthetic media";
      return {
        ...textDecision,
        score: 100,
        recommendation: "skip",
        reasons: [reason, ...textDecision.reasons].slice(0, 4),
        confidence: "high",
        hardAiSynthetic: true,
        visualAiSynthetic: true,
        detectorUsed: true,
        detectorStatus: "available",
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          decisionId: cleanText(detectorDecision.decisionId, 80),
          ...routingMetadata,
          score: detectorScore,
          reason,
          consensus: detectorDecision.consensus || detectorDecision.consensusBasis || null,
          modelBundleVersion: cleanText(detectorDecision.modelBundleVersion, 100),
          componentSpatialScores: detectorDecision.componentSpatialScores || null,
          motionProbability,
          avJoint,
          automaticSkipEligible: true,
          rolloutMode: cleanText(detectorDecision.rolloutMode, 40) || "corroborated"
        },
        sourceScores
      };
    }
    if (detectorDecision.synthetic === true) {
      const reason = cleanText(detectorDecision.reason, 180) || "Spatiotemporal detector found synthetic media";
      return {
        ...textDecision,
        detectorUsed: true,
        detectorStatus: "shadow",
        visualAiSynthetic: true,
        slopCategories,
        matchedSlopPreferences,
        detectorDecision: {
          decisionId: cleanText(detectorDecision.decisionId, 80),
          ...routingMetadata,
          score: detectorScore,
          reason: `${reason}; shadow mode kept this video visible`,
          consensus: detectorDecision.consensus || detectorDecision.consensusBasis || null,
          modelBundleVersion: cleanText(detectorDecision.modelBundleVersion, 100),
          componentSpatialScores: detectorDecision.componentSpatialScores || null,
          motionProbability,
          avJoint,
          wouldSkip: true,
          automaticSkipEligible: false,
          rolloutMode: cleanText(detectorDecision.rolloutMode, 40) || "shadow"
        },
        sourceScores
      };
    }
    return {
      ...textDecision,
      detectorUsed: true,
      detectorStatus: "available",
      slopCategories,
      matchedSlopPreferences,
      detectorDecision: {
        decisionId: cleanText(detectorDecision.decisionId, 80),
        ...routingMetadata,
        score: detectorScore,
        reason: cleanText(detectorDecision.reason, 180) || "No strong synthetic-media signal",
        consensus: detectorDecision.consensus || detectorDecision.consensusBasis || null,
        modelBundleVersion: cleanText(detectorDecision.modelBundleVersion, 100),
        componentSpatialScores: detectorDecision.componentSpatialScores || null,
        motionProbability,
        avJoint
      },
      sourceScores
    };
  }

  function mergeFactCheckDecision(decision, factDecision) {
    const status = cleanText(factDecision?.status, 40) || "unavailable";
    if (status !== "ready") {
      return {
        ...decision,
        factCheckUsed: false,
        factCheckStatus: status,
        factCheckError: cleanText(factDecision?.error, 240),
        hardFactContradiction: false
      };
    }

    const verdict = ["supported", "contradicted", "mixed", "insufficient"].includes(factDecision?.verdict)
      ? factDecision.verdict
      : "insufficient";
    const confidence = clampProbability(factDecision?.confidence);
    const trustedSourceCount = Math.max(0, Math.min(20, Number(factDecision?.trustedSourceCount) || 0));
    const sources = Array.isArray(factDecision?.sources)
      ? factDecision.sources.map(normalizeFactSource).filter(Boolean).slice(0, 12)
      : [];
    const summary = cleanText(factDecision?.summary, 360) || "Source verification did not reach a conclusive result";
    const claim = cleanText(factDecision?.claim, 320);
    const factSlopCategories = verdict === "contradicted"
      ? ["fake_stories", ...(decision.visualAiSynthetic === true ? ["misleading_synthetic_media"] : [])]
      : [];
    const slopCategories = [...new Set([...(decision.slopCategories || []), ...factSlopCategories])];
    const matchedSlopPreferences = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.selectedMatches(decision.selectedSlopPreferences, slopCategories)
      : [...slopCategories];
    const factPreferenceSelected = SLOP_PREFERENCE_API
      ? SLOP_PREFERENCE_API.includesAny(decision.selectedSlopPreferences, factSlopCategories)
      : factSlopCategories.length > 0;
    const automaticSkipRequested = factDecision?.automaticSkip === true
      && verdict === "contradicted"
      && confidence >= 0.88
      && trustedSourceCount >= 2;
    const automaticSkip = automaticSkipRequested && factPreferenceSelected;
    const factCheckDecision = {
      verdict,
      confidence,
      trustedSourceCount,
      automaticSkip,
      wouldAutoSkip: automaticSkipRequested,
      preferenceAllowed: automaticSkipRequested && !automaticSkip,
      claim,
      summary,
      sources,
      imageText: cleanText(factDecision?.imageText, 1800),
      imageOcrStatus: cleanText(factDecision?.imageOcrStatus, 40),
      checkedAt: cleanText(factDecision?.checkedAt, 80)
    };

    if (automaticSkip) {
      return {
        ...decision,
        score: 100,
        recommendation: "skip",
        reasons: [`Fact check: ${summary}`, ...decision.reasons].slice(0, 4),
        confidence: "high",
        factCheckUsed: true,
        factCheckStatus: "available",
        hardFactContradiction: true,
        slopCategories,
        matchedSlopPreferences,
        factCheckDecision,
        sourceScores: {
          ...decision.sourceScores,
          factCheck: 100
        }
      };
    }

    return {
      ...decision,
      factCheckUsed: true,
      factCheckStatus: "available",
      hardFactContradiction: false,
      slopCategories,
      matchedSlopPreferences,
      factCheckDecision,
      sourceScores: {
        ...decision.sourceScores,
        factCheck: verdict === "supported"
          ? -Math.round(confidence * 100)
          : verdict === "contradicted" ? Math.round(confidence * 100) : 0
      }
    };
  }

  function normalizeFactSource(value) {
    if (!value || typeof value !== "object") return null;
    let url;
    try {
      url = new URL(String(value.url || ""));
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    return {
      title: cleanText(value.title, 240) || url.hostname,
      url: url.href.slice(0, 2000),
      domain: cleanText(value.domain || url.hostname, 255),
      publisher: cleanText(value.publisher, 120),
      rating: cleanText(value.rating, 120),
      authority: cleanText(value.authority, 40),
      trusted: value.trusted === true
    };
  }

  function parsePlatformUrl(input, platformHint = "", itemIdHint = "") {
    const raw = String(input || "").trim();
    let url;
    try {
      url = new URL(raw || "https://invalid.local/");
    } catch {
      url = new URL("https://invalid.local/");
    }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    let platform = normalizePlatform(platformHint);
    let itemId = cleanId(itemIdHint);
    let itemKind = "video";

    if (!platform && (host.endsWith("youtube.com") || host === "youtu.be")) platform = "youtube";
    if (!platform && host.endsWith("instagram.com")) platform = "instagram";
    if (!platform && host.endsWith("tiktok.com")) platform = "tiktok";
    if (!platform && host.endsWith("linkedin.com")) platform = "linkedin";

    if (platform === "youtube") {
      const shortId = parts[0] === "shorts" ? cleanId(parts[1]) : null;
      itemId = itemId || shortId || cleanId(url.searchParams.get("v")) || (host === "youtu.be" ? cleanId(parts[0]) : null);
      itemKind = shortId ? "short" : "video";
    } else if (platform === "instagram") {
      const marker = ["reel", "reels", "p"].includes(parts[0]) ? parts[0] : "";
      itemId = itemId || (marker ? cleanId(parts[1]) : null);
      itemKind = marker === "p" ? "post" : "short";
    } else if (platform === "tiktok") {
      const videoIndex = parts.indexOf("video");
      itemId = itemId || (videoIndex >= 0 ? cleanId(parts[videoIndex + 1]) : null);
      itemKind = "short";
    } else if (platform === "linkedin") {
      const activityMatch = url.pathname.match(/\/feed\/update\/urn:li:activity:([^/?#]+)/i);
      const profileIndex = parts.findIndex((part) => part === "in" || part === "company");
      const postIndex = parts.indexOf("posts");
      const pulseIndex = parts.indexOf("pulse");
      itemId = itemId
        || cleanId(activityMatch?.[1])
        || (postIndex >= 0 ? cleanId(parts[postIndex + 1]) : null)
        || (pulseIndex >= 0 ? cleanId(parts[pulseIndex + 1]) : null)
        || (profileIndex >= 0 ? cleanId(parts[profileIndex + 1]) : null);
      itemKind = profileIndex >= 0 && postIndex < 0 ? "profile" : "post";
    }

    return {
      platform: platform || "unknown",
      itemId,
      itemKind,
      normalizedUrl: platform && itemId ? raw : raw || null
    };
  }

  function runMetadataModel(input) {
    if (!AI_MODEL_AVAILABLE) {
      return { available: false, modelId: "orislop-ai-classifier-v1", score: 0, probability: 0, topFeatures: [] };
    }
    const tokens = normalize([input.title, input.description, input.channelName].join(" ")).match(/[a-z0-9][a-z0-9_'-]*/g) || [];
    const filtered = tokens.filter((token) => token.length > 1 && !AI_STOP_WORDS.has(token));
    const terms = [...filtered, ...filtered.slice(0, -1).map((token, index) => `${token}_${filtered[index + 1]}`)];
    terms.push(input.isShort ? "__short__" : "__watch__");
    if (input.durationSeconds > 0 && input.durationSeconds <= 75) terms.push("__duration_short__");
    const counts = new Map();
    for (const term of terms) {
      if (AI_FEATURE_MAP.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
    }
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0) || 1;
    const weighted = Array.from(counts, ([term, count]) => {
      const feature = AI_FEATURE_MAP.get(term);
      return { term, value: (count / total) * feature.idf, weight: feature.weight };
    });
    const norm = Math.sqrt(weighted.reduce((sum, feature) => sum + feature.value * feature.value, 0)) || 1;
    const contributions = weighted.map((feature) => ({ term: feature.term, contribution: (feature.value * feature.weight) / norm }));
    const probability = sigmoid(AI_MODEL_INTERCEPT + contributions.reduce((sum, feature) => sum + feature.contribution, 0));
    return {
      available: true,
      modelId: AI_MODEL?.modelId || "orislop-ai-classifier-v1",
      probability,
      score: Math.round(probability * 100),
      topFeatures: contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 4)
    };
  }

  function protectedFormatKind(flags) {
    if (flags.coreFormatProtected) return "core";
    if (flags.streamClipProtected) return "stream_clip";
    if (flags.creatorPersonaProtected) return "creator_persona";
    return "";
  }

  function normalizePlatform(value) {
    const normalized = String(value || "").toLowerCase();
    return ["youtube", "instagram", "tiktok", "linkedin"].includes(normalized) ? normalized : "";
  }

  function cleanId(value) {
    const id = String(value || "").trim();
    return /^[a-zA-Z0-9_.-]{3,160}$/.test(id) ? id : null;
  }

  function cleanText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function emojiCount(value) {
    return Array.from(value).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
  }

  function isMusicContext(text) {
    return /\b(song|lyrics|music|track|cover|remix|karaoke|performance)\b/.test(text);
  }

  function sigmoid(value) {
    if (value >= 0) {
      const z = Math.exp(-value);
      return 1 / (1 + z);
    }
    const z = Math.exp(value);
    return z / (1 + z);
  }

  function clampProbability(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  globalThis.OrislopClassifier = Object.freeze({
    mergeFactCheckDecision,
    mergeDetectorDecision,
    mergeOllamaDecision,
    parsePlatformUrl,
    scoreCandidate
  });
})();
