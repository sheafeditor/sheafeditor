/*
 * One real-editor run at a time, by waiting rather than refusing.
 *
 * A run drives a real VS Code window, so it owns the pointer and the keyboard focus for
 * as long as it lasts. Two at once fight over both and produce failures that belong to
 * neither piece of work, and the cost is not the wasted run: it is the time someone then
 * spends believing those failures are the product's.
 *
 * Refusing was the first answer, and it is the wrong one for anything unattended. A run
 * that is told to come back later has to be started again by whoever asked for it, and
 * meanwhile the screen may well have gone free. Waiting needs nobody.
 *
 * The lock is a file created with `wx`, which fails if it already exists, and that is
 * what makes taking it atomic: two runs starting in the same millisecond cannot both
 * succeed. It holds who has it, so the waiting line can say what it is waiting for, and
 * a pid, so a lock left behind by a run that was killed can be told from a live one.
 *
 * A pid answers "is it alive" and nothing else, and three separate costs came from the two
 * questions it cannot answer. So the lock also records **where the holder writes**, which is
 * how a waiter tells a holder that is working from one that is alive and wedged, and there is
 * a directory of waiters beside it, which is how the holder tells a sibling queued behind it
 * from a run that cannot take the lock at all. Neither is a new mechanism: both are facts the
 * runs already had and were not writing down.
 *
 * What it does not yet cover: another project on this machine driving a headed browser of
 * its own. The screen is the machine's, so the lock is at a machine path under a name with
 * no project in it, and a run from anywhere that takes the pointer should take this file.
 * Getting the other projects to do that means lifting this module somewhere they can all
 * import it, which is a change to more than one repository and is not made here.
 */

import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Where the lock lives: one file per account, at a path nothing in the environment moves.
 *
 * It used to sit beside the run folders, under `SHEAF_EDITOR_RUNS`. That variable is set
 * per session, so two runs that set it differently took two different locks and neither
 * could see the other's. Mutual exclusion survived, because `otherRunners()` finds the
 * other process anyway, but the run then queued on the process list and lost the line
 * saying who held the screen and what they were running.
 *
 * So the path is derived from the home directory and from nothing else. The name has no
 * `sheaf` in it on purpose: the screen belongs to the machine rather than to this project,
 * and any other run here that takes the pointer should take this same file.
 *
 * `SHEAF_SCREEN_LOCK` moves it, which is for the checks in `test/harness.test.mjs`: they
 * take and break real locks, and must not touch the one a live run is holding.
 */
export function lockPath() {
  return process.env.SHEAF_SCREEN_LOCK || join(homedir(), '.local', 'state', 'agent-screen.lock');
}

/**
 * Where runs queued on the lock say so: one file per waiter, named for its pid.
 *
 * The lock answers "who has the screen" and nothing else, and that turned out to be one
 * fact short. A run that cannot take the lock is queued and will drive in its turn, so it
 * is not something to wait for; a run from a checkout too old to know about the lock is.
 * Both look identical in the process list, so the holder waited the full bound for its own
 * siblings and the screen sat idle for four minutes at every handover.
 *
 * A directory of one file per pid rather than a list inside the lock, because a list would
 * need every waiter to rewrite a file the holder also writes, and `wx` only makes a single
 * create atomic. Creating and removing one's own file races with nobody.
 */
export function waitersDir(path = lockPath()) {
  return `${path}.waiters`;
}

/**
 * Say that this run is queued on the lock, and return the way to stop saying it.
 *
 * Registered on `exit` by `holdScreen` as well, because a waiter killed while queueing
 * would otherwise be counted as queued for ever, which is the same shape of stale record
 * the lock's own takeover rule exists to clear.
 */
export function registerWaiter(info, path = lockPath()) {
  const dir = waitersDir(path);
  const file = join(dir, String(info.pid ?? process.pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(info));
  } catch {
    // A waiter that cannot register is only as bad as the behaviour before this existed.
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone, which is the outcome either way.
    }
  };
}

/**
 * The pids this lock has heard of: whoever holds it, and everyone queued on it.
 *
 * Entries whose process is gone are removed as they are read, so a killed waiter clears
 * itself the next time anybody looks rather than needing a sweep of its own.
 */
