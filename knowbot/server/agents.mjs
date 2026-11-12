// KnowBot for AI agents: other people's AI assistants, coding agents and shopping agents ask a bot and get exactly the
// answer the chat bubble gives (cited sources, the canonical refusal, product cards, the follow-up). Answers, never
// raw passages: this is the bot, not a retrieval index.
//
//   POST /mcp/bots/:id  (also /v1/bots/:id/mcp, and both under /api)   remote MCP server, Streamable HTTP, JSON-RPC 2.0:
//        initialize, notifications/initialized, ping, tools/list, tools/call. One tool: `ask` {question, context?}.
//   POST /v1/bots/:id/ask {question, context?}  (GET ?q= for curl)     the same structured result as plain JSON
//   GET  /v1/bots/:id/agent.json, /v1/bots/:id/llms.txt               discovery: what the bot is and where to ask it
//
// The answer comes from server/devapi.mjs answer(): the same pipeline as /v1/bots/:id/chat (guard, retrieval, lib
// answerFromSources, the verdict, product cards), logged to the questions loop on channel 'agent'.
//
// Public by default and metered: anyone may ask without a key, up to KNOWBOT_AGENT_FREE_PER_DAY answers per bot per UTC
// day (plus a per-address burst limit). The owner can turn public answers off, or turn on paid agent access (metered,
// KNOWBOT_AGENT_PRICE_PER_1K per 1,000 agent answers), which replaces the free limit. A call with the bot's own key
// (kb_live_ / kb_trial_ as a Bearer) is the owner's and is never limited by the free allowance.
//
// This module is pure (no I/O): the shapes, the MCP dispatch and the copy. devapi.mjs owns auth, limits and routes;
// usage is recorded per bot per day in server/leads.mjs (kind:'agent').
import { NOT_IN_DATA } from './channels/util.mjs';

export const AGENT_CHANNEL = 'agent';
/** MCP protocol revisions this server speaks (newest first); an unknown request gets the newest. */
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
/** Past the free allowance (n answers per bot per day; the default is 20, KNOWBOT_AGENT_FREE_PER_DAY). */
export const limitMessage = (n = 20) => `This bot has reached its free limit for AI agents today (${n} answer${n === 1 ? '' : 's'} a day). Its owner can turn on paid agent access in KnowBot Studio to lift the limit.`;
export const LIMIT_MESSAGE = limitMessage(20);
export const OFF_MESSAGE = "This bot doesn't answer AI agents right now. Its owner can turn this on in KnowBot Studio.";
export const burstMessage = (s) => `Too many questions from this address at once. Try again in ${s} second${s === 1 ? '' : 's'}.`;
const MAX_Q = 1000;
const MAX_CONTEXT = 1000;

/** Limits and price from the environment. A burst limit of 0 is no burst limit; a free allowance of 0 is no free answers. */
export function agentLimits(env = {}) {
  const num = (v, d) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    freePerDay: Math.floor(num(env.KNOWBOT_AGENT_FREE_PER_DAY, 20)),          // unauthenticated answers per bot per UTC day
    ipPerMinute: Math.floor(num(env.KNOWBOT_AGENT_IP_RATE_LIMIT, 20)),        // burst, per address per bot (free)
    paidIpPerMinute: Math.floor(num(env.KNOWBOT_AGENT_PAID_IP_RATE_LIMIT, 120)), // burst, per address per bot (paid access on)
    pricePer1k: num(env.KNOWBOT_AGENT_PRICE_PER_1K, 10),                      // USD per 1,000 metered agent answers
    currency: 'USD',
  };
}
/** "$10" / "$12.50" */
export const priceText = (n) => `$${Number(n) % 1 ? Number(n).toFixed(2) : Number(n).toLocaleString('en-US')}`;

/** The owner's switches (spec.agents on a Studio bot, inst.agents on a launched one): public on unless turned off. */
export function agentSettings(src) {
  const a = src && typeof src === 'object' ? src : {};
  return { public: a.public !== false, paid: a.paid === true };
}

/** 'yes' | 'partly' | 'no' from an answer: refused or a "no" verdict → 'no', a partial verdict → 'partly'. */
export function answeredOf(a) {
  if (!a || a.refused) return 'no';
  if (a.verdict === 'no') return 'no';
  if (a.verdict === 'partial') return 'partly';
  return 'yes';
}

