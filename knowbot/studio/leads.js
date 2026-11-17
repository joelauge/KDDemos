// KnowBot Studio: Stats & Leads, a full view (not a dialog).
//
//   openLeads(opts?)   opens the view over the Studio at #stats (deep-linkable, reload-safe; Back, Esc and the back arrow
//                      return to the bot). It shows, for a time range (7 / 30 / 90 days, or All):
//                        - totals
//                        - Questions by day: a labelled chart (answered / not in your files), each day a button; picking
//                          a day shows that day's questions
//                        - Question history: every question, newest first, grouped by day, paged; filters (day, channel,
//                          outcome, search, Studio tests on/off); the answer and its sources for answered questions;
//                          "Add what's missing" on the ones the files could not answer
//                        - What people ask (most asked + gaps), Interactions by channel, AI agents, the Leads table
//                          (sortable; a lead's question opens it in the history), Checkout links sent
//                        - Clicks & sales: links opened from the bot's answers on the website (chat bubble, Homepage
//                          search, voice mode), the click rate, a per-day chart, top products and questions, and the
//                          orders the owner's order page reported after a click (or how to turn that on); two CSVs
//                        - Connect your CRM (studio/crm.js): send new leads to a CRM, an email list, Zapier or a webhook
//                        - Track links, Download leads CSV, Download questions CSV
//                      opts.section 'crm' | 'sales' scrolls to (and focuses) that section once the view is painted.
//   initStatsRoute()   wires #stats: opens the view when the page loads on it, and follows Back / Forward.
//
// Data: GET /api/studio/trials/:id/leads[.csv], /attribution, /clicks.csv, /sales.csv (server/leads.mjs), /history[.csv] (server/questions.mjs questionHistory)
// and /insights. Days and times are the viewer's own (the browser's UTC offset is sent as `tz`).
// Self-contained (styles in leads.css, loaded on first open). Customer-facing copy never names a provider.
import * as api from './api.js';
import { getState } from './store.js';
import { icon } from './icons.js';
import { crmSection } from './crm.js';

const CHANNELS = [
  ['web', 'Website chat'], ['site', 'Homepage search'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['email', 'Email'],
  ['phone', 'Phone'], ['voice', 'Web voice'], ['agent', 'AI agents'], ['api', 'Developer API'], ['studio', 'Studio (your tests)'],
];
const CHANNEL_LABEL = Object.fromEntries(CHANNELS);
const channelLabel = (c) => CHANNEL_LABEL[c] || c || 'Other';
const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All']];
const OUTCOMES = [['', 'Any outcome'], ['answered', 'Answered'], ['refused', 'Not answered (all)'], ['gap', 'Not in your files'], ['off_topic', 'Off-topic'], ['flagged', 'Flagged for review']];
const OUTCOME_LABEL = { answered: 'Answered', gap: 'Not in your files', off_topic: 'Off-topic' };
const OUTCOME_ICON = { answered: 'check', gap: 'question', off_topic: 'shield' };
const FLAG_LABEL = { unsupported_figure: 'Unsupported figure', ungrounded: 'Said without a source' };
const flagLabel = (f) => FLAG_LABEL[f] || String(f).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const PAGE = 50;
const ROUTE = '#stats';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const ico = (name, size = 14) => h('span', { class: 'kb-stats-ico', 'aria-hidden': 'true', html: icon(name, size) });

let cssReady = null;
function ensureCss() {
  if (cssReady) return cssReady;
  const href = new URL('./leads.css', import.meta.url);
  href.search = new URL(import.meta.url).search;
  if (document.querySelector('link[data-kb-leads]')) return (cssReady = Promise.resolve());
  cssReady = new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: href.href, 'data-kb-leads': '' });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
    setTimeout(resolve, 1500);
  });
  return cssReady;
}

