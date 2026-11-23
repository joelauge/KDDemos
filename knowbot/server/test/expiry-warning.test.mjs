// The expiry warning: an unlaunched (trial) bot seen on a real website is noticed (flags.installed, host only), its
// owner is e-mailed at 3 days and at 1 day before it stops, and GET /trials/:id tells the Studio so it can show a banner.
// Fakes only: never touches knowDrive, a real model or a real mail sender.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { expiryWarningEmail, timeLeftText, stopTimeText } from '../expiry-warning.mjs';
import { DAY, sleep, nextIp, boot, client, useFakeSpeed, FAST_SPEED } from './trials-helpers.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1: nothing here may reach a real store
useFakeSpeed(FAST_SPEED);
const HOUR = 3600000;
const VENDORS = /resend|twilio|stripe|anthropic|openai|gemini|google|cloudflare|fly\.io|sendgrid|mailgun/i;

describe('expiry warning e-mail (pure)', () => {
  const at = Date.UTC(2026, 10, 20, 15, 0, 0);
  test('says how long is left without rounding a day up', () => {
    assert.equal(timeLeftText(at, at - 3 * DAY), 'in 3 days');
    assert.equal(timeLeftText(at, at - 2.2 * DAY), 'in 2 days');
    assert.equal(timeLeftText(at, at - 1.2 * DAY), 'in 1 day');
    assert.equal(timeLeftText(at, at - 12 * HOUR), 'in 12 hours');
    assert.equal(timeLeftText(at, at - 20 * 60000), 'in 1 hour');
    assert.equal(stopTimeText(at), 'Friday, November 20 at 3:00 PM UTC');
  });
  test('subject, body, button, plain text: plain words, the host, the stop time, no vendor names, nothing untrue', () => {
    const link = 'https://knowbot.knowdrive.ai/?t=tr_aaaaaaaaaaaaaaaa&k=abc.def';
    const m = expiryWarningEmail({ host: 'shop.example', botName: 'Lumen <Help>', expiresAt: at, now: at - 2 * DAY, link });
    assert.equal(m.subject, 'Your bot on shop.example stops answering in 2 days');
    for (const part of [m.html, m.text]) {
      assert.match(part, /is answering visitors on shop\.example/);
      assert.match(part, /Friday, November 20 at 3:00 PM UTC/);
      assert.match(part, /stops answering on your site and its files are deleted/);
      assert.match(part, /Keep my bot running/);
      assert.ok(!VENDORS.test(part), 'no third-party vendor is named');
      assert.ok(!/—|–/.test(part), 'no dashes');
      assert.ok(!/were deleted|have been deleted|has stopped/i.test(part), 'nothing has happened yet');
    }
    assert.ok(m.html.includes('href="https://knowbot.knowdrive.ai/?t=tr_aaaaaaaaaaaaaaaa&amp;k=abc.def"'), 'the button links to the bot');
    assert.equal((m.html.match(/<a /g) || []).length, 1, 'one button, no other link');
    assert.ok(m.html.includes('Lumen &lt;Help&gt;') && !m.html.includes('<Help>'), 'the bot name is escaped');
    assert.ok(m.text.includes(link));
    assert.match(m.html, /prefers-color-scheme:dark/);
    assert.match(m.html, /role="presentation"/);
  });
});

