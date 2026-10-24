# Store copy conflicts: what to fix (The Ultimate Game Master)

This is a merchant-facing report, not part of the KnowBot corpus, and it must never be ingested.
It lists the places where the store's published copy contradicts itself or contradicts what checkout and the
product data actually do. It was verified on 2026-10-24 with read-only Shopify Admin API queries:
- product variants and selling plans
- delivery profiles
- automatic discounts
- shop policies
- pages and their bodies
- locations

The canonical cards in `corpus/canonical/` state only the operative truth given in the "Operative truth" column below.

## Conflicts

| # | Topic | Conflicting copy (where) | Operative truth (how verified) | Suggested fix |
|---|---|---|---|---|
| 1 | US free shipping | Shipping policy says "FREE shipping to anywhere in the United States" with no minimum (`policies/shipping.md`). FAQ says "free on US orders over $99" (`pages/avada-faqs.md`). | Free only on US orders of **$100.00 or more**. Verified: in the delivery profile "General profile", the US zone has a "FREE SHIPPING" rate of $0 with condition TOTAL_PRICE ≥ 100.00 USD. | Change the policy and FAQ to "free on US orders of $100 or more". |
| 2 | International shipping cost | Shipping policy says shipping elsewhere is "calculated by weight". | UPS carrier-calculated rates at checkout. There is no flat or free rate (live International zone, UPS services only). | Say "calculated by UPS at checkout". |
| 3 | Ship time | FAQ says "In-stock orders ship within 24 hours". Shipping policy says best effort within 2 business days. | Policy: **2 business days**. Not verifiable in config. | Align the FAQ with the policy (or the reverse). |
| 4 | Return window and terms | FAQ says "30-night risk-free return… full refund, no questions" (`pages/avada-faqs.md`). | Refund policy: **30 days from receipt**. The item must be unused and in original packaging, the return must be approved first, and sale items and gift cards can't be returned. Verified against live refund policy text. | Make the FAQ match the refund policy's conditions. |
| 5 | Privacy contact | Privacy policy says "please call or email us" but gives no phone number. It also lists The Ultimate Game Master, LLC, 1908 Thomes Avenue, Cheyenne WY 82001 (`policies/privacy.md`). The contact policy and the returns address use 13665 E 42 Terr S, Ste F, Independence MO 64055. | Email only, team@theultimategamemaster.com. Verified: shop email and contactEmail are team@; the live contact policy holds only the MO address; the `/pages/contact` page body is empty. | Remove "call" or publish a number. Pick one address, or explain why there are two (registered office vs operations). Add content to the contact page. |
| 6 | Bundle savings | Bundle description says "Save over $50 compared to buying components separately" (`catalog/products/ultimate-bundle*.md`). | Saving is **$41.91** ($361.90 sum of the 10 components at current prices vs $319.99). Verified from live variant prices. The compare-at of $361.90 equals that sum. | Change to "save over $40", or mention the free Masterclass ($299) to justify a bigger claim. |
| 7 | Bundle price on comparison page | Comparison page says "Total Investment: $139 (vs $189 for complete bundle)" (`pages/ultimate-game-master-vs-traditional-dm-screens.md`). | Ultimate Bundle is **$319.99** (live). | Update the figure. |
| 8 | Comparison page arithmetic | The same page says "$90 for Professional Quality" and also "you pay $49 more for the UGM system". Its cost table also uses rounded or illustrative figures ($140 screen and so on). | Screen is $139.99. The page's 3-year figures are illustrative and don't agree with each other. | Fix the arithmetic and label the figures as examples. |
| 9 | Black bundle description | Ultimate Bundle (Black) description lists "Ultimate Game Master Screen (Brown)". | Product title and handle are the Black version. The screen color in the Black bundle is presumably black, but this is **not verifiable** from data. | Correct the description. |
| 10 | Resale vs wholesale | Terms of Service: purchases are "for your own personal or household use and not for commercial resale" (`policies/terms.md`). | Live wholesale programme: automatic discounts Tier 1/2/3 (25/40/50% off at $500/$1,000/$1,500, free shipping to all countries), and the FAQ advertises wholesale. Cards treat resale as allowed for approved wholesale accounts. That is an interpretation. | Add a wholesale exception to the Terms. |
| 11 | Gift card description | Mentions "wood finishes" and "versatile shelving units" (`catalog/products/the-ultimate-game-master-gift-card-...md`). | No such products exist. Screens are PU leather over a metal core (catalog search, all active products). | Rewrite the gift card copy. |
| 12 | Subscriptions not described in product copy | Corpus product files don't say the weekly Everlasting Rime seats are subscriptions. The "Monthly Subscription" collection is empty. | Monday, Wednesday and Thursday products have an Appstle selling plan "Weekly" (billing every 1 week) and `requiresSellingPlan: true`. Drop-In and every other product have none. The monthly versions exist only as DRAFT products. | State "weekly subscription, cancel anytime" on the product pages. Remove or hide the empty monthly collection. |
| 13 | Pricing data error | Magnetic Bar Set compare-at $11.99 is below the price of $17.99, on all 5 variants. | Confirmed live. | Clear or raise the compare-at price. |

## Could not verify, or deliberately not published

- **Phone number.** The shop's *billing address* in Shopify has a phone number. It isn't customer-facing or in the corpus, so it wasn't published. Decide whether a public support line should exist (see #5).
- **Not in any store data:** transit times by service, who pays return shipping for EU withdrawals, import duties, card brands accepted, gift card expiry or balance check, Masterclass length or modules or access period, Everlasting Rime session start times and time zone, Map Pack map count and size.
- **Absence-based statements** in the cards rest on catalog searches, not on an explicit store statement: no paint or miniatures, no loyalty programme, no price matching, no retail store or hours. Local pickup was confirmed not configured at either location.
- **Ship-time claims** (#3) are copy only, with no configuration behind them.
- **Negative inventory.** Untracked digital and service items show negative inventory (e.g. Session Zero Checklist −65). The corpus calls them "not tracked". This was not used.

## Owner review: privacy policy "sold"/"shared" disclosure

The published privacy policy (policies/privacy.md, line 94; Shopify's generated template) says the store **has "sold" and "shared" personal information over the preceding 12 months** for advertising and marketing. The store owner says this is not true of the store's actual practice.

- **Suggested fix:** if the store runs no advertising pixels or cookies that count as a "sale" or "sharing" under US state law (Meta, Google, TikTok and similar), regenerate or edit the privacy policy in Shopify (Settings → Policies) so the disclosure matches. If it does run them, the template wording is the legally required disclosure, and the "Your Privacy Choices" opt-out page should stay.
- **KnowBot's behaviour:** it now attributes the wording to the policy and explains the legal meaning. It never asserts the practice as fact, and it points customers to team@theultimategamemaster.com for specifics.
