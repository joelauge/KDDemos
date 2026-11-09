// Research mode (lib/knowbot.js researchAnswer + verifySummary): a capable model reads whole passages, may search the
// files again, quotes line spans word for word and may add a summary that is kept only when every number, price, date
// and name in it is in the quoted lines. The agent here is a scripted fake (Anthropic Messages shape); no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../../lib/knowbot.js';

const BUNDLES = {
  title: 'Ultimate Bundles', filename: 'site/theultimategamemaster.com/collection/ultimate-bundles.md', file_id: 'file-bundles',
  text: '# Ultimate Bundles · https://theultimategamemaster.com/collections/game-master-screen\nComplete Game Master Screen bundles with everything you need for epic campaigns.\nUltimate Bundle (Brown) - Complete Game Master Screen Kit for D&D, Pathfinder & TTRPGs\n$319.99 $361.90\nSave $41.91\nUltimate Bundle (Black) - Complete Game Master Screen Kit for D&D, Pathfinder & TTRPGs\n$319.99 $361.90',
};
const SUBS = { title: 'Monthly Subscription', filename: 'site/theultimategamemaster.com/page/subscription.md', file_id: 'file-subs',
  text: '# Monthly Subscription\nThe monthly subscription includes exclusive access, behind-the-scenes content, and special perks for subscribers.' };
const DICE = { title: 'Dragon Dice Set', filename: 'site/theultimategamemaster.com/product/dragon-dice.md', file_id: 'file-dice',
  text: '# Dragon Dice Set · https://theultimategamemaster.com/products/dragon-dice\nDragon Dice Set price: $24.99\nA seven piece resin dice set.' };

/** A scripted agent: each call returns the next step (a function of the request, or a fixed tool call). */
function fakeAgent(steps) {
  const calls = [];
  const agent = async (params) => {
    calls.push(params);
    const step = steps[calls.length - 1];
    if (!step) throw new Error('no more steps');
    const out = typeof step === 'function' ? step(params) : step;
    return { content: [{ type: 'tool_use', id: `t${calls.length}`, name: out.name, input: out.input }], stop_reason: 'tool_use' };
  };
  agent.calls = calls;
  return agent;
}
const lineNo = (params, text) => {
  const all = JSON.stringify(params.messages);
  const m = new RegExp(`L(\\d+) ${text.replace(/[$()]/g, (c) => `\\${c}`)}`).exec(all);
  if (!m) throw new Error(`line not shown to the model: ${text}`);
  return +m[1];
};

