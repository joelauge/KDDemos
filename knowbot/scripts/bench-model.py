#!/usr/bin/env python3
"""Benchmark a llama-server OpenAI endpoint for the KnowBot RAG shape.

Prompt ~= system + 6 retrieved sources (~1500 tokens total) + question; answer is
forced to exactly N tokens (llama.cpp `ignore_eos`) so decode speed is comparable.
Prompt cache is disabled and each run gets a unique prefix, so every run pays the
full prefill. Reports client-side TTFT plus server-side prefill/decode timings.

Usage: bench-model.py [--url http://127.0.0.1:8080] [--model alias] [--runs 3]
                      [--max-tokens 200] [--concurrency 1]
Stdlib only.
"""
import argparse, json, statistics, threading, time, urllib.request

TOPICS = [
    ("catalog/products/dungeon-tiles.md", "Modular Dungeon Tiles Set"),
    ("catalog/products/gm-screen.md", "Game Master Screen"),
    ("policies/shipping.md", "Shipping Policy"),
    ("policies/refunds.md", "Refund Policy"),
    ("guides/getting-started.md", "Getting Started Guide"),
    ("pages/faq.md", "Frequently Asked Questions"),
]

# Synthetic filler for timing only (not product facts).
FILLER = (
    "This section describes the item, its contents, materials, dimensions, compatible "
    "game systems, care instructions, and frequently asked questions from customers. "
    "It explains how the item is packaged, what is included in the box, how long "
    "delivery usually takes, and how to contact support if something arrives damaged. "
)


def build_messages(run_id: int):
    sources = []
    for i, (fn, title) in enumerate(TOPICS, 1):
        body = (FILLER * 4).strip()
        sources.append(f"[{i}] filename: {fn}\ntitle: {title}\n{body}")
    system = (
        f"(run {run_id}) You are KnowBot, a helpful assistant for an online tabletop "
        "gaming store. Answer ONLY from the sources below and cite them as [n]. If the "
        "sources do not contain the answer, say you don't know.\n\nSOURCES:\n\n"
        + "\n\n".join(sources)
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "What is included with the dungeon tiles set, and how long does shipping take?"},
    ]


def one_run(url, model, run_id, max_tokens):
    body = {
        "model": model, "messages": build_messages(run_id), "stream": True,
        "temperature": 0, "top_p": 1, "seed": 7, "max_tokens": max_tokens,
        "ignore_eos": True, "cache_prompt": False,
    }
    req = urllib.request.Request(url + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter(); ttft = None; timings = {}; usage = {}; n_chunks = 0
    with urllib.request.urlopen(req, timeout=600) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            ev = json.loads(line[6:])
            ch = ev.get("choices") or [{}]
            if ch and (ch[0].get("delta") or {}).get("content"):
                n_chunks += 1
                if ttft is None:
                    ttft = time.perf_counter() - t0
            timings = ev.get("timings", timings); usage = ev.get("usage", usage) or usage
    total = time.perf_counter() - t0
    return {
        "ttft_s": ttft, "total_s": total,
        "prompt_tokens": timings.get("prompt_n") or usage.get("prompt_tokens"),
        "gen_tokens": timings.get("predicted_n") or usage.get("completion_tokens"),
        "prefill_tps": timings.get("prompt_per_second"),
        "decode_tps": timings.get("predicted_per_second"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--model", default="qwen2.5-1.5b-instruct")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=200)
    ap.add_argument("--concurrency", type=int, default=1)
    a = ap.parse_args()

    one_run(a.url, a.model, -1, 8)  # warm-up
    results = []; walls = []
    for r in range(a.runs):
        batch = [None] * a.concurrency
        def go(k):
            batch[k] = one_run(a.url, a.model, r * 100 + k, a.max_tokens)
        ths = [threading.Thread(target=go, args=(k,)) for k in range(a.concurrency)]
        t0 = time.perf_counter(); [t.start() for t in ths]; [t.join() for t in ths]
        wall = time.perf_counter() - t0; walls.append(wall)
        for b in batch:
            b["wall_s"] = wall
        results.extend(batch)

    med = lambda k: statistics.median(x[k] for x in results if x[k] is not None)
    summary = {
        "model": a.model, "runs": a.runs, "concurrency": a.concurrency,
        "prompt_tokens": med("prompt_tokens"), "gen_tokens": med("gen_tokens"),
        "ttft_s_median": round(med("ttft_s"), 2), "ttft_s_max": round(max(x["ttft_s"] for x in results), 2),
        "prefill_tps_median": round(med("prefill_tps"), 1),
        "decode_tps_median": round(med("decode_tps"), 1),
        "total_s_median": round(med("total_s"), 2),
        "aggregate_gen_tps": round(sum(x["gen_tokens"] for x in results) / sum(walls), 1),
    }
    print(json.dumps({"summary": summary, "runs": results}, indent=2))


if __name__ == "__main__":
    main()
