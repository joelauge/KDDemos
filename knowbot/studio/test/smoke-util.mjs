// Shared by the browser smokes (studio/test/*-smoke.mjs, smoke.mjs, tools-shots.mjs, onboarding-e2e.mjs).
//
// Where screenshots and result files go. A test run never writes into the repository: the default is a folder under
// the system temp dir. `--update-screens` writes the tracked copies in studio/test/screens/ instead (do that on purpose,
// then commit them). An explicit folder (the smoke's own env var, e.g. SHOTS=/some/dir) always wins.
//
// axe-core is vendored, so the accessibility checks never depend on a CDN: when it cannot be loaded the smoke fails,
// it does not skip. studio/test/vendor/axe-core-4.10.2/axe.min.js is the unmodified file from the npm package
// axe-core@4.10.2 (https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js, sha256
// b511cd9dec01c76f4b2ad1723b66b6db37d4c2eb4ed199076e1829d9ee7b75e3), Mozilla Public License 2.0: its licence header is
// intact and the licence text sits beside it. Do not edit it; to move to another version, replace the folder and
// AXE_VERSION below. It is test tooling only and is not part of the deployed site (build-site.mjs leaves studio/test out).
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UPDATE_SCREENS = process.argv.includes('--update-screens');
export const TRACKED_SCREENS = path.join(HERE, 'screens');

/**
 * The folder a smoke writes to. name: its subfolder ('' for the Studio smoke's own cells); explicit: a folder the
 * caller was given (env var or argument), used as is.
 */
export function outDir(name = '', explicit = '') {
  if (explicit) return path.resolve(explicit);
  return UPDATE_SCREENS ? path.join(TRACKED_SCREENS, name) : path.join(os.tmpdir(), 'knowbot-smoke', name || 'studio');
}

export const AXE_VERSION = '4.10.2';
export const AXE_PATH = process.env.AXE_PATH || path.join(HERE, 'vendor', `axe-core-${AXE_VERSION}`, 'axe.min.js');
let axeText = null;
/** axe-core's source. Throws when it cannot be read: an accessibility check that cannot run is a failure. */
export function axeSource() {
  if (axeText === null) {
    let t = '';
    try { t = readFileSync(AXE_PATH, 'utf8'); } catch (e) { throw new Error(`axe-core is missing (${AXE_PATH}): ${e.message}`); }
    if (!/axe v\d/.test(t.slice(0, 200))) throw new Error(`${AXE_PATH} is not axe-core`);
    axeText = t;
  }
  return axeText;
}
/** Put axe on the page (once). Throws when it cannot be loaded. */
export async function injectAxe(page) {
  if (await page.evaluate(() => !!window.axe)) return;
  await page.addScriptTag({ content: axeSource() });
  if (!(await page.evaluate(() => !!window.axe))) throw new Error('axe-core did not load on the page');
}

/**
 * Console errors and failed requests of a page, minus what is explicitly allowed. Returns the live list.
 * allow: regular expressions; a message matching any of them is not recorded. Keep the list short and say why.
 */
export const DEFAULT_ALLOWED_ERRORS = [
  /fonts\.(googleapis|gstatic)\.com/,          // the font CDN is unreachable in sandboxes; the page falls back to system fonts
  /ERR_TUNNEL|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_/,   // the same, as Chromium words it
];
export function watchErrors(page, { allow = [] } = {}) {
  const bucket = [];
  const allowed = (t) => [...DEFAULT_ALLOWED_ERRORS, ...allow].some((re) => re.test(t));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const line = `HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`;
    if (!allowed(r.url()) && !allowed(line)) bucket.push(line);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) return;   // reported with its URL by the response listener
    if (!allowed(t)) bucket.push(t);
  });
  page.on('pageerror', (e) => { const t = `pageerror: ${e.message}`; if (!allowed(t)) bucket.push(t); });
  return bucket;
}

/** Wait (at most `cap` ms) until no finite animation or transition is running: the page has stopped moving. */
export async function settled(page, cap = 1000) {
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)), null, { timeout: cap, polling: 50 }).catch(() => null);
}
