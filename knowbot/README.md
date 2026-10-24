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
KNOWDRIVE_API_KEY=<developer key from dev.knowdrive.ai/developer-keys> knowbot/scripts/dev.sh
```

| Variable | Default |
|---|---|
| `KNOWDRIVE_BASE_URL` | `https://dev.knowdrive.ai` |
| `KNOWDRIVE_STORE` | `vs_f66318f0dd0e4540b27663b03ea40f40` |
| `KNOWDRIVE_TAG` | `knowbot:ugm` |
| `KNOWDRIVE_PREFIX` | empty; set it to host the corpus in a shared store under a folder |
| `KNOWDRIVE_API_KEY_FILE` | path to a file holding the key; re-read on every search, so a rotated key needs no restart |

Minted MCP tokens last about 120 seconds, so a long-running server needs a developer key. If knowDrive fails, the
server falls back to local search and labels results `local-fallback`.

To re-seed the store after editing `corpus/`:

```bash
KNOWDRIVE_API_KEY=... node knowbot/scripts/seed-knowdrive.mjs --dry-run   # then without --dry-run
```

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
