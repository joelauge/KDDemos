#!/usr/bin/env python3
"""Derive corpus/catalog/inventory-and-pricing.md from the product files' variant tables.

Catalog-wide questions ("what's sold out?", "any compare-at anomalies?") can't be answered from the
6 sources a small model sees per question, so this precomputes them into one citable file.
Facts are computed from the Shopify data already in corpus/catalog/products; nothing is invented.
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "corpus"
PRODUCTS = ROOT / "catalog" / "products"
OUT = ROOT / "catalog" / "inventory-and-pricing.md"
money = lambda s: float(s.replace("$", "").replace(",", "")) if s and s.strip().startswith("$") else None

rows = []
for f in sorted(PRODUCTS.glob("*.md")):
    t = f.read_text()
    title = re.search(r'^title:\s*"?(.*?)"?\s*$', t, re.M).group(1)
    variants = []
    for line in t.split("## Variants and pricing", 1)[-1].splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 6 and cells[1].startswith("$"):
            variants.append({"name": cells[0], "price": money(cells[1]), "compare": money(cells[2]),
                             "available": cells[4].lower() == "yes", "inventory": cells[5]})
    if variants:
        rows.append({"title": title, "path": f"catalog/products/{f.name}", "variants": variants})

sold_out = [r for r in rows if not any(v["available"] for v in r["variants"])]
partial = [r for r in rows if r not in sold_out and any(not v["available"] for v in r["variants"])]
anomalies = [(r, v) for r in rows for v in r["variants"] if v["compare"] is not None and v["price"] is not None and v["compare"] < v["price"]]
on_sale = [r for r in rows if any(v["compare"] and v["price"] is not None and v["compare"] > v["price"] for v in r["variants"])]

def fmt(x): return f"${x:,.2f}"
L = ["---", 'title: "Catalog inventory & pricing report — sold out, partly sold out, on sale, compare-at anomalies"',
     "kind: guide", "source: shopify", "updated: 2026-10-24", "---", "",
     "# Catalog inventory & pricing report — what's sold out, what's on sale, and pricing anomalies", "",
     f"Computed from the variant tables of the {len(rows)} active products (Shopify data as of 2026-10-24).", "",
     "## Completely sold out products (every variant unavailable)", ""]
L += [f"- {r['title']} (`{r['path']}`)" for r in sold_out] or ["- None: every active product has at least one variant available."]
L += ["", "## Partly sold out products (some variants unavailable)", ""]
L += [f"- {r['title']} (`{r['path']}`): sold out in {', '.join(v['name'] for v in r['variants'] if not v['available'])}" for r in partial] or ["- None."]
L += ["", "## Pricing anomalies: compare-at price lower than the selling price", "",
      "A compare-at price is meant to be the higher \"was\" price. These variants have it set below the actual price, which looks like a data-entry error.", ""]
groups = {}
for r, v in anomalies: groups.setdefault((r["title"], r["path"], v["price"], v["compare"]), []).append(v["name"])
L += [f"- {t}: price {fmt(p)}, compare-at {fmt(c)} ({'all variants' if len(names) == len(next(r for r in rows if r['path'] == path)['variants']) else ', '.join(names)}) (`{path}`)"
      for (t, path, p, c), names in groups.items()] or ["- None."]
L += ["", "## Products on sale (compare-at price above the selling price)", ""]
for r in on_sale:
    v = next(v for v in r["variants"] if v["compare"] and v["compare"] > v["price"])
    L.append(f"- {r['title']}: {fmt(v['price'])}, was {fmt(v['compare'])} (`{r['path']}`)")
if not on_sale: L.append("- None.")
OUT.write_text("\n".join(L) + "\n")
print(f"wrote {OUT.relative_to(ROOT.parent)}: {len(sold_out)} sold out, {len(partial)} partial, {len(anomalies)} anomalous variants, {len(on_sale)} on sale")
