/*
 * Editing against a delimiter the reader cannot see.
 *
 * Two keys behave badly at the same position and for related reasons: Backspace
 * and Delete, which is most of this file, and the space bar, at the end of it.
 *
 * `**bold**` is drawn as `bold`. Put the caret against the b and press
 * Backspace, and what a person expects is the character before the word to go,
 * because on the screen that is what is there: `Before bold` becomes
 * `Beforebold`. What happened instead was that the bold ended and the asterisks
 * appeared:
 *
 *   Before **bold** after     Backspace against the b     Before bold** after
 *
 * The cause is in CodeMirror rather than here, and it is reasonable on its own
 * terms. The hidden `**` is a replaced range fed to `EditorView.atomicRanges`,
 * and the built-in delete asks what to remove, finds a position inside an atomic
 * range, and widens the deletion to take the whole range. That is right for an
 * atomic range that is *drawn*: a comment box or an image is one object, and
 * Backspace against it should remove the object. It is wrong for one that is
 * drawn as nothing, because then the person is not next to an object at all.
 * They are next to a word, and the editor removed half of a pair and left the
 * other half on the screen.
 *
 * So the two kinds are told apart. A replaced range with a widget draws
 * something and keeps the built-in behaviour. A replaced range with no widget
 * is invisible, and deletion steps over it and takes the visible character on
 * the far side, leaving the formatting alone.
 *
 * Which is also the answer to the question this raised: one keystroke should
 * not unformat a word. Backspace is a one-character key. There are already two
 * ways to take formatting off a run of text and neither of them is Backspace,
 * and someone deleting the space in front of a bold word should not find the
 * word unbolded as well.
 *
 * Deleting the *last* visible character of a run is a different case and is not
 * this one. There the caret is against that character rather than against the
 * hidden delimiter, nothing here fires, and whatever already stops the editor
 * writing `****` still runs.
 */

import { EditorSelection, EditorState, findClusterBreak } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { activeLines, sourceModeOn } from './revealState';
import { showingSource } from './lineStart';

/**
 * The invisible replaced range covering `pos`, or null.
 *
 * Read off `EditorView.atomicRanges`, which is the same set the built-in delete
 * consults, so the two cannot disagree about what is atomic. A decoration built
 * with a widget draws something; one built without draws nothing, and that is
 * the whole of the distinction.
 */
function invisibleAt(view: EditorView, pos: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    source(view).between(pos, pos, (from, to, value) => {
      if (from > pos || to <= pos) return undefined;
      if (value.spec?.widget) return undefined;
      found = { from, to };
      return false;
    });
    if (found) return found;
  }
  return found;
}

/** Where the caret ends up after stepping over every invisible range in its way. */
function pastInvisible(view: EditorView, head: number, forward: boolean): number {
  let pos = head;
  // Bounded: each step moves to the far side of a range, so it cannot revisit one.
  for (let guard = 0; guard < 50; guard++) {
    const hidden = invisibleAt(view, forward ? pos : pos - 1);
    if (!hidden) return pos;
    pos = forward ? hidden.to : hidden.from;
  }
  return pos;
}

/** One character away from `pos`, counted in what a person would call a character. */
function oneCharacterFrom(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  if (forward) {
    if (pos === line.to) return Math.min(pos + 1, state.doc.length);
    return line.from + findClusterBreak(line.text, pos - line.from, true);
  }
  if (pos === line.from) return Math.max(pos - 1, 0);
  return line.from + findClusterBreak(line.text, pos - line.from, false);
}

/**
 * Backspace and Delete step over a delimiter that is drawn as nothing and take
 * the visible character beyond it.
 *
 * False unless there is such a delimiter in the way, so both keys fall through
 * to CodeMirror's own behaviour everywhere else, including next to a drawn
 * widget, which stays one object that Backspace removes whole.
 */
export function deleteAcrossInvisible(view: EditorView, forward: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  // A deletion with something selected removes the selection, which is not this.
  if (!range.empty) return false;

  const past = pastInvisible(view, range.head, forward);
  if (past === range.head) return false;

  const target = oneCharacterFrom(state, past, forward);
  const from = Math.min(past, target);
  const to = Math.max(past, target);
  if (from === to) {
    // The far side of the delimiter is the end of the document. Nothing to take,
    // and the key is still answered: falling through would delete the delimiter.
    return true;
  }
  view.dispatch({
    changes: { from, to },
    selection: EditorSelection.cursor(from),
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  });
  return true;
}

