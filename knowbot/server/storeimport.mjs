// KnowBot Studio: "Enter a Store URL" importer (server side). Zero dependencies (node: built-ins only).
//
// ============================================================================================================
// CONTRACT (trials.mjs runs this as a background job; see storeJob in trials.mjs)
// ============================================================================================================
//
//   importStore(url, {
//       remainingBytes: number,     // bytes left in the trial (100 MB quota minus what it holds); never exceeded
//       signal?: AbortSignal,       // cancel
//       onEvent?: (event, data) => void,
//       onFiles?: async ({ kind, files }) => void,   // a batch of built files (one page kind per batch), uploaded by
//                                   // the caller as soon as it is built; awaited (backpressure). Without onFiles the
//                                   // files are returned in result.files (tests, small imports).
//       budgetMs?: 20 min, maxProducts?: 10000, maxPages?: 500, maxCollections?: 200, maxBlog?: 100, maxPdfs?: 100,
//       enrich?: 'auto'|'thin'|'all'|'none',   // read product pages besides the feed (auto: thin feed copy, or all
//                                              // when the time budget allows)
//       batchFiles?: 40, batchBytes?: 2 MB, date?: Date, planOnly?: boolean,
//       skip?: { urls?: string[], paths?: string[] },   // resume: pages an interrupted run of this import already wrote
//                                   // (their URLs, and/or their file paths site/<host>/<kind>/<slug>.<ext>). They are
//                                   // neither read nor written again; result.report.already {kind:n} counts them.
//       net?: { ...createStoreFetcher options }   // tests only: allowAddresses, allowPorts:'any', resolve, paceMs
//   }) → Promise<{ platform, api, base, host, name, plan, files, counts, report, capped, skipped, warnings }>
//   It throws StoreImportError { code, message, status } after emitting `error`.
//
// Events (data is one JSON object):
//   detect   { platform, api, base, name }
//   discovering { step:'sitemaps'|'links', urls, … } the finder at work (sitemaps crawled, links and help desks read)
//   plan     { counts:{product,faq,policy,help,pdf,collection,blog,page}, samples:{kind:[url]}, total, robots, helpdesks,
//              feedTotal }                          what the finder found and will read, best sources first
//   found    { products, pages, policies, faqs, help, pdfs, collections, blog }   (the same counts, Studio copy names)
//   fetching { done, total }                        request progress (throttled)
//   reading  { kind, done, total, read:{kind:n} }   page progress (throttled)
//   building { files:[name], n }                    the first files are built (uploads start right away)
//   capped   { products?, pages?, bytes?, time? }   only when something was left out
//   built    { n, bytes, written:{kind:n}, report } every page is built and handed over
//   error    { code, message }
//
// FILE LAYOUT (knowDrive atoms; verified in production, see the research memo): one Markdown file per page,
//   path  site/<host>/<kind>/<slug>.md          kind: product | faq | policy | help | collection | blog | page
//   # <Page or product title> · <canonical URL>
//
//   Source: <canonical URL>
//
//   ## Price and availability / Description / Specs / Care / Shipping and returns / FAQ (### per question) / Reviews …
// knowDrive puts the heading path in front of every atom's text, always starting with the H1 (deep paths keep the
// first and last heading), and the H1 atom itself begins with the H1 line. So the product URL travels in EVERY atom
// of the file, including continuation fragments of long sections, which never repeat a Source line. PDFs are uploaded
// as they are (site/<host>/pdf/<slug>.pdf); their URL is kept by the caller in a manifest.
// ============================================================================================================

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { findSources, classifyUrl, normalizeUrl, urlKey, anchorsOf, canonicalOf, decodeEntities, robotsCrawlDelay, compareSources, KIND_RANK, KINDS } from './sitefinder.mjs';

export { decodeEntities, KINDS };
export const USER_AGENT = 'KnowBotStudio/1.0 (+https://knowbot.knowdrive.ai)';
const UA_TOKEN = 'knowbotstudio';
const MB = 1024 * 1024;
export const LIMITS = Object.freeze({ maxProducts: 10000, maxPages: 500, maxCollections: 200, maxBlog: 100, maxPdfs: 100, maxOtherPages: 50,
  maxTotalBytes: 100 * MB, timeoutMs: 15000, maxBytes: 5 * MB, maxPdfBytes: 20 * MB, budgetMs: 20 * 60000,
  concurrency: 4, paceMs: 150, maxRedirects: 5, maxRetries: 3, maxRetryAfterMs: 120000, maxPaceMs: 10000, slowMs: 4000 });
/** Bytes the caller adds to every file (trials.mjs uniqueCopy tail); counted against the quota here. */
export const FILE_OVERHEAD = 100;

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
  busy: 'A website import is already running for this bot.',
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
  + 'azurewebsites.net cloudfront.net amazonaws.com '
  // shared store and site-builder platforms (PSL private section): every tenant is its own site, never "same site"
  + 'wixsite.com wixstudio.io editorx.io mybigcommerce.com square.site webflow.io bigcartel.com company.site ecwid.com weebly.com '
  + 'weeblysite.com myshopline.com shoplineapp.com mystrikingly.com strikingly.com jimdosite.com jimdofree.com site123.me godaddysites.com '
  + 'onshopbase.com myshopbase.com shoplightspeed.com mylightspeed.app storenvy.com sellfy.store myvolusion.com 3dcartstores.com myshopwired.uk '
  + 'blogspot.com tumblr.com carrd.co gumroad.com ueniweb.com odoo.com wpengine.com kinsta.cloud shopifypreview.com '
  + 'square.online hubspotpagebuilder.com hs-sites.com framer.website framer.app notion.site super.site').split(' '));
/** Approximate registrable domain (eTLD+1) with a built-in suffix list (incl. shared store platforms, so a tenant
 *  such as shop.wixsite.com is its own site); IP literals are returned as-is. */
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
/** RFC 9309 parser: { groups:[{agents:[...], rules:[{allow, path}], crawlDelay?}], sitemaps:[...] } (Crawl-delay kept per group). */
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
    else if (key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n; }
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


async function defaultResolve(host) { return dns.promises.lookup(host, { all: true, verbatim: true }); }

/**
 * An SSRF-safe fetcher for one import run. Every request: http/https only, standard ports, DNS resolved here and
 * every address checked (the socket then connects to that checked address, so DNS rebinding can't swap it), same
 * registrable site (plus allowHost'ed help-desk hosts, and allowPdfHost'ed asset CDNs for .pdf paths only), robots.txt
 * honoured, redirects re-checked hop by hop (max 5), 15 s per request, 5 MB per body (after decompression), a total
 * time budget (20 min by default), at most 4 in flight with adaptive pacing (Crawl-delay floor, 429/Retry-After
 * backoff and retry, slow answers slow us down). No cookies are stored or sent; only UA/Accept/Accept-Encoding
 * (+content-type for GraphQL POSTs) go out.
 *
 * Options (tests): allowAddresses: ['127.0.0.1'] (default none), allowPorts: [80,443] | 'any', resolve(host) →
 * [{address,family}], timeoutMs, maxBytes, budgetMs, concurrency, paceMs, maxRedirects, maxRetries, maxRetryAfterMs,
 * signal, onProgress({done,total}).
 */
