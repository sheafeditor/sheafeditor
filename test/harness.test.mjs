/*
 * Checks for the test harness itself.
 *
 * The harness is what every real-window result is read through, so a fault in it is
 * worse than a fault in a feature: it shows up as a product bug that nobody can find.
 * What lives here is the part of the harness that can be checked without a window.
 *
 *   node test/harness.test.mjs
 */

import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { complaintFor, readVerdict } from '../scripts/lib/gateOutput.mjs';
import {
  ago,
  holderProgress,
  knownPids,
  lockPath,
  locklessRunners,
  otherRunners,
  pidAlive,
  readLock,
  registerWaiter,
  tryTake,
  waitersDir,
  waitingLine,
  WEDGED_AFTER_MS,
} from './real-editor/screenLock.mjs';
import { reapRuns } from './real-editor/reapRuns.mjs';

const cases = [];
const check = (name, run) => cases.push({ name, run });
const j = (x) => JSON.stringify(x);

/** A scratch directory of its own per check, so one cannot leave a lock for the next. */
const scratch = () => mkdtempSync(join(tmpdir(), 'sheaf-harness-'));

check('the first run takes the lock and the second is told who holds it', () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    const first = tryTake(path, { pid: process.pid, name: 'render', area: 'render', started: new Date().toISOString(), cwd: dir });
    // A live pid, so the second must not take it: this process is the live one.
    const second = tryTake(path, { pid: process.pid, name: 'toc', area: 'toc', started: new Date().toISOString(), cwd: dir });
    return {
      ok: first.held === true && second.held === false && second.by?.name === 'render',
      detail: `first ${j(first)}; second ${j(second)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a lock left behind by a run that is gone is taken over, and the takeover is said out loud', () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    // A pid that cannot be alive: 2 is the kernel's on this platform and never a run of
    // ours, and the check below proves the helper agrees it is not alive.
    const dead = 999999;
    writeFileSync(path, JSON.stringify({ pid: dead, name: 'killed', area: 'render', started: new Date().toISOString(), cwd: dir }));
    let told = null;
    const got = tryTake(path, { pid: process.pid, name: 'mine', area: 'toc', started: new Date().toISOString(), cwd: dir }, { onStale: (by) => (told = by) });
    const now = readLock(path);
    return {
      ok: !pidAlive(dead) && got.held === true && told?.name === 'killed' && now?.name === 'mine',
      detail: `dead pid alive? ${pidAlive(dead)}; took it ${got.held}; told about ${j(told)}; lock now ${j(now)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a lock file that is not readable JSON is treated as left behind rather than held for ever', () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    // A run killed between creating the file and writing to it leaves this.
    writeFileSync(path, '');
    const got = tryTake(path, { pid: process.pid, name: 'mine', area: 'toc', started: new Date().toISOString(), cwd: dir });
    return { ok: got.held === true && readLock(path)?.name === 'mine', detail: `took it ${got.held}; lock now ${j(readLock(path))}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('the waiting line names the run, its area, how long it has been going and where from', () => {
  const line = waitingLine({ name: 'render', area: 'render', started: new Date(Date.now() - 5 * 60000).toISOString(), cwd: '/work/sheaf-dev' });
  const ok =
    line.includes('"render"') && line.includes('(render)') && line.includes('5 min ago') && line.includes('/work/sheaf-dev');
  // With nothing to go on it still says what it is doing rather than printing blanks.
  const bare = waitingLine(null);
  return { ok: ok && bare.length > 20 && !bare.includes('undefined'), detail: `${j(line)}; with nothing: ${j(bare)}` };
});

check('how long ago reads in seconds under a minute and in minutes above it', () => {
  const now = Date.now();
  const secs = ago(new Date(now - 4000).toISOString(), now);
  const mins = ago(new Date(now - 130000).toISOString(), now);
  // A clock that went backwards must not print a negative age.
  const future = ago(new Date(now + 60000).toISOString(), now);
  return { ok: secs === '4s ago' && mins === '2 min ago' && future === 'just now', detail: `${secs}; ${mins}; ${future}` };
});

check('a live pid is alive and this process is, which is what the takeover rule turns on', () => {
  return { ok: pidAlive(process.pid) === true && pidAlive(999999) === false && pidAlive(0) === false, detail: '' };
});

check('the lock is released when the run exits, so the next one does not wait for a ghost', async () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    // A whole process, because the release is registered on `exit`: calling the helper in
    // this one would only prove the handler was added, not that it runs.
    const code = `
      const { holdScreen, lockPath } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      await holdScreen({ name: 'short', area: 'toc', log: () => {} });
      process.stdout.write(lockPath());
    `;
    const held = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SHEAF_SCREEN_LOCK: path } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('exit', () => resolve(out.trim()));
    });
    const stillThere = held ? existsSync(held) : null;
    return { ok: !!held && stillThere === false, detail: `the run's lock was ${j(held)}; still there afterwards? ${stillThere}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a run that would rather fail than queue is told who has it and gets nothing back', async () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    const code = `
      const { holdScreen, lockPath, tryTake } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      const { writeFileSync } = await import('node:fs');
      // A lock held by this very process, so it is certainly alive.
      writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, name: 'theirs', area: 'render', started: new Date().toISOString(), cwd: '/x' }));
      const lines = [];
      const release = await holdScreen({ name: 'mine', area: 'toc', wait: false, log: (l) => lines.push(l) });
      process.stdout.write(JSON.stringify({ release, lines }));
    `;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SHEAF_SCREEN_LOCK: path } });
      let o = '';
      child.stdout.on('data', (d) => (o += d));
      child.on('exit', () => resolve(o.trim()));
    });
    const said = JSON.parse(out || '{}');
    return {
      ok: said.release === null && (said.lines ?? []).some((l) => l.includes('"theirs"')) && (said.lines ?? []).some((l) => l.includes('--no-wait')),
      detail: out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a waiting run takes the lock once the one holding it lets go', async () => {
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    // The whole point of the change, so it is checked end to end rather than by parts: one
    // process holds the lock for a moment, a second waits, and the second must get it.
    const holder = `
      const { holdScreen } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      await holdScreen({ name: 'holder', area: 'render', log: () => {} });
      await new Promise((r) => setTimeout(r, 1200));
    `;
    const waiter = `
      const { holdScreen } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      const lines = [];
      const t0 = Date.now();
      const release = await holdScreen({ name: 'waiter', area: 'toc', pollMs: 150, log: (l) => lines.push(l) });
      process.stdout.write(JSON.stringify({ got: !!release, waitedMs: Date.now() - t0, lines }));
    `;
    const run = (code) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SHEAF_SCREEN_LOCK: path } });
        let o = '';
        child.stdout.on('data', (d) => (o += d));
        child.on('exit', (c) => resolve({ out: o.trim(), code: c }));
      });
    const first = run(holder);
    await new Promise((r) => setTimeout(r, 300));
    const second = await run(waiter);
    await first;
    const said = JSON.parse(second.out || '{}');
    return {
      ok: said.got === true && said.waitedMs > 300 && (said.lines ?? []).some((l) => l.includes('"holder"')),
      detail: second.out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('two runs starting with no lock file present both finish, rather than waiting for each other', async () => {
  /*
   * The deadlock this is here for. `run-editor.mjs` used to consult the process list *before*
   * taking the lock, and wait without a bound for any other run it found. Two runs starting
   * while no lock file existed each saw the other, each waited, and neither ever took the
   * lock. Not a rare window: a finished run removes the lock file, so every run leaves one
   * behind it, and five runs were stuck at once with the oldest at eighteen minutes.
   *
   * Two whole processes, because what is being checked is the order of two steps inside the
   * runner's own startup. Both are told the lock lives in a scratch file that does not exist,
   * which is the state that used to deadlock, and both have to come back.
   */
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    // The shape of the runner's startup rather than the runner itself, which would want a
    // window: take the lock, then look at the process list, and report having got through.
    const code = `
      const { holdScreen, otherRunners } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      const release = await holdScreen({ name: process.argv[2], area: 'toc', log: () => {} });
      if (!release) { process.stdout.write('refused'); process.exit(0); }
      // The bounded look at the process list, as the runner does it, with a bound short
      // enough for a check. Unbounded here is what hung.
      const until = Date.now() + 4000;
      while (otherRunners().length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      process.stdout.write('through');
      release();
    `;
    /*
     * Written to a file called `run-editor.mjs`, and that name is the point.
     * `otherRunners` finds runs with `pgrep -fl 'run-editor[.]mjs'`, so a child spawned with
     * `-e` does not look like a run to it and the wait it is meant to enter ends at once.
     * The first version of this check did exactly that and passed with the deadlock in place,
     * which is a check that could not fail.
     */
    const runner = join(dir, 'run-editor.mjs');
    writeFileSync(runner, code);
    const run = (name) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [runner, name], {
          env: { ...process.env, SHEAF_SCREEN_LOCK: path },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        // A generous ceiling: the point is that neither hangs, so anything near it is a fail.
        const timer = setTimeout(() => (child.kill(), resolve('hung')), 20000);
        child.on('exit', () => (clearTimeout(timer), resolve(out.trim() || 'nothing')));
      });
    const [a, b] = await Promise.all([run('first'), run('second')]);
    return {
      // Both got through, in some order, and the lock is let go afterwards.
      ok: a === 'through' && b === 'through' && !existsSync(path),
      detail: `first ${j(a)}, second ${j(b)}; lock left behind ${existsSync(path)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a run queued on the lock is not one the holder waits for, though the process list still sees it', async () => {
  /*
   * The four minutes of idle screen at every handover. `holdScreen` is taken first and then
   * the process list is consulted, but only one run can hold the lock, so every run queued
   * behind the holder appears in that list holding no lock, which is exactly what a run from
   * a checkout too old to take one looks like. The holder therefore waited the full bound for
   * its own siblings: measured at 4m08s between the lock's timestamp and the run folder
   * appearing, with the only other runs being two queued lock-aware ones.
   *
   * A whole process again, and named `run-editor.mjs` for the same reason the check below
   * says: `otherRunners` finds runs by that name, so a child spawned with `-e` is invisible
   * to it and a check built that way cannot fail.
   */
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  let child;
  try {
    // This process holds the lock, so the spawned one can only queue.
    const held = tryTake(path, { pid: process.pid, name: 'holder', area: 'render', started: new Date().toISOString(), cwd: dir });
    if (!held.held) return { ok: false, detail: 'could not take the lock to set the check up' };
    const runner = join(dir, 'run-editor.mjs');
    writeFileSync(
      runner,
      `
      const { holdScreen } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      // Queues for ever, because the lock is held for the whole of this check.
      await holdScreen({ name: 'queued', area: 'toc', pollMs: 100, log: () => {} });
    `
    );
    child = spawn(process.execPath, [runner], { env: { ...process.env, SHEAF_SCREEN_LOCK: path } });
    // Wait for it to register rather than for a fixed time, so a slow machine does not
    // turn this into a check of how fast a process starts.
    const until = Date.now() + 15000;
    while (Date.now() < until && !knownPids(path).has(child.pid)) await new Promise((r) => setTimeout(r, 100));

    const seenByProcessList = otherRunners().some((l) => Number(l.split(' ')[0]) === child.pid);
    const waitedFor = locklessRunners(path).some((l) => Number(l.split(' ')[0]) === child.pid);

    /*
     * The control, and it is the discriminator itself: with the waiter's registration removed
     * the same live process must come back as something to wait for. Without this, a run that
     * simply failed to appear in the process list at all would pass the assertion above, and
     * "the holder did not wait for it" is what a broken lookup reports too.
     */
    rmSync(join(waitersDir(path), String(child.pid)), { force: true });
    const waitedForUnregistered = locklessRunners(path).some((l) => Number(l.split(' ')[0]) === child.pid);

    return {
      ok: seenByProcessList && !waitedFor && waitedForUnregistered,
      detail: `process list sees it ${seenByProcessList}, waited for while registered ${waitedFor}, waited for once unregistered ${waitedForUnregistered}`,
    };
  } finally {
    child?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a waiter that was killed while queueing stops counting as queued, so it does not hide a real run', () => {
  /*
   * A waiter registers a file named for its pid and removes it on the way out, but a Ctrl-C
   * runs no exit handler, so the file outlives the process. Left alone that entry would
   * subtract a pid for ever, and a genuinely lockless run that later took the same pid would
   * be invisible. So the entries are read as claims and checked against the process table.
   */
  const dir = scratch();
  const path = join(dir, 'screen.lock');
  try {
    const live = registerWaiter({ pid: process.pid, name: 'mine', area: 'toc' }, path);
    // 1 is init, which pidAlive rejects by design, so this stands in for a pid that is gone
    // without the check having to guess at one that is free.
    writeFileSync(join(waitersDir(path), '999999'), j({ pid: 999999, name: 'ghost' }));
    const known = knownPids(path);
    const cleared = !existsSync(join(waitersDir(path), '999999'));
    live();
    const afterRelease = knownPids(path);
    return {
      ok: known.has(process.pid) && !known.has(999999) && cleared && !afterRelease.has(process.pid),
      detail: `live counted ${known.has(process.pid)}, dead counted ${known.has(999999)}, dead entry removed ${cleared}, still counted after release ${afterRelease.has(process.pid)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a holder that has stopped writing is reported as wedged, and a slow one is not', () => {
  /*
   * `pidAlive` was the only liveness test, and a wedged run is alive, so the takeover never
   * fired and the waiters waited: a `code-blocks` run held the screen for 31 minutes with
   * nothing written for 32, twice in one afternoon, and each time it was read as somebody
   * else's slow work. A run stamps `run.json` after every scenario, so its own folder answers
   * the question without asking its process anything.
   */
  const dir = scratch();
  const runDir = join(dir, 'run');
  try {
    mkdirSync(runDir, { recursive: true });
    const now = Date.now();
    const at = (ms) => new Date(now - ms).toISOString();
    const stampedAt = (ms) => {
      writeFileSync(join(runDir, 'run.json'), j({ area: 'toc' }));
      const t = new Date(now - ms);
      utimesSync(join(runDir, 'run.json'), t, t);
    };

    // Working: stamped a moment ago, which is what any run in progress looks like.
    stampedAt(10_000);
    const working = holderProgress({ name: 'a', started: at(20 * 60_000), runDir }, now);
    // Wedged: alive, holding the screen, and its folder has not moved in well past the bound.
    stampedAt(WEDGED_AFTER_MS + 60_000);
    const stalled = holderProgress({ name: 'a', started: at(40 * 60_000), runDir }, now);
    // The shape actually seen: the lock taken and no run folder ever created.
    rmSync(join(runDir, 'run.json'), { force: true });
    const noFolder = holderProgress({ name: 'a', started: at(WEDGED_AFTER_MS + 60_000), runDir }, now);
    // And its control, which is the one that keeps this from firing on every ordinary run:
    // a holder that has just taken the lock has no run.json yet either.
    const justStarted = holderProgress({ name: 'a', started: at(5_000), runDir }, now);
    // A lock from a build that does not record where it writes cannot be judged at all, and
    // must not be guessed at.
    const older = holderProgress({ name: 'a', started: at(60 * 60_000) }, now);

    return {
      ok: !working.wedged && stalled.wedged && noFolder.wedged && !justStarted.wedged && !older.wedged,
      detail:
        `working ${working.wedged} (${working.why}), stalled ${stalled.wedged} (${stalled.why}), ` +
        `no folder ${noFolder.wedged} (${noFolder.why}), just started ${justStarted.wedged}, no runDir ${older.wedged}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a run records when it started, once, rather than when its last scenario ran', () => {
  /*
   * `stamp` writes `run.json` before the first scenario and again after every one, so a
   * time read inside it is the time of the last scenario under a name that promises the
   * opposite. A finished run's `startedAt` sat within a second of its end and no run could
   * say how long it took.
   *
   * Checked by reading the source, because `stamp` is a closure inside the runner and the
   * only other way to ask is to drive a window. It anchors on the two declarations and
   * fails loudly if either moves, rather than passing by finding nothing.
   */
  const source = readFileSync(join(import.meta.dirname, 'real-editor', 'run-editor.mjs'), 'utf8');
  const declared = /\nconst startedAt = new Date\(\)\.toISOString\(\);/.test(source);
  if (!declared) {
    return { ok: false, detail: 'no module-scope `const startedAt = new Date().toISOString();` in run-editor.mjs: this check lost its anchor' };
  }
  const stamp = source.slice(source.indexOf('const stamp = '), source.indexOf('const results = []'));
  if (!stamp.includes('startedAt')) {
    return { ok: false, detail: 'the stamp body no longer mentions startedAt: this check lost its anchor' };
  }
  // The fault was `startedAt: new Date()...` inside the stamp. `updatedAt` is read there on
  // purpose, so the test is which field a fresh time is being written into.
  const reread = /startedAt:\s*new Date\(/.test(stamp);
  return {
    ok: !reread,
    detail: reread
      ? 'startedAt is read again inside stamp, so it holds the time of the last scenario rather than the run'
      : '',
  };
});

check('two runs that put their run folders in different places still look for one lock', async () => {
  const a = scratch();
  const b = scratch();
  try {
    // The screen is the machine's, so where a run keeps its own output has nothing to do
    // with it. When the lock's path was derived from SHEAF_EDITOR_RUNS, two sessions that
    // set that variable differently took two locks and neither saw the other's; they still
    // did not collide, because otherRunners() catches the process, but the run queued on
    // the process list and the waiting line could no longer say who held the screen.
    const code = `
      const { lockPath } = await import(${JSON.stringify(new URL('./real-editor/screenLock.mjs', import.meta.url).href)});
      process.stdout.write(lockPath());
    `;
    const ask = (runsDir) =>
      new Promise((resolve) => {
        const env = { ...process.env, SHEAF_EDITOR_RUNS: runsDir };
        // The override the checks above use would defeat the point of this one.
        delete env.SHEAF_SCREEN_LOCK;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env });
        let o = '';
        child.stdout.on('data', (d) => (o += d));
        child.on('exit', () => resolve(o.trim()));
      });
    const [first, second] = await Promise.all([ask(a), ask(b)]);
    const ok = !!first && first === second && !first.includes(a) && !first.includes(b);
    return { ok, detail: `${j(first)} vs ${j(second)}` };
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

check('the lock is named for the screen rather than for this project, because the screen is the machine\'s', () => {
  const env = { ...process.env };
  delete env.SHEAF_SCREEN_LOCK;
  const saved = process.env.SHEAF_SCREEN_LOCK;
  delete process.env.SHEAF_SCREEN_LOCK;
  try {
    const path = lockPath();
    const name = path.slice(path.lastIndexOf('/') + 1);
    // A run from another project that takes the pointer is meant to take this same file, so
    // a name with `sheaf` in it would be a promise this module cannot keep.
    const ok = name === 'agent-screen.lock' && path.startsWith(homedir() + '/');
    return { ok, detail: path };
  } finally {
    if (saved !== undefined) process.env.SHEAF_SCREEN_LOCK = saved;
  }
});

/*
 * Retention on the run folders.
 *
 * Every session's runs land in one shared directory and nothing removed them, so it reached
 * 5.8 GB across 260 folders. What makes this worth checking rather than eyeballing is that
 * the code deletes things inside folders belonging to sessions it knows nothing about, so
 * each guard that keeps it off a folder is checked from both sides.
 */

/** A run folder: `run.json` when `info` is given, and a byte in each part a run writes. */
function runFolder(root, name, info) {
  const dir = join(root, name);
  for (const part of ['user/User', 'ws/e2e', 'ext', 'shots']) mkdirSync(join(dir, part), { recursive: true });
  writeFileSync(join(dir, 'user/User/settings.json'), '{}');
  writeFileSync(join(dir, 'ws/e2e/note.md'), 'what the run drove');
  writeFileSync(join(dir, 'ext/extension.js'), '//');
  writeFileSync(join(dir, 'shots/fail-x.png'), 'png');
  writeFileSync(join(dir, 'results.json'), '[]');
  if (info) writeFileSync(join(dir, 'run.json'), JSON.stringify(info));
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;
/** Which of a run folder's parts are still there. */
const parts = (dir) => ['user', 'ws', 'ext', 'shots', 'results.json', 'run.json'].filter((p) => existsSync(join(dir, p)));

/** The fixture the retention checks read, with one folder per rule the reaper has. */
function runsFixture() {
  const root = scratch();
  const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  return {
    root,
    // This process, so certainly alive, and `complete: true` on purpose: the runner writes
    // that stamp before it quits VS Code, so for the seconds a window takes to close there
    // really is a live process whose folder says it has finished. That is the case only the
    // pid guard catches, and a fixture saying `complete: false` would have the unfinished
    // rule protecting it instead, leaving the pid guard checked by nothing.
    live: runFolder(root, 'live', { area: 'render', pid: process.pid, startedAt: at(0), complete: true }),
    done: runFolder(root, 'done', { area: 'toc', pid: 999999, startedAt: at(0), complete: true }),
    doneOld: runFolder(root, 'done-old', { area: 'menus', pid: 999999, startedAt: at(30), complete: true }),
    died: runFolder(root, 'died', { area: 'pointer', pid: 999999, startedAt: at(0), complete: false }),
    // No run.json at all, which is every folder written before there was one.
    noStamp: runFolder(root, 'no-stamp', null),
  };
}

check('a run that is still driving the screen keeps every byte of its folder', () => {
  const f = runsFixture();
  try {
    const r = reapRuns(f.root, { keepDays: 3 });
    const kept = parts(f.live);
    const why = r.kept.find((k) => k.name === 'live')?.why ?? '';
    return {
      ok: kept.length === 6 && why.includes(String(process.pid)),
      detail: `${j(kept)} left alone because ${j(why)}`,
    };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

check('a finished run loses its profile at once and the documents it drove only once it is old', () => {
  const f = runsFixture();
  try {
    reapRuns(f.root, { keepDays: 3 });
    // The profile is never evidence, so it goes straight away; `ws` is what a person opens
    // after reading a failure, so it waits. Both keep results, run.json and the pictures.
    const recent = parts(f.done);
    const old = parts(f.doneOld);
    const ok =
      j(recent) === j(['ws', 'shots', 'results.json', 'run.json']) && j(old) === j(['shots', 'results.json', 'run.json']);
    return { ok, detail: `recent ${j(recent)}, old ${j(old)}` };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

check('a run that died halfway is left whole, until it is older than the retention', () => {
  const f = runsFixture();
  try {
    reapRuns(f.root, { keepDays: 3 });
    const before = parts(f.died);
    // Ten days on, the same folder is nobody's open question any more.
    reapRuns(f.root, { keepDays: 3, now: Date.now() + 10 * DAY });
    const after = parts(f.died);
    const ok = before.length === 6 && j(after) === j(['shots', 'results.json', 'run.json']);
    return { ok, detail: `${j(before)} then ${j(after)}` };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

check('a folder with no run.json is judged by when it was last written, since it names no pid', () => {
  const f = runsFixture();
  try {
    // Written a moment ago, so something may be using it and nothing in it may be touched.
    reapRuns(f.root, { keepDays: 3 });
    const fresh = parts(f.noStamp);
    // Quiet for longer than the retention: a run being driven writes the whole time it runs,
    // so a folder nothing has touched has nobody in it. 1.5 GB of the pile was in these.
    reapRuns(f.root, { keepDays: 3, now: Date.now() + 10 * DAY });
    const quiet = parts(f.noStamp);
    // Five rather than six, because this is the folder that has no run.json to begin with.
    const ok = j(fresh) === j(['user', 'ws', 'ext', 'shots', 'results.json']) && j(quiet) === j(['shots', 'results.json']);
    return { ok, detail: `fresh ${j(fresh)}, quiet ${j(quiet)}` };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

check('reaping reports what it freed, and a dry run reports the same and removes nothing', () => {
  const f = runsFixture();
  try {
    const dry = reapRuns(f.root, { keepDays: 3, dryRun: true });
    const untouched = parts(f.done).length === 6 && parts(f.doneOld).length === 6;
    const real = reapRuns(f.root, { keepDays: 3 });
    const ok = untouched && dry.bytes === real.bytes && dry.folders === real.folders && real.bytes > 0;
    return { ok, detail: `dry ${dry.folders} folders / ${dry.bytes} bytes, real ${real.folders} / ${real.bytes}, untouched after dry run? ${untouched}` };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

check('a stray file beside the run folders is not a run and does not stop the tidying', () => {
  const f = runsFixture();
  try {
    writeFileSync(join(f.root, 'notes.txt'), 'not a run');
    const r = reapRuns(f.root, { keepDays: 3 });
    const ok = r.folders > 0 && existsSync(join(f.root, 'notes.txt')) && !r.kept.some((k) => k.name === 'notes.txt');
    return { ok, detail: `${r.folders} folders tidied; the file is ${existsSync(join(f.root, 'notes.txt')) ? 'still there' : 'gone'}` };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

/*
 * A gate step can be green and have measured nothing, which is the one failure that has turned
 * up in four different files this week. The runner reads it out of a step's output, so the
 * reading is checked here rather than by running the gates, which take ten minutes and cannot
 * be made to report zero on demand.
 */

check('a count of zero is a failure rather than a pass', () => {
  const zero = readVerdict('bundling host\n0/0 host checks passed\n');
  const real = readVerdict('bundling host\n217/217 host checks passed\n');
  return {
    ok: complaintFor('Tests', zero) !== null && complaintFor('Tests', real) === null,
    detail: `zero ${j(complaintFor('Tests', zero)?.split('\n')[0] ?? null)}; real ${j(complaintFor('Tests', real))}`,
  };
});

check('a measurement written as prose is read the same way as a count', () => {
  const zero = readVerdict('0 cells, 0 checks, 0 of them failing across 0 classes.\n');
  const real = readVerdict('17523 cells, 55698 checks, 288 of them failing across 150 classes.\n');
  return {
    ok: complaintFor('Editing matrix', zero) !== null && complaintFor('Editing matrix', real) === null,
    detail: `zero ${j(zero.emptyCounts)}; real ${j(real.emptyCounts)}`,
  };
});

check('a skip is collected rather than failed, so it is reported with the others at the end', () => {
  const v = readVerdict('skipped: no Chrome on this machine\n');
  return {
    ok: v.skipped.length === 1 && v.skipped[0] === 'no Chrome on this machine' && complaintFor('Touch layout', v) === null,
    detail: `${j(v)}`,
  };
});

check('a step that prints nothing is not failed, because the type check prints nothing when it passes', () => {
  /*
   * The narrowing that a measurement forced. "Every step prints something" was written here
   * first as a claim, and reading one real green log found `tsc --noEmit` immediately. An
   * exemption for it would have been the first entry in a list that eventually excuses
   * everything, so the rule is narrower instead.
   */
  const v = readVerdict('');
  return { ok: complaintFor('Type check', v) === null, detail: `${j(complaintFor('Type check', v))}` };
});

let pass = 0;
for (const c of cases) {
  let ok = false;
  let detail = '';
  try {
    const result = await c.run();
    if (result && typeof result === 'object') {
      ok = result.ok === true;
      if (result.detail) detail = ` ${result.detail}`;
    } else {
      ok = result === true;
    }
  } catch (e) {
    detail = ` threw: ${e && e.message ? e.message : String(e)}`;
  }
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${c.name}${ok ? '' : detail}`);
}
console.log(`\n${pass}/${cases.length} harness checks passed`);
process.exit(pass === cases.length ? 0 : 1);
