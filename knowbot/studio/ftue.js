// KnowBot Studio: the first-time guide (FTUE). A slim, dismissible card that walks a first-time visitor through five
// steps. It never blocks work (no modal, no scrim) and it never has a "Next" button: each step advances on the real
// event the Studio already records (store milestones), so the guide only ever describes what just happened.
//
//   1  Add knowledge     sample files / upload / website / a note        → a file exists (milestones.firstFile)
//   2  Reading           "n of m ready", plain words about the wait      → milestones.firstReady
//   3  Ask a question    one suggested question from the bot's starters  → milestones.firstCited
//   4  Try to trip it up an off-topic question (or the full test)        → milestones.firstRefusal or .proofRun
//   5  Done              a short celebration, "Where should it answer?" (the plan's three tools, saved as
//                        spec.surfaces like the landing), then "What's next?" (the website line three ways) + Launch
//
// Placement: in the flow of the bot pane, just above the suggested questions and the composer (desktop), or above
// the composer of whichever pane is showing (phones). State lives in localStorage 'kb-ftue':
//   { status: 'active' | 'dismissed' | 'done', phase: 'tools' | 'next', celebrated, tab }
// A returning visitor who dismissed or finished never sees it again unless they pick ⋯ → "Show the guide".
//
// mountFtue(ctx, hooks) → { show(), dismiss(), active(), step() }. app.js passes the actions as hooks so this module
// never reaches into the Builder's internals. Customer-facing copy never names a vendor.

import { TOOLS, normalizeSurfaces } from './surfaces.js?v=93c5afa';

export const FTUE_KEY = 'kb-ftue';
const STEP_KEYS = ['add', 'reading', 'ask', 'trip', 'done'];
const PROBE_Q = "What's the weather in Paris today?";

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

