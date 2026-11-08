# Studio sample files

`lumen-bikes/` is the sample set behind **Use sample files** in KnowBot Studio.

Fictional company, written for KnowBot Studio, CC0 1.0.

Lumen Bikes does not exist. Every name, price, address and policy in these files was written for this demo and
is dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Email
addresses use the reserved `.example` domain.

| File | What it exercises |
|---|---|
| `lumen-warranty-returns.md` | Long-form policy prose with headings (breadcrumbs, multi-paragraph citations) |
| `lumen-service-plans.html` | An HTML `<table>` plus prose (HTML extraction, table rows as derived lines) |
| `lumen-store-faq.txt` | Plain-text question and answer pairs |
| `lumen-price-list-2026.md` | A Markdown price table (table-derived lines, `Header: value` quotes) |
| `questions.json` | Curated starters, Proof Run questions and off-topic probes. All are re-validated at runtime against the floor |

The facts the Studio tests rely on are written verbatim in the files (spec section 5.1); edit them with care.

About 410 atoms in all (roughly 100 per file), so the ingest map has a real shape at desktop width. Writing rules that
keep answers whole: each answer-bearing fact is its own paragraph or its own line (FAQ answers are one sentence per
line), the answer sentence comes first, and no fact is split around an abbreviation. `questions.json` `expect` lists
the substring every curated answer must contain; the Proof Run's `check` uses it.