export function knownPids(path = lockPath()) {
  const known = new Set();
  const held = readLock(path);
  if (held && Number.isInteger(held.pid)) known.add(held.pid);
  let entries = [];
  try {
    entries = readdirSync(waitersDir(path));
  } catch {
    return known;
  }
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (pidAlive(pid)) {
      known.add(pid);
      continue;
    }
    try {
      unlinkSync(join(waitersDir(path), name));
    } catch {
      // Somebody else cleared it first.
    }
  }
  return known;
}

/** Whether a pid is a live process. Signal 0 tests for it without sending anything. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return e.code === 'EPERM';
  }
}

/** What a lock file says, or null when it is missing or unreadable. */
export function readLock(path) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    return typeof held === 'object' && held ? held : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock, or say who holds it.
 *
 * Returns `{ held: true }` on success, or `{ held: false, by }` when somebody else has
 * it. A lock whose pid is dead is stale: it is removed and the attempt is made again,
 * once, so a run killed with Ctrl-C does not block the screen until somebody notices.
 */
export function tryTake(path, info, { onStale } = {}) {
  const attempt = () => {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return { held: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return null;
    }
  };
  mkdirSync(path.slice(0, path.lastIndexOf('/')) || '.', { recursive: true });
  const first = attempt();
  if (first) return first;
  const by = readLock(path);
  // An unreadable lock is treated as stale: a run that crashed between creating the file
  // and writing to it would otherwise hold the screen for ever.
  if (by && pidAlive(by.pid)) return { held: false, by };
  onStale?.(by);
  try {
    unlinkSync(path);
  } catch {
    // Somebody else cleared it first, which is the outcome either way.
  }
  const second = attempt();
  return second ?? { held: false, by: readLock(path) };
}

/** How long ago `started` was, in words, for the waiting line. */
export function ago(started, now = Date.now()) {
  const ms = now - new Date(started).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  return `${mins} min ago`;
}

/** The line printed once while waiting, so it is clear what is being waited for. */
export function waitingLine(by) {
  if (!by) return 'Waiting for another real-editor run to release the screen.';
  const name = by.name ?? '?';
  const area = by.area ? ` (${by.area})` : '';
  const from = by.cwd ? ` from ${by.cwd}` : '';
  return `Waiting for the real-editor run "${name}"${area}, started ${ago(by.started)}${from}.`;
}

/**
 * Wait until the screen is free, then hold it until the process exits.
 *
 * `wait: false` gives up instead, which is what a run that would rather fail than queue
 * asks for. The release is registered on `exit` and on both interrupt signals, because a
 * lock a Ctrl-C left behind is the case that makes a person distrust the whole mechanism.
 */
