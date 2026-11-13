// Shared by the browser smokes (studio/test/*-smoke.mjs, smoke.mjs, tools-shots.mjs, onboarding-e2e.mjs).
//
// Where screenshots and result files go. A test run never writes into the repository: the default is a folder under
// the system temp dir. `--update-screens` writes the tracked copies in studio/test/screens/ instead (do that on purpose,
// then commit them). An explicit folder (the smoke's own env var, e.g. SHOTS=/some/dir) always wins.
import path from 'node:path';
import os from 'node:os';
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
