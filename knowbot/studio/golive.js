// KnowBot Studio: Go live (owner E). SPEC 11.2 "Developers" tab and 11.3 "Channels" gallery.
// Lazily imported by checkout.js; renders a dialog into #co-modal-slot. Prefix gl- (golive.css, also owned by E).
//
// Channels: SMS, Telephone, WhatsApp, Email, Text chatbot, Voice chatbot. Each card has what you need, the webhook URL
// prefilled with the bot id, copyable config, and a Try it:
//   - Text chatbot: a working widget that asks this trial bot (POST /api/studio/trials/:id/ask, SSE)
//   - Voice chatbot: mic → Web Speech API recognition → /ask → speech synthesis, live waveform + captions;
//     uses POST /v1/bots/:id/voice (Google STT/TTS) when the server says Google voice is configured
//   - Telephone: the same voice engine as a call simulator (greeting, gather loop, hang up)
//   - SMS / WhatsApp / Email: the real answer formatted exactly like the channel's reply (labelled as a preview)
// Developers: endpoint, trial key, live-tested snippets (curl, JS fetch, JS OpenAI SDK, Python requests, Python OpenAI SDK).
//
// Nothing here calls Twilio, Meta, Google or OpenAI directly. Only the KnowBot server is called.
//
// Two ways in: openGoLive(ctx, {...}) opens it as a sheet (launch, palette); openGoLive(ctx, {inline: el, surfaces})
// renders the same Set up view inside the bot pane (no scrim, no focus trap), with the bot's chosen answer surfaces
// listed first. The phone's Try it is a phone you can call in the browser (./phonesim.js), on the same Gemini Live
// engine and phone prompt as a real call.

import { mountWidget } from './kdw.js?v=cac62cd';
import { mountNumbers, numberCache } from './numbers.js?v=cac62cd';
import { siteSettings } from './sitebrand.js?v=cac62cd';

const NOT_IN_DATA = "I can't seem to find an answer to that in any of my current data sources.";
const SR_CTOR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

let cssPromise = null;
/** Injects golive.css once; resolves when it has loaded (or failed: never blocks the UI). */
export function ensureCss() {
  if (cssPromise) return cssPromise;
  cssPromise = new Promise((resolve) => {
    if (document.querySelector('link[data-gl-css]')) { resolve(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./golive.css?v=cac62cd', import.meta.url).href;
    link.dataset.glCss = '1';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
    setTimeout(resolve, 2500);
  });
  return cssPromise;
}

// ------------------------------------------------------------------ helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 6) => Math.random().toString(36).slice(2, 2 + n);
const stripMarkers = (s) => String(s || '').replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/[ \t]+/g, ' ').trim();
const humanFile = (f) => String(f || 'your files').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);

// small inline glyphs for channels the shared icon set doesn't carry
const GLYPH = {
  sms: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5h-1A1.5 1.5 0 0 1 3 16V7a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 3.8 9 4.4l1.2 4-2 1.6a12 12 0 0 0 5.8 5.8l1.6-2 4 1.2.6 2.4c.2.9-.4 1.8-1.3 2A15.8 15.8 0 0 1 4.6 5.1c.2-.9 1.1-1.5 2-1.3Z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20.2 5.2 16A8.4 8.4 0 1 1 8.4 19Z"/><path d="M9.2 8.6c.2-.5.5-.6.8-.6h.5c.2 0 .4.1.5.4l.7 1.6c.1.2 0 .5-.1.7l-.5.6c-.1.2-.1.4 0 .6.6 1 1.4 1.8 2.4 2.4.2.1.4.1.6 0l.6-.5c.2-.1.5-.2.7-.1l1.6.7c.3.1.4.3.4.5v.5c0 .3-.1.6-.6.8-.6.3-1.6.4-2.9-.2a9 9 0 0 1-4.1-4.1c-.6-1.3-.5-2.3-.2-2.9Z"/></svg>',
  email: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.8 7 8.2 6 8.2-6"/></svg>',
  text: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4M7.5 9h9M7.5 12.5h5.5"/></svg>',
  site: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/><circle cx="11" cy="14" r="2.6"/><path d="m13 16 2.2 2.2"/></svg>',
  voice: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4M7.5 7v10M11 4.5v15M14.5 8v8M18 10.5v3M21 11.5v1"/></svg>',
};

/** Ask the trial bot (same pipeline, same refusal). onDelta(textSoFar). Resolves {text, refused, citations, final, retrieval, ms}. */
async function askBot(ctx, question, { onDelta, signal } = {}) {
  const t0 = performance.now();
  let text = '', retrieval = null;
  const final = await ctx.api.ask({ question, label: null, as: 'customer', versionTag: ctx.store.getState().spec.version }, {
    signal,
    onEvent: (type, data) => {
      if (type === 'retrieval') retrieval = data;
      if (type === 'delta' && data && data.text) { text += (text ? '\n' : '') + data.text; onDelta && onDelta(text, data); }
    },
  });
  return { text: final?.text ?? text, refused: !!final?.refused, citations: final?.citations || [], final, retrieval, ms: Math.round(performance.now() - t0) };
}

// ------------------------------------------------------------------ syntax highlight (tiny, per language)

const KW = {
  js: new Set(['const', 'let', 'await', 'async', 'import', 'from', 'new', 'for', 'of', 'if', 'return', 'true', 'false', 'null', 'break']),
  py: new Set(['import', 'from', 'for', 'in', 'print', 'def', 'return', 'with', 'as', 'True', 'False', 'None', 'if']),
  sh: new Set(['curl', 'export', 'twilio']),
  html: new Set([]),
  text: new Set([]),
};
function highlight(code, lang = 'text') {
  if (lang === 'text') return esc(code);
  if (lang === 'xml') {
    return esc(code).replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, '$1<span class="gl-t-k">$2</span>').replace(/([A-Za-z-]+)=(&quot;[^&]*?&quot;)/g, '<span class="gl-t-a">$1</span>=<span class="gl-t-s">$2</span>');
  }
  if (lang === 'html') {
    return esc(code).replace(/(&lt;\/?)([a-z]+)/g, '$1<span class="gl-t-k">$2</span>').replace(/([a-z-]+)=(&quot;[^&]*?&quot;)/g, '<span class="gl-t-a">$1</span>=<span class="gl-t-s">$2</span>');
  }
  const comment = lang === 'js' ? '\\/\\/[^\\n]*' : '#[^\\n]*';
  const re = new RegExp(`(${comment})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="gl-t-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="gl-t-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="gl-t-n">${esc(m[3])}</span>`;
    else if (m[4]) out += (KW[lang] && KW[lang].has(m[4])) ? `<span class="gl-t-k">${esc(m[4])}</span>` : esc(m[4]);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}
function highlightJson(obj) {
  const s = JSON.stringify(obj, null, 2);
  return esc(s).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g, (all, str, colon, lit, num) => {
    if (str) return colon ? `<span class="gl-t-a">${str}</span>${colon}` : `<span class="gl-t-s">${str}</span>`;
    if (lit) return `<span class="gl-t-k">${lit}</span>`;
    if (num) return `<span class="gl-t-n">${num}</span>`;
    return all;
  });
}

// fixer r3 (D7): long URLs break only after '/', '?' or '&' (a <wbr> each), never inside an id.
function urlParts(u) {
  const out = [];
  for (const piece of String(u).split(/(?<=[/?&])/)) { out.push(document.createTextNode(piece)); out.push(document.createElement('wbr')); }
  out.pop();
  return out;
}

// ------------------------------------------------------------------ channel formatting (what each adapter sends)

