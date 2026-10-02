/*
 * Which lines show their Markdown when the caret is on each line in turn.
 *
 * The reveal rule is the heart of this product and it exists as code and as the comments around it.
 * Part 2 of the specification has to state it over bytes and caret positions, and the first part of
 * that document was written by reading the modules and was wrong three times. So this derives the
 * rule instead: a fixture holding one of each construct, the caret put on every line, and a record
 * of which lines a person can see the markup of.
 *
 * What is reported is what the **caret changes**: each line's resting state is read with the caret
 * parked where it reveals nothing, and a reveal is a line whose state differs from resting. An
 * absolute reading of "the drawn text equals the source" is true of any line with no markup to hide,
 * so it called every blank line and every plain sentence a reveal. The first version asked whether the line held a
 * `.tok-mark` and was blind to every construct whose marker carries another class: a quote, a table
 * and a fence all came back showing nothing with the caret inside them, which reads exactly like a
 * reveal rule that skips them.
 *
 * It reports rather than asserts. The output is the table Part 2 needs, and a rule nobody has
 * written down yet cannot be checked against; once the document states it, this is what a check
 * would compare against.
 *
 * **One limitation, and it decides which rows of the output are usable.** This runs under jsdom, which
 * has no layout, so a construct drawn as a block widget may not mount at all. The pipe table's first
 * two lines rest as `source` here, which for a table drawn as a grid they would not: the grid is
 * probably not mounted, so the table's rows say nothing about the product and are left in the output
 * rather than filtered, because a missing row would be read as a construct nobody tested. Anything
 * resting as `source` that holds markup is the tell, and so is the table's third row in the drawing
 * table below: it keeps its pipes and hides only the emphasis inside the cells, which is the row
 * drawn as prose rather than as a grid.
 *
 *   node scripts/check-reveal.mjs
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of ['getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'DocumentFragment', 'Text']) {
  if (window[key]) globalThis[key] = window[key];
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { revealMap, drawMap } = createRequire(import.meta.url)(join(REPO, 'test', 'bundle.cjs'));

/*
 * One of each construct, with **markup on every line of every multi-line one**.
 *
 * That is the whole difficulty of this fixture and the first version got it wrong. A difference
 * reading cannot tell "this line was not revealed" from "this line had nothing to reveal", so a
 * paragraph whose second line is plain prose, or a list continuation with no marker on it, reports
 * the same thing either way. The question being asked is the granularity, so every line that the
 * rule might or might not include has to carry something hideable.
 */
const DOC = [
  'A paragraph with **bold** in it,', //        1
  'and *more* on its second line.', //         2
  '', //                                       3
  '## A heading with `code` in it', //          4
  '', //                                       5
  '> A quote with **bold**,', //                6
  '> and *more* on its second line.', //       7
  '', //                                       8
  '- an item with **bold**', //                9
  '  and *more* on its continuation', //      10
  '  - nested, with `code`', //               11
  '', //                                      12
  '| a | b |', //                             13
  '| - | - |', //                             14
  '| **x** | *y* |', //                       15
  '', //                                      16
  '```js', //                                 17
  'const x = 1;', //                          18
  '```', //                                   19
  '', //                                      20
  'A line with `code` and [a link](x.md).', // 21
  '', //                                      22
  '- [ ] a task, with **bold**', //           23
  '', //                                      24
  '---', //                                   25
  '', //                                      26
  '![alt text](picture.png)', //              27
].join('\n');

/*
 * The last three were appended rather than inserted, so the line numbers quoted elsewhere still mean
 * what they said. They are here because the first fixture held nothing that is *replaced*: a task's
 * checkbox, a horizontal rule and a picture are drawn as things that were never in the file, and
 * without one of each the half of this contract about replacement was unexercised while looking
 * covered.
 */

const lines = DOC.split('\n');
const label = (n) => `${String(n).padStart(2)} ${JSON.stringify(lines[n - 1]).slice(0, 34).padEnd(36)}`;

/** A set of line numbers as a reader wants it: ranges rather than a list. */
const ranges = (ns) => {
  if (!ns.length) return 'nothing';
  const out = [];
  let from = ns[0];
  let prev = ns[0];
  for (const n of ns.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(from === prev ? `${from}` : `${from}-${prev}`);
    from = n;
    prev = n;
  }
  out.push(from === prev ? `${from}` : `${from}-${prev}`);
  return out.join(', ');
};

for (const { reveal, how } of [
  { reveal: true, how: 'caret' },
  { reveal: true, how: 'selection' },
  { reveal: true, how: 'command' },
  { reveal: false, how: 'command' },
  { reveal: false, how: 'caret' },
]) {
  const { resting, rows } = revealMap(DOC, { reveal, how });
  console.log(`\nrevealSyntaxOnLine ${reveal ? 'on' : 'off, which is the default'}, by ${how}:\n`);
  let anySource = false;
  for (const { line, changed } of rows) {
    anySource = anySource || changed.length > 0;
    if (!changed.length && !reveal) continue;
    // Printed even when nothing changed, so a line that is never revealed is distinguishable from one
    // that is always showing its source.
    console.log(`  ${how === 'selection' ? 'from' : how === 'command' ? 'command at' : 'caret on'} ${label(line)} reveals ${ranges(changed)}  (at rest this line is ${resting[line - 1]})`);
  }
  if (!anySource) console.log('  the caret reveals nothing wherever it goes.');
}

/*
 * The second table is the control for the first. With the setting off, the default, nothing should
 * reveal from the caret at all, and a run where both tables look alike would mean this instrument is
 * reading something other than the setting.
 */
console.log('\nThe last table is the control: with the setting off nothing should reveal from the caret.');
console.log('The selection table answers R3, "every block a selection touches", which the caret table cannot.');

/*
 * And the other half of the rendering contract: what a reader sees in place of what is in the file.
 *
 * Printed as the two strings beside each other rather than as a verdict, because the difference is
 * the content of the rule: a marker that is hidden leaves shorter text, and a widget leaves an
 * element that was never in the file.
 *
 * Three wrong readings of the widget column before this one, each of which looked like a finding:
 * collecting classes that begin `md-` missed the bullet a list marker is replaced by; reading text
 * alone reported nothing for the three constructs that carry none, which are a task's checkbox, a
 * horizontal rule and a picture; and a picture built no widget at all because the base its path
 * resolves against arrives in `init` and nothing sends one here, so the line read as an editor that
 * draws alt text instead of a picture. The last one is the shape to watch for: a missing precondition
 * and a product that does not do the thing read identically.
 */
console.log('\n\nWhat is drawn in place of what, at rest:\n');
for (const { line, source, drawn, widgets } of drawMap(DOC)) {
  if (source === drawn && !widgets.length) continue;
  const w = widgets.length ? `  widgets ${widgets.join(' ')}` : '';
  console.log(`  ${String(line).padStart(2)} ${JSON.stringify(source).padEnd(38)} drawn as ${JSON.stringify(drawn)}${w}`);
}
console.log('\n  A line left out of this list is drawn exactly as it is written.');
