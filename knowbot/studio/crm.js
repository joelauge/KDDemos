// KnowBot Studio: "Connect your CRM", a section of Stats & Leads (studio/leads.js mounts it under the Leads table).
//
//   crmSection()   → the <section id="kb-crm">: one row per connector (Webhook, Zapier, HubSpot, Salesforce, Pipedrive,
//                    Zoho CRM, Mailchimp, Constant Contact). A row opens in place (a disclosure) to:
//                      not connected   paste a token / address, or sign in in a popup; "Not available yet" when
//                                      one-click sign-in is not switched on and there is nothing to paste
//                      connected       status (Connected / Needs attention + what to do), settings, Send a test lead,
//                                      Sync past leads, Retry failed, the delivery log (last 50), Disconnect
//
// Data: /api/studio/trials/:id/crm… (server/crm/routes.mjs). Secrets never come back from the server: a webhook's
// signing secret and a Zapier key are shown once, right after they are made. Names of the services are shown as text
// (they are integrations the owner picks); nothing here names what KnowBot itself runs on.
import * as api from './api.js';
import { icon } from './icons.js';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const ico = (name, size = 14) => h('span', { class: 'kb-stats-ico', 'aria-hidden': 'true', html: icon(name, size) });
const fmtWhen = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const errText = (e, fallback) => `${(e && e.message) || fallback}${e?.detail?.action ? ` ${e.detail.action}` : ''}`;
const apiOrigin = (() => { try { return new URL(api.BASE || location.origin, location.href).origin; } catch { return location.origin; } })();
const RESULT = { delivered: ['green', 'Delivered'], retrying: ['amber', 'Trying again'], failed: ['red', 'Failed'], skipped: ['gray', 'Skipped'] };
const ACTION = { created: 'New record', updated: 'Updated', sent: 'Sent', saved: 'Saved' };
const ZAPIER_HELP = 'The KnowBot app is not in Zapier’s app directory yet. You can use Zapier today: in Zapier, start a Zap with “Webhooks by Zapier” and choose “Catch Hook”, copy the address it gives you, and paste it into Webhook above. The same works for Make and n8n.';

