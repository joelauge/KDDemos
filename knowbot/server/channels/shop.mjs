// Texted product links for the phone channel (ported from the voice-agent demo's src/shop.js, through 86135d1): resolve
// the products (and variants) on a Shopify storefront, then build ONE cart permalink that opens checkout with them in the
// cart, tagged so a sale can be attributed to the call.
//
//   shopDomainFor(target, env) → 'https://store.example' | null
//     a trial bot whose sources came from a Shopify store import (Studio "Import a store", T.flags.storeLast, kept after
//     convert); else a launched bot's own `shopDomain` (set at launch from that import, or by the admin API); else
//     SHOP_DOMAIN, but only for the one bot named by SHOP_DOMAIN_BOT (never server-wide: an unrelated bot must never text
//     another merchant's checkout links). Null means the product-link tool is not offered at all.
//   textableNumber(raw, fromNumber) → E.164 or null: same country as the sending line, no premium-rate / short codes.
//   createShop({ domain, env, orgName, findHandle }) → { buildProductLink, smsBody }
//   describeLines(lines) → "2 x Dice Tray; Playmat, Red / Large and Dice Bag" (SMS text and logs)
//
// One link holds up to 5 products: a Shopify cart permalink /cart/<variant>:<qty>,<variant>:<qty> opens a NEW checkout
// with exactly those items (it doesn't add to, or include, a cart already open on the website). Repeats of one version are
// merged. The first problem item (sold out, needs a version, not found) comes back with its item_number so the agent can
// ask about just that item. Variant ids come from the storefront's public /products/<handle>.js (cached for an hour, one
// retry on 429). If the storefront can't be reached, a single-product link opens the product page instead.
// Attribution on every link: utm_source / utm_medium / utm_campaign / utm_content=<handle>[,<handle>…] (LINK_UTM_* to
// change), plus on checkout links ref=<LINK_REF> (Shopify's referral code in the order's conversion summary) and
// attributes[call]=<CallSid>.

const CACHE_MS = 60 * 60 * 1000;

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** A product handle from a handle, a /products/<handle> URL, or null. */
export function handleFrom(input) {
  const s = String(input || '').trim();
  const fromUrl = s.match(/\/products\/([a-z0-9-]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : null;
}

/** The storefront base: origin plus any path prefix (a store under a sub-path), never a trailing slash. */
const originOf = (u) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); return /^https?:$/.test(x.protocol) ? `${x.origin}${x.pathname.replace(/\/+$/, '')}` : null; } catch { return null; } };

/** Where product links point for this bot, or null (no product links). */
export function shopDomainFor(target, env = {}) {
  const fromImport = shopifyImportUrl(target?.T?.flags || target?.flags);
  if (fromImport) return originOf(fromImport);
  const own = target?.inst?.shopDomain || target?.spec?.shopDomain;
  if (own) return originOf(own);
  const only = String(env.SHOP_DOMAIN_BOT || '').trim().toLowerCase();
  if (env.SHOP_DOMAIN && only && target?.id && String(target.id).toLowerCase() === only) return originOf(String(env.SHOP_DOMAIN).trim());
  return null;
}
/** The storefront a trial's Shopify store import came from (Studio "Import a store"), or null. */
export function shopifyImportUrl(flags) {
  const last = flags?.storeLast;
  return last && last.platform === 'shopify' && last.url ? String(last.url) : null;
}

