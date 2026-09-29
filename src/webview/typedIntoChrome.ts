/*
 * Typing into a line the editor draws as chrome rather than as text.
 *
 * A horizontal rule and a code fence are both lines whose characters are not on
 * the screen: the rule is drawn as a line across the page, the fence as the top
 * and bottom of a box. The caret can sit anywhere along either of them, every
 * position draws in the same place, and a character typed at any of them takes
 * the construct apart. This file holds the three cases of that, which arrived one
 * at a time and are one problem.
 *
 * What they have in common is the repair. In each case the person is typing
 * *beside* something rather than into it, so they get a line to type on and the
 * construct is left exactly as it was. Nothing is rewritten; a line is added. That
 * is the only kind of repair this editor makes to a neighbour, and it needs none
 * of the Extended-only mechanisms, so Strict Markdown mode behaves the same.
 *
 * ## The divider, and the line above it
 *
 * `---` on its own is a horizontal rule, and Sheaf draws it as one. Put any text
 * on the line directly above it and Markdown reads the same three characters as
 * the underline of a setext heading instead, so the rule disappears and the text
 * silently becomes an H2:
 *
 *   Body above.            Body above.
 *                     ->   X                 now an H2
 *   ---                    ---               now its underline, and not drawn
 *
 * One keystroke, two constructs changed, and neither of them the one being typed
 * in. The rule the person was writing next to is gone from the page, which is the
 * quietest kind of damage: nothing appears, something leaves.
 *
 * Sheaf already knows about this trap from the other side. `insertDivider` keeps
 * a blank line above a rule for exactly this reason, and says so. The insert path
 * guarded it and the typing path did not, so this is finishing a decision rather
 * than taking a new one.
 *
 * The repair is a blank line between the two, which is the only kind of repair
 * this editor makes to a neighbour: it adds something the person could have typed
 * and leaves every byte they did type alone. The `---` has moved and not changed.
 * Rewriting it to `***`, which cannot be an underline, would also work and is
 * rejected: almost nobody writes `***`, and the file should stay something a
 * person would have written by hand.
 *
 * It needs none of the Extended-only mechanisms, so it behaves the same in Strict
 * Markdown mode. A blank line is ordinary Markdown.
 */

import { EditorSelection, EditorState, Line } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { showingSource } from './lineStart';
import { alertMarkerAt, alertMarkerOnText } from './alerts';

/**
 * A line that is nothing but `-` or `=`, which are the two underlines that turn
 * the paragraph above them into a heading.
 *
 * `***` and `___` are horizontal rules too and are deliberately not here: neither
 * can ever be read as an underline, so text above one changes nothing.
 */
const SETEXT_UNDERLINE = /^ {0,3}(?:-+|=+)[ \t]*$/;