/** The section element. It loads itself; `announce(text)` goes to the view's live region. */
export function crmSection({ announce = () => {} } = {}) {
  const st = { view: null, open: null, logs: {}, lists: {}, reveal: {}, busy: new Set(), msg: {}, popup: null };
  const list = h('ul', { class: 'kb-crm-list' });
  const note = h('p', { class: 'kb-leads-hint kb-crm-intro' }, 'Send every new lead to the tools you already use, the moment your bot captures it. Only leads are sent (an email address or phone number someone gave your bot), never plain questions, and each one says how you got it.');
  const sec = h('section', { id: 'kb-crm', class: 'kb-leads-sec kb-crm', 'aria-labelledby': 'kb-crm-h' },
    h('h3', { id: 'kb-crm-h', tabindex: '-1' }, 'Connect your CRM'), note, list);
  const say = (id, text, bad = false) => { st.msg[id] = text ? { text, bad } : null; announce(text || ''); paint(); };
  const rows = () => (st.view ? [...st.view.connectors.slice(0, 1), { ...st.view.zapier, zapier: true }, ...st.view.connectors.slice(1)] : []);

  async function load({ quiet = false } = {}) {
    try { st.view = await api.crm(); paint(); }
    catch (e) { if (!quiet) list.replaceChildren(h('li', { class: 'empty-state kb-leads-empty' }, errText(e, "Couldn't load your connections. Try again in a moment."))); }
  }
  /** Runs one action for a row with its button busy; errors land in the row's message. */
  async function act(id, key, fn, done) {
    const k = `${id}:${key}`;
    if (st.busy.has(k)) return;
    st.busy.add(k); st.msg[id] = null; paint();
    try { const r = await fn(); st.busy.delete(k); if (done) await done(r); else paint(); }
    catch (e) { st.busy.delete(k); say(id, errText(e, 'That did not work. Try again in a moment.'), true); }
  }
  const btn = (id, key, label, fn, cls = 'btn btn-ghost st-btn', extra = {}) => {
    const busy = st.busy.has(`${id}:${key}`);
    return h('button', { type: 'button', class: `${cls} kb-crm-btn${busy ? ' is-busy' : ''}`, 'data-act': key, disabled: busy, 'aria-busy': busy ? 'true' : null, onclick: fn, ...extra }, label);
  };

  // ---- one-click sign-in: a popup the server points at the vendor; its last page posts {type:'knowbot:crm'} back
  function signIn(c, options) {
    let w = null;
    try { w = window.open('', 'knowbot-crm-signin', 'popup,width=520,height=720'); } catch { w = null; } // inside the click, or it is blocked
    act(c.id, 'oauth', () => api.crmOauth(c.id, options), (r) => {
      if (w && !w.closed) { try { w.location.href = r.url; w.focus?.(); } catch { w = null; } }
      if (!w || w.closed) { st.reveal[c.id] = { link: r.url }; say(c.id, 'Your browser blocked the sign-in window. Open it with the link below.'); return; }
      st.popup = { id: c.id, w };
      say(c.id, `Finish signing in to ${c.name} in the window that opened.`);
      const tick = setInterval(async () => {
        if (!st.popup || st.popup.w !== w) return clearInterval(tick);
        if (!w.closed) return;
        clearInterval(tick); st.popup = null;
        await load({ quiet: true });
        const now = st.view?.connectors.find((x) => x.id === c.id)?.connection;
        say(c.id, now ? `${c.name} is connected.` : `${c.name} was not connected. Try again when you are ready.`, !now);
      }, 700);
    });
  }
  window.addEventListener('message', async (e) => {
    if (!sec.isConnected || e.origin !== apiOrigin || !e.data || e.data.type !== 'knowbot:crm') return;
    const id = String(e.data.crm || '');
    st.popup = null;
    await load({ quiet: true });
    const c = st.view?.connectors.find((x) => x.id === id);
    if (!c) return;
    st.open = id;
    say(id, e.data.ok ? `${c.name} is connected.` : `${e.data.message || `${c.name} was not connected.`}${e.data.ref ? ` (ref ${e.data.ref})` : ''}`, !e.data.ok);
  });

  // ---- pieces of an open row
  function field(c, f, value, idp) {
    const id = `${idp}-${f.key}`;
    let input;
    if (f.type === 'select') input = h('select', { id, name: f.key, class: 'input kb-hist-in' }, f.options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    else if (f.type === 'list') {
      const ls = st.lists[c.id];
      input = h('select', { id, name: f.key, class: 'input kb-hist-in', 'aria-busy': ls ? null : 'true' },
        h('option', { value: '', selected: !value }, ls ? (ls.error ? 'Could not load your lists' : ls.items.length ? 'Choose one…' : 'No lists found') : 'Loading…'),
        (ls?.items || []).map((l) => h('option', { value: l.id, selected: l.id === value }, l.name)),
        value && ls && !ls.items.some((l) => l.id === value) ? h('option', { value, selected: true }, 'The list you chose before') : null);
    } else input = h('input', { id, name: f.key, type: 'text', class: 'input kb-hist-in', value: value || '', maxlength: f.maxLength || 100, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': f.help ? `${id}-h` : null });
    return h('div', { class: 'kb-crm-field' }, h('label', { for: id }, f.label), input, f.help ? h('span', { id: `${id}-h`, class: 'kb-leads-hint' }, f.help) : null);
  }
  function settings(c) {
    if (!c.fields?.length) return null;
    const form = h('form', { class: 'kb-crm-form', 'aria-label': `${c.name} settings`, onsubmit: (e) => {
      e.preventDefault();
      const config = Object.fromEntries(c.fields.map((f) => [f.key, form.elements[f.key].value]));
      act(c.id, 'save', () => api.crmConfig(c.id, config), (v) => { st.view = v; say(c.id, 'Settings saved.'); });
    } }, h('h4', null, 'Settings'), h('div', { class: 'kb-crm-fields' }, c.fields.map((f) => field(c, f, c.connection.config?.[f.key] ?? '', `kb-crm-${c.id}`))),
    h('div', { class: 'kb-crm-actions' }, btn(c.id, 'save', 'Save settings', null, 'btn btn-primary st-btn st-btn-primary', { type: 'submit' })));
    if (c.fields.some((f) => f.type === 'list') && !st.lists[c.id]) {
      st.lists[c.id] = null;
      api.crmLists(c.id).then((r) => { st.lists[c.id] = { items: r.lists || [] }; }, () => { st.lists[c.id] = { items: [], error: true }; }).then(paint);
    }
    return form;
  }
  function logTable(id) {
    const log = st.logs[id];
    if (!log) return null;
    if (!log.length) return h('p', { class: 'empty-state kb-leads-empty' }, 'Nothing has been sent yet. Send a test lead to try it.');
    return h('div', { class: 'kb-leads-scroll kb-crm-log', tabindex: '0', role: 'region', 'aria-label': 'Delivery log' },
      h('table', { class: 'data-table is-static kb-leads-table' },
        h('caption', { class: 'st-sr' }, 'The last 50 deliveries, newest first'),
        h('thead', null, h('tr', null, ['When', 'Lead', 'Result', 'Details'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, log.map((r) => {
          const [color, label] = RESULT[r.result] || ['gray', r.result];
          return h('tr', null,
            h('td', { class: 'kb-leads-when' }, h('time', { datetime: r.at }, fmtWhen(r.at))),
            h('td', null, r.test ? 'Test lead' : (r.who || '—')),
            h('td', null, h('span', { class: `chip ${color} is-label no-dot` }, label)),
            h('td', { class: 'kb-leads-q' }, r.error ? `${r.error}${r.action && r.result === 'failed' ? ` ${r.action}` : ''}` : (ACTION[r.action] || ''),
              r.attempts > 1 ? h('span', { class: 'kb-leads-consent' }, `${r.attempts} tries`) : null,
              r.recordUrl ? h('a', { href: r.recordUrl, target: '_blank', rel: 'noopener noreferrer', class: 'kb-crm-open' }, 'Open', h('span', { class: 'st-sr' }, ' the record (new tab)')) : null));
        }))));
  }
  const showLog = (id) => act(id, 'log', () => api.crmLog(id), (r) => { st.logs[id] = r.log || []; paint(); });
  function tools(c, id = c.id) {
    const conn = c.zapier ? c : c.connection;
    const refreshLog = async () => { if (st.logs[id]) st.logs[id] = (await api.crmLog(id)).log || []; };
    return h('div', { class: 'kb-crm-actions' },
      btn(id, 'test', 'Send a test lead', () => act(id, 'test', () => api.crmTest(id), async (r) => {
        await refreshLog(); await load({ quiet: true });
        say(id, r.ok ? (r.entry.result === 'skipped' ? 'The test lead was skipped.' : `Test lead delivered to ${c.name}. Look for “KnowBot Test Lead”.`) : `The test lead was not delivered. ${r.entry.error || ''} ${r.entry.action || ''}`.trim(), !r.ok);
      })),
      btn(id, 'sync', 'Sync past leads', () => act(id, 'sync', () => api.crmSync(id), async (r) => {
        say(id, r.queued ? `Sending ${r.queued === 1 ? '1 lead' : `${r.queued} leads`} from the last ${r.days} days. This can take a few minutes.` : `Nothing to send: every lead from the last ${r.days} days is already there.`);
        for (const ms of [1500, 5000]) setTimeout(async () => { if (!sec.isConnected) return; await refreshLog().catch(() => {}); await load({ quiet: true }); }, ms);
      })),
      conn.failed ? btn(id, 'retry', `Retry failed (${conn.failed})`, () => act(id, 'retry', () => api.crmRetry(id), async () => { await load({ quiet: true }); say(id, 'Trying those again now.'); })) : null,
      st.logs[id] ? btn(id, 'hidelog', 'Hide delivery log', () => { delete st.logs[id]; paint(); }, 'btn btn-ghost st-btn', { 'aria-expanded': 'true' }) : btn(id, 'log', 'Delivery log', () => showLog(id), 'btn btn-ghost st-btn', { 'aria-expanded': 'false' }),
      st.confirm === id
        ? h('span', { class: 'kb-crm-confirm', role: 'group', 'aria-label': `Disconnect ${c.name}?` }, h('span', null, `Disconnect ${c.name}? Leads stop going there.`),
          btn(id, 'disconnect', 'Yes, disconnect', () => act(id, 'disconnect', () => api.crmDisconnect(id), (v) => { st.view = v; st.confirm = null; delete st.logs[id]; delete st.reveal[id]; delete st.lists[id]; say(id, `${c.name} is disconnected.`); }), 'btn btn-ghost st-btn kb-crm-danger'),
          btn(id, 'keep', 'Keep it', () => { st.confirm = null; paint(); }))
        : btn(id, 'askdisconnect', 'Disconnect', () => { st.confirm = id; paint(); sec.querySelector(`[data-crm="${id}"] [data-act="keep"]`)?.focus(); }, 'btn btn-ghost st-btn kb-crm-danger'));
  }
  function copyBox(label, value, hint) {
    const out = h('code', { class: 'kb-crm-secret st-mono' }, value);
    const b = h('button', { type: 'button', class: 'btn btn-ghost st-btn', onclick: async () => { try { await navigator.clipboard.writeText(value); b.textContent = 'Copied'; announce('Copied.'); } catch { const r = document.createRange(); r.selectNodeContents(out); getSelection().removeAllRanges(); getSelection().addRange(r); } } }, 'Copy');
    return h('div', { class: 'kb-crm-reveal', role: 'group', 'aria-label': label }, h('strong', null, label), h('div', { class: 'kb-crm-secret-row' }, out, b), hint ? h('span', { class: 'kb-leads-hint' }, hint) : null);
  }

  function connectForm(c) {
    const a = c.auth || {};
    const parts = [];
    const paste = a.url || a.token;
    if (a.oauth?.available) {
      const opts = (a.oauth.options || []).map((f) => field(c, f, f.default, `kb-crm-${c.id}-o`));
      const form = h('form', { class: 'kb-crm-form', onsubmit: (e) => { e.preventDefault(); signIn(c, Object.fromEntries((a.oauth.options || []).map((f) => [f.key, form.elements[f.key].value]))); } },
        opts.length ? h('div', { class: 'kb-crm-fields' }, opts) : null,
        h('div', { class: 'kb-crm-actions' }, btn(c.id, 'oauth', `Sign in to ${c.name}`, null, 'btn btn-primary st-btn st-btn-primary', { type: 'submit' })),
        h('span', { class: 'kb-leads-hint' }, `A ${c.name} window opens. You sign in there; KnowBot never sees your password.`));
      parts.push(form);
      if (st.reveal[c.id]?.link) parts.push(h('p', { class: 'kb-leads-hint' }, h('a', { href: st.reveal[c.id].link, target: '_blank', rel: 'noopener' }, `Open the ${c.name} sign-in`)));
    }
    if (paste) {
      const id = `kb-crm-${c.id}-paste`;
      const input = h('input', { id, name: 'value', class: 'input kb-hist-in', type: a.url ? 'url' : 'password', inputmode: a.url ? 'url' : null, placeholder: paste.placeholder || '', autocomplete: 'off', spellcheck: 'false', required: true, 'aria-describedby': `${id}-h` });
      parts.push(h('form', { class: 'kb-crm-form', onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return;
        act(c.id, 'connect', () => api.crmConnect(c.id, a.url ? { url: v } : { token: v }), (r) => {
          const { reveal, ...view } = r; st.view = view;
          if (reveal?.secret) st.reveal[c.id] = { secret: reveal.secret, header: reveal.header };
          say(c.id, `${c.name} is connected. Send a test lead to see it arrive.`);
        });
      } }, a.oauth?.available ? h('p', { class: 'kb-crm-or' }, 'or paste a key instead') : null,
      h('div', { class: 'kb-crm-field' }, h('label', { for: id }, paste.label), input, h('span', { id: `${id}-h`, class: 'kb-leads-hint' }, paste.help || '')),
      h('div', { class: 'kb-crm-actions' }, btn(c.id, 'connect', a.url ? 'Connect' : `Connect ${c.name}`, null, a.oauth?.available ? 'btn btn-ghost st-btn' : 'btn btn-primary st-btn st-btn-primary', { type: 'submit' }))));
    }
    if (!parts.length) parts.push(h('p', { class: 'kb-crm-soon' }, ico('clock', 13), ` Connecting ${c.name} is not available yet. In the meantime, the Webhook connection above can send your leads to it through Zapier or Make.`));
    else if (a.oauth && !a.oauth.available && paste) { /* a pasted key is the way in for now: nothing to add */ }
    return parts;
  }
  function zapierPanel(z) {
    const key = st.reveal.zapier?.key;
    return [
      h('p', { class: 'kb-crm-soon' }, ico('info', 13), ` ${ZAPIER_HELP}`),
      h('h4', null, 'For the KnowBot Zapier app'),
      h('p', { class: 'kb-leads-hint' }, 'If you were invited to the KnowBot app in Zapier, it asks for an API key. Create one here and paste it into Zapier. ', z.key ? `Your current key ends in ${z.key.last4}.` : ''),
      key ? copyBox('Your Zapier API key', key, 'Copy it now. For your security we can’t show it again. Creating a new key stops the old one.') : null,
      h('div', { class: 'kb-crm-actions' }, btn('zapier', 'key', z.key ? 'Create a new key' : 'Create an API key', () => act('zapier', 'key', () => api.crmZapierKey(), async (r) => { st.reveal.zapier = { key: r.key }; await load({ quiet: true }); say('zapier', 'Your Zapier API key is ready. Copy it now.'); }), z.key ? 'btn btn-ghost st-btn' : 'btn btn-primary st-btn st-btn-primary')),
      z.key ? h('p', { class: 'kb-leads-hint' }, z.hooks.length ? `${z.hooks.length === 1 ? '1 Zap is' : `${z.hooks.length} Zaps are`} listening for new leads.` : 'No Zap is listening yet. Turn on a Zap that starts with “New Lead” in KnowBot.') : null,
      z.key && z.hooks.length ? tools(z, 'zapier') : z.key ? h('div', { class: 'kb-crm-actions' }, btn('zapier', 'askdisconnect', 'Remove the key', () => act('zapier', 'disconnect', () => api.crmDisconnect('zapier'), (v) => { st.view = v; delete st.reveal.zapier; say('zapier', 'The Zapier key was removed.'); }), 'btn btn-ghost st-btn kb-crm-danger')) : null,
      logTable('zapier'),
    ];
  }
  function panel(c) {
    if (c.zapier) return zapierPanel(c);
    const conn = c.connection;
    if (!conn) return connectForm(c);
    const rv = st.reveal[c.id];
    return [
      h('p', { class: 'kb-crm-acct' }, `Connected to ${conn.account}`, conn.hint ? h('span', { class: 'kb-leads-dim st-mono' }, ` ${conn.hint}`) : null, h('span', { class: 'kb-leads-dim' }, ` · since ${fmtWhen(conn.connectedAt)}`),
        conn.pending ? h('span', { class: 'kb-leads-dim' }, ` · ${conn.pending} waiting to be sent`) : null),
      conn.problem ? h('p', { class: 'kb-crm-problem', role: 'alert' }, ico('warn', 14), h('span', null, h('strong', null, conn.problem.message), conn.problem.action ? ` ${conn.problem.action}` : '')) : null,
      rv?.secret ? copyBox('Signing secret', rv.secret, `Copy it now. For your security we can’t show it again. Every request carries an ${rv.header || 'X-KnowBot-Signature'} header made with it (HMAC-SHA256), so your side can check a lead really came from KnowBot. Zapier, Make and n8n work without it.`) : null,
      settings(c), tools(c), logTable(c.id),
    ];
  }

  function statusChip(c) {
    if (c.zapier) return c.key ? (c.failed ? ['amber', 'Needs attention'] : c.hooks.length ? ['green', 'Connected'] : ['gray', 'Key created']) : ['gray', 'Not connected'];
    if (c.connection) return c.connection.status === 'attention' ? ['amber', 'Needs attention'] : ['green', 'Connected'];
    const a = c.auth || {};
    return a.oauth?.available || a.token || a.url ? ['gray', 'Not connected'] : ['gray', 'Not available yet'];
  }
  function paint() {
    if (!st.view) return;
    const active = document.activeElement && sec.contains(document.activeElement) ? document.activeElement : null;
    const keep = active ? { row: active.closest('[data-crm]')?.dataset.crm, act: active.dataset.act, id: active.id, value: active.value } : null;
    const typed = Object.fromEntries([...sec.querySelectorAll('input[id], select[id]')].map((n) => [n.id, n.value]));
    list.replaceChildren(...rows().map((c) => {
      const id = c.id, open = st.open === id;
      const [color, label] = statusChip(c);
      const connected = c.zapier ? !!c.key : !!c.connection;
      const pid = `kb-crm-p-${id}`;
      const m = st.msg[id];
      return h('li', { class: `kb-crm-row${open ? ' is-open' : ''}`, 'data-crm': id },
        h('div', { class: 'kb-crm-head' },
          h('div', { class: 'kb-crm-name' }, h('strong', null, c.name), h('span', { class: `chip ${color} is-label no-dot kb-crm-status` }, label), h('span', { class: 'kb-leads-hint kb-crm-blurb' }, c.blurb)),
          h('button', { type: 'button', class: `btn ${connected || open || label === 'Not available yet' ? 'btn-ghost' : 'btn-primary st-btn-primary'} st-btn kb-crm-toggle`, 'data-act': 'toggle', 'aria-expanded': String(open), 'aria-controls': pid,
            onclick: () => { st.open = open ? null : id; st.confirm = null; paint(); } },
          open ? 'Close' : connected ? 'Manage' : label === 'Not available yet' ? 'Details' : c.zapier ? 'Set up' : 'Connect', h('span', { class: 'st-sr' }, ` ${c.name}`))),
        h('p', { class: `kb-crm-msg${m?.bad ? ' is-bad' : ''}`, role: m?.bad ? 'alert' : 'status', hidden: !m }, m?.text || ''),
        open ? h('div', { id: pid, class: 'kb-crm-panel' }, panel(c)) : null);
    }));
    // keep what was being typed, and the focus, across a repaint
    for (const [id, v] of Object.entries(typed)) {
      const n = document.getElementById(id);
      if (!n || !v || n.type === 'password') continue;
      if (n.tagName === 'SELECT') { if ([...n.options].some((o) => o.value === v)) n.value = v; } else if (!n.value) n.value = v;
    }
    if (keep) {
      const row = keep.row ? sec.querySelector(`[data-crm="${keep.row}"]`) : null;
      const again = (keep.id && document.getElementById(keep.id)) || (row && keep.act && row.querySelector(`[data-act="${keep.act}"]:not([disabled])`)) || row?.querySelector('.kb-crm-toggle');
      again?.focus({ preventScroll: true });
    }
  }
  list.append(h('li', { class: 'kb-leads-hint' }, 'Loading your connections…'));
  load();
  return sec;
}