/*
 * A space typed at the inner edge of a formatted run.
 *
 * Markdown will not let an emphasis run begin or end with a space, and will not
 * let a link's `]` and `(` be separated. So a space typed at the inner edge of
 * one of those stops it being one, and the delimiters appear:
 *
 *   Before **bold** after     space against the b     Before ** bold** after
 *
 * One space typed, four asterisks arrived, and the word is no longer bold. The
 * same for italic, strikethrough, highlight, a link, an image and an autolink.
 *
 * The space belongs outside the run, because Markdown has nowhere to put it
 * inside. On the screen the two are the same: a space between `Before` and
 * `bold` either way. In the file one of them keeps the formatting and the other
 * destroys it, so the caret's side of an invisible delimiter is the only thing
 * that decides, and a person cannot see which side they are on.
 *
 * Not for a line's opening marker. A space typed at the start of a heading's
 * text belongs in the text: `#  Heading` is a heading with a space in front of
 * its words, which is what was asked for, and moving the space in front of the
 * `#` instead would shift the whole line for no reason.
 */

/*
 * Which runs this is about. Emphasis and its relatives, and no others, because
 * CommonMark's rule about them is exactly the rule that makes this a defect: the
 * delimiters only open and close a run when they sit against non-whitespace.
 *
 * Inline code is left out and belongs out. A code span may hold whatever spaces
 * it likes, and one space at each end is stripped when it is drawn, so a space
 * typed at its edge is both legal and harmless. A link is left out too: its label
 * may begin and end with spaces, so the only place a space breaks one is between
 * `]` and `(`, which is not an edge of the run and is its own question. An
 * autolink is left out because a space anywhere inside it breaks it, which makes
 * it an instance of editing a URL rather than of this.
 */
const RUN_MARKS: Record<string, string> = {
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  Highlight: 'HighlightMark',
};

/**
 * Where a space typed at `pos` should go instead, or null when `pos` is not at
 * the inner edge of a run and the space belongs where it was typed.
 *
 * Every enclosing run is asked, not just the innermost, and the outermost answer
 * wins. `***both***` is emphasis inside strong emphasis and both of them start at
 * the same drawn position, so moving the space outside the inner one alone would
 * leave `** *both***`, which is the same defect one asterisk along.
 */
/**
 * The runs a line break has to respect, which is the emphasis family plus inline
 * code. A code span is not in `RUN_MARKS`, because a space inside one is legal
 * and harmless, but a *line break* inside one is not: the span would run past the
 * end of the line, stop being a span, and put its backticks on the screen.
 */
const SPLIT_MARKS: Record<string, string> = { ...RUN_MARKS, InlineCode: 'CodeMark' };

