// KnowBot Studio: where a bot answers, and the one plan. Pure, no DOM, no network:
// imported by app.js (Builder + spec drawer), checkout.js (Launch card + checkout) and golive.js (Set up), and by
// server tests. server/trials.mjs keeps its own copy of SURFACE_IDS (validatePatch); server/test/surfaces.test.mjs
// checks they match. landing.js (a classic script) repeats the ids in its markup (studio/index.html #kl-surf).
//
// Owner pricing rule: ONE plan, $549/month or $5,490/year, first 30 days free, card at signup. It includes three
// tools the owner switches features on and off in:
//   Website        (one embed line):     Chat bubble (webchat), Voice (webvoice), Homepage search (site)
//   KnowBot number (one phone number):   Texts (sms), Calls (phone), WhatsApp (whatsapp)
//   Email          (one inbox address):  Email answers (email)
// Every feature is included: switching one on or off never changes the price. The stored spec.surfaces list (the
// feature ids above) is unchanged, so existing bots map onto the switches with no data loss. The KnowBot number's own
// usage is billed separately (server/numbers.mjs). The price is shown only at the launch/checkout step, after the
// visitor has tested; the landing and the Builder never volunteer it early.
//
// A fourth tool, AI agents (server/agents.mjs): other AI assistants ask the bot (a remote MCP server, a plain HTTP ask)
// and get the same cited answers. Its one switch, "Public answers", is NOT a spec.surfaces id: it is spec.agents.public,
// on unless the owner turns it off (absent = on), so every bot is public to agents by default. Free up to a daily limit
// per bot; past it, the owner's paid agent access (spec.agents.paid) is metered per 1,000 agent answers.

export const SURFACES = [
  { id: 'webchat', label: 'Website chat', feature: 'Chat bubble', tool: 'website', short: 'web chat' },
  { id: 'sms', label: 'SMS', feature: 'Texts', tool: 'number', short: 'SMS' },
  { id: 'whatsapp', label: 'WhatsApp', feature: 'WhatsApp', tool: 'number', short: 'WhatsApp' },
  { id: 'email', label: 'Email', feature: 'Inbox', tool: 'email', short: 'email' },
  { id: 'phone', label: 'Phone calls', feature: 'Calls', tool: 'number', short: 'phone' },
  { id: 'webvoice', label: 'Website voice', feature: 'Voice', tool: 'website', short: 'web voice' },
  // a simple search overlay built from the bot's files, on top of the homepage (one script line): server/site.mjs, site/overlay.js
  { id: 'site', label: 'Homepage search', feature: 'Homepage search', tool: 'website', short: 'site' },
];
export const SURFACE_IDS = SURFACES.map((s) => s.id);
/** The AI agents tool's one switch (spec.agents.public, not a spec.surfaces id). */
export const AGENTS_FEATURE = 'agents';
export const AGENTS_LABEL = 'Public answers';
export const DEFAULT_SURFACES = ['webchat'];

/** The three tools of the plan, each with its features (spec.surfaces ids) in the order the switches show. */
export const TOOLS = [
  { id: 'website', label: 'Website', sub: 'A chat bubble on your site', blurb: 'One line on your site turns on the chat bubble, voice and homepage search.',
    features: ['webchat', 'webvoice', 'site'] },
  { id: 'number', label: 'KnowBot number', sub: 'One phone number', blurb: 'One number for texts, live phone calls and WhatsApp.',
    features: ['sms', 'phone', 'whatsapp'] },
  { id: 'email', label: 'Email', sub: 'One inbox address', blurb: 'Email comes in, a cited answer goes out.',
    features: ['email'] },
  { id: 'agents', label: 'AI agents', sub: 'Answers other AI assistants, with sources', blurb: 'Other AI assistants ask your bot and get the same cited answers. Free up to a daily limit.',
    features: [AGENTS_FEATURE], metered: true },
];
export const TOOL_IDS = TOOLS.map((t) => t.id);
/** The tools whose features are spec.surfaces ids (Website, KnowBot number, Email): the plan's included tools. */
export const SURFACE_TOOLS = TOOLS.filter((t) => t.id !== 'agents');

export const PRICE_MONTH = 549;
export const PRICE_YEAR = 5490;
export const PLAN_NAME = 'KnowBot';

const byId = new Map(SURFACES.map((s) => [s.id, s]));
const toolById = new Map(TOOLS.map((t) => [t.id, t]));
export const surfaceLabel = (id) => byId.get(id)?.label || String(id);
/** "Chat bubble", "Texts", ...: the switch label inside its tool. */
export const featureLabel = (id) => (id === AGENTS_FEATURE ? AGENTS_LABEL : byId.get(id)?.feature || surfaceLabel(id));
/** spec.agents → {public, paid}: public unless turned off, paid off unless turned on. */
export const agentSwitches = (a) => ({ public: !(a && a.public === false), paid: !!(a && a.paid === true) });
export const toolOf = (id) => toolById.get(byId.get(id)?.tool) || null;
export const toolLabel = (id) => toolById.get(id)?.label || String(id);

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

/**
 * The three tools with each feature's switch state for a stored surfaces list (no data loss: every stored id is a
 * feature of exactly one tool). toolSwitches(['webchat','sms']) ->
 * [{ id:'website', on:true, features:[{id:'webchat', label:'Chat bubble', on:true}, ...] }, ...]
 */
export function toolSwitches(list, { agents = null } = {}) {
  const on = new Set(normalizeSurfaces(list));
  if (agentSwitches(agents).public) on.add(AGENTS_FEATURE);
  return TOOLS.map((t) => {
    const features = t.features.map((id) => ({ id, label: featureLabel(id), on: on.has(id) }));
    return { ...t, features, on: features.some((f) => f.on) };
  });
}

/** Switch one feature on or off; the bot keeps at least one feature on (returns null when that would leave none). */
export function setFeature(list, id, on) {
  const cur = normalizeSurfaces(list);
  if (!SURFACE_IDS.includes(id)) return cur;
  const next = on ? normalizeSurfaces([...cur, id]) : cur.filter((x) => x !== id);
  return next.length ? next : null;
}

/** "Website (Chat bubble, Voice) and KnowBot number (Texts)": the tools in use, with their features on. */
export function toolsText(list) {
  const parts = toolSwitches(list).filter((t) => t.on && t.id !== 'agents').map((t) => (t.features.length === 1 ? t.label
    : `${t.label} (${t.features.filter((f) => f.on).map((f) => f.label).join(', ')})`));
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Money as the plan writes it: 549 -> "$549", 5490 -> "$5,490". */
export const money = (n, sym = '$') => `${sym}${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/**
 * The plan: one line, the same price whatever features are switched on.
 * planTotals(['webchat','sms','whatsapp'], 'month') -> { count: 3, each: 549, total: 549, interval: 'month', lines: [{ id: 'knowbot', ... }] }
 * (count is the number of features on; it never changes the total.)
 */
export function planTotals(list, interval = 'month', { month = PRICE_MONTH, year = PRICE_YEAR } = {}) {
  const ids = normalizeSurfaces(list);
  const iv = interval === 'year' ? 'year' : 'month';
  const each = iv === 'year' ? Number(year) || PRICE_YEAR : Number(month) || PRICE_MONTH;
  return { count: ids.length, features: ids, each, total: each, interval: iv, per: iv === 'year' ? 'yr' : 'mo',
    lines: [{ id: 'knowbot', label: `${PLAN_NAME} plan: Website, KnowBot number and Email`, amount: each }] };
}
