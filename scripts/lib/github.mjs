/*
 * What the release scripts need from GitHub's API: a read-only token, and a way to ask.
 *
 * Both the release command and the status command want the same token lookup and the same
 * rate-limit handling, and the copy that existed in one of them was about to be pasted into
 * the other. A second copy of a credential lookup is a second place for it to go wrong, and
 * the way it goes wrong is silence: a token read from the wrong place is indistinguishable
 * from no token at all, and no token is a soft outcome in both scripts.
 *
 * Nothing here ever prints a token, writes one anywhere, or passes one to a subprocess. The
 * only thing it is used for is an Authorization header on api.github.com.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A read-only token, or null.
 *
 * `GH_TOKEN` first, for a runner or a one-off. Then a file outside every repository, readable
 * only by its owner. Then the login keychain, which is where this started and where a token
 * is never plain text on disk; it stays last because the file needs no `security` call and
 * works on a machine with no keychain at all.
 */
export function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const t = readFileSync(join(process.env.HOME ?? '', '.config', 'sheaf', 'actions-token'), 'utf8').trim();
    if (t) return t;
  } catch {
    // No file: the keychain next, then no token at all.
  }
  const r = spawnSync('security', ['find-generic-password', '-a', 'sheaf', '-s', 'sheaf-actions-token', '-w'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * The `owner/name` a git remote points at, read from the remote rather than written down.
 *
 * Written down it would go stale the first time anybody renamed anything, and it would put
 * the name of a private repository into a file that ships, which is the one thing
 * `check-private-terms.mjs` exists to refuse. Handles both spellings of a GitHub URL, and an
 * ssh host alias, which is how the release key is reached.
 */
export function repoFromRemote(remote, cwd) {
  const r = spawnSync('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? m[1] : null;
}

/**
 * One API read. Throws with something a person can act on rather than a status code alone.
 *
 * Unauthenticated requests are limited per address, around sixty an hour, and hitting that
 * limit reads exactly like a permissions failure unless it is said out loud.
 */
export async function get(repo, path, auth) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers });
  if (r.status === 403 || r.status === 429) {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    const mins = reset ? Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    const limited = r.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(
      limited
        ? `GitHub is rate limiting this address${mins === null ? '' : `; it resets in about ${mins} minute(s)`}`
        : `GitHub refused ${path} with ${r.status}. The token may be wrong, expired, or not scoped to this repository.`
    );
  }
  if (!r.ok) throw new Error(`${path} came back ${r.status} ${r.statusText}`);
  return r.json();
}

/**
 * What the CI workflow made of one commit: `{ state, detail }`.
 *
 * `state` is one of `green`, `red`, `running`, `none`, `untokened` or `unreadable`. Outcomes
 * rather than a boolean, because each of them wants something different done about it: a red
 * run wants reading, a running one wants waiting, and a commit CI never saw wants pushing.
 * Collapsing them into "not green" is how a person ends up re-running something that was never
 * going to finish.
 *
 * `untokened` and `unreadable` are kept apart, and that distinction is the whole reason this
 * function has six states instead of five. Having no token is an ordinary condition: anybody
 * can run the release check, and a contributor who cannot read the private repository's runs
 * is not the person cutting a release. Having a token that then fails to read is not ordinary.
 * It means the guard has stopped guarding, on the machine where it is the only thing standing
 * between a red commit and a release, and the ways it happens are quiet ones: a token expires,
 * loses a scope, or the workflow gets renamed under it.
 *
 * Collapsed into one state, as this was when first written, an expired token would have turned
 * the gate off and printed a note. A watcher for a dark signal that goes dark itself, silently,
 * is the same bug one level up, and the caller cannot tell the two apart unless this does.
 *
 * Asked of one named workflow rather than of every run on the commit, so an unrelated manual
 * dispatch cannot speak for CI in either direction. A renamed workflow is a 404 and therefore
 * `unreadable`, which is the right answer: nothing has been read, so nothing is known.
 */
export async function ciVerdict(repo, sha, auth, workflow = 'ci.yml') {
  if (!repo) return { state: 'unreadable', detail: 'the remote does not name a GitHub repository' };
  if (!auth) return { state: 'untokened', detail: 'no read-only token on this machine' };
  let runs;
  try {
    ({ workflow_runs: runs } = await get(repo, `/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=10`, auth));
  } catch (e) {
    return { state: 'unreadable', detail: e.message };
  }
  if (!runs?.length) return { state: 'none', detail: `${workflow} has no run on ${sha.slice(0, 7)}` };
  // Newest first, which is what the API returns: a re-run is the answer, not the first attempt.
  const run = runs[0];
  const where = run.html_url;
  if (run.status !== 'completed') return { state: 'running', detail: `${run.status} — ${where}` };
  if (run.conclusion === 'success') return { state: 'green', detail: where };
  return { state: 'red', detail: `${run.conclusion} — ${where}` };
}
