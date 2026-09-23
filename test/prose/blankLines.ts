/*
 * Blank lines drawn as the gap between blocks rather than as an empty line of
 * body text.
 *
 * What a reader sees is read back from the editor's own DOM, so a line counts as
 * short only when the class the stylesheet sizes is actually on it. Every check
 * also compares the document with what it was mounted from: this is drawing, and
 * a single byte written would be the bug it exists to prevent.
 *
 * jsdom has no layout, so none of these measures a height. The class is the thing
 * under test here; the pixels, the click that lands on a short line and the arrow
 * keys that cross it are in `test/real-editor/editor/prose.mjs`.
 */

import { Scenario, mountProse } from '../harness';
import { BLANK_LINE_CLASS, isSpacingBlankLine } from '../../src/webview/blankLines';
import { setLivePreviewConfig } from '../../src/webview/livePreview';

type P = ReturnType<typeof mountProse>;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Whether the line numbered `n` (from one, as the document counts them) draws as a gap. */
const short = (p: P, n: number): boolean => lines(p)[n - 1]?.classList.contains(BLANK_LINE_CLASS) ?? false;

/** The document's line numbers that draw as a gap, read back from the DOM. */
const shortLines = (p: P): number[] => lines(p).flatMap((el, i) => (el.classList.contains(BLANK_LINE_CLASS) ? [i + 1] : []));

/**
 * The same, asked of the rule rather than the DOM. For a block that renders as a
 * widget, such as a ```csv grid, the editor draws no line element per document
 * line, so there is nothing in the DOM to read the answer off.
 */
const ruleLines = (p: P): number[] => {
  const state = p.view.state;
  const out: number[] = [];
  for (let n = 1; n <= state.doc.lines; n++) if (isSpacingBlankLine(state, n)) out.push(n);
  return out;
};

/**
 * Mount `doc` with the caret parked on the line numbered `caretLine`, well away
 * from whatever the check is about, and hand the editor to `check`. The document
 * is compared with `doc` afterwards, so no scenario can pass having changed it.
 */
function withDoc(doc: string, caretLine: number, check: (p: P) => boolean): boolean {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  const p = mountProse(doc);
  try {
    p.select(p.view.state.doc.line(caretLine).from);
    return check(p) && p.doc() === doc;
  } finally {
    p.destroy();
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
}

const TWO_PARAGRAPHS = 'First paragraph.\n\nSecond paragraph.';
const HEADING_AND_TABLE = '## Timeline\n\n| Time | Event |\n| :---: | :--- |\n| 01:52 | Beacon normal |';

export const scenarios: Scenario[] = [
  {
    name: 'the blank line between two paragraphs draws as a gap, and the paragraphs do not',
    run: () =>
      withDoc(TWO_PARAGRAPHS, 1, (p) => short(p, 2) && !short(p, 1) && !short(p, 3)),
  },
  {
    name: 'the blank line between a heading and a table draws as a gap',
    run: () => withDoc(HEADING_AND_TABLE, 1, (p) => short(p, 2)),
  },
  {
    name: 'a blank line the caret is on is a full line again, and a gap once the caret leaves',
    run: () =>
      withDoc(TWO_PARAGRAPHS, 1, (p) => {
        const before = short(p, 2);
        p.select(p.view.state.doc.line(2).from);
        const onIt = short(p, 2);
        p.select(0);
        return before && !onIt && short(p, 2);
      }),
  },
  {
    name: 'a selection reaching across a blank line gives it back its height',
    run: () =>
      withDoc(TWO_PARAGRAPHS, 1, (p) => {
        const doc = p.view.state.doc;
        p.select(doc.line(1).from + 2, doc.line(3).from + 3);
        return !short(p, 2);
      }),
  },
  {
    name: 'a blank line inside a fenced code block keeps its height',
    run: () =>
      withDoc('Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.', 1, (p) =>
        // The gaps around the fence shrink; the one inside it is content.
        shortLines(p).join() === '2,8' && !short(p, 5)
      ),
  },
  {
    name: 'a blank line inside a csv block keeps its height, since the grid reads it as a row',
    run: () =>
      withDoc('Before.\n\n```csv id=tasks\nfeature,status\n\nsearch,done\n```\n\nAfter.', 1, (p) =>
        // The block draws as a grid widget rather than as lines, so the rule is
        // what says what each line gets; only the gaps around the block shrink.
        ruleLines(p).join() === '2,8'
      ),
  },
  {
    name: 'a blank line inside a view block keeps its height',
    run: () =>
      withDoc('Before.\n\n```view\nfrom: #tasks\n\nsort: status\n```\n\nAfter.', 1, (p) => ruleLines(p).join() === '2,8'),
  },
  {
    name: 'a blank line inside YAML front matter keeps its height',
    run: () =>
      withDoc('---\ntitle: Incident\n\nauthor: Ada Quill\n---\n\nBody text.', 7, (p) =>
        // Only the line between the closing fence and the body is a separator.
        shortLines(p).join() === '6' && !short(p, 3)
      ),
  },
  {
    name: 'several blank lines in a row each draw as a gap, so more of them still read as more space',
    run: () => withDoc('One.\n\n\n\nTwo.', 1, (p) => shortLines(p).join() === '2,3,4'),
  },
  {
    name: 'blank lines above everything and below everything stay full lines',
    run: () =>
      withDoc('\n\nBody.\n\n\n', 3, (p) => shortLines(p).length === 0),
  },
  {
    name: 'a line of spaces between blocks draws as a gap, as Markdown reads it as blank',
    run: () => withDoc('One.\n   \nTwo.', 1, (p) => short(p, 2)),
  },
  {
    name: 'the rule answers the same question the drawing does, without reading the DOM',
    run: () =>
      withDoc(HEADING_AND_TABLE, 1, (p) => {
        const state = p.view.state;
        const from = [1, 2, 3, 4, 5].filter((n) => isSpacingBlankLine(state, n));
        return from.join() === '2' && from.join() === shortLines(p).join();
      }),
  },
  {
    name: 'drawing a blank line as a gap adds no decoration the caret can be moved over',
    run: () =>
      withDoc(TWO_PARAGRAPHS, 1, (p) => {
        // A line decoration styles the line and covers no character, so every
        // position on and around the blank line is still one the caret can hold.
        const doc = p.view.state.doc;
        const blank = doc.line(2).from;
        return (
          p.view.state.selection.main.from === doc.line(1).from &&
          [blank - 1, blank, blank + 1].every((pos) => {
            p.select(pos);
            return p.view.state.selection.main.head === pos;
          })
        );
      }),
  },
];
