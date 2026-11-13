// Shared helpers for the trials*.test.mjs files (KnowBot Studio server tests). Fakes only: never touches knowDrive or a
// real model. Each test file runs in its own process, so the module state here (the IP counter) is per file.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer, internalSecret } from '../server.mjs';
import { startFakeKnowDrive } from './fake-knowdrive.mjs';
import { startFakeLLM } from './fake-llm.mjs';

delete process.env.KNOWDRIVE_API_KEY; // isolation rule 7.1: nothing here may reach a real store
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const DAY = 86400000;
export const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 10;
export const nextIp = () => `198.51.100.${ipSeq++ % 250}`;

/** Parse a finished SSE body into [{id, event, data}]. */
export function parseSSE(text) {
  return text.split('\n\n').map((fr) => {
    const ev = /^event: (.*)$/m.exec(fr)?.[1];
    if (!ev) return null;
    return { id: Number(/^id: (.*)$/m.exec(fr)?.[1]), event: ev, data: JSON.parse(/^data: (.*)$/m.exec(fr)?.[1] || 'null') };
  }).filter(Boolean);
}

/** A live SSE reader: frames accumulate in `events`; waitFor(pred) resolves with the first match. */
export async function openSSE(url, headers, init = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal, ...init });
  const events = [];
  const waiters = [];
  let buf = '';
  let comments = 0;
  (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const fr = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^: ping/m.test(fr)) comments++;
          const p = parseSSE(`${fr}\n\n`)[0];
          if (!p) continue;
          events.push(p);
          for (const w of [...waiters]) if (w.pred(p)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(p); }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    res, events, get comments() { return comments; },
    waitFor(pred, ms = 15000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        // the timer is cleared once the event arrives: left running it kept the test process alive for up to `ms` after
        // the last test (about 15 s per file)
        const w = { pred, resolve: (p) => { clearTimeout(timer); resolve(p); } };
        waiters.push(w);
        const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`SSE wait timed out; saw ${events.map((e) => e.event).join(',')}`)); } }, ms);
      });
    },
    close() { ac.abort(); },
  };
}

// The fake knowDrive's pipeline speed when a test does not pass its own. 3 keeps every stage long enough to be seen in
// order by the event stream (trials.test.mjs "6/7" asserts the order); files whose assertions only wait for "ready"
// call useFakeSpeed(FAST_SPEED) once, before their servers boot, and spend a quarter of the time waiting.
export const FAST_SPEED = 12;
let defaultSpeed = 3;
export function useFakeSpeed(n) { defaultSpeed = n; }

