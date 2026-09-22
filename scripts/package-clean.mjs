/*
 * Builds a .vsix from a clean export of a commit, not from the working tree.
 *
 *   node scripts/package-clean.mjs                 exports HEAD
 *   node scripts/package-clean.mjs --ref main      exports a named commit or branch
 *   node scripts/package-clean.mjs --out <dir>     writes somewhere else
 *
 * Why an export rather than `npm run package` here: a working tree can
 * hold uncommitted edits, a half-finished worktree, or build output
 * from a test run. `git archive` takes exactly what is committed, so the package
 * is the commit and nothing else.
 *
 * The export goes to `.claude/scratch/build` by default, which is inside the
 * repository and gitignored. Nothing is written outside it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const ref = arg('ref', 'HEAD');
const out = resolve(REPO, arg('out', join('.claude', 'scratch', 'build')));

/** Run a command, inheriting output, and stop the script if it fails. */
function step(label, cmd, args, cwd) {
  process.stdout.write(`${label}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    process.stderr.write(`${label} failed\n`);
    process.exit(r.status ?? 1);
  }
}

const sha = spawnSync('git', ['rev-parse', '--short', ref], { cwd: REPO, encoding: 'utf8' });
if (sha.status !== 0) {
  process.stderr.write(`Not a commit: ${ref}\n`);
  process.exit(1);
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

process.stdout.write(`Exporting ${ref} (${sha.stdout.trim()}) to ${out}\n`);
const archive = spawnSync('git', ['archive', ref], { cwd: REPO, maxBuffer: 1 << 30 });
if (archive.status !== 0) {
  process.stderr.write('git archive failed\n');
  process.exit(archive.status ?? 1);
}
const untar = spawnSync('tar', ['-x', '-C', out], { input: archive.stdout });
if (untar.status !== 0) {
  process.stderr.write('tar failed\n');
  process.exit(untar.status ?? 1);
}

step('Installing dependencies', 'npm', ['ci', '--no-audit', '--no-fund'], out);
step('Packaging', 'npm', ['run', 'package'], out);

const vsix = readdirSync(out).filter((f) => f.endsWith('.vsix'));
for (const f of vsix) process.stdout.write(`\n${join(out, f)}\n`);
