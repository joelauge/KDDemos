// KnowBot Studio: "See it as" — the bot pane shows the bot in the shape it will have once launched.
// A selector above the pane (Web chat · SMS · WhatsApp · Email · Phone · Web voice) swaps the frame; every shape asks the
// same bot from the same files:
//   webchat  → the Studio's own chat thread (this module renders nothing; the host shows the thread)
//   sms / whatsapp / email → POST <api>/v1/bots/:id/preview {channel, question}: the reply exactly as that channel's
//              webhook would send it (same pipeline, same formatter), logged to insights under that channel
//   phone    → the in-browser phone (./phonesim.js) on the live voice socket, phone mode
//   voice    → the web voice assistant widget (../lib/voice-widget.js)
//   site     → the homepage overlay (../site/, site/overlay.js) in a frame: the search box hovering over the imported
//              site's homepage (when it can be framed) or a neutral stand-in page; its × shows the homepage and the
//              "Ask <name>" button. Built from the files (GET …/trials/:id/site), with the owner's trial key in the
//              frame's URL fragment so the preview works before it is published
//
//   const s = mountShapes(selectorHost, frameHost, { getState, base, surfaces, starters: () => [...], onChange(shape) })
//   s.set('sms'); s.shape; s.destroy()

export const SHAPES = [
  { id: 'webchat', label: 'Web chat', short: 'Chat', surface: 'webchat' },
  { id: 'sms', label: 'SMS', short: 'SMS', surface: 'sms' },
  { id: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp', surface: 'whatsapp' },
  { id: 'email', label: 'Email', short: 'Email', surface: 'email' },
  { id: 'phone', label: 'Phone', short: 'Phone', surface: 'phone' },
  { id: 'voice', label: 'Web voice', short: 'Voice', surface: 'webvoice' },
  { id: 'site', label: 'Site', short: 'Site', surface: 'site' },
];
const SHAPE_OF_SURFACE = Object.fromEntries(SHAPES.map((s) => [s.surface, s.id]));

const ICON = {
  webchat: '<path d="M4 5h16v11H9l-5 4z"/>',
  sms: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  whatsapp: '<path d="M4.5 19.5l1.2-3.6A8 8 0 1 1 8.6 18.6z"/><path d="M9.5 9.5c.4 2 2 3.6 4 4l1.2-1.2 1.8.8-.3 1.6c-3.6.3-6.9-3-6.6-6.6l1.6-.3.8 1.8z"/>',
  email: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  site: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/><circle cx="11" cy="14" r="2.6"/><path d="m13 16 2.2 2.2"/>',
};
const svg = (id, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[id]}</svg>`;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const initials = (s) => String(s || 'KB').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'KB';
const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const LINK = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])/g;
/** Plain text with links made clickable (and WhatsApp *bold* when asked). Never innerHTML of untrusted text. */
function richText(text, { bold = false } = {}) {
  const frag = document.createDocumentFragment();
  for (const line of String(text || '').split('\n')) {
    if (frag.childNodes.length) frag.append(document.createElement('br'));
    let last = 0;
    const parts = [];
    for (const m of line.matchAll(LINK)) { parts.push([line.slice(last, m.index), false]); parts.push([m[0], true]); last = m.index + m[0].length; }
    parts.push([line.slice(last), false]);
    for (const [t, isLink] of parts) {
      if (!t) continue;
      if (isLink) { frag.append(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t)); continue; }
      if (bold) {
        const bits = t.split(/(\*[^*\n]+\*)/);
        for (const b of bits) { if (/^\*[^*]+\*$/.test(b)) frag.append(h('b', null, b.slice(1, -1))); else if (b) frag.append(b); }
      } else frag.append(t);
    }
  }
  return frag;
}

export function mountShapes(selectorHost, frameHost, o = {}) {
  const getState = o.getState || (() => ({}));
  const base = String(o.base || location.origin).replace(/\/+$/, '');
  const botName = () => getState().spec?.name || 'Your bot';
  const chosen = () => new Set((getState().spec?.surfaces || []).map((x) => SHAPE_OF_SURFACE[x]).filter(Boolean));
  const st = { shape: 'webchat', dev: null, devP: null, live: null, destroyed: false };

  // ---------------------------------------------------------------- the selector
  const group = h('div', { class: 'sh-sel', role: 'radiogroup', 'aria-label': 'See your bot as' });
  const label = h('span', { class: 'sh-sel-label', 'aria-hidden': 'true' }, 'See it as');
  const btns = new Map();
  for (const s of SHAPES) {
    const b = h('button', { type: 'button', class: 'sh-opt', role: 'radio', 'aria-checked': 'false', 'data-shape': s.id, title: s.label, tabindex: '-1',
      onclick: () => set(s.id, { user: true }) },
    h('span', { class: 'sh-ico', html: svg(s.id) }), h('span', { class: 'sh-txt' }, s.label), h('span', { class: 'sh-mine', 'aria-hidden': 'true' }));
    btns.set(s.id, b); group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const ids = SHAPES.map((s) => s.id);
    const i = ids.indexOf(st.shape);
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') n = ids[0]; else if (e.key === 'End') n = ids[ids.length - 1];
    if (n) { e.preventDefault(); set(n, { user: true }); btns.get(n).focus(); }
  });
  const wrap = h('div', { class: 'sh-bar' }, label, group);
  selectorHost.append(wrap);

  function paintSelector() {
    const mine = chosen();
    for (const [id, b] of btns) {
      const on = id === st.shape;
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-mine', mine.has(id));
      b.title = mine.has(id) ? `${SHAPES.find((s) => s.id === id).label} · one of your answer surfaces` : SHAPES.find((s) => s.id === id).label;
    }
  }

  // ---------------------------------------------------------------- dev key (trial key, bot id, voice socket)
  function loadDev() {
    if (st.dev) return Promise.resolve(st.dev);
    if (st.devP) return st.devP;
    const t = getState().trial || {};
    st.devP = fetch(`${base}/api/studio/trials/${encodeURIComponent(t.id || '')}/devkey`, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {}, credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => { st.devP = null; if (j && j.key) st.dev = j; return st.dev; });
    return st.devP;
  }
  const apiRoot = (d) => { const m = /^(https?:\/\/.+?)\/v1\/bots\//.exec(String(d?.endpoints?.chat || '')); return m ? m[1] : `${base}/api`; };

  // ---------------------------------------------------------------- frames
  function clearFrame() {
    try { st.live?.stop?.(); } catch { /* ignore */ }
    st.live = null;
    frameHost.textContent = '';
  }
  function set(shape, { user = false } = {}) {
    if (!SHAPES.some((s) => s.id === shape) || st.destroyed) return;
    if (shape === st.shape && frameHost.childNodes.length) { paintSelector(); return; }
    st.shape = shape;
    paintSelector();
    clearFrame();
    frameHost.hidden = shape === 'webchat';
    if (shape !== 'webchat') frameHost.append(buildFrame(shape));
    o.onChange?.(shape, { user });
  }
  function buildFrame(shape) {
    if (shape === 'sms' || shape === 'whatsapp') return messagingFrame(shape);
    if (shape === 'email') return emailFrame();
    if (shape === 'phone') return phoneFrame();
    if (shape === 'site') return siteFrame();
    return voiceFrame();
  }

  const starters = () => (typeof o.starters === 'function' ? o.starters() : []).filter(Boolean).slice(0, 3);
  function startersRow(onPick) {
    const qs = starters();
    if (!qs.length) return null;
    return h('div', { class: 'sh-starters', 'aria-label': 'Try asking' }, qs.map((q) => h('button', { type: 'button', class: 'chipbtn sh-starter', onclick: () => onPick(q) }, q)));
  }
  async function preview(channel, question) {
    const d = await loadDev();
    if (!d) throw new Error('Your bot is still getting ready. Try again in a moment.');
    const res = await fetch(`${apiRoot(d)}/v1/bots/${encodeURIComponent(d.botId)}/preview`, {
      method: 'POST', headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ channel, question }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 429 ? 'Too many questions at once. Wait a few seconds and try again.' : (j?.error?.message || "Couldn't answer right now. Try again."));
    return j;
  }

  // SMS and WhatsApp: a phone's messaging screen
  function messagingFrame(kind) {
    const wa = kind === 'whatsapp';
    const name = botName();
    const thread = h('div', { class: 'sh-thread', role: 'log', 'aria-live': 'polite', 'aria-label': `${wa ? 'WhatsApp' : 'Text message'} conversation with ${name}` });
    const input = h('input', { class: 'sh-msg-in', type: 'text', placeholder: wa ? 'Message' : 'Text message', 'aria-label': wa ? 'WhatsApp message' : 'Text message', maxlength: '500', autocomplete: 'off' });
    const send = h('button', { type: 'submit', class: 'sh-msg-send', 'aria-label': 'Send', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5l2.4 7L15 12l-9.6 1.5z"/></svg>' });
    const form = h('form', { class: 'sh-msg-bar' }, input, send);
    const head = h('div', { class: 'sh-msg-head' },
      h('span', { class: 'sh-msg-av', 'aria-hidden': 'true' }, initials(name)),
      h('div', { class: 'sh-msg-who' }, h('b', null, name), h('small', null, wa ? 'Business account · answers from your files' : 'Your KnowBot number')));
    const empty = h('p', { class: 'sh-msg-empty' }, wa ? 'Send a WhatsApp message to your bot. It replies with numbered sources, the way it will on WhatsApp.' : 'Text your bot a question. The reply is the real text message: up to 320 characters, with [1] markers and a proof link.');
    thread.append(empty);
    const bubble = (who, text) => {
      const b = h('div', { class: `sh-bub sh-bub-${who}` }, h('div', { class: 'sh-bub-t' }, richText(text, { bold: wa && who === 'bot' })), h('span', { class: 'sh-bub-time' }, timeNow(), who === 'me' && wa ? h('span', { class: 'sh-ticks', 'aria-label': 'delivered' }, '✓✓') : null));
      empty.remove(); thread.append(b); thread.scrollTop = thread.scrollHeight;
      return b;
    };
    async function ask(q) {
      q = String(q || '').trim();
      if (!q) return;
      input.value = '';
      bubble('me', q);
      const typing = h('div', { class: 'sh-bub sh-bub-bot sh-typing', 'aria-label': `${name} is typing` }, h('i'), h('i'), h('i'));
      thread.append(typing); thread.scrollTop = thread.scrollHeight;
      try {
        const r = await preview(kind, q);
        typing.remove();
        const b = bubble('bot', r.text);
        if (!wa) b.append(h('span', { class: 'sh-meta' }, `${r.text.length} characters${r.text.length > 160 ? ` · ${Math.ceil(r.text.length / 153)} texts` : ' · 1 text'}`));
      } catch (e) { typing.remove(); bubble('sys', e.message); }
      input.focus();
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
    return h('div', { class: `sh-frame sh-device sh-${kind}` },
      h('div', { class: 'sh-screen' }, head, thread, startersRow(ask), form),
      h('p', { class: 'sh-note' }, wa ? 'Exactly what your bot sends on WhatsApp. Every question is logged to your question insights.' : 'Exactly what your bot texts back. Every question is logged to your question insights.'));
  }

  // Email: compose, then the reply in an inbox
  function emailFrame() {
    const name = botName();
    const subject = h('input', { class: 'input sh-em-subj', type: 'text', placeholder: 'Subject (optional)', 'aria-label': 'Subject', maxlength: '120' });
    const body = h('textarea', { class: 'input sh-em-body', rows: '3', placeholder: 'Write your question…', 'aria-label': 'Your email', maxlength: '1000' });
    const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
    const status = h('p', { class: 'sh-em-status', role: 'status' });
    const form = h('form', { class: 'sh-em-compose' },
      h('div', { class: 'sh-em-row' }, h('span', { class: 'sh-em-k' }, 'To'), h('span', { class: 'sh-em-to' }, `${name} <support@yourdomain.com>`)),
      h('div', { class: 'sh-em-row' }, h('span', { class: 'sh-em-k' }, 'Subject'), subject),
      body, h('div', { class: 'sh-em-actions' }, status, sendBtn));
    const inbox = h('div', { class: 'sh-em-inbox', 'aria-live': 'polite' });
    async function ask(q) {
      q = String(q || '').trim();
      if (!q) { body.focus(); return; }
      sendBtn.disabled = true; status.textContent = 'Sending…';
      const mine = h('article', { class: 'sh-em-msg is-mine' }, h('header', null, h('b', null, 'You'), h('span', null, timeNow())), h('h4', null, subject.value.trim() || '(no subject)'), h('p', null, q));
      inbox.prepend(mine);
      try {
        const r = await preview('email', q);
        const frame = h('iframe', { class: 'sh-em-html', title: `Reply from ${name}`, sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:4px 2px;background:#fff}a{color:#4f46e5}</style>${r.html || ''}`;
        frame.addEventListener('load', () => { try { frame.style.height = `${Math.min(900, frame.contentDocument.body.scrollHeight + 12)}px`; } catch { /* ignore */ } });
        const reply = h('article', { class: 'sh-em-msg is-bot' },
          h('header', null, h('span', { class: 'sh-msg-av', 'aria-hidden': 'true' }, initials(name)), h('b', null, name), h('span', null, timeNow())),
          h('h4', null, subject.value.trim() ? `Re: ${subject.value.trim()}` : r.subject), frame);
        inbox.prepend(reply);
        status.textContent = 'Reply received.';
        body.value = ''; subject.value = '';
      } catch (e) { status.textContent = e.message; }
      sendBtn.disabled = false;
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(body.value); });
    return h('div', { class: 'sh-frame sh-email' }, h('div', { class: 'sh-em-app' }, form, startersRow((q) => { body.value = q; ask(q); }), inbox),
      h('p', { class: 'sh-note' }, 'The reply is the real email your bot sends: footnoted sources and the quoted lines. Every question is logged to your question insights.'));
  }

  // Phone: the in-browser phone on the live voice socket
  function phoneFrame() {
    const host = h('div', { class: 'sh-frame sh-phone' });
    const note = h('p', { class: 'sh-note', role: 'status' }, 'Getting the line ready…');
    host.append(note);
    let sim = null, stopped = false;
    st.live = { stop() { stopped = true; try { sim?.stop(); } catch { /* ignore */ } } };
    Promise.all([loadDev(), import('./phonesim.js?v=ab7c464')]).then(([d, m]) => {
      if (stopped) return;
      if (!d) { note.textContent = 'Your bot is still getting ready. Try again in a moment.'; return; }
      note.textContent = 'Call it the way your customers will. Allow the microphone when asked, or tap Type during the call.';
      const ws = d.channels?.webVoice?.socket || `${apiRoot(d).replace(/^http/, 'ws')}/v1/bots/${encodeURIComponent(d.botId)}/voice/live`;
      sim = m.mountPhone(host, { endpoint: ws, key: d.key, botName: botName(), starters: starters() });
      host.append(note);
    }).catch(() => { note.textContent = "The phone couldn't load here."; });
    return host;
  }

  // Web voice: the voice assistant widget
  function voiceFrame() {
    const host = h('div', { class: 'sh-frame sh-voice' });
    const mount = h('div', { class: 'sh-voice-mount' });
    const note = h('p', { class: 'sh-note', role: 'status' }, 'Loading the voice assistant…');
    host.append(mount, note);
    let widget = null, stopped = false;
    st.live = { stop() { stopped = true; try { widget?.destroy?.(); } catch { /* ignore */ } } };
    Promise.all([loadDev(), import('../lib/voice-widget.js?v=ab7c464')]).then(([d, m]) => {
      if (stopped) return;
      if (!d) { note.textContent = 'Your bot is still getting ready. Try again in a moment.'; return; }
      const ws = d.channels?.webVoice?.socket || `${apiRoot(d).replace(/^http/, 'ws')}/v1/bots/${encodeURIComponent(d.botId)}/voice/live`;
      widget = m.mountVoice(mount, { endpoint: ws, bot: d.botId, key: d.key, name: botName() });
      note.textContent = 'This is the voice button visitors get on your website: they talk, it answers out loud and shows its sources.';
    }).catch(() => { note.textContent = "The voice assistant couldn't load here."; });
    return host;
  }

  // Site: the overlay over the homepage, in a frame (the same page visitors get at the hosted link)
  function siteFrame() {
    const host = h('div', { class: 'sh-frame sh-site' });
    const note = h('p', { class: 'sh-note', role: 'status' }, 'Building your page from your files…');
    host.append(note);
    let stopped = false;
    st.live = { stop() { stopped = true; } };
    const t = getState().trial || {};
    Promise.all([loadDev(), fetch(`${base}/api/studio/trials/${encodeURIComponent(t.id || '')}/site`, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {}, credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)]).then(([d, s]) => {
      if (stopped) return;
      if (!d || !s) { note.textContent = 'Your page is still getting ready. Try again in a moment.'; return; }
      const page = new URL('../site/', location.href);
      page.searchParams.set('bot', d.botId);
      if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(new URL(base).origin)) page.searchParams.set('api', new URL(base).origin);
      page.hash = `k=${encodeURIComponent(d.key)}`;
      const frame = h('iframe', { class: 'sh-site-frame', title: `${s.site?.name || botName()} · search over your homepage`, src: page.href, loading: 'lazy',
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms', referrerpolicy: 'no-referrer' });
      host.prepend(h('div', { class: 'sh-site-bar', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('span', null, s.site?.homeUrl ? s.site.homeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'your homepage')), frame);
      note.textContent = s.site?.homeFrame
        ? 'This is how it looks on your homepage. Press × to see your site; the button in the corner opens it again. Add it with one line from Set up.'
        : 'This is how it looks over your homepage (shown here as a plain stand-in page). Press × to close it; the button in the corner opens it again. Add it with one line from Set up.';
    });
    return host;
  }

  // the first shape: the visitor's first chosen surface
  const first = SHAPES.find((s) => chosen().has(s.id))?.id || 'webchat';
  paintSelector();
  set(first);

  return {
    get shape() { return st.shape; },
    set,
    refresh: paintSelector,
    destroy() { st.destroyed = true; clearFrame(); wrap.remove(); },
  };
}
