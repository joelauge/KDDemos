// KnowBot Studio: the Leads report (server/leads.mjs, GET /api/studio/trials/:id/leads[.csv]).
//
//   openLeads()   opens the report as a modal dialog: interactions by channel (7 / 30 days), the leads list (every
//                 e-mail address and phone number a visitor gave the bot), checkout links sent and their clicks, the
//                 link-tracking switch, and "Download CSV" (CRM-friendly columns, for the owner's own CRM).
//
// Self-contained (its own dialog, styles in leads.css loaded on first open), so app.js only adds the entry points:
// the header button, the ⋯ menu item, the command palette and the "What people ask" card. Customer-facing copy never
// names a provider.
import * as api from './api.js?v=8edc9a1';
import { getState } from './store.js?v=8edc9a1';
import { icon } from './icons.js?v=8edc9a1';

const CHANNELS = [
  ['web', 'Website chat'], ['site', 'Homepage search'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['email', 'Email'],
  ['phone', 'Phone'], ['voice', 'Web voice'], ['api', 'Developer API'], ['studio', 'Studio (your tests)'],
];
const CHANNEL_LABEL = Object.fromEntries(CHANNELS);
const channelLabel = (c) => CHANNEL_LABEL[c] || c || 'Other';

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

let cssReady = null;
function ensureCss() {
  if (cssReady) return cssReady;
  const href = new URL('./leads.css?v=8edc9a1', import.meta.url);
  href.search = new URL(import.meta.url).search;
  if (document.querySelector(`link[data-kb-leads]`)) return (cssReady = Promise.resolve());
  cssReady = new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: href.href, 'data-kb-leads': '' });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
    setTimeout(resolve, 1500);
  });
  return cssReady;
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const fmtPhone = (p) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ''));
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : String(p || '');
};

let open = null;

