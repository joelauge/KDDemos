// LEGACY: the first Single-page site (a full search page). Kept only for HTML files owners downloaded before the
// homepage overlay (site/overlay.js) replaced it; the hosted link and new downloads use the overlay.
//
// KnowBot Single-page site: a clean search page built from one bot's own files (server/site.mjs).
//
//   hosted:     https://knowbot.knowdrive.ai/site/?bot=<botId>[&q=<question>]
//   downloaded: <script type="module" src=".../site/site.js" data-bot="<botId>" data-api="<KnowBot API origin>">
//
// It reads the site (GET <api>/api/site/:bot: name, description, topic chips, popular questions, verbatim key facts,
// source links, and a short-lived key that can only ask questions), then asks through the developer API
// (POST <api>/api/v1/bots/:bot/chat, streamed). Answers show their quotes as blocks with [n] marks and a Sources list:
// a website page links to the page itself, an uploaded file to the answer's proof page. No framework, no build step.
// The Studio's preview passes the owner's trial key in the URL fragment (#k=…): never sent anywhere but the API.
import { hostedApi } from '../lib/site-config.js?v=8bb7c43';

const me = new URL(import.meta.url);
const tag = [...document.querySelectorAll('script[src]')].find((s) => s.src === me.href) || document.querySelector('script[src*="site.js"]');
const d = tag?.dataset || {};
const params = new URLSearchParams(location.search);
const BOT = String(d.bot || params.get('bot') || '').trim().toLowerCase();
// ?api= only for a loopback dev server (a crafted link must never repoint a real site's answers)
const apiParam = (() => { try { const u = new URL(params.get('api') || ''); return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) ? u.origin : null; } catch { return null; } })();
const API = String(d.api || apiParam || hostedApi() || location.origin).replace(/\/+$/, '');
let ownerKey = null;
if (/^#k=kb_trial_/.test(location.hash)) {
  ownerKey = decodeURIComponent(location.hash.slice(3));
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep going */ }
}
const NOT_IN_DATA = "The answer to that doesn't seem to be in my files.";

