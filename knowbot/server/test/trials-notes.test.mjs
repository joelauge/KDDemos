// KnowBot Studio server: the research step, time left, notes and the Teach form, Start over, answer failures.
// Split from trials.test.mjs along its describe boundaries; shared helpers live in trials-helpers.mjs.
// Fakes only: never touches knowDrive or a real model.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer, internalSecret } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';
import { etaOf, parseIntent, validatePatch, defaultSpec, normHit, sniffOk, deriveStage, findOffset, hitAllowed, keepRelevantLines, LINE_MARGIN, topicCase, GENERIC_HEADING_RE,
  splitSentences, citeQuotedLines, quotedLineParts, storeIntentOf, sourceSegments, stripSourceLines, lastSourceUrl, answerCheck, cleanTopic, topicsOf, sectionLine, starterGrammarOk, genericNumbered, titleWords, insightKey, refusalReasonOf } from '../trials.mjs';
import { requireCitations, isCourtesy } from '../../lib/knowbot.js';
import { atomize, extractText, startFakeKnowDrive as startKD } from './fake-knowdrive.mjs';
import { NOT_IN_DATA } from '../../lib/knowbot.js';
import { ROOT, DAY, yyyymmdd, sleep, nextIp, parseSSE, openSSE, boot, client, headersOnlyUpload, fakeShop, useFakeSpeed, FAST_SPEED } from './trials-helpers.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1: nothing here may reach a real store
useFakeSpeed(FAST_SPEED);              // nothing here asserts the order of ingest stages (trials-helpers.mjs)

describe('Studio answers with the research step (a fake agent in place of Claude)', () => {
  let S, c;
  const seen = [];
  /** Quotes the bundle's name line and its price line, and adds a summary built from them. */
  const agent = async (params) => {
    seen.push(params);
    const all = JSON.stringify(params.messages);
    const name = Number(/L(\d+) Ultimate Bundle \(Brown\)/.exec(all)?.[1] || 0);
    if (!name) return { content: [{ type: 'tool_use', id: 'a1', name: 'answer', input: { found: false, quotes: [] } }] };
    return { content: [{ type: 'tool_use', id: 'a1', name: 'answer', input: { found: true, quotes: [{ from: name, to: name + 1 }], summary: `The Ultimate Bundle (Brown) is $319.99, down from $361.90 [L${name + 1}].` } }] };
  };
  agent.model = 'fake-research';
  before(async () => { S = await boot({ studio: { researchAgent: agent } }); c = client(S); });
  after(async () => { await S.close(); });

  test('a price on the line under the product name is quoted as one span, with a verified summary and its proof', async () => {
    const t = await c.trial();
    const page = '# Ultimate Bundles\n\nComplete Game Master Screen bundles with everything you need for epic campaigns.\n\nUltimate Bundle (Brown) - Complete Game Master Screen Kit for D&D, Pathfinder & TTRPGs\n\n$319.99 $361.90\n\nSave $41.91\n';
    assert.equal((await c.upload(t, 'ultimate-bundles.md', Buffer.from(page))).status, 201);
    await c.waitReady(t, 1);
    const ev = await c.stream(t, '/ask', { question: "What's the price of the ultimate bundle?" });
    const fin = ev.find((e) => e.event === 'final').data;
    assert.equal(fin.refused, false, JSON.stringify(fin.why));
    assert.match(fin.text, /The Ultimate Bundle \(Brown\) is \$319\.99, down from \$361\.90 \[1\]/);
    assert.match(fin.text, /\$319\.99 \$361\.90/);
    const sel = ev.find((e) => e.event === 'selected').data;
    assert.equal(sel.model, 'fake-research');
    assert.equal(sel.summary, true);
    assert.equal(sel.lines.length, 2);
    const summaryClaim = fin.proof?.claims?.find((x) => x.summary) || fin.claims?.find?.((x) => x.summary);
    if (summaryClaim) assert.equal(summaryClaim.verified, true);
    assert.ok(seen.length >= 1);
    assert.match(seen[0].system, /more than one passage/);
  });
});

