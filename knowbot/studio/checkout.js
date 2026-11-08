// KnowBot Studio: Launch, checkout and go-live (owner E). SPEC 1.4 B9–B11, 2.7 (Launch), 6.4, 11.1–11.3.
//
// What lives here
//   - `launch` card (variant 'launch' = the LaunchCard receipt + $249/mo plan, variant 'make-it-yours')
//   - `activating` and `success` cards (return from checkout, B11) + the Live burst
//   - the CheckoutSheet (co-modal-slot, role=dialog, focus trap, inert background, view transition from the card)
//   - the Go-live sheet (Channels gallery + Developers tab) is lazily imported from ./golive.js
//
// Cross-module effects only through store events (SPEC 3.3): launch:open in; proof:run, drawer:open, setup:post,
// checkout:dismissed, tab:show, intake:pick out. Nothing here reaches into another owner's DOM, except reading the
// SampleBot composer to focus it for "Keep testing" (the same affordance B uses).

const NBSP = ' ';
const DEFAULT_ANCHORS = { asOf: '2026-11', items: ['CustomGPT Premium $499/mo', 'Chatbase Business $500/mo (40 MB cap)', 'Botpress Team $939/mo', 'Intercom Fin $0.99 per resolution'] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POLL_MS = 2000, POLL_FOR_MS = 20000, MINI_PROOF_WAIT = 45000;

// ------------------------------------------------------------------ tiny DOM helpers (module-local)

export function h(tag, props, ...kids) {
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
const plural = (n, w, pl = w + 's') => `${Number(n).toLocaleString()} ${n === 1 ? w : pl}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const initialsOf = (name) => { const w = String(name || '').trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] || 'B') + (w[1]?.[0] || w[0]?.[1] || '')).toUpperCase().slice(0, 2); };
export const mbOf = (b) => { const mb = (Number(b) || 0) / 1048576; return mb === 0 ? '0' : mb < 0.1 ? mb.toFixed(2) : mb < 10 ? mb.toFixed(1) : String(Math.round(mb)); };
const stripMarkers = (s) => String(s || '').replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/\s+/g, ' ').trim();
export function firstSentence(text) {
  const t = String(text || '').replace(/^\s*[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{12,220}?[.!?])(\s|$)/);
  const s = m ? m[1] : t.slice(0, 200) + (t.length > 200 ? '…' : '');
  return s;
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = h('textarea', { class: 'co-sr', readonly: true, 'aria-hidden': 'true' }); ta.value = text;
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}

// ------------------------------------------------------------------ mount

export function mount(ctx) {
  const { store, api, motion, icons, slots, announce } = ctx;
  const { getState, setState, on, emit, mark, registerCard } = store;
  const icon = (n, s = 16) => icons.icon(n, s);
  const modal = slots.modal || document.getElementById('co-modal-slot');
  const params = new URLSearchParams(location.search);
  const subs = [];
  const sub = (type, fn) => { subs.push(on(type, fn)); };

  // ---------------------------------------------------------------- derived state

  const cfg = () => getState().config || {};
  const price = () => {
    const p = cfg().price || {};
    const amount = Number(p.amount) || 249;
    const cur = (p.currency || 'USD').toUpperCase();
    const sym = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : `${cur} `;
    const per = p.interval === 'year' ? 'yr' : 'mo';
    return { amount, sym, per, text: `${sym}${amount}/${per}`, today: `${sym}${amount.toFixed(2)}`, long: `${sym}${amount}/${p.interval === 'year' ? 'year' : 'month'}`, p };
  };
  const botName = () => getState().spec.name || 'Your bot';
  const hueVar = () => `var(--f${(Number(getState().spec.avatar?.hue) || 0) % 8})`;
  const enabledFiles = () => {
    const s = getState();
    // Integrator: spec.sources is the live scope (the drawer writes it); a file row's `enabled` can lag behind it
    const src = s.spec && s.spec.sources;
    const on = (f) => (src && typeof src === 'object' ? src[f.id] !== false : f.enabled !== false);
    return (s.fileOrder || []).map((id) => s.files[id]).filter((f) => f && on(f) && f.phase !== 'rejected' && f.phase !== 'failed');
  };
  const readyFiles = () => enabledFiles().filter((f) => f.phase === 'ready');
  const sampleOnly = () => { const en = enabledFiles(); return en.length > 0 && en.every((f) => f.sample); };
  function stats() {
    const s = getState();
    const files = enabledFiles();
    const atoms = files.reduce((a, f) => a + (Number(f.atoms) || 0), 0);
    const quotaMB = Math.round((s.trial.quota?.bytes || cfg().quota?.bytes || 104857600) / 1048576);
    const sc = s.proof?.score || null;
    // fixer r2 (D8): the 3 + 1 mini check before launch is a "Quick check", never labelled as the 8 + 3 Proof Run.
    const tests = sc ? { passed: (sc.answered || 0) + (sc.refused || 0), total: (sc.total || 0) + (sc.probes || 0), unsupported: sc.unsupported || 0, full: (sc.total || 0) >= 8 } : null;
    return { files: files.length, samples: files.filter((f) => f.sample).length, bytes: s.usage?.bytes || files.reduce((a, f) => a + (f.bytes || 0), 0), quotaMB, atoms, tests };
  }
  /** The last grounded answer: prefer the visitor's own questions over Proof Run rows. */
  // fixer r3 (D8): the peak never shows a fragment. A candidate's first sentence must start with a capital (or a
  // digit/quote), have at least 5 words and end the sentence (no "…" cut). Visitor answers beat Proof Run rows; within
  // each group the best-matching answer wins (ties: the most recent).
  function lastQA() {
    const th = getState().thread || [];
    const ok = (a) => a && a.status === 'grounded' && a.final && !a.final.refused && typeof a.final.text === 'string' && (a.final.citations || []).length;
    const sentenceOf = (a) => stripMarkers(firstSentence(a.final.text));
    const clean = (s) => !!s && !/^[a-z]/.test(s) && s.split(/\s+/).filter(Boolean).length >= 5 && /[.!?]["”’)]?$/.test(s) && !/…$/.test(s);
    const score = (a) => Math.max(0, ...(a.final.citations || []).map((c) => Number(c.match) || (c.similarity != null ? Number(c.similarity) * 100 : 0) || 0), Number(a.final.topMatch) || 0);
    const cands = th.map((a, i) => ({ a, i })).filter(({ a }) => ok(a) && a.question && clean(sentenceOf(a)));
    const best = (list) => list.sort((x, y) => (score(y.a) - score(x.a)) || (y.i - x.i))[0]?.a || null;
    const pick = best(cands.filter(({ a }) => a.by !== 'proof')) || best(cands.filter(({ a }) => a.by === 'proof'))
      || [...th].reverse().find((a) => ok(a) && /[.!?]["”’)]?$/.test(sentenceOf(a)));
    if (!pick) return null;
    const c = pick.final.citations.find((x) => x.n === 1) || pick.final.citations[0];
    return { answerId: pick.id, question: pick.question, answer: sentenceOf(pick), cite: c };
  }
  const anchors = () => {
    const a = cfg().anchors && (cfg().anchors.items || []).length ? cfg().anchors : DEFAULT_ANCHORS;
    const m = /^(\d{4})-(\d{2})/.exec(a.asOf || '');
    const when = m ? `${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}` : a.asOf || '';
    return `For comparison, as published ${when}: ${a.items.join(' · ')}.`;
  };
  const contactHref = () => { const c = cfg().contact || 'mailto:hello@knowdrive.ai'; return /^(mailto:|https?:)/i.test(c) ? c : `mailto:${c}`; };
  const isMobile = () => matchMedia('(max-width: 899px)').matches;
  const testsName = (t) => (t && t.full ? 'Proof Run' : 'Quick check');
  const FULL_PROOF_N = 11;   // 8 in-scope questions + 3 out-of-scope probes (SPEC 1.4 B8)
  const runFullProof = (before) => { if (before) before(); emit('proof:run', { mini: false }); };

  // ---------------------------------------------------------------- shared bits

  function avatar(size = 40) {
    const s = getState().spec;
    return h('span', { class: 'co-ava', style: { '--co-hue': hueVar(), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }, 'aria-hidden': 'true' }, s.avatar?.initials || initialsOf(s.name));
  }
  function copyButton(getText, label = 'Copy', { small = false, what = 'Copied', aria = null } = {}) {
    const lab = h('span', { class: 'co-copy-label' }, label);
    const b = h('button', { type: 'button', class: `co-btn co-btn-ghost co-copy${small ? ' is-small' : ''}`, 'aria-label': aria || label }, h('span', { class: 'co-copy-ico', html: icon('copy', 14) }), lab);
    b.addEventListener('click', async () => {
      const ok = await copyText(typeof getText === 'function' ? getText() : getText);
      b.classList.toggle('is-done', ok);
      lab.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      b.querySelector('.co-copy-ico').innerHTML = icon(ok ? 'check' : 'copy', 14);
      announce(ok ? what : 'Copy failed. Select the text and copy it.', 'polite');
      if (ok) motion.animate(b, [{ transform: 'scale(.96)' }, { transform: 'scale(1.04)' }, { transform: 'none' }], { duration: motion.DUR[2], easing: 'spring', essential: false });
      clearTimeout(b._t);
      b._t = setTimeout(() => { lab.textContent = label; b.classList.remove('is-done'); b.querySelector('.co-copy-ico').innerHTML = icon('copy', 14); }, 1800);
    });
    return b;
  }
  function focusBotComposer() {
    if (isMobile()) emit('tab:show', { tab: 'bot' });
    setTimeout(() => {
      const t = slots.composer && slots.composer.querySelector('textarea, input[type="text"]');
      if (t) t.focus();
    }, isMobile() ? 260 : 0);
  }

  // ================================================================== LaunchCard (B9)

  const launchCards = new Set();   // live instances (all reflect the store)
  let sheet = null;   // CheckoutSheet {layer, dialog, invoker, prevInert, redirecting, dismissed} (declared early: syncCtaFlag reads it)
  let stage = null;   // LaunchStage {layer, panel, inst, opener, cleanup[]}
  let focusNextCard = false;       // set by a user-initiated launch:open: the next summary takes focus (D9)
  let autoStageNext = false;       // set by launch:open: at ≥ 1100 px the next summary also opens the wide receipt
  let foldForSheet = false;        // closing the receipt panel because checkout opens: the Builder card stays folded

  // ---- One solid CTA per viewport (fixer r2, D8). While a Launch card CTA is on screen, or the receipt/checkout is
  // open, the header Launch pill is demoted to outline. CONTRACT-GAP (B): SPEC has no flag for this; E publishes
  // ui.launchCardVisible (store) and :root[data-co-cta] (checkout.css restyles #st-price[data-level="solid"] from it).
  // B can read the store flag instead and drop the CSS override.
  const ctaSeen = new Set();
  const ctaIO = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((ents) => { for (const e of ents) { if (e.isIntersecting) ctaSeen.add(e.target); else ctaSeen.delete(e.target); } syncCtaFlag(); }, { threshold: 0.5 })
    : null;
  function ctaWatch(el) { if (ctaIO) ctaIO.observe(el); else { ctaSeen.add(el); syncCtaFlag(); } }
  function ctaUnwatch(el) { if (ctaIO) ctaIO.unobserve(el); ctaSeen.delete(el); syncCtaFlag(); }
  function syncCtaFlag() {
    for (const t of [...ctaSeen]) if (!t.isConnected) ctaSeen.delete(t);
    const mode = sheet ? 'sheet' : stage ? 'receipt' : ctaSeen.size ? 'card' : null;
    const root = document.documentElement;
    if (mode) root.setAttribute('data-co-cta', mode); else root.removeAttribute('data-co-cta');
    const ui = getState().ui || {};
    if (!!ui.launchCardVisible !== !!mode) setState({ ui: { ...ui, launchCardVisible: !!mode } }, 'ui:launchCardVisible');
  }

  /**
   * The Builder column is ~400 px wide (and a phone is 390), too narrow for the two-column receipt + plan (fixer r1, D8).
   * The chat always gets a compact LaunchSummary: bot, stats, the cited answer, $249 and the CTA in one view. The full
   * card lives in the LaunchStage: at 1100 px and wider it is docked over the SampleBot pane and opens by itself
   * (morphing out of the summary), so receipt, embed preview, price and CTA are visible together above the fold;
   * narrower, "Receipt & plan" opens it as a full-screen dialog.
   */
  function renderLaunchCard(data, el) {
    if (data && data.variant === 'make-it-yours') return renderMakeItYours(el);
    return renderLaunchSummary(el, data || {});
  }

  function builderRect() {
    const b = document.getElementById('st-setup');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width >= 300 && r.height >= 320 ? r : null;
  }
  function botPaneRect() {
    const b = document.getElementById('st-bot');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width >= 560 && r.height >= 360 ? r : null;
  }

  function buildFullCard(el, { where = 'chat' } = {}) {
    const pr = price();
    const titleId = `co-lc-${Math.random().toString(36).slice(2, 8)}`;

    // --- receipt (left)
    const nameEl = h('b', { class: 'co-rc-name' }, botName());
    const subEl = h('small', { class: 'co-rc-sub' });
    const statEls = {};
    const stat = (key, label, unit) => h('div', { class: 'co-stat', dataset: { k: key } },
      h('dt', null, label),
      h('dd', null, statEls[key] = h('span', { class: 'co-num', dataset: { value: '0' } }, '0'), h('small', { class: 'co-unit' }, unit || '')));
    const statsEl = h('dl', { class: 'co-stats' },
      stat('files', 'Files'), stat('mb', 'Storage', 'of 100 MB'), stat('atoms', 'Atoms'), stat('tests', 'Checks', ''));
    const testsLine = h('p', { class: 'co-rc-tests' });
    const qaEl = h('figure', { class: 'co-qa' });
    const embedEl = h('div', { class: 'co-embed-wrap' });
    const receipt = h('section', { class: 'co-receipt', 'aria-label': 'Your KnowBot receipt' },
      h('header', { class: 'co-rc-head' }, h('span', { class: 'co-eyebrow' }, 'Your KnowBot'), h('span', { class: 'co-rc-badge' }, h('i', { class: 'co-dot is-ready', 'aria-hidden': 'true' }), 'Built · ready to launch')),
      h('div', { class: 'co-rc-id' }, avatar(40), h('div', { class: 'co-rc-idtext' }, nameEl, subEl)),
      statsEl, testsLine, qaEl, embedEl);

    // --- plan (right)
    const p = pr.p;
    const incl = [
      ['Your KnowBot, hosted with a share link', 'link'],
      ['Embed widget for any site', 'code'],
      ['100 MB of KnowDrive storage: PDF, DOCX, PPTX, XLSX, HTML, MD, TXT, images, audio', 'layers'],
      ['Your files carry over, nothing gets re-uploaded', 'refresh'],
      ['Citations on every answer, canonical refusals', 'shieldCheck'],
      ['Question insights: every question your customers ask is captured so you can see gaps', 'trending'],
      ['Chat API (OpenAI-compatible) and channel templates: SMS, phone, WhatsApp, email, voice', 'chat'],
      p.answersIncluded ? [String(p.answersIncluded), 'bolt'] : null,
      ['Cancel anytime', 'checkCircle'],
    ].filter(Boolean);
    const cta = h('button', { type: 'button', class: 'co-cta', 'aria-describedby': `${titleId}-trust` },
      h('span', { class: 'co-cta-label' }, `Launch ${botName()} · ${pr.text}`), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    cta.addEventListener('click', () => openSheet({ source: 'card', from: receipt, invoker: cta }));
    const channelsStrip = h('button', { type: 'button', class: 'co-chstrip' },
      h('span', { class: 'co-chstrip-icons', 'aria-hidden': 'true' }, ...['chat', 'phone', 'mail', 'mic', 'code'].map((n, i) => h('i', { style: { '--i': i }, html: icon(n, 13) }))),
      h('span', { class: 'co-chstrip-text' }, 'Web, SMS, phone, WhatsApp, email, voice and API'),
      h('span', { class: 'co-chstrip-go' }, 'Explore', h('span', { html: icon('chevronRight', 14) })));
    channelsStrip.addEventListener('click', () => openGoLive({ tab: 'channels', invoker: channelsStrip }));
    // Order: price → CTA → reassurance first, inclusions after, so the CTA is above the fold at every size (fixer r1).
    const plan = h('section', { class: 'co-plan', 'aria-labelledby': titleId },
      h('div', { class: 'co-plan-brand' }, h('img', { src: '../dashboard/logo.svg', alt: '', width: 20, height: 14 }), 'KnowDrive'),
      h('h3', { class: 'co-price', id: titleId }, h('span', { class: 'co-price-amt' }, `${pr.sym}${pr.amount}`), h('span', { class: 'co-price-per' }, `/${p.interval === 'year' ? 'year' : 'month'}`)),
      h('p', { class: 'co-tagline' }, 'One flat price to build and host your KnowBot. No per-answer fees.'),
      where === 'chat' ? cta : null,   // inline: the card's own CTA is the only one; stage: the sticky bar is (fixer r4, D8)
      h('div', { class: 'co-sublinks' },
        h('button', { type: 'button', class: 'co-link', onclick: () => { announce('Keep testing. Your bot is saved.'); if (where === 'stage') closeStage({ focus: false }); focusBotComposer(); } }, 'Keep testing'),
        h('span', { class: 'co-sep', 'aria-hidden': 'true' }, '·'),
        h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us')),
      h('p', { class: 'co-trust', id: `${titleId}-trust` }, h('span', { html: icon('lock', 13) }), `Your files stay private to your bot. Saved for ${cfg().quota?.ttlDays || 7} days if you don't launch.`),
      h('ul', { class: 'co-incl', 'aria-label': 'Included' }, incl.map(([t]) => h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 14) }), h('span', null, t)))),
      p.annualLine ? h('p', { class: 'co-optline' }, String(p.annualLine)) : null,
      p.guaranteeLine ? h('p', { class: 'co-optline' }, h('span', { html: icon('shieldCheck', 14) }), ' ', String(p.guaranteeLine)) : null,
      channelsStrip,
      h('p', { class: 'co-anchors' }, anchors()));

    const card = h('article', { class: `co-launch${where === 'stage' ? ' is-stage' : where === 'inline' ? ' is-inline' : ''}`, 'aria-label': where === 'inline' ? `${botName()}: full receipt and plan` : `Launch ${botName()}` }, h('div', { class: 'co-launch-glow', 'aria-hidden': 'true' }), h('div', { class: 'co-launch-grid' }, receipt, plan));
    el.append(card);

    const inst = { el, card, receipt, cta, kind: where === 'stage' ? 'stage' : where === 'inline' ? 'inline' : 'launch', paint, update: () => paint(false), destroy };
    launchCards.add(inst);

    function paintQA() {
      const qa = lastQA();
      qaEl.innerHTML = '';
      qaEl.hidden = !qa;
      embedEl.innerHTML = '';
      embedEl.append(embedPreview(qa));
      if (!qa) return;
      const c = qa.cite;
      const chip = h('button', { type: 'button', class: 'co-cite', 'aria-label': `Citation 1: ${c.title || c.file}${c.seq != null ? `, atom ${c.seq}` : ''}. Opens the quoted source.` }, '1');
      chip.addEventListener('click', () => emit('drawer:open', { fileId: c.fileId, atomId: c.atomId ?? null, seq: c.seq ?? null, answerId: qa.answerId, n: c.n || 1 }));
      qaEl.append(
        h('figcaption', { class: 'co-qa-q' }, h('span', { class: 'co-qa-k' }, 'Q'), h('span', null, qa.question)),
        h('blockquote', { class: 'co-qa-a' }, h('span', { class: 'co-qa-k' }, 'A'), h('span', null, qa.answer, NBSP, chip)),
        h('p', { class: 'co-qa-src' }, h('span', { class: 'co-qa-src-ico', html: icon('file', 12) }), h('span', null, [c.file || c.title || 'source', c.locator, c.match != null ? `match ${c.match}` : null].filter(Boolean).join(' · '))));
    }
    function paint(first, { fromZero = false } = {}) {
      const st = stats();
      if (fromZero) for (const k of ['files', 'atoms', 'mb']) statEls[k].dataset.value = '0';
      nameEl.textContent = botName();
      const org = getState().spec.org;
      subEl.textContent = `${org ? `for ${org} · ` : ''}${st.samples && st.samples === st.files ? 'sample files' : plural(st.files, 'file')} · saved ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      $('.co-cta-label', cta).textContent = `Launch ${botName()} · ${price().text}`;
      if (where !== 'inline') card.setAttribute('aria-label', `Launch ${botName()}`);
      const ms = fromZero && !motion.reduced() ? 700 : first ? 0 : 300;
      motion.ticker(statEls.files, st.files, { ms });
      motion.ticker(statEls.atoms, st.atoms, { ms });
      const mbTo = Number(mbOf(st.bytes));
      const dec = mbTo < 0.1 && mbTo > 0 ? 2 : mbTo < 10 ? 1 : 0;
      const mbFrom = Number(statEls.mb.dataset.value) || 0;
      statEls.mb.dataset.value = String(mbTo);
      motion.tween(mbFrom, mbTo, ms, (v) => { statEls.mb.textContent = v.toFixed(dec); });
      $('.co-unit', statsEl.querySelector('[data-k="mb"]')).textContent = `of ${st.quotaMB} MB`;
      const tUnit = $('.co-unit', statsEl.querySelector('[data-k="tests"]'));
      testsLine.innerHTML = '';
      if (st.tests && st.tests.total) {
        statEls.tests.textContent = `${st.tests.passed}/${st.tests.total}`;
        tUnit.textContent = 'passed';
        const allPass = st.tests.passed === st.tests.total && !st.tests.unsupported;
        testsLine.className = `co-rc-tests${allPass ? ' is-pass' : ''}`;
        $('dt', statsEl.querySelector('[data-k="tests"]')).textContent = st.tests.full ? 'Proof Run' : 'Quick check';
        testsLine.append(h('span', { html: icon(allPass ? 'shieldCheck' : 'shield', 14) }), `${testsName(st.tests)} ${st.tests.passed}/${st.tests.total} passed · ${plural(st.tests.unsupported, 'unsupported claim')}`);
        if (!st.tests.full) testsLine.append(h('button', { type: 'button', class: 'co-link', onclick: () => runFullProof(where === 'stage' ? () => closeStage({ focus: false }) : null) }, `Run the full Proof Run (${FULL_PROOF_N})`));
      } else {
        statEls.tests.textContent = '—';
        tUnit.textContent = 'not run';
        testsLine.className = 'co-rc-tests';
        testsLine.append(h('span', { html: icon('flask', 14) }), 'Not tested yet · ', h('button', { type: 'button', class: 'co-link', onclick: () => { if (where === 'stage') closeStage({ focus: false }); emit('proof:run', { mini: false }); } }, 'Run the Proof Run'));
      }
      statsEl.setAttribute('aria-label', `${plural(st.files, 'file')}, ${mbOf(st.bytes)} MB of ${st.quotaMB} MB, ${plural(st.atoms, 'atom')}${st.tests ? `, ${testsName(st.tests)} ${st.tests.passed} of ${st.tests.total} passed` : ''}`);
      $$('.co-ava', receipt).forEach((a) => { a.textContent = getState().spec.avatar?.initials || initialsOf(botName()); a.style.setProperty('--co-hue', hueVar()); });
      if (first || !qaEl.dataset.answer || qaEl.dataset.answer !== (lastQA()?.answerId || '')) { paintQA(); qaEl.dataset.answer = lastQA()?.answerId || ''; }
    }
    paint(true);

    // Signature: assemble (380 ms slide, 60 ms row stagger, 700 ms stats, EmbedPreview last). Skippable (click / Esc).
    const rows = [receipt.querySelector('.co-rc-head'), receipt.querySelector('.co-rc-id'), statsEl, testsLine, qaEl, ...plan.children].filter((x) => x && !x.hidden && x !== embedEl);
    if (!motion.reduced()) {
      for (const r of rows) r.style.opacity = '0';
      embedEl.style.opacity = '0';
    }
    motion.director.request('launch', 2, async (signal) => {
      const anims = [];
      const A = (node, kf, o) => { const a = motion.animate(node, kf, { ...o, signal }); anims.push(a); return a; };
      A(card, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'out' });
      rows.forEach((r, i) => A(r, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: 80 + i * 60, easing: 'out', fill: 'backwards' }).finished.then(() => { r.style.opacity = ''; }));
      paint(false, { fromZero: true });
      const embedAt = 80 + Math.min(rows.length, 8) * 60;
      await Promise.race([sleep(embedAt), new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
      embedEl.style.opacity = '';
      const e = A(embedEl, [{ opacity: 0, transform: 'translateX(18px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3] + 60, easing: 'spring' });
      playEmbed(embedEl, signal);
      await e.finished;
      await Promise.all(anims.map((a) => a.finished));
    }, { region: card, maxMs: 6000 }).finally(() => { for (const r of rows) r.style.opacity = ''; embedEl.style.opacity = ''; caretEmbed(embedEl); });

    function destroy() { launchCards.delete(inst); }
    return inst;
  }

  // ---- LaunchSummary: the launch card in the Builder chat (every width).
  // fixer r3 (D8): the card itself carries the whole pitch: Q and A with a working [1], the three inclusions that matter,
  // a small embed thumbnail, the price, the CTA, "Questions? Talk to us" and the trust line. At ≥ 1100 px the wide
  // two-column receipt (LaunchStage) also opens docked over the SampleBot pane; narrower, "Receipt & plan" expands the
  // full receipt inline inside this card (no overlay that could cover the CTA).
  function renderLaunchSummary(el, data) {
    const pr = price();
    const nameEl = h('span', { class: 'co-sum-name' }, botName());
    const edit = h('button', { type: 'button', class: 'co-sum-edit', 'aria-label': `Rename ${botName()} or edit its settings`, title: 'Edit name and settings', html: icon('edit', 13) });
    edit.addEventListener('click', () => {
      // CONTRACT-GAP (B): no store event opens the spec drawer; the BotChip is the documented entry point, so it is clicked.
      const chip = document.getElementById('st-botchip');
      if (chip && chip.getClientRects().length) chip.click(); else { if (isMobile()) emit('tab:show', { tab: 'setup' }); document.getElementById('st-setup-composer')?.focus(); }
    });
    const subEl = h('small', { class: 'co-rc-sub co-sum-sub' });
    const pills = h('p', { class: 'co-sum-pills' });
    const qaEl = h('figure', { class: 'co-sum-qa', hidden: true });
    const amt = h('span', { class: 'co-price-amt' }, `${pr.sym}${pr.amount}`);
    const per = h('span', { class: 'co-price-per' }, `/${pr.p.interval === 'year' ? 'year' : 'month'}`);
    const cta = h('button', { type: 'button', class: 'co-cta' },
      h('span', { class: 'co-cta-label' }, `Launch ${botName()} · ${pr.text}`), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    const moreId = `co-sum-more-${Math.random().toString(36).slice(2, 8)}`;
    const more = h('div', { class: 'co-sum-more', id: moreId, hidden: true });
    const viewLabel = h('span', null, 'Receipt & plan');
    const view = h('button', { type: 'button', class: 'co-btn co-btn-ghost is-small co-sum-view', 'aria-expanded': 'false', 'aria-controls': moreId },
      h('span', { class: 'co-sum-view-ico', html: icon('layers', 14) }), viewLabel);
    const headId = `co-sum-h-${Math.random().toString(36).slice(2, 8)}`;
    const heading = h('h3', { class: 'co-sum-h', id: headId }, nameEl, edit);
    const fullLink = h('button', { type: 'button', class: 'co-link co-sum-full', hidden: true, onclick: () => runFullProof(() => closeStage({ focus: false })) }, `Run the full Proof Run (${FULL_PROOF_N})`);
    const chBtn = h('button', { type: 'button', class: 'co-link co-sum-channels' }, 'See channels & API');
    chBtn.addEventListener('click', () => openGoLive({ tab: 'channels', invoker: chBtn }));
    const incl = h('ul', { class: 'co-sum-incl', 'aria-label': 'Included in the plan' },
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, 'Hosted share link + embed widget for any site')),
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, '6 channels (SMS, phone, WhatsApp, email, voice, web) + chat API · ', chBtn)),
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, 'Question insights: see what customers ask and where the gaps are')));
    const thumb = h('div', { class: 'co-thumb-hold' });
    // fixer r4 (D8): while the receipt panel is open over the bot pane, this card folds to a one-line stub (name ·
    // checks · price · "Receipt open"), with no CTA, no anchors and no repeated inclusions: one solid CTA, in the panel.
    const stubText = h('span', { class: 'co-stub-text' });
    const stubGo = h('span', { class: 'co-stub-go-t' }, 'Receipt open');
    const stub = h('button', { type: 'button', class: 'co-stub', hidden: true },
      h('span', { class: 'co-stub-dot', 'aria-hidden': 'true' }), stubText,
      h('span', { class: 'co-stub-go' }, stubGo, h('span', { html: icon('arrowRight', 13) })));
    stub.addEventListener('click', () => {
      if (sheet) { try { sheet.email.focus(); } catch { /* ignore */ } return; }
      if (stage) { try { stage.panel.focus({ preventScroll: true }); } catch { /* ignore */ } pulseCard(stage.panel); } else collapse(false);
    });
    // Programmatic focus lands on the card (tabindex=-1, no resting ring), never on the name: it is not an input.
    const card = h('article', { class: 'co-launch co-sum', 'aria-labelledby': headId, tabindex: '-1' },
      h('div', { class: 'co-launch-glow', 'aria-hidden': 'true' }),
      stub,
      h('div', { class: 'co-sum-body' },
        h('div', { class: 'co-sum-head' }, avatar(40), h('div', { class: 'co-rc-idtext' }, heading, subEl),
          h('span', { class: 'co-rc-badge' }, h('i', { class: 'co-dot is-ready', 'aria-hidden': 'true' }), 'Ready to launch')),
        h('div', { class: 'co-sum-pillrow' }, pills, fullLink),
        qaEl,
        h('div', { class: 'co-sum-gets' }, incl, thumb),
        h('div', { class: 'co-sum-price' }, h('p', { class: 'co-price' }, amt, per), h('small', null, 'Flat price · no per-answer fees · cancel anytime')),
        cta,
        h('div', { class: 'co-sum-links' },
          h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us'),
          h('span', { class: 'co-sep', 'aria-hidden': 'true' }, '·'),
          h('button', { type: 'button', class: 'co-link', onclick: () => { closeStage({ focus: false }); announce('Keep testing. Your bot is saved.'); focusBotComposer(); } }, 'Keep testing'),
          view),
        h('p', { class: 'co-trust' }, h('span', { html: icon('lock', 13) }), `Your files stay private to your bot. Saved for ${cfg().quota?.ttlDays || 7} days if you don't launch.`),
        more,
        h('p', { class: 'co-anchors' }, anchors())));
    el.append(card);
    cta.addEventListener('click', () => {
      const from = stage && stage.inst && stage.inst.receipt.isConnected ? stage.inst.receipt : card;
      openSheet({ source: 'card', from, invoker: cta });
    });
    view.addEventListener('click', () => {
      if (stage && stage.opener === view) { closeStage({ focus: false }); return; }
      if (inst.inline) { toggleInline(false); return; }
      if (canDock()) openStage({ from: card, opener: view, focus: true });
      else toggleInline(true);
    });
    function toggleInline(open) {
      if (open) {
        more.innerHTML = '';
        inst.inline = buildFullCard(more, { where: 'inline' });
        more.hidden = false;
        view.setAttribute('aria-controls', moreId); view.setAttribute('aria-expanded', 'true'); viewLabel.textContent = 'Hide receipt';
        if (!motion.reduced()) motion.animate(more, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'out' });
        announce(`Full receipt and plan for ${botName()} shown in the card.`, 'polite');
      } else {
        if (inst.inline) inst.inline.destroy();
        inst.inline = null;
        more.hidden = true; more.innerHTML = '';
        view.setAttribute('aria-expanded', 'false'); viewLabel.textContent = 'Receipt & plan';
      }
    }

    /** Fold to the stub (receipt panel open) or back. FLIP on the card height; instant with reduced motion. */
    function collapse(on, mode = 'receipt') {
      stubGo.textContent = mode === 'checkout' ? 'In checkout' : 'Receipt open';
      paintStubLabel(mode);
      if (!!inst.collapsed === !!on) return;
      inst.collapsed = !!on;
      const body = card.querySelector('.co-sum-body');
      const h0 = card.getBoundingClientRect().height;
      card.classList.toggle('is-collapsed', !!on);
      stub.hidden = !on; body.hidden = !!on;
      if (on) { const ae = document.activeElement; if (ae && body.contains(ae)) { try { stub.focus({ preventScroll: true }); } catch { /* ignore */ } } }
      if (motion.reduced() || !card.isConnected) return;
      const h1 = card.getBoundingClientRect().height;
      if (!h0 || !h1 || Math.abs(h0 - h1) < 2) return;
      motion.animate(card, [{ height: `${h0}px`, overflow: 'hidden' }, { height: `${h1}px`, overflow: 'hidden' }], { duration: motion.DUR[3], easing: 'inOut' });
      motion.animate(on ? stub : body, [{ opacity: 0, transform: on ? 'translateY(-4px)' : 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: on ? 80 : 120, easing: 'out', fill: 'backwards' });
    }
    function paintStubLabel(mode) {
      const st = stats();
      stub.setAttribute('aria-label', `${botName()}, ${st.tests && st.tests.total ? `${testsName(st.tests)} ${st.tests.passed} of ${st.tests.total} passed` : 'not tested yet'}, ${price().long}. ${mode === 'checkout' ? 'Checkout is open: go to the email field.' : 'Receipt and plan are open beside the Builder: go to them.'}`);
    }
    const inst = { el, card, receipt: card, cta, view, viewLabel, heading: card, chBtn, kind: 'summary', inline: null, collapsed: false, collapse, update: () => { paint(); if (inst.inline) inst.inline.update(); },
      destroy() { launchCards.delete(inst); ctaUnwatch(cta); if (inst.inline) inst.inline.destroy(); if (stage && stage.opener === view) closeStage({ focus: false }); } };
    launchCards.add(inst);
    ctaWatch(cta);
    function paint() {
      const st = stats();
      nameEl.textContent = botName();
      edit.setAttribute('aria-label', `Rename ${botName()} or edit its settings`);
      const org = getState().spec.org;
      subEl.textContent = `${org ? `for ${org} · ` : ''}${st.samples && st.samples === st.files ? 'built from sample files' : 'built from your files'}`;
      const qa = lastQA();
      if ((qa?.answerId || '') !== (qaEl.dataset.answer || '')) {
        qaEl.dataset.answer = qa?.answerId || '';
        qaEl.innerHTML = '';
        qaEl.hidden = !qa;
        if (qa) {
          const c = qa.cite;
          const chip = h('button', { type: 'button', class: 'co-cite', 'aria-label': `Citation 1: ${c.title || c.file}${c.seq != null ? `, atom ${c.seq}` : ''}. Opens the quoted source.` }, '1');
          chip.addEventListener('click', () => emit('drawer:open', { fileId: c.fileId, atomId: c.atomId ?? null, seq: c.seq ?? null, answerId: qa.answerId, n: c.n || 1 }));
          qaEl.append(
            h('figcaption', { class: 'co-qa-q' }, h('span', { class: 'co-qa-k' }, 'Q'), h('span', null, qa.question)),
            h('blockquote', { class: 'co-qa-a' }, h('span', { class: 'co-qa-k' }, 'A'), h('span', { class: 'co-sum-qa-t' }, qa.answer, NBSP, chip)),
            h('p', { class: 'co-qa-src' }, h('span', { class: 'co-qa-src-ico', html: icon('file', 12) }), h('span', null, [c.file || c.title || 'source', c.match != null ? `match ${c.match}` : null].filter(Boolean).join(' · '))));
        }
        thumb.replaceChildren(embedThumb(qa));
      }
      $('.co-cta-label', cta).textContent = `Launch ${botName()} · ${price().text}`;
      pills.innerHTML = '';
      const pill = (txt, cls = '') => h('span', { class: `co-pill${cls}` }, txt);
      const allPass = st.tests && st.tests.total && st.tests.passed === st.tests.total && !st.tests.unsupported;
      pills.append(pill(plural(st.files, 'file')), pill(`${mbOf(st.bytes)} of ${st.quotaMB} MB`), pill(plural(st.atoms, 'atom')),
        st.tests && st.tests.total ? pill(`${testsName(st.tests)} ${st.tests.passed}/${st.tests.total}`, allPass ? ' is-pass' : '') : pill('not tested yet'));
      pills.setAttribute('aria-label', `${plural(st.files, 'file')}, ${mbOf(st.bytes)} MB of ${st.quotaMB} MB, ${plural(st.atoms, 'atom')}${st.tests && st.tests.total ? `, ${testsName(st.tests)}: ${st.tests.passed} of ${st.tests.total} passed` : ', not tested yet'}`);
      fullLink.hidden = !(st.tests && st.tests.total && !st.tests.full);
      stubText.textContent = [botName(), st.tests && st.tests.total ? `${st.tests.passed}/${st.tests.total}` : 'not tested yet', price().text].join(' · ');
      paintStubLabel(stubGo.textContent === 'In checkout' ? 'checkout' : 'receipt');
      $$('.co-sum-head .co-ava', card).forEach((a) => { a.textContent = getState().spec.avatar?.initials || initialsOf(botName()); a.style.setProperty('--co-hue', hueVar()); });
    }
    paint();
    if (!motion.reduced()) motion.stagger([...card.querySelector('.co-sum-body').children].filter((n) => !n.hidden), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 45);
    if (focusNextCard) {
      focusNextCard = false;
      requestAnimationFrame(() => setTimeout(() => {
        if (!card.isConnected) return;
        try { card.focus({ preventScroll: true }); } catch { /* ignore */ }
        announce(`${botName()} is ready to launch, ${price().long}. Launch card in the Builder: Launch button, Receipt and plan, Keep testing.`, 'polite');
      }, motion.reduced() ? 0 : 120));
    }
    if (stage && !stage.closing) collapse(true);   // a newer card while the receipt panel is open: folded from the start
    if (autoStageNext) {
      autoStageNext = false;
      setTimeout(() => { if (card.isConnected && !stage && !sheet && canDock()) openStage({ from: card, opener: view, focus: false }); }, motion.reduced() ? 0 : 420);
    }
    return inst;
  }

  /** A 120 px embed thumbnail for the summary: browser bar, page skeleton, the bot's panel in its hue, launcher. */
  function embedThumb(qa = lastQA()) {
    return h('figure', { class: 'co-thumb', style: { '--co-hue': hueVar() }, 'aria-label': `Preview: ${botName()} as a chat widget on your site` , role: 'img' },
      h('div', { class: 'co-thumb-bar', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('span', null, 'yoursite.com')),
      h('div', { class: 'co-thumb-page', 'aria-hidden': 'true' },
        h('b'), h('i'), h('i', { class: 'is-short' }),
        h('div', { class: 'co-thumb-panel' },
          h('span', { class: 'co-thumb-head' }),
          h('span', { class: 'co-thumb-q' }, qa ? qa.question : ''),
          h('span', { class: 'co-thumb-a' }, qa ? qa.answer : getState().spec.greeting || ''),
          h('span', { class: 'co-thumb-src' }, qa ? `[1] ${qa.cite.file || qa.cite.title || ''}` : '')),
        h('span', { class: 'co-thumb-dot' })),
      h('figcaption', { class: 'co-thumb-cap', 'aria-hidden': 'true' }, 'On your site'));
  }

  // ---- LaunchStage: the wide two-column receipt + plan (spec B9). fixer r3 (D8): at ≥ 1100 px it docks over the
  // SampleBot pane (the Builder column, with the launch card and its CTA, stays fully usable beside it: nothing covers
  // the card). It opens by itself with a fresh launch card and on "Receipt & plan"; "Back to the live bot" closes it.
  // Narrower there is no stage: the full receipt expands inline inside the card.
  const canDock = () => !isMobile() && innerWidth >= 1100 && !!botPaneRect();

  function placeStage() {
    if (!stage) return;
    const r = canDock() ? botPaneRect() : null;
    if (!r) { closeStage({ focus: false }); return; }
    const L = stage.layer;
    L.style.left = `${Math.round(r.left)}px`; L.style.top = `${Math.round(r.top)}px`; L.style.width = `${Math.round(r.width)}px`; L.style.height = `${Math.round(r.height)}px`;
  }

  function openStage({ from = null, opener = null, focus = true } = {}) {
    if (stage) { stage.panel.focus({ preventScroll: true }); return stage; }
    const closeBtn = h('button', { type: 'button', class: 'co-btn co-btn-ghost is-small co-stage-x', 'aria-label': 'Close the receipt and go back to the live bot' }, h('span', { html: icon('x', 14) }), 'Back to the live bot');
    const head = h('div', { class: 'co-stage-head' },
      h('p', { class: 'co-eyebrow' }, h('span', { html: icon('rocket', 13) }), `${botName()} is ready to launch`),
      closeBtn);
    const holder = h('div', { class: 'co-stage-card' });
    // Phones: the plan sits below the receipt, so a sticky footer keeps the price and the CTA in reach while scrolling.
    const footCta = h('button', { type: 'button', class: 'co-cta' }, h('span', { class: 'co-cta-label' }, `Launch · ${price().text}`), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    const foot = h('div', { class: 'co-stage-foot' }, h('p', { class: 'co-stage-foot-price' }, h('span', null, h('b', null, `${price().sym}${price().amount}`), `/${price().per}`), h('small', null, 'cancel anytime')), footCta);
    const panel = h('section', { class: 'co-stage', id: 'co-stage', role: 'region', 'aria-label': `Launch ${botName()}: receipt and plan`, tabindex: '-1' }, head, holder, foot);
    footCta.addEventListener('click', () => openSheet({ source: 'card', from: stage?.inst?.receipt || null, invoker: footCta }));
    const layer = h('div', { class: 'co-stage-layer is-right', dataset: { kind: 'launch-stage' } }, h('div', { class: 'co-stage-backdrop', 'aria-hidden': 'true' }), panel);
    modal.append(layer);
    stage = { layer, panel, opener, cleanup: [], float: false, prevInert: null };
    placeStage();
    if (!stage) return null;
    // The covered SampleBot is taken out of the tab order while the receipt sits over it (restored on close).
    // CONTRACT-GAP (B): #st-bot is B's pane; only its inert flag is toggled, never its content.
    const botPane = document.getElementById('st-bot');
    if (botPane) {
      const was = botPane.inert;
      const hadFocus = botPane.contains(document.activeElement);
      botPane.inert = true;
      stage.cleanup.push(() => { botPane.inert = was; });
      if (hadFocus) focus = true;
    }
    stage.inst = buildFullCard(holder, { where: 'stage' });
    if (opener) { opener.setAttribute('aria-expanded', 'true'); const l = [...launchCards].find((c) => c.view === opener); if (l) l.viewLabel.textContent = 'Hide receipt'; }

    // keep it docked to the pane: window resizes, the drawer docking as a 3rd column, the spine changing height
    const onResize = () => placeStage();
    window.addEventListener('resize', onResize);
    stage.cleanup.push(() => window.removeEventListener('resize', onResize));
    const pane = document.getElementById('st-bot');
    if (pane && typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => placeStage()); ro.observe(pane); stage.cleanup.push(() => ro.disconnect()); }
    // fixer r4 (D8): the Builder card folds to a one-line stub underneath (no CTA, no anchors): the panel's sticky bar is
    // the only Launch button. It folds after the morph has measured the card (below).
    stage.cleanup.push(() => { if (foldForSheet) return; for (const c of launchCards) if (c.kind === 'summary' && c.collapse) c.collapse(false); });
    syncCtaFlag();
    const onKey = (e) => {
      if (sheet || !stage || stage.panel !== panel) return;
      if (e.key === 'Escape' && panel.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); closeStage({ focus: true }); }
    };
    document.addEventListener('keydown', onKey, true);
    stage.cleanup.push(() => document.removeEventListener('keydown', onKey, true));
    closeBtn.addEventListener('click', () => closeStage({ focus: true }));
    layer.querySelector('.co-stage-backdrop').addEventListener('click', () => closeStage({ focus: true }));

    // Morph: the stage grows out of the summary card (FLIP), then the full card assembles inside it.
    const fr = from && from.isConnected ? from.getBoundingClientRect() : null;
    const tr = panel.getBoundingClientRect();
    if (motion.reduced() || !fr || !tr.width) {
      motion.animate(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'out' });
    } else {
      const sx = Math.max(0.2, fr.width / tr.width), sy = Math.max(0.12, fr.height / tr.height);
      motion.animate(panel, [
        { transformOrigin: '0 0', transform: `translate(${fr.left - tr.left}px, ${fr.top - tr.top}px) scale(${sx}, ${sy})`, opacity: 0.35, borderRadius: '18px' },
        { transformOrigin: '0 0', transform: 'none', opacity: 1, borderRadius: '0px' },
      ], { duration: motion.DUR[3] + 140, easing: 'spring' });
      const bd = layer.querySelector('.co-stage-backdrop');
      motion.animate(bd, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[3], easing: 'out' });
    }
    for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(true);
    // Focus: a visitor who clicked into this moves with it; one typing in a composer is left alone.
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type !== 'button'));
    if (focus === true || (focus === 'auto' && !typing)) requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    announce(`Receipt and plan for ${botName()}, ${price().long}, shown over the bot pane. Back to the live bot closes it.`, 'polite');
    preloadGoLive();
    return stage;
  }

  function closeStage({ focus = false } = {}) {
    if (!stage) return;
    const s = stage; stage = null;
    for (const fn of s.cleanup.splice(0)) { try { fn(); } catch { /* ignore */ } }
    if (s.inst) launchCards.delete(s.inst);
    syncCtaFlag();
    const opener = s.opener && s.opener.isConnected ? s.opener : null;
    if (opener) { opener.setAttribute('aria-expanded', 'false'); const l = [...launchCards].find((c) => c.view === opener); if (l) l.viewLabel.textContent = 'Receipt & plan'; }
    const hadFocus = s.layer.contains(document.activeElement);
    const to = opener ? opener.closest('.co-launch')?.getBoundingClientRect() : null;
    const pr = s.panel.getBoundingClientRect();
    s.layer.style.pointerEvents = 'none';
    const kf = !motion.reduced() && to && pr.width
      ? [{ transformOrigin: '0 0', transform: 'none', opacity: 1 }, { transformOrigin: '0 0', transform: `translate(${to.left - pr.left}px, ${to.top - pr.top}px) scale(${Math.max(0.2, to.width / pr.width)}, ${Math.max(0.12, to.height / pr.height)})`, opacity: 0 }]
      : [{ opacity: 1 }, { opacity: 0 }];
    const a = motion.animate(s.panel, kf, { duration: motion.reduced() ? 120 : motion.DUR[3], easing: 'inOut', fill: 'forwards' });
    motion.animate(s.layer.querySelector('.co-stage-backdrop'), [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[2], fill: 'forwards' });
    Promise.resolve(a && a.finished).catch(() => {}).then(() => s.layer.remove());
    setTimeout(() => s.layer.remove(), 900);
    if (focus && opener) opener.focus({ preventScroll: true });
    else if (hadFocus && opener) opener.focus({ preventScroll: true });
  }

  /** EmbedPreview: a 280 px browser mock in the bot's hue, answering the receipt's Q&A. Pure HTML/CSS. */
  function embedPreview(qa) {
    const s = getState().spec;
    const greet = s.greeting || `Hi! Ask me anything about ${s.org || s.name || 'us'}.`;
    const label = qa ? `Preview: ${botName()} on yoursite.com, answering “${qa.question}” with a citation.` : `Preview: ${botName()} on yoursite.com.`;
    return h('div', { class: 'co-embed', role: 'img', 'aria-label': label, style: { '--co-hue': hueVar() } },
      h('div', { class: 'co-embed-bar', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('span', { class: 'co-embed-url' }, h('span', { html: icon('lock', 9) }), 'yoursite.com')),
      h('div', { class: 'co-embed-page', 'aria-hidden': 'true' },
        h('div', { class: 'co-embed-skel' }, h('b'), h('i'), h('i'), h('i', { class: 'is-short' })),
        h('div', { class: 'co-embed-panel' },
          h('div', { class: 'co-embed-head' }, h('span', { class: 'co-embed-ava' }, s.avatar?.initials || initialsOf(s.name)), h('span', { class: 'co-embed-name' }, botName()), h('span', { class: 'co-embed-on' }, 'online')),
          h('div', { class: 'co-embed-msgs' },
            h('p', { class: 'co-em is-bot' }, greet),
            qa ? h('p', { class: 'co-em is-user' }, qa.question) : null,
            qa ? h('p', { class: 'co-em is-bot is-ans' }, qa.answer, h('sup', { class: 'co-em-cite' }, '1')) : null,
            qa ? h('p', { class: 'co-em-src' }, `[1] ${qa.cite.file || qa.cite.title || ''}`) : null)),
        h('span', { class: 'co-embed-launcher' }, h('span', { html: icon('chat', 14) }))));
  }
  // fixer r4 (D8): the preview is never an empty widget. Every message (greeting, question, the cited answer, its
  // source) is on screen from the first frame; only the launcher pops in, and once the card's entrance has settled a
  // typing caret blinks twice after the answer (CSS, none with reduced motion).
  function playEmbed(wrap, signal) {
    if (motion.reduced()) return;
    const launcher = $('.co-embed-launcher', wrap);
    motion.animate(launcher, [{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: .6 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'out', signal });
  }
  function caretEmbed(wrap) {
    if (motion.reduced() || !wrap || !wrap.isConnected) return;
    const e = $('.co-embed', wrap);
    if (!e) return;
    e.classList.remove('is-caret'); void e.offsetWidth; e.classList.add('is-caret');
  }

  // ---- make it yours (B9)
  function renderMakeItYours(el) {
    const files = enabledFiles();
    const list = h('ul', { class: 'co-miy-files' }, files.slice(0, 5).map((f) => h('li', { style: { '--co-hue': `var(--f${(f.hue ?? 0) % 8})` } },
      h('span', { class: 'co-miy-ico', html: icons.fileIcon(f.kind, 14) }), h('span', { class: 'co-miy-name' }, f.name), f.sample ? h('span', { class: 'co-miy-tag' }, 'sample') : h('span', { class: 'co-miy-tag is-own' }, 'yours'))));
    const drop = h('button', { type: 'button', class: 'co-miy-drop' },
      h('span', { class: 'co-miy-drop-ico', html: icon('upload', 18) }),
      h('span', { class: 'co-miy-drop-text' }, h('b', null, 'Add one of your own docs'), h('small', null, 'PDF, DOCX, PPTX, XLSX, HTML, MD, TXT · your settings stay')));
    drop.addEventListener('click', () => { emit('intake:pick', {}); });
    const card = h('div', { class: 'co-miy', role: 'group', 'aria-label': 'Make it yours' },
      h('div', { class: 'co-miy-head' }, h('span', { class: 'co-miy-badge', html: icon('flask', 14) }), h('span', null, h('b', null, `${botName()} only knows sample files`), h('small', null, `${plural(files.length, 'file')} · removed when you launch`))),
      list, drop);
    el.append(card);
    motion.stagger($$('li', list), [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 50);
    return { update() {}, destroy() {} };
  }

  registerCard('launch', renderLaunchCard);

  // ---- launch:open (6.4)
  let launching = false;
  async function onLaunchOpen(d = {}) {
    if (launching) return;
    const s = getState();
    if (s.trial.status === 'expired') return;
    if (s.trial.converted || s.milestones.launched) { postSuccess({ burst: false }); return; }
    // Integrator r5: only a deliberate pick (header pill, palette, a Launch chip, force) switches the mobile tab. A typed
    // Builder turn ("how much to go live?") resolves after the reply; by then the person may have moved to the bot tab
    // to ask questions, and yanking them back hid the starters (smoke 04/05 on mobile). The Builder tab badge tells them.
    if (isMobile() && (d.source !== 'setup' || d.force)) emit('tab:show', { tab: 'setup' });
    const fromServerTurn = d.source === 'setup' && !!s.setup?.busy;   // the server reply already carries the Builder line
    // A click (header pill, palette, a Launch chip) moves focus with it; a typed Builder turn leaves focus in the composer.
    const ae = document.activeElement;
    const userPick = d.source === 'header' || d.source === 'palette' || d.source === 'chip' || !!d.force || ae?.id === 'st-price'
      || (!fromServerTurn && !!(ae && ae.closest && ae.closest('.st-chip')));
    // A card is already on screen: header/palette go straight to checkout; anything else re-points at the card.
    const live = [...launchCards].filter((c) => c.el.isConnected && c.kind !== 'stage' && c.kind !== 'inline').pop();
    if (live) {
      live.update();
      const r = live.el.getBoundingClientRect();
      const vis = (r.bottom > 0 && r.top < innerHeight && (!isMobile() || getState().ui.tab === 'setup')) || !!stage;
      const from = stage && stage.inst ? stage.inst.receipt : live.receipt;
      if (vis && (d.source === 'header' || d.source === 'palette' || d.source === 'chip')) { openSheet({ source: d.source, from, invoker: document.activeElement }); return; }
      const nearBottom = live.el.closest('[data-card]')?.nextElementSibling == null;
      if (vis || nearBottom || userPick) {
        // fixer r2 (D8/D9): never an overlay over the bot; scroll to the card, pulse it, and move focus to its heading.
        live.el.scrollIntoView({ behavior: motion.reduced() ? 'auto' : 'smooth', block: 'nearest' });
        pulseCard(live.card);
        if (userPick && !stage && live.view && canDock()) openStage({ from: live.card, opener: live.view, focus: false });
        if (userPick && live.heading) {
          setTimeout(() => { try { live.heading.focus({ preventScroll: true }); } catch { /* ignore */ } }, motion.reduced() ? 0 : 260);
          announce(`${botName()} is ready to launch, ${price().long}. Launch card in the Builder.`, 'polite');
        }
        return;
      }
    }
    // Make it yours: every enabled file is a sample and the visitor hasn't chosen "anyway".
    if (sampleOnly() && !d.force) {
      emit('setup:post', { role: 'assistant',
        text: `One last thing: right now ${botName()} only knows our sample files. Drop one of your own docs and I'll keep all your settings. Sample files are removed when you launch.`,
        card: { type: 'launch', data: { variant: 'make-it-yours' } },
        chips: [
          { id: 'add-own', label: 'Add my own files', kind: 'primary', action: { type: 'request_upload' }, local: true },
          { id: 'launch-anyway', label: 'Launch with samples anyway', action: { type: 'show_launch', force: true }, local: true },
        ] });
      return;
    }
    if (!enabledFiles().length) {
      emit('setup:post', { role: 'assistant', text: `${botName()} needs at least one file before it can launch. Add one and I'll test it for you.`, chips: [
        { id: 'upload', label: 'Upload my files', kind: 'primary', action: { type: 'request_upload' }, local: true },
        { id: 'samples', label: 'Use sample files', action: { type: 'attach_samples', set: 'lumen-bikes' }, local: true },
      ] });
      return;
    }
    launching = true;
    try {
      // Mini proof first so the card always shows real stats (3 in-scope + 1 probe, about 6 s).
      if (!getState().milestones.proofRun && getState().proof?.status !== 'done' && readyFiles().length) {
        const done = new Promise((resolve) => {
          const un = on('proof:done', () => { un(); resolve(true); });
          setTimeout(() => { un(); resolve(false); }, MINI_PROOF_WAIT);
        });
        if (getState().proof?.status !== 'running') emit('proof:run', { mini: true });
        await done;
      }
      const showText = !fromServerTurn;
      focusNextCard = userPick;
      autoStageNext = true;
      emit('setup:post', { role: 'assistant',
        text: showText ? `${botName()} is built and saved. Launch it to get a hosted link and embed code in under a minute.` : '',
        card: { type: 'launch', data: { variant: 'launch' } },
        chips: showText ? [
          // Launch + Keep testing are on the summary card itself; the chips offer the next questions instead.
          { id: 'what-get', label: 'What do I get?', send: 'What do I get?' },
          { id: 'co-channels', label: 'Channels & API', local: true, run: () => openGoLive({ tab: 'channels' }) },
        ] : null });
      mark('launchShown');
      preloadGoLive();
    } finally { launching = false; }
  }
  sub('launch:open', (d) => { onLaunchOpen(d || {}); });
  /** Two accent rings out of the card (transform-free box-shadow; a single static ring in reduced motion). */
  function pulseCard(card) {
    if (!card) return;
    if (motion.reduced()) { card.classList.add('is-ping'); clearTimeout(card._ping); card._ping = setTimeout(() => card.classList.remove('is-ping'), 1400); return; }
    motion.animate(card, [
      { boxShadow: '0 0 0 0 var(--accent-soft)' }, { boxShadow: '0 0 0 7px var(--accent-soft)', offset: .3 }, { boxShadow: '0 0 0 0 transparent', offset: .5 },
      { boxShadow: '0 0 0 6px var(--accent-soft)', offset: .78 }, { boxShadow: '0 0 0 0 transparent' },
    ], { duration: 1100, easing: 'out', essential: false });
  }

  // ================================================================== CheckoutSheet (B10)


  // fixer r4 (D8): the sheet carries the compact receipt only (one line + the cited Q&A). The full receipt grid lives in
  // one place (the receipt panel / the inline expansion), never repeated here.
  function sheetReceipt() {
    const st = stats();
    const pr = price();
    const qa = lastQA();
    const tests = st.tests && st.tests.total ? `${testsName(st.tests)} ${st.tests.passed}/${st.tests.total}` : 'not tested yet';
    const one = [plural(st.files, 'file'), `${mbOf(st.bytes)} MB`, plural(st.atoms, 'atom'), tests].join(' · ');
    const full = st.tests && st.tests.total && !st.tests.full
      ? h('p', { class: 'co-sr-quick' }, h('span', { html: icon('flask', 13) }),
        h('span', null, `Only the ${st.tests.total}-question quick check has run. `,
          h('button', { type: 'button', class: 'co-link', onclick: () => { closeSheet('proof'); runFullProof(); } }, `Run the full Proof Run (${FULL_PROOF_N}) first`)))
      : null;
    return h('section', { class: 'co-sr-receipt', 'aria-label': `Your KnowBot: ${botName()}, ${one}, ${pr.text}` },
      h('div', { class: 'co-sr-line' }, avatar(32),
        h('p', { class: 'co-oneline' }, h('b', { class: 'co-oneline-name' }, botName()), h('span', null, one))),
      full,
      qa ? sheetQA(qa) : null);
  }

  /** The receipt's proof: Q, the cited one-line answer and a working [1] (the drawer sits behind the modal, so the
   *  chip expands the quoted source line in place). */
  function sheetQA(qa) {
    const c = qa.cite || {};
    const exId = `co-sr-ex-${Math.random().toString(36).slice(2, 7)}`;
    const ex = h('p', { class: 'co-sr-ex', id: exId, hidden: true },
      h('span', { class: 'co-qa-src-ico', html: icon('file', 12) }),
      h('span', null, h('b', null, [c.file || c.title || 'source', c.locator].filter(Boolean).join(' · ')), c.excerpt ? h('q', null, String(c.excerpt).replace(/\s+/g, ' ').slice(0, 220)) : null));
    const chip = h('button', { type: 'button', class: 'co-cite', 'aria-expanded': 'false', 'aria-controls': exId, 'aria-label': `Citation 1: ${c.title || c.file || 'source'}. Shows the quoted line.` }, '1');
    chip.addEventListener('click', () => {
      const open = ex.hidden; ex.hidden = !open; chip.setAttribute('aria-expanded', String(open));
      if (open) motion.animate(ex, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
    });
    return h('figure', { class: 'co-sr-qa' },
      h('figcaption', { class: 'co-qa-q' }, h('span', { class: 'co-qa-k' }, 'Q'), h('span', null, qa.question)),
      h('blockquote', { class: 'co-qa-a' }, h('span', { class: 'co-qa-k' }, 'A'), h('span', null, qa.answer, NBSP, chip)),
      ex);
  }

  async function openSheet({ source = 'card', from = null, invoker = null } = {}) {
    if (sheet) { sheet.email?.focus(); return; }
    preloadGoLive();
    // fixer r4 (D8, blocker): desktop checkout is a 440 px sheet on the right, over the SampleBot pane, with the bot thread
    // unblurred beside it (a light, blur-free scrim). The receipt panel closes first, so the receipt exists once.
    const side = !isMobile();
    if (side && stage) { foldForSheet = true; try { closeStage({ focus: false }); } finally { foldForSheet = false; } from = null; }
    // the Builder card stays folded to its one-line stub while checkout is open: the receipt exists once, in the sheet
    if (side) for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(true, 'checkout');
    const pr = price();
    const t = getState().trial;
    const receipt = sheetReceipt();
    const emailIn = h('input', { type: 'email', id: 'co-email', name: 'email', class: 'co-input', autocomplete: 'email', inputmode: 'email', spellcheck: 'false', required: true,
      'aria-describedby': 'co-email-hint', placeholder: 'you@company.com' });
    emailIn.value = t.email || '';
    const emailErr = h('p', { class: 'co-field-err', id: 'co-email-err', hidden: true });
    const submit = h('button', { type: 'submit', class: 'co-cta co-cta-lg' }, h('span', { class: 'co-spin', 'aria-hidden': 'true' }), h('span', { class: 'co-cta-label' }, `Continue to secure checkout · ${pr.text}`), h('span', { class: 'co-cta-ico', html: icon('lock', 15) }));
    const errBox = h('div', { class: 'co-err', role: 'alert', hidden: true });
    const form = h('form', { class: 'co-form', novalidate: true },
      h('label', { class: 'co-label', for: 'co-email' }, 'Email for your KnowDrive login'),
      emailIn,
      h('p', { class: 'co-hint', id: 'co-email-hint' }, 'We send your login and your bot link here. No other field.'),
      emailErr, submit, errBox);
    const back = h('button', { type: 'button', class: 'co-link co-back' }, h('span', { html: icon('arrowRight', 14), class: 'co-back-ico' }), 'Back to my bot');
    const x = h('button', { type: 'button', class: 'co-x', 'aria-label': 'Close and go back to my bot', html: icon('x', 18) });
    const pay = h('section', { class: 'co-pay' },
      h('p', { class: 'co-eyebrow' }, h('span', { html: icon('rocket', 13) }), 'Launch'),
      h('h2', { class: 'co-sheet-title', id: 'co-sheet-title' }, `Launch ${botName()}`),
      h('p', { class: 'co-sheet-desc', id: 'co-sheet-desc' }, h('b', null, `KnowDrive · ${pr.long}`), '. You finish on KnowDrive\'s secure checkout, then come straight back here.'),
      form,
      h('p', { class: 'co-foot co-foot-incl' }, h('span', { html: icon('check', 13) }), `Includes hosting + embed, 6 channels + the chat API, ${stats().quotaMB} MB of storage, question insights.`),
      h('p', { class: 'co-foot' }, `Today: ${pr.today} · renews monthly · cancel anytime. Your bot, files and tests carry over. Nothing gets rebuilt.`),
      h('p', { class: 'co-foot co-foot-trust' }, h('span', { html: icon('lock', 12) }), `Saved for ${cfg().quota?.ttlDays || 7} days if you don't launch. `, h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us')),
      back);
    const dialog = h('div', { class: 'co-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'co-sheet-title', 'aria-describedby': 'co-sheet-desc' }, x, receipt, pay);
    const scrim = h('div', { class: 'co-scrim', 'aria-hidden': 'true' });
    // fixer r3 (D8): spec B10. Desktop: centered 880 px, receipt left (stats, the cited answer, every inclusion), form
    // right, over a 60% scrim with a 2 px blur. Phones: full screen, the one-line receipt on top, no floating duplicate.
    const peek = null;
    const layer = h('div', { class: `co-layer${side ? ' is-side' : ''}`, dataset: { kind: 'checkout' } }, scrim, dialog);
    const ae0 = document.activeElement;
    sheet = { layer, dialog, scrim, peek, receipt, email: emailIn, invoker: invoker || (ae0 && ae0 !== document.body ? ae0 : null), redirecting: false, prevInert: slots.app ? slots.app.inert : false, source, side };
    const dockFrom = () => (side ? 'translateX(56px)' : isMobile() ? 'translateY(48px)' : 'translateY(14px) scale(.98)');

    // Shared-element morph: LaunchCard receipt → sheet receipt (view-transition-name: launch-receipt).
    const fromEl = !side && from && from.isConnected ? from : null;
    const r = fromEl ? fromEl.getBoundingClientRect() : null;
    const fromVisible = r && r.bottom > 0 && r.top < innerHeight;
    const vtNative = typeof document.startViewTransition === 'function' && !motion.reduced() && fromVisible && !document.documentElement.dataset.vtBusy;
    if (fromVisible) fromEl.style.viewTransitionName = 'launch-receipt';
    const insert = () => {
      if (fromEl) fromEl.style.viewTransitionName = '';
      receipt.style.viewTransitionName = 'launch-receipt';
      modal.append(layer);
      if (slots.app) slots.app.inert = true;
      setState({ ui: { ...getState().ui, sheet: 'checkout' } }, 'sheet:checkout');
      // focus lands with the dialog, not after the morph finishes (a slow view transition must not leave focus behind)
      try { emailIn.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
    };
    if (fromVisible) {
      if (!vtNative) {
        motion.animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[3], easing: 'out' });
        motion.animate(pay, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: 80, easing: 'out', fill: 'backwards' });
      }
      if (!motion.reduced()) motion.animate(dialog, [{ transform: dockFrom() }, { transform: 'none' }], { duration: motion.DUR[3] + 60, easing: 'spring', essential: false });
      // User-initiated: not queued behind the director (a running signature is fast-forwarded instead).
      if (motion.director.busy()) motion.director.skip();
      await Promise.race([motion.viewTransition(insert, { name: 'launch-receipt', el: fromEl, target: () => receipt }), sleep(1500)]);
      if (!layer.isConnected) insert();
    } else {
      if (motion.director.busy()) motion.director.skip();
      insert();
      motion.animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[3], easing: 'out' });
      motion.animate(dialog, [{ opacity: 0, transform: dockFrom() }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3] + (side ? 80 : 0), easing: 'spring' });
      // the sheet's content settles in after the panel: receipt line, Q&A, then the form (one purposeful cascade)
      if (side && !motion.reduced()) motion.stagger([...receipt.children, ...pay.children], [{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], delay: 90, easing: 'out', fill: 'backwards' }, 32);
    }
    syncCtaFlag();
    receipt.style.viewTransitionName = '';
    requestAnimationFrame(() => { emailIn.focus(); if (emailIn.value) emailIn.select(); });
    announce(`Checkout for ${botName()}, ${pr.long}. Email field.`, 'polite');

    // events
    scrim.addEventListener('click', () => closeSheet('scrim'));
    x.addEventListener('click', () => closeSheet('close'));
    back.addEventListener('click', () => closeSheet('back'));
    // Captured at the document so Esc/Tab work even when focus fell to <body> (e.g. a clicked node was re-rendered).
    const onKey = (e) => {
      if (!sheet || sheet.layer !== layer) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!sheet.redirecting) closeSheet('esc'); }
      else if (e.key === 'Tab') trap(e, dialog);
    };
    document.addEventListener('keydown', onKey, true);
    sheet.offKey = () => document.removeEventListener('keydown', onKey, true);
    emailIn.addEventListener('input', () => { if (!emailErr.hidden) validate(false); });
    form.addEventListener('submit', (e) => { e.preventDefault(); go(); });

    function validate(focus) {
      const v = emailIn.value.trim();
      let msg = '';
      if (!v) msg = 'Enter an email so we can send your KnowDrive login.';
      else if (v.length > 254 || !EMAIL_RE.test(v)) msg = "That email doesn't look right. Check for a typo.";
      emailErr.textContent = msg; emailErr.hidden = !msg;
      emailIn.setAttribute('aria-invalid', msg ? 'true' : 'false');
      emailIn.setAttribute('aria-describedby', msg ? 'co-email-err co-email-hint' : 'co-email-hint');
      if (msg && focus) { emailIn.focus(); motion.animate(emailIn, [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 320, essential: false }); }
      return !msg;
    }
    async function go() {
      if (sheet?.redirecting) return;
      if (!validate(true)) return;
      errBox.hidden = true; errBox.innerHTML = '';
      const email = emailIn.value.trim();
      sheet.redirecting = true;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.classList.add('is-busy');
      $('.co-cta-label', submit).textContent = 'Opening KnowDrive checkout…';
      announce('Opening KnowDrive checkout…', 'polite');
      try {
        // The server's /checkout flushes the spec doc (PATCH state) and stores the email before it returns the URL.
        // CONTRACT-GAP: SPEC 6.4 step 1 also emits spec:request {email}; B's drawer would render that as a ConfigDiffCard
        // in the middle of a redirect, and /checkout already persists the email, so it is not emitted here.
        const r = await api.checkout({ email });
        if (!r || !r.url) throw new Error('no url');
        try { store.persist(); } catch { /* ignore */ }
        await sleep(motion.reduced() ? 0 : 120);
        location.assign(r.url);
      } catch (err) {
        sheet.redirecting = false;
        submit.disabled = false; submit.removeAttribute('aria-busy'); submit.classList.remove('is-busy');
        $('.co-cta-label', submit).textContent = `Continue to secure checkout · ${pr.text}`;
        if (err && err.status === 400 && /email/i.test(err.message || '')) { emailErr.textContent = err.message; emailErr.hidden = false; emailIn.setAttribute('aria-invalid', 'true'); emailIn.focus(); return; }
        const retry = h('button', { type: 'button', class: 'co-btn co-btn-ghost is-small' }, h('span', { html: icon('refresh', 14) }), 'Try again');
        retry.addEventListener('click', () => go());
        const wait = err && err.status === 429 && err.retryAfter ? ` Try again in ${err.retryAfter}s.` : '';
        errBox.append(h('span', { class: 'co-err-ico', html: icon('warn', 15) }), h('span', null, `Couldn't open checkout. Your bot is safe.${wait}`), retry);
        errBox.hidden = false;
        motion.animate(errBox, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2] });
      }
    }
  }

  function trap(e, root) {
    const f = $$('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  let lastDismissAt = 0;
  function closeSheet(reason = 'close') {
    if (!sheet) return;
    const s = sheet; sheet = null;
    if (s.offKey) s.offKey();
    syncCtaFlag();
    if (s.side && reason !== 'redirect') for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(false);
    if (slots.app) slots.app.inert = !!s.prevInert;
    setState({ ui: { ...getState().ui, sheet: null } }, 'sheet:close');
    const out = [
      motion.animate(s.scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[2], fill: 'forwards' }),
      motion.animate(s.dialog, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: s.side ? 'translateX(48px)' : isMobile() ? 'translateY(40px)' : 'translateY(10px) scale(.985)' }], { duration: motion.DUR[2], easing: 'inOut', fill: 'forwards' }),
      s.peek ? motion.animate(s.peek, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[1] || 120, fill: 'forwards' }) : null,
    ];
    Promise.all(out.map((a) => a && a.finished)).catch(() => {}).then(() => s.layer.remove());
    setTimeout(() => s.layer.remove(), 700);   // never leave a dead layer behind if an animation is starved
    // Focus goes back to the invoker; if it is gone (a re-rendered chip, the palette) the newest launch card's CTA, then
    // the header Launch button, then the Builder composer. Never <body>.
    const usable = (n) => n && n !== document.body && n.isConnected && !n.closest('[inert]') && n.getClientRects().length > 0;
    const inv = [s.invoker, [...launchCards].filter((c) => c.el.isConnected && c.kind === 'summary').pop()?.cta, document.getElementById('st-price'), document.getElementById('st-setup-composer')].find(usable);
    if (inv) { try { inv.focus({ preventScroll: false }); } catch { /* ignore */ } }
    if (reason !== 'redirect' && reason !== 'proof') {
      announce(`${botName()} is saved for ${cfg().quota?.ttlDays || 7} days.`, 'polite');
      // One Builder "no problem, it's saved" turn per visit, not one per close (repeat closes read as nagging).
      if (Date.now() - lastDismissAt > 120000) emit('checkout:dismissed', {});
      lastDismissAt = Date.now();
    }
  }

  // ================================================================== Return / Live (B11)

  let activatingKey = null, pollGen = 0;
  const cardInst = { activating: null, success: null };

  registerCard('activating', (data, el) => {
    const title = h('b', { class: 'co-act-title' });
    const text = h('p', { class: 'co-act-text' });
    const meter = h('div', { class: 'co-act-meter', role: 'progressbar', 'aria-label': 'Checking with KnowDrive', 'aria-valuemin': '0', 'aria-valuemax': '20' }, h('i'));
    const skel = h('div', { class: 'co-act-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i', { class: 'is-short' }));
    // fixer r2 (D8): the pending state lives in this one card (replaced in place), with its own next actions; no
    // duplicate Builder turn repeating the same sentence.
    const again = h('button', { type: 'button', class: 'co-btn co-btn-primary is-small' }, h('span', { html: icon('refresh', 14) }), 'Check again');
    again.addEventListener('click', () => pollConversion());
    const keep = h('button', { type: 'button', class: 'co-btn co-btn-ghost is-small' }, 'Keep testing');
    keep.addEventListener('click', () => focusBotComposer());
    const acts = h('div', { class: 'co-act-actions', hidden: true }, again, keep);
    const card = h('div', { class: 'co-act', role: 'status' },
      h('div', { class: 'co-act-head' }, h('span', { class: 'co-act-ico', html: icon('rocket', 16) }), h('div', null, title, text)), meter, skel, acts);
    el.append(card);
    function update(d = {}) {
      const st = d.state || 'checking';
      card.dataset.state = st;
      acts.hidden = st !== 'pending';
      if (st === 'checking') { title.textContent = `Activating ${botName()}…`; text.textContent = `Checking with KnowDrive · ${Math.round((d.elapsed || 0) / 1000)}s`; meter.setAttribute('aria-valuenow', String(Math.round((d.elapsed || 0) / 1000))); meter.hidden = false; skel.hidden = false; }
      else if (st === 'pending') { title.textContent = 'Payment received? We\'re finishing setup.'; text.textContent = 'Check your email for your KnowDrive login. Your bot is saved either way.'; meter.hidden = true; skel.hidden = true; }
      else if (st === 'done') { title.textContent = 'Payment confirmed'; text.textContent = `${botName()} moved to your KnowDrive account.`; meter.hidden = true; skel.hidden = true; card.querySelector('.co-act-ico').innerHTML = icon('checkCircle', 16); }
      const fill = meter.firstElementChild;
      fill.style.transform = `scaleX(${Math.min(1, (d.elapsed || 0) / POLL_FOR_MS)})`;
    }
    update(data);
    const inst = { update, destroy() { if (cardInst.activating === inst) cardInst.activating = null; } };
    cardInst.activating = inst;
    return inst;
  });

  registerCard('success', (data, el) => {
    const base = siteBase();
    const botId = data.botId || getState().trial.id || 'your-bot';
    const botUrl = data.botUrl || shareUrl(botId);
    const apiBase = api.BASE || location.origin;
    const embed = data.embed || `<script type="module" src="${base}lib/embed.js" data-instance="${botId}" data-api="${apiBase}"></script>`;
    const dash = data.dashboardUrl || 'https://knowdrive.ai/';
    const dot = h('span', { class: 'co-live-dot', 'aria-hidden': 'true' }, h('i'), h('i'));
    const code = h('pre', { class: 'co-code', tabindex: '0', 'aria-label': 'Embed snippet' }, h('code', null, embed));
    const card = h('div', { class: 'co-success' },
      h('div', { class: 'co-success-head' }, dot, h('div', null, h('b', null, `${botName()} is live`), h('small', null, 'Hosted, embeddable and answering only from your files'))),
      h('div', { class: 'co-row' }, h('span', { class: 'co-row-k' }, 'Hosted link'), h('a', { class: 'co-row-v co-mono', href: botUrl, target: '_blank', rel: 'noopener' }, botUrl.replace(/^https?:\/\//, '')), copyButton(botUrl, 'Copy', { small: true, what: 'Link copied', aria: 'Copy hosted link' })),
      data.ownFiles === 0 ? h('div', { class: 'co-success-empty', role: 'note' },
        h('span', { class: 'co-success-empty-ico', html: icon('upload', 16) }),
        h('div', null, h('b', null, 'Sample files were removed at launch'), h('small', null, `${botName()} keeps your settings, tests and tone. Add your docs and it starts answering from them.`)),
        h('button', { type: 'button', class: 'co-btn co-btn-primary is-small', onclick: () => addOwnFiles() }, h('span', { html: icon('upload', 14) }), 'Add your files')) : null,
      h('div', { class: 'co-codewrap' }, h('div', { class: 'co-code-head' }, h('span', null, 'Embed on your site'), copyButton(embed, 'Copy embed', { small: true, what: 'Embed code copied' })), code),
      h('div', { class: 'co-success-actions' },
        h('a', { class: 'co-btn co-btn-primary', href: dash, target: '_blank', rel: 'noopener' }, 'Open KnowDrive dashboard', h('span', { html: icon('external', 14) })),
        h('button', { type: 'button', class: 'co-btn co-btn-ghost', onclick: (e) => openGoLive({ tab: 'channels', invoker: e.currentTarget }) }, h('span', { html: icon('phone', 14) }), 'Set up channels'),
        h('button', { type: 'button', class: 'co-btn co-btn-ghost', onclick: (e) => openGoLive({ tab: 'developers', invoker: e.currentTarget }) }, h('span', { html: icon('code', 14) }), 'Developer API')));
    el.append(card);
    const inst = { el, card, dot, embed, update() {}, destroy() { if (cardInst.success === inst) cardInst.success = null; } };
    cardInst.success = inst;
    if (!motion.reduced()) {
      motion.stagger([...card.children], [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], easing: 'out', fill: 'backwards' }, 60);
    }
    return inst;
  });

  function siteBase() {
    // The studio is served at <site>/studio/; lib/embed.js lives at <site>/lib/.
    return `${location.origin}${location.pathname.replace(/\/studio(?:\/.*)?$/, '/')}`.replace(/\/?$/, '/');
  }
  // CONTRACT-GAP: getTrial() does not return the hosted bot URL after conversion (KnowDrive owns bot creation, SPEC 4.10).
  // Until it does (data.botUrl), the hosted chat page for the bot id is used.
  function shareUrl(botId) { return `${siteBase()}demo/chat.html?instance=${encodeURIComponent(botId)}`; }

  function postSuccess({ burst = true, data = {} } = {}) {
    closeStage({ focus: false });
    if (cardInst.success && cardInst.success.el.isConnected) { cardInst.success.el.scrollIntoView({ behavior: motion.reduced() ? 'auto' : 'smooth', block: 'nearest' }); return; }
    const own = ownFilesAfterLaunch(data);
    data = { ...data, ownFiles: own };
    // CONTRACT-GAP (B): on converted, B's header still shows the price/trial pills, C's ghost answer returns and the Builder
    // offers "Use sample files". Expected: header shows "Live", no ghost, Builder chips = these three. This turn's chips
    // are the post-launch next actions so the conversation itself stops selling.
    const empty = own === 0;
    emit('setup:post', { role: 'assistant', text: empty ? `${botName()} is live. The sample files were removed at launch, so add your docs and it starts answering from them.` : `${botName()} is live. Next: paste this snippet on your site.`,
      card: { type: 'success', data },
      chips: [
        empty ? { id: 'co-add', label: 'Add your files', kind: 'primary', local: true, run: addOwnFiles } : null,
        { id: 'co-copy-embed', label: 'Copy embed code', kind: empty ? undefined : 'primary', local: true, run: async () => { const ok = await copyText(cardInst.success?.embed || ''); emit('toast', { kind: ok ? 'info' : 'warn', text: ok ? 'Embed code copied' : 'Copy failed. Select the snippet and copy it.' }); } },
        empty ? null : { id: 'co-add', label: 'Add more files', local: true, run: addOwnFiles },
        { id: 'co-open', label: 'Open KnowDrive', local: true, run: () => window.open(data.dashboardUrl || 'https://knowdrive.ai/', '_blank', 'noopener') },
      ].filter(Boolean) });
    mark('launched');
    announce(`${botName()} is live.`, 'polite');
    if (burst) setTimeout(() => liveBurst(cardInst.success?.dot), 120);
  }

  /** Own (non-sample) files the live bot kept. Samples are deleted on conversion (SPEC 4.10).
   *  CONTRACT-GAP (A): GET /trials/:id does not return convertedFiles; read it when present, else infer from the store. */
  function ownFilesAfterLaunch(data = {}) {
    if (typeof data.convertedFiles === 'number') return data.convertedFiles;
    const isSample = (f) => !!(f && (f.sample || (f.tags || []).some((t) => String(t).startsWith('sample:'))));
    const fs = enabledFiles();
    if (fs.length) return fs.filter((f) => !isSample(f)).length;
    if (Array.isArray(data.files)) return data.files.filter((f) => !isSample(f)).length;
    return null;
  }
  function addOwnFiles() {
    if (isMobile()) emit('tab:show', { tab: 'bot' });
    emit('intake:pick', {});
  }

  async function pollConversion() {
    const gen = ++pollGen;
    const t0 = Date.now();
    if (!cardInst.activating || !cardInst.activating.update) {
      emit('setup:post', { role: 'assistant', text: '', card: { type: 'activating', data: { state: 'checking', elapsed: 0 } }, scroll: true });
    } else cardInst.activating.update({ state: 'checking', elapsed: 0 });
    for (;;) {
      if (gen !== pollGen) return;
      let r = null;
      try { r = await api.getTrial(); } catch { r = null; }
      if (gen !== pollGen) return;
      const elapsed = Date.now() - t0;
      if (r && r.converted) {
        cardInst.activating?.update({ state: 'done', elapsed });
        setState({ trial: { ...getState().trial, converted: true } }, 'converted');
        postSuccess({ burst: true, data: { botUrl: r.botUrl, embed: r.embed, dashboardUrl: r.dashboardUrl, botId: r.botId, convertedFiles: r.convertedFiles, files: r.files } });
        return;
      }
      if (elapsed >= POLL_FOR_MS) {
        cardInst.activating?.update({ state: 'pending', elapsed });
        return;   // the card (role=status) announces its own pending state
      }
      cardInst.activating?.update({ state: 'checking', elapsed });
      await sleep(POLL_MS);
    }
  }

  sub('trial:ready', (d) => {
    const launched = params.get('launched') === '1';
    const t = getState().trial;
    if (launched && !activatingKey) {
      activatingKey = t.id;
      // Reloading should not re-run the activation beat; keep ?t= for B.
      try { const u = new URL(location.href); u.searchParams.delete('launched'); history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash); } catch { /* ignore */ }
      if (t.converted) postSuccess({ burst: true, data: { files: d && d.files } });
      else setTimeout(pollConversion, 600);
      return;
    }
    if (d && d.restored && t.converted && !getState().milestones.launched) postSuccess({ burst: true, data: { files: d.files } });
  });

  // ---- Live burst: 40 particles, 900 ms, canvas overlay; the status dot pulses twice.
  function liveBurst(dotEl) {
    if (dotEl) dotEl.classList.add('is-pulse');
    if (motion.reduced()) return;
    motion.director.request('launch', 2, (signal) => new Promise((resolve) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = h('canvas', { class: 'co-burst', 'aria-hidden': 'true' });
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      modal.append(cv);
      const g = cv.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      const cols = ['--f0', '--accent', '--accent-2'].map((v) => css.getPropertyValue(v).trim() || '#6366f1');
      const r = dotEl && dotEl.isConnected ? dotEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      const ox = (r.left + r.width / 2) * dpr, oy = (r.top + r.height / 2) * dpr;
      const P = Array.from({ length: 40 }, (_, i) => {
        const a = (i / 40) * Math.PI * 2 + Math.random() * 0.3;
        const sp = (180 + Math.random() * 260) * dpr;
        return { a, sp, c: cols[i % 3], s: (2 + Math.random() * 3) * dpr, rot: Math.random() * 6 };
      });
      let start = 0;
      const stop = motion.loop.add((tm) => {
        if (!start) start = tm;
        const k = Math.min(1, (tm - start) / 900);
        const e = 1 - Math.pow(1 - k, 3);
        g.clearRect(0, 0, cv.width, cv.height);
        for (const p of P) {
          const d = p.sp * e;
          const x = ox + Math.cos(p.a) * d, y = oy + Math.sin(p.a) * d + 60 * dpr * k * k;
          g.globalAlpha = 1 - k;
          g.fillStyle = p.c;
          g.save(); g.translate(x, y); g.rotate(p.rot + k * 4); g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.6); g.restore();
        }
        if (k >= 1 || signal.aborted) { cv.remove(); resolve(); return false; }
        return true;
      });
      signal.addEventListener('abort', () => { stop(); cv.remove(); resolve(); }, { once: true });
    }), { maxMs: 2000 });
  }

  // ================================================================== Go live (Channels + Developers, SPEC 11.2/11.3)

  let goLiveMod = null;
  function preloadGoLive() {
    if (!goLiveMod) goLiveMod = import('./golive.js').then((m) => { m.ensureCss?.(); return m; }).catch((err) => { console.error('[studio] golive.js failed to load', err); goLiveMod = null; return null; });
    return goLiveMod;
  }
  async function openGoLive({ tab = 'channels', channel = null, invoker = null } = {}) {
    // fixer r3 (D9): record the real invoker. Without one (palette, a chip that re-renders) only a focused control in the
    // Builder, header or a launch card counts; anything else (a SampleBot chip, a mobile tab) lets golive.js fall back
    // to the launch card's channels control, the BotChip or the Builder composer.
    const ae = document.activeElement;
    const related = ae && ae !== document.body && ae.closest && ae.closest('#st-setup, #st-header, .co-launch, #co-modal-slot');
    const inv = invoker || (related ? ae : false);
    const m = await preloadGoLive();
    if (!m) { emit('toast', { kind: 'warn', text: 'Channels are loading. Try again in a moment.' }); return; }
    await m.ensureCss?.();
    m.openGoLive(ctx, { tab, channel, invoker: inv, helpers: { h, copyButton, copyText, lastQA, botName, hueVar, price } });
  }
  // Any module (or B's palette) can open it: emit('golive:open', {tab:'channels'|'developers', channel?}).
  sub('golive:open', (d) => openGoLive(d || {}));

  // ================================================================== lifecycle

  sub('drawer:open', () => { if (stage) closeStage({ focus: false }); });
  sub('change:spec', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });
  sub('change:proof', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });
  sub('change:usage', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });
  sub('answer:final', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });
  sub('file:ready', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });
  sub('file:removed', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); });

  return {
    open(source = 'api') { const c = [...launchCards].filter((x) => x.el.isConnected).pop(); return openSheet({ source, from: c?.receipt || null }); },
    openGoLive,
    close() { closeSheet('close'); },
    destroy() { subs.forEach((u) => u()); subs.length = 0; if (sheet) closeSheet('destroy'); pollGen++; },
  };
}
