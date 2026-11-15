// An SSRF-safe POST for URLs an owner (or their Zapier account) gives us: the webhook connector and REST hooks.
//
// The address rules are the website importer's (server/storeimport.mjs isBlockedAddress: no private, loopback,
// link-local, CGNAT, metadata, multicast or reserved address, IPv4 or IPv6 in any wrapper). Every request:
//   - https only, port 443 only, no credentials in the URL, no bare or internal host names
//   - DNS is resolved here, EVERY address it returns is checked, and the socket connects to the checked address
//     (so DNS rebinding cannot swap it between the check and the connect)
//   - a redirect (307/308 only: they keep the method and body) is checked the same way, at most 3 hops
//   - 10 s per request, the response body is read up to 64 KB and otherwise ignored
// Tests (and the local dev server) pass net: { allowAddresses: ['127.0.0.1'], allowHttp: true, allowPorts: 'any' }.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { isBlockedAddress } from '../storeimport.mjs';
import { CrmError } from './http.mjs';

const BAD_HOST_RE = /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|intranet|lan|corp)$/i;
const strip = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
const blocked = (why) => new CrmError('blocked', why, { action: 'Use a public https:// address.' });

/** Checks the URL's shape (not its addresses). → URL. Throws CrmError('blocked'). */
export function checkHookUrl(raw, cfg = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw blocked('That is not a web address.'); }
  if (u.protocol !== 'https:' && !(cfg.allowHttp && u.protocol === 'http:')) throw blocked('The address must start with https://.');
  if (u.username || u.password) throw blocked('Addresses with a user name or password in them are not allowed.');
  const h = strip(u.hostname);
  const allow = new Set((cfg.allowAddresses || []).map(strip));
  if (net.isIP(h)) { if (isBlockedAddress(h) && !allow.has(h)) throw blocked('That address is not on the public internet.'); }
  else if (BAD_HOST_RE.test(h) || !h.includes('.')) throw blocked('That address is not on the public internet.');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (cfg.allowPorts !== 'any' && !(cfg.allowPorts || [443]).includes(port)) throw blocked('Only the standard https port (443) is allowed.');
  if (String(raw).length > 2000) throw blocked('That address is too long.');
  return u;
}

async function resolveChecked(u, cfg) {
  const h = strip(u.hostname);
  const allow = new Set((cfg.allowAddresses || []).map(strip));
  let addrs;
  if (net.isIP(h)) addrs = [{ address: h, family: net.isIP(h) }];
  else {
    try { addrs = await (cfg.resolve || ((host) => dns.promises.lookup(host, { all: true, verbatim: true })))(h); }
    catch { throw new CrmError('network', `We could not find ${h}.`, { action: 'Check the address.' }); }
    addrs = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
  }
  if (!addrs.length) throw new CrmError('network', `We could not find ${h}.`, { action: 'Check the address.' });
  for (const a of addrs) if (isBlockedAddress(a.address) && !allow.has(strip(a.address))) throw blocked('That address is not on the public internet.');
  return addrs[0].address;
}

function once(u, address, { method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const host = strip(u.hostname);
    const opts = { host: address, port: u.port || (isHttps ? 443 : 80), method, path: `${u.pathname}${u.search}`, agent: false,
      headers: { host: u.host, ...headers, ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}) } };
    if (isHttps) { if (!net.isIP(host)) opts.servername = host; opts.rejectUnauthorized = true; }
    const req = (isHttps ? https : http).request(opts);
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(new CrmError('network', e.code === 'ETIMEDOUT' ? `${u.host} took too long to answer.` : `${u.host} could not be reached.`)); });
    req.on('response', (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n <= maxBytes) chunks.push(c); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', () => { clearTimeout(timer); resolve({ status: res.statusCode || 0, headers: res.headers, text: '' }); });
    });
    req.end(body ?? undefined);
  });
}

/**
 * POST (or any method) to an owner-supplied URL. → { status, headers (lower-cased object), text }.
 * Throws CrmError('blocked' | 'network').
 */
export async function safeRequest(rawUrl, { method = 'POST', headers = {}, body = null, net: cfg = {}, timeoutMs = 10000, maxBytes = 65536, maxRedirects = 3 } = {}) {
  let u = checkHookUrl(rawUrl, cfg);
  for (let hop = 0; ; hop++) {
    const address = await resolveChecked(u, cfg);
    const r = await once(u, address, { method, headers, body, timeoutMs, maxBytes });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      if (![307, 308].includes(r.status)) throw new CrmError('invalid', `${u.host} sent us somewhere else instead of accepting the lead.`, { status: r.status, action: 'Use the final address, not one that redirects.' });
      if (hop >= maxRedirects) throw new CrmError('invalid', `${u.host} redirected too many times.`, { status: r.status, action: 'Use the final address, not one that redirects.' });
      let next;
      try { next = new URL(r.headers.location, u); } catch { throw new CrmError('invalid', `${u.host} redirected to an address we could not read.`, { status: r.status }); }
      u = checkHookUrl(next.toString(), cfg); // every hop: https, public, standard port
      continue;
    }
    return r;
  }
}
