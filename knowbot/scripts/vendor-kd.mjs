#!/usr/bin/env node
// Re-vendor KnowDrive's design system into knowbot/vendor/ (served by GitHub Pages at /vendor/). Run from anywhere:
//
//   node scripts/vendor-kd.mjs                      # all three parts, at the pinned versions below
//   node scripts/vendor-kd.mjs widgets tokens       # only some parts (widgets | tokens | react)
//   KDW_VERSION=0.4.2 REACT_VERSION=19.2.9 node scripts/vendor-kd.mjs
//
//   widgets  npm pack @recourse-software/knowdrive-widgets@<KDW_VERSION> from the public GitLab registry and copy
//            dist/, widgets.css, README.md and package.json to vendor/knowdrive-widgets/<version>/.
//   tokens   fetch https://knowdrive.ai/-/theme/main.css and keep ONLY its token blocks (rules on :root,
//            [data-kd-mode="…"] and html.dark/.dark whose declarations are all custom properties) in
//            vendor/kd-theme/tokens.css. The global element reset, page chrome and keyframes are left out.
//   react    install react + react-dom <REACT_VERSION> and esbuild in a scratch directory (never in this repo's
//            dependencies) and bundle them into one ESM file plus four thin specifier modules
//            (react, react/jsx-runtime, react-dom, react-dom/client) in vendor/react/<version>/; studio/index.html's
//            importmap points the bare specifiers at them, so the widgets' React components share one React.
//
// Writes plain files only: no symlinks, no node_modules (a symlink once broke the Pages deploy). Afterwards update
// the versions in vendor/README.md and in studio/index.html's importmap if they changed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const KDW_VERSION = process.env.KDW_VERSION || '0.4.1';
const REACT_VERSION = process.env.REACT_VERSION || '19.2.9';
const ESBUILD_VERSION = process.env.ESBUILD_VERSION || '0.25.10';
const REGISTRY = 'https://gitlab.com/api/v4/groups/recoursellm-group/-/packages/npm/';
const THEME_URL = process.env.KD_THEME_URL || 'https://knowdrive.ai/-/theme/main.css';
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['widgets', 'tokens', 'react'];
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

function assertNoLinks(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n), st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`refusing to vendor a symlink: ${p}`);
    if (st.isDirectory()) assertNoLinks(p);
  }
}

