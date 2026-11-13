// The live voice bots' shared "brain" (web voice: webvoice.mjs, phone: voice-live.mjs). Pure helpers and small stateful
// helpers, no I/O of their own:
//
//   Settings      VOICES (the prebuilt voices), VOICE_LANGUAGES, voiceSetupOf / cleanVoiceSetup (spec.voiceSetup: voice,
//                 language, takeMessages, transfer {number, timezone, days, start, end}), withinHours, isE164.
//   Tool answer   toolAnswer(a): what search_knowledge_base returns to the model: a short spoken-style answer it may
//                 rephrase, the rest ("more", offered rather than read), the must-keep facts (prices, dates, numbers,
//                 names, quoted terms), options (several products: clarify / recommend), related items on a refusal
//                 (named only as the results name them), on-screen and send hints. Citations stay for the chips.
//   Facts guard   extractFacts, figuresIn, unsupportedFigures: a number or price the bot said that is not in the facts,
//                 the answer or the question is logged with a reference (audio can't be unsaid, but it is measured).
//   Speculation   createSpeculator: start the bot's search on the streaming transcript before the caller finishes; reuse
//                 it when the final query is the same or very close, else discard. Bounded per turn.
//   Instant       createInstantAnswers: the spoken answers for a bot's most-asked (answered) questions, precomputed and
//                 cached until the files change (filesEpoch) or a TTL passes; served when a question matches closely.
//   Read-back     readBackPhone / readBackEmail: how a number or address is read back before anything is sent.
//   Prompt        conversationRules: the natural-conversation part of both voice prompts (acknowledge, answer short then
//                 offer more, clarify, recommend, related / message-taking on a refusal, hand-off, wrap-up, language).
//   Model         asyncToolsSupported, liveSetupExtras: NON_BLOCKING search (scheduling WHEN_IDLE) where the Live model
//                 supports asynchronous function calls, and the turn-end silence (VAD) setting.
import { NOT_IN_DATA, formatSpoken, humanTitle, splitSentences } from './util.mjs';
import { normalizeQuestion, questionJaccard, compatibleQuestions } from '../questions.mjs';

// ------------------------------------------------------------------ settings
/** The prebuilt voices the Live models speak with (name and style), in the provider's order. Default Kore. */
export const VOICES = Object.freeze([
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'], ['Orus', 'Firm'],
  ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([id, style]) => Object.freeze({ id, style })));
export const DEFAULT_VOICE = 'Kore';
const VOICE_IDS = new Map(VOICES.map((v) => [v.id.toLowerCase(), v.id]));
/** The reply language: 'auto' (the visitor's own language) or a fixed one. Native-audio models take no language code, so
 * this is a prompt rule, and the voice keeps its own accent. */
export const VOICE_LANGUAGES = Object.freeze([
  ['auto', 'Match the caller'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['pl', 'Polish'], ['sv', 'Swedish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['th', 'Thai'], ['tl', 'Filipino'],
].map(([id, label]) => Object.freeze({ id, label })));
const LANG_LABEL = new Map(VOICE_LANGUAGES.map((l) => [l.id, l.label]));
export const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const isE164 = (s) => /^\+[1-9]\d{7,14}$/.test(String(s || ''));
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; } };
/** A phone number as an owner types it ("+1 (415) 555-0100") → E.164, or null. */
export function toE164Strict(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = s.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  return null;
}

/** spec.voiceSetup with its defaults: { voice, language, takeMessages, transfer|null }. */
export function voiceSetupOf(v, { defaultVoice = DEFAULT_VOICE } = {}) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const voice = VOICE_IDS.get(String(o.voice || '').toLowerCase()) || VOICE_IDS.get(String(defaultVoice || '').toLowerCase()) || DEFAULT_VOICE;
  const language = LANG_LABEL.has(o.language) ? o.language : 'auto';
  const t = o.transfer && typeof o.transfer === 'object' && isE164(o.transfer.number) ? o.transfer : null;
  const transfer = t ? {
    number: t.number,
    timezone: validZone(t.timezone) ? t.timezone : 'UTC',
    days: Array.isArray(t.days) ? DAYS.filter((d) => t.days.includes(d)) : ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: HHMM.test(t.start) ? t.start : '09:00',
    end: HHMM.test(t.end) ? t.end : '17:00',
  } : null;
  return { voice, language, takeMessages: o.takeMessages !== false, transfer };
}

