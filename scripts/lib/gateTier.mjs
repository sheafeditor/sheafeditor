/*
 * Which gates a change can break, derived from what the change touches.
 *
 * Measured on dev-mini on 2026-10-10, both runs in the same hour on the same tree: the whole bar
 * was 567s across 36 gates, and the eight conditional gates below were 423s of that. A run that
 * selected none of them was 143s across 28.
 *
 * **Those are a reason rather than a committed number.** Re-derive them with
 * `node scripts/gate-timings.mjs`, which reports each gate's median over the recorded runs that
 * did not overlap another, and read the total off the bottom of a `npm run gates` run. The count
 * of conditional gates is `node scripts/check-gate-tiers.mjs`, which derives it from `STEPS`.
 *
 * So a landing runs the cheap tier plus `Tests`, and an expensive gate only when the diff touches
 * something that can change its answer. `Tests` is expensive and unconditional on purpose: it has
 * caught more failures than any other gate here.
 *
 * **It is never a flag.** `scripts/gates.mjs` already carries the reason, about a different flag:
 * "A flag somebody has to remember is the same as no check, one step more flattering." That cuts
 * both ways. An opt-in quick tier means the full run stops happening; an opt-in full tier means the
 * expensive gates stop happening. Both failures are silent, and both are worse than the run they
 * were trying to shorten. So the tier comes out of `git diff` and nobody chooses it.
 *
 * `--all` is not an exception to that. It does not select a tier; it turns selection off, which is
 * what CI runs and what a release check runs.
 *
 * ## The fault this design can have
 *
 * A mapping from gate to paths can **miss** a path. The expensive gate then silently never runs
 * for a change it covers, and the run is green: the same shape as a check that cannot fail, and the
 * reason most of this file is about auditing the mapping rather than applying it.
 *
 * Three things hold it down, and only the first two are mechanical.
 *
 *   1. **A subject's paths are checked against the built artefact's real closure.** The sources
 *      esbuild pulled into `media/webview.js` are in the metafile the build writes, so a module
 *      that joins the editor bundle without joining the `editor` subject fails
 *      `scripts/check-gate-tiers.mjs`. This is what makes a narrowed subject impossible to leave
 *      lying around: narrow `editor` to one file and the check names the other seventy-four.
 *   2. **Every path in the tree is claimed, or declared cheap-covered with a reason.** An
 *      unclaimed path fails, naming itself, on the day it is added. A new directory nobody
 *      classified cannot quietly fall outside every expensive gate.
 *   3. **Which subjects a gate reads is a judgement, and nothing here can audit it.** Eight short
 *      `covers` lists in `STEPS`. A gate that stopped declaring a subject it really reads would be
 *      skipped for changes to it, and both checks above would still pass. What stands against that
 *      is a sensitivity run: break the subject and watch the gate fail. The control log in the
 *      commit message says which pairs were measured that way and which were not.
 *
 * ## Fail towards running too much
 *
 * Every undecidable case runs more gates rather than fewer. No base commit, no git, a changed path
 * in the build itself, a step with no `covers`: each of those runs the expensive tier. A gate that
 * ran when it did not need to costs minutes. A gate that did not run when it was needed costs a
 * defect nobody is looking for.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/*
 * A pattern is an exact repository path, or a directory with `/**` after it. Nothing else, and
 * anything else throws: a pattern like `src/*.ts` that silently matched nothing would be a gate
 * quietly covering less than its line says, which is the whole fault this file is about.
 */
export function checkPattern(pattern) {
  const bad = pattern.endsWith('/**') ? pattern.slice(0, -3).includes('*') : pattern.includes('*');
  if (bad || pattern.startsWith('/') || pattern.includes('..')) {
    throw new Error(
      `gate tier pattern ${JSON.stringify(pattern)} is neither an exact path nor a directory ending in /**`
    );
  }
  return pattern;
}

