#!/usr/bin/env node
// Cache-bust the static site: GitHub Pages serves every file with max-age=600, so after a deploy a browser can pair a
// new page with an old cached module. Stamp every relative .js/.css/.mjs reference in the dashboard, demos and lib
// with ?v=<stamp> so one deploy always loads one consistent set of files.
//   node scripts/stamp-assets.mjs [stamp]     (default: current git short sha)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = process.argv[2] || execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
const REF = /(["'])(\.{1,2}\/[^"'?#\s]+\.(?:js|mjs|css))(?:\?v=[\w.-]+)?\1/g;
let changed = 0;
for (const dir of ['dashboard', 'demo', 'lib']) {
  for (const f of readdirSync(join(root, dir))) {
    if (!/\.(?:html|js|mjs)$/.test(f)) continue;
    const p = join(root, dir, f);
    const src = readFileSync(p, 'utf8');
    const out = src.replace(REF, (_, q, ref) => `${q}${ref}?v=${stamp}${q}`);
    if (out !== src) { writeFileSync(p, out); changed++; }
  }
}
console.log(`stamped ${changed} file(s) with ?v=${stamp}`);
