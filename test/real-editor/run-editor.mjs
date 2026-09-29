// Run one area's scenarios in a real VS Code window.
//
//   node test/real-editor/run-editor.mjs <area> [id-substring]
//
// An area file editor/<area>.mjs exports `scenarios`: [{ id, feature, name, run }], and optionally `settings` for
// the VS Code profile. `run(S)` receives the session from session.mjs and returns true, or { ok, detail } where
// detail says what a person would have seen. A throw is a failure (a click on a covered target throws). Every
// failure gets a screenshot. Results are written to results.json in the run folder, whose path is printed.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { session, REPO, RUNS } from './session.mjs';
import { holdScreen, locklessRunners } from './screenLock.mjs';
import { reapQuietly } from './reapRuns.mjs';

const [area, only] = process.argv.slice(2);
if (!area) {
  console.error('usage: node test/real-editor/run-editor.mjs <area> [id-substring]');
  process.exit(2);
}

const { scenarios, settings } = await import(`./editor/${area}.mjs`);
// SHEAF_RUN_NAME gives a run its own profile and run folder, so two runs of one area can go side by side.
const runName = process.env.SHEAF_RUN_NAME || area;

/**
 * How long to wait for a run that holds no lock before going ahead anyway.
 *
 * Long enough that a genuine run from an older checkout finishes an area, short enough that
 * an orphan from a killed shell costs one run's wait rather than the night. `readLock` is no
 * help here by definition: what is being waited for is a process that took no lock.
 */
const WAIT_FOR_UNLOCKED_MS = 4 * 60_000;

/**
 * The runs this one ended up sharing the screen with, if any.
 *
 * Carried the whole way to `run.json` and to the last line of output rather than mentioned
 * once at the top. The cost is one-directional and that is what makes it worth repeating:
 * each run talks to its own VS Code over its own socket, so contention can make a scenario
 * fail and cannot make one pass. A PASS from a contended run is still a PASS; a FAIL looks
 * exactly like a real one, and somebody then spends an hour on a bug that does not exist.
 */
let sharedWith = [];

/*
 * Wait for the screen before driving it.
 *
 * A run owns the pointer and the keyboard focus for as long as it lasts, so two at once
 * produce failures that belong to neither piece of work. This used to refuse to start,
 * which is the wrong answer for anything unattended: a refused run has to be asked for
 * again by whoever wanted it, and by then the screen is usually free. So it queues. The
 * details of the lock are in screenLock.mjs.
 *
 * SHEAF_ALLOW_CONCURRENT=1 skips it, for the rare run that is meant to share, and
 * --no-wait fails instead of queueing.
 */
if (process.env.SHEAF_ALLOW_CONCURRENT !== '1') {
  const wait = !process.argv.includes('--no-wait');
  /*
   * The lock first, and then the process list. That order is the whole of it.
   *
   * The other way round deadlocks, and did: the process-list wait ran before the lock was
   * taken, so two runs starting while no lock file existed each saw the other, each waited
   * for it to exit, and neither ever took the lock or stopped waiting. It is not a rare
   * window either, because a finished run removes the lock file, so every run leaves one
   * behind it. Five runs were stuck in it at once, the oldest for eighteen minutes, with
   * nothing written and no run folder created.
   *
   * Taking the lock first cannot deadlock, because every lock-aware run then queues on the
   * lock, which has an owner and a takeover rule. What the process list still adds is the
   * run from a checkout too old to take a lock at all, or one keeping it somewhere this
   * build no longer looks; those are waited for below, holding the lock, where no other
   * lock-aware run is in the same wait.
   */
  const release = await holdScreen({ name: runName, area, runDir: join(RUNS, runName), wait });
  if (!release) process.exit(3);
  /*
   * Only the runs the lock has never heard of. Every run queued on the lock is in the
   * process list too, and waiting for those was four minutes of idle screen at every
   * handover: the holder cannot be released by a sibling that is waiting for it.
   */
  const unlocked = locklessRunners();
  if (unlocked.length) {
    if (!wait) {
      console.error(`Another real-editor run is on the screen and holds no lock:\n${unlocked.join('\n')}`);
      process.exit(3);
    }
    console.error(`Waiting for a real-editor run that holds no lock, so it is from another checkout:\n${unlocked.join('\n')}`);
    /*
     * Bounded, because the thing being waited for is by definition one this build cannot
     * ask about. An orphan left by a killed shell never exits, and waiting for ever on it
     * while holding the lock would block every run on the machine rather than one. After
     * the bound the run goes ahead and says so: two runs sharing the screen produce
     * confusing failures, and a night that produced nothing at all is worse.
     */
    const until = Date.now() + WAIT_FOR_UNLOCKED_MS;
    while (locklessRunners().length && Date.now() < until) await new Promise((r) => setTimeout(r, 3000));
    const still = locklessRunners();
    if (still.length) {
      console.error(
        `Still there after ${Math.round(WAIT_FOR_UNLOCKED_MS / 1000)}s, so going ahead and sharing the screen with it. ` +
          `Results from this run may belong to neither piece of work:\n${still.join('\n')}`
      );
      sharedWith = still;
    }
  }
}

