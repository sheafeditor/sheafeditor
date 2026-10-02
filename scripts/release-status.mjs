/*
 * What the public repository's workflows have done lately, and where a failed one stopped.
 *
 *   npm run release:status                       the last few runs
 *   npm run release:status -- --watch            poll until the newest run finishes
 *   npm run release:status -- --watch --for=release.yml --sha=<sha>
 *                                                poll until *that* workflow's run on that
 *                                                commit finishes, waiting for it to appear
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
 *
 * ## Why `--for` and `--sha` exist
 *
 * `--watch` used to take the newest run of any workflow. A tag push starts the Release run,
 * and pushing the branch alongside it starts CI, so the newest run at that moment was
 * routinely CI on `main`. The end of a cut then watched CI, printed CI's verdict, and called
 * it the release's. That is a wrong answer rather than a slow one, and at the one moment
 * somebody is deciding whether a release went out.
 *
 * Naming the workflow and the commit also fixes what the old behaviour was working around.
 * A run does not exist the instant a tag is pushed; GitHub takes a few seconds to create it.
 * Taking the newest run meant never having to wait for the right one to appear, at the cost
 * of watching the wrong one. This waits instead, and says that it is waiting.
 */

import { token } from './lib/github.mjs';

const WATCH = process.argv.includes('--watch');
/** Which workflow to watch, and on which commit. Both optional; see the note above. */
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FOR = arg('for');
const SHA = arg('sha');
/*
 * Which repository, because there are two and they run different workflows.
 *
 * The public one is the default and is what a release is watched on. CI on the development
 * branch runs on the private one, so reading a CI result means naming it, and without this the
 * reader silently answered about the wrong repository: asked for a CI run on a commit that only
 * exists on `sheaf-dev`, it listed the public repository's runs and said "No workflow runs",
 * which reads as CI not having started rather than as having looked in the wrong place.
 *
 * `--repo=owner/name` says it outright. The private one needs a token, since nothing about it
 * is public, and a 404 from the API is what a token without access to it looks like.
 */
const REPO = arg('repo') ?? 'sheafeditor/sheafeditor';
const API = `https://api.github.com/repos/${REPO}`;
/** Twenty seconds: a release run takes two to three minutes, so this is a dozen or so asks. */
const EVERY_MS = 20_000;
/** How long to wait for a named run to appear before giving up on it existing. */
const APPEAR_MS = 3 * 60 * 1000;

const say = (line) => process.stdout.write(`${line}\n`);
/** Elapsed, so a line that repeats still carries something that changed. */
const since = (t0) => {
  const s = Math.round((Date.now() - t0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/*
 * A read-only token, if there is one, for the single thing a public repository does not
 * serve: the log text of a step. Everything else here works without one and keeps working
 * without one, which is the point: a missing token costs the log and nothing else.
 *
 * The lookup itself is in `lib/github.mjs`, because the release command needs the same one.
 */
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
if (!runs?.length && !WATCH) {
  say('No workflow runs.');
  process.exit(0);
}

say(`${REPO}\n`);
for (const run of runs ?? []) say(`  ${line(run)}`);

/**
 * The run this is about: the one `--for` and `--sha` name, or the newest when they say nothing.
 *
 * Asked of the named workflow's own endpoint rather than filtered out of the general list,
 * because the general list is five runs deep and the run being waited for can be pushed off
 * it by anything else that starts.
 */
async function subject() {
  if (!FOR) return runs?.[0];
  const q = SHA ? `?head_sha=${SHA}&per_page=5` : '?per_page=5';
  const { workflow_runs: mine } = await get(`/actions/workflows/${FOR}/runs${q}`);
  return mine?.[0];
}

let watched = await subject();

/*
 * Wait for it to appear, when it was named and is not there yet.
 *
 * A tag push does not create its run instantly, so the seconds after a cut are exactly when
 * this is asked and exactly when the answer is "no such run". Silence here reads as a release
 * that never started, so it says what it is waiting for and how long it has been waiting.
 */
if (WATCH && FOR && !watched) {
  const began = Date.now();
  say(`\nWaiting for ${FOR}${SHA ? ` on ${SHA.slice(0, 7)}` : ''} to appear.`);
  while (!watched) {
    if (Date.now() - began > APPEAR_MS) {
      say(`  no run of ${FOR}${SHA ? ` on ${SHA.slice(0, 7)}` : ''} after ${since(began)}. It may not have been triggered.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, EVERY_MS));
    say(`  still no run, ${since(began)} so far`);
    watched = await subject();
  }
}

if (!watched) {
  say('No workflow runs.');
  process.exit(0);
}

if (watched.status === 'completed' && watched.conclusion !== 'success') await whereItStopped(watched);

if (!WATCH || watched.status === 'completed') process.exit(0);

/*
 * One line per change of state, plus elapsed, rather than one line per poll.
 *
 * It used to print the status every twenty seconds, so watching a three-minute run produced
 * a column of twenty identical `in_progress` lines that said nothing and hid the one line
 * that mattered. What a person watching wants to know is what is being watched, that it is
 * still going, and how long it has been going, so that is what each line carries.
 */
const began = Date.now();
say(`\nWatching ${watched.name} on ${watched.head_sha.slice(0, 7)}, asking every ${EVERY_MS / 1000}s.`);
say(`  ${watched.html_url}`);
let was = watched.status;
for (;;) {
  await new Promise((r) => setTimeout(r, EVERY_MS));
  const run = await get(`/actions/runs/${watched.id}`);
  if (run.status !== 'completed') {
    if (run.status !== was) say(`  ${run.status}, ${since(began)} in`);
    was = run.status;
    continue;
  }
  say(`\n${run.name} on ${run.head_sha.slice(0, 7)}: ${run.conclusion} after ${since(began)}`);
  if (run.conclusion !== 'success') await whereItStopped(run);
  process.exit(run.conclusion === 'success' ? 0 : 1);
}
