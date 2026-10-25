// KnowBot API on Cloudflare: a thin Worker in front of one Container that runs llama-server
// (Qwen2.5-1.5B-Instruct Q4_K_M) and the unchanged KnowBot Node server (server/server.mjs).
// The static site (dashboard + demos) is served separately at knowbot.knowdrive.ai.
import { Container, getContainer } from '@cloudflare/containers';

export class KnowBotContainer extends Container {
  defaultPort = 8787;
  sleepAfter = '15m'; // scale to zero when idle; the next request wakes it (model load ~10-20 s)
  constructor(ctx, env) {
    super(ctx, env);
    // Secrets live in the Worker (wrangler secret put) and reach the container only as env vars.
    this.envVars = {
      KNOWDRIVE_API_KEY: env.KNOWDRIVE_API_KEY || '',
      KNOWBOT_RATE_LIMIT: env.KNOWBOT_RATE_LIMIT || '30',
      ...(env.KNOWBOT_DASHBOARD_TOKEN ? { KNOWBOT_DASHBOARD_TOKEN: env.KNOWBOT_DASHBOARD_TOKEN } : {}),
      // Required for creating chat instances and uploading files from the dashboard (writes to the knowDrive store).
      ...(env.KNOWBOT_ADMIN_TOKEN ? { KNOWBOT_ADMIN_TOKEN: env.KNOWBOT_ADMIN_TOKEN } : {}),
      // Optional: seals stored OpenAI/Anthropic keys (defaults to the admin token).
      ...(env.KNOWBOT_SECRET_KEY ? { KNOWBOT_SECRET_KEY: env.KNOWBOT_SECRET_KEY } : {}),
    };
  }

  // A running container keeps the env it started with. When a deploy or `wrangler secret put` changes the secrets
  // (rotated admin token, new knowDrive key) the same image can stay up with the old values, so compare a
  // fingerprint of the env on every request and restart the container once when it changed.
  async fetch(request) {
    const fp = await fingerprint(this.envVars);
    let started = null;
    try { started = this.ctx.storage.kv.get(ENV_FP_KEY) ?? null; } catch { /* storage unavailable: no restart check */ }
    if (started !== fp) {
      if (this.container.running) {
        await this.destroy();
        for (let i = 0; i < 50 && this.container.running; i++) await new Promise((r) => setTimeout(r, 100));
      }
      try { this.ctx.storage.kv.put(ENV_FP_KEY, fp); } catch { /* ignore */ }
    }
    return super.fetch(request);
  }
}

const ENV_FP_KEY = 'knowbot-env-fingerprint';
async function fingerprint(vars) {
  const data = new TextEncoder().encode(JSON.stringify(Object.entries(vars || {}).sort()));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-filename', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/healthz') {
      return Response.json({ service: 'knowbot-api', ok: true, site: env.SITE_URL || 'https://knowbot.knowdrive.ai' }, { headers: CORS });
    }
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404, headers: CORS });
    // One instance: sessions, the dashboard event feed and SSE all live in the same Node process.
    const box = getContainer(env.KNOWBOT, 'main');
    const headers = new Headers(request.headers);
    // The server only trusts X-Forwarded-For behind a proxy (KNOWBOT_TRUST_PROXY=1): set it, never append.
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '0.0.0.0');
    try {
      return await box.fetch(new Request(request, { headers }));
    } catch (e) {
      return Response.json({ error: { status: 503, message: `KnowBot is waking up, try again in a few seconds (${e.message || e})` } }, { status: 503, headers: { ...CORS, 'retry-after': '5' } });
    }
  },
};
