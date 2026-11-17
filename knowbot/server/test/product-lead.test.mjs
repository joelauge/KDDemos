// Product asks lead with the product: "Do you have magnetic charts?" answers "Yes, we have “Blank Magnetic Charts” …
// It's $17.99 and in stock." from the product's own data, and a stock refund line the question didn't ask about is
// not the answer. Fakes only: an in-memory bot, never knowDrive or a real model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAnswer } from '../answer.mjs';
import { isProductAsk, isPolicyLine, productLead } from '../../lib/knowbot.js';

const URL = 'https://theultimategamemaster.com/products/blank-magnetic-charts';
const TITLE = 'Blank Magnetic Charts - Custom DM Reference Sheets for TTRPG Game Master Screens';
const card = { url: URL, title: TITLE, price: 17.99, compareAt: null, currency: 'USD', availability: 'in stock', image: 'https://example.test/c.jpg' };

function bot(passage, cards = [card]) {
  const adapter = {
    retrieve: async () => ({ vector: [{ fileId: 'f1', atomId: 'a1', seq: 0, text: passage, similarity: 0.9 }], hybridOnly: [], top: 0.9 }),
    sources: async (hits) => ({ sources: hits.map((h) => ({ file_id: h.fileId, filename: 'Blank Magnetic Charts.md', title: TITLE, url: URL, text: h.text, score: h.similarity })), srcHit: hits }),
    fileName: () => 'Blank Magnetic Charts.md',
    products: async () => cards,
  };
  return (question, pick = 'L1') => runAnswer({ question, persona: { name: 'Bot', org: 'UGM' }, floor: 0.5, adapter, channel: 'web',
    complete: async (m) => (/grade one answer/i.test(String(m[0]?.content || '')) ? '{"verdict":"yes"}' : pick) });
}

describe('product asks lead with the product', () => {
  test('detects product asks, not policy questions', () => {
    for (const q of ['Do you have magnetic charts?', 'do you sell dice trays', "I'm looking for a GM screen", 'Where can I buy the blank charts?', 'Are the charts in stock?'])
      assert.ok(isProductAsk(q), q);
    for (const q of ['Can I return the magnetic charts?', 'Do you ship to Canada?', 'What is the warranty on the screen?', 'How do the charts attach?'])
      assert.ok(!isProductAsk(q), q);
    assert.ok(isPolicyLine('Try it at your table for 30 nights. If it doesn\'t transform how you run your games, return it for a full refund.'));
    assert.ok(!isPolicyLine('Write your own tables and conditions on dry-erase magnetic sheets.'));
  });

  test('the lead sentence is built from the product data only', () => {
    assert.equal(productLead(card, 1), `Yes, we have [“${TITLE}”](${URL}) [1]. It's $17.99 and in stock.`);
    assert.equal(productLead({ ...card, availability: 'out of stock' }, 2), `Yes, we have [“${TITLE}”](${URL}) [2]. It's $17.99 and out of stock right now.`);
    assert.equal(productLead({ ...card, price: null, availability: '' }, 1), `Yes, we have [“${TITLE}”](${URL}) [1].`);
    assert.equal(productLead({ ...card, url: '' }, 1), null);
  });

  test('a refund line is replaced by the product lead (the magnetic charts case)', async () => {
    const ask = bot("Try the Blank Magnetic Charts at your table for 30 nights. If it doesn't transform how you run your games, return it for a full refund. No questions, no quests.");
    const a = await ask('Do you have magnetic charts?');
    assert.equal(a.refused, false);
    const lines = a.text.split('\n');
    assert.match(lines[0], /^Yes, we have \[“Blank Magnetic Charts/);
    assert.match(lines[0], /\$17\.99 and in stock/);
    assert.ok(!/refund|30 nights/i.test(a.text), a.text);
    const lead = a.proof.claims.find((c) => c.product);
    assert.ok(lead && lead.verified, 'the lead is a verified claim from the product data');
  });

  test('a describing line stays, after the product lead', async () => {
    const ask = bot('Write your own tables, conditions and initiative on dry-erase magnetic charts.');
    const a = await ask('Do you have magnetic charts?');
    const lines = a.text.split('\n');
    assert.match(lines[0], /^Yes, we have/);
    assert.ok(lines.some((l) => /dry-erase magnetic charts/.test(l)), a.text);
    assert.ok(!/Good news, I found/.test(a.text), 'no generic opener before the product');
  });

  test('a policy question keeps quoting the policy', async () => {
    const ask = bot("Try the Blank Magnetic Charts at your table for 30 nights. If it doesn't transform how you run your games, return it for a full refund.");
    const a = await ask('Can I return the magnetic charts?');
    assert.ok(/full refund/.test(a.text), a.text);
    assert.ok(!/^Yes, we have/.test(a.text));
  });

  test('no product card: the answer is unchanged', async () => {
    const ask = bot('Write your own tables on dry-erase magnetic charts.', []);
    const a = await ask('Do you have magnetic charts?');
    assert.ok(!/^Yes, we have/.test(a.text) && /dry-erase/.test(a.text), a.text);
  });
});