function readSaved() {
  try {
    const raw = localStorage.getItem(FTUE_KEY);
    if (!raw) return null;
    if (raw === 'dismissed' || raw === 'done') return { status: raw };
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function writeSaved(v) { try { localStorage.setItem(FTUE_KEY, JSON.stringify(v)); } catch { /* storage blocked: the guide still works for this visit */ } }

/** Which step the visitor is on, from the store alone (milestones only ever move forward). */
export function ftueStep(s) {
  const m = s.milestones || {};
  const files = (s.fileOrder || []).map((id) => s.files[id]).filter((f) => f && f.phase !== 'rejected');
  if (!files.length && !m.firstReady) return 'add';
  if (!m.firstReady) return 'reading';
  if (!m.firstCited) return 'ask';
  if (!m.firstRefusal && !m.proofRun) return 'trip';
  return 'done';
}

export function mountFtue(ctx, hooks = {}) {
  const { store, icons, motion, announce } = ctx;
  const { getState, on } = store;
  const icon = (n, s = 16) => icons.icon(n, s);
  const reduced = () => (motion?.reduced ? motion.reduced() : document.documentElement.getAttribute('data-motion') === 'reduce');
  const isMobile = () => matchMedia('(max-width: 899px)').matches;

  let saved = readSaved();
  // A brand-new visitor (no bot saved on this device, no return link) starts the guide. Anyone else only sees it when
  // it was left in progress, or when they ask for it (⋯ → Show the guide).
  if (!saved && hooks.fresh) { saved = { status: 'active' }; writeSaved(saved); }
  const save = (patch) => { saved = { ...(saved || {}), ...patch }; writeSaved(saved); };

  const card = h('section', { id: 'st-ftue', class: 'st-ftue', role: 'region', 'aria-labelledby': 'st-ftue-h', hidden: true, tabindex: '-1' });
  const live = h('p', { class: 'st-sr', 'aria-live': 'polite', id: 'st-ftue-live' });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); dismiss({ via: 'escape' }); }
  });

  let shownStep = null, shownPhase = null, raf = 0, snippetP = null, snippetFor = '';

  const active = () => saved?.status === 'active';
  const visible = () => active() && !document.documentElement.hasAttribute('data-landing');

  // ------------------------------------------------------------------ placement
  function place() {
    const tab = getState().ui?.tab;
    let parent, before;
    if (isMobile() && tab === 'setup') { parent = document.getElementById('st-setup'); before = parent?.querySelector('.st-composer-wrap'); }
    else { parent = document.getElementById('st-bot'); before = document.getElementById('sb-suggest-slot'); }
    if (!parent) return;
    if (card.parentElement !== parent || card.nextElementSibling !== (before || null)) {
      const hadFocus = card.contains(document.activeElement);
      if (before && before.parentElement === parent) parent.insertBefore(card, before); else parent.append(card);
      if (hadFocus) card.focus({ preventScroll: true });
    }
    if (!live.isConnected) document.body.append(live);
  }

  // ------------------------------------------------------------------ rendering
  function frame(stepKey, { title, body, actions = null, extra = null }) {
    const n = STEP_KEYS.indexOf(stepKey) + 1;
    const dots = h('ol', { class: 'st-ftue-dots', 'aria-hidden': 'true' }, STEP_KEYS.map((k, i) => h('li', { dataset: { state: i + 1 < n ? 'done' : i + 1 === n ? 'now' : 'todo' } })));
    const head = h('div', { class: 'st-ftue-top' },
      h('p', { class: 'st-ftue-eyebrow' }, `Step ${n} of 5`), dots,
      h('button', { type: 'button', class: 'st-ftue-x', 'aria-label': 'Hide the guide', title: 'Hide the guide', html: icon('x', 16), onclick: () => dismiss({ via: 'x' }) }));
    const main = h('div', { class: 'st-ftue-main' },
      h('h2', { class: 'st-ftue-h', id: 'st-ftue-h', tabindex: '-1' }, title),
      body ? h('p', { class: 'st-ftue-p' }, body) : null,
      extra, actions);
    return [head, main];
  }

  function btn(label, fn, { primary = false, cls = '', ico = null, attrs = {} } = {}) {
    return h('button', { type: 'button', class: `${primary ? 'btn btn-primary st-ftue-go' : 'st-ftue-link'}${cls ? ` ${cls}` : ''}`, onclick: fn, ...attrs },
      ico ? h('span', { class: 'st-ftue-ico', 'aria-hidden': 'true', html: icon(ico, 15) }) : null, h('span', null, label));
  }

  function readingCounts() {
    const s = getState();
    const files = s.fileOrder.map((id) => s.files[id]).filter((f) => f && f.phase !== 'rejected');
    return { ready: files.filter((f) => f.phase === 'ready').length, total: files.length };
  }

  function suggestedQuestion() {
    const chip = document.querySelector('#sb-suggest-slot .sb-chip:not(.sb-chip-probe)');
    const fromChip = chip && chip.textContent.trim();
    if (fromChip) return fromChip;
    const st = (getState().spec?.starters || []).find((q) => q && String(q).trim());
    return st || (hooks.starters ? hooks.starters()[0] : '') || '';
  }

  function render(force = false) {
    raf = 0;
    if (!visible()) { if (!card.hidden) card.hidden = true; document.documentElement.toggleAttribute('data-ftue', false); return; }
    place();
    const step = ftueStep(getState());
    const phase = step === 'done' ? (saved.phase || 'tools') : '';
    if (card.hidden) card.hidden = false;
    document.documentElement.toggleAttribute('data-ftue', true);
    card.dataset.step = step;
    if (step === 'reading' && shownStep === 'reading' && !force) { paintReading(); return; }
    if (step === 'ask' && shownStep === 'ask' && !force) { paintAsk(); return; }
    if (!force && step === shownStep && phase === shownPhase) return;
    const moved = shownStep && shownStep !== step;
    const hadFocus = card.contains(document.activeElement);
    shownStep = step; shownPhase = phase;
    const parts = build(step, phase);
    card.replaceChildren(...parts);
    if (moved || force) {
      const n = STEP_KEYS.indexOf(step) + 1;
      const title = card.querySelector('.st-ftue-h')?.textContent || '';
      live.textContent = '';
      setTimeout(() => { live.textContent = `Guide, step ${n} of 5: ${title}`; }, 40);
      if (!reduced()) motion?.animate?.(card, [{ opacity: 0.4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'out' });
      // the step changed because of something the visitor did inside the guide: keep the keyboard with the guide
      if (hadFocus && card.isConnected && document.activeElement !== document.getElementById('sb-input')) card.querySelector('.st-ftue-h')?.focus({ preventScroll: true });
    }
    if (step === 'done' && !saved.celebrated) { save({ celebrated: true }); celebrate(); }
    if (step === 'done' && phase === 'next') pulseStats();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => render(false)); };

  function build(step, phase) {
    if (step === 'add') {
      return frame('add', {
        title: 'Add what your bot should know',
        body: 'Your bot answers only from what you give it. Start with ours, or bring your own.',
        actions: h('div', { class: 'st-ftue-acts' },
          btn('Try sample files', () => hooks.addSamples?.(), { primary: true }),
          h('span', { class: 'st-ftue-or' },
            btn('Upload files', () => hooks.upload?.(), { cls: 'is-inline' }), h('span', { 'aria-hidden': 'true' }, ' · '),
            btn('Add your website', () => hooks.website?.(), { cls: 'is-inline' }), h('span', { 'aria-hidden': 'true' }, ' · '),
            btn('Write a note', () => hooks.note?.(), { cls: 'is-inline' }))),
      });
    }
    if (step === 'reading') {
      const bar = h('div', { class: 'st-ftue-bar', role: 'progressbar', 'aria-label': 'Files ready', 'aria-valuemin': '0' }, h('i'));
      const count = h('p', { class: 'st-ftue-count' });
      const parts = frame('reading', {
        title: 'Reading your files',
        body: 'Usually under a minute. You can keep going while it reads.',
        extra: h('div', { class: 'st-ftue-progress' }, bar, count),
      });
      queueMicrotask(paintReading);
      return parts;
    }
    if (step === 'ask') {
      const q = suggestedQuestion();
      return frame('ask', {
        title: 'Ask it a question',
        body: 'Every line of the answer shows the file it came from.',
        actions: h('div', { class: 'st-ftue-acts' },
          q ? btn(`Ask: ${q}`, () => ask(q), { primary: true, cls: 'st-ftue-ask', attrs: { 'data-q': q } })
            : btn('Type a question', () => hooks.focusAsk?.(), { primary: true, cls: 'st-ftue-ask' }),
          q ? btn('Or type your own', () => hooks.focusAsk?.(), { cls: 'is-inline' }) : null),
      });
    }
    if (step === 'trip') {
      return frame('trip', {
        title: 'Now try to trip it up',
        body: 'Ask something your files don’t cover. A good bot says it doesn’t know instead of guessing.',
        actions: h('div', { class: 'st-ftue-acts' },
          btn('Ask something off-topic', () => probe(), { primary: true, cls: 'st-ftue-probe' }),
          btn('Run the full test', () => hooks.runTest?.(), { cls: 'is-inline st-ftue-test', attrs: { title: 'Real questions from your files, plus a few it must refuse' } })),
      });
    }
    // ---- done
    if (phase === 'next') return buildNext();
    return buildTools();
  }

  function paintReading() {
    const { ready, total } = readingCounts();
    const bar = card.querySelector('.st-ftue-bar');
    const count = card.querySelector('.st-ftue-count');
    if (!bar || !count) return;
    bar.setAttribute('aria-valuemax', String(Math.max(total, 1)));
    bar.setAttribute('aria-valuenow', String(ready));
    bar.setAttribute('aria-valuetext', `${ready} of ${total} ready`);
    bar.firstChild.style.width = `${total ? Math.max(4, Math.round((ready / total) * 100)) : 4}%`;
    const t = total ? `${ready} of ${total} ${total === 1 ? 'file' : 'files'} ready` : 'Getting started…';
    if (count.textContent !== t) count.textContent = t;
  }
  function paintAsk() {
    const b = card.querySelector('.st-ftue-ask[data-q]');
    const q = suggestedQuestion();
    if (q && (!b || b.dataset.q !== q)) render(true);
  }

  function ask(q) {
    const chip = [...document.querySelectorAll('#sb-suggest-slot .sb-chip:not(.sb-chip-probe)')].find((c) => c.textContent.trim() === q);
    if (chip && chip.getAttribute('aria-disabled') !== 'true') { chip.click(); return; }
    hooks.ask?.(q);
  }
  function probe() {
    const chip = document.querySelector('#sb-suggest-slot .sb-chip-probe');
    if (chip) { chip.click(); return; }
    hooks.ask?.(PROBE_Q);
  }

  // ---- step 5a: where should it answer?
  function buildTools() {
    const current = new Set(normalizeSurfaces(getState().spec?.surfaces));
    const chosen = new Set(TOOLS.filter((t) => t.features.some((f) => current.has(f))).map((t) => t.id));
    if (!chosen.size) chosen.add('website');
    const note = h('p', { class: 'st-ftue-note', 'aria-live': 'polite' });
    const glyph = { website: 'chat', number: 'phone', email: 'mail' };
    const opts = h('div', { class: 'st-ftue-tools', role: 'group', 'aria-label': 'Where should it answer?' },
      TOOLS.map((t) => h('button', { type: 'button', class: 'st-ftue-tool', 'aria-pressed': String(chosen.has(t.id)), dataset: { tool: t.id },
        onclick: (e) => {
          const b = e.currentTarget;
          if (chosen.has(t.id) && chosen.size === 1) { note.textContent = `${t.label} stays on: pick another first. Your bot needs at least one.`; return; }
          if (chosen.has(t.id)) chosen.delete(t.id); else chosen.add(t.id);
          b.setAttribute('aria-pressed', String(chosen.has(t.id)));
          note.textContent = '';
        } },
      h('span', { class: 'st-ftue-tool-ico', 'aria-hidden': 'true', html: icon(glyph[t.id] || 'chat', 18) }),
      h('span', { class: 'st-ftue-tool-t' }, t.label, h('small', null, t.sub)),
      h('span', { class: 'st-ftue-tool-tick', 'aria-hidden': 'true', html: icon('check', 14) }))));
    const [head, main] = frame('done', {
      title: 'Your bot is ready',
      body: 'It answered from your files and refused what it didn’t know. Where should it answer?',
      extra: h('div', null, opts, note),
      actions: h('div', { class: 'st-ftue-acts' },
        btn('Continue', async (e) => {
          const b = e.currentTarget; b.disabled = true;
          const surfaces = [...new Set(TOOLS.filter((t) => chosen.has(t.id)).flatMap((t) => t.features))];
          try { await hooks.saveSurfaces?.(surfaces); } catch { /* app.js toasts a failed save */ }
          save({ phase: 'next' });
          render(true);
        }, { primary: true, cls: 'st-ftue-continue' })),
    });
    main.querySelector('.st-ftue-h')?.prepend(h('span', { class: 'st-ftue-done-mark', 'aria-hidden': 'true', html: icon('checkCircle', 18) }));
    return [head, main];
  }

  // ---- step 5b: what's next?
  const TABS = [['agent', 'Ask your AI agent'], ['dev', 'Send to your developer'], ['diy', 'Do it yourself']];
  function buildNext() {
    const s = getState();
    const on = new Set(normalizeSurfaces(s.spec?.surfaces));
    const website = TOOLS[0].features.some((f) => on.has(f));
    const liveNow = !!hooks.isLive?.();
    const launch = liveNow ? null : btn('Launch', () => hooks.launch?.(), { primary: true, cls: 'st-ftue-launch' });
    const stats = h('p', { class: 'st-ftue-stats' }, 'Check your stats any time in ',
      btn('Stats & Leads', () => hooks.openStats?.(), { cls: 'is-inline st-ftue-statslink' }), isMobile() ? ' (in the ⋯ menu).' : ' at the top.');
    const finish = btn('Finish the guide', () => finishGuide(), { cls: 'is-inline st-ftue-finish' });
    const back = btn('Change where it answers', () => { save({ phase: 'tools' }); render(true); }, { cls: 'is-inline' });
    let body;
    if (!website) {
      body = h('div', { class: 'st-ftue-next' },
        h('p', { class: 'st-ftue-p' }, 'Your number and inbox are set up from Set up, and they start answering once you launch.'),
        btn('Open Set up', () => hooks.openSetup?.(), { cls: 'is-inline' }));
    } else {
      body = whatsNextTabs();
    }
    const [head, main] = frame('done', {
      title: 'What’s next?',
      body: liveNow ? 'Your bot is live. Put it on your website one of three ways.' : 'Put it on your website one of three ways. It starts answering visitors once you launch.',
      extra: body,
      actions: h('div', { class: 'st-ftue-acts st-ftue-foot' }, launch, finish, back),
    });
    main.append(stats);
    return [head, main];
  }

  function whatsNextTabs() {
    const wrap = h('div', { class: 'st-ftue-next' });
    const tl = h('div', { class: 'st-ftue-tabs', role: 'tablist', 'aria-label': 'Ways to add it to your website' });
    const panel = h('div', { class: 'st-ftue-panel', role: 'tabpanel', id: 'st-ftue-panel', tabindex: '0' });
    let cur = TABS.some(([k]) => k === saved.tab) ? saved.tab : 'agent';
    const tabs = TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', class: 'st-ftue-tab', id: `st-ftue-tab-${k}`, 'aria-controls': 'st-ftue-panel', dataset: { tab: k },
      onclick: () => select(k, false) }, label));
    tl.append(...tabs);
    tl.addEventListener('keydown', (e) => {
      const i = TABS.findIndex(([k]) => k === cur);
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = TABS.length - 1;
      if (j == null) return;
      e.preventDefault(); select(TABS[j][0], true);
    });
    function select(k, focus) {
      cur = k; save({ tab: k });
      for (const b of tabs) { const sel = b.dataset.tab === k; b.setAttribute('aria-selected', String(sel)); b.tabIndex = sel ? 0 : -1; }
      panel.setAttribute('aria-labelledby', `st-ftue-tab-${k}`);
      if (focus) tabs.find((b) => b.dataset.tab === k)?.focus();
      paintPanel(panel, k);
    }
    wrap.append(tl, panel);
    select(cur, false);
    return wrap;
  }

  function snippet() {
    const surf = normalizeSurfaces(getState().spec?.surfaces).join(',');
    const sig = `${getState().trial.id}|${surf}|${!!getState().trial.converted}`;
    if (!snippetP || snippetFor !== sig) { snippetFor = sig; snippetP = Promise.resolve(hooks.websiteLine?.()).catch(() => null); }
    return snippetP;
  }

  function paintPanel(panel, k) {
    panel.replaceChildren(h('p', { class: 'st-ftue-p', role: 'status' }, 'Getting your line…'));
    snippet().then((line) => {
      if (!panel.isConnected) return;
      const real = line && typeof line === 'object' ? line.copy : line;
      const shown = line && typeof line === 'object' ? line.display : line;
      if (!real) { panel.replaceChildren(h('p', { class: 'st-ftue-p' }, 'Your website line isn’t available right now. Open Set up to copy it.')); return; }
      panel.replaceChildren(...panelContent(k, real, shown));
    });
  }

  function agentPrompt(line) {
    return [
      'Add the KnowBot chat to my website.',
      '',
      'Paste this one line just before the closing </body> tag in the shared layout or template that every page uses (for example the base layout, the theme footer, or _document / layout file), so it loads on every page:',
      '',
      line,
      '',
      'Don’t change anything else on the page.',
      '',
      'Then check it: run the site, open any page, and confirm a chat bubble appears in the bottom-right corner, and that the browser console shows no errors from embed.js. (The bubble starts answering visitors once the bot is launched in KnowBot Studio.)',
    ].join('\n');
  }
  function devMessage(line) {
    return [
      'Hi,',
      '',
      'Could you add our KnowBot chat to the website? It is one line:',
      '',
      line,
      '',
      '1. Paste it just before </body> in the template or layout every page uses.',
      '2. Don’t change anything else.',
      '3. Open any page and check that a chat bubble appears in the bottom-right corner.',
      '',
      'It starts answering visitors once we launch the bot. Thanks!',
    ].join('\n');
  }

  function panelContent(k, real, shown) {
    if (k === 'agent') {
      const text = agentPrompt(real);
      return [h('p', { class: 'st-ftue-p' }, 'Paste this into your AI coding agent. It says exactly where the line goes and how to check it.'),
        codeBox(agentPrompt(shown), text, 'Copy prompt', 'Prompt copied')];
    }
    if (k === 'dev') {
      const text = devMessage(real);
      const mail = `mailto:?subject=${encodeURIComponent('Add our KnowBot chat to the website')}&body=${encodeURIComponent(text)}`;
      return [h('p', { class: 'st-ftue-p' }, 'A short message with the line and the steps.'),
        codeBox(devMessage(shown), text, 'Copy message', 'Message copied',
          h('a', { class: 'st-ftue-link is-inline st-ftue-mail', href: mail }, h('span', { 'aria-hidden': 'true', class: 'st-ftue-ico', html: icon('mail', 15) }), h('span', null, 'Open in email')))];
    }
    return [h('ol', { class: 'st-ftue-steps' },
      h('li', null, 'Copy the line below.'),
      h('li', null, 'In your site’s editor, find where you can add code to every page. It’s often called “Custom code”, “Footer scripts” or “Code injection”.'),
      h('li', null, 'Paste it just before </body>, save, and open your site to see the chat bubble.')),
      codeBox(shown, real, 'Copy line', 'Line copied')];
  }

  function codeBox(display, copy, label, done, extra = null) {
    const status = h('span', { class: 'st-sr', role: 'status' });
    const copyBtn = h('button', { type: 'button', class: 'st-ftue-link is-inline st-ftue-copy', dataset: { copy } },
      h('span', { 'aria-hidden': 'true', class: 'st-ftue-ico', html: icon('copy', 15) }), h('span', null, label));
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(copy);
      const lab = copyBtn.lastChild;
      lab.textContent = ok ? 'Copied' : 'Select and copy';
      status.textContent = ok ? done : 'Copy didn’t work here. Select the text and copy it.';
      setTimeout(() => { lab.textContent = label; }, 1800);
    });
    return h('div', { class: 'st-ftue-code' },
      h('pre', { class: 'st-ftue-pre', tabindex: '0', 'aria-label': label.replace(/^Copy /, '') }, h('code', null, display)),
      h('div', { class: 'st-ftue-codebar' }, copyBtn, extra, status));
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* fall back */ }
    try {
      const ta = h('textarea', { style: 'position:fixed;opacity:0;left:-9999px', 'aria-hidden': 'true' }); ta.value = t;
      document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }

  // ------------------------------------------------------------------ celebration
  function celebrate() {
    card.classList.add('is-celebrating');
    setTimeout(() => card.classList.remove('is-celebrating'), 2000);
    if (reduced()) { card.dataset.celebrated = 'calm'; return; }
    card.dataset.celebrated = 'fireworks';
    fireworks(card);
  }

  function fireworks(anchor) {
    const cv = h('canvas', { class: 'st-ftue-fireworks', 'aria-hidden': 'true' });
    document.body.append(cv);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    if (!g) { cv.remove(); return; }
    g.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--f0', '--f2', '--f4', '--f5', '--f7', '--f6'].map((v) => cs.getPropertyValue(v).trim()).filter(Boolean);
    if (!colors.length) colors.push('#6c5ce7');
    const r = anchor.getBoundingClientRect();
    const origins = [
      { x: r.left + r.width * 0.5, y: r.top + 10, at: 0 },
      { x: r.left + r.width * 0.2, y: r.top + 24, at: 260 },
      { x: r.left + r.width * 0.8, y: r.top + 18, at: 480 },
    ];
    const parts = [];
    const spawn = (o) => {
      const n = 44;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const sp = 2.6 + Math.random() * 3.6;
        parts.push({ x: o.x, y: o.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.6, life: 0, max: 1000 + Math.random() * 600, c: colors[(i + o.at) % colors.length], s: 2 + Math.random() * 2 });
      }
    };
    const t0 = performance.now();
    let last = t0;
    const fired = new Set();
    const tick = (now) => {
      const dt = Math.min(40, now - last); last = now;
      const el = now - t0;
      origins.forEach((o, i) => { if (!fired.has(i) && el >= o.at) { fired.add(i); spawn(o); } });
      g.clearRect(0, 0, W, H);
      const k = dt / 16.7;
      for (const p of parts) {
        p.life += dt;
        p.vx *= Math.pow(0.97, k); p.vy = p.vy * Math.pow(0.97, k) + 0.06 * k;
        p.x += p.vx * k; p.y += p.vy * k;
        const a = Math.max(0, 1 - p.life / p.max);
        if (!a) continue;
        g.globalAlpha = a;
        g.fillStyle = p.c;
        g.beginPath(); g.arc(p.x, p.y, p.s, 0, Math.PI * 2); g.fill();
      }
      if (el < 1900) requestAnimationFrame(tick); else cv.remove();
    };
    requestAnimationFrame(tick);
  }

  function pulseStats() {
    const target = isMobile() ? document.getElementById('st-more') : document.getElementById('st-leads');
    if (!target || target.offsetParent === null) return;
    target.classList.remove('is-guide-pulse');
    requestAnimationFrame(() => requestAnimationFrame(() => target.classList.add('is-guide-pulse')));
    setTimeout(() => target.classList.remove('is-guide-pulse'), 4200);
  }

  // ------------------------------------------------------------------ show / hide
  function focusAfterHide() {
    const t = [document.getElementById(isMobile() && getState().ui?.tab === 'setup' ? 'st-setup-composer' : 'sb-input'), document.getElementById('st-setup-composer'), document.getElementById('st-more')]
      .find((x) => x && x.offsetParent !== null);
    t?.focus({ preventScroll: true });
  }
  function dismiss({ via = 'x' } = {}) {
    if (!active()) return;
    const hadFocus = card.contains(document.activeElement);
    save({ status: 'dismissed' });
    render();
    shownStep = null;
    announce?.('Guide hidden. Bring it back from the More options menu: Show the guide.');
    hooks.onDismiss?.(via);
    if (hadFocus) focusAfterHide();
  }
  function finishGuide() {
    const hadFocus = card.contains(document.activeElement);
    save({ status: 'done' });
    render();
    shownStep = null;
    announce?.('Guide finished. It is in the More options menu if you want it again.');
    if (hadFocus) focusAfterHide();
  }
  function show() {
    save({ status: 'active' });
    shownStep = null;
    render(true);
    requestAnimationFrame(() => { card.scrollIntoView?.({ block: 'nearest' }); card.querySelector('.st-ftue-h')?.focus({ preventScroll: true }); });
  }

  // a live (launched) bot never starts the guide on its own
  if (active() && hooks.isLive?.() && !saved.phase) save({ status: 'done' });

  on('state', schedule);
  on('milestone', schedule);
  on('change:spec', () => { snippetP = null; });
  matchMedia('(max-width: 899px)').addEventListener?.('change', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-landing', 'data-builder'] });
  render(true);

  return { show, dismiss, active, step: () => (visible() ? ftueStep(getState()) : null), el: card };
}
