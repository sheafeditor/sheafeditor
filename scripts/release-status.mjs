/*
 * What the public repository's workflows have done lately, and where a failed one stopped.
 *
 *   npm run release:status            the last few runs
 *   npm run release:status -- --watch poll until the newest run finishes
 *
 * No credentials, and that is the point rather than a limitation. `sheafeditor/sheafeditor`
 * is public, so GitHub serves its workflow runs and every job's step list to anyone who
 * asks. A token would buy one more thing, the raw log text of a step, and cost a stored
 * secret; the step list already says which step failed, which is the question anybody asks
 * first and usually last.
 *
 * It exists because a release failed and the only way to see that was a person opening the
 * Actions tab and describing it. The failure was `Gates`, on a tag, with everything after it
 * skipped, and that is exactly what this prints.
 *
 * Unauthenticated requests are rate limited per address, around sixty an hour. `--watch`
 * polls every twenty seconds, which is three an minute of a run that takes two or three, so
 * a couple of watched releases in an hour is fine and a loop left running all day is not.
 */

const REPO = 'sheafeditor/sheafeditor';
const API = `https://api.github.com/repos/${REPO}`;
const WATCH = process.argv.includes('--watch');
/** Twenty seconds: a release run takes two to three minutes, so this is a dozen or so asks. */
const EVERY_MS = 20_000;

const say = (line) => process.stdout.write(`${line}\n`);

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
  /*
   * The step list says which step, never why. The log text of a step is the one thing a
   * public repository does not serve without a token, so it is named as the next place to
   * look rather than left as a gap the reader has to notice.
   */
  say('  The step list says which step. Its log text needs the Actions tab, or a token.');
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
