# KnowBot

A small front-end JS library, a small fast open-weights model, and a small knowDrive store. KnowBot answers like a
senior professional for whatever is in the store, and **every answer cites the store files it came from**. A live
dashboard shows which surface each user is chatting through and gets KnowBot's canonical answer in real time.

The first store is **The Ultimate Game Master** (theultimategamemaster.com): 105 files built read-only from the
Shopify store (40 active products, 17 collections, 6 policies, 9 pages, 25 blog posts, shop and operations notes),
held in the knowDrive Dev store `knowbot-ugm`.

`SPEC.md` is the binding contract between the pieces. This file is how to run them.

## Pieces

| Path | What it is |
|---|---|
| `lib/knowbot.js` | Core library (ESM, zero deps, browser + Node): retrieval, prompt, engines, citation rules, surface detection, telemetry |
| `lib/widget.js`, `lib/knowbot.css` | UI: floating widget, inline panel, full-page chat |
| `lib/embed.js` | One-line `<script>` embed |
| `server/server.mjs` | Node 22 server, no npm deps: search, chat proxy, canonical answers, SSE telemetry, static files |
| `dashboard/` | Live operator dashboard |
| `demo/` | Host pages for each surface |
| `corpus/` | The knowDrive corpus, mirrored 1:1 into the store |
| `eval/` | Sidekick profile, 54-item benchmark, rubric, harness, results |
| `scripts/` | Model setup/start, knowDrive seeding, dev launcher |

## Run it locally

```bash
knowbot/scripts/setup-model.sh   # once: llama.cpp b11450 + Qwen2.5-1.5B-Instruct Q4_K_M (~1 GB)
knowbot/scripts/dev.sh           # starts the model on :8080 if needed, then the server on :8787
```

Then open:

- `http://localhost:8787/demo/`: index of the demo surfaces (storefront widget, help-center inline panel, full-page chat, browser-only)
- `http://localhost:8787/dashboard/`: the live dashboard. Chat on a demo page in another tab and watch it arrive.

The dashboard also works with no server: open it and press **Simulate traffic**.

## Retrieval: knowDrive vs local

| Mode | When | Notes |
|---|---|---|
| `knowdrive` | `KNOWDRIVE_API_KEY` is set | Hybrid search on `knowbot-ugm`, windowed to tag `knowbot:ugm`. Multilingual: "devoluciones" finds the refund policy. |
| `local` | no key | BM25 over `corpus/`. The same paths are cited, so answers are comparable, but keyword-only. |

```bash
KNOWDRIVE_API_KEY=<developer key from knowdrive.ai/developer-keys> knowbot/scripts/dev.sh
```

| Variable | Default |
|---|---|
| `KNOWDRIVE_BASE_URL` | `https://knowdrive.ai` (production) |
| `KNOWDRIVE_STORE` | `vs_97c857474b1f4e8892b134c283cf9849` ("Joel's Store") |
| `KNOWDRIVE_TAG` | `knowbot:ugm` |
| `KNOWDRIVE_PREFIX` | `knowbot/ugm/` (the folder inside the shared store) |
| `KNOWDRIVE_MIN_SIMILARITY` | `0.745`: relevance floor on vector similarity; below it KnowBot refuses |
| `KNOWDRIVE_API_KEY_FILE` | path to a file holding the key; re-read on every search, so a rotated key needs no restart |

Minted MCP tokens last about 120 seconds, so a long-running server needs a developer key. If knowDrive fails, the
server falls back to local search and labels results `local-fallback`.

To re-seed the store after editing `corpus/`:

```bash
KNOWDRIVE_API_KEY=... node knowbot/scripts/seed-knowdrive.mjs --dry-run   # then without --dry-run
```

## Sync

`scripts/sync-knowdrive.mjs` keeps the live store identical to `corpus/`. It compares every corpus file with the live
file at `KNOWDRIVE_PREFIX` + its path and plans `add`, `update` (content differs), `same`, `retag` (missing `knowbot`,
`knowbot:ugm`, `kind:` or `canonical/TAGS.json` tags) and `remove` (live files tagged `knowbot:ugm` under the prefix that
no longer exist locally). Nothing outside the prefix and tag is touched: the store is shared.

```bash
KNOWDRIVE_API_KEY=... node knowbot/scripts/sync-knowdrive.mjs           # dry run: prints the plan
KNOWDRIVE_API_KEY=... node knowbot/scripts/sync-knowdrive.mjs --apply   # uploads, retags (additive), deletes
node knowbot/scripts/sync-knowdrive.mjs --json                           # machine-readable plan/result
```

