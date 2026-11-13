// KnowBot Studio: Launch, checkout and go-live (owner E). SPEC 1.4 B9–B11, 2.7 (Launch), 6.4, 11.1–11.3.
//
// What lives here
//   - `launch` card (variant 'launch' = the LaunchCard receipt + $549/mo plan, variant 'make-it-yours')
//   - `activating` and `success` cards (return from checkout, B11) + the Live burst
//   - the CheckoutSheet (co-modal-slot, role=dialog, focus trap, inert background, view transition from the card)
//   - the Go-live sheet (Channels gallery + Developers tab) is lazily imported from ./golive.js
//
// Cross-module effects only through store events (SPEC 3.3): launch:open in; proof:run, drawer:open, setup:post,
// checkout:dismissed, tab:show, intake:pick out. Nothing here reaches into another owner's DOM, except reading the
// SampleBot composer to focus it for "Keep testing" (the same affordance B uses).

const NBSP = ' ';
import { normalizeSurfaces, planTotals, toolSwitches, PRICE_MONTH, PRICE_YEAR } from './surfaces.js?v=581e55b';
const DEFAULT_ANCHORS = { asOf: '2026-11', items: ['CustomGPT Premium $499/mo', 'Chatbase Business $500/mo (40 MB cap)', 'Botpress Team $939/mo', 'Intercom Fin $0.99 per resolution'] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// fixer r7 (D8): 2 s polls for the first 20 s, then a background poll every 5 s up to 2 minutes (with a visible clock),
// then "taking longer than usual: we'll email you"; the bot stays usable throughout.
const POLL_MS = 2000, POLL_FOR_MS = 20000, POLL_SLOW_MS = 5000, POLL_MAX_MS = 120000, MINI_PROOF_WAIT = 45000;
const clock = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

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
// fixer M r1 (D8): the bot's preview line is a cited fact in the librarian voice, never its courtesy opener.
// Mirrors lib/knowbot.js isCourtesy (opener/closer templates with no digit, currency, URL or quotation).
const COURTESY_LINE = /^(?:(?:i think |good news,? |great news,? )?i(?:'ve| have)? found (?:what you(?:'re| are) looking for|it|this|that|the answer|something|a few things|a couple of things|some things)(?: that (?:should|might|may|could|will) help)?(?: for you)?|here(?:'s| is) what i found(?: for you)?|(?:i )?hope (?:this|that) helps(?: you)?|feel free to [^.!?]{0,80}|(?:i'm |i am )?happy to help(?: with that)?|glad (?:you asked|to help|i could help)|let me know if you need [^.!?]{0,40}|(?:good|great) question|thanks for asking)[.!]*$/i;
const COURTESY_FACTY = /\d|[$€£¥₹¢]|@|https?:|www\.|[“”"«»]/;
export function isCourtesyLine(s) {
  const t = String(s ?? '').replace(/[‘’]/g, "'").replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/\s+/g, ' ').trim();
  return !t || (t.length <= 140 && !COURTESY_FACTY.test(t) && COURTESY_LINE.test(t));
}
// “Title” or [“Title”](url), then optional ", page N" and ", under “Section”"
const WHERE_RE = /(?:\[“([^”]{1,140})”\]\([^)\s]*\)|“([^”]{1,140})”)((?:,\s*page\s+[^,:“]{1,20})?)(?:,\s*under\s+“([^”]{1,100})”)?/;
const whereLabel = (m) => {
  if (!m) return '';
  const title = String(m[1] || m[2] || '').trim();
  const page = (m[3] || '').replace(/^,\s*/, '').trim();
  return [title, page, (m[4] || '').trim()].filter(Boolean).join(' · ');
};
/**
 * The first cited fact of an answer in the librarian voice: {where, quote, n, text}. Skips courtesy openers/closers and
 * the "From “Title”, under “Section”:" lead-in (it becomes `where`). text is ready to show: 'Title · Section: “quote”'.
 * Falls back to the first marker-carrying sentence, then to citations[0].excerpt. Pure.
 */