export function createStoreFetcher(o = {}) {
  const cfg = { ...LIMITS, resolve: defaultResolve, allowAddresses: [], allowPorts: [80, 443], userAgent: USER_AGENT, ...o };
  cfg.concurrency = Math.max(1, Math.min(4, Number(cfg.concurrency) || 4)); // politeness: never more than 4 in flight
  const allowAddr = new Set((cfg.allowAddresses || []).map(normIp));
  const sites = new Set(), hosts = new Set(), pdfHosts = new Set();
  const dnsCache = new Map(), robotsCache = new Map();
  const startedAt = Date.now();
  const deadline = startedAt + cfg.budgetMs;
  const stats = { done: 0, total: 0, bytes: 0, maxActive: 0, retries: 0, throttled: 0, pace: cfg.paceMs, crawlDelayMs: 0 };
  // adaptive pacing: `pace` ms between request starts. A 429/503 doubles it and pauses everything until Retry-After;
  // a slow answer adds a quarter; every 20 quick successes take a fifth off again, never below the floor
  // (max(paceMs, Crawl-delay)).
  let pace = cfg.paceMs, floor = cfg.paceMs, pauseUntil = 0, okStreak = 0;
  let active = 0, lastStart = 0, pumpTimer = null;
  const queue = [];

  const checkAbort = () => { if (cfg.signal?.aborted) throw err('aborted'); };
  const pastDeadline = () => Date.now() >= deadline;
  function pump() {
    while (queue.length && active < cfg.concurrency) {
      if (cfg.signal?.aborted || pastDeadline()) { const it = queue.shift(); it.rej(cfg.signal?.aborted ? err('aborted') : err('timeout', 'Time budget used up.', { budget: true })); continue; }
      const wait = Math.max(lastStart + pace, pauseUntil) - Date.now();
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
    // fixer r8 (D10): only an explicit non-standard port gets the port copy here; an implicit 80/443 is checked after
    // DNS and address blocking (resolveChecked), so an unknown host reads "couldn't reach" and a private one "public
    // web address", never a misleading port message
    if (u.port && !portOk(u)) throw err('blocked_host', 'Only standard web ports (80 and 443) can be read.');
    // asset hosts (cdn.shopify.com …) are allowed for PDF files only, still address-checked on every hop
    if (!anyHost && !hostOk(h) && !(pdfHosts.has(h) && /\.pdf$/i.test(u.pathname))) throw err('blocked_host', `${h} is not part of this store.`, { offSite: true });
  }
  function checkPortAfterResolve(u) {
    if (!portOk(u)) throw err('blocked_host', 'Only standard web ports (80 and 443) can be read.');
  }
  async function resolveChecked(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!dnsCache.has(h)) {
      dnsCache.set(h, (async () => {
        let addrs;
        if (net.isIP(h)) addrs = [{ address: h, family: net.isIP(h) }];
        else {
          try { addrs = await cfg.resolve(h); } catch { throw err('not_found', `We couldn't reach ${h}. Check the address.`); }
          addrs = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
        }
        if (!addrs.length) throw err('not_found', `We couldn't reach ${h}. Check the address.`);
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
        const parsed = parseRobots(r.body.toString('utf8'));
        // Crawl-delay is honoured from the first request on (the strictest one seen becomes the pacing floor)
        const cd = Math.min(30, robotsCrawlDelay(parsed, UA_TOKEN)) * 1000;
        if (cd > 0) { stats.crawlDelayMs = Math.max(stats.crawlDelayMs, cd); floor = Math.max(floor, cd); pace = Math.max(pace, floor); stats.pace = pace; }
        return parsed;
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
        const address = await resolveChecked(u.hostname);
        checkPortAfterResolve(u);
        if (!skipRobots && !(await robotsAllowed(u))) throw err('robots', `robots.txt asks us not to read ${u.pathname}.`, { path: u.pathname });
        let r;
        for (let attempt = 0; ; attempt++) {
          const t0 = Date.now();
          r = await schedule(() => rawRequest(u, address, { method, headers, body, maxBytes }));
          stats.bytes += r.body.length;
          if ((r.status === 429 || (r.status === 503 && r.headers['retry-after'] != null)) && attempt < cfg.maxRetries) {
            // honour 429/Retry-After: slow down for everyone, wait, then try the same request again
            stats.throttled++; stats.retries++;
            const wait = Math.min(cfg.maxRetryAfterMs, retryAfterMs(r.headers['retry-after']) ?? Math.max(1000, pace * 4));
            pace = Math.min(cfg.maxPaceMs, Math.max(pace * 2, 250)); okStreak = 0; stats.pace = pace;
            if (Date.now() + wait >= deadline) throw err('timeout', 'Time budget used up.', { budget: true });
            pauseUntil = Math.max(pauseUntil, Date.now() + wait);
            await sleepAbortable(wait, cfg.signal);
            continue;
          }
          const took = Date.now() - t0;
          if (r.status >= 500 || took > cfg.slowMs) { pace = Math.min(cfg.maxPaceMs, Math.max(pace * 1.25, floor + 50)); okStreak = 0; }
          else if (++okStreak >= 20 && pace > floor) { pace = Math.max(floor, pace * 0.8); okStreak = 0; }
          stats.pace = pace;
          break;
        }
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
    /** Allow `host` for .pdf paths only (an asset CDN such as cdn.shopify.com). */
    allowPdfHost(host) { pdfHosts.add(String(host).toLowerCase()); },
    /** robots.txt Crawl-delay (seconds, capped at 30): becomes the pacing floor. */
    setCrawlDelay(sec) { const ms = Math.min(30, Math.max(0, Number(sec) || 0)) * 1000; stats.crawlDelayMs = Math.max(stats.crawlDelayMs, ms); floor = Math.max(floor, ms); pace = Math.max(pace, floor); stats.pace = pace; },
    get pace() { return pace; },
    /** True when `url` is http(s) on this store's site (or an allowed CDN host). */
    hostOkFor(url) { try { const x = new URL(url); return (x.protocol === 'http:' || x.protocol === 'https:') && hostOk(x.hostname); } catch { return false; } },
    /** True when `url` may be fetched as a PDF: on this site, or a .pdf on an allowPdfHost'ed asset host. */
    pdfOkFor(url) { try { const x = new URL(url); return (x.protocol === 'http:' || x.protocol === 'https:') && (hostOk(x.hostname) || (pdfHosts.has(x.hostname.toLowerCase()) && /\.pdf$/i.test(x.pathname))); } catch { return false; } },
    timeLeft: () => deadline - Date.now(),
    flushProgress: () => progress(true),
  };
}
/** Retry-After as ms: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(v) {
  if (v == null || v === '') return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(err('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(err('aborted')); };
    signal?.addEventListener?.('abort', on, { once: true });
  });
}
function netError(e, u) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return err('not_found', `We couldn't reach ${u.hostname}. Check the address.`);
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EPIPE') return err('unreachable', `${u.host} didn't answer.`);
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(String(c || e?.message))) return err('unreachable', `${u.host} has a certificate problem.`);
  return err('unreachable', `${u.host} didn't answer.`);
}

// ------------------------------------------------------------------------------------------------ HTML helpers
const oneLine = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const STRIP_BLOCKS_RE = /<(script|style|noscript|template|svg|iframe|object|embed|canvas|form|select|button|dialog|video|audio|picture)\b[\s\S]*?<\/\1\s*>/gi;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);

/**
 * Remove every element whose opening tag matches pred(tagName, openTagText), with its whole subtree (nesting of the
 * same tag is counted). An element that is never closed loses only its opening tag.
 */
export function removeElements(html, pred) {
  const s = String(html ?? '');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  let out = '', last = 0, skip = null, m;
  while ((m = re.exec(s))) {
    const close = !!m[1], name = m[2].toLowerCase(), self = !!m[3];
    if (skip) {
      if (name === skip.tag) { if (close) { if (--skip.depth === 0) { last = re.lastIndex; skip = null; } } else if (!self) skip.depth++; }
      continue;
    }
    if (!close && !self && !VOID.has(name) && pred(name, m[0])) { out += s.slice(last, m.index); skip = { tag: name, depth: 1, openEnd: re.lastIndex }; }
  }
  if (skip) return out + s.slice(skip.openEnd);
  return out + s.slice(last);
}
const CHROME_TAG_RE = /^(?:nav|header|footer|aside)$/;
const CHROME_ATTR_RE = /\brole\s*=\s*["']?(?:navigation|banner|contentinfo|dialog|alertdialog|search)\b|\b(?:id|class)\s*=\s*["'][^"']*?(?:cookie|consent|gdpr|onetrust|cookiebot|cc-window|cc-banner|newsletter|klaviyo|mailchimp|popup|pop-up|announcement|breadcrumb|site-nav|site-header|site-footer|mega-?menu|skip-to|skip-link|visually-hidden|sr-only|share-buttons|social-share|recently-viewed|you-may-also-like|related-products|product-recommendations|upsell|cross-sell)[^"']*["']/i;
/** Drop navigation, header, footer, asides, cookie/consent banners, newsletter pop-ups, breadcrumbs and "related" rails. */
export function stripBoilerplate(html) {
  return removeElements(html, (name, tag) => CHROME_TAG_RE.test(name) || CHROME_ATTR_RE.test(tag));
}
/**
 * Page-builder shortcodes (Divi, WPBakery, Avada …) that leak into WordPress content: accordion and toggle items become
 * <details><summary>title</summary>body</details> (their titles are the FAQ questions), tabs become headings, every
 * other shortcode tag is dropped and its inner text kept.
 */
export function convertShortcodes(html) {
  const attr = (a, k) => decodeEntities(new RegExp(`\\b${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|&#8221;([^&]*)&#8221;|&#8243;([^&]*)&#8243;)`).exec(a)?.slice(1).find((x) => x != null) || '');
  return String(html ?? '')
    .replace(/\[(et_pb_accordion_item|et_pb_toggle|vc_tta_section|fusion_toggle|av_toggle)\b([^\]]*)\]([\s\S]*?)\[\/\1\]/g, (m, tag, a, body) => {
      const t = attr(a, 'title') || attr(a, 'heading');
      return t ? `<details><summary>${t.replace(/</g, '&lt;')}</summary>${body}</details>` : body;
    })
    .replace(/\[(?:et_pb_tab|vc_tab)\b([^\]]*)\]/g, (m, a) => { const t = attr(a, 'title'); return t ? `<h3>${t.replace(/</g, '&lt;')}</h3>` : ' '; })
    .replace(/\[\/?(?:et_pb_|vc_|fusion_|av_|cs_|x_|themify_|tatsu_|su_|ux_|fl_|elementor)[a-z_0-9-]*\b[^\]]*\]/gi, ' ');
}
function mainOf(html) {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html) || /<article\b[^>]*>([\s\S]*)<\/article\s*>/i.exec(html);
  if (m) return m[1];
  const r = /<[a-z]+\b[^>]*(?:role=["']main["']|id=["'](?:main-?content|maincontent|content|main)["'])[^>]*>/i.exec(html);
  if (r) return html.slice(r.index);
  const b = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  return b ? b[1] : html;
}
/**
 * Imported text can never forge our structure: a line starting with # (ATX heading), "Source:" or "Product page:" is
 * escaped, and so is a setext underline (a line of only '=' or '-' right under a text line, which CommonMark turns
 * into an H1/H2 that would replace the page's H1 in every later atom's breadcrumb).
 */
export function escapeText(text) {
  const lines = String(text ?? '').replace(/^(\s*)(#{1,6})(?=\s|$)/gm, '$1\\$2').replace(/^(\s*)(Source\s*:|Product page\s*:)/gim, '$1\\$2').split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i]) && lines[i - 1].trim()) lines[i] = lines[i].replace(/^( {0,3})/, '$1\\');
  }
  return lines.join('\n');
}
/**
 * Readable text of an HTML page or fragment: scripts/styles/forms stripped, shortcodes converted, boilerplate dropped
 * (main=true), headings rendered as Markdown starting at `minLevel`, lists as `- `, and any `#` or `Source:` the page
 * itself begins a line with escaped, so imported text can never forge a section heading or a source link.
 */
export function htmlToText(html, { main = true, minLevel = 3 } = {}) {
  let s = convertShortcodes(String(html ?? '').replace(/[\u0001\u0002]/g, ''));
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(STRIP_BLOCKS_RE, ' ').replace(/<(script|style)\b[^>]*\/>/gi, ' ');
  s = main ? stripBoilerplate(mainOf(s)) : stripBoilerplate(s);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, l, t) => {
    const txt = oneLine(t); if (!txt) return '\n';
    return `\n\n\u0001${Math.min(6, minLevel + Math.max(0, Number(l) - 2))}\u0002 ${txt.replace(/^#+\s*/, '')}\n\n`;
  });
  s = s.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi, (_, t) => `\n\n**${oneLine(t)}**\n\n`);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:td|th)\s*>/gi, ' · ')
    .replace(/<\/?(?:p|div|section|article|ul|ol|table|tr|blockquote|dl|dt|dd|details|summary|figure|figcaption|pre|address|main|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\u0000/g, '');
  const lines = s.split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim().replace(/\s·$/, ''));
  let out = lines.filter((l) => l !== '-').join('\n').replace(/\n{3,}/g, '\n\n').trim();
  out = escapeText(out);
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
/**
 * The site's own brand, as its home page states it in <head>: <meta name="theme-color"> (a #hex only) and a square
 * icon (apple-touch-icon, else an icon link with sizes 64+ or an SVG), absolute https only. Nothing is guessed: no
 * colour sampled from images, no og:image (usually a product photo). { color, logo } or null.
 */
export function brandOfHtml(html, base) {
  const head = String(html || '').slice(0, 200000);
  const attr = (tag, name) => new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;
  let color = null, logo = null;
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname=["']theme-color["']/i.test(m[0]) || /\bmedia=["'][^"']*dark/i.test(m[0])) continue;
    const c = String(attr(m[0], 'content') || '').trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) { color = c.toLowerCase(); break; }
  }
  const icons = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /\brel=["'][^"']*icon[^"']*["']/i.test(t));
  const score = (t) => { const rel = String(attr(t, 'rel') || '').toLowerCase(); const href = String(attr(t, 'href') || ''); const size = Number(/(\d+)x\d+/.exec(String(attr(t, 'sizes') || ''))?.[1] || 0);
    return rel.includes('apple-touch-icon') ? 3 : /\.svg(?:$|\?)/i.test(href) ? 2 : size >= 64 ? 1 : 0; };
  const best = icons.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a))[0];
  if (best) {
    try { const u = new URL(String(attr(best, 'href') || ''), base); if (u.protocol === 'https:' && u.href.length <= 500) logo = u.href; } catch { /* not a URL */ }
  }
  return color || logo ? { color, logo } : null;
}

