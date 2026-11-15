// Trigger: New Lead. A REST hook (instant): Zapier subscribes its hook URL with KnowBot when a Zap is switched on and
// unsubscribes when it is switched off; KnowBot POSTs each new lead to it. performList is the polling fallback Zapier
// uses for samples in the editor: an array, newest first, each item with a stable `id`.
'use strict';

const { BASE } = require('../authentication');

const subscribe = async (z, bundle) => {
  const r = await z.request({ url: `${BASE}/hooks`, method: 'POST', body: { hookUrl: bundle.targetUrl } });
  return r.data; // { id }: kept by Zapier as bundle.subscribeData
};
const unsubscribe = async (z, bundle) => {
  const r = await z.request({ url: `${BASE}/hooks/${encodeURIComponent(bundle.subscribeData.id)}`, method: 'DELETE' });
  return r.data;
};
/** A hook delivery: KnowBot sends one lead per request. */
const perform = async (z, bundle) => [bundle.cleanedRequest];
/** Recent leads, newest first (samples, and "Load more" in the editor). */
const performList = async (z, bundle) => {
  const r = await z.request({ url: `${BASE}/leads`, params: { limit: 10 } });
  return r.data;
};

const sample = {
  event: 'lead.created',
  id: 'ld_3f2a9c1b7d6e4f5a8b9c0d1e',
  createdAt: '2026-11-15T16:04:12.000Z',
  bot: { id: 'tr_abcdefghijklmnop', name: 'Lumen Helper' },
  channel: 'web',
  channelLabel: 'Website chat',
  contact: { email: 'ada@example.com', name: 'Ada Lovelace' },
  question: 'How long is the frame warranty?',
  answer: { summary: 'Frames are covered for five years.' },
  links: [{ url: 'https://example.com/warranty?utm_source=knowbot&utm_medium=webchat', kind: 'proof' }],
  consent: { code: 'asked_to_send', label: 'Asked the bot to send them the answer' },
  source: { utm_source: 'knowbot', utm_medium: 'webchat', utm_campaign: 'tr_abcdefghijklmnop', clickId: 'abcdefghjk', page: null },
  studioUrl: 'https://knowbot.app/studio/?t=tr_abcdefghijklmnop#stats',
};

module.exports = {
  key: 'new_lead',
  noun: 'Lead',
  display: {
    label: 'New Lead',
    description: 'Triggers when your KnowBot captures a lead: someone asks it to send them an answer, texts, calls or emails it, leaves a message or asks for a callback.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribe,
    performUnsubscribe: unsubscribe,
    perform,
    performList,
    sample,
    outputFields: [
      { key: 'id', label: 'Lead ID' },
      { key: 'createdAt', label: 'Captured at', type: 'datetime' },
      { key: 'bot__name', label: 'Bot name' },
      { key: 'bot__id', label: 'Bot ID' },
      { key: 'channel', label: 'Channel (code)' },
      { key: 'channelLabel', label: 'Channel' },
      { key: 'contact__email', label: 'Email' },
      { key: 'contact__phone', label: 'Phone' },
      { key: 'contact__name', label: 'Name' },
      { key: 'question', label: 'Question' },
      { key: 'answer__summary', label: 'Answer summary' },
      { key: 'consent__label', label: 'How you got their details' },
      { key: 'consent__code', label: 'Consent (code)' },
      { key: 'source__utm_source', label: 'UTM source' },
      { key: 'source__utm_medium', label: 'UTM medium' },
      { key: 'source__utm_campaign', label: 'UTM campaign' },
      { key: 'note', label: 'Note' },
      { key: 'studioUrl', label: 'Open in KnowBot Studio' },
      { key: 'test', label: 'Is a test lead', type: 'boolean' },
    ],
  },
};
