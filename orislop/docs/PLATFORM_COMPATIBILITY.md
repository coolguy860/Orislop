# Feed-platform compatibility

Orislop Shield 1.1 supports YouTube, Instagram, TikTok, and LinkedIn through isolated adapters. Each adapter supplies its own candidate roots, item links, caption fields, creator fields, transcript-like text, and media fallbacks.

## Instagram

Supported surfaces:

- Home-feed video posts
- `/reel/{id}` pages
- Reel cards and dialog surfaces
- `/p/{id}` posts for ordinary slop scoring; source fact checking remains limited to short-form Reel items

The adapter prefers semantic `article`, profile-link, caption, alt-text, and video fields. If Instagram changes its wrapper hierarchy, Orislop derives a bounded candidate root from the visible video instead of treating the entire page as one item.

## TikTok

Supported surfaces:

- For You/feed items
- `/@creator/video/{id}` pages
- Browse and search video cards that expose a stable video link

The adapter prefers TikTok's semantic `data-e2e` fields and falls back to the nearest bounded video container. Creator IDs and video IDs are normalized independently of tracking query parameters.

## LinkedIn

Supported surfaces:

- Home-feed posts with stable activity IDs
- Individual post pages
- `/in/{slug}` member profiles
- `/company/{slug}` company profiles
- Image posts and video posts

LinkedIn uses annotation-first trust labels. Up to the next 100 already-loaded items are checked in bounded ten-item batches. Post/profile claims and image text enter source verification; likely AI-written prose is an advisory style label. A video preview remains `deferred_until_open` and cannot receive an AI-video verdict until the user opens or plays it.

## Shared behavior

- Short-form platforms retain bounded current/nearby batches. LinkedIn considers up to 100 already-loaded items, processed in batches of 10.
- Orislop never emits scroll, wheel, keyboard-navigation, or next-video actions.
- Future Skip-rated cards are hidden; the current video gets a cover constrained to its media container.
- Instagram and TikTok control text such as Like, Follow, Share, counts, and timestamps is excluded from language and fact-check input.
- LinkedIn reaction controls and profile-avatar text are excluded from claim and OCR input.
- HTTPS CDN video sources are passed to the loopback visual bridge when exposed. Otherwise, the bridge uses the supported public page URL. If authenticated or private media cannot be acquired, visual analysis fails open while text/context scoring continues.

Platform DOMs change without notice. Every release still requires manual smoke testing in a normal signed-in browser profile.
