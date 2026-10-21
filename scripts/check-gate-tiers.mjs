/*
 * Whether the gate tiering still covers what it says it covers.
 *
 *   node scripts/check-gate-tiers.mjs
 *
 * `scripts/lib/gateTier.mjs` decides which expensive gates a change has to run, from what the diff
 * touches. The fault that design can have is a mapping that **misses** a path: the expensive gate
 * then never runs for a change it covers, the run is green, and nothing says so. A silent gap in
 * the bar is worse than the ten minutes the tiering saves, so this is the check that stands between
 * the two.
 *
 * Four questions, and what each one can and cannot catch:
 *
 *   1. **Is every source claimed?** Every file git tracks under `src/`, `media/` and `test/` is
 *      covered by an expensive gate's patterns, or named in `CHEAP_ONLY` with a reason. A new file
 *      in a directory nobody classified fails here on the day it is added, rather than six months
 *      later when somebody notices a gate has not run. It cannot tell a *wrong* claim from a right
 *      one: a file claimed by the wrong gate is claimed. It reads `git ls-files`, so a file that
 *      has not been added yet is outside it; that case is covered where it arises, by the same
 *      question asked of the diff in `scripts/gates.mjs`, which counts untracked paths and refuses
 *      to derive a tier when one is unclaimed.
 *
 *   2. **Does a subject cover its artefact's real closure?** The sources esbuild pulled into
 *      `media/webview.js`, `dist/serve.js` and `dist/serve-host.js` are in the metafiles the build
 *      writes, and every repository source in one has to be covered by the subject's own patterns.
 *      This is the question that catches a narrowed mapping. Narrow `editor` to one file and this
 *      names the other seventy-four. It reads the metafile from the build in this run, because the
 *      step runs after `Build`: a closure read from an older build is a statement about a tree
 *      nobody is landing.
 *
 *   3. **Does every declared pattern still match something?** A pattern matching nothing is a
 *      claim that has rotted, which is what a renamed directory leaves behind. `src/webview/**`
 *      renamed to `src/editor/**` would otherwise leave the `editor` subject covering an empty set
 *      while every file in the tree stayed claimed by question 1, because the renamed files would
 *      land in whatever other pattern happened to reach them.
 *
 *   4. **Is every stylesheet accounted for?** `media/webview.css` and `media/browser-theme.css`
 *      are served as they are rather than built, so there is no closure to read. The audit instead
 *      is that every stylesheet git tracks under `media/` is in the subject, so adding a third one
 *      fails rather than going unwatched.
 *
 * **What none of them can answer is whether a gate declares the subjects it really reads.** That is
 * eight short `covers` lists, and a gate that quietly stopped declaring one would be skipped for
 * changes to it with all four questions above still passing. The only instrument for that is a
 * sensitivity run: break the subject, watch the gate fail. So this check is about the mapping's
 * completeness and about one half of its correctness, and it is not about gate selection as a
 * whole. Saying that plainly here rather than letting a green line imply more.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { STEPS } from './lib/gateSteps.mjs';
import { CHEAP_ONLY, SUBJECTS, coveredBy, population, subjectGaps, unclaimed } from './lib/gateTier.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const problems = [];
const said = [];

const conditional = STEPS.filter((s) => Array.isArray(s[3]));
/*
 * Two populations, and they are not the same question. The completeness rule is about `src/`,
 * `media/` and `test/`, which is where a source nobody classified can hide. Whether a declared
 * pattern still matches anything is about the whole tree, because a gate may name a path outside
 * those three: `Table widths` reads one document out of `sample/`, and a rot check scoped to the
 * three would have reported that correct line as matching nothing.
 */
const tree = population(REPO);
const everything = population(REPO, ['.']);

/* 1. Every source claimed. */
const loose = unclaimed({ steps: STEPS, population: tree });
if (loose.length) {
  problems.push(
    `${loose.length} tracked file${loose.length === 1 ? '' : 's'} under src/, media/ and test/ ${loose.length === 1 ? 'is' : 'are'} claimed by no expensive gate and named in no cheap-tier declaration:\n` +
      loose.map((p) => `    ${p}`).join('\n') +
      '\n  Each one has to be either inside a subject in scripts/lib/gateTier.mjs, so the gates that\n' +
      '  read it run when it changes, or in CHEAP_ONLY with a sentence saying why nothing in the\n' +
      '  expensive tier can see it. Until then a change to it runs the cheap tier alone, and no\n' +
      '  other check would say so.'
  );
} else {
  said.push(`every one of the ${tree.length} tracked sources under src/, media/ and test/ is claimed`);
}

