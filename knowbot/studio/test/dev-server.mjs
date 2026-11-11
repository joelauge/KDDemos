#!/usr/bin/env node
// KnowBot Studio local dev server (spec 7.1): the real server on FAKE knowDrive + FAKE model, never production.
//
//   npm run studio:dev                 # prints  Studio: http://127.0.0.1:<port>/studio/
//   FAKE_SPEED=4 npm run studio:dev    # 4x faster fake ingest pipeline
//   PORT=8790 npm run studio:dev       # fixed port (default: random)
//   STUDIO_ENGINE=llm npm run studio:dev   # Builder through the (fake) local model instead of the scripted engine
//
// The server gets an explicit env object (process.env is never inherited) and refuses to start unless knowDrive
// resolves to 127.0.0.1. In-process use (Playwright smoke): `const dev = await startDevServer({ speed: 4 })`.
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKnowBotServer } from '../../server/server.mjs';
import { startFakeKnowDrive } from '../../server/test/fake-knowdrive.mjs';
import { startFakeLLM } from '../../server/test/fake-llm.mjs';
import { startFakeTwilio } from '../../server/test/fake-twilio.mjs';
import { startFakeStripe } from '../../server/test/fake-stripe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Fake channel credentials (fixer r1): every channel webhook works end to end on the dev server. Nothing here is a real
// secret; outbound sends (Meta Graph, e-mail relay, Twilio REST) go to a loopback sink that records them.
export const DEV_CHANNEL_SECRETS = Object.freeze({
  TWILIO_AUTH_TOKEN: 'dev-twilio-auth-token', TWILIO_ACCOUNT_SID: 'ACdev00000000000000000000000000000',
  WHATSAPP_VERIFY_TOKEN: 'dev-whatsapp-verify', WHATSAPP_APP_SECRET: 'dev-whatsapp-app-secret', WHATSAPP_ACCESS_TOKEN: 'dev-whatsapp-access-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
  EMAIL_WEBHOOK_SECRET: 'dev-email-secret', EMAIL_FROM: 'bot@studio.test',
});
// KnowBot numbers (server/numbers.mjs) on the dev server: a fake number provider and fake payments on loopback, with
// fake keys. A real payments key (sk_live_ / sk_test_ / rk_…) is refused.
export const DEV_NUMBER_SECRETS = Object.freeze({ STRIPE_SECRET_KEY: 'sk_dev_fake', STRIPE_PUBLISHABLE_KEY: 'pk_dev_fake', STRIPE_WEBHOOK_SECRET: 'whsec_dev_fake' });
// Keys that would reach a real provider: never accepted by the dev server.
const REAL_PROVIDER_KEYS = ['SENDGRID_API_KEY', 'POSTMARK_SERVER_TOKEN', 'GOOGLE_API_KEY', 'GOOGLE_STT_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_ACCESS_TOKEN', 'MAILGUN_SIGNING_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

/** Loopback sink for outbound channel sends: { url, sent: [{at, path, body}], close() }. */
export async function startFakeChannelSink({ host = '127.0.0.1' } = {}) {
  const sent = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw; try { body = JSON.parse(raw); } catch {}
      sent.push({ at: new Date().toISOString(), method: req.method, path: req.url, body });
      if (sent.length > 200) sent.shift();
      res.writeHead(200, { 'content-type': 'application/json' });
      if (/\/messages$/.test(req.url)) return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.fake${sent.length}` }] }));
      res.end(JSON.stringify({ ok: true, id: `fake_${sent.length}` }));
    });
    req.on('error', () => {});
  });
  srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
  await new Promise((r) => srv.listen(0, host, r));
  const url = `http://${host}:${srv.address().port}`;
  return { url, sent, close: () => new Promise((r) => srv.close(() => r())) };
}

/**
 * A fake Shopify-shaped store on loopback for "Enter a Store URL" (fictional Lumen Bikes shop, written for the dev
 * server): products.json, two policies, an FAQ page and a sitemap. { url, port, close() }. The dev Studio may import
 * from THIS port only (storeNet below); production never reaches loopback.
 */
export async function startFakeStore({ host = '127.0.0.1' } = {}) {
  const page = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body><header><nav>Shop Help Cart</nav></header><main><h1>${title}</h1>${body}</main><footer>© Lumen Bikes</footer></body></html>`;
  const products = [
    ['Trail Pro', 'trail-pro', '1899.00', 'Full-suspension carbon trail bike. Frames carry a lifetime warranty for the original owner.', [['Small / Black', 'TP-S', true], ['Large / Black', 'TP-L', false]]],
    ['Commuter Lite', 'commuter-lite', '799.00', 'Aluminium city bike with mudguards, a rack and dynamo lights.', [], '899.00'],
    ['E-City 500', 'e-city-500', '2499.00', 'Electric city bike with a 500 Wh battery: about 90 km of range on the eco setting.', []],
    ['Kids 20', 'kids-20', '349.00', 'A 20-inch bike for riders aged 6 to 9, with coaster brakes.', [], '399.00'],
    ['Gravel X', 'gravel-x', '1299.00', 'Steel gravel bike with wide tyre clearance and rack mounts.', [], null, false],
  ].map(([title, handle, price, desc, vs, compareAt = null, available = true], i) => ({ id: i + 1, title, handle, vendor: 'Lumen', product_type: 'Bikes', tags: [], body_html: `<p>${desc}</p>`,
    variants: vs.length ? vs.map(([t, sku, ok]) => ({ title: t, price, sku, available: ok, compare_at_price: compareAt })) : [{ title: 'Default Title', price, sku: handle.toUpperCase(), available, compare_at_price: compareAt }] }));
  // product photos (a simple bike drawing per product, in its own colour), served by the shop like a store's CDN
  const HUES = { 'trail-pro': ['#e8f1ee', '#0f766e'], 'commuter-lite': ['#eef0f7', '#3b4a8c'], 'e-city-500': ['#f6efe6', '#b45309'], 'kids-20': ['#f7ecf1', '#be185d'], 'gravel-x': ['#eceff1', '#475569'] };
  const bikeSvg = (handle) => {
    const [bg, fg] = HUES[handle] || ['#eee', '#333'];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="480" height="480"><rect width="240" height="240" fill="${bg}"/><g fill="none" stroke="${fg}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><circle cx="70" cy="150" r="38"/><circle cx="170" cy="150" r="38"/><path d="M70 150 L104 96 L150 96 L170 150 M104 96 L124 150 L150 96 M124 150 L70 150 M96 82 L116 82 M150 96 L146 76 L162 72"/></g></svg>`;
  };
  const withImages = (base) => products.map((p) => ({ ...p, images: [{ src: `${base}/cdn/shop/files/${p.handle}.svg`, width: 480, height: 480 }] }));
  const routes = {
    '/': () => [200, 'text/html', page('Lumen Bikes', '<p>Bikes for trails and towns.</p>', '<link href="https://cdn.shopify.com/s/theme.css"><script>Shopify.currency={"active":"USD"};</script><meta property="og:site_name" content="Lumen Bikes"><meta name="theme-color" content="#0f766e">')],
    '/products.json': (u, base) => [200, 'application/json', JSON.stringify({ products: Number(u.searchParams.get('page') || 1) > 1 ? [] : withImages(base) })],
    '/policies/refund-policy': () => [200, 'text/html', page('Refund policy', '<p>Unridden bikes can be returned within 30 days of delivery for a full refund.</p><p>Ridden bikes can be exchanged within 14 days.</p>')],
    '/policies/shipping-policy': () => [200, 'text/html', page('Shipping policy', '<p>Orders ship within 2 business days. Shipping is free in the US on orders over $100.</p>')],
    '/pages/faq': () => [200, 'text/html', page('FAQ', '<details><summary>Do you ship to Canada?</summary><p>Yes, we ship to Canada for a flat $25 fee.</p></details><details><summary>Can I test ride a bike?</summary><p>Test rides last 30 minutes and need a photo ID.</p></details>')],
    '/sitemap.xml': (u, base) => [200, 'application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/pages/faq</loc></url></urlset>`],
  };
  let delayMs = 0;   // setDelay(ms): every answer waits (the smoke stops an import during a slow discovery)
  const srv = http.createServer(async (req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = new URL(req.url, 'http://x');
    const img = /^\/cdn\/shop\/files\/([a-z0-9-]+)\.svg$/.exec(u.pathname);
    if (img && HUES[img[1]]) { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' }); return res.end(bikeSvg(img[1])); }
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    const [status, type, body] = r(u, `http://${host}:${srv.address().port}`);
    res.writeHead(status, { 'content-type': type }); res.end(body);
  });
  srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
  await new Promise((r) => srv.listen(0, host, r));
  const port = srv.address().port;
  return { url: `http://${host}:${port}`, port, setDelay: (ms) => { delayMs = Math.max(0, Number(ms) || 0); }, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(() => r())); } };
}

