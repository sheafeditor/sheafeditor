/*
 * What the gate tiering would have selected for each of the last landings, and what that would
 * have cost.
 *
 *   node scripts/gate-tier-history.mjs                  the last 60 landings on this branch
 *   node scripts/gate-tier-history.mjs --count 120      more of them
 *   node scripts/gate-tier-history.mjs --from <commit>  ending at that commit rather than at HEAD
 *
 * It reads and prints. Nothing here runs a gate, builds anything, or changes a file.
 *
 * It exists because "the tiering saves time" is a claim about the distribution of real changes
 * rather than about the gates, and the only honest source for that is the history. A proposal to
 * widen a subject, to make a gate unconditional, or to drop the whole arrangement is a decision
 * about these numbers, and without this they would be an impression of how often a change seems
 * to touch the editor.
 *
 * Two things it is careful about, because both have produced a wrong answer here.
 *
 * **The window is the landings, not the commits in it.** `--first-parent` from a branch tip counts
 * that branch's own commits first, so measuring 60 from a working branch mixes the work being
 * measured into the sample it is being measured against. Taking 60 landings before the branch
 * point gave 31 of 60 where taking 60 from the tip gave 29, and the second number is about a
 * different population. Pass `--from` to name where the window ends.
 *
 * **The durations are medians from the record, and a gate the record has never seen costs zero
 * here.** So a freshly added gate reads as free until a run has timed it, and a total from a
 * record of two runs is two runs' worth of evidence. The run count is printed for that reason.
 * `scripts/gate-timings.mjs` is the instrument for the durations themselves.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STEPS } from './lib/gateSteps.mjs';
import { CHEAP_ONLY, coveredBy, patternsFor, selectSteps } from './lib/gateTier.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'node scripts/gate-tier-history.mjs [--count <n>] [--from <commit>] [--file <path>]\n\n' +
      'Which gates the tier would have selected for each of the last landings, and what it would\n' +
      'have cost, using the per-gate medians recorded by npm run gates.\n'
  );
  process.exit(0);
}

const COUNT = Number(flag('--count', 60));
const FROM = flag('--from', 'HEAD');
const FILE = flag('--file', join(REPO, '.claude', 'scratch', 'gate-timings.jsonl'));

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' });

/** Per-gate durations from the runs that did not overlap another, which are the comparable ones. */
let runs;
try {
  runs = readFileSync(FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => Array.isArray(r?.gates) && !r.overlapped);
} catch {
  process.stderr.write(`No record at ${FILE}. It is written by npm run gates, one line per run.\n`);
  process.exit(1);
}
if (!runs.length) {
  process.stderr.write(`No uncontended runs in ${FILE}, so there are no durations to price a tier with.\n`);
  process.exit(1);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const seen = new Map();
for (const run of runs) {
  for (const g of run.gates) {
    if (!g?.name || typeof g.ms !== 'number' || g.status === 'skip') continue;
    if (!seen.has(g.name)) seen.set(g.name, []);
    seen.get(g.name).push(g.ms);
  }
}
const cost = (label) => (seen.has(label) ? median(seen.get(label)) : 0);
const untimed = STEPS.filter(([l]) => !seen.has(l)).map(([l]) => l);
const whole = STEPS.reduce((n, [l]) => n + cost(l), 0);

const expensive = STEPS.filter((s) => Array.isArray(s[3])).flatMap(([, , , c]) => patternsFor(c));
const cheap = CHEAP_ONLY.flatMap((c) => c.patterns);
const secs = (ms) => `${(ms / 1000).toFixed(0)}s`;

const rows = [];
for (const sha of git('log', '--format=%h', `-${COUNT}`, '--first-parent', FROM).trim().split('\n')) {
  const changed = git('diff', '--name-only', `${sha}^1`, sha, '--').trim().split('\n').filter(Boolean);
  const loose = changed.filter((p) => /^(src|media|test)\//.test(p) && !coveredBy(expensive, p) && !coveredBy(cheap, p));
  const picked = selectSteps({ steps: STEPS, changed, base: sha, repo: REPO });
  rows.push({
    sha,
    changed: changed.length,
    gates: picked.run.length,
    ms: picked.run.reduce((n, [l]) => n + cost(l), 0),
    loose,
    ran: picked.selected.filter((s) => s.by).map((s) => s.label),
  });
}

const out = [];
out.push(
  `${rows.length} landings ending at ${git('rev-parse', '--short', FROM).trim()}, priced from ${runs.length} uncontended run${runs.length === 1 ? '' : 's'} in ${FILE.slice(REPO.length + 1)}`
);
out.push(`the whole bar is ${secs(whole)} across ${STEPS.length} gates`);
if (untimed.length) out.push(`${untimed.length} gate${untimed.length === 1 ? '' : 's'} the record has never timed, counted as free here: ${untimed.join(', ')}`);
out.push('');
for (const r of rows) {
  const why = r.loose.length
    ? `REFUSED, nothing claims ${r.loose.join(' ')}`
    : r.ran.length === STEPS.filter((s) => Array.isArray(s[3])).length
      ? 'every expensive gate'
      : r.ran.join(', ') || 'the cheap tier alone';
  out.push(`  ${r.sha}  ${String(r.changed).padStart(3)} paths  ${String(r.gates).padStart(2)} gates  ${secs(r.ms).padStart(5)}  ${why}`);
}

const cheapOnly = rows.filter((r) => !r.ran.length && !r.loose.length);
const refused = rows.filter((r) => r.loose.length);
out.push('');
out.push(
  `${cheapOnly.length} of ${rows.length} would have run the cheap tier alone, at ${cheapOnly.length ? secs(median(cheapOnly.map((r) => r.ms))) : '-'} against ${secs(whole)}`
);
out.push(`median landing ${secs(median(rows.map((r) => r.ms)))}; ${secs(rows.reduce((n, r) => n + r.ms, 0))} in total against ${secs(whole * rows.length)} with no tiering`);
if (refused.length) {
  out.push(
    `${refused.length} would have refused to derive a tier, naming a path nothing claims. That is the completeness`
  );
  out.push('rule reading history it predates rather than a fault in those landings.');
}

process.stdout.write(`${out.join('\n')}\n`);
