// The research agent behind every bot answer (lib/knowbot.js researchAnswer): Claude reads whole passages, may search
// the bot's files again, and points at the lines to quote word for word (plus an optional summary the library verifies
// against those lines). Without a key, or with KNOWBOT_RESEARCH=off, there is no agent and bots keep the select path.
//
// Settings (names only): ANTHROPIC_API_KEY (also the Builder's), KNOWBOT_RESEARCH_MODEL (default claude-haiku-5-5),
// KNOWBOT_RESEARCH_EFFORT (low | medium | high; unset or anything else: the model's own default, no effort sent; it applies
// to this research step only), KNOWBOT_RESEARCH=off, KNOWBOT_ANTHROPIC_BASE_URL (tests: a fake on 127.0.0.1).
import { createAnthropicComplete } from './builder/engine.mjs';

export const RESEARCH_MODEL = 'claude-haiku-5-5';
/** The research step's effort (Messages API output_config.effort), or null for the model's default. */
export function researchEffort(v) {
  const e = String(v ?? '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(e) ? e : null;
}

/**
 * @param {object} env
 * @param {{ key?: () => string|null, log?: (s: string) => void, timeoutMs?: number }} [o]
 * @returns {null | ((params: object, opts?: {signal?: AbortSignal}) => Promise<object>)}
 */
export function createResearchAgent(env = {}, o = {}) {
  if (/^(?:off|0|false|no)$/i.test(String(env.KNOWBOT_RESEARCH || ''))) return null;
  const key = typeof o.key === 'function' ? o.key : () => env.ANTHROPIC_API_KEY || null;
  if (!key()) return null;
  const model = env.KNOWBOT_RESEARCH_MODEL || RESEARCH_MODEL;
  const effort = researchEffort(env.KNOWBOT_RESEARCH_EFFORT);
  const log = typeof o.log === 'function' ? o.log : () => {};
  const complete = createAnthropicComplete({ apiKey: () => key(), baseURL: env.KNOWBOT_ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeoutMs: Number(o.timeoutMs || 20000) });
  const agent = async (params, { signal } = {}) => {
    const t0 = Date.now();
    try {
      const r = await complete({ model, ...params, ...(effort ? { output_config: { effort } } : {}) }, { signal });
      return r;
    } catch (e) {
      log(`[research] ${model} failed after ${Date.now() - t0} ms: ${e?.status || ''} ${e?.message || e}`);
      throw e;
    }
  };
  agent.model = model;
  agent.effort = effort;
  return agent;
}
