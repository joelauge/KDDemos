// KnowBot Studio Builder: the tool registry the tool-using Builder engine (engine.mjs) offers the model.
//
// Every tool mirrors a Studio action the client can execute today (studio/app.js dispatchAction, onChip emit) and is
// validated server-side against the trial state before anything is returned. A tool never performs a side effect
// itself: it returns { ok, action?, patch?, chips?, data?, error? } and the Studio executes the action/patch the way it
// always has (the setup route persists the patch through validatePatch, the client runs the action).
//
// Destructive or paid steps (Start over, checkout, removing files) have NO tool: the model can only offer the launch
// card as a button (open_launch), and the client's own launch flow handles checkout after a human click.
//
// Pure module: no network, no filesystem. validatePatch is injected (server/trials.mjs exports it) so the exact PATCH
// semantics apply; a local mirror of the same rules is used when it is not injected (tests, standalone use).

export const TONES = ['friendly', 'neutral', 'formal'];
export const LENGTHS = ['short', 'normal'];
export const AUDIENCES = ['customers', 'employees', 'students'];
export const CHANNELS = ['sms', 'telephone', 'whatsapp', 'email', 'text', 'voice'];
/** The client actions (studio/app.js dispatchAction) a tool may return. Anything else is dropped. */
export const CLIENT_ACTIONS = new Set(['request_upload', 'attach_samples', 'ask_samplebot', 'run_proof', 'show_launch', 'set_scope', 'open_spec', 'email_capture', 'remove_samples', 'import_store']);
/** Actions the model may never cause directly: they are offered as buttons only (a human click runs them). */
export const OFFER_ONLY_ACTIONS = new Set(['show_launch', 'remove_samples']);
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;

