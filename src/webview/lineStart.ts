/*
 * Home, and where the start of a line is when the line opens with a marker.
 *
 * CodeMirror's Home goes to the start of the visual line, which it finds from the DOM. That
 * makes it land on the first character actually drawn, and since each kind of block hides a
 * different amount of its marker, each kind answered differently:
 *
 *   # A heading here    column 2   `# ` is hidden, so the first drawn character is the H
 *   > A quoted line     column 1   `>` is hidden and the space after it is not
 *   - A bullet item     column 0   the marker is drawn, as a bullet, and sits at the edge
 *   - [ ] A task item   column 0   the same, as a checkbox
 *
 * Three answers to one key, and the quote's is a position between the `>` and its space,
 * which is the start of nothing. A person cannot learn that.
 *
 * The answer here is the first character of the line's own text, past whatever marker opens
 * it. One rule, and it is the only position where the next keystroke does what the person
 * means: at column 0 on a bullet, typing puts a letter in front of the `-` and the line
 * stops being a bullet at all. Landing on the text cannot do that to a block. Which is also
 * why the heading's old answer was the right one and the bullet's was not, the opposite way
 * round from how the three-answer problem first read.
 *
 * A wrapped line keeps CodeMirror's answer. On the second visual line of a long paragraph,
 * Home means the start of that visual line, and jumping back to the top of the paragraph
 * would be a worse thing than the inconsistency this fixes. So the marker rule only applies
 * where CodeMirror's own answer is inside the marker, which can only be the first visual
 * line.
 *
 * Code and tables keep CodeMirror's answer too. A `#` inside a fenced block is a comment in
 * somebody's shell script, not a heading, and a table's row is drawn as a grid.
 *
 * And so does a line that is showing its Markdown. Edit Markdown, and whole-document source
 * mode, are asked for precisely to get at the markers: there the `##` is the content being
 * edited rather than decoration standing in front of it, and skipping it puts the caret
 * past the thing the person opened the line to change. Typing a third `#` then wrote
 * `## #Heading` instead of `### Heading`.
 */

import { EditorSelection, EditorState, Extension, SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { blockRangeAt } from './blockModel';
import { activeLines, sourceModeOn } from './livePreview';

/** Blocks whose lines are not prose, so nothing in them opens with a marker. */
const NOT_PROSE = new Set(['code', 'table', 'frontmatter']);

/**
 * How many characters of `text` are the marker that opens the line: the `#` of a heading,
 * the `>` of one or more quote levels, a list bullet or number, a task's box, and the
 * whitespace that separates each from what follows. 0 when the line opens with its text.
 *
 * A line holding nothing but its marker counts the whole of it, so Home on an empty list
 * item goes where the person would type rather than in front of the bullet.
 */
export function markerLength(text: string): number {
  const marker = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(text);
  if (!marker) return 0;
  const len = marker[0].length;
  // Indentation alone is not a marker: a wrapped list item's continuation line is indented
  // and its text begins where the indentation ends, which is what Home already does.
  return /^[ \t]*$/.test(marker[0]) ? 0 : len;
}

/**
 * Whether the line at `pos` is showing its Markdown rather than being drawn as
 * prose.
 *
 * Exported because every repair this editor makes to a construct depends on it.
 * All of them exist because a person cannot see the characters they are typing
 * next to, and on a line showing its source they can see all of them: there the
 * `**` is the thing being edited, and moving a typed space to the far side of it,
 * or closing and reopening a run around a line break, is the editor overruling
 * somebody who is looking straight at the markup.
 */
/*
 * Three ways a line comes to show its Markdown, and this used to answer two.
 *
 * It read `revealField` directly, which covers source mode and an explicit reveal, and missed
 * reveal-on-line: `revealSyntaxOnLine` opening whatever the selection touches, widened to the
 * whole block. So with that setting on, eleven guards across three files behaved as though the
 * delimiters were hidden while they were on the screen, each against its own comment. A space
 * typed at the inner edge of a visible `**bold**` was moved outside it; a character typed beside
 * a visible `---` got a new line rather than landing where it was put.
 *
 * `activeLines` is the set `livePreview.ts` builds its own `lineActive` from, and every decoration
 * there asks it before hiding a marker. Asking the same pair makes this answer the question its
 * name claims and unable to disagree with what is drawn. Both halves are needed: `activeLines`
 * returns an empty set under source mode, which `lineActive` folds in separately.
 *
 * Measured rather than argued. `test/prose/revealOnLine.ts` reads the screen with the caret on each
 * construct's line and reports all eight revealed: emphasis, inline code, a link, a heading marker,
 * a hard break, a rule, a callout's marker line and a fence. A comment in `test/prose/alerts.ts`
 * said reveal-on-line does not open a callout's marker line, and that reading disproves it.
 */
export function showingSource(state: EditorState, pos: number): boolean {
  if (sourceModeOn(state)) return true;
  return activeLines(state).has(state.doc.lineAt(pos).number);
}

/** Where the text on the line at `pos` begins, past any marker. */
export function lineTextStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  if (NOT_PROSE.has(blockRangeAt(state, pos)?.kind ?? 'other')) return line.from;
  if (showingSource(state, pos)) return line.from;
  return line.from + markerLength(line.text);
}

