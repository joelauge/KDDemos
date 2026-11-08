// KnowBot Studio: "Enter a Store URL" importer (server side). Zero dependencies (node: built-ins only).
//
// ============================================================================================================
// INTEGRATION HOOK (not wired yet; trials.mjs and the Studio UI are owned elsewhere)
// ============================================================================================================
//
// Exports used by trials.mjs:
//
//   importStore(url: string, {
//       remainingBytes: number,           // QUOTA_BYTES - usageOf(T, files).bytes   (required in production)
//       signal?: AbortSignal,             // abort on req 'close'
//       onEvent?: (event: string, data: object) => void,   // progress, see "SSE events" below
//       maxProducts?: 2000, maxPages?: 200, maxTotalBytes?: 20 MB,
//       net?: { ...createStoreFetcher options }   // tests only: allowAddresses, allowPorts:'any', resolve, timeouts
//   }) → Promise<{
//       platform: 'shopify'|'magento'|'squarespace'|'woocommerce'|'generic', api: boolean, base: string, name: string|null,
//       files: [{ name: string, bytes: Buffer, mime: 'text/markdown', docs: number, size: number }],
//       counts: { products, pages, policies, faqs }, capped: object|null, skipped: { robots, failed, budget }, warnings: string[] }>
//   It throws StoreImportError { code, message, status } after emitting `error`.
//
// Route (owner A adds it next to `sub === 'samples'` in studio.handle, and adds `store` to the server.mjs isStream
// regex: /^\/api\/studio\/trials\/[^/]+\/(?:events|setup|ask|store)/):
//
//   POST /api/studio/trials/:id/store      Authorization: Bearer <token>     body {"url":"https://shop.example.com"}
//   → SSE (4.3 headers, id/event/data frames, `: ping` every 15 s, ends with `event: done`)
//
//   if (sub === 'store') {
//     allow('POST');
//     limitTrialAndIp(T, req, 'store imports', 6, 20, 'store imports');        // suggested: 6/h per trial, 20/h per IP
//     const body = await readBody(req);                                        // {url} only; 400 bad_request otherwise
//     const files = await filesOf(T, { maxAgeMs: 0 });
//     const remaining = QUOTA_BYTES - usageOf(T, files).bytes;
//     if (remaining <= 0) fail(413, 'quota', 'Your trial is full. Remove a file to import a store.');
//     open SSE; const ac = new AbortController(); req.on('close', () => ac.abort());
//     let n = 0; const send = (ev, data) => writeFrame(res, ++n, ev, data);
//     try {
//       const r = await importStore(body.url, { remainingBytes: remaining, signal: ac.signal, onEvent: send });
//       const rows = [];
//       for (const f of r.files) {                       // the existing upload path, unchanged: tags, quota, expires
//         if (!sniffOk('md', f.bytes)) continue;         // always true (UTF-8, no NUL) but keeps the 4.4.5 rule
//         rows.push(await uploadInto(T, { name: f.name, bytes: f.bytes, mime: f.mime, extraTags: ['src:store'] }));
//         send('uploaded', { file: rows.at(-1) });
//       }
//       kickPoller(T);
//       const all = await filesOf(T);
//       send('done', { files: rows, usage: usageOf(T, all), platform: r.platform, counts: r.counts, capped: r.capped });
//     } catch (e) { send('error', { code: e.code || 'upstream', message: e.message }); send('done', { files: [] }); }
//     finally { res.end(); }
//   }
//
//   Note: importStore itself emits `done` (its build result) before the upload; trials.mjs should either forward it
//   renamed as `built`, or drop it, and send its own terminal `done` after uploadInto (shown above). Simplest: wrap
//   onEvent as (ev, d) => send(ev === 'done' ? 'built' : ev, d).
//   Extra tag `src:store` is optional (sample copies already set the precedent with `sample:<set>`); a re-import can
//   delete earlier rows tagged `src:store` first so files don't pile up as "acme-com-products-1 (2).md".
//
// SSE events (data is one JSON line; same names are passed to onEvent):
//   detect   { platform, api, base, name }                    platform found; api=false means HTML/JSON-LD fallback
//   fetching { done, total }                                   request progress (throttled to ~4/s, plus a final one)
//   found    { products, pages, policies, faqs }               what was collected
//   building { files: [name] }                                 Markdown files being assembled
//   capped   { products?:{limit,kept,more}, pages?:{limit,kept,more}, bytes?:{limit,droppedProducts,droppedSections},
//              time?:true }                                    only when something was left out
//   built/done { files: [{ name, bytes:<number>, docs }], platform, counts }
//   uploaded { file: FileRow }                                 (trials.mjs only)
//   error    { code, message }   codes: bad_url, blocked_host, not_found, unreachable, robots, timeout, too_large,
//                                 too_many_redirects, no_content, quota, aborted, upstream
//
// UI (Builder third chip "Enter a Store URL", owner B): chip opens an inline input (type=url, placeholder
// "yourstore.com", submit "Import store"). States: idle → validating (client: non-empty, ≤ 2048 chars) →
// "Looking at yourstore.com…" (until detect) → "Shopify store found" (detect) → progress bar from fetching.done/total
// with "Reading products and help pages…" → "Found 412 products, 6 help pages, 3 policies" (found) → "Building 4
// files…" (building) → optional notice for capped ("Imported the first 2,000 products") → files appear in the ingest
// panel via the normal events stream (uploaded/done) → error states map code → copy (see ERROR_COPY below; every
// error offers "Try another URL" and "Upload files instead").
// ============================================================================================================

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';

export const USER_AGENT = 'KnowBotStudio/1.0 (+https://knowbot.knowdrive.ai)';
const UA_TOKEN = 'knowbotstudio';
const MB = 1024 * 1024;
export const LIMITS = Object.freeze({ maxProducts: 2000, maxPages: 200, maxTotalBytes: 20 * MB, timeoutMs: 10000, maxBytes: 5 * MB, budgetMs: 90000,
  concurrency: 4, paceMs: 150, maxRedirects: 5 });
const POLICY_HANDLES = ['refund-policy', 'shipping-policy', 'privacy-policy', 'terms-of-service'];
const HELP_RE = /faq|help|support|customer-?service|question|shipping|delivery|return|refund|exchange|warrant|guarantee|about|contact|polic|terms|privacy|care-guide|size-guide|sizing/i;
const FAQ_RE = /faq|help|question/i;
const POLICY_RE = /shipping|delivery|return|refund|exchange|warrant|guarantee|polic|terms|privacy/i;
const SKIP_SITEMAP_RE = /blog|post|article|news|image|video|tag|author|categor|collection/i;

export const ERROR_COPY = {
  bad_url: "That doesn't look like a web address. Try something like yourstore.com.",
  blocked_host: "We can't import from that address. Use your store's public web address.",
  not_found: "We couldn't find that website. Check the address and try again.",
  unreachable: "That website didn't answer. Check the address, or try again in a minute.",
  robots: "That store's robots.txt asks bots like ours not to read it, so we didn't.",
  timeout: 'That store took too long to answer. Try again, or upload files instead.',
  too_large: 'A page on that store was too large to read.',
  too_many_redirects: 'That address redirects too many times.',
  no_content: "We couldn't find products or help pages on that site. It may build its pages with JavaScript; upload files instead.",
  quota: 'Your trial is full. Remove a file to import a store.',
  aborted: 'The import was cancelled.',
  upstream: 'Something went wrong reading that store. Try again, or upload files instead.',
};

export class StoreImportError extends Error {
  constructor(code, message, extra = {}) {
    super(message || ERROR_COPY[code] || code);
    this.code = code;
    this.status = { bad_url: 400, blocked_host: 400, not_found: 404, robots: 403, quota: 413, too_large: 413, no_content: 422, aborted: 499 }[code] || 502;
    Object.assign(this, extra);
  }
}
const err = (code, message, extra) => new StoreImportError(code, message, extra);
/** Errors that end the whole import (vs a single page that failed). */
const FATAL = new Set(['aborted', 'quota']);

// ------------------------------------------------------------------------------------------------ address policy
function v4int(ip) { const p = ip.split('.').map(Number); return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0; }
const V4_BLOCKS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .map(([b, bits]) => [v4int(b), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);
function v4Blocked(ip) { const n = v4int(ip); return V4_BLOCKS.some(([b, m]) => ((n & m) >>> 0) === ((b & m) >>> 0)); }
/** Parse an IPv6 literal into 8 16-bit groups (handles ::, embedded IPv4 and %zone). */
function v6groups(ip) {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) { const n = v4int(tail[1]); s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], r = rest ? rest.split(':') : [];
  const fill = rest === null ? [] : new Array(8 - h.length - r.length).fill('0');
  return [...h, ...fill, ...r].map((x) => parseInt(x || '0', 16));
}
const g2v4 = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
/** True for addresses a server-side fetch must never reach: private, loopback, link-local, CGNAT, metadata, multicast,
 *  reserved, and IPv6 equivalents (incl. IPv4-mapped/compatible, NAT64, 6to4 and Teredo wrappers). */
