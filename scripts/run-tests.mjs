/*
 * Runs the test suites: all of them, or the ones named on the command line.
 *
 *   node scripts/run-tests.mjs              every suite, in order
 *   node scripts/run-tests.mjs prose        one suite
 *   node scripts/run-tests.mjs tables host  several
 *
 * Each suite is bundled with the esbuild in this checkout and then run, so a
 * single suite costs one bundle instead of five. Everything it needs is in this
 * repository: no `npx`, no download, and nothing written outside `test/`.
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every suite, in the order `npm test` runs them. */
const SUITES = {
  engine: { entry: 'test/engine.entry.ts', out: 'test/bundle.cjs', platform: 'browser', run: 'test/engine.test.mjs' },
  tables: { entry: 'test/tables.entry.ts', out: 'test/tables.bundle.cjs', platform: 'browser', run: 'test/tables.test.mjs' },
  sync: { entry: 'test/sync.entry.ts', out: 'test/textSync.bundle.cjs', platform: 'node', run: 'test/textSync.test.mjs' },
  host: { entry: 'test/hostEntry.ts', out: 'test/host.bundle.cjs', platform: 'node', run: 'test/host.test.mjs', external: ['vscode'] },
  prose: { entry: 'test/prose.entry.ts', out: 'test/prose.bundle.cjs', platform: 'browser', run: 'test/prose.test.mjs' },
  server: { entry: 'test/server.entry.ts', out: 'test/server.bundle.cjs', platform: 'node', run: 'test/server.test.mjs' },
};

const names = process.argv.slice(2);
const unknown = names.filter((n) => !SUITES[n]);
if (unknown.length) {
  console.error(`Unknown suite: ${unknown.join(', ')}. Choose from: ${Object.keys(SUITES).join(', ')}.`);
  process.exit(2);
}
const chosen = names.length ? names : Object.keys(SUITES);

/** Run a file and pass its output straight through; resolve with its exit code. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, file)], { cwd: REPO, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const name of chosen) {
  const suite = SUITES[name];
  await build({
    entryPoints: [join(REPO, suite.entry)],
    outfile: join(REPO, suite.out),
    bundle: true,
    format: 'cjs',
    platform: suite.platform,
    external: suite.external ?? [],
    logLevel: 'warning',
    absWorkingDir: REPO,
  });
  const code = await run(suite.run);
  if (code !== 0) failed = code;
}
process.exit(failed);
