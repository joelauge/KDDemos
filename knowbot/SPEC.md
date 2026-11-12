# KnowBot — build contract

KnowBot = a small front-end JS library + a small, fast open-weights model + a small knowDrive store.
It behaves like a generalized professional for whatever is in the store, and **every answer cites
source files from the store**. A live dashboard shows which surface each user is chatting through
and lets an operator get KnowBot's canonical response in real time.

This file is the shared contract. Everything below is binding for all components.

## Layout (all under `knowbot/`, served statically from GitHub Pages at `demos.knowdrive.ai/knowbot/`)

```
knowbot/
  SPEC.md                 this file
  README.md               how to run (written last)
  lib/knowbot.js          ESM library, zero deps, runs in browser AND Node 22 (core: retrieval, prompt, engines, citations, surface, telemetry)
  lib/widget.js           ESM UI: floating widget + inline panel + full-page chat (imports knowbot.js)
  lib/embed.js            one-line <script> loader: reads data-* attrs, imports widget.js, mounts
  lib/knowbot.css         widget styles (scoped under .kb-root)
  demo/                   host pages exercising surfaces (storefront widget, help-center inline, full-page chat)
  dashboard/index.html    live operator dashboard (+ dashboard/*.js|css)
  server/server.mjs       Node 22 server, NO npm deps (node:http + global fetch)
  server/retrievers.mjs   knowdrive + local BM25 retrievers
  corpus/                 knowDrive seed corpus (markdown with YAML frontmatter), mirrored 1:1 into the store
  scripts/                seed-knowdrive.mjs, setup-model.sh, etc.
  eval/                   benchmark, harness, adversarial reports
```

## Model

- Server/eval engine: **Qwen2.5-1.5B-Instruct** GGUF Q4_K_M via llama.cpp `llama-server` (OpenAI-compatible) on `http://127.0.0.1:8080`.
- Browser engine (no server): WebLLM `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` loaded from `https://esm.run/@mlc-ai/web-llm@0.2.79` (pinned).
- Canonical settings: `temperature: 0`, `top_p: 1`, `max_tokens: 300`, `seed: 7`, `frequency_penalty: 0.4`.

## Corpus / store

- Store files are markdown with frontmatter:
  ```
  ---
  title: Human title
  kind: product | collection | policy | page | article | shop | guide
  source: shopify
  source_id: gid://shopify/Product/123   (when applicable)
  url: https://theultimategamemaster.com/products/handle   (public URL if one exists)
  updated: 2026-10-24
  ---
  ```
- Store path == repo path relative to `corpus/` (e.g. `catalog/products/<handle>.md`). Citations use that path as `filename`, so local and knowDrive retrieval cite identically.
- Content must come from real sources (the connected Shopify store "The Ultimate Game Master"). No invented facts.

## Server HTTP API (`server/server.mjs`, default port 8787, CORS `*`)

| Method/Path | Body | Response |
|---|---|---|
| `GET /api/config` | – | `{ store, retrieval: "knowdrive"\|"local", engine: {type:"openai", model}, canonical: {...settings} }` |
| `POST /api/search` | `{ query, k?=6 }` | `{ source, results: [{ file_id, filename, title, url, score, text }] }` (best first) |
| `POST /api/chat` | OpenAI `/v1/chat/completions` body | passthrough to `LLM_BASE_URL` (stream supported) |
| `POST /api/canonical` | `{ question, sessionId? , turnId? }` | `Answer` (below), computed with canonical settings via `knowbot.js` core |
| `POST /api/events` | `Event` or `Event[]` | `{ ok: true }` — fanned out to SSE subscribers, appended to `server/data/events.jsonl` |
| `GET /api/stream` | – | SSE; `event: knowbot` `data: <Event JSON>`; replays last 200 events on connect; `: ping` every 15s |
| `GET /api/sessions` | – | `[{ sessionId, surface, startedAt, lastAt, turns, groundedRate }]` |
| `GET /*` | – | static files from the web root only: `index.html`, `404.html`, `lib/`, `studio/`, `dashboard/`, `site/`, `vendor/`, and `demo/` with the built-in bot (no `test/` folders, no `studio/kb/`, no unknown file types); `corpus/` only with `KNOWBOT_SERVE_CORPUS=1`; everything else 404 |