// ---------------------------------------------------------------- widgets
function widgets() {
  const tmp = mkdtempSync(join(tmpdir(), 'kdw-'));
  try {
    const tgz = sh('npm', ['pack', `@recourse-software/knowdrive-widgets@${KDW_VERSION}`, `--registry=${REGISTRY}`, '--silent'], tmp).trim().split('\n').pop();
    sh('tar', ['-xzf', tgz], tmp);
    const pkg = join(tmp, 'package');
    const out = join(VENDOR, 'knowdrive-widgets', KDW_VERSION);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const f of ['dist', 'widgets.css', 'README.md', 'package.json']) cpSync(join(pkg, f), join(out, f), { recursive: true });
    assertNoLinks(out);
    console.log(`widgets: @recourse-software/knowdrive-widgets@${KDW_VERSION} -> vendor/knowdrive-widgets/${KDW_VERSION}/`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- tokens
/** Top-level rules of a stylesheet as {prelude, body} (comments removed; at-rules kept whole with body = null). */
function topLevelRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open < 0) break;
    if (semi >= 0 && semi < open && css.slice(i, semi).trim().startsWith('@')) { out.push({ prelude: css.slice(i, semi).trim(), body: null }); i = semi + 1; continue; }
    let depth = 1, j = open + 1, q = null;
    for (; j < css.length && depth; j++) {
      const ch = css[j];
      if (q) { if (ch === q && css[j - 1] !== '\\') q = null; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
const TOKEN_SELECTOR = /^(?::root|html\.dark|\.dark|\[data-kd-mode="[a-z]+"\])$/;
function declarations(body) {
  // split on ; outside parentheses
  const out = []; let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && !depth) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
export function extractTokens(css) {
  const keep = [];
  for (const r of topLevelRules(css)) {
    if (r.body == null || r.prelude.startsWith('@')) continue;
    const sels = r.prelude.split(',').map((s) => s.trim());
    if (!sels.every((s) => TOKEN_SELECTOR.test(s))) continue;
    const all = declarations(r.body);
    // A browser drops a malformed declaration and keeps the rest of the block; do the same and say so. (main.css has
    // one: a comment closed early by "--elev-*/modes" swallows dark --elev-color-sm, so browsers never apply it.)
    const decls = all.filter((d) => /^--[\w-]+\s*:/.test(d));
    for (const d of all) if (!decls.includes(d)) console.warn(`tokens: dropped a malformed declaration in "${r.prelude}" (browsers drop it too): ${d.replace(/\s+/g, ' ').slice(0, 90)}`);
    if (decls.length < all.length / 2) continue;   // a real rule, not a token block
    keep.push(`${sels.join(', ')} {\n${decls.map((d) => `  ${d.replace(/\s+/g, ' ')};`).join('\n')}\n}`);
  }
  return keep;
}
async function tokens() {
  const res = await fetch(THEME_URL);
  if (!res.ok) throw new Error(`tokens: ${THEME_URL} -> HTTP ${res.status}`);
  const css = await res.text();
  const rules = extractTokens(css);
  const names = new Set(rules.join('\n').match(/^\s*(--[\w-]+)\s*:/gm).map((s) => s.trim().slice(0, -1)));
  if (names.size < 50) throw new Error(`tokens: only ${names.size} custom properties found; did main.css change shape?`);
  const sha = createHash('sha256').update(css).digest('hex');
  const head = `/* KnowDrive theme TOKENS ONLY, extracted by knowbot/scripts/vendor-kd.mjs from ${THEME_URL}
   (${css.length} bytes, sha256 ${sha.slice(0, 16)}, fetched ${new Date().toISOString().slice(0, 10)}).
   ${names.size} custom properties: light (:root), operating modes ([data-kd-mode]) and dark (html.dark / .dark).
   The source's global element reset, page chrome and keyframes are deliberately NOT here. Fonts: the tokens name
   Plus Jakarta Sans and JetBrains Mono (design contract 1.4); the page loads them (studio/index.html). Do not edit:
   re-run the script. */\n`;
  mkdirSync(join(VENDOR, 'kd-theme'), { recursive: true });
  writeFileSync(join(VENDOR, 'kd-theme', 'tokens.css'), head + rules.join('\n') + '\n');
  console.log(`tokens: ${names.size} custom properties in ${rules.length} rules -> vendor/kd-theme/tokens.css`);
}

// ---------------------------------------------------------------- react
function react() {
  const tmp = mkdtempSync(join(tmpdir(), 'kdreact-'));
  try {
    writeFileSync(join(tmp, 'package.json'), '{"private":true}');
    sh('npm', ['install', '--no-audit', '--no-fund', '--silent', `react@${REACT_VERSION}`, `react-dom@${REACT_VERSION}`, `esbuild@${ESBUILD_VERSION}`], tmp);
    const req = createRequire(join(tmp, 'x.js'));
    process.env.NODE_ENV = 'production';
    const names = {
      react: Object.keys(req('react')),
      'react/jsx-runtime': Object.keys(req('react/jsx-runtime')),
      'react-dom': Object.keys(req('react-dom')),
      'react-dom/client': Object.keys(req('react-dom/client')),
    };
    // one bundle holds every module (so there is exactly one React); the specifier files re-export from it
    writeFileSync(join(tmp, 'entry.mjs'), [
      "import * as React from 'react';", "import * as JSX from 'react/jsx-runtime';",
      "import * as ReactDOM from 'react-dom';", "import * as Client from 'react-dom/client';",
      'export { React, JSX, ReactDOM, Client };',
    ].join('\n'));
    const out = join(VENDOR, 'react', REACT_VERSION);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    sh(join(tmp, 'node_modules', '.bin', 'esbuild'), ['entry.mjs', '--bundle', '--format=esm', '--minify', '--define:process.env.NODE_ENV="production"',
      '--legal-comments=eof', `--outfile=${join(out, 'react-all.mjs')}`], tmp);
    const facade = (ns, keys, file) => {
      const ok = keys.filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
      writeFileSync(join(out, file), `// ${file}: re-exports from the one bundled React ${REACT_VERSION} (vendor-kd.mjs)\nimport { ${ns} as M } from './react-all.mjs';\nexport default M;\nexport const { ${ok.join(', ')} } = M;\n`);
    };
    facade('React', names.react, 'react.mjs');
    facade('JSX', names['react/jsx-runtime'], 'jsx-runtime.mjs');
    facade('ReactDOM', names['react-dom'], 'react-dom.mjs');
    facade('Client', names['react-dom/client'], 'react-dom-client.mjs');
    for (const f of ['react', 'react-dom']) cpSync(join(tmp, 'node_modules', f, 'LICENSE'), join(out, `LICENSE.${f}`));
    assertNoLinks(out);
    console.log(`react: react + react-dom ${REACT_VERSION} -> vendor/react/${REACT_VERSION}/ (esbuild ${ESBUILD_VERSION})`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const p of parts) {
    if (p === 'widgets') widgets();
    else if (p === 'tokens') await tokens();
    else if (p === 'react') react();
    else throw new Error(`unknown part ${p} (widgets | tokens | react)`);
  }
  console.log('done. Check vendor/README.md and the importmap in studio/index.html for the versions.');
}
