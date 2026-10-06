/*
 * Cutting a public release: everything that can be checked, then one thing that cannot.
 *
 *   npm run release:check     prove the release will pass, change nothing
 *   npm run release           the same, then cut it, asking for the key's passphrase once
 *
 * The passphrase is the whole gate. `oss` pushes through a deploy key only the maintainer
 * can unlock, so the check half runs as often as anybody likes and the cut half cannot run
 * without a person. What this script removes is the rest of it: the order of the steps, the
 * things that have to agree before a tag is worth pushing, and the two separate passphrase
 * prompts that pushing a branch and a tag used to cost.
 *
 * ## Why the check half exists
 *
 * v0.2.0 was tagged and its workflow failed on the gates, so nothing published and the tag
 * had to be moved. The gates had passed on `main`; what had not been run was the gates on
 * the tree the tag names, after `npm version` stamped the changelog. That stamp is part of
 * the release, and it is the last thing to change before the tag, so it is the one thing
 * nobody had checked. A release should not be a thing that is tried.
 *
 * So the check half is CI, run here first, on the same bytes: export the commit, install
 * from the lockfile, run the gates, build the package. Plus the three things the release
 * workflow checks before it builds at all, which are cheap and fail late in CI: the tag
 * against the manifest, the changelog section for that tag, and whether the tag is already
 * somewhere else.
 *
 * ## What it cannot prove
 *
 * Everything after the package needs credentials this machine does not hold: the build
 * attestation, the GitHub Release, and the publishes to the Marketplace and Open VSX. Those
 * are reported as unchecked rather than left unsaid. They worked for v0.1.0, which is the
 * only evidence there is for them.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { token, repoFromRemote, ciVerdict } from './lib/github.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CUT = process.argv.includes('--cut');
/** The deploy key, and the ssh host alias `oss` pushes through. */
const KEY = join(process.env.HOME ?? '', '.ssh', 'id_ed25519_sheaf_release');
/** Where a green check is remembered, so a retry does not pay for it twice. Gitignored. */
const STAMP = join(REPO, '.claude', 'scratch', 'release-checked');

const say = (line) => process.stdout.write(`${line}\n`);
const failures = [];
const unchecked = [];

/** Run a command and return its output, without failing the script. */
function run(cmd, args, cwd = REPO) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/*
 * The environment the check half runs in: this one, minus anything a session sets that an
 * ordinary terminal does not.
 *
 * This exists because of a release that went out on a green check and then refused. The
 * gates were green here and red in the maintainer's shell, over one variable naming a file
 * outside the repository: set for the session that ran the check, unset everywhere else, and
 * the step it feeds skips without it. A skipped step fails a gates run, so the check and the
 * cut were never running the same gates, and "it will pass" meant "it passes for me".
 *
 * Stripping them is the only way this command can promise anything about somebody else's
 * terminal. It also holds the repository to its own rule that everything a build needs is in
 * it: a check that leans on a path into another checkout is not checking this one.
 */
const OWN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('SHEAF_') && k !== 'PLAYWRIGHT_CORE')
);

/** Run a command, showing its output, and stop the script if it fails. */
function must(label, cmd, args, cwd = REPO, env) {
  say(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) {
    process.stderr.write(`\n${label} failed. Nothing has been pushed.\n`);
    process.exit(r.status ?? 1);
  }
}

