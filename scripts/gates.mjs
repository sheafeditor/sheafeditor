/*
 * The gates every change has to pass, in one command: the public documentation
 * check, the generated files, the type check, all the test suites, then the
 * production build.
 *
 *   npm run gates            stops at the first failure, for a person at a terminal
 *   npm run gates -- --all   runs every gate and reports all of them, which is what CI does
 *
 * One command rather than several chained together, because a chain of shell
 * commands is harder for both people and tooling to approve, and because the
 * steps must not overlap: `npm test` and `npm run build` both drive esbuild over
 * this checkout, and running them at once makes the test run print no counts and
 * the build end in a stack trace with nothing actually wrong.
 *
 * Everything it runs is in this repository. By default it stops at the first failure
 * and exits with that step's code; every run ends by saying how many of the gates it
 * reached, because "all gates passed" is the same sentence whether that was nine or
 * twenty-three.
 *
 * A step that *skips* is not a step that passed. Five of these are browser-driven,
 * and each one skips and exits 0 when it cannot find Chrome or `playwright-core`.
 * Those five are the whole layout half of the bar, and jsdom can see none of what
 * they cover, so one missing dependency used to take all five out at once and the
 * run still said "All gates passed". This reads each step's output for the line the
 * scripts already print and refuses to claim success when one appears.
 *
 * Reading the output rather than checking whether Chrome is installed, on purpose:
 * it detects the event rather than predicting its cause, so a future reason to skip
 * is caught without this file knowing about it.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runGates } from './lib/gateRun.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = (name) => join(REPO, 'node_modules', '.bin', name);

const STEPS = [
  // First because it is the cheapest, and because a page that should not ship
  // is worth hearing about in a second rather than after the suites.
  ['Docs', process.execPath, [join(REPO, 'scripts', 'check-docs.mjs')]],
  // The same private terms as the docs check, across everything that ships rather than `docs/`
  // alone. Two tracker ids had shipped in comments outside `docs/`, which is the only reason
  // they survived: the rule that would have caught them was already written down.
  ['Private terms', process.execPath, [join(REPO, 'scripts', 'check-private-terms.mjs')]],
  // Also cheap, and a clash here makes every later result untrustworthy: two scenarios
  // under one id means a run reports one of them and the other is never asked for.
  ['Scenario ids', process.execPath, [join(REPO, 'scripts', 'check-scenarios.mjs')]],
  // Cheap too, and it catches the quietest kind of drift: a feature documented for a reader
  // who then has nothing in the corpus to open. Four features shipped that way before this
  // existed, because nothing was comparing the two directories.
  ['Feature samples', process.execPath, [join(REPO, 'scripts', 'check-samples.mjs')]],
  // Cheap as well, and the one generated file in `src/`: the emoji table is written
  // from gemoji and committed, so an upgrade of that dependency that nobody
  // regenerated after would otherwise ship a table quietly older than the lock file.
  ['Emoji table', process.execPath, [join(REPO, 'scripts', 'gen-emoji.mjs'), '--check']],
  // Cheap and static: a padding written for an editor line in the stylesheet, without naming
  // `.cm-line`, loses to CodeMirror's own rule and never reaches the screen. One had been losing
  // silently, so a reader of the stylesheet believed a number the product ignored.
  ['Line padding', process.execPath, [join(REPO, 'scripts', 'check-css-line-padding.mjs')]],
  /*
   * The dialect may not reach an editor. Cheap, static, and ahead of the type check because it is
   * about what a module is allowed to import rather than about whether it compiles: a grammar that
   * pulls `@codemirror/view` type-checks perfectly and costs every consumer 70 KB.
   */
  ['Dialect imports', process.execPath, [join(REPO, 'scripts', 'check-dialect-imports.mjs')]],
  ['Field imports', process.execPath, [join(REPO, 'scripts', 'check-field-imports.mjs')]],
  ['Render safety', process.execPath, [join(REPO, 'scripts', 'check-render-safety.mjs')]],
  ['Type check', bin('tsc'), ['--noEmit']],
  /*
   * The suites' own TypeScript, which until 2026-10-02 nothing compiled: `tsconfig.json` includes
   * `src` alone, and esbuild strips types without checking them, so a type error in any of the 74
   * `.ts` files under `test/` was invisible unless it also broke at runtime. Two configs rather than
   * one include, because the build's `rootDir` is `src` and its `outDir` is `dist`, and this must
   * not change a byte of what ships.
   */
  ['Type check (tests)', bin('tsc'), ['-p', join(REPO, 'tsconfig.test.json')]],
  ['Tests', process.execPath, [join(REPO, 'scripts', 'run-tests.mjs')]],
  // The jsdom half of the real-editor scenarios: every area, about half a minute.
  // It fails on any failing scenario, so the count it reports is the whole of it.
  ['Editor scenarios (jsdom)', process.execPath, [join(REPO, 'test', 'real-editor', 'run-unit.mjs')]],
  ['Build', process.execPath, [join(REPO, 'esbuild.mjs'), '--production']],
  /*
   * What a consumer downloads to start editing, against the size committed beside it. A gate rather
   * than part of `npm test`, for one reason: it measures the built files, and `npm test` runs before
   * the build. Reading an older build would be worse than not reading one, because the number would
   * be real and about the wrong tree.
   *
   * It ratchets rather than gates: being over budget is reported on every run and only growth fails,
   * so a kilobyte added without a word in the diff stops the landing and a deliberate increase is a
   * line somebody reads.
   */
  ['Bundle size', process.execPath, [join(REPO, 'scripts', 'check-bundle-size.mjs')]],
  /*
   * The site demo's host against the wire it implements. It is the third host and the only one no
   * type reaches: hand-written JavaScript in a repository that does not depend on this one, so a
   * message added here is a compile error in two hosts and silence in the third.
   *
   * It skips, loudly, when the site checkout is not beside this one, so a clone of this repository
   * passes its gates on its own.
   */
  ['Demo host', process.execPath, [join(REPO, 'scripts', 'check-demo-host.mjs')]],
  // The corpus read through the editor's own live preview: a construct that quietly falls
  // back to showing its Markdown is a regression a person sees and no unit check does. It
  // costs about a second. It was not here before, and that is exactly why its own
  // known-gaps list went stale: footnotes shipped, the list still called them unrendered,
  // and the script had been saying so to nobody for days.
  ['Rendered corpus', process.execPath, [join(REPO, 'scripts', 'check-render.mjs')]],
  // The same corpus question asked of keystrokes rather than of documents: what every
  // gesture, at every caret position an arrow walk reaches, does to the drawn page. It
  // holds a ledger of what fails today and fails when a count moves in either direction,
  // so it catches a regression and an unrecorded fix alike. About a minute, and it needs
  // the larger heap for the same reason the suites do: it mounts eleven thousand editors.
  ['Editing matrix', process.execPath, ['--max-old-space-size=8192', join(REPO, 'scripts', 'check-editing.mjs')]],
  // After the build, because it serves the built files, and last because it is the
  // only step that needs a browser. Without one it says so and passes: a missing
  // Chrome is not a broken document.
  ['Touch layout', process.execPath, [join(REPO, 'scripts', 'check-touch.mjs')]],
  // Beside it, and for the same reason: whether a page of document comes back to where it
  // started is a question about how tall each drawn line is, so jsdom cannot answer it and
  // no suite here can. It went wrong once and only a person reading noticed.
  ['Paging', process.execPath, [join(REPO, 'scripts', 'check-paging.mjs')]],
  // And beside those two: which of a line's two identical-looking positions an arrow key
  // lands on, read from what the next keystroke wrote to the file. The markers are hidden
  // by decorations, so the question is geometric and jsdom cannot ask it. One keystroke
  // used to destroy a heading.
  ['Caret at markers', process.execPath, [join(REPO, 'scripts', 'check-caret.mjs')]],
  // And beside those: where a line's words start, across every marker and every nesting
  // level. A marker is drawn by a decoration and the indent is a computed padding, so what
  // a reader has is a drawn position and jsdom has no layout to read it from. Every
  // horizontal position in the editor used to be decided separately, nine of them, no two
  // agreeing, and a wrapped list line returned to the margin.
  // Both axes: where a line's words start, and how far apart one line sits from the next.
  ['Indent and rhythm', process.execPath, [join(REPO, 'scripts', 'check-indent.mjs')]],
  // And beside it: whether code in a fenced block is coloured at all. Syntax colouring is the
  // one feature that can be entirely absent while looking present, because the grammars attach,
  // every token gets a class, and a palette that resolves to one grey throws all of it away.
  // Five token types shipped drawn in body-text grey.
  ['Code colours', process.execPath, [join(REPO, 'scripts', 'check-code-colours.mjs')]],
  // And beside it: whether a table's hover bar can be pressed from any direction. The bar
  // floats clear of the table, so a button's middle is over the line above, and whether it was
  // alive depended on where the pointer had come from. Nothing about that is visible in the
  // drawing: the bar and the button are both drawn and the geometry is right.
  ['Hover bar', process.execPath, [join(REPO, 'scripts', 'check-hover-bar.mjs')]],
  // And the one part of diagrams no jsdom scenario can reach, because they all replace
  // the loader: working out where the editor's own files are, which is what splitting
  // the bundle into modules silently broke in every host.
  ['Diagrams', process.execPath, [join(REPO, 'scripts', 'check-diagrams.mjs')]],
  // And what typing in a table cell does to the columns beside it, which is a drawn width
  // and so invisible to jsdom, and which no suite could reach anyway: createColumnLayout
  // is exported to no test entry.
  ['Table widths', process.execPath, [join(REPO, 'scripts', 'check-table-widths.mjs')]],
  // And whether Edit Markdown in an open cell shows that cell's source rather than the whole
  // table's. The rendered and revealed readings are the same text with and without its
  // markers, so the question is what is drawn, and the cell below has to stay drawn to tell
  // one cell's reveal from the table's.
  ['Cell source', process.execPath, [join(REPO, 'scripts', 'check-cell-source.mjs')]],
  // And whether a card dragged across a board is carried while the pointer is down. The file
  // ends up right either way, which is the whole difficulty: the defect lived entirely in the
  // half-second between the press and the release, so every reading it takes is taken mid-drag.
  ['Board drag', process.execPath, [join(REPO, 'scripts', 'check-board-drag.mjs')]],
  // And whether a tall table's held header stays in one place while the document scrolls past
  // it. Every frame of a flicker is individually correct and only the sequence is wrong, so
  // this reads a run of states rather than a state.
  ['Sticky header', process.execPath, [join(REPO, 'scripts', 'check-sticky-header.mjs')]],
  // And whether every child of a table's frame lines up with the table inside it. A frame wide
  // enough to use the pane escapes the writing column by negative margins, so each of its children
  // starts at the pane's edge unless it takes that inset back. Four findings in one week were four
  // children that did not, each found by somebody noticing it looked wrong, and a fifth was in the
  // tree throughout. The obligation is stated nowhere in the stylesheet, so it is stated here.
  ['Frame children', process.execPath, [join(REPO, 'scripts', 'check-wrap-children.mjs')]],
  // And whether a resource fetched after the editor is running recovers from one failure. Both the
  // emoji table and KaTeX discarded the rejection and left `pending` holding a settled promise, so
  // a single flake meant that editor never drew an emoji or an equation again, silently. The
  // obvious check for it cannot fail — a blocked fetch drawing nothing is correct — so this drives a
  // loader that fails once and then succeeds, and asserts on the second attempt.
  ['Lazy retry', process.execPath, [join(REPO, 'scripts', 'check-lazy-retry.mjs')]],
];

