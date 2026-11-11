// Product cards under answers (Studio chat, web chat, Homepage search): the bot's product index and photo lookups.
//
// A website import (storeimport.mjs) hands every product page's card ({ url, title, price, compareAt, currency,
// availability, image }) to trials.mjs with the page's file. trials.mjs keeps them per bot as a product index, keyed by
// the product URL (lib productKey), and stores it beside the bot's spec doc in knowDrive (_products.json, tagged
// kind:trial-spec so it is never searched or cited), so it survives restarts and goes away with the bot's files.
//
// At answer time lib productCards() picks the products the answer links or cites (up to 4); a URL the index doesn't
// know is read from the cited product file's own text (the "# Title · URL" head and the price lines). A card with no
// photo may get the page's og:image, fetched here through the importer's SSRF-safe fetcher (same-site only, robots.txt
// honoured, short timeout, cached in memory), never holding an answer for longer than `waitMs`.
//
// Zero dependencies (node: built-ins and our own modules only).
import { productCard, productKey } from '../lib/knowbot.js';
import { createStoreFetcher, productImageOfHtml } from './storeimport.mjs';

export const INDEX_VERSION = 1;
export const INDEX_MAX = 10000;

/** The index as compact JSON ({ v, at, items: [[url, title, price, compareAt, currency, availability, image], …] }). */
export function indexToJson(index, at = new Date()) {
  const items = [];
  for (const c of index.values()) {
    if (items.length >= INDEX_MAX) break;
    items.push([c.url, c.title, c.price ?? null, c.compareAt ?? null, c.currency ?? null, c.availability ?? null, c.image ?? null]);
  }
  return JSON.stringify({ v: INDEX_VERSION, at: new Date(at).toISOString(), items });
}
/** JSON (indexToJson) → Map(productKey → card); bad rows are dropped, never trusted. */
export function indexFromJson(text) {
  const out = new Map();
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { return out; }
  for (const row of Array.isArray(j?.items) ? j.items.slice(0, INDEX_MAX) : []) {
    const [url, title, price, compareAt, currency, availability, image] = Array.isArray(row) ? row : [];
    const card = productCard({ url, title, price, compareAt, currency, availability, image });
    const k = card && productKey(card.url);
    if (k) out.set(k, card);
  }
  return out;
}
/** Add a card to an index (keyed by its product URL); returns the stored card or null. */
export function indexAdd(index, card) {
  const c = productCard(card);
  const k = c && productKey(c.url);
  if (!k || (!index.has(k) && index.size >= INDEX_MAX)) return null;
  index.set(k, c);
  return c;
}

/**
 * Photo lookups for product pages with no photo in the index: GET the page through createStoreFetcher (http(s), public
 * addresses only, the page's own site, robots.txt, `timeoutMs`), read its Product JSON-LD image or og:image. Results
 * are cached in memory for `ttlMs` (a miss for `missTtlMs`); one request per URL at a time.
 * → { find(url) → Promise<url|null>, peek(url) → url|null|undefined (undefined: not looked up yet) }
 */
export function createImageFinder({ net = {}, timeoutMs = 3000, ttlMs = 6 * 3600000, missTtlMs = 10 * 60000, max = 1000, now = () => Date.now() } = {}) {
  const cache = new Map();
  async function lookup(url) {
    const host = new URL(url).hostname;
    const f = createStoreFetcher({ budgetMs: timeoutMs * 2, timeoutMs, maxBytes: 2 * 1024 * 1024, paceMs: 0, maxRetries: 0, maxRedirects: 3, ...net });
    f.allowSite(host);
    const r = await f.get(url, { accept: 'text/html,application/xhtml+xml' });
    if (!/html|xml/i.test(String(r.headers['content-type'] || 'text/html'))) return null;
    return productImageOfHtml(r.text(), r.url || url);
  }
  const fresh = (e) => !!e && now() - e.at < (e.image === null ? missTtlMs : ttlMs);
  function find(url) {
    const k = productKey(url);
    if (!k) return Promise.resolve(null);
    const hit = cache.get(k);
    if (fresh(hit)) return hit.p;
    const p = lookup(url).catch(() => null);
    cache.set(k, { at: now(), p, image: undefined });
    p.then((image) => { const e = cache.get(k); if (e && e.p === p) e.image = image; });
    while (cache.size > max) cache.delete(cache.keys().next().value);
    return p;
  }
  function peek(url) { const e = cache.get(productKey(url)); return fresh(e) ? e.image : undefined; }
  return { find, peek, cache };
}

/** Resolve within `ms` (null after that); the promise itself keeps running. */
export const within = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), Math.max(0, ms));
  t.unref?.();
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
});