/**
 * Validates an owner's patch to spec.voiceSetup (Set up → Voice). Throws Error(message) on a bad value; → the next
 * stored value. transfer: null removes it; its number must be E.164 (a typed US number is accepted and normalised).
 */
export function cleanVoiceSetup(patch, cur = null) {
  if (patch === null) return undefined;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('must be {voice?, language?, takeMessages?, transfer?}');
  const next = { ...(cur && typeof cur === 'object' ? cur : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'voice') {
      const id = VOICE_IDS.get(String(v || '').toLowerCase());
      if (!id) throw new Error(`voice must be one of ${VOICES.map((x) => x.id).join(', ')}`);
      next.voice = id;
    } else if (k === 'language') {
      if (!LANG_LABEL.has(v)) throw new Error(`language must be "auto" or one of ${VOICE_LANGUAGES.slice(1).map((x) => x.id).join(', ')}`);
      next.language = v;
    } else if (k === 'takeMessages') {
      if (typeof v !== 'boolean') throw new Error('takeMessages must be true or false');
      next.takeMessages = v;
    } else if (k === 'transfer') {
      if (v === null || (v && typeof v === 'object' && !String(v.number ?? '').trim() && Object.keys(v).length <= 1)) { next.transfer = null; continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('transfer must be {number, timezone, days, start, end} or null');
      const t = { ...(next.transfer || {}), ...v };
      const number = toE164Strict(t.number);
      if (!number) throw new Error('transfer number must be a full phone number with its country code, like +14155550100');
      const timezone = String(t.timezone || 'UTC');
      if (!validZone(timezone)) throw new Error('transfer timezone must be a time zone like America/New_York');
      const days = t.days === undefined ? ['mon', 'tue', 'wed', 'thu', 'fri'] : t.days;
      if (!Array.isArray(days) || days.some((d) => !DAYS.includes(d))) throw new Error(`transfer days must be a list of ${DAYS.join(', ')}`);
      const start = t.start === undefined ? '09:00' : t.start, end = t.end === undefined ? '17:00' : t.end;
      if (!HHMM.test(start) || !HHMM.test(end)) throw new Error('transfer hours must be 24-hour times like 09:00 and 17:30');
      if (start === end) throw new Error('transfer hours must start and end at different times');
      next.transfer = { number, timezone, days: DAYS.filter((d) => days.includes(d)), start, end };
    } else throw new Error(`unknown setting ${JSON.stringify(k).slice(0, 30)}`);
  }
  return next;
}

/** Is `now` inside the business hours (in their own time zone)? An end before the start spans midnight. */
export function withinHours(t, now = Date.now()) {
  if (!t || !isE164(t.number) || !Array.isArray(t.days) || !t.days.length) return false;
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: t.timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)); }
  catch { return false; }
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const day = get('weekday').slice(0, 3).toLowerCase();
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  const m = (s) => { const [h, mm] = String(s).split(':').map(Number); return h * 60 + mm; };
  const s = m(t.start || '09:00'), e = m(t.end || '17:00');
  if (s < e) return t.days.includes(day) && mins >= s && mins < e;
  // overnight (e.g. 22:00–06:00): the evening part belongs to `day`, the morning part to the day before
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
  return (t.days.includes(day) && mins >= s) || (t.days.includes(prev) && mins < e);
}