/**
 * Run one step, passing its output straight through as it arrives so nothing is
 * buffered, while keeping a copy to read afterwards.
 */
function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: ['inherit', 'pipe', 'pipe'] });
    let seen = '';
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        seen += chunk;
        out.write(chunk);
      });
    }
    child.on('close', (status, signal) => done({ status, signal, seen }));
    child.on('error', (err) => done({ status: 1, seen: `${seen}\n${err.message}` }));
  });
}

/*
 * Which skips are forgiven, and why the answer is a list rather than a flag.
 *
 * `SHEAF_ALLOW_SKIPPED_GATES=1` forgives every skip, which is the blunt instrument and is
 * kept for a local run somebody is deliberately doing without a browser. A runner needs
 * something narrower: the private-terms list lives outside the repository on purpose, so it
 * can never exist there and that one step can never run, while the five browser checks
 * skipping on a runner is a real gap and has to keep failing. Forgiving all of them to get
 * past one would put back exactly the hole `A skipped gate is not a passed gate` closed.
 *
 * So the variable also takes the labels it forgives, comma-separated. A step not named
 * stops the run as before.
 */
const ALLOWED = (process.env.SHEAF_ALLOW_SKIPPED_GATES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const forgiven = (label) => ALLOWED.includes('1') || ALLOWED.includes(label);

/*
 * Two modes, differing only in what happens after a gate fails.
 *
 * The default stops there, which is right for a person at a terminal: the first failure is
 * usually the thing they just did, and twenty more minutes of gates does not help them fix it.
 *
 * `--all` runs every gate and reports all of them, which is right for CI, where nobody is waiting
 * at a prompt and the run is the only record. A run that stops at the first failure hides
 * everything behind it for as long as that failure lives, and nothing reported the number that
 * went dark. From 2026-09-23 to 2026-09-30 every run on `main` died at gate 9 of 23, so fourteen
 * gates did not run on a Linux runner for a week. One of them pressed a macOS-only chord and
 * reported the product broken; that defect failed three release cuts, and it is tempting to say
 * CI should have caught it. CI could not: the gate was nineteen positions behind a failure that
 * had nothing to do with it.
 *
 * **Under `--all` a failure cascades, and that is accepted rather than worked around.** Eleven of
 * these gates serve the built files, so a failing `Build` fails them too. The alternative is a
 * dependency graph between gates, which would be a second description of the order they are
 * already written in, and it would go stale. A reader of a CI log sees `Build` first in the list,
 * which is the one to fix.
 *
 * The loop itself is in `lib/gateRun.mjs` so that it can have a control: what it decides is which
 * gates get reached, and asking that of the real gates would mean ten minutes and no way to make
 * one fail at position 21 on demand. The harness suite drives it with steps that fail where it
 * wants them to.
 */
const ALL = process.argv.includes('--all') || process.env.SHEAF_GATES_ALL === '1';

const { status } = await runGates({
  steps: STEPS,
  run,
  all: ALL,
  forgiven,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exit(status);
