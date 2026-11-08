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

const MAX_ITEMS = 5;

/**
 * Cart permalink: starts a NEW checkout containing exactly these items (it
 * does not merge with anything already in the shopper's cart).
 */
function cartLink(lines, callSid) {
  const { ref } = config.shop;
  const params = utmParams(lines.map((l) => l.handle).join(","));
  params.set("ref", ref); // Shown as the referral code in the order's conversion summary
  if (callSid) params.set("attributes[call]", callSid); // Ties the order to the call log
  return `${config.shop.domain}/cart/${lines.map((l) => `${l.variantId}:${l.quantity}`).join(",")}?${params}`;
}

/** Product page with the same UTM tags, used when no variant can be resolved. */
function productPageLink(handle) {
  return `${config.shop.domain}/products/${handle}?${utmParams(handle)}`;
}

const shortTitle = (title) => String(title).split(/\s+[-–|]\s+/)[0].trim();

/**
 * Resolve one requested item to a purchasable variant.
 * Returns { status: "ok", handle, variantId, title, variant, quantity }, or a
 * status the model can act on ("need_variant", "unavailable", "not_found",
 * "store_unreachable").
 */
async function resolveItem({ product, variant = "", quantity = 1 }) {
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
    console.warn("[shop]", err.message);
    return { status: "store_unreachable", product, handle };
  }
  if (!data) {
    return {
      status: "not_found",
      product,
      reason: `No product matches "${product}". Search the knowledge base for the product, then pass its handle.`,
    };
  }

  const { variant: chosen, options } = matchVariant(data, variant);
  if (!chosen) {
    return {
      status: "need_variant",
      product: shortTitle(data.title),
      reason: "Ask the caller which version they want, then call again with it.",
      valid_options: options,
    };
  }
  if (!chosen.available) {
    return {
      status: "unavailable",
      product: shortTitle(data.title),
      reason: `${chosen.title} is sold out.`,
      in_stock_options: (data.variants || []).filter((v) => v.available).map((v) => v.title),
    };
  }
  return {
    status: "ok",
    handle: data.handle,
    variantId: chosen.id,
    title: shortTitle(data.title),
    variant: chosen.title === "Default Title" ? "" : chosen.title,
    quantity: qty,
  };
}

/**
 * Turn the requested items into one link.
 * Returns { status: "ok", kind: "checkout"|"product_page", url, lines: [{title, variant, quantity}] },
 * or the first item's problem status (plus which item) so the model can ask the caller.
 */
export async function buildProductLink({ items, callSid }) {
  if (!config.shop.domain) return { status: "error", reason: "Product links are not configured (SHOP_DOMAIN)." };
  const wanted = (Array.isArray(items) ? items : []).filter((i) => i?.product).slice(0, MAX_ITEMS);
  if (!wanted.length) return { status: "error", reason: "No products were given." };

  const resolved = await Promise.all(wanted.map(resolveItem));

  // The store couldn't be reached: a single product still gets its (tagged) page.
  const unreachable = resolved.filter((r) => r.status === "store_unreachable");
  if (unreachable.length) {
    if (wanted.length === 1 && unreachable[0].handle) {
      return {
        status: "ok",
        kind: "product_page",
        url: productPageLink(unreachable[0].handle),
        lines: [{ title: unreachable[0].product, variant: wanted[0].variant || "", quantity: 1 }],
      };
    }
    return { status: "error", retryable: true, reason: "The store couldn't be reached." };
  }

  const problemIndex = resolved.findIndex((r) => r.status !== "ok");
  if (problemIndex !== -1) return { ...resolved[problemIndex], item_number: problemIndex + 1 };

  // Merge repeats of the same variant.
  const lines = [];
  for (const r of resolved) {
    const same = lines.find((l) => l.variantId === r.variantId);
    if (same) same.quantity = Math.min(same.quantity + r.quantity, 10);
    else lines.push({ ...r });
  }
  return {
    status: "ok",
    kind: "checkout",
    url: cartLink(lines, callSid),
    lines: lines.map(({ title, variant, quantity }) => ({ title, variant, quantity })),
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

const describeLine = ({ title, variant, quantity = 1 }) =>
  `${quantity > 1 ? `${quantity} x ` : ""}${title}${variant ? `, ${variant}` : ""}`;

export function describeLines(lines) {
  const parts = lines.map(describeLine);
  return parts.length > 1 ? `${parts.slice(0, -1).join("; ")} and ${parts.at(-1)}` : parts[0];
}

export function smsBody({ lines, kind, url }) {
  const what = describeLines(lines);
  const org = config.persona.orgName;
  const verb = lines.length > 1 || lines[0].quantity > 1 ? "are" : "is";
  return kind === "checkout"
    ? `${what} ${verb} in your cart at ${org}. Tap to check out: ${url}`
    : `Here's the ${what} from ${org}: ${url}`;
}
