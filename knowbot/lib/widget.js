// KnowBot UI: floating widget, inline panel, full-page chat. Plain ESM, imports the core library.
import { KnowBot } from './knowbot.js?v=e98cc5f';

const CSS_URL = new URL('./knowbot.css?v=e98cc5f', import.meta.url).href;
let uid = 0;

/* ---------- tiny safe markdown ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function inline(s, cite) {
  return escapeHtml(s)
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()[\]]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>')
    .replace(/\[([^\]\n]{1,200})\]\(mailto:([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\)/g, '<a href="mailto:$2">$1</a>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\s?\[(\d{1,2})\](?!\()([.,;:!?)]*)/g, (_, n, p) => `<span class="kb-cw">${cite(+n)}${p}</span>`);
}

/** Escape first, then: **bold**, *em*, `code`, [text](http(s) only), - / 1. lists, # headings, line breaks, [n] chips. */
export function renderMarkdown(text, cite = (n) => `<sup class="kb-cite kb-cite--pending">${n}</sup>`) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; };
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      const tag = m[1] ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(inline(m[3], cite));
    } else if (!line.trim()) { flushPara(); flushList(); }
    else {
      flushList();
      const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) { flushPara(); out.push(`<p class="kb-h">${inline(h[1], cite)}</p>`); } else para.push(inline(line.trim(), cite));
    }
  }
  flushPara(); flushList();
  return out.join('');
}

/* ---------- helpers ---------- */

function h(tag, attrs = {}, html) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  if (html != null) el.innerHTML = html;
  return el;
}

export function ensureCss(href = CSS_URL) {
  if (typeof document === 'undefined' || href === false) return;
  if (document.querySelector('link[data-knowbot-css]')) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href, 'data-knowbot-css': '' }));
}

const ICON = {
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.8c-.5.4-1.4.1-1.4-.6z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9zm2 9h8.3a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 18.5 10H14l.7-3.6A1.8 1.8 0 0 0 11.4 5L9 10.5z" fill="currentColor"/></svg>',
};
ICON.down = ICON.up.replace('<svg ', '<svg style="transform:scaleY(-1)" ');

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/* ---------- chat view (shared by all surfaces) ---------- */

class ChatView {
  constructor(container, kind, o) {
    this.o = o;
    this.id = `kb${++uid}`;
    const persona = { name: 'KnowBot', org: 'this organization', ...o.persona };
    this.bot = o.bot || new KnowBot({ ...o, persona, surface: { ...(o.surface || {}), kind } });
    this.busy = false;
    const title = o.title || persona.name;
    const sub = o.subtitle || `Answers cite ${persona.org}'s knowDrive`;
    this.el = h('section', { class: `kb-panel kb-panel--${kind}`, role: kind === 'widget' ? 'dialog' : 'region', 'aria-label': `${title} chat`, id: `${this.id}-panel` });
    this.el.innerHTML = `
      <header class="kb-head">
        <div class="kb-avatar" aria-hidden="true">${escapeHtml(title.slice(0, 1))}</div>
        <div class="kb-head-text"><div class="kb-title">${escapeHtml(title)}</div><div class="kb-sub">${escapeHtml(sub)}</div></div>
      </header>
      <div class="kb-progress" hidden><div class="kb-bar" role="progressbar" aria-label="Model download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><div class="kb-progress-text"></div></div>
      <div class="kb-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Conversation"></div>
      <div class="kb-starters" role="group" aria-label="Suggested questions"></div>
      <form class="kb-form" autocomplete="off">
        <label class="kb-sr" for="${this.id}-in">Ask ${escapeHtml(title)} a question</label>
        <textarea id="${this.id}-in" class="kb-input" rows="1" maxlength="2000" placeholder="${escapeHtml(o.placeholder || 'Ask a question…')}"></textarea>
        <button class="kb-send" type="submit" aria-label="Send">${ICON.send}</button>
      </form>
      <div class="kb-foot">Grounded answers from the knowDrive · <span class="kb-engine"></span></div>`;
    container.appendChild(this.el);
    const $ = (s) => this.el.querySelector(s);
    Object.assign(this, { log: $('.kb-log'), input: $('.kb-input'), form: $('.kb-form'), sendBtn: $('.kb-send'),
      starters: $('.kb-starters'), prog: $('.kb-progress'), head: $('.kb-head') });
    $('.kb-engine').textContent = this.bot.engine.type === 'webllm' ? 'runs in your browser' : `engine: ${this.bot.engine.type}`;
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.log.addEventListener('click', (e) => this.onCite(e));
    if (o.greeting !== false) this.addBot(o.greeting || `Hi! I'm ${title}. Ask me anything about ${persona.org} — every answer cites the files it came from.`, 'kb-greet');
    for (const q of o.starters || []) {
      this.starters.appendChild(h('button', { type: 'button', class: 'kb-starter', onclick: () => this.ask(q) })).textContent = q;
    }
    this.starters.hidden = !(o.starters || []).length;
    if (o.preload && this.bot.engine.type === 'webllm') this.loadModel().catch(() => {});
  }

