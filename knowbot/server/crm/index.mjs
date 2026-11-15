// KnowBot lead delivery: the leads a bot captures (server/leads.mjs) are sent to the CRMs its owner connected.
//
// Pieces
//   connectors/*.mjs   one adapter per destination, all with the same interface:
//                        { id, name, blurb, auth:{oauth?,token?,url?}, fields:[…mapping the owner may edit…],
//                          connect(ctx, input)?   pasted token / webhook URL → { secrets, account, hint, reveal? }
//                          oauth?: { authorizeUrl(ctx, {client, redirectUri, state, challenge, options}),
//                                    exchange(ctx, {client, code, redirectUri, verifier, options, query}) → { secrets, access, account },
//                                    refresh(ctx, {client}) → { access:{token, expiresIn}, secrets? } },
//                          verify(ctx) → { account? }, deliver(ctx, lead, progress) → { action, recordId?, recordUrl? } }
//   payload.mjs        the standard lead payload and its stable id
//   http.mjs           CrmError and the error mapping; safefetch.mjs: the SSRF-safe POST for owner-supplied URLs
//   this file          connections, the outbox, the delivery log, test / sync, Zapier keys and REST hooks
//
// Where things live
//   T.flags.crm (the bot's saved state: the spec doc, carried through convert/launch like every other flag)
//     { connections: { <id>: { id, kind:'token'|'oauth'|'url', sealed, account, hint, config, connectedAt, by, problem? } },
//       zapier: { nonce, last4, createdAt, hooks: [{ id, sealed, host, createdAt }] }, studio: <Studio origin> }
//     Secrets (tokens, refresh tokens, the webhook URL and its signing secret, hook URLs) are only ever stored sealed
//     (AES-256-GCM under the server secret, as server/kdaccount.mjs seals refresh tokens). They are never returned to
//     the browser (the view carries a 4-character hint at most) and never logged.
//   <bot root>/_crm.json (docs.read / docs.write: the KnowDrive store, beside _spec.json; tagged crm:pending while the
//     queue is not empty so a restarted server finds it)
//     { v, queue:[{ id, target, lead, attempts, nextAt, firstAt, lastError, progress }], dead:[…], done:{ target: { leadId: at } },
//       log:{ <connection>: [{ at, leadId, who, result, action, attempts, error?, test?, recordUrl? }] } }
//
// The outbox
//   - every new lead is queued once per connection (id = <lead id>:<target>); a lead already delivered, queued or
//     dead-lettered for a target is never queued again (idempotent), and connectors upsert by e-mail / phone and keep
//     per-item progress, so a retry updates rather than duplicates and never writes a second note
//   - per bot and target the queue is strictly first in, first out: a lead waiting for its retry holds back the ones
//     behind it
//   - a failed delivery is retried with exponential backoff (30 s doubling to 6 h, or the vendor's Retry-After), at
//     most MAX_ATTEMPTS times, then dead-lettered with its last error; an error retrying cannot fix (the vendor rejected
//     the record, the address is not allowed) is dead-lettered at once. "Retry failed" puts dead letters back.
//   - only leads are sent: never a plain question. The consent label travels in the payload and in every CRM note.
//   - e-mail marketing lists (kind:'list': Mailchimp, Constant Contact) need an e-mail address and a list the owner
//     chose: a phone-only lead is logged as "skipped: no email address", and nothing is queued for a list connector
//     until its list is chosen. Their connectors never subscribe anyone to marketing unless the owner says they have
//     that consent (see each connector's header).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sealKey, openKey } from '../providers.mjs';
import { createStateSealer, bearerHash, pkcePair, ORIGIN_RE } from '../oauthstate.mjs';
import { CrmError, RETRYABLE, plain, scrub } from './http.mjs';
import { clientOf } from './oauth.mjs';
import { leadPayload, testPayload, maskContact } from './payload.mjs';
import { checkHookUrl } from './safefetch.mjs';
import webhook, { postLead } from './connectors/webhook.mjs';
import hubspot from './connectors/hubspot.mjs';
import salesforce from './connectors/salesforce.mjs';
import pipedrive from './connectors/pipedrive.mjs';
import zoho from './connectors/zoho.mjs';
import mailchimp from './connectors/mailchimp.mjs';
import constantcontact from './connectors/constantcontact.mjs';

export { CrmError };
export const ADAPTERS = Object.freeze({ webhook, hubspot, salesforce, pipedrive, zoho, mailchimp, constantcontact });
export const CONNECTOR_IDS = Object.freeze(['webhook', 'zapier', 'hubspot', 'salesforce', 'pipedrive', 'zoho', 'mailchimp', 'constantcontact']);
export const MAX_ATTEMPTS = 10;
export const LOG_MAX = 50;
const DEAD_MAX = 200, DONE_MAX = 5000, QUEUE_MAX = 5000, HOOKS_MAX = 20;
const DAY = 86400000;
const ZAP_KEY_RE = /^kb_zap_([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9_-]{20,40})$/;
const ZAPIER = Object.freeze({ id: 'zapier', name: 'Zapier', blurb: 'Start a Zap whenever your bot captures a lead, and send it to thousands of apps.' });
/** Backoff before attempt n+1 (n = attempts so far, ≥ 1): 30 s, 1 min, 2 min … capped at 6 h. */
export const backoffMs = (attempts) => Math.min(6 * 3600000, 30000 * 2 ** Math.max(0, attempts - 1));
const connOf = (target) => String(target).split(':')[0];