export function isBlockedAddress(ip) {
  const s = String(ip || '').trim();
  const kind = net.isIP(s.replace(/^\[|\]$/g, '').split('%')[0]);
  if (kind === 4) return v4Blocked(s);
  if (kind !== 6) return true;
  const g = v6groups(s);
  if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return true;
  if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 && g[7] <= 1 ? true : v4Blocked(g2v4(g[6], g[7])); // ::, ::1, ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(g2v4(g[6], g[7]));                 // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || v4Blocked(g2v4(g[6], g[7]));                          // NAT64
  if (g[0] === 0x2002) return v4Blocked(g2v4(g[1], g[2]));                                                          // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;                                               // Teredo, doc
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;                                       // discard
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                                                      // ULA (incl. fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;                                        // link/site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                                                                      // multicast
  return false;
}
const normIp = (ip) => { const s = String(ip).replace(/^\[|\]$/g, '').toLowerCase(); return net.isIP(s) === 6 ? v6groups(s).join(':') : s; };
const BAD_HOST_RE = /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|intranet|lan|corp)$/i;

const MULTI_SUFFIX = new Set(('co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk com.au net.au org.au co.nz org.nz co.jp ne.jp or.jp com.br com.mx co.za '
  + 'com.sg com.hk co.in com.tr com.cn co.kr com.ar com.co co.id com.my com.ph com.tw co.il com.pl com.ua co.th '
  + 'myshopify.com squarespace.com wordpress.com wpcomstaging.com github.io netlify.app vercel.app herokuapp.com pages.dev web.app firebaseapp.com '
  + 'azurewebsites.net cloudfront.net amazonaws.com').split(' '));
/** Approximate registrable domain (eTLD+1) with a small built-in suffix list; IP literals are returned as-is. */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(h)) return normIp(h);
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return MULTI_SUFFIX.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

/** Normalise what a visitor typed into an http(s) URL, or throw bad_url. */
export function normalizeStoreUrl(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 2048 || /[\s\0-\x1f]/.test(s)) throw err('bad_url');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { /* has scheme */ }
  else if (/^(?:javascript|data|file|ftp|mailto|about|blob|vbscript|gopher|ws|wss|dict|ldap|tftp|jar|chrome|view-source):/i.test(s)) throw err('bad_url');
  else s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(s); } catch { throw err('bad_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err('bad_url');
  if (u.username || u.password) throw err('bad_url', 'Store addresses with a username or password are not supported.');
  if (!u.hostname) throw err('bad_url');
  u.hash = '';
  return u;
}

// ------------------------------------------------------------------------------------------------ robots.txt
/** RFC 9309 parser: { groups:[{agents:[...], rules:[{allow, path}]}], sitemaps:[...] }. */
export function parseRobots(text) {
  const groups = [], sitemaps = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') { if (val) cur.rules.push({ allow: key === 'allow', path: val }); }
  }
  return { groups, sitemaps };
}
function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}
/** Longest-match rules for our UA group (most specific agent), else `*`; ties go to Allow. */
export function robotsAllows(parsed, pathAndQuery, token = UA_TOKEN) {
  if (!parsed || !parsed.groups?.length) return true;
  let best = -1, rules = [];
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      const score = a === '*' ? 0 : a && (token.includes(a) || a.includes(token)) ? a.length : -1;
      if (score > best) { best = score; rules = [...g.rules]; } else if (score === best && score >= 0) rules.push(...g.rules);
    }
  }
  if (best < 0) return true;
  let p = pathAndQuery || '/';
  try { p = decodeURI(p); } catch {}
  let win = null;
  for (const r of rules) {
    let rp = r.path; try { rp = decodeURI(rp); } catch {}
    if (!ruleMatches(rp, p)) continue;
    const len = rp.replace(/\*/g, '').length;
    if (!win || len > win.len || (len === win.len && r.allow)) win = { len, allow: r.allow };
  }
  return win ? win.allow : true;
}

// ------------------------------------------------------------------------------------------------ safe fetcher
async function defaultResolve(host) { return dns.promises.lookup(host, { all: true, verbatim: true }); }

/**
 * An SSRF-safe fetcher for one import run. Every request: http/https only, standard ports, DNS resolved here and
 * every address checked (the socket then connects to that checked address, so DNS rebinding can't swap it), same
 * registrable site (plus allowHost'ed CDN hosts), robots.txt honoured, redirects re-checked hop by hop (max 5),
 * 10 s per request, 5 MB per body (after decompression), ~90 s total budget, ≤ 4 in flight with polite pacing.
 * No cookies are stored or sent; only UA/Accept/Accept-Encoding (+content-type for GraphQL POSTs) go out.
 *
 * Options (tests): allowAddresses: ['127.0.0.1'] (default none), allowPorts: [80,443] | 'any', resolve(host) →
 * [{address,family}], timeoutMs, maxBytes, budgetMs, concurrency, paceMs, maxRedirects, signal, onProgress({done,total}).
 */
