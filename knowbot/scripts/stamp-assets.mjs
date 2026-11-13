#!/usr/bin/env node
// Cache-bust the static site. GitHub Pages serves every file with max-age=600, so after a deploy a browser can pair a
// new page with an old cached module. Stamping every .js/.mjs/.css reference with ?v=<stamp> makes one deploy load one
// consistent set of files.
//
// SOURCE IS KEPT STAMP-FREE. The stamp is applied to the deployed copy only (.github/workflows/deploy-pages.yml runs
// this on the checkout, then uploads the result), so branches never conflict over "Stamp assets" commits.
//
//   node scripts/stamp-assets.mjs [stamp]            stamp in place (default stamp: current git short sha)
//   node scripts/stamp-assets.mjs --strip            remove every stamp (back to clean source)
//   node scripts/stamp-assets.mjs --check            exit 1 if the tree carries any stamp (source must not)
//   node scripts/stamp-assets.mjs --list [stamp]     print every reference it would touch, change nothing
//   ... --root <dir>                                 work on another copy of the site (default: this repo's knowbot/)
//
// Idempotent, and it works on unstamped and on already-stamped files alike (an old stamp is replaced).
//
// What counts as a reference (always a path ending in .js/.mjs/.css, with no spaces):
//   - a quoted string that starts with ./ ../ or /        import x from './a.js'   import('./a.js')   new URL('../b.css', …)
//                                                         <script src="./a.js">    <link href="./a.css">   importmap values
//   - a template literal that starts with ./ ../ / or ${  import(`${siteBase}lib/voice-mode.js`)
//   - an unquoted CSS url(...)                            @import url(./a.css)
// Module names must be whole literals for this to see them: write import(file) over a list of './name.js' strings, never
// import(`./${name}.js`). The embed snippets shown to customers ("${siteBase}lib/embed.js" inside a longer template)
// are not references and stay unversioned on purpose: customers paste them once, and embed.js stamps its own imports.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const DIRS = ['dashboard', 'demo', 'lib', 'studio', 'site'];   // walked recursively; vendor/ is versioned by its path
const SKIP_DIRS = new Set(['test', 'node_modules', 'screens', 'fixtures']);
const FILE = /\.(?:html|js|mjs|css)$/;
const EXT = '\\.(?:js|mjs|css)';
const OLD = '(?:\\?v=[\\w.-]+)?';
const QUOTED = new RegExp(`(["'\`])((?:\\.{1,2}/|/(?!/))[^"'\`?#\\s$\\\\]+${EXT})${OLD}\\1`, 'g');
const TEMPLATE = new RegExp(`(\`)((?=\\.{1,2}/|/(?!/)|\\$\\{)[^"'\`?#\\s\\\\]*\\$\\{[^"'\`?#\\s\\\\]*${EXT})${OLD}\``, 'g');
const CSS_URL = new RegExp(`(url\\(\\s*)((?:\\.{1,2}/|/(?!/))[^)"'\`?#\\s]+${EXT})${OLD}(\\s*\\))`, 'g');

/** Every site file under root: the root's own .html pages plus DIRS, recursively (tests and fixtures left out). */
export function siteFiles(root) {
  const out = [];
  for (const f of readdirSync(root)) if (/\.html$/.test(f)) out.push(join(root, f));
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); }
      else if (e.isFile() && FILE.test(e.name)) out.push(join(dir, e.name));
    }
  };
  for (const d of DIRS) if (existsSync(join(root, d))) walk(join(root, d));
  return out.sort();
}

/** Rewrite one file's text: every reference gets ?v=<stamp> (stamp '' strips it). Returns { out, refs }. */
export function stampText(src, stamp) {
  const refs = [];
  const v = stamp ? `?v=${stamp}` : '';
  let out = src.replace(QUOTED, (_, q, ref) => { refs.push(ref); return `${q}${ref}${v}${q}`; });
  out = out.replace(TEMPLATE, (_, q, ref) => { refs.push(ref); return `${q}${ref}${v}${q}`; });
  out = out.replace(CSS_URL, (_, a, ref, b) => { refs.push(ref); return `${a}${ref}${v}${b}`; });
  return { out, refs };
}

/** Every reference in the text, in order: [{ ref, v }] (v: the stamp it carries, or null). */
export function scanRefs(src) {
  const out = [];
  for (const re of [QUOTED, TEMPLATE, CSS_URL]) {
    for (const m of src.matchAll(re)) out.push({ ref: m[2], v: (/\?v=([\w.-]+)/.exec(m[0].slice(m[0].indexOf(m[2]) + m[2].length)) || [])[1] || null });
  }
  return out;
}

/** True when the text carries a stamp on something stampText would touch. */
export function hasStamp(src) { return stampText(src, '').out !== src; }

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--root'));
  const ri = argv.indexOf('--root');
  const here = join(dirname(fileURLToPath(import.meta.url)), '..');
  const root = ri >= 0 ? resolve(argv[ri + 1] || '') : here;
  const positional = argv.filter((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
  const unknown = [...flags].filter((f) => !['--strip', '--check', '--list'].includes(f));
  if (unknown.length || (ri >= 0 && !argv[ri + 1])) { console.error(`usage: stamp-assets.mjs [stamp] [--strip|--check|--list] [--root <dir>]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`); return 2; }
  if (!existsSync(root)) { console.error(`no such directory: ${root}`); return 2; }
  const files = siteFiles(root);
  const rel = (p) => relative(root, p);

  if (flags.has('--check')) {
    const bad = files.filter((p) => hasStamp(readFileSync(p, 'utf8')));
    if (bad.length) { console.error(`stamped references in ${bad.length} file(s); source must be stamp-free (node scripts/stamp-assets.mjs --strip):\n  ${bad.map(rel).join('\n  ')}`); return 1; }
    console.log(`no stamps in ${files.length} file(s)`);
    return 0;
  }
  let stamp = '';
  if (!flags.has('--strip')) {
    stamp = positional[0] || process.env.STAMP || execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    if (!/^[\w.-]+$/.test(stamp)) { console.error(`bad stamp "${stamp}" (letters, digits, . _ - only)`); return 2; }
  }
  let changed = 0, total = 0;
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const { out, refs } = stampText(src, stamp);
    total += refs.length;
    if (flags.has('--list')) { for (const r of refs) console.log(`${rel(p)}: ${r}`); continue; }
    if (out !== src) { writeFileSync(p, out); changed++; }
  }
  if (flags.has('--list')) console.log(`${total} reference(s) in ${files.length} file(s)`);
  else console.log(stamp ? `stamped ${changed} file(s) with ?v=${stamp} (${total} references)` : `stripped stamps from ${changed} file(s) (${total} references)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
