#!/usr/bin/env node
/**
 * Tidy the disposable parts of finished scenario-run folders, by hand.
 *
 * Every real-editor run does this for itself on the way in, so this is for the pile that
 * built up before anything did, and for looking at what would go without doing it.
 *
 *   npm run reap:runs            # tidy, and say what went
 *   npm run reap:runs -- --dry   # say what would go, and touch nothing
 *   npm run reap:runs -- --keep-days 7
 *
 * It reads `SHEAF_EDITOR_RUNS`, so it tidies whichever directory this session's runs go to.
 * What it will and will not touch is in `test/real-editor/reapRuns.mjs`; the short of it is
 * that `results.json`, `run.json` and the screenshots are never removed, a live run is left
 * alone, and a run that never finished is kept until it is older than the retention.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bytes, reapRuns } from '../test/real-editor/reapRuns.mjs';

const RUNS = process.env.SHEAF_EDITOR_RUNS || join(tmpdir(), 'sheaf-real-editor');
const dry = process.argv.includes('--dry');
const keepAt = process.argv.indexOf('--keep-days');
const keepDays = keepAt === -1 ? 3 : Number(process.argv[keepAt + 1]);
if (!Number.isFinite(keepDays) || keepDays < 0) {
  console.error('--keep-days takes a number of days');
  process.exit(2);
}

const before = (() => {
  try {
    return readdirSync(RUNS, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
})();

const r = reapRuns(RUNS, { keepDays, dryRun: dry });

console.log(`${RUNS}\n${before} run folder${before === 1 ? '' : 's'}, keeping anything unfinished for ${keepDays} day${keepDays === 1 ? '' : 's'}.\n`);
// The reasons, because the interesting outcome is the folder that was left and why.
const why = new Map();
for (const k of r.kept) why.set(k.why, (why.get(k.why) ?? 0) + 1);
for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  left alone: ${n} ${reason}`);
console.log(`\n${dry ? 'Would free' : 'Freed'} ${bytes(r.bytes)} from ${r.folders} folder${r.folders === 1 ? '' : 's'}. Results and screenshots kept.`);
