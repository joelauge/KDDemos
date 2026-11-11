/* KnowBot homepage overlay: a simple search box that hovers over a business's own homepage. Visitors ask a question
 * and get an answer quoted from the business's own pages, with its sources; the × closes it and shows the site
 * underneath, and a small "Ask <name>" button in the corner opens it again.
 *
 *   on a homepage:  <script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="<botId>" async></script>
 *                   optional data-api="<KnowBot API origin>" (else found from this script's own address),
 *                   data-theme="light|dark" (else the visitor's system setting)
 *   hosted link:    https://knowbot.knowdrive.ai/site/?bot=<botId>[&q=<question>]  (site/index.html, data-hosted):
 *                   the overlay over the business's homepage in a frame when its headers allow it, else a neutral page
 *
 * It reads the published site (GET <api>/api/site/:bot: name, brand colour, options, source links and a short-lived
 * key that can only ask questions) and asks through the developer API (POST <api>/api/v1/bots/:bot/chat, streamed).
 * Everything lives in one Shadow DOM: the page's CSS can't reach it and its CSS can't reach the page. No framework,
 * no globals. Owner options (KnowBot Studio): showOn 'until-dismissed' (opens on each visit until
 * the visitor closes it with ×; then only the "Ask" pill, in that browser) | 'every-visit', an uploaded logo (shown under the
 * wave in place of the name),
 * showChips (topic buttons under the box, default off). The Studio's preview passes the owner's trial key as #k=…
 * (hosted link only), which also opens a site that is not published yet.
 * Voice mode: the mic button in the search box opens ../lib/voice-mode.js (loaded from this script's own origin only when
 * pressed) in place of the search: an orb in the owner's colour (site.orb) that follows the visitor's voice and the
 * answer's, with captions, a transcript and the sources. It asks through the bot's voice session with the same key. */