/** Normalize a spoken or caller-ID number to E.164 (North America default). */
export function toE164(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// Country calling codes: 1 and 7 are one digit, these are two, the rest three (enough to compare a number with the line's).
const CC2 = new Set('20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(' '));
export function countryCodeOf(e164) {
  const d = String(e164 || '').replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(d)) return null;
  if (d[0] === '1' || d[0] === '7') return d[0];
  return CC2.has(d.slice(0, 2)) ? d.slice(0, 2) : d.slice(0, 3);
}
// Premium-rate / shared-cost national prefixes (after the country code) that are never texted.
const PREMIUM = { 44: ['9', '87', '84', '70'], 49: ['900', '137', '138'], 33: ['89', '81', '82'], 34: ['80', '90'], 39: ['89', '4'], 61: ['19'], 64: ['900'], 31: ['900', '909'], 41: ['90'], 353: ['15'] };
/**
 * A number texts may go to: E.164, in the same country as the sending line (TWILIO_FROM_NUMBER; +1 when unknown), never a
 * short code, premium-rate or N11 number. Null otherwise.
 */
export function textableNumber(raw, fromNumber = '') {
  const e = toE164(raw);
  if (!e) return null;
  const cc = countryCodeOf(e);
  if (!cc || cc !== (countryCodeOf(toE164(fromNumber)) || '1')) return null;
  const national = e.slice(1 + cc.length);
  if (national.length < 7) return null;
  if (cc === '1') {
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
    const area = national.slice(0, 3), exch = national.slice(3, 6);
    if (area === '900' || area === '976' || exch === '976' || /^\d11$/.test(area) || /^\d11$/.test(exch)) return null;
    return e;
  }
  if ((PREMIUM[cc] || []).some((p) => national.startsWith(p))) return null;
  return e;
}

/**
 * Pick the variant matching `variantText` (e.g. "brown landscape"): every word of each option value of the chosen variant
 * must appear in the request.
 */
export function matchVariant(product, variantText) {
  const variants = product.variants || [];
  if (variants.length === 1) return { variant: variants[0] };
  const wanted = new Set(words(variantText));
  const matches = variants.filter((v) => [v.option1, v.option2, v.option3].filter(Boolean).every((opt) => words(opt).every((w) => wanted.has(w))));
  if (matches.length === 1) return { variant: matches[0] };
  return { options: variants.map((v) => ({ name: v.title, available: !!v.available })) };
}

const shortTitle = (title) => String(title).split(/\s+[-–|]\s+/)[0].trim();

/** Most products one texted link may hold. */
export const MAX_LINK_ITEMS = 5;
const MAX_QTY = 10;

const describeLine = ({ title, variant, quantity = 1 }) => `${quantity > 1 ? `${quantity} x ` : ''}${title}${variant ? `, ${variant}` : ''}`;
/** "2 x Dice Tray; Playmat, Red / Large and Dice Bag": every item of a link, for the SMS text and the logs. */
export function describeLines(lines = []) {
  const parts = lines.map(describeLine);
  return parts.length > 1 ? `${parts.slice(0, -1).join('; ')} and ${parts.at(-1)}` : parts[0] || '';
}

export function createShop({ domain, env = {}, orgName = 'the store', findHandle = null, fetchImpl = fetch, log = () => {}, utm: utmTags = null } = {}) {
  const cache = new Map(); // handle → { product, at }
  // utmTags: the leads report's tags (knowbot / phone / <bot id>, server/leads.mjs) when link tracking is on for the bot;
  // LINK_UTM_* still win, so an owner's own campaign naming is kept
  const tags = {
    utm_source: env.LINK_UTM_SOURCE || utmTags?.source || 'ai-assistant',
    utm_medium: env.LINK_UTM_MEDIUM || utmTags?.medium || 'sms',
    utm_campaign: env.LINK_UTM_CAMPAIGN || utmTags?.campaign || 'voice-agent',
    ref: env.LINK_REF || 'ai-voice-agent',
  };

  async function fetchProduct(handle) {
    const hit = cache.get(handle);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.product;
    const url = `${domain}/products/${handle}.js`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (res.status === 404) return null;
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`storefront returned ${res.status} for ${handle}`);
      const product = await res.json();
      cache.set(handle, { product, at: Date.now() });
      return product;
    }
    throw new Error(`storefront rate-limited the lookup for ${handle}`);
  }

  const utm = (content) => new URLSearchParams({ utm_source: tags.utm_source, utm_medium: tags.utm_medium, utm_campaign: tags.utm_campaign, utm_content: content });
  /** Cart permalink: a NEW checkout holding exactly these items (it never merges with a cart already open on the site). */
  function cartLink(lines, callSid) {
    const p = utm([...new Set(lines.map((l) => l.handle))].join(','));
    p.set('ref', tags.ref);
    if (callSid) p.set('attributes[call]', callSid);
    return `${domain}/cart/${lines.map((l) => `${l.variantId}:${l.quantity}`).join(',')}?${p}`;
  }
  const productPageLink = (handle) => `${domain}/products/${handle}?${utm(handle)}`;

  /**
   * One requested item → { status: 'ok', handle, variantId, title, variant, quantity }, or a status the model can act on:
   * 'need_variant' | 'unavailable' | 'not_found' (each naming the product), or 'store_unreachable' (internal).
   */
  async function resolveItem({ product, variant = '', quantity = 1 } = {}) {
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), MAX_QTY);
    let handle = handleFrom(product);
    let data = null;
    try {
      if (handle) data = await fetchProduct(handle);
      if (!data && findHandle) {
        handle = await findHandle(String(product || ''));
        if (handle) data = await fetchProduct(handle);
      }
    } catch (e) {
      log(`[shop] ${e.message}`);
      return { status: 'store_unreachable', product: String(product || ''), handle };
    }
    if (!data) return { status: 'not_found', product: String(product || ''), reason: `No product matches "${product}". Search the knowledge base for the product, then pass its handle.` };
    const { variant: chosen, options } = matchVariant(data, variant);
    if (!chosen) return { status: 'need_variant', product: shortTitle(data.title), reason: 'Ask the caller which version they want, then call again with it.', valid_options: options };
    if (!chosen.available) {
      return { status: 'unavailable', product: shortTitle(data.title), reason: `${chosen.title} is sold out.`, in_stock_options: (data.variants || []).filter((v) => v.available).map((v) => v.title) };
    }
    return { status: 'ok', handle: data.handle || handle, variantId: chosen.id, title: shortTitle(data.title), variant: chosen.title === 'Default Title' ? '' : chosen.title, quantity: qty };
  }

  /**
   * The requested items (up to MAX_LINK_ITEMS; the older single { product, variant, quantity } shape too) → ONE link:
   *   { status: 'ok', kind: 'checkout'|'product_page', url, lines: [{ title, variant, quantity }] }
   * or the FIRST problem item's status with its item_number (1-based), so the agent asks about just that item; or 'error'.
   * Repeats of the same version are merged into one line. A single product on an unreachable store gets its product page.
   */
  async function buildProductLink({ items, product, variant = '', quantity = 1, callSid } = {}) {
    if (!domain) return { status: 'error', retryable: false, reason: 'Product links are not set up for this bot.' };
    const list = Array.isArray(items) && items.length ? items : product ? [{ product, variant, quantity }] : [];
    const wanted = list.filter((i) => i && String(i.product || '').trim());
    if (!wanted.length) return { status: 'error', retryable: false, reason: 'No products were given. Pass one entry per product in items.' };
    if (wanted.length > MAX_LINK_ITEMS) return { status: 'error', retryable: false, reason: `One link holds at most ${MAX_LINK_ITEMS} products. Ask the caller which ones to include, or send the rest in a second link.` };

    const resolved = await Promise.all(wanted.map(resolveItem));
    const unreachable = resolved.filter((r) => r.status === 'store_unreachable');
    if (unreachable.length) {
      // a single product still gets its (tagged) product page; several can't be put in one cart without the store
      const u = unreachable[0];
      if (wanted.length === 1 && u.handle) {
        const title = /^https?:\/\//i.test(u.product) ? u.handle.replace(/-/g, ' ') : u.product;
        return { status: 'ok', kind: 'product_page', url: productPageLink(u.handle), lines: [{ title, variant: String(wanted[0].variant || ''), quantity: 1 }] };
      }
      return { status: 'error', retryable: true, reason: "The store couldn't be reached." };
    }
    const bad = resolved.findIndex((r) => r.status !== 'ok');
    if (bad !== -1) return { ...resolved[bad], item_number: bad + 1 };

    const lines = [];
    for (const r of resolved) {
      const same = lines.find((l) => l.variantId === r.variantId);
      if (same) same.quantity = Math.min(same.quantity + r.quantity, MAX_QTY);
      else lines.push({ ...r });
    }
    return { status: 'ok', kind: 'checkout', url: cartLink(lines, callSid), lines: lines.map(({ title, variant: v, quantity: q }) => ({ title, variant: v, quantity: q })) };
  }

  function smsBody({ lines = [], kind, url }) {
    const what = describeLines(lines);
    const verb = lines.length > 1 || (lines[0]?.quantity || 1) > 1 ? 'are' : 'is';
    return kind === 'checkout' ? `${what} ${verb} in your cart at ${orgName}. Tap to check out: ${url}` : `Here's the ${what} from ${orgName}: ${url}`;
  }

  return { buildProductLink, smsBody, domain };
}

/** A product handle named in retrieved text: a "Handle: `x`" field or a /products/<handle> address on the shop's host. */
export function handleInText(text, domain) {
  const s = String(text || '');
  const field = s.match(/Handle:\**\s*`?([a-z0-9]+(?:-[a-z0-9]+)*)`?/i)?.[1];
  if (field) return field.toLowerCase();
  let host = '';
  try { host = new URL(domain).host.replace(/^www\./, ''); } catch {}
  for (const m of s.matchAll(/https?:\/\/([^/\s)]+)\/(?:[a-z-]+\/)?products\/([a-z0-9-]+)/gi)) {
    if (!host || m[1].toLowerCase().replace(/^www\./, '') === host) return m[2].toLowerCase();
  }
  return null;
}
