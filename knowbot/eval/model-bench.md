# KnowBot model benchmark (CPU, llama.cpp)

Date: 2026-10-24 · Runtime: llama.cpp `llama-server` **b11450** (prebuilt `llama-b11450-bin-ubuntu-x64.tar.gz`, commit a46709b68)
Host: cloud container, 4 vCPU Intel Xeon @ 2.30 GHz (AVX-512/VNNI, 1 thread/core), 15 GB RAM, no GPU.
Server flags (all models): `-c 8192 -t 4 -np 2 --kv-unified --jinja` (see `scripts/start-model.sh`).

## Workload

`scripts/bench-model.py`: one system prompt containing 6 retrieved sources plus a question,
**1576 prompt tokens** → **200 generated tokens** (forced with `ignore_eos` so decode speed is comparable).
`temperature 0, top_p 1, seed 7`, streaming. Prompt cache is disabled and each run has a unique
prefix, so every run pays the full prefill. 1 warm-up and then 3 measured runs; the medians are reported.
TTFT is measured by the client (request sent → first content delta). Prefill and decode rates come from llama-server `timings`.

## Results (single request, idle machine)

| Model (Q4_K_M) | GGUF size | RSS | TTFT | Prefill tok/s | Decode tok/s | Total for 1576→200 |
|---|---|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct | 469 MiB | 0.8 GB | **3.7 s** | 425 | **65.4** | 7.1 s |
| **Qwen2.5-1.5B-Instruct** | 1066 MiB | 2.7 GB | **5.4 s** | 296 | **21.4** | 14.7 s |
| Qwen2.5-3B-Instruct | 2007 MiB | 4.3 GB | **10.7 s** | 150 | **11.6** | 27.9 s |

Run-to-run spread was small: TTFT max was within 0.3 s of the median for every model.

### 1.5B with 2 concurrent requests (both slots busy)

| | TTFT median / max | Decode tok/s per stream | Aggregate gen tok/s | Total per request |
|---|---|---|---|---|
| 1.5B, concurrency 2 | 8.8 s / 11.2 s | 11.7 | 15.4 | 26.0 s |

With both slots busy, each user's TTFT is about 1.6–2x the single-request figure, and each stream's decode rate is about halved. Total throughput only rises about 1.3x, because 4 cores are already saturated by one request.

### Methodology note: contention

Other KnowBot agents were sending traffic to the shared :8080 server while this ran, so the
first benchmark pass was contaminated: it showed the 0.5B at 4 tok/s and the 3B at 2 tok/s. The final numbers above
come from runs gated on the `:8080/metrics` counters. A run is accepted only if no foreign prompt tokens
were processed during it. The 0.5B and 3B ran on a temporary server on :8081. The concurrency-2 row was
not gated, so treat it as approximate.

## What this means for KnowBot

- Prefill dominates. With six sources, TTFT is about `prompt_tokens / prefill_rate`. Each additional 250-token
  source adds about 0.85 s of TTFT on 1.5B. Keeping retrieved text tight, with k ≤ 6 and trimmed chunks, gives the biggest latency win.
- With the canonical `max_tokens: 400`, the worst case on 1.5B is about 5.4 s + 400/21.4 ≈ **24 s**. Typical answers of
  100–200 tokens take 10–15 s end to end and start streaming after about 5 s.
- Repeated or overlapping prompts benefit from llama-server's prompt cache (`cache_prompt` defaults to on). A shared system
  prompt prefix is reused across turns, so real TTFT for follow-up turns is lower than the cold numbers above.

## Recommendation

**Keep Qwen2.5-1.5B-Instruct Q4_K_M as the server and eval engine**, as specified in SPEC.md, on :8080.
- It is the best quality-to-latency point that is still interactive on 4 CPU cores. It streams at about 21 tok/s, faster than reading speed, with about 5 s to the
  first token on a full 6-source prompt. It also matches the browser WebLLM engine (Qwen2.5-1.5B), so local and
  browser answers come from the same model family. The 3B roughly doubles every latency (11 s TTFT, 12 tok/s, about 28 s per
  answer) and needs 4.3 GB RSS, so it is too slow for a live demo on this hardware.
- 0.5B is 2–3x faster and suits quick tests or fast smoke runs. However, 0.5B-class models
  are noticeably weaker at following "answer only from sources and cite [n]" instructions, so it should not be the canonical model.
  Answer quality was **not** scored in this benchmark; it measures speed only.
- Operational: keep `-np 2`, since a second user is not blocked, but expect about 2x latency when both slots are busy. If more
  concurrent eval traffic is needed, run eval jobs sequentially rather than raising `-np`.

## Reproduce

```bash
knowbot/scripts/setup-model.sh                         # binary + 1.5B (add KNOWBOT_MODEL=0.5b|3b for others)
knowbot/scripts/start-model.sh                         # :8080, detached
python3 knowbot/scripts/bench-model.py --runs 3        # add --concurrency 2 for the 2-slot test
# comparison models on a side port:
KNOWBOT_MODEL=3b knowbot/scripts/setup-model.sh
KNOWBOT_PORT=8081 KNOWBOT_LOG=$HOME/.cache/knowbot/llama-8081.log \
  KNOWBOT_MODEL_FILE=$HOME/.cache/knowbot/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  KNOWBOT_MODEL_ALIAS=qwen2.5-3b-instruct knowbot/scripts/start-model.sh
python3 knowbot/scripts/bench-model.py --url http://127.0.0.1:8081 --model qwen2.5-3b-instruct
KNOWBOT_PORT=8081 knowbot/scripts/start-model.sh stop
```
