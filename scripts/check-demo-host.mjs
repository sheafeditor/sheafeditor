/*
 * The site demo's host against the wire it implements.
 *
 * Three hosts read the editor's messages. Two of them are in this repository and are held to
 * `src/protocol.ts` by the type system: the extension host switches on `FromWebview`, and
 * `src/server/host.ts` carries a `Record<FromWebviewType, Decision>` that cannot compile with an
 * entry missing. The third is `public/demo/host.js` in the site's own checkout, hand-written
 * JavaScript in a repository that does not depend on this one, so it can import no type and nothing
 * has ever compared the two.
 *
 * That makes it the host most likely to drift and the only one with no mechanism. A message added
 * here is a compile error in two hosts and silence in the third, which is the shape that produced
 * the line-numbers button that turned them on and then did nothing for ever.
 *
 * **It reports and ratchets rather than demanding parity.** A demo is allowed to answer less than a
 * tab: it serves a fixed document on a static site with no server behind it. What it is not allowed
 * to do is answer *fewer* messages than it did yesterday without somebody saying so, or carry a case
 * for a message the protocol no longer has, which is dead code wearing the clothes of coverage.
 *
 * Skipped when there is no site checkout to read, found through SHEAF_SITE_DIR or by walking up for
 * a `sheaf-site` sibling, so a clone of this repository on its own still passes its gates. That skip
 * is the risk this file carries: a check that silently passes when it cannot see its subject is the
 * `PLAYWRIGHT_CORE` trap, so it prints that it skipped and why rather than reporting success.
 *
 *   node scripts/check-demo-host.mjs             compare and report
 *   node scripts/check-demo-host.mjs --accept     record what the demo answers today
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(REPO, 'scripts', 'demo-host.json');

/*
 * The site checkout, which sits beside the one this file belongs to rather than above it.
 *
 * **It walks up rather than taking one sibling, and that is the whole of this function.** Run from
 * a session's own worktree, `sheaf-site` is not one directory up: a worktree sits at
 * `.claude/worktrees/<name>`, three levels below the checkout it belongs to, so the sibling of
 * wherever this file happens to be is `.claude/worktrees/sheaf-site`, which nothing has ever
 * created. This gate could therefore pass only in the main checkout, and every branch is built in a
 * worktree. Worse than failing: it is not forgiven, so the run stopped here and the thirteen gates
 * after it reported nothing, while its own message blamed a missing clone that was present.
 *
 * Same walk and same shape as `findDevDir` in brain's `check-docs.mjs`, which had this exact bug and
 * for the same reason. A walk rather than `git rev-parse --git-common-dir` because it needs no
 * subprocess and works in a checkout that is not a git repository at all.
 */
function findSite() {
  for (let dir = REPO; ; dir = dirname(dir)) {
    const candidate = join(dirname(dir), 'sheaf-site');
    if (existsSync(join(candidate, 'public'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/*
 * `SHEAF_SITE_DIR` wins, and a wrong one is said out loud rather than quietly replaced by the walk.
 * Taken on trust, or silently fallen back from, a mistyped path reads exactly like no site at all,
 * and this gate's skip is the one thing it must not get wrong: it exists because a check that passes
 * when it cannot see its subject is the `PLAYWRIGHT_CORE` trap.
 */
const SITE = process.env.SHEAF_SITE_DIR ?? findSite();

if (process.env.SHEAF_SITE_DIR && !existsSync(join(SITE, 'public'))) {
  console.log(`skipped: SHEAF_SITE_DIR is set to ${SITE}, which has no public/ in it.`);
  console.log('Point it at a sheaf-site checkout or unset it to search for one. Nothing was compared.');
  process.exit(0);
}

if (!SITE) {
  console.log('skipped: no sheaf-site checkout found beside this one or any directory above it,');
  console.log('so the demo host cannot be read. Set SHEAF_SITE_DIR to point at one. Nothing was compared.');
  process.exit(0);
}

const HOST = join(SITE, 'public', 'demo', 'host.js');
if (!existsSync(HOST)) {
  console.log(`skipped: ${HOST} is not there, so the demo host cannot be read. Nothing was compared.`);
  process.exit(0);
}

/**
 * Every message the editor can send, read out of the union rather than from a list.
 *
 * The union's members each carry a `type: '...'` literal, and taking them from the source is what
 * makes this derived: a list typed into this file would catch only the messages somebody remembered
 * to add to it, which is the fault `src/server/host.ts` replaced a check for.
 */
function wireMessages() {
  const src = readFileSync(join(REPO, 'src', 'protocol.ts'), 'utf8');
  const start = src.indexOf('export type FromWebview');
  if (start < 0) return [];
  // To the end of the union, which is the first line that starts a new declaration.
  const rest = src.slice(start);
  const end = rest.search(/\n(?:export|\/\*\*\s*\n\s*\*\s*The answers)/);
  const body = end > 0 ? rest.slice(0, end) : rest;
  return [...new Set([...body.matchAll(/type:\s*'(\w+)'/g)].map(([, name]) => name))].sort();
}

/** Every message the demo answers, by the cases its switch carries. */
function demoAnswers() {
  const src = readFileSync(HOST, 'utf8');
  return [...new Set([...src.matchAll(/case\s*'(\w+)'/g)].map(([, name]) => name))].sort();
}

const wire = wireMessages();
const answers = demoAnswers();

// A parse that found nothing agrees with anything, so each side has to say it found something.
if (!wire.length) {
  console.log('could not read the message union out of src/protocol.ts, so this check is reading the wrong thing.');
  process.exit(1);
}
if (!answers.length) {
  console.log(`could not read any case out of ${HOST}, so this check is reading the wrong thing.`);
  process.exit(1);
}

const ignored = wire.filter((m) => !answers.includes(m));
const stale = answers.filter((m) => !wire.includes(m));

if (process.argv.includes('--accept')) {
  writeFileSync(BASELINE, JSON.stringify({ answers }, null, 2) + '\n');
  console.log(`recorded: the demo answers ${answers.length} of ${wire.length} messages.`);
  process.exit(0);
}

const committed = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).answers : null;

console.log(`The site demo answers ${answers.length} of the editor's ${wire.length} messages.\n`);
console.log(`  answers: ${answers.join(', ')}`);
console.log(`  ignores: ${ignored.join(', ')}`);

const problems = [];
if (stale.length) problems.push(`carries a case for ${stale.join(', ')}, which the protocol no longer has`);
if (committed) {
  const lost = committed.filter((m) => !answers.includes(m));
  if (lost.length) problems.push(`no longer answers ${lost.join(', ')}, which it answered when this was recorded`);
  const gained = answers.filter((m) => !committed.includes(m));
  if (gained.length) console.log(`\n  newly answered since this was recorded: ${gained.join(', ')}. Run with --accept to hold the new line.`);
} else {
  console.log('\n  nothing recorded yet. Run with --accept to record what it answers today.');
}

if (problems.length) {
  console.log(`\n${problems.map((p) => `The demo host ${p}.`).join('\n')}`);
  console.log('Fix it in the site checkout, or run with --accept in the same commit if the change is deliberate.');
  process.exit(1);
}

console.log('\nNo message the demo answered has gone, and it carries no case the protocol has dropped.');
