#!/usr/bin/env node
// Run only the tests for the part of KnowBot you are working on.
//
//   npm run test:area -- sendinfo              unit tests for one area
//   npm run test:area -- leads voice           several areas
//   npm run test:area -- site --smoke          ...and the area's browser smokes afterwards (one at a time)
//   npm run test:area -- --changed             areas picked from the files that differ from the base branch
//   npm run test:area -- --changed=origin/main ...from another base (default: $TEST_AREA_BASE, else `knowbot`, else HEAD)
//   npm run test:area -- --list                the map
//   npm run test:area -- all                   every unit test (same as npm test)
//
// A changed file that belongs to no area (or to shared plumbing) runs everything, so --changed is never weaker than
// npm test for code it can't place. Docs, screenshots and workflow files pick no tests.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = (...names) => names.map((n) => (n.includes('/') ? n : `server/test/${n}.test.mjs`));

/** area -> { about, tests, smokes (npm scripts), src (path patterns that mean "this area changed"), aka } */
export const AREAS = {
  sendinfo: { about: '"Send me this": answers by e-mail or text', tests: T('sendinfo', 'sendinfo-render', 'sendinfo-switch'),
    src: [/^server\/sendinfo/, /^server\/test\/sendinfo/] },
  leads: { about: 'the Leads report', tests: T('leads'), smokes: ['leads:smoke'],
    src: [/^server\/leads\.mjs$/, /^studio\/leads\./, /^studio\/test\/leads-smoke/] },
  channels: { about: 'SMS, WhatsApp, e-mail, shop channels and the tool switches', tests: T('channels', 'surfaces'),
    src: [/^server\/channels\/(?:email|google|shop|sms|util|whatsapp|ws)\.mjs$/, /^studio\/surfaces\.js$/, /^server\/test\/fake-twilio/] },
  voice: { about: 'phone and web voice', tests: T('voice-live', 'webvoice', 'voice-brain'), smokes: ['voice:smoke'],
    src: [/^server\/channels\/(?:voice|webvoice)/, /^lib\/voice-/, /^studio\/phonesim\.js$/, /^scripts\/voice-live-test/, /^studio\/test\/voice-smoke/] },
  builder: { about: 'the Studio Builder (scripted and LLM engines, its knowledge base)', tests: T('builder-kb', 'builder-engine', 'builder-eval', 'trials', 'trials-builder', 'trials-modes'),
    src: [/^server\/builder\//, /^server\/test\/builder-/, /^studio\/builderpane\.js$/, /^studio\/kb\//, /^scripts\/builder-eval/] },
  import: { about: 'Enter a Store URL: store import, products, site finder', tests: T('storeimport', 'products', 'sitefinder', 'trials-store'),
    src: [/^server\/(?:storeimport|products|sitefinder)\.mjs$/] },
  site: { about: 'Homepage search (site/, overlay) and the deployable site build', tests: T('site', 'scripts/test/stamp-assets.test.mjs', 'scripts/test/test-area.test.mjs'), smokes: ['site:smoke'],
    src: [/^server\/site\.mjs$/, /^site\//, /^studio\/sitebrand\.js$/, /^scripts\/(?:stamp-assets|build-site|check-site)/, /^scripts\/test\//, /^studio\/test\/site-smoke/] },
  answers: { about: 'the answer pipeline: retrieval, evidence, citations, recall, questions, notes', aka: ['answer'],
    tests: T('lib/test/core.test.mjs', 'lib/test/recall.test.mjs', 'evidence', 'recall', 'parity', 'questions', 'research', 'trials-answers', 'trials-notes'),
    src: [/^server\/(?:answer|evidence|retrievers|research|questions)\.mjs$/, /^lib\/knowbot\.(?:js|css)$/, /^lib\/test\//, /^attendd\//, /^corpus\//, /^scripts\/evidence-/] },
  devapi: { about: 'the developer API and AI agents (MCP)', aka: ['agents'], tests: T('devapi', 'agents'), smokes: ['tools:smoke'],
    src: [/^server\/(?:devapi|agents)\.mjs$/, /^studio\/test\/tools-shots/] },
  numbers: { about: 'KnowBot numbers and the KnowDrive account step', aka: ['kdaccount'], tests: T('numbers', 'kdaccount'), smokes: ['kd:smoke'],
    src: [/^server\/(?:numbers|kdaccount)\.mjs$/, /^studio\/(?:numbers|kdaccount)\.js$/, /^studio\/test\/kd-smoke/, /^server\/test\/fake-stripe/] },
  studio: { about: 'Studio core: trials, uploads, events, launch, the server itself', aka: ['core'],
    tests: T('server', 'instances', 'providers', 'trials', 'trials-launch', 'trials-modes'), smokes: ['studio:smoke', 'ftue:smoke', 'onboarding:e2e'],
    src: [/^server\/(?:trials|server|instances|providers)\.mjs$/, /^studio\/[^/]+\.(?:js|css|html)$/, /^studio\/samples\//, /^studio\/test\/[^/]+\.mjs$/, /^dashboard\//] },
  // Placeholder until the Stripe checkout lands: the cases that touch paying today (checkout, convert, numbers, the account step).
  billing: { about: 'checkout and payments (placeholder: add the Stripe checkout tests here)', aka: ['checkout', 'stripe'], tests: T('trials-launch', 'numbers', 'kdaccount'),
    src: [/^studio\/checkout\./, /^server\/(?:billing|checkout|stripe)/, /^server\/test\/(?:billing|checkout|stripe)/] },
};
// Shared plumbing: a change here can break any area, so --changed runs everything.
const EVERYTHING = [/^package(?:-lock)?\.json$/, /^server\/test\/(?:fake-knowdrive|fake-llm|fake-anthropic|trials-helpers)\.mjs$/, /^lib\/(?:embed|widget|site-config)\.js$/, /^scripts\/test-area\.mjs$/, /^cloudflare\//, /^vendor\//];
// Never needs a test run.
const NOTHING = [/\.md$/, /^\.github\//, /^studio\/test\/screens\//, /^studio\/test\/fixtures\//, /^eval\//, /^demo\//, /^\.[^/]+$/, /^CNAME$/, /\.(?:png|svg|jpg)$/, /^scripts\/(?!stamp-assets|build-site|check-site|test-area|test\/|builder-eval|evidence-|voice-live-test)/];

export function allTests() {
  const out = [];
  for (const d of ['scripts/test', 'lib/test', 'server/test']) for (const f of readdirSync(join(root, d)).sort()) if (f.endsWith('.test.mjs')) out.push(`${d}/${f}`);
  return out;
}
export function areaOf(name) {
  if (AREAS[name]) return name;
  return Object.keys(AREAS).find((k) => (AREAS[k].aka || []).includes(name)) || null;
}
/** Areas for a list of changed paths (relative to knowbot/): { areas, all, unplaced }. */
export function areasForFiles(files) {
  const areas = new Set(); const unplaced = []; let all = false;
  for (const f of files) {
    if (EVERYTHING.some((re) => re.test(f))) { all = true; continue; }
    const hits = Object.keys(AREAS).filter((k) => AREAS[k].src.some((re) => re.test(f)) || AREAS[k].tests.includes(f));
    if (hits.length) { for (const k of hits) areas.add(k); continue; }
    if (NOTHING.some((re) => re.test(f))) continue;
    unplaced.push(f); all = true;
  }
  return { areas: [...areas], all, unplaced };
}

function changedFiles(base) {
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  const ok = (ref) => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status === 0;
  const ref = [base, process.env.TEST_AREA_BASE, 'knowbot', 'origin/knowbot', 'main', 'origin/main'].filter(Boolean).find(ok) || 'HEAD';
  const mb = git('merge-base', ref, 'HEAD').stdout.trim() || ref;
  const names = new Set();
  // committed since the base, plus staged, unstaged and untracked work; --relative keeps paths inside knowbot/
  for (const args of [['diff', '--name-only', '--relative', mb, 'HEAD'], ['diff', '--name-only', '--relative', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    for (const l of git(...args).stdout.split('\n')) if (l.trim()) names.add(l.trim());
  }
  return { ref, files: [...names].sort() };
}

function main(argv) {
  const smoke = argv.includes('--smoke');
  const changedArg = argv.find((a) => a === '--changed' || a.startsWith('--changed='));
  const names = argv.filter((a) => !a.startsWith('--'));
  const everything = allTests();
  if (argv.includes('--list') || (!names.length && !changedArg)) {
    for (const [k, a] of Object.entries(AREAS)) {
      console.log(`${k}${a.aka ? ` (${a.aka.join(', ')})` : ''}: ${a.about}`);
      for (const t of a.tests) console.log(`    ${t}`);
      if (a.smokes) console.log(`    smokes: ${a.smokes.join(', ')}`);
    }
    const covered = new Set(Object.values(AREAS).flatMap((a) => a.tests));
    const loose = everything.filter((t) => !covered.has(t));
    const gone = [...covered].filter((t) => !everything.includes(t));
    if (loose.length) console.log(`\nin no area (add them to scripts/test-area.mjs):\n    ${loose.join('\n    ')}`);
    if (gone.length) console.log(`\nlisted but missing:\n    ${gone.join('\n    ')}`);
    if (!argv.includes('--list')) console.log('\nusage: npm run test:area -- <area…> [--smoke] | --changed[=base] | --list | all');
    return loose.length || gone.length ? 1 : 0;
  }
  let picked = new Set(); let all = names.includes('all');
  for (const n of names.filter((x) => x !== 'all')) {
    const k = areaOf(n);
    if (!k) { console.error(`unknown area "${n}". Areas: ${Object.keys(AREAS).join(', ')}, all`); return 2; }
    picked.add(k);
  }
  if (changedArg) {
    const { ref, files } = changedFiles(changedArg.includes('=') ? changedArg.split('=')[1] : null);
    const r = areasForFiles(files);
    console.log(`changed against ${ref}: ${files.length} file(s)`);
    if (r.unplaced.length) console.log(`  in no area, so everything runs: ${r.unplaced.slice(0, 8).join(', ')}${r.unplaced.length > 8 ? ', …' : ''}`);
    for (const k of r.areas) picked.add(k);
    all ||= r.all;
    if (!all && !picked.size) { console.log('nothing to test for these changes'); return 0; }
  }
  const tests = all ? everything : everything.filter((t) => [...picked].some((k) => AREAS[k].tests.includes(t)));
  console.log(`${all ? 'all areas' : [...picked].join(', ')}: ${tests.length} test file(s)`);
  let rc = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' }).status ?? 1;
  if (smoke && rc === 0) {
    const smokes = [...new Set((all ? Object.keys(AREAS) : [...picked]).flatMap((k) => AREAS[k].smokes || []))];
    for (const s of smokes) {
      console.log(`\n> npm run ${s}`);
      const r = spawnSync('npm', ['run', '--silent', s], { cwd: root, stdio: 'inherit' }).status ?? 1;
      if (r !== 0) rc = r;
    }
  }
  return rc;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
