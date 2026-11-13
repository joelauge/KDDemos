// The cache stamper (scripts/stamp-assets.mjs) and the deployable site build (build-site.mjs + check-site.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampText, hasStamp, scanRefs } from '../stamp-assets.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = (s, v = 'abc1234') => stampText(s, v).out;

describe('stamp-assets: what counts as a reference', () => {
  const cases = [
    ["import { a } from './a.js';", "import { a } from './a.js?v=abc1234';"],
    ['import * as b from "../lib/b.js";', 'import * as b from "../lib/b.js?v=abc1234";'],
    ["const m = await import('./c.js');", "const m = await import('./c.js?v=abc1234');"],
    ["const list = [['ingest', './ingest.js']];", "const list = [['ingest', './ingest.js?v=abc1234']];"],
    ['import(`${siteBase}lib/voice-mode.js`)', 'import(`${siteBase}lib/voice-mode.js?v=abc1234`)'],
    ['import(`./mods/${name}.js`)', 'import(`./mods/${name}.js?v=abc1234`)'],
    ["new URL('./golive.css', import.meta.url)", "new URL('./golive.css?v=abc1234', import.meta.url)"],
    ["import { hostedApi } from '/lib/site-config.js';", "import { hostedApi } from '/lib/site-config.js?v=abc1234';"],
    ['<script type="module" async src="./app.js"></script>', '<script type="module" async src="./app.js?v=abc1234"></script>'],
    ['<link rel="stylesheet" href="../vendor/kd-theme/tokens.css">', '<link rel="stylesheet" href="../vendor/kd-theme/tokens.css?v=abc1234">'],
    ['{"imports":{"react":"../vendor/react/19.2.9/react.mjs"}}', '{"imports":{"react":"../vendor/react/19.2.9/react.mjs?v=abc1234"}}'],
    ['@import url(./base.css);', '@import url(./base.css?v=abc1234);'],
    ["@import url('./base.css');", "@import url('./base.css?v=abc1234');"],
  ];
  for (const [src, want] of cases) {
    test(src, () => {
      assert.equal(stamp(src), want);
      assert.equal(stamp(want), want, 'stamping twice changes nothing');
      assert.equal(stamp(stamp(src, 'old-1.0'), 'abc1234'), want, 'an old stamp is replaced');
      assert.equal(stampText(want, '').out, src, 'strip gives the source back');
      assert.equal(hasStamp(src), false);
      assert.equal(hasStamp(want), true);
    });
  }
  test('left alone: customer snippets, other sites, bare names, other file types, API paths', () => {
    for (const src of [
      'return `<script type="module" src="${siteBase}lib/embed.js" data-bot="${id}"></script>`;',
      '`<script src="https://knowbot.knowdrive.ai/site/overlay.js" data-bot="${id}" async></script>`',
      "import('https://cdn.example/x.js')", "import('//cdn.example/x.js')", "import('react')", "import OpenAI from 'openai';",
      "new URL('../site/', import.meta.url)", '<img src="./logo.svg">', "fetch('./questions.json')",
      'console.error(`[studio] ${name}.js failed to mount; the rest keeps working`, err)',
      '`/api/site/${id}/logo?v=${v}`',
    ]) assert.equal(stamp(src), src, src);
  });
  test('scanRefs reports each reference and the stamp it carries', () => {
    assert.deepEqual(scanRefs("import a from './a.js?v=x1'; import('./b.js');"), [{ ref: './a.js', v: 'x1' }, { ref: './b.js', v: null }]);
  });
});

describe('the site build', () => {
  test('the deployable copy is stamped throughout, complete, and leaves server and test folders out', () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'kb-site-'));
    try {
      const log = execFileSync(process.execPath, [path.join(SCRIPTS, 'build-site.mjs'), out, 't3st'], { encoding: 'utf8' });
      assert.match(log, /site check ok: .* all stamped \?v=t3st/);
      // what customers' pages load by name is there, unversioned in its address, with stamped imports inside
      const embed = readFileSync(path.join(out, 'lib/embed.js'), 'utf8');
      assert.match(embed, /from '\.\/widget\.js\?v=t3st'/);
      assert.match(embed, /new URL\('\.\.\/site\/overlay\.js\?v=t3st', me\)/);
      assert.match(readFileSync(path.join(out, 'site/overlay.js'), 'utf8'), /lib\/voice-mode\.js\?v=t3st/);
      // the lazily mounted Studio modules and the Set up previews are stamped like everything else
      const app = readFileSync(path.join(out, 'studio/app.js'), 'utf8');
      for (const m of ['ingest', 'samplebot', 'checkout']) assert.ok(app.includes(`'./${m}.js?v=t3st'`), m);
      const golive = readFileSync(path.join(out, 'studio/golive.js'), 'utf8');
      assert.match(golive, /\$\{siteBase\}lib\/voice-mode\.js\?v=t3st`/);
      assert.match(golive, /src="\$\{siteBase\}lib\/embed\.js"/, 'the embed line shown to customers stays unversioned');
      for (const gone of ['server', 'scripts', 'cloudflare', 'studio/test', 'lib/test', 'package.json', '.github', 'node_modules']) assert.equal(existsSync(path.join(out, gone)), false, gone);
      for (const kept of ['CNAME', 'index.html', '404.html', 'studio/samples/lumen-bikes/questions.json', 'corpus/MANIFEST.json']) assert.ok(existsSync(path.join(out, kept)), kept);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
