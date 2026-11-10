// KnowBot Studio: answer surfaces (where a bot answers) and the per-surface plan math. Pure, no DOM, no network:
// imported by app.js (Builder + spec drawer) and checkout.js (Launch card + checkout), and by server tests.
// server/trials.mjs keeps its own copy of SURFACE_IDS (validatePatch); server/test/surfaces.test.mjs checks they match.
// landing.js (a classic script) repeats the ids in its markup (studio/index.html #kl-surf).
//
// Owner pricing rule: each answer surface is its own plan line ($249/month or $2,499/year). The price is shown only at
// the launch/checkout step, after the visitor has tested; the landing and the Builder never volunteer it early.

export const SURFACES = [
  { id: 'webchat', label: 'Website chat', short: 'web chat' },
  { id: 'sms', label: 'SMS', short: 'SMS' },
  { id: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp' },
  { id: 'email', label: 'Email', short: 'email' },
  { id: 'phone', label: 'Phone', short: 'phone' },
  { id: 'webvoice', label: 'Web voice assistant', short: 'web voice' },
  // a clean search page built from the bot's files, to use as (or instead of) the homepage: server/site.mjs, site/
  { id: 'site', label: 'Single-page site', short: 'site' },
];
export const SURFACE_IDS = SURFACES.map((s) => s.id);
export const DEFAULT_SURFACES = ['webchat'];
export const PRICE_MONTH = 249;
export const PRICE_YEAR = 2499;

const byId = new Map(SURFACES.map((s) => [s.id, s]));
export const surfaceLabel = (id) => byId.get(id)?.label || String(id);

/** Known ids only, deduped, in canonical order; empty or junk falls back to the default (website chat). */
export function normalizeSurfaces(list, { fallback = true } = {}) {
  const want = new Set(Array.isArray(list) ? list.map((x) => String(x || '').trim().toLowerCase()) : []);
  const out = SURFACE_IDS.filter((id) => want.has(id));
  return out.length || !fallback ? out : [...DEFAULT_SURFACES];
}

/** "Website chat, SMS and WhatsApp" */
export function surfacesText(list) {
  const names = normalizeSurfaces(list).map(surfaceLabel);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Money as the plan writes it: 249 -> "$249", 7497 -> "$7,497". */
export const money = (n, sym = '$') => `${sym}${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/**
 * The plan for a set of surfaces: one line per surface at the per-surface price, and the total.
 * planTotals(['webchat','sms','whatsapp'], 'month') -> { count: 3, each: 249, total: 747, interval: 'month', lines: [...] }
 */
export function planTotals(list, interval = 'month', { month = PRICE_MONTH, year = PRICE_YEAR } = {}) {
  const ids = normalizeSurfaces(list);
  const iv = interval === 'year' ? 'year' : 'month';
  const each = iv === 'year' ? Number(year) || PRICE_YEAR : Number(month) || PRICE_MONTH;
  return { count: ids.length, each, total: each * ids.length, interval: iv, per: iv === 'year' ? 'yr' : 'mo',
    lines: ids.map((id) => ({ id, label: surfaceLabel(id), amount: each })) };
}