// ---- dates: a day is "YYYY-MM-DD" in the viewer's own time zone
const tzOffset = () => -new Date().getTimezoneOffset();
const dayDate = (day) => { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1, 12); };
const fmtDay = (day, o = { weekday: 'short', month: 'short', day: 'numeric' }) => dayDate(day).toLocaleDateString(undefined, o);
const fmtDayLong = (day) => fmtDay(day, { weekday: 'long', month: 'long', day: 'numeric', ...(dayDate(day).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
const fmtClock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const localDayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tzName = () => {
  const m = tzOffset(), a = Math.abs(m);
  return `UTC${m < 0 ? '−' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
};
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const fmtPhone = (p) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ''));
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : String(p || '');
};
/** The part of a lead's question that the (masked) question log is sure to contain: up to the first address or long number. */
const searchable = (q) => String(q || '').split(/\S*@\S*|\+?\d[\d\s().-]{5,}\d/)[0].replace(/\s+/g, ' ').trim().slice(0, 80);

// ---- the route: #stats[?range=&day=&dayEnd=&ch=&out=&q=&tests=0]
function parseRoute(hash = location.hash) {
  if (!/^#stats(?:$|\?)/.test(hash)) return null;
  const sp = new URLSearchParams(hash.slice(ROUTE.length + 1));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('day') || '') ? sp.get('day') : '';
  return {
    range: RANGES.some(([v]) => v === sp.get('range')) ? sp.get('range') : '30',
    day, dayEnd: day && /^\d{4}-\d{2}-\d{2}$/.test(sp.get('dayEnd') || '') ? sp.get('dayEnd') : '',
    channel: CHANNEL_LABEL[sp.get('ch')] ? sp.get('ch') : '',
    outcome: OUTCOMES.some(([v]) => v && v === sp.get('out')) ? sp.get('out') : '',
    q: (sp.get('q') || '').slice(0, 120),
    tests: sp.get('tests') !== '0',
  };
}
function routeOf(f) {
  const sp = new URLSearchParams();
  if (f.range !== '30') sp.set('range', f.range);
  if (f.day) { sp.set('day', f.day); if (f.dayEnd) sp.set('dayEnd', f.dayEnd); }
  if (f.channel) sp.set('ch', f.channel);
  if (f.outcome) sp.set('out', f.outcome);
  if (f.q) sp.set('q', f.q);
  if (!f.tests) sp.set('tests', '0');
  const s = sp.toString();
  return `${ROUTE}${s ? `?${s}` : ''}`;
}

let view = null;     // the open view: { el, close(fromHistory), apply(filters) }
let hooks = {};      // { addMissing(question, invoker) } from app.js
let routed = false;

/** Wire #stats to the view (once): open on load when the page is on it, follow Back / Forward. */
export function initStatsRoute(opts = {}) {
  hooks = { ...hooks, ...opts };
  if (routed) return;
  routed = true;
  const sync = () => {
    const f = parseRoute();
    if (f && !view) openLeads({ filters: f, push: false });
    else if (f && view) view.apply(f);
    else if (!f && view) view.close(true);
  };
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  if (parseRoute()) sync();
}

/** Opens Stats & Leads as a full view (one at a time). Resolves when it is shown. */
export async function openLeads({ filters = null, push = true, invoker = null, section = null } = {}) {
  if (view) { if (filters && view.el.isConnected) view.apply({ ...parseRoute(ROUTE), ...filters }); if (section) view.show(section); else view.el.querySelector('#kb-stats-title')?.focus(); return; }
  if (!getState().trial?.id) return;
  const opener = invoker || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  const f = { ...(parseRoute() || parseRoute(ROUTE)), ...(filters || {}) };
  const st = { leads: null, att: null, prodSort: 'clicks', hist: null, insights: null, items: [], dayCounts: {}, cursor: null, busy: false, seq: 0, sort: { key: 'at', dir: -1 } };
  const prevTitle = document.title;
  const app = document.getElementById('st-app');

  // claim the route first (so two quick opens make one view), then build
  const here = parseRoute();
  if (!here) {
    if (push) history.pushState({ ...(history.state || {}), kbStats: true }, '', `${location.pathname}${location.search}${routeOf(f)}`);
    else history.replaceState(history.state, '', `${location.pathname}${location.search}${routeOf(f)}`);
  }
  const titleId = 'kb-stats-title';
  const status = h('p', { class: 'kb-stats-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'kb-stats-body' });
  const seg = h('div', { class: 'st-seg kb-stats-seg', role: 'group', 'aria-label': 'Time range' },
    RANGES.map(([v, label]) => h('button', { type: 'button', class: 'st-seg-btn', 'aria-pressed': String(v === f.range), 'data-range': v,
      onclick: () => { if (f.range !== v) setFilters({ range: v, day: '', dayEnd: '' }); } }, v === 'all' ? label : h('span', null, h('span', { class: 'st-sr' }, 'Last '), label))));
  const leadsCsvBtn = h('button', { type: 'button', class: 'btn btn-primary st-btn st-btn-primary kb-stats-csv', onclick: () => download('leads') }, ico('table'), h('span', null, h('span', { class: 'st-sr' }, 'Download '), 'Leads CSV'));
  const qCsvBtn = h('button', { type: 'button', class: 'btn btn-ghost st-btn kb-stats-csv kb-stats-csv-q', onclick: () => download('questions') }, ico('table'), h('span', null, h('span', { class: 'st-sr' }, 'Download '), 'Questions CSV'));
  const trackSw = h('button', { type: 'button', role: 'switch', 'aria-checked': 'true', class: 'kb-leads-switch', 'aria-describedby': 'kb-leads-track-hint', onclick: () => toggleTracking() },
    h('span', { class: 'kb-leads-knob', 'aria-hidden': 'true' }), h('span', { class: 'kb-leads-switch-label' }, 'Track links'));
  const trackHint = h('span', { id: 'kb-leads-track-hint', class: 'kb-leads-hint' }, 'Adds campaign tags to the links in your bot’s answers and messages, and counts their clicks. Off: links go out as they are and nothing is counted.');
  const back = h('button', { type: 'button', class: 'st-iconbtn kb-stats-back', 'aria-label': 'Back to your bot', title: 'Back to your bot (Esc)', onclick: () => close() }, h('span', { class: 'kb-stats-flip', 'aria-hidden': 'true', html: icon('arrowRight', 18) }));
  const botName = (getState().spec?.name || '').trim();
  const el = h('section', { id: 'kb-stats', class: 'kb-stats', 'aria-labelledby': titleId },
    h('header', { class: 'kb-stats-top' },
      h('div', { class: 'kb-stats-top-in' },
        h('div', { class: 'kb-stats-bar1' }, back,
          h('div', { class: 'kb-stats-titles' },
            h('h2', { id: titleId, tabindex: '-1' }, 'Stats & Leads'),
            h('p', { id: 'kb-stats-sub' }, botName ? `${botName}: what people asked, who your bot talked to, and what they clicked.` : 'What people asked, who your bot talked to, and what they clicked.'))),
        h('div', { class: 'kb-stats-tools' }, seg, h('div', { class: 'kb-leads-track' }, trackSw, trackHint), h('div', { class: 'kb-stats-dl' }, qCsvBtn, leadsCsvBtn)))),
    h('div', { class: 'kb-stats-scroll' }, h('div', { class: 'kb-stats-in' }, status, body)));

  // one live region for the history, so filters and paging are announced without re-reading the list
  const histLive = h('p', { class: 'st-sr', role: 'status', 'aria-live': 'polite' });
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && t.matches?.('input[type="search"]') && t.value) return; // Esc clears a search first
    if (t && t.matches?.('select')) return;
    e.preventDefault();
    close();
  };
  document.addEventListener('keydown', onKey);
  // Connect your CRM: built once per view (it keeps its own state while the report repaints around it)
  let crmEl = null, wantSection = section;
  const showSection = (name) => {
    wantSection = name;
    const target = name === 'crm' ? el.querySelector('#kb-crm') : name === 'sales' ? el.querySelector('#kb-sales') : null;
    if (!target) return; // not painted yet: paint() comes back here
    wantSection = null;
    target.scrollIntoView({ block: 'start' });
    target.querySelector('h3')?.focus({ preventScroll: true });
  };
  let ready = false; // a route change that lands while the styles load only updates the filters: the first load picks them up
  view = { el, close, show: showSection, apply: (nf) => { Object.assign(f, nf); if (!ready) return; paintSeg(); load(); } }; // claimed before the first await: one view, however it is asked for
  await ensureCss();
  if (!view || view.el !== el) return; // closed while the styles loaded
  document.body.append(el);
  if (app) { app.inert = true; app.setAttribute('aria-hidden', 'true'); }
  document.documentElement.classList.add('kb-stats-open');
  document.title = `Stats & Leads${botName ? ` · ${botName}` : ''}`;
  el.querySelector(`#${titleId}`).focus({ preventScroll: true });
  setTimeout(() => { ready = true; paintSeg(); load(); }, 0); // after the helpers below exist

  /** Leave the view. fromHistory: Back / Forward already changed the URL. */
  function close(fromHistory = false) {
    if (!view) return;
    view = null;
    document.removeEventListener('keydown', onKey);
    el.remove();
    if (app) { app.inert = false; app.removeAttribute('aria-hidden'); }
    document.documentElement.classList.remove('kb-stats-open');
    document.title = prevTitle;
    if (!fromHistory && parseRoute()) {
      if (history.state?.kbStats) history.back(); // we pushed #stats: Back is the same as closing
      else history.replaceState(history.state, '', `${location.pathname}${location.search}`); // opened by a deep link
    }
    const t = opener && opener.isConnected && opener.offsetParent !== null ? opener : (document.getElementById('st-leads')?.offsetParent ? document.getElementById('st-leads') : document.getElementById('st-more'));
    t?.focus?.();
  }

  function paintSeg() { for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.range === f.range)); }
  function syncRoute() { if (view) history.replaceState(history.state, '', `${location.pathname}${location.search}${routeOf(f)}`); }
  /** Change filters. Everything reloads when the range changes; only the history when a list filter does. */
  function setFilters(nf, { focus = null } = {}) {
    const rangeChanged = nf.range != null && nf.range !== f.range;
    Object.assign(f, nf);
    syncRoute();
    paintSeg();
    return rangeChanged ? load() : loadHistory({ focus });
  }
  const histParams = (extra = {}) => ({ days: f.range, tz: tzOffset(), day: f.day || undefined, dayEnd: f.day && f.dayEnd ? f.dayEnd : undefined, channel: f.channel || undefined,
    outcome: f.outcome || undefined, q: f.q || undefined, tests: f.tests ? undefined : 0, ...extra });
  const leadDays = () => (f.range === 'all' ? 90 : Number(f.range));
  const rangeWords = () => (f.range === 'all' ? 'all time' : `the last ${f.range} days`);

  async function load() {
    const seq = ++st.seq;
    st.busy = true;
    body.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading…';
    try {
      const [rep, hist, ins, att] = await Promise.all([api.leads(leadDays()), api.history(histParams({ limit: PAGE })), st.insights ? st.insights : api.insights().catch(() => null),
        api.attribution(leadDays(), tzOffset()).catch(() => null)]);
      if (seq !== st.seq || !view) return;
      st.leads = rep; st.hist = hist; st.insights = ins; st.att = att;
      st.items = hist.items || []; st.dayCounts = { ...(hist.dayCounts || {}) }; st.cursor = hist.nextCursor || null;
      paint();
      status.textContent = `Showing ${rangeWords()}: ${plural(hist.total || 0, 'question')}, ${plural(rep.leads.length, 'lead')}, ${plural(rep.conversions.sent, 'checkout link')} sent.`;
    } catch (e) {
      if (seq !== st.seq || !view) return;
      if (!e?.status) console.error('[stats]', e); // not a server answer: a bug here should never hide behind "try again"
      body.replaceChildren(h('p', { class: 'alert alert-danger kb-leads-err', role: 'alert' }, e?.status === 401 ? 'This bot has expired, so its stats and leads are no longer available.' : "Couldn't load Stats & Leads. Try again in a moment."));
      status.textContent = '';
    } finally {
      if (seq === st.seq) { st.busy = false; body.removeAttribute('aria-busy'); }
    }
  }

  /** Reload the chart and the first page of the history for the current filters (the rest of the view stays). */
  async function loadHistory({ focus = null } = {}) {
    if (!st.leads) return load();
    const seq = ++st.seq;
    const sec = body.querySelector('#kb-hist');
    sec?.setAttribute('aria-busy', 'true');
    try {
      const hist = await api.history(histParams({ limit: PAGE }));
      if (seq !== st.seq || !view) return;
      st.hist = hist; st.items = hist.items || []; st.dayCounts = { ...(hist.dayCounts || {}) }; st.cursor = hist.nextCursor || null;
      paintQuestions();
      histLive.textContent = `${plural(hist.matched, 'question')} ${filterWords()}.`;
      if (focus) body.querySelector(focus)?.focus({ preventScroll: true });
    } catch {
      if (seq !== st.seq || !view) return;
      histLive.textContent = "Couldn't load the questions. Try again in a moment.";
      sec?.querySelector('.kb-hist-list')?.replaceChildren(h('p', { class: 'alert alert-danger kb-leads-err', role: 'alert' }, "Couldn't load the questions. Try again in a moment."));
    } finally { sec?.removeAttribute('aria-busy'); }
  }

  async function more(btn) {
    if (!st.cursor) return;
    btn.disabled = true;
    const seq = st.seq;
    try {
      const r = await api.history(histParams({ limit: PAGE, cursor: st.cursor }));
      if (seq !== st.seq || !view) return;
      const firstNew = st.items.length;
      st.items.push(...(r.items || [])); Object.assign(st.dayCounts, r.dayCounts || {}); st.cursor = r.nextCursor || null;
      paintList();
      histLive.textContent = `Showing ${st.items.length.toLocaleString()} of ${plural(st.hist.matched, 'question')}.`;
      body.querySelectorAll('.kb-hist-row')[firstNew]?.querySelector('.kb-hist-q')?.focus({ preventScroll: true });
    } catch { histLive.textContent = "Couldn't load more questions. Try again."; btn.disabled = false; }
  }

  async function toggleTracking() {
    if (!st.leads || st.busy) return;
    const next = !(trackSw.getAttribute('aria-checked') === 'true');
    trackSw.setAttribute('aria-checked', String(next));
    try {
      const r = await api.setLeadTracking(next);
      st.leads.tracking = r.tracking;
      if (st.att) { st.att.tracking = r.tracking; body.querySelector('#kb-sales')?.replaceWith(salesSection(st.att) || ''); }
      status.textContent = r.tracking ? 'Link tracking is on.' : 'Link tracking is off: links are sent as they are.';
    } catch {
      trackSw.setAttribute('aria-checked', String(!next));
      status.textContent = "Couldn't change link tracking. Try again.";
    }
  }

  async function download(kind) {
    const btn = kind === 'leads' ? leadsCsvBtn : kind === 'questions' ? qCsvBtn : body.querySelector(`[data-csv="${kind}"]`) || qCsvBtn;
    btn.disabled = true;
    status.textContent = 'Preparing the CSV…';
    try {
      const res = kind === 'leads' ? await api.leadsCsv(leadDays()) : kind === 'clicks' ? await api.clicksCsv(leadDays(), tzOffset()) : kind === 'sales' ? await api.salesCsv(leadDays(), tzOffset()) : await api.historyCsv(histParams());
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1])
        || `knowbot-${kind}-${(getState().spec?.name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'}-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.textContent = `Downloaded ${name}.`;
    } catch {
      status.textContent = "Couldn't download the CSV. Try again in a moment.";
    } finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------------ painting
  function paint() {
    const data = st.leads, hist = st.hist;
    trackSw.setAttribute('aria-checked', String(data.tracking !== false));
    const emails = data.leads.filter((l) => l.type === 'email').length;
    const phones = data.leads.length - emails;
    const tiles = h('ul', { class: 'kb-leads-tiles', 'aria-label': 'Totals' },
      tile('Questions', hist.total, hist.refused ? `${hist.refused.toLocaleString()} not in your files` : hist.total ? 'all answered from your files' : 'none yet'),
      tile('Leads', data.leads.length, `${plural(emails, 'email')} · ${plural(phones, 'phone')}`),
      tile('Checkout links sent', data.conversions.sent, `${plural(data.conversions.clickedSends || 0, 'opened', 'opened')}`),
      tile('Link clicks', data.links?.clicks || 0, `on ${plural(data.links?.sent || 0, 'tracked link')}`));
    const keep = data.retentionDays || hist.retention?.leadsDays || 90;
    body.replaceChildren(...[
      tiles,
      f.range === 'all' ? h('p', { class: 'kb-stats-note' }, ico('info', 13), ` “All” shows every question since ${fmtDay(hist.range.from, { month: 'short', day: 'numeric', year: 'numeric' })}${hist.range.all && hist.range.days >= (hist.range.reachDays || 730) ? ' (it goes back two years at most)' : ''}. Leads, checkout links and clicks are only kept for ${keep} days, so those show the last ${keep} days.`) : null,
      h('div', { id: 'kb-qsec', class: 'kb-stats-q' }),
      h('div', { class: 'kb-stats-cols' }, asksSection(st.insights), h('div', { id: 'kb-chsec' })),
      salesSection(st.att), agentsSection(data.agents), leadsSection(data.leads), (crmEl ||= crmSection({ announce: (t) => { status.textContent = t; } })), checkoutSection(data.conversions.items || []),
      h('p', { class: 'kb-leads-foot' }, ico('lock', 12),
        h('span', null, `Only you can see this. Days and times are in your time zone (${tzName()}). Questions are kept for as long as your bot exists, with email addresses and long numbers masked; leads, checkout links, clicks and reported orders are kept for ${keep} days. Tracked links carry utm_source=knowbot, utm_medium (the channel) and utm_campaign (this bot), so your own analytics can count visits and sales from them. The leads CSV lists each AI agent question on channel "agent".`)),
    ].filter(Boolean));
    paintQuestions();
    if (wantSection) showSection(wantSection);
  }
  function tile(label, n, sub) {
    return h('li', { class: 'kb-leads-tile' }, h('span', { class: 'kb-leads-tile-label' }, label), h('strong', { class: 'kb-leads-tile-n st-mono' }, Number(n || 0).toLocaleString()), h('span', { class: 'kb-leads-tile-sub' }, sub));
  }
  /** The chart, the history and the channel bars: everything that follows the question filters. */
  function paintQuestions() {
    const slot = body.querySelector('#kb-qsec');
    if (!slot) return;
    const active = document.activeElement && slot.contains(document.activeElement) ? document.activeElement : null;
    const keepFocus = active?.id ? `#${active.id}` : active?.dataset?.day ? `.kb-bar[data-day="${active.dataset.day}"]` : null;
    slot.replaceChildren(chartSection(st.hist), historySection(st.hist));
    body.querySelector('#kb-chsec')?.replaceChildren(channelsSection(st.hist));
    paintList();
    if (keepFocus) slot.querySelector(keepFocus)?.focus({ preventScroll: true });
  }

  // ---- Questions by day
  /** A round number at or above n, for the top of the axis. */
  const niceMax = (n) => { if (n <= 4) return Math.max(1, n); const p = 10 ** Math.floor(Math.log10(n)); for (const m of [1, 2, 5, 10]) if (n <= m * p) return m * p; return n; };
  function chartSection(hist) {
    const days = hist.byDay || [];
    // long ranges are grouped by week, so every bar stays wide enough to read and to press
    const weekly = days.length > 92;
    const buckets = [];
    if (weekly) {
      for (let i = 0; i < days.length; i += 7) {
        const run = days.slice(i, i + 7);
        buckets.push({ day: run[0].day, dayEnd: run[run.length - 1].day, total: run.reduce((n, d) => n + d.total, 0), answered: run.reduce((n, d) => n + d.answered, 0), refused: run.reduce((n, d) => n + d.refused, 0) });
      }
    } else for (const d of days) buckets.push({ day: d.day, dayEnd: '', total: d.total, answered: d.answered, refused: d.refused });
    const peak = Math.max(0, ...buckets.map((b) => b.total));
    const top = niceMax(peak);
    const nameOf = (b) => (b.dayEnd && b.dayEnd !== b.day ? `${fmtDay(b.day, { month: 'short', day: 'numeric' })} to ${fmtDay(b.dayEnd, { month: 'short', day: 'numeric' })}` : fmtDay(b.day));
    const sumOf = (b) => (b.total ? `${plural(b.total, 'question')}: ${b.answered.toLocaleString()} answered, ${b.refused.toLocaleString()} not in your files` : 'no questions');
    const isSel = (b) => !!f.day && f.day === b.day && (f.dayEnd || '') === (b.dayEnd && b.dayEnd !== b.day ? b.dayEnd : '');
    // axis labels: every bar when they fit, else an even spread that always includes the newest
    const every = buckets.length <= 10 ? 1 : buckets.length <= 31 ? 5 : buckets.length <= 62 ? 7 : 14;
    const tickAt = (i) => (buckets.length - 1 - i) % every === 0;
    const tickText = (b) => (weekly || buckets.length > 10 ? fmtDay(b.day, { month: 'short', day: 'numeric' }) : fmtDay(b.day, { weekday: 'short', day: 'numeric' }));
    const pick = (b) => (isSel(b) ? setFilters({ day: '', dayEnd: '' }) : setFilters({ day: b.day, dayEnd: b.dayEnd && b.dayEnd !== b.day ? b.dayEnd : '' }));
    const bars = buckets.map((b, i) => h('button', { type: 'button', class: 'kb-bar', 'data-day': b.day, 'aria-pressed': String(isSel(b)), tabindex: isSel(b) || (!f.day && i === buckets.length - 1) ? '0' : '-1',
      'aria-label': `${nameOf(b)}: ${sumOf(b)}`, title: `${nameOf(b)}: ${sumOf(b)}`, onclick: () => pick(b) },
    h('span', { class: 'kb-bar-col', 'aria-hidden': 'true' },
      b.total ? h('span', { class: 'kb-bar-n st-mono' }, b.total.toLocaleString()) : null,
      h('span', { class: 'kb-bar-stack', style: `height:${b.total ? Math.max(2, (b.total / top) * 100) : 0}%` },
        b.refused ? h('i', { class: 'kb-bar-r', style: `flex-grow:${b.refused}` }) : null,
        b.answered ? h('i', { class: 'kb-bar-a', style: `flex-grow:${b.answered}` }) : null)),
    h('span', { class: `kb-bar-x${tickAt(i) ? ' is-tick' : ''}`, 'aria-hidden': 'true' }, tickAt(i) ? tickText(b) : '')));
    // one tab stop; arrows move between days (Home / End jump), Enter or Space picks the day
    const onKeys = (e) => {
      const list = [...plot.querySelectorAll('.kb-bar')];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const to = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
      if (to < 0 || to >= list.length) return;
      e.preventDefault();
      for (const b of list) b.tabIndex = -1;
      list[to].tabIndex = 0;
      list[to].focus();
      list[to].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const plot = h('div', { class: `kb-chart-plot${buckets.length > 45 ? ' is-dense' : ''}`, style: `--n:${buckets.length}`, role: 'group', 'aria-label': `Questions per ${weekly ? 'week' : 'day'}. Arrow keys move between ${weekly ? 'weeks' : 'days'}; Enter shows that ${weekly ? "week's" : "day's"} questions.`, onkeydown: onKeys }, bars);
    const ticks = top <= 1 ? [1, 0] : [top, top / 2, 0];
    const scroller = h('div', { class: 'kb-chart-scroll' }, plot);
    const sec = h('section', { class: 'kb-leads-sec kb-chart-sec', 'aria-labelledby': 'kb-chart-h' },
      h('div', { class: 'kb-sec-head' },
        h('h3', { id: 'kb-chart-h' }, `Questions by ${weekly ? 'week' : 'day'}`, f.channel ? h('span', { class: 'kb-leads-count' }, `${channelLabel(f.channel)} only`) : null),
        h('ul', { class: 'kb-chart-key', 'aria-label': 'Legend' },
          h('li', null, h('i', { class: 'kb-key kb-bar-a', 'aria-hidden': 'true' }), 'Answered'),
          h('li', null, h('i', { class: 'kb-key kb-bar-r', 'aria-hidden': 'true' }), 'Not in your files'))),
      peak
        ? h('figure', { class: 'kb-chart' },
          h('div', { class: 'kb-chart-y', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { class: 'st-mono' }, Number.isInteger(t) ? t.toLocaleString() : ''))),
          h('div', { class: 'kb-chart-area' }, h('div', { class: 'kb-chart-grid', 'aria-hidden': 'true' }, ticks.map(() => h('i'))), scroller),
          h('figcaption', { class: 'kb-leads-hint' }, f.day
            ? h('span', null, h('strong', null, nameOf({ day: f.day, dayEnd: f.dayEnd })), `: ${sumOf(buckets.find(isSel) || { total: 0 })}. `,
              h('button', { type: 'button', class: 'st-link-btn kb-chart-clear', onclick: () => setFilters({ day: '', dayEnd: '' }, { focus: '.kb-bar[tabindex="0"]' }) }, `Show all ${weekly ? 'weeks' : 'days'}`))
            : `Pick a ${weekly ? 'week' : 'day'} to see its questions. ${weekly ? 'Long ranges are grouped by week.' : ''}`))
        : h('p', { class: 'empty-state kb-leads-empty' }, f.channel || !f.tests ? `No questions match in ${rangeWords()}.` : `No questions in ${rangeWords()} yet. When someone asks your bot something, it shows up here.`));
    // start at the newest day (the right edge) when the chart is wider than its box
    requestAnimationFrame(() => { const s = plot.querySelector('.kb-bar[aria-pressed="true"]'); if (s) s.scrollIntoView({ block: 'nearest', inline: 'center' }); else scroller.scrollLeft = scroller.scrollWidth; });
    return sec;
  }

  // ---- Question history
  function filterWords() {
    const parts = [];
    if (f.day) parts.push(f.dayEnd ? `from ${fmtDay(f.day)} to ${fmtDay(f.dayEnd)}` : `on ${fmtDay(f.day)}`); else parts.push(`in ${rangeWords()}`);
    if (f.channel) parts.push(`on ${channelLabel(f.channel)}`);
    if (f.outcome) parts.push(`· ${OUTCOMES.find(([v]) => v === f.outcome)?.[1].toLowerCase()}`);
    if (f.q) parts.push(`matching “${f.q}”`);
    return parts.join(' ');
  }
  function historySection(hist) {
    let timer = 0;
    const search = h('input', { type: 'search', id: 'kb-hist-q', class: 'input kb-hist-in', value: f.q, maxlength: '120', placeholder: 'Search questions', autocomplete: 'off', enterkeyhint: 'search',
      oninput: () => { clearTimeout(timer); timer = setTimeout(() => { if (search.value.trim() !== f.q) setFilters({ q: search.value.trim() }, { focus: '#kb-hist-q' }); }, 280); } });
    const sel = (id, label, value, opts, key) => h('label', { class: 'kb-hist-f', for: id }, h('span', { class: 'kb-hist-flabel' }, label),
      h('select', { id, class: 'input kb-hist-in', onchange: (e) => setFilters({ [key]: e.target.value }, { focus: `#${id}` }) }, opts.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
    const used = new Set(CHANNELS.map(([id]) => id).filter((id) => (hist.byChannel?.[id] || 0) > 0 || id === f.channel));
    const tests = h('label', { class: 'kb-hist-check', for: 'kb-hist-tests' },
      h('input', { type: 'checkbox', id: 'kb-hist-tests', checked: f.tests, onchange: (e) => setFilters({ tests: e.target.checked, ...(e.target.checked || f.channel !== 'studio' ? {} : { channel: '' }) }, { focus: '#kb-hist-tests' }) }),
      h('span', null, 'Include Studio (your tests)'));
    const any = f.day || f.channel || f.outcome || f.q;
    return h('section', { id: 'kb-hist', class: 'kb-leads-sec kb-hist', 'aria-labelledby': 'kb-hist-h' },
      h('div', { class: 'kb-sec-head' },
        h('h3', { id: 'kb-hist-h', tabindex: '-1' }, 'Question history', h('span', { class: 'kb-leads-count st-mono', id: 'kb-hist-n' }, Number(hist.matched || 0).toLocaleString())),
        h('p', { class: 'kb-leads-hint kb-hist-sum' }, `${plural(hist.matched, 'question')} ${filterWords()}, newest first.`)),
      h('div', { class: 'kb-hist-filters', role: 'group', 'aria-label': 'Filter the questions' },
        h('label', { class: 'kb-hist-f kb-hist-search', for: 'kb-hist-q' }, h('span', { class: 'kb-hist-flabel' }, 'Search'), search),
        sel('kb-hist-ch', 'Channel', f.channel, [['', 'Every channel'], ...CHANNELS.filter(([id]) => used.has(id) && (f.tests || id !== 'studio'))], 'channel'),
        sel('kb-hist-out', 'Outcome', f.outcome, OUTCOMES, 'outcome'),
        tests),
      any ? h('div', { class: 'kb-hist-chips' },
        f.day ? chip(f.dayEnd ? `${fmtDay(f.day, { month: 'short', day: 'numeric' })} to ${fmtDay(f.dayEnd, { month: 'short', day: 'numeric' })}` : fmtDay(f.day), { day: '', dayEnd: '' }) : null,
        f.channel ? chip(channelLabel(f.channel), { channel: '' }) : null,
        f.outcome ? chip(OUTCOMES.find(([v]) => v === f.outcome)[1], { outcome: '' }) : null,
        f.q ? chip(`“${f.q}”`, { q: '' }) : null,
        h('button', { type: 'button', class: 'st-link-btn kb-hist-reset', onclick: () => setFilters({ day: '', dayEnd: '', channel: '', outcome: '', q: '' }, { focus: '#kb-hist-q' }) }, 'Clear filters')) : null,
      hist.partial ? h('p', { class: 'kb-stats-note' }, ico('info', 13), ' This is a long history: some older questions were not searched yet. Narrow the range or pick a day to search them all.') : null,
      hist.truncated ? h('p', { class: 'kb-stats-note' }, ico('info', 13), ' One month has more questions than this view can list at once; pick a shorter range to see them all.') : null,
      histLive,
      h('div', { class: 'kb-hist-list' }));
  }
  const chip = (text, clear) => h('button', { type: 'button', class: 'kb-hist-chip', 'aria-label': `Remove filter: ${text}`, onclick: () => setFilters(clear, { focus: '#kb-hist-h' }) }, h('span', null, text), ico('close', 12));

  function paintList() {
    const list = body.querySelector('.kb-hist-list');
    if (!list) return;
    const hist = st.hist;
    if (!st.items.length) {
      list.replaceChildren(h('p', { class: 'empty-state kb-leads-empty' }, f.day || f.channel || f.outcome || f.q || !f.tests ? 'No questions match these filters.' : `No questions in ${rangeWords()} yet.`));
      return;
    }
    const groups = [];
    for (const it of st.items) { const g = groups[groups.length - 1]; if (g && g.day === it.day) g.items.push(it); else groups.push({ day: it.day, items: [it] }); }
    const kids = groups.map((g) => {
      const n = st.dayCounts[g.day] ?? g.items.length;
      const id = `kb-day-${g.day}`;
      return h('section', { class: 'kb-hist-day', 'aria-labelledby': id },
        h('h4', { id, class: 'kb-hist-dayh' }, h('span', null, fmtDayLong(g.day)), h('span', { class: 'kb-hist-dayn st-mono' }, plural(n, 'question'))),
        h('ol', { class: 'kb-hist-rows' }, g.items.map(row)));
    });
    if (st.cursor) {
      const btn = h('button', { type: 'button', class: 'btn btn-ghost st-btn kb-hist-more', onclick: () => more(btn) }, `Show ${Math.min(PAGE, hist.matched - st.items.length).toLocaleString()} more`);
      kids.push(h('div', { class: 'kb-hist-foot' }, h('span', { class: 'kb-leads-hint' }, `Showing ${st.items.length.toLocaleString()} of ${Number(hist.matched).toLocaleString()}`), btn));
    } else if (st.items.length > 20) kids.push(h('p', { class: 'kb-leads-hint kb-hist-end' }, `That's all ${Number(hist.matched).toLocaleString()}.`));
    list.replaceChildren(...kids);
  }

  function row(it) {
    const hasMore = it.outcome === 'answered' || it.note || it.files?.length;
    const detailId = `kb-d-${it.id}`;
    const tag = h('span', { class: `kb-out kb-out-${it.outcome}` }, ico(OUTCOME_ICON[it.outcome] || 'dot', 12), OUTCOME_LABEL[it.outcome] || it.outcome);
    const q = hasMore
      ? h('button', { type: 'button', class: 'kb-hist-q kb-hist-qbtn', 'aria-expanded': 'false', 'aria-controls': detailId, onclick: () => toggle() },
        h('span', { class: 'kb-hist-qtext' }, it.q || 'Question text is not available'), h('span', { class: 'kb-hist-caret', 'aria-hidden': 'true', html: icon('chevronDown', 14) }),
        h('span', { class: 'st-sr' }, it.outcome === 'answered' ? ' (show the answer)' : ' (show details)'))
      : h('span', { class: 'kb-hist-q', tabindex: '-1' }, h('span', { class: 'kb-hist-qtext' }, it.q || 'Question text is not available'));
    const detail = hasMore ? h('div', { class: 'kb-hist-detail', id: detailId, hidden: true }) : null;
    function toggle() {
      const open = detail.hidden;
      detail.hidden = !open;
      q.setAttribute('aria-expanded', String(open));
      if (open && !detail.childNodes.length) {
        detail.append(...[
          it.outcome === 'answered'
            ? (it.answer
              ? h('div', { class: 'kb-hist-answer' }, h('span', { class: 'kb-hist-dt' }, 'Your bot answered'), h('p', null, it.answer))
              : h('p', { class: 'kb-leads-hint' }, 'The answer text was not saved for this question. Answers are saved with new questions from now on.'))
            : null,
          it.files?.length ? h('div', { class: 'kb-hist-src' }, h('span', { class: 'kb-hist-dt' }, it.files.length === 1 ? 'Source' : 'Sources'),
            h('ul', null, it.files.map((name) => h('li', null, ico('file', 12), name)))) : (it.outcome === 'answered' ? h('p', { class: 'kb-leads-hint' }, 'No source file was recorded for this answer.') : null),
          it.note ? h('div', { class: 'kb-hist-src' }, h('span', { class: 'kb-hist-dt' }, 'Why it was flagged'), h('p', null, it.note)) : null,
        ].filter(Boolean));
      }
    }
    const add = it.outcome === 'gap' && it.q && hooks.addMissing
      ? h('button', { type: 'button', class: 'st-link-btn kb-hist-add', 'aria-label': `Add what's missing for: ${it.q}`, onclick: (e) => hooks.addMissing(it.q, e.currentTarget) }, ico('plus', 12), 'Add what’s missing')
      : null;
    return h('li', { class: 'kb-hist-row', 'data-outcome': it.outcome, 'data-channel': it.channel },
      h('time', { class: 'kb-hist-time st-mono', datetime: it.at }, fmtClock(it.at)),
      h('div', { class: 'kb-hist-main' }, q,
        h('div', { class: 'kb-hist-meta' }, h('span', { class: 'kb-hist-ch' }, channelLabel(it.channel)), tag,
          it.clicks ? h('span', { class: 'kb-out kb-out-click' }, ico('external', 12), it.clicks === 1 ? 'Link clicked' : `Links clicked ${it.clicks}×`) : null,
          it.sale ? h('span', { class: 'kb-out kb-out-sale', title: 'An order your site reported after a click on this answer' }, ico('card', 12), `Sale ${fmtMoney(it.sale.total, it.sale.currency)}${it.sale.orders > 1 ? ` · ${it.sale.orders} orders` : ''}`) : null,
          ...(it.flags || []).map((fl) => h('span', { class: 'kb-out kb-out-flag' }, ico('warn', 12), `Flagged: ${flagLabel(fl)}`)), add),
        detail));
  }

  /** Jump to the history with these filters (from "see all", a channel bar, a lead's question). */
  function showInHistory(nf) {
    const p = setFilters({ day: '', dayEnd: '', channel: '', outcome: '', q: '', ...nf });
    Promise.resolve(p).then(() => { const t = body.querySelector('#kb-hist-h'); t?.scrollIntoView({ block: 'start', behavior: 'auto' }); t?.focus({ preventScroll: true }); });
  }

  // ---- What people ask (the same question insights as the chat card, SPEC 11.1): every question since the bot started
  function asksSection(d) {
    if (!d) return null;
    const sec = h('section', { class: 'kb-leads-sec kb-leads-asks', 'aria-labelledby': 'kb-leads-qs' },
      h('h3', { id: 'kb-leads-qs' }, 'What people ask', h('span', { class: 'kb-leads-count st-mono' }, Number(d.total || 0).toLocaleString())),
      h('p', { class: 'kb-leads-hint' }, `Since your bot started: ${Number(d.answered || 0).toLocaleString()} answered · ${Number(d.refused || 0).toLocaleString()} not answered. Questions are never used as sources.`));
    const answered = (d.top || []).filter((t) => t && t.outcome !== 'refused').slice(0, 10);
    const gaps = (d.gaps || []).slice(0, 10);
    const max = Math.max(1, ...answered.map((t) => t.count || 1));
    const rowOf = (t, gap) => {
      const n = t.count || 1, ways = Number(t.ways) || 1;
      return h('li', { class: 'st-ins-row', 'data-outcome': gap ? 'refused' : 'answered' },
        h('button', { type: 'button', class: 'st-ins-q kb-ask-q', title: `See “${t.q}” in the question history`, onclick: () => showInHistory({ range: 'all', q: searchable(t.q) }) }, t.q),
        ...(ways > 1 ? [h('span', { class: 'st-ins-ways' }, `asked ${ways} ways`)] : []),
        gap ? h('span', { class: 'st-ins-tag' }, h('span', { html: icon('shield', 11), 'aria-hidden': 'true' }), 'not in files')
          : h('span', { class: 'st-ins-bar', 'aria-hidden': 'true' }, h('i', { style: `transform:scaleX(${n / max})` })),
        h('span', { class: 'st-ins-n st-mono', 'aria-label': `asked ${n} time${n === 1 ? '' : 's'}` }, `×${n}`));
    };
    const col = (label, cls, items, gap, empty, all) => h('section', { class: `st-ins-col ${cls}`, 'aria-label': label },
      h('h4', { class: 'kb-ask-h' }, ...(gap ? [h('span', { html: icon('shield', 13), 'aria-hidden': 'true' }), ' '] : []), label),
      items.length ? h('ol', { class: 'st-ins-list' }, items.map((t) => rowOf(t, gap))) : h('p', { class: 'empty-state st-field-hint st-ins-empty' }, empty),
      items.length ? h('button', { type: 'button', class: 'st-link-btn kb-ask-all', onclick: () => showInHistory({ range: 'all', outcome: all }) }, gap ? 'See all questions not in your files' : 'See all answered questions') : null);
    const off = (d.offTopic || []).length;
    sec.append(h('div', { class: 'st-ins-grid' },
      col('Most asked', '', answered, false, 'No answered questions yet.', 'answered'),
      h('div', null, col('Gaps · not in your files', 'st-ins-gaps', gaps, true, off ? 'No content gaps: every on-topic question was answered from your files.' : 'No gaps: every question so far was answered from your files.', 'gap'),
        ...(off ? [h('p', { class: 'st-field-hint st-ins-off' }, `${off} off-topic question${off === 1 ? '' : 's'} turned away, as ${off === 1 ? 'it' : 'they'} should be (not a gap). `,
          h('button', { type: 'button', class: 'st-link-btn', onclick: () => showInHistory({ range: 'all', outcome: 'off_topic' }) }, 'See them'))] : []))));
    return sec;
  }

  function channelsSection(hist) {
    const rows = CHANNELS.map(([id, label]) => ({ id, label, n: hist.byChannel?.[id] || 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map((r) => r.n));
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-ch' }, h('h3', { id: 'kb-leads-ch' }, 'Interactions by channel'));
    if (!rows.length) { sec.append(h('p', { class: 'empty-state kb-leads-empty' }, `No questions in ${rangeWords()} yet.`)); return sec; }
    sec.append(h('p', { class: 'kb-leads-hint' }, `Questions in ${rangeWords()}. Pick a channel to see its questions.`),
      h('ul', { class: 'kb-leads-bars' }, rows.map((r) => h('li', null,
        h('button', { type: 'button', class: 'kb-leads-bar-btn', 'aria-pressed': String(f.channel === r.id), 'aria-label': `${r.label}: ${plural(r.n, 'question')}. Show them in the history.`,
          onclick: () => showInHistory({ day: f.day, dayEnd: f.dayEnd, outcome: f.outcome, q: f.q, channel: f.channel === r.id ? '' : r.id }) },
        h('span', { class: 'kb-leads-bar-label' }, r.label),
        h('span', { class: 'kb-leads-bar-track', 'aria-hidden': 'true' }, h('span', { class: 'kb-leads-bar-fill', style: `width:${Math.max(3, Math.round((r.n / max) * 100))}%` })),
        h('span', { class: 'kb-leads-bar-n st-mono', 'aria-hidden': 'true' }, r.n.toLocaleString()))))));
    return sec;
  }


  // ---- Clicks & sales (server/leads.mjs attribution): links opened from the bot's answers on the website, and the
  // orders the owner's own order page reported after those clicks ("reported by your site", never called payments)
  const fmtMoney = (n, cur) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 2 }).format(Number(n) || 0); }
    catch { return `${(Number(n) || 0).toLocaleString()} ${cur || ''}`.trim(); }
  };
  const fmtShortDay = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  function salesSection(a) {
    if (!a || a.available === false || !a.totals) return null;
    const t = a.totals, installed = !!a.saleTracking?.installed, win = a.windowDays || a.saleWindowDays || 7;
    const winWords = win === 1 ? '1 day' : `${win} days`;
    const revenue = t.revenue || [];
    const csvBtn = (kind, label) => h('button', { type: 'button', class: 'btn btn-ghost st-btn kb-stats-csv', 'data-csv': kind, onclick: () => download(kind) }, ico('table'), h('span', null, h('span', { class: 'st-sr' }, 'Download '), label));
    const big = (label, value, sub, cls = '') => h('li', { class: `kb-sales-tile ${cls}`.trim() }, h('span', { class: 'kb-sales-tile-label' }, label), h('strong', { class: 'kb-sales-tile-n st-mono' }, value), h('span', { class: 'kb-sales-tile-sub' }, sub));
    const setup = () => { close(); document.dispatchEvent(new CustomEvent('knowbot:open-sale-setup')); };
    const tiles = h('ul', { class: 'kb-sales-tiles', 'aria-label': 'Clicks and sales totals' },
      big('Clicks', Number(t.clicks || 0).toLocaleString(), 'on product cards and links in answers'),
      big('Answers that got a click', t.rate == null ? '–' : `${Math.round(t.rate * 100)}%`, t.shown ? `${Number(t.clickedAnswers || 0).toLocaleString()} of ${plural(t.shown, 'answer')} that showed a product or link` : 'no answer has shown a product or link yet'),
      ...(installed
        ? [big('Orders after a click', Number(t.orders || 0).toLocaleString(), `reported by your site, within ${winWords} of a click`),
          big('Sales after a click', revenue.length ? revenue.map((r) => fmtMoney(r.amount, r.currency)).join(' + ') : fmtMoney(0, a.currency || 'USD'), revenue.length ? 'order totals reported by your site' : 'no orders in this range yet', 'kb-sales-money')]
        : [h('li', { class: 'kb-sales-tile kb-sales-cta' },
          h('strong', { class: 'kb-sales-cta-t' }, 'See which answers lead to orders'),
          h('span', { class: 'kb-sales-tile-sub' }, 'Sale tracking is not installed yet, so orders are not counted here. Paste one snippet on your order confirmation page to turn it on. Your store’s own analytics already count these visits (see “How clicks and sales are counted” below).'),
          h('button', { type: 'button', class: 'btn btn-primary st-btn st-btn-primary kb-sales-setup', onclick: setup }, 'Set up sale tracking'))]));

    // per day: clicks and orders, both counts, on one axis; revenue is in the table for screen readers and in the tooltip
    const days = a.byDay || [];
    const weekly = days.length > 45;
    const buckets = [];
    const sum = (run, k) => run.reduce((n, d) => n + (d[k] || 0), 0);
    if (weekly) for (let i = days.length % 7; i <= days.length - 7; i += 7) { const run = days.slice(i, i + 7); buckets.push({ day: run[0].day, dayEnd: run[6].day, clicks: sum(run, 'clicks'), orders: sum(run, 'orders'), revenue: sum(run, 'revenue') }); }
    else for (const d of days) buckets.push({ day: d.day, dayEnd: '', clicks: d.clicks, orders: d.orders, revenue: d.revenue });
    const peak = Math.max(0, ...buckets.map((b) => Math.max(b.clicks, b.orders)));
    const top = niceMax(peak);
    const nameOf = (b) => (b.dayEnd ? `${fmtDay(b.day, { month: 'short', day: 'numeric' })} to ${fmtDay(b.dayEnd, { month: 'short', day: 'numeric' })}` : fmtDay(b.day));
    const sumOf = (b) => `${plural(b.clicks, 'click')}${installed ? `, ${plural(b.orders, 'order')}${b.orders && a.currency ? ` (${fmtMoney(b.revenue, a.currency)})` : ''}` : ''}`;
    const every = buckets.length <= 10 ? 1 : buckets.length <= 31 ? 5 : 7;
    const tickAt = (i) => (buckets.length - 1 - i) % every === 0;
    const pct = (n) => (n ? Math.max(2, (n / top) * 100) : 0);
    const cols = buckets.map((b, i) => h('div', { class: 'kb-sbar', title: `${nameOf(b)}: ${sumOf(b)}` },
      h('span', { class: 'kb-bar-col' },
        b.clicks ? h('span', { class: 'kb-bar-n st-mono' }, b.clicks.toLocaleString()) : null,
        h('span', { class: 'kb-sbar-pair', style: `height:${pct(Math.max(b.clicks, b.orders))}%` },
          h('i', { class: 'kb-sbar-c', style: `height:${b.clicks ? Math.max(4, (b.clicks / Math.max(b.clicks, b.orders)) * 100) : 0}%` }),
          installed ? h('i', { class: 'kb-sbar-o', style: `height:${b.orders ? Math.max(4, (b.orders / Math.max(b.clicks, b.orders)) * 100) : 0}%` }) : null)),
      h('span', { class: `kb-bar-x${tickAt(i) ? ' is-tick' : ''}` }, tickAt(i) ? fmtDay(b.day, { month: 'short', day: 'numeric' }) : '')));
    const ticks = top <= 1 ? [1, 0] : [top, top / 2, 0];
    const scroller = h('div', { class: 'kb-chart-scroll' }, h('div', { class: `kb-chart-plot kb-sales-plot${buckets.length > 45 ? ' is-dense' : ''}`, style: `--n:${buckets.length}` }, cols));
    const active = buckets.filter((b) => b.clicks || b.orders);
    const chart = peak
      ? h('figure', { class: 'kb-chart kb-sales-chart', role: 'group', 'aria-label': `Clicks${installed ? ' and orders' : ''} per ${weekly ? 'week' : 'day'}: ${plural(t.clicks, 'click')}${installed ? ` and ${plural(t.orders, 'order')}` : ''} in ${rangeWords()}. The table after the chart lists each ${weekly ? 'week' : 'day'}.` },
        h('div', { class: 'kb-chart-y', 'aria-hidden': 'true' }, ticks.map((x) => h('span', { class: 'st-mono' }, Number.isInteger(x) ? x.toLocaleString() : ''))),
        h('div', { class: 'kb-chart-area', 'aria-hidden': 'true' }, h('div', { class: 'kb-chart-grid' }, ticks.map(() => h('i'))), scroller),
        h('figcaption', { class: 'kb-sales-cap' },
          h('ul', { class: 'kb-chart-key', 'aria-label': 'Legend' },
            h('li', null, h('i', { class: 'kb-key kb-sbar-c', 'aria-hidden': 'true' }), 'Clicks'),
            installed ? h('li', null, h('i', { class: 'kb-key kb-sbar-o', 'aria-hidden': 'true' }), 'Orders after a click') : null),
          h('table', { class: 'st-sr' },
            h('caption', null, `Clicks${installed ? ' and orders' : ''} by ${weekly ? 'week' : 'day'} (only ${weekly ? 'weeks' : 'days'} with activity)`),
            h('thead', null, h('tr', null, [weekly ? 'Week' : 'Day', 'Clicks', ...(installed ? ['Orders', 'Sales'] : [])].map((x) => h('th', { scope: 'col' }, x)))),
            h('tbody', null, active.map((b) => h('tr', null, h('th', { scope: 'row' }, nameOf(b)), h('td', null, String(b.clicks)), ...(installed ? [h('td', null, String(b.orders)), h('td', null, a.currency ? fmtMoney(b.revenue, a.currency) : '')] : [])))))))
      : null;
    if (chart) requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });

    // top products: by clicks, or by the sales that followed a click on them
    const prodBox = h('div', { class: 'kb-sales-box' });
    const paintProducts = () => {
      const by = st.prodSort === 'revenue' && installed ? 'revenue' : 'clicks';
      const list = [...(a.products || [])].sort((x, y) => (by === 'revenue' ? y.revenue - x.revenue || y.orders - x.orders : 0) || y.clicks - x.clicks).slice(0, 10);
      const sortBtn = (k, label) => h('button', { type: 'button', class: 'st-seg-btn', 'aria-pressed': String(by === k), onclick: () => { st.prodSort = k; paintProducts(); prodBox.querySelector(`[data-sort="${k}"]`)?.focus(); }, 'data-sort': k }, label);
      prodBox.replaceChildren(...[
        h('div', { class: 'kb-sec-head' }, h('h4', { class: 'kb-sales-h4', id: 'kb-sales-ph' }, 'Top products'),
          installed ? h('div', { class: 'st-seg kb-sales-sort', role: 'group', 'aria-label': 'Order the products' }, sortBtn('clicks', 'By clicks'), sortBtn('revenue', 'By sales')) : null),
        list.length
          ? h('div', { class: 'kb-leads-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'kb-sales-ph' }, h('table', { class: 'data-table is-static kb-leads-table kb-sales-table' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Product'), h('th', { scope: 'col', class: 'kb-num' }, 'Clicks'), ...(installed ? [h('th', { scope: 'col', class: 'kb-num' }, 'Orders'), h('th', { scope: 'col', class: 'kb-num' }, 'Sales')] : []))),
            h('tbody', null, list.map((p) => h('tr', null,
              h('td', { class: 'kb-leads-q' }, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', class: 'kb-sales-prod' }, p.title || p.url, h('span', { class: 'st-sr' }, ' (opens in a new tab)')),
                p.price != null ? h('span', { class: 'kb-leads-consent' }, p.currency ? fmtMoney(p.price, p.currency) : String(p.price)) : null),
              h('td', { class: 'kb-num st-mono' }, Number(p.clicks || 0).toLocaleString()),
              ...(installed ? [h('td', { class: 'kb-num st-mono' }, Number(p.orders || 0).toLocaleString()), h('td', { class: 'kb-num st-mono' }, p.orders && a.currency ? fmtMoney(p.revenue, a.currency) : '–')] : []))))))
          : h('p', { class: 'empty-state kb-leads-empty' }, 'No product card has been clicked in this range yet.'),
        installed && list.length ? h('p', { class: 'kb-leads-hint' }, 'Sales are the totals of orders that followed a click on that product’s card. An order can hold other items too.') : null].filter(Boolean));
    };
    paintProducts();
    const qs = (a.questions || []).slice(0, 10);
    const qBox = h('div', { class: 'kb-sales-box' },
      h('h4', { class: 'kb-sales-h4' }, installed ? 'Questions that led to clicks and sales' : 'Questions that led to clicks'),
      qs.length
        ? h('ol', { class: 'kb-sales-qs' }, qs.map((q) => h('li', null,
          searchable(q.question)
            ? h('button', { type: 'button', class: 'st-link-btn kb-sales-q', title: 'See this question in the question history', onclick: () => showInHistory({ range: f.range, q: searchable(q.question) }) }, q.question)
            : h('span', { class: 'kb-sales-q' }, q.question),
          h('span', { class: 'kb-sales-qn' }, plural(q.clicks, 'click'), installed && q.orders ? ` · ${plural(q.orders, 'order')}${a.currency && q.revenue ? ` · ${fmtMoney(q.revenue, a.currency)}` : ''}` : ''))))
        : h('p', { class: 'empty-state kb-leads-empty' }, 'No answer’s links have been clicked in this range yet.'));

    const sales = a.sales || [];
    const salesBox = !installed ? null : h('div', { class: 'kb-sales-box' },
      h('h4', { class: 'kb-sales-h4', id: 'kb-sales-oh' }, 'Orders after a click', h('span', { class: 'kb-leads-count st-mono' }, sales.length.toLocaleString()), h('span', { class: 'chip gray is-label no-dot kb-sales-src' }, 'Reported by your site')),
      sales.length
        ? h('div', { class: 'kb-leads-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'kb-sales-oh' }, h('table', { class: 'data-table is-static kb-leads-table kb-sales-table' },
          h('thead', null, h('tr', null, ['When', 'Order', 'Total', 'Clicked', 'Question', 'Where'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, sales.slice(0, 200).map((s) => h('tr', null,
            h('td', { class: 'kb-leads-when' }, h('time', { datetime: s.at }, fmtTime(s.at))),
            h('td', { class: 'st-mono' }, s.order),
            h('td', { class: 'st-mono kb-leads-when' }, fmtMoney(s.total, s.currency)),
            h('td', { class: 'kb-leads-q' }, s.title || (s.kind === 'source' ? 'A source link' : s.kind === 'link' ? 'A link in the answer' : 'A link'),
              h('span', { class: 'kb-leads-consent' }, s.clickedAt ? `${s.clickSeen ? 'clicked' : 'answer shown'} ${fmtTime(s.clickedAt)}` : '')),
            h('td', { class: 'kb-leads-q' }, s.question && searchable(s.question)
              ? h('button', { type: 'button', class: 'st-link-btn kb-leads-qlink', title: 'See this question in the question history', onclick: () => showInHistory({ range: f.range, q: searchable(s.question) }) }, s.question)
              : (s.question || h('span', { class: 'kb-leads-dim' }, '–'))),
            h('td', null, channelLabel(s.channel)))))))
        : h('p', { class: 'empty-state kb-leads-empty' }, `Sale tracking is installed${a.saleTracking.lastSeenAt ? ` (your order page last checked in on ${fmtShortDay(a.saleTracking.lastSeenAt)})` : ''}. No order has followed a click in ${rangeWords()} yet.`),
      sales.length > 200 ? h('p', { class: 'kb-leads-hint' }, `Showing 200 of ${sales.length.toLocaleString()}. The CSV has them all.`) : null);

    const help = h('details', { class: 'kb-sales-help' },
      h('summary', null, 'How clicks and sales are counted'),
      h('div', { class: 'kb-sales-help-in' },
        h('p', null, h('b', null, 'Campaign tags. '), 'Every link in an answer on your website gets campaign tags (also called UTM tags: short labels added to the end of a link that analytics tools read). They say the visit came from your bot (source “knowbot”), from where (webchat, homepage or voice) and which bot. They do not identify anyone.'),
        h('p', null, h('b', null, 'In your store’s own analytics, with nothing to set up. '), 'In Shopify, open Analytics, then Reports, and look at sessions and sales by marketing source or referrer: your bot shows up as “knowbot”. In Google Analytics, open Reports, then Acquisition, then Traffic acquisition, and look for “knowbot / webchat”. Other tools list it under the campaign source “knowbot”.'),
        h('p', null, h('b', null, 'Orders shown here. '), `With sale tracking installed, your order confirmation page tells KnowBot when an order follows a click within ${winWords} (the newest click counts). These are reported by your site, not verified payments, so check them against your store’s own orders. `,
          h('button', { type: 'button', class: 'st-link-btn', onclick: setup }, installed ? 'Change sale tracking' : 'Set up sale tracking')),
        h('p', null, h('b', null, 'What can be missed. '), 'A visitor who blocks tracking scripts, who buys later on another device or browser, or whose checkout is on a different web address from your shop. A link opened with “open in a new tab” from the right-click menu still carries its tags, but its click is only counted if an order follows.'),
        h('p', null, h('b', null, 'Privacy. '), 'A click keeps the time, the question, the link and a random click id for that answer. No name, address or visitor id, and no cookie. When a visitor’s browser asks not to be tracked (Global Privacy Control or Do Not Track), no click or order is recorded for them; the campaign tags stay because they identify nobody.')));

    return h('section', { id: 'kb-sales', class: 'kb-leads-sec kb-sales', 'aria-labelledby': 'kb-sales-h' },
      h('div', { class: 'kb-sec-head' },
        h('h3', { id: 'kb-sales-h', tabindex: '-1' }, 'Clicks & sales', f.range === 'all' ? h('span', { class: 'kb-leads-hint kb-sec-aside' }, `last ${leadDays()} days`) : null),
        h('div', { class: 'kb-stats-dl kb-sales-dl' }, csvBtn('clicks', 'Clicks CSV'), installed ? csvBtn('sales', 'Sales CSV') : null)),
      h('p', { class: 'kb-leads-hint kb-sales-intro' }, 'Links people opened from your bot’s answers on your website (the chat bubble, Homepage search and voice mode), and the orders your site reported after those clicks.'),
      a.tracking === false ? h('p', { class: 'kb-stats-note' }, ico('info', 13), ' “Track links” is off, so new clicks and orders are not counted. Turn it on at the top of this page.') : null,
      tiles, chart,
      h('div', { class: 'kb-sales-cols' }, prodBox, qBox),
      salesBox, help);
  }

  /** AI agents (server/agents.mjs): questions other AI assistants asked, how they were answered, and the usage meter. */
  function agentsSection(a) {
    if (!a || !(a.questions || a.limited)) return null;
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-ag' }, h('h3', { id: 'kb-leads-ag' }, 'AI agents', h('span', { class: 'kb-leads-count st-mono' }, (a.questions || 0).toLocaleString())));
    const item = (label, n, sub) => h('li', { class: 'kb-leads-agent' }, h('strong', { class: 'st-mono' }, Number(n || 0).toLocaleString()), h('span', null, label), sub ? h('span', { class: 'kb-leads-hint' }, sub) : null);
    sec.append(h('ul', { class: 'kb-leads-agents', 'aria-label': 'AI agents' },
      item('answered from your files', a.answered),
      item('not in your files', a.refused),
      item('free answers', a.free, 'within the daily free limit'),
      item('paid answers', a.paid, 'metered (paid agent access)'),
      item('turned away', a.limited, 'past the free limit'),
      a.owner ? item('your own tests', a.owner, 'with your bot\'s key; never counted') : null));
    return sec;
  }

  function contactCell(l) {
    return l.type === 'email' ? h('a', { href: `mailto:${l.value}`, class: 'kb-leads-contact' }, l.value) : h('a', { href: `tel:${l.value}`, class: 'kb-leads-contact kb-leads-num' }, fmtPhone(l.value));
  }
  function clickedCell(at, n) {
    return at ? h('span', { class: 'chip green is-label no-dot' }, n > 1 ? `Clicked · ${n}×` : 'Clicked') : h('span', { class: 'kb-leads-dim' }, 'Not yet');
  }

  // ---- Leads: sortable; a lead's question opens that question in the history (its day, searched by its words)
  const LEAD_COLS = [['at', 'When'], ['channel', 'Channel'], ['value', 'Contact'], ['question', 'Question'], ['clicks', 'Link']];
  const leadKey = { at: (l) => l.at || '', channel: (l) => channelLabel(l.channel).toLowerCase(), value: (l) => String(l.value || '').toLowerCase(), question: (l) => String(l.question || '').toLowerCase(), clicks: (l) => (l.cid ? 1 + (l.clicks || 0) : 0) };
  function leadsSection(list) {
    const days = leadDays();
    const sec = h('section', { id: 'kb-leads-sec', class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-ls' }, h('h3', { id: 'kb-leads-ls' }, 'Leads', h('span', { class: 'kb-leads-count st-mono' }, list.length.toLocaleString()),
      f.range === 'all' ? h('span', { class: 'kb-leads-hint kb-sec-aside' }, `last ${days} days`) : null));
    if (!list.length) {
      sec.append(h('p', { class: 'empty-state kb-leads-empty' }, 'No leads yet. When a visitor asks your bot to send them an answer, or texts, calls or emails your bot, their email address or number shows up here.'));
      return sec;
    }
    const { key, dir } = st.sort;
    const sorted = [...list].sort((a, b) => { const x = leadKey[key](a), y = leadKey[key](b); return (x < y ? -1 : x > y ? 1 : 0) * dir || String(b.at).localeCompare(String(a.at)); });
    const sortBy = (k) => { st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : (k === 'at' || k === 'clicks' ? -1 : 1) }; const fresh = leadsSection(st.leads.leads); sec.replaceWith(fresh); fresh.querySelector(`th[data-key="${k}"] button`)?.focus(); };
    const table = h('table', { class: 'data-table is-static kb-leads-table' },
      h('caption', { class: 'st-sr' }, `Leads in the last ${days} days. Column headers sort the table.`),
      h('thead', null, h('tr', null, LEAD_COLS.map(([k, t]) => h('th', { scope: 'col', 'data-key': k, 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'kb-leads-sort', onclick: () => sortBy(k) }, t, h('span', { class: 'kb-leads-sort-ico', 'aria-hidden': 'true' }, key === k ? (dir > 0 ? '↑' : '↓') : '↕')))))),
      h('tbody', null, sorted.slice(0, 200).map((l) => h('tr', null,
        h('td', { class: 'kb-leads-when' }, h('time', { datetime: l.at }, fmtTime(l.at))),
        h('td', null, channelLabel(l.channel)),
        h('td', null, contactCell(l), h('span', { class: 'kb-leads-consent' }, l.consentLabel || '')),
        h('td', { class: 'kb-leads-q' }, l.question && searchable(l.question)
          ? h('button', { type: 'button', class: 'st-link-btn kb-leads-qlink', title: 'See this question in the question history', onclick: () => showInHistory({ day: localDayOf(l.at), q: searchable(l.question) }) }, l.question)
          : (l.question || h('span', { class: 'kb-leads-dim' }, '—'))),
        h('td', null, l.cid ? clickedCell(l.clickedAt, l.clicks) : h('span', { class: 'kb-leads-dim' }, '—'))))));
    sec.append(h('div', { class: 'kb-leads-scroll', tabindex: '0', role: 'region', 'aria-label': 'Leads table' }, table));
    if (list.length > 200) sec.append(h('p', { class: 'kb-leads-hint' }, `Showing 200 of ${list.length.toLocaleString()}. The CSV has them all.`));
    return sec;
  }

  function checkoutSection(items) {
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-co' }, h('h3', { id: 'kb-leads-co' }, 'Checkout links sent', h('span', { class: 'kb-leads-count st-mono' }, items.length.toLocaleString())));
    if (!items.length) {
      sec.append(h('p', { class: 'empty-state kb-leads-empty' }, 'None yet. When your phone bot texts a caller a link to their cart, it shows up here with whether they opened it.'));
      return sec;
    }
    const table = h('table', { class: 'data-table is-static kb-leads-table' },
      h('caption', { class: 'st-sr' }, `Checkout links sent in the last ${leadDays()} days`),
      h('thead', null, h('tr', null, ['When', 'Sent to', 'Items', 'Link'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, items.slice(0, 200).map((s) => h('tr', null,
        h('td', { class: 'kb-leads-when' }, h('time', { datetime: s.at }, fmtTime(s.at))),
        h('td', null, s.phone ? h('a', { href: `tel:${s.phone}`, class: 'kb-leads-contact kb-leads-num' }, fmtPhone(s.phone)) : '—'),
        h('td', { class: 'kb-leads-q' }, s.itemsText || '—', s.linkKind === 'product_page' ? h('span', { class: 'kb-leads-consent' }, 'Product page') : null),
        h('td', null, s.cid ? clickedCell(s.clickedAt, s.clicks) : h('span', { class: 'kb-leads-dim' }, '—'))))));
    sec.append(h('div', { class: 'kb-leads-scroll', tabindex: '0', role: 'region', 'aria-label': 'Checkout links table' }, table));
    return sec;
  }
}
