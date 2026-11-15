// A lead-delivery manager (server/crm) wired to in-memory bot state, an in-memory document store, a real leads store
// and the fake CRM server. Time is a variable the test moves; nothing is scheduled on its own (the test calls tick()).
import { createCrm } from '../crm/index.mjs';
import { createLeads } from '../leads.mjs';

export const BOT = 'tr_aaaaaaaaaaaaaaaa';
export const DAY = 86400000;
export const SECRET = 'unit-test-server-secret';
/** Every string a test must never find in a response, a log line or a stored document in the clear. */
export const leaks = (text, secrets) => secrets.filter((s) => s && String(text).includes(s));

export function harness(fake, { env = {}, crm: crmOpts = {} } = {}) {
  let t = Date.parse('2026-11-10T12:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
  const docs = new Map();      // bot id → the outbox document text
  const pending = new Set();   // bot ids whose document is tagged crm:pending
  const logs = [];
  const T = { id: BOT, flags: {}, spec: { name: 'Lumen Helper' }, expiresAt: t + 30 * DAY };
  const trials = new Map([[BOT, T]]);
  let saves = 0;
  const leads = createLeads({ now: clock.now });
  function make(extra = {}) {
    const crm = createCrm({ env, secret: SECRET, now: clock.now, log: (x) => logs.push(String(x)), net: fake.net, bases: fake.bases, leads, timers: false, saveMs: 0,
      loadTrial: async (id) => trials.get(id) || null, saveTrial: async () => { saves++; }, botName: (x) => x.spec.name,
      docs: { read: async (x) => docs.get(x.id) || null, write: async (x, text, { pending: p }) => { docs.set(x.id, text); if (p) pending.add(x.id); else pending.delete(x.id); } },
      listPending: async () => [...pending], ...crmOpts, ...extra });
    const off = leads.on((ev, x) => { crm.onLead(ev, x); });
    return Object.assign(crm, { detach: off });
  }
  const crm = make();
  /** Records a lead the way a channel does; resolves once the outbox has done what it can. */
  async function lead(o = {}, c = crm) {
    const ev = leads.lead({ botId: BOT, channel: 'web', value: 'ada@example.com', question: 'How long is the warranty?', consent: 'asked_to_send', at: clock.now(), ...o });
    await c.idle();
    return ev;
  }
  const doc = () => JSON.parse(docs.get(BOT) || '{"queue":[],"dead":[],"log":{},"done":{}}');
  return { T, trials, crm, make, leads, lead, clock, docs, pending, logs, doc, get saves() { return saves; } };
}
