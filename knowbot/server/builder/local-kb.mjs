// Offline KnowBot product knowledge base for the tool-using Builder: a small lexical (BM25-style) search over the
// studio/kb/*.md sections. Used in tests and as the fallback when the knowDrive-backed KB (kb.mjs createBuilderKb) is
// not usable. Same result shape as kb.mjs search(): { sources:[{ n, name, title, section, page, text, similarity }], top }.
//
// The pricing passage is always present (owner rule 2: building and testing are free with no account; launching is a
// KnowDrive account at $549/month or $5,490/year (one plan: Website, KnowBot number and Email, every feature included),
// first 30 days free, credit card required at signup, cancel anytime;
// studio/kb/pricing-and-trial.md is the full source). Only the checkout URL is configurable.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_KB_DIR = path.resolve(__dirname, '..', '..', 'studio', 'kb');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function pricingPassage({ price = 549, yearly = 5490, trialDays = 30, checkoutUrl = '' } = {}) {
  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
  return { name: 'pricing', title: 'KnowBot pricing', section: 'The price to launch', page: checkoutUrl || null,
    text: `Building and testing a bot in KnowBot Studio is free and needs no account. To launch, you start a KnowDrive account at ${money(price)} per month`
      + `${yearly ? `, or ${money(yearly)} per year` : ''}. One plan includes all three tools: Website, KnowBot number and Email, with every feature. The first ${trialDays} days are free. A credit card is required at signup. You can cancel anytime.` };
}

/** Sections of studio/kb/*.md: [{ name, title, section, page, text }]. Missing folder -> []. */
export function loadSections(dir = LOCAL_KB_DIR) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9-]{0,60}\.md$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    let t = '';
    try { t = readFileSync(path.join(dir, name), 'utf8').replace(/\r/g, ''); } catch { continue; }
    const title = /^#\s+(.+)$/m.exec(t)?.[1].trim() || name.replace(/\.md$/, '');
    const parts = t.split(/^##\s+/m).slice(1);
    for (const p of parts) {
      const [head, ...body] = p.split('\n');
      const page = /^Source:\s*(\S+)\s*$/im.exec(body.join('\n'))?.[1] || null;
      const text = oneLine(body.join('\n').replace(/^\s*Source:\s*\S+\s*$/gim, '').replace(/TODO\(owner\)[^.]*\.?/g, '').replace(/[#*_`>]/g, ' '));
      if (text) out.push({ name, title, section: head.trim(), page, text });
    }
  }
  return out;
}

const STOP = new Set('a an the and or but of to in on at for from by with about as is are was were be been do does did can could will would should i you it its my your our we me how what which who why when where this that there their them they any some much many'.split(' '));
const SYN = { cost: 'price', costs: 'price', pricing: 'price', prices: 'price', priced: 'price', pay: 'price', charge: 'price', fee: 'price', fees: 'price', expensive: 'price', cheap: 'price', monthly: 'month', mo: 'month', cancellation: 'cancel', signup: 'account' };
const stem = (w) => w.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, '') || w;
export const terms = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map((w) => SYN[w] || stem(w));

/** createLocalKb({ sections?, dir?, pricing? }) -> { search(question, {k}) -> {sources, top, mode} } */
export function createLocalKb(o = {}) {
  const base = Array.isArray(o.sections) ? o.sections : loadSections(o.dir);
  const all = [pricingPassage(o.pricing || {}), ...base.filter((s) => s && s.text)];
  const index = all.map((d) => { const tf = new Map(); const t = terms(`${d.title} ${d.section || ''} ${d.section || ''} ${d.text}`); for (const w of t) tf.set(w, (tf.get(w) || 0) + 1); return { d, tf, len: t.length }; });
  const df = new Map(); for (const x of index) for (const w of x.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const avg = index.reduce((s, x) => s + x.len, 0) / Math.max(1, index.length);
  async function search(question, { k = 4 } = {}) {
    const q = [...new Set(terms(question))];
    const N = index.length;
    const scored = index.map((x) => {
      let s = 0;
      for (const w of q) { const f = x.tf.get(w) || 0; if (!f) continue; const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * x.len / avg)); }
      return { x: x.d, s };
    }).filter((r) => r.s > 0.5).sort((a, b) => b.s - a.s).slice(0, k);
    const max = scored[0]?.s || 1;
    const sources = scored.map((r, i) => ({ n: i + 1, ...r.x, similarity: Math.round((0.6 + 0.4 * r.s / max) * 10000) / 10000 }));
    return { sources, top: sources[0]?.similarity ?? null, mode: sources.length ? 'lexical' : 'none' };
  }
  return { search, sections: all };
}