/** Whether a repository-relative path is covered by one pattern. */
export function matches(pattern, path) {
  checkPattern(pattern);
  return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

/** The first pattern in `patterns` that covers `path`, or undefined. */
export const coveredBy = (patterns, path) => patterns.find((p) => matches(p, path));

/*
 * The subjects. A subject is a set of sources and the built thing they end up in, named once so
 * that eight gates reading the editor bundle do not carry eight copies of what that bundle is
 * built from. One fact in two places drifts, and `serve-for-check.mjs` already held a narrower
 * copy of the first one: it listed `src/webview` and the stylesheet and not `src/dialect`, so a
 * grammar edit could have been served stale.
 *
 * `artefacts` is what makes a subject auditable. Each names a built file and the metafile the
 * build writes beside it, and `scripts/check-gate-tiers.mjs` asserts every repository source in
 * that metafile is covered by the subject's own patterns.
 */
export const SUBJECTS = {
  editor: {
    what: 'the editor bundle, which every gate in the expensive tier mounts',
    artefacts: [{ built: 'media/webview.js', metafile: '.claude/scratch/webview-metafile.json' }],
    patterns: ['src/webview/**', 'src/dialect/**', 'src/docLink.ts', 'src/textSync.ts'],
  },
  stylesheet: {
    what: "the editor's stylesheet, which a browser applies and jsdom does not",
    /*
     * No metafile: these are committed files served as they are rather than build inputs, so the
     * audit for this one is that every `media/**` stylesheet in the tree is named here. A new
     * stylesheet is then a failure rather than a file no gate watches.
     */
    everyCssUnder: 'media',
    patterns: ['media/webview.css', 'media/browser-theme.css'],
  },
  server: {
    what: 'the local server and its host shim, which every browser-driven gate loads its page from',
    artefacts: [
      { built: 'dist/serve.js', metafile: '.claude/scratch/serve-metafile.json' },
      { built: 'dist/serve-host.js', metafile: '.claude/scratch/serve-host-metafile.json' },
    ],
    patterns: [
      'src/server/**',
      'src/settingValues.ts',
      'src/recentTyping.ts',
      'src/buildStamp.ts',
      'src/textSync.ts',
      'src/docLink.ts',
    ],
  },
  'editor-scenarios': {
    what: 'the jsdom half of the real-editor scenarios, and the harness they are written against',
    /*
     * `run-unit.mjs` generates its entry into the run folder and bundles `unit/*.ts` with the
     * esbuild in this checkout, so there is no committed artefact to read a closure out of. The
     * patterns are the directory it reads its areas from and the harness those areas import.
     */
    patterns: ['test/real-editor/unit/**', 'test/real-editor/run-unit.mjs', 'test/harness.ts'],
  },
};

/*
 * What the cheap tier covers on its own: paths where **no gate in the expensive tier can change
 * its verdict**. That is the claim, and it is not "a cheap gate reads this file". Nearly every
 * file here is read by `Tests`, which always runs, so a declaration about what the cheap tier
 * touches would cover the whole tree and the completeness check would pass over everything.
 *
 * Each entry says why the expensive tier cannot see it. A reason that turns out to be wrong is a
 * mapping fault with its reasoning written down next to it, which is the point of writing it.
 */
export const CHEAP_ONLY = [
  {
    patterns: [
      'src/extension.ts',
      'src/markdownEditorProvider.ts',
      'src/about.ts',
      'src/defaultEditor.ts',
      'src/browserSession.ts',
    ],
    why: 'extension-host code. Nothing in the expensive tier starts VS Code: the real-window suite does, and it is not a gate. The host suite under Tests is what reads these.',
  },
  {
    patterns: ['src/protocol.ts', 'src/hostContract.ts'],
    why: 'types only. Neither appears in any build metafile, so no bundle changes when they do, and the type checks are what read them.',
  },
  {
    patterns: ['src/lib/**'],
    why: 'the importable library, a separate build. The expensive tier loads media/webview.js; Package and Bundle size read lib/ and are both cheap.',
  },
  {
    patterns: ['src/render/**'],
    why: "Markdown to HTML with no editor in it, absent from the editor bundle's closure. Reached by the library build and by the dialect suite under Tests.",
  },
  {
    patterns: ['media/icon.svg', 'media/icon-small.svg', 'media/icon.png'],
    why: 'artwork. No gate draws it; the package check is what notices one going missing.',
  },
  {
    patterns: ['test/real-editor/editor/**'],
    why: 'the real-window half of the scenarios, which no gate runs. Scenario ids imports every one of these files to count them, and it is cheap.',
  },
  {
    patterns: [
      'test/real-editor/README.md',
      'test/real-editor/args.mjs',
      'test/real-editor/pixels.mjs',
      'test/real-editor/reapRuns.mjs',
      'test/real-editor/run-editor.mjs',
      'test/real-editor/screenLock.mjs',
      'test/real-editor/session.mjs',
      'test/real-editor/tabHost.mjs',
    ],
    why: 'the real-window runner and what it drives a window with. run-unit.mjs imports none of it.',
  },
  {
    patterns: [
      'test/prose/**',
      'test/browserHost.entry.ts',
      'test/browserHost.test.mjs',
      'test/columnWidths.cases.ts',
      'test/dialect.corpus.json',
      'test/dialect.entry.ts',
      'test/dialect.test.mjs',
      'test/engine.entry.ts',
      'test/engine.test.mjs',
      'test/harness.test.mjs',
      'test/host.test.mjs',
      'test/hostContract.entry.ts',
      'test/hostEntry.ts',
      'test/prose.entry.ts',
      'test/prose.test.mjs',
      'test/server.entry.ts',
      'test/server.test.mjs',
      'test/sync.entry.ts',
      'test/tables.entry.ts',
      'test/tables.test.mjs',
      'test/textSync.test.mjs',
      'test/webview.mjs',
    ],
    why: 'the suites, which Tests runs and nothing in the expensive tier reads. test/harness.ts is the exception and belongs to the editor-scenarios subject, because run-unit.mjs bundles it.',
  },
];

/*
 * Changes that make the tier undecidable, and therefore run all of it.
 *
 * The build, the dependency set and the selection code itself: a change to any of them can move
 * what every artefact is built from, so a mapping derived from the state before it is not about
 * the tree being landed. This list is short on purpose, and the rule for adding to it is that a
 * change to the named path can alter a *different* path's meaning.
 */
export const RUNS_EVERYTHING = [
  'esbuild.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.lib.json',
  'tsconfig.test.json',
  'scripts/esbuild-plugins.mjs',
  'scripts/gates.mjs',
  'scripts/lib/gateRun.mjs',
  'scripts/lib/gateTier.mjs',
];

/**
 * The local modules a script reaches, transitively, as repository-relative paths.
 *
 * Derived rather than declared, because a gate's own helpers are the one part of its coverage
 * that can be read off the source. `serve-for-check.mjs` is shared by six gates and
 * `lib/editorDom.mjs` by two, and a hand-written list of which gate uses which would be a second
 * copy of their import lines.
 *
 * Static specifiers only. A dynamic `import(variable)` is invisible here, and the gates have none.
 */
export function localImports(repo, entry, seen = new Set()) {
  const abs = resolve(repo, entry);
  const rel = relative(repo, abs);
  if (seen.has(rel) || !existsSync(abs)) return seen;
  seen.add(rel);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return seen;
  }
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
    localImports(repo, relative(repo, resolve(dirname(abs), m[1])), seen);
  }
  return seen;
}

