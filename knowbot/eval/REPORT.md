# KnowBot vs Shopify Sidekick: scorecard

Store: **The Ultimate Game Master** (theultimategamemaster.com). KnowBot = Qwen2.5-1.5B-Instruct Q4_K_M on 4 CPU
cores + `lib/knowbot.js` + a 106-file knowDrive. Sidekick is not callable from here, so it is represented by its
documented behaviour (`sidekick-profile.md`, 15 cited sources) and the per-category reference scores in
`rubric.md`. The benchmark is 54 questions with ground truth taken from the Shopify Admin API (`benchmark.json`).

**Bottom line:** judged Sidekick parity is **0.71**. KnowBot beats Sidekick on out-of-corpus refusals and is close
on merchant questions. It is behind on everything that needs a small model to attribute facts precisely (prices
per product, stock per variant, policy polarity), and 5 answers still contain severe cited errors. The automatic
scorer reads **0.85**; it overstates KnowBot by ~0.14 because it checks that a citation *exists*, not that the
cited file *supports* the claim. Trust the judged number.

## Judged scores (round 6, current code)

An adversarial judge agent checked 117 cited claims one by one against the cited corpus files.

| Category | n | KnowBot judged | KnowBot auto | Sidekick ref | Judged ratio |
|---|---|---|---|---|---|
| Catalog facts | 10 | 71.6 | 84.6 | 85 | 0.84 |
| Policy | 9 | 61.3 | 81.8 | 80 | 0.77 |
| Synthesis | 9 | 63.7 | 71.9 | 80 | 0.80 |
| Merchant / operator | 8 | 80.1 | 84.1 | 90 | 0.89 |
| Out of corpus | 5 | 74.0 | 82.6 | 70 | **1.06** |
| Adversarial | 13 | 56.7 | 72.9 | 75 | 0.76 |
| **Parity** | | **0.71** | 0.85 | 1.00 | |

| Gate | Result |
|---|---|
| Zero severe hallucinations | **FAIL**: cat-04, pol-08, adv-03, adv-07, adv-10 |
| Out-of-scope refusal ≥ 95% | **FAIL**: 0.92 (ooc-04, invented Shopify Payments steps) |
| False refusal ≤ 10% | pass: 0.02 |
| Citation integrity (every `[n]` maps to a real file) | pass: 1.00 |
| Prompt-injection compliance = 0 | pass |

- **Claim-level citation precision:** 0.65 (a claim is supported by the file it cites).
- **Latency:** p50 4.8 s, p90 14.7 s, max 15.4 s on a shared 4-core CPU. Sidekick publishes no latency figures, and merchants report seconds to minutes in long threads.

## How we got here: six rounds

| Round | Change | Auto parity | Judged parity |
|---|---|---|---|
| 1 | Baseline (worked citation example added) | 0.72 | n/a |
| 2 | Request guard (actions, personal data, prompt extraction), decline detection, honest citation fallback, red-team hardening, computed inventory & pricing report in the corpus | 0.70 | n/a |
| 3 | Claim support check + worked decline example | 0.71 | n/a |
| 4 | Decline example removed (made the model over-decline and copy example facts) | 0.82 | n/a |
| 5 | Support check ignores words echoed from the question; broader decline detection | 0.85 | **0.707** |
| 6 | Judge fixes: refusals use canned text, narrower decline detection, label/repeat hygiene, repetition penalty | 0.85 | **0.712** |

What moved, from the automatic scorer:
- Merchant questions: 63 → 84.
- Adversarial questions: 53 → 73.
- Out-of-corpus refusals went 83 → 28 → 99 as the decline example was added and then removed, and ended at 83.
- False refusals: 10% → 36% (round 3) → 2%.
- Citation integrity: 1.00 in every round.

## Where KnowBot beats Sidekick

- **Every answer is traceable.** Each claim carries `[n]` linking to a knowDrive file and its public URL. Sidekick's documentation never mentions citations, and merchants report that it "rarely says I don't know".
- **It refuses instead of inventing.** There are no phone numbers, store hours or discount codes in the corpus, and KnowBot gave none. All 7 benchmark requests for actions, personal data or prompt extraction are refused by `guardRequest` before the model runs, with no false positives on 6 near-miss legitimate questions.
- **It serves surfaces Sidekick can't.** Sidekick is an admin assistant and officially can't talk to customers. KnowBot runs as a storefront widget, an inline help panel, a full-page chat, or in the browser via WebGPU. The live end-to-end test showed all three surfaces in the dashboard with a "matches canonical" verdict.
- **It's portable and cheap.** It uses an open-weights 1.5B model on CPU, and any knowDrive store works, not only Shopify data.

## Where Sidekick wins

- **By design (out of scope for a read-only cited assistant):** taking actions (discounts, edits), live analytics, orders and revenue, customer data, Shopify how-to, Flow automations, image generation. KnowBot declines these, which caps its answer coverage at about 0.35–0.54.
- **Where KnowBot is just weaker** (the fix list below):
  1. **Facts attributed to the wrong product.** The 1.5B model lifts a price from a neighbouring product's file. The support check confirms the number appears in the cited file, but not that it belongs to the product asked about (adv-03: screen "$47.99"; adv-07: screen "$35").
  2. **Polarity.** pol-08 says the store "does not sell or share" personal data and cites three files that say it does. Word overlap can't see negation.
  3. **Variant stock.** cat-04 says Green is available when the variant table says sold out.
  4. **False premises and competitors.** adv-10 attaches a corpus price table to a competitor (Wyrmwood). adv-04 and adv-05 accept premises they should correct.
  5. **Retrieval misses.** Local BM25 misses files that exist (subscription cancellation, the $100 free-shipping threshold, all 7 magnetic covers) and all non-English queries (adv-11). knowDrive hybrid search, which is already wired in and tag-windowed, found the refund policy for "devoluciones" in a spot check. It wasn't used for these runs because no long-lived API key was available.

## Next fixes, in priority order

1. **Structured answers for price, stock and variants.** When a question names one product, answer price, compare-at and per-variant stock straight from its variant table, and quote policy text verbatim for privacy, returns and shipping. Also check that each claim agrees with its source in polarity and is about the same product. Covers 4 of the 5 severe items.
2. **Run on knowDrive hybrid retrieval with a developer key** (`KNOWDRIVE_API_KEY`), and route by question type (deals → promotions, lists → collections, costs → shipping config). Covers about 9 items, including multilingual.
3. **Premise check and competitor guard.** Confirm or correct facts the user asserts, and never attach a third-party name to a corpus price.
4. **Generation hygiene, round 2.** Drop list items that are only a marker (keeps ooc-04 failing the gate), collapse near-duplicate sentences, and replace the repetition penalty with prompt-side brevity. The penalty caused 3 small regressions and pushed p90 latency up.
5. **Evaluation.** Add `must_not` patterns for the judged failures, and make a judge pass part of every round. The automatic number alone was misleading.

## Files

- `judge-report.md`: the full adversarial judgement for rounds 5 and 6: worst answers, root causes, regressions.
- `results/*.json`: every round. `*.judged.json` hold the judge's per-item scores.
- `redteam-static.md`: security review (9 high findings; 7 fixed in code, 2 applied by the orchestrator; open items listed).
- `model-bench.md`: 0.5B / 1.5B / 3B latency on this hardware.
- `screens/live-*.png`: the live end-to-end run (widget, mobile full page, dashboard with canonical comparison).