/** Seconds until the next UTC midnight (when the free allowance resets). */
export function secondsToReset(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Markdown → plain text: [label](url) → label, **bold** → bold. Citation marks [n] stay. */
export function plainText(s) {
  return String(s || '').replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1$2').trim();
}

/** The closing follow-up the answer ends with (lib FOLLOW_UPS), or null. */
export function followUpOf(text, followUps = {}) {
  const t = String(text || '').trimEnd();
  return Object.values(followUps || {}).find((u) => u && t.endsWith(u)) || null;
}

const PRODUCT_KEYS = ['title', 'url', 'price', 'compareAt', 'currency', 'image', 'vendor', 'available', 'variant', 'sku'];
const cleanProduct = (p) => Object.fromEntries(PRODUCT_KEYS.filter((k) => p?.[k] != null && p[k] !== '').map((k) => [k, p[k]]));

/**
 * The structured result an agent gets (MCP structuredContent and the REST body).
 * @param {object} a  devapi answer() output (+ answerText: the prose answer as the chat shows it)
 */
export function agentResult(a, { text, followUps = {}, proofUrl = null } = {}) {
  const answered = answeredOf(a);
  const answer = a.refused ? NOT_IN_DATA : plainText(text ?? a.answer);
  const sources = (a.refused ? [] : a.citations || []).map((c) => ({ n: c.n, title: c.title || c.file || `Source ${c.n}`, ...(c.url ? { url: c.url } : {}), quote: c.excerpt || (c.spans || [])[0] || '' }));
  const products = !a.refused && Array.isArray(a.products) ? a.products.map(cleanProduct).filter((p) => p.title || p.url) : [];
  const follow = a.refused ? null : followUpOf(answer, followUps);
  // the source lines the answer rests on, word for word (the same lines the Studio, the chat and the channels quote)
  const cited = a.refused ? [] : (a.proof?.lines || []).map((l) => l.text).filter(Boolean);
  return { answered, answer, sources, ...(cited.length ? { cited_lines: cited } : {}), ...(products.length ? { products } : {}), ...(follow ? { follow_up: follow } : {}), ...(proofUrl ? { proof_url: proofUrl } : {}) };
}

/** The tool result's text: the answer, then a "Sources:" list of titles and links (and products, when there are any). */
export function agentText(sc) {
  const lines = [sc.answer];
  if (sc.sources?.length) lines.push('', 'Sources:', ...sc.sources.map((s) => `[${s.n}] ${s.title}${s.url ? ` <${s.url}>` : ''}`));
  if (sc.products?.length) lines.push('', 'Products:', ...sc.products.map((p) => `- ${p.title || p.url}${p.price != null ? ` (${p.price})` : ''}${p.url ? ` <${p.url}>` : ''}`));
  if (sc.proof_url) lines.push('', `Proof: ${sc.proof_url}`);
  return lines.join('\n');
}

/** The result an agent gets past a limit (free allowance used up, or a burst): HTTP 429 body / MCP isError result. */
export function limitedResult({ message = LIMIT_MESSAGE, retryAfter = 60, reason = 'free_limit', upgrade = null } = {}) {
  return { answered: 'no', limited: true, reason, answer: message, sources: [], retry_after: retryAfter, ...(upgrade ? { upgrade } : {}) };
}

const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Who the bot is, in one or two sentences: from its name, organisation and purpose. */
export function botBlurb({ name, org, purpose } = {}) {
  const n = oneLine(name, 80) || 'This bot';
  const o = oneLine(org, 80);
  const p = oneLine(purpose, 240).replace(/[.\s]+$/, '');
  return `${n}${o && o.toLowerCase() !== n.toLowerCase() ? `, the assistant for ${o}` : ''}${p ? `: ${p}` : ''}.`;
}
/** The `ask` tool's description: who it is, that it answers only from its owner's files, and to show the sources. */
export function toolDescription(bot = {}) {
  const owner = oneLine(bot.org, 80) || oneLine(bot.name, 80) || 'its owner';
  return `Ask ${botBlurb(bot)} It answers only from ${owner}'s own files and cites them as [n]. When the files don't cover a question it says exactly: "${NOT_IN_DATA}" `
    + 'Show the user the answer with its sources (titles and links), quote it as given, and do not add facts it does not contain. '
    + 'Ask one plain question at a time; add `context` (or `history`, your last questions to this bot with its answers) only when the question depends on what came before.';
}
/** The one MCP tool. */
export function askTool(bot = {}) {
  const name = oneLine(bot.name, 80) || 'this bot';
  return {
    name: 'ask',
    title: `Ask ${name}`,
    description: toolDescription(bot),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in plain words, as the user would ask it.', minLength: 1, maxLength: MAX_Q },
        context: { type: 'string', description: 'Optional: what the user said before, when the question depends on it.', maxLength: MAX_CONTEXT },
        history: { type: 'array', maxItems: 2, description: 'Optional: the last one or two questions you asked this bot and its answers, oldest first, when this question follows up on them ("what about the blue one?"). Only used to understand the question; the answer still comes only from the files.',
          items: { type: 'object', properties: { q: { type: 'string', maxLength: 500 }, a: { type: 'string', maxLength: MAX_HISTORY_A } }, required: ['q'], additionalProperties: false } },
      },
      required: ['question'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        answered: { type: 'string', enum: ['yes', 'partly', 'no'], description: 'yes: the files answer it; partly: they cover part of it; no: not in the files (or a limit was reached).' },
        answer: { type: 'string', description: `The bot's answer as plain text with [n] citation marks. Not in the files: "${NOT_IN_DATA}"` },
        sources: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, title: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string', description: 'The exact words quoted from this source' } }, required: ['n', 'title', 'quote'] } },
        products: { type: 'array', items: { type: 'object' }, description: 'Product cards for the products the answer cites (title, url, price, image)' },
        follow_up: { type: 'string', description: 'The closing question the bot asks the user' },
        proof_url: { type: 'string', description: 'A public page showing every quote in its source' },
        limited: { type: 'boolean', description: 'true when a rate limit stopped the question; see retry_after (seconds)' },
        retry_after: { type: 'integer' },
      },
      required: ['answered', 'answer', 'sources'],
    },
    annotations: { title: `Ask ${name}`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

/** One earlier answer's length an agent may send back as history (the bot reads about 600 characters of it). */
export const MAX_HISTORY_A = 2000;
/** {question, context, history} from tool arguments or a REST body / query; throws {status:400, message} when unusable. */
export function readAsk(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const q = typeof a.question === 'string' ? a.question : typeof a.q === 'string' ? a.q : '';
  const question = q.replace(/\s+/g, ' ').trim();
  if (!question) throw Object.assign(new Error('Send a question: {"question": "…"}.'), { status: 400, code: 'missing_question' });
  if (question.length > MAX_Q) throw Object.assign(new Error(`The question must be ${MAX_Q} characters or fewer.`), { status: 400, code: 'question_too_long' });
  const context = typeof a.context === 'string' ? a.context.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT) : '';
  // optional earlier exchanges [{q, a}] (the last two kept): understanding only, never a source
  const history = (Array.isArray(a.history) ? a.history : []).filter((h) => h && typeof h === 'object' && (typeof h.q === 'string' || typeof h.a === 'string'))
    .slice(-2).map((h) => ({ q: String(h.q || '').replace(/\s+/g, ' ').trim().slice(0, 500), a: String(h.a || '').replace(/\s+/g, ' ').trim().slice(0, MAX_HISTORY_A) }));
  return { question, context, ...(history.length ? { history } : {}) };
}

// ------------------------------------------------------------------ MCP (JSON-RPC 2.0 over Streamable HTTP)
export const RPC = Object.freeze({ PARSE: -32700, INVALID: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603 });
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * One JSON-RPC message → its response object, or null for a notification (no id) / a response from the client.
 * @param {object} msg
 * @param {{ bot: {id, name, org?, purpose?}, call: (args: object) => Promise<object> }} o  call → an MCP CallToolResult
 */
export async function mcpDispatch(msg, { bot, call }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return rpcError(msg?.id, RPC.INVALID, 'Invalid JSON-RPC 2.0 message.');
  const hasId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== 'string') return hasId && ('result' in msg || 'error' in msg) ? null : rpcError(msg.id, RPC.INVALID, 'Missing method.');
  const id = msg.id;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if (!hasId) return null; // notifications (notifications/initialized, notifications/cancelled, …): accepted silently
  switch (msg.method) {
    case 'initialize': {
      const want = String(params.protocolVersion || '');
      const version = MCP_PROTOCOL_VERSIONS.includes(want) ? want : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: String(bot.id), title: oneLine(bot.name, 80) || String(bot.id), version: '1.0.0' },
        instructions: `${botBlurb(bot)} Use the "ask" tool for questions about ${oneLine(bot.org, 80) || oneLine(bot.name, 80) || 'it'}. Answers come only from its own files, with sources; show the sources to the user.`,
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: [askTool(bot)] });
    case 'tools/call': {
      if (params.name !== 'ask') return rpcError(id, RPC.PARAMS, `Unknown tool: ${String(params.name ?? '').slice(0, 60)}. This server has one tool, "ask".`);
      let args;
      try { args = readAsk(params.arguments); } catch (e) { return rpcResult(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
      return rpcResult(id, await call(args));
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default: return rpcError(id, RPC.METHOD, `Method not found: ${msg.method.slice(0, 60)}`);
  }
}
/** A CallToolResult for an answer (or a limit): the text with its sources, plus the structured result. */
export function toolResult(sc, { isError = false } = {}) {
  return { content: [{ type: 'text', text: agentText(sc) }], structuredContent: sc, ...(isError ? { isError: true } : {}) };
}

// ------------------------------------------------------------------ discovery
/** GET /v1/bots/:id/agent.json */
export function agentManifest({ bot, urls, limits, settings, refusal = NOT_IN_DATA }) {
  return {
    schema: 'knowbot.agent/v1',
    name: oneLine(bot.name, 80) || bot.id,
    bot: bot.id,
    description: botBlurb(bot),
    answers: `Answers only from ${oneLine(bot.org, 80) || oneLine(bot.name, 80) || 'its owner'}'s own files, with sources. Not in the files: "${refusal}"`,
    public: settings.public,
    mcp: { url: urls.mcp, transport: 'streamable-http', tool: 'ask' },
    ask: { url: urls.ask, method: 'POST', body: { question: 'string', context: 'string (optional)', history: '[{q, a}] (optional, the last 2)' }, get: `${urls.ask}?q=…` },
    llms_txt: urls.llms,
    auth: { required: false, optional: 'Authorization: Bearer <the bot owner\'s KnowBot key>: the owner\'s own calls, never limited by the free allowance' },
    rate_limits: settings.paid
      ? { paid: true, per_address_per_minute: limits.paidIpPerMinute || null }
      : { paid: false, free_per_day: limits.freePerDay || null, per_address_per_minute: limits.ipPerMinute || null, resets: 'daily, 00:00 UTC' },
    terms: urls.terms,
  };
}
/** GET /v1/bots/:id/llms.txt (llmstxt.org shape) */
export function llmsTxt({ bot, urls, limits, settings }) {
  const n = oneLine(bot.name, 80) || bot.id;
  return [
    `# ${n}`,
    '',
    `> ${botBlurb(bot)} It answers only from its own files and cites its sources. When the files don't cover a question it says: "${NOT_IN_DATA}"`,
    '',
    settings.public ? `AI agents may ask it without a key${settings.paid ? '' : ` (up to ${limits.freePerDay} answers a day)`}. Show the user the sources it cites.` : 'It does not answer AI agents right now.',
    '',
    '## Ask',
    '',
    `- [MCP server](${urls.mcp}): remote MCP (Streamable HTTP) with one tool, \`ask\` {question, context?}`,
    `- [Ask over HTTP](${urls.ask}): POST {"question": "…"} or GET ?q=…, returns {answered, answer, sources, products?, follow_up?}`,
    `- [Agent manifest](${urls.manifest}): name, URLs and rate limits as JSON`,
    '',
    '## Terms',
    '',
    `- [Terms of use](${urls.terms})`,
    '',
  ].join('\n');
}