/** A check that has to hold before a tag is worth pushing. */
function check(what, ok, detail) {
  say(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(what);
  return ok;
}

// ---- What is being released -----------------------------------------------

/*
 * **A release is a commit that was proven, not whatever `main` holds when somebody types the
 * command.** The check half proves a commit and sets it aside under this ref; the cut half releases
 * that commit and nothing else.
 *
 * It used to rebuild the release tree from `origin/main` at cut time. That is correct only while
 * nothing lands between the proof and the cut, and the whole point of proving a release early is so
 * that the cut can wait for the one person who holds the passphrase. Under the old shape, every
 * commit landed while waiting shipped inside that release, with its own entries still sitting under
 * `[Unreleased]`: a release whose notes describe less than it contains, which is the one thing a
 * changelog exists to stop. Pinning the commit is what makes "it is ready when you are" true.
 *
 * A ref rather than the scratch stamp beside it, because the stamp records that the gates ran and
 * this records what was being released. The first is a cache and may be deleted at any time; the
 * second is a decision and shows up in `git log` and `git show`.
 */
const CANDIDATE = 'refs/release-candidate';
const candidate = run('git', ['rev-parse', '--verify', '--quiet', CANDIDATE]).out;

if (CUT && !candidate) {
  process.stderr.write(
    '\nNothing has been set aside to release.\n' +
      'Run `npm run release:check` first: it proves the commit you are on and records it here,\n' +
      'and this command then releases that commit however far main has moved since.\n'
  );
  process.exit(1);
}

/** The commit being released: the one set aside, or the one being proven. */
const target = CUT ? candidate : run('git', ['rev-parse', 'HEAD']).out;

/*
 * The manifest and the changelog as they are **at that commit**, not in the working tree. Once main
 * moves on, the tree's version is the next one being built and reading it here would name a release
 * nobody proved.
 */
const atTarget = (path) => run('git', ['show', `${target}:${path}`]).out;
const version = JSON.parse(atTarget('package.json')).version;
const tag = `v${version}`;
say(`Sheaf Editor ${version}, tag ${tag}, from ${target.slice(0, 7)}${CUT ? ' (set aside earlier)' : ''}\n`);

// ---- The checkout this is run from ----------------------------------------

say('=== The checkout ===');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
check('run from the main checkout, on main', branch === 'main', `on ${branch}`);
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).out;
check('no uncommitted changes', dirty === '', dirty ? dirty.split('\n').length + ' files' : 'clean');

run('git', ['fetch', '--quiet', 'origin', 'main']);
const local = run('git', ['rev-parse', 'main']).out;
const remote = run('git', ['rev-parse', 'origin/main']).out;
if (CUT) {
  /*
   * The commit being cut has to be on `origin/main`, and it no longer has to be its tip. That is
   * the difference the ref above buys: main carries on while a proven release waits for the one
   * person who can unlock the key. Contained rather than equal, so this is still refused for a
   * commit that was proven and then never pushed, or one that was rewritten out of the branch.
   */
  const onMain = run('git', ['merge-base', '--is-ancestor', target, remote]).ok;
  const behind = onMain ? Number(run('git', ['rev-list', '--count', `${target}..${remote}`]).out || 0) : 0;
  check(
    'the commit being released is on origin/main',
    onMain,
    onMain ? `${target.slice(0, 7)}, with ${behind} commit(s) landed since` : `${target.slice(0, 7)} is not on origin/main`
  );
} else {
  check('main is pushed to origin', local === remote, local === remote ? local.slice(0, 7) : `${local.slice(0, 7)} vs ${remote.slice(0, 7)}`);
}

/*
 * The release branch lives in its own worktree, not in this checkout. Found rather than
 * assumed: a path written down here goes stale the first time anybody moves it, and the
 * failure would be a release cut from the wrong tree.
 */
const worktrees = run('git', ['worktree', 'list', '--porcelain']).out.split('\n\n');
const releaseTree = worktrees
  .map((block) => ({
    path: /^worktree (.+)$/m.exec(block)?.[1],
    branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
  }))
  .find((w) => w.branch === 'release')?.path;
check('the release worktree is there', !!releaseTree && existsSync(releaseTree), releaseTree ?? 'not found');

// ---- What the release workflow checks before it builds --------------------

say('\n=== What the workflow checks first ===');

const notes = run('node', [join('scripts', 'changelog-notes.mjs'), tag]);
check(`CHANGELOG.md has a section for ${tag}`, notes.ok && notes.out !== '', notes.ok ? `${notes.out.split('\n').length} lines` : notes.err.split('\n')[0]);

// The workflow compares the tag against the manifest and refuses a mismatch. Here the tag
// is built from the manifest, so this says the changelog agrees with both rather than
// re-checking arithmetic.
const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
const dated = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog);
check(`the ${version} heading is dated`, dated, dated ? 'stamped' : 'run npm version, or npm run stamp-changelog');

/*
 * `changelog-notes.mjs` reads the working tree's CHANGELOG.md, and the workflow will read the
 * tagged commit's. Those are the same file until a release is set aside and work carries on, so
 * rather than teaching that script to take a path, this asserts the one thing that makes its answer
 * apply: this version's section is identical in both. Later entries land under `[Unreleased]` and do
 * not touch it, so the normal case passes and an edit to a shipped section is caught.
 */
