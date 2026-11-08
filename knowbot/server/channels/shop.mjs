// Texted product links for the phone channel (ported from the voice-agent demo's src/shop.js): resolve a product (and
// variant) on a Shopify storefront, then build a cart permalink that adds it to the cart and opens checkout, tagged so a
// sale can be attributed to the call.
//
//   shopDomainFor(target, env) → 'https://store.example' | null
//     SHOP_DOMAIN when set; else a trial bot whose sources came from a Shopify store import (Studio "Import a store");
//     else a launched bot's own `shopDomain`. Null means the product-link tool is not offered at all.
//   createShop({ domain, env, orgName, findHandle }) → { buildProductLink, smsBody }
//
// Variant ids come from the storefront's public /products/<handle>.js (cached for an hour). A sold-out version is refused
// with the in-stock alternatives. If the storefront can't be reached, the link opens the product page instead.
// Attribution on every link: utm_source / utm_medium / utm_campaign / utm_content=<handle> (LINK_UTM_* to change), plus
// on checkout links ref=<LINK_REF> (Shopify's referral code in the order's conversion summary) and attributes[call]=<CallSid>.

const CACHE_MS = 60 * 60 * 1000;

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** A product handle from a handle, a /products/<handle> URL, or null. */
export function handleFrom(input) {
  const s = String(input || '').trim();
  const fromUrl = s.match(/\/products\/([a-z0-9-]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : null;
}

const originOf = (u) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };

/** Where product links point for this bot, or null (no product links). */
export function shopDomainFor(target, env = {}) {
  if (env.SHOP_DOMAIN) return originOf(String(env.SHOP_DOMAIN).trim());
  const last = target?.T?.flags?.storeLast;
  if (last && last.platform === 'shopify' && last.url) return originOf(last.url);
  const own = target?.inst?.shopDomain || target?.spec?.shopDomain;
  return own ? originOf(own) : null;
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

export function createShop({ domain, env = {}, orgName = 'the store', findHandle = null, fetchImpl = fetch, log = () => {} } = {}) {
  const cache = new Map(); // handle → { product, at }
  const tags = {
    utm_source: env.LINK_UTM_SOURCE || 'ai-assistant',
    utm_medium: env.LINK_UTM_MEDIUM || 'sms',
    utm_campaign: env.LINK_UTM_CAMPAIGN || 'voice-agent',
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

  const utm = (handle) => new URLSearchParams({ utm_source: tags.utm_source, utm_medium: tags.utm_medium, utm_campaign: tags.utm_campaign, utm_content: handle });
  function cartLink(variantId, quantity, handle, callSid) {
    const p = utm(handle);
    p.set('ref', tags.ref);
    if (callSid) p.set('attributes[call]', callSid);
    return `${domain}/cart/${variantId}:${quantity}?${p}`;
  }
  const productPageLink = (handle) => `${domain}/products/${handle}?${utm(handle)}`;

  /**
   * → { status: 'ok', url, kind: 'checkout'|'product_page', title, variant, quantity }
   *   or a status the model can act on: 'need_variant' | 'unavailable' | 'not_found' | 'error'.
   */
  async function buildProductLink({ product, variant = '', quantity = 1, callSid } = {}) {
    if (!domain) return { status: 'error', retryable: false, reason: 'Product links are not set up for this bot.' };
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 10);
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
      if (handle) return { status: 'ok', kind: 'product_page', url: productPageLink(handle), title: String(product), variant: String(variant || ''), quantity: qty };
      return { status: 'error', retryable: true, reason: "The store couldn't be reached." };
    }
    if (!data) return { status: 'not_found', reason: `No product matches "${product}". Search the knowledge base for the product, then pass its handle.` };
    const { variant: chosen, options } = matchVariant(data, variant);
    if (!chosen) return { status: 'need_variant', reason: 'Ask the caller which version they want, then call again with it.', valid_options: options };
    if (!chosen.available) {
      return { status: 'unavailable', reason: `${chosen.title} is sold out.`, in_stock_options: (data.variants || []).filter((v) => v.available).map((v) => v.title) };
    }
    return { status: 'ok', kind: 'checkout', url: cartLink(chosen.id, qty, data.handle || handle, callSid), title: shortTitle(data.title),
      variant: chosen.title === 'Default Title' ? '' : chosen.title, quantity: qty };
  }

  function smsBody({ title, variant, quantity = 1, kind, url }) {
    const what = `${quantity > 1 ? `${quantity} x ` : ''}${title}${variant ? `, ${variant}` : ''}`;
    return kind === 'checkout' ? `${what} is in your cart at ${orgName}. Tap to check out: ${url}` : `Here's the ${what} from ${orgName}: ${url}`;
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
