// The question history behind the Studio's full Stats & Leads view (server/questions.mjs questionHistory / questionsCsv,
// GET /api/studio/trials/:id/history[.csv]): paging, filters, the viewer's-day buckets (time zones), the Studio-tests
// switch, search, the stored answer (new questions only), the CSV, and auth exactly like the leads report.
// Fakes only (fake knowDrive, fake model).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { createLeads } from '../leads.mjs';
import {
  logQuestion, questionHistory, questionsCsv, historyRange, flushQuestions, configureQuestions, _resetQuestions, scrubAnswer, questionDoc, parseQuestionDoc,
  QUESTIONS_CSV_COLUMNS, HISTORY_ALL_DAYS,
} from '../questions.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86400000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const at = (iso) => Date.parse(iso);

describe('history: ranges and time zones', () => {
  test('a range is whole local days; tz is minutes east of UTC; UTC without it', () => {
    const utc = historyRange({ days: 7, now: NOW });
    assert.deepEqual([utc.from, utc.to, utc.days, utc.tz], ['2026-11-04', '2026-11-10', 7, 0]);
    assert.equal(utc.startMs, at('2026-11-04T00:00:00Z'));
    assert.equal(utc.endMs, at('2026-11-11T00:00:00Z'));
    // Toronto in November (UTC-5): the local day starts at 05:00 UTC
    const tor = historyRange({ days: 7, tz: -300, now: NOW });
    assert.equal(tor.startMs, at('2026-11-04T05:00:00Z'));
    // 01:00 UTC on the 10th is still the 9th in Toronto, already the 10th in Tokyo
    assert.equal(historyRange({ days: 1, tz: -300, now: at('2026-11-10T01:00:00Z') }).to, '2026-11-09');
    assert.equal(historyRange({ days: 1, tz: 540, now: at('2026-11-09T16:00:00Z') }).to, '2026-11-10');
    // from / to win over days; a to in the future is today; a garbage tz is UTC; tz is clamped to real offsets
    const ft = historyRange({ from: '2026-10-01', to: '2026-12-31', now: NOW });
    assert.deepEqual([ft.from, ft.to, ft.days], ['2026-10-01', '2026-11-10', 41]);
    assert.equal(historyRange({ days: 7, tz: 'x', now: NOW }).tz, 0);
    assert.equal(historyRange({ days: 7, tz: 99999, now: NOW }).tz, 840);
    const all = historyRange({ days: 'all', now: NOW });
    assert.equal(all.open, true);
    assert.equal(all.days, HISTORY_ALL_DAYS);
  });
});