export async function holdScreen({ name, area, runDir, wait = true, pollMs = 3000, log = console.error } = {}) {
  const path = lockPath();
  // `runDir` is where this run will write, recorded so a waiter can tell a holder that is
  // working from one that is wedged without asking its process anything.
  const info = { pid: process.pid, name, area, runDir, started: new Date().toISOString(), cwd: process.cwd() };
  let said = false;
  let toldWedged = false;
  // Registered while queueing and removed the moment the lock is taken, so the holder can
  // subtract everyone who is merely in the queue from the runs it waits for.
  let unregister = null;
  const stopWaiting = () => {
    unregister?.();
    unregister = null;
  };
  process.on('exit', stopWaiting);
  try {
    for (;;) {
      const got = tryTake(path, info, {
        onStale: (by) => log(`Taking over a lock left behind by ${by?.name ?? 'a run'} (pid ${by?.pid ?? '?'}), which is gone.`),
      });
      if (got.held) break;
      if (!wait) {
        log(waitingLine(got.by));
        log('Refusing rather than queueing, because --no-wait was given.');
        return null;
      }
      if (!said) {
        log(waitingLine(got.by));
        said = true;
      }
      if (!unregister) unregister = registerWaiter(info, path);
      /*
       * Say it once when the holder stops looking like it is working. Reporting rather than
       * seizing, deliberately: a run genuinely slow at one scenario is not a wedged one, and
       * taking the screen off a live run interrupts real work. What was missing was anybody
       * saying anything at all, which is why a queue read as slow work twice in one day.
       */
      if (!toldWedged) {
        const { wedged, why } = holderProgress(got.by);
        if (wedged) {
          toldWedged = true;
          log(
            `The run holding the screen looks wedged rather than busy: "${got.by?.name ?? '?'}" (pid ${got.by?.pid ?? '?'}), ${why}. ` +
              `Still waiting, because a slow run and a wedged one are not worth guessing between; stop it yourself if it is stuck.`
          );
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    stopWaiting();
  }
  if (said) log('The screen is free; starting.');

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only our own lock: a stale-lock takeover elsewhere may have replaced it, and
    // removing somebody else's is how one run interrupts another.
    const held = readLock(path);
    if (held?.pid === process.pid) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}

/**
 * A run from a checkout that does not know about the lock yet.
 *
 * The lock only holds between runs that take it, and a worktree or an older checkout can
 * be running the version that had no lock at all. So a live `run-editor.mjs` that holds
 * no lock is still waited for, by the process list, which is what the refusal this
 * replaced was built on.
 */
export function otherRunners() {
  const mine = new Set();
  for (let pid = process.pid; pid > 1 && !mine.has(pid); ) {
    mine.add(pid);
    try {
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    } catch {
      break;
    }
  }
  // What a process is, from its executable rather than its command line: a shell running
  // `node run-editor.mjs | grep …` forks a child per pipe stage, and each inherits a
  // command line naming this file. Those are siblings of this run, not rivals.
  const isNode = (pid) => {
    try {
      return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split('/').pop() === 'node';
    } catch {
      return false;
    }
  };
  try {
    // The bracket keeps a command that merely names this search from matching itself.
    return execFileSync('pgrep', ['-fl', 'run-editor[.]mjs'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => {
        const pid = Number(line.split(' ')[0]);
        return line && !mine.has(pid) && isNode(pid);
      });
  } catch {
    // pgrep exits non-zero when nothing matches, which is the clear case.
    return [];
  }
}

/**
 * The runs on the screen that this lock has never heard of, which are the only ones worth
 * waiting for.
 *
 * `otherRunners()` answers "what else is running", and every run queued on the lock is in
 * that answer. Subtracting the holder and the registered waiters leaves the case the wait
 * was written for: a checkout too old to take a lock, one keeping it somewhere this build
 * no longer looks, or an orphan from a killed shell.
 *
 * It stays a separate function rather than a filter inside `otherRunners()`, because the
 * unfiltered question is still the right one for a check that wants to know whether a
 * process exists at all.
 */
export function locklessRunners(path = lockPath()) {
  const known = knownPids(path);
  return otherRunners().filter((line) => !known.has(Number(line.split(' ')[0])));
}

/**
 * How long a holder may write nothing before it is worth saying it looks wedged.
 *
 * A run stamps `run.json` before its first scenario and again after every one, and an area
 * of four scenarios takes about nineteen seconds, so scenarios are seconds rather than
 * minutes. Five minutes of silence is therefore not a slow scenario. It is generous on
 * purpose: the cost of saying it early is a false alarm about somebody else's work, and
 * this only ever reports.
 */
export const WEDGED_AFTER_MS = 5 * 60_000;

/**
 * Whether the run holding the lock still looks like it is working, by reading its own
 * folder rather than asking its process anything.
 *
 * `pidAlive` was the only liveness test there was, and a wedged run is alive. So the
 * takeover never fired, the waiters waited, and three sessions read a queue as somebody
 * else's slow work for half an hour. A run writes into its own folder the whole time it
 * drives, which is the reading the scheduled window-suite tasks already use to tell a
 * deadlock from a queue.
 *
 * Returns `{ wedged, why }`. Two shapes count, and the second is the one actually seen: a
 * holder whose `run.json` has not moved, and a holder that never created its folder at all,
 * which is what a run that took the lock and then hung before starting looks like.
 */
export function holderProgress(by, now = Date.now()) {
  if (!by?.runDir) return { wedged: false, why: 'the holder does not say where it writes' };
  const held = new Date(by.started).getTime();
  const quietFor = (since) => now - since;
  let last;
  try {
    last = statSync(join(by.runDir, 'run.json')).mtimeMs;
  } catch {
    // No run.json: either it has not started one yet, or it never will.
    const waiting = Number.isFinite(held) ? quietFor(held) : 0;
    if (waiting < WEDGED_AFTER_MS) return { wedged: false, why: 'the holder has not written its first scenario yet' };
    return {
      wedged: true,
      why: `it took the screen ${ago(by.started, now)} and has still not created a run folder at ${by.runDir}`,
    };
  }
  const quiet = quietFor(last);
  if (quiet < WEDGED_AFTER_MS) return { wedged: false, why: `last wrote ${Math.round(quiet / 1000)}s ago` };
  return { wedged: true, why: `it last wrote to ${by.runDir} ${ago(new Date(last).toISOString(), now)}` };
}

export { existsSync };
