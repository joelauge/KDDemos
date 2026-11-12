// "Send me this": what the visitor receives (server/sendinfo-render.mjs). Pure renderers, plus one send() through fake
// transports to check that tracked links reach the message unchanged. No network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { emailMessage, textMessage, conversationEmail, conversationText, answerBlocks, answerPlain, wrap, SMS_SEGMENTS } from '../sendinfo-render.mjs';
import { createSendInfo, normalizeAnswer } from '../sendinfo.mjs';
import { smsInfo } from '../channels/util.mjs';

const PROOF = 'https://kb.example.test/p/abc123';
const POLICY = normalizeAnswer({
  question: 'How long is the warranty on the frame and the battery?',
  answer: "I found a few things that will help!\n- From [“Lumen Warranty”](https://lumen.test/warranty), page 2: “Every Lumen frame carries a lifetime warranty for the original owner” [1]\n- From [“Battery Care Guide”](https://lumen.test/docs/battery.pdf), under “Coverage”: “Batteries are covered for 2 years or 500 full charge cycles — whichever comes first” [2]\nFeel free to open the links for the full details. Did you find what you were looking for?",
  citations: [
    { n: 1, file: 'policies/lumen-warranty.md', title: 'Lumen Warranty', url: 'https://lumen.test/warranty', page: 2, excerpt: 'Every Lumen frame carries a lifetime warranty for the original owner' },
    { n: 2, file: 'docs/battery.pdf', title: 'battery.pdf', url: 'https://lumen.test/docs/battery.pdf', section: 'Coverage', excerpt: 'Batteries are covered for 2 years or 500 full charge cycles' },
  ],
  proof: { quoted: [{ n: 1, text: 'Every Lumen frame carries a lifetime warranty for the original owner' }, { n: 1, text: 'The warranty covers manufacturing defects, not wear or crashes.' }, { n: 2, text: 'Batteries are covered for 2 years or 500 full charge cycles — whichever comes first' }] },
});
const PRODUCT = normalizeAnswer({
  question: 'Which trail bike would you recommend under $1,500?',
  answer: 'Good news, I found it! In [“Ridge 27.5”](https://shop.lumen.test/products/ridge-275), it says: “Ridge 27.5 Hardtail: a light, nimble trail bike, now on sale” [1]. Was that helpful, or is there something else you\'re looking for?',
  citations: [{ n: 1, file: 'store/ridge-275.md', title: 'Ridge 27.5', url: 'https://shop.lumen.test/products/ridge-275', excerpt: 'Ridge 27.5 Hardtail: a light, nimble trail bike, now on sale' }],
  proof: { quoted: [{ n: 1, text: 'Ridge 27.5 Hardtail: a light, nimble trail bike, now on sale' }] },
  products: [
    { url: 'https://shop.lumen.test/products/ridge-275', title: 'Ridge 27.5 Hardtail', price: 949, compareAt: 1099, currency: 'USD', availability: 'https://schema.org/InStock', image: 'https://cdn.lumen.test/ridge.png' },
    { url: 'https://shop.lumen.test/products/trail-pro', title: 'Trail Pro 29', price: 1299, currency: 'USD', availability: 'Sold out', image: 'http://cdn.lumen.test/insecure.jpg' },
    { url: 'javascript:alert(1)', title: 'Bad link', price: 1 },
  ],
});
const CTX = { botName: 'Lumen Help', org: 'Lumen Bikes', to: 'sam@example.com', site: 'https://lumen.test', channel: 'web', proofUrl: PROOF };
const VENDORS = /resend|twilio|mailgun|postmark|sendgrid|anthropic|openai|gemini/i;
const oneLine = (s) => s.replace(/\s+/g, ' ');

