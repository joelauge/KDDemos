#!/usr/bin/env node
// Asks a list of questions through both evidence paths and prints one row per question and path: today's search
// (vector + hybrid under the trial's tag filter, the Studio's similarity floor) and the evidence selector (attendd).
// Read-only: it only searches and reads; nothing is written to the store. Not part of CI.
//
// The answer step is the deterministic keyword selector (lib finalizeSelection with no model reply), so the quote
// counts compare the evidence, not a model's choices (production uses the research agent on either path).
//
// Usage:
//   KNOWDRIVE_API_KEY=… node scripts/evidence-compare.mjs --store vs_… --scope trial:tr_… [--attendd http://127.0.0.1:7071]
//     [--questions file.txt] [--floor 0.7] [--json]
// Env: KNOWDRIVE_BASE_URL (default https://knowdrive.ai), KNOWDRIVE_API_KEY, ATTENDD_URL, KNOWBOT_EVIDENCE_WEAK.
import { readFileSync } from 'node:fs';
import * as lib from '../lib/knowbot.js';
import { normHit } from '../server/trials.mjs';
import { createEvidenceSelector } from '../server/evidence.mjs';

const args = process.argv.slice(2);
const opt = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const flag = (name) => args.includes(`--${name}`);
const store = opt('store', 'vs_97c857474b1f4e8892b134c283cf9849');
const scopeTag = opt('scope', 'trial:tr_6ajxk3z2gxkzrbwi');
const floor = Number(opt('floor', 0.7));
const base = String(process.env.KNOWDRIVE_BASE_URL || 'https://knowdrive.ai').replace(/\/+$/, '');
const key = process.env.KNOWDRIVE_API_KEY;
const attenddUrl = opt('attendd', process.env.ATTENDD_URL || 'http://127.0.0.1:7071');
const EXCLUDE = ['kind:trial-spec', 'kind:config', 'questions'];
const DEFAULT_QUESTIONS = [
  'What is your return policy?',
  'How long does shipping take?',
  'Do you ship internationally?',
  'What are your store hours?',
  'How much is the Tales of the Valiant Rules Pack?',
  'How do I contact customer support?',
  'Can I cancel my order?',
  'What is the capital of Australia?',
];
const questions = opt('questions') ? readFileSync(opt('questions'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : DEFAULT_QUESTIONS;
if (!key) { console.error('KNOWDRIVE_API_KEY is not set'); process.exit(2); }

async function search(query, mode, k) {
  const res = await fetch(`${base}/api/v1/vector_stores/${encodeURIComponent(store)}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ query, max_num_results: k, mode, text: 'raw', filter: { all_of: [scopeTag], none_of: EXCLUDE }, fields: 'tags,uri,score,text,file_id,metadata' }),
  });
  if (!res.ok) throw new Error(`${mode} search HTTP ${res.status}`);
  return ((await res.json()).data || []).map((d) => normHit(d, mode)).filter((h) => h.text && h.tags?.includes(scopeTag) && !EXCLUDE.some((t) => h.tags.includes(t)));
}

/** Today's path, as the Studio runs it: vector hits over the floor (hybrid-with-distance when vector is empty) + 3 hybrid. */
async function searchPath(question) {
  const [v0, hyb] = await Promise.all([search(question, 'vector', 12), search(question, 'hybrid', 8)]);
  const vector = (v0.length ? v0 : hyb.filter((h) => h.similarity != null)).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  const top = vector.length ? vector[0].similarity ?? 0 : 0;
  if (top < floor) return { status: `refused (top ${top.toFixed(3)} < floor)`, sources: [] };
  const kept = vector.filter((h) => (h.similarity ?? 0) >= floor).slice(0, 6);
  for (const h of hyb.slice(0, 3)) if (kept.length < 6 && !kept.some((x) => x.fileId === h.fileId && x.text === h.text)) kept.push(h);
  return { status: `ok (top ${top.toFixed(3)})`, sources: kept.map((h) => ({ file_id: h.fileId, filename: h.filename, title: h.filename.split('/').pop(), text: h.text, score: h.similarity })) };
}

const selector = createEvidenceSelector({ KNOWBOT_EVIDENCE: 'attend', ATTENDD_URL: attenddUrl, KNOWBOT_EVIDENCE_WEAK: process.env.KNOWBOT_EVIDENCE_WEAK || '' }, { log: (m) => console.error(m), timeoutMs: 25000 });
async function attendPath(question) {
  const sel = await selector.select({ store, question, scopes: [{ tags_all: [scopeTag], tags_none: EXCLUDE }] });
  if (!sel) return { status: 'selector unavailable', sources: null };
  return { status: sel.status, sources: sel.sources, receipt: sel.receipt?.digest };
}

const complete = async () => ''; // no model: the keyword selector picks the lines
async function answer(question, sources, evidenceOnly) {
  if (!sources?.length) return { quotes: 0, files: [], refused: true };
  const r = await lib.answerFromSources({ question, results: sources, complete, mode: 'select', voice: false, evidenceOnly, k: evidenceOnly ? sources.length : 6 });
  const fin = r.fin;
  return { quotes: fin.refused ? 0 : (fin.selected || []).length || (fin.citations || []).length, files: [...new Set((fin.citations || []).map((c) => String(c.filename).split('/').pop()))], refused: !!fin.refused };
}

const rows = [];
for (const q of questions) {
  for (const [name, run, only] of [['search', searchPath, false], ['selector', attendPath, true]]) {
    const t0 = performance.now();
    let row;
    try {
      const p = await run(q);
      const ms = Math.round(performance.now() - t0);
      const a = await answer(q, p.sources, only);
      row = { question: q, path: name, status: p.status, passages: p.sources?.length ?? 0, quotes: a.quotes, refused: a.refused, files: a.files.join(', ') || '-', ms };
    } catch (e) {
      row = { question: q, path: name, status: `error: ${e.message}`, passages: 0, quotes: 0, refused: true, files: '-', ms: Math.round(performance.now() - t0) };
    }
    rows.push(row);
  }
}
if (flag('json')) console.log(JSON.stringify(rows, null, 2));
else {
  console.log('| question | path | status | passages | quotes | files cited | ms |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.question} | ${r.path} | ${r.status} | ${r.passages} | ${r.refused ? 'refused' : r.quotes} | ${r.files} | ${r.ms} |`);
}