/**
 * Home, and Shift+Home: the start of the visual line, except that the first visual line of
 * a block goes to the start of its text rather than into its marker.
 */
export function toLineStart(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  const ranges = state.selection.ranges.map((range: SelectionRange) => {
    const boundary = view.moveToLineBoundary(range, false);
    const textStart = lineTextStart(state, range.head);
    // Only where CodeMirror's own answer is inside the marker. On a later visual line its
    // answer is past the text start, and it keeps it.
    const head = boundary.head < textStart && state.doc.lineAt(boundary.head).from === state.doc.lineAt(textStart).from ? textStart : boundary.head;
    return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
  });
  view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true });
  return true;
}

/*
 * Two positions, one place on the screen.
 *
 * Everything above answers where Home goes. What follows keeps the caret from
 * resting in the one place where nothing else can help it.
 *
 * A hidden marker is one atomic range, so the caret glides over `# ` in a single
 * step and cannot land in the middle of it. It can still land at either end. On
 * `# Heading` that is offset 0 and offset 2, and both draw against the left edge
 * of the H, because the two characters between them are not on the screen. There
 * is no way to tell them apart by looking, and they do not do the same thing:
 *
 *   caret at 2, type X    # XHeading     the heading gains a letter
 *   caret at 0, type X    X# Heading     a paragraph that reads "X# Heading"
 *
 * The second is what a person gets by pressing ArrowLeft once too often, or by
 * pressing Enter at the start of a heading and then ArrowUp, which is how this
 * was found. It is not a heading any more, and the hashes a person never asked
 * to see are on the screen. Every marked block does this: a quote, a bullet, a
 * numbered item and a task box all lose what they were.
 *
 * So the caret does not rest there. A collapsed caret at the front of a hidden
 * marker moves to the far side of it, which is the same place on the screen and
 * the only one of the two where typing does what it looks like it will do.
 *
 * Only collapsed carets. A selection that reaches back through the marker is a
 * different question, because what a person means by dragging across a heading
 * is not settled by this and replacing the marker may well be right.
 *
 * Only where the marker is hidden. `lineTextStart` already declines inside code,
 * inside a table, in the front matter, on a revealed line and in source mode,
 * which is every case where the marker is the text rather than decoration in
 * front of it.
 *
 * This has a consequence that has to be handled with it, in `unwrapAtTextStart`
 * below: once the caret cannot be at offset 0, Backspace at the left edge of a
 * heading would delete the space out of `# ` and write `#Heading`. It deletes
 * the marker instead.
 */

/** The caret moved off the front of a hidden marker, or null when none of them was there. */
function pastMarker(state: EditorState, sel: EditorSelection): EditorSelection | null {
  let moved = false;
  const ranges = sel.ranges.map((range) => {
    if (!range.empty) return range;
    const line = state.doc.lineAt(range.head);
    if (range.head !== line.from) return range;
    const textStart = lineTextStart(state, range.head);
    if (textStart === line.from) return range;
    moved = true;
    return EditorSelection.cursor(textStart, range.assoc, range.bidiLevel ?? undefined);
  });
  return moved ? EditorSelection.create(ranges, sel.mainIndex) : null;
}

/**
 * A collapsed caret never rests in front of a hidden marker.
 *
 * A filter rather than a key handler, because the caret arrives there by more
 * routes than the keyboard: ArrowLeft and ArrowUp, a click on the left edge, a
 * command that puts the caret at the start of a line, and a mapped selection
 * after some other change. Each of those would need its own fix, and the ones
 * nobody thought of would keep the defect alive.
 */
