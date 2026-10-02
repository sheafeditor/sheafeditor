/*
 * What Enter writes, position by position, as bytes.
 *
 * Part 3 of the specification owes a table per command and this derives the first one. Enter is the
 * right one to start with: it has four handlers in a defined order, none of them waits on work still
 * being decided, and it is the key a person presses most without thinking about it.
 *
 * It reports rather than asserts, which is the same choice `check-reveal.mjs` made and for the same
 * reason: a rule nobody has written down cannot be checked against, and this exists to write it down.
 * Once the table is in the document the comparison is one step from here.
 *
 * **Three caret positions per line**, the start, the middle and the end, because Enter's answer
 * depends on where in the line it is pressed and a table taken only at line ends would say the
 * handlers are simpler than they are.
 *
 * **A fresh editor per position.** Enter changes the document, so a loop reusing one editor measures
 * the second position against a document this script made rather than against the fixture. That is
 * the mistake that makes a derivation read as a cascade of unrelated behaviour.
 *
 *   node scripts/check-enter.mjs
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of ['getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment', 'Text']) {
  if (window[key]) globalThis[key] = window[key];
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { keyMap } = createRequire(import.meta.url)(join(REPO, 'test', 'prose.bundle.cjs'));

/*
 * One of each block Enter is known to treat specially, and nothing else.
 *
 * The four handlers are ending an empty block, opening a line above a marker, breaking at a callout's
 * marker, and splitting a line while keeping its runs. So the fixture needs an empty list item, a
 * line carrying a marker, a callout, and a line with a run on it that a split could break.
 */
/*
 * Characters made of several code points, each at the end of its line on purpose.
 *
 * The end is where a person is when they have just typed one and press Backspace, which is the
 * gesture that loses a piece of the character, so the table's `end` row is the one that answers it. A
 * fixture with words after the character tests the middle instead and says nothing about that.
 */
const GRAPHEME = [
  'AB\u{1F44D}\u{1F3FD}', //            a thumb with a skin tone, two code points
  'AB\u0065\u0301', //                  an e with a combining acute, also two
  'AB\u{1F469}\u200D\u{1F4BB}', //     a woman technologist, three joined by a zero-width joiner
  'AB\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', // a tag sequence, seven
].join('\n');

/*
 * What the public page claims about Tab, as a fixture.
 *
 * `docs/features/typing-markdown.md` makes four claims in prose and nothing checks them against the
 * code: Tab nests a list item under the one above, Shift+Tab brings it back, Tab does nothing on a
 * paragraph, a heading or a list's first item, and inside a code block it indents the line. Each line
 * here is one of those cases.
 */
const TAB = [
  'A paragraph.', //          1  the page says nothing happens
  '', //                      2
  '## A heading', //          3  the page says nothing happens
  '', //                      4
  '- first', //               5  the page says nothing happens, being the first item
  '- second', //              6  the page says this nests under the first
  '  - third', //             7  already nested one level
  '', //                      8
  '```js', //                 9
  'const x = 1;', //         10  the page says this indents
  '```', //                  11
].join('\n');

/*
 * What a hard break looks like before Shift+Enter is pressed.
 *
 * Markdown has two spellings for one and Sheaf writes one of them, so the table has to say which, and
 * what happens on a line that already ends in the other. Neither question is answered by any page.
 * The trailing spaces on the second line are the point of it and must survive an editor that trims.
 */
const BREAKS = [
  'A plain line.', //                 1  nothing at the end
  'Ends in two spaces.  ', //         2  already a hard break, the space spelling
  'Ends in a backslash.\\', //        3  already a hard break, the other spelling
  'Ends in one space. ', //           4  one space, which is not a break
  '- an item', //                     5  inside a list
  '> a quote', //                     6  inside a quote
].join('\n');