/* 2. Each subject against its artefacts' real closures. */
let artefacts = 0;
for (const [name, subject] of Object.entries(SUBJECTS)) {
  for (const artefact of subject.artefacts ?? []) {
    const { built, metafile } = artefact;
    const gaps = subjectGaps(REPO, subject, artefact);
    if (!gaps) {
      problems.push(
        `${metafile} is not there, so the ${name} subject's paths were compared against nothing.\n` +
          `  It is written by the build that produces ${built}. Run npm run build.\n` +
          '  Reported as a failure rather than skipped: a subject whose closure was never read is a\n' +
          '  subject that could have been narrowed to one file without anything noticing.'
      );
      continue;
    }
    artefacts += 1;
    const { closure, missing } = gaps;
    if (missing.length) {
      problems.push(
        `${built} is built from ${missing.length} source${missing.length === 1 ? '' : 's'} the ${name} subject does not cover:\n` +
          missing.map((p) => `    ${p}`).join('\n') +
          `\n  Every gate reading that subject would be skipped for a change to ${missing.length === 1 ? 'it' : 'them'}, and the\n` +
          `  run would be green. Add ${missing.length === 1 ? 'it' : 'them'} to SUBJECTS.${name}.patterns, or say in CHEAP_ONLY why the\n` +
          '  expensive tier cannot see it.'
      );
    } else {
      said.push(`${built}: all ${closure.length} repository sources in its closure are inside the ${name} subject`);
    }
  }
}

/* 3. Every declared pattern still matches something. */
const declared = [
  ...Object.entries(SUBJECTS).map(([name, s]) => [`subject ${name}`, s.patterns]),
  ...CHEAP_ONLY.map((c, i) => [`CHEAP_ONLY entry ${i + 1}`, c.patterns]),
  ...conditional.map(([label, , , covers]) => [`${label}'s covers`, covers.filter((c) => !SUBJECTS[c])]),
];
const rotted = [];
for (const [where, patterns] of declared) {
  for (const pattern of patterns) {
    if (!everything.some((p) => coveredBy([pattern], p))) rotted.push(`${pattern} (${where})`);
  }
}
if (rotted.length) {
  problems.push(
    `${rotted.length} declared pattern${rotted.length === 1 ? '' : 's'} match${rotted.length === 1 ? 'es' : ''} no tracked file:\n` +
      rotted.map((p) => `    ${p}`).join('\n') +
      '\n  A pattern matching nothing is a claim that has rotted, which is what a rename leaves\n' +
      '  behind: the files move into whatever other pattern happens to reach them, every file in\n' +
      '  the tree stays claimed, and the gate that was meant to cover them covers an empty set.'
  );
} else {
  said.push(`all ${declared.reduce((n, [, ps]) => n + ps.length, 0)} declared patterns match at least one tracked file`);
}

/* 4. Every stylesheet accounted for. */
for (const [name, subject] of Object.entries(SUBJECTS)) {
  if (!subject.everyCssUnder) continue;
  const sheets = population(REPO, [subject.everyCssUnder]).filter((p) => p.endsWith('.css'));
  const loose = sheets.filter((p) => !coveredBy(subject.patterns, p));
  if (loose.length) {
    problems.push(
      `${loose.length} stylesheet${loose.length === 1 ? '' : 's'} under ${subject.everyCssUnder}/ ${loose.length === 1 ? 'is' : 'are'} not in the ${name} subject:\n` +
        loose.map((p) => `    ${p}`).join('\n') +
        '\n  A stylesheet is served as it is rather than built, so there is no closure to read and\n' +
        '  this list is the whole of the audit for it. Add it, or move it out of media/.'
    );
  } else {
    said.push(`all ${sheets.length} stylesheets under ${subject.everyCssUnder}/ are in the ${name} subject`);
  }
}

/* What the tier currently is, printed so a reader of a gates log can see it without reading code. */
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

console.log(`gate tiers at ${commit}: ${STEPS.length} gates, ${conditional.length} of them conditional`);
for (const [label, , , covers] of conditional) {
  console.log(`  ${label}: ${covers.join(', ')}`);
}
for (const s of said) console.log(`  ${s}`);

if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`${p}\n`);
  console.log(
    `${problems.length} problem${problems.length === 1 ? '' : 's'} with the gate tiering. Until ${problems.length === 1 ? 'it is' : 'they are'} fixed, a change to a path\n` +
      'nothing claims runs the cheap tier alone, which is a gate not running and a green run.'
  );
  process.exit(1);
}

console.log(
  `\nThe mapping covers ${tree.length} sources and ${artefacts} built artefact${artefacts === 1 ? '' : 's'}. ` +
    'It does not say that each\ngate declares the subjects it reads; only a sensitivity run says that.'
);
