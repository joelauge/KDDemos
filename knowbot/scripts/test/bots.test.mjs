// studio/bots.js: the list of bots a browser remembers (pure list logic and the storage wrappers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTS_KEY, BOTS_MAX, cleanBot, cleanBots, capBots, upsertBot, removeBot, sortBots, botLabel, sameBots, readBots, writeBots } from '../../studio/bots.js';

const id = (n) => `tr_${String(n).padStart(16, 'a').replace(/[^a-z2-7]/g, (c) => 'abcdefghij'[Number(c)])}`;
const bot = (n, extra = {}) => ({ id: id(n), name: `Bot ${n}`, token: `tok-${n}`, restoreKey: `key-${n}`, expiresAt: '2030-01-01T00:00:00.000Z', converted: false, seenAt: n + 1, ...extra });
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

test('cleanBot keeps only what opens a bot, and refuses an entry without an id or a token', () => {
  assert.equal(cleanBot(null), null);
  assert.equal(cleanBot({ id: 'nope', token: 't' }), null);
  assert.equal(cleanBot({ id: id(1), token: '' }), null);
  assert.equal(cleanBot({ id: id(1) }), null);
  const e = cleanBot({ ...bot(1), extra: 'x', avatar: { initials: 'LBX', hue: 11, junk: 1 }, milestones: { firstFile: 5, junk: 9, launched: -1 } });
  assert.deepEqual(e, { id: id(1), name: 'Bot 1', token: 'tok-1', restoreKey: 'key-1', expiresAt: '2030-01-01T00:00:00.000Z', converted: false, seenAt: 2,
    avatar: { initials: 'LB', hue: 3 },
    milestones: { firstFile: 5, firstReady: 0, ownFile: 0, firstCited: 0, firstRefusal: 0, proofRun: 0, emailOffered: 0, launchShown: 0, launched: 0 } });
  assert.equal(cleanBot({ id: id(2), token: 't', converted: 'yes' }).converted, false, 'only a real true is live');
  assert.equal(cleanBot({ id: id(2), token: 't' }).restoreKey, null);
});

test('upsertBot adds, updates in place, and keeps fields the patch leaves undefined', () => {
  let l = upsertBot([], { id: id(1), token: 't1', name: 'Lumen Bikes', restoreKey: 'k1' }, 100);
  assert.equal(l.length, 1);
  assert.equal(l[0].seenAt, 100);
  // a boot that knows only the token must not blank the name or the restore key
  l = upsertBot(l, { id: id(1), token: 't1b', name: undefined, restoreKey: undefined, converted: undefined }, 200);
  assert.deepEqual([l.length, l[0].name, l[0].token, l[0].restoreKey, l[0].seenAt], [1, 'Lumen Bikes', 't1b', 'k1', 200]);
  l = upsertBot(l, { id: id(1), name: 'Lumen', converted: true }, 300);
  assert.deepEqual([l[0].name, l[0].converted, l[0].token], ['Lumen', true, 't1b']);
  l = upsertBot(l, { id: id(2), token: 't2' }, 400);
  assert.deepEqual(l.map((e) => e.id), [id(1), id(2)]);
  assert.equal(upsertBot(l, { id: id(3) }, 500), l, 'a new bot without a token is not remembered');
  assert.equal(upsertBot(l, { id: 'bad', token: 't' }, 500), l);
  assert.equal(upsertBot(l, null, 500), l);
});

test('the list is capped: the least recently seen go, never the bot being written', () => {
  let l = [];
  for (let i = 0; i < BOTS_MAX; i++) l = upsertBot(l, { id: id(i), token: `t${i}` }, 1000 + i);
  assert.equal(l.length, BOTS_MAX);
  l = upsertBot(l, { id: id(50), token: 't50' }, 5000);
  assert.equal(l.length, BOTS_MAX);
  assert.ok(!l.some((e) => e.id === id(0)), 'the oldest was dropped');
  assert.ok(l.some((e) => e.id === id(50)));
  // an old bot written with an old clock still survives its own write
  l = upsertBot(l, { id: id(60), token: 't60' }, 1);
  assert.ok(l.some((e) => e.id === id(60)));
  assert.equal(l.length, BOTS_MAX);
  assert.equal(capBots([bot(1), bot(2), bot(3)], 2).length, 2);
  assert.deepEqual(capBots([bot(1), bot(2), bot(3)], 2).map((e) => e.id), [id(2), id(3)]);
  assert.deepEqual(capBots([bot(1), bot(2), bot(3)], 2, id(1)).map((e) => e.id), [id(1), id(3)]);
});

test('removeBot forgets one bot and leaves the list alone when it is not there', () => {
  const l = [bot(1), bot(2)];
  assert.deepEqual(removeBot(l, id(1)).map((e) => e.id), [id(2)]);
  assert.equal(removeBot(l, id(9)), l);
});

test('sortBots: live first, then not launched, each most recently seen first', () => {
  const l = [bot(1), bot(2, { converted: true }), bot(3), bot(4, { converted: true })];
  assert.deepEqual(sortBots(l).map((e) => e.id), [id(4), id(2), id(3), id(1)]);
  assert.deepEqual(l.map((e) => e.id), [id(1), id(2), id(3), id(4)], 'the input is not reordered');
});

test('botLabel never shows the placeholder name', () => {
  assert.equal(botLabel({ name: 'Lumen Bikes' }), 'Lumen Bikes');
  assert.equal(botLabel({ name: 'SampleBot' }), 'Unnamed bot');
  assert.equal(botLabel({ name: '' }, true), 'Your bot');
  assert.equal(botLabel(null), 'Unnamed bot');
});

test('sameBots ignores the last-seen time only', () => {
  assert.equal(sameBots([bot(1)], [bot(1, { seenAt: 999 })]), true);
  assert.equal(sameBots([bot(1)], [bot(1, { name: 'Other' })]), false);
  assert.equal(sameBots([bot(1)], [bot(1), bot(2)]), false);
});

test('cleanBots: one entry per bot (the most recent wins), bad entries dropped', () => {
  const l = cleanBots([bot(1, { seenAt: 5, name: 'old' }), 'junk', { id: id(2) }, bot(1, { seenAt: 9, name: 'new' }), bot(3)]);
  assert.deepEqual(l.map((e) => [e.id, e.name]), [[id(1), 'new'], [id(3), 'Bot 3']]);
  assert.deepEqual(cleanBots('nope'), []);
});

test('readBots / writeBots: versioned, never throw, an empty list removes the key', () => {
  const st = fakeStorage();
  assert.deepEqual(readBots(st), []);
  assert.equal(writeBots([bot(1), bot(2)], st), true);
  assert.equal(JSON.parse(st.m.get(BOTS_KEY)).v, 1);
  assert.deepEqual(readBots(st).map((e) => e.id), [id(1), id(2)]);
  assert.equal(writeBots([], st), true);
  assert.equal(st.m.has(BOTS_KEY), false);
  assert.deepEqual(readBots(fakeStorage({ [BOTS_KEY]: '{not json' })), []);
  assert.deepEqual(readBots(fakeStorage({ [BOTS_KEY]: JSON.stringify({ v: 2, bots: [bot(1)] }) })), [], 'another version is not read');
  assert.deepEqual(readBots(fakeStorage({ [BOTS_KEY]: JSON.stringify([bot(1)]) })), []);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(readBots(blocked), []);
  assert.equal(writeBots([bot(1)], blocked), false);
});
