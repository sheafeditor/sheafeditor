/*
 * The gates every change has to pass, in one command: the public documentation
 * check, type check, all five test suites, then the production build.
 *
 *   npm run gates
 *
 * One command rather than several chained together, because a chain of shell
 * commands is harder for both people and tooling to approve, and because the
 * steps must not overlap: `npm test` and `npm run build` both drive esbuild over
 * this checkout, and running them at once makes the test run print no counts and
 * the build end in a stack trace with nothing actually wrong.
 *
 * Everything it runs is in this repository. Stops at the first failure and exits
 * with that step's code.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = (name) => join(REPO, 'node_modules', '.bin', name);

const STEPS = [
  // First because it is the cheapest, and because a page that should not ship
  // is worth hearing about in a second rather than after the suites.
  ['Docs', process.execPath, [join(REPO, 'scripts', 'check-docs.mjs')]],
  ['Type check', bin('tsc'), ['--noEmit']],
  ['Tests', process.execPath, [join(REPO, 'scripts', 'run-tests.mjs')]],
  // The jsdom half of the real-editor scenarios: every area, about half a minute.
  // It fails on any failing scenario, so the count it reports is the whole of it.
  ['Editor scenarios (jsdom)', process.execPath, [join(REPO, 'test', 'real-editor', 'run-unit.mjs')]],
  ['Build', process.execPath, [join(REPO, 'esbuild.mjs'), '--production']],
];

for (const [label, cmd, args] of STEPS) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`\n${label} failed\n`);
    process.exit(r.status ?? 1);
  }
}
process.stdout.write('\nAll gates passed\n');