// ------------------------------------------------------------------ spoken style + facts
const WORD_NUM = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90 };
const SCALE = { hundred: 100, thousand: 1000, million: 1e6 };
/** Spoken number words → digits ("thirty five" → "35", "two hundred and ten" → "210"); other words unchanged. */
export function wordsToDigits(text) {
  const toks = String(text || '').split(/(\s+|-)/);
  const out = [];
  let cur = null, total = 0, pend = [];
  const flush = () => { if (cur != null || total) { out.push(String(total + (cur || 0))); pend = []; } else out.push(...pend); cur = null; total = 0; pend = []; };
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    const w = raw.toLowerCase().replace(/[^a-z]/g, '');
    const tail = raw.replace(/^[A-Za-z-]+/, '');
    if (/^(\s+|-)$/.test(raw)) { if (cur != null || total) pend.push(raw); else out.push(raw); continue; }
    if (w in WORD_NUM && !(w === 'oh' && cur == null)) {
      const v = WORD_NUM[w];
      // "twenty five" adds up; "one two" (digits read one by one) are two numbers
      const joins = cur == null || (cur % 100 === 0 && cur > 0) || (cur % 10 === 0 && cur % 100 >= 20 && v < 10 && v > 0);
      if (!joins) { const ws = pend.some((p) => /^\s+$/.test(p)) ? ' ' : ''; flush(); out.push(ws); }
      cur = (cur || 0) + v;
      if (tail) { pend = []; flush(); out.push(tail); }
      continue;
    }
    if (w in SCALE && (cur != null || total)) { const v = (cur || 1) * SCALE[w]; if (SCALE[w] >= 1000) { total += v; cur = null; } else cur = v; if (tail) { flush(); out.push(tail); } continue; }
    if (w === 'and' && (cur != null || total)) { pend.push(raw); continue; }
    if (cur != null || total) { const ws = pend.filter((p) => /^\s+$/.test(p)).length ? ' ' : ''; flush(); out.push(ws); }
    out.push(raw);
  }
  flush();
  return out.join('').replace(/\s+/g, ' ');
}
/** Every figure in a text, normalised ("$1,299.00" → "1299", "30%" → "30", "nine thirty" → "9", "30"). */
export function figuresIn(text) {
  const t = wordsToDigits(String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1'));
  return [...new Set([...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))))];
}
/** The answer said aloud: no URLs, no markdown, money without ".00", symbols as words. */
export function spokenStyle(s) {
  return String(s || '').replace(/\[([^\]\n]{1,200})\]\((?:https?:\/\/)[^\s)]+\)/g, '$1').replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, '').replace(/\bwww\.[^\s]+/g, '')
    .replace(/([$€£]\s?\d[\d,]*)\.00\b/g, '$1').replace(/\s&\s/g, ' and ').replace(/\be\.g\.,?/gi, 'for example').replace(/\bi\.e\.,?/gi, 'that is')
    .replace(/[*_#`>]+/g, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
}
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const UNITS = '(?:days?|nights?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?|seconds?|items?|pieces?|people|persons?|guests?|miles?|mi|km|kilometers?|kilograms?|kg|grams?|g|pounds?|lbs?|ounces?|oz|inches?|in|cm|mm|meters?|m|feet|foot|ft|liters?|l|ml|gallons?|watts?|w|wh|kwh|volts?|v|mph|km/h|speeds?|gears?|sizes?|colou?rs?|models?|seats?|rooms?|stores?|locations?|times?|percent)';
const FACT_RES = [
  /[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:per|a|\/)\s?\w+)?/g,                                   // prices
  /\+?\d[\d\s().-]{7,}\d/g,                                                                   // phone numbers
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b)/gi,                                                 // percentages
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'g'),          // dates
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/gi,                                          // times
  new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:-|to|–)\\s?\\d[\\d,]*(?:\\.\\d+)?\\s+(?:business |working )?${UNITS}\\b`, 'gi'), // ranges with a unit
  new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:business |working |calendar )?${UNITS}\\b`, 'gi'),        // a number with its unit
  /[“"]([^”"\n]{2,80})[”"]/g,                                                                 // quoted terms
];
const NAME_STOP = new Set('I A An The We Our You Your It Its This That These Those If When For And Or But Yes No Not Also Just Each Every Any All Some Monday Tuesday Wednesday Thursday Friday Saturday Sunday'.split(' '));
/**
 * The facts a spoken answer may not change: prices, percentages, dates, times, numbers with their unit, phone numbers,
 * quoted terms, and names (capitalised words not opening a sentence). At most `max`, longest first within each kind.
 */
export function extractFacts(text, { max = 8 } = {}) {
  const t = String(text || '');
  const out = [];
  const add = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
    if (!v || v.length > 90) return;
    if (out.some((x) => x.toLowerCase().includes(v.toLowerCase()))) return;
    for (let i = out.length - 1; i >= 0; i--) if (v.toLowerCase().includes(out[i].toLowerCase())) out.splice(i, 1);
    out.push(v);
  };
  for (const re of FACT_RES) for (const m of t.matchAll(re)) add(m[1] || m[0]);
  for (const sn of splitSentences(t)) {
    const words = sn.split(/\s+/);
    let run = [];
    const end = () => { if (run.length && !(run.length === 1 && NAME_STOP.has(run[0]))) add(run.join(' ')); run = []; };
    words.forEach((w, i) => {
      const bare = w.replace(/^[“"(]+|[”").,;:!?]+$/g, '');
      if (i > 0 && /^[A-Z][A-Za-z0-9'’-]+$/.test(bare) && !NAME_STOP.has(bare)) run.push(bare); else end();
      if (/[,.;:!?)]$/.test(w)) end();
    });
    end();
  }
  return out.slice(0, max);
}
/**
 * The facts guard: figures the bot said that appear in none of `allowed` (the facts, the answer it was given, the
 * question, a read-back). → the unsupported figures (strings); [] when every figure is backed.
 */
