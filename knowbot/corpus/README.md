---
title: "KnowBot corpus README"
kind: guide
source: shopify
updated: 2026-10-24
---

# KnowBot seed corpus — The Ultimate Game Master

This directory is the knowDrive seed corpus for KnowBot. Every file was generated from live, read-only
Shopify Admin API data for the store **The Ultimate Game Master** (https://theultimategamemaster.com) on 2026-10-24. The store path of each file
in knowDrive equals its path relative to `corpus/`, and KnowBot citations use that path as the filename.

## File format

Each file is markdown with YAML frontmatter:

```
---
title: "Human title"
kind: product | collection | policy | page | article | shop | guide
source: shopify
source_id: gid://shopify/...      (Shopify GID, when applicable)
url: https://theultimategamemaster.com/...   (public storefront URL, when one exists)
updated: 2026-10-24
---
```

HTML from Shopify was converted to markdown; wording is kept verbatim. One entity per file.

## Layout

| Path | Kind | Contents |
|---|---|---|
| `shop/about.md` | shop | Store identity, contact, currency, taxes, wallets, ship-to countries |
| `catalog/index.md` | guide | Catalog overview: counts, product types, price range, every product with its file path |
| `catalog/products/<handle>.md` | product | One active product: price, options, variants (SKU, price, availability, inventory), description, collections |
| `catalog/collections/<handle>.md` | collection | One collection: description and the active products in it |
| `policies/<type>.md` | policy | Refund, shipping, privacy, terms of service, contact information, cancellation (subscription) policies |
| `pages/<handle>.md` | page | Published online-store pages with body content (FAQ, guides, comparison, gallery, etc.) |
| `blog/news/<handle>.md` | article | Published articles from "The UGM Blog"; `blog/news/index.md` lists them |
| `operations/*.md` | shop | Shipping zones & carriers, markets & currencies, fulfillment locations, active automatic promotions |
| `MANIFEST.json` | — | `[{path, title, kind, source_id, url, bytes}]` for every markdown file |

## Counts

- article: 25
- collection: 17
- guide: 2
- page: 9
- policy: 6
- product: 40
- shop: 5
- total markdown files (excluding this README): 104

## Exclusions

- Draft and unlisted products (17) are not included; only `ACTIVE` products are.
- No customer data, orders, or discount codes (codes can be private, per-customer, or wholesale-only). Only
  active *automatic* promotions that apply without a code are described.
- Theme-template pages with no body content in Shopify (contact, accessories, home, the-endless-rime, dungeon-crawl, dungeon-masterclass) are omitted.
