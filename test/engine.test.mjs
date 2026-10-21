import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

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

const { run, revealMap } = createRequire(import.meta.url)('./bundle.cjs');

// Each element in its own tiny doc. A leading `.\n\n` keeps the default cursor
// (pos 0) off the element's line, so inactive-line rendering is exercised.
const P = '.\n\n';
const cases = [
  ['heading',    P + '# Title',                      (r) => r.counts.h1 === 1],
  ['bold',       P + 'a **bold** b',                 (r) => r.counts.strong === 1],
  ['italic',     P + 'a _em_ b',                     (r) => r.counts.em === 1],
  ['strike',     P + 'a ~~gone~~ b',                 (r) => r.counts.strike === 1],
  // One tilde is strikethrough too, which is what pins this harness to the
  // dialect the editor reads: the stock Markdown language parses `~gone~` as
  // Pandoc subscript and renders nothing struck through.
  ['oneTilde',   P + 'a ~gone~ b',                   (r) => r.counts.strike === 1],
  ['inlineCode', P + 'a `code` b',                   (r) => r.counts.inlineCode === 1],
  ['link',       P + 'a [text](https://x.com) b',    (r) => r.counts.link === 1],
  ['blockquote', P + '> quoted line',                (r) => r.counts.quote === 1],
  ['bullet',     P + '- one\n- two',                 (r) => r.counts.bullet === 2],
  ['task',       P + '- [ ] todo\n- [x] done',       (r) => r.counts.task === 2],
  ['hr',         P + '---',                          (r) => r.counts.hr === 1],
  ['image',      P + '![alt](https://x.com/i.png)',  (r) => r.counts.img === 1],
  ['codeBlock',  P + '```js\nconst x = 1;\n```',     (r) => r.counts.codeBlock >= 1],
  // Reveal: cursor at pos 2 sits inside the heading, so its `#` marker shows. The only case
  // here that turns `revealSyntaxOnLine` on, and it says so rather than inheriting it: the
  // setting is a module-level variable and this used to read whatever was left there.
  ['reveal',     '# Title',                          (r) => r.revealedMarksOnActiveLine === 1, { reveal: true }],
];

let pass = 0;
for (const [name, text, check, opts] of cases) {
  let ok = false, detail = '';
  try {
    const r = run(text, opts);
    ok = check(r);
    detail = JSON.stringify(name === 'reveal' ? { revealed: r.revealedMarksOnActiveLine } : r.counts);
  } catch (e) {
    detail = 'threw: ' + e.message;
  }
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(11)} ${ok ? '' : detail}`);
  if (ok) pass++;
}

/*
 * How far a reveal reaches: the whole block the caret is in, stated as the exact set of lines.
 *
 * `scripts/check-reveal.mjs` derives the same table and prints it for a reader. This asserts it,
 * which is the half that was missing while the rule was written down nowhere: the granularity was a
 * property of four modules and nothing compared it against a sentence. Every case here is an
 * equality against the whole set rather than a membership test, so a reveal that grows is a failure
 * as much as one that shrinks.
 *
 * The fixture's first two lines are a sentence and a blank, which `revealMap` needs: the caret rests
 * on a blank line to take each line's resting state, and a construct holding the resting caret reads
 * as revealed from everywhere.
 */
const REST = '.\n\n';
const granularity = [
  // Every line of a paragraph, from any line of it.
  ['para.first', REST + 'A paragraph with **bold** in it,\nand *more* on its second line.', 3, [3, 4]],
  ['para.second', REST + 'A paragraph with **bold** in it,\nand *more* on its second line.', 4, [3, 4]],
  // Every line of a quote, from any line of it. A quote is one block and the caret is in all of it.
  ['quote.first', REST + '> A quote with **bold**,\n> and *more* on its second line.', 3, [3, 4]],
  ['quote.second', REST + '> A quote with **bold**,\n> and *more* on its second line.', 4, [3, 4]],
  // An item with its continuation and its nested lines, from the item's own line or its continuation.
  ['item.parent', REST + '- an item with **bold**\n  and *more* on its continuation\n  - nested, with `code`', 3, [3, 4, 5]],
  ['item.continuation', REST + '- an item with **bold**\n  and *more* on its continuation\n  - nested, with `code`', 4, [3, 4, 5]],
  // The nested item is a block of its own, so the caret on it reveals it and not its parent's lines.
  ['item.nested', REST + '- an item with **bold**\n  and *more* on its continuation\n  - nested, with `code`', 5, [5]],
  // A fenced block reveals its two fence lines and not the code between them: the code is already
  // drawn as written, so there is nothing of it to show.
  ['fence.open', REST + '```js\nconst x = 1;\n```', 3, [3, 5]],
  ['fence.body', REST + '```js\nconst x = 1;\n```', 4, [3, 5]],
  ['fence.close', REST + '```js\nconst x = 1;\n```', 5, [3, 5]],
];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
for (const [name, text, caret, expected] of granularity) {
  let ok = false, detail = '';
  try {
    const { rows } = revealMap(text, { reveal: true, how: 'caret' });
    const got = rows.find((r) => r.line === caret).changed;
    ok = same(got, expected);
    detail = `caret on ${caret} revealed [${got}], wanted [${expected}]`;
  } catch (e) {
    detail = 'threw: ' + e.message;
  }
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(18)} ${ok ? '' : detail}`);
  if (ok) pass++;
}

/*
 * The control for the ten above, and the reason they are not vacuous.
 *
 * Each of them reads what the caret **changed**, so a build where nothing reveals anywhere would
 * fail them rather than pass them. The opposite mistake is the one worth pinning: the setting is off
 * by default, and a reveal that fired regardless of it would satisfy every case above while being
 * the bug. So the same fixtures are read with the setting off, where the caret must change nothing.
 */
let offOk = true;
let offDetail = '';
for (const [name, text] of granularity) {
  const { rows } = revealMap(text, { reveal: false, how: 'caret' });
  const leaked = rows.filter((r) => r.changed.length);
  if (leaked.length) {
    offOk = false;
    offDetail = `${name}: caret on ${leaked[0].line} revealed [${leaked[0].changed}] with the setting off`;
    break;
  }
}
console.log(`${offOk ? '✅' : '❌'} ${'reveal.off'.padEnd(18)} ${offOk ? '' : offDetail}`);
if (offOk) pass++;

const total = cases.length + granularity.length + 1;
console.log(`\n${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
