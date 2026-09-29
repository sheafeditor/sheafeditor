/*
 * Paging that comes back to where it started.
 *
 * PageDown and PageUp are the one gesture a reader expects to be exactly reversible: they
 * look further on, then come back, and the paragraph they were reading should be where
 * they left it.
 *
 * **A page here is a count of rows, not a distance in pixels.** That is what the text
 * editor beside a Sheaf document does, so it surprises nobody, and it is what makes the
 * gesture reversible. CodeMirror's own commands move the caret by the height of the
 * viewport and let it land on whichever line that pixel falls in. The caret cannot land
 * between two lines, so the move rounds, and the rounding is not symmetric: going down
 * starts from the bottom of the caret and going up from its top, and a page is almost
 * never a whole number of lines. Wherever lines differ in height the two directions round
 * differently and the difference accumulates. Measured in a browser on 150 headings and
 * paragraphs, with an 858px page and a 90.4px section: every PageDown travelled 904px and
 * every PageUp 858px, so twelve of each left the reader 546px, six sections, below where
 * they began. The same numbers came back on a second and third round trip over a document
 * whose heights had all been measured, so this is the rounding and not an estimate
 * settling down.
 *
 * Counting rows removes the rounding, because a row is what the caret lands on. Two things
 * have to be true for it to be exact, and both were work in their own right.
 *
 * **A single row step has to be its own inverse.** It was not: Up skipped any line drawn
 * shorter than the 10px CodeMirror retries a vertical probe with, which is every blank
 * separator above a heading. A page built on that crossed 34 rows down and about 42 back.
 * `oneRow` in `caretMotion.ts` is the corrected step, and it exists as a function rather
 * than only as a key because this needs to take several of them.
 *
 * **The count may not depend on where the reader is.** "The number of rows on the screen"
 * is the obvious reading and it does depend on that, since a screen of headings holds
 * fewer rows than a screen of prose. Move down by the rows on this screen and the next
 * screen holds a different number, so coming back travels a different distance: the same
 * asymmetry as the pixel one, smaller but not zero. So the count is the rows a screen of
 * body text holds, which is a property of the window rather than of the document, and
 * paging down and up by the same count returns to the same row however tall the rows
 * between were.
 *
 * What that costs is the trade this was chosen with open eyes: a screen holding a table, a
 * diagram or several headings pages by a little more than a screenful, and a screen of
 * tightly separated blocks by a little less. Nobody measures a screenful. Losing your
 * place is noticed immediately.
 *
 * The view then follows the caret, keeping it at the height on the screen it already had,
 * which is what CodeMirror's command does too and what makes the page turn under a fixed
 * reading line.
 *
 * Three cases are left to CodeMirror's own commands, by declining the key:
 *
 *   - **A grid has the keyboard.** A table answers these keys with its own row paging, and
 *     moving the document underneath it as well would take the cells it is about to show.
 *   - **The caret is already at the end it is heading for.** A reader pressing PageDown at
 *     the bottom wants the end of the document, which is what the default gives.
 *   - **The document fits.** There is no page to turn.
 */

import { EditorSelection, Prec, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { oneRow } from './caretMotion';

/**
 * How many rows a page is: the rows a screen of body text holds, less one so something
 * the reader was looking at stays in view. Derived from the window and not from the
 * document, which is what makes a page down and a page up cancel.
 */
function pageRows(view: EditorView): number {
  const row = view.defaultLineHeight;
  if (!(row > 0)) return 1;
  return Math.max(1, Math.floor(view.scrollDOM.clientHeight / row) - 1);
}

/** Moves the caret a page of rows and takes the view with it. */
function byPage(view: EditorView, forward: boolean, extend: boolean): boolean {
  // Only when the text itself has the keyboard: `hasFocus` is the content element and
  // nothing else, so a focused table grid reads as false here and keeps its own keys.
  if (!view.hasFocus) return false;
  const scroller = view.scrollDOM;
  if (scroller.scrollHeight - scroller.clientHeight < 1) return false;

  const range = view.state.selection.main;
  const rows = pageRows(view);
  let moved: SelectionRange = range;
  for (let i = 0; i < rows; i++) {
    const next = oneRow(view, moved, forward);
    // Against the end of the document, where the default command's jump to the very start
    // or end is what a reader pressing the key again is asking for.
    if (next.head === moved.head) break;
    moved = next;
  }
  if (moved.head === range.head) return false;

  const was = view.coordsAtPos(range.head, range.assoc || -1);
  const box = scroller.getBoundingClientRect();
  const keepsItsPlace = was && was.top >= box.top && was.bottom <= box.bottom;
  view.dispatch({
    selection: extend ? EditorSelection.range(range.anchor, moved.head, moved.goalColumn) : moved,
    effects: keepsItsPlace ? EditorView.scrollIntoView(moved.head, { y: 'start', yMargin: was.top - box.top }) : undefined,
    userEvent: 'select',
  });
  return true;
}

/** PageUp and PageDown, with and without Shift. */
export const pageKeys: readonly KeyBinding[] = [
  { key: 'PageDown', run: (view) => byPage(view, true, false) },
  { key: 'PageUp', run: (view) => byPage(view, false, false) },
  { key: 'Shift-PageDown', run: (view) => byPage(view, true, true) },
  { key: 'Shift-PageUp', run: (view) => byPage(view, false, true) },
];

/**
 * Paging bound ahead of CodeMirror's own, which is still behind it: every binding here
 * declines the cases named at the top of this file, and a declined key falls through to
 * the default exactly as if this extension were not loaded.
 */
export const paging: Extension = Prec.high(keymap.of([...pageKeys]));
