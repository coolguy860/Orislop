# OriSlop LinkedIn protection

OriSlop 1.1 adds LinkedIn posts and profiles to the browser extension. The LinkedIn experience is annotation-first: it adds a reversible trust label and explanation panel to a post or profile, but it does not automatically hide professional content.

## What is checked

- Post and profile text is screened for source-checkable factual and professional claims.
- High-confidence writing-style signals can produce a **Likely AI-written** advisory label.
- Post images are checked as still images. Text in LinkedIn-hosted images is read with bounded OCR and included in the source-checking job.
- Claims can resolve to **supported**, **contradicted**, **mixed**, or **insufficient**. Contradiction requires evidence about the same claim; automatic false-content decisions retain the existing two-independent-trusted-source and 0.88 confidence gates.
- The explanation panel can summarize a post or profile, show uncertainty and trusted sources, and host follow-up chat grounded in the visible content and supplied evidence.

## Video boundary

LinkedIn feed video previews are commonly a single poster frame plus a small amount of post text. That is not enough evidence to label a whole video AI-generated.

1. The scanner may queue up to the next 100 loaded LinkedIn items.
2. An unopened video receives `deferred_until_open` and the visible label **Video check on open**.
3. Playing the video marks that stable item ID as opened, invalidates the deferred result, and runs the normal OriSlop spatial, temporal, motion, and optional audio/visual pipeline.
4. A still image remains eligible for still-image detection, but that result is never presented as a video verdict.

The limit is 100 already-loaded LinkedIn items. OriSlop does not auto-scroll LinkedIn or manufacture engagement in order to force more items into the DOM.

## “Is this person lying?”

OriSlop does not infer intent. A false statement, stale profile, typo, exaggeration, and deliberate lie can look identical to a browser extension.

For that reason, profile checks use claim-level language:

- **Claims supported**
- **Claim contradicted**
- **Mixed evidence**
- **Unverified / insufficient evidence**

The chatbot follows the same rule. It can explain which claim was checked, what the cited sources say, and what remains unsupported; it must not diagnose deception or invent evidence.

## AI-writing interpretation

AI-writing classification is a style estimate, not authorship proof. The context model must use `uncertain` for merely polished, formal, concise, grammatical, or non-native writing. A **Likely AI-written** label requires at least 0.80 model confidence and multiple concrete templating signals. It does not by itself hide a post or mark a claim false.

## Image-text claim flow

1. The extension collects meaningful image alt text and the bounded LinkedIn image URL.
2. The companion accepts only HTTPS images hosted on `*.licdn.com`, checks redirects and content type, and reads at most 8 MB.
3. Tesseract OCR extracts at most 1,800 normalized characters.
4. OCR text is treated as untrusted quoted content and is included in claim extraction.
5. Source-backed adjudication applies the same relevance, polarity, confidence, and independent-domain guards used for video claims.

OCR can misread text. The UI exposes OCR provenance and uncertainty; it does not treat OCR as independent evidence that a claim is true.

## Cloud and privacy

- LinkedIn text, image text, and media metadata follow the existing local/hybrid settings.
- Cloud Heavy receives LinkedIn video media only after the user opens or plays that video.
- Ordinary temporary media follows the existing 60-second deletion contract.
- OCR accepts only allowlisted LinkedIn CDN images.
- OriSlop never stores a claim that a person “lied”; it stores the checked claim, verdict, confidence, sources, and uncertainty.