// ---------------------------------------------------------------------------------------------------- helpers
function h(t, props, ...kids) {
  const el = document.createElement(t);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const meta = (sel, attr, val) => { let m = document.head.querySelector(sel); if (!m) { m = document.createElement('meta'); const [k, v] = /\[(\w+(?::\w+)?)="([^"]+)"\]/.exec(sel).slice(1); m.setAttribute(k, v); document.head.append(m); } m.setAttribute(attr, val); };
const visitor = (() => { try { let v = localStorage.getItem('ks-visitor'); if (!v) { v = Math.random().toString(36).slice(2, 12); localStorage.setItem('ks-visitor', v); } return v; } catch { return 'anon'; } })();
if (!/(^|\s)dark(\s|$)/.test(document.documentElement.className) && !params.get('theme')) {
  try { if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark'); } catch { /* light */ }
}

const root = document.getElementById('ks-root') || document.body.appendChild(h('div', { id: 'ks-root', class: 'ks-root' }));
let site = null;
const history_ = [];   // the last turns, for follow-ups: [{role, content}]
let busy = false;

// ---------------------------------------------------------------------------------------------------- the site
async function loadSite() {
  const r = await fetch(`${API}/api/site/${encodeURIComponent(BOT)}`, { headers: ownerKey ? { authorization: `Bearer ${ownerKey}` } : {}, credentials: 'omit' });
  if (!r.ok) { const e = new Error('site'); e.status = r.status; throw e; }
  return r.json();
}

function applyBrand(s) {
  const st = document.getElementById('ks-brand') || document.head.appendChild(h('style', { id: 'ks-brand' }));
  const c = /^#[0-9a-f]{6}$/i.test(s.brand?.color || '') ? s.brand.color : null;
  const dk = /^#[0-9a-f]{6}$/i.test(s.brand?.colorDark || '') ? s.brand.colorDark : c;
  st.textContent = c ? `:root{--ks-accent:${c};--kd-brand-purple:${c}}html.dark{--ks-accent:${dk};--kd-brand-purple:${dk}}` : '';
  document.title = `${s.name} · Ask anything`;
  meta('meta[name="description"]', 'content', s.tagline || `Ask anything about ${s.name}.`);
  meta('meta[property="og:title"]', 'content', document.title);
  meta('meta[property="og:description"]', 'content', s.tagline || '');
  if (s.noindex) meta('meta[name="robots"]', 'content', 'noindex');
}

function render(s) {
  root.textContent = '';
  const logo = safeUrl(s.brand?.logo)
    ? h('img', { class: 'ks-logo', src: s.brand.logo, alt: '', width: '40', height: '40', referrerpolicy: 'no-referrer', loading: 'eager' })
    : h('span', { class: 'ks-mark', 'aria-hidden': 'true' }, s.initials || s.name.slice(0, 2).toUpperCase());
  const home = safeUrl(s.homeUrl);
  const header = h('header', { class: 'ks-top' },
    h('div', { class: 'ks-brand' }, logo, h('span', { class: 'ks-brand-name' }, s.name)),
    home ? h('a', { class: 'ks-home', href: home, rel: 'noopener' }, `Visit ${hostOf(home) || 'our website'}`) : null);
  if (s.preview) header.append(h('p', { class: 'chip amber ks-preview', role: 'note' }, 'Preview · not published yet'));

  const input = h('input', { id: 'ks-q', class: 'input ks-input', type: 'search', name: 'q', autocomplete: 'off', maxlength: '500', placeholder: 'Type your question', enterkeyhint: 'search' });
  const form = h('form', { class: 'ks-search', role: 'search' },
    h('label', { class: 'ks-label', for: 'ks-q' }, `Ask anything about ${s.name}`),
    h('div', { class: 'ks-search-row' }, input, h('button', { class: 'btn btn-primary ks-go', type: 'submit' }, 'Search')));
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });

  const chips = (s.chips || []).length ? h('div', { class: 'ks-chips', role: 'group', 'aria-label': 'Topics' },
    s.chips.map((c) => h('button', { type: 'button', class: 'chipbtn ks-chip', onclick: () => ask(c.q), title: c.q }, c.label))) : null;

  const hero = h('section', { class: 'ks-hero', 'aria-labelledby': 'ks-h1' },
    h('h1', { id: 'ks-h1', class: 'ks-h1' }, s.name), s.tagline ? h('p', { class: 'ks-tag' }, s.tagline) : null, form, chips);

  const answers = h('section', { id: 'ks-answers', class: 'ks-answers', 'aria-label': 'Answers', hidden: true });
  const status = h('p', { id: 'ks-status', class: 'ks-sr', role: 'status', 'aria-live': 'polite' });

  const popular = (s.questions || []).length ? h('section', { class: 'card ks-card ks-popular', 'aria-labelledby': 'ks-pop-h' },
    h('h2', { id: 'ks-pop-h', class: 'ks-h2' }, 'Popular questions'),
    h('ul', { class: 'ks-qlist' }, s.questions.map((q) => h('li', null, h('a', { href: `?${shareQuery(q)}`, class: 'ks-qlink', onclick: (e) => { e.preventDefault(); ask(q); } }, q))))) : null;

  const facts = (s.facts || []).length ? h('section', { class: 'card ks-card ks-facts', 'aria-labelledby': 'ks-facts-h' },
    h('h2', { id: 'ks-facts-h', class: 'ks-h2' }, 'Key facts'),
    h('ul', { class: 'ks-factlist' }, s.facts.map((f) => {
      const u = safeUrl(f.url);
      return h('li', { class: 'ks-fact' }, h('span', { class: 'ks-fact-k' }, f.label),
        h('blockquote', { class: 'ks-quote' }, f.text),
        h('span', { class: 'ks-fact-src' }, 'From ', u ? h('a', { href: u, rel: 'noopener', target: '_blank' }, cleanTitle(f.file), h('span', { class: 'ks-sr' }, ' (opens in a new tab)')) : cleanTitle(f.file)));
    }))) : null;

  const footer = h('footer', { class: 'ks-foot' },
    h('p', null, `Answers come only from ${s.name}'s own pages.`),
    h('p', { class: 'ks-built' }, h('a', { href: 'https://knowbot.knowdrive.ai/', rel: 'noopener' }, 'Built with KnowBot')));

  const main = h('main', { class: 'ks-main' }, hero, status, answers, h('div', { class: 'ks-more' }, popular, facts));
  root.append(header, main, footer);
  return { input, answers, status };
}

/** "Refund policy · https://shop.example/policies/refund-policy" → "Refund policy" (the link is in Sources). */
const noUrl = (s) => String(s || '').replace(/\s*[·|–-]\s*https?:\/\/[^\s”"]+/g, '').trim();
const cleanTitle = (f) => String(f || 'Source').split('/').pop().replace(/\.[a-z0-9]{1,6}$/i, '').replace(/^.* · /, '').replace(/[-_]+/g, ' ').trim();
const shareQuery = (q) => { const p = new URLSearchParams(); if (!d.bot) p.set('bot', BOT); p.set('q', q); return p.toString(); };

// ---------------------------------------------------------------------------------------------------- asking
let ui = null;
async function ask(qRaw) {
  const q = String(qRaw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q || busy || !site) return;
  busy = true;
  ui.input.value = '';
  document.body.classList.add('is-asked');
  try { history.replaceState(null, '', `${location.pathname}?${shareQuery(q)}`); } catch { /* fine */ }
  const turn = h('article', { class: 'card ks-turn', 'aria-busy': 'true' },
    h('h2', { class: 'ks-q' }, q),
    h('div', { class: 'ks-a' }, h('p', { class: 'ks-typing' }, h('span', { class: 'ks-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'ks-sr' }, 'Searching…'))));
  ui.answers.hidden = false;
  ui.answers.querySelector('.ks-follow')?.remove();
  ui.answers.append(turn);
  ui.status.textContent = `Searching for: ${q}`;
  turn.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  let final = null;
  try {
    final = await stream(q, (text) => {
      const a = turn.querySelector('.ks-a');
      a.textContent = '';
      a.append(h('p', { class: 'ks-streaming' }, text.replace(/\s*\[\d{1,3}\]/g, '')));
    });
  } catch (e) {
    turn.querySelector('.ks-a').replaceChildren(h('p', { class: 'ks-err' }, e.message || "Couldn't answer right now. Try again in a moment."));
  }
  if (final) {
    renderAnswer(turn, final);
    history_.push({ role: 'user', content: q }, { role: 'assistant', content: String(final.answer || '') });
    while (history_.length > 8) history_.shift();
    ui.status.textContent = final.refused ? 'No answer found in this site’s pages.' : `Answer ready, with ${final.citations?.length || 0} ${final.citations?.length === 1 ? 'source' : 'sources'}.`;
  }
  turn.removeAttribute('aria-busy');
  ui.answers.append(followUp());
  busy = false;
}

async function stream(q, onText, retried = false) {
  const res = await fetch(`${API}/api/v1/bots/${encodeURIComponent(BOT)}/chat`, {
    method: 'POST', credentials: 'omit',
    headers: { authorization: `Bearer ${ownerKey || site.key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ question: q, history: history_.slice(-6), stream: true, format: 'bullets', user: visitor }),
  });
  if (res.status === 401 && !retried && !ownerKey) { site = { ...site, ...(await loadSite()) }; return stream(q, onText, true); }
  if (res.status === 429) throw new Error('Lots of questions right now. Wait a few seconds and try again.');
  if (!res.ok || !res.body) throw new Error("Couldn't answer right now. Try again in a moment.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', final = null, err = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(frame)?.[1];
      let data = null; try { data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] || 'null'); } catch { /* skip */ }
      if (ev === 'delta' && data) { text += data.raw ?? data.text ?? ''; onText(text); }
      else if (ev === 'final') final = data;
      else if (ev === 'error') err = data?.message;
    }
  }
  if (!final) throw new Error(err || "Couldn't answer right now. Try again in a moment.");
  return final;
}

/** A source's link: the website page it came from, else the answer's proof page (every quote in context). */
function sourceOf(c, final) {
  const L = site.links || {};
  const fid = (final.proof?.quoted || []).find((x) => x.n === c.n && x.fileId)?.fileId;
  const page = safeUrl(c.url) || safeUrl(fid && L.byId?.[fid]) || safeUrl(L.byName?.[String(c.file || '').split('/').pop()]);
  if (page) return { href: page, kind: 'page', where: hostOf(page) };
  const proof = safeUrl(final.proofUrl);
  return proof ? { href: proof, kind: 'proof', where: 'Proof page' } : { href: null, kind: 'none', where: '' };
}

function cite(n, turnId) {
  return h('a', { class: 'ks-n', href: `#${turnId}-s${n}`, 'aria-label': `Source ${n}` }, String(n));
}

let turnSeq = 0;
function renderAnswer(turn, final) {
  const a = turn.querySelector('.ks-a');
  a.textContent = '';
  const id = turn.id = `ks-t${++turnSeq}`;
  if (final.refused || !(final.citations || []).length) {
    a.append(h('p', { class: 'ks-refusal' }, String(final.answer || NOT_IN_DATA).trim() || NOT_IN_DATA),
      h('p', { class: 'ks-hint' }, 'Try different words, or pick a topic above.'));
    return;
  }
  // one line per claim (format "bullets"); a line that ends in a quotation is shown as a quote block
  for (const raw of String(final.answer || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const marks = [...raw.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
    const line = raw.replace(/^[-*•]\s+/, '').replace(/\s*\[\d{1,3}\]/g, '').trim();
    const end = line.lastIndexOf('”');
    const start = end > 0 ? line.lastIndexOf('“', end) : -1;
    const nums = [...new Set(marks)].map((n) => cite(n, id));
    if (start >= 0 && end >= line.length - 2 && end - start > 3) {
      const lead = noUrl(line.slice(0, start)).trim().replace(/[:,]$/, '').trim();
      if (lead) a.append(h('p', { class: 'ks-from' }, `${lead}:`));
      a.append(h('blockquote', { class: 'ks-quote' }, line.slice(start + 1, end).trim(), ' ', nums));
    } else a.append(h('p', null, line, nums.length ? ' ' : '', nums));
  }
  const list = h('ol', { class: 'ks-srclist' });
  for (const c of final.citations) {
    const s = sourceOf(c, final);
    const title = noUrl(c.title || '') || cleanTitle(c.file);
    list.append(h('li', { id: `${id}-s${c.n}`, class: 'ks-src' },
      h('span', { class: 'ks-src-n', 'aria-hidden': 'true' }, String(c.n)),
      h('div', { class: 'ks-src-body' },
        s.href ? h('a', { class: 'ks-src-link', href: s.href, target: '_blank', rel: 'noopener' }, title, h('span', { class: 'ks-sr' }, ' (opens in a new tab)')) : h('b', null, title),
        h('span', { class: 'ks-src-where' }, [s.where, c.page ? `page ${c.page}` : null, c.section || null].filter(Boolean).join(' · ')))));
  }
  a.append(h('section', { class: 'ks-sources', 'aria-label': 'Sources' }, h('h3', { class: 'ks-h3' }, 'Sources'), list));
}

function followUp() {
  const inp = h('input', { id: `ks-f${turnSeq}`, class: 'input ks-input', type: 'text', autocomplete: 'off', maxlength: '500', placeholder: 'Ask a follow-up', enterkeyhint: 'send' });
  const f = h('form', { class: 'ks-follow' },
    h('label', { class: 'ks-label ks-label-sm', for: inp.id }, 'Ask a follow-up'),
    h('div', { class: 'ks-search-row' }, inp, h('button', { class: 'btn btn-primary ks-go', type: 'submit' }, 'Ask')),
    h('button', { type: 'button', class: 'btn btn-ghost ks-share', onclick: share }, 'Copy link to this answer'));
  f.addEventListener('submit', (e) => { e.preventDefault(); ask(inp.value); });
  return f;
}
async function share(e) {
  const b = e.currentTarget;
  try { await navigator.clipboard.writeText(location.href); b.textContent = 'Link copied'; } catch { b.textContent = location.href; }
  ui.status.textContent = 'Link copied.';
}

// ---------------------------------------------------------------------------------------------------- start
async function start() {
  if (!/^[a-z0-9-]{1,40}$|^tr_[a-z2-7]{16}$/.test(BOT)) {
    root.replaceChildren(h('main', { class: 'ks-main ks-empty' }, h('h1', { class: 'ks-h1' }, 'No site here yet'), h('p', null, 'This link is missing its site. Check the link you were given.')));
    return;
  }
  try { site = await loadSite(); } catch (e) {
    root.replaceChildren(h('main', { class: 'ks-main ks-empty' }, h('h1', { class: 'ks-h1' }, 'This page is not available'),
      h('p', null, e.status === 404 ? 'It may not be published yet, or its trial has ended.' : "We couldn't load this page. Try again in a moment.")));
    return;
  }
  applyBrand(site);
  ui = render(site);
  const q = params.get('q');
  if (q) ask(q);
}
start();
