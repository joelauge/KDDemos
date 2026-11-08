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
      // The commit being deployed: part of the env fingerprint, so a new deploy restarts a warm container on the new image.
      ...(env.KNOWBOT_BUILD ? { KNOWBOT_BUILD: env.KNOWBOT_BUILD } : {}),
      ...(env.KNOWBOT_DASHBOARD_TOKEN ? { KNOWBOT_DASHBOARD_TOKEN: env.KNOWBOT_DASHBOARD_TOKEN } : {}),
      // Required for creating chat instances and uploading files from the dashboard (writes to the knowDrive store).
      ...(env.KNOWBOT_ADMIN_TOKEN ? { KNOWBOT_ADMIN_TOKEN: env.KNOWBOT_ADMIN_TOKEN } : {}),
      // Optional: seals stored OpenAI/Anthropic keys (defaults to the admin token).
      ...(env.KNOWBOT_SECRET_KEY ? { KNOWBOT_SECRET_KEY: env.KNOWBOT_SECRET_KEY } : {}),
      // KnowBot Studio Builder (Claude): the key is a Worker secret (GitHub secret ANTHROPIC_API_KEY); provider and model are plain vars.
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.KNOWBOT_STUDIO_PROVIDER ? { KNOWBOT_STUDIO_PROVIDER: env.KNOWBOT_STUDIO_PROVIDER } : {}),
      ...(env.KNOWBOT_STUDIO_MODEL ? { KNOWBOT_STUDIO_MODEL: env.KNOWBOT_STUDIO_MODEL } : {}),
      // Phone channel (server/channels/voice.mjs + voice-live.mjs) and SMS: Worker secrets, passed through only when set, so
      // a missing one leaves that feature off ("channel not configured") instead of breaking the container.
      ...pick(env, ['GEMINI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
        // plain vars (wrangler.jsonc "vars" or --var), optional
        // (no SHOP_DOMAIN: product links come from each bot's own Shopify store import, never one server-wide store)
        'GEMINI_LIVE_MODEL', 'GEMINI_VOICE', 'KNOWBOT_PUBLIC_URL', 'KNOWBOT_PHONE_MAX_SECONDS', 'KNOWBOT_PHONE_MAX_SESSIONS']),
    };
  }

  // A running container keeps the env and image it started with. When `wrangler secret put` changes a secret (rotated
  // admin token, new knowDrive key) or a deploy ships new code (KNOWBOT_BUILD), compare a fingerprint of the env on
  // every request and restart the container once when it changed.
  // Long phone calls and web voice sessions: @cloudflare/containers 0.3.7 counts a proxied WebSocket as an in-flight
  // request until it closes (containerFetch → inflightRequests; isActivityExpired() is false while any is open, and every
  // forwarded message renews the activity timeout), so sleepAfter never puts a container to sleep mid-call. The restart
  // below would cut a call, though, so it waits until nothing is in flight; the next request after that restarts it.
  // Checked with `wrangler dev --local-protocol https` and a stand-in container: wss upgrades on the media stream and web
  // voice paths reach the container with Upgrade: websocket and x-forwarded-proto https; other upgrade paths get 404.
  async fetch(request) {
    const fp = await fingerprint(this.envVars);
    let started = null;
    try { started = this.ctx.storage.kv.get(ENV_FP_KEY) ?? null; } catch { /* storage unavailable: no restart check */ }
    const busy = this.container.running && Number(this.inflightRequests || 0) > 0;
    if (started !== fp && !busy) {
      if (this.container.running) {
        await this.destroy();
        for (let i = 0; i < 50 && this.container.running; i++) await new Promise((r) => setTimeout(r, 100));
      }
      try { this.ctx.storage.kv.put(ENV_FP_KEY, fp); } catch { /* ignore */ }
    }
    return super.fetch(request);
  }
}

const pick = (env, names) => Object.fromEntries(names.filter((n) => env[n]).map((n) => [n, String(env[n])]));

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
    // WebSocket upgrades: only the phone channel's Twilio Media Streams path and the web voice assistant's socket go to the
    // container (the Container class proxies the socket both ways); any other upgrade is refused here.
    const upgrade = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
    if (upgrade && !/^\/api\/v1\/(?:channels\/[^/]+\/voice\/media|bots\/[^/]+\/voice\/live)\/?$/.test(url.pathname)) return new Response('not found', { status: 404 });
    // One instance: sessions, the dashboard event feed and SSE all live in the same Node process.
    const box = getContainer(env.KNOWBOT, 'main');
    const headers = new Headers(request.headers);
    // The server only trusts X-Forwarded-For behind a proxy (KNOWBOT_TRUST_PROXY=1): set it, never append.
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '0.0.0.0');
    // Twilio signs the https URL it called and media streams must be wss: tell the server the public scheme.
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    try {
      return await box.fetch(new Request(request, { headers }));
    } catch (e) {
      if (upgrade) return new Response('KnowBot is waking up, try again in a few seconds', { status: 503, headers: { 'retry-after': '5' } });
      return Response.json({ error: { status: 503, message: `KnowBot is waking up, try again in a few seconds (${e.message || e})` } }, { status: 503, headers: { ...CORS, 'retry-after': '5' } });
    }
  },
};
