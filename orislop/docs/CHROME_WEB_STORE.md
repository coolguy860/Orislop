# Chrome Web Store release guide

## Build the upload file

```powershell
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 run extension:test
corepack pnpm@11.9.0 run extension:zip
```

Upload `dist/orislop-browser-extension-webstore.zip`. The package contains extension files at the archive root, uses Manifest V3, and the build stops if `manifest.json` contains the Web Store-forbidden `key` field. Do not upload the repository ZIP or the `apps/extension/dist` parent directory.

## Suggested listing

- Name: **Orislop Shield**
- Summary: **Clean up repetitive, synthetic, and low-value feed content while useful and uncertain posts stay visible.**
- Category: **Productivity**
- Language: **English**
- Homepage: `https://orislop.com`
- Privacy policy: `https://orislop.com/privacy`

Description:

> Orislop Shield helps you reclaim YouTube, Instagram, TikTok, and LinkedIn. Choose what you want to hide in plain language, let fast checks run ahead of your scroll, and inspect or undo every decision. Useful and uncertain content stays visible. Local mode keeps deeper analysis on your computer; optional cloud protection is enabled only after a clear disclosure and sign-in. LinkedIn is annotation-first and is never automatically hidden.

## Permission disclosure

- `storage`: saves protection choices and recent activity in the browser profile.
- `identity`: opens the optional Google sign-in flow for Cloud Heavy. Local protection works without sign-in.
- Supported-site access: reads only the supported feed surfaces needed to label or hide items.
- `api.orislop.com`: used only after cloud disclosure and sign-in.
- `127.0.0.1` and `localhost`: talks to the optional Orislop Companion running on the user's own computer.

The extension does not sell data, embed analytics, collect private messages, or receive the user's site cookies. Store privacy answers and the public privacy page must match `apps/web/dist/privacy.html` at the submitted commit.

## Submission checks

1. Use the images in `assets/chrome-web-store` and verify their dimensions in `ASSET_MANIFEST.json`.
2. Test a fresh install, upgrade, pause/resume, filter setup, reveal/undo, and offline fallback in stable Chrome.
3. Confirm the toolbar icon, popup version `1.3.0`, homepage, privacy URL, and support contact.
4. If Cloud Heavy is included, build with the production Google OAuth client ID and register the final 32-character extension ID before upload.
5. Retain the previous approved ZIP for rollback and complete `docs/RELEASE_CHECKLIST.md`.

Store approval is still an external review. Passing the package checks means the artifact is structurally ready; it does not guarantee approval or certify the uncompleted live calibration gates.