describe('time left: knowDrive store progress (#886) becomes the eta event', () => {
  test('etaOf: ages the band from computed_at, nulls the point while estimating/stalled, null without progress', () => {
    const t = 1_800_000_000_000, at = t / 1000 - 60;
    assert.equal(etaOf(null, t), null);
    assert.equal(etaOf({}, t), null);
    const d = etaOf({ state: 'draining', eta_seconds: 300, eta_low_seconds: 200, eta_high_seconds: 500, atoms_estimated_remaining: 90, computed_at: at }, t);
    assert.deepEqual({ ...d }, { state: 'draining', seconds: 240, low: 140, high: 440, atomsLeft: 90, at: at * 1000 });
    assert.equal(etaOf({ state: 'draining', eta_seconds: 30, eta_low_seconds: 10, eta_high_seconds: 50, computed_at: at }, t).low, 0, 'never below zero');
    assert.equal(etaOf({ state: 'stalled', eta_seconds: 100, computed_at: at }, t).seconds, null);
    assert.equal(etaOf({ state: 'estimating', eta_seconds: null, computed_at: at }, t).seconds, null);
  });

  test('hello and eta events carry the store estimate while a file learns, rounded; null once nothing learns', async () => {
    const S = await boot({ studio: { etaMaxAgeMs: 0 }, kdOpts: { progressOverride: { state: 'draining', eta_seconds: 400, eta_low_seconds: 290, eta_high_seconds: 610, atoms_estimated_remaining: 1200, computed_at: Math.floor(Date.now() / 1000) } } });
    try {
      const c = client(S);
      const t = await c.trial();
      const sse = await openSSE(`${S.base}/api/studio/trials/${t.trialId}/events`, c.h(t));
      const hello = await sse.waitFor((e) => e.event === 'hello');
      assert.equal(hello.data.eta, null, 'no files: no estimate');
      const up = await c.upload(t, 'stuck.md', Buffer.from('# Stuck\n\nSTALL this file never finishes extracting.\n'));
      assert.equal(up.status, 201);
      const e1 = await sse.waitFor((e) => e.event === 'eta' && e.data && e.data.state === 'draining', 8000);
      assert.equal(e1.data.learning, 1);
      assert.ok(e1.data.low % 15 === 0 && e1.data.high % 15 === 0, 'rounded to 15 s');
      assert.ok(e1.data.low <= e1.data.seconds && e1.data.seconds <= e1.data.high);
      S.kd.setProgress({ state: 'stalled', eta_seconds: null, eta_low_seconds: null, eta_high_seconds: null, atoms_estimated_remaining: 1200, computed_at: Math.floor(Date.now() / 1000) });
      const e2 = await sse.waitFor((e) => e.event === 'eta' && e.data && e.data.state === 'stalled', 8000);
      assert.equal(e2.data.seconds, null);
      const fid = (await up.json()).file.id;
      assert.ok([200, 204].includes((await c.json(t, `/files/${fid}`, 'DELETE')).status));
      await sse.waitFor((e) => e.event === 'eta' && e.data === null, 8000);
      sse.close();
    } finally { await S.close(); }
  });
});

