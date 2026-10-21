/*
 * What each gate costs, read back out of the record `scripts/gates.mjs` appends to on every run.
 *
 *   node scripts/gate-timings.mjs                  the gates by median duration, slowest first
 *   node scripts/gate-timings.mjs --all-runs        including runs that overlapped another
 *   node scripts/gate-timings.mjs --file <path>     a record from somewhere else
 *
 * It reads and prints. Nothing here runs a gate or decides anything about one.
 *
 * **Median rather than mean**, because the contamination is large and one-directional. Several
 * gates drive Chromium, and two concurrent gates runs on one machine contend over it badly enough
 * to roughly triple each other's wall clock, so a handful of overlapped runs drags a mean far
 * above anything a single run would ever take. A median survives them, and the overlapped runs are
 * left out as well by default, which is why `gates.mjs` records the flag.
 *
 * **A skip is not a cheap gate.** A browser check that cannot find Chrome prints `skipped` and
 * exits in about a second, against minutes when it runs. Taking a median across both would report
 * a gate as cheap on the strength of the runs where it measured nothing, which is the same mistake
 * in a different place as calling a skipped gate a passed one. So the median is over the runs where
 * the gate actually ran, and the skips are counted beside it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const ALL_RUNS = args.includes('--all-runs');
const fileArg = args.indexOf('--file');
const FILE = fileArg >= 0 ? args[fileArg + 1] : join(REPO, '.claude', 'scratch', 'gate-timings.jsonl');

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'node scripts/gate-timings.mjs [--all-runs] [--file <path>]\n\n' +
      "Each gate's median and worst duration across the recorded gates runs, slowest first.\n" +
      'Runs that overlapped another gates run are left out unless --all-runs is given.\n'
  );
  process.exit(0);
}

let text;
try {
  text = readFileSync(FILE, 'utf8');
} catch {
  process.stderr.write(`No record at ${FILE}. It is written by npm run gates, one line per run.\n`);
  process.exit(1);
}

/*
 * One bad line does not lose the rest. The file is appended to by a process that can be killed
 * part way through a write, so a truncated last line is an ordinary thing to find rather than a
 * reason to report nothing.
 */
const runs = [];
let unreadable = 0;
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  try {
    const run = JSON.parse(line);
    if (Array.isArray(run?.gates)) runs.push(run);
    else unreadable += 1;
  } catch {
    unreadable += 1;
  }
}

const kept = ALL_RUNS ? runs : runs.filter((r) => !r.overlapped);
const dropped = runs.length - kept.length;

if (!kept.length) {
  process.stderr.write(
    `No usable runs in ${FILE}: ${runs.length} recorded, ${dropped} of them overlapping another run.\n` +
      (dropped ? 'Pass --all-runs to read them anyway, knowing the durations are not comparable.\n' : '')
  );
  process.exit(1);
}

/** Per gate: the durations of the runs where it ran, and how many runs skipped it. */
const byGate = new Map();
for (const run of kept) {
  for (const gate of run.gates) {
    if (!gate?.name || typeof gate.ms !== 'number') continue;
    const row = byGate.get(gate.name) ?? { name: gate.name, ran: [], skips: 0, fails: 0 };
    if (gate.status === 'skip') row.skips += 1;
    else {
      row.ran.push(gate.ms);
      if (gate.status === 'fail') row.fails += 1;
    }
    byGate.set(gate.name, row);
  }
}

/** The middle value, averaging the two middle ones for an even count. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const rows = [...byGate.values()]
  .map((r) => ({
    name: r.name,
    median: r.ran.length ? median(r.ran) : null,
    worst: r.ran.length ? Math.max(...r.ran) : null,
    runs: r.ran.length,
    skips: r.skips,
    fails: r.fails,
  }))
  .sort((a, b) => (b.median ?? -1) - (a.median ?? -1));

const width = Math.max(4, ...rows.map((r) => r.name.length));
const out = [];
out.push(`${kept.length} run${kept.length === 1 ? '' : 's'} from ${FILE}`);
out.push(
  'A run that overlapped another gates run is not comparable: the two contend over Chromium and roughly triple each other.'
);
if (dropped) out.push(`${dropped} such run${dropped === 1 ? '' : 's'} left out. Pass --all-runs to include ${dropped === 1 ? 'it' : 'them'}.`);
else if (ALL_RUNS) out.push('--all-runs given, so overlapping runs are included.');
if (unreadable) out.push(`${unreadable} line${unreadable === 1 ? '' : 's'} could not be read and ${unreadable === 1 ? 'was' : 'were'} left out.`);
out.push('');
out.push(`  ${'median'.padStart(9)}  ${'worst'.padStart(9)}  ${'runs'.padStart(4)}  ${'gate'.padEnd(width)}  notes`);
for (const r of rows) {
  const notes = [];
  if (r.skips) notes.push(`skipped in ${r.skips}, not counted`);
  if (r.fails) notes.push(`failed in ${r.fails}`);
  out.push(
    `  ${(r.median === null ? '-' : secs(r.median)).padStart(9)}  ` +
      `${(r.worst === null ? '-' : secs(r.worst)).padStart(9)}  ` +
      `${String(r.runs).padStart(4)}  ${r.name.padEnd(width)}  ${notes.join('; ')}`
  );
}
out.push('');
const totals = kept.map((r) => r.totalMs).filter((n) => typeof n === 'number');
if (totals.length) out.push(`whole run: median ${secs(median(totals))}, worst ${secs(Math.max(...totals))}`);

process.stdout.write(`${out.join('\n')}\n`);