function smsReply(r, proofUrl) {
  if (r.refused) return r.text;
  const body = lines(r.text).join(' ').replace(/\s+/g, ' ');
  const link = proofUrl ? ` Proof: ${proofUrl}` : '';
  const max = 320 - link.length;
  let s = body;
  if (s.length > max) { const cut = s.slice(0, max - 1); const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('] ')); s = (at > 80 ? cut.slice(0, at + 1) : cut.replace(/\s+\S*$/, '')) + '…'; }
  return s + link;
}
function smsSegments(s) { const n = s.length; const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅå_ÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(s); const one = gsm ? 160 : 70, many = gsm ? 153 : 67; return n <= one ? 1 : Math.ceil(n / many); }
function footnotes(r) {
  return (r.citations || []).map((c) => `[${c.n}] ${c.file || c.title}${c.locator ? `, ${c.locator}` : ''}${c.excerpt ? `: “${String(c.excerpt).replace(/\s+/g, ' ').slice(0, 110)}${String(c.excerpt).length > 110 ? '…' : ''}”` : ''}`);
}
// fixer r4 (D11): the spoken attribution keeps proper nouns. Port of server/channels/util.mjs lowerLead/properWords:
// only an ordinary sentence opener ("The", "A", "If", "Our", "You", …) is lower-cased after "According to …,"; a first
// word that is part of the bot/org name or the source title, or is followed by another capitalised word, keeps its capital.
const LEAD_LOWER = /^(?:you|your|yours|we|our|ours|they|their|there|it|its|this|that|these|those|the|a|an|all|any|each|every|most|some|no|if|when|after|before|during|within|only|orders?|items?|customers?|refunds?|returns?|shipping|standard|free)$/;
const NAME_SKIP = new Set(['you', 'your', 'we', 'our', 'the', 'a', 'an', 'my', 'it', 'its']);
export function properWords(texts = [], names = []) {
  const out = new Set();
  for (const n of names) for (const w of String(n || '').match(/[A-Za-z][A-Za-z']*/g) || []) if (/^[A-Z]/.test(w) && !NAME_SKIP.has(w.toLowerCase())) out.add(w.toLowerCase());
  for (const t of texts) for (const m of String(t || '').matchAll(/(?:[a-z0-9,;)][ \t]+)([A-Z][a-z']+)\b/g)) out.add(m[1].toLowerCase());
  return out;
}
export function lowerLead(s, proper = new Set()) {
  const w = /^[A-Za-z']+/.exec(s)?.[0] || '';
  if (!w || w.slice(1) !== w.slice(1).toLowerCase()) return s;          // ALLCAPS / CamelCase: keep
  const lw = w.toLowerCase();
  if (!LEAD_LOWER.test(lw) || proper.has(lw)) return s;
  const next = /^[A-Za-z']+\s+([A-Za-z][A-Za-z']*)/.exec(s)?.[1] || '';
  if (/^[A-Z]/.test(next) && !/^(?:I|I'm|I've)$/.test(next)) return s;      // "The Lumen …": a name, keep the capital
  return s.charAt(0).toLowerCase() + s.slice(1);
}
// fixer M r1 (D11): spoken like the server's formatSpoken (server/channels/util.mjs): the librarian voice's quotations
// are what gets read, the courtesy opener/closer and the written "From “X”, under “Y”:" pointer are dropped, and the
// source is said once ("According to …, …"; a second source: "And according to …").
const SPOKEN_COURTESY = /^(?:(?:i think |good news,? |great news,? )?i(?:'ve| have)? found [^.!?]{0,60}|here(?:'s| is) what i found(?: for you)?|(?:i )?hope (?:this|that) helps(?: you)?|feel free to [^.!?]{0,80}|(?:i'm |i am )?happy to help(?: with that)?|glad (?:you asked|to help|i could help)|let me know if you need [^.!?]{0,40}|(?:good|great) question|thanks for asking)[.!]*$/i;
const spokenCourtesy = (t) => { const x = String(t || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); return !x || (x.length <= 140 && !/\d|[$€£¥]|https?:|[“”"]/.test(x) && SPOKEN_COURTESY.test(x)); };
const speakable = (t) => String(t || '').replace(/\[([^\]]+)\]\((?:https?:|mailto:)[^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>]/g, '').replace(/[“”]/g, '').replace(/\s+/g, ' ').trim();
export function spokenItems(text) {
  const out = [];
  for (const l of lines(text)) {
    if (/\bsays\s*\[\d+\]\s*:\s*$/.test(l)) continue;               // "Here's what “X” says [1]:" header, the attribution says it
    const q = [...l.matchAll(/“([^”\n]+)”\s*\[(\d{1,3})\]/g)];
    if (q.length) { for (const m of q) out.push({ n: Number(m[2]), text: m[1] }); continue; }
    for (const sen of l.split(/(?<=[.!?])\s+/)) {
      if (spokenCourtesy(stripMarkers(sen))) continue;
      const n = Number(/\[(\d{1,3})\]/.exec(sen)?.[1]) || null;
      const t = stripMarkers(sen).replace(/^(?:From|In)\s+“[^”]+”(?:,\s*[^:]{0,60})?:\s*/, '');
      if (t) out.push({ n, text: t });
    }
  }
  return out;
}
function spokenText(r, names = []) {
  if (r.refused) return NOT_IN_DATA;
  const cites = r.citations || [];
  const byN = new Map(cites.map((c) => [c.n, c]));
  const items = spokenItems(r.text);
  const proper = properWords([r.text, ...cites.map((x) => x.excerpt)], [...names, ...cites.map((c) => humanFile(c.title || c.file)), ...cites.map((c) => c.title)]);
  const parts = [];
  let lastN = null, said = 0;
  for (const it of items.slice(0, 3)) {
    let s = speakable(it.text);
    if (!s) continue;
    if (!/[.!?]$/.test(s)) s += '.';
    const c = byN.get(it.n) || (said === 0 && !it.n ? cites[0] : null);
    if (c && it.n !== lastN) { parts.push(`${said ? 'And according to' : 'According to'} ${humanFile(c.title || c.file)}, ${lowerLead(s, proper)}`); said++; }
    else parts.push(s);
    lastN = it.n ?? lastN;
  }
  return parts.join(' ') || stripMarkers(lines(r.text).join(' '));
}

// ================================================================== the dialog

let current = null;   // the open go-live dialog (one at a time)
const exampleCache = { trial: null, promise: null };   // one prefilled Try it exchange per trial
const devCache = { info: null, at: 0, promise: null };

/**
 * openGoLive(ctx, {tab:'channels'|'developers', channel?, invoker?, helpers}) -> close()
 * helpers come from checkout.js: {h, copyButton, copyText, lastQA, botName, hueVar, price}.
 */
// answer surface id (studio/surfaces.js) → channel card id
const SURFACE_CH = { webchat: 'text', sms: 'sms', whatsapp: 'whatsapp', email: 'email', phone: 'phone', webvoice: 'voice', site: 'site' };
export function openGoLive(ctx, { tab = 'channels', channel = null, invoker = null, helpers = {}, inline = null, surfaces = null } = {}) {
  if (current && !inline) { current.select(tab, channel); return current.close; }
  const { store, api, motion, icons, slots, announce } = ctx;
  const { getState, setState, emit } = store;
  const icon = (n, s = 16) => icons.icon(n, s);
  const modal = slots.modal || document.getElementById('co-modal-slot');
  const botName = helpers.botName || (() => getState().spec.name || 'Your bot');
  const copyButton = helpers.copyButton;
  const cleanups = [];
  const isMobile = () => matchMedia('(max-width: 899px)').matches;

  const apiBase = (api.BASE || location.origin).replace(/\/+$/, '');
  // Integrator: /v1 is served under /api/v1 too (F); the production Worker only forwards /api/*, so hand out that form.
  // fixer r2 (D11): ONE canonical public base everywhere (cards, snippets, Run, status line). The server reports it in
  // GET …/devkey → endpoints.chat (F hands out the /api/v1 form, which works behind the production Worker too).
  let apiRoot = `${apiBase}/api`;
  const syncRoot = (info) => { const m = info && info.endpoints && /^(https?:\/\/.+?)\/v1\/bots\//.exec(String(info.endpoints.chat || '')); if (m) apiRoot = m[1]; };
  syncRoot(devCache.info);
  /** Path as the visitor should type it, e.g. /api/v1/chat/completions. */
  const pub = (p) => `${apiRoot.replace(/^https?:\/\/[^/]+/, '')}${p}`;
  const siteBase = `${location.origin}${location.pathname.replace(/\/studio(?:\/.*)?$/, '/')}`.replace(/\/?$/, '/');
  const cfg = () => getState().config || {};
  const dev = () => devCache.info || { status: 'loading' };
  const botId = () => dev().botId || getState().trial.id || 'tr_yourbot';
  // CONTRACT-GAP (A/F): the Google voice flag is not in GET /api/studio/config yet. Read defensively from either
  // config.voice / config.channels.voice or the dev-key response; default = browser speech (Web Speech API).
  const googleVoice = () => {
    const c = cfg(); const v = c.voice || c.channels?.voice || dev().voice || {};
    return v.google === true || v.provider === 'google';
  };
  // web voice assistant: the server says which engine runs (GET …/devkey → channels.webVoice)
  const liveVoice = () => !!(dev().channels && dev().channels.webVoice && dev().channels.webVoice.live);
  const webVoiceUrl = () => (dev().channels && dev().channels.webVoice && dev().channels.webVoice.socket) || `${apiRoot.replace(/^http/, 'ws')}/v1/bots/${encodeURIComponent(botId())}/voice/live`;
  const verifyToken = `kb_verify_${rid(10)}`;

  // ------------------------------------------------------------ frame
  const titleId = `gl-title-${rid()}`;
  const close = () => doClose();
  const xBtn = inline ? (helpers.onBack ? h('button', { type: 'button', class: 'gl-back', onclick: () => helpers.onBack() }, h('span', { html: icon('chat', 15) }), 'Back to chat') : null)
    : h('button', { type: 'button', class: 'gl-x', 'aria-label': 'Close channels and API', html: icon('x', 18), onclick: close });
  const idPill = h('span', { class: 'gl-idpill' }, h('span', { class: 'gl-idpill-k' }, 'bot id'), h('code', { class: 'gl-mono' }, botId()));
  // Channels | Developers: KnowDrive's <Tabs> (kdw.js island). The component owns the strip, the selection, the
  // keyboard (ArrowLeft/ArrowRight wrap, Home/End) and the ARIA; each panel's content is the gl-panel element this
  // module builds (once, on first selection) and keeps, so its state survives switching tabs.
  const panels = {};
  const tabLabels = {};
  const TABS = [['channels', 'Channels', 'chat'], ['developers', 'Developers', 'code']];
  for (const [id, label, ic] of TABS) {
    panels[id] = h('div', { class: 'gl-panel', id: `gl-panel-${id}` });
    tabLabels[id] = [h('span', { class: 'gl-tab-ico', html: icon(ic, 15) }), label];
  }
  const tabProps = (value) => ({ label: inline ? 'Set up' : 'Go live', value, onChange: (id) => select(id), tabs: TABS.map(([id]) => ({ id, label: tabLabels[id], content: panels[id] })) });

  const head = h('header', { class: 'gl-head' },
    h('div', { class: 'gl-head-main' },
      h('p', { class: 'gl-eyebrow' }, h('span', { html: icon('rocket', 13) }), inline ? 'Set up' : 'Go live'),
      h('h2', { class: 'gl-title', id: titleId }, inline ? `Set up ${botName()}` : `Put ${botName()} everywhere`),
      h('p', { class: 'gl-sub' }, inline ? 'Pick a place for your bot to answer. Each one has its setup steps and a way to try it right here. ' : 'Same files, same citations, same canonical refusal on every channel. ', idPill)),
    xBtn);
  // the scroller: the tab strip (sticky at its top) and the panels render into it
  const body = h('div', { class: 'gl-body' });
  const tabs = mountWidget(body, 'Tabs', tabProps(tab === 'developers' ? 'developers' : 'channels'));
  cleanups.push(() => tabs.unmount());
  // React could not load (offline vendor files): the panels still show, stacked, without a strip
  tabs.ready.catch(() => { if (!body.childElementCount) body.append(panels.channels, panels.developers); });
  const dialog = inline
    ? h('section', { class: 'gl-sheet gl-inline', 'aria-labelledby': titleId }, head, body)
    : h('div', { class: 'gl-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, head, body);
  const scrim = h('div', { class: 'gl-scrim', 'aria-hidden': 'true', onclick: close });
  const layer = h('div', { class: 'gl-layer' }, scrim, dialog);
  const prevInert = slots.app ? slots.app.inert : false;
  const inv = invoker === false ? null : invoker || document.activeElement;
  const prevSheet = getState().ui.sheet;
  if (inline) {
    inline.append(dialog);
    motion.animate(dialog, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'out' });
  } else {
    modal.append(layer);
    if (slots.app) slots.app.inert = true;
    setState({ ui: { ...getState().ui, sheet: 'golive' } }, 'sheet:golive');
    motion.animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[3], easing: 'out' });
    motion.animate(dialog, isMobile()
      ? [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0, transform: 'translateX(28px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3] + 40, easing: 'spring' });

    // Captured at the document so Esc/Tab work even when focus fell to <body>.
    const onKey = (e) => {
      if (closing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') trap(e, dialog);
    };
    document.addEventListener('keydown', onKey, true);
    cleanups.push(() => document.removeEventListener('keydown', onKey, true));
  }

  const cur = { tab: null, channel: channel || 'sms' };
  const built = { channels: false, developers: false };

  function select(id, ch = null) {
    if (!panels[id]) id = 'channels';
    if (ch) cur.channel = ch;
    const prev = cur.tab;
    cur.tab = id;
    if (tabs.props.value !== id) tabs.update(tabProps(id));
    if (!built[id]) { built[id] = true; (id === 'channels' ? buildChannels : buildDevelopers)(panels[id]); }
    else if (id === 'channels' && ch) selectChannel(ch);
    if (prev && prev !== id) motion.animate(panels[id], [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
    body.scrollTop = 0;
  }
  function trap(e, root) {
    const f = $$('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  let closing = false;
  function doClose() {
    if (closing) return; closing = true;
    for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
    if (inline) { dialog.remove(); return; }
    if (slots.app) slots.app.inert = !!prevInert;
    setState({ ui: { ...getState().ui, sheet: prevSheet === 'golive' ? null : prevSheet || null } }, 'sheet:close');
    const a = motion.animate(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[2], fill: 'forwards' });
    const b = motion.animate(dialog, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: isMobile() ? 'translateY(20px)' : 'translateX(24px)' }], { duration: motion.DUR[2], easing: 'inOut', fill: 'forwards' });
    Promise.all([a.finished, b.finished]).then(() => layer.remove());
    current = null;
    returnFocus();
  }
  /** fixer r2 (D9): back to the invoker; a roving chip (tabindex=-1) hands focus to its toolbar's active item instead. */
  // fixer r3 (D9): never <body>. Invoker if still usable; else the newest launch card's channels control, the BotChip,
  // the Builder composer, the header Launch button.
  function returnFocus() {
    const usable = (n) => !!n && n !== document.body && n !== document.documentElement && n.isConnected && !n.closest('[inert]') && n.getClientRects().length > 0;
    let t = usable(inv) ? inv : null;
    if (t && t.getAttribute('tabindex') === '-1' && !/^(DIALOG|SECTION|ARTICLE|H[1-6])$/.test(t.tagName) && !t.classList.contains('co-launch')) {
      const bar = t.closest('[role="toolbar"], [role="tablist"], [role="radiogroup"]');
      t = (bar && bar.querySelector('[tabindex="0"]')) || null;
    }
    if (!usable(t)) t = [$$('#st-log .co-sum-channels').pop(), document.getElementById('st-botchip'), document.getElementById('st-setup-composer'), document.getElementById('st-price')].find(usable) || null;
    if (t) { try { t.focus({ preventScroll: false }); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------ dev key (shared by both tabs)
  // GET /api/studio/trials/:id/devkey (trial bearer auth) -> {key: kb_trial_…, botId, expiresAt, voice, endpoints,
  // rateLimit, channels}. A network failure leaves the key area in its "unavailable" state (placeholder in snippets).
  function loadDev() {
    if (devCache.info && devCache.info.trial === getState().trial.id && Date.now() - devCache.at < 5 * 60e3) return Promise.resolve(devCache.info);
    if (devCache.promise) return devCache.promise;
    const t = getState().trial;
    devCache.promise = (async () => {
      let info = { status: 'unavailable', trial: t.id };
      try {
        let r = null;
        const res = await fetch(`${apiBase}/api/studio/trials/${encodeURIComponent(t.id || '')}/devkey`, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {}, credentials: 'omit' });
        if (res.ok) r = await res.json(); else info.httpStatus = res.status;
        if (r && typeof r.key === 'string' && /^kb_(trial|live)_/.test(r.key)) info = { status: 'ok', trial: t.id, key: r.key, botId: r.botId || null, expiresAt: r.expiresAt || t.expiresAt || null, voice: r.voice || null, endpoints: r.endpoints || null,
          rateLimit: r.rateLimit || null, channels: r.channels && typeof r.channels === 'object' ? r.channels : null };
      } catch { /* network: unavailable */ }
      devCache.info = info; devCache.at = Date.now(); devCache.promise = null;
      syncRoot(info);
      return info;
    })();
    return devCache.promise;
  }

  // ============================================================ Channels
  const voices = [];   // live voice sessions (stopped on close)
  cleanups.push(() => { for (const v of voices) v.stop(); try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* ignore */ } });

  const CH = () => {
    const id = botId();
    const ch = (name) => `${apiRoot}/v1/channels/${id}/${name}`;
    const embed = `<script type="module" src="${siteBase}lib/embed.js" data-instance="${id}" data-api="${apiBase}"></script>`;
    return mineFirst(phoneByEngine([
      // Owner rule: customer-facing copy never names the phone vendor; it is "your KnowBot number" / "your phone number provider".
      { id: 'sms', name: 'SMS', blurb: 'Customers text a number, your bot texts back with [1] citations and a proof link.', provider: 'KnowBot Messaging', hue: 1, url: ch('sms'), status: 'Needs a KnowBot number', tryLabel: 'Preview an SMS reply',
        needs: ['A KnowBot number that can send and receive texts (or a number from your own phone provider)'],
        steps: ['In your phone number settings, open your number’s messaging setup.', 'Set incoming messages to Webhook, HTTP POST, and paste the URL below.', 'Every request is signature-checked, so only your number can reach your bot.'],
        configs: [
          { label: 'Number settings', lang: 'text', code: `Your number → Messaging\n  A message comes in:  Webhook\n  URL:                 ${ch('sms')}\n  HTTP:                POST` },
        ] },
      { id: 'phone', name: 'Telephone', blurb: 'Callers talk naturally. It answers by voice and names the source: “According to your returns policy…”.', provider: 'Your KnowBot number · live voice', hue: 3, url: ch('voice'), status: 'Needs a KnowBot number', tryLabel: 'Call simulator',
        needs: ['A KnowBot number that can take calls (KnowBot runs the voice for you)'],
        steps: ['In your phone number settings, set incoming calls to Webhook, HTTP POST, with the URL below.',
          'KnowBot picks up and talks with the caller in real time, looking up every answer in your files and naming the source.',
          'Every question asked on a call is logged to your question insights.'],
        configs: [
          { label: 'Number settings', lang: 'text', code: `Your number → Voice\n  A call comes in:  Webhook\n  URL:              ${ch('voice')}\n  HTTP:             POST` },
        ] },
      { id: 'whatsapp', name: 'WhatsApp', blurb: 'Answers in WhatsApp with numbered footnotes.', provider: 'WhatsApp Business', hue: 4, url: ch('whatsapp'), status: 'Needs WhatsApp Business', tryLabel: 'Preview a WhatsApp reply',
        needs: ['A Meta app with WhatsApp Business', 'The app secret (verifies X-Hub-Signature-256) and an access token to reply'],
        steps: ['In Meta for Developers → your app → WhatsApp → Configuration, paste the callback URL below.', 'Use the verify token below for the handshake and subscribe to the messages field.', 'Add the four values to your KnowBot environment.'],
        configs: [
          { label: 'Meta webhook', lang: 'text', code: `WhatsApp → Configuration → Webhook\n  Callback URL:    ${ch('whatsapp')}\n  Verify token:    ${verifyToken}\n  Webhook fields:  messages ✓` },
          { label: 'Environment', lang: 'sh', code: `WHATSAPP_VERIFY_TOKEN=${verifyToken}\nWHATSAPP_APP_SECRET=your_meta_app_secret        # verifies X-Hub-Signature-256\nWHATSAPP_ACCESS_TOKEN=your_meta_access_token     # sends the reply\nWHATSAPP_PHONE_NUMBER_ID=your_phone_number_id` },
        ] },
      // The inbound webhook is authenticated (server/channels/email.mjs): SendGrid/Postmark carry EMAIL_WEBHOOK_SECRET as
      // ?key=… on the URL; Mailgun is verified with its signing key instead. Without either the server answers 403.
      { id: 'email', name: 'Email', blurb: 'Forward support@ to your bot. It replies with footnoted citations and a source list.', provider: 'SendGrid · Postmark · Mailgun', hue: 2, url: `${ch('email')}?key=YOUR_EMAIL_WEBHOOK_SECRET`, status: 'Needs inbound email', tryLabel: 'Preview an email reply',
        needs: ['An inbound-parse service: SendGrid, Postmark or Mailgun', 'An address customers write to, for example support@yourdomain.com', 'EMAIL_WEBHOOK_SECRET on your KnowBot server: SendGrid and Postmark send it as ?key= on the URL (Mailgun uses MAILGUN_SIGNING_KEY instead)'],
        steps: ['Pick a long random secret and set EMAIL_WEBHOOK_SECRET on your KnowBot server (Mailgun: set MAILGUN_SIGNING_KEY).', 'Point your provider\'s inbound webhook at the URL below, with your secret in place of YOUR_EMAIL_WEBHOOK_SECRET.', 'Route the address you want answered (for example support@) to it. Replies quote the source lines.'],
        configs: [
          { label: 'SendGrid', lang: 'text', code: `Settings → Inbound Parse → Add Host & URL\n  Receiving domain:  support.yourdomain.com\n  Destination URL:   ${ch('email')}?key=YOUR_EMAIL_WEBHOOK_SECRET\n  POST the raw, full MIME message:  off` },
          { label: 'Postmark', lang: 'text', code: `Servers → (your server) → Default Inbound Stream → Settings\n  Webhook:  ${ch('email')}?key=YOUR_EMAIL_WEBHOOK_SECRET\n  Include raw email content in JSON payload:  off` },
          { label: 'Mailgun', lang: 'sh', code: `# Verified with your Mailgun webhook signing key (MAILGUN_SIGNING_KEY): no secret in this URL\ncurl -s --user 'api:YOUR_MAILGUN_API_KEY' https://api.mailgun.net/v3/routes \\\n  -F priority=0 \\\n  -F expression='match_recipient("support@yourdomain.com")' \\\n  -F action='forward("${ch('email')}")' \\\n  -F action='stop()'` },
          { label: 'Environment', lang: 'sh', code: 'EMAIL_WEBHOOK_SECRET=a_long_random_secret      # SendGrid / Postmark: ?key= on the webhook URL\nMAILGUN_SIGNING_KEY=your_mailgun_signing_key  # Mailgun: verifies the request signature\n# to send the reply, one of:\nSENDGRID_API_KEY=your_sendgrid_api_key\nPOSTMARK_SERVER_TOKEN=your_postmark_server_token\nEMAIL_FROM=support@yourdomain.com' },
        ] },
      { id: 'text', name: 'Text chatbot', blurb: 'A floating widget or a full-page chat on your site. Paste one line; it goes live after launch. Try it here now.', provider: 'Embed snippet', hue: 0, url: null, status: 'Try it now', tryLabel: 'Try the widget',
        needs: ['Access to your site\'s HTML (or your CMS\'s custom code box)'],
        steps: ['Paste the snippet before </body> on any page.', 'Want it inline? Add data-mode="inline" and data-target="#help".', 'The widget answers with [n] citations and the canonical refusal, like here.'],
        configs: [
          { label: 'Widget', lang: 'html', code: embed },
          { label: 'Inline panel', lang: 'html', code: `<div id="help"></div>\n${embed.replace('<script ', '<script data-mode="inline" data-target="#help" ')}` },
          { label: 'Full-page link', lang: 'text', code: `${siteBase}demo/chat.html?instance=${id}` },
        ] },
      // Web voice assistant (lib/voice-widget.js over GET /v1/bots/:id/voice/live, server/channels/webvoice.mjs): the same
      // live voice engine as the phone. Customer-facing copy never names the voice provider (owner rule).
      { id: 'voice', name: 'Web voice assistant', blurb: 'Visitors talk to your bot from a mic button on your site and hear the answer, with its sources on screen as it speaks.', provider: 'Live voice · on your website', hue: 5, url: webVoiceUrl(), status: 'Try it now', tryLabel: 'Talk to your bot',
        needs: ['Nothing: paste one line on your site (KnowBot runs the voice for you)'],
        steps: ['Paste the embed below on your site: a round button in your orb colour that opens voice mode (the orb moves with the visitor\'s voice).', 'It talks with the visitor in real time, the same live voice as your phone line, and speaks just the answer from your sources; the sources show as links while it speaks.', 'Pick the orb colour below. It applies to voice mode everywhere: this assistant, web chat and homepage search.'],
        configs: [
          // a trial bot needs its trial key in the embed (masked on screen, real on Copy); a launched bot's voice socket is public
          { label: 'Embed (voice)', lang: 'html', secret: true, code: (mode) => `<script type="module" src="${siteBase}lib/embed.js" data-mode="voice"\n        data-api="${apiRoot}" data-bot="${id}" data-name="${String(botName()).replace(/"/g, '&quot;')}"\n        data-key="${keyFor(mode)}"></script>\n<!-- data-target="#id" to place it inline; data-position="left"; data-orb="silver" to override the colour -->` },
          { label: 'Voice socket', lang: 'text', code: `${webVoiceUrl()}\n  → {"type":"start","key":"kb_trial_…"}   then 16 kHz PCM16 mono frames, or {"type":"text","text":"…"}\n  ← ready · transcript · citations · 24 kHz PCM16 speech (live) · answer (browser speech)` },
        ] },
      // Homepage search (server/site.mjs, ../site/overlay.js): a simple search box that hovers over the homepage
      { id: 'site', name: 'Homepage search', blurb: 'A simple search box that hovers over your homepage. Visitors ask anything; answers quote your pages and link to them. They close it with × and see your site as usual.', provider: 'One line on your homepage', hue: 6, url: null, status: 'Try it now', tryLabel: 'On your homepage',
        needs: ['Nothing to connect: it is built from your files', 'Access to your homepage\'s HTML, or your website builder\'s custom code box'],
        steps: ['Check the preview on the right: the search box over your homepage. Press × to see your homepage underneath.',
          'Pick when it shows (first visit or every visit), then press Publish.',
          'Copy the one line under “Add to your homepage” and paste it into your homepage, just before </body>. Save your site.',
          'While your bot is a trial, search engines are asked not to list the hosted link.'],
        configs: [
          { label: 'Homepage line', lang: 'html', code: overlayLine() },
          { label: 'Hosted link', lang: 'text', code: siteLink() },
        ] },
    ]));
  };
  /** Phone calls are Gemini Live voice-to-voice only (GET …/devkey → channels.voice). Texted checkout links are described
   *  only when voice.texts is true (a Shopify store for this bot, texting configured). */
  const mine = new Set((Array.isArray(surfaces) ? surfaces : []).map((x) => SURFACE_CH[x]).filter(Boolean));
  /** The bot's chosen answer surfaces first (in the order the cards were defined), each marked as theirs. */
  function mineFirst(list) {
    if (!mine.size) return list;
    return [...list.filter((c) => mine.has(c.id)).map((c) => ({ ...c, mine: true })), ...list.filter((c) => !mine.has(c.id))];
  }
  function phoneByEngine(list) {
    const v = (dev().channels && dev().channels.voice) || {};
    if (!v.texts) return list;
    return list.map((c) => (c.id !== 'phone' ? c : { ...c,
      needs: [...c.needs, 'Texting enabled on that number, for the checkout links it can send'],
      steps: [...c.steps.slice(0, -1),
        'When a caller wants products, it can text them one link that opens a new checkout with exactly those items in the cart (up to 5 products per link, 3 texts per call).',
        c.steps[c.steps.length - 1]] }));
  }

  let chGrid = null, chDetail = null;
  function buildChannels(panel) {
    panel.innerHTML = '';
    const intro = h('div', { class: 'gl-intro' },
      inline
        ? h('p', null, h('b', null, 'Your bot can answer in 7 places.'), ' Pick one to see how to set it up, and try it right here. Every place uses the same files and shows its sources.')
        : h('p', null, h('b', null, '7 channel templates.'), ' Webhook URLs are prefilled with your bot id. Connect the accounts when you\'re ready; every channel logs to your question insights.'));
    chGrid = h('div', { class: 'gl-chgrid', role: 'list', 'aria-label': 'Channels' });
    chDetail = h('section', { class: 'card gl-chdetail', id: 'gl-chdetail', 'aria-live': 'polite' });
    const list = CH();
    list.forEach((c, i) => {
      const card = h('button', { type: 'button', class: 'card gl-chcard', 'aria-pressed': 'false', 'aria-controls': 'gl-chdetail', dataset: { ch: c.id }, style: { '--gl-hue': `var(--f${c.hue})`, '--i': i } },
        h('span', { class: 'gl-chcard-ico', 'aria-hidden': 'true', html: GLYPH[c.id] }),
        h('span', { class: 'gl-chcard-text' }, h('b', null, c.name, c.mine ? h('span', { class: 'chip violet is-label no-dot gl-mine' }, 'Yours') : null), h('small', null, c.provider)),
        h('span', { class: 'chip gray is-label gl-chcard-status' }, c.status));
      card.addEventListener('click', () => selectChannel(c.id, { user: true }));
      chGrid.append(h('div', { role: 'listitem', class: 'gl-chitem' }, card));
    });
    panel.append(intro, chGrid, chDetail);
    motion.stagger($$('.gl-chcard', chGrid), [{ opacity: 0, transform: 'translateY(10px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'spring', fill: 'backwards' }, 45);
    paintCardStatus();
    selectChannel(cur.channel, { first: true });
    loadDev().then(() => { if (!closing && cur.tab === 'channels') { idPill.querySelector('code').textContent = botId(); paintCardStatus({ animate: true }); renderDetail(cur.channel, { quiet: true }); } });
  }

  // fixer r4 (D11): each card's status comes from the server (GET …/devkey → channels[ch]): configured with nothing
  // missing → green "Ready · send a test"; otherwise the missing settings, by name. No server info → the static hint.
  const CH_KEY = { sms: 'sms', phone: 'voice', whatsapp: 'whatsapp', email: 'email', text: 'chat', voice: 'voiceBot' };
  const TESTABLE = { sms: 'sms', phone: 'voice', whatsapp: 'whatsapp', email: 'email' };
  /** The bot's own KnowBot number (./numbers.js), once it is live: SMS and Telephone are on. */
  const liveNumber = () => {
    const n = numberCache.trial === getState().trial.id ? numberCache.info?.number : null;
    return n && n.state === 'active' ? n : null;
  };
  function chStatus(c) {
    const info = dev().channels && dev().channels[CH_KEY[c.id]];
    const ln = (c.id === 'sms' || c.id === 'phone') ? liveNumber() : null;
    // (calls also need this server's live voice: without it the card keeps saying so)
    if (ln && !(info && !info.configured)) return { tone: ln.out ? 'warn' : 'go', label: ln.out ? 'Out of credit' : `Live · ${ln.display}`, needs: [], known: true, info: null };
    if (!info) return { tone: /Try|Live/.test(c.status) ? 'go' : 'off', label: c.status, needs: null, known: false };
    // KnowBot's own voice settings are never the customer's to set, and the provider is never named on screen
    const needs = Array.isArray(info.needs) ? info.needs.filter((n) => n && !/GEMINI|GOOGLE/i.test(String(n))) : [];
    if (!info.configured && !needs.length) return { tone: 'off', label: 'Coming soon on this server', needs, known: true, info };
    if (info.configured && !needs.length) return { tone: 'go', label: TESTABLE[c.id] ? 'Ready · send a test' : 'Ready · try it now', needs, known: true, info };
    if (info.configured) return { tone: 'warn', label: `Receives · needs ${needs.length === 1 ? '1 setting' : `${needs.length} settings`}`, needs, known: true, info };
    return { tone: 'off', label: needs.length === 1 ? `Needs ${needs[0]}` : needs.length ? `Needs ${needs.length} settings` : c.status, needs, known: true, info };
  }
  function paintCardStatus({ animate = false } = {}) {
    if (!chGrid) return;
    const list = CH();
    for (const b of $$('.gl-chcard', chGrid)) {
      const c = list.find((x) => x.id === b.dataset.ch);
      const el = $('.gl-chcard-status', b);
      if (!c || !el) continue;
      const st = chStatus(c);
      const prov = $('.gl-chcard-text small', b);
      if (prov && prov.textContent !== c.provider) prov.textContent = c.provider; // the phone engine arrives with the dev key
      const was = el.textContent;
      el.textContent = st.label;
      el.className = `chip ${st.tone === 'go' ? 'green' : st.tone === 'warn' ? 'amber' : 'gray'} is-label gl-chcard-status is-${st.tone}`;   // KnowDrive .chip
      // fixer r5 (D9, WCAG 2.5.3): no aria-label; the accessible name is the visible name, provider and status.
      b.removeAttribute('aria-label');
      if (animate && was !== st.label && !motion.reduced()) motion.animate(el, [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'spring' });
    }
  }

  function selectChannel(id, { first = false, user = false } = {}) {
    if (!chGrid) return;
    const prev = cur.channel;
    cur.channel = id;
    for (const b of $$('.gl-chcard', chGrid)) {
      const on = b.dataset.ch === id;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    }
    if (prev !== id || first || !chDetail.firstChild) renderDetail(id, { animate: !first });
    if (user) revealDetail();
  }
  /** fixer r4 (D10): a tap on a card brings its detail into view (below the fold on phones) and, on narrow screens,
   *  moves focus to the detail heading so the tap visibly (and audibly) does something. */
  function revealDetail() {
    const title = chDetail && $('.gl-cd-title', chDetail);
    if (!title) return;
    const narrow = isMobile() || matchMedia('(max-width: 1180px)').matches;
    const br = body.getBoundingClientRect(), hr = chDetail.getBoundingClientRect();
    const visible = hr.top >= br.top - 1 && hr.top + 120 <= br.bottom;
    if (!visible || narrow) {
      requestAnimationFrame(() => {
        try { chDetail.scrollIntoView({ block: 'start', behavior: motion.reduced() ? 'auto' : 'smooth' }); } catch { chDetail.scrollIntoView(); }
        if (narrow) setTimeout(() => { try { title.focus({ preventScroll: true }); } catch { /* ignore */ } }, motion.reduced() ? 0 : 60);
      });
    }
  }

  // "Get your KnowBot number" (./numbers.js): one panel per dialog, moved between the SMS and Telephone cards (one number
  // serves both), so a search or a payment in progress survives switching cards
  let numberEl = null, numberPanel = null;
  function numberBlock() {
    if (!numberEl) {
      numberEl = h('div', { class: 'gl-number' });
      numberPanel = mountNumbers(numberEl, { apiBase, trial: () => getState().trial, icon, announce: (t, p) => announce && announce(t, p),
        onState: () => { if (!closing) paintCardStatus({ animate: true }); } });
      cleanups.push(() => numberPanel?.destroy());
    }
    return numberEl;
  }
  function renderDetail(id, { animate = false, quiet = false } = {}) {
    const c = CH().find((x) => x.id === id) || CH()[0];
    const keep = quiet ? $('.gl-try', chDetail) : null;   // a quiet repaint (dev key arrived) keeps a running Try it
    if (!keep) for (const v of voices.splice(0)) v.stop();
    chDetail.innerHTML = '';
    chDetail.style.setProperty('--gl-hue', `var(--f${c.hue})`);
    const head = h('div', { class: 'gl-cd-head' },
      h('span', { class: 'gl-chcard-ico is-lg', html: GLYPH[c.id] }),
      h('div', null, h('h3', { class: 'gl-cd-title', tabindex: '-1' }, c.name), h('p', { class: 'gl-cd-blurb' }, c.blurb)));
    const left = h('div', { class: 'gl-cd-setup' });
    const ownNumber = c.id === 'sms' || c.id === 'phone';
    if (ownNumber) left.append(numberBlock());
    const st = chStatus(c);
    if (st.known) {
      left.append(h('div', { class: `gl-cd-status is-${st.tone}`, role: 'note' },
        h('span', { class: 'gl-cd-status-dot', 'aria-hidden': 'true' }),
        h('div', null,
          h('b', null, st.tone === 'go' ? 'Ready on this server' : st.tone === 'warn' ? 'Receiving, one step left' : 'Not connected on this server yet'),
          // SMS and Telephone run on a KnowBot number: never show the phone provider's setting names to a customer
          (c.id === 'sms' || c.id === 'phone') && st.tone !== 'go'
            ? h('span', { class: 'gl-cd-needs' }, 'Get your KnowBot number below and texts and calls go live on it.')
            : st.needs && st.needs.length
            ? h('span', { class: 'gl-cd-needs' }, st.tone === 'warn' ? 'To reply, set ' : 'Set ', st.needs.map((n, i) => [i ? (i === st.needs.length - 1 ? ' and ' : ', ') : '', h('code', { class: 'gl-mono' }, n)]), ' in your KnowBot environment.')
            : h('span', { class: 'gl-cd-needs' }, TESTABLE[c.id] ? 'Signatures are checked on every request. Send a signed test event below.' : 'Nothing to connect: it works today.'))));
    }
    left.append(h('h4', { class: 'gl-h4' }, 'What you need'), h('ul', { class: 'gl-needs' }, c.needs.map((n) => h('li', null, h('span', { html: icon('check', 13) }), n))));
    if (c.url) {
      left.append(h('h4', { class: 'gl-h4' }, c.id === 'voice' ? 'Voice endpoint' : 'Webhook URL'),
        h('div', { class: 'gl-url' }, h('span', { class: 'gl-method' }, 'POST'), h('code', { class: 'gl-mono gl-url-v' }, urlParts(c.url)), copyButton(c.url, 'Copy', { what: 'Webhook URL copied', aria: `Copy the ${c.name} ${c.id === 'voice' ? 'voice endpoint' : 'webhook'} URL`, iconOnly: true })));
    }
    if (TESTABLE[c.id]) left.append(h('h4', { class: 'gl-h4' }, 'Test event'), testWebhook(c));
    left.append(h('h4', { class: 'gl-h4' }, ownNumber ? 'Or use a number you already have' : 'Set it up'), h('ol', { class: 'gl-steps' }, c.steps.map((s, i) => h('li', null, h('span', { class: 'gl-step-n' }, String(i + 1)), h('span', null, s)))));
    left.append(h('h4', { class: 'gl-h4' }, 'Copyable config'), codeTabs(c.configs, `gl-cfg-${c.id}`));
    const right = keep || h('div', { class: 'gl-try' });
    if (!keep) buildTry(c, right);
    chDetail.append(head, h('div', { class: 'gl-cd-grid' }, left, right));
    if (animate) motion.animate(chDetail, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'out' });
    if (!quiet && animate) announce(`${c.name} selected.`, 'polite');
  }

  /** fixer r6 (D10): a horizontally scrollable <pre> shows an edge fade where more code is hidden (right, and left once
   *  scrolled), so a phone visitor sees there is more to swipe to. Scroll/resize events only, never a per-frame read. */
  function preBox(pre) {
    const box = h('div', { class: 'gl-prebox' }, pre);
    let raf = 0;
    const sync = () => {
      raf = 0;
      if (!pre.isConnected) return;
      const over = pre.scrollWidth - pre.clientWidth;
      const r = over > 2 && pre.scrollLeft < over - 2, l = over > 2 && pre.scrollLeft > 2;
      if (box.classList.contains('is-fade-r') !== r) box.classList.toggle('is-fade-r', r);
      if (box.classList.contains('is-fade-l') !== l) box.classList.toggle('is-fade-l', l);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(sync); };
    pre.addEventListener('scroll', queue, { passive: true });
    if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(queue); ro.observe(pre); cleanups.push(() => ro.disconnect()); }
    else setTimeout(sync, 0);
    if (typeof MutationObserver === 'function') { const mo = new MutationObserver(queue); mo.observe(pre, { childList: true, subtree: true, characterData: true }); cleanups.push(() => mo.disconnect()); }
    return box;
  }

  /** Tabbed code blocks (role=tablist), each with Copy. */
  function codeTabs(items, idBase) {
    const wrap = h('div', { class: 'gl-code' });
    const bar = h('div', { class: 'gl-code-bar' });
    const tl = h('div', { class: 'gl-code-tabs', role: 'tablist', 'aria-label': 'Config format' });
    const pre = h('pre', { class: 'gl-pre', tabindex: '0' }, h('code'));
    let idx = 0;
    const codeOf = (it, mode) => (typeof it.code === 'function' ? it.code(mode) : it.code);
    const showLab = h('span', null, devState.reveal ? 'Hide key' : 'Show key');
    const show = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small gl-showkey', 'aria-pressed': String(devState.reveal), hidden: true },
      h('span', { html: icon('eye', 14) }), showLab);
    show.addEventListener('click', () => { devState.reveal = !devState.reveal; show.setAttribute('aria-pressed', String(devState.reveal)); showLab.textContent = devState.reveal ? 'Hide key' : 'Show key'; paint(); });
    const paint = () => {
      const it = items[idx];
      pre.firstChild.innerHTML = highlight(codeOf(it, 'display'), it.lang);
      pre.setAttribute('aria-label', `${it.label} config${it.secret && dev().key && !devState.reveal ? ', key hidden' : ''}`);
      show.hidden = !(it.secret && dev().key);
      $$('[role="tab"]', tl).forEach((b, i) => { b.setAttribute('aria-selected', String(i === idx)); b.tabIndex = i === idx ? 0 : -1; });
    };
    items.forEach((it, i) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'gl-code-tab', id: `${idBase}-${i}`, 'aria-controls': `${idBase}-pre` }, it.label);
      b.addEventListener('click', () => { idx = i; paint(); motion.animate(pre.firstChild, [{ opacity: .3 }, { opacity: 1 }], { duration: motion.DUR[2] }); });
      tl.append(b);
    });
    tl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length; paint(); $$('[role="tab"]', tl)[idx].focus();
    });
    pre.id = `${idBase}-pre`;
    if (items.length < 2) tl.hidden = true;
    bar.append(items.length < 2 ? h('span', { class: 'gl-code-label' }, items[0].label) : tl,
      h('div', { class: 'gl-code-tools' }, show, copyButton(() => codeOf(items[idx], 'copy'), 'Copy', { what: 'Config copied', aria: 'Copy this config', iconOnly: true })));
    wrap.append(bar, preBox(pre));
    paint();
    return wrap;
  }

  // ------------------------------------------------------------ Send a test webhook (fixer r4, D11)
  // Like Stripe's "Send test event": the server (POST /api/studio/trials/:id/channels/:ch/test, A) builds a provider-shaped
  // payload, signs it with the channel's own secret, posts it to this bot's real /v1/channels webhook on loopback and
  // returns the raw reply (TwiML or JSON) with its status and latency. Nothing here reaches Twilio, Meta or a mail service.
  function testWebhook(c) {
    const ch = TESTABLE[c.id];
    const out = h('div', { class: 'gl-tw-out', 'aria-live': 'polite' });
    const label = h('span', null, 'Send test webhook');
    const btn = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small gl-tw-btn' }, h('span', { class: 'gl-tw-ico', html: icon('play', 13) }), label);
    const q = () => (exampleExchange()?.question || starterQs()[0] || validatedQ || '');
    const hint = h('small', { class: 'gl-tw-hint' }, ch === 'voice' ? 'A signed incoming call (the reply connects it to live voice)' : ch === 'email' ? 'An inbound e-mail (Postmark shape)' : ch === 'whatsapp' ? 'A signed incoming WhatsApp message' : 'A signed incoming SMS', ch === 'voice' ? '.' : ', asking your first starter question.');
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true; btn.classList.add('is-busy'); label.textContent = 'Sending…';
      out.innerHTML = '';
      out.append(h('div', { class: 'gl-out-skel', role: 'status', 'aria-label': 'Sending the test event' }, h('i'), h('i'), h('i')));
      const t = getState().trial;
      const t0 = performance.now();
      try {
        const res = await fetch(`${apiBase}/api/studio/trials/${encodeURIComponent(t.id || '')}/channels/${ch}/test`, {
          method: 'POST', credentials: 'omit',
          headers: { 'content-type': 'application/json', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
          body: JSON.stringify(q() ? { question: q() } : {}),
        });
        const j = await res.json().catch(() => null);
        if (res.status === 429) throw Object.assign(new Error('rate'), { status: 429, retryAfter: Number(res.headers.get('retry-after')) || null });
        if (!res.ok || !j) throw Object.assign(new Error(j?.error?.message || `HTTP ${res.status}`), { status: res.status, body: j });
        renderTest(out, j, Math.round(performance.now() - t0));
      } catch (err) {
        out.innerHTML = '';
        // CONTRACT-GAP (A): older servers have no test route (404); say so plainly instead of faking a reply.
        const msg = err && err.status === 429 ? `Too many test events. Try again in ${err.retryAfter || 30}s.`
          : err && err.status === 404 ? 'This server has no test-event route yet. Point the provider at the webhook URL above to test it live.'
          : `The test event didn't go through: ${err && err.message ? err.message : 'network error'}.`;
        out.append(h('p', { class: 'gl-out-err', role: 'alert' }, h('span', { html: icon('warn', 14) }), ' ', msg));
      } finally { btn.disabled = false; btn.classList.remove('is-busy'); label.textContent = 'Send another'; }
    });
    return h('div', { class: 'gl-tw' }, h('div', { class: 'gl-tw-row' }, btn, hint), out);
  }
  function renderTest(out, j, rtt) {
    out.innerHTML = '';
    const rs = j.response || {}, rq = j.request || {};
    const ok = rs.status >= 200 && rs.status < 300;
    const isXml = /xml/i.test(rs.contentType || '') || /^\s*</.test(rs.body || '');
    const pretty = rs.json ? null : isXml ? String(rs.body || '').replace(/>\s*</g, '>\n<').replace(/\n(<(?!\/?Response)[^/])/g, '\n  $1') : String(rs.body || '');
    const reqBody = rq.body && typeof rq.body === 'object'
      ? (/urlencoded/.test(rq.contentType || '') ? Object.entries(rq.body).map(([k, v]) => `${k}=${v}`).join('\n') : null)
      : String(rq.body || '');
    const nodes = [
      h('div', { class: 'gl-out-bar' },
        h('span', { class: `gl-status ${ok ? 'is-ok' : 'is-bad'}` }, `${rs.status || '—'}${ok ? ' OK' : ''}`),
        h('code', { class: 'gl-mono' }, `${rq.method || 'POST'} `, urlParts(pub(rq.path || ''))),
        h('span', { class: 'gl-mono gl-out-ms' }, `${j.ms ?? rtt} ms`)),
      h('p', { class: 'gl-tw-meta' },
        j.signed ? h('span', { class: 'gl-tw-chip is-ok' }, h('span', { html: icon('shieldCheck', 12) }), `Signed · ${rq.signature || 'verified'}`) : h('span', { class: 'gl-tw-chip' }, h('span', { html: icon('shield', 12) }), 'Unsigned (no secret configured)'),
        j.provider ? h('span', { class: 'gl-tw-chip' }, String(j.provider)) : null,
        j.question ? h('span', { class: 'gl-tw-q' }, '“', j.question, '”') : null),
      j.skipped ? h('p', { class: 'gl-out-note' }, h('span', { html: icon('info', 13) }), ' ', j.message || 'Test sends are disabled on this server.') : null,
      j.configured === false ? h('p', { class: 'gl-out-note' }, h('span', { html: icon('info', 13) }), ' Not configured on this server, so the adapter answered 503. Set the settings above and send again.') : null,
      j.skipped ? null : h('div', { class: 'gl-code gl-tw-resp' },
        h('div', { class: 'gl-code-bar' }, h('span', { class: 'gl-code-label' }, `Response · ${rs.contentType || 'text/plain'}`),
          h('div', { class: 'gl-code-tools' }, copyButton(() => (rs.json ? JSON.stringify(rs.json, null, 2) : String(rs.body || '')), 'Copy', { what: 'Response copied', aria: 'Copy the raw response', iconOnly: true }))),
        h('pre', { class: 'gl-pre', tabindex: '0', 'aria-label': 'Raw webhook response' }, h('code', { html: rs.json ? highlightJson(rs.json) : highlight(pretty, isXml ? 'xml' : 'text') }))),
      rq.body ? h('details', { class: 'gl-json' }, h('summary', null, `Request body · ${rq.contentType || ''}`),
        h('pre', { class: 'gl-pre', tabindex: '0', 'aria-label': 'Test event request body' }, h('code', { html: reqBody != null ? highlight(reqBody, 'text') : highlightJson(rq.body) }))) : null,
    ].filter(Boolean);
    out.append(...nodes);
    if (!motion.reduced()) motion.stagger(nodes, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 50);
    announce(`Test event: ${rs.status || 'no'} ${ok ? 'OK' : 'response'}${j.signed ? ', signed' : ''}, ${j.ms ?? rtt} milliseconds.`, 'polite');
  }

  // ------------------------------------------------------------ Try it
  function buildTry(c, el) {
    el.append(h('div', { class: 'gl-try-head' }, h('span', { class: 'gl-try-k' }, 'Try it'), h('b', null, c.tryLabel)));
    if (c.id === 'voice') { webVoiceTry(el); return; }
    if (c.id === 'phone') { phoneTry(el); return; }
    if (c.id === 'text') { widgetTry(el); return; }
    if (c.id === 'site') { siteTry(el); return; }
    previewTry(el, c.id);
  }

  function starterQs() {
    const s = getState();
    const qs = [];
    const lq = helpers.lastQA && helpers.lastQA();
    if (lq) qs.push(lq.question);
    for (const q of s.spec.starters || []) qs.push(typeof q === 'string' ? q : q?.q);
    for (const a of [...(s.thread || [])].reverse()) if (a && a.status === 'grounded') qs.push(a.question);
    return [...new Set(qs.filter(Boolean))].slice(0, 3);
  }
  function askForm({ placeholder, button = 'Send', onAsk, chips = true, label = 'Question' }) {
    const id = `gl-in-${rid()}`;
    const input = h('input', { id, class: 'input gl-input', type: 'text', autocomplete: 'off', placeholder, maxlength: '500' });
    const btn = h('button', { type: 'submit', class: 'gl-send', 'aria-label': button }, h('span', { html: icon('send', 15) }));
    const form = h('form', { class: 'gl-askform' }, h('label', { class: 'co-sr', for: id }, label), input, btn);
    form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value.trim(); if (!q) { input.focus(); return; } input.value = ''; onAsk(q); });
    const row = chips ? h('div', { class: 'gl-qchips', role: 'group', 'aria-label': 'Suggested questions' },
      [...starterQs().slice(0, 2), "What's the weather in Paris today?"].map((q) => h('button', { type: 'button', class: 'gl-qchip', onclick: () => onAsk(q) }, q))) : null;
    return { form, input, row, setBusy(b) { btn.disabled = b; form.classList.toggle('is-busy', b); } };
  }

  /**
   * Asks through the developer API (POST /v1/bots/:id/chat with the trial key) so the reply carries the server's real
   * proofUrl, exactly what the channel adapters append. Logged as channel 'studio' (a preview, not a real SMS).
   * Falls back to the Studio /ask stream (no proof link: the preview then says where the link goes, never a fake one).
   */
  async function askChannel(q) {
    const d = await loadDev();
    if (d.status === 'ok') {
      try {
        const t0 = performance.now();
        const path = `/v1/bots/${encodeURIComponent(botId())}/chat`;
        const res = await fetch(`${apiRoot}${path}`, {
          method: 'POST', credentials: 'omit',
          headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ question: q, channel: 'studio' }),
        });
        if (res.status === 429) { const e = new Error('rate'); e.status = 429; e.retryAfter = Number(res.headers.get('retry-after')) || null; throw e; }
        if (res.ok) {
          const j = await res.json();
          if (j && typeof j.answer === 'string') {
            return { text: j.answer, refused: !!j.refused, proofUrl: j.refused ? null : (j.proofUrl || null), ms: Math.round(performance.now() - t0), live: true, req: { method: 'POST', path: pub(path), status: res.status },
              citations: (j.citations || []).map((c, i) => ({ n: c.n ?? i + 1, file: c.file, title: c.title, locator: c.locator, excerpt: c.excerpt })) };
          }
        }
      } catch (err) { if (err && err.status === 429) throw err; /* fall back to /ask */ }
    }
    const r = await askBot(ctx, q);
    return { ...r, proofUrl: null, live: false, req: { method: 'POST', path: `/api/studio/trials/${getState().trial.id || '…'}/ask`, status: 200, fallback: true } };
  }

  // fixer r4 (D11): every Try it opens on one real, cited exchange from this trial bot. The visitor's own last cited
  // answer is used when there is one (no request); otherwise one validated starter is asked once per trial and cached.
  function getExample() {
    const own = exampleExchange();
    if (own) return Promise.resolve(own);
    const tid = getState().trial.id || '';
    if (exampleCache.trial === tid && exampleCache.promise) return exampleCache.promise;
    exampleCache.trial = tid;
    exampleCache.promise = (async () => {
      let q = starterQs()[0] || validatedQ;
      if (!q) { try { const r = await ctx.api.questions?.(); q = r?.starters?.[0]?.q || r?.proof?.[0]?.q || null; } catch { /* none */ } }
      if (!q) return null;
      try {
        const r = await askChannel(q);
        if (!r || r.refused || !(r.citations || []).length) return null;
        return { question: q, r: { ...r, proofUrl: r.proofUrl || null } };
      } catch { return null; }
    })();
    exampleCache.promise.then((v) => { if (!v) exampleCache.promise = null; });
    return exampleCache.promise;
  }

  // SMS / WhatsApp / Email previews: the real answer, formatted the way the adapter sends it.
  function previewTry(el, kind) {
    const screen = h('div', { class: `gl-prev gl-prev-${kind}`, 'aria-live': 'polite', role: 'region', tabindex: '0', 'aria-label': `${kind === 'sms' ? 'SMS' : kind === 'whatsapp' ? 'WhatsApp' : 'Email'} preview, scrollable` });
    const meta = h('p', { class: 'gl-prev-meta' });
    const name = botName();
    const intro = {
      sms: [h('p', { class: 'gl-bub is-in' }, `Hi! Text me a question about ${getState().spec.org || name}.`)],
      whatsapp: [h('div', { class: 'gl-wa-head' }, h('span', { class: 'gl-wa-ava' }, (name[0] || 'B').toUpperCase()), h('b', null, name), h('small', null, 'business account'))],
      email: [],
    }[kind];
    screen.append(...intro);
    const ex = exampleExchange();
    const loadingEx = ex ? null : h('div', { class: 'gl-ex-loading', role: 'status', 'aria-label': 'Loading an example from your trial bot' }, h('span', { class: 'gl-ex-tag' }, 'Example from your trial bot'), h('i'), h('i'), h('i', { class: 'is-short' }));
    if (loadingEx) screen.append(loadingEx);
    const af = askForm({ placeholder: kind === 'email' ? 'Customer email, e.g. “Hi, how long is the warranty?”' : kind === 'sms' ? 'Text your bot…' : 'Message…', button: 'Send', label: `${kind === 'email' ? 'Email' : 'Message'} to your bot`, onAsk });
    el.append(h('div', { class: `gl-device gl-device-${kind}` }, screen), af.form, af.row, meta,
      h('p', { class: 'gl-note' }, h('span', { html: icon('info', 13) }), kind === 'email' ? 'Preview: answered by your trial bot, formatted as the email reply. Live once your inbound webhook points here.' : `Preview: answered by your trial bot, formatted exactly as the ${kind === 'sms' ? 'SMS' : 'WhatsApp'} reply. Live once ${kind === 'sms' ? 'your number' : 'WhatsApp'} points at the webhook.`));
    const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    function putQuestion(q, now) {
      if (kind === 'email') {
        screen.append(h('div', { class: 'gl-mail is-in' }, h('div', { class: 'gl-mail-h' }, h('b', null, 'customer@example.com'), h('small', null, `to support@ · ${now}`)), h('p', { class: 'gl-mail-s' }, 'Question'), h('p', null, q)));
      } else screen.append(h('p', { class: 'gl-bub is-out' }, q));
    }
    // fixer r2 (D11): the pane is never empty: one real exchange from this trial bot (its last cited answer, no new
    // request, nothing logged twice) is shown in the channel's format, labelled as an example.
    let asked = false;
    function showExample(x) {
      if (loadingEx) loadingEx.remove();
      if (asked || !el.isConnected) return;
      if (!x) { if (kind === 'email') screen.append(h('p', { class: 'gl-mail-empty' }, 'Write a customer email below to see the reply your bot sends.')); return; }
      const now = stamp();
      const mark = screen.childElementCount;
      screen.append(h('span', { class: 'gl-ex-tag' }, 'Example from your trial bot'));
      putQuestion(x.question, now);
      putReply(x.r, now);
      meta.textContent = `${meta.textContent} · ask your own below`;
      if (!ex && !motion.reduced()) motion.stagger([...screen.children].slice(mark), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 70);
    }
    if (ex) showExample(ex); else getExample().then(showExample);
    async function onAsk(q) {
      asked = true;
      if (loadingEx) loadingEx.remove();
      af.setBusy(true);
      if (kind === 'email') screen.innerHTML = '';
      const now = stamp();
      putQuestion(q, now);
      const typing = h('p', { class: 'gl-bub is-in is-typing', role: 'status', 'aria-label': `${name} is typing` }, h('i'), h('i'), h('i'));
      screen.append(typing);
      screen.scrollTop = screen.scrollHeight;
      try {
        const r = await askChannel(q);
        typing.remove();
        putReply(r, now);
        const last = screen.lastElementChild;
        motion.animate(last, [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'spring' });
      } catch (err) {
        typing.remove();
        screen.append(h('p', { class: 'gl-bub is-err', role: 'alert' }, err && err.status === 429 ? `That's a lot of questions at once. Try again in ${err.retryAfter || 10}s.` : "Couldn't reach your bot. Your question wasn't lost."));
        af.input.value = q;
      } finally { af.setBusy(false); screen.scrollTop = screen.scrollHeight; }
    }
    function putReply(r, now) {
        const proofLink = (u) => h('a', { class: 'gl-prooflink', href: u, target: '_blank', rel: 'noopener' }, u);
        const proofChip = (u) => (u
          ? h('a', { class: 'gl-proofchip', href: u, target: '_blank', rel: 'noopener', title: `Proof link: ${u}` }, h('span', { html: icon('link', 11) }), 'proof · ', ((m) => (m ? m[1] + m[2] : String(u).replace(/^https?:\/\//, '')))(/^https?:\/\/([^/]+).*?(\/p\/[^?#]+)/.exec(String(u))))
          : h('span', { class: 'gl-proofchip is-ph', title: 'The live SMS adds a short proof link here' }, h('span', { html: icon('link', 11) }), 'proof link · added on the live line'));
        const noProof = !r.refused && !r.proofUrl;
        if (kind === 'sms') {
          const s = smsReply(r, r.proofUrl);
          const bub = h('p', { class: 'gl-bub is-in' });
          if (r.proofUrl && s.endsWith(r.proofUrl)) bub.append(s.slice(0, -r.proofUrl.length).replace(/\s*Proof:\s*$/, ' '), proofChip(r.proofUrl));
          else bub.append(s);
          if (noProof) bub.append(' ', proofChip(null));
          screen.append(bub);
          const seg = smsSegments(s);
          meta.textContent = `${s.length}/320 characters · ${seg} SMS segment${seg === 1 ? '' : 's'}${noProof ? ' before the proof link' : ''} · ${r.refused ? 'canonical refusal' : `${r.citations.length} citation${r.citations.length === 1 ? '' : 's'}`}${r.ms ? ` · ${r.ms} ms` : ''}`;
        } else if (kind === 'whatsapp') {
          const body = r.refused ? r.text : lines(r.text).join('\n');
          const fn = r.refused ? [] : footnotes(r);
          screen.append(h('div', { class: 'gl-bub is-in gl-wa' }, h('p', null, body), fn.length ? h('p', { class: 'gl-wa-fn' }, fn.join('\n')) : null,
            r.proofUrl ? h('p', { class: 'gl-wa-fn' }, 'See the exact quotes: ', proofLink(r.proofUrl)) : noProof ? h('p', { class: 'gl-wa-fn gl-proof-ph' }, 'See the exact quotes: proof link added here on the live line') : null,
            h('small', { class: 'gl-wa-t' }, now)));
          meta.textContent = `${r.refused ? 'Canonical refusal' : `${fn.length} footnote${fn.length === 1 ? '' : 's'}`}${r.ms ? ` · ${r.ms} ms` : ''}`;
        } else {
          const fn = r.refused ? [] : footnotes(r);
          screen.append(h('div', { class: 'gl-mail is-out' },
            h('div', { class: 'gl-mail-h' }, h('b', null, `${name} <support@yourdomain.com>`), h('small', null, `Re: Question · ${now}`)),
            h('p', null, 'Hi,'),
            ...(r.refused ? [h('p', null, r.text)] : lines(r.text).map((l) => h('p', null, l))),
            fn.length ? h('div', { class: 'gl-mail-src' }, h('b', null, 'Sources'), h('ol', null, fn.map((f) => h('li', null, f.replace(/^\[\d+\]\s*/, ''))))) : null,
            r.proofUrl ? h('p', null, 'See every quote in context: ', proofLink(r.proofUrl)) : noProof ? h('p', { class: 'gl-proof-ph' }, 'See every quote in context: proof link added here on the live line') : null,
            h('p', { class: 'gl-mail-sig' }, `— ${name} · answers only from ${getState().spec.org || 'our'} files`)));
          meta.textContent = `${r.refused ? 'Canonical refusal' : `${fn.length} source${fn.length === 1 ? '' : 's'} quoted`}${r.ms ? ` · ${r.ms} ms` : ''}`;
        }
    }
  }
  /** The visitor's last cited answer from the store thread, as an askChannel()-shaped reply (no network). */
  function exampleExchange() {
    const th = getState().thread || [];
    const ok = (a) => a && a.status === 'grounded' && a.final && !a.final.refused && typeof a.final.text === 'string' && (a.final.citations || []).length;
    const a = [...th].reverse().find((x) => ok(x) && x.by !== 'proof') || [...th].reverse().find(ok);
    if (!a) return null;
    return { question: a.question, r: { text: a.final.text, refused: false, proofUrl: null, live: false, ms: Number(a.ms || a.final.ms || a.final.latencyMs) || 0,
      citations: a.final.citations.map((c, i) => ({ n: c.n ?? i + 1, file: c.file, title: c.title, locator: c.locator, excerpt: c.excerpt })) } };
  }

  // Text chatbot: a working widget (streams deltas, [n] chips open the quoted excerpt inline).
  // ------------------------------------------------------------ Homepage search: preview, edit, publish, download
  const siteLink = () => `https://knowbot.knowdrive.ai/site/?bot=${encodeURIComponent(botId())}`;
  function overlayLine() { return `<script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="${encodeURIComponent(botId())}" async></script>`; }
  function siteTry(el) {
    const t = getState().trial;
    const url = `${apiBase}/api/studio/trials/${encodeURIComponent(t.id || '')}/site`;
    const auth = { authorization: `Bearer ${t.token}` };
    const status = h('p', { class: 'gl-sp-status', role: 'status', 'aria-live': 'polite' }, 'Building your page from your files…');
    const box = h('div', { class: 'gl-sp' });
    el.append(box, status);
    let v = null;
    const call = async (method, body) => {
      const r = await fetch(url, { method, credentials: 'omit', headers: body ? { ...auth, 'content-type': 'application/json' } : auth, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || "Couldn't save that. Try again.");
      return j;
    };
    call('GET').then((j) => { v = j; paint(); status.textContent = ''; }).catch(() => { status.textContent = "Your page couldn't be built right now. Try again in a moment."; });
    function frame() {
      const f = h('div', { class: 'gl-sp-frame' }, h('p', { class: 'gl-note' }, 'Loading the preview…'));
      loadDev().then((d) => {
        if (d.status !== 'ok' || !f.isConnected) return;
        const page = new URL('../site/', location.href);
        page.searchParams.set('bot', d.botId);
        if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(apiBase)) page.searchParams.set('api', apiBase);
        page.hash = `k=${encodeURIComponent(d.key)}`;
        f.replaceChildren(h('iframe', { title: `Preview: ${v.site.name} search over your homepage`, src: page.href, loading: 'lazy', referrerpolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms' }));
      });
      return f;
    }
    function paint() {
      const s = v.site;
      const showChips = h('input', { type: 'checkbox', id: 'gl-sp-chipson' });
      showChips.checked = !!s.showChips;
      const chips = (s.chips || []).map((c) => ({ ...c }));
      const list = h('ul', { class: 'gl-sp-chips', 'aria-label': 'Topic buttons' });
      const paintChips = () => {
        list.replaceChildren(...chips.map((c, i) => {
          const inp = h('input', { class: 'input gl-input', type: 'text', maxlength: '40', value: c.label, 'aria-label': `Topic ${i + 1} name (asks: ${c.q})`, title: `Asks: ${c.q}` });
          inp.addEventListener('input', () => { c.label = inp.value; });
          return h('li', null, inp, h('button', { type: 'button', class: 'btn btn-ghost gl-sp-x', 'aria-label': `Remove topic ${c.label}`, onclick: () => { chips.splice(i, 1); paintChips(); } }, '✕'));
        }));
        if (!chips.length) list.append(h('li', { class: 'gl-note' }, 'No topic buttons. Add one below.'));
      };
      paintChips();
      const add = h('input', { id: 'gl-sp-add', class: 'input gl-input', type: 'text', maxlength: '140', placeholder: 'A question, e.g. What are your opening hours?' });
      const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { const q = add.value.trim(); if (!q || chips.length >= 8) return; chips.push({ label: q.length > 40 ? `${q.slice(0, 38)}…` : q, q }); add.value = ''; paintChips(); } }, 'Add topic');
      const chipBox = h('div', { class: 'gl-sp-chipbox' }, list, h('label', { class: 'co-sr', for: 'gl-sp-add' }, 'New topic question'), h('div', { class: 'gl-sp-addrow' }, add, addBtn));
      chipBox.hidden = !showChips.checked;
      showChips.addEventListener('change', () => { chipBox.hidden = !showChips.checked; });
      const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
      const form = h('form', { class: 'gl-sp-form' },
        h('label', { class: 'gl-sp-opt', for: 'gl-sp-chipson' }, showChips, h('span', null, 'Show topic buttons under the search box')),
        chipBox,
        h('div', { class: 'gl-sp-actions' }, save));
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); save.disabled = true; status.textContent = 'Saving…';
        try { v = await call('POST', { showChips: showChips.checked, chips: chips.filter((c) => c.label.trim()).map((c) => ({ label: c.label.trim(), q: c.q })) }); paint(); status.textContent = 'Saved. The preview shows your changes.'; }
        catch (err) { status.textContent = err.message; save.disabled = false; }
      });
      const pub = h('button', { type: 'button', class: `btn ${v.published ? 'btn-ghost' : 'btn-primary'} gl-sp-pub`, 'aria-pressed': String(!!v.published) }, v.published ? 'Unpublish' : 'Publish');
      pub.addEventListener('click', async () => {
        pub.disabled = true; status.textContent = v.published ? 'Unpublishing…' : 'Publishing…';
        try { v = await call('POST', { published: !v.published }); paint(); status.textContent = v.published ? 'Published. Paste the line into your homepage, or share the link.' : 'Unpublished. The search box no longer shows on your homepage.'; }
        catch (err) { status.textContent = err.message; pub.disabled = false; }
      });
      const dl = h('button', { type: 'button', class: 'btn btn-ghost gl-sp-dl' }, 'Download how-to');
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        try {
          const r = await fetch(`${url}?download=1&api=${encodeURIComponent(apiBase)}`, { headers: auth, credentials: 'omit' });
          if (!r.ok) throw new Error('download');
          const a = h('a', { href: URL.createObjectURL(await r.blob()), download: 'add-to-homepage.html' });
          document.body.append(a); a.click(); a.remove();
          status.textContent = 'Downloaded add-to-homepage.html: the line to paste and where to paste it.';
        } catch { status.textContent = "Couldn't download the how-to. Try again."; }
        dl.disabled = false;
      });
      let fr = null;
      const snippet = v.snippet || overlayLine();
      const line = h('div', { class: 'gl-code gl-sp-snip' },
        h('div', { class: 'gl-code-bar' }, h('span', { class: 'gl-code-label' }, 'Paste before </body>'),
          h('div', { class: 'gl-code-tools' }, copyButton(snippet, 'Copy', { what: 'Line copied', aria: 'Copy the line for your homepage', iconOnly: false }))),
        h('pre', { class: 'gl-sp-pre' }, h('code', { class: 'gl-mono' }, snippet)));
      const link = h('div', { class: 'gl-url gl-sp-url' }, h('code', { class: 'gl-mono gl-url-v' }, v.hostedUrl), copyButton(v.hostedUrl, 'Copy', { what: 'Link copied', aria: 'Copy the link to your page', iconOnly: true }));
      box.replaceChildren(...[
        h('div', { class: 'gl-sp-pubrow' }, h('span', { class: `chip ${v.published ? 'green' : 'gray'} is-label` }, v.published ? 'Published' : 'Not published'), pub, dl),
        h('h4', { class: 'gl-h4' }, 'Add to your homepage'),
        h('p', { class: 'gl-note' }, 'Paste this one line into your homepage. The search box shows on top of your site; visitors close it with ×.'),
        line,
        v.published ? null : h('p', { class: 'gl-note' }, 'It shows on your homepage once you publish.'),
        (fr = frame()),
        h('h4', { class: 'gl-h4' }, 'Look and timing'),
        siteSettings({ view: v, onSaved: (j) => { v = j; const nf = frame(); fr.replaceWith(nf); fr = nf; } }),
        form,
        h('h4', { class: 'gl-h4' }, 'Hosted link'), link].filter(Boolean));   // replaceChildren would print a null
    }
  }

  function widgetTry(el) {
    const s = getState().spec;
    const msgs = h('div', { class: 'gl-wmsgs', role: 'log', 'aria-live': 'polite', 'aria-label': `${botName()} widget conversation` });
    const panel = h('div', { class: 'gl-widget', style: { '--gl-hue': `var(--f${(Number(s.avatar?.hue) || 0) % 8})` } },
      h('div', { class: 'gl-whead' }, h('span', { class: 'gl-wava' }, s.avatar?.initials || botName().slice(0, 2).toUpperCase()), h('span', { class: 'gl-wname' }, botName()), h('span', { class: 'gl-won' }, 'online')),
      msgs);
    msgs.append(h('p', { class: 'gl-wm is-bot' }, s.greeting || `Hi! Ask me anything about ${s.org || botName()}.`));
    // fixer r4 (D11): opens on one real cited exchange from the trial bot, never a greeting over an empty frame
    let asked = false;
    const exHold = h('div', { class: 'gl-wex-hold' }, h('span', { class: 'gl-ex-tag' }, 'Example from your trial bot'), h('div', { class: 'gl-wm is-bot is-typing' }, h('i'), h('i'), h('i')));
    msgs.append(exHold);
    getExample().then((x) => {
      if (asked || !msgs.isConnected) { exHold.remove(); return; }
      exHold.replaceChildren();
      if (!x) { exHold.remove(); return; }
      const out = h('div', { class: 'gl-wm is-bot' });
      exHold.append(h('span', { class: 'gl-ex-tag' }, 'Example from your trial bot'), h('p', { class: 'gl-wm is-user' }, x.question), out);
      renderWidgetAnswer(out, x.r);
      if (!motion.reduced()) motion.stagger([...exHold.children], [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 80);
    });
    const af = askForm({ placeholder: 'Ask a question…', onAsk, label: 'Ask the widget' });
    panel.append(af.form);
    el.append(h('div', { class: 'gl-widget-stage' }, h('div', { class: 'gl-site-skel', 'aria-hidden': 'true' }, h('b'), h('i'), h('i'), h('i')), panel), af.row,
      h('p', { class: 'gl-note' }, h('span', { html: icon('info', 13) }), 'This is your trial bot in widget form. After launch, the snippet on the left shows the same widget on your site.'));
    async function onAsk(q) {
      if (!asked) { asked = true; if (!exHold.querySelector('.is-user')) exHold.remove(); }
      af.setBusy(true);
      msgs.append(h('p', { class: 'gl-wm is-user' }, q));
      const out = h('div', { class: 'gl-wm is-bot is-typing' }, h('i'), h('i'), h('i'));
      msgs.append(out);
      msgs.scrollTop = msgs.scrollHeight;
      try {
        const r = await askBot(ctx, q, { onDelta: (t) => { out.classList.remove('is-typing'); out.textContent = stripMarkers(t); msgs.scrollTop = msgs.scrollHeight; } });
        renderWidgetAnswer(out, r);
      } catch (err) {
        out.classList.remove('is-typing'); out.classList.add('is-err');
        out.textContent = err && err.status === 429 ? `That's a lot of questions at once. Try again in ${err.retryAfter || 10}s.` : "Couldn't reach your bot. Your question wasn't lost.";
        af.input.value = q;
      } finally { af.setBusy(false); msgs.scrollTop = msgs.scrollHeight; }
    }
  }

  /** A widget answer: lines with [n] chips that open the quoted excerpt in place, then the source list. */
  function renderWidgetAnswer(out, r) {
    out.classList.remove('is-typing');
    out.innerHTML = '';
    if (r.refused) { out.classList.add('is-refused'); out.textContent = r.text; return; }
    for (const l of lines(r.text)) {
      const p = h('p');
      const parts = l.split(/(\[\d+(?:\s*,\s*\d+)*\])/);
      for (const part of parts) {
        const m = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
        if (!m) { p.append(part); continue; }
        for (const n of m[1].split(/\s*,\s*/).map(Number)) {
          const c = (r.citations || []).find((x) => x.n === n);
          const b = h('button', { type: 'button', class: 'gl-wcite', 'aria-expanded': 'false', 'aria-label': `Citation ${n}${c ? `: ${c.file}` : ''}` }, String(n));
          const ex = h('span', { class: 'gl-wex', hidden: true }, c ? h('span', null, h('b', null, c.file), c.locator ? ` · ${c.locator}` : '', h('q', null, String(c.excerpt || '').slice(0, 220))) : 'Source');
          b.addEventListener('click', () => { const o = ex.hidden; ex.hidden = !o; b.setAttribute('aria-expanded', String(o)); if (o) motion.animate(ex, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2] }); });
          p.append(b, ex);
        }
      }
      out.append(p);
    }
    if ((r.citations || []).length) out.append(h('p', { class: 'gl-wsrc' }, `Sources: ${r.citations.map((c) => `[${c.n}] ${c.file}`).join(' · ')}`));
  }

  // ------------------------------------------------------------ Web voice assistant preview (the real embeddable widget)
  // Mounts lib/voice-widget.js inline with this trial's key, exactly what the embed snippet does on a site. The older
  // clip-based voice bot (POST /v1/bots/:id/voice) stays one click away for servers with Google speech.
  // The phone you can call in the browser: real phone prompt and greeting, Gemini Live voice to voice (or browser
  // speech when the server has no live voice), and the bot may hang up. Without a trial key: the older simulator.
  function phoneTry(el) {
    const host = h('div', { class: 'gl-phonesim' });
    const note = h('p', { class: 'gl-tw-hint', role: 'status' }, 'Getting the line ready…');
    el.append(note, host);
    let sim = null, stopped = false;
    voices.push({ stop() { stopped = true; try { sim && sim.stop(); } catch { /* ignore */ } sim = null; } });
    loadDev().then(() => import('./phonesim.js?v=cac62cd')).then(({ mountPhone }) => {
      if (stopped || closing) return;
      const d = dev();
      if (d.status !== 'ok' || !d.key) { note.remove(); voices.push(voiceTry(el, { mode: 'phone' })); return; }
      note.textContent = liveVoice() ? 'Live voice, the same as a real call. Allow the microphone when asked.' : 'Your browser listens and speaks on this test line. Real calls use live voice.';
      sim = mountPhone(host, { endpoint: webVoiceUrl(), key: d.key, botName: botName(), starters: starterQs() });
    }).catch(() => { if (!stopped) { note.remove(); voices.push(voiceTry(el, { mode: 'phone' })); } });
  }

  function webVoiceTry(el) {
    const host = h('div', { class: 'gl-webvoice' });
    const note = h('p', { class: 'gl-tw-hint', role: 'status' }, 'Loading the voice assistant…');
    el.append(note, host);
    let widget = null, stopped = false;
    voices.push({ stop() { stopped = true; try { widget && widget.destroy(); } catch { /* ignore */ } widget = null; } });
    loadDev().then(() => import(`${siteBase}lib/voice-launcher.js?v=e3d6fc1`)).then(({ mountVoiceLauncher }) => {
      if (stopped || closing) return;
      const d = dev();
      if (d.status !== 'ok' || !d.key) { note.textContent = 'The voice assistant needs your trial key; it is not available right now. The clip endpoint below still works.'; return; }
      note.textContent = liveVoice() ? 'Live voice, the same as your phone line: speak and it answers out loud, with the sources as links while it speaks.' : 'Live voice is unavailable right now, so your browser listens and speaks instead. Same sources, same citations.';
      // voice mode with the orb, in the bot's colour; the picker below changes it (and saves it for every voice surface)
      widget = mountVoiceLauncher(host, { apiBase, endpoint: webVoiceUrl(), bot: botId(), key: d.key, name: botName() });
      api.getSite?.().then((view) => {
        if (stopped || closing || !host.isConnected) return;
        const pick = h('div', { class: 'gl-wv-orb' });
        pick.append(siteSettings({ view, compact: true, orbOnly: true, onSaved: (v) => { try { widget?.setOrb?.(v?.site?.orb); } catch { /* ignore */ } } }));
        host.after(pick);
      }).catch(() => {});
    }).catch(() => { if (!stopped) note.textContent = "The voice assistant couldn't load here. The clip endpoint below still works."; });
  }

  // ------------------------------------------------------------ Voice: browser chatbot + call simulator
  function voiceTry(el, { mode = 'browser' } = {}) {
    const phone = mode === 'phone';
    const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    const state = { s: 'idle', rec: null, stream: null, audioCtx: null, analyser: null, freq: null, env: 0, stopLoop: null, utter: null, call: false, callT0: 0, timer: 0, gen: 0, audioEl: null, mediaRec: null };
    const canvas = h('canvas', { class: 'gl-wave', 'aria-hidden': 'true' });
    const micBtn = h('button', { type: 'button', class: 'gl-mic', 'aria-pressed': 'false' }, h('span', { class: 'gl-mic-ring', 'aria-hidden': 'true' }), h('span', { class: 'gl-mic-ico', html: phone ? GLYPH.phone : icon('mic', 22) }));
    const micLabel = h('span', { class: 'gl-mic-label', 'aria-hidden': 'true' });
    const status = h('p', { class: 'gl-vstatus', role: 'status' });
    // Degraded state (no recognition, no mic, mic denied): say so plainly and hand over to the typed path, which runs the
    // same pipeline: your bot → spoken answer (speechSynthesis) with its source.
    const degraded = h('p', { class: 'gl-vdegraded', hidden: true }, h('span', { class: 'gl-vdegraded-ico', html: icon('warn', 14) }), h('span', { class: 'gl-vdegraded-t' }));
    const capYou = h('span', { class: 'gl-cap-text', dataset: { ph: phone ? 'What the caller says appears here' : 'Your question appears here as you speak' } });
    const capBot = h('span', { class: 'gl-cap-text', dataset: { ph: 'The spoken answer appears here, word by word, with its source' } });
    const capSrc = h('p', { class: 'gl-cap-src' });
    // fixer r4 (D11): the published endpoint this demo actually called, under the captions (Stripe-style request line)
    const reqLine = h('p', { class: 'gl-reqline', 'aria-live': 'off' });
    // fixer r7 (D11): the phone simulator shows the TwiML the voice webhook returned for the last turn
    const twimlBox = phone ? h('details', { class: 'gl-json gl-twiml', hidden: true }, h('summary', null, 'Call instructions returned by the voice webhook'),
      h('pre', { class: 'gl-pre', tabindex: '0', 'aria-label': 'Call instructions response' }, h('code'))) : null;
    const callBar = phone ? h('div', { class: 'gl-callbar' }, h('span', { class: 'gl-call-dot', 'aria-hidden': 'true' }), h('span', { class: 'gl-call-label' }, `${botName()} · KnowBot line`), h('span', { class: 'gl-call-t gl-mono' }, '00:00')) : null;
    const speakToggle = h('input', { type: 'checkbox', checked: true, id: `gl-speak-${rid()}` });
    const engineNote = h('span', { class: 'gl-engine' });
    const typed = askForm({ placeholder: phone ? 'Or type what the caller says…' : 'Or type a question…', label: phone ? 'Caller question' : 'Question for the voice bot', chips: false, onAsk: (q) => { if (phone && !state.call) startCall(q); else answer(q); } });
    const micWrap = h('div', { class: 'gl-mic-wrap' }, micBtn, micLabel);
    const stage = h('div', { class: `gl-vstage${phone ? ' is-phone' : ''}` }, callBar, canvas, micWrap);
    const caps = h('div', { class: 'gl-caps' },
      h('p', { class: 'gl-cap is-you' }, h('span', { class: 'gl-cap-k' }, phone ? 'Caller' : 'You'), capYou),
      h('p', { class: 'gl-cap is-bot' }, h('span', { class: 'gl-cap-k' }, botName()), capBot), capSrc, reqLine, twimlBox);
    el.append(stage, status, degraded, caps, typed.form,
      h('div', { class: 'gl-vopts' }, h('label', { class: 'gl-switch', for: speakToggle.id }, speakToggle, h('span', { class: 'gl-switch-ui', 'aria-hidden': 'true' }), 'Speak answers'), engineNote),
      h('p', { class: 'gl-note' }, h('span', { html: icon('info', 13) }), phone
        ? 'Each turn is answered by your bot from its files, with its source. A real call is answered in live voice through your voice webhook; the call instructions that webhook returns are shown below.'
        : 'Runs in your browser: speech recognition → your bot → spoken answer with its source. Nothing is recorded or stored.'));

    const paintEngine = () => {
      const rec = googleVoice() && dev().key && 'MediaRecorder' in window ? 'Server speech recognition' : SR_CTOR ? 'Browser speech recognition' : 'Typed input (no speech recognition in this browser)';
      const out = googleVoice() && dev().key ? 'server voice' : synth ? 'browser voice' : 'captions only';
      engineNote.textContent = `${rec} · ${out}`;
    };
    paintEngine();
    loadDev().then(paintEngine);
    const setS = (s, msg) => {
      state.s = s;
      el.dataset.vstate = s;
      micBtn.classList.toggle('is-live', s === 'listening');
      micBtn.setAttribute('aria-pressed', String(s === 'listening' || (phone && state.call)));
      // The visible label is the button's accessible name (WCAG 2.5.3 label in name).
      const off = state.degraded && !phone;
      const lab = phone
        ? (state.call ? 'Hang up' : `Call ${botName()}`)
        : s === 'listening' ? 'Listening · tap to stop' : s === 'speaking' ? 'Tap to stop' : s === 'thinking' ? 'Thinking…' : off ? 'Mic unavailable' : 'Tap or hold to talk';
      micLabel.textContent = lab;
      micBtn.setAttribute('aria-label', lab === 'Thinking…' ? 'Thinking, please wait' : lab);
      // fixer r6 (D9): with no usable mic the hint never says "tap the mic": it points at the text field instead
      if (off && msg && /\b(mic|tap|hold)\b/i.test(msg)) msg = 'Type your question below.';
      if (msg != null) { status.textContent = msg; }
      drawStatic();
    };
    /** fixer r6 (D9): no mic / no recognition / mic blocked: the mic button is aria-disabled with muted styling (the
     *  call button in the phone simulator stays live: the call works typed), the hint points at the text field. */
    function markMicOff() {
      if (phone) return;
      state.degraded = true;
      micBtn.setAttribute('aria-disabled', 'true');
      micBtn.classList.add('is-off');
    }
    function degrade(why) {
      degraded.hidden = false;
      $('.gl-vdegraded-t', degraded).textContent = `Mic unavailable, type your question instead. ${why}`.trim();
      el.classList.add('is-degraded');
      markMicOff();
      typed.input.placeholder = phone ? 'Type what the caller says…' : 'Type your question, the answer is still spoken…';
      setS('idle', phone ? '' : 'Type your question below.');
      try { typed.input.focus({ preventScroll: true }); } catch { /* ignore */ }
      motion.animate(degraded, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
      announce('Microphone unavailable. Type your question below.', 'polite');
    }
    const hasMicApi = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    setS('idle', phone ? `Tap to call ${botName()}. It greets you, then listens.` : 'Tap the mic and ask out loud, or hold it while you speak.');
    if ((!SR_CTOR && !googleVoice()) || !hasMicApi) {
      degraded.hidden = false;
      el.classList.add('is-degraded');
      markMicOff();
      setS('idle', phone ? null : 'Type your question below.');
      $('.gl-vdegraded-t', degraded).textContent = !hasMicApi ? 'Mic unavailable on this page, type your question instead. Answers are still spoken.' : 'This browser has no speech recognition (try Chrome or Edge). Type your question instead, answers are still spoken.';
    }

    // waveform ------------------------------------------------
    const N = 44;
    const levels = new Float32Array(N);
    // fixer r6 (D6): no layout or style reads inside the animation loop. The canvas size comes from a ResizeObserver,
    // the colours and the gradient are cached (refreshed on resize, theme change and state change, never per frame).
    const cv = { w: 0, h: 0, cssW: 320, cssH: 88, cols: null, grad: null, g: null };
    function measureCanvas() {
      cv.cssW = Math.max(200, canvas.clientWidth || 320); cv.cssH = canvas.clientHeight || 88;
      cv.cols = null; cv.grad = null;
    }
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver((ents) => { const r = ents[0] && ents[0].contentRect; if (r && r.width) { cv.cssW = Math.max(200, r.width); cv.cssH = r.height || 88; cv.grad = null; drawStatic(); } });
      ro.observe(canvas); cleanups.push(() => ro.disconnect());
    }
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => { cv.cols = null; cv.grad = null; drawStatic(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); cleanups.push(() => mo.disconnect());
    }
    function sizeCanvas() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(cv.cssW * dpr), Hh = Math.round(cv.cssH * dpr);
      if (canvas.width !== W || canvas.height !== Hh) { canvas.width = W; canvas.height = Hh; cv.grad = null; }
      return { dpr, w: canvas.width, h: canvas.height };
    }
    function colors() {
      if (cv.cols) return cv.cols;
      const css = getComputedStyle(el);
      cv.cols = [css.getPropertyValue('--accent').trim() || '#6366f1', css.getPropertyValue('--gl-hue').trim() || css.getPropertyValue('--f5').trim() || '#7c3aed', css.getPropertyValue('--line-2').trim() || '#cbd5e1'];
      return cv.cols;
    }
    function draw(t = 0) {
      const g = cv.g || (cv.g = canvas.getContext('2d'));
      if (!g) return;
      const { w, h: H, dpr } = sizeCanvas();
      g.clearRect(0, 0, w, H);
      const [c1, c2, idleC] = colors();
      if (!cv.grad) { cv.grad = g.createLinearGradient(0, 0, w, 0); cv.grad.addColorStop(0, c1); cv.grad.addColorStop(1, c2); }
      const grad = cv.grad;
      const gap = w / N, bw = Math.max(2 * dpr, gap * 0.46), mid = H / 2;
      for (let i = 0; i < N; i++) {
        let v = 0;
        const win = Math.sin(Math.PI * (i + .5) / N);
        if (state.s === 'listening' && state.freq) {
          const bin = Math.floor(2 + (i / N) * (state.freq.length * 0.55));
          // a silent mic still breathes (low, centred), so "listening" never looks frozen
          v = Math.max((state.freq[bin] || 0) / 255, (0.07 + 0.05 * Math.sin(t / 220 + i * .45)) * win);
        } else if (state.s === 'listening') {
          v = 0.12 + 0.1 * Math.sin(t / 180 + i * .5);   // no analyser (mic owned by recognition): honest idle pulse
        } else if (state.s === 'speaking') {
          const n = 0.55 + 0.45 * Math.sin(t / 90 + i * 1.7) * Math.sin(t / 160 + i * .6);
          v = state.env * n * win * 1.2;
          if (state.analyser && state.freq) { state.analyser.getByteFrequencyData(state.freq); const bin = Math.floor(2 + (i / N) * (state.freq.length * 0.5)); v = (state.freq[bin] || 0) / 255; }
        } else if (state.s === 'thinking') {
          const scan = (t / 900) % 1;
          v = 0.08 + 0.32 * Math.max(0, 1 - Math.abs(i / N - scan) * 6);
        }
        levels[i] += (Math.min(1, v) - levels[i]) * (state.s === 'listening' ? 0.45 : 0.25);
        const amp = Math.max(1.5 * dpr, levels[i] * (H * 0.46));
        g.fillStyle = state.s === 'idle' ? idleC : grad;
        const x = i * gap + (gap - bw) / 2;
        const r = bw / 2;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, mid - amp, bw, amp * 2, r); else g.rect(x, mid - amp, bw, amp * 2);
        g.fill();
      }
      state.env *= 0.93;
    }
    function drawStatic() { try { draw(performance.now()); } catch { /* canvas unavailable */ } }
    requestAnimationFrame(() => setTimeout(() => { measureCanvas(); drawStatic(); }, 0));
    function startLoop() {
      if (state.stopLoop || motion.reduced()) { drawStatic(); return; }
      state.stopLoop = motion.loop.add((t) => {
        if (state.s === 'listening' && state.analyser && state.freq) state.analyser.getByteFrequencyData(state.freq);
        draw(t);
        if (state.s === 'idle' && levels.every((v) => v < 0.02)) { state.stopLoop = null; drawStatic(); return false; }
        return true;
      });
    }
    requestAnimationFrame(drawStatic);

    // mic ----------------------------------------------------
    async function openMic() {
      if (state.stream) return true;
      if (!navigator.mediaDevices?.getUserMedia) return false;
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          state.audioCtx = new AC();
          const src = state.audioCtx.createMediaStreamSource(state.stream);
          state.analyser = state.audioCtx.createAnalyser();
          state.analyser.fftSize = 256; state.analyser.smoothingTimeConstant = 0.6;
          state.freq = new Uint8Array(state.analyser.frequencyBinCount);
          src.connect(state.analyser);
        }
        return true;
      } catch (err) {
        state.micError = err && err.name;
        return false;
      }
    }
    function closeMic() {
      try { state.stream && state.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { state.audioCtx && state.audioCtx.close(); } catch { /* ignore */ }
      state.stream = null; state.audioCtx = null; state.analyser = null; state.freq = null;
    }

    async function listen() {
      const gen = ++state.gen;
      const clearYou = () => { capYou.textContent = ''; capYou.classList.remove('is-final'); };
      if (googleVoice() && dev().key && 'MediaRecorder' in window) {
        clearYou();
        const ok = await googleListen(gen).catch(() => false);
        if (ok !== false) return;
        status.textContent = 'Live voice is unavailable right now, using your browser\'s speech instead.';
      }
      if (!SR_CTOR) { degrade('This browser has no speech recognition (try Chrome or Edge). Answers are still spoken.'); if (phone && state.call) setS('idle', 'Type what the caller says. The bot answers out loud.'); return; }
      if (!hasMicApi) { degrade('Answers are still spoken.'); return; }
      const micOk = await openMic();
      if (gen !== state.gen) return;
      if (!micOk) {
        const e = state.micError;
        degrade(e === 'NotAllowedError' || e === 'SecurityError' ? 'Microphone access is blocked: allow it in the address bar to talk.'
          : e === 'NotFoundError' || e === 'OverconstrainedError' ? 'No microphone was found.'
          : e === 'NotReadableError' ? 'The microphone is in use by another app.' : 'Answers are still spoken.');
        if (phone && state.call) setS('idle', 'Type what the caller says. The bot answers out loud.');
        return;
      }
      degraded.hidden = true; el.classList.remove('is-degraded');
      clearYou();
      let finalText = '', errored = null, heardAt = performance.now(), ended = false, misses = state.misses || 0;
      const NO_SPEECH_MS = 7000;
      const noSpeech = setInterval(() => {
        if (gen !== state.gen || ended) { clearInterval(noSpeech); return; }
        if (!capYou.textContent.trim() && performance.now() - heardAt > NO_SPEECH_MS) {
          clearInterval(noSpeech);
          errored = errored || 'no-speech';
          try { rec.abort(); } catch { /* ignore */ }
          // Some engines (headless, no audio device) never fire onend: settle ourselves.
          setTimeout(() => { if (!ended && gen === state.gen) rec.onend(); }, 600);
        }
      }, 250);
      const rec = new SR_CTOR();
      state.rec = rec;
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
        }
        capYou.textContent = (finalText + interim).trim();
        capYou.classList.toggle('is-final', !interim);
        heardAt = performance.now();
        state.env = 1;
      };
      rec.onerror = (e) => { errored = e.error; };
      rec.onend = () => {
        if (ended || gen !== state.gen) return;
        ended = true; clearInterval(noSpeech);
        state.rec = null;
        closeMic();
        const q = finalText.trim() || capYou.textContent.trim();
        if (q) { state.misses = 0; capYou.textContent = q; capYou.classList.add('is-final'); answer(q); return; }
        if (errored === 'not-allowed' || errored === 'service-not-allowed') { degrade('Microphone access is blocked: allow it in the address bar to talk.'); return; }
        if (errored === 'audio-capture') { degrade('No microphone was found.'); return; }
        if (errored === 'network') { degrade('The browser\'s speech service is unreachable.'); return; }
        // Silence: the waveform settles and the visitor gets both ways forward.
        state.misses = misses + 1;
        if (phone && state.call && state.misses < 2) { setS('idle', 'I didn\'t catch that. Listening again…'); setTimeout(() => { if (state.call && gen === state.gen) listen(); }, 700); return; }
        state.misses = 0;
        if (phone && state.call) { endCall('I didn\'t hear anything, so the call ended. Tap to call again, or type below.'); return; }
        // fixer r6 (D9): no speech within 7 s: stop, say so, and hand over to the typed field (focused + announced)
        setS('idle', 'Didn\'t catch that. Type your question instead.');
        try { typed.input.focus({ preventScroll: true }); } catch { /* ignore */ }
        if (!motion.reduced()) motion.animate(typed.form, [{ boxShadow: '0 0 0 0 var(--accent-soft)' }, { boxShadow: '0 0 0 6px var(--accent-soft)', offset: .4 }, { boxShadow: '0 0 0 0 transparent' }], { duration: 900, easing: 'out', essential: false });
        announce('Didn\'t catch that. Type your question instead.', 'assertive');
      };
      try { rec.start(); } catch { ended = true; clearInterval(noSpeech); state.rec = null; closeMic(); degrade('Speech recognition couldn\'t start.'); return; }
      setS('listening', phone ? 'Listening… ask your question.' : 'Listening… speak now. Tap again to stop.');
      announce(phone ? 'Listening' : 'Listening. Speak now.', 'polite');
      startLoop();
    }

    // Google path (configured server): record a clip, POST /v1/bots/:id/voice, play the returned audio.
    // CONTRACT-GAP (F): response assumed {transcript, answer|text, citations, refused, audio(base64), mime}.
    async function googleListen(gen) {
      const okMic = await openMic();
      if (!okMic) return false;
      const chunks = [];
      const mr = new MediaRecorder(state.stream);
      state.mediaRec = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { mr.onstop = r; });
      mr.start();
      setS('listening', 'Listening… tap again when you\'re done.');
      startLoop();
      // stop after 1.2 s of silence once speech was heard, or 9 s max
      let heard = false, quietSince = 0; const t0 = performance.now();
      const watch = setInterval(() => {
        if (!state.analyser || !state.freq) return;
        state.analyser.getByteFrequencyData(state.freq);
        const lvl = state.freq.reduce((a, b) => a + b, 0) / state.freq.length / 255;
        if (lvl > 0.08) { heard = true; quietSince = 0; } else if (heard && !quietSince) quietSince = performance.now();
        if ((heard && quietSince && performance.now() - quietSince > 1200) || performance.now() - t0 > 9000) { if (mr.state !== 'inactive') mr.stop(); }
      }, 100);
      await stopped;
      clearInterval(watch);
      state.mediaRec = null;
      closeMic();
      if (gen !== state.gen) return true;
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      setS('thinking', 'Transcribing…');
      startLoop();
      const vPath = `/v1/bots/${encodeURIComponent(botId())}/voice`;
      const tv = performance.now();
      const res = await fetch(`${apiRoot}${vPath}`, { method: 'POST', headers: { authorization: `Bearer ${dev().key}`, 'content-type': blob.type }, body: blob, credentials: 'omit' });
      paintReq({ method: 'POST', path: pub(vPath), status: res.status, ms: Math.round(performance.now() - tv), note: `${blob.type.split(';')[0]} · ${Math.max(1, Math.round(blob.size / 1024))} KB` });
      if (!res.ok) throw new Error(`voice ${res.status}`);
      const j = await res.json();
      const r = { text: j.answer ?? j.text ?? '', refused: !!j.refused, citations: (j.citations || []).map((c, i) => ({ n: c.n ?? i + 1, file: c.file, title: c.title, excerpt: c.excerpt })), spoken: j.spoken || null };
      capYou.textContent = j.transcript || ''; capYou.classList.add('is-final');
      await speak(r, j.audio ? `data:${j.mime || 'audio/mpeg'};base64,${j.audio}` : null);
      return true;
    }

    async function answer(q) {
      const gen = ++state.gen;
      try { synth && synth.cancel(); } catch { /* ignore */ }
      capYou.textContent = q; capYou.classList.add('is-final');
      capBot.textContent = ''; capSrc.textContent = '';
      const atoms = Object.values(getState().files || {}).reduce((a, f) => a + (f && f.enabled !== false ? (f.atoms || 0) : 0), 0);
      setS('thinking', atoms ? `Searching ${atoms.toLocaleString()} atoms…` : 'Searching your files…');
      startLoop();
      typed.setBusy(true);
      try {
        const v = await askVoice(q);
        if (gen !== state.gen) return;
        await speak(v.r, v.audio);
      } catch (err) {
        if (gen !== state.gen) return;
        setS('idle', err && err.status === 429 ? `That's a lot of questions at once. Try again in ${err.retryAfter || 10}s.` : "Couldn't reach your bot. Your question wasn't lost.");
        typed.input.value = q;
        if (phone && state.call) endCall();
      } finally { typed.setBusy(false); }
    }

    /**
     * Typed and recognized turns go to the published API with the trial key, exactly as a customer's integration would:
     * POST /v1/bots/:id/voice {text} when Google voice is configured (cited answer + Google audio), else
     * POST /v1/bots/:id/chat (cited answer, spoken by the browser). Studio /ask only if the API is unavailable.
     */
    /**
     * fixer r7 (D11): the call simulator exercises the real telephone webhook. Each caller turn goes through the Studio
     * test route (A), which posts a signed incoming call to POST /v1/channels/:id/voice; the TwiML that comes back
     * (<Connect><Stream> to Gemini Live, or the "not set up yet" <Say>) is shown under the captions, and the turn itself
     * is answered via the chat API (calls are voice-to-voice, so there is no per-question TwiML to speak).
     */
    async function askPhone(q) {
      const t = getState().trial;
      const t0 = performance.now();
      let why = 'telephone webhook unavailable here';
      let twiml = null;
      try {
        const res = await fetch(`${apiBase}/api/studio/trials/${encodeURIComponent(t.id || '')}/channels/voice/test`, {
          method: 'POST', credentials: 'omit',
          headers: { 'content-type': 'application/json', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
          body: JSON.stringify({ question: q }),
        });
        if (res.status === 429) { const e = new Error('rate'); e.status = 429; e.retryAfter = Number(res.headers.get('retry-after')) || null; throw e; }
        const j = await res.json().catch(() => null);
        if (j && j.configured === false) why = 'telephone channel not configured on this server';
        const rs = (j && j.response) || {};
        if (res.ok && j && j.configured !== false && rs.status >= 200 && rs.status < 300) {
          const body = String(rs.body || '');
          const unx = (x) => String(x).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
          const says = [...body.matchAll(/<Say\b[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => unx(m[1]).trim()).filter(Boolean);
          const plays = [...body.matchAll(/<Play\b[^>]*>([\s\S]*?)<\/Play>/g)].map((m) => unx(m[1]).trim()).filter(Boolean);
          // the call webhook streams the call (<Connect><Stream>) or, when the line isn't set up, says so and hangs up:
          // neither is an answer to this turn, so the turn is answered via the chat API and the real TwiML is shown
          const callTwiml = /<Connect>|<Hangup\/>/.test(body);
          if (callTwiml) { why = /<Connect>/.test(body) ? 'real calls are answered in live voice' : 'the phone line is not set up on this server yet'; twiml = body; }
          const spoken = callTwiml ? '' : says[0] || '';
          if (spoken) {
            const src = /^According to ([^,]{2,80}),/.exec(spoken);
            const refused = /can't seem to find an answer/i.test(spoken);
            paintReq({ method: 'POST', path: pub((j.request && j.request.path) || `/v1/channels/${botId()}/voice`), status: rs.status, ms: j.ms ?? Math.round(performance.now() - t0), note: `${j.signed ? 'signed ' : ''}call → call instructions` });
            paintTwiml(body);
            return { r: { text: spoken, refused, citations: [], srcNote: refused ? null : src ? `Named on the call: ${src[1]}` : null }, audio: null };
          }
          if (plays.length) why = 'the voice audio is played on the real line';
        }
      } catch (err) { if (err && err.status === 429) throw err; }
      const r = await askChannel(q);
      paintReq({ ...(r.req || {}), ms: r.ms, note: `answers via the chat API (${why})` });
      paintTwiml(twiml);
      return { r, audio: null };
    }
    function paintTwiml(body) {
      if (!twimlBox) return;
      twimlBox.hidden = !body;
      if (!body) return;
      const pretty = String(body).replace(/>\s*</g, '>\n<').replace(/\n(<(?!\/?Response)[^/])/g, '\n  $1');
      $('code', twimlBox).innerHTML = highlight(pretty, 'xml');
    }

    async function askVoice(q) {
      if (phone) return askPhone(q);
      const d = await loadDev();
      if (d.status === 'ok' && googleVoice()) {
        const vPath = `/v1/bots/${encodeURIComponent(botId())}/voice`;
        const t0 = performance.now();
        try {
          const res = await fetch(`${apiRoot}${vPath}`, { method: 'POST', credentials: 'omit', headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: q }) });
          const ms = Math.round(performance.now() - t0);
          if (res.status === 429) { const e = new Error('rate'); e.status = 429; e.retryAfter = Number(res.headers.get('retry-after')) || null; throw e; }
          if (res.ok) {
            const j = await res.json();
            paintReq({ method: 'POST', path: pub(vPath), status: res.status, ms, note: j.audio ? 'server voice' : 'browser voice' });
            const r = { text: j.answer ?? j.text ?? '', refused: !!j.refused, citations: (j.citations || []).map((c, i) => ({ n: c.n ?? i + 1, file: c.file, title: c.title, excerpt: c.excerpt })), spoken: j.spoken || null };
            return { r, audio: j.audio ? `data:${j.mime || 'audio/mpeg'};base64,${j.audio}` : null };
          }
        } catch (err) { if (err && err.status === 429) throw err; /* fall back to /chat */ }
      }
      const r = await askChannel(q);
      paintReq({ ...(r.req || {}), ms: r.ms });
      return { r, audio: null };
    }
    function paintReq(q) {
      reqLine.innerHTML = '';
      if (!q || !q.path) return;
      const ok = q.status >= 200 && q.status < 300;
      // fixer r6 (D7): one wrapping line (status chip, then "POST path · ms · note"), never a column of fragments
      reqLine.append(h('span', { class: `gl-status${ok ? (q.fallback ? ' is-prev' : ' is-ok') : ' is-bad'}` }, q.fallback ? 'Studio' : String(q.status)),
        h('span', { class: 'gl-out-line' }, ...[h('code', { class: 'gl-mono' }, `${q.method || 'POST'} `, urlParts(q.path)),
          q.ms ? [' · ', h('span', { class: 'gl-mono gl-reqline-ms' }, `${q.ms} ms`)] : null,
          q.note ? [' · ', h('span', { class: 'gl-reqline-note' }, q.note)] : null,
          q.fallback ? [' · ', h('span', { class: 'gl-reqline-note' }, 'developer API unavailable on this server')] : null].filter(Boolean).flat()));
      if (!motion.reduced()) motion.animate(reqLine, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
    }

    function speak(r, audioUrl = null, { after = null } = {}) {
      const text = r.spoken || spokenText(r, [botName(), getState().spec.org, getState().spec.name]);
      const words = text.split(/(\s+)/);
      capBot.innerHTML = '';
      const spans = [];
      let pos = 0;
      for (const w of words) {
        if (!w) continue;
        if (/^\s+$/.test(w)) { capBot.append(w); pos += w.length; continue; }
        const s = h('span', { class: 'gl-w', dataset: { at: String(pos) } }, w);
        spans.push(s); capBot.append(s); pos += w.length;
      }
      capBot.classList.toggle('is-refused', r.refused);
      capSrc.innerHTML = '';
      if (!r.refused && r.citations.length) capSrc.append(h('span', { html: icon('file', 12) }), ` ${r.citations.map((c) => `[${c.n}] ${c.file || c.title}`).join(' · ')}`);
      else if (r.refused) capSrc.append(h('span', { html: icon('shield', 12) }), ' Canonical refusal: no file covers this.');
      else if (r.srcNote) capSrc.append(h('span', { html: icon('file', 12) }), ` ${r.srcNote}`);
      announce(text, 'polite');
      const mark = (charIndex) => { for (const s of spans) s.classList.toggle('is-said', Number(s.dataset.at) <= charIndex); state.env = 1; };
      const finish = () => {
        for (const s of spans) s.classList.add('is-said');
        if (after) { after(); return; }
        if (phone && state.call) { setS('idle', 'Listening again…'); setTimeout(() => { if (state.call) listen(); }, 500); }
        else setS('idle', 'Tap the mic to ask another question.');
      };
      if (motion.reduced()) for (const s of spans) s.classList.add('is-said');
      const gen = state.gen;
      if (audioUrl) {
        return new Promise((resolve) => {
          const a = new Audio(audioUrl);
          state.audioEl = a;
          setS('speaking', `${botName()} is answering…`);
          startLoop();
          a.ontimeupdate = () => { if (a.duration) mark(Math.floor((a.currentTime / a.duration) * text.length)); };
          a.onended = () => { state.audioEl = null; if (gen === state.gen) finish(); resolve(); };
          a.onerror = () => { state.audioEl = null; finish(); resolve(); };
          a.play().catch(() => { finish(); resolve(); });
        });
      }
      if (!synth || !speakToggle.checked) { for (const s of spans) s.classList.add('is-said'); finish(); return Promise.resolve(); }
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        state.utter = u;
        u.lang = navigator.language || 'en-US';
        const vs = synth.getVoices ? synth.getVoices() : [];
        const lang = (u.lang || 'en').slice(0, 2);
        u.voice = vs.find((v) => v.lang?.startsWith(lang) && /Google|Natural|Neural/i.test(v.name)) || vs.find((v) => v.lang?.startsWith(lang)) || null;
        u.rate = 1.02;
        let gotBoundary = false;
        const t0 = performance.now();
        const est = setInterval(() => { if (!gotBoundary) mark(Math.floor(((performance.now() - t0) / 1000) * 14.5)); state.env = Math.max(state.env, 0.55 + Math.random() * 0.45); }, 110);
        u.onboundary = (e) => { gotBoundary = true; mark(e.charIndex || 0); };
        const end = () => { clearInterval(est); state.utter = null; if (gen === state.gen) finish(); resolve(); };
        u.onend = end; u.onerror = end;
        setS('speaking', `${botName()} is answering…`);
        startLoop();
        try { synth.cancel(); synth.speak(u); } catch { end(); }
        // Some engines never fire onend when the page is backgrounded: settle after a generous estimate.
        setTimeout(() => { if (state.utter === u) { try { synth.cancel(); } catch { /* ignore */ } end(); } }, 4000 + text.length * 110);
      });
    }

    // phone call simulator ------------------------------------
    function tickCall() {
      const t = Math.floor((Date.now() - state.callT0) / 1000);
      if (callBar) $('.gl-call-t', callBar).textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    }
    async function startCall(firstQ = null) {
      state.call = true; state.callT0 = Date.now();
      el.classList.add('is-incall');
      clearInterval(state.timer); state.timer = setInterval(tickCall, 1000); tickCall();
      const s = getState().spec;
      const greet = `Thanks for calling ${s.org || botName()}. ${s.greeting || 'Ask me anything.'}`.replace(/\s+/g, ' ');
      capYou.textContent = ''; capSrc.textContent = '';
      setS('speaking', `${botName()} picked up.`);
      await speak({ text: greet, refused: false, citations: [] }, null, { after: () => { if (!state.call) return; if (firstQ) answer(firstQ); else listen(); } }).catch(() => {});
    }
    function endCall(msg) {
      state.call = false; state.gen++;
      clearInterval(state.timer);
      el.classList.remove('is-incall');
      try { state.rec && state.rec.abort(); } catch { /* ignore */ }
      try { synth && synth.cancel(); } catch { /* ignore */ }
      try { state.mediaRec && state.mediaRec.state !== 'inactive' && state.mediaRec.stop(); } catch { /* ignore */ }
      closeMic();
      setS('idle', msg || `Call ended. Tap to call ${botName()} again.`);
    }

    let holdT = 0, held = false, suppressClick = false;
    if (!phone) {
      micBtn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || state.s !== 'idle' || state.degraded) return;
        held = false; clearTimeout(holdT);
        holdT = setTimeout(() => { held = true; micBtn.classList.add('is-held'); listen(); }, 350);
      });
      const release = () => {
        clearTimeout(holdT);
        if (!held) return;
        held = false; suppressClick = true; micBtn.classList.remove('is-held');
        setTimeout(() => { suppressClick = false; }, 400);
        if (state.s === 'listening') { try { state.rec ? state.rec.stop() : state.mediaRec?.stop(); } catch { /* ignore */ } }
      };
      micBtn.addEventListener('pointerup', release);
      micBtn.addEventListener('pointercancel', release);
      micBtn.addEventListener('pointerleave', release);
    }
    micBtn.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (state.degraded && !phone) { try { typed.input.focus({ preventScroll: true }); } catch { /* ignore */ } announce('Microphone unavailable. Type your question below.', 'polite'); return; }
      if (phone) { if (state.call) endCall(); else startCall(); return; }
      if (state.s === 'listening') { try { state.rec ? state.rec.stop() : state.mediaRec?.stop(); } catch { /* ignore */ } return; }
      if (state.s === 'speaking') { state.gen++; try { synth && synth.cancel(); state.audioEl?.pause(); } catch { /* ignore */ } setS('idle', 'Stopped. Tap the mic to ask again.'); return; }
      listen();
    });

    return {
      stop() {
        state.gen++; state.call = false; clearInterval(state.timer);
        try { state.rec && state.rec.abort(); } catch { /* ignore */ }
        try { state.mediaRec && state.mediaRec.state !== 'inactive' && state.mediaRec.stop(); } catch { /* ignore */ }
        try { synth && synth.cancel(); state.audioEl?.pause(); } catch { /* ignore */ }
        closeMic();
        if (state.stopLoop) { state.stopLoop(); state.stopLoop = null; }
      },
    };
  }

  // ============================================================ Developers (11.2)
  const devState = { lang: 'curl', stream: false, reveal: false };
  function buildDevelopers(panel) {
    panel.innerHTML = '';
    const keyBox = h('div', { class: 'gl-key' });
    const endpoints = h('div', { class: 'gl-endpoints' });
    const snippetsEl = h('div', { class: 'gl-snips' });
    const runEl = h('div', { class: 'gl-run' });
    // fixer r4 (D11): the machine-readable contract next to the human one (GET /v1/openapi.json, F)
    const specLink = h('a', { class: 'gl-speclink', href: `${apiRoot}/v1/openapi.json`, target: '_blank', rel: 'noopener', download: 'knowbot-openapi.json' },
      h('span', { html: icon('code', 13) }), 'OpenAPI 3.1 spec', h('span', { class: 'co-sr' }, ' (opens the JSON document)'));
    const errorsEl = h('div', { class: 'gl-errs' });
    panel.append(
      h('div', { class: 'gl-intro' }, h('p', null, h('b', null, 'Route answers into your own interface.'), ' Same retrieval, citations and refusal as the Studio. OpenAI-compatible, so the official SDKs work by changing the base URL.')),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-ep-h' },
        h('div', { class: 'gl-h3-row' }, h('h3', { class: 'gl-h3', id: 'gl-ep-h' }, 'Endpoints'), specLink),
        endpoints),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-key-h' }, h('h3', { class: 'gl-h3', id: 'gl-key-h' }, 'Your trial key'), keyBox),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-sn-h' }, h('h3', { class: 'gl-h3', id: 'gl-sn-h' }, 'Quickstart'), snippetsEl),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-run-h' }, h('h3', { class: 'gl-h3', id: 'gl-run-h' }, 'Run it live'), runEl),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-ref-h' }, h('h3', { class: 'gl-h3', id: 'gl-ref-h' }, 'Response'), responseRef()),
      h('section', { class: 'gl-devsec', 'aria-labelledby': 'gl-err-h' }, h('h3', { class: 'gl-h3', id: 'gl-err-h' }, 'Errors and rate limits'), errorsEl),
      h('p', { class: 'gl-note' }, h('span', { html: icon('trending', 13) }), 'Every API call is logged to your question insights as channel:api. Logged questions are never used as sources. Refusals return exactly: ', h('q', null, NOT_IN_DATA)));

    const paintAll = () => { specLink.href = `${apiRoot}/v1/openapi.json`; paintEndpoints(endpoints); paintKey(keyBox, paintAll); paintSnippets(snippetsEl); paintErrors(errorsEl); };
    paintAll();
    buildRun(runEl);
    loadDev().then(() => { if (!closing) { idPill.querySelector('code').textContent = botId(); paintAll(); } });
  }

  function paintEndpoints(el) {
    el.innerHTML = '';
    const rows = [
      ['POST', `/v1/bots/${botId()}/chat`, 'KnowBot chat · JSON, or SSE with "stream": true (retrieval, delta, final, done)'],
      ['POST', '/v1/chat/completions', `OpenAI-compatible · model = "${botId()}" · citations as footnotes + a knowbot field`],
    ];
    for (const [m, p, d] of rows) {
      el.append(h('div', { class: 'gl-ep' },
        h('span', { class: 'gl-method' }, m),
        h('div', { class: 'gl-ep-main' }, h('code', { class: 'gl-mono gl-ep-path' }, h('span', { class: 'gl-ep-base' }, urlParts(apiRoot)), urlParts(p)), h('small', null, d)),
        copyButton(`${apiRoot}${p}`, 'Copy', { what: 'Endpoint copied', aria: `Copy the ${m === 'POST' && /completions/.test(p) ? 'OpenAI-compatible' : 'chat'} endpoint URL`, iconOnly: true })));
    }
    // fixer r7 (D11): one customer-facing line. CONTRACT-GAP (F): the internal note (bare /v1 is an alias of /api/v1 on
    // the KnowBot server) belongs in the OpenAPI document's description (server/devapi.mjs), not in this panel.
    el.append(h('p', { class: 'gl-ep-canon' }, 'Base URL: ', h('code', null, `${apiRoot}/v1`), ' (works with every OpenAI SDK).'));
  }
  function maskKey(k) { return k ? `${k.slice(0, 13)}${'•'.repeat(10)}${k.slice(-4)}` : ''; }
  function keyFor(code) { const k = dev().key; return k ? (code === 'copy' || devState.reveal ? k : maskKey(k)) : 'YOUR_KNOWBOT_KEY'; }
  function paintKey(el, repaint) {
    el.innerHTML = '';
    const d = dev();
    if (d.status === 'loading') { el.append(h('div', { class: 'gl-key-skel', role: 'status', 'aria-label': 'Loading your key' }, h('i'), h('i'))); return; }
    if (d.status !== 'ok') {
      el.append(h('div', { class: 'gl-key-off' }, h('span', { html: icon('lock', 15) }),
        h('div', null, h('b', null, 'The developer API isn\'t enabled on this server yet.'), h('small', null, 'Your trial key appears here once it is. The snippets below use a placeholder, and Run it live previews the exact response shape through this Studio.'))));
      return;
    }
    const exp = d.expiresAt ? new Date(d.expiresAt) : null;
    const reveal = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small', 'aria-pressed': String(devState.reveal) }, h('span', { html: icon('eye', 14) }), devState.reveal ? 'Hide' : 'Show');
    reveal.addEventListener('click', () => { devState.reveal = !devState.reveal; repaint(); });
    el.append(
      h('div', { class: 'gl-key-row' }, h('code', { class: 'gl-mono gl-key-v' }, h('span', { class: 'co-sr' }, devState.reveal ? 'Trial key: ' : 'Trial key, hidden: '), keyFor()), reveal, copyButton(d.key, 'Copy key', { small: true, what: 'Trial key copied', aria: 'Copy key' })),
      h('p', { class: 'gl-key-meta' }, h('span', { html: icon('shieldCheck', 13) }), `Scoped to ${botId()} only · rate-limited · ${exp ? `expires ${exp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} with your trial` : 'expires with your trial'}. After launch you get kb_live_ keys.`));
  }

  function snippetSet(q) {
    const base = apiBase, id = botId(), st = devState.stream;
    const jq = JSON.stringify(q);
    const shq = (s) => s.replace(/'/g, "'\\''");
    const K = (mode) => keyFor(mode);
    return {
      curl: { label: 'cURL', lang: 'sh', ep: 'chat', code: (m) => `curl ${st ? '-N ' : ''}${apiRoot}/v1/bots/${id}/chat \\\n  -H "Authorization: Bearer ${K(m)}" \\\n  -H "Content-Type: application/json" \\\n  -d '${shq(JSON.stringify(st ? { question: q, stream: true } : { question: q }))}'` },
      js: { label: 'JavaScript', lang: 'js', ep: 'chat', code: (m) => st
        ? `const res = await fetch("${apiRoot}/v1/bots/${id}/chat", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer ${K(m)}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ question: ${jq}, stream: true }),\n});\n\n// Server-sent events: retrieval, delta, final, done\nconst reader = res.body.pipeThrough(new TextDecoderStream()).getReader();\nfor (;;) {\n  const { value, done } = await reader.read();\n  if (done) break;\n  for (const line of value.split("\\n")) {\n    if (line.startsWith("data:")) console.log(JSON.parse(line.slice(5)));\n  }\n}`
        : `const res = await fetch("${apiRoot}/v1/bots/${id}/chat", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer ${K(m)}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ question: ${jq} }),\n});\n\nconst { answer, citations, refused } = await res.json();\nconsole.log(answer);\nfor (const c of citations) console.log(\`[\${c.n}] \${c.file}: \${c.excerpt}\`);` },
      jsOpenai: { label: 'JS · OpenAI SDK', lang: 'js', ep: 'openai', code: (m) => `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  apiKey: "${K(m)}",\n  baseURL: "${apiRoot}/v1",\n});\n\n` + (st
        ? `const stream = await client.chat.completions.create({\n  model: "${id}",\n  messages: [{ role: "user", content: ${jq} }],\n  stream: true,\n});\nfor await (const chunk of stream) {\n  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");\n}`
        : `const completion = await client.chat.completions.create({\n  model: "${id}",\n  messages: [{ role: "user", content: ${jq} }],\n});\n\nconsole.log(completion.choices[0].message.content); // answer + [n] footnotes\nconsole.log(completion.knowbot.citations);          // structured citations`) },
      py: { label: 'Python', lang: 'py', ep: 'chat', code: (m) => st
        ? `import json, requests\n\nwith requests.post(\n    "${apiRoot}/v1/bots/${id}/chat",\n    headers={"Authorization": "Bearer ${K(m)}"},\n    json={"question": ${jq}, "stream": True},\n    stream=True,\n) as r:\n    for line in r.iter_lines(decode_unicode=True):\n        if line and line.startswith("data:"):\n            print(json.loads(line[5:]))`
        : `import requests\n\nr = requests.post(\n    "${apiRoot}/v1/bots/${id}/chat",\n    headers={"Authorization": "Bearer ${K(m)}"},\n    json={"question": ${jq}},\n    timeout=30,\n)\ndata = r.json()\nprint(data["answer"])\nfor c in data["citations"]:\n    print(f"[{c['n']}] {c['file']}: {c['excerpt']}")` },
      pyOpenai: { label: 'Python · OpenAI SDK', lang: 'py', ep: 'openai', code: (m) => `from openai import OpenAI\n\nclient = OpenAI(\n    api_key="${K(m)}",\n    base_url="${apiRoot}/v1",\n)\n\n` + (st
        ? `stream = client.chat.completions.create(\n    model="${id}",\n    messages=[{"role": "user", "content": ${jq}}],\n    stream=True,\n)\nfor chunk in stream:\n    print(chunk.choices[0].delta.content or "", end="")`
        : `completion = client.chat.completions.create(\n    model="${id}",\n    messages=[{"role": "user", "content": ${jq}}],\n)\nprint(completion.choices[0].message.content)  # answer + [n] footnotes\nprint(completion.model_extra["knowbot"]["citations"])`) },
    };
  }
  let snipQ = null, validatedQ = null;
  // Validated starters (GET /questions: each one clears the floor against these files) beat a guessed default.
  ctx.api.questions?.().then((r) => { validatedQ = r?.starters?.[0]?.q || r?.proof?.[0]?.q || null; }).catch(() => {});
  const defaultQ = () => (helpers.lastQA && helpers.lastQA()?.question) || starterQs()[0] || validatedQ || 'What does this cover?';
  function paintSnippets(el) {
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    el.innerHTML = '';
    const q = snipQ || defaultQ();
    const set = snippetSet(q);
    const tl = h('div', { class: 'gl-code-tabs', role: 'tablist', 'aria-label': 'Language' });
    const keys = Object.keys(set);
    for (const k of keys) {
      const b = h('button', { type: 'button', role: 'tab', class: 'gl-code-tab', dataset: { k }, 'aria-selected': String(devState.lang === k), tabindex: devState.lang === k ? '0' : '-1', 'aria-controls': 'gl-snip-pre' }, set[k].label);
      b.addEventListener('click', () => { devState.lang = k; paintSnippets(el); el.querySelector(`[data-k="${k}"]`)?.focus(); });
      tl.append(b);
    }
    tl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = keys.indexOf(devState.lang);
      devState.lang = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      paintSnippets(el); el.querySelector(`[data-k="${devState.lang}"]`)?.focus();
    });
    const sw = h('button', { type: 'button', role: 'switch', class: 'gl-sw', 'aria-checked': String(devState.stream), dataset: { k: 'stream' } }, h('span', { class: 'gl-sw-ui', 'aria-hidden': 'true' }), 'Stream');
    sw.addEventListener('click', () => { devState.stream = !devState.stream; paintSnippets(el); el.querySelector('[data-k="stream"]')?.focus(); });
    const s = set[devState.lang];
    const pre = h('pre', { class: 'gl-pre gl-pre-lg', id: 'gl-snip-pre', tabindex: '0', 'aria-label': `${s.label} example` }, h('code', { html: highlight(s.code('show'), s.lang) }));
    el.append(
      h('div', { class: 'gl-code' }, h('div', { class: 'gl-code-bar' }, tl, h('div', { class: 'gl-code-tools' }, sw, copyButton(() => set[devState.lang].code('copy'), 'Copy', { what: 'Snippet copied', aria: `Copy the ${s.label} snippet`, iconOnly: true }))), preBox(pre)),
      h('p', { class: 'gl-key-meta' }, dev().key ? 'Copy includes your trial key.' : 'Replace YOUR_KNOWBOT_KEY with your key.', ` ${s.ep === 'openai' ? 'Install: ' : ''}`, s.ep === 'openai' ? h('code', { class: 'gl-mono' }, s.lang === 'py' ? 'pip install openai' : 'npm i openai') : null));
    if (keep) el.querySelector(`[data-k="${keep}"]`)?.focus();
  }

  function buildRun(el) {
    const id = `gl-runq-${rid()}`;
    const input = h('input', { id, class: 'input gl-input', type: 'text', maxlength: '500', value: defaultQ() });
    let touched = false;
    input.addEventListener('input', () => { touched = true; });
    setTimeout(() => { if (!touched && !closing && input.value !== defaultQ()) { input.value = defaultQ(); if (!snipQ) paintSnippets($('.gl-snips', panels.developers)); } }, 900);
    const epSel = h('div', { class: 'gl-seg', role: 'radiogroup', 'aria-label': 'Endpoint' });
    let ep = 'chat';
    for (const [k, label] of [['chat', pub('/v1/bots/…/chat')], ['openai', pub('/v1/chat/completions')]]) {
      const b = h('button', { type: 'button', role: 'radio', class: 'gl-seg-b', 'aria-checked': String(ep === k), dataset: { k } }, label);
      b.addEventListener('click', () => { ep = k; $$('.gl-seg-b', epSel).forEach((x) => x.setAttribute('aria-checked', String(x.dataset.k === k))); });
      epSel.append(b);
    }
    const runBtn = h('button', { type: 'submit', class: 'btn btn-primary co-btn co-btn-primary gl-runbtn' }, h('span', { html: icon('play', 14) }), 'Run');
    const out = h('div', { class: 'gl-out', 'aria-live': 'polite' });
    // fixer r2 (D11): the result is announced where the eye is: a status line beside Run ("200 · 41 ms"), and the
    // response block is scrolled into view (smooth, or instant in reduced motion).
    const runMeta = h('span', { class: 'gl-runmeta', role: 'status' });
    const form = h('form', { class: 'gl-runform' }, h('label', { class: 'flabel gl-label', for: id }, 'Question'), h('div', { class: 'gl-runrow' }, input, runBtn), h('div', { class: 'gl-runfoot' }, epSel, runMeta));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      snipQ = q;
      paintSnippets($('.gl-snips', panels.developers));
      runBtn.disabled = true; runBtn.classList.add('is-busy');
      out.innerHTML = '';
      out.append(h('div', { class: 'gl-out-skel', role: 'status', 'aria-label': 'Running' }, h('i'), h('i'), h('i')));
      runMeta.innerHTML = ''; runMeta.append(h('span', { class: 'gl-status' }, 'Running…'));
      revealOut(out, runMeta);
      try {
        const r = await runLive(ep, q);
        renderOut(out, r);
        // fixer r6 (D11): one status line only, in the response block (200 OK · POST path · ms)
        runMeta.innerHTML = '';
      } catch (err) {
        out.innerHTML = '';
        out.append(h('p', { class: 'gl-out-err', role: 'alert' }, h('span', { html: icon('warn', 14) }), err && err.status === 429 ? ` Rate limited. Try again in ${err.retryAfter || 10}s.` : " Couldn't reach your bot. Your question wasn't lost."));
        runMeta.innerHTML = ''; runMeta.append(h('span', { class: 'gl-status is-bad' }, err && err.status === 429 ? '429' : 'Error'));
      } finally { runBtn.disabled = false; runBtn.classList.remove('is-busy'); revealOut(out, runMeta); }
    });
    el.append(form, out);
  }

  /** Brings the response block into view inside the sheet's scroller (it renders below the fold otherwise). */
  function revealOut(out, meta) {
    requestAnimationFrame(() => {
      if (!out.isConnected) return;
      const sc = body, r = out.getBoundingClientRect(), b = sc.getBoundingClientRect();
      if (r.top >= b.top && r.bottom <= b.bottom) return;
      // Taller than the sheet: start from the status row (200 · 41 ms) so the result reads top-down.
      const anchor = meta && meta.parentElement ? meta.parentElement : out;
      const top = sc.scrollTop + (r.height > b.height - 32 ? anchor.getBoundingClientRect().top - b.top - 12 : r.bottom - b.bottom + 16);
      sc.scrollTo({ top: Math.max(0, top), behavior: motion.reduced() ? 'auto' : 'smooth' });
    });
  }

  /** Calls the real /v1 endpoint with the trial key; if the server has no developer API, previews the same shape via /ask. */
  async function runLive(ep, q) {
    const d = await loadDev();
    const path = ep === 'openai' ? '/v1/chat/completions' : `/v1/bots/${botId()}/chat`;
    if (d.status === 'ok') {
      const t0 = performance.now();
      try {
        const res = await fetch(`${apiRoot}${path}`, {
          method: 'POST', credentials: 'omit',
          headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' },
          body: JSON.stringify(ep === 'openai' ? { model: botId(), messages: [{ role: 'user', content: q }] } : { question: q }),
        });
        const ms = Math.round(performance.now() - t0);
        const json = await res.json().catch(() => null);
        if (res.ok && json) return { live: true, status: res.status, ms, path, json, ep };
        if (res.status === 429) { const e = new Error('rate'); e.status = 429; e.retryAfter = Number(res.headers.get('retry-after')) || null; throw e; }
        if (![404, 405, 501, 503].includes(res.status)) return { live: true, status: res.status, ms, path, json: json || { error: `HTTP ${res.status}` }, ep };
      } catch (err) { if (err && err.status === 429) throw err; /* fall through to the preview */ }
    }
    const r = await askBot(ctx, q);
    const fin = r.final || {};
    const citations = (r.citations || []).map((c) => ({ n: c.n, file: c.file, title: c.title || c.file, excerpt: c.excerpt, url: null }));
    const proof = { hits: r.refused ? [] : (r.retrieval?.hits || []).filter((x) => x.kept).map((x) => ({ file: x.file, similarity: x.similarity })), quoted: (fin.proof?.quotedLines || []).map((x) => ({ n: x.n, text: x.text, file: x.file })) };
    const json = ep === 'openai'
      ? { id: `chatcmpl-${rid(12)}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: botId(),
          choices: [{ index: 0, message: { role: 'assistant', content: r.refused ? r.text : `${r.text}\n\n${citations.map((c) => `[${c.n}] ${c.file}`).join('\n')}`.trim() }, finish_reason: 'stop' }],
          knowbot: { citations, refused: r.refused, proof } }
      : { id: `chat_${rid(12)}`, answer: r.text, citations, refused: r.refused, grounded: !r.refused && citations.length > 0, proof, usage: { latencyMs: r.ms } };
    return { live: false, status: 200, ms: r.ms, path, json, ep };
  }

  function renderOut(out, r) {
    out.innerHTML = '';
    const j = r.json || {};
    const answer = r.ep === 'openai' ? j.choices?.[0]?.message?.content : j.answer;
    const cits = (r.ep === 'openai' ? j.knowbot?.citations : j.citations) || [];
    const refused = r.ep === 'openai' ? j.knowbot?.refused : j.refused;
    const ok = r.status >= 200 && r.status < 300;
    // fixer r2 (D11): Element.append() stringifies null ("null" text node); only real nodes go in.
    out.append(...[
      h('div', { class: 'gl-out-bar', role: 'status' },
        h('span', { class: `gl-status${ok ? (r.live ? ' is-ok' : ' is-prev') : ' is-bad'}` }, r.live ? `${r.status} ${ok ? 'OK' : 'Error'}` : 'Preview'),
        h('span', { class: 'gl-out-line' }, h('code', { class: 'gl-mono' }, 'POST ', urlParts(pub(r.path))), h('span', { class: 'gl-out-sep', 'aria-hidden': 'true' }, ' · '), h('span', { class: 'gl-mono gl-out-ms' }, `${r.ms} ms`))),
      !r.live ? h('p', { class: 'gl-out-note' }, h('span', { html: icon('info', 13) }), ' The /v1 API isn\'t enabled on this server, so this ran through your Studio bot and is shown in the exact /v1 response shape.') : null,
      answer != null ? h('div', { class: `gl-out-answer${refused ? ' is-refused' : ''}` }, h('p', null, lines(String(answer).split('\n\n')[0]).join('\n')),
        cits.length ? h('ul', { class: 'gl-out-cits' }, cits.map((c) => h('li', null, h('span', { class: 'gl-wcite' }, String(c.n)), h('b', null, c.file), c.excerpt ? h('q', null, String(c.excerpt).slice(0, 160)) : null))) : null) : null,
      h('details', { class: 'gl-json', open: true }, h('summary', null, 'JSON response'), preBox(h('pre', { class: 'gl-pre', tabindex: '0', 'aria-label': 'JSON response' }, h('code', { html: highlightJson(j) })))),
    ].filter(Boolean));
    motion.stagger([...out.children], [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 50);
    announce(refused ? 'Refused with the canonical text.' : `Answer with ${cits.length} citation${cits.length === 1 ? '' : 's'}.`, 'polite');
  }

  /** Errors: the real codes the server returns ({error:{message,type,code,param,status}}), plus the key's rate limit. */
  function paintErrors(el) {
    el.innerHTML = '';
    const per = Number(dev().rateLimit?.perMinute) || null;
    const rows = [
      ['400', 'invalid_request', 'The body is not {question} or {messages:[…]}, or the question is too long', '{"question": 42}'],
      ['401', 'missing_api_key', 'No Authorization header', 'curl … (no -H "Authorization")'],
      ['401', 'invalid_api_key', 'The key is malformed, unknown or revoked', 'Bearer kb_trial_wrong'],
      ['401', 'expired_api_key', 'A trial key outlived its trial', 'a kb_trial_ key after 7 days'],
      ['403', 'wrong_bot', 'The key belongs to another bot', `/v1/bots/other-bot/chat`],
      ['403', 'bad_signature', 'Channel webhooks: the request signature did not verify', 'a forged SMS webhook'],
      ['404', 'bot_not_found · model_not_found', 'No such bot, or model ≠ your bot id', '"model": "gpt-4o"'],
      ['429', 'rate_limit_exceeded', 'Too many requests for this key. Wait retry-after seconds', 'retry-after: 12'],
      ['503', 'channel_not_configured', 'A channel webhook whose provider secret is not set', 'SMS before the number is connected'],
    ];
    el.append(
      h('p', { class: 'gl-ratelim' }, h('span', { html: icon('bolt', 13) }),
        per ? h('span', null, h('b', null, `${per} requests per minute`), ' for this key. Every response carries ', h('code', { class: 'gl-mono' }, 'x-ratelimit-limit'), ', ', h('code', { class: 'gl-mono' }, 'x-ratelimit-remaining'), ' and ', h('code', { class: 'gl-mono' }, 'x-ratelimit-reset'), '; a 429 adds ', h('code', { class: 'gl-mono' }, 'retry-after'), ' (seconds).')
          : h('span', null, 'Every key is rate-limited per minute. Responses carry ', h('code', { class: 'gl-mono' }, 'x-ratelimit-*'), ' headers; a 429 adds ', h('code', { class: 'gl-mono' }, 'retry-after'), ' (seconds).')),
      // KnowDrive's .data-table inside a .card (the container motif); the card scrolls sideways on a phone
      h('div', { class: 'card gl-ref-wrap', tabindex: '0', role: 'region', 'aria-label': 'Error codes' }, h('table', { class: 'data-table is-static gl-ref gl-ref-err' },
        h('thead', null, h('tr', null, ['Status', 'Code', 'Meaning', 'Example'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.map(([st, code, m, ex]) => h('tr', null,
          h('td', null, h('span', { class: `gl-status ${st === '429' ? 'is-prev' : 'is-bad'}` }, st)),
          h('td', null, h('code', { class: 'gl-mono' }, code)), h('td', null, m), h('td', null, h('code', { class: 'gl-mono gl-ref-t' }, ex))))))),
      h('div', { class: 'gl-code' },
        h('div', { class: 'gl-code-bar' }, h('span', { class: 'gl-code-label' }, 'Error body (every status)')),
        h('pre', { class: 'gl-pre', tabindex: '0', 'aria-label': 'Example error body' }, h('code', { html: highlightJson({ error: { message: `Rate limit reached (${per || 30} requests per minute for this key). Retry in 12s.`, type: 'rate_limit_error', code: 'rate_limit_exceeded', param: null, status: 429 } }) }))));
  }

  function responseRef() {
    const rows = [
      ['answer', 'string', 'The answer, every line backed by a quoted source line'],
      ['citations[]', '{n, file, title, excerpt, url?}', '[n] markers in answer map to these, in order'],
      ['refused', 'boolean', 'true → answer is exactly the canonical refusal'],
      ['grounded', 'boolean', 'true when at least one citation backs the answer'],
      ['proof.hits[]', '{file, similarity}', 'Vector similarity 0–1 of the kept passages'],
      ['proof.quoted[]', '{n, text, file}', 'The verbatim lines the answer was built from'],
      ['usage.latencyMs', 'number', 'Server time for this answer'],
    ];
    return h('div', { class: 'card gl-ref-wrap', tabindex: '0', role: 'region', 'aria-label': 'Response fields' }, h('table', { class: 'data-table is-static gl-ref' },
      h('thead', null, h('tr', null, ['Field', 'Type', 'Meaning'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map(([f, t, m]) => h('tr', null, h('td', null, h('code', { class: 'gl-mono' }, f)), h('td', null, h('code', { class: 'gl-mono gl-ref-t' }, t)), h('td', null, m))))));
  }

  // ------------------------------------------------------------ go
  select(tab === 'developers' ? 'developers' : 'channels', channel || (mine.size ? CH()[0].id : null));
  // the sheet opens with focus on the selected tab (the strip renders in a frame or two, once React has loaded)
  if (!inline) tabs.ready.then(() => { let n = 0; const go = () => { const t = body.querySelector('[role="tab"][aria-selected="true"]'); if (t) t.focus(); else if (++n < 30 && !closing) requestAnimationFrame(go); }; requestAnimationFrame(go); }).catch(() => {});
  if (inline) return { close: doClose, select };
  current = { close: doClose, select };
  return doClose;
}
