/*
 * Marks on the lines a write from outside the editor put in: an agent, a branch
 * switch or another editor changing the open file.
 *
 * A write is applied here the way the webview applies one: the whole new text,
 * turned into the single replacement the host's minimal edit makes, marked remote,
 * kept off the history, and carrying the effect that says it came from outside.
 * The host suite drives the real message path; these check what gets marked.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { Transaction } from '@codemirror/state';
import { arrivedLines, keptLines, outsideWrite } from '../../src/webview/changeMarks';
import { setDocumentSourceMode, setLivePreviewConfig } from '../../src/webview/livePreview';
import { minimalEdit } from '../../src/textSync';

const DOC = [
  'Alpha paragraph.',
  '',
  'Bravo paragraph.',
  '',
  'Charlie paragraph.',
  '',
  'Delta paragraph.',
  '',
  'Echo paragraph.',
  '',
].join('\n');

const withProse = (doc: string, fn: (p: Prose) => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  const p = mountProse(doc);
  try {
    return fn(p);
  } finally {
    p.destroy();
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

/** Write `text` into the editor from outside, as a `setContent` from the host does. */
const write = (p: Prose, text: string): void => {
  const { start, end, replacement } = minimalEdit(p.doc(), text);
  p.view.dispatch({
    changes: { from: start, to: end, insert: replacement },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    effects: outsideWrite.of(null),
    scrollIntoView: false,
  });
};

/** `DOC` with the lines at the given one-based numbers replaced. */
const withLines = (doc: string, replace: Record<number, string | null>): string =>
  doc
    .split('\n')
    .flatMap((line, i) => {
      const r = replace[i + 1];
      return r === undefined ? [line] : r === null ? [] : [r];
    })
    .join('\n');

/** The one-based numbers of the lines marked with `kind`. */
const marked = (p: Prose, kind = 'changed'): number[] =>
  p.view.state
    .field(arrivedLines)
    .filter((m) => m.kind === kind)
    .map((m) => p.view.state.doc.lineAt(m.pos).number);

const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The text of every rendered line carrying `cls`. */
const shownWith = (p: Prose, cls: string): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>(`.cm-line.${cls}`)).map((el) => el.textContent ?? '');

/** Type `text` at `pos`, as a keystroke would. */
const type = (p: Prose, pos: number, text: string): void => {
  p.view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: 'input.type' });
};

