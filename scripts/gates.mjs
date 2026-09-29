/*
 * The gates every change has to pass, in one command: the public documentation
 * check, the generated files, the type check, all the test suites, then the
 * production build.
 *
 *   npm run gates
 *
 * One command rather than several chained together, because a chain of shell
 * commands is harder for both people and tooling to approve, and because the
 * steps must not overlap: `npm test` and `npm run build` both drive esbuild over
 * this checkout, and running them at once makes the test run print no counts and
 * the build end in a stack trace with nothing actually wrong.
 *
 * Everything it runs is in this repository. Stops at the first failure and exits
 * with that step's code.
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
import { complaintFor, readVerdict } from './lib/gateOutput.mjs';

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
  ['Type check', bin('tsc'), ['--noEmit']],
  ['Tests', process.execPath, [join(REPO, 'scripts', 'run-tests.mjs')]],
  // The jsdom half of the real-editor scenarios: every area, about half a minute.
  // It fails on any failing scenario, so the count it reports is the whole of it.
  ['Editor scenarios (jsdom)', process.execPath, [join(REPO, 'test', 'real-editor', 'run-unit.mjs')]],
  ['Build', process.execPath, [join(REPO, 'esbuild.mjs'), '--production']],
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

const skipped = [];

for (const [label, cmd, args] of STEPS) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = await run(cmd, args);
  if (r.status !== 0) {
    /*
     * Name the signal when there is one. A step killed for memory exits without
     * printing, and a bare "failed" then reads as a regression in whatever was being
     * worked on: an hour of reading a diff with nothing wrong in it. `SIGKILL` or
     * `SIGABRT` here is recognisable in seconds.
     */
    const how = r.signal ? ` (killed by ${r.signal})` : r.status === 134 ? ' (aborted: out of heap, most likely)' : '';
    process.stderr.write(`\n${label} failed${how}\n`);
    if (r.signal || r.status === 134) {
      process.stderr.write(
        'A step that was killed has not reported anything about your change. Run it on its\n' +
          'own before reading the diff, and use the repository\'s own command rather than a\n' +
          'hand-assembled node invocation, which is how a stale heap flag gets carried in.\n'
      );
    }
    process.exit(r.status ?? 1);
  }
  /*
   * A step can be green and have measured nothing, and the exit status cannot tell you.
   * `readVerdict` names the three shapes that takes: a skip, which is collected and reported
   * at the end with the others, and a silent step or a count of zero, which fail here. A step
   * that printed nothing or counted to zero has reported nothing about the change being landed.
   */
  const verdict = readVerdict(r.seen);
  for (const why of verdict.skipped) skipped.push(`${label}: ${why}`);
  const complaint = complaintFor(label, verdict);
  if (complaint) {
    process.stderr.write(`\n${complaint}\n`);
    process.exit(1);
  }
}

if (skipped.length) {
  process.stderr.write(`\n${skipped.length} step${skipped.length > 1 ? 's' : ''} did not run:\n`);
  for (const s of skipped) process.stderr.write(`  - ${s}\n`);
  process.stderr.write(
    '\nA step that did not run has not passed, and these are the checks jsdom cannot\n' +
      'stand in for. Fix what they are missing, or set SHEAF_ALLOW_SKIPPED_GATES=1 to\n' +
      'accept the gap for this run and say so wherever you report the result.\n'
  );
  if (process.env.SHEAF_ALLOW_SKIPPED_GATES !== '1') process.exit(1);
  process.stdout.write('\nAll gates passed, with the skipped steps above allowed\n');
} else {
  process.stdout.write('\nAll gates passed\n');
}