/**
 * Whether the home page lets another site show it in a frame (the Homepage search's hosted link shows its overlay over
 * the real homepage only then). Response headers as a plain object (lower-case names). Any X-Frame-Options value, or a
 * CSP frame-ancestors list without "*", "https:" or the KnowBot host, means no. Unknown (no headers) is no.
 */
export function frameableOf(headers, host = 'knowbot.knowdrive.ai') {
  if (!headers || typeof headers !== 'object') return false;
  const get = (n) => [].concat(headers[n] ?? []).join(',');
  if (get('x-frame-options').trim()) return false;
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(get('content-security-policy'))?.[1];
  if (fa == null) return true;
  return fa.split(/\s+/).some((t) => t === '*' || t === 'https:' || t.replace(/^https:\/\//, '').replace(/\/$/, '') === host || t === `https://*.${host.split('.').slice(1).join('.')}`);
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
  while ((m = re.exec(String(html ?? '')))) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { walk(JSON.parse(raw)); } catch { try { walk(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch {} }
  }
  return out;
}
const typeIs = (o, t) => [].concat(o?.['@type'] || []).some((x) => String(x).replace(/^.*[/#]/, '') === t);
/** Q/A pairs on a page: <details><summary> (and converted accordions), else headings / bold lines that end with '?'. */
export function faqPairsFromHtml(html) {
  const pairs = [];
  const body = stripBoilerplate(mainOf(convertShortcodes(String(html ?? '')).replace(STRIP_BLOCKS_RE, ' ')));
  const dre = /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>/gi;
  let m;
  while ((m = dre.exec(body))) { const q = oneLine(m[1]), a = htmlToText(m[2], { main: false, minLevel: 5 }); if (q && a) pairs.push({ q, a }); }
  if (pairs.length >= 1) return pairs;
  const text = htmlToText(body, { main: false, minLevel: 3 });
  const blocks = text.split(/\n(?=#{3,6} |\*\*[^\n]+\?\*\*\s*$)/m);
  const hq = [];
  for (const b of blocks) {
    const hm = /^(?:#{3,6} (.+\?)|\*\*(.+\?)\*\*)\s*\n([\s\S]+)$/.exec(b.trim());
    if (hm) { const a = hm[3].trim().replace(/^#{3,6} .*$/gm, '').trim(); if (a) hq.push({ q: (hm[1] || hm[2]).trim(), a }); }
  }
  return hq.length >= 2 ? hq : pairs;
}
/** FAQPage JSON-LD → [{q, a}]. */
function ldFaqs(ld) {
  const out = [];
  for (const o of ld) {
    if (!typeIs(o, 'FAQPage')) continue;
    for (const q of [].concat(o.mainEntity || [])) {
      const a = [].concat(q?.acceptedAnswer || [])[0];
      const qt = oneLine(q?.name), at = a ? htmlToText(String(a.text || ''), { main: false, minLevel: 5 }) : '';
      if (qt && at) out.push({ q: qt, a: at });
    }
  }
  return out;
}
/** Markdown (our `## ` headings) → [{ heading|null, text }]. */
function splitSections(md) {
  const out = [];
  let cur = { heading: null, lines: [] };
  for (const line of String(md || '').split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) { out.push(cur); cur = { heading: h[1].trim(), lines: [] }; continue; }
    cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s) => s.text || s.heading);
}
const normPara = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ documents
// A document is one page: { kind, url, title, sections:[{ heading|null, text, html? }], pdfs:[{url, text}] }, or a PDF
// { kind:'pdf', url, title, bytes, mime }. renderMarkdown turns it into the file layout described at the top.
const fmtMoney = (v, cur) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return null;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${s} ${cur}` : s;
};
const AVAIL = (a) => (a == null ? null : a === true ? 'in stock' : a === false ? 'out of stock'
  : String(a).replace(/^.*[/#]/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
const cleanTitle = (s) => clip(oneLine(s), 200).replace(/^#+\s*/, '');

/** Fact lines for a product record; every line names its product (a line is quoted on its own). */
export function productFacts(p) {
  const name = cleanTitle(p.title) || 'Untitled product';
  const L = [];
  const fact = (key, value) => L.push(`- ${name} ${key}: ${value}`);
  const price = fmtMoney(p.price, p.currency);
  const was = fmtMoney(p.compareAt, p.currency);
  if (price) fact('price', `${price}${was && Number(p.compareAt) > Number(p.price) ? ` (was ${was})` : ''}${p.priceMax && Number(p.priceMax) > Number(p.price) ? ` to ${fmtMoney(p.priceMax, p.currency)}` : ''}`);
  if (p.brand) fact('brand', oneLine(p.brand));
  if (p.type) fact('type', oneLine(p.type));
  if (p.sku) fact('SKU', oneLine(p.sku));
  const vs = (p.variants || []).filter((v) => v && v.title && !/^default( title)?$/i.test(v.title));
  // a product-level "in stock" is never written when any option is out: mixed stock names the options in stock
  const vIn = (v) => v.available === true || /^in ?stock$/i.test(String(v.available ?? '').trim());
  const vOut = (v) => v.available === false || /^(?:out ?of ?stock|sold ?out)$/i.test(String(v.available ?? '').trim());
  let availability = p.availability || null;
  if (vs.length && vs.some(vOut)) {
    const inStock = vs.filter(vIn).map((v) => oneLine(v.title));
    availability = inStock.length ? `only some options in stock (${inStock.slice(0, 8).join(', ')}${inStock.length > 8 ? ' and more' : ''})`
      : vs.every(vOut) ? 'out of stock' : null;
  }
  if (availability) fact('availability', availability);
  if (vs.length) {
    L.push(`- ${name} variants:`);
    for (const v of vs.slice(0, 100)) {
      const bits = [fmtMoney(v.price, p.currency), v.sku ? `SKU ${oneLine(v.sku)}` : null, v.available == null ? null : AVAIL(v.available)].filter(Boolean);
      const vt = oneLine(v.title);
      L.push(`  - ${vt.toLowerCase().startsWith(name.toLowerCase()) ? vt : `${name} ${vt}`}${bits.length ? `: ${bits.join(', ')}` : ''}`);
    }
    if (vs.length > 100) L.push(`  - …and ${vs.length - 100} more variants`);
  }
  if (p.options?.length) fact('options', p.options.map((o) => `${oneLine(o.name)} (${o.values.map(oneLine).join(', ')})`).join('; '));
  if (p.categories?.length) fact('categories', p.categories.map(oneLine).filter(Boolean).join(', '));
  if (p.tags?.length) fact('tags', p.tags.map(oneLine).filter(Boolean).join(', '));
  return escapeText(L.join('\n'));
}
/** A product record ({title, url, price, …, descriptionHtml}) as a document. */
export function productDoc(p) {
  const title = cleanTitle(p.title) || 'Untitled product';
  const sections = [];
  const facts = productFacts(p);
  if (facts) sections.push({ heading: 'Price and availability', text: facts });
  const desc = p.descriptionHtml != null ? htmlToText(p.descriptionHtml, { main: false, minLevel: 3 }) : escapeText(String(p.description || '').trim());
  if (desc) sections.push({ heading: 'Description', text: clip(desc, 12000) });
  return { kind: 'product', url: p.url, title, sections, pdfs: [...(p.pdfs || [])], record: p };
}
function recordFromLd(o, pageUrl) {
  const offers = [].concat(o.offers || []).flatMap((x) => (typeIs(x, 'AggregateOffer') && x.offers ? [].concat(x.offers) : [x]));
  const first = offers[0] || {};
  const agg = [].concat(o.offers || []).find((x) => typeIs(x, 'AggregateOffer'));
  const variants = [].concat(o.hasVariant || []).map((v) => { const vo = [].concat(v.offers || [])[0] || {}; return { title: v.name, sku: v.sku, price: vo.price, available: vo.availability ? AVAIL(vo.availability) : null }; });
  return { title: o.name, url: pageUrl, sku: o.sku, brand: typeof o.brand === 'object' ? o.brand?.name : o.brand,
    price: agg?.lowPrice ?? first.price ?? first.priceSpecification?.price, priceMax: agg?.highPrice, currency: agg?.priceCurrency || first.priceCurrency || first.priceSpecification?.priceCurrency,
    availability: first.availability ? AVAIL(first.availability) : null, variants, categories: o.category ? [].concat(o.category).map(String) : [],
    descriptionHtml: o.description ? String(o.description) : '' };
}
const SECTION_NAMES = [
  ['FAQ', /\b(?:faqs?|frequently asked|questions?)\b/i],
  ['Reviews', /\b(?:reviews?|ratings?|testimonials?)\b/i],
  ['Shipping and returns', /\b(?:shipping|delivery|returns?|refunds?|exchanges?|warrant(?:y|ies)|guarantee)\b/i],
  ['Care', /\b(?:care|wash(?:ing)?|cleaning|maintenance|storage)\b/i],
  ['Specs', /\b(?:specs?|specifications?|dimensions?|measurements?|materials?|fabric|composition|weight|technical|tech specs|features?|ingredients|size(?: and fit| & fit| guide| chart)?|fit|what'?s included|in the box|details)\b/i],
  ['Description', /\b(?:description|overview|about this|product info(?:rmation)?)\b/i],
];
const sectionName = (h) => SECTION_NAMES.find(([, re]) => re.test(h))?.[0] || null;
/** Product-page reviews as text: aggregateRating and up to 5 written reviews from JSON-LD. */
function ldReviews(p) {
  const L = [];
  const ar = p?.aggregateRating;
  if (ar && ar.ratingValue != null) L.push(`Rated ${oneLine(ar.ratingValue)} out of ${oneLine(ar.bestRating ?? 5)}${ar.reviewCount ?? ar.ratingCount ? ` from ${oneLine(ar.reviewCount ?? ar.ratingCount)} reviews` : ''}.`);
  for (const r of [].concat(p?.review || []).slice(0, 5)) {
    const body = oneLine(r?.reviewBody || r?.description || '');
    if (!body) continue;
    const who = oneLine(typeof r.author === 'object' ? r.author?.name : r.author);
    const stars = r.reviewRating?.ratingValue != null ? ` (${oneLine(r.reviewRating.ratingValue)}/${oneLine(r.reviewRating.bestRating ?? 5)})` : '';
    L.push(`- ${clip(body, 600)}${who ? ` (${clip(who, 60)})` : ''}${stars}`);
  }
  return escapeText(L.join('\n'));
}
/** .pdf links in the main content of a page: [{url, text}] (manuals, spec sheets, size charts first). */
function pdfLinksOf(html, pageUrl) {
  const main = stripBoilerplate(mainOf(String(html ?? '').replace(STRIP_BLOCKS_RE, ' ')));
  const out = new Map();
  for (const a of anchorsOf(main, pageUrl)) if (/\.pdf$/i.test(new URL(a.url).pathname) && !out.has(a.url)) out.set(a.url, { url: a.url, text: a.text, from: pageUrl });
  return [...out.values()];
}

/**
 * A product page's HTML on top of what the feed gave (rec, may be null): JSON-LD Product, FAQPage and reviews, the
 * page's own sections (specs, care, shipping and returns, FAQ …, boilerplate stripped), its PDF links and canonical URL.
 * Paragraphs that repeat the feed description are dropped. → doc | null (no product on the page and no record).
 */
export function readProductHtml(html, pageUrl, rec = null, { requireLd = false } = {}) {
  const ld = jsonLdBlocks(html);
  const ldp = ld.find((o) => (typeIs(o, 'Product') || typeIs(o, 'ProductGroup')) && o.name);
  if (!rec && !ldp && requireLd) return null;
  const canonical = canonicalOf(html, pageUrl);
  const url = rec?.url || canonical || pageUrl;
  const record = rec || (ldp ? recordFromLd(ldp, url) : { title: titleOfHtml(html) || url, url });
  const doc = productDoc(record);
  doc.canonical = canonical;
  const descNorm = normPara((doc.sections.find((s) => s.heading === 'Description')?.text || ''));
  const title = doc.title.toLowerCase();
  const merged = new Map();
  for (const s of splitSections(htmlToText(html, { main: true, minLevel: 2 }))) {
    const paras = s.text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => {
      const n = normPara(p);
      if (!n || n.split(' ').filter((w) => /[a-z]{2}/.test(w)).length < 3) return false; // "Quantity", "$799.00", "Add to cart"
      if (descNorm && n.length > 20 && descNorm.includes(n)) return false;
      return true;
    });
    if (!paras.length) continue;
    let name = s.heading && s.heading.toLowerCase() !== title ? (sectionName(s.heading) || clip(s.heading.replace(/[*_`]+/g, ''), 80)) : 'From the product page';
    if (name === 'Description') name = 'More about this product';
    const prev = merged.get(name);
    merged.set(name, prev ? `${prev}\n\n${paras.join('\n\n')}` : paras.join('\n\n'));
  }
  const faqs = [...ldFaqs(ld), ...(merged.has('FAQ') ? faqPairsFromHtml(html) : [])];
  if (faqs.length) merged.delete('FAQ');
  const reviewsLd = ldReviews(ldp);
  for (const [heading, text] of merged) {
    if (heading === 'Reviews' && text.replace(/\s+/g, ' ').length < 40) continue;
    // a recognised section (specs, care, shipping …) is product copy even when many products share it: never filtered
    doc.sections.push({ heading, text: clip(text, 12000), html: true, ...(SECTION_NAMES.some(([n]) => n === heading) ? { keep: true } : {}) });
  }
  if (faqs.length) {
    const seen = new Set();
    doc.sections.push({ heading: 'FAQ', text: faqs.filter((f) => !seen.has(f.q) && seen.add(f.q)).map((f) => `### ${headText(f.q)}\n${clip(f.a, 3000)}`).join('\n\n'), html: true });
  }
  if (reviewsLd && !merged.has('Reviews')) doc.sections.push({ heading: 'Reviews', text: reviewsLd });
  doc.pdfs = [...doc.pdfs, ...pdfLinksOf(html, pageUrl)];
  return doc;
}
/**
 * A help, policy, FAQ, collection, blog or other page as a document. FAQ pages become one `##` section per question
 * (each question is its own atom); other pages keep their own headings as `##` sections.
 */
export function readPageHtml(html, pageUrl, { kind = 'help', title = null } = {}) {
  const ld = jsonLdBlocks(html);
  const t = cleanTitle(title || titleOfHtml(html) || new URL(pageUrl).pathname);
  const canonical = canonicalOf(html, pageUrl);
  let faqs = ldFaqs(ld);
  if (!faqs.length && (kind === 'faq' || /\b(?:faqs?|questions)\b/i.test(t))) faqs = faqPairsFromHtml(html);
  const doc = { kind, url: pageUrl, title: t, sections: [], pdfs: pdfLinksOf(html, pageUrl), canonical };
  if (faqs.length >= 2 || (faqs.length && kind === 'faq')) {
    if (kind !== 'faq' && kind !== 'policy') doc.kind = 'faq';
    const seen = new Set();
    for (const f of faqs) if (!seen.has(f.q)) { seen.add(f.q); doc.sections.push({ heading: f.q, text: clip(f.a, 8000), html: true }); }
    return doc;
  }
  const secs = splitSections(htmlToText(html, { main: true, minLevel: 2 }));
  for (const s of secs) {
    if (s.heading && s.heading.toLowerCase() === t.toLowerCase()) { if (s.text) doc.sections.push({ heading: null, text: s.text, html: true }); continue; }
    doc.sections.push({ heading: s.heading, text: s.text, html: true });
  }
  return doc;
}

// ------------------------------------------------------------------------------------------------ Markdown files
/** Our own heading text: one line, no leading #, no " > " (the breadcrumb separator), no forged " · <url>" tail. */
export function headText(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/^[#\s]+/, '').replace(/\s+>\s+/g, ' › ').replace(/\s·\s+(?=https?:)/gi, ' - ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'Untitled';
}
/** A file-name part: no path separators or control characters, single spaces, at most 60 characters. */
const displayPart = (s) => String(s ?? '').replace(/[\0-\x1f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60).trim();
/** The Markdown of one page document (deterministic: same document, same bytes). */
export function renderMarkdown(doc) {
  const url = doc.url;
  const out = [`# ${headText(doc.title)} · ${url}`, '', `Source: ${url}`];
  for (const s of doc.sections) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    if (s.heading) out.push('', `## ${headText(s.heading)}`, '', text);
    else out.push(text);
  }
  if (doc.kind === 'product' && doc.pdfs?.length) out.push('', '## Downloads', '', doc.pdfs.slice(0, 20).map((p) => `- ${headText(p.text || 'Document')} (PDF): ${p.url}`).join('\n'));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
const shortHash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
/** A stable slug for a page URL (last meaningful path segment). */
export function slugOf(url) {
  let p = '';
  try { p = decodeURIComponent(new URL(url).pathname); } catch { try { p = new URL(url).pathname; } catch { p = String(url || ''); } }
  const segs = p.split('/').filter(Boolean).map((x) => x.replace(/\.(?:html?|php|aspx?|pdf)$/i, ''));
  const last = segs.length ? segs[segs.length - 1] : 'home';
  return String(last).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `page-${shortHash(url)}`;
}

/**
 * Counts of repeated paragraphs across HTML pages: text on more than half the pages (and at least 3) is boilerplate.
 * Paragraphs are counted by a 64-bit hash (16 hex of sha1), never by their text, and keys seen only once are pruned
 * every 1,000 pages, so 10,000 product pages hold a few thousand short keys, not every paragraph of the store.
 */
function createRepeatFilter({ pruneEvery = 1000 } = {}) {
  const counts = new Map();
  let pages = 0;
  const keyOf = (n) => createHash('sha1').update(n).digest('hex').slice(0, 16);
  const parasOf = (doc) => doc.sections.filter((s) => s.html && !s.keep).flatMap((s) => s.text.split(/\n{2,}/)).map(normPara).filter((n) => n.length >= 30);
  return {
    observe(doc) {
      const ps = new Set(parasOf(doc).map(keyOf)); if (!ps.size) return false;
      pages++;
      for (const p of ps) counts.set(p, (counts.get(p) || 0) + 1);
      if (pages % pruneEvery === 0) for (const [k, c] of counts) if (c <= 1) counts.delete(k);
      return true;
    },
    get pages() { return pages; },
    get keys() { return counts.size; },
    apply(doc) {
      if (pages < 4) return doc;
      const boiler = (p) => { const n = normPara(p); if (n.length < 30) return false; const c = counts.get(keyOf(n)) || 0; return c >= 3 && c / pages > 0.5; };
      const sections = doc.sections.map((s) => (s.html && !s.keep ? { ...s, text: s.text.split(/\n{2,}/).filter((p) => !boiler(p)).join('\n\n') } : s)).filter((s) => s.text.trim());
      return { ...doc, sections };
    },
  };
}

/**
 * The file writer: documents in, Markdown (or PDF) files out, in batches of one page kind, under a byte budget.
 * add() is serialised (docs arrive from parallel readers); the first 10 HTML pages are held back so repeated blocks can
 * be recognised before anything is written. → { add(doc), finish(), stats }
 */
function createWriter({ maxTotalBytes, storeName, siteHost, onFiles, emit, batchFiles = 40, batchBytes = 2 * MB, warmPages = 10, maxBatchAgeMs = 3000, isDone = null }) {
  const label = displayPart(storeName) || displayPart(siteHost) || 'Store';
  const stats = { used: 0, files: 0, written: {}, leftOut: {}, bytesByKind: {} };
  const out = [];
  const taken = new Set();
  const batches = new Map();
  // repeated blocks are per template: product pages are compared with product pages, other pages with other pages
  const filters = new Map(), held = new Map(), warm = new Set();
  const groupOf = (doc) => (doc.kind === 'product' ? 'product' : 'page');
  const filterOf = (g) => { if (!filters.has(g)) filters.set(g, createRepeatFilter()); return filters.get(g); };
  let q = Promise.resolve(), announced = false;
  const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  async function flush(kind) {
    const b = batches.get(kind);
    if (!b || !b.files.length) return;
    batches.delete(kind);
    if (onFiles) await onFiles({ kind, files: b.files });
  }
  async function write(doc) {
    const d = doc.kind === 'pdf' ? doc : filterOf(groupOf(doc)).apply(doc);
    let bytes, ext, mime;
    if (d.kind === 'pdf') { bytes = d.bytes; ext = 'pdf'; mime = 'application/pdf'; }
    else {
      if (!d.sections.some((s) => String(s.text || '').trim())) return;
      bytes = Buffer.from(renderMarkdown(d), 'utf8'); ext = 'md'; mime = 'text/markdown';
    }
    const size = bytes.length;
    if (stats.used + size + FILE_OVERHEAD > maxTotalBytes) { inc(stats.leftOut, d.kind); return; }
    let host = siteHost;
    try { const h = new URL(d.url).hostname.toLowerCase(); if (d.kind !== 'pdf') host = h; } catch {}
    let slug = slugOf(d.url);
    let rel = `site/${host}/${d.kind}/${slug}.${ext}`;
    if (taken.has(rel)) { slug = `${slug}-${shortHash(d.url)}`; rel = `site/${host}/${d.kind}/${slug}.${ext}`; }
    if (taken.has(rel)) return;
    // resume: a page the interrupted run already wrote (its URL, or its file path) is not written twice
    if (isDone && isDone(d.url, d.kind, rel)) return;
    taken.add(rel);
    stats.used += size + FILE_OVERHEAD; stats.files++; inc(stats.written, d.kind); inc(stats.bytesByKind, d.kind, size);
    const title = headText(d.title);
    const file = { path: rel, name: `${label} · ${displayPart(title) || 'Page'}.${ext}`, title, url: d.url, kind: d.kind, host, bytes, mime, size, docs: 1 };
    if (!announced) { announced = true; emit('building', { files: [file.name], n: 1 }); }
    if (onFiles) {
      let b = batches.get(d.kind);
      if (!b) { b = { files: [], bytes: 0, at: Date.now() }; batches.set(d.kind, b); }
      b.files.push(file); b.bytes += size;
      const limit = d.kind === 'product' ? batchFiles : d.kind === 'pdf' ? 1 : 10;
      // a batch also goes up once it is a few seconds old, so a slow crawl still feeds knowDrive steadily
      if (b.files.length >= limit || b.bytes >= batchBytes || Date.now() - b.at >= maxBatchAgeMs) await flush(d.kind);
      out.push({ ...file, bytes: undefined });
    } else out.push(file);
  }
  async function release(g) { const h = held.get(g) || []; held.delete(g); for (const x of h) await write(x); }
  async function addNow(doc) {
    const g = groupOf(doc), fl = filterOf(g);
    if (doc.kind !== 'pdf' && fl.observe(doc) && !warm.has(g)) {
      if (!held.has(g)) held.set(g, []);
      held.get(g).push(doc);
      if (fl.pages >= warmPages) { warm.add(g); await release(g); }
      return;
    }
    await write(doc);
  }
  return {
    stats, files: out,
    add(doc) { q = q.then(() => addNow(doc)); return q; },
    /** Hand over every pending batch (between reading phases: help pages go up before the products are read). */
    flushAll() {
      q = q.then(async () => {
        for (const g of [...held.keys()]) await release(g); // what is held goes now (later pages still warm up)
        for (const k of [...batches.keys()]) await flush(k);
      });
      return q;
    },
    async finish() {
      await q;
      for (const g of [...held.keys()]) { warm.add(g); await release(g); }
      for (const k of [...batches.keys()].sort((a, b) => (KIND_RANK[a] ?? 9) - (KIND_RANK[b] ?? 9))) await flush(k);
      return out;
    },
  };
}
/**
 * Build files from documents synchronously (no batching, no repeated-block filter): { files, capped, leftOut }.
 * Kept for callers and tests that hold all documents at once.
 */
export async function buildMarkdownFiles(docs, o = {}) {
  const files = [];
  const w = createWriter({ maxTotalBytes: o.maxTotalBytes ?? LIMITS.maxTotalBytes, storeName: o.storeName, siteHost: o.host || 'site', emit: () => {}, warmPages: Infinity,
    onFiles: async (b) => { files.push(...b.files); } });
  for (const d of [...docs].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))) await w.add(d);
  await w.finish();
  return { files, leftOut: w.stats.leftOut, capped: Object.keys(w.stats.leftOut).length ? { bytes: { limit: o.maxTotalBytes, droppedProducts: w.stats.leftOut.product || 0, droppedSections: Object.values(w.stats.leftOut).reduce((a, b) => a + b, 0) } } : null };
}

// ------------------------------------------------------------------------------------------------ platform detection
const hasHeader = (h, re) => Object.keys(h || {}).some((k) => re.test(k));
/**
 * Detect the store platform. `fetchFn` is a createStoreFetcher().fetch (or anything with the same contract:
 * (url, {method, body, headers, accept, anyHost}) → {status, ok, url, headers, body, text(), json()}).
 * → { platform, api, base, name, currency, signals:[...], home:{url, html}, apiBase? }
 * platform: shopify | magento | squarespace | woocommerce (feeds) | bigcommerce | wix (sitemaps + HTML) | generic.
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
    bigcommerce: /cdn\d*\.bigcommerce\.com|BCData|stencil-utils/i.test(html) || /bigcommerce/i.test(String(h.server || '') + String(h['x-powered-by'] || '')),
    wix: hasHeader(h, /^x-wix-/) || /static\.wixstatic\.com|wix-warmup-data|_wixCssImports/.test(html),
  };
  for (const [k, v] of Object.entries(hint)) if (v) signals.push(`hint:${k}`);
  const name = siteNameOfHtml(html);
  const brand = brandOfHtml(html, home.url || base);
  const frameable = frameableOf(h);
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
    if (r) { signals.push(`api:${k}`); return { platform: k, api: true, base, name: r.name || name, currency: r.currency || currency, brand, frameable, signals, home: { url: home.url, html }, apiBase: r.apiBase }; }
  }
  const hinted = ['shopify', 'magento', 'squarespace', 'woocommerce', 'bigcommerce', 'wix'].find((k) => hint[k]);
  return { platform: hinted || 'generic', api: false, base, name, currency, brand, frameable, signals, home: { url: home.url, html } };
}


// ------------------------------------------------------------------------------------------------ platform feeds
// Each feed is an async generator of product-record arrays ({ title, url, price, priceMax, compareAt, currency, sku,
// brand, type, availability, variants, options, categories, tags, descriptionHtml, pdfs }).
async function* shopifyFeed(ctx) {
  const size = ctx.pageSize || 250;
  for (let page = 1; page <= 400; page++) {
    let list;
    try { list = page === 1 && ctx.firstFeedPage ? ctx.firstFeedPage : (await ctx.f.getJson(`${ctx.base}/products.json?limit=${size}&page=${page}`)).data?.products; }
    catch (e) { if (FATAL.has(e.code)) throw e; if (page === 1) ctx.feedFailed = true; else ctx.pageError(e, 'product'); return; }
    if (!Array.isArray(list) || !list.length) return;
    yield list.map((p) => {
      const vs = Array.isArray(p.variants) ? p.variants : [];
      const prices = vs.map((v) => Number(v.price)).filter(Number.isFinite);
      const url = `${ctx.base}/products/${p.handle}`;
      return { title: p.title, url, brand: p.vendor, type: p.product_type, currency: ctx.det.currency,
        price: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
        compareAt: vs.length === 1 ? vs[0].compare_at_price : null, sku: vs.length === 1 ? vs[0].sku : null,
        availability: vs.length ? (vs.some((v) => v.available !== false) ? 'in stock' : 'out of stock') : null,
        variants: vs.length > 1 ? vs.map((v) => ({ title: v.title, price: v.price, sku: v.sku, available: v.available })) : [],
        options: (p.options || []).filter((o) => o?.name && Array.isArray(o.values) && o.values.length > 1).map((o) => ({ name: o.name, values: o.values })),
        tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean), descriptionHtml: p.body_html || '',
        pdfs: pdfLinksOf(`<main>${p.body_html || ''}</main>`, url) };
    });
    if (list.length < size) return;
  }
}
function wooUrl(ctx, route, params) {
  const qs = new URLSearchParams(params).toString();
  return ctx.det.apiBase === 'rest_route' ? `${ctx.base}/?rest_route=${route}&${qs}` : `${ctx.base}/wp-json${route}?${qs}`;
}
async function* wooFeed(ctx) {
  const size = ctx.pageSize || 100;
  for (let page = 1, total = 1; page <= total && page <= 400; page++) {
    let r;
    try { r = await ctx.f.getJson(wooUrl(ctx, '/wc/store/v1/products', { per_page: size, page })); } catch (e) { if (FATAL.has(e.code)) throw e; if (page === 1) ctx.feedFailed = true; else ctx.pageError(e, 'product'); return; }
    total = Number(r.res.headers['x-wp-totalpages']) || (Array.isArray(r.data) && r.data.length === size ? page + 1 : page);
    const list = Array.isArray(r.data) ? r.data : [];
    if (!list.length) return;
    yield list.map((p) => {
      const pr = p.prices || {};
      const div = 10 ** (Number(pr.currency_minor_unit) || 0);
      const m = (v) => (v == null || v === '' ? null : Number(v) / div);
      const html = [p.short_description, p.description].filter(Boolean).join('\n');
      return { title: decodeEntities(p.name), url: p.permalink, sku: p.sku, currency: pr.currency_code,
        price: pr.price_range ? m(pr.price_range.min_amount) : m(pr.price), priceMax: pr.price_range ? m(pr.price_range.max_amount) : null,
        compareAt: pr.regular_price && pr.regular_price !== pr.price ? m(pr.regular_price) : null,
        availability: p.stock_availability?.text ? oneLine(p.stock_availability.text).toLowerCase() : p.is_in_stock == null ? null : AVAIL(!!p.is_in_stock),
        options: (p.attributes || []).filter((a) => a.terms?.length).map((a) => ({ name: a.name, values: a.terms.map((t) => t.name) })),
        categories: (p.categories || []).map((c) => decodeEntities(c.name)), tags: (p.tags || []).map((t) => decodeEntities(t.name)),
        descriptionHtml: html, pdfs: p.permalink ? pdfLinksOf(`<main>${html}</main>`, p.permalink) : [] };
    });
  }
}
const MAGENTO_Q_FULL = `query($page:Int!,$size:Int!){products(search:"",pageSize:$size,currentPage:$page){total_count page_info{current_page total_pages}
items{__typename name sku url_key url_suffix stock_status categories{name}
price_range{minimum_price{regular_price{value currency} final_price{value currency}} maximum_price{final_price{value currency}}}
short_description{html} description{html}
... on ConfigurableProduct{variants{attributes{label code} product{sku stock_status price_range{minimum_price{final_price{value currency}}}}}}}}}`;
const MAGENTO_Q_MIN = `query($page:Int!,$size:Int!){products(search:"",pageSize:$size,currentPage:$page){total_count page_info{current_page total_pages}
items{name sku url_key stock_status price_range{minimum_price{regular_price{value currency} final_price{value currency}}} description{html}}}}`;
const MAGENTO_CMS = ['faq', 'faqs', 'customer-service', 'help', 'shipping', 'shipping-policy', 'delivery', 'returns', 'return-policy', 'returns-and-exchanges',
  'warranty', 'privacy-policy-cookie-restriction-mode', 'privacy-policy', 'terms', 'terms-and-conditions', 'about-us', 'contact', 'size-guide', 'care'];
async function magentoGql(ctx, query, variables) {
  const r = await ctx.f.fetch(`${ctx.base}/graphql`, { method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = r.json();
  if (!j || (!r.ok && !j.data)) throw err('upstream', `GraphQL answered ${r.status}.`);
  return j;
}
async function* magentoFeed(ctx) {
  let q = MAGENTO_Q_FULL;
  const size = ctx.pageSize || 100;
  for (let page = 1, total = 1; page <= total && page <= 400; page++) {
    let j;
    try {
      j = await magentoGql(ctx, q, { page, size });
      if (!j.data?.products && q === MAGENTO_Q_FULL) { q = MAGENTO_Q_MIN; j = await magentoGql(ctx, q, { page, size }); }
    } catch (e) { if (FATAL.has(e.code)) throw e; if (page === 1) ctx.feedFailed = true; else ctx.pageError(e, 'product'); return; }
    const pr = j.data?.products;
    if (!pr) { if (page === 1) ctx.feedFailed = true; return; }
    total = Number(pr.page_info?.total_pages) || 1;
    yield (pr.items || []).map((it) => {
      const mp = it.price_range?.minimum_price || {};
      const cur = mp.final_price?.currency || mp.regular_price?.currency || ctx.det.currency;
      const url = `${ctx.base}/${it.url_key}${it.url_suffix ?? '.html'}`;
      const html = [it.short_description?.html, it.description?.html].filter(Boolean).join('\n');
      return { title: it.name, url, sku: it.sku, currency: cur,
        price: mp.final_price?.value ?? mp.regular_price?.value, compareAt: mp.regular_price?.value, priceMax: it.price_range?.maximum_price?.final_price?.value,
        availability: it.stock_status ? AVAIL(it.stock_status === 'IN_STOCK') : null, type: it.__typename && it.__typename !== 'SimpleProduct' ? it.__typename.replace(/Product$/, '') : null,
        categories: (it.categories || []).map((c) => c?.name).filter(Boolean),
        variants: (it.variants || []).map((v) => ({ title: (v.attributes || []).map((a) => a.label).join(' / '), sku: v.product?.sku, price: v.product?.price_range?.minimum_price?.final_price?.value,
          available: v.product?.stock_status ? v.product.stock_status === 'IN_STOCK' : null })),
        descriptionHtml: html, pdfs: pdfLinksOf(`<main>${html}</main>`, url) };
    });
  }
}
function squarespaceRecord(it, base) {
  const sc = it.structuredContent || {};
  const vs = Array.isArray(it.variants) ? it.variants : Array.isArray(sc.variants) ? sc.variants : [];
  const money = (v) => (v?.priceMoney?.value != null ? Number(v.priceMoney.value) : v?.price != null ? Number(v.price) / 100 : null);
  const cur = vs.find((v) => v.priceMoney?.currency)?.priceMoney.currency || null;
  const prices = vs.map(money).filter(Number.isFinite);
  const vtitle = (v) => Object.entries(v.attributes || v.optionValues || {}).map(([k, x]) => (typeof x === 'object' ? `${x.optionName || k}: ${x.value}` : `${k}: ${x}`)).join(' / ');
  const avail = (v) => (v.unlimited || Number(v.qtyInStock ?? v.stock?.quantity) > 0 || v.stock?.unlimited ? true : v.qtyInStock != null || v.stock ? false : null);
  return { title: it.title, url: `${base}${it.fullUrl || ''}`, currency: cur, price: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    sku: vs.length === 1 ? vs[0].sku : null, availability: vs.length ? (vs.some((v) => avail(v) === true) ? 'in stock' : vs.every((v) => avail(v) === false) ? 'out of stock' : null) : null,
    variants: vs.length > 1 ? vs.map((v) => ({ title: vtitle(v), sku: v.sku, price: money(v), available: avail(v) })) : [],
    tags: it.tags || [], categories: it.categories || [], descriptionHtml: it.body || it.excerpt || '' };
}
async function* squarespaceFeed(ctx) {
  const colls = new Set();
  for (const u of ctx.plan.productUrls) { const p = new URL(u).pathname; const m = /^(.*)\/p\/[^/]+$/.exec(p); colls.add(m ? m[1] || '/' : p.replace(/\/[^/]+$/, '') || '/'); }
  let got = false;
  for (const c of [...colls].slice(0, 20)) {
    let offset = null;
    for (let guard = 0; guard < 400; guard++) {
      let j;
      try { j = (await ctx.f.getJson(`${ctx.base}${c}?format=json${offset != null ? `&offset=${encodeURIComponent(offset)}` : ''}`)).data; } catch (e) { if (FATAL.has(e.code)) throw e; ctx.pageError(e, 'product'); break; }
      const items = (j?.items || []).filter((it) => it.structuredContent?.variants || it.variants || it.recordTypeLabel === 'store-item' || it.productType != null);
      if (items.length) { got = true; yield items.map((it) => squarespaceRecord(it, ctx.base)); }
      const pg = j?.pagination;
      if (!pg?.nextPage || pg.nextPageOffset == null) break;
      offset = pg.nextPageOffset;
    }
  }
  if (!got) ctx.feedFailed = true;
}
const FEEDS = { shopify: shopifyFeed, woocommerce: wooFeed, magento: magentoFeed, squarespace: squarespaceFeed };
/** The feed's product total when one request tells it (WooCommerce X-WP-Total, Magento total_count). */
async function feedTotalOf(ctx) {
  if (!ctx.det.api) return null;
  if (ctx.det.platform === 'shopify') {
    // the first feed page is read here once (and reused by the feed): a short page is the exact catalogue size
    const size = ctx.pageSize || 250;
    const list = (await ctx.f.getJson(`${ctx.base}/products.json?limit=${size}&page=1`)).data?.products;
    if (!Array.isArray(list)) return null;
    ctx.firstFeedPage = list;
    return list.length < size ? list.length : null;
  }
  if (ctx.det.platform === 'woocommerce') { const r = await ctx.f.fetch(wooUrl(ctx, '/wc/store/v1/products', { per_page: 1 }), { accept: 'application/json' }); const n = Number(r.headers['x-wp-total']); return Number.isFinite(n) ? n : null; }
  if (ctx.det.platform === 'magento') { const j = await magentoGql(ctx, '{products(search:"",pageSize:1){total_count}}', {}); const n = Number(j.data?.products?.total_count); return Number.isFinite(n) ? n : null; }
  return null;
}
/** Pages a platform API hands over whole (WordPress pages, Magento CMS pages): fewer requests, Crawl-delay friendly. */
async function prefetchPlatformPages(ctx) {
  const { f, plan } = ctx;
  const addSource = (url, title, html) => {
    const u = normalizeUrl(url);
    if (!u || !f.hostOkFor(u)) return;
    ctx.prefetched.set(urlKey(u), { html, title: oneLine(title) });
    const kind = classifyUrl(u, { platform: ctx.det.platform, text: title });
    if (!['faq', 'policy', 'help'].includes(kind)) return;
    const cur = plan.sources.find((s) => urlKey(s.url) === urlKey(u));
    if (!cur) { plan.sources.push({ url: u, kind, rank: KIND_RANK[kind], via: ['api'], text: oneLine(title) }); plan.counts[kind]++; }
    else if ((KIND_RANK[kind] ?? 9) < (KIND_RANK[cur.kind] ?? 9) && cur.kind !== 'product') { if (plan.counts[cur.kind]) plan.counts[cur.kind]--; plan.counts[kind]++; cur.kind = kind; cur.rank = KIND_RANK[kind]; }
  };
  if (ctx.det.platform === 'woocommerce' && ctx.det.api) {
    for (let page = 1; page <= 5; page++) {
      let r;
      try { r = await f.getJson(wooUrl(ctx, '/wp/v2/pages', { per_page: 100, page, _fields: 'link,title,content' })); } catch (e) { if (FATAL.has(e.code)) throw e; break; }
      const list = Array.isArray(r.data) ? r.data : [];
      for (const pg of list) if (pg.link) addSource(pg.link, oneLine(pg.title?.rendered), `<main><h1>${pg.title?.rendered || ''}</h1>${pg.content?.rendered || ''}</main>`);
      if (list.length < 100) break;
    }
  }
  if (ctx.det.platform === 'magento' && ctx.det.api) {
    try {
      const qq = `{${MAGENTO_CMS.map((id, i) => `p${i}: cmsPage(identifier:${JSON.stringify(id)}){title content url_key}`).join(' ')}}`;
      const j = await magentoGql(ctx, qq, {});
      for (const pg of Object.values(j.data || {})) if (pg?.content && pg.url_key) addSource(`${ctx.base}/${pg.url_key}`, pg.title || pg.url_key, `<main><h1>${pg.title || ''}</h1>${pg.content}</main>`);
    } catch (e) { if (FATAL.has(e.code)) throw e; }
  }
  plan.sources.sort(compareSources);
}

// ------------------------------------------------------------------------------------------------ readers
/** Run fn over items with at most `width` in progress (the fetcher itself keeps ≤ 4 requests in flight). */
async function pool(items, fn, width = 12) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const isHtml = (r) => /html|xml/i.test(String(r.headers['content-type'] || 'text/html'));
const isPdfBytes = (b) => b && b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-';
/** A usable canonical: same site, and not the home page for a deeper page (some themes point every page at /). */
function goodCanonical(ctx, canon, pageUrl) {
  if (!canon || !ctx.f.hostOkFor(canon)) return null;
  try { if (new URL(canon).pathname === '/' && new URL(pageUrl).pathname !== '/') return null; } catch { return null; }
  return canon;
}
function addPdf(ctx, p) {
  const u = normalizeUrl(p.url);
  if (!u || !ctx.f.pdfOkFor(u)) return;
  const k = urlKey(u);
  if (!ctx.pdfs.has(k)) ctx.pdfs.set(k, { url: u, text: oneLine(p.text || ''), from: p.from || null });
}
async function readPageSource(ctx, s) {
  const { f, report } = ctx;
  if (ctx.timeUp) { ctx.inc(report.leftOut.time, s.kind); return; }
  const key = urlKey(s.url);
  if (ctx.seen.has(key) || ctx.seenProducts.has(key)) { report.skipped.duplicate++; return; }
  ctx.seen.add(key);
  if (ctx.already(s.url, s.kind)) return;
  let html, url = s.url;
  const pre = ctx.prefetched.get(key) || ctx.plan.prefetched.get(key);
  if (pre && htmlToText(pre.html, { main: true }).replace(/\s+/g, ' ').length >= 30) html = pre.html;
  else {
    let r;
    try { r = await f.get(s.url, { accept: 'text/html,application/xhtml+xml' }); } catch (e) { ctx.pageError(e, s.kind); return; }
    if (isPdfBytes(r.body)) { addPdf(ctx, { url: s.url, text: s.text }); return; }
    if (!isHtml(r)) { report.skipped.failed++; return; }
    html = r.text();
    url = normalizeUrl(r.url) || s.url;
    const canon = goodCanonical(ctx, canonicalOf(html, url), url);
    if (canon) { const ck = urlKey(canon); if (ck !== key && ctx.seen.has(ck)) { report.skipped.duplicate++; return; } ctx.seen.add(ck); url = canon; }
    if (url !== s.url && ctx.already(url, s.kind)) return;
  }
  let kind = s.kind;
  if (kind === 'page' || kind === 'help') { const k2 = classifyUrl(url, { platform: ctx.det.platform, text: pre?.title || titleOfHtml(html) }); if (['faq', 'policy', 'help'].includes(k2)) kind = k2; }
  const doc = readPageHtml(html, url, { kind, title: pre?.title || null });
  for (const p of doc.pdfs) addPdf(ctx, p);
  if (doc.sections.reduce((n, x) => n + String(x.text || '').replace(/\s+/g, ' ').trim().length, 0) < 12) { report.skipped.empty++; return; }
  ctx.progress(doc.kind);
  await ctx.writer.add(doc);
}
/**
 * Read up to `cap` of these (ranked) sources. The site's own pages are kept first (menu-linked ones first within each
 * kind, see compareSources); help-desk articles take what is left of the cap, so a 2,000-article desk can never crowd
 * out the policy and FAQ pages the site's menus link.
 */
async function readPages(ctx, sources, cap) {
  const desk = (s) => s.via?.includes('helpdesk') && !s.via.some((v) => v === 'nav' || v === 'link' || v === 'sitemap');
  const own = sources.filter((s) => !desk(s)).sort(compareSources), hd = sources.filter(desk).sort(compareSources);
  const ownList = own.slice(0, cap), deskList = hd.slice(0, Math.max(0, cap - ownList.length));
  for (const s of [...own.slice(ownList.length), ...hd.slice(deskList.length)]) ctx.inc(ctx.report.leftOut.cap, s.kind);
  await pool([...ownList, ...deskList], (s) => readPageSource(ctx, s));
}
/** ms one more product page costs: the pacing interval, or the measured rate once ~10 pages were read. */
function pageCostMs(ctx) {
  const e = ctx.enrichClock;
  const measured = e.n >= 10 ? (Date.now() - e.t0) / e.n : 0;
  return Math.max(ctx.f.pace, measured, e.n >= 10 ? 1 : 100);
}
/** Time the readers after the products still need (PDFs, collections, blog, other pages), kept back from enrichment. */
function reserveMs(ctx) {
  const want = (k, cap) => (ctx.kinds && !ctx.kinds.has(k) ? 0 : Math.min(ctx.totals[k] || 0, cap));
  const pdfs = ctx.kinds && !ctx.kinds.has('pdf') ? 0 : Math.min(Math.max(ctx.totals.pdf || 0, ctx.pdfs.size), ctx.caps.maxPdfs);
  const n = pdfs + want('collection', ctx.caps.maxCollections) + want('blog', ctx.caps.maxBlog) + want('page', ctx.caps.maxOtherPages);
  return Math.min(0.25 * Math.max(0, ctx.f.timeLeft()), n * Math.max(ctx.f.pace, 100)) + 2000;
}
/**
 * Read this product's page as well as its feed record? A running budget, decided per product: thin feed copy (< 400
 * characters) is read while any time is left; richer copy is read while the time left (minus a reserve for the readers
 * that follow) still covers the thin products still to come, so a 10,000-product store gets as many full pages as
 * the 20-minute budget allows, thin ones first, instead of all-or-nothing.
 */
function shouldEnrich(ctx, descLen) {
  const mode = ctx.enrich;
  const thin = descLen < 400;
  ctx.enrichSeen++; if (thin) ctx.enrichThin++;
  if (mode === 'none' || ctx.enrichStopped) return false;
  if (mode === 'all') return true;
  if (mode === 'thin') return thin;
  const per = pageCostMs(ctx);
  const avail = ctx.f.timeLeft() - reserveMs(ctx);
  const remaining = Math.max(0, (ctx.productTotal || 0) - ctx.enrichSeen);
  const thinShare = ctx.enrichSeen >= 20 ? ctx.enrichThin / ctx.enrichSeen : 0.5;
  const ok = thin ? avail > per : avail - remaining * thinShare * per > per;
  if (!ok) ctx.report.enrichSkipped++;
  return ok;
}
async function buildProduct(ctx, rec) {
  const { f, report } = ctx;
  let doc = null;
  const descLen = htmlToText(rec.descriptionHtml || '', { main: false }).length;
  if (!ctx.timeUp && shouldEnrich(ctx, descLen)) {
    try {
      if (!ctx.enrichClock.t0) ctx.enrichClock.t0 = Date.now();
      const r = await f.get(rec.url, { accept: 'text/html,application/xhtml+xml' });
      ctx.enrichClock.n++;
      if (isHtml(r)) { doc = readProductHtml(r.text(), rec.url, rec); report.enriched++; report.productPagesRead++; }
    } catch (e) {
      if (FATAL.has(e.code)) throw e;
      if (e.budget) { ctx.timeUp = true; ctx.enrichStopped = true; }
      else if (e.code === 'robots') report.skipped.robots++;
      else if (e.code !== 'not_found') report.enrichFailed++;
    }
  }
  doc ||= productDoc(rec);
  for (const p of doc.pdfs || []) addPdf(ctx, p);
  ctx.progress('product');
  await ctx.writer.add(doc);
  return true;
}
/**
 * One product page read whole (no feed record). candidate: a maybe-product (Magento .html, /shop/<x>): kept as a product
 * only with Product JSON-LD, else read as a collection page (when collections are wanted and under their cap).
 * → 'product' | 'collection' | 'time' (not attempted: the budget is used up) | null (failed, duplicate, not a product)
 */
async function readProductUrl(ctx, url, { requireLd = false, candidate = false } = {}) {
  const { f, report } = ctx;
  if (ctx.timeUp) return 'time';
  let r;
  try { r = await f.get(url, { accept: 'text/html,application/xhtml+xml' }); }
  catch (e) { if (e.budget || (e.code === 'timeout' && f.timeLeft() <= 0)) { ctx.timeUp = true; return 'time'; } ctx.pageError(e, 'product'); return null; }
  if (!isHtml(r)) { report.skipped.failed++; return null; }
  const html = r.text();
  let finalUrl = normalizeUrl(r.url) || url;
  const canon = goodCanonical(ctx, canonicalOf(html, finalUrl), finalUrl);
  if (canon) {
    const ck = urlKey(canon);
    if (ck !== urlKey(url) && ctx.seenProducts.has(ck)) { report.skipped.duplicate++; return null; }
    ctx.seenProducts.add(ck); finalUrl = canon;
    if (canon !== url && ctx.already(canon, 'product')) return 'product';
  }
  const doc = readProductHtml(html, finalUrl, null, { requireLd: requireLd || candidate });
  if (!doc) {
    report.skipped.notProduct++;
    // a category page found among the candidates is still knowledge: kept as a collection page
    if (candidate && (!ctx.kinds || ctx.kinds.has('collection')) && ctx.collectionsRead < ctx.caps.maxCollections && !ctx.seen.has(urlKey(finalUrl))) {
      ctx.seen.add(urlKey(finalUrl));
      const page = readPageHtml(html, finalUrl, { kind: 'collection' });
      for (const p of page.pdfs) addPdf(ctx, p);
      if (page.sections.reduce((n, x) => n + String(x.text || '').replace(/\s+/g, ' ').trim().length, 0) >= 12) {
        ctx.collectionsRead++; ctx.progress(page.kind); await ctx.writer.add(page); return 'collection';
      }
    }
    return null;
  }
  doc.url = finalUrl;
  report.productPagesRead++;
  for (const p of doc.pdfs || []) addPdf(ctx, p);
  ctx.progress('product');
  await ctx.writer.add(doc);
  return 'product';
}
/**
 * Every product: the platform feed first (structured data, its own page read on top while the budget allows), then
 * every product page the feed did not cover (sitemaps, nav links), then candidates. The product cap counts products
 * actually written (claimed slots in flight included, so it is never exceeded); a candidate that turns out to be a
 * category frees its slot. When the time budget runs out, what was not read is counted ONCE (leftOut.time.product).
 */
async function readProducts(ctx) {
  const { caps, report, plan } = ctx;
  const max = caps.maxProducts;
  let pending = 0, done = 0;
  const claim = (url) => {
    const k = urlKey(url);
    if (!k || ctx.seenProducts.has(k)) { report.skipped.duplicate++; return false; }
    // resume: written by the interrupted run: counts as done (and against the product cap), never read again
    if (ctx.already(url, 'product')) { ctx.seenProducts.add(k); ctx.productCount++; done++; return false; }
    if (ctx.productCount + pending >= max) { ctx.productsMore = true; ctx.inc(report.leftOut.cap, 'product'); return false; }
    ctx.seenProducts.add(k); pending++;
    return true;
  };
  const settle = (outcome) => { pending--; if (outcome === 'product') ctx.productCount++; if (outcome !== 'time') done++; };
  const feed = ctx.det.api ? FEEDS[ctx.det.platform] : null;
  if (feed) {
    for await (const recs of feed(ctx)) {
      const batch = recs.filter((rec) => rec.url && claim(rec.url));
      await pool(batch, async (rec) => { let ok = false; try { ok = await buildProduct(ctx, rec); } finally { settle(ok ? 'product' : null); } });
      ctx.totals.product = Math.max(ctx.totals.product || 0, ctx.productCount);
      if (ctx.timeUp) break;
    }
    if (ctx.feedFailed) ctx.warnings.push(`This ${ctx.det.platform} store's product feed didn't answer, so products were read from their pages.`);
  }
  // product pages the feed did not cover: read whole. A platform whose product paths are certain (Shopify, Woo, Wix,
  // Squarespace) keeps any page; elsewhere a page must carry Product JSON-LD to be written as a product.
  const sure = ['shopify', 'woocommerce', 'wix', 'squarespace'].includes(ctx.det.platform);
  const rest = [...new Set(plan.productUrls)].filter((u) => !ctx.seenProducts.has(urlKey(u)));
  const cands = [...new Set(plan.candidateUrls || [])].filter((u) => !ctx.seenProducts.has(urlKey(u)) && !rest.includes(u));
  ctx.totals.product = Math.max(ctx.totals.product || 0, ctx.productCount + rest.length);
  for (const [list, candidate] of [[rest, false], [cands, true]]) {
    if (ctx.timeUp) break;
    await pool(list, async (u) => {
      if (ctx.timeUp || !claim(u)) return;
      let out = null;
      try { out = await readProductUrl(ctx, u, { requireLd: !sure, candidate }); } finally { settle(out); }
    });
  }
  if (ctx.timeUp) report.leftOut.time.product = Math.max(0, (ctx.totals.product || 0) - done);
}
const PDF_PRI = /manual|instruction|spec|datasheet|data-sheet|size|chart|guide|care|warrant|assembly|install|safety|user/i;
async function readPdfs(ctx) {
  const { f, report, caps } = ctx;
  if (ctx.kinds && !ctx.kinds.has('pdf')) return;
  for (const s of ctx.plan.sources.filter((x) => x.kind === 'pdf')) addPdf(ctx, s);
  const all = [...ctx.pdfs.values()].sort((a, b) => (PDF_PRI.test(`${a.url} ${a.text}`) ? 0 : 1) - (PDF_PRI.test(`${b.url} ${b.text}`) ? 0 : 1) || a.url.localeCompare(b.url));
  ctx.totals.pdf = all.length;
  for (const p of all.slice(caps.maxPdfs)) ctx.inc(report.leftOut.cap, 'pdf');
  await pool(all.slice(0, caps.maxPdfs), async (p) => {
    if (ctx.already(p.url, 'pdf')) return;
    if (ctx.timeUp) { ctx.inc(report.leftOut.time, 'pdf'); return; }
    let r;
    try { r = await f.get(p.url, { accept: 'application/pdf', maxBytes: f.config.maxPdfBytes }); } catch (e) { ctx.pageError(e, 'pdf'); return; }
    if (!isPdfBytes(r.body)) { report.skipped.failed++; return; }
    const name = decodeURIComponent(new URL(p.url).pathname.split('/').pop() || 'document.pdf').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ');
    ctx.progress('pdf');
    await ctx.writer.add({ kind: 'pdf', url: p.url, title: p.text && p.text.length > 2 ? p.text : name, bytes: r.body, from: p.from });
  }, 4);
}

// ------------------------------------------------------------------------------------------------ orchestration
const PAGE_KINDS = ['policy', 'faq', 'help'];
/** Import a website: detect, find and rank sources, read them best first, build one file per page. See the top. */
export async function importStore(input, o = {}) {
  const emit = (ev, data) => { try { o.onEvent?.(ev, data); } catch {} };
  try {
    const start = normalizeStoreUrl(input);
    const remaining = o.remainingBytes ?? LIMITS.maxTotalBytes;
    if (!(remaining > 0)) throw err('quota');
    const cap = (k) => Math.max(0, Math.min(o[k] ?? LIMITS[k], LIMITS[k]));
    const caps = { maxProducts: cap('maxProducts'), maxPages: cap('maxPages'), maxCollections: cap('maxCollections'), maxBlog: cap('maxBlog'), maxPdfs: cap('maxPdfs'),
      maxOtherPages: cap('maxOtherPages'), maxTotalBytes: Math.max(0, Math.min(o.maxTotalBytes ?? LIMITS.maxTotalBytes, LIMITS.maxTotalBytes, remaining)) };
    const f = createStoreFetcher({ budgetMs: LIMITS.budgetMs, ...(o.net || {}), ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}), signal: o.signal, onProgress: (p) => emit('fetching', p) });
    f.allowSite(start.hostname);
    const det = await detectPlatform(start, f.fetch);
    f.allowSite(new URL(det.base).hostname);
    if (det.platform === 'shopify') f.allowPdfHost('cdn.shopify.com');
    if (det.platform === 'squarespace') { f.allowPdfHost('static1.squarespace.com'); f.allowPdfHost('images.squarespace-cdn.com'); }
    if (det.platform === 'bigcommerce') f.allowPdfHost('cdn11.bigcommerce.com');
    emit('detect', { platform: det.platform, api: det.api, base: det.base, name: det.name });

    const report = { found: null, read: {}, written: {}, bytes: 0, enriched: 0, enrichFailed: 0, enrichSkipped: 0, productPagesRead: 0,
      skipped: { robots: 0, failed: 0, notFound: 0, duplicate: 0, empty: 0, notProduct: 0 }, leftOut: { time: {}, quota: {}, cap: {}, excluded: {} }, timeUp: false };
    let lastReading = 0;
    // kinds: the page kinds the visitor ticked (null = every kind); unknown names are ignored
    const kinds = Array.isArray(o.kinds) && o.kinds.length ? new Set(o.kinds.filter((k) => KINDS.includes(k))) : null;
    // resume: pages written by an interrupted run of this import, by URL key and by file path
    const skipUrls = new Set([...(o.skip?.urls || [])].map((u) => urlKey(u)).filter(Boolean));
    const skipPaths = new Set([...(o.skip?.paths || [])].map((x) => String(x).toLowerCase()));
    const isDone = skipUrls.size || skipPaths.size ? (url, kind, rel) => {
      const k = urlKey(url);
      if (k && skipUrls.has(k)) return true;
      if (!rel) { try { rel = `site/${kind === 'pdf' ? ctx.plan?.host || new URL(url).hostname.toLowerCase() : new URL(url).hostname.toLowerCase()}/${kind}/${slugOf(url)}.${kind === 'pdf' ? 'pdf' : 'md'}`; } catch { return false; } }
      return skipPaths.has(String(rel).toLowerCase());
    } : null;
    report.already = {};
    const ctx = { f, base: det.base, det, caps, report, warnings: [], seen: new Set(), seenProducts: new Set(), pdfs: new Map(), prefetched: new Map(),
      productCount: 0, productsMore: false, timeUp: false, enrich: o.enrich || 'auto', pageSize: o.pageSize, totals: {}, kinds, collectionsRead: 0,
      enrichSeen: 0, enrichThin: 0, enrichClock: { t0: 0, n: 0 },
      inc: (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; },
      /** Written by the interrupted run (resume): counted in report.already and in the reading progress, not read. */
      already(url, kind) {
        if (!isDone || !isDone(url, kind)) return false;
        ctx.inc(report.already, kind);
        return true;
      },
      pageError(e, kind) {
        if (FATAL.has(e.code)) throw e;
        if (e.code === 'robots') report.skipped.robots++;
        else if (e.budget || (e.code === 'timeout' && f.timeLeft() <= 0)) { ctx.timeUp = true; ctx.inc(report.leftOut.time, kind); }
        else if (e.code === 'not_found') report.skipped.notFound++;
        else report.skipped.failed++;
      },
      progress(kind) {
        ctx.inc(report.read, kind);
        const t = Date.now();
        if (t - lastReading < 250) return;
        lastReading = t;
        const done = report.read[kind] + (report.already[kind] || 0);
        emit('reading', { kind, done, total: Math.max(ctx.totals[kind] || 0, done), read: { ...report.read } });
      } };
    const plan = await findSources(f, det, { inflate: (b) => zlib.gunzipSync(b, { maxOutputLength: f.config.maxBytes }), registrable: registrableDomain,
      allowHelpHost: (h) => f.allowHost(h), feedTotal: () => feedTotalOf(ctx), onDiscover: (d) => emit('discovering', d) });
    ctx.plan = plan;
    f.setCrawlDelay(plan.robots.crawlDelay);
    await prefetchPlatformPages(ctx);
    for (const k of KINDS) ctx.totals[k] = plan.counts[k];
    ctx.productTotal = plan.counts.product;
    report.found = { ...plan.counts };
    const total = Object.values(plan.counts).reduce((a, b) => a + b, 0);
    emit('plan', { counts: plan.counts, samples: plan.samples, total, robots: plan.robots, helpdesks: plan.helpdesks.map(({ type, origin }) => ({ type, origin })), feedTotal: plan.feedTotal,
      candidates: plan.candidates, upTo: plan.upTo, approx: plan.approx, skippedDesks: plan.skippedDesks, ...(kinds ? { kinds: [...kinds] } : {}) });
    emit('found', { products: plan.counts.product, pages: plan.counts.help + plan.counts.page, policies: plan.counts.policy, faqs: plan.counts.faq, help: plan.counts.help,
      pdfs: plan.counts.pdf, collections: plan.counts.collection, blog: plan.counts.blog });
    const publicPlan = { counts: plan.counts, samples: plan.samples, total, robots: plan.robots, helpdesks: plan.helpdesks, skippedDesks: plan.skippedDesks, feedTotal: plan.feedTotal, notes: plan.notes,
      candidates: plan.candidates, upTo: plan.upTo, approx: plan.approx, sources: plan.sources.slice(0, 200).map((s) => ({ url: s.url, kind: s.kind, via: s.via })) };
    if (o.planOnly) return { platform: det.platform, api: det.api, base: det.base, host: plan.host, name: det.name, plan: publicPlan, files: [], counts: {}, report, capped: null, skipped: report.skipped, warnings: ctx.warnings };
    if (total === 0 && !det.api) throw err('no_content');

    const writer = createWriter({ maxTotalBytes: caps.maxTotalBytes, storeName: det.name || plan.host, siteHost: plan.host, onFiles: o.onFiles, emit,
      batchFiles: o.batchFiles || 40, batchBytes: o.batchBytes || 2 * MB,
      isDone: isDone ? (url, kind, rel) => { if (!isDone(url, kind, rel)) return false; ctx.inc(report.already, kind); return true; } : null });
    ctx.writer = writer;
    // best sources first: policies and FAQ, help, then every product, PDFs, collections, blog, other pages; kinds the
    // visitor did not tick are never read (reported as leftOut.excluded)
    const want = (k) => !kinds || kinds.has(k);
    if (kinds) for (const k of KINDS) if (!kinds.has(k) && plan.counts[k]) report.leftOut.excluded[k] = plan.counts[k];
    await readPages(ctx, plan.sources.filter((s) => PAGE_KINDS.includes(s.kind) && want(s.kind)), caps.maxPages);
    await writer.flushAll();
    if (want('product')) await readProducts(ctx);
    await writer.flushAll();
    await readPdfs(ctx);
    if (want('collection')) await readPages(ctx, plan.sources.filter((s) => s.kind === 'collection'), Math.max(0, caps.maxCollections - ctx.collectionsRead));
    if (want('blog')) await readPages(ctx, plan.sources.filter((s) => s.kind === 'blog'), caps.maxBlog);
    if (want('page')) await readPages(ctx, plan.sources.filter((s) => s.kind === 'page'), caps.maxOtherPages);
    const files = await writer.finish();
    f.flushProgress();
    if (o.signal?.aborted) throw err('aborted');

    report.written = { ...writer.stats.written };
    report.bytes = writer.stats.used;
    report.leftOut.quota = { ...writer.stats.leftOut };
    report.timeUp = ctx.timeUp;
    report.products = { found: Math.max(plan.counts.product, ctx.totals.product || 0), read: report.read.product || 0, written: writer.stats.written.product || 0 };
    report.throttled = f.stats.throttled;
    report.requests = f.stats.total;
    const counts = { products: report.written.product || 0, pages: (report.written.help || 0) + (report.written.page || 0), policies: report.written.policy || 0,
      faqs: report.written.faq || 0, pdfs: report.written.pdf || 0, collections: report.written.collection || 0, blog: report.written.blog || 0 };
    const capped = {};
    if (report.leftOut.cap.product) capped.products = { limit: caps.maxProducts, kept: ctx.productCount, more: true };
    // product pages read in full (feed + page) vs products written, when the time budget kept some to feed copy only
    if (report.enrichSkipped && ctx.productCount) capped.enrich = { read: report.productPagesRead, of: ctx.productCount };
    report.enrich = { read: report.productPagesRead, of: ctx.productCount };
    const pagesCut = PAGE_KINDS.reduce((n, k) => n + (report.leftOut.cap[k] || 0), 0);
    if (pagesCut) capped.pages = { limit: caps.maxPages, kept: caps.maxPages, more: true };
    const quotaOut = Object.values(report.leftOut.quota).reduce((a, b) => a + b, 0);
    if (quotaOut) capped.bytes = { limit: caps.maxTotalBytes, droppedProducts: report.leftOut.quota.product || 0, droppedSections: quotaOut, leftOut: report.leftOut.quota };
    if (ctx.timeUp) capped.time = { leftOut: report.leftOut.time };
    if (Object.keys(capped).length) emit('capped', capped);
    const alreadyN = Object.values(report.already).reduce((a, b) => a + b, 0);
    if (!writer.stats.files && !alreadyN) throw err(quotaOut ? 'quota' : 'no_content');
    emit('built', { n: writer.stats.files, bytes: writer.stats.used, written: report.written, files: files.slice(0, 50).map((x) => ({ name: x.name, path: x.path, bytes: x.size, kind: x.kind })), report });
    return { platform: det.platform, api: !!det.api && !ctx.feedFailed, base: det.base, host: plan.host, name: det.name, brand: det.brand || null, frameable: det.frameable === true, plan: publicPlan, files, counts, report,
      capped: Object.keys(capped).length ? capped : null, skipped: report.skipped, warnings: ctx.warnings, requests: f.stats.total, maxConcurrent: f.stats.maxActive };
  } catch (e) {
    // a cancel wins; an error from the caller's onFiles (e.g. knowDrive refused a batch) keeps its own code
    const se = e instanceof StoreImportError ? e : (o.signal?.aborted || e?.code === 'aborted') ? err('aborted')
      : e?.status && e?.code ? e : err('upstream', undefined, { cause: e });
    emit('error', { code: se.code, message: se.message });
    throw se;
  }
}
