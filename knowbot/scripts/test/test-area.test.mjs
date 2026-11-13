// scripts/test-area.mjs: the area map stays complete and --changed picks the right areas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, allTests, areaOf, areasForFiles } from '../test-area.mjs';

test('every test file belongs to an area, and every listed file exists', () => {
  const all = allTests();
  const listed = new Set(Object.values(AREAS).flatMap((a) => a.tests));
  assert.deepEqual(all.filter((t) => !listed.has(t)), [], 'add new test files to an area in scripts/test-area.mjs');
  assert.deepEqual([...listed].filter((t) => !all.includes(t)), [], 'listed but missing');
});
test('area names and their other names', () => {
  assert.equal(areaOf('devapi'), 'devapi');
  assert.equal(areaOf('agents'), 'devapi');
  assert.equal(areaOf('kdaccount'), 'numbers');
  assert.equal(areaOf('core'), 'studio');
  assert.equal(areaOf('nope'), null);
});
test('--changed: files pick their areas; shared plumbing and unknown code run everything; docs run nothing', () => {
  assert.deepEqual(areasForFiles(['server/sendinfo-render.mjs']), { areas: ['sendinfo'], all: false, unplaced: [] });
  assert.deepEqual(areasForFiles(['server/channels/voice-brain.mjs', 'lib/voice-orb.js']).areas, ['voice']);
  assert.deepEqual(areasForFiles(['server/test/leads.test.mjs', 'server/leads.mjs']).areas, ['leads']);
  assert.deepEqual(areasForFiles(['studio/leads.css']).areas.sort(), ['leads', 'studio'], 'a Studio file also runs the Studio core tests');
  assert.deepEqual(areasForFiles(['studio/checkout.js']).areas.sort(), ['billing', 'studio']);
  assert.deepEqual(areasForFiles(['README.md', 'studio/test/screens/site/a.png', 'SPEC.md']), { areas: [], all: false, unplaced: [] });
  assert.equal(areasForFiles(['server/test/fake-knowdrive.mjs']).all, true);
  assert.deepEqual(areasForFiles(['server/brand-new.mjs']), { areas: [], all: true, unplaced: ['server/brand-new.mjs'] });
});