export const caretPastMarker: Extension = EditorState.transactionFilter.of((tr) => {
  const fixed = pastMarker(tr.state, tr.newSelection);
  return fixed ? [tr, { selection: fixed, sequential: true }] : tr;
});

/**
 * Backspace at the start of a block's text takes the block's formatting.
 *
 * This is the other half of `caretPastMarker`. With the caret held at the far
 * side of the marker, the unchanged Backspace deletes the last character of the
 * marker itself: `# Heading` becomes `#Heading`, which is a paragraph with a
 * hash in it, and the person who pressed the key was trying to delete nothing of
 * the sort. They were at the left edge of a heading, and what a person means
 * there is the same thing they mean in every other editor: stop being a heading.
 *
 * So the whole marker goes and the text stays where it is. Press it again and
 * the caret is at a real line start with nothing in front of it, and the ordinary
 * Backspace joins this line to the one above, which is the other thing a person
 * means at the left edge and the one they get on the second press.
 *
 * False everywhere else, so Backspace keeps its own behaviour: in the middle of a
 * line, on a line with no marker, on a line showing its Markdown, and inside a
 * selection, where what is selected is what goes.
 */
export function unwrapAtTextStart(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const textStart = lineTextStart(state, range.head);
  if (range.head !== textStart || textStart === line.from) return false;
  view.dispatch({
    changes: { from: line.from, to: textStart },
    selection: EditorSelection.cursor(line.from),
    userEvent: 'delete.backward',
    scrollIntoView: true,
  });
  return true;
}

/*
 * Enter at the start of a block's text.
 *
 * The caret is at the left edge of a heading and the person presses Enter,
 * meaning "give me a line above this one". What they got was the heading split
 * through its own marker: the line above holds `# ` and nothing else, and the
 * line below holds the words. `# ` draws as nothing, so the gap they asked for
 * appears and looks right, and it is an empty heading. Two things then go
 * wrong. The next thing typed on that line lands in front of the hash, which is
 * the defect `caretPastMarker` is about, one line further on. And `# ` survives
 * in the file, renders as an empty heading everywhere else, and outlives the
 * session that made it. A blank line is what the person meant and it is
 * ordinary Markdown; a bare `# ` is neither.
 *
 * So Enter at the start of a heading's text opens a plain blank line above and
 * leaves the caret on the words, where it already was.
 *
 * Not every marked block wants this. An empty bullet and an empty numbered item
 * draw their marker, so splitting one leaves something a reader can see and a
 * person can carry on typing into, which is what Enter at the start of a list
 * item means everywhere else. They keep Markdown's own Enter.
 *
 * A task item is the exception among those: splitting one wrote `- [ ]` with no
 * space after the box, which is not a task at all, so the line above drew a
 * literal `[ ]` instead of a checkbox. It gets the space.
 *
 * A quote is left alone here. `>` on its own draws as nothing, so it has the
 * heading's problem, but a blank line inside a quote ends the quote rather than
 * spacing it, and what Enter should do in the middle of a quoted passage is a
 * different question from this one.
 */

/** An empty version of the marker that opens `text`, or null when it does not want one. */
function emptyTwin(text: string): string | null {
  const task = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\])[ \t]+/.exec(text);
  // `- [ ]` with nothing after the box is not a task, and drew the brackets as
  // text. The space is what makes it one.
  return task ? `${task[1]} ` : null;
}

/**
 * Enter at the start of a heading's text opens a blank line above it instead of
 * splitting the heading through its marker.
 *
 * False everywhere else, so Enter keeps its own behaviour: in the middle of a
 * line, at a real line start, on a list item, inside a selection, and on any
 * line showing its Markdown, where the marker is the text being edited.
 */
export function openLineAboveMarker(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const textStart = lineTextStart(state, range.head);
  if (range.head !== textStart || textStart === line.from) return false;

  const kind = blockRangeAt(state, range.head)?.kind;
  const twin = emptyTwin(line.text);
  if (kind !== 'heading' && !twin) return false;

  const insert = twin ? `${twin}\n` : '\n';
  view.dispatch({
    changes: { from: line.from, insert },
    // The caret stays on the words, which have moved down by what was inserted.
    selection: EditorSelection.cursor(range.head + insert.length),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}
