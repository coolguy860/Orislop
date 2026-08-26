# Chrome Web Store listing

## Product name

Orislop

## Summary

Automatically filter AI clips, reposts, engagement bait, and repetitive videos from YouTube and Shorts.

## Detailed description

Orislop is a focused YouTube cleanup extension. It starts filtering as soon as it is installed—there is no onboarding flow, no prompt to start, and no filter-building required.

Orislop scans YouTube videos and Shorts as you browse. It uses visible context plus the Orislop companion's Heavy visual pipeline to identify low-value or synthetic content before it wastes your time.

What Orislop filters:

- AI-generated or manipulated video and synthetic narration
- Reposts, clip farms, thin edits, and empty compilations
- Engagement bait, fake urgency, rankings, and copy-paste formats
- Texting stories, Reddit stories, unrelated split-screen footage, and repetitive Shorts
- Misleading get-rich-quick, passive-income, and dropshipping funnels

What stays visible:

- Tutorials, education, reporting, original analysis, art, music, comedy, and ordinary personal videos
- Videos Orislop is not confident enough to filter
- Anything you choose to reveal with the Show action

The MVP supports YouTube and YouTube Shorts only. It does not run on Instagram, TikTok, LinkedIn, or unrelated websites. The Explain video option has been removed so the in-feed experience stays simple. A filtered item shows only Show and Hide.

Full Heavy analysis requires the Orislop companion to be running on the user's device. The extension itself has no setup screens; once the companion is available, filtering begins automatically. Settings and activity remain in the user's browser profile. Orislop does not use behavioral advertising or sell user data.

## Single purpose

Orislop's single purpose is to automatically identify and filter low-value or synthetic videos from YouTube and YouTube Shorts.

## Permission justifications

### Storage

Stores the protection toggle, filter preferences, local engine status, user overrides, and recent filtered activity in the user's Chrome profile.

### YouTube hosts

Reads visible YouTube and YouTube Shorts metadata, captions, media URLs, and video containers needed to score and filter the current feed. Orislop does not request access to unrelated websites.

### googlevideo.com

Observes YouTube's video delivery requests so the local companion can analyze the same public video the user is viewing.

### 127.0.0.1 and localhost on port 4317

Connects only to the Orislop companion on the user's device. The companion brokers local context scoring and Heavy visual detection. This permission does not grant access to a remote internet host.

### webRequest

Observes YouTube media requests so Heavy analysis can receive the correct video bytes. Orislop does not block or rewrite unrelated requests.

## Privacy disclosure

- No sale or transfer of user data
- No advertising or behavioral analytics
- No remote code execution
- No collection of cookies, passwords, private messages, or general browsing history
- No access to Instagram, TikTok, LinkedIn, or unrelated websites
- Feed settings and activity stay in Chrome extension storage
- Temporary companion media is deleted after analysis
- Users can clear local Orislop data from the popup

## Store media checklist

- 128 x 128 store icon from `apps/extension/src/icons/icon128.png`
- At least one 1280 x 800 or 640 x 400 screenshot
- Recommended screenshot 1: YouTube with a filtered Short showing only Show and Hide
- Recommended screenshot 2: the compact Orislop popup showing automatic protection active
- Recommended screenshot 3: recent filtering activity
- Optional 1400 x 560 promotional tile using the Orislop orange-and-blue identity

Do not submit screenshots containing another user's account name, private recommendations, browsing history, or a Heavy-ready claim unless the companion is actually online in that screenshot.