describe('sendinfo-render: e-mail', () => {
  test('structure: email-safe HTML (tables, inline styles, 600px, preheader, light + dark), greeting, question, answer, sources, proof, footer', () => {
    const m = emailMessage(POLICY, CTX);
    assert.equal(m.subject, 'Your answer from Lumen Help: How long is the warranty on the frame and the battery?');
    const h = m.html;
    assert.match(h, /^<!DOCTYPE html>/);
    assert.match(h, /<meta name="color-scheme" content="light dark">/);
    assert.match(h, /@media \(prefers-color-scheme:dark\)/);
    assert.match(h, /role="presentation"/);
    assert.match(h, /max-width:600px/);
    assert.match(h, /font-size:16px;line-height:1\.6/);
    assert.match(h, /<div style="display:none;[^"]*">From Lumen Warranty, page 2: “Every Lumen frame carries/, 'the preheader is the answer');
    assert.doesNotMatch(h, /<script|<link |<img [^>]*src="http:/i);
    // every visible block carries its own inline style (the <style> block only adds dark-mode / narrow-screen overrides)
    for (const tag of h.match(/<(?:p|td|a|li|ul|ol|table)\b[^>]*>/g)) assert.match(tag, /style="|^<td>$|<table role="presentation" width="600"/, tag); // (the last two: Outlook's 600px wrapper)
    assert.match(h, /Hi, here&#39;s the answer you asked Lumen Help for\./);
    assert.match(h, />You asked<\/p><p[^>]*>How long is the warranty/);
    assert.match(h, />Sources<\/p>/);
    assert.match(h, /href="https:\/\/lumen\.test\/warranty"[^>]*>Lumen Warranty<\/a>/);
    assert.match(h, /page 2 · lumen\.test/);
    assert.match(h, /“Coverage” · PDF · lumen\.test/);
    assert.match(h, new RegExp(`href="${PROOF}"[^>]*>See exactly where this came from</a>`));
    assert.match(h, /You asked Lumen Help to send this to sam@example\.com on lumen\.test\./);
    assert.match(h, /Lumen Help answers only from documents Lumen Bikes provided/);
    assert.doesNotMatch(h + m.text, VENDORS);
  });
  test('the answer reads as prose: no markdown, no [n] left, superscript numbers linking to the source, no chat-only courtesy lines', () => {
    const m = emailMessage(POLICY, CTX);
    for (const body of [m.html, m.text]) {
      assert.doesNotMatch(body, /\]\(|\*\*|Feel free|Did you find|I found a few/);
    }
    assert.doesNotMatch(m.html, /\[\d+\]/);
    assert.match(m.html, /<sup[^>]*><a href="https:\/\/lumen\.test\/warranty"[^>]*>1<\/a><\/sup>/);
    assert.match(m.html, /<sup[^>]*><a href="https:\/\/lumen\.test\/docs\/battery\.pdf"[^>]*>2<\/a><\/sup>/);
    // a citation the answer does not have is dropped, never left dangling; markdown bold and bare links become real markup
    const b = answerBlocks('The **frame** is covered for life [1][9]. See https://lumen.test/faq.', [{ n: 1 }]);
    assert.deepEqual(b[0].segs.map((p) => p.t), ['text', 'b', 'text', 'cite', 'text', 'link', 'text']);
    assert.deepEqual(b[0].segs[3].ns, [1]);
    assert.equal(answerPlain(b), 'The frame is covered for life. See lumen.test/faq.');
    // a table row reads as a list of values
    assert.equal(answerPlain(answerBlocks('| Model | Price |\n|---|---|\n| Ridge | $949 |')), 'Model, Price Ridge, $949');
  });
  test('"From the documents" shows only quoted lines the answer does not already say', () => {
    const m = emailMessage(POLICY, CTX);
    assert.match(m.html, />From the documents<\/p>/);
    assert.match(m.html, /The warranty covers manufacturing defects, not wear or crashes\./);
    assert.equal((m.html.match(/Every Lumen frame carries/g) || []).length, 2, 'the preheader and the answer, not a third time as a quote');
    assert.doesNotMatch(emailMessage({ ...POLICY, proof: { quoted: [POLICY.proof.quoted[0]] } }, CTX).html, /From the documents/);
  });
  test('product cards only when the answer has products: photo (https only), name, price, compare-at, availability, "View product"', () => {
    const plain = emailMessage(POLICY, CTX);
    assert.doesNotMatch(plain.html, /View product|>Products?</);
    assert.doesNotMatch(plain.text, /View product|^Products?$/m);
    const m = emailMessage(PRODUCT, { ...CTX, storeUrl: 'https://shop.lumen.test' });
    assert.match(m.html, />Products<\/p>/);
    assert.equal((m.html.match(/>View product<\/a>/g) || []).length, 2, 'the javascript: link is never a card');
    assert.match(m.html, /<img src="https:\/\/cdn\.lumen\.test\/ridge\.png" width="92" alt="Ridge 27\.5 Hardtail"/);
    assert.doesNotMatch(m.html, /insecure\.jpg/, 'an http photo is left out');
    assert.match(m.html, /<strong>\$949<\/strong> <s[^>]*>\$1,099<\/s>/);
    assert.match(m.html, />In stock<\/p>/);
    assert.match(m.html, />Out of stock<\/p>/);
    assert.match(m.html, /href="https:\/\/shop\.lumen\.test\/"[^>]*>Shop the store<\/a>/);
    assert.match(m.text, /^Products$/m);
    assert.match(m.text, /^\$949 \(was \$1,099\) · In stock$/m);
    assert.match(m.text, /^View product:\nhttps:\/\/shop\.lumen\.test\/products\/ridge-275$/m);
    assert.doesNotMatch(m.html + m.text, /javascript:/);
  });
  test('everything from files and visitors is escaped', () => {
    const evil = normalizeAnswer({
      question: '<script>alert(1)</script> & "quotes"',
      answer: 'It is <img src=x onerror=alert(1)> covered [1]. See [click](javascript:alert(2)).',
      citations: [{ n: 1, file: 'x.md', title: '"><b>Owned</b>', url: 'https://lumen.test/a?x="><script>', excerpt: 'e' }],
      proof: { quoted: [{ n: 1, text: '</p><iframe src=//evil.test>' }] },
      products: [{ url: 'https://shop.lumen.test/p/1', title: '<b>Bike</b>"onmouseover="x', price: 1, currency: 'USD', image: 'https://cdn.lumen.test/a.png" onerror="alert(1)' }],
    });
    const m = emailMessage(evil, { ...CTX, botName: '<i>Bot</i>', org: 'A&B "Co"', to: 'x"@example.com' });
    assert.doesNotMatch(m.html, /<script|<img src=x|<iframe|<b>|<i>Bot|onerror="alert|onmouseover="/i);
    assert.match(m.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
    assert.match(m.html, /&lt;iframe src=\/\/evil\.test&gt;/);
    assert.doesNotMatch(m.html, /href="javascript:/i);
    assert.doesNotMatch(m.text, /&(?:amp|lt|gt|quot|#39);/, 'no HTML entities in the text part');
    assert.match(m.text, /You asked: “<script>alert\(1\)<\/script> & "quotes"”/);
  });
  test('the plain-text part reads well on its own: wrapped at 72, every link on its own line, no entities', () => {
    for (const m of [emailMessage(POLICY, CTX), emailMessage(PRODUCT, { ...CTX, storeUrl: 'https://shop.lumen.test' })]) {
      assert.doesNotMatch(m.text, /&(?:amp|lt|gt|quot|#39|nbsp);|<\/?[a-z][^>]*>/);
      for (const line of m.text.split('\n')) {
        if (/https?:\/\//.test(line)) assert.match(line, /^\s*https?:\/\/\S+$/, `link on its own line: ${line}`);
        else assert.ok(line.length <= 72, `${line.length}: ${line}`);
      }
      assert.match(m.text, /^Sources$/m);
      assert.match(m.text, /^See exactly where this came from:\nhttps:\/\/kb\.example\.test\/p\/abc123$/m);
      assert.match(m.text, /^--\nLumen Help · Lumen Bikes$/m);
    }
    assert.equal(wrap('aaa bbb ccc', '- ', '  ', 9), '- aaa bbb\n  ccc');
  });
  test('subjects are specific: the question, else the first source; a conversation names its first question', () => {
    assert.equal(emailMessage({ ...POLICY, question: '' }, CTX).subject, 'Your answer from Lumen Help: Lumen Warranty');
    const c = conversationEmail([{ answer: POLICY, proofUrl: PROOF }, { answer: PRODUCT, proofUrl: null }], [], { ...CTX, channel: 'phone' });
    assert.equal(c.subject, 'Your call with Lumen Help: How long is the warranty on the frame and the battery? + 1 more');
  });
  test('conversation e-mail: each answer with its own products, quotes and sources, then the transcript', () => {
    const c = conversationEmail([{ answer: POLICY, proofUrl: PROOF }, { answer: PRODUCT, proofUrl: 'https://kb.example.test/p/def456' }],
      [{ role: 'caller', text: 'Warranty?' }, { role: 'agent', text: 'Lifetime on frames <b>.' }], CTX);
    assert.equal((c.html.match(/>View product<\/a>/g) || []).length, 2);
    assert.ok(c.html.indexOf('Which trail bike') < c.html.indexOf('>Transcript<'));
    assert.match(c.html, /Lifetime on frames &lt;b&gt;\./);
    assert.match(c.text, /^1\. How long is the warranty/m);
    assert.match(c.text, /^2\. Which trail bike/m);
    assert.match(c.text, /^Lumen Help: Lifetime on frames <b>\.$/m);
    assert.match(c.text, /^https:\/\/kb\.example\.test\/p\/def456$/m);
    assert.doesNotMatch(c.html, /\[\d+\]|\]\(/);
  });
});

describe('sendinfo-render: text messages', () => {
  test('answer first, key lines, links on their own lines (products, then sources), STOP line; GSM-7 and ≤ 3 segments', () => {
    const t = textMessage(POLICY, CTX);
    const lines = t.split('\n');
    assert.equal(lines[0], 'Lumen Help:');
    assert.match(lines[1], /^Every Lumen frame carries a lifetime warranty for the original owner\./);
    assert.ok(lines.includes('See the sources:') && lines.includes(PROOF));
    assert.equal(lines[lines.length - 1], 'Sent at your request. Reply STOP to opt out.');
    assert.doesNotMatch(t, /\[\d+\]|\]\(|\*\*|[“”‘’—–…]|Feel free|I found/);
    assert.match(t, /cycles - whichever/, 'the long dash became a GSM-7 hyphen');
    assert.deepEqual([smsInfo(t).encoding, smsInfo(t).segments <= SMS_SEGMENTS], ['GSM-7', true]);
    const p = textMessage(PRODUCT, CTX);
    const pl = p.split('\n');
    assert.ok(pl.indexOf('Ridge 27.5 Hardtail, $949 (was $1,099):') > 0);
    assert.equal(pl[pl.indexOf('Ridge 27.5 Hardtail, $949 (was $1,099):') + 1], 'https://shop.lumen.test/products/ridge-275');
    assert.ok(pl.indexOf('Trail Pro 29, $1,299, out of stock:') > 0);
    assert.ok(pl.indexOf('https://shop.lumen.test/products/ridge-275') < pl.indexOf(PROOF), 'product links before the sources link');
  });
  test('a long answer still fits 3 segments; a non-GSM answer stays within 3 UCS-2 segments', () => {
    const long = normalizeAnswer({ ...POLICY, answer: Array.from({ length: 12 }, (_, i) => `- Line ${i} says something quite useful about returns, refunds and exchanges for every order we ship. [1]`).join('\n') });
    const t = textMessage(long, { ...CTX, proofUrl: `${PROOF}?utm_source=knowbot&utm_medium=sms&utm_campaign=lumen-help&utm_content=proof_sms&kb_cid=abcdef1234` });
    assert.ok(smsInfo(t).segments <= SMS_SEGMENTS, JSON.stringify(smsInfo(t)));
    assert.ok(t.split('\n').filter((l) => l.startsWith('- ')).length <= 3, 'at most 3 key lines');
    assert.match(t, /utm_content=proof_sms&kb_cid=abcdef1234\n/, 'the tracked link is sent whole');
    const zh = normalizeAnswer({ ...POLICY, answer: '所有车架均享有原车主终身保修，电池保修两年或五百次完整充电循环，以先到者为准。我们的门店每天上午九点至晚上六点营业，欢迎随时来店试骑。 [1]' });
    const z = textMessage(zh, CTX);
    assert.equal(smsInfo(z).encoding, 'UCS-2');
    assert.ok(smsInfo(z).segments <= SMS_SEGMENTS, JSON.stringify(smsInfo(z)));
    assert.match(z, /Reply STOP to opt out\.$/);
    assert.match(z, new RegExp(`\\n${PROOF.replace(/\./g, '\\.')}\\n`));
  });
  test('conversation text: each question with its link on its own line, numbered', () => {
    const t = conversationText([{ answer: POLICY, proofUrl: PROOF }, { answer: PRODUCT, proofUrl: null }, { answer: PRODUCT, proofUrl: 'https://kb.example.test/p/2' }], { ...CTX, channel: 'phone' });
    assert.equal(t, `Lumen Help: the answers from our call, with their sources.\n1) How long is the warranty on the frame and the battery?\n${PROOF}\n2) Which trail bike would you recommend under $1,500?\nhttps://kb.example.test/p/2\nSent at your request. Reply STOP to opt out.`);
    assert.equal(conversationText([{ answer: POLICY, proofUrl: null }], CTX), null);
  });
});

describe('sendinfo-render: through send() with tracked links', () => {
  test('every link (sources, products, store, proof) is the tracked one; photos are never rewritten', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); };
    const si = createSendInfo({ env: { RESEND_API_KEY: 're_test' }, fetchImpl, onSent: () => {} });
    const kinds = [];
    const trackLink = (u, { kind, via }) => { kinds.push(kind); return `https://t.test/r/${kind}${kinds.length}?via=${via}`; };
    const raw = { ...PRODUCT, proofUrl: PROOF };
    const r = await si.send({ botId: 'lumen-help', botName: 'Lumen Help', org: 'Lumen Bikes', site: 'https://lumen.test', storeUrl: 'https://shop.lumen.test', channel: 'web', via: 'email', to: 'sam@example.com', answer: raw, trackLink });
    assert.equal(r.status, 'sent');
    const { html, text, subject } = calls[0];
    assert.equal(subject, 'Your answer from Lumen Help: Which trail bike would you recommend under $1,500?');
    assert.deepEqual([...new Set(kinds)].sort(), ['product', 'proof', 'source', 'store']);
    for (const href of html.match(/href="[^"]+"/g)) assert.match(href, /^href="https:\/\/t\.test\/r\/[a-z]+\d+\?via=email"$/, href);
    assert.match(html, /src="https:\/\/cdn\.lumen\.test\/ridge\.png"/);
    assert.doesNotMatch(text, /https:\/\/(?:shop\.)?lumen\.test\//, 'no untracked link in the text part');
    assert.match(html, /shop\.lumen\.test<\/p>/, "the source's own site is shown, not the short link's");
    assert.match(html, /on lumen\.test\./);
  });
});