describe('history: the list (memory)', () => {
  const tags = ['trial:tr_historytestaaaaaa'];
  before(() => {
    _resetQuestions();
    const log = (question, o = {}) => logQuestion({ scopeTags: tags, question, outcome: 'answered', channel: 'web', callerKey: question, ...o });
    log('Do you ship to Canada?', { channel: 'sms', now: at('2026-11-10T02:30:00Z'), citations: [{ file: 'shipping.md' }], topScore: 0.83, answer: 'Yes. We ship to Canada. Write to help@lumen.example or call 416 555 0142.' });
    log('Do you ship to Brazil?', { channel: 'sms', outcome: 'refused', now: at('2026-11-09T15:00:00Z'), topScore: 0.6, answer: 'never stored for a refusal' });
    log('What is the capital of France?', { channel: 'web', outcome: 'refused', now: at('2026-11-09T14:00:00Z'), topScore: 0.2 });
    log('What are your hours?', { channel: 'phone', now: at('2026-11-08T20:00:00Z') });
    log('How long is the frame warranty?', { channel: 'studio', now: at('2026-11-08T10:00:00Z') });
    log('Is the price 499 dollars?', { channel: 'phone', now: at('2026-11-07T10:00:00Z'), flags: ['unsupported_figure'], note: 'said 499 not in the facts' });
    log("What's the weather in Paris today?", { channel: 'studio', outcome: 'refused', origin: 'probe', now: at('2026-11-10T03:00:00Z') });
    log('Asked by setup', { channel: 'studio', origin: 'setup', now: at('2026-11-10T04:00:00Z') });
    log('Too old for a week', { channel: 'email', now: NOW - 40 * DAY });
  });
  after(() => _resetQuestions());
  const hist = (o = {}) => questionHistory({ scopeTags: tags, days: 7, now: NOW, ...o });

  test('newest first, with per-day counts by outcome; test traffic is never listed', async () => {
    const r = await hist();
    assert.deepEqual(r.range, { from: '2026-11-04', to: '2026-11-10', tz: 0, days: 7 });
    assert.equal(r.total, 6);
    assert.equal(r.answered, 4);
    assert.equal(r.refused, 2);
    assert.equal(r.flagged, 1);
    assert.deepEqual(r.items.map((i) => i.q), ['Do you ship to Canada?', 'Do you ship to Brazil?', 'What is the capital of France?', 'What are your hours?', 'How long is the frame warranty?', 'Is the price 499 dollars?']);
    assert.equal(r.byDay.length, 7);
    assert.deepEqual(r.byDay.map((d) => d.day), ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
    assert.deepEqual(r.byDay.at(-2), { day: '2026-11-09', total: 2, answered: 0, refused: 2, flagged: 0 });
    assert.deepEqual(r.byDay.at(-1), { day: '2026-11-10', total: 1, answered: 1, refused: 0, flagged: 0 });
    assert.equal(r.byDay[3].flagged, 1);
    assert.equal(r.byDay.reduce((n, d) => n + d.total, 0), r.total, 'the chart adds up to the total');
    assert.deepEqual(r.dayCounts, { '2026-11-10': 1, '2026-11-09': 2, '2026-11-08': 2, '2026-11-07': 1 });
    assert.equal(r.byChannel.sms, 2);
    assert.equal(r.byChannel.studio, 1, 'the owner\'s own Studio question counts; the probe and the setup ask do not');
    assert.equal(r.matched, 6);
    assert.equal(r.nextCursor, null);
    assert.doesNotMatch(JSON.stringify(r), /weather in Paris|Asked by setup|Too old/);
  });

  test('each row: local time, channel, outcome, cited files, flags and the stored answer (masked like a question)', async () => {
    const r = await hist();
    const ca = r.items[0];
    assert.equal(ca.day, '2026-11-10');
    assert.equal(ca.time, '02:30');
    assert.equal(ca.at, '2026-11-10T02:30:00.000Z');
    assert.equal(ca.channel, 'sms');
    assert.equal(ca.outcome, 'answered');
    assert.deepEqual(ca.files, ['shipping.md']);
    assert.equal(ca.top, 0.83);
    assert.equal(ca.answer, 'Yes. We ship to Canada. Write to [email] or call [number].');
    const br = r.items[1];
    assert.equal(br.outcome, 'gap');
    assert.equal(br.answer, null, 'a refusal has no answer');
    assert.equal(r.items[3].answer, null, 'answered, but no answer text was logged (an older question)');
    const fl = r.items.at(-1);
    assert.deepEqual(fl.flags, ['unsupported_figure']);
    assert.equal(fl.note, 'said 499 not in the facts');
    assert.ok(r.items.every((i) => /^[a-z0-9-]+$/.test(i.id)) && new Set(r.items.map((i) => i.id)).size === r.items.length);
  });

  test('days are the viewer\'s days: the same question lands on different days in different time zones', async () => {
    // 02:30 UTC on Nov 10 is 21:30 on Nov 9 in Toronto (UTC-5)
    const tor = await hist({ tz: -300 });
    assert.equal(tor.range.tz, -300);
    const ca = tor.items.find((i) => i.q === 'Do you ship to Canada?');
    assert.deepEqual([ca.day, ca.time], ['2026-11-09', '21:30']);
    assert.deepEqual(tor.byDay.at(-1), { day: '2026-11-10', total: 0, answered: 0, refused: 0, flagged: 0 });
    assert.equal(tor.byDay.at(-2).total, 3);
    // 20:00 UTC on Nov 8 is 05:00 on Nov 9 in Tokyo (UTC+9)
    const tok = await hist({ tz: 540 });
    const hrs = tok.items.find((i) => i.q === 'What are your hours?');
    assert.deepEqual([hrs.day, hrs.time], ['2026-11-09', '05:00']);
    assert.equal(tok.byDay.reduce((n, d) => n + d.total, 0), tok.total);
    // one day
    const one = await hist({ tz: -300, day: '2026-11-09' });
    assert.deepEqual(one.items.map((i) => i.q), ['Do you ship to Canada?', 'Do you ship to Brazil?', 'What is the capital of France?']);
    assert.equal(one.total, 6, 'the totals and the chart keep the whole range');
    assert.equal(one.matched, 3);
  });

  test('filters: channel, outcome, search, and the Studio-tests switch', async () => {
    const sms = await hist({ channel: 'sms' });
    assert.equal(sms.total, 2, 'the chart follows the channel');
    assert.equal(sms.byChannel.phone, 2, 'the channel breakdown still shows every channel');
    assert.deepEqual(sms.items.map((i) => i.q), ['Do you ship to Canada?', 'Do you ship to Brazil?']);
    assert.deepEqual((await hist({ outcome: 'answered' })).items.map((i) => i.outcome), ['answered', 'answered', 'answered', 'answered']);
    assert.equal((await hist({ outcome: 'refused' })).matched, 2);
    assert.deepEqual((await hist({ outcome: 'flagged' })).items.map((i) => i.q), ['Is the price 499 dollars?']);
    // gap vs off-topic is the caller's rule (the Studio passes the one its insights card uses)
    const classify = ({ q, top }) => (/capital of/.test(q) || top < 0.3 ? 'off_topic' : 'gap');
    assert.deepEqual((await hist({ outcome: 'gap', classify })).items.map((i) => i.q), ['Do you ship to Brazil?']);
    const off = await hist({ outcome: 'off_topic', classify });
    assert.deepEqual(off.items.map((i) => [i.q, i.outcome]), [['What is the capital of France?', 'off_topic']]);
    // search: case, accents and spacing do not matter; it only ever searches the question text
    assert.deepEqual((await hist({ q: '  SHIP  to ' })).items.map((i) => i.q), ['Do you ship to Canada?', 'Do you ship to Brazil?']);
    assert.equal((await hist({ q: 'shipping.md' })).matched, 0);
    assert.equal((await hist({ q: 'ship', channel: 'sms', outcome: 'answered' })).matched, 1);
    // Studio (your tests) off
    const noStudio = await hist({ includeStudio: false });
    assert.equal(noStudio.total, 5);
    assert.equal(noStudio.byChannel.studio, 0);
    assert.ok(noStudio.items.every((i) => i.channel !== 'studio'));
    // unknown filter values are ignored, never an error
    assert.equal((await hist({ channel: 'fax', outcome: 'maybe', day: 'yesterday' })).matched, 6);
  });

  test('paging: a cursor continues exactly where the page ended', async () => {
    const p1 = await hist({ limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = await hist({ limit: 2, cursor: p1.nextCursor });
    const p3 = await hist({ limit: 2, cursor: p2.nextCursor });
    assert.equal(p3.nextCursor, null);
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.q), (await hist()).items.map((i) => i.q));
    assert.equal(p2.matched, 6, 'every page reports the whole match count');
    assert.deepEqual(p2.dayCounts, { '2026-11-09': 2, '2026-11-08': 2 }, 'a day header on a later page still has the whole day\'s count');
    // a bad cursor starts over; a huge limit is capped
    assert.equal((await hist({ limit: 2, cursor: '!!' })).items[0].q, 'Do you ship to Canada?');
    assert.equal((await hist({ limit: 100000 })).items.length, 6);
  });

  test('"All" starts at the first day with a question (at least a week)', async () => {
    const r = await hist({ days: 'all' });
    assert.equal(r.range.all, true);
    assert.equal(r.range.from, '2026-10-01');
    assert.equal(r.total, 7);
    assert.equal(r.byDay.length, r.range.days);
    assert.equal(r.byDay[0].total, 1);
    assert.equal(r.items.at(-1).q, 'Too old for a week');
    const empty = await questionHistory({ scopeTags: ['trial:tr_nothingyetaaaaaaaa'], days: 'all', now: NOW });
    assert.deepEqual([empty.range.from, empty.range.days, empty.total, empty.items.length], ['2026-11-04', 7, 0, 0]);
  });

  test('the CSV: date, time, channel, question, outcome; newest first; formulas neutralised', async () => {
    logQuestion({ scopeTags: tags, question: '=SUM(A1:A9), "really"?', outcome: 'refused', channel: 'email', callerKey: 'x', now: at('2026-11-10T09:00:00Z') });
    const csv = await questionsCsv({ scopeTags: tags, days: 7, now: NOW, tz: -300, classify: ({ q }) => (/capital of/.test(q) ? 'off_topic' : 'gap') });
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines[0], QUESTIONS_CSV_COLUMNS.join(','));
    assert.equal(lines[0], 'date,time,channel,question,outcome');
    assert.equal(lines.length, 8);
    assert.equal(lines[1], `2026-11-10,04:00,email,"'=SUM(A1:A9), ""really""?",not in files`);
    assert.ok(lines.includes('2026-11-09,21:30,sms,Do you ship to Canada?,answered'), csv);
    assert.ok(lines.includes('2026-11-09,09:00,web,What is the capital of France?,off-topic'), csv);
    assert.ok(lines.includes('2026-11-07,05:00,phone,Is the price 499 dollars?,answered; flagged: unsupported_figure'), csv);
    assert.doesNotMatch(csv, /weather in Paris|shipping\.md|We ship to Canada/, 'no test traffic, no sources, no answers: only what the columns say');
    // the same filters as the list
    assert.equal((await questionsCsv({ scopeTags: tags, days: 7, now: NOW, channel: 'sms' })).trimEnd().split('\r\n').length, 3);
  });
});

