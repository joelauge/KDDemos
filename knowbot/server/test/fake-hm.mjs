// A host-manager stand-in for the hm sign-in tests: serves /.well-known/jwks.json on 127.0.0.1 and mints Function
// Access Tokens (ES256 JWTs) the way host-manager signs them. Never talks to the network.
import http from 'node:http';
import { generateKeyPairSync, sign as signWith, createHmac } from 'node:crypto';

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export async function startFakeHm({ host = '127.0.0.1' } = {}) {
  const newKey = (kid) => ({ kid, ...generateKeyPairSync('ec', { namedCurve: 'P-256' }) });
  let n = 0;
  const S = { fetches: 0, down: false, oversize: false, redirect: false, extraKeys: [], keys: [newKey(`k${++n}`)] };
  const jwk = (k) => ({ ...k.publicKey.export({ format: 'jwk' }), kid: k.kid, alg: 'ES256', use: 'sig' });
  const srv = http.createServer((req, res) => {
    if (req.url !== '/.well-known/jwks.json') { res.writeHead(404); return res.end(); }
    S.fetches++;
    if (S.down) { res.writeHead(503); return res.end(); }
    if (S.redirect) { res.writeHead(302, { location: 'http://127.0.0.1:9/jwks.json' }); return res.end(); }
    const body = JSON.stringify({ keys: [...S.keys.map(jwk), ...S.extraKeys], ...(S.oversize ? { pad: 'x'.repeat(70 * 1024) } : {}) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, host, r));
  const url = `http://${host}:${srv.address().port}`;
  return Object.assign(S, {
    url, issuer: url, jwksUrl: `${url}/.well-known/jwks.json`,
    get kid() { return S.keys[0].kid; },
    /** A compact JWT. `header` and `claims` override the defaults; `key` signs (default: the active key). */
    mint(claims = {}, { header = {}, key = S.keys[0], aud, raw } = {}) {
      const t = Math.floor(Date.now() / 1000);
      const h = { alg: 'ES256', kid: key.kid, typ: 'JWT', ...header };
      const p = { iss: url, aud: aud || [], sub: 'owner', iat: t, exp: t + 300, jti: `j${t}${Math.random()}`, auth_method: 'local',
        entitlements: ['knowbot:*:admin', 'knowbot:*:read'], ...claims };
      for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
      const input = `${b64u(h)}.${b64u(p)}`;
      if (raw) return raw(input, h, p);
      return `${input}.${signWith('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
    /** HS256 signed with the public JWK's bytes: the classic alg-confusion forgery. */
    hs256(claims = {}, aud) {
      return S.mint(claims, { aud, header: { alg: 'HS256' }, raw: (input) => `${input}.${createHmac('sha256', JSON.stringify(jwk(S.keys[0]))).update(input).digest('base64url')}` });
    },
    /** Swap the active key; the old one is no longer published. */
    rotate() { S.old = S.keys[0]; S.keys = [newKey(`k${++n}`)]; return S.keys[0]; },
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  });
}