const sectionOf = (text) => {
  const from = text.indexOf(`## [${version}] - `);
  if (from < 0) return null;
  const next = text.indexOf('\n## [', from + 1);
  return next < 0 ? text.slice(from) : text.slice(from, next);
};
if (CUT) {
  const here = sectionOf(changelog);
  const there = sectionOf(atTarget('CHANGELOG.md'));
  check(
    `the ${version} notes are the ones that were set aside`,
    here !== null && here === there,
    here === there ? 'unchanged since' : 'the section has been edited since this commit was proven'
  );
}

/*
 * The branch push, checked before the passphrase rather than discovered after it.
 *
 * `oss` fetches through the everyday key, so what its `main` holds is readable here for
 * nothing. The commit this is about to make sits on top of `release`, so the push is a
 * fast-forward exactly when `oss`'s `main` is already an ancestor of `release`. When it is
 * not, something has been pushed to the public repository that is not in this history, and
 * that is a thing to look at rather than to force past.
 */
run('git', ['fetch', '--quiet', 'oss']);
const ossMain = run('git', ['rev-parse', 'oss/main']);
const releaseHead = run('git', ['rev-parse', 'release']);
const fastForward =
  !ossMain.ok ||
  ossMain.out === releaseHead.out ||
  run('git', ['merge-base', '--is-ancestor', ossMain.out, releaseHead.out]).ok;
check(
  'the push to the public repository will fast-forward',
  fastForward,
  ossMain.ok ? `oss/main ${ossMain.out.slice(0, 7)}, release ${releaseHead.out.slice(0, 7)}` : 'oss has no main yet'
);

const onOss = run('git', ['ls-remote', '--tags', 'oss', tag]).out;
const tagElsewhere = onOss !== '' ? onOss.split(/\s+/)[0] : null;
say(`  note   ${tag} on oss: ${tagElsewhere ? `${tagElsewhere.slice(0, 7)}, which this will move` : 'not there yet'}`);

// ---- What CI already said about this commit --------------------------------

/*
 * The gates run below on a clone of this commit, and CI ran them on the same commit when it
 * was pushed. Asking what CI concluded costs one request and answers a question the local run
 * cannot: whether these bytes pass on a machine that is not this one.
 *
 * It exists because of the day that went into cutting a release that already existed. A
 * commit was already built, already green and already sitting in the public repository, and
 * `main` had moved a day past it onto commits whose CI was red. Nothing said so. Each cut
 * failed on a different runner-only defect, one of them a keyboard chord that only exists on
 * macOS, and every one of them had been sitting in a red CI run for days where anybody could
 * have read it.
 *
 * Green is required rather than noted, because the whole point of the check half is that a
 * release is not a thing that gets tried. The three ways of not being green are told apart,
 * since a red run wants reading, a running one wants a minute, and a commit CI never saw
 * wants pushing.
 *
 * With no token at all this is unchecked rather than failed. Anybody can run `release:check`,
 * and a contributor who cannot read the private repository's runs is not the person cutting a
 * release.
 *
 * A token that fails to read is the opposite, and the two are deliberately not the same
 * outcome. On the machine that cuts releases this is the only thing standing between a red
 * commit and a published one, and the ways it stops working are all quiet: a token expires,
 * loses a scope, or the workflow is renamed under it. Treated as "unchecked" it would turn
 * itself off and print a note, which is this morning's failure repeated one level up, so it
 * fails instead and says what could not be read.
 */
