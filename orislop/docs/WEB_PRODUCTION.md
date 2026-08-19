# Orislop website production guide

The website is a real product surface, not a mock API client. It always gives an instant local text/metadata result and optionally adds a live Qwen context second opinion through a same-origin Vercel function. The full spatial, temporal, motion, and AV stack remains in the extension because a pasted YouTube page URL is not direct access to the video bytes.

## Vercel setup

1. Import `coolguy860/orislop` into Vercel.
2. Leave the project root at the repository root. `vercel.json` already publishes `apps/web/dist`.
3. Add these encrypted environment variables:

   - `ORISLOP_AI_API_URL`: the TLS URL of the deployed detector bridge, such as `https://api.orislop.com`.
   - `ORISLOP_WEB_API_TOKEN`: one long token also present in the bridge's `ORISLOP_API_TOKENS` list.
   - `ORISLOP_WEB_ORIGIN`: the exact public site origin, normally `https://orislop.com`.

4. On the GPU bridge set `ORISLOP_ALLOWED_WEB_ORIGINS=https://orislop.com`. Keep the published extension origin separately in `ORISLOP_ALLOWED_EXTENSION_ORIGINS`.
5. Deploy, then open `/api/status`. A healthy connected deployment returns `{"ok":true,"status":"online"}`. Missing secrets return `not_configured` without exposing any credential.

The API token is read only inside Vercel's server environment. Do not create a `VITE_`, `PUBLIC_`, or client-side copy of it. The browser calls only `/api/status` and `/api/analyze` on its current origin.

## User-visible failure behavior

- GPU service online: the result shows the instant local decision plus the live context AI opinion.
- GPU service cold or temporarily offline: the instant result remains and the page says the deeper checker is waking up.
- Rate limited: the instant result remains and the page asks the visitor to try the live check shortly.
- Invalid URL or missing context: the form explains what to add without displaying an exception, host, token, model repository, or stack trace.

## Release verification

```powershell
corepack pnpm@11.9.0 install --frozen-lockfile
corepack pnpm@11.9.0 run web:test
corepack pnpm@11.9.0 run production:check
```

After deploy, verify the home page at desktop and mobile widths, the privacy page, the extension download, `/api/status`, one live analysis, and one deliberate backend-offline fallback. YouTube embeds and thumbnails are explicitly allowed by the production CSP; other third-party frames remain blocked.

## Honest launch boundary

The Heavy cloud configuration remains shadow-only until the calibration and reviewed-shadow gates in `CLOUD_DEPLOYMENT.md` pass. Do not market website text analysis as a deepfake verdict, and do not enable automatic Heavy hides merely because the UI and infrastructure are ready.
