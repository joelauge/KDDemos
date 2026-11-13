#!/usr/bin/env node
// Build the deployable copy of the static site (what GitHub Pages serves): copy the site out of the source tree,
// stamp every script/style reference with ?v=<stamp>, then crawl the result so a deploy never ships a broken page.
//   node scripts/build-site.mjs <outDir> [stamp]      (default stamp: current git short sha)
// Source stays stamp-free; only <outDir> is stamped. Used by .github/workflows/deploy-pages.yml.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// Not part of the website: the API server and its tests, deploy and build tooling, the evidence engine, evaluation
// notes, browser-test screenshots, package metadata and dotfiles. Nothing a page loads lives in these (check-site.mjs
// proves it on every build). CNAME is copied; the custom domain itself is a repository setting.
const EXCLUDE = ['server', 'scripts', 'cloudflare', 'attendd', 'eval', 'node_modules', 'studio/test', 'lib/test', 'package.json', 'package-lock.json'];

const [outArg, stampArg] = process.argv.slice(2);
if (!outArg) { console.error('usage: build-site.mjs <outDir> [stamp]'); process.exit(2); }
const out = resolve(outArg);
if (out === root || root.startsWith(out + sep)) { console.error('outDir must not be the source tree or contain it'); process.exit(2); }
const stamp = stampArg || process.env.STAMP || execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
const skip = new Set(EXCLUDE.map((e) => join(root, e)));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(root, out, {
  recursive: true,
  filter: (src) => {
    if (src === root) return true;
    const rel = relative(root, src);
    if (skip.has(src) || src === out || src.startsWith(out + sep)) return false;
    if (rel.split(sep).includes('node_modules')) return false;
    return !rel.split(sep)[0].startsWith('.') || rel === '.nojekyll';   // no dotfiles (.github, .env*, .engine-src, …)
  },
});
if (!existsSync(join(out, 'CNAME'))) { console.error('CNAME is missing from the site'); process.exit(1); }
const run = (script, args) => execFileSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
run('stamp-assets.mjs', [stamp, '--root', out]);
run('check-site.mjs', [out, '--stamp', stamp]);
console.log(`site built in ${out}`);