// Behind the lock, so two runs are never walking the same folders, and before the session
// is built, so this run's own folder is created after the tidying rather than during it.
reapQuietly(RUNS);

const S = await session(runName, { settings });

/*
 * Who is writing this folder, what they are measuring, and whether they finished.
 *
 * A run that is killed, or whose folder is deleted by a second run of the same
 * area, used to leave `results.json` exactly as the previous run wrote it, and a
 * reader had no way to tell whose numbers they were holding or whether the run
 * that produced them had reached the end. That has already been read as a result
 * three times. `run.json` is written before the first scenario and again after
 * every one, so a partial run says so while it is still partial.
 */
const selected = scenarios.filter((sc) => !only || sc.id.includes(only));
const commit = (() => {
  try {
    // The checkout under test, which is the one Sheaf runs from: this runner's own
    // checkout unless SHEAF_CHECKOUT names another. Stamping the runner's checkout
    // labelled every run of another branch with the wrong commit. A checkout with
    // uncommitted changes says so, since its commit alone does not describe what ran.
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO }).toString().trim() !== '';
    return dirty ? `${head}+dirty` : head;
  } catch {
    return 'unknown';
  }
})();
/*
 * When the run began, taken once. `stamp` is called before the first scenario and again
 * after every one, so a time read inside it is the time of the last scenario and the
 * field said so under a name that promised the opposite: a finished run's `startedAt` was
 * within a second of its end, and how long a run took could not be worked out from its
 * own record.
 */
const startedAt = new Date().toISOString();
const stamp = (complete) =>
  writeFileSync(
    join(S.run, 'run.json'),
    JSON.stringify(
      {
        area,
        only: only ?? null,
        runName,
        commit,
        pid: process.pid,
        startedAt,
        // Written on every stamp, so a run killed partway still says when it was last
        // heard from, and a finished one says how long it took.
        updatedAt: new Date().toISOString(),
        selected: selected.length,
        done: results.length,
        // Empty on an ordinary run, including one that merely waited its turn. Anything here
        // means a failure below may belong to neither piece of work.
        sharedWith,
        complete,
      },
      null,
      2
    )
  );