Local-mode retrieval reads the same `corpus/` folder, so after a sync the two modes search identical content and
cite identical paths.

## Embed it

```html
<script type="module" src="https://demos.knowdrive.ai/knowbot/lib/embed.js"
        data-api="https://your-knowbot-server" data-mode="widget"
        data-org="The Ultimate Game Master"></script>
```

`data-mode` is `widget`, `inline` (with `data-target="#el"`) or `fullpage`. `data-engine="webllm"` runs the model in
the visitor's browser on WebGPU instead of the server.

## How citation is guaranteed

`finalizeAnswer` in `lib/knowbot.js` runs on every answer. The browser and the server use the same function, so a
surface answer and the canonical answer follow identical rules:

1. `[n]` markers that don't map to a retrieved source are removed.
2. If the model makes claims without valid markers, they are pinned to the top source. No answer leaves uncited.
3. If retrieval finds nothing relevant, KnowBot refuses without calling the model and says what the store does cover.
4. Cited sources are renumbered 1..N, and each links to its knowDrive file and public URL.

The prompt includes one worked example of a cited answer. On the 1.5B model this took inline citations from 0 per
answer to 1–2.

## Tests and evaluation

```bash
node --test knowbot/lib/test/core.test.mjs knowbot/server/test/server.test.mjs
node knowbot/eval/run-benchmark.mjs --api http://localhost:8787     # writes eval/results/<ts>.json
```

`eval/sidekick-profile.md` is the research on Shopify Sidekick, `eval/rubric.md` explains the scoring, and
`eval/REPORT.md` is the scorecard.

## Model

Qwen2.5-1.5B-Instruct Q4_K_M on 4 CPU cores: ~5 s to first token, ~21 tok/s, ~15 s for a 6-source, 200-token
answer. 3B doubles that; 0.5B halves it. See `eval/model-bench.md`. Canonical settings: temperature 0, top_p 1,
max_tokens 400, seed 7.

## Public hosting (knowbot.knowdrive.ai + Cloudflare)

- **Static site:** GitHub Pages serves this repo's root at `knowbot.knowdrive.ai` (`CNAME`, `.nojekyll`; light mode by default).
- **API:** `cloudflare/` deploys a Worker (`knowbot-api`) in front of one Cloudflare Container (`standard-4`, 4 vCPU / 12 GiB) that runs llama.cpp `llama-server` with Qwen2.5-1.5B-Instruct Q4_K_M plus the unchanged Node server. It is the same model and code as every judged round. The container sleeps after 15 minutes idle; the first request after that wakes it in roughly 5–20 s.
- **Deploy:** `.github/workflows/deploy-cloudflare.yml` runs on push to `main` (or manually) once the repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `KNOWDRIVE_API_KEY` exist. Locally: `cd cloudflare && npm install && npx wrangler deploy` (needs Docker).
- **Wire the pages to it:** put the deployed Worker URL in `lib/site-config.js` (`HOSTED_APIS['knowbot.knowdrive.ai']`). The dashboard and demos then use it by default.

## Bots and buckets