export function unsupportedFigures(said, allowed = []) {
  const ok = new Set(allowed.flatMap((a) => figuresIn(a)));
  // the digits of a read-back number count one by one ("four one five" → 4, 1, 5)
  for (const a of allowed) for (const d of String(a || '').replace(/\D/g, '')) ok.add(d);
  return figuresIn(said).filter((f) => !ok.has(f) && !(Number(f) <= 1 && !/\./.test(f))); // "one of", "a" never count
}

// ------------------------------------------------------------------ the search tool's answer
const sentencesOf = (s) => splitSentences(String(s || '')).map((x) => x.trim()).filter(Boolean);
/** Near-miss items on a refusal, named only as the results name them (file / page titles), when they are close enough. */
export function relatedFrom(a, { max = 2, minRatio = 0.8 } = {}) {
  if (!a?.refused || a.guard) return [];
  const floor = Number(a.proof?.floor?.min) || 0;
  const hits = (a.proof?.hits || []).filter((h) => h && h.file && typeof h.similarity === 'number' && (floor ? h.similarity >= floor * minRatio : h.similarity >= 0.5));
  const titles = [];
  for (const h of hits) {
    const t = humanTitle({ title: h.title || null, file: h.file });
    if (t && !titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    if (titles.length >= max) break;
  }
  return titles;
}
/** Distinct products an answer cites (by title, as the files name them): the options to clarify or recommend from. */
export function optionsFrom(a, { max = 4 } = {}) {
  if (!a || a.refused) return [];
  const names = [];
  for (const p of a.products || []) { const t = String(p?.title || '').trim(); if (t && !names.some((x) => x.toLowerCase() === t.toLowerCase())) names.push(t); }
  return names.slice(0, max);
}
/**
 * What search_knowledge_base returns to the model.
 *   grounded → { status:'ok', answer, more?, facts[], source_titles[], options?, on_screen?, can_send?, suggest_summary? }
 *   refused  → { status:'not_in_data', say, related?, next:'offer_related'|'offer_message'|'offer_other_help' }
 * answer: the first sentence, spoken style (may be rephrased); more: the rest, offered ("Want the details?"), never
 * read unasked; facts: the exact items that may not change. Nothing here is a URL.
 */
export function toolAnswer(a, { names = [], onScreen = false, send = null, takeMessages = false, questionsSoFar = 0, sentSomething = false } = {}) {
  if (!a || a.refused) {
    const related = relatedFrom(a);
    return { status: 'not_in_data', say: NOT_IN_DATA, ...(related.length ? { related } : {}),
      next: related.length ? 'offer_related' : takeMessages ? 'offer_message' : 'offer_other_help' };
  }
  const spoken = spokenStyle(formatSpoken(a, 450, { names, attribute: false }));
  const ss = sentencesOf(spoken);
  const answer = ss[0] || spoken;
  const more = ss.slice(1).join(' ').trim();
  const options = optionsFrom(a);
  const media = send ? (send.text && send.email ? 'text or email' : send.text ? 'text' : send.email ? 'email' : null) : null;
  const shown = onScreen && ((a.products || []).length ? 'products' : (a.citations || []).length ? 'sources' : null);
  return {
    status: 'ok', answer, ...(more ? { more } : {}), facts: extractFacts(spoken),
    source_titles: [...new Set((a.citations || []).slice(0, 4).map((c) => humanTitle(c)))],
    ...(options.length > 1 ? { options } : {}),
    ...(shown ? { on_screen: shown } : {}),
    ...(media ? { can_send: media } : {}),
    ...(questionsSoFar >= 4 && !sentSomething && media ? { suggest_summary: true } : {}),
  };
}

// ------------------------------------------------------------------ read-back (before anything is sent)
const DIGIT_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** "+14155550100" → "+1, 415, 555, 0100" read digit by digit in groups: "plus one, four one five, five five five, zero one zero zero". */
export function readBackPhone(num) {
  const d = String(num || '').replace(/[^\d+]/g, '');
  const digits = d.replace(/\D/g, '');
  if (!digits) return '';
  const say = (s) => [...s].map((c) => DIGIT_WORD[Number(c)]).join(' ');
  let groups;
  if (digits.length === 11 && digits[0] === '1') groups = ['1', digits.slice(1, 4), digits.slice(4, 7), digits.slice(7)];
  else if (digits.length === 10) groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  else { groups = []; for (let i = 0; i < digits.length; i += 3) groups.push(digits.slice(i, i + 3)); if (groups.length > 1 && groups[groups.length - 1].length === 1) { const l = groups.pop(); groups[groups.length - 1] += l; } }
  return `${d.startsWith('+') ? 'plus ' : ''}${groups.map(say).join(', ')}`;
}
const COMMON_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'me.com', 'msn.com', 'protonmail.com', 'proton.me']);
/**
 * "ann.lee42@gmail.com" → "a n n, dot, l e e, four two, at gmail dot com": the name spelled letter by letter (digits as
 * words), a well-known domain said as a word, any other domain spelled too.
 */
