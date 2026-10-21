/*
 * The gates every change has to pass, in one command: the public documentation
 * check, the generated files, the type check, all the test suites, then the
 * production build.
 *
 *   npm run gates            stops at the first failure, for a person at a terminal
 *   npm run gates -- --all   runs every gate and reports all of them, which is what CI does
 *
 * The list of gates is in `lib/gateSteps.mjs`, with the reasoning for each one beside it and, for
 * the expensive ones, the mapping that says which changes they can have something to say about.
 *
 * **Which of them run is derived from the diff, and never chosen.** A handful of these hold almost
 * all of the wall clock, and one of them runs when the change can reach what it covers. The
 * reasoning is in `lib/gateTier.mjs`; the short version is that an opt-in quick tier means the full
 * run stops happening and an opt-in full tier means the expensive gates stop happening, and both
 * failures are silent. `--all` turns selection off rather than selecting a wider tier, which is
 * what CI and the release check run.
 *
 * One command rather than several chained together, because a chain of shell
 * commands is harder for both people and tooling to approve, and because the
 * steps must not overlap: `npm test` and `npm run build` both drive esbuild over
 * this checkout, and running them at once makes the test run print no counts and
 * the build end in a stack trace with nothing actually wrong.
 *
 * Everything it runs is in this repository. By default it stops at the first failure
 * and exits with that step's code; every run ends by saying how many of the gates it
 * reached, because "all gates passed" is the same sentence whether that was nine or
 * twenty-three.
 *
 * A step that *skips* is not a step that passed. **Fourteen** of these are browser-driven,
 * and each one skips and exits 0 when it cannot find Chrome or `playwright-core`.
 * Those fourteen are the whole layout half of the bar, and jsdom can see none of what
 * they cover, so one missing dependency used to take all of them out at once and the
 * run still said "All gates passed". This reads each step's output for the line the
 * scripts already print and refuses to claim success when one appears.
 *
 * This said "five" until 2026-10-07, when it was counted rather than remembered:
 * run the gates with `PLAYWRIGHT_CORE` pointing at a path that does not exist and
 * `SHEAF_ALLOW_SKIPPED_GATES=1`, and exactly twelve printed `skipped` — Table widths,
 * Diagrams, Caret at markers, Paging, Sticky header, Frame children, Touch layout,
 * Indent and rhythm, Board drag, Hover bar, Cell source, Code colours. They were 336s
 * of a 551s run. `Mounted click` and `Field height` were both added the same day and
 * are the thirteenth and fourteenth, so the twelve and the 336s are from before them
 * and neither number has been taken again. **This count is a thing to re-derive with
 * the command above rather than to increment**, which is how it came to say five.
 * **Four gates in the same stretch need no browser at all**, and one
 * of them, `Editing matrix`, is 90s on its own, so anyone moving "the browser block"
 * to a nightly on the strength of where these sit in the list would leave it behind.
 *
 * Reading the output rather than checking whether Chrome is installed, on purpose:
 * it detects the event rather than predicting its cause, so a future reason to skip
 * is caught without this file knowing about it.
 *
 * Every run is also timed, per gate, and the timings are both printed and appended to
 * `.claude/scratch/gate-timings.jsonl`. See **Timing** at the bottom of this file for
 * what is recorded and why, and `scripts/gate-timings.mjs` for reading it back. The
 * timing lives here rather than in the loop so that nothing about which gates run, in
 * what order, or what any of them checks passes through it: it wraps `run` and reads
 * the same output the loop already captured.
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runGates } from './lib/gateRun.mjs';
import { readVerdict, complaintFor } from './lib/gateOutput.mjs';
import { STEPS } from './lib/gateSteps.mjs';
import { CHEAP_ONLY, changedPaths, coveredBy, patternsFor, selectSteps } from './lib/gateTier.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));


/**
 * Run one step, passing its output straight through as it arrives so nothing is
 * buffered, while keeping a copy to read afterwards.
 */
