# KnowDrive Corpus Unfurl (demo)

Paste one link into iMessage, WhatsApp or Signal. It unfurls as a KnowDrive search box for one of your stores. Tap it and you can search that store's atoms and files by text, voice, image or audio. Any result can be shared back into the chat as its own link, and that link unfurls too.

| Page | What it is |
| --- | --- |
| [`dashboard.html`](https://demos.knowdrive.ai/unfurl/dashboard.html) | The "Unfurl links" screen in the KnowDrive dashboard. Pick a store, scope it to tags, choose what the link allows (atoms, files, snippets, open files, sharing, image/audio search), set an expiry, and preview the unfurl in iMessage, WhatsApp and Signal. You can also revoke links here. |
| [`index.html?l=<link>`](https://demos.knowdrive.ai/unfurl/?l=pr-ca-7qx2) | The page the unfurl opens. It has the branded multimodal search box and Atoms/Files results, with Share, Copy quote and Open in file on each result. |
| [`share.html?l=<link>&a=<atom>`](https://demos.knowdrive.ai/unfurl/share.html?l=pr-ca-7qx2&a=file-EkhAVdCyuwOgqHnwlg5VpI9b%3A1506) | A shared result: the quote, where it came from, and buttons to share it back or search the same store. |
| `og-*.png` | The unfurl images, rendered from `og/card.html` (`NODE_PATH=$(npm root -g) node og/render.js`). |
| `worker/` | Reference Cloudflare Worker for production: per-link OG tags, a server-held scoped token, and entitlement-enforced search proxying. |

Demo links: `pr-ca-7qx2` (whole store, all permissions) and `ethi-ai-k3m9` (ETHI committee only, atoms and snippets only, no files, no media).

## How the demo runs

GitHub Pages only serves static files, so the demo searches a **snapshot**: 18 real atoms from the public KnowDrive store *Canada · Public Record* (`vs_6164dda13277488abf2b8c7414f43c23`), ranked in the browser. Links you create in the dashboard are saved in your browser. Their settings are packed into a short `#c=` fragment so the link also opens on your phone.

## Production design

Chat apps build previews from `og:*` meta tags and their crawlers don't run JavaScript. The KnowDrive API also doesn't allow browser CORS. So production needs a small server in front: `worker/unfurl-worker.js`.

1. **Create link** (dashboard backend) mints a read-only, store-scoped token (`POST /-/apitokens/mint`, `aud` = store) and saves `link id → {store, scope, entitlements, limits, token}`. The URL contains only the opaque id (`https://kd.link/u/pr-ca-7qx2`).
2. **Unfurl**: `GET /u/:link` serves the search page with that store's `og:title`/`og:description`/`og:image` written into the HTML. `GET /u/:link/a/:file:seq` writes the atom's own snippet into the preview, so a pasted-back result unfurls as the quote.
3. **Search**: `GET /u/:link/search?q=` → `GET /api/v1/vector_stores/{id}/search` (hybrid, `tags_all` = scope, `fields` projection). `POST` multipart → `POST /api/v1/search` with `X-Vector-Store-Id` and `search_field=vision|audio`. The worker enforces scope, the result cap, snippet stripping and media permissions. The browser never sees the token.
4. **Revoke** marks the link revoked and calls `/-/apitokens/revoke`. Every copy of the link, including forwarded ones, then shows "Link revoked".

To switch the pages from the snapshot to the live store, deploy the worker (`worker/wrangler.toml`). It injects `KD_LIVE_PROXY`/`KD_LINK` into the same static pages, so they need no changes.

### Limits worth knowing

- iMessage, WhatsApp and Signal only show a **preview card** (image, title, description). None of them can show an interactive text box inside the chat bubble. So the unfurl is designed to *look* like the search box, and tapping it opens the real one in the in-app browser. The only way to get a live box inside the bubble is an iMessage App Extension (iOS only), which would be a separate build.
- Signal builds previews on the **sender's** device, and only if the sender has link previews turned on. Expect a bare link in some Signal chats.
- WhatsApp caches previews per URL. Each result link is unique, so this mostly matters when you change a store's card art.