export function readBackEmail(addr) {
  const s = String(addr || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  const spell = (part) => part.split(/([.\-_+])/).filter(Boolean).map((seg) => ({ '.': 'dot', '-': 'dash', _: 'underscore', '+': 'plus' }[seg]
    || seg.match(/\d+|[a-z]+/g).map((r) => (/\d/.test(r) ? [...r].map((c) => DIGIT_WORD[Number(c)]).join(' ') : [...r].join(' '))).join(', '))).join(', ');
  const local = s.slice(0, at), domain = s.slice(at + 1);
  const dom = COMMON_DOMAINS.has(domain) ? domain.replace(/\./g, ' dot ') : spell(domain);
  return `${spell(local)}, at ${dom}`;
}

// ------------------------------------------------------------------ speculative search (N4)
const simQ = (a, b) => {
  const na = normalizeQuestion(a), nb = normalizeQuestion(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (!compatibleQuestions(a, b)) return 0;
  return questionJaccard(a, b);
};
export const sameEnough = (a, b, threshold) => simQ(a, b) >= threshold;
/**
 * Starts the bot's search on the streaming transcript, before the caller finishes. partial(text) on every transcript
 * delta (the turn so far); once it holds still for idleMs with at least minWords words, a search starts (at most
 * maxPerTurn per turn, one at a time; a newer one makes an older, unfinished one stale). take(query) → the result
 * promise of the closest search when it is the same or very close to `query` (≥ threshold), else null (and the
 * guesses are discarded). endTurn() resets for the next turn. run(q, {signal}) is the bot's own answer pipeline.
 */
export function createSpeculator({ run, minWords = 4, idleMs = 250, maxPerTurn = 2, threshold = 0.6, log = () => {}, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let text = '', timer = null, specs = [], turnCount = 0;
  const stats = { started: 0, reused: 0, discarded: 0, cancelled: 0, savedMs: 0 };
  function fire() {
    timer = null;
    const q = text.replace(/\s+/g, ' ').trim();
    if (q.split(' ').length < minWords || turnCount >= maxPerTurn) return;
    if (specs.some((s) => normalizeQuestion(s.q) === normalizeQuestion(q))) return;
    // one search in flight at a time: an older unfinished guess is stale now
    for (const s of specs) if (!s.done && !s.stale) { s.stale = true; s.ac.abort(); stats.cancelled++; }
    turnCount++;
    stats.started++;
    const ac = new AbortController();
    const s = { q, ac, t0: now(), t1: null, done: false, stale: false };
    s.p = Promise.resolve().then(() => run(q, { signal: ac.signal })).then((a) => { s.done = true; s.t1 = now(); return a; }, (e) => { s.done = true; s.t1 = now(); s.error = e; throw e; });
    s.p.catch(() => {});
    specs.push(s);
    log(`[voice] speculative search ${turnCount}/${maxPerTurn}: "${q.slice(0, 80)}"`);
  }
  return {
    partial(t) {
      text = String(t || '');
      if (turnCount >= maxPerTurn) return;
      if (timer) clearTimer(timer);
      timer = setTimer(fire, idleMs);
      timer?.unref?.();
    },
    take(query) {
      if (timer) { clearTimer(timer); timer = null; }
      const best = specs.filter((s) => !s.error).map((s) => ({ s, sim: simQ(s.q, query) })).sort((x, y) => y.sim - x.sim || y.s.t0 - x.s.t0)[0];
      if (!best || best.sim < threshold) { stats.discarded += specs.length; this.endTurn(); return null; }
      const s = best.s;
      stats.reused++;
      // saved: how long the search had already been running when the real query arrived
      const saved = Math.round(now() - s.t0);
      stats.savedMs += saved;
      log(`[voice] speculative search reused (sim ${best.sim.toFixed(2)}, ${s.done ? 'finished' : 'in flight'}, ${saved} ms ahead)`);
      for (const o of specs) if (o !== s) { stats.discarded++; if (!o.done) o.ac.abort(); }
      specs = []; turnCount = 0; text = '';
      return { promise: s.p, query: s.q, aheadMs: saved };
    },
    endTurn() { if (timer) { clearTimer(timer); timer = null; } for (const s of specs) if (!s.done) s.ac.abort(); specs = []; turnCount = 0; text = ''; },
    get pending() { return specs.length; },
    stats,
  };
}

// ------------------------------------------------------------------ instant answers (N5)
let FILES_EPOCH = 0;
/** Any change to any bot's files (upload, delete, move, ingest) bumps this; cached instant answers built before are stale. */
export const bumpFilesEpoch = () => ++FILES_EPOCH;
export const filesEpoch = () => FILES_EPOCH;
/**
 * The spoken answers to a bot's most-asked questions, ready before anyone asks. top(botKey) → the bot's most-asked
 * questions that were answered (question insights); answerFor(botKey, q) → the bot's own answer (no log). Only grounded
 * answers with citations are kept (never a refusal). warm() builds in the background, once at a time per bot, when the
 * cache is missing, older than ttlMs, or built before the files last changed. match() never waits for a build.
 */
export function createInstantAnswers({ top, answerFor, max = 5, ttlMs = 30 * 60e3, threshold = 0.85, epoch = filesEpoch, now = () => Date.now(), log = () => {}, minRebuildMs = 60e3 } = {}) {
  const cache = new Map(); // botKey → { at, epoch, items:[{q, norm, a}], building?: Promise, startedAt }
  const fresh = (c) => c && c.epoch === epoch() && now() - c.at < ttlMs;
  function warm(botKey) {
    const c = cache.get(botKey);
    if (fresh(c) || c?.building) return c?.building || Promise.resolve(c);
    // stale answers are never served (match() checks the epoch); a rebuild costs searches, so one per bot per minRebuildMs
    if (c?.startedAt != null && now() - c.startedAt < minRebuildMs) return Promise.resolve(null);
    const startedAt = now();
    const e0 = epoch();
    const building = (async () => {
      let qs = [];
      try { qs = (await top(botKey)) || []; } catch (e) { log(`[voice] instant answers: top questions failed for ${botKey}: ${e.message}`); }
      const items = [];
      for (const q of qs.slice(0, max)) {
        try {
          const a = await answerFor(botKey, q);
          if (a && !a.refused && (a.citations || []).length) items.push({ q, norm: normalizeQuestion(q), a });
        } catch (e) { log(`[voice] instant answer failed for "${String(q).slice(0, 60)}": ${e.message}`); }
      }
      const rec = { at: now(), epoch: e0, items, startedAt };
      // files changed while building: keep nothing (the next warm() rebuilds)
      if (epoch() === e0) cache.set(botKey, rec); else cache.set(botKey, { at: 0, epoch: -1, items: [], startedAt });
      log(`[voice] instant answers for ${botKey}: ${items.length} ready`);
      return rec;
    })().finally(() => { const cur = cache.get(botKey); if (cur && cur.building) delete cur.building; });
    cache.set(botKey, { ...(c || { at: 0, epoch: -1, items: [] }), building, startedAt });
    return building;
  }
  function match(botKey, query) {
    const c = cache.get(botKey);
    if (!fresh(c)) return null;
    const n = normalizeQuestion(query);
    let best = null, sim = 0;
    for (const it of c.items) {
      const s = it.norm === n ? 1 : compatibleQuestions(it.q, query) ? questionJaccard(it.q, query) : 0;
      if (s > sim) { sim = s; best = it; }
    }
    return best && sim >= threshold ? { q: best.q, a: best.a, sim } : null;
  }
  return { warm, match, invalidate: (botKey) => (botKey == null ? cache.clear() : cache.delete(botKey)), get size() { return cache.size; }, _cache: cache };
}

// ------------------------------------------------------------------ model support
/** Asynchronous (NON_BLOCKING) function calls: Gemini 3.8 Live (and its extended-thinking variant), 2.5 Flash Live.
 * Not 3.1 Flash Live Preview (synchronous only). KNOWBOT_VOICE_ASYNC_TOOLS=0|1 overrides. */
export function asyncToolsSupported(model, env = {}) {
  const o = String(env.KNOWBOT_VOICE_ASYNC_TOOLS ?? '').trim();
  if (/^(0|false|no|off)$/i.test(o)) return false;
  if (/^(1|true|yes|on)$/i.test(o)) return true;
  const m = String(model || '').replace(/^models\//, '').toLowerCase();
  return /^gemini-3\.8-live\b/.test(m) || /^gemini-2\.5-flash.*(?:live|native-audio)/.test(m);
}
/** Turn-end silence for the Live model's own voice activity detection (ms; server default ≈ 800). */
export function silenceMs(env = {}) {
  const n = Number(env.KNOWBOT_VOICE_SILENCE_MS);
  return Number.isFinite(n) && n >= 200 && n <= 2000 ? Math.round(n) : 600;
}

// ------------------------------------------------------------------ the conversation rules (prompt)
/**
 * The natural-conversation rules both voice prompts share.
 * o.who 'caller' | 'visitor'; o.asyncSearch (the search runs NON_BLOCKING); o.onScreen (web: cards and sources show);
 * o.send {email, text} or null; o.takeMessages (message-taking on); o.transfer 'now' (phone, in hours) | 'callback' |
 * null; o.language ('auto' | code).
 */
export function conversationRules({ who = 'caller', asyncSearch = false, onScreen = false, send = null, takeMessages = true, transfer = null, language = 'auto' } = {}) {
  const canSend = !!(send && (send.email || send.text));
  const media = send?.text && send?.email ? 'text or email' : send?.text ? 'text' : 'email';
  const L = [];
  L.push(`While you look something up:
- ${asyncSearch
    ? 'Call search_knowledge_base right away and, while it runs, say one short acknowledgement (a few words), then wait for the result. Never start answering before the result arrives.'
    : 'Say one short acknowledgement (a few words), then call search_knowledge_base.'}
- Vary it naturally, like a person would ("Sure, let me check.", "Good question, one sec.", "Let me look that up.", "Okay, checking now."). Never use the same words twice in a row; skip it for a quick yes/no follow-up.`);
  L.push(`Answering from the result:
- "answer" is the answer in spoken style. Say it in your own natural words, in one or two short sentences, with contractions, the way people talk.
- "facts" are exact: every price, date, time, number, name and quoted term in it must be said exactly as given whenever you mention it. Never change, round or add a fact, number, date, price or name that is not in "answer", "more" or "facts".
- Answer short first. If the result has "more", don't read it out: offer it in a few words ("Want the details?") and say it only if they want it.
- Numbers the natural way ("twelve ninety-nine", "the third of March"). Never read out web addresses, file names, citation numbers or links.`);
  if (onScreen) L.push(`On screen:
- When the result has "on_screen", the ${who} can see the ${'products and sources'} as you speak. Say so briefly instead of reading out details or lists ("I've put it on your screen."), once per answer, not every time.`);
  L.push(`When it isn't clear:
- If the question could mean several different things, or the result's "options" lists several different products and the ${who} didn't say which, ask ONE short question naming the real options exactly as the result names them. Never invent an option.
- For "which should I get" questions: ask at most one or two short questions (budget, what it's for, size), then recommend only from products and facts in the results, saying briefly why from the facts. Never invent a product, a spec or a comparison the results don't support.`);
  const refusal = [`- When the result says "not_in_data", say the refusal line, then:`];
  refusal.push(`  - if it lists "related", offer those by name, exactly as named ("We don't have that, but we do have the Returns Policy. Want to hear about it?"). Only those names; never guess what they contain.`);
  if (takeMessages) refusal.push(`  - otherwise offer to take a message so our team can follow up: get their name and an email address or phone number, read it back (take_message returns how) and call take_message with what they asked. Never promise when or whether the team will answer, and never say the information exists.`);
  else refusal.push(`  - otherwise offer to help with something else.`);
  L.push(`Not in our files:\n${refusal.join('\n')}`);
  if (transfer === 'now') L.push(`A person:
- If the caller asks for a person, or you can't help after a refusal, offer to put them through to our team. Only after they say yes, tell them you're connecting them and call transfer_call. Never transfer without a clear yes.`);
  else if (transfer === 'callback' && takeMessages) L.push(`A person:
- If the ${who} asks for a person, say our team isn't available to take calls right now and offer a callback: get their phone number and a good time, read the number back, and call take_message with kind "callback". Never promise a time.`);
  if (canSend) L.push(`Sending instead of reading:
- After a product or policy answer that has more detail or a link (the result has "can_send"), you may offer to send it ("Want me to ${send.text ? 'text' : 'email'} you the link?") by ${media}, at most once per topic. Don't offer after every answer.
- Before sending anything, send_info reads back the number or address: say its "read_back" exactly and get a yes. On a no, ask for it again.
- After several questions, or when the result has "suggest_summary", or when they say they're done, offer to send a summary of what you covered by ${media}, once.`);
  if (language && language !== 'auto') {
    const name = LANG_LABEL.get(language) || language;
    L.push(`Language:
- Speak ${name}. Greet in ${name} with a faithful translation of the greeting, and say the refusal line as a faithful ${name} translation. Translate facts faithfully; keep names, prices and numbers exact. If the ${who} clearly can't follow, switch to their language.
- Write search_knowledge_base queries in the language of our files (English unless the files are in another language).`);
  } else {
    L.push(`Language:
- Reply in the language the ${who} speaks; if they switch, switch with them. Greet in English. In another language, say the greeting and the refusal line as faithful translations, translate facts faithfully, and keep names, prices and numbers exact. Never add anything in translation.
- Write search_knowledge_base queries in the language of our files (English unless the files are in another language).`);
  }
  L.push(`Speak for the business: "we", "our", "us".`);
  return `\n\n${L.join('\n\n')}`;
}

/** The message / callback tool (U5/U6): a lead the team follows up on. */
export const takeMessageDeclaration = ({ phone = false } = {}) => ({ name: 'take_message',
  description: `Leave a message for our team (a question we couldn't answer, or a callback request), recorded as a lead. Call it first without confirmed to get the read-back, say it, and call again with confirmed true after they say yes.${phone ? ' On a phone call the contact may be left empty to use the number they are calling from.' : ''}`,
  parameters: { type: 'OBJECT', properties: {
    name: { type: 'STRING', description: 'Their name, as they said it.' },
    contact: { type: 'STRING', description: 'Their email address or phone number, as they said it.' },
    question: { type: 'STRING', description: 'What they wanted to know, in their words.' },
    kind: { type: 'STRING', enum: ['message', 'callback'], description: 'message (default) or callback.' },
    preferred_time: { type: 'STRING', description: 'For a callback: when suits them, as they said it.' },
    confirmed: { type: 'BOOLEAN', description: 'True only after you read back the contact and they said yes.' },
  }, required: ['question'] } });
export const transferDeclaration = () => ({ name: 'transfer_call', description: 'Put the caller through to a person on our team. Only after the caller clearly said yes to being transferred.',
  parameters: { type: 'OBJECT', properties: { caller_agreed: { type: 'BOOLEAN', description: 'True: the caller said yes to being transferred.' }, reason: { type: 'STRING', description: 'Why, in a few words.' } }, required: ['caller_agreed'] } });

/** Read-back gate shared by send_info and take_message: the first call returns the read-back, the confirmed one goes. */
export function createReadBack() {
  const issued = new Set();
  const key = (to) => String(to || '').toLowerCase().replace(/[^\da-z@.+]/g, '');
  return {
    /** → null when `to` was read back and confirmed, else the read-back text to say (and ask yes/no). */
    check(to, { confirmed = false, lastFour = '' } = {}) {
      const k = key(to);
      if (confirmed && issued.has(k)) return null;
      issued.add(k);
      if (!to && lastFour) return `the number ending in ${[...lastFour].map((c) => DIGIT_WORD[Number(c)] || c).join(' ')}`;
      return String(to).includes('@') ? readBackEmail(to) : readBackPhone(to);
    },
  };
}
