// Deterministic pre-parser for the tool-using Builder: runs BEFORE the model, so the common commands are exact and
// never depend on the model reading them right.
//
//   a pasted URL/domain                      -> import_website{url}
//   "call it X, friendly, for my Y shop"     -> update_bot{name, tone, purpose, org, …} (every field in one message)
//   a typed chip label ("launch with samples anyway", or any chip on screen) -> that chip (the visitor's own click)
//   "use the sample files" / "upload my files" / "run the proof run" -> the matching tool
//   a question about KnowBot itself (pricing, plans, channels…) -> kb_search{query} first, so the model cites
//
// preparse(message, state) -> { toolCalls:[{name,input}], chip|null, productQuestion, command }
// `command` is true when the message is a pure command the pre-parser fully understood.

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------------------------------------ URLs
const TLD = '(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})';
const URL_RE = new RegExp(`(?:^|[\\s(<"'“])((?:https?:\\/\\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+${TLD}(?::\\d{2,5})?(?:\\/[^\\s,;!?)"'”<>]*)?)(?=$|[\\s,;!?)"'”>]|\\.(?:\\s|$))`, 'i');
const FILE_EXT = /\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|markdown|html?|png|jpe?g|gif|webp|tiff?|bmp|heic|mp3|wav|m4a|json|zip|js|mjs|py|exe)$/i;
// words that look like domains in prose but are not ("e.g", "i.e", "node.js", "next.js")
const NOT_DOMAIN = /^(?:e\.g|i\.e|etc|node\.js|next\.js|vue\.js|react\.js|asp\.net)$/i;
/** The first web address in a message, or null. E-mail addresses and file names never count. */
export function findUrl(msg) {
  const s = String(msg || '').replace(/\S+@\S+/g, ' ');
  const m = URL_RE.exec(s);
  if (!m) return null;
  const raw = m[1].replace(/[.]+$/, '');
  if (FILE_EXT.test(raw.replace(/^https?:\/\//i, '').split(/[?#]/)[0]) || NOT_DOMAIN.test(raw)) return null;
  // a bare word.word needs a real-looking TLD (not "file.final") unless it has a scheme
  if (!/^https?:\/\//i.test(raw) && !/\.(?:com|net|org|shop|store|co|io|ai|app|biz|info|uk|us|ca|au|de|fr|nl|es|it|eu|nz|ie|in|jp|br|mx|se|no|dk|fi|ch|at|be|pl|pt|cz|xyz|online|site|dev|me|tv|fm|gg|ly|so|to|cc|website|tech|cafe|bike|bikes|travel|studio|design|agency|club|health|law|shop)(?:\.[a-z]{2})?(?:[:/]|$)/i.test(raw)) return null;
  return raw;
}

// ------------------------------------------------------------------------------------------------ spec fields
const BOT_NOUN = '(?:bot|chatbot|assistant|helper|agent|guide|help ?desk|desk|concierge|faq)';
const STOP_TAIL = /\s+(?:and|with|that|which|so|please|to|who|because|but)\b.*$/i;
const AUDIENCE_WORD = /^(?:customers?|clients?|shoppers?|employees?|staff|team|colleagues|students?|users?|visitors?|website|site|business|company|files?|docs?|self)$/i;

/** Every spec field one message sets ("call it Paddle Pal, friendly, a support bot for my kayak rental shop"). */
export function parseFields(message) {
  const msg = oneLine(message);
  const out = {};
  if (!msg) return out;
  let m;
  // name: "call it X", "name it X", "rename it to X", "the bot is called X", "name: X"
  if ((m = /\b(?:call|name)\s+(?:it|the bot|my bot|him|her)\s+["“']?([^"”',.!?;\n]{2,40})/i.exec(msg))
    || (m = /\brename\s+(?:it\s+|the bot\s+)?(?:to|as)\s+["“']?([^"”',.!?;\n]{2,40})/i.exec(msg))
    || (m = new RegExp(`\\b(?:it|${BOT_NOUN})\\s+(?:is\\s+)?(?:called|named)\\s+["“']?([^"”',.!?;\\n]{2,40})`, 'i').exec(msg))
    || (m = /\bname:\s*["“']?([^"”',;\n]{2,40})/i.exec(msg))) {
    const name = m[1].replace(STOP_TAIL, '').replace(/\s+for\s+.*$/i, '').trim();
    if (name.length >= 2 && !/^(?:something|anything|whatever|it|that|this)$/i.test(name)) out.name = name.slice(0, 40);
  }
  // the name clause is cut out before anything else is read, so a name word is never a tone, purpose or org
  // (only "call it <name>" is cut: the regex may have read on past the name, e.g. "… Help and make answers shorter")
  const rest = m && out.name ? msg.replace(`${m[0].slice(0, m[0].length - m[1].length)}${m[1].slice(0, m[1].indexOf(out.name) + out.name.length)}`, ' ') : msg;
  if (/\b(?:friendly|friendlier|casual|warm|warmer|less formal)\b/i.test(rest)) out.tone = 'friendly';
  else if (/\b(?:formal|professional)\b/i.test(rest)) out.tone = 'formal';
  else if (/\bneutral\b/i.test(rest)) out.tone = 'neutral';
  if (/\b(?:short|shorter|concise|brief|briefer)\b/i.test(rest)) out.length = 'short';
  else if (/\b(?:longer|more detail(?:ed)?|detailed)\b/i.test(rest)) out.length = 'normal';
  if (/\bfor\s+(?:my|our|the)\s+(?:employees|staff|team|colleagues)\b|\b(?:employees|staff)\s+(?:only|can ask)\b/i.test(rest)) out.audience = 'employees';
  else if (/\bfor\s+(?:my|our|the)\s+(?:customers|clients|shoppers)\b/i.test(rest)) out.audience = 'customers';
  else if (/\bfor\s+(?:my|our|the)\s+students\b/i.test(rest)) out.audience = 'students';
  // purpose: the clause that says what kind of bot it is ("a support bot for my kayak rental shop")
  const clauses = rest.split(/\s*[,;]\s*|\s+-\s+|\.\s+/).map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    const pm = new RegExp(`^(?:and\\s+)?(?:it'?s\\s+|it\\s+is\\s+|make\\s+it\\s+|as\\s+|i\\s+(?:want|need)\\s+|this\\s+is\\s+|should\\s+be\\s+)?(?:a|an)\\s+(.*\\b${BOT_NOUN}\\b.*)$`, 'i').exec(c)
      || new RegExp(`^((?:support|sales|booking|bookings|returns?|hr|onboarding|policy|policies|product|docs|documentation|customer service|help|faq|it|internal|training|order|orders)\\s+${BOT_NOUN}\\b.*)$`, 'i').exec(c);
    if (pm) {
      const p = pm[1].replace(/[.!]+$/, '').replace(/\b(?:friendly|formal|neutral|casual|professional)\b\s*/gi, '').replace(/\s{2,}/g, ' ').trim();
      if (p.length >= 4) { out.purpose = cap(p).slice(0, 200); break; }
    }
  }
  // org: "for my kayak rental shop" (what it is for), "for Acme Bikes", "my bike shop called Spokes" (the business)
  if ((m = /\b(?:my|our)\s+(?:own\s+)?[a-z][\w'’ -]{1,40}?\s+(?:called|named)\s+["“']?([A-Z][^"”',.!?;\n]{1,40})/.exec(rest))) out.org = m[1].replace(STOP_TAIL, '').trim().slice(0, 60);
  else if ((m = /\bfor\s+(?:my|our)\s+(?:own\s+)?([a-z0-9][\w&'’-]*(?:\s+[a-z0-9][\w&'’-]*){0,4})/i.exec(rest))) {
    const org = m[1].replace(STOP_TAIL, '').replace(/[.,;:!?]+$/, '').trim();
    if (org.length >= 2 && !AUDIENCE_WORD.test(org)) out.org = cap(org).slice(0, 60);
  } else if ((m = /\bfor\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/.exec(rest)) && !/^(?:I|My|Our|The|A|An|It|This|Example)$/.test(m[1])) out.org = m[1].slice(0, 60);
  // greeting: "set the greeting to 'Welcome!'"
  if ((m = /\b(?:greeting|welcome message|first message|opening line)\s*(?:to|:|=|as|should (?:say|be)|says?)\s*["“']?([^"”'\n]{3,160}?)["”']?\s*[.!]?\s*$/i.exec(msg))) out.greeting = m[1].trim();
  return out;
}

// ------------------------------------------------------------------------------------------------ chips and commands
const norm = (t) => String(t || '').toLowerCase().replace(/[·$\d/]+mo\b/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** A typed message that is a chip on screen (label or send text), or a known launch-chip phrasing. */
export function chipFor(message, lastChips = []) {
  const t = norm(message);
  if (!t || t.length > 80) return null;
  const offered = Array.isArray(lastChips) ? lastChips.filter((c) => c && c.label) : [];
  for (const c of offered) if (t === norm(c.label) || (c.send && t === norm(c.send))) return c;
  if (/\blaunch\b.*\b(?:samples?|anyway)\b|\banyway\b.*\blaunch\b|\b(?:go live|launch)\s+(?:as is|now anyway)\b/.test(t)) {
    return offered.find((c) => c.id === 'launch-anyway') || { id: 'launch-anyway', label: 'Launch with samples anyway', action: { type: 'show_launch', force: true } };
  }
  return null;
}
const COMMANDS = [
  [/^(?:please\s+)?(?:use|load|try|show me)\s+(?:the\s+)?(?:sample|demo|example)(?:\s+files?|\s+docs?)?(?:\s+please)?$/, 'attach_samples'],
  [/^(?:please\s+)?(?:let me\s+)?(?:upload|add)\s+(?:my\s+|some\s+|more\s+)?(?:own\s+)?(?:files?|docs?|documents?)(?:\s+please)?$/, 'request_upload'],
  [/^(?:please\s+)?(?:run|start|do)\s+(?:the\s+|a\s+)?proof(?:\s+run)?(?:\s+please)?$|^test (?:it|my bot)$/, 'run_proof'],
];

// ------------------------------------------------------------------------------------------------ product questions
const PRODUCT_TOPIC = /\b(?:price|prices|pricing|cost|costs|how much|pay|paying|paid|free|trial|cancel|cancell?ation|credit card|card|subscription|billing|bill|plan|plans|account|sign ?up|signup|refund|discount|coupon|knowbot|knowdrive|languages?|channels?|whatsapp|sms|telephone|phone calls?|voice|email|api|integrat\w*|embed|widget|privacy|private|my data|data (?:safe|stored|kept)|secure|security|gdpr|hipaa|soc ?2|limits?|how many files|file size|100 ?mb|what do i get|what'?s included|included|support team|contact|human|person)\b/i;
const QUESTION_SHAPE = /\?\s*$|^(?:how|what|whats|what's|when|where|which|who|why|is|are|do|does|can|could|will|would|should|tell me|explain)\b/i;
export function isProductQuestion(message) {
  const m = oneLine(message);
  return m.length >= 4 && m.length <= 300 && QUESTION_SHAPE.test(m) && PRODUCT_TOPIC.test(m);
}

/** The full pre-pass. */
export function preparse(message, state = {}) {
  const msg = oneLine(message);
  const res = { toolCalls: [], chip: null, productQuestion: false, command: false };
  if (!msg) return res;
  const chipHit = chipFor(msg, state.lastChips);
  if (chipHit) { res.chip = chipHit; res.command = true; return res; }
  const low = norm(msg);
  for (const [re, name] of COMMANDS) if (re.test(low)) { res.toolCalls.push({ name, input: {} }); res.command = true; return res; }
  const url = findUrl(msg);
  if (url) res.toolCalls.push({ name: 'import_website', input: { url } });
  const isQ = /\?\s*$/.test(msg);
  const fields = parseFields(msg);
  // a question ("is it friendly?") only sets fields when it names the bot ("can you call it X?")
  if (Object.keys(fields).length && (!isQ || fields.name)) res.toolCalls.push({ name: 'update_bot', input: fields });
  if (isProductQuestion(msg)) { res.productQuestion = true; res.toolCalls.push({ name: 'kb_search', input: { query: msg.slice(0, 300) } }); }
  res.command = res.toolCalls.length > 0 && !res.productQuestion && !isQ;
  return res;
}