describe('history: the stored document', () => {
  test('the answer travels in the file\'s metadata; older files simply have none', () => {
    assert.equal(scrubAnswer('Call  +1 (416) 555-0142\nor a@b.co. Open 9 to 5.'), 'Call [number] or [email]. Open 9 to 5.');
    assert.equal(scrubAnswer('x'.repeat(4000)).length, 1500);
    const doc = questionDoc({ q: 'Hours?', hash: 'h', outcome: 'answered', channel: 'web', at: 0, top: 0.9, files: ['hours.md'], answer: 'Open 9 to 5 --> daily' });
    assert.equal(parseQuestionDoc(doc).answer, 'Open 9 to 5 --> daily');
    assert.equal(doc.split('\n')[0], 'Hours?', 'the question is still the first line (similarity grouping compares question to question)');
    assert.ok(!/-->[\s\S]*-->/.test(doc.replace(/-->\s*$/, '')), 'an answer cannot close the metadata comment early');
    assert.equal(parseQuestionDoc(questionDoc({ q: 'Hours?', hash: 'h', outcome: 'answered', channel: 'web', at: 0, top: 0.9, files: [] })).answer, undefined);
  });
});

describe('history: from the question log (fake knowDrive)', () => {
  let kd;
  const kdc = () => ({ baseUrl: kd.url, apiKey: 'fake-key', store: 'vs_fake' });
  const tags = ['trial:tr_historykdaaaaaaaa'];
  const root = 'knowbot/trials/tr_historykdaaaaaaaa/';
  const N = 130;
  before(async () => {
    _resetQuestions();
    kd = await startFakeKnowDrive({ speed: 50 });
    configureQuestions({ debounceMs: 5, dedupeMs: 0 });
    // 130 questions over three months, one every 14 hours back from "now"; every 5th refused, every 13th by phone
    for (let i = 0; i < N; i++) {
      logQuestion({ kd: kdc(), scopeTags: tags, root, question: i % 5 === 0 ? `Do you ship to planet ${i}?` : `What is the warranty on model ${i}?`, outcome: i % 5 === 0 ? 'refused' : 'answered',
        channel: i % 13 === 0 ? 'phone' : 'web', callerKey: `c${i}`, now: NOW - i * 14 * 3600000, citations: i % 5 === 0 ? [] : [{ file: 'warranty.md' }], topScore: i % 5 === 0 ? 0.5 : 0.9,
        ...(i < 10 ? { answer: `Model ${i} has a 2 year warranty. Questions: care@lumen.example` } : {}) });
    }
    logQuestion({ kd: kdc(), scopeTags: tags, root, question: "What's the weather in Paris today?", outcome: 'refused', channel: 'studio', origin: 'probe', callerKey: 'p', now: NOW - 3600000 });
    logQuestion({ kd: kdc(), scopeTags: ['trial:tr_someoneelseaaaaaa'], root: 'knowbot/trials/tr_someoneelseaaaaaa/', question: 'Another bot entirely?', outcome: 'answered', channel: 'web', callerKey: 'z', now: NOW - 3600000 });
    await flushQuestions();
    await kd.settle();
    _resetQuestions(); // nothing in memory: everything below comes from the log itself
    configureQuestions({ historyListTtlMs: 60000 });
  });
  after(async () => { _resetQuestions(); await kd.close(); });
  const hist = (o = {}) => questionHistory({ kd: kdc(), scopeTags: tags, days: 90, now: NOW, ...o });

  test('lists every month the range touches, pages through all of it, and reads only the page it shows', async () => {
    const before = kd.calls.length;
    const all = [];
    let cursor, pages = 0, first;
    do {
      const r = await hist({ cursor, limit: 50 });
      first = first || r;
      all.push(...r.items);
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(first.source, 'knowdrive');
    assert.equal(first.total, N);
    assert.equal(first.refused, 26);
    assert.equal(first.matched, N);
    assert.equal(first.partial, false);
    assert.equal(pages, 3);
    assert.equal(all.length, N);
    assert.equal(new Set(all.map((i) => i.id)).size, N, 'no row twice, none missing');
    assert.deepEqual(all.map((i) => i.at), [...all.map((i) => i.at)].sort().reverse(), 'newest first across pages');
    assert.ok(new Set(all.map((i) => i.day.slice(0, 7))).size >= 3, 'three months of history');
    assert.equal(first.byDay.length, 90);
    assert.equal(first.byDay.reduce((n, d) => n + d.total, 0), N);
    assert.equal(first.byChannel.phone, 10);
    assert.doesNotMatch(JSON.stringify(all), /weather in Paris|Another bot entirely/);
    const made = kd.calls.slice(before);
    const listings = made.filter((c) => /\/files$/.test(c.url));
    assert.ok(listings.length >= 3 && listings.length <= 5, `one listing per month, reused between pages (${listings.length})`);
    assert.ok(made.length <= N + listings.length, `one read per shown row at most (${made.length} calls)`);
  });

  test('new questions carry their answer (masked); older ones say nothing rather than guess', async () => {
    const r = await hist({ limit: 20 });
    assert.equal(r.items[1].q, 'What is the warranty on model 1?');
    assert.equal(r.items[1].answer, 'Model 1 has a 2 year warranty. Questions: [email]');
    assert.deepEqual(r.items[1].files, ['warranty.md']);
    assert.equal(r.items[1].top, 0.9);
    assert.equal(r.items[0].answer, null, 'refused');
    assert.equal(r.items[11].outcome, 'answered');
    assert.equal(r.items[11].answer, null, 'logged without an answer');
  });

  test('search, outcome and day filters work over the whole log, not just the loaded page', async () => {
    const s = await hist({ q: 'model 12' });
    assert.deepEqual(s.items.map((i) => i.q).sort(), ['What is the warranty on model 12?', 'What is the warranty on model 121?', 'What is the warranty on model 122?', 'What is the warranty on model 123?',
      'What is the warranty on model 124?', 'What is the warranty on model 126?', 'What is the warranty on model 127?', 'What is the warranty on model 128?', 'What is the warranty on model 129?'].sort());
    assert.equal(s.partial, false);
    const gaps = await hist({ outcome: 'gap', classify: ({ top }) => (top < 0.3 ? 'off_topic' : 'gap') });
    assert.equal(gaps.matched, 26);
    assert.ok(gaps.items.every((i) => i.outcome === 'gap' && /planet/.test(i.q)));
    const busiest = (await hist()).byDay.reduce((a, b) => (b.total > a.total ? b : a));
    const day = await hist({ day: busiest.day });
    assert.equal(day.matched, busiest.total);
    assert.ok(day.items.length === busiest.total && day.items.every((i) => i.day === busiest.day));
    assert.equal((await hist({ channel: 'phone' })).total, 10);
  });

  test('a time zone moves questions between days without losing any', async () => {
    const a = await hist({ tz: 0 }), b = await hist({ tz: -480 });
    assert.notDeepEqual(a.byDay.map((d) => d.total), b.byDay.map((d) => d.total));
    // the range itself moves with the zone, so only compare what both ranges cover
    assert.ok(Math.abs(a.total - b.total) <= 2);
    assert.equal(b.byDay.reduce((n, d) => n + d.total, 0), b.total);
  });

  test('the CSV has every row of the range', async () => {
    const csv = await questionsCsv({ kd: kdc(), scopeTags: tags, days: 90, now: NOW });
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines.length, N + 1);
    assert.match(lines[1], /^2026-11-10,12:00,phone,Do you ship to planet 0\?,not in files$/);
  });
});

