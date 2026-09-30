/*
 * What the public repository's workflows have done lately, and where a failed one stopped.
 *
 *   npm run release:status            the last few runs
 *   npm run release:status -- --watch poll until the newest run finishes
 *
 * Runs and step lists need no credentials, because `sheafeditor/sheafeditor` is public and
 * GitHub serves both to anyone who asks. Log text is the one thing it does not, and knowing
 * which step failed turned out not to be enough: a release failed three times at the same
 * step for three different reasons, and each one cost a round trip to a person reading the
 * Actions tab. So a read-only token is used for that one request when there is one, and
 * everything else works exactly the same without it.
 *
 * It exists because a release failed and the only way to see that was a person opening the
 * Actions tab and describing it. The failure was `Gates`, on a tag, with everything after it
 * skipped, and that is exactly what this prints.
 *
 * Unauthenticated requests are rate limited per address, around sixty an hour. `--watch`
 * polls every twenty seconds, which is three an minute of a run that takes two or three, so
 * a couple of watched releases in an hour is fine and a loop left running all day is not.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'sheafeditor/sheafeditor';
const API = `https://api.github.com/repos/${REPO}`;
const WATCH = process.argv.includes('--watch');
/** Twenty seconds: a release run takes two to three minutes, so this is a dozen or so asks. */
const EVERY_MS = 20_000;

const say = (line) => process.stdout.write(`${line}\n`);

/*
 * A read-only token, if there is one, for the single thing a public repository does not
 * serve: the log text of a step.
 *
 * Everything else here works without one and keeps working without one, which is the point:
 * a missing token costs the log and nothing else. Read from the login keychain rather than a
 * file, so it is never plain text on disk and never in a shell's history, and from `GH_TOKEN`
 * first for a runner or a one-off.
 *
 * It is never printed, never written anywhere, and never passed to a subprocess. The only
 * thing it is used for is an Authorization header on api.github.com.
 */
function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  // A file outside every repository, readable only by its owner. Tried before the keychain
  // because it works without one and needs no `security` invocation.
  try {
    const t = readFileSync(join(process.env.HOME ?? '', '.config', 'sheaf', 'actions-token'), 'utf8').trim();
    if (t) return t;
  } catch {
    // No file: fall through to the keychain, then to no token at all.
  }
  const r = spawnSync('security', ['find-generic-password', '-a', 'sheaf', '-s', 'sheaf-actions-token', '-w'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

const TOKEN = token();

/**
 * The failing step's own output, which needs the token.
 *
 * A job's log is one plain-text stream with a line per step, so the step's name is what
 * finds its section. Only the tail is printed: the useful part of a failed check is the last
 * thing it said, and a whole job's log is tens of thousands of lines.
 */
async function logTail(jobId, stepName, lines = 40) {
  if (!TOKEN) {
    say('  The step list says which step. Its log text needs the Actions tab, or a token:');
    say('  a fine-grained token, this repository only, Actions read-only, in the login keychain');
    say('  under the service name sheaf-actions-token.');
    return;
  }
  const r = await fetch(`${API}/actions/jobs/${jobId}/logs`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) {
    say(`  The log could not be read: ${r.status} ${r.statusText}. The token may be wrong or expired.`);
    return;
  }
  const text = await r.text();
  const at = text.indexOf(stepName);
  const body = at === -1 ? text : text.slice(at);
  const tail = body.split('\n').slice(0, 4000).filter(Boolean).slice(-lines);
  say(`\n  --- ${stepName}, last ${tail.length} lines ---`);
  for (const line of tail) say(`  ${line.replace(/^\S+\s/, '')}`);
}

async function get(path) {
  const r = await fetch(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 403 || r.status === 429) {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    const mins = reset ? Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    throw new Error(`GitHub is rate limiting this address${mins === null ? '' : `; it resets in about ${mins} minute(s)`}`);
  }
  if (!r.ok) throw new Error(`${path} came back ${r.status} ${r.statusText}`);
  return r.json();
}

/** A run as one line: what it was, what it ran on, and how it went. */
const line = (run) =>
  `${(run.name ?? '').slice(0, 20).padEnd(22)}${(run.head_branch ?? '').slice(0, 14).padEnd(16)}` +
  `${run.head_sha.slice(0, 7)}  ${run.status === 'completed' ? (run.conclusion ?? '?') : run.status}`;

/** Where a run stopped, from its jobs' steps. Public for a public repository. */
async function whereItStopped(run) {
  const { jobs } = await get(`/actions/runs/${run.id}/jobs`);
  for (const job of jobs ?? []) {
    if (job.conclusion === 'success' || job.conclusion === 'skipped') continue;
    say(`\n  ${job.name}: ${job.conclusion ?? job.status}`);
    for (const step of job.steps ?? []) {
      const state = step.conclusion ?? step.status;
      const mark = state === 'failure' || state === 'cancelled' ? '  <-- stopped here' : '';
      say(`    ${String(state).padEnd(10)} ${step.name}${mark}`);
    }
  }
  say(`\n  ${run.html_url}`);
  const failed = (jobs ?? []).find((j) => j.conclusion === 'failure');
  const step = failed?.steps?.find((s) => s.conclusion === 'failure');
  if (failed && step) await logTail(failed.id, step.name);
}

const { workflow_runs: runs } = await get('/actions/runs?per_page=5');
if (!runs?.length) {
  say('No workflow runs.');
  process.exit(0);
}

say(`${REPO}\n`);
for (const run of runs) say(`  ${line(run)}`);

const newest = runs[0];
if (newest.status === 'completed' && newest.conclusion !== 'success') await whereItStopped(newest);

if (!WATCH || newest.status === 'completed') process.exit(0);

say(`\nWatching ${newest.name} on ${newest.head_sha.slice(0, 7)}, asking every ${EVERY_MS / 1000}s.`);
for (;;) {
  await new Promise((r) => setTimeout(r, EVERY_MS));
  const run = await get(`/actions/runs/${newest.id}`);
  if (run.status !== 'completed') {
    say(`  ${run.status}`);
    continue;
  }
  say(`\n${run.name}: ${run.conclusion}`);
  if (run.conclusion !== 'success') await whereItStopped(run);
  process.exit(run.conclusion === 'success' ? 0 : 1);
}