(() => {
  'use strict';
  const me = document.currentScript;
  if (!me || document.querySelector('knowbot-overlay')) return;
  const SRC = (() => { try { return me.src ? new URL(me.src, location.href).href : null; } catch { return null; } })();
  const d = me.dataset || {};
  const HOSTED = d.hosted != null;
  const params = new URLSearchParams(HOSTED ? location.search : '');
  const BOT = String(d.bot || params.get('bot') || '').trim().toLowerCase();
  // Where each public host finds its KnowBot API: keep in step with lib/site-config.js HOSTED_APIS.
  const HOSTED_APIS = { 'knowbot.knowdrive.ai': 'https://knowbot-api.joelauge.workers.dev' };
  const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
  const API = (() => {
    const ok = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
    if (d.api && ok(d.api)) return ok(d.api);
    // ?api= only for a loopback dev server (a crafted link must never repoint a real site's answers)
    if (HOSTED && params.get('api')) { const a = ok(params.get('api')); if (a && LOOPBACK.test(new URL(a).hostname)) return a; }
    let src = null; try { src = new URL(me.src, location.href); } catch { /* inline */ }
    return (src && HOSTED_APIS[src.hostname]) || (src && src.origin) || location.origin;
  })();
  let ownerKey = null;
  if (HOSTED && /^#k=kb_trial_/.test(location.hash)) {
    ownerKey = decodeURIComponent(location.hash.slice(3));
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep going */ }
  }
  const framed = (() => { try { return window.top !== window; } catch { return true; } })();
  const CLOSED_KEY = `knowbot-overlay-closed:${BOT}`;
  const NOT_IN_DATA = "The answer to that doesn't seem to be in my files.";
  const store = (kind) => { try { return window[kind]; } catch { return null; } };
  const sGet = (kind, k) => { try { return store(kind)?.getItem(k) ?? null; } catch { return null; } };
  const sSet = (kind, k, v) => { try { store(kind)?.setItem(k, v); } catch { /* private mode */ } };
  const visitor = (() => { let v = sGet('localStorage', 'knowbot-visitor'); if (!v) { v = Math.random().toString(36).slice(2, 12); sSet('localStorage', 'knowbot-visitor', v); } return v; })();
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // ------------------------------------------------------------------------------------------------ helpers
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
  const svg = (paths, size = 20) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.innerHTML = paths; return s; };
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);
  /** "Refund policy · https://shop.example/policies/refund-policy" → "Refund policy" (the link is in Sources). */
  const noUrl = (s) => String(s || '').replace(/\s*[·|–-]\s*https?:\/\/[^\s”"]+/g, '').trim();
  const cleanTitle = (f) => String(f || 'Source').split('/').pop().replace(/\.[a-z0-9]{1,6}$/i, '').replace(/^.* · /, '').replace(/[-_]+/g, ' ').trim();

  // ------------------------------------------------------------------------------------------------ styles
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.kb {
  --bg: #ffffff; --ink: #15151f; --text: #33333f; --muted: #5f6170; --line: #dadce3; --soft: #f4f4f7; --scrim: rgb(246 246 250 / .62);
  --shadow: 0 1px 6px rgb(32 33 36 / .2); --acc: var(--kb-accent, #4f46e5); --on-acc: #ffffff; --link: var(--kb-accent, #4f46e5);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--text);
  -webkit-text-size-adjust: 100%; text-align: left; letter-spacing: normal; color-scheme: light;
}
.kb.dark {
  --bg: #15151f; --ink: #f4f4f8; --text: #d4d4de; --muted: #a8aabb; --line: #3a3a4c; --soft: #22222e; --scrim: rgb(10 10 16 / .62);
  --shadow: 0 1px 8px rgb(0 0 0 / .5); --acc: var(--kb-accent-dark, #a5b4fc); --on-acc: #15151f; --link: var(--kb-accent-dark, #a5b4fc); color-scheme: dark;
}
a { color: var(--link); text-underline-offset: 2px; }
:focus-visible { outline: 3px solid var(--acc); outline-offset: 2px; }
.sr { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
button { font: inherit; color: inherit; }

/* the overlay: a soft see-through scrim over the page and one centered panel */
.scrim { position: fixed; inset: 0; z-index: 2147483000; background: var(--scrim); -webkit-backdrop-filter: blur(10px) saturate(.9); backdrop-filter: blur(10px) saturate(.9); }
.dialog { position: fixed; inset: 0; z-index: 2147483001; overflow-y: auto; overscroll-behavior: contain; display: flex; padding: 12px; }
.panel {
  position: relative; margin: auto; width: 100%; max-width: 760px; min-height: min(640px, calc(100dvh - 24px));
  display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 24px;
  box-shadow: 0 24px 64px rgb(20 20 40 / .18); padding: 64px 16px 8px;
}
.kb.dark .panel { box-shadow: 0 24px 64px rgb(0 0 0 / .5); }
.x {
  position: absolute; top: 10px; right: 10px; width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 999px;
  background: transparent; color: var(--muted); cursor: pointer;
}
.x:hover { background: var(--soft); color: var(--ink); }
.preview { position: absolute; top: 18px; left: 18px; margin: 0; padding: 2px 10px; border-radius: 999px; background: #fff4d6; color: #6b4600; font-size: 13px; font-weight: 600; }
.kb.dark .preview { background: #3b2f12; color: #ffd98a; }
.col { flex: 1; width: 100%; max-width: 600px; margin: 0 auto; text-align: center; }

/* KnowBot's own wave: a real wrist wave pivoting low on the palm, twice on arrival, gentle on hover */
.wave { line-height: 1; margin: 0 0 8px; }
.hand {
  display: inline-block; font-size: clamp(60px, 11vh, 88px); line-height: 1; user-select: none; cursor: default;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif;
  transform-origin: 72% 84%; filter: drop-shadow(0 12px 16px rgb(180 120 20 / .18));
}
.hand.waving { animation: kb-wave 1.5s cubic-bezier(.4, 0, .3, 1) .3s 2 both; }
.wave:hover .hand { animation: kb-wave-soft 1.4s ease-in-out infinite; }
@keyframes kb-wave { 0% { transform: rotate(0deg); } 14% { transform: rotate(16deg); } 28% { transform: rotate(-9deg); } 42% { transform: rotate(15deg); } 56% { transform: rotate(-5deg); } 70% { transform: rotate(9deg); } 100% { transform: rotate(0deg); } }
@keyframes kb-wave-soft { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(10deg); } 60% { transform: rotate(-5deg); } }

.name {
  margin: 0 0 28px; color: var(--ink); font-size: clamp(34px, 8vw, 54px); line-height: 1.08; font-weight: 700; letter-spacing: -.03em;
  overflow-wrap: anywhere; display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap;
}
.name.has-logo { margin-bottom: 24px; }
.brandlogo { display: block; max-width: min(300px, 80%); max-height: 120px; width: auto; height: auto; object-fit: contain; }
.kb.dark .brandlogo { padding: 10px 16px; border-radius: 14px; background: #fff; }
.logo { width: 48px; height: 48px; border-radius: 12px; object-fit: contain; background: #fff; flex: none; }

/* one big rounded search box with one button */
.box {
  display: flex; align-items: center; gap: 4px; min-height: 56px; padding: 5px 5px 5px 18px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg); transition: box-shadow .15s ease, border-color .15s ease;
}
.box:hover, .box:focus-within { box-shadow: var(--shadow); border-color: transparent; }
.kb.dark .box:hover, .kb.dark .box:focus-within { border-color: var(--line); }
.box > svg { flex: none; color: var(--muted); }
.q {
  flex: 1; min-width: 0; min-height: 44px; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 18px; padding: 0 6px;
  -webkit-appearance: none; appearance: none;
}
.q::placeholder { color: var(--muted); opacity: 1; }
.q::-webkit-search-cancel-button { display: none; }
.box:has(.q:focus-visible) { outline: 3px solid var(--acc); outline-offset: 2px; }
.go {
  flex: none; min-height: 44px; min-width: 72px; padding: 0 20px; border: 0; border-radius: 999px; background: var(--acc); color: var(--on-acc);
  font-weight: 700; cursor: pointer;
}
.go:hover { filter: brightness(1.08); }
.mic {
  flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 999px; background: transparent; color: var(--muted);
  cursor: pointer;
}
.mic:hover { background: var(--soft); color: var(--ink); }
.voice { flex: 1; width: 100%; max-width: 640px; margin: 0 auto; --kbvm-accent: var(--acc); --kbvm-accent-dark: var(--acc); --kbvm-on-accent: var(--on-acc); --kbvm-on-accent-dark: var(--on-acc); }
.voice-load { margin: 40px 0; text-align: center; color: var(--muted); }
.go:disabled { opacity: .6; cursor: default; }
.quiet { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 18px 0 0; }
.chip { min-height: 44px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--ink); font-size: 15px; cursor: pointer; }
.chip:hover { border-color: var(--acc); }

/* the answer: same simple column, quotes as blocks with numbered marks, then Sources */
.answer { margin: 32px 0 8px; text-align: left; }
.aq { margin: 0 0 12px; color: var(--ink); font-size: 20px; line-height: 1.35; overflow-wrap: anywhere; }
.ab p { margin: 0 0 10px; overflow-wrap: anywhere; }
.from { color: var(--muted); font-size: 15px; margin-bottom: 4px !important; }
.quote { margin: 0 0 14px; padding: 8px 14px; border-left: 3px solid var(--acc); background: var(--soft); border-radius: 0 10px 10px 0; color: var(--ink); overflow-wrap: anywhere; }
.n {
  display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; margin-left: 2px; border-radius: 999px; background: var(--acc);
  color: var(--on-acc) !important; font-size: 13px; font-weight: 700; text-decoration: none; vertical-align: 2px;
}
.refusal { color: var(--ink); }
.hint, .err { color: var(--muted); font-size: 15px; }
.typing { display: flex; align-items: center; min-height: 28px; }
.dots { display: inline-flex; gap: 5px; }
.dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--acc); opacity: .35; animation: kb-dot 1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes kb-dot { 50% { opacity: 1; transform: translateY(-2px); } }
.sources { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
/* product cards (final.products): a calm row of small cards; scrolls sideways when it holds more than fits */
.prods { list-style: none; display: flex; gap: 10px; margin: 4px -2px 0; padding: 2px 2px 6px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: thin; }
.prods > li { flex: 0 0 148px; width: 148px; min-width: 0; margin: 0; padding: 0; scroll-snap-align: start; }
.prod { height: 100%; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--ink); text-decoration: none; overflow: hidden; }
.prod:hover { border-color: var(--acc); }
.prod:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
.prod-media { display: grid; place-items: center; width: 100%; aspect-ratio: 4 / 3; background: var(--soft); color: var(--muted); border-bottom: 1px solid var(--line); }
.prod-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.prod.out .prod-media img { opacity: .72; }
.prod-body { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 10px; min-width: 0; }
.prod-t { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; font-size: 14px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.prod-p { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
.prod-p s { color: var(--muted); }
.prod-chip { align-self: flex-start; margin-top: 2px; padding: 1px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: 12px; }
.h3 { margin: 0 0 6px; color: var(--ink); font-size: 15px; }
.srclist { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.src { display: flex; gap: 10px; align-items: flex-start; padding: 6px; margin: 0 -6px; border-radius: 8px; }
.src.hit { background: var(--soft); }
.src-n { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; border: 1px solid var(--acc); color: var(--ink); font-size: 13px; font-weight: 700; }
.src-body { display: flex; flex-direction: column; min-width: 0; }
.src-link { font-weight: 600; overflow-wrap: anywhere; }
.src-where { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.again {
  display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; padding: 0 16px; border: 1px solid var(--line); border-radius: 999px;
  background: transparent; color: var(--ink); cursor: pointer;
}
.again:hover { background: var(--soft); }
.foot { display: flex; justify-content: flex-end; margin-top: 24px; }
.built { display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; color: var(--muted); font-size: 13px; text-decoration: none; }
.built:hover { text-decoration: underline; }
.empty { margin: 8px auto 0; max-width: 30em; }

/* closed: one small button in the corner opens it again */
.pill {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: inline-flex; align-items: center; gap: 8px; min-height: 48px;
  max-width: calc(100vw - 32px); padding: 0 18px 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--ink);
  font-weight: 600; font-size: 15px; box-shadow: 0 6px 20px rgb(20 20 40 / .16); cursor: pointer;
}
.pill:hover { box-shadow: 0 8px 26px rgb(20 20 40 / .22); }
.pill-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill-h { font-size: 20px; line-height: 1; font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }

@media (min-width: 720px) {
  .dialog { padding: 32px; }
  .panel { padding: 88px 40px 12px; min-height: min(680px, calc(100dvh - 64px)); }
  .answer { margin-top: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .hand.waving, .wave:hover .hand, .dots i { animation: none; }
  .box { transition: none; }
}`;

  // ------------------------------------------------------------------------------------------------ the shell
  const host = document.createElement('knowbot-overlay');
  // nothing on the page can restyle or hide the host; its children are fixed to the viewport
  host.setAttribute('style', 'all: initial !important; display: block !important;');
  const shadow = host.attachShadow({ mode: 'open' });
  const root = h('div', { class: 'kb' });
  const brandStyle = h('style');
  shadow.append(h('style', null, CSS), brandStyle, root);
  const status = h('p', { class: 'sr', role: 'status', 'aria-live': 'polite' });

  const explicitTheme = d.theme || (HOSTED ? params.get('theme') : null);
  const mq = (() => { try { return matchMedia('(prefers-color-scheme: dark)'); } catch { return null; } })();
  const paintTheme = () => root.classList.toggle('dark', explicitTheme ? explicitTheme === 'dark' : !!mq?.matches);
  paintTheme();
  if (!explicitTheme) mq?.addEventListener?.('change', paintTheme);

  let site = null, ui = null, isOpen = false, prevFocus = null, prevOverflow = null, busy = false, turnSeq = 0;
  const hist = []; // the last turns, for follow-ups: [{role, content}]

  async function loadSite() {
    const r = await fetch(`${API}/api/site/${encodeURIComponent(BOT)}`, { headers: ownerKey ? { authorization: `Bearer ${ownerKey}` } : {}, credentials: 'omit' });
    if (!r.ok) { const e = new Error('site'); e.status = r.status; throw e; }
    return r.json();
  }

  function build(s) {
    const c = hex(s.brand?.color), dk = hex(s.brand?.colorDark) || c;
    brandStyle.textContent = c ? `.kb{--kb-accent:${c};--kb-accent-dark:${dk}}` : '';
    const name = String(s.name || 'Our help centre');
    const logo = safeUrl(s.brand?.logo) && /^https:/i.test(s.brand.logo) ? h('img', { class: 'logo', src: s.brand.logo, alt: '', width: '48', height: '48', referrerpolicy: 'no-referrer' }) : null;
    // the owner's uploaded logo replaces the name under the wave (the name stays its text alternative)
    const brandLogo = typeof s.logo?.path === 'string' && /^\/api\/site\/[^/]+\/logo\?v=[a-f0-9]+$/.test(s.logo.path)
      ? h('img', { class: 'brandlogo', src: `${API}${s.logo.path}`, alt: name, referrerpolicy: 'no-referrer', decoding: 'async' }) : null;
    const input = h('input', { id: 'kb-q', class: 'q', type: 'search', name: 'q', autocomplete: 'off', maxlength: '500', placeholder: innerWidth < 480 ? 'Ask anything' : `Ask anything about ${name}`, enterkeyhint: 'search' });
    const go = h('button', { class: 'go', type: 'submit' }, 'Ask');
    // voice mode: only where the script knows its own address (the module is loaded from there when pressed)
    const mic = SRC ? h('button', { class: 'mic', type: 'button', 'aria-label': 'Ask by voice', title: 'Ask by voice', onclick: () => enterVoice() },
      svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 22)) : null;
    const form = h('form', { class: 'form', role: 'search', 'aria-label': `Ask ${name}` },
      h('label', { class: 'sr', for: 'kb-q' }, `Ask anything about ${name}`),
      h('div', { class: 'box' }, svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'), input, mic, go));
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
    const chips = s.showChips && (s.chips || []).length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Topics' },
      s.chips.map((x) => h('button', { type: 'button', class: 'chip', title: x.q, onclick: () => ask(x.q) }, x.label))) : null;
    const hand = h('span', { class: 'hand' }, '👋');
    const answer = h('section', { class: 'answer', 'aria-label': 'Answer', hidden: true });
    const close = h('button', { class: 'x', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => closeIt() }, svg('<path d="M6 6l12 12M18 6 6 18"/>', 22));
    const voiceBox = h('div', { class: 'voice', hidden: true });
    const col = h('div', { class: 'col' },
        h('div', { class: 'wave', 'aria-hidden': 'true' }, hand),
        brandLogo ? h('h1', { id: 'kb-h', class: 'name has-logo' }, brandLogo) : h('h1', { id: 'kb-h', class: 'name' }, logo, h('span', null, name)),
        form,
        h('p', { class: 'quiet' }, typeof s.subline === 'string' && s.subline.trim() ? s.subline.trim().slice(0, 140) : `Answers come only from ${name}'s own pages.`),
        chips, status, answer);
    const panel = h('div', { class: 'panel' },
      s.preview ? h('p', { class: 'preview' }, 'Preview · not published yet') : null,
      close, col, voiceBox,
      h('div', { class: 'foot' }, h('a', { class: 'built', href: 'https://knowbot.knowdrive.ai/', target: '_blank', rel: 'noopener' }, 'Built with KnowBot', h('span', { class: 'sr' }, ' (opens in a new tab)'))));
    const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kb-h', hidden: true }, panel);
    // a click on the scrim around the panel closes it too
    dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) closeIt(); });
    const scrim = h('div', { class: 'scrim', hidden: true, 'aria-hidden': 'true' });
    const pill = h('button', { class: 'pill', type: 'button', hidden: true, 'aria-haspopup': 'dialog', onclick: () => openIt(pill) },
      h('span', { class: 'pill-h', 'aria-hidden': 'true' }, '👋'), h('span', { class: 'pill-t' }, `Ask ${name}`));
    root.replaceChildren(scrim, dialog, pill);
    return { input, go, mic, answer, dialog, scrim, pill, hand, panel, col, voiceBox };
  }

  // ------------------------------------------------------------------------------------------------ open / close
  const focusables = () => [...ui.dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), summary')].filter((el) => el.getClientRects().length);
  function onKey(e) {
    if (!isOpen) return;
    // Esc ends voice mode first (back to the search box), then closes the overlay
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (voice || voiceLoading) exitVoice(); else closeIt(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const active = shadow.activeElement;
    const i = list.indexOf(active);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
  }
  // focus that lands on the page behind (a script, a click through) comes back into the dialog
  function onFocusIn(e) { if (isOpen && e.target !== host) { if (voice) voice.focus(); else ui.input.focus({ preventScroll: true }); } }

  function openIt(from) {
    if (isOpen || !ui) return;
    isOpen = true;
    prevFocus = from || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    ui.scrim.hidden = false; ui.dialog.hidden = false; ui.pill.hidden = true;
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    if (backdrop) backdrop.inert = true;
    ui.hand.classList.remove('waving'); void ui.hand.offsetWidth; if (!reduced()) ui.hand.classList.add('waving');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    ui.input.focus({ preventScroll: true });
  }
  function closeIt() {
    if (!isOpen) return;
    exitVoice({ focus: false });
    isOpen = false;
    ui.scrim.hidden = true; ui.dialog.hidden = true; ui.pill.hidden = false;
    document.documentElement.style.overflow = prevOverflow || '';
    if (backdrop) backdrop.inert = false;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocusIn);
    if (!HOSTED && site?.showOn !== 'every-visit') sSet('localStorage', CLOSED_KEY, '1');
    const back = prevFocus && prevFocus.isConnected && prevFocus !== ui.pill ? prevFocus : ui.pill;
    try { back.focus({ preventScroll: true }); } catch { ui.pill.focus(); }
    status.textContent = '';
  }

  // ------------------------------------------------------------------------------------------------ voice mode
  let voice = null, voiceLoading = false, voiceSeq = 0;
  async function enterVoice() {
    if (voice || voiceLoading || !ui || !SRC) return;
    voiceLoading = true;
    const seq = ++voiceSeq;
    ui.col.hidden = true;
    ui.voiceBox.hidden = false;
    ui.voiceBox.replaceChildren(h('p', { class: 'voice-load', role: 'status' }, 'Starting voice mode…'));
    status.textContent = '';
    try {
      const [{ openVoiceMode }] = await Promise.all([
        import(new URL('../lib/voice-mode.js?v=09e5dd0', SRC).href),
        // a fresh key when this one is about to run out (it lives a few hours)
        !ownerKey && Date.parse(site.keyExpiresAt || '') < Date.now() + 120000 ? loadSite().then((x) => { site = { ...site, ...x }; }).catch(() => {}) : null,
      ]);
      if (seq !== voiceSeq || !isOpen) return;
      const ep = typeof site.endpoints?.voice === 'string' && /^wss?:\/\//.test(site.endpoints.voice) ? site.endpoints.voice : `${API.replace(/^http/, 'ws')}/api/v1/bots/${encodeURIComponent(BOT)}/voice/live`;
      ui.voiceBox.replaceChildren();
      voice = openVoiceMode(ui.voiceBox, {
        endpoint: ep, key: ownerKey || site.key, name: String(site.name || 'Our help centre'), orb: site.orb,
        theme: root.classList.contains('dark') ? 'dark' : 'light', size: 'min(240px, 56vw, 34vh)',
        onTurn: (t) => { if (!t.question || !t.answer) return; hist.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.answer }); while (hist.length > 8) hist.shift(); },
        onClose: () => { voice = null; exitVoice(); },
      });
      voice.focus();
    } catch {
      if (seq !== voiceSeq) return;
      ui.voiceBox.replaceChildren(h('p', { class: 'voice-load', role: 'alert' }, "Voice mode couldn't start here. Press Esc and type your question instead."));
    } finally { if (seq === voiceSeq) voiceLoading = false; }
  }
  function exitVoice({ focus = true } = {}) {
    if (!ui || (ui.voiceBox.hidden && !voice)) return;
    voiceSeq++; voiceLoading = false;
    const v = voice; voice = null;
    ui.voiceBox.hidden = true;
    ui.col.hidden = false;
    if (v) v.stop(); // its onClose comes back here with nothing left to do
    ui.voiceBox.replaceChildren();
    if (focus && isOpen) (ui.mic || ui.input).focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------------------------------------ asking
  async function ask(qRaw) {
    const q = String(qRaw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!q || busy || !site) return;
    busy = true;
    ui.input.value = '';
    const body = h('div', { class: 'ab' }, h('p', { class: 'typing' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'sr' }, 'Searching…')));
    const turn = h('article', { class: 'turn', 'aria-busy': 'true' }, h('h2', { class: 'aq' }, q), body);
    ui.answer.replaceChildren(turn);
    ui.answer.hidden = false;
    status.textContent = `Searching for: ${q}`;
    let final = null;
    try {
      final = await stream(q, (text) => { body.replaceChildren(h('p', null, text.replace(/\s*\[\d{1,3}\]/g, ''))); });
    } catch (e) {
      body.replaceChildren(h('p', { class: 'err' }, e.message || "Couldn't answer right now. Try again in a moment."));
    }
    if (final) {
      renderAnswer(turn, body, final);
      hist.push({ role: 'user', content: q }, { role: 'assistant', content: String(final.answer || '') });
      while (hist.length > 8) hist.shift();
      status.textContent = final.refused || !(final.citations || []).length ? 'No answer found in these pages.' : `Answer ready, with ${final.citations.length} ${final.citations.length === 1 ? 'source' : 'sources'}.`;
    }
    turn.removeAttribute('aria-busy');
    turn.append(h('button', { type: 'button', class: 'again', onclick: () => { ui.answer.replaceChildren(); ui.answer.hidden = true; hist.length = 0; status.textContent = ''; ui.input.focus(); } }, 'Ask another'));
    busy = false;
  }

  async function stream(q, onText, retried = false) {
    const res = await fetch(`${API}/api/v1/bots/${encodeURIComponent(BOT)}/chat`, {
      method: 'POST', credentials: 'omit',
      headers: { authorization: `Bearer ${ownerKey || site.key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question: q, history: hist.slice(-6), stream: true, format: 'bullets', user: visitor }),
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
    if (page) return { href: page, where: hostOf(page) };
    const proof = safeUrl(final.proofUrl);
    return proof ? { href: proof, where: 'Proof page' } : { href: null, where: '' };
  }
  // a [n] mark scrolls to its source inside the overlay (a #fragment would never reach into the Shadow DOM)
  function cite(n, id) {
    return h('a', { class: 'n', href: `#${id}-s${n}`, 'aria-label': `Source ${n}`, onclick: (e) => {
      e.preventDefault();
      const li = shadow.getElementById(`${id}-s${n}`);
      if (!li) return;
      for (const x of shadow.querySelectorAll('.src.hit')) x.classList.remove('hit');
      li.classList.add('hit');
      li.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      li.focus({ preventScroll: true });
    } }, String(n));
  }

  function renderAnswer(turn, a, final) {
    a.textContent = '';
    const id = `kb-t${++turnSeq}`;
    if (final.refused || !(final.citations || []).length) {
      a.append(h('p', { class: 'refusal' }, String(final.answer || NOT_IN_DATA).trim() || NOT_IN_DATA), h('p', { class: 'hint' }, 'Try different words.'));
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
        if (lead) a.append(h('p', { class: 'from' }, `${lead}:`));
        a.append(h('blockquote', { class: 'quote' }, line.slice(start + 1, end).trim(), ' ', nums));
      } else a.append(h('p', null, line, nums.length ? ' ' : '', nums));
    }
    const list = h('ol', { class: 'srclist' });
    for (const c of final.citations) {
      const s = sourceOf(c, final);
      const title = noUrl(c.title || '') || cleanTitle(c.file);
      list.append(h('li', { id: `${id}-s${c.n}`, class: 'src', tabindex: '-1' },
        h('span', { class: 'src-n', 'aria-hidden': 'true' }, String(c.n)),
        h('div', { class: 'src-body' },
          s.href ? h('a', { class: 'src-link', href: s.href, target: '_blank', rel: 'noopener' }, title, h('span', { class: 'sr' }, ' (opens in a new tab)')) : h('b', null, title),
          h('span', { class: 'src-where' }, [s.where, c.page ? `page ${c.page}` : null, c.section || null].filter(Boolean).join(' · ')))));
    }
    const prods = productCards(final.products);
    if (prods) a.append(prods);
    a.append(h('section', { class: 'sources', 'aria-label': 'Sources' }, h('h3', { class: 'h3' }, 'Sources'), list));
  }
  /** The products the answer links (final.products, at most 4): photo, two-line title, price (compare-at struck), "Out of stock" only when it is. */
  const money = (v, cur) => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return '';
    const dp = Math.abs(n - Math.round(n)) < 0.005 ? 0 : 2;
    try { if (cur) return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n); } catch { /* unknown code */ }
    return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: 2 });
  };
  const BAG = '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>';
  const cleanHref = (u) => (safeUrl(u) && !/[\s"'<>`]/.test(u) ? u : null);
  function productCards(list) {
    const items = (Array.isArray(list) ? list : []).slice(0, 12).map((p) => {
      const url = cleanHref(p?.url), title = String(p?.title ?? '').trim();
      if (!url || !title) return null;
      const price = money(p.price, p.currency), was = p.compareAt != null && Number(p.compareAt) > Number(p.price) ? money(p.compareAt, p.currency) : '';
      const av = String(p.availability || '');
      const out = /\b(?:out of stock|sold out|unavailable|discontinued|not available|no longer available)\b/i.test(av) && !/\bonly some\b/i.test(av);
      const src = cleanHref(p.image);
      const media = h('span', { class: 'prod-media' });
      if (src) {
        const img = h('img', { src, alt: title, width: '148', height: '111', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.replaceWith(svg(BAG, 22)), { once: true });
        media.append(img);
      } else media.append(svg(BAG, 22));
      const name = [title, price && (was ? `${price}, was ${was}` : price), out && 'out of stock'].filter(Boolean).join(', ');
      return h('li', null, h('a', { class: `prod${out ? ' out' : ''}`, href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${name} (opens in a new tab)` }, media,
        h('span', { class: 'prod-body' }, h('span', { class: 'prod-t' }, title),
          price ? h('span', { class: 'prod-p' }, h('b', null, price), was ? h('s', null, was) : null) : null,
          out ? h('span', { class: 'prod-chip' }, 'Out of stock') : null)));
    }).filter(Boolean).slice(0, 4);
    return items.length ? h('ul', { class: 'prods', 'aria-label': items.length === 1 ? 'Product' : 'Products' }, items) : null;
  }

  // ------------------------------------------------------------------------------------------------ hosted link
  // site/index.html: the business's homepage in a frame behind the overlay when its headers allow it, else a calm
  // neutral page. Ours to style (light DOM of our own page).
  let backdrop = null;
  function hostedBackdrop(s) {
    document.title = `${s.name} · Ask anything`;
    const desc = document.head.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', `Ask anything about ${s.name}. Answers come only from ${s.name}'s own pages.`);
    const robots = document.head.querySelector('meta[name="robots"]');
    if (robots && !s.noindex) robots.remove();
    const frameUrl = safeUrl(s.homeFrame);
    const home = safeUrl(s.homeUrl);
    if (frameUrl) {
      backdrop = h('iframe', { class: 'kh-home', src: frameUrl, title: `${s.name} homepage`, referrerpolicy: 'no-referrer',
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms' });
    } else {
      backdrop = h('main', { class: 'kh-page' },
        h('header', { class: 'kh-top' }, h('b', null, s.name), home ? h('a', { href: home, rel: 'noopener' }, `Go to ${hostOf(home) || 'the website'}`) : null),
        h('div', { class: 'kh-hero', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('div', { class: 'kh-cards', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    }
    document.body.prepend(backdrop);
  }
  function hostedMessage(title, line) {
    root.replaceChildren(h('div', { class: 'scrim' }), h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kb-h' },
      h('div', { class: 'panel' }, h('div', { class: 'col' }, h('div', { class: 'wave', 'aria-hidden': 'true' }, h('span', { class: 'hand' }, '👋')),
        h('h1', { id: 'kb-h', class: 'name' }, title), h('p', { class: 'empty' }, line)))));
  }

  // ------------------------------------------------------------------------------------------------ start
  async function start() {
    if (!/^[a-z0-9-]{1,40}$|^tr_[a-z2-7]{16}$/.test(BOT)) {
      if (HOSTED) { document.body.append(host); hostedMessage('Nothing to show here yet', 'This link is missing its site. Check the link you were given.'); }
      return;
    }
    try { site = await loadSite(); } catch (e) {
      if (HOSTED) { document.body.append(host); hostedMessage('This page is not available', e.status === 404 ? 'It may not be published yet, or its trial has ended.' : "We couldn't load this page. Try again in a moment."); }
      return; // on a business's homepage: nothing shows, nothing breaks
    }
    if (HOSTED) hostedBackdrop(site);
    ui = build(site);
    document.body.append(host);
    const q = HOSTED ? params.get('q') : null;
    const closedBefore = !HOSTED && site.showOn !== 'every-visit' && sGet('localStorage', CLOSED_KEY) === '1';
    // inside someone else's frame (the hosted link showing this homepage) it waits behind its button
    if (HOSTED || (!closedBefore && !framed)) { openIt(null); if (q) ask(q); }
    else ui.pill.hidden = false;
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
