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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Fake channel credentials (fixer r1): every channel webhook works end to end on the dev server. Nothing here is a real
// secret; outbound sends (Meta Graph, e-mail relay, Twilio REST) go to a loopback sink that records them.
export const DEV_CHANNEL_SECRETS = Object.freeze({
  TWILIO_AUTH_TOKEN: 'dev-twilio-auth-token', TWILIO_ACCOUNT_SID: 'ACdev00000000000000000000000000000',
  WHATSAPP_VERIFY_TOKEN: 'dev-whatsapp-verify', WHATSAPP_APP_SECRET: 'dev-whatsapp-app-secret', WHATSAPP_ACCESS_TOKEN: 'dev-whatsapp-access-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
  EMAIL_WEBHOOK_SECRET: 'dev-email-secret', EMAIL_FROM: 'bot@studio.test',
});
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

function assertLoopback(u, what = 'KNOWDRIVE_BASE_URL') {
  const host = new URL(u).hostname;
  if (host !== '127.0.0.1') throw new Error(`dev-server refuses to start: ${what} must resolve to 127.0.0.1 (got ${host})`);
}

/**
 * @param {{ speed?: number, port?: number, host?: string, engine?: 'scripted'|'llm', quiet?: boolean, env?: object, studio?: object }} [o]
 * @returns {Promise<{ url: string, studioUrl: string, port: number, kd: object, llm: object, kb: object, close: () => Promise<void> }>}
 */
export async function startDevServer({ speed = 1, port = 0, host = '127.0.0.1', engine = 'scripted', quiet = true, env: extra = {}, studio, channels = true } = {}) {
  if (extra.KNOWDRIVE_BASE_URL) assertLoopback(extra.KNOWDRIVE_BASE_URL); // refuse before starting anything
  const kd = await startFakeKnowDrive({ speed, queueStaggerMs: 1800, honorScope: true });
  const llm = await startFakeLLM();
  const sink = await startFakeChannelSink({ host: '127.0.0.1' });
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-studio-dev-'));
  const env = {
    KNOWDRIVE_BASE_URL: kd.url, KNOWDRIVE_API_KEY: 'fake-key', KNOWDRIVE_STORE: 'vs_fake', KNOWBOT_TRIAL_STORE: 'vs_fake_trials',
    KNOWBOT_ADMIN_TOKEN: 'dev-admin', KNOWBOT_SECRET_KEY: 'dev-secret', LLM_BASE_URL: `${llm.url}/v1`, LLM_MODEL: 'fake-qwen2.5-1.5b',
    KNOWBOT_CHECKOUT_URL: 'https://knowdrive.ai/signup?plan=knowbot',
    ...(channels ? { ...DEV_CHANNEL_SECRETS, META_GRAPH_BASE_URL: `${sink.url}/graph/v21.0`, EMAIL_REPLY_WEBHOOK: `${sink.url}/email-relay`,
      TWILIO_API_BASE_URL: sink.url, KNOWBOT_STUDIO_CHANNEL_TEST: '1' } : {}),
    ...(engine === 'llm' ? { KNOWBOT_STUDIO_PROVIDER: 'local' } : {}),
    ...extra,
  };
  try {
    assertLoopback(env.KNOWDRIVE_BASE_URL);
    assertLoopback(env.LLM_BASE_URL, 'LLM_BASE_URL');
    if (env.KNOWBOT_STUDIO_PROVIDER && env.KNOWBOT_STUDIO_PROVIDER !== 'local') throw new Error('dev-server: only the local (fake) model is allowed');
    for (const k of ['META_GRAPH_BASE_URL', 'EMAIL_REPLY_WEBHOOK', 'TWILIO_API_BASE_URL']) if (env[k]) assertLoopback(env[k], k);
    for (const k of REAL_PROVIDER_KEYS) if (env[k]) throw new Error(`dev-server refuses to start: ${k} would reach a real provider`);
  } catch (e) { await kd.close(); await llm.close(); await sink.close(); throw e; }
  const kb = createKnowBotServer({ root: ROOT, env, quiet, watch: false, dataDir, studio: { sweep: false, ...(studio || {}) } });
  await new Promise((r, j) => { kb.server.once('error', j); kb.server.listen(port, host, r); });
  const actual = kb.server.address().port;
  const url = `http://${host}:${actual}`;
  return {
    url, studioUrl: `${url}/studio/`, port: actual, kd, llm, kb, dataDir, sink, channelSecrets: channels ? DEV_CHANNEL_SECRETS : null,
    async close() {
      await new Promise((r) => kb.server.close(() => r()));
      await kd.close();
      await llm.close();
      await sink.close();
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
  console.log(`[dev] channels: SMS, voice, WhatsApp and e-mail webhooks use fake secrets (TWILIO_AUTH_TOKEN=${DEV_CHANNEL_SECRETS.TWILIO_AUTH_TOKEN}, EMAIL_WEBHOOK_SECRET=${DEV_CHANNEL_SECRETS.EMAIL_WEBHOOK_SECRET}); outbound sends go to ${dev.sink.url}`);
  dev.kb.server.on('error', (e) => console.error(`[dev ${stamp()}] server error: ${e?.stack || e}`));
  dev.kb.server.on('close', () => console.error(`[dev ${stamp()}] server closed`));
  dev.kb.server.on('clientError', (e, sock) => { if (!quietClientError(e)) console.error(`[dev ${stamp()}] clientError: ${e.code || e.message}`); try { sock.destroy(); } catch {} });
  const stop = async (sig) => { console.error(`[dev ${stamp()}] ${sig || 'stop'}: shutting down`); await dev.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
