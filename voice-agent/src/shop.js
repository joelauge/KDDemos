// Product links for SMS: resolve a product (and variant) on the Shopify
// storefront, then build a cart permalink that adds it to the cart and opens
// checkout, tagged so the sale can be attributed to the voice agent.

import { config } from "./config.js";
import { searchKnowDrive } from "./knowdrive.js";

const productCache = new Map(); // handle -> { product, at }
const CACHE_MS = 60 * 60 * 1000;

const words = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

function handleFrom(input) {
  const s = String(input || "").trim();
  const fromUrl = s.match(/\/products\/([a-z0-9-]+)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : null;
}

/** Fetch /products/<handle>.js from the storefront (public, no auth). */
async function fetchProduct(handle) {
  const cached = productCache.get(handle);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.product;

  const url = `${config.shop.domain}/products/${handle}.js`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 1, 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`storefront returned ${res.status} for ${handle}`);
    const product = await res.json();
    productCache.set(handle, { product, at: Date.now() });
    return product;
  }
  throw new Error(`storefront rate-limited the lookup for ${handle}`);
}

/** Find a product handle from a name by searching the knowledge base. */
async function handleFromKnowledgeBase(name) {
  const passages = await searchKnowDrive(`${name} product handle online store page`, { limit: 6 });
  for (const p of passages) {
    const handle = p.text.match(/Handle:\*\*\s*`([a-z0-9-]+)`/)?.[1] || handleFrom(p.text.match(/https?:\/\/\S+\/products\/[a-z0-9-]+/i)?.[0]);
    if (handle) return handle;
  }
  return null;
}

/**
 * Pick the variant matching `variant` (e.g. "brown landscape"). Every word of
 * each option value of the chosen variant must appear in the request.
 */
function matchVariant(product, variantText) {
  const variants = product.variants || [];
  if (variants.length === 1) return { variant: variants[0] };
  const wanted = new Set(words(variantText));
  const matches = variants.filter((v) =>
    [v.option1, v.option2, v.option3].filter(Boolean).every((opt) => words(opt).every((w) => wanted.has(w))),
  );
  if (matches.length === 1) return { variant: matches[0] };
  return { options: variants.map((v) => ({ name: v.title, available: v.available })) };
}

function utmParams(handle) {
  const { utmSource, utmMedium, utmCampaign } = config.shop;
  return new URLSearchParams({
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    utm_content: handle,
  });
}

/** Cart permalink: adds the variant and goes straight to checkout. */
function cartLink(variantId, quantity, handle, callSid) {
  const { ref } = config.shop;
  const params = utmParams(handle);
  params.set("ref", ref); // Shown as the referral code in the order's conversion summary
  if (callSid) params.set("attributes[call]", callSid); // Ties the order to the call log
  return `${config.shop.domain}/cart/${variantId}:${quantity}?${params}`;
}

/** Product page with the same UTM tags, used when no variant can be resolved. */
function productPageLink(handle) {
  return `${config.shop.domain}/products/${handle}?${utmParams(handle)}`;
}

const shortTitle = (title) => String(title).split(/\s+[-–|]\s+/)[0].trim();

/**
 * Resolve what the caller wants into a link.
 * Returns { status: "ok", url, kind: "checkout"|"product_page", title, variant }
 * or a status the model can act on ("need_variant", "unavailable", "not_found").
 */
export async function buildProductLink({ product, variant = "", quantity = 1, callSid }) {
  if (!config.shop.domain) return { status: "error", reason: "Product links are not configured (SHOP_DOMAIN)." };
  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 10);

  let handle = handleFrom(product);
  let data = null;
  try {
    if (handle) data = await fetchProduct(handle);
    if (!data) {
      handle = await handleFromKnowledgeBase(product);
      if (handle) data = await fetchProduct(handle);
    }
  } catch (err) {
    // Storefront unreachable or rate-limited: fall back to the product page.
    console.warn("[shop]", err.message);
    if (handle) return { status: "ok", kind: "product_page", url: productPageLink(handle), title: product, variant };
    return { status: "error", retryable: true, reason: "The store couldn't be reached." };
  }
  if (!data) {
    return {
      status: "not_found",
      reason: `No product matches "${product}". Search the knowledge base for the product, then pass its handle.`,
    };
  }

  const { variant: chosen, options } = matchVariant(data, variant);
  if (!chosen) {
    return {
      status: "need_variant",
      reason: "Ask the caller which version they want, then call again with it.",
      valid_options: options,
    };
  }
  if (!chosen.available) {
    return {
      status: "unavailable",
      reason: `${chosen.title} is sold out.`,
      in_stock_options: (data.variants || []).filter((v) => v.available).map((v) => v.title),
    };
  }

  return {
    status: "ok",
    kind: "checkout",
    url: cartLink(chosen.id, qty, data.handle, callSid),
    title: shortTitle(data.title),
    variant: chosen.title === "Default Title" ? "" : chosen.title,
    quantity: qty,
  };
}

/** Normalize a spoken or caller-ID number to E.164 (North America default). */
export function toE164(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function smsBody({ title, variant, quantity = 1, kind, url }) {
  const what = `${quantity > 1 ? `${quantity} x ` : ""}${title}${variant ? `, ${variant}` : ""}`;
  const org = config.persona.orgName;
  return kind === "checkout"
    ? `${what} is in your cart at ${org}. Tap to check out: ${url}`
    : `Here's the ${what} from ${org}: ${url}`;
}