/** A line drawn as a horizontal rule, in any of the three spellings. */
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** The indentation and the run of backticks or tildes a fence line opens with. */
const FENCE_RUN = /^([ \t]*)(`{3,}|~{3,})/;

/**
 * The fenced block around `pos`, looked for on both sides.
 *
 * Resolving to the right alone missed the block whenever the caret was at the end
 * of the closing fence, because there the position is the node's own boundary and
 * what lies to the right of it is whatever follows the block.
 */
function fencedCodeAround(state: EditorState, pos: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'FencedCode') return { from: node.from, to: node.to };
    }
  }
  return null;
}

/**
 * Where a fence line's run of backticks sits, when `pos` is on one, along with
 * whether it is the block's opening fence.
 */
function fenceRunAt(state: EditorState, pos: number): { start: number; end: number; opening: boolean; block: { from: number; to: number } } | null {
  const line = state.doc.lineAt(pos);
  const run = FENCE_RUN.exec(line.text);
  if (!run) return null;
  const block = fencedCodeAround(state, pos);
  if (!block) return null;
  const start = line.from + run[1].length;
  return { start, end: start + run[2].length, opening: state.doc.lineAt(block.from).number === line.number, block };
}

/**
 * The alert whose marker line `pos` sits on, or null.
 *
 * `> [!NOTE]` on a quote's first line is drawn as a label: an icon and the type's name, with
 * the marker itself off the screen. So it is a line of chrome exactly as a fence is, and this
 * answers the same question `fenceRunAt` answers for one.
 *
 * Read off `alerts.ts` rather than off `blockModel`, which is the shorter direction and the
 * only one that can answer it: `blockModel`'s `kindOf` maps every `Blockquote` to `'quote'` and
 * cannot tell an alert from an ordinary one.
 *
 * `body` is where the callout's text begins, which is the line after the marker, or null when
 * the marker line is the whole callout.
 */
function alertMarkerLineAt(
  state: EditorState,
  pos: number
): { quote: { from: number; to: number }; line: Line; body: Line | null } | null {
  const tree = syntaxTree(state);
  let quote: { from: number; to: number } | null = null;
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Blockquote') {
        quote = { from: node.from, to: node.to };
        break;
      }
    }
    if (quote) break;
  }
  if (!quote) return null;
  const line = state.doc.lineAt(pos);
  // The marker only ever opens the quote's first line, so a caret further down is in the body.
  if (state.doc.lineAt(quote.from).number !== line.number) return null;
  if (!alertMarkerAt(state.doc, quote.from)) return null;
  const last = state.doc.lineAt(Math.min(quote.to, state.doc.length)).number;
  return { quote, line, body: last > line.number ? state.doc.line(line.number + 1) : null };
}

/** Where a quoted line's own words begin, past its `>` markers and their spaces. */
function pastQuoteMarkers(line: Line): number {
  return line.from + (/^\s*(?:>\s?)*/.exec(line.text)?.[0].length ?? 0);
}

/**
 * Typing on a callout's marker line writes in the callout's body instead of taking it apart.
 *
 * `> [!NOTE]` draws as a label. The caret can sit anywhere along it, every position looks the
 * same, and a character typed at any of them lands inside the marker: `[X!NOTE]`, which is not
 * a marker any more, so the label vanishes and the brackets come back as text. One keystroke,
 * and the construct the person was typing in is gone from the page.
 *
 * That is the fence's problem exactly, and it takes the fence's repair: the person is typing
 * *beside* something rather than into it, so they get somewhere to type and the construct is
 * left byte for byte. The one difference is where. A fence puts the text outside its block,
 * because the inside of a code block is code. A callout's inside is prose, and somebody who
 * clicked a callout and started typing meant to write in it, so the text goes at the front of
 * the body rather than out of the callout altogether.
 *
 * A callout with no body line gets one, quoted, so what they typed is inside it rather than
 * underneath it.
 *
 * Not when the line is showing its Markdown. `> [!question]- Why this way?` is how a person
 * changes a callout's type or its title, and on that line the marker is the text being edited.
 * `showingSource` is what tells the two apart, and every other handler in this file asks it
 * first for the same reason.
 */
export const typingIntoAnAlert = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length === 0 || text.includes('\n')) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  if (showingSource(state, from)) return false;
  const alert = alertMarkerLineAt(state, from);
  if (!alert) return false;

  if (alert.body) {
    const at = pastQuoteMarkers(alert.body);
    view.dispatch({
      changes: { from: at, insert: text },
      selection: EditorSelection.cursor(at + text.length),
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
  // No body to write in, so one is added under the marker, quoted to the same depth.
  const quotes = /^\s*(?:>\s?)*/.exec(alert.line.text)?.[0] ?? '> ';
  const insert = `\n${quotes}${text}`;
  view.dispatch({
    changes: { from: alert.line.to, insert },
    selection: EditorSelection.cursor(alert.line.to + insert.length),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

/**
 * Enter and Shift+Enter on a callout's marker line open a line in the callout's body.
 *
 * The same question as typing a character there, and it needs answering separately only
 * because a line break arrives as a key rather than as input. Left alone, Enter splits
 * `> [!NOTE]` down the middle and Shift+Enter writes a backslash into it, and either way the
 * marker stops being a marker and the label comes back as brackets.
 *
 * A break on chrome means the person wants a line to write on, so they get one where their
 * writing goes: the top of the body. The marker line is not touched.
 *
 * Called from the Enter keymap and from `insertHardBreak`, which is the pair of keys that reach
 * `splitKeepingRuns`. One predicate, two call sites, for the reason `alertChromeEdit` is one
 * function: this rule has been missed by a second path three times in one issue.
 */
export function breakOnAlertMarker(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const head = state.selection.main.head;
  if (showingSource(state, head)) return false;
  const alert = alertMarkerLineAt(state, head);
  if (!alert) return false;

  const quotes = /^\s*(?:>\s?)*/.exec(alert.line.text)?.[0] ?? '> ';
  // An empty quoted line at the top of the body, and the caret on it.
  const insert = `\n${quotes.trimEnd()} `;
  view.dispatch({
    changes: { from: alert.line.to, insert },
    selection: EditorSelection.cursor(alert.line.to + insert.length),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

/**
 * Backspace and Delete on a callout's marker line take the callout's formatting, not a
 * character of `[!NOTE]`.
 *
 * The same answer the editor already gives at the left edge of a heading and on a code fence:
 * the block stops being that kind of block and the words stay. Taking one character instead
 * leaves `[!NOTE` or `[NOTE]`, which is not a marker, so the label comes back as brackets and
 * the person is looking at the wreckage of a construct they pressed one key on.
 *
 * **Every position on the line, and both keys.** There is nothing on that line a person put
 * there except a title, so there is no position where a character-sized answer means anything:
 * each one looks like the same place and each one leaves a different broken marker. Delete at
 * the end is the same, and not for symmetry — joining the body up would give `> [!NOTE]Body`,
 * which is not a callout in any renderer, so leaving it drawn as one would be a lie about the
 * file.
 *
 * Word-sized deletions take the same branch for the same reason: every position on the line is
 * inside one piece of chrome, so reaching further along it reaches nothing different.
 *
 * A title is kept, as it is everywhere else a block command takes this line, because it is the
 * only part of it that was ever the person's. `> [!TIP] Worth knowing` leaves `> Worth
 * knowing`; an untitled callout loses the line.
 *
 * Undo brings the whole callout back in one press, which is what makes taking a construct safe
 * on a one-character key, and is the same bargain `unwrapFenceAtEdge` makes.
 */
export function unwrapAlertAtEdge(view: EditorView, forward: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (showingSource(state, range.head)) return false;
  const alert = alertMarkerLineAt(state, range.head);
  if (!alert) return false;
  /*
   * Backspace from the very start of the line is the one position that means something else:
   * there the person is joining this line to what is above it, which is the blank line
   * separating the callout from the block before. Left to the editor that removes the blank
   * line and runs the callout into that block, which is a different edit on a different line
   * and nothing to do with the marker. So it is taken here too, and takes the marker.
   */
  void forward;

  const quotes = /^\s*(?:>\s?)*/.exec(alert.line.text)?.[0] ?? '';
  const marker = alertMarkerOnText(alert.line.text.slice(quotes.length));
  const title = marker?.title ?? '';
  const changes = title
    ? { from: alert.line.from, to: alert.line.to, insert: `${quotes}${title}` }
    : // The line and its own newline, so the body moves up into its place rather than joining
      // whatever is above. On the document's last line there is no newline of its own to take.
      { from: alert.line.from, to: Math.min(alert.line.to + 1, state.doc.length) };
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(alert.line.from + (title ? quotes.length + title.length : 0)),
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  });
  return true;
}

/**
 * Keep a blank line between text being typed and a divider below it, so the
 * divider stays a divider.
 *
 * Only where the line was empty before the keystroke. A line that already holds
 * text is already the heading this exists to prevent, and adding a blank line
 * underneath it then would move a construct the person is in the middle of using.
 */
export const dividerKeepsItsLine = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length === 0 || text.includes('\n')) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;

  // On a line showing its Markdown the `---` and the backticks are the text
  // being edited, so nothing here applies.
  if (showingSource(state, from)) return false;
  const line = state.doc.lineAt(from);
  if (line.text.trim() !== '') return false;
  if (line.number >= state.doc.lines) return false;
  if (!SETEXT_UNDERLINE.test(state.doc.line(line.number + 1).text)) return false;

  view.dispatch({
    changes: [
      { from, insert: text },
      { from: line.to, insert: '\n' },
    ],
    selection: EditorSelection.cursor(from + text.length),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

/**
 * Typing against a horizontal rule writes a new line rather than joining the rule.
 *
 * The rule is drawn as one object with the caret able to sit at either end of it,
 * and both ends are the edge of a line that is nothing but `---`. Typing there
 * gave `X---` or `---X`, which is a paragraph: the rule is gone and three
 * characters of punctuation are on the screen in its place.
 *
 * A person typing against something drawn as a solid line means to write next to
 * it, so that is what they get: a new line on the side they typed on, with the
 * rule untouched.
 */
export const typingBesideARule = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length === 0 || text.includes('\n')) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;

  // On a line showing its Markdown the `---` and the backticks are the text
  // being edited, so nothing here applies.
  if (showingSource(state, from)) return false;
  const line = state.doc.lineAt(from);
  if (!THEMATIC_BREAK.test(line.text)) return false;
  const atStart = from === line.from;
  if (!atStart && from !== line.to) return false;

  // Above the rule, the new line also needs the blank line the guard above keeps,
  // or the text lands directly over a `---` and becomes its heading.
  const needsGap = atStart && SETEXT_UNDERLINE.test(line.text);
  const insert = atStart ? `${text}\n${needsGap ? '\n' : ''}` : `\n${text}`;
  view.dispatch({
    changes: { from: atStart ? line.from : line.to, insert },
    selection: EditorSelection.cursor((atStart ? line.from : line.to) + (atStart ? text.length : insert.length)),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

/**
 * Typing into a code fence writes a line beside the block instead of breaking it.
 *
 * A fence line draws as the top or bottom edge of the block and its backticks are
 * not on the screen, so the caret has four positions along ```` ```js ```` that
 * all look like the same one. Three of them used to destroy the block: `X```js`,
 * `` `X``js `` and `` ``X`js `` are each a paragraph, and the code below them
 * stops being code. The closing fence has the same four and no language after
 * them.
 *
 * The position immediately after the run is the language, and typing there is the
 * one thing on a fence line a person might actually mean, so it is left alone:
 * ```` ```Xjs ```` is how the language gets edited.
 *
 * Everywhere else on the run, the text goes on a new line outside the block, on
 * the side the person typed on.
 */
export const typingIntoAFence = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length === 0 || text.includes('\n')) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;

  // On a line showing its Markdown the `---` and the backticks are the text
  // being edited, so nothing here applies.
  if (showingSource(state, from)) return false;
  const fence = fenceRunAt(state, from);
  if (!fence) return false;
  // On the opening fence the position just past the run is the language, and is
  // the one place on these lines where typing means what it says.
  if (from < fence.start || from > (fence.opening ? fence.end - 1 : fence.end)) return false;

  const at = fence.opening ? state.doc.lineAt(fence.block.from).from : state.doc.lineAt(fence.block.to).to;
  const insert = fence.opening ? `${text}\n` : `\n${text}`;
  view.dispatch({
    changes: { from: at, insert },
    selection: EditorSelection.cursor(at + (fence.opening ? text.length : insert.length)),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

/**
 * Backspace and Delete on a fence take the block's fences, not one backtick.
 *
 * Removing one character of ```` ``` ```` leaves ```` `` ````, which fences
 * nothing: the block stops being code, its backticks come back as text and the
 * lines below it are reparsed as prose. What a person means at the edge of a
 * block is what they mean at the left edge of a heading, and the editor already
 * answers that one the same way: the block stops being that kind of block and the
 * words stay where they are.
 *
 * Both fences go, because half a code block is not a thing. Undo brings it back
 * in one press, which is what makes taking a whole construct safe on a
 * one-character key.
 */
export function unwrapFenceAtEdge(view: EditorView, forward: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (showingSource(state, range.head)) return false;

  // The character this keystroke would take, rather than where the caret is.
  const target = forward ? range.head : range.head - 1;
  const line = state.doc.lineAt(range.head);
  const here = fenceRunAt(state, range.head);
  const onTheRun = here && target >= here.start && target < here.end;

  /*
   * The other way to lose a fence is to delete the newline beside it rather than
   * one of its backticks, which pulls the closing fence up onto the last line of
   * the code and leaves `const a = 1;```. Backspace at the start of that line and
   * Delete at the end of the line above it are the two keystrokes that do it.
   *
   * The opening fence needs no such guard: joining it to the paragraph above
   * leaves a fence directly under text, which CommonMark still reads as a fence.
   */
  const joiningTheCloser = !forward && here && !here.opening && range.head === line.from;
  const next = !forward || line.number >= state.doc.lines ? null : state.doc.line(line.number + 1);
  const pullingTheCloser = forward && range.head === line.to && next && fenceRunAt(state, next.from)?.opening === false;

  const fence = onTheRun || joiningTheCloser ? here : pullingTheCloser && next ? fenceRunAt(state, next.from) : null;
  if (!fence) return false;

  const open = state.doc.lineAt(fence.block.from);
  const close = state.doc.lineAt(fence.block.to);
  const changes = [{ from: open.from, to: Math.min(open.to + 1, state.doc.length) }];
  // A block whose closing fence is missing runs to the end of the document, and
  // there is only the one line to take.
  if (close.number > open.number && FENCE_RUN.test(close.text)) changes.push({ from: close.from - 1, to: close.to });
  view.dispatch({
    changes,
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  });
  return true;
}