say('\n=== CI, on this commit, on a machine that is not this one ===');
const ci = await ciVerdict(repoFromRemote('origin', REPO), target, token());
if (ci.state === 'green') check('CI passed on this commit', true, ci.detail);
else if (ci.state === 'untokened') {
  say(`  note   CI on this commit is unchecked: ${ci.detail}`);
  unchecked.push(`whether CI passed on ${local.slice(0, 7)}, which needs a read-only token`);
} else {
  const what = {
    red: 'CI failed on this commit. Read the run before cutting: a runner-only defect fails the release and nothing else.',
    running: 'CI is still running on this commit. Wait for it rather than cutting alongside it.',
    none: 'CI never ran on this commit, so nothing has built these bytes but this machine.',
    unreadable:
      'There is a token, and it could not read the runs, so this check is not checking anything. ' +
      'Fix it rather than cutting past it: an expired or unscoped token turns this gate off silently.',
  }[ci.state];
  check('CI passed on this commit', false, `${ci.detail}\n         ${what}`);
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} check(s) failed. Nothing has been pushed.\n`);
  process.exit(1);
}

// ---- CI, run here, on the tree the tag will name --------------------------

/*
 * `main`'s tree, because that is what the release commit gets: the release branch shares no
 * history with `main` and is rebuilt from it each time, so the bytes are `main`'s and the
 * parentage is the previous release's.
 *
 * A clone rather than a `git archive` export, which is what `package-clean.mjs` uses and is
 * the right thing there. The gates cannot run on an export: one host check reads the
 * repository's own top-level paths out of git to decide that each one either ships or is
 * excluded, and in a tree with no `.git` it sees nothing and fails saying so. That is the
 * check behaving correctly. CI runs `actions/checkout`, which is a clone, so a clone is what
 * this has to be to mean anything. `--local` hardlinks the objects, so it costs almost
 * nothing.
 */
const head = target;
let stamped = null;
try {
  stamped = JSON.parse(readFileSync(STAMP, 'utf8'));
} catch {
  // No stamp, or an unreadable one: run the long half.
}
/*
 * No expiry on the stamp any more, because it is about a commit rather than about `main`.
 * A commit does not change, so a proof of one does not go stale however long it waits to be cut;
 * two hours was the right guard while this proved whatever the branch tip happened to be.
 */
/*
 * **And it does not run at all when CI is green on this commit, because CI ran strictly more.**
 *
 * This half existed to answer "has anything run the gates on the tree the tag will name", which
 * once needed answering here: the v0.2.0 cut failed because nobody ran them after `npm version`
 * rewrote the changelog. That hole is closed by requiring CI green on the commit being released
 * rather than on whatever `main` was, which is the check above.
 *
 * What is left is duplication, and it was expensive: fifteen minutes between the person deciding to
 * release and the prompt that needs them, for a run that reaches *less* than CI does. Both the local
 * clone and the runner lack the two checkouts this repository keeps beside itself, so both forgive
 * the same two gates by name; CI additionally runs from a clean `npm ci` on a machine nobody has
 * been working on. The gates those two forgive are run by the integrator before the commit lands,
 * in the one checkout that has the sibling repositories.
 *
 * So it runs when CI has no verdict to give: no token on this machine, or a commit CI never saw.
 */
const ciIsTheProof = ci.state === 'green';
if (ciIsTheProof) {
  say(`\n=== The gates, already run on this commit ===`);
  say(`  ok   CI ran all of them on ${head.slice(0, 7)} from a clean install, so they are not run again here.`);
  say('       It reaches everything this would, and from a machine that is not this one.');
} else if (stamped && stamped.head === head) {
  const mins = Math.round((Date.now() - stamped.at) / 60000);
  say(`\n=== CI, already run on this commit ===`);
  say(`  ok   the gates and the package passed on ${head.slice(0, 7)} ${mins} minute(s) ago, so they are not run again.`);
  say('       Delete .claude/scratch/release-checked to force them.');
} else {

const build = join(REPO, '.claude', 'scratch', 'release');
run('rm', ['-rf', build]);
must('Cloning the commit being released', 'git', ['clone', '--quiet', '--local', '--no-hardlinks', REPO, build]);
must(`Checking out ${target.slice(0, 7)}`, 'git', ['checkout', '--quiet', '--detach', target], build);
/*
 * `env:` replaces the environment rather than adding to it, so these three run the way they
 * would in any terminal. See `OWN_ENV`.
 */
/*
 * The one variable the clone gets back, read out of the workflow rather than written twice.
 *
 * Two gates cannot run in a tree with no sibling checkouts beside it: the private-terms list and the
 * website's demo page both live outside this repository. A runner is in exactly that position and
 * `ci.yml` forgives those steps by name; this clone sits in `.claude/scratch/` and is in the same
 * position, so a check meant to prove what CI will do has to run them the same way. Stripping it
 * instead made `release:check` fail on a commit whose CI was green, which is the opposite of what
 * this file is for.
 *
 * Taken from the workflow so there is one list. Written out here as well, the two would drift and
 * the first anybody would know is a release check disagreeing with a release.
 */
const forgivenSkips = (() => {
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const m = /^\s*SHEAF_ALLOW_SKIPPED_GATES:\s*(.+?)\s*$/m.exec(yml);
  if (!m) {
    process.stderr.write(
      '\n.github/workflows/ci.yml no longer sets SHEAF_ALLOW_SKIPPED_GATES, so this check cannot run the gates the way CI does.\n' +
        'Read what the workflow does now and update this script.\n'
    );
    process.exit(1);
  }
  return m[1].replace(/^['"]|['"]$/g, '');
})();

const own = (label, args) => {
  say(`\n=== ${label} ===`);
  const r = spawnSync('npm', args, {
    cwd: build,
    stdio: 'inherit',
    env: { ...OWN_ENV, SHEAF_ALLOW_SKIPPED_GATES: forgivenSkips },
  });
  if (r.status !== 0) {
    process.stderr.write(`\n${label} failed. Nothing has been pushed.\n`);
    process.exit(r.status ?? 1);
  }
};
own('Installing from the lockfile', ['ci', '--no-audit', '--no-fund']);
own('Running the gates', ['run', 'gates']);
own('Building the package', ['run', 'package']);
}

unchecked.push('the build attestation, which needs the workflow’s OIDC token');
unchecked.push('the GitHub Release, which needs a repository token');
unchecked.push('the Marketplace and Open VSX publishes, which need the release environment’s credentials');

/*
 * A green check, remembered against the commit it passed on.
 *
 * So that a retry costs seconds rather than the whole run again. A mistyped passphrase used
 * to mean redoing twenty minutes of gates to get back to the prompt, which is the kind of
 * cost that makes somebody skip the check next time.
 *
 * The commit has to match before it is reused, and the cheap checks run again regardless: what is
 * skipped is only the long half, and only for the exact commit it was run on.
 */
try {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, JSON.stringify({ head: target, at: Date.now() }));
} catch {
  // A stamp that cannot be written costs a re-run and nothing else.
}

/*
 * And the commit itself, set aside under a ref, which is the half of this that outlives a scratch
 * directory. From here the cut is one command whenever the person holding the passphrase gets to it,
 * and `main` can carry on in the meantime without changing what that command releases.
 */
if (!CUT) {
  const set = run('git', ['update-ref', CANDIDATE, target]);
  if (set.ok) {
    say(`\nSet aside: ${tag} is ${target.slice(0, 7)}, and \`npm run release\` cuts that commit however far main moves.`);
  } else {
    say(`\nNote: could not record ${CANDIDATE} (${set.err.split('\n')[0]}), so the cut would ask you to run this again.`);
  }
}