  autosize() { this.input.style.height = 'auto'; this.input.style.height = Math.min(this.input.scrollHeight, 140) + 'px'; }
  focus() { this.input.focus({ preventScroll: true }); }
  scroll() { this.log.scrollTop = this.log.scrollHeight; }

  submit() {
    const q = this.input.value.trim();
    if (!q || this.busy) return;
    this.input.value = '';
    this.autosize();
    this.ask(q);
  }

  addBot(text, cls = '') {
    const msg = h('article', { class: `kb-msg kb-bot ${cls}`, 'aria-label': `${this.bot.persona.name} says` });
    msg.innerHTML = `<div class="kb-bubble"><div class="kb-md">${renderMarkdown(text)}</div></div>`;
    this.log.appendChild(msg);
    this.scroll();
    return msg;
  }

  progress(p) {
    if (!p) { this.prog.hidden = true; return; }
    this.prog.hidden = false;
    const pct = Math.round((p.progress || 0) * 100);
    this.prog.querySelector('span').style.width = pct + '%';
    this.prog.querySelector('.kb-bar').setAttribute('aria-valuenow', pct);
    this.prog.querySelector('.kb-progress-text').textContent = p.text || `Loading model… ${pct}%`;
    if (p.progress >= 1) setTimeout(() => this.progress(null), 600);
  }

  async loadModel() {
    if (this.bot.engine.loaded) return;
    const gpu = typeof navigator !== 'undefined' && navigator.gpu;
    if (!gpu || !(await gpu.requestAdapter().catch(() => null))) {
      this.progress({ progress: 0, text: 'No WebGPU adapter in this browser, so the in-browser model cannot run. Try desktop Chrome or Edge.' });
      throw new Error('WebGPU is not available in this browser.');
    }
    this.progress({ progress: 0, text: 'Downloading the model (first visit only)…' });
    await this.bot.load((p) => this.progress(p));
  }

  async ask(question) {
    if (this.busy) return;
    this.busy = true;
    this.sendBtn.disabled = true;
    this.starters.hidden = true;
    const u = h('article', { class: 'kb-msg kb-user', 'aria-label': 'You said' });
    u.innerHTML = `<div class="kb-bubble"></div>`;
    u.firstChild.textContent = question;
    this.log.appendChild(u);
    const msg = this.addBot('', 'kb-pending');
    const md = msg.querySelector('.kb-md');
    md.innerHTML = '<span class="kb-status">Searching the knowDrive</span><span class="kb-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    this.log.setAttribute('aria-busy', 'true');
    let raf = 0, latest = '';
    const paint = () => { raf = 0; md.innerHTML = renderMarkdown(latest) + '<span class="kb-caret" aria-hidden="true"></span>'; this.scroll(); };
    try {
      if (this.bot.engine.type === 'webllm' && !this.bot.engine.loaded) await this.loadModel();
      const answer = await this.bot.ask(question, {
        onStatus: (s) => { if (s.phase === 'generating' && !latest) md.querySelector('.kb-status') && (md.querySelector('.kb-status').textContent = 'Writing an answer'); },
        onToken: (_, full) => { latest = full; if (!raf) raf = requestAnimationFrame(paint); },
        onProgress: (p) => this.progress(p),
      });
      cancelAnimationFrame(raf);
      this.renderAnswer(msg, answer);
      this.o.onAnswer?.(answer);
    } catch (err) {
      cancelAnimationFrame(raf);
      msg.className = 'kb-msg kb-bot kb-error';
      md.innerHTML = renderMarkdown(`Sorry, something went wrong: ${err?.message || err}`);
      this.o.onError?.(err);
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.log.setAttribute('aria-busy', 'false');
      this.scroll();
    }
  }