const DOC = [
  'A paragraph with **bold** in it.', //  1  a run a split could break
  '', //                                 2  between blocks
  '- an item', //                        3  a list item with words
  '- ', //                               4  an empty item, which ends the list
  '', //                                 5
  '> [!NOTE]', //                        6  a callout's marker
  '> its words', //                      7  inside the callout
  '', //                                 8
  '1. first', //                         9  an ordered item
  '', //                                10
  '| a | b |', //                       11  a table row
  '| - | - |', //                       12
  '', //                                13
  '```js', //                           14  inside a fence
  'const x = 1;', //                    15
  '```', //                             16
].join('\n');

const show = (s) => JSON.stringify(s);

/**
 * What changed between two documents, as the lines a reader wants rather than two whole files.
 *
 * The prefix and suffix walks have to be stopped from meeting, which the first version did not do: on
 * an insertion they overlapped and the report came out as `"" -> ""`, which is the one answer that
 * tells a reader nothing while looking like a measurement. The guard is that the two walks together
 * may not consume more than the shorter document.
 */
function changed(before, after) {
  if (before === after) return 'nothing';
  const a = before.split('\n');
  const b = after.split('\n');
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  let j = 0;
  while (j < limit - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const from = a.slice(i, a.length - j);
  const to = b.slice(i, b.length - j);
  const at = `line ${i + 1}`;
  if (from.length === 0) return `${at}: inserted ${show(to.join('\\n'))}`;
  if (to.length === 0) return `${at}: removed ${show(from.join('\\n'))}`;
  return `${at}: ${show(from.join('\\n'))} -> ${show(to.join('\\n'))}`;
}

/*
 * The key is an argument so the two states that are not "wrote bytes" can be exercised from the
 * command line rather than by editing the harness. `Mod-/` opens the shortcuts overlay, so it is
 * handled and touches no document bytes; `F7` is bound by nothing. Both were temporary edits the
 * first time and are a flag now, because a control somebody has to hand-edit is a control nobody
 * re-runs.
 *
 *   node scripts/check-enter.mjs            Enter
 *   node scripts/check-enter.mjs Backspace  any other key
 */
const KEY = process.argv[2] ?? 'Enter';
/*
 * Backspace gets its own fixture, because what is interesting about it is characters made of several
 * code points and the block fixture holds none. A skin-tone emoji and a combining accent are each
 * known to lose a piece rather than going, and this is where that is confirmed at byte level or found
 * fixed.
 */
const FIXTURE =
  KEY === 'Backspace'
    ? GRAPHEME
    : KEY === 'Tab' || KEY === 'Shift-Tab'
      ? TAB
      : KEY === 'Shift-Enter'
        ? BREAKS
        : DOC;
const rows = keyMap(FIXTURE, KEY);
console.log(`What ${KEY} writes, ${rows.length} caret positions over ${FIXTURE.split('\n').length} lines:\n`);

let lastLine = 0;
for (const r of rows) {
  if (r.line !== lastLine) {
    console.log(`\n  line ${String(r.line).padStart(2)}  ${show(r.before)}`);
    lastLine = r.line;
  }
  const where = r.col === 0 ? 'start ' : r.col >= r.before.length ? 'end   ' : `col ${String(r.col).padStart(2)}`;
  /*
   * An unchanged document has two causes and they are different answers. A handler that ran and
   * decided to write nothing is a rule; no handler wanting the key is a gap. Printing one word for
   * both lets a reader take whichever reading suits them.
   */
  const what =
    r.after !== FIXTURE
      ? changed(FIXTURE, r.after)
      : r.handled
        ? 'handled, and wrote nothing'
        : 'NO BINDING TOOK THE KEY, so the editor let it through';
  console.log(`      ${where}  ${what}`);
}

const quiet = rows.filter((r) => r.after === FIXTURE);
console.log(
  `\n  ${rows.length} positions, ${rows.length - quiet.length} wrote bytes, ` +
    `${quiet.filter((r) => r.handled).length} were handled and wrote none, ` +
    `${quiet.filter((r) => !r.handled).length} were not handled at all.`
);