describe('research mode', () => {
  test('quotes a name line and its price line as one span, with a verified summary', async () => {
    const agent = fakeAgent([(p) => {
      const a = lineNo(p, 'Ultimate Bundle (Brown)');
      return { name: 'answer', input: { found: true, quotes: [{ from: a, to: a + 1 }], summary: `The Ultimate Bundle (Brown) is $319.99, down from $361.90 [L${a + 1}].` } };
    }]);
    const fin = await lib.researchAnswer({ question: "What's the price of the ultimate bundle?", sources: [BUNDLES, SUBS], agent, voice: true });
    assert.equal(fin.refused, false);
    assert.equal(fin.selected.length, 2);
    assert.match(fin.text, /^The Ultimate Bundle \(Brown\) is \$319\.99, down from \$361\.90 \[1\]\./);
    assert.match(fin.text, /“\$319\.99 \$361\.90”|\$319\.99 \$361\.90/);
    assert.equal(fin.citations[0].file_id, 'file-bundles');
    // the system prompt tells the model it can combine passages and search again
    assert.match(agent.calls[0].system, /more than one passage/);
    assert.match(agent.calls[0].system, /search_files/);
    // the passages are grouped and named
    assert.match(agent.calls[0].messages[0].content, /PASSAGE P1 · Ultimate Bundles/);
    // after requireCitations every sentence still stands
    const done = lib.requireCitations(fin);
    assert.match(done.text, /\$319\.99, down from \$361\.90 \[1\]/);
  });

  test('a summary with a number that is not in the quotes is dropped; the quotes stay', async () => {
    const agent = fakeAgent([(p) => {
      const a = lineNo(p, 'Ultimate Bundle (Brown)');
      return { name: 'answer', input: { found: true, quotes: [{ from: a, to: a + 1 }], summary: `The Ultimate Bundle (Brown) is $299.99 [L${a}].` } };
    }]);
    const fin = await lib.researchAnswer({ question: 'How much is the ultimate bundle?', sources: [BUNDLES], agent });
    assert.equal(fin.refused, false);
    assert.equal(fin.summary, undefined);
    assert.match(fin.research.summaryDropped, /number \$?299\.99/);
    assert.doesNotMatch(fin.text, /299\.99/);
    assert.match(fin.text, /\$319\.99 \$361\.90/);
  });

  test('a summary naming something that is not in the quotes is dropped', async () => {
    const agent = fakeAgent([(p) => {
      const a = lineNo(p, 'Ultimate Bundle (Brown)');
      return { name: 'answer', input: { found: true, quotes: [{ from: a, to: a + 1 }], summary: `The Ultimate Bundle (Brown) ships free with Paizo [L${a}].` } };
    }]);
    const fin = await lib.researchAnswer({ question: 'How much is the ultimate bundle?', sources: [BUNDLES], agent });
    assert.equal(fin.summary, undefined);
    assert.match(fin.research.summaryDropped, /Paizo/);
  });

  test('it can search the files again and quote a passage found that way (more than one passage)', async () => {
    const searched = [];
    const search = async (q) => { searched.push(q); return { results: [DICE] }; };
    const agent = fakeAgent([
      { name: 'search_files', input: { query: 'dice set price' } },
      (p) => {
        const bundle = lineNo(p, 'Ultimate Bundle (Brown)');
        const dice = lineNo(p, 'Dragon Dice Set price: $24.99');
        return { name: 'answer', input: { found: true, quotes: [{ from: bundle, to: bundle + 1 }, { from: dice }],
          summary: `Of the products in your files, the Ultimate Bundle (Brown) at $319.99 is the most expensive [L${bundle + 1}], and the Dragon Dice Set is $24.99 [L${dice}].` } };
      },
    ]);
    const fin = await lib.researchAnswer({ question: "What's the most expensive product?", sources: [BUNDLES], search, agent, voice: true });
    assert.deepEqual(searched, ['dice set price']);
    assert.equal(fin.research.searches, 1);
    assert.equal(fin.citations.length, 2, 'two files cited');
    assert.ok(fin.summary, fin.research.summaryDropped);
    assert.match(fin.summary, /\[1\].*\[2\]/);
    // the tool result showed the new passage to the model
    const toolResult = agent.calls[1].messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.match(toolResult.content, /PASSAGE P2 · Dragon Dice Set/);
  });

  test('the last turn only offers answer; found=false is the fixed refusal', async () => {
    const search = async () => ({ results: [] });
    const agent = fakeAgent([
      { name: 'search_files', input: { query: 'a' } }, { name: 'search_files', input: { query: 'b' } }, { name: 'search_files', input: { query: 'c' } },
      (p) => { assert.deepEqual(p.tools.map((t) => t.name), ['answer']); return { name: 'answer', input: { found: false, quotes: [] } }; },
    ]);
    const fin = await lib.researchAnswer({ question: 'Do you sell boats?', sources: [SUBS], search, agent });
    assert.equal(fin.refused, true);
    assert.equal(fin.text, lib.NOT_IN_DATA);
    assert.equal(agent.calls.length, 4);
    assert.ok(agent.calls.every((c) => c.tool_choice.type === 'auto'), 'never a forced tool choice (it does not combine with thinking)');
  });

  test('an agent failure returns null so the caller keeps the select path; spans never cross passages', async () => {
    const broken = async () => { throw new Error('503'); };
    assert.equal(await lib.researchAnswer({ question: 'x?', sources: [SUBS], agent: broken }), null);
    const agent = fakeAgent([(p) => {
      const last = lineNo(p, 'The monthly subscription includes');
      return { name: 'answer', input: { found: true, quotes: [{ from: last - 1, to: last + 5 }] } };
    }]);
    const fin = await lib.researchAnswer({ question: 'What does the monthly subscription include?', sources: [BUNDLES, SUBS], agent });
    assert.equal(fin.refused, false);
    assert.ok(fin.citations.every((c) => c.file_id === fin.citations[0].file_id));
  });

  test('answerFromSources uses research when given an agent, and falls back to select when it fails', async () => {
    const agent = fakeAgent([(p) => { const a = lineNo(p, 'The monthly subscription includes'); return { name: 'answer', input: { found: true, quotes: [{ from: a }] } }; }]);
    const complete = async () => 'NONE';
    const r = await lib.answerFromSources({ question: 'What does the monthly subscription include?', results: [SUBS], complete, research: agent, voice: true });
    assert.equal(r.research, true);
    assert.match(r.fin.text, /exclusive access/);
    const r2 = await lib.answerFromSources({ question: 'What does the monthly subscription include?', results: [SUBS], complete: async () => 'L1', research: async () => { throw new Error('down'); } });
    assert.equal(r2.research, undefined);
    assert.match(r2.fin.text, /exclusive access/);
  });

  test('verifySummary: numbers exact, quoted phrases verbatim, markers only on quoted lines', () => {
    const q = ['Dragon Dice Set price: $24.99', 'Ships in 2 business days'];
    const ok = lib.verifySummary('The Dragon Dice Set is $24.99 [L4].', { quotedLines: q, picks: [4, 5], citeOf: () => 1, question: 'how much are the dice?' });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, 'The Dragon Dice Set is $24.99 [1].');
    assert.equal(lib.verifySummary('It ships in 3 business days [L5].', { quotedLines: q, picks: [4, 5] }).ok, false);
    assert.equal(lib.verifySummary('It is $24.99 [L9].', { quotedLines: q, picks: [4, 5] }).ok, false, 'marker outside the quotes');
    assert.equal(lib.verifySummary('It is $24.99.', { quotedLines: q, picks: [4, 5] }).ok, false, 'uncited');
  });
});

test('verifySummary: a sentence without its own marker borrows the previous one, and is still checked', () => {
  const q = ['Toad Vault price: 50.00 USD to 300.00 USD', 'Style (Cherry w/ Engraving, Bolivian Rosewood w/ Marquetry)'];
  const ok = lib.verifySummary('The Toad Vault costs 50.00 USD to 300.00 USD [L2]. It comes in Cherry or Bolivian Rosewood.', { quotedLines: q, picks: [2, 3], citeOf: () => 1 });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.text, 'The Toad Vault costs 50.00 USD to 300.00 USD [1]. It comes in Cherry or Bolivian Rosewood [1].');
  assert.equal(lib.verifySummary('It costs $50 [L2]. It also comes in Walnut.', { quotedLines: q, picks: [2, 3] }).ok, false, 'Walnut is not in the quotes');
});
