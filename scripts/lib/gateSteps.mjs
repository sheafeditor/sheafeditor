/*
 * The gates, in the order they run, with the mapping beside each one that says which changes it
 * can have something to say about.
 *
 * It lives here rather than in `scripts/gates.mjs` because two things read it: the runner, and
 * `scripts/check-gate-tiers.mjs`, which audits the mapping. `gates.mjs` runs the gates at module
 * scope, so a check importing it would run them, and a second copy of the list for the check to
 * read would be one more thing to drift. The reasoning about each gate stays beside the gate.
 *
 * ## The fourth element
 *
 * `[label, command, arguments]` is a gate that runs on every landing. A fourth element makes it
 * conditional: it names the subjects in `lib/gateTier.mjs` whose change can alter that gate's
 * verdict, plus any extra path the gate reads by name. The gate then runs when the diff touches
 * one of them, and not otherwise. `--all` ignores the whole arrangement.
 *
 * **Absence means it always runs**, and that direction is the point. A new expensive gate whose
 * author forgot the fourth element costs time on every landing, which somebody notices. The
 * opposite default would make the same omission a gate that silently never runs.
 *
 * A gate's own script, and that script's own local imports, are not listed: `selectSteps` reads
 * them off the source. Six of these import `serve-for-check.mjs` and two import
 * `lib/editorDom.mjs`, and a hand-written list of which would be a second copy of import lines
 * that are already in the files.
 *
 * Which gates earn a fourth element is a measurement rather than a judgement. Read it back with
 * `node scripts/gate-timings.mjs`, which reports each gate's median over the runs that did not
 * overlap another one: a handful of these hold almost all of the wall clock and the rest are
 * seconds. `Tests` is the exception that is a judgement: it is expensive and it is unconditional,
 * because it has caught more failures than any other gate here.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const bin = (name) => join(REPO, 'node_modules', '.bin', name);

export const STEPS = [
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
  //
  // The stylesheet is in its covers and it does not mount one: `test/real-editor/unit/host.ts`
  // reads `media/webview.css` as text and asserts on rules in it, which is the kind of dependency
  // a mapping written from what a check looks like would miss. No server, because it drives jsdom.
  ['Editor scenarios (jsdom)', process.execPath, [join(REPO, 'test', 'real-editor', 'run-unit.mjs')], ['editor', 'editor-scenarios', 'stylesheet']],
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
   * The package boundary, beside the bundle size and after the build for the same reason: both read
   * the files a consumer is served rather than a second build of their own.
   *
   * What it catches that nothing else can is the entry's eager closure. A mounted surface renders
   * and becomes an editor on first focus, and the difference between that and an editor that
   * happens to look rendered is invisible on the page: one static import in `src/lib/index.ts`, or
   * `splitting: false` in the library build, makes the claim false with nothing to see.
   */
  ['Package', process.execPath, [join(REPO, 'scripts', 'check-package.mjs')]],
  /*
   * Whether the mapping above still covers what it says it covers, and after the build for the
   * third time on this page: it compares each subject's declared paths against the sources esbuild
   * actually pulled into the artefact, and those come out of the metafiles this run's build wrote.
   * A closure read from an older build is a statement about a tree nobody is landing.
   *
   * It is unconditional, and it has to be. It is the one step standing between the tiering and a
   * gate that quietly stops running, so a tier that decided this gate did not apply would be the
   * mapping vouching for itself.
   */
  ['Gate tiers', process.execPath, [join(REPO, 'scripts', 'check-gate-tiers.mjs')]],
  /*
   * And what a person gets from that arrangement, beside the check that proves it exists. A
   * surface that renders and becomes an editor on first focus has one gesture nothing else covers:
   * the click that builds the editor, whose position the focus event cannot carry. It went nowhere,
   * so the first sentence a person typed into a description was inserted at the top of it however
   * far down they had clicked, and every click after that was correct.
   *
   * A real browser, because the question is a coordinate conversion and jsdom has no layout. The
   * wiring half is in the prose suite, which runs whether there is a browser here or not.
   */
  ['Mounted click', process.execPath, [join(REPO, 'scripts', 'check-mount-click.mjs')]],
  /*
   * And the other thing a consumer is handed, which is a surface the size of what it holds. A
   * `field` used to take its one line from 18px to 480px on first focus, because all three profiles
   * installed the writing column whole, and no height a consumer set could fix it.
   *
   * It reads the scroller's padding and not only the height, which is the whole reason it is here
   * rather than being left to a number somebody checks by eye: flattening the column everywhere is
   * the wrong way to make the field short, and it leaves the `document` profile's height unchanged
   * at 963px, because the editor fills the page. A check reading heights alone passes over that.
   */
  ['Field height', process.execPath, [join(REPO, 'scripts', 'check-field-height.mjs')]],
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
  //
  // The editor and nothing else. It mounts under jsdom through `lib/editorDom.mjs`, so no
  // stylesheet is applied and no rule in one can change what it reads, and it serves no page.
  // Measured rather than assumed: a stylesheet gutted on purpose left this gate's ledger
  // unchanged while a browser-driven gate failed on the same tree.
  ['Editing matrix', process.execPath, ['--max-old-space-size=8192', join(REPO, 'scripts', 'check-editing.mjs')], ['editor']],
  // After the build, because it serves the built files, and last because it is the
  // only step that needs a browser. Without one it says so and passes: a missing
  // Chrome is not a broken document.
  ['Touch layout', process.execPath, [join(REPO, 'scripts', 'check-touch.mjs')]],
  // Beside it, and for the same reason: whether a page of document comes back to where it
  // started is a question about how tall each drawn line is, so jsdom cannot answer it and
  // no suite here can. It went wrong once and only a person reading noticed.
  //
  // The six gates that take a page from the local server read three subjects between them: the
  // editor bundle they mount, the stylesheet the page links, and the server and host shim that
  // serve both. All three come from `serve-for-check.mjs`, which every one of them imports, and
  // `selectSteps` reads that import rather than taking it on trust from here.
  ['Paging', process.execPath, [join(REPO, 'scripts', 'check-paging.mjs')], ['editor', 'stylesheet', 'server']],
  // And beside those two: which of a line's two identical-looking positions an arrow key
  // lands on, read from what the next keystroke wrote to the file. The markers are hidden
  // by decorations, so the question is geometric and jsdom cannot ask it. One keystroke
  // used to destroy a heading.
  ['Caret at markers', process.execPath, [join(REPO, 'scripts', 'check-caret.mjs')], ['editor', 'stylesheet', 'server']],
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
  ['Diagrams', process.execPath, [join(REPO, 'scripts', 'check-diagrams.mjs')], ['editor', 'stylesheet', 'server']],
  // And what typing in a table cell does to the columns beside it, which is a drawn width
  // and so invisible to jsdom, and which no suite could reach anyway: createColumnLayout
  // is exported to no test entry.
  ['Table widths', process.execPath, [join(REPO, 'scripts', 'check-table-widths.mjs')], ['editor', 'stylesheet', 'server', 'sample/edge/markdown-torture.md']],
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
  ['Sticky header', process.execPath, [join(REPO, 'scripts', 'check-sticky-header.mjs')], ['editor', 'stylesheet', 'server']],
  // And whether every child of a table's frame lines up with the table inside it. A frame wide
  // enough to use the pane escapes the writing column by negative margins, so each of its children
  // starts at the pane's edge unless it takes that inset back. Four findings in one week were four
  // children that did not, each found by somebody noticing it looked wrong, and a fifth was in the
  // tree throughout. The obligation is stated nowhere in the stylesheet, so it is stated here.
  // Whether the editor the checks mount is the editor the product mounts. `viewBlocks` was composed
  // in main.ts's own array rather than inside editorExtensions, so every jsdom mount drew a `view`
  // fence as a code block and check-render reported four of them clean. This compares the two
  // closures for modules that draw, so the next extension in the wrong array fails on the day it is
  // written rather than when somebody writes a probe for whatever it draws.
  ['Editor is whole', process.execPath, [join(REPO, 'scripts', 'check-editor-whole.mjs')]],
  ['Frame children', process.execPath, [join(REPO, 'scripts', 'check-wrap-children.mjs')], ['editor', 'stylesheet', 'server']],
  // And whether a resource fetched after the editor is running recovers from one failure. Both the
  // emoji table and KaTeX discarded the rejection and left `pending` holding a settled promise, so
  // a single flake meant that editor never drew an emoji or an equation again, silently. The
  // obvious check for it cannot fail — a blocked fetch drawing nothing is correct — so this drives a
  // loader that fails once and then succeeds, and asserts on the second attempt.
  ['Lazy retry', process.execPath, [join(REPO, 'scripts', 'check-lazy-retry.mjs')]],
];
