// Answering models for bots: the local llama.cpp model, or a hosted platform (OpenAI, Anthropic) with the
// operator's own API key. Keys are stored encrypted in the registry and never leave the server.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const PROVIDERS = Object.freeze({
  local: { label: 'Local model (llama.cpp)', needsKey: false },
  openai: { label: 'OpenAI', needsKey: true, keyHint: 'sk-…', docs: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic (Claude)', needsKey: true, keyHint: 'sk-ant-…', docs: 'https://platform.claude.com/settings/keys', defaultModel: 'claude-opus-5-5' },
});

export class ProviderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- key storage (AES-256-GCM)
const keyFor = (secret) => createHash('sha256').update(`knowbot-provider-keys\n${secret}`).digest();
export function sealKey(apiKey, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([c.update(String(apiKey), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
export function openKey(sealed, secret) {
  const [v, iv, tag, body] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new ProviderError(500, 'stored API key is unreadable');
  try {
    const d = createDecipheriv('aes-256-gcm', keyFor(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new ProviderError(409, 'the stored API key was sealed with a different server secret; enter it again');
  }
}

// ---------------------------------------------------------------- calls
// Line selection needs a few tokens of answer; thinking models spend their budget thinking first, so give them room.
const SELECT_MAX = 24;
const isSelect = (settings) => Number(settings?.max_tokens) > 0 && Number(settings.max_tokens) <= SELECT_MAX * 2;
const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '');

// Models that take output_config.effort, and the ones that take the server-side refusal fallback.
const CLAUDE_EFFORT = /^claude-(?:fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[5-8]|sonnet-4-6)/;
const CLAUDE_FALLBACK = /^claude-(?:fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

// Pinned hosts: an inherited ANTHROPIC_BASE_URL must never redirect an operator's key. Tests override explicitly.
const ANTHROPIC_BASE = () => process.env.KNOWBOT_ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const OPENAI_BASE = () => process.env.KNOWBOT_OPENAI_BASE_URL || 'https://api.openai.com/v1';

let anthropicMod = null;
async function anthropicSdk() {
  if (!anthropicMod) {
    try { anthropicMod = (await import('@anthropic-ai/sdk')).default; }
    catch { throw new ProviderError(503, 'the Anthropic SDK is not installed on this server (npm install in knowbot/)'); }
  }
  return anthropicMod;
}

async function anthropicError(e) {
  const A = await anthropicSdk();
  if (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError) return new ProviderError(401, 'Anthropic rejected the API key');
  if (e instanceof A.NotFoundError) return new ProviderError(400, `Anthropic: ${e.message}`);
  if (e instanceof A.BadRequestError) return new ProviderError(400, `Anthropic: ${e.message}`);
  if (e instanceof A.RateLimitError) return new ProviderError(429, 'Anthropic rate limit reached; try again shortly');
  if (e instanceof A.APIError) return new ProviderError(502, `Anthropic error ${e.status ?? ''}: ${e.message}`);
  return new ProviderError(502, `Anthropic unreachable: ${e.message}`);
}

async function anthropicComplete(apiKey, model, messages, settings) {
  const A = await anthropicSdk();
  const client = new A({ apiKey, baseURL: ANTHROPIC_BASE(), maxRetries: 1, timeout: 120000 });
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const select = isSelect(settings);
  // No temperature/top_p: current Claude models reject sampling parameters. Depth comes from effort instead.
  const req = {
    model, system, messages: turns,
    max_tokens: select ? 4000 : Math.max(Number(settings?.max_tokens) || 0, 2000) + 6000,
    ...(CLAUDE_EFFORT.test(model) ? { output_config: { effort: select ? 'low' : 'medium' } } : {}),
  };
  try {
    const r = CLAUDE_FALLBACK.test(model)
      ? await client.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(req);
    // A declined request answers nothing: KnowBot then gives its fixed "not in my data" reply.
    if (r.stop_reason === 'refusal') return '';
    return textOf(r.content);
  } catch (e) { throw await anthropicError(e); }
}

async function openaiFetch(apiKey, path, init = {}) {
  let res;
  try {
    res = await fetch(`${OPENAI_BASE()}${path}`, {
      ...init, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(120000),
    });
  } catch (e) { throw new ProviderError(502, `OpenAI unreachable: ${e.cause?.code || e.message}`); }
  const text = await res.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  if (res.status === 401 || res.status === 403) throw new ProviderError(401, 'OpenAI rejected the API key');
  if (res.status === 429) throw new ProviderError(429, `OpenAI: ${j.error?.message || 'rate limit reached'}`);
  if (!res.ok) throw new ProviderError(res.status === 400 || res.status === 404 ? 400 : 502, `OpenAI: ${j.error?.message || text.slice(0, 200)}`);
  return j;
}

async function openaiComplete(apiKey, model, messages, settings) {
  const select = isSelect(settings);
  const base = { model, messages, max_completion_tokens: select ? 2000 : Math.max(Number(settings?.max_tokens) || 0, 1000) + 3000 };
  try {
    const j = await openaiFetch(apiKey, '/chat/completions', { method: 'POST', body: JSON.stringify({ ...base, temperature: 0 }) });
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    // Reasoning models only accept the default temperature.
    if (!(e instanceof ProviderError) || e.status !== 400 || !/temperature/i.test(e.message)) throw e;
    const j = await openaiFetch(apiKey, '/chat/completions', { method: 'POST', body: JSON.stringify(base) });
    return j.choices?.[0]?.message?.content ?? '';
  }
}

/** The models a platform offers to this key (also how a key is checked before it is saved). */
export async function listModels(provider, apiKey) {
  if (provider === 'openai') {
    const j = await openaiFetch(apiKey, '/models');
    return (j.data || []).map((m) => m.id).filter((id) => /^(?:gpt-|o\d|chatgpt-)/.test(id) && !/(?:audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
      .sort().map((id) => ({ id, label: id }));
  }
  if (provider === 'anthropic') {
    const A = await anthropicSdk();
    const client = new A({ apiKey, baseURL: ANTHROPIC_BASE(), maxRetries: 1, timeout: 30000 });
    const out = [];
    try { for await (const m of client.models.list()) out.push({ id: m.id, label: m.display_name || m.id }); }
    catch (e) { throw await anthropicError(e); }
    return out;
  }
  throw new ProviderError(400, `unknown provider "${provider}"`);
}

export function completeWith(provider, apiKey, model, messages, settings) {
  if (provider === 'openai') return openaiComplete(apiKey, model, messages, settings);
  if (provider === 'anthropic') return anthropicComplete(apiKey, model, messages, settings);
  throw new ProviderError(400, `unknown provider "${provider}"`);
}
