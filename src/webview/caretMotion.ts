/*
 * Left, at the edge of a marker the reader cannot see.
 *
 * A heading's `# ` and a quote's `>` are hidden, so a line has two positions that are
 * drawn in the same place: in front of the marker, and at the start of the words. Home
 * already chooses between them and goes to the words (`lineStart.ts`, which explains
 * why). Arrow motion had not been given the same answer, and the consequence was worse
 * than an inconsistency.
 *
 * The markers are replaced decorations and those are fed to `EditorView.atomicRanges`,
 * which stops the caret resting *inside* one. What atomic motion does is step over the
 * range to its far side, so Left from the start of the words landed in front of the
 * marker. Nothing appeared to move, because everything between the two positions is
 * invisible, and the next letter typed then went in front of the `#` and the heading
 * stopped being a heading:
 *
 *   # Welcome to Sheaf   ->  d# Welcome to Sheaf     drawn as body text, hashes showing
 *   ## Second section    ->  d## Second section      the same
 *   > A quoted line.     ->  >d A quoted line.       inside the marker, between > and its space
 *
 * So Left at the start of a line's words goes to the end of the line above, which is
 * where a person pressing Left at the start of a line means to go. On the first line of
 * the document there is nowhere above, and the key does nothing rather than stepping
 * into the marker.
 *
 * **Right reaches the same position from the other side, which was measured rather than
 * assumed.** This file first said Right was safe, on the reasoning that atomic motion
 * steps over a marker forwards too and so lands on the words. It does not: Right from
 * the end of the line above lands in front of the marker, and typing there wrote
 * `d## Second section`. So Right onto a line that opens with a marker goes to the start
 * of its words, and the bad position is reachable from neither side.
 *
 * ## Up, over a line too short for CodeMirror to see
 *
 * A separate defect with a separate cause, in the same place. Up skipped the blank line
 * above every heading, so one line in four could not be reached going up and Up then
 * Down did not return. Measured on headings and paragraphs, where headings sit on lines
 * 4k+1 and blanks on the even ones:
 *
 *   ArrowDown  59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79
 *   ArrowUp    78 77 75 74 73 71 70 69 67 66 65 63 62 61 59 58 57 55 54 53
 *
 * Down visits every line. Up skipped 76, 72, 68, 64, 60 and 56, each the blank line
 * immediately above a heading and nothing else.
 *
 * CodeMirror moves the caret a line by probing half a text height beyond it and asking
 * what position is there, retrying 10px further whenever the answer is still inside the
 * line it started from. A heading carries generous top padding, so going up out of one
 * the first probe lands inside the heading's own padding, and the retry then clears an
 * 8px blank line entirely. **Any line drawn shorter than that 10px step can be jumped,**
 * which is why a taller blank line would hide this rather than fix it.
 *
 * The correction is deliberately narrow: CodeMirror's own answer is taken first, and
 * only if it stepped over a line that is drawn as a row of its own is that line used
 * instead. Everything else keeps CodeMirror's motion exactly, which matters because a
 * single row can legitimately cross several lines of the file: front matter folded to a
 * strip, or an image written as several lines of HTML, is one drawn row over many lines,
 * and stepping through those one line at a time would be the wrong answer.
 *
 * Making a row step land where it should also makes Up and Down inverses of each other,
 * which is what a page of lines needs underneath it.
 */