describe("Didn't get the answer you needed? POST /trials/:id/notes", () => {
  for (const [label, opts] of [['live samples', {}], ['shared samples, strict scope', { env: { KNOWBOT_STUDIO_SAMPLE_MODE: 'shared' }, kdOpts: { honorScope: true }, samples: true }]])
  test(`saves the owner answer as a tagged source file, and the bot then answers from it (${label})`, async () => {
    const S = await boot(opts);
    try {
      const c = client(S);
      const t = await c.trial();
      if (opts.samples) { assert.ok([200, 201, 202].includes((await c.json(t, '/samples', 'POST', {})).status)); await S.kd.settle(); await sleep(400); }
      const Q = 'Do you take walk-ins?';
      const before = (await c.stream(t, '/ask', { question: Q })).find((e) => e.event === 'final')?.data;
      assert.ok(!before || before.refused || before.status !== 'grounded', 'no answer before the note');
      assert.equal((await c.json(t, '/notes', 'POST', { question: Q, answer: '' })).status, 400);
      const r = await c.json(t, '/notes', 'POST', { question: Q, answer: 'Yes, we take walk-ins Monday to Friday, 9am to noon. Afternoons are by appointment.', tags: ['Hours', 'booking!', 'hours'] });
      assert.equal(r.status, 201);
      const j = await r.json();
      assert.deepEqual(j.tags, ['hours', 'booking']);
      assert.match(j.file.name, /^notes\/do-you-take-walk-ins\.md$/);
      const row = [...S.kd.files.values()].find((f) => f.filename.endsWith('notes/do-you-take-walk-ins.md'));
      assert.ok(row && row.tags.includes('src:note') && row.tags.includes('topic:hours') && row.tags.includes(`trial:${t.trialId}`));
      // GET /notes: the tags this bot already uses, from knowDrive, most used first (offered again in the form)
      assert.equal((await c.json(t, '/notes', 'POST', { question: 'Can I book online?', answer: 'Yes, book online any time from our website.', tags: ['hours', 'online'] })).status, 201);
      const tg = await (await c.json(t, '/notes', 'GET')).json();
      assert.deepEqual(tg.tags.map((x) => x.tag), ['hours', 'booking', 'online']);
      assert.equal(tg.tags[0].count, 2);
      const other = await c.trial();
      assert.deepEqual((await (await c.json(other, '/notes', 'GET')).json()).tags, [], 'another bot sees only its own tags');
      // the file list carries each file's tags for its row in Sources
      const fl = await (await c.json(t, '/files', 'GET')).json();
      const noteRow = (fl.files || fl).find((f) => f.name === 'notes/do-you-take-walk-ins.md');
      assert.deepEqual(noteRow?.topics, ['hours', 'booking'], JSON.stringify(noteRow));
      await S.kd.settle();
      await sleep(300);
      const after = (await c.stream(t, '/ask', { question: Q })).find((e) => e.event === 'final').data;
      assert.equal(after.refused, false, `answered: ${JSON.stringify(after).slice(0, 300)}`);
      assert.match(after.text, /walk-ins/i);
    } finally { await S.close(); }
  });
});

