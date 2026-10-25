// Tiny in-browser BM25 over the corpus/ markdown files (via corpus/MANIFEST.json), used by browser-only.html
// when the KnowBot server is unreachable. Filenames match store paths, so citations are identical to server retrieval.
import { parseFrontmatter } from '../lib/knowbot.js?v=202610251959';

const STOP = new Set('a an and are as at be by can do does for from has have how i in is it its me my of on or our so that the this to was we what when where which who why will with you your'.split(' '));
const tok = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));

function chunk(body, max = 1400) {
  const parts = body.split(/\n(?=#{1,3} )/), out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p;
    while (cur.length > max * 1.5) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function buildLocalIndex(base = new URL('../corpus/', import.meta.url).href, onProgress) {
  const manifest = await (await fetch(new URL('MANIFEST.json', base))).json();
  const files = manifest.filter((m) => m.path.endsWith('.md') && m.path !== 'README.md');
  const docs = [];
  let done = 0;
  await Promise.all(files.map(async (m) => {
    try {
      const text = await (await fetch(new URL(m.path, base))).text();
      const { meta, body } = parseFrontmatter(text);
      chunk(body).forEach((c, i) => docs.push({ file_id: `${m.path}#${i}`, filename: m.path, title: meta.title || m.title, url: meta.url || m.url, text: c }));
    } catch { /* skip unreadable file */ }
    onProgress?.(++done / files.length);
  }));
  const df = new Map();
  let total = 0;
  for (const d of docs) {
    d.tf = new Map();
    const words = tok(`${d.title} ${d.title} ${d.text}`);
    d.len = words.length; total += words.length;
    for (const w of words) d.tf.set(w, (d.tf.get(w) || 0) + 1);
    for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  const N = docs.length, avg = total / (N || 1), k1 = 1.2, b = 0.75;
  return {
    size: N,
    search(query, k = 6) {
      const qs = [...new Set(tok(query))];
      const scored = [];
      for (const d of docs) {
        let s = 0;
        for (const w of qs) {
          const f = d.tf.get(w);
          if (!f) continue;
          const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
          s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
        }
        if (s > 0) scored.push([s, d]);
      }
      scored.sort((a, z) => z[0] - a[0]);
      const seen = new Set(), results = [];
      for (const [score, d] of scored) {         // one chunk per file keeps the source list diverse
        if (seen.has(d.filename)) continue;
        seen.add(d.filename);
        results.push({ file_id: d.file_id, filename: d.filename, title: d.title, url: d.url, score: +score.toFixed(4), text: d.text });
        if (results.length >= k) break;
      }
      return { source: 'local-browser', results };
    },
  };
}
