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
import { session, REPO } from './session.mjs';

const [area, only] = process.argv.slice(2);
if (!area) {
  console.error('usage: node test/real-editor/run-editor.mjs <area> [id-substring]');
  process.exit(2);
}

/*
 * Refuse to start while another run is driving a window.
 *
 * Two runs on one machine fight for the pointer and the keyboard focus, and each
 * produces failures that belong to neither piece of work. The cost is not the run: it
 * is the hour someone then spends believing those failures. Every session here had
 * been told to check first and it did not hold, for this reason: a check that prints
 * what it found and then carries on is not a check. So it lives here, where a run
 * cannot start without passing it, and it errs towards refusing.
 *
 * SHEAF_ALLOW_CONCURRENT=1 skips it, for the rare run that is meant to share.
 */
if (process.env.SHEAF_ALLOW_CONCURRENT !== '1') {
  // This run and every process above it. A shell that started this one carries the
  // runner's path in its own command line, often as a grandparent rather than the
  // parent, and a run that counted its own launcher as a rival would refuse itself.
  const mine = new Set();
  for (let pid = process.pid; pid > 1 && !mine.has(pid); ) {
    mine.add(pid);
    try {
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    } catch {
      break;
    }
  }
  // What a process is, from its executable rather than its command line. A shell running
  // `node run-editor.mjs … | grep …` forks a child for each stage of the pipe, and every
  // child inherits the parent's command line, which names this file. They are siblings
  // of this run, not ancestors, so the exclusion above misses them, and a check on the
  // command line alone made every piped run refuse itself. A rival that actually holds
  // the screen is always a node process running this file, so that is what is counted.
  const isNode = (pid) => {
    try {
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      return comm.split('/').pop() === 'node';
    } catch {
      return false;
    }
  };
  let others = '';
  try {
    // The pattern's bracket keeps a command that merely names this search from matching it.
    others = execFileSync('pgrep', ['-fl', 'run-editor[.]mjs'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => {
        const pid = Number(line.split(' ')[0]);
        return line && !mine.has(pid) && isNode(pid);
      })
      .join('\n');
  } catch {
    // pgrep exits non-zero when nothing matches, which is the clear case.
  }
  if (others) {
    console.error(`Another real-editor run is on the screen, so this one would be contended. Refusing:\n${others}`);
    console.error('Wait for it to finish, or set SHEAF_ALLOW_CONCURRENT=1 if sharing the screen is intended.');
    process.exit(3);
  }
}
const { scenarios, settings } = await import(`./editor/${area}.mjs`);
// SHEAF_RUN_NAME gives a run its own profile and run folder, so two runs of one area can go side by side.
const runName = process.env.SHEAF_RUN_NAME || area;
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
const stamp = (complete) =>
  writeFileSync(
    join(S.run, 'run.json'),
    JSON.stringify(
      { area, only: only ?? null, runName, commit, pid: process.pid, startedAt: new Date().toISOString(), selected: selected.length, done: results.length, complete },
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
  if (!ok) shot = await S.shot(`fail-${sc.id}`).catch(() => null);
  const errors = await S.errors();
  results.push({ id: sc.id, feature: sc.feature, name: sc.name, ok, detail, errors, shot });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sc.id} ${sc.name}${ok ? '' : `\n     ${detail}`}${errors.length ? `\n     errors: ${errors.join(' | ')}` : ''}`);
  // Written as they come in rather than at the end, so a run that is stopped
  // leaves what it actually measured instead of the last run's numbers.
  writeFileSync(join(S.run, 'results.json'), JSON.stringify(results, null, 2));
  stamp(false);
  await S.cleanup().catch(() => {});
}
writeFileSync(join(S.run, 'results.json'), JSON.stringify(results, null, 2));
stamp(true);
const pass = results.filter((r) => r.ok).length;
console.log(`\n${area}: ${pass}/${results.length} scenarios passed, ${scenarios.length} in the area (results in ${S.run})`);
await S.quit();
process.exit(pass === results.length ? 0 : 1);