describe('Teach form: pages a note links to are read and added as sources', () => {
  test('a linked page becomes a source with the note tags; a broken link is reported, the note still saved', async () => {
    const site = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
      if (req.url === '/collections/weekly-games') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><title>Weekly games</title></head><body><main><h1>Weekly games</h1><p>The Everlasting Rime runs every Thursday at 7pm Eastern on Discord, with three drop-in seats each week.</p></main></body></html>');
      }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>');
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${site.address().port}`;
    const S = await boot({ studio: { storeNet: { allowAddresses: ['127.0.0.1'], allowPorts: 'any', paceMs: 0 } } });
    try {
      const c = client(S);
      const t = await c.trial();
      const r = await c.json(t, '/notes', 'POST', { question: 'Does Jason run remote games?', tags: ['weekly-live-games'],
        answer: `Yes! See the weekly games page: ${base}/collections/weekly-games. Old link: ${base}/gone.` });
      assert.equal(r.status, 201);
      const j = await r.json();
      assert.equal(j.links.length, 2);
      assert.equal(j.links[0].ok, true, JSON.stringify(j.links[0]));
      assert.equal(j.links[0].title, 'Weekly games');
      assert.match(j.links[0].file.name, /^notes\/links\/127\.0\.0\.1-weekly-games\.md$/);
      assert.deepEqual([j.links[1].ok, j.links[1].reason], [false, 'That page was not found.']);
      const row = [...S.kd.files.values()].find((f) => f.filename.endsWith('notes/links/127.0.0.1-weekly-games.md'));
      assert.ok(row && row.tags.includes('src:note-link') && row.tags.includes('topic:weekly-live-games') && row.tags.includes(`trial:${t.trialId}`));
      assert.match(row.text, /Thursday at 7pm Eastern/);
      assert.match(row.text, new RegExp(`Source: ${base.replace(/[.]/g, '\\.')}/collections/weekly-games`));
      await S.kd.settle();
      await sleep(300);
      const a = (await c.stream(t, '/ask', { question: 'When does The Everlasting Rime run every Thursday on Discord?' })).find((e) => e.event === 'final').data;
      assert.equal(a.refused, false, JSON.stringify(a).slice(0, 300));
      assert.match(a.text, /Thursday/);
      assert.ok(a.citations.some((x) => /notes\/links\/127\.0\.0\.1-weekly-games\.md/.test(x.file || '')), JSON.stringify(a.citations.map((x) => x.file)));
    } finally { await S.close(); await new Promise((r) => site.close(r)); }
  });
});

describe('Start over with many files', () => {
  test('answers quickly (deletes in parallel, the rest in the background) and every file of the trial is gone', async () => {
    const S = await boot({ studio: { startOverWaitMs: 300 } });
    try {
      const c = client(S);
      const t = await c.trial();
      for (let i = 0; i < 24; i++) assert.equal((await c.upload(t, `page-${i}.md`, Buffer.from(`# Page ${i}\n\nThe shop opens at ${i % 12 + 1}am on day ${i}.\n`))).status, 201);
      await S.kd.settle();
      const mine = () => [...S.kd.files.values()].filter((f) => f.tags.includes(`trial:${t.trialId}`) && f.tags.includes('kind:trial')).length;
      assert.ok(mine() >= 24);
      S.kd.setLatency?.(250);
      const t0 = Date.now();
      const r = await c.json(t, '', 'DELETE');
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.ok(Date.now() - t0 < 3000, `answered in ${Date.now() - t0} ms`);
      assert.ok(j.total >= 24);
      for (let i = 0; i < 100 && mine() > 0; i++) await sleep(100);
      assert.equal(mine(), 0, 'every file deleted');
      assert.equal((await c.json(t, '/files')).status === 200, false, 'the trial is gone');
    } finally { await S.close(); }
  });
});

// ------------------------------------------------------------------------------------------------ answer failures
describe('answer failures say where they happened (step + reference); past the search they answer "not found"', () => {
  for (const [step, recovered] of [['select', true], ['quote', true], ['search', false]]) {
    test(`a fault at "${step}" → ${recovered ? 'a not-found answer with failure {step, ref}' : 'an error event naming the step, with a ref'}`, async () => {
      const S = await boot({ studio: { faultAt: step } });
      try {
        const c = client(S);
        const t = await c.trial();
        await (await c.json(t, '/samples', 'POST', { set: 'lumen-bikes' })).json();
        await c.waitReady(t, 4);
        const ev = await c.stream(t, '/ask', { question: 'How long is the frame warranty?' });
        if (recovered) {
          const fin = ev.find((e) => e.event === 'final')?.data;
          assert.ok(fin, 'a final answer, not an error');
          assert.equal(fin.refused, true);
          assert.equal(fin.text, "Looks like we don't have that in our files.");
          assert.equal(fin.failure.step, step);
          assert.match(fin.failure.ref, /^[0-9a-f]{8}$/);
          assert.ok(!ev.some((e) => e.event === 'error'));
        } else {
          const err = ev.find((e) => e.event === 'error')?.data;
          assert.ok(err, 'an error event');
          assert.equal(err.step, 'search');
          assert.match(err.ref, /^[0-9a-f]{8}$/);
          assert.match(err.message, /couldn’t be searched just now/);
        }
      } finally { await S.close(); }
    });
  }
});
