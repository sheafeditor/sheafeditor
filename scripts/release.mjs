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

const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
say(`Sheaf Editor ${version}, tag ${tag}\n`);

// ---- The checkout this is run from ----------------------------------------

say('=== The checkout ===');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
check('run from the main checkout, on main', branch === 'main', `on ${branch}`);
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).out;
check('no uncommitted changes', dirty === '', dirty ? dirty.split('\n').length + ' files' : 'clean');

run('git', ['fetch', '--quiet', 'origin', 'main']);
const local = run('git', ['rev-parse', 'main']).out;
const remote = run('git', ['rev-parse', 'origin/main']).out;
check('main is pushed to origin', local === remote, local === remote ? local.slice(0, 7) : `${local.slice(0, 7)} vs ${remote.slice(0, 7)}`);

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
const head = run('git', ['rev-parse', 'HEAD']).out;
let stamped = null;
try {
  stamped = JSON.parse(readFileSync(STAMP, 'utf8'));
} catch {
  // No stamp, or an unreadable one: run the long half.
}
const STILL_GOOD_MS = 2 * 60 * 60 * 1000;
if (stamped && stamped.head === head && Date.now() - stamped.at < STILL_GOOD_MS) {
  const mins = Math.round((Date.now() - stamped.at) / 60000);
  say(`\n=== CI, already run on this commit ===`);
  say(`  ok   the gates and the package passed on ${head.slice(0, 7)} ${mins} minute(s) ago, so they are not run again.`);
  say('       Delete .claude/scratch/release-checked to force them.');
} else {

const build = join(REPO, '.claude', 'scratch', 'release');
run('rm', ['-rf', build]);
must('Cloning main', 'git', ['clone', '--quiet', '--local', '--no-hardlinks', '--branch', 'main', REPO, build]);
/*
 * `env:` replaces the environment rather than adding to it, so these three run the way they
 * would in any terminal. See `OWN_ENV`.
 */
const own = (label, args) => {
  say(`\n=== ${label} ===`);
  const r = spawnSync('npm', args, { cwd: build, stdio: 'inherit', env: OWN_ENV });
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
 * The commit and the clock both have to agree before it is reused, and the cheap checks run
 * again regardless: what is skipped is only the long half, and only for the exact commit it
 * was run on.
 */
try {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, JSON.stringify({ head: run('git', ['rev-parse', 'HEAD']).out, at: Date.now() }));
} catch {
  // A stamp that cannot be written costs a re-run and nothing else.
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

say('\n=== Rebuilding the release tree from origin/main ===');
must('Discarding whatever the release worktree held', 'git', ['reset', '--hard'], releaseTree);
must('Taking origin/main’s tree', 'git', ['read-tree', '-u', '--reset', 'origin/main'], releaseTree);
must('Staging it', 'git', ['add', '-A'], releaseTree);

/*
 * The staged tree has to be `origin/main`'s exactly. Anything here means the release would
 * carry bytes that were never on `main`, which is the shape of the stale squash that sat in
 * this worktree for six days and would have published a Sheaf with three modules deleted.
 */
const drift = run('git', ['diff', '--cached', '--stat', 'origin/main'], releaseTree).out;
if (drift !== '') {
  process.stderr.write(`\nThe release tree is not origin/main's:\n${drift}\n\nNothing has been pushed.\n`);
  process.exit(1);
}
say('  ok   the staged tree is origin/main’s, exactly');

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
 */
const watched = spawnSync('node', [join('scripts', 'release-status.mjs'), '--watch'], { cwd: REPO, stdio: 'inherit' });
if (watched.status === 0) {
  say('\nPublished. The Marketplace takes a while to index after the workflow goes green.');
} else {
  say('\nThe tag is pushed either way. `npm run release:status` says where the run is.');
}
