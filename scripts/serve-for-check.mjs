/*
 * The local server, started for a check that drives a browser at it.
 *
 * Three checks need one: `check-touch.mjs`, `check-paging.mjs` and `check-caret.mjs` each
 * ask a question about drawn pixels, which only a real browser over a real server can
 * answer. They had a copy of this each, the copies drifted, and both of the bugs they have
 * had were in all three at once. So there is one.
 *
 * **The port is never assumed, and there is nothing to assume.** A port that answers is not
 * proof it is this server: a leftover from an earlier run, or another session's, serving a
 * different folder, answers exactly the same. Sheaf's server moves up a port at a time when
 * the one it is asked for is taken, by design, so a check that wrote a port into itself
 * could have its own server bind elsewhere while its wait was satisfied by the stranger.
 * That happened both ways round on one afternoon: seven caret cases reported "the line was
 * not drawn" against correct code, and a paging run died on `ERR_CONNECTION_REFUSED` when
 * the stranger went away between the wait and the page load. The same accident produces a
 * pass on someone else's build just as easily, and that is the outcome worth the change.
 *
 * `--port 0` asks the operating system for a free port, which cannot collide with anything,
 * and the port is read out of the line the server prints about itself. The server is the
 * only thing that knows which port it got, so it is the only thing asked. Nothing is said
 * about which port that is: no port was requested, so there is no surprise to report.
 *
 * The wait ends on an answer rather than on a clock, which is what it was changed to do
 * when a fixed four-second wait let a server that never started read as a layout fault.
 * `SIGKILL` on the way out, because a leftover that caused one of these had survived a
 * plain `kill()`.
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * How long the server gets to answer before this gives up and says so.
 *
 * Generous, because a cold start on a loaded machine is slow and a needless failure here
 * costs a whole gate run. It is a ceiling rather than a wait: the normal case ends as soon
 * as the server answers, which is well under a second.
 */
const START_MS = 20_000;

/*
 * The bundle these checks measure is built by somebody else, and none of them could tell
 * whether the bytes they served were the bytes their sources say. So a control run against
 * a stale bundle **passed**, which reads as the check being unable to catch the defect it
 * was written for rather than as a run that measured nothing.
 *
 * Measured: the indent check read `moved 0.00px` against a bundle five minutes older than
 * the edit under test, and `moved -96.00px` after a build, from identical sources.
 *
 * This refuses rather than building. Two esbuild runs over one checkout make the test run
 * print no counts and the build end in a stack trace, so a check that builds is a check
 * that collides with whatever else is building. And it refuses rather than warning: a
 * notice above a green result is the thing nobody reads.
 *
 * `git checkout` sets a file's time to now, so restoring a control's edit makes the sources
 * newer than the bundle and this will ask for a build. That is correct: the bundle really is
 * the broken one until it is rebuilt.
 */
const SERVES = [
  { built: ['media', 'webview.js'], from: [['src', 'webview'], ['media', 'webview.css']] },
  { built: ['dist', 'serve.js'], from: [['src', 'server']] },
];

/** Every file under `dir`, or just `dir` when it is a file; missing paths contribute nothing. */
function filesUnder(dir) {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [{ path: dir, at: stat.mtimeMs }];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath ?? e.path, e.name);
        return { path, at: statSync(path).mtimeMs };
      });
  } catch {
    return [];
  }
}

function refuseStaleBundle(repo, whenAbsent) {
  const tail = whenAbsent ? `\n${whenAbsent}` : '';
  for (const { built, from } of SERVES) {
    const target = join(repo, ...built);
    let at;
    try {
      at = statSync(target).mtimeMs;
    } catch {
      console.log(`${built.join('/')} is not built, so there is nothing to serve. Run npm run build.${tail}`);
      process.exit(1);
    }
    const newer = from
      .flatMap((parts) => filesUnder(join(repo, ...parts)))
      .filter((f) => f.at > at)
      .sort((a, b) => b.at - a.at);
    if (newer.length) {
      const names = newer.slice(0, 3).map((f) => f.path.slice(repo.length + 1));
      console.log(
        `${built.join('/')} is older than ${newer.length} of the sources it is built from, ` +
          `${names.join(', ')}${newer.length > 3 ? ' and others' : ''}.\n` +
          'Serving it would measure bytes from before those edits, and a control run that way ' +
          'passes and reads as the check being unable to catch anything. Run npm run build.\n' +
          'This reads modification times, not content, so a git checkout, a branch switch or a ' +
          'rebase that leaves a file byte-identical still trips it. Rebuilding is the answer ' +
          'either way and costs seconds; nothing is wrong with the source.' +
          tail
      );
      process.exit(1);
    }
  }
}

/**
 * Starts the server on `root` and returns it with the address it took.
 *
 * `repo` is the checkout to run `dist/serve.js` from, and the directory a relative `root`
 * is read against. `whenAbsent` is a sentence about what the check cannot do without a
 * server, printed after the reason it has none.
 *
 * Exits the process, having said why, when there is no server to return.
 */
export async function serveForCheck({ repo, root, whenAbsent = '' }) {
  refuseStaleBundle(repo, whenAbsent);
  const server = spawn(process.execPath, [join(repo, 'dist', 'serve.js'), root, '--port', '0', '--no-open'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', (b) => (said += b));
  server.stderr.on('data', (b) => (said += b));
  let exited = null;
  server.on('exit', (code, signal) => (exited = signal ? `killed by ${signal}` : `exited with ${code}`));

  const tail = whenAbsent ? `\n${whenAbsent}` : '';
  const until = Date.now() + START_MS;
  for (;;) {
    if (exited) {
      console.log(`the local server ${exited} before it answered${said ? `, saying:\n${said.trim()}` : ', saying nothing'}${tail}`);
      process.exit(1);
    }
    /*
     * The line the server prints about itself, which is the only place its port appears.
     * It writes the host as `localhost` and only the port is read out of it: the address is
     * built on `127.0.0.1`, because a name resolving to the IPv6 loopback while the server
     * listens on the IPv4 one is a refused connection with nothing said about why. The
     * whole accumulated output is searched rather than each chunk, so a port split across
     * two reads still matches.
     */
    const found = /(?:localhost|127\.0\.0\.1):(\d+)\//.exec(said);
    if (found) {
      const base = `http://127.0.0.1:${found[1]}`;
      try {
        // Any answer at all means it is listening; a 404 is as good as a 200 here.
        await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
        return { server, base };
      } catch {
        /* it has said where it is and is not answering there yet, so keep waiting */
      }
    }
    if (Date.now() > until) {
      server.kill('SIGKILL');
      console.log(
        `the local server did not answer within ${Math.round(START_MS / 1000)}s` +
          `${said ? `, saying:\n${said.trim()}` : ', and printed nothing'}${tail}`
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
