/*
 * Throwing away the disposable nine tenths of a finished run.
 *
 * Every run folder holds a whole VS Code profile, a copy of the sample workspace, the
 * screenshots and `results.json`. Nothing removed any of it, and because every session
 * writes into one shared directory, nobody owned the pile either: measured on 2026-09-26
 * it was 5.8 GB across 260 folders, and the only direction that number went was up.
 *
 * Measured across those 260 folders, which is what decides the rule below:
 *
 *   user/          4.8 GB    a VS Code profile. Nobody has ever read one.
 *   ws/            982 MB    the documents the run drove. Evidence, when one fails.
 *   shots/          35 MB    the pictures. The first thing a person opens.
 *   ext/           1.0 MB    the built extension, rebuilt by every run anyway.
 *   results.json   1.7 MB    the whole durable point of a run.
 *
 * So there are two ages rather than one. `user/` and `ext/` go as soon as the run is not
 * live, because they are never what anybody comes back for; `ws/` waits, because the state
 * a document was left in is exactly what a person wants after reading a failure. That
 * takes 83% off immediately without losing a thing, and the rest a few days later.
 *
 * `results.json`, `run.json` and `shots/` are never touched. A run whose folder is only
 * those is about 140 KB, so keeping every result for ever costs nothing worth counting.
 *
 * What it will not touch, which matters because these folders belong to sessions this
 * process knows nothing about:
 *
 *   - any run whose pid is still alive, which is the one that is driving the screen now;
 *   - a folder with no readable `run.json` and anything written in it within `keepDays`,
 *     since there is no pid to ask and a run being driven writes the whole time;
 *   - any run that never wrote `complete: true`, until it is older than `keepDays`, since
 *     a run that died halfway is the one somebody is most likely to be looking into.
 */

import { readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive } from './screenLock.mjs';

/**
 * Bytes under `path`, and the most recent moment anything in it was written.
 *
 * Both come from one walk because both are needed about the same folder: the size is for
 * saying how much went, and the newest write is the only liveness test available for a
 * folder with no `run.json` to name a pid. A directory's own mtime will not do, since a
 * write deep inside a profile does not touch it.
 */
function scan(path) {
  let bytesSeen = 0;
  let newest = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e));
    } else bytesSeen += st.size;
  };
  walk(path);
  return { bytes: bytesSeen, newest };
}

/** A run folder's `run.json`, or null when there is none to read. */
function runInfo(dir) {
  try {
    const held = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    return typeof held === 'object' && held ? held : null;
  } catch {
    return null;
  }
}

/**
 * Remove the disposable parts of every finished run under `runsRoot`.
 *
 * Returns `{ folders, bytes, kept }`: how many folders were touched, how much went, and
 * why each untouched one was left, which is what makes a surprising result readable.
 * `dryRun` reports without removing, which is how the checks read the decision.
 */
export function reapRuns(runsRoot, { keepDays = 3, now = Date.now(), dryRun = false } = {}) {
  const out = { folders: 0, bytes: 0, kept: [] };
  let entries;
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    // No runs directory yet, which is the first run on a machine.
    return out;
  }
  const keepMs = keepDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsRoot, entry.name);
    const info = runInfo(dir);
    let old;
    if (info) {
      if (pidAlive(info.pid)) {
        out.kept.push({ name: entry.name, why: `pid ${info.pid} is still running` });
        continue;
      }
      const age = now - new Date(info.startedAt ?? 0).getTime();
      old = Number.isFinite(age) && age > keepMs;
      if (info.complete !== true && !old) {
        out.kept.push({ name: entry.name, why: 'it never finished, and is recent enough to be worth reading' });
        continue;
      }
    } else {
      // Folders from before `run.json` existed, and a run that died before its first stamp.
      // There is no pid to ask, so the test is that nothing in the folder has been written
      // for the whole retention: a run being driven writes screenshots, results and a
      // profile the entire time, so a folder this quiet has nobody in it. 1.5 GB of the
      // pile was in these, and a rule that needed `run.json` could never reach it.
      const quiet = now - scan(dir).newest > keepMs;
      if (!quiet) {
        out.kept.push({ name: entry.name, why: 'no run.json, and written to recently enough that something may be using it' });
        continue;
      }
      old = true;
    }
    const doomed = ['user', 'ext', ...(old ? ['ws'] : [])].map((n) => join(dir, n)).filter((p) => existsSync(p));
    if (!doomed.length) continue;
    for (const path of doomed) {
      out.bytes += scan(path).bytes;
      if (!dryRun) rmSync(path, { recursive: true, force: true });
    }
    out.folders++;
  }
  return out;
}

/** `1.4 GB`, for one line of output rather than a number nobody can read. */
export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Reap, and say so in one line, or say nothing when there was nothing to do.
 *
 * Quiet on a normal run is the point: a line every time would be noise above the results,
 * and the number only matters when it is large.
 */
export function reapQuietly(runsRoot, opts = {}) {
  let r;
  try {
    r = reapRuns(runsRoot, opts);
  } catch (e) {
    // Retention is housekeeping. A run must not fail because it could not tidy up.
    (opts.log ?? console.error)(`Could not tidy old run folders: ${e?.message ?? e}`);
    return null;
  }
  if (r.folders) (opts.log ?? console.error)(`Tidied ${r.folders} finished run folder${r.folders === 1 ? '' : 's'}, freeing ${bytes(r.bytes)}. Results and screenshots are kept.`);
  return r;
}