describe('expiry warning (server)', () => {
  let S, c;
  const sent = [];
  const mailTo = (to) => sent.filter((x) => x.to === to);
  const st = () => S.kb.studio;
  const flags = (t) => st().trials.get(t.trialId)?.flags || {};
  const specWrites = (t) => S.kd.calls.filter((x) => x.url === '/api/v1/ingest' && x.ingest?.path === `knowbot/trials/${t.trialId}/_spec.json`).length;
  const visit = (t, headers = {}) => S.api(`/api/v1/channels/${t.trialId}`, { headers: { 'x-forwarded-for': nextIp(), ...headers } });
  const admin = (t, sub, body = {}) => S.api(`/api/studio/trials/${t.trialId}/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-admin', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body) });
  /** Waits for the (never awaited) install note of the last request. */
  async function installed(t, host, ms = 3000) {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (flags(t).installed?.host === host) return flags(t).installed; await sleep(15); }
    assert.fail(`never installed on ${host}: ${JSON.stringify(flags(t).installed)}`);
  }
  /** A saved bot (one small file, so its state file exists), optionally with an owner address and seen on a site. */
  async function bot({ email = null, host = null } = {}) {
    const t = await c.trial();
    assert.equal((await c.upload(t, 'returns.md', Buffer.from('# Returns\n\nUnused items can be returned within 30 days of delivery for a full refund.\n'))).status, 201);
    await c.waitReady(t, 1);
    if (email) assert.equal((await c.json(t, '/email', 'POST', { email })).status, 200);
    if (host) { assert.equal((await visit(t, { origin: `https://${host}` })).status, 200); await installed(t, host); }
    await st().flush();
    return t;
  }

  before(async () => {
    S = await boot({ studio: { sendEmail: async (env, msg) => { sent.push(msg); return { id: `m${sent.length}` }; } } });
    c = client(S);
  });
  after(async () => { await S.close(); });

  test('install: a real site counts; no origin, localhost, KnowBot\'s own site, this server and the owner\'s key do not', async () => {
    const t = await bot();
    const dk = await (await S.api(`/api/studio/trials/${t.trialId}/devkey`, { headers: c.h(t) })).json();
    for (const h of [{}, { origin: 'null' }, { origin: 'http://localhost:5173' }, { origin: 'http://127.0.0.1:8080' }, { origin: 'https://knowbot.knowdrive.ai' }, { referer: 'https://knowbot.knowdrive.ai/?t=x' },
      { origin: S.base }, { origin: 'http://192.168.1.20:3000' }, { origin: 'chrome-extension://abcdef' }]) {
      assert.equal((await visit(t, h)).status, 200);
    }
    // the owner's own key (the Studio's preview and tests), even from another origin
    const own = await S.api(`/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${dk.key}`, 'content-type': 'application/json', origin: 'https://owner.example' }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) });
    assert.equal(own.status, 200);
    const ownWeb = await S.api(`/api/v1/bots/${t.trialId}/web`, { method: 'POST', headers: { authorization: `Bearer ${dk.key}`, 'content-type': 'application/json', origin: 'https://owner.example', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) });
    assert.equal(ownWeb.status, 200);
    await sleep(120);
    assert.equal(flags(t).installed, undefined, 'none of those is an install');
    assert.equal((await (await c.json(t, '')).json()).installed, null, 'GET /trials/:id: not installed');

    // the website line on the owner's site reads the bot's switches on every page load
    const before = Date.now();
    assert.equal((await visit(t, { origin: 'https://www.shop.example' })).status, 200);
    const i = await installed(t, 'www.shop.example');
    assert.deepEqual(Object.keys(i).sort(), ['firstSeenAt', 'host', 'lastSeenAt'], 'the host and two times, nothing else');
    assert.ok(Date.parse(i.firstSeenAt) >= before - 1000 && i.firstSeenAt === i.lastSeenAt);
    const got = await (await c.json(t, '')).json();
    assert.deepEqual(got.installed, { host: 'www.shop.example', lastSeenAt: i.lastSeenAt }, 'GET /trials/:id tells the owner');
  });

  test('install: written on the first sighting, then only when a day has passed or the site changes; host only', async () => {
    const t = await bot({ host: 'shop.example' });
    const first = { ...flags(t).installed };
    const n0 = specWrites(t);
    const row = () => [...S.kd.files.values()].find((f) => f.filename === `knowbot/trials/${t.trialId}/_spec.json`);
    assert.ok(row().tags.includes('installed:site'), 'the saved state is tagged, so the hourly pass can find it after a restart');
    for (let k = 0; k < 6; k++) await visit(t, { origin: 'https://shop.example' });
    await visit(t, { referer: 'https://shop.example/products/trail-pro?utm_source=news&email=ana%40example.com' });
    await sleep(100); await st().flush();
    assert.equal(specWrites(t), n0, 'repeat page loads write nothing');
    assert.deepEqual(flags(t).installed, first);
    try {
      // another site a few minutes later: the saved one stays (two sites taking turns never write on every request)
      S.clock.skew = 10 * 60000;
      await visit(t, { origin: 'https://other.example' });
      await sleep(100); await st().flush();
      assert.equal(specWrites(t), n0);
      assert.equal(flags(t).installed.host, 'shop.example');
      // a day later the same site refreshes lastSeenAt (one write), and keeps firstSeenAt
      S.clock.skew = 25 * HOUR;
      await visit(t, { origin: 'https://shop.example' });
      for (const t0 = Date.now(); Date.now() - t0 < 3000 && flags(t).installed.lastSeenAt === first.lastSeenAt;) await sleep(15);
      await st().flush();
      assert.equal(flags(t).installed.firstSeenAt, first.firstSeenAt);
      assert.ok(Date.parse(flags(t).installed.lastSeenAt) - Date.parse(first.lastSeenAt) >= 24 * HOUR);
      assert.equal(specWrites(t), n0 + 1);
      // later a different site: the most recently seen one is kept; only its host (from a Referer here), no path or query
      S.clock.skew = 27 * HOUR;
      await visit(t, { referer: 'https://New-Shop.example:8443/checkout/thanks?order=991&email=ana%40example.com' });
      const moved = await installed(t, 'new-shop.example');
      assert.equal(moved.firstSeenAt, moved.lastSeenAt);
      await st().flush();
      assert.equal(specWrites(t), n0 + 2);
      const saved = row().text;
      assert.ok(saved.includes('"host": "new-shop.example"') && !/thanks|order=|ana%40|utm_source|trail-pro|8443/.test(saved), 'no path, query or visitor detail is stored');
    } finally { S.clock.skew = 0; }
  });

  test('install: the widget, the Homepage search config and its site key each count', async () => {
    const t = await bot();
    try {
      const web = await S.api(`/api/v1/bots/${t.trialId}/web`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://widget.example', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) });
      assert.equal(web.status, 200);
      await installed(t, 'widget.example');
      // the Homepage search: built, published, then loaded by the owner's page
      assert.equal((await c.json(t, '/site')).status, 200);
      assert.equal((await c.json(t, '/site', 'POST', { published: true })).status, 200);
      S.clock.skew = 2 * HOUR;
      const dk = await (await S.api(`/api/studio/trials/${t.trialId}/devkey`, { headers: c.h(t) })).json();
      assert.equal((await S.api(`/api/site/${t.trialId}`, { headers: { authorization: `Bearer ${dk.key}`, origin: 'https://ownerpreview.example', 'x-forwarded-for': nextIp() } })).status, 200);
      await sleep(100);
      assert.equal(flags(t).installed.host, 'widget.example', 'the owner\'s preview is not an install');
      const cfg = await S.api(`/api/site/${t.trialId}`, { headers: { origin: 'https://home.example', 'x-forwarded-for': nextIp() } });
      assert.equal(cfg.status, 200);
      await installed(t, 'home.example');
      S.clock.skew = 4 * HOUR;
      const key = (await cfg.json()).key;
      const ask = await S.api(`/api/v1/bots/${t.trialId}/chat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: 'https://search.example', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ question: 'How long do I have to return an item?' }) });
      assert.equal(ask.status, 200);
      await installed(t, 'search.example');
    } finally { S.clock.skew = 0; }
  });

  test('e-mail: once at 3 days, once at 1 day, again after an extension; the link reopens the bot', async () => {
    const to = 'ana.marks@example.com';
    const t = await bot({ email: to, host: 'shop.example' });
    await c.json(t, '', 'PATCH', { name: 'Lumen Help' });
    await st().flush();
    try {
      assert.equal((await st().warnExpiring()).sent, 0, '7 days left: nothing');
      S.clock.skew = 3.9 * DAY;
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 0, 'more than 3 days left: nothing');
      S.clock.skew = 4.5 * DAY;
      const r1 = await st().warnExpiring();
      assert.ok(r1.sent >= 1);
      assert.equal(mailTo(to).length, 1);
      const m = mailTo(to)[0];
      assert.match(m.subject, /^Your bot on shop\.example stops answering in (2|3) days$/);
      assert.match(m.from, /^KnowBot </);
      assert.match(m.text, /Lumen Help is answering visitors on shop\.example/);
      assert.ok(m.html.includes('Keep my bot running') && !VENDORS.test(m.html + m.text));
      const exp = Date.parse((await (await c.json(t, '')).json()).expiresAt);
      assert.ok(m.text.includes(new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(exp))), 'the day it stops');
      const link = /https:\/\/knowbot\.knowdrive\.ai\/\?t=(tr_[a-z2-7]{16})&k=(\S+)/.exec(m.text);
      assert.ok(link && link[1] === t.trialId, 'a link to the bot in the Studio, on the public site');
      const back = await S.api(`/api/studio/trials/${t.trialId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ k: decodeURIComponent(link[2]) }) });
      assert.equal(back.status, 200, 'the link\'s key reopens the bot');
      // the same mark is never sent twice, also when the server restarted in between (nothing in memory)
      await st().warnExpiring();
      await st().flush(); st().trials.delete(t.trialId);
      S.clock.skew = 5 * DAY;
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 1);
      // 1 day or less: the second and last one
      S.clock.skew = 6.5 * DAY;
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 2);
      assert.equal(mailTo(to)[1].subject, 'Your bot on shop.example stops answering in 12 hours');
      S.clock.skew = 6.9 * DAY;
      const sw = await st().sweep();
      assert.equal(sw.warned, 0, 'the hourly sweep runs the pass; nothing new to send');
      assert.equal(mailTo(to).length, 2);
      assert.deepEqual(flags(t).expiryWarned.marks.slice().sort(), [1, 3]);
      // an admin gives it 30 more days: quiet until the new end is near, then both warnings again
      assert.equal((await admin(t, 'extend', { days: 30 })).status, 200);
      await st().warnExpiring();
      S.clock.skew = (6.9 + 27.5) * DAY;
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 2, 'not seen on the site for weeks: not installed any more, no mail');
      await visit(t, { origin: 'https://shop.example' });
      for (const t0 = Date.now(); Date.now() - t0 < 3000 && Date.now() + S.clock.skew - Date.parse(flags(t).installed.lastSeenAt) > DAY;) await sleep(15);
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 3, 'the expiry moved later: warned again');
      assert.match(mailTo(to)[2].subject, /in (2|3) days$/);
      S.clock.skew = (6.9 + 29.5) * DAY;
      await st().warnExpiring(); await st().warnExpiring();
      assert.equal(mailTo(to).length, 4);
    } finally { S.clock.skew = 0; }
  });

  test('e-mail: after a restart (no trial in memory) the pass finds the bot from the store rows alone', async () => {
    const to = 'restart@example.com';
    const t = await bot({ email: to, host: 'restart-shop.example' });
    const quiet = await bot({ email: 'quiet@example.com' });   // saved, has an address, never installed
    await st().flush();
    st().trials.delete(t.trialId); st().trials.delete(quiet.trialId);
    try {
      S.clock.skew = 5 * DAY;
      const reads = () => S.kd.calls.filter((x) => String(x.url).includes(`/path/content/knowbot/trials/${quiet.trialId}/`)).length;
      const r0 = reads();
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 1);
      assert.match(mailTo(to)[0].subject, /^Your bot on restart-shop\.example stops answering in 2 days$/);
      assert.equal(mailTo('quiet@example.com').length, 0, 'not installed: no mail');
      assert.equal(reads(), r0, 'a bot that is not installed is not even loaded');
      assert.ok(!st().trials.has(quiet.trialId));
    } finally { S.clock.skew = 0; }
  });

  test('e-mail: none for a launched bot, none without an address (and it is not marked as warned)', async () => {
    const launched = await bot({ email: 'launched@example.com', host: 'live-shop.example' });
    assert.equal((await admin(launched, 'convert', { account: 'acme', bucketId: 'acme-help' })).status, 200);
    assert.equal((await (await c.json(launched, '')).json()).installed, null, 'a launched bot never sees the banner');
    const nobody = await bot({ host: 'nobody-shop.example' });
    try {
      S.clock.skew = 5 * DAY;
      const before = sent.length;
      await st().warnExpiring();
      assert.equal(mailTo('launched@example.com').length, 0);
      assert.equal(sent.slice(before).filter((x) => /nobody-shop/.test(x.subject)).length, 0);
      assert.equal(flags(nobody).expiryWarned, undefined, 'no address: nothing sent, nothing marked');
      assert.equal((await (await c.json(nobody, '')).json()).installed.host, 'nobody-shop.example', 'the Studio banner still has what it needs');
      // the owner then leaves an address: the warning goes out on the next pass
      assert.equal((await c.json(nobody, '/email', 'POST', { email: 'late@example.com' })).status, 200);
      await st().warnExpiring();
      assert.equal(mailTo('late@example.com').length, 1);
    } finally { S.clock.skew = 0; }
  });

  test('e-mail: a failed send is not marked, so the next pass tries again', async () => {
    const to = 'bounce-once@example.com';
    const t = await bot({ email: to, host: 'retry-shop.example' });
    const orig = sent.push.bind(sent);
    let fail = true;
    sent.push = (m) => { if (fail && m.to === to) { fail = false; throw new Error('mail API HTTP 500'); } return orig(m); };
    try {
      S.clock.skew = 5 * DAY;
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 0);
      assert.equal(flags(t).expiryWarned, undefined);
      await st().warnExpiring();
      assert.equal(mailTo(to).length, 1);
    } finally { S.clock.skew = 0; sent.push = orig; }
  });
});

describe('expiry warning (mail not configured)', () => {
  let S, c;
  before(async () => { S = await boot(); c = client(S); });
  after(async () => { await S.close(); });
  test('skips quietly and does not mark the bot as warned', async () => {
    const t = await c.trial();
    assert.equal((await c.upload(t, 'a.md', Buffer.from('# A\n\nOpen every day from nine to five.\n'))).status, 201);
    await c.waitReady(t, 1);
    assert.equal((await c.json(t, '/email', 'POST', { email: 'owner@example.com' })).status, 200);
    assert.equal((await S.api(`/api/v1/channels/${t.trialId}`, { headers: { origin: 'https://shop.example' } })).status, 200);
    const T = () => S.kb.studio.trials.get(t.trialId);
    for (const t0 = Date.now(); Date.now() - t0 < 3000 && !T().flags.installed;) await sleep(15);
    assert.equal(T().flags.installed.host, 'shop.example');
    try {
      S.clock.skew = 5 * DAY;
      const r = await S.kb.studio.warnExpiring();
      assert.deepEqual(r, { checked: 1, sent: 0 });
      assert.equal(T().flags.expiryWarned, undefined);
    } finally { S.clock.skew = 0; }
  });
});