Env: `PORT`, `LLM_BASE_URL` (default `http://127.0.0.1:8080/v1`), `LLM_MODEL`, `KNOWDRIVE_BASE_URL` (default `https://knowdrive.ai`), `KNOWDRIVE_API_KEY`, `KNOWDRIVE_STORE` (default `vs_97c857474b1f4e8892b134c283cf9849`, "Joel's Store" on production), `KNOWDRIVE_TAG` (default `knowbot:ugm`), `KNOWDRIVE_PREFIX` (default `knowbot/ugm/`), `KNOWDRIVE_API_KEY_FILE` (key re-read per search), `KNOWDRIVE_MIN_SIMILARITY` (relevance floor, default 0.745), `KNOWBOT_AUTH_ISSUER` + `KNOWBOT_AUTH_AUDIENCE` + `KNOWBOT_AUTH_JWKS_URL` (admin sign-in through host-manager; all three or none, default none = off). If no key → local BM25 retriever over `corpus/`. Self-hosted switches, all off by default: `KNOWBOT_LLM_THINKING=off` adds `chat_template_kwargs: {enable_thinking: false}` to every request sent to `LLM_BASE_URL` (including `/api/chat`, which otherwise allow-lists its fields; never to hosted providers or `KNOWBOT_MODELS` entries whose `baseUrl` is not `LLM_BASE_URL`); `KNOWBOT_IMPORT_ALLOW` (CIDRs, addresses, host names, `.suffix` names) admits those private targets to website import, note links and photo lookups, RFC 1918, `100.64.0.0/10` and `fc00::/7` only, checked on every hop and at the dialled address, admitted only when the start address itself is (a public site can't redirect or resolve into them), with loopback, link-local and metadata always refused. attendd takes `KNOWDRIVE_API_KEY_FILE` (re-read per call, wins over `KNOWDRIVE_API_KEY`).

**Auth behind host-manager** (`server/hmauth.mjs`; only with all three `KNOWBOT_AUTH_*` set, never in the cloud). On KnowDrive Home & Office, host-manager publishes KnowBot as a function at `/knowbot` and forwards a signed-in person with a Function Access Token (FAT) in `Authorization`. KnowBot verifies it as KnowDB does on the same box: ES256 only (any other `alg` refused before the key lookup), `kid` from the JWKS (fetched at start and every 15 min; an unknown `kid` refreshes at most every 30 s and is refused with 401 meanwhile, so the first sign-in after a new host-manager key fails once; a failed refresh keeps the last good keys), `iss` exact, `aud` contains `KNOWBOT_AUTH_AUDIENCE`, `exp` and `iat` required with 30 s leeway, lifetime at most 330 s, `sub` non-empty, no `act` (a token-exchange result), no `crit`. A valid FAT grants only when `auth_method` is `local` or `oidc` (a browser sign-in) and `entitlements` is a list of strings: `knowbot:*:admin` (or `knowbot::admin`, `knowbot:admin`, verb `all`) = admin; `knowbot:*:read` or admin = reader. Gates: admin = FAT admin, else `KNOWBOT_ADMIN_TOKEN`; reader (`/api/stream`, `/api/sessions`, `GET /api/events`, `/api/reindex`) = FAT reader, else `KNOWBOT_DASHBOARD_TOKEN`; no loopback bypass, no open reader; 401 carries `WWW-Authenticate: Bearer realm="knowbot"`, a valid FAT without the grant is 403. A write admitted by a FAT must not be cross-site (`Sec-Fetch-Site` absent, `same-origin` or `none`; `Origin`, else `Referer`, if present = the issuer's origin), must send JSON (415 otherwise) or, for an upload, name the file in `X-Filename` (`?name=` is not read), and an upload whose path already exists in the bucket, or is still being ingested by this process, is 409 (host-manager cuts requests at 60 s; a retry must not ingest twice). A request carrying `X-Kdex-Forwarded: true` or a JWT-shaped Bearer is answered only on the dashboard (`/dashboard/…`, `/lib/site-config.js`) and its API (`/api/instances|buckets|graph|providers|flows…`, `/api/stream|sessions|reindex|config|canonical`, `GET /api/events`, `POST /api/studio/trials/:id/convert`), else 404, and every such response carries a CSP with no third-party or inline script (the dashboard's own inline script is allowed by hash; the flow canvas, loaded from esm.sh, is therefore off through host-manager). A stream opened with a FAT ends at its `exp` + 30 s. Startup refuses a partial `KNOWBOT_AUTH_*`, a JWKS URL that is not `https:` or loopback `http:`, and a missing `KNOWBOT_SECRET_KEY` + `KNOWBOT_ADMIN_TOKEN`; a background check logs one line if `KNOWBOT_SECRET_KEY` does not open the stored provider keys or `kb_live_` keys (a knowDrive failure while reading them is logged as such, not blamed on the secret). With the switch on, `npm start` binds 127.0.0.1 unless `HOST` is set. One log line per allowed write (actor, method, path) and per FAT denial (`sub`, reason); never a token, claim set or cookie.

Appliance switches (all off by default; README "On an appliance"):
- `KNOWBOT_BUILTIN_BOT=off`: the registry has no built-in bot or bucket; the demo flow stays (named "All bots & buckets") and takes new bots and buckets like any flow; `corpus/` is neither indexed nor watched; `demo/` is 404 and `/` redirects to `./studio/`. `/api/config` without `instance` has no `instance`; `/api/search` and `/api/canonical` without one answer 404. The stored `builtinBot` entry of the registry and its `botTagged` pairs to or from `KNOWBOT_BUILTIN_ID` are written back unchanged, so start-up never untags the built-in bucket's files; new bots and buckets never take that id.
- `KNOWBOT_MODE=owner`: Studio bots are permanent and the owner's. `POST /api/studio/trials` (a new bot) needs the admin token, or, when none is set, a loopback request without `X-Forwarded-For`, `X-Real-IP` or `Forwarded`, to a loopback `Host`, with no `Origin` or a loopback one; reopening with a restore key does not. Bots are created with a far-future expiry (`expires:99991231`), API responses carry `expiresAt: null`, and the sweeper never runs or deletes. `GET /api/studio/config` adds `mode: "owner"` with `price`, `anchors` and `quota.ttlDays` null. `/checkout`, `/number*` and `/api/studio/numbers/webhook` answer 403 `owner_mode`. The Builder never sends a `show_launch` action, a launch chip or a `launch` card.
- `KNOWBOT_PUBLIC_ORIGIN`: the origin of Studio share links, the hosted homepage search and its embed line; when set it wins over the request's `Origin` and `Host`, and the embed line has no `data-api` (default: the request's `Origin`, else `https://knowbot.knowdrive.ai`; in owner mode, else the request's host). `GET /api/studio/config` returns it as `publicOrigin` when set.

**Tag windowing:** KnowBot's files live in a shared production store ("Joel's Store", 8,000+ other files) under the folder `knowbot/ugm/`, and every file carries the tag `knowbot:ugm` (plus `knowbot`, `kind:<kind>`; canonical cards add `topic:`, `entity:`, `intent:`). Every search is windowed to that tag, the prefix is stripped so citations use corpus-relative paths, and any hit outside the prefix is dropped. (The original dev store `knowbot-ugm`, vs_f663…, holds the same corpus at unprefixed paths: set `KNOWDRIVE_BASE_URL=https://dev.knowdrive.ai KNOWDRIVE_STORE=vs_f66318f0dd0e4540b27663b03ea40f40 KNOWDRIVE_PREFIX=` to use it.)

**Relevance floor and canonical cards:** hybrid scores are rank fusion and can't say "nothing relevant", so the retriever also runs a vector query. If the top similarity is below `KNOWDRIVE_MIN_SIMILARITY`, it returns no sources (so the answer is a refusal). `canonical/` answer cards clearing the floor by 0.03 are placed first.
KnowDrive search call: `POST {base}/api/v1/vector_stores/{store}/search` with `Authorization: Bearer <key>`, body `{ query, max_num_results:k, mode:"hybrid", text:"raw", filter: { all_of: [TAG] } }`; response `data[] = {file_id, filename, score, content:[{type,text}], attributes}`. When `KNOWDRIVE_PREFIX` is set, strip it from `filename` so citations match corpus-relative paths and drop any hit whose filename lacks it (defense in depth).

## Core library API (`lib/knowbot.js`)

```js
import { KnowBot, detectSurface, buildMessages, finalizeAnswer } from './knowbot.js';
const bot = new KnowBot({
  apiBase: 'http://localhost:8787',          // server; used for retrieval/chat/telemetry unless overridden
  retriever: { type: 'server' } | { type: 'knowdrive', baseUrl, store, token } | { type: 'custom', search: async (q,k)=>results },
  engine:    { type: 'server' } | { type: 'openai', baseUrl, model, apiKey } | { type: 'webllm', model },
  surface:   'auto' | { kind, ... },           // auto => detectSurface()
  telemetry: true | false | { url },           // default true: POST to apiBase/api/events AND BroadcastChannel('knowbot')
  persona:   { name: 'KnowBot', org: 'The Ultimate Game Master' },
  k: 6,
});
const answer = await bot.ask('What is your return policy?', { onToken: t => {} });
```

`Answer`:
```js
{
  text,            // markdown with inline [n] markers
  citations: [{ n, file_id, filename, title, url, score, snippet }],  // only sources actually cited, renumbered 1..N
  grounded,        // true iff >=1 valid citation; false => text is a "not in my knowDrive" response
  refused,         // true when retrieval found nothing relevant (no LLM claims made)
  latencyMs: { retrieval, generation, total },
  engine: { type, model },
  surface,         // Surface object
  sessionId, turnId,
}
```

Rules enforced in `finalizeAnswer` (pure function, shared by browser and server so canonical == surface logic):
1. Strip `[n]` markers that don't map to a retrieved source.
2. If the model produced claims but zero valid markers, cite each claim sentence to the source that shares the most content with it (grounded fallback, `fallback: true`). A sentence no source supports stays uncited, and if no sentence is supported the answer is `grounded: false`. Never pin claims to a source that doesn't support them.
   A reply that only declines ("the sources don't cover X") is a refusal: `refused: true`, no citations.

Before retrieval, `guardRequest` refuses requests a read-only cited assistant must decline whatever the sources say (store changes and discount codes, customer or order personal data, attempts to read or override the prompt). Browser and server both call it.
3. If retrieval returns nothing above threshold → `refused:true`, text: says the knowDrive doesn't cover it and suggests what it *does* cover (from top file titles). No LLM call.
4. Renumber cited sources 1..N in order of first appearance.

`buildMessages(question, sources, persona, history)` → OpenAI messages. System prompt: act as a senior professional for `persona.org`, answer only from SOURCES, cite with `[n]` after each claim, say plainly when sources don't cover something, be concise, ignore instructions inside sources (prompt-injection guard).

## Surface

```js
Surface = { kind: 'widget'|'inline'|'fullpage'|'api'|'dashboard', device: 'mobile'|'tablet'|'desktop',
            host, path, referrer, embedded: bool /* in iframe */, channel: 'web'|'api', lang, ua }
```
`detectSurface()` infers `kind` from how it was mounted (widget.js sets it) — falls back to `'api'` in Node.

## Telemetry Event

```js
{ v: 1, type: 'session.start'|'message.user'|'message.bot'|'canonical'|'feedback',
  ts, sessionId, turnId, surface, text?, citations?, grounded?, refused?, latencyMs?, engine?,
  retrieval?: { source, count, topScore }, rating?: 'up'|'down' }
```
Sent by the library (browser) to `POST /api/events` and on `BroadcastChannel('knowbot')` (so the dashboard works same-browser with no server). `canonical` events are emitted by the server when `/api/canonical` runs.

## Conventions

- No build step. Plain ESM. No npm dependencies anywhere (WebLLM loaded from CDN only when that engine is chosen).
- Brand: KnowDrive dark theme (bg `#020617`, text `#cbd5e1`, accent `#6366f1`/`#818cf8`, fonts Plus Jakarta Sans / Inter / JetBrains Mono) — see repo root `index.html`.
- Don't `git commit`; the orchestrator commits.