import { EditorSelection, type SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { lineTextStart } from './lineStart';

/**
 * Left, and Shift+Left, at the first position after a line's hidden marker: the end of
 * the line above rather than the far side of the marker. False everywhere else, so the
 * key falls through to CodeMirror's own motion exactly as if this were not loaded.
 */
export function leftAcrossMarker(view: EditorView, extend: boolean): boolean {
  // Only when the text itself has the keyboard. A focused grid, board or menu answers
  // its own arrows, and `hasFocus` is the content element and nothing else.
  if (!view.hasFocus) return false;
  const { state } = view;
  const { doc } = state;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  // A plain Left on a selection collapses it, which is CodeMirror's job and not this.
  if (!extend && !range.empty) return false;
  const line = doc.lineAt(range.head);
  const textStart = lineTextStart(state, range.head);
  // Nowhere else: only the one position whose Left would step into a marker.
  if (range.head !== textStart || textStart === line.from) return false;
  // The first line of the document has nothing above it, so the caret stays where it is.
  // The key is still taken, because the alternative is the position this exists to avoid.
  if (line.number === 1) return true;
  const head = doc.line(line.number - 1).to;
  return go(view, range, head, extend);
}

/**
 * Right, and Shift+Right, at the end of a line whose next line opens with a hidden
 * marker: the start of that line's words rather than the position in front of its
 * marker. False everywhere else.
 */
export function rightAcrossMarker(view: EditorView, extend: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  const { doc } = state;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!extend && !range.empty) return false;
  const line = doc.lineAt(range.head);
  if (range.head !== line.to || line.number === doc.lines) return false;
  const next = doc.line(line.number + 1);
  const textStart = lineTextStart(state, next.from);
  // The next line opens with its own text, so Right already lands somewhere safe.
  if (textStart === next.from) return false;
  return go(view, range, textStart, extend);
}

/**
 * The first line between `from` and `to` that is drawn as a row of its own, or 0 for
 * none. A line inside a folded strip or a multi-line widget belongs to a block that
 * starts somewhere else, and stepping onto it is not what a row step means.
 */
function skippedOwnRow(view: EditorView, from: number, to: number, dir: 1 | -1): number {
  const { doc } = view.state;
  for (let n = from + dir; n !== to; n += dir) {
    if (n < 1 || n > doc.lines) return 0;
    const line = doc.line(n);
    const block = view.lineBlockAt(line.from);
    if (block.from === line.from && block.height > 0) return n;
  }
  return 0;
}

/**
 * The caret one drawn row from `range`: CodeMirror's own move, except where that stepped
 * over a line drawn as a row of its own, which it can do to any line shorter than the
 * 10px it retries a probe with.
 *
 * Exported because paging is a count of these, and a page is only reversible if a single
 * step is. Everything CodeMirror gets right it keeps, so wrapping, widgets and bidi are
 * untouched; the correction is one landing position on one line.
 */
export function oneRow(view: EditorView, range: SelectionRange, forward: boolean): SelectionRange {
  const { state } = view;
  const { doc } = state;
  const theirs = view.moveVertically(range, forward);
  const from = doc.lineAt(range.head).number;
  const to = doc.lineAt(theirs.head).number;
  // One line, or none at all inside a wrapped paragraph: CodeMirror was right.
  if (Math.abs(to - from) < 2) return theirs;
  const over = skippedOwnRow(view, from, to, forward ? 1 : -1);
  if (!over) return theirs;
  const line = doc.line(over);
  const caret = view.coordsAtPos(range.head, range.assoc || -1);
  const content = view.contentDOM.getBoundingClientRect();
  const goal = range.goalColumn ?? (caret ? caret.left - content.left : 0);
  const at = view.coordsAtPos(line.from);
  const found = at ? view.posAtCoords({ x: content.left + goal, y: (at.top + at.bottom) / 2 }, false) : line.from;
  // Never in front of a marker, which is the position the rest of this file exists to avoid.
  const start = lineTextStart(state, line.from);
  const head = doc.lineAt(found).number === over ? Math.max(found, start) : start;
  return EditorSelection.cursor(head, 0, undefined, goal);
}

/**
 * Up and Down, with Shift. False whenever CodeMirror's own answer was already right,
 * which is nearly always, so the key falls through to it unchanged.
 */
export function verticallyByRow(view: EditorView, forward: boolean, extend: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  const stepped = oneRow(view, range, forward);
  const theirs = view.moveVertically(range, forward);
  if (stepped.head === theirs.head) return false;
  const landed: SelectionRange = extend
    ? EditorSelection.range(range.anchor, stepped.head, stepped.goalColumn)
    : stepped;
  view.dispatch({ selection: landed, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/** Moves the one range to `head`, extending it or collapsing it onto it. */
function go(view: EditorView, range: { anchor: number }, head: number, extend: boolean): boolean {
  view.dispatch({
    selection: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head),
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}