/** The delimiter characters, which are the only thing allowed to sit between nested runs. */
const MARK_CHARS = /^[*_~=`]*$/;

/**
 * Past any enclosing run whose remaining side is nothing but delimiters.
 *
 * `***two***` is emphasis wrapping strong emphasis, and the caret at the end of
 * `two` is at the inner run's edge while still inside the outer one. Stopping at
 * the inner edge splits between the two closing delimiters and writes
 * `***two**` and `* after`. There is no text out there to keep, only marks, so
 * the edge that matters is the outer one.
 */
function pastEnclosingMarks(state: EditorState, at: number, forward: boolean, kinds: Record<string, string>): number {
  const tree = syntaxTree(state);
  // Bounded: each step moves strictly outward, and runs nest only so deep.
  for (let guard = 0; guard < 8; guard++) {
    let moved = false;
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, forward ? 1 : -1); node; node = node.parent) {
      if (!kinds[node.name]) continue;
      const edge = forward ? node.to : node.from;
      if (edge === at) continue;
      const between = forward ? state.doc.sliceString(at, edge) : state.doc.sliceString(edge, at);
      if (!MARK_CHARS.test(between)) continue;
      at = edge;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return at;
}

/** The outside of the run `pos` is at the edge of, with which way that is, or null. */
function runEdgeOutside(state: EditorState, pos: number, kinds: Record<string, string> = RUN_MARKS): { at: number; forward: boolean } | null {
  const tree = syntaxTree(state);
  let out: { at: number; forward: boolean } | null = null;
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const markName = kinds[node.name];
      if (!markName) continue;
      const marks = node.node.getChildren(markName);
      if (marks.length < 2) continue;
      if (pos === marks[0].to) {
        const at = pastEnclosingMarks(state, node.from, false, kinds);
        if (!out || at < out.at) out = { at, forward: false };
      } else if (pos === marks[marks.length - 1].from) {
        const at = pastEnclosingMarks(state, node.to, true, kinds);
        if (!out || at > out.at) out = { at, forward: true };
      }
    }
  }
  return out;
}

/**
 * The far side of a link or image whose `](` join `pos` sits in, or null.
 *
 * That join is the one position inside a link where a character must not go, and
 * it is not an edge of a run: a label may begin and end with spaces, so nothing
 * else about a link needs protecting.
 */
function linkJoin(state: EditorState, pos: number): { typing: number | null; end: number } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Link' && node.name !== 'Image') continue;
      const marks = node.node.getChildren('LinkMark');
      if (marks.length < 2) continue;
      /*
       * Two different questions about the same construct, and collapsing them
       * cost a regression in each direction.
       *
       * A *character* may go anywhere in the address, because that is how an
       * address gets written: the Link command leaves the caret there on purpose.
       * Only the one position between `]` and `(` is forbidden, since a character
       * there separates them and the link stops being one. Reading that as the
       * whole of `](address)` sent every character of a typed address to the end
       * of the label, and `[docsttps://x.io](h)` is what the real-window run saw.
       *
       * A *line break* may go nowhere in the address at all, because a link does
       * not survive one. Narrowing that to the join alone let Enter split a link
       * through its address, which the matrix saw as soon as the first fix landed.
       */
      /*
       * And a third question, which cost typing a link by hand entirely.
       *
       * `pos === marks[1].to` is the position just past the `]`. For `[a](b)` that is the
       * join and a character there must not go. For `[again]` with no address it is simply
       * the end of the link, and a character there is how the address gets started: the
       * next thing a person types is `(`. A shortcut reference link is still a `Link` node
       * with two `LinkMark`s, so this branch claimed it, and typing `[again](#` gave
       * `[again(#]` because every character after the `]` was redirected inside the label.
       * That killed link completion outright, since the text never became `](`, so the
       * heading list had nothing to fire on.
       *
       * The discriminator is whether the construct continues past its `]`. It does when
       * there is an address, and does not when the `]` closes it.
       *
       * A callout's `[!NOTE]` is a shortcut reference link too, and it used to be named here
       * as an exception, so that a character typed past its `]` was pushed back inside the
       * label. That was never a decision: it was the accident this rule started as, kept
       * because removing it cost cells in the editing matrix, and what it bought was
       * `[!NOT E]` instead of `[!NOTE]X` — one broken marker rather than another. The callout
       * has a handler of its own now, `typingIntoAnAlert`, which sends the character to the
       * callout's body and leaves the marker untouched, so the exception has nothing left to
       * protect and a link rule has no business knowing what a callout is.
       */
      if (pos === marks[1].to && marks[1].to < node.to) {
        return { typing: marks[1].from, end: node.to };
      }
      if (pos > marks[1].from && pos < node.to) return { typing: null, end: node.to };
    }
  }
  return null;
}

/**
 * A link or image whose *label* `pos` is inside, with the two pieces a break
 * through it has to be made of.
 *
 * `[text](address)` broken in the middle of `text` left `[` on one line and
 * `text](address)` on the other, so the link was gone and its brackets and
 * address were on the screen. Closing the label and opening a new one gives two
 * links to the same address, which is what a break through a link means
 * everywhere else and is the only answer that keeps both halves clickable.
 */
/**
 * The outside of a link whose label `pos` is at the very start or end of.
 *
 * The same shape as a run's edge: closing and opening the label there would make
 * a link with nothing in it, so the break goes around the whole link instead.
 */
function linkEdgeOutside(state: EditorState, pos: number): number | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Link' && node.name !== 'Image') continue;
      const marks = node.node.getChildren('LinkMark');
      if (marks.length < 2) continue;
      if (pos === marks[0].to) return node.from;
      if (pos === marks[1].from) return node.to;
    }
  }
  return null;
}

