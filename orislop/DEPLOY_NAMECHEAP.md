# Deploy Orislop Static MVP To Namecheap

This deploy path is for the static browser prototype only. It does not run Electron, Python, PyTorch, local checkpoints, a backend server, or secret API keys.

## Build

1. Run `pnpm install`.
2. Run `pnpm run web:build`.
3. Run `pnpm run web:deploy:zip`.
4. Run `pnpm run release:verify`.
5. Confirm the ZIP exists at `dist/orislop-namecheap-static.zip`.

Do not upload old browser-renamed files such as `orislop-namecheap-static(1).zip` or `orislop-namecheap-static(2).zip`.
The production build includes `release-info.json` with release ID `orislop-shield-web-1.3.0-2026-08-18`.

## Upload With cPanel File Manager

1. Log into Namecheap cPanel.
2. Open File Manager.
3. Open `public_html`.
4. Upload `dist/orislop-namecheap-static.zip`.
5. Extract it inside `public_html`.
6. Confirm `index.html` is directly inside `public_html`.
7. Confirm `privacy.html` and `release-info.json` are also directly inside `public_html`.
8. Visit the domain, for example `https://orislop.com`.

The ZIP is built so its contents go directly inside `public_html`. It should not create an extra nested `dist` or `apps/web/dist` folder.

## Troubleshooting

- Blank page: the files may have been extracted into a nested folder. Move `index.html` and the `assets` folder directly into `public_html`.
- Missing `index.html`: rebuild with `pnpm run web:build`, then recreate the ZIP with `pnpm run web:deploy:zip`.
- Old files still cached: clear the browser cache or test in a private window.
- Old site files conflict: delete old static files in `public_html` before extracting the new ZIP.
- Stale build: open `/release-info.json` on the domain and confirm `releaseId` is `orislop-shield-web-1.3.0-2026-08-18`.
- Domain not loading: confirm the domain DNS points to the Namecheap hosting account.
- HTTPS warning: SSL setup can take time after DNS or hosting changes.
- Assets 404: the Vite base path is `./`; confirm the uploaded `assets` folder sits next to `index.html`.

## Local Preview

Run `pnpm run web:preview` after building. Open the printed local URL in a normal browser.
Avoid opening `index.html` directly with `file://`; module loading and browser storage behavior can differ from real hosting.

## What This Static Build Includes

- Homepage explaining Orislop.
- YouTube URL parser for watch links, short links, and Shorts links.
- Official YouTube iframe embed preview.
- Browser-safe static slop scoring for URL, title, and caption text.
- Orislop AI Classifier v1 local TF-IDF/logistic metadata scoring.
- Combined source breakdown for heuristic, AI classifier, optional transcript, channel risk, and spatiotemporal status.
- Watch, Questionable, and Skip recommendations with reasons.
- Clean feed demo that scans the next 10 queued videos and hides Skip results from the visible feed.
- Local flagged-video log for videos Orislop questioned or hid.
- Downloadable browser extension ZIP at `downloads/orislop-browser-extension.zip`.
- Accurate/Wrong feedback saved in local browser storage.
- Basic settings saved in local browser storage.
- Optional local video frame-sampling demo labeled as a lightweight browser prototype.

## What This Static Build Does Not Include

- Full PyTorch temporal detector inference.
- Full spatial detector inference.
- Electron runtime.
- Python backend.
- YouTube API calls.
- Secret API keys.
- YouTube scraping or video downloads.
- Raw model checkpoints or private data.

## Browser Extension Download

The public website includes a download button for `downloads/orislop-browser-extension.zip`.
Visitors can unzip it and load it through Chrome or Edge Developer mode with `Load unpacked`.
This is useful for local testing; publishing through the Chrome Web Store would require a separate review process.