const clip = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).replace(/\s+\S*$/, '')}…`; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------------------------------------ URL validation
const BLOCKED_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|onion|arpa|home\.arpa|svc|cluster\.local|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/**
 * Normalize and validate a website address a visitor typed or pasted ("acme.com/shop", "https://www.acme.co.uk").
 * http/https only, no credentials, default ports only, a public-looking host name (no IP literals, no localhost or
 * private/reserved suffixes, a real TLD). Returns { ok:true, url, host } or { ok:false, error }.
 */
export function normalizeWebsiteUrl(raw) {
  let s = String(raw ?? '').trim().replace(/^[<("'“]+|[>)"'”.,;!?]+$/g, '');
  if (!s) return { ok: false, error: 'no web address given' };
  if (s.length > 2048) return { ok: false, error: 'that web address is too long' };
  if (/\s/.test(s)) return { ok: false, error: 'a web address has no spaces' };
  // "acme.com:8080/shop" is a host and a port, not a scheme
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d+(?:[/?#]|$)/i.test(s)) {
    if (!/:(?:80|443)(?:[/?#]|$)/.test(s)) return { ok: false, error: 'only standard web ports work' };
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return { ok: false, error: 'only http and https web addresses work' };
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'that does not look like a web address' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'only http and https web addresses work' };
  if (u.username || u.password) return { ok: false, error: 'a web address with a login in it cannot be imported' };
  if (u.port && !['80', '443'].includes(u.port)) return { ok: false, error: 'only standard web ports work' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || IPV4.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return { ok: false, error: 'use the site\'s name (like yourshop.com), not an IP address' };
  if (BLOCKED_SUFFIX.test(host) || !host.includes('.')) return { ok: false, error: 'that is not a public website' };
  const labels = host.split('.');
  if (labels.some((l) => !l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) && !/^xn--/.test(l) || /^-|-$/.test(l))) return { ok: false, error: 'that does not look like a web address' };
  if (!/^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/.test(labels[labels.length - 1])) return { ok: false, error: 'that does not look like a web address' };
  u.hash = '';
  return { ok: true, url: u.toString(), host };
}

// ------------------------------------------------------------------------------------------------ spec patches
/** Local mirror of trials.mjs validatePatch for the fields the Builder edits (throws {status:400, message}). */
function mirrorValidate(patch, spec) {
  const bad = (k, msg) => { const e = new Error(`${k}: ${msg}`); e.status = 400; e.field = k; throw e; };
  const str = (k, max, allowEmpty = true) => {
    if (typeof patch[k] !== 'string') bad(k, 'must be a string');
    const t = oneLine(patch[k]);
    if (!allowEmpty && !t) bad(k, 'must not be empty');
    if (t.length > max) bad(k, `must be ${max} characters or fewer`);
    return t;
  };
  const next = { ...spec };
  for (const k of Object.keys(patch)) {
    switch (k) {
      case 'name': next.name = str('name', 40, false); break;
      case 'org': next.org = str('org', 60); break;
      case 'purpose': next.purpose = str('purpose', 200); break;
      case 'greeting': next.greeting = str('greeting', 160); break;
      case 'tone': if (!TONES.includes(patch.tone)) bad('tone', `must be one of ${TONES.join(', ')}`); next.tone = patch.tone; break;
      case 'length': if (!LENGTHS.includes(patch.length)) bad('length', `must be one of ${LENGTHS.join(', ')}`); next.length = patch.length; break;
      case 'audience': if (!AUDIENCES.includes(patch.audience)) bad('audience', `must be one of ${AUDIENCES.join(', ')}`); next.audience = patch.audience; break;
      case 'sources': {
        if (!isObj(patch.sources)) bad('sources', 'must be a map of file id to true/false');
        for (const [id, on] of Object.entries(patch.sources)) if (!/^[\w.:@-]{1,120}$/.test(id) || typeof on !== 'boolean') bad('sources', 'must map file ids to true or false');
        next.sources = { ...(spec.sources || {}) };
        for (const [id, on] of Object.entries(patch.sources)) { if (on) delete next.sources[id]; else next.sources[id] = false; }
        break;
      }
      default: bad(k, 'unknown field');
    }
  }
  const diff = [];
  for (const k of ['name', 'org', 'purpose', 'audience', 'tone', 'length', 'greeting', 'sources']) if (JSON.stringify(spec[k]) !== JSON.stringify(next[k])) diff.push({ field: k, from: spec[k], to: next[k] });
  return { next, diff };
}

// ------------------------------------------------------------------------------------------------ state helpers
export const filesOf = (state) => (Array.isArray(state?.files) ? state.files : []);
export const readyFiles = (state) => filesOf(state).filter((f) => f && f.stage === 'ready' && f.enabled !== false);
const learningFiles = (state) => filesOf(state).filter((f) => f && f.enabled !== false && !['ready', 'failed'].includes(f.stage));
export function quotaOf(state) {
  const total = Number(state?.quota?.bytes) > 0 ? Number(state.quota.bytes) : DEFAULT_QUOTA_BYTES;
  const used = Number(state?.usage?.bytes) || filesOf(state).reduce((s, f) => s + (Number(f.bytes) || 0), 0);
  return { total, used, remaining: Math.max(0, total - used) };
}
const fail = (error, code = 'precondition') => ({ ok: false, code, error });
const chip = (id, label, extra = {}) => ({ id, label: clip(oneLine(label), 60), kind: 'default', ...extra });

// ------------------------------------------------------------------------------------------------ the registry
/** JSON-schema tool definitions (Anthropic Messages API `tools` shape). Descriptions say what the visitor sees. */
export const TOOL_DEFS = [
  { name: 'attach_samples', description: 'Load the sample files (Lumen Bikes, a fictional bike shop) so the visitor can watch a bot learn and answer in about 30 seconds. Only when no sample files are attached yet.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'request_upload', description: "Open the visitor's file picker so they can upload their own files (PDF, Word, PowerPoint, Excel, HTML, Markdown, text, images, audio; 100 MB in total).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'import_website', description: "Open the website import for a public web address the visitor gave (their shop or site). The visitor confirms they own or manage it before anything is read. Pass the address exactly as the visitor wrote it.",
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The web address, e.g. "acme.com" or "https://acme.com/shop".' } }, required: ['url'], additionalProperties: false } },
  { name: 'update_bot', description: "Change the visitor's bot settings. Only the fields the visitor asked for. scope_files limits answers to the named files (names exactly as listed in the state).",
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Bot name, up to 40 characters.' },
      tone: { type: 'string', enum: TONES },
      purpose: { type: 'string', description: 'What the bot is for, up to 200 characters, e.g. "support bot for my kayak rental shop".' },
      org: { type: 'string', description: 'The business or organization, up to 60 characters.' },
      audience: { type: 'string', enum: AUDIENCES },
      greeting: { type: 'string', description: 'First message the bot shows, up to 160 characters.' },
      length: { type: 'string', enum: LENGTHS },
      scope_files: { type: 'array', items: { type: 'string' }, description: 'File names (or ids) the bot may answer from; every other file is switched off.' },
    }, additionalProperties: false } },
  { name: 'ask_bot', description: "Ask the visitor's bot a test question, as if the visitor typed it on the right. run=true asks it now; run=false only offers it as a button. Needs at least one ready file.",
    input_schema: { type: 'object', properties: { question: { type: 'string' }, run: { type: 'boolean' } }, required: ['question'], additionalProperties: false } },
  { name: 'run_proof', description: 'Start the Proof Run: test questions written from the files, plus questions the bot must refuse. Needs at least one ready file.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'open_channels', description: 'Offer a button that opens the Channels sheet (SMS, telephone, WhatsApp, email, text chatbot, voice chatbot), optionally at one channel.',
    input_schema: { type: 'object', properties: { channel: { type: 'string', enum: CHANNELS } }, additionalProperties: false } },
  { name: 'open_developers', description: 'Offer a button that opens the Developers sheet (chat API, keys, code snippets).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'open_launch', description: 'Offer the launch button. It only offers it: the visitor taps it to see the launch card. Never claims anything was bought or launched.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'kb_search', description: 'Search the KnowBot knowledge base for facts about KnowBot itself (pricing, plans, features, channels, languages, data handling, how it works). The ONLY source for product facts. Each result has a number n: cite it as [n] right after the fact.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'offer_choices', description: 'Offer 1 to 4 reply buttons. Each button sends its text as the visitor\'s next message.',
    input_schema: { type: 'object', properties: { chips: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, send: { type: 'string' } }, required: ['label'], additionalProperties: false } } }, required: ['chips'], additionalProperties: false } },
];
export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/** Light schema check against the tool's own JSON schema (types, enums, required, no extra keys). */
export function checkInput(name, input) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return `unknown tool "${name}"`;
  if (!isObj(input)) return 'input must be an object';
  const s = def.input_schema;
  for (const r of s.required || []) if (input[r] == null) return `${r} is required`;
  for (const [k, v] of Object.entries(input)) {
    const p = s.properties[k];
    if (!p) return `unknown field "${k}"`;
    if (v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') return `${k} must be a string`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`;
    if (p.type === 'array' && !Array.isArray(v)) return `${k} must be a list`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