/**
 * The innermost pair of inline HTML tags `pos` sits between, as the two pieces a
 * break through them has to be made of.
 *
 * `<kbd>Esc</kbd>` is drawn as `Esc`, and a break through it left `<kbd>` on one
 * line and `Esc</kbd>` on the other, so both tags came back as text. There is no
 * node for the pair, only one for each tag, so they are matched here by name.
 *
 * Only on one line, and only where the names pair up. Anything else is either
 * already broken or an HTML block rather than an inline tag, and guessing at
 * either would write markup nobody asked for.
 */
function htmlPairAround(state: EditorState, pos: number): { close: string; open: string; edge: number | null } | null {
  const line = state.doc.lineAt(pos);
  const tags: { from: number; to: number; name: string; closing: boolean }[] = [];
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name !== 'HTMLTag') return undefined;
      const text = state.doc.sliceString(node.from, node.to);
      const named = /^<\/?\s*([A-Za-z][-A-Za-z0-9]*)/.exec(text);
      if (named) tags.push({ from: node.from, to: node.to, name: named[1].toLowerCase(), closing: text.startsWith('</') });
      return undefined;
    },
  });
  const stack: typeof tags = [];
  for (const tag of tags) {
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }
    const open = stack.pop();
    if (!open || open.name !== tag.name) return null;
    if (pos >= open.to && pos <= tag.from && stack.length === 0) {
      return {
        close: state.doc.sliceString(tag.from, tag.to),
        open: state.doc.sliceString(open.from, open.to),
        // At either end of what the tags wrap, the break goes around the pair
        // rather than through it, or it leaves a `<kbd></kbd>` with nothing in it.
        edge: pos === open.to ? open.from : pos === tag.from ? tag.to : null,
      };
    }
  }
  return null;
}

/**
 * The autolink `pos` sits inside, as the two brackets an edit through it has to take away.
 *
 * `<http://example.test>` is drawn as the address alone. Every other construct here is a pair
 * of delimiters that can be closed and opened again around a break, which is what
 * `linkLabelAt` and `htmlPairAround` do. An autolink cannot be: its delimiters are not a
 * label and an address but a single address, and half an address is not one. Closing and
 * reopening would write `<http://exa>` and `<mple.test>`, two addresses that go nowhere, out
 * of one that went somewhere.
 *
 * So the answer is the other one the ticket names: the brackets go. They were punctuation the
 * reader never saw, the construct they marked has stopped existing, and leaving them behind
 * turns one deleted character into two that appeared. The address stays as text, which is
 * what it looked like all along.
 *
 * Strictly inside, so a caret against either bracket is outside the construct and the break
 * goes around it, exactly as it does at the edge of a run.
 */
function autolinkAround(state: EditorState, pos: number): { open: number; close: number } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Autolink') continue;
      if (pos <= node.from || pos >= node.to) return null;
      // Read rather than assumed: a dialect that stopped including the brackets in the node
      // would otherwise have this deleting the first and last characters of the address.
      const text = state.doc.sliceString(node.from, node.to);
      if (!text.startsWith('<') || !text.endsWith('>')) return null;
      return { open: node.from, close: node.to - 1 };
    }
  }
  return null;
}

function linkLabelAt(state: EditorState, pos: number): { close: string; open: string } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Link' && node.name !== 'Image') continue;
      const marks = node.node.getChildren('LinkMark');
      if (marks.length < 2) continue;
      // Strictly inside the label, so a caret against either bracket is outside it.
      if (pos <= marks[0].to || pos >= marks[1].from) continue;
      return { close: state.doc.sliceString(marks[1].from, node.to), open: state.doc.sliceString(node.from, marks[0].to) };
    }
  }
  return null;
}

/**
 * The start of the hard-break marker `pos` has landed past, or null.
 *
 * A heading's marker is in front of the words and a hard break's is behind them,
 * so this is the same defect at the other end of the line. Both spellings, a
 * trailing backslash and two or more trailing spaces, are drawn as nothing, which
 * puts the end of the words and the end of the line in one place on the screen.
 * End goes to the end of the line, so a character typed there lands on the far
 * side of the marker: the spaces stop being trailing, or the backslash turns up in
 * the middle of the sentence. Either way the break is gone.
 *
 * It is quieter than the heading case and worse. Sheaf draws source lines as rows,
 * so the two lines still look like two lines afterwards, and it is only where the
 * document is published that a single newline reads as a soft break and the
 * paragraph joins up. The person who broke it cannot see that they did.
 *
 * The parser decides what is a break, so the look-alikes are left alone on their
 * own: a single trailing space, and a backslash that ends a paragraph rather than
 * a line inside one, produce no `HardBreak` node and nothing is hidden to land
 * past.
 */
