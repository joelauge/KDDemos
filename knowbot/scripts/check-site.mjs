#!/usr/bin/env node
// Crawl a copy of the static site and fail on anything a page would load that is not there. Used by the Pages deploy
// (.github/workflows/deploy-pages.yml) on the stamped tree it is about to upload, and runnable on source:
//   node scripts/check-site.mjs [root]                 every reference resolves to a file under root
//   node scripts/check-site.mjs <root> --stamp <sha>   ...and every .js/.mjs/.css reference carries ?v=<sha>
// It follows what scripts/stamp-assets.mjs stamps (imports, dynamic imports, script/link tags, importmap values, CSS
// url()) plus src/href/new URL(...) references to other files (pages, images, sample documents).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteFiles, scanRefs } from './stamp-assets.mjs';

// Paths other sites and customers' pages load by name: they must exist, unversioned, in every deploy.
const MUST_EXIST = ['index.html', '404.html', 'CNAME', 'studio/index.html', 'dashboard/index.html', 'site/index.html', 'site/overlay.js', 'site/site.js',
  'lib/embed.js', 'lib/widget.js', 'lib/knowbot.js', 'lib/knowbot.css', 'lib/site-config.js', 'lib/voice-mode.js', 'lib/voice-launcher.js', 'lib/voice-widget.js', 'lib/voice-orb.js',
  'demo/chat.html', 'vendor/kd-theme/tokens.css', 'corpus/MANIFEST.json', 'studio/samples/lumen-bikes/questions.json'];
const OTHER = /(?:\b(?:src|href)=|new URL\(\s*)(["'])((?:\.{1,2}\/)[^"'`?#\s$\\<>]+\.[a-z0-9]{2,5})(?:[?#][^"']*)?\1/g;

const argv = process.argv.slice(2);
const si = argv.indexOf('--stamp');
const stamp = si >= 0 ? argv[si + 1] : null;
const root = resolve(argv.find((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1)) || join(dirname(fileURLToPath(import.meta.url)), '..'));
const problems = [];
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const inside = (p) => p === root || p.startsWith(root + sep);
/** Where a reference written in `from` points on disk (null: it leaves the site or can't be known statically). */
function target(from, ref) {
  let r = ref;
  if (r.startsWith('${')) { const end = r.indexOf('}'); if (r.includes('${', end)) return null; r = '/' + r.slice(end + 1); }   // `${siteBase}lib/x.js`: site root
  else if (r.includes('${')) return null;
  const p = r.startsWith('/') ? join(root, r) : resolve(dirname(from), r);
  return inside(p) ? p : null;
}

for (const m of MUST_EXIST) if (!isFile(join(root, m))) problems.push(`missing: ${m}`);
const files = siteFiles(root);
let refs = 0, others = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const name = relative(root, f);
  const seen = new Set();
  for (const { ref, v } of scanRefs(src)) {
    refs++; seen.add(ref);
    const t = target(f, ref);
    if (t && !isFile(t)) problems.push(`${name}: ${ref} is not in the site`);
    if (stamp && v !== stamp) problems.push(`${name}: ${ref} ${v ? `carries ?v=${v}, not ?v=${stamp}` : 'is not stamped'}`);
  }
  for (const m of src.matchAll(OTHER)) {
    if (seen.has(m[2])) continue;
    others++;
    const t = target(f, m[2]);
    if (t && !isFile(t)) problems.push(`${name}: ${m[2]} is not in the site`);
  }
}
if (problems.length) { console.error(`site check FAILED (${root}):\n  ${problems.join('\n  ')}`); process.exitCode = 1; }
else console.log(`site check ok: ${files.length} files, ${refs} script/style references${stamp ? ` all stamped ?v=${stamp}` : ''}, ${others} other references, ${MUST_EXIST.length} public paths present`);
