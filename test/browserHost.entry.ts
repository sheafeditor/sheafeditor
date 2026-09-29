/*
 * Entry point for the browser-host checks.
 *
 * `src/server/host.ts` runs for its side effects: importing it defines
 * `window.acquireVsCodeApi`, reads the boot element and starts nothing else. So there is
 * nothing to export, and the import itself is what the checks drive. The globals it
 * reads have to exist before this is required, which is the test's job.
 */

import '../src/server/host';

/** So the bundle has an export and the require in the test has something to hold. */
export const loaded = true;