  renderAnswer(msg, a) {
    const mid = `${this.id}-${a.turnId.replace(/[^\w-]/g, '_')}`;
    msg.className = `kb-msg kb-bot${a.refused ? ' kb-refused' : !a.grounded ? ' kb-ungrounded' : ''}`;
    msg.dataset.turn = a.turnId;
    const byN = new Map(a.citations.map((c) => [c.n, c]));
    const cite = (n) => {
      const c = byN.get(n);
      return c ? `<sup><a class="kb-cite" href="#${mid}-s${n}" data-n="${n}" aria-label="Source ${n}: ${escapeHtml(c.title)}">${n}</a></sup>` : '';
    };
    const badge = a.refused ? '<div class="kb-badge">Not in the knowDrive</div>' : !a.grounded ? '<div class="kb-badge">No supporting source</div>'
      : a.fallback ? '<div class="kb-badge">Sources matched automatically</div>' : '';
    let html = `<div class="kb-bubble">${badge}<div class="kb-md">${renderMarkdown(a.text, cite)}</div></div>`;
    if (a.citations.length) {
      html += `<div class="kb-sources"><div class="kb-sources-h" id="${mid}-sh">Sources</div><ol aria-labelledby="${mid}-sh">${a.citations.map((c) => {
        const url = safeUrl(c.url), t = escapeHtml(c.title);
        return `<li id="${mid}-s${c.n}" tabindex="-1"><span class="kb-src-n">${c.n}</span><div class="kb-src-body">${url ? `<a class="kb-src-title" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<span class="kb-src-title">${t}</span>`}<code class="kb-src-file">${escapeHtml(c.filename)}</code>${c.snippet ? `<p class="kb-src-snip">${escapeHtml(c.snippet)}</p>` : ''}</div></li>`;
      }).join('')}</ol></div>`;
    }
    const secs = (a.latencyMs.total / 1000).toFixed(1);
    html += `<div class="kb-actions"><button type="button" class="kb-fb" data-r="up" aria-pressed="false" aria-label="Helpful">${ICON.up}</button><button type="button" class="kb-fb" data-r="down" aria-pressed="false" aria-label="Not helpful">${ICON.down}</button><span class="kb-meta">${secs}s · ${a.citations.length} source${a.citations.length === 1 ? '' : 's'}</span></div>`;
    msg.innerHTML = html;
    msg.querySelectorAll('.kb-fb').forEach((b) => b.addEventListener('click', () => {
      msg.querySelectorAll('.kb-fb').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.bot.feedback(a, b.dataset.r);
    }));
  }

  onCite(e) {
    const a = e.target.closest?.('.kb-cite[href]');
    if (!a) return;
    e.preventDefault();
    const li = this.el.querySelector(a.getAttribute('href'));
    if (!li) return;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.classList.remove('kb-flash');
    void li.offsetWidth;
    li.classList.add('kb-flash');
    li.focus({ preventScroll: true });
  }
}

/* ---------- public mounts ---------- */

function root(kind, extra = '') {
  return h('div', { class: `kb-root kb-mode-${kind} ${extra}`.trim() });
}

function resolveEl(el) {
  const t = typeof el === 'string' ? document.querySelector(el) : el;
  if (!t) throw new Error(`KnowBot: mount target not found: ${el}`);
  return t;
}

function controller(view, r, extra = {}) {
  return { bot: view.bot, el: r, view, ask: (q) => view.ask(q), destroy: () => { r.remove(); view.bot.telemetry.close(); }, ...extra };
}

/** Floating launcher bubble + panel. Surface kind 'widget'. */
export function mountWidget(o = {}) {
  ensureCss(o.css);
  const r = root('widget', o.position === 'left' ? 'kb-left' : '');
  const view = new ChatView(r, 'widget', o);
  const launch = h('button', { type: 'button', class: 'kb-launcher', 'aria-expanded': 'false', 'aria-controls': view.el.id,
    'aria-label': `Open ${o.title || view.bot.persona.name} chat` }, ICON.chat + ICON.close);
  const close = h('button', { type: 'button', class: 'kb-close', 'aria-label': 'Close chat' }, ICON.close);
  view.head.appendChild(close);
  view.el.hidden = true;
  r.insertBefore(launch, view.el);
  const setOpen = (open, focusBack = true) => {
    view.el.hidden = !open;
    r.classList.toggle('kb-open', open);
    launch.setAttribute('aria-expanded', String(open));
    launch.setAttribute('aria-label', `${open ? 'Close' : 'Open'} ${o.title || view.bot.persona.name} chat`);
    if (open) { view.bot.start(); view.focus(); view.scroll(); } else if (focusBack) launch.focus();
  };
  launch.addEventListener('click', () => setOpen(view.el.hidden));
  close.addEventListener('click', () => setOpen(false));
  r.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !view.el.hidden) { e.stopPropagation(); setOpen(false); } });
  resolveEl(o.container || document.body).appendChild(r);
  if (o.open) setOpen(true, false);
  return controller(view, r, { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(view.el.hidden) });
}

/** Embedded panel inside a host element. Surface kind 'inline'. */
export function mountInline(el, o = {}) {
  ensureCss(o.css);
  const r = root('inline');
  const view = new ChatView(r, 'inline', o);
  resolveEl(el).appendChild(r);
  view.bot.start();
  return controller(view, r);
}

/** Full-page chat filling the host element (or body). Surface kind 'fullpage'. */
export function mountFullpage(el, o = {}) {
  ensureCss(o.css);
  const r = root('fullpage');
  const view = new ChatView(r, 'fullpage', o);
  resolveEl(el || document.body).appendChild(r);
  view.bot.start();
  if (o.autofocus !== false) view.focus();
  return controller(view, r);
}

export function mount(mode = 'widget', el, o = {}) {
  return mode === 'inline' ? mountInline(el, o) : mode === 'fullpage' ? mountFullpage(el, o) : mountWidget({ container: el || undefined, ...o });
}

export { KnowBot };