const results = [];
stamp(false);
for (const sc of selected) {
  let ok = false;
  let detail = '';
  try {
    const r = await sc.run(S);
    ok = r === true || r?.ok === true;
    detail = typeof r === 'object' && r ? r.detail ?? '' : ok ? '' : `returned ${JSON.stringify(r)}`;
  } catch (e) {
    detail = `threw: ${String(e.message || e).split('\n')[0]}`;
  }
  let shot = null;
  /*
   * A scenario may carry `known: '<why>'`: the behaviour it asks for is not there yet, the bug
   * is filed, and nobody is fixing it this week. Without this the run reports it as a failure
   * every time, and a standing failure is worse than no check at all, because the next person
   * reads the count rather than the list and a new failure hides among the old ones. Two of
   * those cost real time in one evening: one scenario asserted something no correct behaviour
   * could produce and was believed for hours, and another had been failing so long that its
   * area's "one failure" was assumed to be it.
   *
   * So a known one prints KNOWN and is left out of the count — and it fails the run when it
   * *passes*, because a known failure that starts working means the bug is fixed and the marker
   * is now a lie. That is the whole point: it turns a standing failure into a tripwire.
   *
   * The marker holds the reason in words rather than a ticket, because a tracker id in a file
   * that ships is a reference a stranger cannot follow. The ticket is on the feature's row in
   * the quality notes, which is where the results already live.
   *
   * Only the bug-finding session marks one, because deciding that a failure is expected is a
   * judgement about the product rather than about the code.
   */
  const known = typeof sc.known === 'string' && sc.known ? sc.known : null;
  const surprise = known && ok;
  const state = surprise ? 'FIXED' : known ? 'KNOWN' : ok ? 'PASS' : 'FAIL';
  // A surprise is counted, and counted as a failure: the marker is wrong and someone must look.
  const counts = known ? false : ok;
  if (!ok && !known) shot = await S.shot(`fail-${sc.id}`).catch(() => null);
  const errors = await S.errors();
  results.push({ id: sc.id, feature: sc.feature, name: sc.name, ok: counts, raw: ok, known, detail, errors, shot });
  const say = surprise
    ? `\n     it passes now, so either the bug is fixed or this marker is stale: take the marker off`
    : known
      ? `\n     known: ${known}\n     ${detail}`
      : ok
        ? ''
        : `\n     ${detail}`;
  console.log(`${state} ${sc.id} ${sc.name}${say}${errors.length ? `\n     errors: ${errors.join(' | ')}` : ''}`);
  // Written as they come in rather than at the end, so a run that is stopped
  // leaves what it actually measured instead of the last run's numbers.
  writeFileSync(join(S.run, 'results.json'), JSON.stringify(results, null, 2));
  stamp(false);
  await S.cleanup().catch(() => {});
}
writeFileSync(join(S.run, 'results.json'), JSON.stringify(results, null, 2));
stamp(true);
const knownFailures = results.filter((r) => r.known && !r.raw);
const surprises = results.filter((r) => r.known && r.raw);
// A known failure is out of the count entirely, so a run with nothing but those left is green.
// Counting it as red is exactly what makes a standing failure invisible.
const counted = results.filter((r) => !(r.known && !r.raw));
const pass = counted.filter((r) => r.ok).length;
// Said out loud as well as written into `run.json`, because sizing an unattended sweep of
// every area means reading a per-area duration, and the terminal is where anyone doing that
// is already looking. `startedAt` above is what makes it a duration rather than a guess.
const tookMs = Date.now() - new Date(startedAt).getTime();
const took = tookMs < 90000 ? `${Math.round(tookMs / 1000)}s` : `${Math.floor(tookMs / 60000)}m ${Math.round((tookMs % 60000) / 1000)}s`;
console.log(
  `\n${area}: ${pass}/${counted.length} scenarios passed in ${took}, ${scenarios.length} in the area (results in ${S.run})` +
    // On the line a person actually reads, because the warning printed before the run is at
    // the top of output that is read from the bottom.
    (sharedWith.length
      ? `\nSCREEN SHARED with ${sharedWith.length} run${sharedWith.length === 1 ? '' : 's'} holding no lock: a failure here may not be real`
      : '') +
    (knownFailures.length
      ? `\n${knownFailures.length} known failure${knownFailures.length === 1 ? '' : 's'}, not counted: ${knownFailures.map((r) => r.id).join(', ')}`
      : '') +
    (surprises.length ? `\n${surprises.length} marked known and passing, which fails this run: ${surprises.map((r) => r.id).join(', ')}` : '')
);
await S.quit();
process.exit(pass === counted.length ? 0 : 1);