export function citedLine(text, citations = []) {
  const ls = String(text || '').split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);
  let headWhere = '';
  for (const l of ls) {
    // "Here's what “Title”, under “X” says [1]:" — a header for the bullets that follow
    const hm = /(?:what|In|From)\s+(.+?)\s+says\s*\[\d+\]\s*:\s*$/.exec(l);
    if (hm) { headWhere = whereLabel(WHERE_RE.exec(hm[1])); continue; }
    const q = /“([^”\n]{3,400})”\s*\[(\d{1,3})\]/.exec(l);
    if (q) {
      const before = l.slice(0, q.index);
      const lead = /(?:^|\s)(?:In|From)\s+(.+?)(?:,\s*it says)?\s*:\s*$/.exec(before);
      const where = (lead && whereLabel(WHERE_RE.exec(lead[1]))) || headWhere;
      const quote = q[1].trim().replace(/([^.!?…])$/, '$1.');
      return { where, quote, n: Number(q[2]), text: `${where ? `${where}: ` : ''}“${quote}”` };
    }
    // model-written prose: the first sentence that carries a marker and is not courtesy
    for (const sen of l.split(/(?<=[.!?])\s+(?=[A-Z“"(\d])/)) {
      const m = /\[(\d{1,3})(?:\s*,\s*\d+)*\]/.exec(sen);
      if (!m || isCourtesyLine(sen)) continue;
      const plain = stripMarkers(sen).replace(/^(?:From|In)\s+“[^”]+”(?:,\s*[^:]{0,60})?:\s*/, '');
      if (plain.split(/\s+/).length >= 3) return { where: '', quote: '', n: Number(m[1]), text: /[.!?]["”’)]?$/.test(plain) ? plain : `${plain}.` };
    }
  }
  const c = (citations || []).find((x) => x && x.excerpt) || null;
  if (!c) return null;
  const ex = firstSentence(String(c.excerpt).replace(/^#+\s*/gm, '')).replace(/[“”]/g, '"');
  const where = [c.title || c.file, c.section].filter(Boolean).join(' · ');
  return { where, quote: ex, n: c.n || 1, text: `${where ? `${where}: ` : ''}“${ex}”` };
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
  // Owner pricing: ONE plan, $549/month or $5,490/year, with all three tools (Website, KnowBot number, Email) and every
  // feature; the visitor picks monthly or yearly here. The features switched on (spec.surfaces) never change the price.
  // Shown only at launch/checkout, which comes after testing.
  let planInterval = 'month';
  const price = () => {
    const p = cfg().price || {};
    const plan = planTotals(getState().spec?.surfaces, planInterval, { month: Number(p.amount) || PRICE_MONTH, year: Number(p.yearAmount) || PRICE_YEAR });
    const cur = (p.currency || 'USD').toUpperCase();
    const sym = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : `${cur} `;
    const fmt = (n) => `${sym}${Number(n).toLocaleString('en-US')}`;
    const amount = plan.total;
    return { amount, amt: fmt(amount), each: fmt(plan.each), sym, per: plan.per, perLong: plan.interval, text: `${fmt(amount)}/${plan.per}`, today: `${sym}0`,
      long: `${fmt(amount)}/${plan.interval}`, p, plan, fmt };
  };
  /** Every price on screen carries data-co-price=<kind>; one repaint keeps them all in step with the plan. */
  const PRICE_KINDS = {
    amt: (pr) => pr.amt, per: (pr) => `/${pr.perLong}`, cta: (pr) => `, ${pr.text}`, submit: (pr) => `Continue to secure checkout · ${pr.text}`,
    today: (pr) => `Today: ${pr.today} · first 30 days free, then ${pr.long} · cancel anytime. `,
    count: (pr) => `One plan · all three tools · ${pr.perLong === 'year' ? 'billed yearly' : 'billed monthly'}`,
  };
  const pspan = (kind, cls, tag = 'span') => h(tag, { class: cls, dataset: { coPrice: kind } }, PRICE_KINDS[kind](price()));
  const planBlocks = new Set();
  function repaintPrices() {
    const pr = price();
    for (const n of document.querySelectorAll('[data-co-price]')) { const f = PRICE_KINDS[n.dataset.coPrice]; if (f && !n.closest('.is-busy')) n.textContent = f(pr); }
    for (const b of [...planBlocks]) { if (b.isConnected) b.paint(); else planBlocks.delete(b); }
  }
  /** The plan: monthly | yearly, ONE line (the KnowBot plan), what it includes (the three tools, with the features that
   *  are switched on now) and the terms. Features are switched in Set up; they never change the price. */
  function planBlock() {
    const ivGroup = h('div', { class: 'co-iv', role: 'group', 'aria-label': 'Billing period' });
    const ivBtn = (iv, label) => {
      const b = h('button', { type: 'button', class: 'co-iv-btn', 'aria-pressed': String(planInterval === iv) }, label);
      b.addEventListener('click', () => { if (planInterval === iv) return; planInterval = iv; repaintPrices(); announce(`${iv === 'year' ? 'Yearly' : 'Monthly'}: ${price().long}.`, 'polite'); });
      return b;
    };
    const mBtn = ivBtn('month', 'Monthly'), yBtn = ivBtn('year', 'Yearly');
    ivGroup.append(mBtn, yBtn);
    const list = h('ul', { class: 'co-surf-lines', 'aria-label': 'Your plan' });
    const tools = h('ul', { class: 'co-tools', 'aria-label': 'Included tools' });
    const total = h('p', { class: 'co-surf-total' });
    const terms = h('p', { class: 'co-surf-terms' });
    const el = h('section', { class: 'co-surf', 'aria-label': 'Your plan' }, ivGroup, list, tools, total, terms);
    el.paint = () => {
      const pr = price();
      mBtn.setAttribute('aria-pressed', String(pr.plan.interval === 'month'));
      yBtn.setAttribute('aria-pressed', String(pr.plan.interval === 'year'));
      list.innerHTML = '';
      for (const line of pr.plan.lines) {
        list.append(h('li', { class: 'co-surf-line' }, h('span', { class: 'co-surf-name' }, 'KnowBot plan'), h('span', { class: 'co-surf-amt' }, `${pr.fmt(line.amount)}/${pr.per}`)));
      }
      tools.innerHTML = '';
      for (const t of toolSwitches(getState().spec?.surfaces).filter((x) => x.id !== 'agents')) { // AI agents: metered, not a plan line
        const onF = t.features.filter((f) => f.on).map((f) => f.label);
        const state = t.features.length === 1 ? (onF.length ? 'on' : 'off') : onF.length ? `${onF.join(', ')} on` : 'all off';
        tools.append(h('li', { class: `co-tool${t.on ? ' is-on' : ''}` }, h('span', { class: 'co-incl-ico', html: icon(t.on ? 'check' : 'plus', 12) }),
          h('span', null, h('b', null, t.label), ` · ${t.sub} · `, h('span', { class: 'co-tool-state' }, state))));
      }
      total.textContent = `Total: ${pr.long}, whatever features you switch on`;
      terms.textContent = `One plan: ${pr.fmt(pr.p.amount || PRICE_MONTH)}/month or ${pr.fmt(pr.p.yearAmount || PRICE_YEAR)}/year · every feature included · switch features on and off in Set up · first 30 days free · card required · up to 100 MB per deployment · KnowBot number usage billed separately · more than 100 MB is enterprise: ${pr.p.enterpriseEmail || 'sales@recoursellm.com'}`;
    };
    el.paint();
    planBlocks.add(el);
    return el;
  }
  const botName = () => getState().spec.name || 'Your bot';
  // fixer M r1 (D8): the trial bot is "your bot" until it is actually launched (never "live" before payment)
  const converted = () => { const s = getState(); return !!(s.trial?.converted || s.milestones?.launched); };
  const backLabel = () => (converted() ? 'Back to the live bot' : 'Back to your bot');
  const hueVar = () => `var(--f${(Number(getState().spec.avatar?.hue) || 0) % 8})`;
  const enabledFiles = () => {
    const s = getState();
    // Integrator: spec.sources is the live scope (the drawer writes it); a file row's `enabled` can lag behind it
    const src = s.spec && s.spec.sources;
    const on = (f) => (src && typeof src === 'object' ? src[f.id] !== false : f.enabled !== false);
    return (s.fileOrder || []).map((id) => s.files[id]).filter((f) => f && on(f) && f.phase !== 'rejected' && f.phase !== 'failed');
  };
  const readyFiles = () => enabledFiles().filter((f) => f.phase === 'ready');
  const isSampleFile = (f) => !!(f && (f.sample || (f.tags || []).some((t) => String(t).startsWith('sample:'))));
  const sampleOnly = () => { const en = enabledFiles(); return en.length > 0 && en.every(isSampleFile); };
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
    const lineOf = (a) => { if (!a._coLine || a._coLine.src !== a.final.text) { try { Object.defineProperty(a, '_coLine', { value: { src: a.final.text, v: citedLine(a.final.text, a.final.citations) }, configurable: true, enumerable: false, writable: true }); } catch { return citedLine(a.final.text, a.final.citations); } } return a._coLine.v; };
    const clean = (l) => !!l && !!l.text && !/…["”]?$/.test(l.text) && l.text.split(/\s+/).filter(Boolean).length >= 4;
    const score = (a) => Math.max(0, ...(a.final.citations || []).map((c) => Number(c.match) || (c.similarity != null ? Number(c.similarity) * 100 : 0) || 0), Number(a.final.topMatch) || 0);
    const cands = th.map((a, i) => ({ a, i })).filter(({ a }) => ok(a) && a.question && clean(lineOf(a)));
    const best = (list) => list.sort((x, y) => (score(y.a) - score(x.a)) || (y.i - x.i))[0]?.a || null;
    const pick = best(cands.filter(({ a }) => a.by !== 'proof')) || best(cands.filter(({ a }) => a.by === 'proof'))
      || [...th].reverse().find((a) => ok(a) && lineOf(a));
    if (!pick) return null;
    const line = lineOf(pick);
    const c = pick.final.citations.find((x) => x.n === line.n) || pick.final.citations.find((x) => x.n === 1) || pick.final.citations[0];
    return { answerId: pick.id, question: pick.question, answer: line.text, where: line.where, quote: line.quote, cite: c };
  }
  const anchors = () => {
    const a = cfg().anchors && (cfg().anchors.items || []).length ? cfg().anchors : DEFAULT_ANCHORS;
    const m = /^(\d{4})-(\d{2})/.exec(a.asOf || '');
    const when = m ? `${MONTHS[Number(m[2]) - 1] || ''} ${m[1]}` : a.asOf || '';
    return `For comparison, as published ${when}: ${a.items.join(' · ')}.`;
  };
  const contactHref = () => { const c = cfg().contact || 'mailto:hello@knowdrive.ai'; return /^(mailto:|https?:)/i.test(c) ? c : `mailto:${c}`; };
  const isMobile = () => matchMedia('(max-width: 899px)').matches;
  // fixer r6 (D8/D9): the CTA shows "Launch <bot>" (the price is the hero beside it); the price rides in a visually
  // hidden suffix so the accessible name stays "Launch <bot>, $549/mo" (it starts with the visible label).
  const ctaPrice = () => pspan('cta', 'co-sr co-cta-price');
  const testsName = (t) => (t && t.full ? 'Proof Run' : 'Quick check');
  const FULL_PROOF_N = 11;   // 8 in-scope questions + 3 out-of-scope probes (SPEC 1.4 B8)
  const runFullProof = (before) => { if (before) before(); emit('proof:run', { mini: false }); };

  // ---------------------------------------------------------------- shared bits

  function avatar(size = 40) {
    const s = getState().spec;
    return h('span', { class: 'co-ava', style: { '--co-hue': hueVar(), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }, 'aria-hidden': 'true' }, s.avatar?.initials || initialsOf(s.name));
  }
  function copyButton(getText, label = 'Copy', { small = false, what = 'Copied', aria = null, iconOnly = false, primary = false } = {}) {
    // fixer r6 (D10/D11): an icon-only 44 x 44 variant pinned to the corner of an endpoint or a code block. It has no
    // visible text, so its accessible name (and tooltip) can carry the full context ("Copy the chat endpoint URL").
    if (iconOnly) {
      const name0 = aria || label;
      const ib = h('button', { type: 'button', class: 'co-copy co-copy-icon', 'aria-label': name0, title: name0 }, h('span', { class: 'co-copy-ico', 'aria-hidden': 'true', html: icon('copy', 16) }));
      ib.addEventListener('click', async () => {
        const ok = await copyText(typeof getText === 'function' ? getText() : getText);
        ib.classList.toggle('is-done', ok);
        ib.setAttribute('aria-label', ok ? `Copied: ${name0.replace(/^Copy\s+/i, '')}` : `Copy failed: ${name0.replace(/^Copy\s+/i, '')}`);
        ib.querySelector('.co-copy-ico').innerHTML = icon(ok ? 'check' : 'copy', 16);
        announce(ok ? what : 'Copy failed. Select the text and copy it.', 'polite');
        if (ok) motion.animate(ib, [{ transform: 'scale(.9)' }, { transform: 'scale(1.08)' }, { transform: 'none' }], { duration: motion.DUR[2], easing: 'spring', essential: false });
        clearTimeout(ib._t);
        ib._t = setTimeout(() => { ib.setAttribute('aria-label', name0); ib.classList.remove('is-done'); ib.querySelector('.co-copy-ico').innerHTML = icon('copy', 16); }, 1800);
      });
      return ib;
    }
    const lab = h('span', { class: 'co-copy-label' }, label);
    // fixer r5 (D9, WCAG 2.5.3): the accessible name always STARTS with the visible label ("Copy", "Copied", "Press
    // Ctrl+C"); the extra context ("hosted link") follows it and tracks the label as it changes.
    const tail = aria ? (aria.toLowerCase().startsWith(label.toLowerCase()) ? aria.slice(label.length) : `, ${aria}`) : '';
    const b = h('button', { type: 'button', class: `btn ${primary ? 'btn-primary' : 'btn-ghost'} co-btn ${primary ? 'co-btn-primary' : 'co-btn-ghost'} co-copy${small ? ' is-small' : ''}` }, h('span', { class: 'co-copy-ico', 'aria-hidden': 'true', html: icon('copy', 14) }), lab);
    const name = () => { if (tail) b.setAttribute('aria-label', `${lab.textContent}${tail}`); };
    name();
    b.addEventListener('click', async () => {
      const ok = await copyText(typeof getText === 'function' ? getText() : getText);
      b.classList.toggle('is-done', ok);
      lab.textContent = ok ? 'Copied' : 'Press Ctrl+C'; name();
      b.querySelector('.co-copy-ico').innerHTML = icon(ok ? 'check' : 'copy', 14);
      announce(ok ? what : 'Copy failed. Select the text and copy it.', 'polite');
      if (ok) motion.animate(b, [{ transform: 'scale(.96)' }, { transform: 'scale(1.04)' }, { transform: 'none' }], { duration: motion.DUR[2], easing: 'spring', essential: false });
      clearTimeout(b._t);
      b._t = setTimeout(() => { lab.textContent = label; name(); b.classList.remove('is-done'); b.querySelector('.co-copy-ico').innerHTML = icon('copy', 14); }, 1800);
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
  // The KnowDrive account step (owner decisions 1-4, ./kdaccount.js, loaded on first use): Launch opens it before the
  // checkout until the bot's files are in the visitor's own KnowDrive account. Off (owner's deployment, or a server
  // without it): config.kd.required is false and Launch goes straight to the checkout, as before.
  let kdStepP = null, kdEmail = null;
  const kdStep = () => (kdStepP ||= import('./kdaccount.js?v=581e55b').then((m) => m.createKdStep(ctx, { h, $$ })));
  const kdNeeded = () => !!cfg().kd?.required && !converted();
  setTimeout(() => { if (cfg().kd?.available && getState().trial?.id) kdStep().then((k) => k.check()).catch(() => {}); }, 2500);
  let stage = null;   // LaunchStage {layer, panel, inst, opener, cleanup[]}
  let focusNextCard = false;       // set by a user-initiated launch:open: the next summary takes focus (D9)
  let pickFocus = null;            // fixer r7 (D9): what had focus when that launch was picked
  /** Focus only follows a launch the visitor picked if they have not moved on meanwhile (the mini check can take a few
   *  seconds): still on the picked control, on <body>, or on the Builder log the retired chip handed focus to. */
  const focusStillOurs = () => {
    const a = document.activeElement;
    return !a || a === document.body || a === pickFocus || !(pickFocus && pickFocus.isConnected) && !!(a.closest && a.closest('#st-log, .st-log, .co-launch'))
      || !!(a.matches && a.matches('#st-log, .st-log'));
  };
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
   * The chat always gets a compact LaunchSummary: bot, stats, the cited answer, $549 and the CTA in one view. The full
   * card lives in the LaunchStage: at 1100 px and wider it is docked over the SampleBot pane and opens by itself
   * (morphing out of the summary), so receipt, embed preview, price and CTA are visible together above the fold;
   * narrower, "Receipt & plan" opens it as a full-screen dialog.
   */
  function renderLaunchCard(data, el) {
    if (data && data.variant === 'make-it-yours') return renderMakeItYours(el);
    return renderLaunchSummary(el, data || {});
  }

  function botPaneRect() {
    const b = document.getElementById('st-bot');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width >= 560 && r.height >= 360 ? r : null;
  }

  // fixer r5 (D7): the KnowDrive mark inlined with currentColor, so it reads in both themes (logo.svg is white-only).
  const KD_LOGO = '<svg viewBox="0 0 472.45 327.79" width="20" height="14" focusable="false"><g fill="currentColor"><rect x="4.71" y="22.4" width="71.76" height="283.06" rx="35.88" ry="35.88"/><path d="M135.38,192.3l29.42-29.73,144.96,137.9c2.53,2.41.81,6.67-2.68,6.65l-81-.45c-7.19-.04-14.06-2.92-19.13-8.02l-71.83-72.26c-9.41-9.46-9.29-24.78.26-34.1Z"/><path opacity=".18" d="M164.8,162.57l8.66,8.68-21.98,20.96c-4.73,4.51-8.24,10.05-11.21,15.88-4.14,8.11-.14,22.87-.14,22.87,0,0-9.84-8.1-11.3-17.75-1.33-8.74,3.22-15.86,6.2-19.59,5.08-6.38,21.36-22.47,21.36-22.47l8.42-8.57Z"/><path d="M133.55,224.72l-39.3-37.25c-12.84-12.09-13.13-32.41-.63-44.86l109.34-108.91c8.35-8.32,19.68-12.94,31.46-12.84l105.98.91c6.94.06,13.82,1.17,20.43,3.28,30.06,9.63,107.24,43.47,106.92,134.62-.41,117.27-82.27,140.21-88.22,143.32-2.25,1.18-20.09,4.81-23.7,4.81-9.1,0-17.81-3.69-24.16-10.2l-33.84-35.16c-2.04-2.08-.56-5.58,2.36-5.56l30.64.23c9.43-2.37,74.21-16.99,73.36-89.79-.79-67.42-69.84-80.09-81.99-80.31l-46.95-.82-18.27.6c-10.6.35-20.68,4.65-28.25,12.07l-42.33,41.44-50.14,51.62c-5.07,5.22-7.52,14.36-7.32,19.58.28,7.3,4.62,13.23,4.62,13.23Z"/></g></svg>';

  /** "Keep testing · Questions? Talk to us": always directly under the primary CTA it escapes from. */
  function sublinks({ stage: onStage = false } = {}) {
    return h('div', { class: `co-sublinks${onStage ? ' is-foot' : ''}` },
      h('button', { type: 'button', class: 'co-link', onclick: () => { announce('Keep testing. Your bot is saved.'); if (onStage) closeStage({ focus: false }); focusBotComposer(); } }, 'Keep testing'),
      h('span', { class: 'co-sep', 'aria-hidden': 'true' }, '·'),
      h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us'));
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
      ['One embed line for any site', 'code'],
      ['100 MB of KnowDrive storage: PDF, DOCX, PPTX, XLSX, HTML, MD, TXT, images, audio', 'layers'],
      sampleOnly() ? ['Sample files are removed at launch: add your own docs after, your settings and tests stay', 'refresh'] : ['Your files carry over, nothing gets re-uploaded', 'refresh'],
      ['Citations on every answer, canonical refusals', 'shieldCheck'],
      ['Question insights: every question your customers ask is captured so you can see gaps', 'trending'],
      ['Three tools: Website (chat bubble, voice, homepage search), KnowBot number (texts, calls, WhatsApp) and Email', 'chat'],
      ['Chat API (OpenAI-compatible)', 'code'],
      p.answersIncluded ? [String(p.answersIncluded), 'bolt'] : null,
      ['Cancel anytime', 'checkCircle'],
    ].filter(Boolean);
    const cta = h('button', { type: 'button', class: 'co-cta', 'aria-describedby': `${titleId}-trust` },
      h('span', { class: 'co-cta-label' }, `Launch ${botName()}`), ctaPrice(), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    cta.addEventListener('click', () => openSheet({ source: 'card', from: receipt, invoker: cta }));
    const channelsStrip = h('button', { type: 'button', class: 'co-chstrip' },
      h('span', { class: 'co-chstrip-icons', 'aria-hidden': 'true' }, ...['chat', 'phone', 'mail', 'mic', 'code'].map((n, i) => h('i', { style: { '--i': i }, html: icon(n, 13) }))),
      h('span', { class: 'co-chstrip-text' }, 'Website, KnowBot number, Email and API'),
      h('span', { class: 'co-chstrip-go' }, 'Explore', h('span', { html: icon('chevronRight', 14) })));
    channelsStrip.addEventListener('click', () => openGoLive({ tab: 'channels', invoker: channelsStrip }));
    // Order: price → CTA → reassurance first, inclusions after, so the CTA is above the fold at every size (fixer r1).
    const plan = h('section', { class: 'co-plan', 'aria-labelledby': titleId },
      h('div', { class: 'co-plan-brand' }, h('span', { class: 'co-plan-logo', 'aria-hidden': 'true', html: KD_LOGO }), 'KnowDrive'),
      h('h3', { class: 'co-price', id: titleId }, pspan('amt', 'co-price-amt'), pspan('per', 'co-price-per')),
      h('p', { class: 'co-tagline' }, 'One plan with all three tools: Website, KnowBot number and Email. Every feature included, no per-answer fees.'),
      planBlock(),
      where === 'chat' ? cta : null,   // inline: the card's own CTA is the only one; stage: the sticky bar is (fixer r4, D8)
      // fixer r5 (D8): on the stage the escape hatch lives directly under the sticky CTA bar (openStage), not up here
      where === 'stage' ? null : sublinks({ stage: false }),
      h('p', { class: 'co-trust', id: `${titleId}-trust` }, h('span', { html: icon('lock', 13) }), `Your files stay private to your bot. Saved for ${cfg().quota?.ttlDays || 7} days if you don't launch.`),
      h('ul', { class: 'co-incl', 'aria-label': 'Included' }, incl.map(([t]) => h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 14) }), h('span', null, t)))),
      p.guaranteeLine ? h('p', { class: 'co-optline' }, h('span', { html: icon('shieldCheck', 14) }), ' ', String(p.guaranteeLine)) : null,
      p.enterpriseEmail ? h('p', { class: 'co-optline co-enterprise' }, 'More than 100 MB? ', h('a', { href: `mailto:${p.enterpriseEmail}?subject=${encodeURIComponent('KnowBot enterprise')}` }, 'Talk to enterprise sales')) : null,
      channelsStrip,
      h('p', { class: 'co-anchors' }, anchors()));

    // fixer r6 (D8): in the 560 px receipt sheet the card is one column; the embed preview moves below the inclusions
    // (after "what you get"), so the cited answer leads straight into the plan instead of a tall mock
    if (where === 'stage') plan.insertBefore(embedEl, plan.querySelector('.co-anchors'));
    const card = h('article', { class: `co-launch${where === 'stage' ? ' is-stage' : where === 'inline' ? ' is-inline' : ''}`, 'aria-label': where === 'inline' ? `${botName()}: full receipt and plan` : `Launch ${botName()}` }, h('div', { class: 'co-launch-glow', 'aria-hidden': 'true' }), h('div', { class: 'co-launch-grid' }, receipt, plan));
    // fixer r5 (D6): on the stage the plan column and the embed preview are laid out in later frames (content-visibility
    // skips their layout until released), so no single frame lays out the whole two-column card under CPU throttling.
    const deferred = where === 'stage' ? [plan, embedEl] : [];
    for (const n of deferred) n.style.contentVisibility = 'hidden';
    el.append(card);

    const inst = { el, card, receipt, cta, kind: where === 'stage' ? 'stage' : where === 'inline' ? 'inline' : 'launch', paint, update: () => paint(false), destroy, deferred };
    launchCards.add(inst);

    function paintQA() {
      const qa = lastQA();
      qaEl.innerHTML = '';
      qaEl.hidden = !qa;
      embedEl.innerHTML = '';
      embedEl.append(embedPreview(qa));
      if (!qa) return;
      const c = qa.cite;
      const chip = h('button', { type: 'button', class: 'co-cite', 'aria-label': `Citation ${c.n || 1}: ${c.title || c.file}${c.seq != null ? `, atom ${c.seq}` : ''}. Opens the quoted source.` }, String(c.n || 1));
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
      // fixer r6 (D8): the price is shown once, as the hero; the CTA names the bot, not the price again
      $('.co-cta-label', cta).textContent = `Launch ${botName()}`;
      const samples = st.samples && st.samples === st.files;
      $('dt', statsEl.querySelector('[data-k="files"]')).textContent = samples ? 'Sample files' : 'Files';
      $('.co-unit', statsEl.querySelector('[data-k="files"]')).textContent = samples ? 'removed at launch' : '';
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
    const amt = pspan('amt', 'co-price-amt');
    const per = pspan('per', 'co-price-per');
    const cta = h('button', { type: 'button', class: 'co-cta' },
      h('span', { class: 'co-cta-label' }, `Launch ${botName()}`), ctaPrice(), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    const moreId = `co-sum-more-${Math.random().toString(36).slice(2, 8)}`;
    const more = h('div', { class: 'co-sum-more', id: moreId, hidden: true });
    const viewLabel = h('span', null, 'Receipt & plan');
    // fixer r6 (D8/D10): "Receipt & plan" is a text link in the card header (it no longer floats alone under the CTA)
    const view = h('button', { type: 'button', class: 'co-link co-sum-view', 'aria-expanded': 'false', 'aria-controls': moreId }, viewLabel);
    const headId = `co-sum-h-${Math.random().toString(36).slice(2, 8)}`;
    const heading = h('h3', { class: 'co-sum-h', id: headId }, nameEl, edit);
    const fullLink = h('button', { type: 'button', class: 'co-link co-sum-full', hidden: true, onclick: () => runFullProof(() => closeStage({ focus: false })) }, `Run the full Proof Run (${FULL_PROOF_N})`);
    const chBtn = h('button', { type: 'button', class: 'co-link co-sum-channels' }, 'See the tools & API');
    chBtn.addEventListener('click', () => openGoLive({ tab: 'channels', invoker: chBtn }));
    const incl = h('ul', { class: 'co-sum-incl', 'aria-label': 'Included in the plan' },
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, 'Hosted share link + one embed line for any site')),
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, 'Website, KnowBot number and Email, every feature included, + chat API · ', chBtn)),
      h('li', null, h('span', { class: 'co-incl-ico', html: icon('check', 13) }), h('span', null, 'Question insights: see what customers ask and where the gaps are')));
    const thumb = h('div', { class: 'co-thumb-hold' });
    // fixer r4 (D8): while the receipt panel is open over the bot pane, this card folds to a one-line stub (name ·
    // checks · price · "Receipt open"), with no CTA, no anchors and no repeated inclusions: one solid CTA, in the panel.
    // fixer r5 (D9 label-in-name, D7/D8 price clarity): the stub has no aria-label; its accessible name IS its visible
    // text (name · checks · price, Receipt open) and the extra hint rides on aria-describedby. Only the bot name may
    // ellipsize; the checks and the price sit in non-shrinking spans so "$549/mo" never truncates.
    // fixer r6 (D7/D8): two lines, so the name never truncates beside its stats: the name on top, the checks under it.
    // The price is not repeated here (it is the hero in the receipt panel / checkout).
    const stubName = h('span', { class: 'co-stub-name' });
    const stubMeta = h('span', { class: 'co-stub-meta' });
    const stubText = h('span', { class: 'co-stub-text' }, stubName, stubMeta);
    const stubGo = h('span', { class: 'co-stub-go-t' }, 'Receipt open');
    const stubHintId = `co-stub-hint-${Math.random().toString(36).slice(2, 8)}`;
    const stubHint = h('span', { class: 'co-sr', id: stubHintId, hidden: true });
    const stub = h('button', { type: 'button', class: 'co-stub', hidden: true, 'aria-describedby': stubHintId },
      h('span', { class: 'co-stub-dot', 'aria-hidden': 'true' }), stubText, stubHint,
      h('span', { class: 'co-stub-go' }, stubGo, h('span', { html: icon('arrowRight', 13) })));
    stub.addEventListener('click', () => {
      if (sheet) { try { sheet.email.focus(); } catch { /* ignore */ } return; }
      // fixer r7 (D9): the stub moves focus to the receipt panel's heading (the panel's first stop), never its container
      if (stage) { focusStageHead(); pulseCard(stage.panel); } else collapse(false);
    });
    // Programmatic focus lands on the card (tabindex=-1, no resting ring), never on the name: it is not an input.
    const card = h('article', { class: 'co-launch co-sum', 'aria-labelledby': headId, tabindex: '-1' },
      h('div', { class: 'co-launch-glow', 'aria-hidden': 'true' }),
      stub,
      h('div', { class: 'co-sum-body' },
        h('div', { class: 'co-sum-head' }, avatar(40), h('div', { class: 'co-rc-idtext' }, heading, subEl),
          h('div', { class: 'co-sum-headr' }, h('span', { class: 'co-rc-badge' }, h('i', { class: 'co-dot is-ready', 'aria-hidden': 'true' }), 'Ready to launch'), view)),
        h('div', { class: 'co-sum-pillrow' }, pills, fullLink),
        qaEl,
        h('div', { class: 'co-sum-gets' }, incl, thumb),
        h('div', { class: 'co-sum-price' }, h('p', { class: 'co-price' }, amt, per), h('small', null, pspan('count', ''), ' · no per-answer fees · cancel anytime')),
        cta,
        h('div', { class: 'co-sum-links' },
          h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us'),
          h('span', { class: 'co-sep', 'aria-hidden': 'true' }, '·'),
          h('button', { type: 'button', class: 'co-link', onclick: () => { closeStage({ focus: false }); announce('Keep testing. Your bot is saved.'); focusBotComposer(); } }, 'Keep testing')),
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
    function collapse(on, mode = 'receipt', { instant = false, fade = false } = {}) {
      stubGo.textContent = mode === 'checkout' ? 'In checkout' : 'Receipt open';
      paintStubLabel(mode);
      if (!!inst.collapsed === !!on) return;
      inst.collapsed = !!on;
      const body = card.querySelector('.co-sum-body');
      const h0 = instant || motion.reduced() || !card.isConnected ? 0 : card.getBoundingClientRect().height;
      card.classList.toggle('is-collapsed', !!on);
      stub.hidden = !on; body.hidden = !!on;
      if (on) { const ae = document.activeElement; if (ae && body.contains(ae)) { try { stub.focus({ preventScroll: true }); } catch { /* ignore */ } } }
      // fixer r6 (D6): an unfold triggered by closing the receipt panel never measures (no forced layout while the
      // panel animates out): the body fades up in place instead of a height FLIP
      if (fade && !on && !motion.reduced() && card.isConnected) { motion.animate(body, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: 60, easing: 'out', fill: 'backwards' }); return; }
      if (instant || motion.reduced() || !card.isConnected) return;
      const h1 = card.getBoundingClientRect().height;
      if (!h0 || !h1 || Math.abs(h0 - h1) < 2) return;
      motion.animate(card, [{ height: `${h0}px`, overflow: 'hidden' }, { height: `${h1}px`, overflow: 'hidden' }], { duration: motion.DUR[3], easing: 'inOut' });
      motion.animate(on ? stub : body, [{ opacity: 0, transform: on ? 'translateY(-4px)' : 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: on ? 80 : 120, easing: 'out', fill: 'backwards' });
    }
    function paintStubLabel(mode) {
      const st = stats();
      stub.removeAttribute('aria-label');
      stubHint.textContent = `${st.tests && st.tests.total ? `${testsName(st.tests)}: ${st.tests.passed} of ${st.tests.total} passed` : 'Not tested yet'}, ${price().long}. ${mode === 'checkout' ? 'Checkout is open: go to the email field.' : 'Receipt and plan are open beside the Builder: go to them.'}`;
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
          const chip = h('button', { type: 'button', class: 'co-cite', 'aria-label': `Citation ${c.n || 1}: ${c.title || c.file}${c.seq != null ? `, atom ${c.seq}` : ''}. Opens the quoted source.` }, String(c.n || 1));
          chip.addEventListener('click', () => emit('drawer:open', { fileId: c.fileId, atomId: c.atomId ?? null, seq: c.seq ?? null, answerId: qa.answerId, n: c.n || 1 }));
          qaEl.append(
            h('figcaption', { class: 'co-qa-q' }, h('span', { class: 'co-qa-k' }, 'Q'), h('span', null, qa.question)),
            h('blockquote', { class: 'co-qa-a' }, h('span', { class: 'co-qa-k' }, 'A'), h('span', { class: 'co-sum-qa-t' }, qa.answer, NBSP, chip)),
            h('p', { class: 'co-qa-src' }, h('span', { class: 'co-qa-src-ico', html: icon('file', 12) }), h('span', null, [c.file || c.title || 'source', c.match != null ? `match ${c.match}` : null].filter(Boolean).join(' · '))));
        }
        thumb.replaceChildren(embedThumb(qa));
      }
      $('.co-cta-label', cta).textContent = `Launch ${botName()}`;
      pills.innerHTML = '';
      const pill = (txt, cls = '') => h('span', { class: `co-pill${cls}` }, txt);
      const allPass = st.tests && st.tests.total && st.tests.passed === st.tests.total && !st.tests.unsupported;
      const samples = st.samples && st.samples === st.files;
      // fixer r6 (D8): a sample-only bot says, before payment, that its sample files do not carry over
      pills.append(...[samples ? pill(`${plural(st.files, 'sample file')} · removed at launch`, ' is-warn') : pill(plural(st.files, 'file')),
        samples ? null : pill(`${mbOf(st.bytes)} of ${st.quotaMB} MB`), samples ? null : pill(plural(st.atoms, 'atom')),
        st.tests && st.tests.total ? pill(`${testsName(st.tests)} ${st.tests.passed}/${st.tests.total}`, allPass ? ' is-pass' : '') : pill('not tested yet')].filter(Boolean));
      fullLink.hidden = !(st.tests && st.tests.total && !st.tests.full);
      stubName.textContent = botName();
      stubMeta.textContent = st.tests && st.tests.total ? `${testsName(st.tests)} ${st.tests.passed}/${st.tests.total} passed` : 'Not tested yet';
      paintStubLabel(stubGo.textContent === 'In checkout' ? 'checkout' : 'receipt');
      $$('.co-sum-head .co-ava', card).forEach((a) => { a.textContent = getState().spec.avatar?.initials || initialsOf(botName()); a.style.setProperty('--co-hue', hueVar()); });
    }
    paint();
    // fixer r5 (D6): on a docking desktop the fresh card is mounted already folded to its stub and the receipt panel
    // grows out of that stub right away: the full card is never rendered in the log only to be yanked away.
    const mountFolded = autoStageNext && !sheet && canDock();
    if (mountFolded) {
      collapse(true, 'receipt', { instant: true });
      if (!motion.reduced()) motion.animate(stub, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
    } else if (!motion.reduced()) motion.stagger([...card.querySelector('.co-sum-body').children].filter((n) => !n.hidden), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out', fill: 'backwards' }, 45);
    // fixer r7 (D9): a user-initiated launch that docks the receipt panel moves focus to the panel's heading (openStage
    // announces it); only an undocked card takes focus itself
    const stageFocus = focusNextCard && mountFolded && focusStillOurs();
    if (focusNextCard && mountFolded) focusNextCard = false;
    if (focusNextCard && !focusStillOurs()) focusNextCard = false;
    if (focusNextCard) {
      focusNextCard = false;
      requestAnimationFrame(() => setTimeout(() => {
        if (!card.isConnected) return;
        try { card.focus({ preventScroll: true }); } catch { /* ignore */ }
        announce(`${botName()} is ready to launch, ${price().long}. Launch card in the Builder: Launch button, Receipt and plan, Keep testing.`, 'polite');
      }, motion.reduced() ? 0 : 120));
    }
    if (stage && !stage.closing) collapse(true, 'receipt', { instant: true });   // a newer card while the receipt panel is open: folded from the start
    if (autoStageNext) {
      autoStageNext = false;
      const go = () => {
        if (card.isConnected && !stage && !sheet && canDock()) openStage({ from: card, opener: view, focus: stageFocus, auto: true });
        else if (mountFolded && !stage) collapse(false);   // could not dock after all: unfold the card in the log
      };
      if (mountFolded) requestAnimationFrame(go); else setTimeout(go, motion.reduced() ? 0 : 420);
    }
    return inst;
  }

  /** A 120 px embed thumbnail for the summary: browser bar, page skeleton, the bot's panel in its hue, launcher. */
  function embedThumb(qa = lastQA()) {
    return h('div', { class: 'co-thumb', style: { '--co-hue': hueVar() }, 'aria-label': `Preview: ${botName()} as a chat widget on your site`, role: 'img' },
      h('div', { class: 'co-thumb-bar', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('span', null, 'yoursite.com')),
      h('div', { class: 'co-thumb-page', 'aria-hidden': 'true' },
        h('b'), h('i'), h('i', { class: 'is-short' }),
        h('div', { class: 'co-thumb-panel' },
          h('span', { class: 'co-thumb-head' }),
          h('span', { class: 'co-thumb-q' }, qa ? qa.question : ''),
          h('span', { class: 'co-thumb-a' }, qa ? qa.answer : getState().spec.greeting || ''),
          h('span', { class: 'co-thumb-src' }, qa ? `[${qa.cite.n || 1}] ${qa.cite.file || qa.cite.title || ''}` : '')),
        h('span', { class: 'co-thumb-dot' })),
      h('span', { class: 'co-thumb-cap', 'aria-hidden': 'true' }, 'On your site'));
  }

  // ---- LaunchStage: the wide two-column receipt + plan (spec B9). fixer r3 (D8): at ≥ 1100 px it docks over the
  // SampleBot pane (the Builder column, with the launch card and its CTA, stays fully usable beside it: nothing covers
  // the card). It opens by itself with a fresh launch card and on "Receipt & plan"; "Back to the live bot" closes it.
  // Narrower there is no stage: the full receipt expands inline inside the card.
  // fixer r6 (D6): "can the receipt dock?" is answered from a ResizeObserver cache of the bot pane's size, so a fresh
  // launch card (inserted by the Builder a moment earlier) never forces a synchronous layout just to ask.
  let paneSize = null, paneRO = null;
  function watchPane() {
    if (paneRO || typeof ResizeObserver !== 'function') return;
    const b = document.getElementById('st-bot');
    if (!b) return;
    paneRO = new ResizeObserver((ents) => {
      const e = ents[ents.length - 1]; if (!e) return;
      const bb = e.borderBoxSize && (e.borderBoxSize[0] || e.borderBoxSize);
      paneSize = bb && bb.inlineSize != null ? { w: bb.inlineSize, h: bb.blockSize } : { w: e.contentRect.width, h: e.contentRect.height };
    });
    paneRO.observe(b);
  }
  const canDock = () => {
    if (isMobile() || innerWidth < 1100) return false;
    watchPane();
    return paneSize ? paneSize.w >= 560 && paneSize.h >= 360 : !!botPaneRect();
  };
  const STAGE_W = 560;

  function placeStage(known = null) {
    if (!stage) return;
    const r = known || (canDock() ? botPaneRect() : null);
    if (!r) { closeStage({ focus: false }); return; }
    const L = stage.layer;
    L.style.left = `${Math.round(r.left)}px`; L.style.top = `${Math.round(r.top)}px`; L.style.width = `${Math.round(r.width)}px`; L.style.height = `${Math.round(r.height)}px`;
  }

  /** fixer r7 (D9): the receipt panel's heading is its focus target (tabindex=-1, no resting ring). */
  function focusStageHead() {
    const t = stage && (stage.headEl || stage.panel);
    if (t) { try { t.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
  /** fixer r7 (D9): where focus goes back to when the receipt panel closes: the control that opened it when it lives
   *  in the Builder, the header or a launch card (never a SampleBot / Proof Run control behind the panel), else the
   *  launch card's own "Receipt & plan" control, else the card. */
  function stageReturnTarget(s) {
    const usable = (n) => n && n !== document.body && n.isConnected && !n.closest('[inert]') && !n.hidden && n.getClientRects().length > 0;
    const rt = s.returnTo;
    const okHome = rt && rt.matches && rt.matches('button, a[href], input, textarea, select, [role="button"]') && rt.closest && rt.closest('#st-setup, #st-header, .co-launch') && !(s.layer && s.layer.contains(rt));
    const card = [...launchCards].filter((c) => c.kind === 'summary' && c.el.isConnected).pop();
    return [okHome ? rt : null, s.opener, card && card.view, card && card.card].find(usable) || null;
  }

  function openStage({ from = null, opener = null, focus = true, auto = false } = {}) {
    if (stage) { focusStageHead(); return stage; }
    const ae0 = document.activeElement;
    // fixer r5 (D6): every read first (pane rect, the folded stub's rect), then only writes: no forced layout mid-open
    const r0 = canDock() ? botPaneRect() : null;
    if (!r0) return null;
    const preStub = from && from.isConnected && from.querySelector ? from.querySelector('.co-stub:not([hidden])') : null;
    // fixer r6 (D6): the morph's start rect is read here, before any write. An unfolded card is about to fold to its
    // stub in place (same top-left), so its top 56 px stand in for the stub: no forced layout after the fold below.
    const fromR = !preStub && from && from.isConnected && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
    let fr = preStub ? preStub.getBoundingClientRect() : fromR && fromR.width ? { left: fromR.left, top: fromR.top, width: fromR.width, height: Math.min(56, fromR.height) } : null;
    const botPane = document.getElementById('st-bot');
    if (botPane && botPane.contains(document.activeElement)) focus = true;
    const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small co-stage-x', 'aria-describedby': 'co-stage-x-hint' }, h('span', { 'aria-hidden': 'true', html: icon('x', 14) }), backLabel(), h('span', { class: 'co-sr', id: 'co-stage-x-hint', hidden: true }, 'Closes the receipt'));
    // fixer r7 (D9): the eyebrow is the panel's heading and its focus target on a user-initiated open
    const headEl = h('h2', { class: 'co-eyebrow co-stage-h', id: 'co-stage-h', tabindex: '-1' }, h('span', { html: icon('rocket', 13), 'aria-hidden': 'true' }), `${botName()} is ready to launch`);
    const head = h('div', { class: 'co-stage-head' }, headEl, closeBtn);
    const holder = h('div', { class: 'co-stage-card' });
    // Phones: the plan sits below the receipt, so a sticky footer keeps the price and the CTA in reach while scrolling.
    // fixer r6 (D8): the price is the hero once, here in the sticky bar ($549/month); the CTA names the bot only and the
    // plan column's own price is hidden on the stage (checkout.css)
    const footCta = h('button', { type: 'button', class: 'co-cta' }, h('span', { class: 'co-cta-label' }, `Launch ${botName()}`), ctaPrice(), h('span', { class: 'co-cta-ico', html: icon('arrowRight', 16) }));
    const pr0 = price();
    const foot = h('div', { class: 'co-stage-foot' },
      h('div', { class: 'co-stage-foot-bar' }, h('p', { class: 'co-stage-foot-price' }, h('span', null, pspan('amt', '', 'b'), pspan('per', 'co-stage-foot-per')), h('small', null, 'all three tools · cancel anytime')), footCta),
      sublinks({ stage: true }));
    // fixer r7 (D9): a non-modal side panel (role=region, named "Launch <bot>"): the Builder beside it stays live, the
    // covered SampleBot is inert and shown un-dimmed behind a click-to-close veil (no modal scrim)
    const panel = h('section', { class: 'co-stage', id: 'co-stage', role: 'region', 'aria-label': `Launch ${botName()}`, tabindex: '-1' }, head, holder, foot);
    footCta.addEventListener('click', () => openSheet({ source: 'card', from: stage?.inst?.receipt || null, invoker: footCta }));
    const layer = h('div', { class: 'co-stage-layer is-right', dataset: { kind: 'launch-stage' } }, h('div', { class: 'co-stage-backdrop', 'aria-hidden': 'true' }), panel);
    modal.append(layer);
    const returnTo = ae0 && ae0 !== document.body && !(botPane && botPane.contains(ae0)) ? ae0 : null;
    stage = { layer, panel, headEl, opener, returnTo, cleanup: [], float: false, prevInert: null };
    placeStage(r0);
    if (!stage) return null;
    // fixer r5 (D6): the receipt content is built one task after the shell (the proxy is already flying), so building
    // the card and laying out the shell never land in the same long frame. The covered SampleBot is taken out of the
    // tab order in that same slice (its style recalc is not stacked on the shell's frame), restored on close.
    // CONTRACT-GAP (B): #st-bot is B's pane; only its inert flag is toggled, never its content.
    const st0 = stage;
    st0.build = () => {
      if (stage !== st0 || st0.inst) return;
      // fixer r6 (D6): the pane's inert flag restyles its whole subtree, so it is set in an idle slot after the reveal
      // (the dim backdrop already catches pointer input meanwhile), never in the same frame as the card build
      if (botPane && !st0.inerted) {
        st0.inerted = true;
        const was = botPane.inert;
        const idle = (fn, ms) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: ms }) : setTimeout(fn, ms / 2));
        const setInert = () => { if (stage === st0) { botPane.inert = true; st0.cleanup.push(() => { if (st0.uninertNow) botPane.inert = was; else idle(() => { if (!stage) botPane.inert = was; }, 600); }); } };
        idle(setInert, 1500);
      }
      st0.inst = buildFullCard(holder, { where: 'stage' });
    };
    st0.cleanup.push(() => { for (const n of (st0.inst && st0.inst.deferred) || []) n.style.contentVisibility = ''; });
    if (opener) { opener.setAttribute('aria-expanded', 'true'); const l = [...launchCards].find((c) => c.view === opener); if (l) l.viewLabel.textContent = 'Hide receipt'; }

    // keep it docked to the pane: window resizes, the drawer docking as a 3rd column, the spine changing height
    const onResize = () => placeStage();
    window.addEventListener('resize', onResize);
    stage.cleanup.push(() => window.removeEventListener('resize', onResize));
    const pane = document.getElementById('st-bot');
    if (pane && typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => placeStage()); ro.observe(pane); stage.cleanup.push(() => ro.disconnect()); }
    // fixer r4 (D8): the Builder card folds to a one-line stub underneath (no CTA, no anchors): the panel's sticky bar is
    // the only Launch button. It folds after the morph has measured the card (below).
    stage.cleanup.push(() => { if (foldForSheet) return; for (const c of launchCards) if (c.kind === 'summary' && c.collapse) c.collapse(false, 'receipt', { instant: true, fade: true }); });
    syncCtaFlag();
    // fixer r7 (D9): the panel is the topmost surface, so Esc closes it from anywhere (inside it, the folded launch stub,
    // <body>, the Builder), except while another dialog, menu or popover is open or a text field holds a draft: those
    // keep their own Esc. Focus then goes back to the control that opened it (stageReturnTarget).
    const onKey = (e) => {
      if (sheet || !stage || stage.panel !== panel || e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && !panel.contains(a)) {
        if (a.closest && a.closest('[role="dialog"], [role="menu"], [role="listbox"], [popover], [aria-modal="true"]')) return;
        if ((a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|submit|checkbox|radio)$/.test(a.type))) && a.value) return;
        if (document.querySelector('[aria-expanded="true"][aria-haspopup]')) return;
      }
      e.preventDefault(); e.stopPropagation(); closeStage({ focus: true });
    };
    document.addEventListener('keydown', onKey, true);
    stage.cleanup.push(() => document.removeEventListener('keydown', onKey, true));
    closeBtn.addEventListener('click', () => closeStage({ focus: true }));
    // fixer r7 (D9/D10): the veil over the live bot is a light dismiss: the click closes the panel and lands where it
    // was aimed (a text field under the pointer takes focus), so the bot never needs a second click
    layer.querySelector('.co-stage-backdrop').addEventListener('click', (e) => {
      st0.uninertNow = true;
      const x = e.clientX, y = e.clientY;
      closeStage({ focus: false });
      const under = document.elementFromPoint(x, y);
      const field = under && under.closest && under.closest('textarea, input, button, a[href], [tabindex]:not([tabindex="-1"])');
      if (field && !field.closest('[inert]')) { try { field.focus({ preventScroll: true }); } catch { /* ignore */ } }
      else { const t = stageReturnTarget(st0); if (t) try { t.focus({ preventScroll: true }); } catch { /* ignore */ } }
    });

    // fixer r5 (D6): fold the Builder card to its stub FIRST (instant if it was mounted folded), so the morph starts from
    // the stub's final rect and the log never reflows mid-flight. Then a text-free proxy surface flies from the stub to
    // the pane (scaling an empty box never distorts glyphs), and the real panel is revealed in place with a clip-path
    // wipe + fade: the receipt text is never scaled.
    for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(true, 'receipt', { instant: true });
    // fixer r6 (D8): the receipt is a right-side sheet of at most 560 px; the live bot stays visible (dimmed) beside it
    const sw = Math.min(STAGE_W, Math.round(r0.width));
    const tr = { left: Math.round(r0.left + r0.width - sw), top: Math.round(r0.top), width: sw, height: Math.round(r0.height) };
    stage.rect = tr;   // fixer r7 (D6): checkout reads the panel's place from here, never from layout inside its click
    const bd = layer.querySelector('.co-stage-backdrop');
    {
      const fly = !motion.reduced() && fr && fr.width && tr.width;
      const t0 = performance.now();
      panel.style.opacity = '0';
      if (fly) {
        stageProxy(fr, tr, { duration: motion.DUR[3] + 120 });
        motion.animate(bd, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.DUR[3], easing: 'out' });
      }
      // one slice per frame: card (receipt column) → plan column → embed preview → reveal
      const slice = (fn) => new Promise((res) => requestAnimationFrame(() => setTimeout(() => { if (stage === st0) fn(); res(); }, 0)));
      (async () => {
        await slice(() => st0.build());
        for (const n of (st0.inst && st0.inst.deferred) || []) await slice(() => { n.style.contentVisibility = ''; });
        if (st0.inst) st0.inst.deferred = [];
        requestAnimationFrame(() => {
          if (stage !== st0) return;
          const wait = Math.max(0, motion.DUR[3] - 60 - (performance.now() - t0));
          if (fly) {
            motion.animate(panel, [
              { opacity: 0, clipPath: 'inset(0 0 100% 0 round 18px)' },
              { opacity: 1, clipPath: 'inset(0 0 0 0 round 0px)' },
            ], { duration: motion.DUR[3], delay: wait, easing: 'out', fill: 'backwards' });
          } else motion.animate(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'out', reducedFade: true });
          panel.style.opacity = '';
        });
      })();
    }
    // Focus: a visitor who clicked into this moves with it; one typing in a composer is left alone.
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type !== 'button'));
    if (focus === true || (focus === 'auto' && !typing)) requestAnimationFrame(() => { if (stage === st0) focusStageHead(); });
    // fixer r7 (D9): an auto-open says what just appeared; a user-initiated one also says where focus went
    announce(auto
      ? `${botName()} is ready to launch: receipt and plan opened beside the Builder, ${price().long}. Press Escape or ${backLabel()} to close it.`
      : `Receipt and plan for ${botName()}, ${price().long}, opened beside the Builder. ${backLabel()} closes it.`, 'polite');
    preloadGoLive();
    return stage;
  }

  /** A text-free surface (panel colour, accent edge) that flies between two rects with transform only, then fades. */
  function stageProxy(a, b, { duration = 420, reverse = false } = {}) {
    const px = h('div', { class: 'co-stage-proxy', 'aria-hidden': 'true' });
    Object.assign(px.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    modal.append(px);
    const sx = Math.max(0.02, a.width / b.width), sy = Math.max(0.02, a.height / b.height);
    const fromT = `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${sx}, ${sy})`;
    const an = motion.animate(px, [
      { transform: fromT, opacity: reverse ? 0.9 : 1 },
      { transform: 'none', opacity: reverse ? 0 : 1, offset: reverse ? 1 : 0.82 },
      ...(reverse ? [] : [{ transform: 'none', opacity: 0 }]),
    ], { duration: reverse ? duration : duration + motion.DUR[2], easing: 'spring', fill: 'forwards' });
    const rm = () => px.remove();
    Promise.resolve(an && an.finished).catch(() => {}).then(rm);
    setTimeout(rm, duration + 900);
    return px;
  }

  function closeStage({ focus = false, morph = false } = {}) {
    if (!stage) return;
    const s = stage; stage = null;
    // fixer r6 (D6): every read first (the folded card's rect, the panel's rect), then only writes
    const opener = s.opener && s.opener.isConnected ? s.opener : null;
    const hadFocus = s.layer.contains(document.activeElement);
    const cr = !motion.reduced() && opener && !morph ? opener.closest('.co-launch')?.getBoundingClientRect() : null;
    const to = cr && cr.width ? { left: cr.left, top: cr.top, width: cr.width, height: Math.max(56, Math.min(cr.height, 160)) } : null;
    const pr = !motion.reduced() && !morph ? s.panel.getBoundingClientRect() : { width: 0 };
    for (const fn of s.cleanup.splice(0)) { try { fn(); } catch { /* ignore */ } }
    if (s.inst) launchCards.delete(s.inst);
    syncCtaFlag();
    if (opener) { opener.setAttribute('aria-expanded', 'false'); const l = [...launchCards].find((c) => c.view === opener); if (l) l.viewLabel.textContent = 'Receipt & plan'; }
    s.layer.style.pointerEvents = 'none';
    // fixer r5 (D6): the panel fades/wipes away in place (no scaled text) while a text-free proxy flies back to the card.
    const kf = [{ opacity: 1, clipPath: 'inset(0 0 0 0)' }, { opacity: 0, clipPath: 'inset(0 0 100% 0)' }];
    if (!motion.reduced() && to && pr.width) stageProxy(pr, to, { duration: motion.DUR[3], reverse: true });
    // fixer r7 (D8): checkout opening from the same edge: the receipt dissolves in place under the arriving sheet
    const a = motion.animate(s.panel, motion.reduced() || morph ? [{ opacity: 1 }, { opacity: 0 }] : kf, { duration: motion.reduced() ? 120 : morph ? motion.DUR[3] : motion.DUR[2], easing: 'inOut', fill: 'forwards' });
    motion.animate(s.layer.querySelector('.co-stage-backdrop'), [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[2], fill: 'forwards' });
    Promise.resolve(a && a.finished).catch(() => {}).then(() => s.layer.remove());
    setTimeout(() => s.layer.remove(), 900);
    // focus moves one frame later, so focus() never forces the unfolded card's layout inside this click
    // fixer r7 (D9): back to the control that opened it (Builder/header/launch card), else the card's own control
    if ((focus || hadFocus) && !morph) requestAnimationFrame(() => setTimeout(() => { const t = stageReturnTarget(s); if (t) { try { t.focus({ preventScroll: true }); } catch { /* ignore */ } } }, 0));
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
            qa ? h('p', { class: 'co-em is-bot is-ans' }, qa.answer, h('sup', { class: 'co-em-cite' }, String(qa.cite?.n || 1))) : null,
            qa ? h('p', { class: 'co-em-src' }, `[${qa.cite.n || 1}] ${qa.cite.file || qa.cite.title || ''}`) : null)),
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
    // perf (M): restart the caret a frame later instead of forcing a reflow (void offsetWidth) to restart it
    e.classList.remove('is-caret');
    requestAnimationFrame(() => requestAnimationFrame(() => { if (e.isConnected) e.classList.add('is-caret'); }));
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
        // fixer r7 (D9): a user pick that docks the receipt panel moves focus to its heading; else to the card
        const docked = userPick && !stage && live.view && canDock() ? openStage({ from: live.card, opener: live.view, focus: true }) : null;
        if (userPick && stage && !docked) focusStageHead();
        if (userPick && !stage && live.heading) {
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
      pickFocus = userPick ? ae : null;
      autoStageNext = true;
      emit('setup:post', { role: 'assistant',
        text: showText ? `${botName()} is built and saved. Launch it to get a hosted link and embed code in under a minute.` : '',
        card: { type: 'launch', data: { variant: 'launch' } },
        chips: showText ? [
          // Launch + Keep testing are on the summary card itself; the chips offer the next questions instead.
          { id: 'what-get', label: 'What do I get?', send: 'What do I get?' },
          { id: 'co-channels', label: 'Test it before going live', local: true, run: () => openGoLive({ tab: 'channels' }) },
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
    // fixer r6 (D8): a sample-only bot is told at the moment of payment that its sample files do not carry over
    const one = sampleOnly() ? [`Sample files (removed at launch): ${st.files}`, tests].join(' · ') : [plural(st.files, 'file'), `${mbOf(st.bytes)} MB`, plural(st.atoms, 'atom'), tests].join(' · ');
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
    const chip = h('button', { type: 'button', class: 'co-cite', 'aria-expanded': 'false', 'aria-controls': exId, 'aria-label': `Citation ${c.n || 1}: ${c.title || c.file || 'source'}. Shows the quoted line.` }, String(c.n || 1));
    chip.addEventListener('click', () => {
      const open = ex.hidden; ex.hidden = !open; chip.setAttribute('aria-expanded', String(open));
      if (open) motion.animate(ex, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], easing: 'out' });
    });
    return h('figure', { class: 'co-sr-qa' },
      h('figcaption', { class: 'co-qa-q' }, h('span', { class: 'co-qa-k' }, 'Q'), h('span', null, qa.question)),
      h('blockquote', { class: 'co-qa-a' }, h('span', { class: 'co-qa-k' }, 'A'), h('span', null, qa.answer, NBSP, chip)),
      ex);
  }

  async function openSheet({ source = 'card', from = null, invoker = null, kdChecked = false } = {}) {
    if (sheet) { sheet.email?.focus(); return; }
    if (kdNeeded() && !kdChecked) {
      let k = null;
      try { k = await kdStep(); if (!k.isReady()) await k.status(); } catch { k = null; }
      if (k && !k.isReady()) {
        k.open({ invoker: invoker || document.activeElement, onContinue: ({ email } = {}) => { kdEmail = email || kdEmail; openSheet({ source, from: null, invoker, kdChecked: true }); } });
        return;
      }
      kdEmail = k?.last?.email || kdEmail;
    }
    preloadGoLive();
    // fixer r4 (D8, blocker): desktop checkout is a 440 px sheet on the right, over the SampleBot pane, with the bot thread
    // unblurred beside it (a light, blur-free scrim). The receipt panel closes first, so the receipt exists once.
    const side = !isMobile();
    // fixer r7 (D8): checkout continues the receipt panel from the same (right) edge: the panel dissolves in place while
    // the email step slides in over it at the same width, so the live bot stays visible on the left the whole time
    let stageW = 0;
    // the sheet starts where the bot pane starts (under the header and the step spine), exactly like the receipt panel
    const paneTop = side ? Math.max(0, Math.round((stage && stage.rect ? stage.rect.top : botPaneRect()?.top) || 0)) : 0;
    if (side && stage) {
      stageW = stage.rect ? stage.rect.width : STAGE_W;
      foldForSheet = true; try { closeStage({ focus: false, morph: true }); } finally { foldForSheet = false; } from = null;
    }
    // the Builder card stays folded to its one-line stub while checkout is open: the receipt exists once, in the sheet
    if (side) for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(true, 'checkout');
    const pr = price();
    const t = getState().trial;
    const receipt = sheetReceipt();
    const emailIn = h('input', { type: 'email', id: 'co-email', name: 'email', class: 'input co-input', autocomplete: 'email', inputmode: 'email', spellcheck: 'false', required: true,
      'aria-describedby': 'co-email-hint', placeholder: 'you@company.com' });
    emailIn.value = t.email || kdEmail || '';
    const emailErr = h('p', { class: 'form-error co-field-err', id: 'co-email-err', hidden: true });
    const submit = h('button', { type: 'submit', class: 'co-cta co-cta-lg' }, h('span', { class: 'co-spin', 'aria-hidden': 'true' }), h('span', { class: 'co-cta-label', dataset: { coPrice: 'submit' } }, `Continue to secure checkout · ${pr.text}`), h('span', { class: 'co-cta-ico', html: icon('lock', 15) }));
    const errBox = h('div', { class: 'co-err', role: 'alert', hidden: true });
    const samples = sampleOnly();
    const addFirst = samples ? h('p', { class: 'co-addfirst' }, h('span', { html: icon('upload', 13) }),
      h('span', null, `${botName()} only knows sample files. `, h('button', { type: 'button', class: 'co-link', onclick: () => { closeSheet('addfiles'); addOwnFiles(); } }, 'Add my files first'))) : null;
    const form = h('form', { class: 'co-form', novalidate: true },
      h('label', { class: 'flabel co-label', for: 'co-email' }, 'Email for your KnowDrive login'),
      emailIn,
      h('p', { class: 'co-hint', id: 'co-email-hint' }, 'We send your login and your bot link here. No other field.'),
      emailErr, addFirst, submit, errBox);
    const back = h('button', { type: 'button', class: 'co-link co-back' }, h('span', { html: icon('arrowRight', 14), class: 'co-back-ico' }), 'Back to my bot');
    const x = h('button', { type: 'button', class: 'co-x', 'aria-label': 'Close and go back to my bot', html: icon('x', 18) });
    const pay = h('section', { class: 'co-pay' },
      h('p', { class: 'co-eyebrow' }, h('span', { html: icon('rocket', 13) }), 'Launch'),
      h('h2', { class: 'co-sheet-title', id: 'co-sheet-title' }, `Launch ${botName()}`),
      h('p', { class: 'co-sheet-desc', id: 'co-sheet-desc' }, h('b', null, 'KnowDrive · ', pspan('amt', ''), pspan('per', '')), '. You finish on KnowDrive\'s secure checkout, then come straight back here.'),
      planBlock(),
      form,
      h('p', { class: 'co-foot co-foot-incl' }, h('span', { html: icon('check', 13) }), `Includes hosting, Website, KnowBot number and Email + the chat API, ${stats().quotaMB} MB of storage, question insights.`),
      h('p', { class: 'co-foot' }, pspan('today', ''), samples
        ? 'Your settings, tone and tests carry over; sample files are removed, so add your own docs after launch.'
        : 'Your bot, files and tests carry over. Nothing gets rebuilt.'),
      h('p', { class: 'co-foot co-foot-trust' }, h('span', { html: icon('lock', 12) }), `Saved for ${cfg().quota?.ttlDays || 7} days if you don't launch. `, h('a', { class: 'co-link', href: contactHref() }, 'Questions? Talk to us')),
      back);
    // fixer r5 (D8): the docked sheet is full height; below the form, the embed preview fills it with what they are
    // buying (the form and its CTA stay above the fold).
    // fixer r7 (D6): below the fold, so it is laid out two frames after the sheet (content-visibility), never in the
    // frame that slides the sheet in
    const sideEmbed = side ? h('div', { class: 'co-sr-embed', style: { contentVisibility: 'hidden' } }, h('p', { class: 'co-eyebrow' }, 'On your site'), embedPreview(lastQA())) : null;
    if (sideEmbed) requestAnimationFrame(() => nextSlice(() => { sideEmbed.style.contentVisibility = ''; }));
    const dialog = h('div', { class: 'co-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'co-sheet-title', 'aria-describedby': 'co-sheet-desc' }, x, receipt, pay, sideEmbed);
    const scrim = h('div', { class: 'co-scrim', 'aria-hidden': 'true' });
    // fixer r6 (D8/D10): phones get an 85%-height bottom sheet; above it the live bot's last cited answer peeks
    // through (tap it to go back to the bot). The peek is a visual echo of the receipt's own Q&A, so it is aria-hidden.
    const qa0 = !side ? lastQA() : null;
    const peek = !side ? h('div', { class: 'co-peek', 'aria-hidden': 'true', style: { '--co-hue': hueVar() } },
      h('span', { class: 'co-peek-head' }, avatar(22), h('b', null, botName()), h('span', { class: 'co-peek-on' }, h('i', { class: 'co-dot is-ready' }), converted() ? 'live bot' : 'your bot (draft)')),
      qa0 ? h('span', { class: 'co-peek-a' }, qa0.answer, NBSP, h('span', { class: 'co-peek-cite' }, String(qa0.cite?.n || 1))) : h('span', { class: 'co-peek-a' }, getState().spec.greeting || `Ask ${botName()} anything.`)) : null;
    const layer = h('div', { class: `co-layer${side ? ' is-side' : ' is-bottom'}`, dataset: { kind: 'checkout' } }, scrim, peek, dialog);
    if (peek) peek.addEventListener('click', () => closeSheet('back'));
    // fixer r7 (D8): desktop checkout docks on the RIGHT, the same edge as the receipt panel it continues (and at its
    // width), so the brand/header and the Builder stay put on the left and the spatial model never flips.
    if (side) { layer.style.setProperty('--co-side-w', `${Math.round(Math.max(440, Math.min(560, stageW || 480)))}px`); layer.style.setProperty('--co-side-top', `${paneTop}px`); }
    const ae0 = document.activeElement;
    sheet = { layer, dialog, scrim, peek, receipt, email: emailIn, invoker: invoker || (ae0 && ae0 !== document.body ? ae0 : null), redirecting: false, prevInert: slots.app ? slots.app.inert : false, source, side };
    const dockFrom = () => (side ? (stageW ? 'translateX(24px)' : 'translateX(56px)') : isMobile() ? 'translateY(38%)' : 'translateY(14px) scale(.98)');

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
      // focus lands with the dialog, not after the morph finishes (a slow view transition must not leave focus behind).
      // fixer r7 (D6): without a view transition it moves on the next frame (below), once the sheet has been laid out by
      // the browser anyway, so focus() never forces a synchronous restyle of the whole page in this click.
      if (vtNative) { try { emailIn.focus({ preventScroll: true }); } catch { /* not focusable yet */ } }
      // fixer r7 (D6): taking the whole app out of the tab order restyles every node, so it happens one frame later,
      // never in the frame that lays out the sheet (the scrim already blocks pointers; the Tab trap guards keys)
      // fixer r7 (D6/D9): making the app inert restyles every node (30+ ms on a throttled CPU), so it happens in an idle
      // slot once the sheet has finished arriving; until then the dialog is aria-modal, the Tab trap keeps keyboard
      // focus inside and the scrim takes pointers
      const S = sheet;
      nextSlice(() => { if (sheet === S) setState({ ui: { ...getState().ui, sheet: 'checkout' } }, 'sheet:checkout'); });
      setTimeout(() => {
        const go = () => { if (sheet === S && slots.app) { slots.app.inert = true; S.inerted = true; } };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 800 }); else go();
      }, motion.reduced() ? 0 : 520);
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
      // fixer r7 (D6): five groups, not every row (each animated node is its own layer to paint in the arrival frame)
      if (side && !motion.reduced()) motion.stagger([receipt, ...[...pay.children].slice(0, 4)], [{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2], delay: 90, easing: 'out', fill: 'backwards' }, 40);
    }
    syncCtaFlag();
    if (peek && !motion.reduced()) motion.animate(peek, [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[3], delay: 140, easing: 'out', fill: 'backwards' });
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
        const r = await api.checkout({ email, surfaces: normalizeSurfaces(getState().spec?.surfaces), interval: planInterval });
        if (!r || !r.url) throw new Error('no url');
        try { store.persist(); } catch { /* ignore */ }
        await sleep(motion.reduced() ? 0 : 120);
        location.assign(withRestoreKey(r.url));
      } catch (err) {
        sheet.redirecting = false;
        submit.disabled = false; submit.removeAttribute('aria-busy'); submit.classList.remove('is-busy');
        $('.co-cta-label', submit).textContent = PRICE_KINDS.submit(price());
        // the KnowDrive step is not finished (signed out, sign-in expired): back to it
        if (err && /^kd_/.test(err.code || '')) { closeSheet('kd'); setTimeout(() => kdStep().then((k) => k.open({ onContinue: () => openSheet({ source: 'card', kdChecked: true }) })).catch(() => {}), motion.reduced() ? 60 : 480); return; }
        if (err && err.status === 400 && /email/i.test(err.message || '')) { emailErr.textContent = err.message; emailErr.hidden = false; emailIn.setAttribute('aria-invalid', 'true'); emailIn.focus(); return; }
        const retry = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small' }, h('span', { html: icon('refresh', 14) }), 'Try again');
        retry.addEventListener('click', () => go());
        const wait = err && err.status === 429 && err.retryAfter ? ` Try again in ${err.retryAfter}s.` : '';
        errBox.append(h('span', { class: 'co-err-ico', html: icon('warn', 15) }), h('span', null, `Couldn't open checkout. Your bot is safe.${wait}`), retry);
        errBox.hidden = false;
        motion.animate(errBox, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: motion.DUR[2] });
      }
    }
  }

  /** fixer r7 (D8): the return link carries the trial's restore key (?t=&k=, the share-link form B's boot already
   *  exchanges via POST /restore), so finishing payment in another browser or an in-app webview lands in Activating on
   *  that device too. CONTRACT-GAP (A): /checkout builds return=…/studio/?t=<id>&launched=1 without k; it could add it
   *  server-side. Until then the client appends it to the return param before redirecting. */
  function withRestoreKey(url) {
    const k = getState().trial.restoreKey;
    if (!k) return url;
    try {
      const u = new URL(url, location.href);
      const ret = u.searchParams.get('return');
      if (!ret) return url;
      const ru = new URL(ret, location.href);
      if (ru.searchParams.get('k')) return url;
      ru.searchParams.set('k', k);
      // CONTRACT-GAP (B): ensureTrial() rewrites the URL to ?t=<id> after exchanging k, dropping launched=1 before this
      // module mounts; the hash survives that rewrite, so it carries the return flag too.
      ru.hash = 'launched';
      u.searchParams.set('return', ru.toString());
      return u.toString();
    } catch { return url; }
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
    s.layer.style.pointerEvents = 'none';
    // fixer r7 (D6): the exit animations start in this frame; the expensive restyles (the app leaving inert, the card
    // unfolding, the CTA flag on :root) follow in their own frames, and the Builder's "it's saved" turn after that
    const uninert = () => { if (s.inerted && slots.app) slots.app.inert = !!s.prevInert; };
    const finish = () => {
      setState({ ui: { ...getState().ui, sheet: null } }, 'sheet:close');
      if (sheet) { uninert(); return; }
      syncCtaFlag();
      if (s.side && reason !== 'redirect') for (const c of launchCards) if (c.kind === 'summary' && c.collapse && c.el.isConnected) c.collapse(false, 'receipt', { fade: true });
      // one frame each: the app leaves inert, then focus returns (after the browser has laid it out: no forced layout)
      nextSlice(() => { uninert(); nextSlice(refocus); });
    };
    if (reason === 'redirect' || reason === 'destroy') { uninert(); setState({ ui: { ...getState().ui, sheet: null } }, 'sheet:close'); syncCtaFlag(); }
    else nextSlice(finish);
    const out = [
      motion.animate(s.scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[2], fill: 'forwards' }),
      motion.animate(s.dialog, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: s.side ? 'translateX(48px)' : isMobile() ? 'translateY(40px)' : 'translateY(10px) scale(.985)' }], { duration: motion.DUR[2], easing: 'inOut', fill: 'forwards' }),
      s.peek ? motion.animate(s.peek, [{ opacity: 1 }, { opacity: 0 }], { duration: motion.DUR[1] || 120, fill: 'forwards' }) : null,
    ];
    Promise.all(out.map((a) => a && a.finished)).catch(() => {}).then(() => s.layer.remove());
    setTimeout(() => s.layer.remove(), 700);   // never leave a dead layer behind if an animation is starved
    // Focus goes back to the invoker; if it is gone (a re-rendered chip, the palette) the newest launch card's CTA, then
    // the header Launch button, then the Builder composer. Never <body>.
    function refocus() {
      if (reason === 'redirect' || reason === 'destroy') return;
      const usable = (n) => n && n !== document.body && n.isConnected && !n.closest('[inert]') && !n.closest('[hidden]') && n.getClientRects().length > 0;
      const inv = [s.invoker, [...launchCards].filter((c) => c.el.isConnected && c.kind === 'summary').pop()?.cta, document.getElementById('st-price'), document.getElementById('st-setup-composer')].find(usable);
      if (inv) { try { inv.focus({ preventScroll: false }); } catch { /* ignore */ } }
    }
    if (reason !== 'redirect' && reason !== 'proof' && reason !== 'addfiles' && reason !== 'destroy' && reason !== 'kd') {
      announce(`${botName()} is saved for ${cfg().quota?.ttlDays || 7} days.`, 'polite');
      // One Builder "no problem, it's saved" turn per visit, not one per close (repeat closes read as nagging). It is
      // posted once the sheet has left, so the new turn's layout never lands in the exit animation's frames.
      if (Date.now() - lastDismissAt > 120000) setTimeout(() => emit('checkout:dismissed', {}), motion.reduced() ? 0 : 420);
      lastDismissAt = Date.now();
    }
  }
  function nextSlice(fn) { requestAnimationFrame(() => setTimeout(fn, 0)); }

  // ================================================================== Return / Live (B11)

  let activatingKey = null, pollGen = 0;
  // fixer r6 (D7/D8): the header pill follows the activation. CONTRACT-GAP (B): B's #st-price shows a spinner
  // "Activating…" on a 25 s timer and has no pending state. E publishes :root[data-co-act="checking"|"pending"];
  // checkout.css keeps the "Activating…" label on phones too and, once pending, swaps the spinner pill for a static
  // "Setup pending" outline pill (the Builder card carries "Check again"). B may read the attribute instead.
  function setActFlag(v) {
    const root = document.documentElement;
    if (v) { if (root.getAttribute('data-co-act') !== v) root.setAttribute('data-co-act', v); } else if (root.hasAttribute('data-co-act')) root.removeAttribute('data-co-act');
  }
  const cardInst = { activating: null, success: null };

  registerCard('activating', (data, el) => {
    const title = h('b', { class: 'co-act-title' });
    const text = h('span', { class: 'co-act-msg' });
    // the clock ticks every second but is aria-hidden: only state changes are announced (live span below)
    const clk = h('span', { class: 'co-act-clock', 'aria-hidden': 'true' });
    const line = h('p', { class: 'co-act-text' }, text, clk);
    const live = h('span', { class: 'co-sr', role: 'status' });
    const meter = h('div', { class: 'co-act-meter', role: 'progressbar', 'aria-label': 'Checking with KnowDrive', 'aria-valuemin': '0', 'aria-valuemax': String(POLL_MAX_MS / 1000) }, h('i'));
    const skel = h('div', { class: 'co-act-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i', { class: 'is-short' }));
    // fixer r2 (D8): the pending state lives in this one card (replaced in place), with its own next actions; no
    // duplicate Builder turn repeating the same sentence.
    const again = h('button', { type: 'button', class: 'btn btn-ghost co-btn co-btn-ghost is-small' }, h('span', { html: icon('refresh', 14) }), 'Check now');
    again.addEventListener('click', () => { if (pollWake) pollWake(); else pollConversion(); });
    const keep = h('button', { type: 'button', class: 'btn btn-primary co-btn co-btn-primary is-small' }, 'Keep testing');
    keep.addEventListener('click', () => focusBotComposer());
    const acts = h('div', { class: 'co-act-actions', hidden: true }, keep, again);
    const card = h('div', { class: 'co-act' },
      h('div', { class: 'co-act-head' }, h('span', { class: 'co-act-ico', html: icon('rocket', 16) }), h('div', null, title, line)), meter, skel, acts, live);
    el.append(card);
    let st = null, t0 = Date.now() - (Number(data && data.elapsed) || 0), tick = 0;
    const paintClock = () => {
      const e = Date.now() - t0;
      clk.textContent = st === 'checking' || st === 'pending' ? ` · ${clock(e)}` : '';
      meter.setAttribute('aria-valuenow', String(Math.min(POLL_MAX_MS, e) / 1000 | 0));
      meter.firstElementChild.style.transform = `scaleX(${Math.min(1, e / POLL_MAX_MS)})`;
    };
    function update(d = {}) {
      const next = d.state || 'checking';
      if (d.t0) t0 = d.t0;
      const changed = next !== st;
      st = next;
      card.dataset.state = st;
      setActFlag(st === 'done' ? null : st === 'slow' ? 'pending' : st);
      acts.hidden = !(st === 'pending' || st === 'slow');
      meter.hidden = !(st === 'checking' || st === 'pending');
      skel.hidden = st !== 'checking';
      const email = getState().trial.email;
      if (st === 'checking') { title.textContent = `Activating ${botName()}…`; text.textContent = 'Checking with KnowDrive'; }
      else if (st === 'pending') { title.textContent = 'Payment received? We\'re finishing setup.'; text.textContent = 'Checking again automatically every 5 s · usually under a minute'; }
      else if (st === 'slow') { title.textContent = 'Taking longer than usual: we\'ll email you'; text.textContent = `We'll email ${email || 'you'} the moment ${botName()} is live. Keep testing meanwhile: your bot is saved.`; }
      else if (st === 'done') { title.textContent = 'Payment confirmed'; text.textContent = `${botName()} moved to your KnowDrive account.`; card.querySelector('.co-act-ico').innerHTML = icon('checkCircle', 16); }
      paintClock();
      clearInterval(tick);
      if (st === 'checking' || st === 'pending') tick = setInterval(() => { if (!card.isConnected) { clearInterval(tick); return; } paintClock(); }, 1000);
      if (changed) live.textContent = st === 'checking' ? `Activating ${botName()}. Checking with KnowDrive.` : `${title.textContent} ${text.textContent}`;
      if (changed && st !== 'checking' && !motion.reduced()) motion.animate(card, [{ transform: 'translateY(3px)', opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: motion.DUR[2], easing: 'out' });
    }
    update(data);
    const inst = { update, destroy() { clearInterval(tick); if (cardInst.activating === inst) { cardInst.activating = null; setActFlag(null); } } };
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
      data.ownFiles === 0 ? h('div', { class: 'alert alert-warn co-success-empty', role: 'note' },
        h('span', { class: 'co-success-empty-ico', html: icon('upload', 16) }),
        h('div', null, h('b', null, 'Sample files were removed at launch'), h('small', null, `${botName()} keeps your settings, tests and tone. Add your docs and it starts answering from them.`)),
        h('button', { type: 'button', class: 'btn btn-primary co-btn co-btn-primary is-small', onclick: () => addOwnFiles() }, h('span', { html: icon('upload', 14) }), 'Add your files')) : null,
      // fixer r7 (D8): one solid next step per Live card: "Add your files" when the samples were removed, else "Copy
      // embed". The dashboard is an outline link; channels and the API are the turn's chips (never repeated here).
      h('div', { class: 'co-codewrap' }, h('div', { class: 'co-code-head' }, h('span', null, 'Embed on your site'), copyButton(embed, 'Copy embed', { small: true, what: 'Embed code copied', primary: data.ownFiles !== 0 })), code),
      h('div', { class: 'co-success-actions' },
        h('a', { class: 'btn btn-ghost co-btn co-btn-ghost', href: dash, target: '_blank', rel: 'noopener' }, 'Open KnowDrive dashboard', h('span', { html: icon('external', 14) }), h('span', { class: 'co-sr' }, ' (opens in a new tab)'))));
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
    setActFlag(null);
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
      // fixer r7 (D8): the chips never repeat the card's buttons (Add your files, Copy embed, dashboard live on the card)
      // and none is solid: the card holds the one primary next step. CONTRACT-GAP (B): app.js sayLive() re-posts the
      // Live turn on a reload with its own chips; it should offer these same two.
      chips: [
        { id: 'co-channels', label: 'Set up channels', local: true, run: () => openGoLive({ tab: 'channels' }) },
        { id: 'co-dev', label: 'Developer API', local: true, run: () => openGoLive({ tab: 'developers' }) },
      ] });
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

  let pollWake = null;
  async function pollConversion() {
    const gen = ++pollGen;
    const t0 = Date.now();
    if (!cardInst.activating || !cardInst.activating.update) {
      emit('setup:post', { role: 'assistant', text: '', card: { type: 'activating', data: { state: 'checking', elapsed: 0 } }, scroll: true });
    }
    cardInst.activating?.update({ state: 'checking', t0 });
    for (;;) {
      if (gen !== pollGen) return;
      let r = null;
      try { r = await api.getTrial(); } catch { r = null; }
      if (gen !== pollGen) return;
      const elapsed = Date.now() - t0;
      if (r && r.converted) {
        pollWake = null;
        cardInst.activating?.update({ state: 'done' });
        setState({ trial: { ...getState().trial, converted: true } }, 'converted');
        postSuccess({ burst: true, data: { botUrl: r.botUrl, embed: r.embed, dashboardUrl: r.dashboardUrl, botId: r.botId, convertedFiles: r.convertedFiles, files: r.files } });
        return;
      }
      if (elapsed >= POLL_MAX_MS) {
        pollWake = null;
        cardInst.activating?.update({ state: 'slow' });
        return;   // the card announces its own state; "Check now" restarts a fresh 2-minute poll
      }
      cardInst.activating?.update({ state: elapsed >= POLL_FOR_MS ? 'pending' : 'checking' });
      // a background poll; "Check now" wakes it early
      await new Promise((res) => { const t = setTimeout(res, elapsed >= POLL_FOR_MS ? POLL_SLOW_MS : POLL_MS); pollWake = () => { clearTimeout(t); pollWake = null; res(); }; });
    }
  }

  sub('trial:ready', (d) => {
    const launched = params.get('launched') === '1' || /^#launched\b/.test(location.hash);
    const t = getState().trial;
    if (launched && !activatingKey) {
      activatingKey = t.id;
      // Reloading should not re-run the activation beat; keep ?t= for B.
      try { const u = new URL(location.href); u.searchParams.delete('launched'); u.searchParams.delete('k'); if (/^#launched\b/.test(u.hash)) u.hash = ''; history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash); } catch { /* ignore */ }
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
  // fixer r5 (D6): the speculative preload waits for an idle slot, so parsing golive.js never lands in a morph frame
  function preloadGoLive({ now = false } = {}) {
    if (!goLiveMod && !now) {
      if (!preloadGoLive.queued) {
        preloadGoLive.queued = true;
        const go = () => preloadGoLive({ now: true });
        if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 1200);
      }
      return null;
    }
    if (!goLiveMod) goLiveMod = import('./golive.js?v=581e55b').then((m) => { m.ensureCss?.(); return m; }).catch((err) => { console.error('[studio] golive.js failed to load', err); goLiveMod = null; return null; });
    return goLiveMod;
  }
  async function openGoLive({ tab = 'channels', channel = null, invoker = null } = {}) {
    // fixer r3 (D9): record the real invoker. Without one (palette, a chip that re-renders) only a focused control in the
    // Builder, header or a launch card counts; anything else (a SampleBot chip, a mobile tab) lets golive.js fall back
    // to the launch card's channels control, the BotChip or the Builder composer.
    const ae = document.activeElement;
    const related = ae && ae !== document.body && ae.closest && ae.closest('#st-setup, #st-header, .co-launch, #co-modal-slot');
    const inv = invoker || (related ? ae : false);
    const m = await preloadGoLive({ now: true });
    if (!m) { emit('toast', { kind: 'warn', text: 'Channels are loading. Try again in a moment.' }); return; }
    await m.ensureCss?.();
    m.openGoLive(ctx, { tab, channel, invoker: inv, helpers: { h, copyButton, copyText, lastQA, botName, hueVar, price } });
  }
  // Any module (or B's palette) can open it: emit('golive:open', {tab:'channels'|'developers', channel?}).
  sub('golive:open', (d) => openGoLive(d || {}));
  // The bot pane's Set up view: the same channels, rendered inline (app.js owns the pane and its toggle).
  // emit('setup:mount', {el, surfaces, channel?, onBack, onReady(handle)}); handle.close() unmounts (and ends any call).
  async function mountSetup({ el, surfaces = null, channel = null, onBack = null, onReady = null } = {}) {
    if (!el) return;
    const m = await preloadGoLive({ now: true });
    if (!m) { emit('toast', { kind: 'warn', text: 'Setup is loading. Try again in a moment.' }); onReady?.(null); return; }
    await m.ensureCss?.();
    const handle = m.openGoLive(ctx, { inline: el, surfaces, channel, invoker: false, helpers: { h, copyButton, copyText, lastQA, botName, hueVar, price, onBack } });
    onReady?.(handle);
  }
  sub('setup:mount', (d) => mountSetup(d || {}));
  sub('trial:ready', () => watchPane());
  setTimeout(watchPane, 0);

  // ================================================================== lifecycle

  sub('drawer:open', () => { if (stage) closeStage({ focus: false }); });
  sub('change:spec', () => { for (const c of launchCards) if (c.el.isConnected) c.update(); repaintPrices(); });
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