describe('history: through the server (auth like the leads report)', () => {
  let kd, llm, kb, base, dataDir, trial, trial2;
  const api = (p, init = {}) => fetch(base + p, init);
  const H = (t) => ({ authorization: `Bearer ${t.token}`, 'content-type': 'application/json' });
  const T = (t, p) => `/api/studio/trials/${t.trialId}${p}`;
  const sse = (text) => text.split('\n\n').map((fr) => { const ev = /^event: (.*)$/m.exec(fr)?.[1]; return ev ? { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') } : null; }).filter(Boolean);
  const ask = async (t, question) => sse(await (await api(T(t, '/ask'), { method: 'POST', headers: H(t), body: JSON.stringify({ question }) })).text()).find((e) => e.event === 'final').data;
  before(async () => {
    _resetQuestions();
    kd = await startFakeKnowDrive({ speed: 20 });
    llm = await startFakeLLM({ slowMs: 9000 });
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-history-srv-'));
    kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, leads: createLeads({ dataDir }), env: {
      KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
      KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen',
    }, studio: { sweep: false } });
    await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${kb.server.address().port}`;
    trial = await (await api('/api/studio/trials', { method: 'POST' })).json();
    assert.equal((await api(T(trial, '/samples'), { method: 'POST', headers: H(trial), body: JSON.stringify({ set: 'lumen-bikes' }) })).status, 201);
    for (let i = 0; i < 400; i++) {
      const j = await (await api(T(trial, '/files'), { headers: H(trial) })).json();
      if (j.files.length >= 4 && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    trial2 = await (await api('/api/studio/trials', { method: 'POST' })).json();
  });
  after(async () => { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); _resetQuestions(); });

  test('the history and its CSV need the bot\'s own trial token', async () => {
    for (const h of [{}, H(trial2), { authorization: 'Bearer nope' }]) {
      for (const p of ['/history', '/history.csv', '/history?days=all&q=warranty']) assert.equal((await api(T(trial, p), { headers: h })).status, 401, `${p} ${JSON.stringify(h).slice(0, 30)}`);
    }
    assert.equal((await api(T(trial, '/history'), { method: 'POST', headers: H(trial), body: '{}' })).status, 405);
  });

  test('a question asked in the Studio shows up with its answer, its sources and the viewer\'s local day', async () => {
    const a = await ask(trial, 'How long is the frame warranty?');
    assert.equal(a.status, 'grounded');
    const miss = await ask(trial, 'Do you sell hoverboards for my cat jo@example.com?');
    assert.ok(miss.refused);
    await ask(trial, 'What is the capital of France?');
    const r = await (await api(T(trial, '/history?days=7&tz=-300'), { headers: H(trial) })).json();
    assert.equal(r.botId, trial.trialId);
    assert.equal(r.range.tz, -300);
    assert.equal(r.total, 3);
    assert.equal(r.refused, 2);
    assert.equal(r.byDay.length, 7);
    assert.equal(r.byDay.at(-1).total + r.byDay.at(-2).total, 3);
    const w = r.items.find((i) => i.q === 'How long is the frame warranty?');
    assert.ok(w, JSON.stringify(r.items));
    assert.equal(w.outcome, 'answered');
    assert.equal(w.channel, 'studio');
    assert.ok(w.answer && w.answer.length > 10 && a.text.replace(/\s+/g, ' ').includes(w.answer.slice(0, 20)), `${w.answer} / ${a.text}`);
    assert.ok(w.files.length >= 1);
    const hov = r.items.find((i) => /hoverboards/.test(i.q));
    assert.equal(hov.q, 'Do you sell hoverboards for my cat [email]?', 'masked exactly as the question log stores it');
    assert.equal(hov.answer, null);
    assert.equal(r.items.find((i) => /capital of France/.test(i.q)).outcome, 'off_topic');
    assert.deepEqual(r.retention, { questionsDays: null, leadsDays: 90, allDays: 730 });
    // the Studio-tests switch, a filter, and the range options
    const none = await (await api(T(trial, '/history?days=7&tests=0'), { headers: H(trial) })).json();
    assert.equal(none.total, 0);
    const off = await (await api(T(trial, '/history?days=90&outcome=off_topic'), { headers: H(trial) })).json();
    assert.deepEqual([off.range.days, off.matched], [90, 1]);
    assert.equal((await (await api(T(trial, '/history?days=all'), { headers: H(trial) })).json()).range.all, true);
    assert.equal((await (await api(T(trial, '/history?days=5000'), { headers: H(trial) })).json()).range.days, 30, 'only 7, 30, 90 or all');
    // once written to the log (and with nothing left in this process's memory) it reads the same
    await flushQuestions();
    await kd.settle();
    const again = await (await api(T(trial, '/history?days=7&tz=-300&q=WARRANTY'), { headers: H(trial) })).json();
    assert.equal(again.matched, 1);
    assert.equal(again.items[0].answer, w.answer);
    // another bot sees none of it
    assert.equal((await (await api(T(trial2, '/history?days=7'), { headers: H(trial2) })).json()).total, 0);
  });

  test('the questions CSV downloads with the bot\'s name and the documented columns', async () => {
    const csv = await api(T(trial, '/history.csv?days=30&tz=-300'), { headers: H(trial) });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="knowbot-questions-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await csv.text()).replace(/^﻿/, '').trimEnd().split('\r\n');
    assert.equal(lines[0], 'date,time,channel,question,outcome');
    assert.equal(lines.length, 4);
    assert.ok(lines.some((l) => /^\d{4}-\d{2}-\d{2},\d{2}:\d{2},studio,How long is the frame warranty\?,answered$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /,What is the capital of France\?,off-topic$/.test(l)));
    assert.doesNotMatch(lines.join('\n'), /jo@example\.com/);
  });
});