export async function boot({ env = {}, studio = {}, speed = defaultSpeed, kdKey = true, kdOpts = {} } = {}) {
  const kd = await startFakeKnowDrive({ speed, narrowScope: 'all', ...kdOpts }); // production: narrow-filter vector search can be empty
  const llm = await startFakeLLM({ slowMs: 9000 });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-trials-'));
  const clock = { skew: 0 };
  const fullEnv = {
    KNOWDRIVE_BASE_URL: kd.url, ...(kdKey ? { KNOWDRIVE_API_KEY: 'fake-key' } : {}), KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials', KNOWBOT_STUDIO_SAMPLE_MODE: 'live',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen',
    KNOWBOT_KD_ACCOUNTS: 'off', // the checkout and convert tests here are the unlinked path; server/test/kdaccount.test.mjs covers the linked one
    ...env,
  };
  const kb = createKnowBotServer({ root: ROOT, dataDir, quiet: true, watch: false, trustProxy: true, env: fullEnv,
    studio: { sweep: false, now: () => Date.now() + clock.skew, pingMs: 200, pollMs: 40, pollSlowMs: 150, pollIdleMs: 400, ...studio } });
  await new Promise((r) => kb.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${kb.server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  return {
    kd, llm, kb, base, api, clock,
    async close() { await new Promise((r) => kb.server.close(() => r())); await kd.close(); await llm.close(); await fsp.rm(dataDir, { recursive: true, force: true }); },
  };
}

/** Helpers bound to one server. */
export function client(S) {
  const h = (t, ip, extra = {}) => ({ authorization: `Bearer ${t.token}`, 'x-forwarded-for': ip || t.ip, ...extra });
  return {
    async trial() {
      const ip = nextIp();
      const r = await S.api('/api/studio/trials', { method: 'POST', headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 201);
      return { ...(await r.json()), ip };
    },
    h,
    json: (t, p, method = 'GET', body) => S.api(`/api/studio/trials/${t.trialId}${p}`, { method, headers: h(t, null, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }),
    upload: (t, name, bytes, ip) => S.api(`/api/studio/trials/${t.trialId}/files`, { method: 'POST', headers: h(t, ip, { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' }), body: bytes }),
    async stream(t, p, body) {
      const r = await S.api(`/api/studio/trials/${t.trialId}${p}`, { method: 'POST', headers: h(t, null, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
      assert.equal(r.status, 200, `${p} status`);
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      return parseSSE(await r.text());
    },
    async waitReady(t, n, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const j = await (await this.json(t, '/files')).json();
        if (j.files.length >= n && j.files.every((f) => f.stage === 'ready' || f.stage === 'failed')) return j.files;
        await sleep(60);
      }
      throw new Error('files never became ready');
    },
  };
}

/** A raw upload whose body is never sent: the server must answer from the headers alone. */
export function headersOnlyUpload(base, t, { len, name = 'big.pdf', ip }) {
  const u = new URL(`${base}/api/studio/trials/${t.trialId}/files`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'x-forwarded-for': ip || t.ip, 'x-filename': name, 'content-length': String(len), 'content-type': 'application/pdf' } });
    req.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: b ? JSON.parse(b) : null, req }); }); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
    req.write('%PDF-1.7\n'); // the rest of the body is never sent
    setTimeout(() => resolve({ status: 'pending', req }), 400);
  });
}

/** A tiny Shopify-shaped store on 127.0.0.1 (products.json, a refund policy, an FAQ page). slow: n extra product pages, each slow. */
export async function fakeShop({ slow = 0, slowMs = 120 } = {}) {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  let price = '1299.00', ogPage = false;
  const routes = {
    '/': () => [200, 'text/html', page('Lumen Test Shop', '<p>Bikes.</p>').replace('</head>', '<link href="https://cdn.shopify.com/s/theme.css"><script>Shopify.currency={"active":"USD"};</script><meta property="og:site_name" content="Lumen Test Shop"></head>')],
    '/products.json': (u, base) => [200, 'application/json', JSON.stringify({ products: Number(u.searchParams.get('page') || 1) > 1 ? [] : [
      { id: 1, title: 'Trail Pro', handle: 'trail-pro', vendor: 'Lumen', product_type: 'Bikes', tags: [], body_html: '<p>A carbon trail bike with a lifetime frame warranty.</p>', variants: [{ title: 'Default Title', price, sku: 'TP-1', available: true }],
        images: [{ src: `${base}/cdn/trail-pro.jpg` }] },
      { id: 2, title: 'Commuter Lite', handle: 'commuter-lite', vendor: 'Lumen', product_type: 'Bikes', tags: [], body_html: '<p>An aluminium city bike with mudguards.</p>', variants: [{ title: 'Default Title', price: '799.00', sku: 'CL-1', available: true }] },
    ] })],
    '/policies/refund-policy': () => [200, 'text/html', page('Refund policy', '<p>Unridden bikes can be returned within 30 days of delivery for a full refund.</p>')],
    '/pages/faq': () => [200, 'text/html', page('FAQ', '<details><summary>Do you ship to Canada?</summary><p>Yes, we ship to Canada for a flat $25 fee.</p></details>')],
    '/sitemap.xml': (u, base) => [200, 'application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/pages/faq</loc></url>${
      Array.from({ length: slow }, (_, i) => `<url><loc>${base}/products/slow-${i + 1}</loc></url>`).join('')}</urlset>`],
  };
  const hits = new Map();
  const s = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
    const sm = /^\/products\/slow-(\d+)$/.exec(u.pathname);
    if (sm) {
      await sleep(slowMs);
      const n = sm[1];
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>Slow ${n}</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `Slow Bike ${n}`, offers: { '@type': 'Offer', price: '100.00', priceCurrency: 'USD' } })}</script></head><body><main><h1>Slow Bike ${n}</h1><p>Slow bike number ${n} is a steel touring bike.</p></main></body></html>`);
    }
    // the Commuter Lite page (with its og:image) exists only once ogPage is on: after the import, as for an older import
    if (u.pathname === '/products/commuter-lite' && ogPage) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page('Commuter Lite', '<p>An aluminium city bike.</p>').replace('</head>', '<meta property="og:image" content="/cdn/commuter-lite.jpg"></head>'));
    }
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    const [status, type, body] = r(u, `http://127.0.0.1:${s.address().port}`);
    res.writeHead(status, { 'content-type': type }); res.end(body);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${s.address().port}`, hits, setPrice: (p) => { price = p; }, setOgPage: (on) => { ogPage = !!on; }, close: () => { s.closeAllConnections?.(); return new Promise((r) => s.close(r)); } };
}