export const scenarios: Scenario[] = [
  {
    name: 'arriving changes: an outside write that changes one line marks exactly that line',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 5: 'Charlie paragraph, rewritten.' }));
        const shown = shownWith(p, 'sheaf-arrived');
        return same(marked(p), [5]) && shown.length === 1 && shown[0] === 'Charlie paragraph, rewritten.';
      }),
  },
  {
    name: 'arriving changes: two separate changed lines are both marked and the lines between are not',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 1: 'Alpha, changed.', 9: 'Echo, changed.' }));
        const shown = shownWith(p, 'sheaf-arrived');
        return same(marked(p), [1, 9]) && shown.length === 2 && shown[0] === 'Alpha, changed.' && shown[1] === 'Echo, changed.';
      }),
  },
  {
    name: 'arriving changes: an inserted paragraph marks each line it put in',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 4: '\nNew one.\nNew two.\n' }));
        // Lines 4..7 are the blank, the two new lines and the blank inserted around them;
        // the diff keeps one of the blanks as the old line 4, so three or four are new.
        const lines = p.view.state.doc.toString().split('\n');
        const marks = marked(p);
        const newLinesMarked = marks.includes(lines.indexOf('New one.') + 1) && marks.includes(lines.indexOf('New two.') + 1);
        const untouchedClear = !marks.includes(lines.indexOf('Charlie paragraph.') + 1) && !marks.includes(1);
        return newLinesMarked && untouchedClear && marks.length <= 4;
      }),
  },
  {
    name: 'arriving changes: a write that only removes lines leaves a tick on the line after the gap',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 5: null, 6: null }));
        const ticks = marked(p, 'deletedAbove');
        const after = p.view.state.doc.line(ticks[0] ?? 1).text;
        return marked(p).length === 0 && ticks.length === 1 && after === 'Delta paragraph.' &&
          same(shownWith(p, 'sheaf-arrived-deleted'), ['Delta paragraph.']);
      }),
  },
  {
    name: 'arriving changes: removing the last lines puts the tick under the line before the gap',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 8: null, 9: null }));
        const below = marked(p, 'deletedBelow');
        return marked(p).length === 0 && below.length === 1 && p.view.state.doc.line(below[0]).text === 'Delta paragraph.';
      }),
  },
  {
    name: 'arriving changes: a second write adds its lines to the marks already there',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 3: 'Bravo, first write.' }));
        const first = same(marked(p), [3]);
        // The second write also puts a line in above the first mark, which must stay
        // on the line it was on.
        write(p, withLines(p.doc(), { 1: 'Top.\nAlpha paragraph.', 9: 'Delta, second write.' }));
        const lines = p.doc().split('\n');
        const expect = [1, lines.indexOf('Bravo, first write.') + 1, lines.indexOf('Delta, second write.') + 1];
        return first && same(marked(p), expect);
      }),
  },
  {
    name: 'arriving changes: typing on a marked line clears that line and only that line',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 3: 'Bravo, written.', 7: 'Delta, written.' }));
        type(p, p.view.state.doc.line(3).to, '!');
        return same(marked(p), [7]) && same(shownWith(p, 'sheaf-arrived'), ['Delta, written.']);
      }),
  },
  {
    name: 'arriving changes: typing elsewhere, a new line above included, leaves the marks on their lines',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 5: 'Charlie, written.' }));
        type(p, p.view.state.doc.line(1).to, ' more');
        type(p, p.view.state.doc.line(3).to, '\nAnother line.');
        const at = marked(p);
        return at.length === 1 && p.view.state.doc.line(at[0]).text === 'Charlie, written.';
      }),
  },
  {
    name: 'arriving changes: the document an editor opens with marks nothing, nor does an edit without the outside flag',
    run: () =>
      withProse(DOC, (p) => {
        const none = marked(p).length === 0 && shownWith(p, 'sheaf-arrived').length === 0;
        type(p, 0, 'X');
        return none && p.view.state.field(arrivedLines).length === 0;
      }),
  },
  {
    name: "arriving changes: the person's own undo and redo mark nothing",
    run: () =>
      withProse(DOC, (p) => {
        type(p, p.view.state.doc.line(3).to, ' typed');
        const undone = p.press('Mod-z') && p.doc() === DOC;
        const redone = p.press('Mod-Shift-z') && p.doc().includes('Bravo paragraph. typed');
        return undone && redone && p.view.state.field(arrivedLines).length === 0;
      }),
  },
  {
    name: 'arriving changes: source mode shows the same marks',
    run: () =>
      withProse(DOC, (p) => {
        write(p, withLines(DOC, { 3: '**Bravo**, written.' }));
        setDocumentSourceMode(p.view, p.view.dom.parentElement as HTMLElement, true);
        const shown = shownWith(p, 'sheaf-arrived');
        setDocumentSourceMode(p.view, p.view.dom.parentElement as HTMLElement, false);
        return same(shown.map((t) => (t === '**Bravo**, written.' ? 1 : 0)), [1]);
      }),
  },
  {
    name: 'arriving changes: a write into a table row keeps the grid drawn, with the row recorded as marked',
    run: () => {
      const table = 'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
      return withProse(table, (p) => {
        write(p, table.replace('| 1 | 2 |', '| 1 | 3 |'));
        const grid = p.view.contentDOM.querySelectorAll('.sheaf-table').length === 1;
        return grid && same(marked(p), [5]);
      });
    },
  },
  {
    name: 'arriving changes: a 3000-line document with one outside write is marked quickly',
    run: () => {
      const big = Array.from({ length: 3000 }, (_, i) => `Line ${i} of a long document.`).join('\n');
      return withProse(big, (p) => {
        const started = Date.now();
        write(p, withLines(big, { 1500: 'Changed in the middle.' }));
        const took = Date.now() - started;
        return same(marked(p), [1500]) && took < 250;
      });
    },
  },
  {
    name: 'arriving changes: the line comparison keeps every line two texts share, in order',
    run: () => {
      const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const b = ['a', 'x', 'c', 'd', 'y', 'z', 'f', 'g', 'h'];
      const kept = Array.from(keptLines(a, b));
      // b and e are gone; a, c, d, f, g survive at their new places.
      return same(kept, [0, -1, 2, 3, -1, 6, 7]);
    },
  },
];