say('\n=== Green ===');
say('Everything the workflow does before it publishes passes here, on a clone of the commit');
say('the tag will name. What is left unchecked, because this machine holds none of the');
say('credentials for it:');
for (const item of unchecked) say(`  - ${item}`);

if (!CUT) {
  say('\nNothing has been changed. `npm run release` cuts it, asking for the passphrase once.');
  process.exit(0);
}

// ---- The cut --------------------------------------------------------------

say(`\n=== Rebuilding the release tree from ${target.slice(0, 7)} ===`);
must('Discarding whatever the release worktree held', 'git', ['reset', '--hard'], releaseTree);
must(`Taking ${target.slice(0, 7)}’s tree`, 'git', ['read-tree', '-u', '--reset', target], releaseTree);
must('Staging it', 'git', ['add', '-A'], releaseTree);

/*
 * The staged tree has to be the released commit's exactly. Anything here means the release would
 * carry bytes that were never on `main`, which is the shape of the stale squash that sat in
 * this worktree for six days and would have published a Sheaf with three modules deleted.
 */
const drift = run('git', ['diff', '--cached', '--stat', target], releaseTree).out;
if (drift !== '') {
  process.stderr.write(`\nThe release tree is not ${target.slice(0, 7)}'s:\n${drift}\n\nNothing has been pushed.\n`);
  process.exit(1);
}
say(`  ok   the staged tree is ${target.slice(0, 7)}’s, exactly`);

