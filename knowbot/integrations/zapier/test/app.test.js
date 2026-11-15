// The app's shape, checked without Zapier's servers or its SDK installed (zapier-platform-core is stubbed when absent).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'zapier-platform-core') { try { return load.call(this, request, ...rest); } catch (e) { return { version: '0.0.0-stub' }; } }
  return load.call(this, request, ...rest);
};
const App = require('../index');
const newLead = require('../triggers/new_lead');
const auth = require('../authentication');

test('one hook trigger with subscribe, unsubscribe, perform, a polling list and a sample', () => {
  assert.deepEqual(Object.keys(App.triggers), ['new_lead']);
  const op = newLead.operation;
  assert.equal(op.type, 'hook');
  for (const k of ['performSubscribe', 'performUnsubscribe', 'perform', 'performList']) assert.equal(typeof op[k], 'function', k);
  assert.match(op.sample.id, /^ld_/);
  assert.ok(op.outputFields.some((f) => f.key === 'contact__email') && op.outputFields.some((f) => f.key === 'consent__label'));
});

test('auth: one API key field, tested against /me, sent as a Bearer header', () => {
  assert.equal(auth.type, 'custom');
  assert.deepEqual(auth.fields.map((f) => f.key), ['apiKey']);
  assert.match(auth.test.url, /\/api\/studio\/zapier\/v1\/me$/);
  const req = App.beforeRequest[0]({ headers: {} }, {}, { authData: { apiKey: 'kb_zap_x.y' } });
  assert.equal(req.headers.Authorization, 'Bearer kb_zap_x.y');
});

test('the requests the trigger makes', async () => {
  const calls = [];
  const z = { request: async (o) => { calls.push(o); return { data: o.method === 'POST' ? { id: 'hk_1' } : o.method === 'DELETE' ? { ok: true } : [newLead.operation.sample] }; } };
  assert.deepEqual(await newLead.operation.performSubscribe(z, { targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/' }), { id: 'hk_1' });
  assert.deepEqual(calls[0].body, { hookUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/' });
  assert.match(calls[0].url, /\/hooks$/);
  await newLead.operation.performUnsubscribe(z, { subscribeData: { id: 'hk_1' } });
  assert.match(calls[1].url, /\/hooks\/hk_1$/);
  assert.equal(calls[1].method, 'DELETE');
  const list = await newLead.operation.performList(z, {});
  assert.ok(Array.isArray(list) && list[0].id);
  assert.deepEqual(await newLead.operation.perform(z, { cleanedRequest: { id: 'ld_x' } }), [{ id: 'ld_x' }]);
});

test('a 401 asks the user to reconnect; other errors carry KnowBot’s message', () => {
  class RefreshAuthError extends Error {}
  class ZError extends Error {}
  const z = { errors: { RefreshAuthError, Error: ZError } };
  assert.throws(() => App.afterResponse[0]({ status: 401 }, z), RefreshAuthError);
  assert.throws(() => App.afterResponse[0]({ status: 400, json: { error: { message: 'That address is not on the public internet.' } } }, z), /public internet/);
  assert.equal(App.afterResponse[0]({ status: 200 }, z).status, 200);
});