function hardBreakBefore(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  /*
   * Only where the marker is hidden, and `showingSource` is not that question.
   *
   * It answers source mode and an explicit reveal, and it does not answer
   * reveal-on-line, which is the third way a line comes to show its Markdown.
   * What decides whether this marker is drawn is `lineActive` in `livePreview.ts`,
   * which is `sourceModeOn` or the line being in `activeLines`, and that is the
   * pair asked here so the rule cannot disagree with the drawing. With the
   * backslash on the screen a person typing past it meant to, and moving their
   * character would overrule them.
   *
   * The handlers below still ask `showingSource`, so under reveal-on-line they
   * move a space past a `**` the person can see. Same mistake, different rule, and
   * its own fix: it changes three behaviours that have their own cases.
   */
  if (sourceModeOn(state) || activeLines(state).has(line.number)) return null;
  let at: number | null = null;
  // The node starts at the marker and runs past the newline it belongs to, so it is
  // found by overlap with the line rather than by being contained in it.
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name !== 'HardBreak') return undefined;
      if (node.from >= line.from && node.from < pos) at = node.from;
      return undefined;
    },
  });
  return at;
}

/**
 * Where text typed at `pos` should go instead, or null when it belongs where it
 * was typed.
 *
 * A link's `](` join takes anything, not only a space: typing a letter there gave
 * `Before altX(http://example.test/i.png) after`, the image gone and its address
 * on the screen. A hard break's marker takes anything too, for the same reason: it
 * is the character arriving that destroys the break, whatever the character is. A
 * run's edge is the one that only cares about whitespace, because that is the only
 * thing CommonMark refuses to let a delimiter sit against.
 */
function typedTextBelongsAt(state: EditorState, pos: number, text: string): number | null {
  const join = linkJoin(state, pos)?.typing ?? null;
  if (join !== null) return join;
  const hardBreak = hardBreakBefore(state, pos);
  if (hardBreak !== null) return hardBreak;
  return /^\s+$/.test(text) ? (runEdgeOutside(state, pos)?.at ?? null) : null;
}

/**
 * Put typed text on the outside of a run, or at the end of a link's label,
 * rather than in the one position where it would take the construct apart.
 *
 * An input handler rather than a key binding, because this is about the text
 * arriving rather than about the key: a space from an input method, or a pasted
 * one, breaks a run the same way the space bar does.
 */