function assertLoopback(u, what = 'KNOWDRIVE_BASE_URL') {
  const host = new URL(u).hostname;
  if (host !== '127.0.0.1') throw new Error(`dev-server refuses to start: ${what} must resolve to 127.0.0.1 (got ${host})`);
}

/**
 * @param {{ speed?: number, port?: number, host?: string, engine?: 'scripted'|'llm', quiet?: boolean, env?: object, studio?: object }} [o]
 * @returns {Promise<{ url: string, studioUrl: string, port: number, kd: object, llm: object, kb: object, close: () => Promise<void> }>}
 */
export async function startDevServer({ speed = 1, port = 0, host = '127.0.0.1', engine = 'scripted', quiet = true, env: extra = {}, studio, channels = true, numbers = true } = {}) {
  if (extra.KNOWDRIVE_BASE_URL) assertLoopback(extra.KNOWDRIVE_BASE_URL); // refuse before starting anything
  const kd = await startFakeKnowDrive({ speed, queueStaggerMs: 600, honorScope: true, narrowScope: 'all' }); // production: a narrow-filter vector search can come back empty
  const llm = await startFakeLLM();
  const sink = await startFakeChannelSink({ host: '127.0.0.1' });
  const shop = await startFakeStore({ host: '127.0.0.1' });
  const tw = channels && numbers ? await startFakeTwilio({ host: '127.0.0.1' }) : null;
  const pay = channels && numbers ? await startFakeStripe({ host: '127.0.0.1' }) : null;
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-studio-dev-'));
  const env = {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen2.5-1.5b',
    KNOWBOT_CHECKOUT_URL: 'https://knowdrive.ai/signup?plan=knowbot',
    ...(channels ? { ...DEV_CHANNEL_SECRETS, META_GRAPH_BASE_URL: `${sink.url}/graph/v21.0`, EMAIL_REPLY_WEBHOOK: `${sink.url}/email-relay`,
      TWILIO_API_BASE_URL: sink.url, KNOWBOT_STUDIO_CHANNEL_TEST: '1',
      // "send me this" by e-mail (and the Leads report's e-mail leads): a fake mail key; every e-mail lands in the sink
      RESEND_API_KEY: 're_dev_fake', RESEND_BASE_URL: sink.url } : {}),
    ...(tw && pay ? { ...DEV_NUMBER_SECRETS, TWILIO_API_BASE_URL: tw.url, TWILIO_PRICING_BASE_URL: tw.url, STRIPE_API_BASE_URL: pay.url, STRIPE_JS_URL: `${pay.url}/stripe.js` } : {}),
    ...(engine === 'llm' ? { KNOWBOT_STUDIO_PROVIDER: 'local' } : {}),
    ...extra,
  };
  try {
    assertLoopback(env.KNOWDRIVE_BASE_URL);
    assertLoopback(env.LLM_BASE_URL, 'LLM_BASE_URL');
    if (env.KNOWBOT_STUDIO_PROVIDER && env.KNOWBOT_STUDIO_PROVIDER !== 'local') throw new Error('dev-server: only the local (fake) model is allowed');
    for (const k of ['META_GRAPH_BASE_URL', 'EMAIL_REPLY_WEBHOOK', 'RESEND_BASE_URL', 'TWILIO_API_BASE_URL', 'TWILIO_PRICING_BASE_URL', 'STRIPE_API_BASE_URL', 'STRIPE_JS_URL']) if (env[k]) assertLoopback(env[k], k);
    for (const k of REAL_PROVIDER_KEYS) if (env[k]) throw new Error(`dev-server refuses to start: ${k} would reach a real provider`);
    if (/^(?:sk|rk)_(?:live|test)_/.test(String(env.STRIPE_SECRET_KEY || ''))) throw new Error('dev-server refuses to start: STRIPE_SECRET_KEY is a real payments key');
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_API_BASE_URL) throw new Error('dev-server refuses to start: STRIPE_SECRET_KEY without a loopback STRIPE_API_BASE_URL');
  } catch (e) { await kd.close(); await llm.close(); await sink.close(); await shop.close(); await tw?.close(); await pay?.close(); throw e; }
  // "Enter a Store URL" may reach the fake shop's port on loopback only (the importer refuses loopback by default)
  const storeNet = { allowAddresses: ['127.0.0.1'], allowPorts: [shop.port], paceMs: 20 };
  const kb = createKnowBotServer({ root: ROOT, env, quiet, watch: false, dataDir, studio: { sweep: false, storeNet, ...(studio || {}) } });
  await new Promise((r, j) => { kb.server.once('error', j); kb.server.listen(port, host, r); });
  const actual = kb.server.address().port;
  const url = `http://${host}:${actual}`;
  // fake payments post the signed checkout.session.completed event to this server, like the real webhook
  if (pay) pay.state.webhook = { url: `${url}/api/studio/numbers/webhook`, secret: DEV_NUMBER_SECRETS.STRIPE_WEBHOOK_SECRET };
  return {
    url, studioUrl: `${url}/studio/`, port: actual, kd, llm, kb, dataDir, sink, shop, shopUrl: shop.url, channelSecrets: channels ? DEV_CHANNEL_SECRETS : null, numbers: tw && pay ? { provider: tw, payments: pay } : null,
    async close() {
      await new Promise((r) => kb.server.close(() => r()));
      await shop.close();
      await kd.close();
      await llm.close();
      await sink.close();
      await tw?.close();
      await pay?.close();
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const quietClientError = (e) => ['ECONNRESET', 'EPIPE', 'HPE_INVALID_EOF_STATE'].includes(e?.code);

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  delete process.env.KNOWDRIVE_API_KEY; // belt and braces: nothing below reads it, and nothing may
  // Crashes are always logged, even in quiet mode (a silent exit mid-session is undiagnosable). The dev server keeps
  // serving after an uncaught exception from one request; it exits (with the code logged) only on a real shutdown.
  const stamp = () => new Date().toISOString();
  process.on('uncaughtException', (e, origin) => { console.error(`[dev ${stamp()}] uncaughtException (${origin}): ${e?.stack || e}`); });
  process.on('unhandledRejection', (e) => { console.error(`[dev ${stamp()}] unhandledRejection: ${e?.stack || e}`); });
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(`[dev ${stamp()}] warning: ${w.stack || w}`); });
  process.on('exit', (code) => { console.error(`[dev ${stamp()}] exiting with code ${code}`); });
  for (const sig of ['SIGHUP', 'SIGPIPE']) { try { process.on(sig, () => console.error(`[dev ${stamp()}] received ${sig} (ignored)`)); } catch {} }
  const speed = Number(process.env.FAKE_SPEED || 1) || 1;
  const port = Number(process.env.PORT || 0) || 0;
  const engine = process.env.STUDIO_ENGINE === 'llm' ? 'llm' : 'scripted';
  const dev = await startDevServer({ speed, port, engine, quiet: process.env.QUIET !== '0' });
  console.log(`Studio: ${dev.studioUrl}`);
  console.log(`[dev] fake knowDrive ${dev.kd.url} · fake model ${dev.llm.url} · FAKE_SPEED=${speed} · Builder engine: ${engine}`);
  console.log(`[dev] Enter a Store URL: try ${dev.shopUrl} (a fake Shopify store on loopback; nothing else is reachable)`);
  console.log(`[dev] channels: SMS, voice, WhatsApp and e-mail webhooks use fake secrets (TWILIO_AUTH_TOKEN=${DEV_CHANNEL_SECRETS.TWILIO_AUTH_TOKEN}, EMAIL_WEBHOOK_SECRET=${DEV_CHANNEL_SECRETS.EMAIL_WEBHOOK_SECRET}); outbound sends go to ${dev.sink.url}`);
  dev.kb.server.on('error', (e) => console.error(`[dev ${stamp()}] server error: ${e?.stack || e}`));
  dev.kb.server.on('close', () => console.error(`[dev ${stamp()}] server closed`));
  dev.kb.server.on('clientError', (e, sock) => { if (!quietClientError(e)) console.error(`[dev ${stamp()}] clientError: ${e.code || e.message}`); try { sock.destroy(); } catch {} });
  const stop = async (sig) => { console.error(`[dev ${stamp()}] ${sig || 'stop'}: shutting down`); await dev.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