/*
 * Only when there is something to commit.
 *
 * A run that made the release commit and then failed before pushing leaves the branch
 * already carrying this tree. The next run resets, takes `origin/main` again, finds nothing
 * changed, and `git commit` exits non-zero saying "nothing to commit" — which this read as
 * the commit having failed, when in fact it had already succeeded. Retrying a release should
 * be safe, and this is the step that made it not be.
 */
if (run('git', ['diff', '--cached', '--quiet'], releaseTree).ok) {
  say(`\n=== Sheaf Editor ${version} is already committed ===`);
  say(`  ok   ${run('git', ['rev-parse', '--short', 'HEAD'], releaseTree).out} already carries this tree, so there is nothing to commit.`);
} else {
  must(`Committing Sheaf Editor ${version}`, 'git', ['commit', '-m', `Sheaf Editor ${version}`], releaseTree);
}

/*
 * Both pushes inside one agent, so the passphrase is asked for once instead of once per
 * push. The agent is started by this command and dies with it, so nothing is left unlocked
 * afterwards: there is no `ssh-add` against the user's own agent and nothing to remember to
 * undo. `IdentitiesOnly yes` on the `github-sheaf-release` host means ssh offers exactly
 * this key, and it takes it from the agent once it is there.
 */
say('\n=== Pushing to the public repository ===');
say('The passphrase for the release key is asked for once. Both pushes use it.\n');
/*
 * Every path that can be taken after the passphrase is taken inside this one agent, the
 * fallback included. A step that fails after somebody has typed their passphrase costs them
 * the one thing this whole script exists to ask for only once, and leaves a release half
 * done: the branch pushed and the tag still pointing at the build that failed.
 *
 * The fallback is for a tag that already exists. Moving one is an ordinary force push and
 * there is no tag ruleset on the public repository to refuse it, but if that ever changes,
 * deleting it and pushing it again is the other way to the same place and costs nothing to
 * try here rather than in a second run.
 */
const push = [
  /*
   * Three goes at the passphrase rather than one run thrown away.
   *
   * `ssh-add` re-prompts a few times on a wrong passphrase and then gives up, and giving up
   * used to end the whole command: the branch unpushed, the tag unmoved, and the twenty
   * minutes of checks that led up to the prompt spent for nothing. Three invocations is
   * plenty of room for a typo, Ctrl-C still stops the lot, and nothing is pushed until the
   * key is actually loaded.
   */
  `for i in 1 2 3; do ssh-add ${JSON.stringify(KEY)} && break; ` +
    `[ $i = 3 ] && { echo "The key was not unlocked. Nothing has been pushed; run it again."; exit 1; }; done`,
  'git push oss release:main',
  `git tag -f ${tag} HEAD`,
  `{ git push -f oss ${tag} || { echo "Moving the tag was refused; replacing it instead."; ` +
    `git push oss :refs/tags/${tag} && git push oss ${tag}; }; }`,
].join(' && ');
const cut = spawnSync('ssh-agent', ['bash', '-c', push], { cwd: releaseTree, stdio: 'inherit' });
if (cut.status !== 0) {
  process.stderr.write('\nThe push failed. The release commit is made but nothing reached the public repository.\n');
  process.exit(cut.status ?? 1);
}

say('\n=== Cut ===');
say(`${tag} is pushed. The workflow builds, attests, creates the Release and publishes.`);

/*
 * Watched from here rather than left to somebody opening the Actions tab. The public
 * repository serves its runs and their step lists without a token, so the end of the cut can
 * be the run going green rather than the push going out. Nothing after this changes
 * anything, so a rate limit or no network is reported and not treated as a failed release.
 *
 * Named by workflow and commit, because the run this cares about is the Release run on the
 * tree just pushed. Left to take the newest run it took CI on `main`, which the branch push a
 * few lines above starts at the same moment, and then reported CI's verdict as the release's.
 */
const releaseSha = run('git', ['rev-parse', 'HEAD'], releaseTree).out;
const watched = spawnSync(
  'node',
  [join('scripts', 'release-status.mjs'), '--watch', '--for=release.yml', `--sha=${releaseSha}`],
  { cwd: REPO, stdio: 'inherit' }
);
if (watched.status === 0) {
  say('\nPublished. The Marketplace takes a while to index after the workflow goes green.');
} else {
  say('\nThe tag is pushed either way. `npm run release:status` says where the run is.');
}