/** Every pattern a step's `covers` resolves to, subjects expanded. */
export function patternsFor(covers) {
  const out = [];
  for (const name of covers) {
    const subject = SUBJECTS[name];
    if (subject) out.push(...subject.patterns);
    else out.push(checkPattern(name));
  }
  return out;
}

/*
 * What changed, against the commit this work branched from.
 *
 * `origin/main` rather than `main`, and the merge-base rather than the tip, so the same rule
 * covers both places the gates run: a builder's worktree on a branch off `main`, where the
 * merge-base is the branch point, and the integrator's checkout holding `main` ahead of the
 * remote, where it is `origin/main` itself. A stale `origin/main` moves the base backwards and
 * selects more gates, which is the direction to be wrong in.
 *
 * Uncommitted and untracked files count. Most of a gates run happens over a working tree that has
 * not been committed yet, and a brand-new file nobody has classified is exactly the case the
 * completeness check exists for.
 *
 * `SHEAF_GATES_BASE` names another base, for a run that wants to ask the question of a different
 * stretch of history. A base that cannot be resolved is not an error: it returns no base, and the
 * caller then runs everything.
 */
export function changedPaths(repo, { base = process.env.SHEAF_GATES_BASE } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  let from = null;
  let why = '';
  try {
    if (base) {
      from = git('rev-parse', '--verify', `${base}^{commit}`).trim();
      why = `SHEAF_GATES_BASE=${base}`;
    } else {
      from = git('merge-base', 'HEAD', 'origin/main').trim();
      why = 'the merge-base of HEAD and origin/main';
    }
  } catch {
    return { base: null, why: base ? `${base} could not be resolved` : 'neither origin/main nor a merge-base with it could be read', paths: [] };
  }
  const paths = new Set();
  try {
    for (const line of git('diff', '--name-only', from, '--').split('\n')) if (line.trim()) paths.add(line.trim());
    /*
     * `--porcelain -uall` rather than a second diff, so a rename shows both of its paths and an
     * untracked file shows at all. The status codes are fixed-width and the path follows them;
     * a rename is printed as `old -> new` and both halves count, because a gate covering either
     * one has something to say about the move.
     */
    for (const line of git('status', '--porcelain', '-uall').split('\n')) {
      const rest = line.slice(3).trim();
      if (!rest) continue;
      for (const part of rest.split(' -> ')) paths.add(part.replace(/^"|"$/g, ''));
    }
  } catch {
    return { base: null, why: 'git could not say what changed', paths: [] };
  }
  return { base: from, why, paths: [...paths].sort() };
}