/** Opens the Leads report (one at a time). Resolves when it is shown. */
export async function openLeads() {
  if (open) { open.dialog.focus(); return; }
  if (!getState().trial?.id) return;
  await ensureCss();
  const invoker = document.activeElement;
  let days = 30;
  let data = null;
  let busy = false;

  const titleId = 'kb-leads-title';
  const status = h('p', { class: 'kb-leads-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'kb-leads-body' });
  const seg = h('div', { class: 'st-seg kb-leads-seg', role: 'group', 'aria-label': 'Time range' });
  const segBtn = (n) => h('button', { type: 'button', class: 'st-seg-btn', 'aria-pressed': String(n === days), 'data-days': n, onclick: () => { if (days !== n) { days = n; paintSeg(); load(); } } }, `Last ${n} days`);
  seg.append(segBtn(7), segBtn(30));
  const paintSeg = () => { for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)); };
  const csvBtn = h('button', { type: 'button', class: 'btn btn-primary st-btn st-btn-primary kb-leads-csv', onclick: () => download() },
    h('span', { 'aria-hidden': 'true', html: icon('table', 14) }), h('span', null, 'Download CSV'));
  const trackSw = h('button', { type: 'button', role: 'switch', 'aria-checked': 'true', class: 'kb-leads-switch', 'aria-describedby': 'kb-leads-track-hint', onclick: () => toggleTracking() },
    h('span', { class: 'kb-leads-knob', 'aria-hidden': 'true' }), h('span', { class: 'kb-leads-switch-label' }, 'Track links'));
  const trackHint = h('span', { id: 'kb-leads-track-hint', class: 'kb-leads-hint' }, 'Adds campaign tags and a short tracking link to every link your bot sends by text, email or WhatsApp.');
  const close = h('button', { type: 'button', class: 'st-iconbtn kb-leads-close', 'aria-label': 'Close the leads report', html: icon('close', 18), onclick: () => dialog.close() });
  const dialog = h('dialog', { class: 'kb-leads', 'aria-labelledby': titleId, 'aria-describedby': 'kb-leads-sub' },
    h('div', { class: 'kb-leads-panel' },
      h('header', { class: 'kb-leads-head' },
        h('span', { class: 'kb-leads-ico', 'aria-hidden': 'true', html: icon('users', 18) }),
        h('div', { class: 'kb-leads-titles' },
          h('h2', { id: titleId }, 'Leads'),
          h('p', { id: 'kb-leads-sub' }, 'Who your bot talked to, what it sent them, and what they clicked. Download it into your own CRM.')),
        close),
      h('div', { class: 'kb-leads-bar' }, seg, h('div', { class: 'kb-leads-track' }, trackSw, trackHint), csvBtn),
      status, body));

  dialog.addEventListener('close', () => {
    dialog.remove();
    open = null;
    if (invoker && invoker.isConnected) invoker.focus();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // the backdrop
  document.body.append(dialog);
  open = { dialog };
  dialog.showModal();
  close.focus();
  await load();

  async function load() {
    busy = true;
    body.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading…';
    try {
      data = await api.leads(days);
      paint();
      status.textContent = `Showing the last ${days} days: ${plural(data.interactions?.total || 0, 'question')}, ${plural(data.leads.length, 'lead')}, ${plural(data.conversions.sent, 'checkout link')} sent.`;
    } catch (e) {
      body.replaceChildren(h('p', { class: 'alert alert-danger kb-leads-err', role: 'alert' }, e?.status === 401 ? 'This bot has expired, so its leads are no longer available.' : "Couldn't load the leads report. Try again in a moment."));
      status.textContent = '';
    } finally {
      busy = false;
      body.removeAttribute('aria-busy');
    }
  }

  async function toggleTracking() {
    if (!data || busy) return;
    const next = !(trackSw.getAttribute('aria-checked') === 'true');
    trackSw.setAttribute('aria-checked', String(next));
    try {
      const r = await api.setLeadTracking(next);
      data.tracking = r.tracking;
      status.textContent = r.tracking ? 'Link tracking is on.' : 'Link tracking is off: links are sent as they are.';
    } catch {
      trackSw.setAttribute('aria-checked', String(!next));
      status.textContent = "Couldn't change link tracking. Try again.";
    }
  }

  async function download() {
    csvBtn.disabled = true;
    status.textContent = 'Preparing the CSV…';
    try {
      const res = await api.leadsCsv(days);
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1])
        || `knowbot-leads-${(getState().spec?.name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'}-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.textContent = `Downloaded ${name}.`;
    } catch {
      status.textContent = "Couldn't download the CSV. Try again in a moment.";
    } finally { csvBtn.disabled = false; }
  }

  function paint() {
    trackSw.setAttribute('aria-checked', String(data.tracking !== false));
    const ix = data.interactions || { total: 0, byChannel: {}, byDay: [] };
    const emails = data.leads.filter((l) => l.type === 'email').length;
    const phones = data.leads.length - emails;
    const tiles = h('ul', { class: 'kb-leads-tiles', 'aria-label': 'Totals' },
      tile('Questions', ix.total, ix.refused ? `${ix.refused.toLocaleString()} not in your files` : 'all answered from your files'),
      tile('Leads', data.leads.length, `${plural(emails, 'email')} · ${plural(phones, 'phone')}`),
      tile('Checkout links sent', data.conversions.sent, `${plural(data.conversions.clickedSends || 0, 'opened', 'opened')}`),
      tile('Link clicks', data.links?.clicks || 0, `on ${plural(data.links?.sent || 0, 'tracked link')}`));
    body.replaceChildren(tiles, channelsSection(ix), leadsSection(data.leads), checkoutSection(data.conversions.items || []),
      h('p', { class: 'kb-leads-foot' }, h('span', { 'aria-hidden': 'true', html: icon('lock', 12) }),
        ` Only you can see this report. Leads are kept for ${data.retentionDays || 90} days. Tracked links carry utm_source=knowbot, utm_medium (the channel) and utm_campaign (this bot), so your own analytics can count visits and sales from them.`));
  }

  function tile(label, n, sub) {
    return h('li', { class: 'kb-leads-tile' }, h('span', { class: 'kb-leads-tile-label' }, label), h('strong', { class: 'kb-leads-tile-n st-mono' }, Number(n || 0).toLocaleString()), h('span', { class: 'kb-leads-tile-sub' }, sub));
  }

  function channelsSection(ix) {
    const rows = CHANNELS.map(([id, label]) => ({ id, label, n: ix.byChannel?.[id] || 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map((r) => r.n));
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-ch' }, h('h3', { id: 'kb-leads-ch' }, 'Interactions by channel'));
    if (!rows.length) { sec.append(h('p', { class: 'empty-state kb-leads-empty' }, `No questions in the last ${days} days yet.`)); return sec; }
    sec.append(h('ul', { class: 'kb-leads-bars' }, rows.map((r) => h('li', null,
      h('span', { class: 'kb-leads-bar-label' }, r.label),
      h('span', { class: 'kb-leads-bar-track', 'aria-hidden': 'true' }, h('span', { class: 'kb-leads-bar-fill', style: `width:${Math.max(3, Math.round((r.n / max) * 100))}%` })),
      h('span', { class: 'kb-leads-bar-n st-mono' }, r.n.toLocaleString(), h('span', { class: 'st-sr' }, r.n === 1 ? ' question' : ' questions'))))));
    const byDay = ix.byDay || [];
    if (byDay.length > 1) {
      const peak = Math.max(1, ...byDay.map((d) => d.total));
      const w = 100 / byDay.length;
      const svg = `<svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">${byDay.map((d, i) => { const bh = d.total ? Math.max(1.5, (d.total / peak) * 30) : 0; return `<rect x="${(i * w + w * 0.15).toFixed(2)}" y="${(32 - bh).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6"><title>${d.day}: ${d.total}</title></rect>`; }).join('')}</svg>`;
      const busiest = byDay.reduce((a, b) => (b.total > a.total ? b : a), byDay[0]);
      sec.append(h('figure', { class: 'kb-leads-days' }, h('div', { class: 'kb-leads-days-chart', html: svg }),
        h('figcaption', null, `Questions per day. Busiest: ${new Date(`${busiest.day}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (${plural(busiest.total, 'question')}).`)));
    }
    return sec;
  }

  function contactCell(l) {
    return l.type === 'email' ? h('a', { href: `mailto:${l.value}`, class: 'kb-leads-contact' }, l.value) : h('a', { href: `tel:${l.value}`, class: 'kb-leads-contact kb-leads-num' }, fmtPhone(l.value));
  }
  function clickedCell(at, n) {
    return at ? h('span', { class: 'chip green is-label no-dot' }, n > 1 ? `Clicked · ${n}×` : 'Clicked') : h('span', { class: 'kb-leads-dim' }, 'Not yet');
  }

  function leadsSection(list) {
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-ls' }, h('h3', { id: 'kb-leads-ls' }, 'Leads', h('span', { class: 'kb-leads-count st-mono' }, list.length.toLocaleString())));
    if (!list.length) {
      sec.append(h('p', { class: 'empty-state kb-leads-empty' }, 'No leads yet. When a visitor asks your bot to send them an answer, or texts, calls or emails your bot, their email address or number shows up here.'));
      return sec;
    }
    const table = h('table', { class: 'data-table is-static kb-leads-table' },
      h('caption', { class: 'st-sr' }, `Leads in the last ${days} days`),
      h('thead', null, h('tr', null, ['When', 'Channel', 'Contact', 'Question', 'Link'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, list.slice(0, 200).map((l) => h('tr', null,
        h('td', { class: 'kb-leads-when' }, h('time', { datetime: l.at }, fmtTime(l.at))),
        h('td', null, channelLabel(l.channel)),
        h('td', null, contactCell(l), h('span', { class: 'kb-leads-consent' }, l.consentLabel || '')),
        h('td', { class: 'kb-leads-q' }, l.question || h('span', { class: 'kb-leads-dim' }, '—')),
        h('td', null, l.cid ? clickedCell(l.clickedAt, l.clicks) : h('span', { class: 'kb-leads-dim' }, '—'))))));
    sec.append(h('div', { class: 'kb-leads-scroll', tabindex: '0', role: 'region', 'aria-label': 'Leads table' }, table));
    if (list.length > 200) sec.append(h('p', { class: 'kb-leads-hint' }, `Showing the newest 200 of ${list.length.toLocaleString()}. The CSV has them all.`));
    return sec;
  }

  function checkoutSection(items) {
    const sec = h('section', { class: 'kb-leads-sec', 'aria-labelledby': 'kb-leads-co' }, h('h3', { id: 'kb-leads-co' }, 'Checkout links sent', h('span', { class: 'kb-leads-count st-mono' }, items.length.toLocaleString())));
    if (!items.length) {
      sec.append(h('p', { class: 'empty-state kb-leads-empty' }, 'None yet. When your phone bot texts a caller a link to their cart, it shows up here with whether they opened it.'));
      return sec;
    }
    const table = h('table', { class: 'data-table is-static kb-leads-table' },
      h('caption', { class: 'st-sr' }, `Checkout links sent in the last ${days} days`),
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