/**
 * createBuilderTools({ validatePatch?, floorMin?, kb?, price? }) -> { defs, names, run(name, input, state, ctx) }.
 * ctx.cite(doc) -> n registers a knowledge-base passage as citation n for this turn (engine.mjs supplies it).
 */
export function createBuilderTools(o = {}) {
  const floorMin = Number(o.floorMin) || 0.7;
  const price = Number(o.price) || 249;
  const kb = o.kb || null;
  function validate(patch, spec) {
    if (typeof o.validatePatch === 'function') {
      const r = o.validatePatch(patch, spec, { floorMin });
      return { diff: r.diff || [] };
    }
    return mirrorValidate(patch, spec);
  }

  const handlers = {
    attach_samples(_in, state) {
      if (state?.spec?.sampleSet || filesOf(state).some((f) => f.sample)) return fail('the sample files are already attached');
      if (quotaOf(state).remaining <= 0) return fail('the 100 MB trial space is full', 'quota');
      return { ok: true, action: { type: 'attach_samples', set: 'lumen-bikes' } };
    },
    request_upload(_in, state) {
      if (quotaOf(state).remaining <= 0) return fail('the 100 MB trial space is full; remove a file first', 'quota');
      return { ok: true, action: { type: 'request_upload' } };
    },
    import_website(input, state) {
      const n = normalizeWebsiteUrl(input.url);
      if (!n.ok) return fail(n.error, 'bad_url');
      const si = state?.storeImport || {};
      if (si.busy) return fail('a website import is already running for this bot', 'busy');
      if (si.left === 0 || si.limited) return fail('too many website imports for now; try again later', 'rate_limited');
      if (quotaOf(state).remaining <= 0) return fail('the 100 MB trial space is full', 'quota');
      return { ok: true, action: { type: 'import_store', url: n.url }, data: { host: n.host } };
    },
    update_bot(input, state) {
      const spec = state?.spec || {};
      const patch = {};
      for (const k of ['name', 'tone', 'purpose', 'org', 'audience', 'greeting', 'length']) if (input[k] != null) patch[k] = typeof input[k] === 'string' ? oneLine(input[k]) : input[k];
      if (Array.isArray(input.scope_files)) {
        const files = filesOf(state);
        if (!files.length) return fail('there are no files to choose from yet');
        const ids = new Set();
        for (const want of input.scope_files) {
          const w = oneLine(want).toLowerCase();
          const f = files.find((x) => String(x.id).toLowerCase() === w || String(x.name || '').toLowerCase() === w)
            || files.find((x) => String(x.name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '') === w.replace(/\.[a-z0-9]+$/, ''));
          if (!f) return fail(`no file named "${clip(want, 60)}"; the files are: ${files.map((x) => x.name).slice(0, 8).join(', ')}`, 'bad_input');
          ids.add(f.id);
        }
        if (!ids.size) return fail('name at least one file', 'bad_input');
        patch.sources = Object.fromEntries(files.map((f) => [f.id, ids.has(f.id)]));
      }
      if (!Object.keys(patch).length) return fail('nothing to change', 'bad_input');
      let diff;
      try { ({ diff } = validate(patch, spec)); } catch (e) { return fail(String(e.message || e).replace(/^\d+\s*/, ''), 'bad_input'); }
      return { ok: true, patch, data: { changed: diff.map((d) => d.field) } };
    },
    ask_bot(input, state) {
      const q = oneLine(input.question);
      if (q.length < 3 || q.length > 300) return fail('the question must be 3 to 300 characters', 'bad_input');
      if (!readyFiles(state).length) return fail('no file is ready yet, so the bot cannot answer');
      const action = { type: 'ask_samplebot', question: q, label: null };
      if (input.run) return { ok: true, action };
      return { ok: true, chips: [chip('ask-bot', `Ask: "${clip(q, 44)}"`, { kind: 'primary', action })], offered: true };
    },
    run_proof(_in, state) {
      if (!readyFiles(state).length) return fail('the Proof Run needs at least one ready file');
      if (state?.proof?.status === 'running') return fail('a Proof Run is already running');
      const learning = learningFiles(state).length;
      return { ok: true, action: { type: 'run_proof', mini: false }, data: learning ? { note: `${learning} file(s) still learning; they are not tested yet` } : {} };
    },
    open_channels(input) {
      const detail = { tab: 'channels', ...(input.channel ? { channel: input.channel } : {}) };
      const label = input.channel ? `Open ${({ sms: 'SMS', telephone: 'Telephone', whatsapp: 'WhatsApp', email: 'Email', text: 'Text chatbot', voice: 'Voice chatbot' })[input.channel]} setup` : 'Open Channels';
      return { ok: true, offered: true, chips: [chip('golive-channels', label, { kind: 'primary', emit: { type: 'golive:open', detail } })] };
    },
    open_developers() {
      return { ok: true, offered: true, chips: [chip('golive-developers', 'Open Developers', { kind: 'primary', emit: { type: 'golive:open', detail: { tab: 'developers' } } })] };
    },
    open_launch(_in, state) {
      if (!filesOf(state).length) return fail('add a file first: a bot needs files before it can launch');
      return { ok: true, offered: true, chips: [chip('launch', `Launch · $${price}/mo`, { kind: 'primary', action: { type: 'show_launch' } })] };
    },
    async kb_search(input, _state, ctx = {}) {
      const q = oneLine(input.query);
      if (q.length < 2 || q.length > 300) return fail('the query must be 2 to 300 characters', 'bad_input');
      if (!kb || typeof kb.search !== 'function') return { ok: true, data: { results: [], note: 'the knowledge base is unavailable; say you do not know and offer a person' } };
      // kb.mjs / local-kb.mjs return { sources:[…] }; a plain array of passages is accepted too
      const r = await kb.search(q, { k: 4, signal: ctx.signal });
      const hits = Array.isArray(r) ? r : Array.isArray(r?.sources) ? r.sources : [];
      const results = hits.slice(0, 4).filter((h) => h && h.text).map((h) => {
        const n = typeof ctx.cite === 'function' ? ctx.cite(h) : null;
        const title = [h.title, h.section].filter(Boolean).join(': ') || h.name || h.id || 'KnowBot';
        return { n, title: clip(oneLine(title), 100), text: clip(oneLine(h.text), 700) };
      });
      return { ok: true, data: { results, ...(results.length ? {} : { note: 'nothing found: say you do not know and offer a person' }) } };
    },
    offer_choices(input) {
      const chips = (Array.isArray(input.chips) ? input.chips : []).slice(0, 4).map((c, i) => {
        const label = clip(oneLine(c?.label), 60);
        const send = clip(oneLine(c?.send || c?.label), 200);
        return label ? chip(`offer-${i}`, label, { send }) : null;
      }).filter(Boolean);
      if (!chips.length) return fail('give at least one button with a label', 'bad_input');
      return { ok: true, offered: true, chips };
    },
  };

  /** Run a tool: schema check, then the precondition handler. Never throws. */
  async function run(name, input, state, ctx = {}) {
    if (!TOOL_NAMES.has(name)) return fail(`unknown tool "${String(name).slice(0, 40)}"; destructive and paid steps are only offered as buttons`, 'unknown_tool');
    const bad = checkInput(name, input ?? {});
    if (bad) return fail(bad, 'bad_input');
    try {
      const r = await handlers[name](input ?? {}, state || {}, ctx);
      // a tool may only ever return client actions the Studio can run; offer-only actions never run directly
      if (r.action && (!CLIENT_ACTIONS.has(r.action.type) || OFFER_ONLY_ACTIONS.has(r.action.type))) return fail('that step can only be offered as a button', 'offer_only');
      return r;
    } catch (e) { return fail(`tool failed: ${String(e.message || e).slice(0, 120)}`, 'error'); }
  }
  return { defs: TOOL_DEFS, names: TOOL_NAMES, run };
}