export function createStoreFetcher(o = {}) {
  const cfg = { ...LIMITS, resolve: defaultResolve, allowAddresses: [], allowPorts: [80, 443], userAgent: USER_AGENT, ...o };
  const allowAddr = new Set((cfg.allowAddresses || []).map(normIp));
  const sites = new Set(), hosts = new Set();
  const dnsCache = new Map(), robotsCache = new Map();
  const startedAt = Date.now();
  const deadline = startedAt + cfg.budgetMs;
  const stats = { done: 0, total: 0, bytes: 0, maxActive: 0 };
  let active = 0, lastStart = 0, pumpTimer = null;
  const queue = [];

  const checkAbort = () => { if (cfg.signal?.aborted) throw err('aborted'); };
  const pastDeadline = () => Date.now() >= deadline;
  function pump() {
    while (queue.length && active < cfg.concurrency) {
      if (cfg.signal?.aborted || pastDeadline()) { const it = queue.shift(); it.rej(cfg.signal?.aborted ? err('aborted') : err('timeout', 'Time budget used up.', { budget: true })); continue; }
      const wait = lastStart + cfg.paceMs - Date.now();
      if (wait > 0) { if (!pumpTimer) { pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait); pumpTimer.unref?.(); } return; }
      const it = queue.shift();
      active++; stats.maxActive = Math.max(stats.maxActive, active); lastStart = Date.now();
      Promise.resolve().then(it.fn).then(it.res, it.rej).finally(() => { active--; pump(); });
    }
  }
  const schedule = (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); pump(); });

  function portOk(u) {
    if (cfg.allowPorts === 'any') return true;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return cfg.allowPorts.includes(port);
  }
  function hostOk(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hosts.has(h) || sites.has(registrableDomain(h));
  }
  function checkUrl(u, anyHost) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err('blocked_host', 'Only http and https links can be read.');
    if (u.username || u.password) throw err('blocked_host', 'Links with credentials are not followed.');
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!net.isIP(h) && (BAD_HOST_RE.test(h) || !h.includes('.'))) throw err('blocked_host');
    if (!portOk(u)) throw err('blocked_host', 'Only standard web ports (80 and 443) can be read.');
    if (!anyHost && !hostOk(h)) throw err('blocked_host', `${h} is not part of this store.`, { offSite: true });
  }
  async function resolveChecked(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!dnsCache.has(h)) {
      dnsCache.set(h, (async () => {
        let addrs;
        if (net.isIP(h)) addrs = [{ address: h, family: net.isIP(h) }];
        else {
          try { addrs = await cfg.resolve(h); } catch { throw err('not_found'); }
          addrs = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
        }
        if (!addrs.length) throw err('not_found');
        for (const a of addrs) if (isBlockedAddress(a.address) && !allowAddr.has(normIp(a.address))) throw err('blocked_host', undefined, { address: a.address });
        return addrs[0].address;
      })());
    }
    return dnsCache.get(h);
  }

  function rawRequest(u, address, { method, headers, body, maxBytes }) {
    return new Promise((resolve, reject) => {
      const isHttps = u.protocol === 'https:';
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const timeoutMs = Math.max(1, Math.min(cfg.timeoutMs, deadline - Date.now()));
      let settled = false, req = null;
      const finish = (e, v) => {
        if (settled) return; settled = true; clearTimeout(timer); cfg.signal?.removeEventListener?.('abort', onAbort);
        if (e) { try { req?.destroy(); } catch {} reject(e); } else resolve(v);
      };
      const timer = setTimeout(() => finish(err('timeout', `${u.host} took too long to answer.`)), timeoutMs);
      const onAbort = () => finish(err('aborted'));
      if (cfg.signal) { if (cfg.signal.aborted) return onAbort(); cfg.signal.addEventListener('abort', onAbort, { once: true }); }
      const opts = { host: address, port: u.port || (isHttps ? 443 : 80), method, path: `${u.pathname}${u.search}`, agent: false,
        headers: { host: u.host, 'user-agent': cfg.userAgent, accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...headers } };
      if (isHttps) { if (!net.isIP(host)) opts.servername = host; opts.rejectUnauthorized = true; }
      if (body != null) opts.headers['content-length'] = Buffer.byteLength(body);
      req = (isHttps ? https : http).request(opts);
      req.on('error', (e) => finish(netError(e, u)));
      req.on('response', (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return finish(null, { status, headers: res.headers, body: Buffer.alloc(0) }); }
        const cl = Number(res.headers['content-length']);
        if (Number.isFinite(cl) && cl > maxBytes) { res.destroy(); return finish(err('too_large', `A page on ${u.host} is larger than ${Math.round(maxBytes / MB)} MB.`)); }
        const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = []; let n = 0, raw = 0;
        const tooBig = () => { res.destroy(); if (stream !== res) stream.destroy(); finish(err('too_large', `A page on ${u.host} is larger than ${Math.round(maxBytes / MB) || 1} MB.`)); };
        if (stream !== res) res.on('data', (c) => { raw += c.length; if (raw > maxBytes) tooBig(); });
        stream.on('data', (c) => { n += c.length; if (n > maxBytes) return tooBig(); chunks.push(c); });
        stream.on('end', () => finish(null, { status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', () => finish(err('upstream', `${u.host} sent a response we couldn't read.`)));
        res.on('error', () => finish(err('unreachable', `${u.host} closed the connection.`)));
      });
      req.end(body ?? undefined);
    });
  }

  async function robotsFor(origin) {
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, (async () => {
        let r;
        try { r = await fetchUrl(`${origin}/robots.txt`, { skipRobots: true, anyHost: true, maxBytes: 512 * 1024, accept: 'text/plain,*/*' }); }
        catch (e) { if (['aborted', 'blocked_host'].includes(e.code)) throw e; if (e.code === 'timeout') throw e; return { groups: [], sitemaps: [] }; }
        if (r.status >= 500) return { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }], sitemaps: [], unavailable: true };
        if (r.status >= 400 || r.status < 200) return { groups: [], sitemaps: [] };
        return parseRobots(r.body.toString('utf8'));
      })());
    }
    return robotsCache.get(origin);
  }
  async function robotsAllowed(url) {
    const u = typeof url === 'string' ? new URL(url) : url;
    return robotsAllows(await robotsFor(u.origin), `${u.pathname}${u.search}`);
  }

  /** Fetch with every hop checked. Returns {status, url, headers, body:Buffer, text(), json()} (any status). */
  async function fetchUrl(url, { method = 'GET', body = null, headers = {}, accept, anyHost = false, skipRobots = false, maxBytes = cfg.maxBytes } = {}) {
    checkAbort();
    let u;
    try { u = new URL(url); } catch { throw err('bad_url'); }
    if (accept) headers = { ...headers, accept };
    stats.total++; progress();
    try {
      for (let hop = 0; ; hop++) {
        checkAbort();
        if (pastDeadline()) throw err('timeout', 'Time budget used up.', { budget: true });
        checkUrl(u, anyHost);
        if (!skipRobots && !(await robotsAllowed(u))) throw err('robots', `robots.txt asks us not to read ${u.pathname}.`, { path: u.pathname });
        const address = await resolveChecked(u.hostname);
        const r = await schedule(() => rawRequest(u, address, { method, headers, body, maxBytes }));
        stats.bytes += r.body.length;
        if (r.status >= 300 && r.status < 400 && r.headers.location) {
          if (hop >= cfg.maxRedirects) throw err('too_many_redirects');
          let next;
          try { next = new URL(String(r.headers.location), u); } catch { throw err('bad_url', 'That store sent a broken redirect.'); }
          if (method !== 'GET' && ![307, 308].includes(r.status)) { method = 'GET'; body = null; }
          u = next;
          continue;
        }
        const out = { status: r.status, ok: r.status >= 200 && r.status < 300, url: u.href, headers: r.headers, body: r.body };
        out.text = () => r.body.toString('utf8');
        out.json = () => { try { return JSON.parse(r.body.toString('utf8')); } catch { return undefined; } };
        return out;
      }
    } finally { stats.done++; progress(); }
  }
  let lastProgress = 0;
  function progress(force = false) {
    if (!cfg.onProgress) return;
    const t = Date.now();
    if (!force && t - lastProgress < 250 && stats.done < stats.total) return;
    lastProgress = t;
    try { cfg.onProgress({ done: stats.done, total: stats.total }); } catch {}
  }
  /** GET and require 2xx; 404/410 → not_found. */
  async function get(url, opts) {
    const r = await fetchUrl(url, opts);
    if (r.status === 404 || r.status === 410) throw err('not_found', `${new URL(url).pathname} was not found.`);
    if (!r.ok) throw err('upstream', `${new URL(url).pathname} answered ${r.status}.`, { httpStatus: r.status });
    return r;
  }
  async function getJson(url, opts = {}) {
    const r = await get(url, { accept: 'application/json', ...opts });
    const j = r.json();
    if (j === undefined) throw err('upstream', `${new URL(url).pathname} did not return JSON.`);
    return { data: j, res: r };
  }

  return {
    fetch: fetchUrl, get, getJson, robotsFor, robotsAllowed, stats, deadline, config: cfg,
    allowSite(host) { sites.add(registrableDomain(host)); },
    allowHost(host) { hosts.add(String(host).toLowerCase()); },
    /** True when `url` is http(s) on this store's site (or an allowed CDN host). */
    hostOkFor(url) { try { const x = new URL(url); return (x.protocol === 'http:' || x.protocol === 'https:') && hostOk(x.hostname); } catch { return false; } },
    timeLeft: () => deadline - Date.now(),
    flushProgress: () => progress(true),
  };
}
function netError(e, u) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return err('not_found');
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EPIPE') return err('unreachable', `${u.host} didn't answer.`);
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(String(c || e?.message))) return err('unreachable', `${u.host} has a certificate problem.`);
  return err('unreachable', `${u.host} didn't answer.`);
}

// ------------------------------------------------------------------------------------------------ HTML helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', middot: '·', bull: '•', laquo: '«', raquo: '»', shy: '' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const oneLine = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const STRIP_BLOCKS_RE = /<(script|style|noscript|template|svg|iframe|object|embed|canvas|form|select|button|dialog)\b[\s\S]*?<\/\1\s*>/gi;
const CHROME_RE = /<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi;

function mainOf(html) {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html) || /<article\b[^>]*>([\s\S]*)<\/article\s*>/i.exec(html);
  if (m) return m[1];
  const r = /<[a-z]+\b[^>]*(?:role=["']main["']|id=["'](?:main-?content|maincontent|content|main)["'])[^>]*>/i.exec(html);
  if (r) return html.slice(r.index);
  const b = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  return b ? b[1] : html;
}
/**
 * Readable text of an HTML page or fragment: scripts/styles/forms stripped, nav/header/footer dropped (main=true),
 * headings rendered as Markdown starting at `minLevel`, lists as `- `, and any `#` the page itself begins a line with
 * escaped, so imported text can never forge a section heading (citations rely on our own `##` structure).
 */
export function htmlToText(html, { main = true, minLevel = 3 } = {}) {
  let s = String(html ?? '').replace(/[\u0001\u0002]/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(STRIP_BLOCKS_RE, ' ').replace(/<(script|style)\b[^>]*\/>/gi, ' ');
  if (main) s = mainOf(s).replace(CHROME_RE, ' ');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, l, t) => {
    const txt = oneLine(t); if (!txt) return '\n';
    return `\n\n\u0001${Math.min(6, minLevel + Math.max(0, Number(l) - 2))}\u0002 ${txt}\n\n`;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:td|th)\s*>/gi, ' · ')
    .replace(/<\/?(?:p|div|section|article|ul|ol|table|tr|blockquote|dl|dt|dd|details|summary|figure|figcaption|pre|address|main)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\u0000/g, '');
  const lines = s.split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim().replace(/\s·$/, ''));
  let out = lines.filter((l) => l !== '-').join('\n').replace(/\n{3,}/g, '\n\n').trim();
  out = out.replace(/^(#{1,6})(?=\s|$)/gm, '\\$1');
  return out.replace(/\u0001(\d)\u0002/g, (_, n) => '#'.repeat(Number(n)));
}
export function titleOfHtml(html) {
  const og = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html) || /<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(mainOf(String(html).replace(STRIP_BLOCKS_RE, ' ')));
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return clip(oneLine(h1?.[1] || og?.[1] || t?.[1] || ''), 140);
}
function siteNameOfHtml(html) {
  const m = /<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i.exec(html) || /<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i.exec(html);
  if (m) return clip(oneLine(m[1]), 80);
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return t ? clip(oneLine(t[1]).split(/\s[|–—-]\s/)[0], 80) : null;
}
/** All schema.org JSON-LD objects on a page, flattened (arrays and @graph). */
export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  const walk = (x, depth = 0) => {
    if (!x || depth > 4) return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    if (typeof x !== 'object') return;
    out.push(x);
    if (Array.isArray(x['@graph'])) x['@graph'].forEach((y) => walk(y, depth + 1));
  };
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { walk(JSON.parse(raw)); } catch { try { walk(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch {} }
  }
  return out;
}
const typeIs = (o, t) => [].concat(o?.['@type'] || []).some((x) => String(x).replace(/^.*[/#]/, '') === t);
function linksOf(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href=["']([^"'#]+)(?:#[^"']*)?["']/gi;
  let m;
  while ((m = re.exec(html))) { try { const u = new URL(decodeEntities(m[1]), baseUrl); if (u.protocol.startsWith('http')) { u.hash = ''; out.add(u.href); } } catch {} }
  return [...out];
}
/** Q/A pairs from a help page: <details><summary>, and headings / bold lines that end with '?'. */
export function faqPairsFromHtml(html) {
  const pairs = [];
  const body = mainOf(String(html).replace(STRIP_BLOCKS_RE, ' ')).replace(CHROME_RE, ' ');
  const dre = /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>/gi;
  let m;
  while ((m = dre.exec(body))) { const q = oneLine(m[1]), a = htmlToText(m[2], { main: false, minLevel: 5 }); if (q && a) pairs.push({ q, a }); }
  if (pairs.length >= 2) return pairs;
  const text = htmlToText(body, { main: false, minLevel: 3 });
  const blocks = text.split(/\n(?=#{3,6} |\*\*[^\n]+\?\*\*\s*$)/m);
  const hq = [];
  for (const b of blocks) {
    const hm = /^(?:#{3,6} (.+\?)|\*\*(.+\?)\*\*)\s*\n([\s\S]+)$/.exec(b.trim());
    if (hm) { const a = hm[3].trim().replace(/^#{3,6} .*$/gm, '').trim(); if (a) hq.push({ q: (hm[1] || hm[2]).trim(), a }); }
  }
  return hq.length >= 2 ? hq : pairs;
}

// ------------------------------------------------------------------------------------------------ documents
const fmtMoney = (v, cur) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return null;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${s} ${cur}` : s;
};
const AVAIL = (a) => (a == null ? null : a === true ? 'in stock' : a === false ? 'out of stock'
  : String(a).replace(/^.*[/#]/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
const cleanTitle = (s) => clip(oneLine(s), 200).replace(/^#+\s*/, '');
/** A product as Markdown body lines (the section heading and Source line are added by the file builder). */
export function productDoc(p) {
  // Every fact line names its product ("- Trail Pro price: …"): a line is quoted on its own, so it must say what it
  // is about without its heading (a line picker sees only the line; a librarian quote should read whole).
  const name = cleanTitle(p.title) || 'Untitled product';
  const L = [];
  const fact = (key, value) => L.push(`- ${name} ${key}: ${value}`);
  const price = fmtMoney(p.price, p.currency);
  const was = fmtMoney(p.compareAt, p.currency);
  if (price) fact('price', `${price}${was && Number(p.compareAt) > Number(p.price) ? ` (was ${was})` : ''}${p.priceMax && Number(p.priceMax) > Number(p.price) ? ` to ${fmtMoney(p.priceMax, p.currency)}` : ''}`);
  if (p.brand) fact('brand', oneLine(p.brand));
  if (p.type) fact('type', oneLine(p.type));
  if (p.sku) fact('SKU', oneLine(p.sku));
  if (p.availability) fact('availability', p.availability);
  const vs = (p.variants || []).filter((v) => v && v.title && !/^default( title)?$/i.test(v.title));
  if (vs.length) {
    L.push(`- ${name} variants:`);
    for (const v of vs.slice(0, 60)) {
      const bits = [fmtMoney(v.price, p.currency), v.sku ? `SKU ${oneLine(v.sku)}` : null, v.available == null ? null : AVAIL(v.available)].filter(Boolean);
      const vt = oneLine(v.title);
      L.push(`  - ${vt.toLowerCase().startsWith(name.toLowerCase()) ? vt : `${name} ${vt}`}${bits.length ? `: ${bits.join(', ')}` : ''}`);
    }
    if (vs.length > 60) L.push(`  - …and ${vs.length - 60} more variants`);
  }
  if (p.options?.length) fact('options', p.options.map((o) => `${oneLine(o.name)} (${o.values.map(oneLine).join(', ')})`).join('; '));
  if (p.categories?.length) fact('categories', p.categories.map(oneLine).filter(Boolean).join(', '));
  if (p.tags?.length) fact('tags', p.tags.map(oneLine).filter(Boolean).join(', '));
  const desc = p.descriptionHtml != null ? htmlToText(p.descriptionHtml, { main: false, minLevel: 4 }) : String(p.description || '').trim();
  const text = `${L.join('\n')}${desc ? `\n\n${clip(desc, 6000)}` : ''}`.trim();
  return { kind: 'product', title: name, url: p.url, text };
}
function productFromLd(o, pageUrl) {
  const offers = [].concat(o.offers || []).flatMap((x) => (typeIs(x, 'AggregateOffer') && x.offers ? [].concat(x.offers) : [x]));
  const first = offers[0] || {};
  const agg = [].concat(o.offers || []).find((x) => typeIs(x, 'AggregateOffer'));
  const variants = [].concat(o.hasVariant || []).map((v) => { const vo = [].concat(v.offers || [])[0] || {}; return { title: v.name, sku: v.sku, price: vo.price, available: vo.availability ? AVAIL(vo.availability) : null }; });
  return productDoc({ title: o.name, url: (typeof o.url === 'string' && o.url) || pageUrl, sku: o.sku, brand: typeof o.brand === 'object' ? o.brand?.name : o.brand,
    price: agg?.lowPrice ?? first.price ?? first.priceSpecification?.price, priceMax: agg?.highPrice, currency: agg?.priceCurrency || first.priceCurrency || first.priceSpecification?.priceCurrency,
    availability: first.availability ? AVAIL(first.availability) : null, variants, categories: o.category ? [].concat(o.category).map(String) : [],
    descriptionHtml: o.description ? String(o.description) : '' });
}
const kindOf = (url, title) => { const s = `${safePath(url)} ${title || ''}`; return FAQ_RE.test(s) ? 'faq' : POLICY_RE.test(s) ? 'policy' : 'page'; };
function safePath(url) { try { return new URL(url).pathname; } catch { return String(url || ''); } }

/** Everything useful on one fetched HTML page: JSON-LD products and FAQs, Q/A pairs, else readable text. */
export function docsFromHtml(html, url, { kindHint = null, wantProducts = true } = {}) {
  const docs = [];
  const ld = jsonLdBlocks(html);
  if (wantProducts) for (const o of ld) if ((typeIs(o, 'Product') || typeIs(o, 'ProductGroup')) && o.name) docs.push(productFromLd(o, url));
  const title = titleOfHtml(html) || safePath(url);
  let faqs = [];
  for (const o of ld) {
    if (!typeIs(o, 'FAQPage')) continue;
    for (const q of [].concat(o.mainEntity || [])) {
      const a = [].concat(q?.acceptedAnswer || [])[0];
      const qt = oneLine(q?.name), at = a ? htmlToText(String(a.text || ''), { main: false, minLevel: 5 }) : '';
      if (qt && at) faqs.push({ q: qt, a: at });
    }
  }
  const kind = kindHint || kindOf(url, title);
  if (!faqs.length && kind !== 'product' && (kind === 'faq' || FAQ_RE.test(title))) faqs = faqPairsFromHtml(html);
  if (faqs.length) for (const f of faqs) docs.push({ kind: 'faq', title: clip(f.q, 300), url, text: clip(f.a, 8000), group: title });
  else if (kind !== 'product' && !docs.some((d) => d.kind === 'product')) {
    // the page's own title heading would repeat our `## title` line
    const text = htmlToText(html, { main: true, minLevel: 3 }).replace(/^#{3,6} (.*)\n+/, (m, h) => (h.trim().toLowerCase() === title.trim().toLowerCase() ? '' : m));
    if (text.replace(/\s+/g, ' ').length >= 40) docs.push({ kind: kind === 'faq' ? 'page' : kind, title: cleanTitle(title), url, text: clip(text, 60000) });
  }
  return docs;
}

// ------------------------------------------------------------------------------------------------ platform detection
const hasHeader = (h, re) => Object.keys(h || {}).some((k) => re.test(k));
/**
 * Detect the store platform. `fetchFn` is a createStoreFetcher().fetch (or anything with the same contract:
 * (url, {method, body, headers, accept, anyHost}) → {status, ok, url, headers, body, text(), json()}).
 * → { platform, api, base, name, currency, signals:[...], home:{url, html}, apiBase? }
 */
export async function detectPlatform(url, fetchFn) {
  const start = typeof url === 'string' ? normalizeStoreUrl(url) : url;
  let home;
  try { home = await fetchFn(`${start.origin}/`, { anyHost: true, accept: 'text/html,application/xhtml+xml' }); }
  catch (e) { throw e.code === 'robots' ? err('robots') : e; }
  if (home.status === 404 && !home.body.length) throw err('not_found');
  const base = new URL(home.url).origin;
  const html = home.text().slice(0, 2 * MB);
  const h = home.headers || {};
  const cookies = [].concat(h['set-cookie'] || []).join(';');
  const signals = [];
  const hint = {
    shopify: hasHeader(h, /^x-shopify|^x-shopid$/) || /shopify/i.test(String(h['powered-by'] || '')) || /cdn\.shopify\.com|Shopify\.theme|shopify-section/.test(html),
    magento: hasHeader(h, /^x-magento/) || /mage-cache|X-Magento-Vary|form_key|mage-messages/i.test(cookies) || /text\/x-magento-init|Magento_[A-Z]|\/static\/version\d+\/|mage\/cookies/.test(html),
    squarespace: /squarespace/i.test(String(h.server || '')) || /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT|<!-- This is Squarespace/.test(html),
    woocommerce: /woocommerce|wc-block-|\/wp-content\/plugins\/woocommerce/i.test(html),
    wordpress: /wp-content|wp-json|api\.w\.org/.test(html) || /api\.w\.org/.test(String(h.link || '')),
  };
  for (const [k, v] of Object.entries(hint)) if (v) signals.push(`hint:${k}`);
  const name = siteNameOfHtml(html);
  const currency = /Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/.exec(html)?.[1]
    || /<meta\b[^>]*(?:property|itemprop)=["'](?:og:price:currency|product:price:currency|priceCurrency)["'][^>]*content=["']([A-Z]{3})["']/i.exec(html)?.[1] || null;
  const quiet = async (fn) => { try { return await fn(); } catch (e) { if (FATAL.has(e.code)) throw e; signals.push(`probe-error:${e.code}`); return null; } };
  // probes target the homepage's final origin exactly (already address-checked), so they may run before allowSite(base)
  const json = async (u, opts) => { const r = await fetchFn(u, { accept: 'application/json', anyHost: true, ...opts }); return r.ok ? r.json() : undefined; };
  const probes = {
    shopify: () => quiet(async () => { const j = await json(`${base}/products.json?limit=1`); return Array.isArray(j?.products) ? {} : null; }),
    woocommerce: () => quiet(async () => {
      const j = await json(`${base}/wp-json/wc/store/v1/products?per_page=1`);
      if (Array.isArray(j)) return { apiBase: 'pretty' };
      const k = await json(`${base}/?rest_route=/wc/store/v1/products&per_page=1`);
      return Array.isArray(k) ? { apiBase: 'rest_route' } : null;
    }),
    magento: () => quiet(async () => {
      const j = await json(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ storeConfig { store_name base_currency_code } }' }) });
      return j?.data?.storeConfig ? { name: j.data.storeConfig.store_name, currency: j.data.storeConfig.base_currency_code } : null;
    }),
    squarespace: () => quiet(async () => { const j = await json(`${base}/?format=json`); return j && (j.website || j.websiteSettings) ? { name: j.website?.siteTitle } : null; }),
  };
  const order = ['shopify', 'magento', 'squarespace', 'woocommerce'].filter((k) => hint[k]);
  if (!order.length) order.push('shopify', 'woocommerce', ...(hint.wordpress ? [] : ['magento']));
  else if (hint.wordpress && !order.includes('woocommerce')) order.push('woocommerce');
  for (const k of order) {
    const r = await probes[k]();
    if (r) { signals.push(`api:${k}`); return { platform: k, api: true, base, name: r.name || name, currency: r.currency || currency, signals, home: { url: home.url, html }, apiBase: r.apiBase }; }
  }
  const hinted = ['shopify', 'magento', 'squarespace', 'woocommerce'].find((k) => hint[k]);
  return { platform: hinted || 'generic', api: false, base, name, currency, signals, home: { url: home.url, html } };
}

// ------------------------------------------------------------------------------------------------ collectors
/** Sitemap discovery: robots.txt Sitemap: lines, then /sitemap.xml and /sitemap_index.xml; follows indexes. */
async function sitemapEntries(ctx) {
  if (ctx._sitemap) return ctx._sitemap;
  ctx._sitemap = (async () => {
    const { f, base } = ctx;
    const robots = await f.robotsFor(base).catch(() => ({ sitemaps: [] }));
    const seeds = [...new Set([...(robots.sitemaps || []), `${base}/sitemap.xml`, `${base}/sitemap_index.xml`, ...(ctx.det.platform === 'woocommerce' ? [`${base}/wp-sitemap.xml`] : [])])];
    const entries = [], seenLoc = new Set(), seenMap = new Set();
    const queue = seeds.map((u) => ({ u, depth: 0 }));
    let files = 0, foundAny = false;
    while (queue.length && files < 40 && entries.length < 20000) {
      const { u, depth } = queue.shift();
      if (seenMap.has(u)) continue; seenMap.add(u);
      if (depth === 0 && foundAny && !robots.sitemaps?.includes(u)) continue; // defaults only when robots gave nothing usable
      let r;
      try { r = await f.get(u, { accept: 'application/xml,text/xml,*/*' }); } catch (e) { if (FATAL.has(e.code)) throw e; if (e.budget) break; continue; }
      files++;
      let xml = r.body;
      if (xml[0] === 0x1f && xml[1] === 0x8b) { try { xml = zlib.gunzipSync(xml, { maxOutputLength: f.config.maxBytes }); } catch { continue; } }
      const s = xml.toString('utf8');
      const locs = [...s.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1].trim()));
      if (/<sitemapindex\b/i.test(s)) {
        const kids = locs.filter((l) => { try { return f.hostOkFor(l); } catch { return false; } });
        const pri = (l) => (/page/i.test(l) ? 0 : /product/i.test(l) ? 1 : SKIP_SITEMAP_RE.test(l) ? 3 : 2);
        kids.sort((a, b) => pri(a) - pri(b));
        for (const k of kids) if (depth < 3 && pri(k) < 3 && !(ctx.skipProductSitemaps && pri(k) === 1)) queue.push({ u: k, depth: depth + 1 });
        foundAny = foundAny || kids.length > 0;
      } else {
        for (const l of locs) if (!seenLoc.has(l) && f.hostOkFor(l)) { seenLoc.add(l); entries.push({ loc: l, sitemap: u }); }
        foundAny = foundAny || locs.length > 0;
      }
    }
    return entries;
  })();
  return ctx._sitemap;
}

/** Fetch help/policy pages (≤ maxPages+1 so caps can be reported) and turn them into documents. */
async function fetchHelpPages(ctx, urls, { titleFilter = false, kindHint = null } = {}) {
  const docs = [];
  const uniq = [...new Set(urls)].filter((u) => !ctx.seenPages.has(u));
  for (const u of uniq) ctx.seenPages.add(u);
  const room = Math.max(0, ctx.caps.maxPages + 1 - ctx.pageCount);
  const list = uniq.slice(0, room);
  if (uniq.length > room) ctx.pagesMore = true;
  ctx.pageCount += list.length;
  await Promise.all(list.map(async (u) => {
    try {
      const r = await ctx.f.get(u, { accept: 'text/html,application/xhtml+xml' });
      if (!/html|xml/i.test(String(r.headers['content-type'] || 'text/html'))) return;
      const html = r.text();
      const ds = docsFromHtml(html, r.url, { kindHint, wantProducts: false });
      if (titleFilter && !HELP_RE.test(`${safePath(u)} ${titleOfHtml(html)}`)) return;
      docs.push(...ds);
    } catch (e) { ctx.pageError(e); }
  }));
  return docs;
}
/** Product pages without an API: JSON-LD Product on each page (bounded by maxProducts and the time budget). */
async function fetchProductPages(ctx, urls) {
  const docs = [];
  const uniq = [...new Set(urls)];
  const room = Math.max(0, ctx.caps.maxProducts + 1 - ctx.productPageCount);
  const list = uniq.slice(0, room);
  if (uniq.length > room) ctx.productsMore = true;
  ctx.productPageCount += list.length;
  await Promise.all(list.map(async (u) => {
    try {
      const r = await ctx.f.get(u, { accept: 'text/html,application/xhtml+xml' });
      docs.push(...docsFromHtml(r.text(), r.url, { kindHint: 'product' }).filter((d) => d.kind === 'product' || d.kind === 'faq'));
    } catch (e) { ctx.pageError(e); }
  }));
  return docs;
}
const PRODUCT_URL_RE = /\/(?:products?|p|shop|item|items|store)\/[^/?#]+/i;
function isHelpUrl(u) { return HELP_RE.test(safePath(u)); }

async function collectGeneric(ctx, { products = true } = {}) {
  const docs = [];
  const homeHtml = ctx.det.home.html;
  docs.push(...docsFromHtml(homeHtml, ctx.det.home.url, { kindHint: 'home' }).filter((d) => d.kind !== 'page' && d.kind !== 'home'));
  let entries = await sitemapEntries(ctx);
  if (!entries.length) entries = linksOf(homeHtml, ctx.det.home.url).filter((l) => ctx.f.hostOkFor(l)).map((loc) => ({ loc, sitemap: null }));
  const help = entries.filter((e) => isHelpUrl(e.loc) && !/product/i.test(e.sitemap || '')).map((e) => e.loc);
  docs.push(...await fetchHelpPages(ctx, help));
  if (products) {
    const prod = entries.filter((e) => /product/i.test(e.sitemap || '') || PRODUCT_URL_RE.test(safePath(e.loc)) || (ctx.det.platform === 'magento' && /\.html$/.test(e.loc) && !isHelpUrl(e.loc)));
    docs.push(...await fetchProductPages(ctx, prod.map((e) => e.loc)));
  }
  return docs;
}

async function collectShopify(ctx) {
  const { f, base, caps } = ctx;
  const docs = [];
  let api = ctx.det.api;
  if (api) {
    let n = 0;
    for (let page = 1; n <= caps.maxProducts && page <= 100; page++) {
      let list;
      try { list = (await f.getJson(`${base}/products.json?limit=${ctx.pageSize || 250}&page=${page}`)).data?.products; }
      catch (e) { if (FATAL.has(e.code)) throw e; if (page === 1) api = false; else ctx.pageError(e); break; }
      if (!Array.isArray(list) || !list.length) break;
      for (const p of list) {
        if (n++ >= caps.maxProducts) { ctx.productsMore = true; break; }
        const vs = Array.isArray(p.variants) ? p.variants : [];
        const prices = vs.map((v) => Number(v.price)).filter(Number.isFinite);
        const avail = vs.some((v) => v.available !== false);
        docs.push(productDoc({ title: p.title, url: `${base}/products/${p.handle}`, brand: p.vendor, type: p.product_type, currency: ctx.det.currency,
          price: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
          compareAt: vs.length === 1 ? vs[0].compare_at_price : null, sku: vs.length === 1 ? vs[0].sku : null,
          availability: vs.length ? (avail ? 'in stock' : 'out of stock') : null,
          variants: vs.length > 1 ? vs.map((v) => ({ title: v.title, price: v.price, sku: v.sku, available: v.available })) : [],
          tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean), descriptionHtml: p.body_html || '' }));
      }
      if (list.length < (ctx.pageSize || 250)) break;
    }
    ctx.api = api;
  }
  ctx.skipProductSitemaps = api;
  const entries = await sitemapEntries(ctx);
  if (!api) {
    ctx.warnings.push('This Shopify store turns off /products.json, so products were read from product pages (slower, fewer details).');
    docs.push(...await fetchProductPages(ctx, entries.filter((e) => /sitemap_products/.test(e.sitemap || '') || /\/products\/[^/]+$/.test(safePath(e.loc))).map((e) => e.loc)));
  }
  docs.push(...await fetchHelpPages(ctx, POLICY_HANDLES.map((h) => `${base}/policies/${h}`), { kindHint: 'policy' }));
  const pages = entries.filter((e) => /sitemap_pages/.test(e.sitemap || '') || /^\/pages\//.test(safePath(e.loc))).map((e) => e.loc);
  const byHandle = pages.filter(isHelpUrl);
  docs.push(...await fetchHelpPages(ctx, byHandle));
  if (pages.length <= 30) docs.push(...await fetchHelpPages(ctx, pages.filter((u) => !byHandle.includes(u)), { titleFilter: true }));
  return docs;
}

const MAGENTO_Q_FULL = `query($page:Int!,$size:Int!){products(search:"",pageSize:$size,currentPage:$page){total_count page_info{current_page total_pages}
items{__typename name sku url_key url_suffix stock_status categories{name}
price_range{minimum_price{regular_price{value currency} final_price{value currency}} maximum_price{final_price{value currency}}}
short_description{html} description{html}
... on ConfigurableProduct{variants{attributes{label code} product{sku stock_status price_range{minimum_price{final_price{value currency}}}}}}}}}`;
const MAGENTO_Q_MIN = `query($page:Int!,$size:Int!){products(search:"",pageSize:$size,currentPage:$page){total_count page_info{current_page total_pages}
items{name sku url_key stock_status price_range{minimum_price{regular_price{value currency} final_price{value currency}}} description{html}}}}`;
const MAGENTO_CMS = ['faq', 'faqs', 'customer-service', 'help', 'shipping', 'shipping-policy', 'delivery', 'returns', 'return-policy', 'returns-and-exchanges',
  'warranty', 'privacy-policy-cookie-restriction-mode', 'privacy-policy', 'terms', 'terms-and-conditions', 'about-us', 'contact'];
async function magentoGql(ctx, query, variables) {
  const r = await ctx.f.fetch(`${ctx.base}/graphql`, { method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = r.json();
  if (!j || (!r.ok && !j.data)) throw err('upstream', `GraphQL answered ${r.status}.`);
  return j;
}
async function collectMagento(ctx) {
  const { base, caps } = ctx;
  if (!ctx.det.api) return collectGeneric(ctx);
  ctx.skipProductSitemaps = true;
  const docs = [];
  let q = MAGENTO_Q_FULL, n = 0;
  const size = ctx.pageSize || 100;
  try {
    for (let page = 1, total = 1; page <= total && n <= caps.maxProducts && page <= 200; page++) {
      let j = await magentoGql(ctx, q, { page, size });
      if (!j.data?.products && q === MAGENTO_Q_FULL) { q = MAGENTO_Q_MIN; j = await magentoGql(ctx, q, { page, size }); }
      const pr = j.data?.products;
      if (!pr) { if (page === 1) throw err('upstream', 'GraphQL products query failed.'); break; }
      total = Number(pr.page_info?.total_pages) || 1;
      for (const it of pr.items || []) {
        if (n++ >= caps.maxProducts) { ctx.productsMore = true; break; }
        const mp = it.price_range?.minimum_price || {};
        const cur = mp.final_price?.currency || mp.regular_price?.currency || ctx.det.currency;
        docs.push(productDoc({ title: it.name, url: `${base}/${it.url_key}${it.url_suffix ?? '.html'}`, sku: it.sku, currency: cur,
          price: mp.final_price?.value ?? mp.regular_price?.value, compareAt: mp.regular_price?.value, priceMax: it.price_range?.maximum_price?.final_price?.value,
          availability: it.stock_status ? AVAIL(it.stock_status === 'IN_STOCK') : null, type: it.__typename && it.__typename !== 'SimpleProduct' ? it.__typename.replace(/Product$/, '') : null,
          categories: (it.categories || []).map((c) => c?.name).filter(Boolean),
          variants: (it.variants || []).map((v) => ({ title: (v.attributes || []).map((a) => a.label).join(' / '), sku: v.product?.sku, price: v.product?.price_range?.minimum_price?.final_price?.value,
            available: v.product?.stock_status ? v.product.stock_status === 'IN_STOCK' : null })),
          descriptionHtml: [it.short_description?.html, it.description?.html].filter(Boolean).join('\n') }));
      }
    }
  } catch (e) {
    if (FATAL.has(e.code)) throw e;
    if (!docs.length) { ctx.api = false; ctx.skipProductSitemaps = false; ctx.warnings.push("This Magento store's GraphQL API didn't answer, so products were read from product pages."); return collectGeneric(ctx); }
    ctx.pageError(e);
  }
  // CMS pages: one aliased cmsPage query (missing identifiers just come back null with an error entry)
  try {
    const qq = `{${MAGENTO_CMS.map((id, i) => `p${i}: cmsPage(identifier:${JSON.stringify(id)}){title content url_key}`).join(' ')}}`;
    const j = await magentoGql(ctx, qq, {});
    for (const [, pg] of Object.entries(j.data || {})) {
      if (!pg?.content) continue;
      const url = `${base}/${pg.url_key}`;
      ctx.seenPages.add(url);
      docs.push(...docsFromHtml(`<main><h1>${pg.title || ''}</h1>${pg.content}</main>`, url, { wantProducts: false }));
      ctx.pageCount++;
    }
  } catch (e) { if (FATAL.has(e.code)) throw e; }
  docs.push(...await collectGeneric(ctx, { products: false }));
  return docs;
}

function squarespaceItemDoc(it, base) {
  const sc = it.structuredContent || {};
  const vs = Array.isArray(it.variants) ? it.variants : Array.isArray(sc.variants) ? sc.variants : [];
  const money = (v) => (v?.priceMoney?.value != null ? Number(v.priceMoney.value) : v?.price != null ? Number(v.price) / 100 : null);
  const cur = vs.find((v) => v.priceMoney?.currency)?.priceMoney.currency || null;
  const prices = vs.map(money).filter(Number.isFinite);
  const vtitle = (v) => Object.entries(v.attributes || v.optionValues || {}).map(([k, x]) => (typeof x === 'object' ? `${x.optionName || k}: ${x.value}` : `${k}: ${x}`)).join(' / ');
  const avail = (v) => (v.unlimited || Number(v.qtyInStock ?? v.stock?.quantity) > 0 || v.stock?.unlimited ? true : v.qtyInStock != null || v.stock ? false : null);
  return productDoc({ title: it.title, url: `${base}${it.fullUrl || ''}`, currency: cur, price: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    sku: vs.length === 1 ? vs[0].sku : null, availability: vs.length ? (vs.some((v) => avail(v) === true) ? 'in stock' : vs.every((v) => avail(v) === false) ? 'out of stock' : null) : null,
    variants: vs.length > 1 ? vs.map((v) => ({ title: vtitle(v), sku: v.sku, price: money(v), available: avail(v) })) : [],
    tags: it.tags || [], categories: it.categories || [], descriptionHtml: it.body || it.excerpt || '' });
}
async function collectSquarespace(ctx) {
  const { f, base, caps } = ctx;
  const docs = [];
  const entries = await sitemapEntries(ctx);
  const productUrls = entries.filter((e) => /\/p\/[^/]+$/.test(safePath(e.loc)) || PRODUCT_URL_RE.test(safePath(e.loc))).map((e) => e.loc);
  let got = false;
  if (ctx.det.api) {
    const colls = new Set();
    for (const u of productUrls) { const p = safePath(u); const m = /^(.*)\/p\/[^/]+$/.exec(p); colls.add(m ? m[1] || '/' : p.replace(/\/[^/]+$/, '') || '/'); }
    let n = 0;
    for (const c of [...colls].slice(0, 10)) {
      let offset = null;
      for (let guard = 0; guard < 200 && n <= caps.maxProducts; guard++) {
        let j;
        try { j = (await f.getJson(`${base}${c}?format=json${offset != null ? `&offset=${encodeURIComponent(offset)}` : ''}`)).data; } catch (e) { if (FATAL.has(e.code)) throw e; ctx.pageError(e); break; }
        const items = (j?.items || []).filter((it) => it.structuredContent?.variants || it.variants || it.recordTypeLabel === 'store-item' || it.productType != null);
        for (const it of items) { if (n++ >= caps.maxProducts) { ctx.productsMore = true; break; } docs.push(squarespaceItemDoc(it, base)); got = true; }
        const pg = j?.pagination;
        if (!pg?.nextPage || pg.nextPageOffset == null) break;
        offset = pg.nextPageOffset;
      }
    }
  }
  if (!got) { if (ctx.det.api === false) ctx.warnings.push("Squarespace's JSON view isn't open to bots on this site, so products were read from product pages."); docs.push(...await fetchProductPages(ctx, productUrls)); }
  ctx.api = got;
  docs.push(...await collectGeneric(ctx, { products: false }));
  return docs;
}

function wooUrl(ctx, route, params) {
  const qs = new URLSearchParams(params).toString();
  return ctx.det.apiBase === 'rest_route' ? `${ctx.base}/?rest_route=${route}&${qs}` : `${ctx.base}/wp-json${route}?${qs}`;
}
async function collectWoo(ctx) {
  const { f, caps } = ctx;
  if (!ctx.det.api) return collectGeneric(ctx);
  ctx.skipProductSitemaps = true;
  const docs = [];
  const size = ctx.pageSize || 100;
  let n = 0;
  for (let page = 1, total = 1; page <= total && n <= caps.maxProducts && page <= 200; page++) {
    let r;
    try { r = await f.getJson(wooUrl(ctx, '/wc/store/v1/products', { per_page: size, page })); } catch (e) { if (FATAL.has(e.code)) throw e; ctx.pageError(e); break; }
    total = Number(r.res.headers['x-wp-totalpages']) || (Array.isArray(r.data) && r.data.length === size ? page + 1 : page);
    const list = Array.isArray(r.data) ? r.data : [];
    if (!list.length) break;
    for (const p of list) {
      if (n++ >= caps.maxProducts) { ctx.productsMore = true; break; }
      const pr = p.prices || {};
      const div = 10 ** (Number(pr.currency_minor_unit) || 0);
      const m = (v) => (v == null || v === '' ? null : Number(v) / div);
      docs.push(productDoc({ title: decodeEntities(p.name), url: p.permalink, sku: p.sku, currency: pr.currency_code,
        price: pr.price_range ? m(pr.price_range.min_amount) : m(pr.price), priceMax: pr.price_range ? m(pr.price_range.max_amount) : null,
        compareAt: pr.regular_price && pr.regular_price !== pr.price ? m(pr.regular_price) : null,
        availability: p.stock_availability?.text ? oneLine(p.stock_availability.text).toLowerCase() : p.is_in_stock == null ? null : AVAIL(!!p.is_in_stock),
        options: (p.attributes || []).filter((a) => a.terms?.length).map((a) => ({ name: a.name, values: a.terms.map((t) => t.name) })),
        categories: (p.categories || []).map((c) => decodeEntities(c.name)), tags: (p.tags || []).map((t) => decodeEntities(t.name)),
        descriptionHtml: [p.short_description, p.description].filter(Boolean).join('\n') }));
    }
  }
  // WordPress pages (public REST); falls back to the sitemap
  let wpOk = false;
  for (let page = 1; page <= 3 && ctx.pageCount <= caps.maxPages; page++) {
    let r;
    try { r = await f.getJson(wooUrl(ctx, '/wp/v2/pages', { per_page: 100, page, _fields: 'link,title,content' })); } catch (e) { if (FATAL.has(e.code)) throw e; break; }
    const list = Array.isArray(r.data) ? r.data : [];
    wpOk = wpOk || list.length > 0;
    for (const pg of list) {
      const title = oneLine(pg.title?.rendered), link = pg.link;
      if (!link || !HELP_RE.test(`${safePath(link)} ${title}`) || ctx.seenPages.has(link)) continue;
      if (!f.hostOkFor(link)) continue;
      if (ctx.pageCount >= caps.maxPages + 1) { ctx.pagesMore = true; break; }
      ctx.seenPages.add(link); ctx.pageCount++;
      docs.push(...docsFromHtml(`<main><h1>${title}</h1>${pg.content?.rendered || ''}</main>`, link, { wantProducts: false }));
    }
    if (list.length < 100) break;
  }
  docs.push(...await collectGeneric(ctx, { products: false }));
  return docs;
}
const COLLECTORS = { shopify: collectShopify, magento: collectMagento, squarespace: collectSquarespace, woocommerce: collectWoo, generic: collectGeneric };

// ------------------------------------------------------------------------------------------------ Markdown files
const fileSlug = (s) => String(s || 'store').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';
const mdLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim();
/**
 * Turn documents into a few Markdown files: `<slug>-products-N.md` (one `## title` per product), `<slug>-faq.md`
 * (`## page` / `### question`), one `<slug>-<policy>.md` per policy and `<slug>-pages.md`. Every section carries a
 * `Source: <url>` line (right under its heading, after a blank line) so citations can link where the answer came from. Byte budget priority: policies, FAQ, pages,
 * then products. → { files:[{name, bytes:Buffer, mime, docs, size}], capped:{...}|null }
 */
export function buildMarkdownFiles(docs, o = {}) {
  const maxTotalBytes = Math.min(o.maxTotalBytes ?? LIMITS.maxTotalBytes, LIMITS.maxTotalBytes);
  const maxProducts = o.maxProducts ?? LIMITS.maxProducts, maxPages = o.maxPages ?? LIMITS.maxPages;
  const perFile = o.perFileProducts ?? 400, maxFileBytes = o.maxFileBytes ?? 2 * MB;
  const slug = fileSlug(o.slug), store = mdLine(o.storeName) || o.slug || 'Store';
  const stamp = `Imported from ${o.base || 'the store website'} on ${(o.date || new Date()).toISOString().slice(0, 10)}. Each section names its source page.`;
  const capped = {};
  // de-duplicate
  const seen = new Set();
  docs = docs.filter((d) => { const k = `${d.kind}|${d.url}|${d.title}`; if (seen.has(k)) return false; seen.add(k); return d.text && d.title; });
  let products = docs.filter((d) => d.kind === 'product');
  const policies = docs.filter((d) => d.kind === 'policy');
  const faqs = docs.filter((d) => d.kind === 'faq');
  const pages = docs.filter((d) => d.kind === 'page');
  if (products.length > maxProducts || o.productsMore) capped.products = { limit: maxProducts, kept: Math.min(products.length, maxProducts), more: true };
  products = products.slice(0, maxProducts);
  const pageUrls = [...new Set([...policies, ...faqs, ...pages].map((d) => d.url))];
  let keepUrls = null;
  if (pageUrls.length > maxPages || o.pagesMore) { capped.pages = { limit: maxPages, kept: Math.min(pageUrls.length, maxPages), more: true }; keepUrls = new Set(pageUrls.slice(0, maxPages)); }
  const keep = (d) => !keepUrls || keepUrls.has(d.url);

  let used = 0, droppedSections = 0, droppedProducts = 0;
  const files = [];
  const taken = new Set();
  const nameOf = (base) => { let n = `${slug}-${base}.md`, i = 2; while (taken.has(n)) n = `${slug}-${base}-${i++}.md`; taken.add(n); return n; };
  // The heading stands alone (so every chunker keeps it as the section breadcrumb) and the Source line opens the section's
  // first paragraph (so the URL travels in the same atom as the first facts; trials.mjs looks it up for later atoms).
  const section = (d, level = 2) => `${'#'.repeat(level)} ${mdLine(d.title)}\n\nSource: ${d.url}\n${String(d.text).trim()}\n`;
  /** Add sections to new file(s) under the byte budget; returns how many sections were kept. */
  function emit(baseName, header, sections, { split = Infinity } = {}) {
    let cur = null, part = 0;
    const out = [];
    // +20 bytes reserves room for the " (part i of n)" suffix filled in below
    const open = () => { part++; cur = { head: header(part), body: [], docs: 0 }; cur.size = Buffer.byteLength(cur.head) + 20; out.push(cur); };
    for (const s of sections) {
      const sz = Buffer.byteLength(s.md) + 1;
      if (!cur || cur.docs >= split || cur.size + sz > maxFileBytes) { if (cur && !cur.docs) out.pop(); open(); }
      const headCost = cur.docs ? 0 : cur.size;
      if (used + headCost + sz > maxTotalBytes) { droppedSections++; if (s.product) droppedProducts++; continue; }
      used += headCost + sz;
      cur.body.push(s.md); cur.docs += s.n || 1; cur.size += sz;
    }
    const real = out.filter((f) => f.docs);
    real.forEach((f, i) => {
      const md = `${f.head.replace('{{N}}', real.length > 1 ? ` (part ${i + 1} of ${real.length})` : '')}\n${f.body.join('\n')}`;
      const name = real.length > 1 || split !== Infinity ? nameOf(`${baseName}-${i + 1}`) : nameOf(baseName);
      const bytes = Buffer.from(md, 'utf8');
      files.push({ name, bytes, mime: 'text/markdown', docs: f.docs, size: bytes.length });
    });
  }
  // policies: one file per policy (more than 12 → the rest share one file)
  const pol = policies.filter(keep);
  pol.slice(0, 12).forEach((d) => emit(fileSlug(mdLine(d.title)).slice(0, 40) || 'policy', () => `# ${mdLine(d.title)}: ${store}{{N}}\n\n${stamp}\n`, [{ md: section(d) }]));
  if (pol.length > 12) emit('policies', () => `# Policies: ${store}{{N}}\n\n${stamp}\n`, pol.slice(12).map((d) => ({ md: section(d) })));
  // FAQ: grouped by source page
  const groups = new Map();
  for (const d of faqs.filter(keep)) { const k = d.url; if (!groups.has(k)) groups.set(k, { title: d.group || 'FAQ', url: d.url, items: [] }); groups.get(k).items.push(d); }
  const faqSecs = [...groups.values()].map((g) => ({ n: g.items.length, md: `## ${mdLine(g.title)}\n\nSource: ${g.url}\n\n${g.items.map((d) => `### ${mdLine(d.title)}\n${String(d.text).trim()}\n`).join('\n')}` }));
  if (faqSecs.length) emit('faq', () => `# Frequently asked questions: ${store}{{N}}\n\n${stamp}\n`, faqSecs);
  const pgs = pages.filter(keep);
  if (pgs.length) emit('pages', () => `# Help and about pages: ${store}{{N}}\n\n${stamp}\n`, pgs.map((d) => ({ md: section(d) })));
  if (products.length) emit('products', () => `# Products: ${store}{{N}}\n\n${stamp} Prices and stock are as listed on the day of import.\n`, products.map((d) => ({ md: section(d), product: true })), { split: perFile });
  if (droppedSections) capped.bytes = { limit: maxTotalBytes, droppedSections, droppedProducts };
  return { files, capped: Object.keys(capped).length ? capped : null };
}

// ------------------------------------------------------------------------------------------------ orchestration
/** Import a store: detect, collect, build Markdown. See the integration block at the top of this file. */
export async function importStore(input, o = {}) {
  const emit = (ev, data) => { try { o.onEvent?.(ev, data); } catch {} };
  try {
    const start = normalizeStoreUrl(input);
    const remaining = o.remainingBytes ?? LIMITS.maxTotalBytes;
    if (!(remaining > 0)) throw err('quota');
    const caps = { maxProducts: Math.min(o.maxProducts ?? LIMITS.maxProducts, LIMITS.maxProducts), maxPages: Math.min(o.maxPages ?? LIMITS.maxPages, LIMITS.maxPages),
      maxTotalBytes: Math.max(0, Math.min(o.maxTotalBytes ?? LIMITS.maxTotalBytes, LIMITS.maxTotalBytes, remaining)) };
    const f = createStoreFetcher({ ...(o.net || {}), signal: o.signal, onProgress: (p) => emit('fetching', p) });
    f.allowSite(start.hostname);
    const det = await detectPlatform(start, f.fetch);
    f.allowSite(new URL(det.base).hostname);
    if (det.platform === 'shopify') f.allowHost('cdn.shopify.com');
    if (det.platform === 'squarespace') { f.allowHost('static1.squarespace.com'); f.allowHost('images.squarespace-cdn.com'); }
    emit('detect', { platform: det.platform, api: det.api, base: det.base, name: det.name });

    const skipped = { robots: 0, failed: 0, budget: 0 };
    const ctx = { f, base: det.base, det, caps, warnings: [], api: det.api, seenPages: new Set(), pageCount: 0, productPageCount: 0, productsMore: false, pagesMore: false,
      pageSize: o.pageSize, timeCapped: false,
      pageError(e) {
        if (FATAL.has(e.code)) throw e;
        if (e.code === 'robots') skipped.robots++;
        else if (e.budget) { skipped.budget++; ctx.timeCapped = true; }
        else if (e.code !== 'not_found') skipped.failed++;
      } };
    let docs = await COLLECTORS[det.platform](ctx);
    const counts = { products: docs.filter((d) => d.kind === 'product').length, pages: docs.filter((d) => d.kind === 'page').length,
      policies: docs.filter((d) => d.kind === 'policy').length, faqs: docs.filter((d) => d.kind === 'faq').length };
    f.flushProgress();
    emit('found', counts);
    if (!docs.length) throw err('no_content');

    const built = buildMarkdownFiles(docs, { ...caps, storeName: det.name || new URL(det.base).hostname, base: det.base, slug: new URL(det.base).hostname,
      date: o.date, productsMore: ctx.productsMore, pagesMore: ctx.pagesMore, perFileProducts: o.perFileProducts });
    emit('building', { files: built.files.map((x) => x.name) });
    let capped = built.capped;
    if (ctx.timeCapped) capped = { ...(capped || {}), time: true };
    if (capped) emit('capped', capped);
    if (!built.files.length) throw err('no_content');
    const out = { platform: det.platform, api: !!ctx.api, base: det.base, name: det.name, files: built.files, counts, capped, skipped, warnings: ctx.warnings,
      requests: f.stats.total, maxConcurrent: f.stats.maxActive };
    emit('done', { files: built.files.map((x) => ({ name: x.name, bytes: x.size, docs: x.docs })), platform: det.platform, counts });
    return out;
  } catch (e) {
    const se = e instanceof StoreImportError ? e : err('upstream', undefined, { cause: e });
    emit('error', { code: se.code, message: se.message });
    throw se;
  }
}