/**
 * @param {object} o
 *   secret            the server secret (KNOWBOT_SECRET_KEY): seals every connection secret and the OAuth state
 *   loadTrial(id)     → the bot's state T (with T.flags) or null; saveTrial(T, {soon}) persists T.flags
 *   docs              { read(T) → text|null, write(T, text, {pending}) }: the durable outbox document
 *   listPending()     → bot ids whose outbox document says deliveries are waiting (after a restart)
 *   leads             server/leads.mjs (report, linksOf)
 *   botName(T), onChange(T): the bot's name; called when a connection's status changes (the Studio's event stream)
 *   net               safefetch options (tests: allowAddresses / allowHttp / allowPorts); bases: { <connector>: { api, … } } (tests)
 *   fetch, now, log, env, saveMs (debounce of the outbox document), timers (false: never schedules on its own; tests call tick())
 */
export function createCrm(o = {}) {
  const env = o.env || {};
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const net = o.net || {};
  const bases = o.bases || {};
  const secret = String(o.secret || 'knowbot-local-dev');
  const sealingKey = `${secret}\nknowbot-crm-secrets`;
  const zapKey = `${secret}\nknowbot-crm-zapier`;
  const states = createStateSealer({ key: `${secret}\nknowbot-crm-state`, now, service: 'connection', makeError: (m) => new CrmError('bad_state', m, { status: 400 }) });
  const saveMs = Math.max(0, Number(o.saveMs ?? 300));
  const maxAttempts = Math.max(1, Number(o.maxAttempts ?? MAX_ATTEMPTS));
  const backoff = o.backoffMs || backoffMs;
  const timers = o.timers !== false;
  const loadTrial = async (id) => { try { return (await o.loadTrial?.(id)) || null; } catch (e) { log(`[crm] could not load bot ${id}: ${e.message}`); return null; } };
  const saveTrial = (T, opts) => { try { return o.saveTrial?.(T, opts); } catch (e) { log(`[crm] could not save bot ${T.id}: ${e.message}`); return null; } };
  const changed = (T) => { try { o.onChange?.(T); } catch { /* never mask */ } };
  const botName = (T) => String(o.botName?.(T) || T.spec?.name || 'Your bot');
  let closed = false;

  // one-click sign-in is offered per connector only when its app credentials are set; say which are missing once, in
  // the server log (the operator's view): customers only ever see "Not available yet"
  const missing = Object.values(ADAPTERS).filter((a) => a.oauth && !clientOf(env, a.id)).map((a) => `${a.name} (KNOWBOT_${a.id.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET)`);
  if (missing.length) log(`[crm] one-click connect is off until these are set: ${missing.join('; ')}`);

  // ------------------------------------------------------------------ state on the bot
  const stateOf = (T) => {
    T.flags ||= {};
    const c = (T.flags.crm ||= {});
    c.connections ||= {};
    return c;
  };
  const peekState = (T) => T?.flags?.crm || null;
  const seal = (obj) => sealKey(JSON.stringify(obj), sealingKey);
  function open(sealed) {
    try { return JSON.parse(openKey(String(sealed || ''), sealingKey)); }
    catch { throw new CrmError('auth', 'The saved connection can no longer be read.', { action: 'Connect it again.' }); }
  }
  const adapterOf = (id) => { const a = ADAPTERS[id]; if (!a) throw new CrmError('not_found', 'No such connector.', { status: 404 }); return a; };
  const nameOf = (id) => (id === 'zapier' ? ZAPIER.name : ADAPTERS[id]?.name || 'The CRM');
  /** The delivery targets of a bot: each connection, and each Zapier hook. */
  function targetsOf(T, only = null) {
    const c = peekState(T);
    if (!c) return [];
    const out = [];
    for (const id of Object.keys(c.connections || {})) if (ADAPTERS[id] && (!only || only === id)) out.push(id);
    if (!only || only === 'zapier') for (const h of c.zapier?.hooks || []) out.push(`zapier:${h.id}`);
    return out;
  }
  const targetExists = (T, target) => targetsOf(T).includes(target);
  /** The required settings a connection still lacks (a list connector's list), as field labels. */
  function missingOf(T, id) {
    const a = ADAPTERS[id], conn = peekState(T)?.connections?.[id];
    if (!a || !conn) return [];
    return (a.fields || []).filter((f) => f.required && !(conn.config?.[f.key] ?? f.default)).map((f) => f.label);
  }
  const ready = (T, target) => !missingOf(T, connOf(target)).length;

  // ------------------------------------------------------------------ mapping (the owner's small, safe settings)
  function cleanConfig(adapter, input = {}, prev = {}) {
    const out = { ...prev };
    for (const f of adapter.fields || []) {
      if (!(f.key in (input || {}))) continue;
      const v = String(input[f.key] ?? '').trim();
      if (f.type === 'select') {
        if (!f.options.some(([val]) => val === v)) throw new CrmError('invalid', `“${f.label}” has a choice we do not know.`, { status: 400 });
      } else if (f.type === 'list') {
        if (v && !new RegExp(f.pattern).test(v)) throw new CrmError('invalid', `“${f.label}” has a choice we do not know.`, { status: 400 });
      } else if (v) {
        if (v.length > (f.maxLength || 100) || /[\u0000-\u001f]/.test(v)) throw new CrmError('invalid', `“${f.label}” is too long.`, { status: 400 });
        if (f.pattern && !new RegExp(f.pattern).test(v)) throw new CrmError('invalid', `“${f.label}” does not look right.${f.help ? ` ${f.help}` : ''}`, { status: 400 });
      }
      out[f.key] = v;
    }
    return out;
  }
  const withDefaults = (adapter, config = {}) => Object.fromEntries((adapter.fields || []).map((f) => [f.key, config[f.key] ?? f.default ?? '']));

  // ------------------------------------------------------------------ access (pasted tokens, OAuth refresh)
  const access = new Map();   // `${bot}:${conn}` → { token, exp }
  const refreshing = new Map();
  function ctxFor(T, id) {
    const conn = stateOf(T).connections[id];
    if (!conn) throw new CrmError('not_found', `${nameOf(id)} is not connected.`, { status: 404 });
    const adapter = adapterOf(id);
    const ctx = { fetch: doFetch, env, now, log, net, kind: conn.kind, secrets: open(conn.sealed), config: withDefaults(adapter, conn.config), base: (k, d) => bases[id]?.[k] ?? d };
    ctx.token = (force = false) => tokenFor(T, id, ctx, force);
    return ctx;
  }
  const bareCtx = (id, extra = {}) => ({ fetch: doFetch, env, now, log, net, kind: 'token', secrets: {}, config: {}, base: (k, d) => bases[id]?.[k] ?? d, token: async () => '', ...extra });
  async function tokenFor(T, id, ctx, force) {
    if (ctx.kind !== 'oauth') return ctx.secrets.token || '';
    const key = `${T.id}:${id}`;
    const c = access.get(key);
    if (!force && c && c.exp - 60000 > now()) return c.token;
    if (!refreshing.has(key)) {
      refreshing.set(key, (async () => {
        const adapter = adapterOf(id);
        const client = clientOf(env, id);
        if (!client) throw new CrmError('config', `${adapter.name} sign-in is not available on this server right now.`, { action: 'Contact us.' });
        const r = await adapter.oauth.refresh(ctx, { client });
        access.set(key, { token: r.access.token, exp: now() + Math.max(60, Number(r.access.expiresIn) || 900) * 1000 });
        if (r.secrets) { // a rotated refresh token, or an account that moved: sealed and saved with the bot
          Object.assign(ctx.secrets, r.secrets);
          const conn = stateOf(T).connections[id];
          if (conn) { conn.sealed = seal(ctx.secrets); await saveTrial(T); }
        }
        return r.access.token;
      })().finally(() => refreshing.delete(key)));
    }
    return refreshing.get(key);
  }

  // ------------------------------------------------------------------ the durable outbox document (one per bot)
  const boxes = new Map(); // bot id → { id, doc, ready, timer, write, running, again }
  const emptyDoc = () => ({ v: 1, queue: [], dead: [], done: {}, log: {} });
  function boxOf(T) {
    let box = boxes.get(T.id);
    if (box) return box.ready.then(() => box);
    box = { id: T.id, T, doc: emptyDoc(), ready: null, timer: null, retry: null, write: Promise.resolve(), running: null, again: false, dirty: false };
    boxes.set(T.id, box);
    box.ready = (async () => {
      try {
        const text = await o.docs?.read?.(T);
        const d = text ? JSON.parse(text) : null;
        if (d && typeof d === 'object') box.doc = { ...emptyDoc(), ...d, queue: Array.isArray(d.queue) ? d.queue : [], dead: Array.isArray(d.dead) ? d.dead : [], done: d.done || {}, log: d.log || {} };
      } catch (e) { log(`[crm] could not read the delivery queue of ${T.id}: ${e.message}`); }
    })();
    return box.ready.then(() => box);
  }
  function prune(doc) {
    const cut = now() - 100 * DAY;
    for (const [t, m] of Object.entries(doc.done)) {
      const keep = Object.entries(m).filter(([, at]) => at >= cut).sort((a, b) => a[1] - b[1]).slice(-DONE_MAX);
      if (keep.length) doc.done[t] = Object.fromEntries(keep); else delete doc.done[t];
    }
    if (doc.dead.length > DEAD_MAX) doc.dead.splice(0, doc.dead.length - DEAD_MAX);
    for (const k of Object.keys(doc.log)) if (doc.log[k].length > LOG_MAX) doc.log[k] = doc.log[k].slice(-LOG_MAX);
  }
  function writeNow(box) {
    clearTimeout(box.timer); box.timer = null;
    box.write = box.write.then(async () => {
      if (!box.dirty || closed || !box.T) return;
      box.dirty = false;
      prune(box.doc);
      try { await o.docs?.write?.(box.T, JSON.stringify({ ...box.doc, bot: box.id, savedAt: new Date(now()).toISOString() }), { pending: box.doc.queue.length > 0 }); }
      catch (e) {
        log(`[crm] could not save the delivery queue of ${box.id}: ${e.message}`);
        if (timers && !closed && !box.retry) { box.retry = setTimeout(() => { box.retry = null; box.dirty = true; writeNow(box); }, 30000); box.retry.unref?.(); }
      }
    });
    return box.write;
  }
  /** Persists the outbox document (debounced by saveMs). */
  function save(T, box) {
    box.T = T; box.dirty = true;
    if (!saveMs) return writeNow(box);
    if (!box.timer) { box.timer = setTimeout(() => writeNow(box), saveMs); box.timer.unref?.(); }
    return Promise.resolve();
  }
  function logEntry(box, conn, entry) {
    const list = (box.doc.log[conn] ||= []);
    // one row per lead and target: a retry updates its row instead of adding one per attempt
    const i = entry.key ? list.findIndex((x) => x.key === entry.key) : -1;
    if (i >= 0) list.splice(i, 1);
    list.push(entry);
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
  }
  function enqueue(box, target, lead) {
    const id = `${lead.id}:${target}`;
    if (box.doc.done[target]?.[lead.id] || box.doc.queue.some((i) => i.id === id) || box.doc.dead.some((i) => i.id === id)) return false;
    if (box.doc.queue.length >= QUEUE_MAX) { log(`[crm] ${box.id}: the delivery queue is full; a lead for ${connOf(target)} was not queued`); return false; }
    box.doc.queue.push({ id, target, lead, attempts: 0, nextAt: 0, firstAt: now(), lastError: null, progress: {} });
    return true;
  }

  // ------------------------------------------------------------------ delivering
  function setProblem(T, id, p) {
    const conn = peekState(T)?.connections?.[id];
    if (!conn) return;
    const before = conn.problem?.message || null;
    conn.problem = p ? { code: p.code, message: p.message, action: p.action || null, at: new Date(now()).toISOString() } : null;
    if (!p) delete conn.problem;
    if (before !== (p?.message || null)) { saveTrial(T, { soon: true }); changed(T); }
  }
  async function deliverTo(T, target, lead, progress) {
    const id = connOf(target);
    if (id === 'zapier') {
      const hook = (peekState(T)?.zapier?.hooks || []).find((h) => `zapier:${h.id}` === target);
      if (!hook) return { action: 'skipped' };
      return postLead({ now, net }, open(hook.sealed).url, lead, { name: 'Zapier' });
    }
    return adapterOf(id).deliver(ctxFor(T, id), lead, progress);
  }
  const rowOf = (item, extra) => ({ key: item.id, at: new Date(now()).toISOString(), leadId: item.lead.id, who: maskContact(item.lead), attempts: item.attempts, ...(item.lead.test ? { test: true } : {}), ...extra });
  async function run(T, box) {
    const doc = box.doc;
    for (const target of [...new Set(doc.queue.map((i) => i.target))]) {
      const id = connOf(target);
      for (;;) {
        if (closed) return;
        const item = doc.queue.find((i) => i.target === target);
        if (!item || item.nextAt > now()) break; // first in, first out: a waiting lead holds back the ones behind it
        const drop = () => { const i = doc.queue.indexOf(item); if (i >= 0) doc.queue.splice(i, 1); };
        if (!targetExists(T, target)) { drop(); save(T, box); continue; }
        item.attempts++;
        try {
          const r = await deliverTo(T, target, item.lead, (item.progress ||= {}));
          drop();
          (doc.done[target] ||= {})[item.lead.id] = now();
          if (r?.action === 'skipped') logEntry(box, id, rowOf(item, { result: 'skipped', error: `Skipped: ${r.reason || 'not needed'}.` }));
          else logEntry(box, id, rowOf(item, { result: 'delivered', action: r?.action || 'sent', ...(r?.recordUrl ? { recordUrl: r.recordUrl } : {}) }));
          log(`[crm] ${T.id}: lead ${item.lead.id} → ${id} ${r?.action || 'sent'} (attempt ${item.attempts})`);
          setProblem(T, id, null);
        } catch (e) {
          const p = plain(e, nameOf(id));
          log(`[crm] ${T.id}: lead ${item.lead.id} → ${id} failed (attempt ${item.attempts}, ${p.code}): ${scrub(e?.message || e)}`);
          if (e instanceof CrmError && e.code === 'gone' && id === 'zapier') { // the Zap was switched off or deleted
            removeHook(T, target.slice('zapier:'.length));
            doc.queue = doc.queue.filter((i) => i.target !== target);
            save(T, box);
            break;
          }
          if (p.code === 'auth') setProblem(T, id, p);
          const final = !RETRYABLE.has(p.code) || item.attempts >= maxAttempts;
          item.lastError = p;
          if (final) {
            drop();
            doc.dead.push({ ...item, deadAt: now() });
            logEntry(box, id, rowOf(item, { result: 'failed', error: p.message, action: p.action || null }));
            save(T, box);
            continue;
          }
          item.nextAt = now() + Math.max(backoff(item.attempts), e instanceof CrmError && e.retryAfterMs ? e.retryAfterMs : 0);
          logEntry(box, id, rowOf(item, { result: 'retrying', error: p.message, nextAt: new Date(item.nextAt).toISOString() }));
          save(T, box);
          break;
        }
        save(T, box);
      }
    }
  }
  /** Delivers whatever is due for one bot (single flight per bot). */
  const inbound = new Set(); // work that has started but is not yet a running box (idle() waits for it)
  function pump(botId) {
    const p = pumpNow(botId).catch((e) => log(`[crm] ${botId}: delivery stopped: ${e.message}`));
    inbound.add(p); p.finally(() => inbound.delete(p));
    return p;
  }
  async function pumpNow(botId) {
    const T = await loadTrial(botId);
    if (!T || closed) return;
    const box = await boxOf(T);
    if (box.running) { box.again = true; return box.running; }
    box.running = (async () => {
      do { box.again = false; await run(T, box); } while (box.again && !closed);
    })().catch((e) => log(`[crm] ${botId}: delivery stopped: ${e.message}`)).finally(() => { box.running = null; schedule(); });
    return box.running;
  }
  let timer = null;
  function schedule() {
    if (!timers || closed) return;
    let next = Infinity;
    for (const box of boxes.values()) {
      const seen = new Set();
      for (const i of box.doc.queue) { if (seen.has(i.target)) continue; seen.add(i.target); next = Math.min(next, i.nextAt || 0); }
    }
    clearTimeout(timer); timer = null;
    if (next === Infinity) return;
    timer = setTimeout(() => { timer = null; tick(); }, Math.min(Math.max(250, next - now()), 3600000));
    timer.unref?.();
  }
  /** Delivers everything that is due, for every bot with a queue. */
  async function tick() {
    await Promise.all([...boxes.values()].filter((b) => b.doc.queue.length).map((b) => pump(b.id)));
  }
  /** After a restart: load the queues that were waiting and carry on. */
  async function resume() {
    let ids = [];
    try { ids = (await o.listPending?.()) || []; } catch (e) { log(`[crm] could not list waiting deliveries: ${e.message}`); return { resumed: 0 }; }
    let n = 0;
    for (const id of ids) {
      const T = await loadTrial(id);
      if (!T) continue;
      const box = await boxOf(T);
      if (box.doc.queue.length) { n++; pump(id); }
    }
    if (n) log(`[crm] resumed deliveries for ${n} bot(s)`);
    return { resumed: n };
  }
  /** Resolves when nothing is being delivered and every outbox document is written (tests, shutdown). */
  async function idle() {
    for (let i = 0; i < 200; i++) {
      if (inbound.size) { await Promise.all([...inbound]); continue; }
      const running = [...boxes.values()].filter((b) => b.running);
      if (running.length) { await Promise.all(running.map((b) => b.running)); continue; }
      const unsaved = [...boxes.values()].filter((b) => b.dirty || b.timer);
      if (unsaved.length) { await Promise.all(unsaved.map(writeNow)); continue; }
      await Promise.all([...boxes.values()].map((b) => b.write));
      if (!inbound.size && ![...boxes.values()].some((b) => b.running || b.dirty || b.timer)) return;
    }
  }
  /** Writes a bot's outbox document again as it is (its tags change when the bot launches). */
  async function rewrite(T) { const box = await boxOf(T); box.T = T; box.dirty = true; return writeNow(box); }

  // ------------------------------------------------------------------ leads in
  const studioUrlOf = (T) => { const s = peekState(T)?.studio; return s && ORIGIN_RE.test(s) ? `${s}/studio/?t=${encodeURIComponent(T.id)}#stats` : null; };
  const linksOf = async (bot, cid) => { try { return cid ? (await o.leads?.linksOf?.(bot, cid)) || [] : []; } catch { return []; } };
  /** A lead the bot just captured (leads.mjs event; extra.answer: the answer text, when the bot sent one). */
  function onLead(ev, extra = {}) {
    if (!ev || ev.kind !== 'lead' || closed) return Promise.resolve();
    const p = (async () => {
      const T = await loadTrial(ev.bot);
      const targets = T ? targetsOf(T).filter((t) => ready(T, t)) : [];
      if (!targets.length) return;
      const lead = leadPayload(ev, { botName: botName(T), links: await linksOf(ev.bot, ev.cid), answer: extra.answer || null, studioUrl: studioUrlOf(T) });
      const box = await boxOf(T);
      let n = 0;
      for (const t of targets) if (enqueue(box, t, lead)) n++;
      if (!n) return;
      await save(T, box);
      pump(T.id);
    })().catch((e) => log(`[crm] a lead was not queued: ${e.message}`));
    inbound.add(p); p.finally(() => inbound.delete(p));
    return p;
  }

  // ------------------------------------------------------------------ what the Studio sees (never a secret)
  async function view(T) {
    const c = peekState(T) || {};
    const box = await boxOf(T);
    const counts = (id) => {
      const mine = (i) => connOf(i.target) === id;
      const last = (box.doc.log[id] || []).filter((x) => x.result === 'delivered').slice(-1)[0];
      return { pending: box.doc.queue.filter(mine).length, failed: box.doc.dead.filter(mine).length, lastDeliveredAt: last?.at || null };
    };
    const connectors = Object.values(ADAPTERS).map((a) => {
      const conn = c.connections?.[a.id] || null;
      const n = counts(a.id);
      const lacks = conn ? missingOf(T, a.id) : [];
      const problem = conn?.problem ? { message: conn.problem.message, action: conn.problem.action }
        : lacks.length ? { message: `Choose your ${lacks.join(" and ").toLowerCase()} to start sending leads.`, action: 'Open Settings and choose one.' } : n.failed && conn ? { message: `${n.failed === 1 ? '1 lead' : `${n.failed} leads`} could not be delivered.`, action: 'Open the delivery log to see why, then choose “Retry failed”.' } : null;
      return { id: a.id, name: a.name, blurb: a.blurb, kind: a.kind || 'crm',
        auth: { ...(a.auth.oauth ? { oauth: { available: !!clientOf(env, a.id), options: a.auth.oauth.options || [] } } : {}), ...(a.auth.token ? { token: a.auth.token } : {}), ...(a.auth.url ? { url: a.auth.url } : {}) },
        fields: a.fields || [],
        connection: conn ? { status: problem ? 'attention' : 'connected', kind: conn.kind, account: conn.account || a.name, hint: conn.hint || null, connectedAt: conn.connectedAt, config: withDefaults(a, conn.config), problem, ...n } : null };
    });
    const z = c.zapier || null;
    const zn = counts('zapier');
    return { connectors, retentionDays: o.leads?.retentionDays || 90,
      zapier: { ...ZAPIER, key: z?.nonce ? { last4: z.last4, createdAt: z.createdAt } : null, hooks: (z?.hooks || []).map((h) => ({ id: h.id, host: h.host, createdAt: h.createdAt })),
        status: zn.failed ? 'attention' : 'connected', problem: zn.failed ? { message: `${zn.failed === 1 ? '1 lead' : `${zn.failed} leads`} could not be delivered to Zapier.`, action: 'Open the delivery log to see why, then choose “Retry failed”.' } : null, ...zn } };
  }
  /** The lists (audiences) the owner can choose from, for list connectors. → { lists: [{id, name}] } */
  async function listsOf(T, id) {
    const adapter = adapterOf(id);
    if (!adapter.lists) return { lists: [] };
    try { const l = await adapter.lists(ctxFor(T, id)); setProblem(T, id, null); return { lists: l.slice(0, 500) }; }
    catch (e) { const p = plain(e, adapter.name); if (p.code === 'auth') setProblem(T, id, p); throw e; }
  }
  async function logOf(T, id) {
    if (id !== 'zapier') adapterOf(id);
    const box = await boxOf(T);
    return { log: [...(box.doc.log[id] || [])].reverse().map(({ key, ...row }) => row) };
  }

  // ------------------------------------------------------------------ connect / change / disconnect
  const rememberStudio = (T, origin) => { if (origin && ORIGIN_RE.test(String(origin))) stateOf(T).studio = String(origin); };
  function putConnection(T, id, { kind, secrets, account, hint = null, config, by = null }) {
    const prev = stateOf(T).connections[id];
    stateOf(T).connections[id] = { id, kind, sealed: seal(secrets), account: String(account || nameOf(id)).slice(0, 120), hint, config: config ?? prev?.config ?? {}, connectedAt: new Date(now()).toISOString(), ...(by ? { by } : {}) };
    access.delete(`${T.id}:${id}`);
  }
  /** A pasted token or a webhook URL. → { reveal? } (a webhook's signing secret, shown once). */
  async function connect(T, id, input = {}, { origin = null } = {}) {
    const adapter = adapterOf(id);
    if (!adapter.connect) throw new CrmError('invalid', `${adapter.name} connects by signing in.`, { status: 400 });
    const config = cleanConfig(adapter, input.config || {}, {});
    const r = await adapter.connect(bareCtx(id), input);
    putConnection(T, id, { kind: adapter.auth.url ? 'url' : 'token', secrets: r.secrets, account: r.account, hint: r.hint, config });
    rememberStudio(T, origin);
    await saveTrial(T);
    changed(T);
    log(`[crm] ${T.id}: connected ${id} (${adapter.auth.url ? 'address' : 'pasted token'})`);
    pump(T.id);
    return { ...(r.reveal ? { reveal: r.reveal } : {}) };
  }
  /** One-click sign-in: → { url } for the popup. The state is sealed and bound to the trial and its bearer. */
  async function oauthStart(T, id, { bearer, origin, redirectUri, options = {} } = {}) {
    const adapter = adapterOf(id);
    const client = adapter.oauth ? clientOf(env, id) : null;
    if (!client) throw new CrmError('config', `Signing in to ${adapter.name} is not available yet.`, { status: 409 });
    const opts = {};
    for (const f of adapter.auth.oauth.options || []) { const v = String(options?.[f.key] ?? f.default ?? ''); opts[f.key] = f.options.some(([val]) => val === v) ? v : f.default; }
    const { verifier, challenge } = pkcePair();
    const state = states.seal({ t: T.id, bh: bearerHash(bearer), o: ORIGIN_RE.test(String(origin || '')) ? origin : null, r: redirectUri, v: verifier, c: id, x: opts }, { expiresAt: T.expiresAt });
    return { url: adapter.oauth.authorizeUrl(bareCtx(id), { client, redirectUri, state, challenge, options: opts }) };
  }
  const oauthPeek = (state) => states.peek(state);
  /** The popup's redirect: consumes the state, exchanges the code server side, saves the sealed connection. → { T, state } */
  async function oauthFinish({ id, state, code, query = {} }) {
    const d = states.consume(state);
    if (d.c !== id) throw new CrmError('bad_state', 'This connection link is not valid. Start again from KnowBot Studio.', { status: 400 });
    const adapter = adapterOf(id);
    const client = clientOf(env, id);
    if (!client) throw new CrmError('config', `Signing in to ${adapter.name} is not available yet.`, { status: 409 });
    if (!code) throw new CrmError('denied', 'The sign-in was cancelled.', { status: 400 });
    const T = await loadTrial(d.t);
    if (!T) throw new CrmError('bad_state', 'This bot no longer exists.', { status: 404 });
    const r = await adapter.oauth.exchange(bareCtx(id, { kind: 'oauth' }), { client, code: String(code), redirectUri: d.r, verifier: d.v, options: d.x || {}, query });
    putConnection(T, id, { kind: r.kind || 'oauth', secrets: r.secrets, account: r.account, by: d.bh });
    access.set(`${T.id}:${id}`, { token: r.access.token, exp: now() + Math.max(60, Number(r.access.expiresIn) || 900) * 1000 });
    rememberStudio(T, d.o);
    await saveTrial(T);
    changed(T);
    log(`[crm] ${T.id}: connected ${id} (signed in)`);
    pump(T.id);
    return { T, state: d };
  }
  async function setConfig(T, id, config) {
    const adapter = adapterOf(id);
    const conn = stateOf(T).connections[id];
    if (!conn) throw new CrmError('not_found', `${adapter.name} is not connected.`, { status: 404 });
    conn.config = cleanConfig(adapter, config || {}, conn.config || {});
    await saveTrial(T);
  }
  async function forgetTarget(T, pred) {
    const box = await boxOf(T);
    box.doc.queue = box.doc.queue.filter((i) => !pred(i.target));
    box.doc.dead = box.doc.dead.filter((i) => !pred(i.target));
    for (const t of Object.keys(box.doc.done)) if (pred(t)) delete box.doc.done[t];
    return box;
  }
  async function disconnect(T, id) {
    const c = stateOf(T);
    if (id === 'zapier') { delete c.zapier; }
    else { adapterOf(id); delete c.connections[id]; access.delete(`${T.id}:${id}`); }
    const box = await forgetTarget(T, (t) => connOf(t) === id);
    delete box.doc.log[id];
    await saveTrial(T);
    await save(T, box);
    changed(T);
    log(`[crm] ${T.id}: disconnected ${id}`);
  }

  // ------------------------------------------------------------------ test, sync, retry
  /** Sends one clearly marked test lead now (no queue, no retries). → { ok, entry } */
  async function test(T, id) {
    const targets = targetsOf(T, id);
    if (!targets.length) throw new CrmError('not_found', id === 'zapier' ? 'No Zap is listening yet. Turn on a Zap that uses the KnowBot “New Lead” trigger first.' : `${nameOf(id)} is not connected.`, { status: 404 });
    const lacks = missingOf(T, id);
    if (lacks.length) throw new CrmError('invalid', `Choose your ${lacks.join(" and ").toLowerCase()} first.`, { status: 400 });
    const lead = testPayload({ botId: T.id, botName: botName(T), studioUrl: studioUrlOf(T), now: now() });
    const box = await boxOf(T);
    let entry = null, ok = true;
    for (const target of targets) {
      const item = { id: `${lead.id}:${target}`, lead, attempts: 1 };
      try {
        const r = await deliverTo(T, target, lead, {});
        entry = rowOf(item, { result: 'delivered', action: r?.action || 'sent', ...(r?.recordUrl ? { recordUrl: r.recordUrl } : {}) });
        setProblem(T, id, null);
      } catch (e) {
        const p = plain(e, nameOf(id));
        ok = false;
        log(`[crm] ${T.id}: test lead → ${id} failed (${p.code}): ${scrub(e?.message || e)}`);
        if (p.code === 'auth') setProblem(T, id, p);
        entry = rowOf(item, { result: 'failed', error: p.message, action: p.action || null });
      }
      logEntry(box, id, entry);
    }
    await save(T, box);
    const { key, ...row } = entry;
    return { ok, entry: row };
  }
  /** Queues the leads of the last `days` days (the retention window at most) that this connection has not had yet. */
  async function sync(T, id, { days = null } = {}) {
    const targets = targetsOf(T, id);
    if (!targets.length) throw new CrmError('not_found', `${nameOf(id)} is not connected.`, { status: 404 });
    const lacks = missingOf(T, id);
    if (lacks.length) throw new CrmError('invalid', `Choose your ${lacks.join(" and ").toLowerCase()} first.`, { status: 400 });
    const keep = o.leads?.retentionDays || 90;
    const r = await o.leads.report([T.id], { days: Math.min(keep, Number(days) || keep) });
    const box = await boxOf(T);
    let queued = 0, already = 0;
    for (const l of [...(r.leads || [])].reverse()) { // oldest first, so the CRM sees them in the order they happened
      const ev = { kind: 'lead', bot: l.bot, at: Date.parse(l.at), type: l.type, value: l.value, consent: l.consent, channel: l.channel, cid: l.cid || null, question: l.question || '', name: l.name || null, note: l.note || null };
      const lead = leadPayload(ev, { botName: botName(T), links: await linksOf(l.bot, l.cid), studioUrl: studioUrlOf(T) });
      for (const t of targets) { if (enqueue(box, t, lead)) queued++; else already++; }
    }
    await save(T, box);
    if (queued) pump(T.id);
    return { queued, already, days: r.days };
  }
  /** Puts this connection's dead letters back in the queue (in their original order, ahead of newer leads). */
  async function retryFailed(T, id) {
    const box = await boxOf(T);
    const mine = box.doc.dead.filter((i) => connOf(i.target) === id && targetExists(T, i.target));
    box.doc.dead = box.doc.dead.filter((i) => connOf(i.target) !== id);
    const back = mine.sort((a, b) => a.firstAt - b.firstAt).map(({ deadAt, ...i }) => ({ ...i, attempts: 0, nextAt: 0 }));
    box.doc.queue = [...back, ...box.doc.queue];
    for (const i of box.doc.queue) if (connOf(i.target) === id) i.nextAt = 0;
    await save(T, box);
    pump(T.id);
    return { retried: back.length };
  }

  // ------------------------------------------------------------------ Zapier: a per-bot key and REST hooks
  const zapSig = (payload) => createHmac('sha256', zapKey).update(payload).digest().subarray(0, 18).toString('base64url');
  /** A new key for this bot (the old one stops working). Shown once: only its last four characters are kept. */
  async function zapierNewKey(T, { origin = null } = {}) {
    const c = stateOf(T);
    const nonce = randomBytes(9).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ t: T.id, n: nonce })).toString('base64url');
    const key = `kb_zap_${payload}.${zapSig(payload)}`;
    c.zapier = { hooks: [], ...(c.zapier || {}), nonce, last4: key.slice(-4), createdAt: new Date(now()).toISOString() };
    rememberStudio(T, origin);
    await saveTrial(T);
    changed(T);
    return { key };
  }
  /** Authorization: Bearer kb_zap_… → the bot. Throws CrmError('auth', 401). */
  async function zapierAuth(token) {
    const bad = () => new CrmError('auth', 'This KnowBot API key is not valid. Copy a new one from Stats & Leads in KnowBot Studio.', { status: 401 });
    const m = ZAP_KEY_RE.exec(String(token || '').trim());
    if (!m) throw bad();
    const a = Buffer.from(m[2]), b = Buffer.from(zapSig(m[1]));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw bad();
    let d;
    try { d = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { throw bad(); }
    const T = await loadTrial(d.t);
    const z = peekState(T)?.zapier;
    if (!T || !z?.nonce || z.nonce !== d.n) throw bad();
    return T;
  }
  function removeHook(T, hookId) {
    const z = peekState(T)?.zapier;
    if (!z) return false;
    const before = (z.hooks || []).length;
    z.hooks = (z.hooks || []).filter((h) => h.id !== hookId);
    if (z.hooks.length === before) return false;
    saveTrial(T, { soon: true });
    changed(T);
    return true;
  }
  /** REST hook subscribe: Zapier's performSubscribe posts the URL it wants new leads sent to. → { id } */
  async function zapierSubscribe(T, hookUrl) {
    const u = checkHookUrl(hookUrl, net);
    const z = stateOf(T).zapier;
    z.hooks ||= [];
    const same = z.hooks.find((h) => { try { return open(h.sealed).url === u.toString(); } catch { return false; } });
    if (same) return { id: same.id };
    if (z.hooks.length >= HOOKS_MAX) throw new CrmError('invalid', `This bot already has ${HOOKS_MAX} Zaps listening. Turn one off first.`, { status: 409 });
    const hook = { id: `hk_${randomBytes(9).toString('base64url')}`, sealed: seal({ url: u.toString() }), host: u.host, createdAt: new Date(now()).toISOString() };
    z.hooks.push(hook);
    await saveTrial(T);
    changed(T);
    log(`[crm] ${T.id}: a Zap subscribed (${z.hooks.length} listening)`);
    return { id: hook.id };
  }
  async function zapierUnsubscribe(T, hookId) {
    const ok = removeHook(T, String(hookId || ''));
    if (ok) { const box = await forgetTarget(T, (t) => t === `zapier:${hookId}`); await save(T, box); await saveTrial(T); }
    return { ok: true };
  }
  /** The polling fallback and the sample for Zapier's editor: recent leads, newest first, each with a stable id. */
  async function zapierRecent(T, { limit = 25 } = {}) {
    const r = await o.leads.report([T.id], { days: o.leads?.retentionDays || 90 });
    const out = [];
    for (const l of (r.leads || []).slice(0, Math.max(1, Math.min(100, Number(limit) || 25)))) {
      const ev = { kind: 'lead', bot: l.bot, at: Date.parse(l.at), type: l.type, value: l.value, consent: l.consent, channel: l.channel, cid: l.cid || null, question: l.question || '', name: l.name || null, note: l.note || null };
      out.push({ event: 'lead.created', ...leadPayload(ev, { botName: botName(T), links: await linksOf(l.bot, l.cid), studioUrl: studioUrlOf(T) }) });
    }
    // an empty array would leave Zapier's editor with nothing to map: offer one clearly marked sample
    if (!out.length) out.push({ event: 'lead.test', ...testPayload({ botId: T.id, botName: botName(T), studioUrl: studioUrlOf(T), now: now() }) });
    return out;
  }

  function close() {
    closed = true;
    clearTimeout(timer); timer = null;
    for (const b of boxes.values()) { clearTimeout(b.timer); b.timer = null; clearTimeout(b.retry); b.retry = null; }
  }
  return { view, logOf, listsOf, connect, oauthStart, oauthPeek, oauthFinish, setConfig, disconnect, test, sync, retryFailed, onLead, pump, tick, resume, idle, rewrite, close,
    zapier: { newKey: zapierNewKey, auth: zapierAuth, subscribe: zapierSubscribe, unsubscribe: zapierUnsubscribe, recent: zapierRecent, me: (T) => ({ id: T.id, name: botName(T) }) },
    targetsOf, hasConnections: (T) => targetsOf(T).length > 0, _box: (T) => boxOf(T) };
}