function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: ['inherit', 'pipe', 'pipe'] });
    let seen = '';
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        seen += chunk;
        out.write(chunk);
      });
    }
    child.on('close', (status, signal) => done({ status, signal, seen }));
    child.on('error', (err) => done({ status: 1, seen: `${seen}\n${err.message}` }));
  });
}

/*
 * Which skips are forgiven, and why the answer is a list rather than a flag.
 *
 * `SHEAF_ALLOW_SKIPPED_GATES=1` forgives every skip, which is the blunt instrument and is
 * kept for a local run somebody is deliberately doing without a browser. A runner needs
 * something narrower: the private-terms list lives outside the repository on purpose, so it
 * can never exist there and that one step can never run, while the browser-driven checks
 * skipping on a runner is a real gap and has to keep failing. Forgiving all of them to get
 * past one would put back exactly the hole `A skipped gate is not a passed gate` closed.
 *
 * So the variable also takes the labels it forgives, comma-separated. A step not named
 * stops the run as before.
 */
const ALLOWED = (process.env.SHEAF_ALLOW_SKIPPED_GATES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const forgiven = (label) => ALLOWED.includes('1') || ALLOWED.includes(label);

/*
 * Two modes, differing only in what happens after a gate fails.
 *
 * The default stops there, which is right for a person at a terminal: the first failure is
 * usually the thing they just did, and twenty more minutes of gates does not help them fix it.
 *
 * `--all` runs every gate and reports all of them, which is right for CI, where nobody is waiting
 * at a prompt and the run is the only record. A run that stops at the first failure hides
 * everything behind it for as long as that failure lives, and nothing reported the number that
 * went dark. From 2026-09-23 to 2026-09-30 every run on `main` died at gate 9 of 23, so fourteen
 * gates did not run on a Linux runner for a week. One of them pressed a macOS-only chord and
 * reported the product broken; that defect failed three release cuts, and it is tempting to say
 * CI should have caught it. CI could not: the gate was nineteen positions behind a failure that
 * had nothing to do with it.
 *
 * **Under `--all` a failure cascades, and that is accepted rather than worked around.** Eleven of
 * these gates serve the built files, so a failing `Build` fails them too. The alternative is a
 * dependency graph between gates, which would be a second description of the order they are
 * already written in, and it would go stale. A reader of a CI log sees `Build` first in the list,
 * which is the one to fix.
 *
 * The loop itself is in `lib/gateRun.mjs` so that it can have a control: what it decides is which
 * gates get reached, and asking that of the real gates would mean ten minutes and no way to make
 * one fail at position 21 on demand. The harness suite drives it with steps that fail where it
 * wants them to.
 */
const ALL = process.argv.includes('--all') || process.env.SHEAF_GATES_ALL === '1';

/*
 * **The tier**, derived from the diff and printed before anything runs.
 *
 * Printed rather than quietly applied, and printed in both halves: which expensive gates were
 * selected and by which changed path, and which were left out. A run that is shorter than the last
 * one has to say why on its own face, because the alternative is somebody reading `All 28 of 28
 * gates passed` and having no way to tell a tiered run from a shrinking bar.
 *
 * **An unclaimed changed path stops the run here, before any gate.** A file nothing claims runs
 * the cheap tier alone, which is an expensive gate silently not running, so it is a failure on the
 * day the file is added rather than a thing discovered later. `scripts/check-gate-tiers.mjs` is the
 * same question asked of the whole tree, and it is a gate; this is the one asked of the diff, and
 * it is cheaper than starting the gates to find out.
 */
const selection = ALL
  ? { run: STEPS, selected: [], everything: true, all: true }
  : (() => {
      const { base, why, paths } = changedPaths(REPO);
      const expensive = STEPS.filter((s) => Array.isArray(s[3])).flatMap(([, , , covers]) => patternsFor(covers));
      const cheap = CHEAP_ONLY.flatMap((c) => c.patterns);
      const loose = paths.filter(
        (p) => /^(src|media|test)\//.test(p) && !coveredBy(expensive, p) && !coveredBy(cheap, p)
      );
      if (loose.length) {
        process.stderr.write(
          `\nNo gate claims ${loose.length === 1 ? 'a path' : 'paths'} this change touches, so the tier cannot be derived:\n` +
            loose.map((p) => `  - ${p}\n`).join('') +
            '\nA path nothing claims runs the cheap tier alone, which is an expensive gate not running\n' +
            'and a green run. Put each one inside a subject in scripts/lib/gateTier.mjs, so the gates\n' +
            'that read it run when it changes, or in CHEAP_ONLY with a sentence saying why nothing in\n' +
            'the expensive tier can see it. Run with --all to reach every gate meanwhile.\n'
        );
        process.exit(1);
      }
      return { ...selectSteps({ steps: STEPS, changed: paths, base, repo: REPO }), base, why, changed: paths.length };
    })();

{
  const lines = [];
  if (selection.all) {
    lines.push(`\n--- gate tier: every gate, --all given ---`);
  } else if (selection.everything) {
    lines.push(`\n--- gate tier: every gate ---`);
    lines.push(`  ${selection.selected[0]?.because ?? 'the tier could not be derived'}`);
    if (selection.base === null) lines.push(`  ${selection.why}`);
  } else {
    lines.push(`\n--- gate tier: ${selection.run.length} of ${STEPS.length} gates ---`);
    lines.push(`  ${selection.changed} path${selection.changed === 1 ? '' : 's'} changed against ${selection.base.slice(0, 9)} (${selection.why})`);
    /*
     * Said out loud, because it is the one state where a short run means nothing was checked
     * rather than that little was at risk. A tree level with its base and clean selects the cheap
     * tier, and that is what a clone of `main` looks like: `scripts/release.mjs` passes `--all`
     * for exactly this reason, and anybody else in that position needs to know they are in it.
     */
    if (selection.changed === 0) {
      lines.push(
        '  Nothing changed against that base, so this is the cheap tier over a tree the base already\n' +
          '  covers. A clone of the integration branch looks like this. Use --all to mean the whole bar.'
      );
    }
    for (const s of selection.selected) {
      lines.push(
        s.by
          ? `  runs     ${s.label}: ${s.by} is covered by ${s.because}`
          : `  left out ${s.label}: nothing this change touches is covered by it`
      );
    }
    lines.push('  Gate tiers checks the mapping itself, and runs whatever the tier is. --all reaches every gate.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/*
 * **Timing.** What each gate costs, printed at the end of every run and appended to a record so a
 * week of runs accumulates. It exists because the only evidence about which gates are expensive
 * was an impression of which runs felt long, and a proposal to run the cheap ones first, or to
 * move the expensive ones to a nightly, is a decision about numbers nobody had.
 *
 * It is measurement and nothing else. Which gates run, in what order, and what each one checks
 * are decided above and in `lib/gateRun.mjs`, and none of that is reachable from here: this wraps
 * the `run` the loop is handed, returns the loop's own result untouched, and reads the output the
 * loop had already captured. A gate cannot pass or fail differently because it was timed.
 *
 * Two things about reading the numbers afterwards.
 *
 * **A run that overlapped another is not comparable.** Several of these gates drive Chromium, and
 * two concurrent runs on one machine contend over it badly enough to roughly triple each other's
 * wall clock. So each run records whether another `gates.mjs` was alive when it started, and
 * `scripts/gate-timings.mjs` leaves those runs out by default. The detection is one `ps` and a
 * walk up the process's own ancestors, which is cheap and is the whole of it: an overlap that
 * begins *after* this run does is not detected, and nothing here pretends otherwise.
 *
 * **A skipped gate's duration is not that gate's cost.** A browser check that cannot find Chrome
 * prints `skipped` and exits in a second, against minutes when it runs, so the status is recorded
 * beside the duration and the reader separates them rather than taking a median across both.
 *
 * What it costs: per gate, two `hrtime` reads and a second pass of `readVerdict` over output the
 * run already holds in memory, which is a fraction of a millisecond. Per run, one `ps`, one
 * `git rev-parse` and one append, which is the whole of the fixed cost and is dominated by the
 * `ps`. Time those two commands on this machine and you have the number; against a run measured
 * in minutes it does not reach a tenth of a percent.
 */
const TIMINGS_FILE = join(REPO, '.claude', 'scratch', 'gate-timings.jsonl');

/** The label a `run(cmd, args)` call belongs to. Each step's command and arguments are distinct. */
const LABELS = new Map(STEPS.map(([label, cmd, args]) => [[cmd, ...args].join('\u0000'), label]));

/**
 * Whether another gates run was already going when this one started.
 *
 * `ps` once, then up this process's own ppid chain, because `npm run gates` puts a shell between
 * npm and node whose command line carries this script's path too, and that ancestor is not
 * another run. Anything that cannot be read is reported as no overlap rather than as an error:
 * a failure to measure contention must not fail the gates.
 */
function overlapping() {
  try {
    const rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const mine = new Set();
    for (let p = process.pid; p && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
    return rows.some((r) => !mine.has(r.pid) && /(^|[/\s])gates\.mjs(\s|$)/.test(r.command));
  } catch {
    return false;
  }
}

/** What this run's timings are about. Unknown rather than wrong when git cannot be asked. */
function commit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** pass, fail or skip, read the way the loop reads it, so the two never disagree. */
function statusOf(r, label) {
  if (r.status !== 0) return 'fail';
  const verdict = readVerdict(r.seen);
  if (verdict.skipped.length) return 'skip';
  return complaintFor(label, verdict) ? 'fail' : 'pass';
}

/** Every gate the loop reached, in the order it reached them. */
const timings = [];

/** `run`, timed. Returns exactly what `run` returned. */
async function timedRun(cmd, args) {
  const label = LABELS.get([cmd, ...args].join('\u0000')) ?? args[args.length - 1] ?? cmd;
  const started = process.hrtime.bigint();
  const r = await run(cmd, args);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  timings.push({ name: label, ms: Math.round(ms), status: statusOf(r, label) });
  return r;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const startedAt = process.hrtime.bigint();
const overlapped = overlapping();
/* Read before the run rather than after it, so the record names the tree that was measured. */
const headCommit = commit();

const { status, failures } = await runGates({
  steps: selection.run,
  run: timedRun,
  all: ALL,
  forgiven,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});

const totalMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

/*
 * The table, slowest first, and the one caveat a reader needs in front of the numbers. It comes
 * after everything the run already printed, so a failing run still ends at its own report of what
 * failed: the last line here names it again rather than leaving a table as the final word.
 */
{
  const width = Math.max(0, ...timings.map((t) => t.name.length));
  /* `---` rather than the `===` a gate's own heading uses, so this block is not read as a gate. */
  const lines = ['\n--- gate timings ---'];
  for (const t of [...timings].sort((a, b) => b.ms - a.ms)) {
    lines.push(`  ${secs(t.ms).padStart(8)}  ${t.name.padEnd(width)}  ${t.status}`);
  }
  lines.push(`  ${secs(totalMs).padStart(8)}  total across ${timings.length} gate${timings.length === 1 ? '' : 's'}`);
  lines.push(
    overlapped
      ? '  Another gates run was already going when this one started, so these durations are not comparable.'
      : '  A run that overlapped another gates run is not comparable; no other run was going when this one started.'
  );
  lines.push(`  Appended to ${TIMINGS_FILE.slice(REPO.length + 1)}; read it back with node scripts/gate-timings.mjs`);
  if (failures.length) {
    lines.push(`  Timing only. What failed is ${failures.map((f) => f.label).join(', ')}, reported in full above.`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/*
 * The record. A failure to write it is said once and changes nothing else: a gates run that
 * passed must not go red because a scratch directory was not writable.
 */
try {
  mkdirSync(dirname(TIMINGS_FILE), { recursive: true });
  appendFileSync(
    TIMINGS_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), commit: headCommit, totalMs, overlapped, gates: timings })}\n`
  );
} catch (err) {
  process.stderr.write(`\nCould not append to ${TIMINGS_FILE}: ${err.message}\n`);
}

process.exit(status);