export const spaceOutsideInvisible = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length === 0 || text.includes('\n')) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  // On a line showing its Markdown the person can see the delimiter they are
  // typing against, and moving their space past it would overrule them.
  if (showingSource(state, from)) return false;
  /*
   * Whitespace inside an autolink ends it, so its brackets go and the space lands where it was
   * typed. Unlike a run, there is nowhere outside to put it: moving the space past the address
   * would leave the autolink whole and the space somewhere the person did not press it.
   *
   * Whitespace only, and not every character, because whitespace is the one thing an address
   * definitionally cannot hold. A letter typed into an address usually leaves it an address,
   * and deciding which characters do not would mean re-parsing the line here to find out.
   */
  const auto = /^\s+$/.test(text) ? autolinkAround(state, from) : null;
  if (auto) {
    view.dispatch({
      changes: [
        { from: auto.open, to: auto.open + 1 },
        { from, insert: text },
        { from: auto.close, to: auto.close + 1 },
      ],
      selection: EditorSelection.cursor(from + text.length - 1),
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
  const at = typedTextBelongsAt(state, from, text);
  if (at === null || at === from) return false;
  view.dispatch({
    changes: { from: at, insert: text },
    // The caret keeps the place it looks like it has: against the same character,
    // with what was typed now on the other side of a delimiter nobody can see.
    selection: EditorSelection.cursor(at < from ? from + text.length : from),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});

/*
 * Enter in the middle of a formatted run.
 *
 * `Before bold after`, with `bold` in bold, and the caret between the o and the
 * l. Enter cut the run in half and left the halves of its delimiters behind:
 *
 *   Before **bo          four asterisks a reader never saw, and
 *   ld** after           neither half is bold any more
 *
 * A run is a thing with two ends, and a paragraph break is not somewhere either
 * of them can be. So the run is closed before the break and opened again after
 * it, which leaves two runs, both formatted, and nothing on the screen that was
 * not there before.
 *
 * Every enclosing run is closed and reopened, innermost first on the way out and
 * outermost first on the way back in, because `***both***` is emphasis inside
 * strong emphasis and closing them in the wrong order writes `*ist**` rather than
 * `**i***`.
 *
 * A link is left alone. Splitting one would have to decide what the two halves
 * point at, and two links to the same address is a guess rather than a
 * consequence; a person who wants that can make the second one.
 */

/** Every run strictly containing `pos`, innermost first, with the delimiter that opens it. */
function runsAround(state: EditorState, pos: number): string[] {
  const tree = syntaxTree(state);
  const found: { from: number; delim: string }[] = [];
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const markName = node.name === 'InlineCode' ? 'CodeMark' : RUN_MARKS[node.name];
      if (!markName) continue;
      const marks = node.node.getChildren(markName);
      if (marks.length < 2) continue;
      // Strictly inside the run's own text, so a caret against a delimiter is outside.
      if (pos <= marks[0].to || pos >= marks[marks.length - 1].from) continue;
      if (found.some((f) => f.from === node!.from)) continue;
      found.push({ from: node.from, delim: state.doc.sliceString(marks[0].from, marks[0].to) });
    }
  }
  // Innermost first: the run that starts latest is the one nested deepest.
  return found.sort((a, b) => b.from - a.from).map((f) => f.delim);
}

/**
 * Enter inside one or more formatted runs closes them, breaks the line, and opens
 * them again, so both halves keep their formatting.
 *
 * False everywhere else, so Enter falls through to the list continuation and to
 * CodeMirror's own behaviour exactly as if this were not loaded.
 */
export function splitKeepingRuns(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  // Not where the markers are on the screen: there the break is through text the
  // person can see, and rearranging it around them is not help.
  if (showingSource(state, range.head)) return false;

  /*
   * At the very start or the very end of a run, the break goes outside it rather
   * than through it. Closing and reopening there would write a run with nothing in
   * it, `Before ****` and `**bold** after`, which is two asterisk pairs on the
   * screen for a key that was meant to start a new line. The same at a link's
   * `](` join, where the break belongs after the whole link. A space there goes to
   * the end of the label instead, because a label may hold one and a line break
   * cannot: splitting at the label's end leaves `](address)` alone on a line, drawn
   * as nothing, which is the hidden-content defect one construct along.
   */
  const edge = runEdgeOutside(state, range.head, SPLIT_MARKS);
  const outside = edge
    ? edge.at
    : (linkEdgeOutside(state, range.head) ??
       htmlPairAround(state, range.head)?.edge ??
       linkJoin(state, range.head)?.end ??
       null);
  if (outside !== null) {
    view.dispatch({
      changes: { from: outside, insert: '\n' },
      selection: EditorSelection.cursor(outside + 1),
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }

  /*
   * A break through an autolink takes its brackets away rather than closing and reopening
   * them, because half an address is not an address. See `autolinkAround`.
   */
  const auto = autolinkAround(state, range.head);
  if (auto) {
    view.dispatch({
      // Ascending and non-overlapping, since the caret is strictly between the two brackets.
      changes: [
        { from: auto.open, to: auto.open + 1 },
        { from: range.head, insert: '\n' },
        { from: auto.close, to: auto.close + 1 },
      ],
      // One character removed before the caret and one inserted at it, so it lands where it
      // started, which is the beginning of the second line.
      selection: EditorSelection.cursor(range.head),
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }

  // A break through a link's label closes the label and opens another one, so
  // both halves stay links to the same address. A pair of inline HTML tags is
  // closed and reopened the same way.
  const label = linkLabelAt(state, range.head) ?? htmlPairAround(state, range.head);
  if (label) {
    const insert = `${label.close}\n${label.open}`;
    view.dispatch({
      changes: { from: range.head, insert },
      selection: EditorSelection.cursor(range.head + insert.length),
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }

  const runs = runsAround(state, range.head);
  if (!runs.length) return false;

  /*
   * A run may not begin or end against a space, so the delimiters go on the
   * inside of any whitespace the break lands next to. Closing at the caret in
   * `**bold | with code**` would write `**bold **`, which is not bold at all, and
   * the asterisks would be on the screen. The space itself stays where the person
   * put it, at the end of the first line or the start of the second.
   */
  const text = state.doc.toString();
  let closeAt = range.head;
  while (closeAt > 0 && /\s/.test(text[closeAt - 1]) && text[closeAt - 1] !== '\n') closeAt--;
  let openAt = range.head;
  while (openAt < text.length && /\s/.test(text[openAt]) && text[openAt] !== '\n') openAt++;

  const closing = runs.join('');
  const opening = [...runs].reverse().join('');
  view.dispatch({
    changes: [
      { from: closeAt, insert: closing },
      { from: range.head, insert: '\n' },
      { from: openAt, insert: opening },
    ],
    // Where the words continue: past the newline, the whitespace and the reopened marks.
    selection: EditorSelection.cursor(openAt + closing.length + 1 + opening.length),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

/*
 * Backspace and Delete by the word, which reach further and so break more.
 *
 * `Before **bold** after` has three places where a word-sized delete used to take
 * a delimiter with it:
 *
 *   caret on the b     Before bold** after    the opening pair went
 *   caret after bold   Before **** after      the word went and left empty marks
 *   caret after the run Before **bold after   the closing pair went
 *
 * The first and the third are the single-character defect with a longer reach,
 * and they get the same answer: step over what is drawn as nothing and take the
 * word beyond it. The second is different and is already a promise the editor
 * makes elsewhere, that it never writes empty markers: taking the last of a run's
 * text takes the run.
 */

/** One word away from `pos`, counted over the line's own text. */
function wordEdgeFrom(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  if (forward && pos === line.to) return Math.min(pos + 1, state.doc.length);
  if (!forward && pos === line.from) return Math.max(pos - 1, 0);
  const text = line.text;
  let at = pos - line.from;
  const word = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);
  const step = forward ? 1 : -1;
  const peek = (): string => text[forward ? at : at - 1] ?? '';
  // Whitespace first, then a run of one kind of character, which is how every
  // editor counts a word and what CodeMirror's own group motion does.
  while (at !== (forward ? text.length : 0) && /\s/.test(peek())) at += step;
  const started = peek();
  if (started && word(started)) while (at !== (forward ? text.length : 0) && word(peek())) at += step;
  else if (started) while (at !== (forward ? text.length : 0) && !word(peek()) && !/\s/.test(peek())) at += step;
  return line.from + at;
}

/** The run whose whole text a deletion of `from`..`to` would remove, if any. */
function runEmptiedBy(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, side); node; node = node.parent) {
      const markName = SPLIT_MARKS[node.name];
      if (!markName) continue;
      const marks = node.node.getChildren(markName);
      if (marks.length < 2) continue;
      const contentFrom = marks[0].to;
      const contentTo = marks[marks.length - 1].from;
      if (from <= contentFrom && to >= contentTo) return { from: node.from, to: node.to };
    }
  }
  return null;
}

/**
 * Backspace and Delete by the word, over and around delimiters that are drawn as
 * nothing rather than through them.
 *
 * False when there is no such delimiter in reach and no run about to be emptied,
 * so the key falls through to CodeMirror's own group deletion everywhere else.
 */
export function deleteWordAcrossInvisible(view: EditorView, forward: boolean): boolean {
  if (!view.hasFocus) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (showingSource(state, range.head)) return false;

  const past = pastInvisible(view, range.head, forward);
  const target = wordEdgeFrom(state, past, forward);
  let from = Math.min(past, target);
  let to = Math.max(past, target);
  if (from === to) return past !== range.head;

  // Taking the last of a run's text takes the run, rather than leaving `****`.
  const emptied = runEmptiedBy(state, from, to);
  const steppedOver = past !== range.head;
  if (!emptied && !steppedOver) return false;
  if (emptied) {
    from = Math.min(from, emptied.from);
    to = Math.max(to, emptied.to);
  }
  view.dispatch({
    changes: { from, to },
    selection: EditorSelection.cursor(from),
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  });
  return true;
}