/**
 * Which gates this change can break.
 *
 * `steps` are `gates.mjs`'s own, `[label, cmd, args, covers?]`. A step with no `covers` is in the
 * cheap tier and always runs: the default has to be the expensive direction, so that a new gate
 * nobody classified costs time rather than going silently unrun.
 *
 * Returns the steps to run, in their original order, and for each conditional gate either the
 * changed path that selected it or the fact that nothing did.
 */
export function selectSteps({ steps, changed, base, repo }) {
  const conditional = steps.filter((s) => Array.isArray(s[3]));
  if (!base) {
    return {
      run: steps,
      selected: conditional.map(([label]) => ({ label, by: null, because: 'no base commit, so every gate runs' })),
      everything: true,
    };
  }
  const forced = changed.find((p) => RUNS_EVERYTHING.includes(p));
  if (forced) {
    return {
      run: steps,
      selected: conditional.map(([label]) => ({ label, by: forced, because: 'the build or the selection itself changed' })),
      everything: true,
    };
  }
  const selected = [];
  for (const [label, , args, covers] of conditional) {
    /* Its own script and that script's helpers, plus the subjects and extra paths it declares. */
    const own = [...localImports(repo, relative(repo, args[args.length - 1]))];
    const patterns = [...own, ...patternsFor(covers)];
    const hit = changed.find((p) => coveredBy(patterns, p));
    selected.push({ label, by: hit ?? null, because: hit ? coveredBy(patterns, hit) : null });
  }
  const dropped = new Set(selected.filter((s) => !s.by).map((s) => s.label));
  return { run: steps.filter(([label]) => !dropped.has(label)), selected, everything: false };
}

/**
 * The paths in the tree that no expensive gate claims and no cheap-tier declaration covers.
 *
 * `population` is the tree as git knows it. `git ls-files` rather than a directory walk, because
 * the build writes KaTeX, mermaid and the editor's chunks into `media/` and those are not sources
 * anybody classifies.
 */
export function unclaimed({ steps, population }) {
  const expensive = steps.filter((s) => Array.isArray(s[3])).flatMap(([, , , covers]) => patternsFor(covers));
  const cheap = CHEAP_ONLY.flatMap((c) => c.patterns.map(checkPattern));
  return population.filter((p) => !coveredBy(expensive, p) && !coveredBy(cheap, p));
}

/** Every file git tracks under the directories the completeness rule covers. */
export function population(repo, dirs = ['src', 'media', 'test']) {
  return execFileSync('git', ['ls-files', ...dirs], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The repository sources a built artefact actually holds, read from the metafile the build wrote. */
export function closureOf(repo, metafile, dirs = ['src/', 'media/', 'test/']) {
  const path = join(repo, metafile);
  if (!existsSync(path)) return null;
  const inputs = JSON.parse(readFileSync(path, 'utf8'))?.inputs;
  if (!inputs) return null;
  return Object.keys(inputs).filter((p) => dirs.some((d) => p.startsWith(d)));
}

/**
 * The sources an artefact is built from that its subject does not cover.
 *
 * The comparison that catches a narrowed mapping, as a function rather than as lines inside
 * `check-gate-tiers.mjs`, for the reason the gates' loop was separated from the gates: a check
 * cannot be asked to fail on demand while the only way to run it is to build the real artefact.
 * The harness suite hands it a metafile of its own and a subject narrowed to one file.
 *
 * `null` for an artefact whose metafile is not there, which the caller reports rather than skips:
 * a subject whose closure was never read is a subject that could have been narrowed to nothing.
 */
export function subjectGaps(repo, subject, artefact) {
  const closure = closureOf(repo, artefact.metafile);
  if (!closure) return null;
  return { closure, missing: closure.filter((p) => !coveredBy(subject.patterns, p)) };
}