A **bucket** is a tag: every file carrying `bucket:<id>` belongs to it, wherever knowDrive stores it. A **bot** (chat instance) is linked to any number of buckets, and each link can be switched on or off. A bot answers **only** from its enabled buckets. Each bucket is searched on its own, filtered to its tag (plus the link's mask), and any hit whose tags don't match is dropped before it can be quoted or cited. Several bots can share a bucket, and a bot with no enabled links answers nothing. Wire them on the dashboard's **Bots & buckets** canvas.

- **Flows:** the dashboard's left column lists **Bots & buckets** flows. A flow is a group of bots and the buckets they answer from, each on its own canvas. The built-in bot and bucket form the demo flow. **+ New bot** there starts a new flow, and **+ Bucket** / **+ Bot** inside a flow add to it. A new bot linked to a bucket joins that bucket's flow. Registries from before flows are grouped automatically by what is linked to what, and each group is named after its bucket. API: `GET/POST /api/flows`, `PATCH/DELETE /api/flows/:id` (only an empty flow can be deleted); bots and buckets take `flow` on create or update.
- **Buckets nest, and nesting is tags too.** The dashboard never says "folder": a file in the bucket's `Menus › Lunch` carries `f1:menus` and `f2:lunch`. The inspector draws the bucket tree from those tags, an uploaded folder keeps its structure as nested buckets, and **Move** just retags a file (nothing is re-uploaded). There are no user-facing paths. Files still get a storage location (`knowbot/<bucket id>/…`) because knowDrive needs one, but nothing reads it.
- **Masks:** a link can carry a mask, `{ require: [tags], exclude: [tags] }`, which narrows what that bot may cite from that bucket: only files with every `require` tag and none of the `exclude` tags. Use nested-bucket tags (`f1:`, `f2:`) to keep a bot to one of them or to leave one out, or any other tag (`format:pdf`, `status:archived`). Edit masks under a bot's linked buckets; masked links show a **mask** badge on the canvas.
- **Bot tags:** linking a bucket to a bot (on or off) tags every file in it `bot:<bot id>`, and new uploads to that bucket get the tag too. Unlinking or deleting the bot removes it. This runs in the background, and a full pass at server start-up also catches files that reached a linked bucket some other way, such as a bulk ingest. Bot tags aren't offered as mask tags.
- **Migration:** buckets from the folder era are converted on first load. Their files get the bucket tag and folder tags derived from their paths, once per bucket.
- **Registry:** `knowbot/_config/instances.json` in the same store, tagged `kind:config` and never searchable. The built-in bot and bucket (`ugm`, `knowbot/ugm/`) come from the server config; only the built-in bot's links can change.
- **Uploads:** any file type knowDrive accepts. One file per request, up to 95 MB (the Cloudflare request limit), tagged `knowbot`, `bucket:<id>`, `kind:upload` and the folder tags of its relative path.
- **Relevance floor:** a bot's floor (default 0.70, `KNOWBOT_INSTANCE_MIN_SIMILARITY`) applies to its uploaded buckets; the built-in bucket keeps its calibrated 0.745. Raise the floor if a bot answers off-topic questions; lower it if it refuses questions its files do answer.
- **Guards:** `general` (prompt-injection, personal data, actions) or `store`, which adds the retail-only platform and analytics refusals.
- **Admin:** creating, editing, linking, uploading and deleting require `KNOWBOT_ADMIN_TOKEN`, sent as `Authorization: Bearer …`; the dashboard keeps it in this browser only. Without a token set, only loopback requests can manage bots and buckets (local development).
- **Using a bot:** `demo/chat.html?instance=<bot id>`, or `<script type="module" src=".../lib/embed.js" data-instance="<bot id>" data-api="<api>"></script>`. Its name, greeting and starter questions come from the bot settings.

- **Corpus inspector:** clicking a bucket shows its files and where each one is in knowDrive's pipeline (Uploaded → Extracted → Chunked → Vectorized → Ready, or Failed with the reason), stage totals, atoms vectorized, and a preview of each file's first atoms (what bots can quote). A fresh file usually reaches Ready in 1–3 minutes.
- **Answering model:** each bot answers with the local model (default) or a hosted platform: OpenAI or Anthropic (Claude), using the operator's own API key. Add keys under **Answering platforms**. They are checked against the platform by listing its models, sealed with AES-256-GCM using `KNOWBOT_SECRET_KEY` (or, if that's unset, the admin token), and only the last 4 characters are ever shown. Claude calls use the official `@anthropic-ai/sdk` (the server's only npm dependency) with no sampling parameters, `low` effort for line picking, and the server-side refusal fallback on models that support it. A declined request returns the fixed "not in my data" reply.
- **Answer style:** `select` (quote only; the model picks lines and KnowBot quotes them) or `generate` (the model writes; claims a source doesn't support are removed). **Instructions** add focus and tone, and never override the grounding rules.

API:
- `GET /api/graph` returns bots, buckets and `canManage`.
- Buckets: `GET/POST /api/buckets`, `GET/PATCH/DELETE /api/buckets/:id`, `GET/POST /api/buckets/:id/files` (raw body with an `x-filename` header; its folders become tags), `PATCH /api/buckets/:id/files/:fileId` `{folders}` (move = retag), `DELETE /api/buckets/:id/files/:fileId`, `GET /api/buckets/:id/tags` (tags in the bucket, for masks). Create a bucket with `{name, tag?}`; links are `{id, enabled, mask?}`.
- Bots: `GET/POST /api/instances`, `GET/PATCH/DELETE /api/instances/:id`; `buckets: [{id, enabled}]` replaces the bot's links.
- Platforms (admin): `GET /api/providers`, `PUT/DELETE /api/providers/:id` (`{apiKey}`), `GET /api/providers/:id/models`.
- Files: `GET /api/buckets/:id/files/:fileId/atoms?limit=3` previews a file's first atoms.
- `/api/search`, `/api/canonical` and `/api/config` take `instance` (a bot id).
