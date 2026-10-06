/*
 * Top formatting toolbar.
 *
 * Renders a row of buttons into the host-provided container and wires each to a
 * command that edits the CodeMirror document — wrapping the selection in inline
 * marks (bold/italic/strike/code), toggling line prefixes (headings/lists/quote)
 * or inserting a link scaffold. The same command functions are re-used by the
 * keyboard-shortcut registry (see shortcuts.ts) so Cmd/Ctrl-B, -I, etc. mirror
 * the buttons.
 */

import { EditorSelection, EditorState, ChangeSpec, Line, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { undo, redo, undoDepth, redoDepth, insertNewlineAndIndent } from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { formatStateAt, FormatState } from './formatState';
import { drawKeyHint, hint, keyShortcuts } from './shortcuts';

import { inlineOnlyEditor } from './inlineOnly';
import { alertMarkerOnText } from './alerts';
import { breakOnAlertMarker } from './typedIntoChrome';
import { pickImage } from './imageIngest';
import { inlineLinkAt, inlineLinksIn, InlineLink } from './floatingState';
import { editLinkInPopover, openNewLinkPopover, removeLinks } from './linkPopover';
import { linkAddressAt, openLink } from './linkTarget';
import { pendingMarksField, setPendingMarks } from './pendingMarks';
import { lineTextStart } from './lineStart';
import { splitKeepingRuns } from './invisibleEdges';

type TreeNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** The syntax node each inline marker produces. */
export const MARK_NODE: Record<string, string> = {
  '**': 'StrongEmphasis',
  '*': 'Emphasis',
  '~~': 'Strikethrough',
  '==': 'Highlight',
  '`': 'InlineCode',
};

type Span = { from: number; to: number };

/**
 * A mark's own delimiters, and the text inside them once any nested mark's
 * delimiters at its edges are skipped. The spaces that keep a code span's fence
 * off a backtick at its edge (`` `a ``) count as part of the fence, since
 * CommonMark strips them from the code.
 */
function markBounds(state: EditorState, node: TreeNode): { open: Span; close: Span; innerFrom: number; innerTo: number } | null {
  const marks = node.getChildren(MARKED[node.name]);
  if (marks.length < 2) return null;
  const open: Span = { from: marks[0].from, to: marks[0].to };
  const close: Span = { from: marks[marks.length - 1].from, to: marks[marks.length - 1].to };
  if (node.name === 'InlineCode') {
    const body = state.sliceDoc(open.to, close.from);
    if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && (body[1] === '`' || body[body.length - 2] === '`')) {
      open.to += 1;
      close.from -= 1;
    }
  }
  let innerFrom = open.to;
  let innerTo = close.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const nested = MARKED[child.name] ? child.getChildren(MARKED[child.name]) : [];
    if (nested.length < 2) continue;
    if (child.from === innerFrom) innerFrom = nested[0].to;
    if (child.to === innerTo) innerTo = nested[nested.length - 1].from;
  }
  return { open, close, innerFrom, innerTo };
}

/**
 * The parts of `from`..`to` that hold inline text, one per paragraph or heading,
 * without list markers, `#` markers or the whitespace at their edges. Emphasis
 * cannot cross a block, so each part is wrapped on its own. Code blocks give none.
 */
function textSpans(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (/^(FencedCode|CodeBlock|HTMLBlock|Table)$/.test(n.name)) return false;
      if (!/^(Paragraph|ATXHeading[1-6]|SetextHeading[12])$/.test(n.name)) return;
      let start = n.from;
      let end = n.to;
      const headerMarks = n.node.getChildren('HeaderMark');
      if (n.name.startsWith('ATX')) {
        if (headerMarks.length) start = headerMarks[0].to;
        if (headerMarks.length > 1) end = headerMarks[headerMarks.length - 1].from;
      } else if (headerMarks.length) {
        end = headerMarks[0].from;
      }
      start = Math.max(start, from);
      end = Math.min(end, to);
      const text = state.doc.sliceString(start, end);
      start += text.length - text.trimStart().length;
      end -= text.length - text.trimEnd().length;
      if (start < end) spans.push({ from: start, to: end });
      return false;
    },
  });
  return spans;
}

/**
 * Toggle an inline mark (**, *, ~~, ==, `) on each selection range, reading the
 * syntax tree rather than the characters beside the selection:
 *
 * - A selection inside that mark removes it, or splits it when only part of the
 *   mark's text is selected. A nested mark (italic inside bold) does not count.
 * - Any other selection is wrapped per paragraph or heading, with its edge
 *   whitespace left outside, absorbing any same marks it overlaps.
 * - A bare caret removes the mark it is inside, wraps the word it is in, or
 *   outside any word waits for the next typed text.
 */
export function toggleWrap(view: EditorView, mark: string): boolean {
  const { state } = view;
  const name = MARK_NODE[mark];
  const tree = syntaxTree(state);
  // Nothing to write here: the delimiters would be text rather than formatting.
  // The mark's own construct is exempt, because that is what turning it off means.
  if (state.selection.ranges.some((r) => marksAreLiteral(state, r.from, r.to, name))) return false;
  let pendingAt: number | null = null;

  const markAround = (from: number, to: number, strict: boolean): TreeNode | null => {
    for (const side of [1, -1] as const) {
      for (let n: TreeNode | null = tree.resolveInner(from, side); n; n = n.parent) {
        if (n.name !== name) continue;
        if (strict ? n.from < from && to < n.to : n.from <= from && to <= n.to) return n;
      }
    }
    return null;
  };

  const tr = state.changeByRange((range) => {
    const changes: ChangeSpec[] = [];
    const cut = (from: number, to: number): void => void changes.push({ from, to });

    if (range.empty) {
      const at = range.head;
      if (formatStateAt(state, at).codeBlock) return { range };
      const inside = markAround(at, at, true);
      const bounds = inside && markBounds(state, inside);
      if (bounds) {
        cut(bounds.open.from, bounds.open.to);
        cut(bounds.close.from, bounds.close.to);
        const set = state.changes(changes);
        return { changes: set, range: EditorSelection.cursor(set.mapPos(at, -1)) };
      }
      const word = state.wordAt(at);
      if (word) {
        const set = state.changes([
          { from: word.from, insert: mark },
          { from: word.to, insert: mark },
        ]);
        return { changes: set, range: EditorSelection.cursor(set.mapPos(at, at === word.to ? -1 : 1)) };
      }
      if (state.selection.ranges.length === 1) pendingAt = at;
      return { range };
    }

    const spans = textSpans(state, range.from, range.to);
    if (!spans.length) return { range };
    const seen = new Set<string>();
    const add = (spec: { from: number; to?: number; insert?: string }): void => {
      const key = `${spec.from}:${spec.to ?? ''}:${spec.insert ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      changes.push(spec);
    };
    for (const { from, to } of spans) {
      const around = markAround(from, to, false);
      const bounds = around && markBounds(state, around);
      if (bounds) {
        if (from <= bounds.innerFrom) add({ from: bounds.open.from, to: bounds.open.to });
        else add({ from, insert: mark });
        if (to >= bounds.innerTo) add({ from: bounds.close.from, to: bounds.close.to });
        else add({ from: to, insert: mark });
        continue;
      }
      let start = from;
      let end = to;
      const absorbed: Span[] = [];
      tree.iterate({
        from,
        to,
        enter: (n) => {
          if (n.name !== name || n.to <= from || n.from >= to) return;
          const b = markBounds(state, n.node);
          if (!b) return;
          start = Math.min(start, n.from);
          end = Math.max(end, n.to);
          add({ from: b.open.from, to: b.open.to });
          add({ from: b.close.from, to: b.close.to });
          absorbed.push(b.open, b.close);
        },
      });
      let open = mark;
      let close = mark;
      if (mark === '`') {
        // A code span's fence must be longer than any backtick run in the code, with a space before a backtick at either edge.
        let inner = '';
        let at = start;
        for (const cut of absorbed.sort((x, y) => x.from - y.from)) {
          inner += state.sliceDoc(at, cut.from);
          at = cut.to;
        }
        inner += state.sliceDoc(at, end);
        const longest = (inner.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
        const fence = '`'.repeat(longest + 1);
        const pad = inner.startsWith('`') || inner.endsWith('`') ? ' ' : '';
        open = fence + pad;
        close = pad + fence;
      }
      add({ from: start, insert: open });
      add({ from: end, insert: close });
    }
    const set = state.changes(changes);
    const head = range.head === range.to;
    const a = set.mapPos(spans[0].from, 1);
    const b = set.mapPos(spans[spans.length - 1].to, -1);
    return { changes: set, range: head ? EditorSelection.range(a, b) : EditorSelection.range(b, a) };
  });

  if (pendingAt !== null) {
    const current = state.field(pendingMarksField, false);
    const marks = current && current.pos === pendingAt ? [...current.marks] : [];
    const i = marks.indexOf(mark);
    if (i >= 0) marks.splice(i, 1);
    else marks.push(mark);
    view.dispatch({ effects: setPendingMarks.of(marks.length ? { pos: pendingAt, marks } : null) });
  } else if (!tr.changes.empty) {
    view.dispatch(tr);
  }
  view.focus();
  return true;
}

/** Apply a per-line transform to every line touched by the selection. */
function transformLines(
  view: EditorView,
  fn: (text: string, indexInSelection: number, lineNumber: number) => string
): boolean {
  const { state } = view;
  const lineNums = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lineNums.add(n);
  }
  const changes: ChangeSpec[] = [];
  let i = 0;
  for (const n of [...lineNums].sort((a, b) => a - b)) {
    const line = state.doc.line(n);
    const next = fn(line.text, i++, n);
    if (next !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
  return true;
}

const HEADING_RE = /^#{1,6}\s+/;
/** A line's quote markers and indentation, then any list marker with the spaces after it, then any task box with its spaces. */
const LIST_LINE_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+|$)(?:(\[[ xX]\])([ \t]+|$))?)?/;

/**
 * A line split for the list toggles: `lead` is the quote markers and indentation
 * that stay in place, `marker` is the list marker with its spaces (without a
 * task box), and `rest` is everything after the marker and any task box.
 */
function parseListLine(text: string): { lead: string; kind: 'bullet' | 'ordered' | 'task' | null; marker: string; rest: string } {
  const m = LIST_LINE_RE.exec(text)!;
  const [whole, quotes, indent, mark, space = ''] = m;
  const lead = quotes + indent;
  if (!mark) return { lead, kind: null, marker: '', rest: text.slice(lead.length) };
  const marker = mark + space;
  const bullet = /^[-*+]$/.test(mark);
  // A task box counts only after a bullet; after a number it stays part of the text.
  if (bullet && m[5] !== undefined) return { lead, kind: 'task', marker, rest: text.slice(whole.length) };
  return { lead, kind: bullet ? 'bullet' : 'ordered', marker, rest: text.slice(lead.length + marker.length) };
}
/**
 * Constructs whose contents are read as characters rather than as prose, so a
 * `**` written inside one is two asterisks and stays on the screen.
 *
 * A code span and a fenced block are the obvious ones. The other three are less
 * obvious and were each found by writing a command's output back out and
 * reading it: an autolink's `<http://example.test>` stops being a link the
 * moment anything is put inside it, and shows its angle brackets; the address
 * half of a `[text](address)` is not prose either, though the text half is and
 * bolding that is an ordinary thing to want; and a footnote reference took the
 * marks inside its brackets and drew `[^**1**]`.
 */
const LITERAL_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'Autolink', 'URL', 'FootnoteReference']);

/**
 * Whether an inline mark written over `from`..`to` would come out as text.
 *
 * Asked of the whole range rather than of one end, because a selection can start
 * in prose and finish inside a code span, and wrapping that writes a `**` the
 * reader can see at whichever end landed in the code.
 *
 * A collapsed caret exactly on the boundary of one of these is not inside it:
 * the caret against the backtick of a code span is in the paragraph, and arming
 * bold there is a reasonable thing to do.
 *
 * `except` names the one construct that does not count, which is the construct
 * the command is toggling. Inline code is the case: being inside a code span is
 * exactly the position from which a person turns the code span off, and reading
 * it as a literal context refused the command that was meant to remove it.
 */
/**
 * Whether the mark `mark` can be written over the current selection, which is
 * what the toolbar button and the menu item both ask before drawing themselves.
 */
/**
 * Whether a block command can act on this editor at all.
 *
 * False in a table cell, whose document is one cell's inline content: a heading, a list, a
 * quote, a fence or a divider has no meaning there, and running one wrote its marker into the
 * cell's value, so Quote turned `needs review` into `> needs review`. The control is drawn
 * unavailable instead, which is what the rest of the toolbar already does with a mark that
 * cannot apply.
 */
export function blocksApply(view: EditorView): boolean {
  return !view.state.facet(inlineOnlyEditor);
}

export function marksApply(view: EditorView, mark: string): boolean {
  const { state } = view;
  return !state.selection.ranges.some((r) => marksAreLiteral(state, r.from, r.to, MARK_NODE[mark]));
}

export function marksAreLiteral(state: EditorState, from: number, to: number, except?: string): boolean {
  let literal = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (literal) return false;
      if (node.name === except) return undefined;
      if (!LITERAL_NODES.has(node.name)) return undefined;
      // Touching from outside does not count; overlapping the inside does.
      if (node.to <= from || node.from >= to) return undefined;
      if (from === to && (from === node.from || from === node.to)) return undefined;
      literal = true;
      return false;
    },
  });
  return literal;
}

/**
 * The text of a line that is about to become a list item, with any heading
 * marker taken off it.
 *
 * `- ## Heading` is valid Markdown and it is not what "make this a bullet"
 * means: it is a list item holding a heading, which is a different thing from a
 * list item, and it is what all three list commands used to write. Two of them
 * hid it, because a heading nested in a bullet draws with its hashes hidden and
 * the line looked right while the file said otherwise. The task list drew
 * `[ ] ## Heading` and gave the game away.
 *
 * Quote does not do this and should not: a quoted heading is an ordinary thing
 * to want, the quote wraps the block rather than replacing it, and Quote's own
 * comment says it keeps the heading deliberately.
 */
function unheaded(rest: string): string {
  return rest.replace(HEADING_RE, '');
}

/** One level of quote marker at the start of a line, after any indentation, with or without a space after it. */
const QUOTE_RE = /^([ \t]*)>[ \t]?/;

/**
 * The headings underlined with `===` or `---` that the selection touches, read
 * from the syntax tree: each text line's number maps to the heading's level and
 * the underline line that makes it a heading.
 */
function setextHeadings(state: EditorState): Map<number, { level: number; underline: Line }> {
  const found = new Map<number, { level: number; underline: Line }>();
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    tree.iterate({
      from: state.doc.lineAt(range.from).from,
      to: state.doc.lineAt(range.to).to,
      enter: (node) => {
        const setext = /^SetextHeading([12])$/.exec(node.name);
        if (!setext) return;
        const underline = state.doc.lineAt(node.to);
        for (let n = state.doc.lineAt(node.from).number; n < underline.number; n++) {
          found.set(n, { level: Number(setext[1]), underline });
        }
        return false;
      },
    });
  }
  return found;
}

/**
 * The lines touched by the selection that a line toggle acts on, in document
 * order. Lines of a table, code block, divider or HTML block are left out, since
 * a marker there breaks the table or changes the code. When the selection spans
 * lines its blank lines are left out too: they keep separate paragraphs apart,
 * and a marker on one would add an empty item. The underline of a `===` or `---`
 * heading stands for the heading's text lines and is never marked itself.
 */
function markableLines(state: EditorState): Line[] {
  const skip = unmarkableLines(state);
  const numbers = new Set<number>();
  let multiLine = false;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    if (last > first) multiLine = true;
    for (let n = first; n <= last; n++) numbers.add(n);
  }
  const underlines = new Set<number>();
  for (const [n, { underline }] of setextHeadings(state)) {
    if (numbers.has(underline.number)) numbers.add(n);
    underlines.add(underline.number);
  }
  return [...numbers]
    .sort((a, b) => a - b)
    .filter((n) => !skip.has(n) && !underlines.has(n))
    .map((n) => state.doc.line(n))
    .filter((line) => !(multiLine && line.text.trim() === ''));
}

/**
 * Replace each line with its new text, leaving lines whose text is unchanged
 * byte-identical. When a line of a `===` or `---` heading stops being that
 * heading (its text changes, or `drop` says so) the underline line goes too, so
 * it is not left behind as a stray paragraph.
 */
/** One line's new text, as `writeLines` takes it. */
type LineEdit = { line: Line; text: string; drop?: boolean; remove?: boolean };

/**
 * What a block command does to an alert's marker line, or null when the line is not one.
 *
 * **An alert's marker line is chrome.** `> [!NOTE]` has no text of its own on screen: what is
 * drawn there is a label, the way a code fence draws its language and a horizontal rule draws a
 * line. So a block command takes that line with the quote rather than leaving `[!NOTE]` behind
 * as literal characters, which is not what any of these commands mean and is what a person saw:
 * pressing Bullet list on a callout wrote `- [!NOTE]` and the label became text.
 *
 * A title is the exception, because it is the only part of that line that was ever the person's:
 * the label drawn in its place is the title when there is one and the type's name when there is
 * not. So a titled callout keeps its title and an untitled one loses the line. This is the rule
 * `blockModel.ts` already applies when it reads a block's text, quoted rather than reinvented,
 * because the two must not disagree about what a callout turns into.
 *
 * **One function because there have been three paths and each was found separately.** The
 * rhythm lane fixed `blockModel`, which did not move a single cell of the measurement, because
 * the block commands go through `turnInto`. Fixing `turnInto` cleared nineteen classes and left
 * four, because Bullet list, Numbered list, Task list and Quote are toggles that mark lines
 * themselves and never reach it. A fifth path would have been a fourth discovery. Now there is
 * one predicate and five callers.
 *
 * `keepQuote` is false only for Plain text, which is the one command whose whole purpose is to
 * take the quote off as well.
 */
function alertChromeEdit(line: Line, keepQuote: boolean): LineEdit | null {
  const m = BLOCK_PREFIX_RE.exec(line.text)!;
  const [, indent, quotes] = m;
  const alert = alertMarkerOnText(line.text.slice(m[0].length));
  if (!alert) return null;
  if (!alert.title) return { line, text: line.text, remove: true };
  return { line, text: keepQuote ? `${indent}${quotes}${alert.title}` : alert.title, drop: true };
}

function writeLines(view: EditorView, edits: { line: Line; text: string; drop?: boolean; remove?: boolean }[]): boolean {
  const setext = setextHeadings(view.state);
  const dropped = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const { line, text, drop, remove } of edits) {
    if (remove) {
      /*
       * The line goes entirely, and its *own* newline with it, so what followed moves up into
       * its place. Taking the newline before it instead joins it to whatever is above, which on
       * an alert's marker line is the blank line separating the callout from the previous block:
       * the callout ran into that block and a `# ` was left behind on a line of its own, drawing
       * as empty. Only on the last line of the document is there no newline of its own to take,
       * and there the one before it is the right one.
       */
      const last = line.to >= view.state.doc.length;
      changes.push(last ? { from: Math.max(0, line.from - 1), to: line.to } : { from: line.from, to: line.to + 1 });
      continue;
    }
    if (text !== line.text) changes.push({ from: line.from, to: line.to, insert: text });
    const underline = setext.get(line.number)?.underline;
    if (underline && (drop ?? text !== line.text) && !dropped.has(underline.number)) {
      dropped.add(underline.number);
      changes.push({ from: underline.from - 1, to: underline.to });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
  return true;
}

/**
 * Toggle a heading of the given level on the selected lines: off when every one
 * already is a heading of that level (written with `#` or underlined), otherwise
 * an ATX heading of that level on each line that is not one already.
 */
export function toggleHeading(view: EditorView, level: number): boolean {
  const marker = '#'.repeat(level) + ' ';
  const { state } = view;
  const setext = setextHeadings(state);
  const levelOf = (line: Line): number => setext.get(line.number)?.level ?? (HEADING_RE.exec(line.text)?.[0].trim().length ?? 0);
  const lines = markableLines(state);
  const all = lines.length > 0 && lines.every((line) => levelOf(line) === level);
  return writeLines(
    view,
    lines.map((line) => {
      const body = line.text.replace(HEADING_RE, '');
      if (all) return { line, text: body, drop: true };
      if (levelOf(line) === level) return { line, text: line.text, drop: false };
      return { line, text: marker + body, drop: true };
    })
  );
}

/** Strip any heading marker, or the underline of a `===` or `---` heading, from the selected lines (turn them into paragraphs). */
export function clearHeading(view: EditorView): boolean {
  return writeLines(
    view,
    markableLines(view.state).map((line) => ({ line, text: line.text.replace(HEADING_RE, ''), drop: true }))
  );
}

/**
 * Toggle an unordered-list marker on the selected lines. Only the list marker
 * changes: indentation and quote markers stay where they are, so a nested item
 * stays nested and a quoted line keeps the marker inside its quote. A task item
 * is not a plain bullet: it becomes one by losing its box, keeping its bullet.
 */
export function toggleBullet(view: EditorView): boolean {
  const lines = markableLines(view.state);
  const parsed = lines.map((line) => parseListLine(line.text));
  const all = lines.length > 0 && parsed.every((p) => p.kind === 'bullet');
  return writeLines(
    view,
    lines.map((line, i) => {
      const chrome = alertChromeEdit(line, true);
      if (chrome) return chrome;
      const p = parsed[i];
      if (all) return { line, text: p.lead + p.rest };
      if (p.kind === 'bullet') return { line, text: line.text };
      if (p.kind === 'task') return { line, text: p.lead + p.marker + p.rest };
      return { line, text: p.lead + '- ' + unheaded(p.rest) };
    })
  );
}

/**
 * Toggle an ordered-list marker on the selected lines, keeping indentation and
 * quote markers in place. Numbers count from 1 over the lines that take one, and
 * each depth of indentation or quoting counts on its own, so a nested item is
 * numbered within its own list.
 */
export function toggleOrdered(view: EditorView): boolean {
  const lines = markableLines(view.state);
  const parsed = lines.map((line) => parseListLine(line.text));
  const all = lines.length > 0 && parsed.every((p) => p.kind === 'ordered');
  const counts = new Map<number, number>();
  return writeLines(
    view,
    lines.map((line, i) => {
      const chrome = alertChromeEdit(line, true);
      if (chrome) return chrome;
      const p = parsed[i];
      if (all) return { line, text: p.lead + p.rest };
      const depth = p.lead.length;
      // A shallower line ends the deeper lists above it.
      for (const d of [...counts.keys()]) if (d > depth) counts.delete(d);
      const n = (counts.get(depth) ?? 0) + 1;
      counts.set(depth, n);
      return { line, text: `${p.lead}${n}. ${unheaded(p.rest)}` };
    })
  );
}

/**
 * Toggle a blockquote marker on the selected lines. When every selected line
 * with text is quoted, one level of `>` comes off each, whether or not a space
 * follows it, so a `>` on its own between paragraphs leaves a blank line, and
 * the lines of a code block or table the quote holds lose theirs with the rest.
 * Otherwise each unquoted line gains `> `, and a blank line between two selected
 * lines gains `>`, so separate paragraphs become one quote that Quote removes
 * again. The underline of a `===` or `---` heading is quoted with its text, so
 * the heading stays a heading inside the quote.
 */
export function toggleQuote(view: EditorView): boolean {
  const { state } = view;
  const setext = setextHeadings(state);
  const byNumber = new Map<number, Line>();
  for (const line of markableLines(state)) {
    byNumber.set(line.number, line);
    const underline = setext.get(line.number)?.underline;
    if (underline) byNumber.set(underline.number, underline);
  }
  const lines = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const allQuoted = lines.length > 0 && lines.every((line) => QUOTE_RE.test(line.text));
  if (allQuoted) {
    for (const line of quotedUnmarkableLines(state)) byNumber.set(line.number, line);
    const all = [...byNumber.values()].sort((a, b) => a.number - b.number);
    /*
     * Taking the quote off a callout takes its marker line with it, because the quote is what
     * made that line a marker: `[!NOTE]` outside a blockquote is not an alert in any renderer,
     * so un-quoting one and leaving the text behind writes a line that means nothing and draws
     * as the characters it is. `keepQuote` is false here for that reason and only here.
     *
     * Only this branch. Adding a level of quoting instead gives `> > [!NOTE]`, which is a
     * nested quote holding literal text — on GitHub as well, whose alerts are only read at a
     * blockquote's top level. Drawing it as text there is the file being shown as it is.
     */
    return writeLines(
      view,
      all.map((line) => alertChromeEdit(line, false) ?? { line, text: line.text.replace(QUOTE_RE, '$1'), drop: false })
    );
  }
  const edits = lines.map((line) => ({ line, text: QUOTE_RE.test(line.text) ? line.text : '> ' + line.text, drop: false }));
  const selected = (n: number): boolean =>
    state.selection.ranges.some((r) => state.doc.lineAt(r.from).number <= n && n <= state.doc.lineAt(r.to).number);
  for (let i = 1; i < lines.length; i++) {
    const gap: Line[] = [];
    for (let n = lines[i - 1].number + 1; n < lines[i].number; n++) gap.push(state.doc.line(n));
    // Only a run of selected blank lines joins two quoted lines; a skipped code block or table keeps them apart.
    if (gap.every((line) => line.text.trim() === '' && selected(line.number))) {
      for (const line of gap) edits.push({ line, text: '>', drop: false });
    }
  }
  return writeLines(view, edits);
}

/**
 * Toggle a task-list marker (`- [ ] `) on the selected lines, converting bullets
 * and numbers, with indentation and quote markers kept in place. A bullet keeps
 * its own bullet character and gains a box.
 */
export function toggleTask(view: EditorView): boolean {
  const lines = markableLines(view.state);
  const parsed = lines.map((line) => parseListLine(line.text));
  const allTasks = lines.length > 0 && parsed.every((p) => p.kind === 'task');
  return writeLines(
    view,
    lines.map((line, i) => {
      const chrome = alertChromeEdit(line, true);
      if (chrome) return chrome;
      const p = parsed[i];
      if (allTasks) return { line, text: p.lead + p.rest };
      if (p.kind === 'task') return { line, text: line.text };
      if (p.kind === 'bullet') return { line, text: p.lead + p.marker + '[ ] ' + unheaded(p.rest) };
      return { line, text: p.lead + '- [ ] ' + unheaded(p.rest) };
    })
  );
}

/** The innermost node at `pos`, looked for on the left and then on the right. */
function fencedCodeAt(state: EditorState, pos: number): { name: string; from: number; to: number; parent: unknown } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node = tree.resolveInner(pos, side) as { name: string; from: number; to: number; parent: unknown } | null; node; node = node.parent as typeof node) {
      if (node.name === 'FencedCode') return node;
    }
  }
  return null;
}

/**
 * Wrap the selected lines in a fenced code block, or, with the caret inside one,
 * remove its fences and keep the code. The fence grows past any backtick run in
 * the code, and keeps the first line's indentation so a block in a list stays in it.
 */
export function toggleCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  /*
   * Looked for on both sides of the caret. Resolving to the left alone missed
   * the block whenever the caret sat at the very start of the opening fence,
   * because there the position is the node's own boundary and the thing to its
   * left is whatever comes before the block. The command then read the caret as
   * being outside any fence and wrapped the block in a second one, giving a
   * ```` fence around a ``` fence, which is not Markdown anybody can read.
   */
  const inside = fencedCodeAt(state, sel.head);
  for (let node = inside as { name: string; from: number; to: number; parent: unknown } | null; node; node = node.parent as typeof node) {
    if (node.name !== 'FencedCode') continue;
    const open = state.doc.lineAt(node.from);
    const close = state.doc.lineAt(node.to);
    const changes: ChangeSpec[] = [{ from: open.from, to: Math.min(open.to + 1, state.doc.length) }];
    if (close.number > open.number && /^\s*(`{3,}|~{3,})\s*$/.test(close.text)) {
      changes.push({ from: close.from - 1, to: close.to });
    }
    view.dispatch({ changes });
    view.focus();
    return true;
  }
  const first = state.doc.lineAt(sel.from);
  const last = state.doc.lineAt(sel.to);
  const body = state.doc.sliceString(first.from, last.to);
  const indent = /^\s*/.exec(first.text)![0];
  const longest = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = indent + '`'.repeat(Math.max(3, longest + 1));
  const insert = `${fence}\n${body}\n${fence}`;
  view.dispatch({
    changes: { from: first.from, to: last.to, insert },
    // An empty line becomes an empty block with the caret inside it.
    ...(body.trim() === '' ? { selection: { anchor: first.from + fence.length + 1 } } : {}),
  });
  view.focus();
  return true;
}

/** True when a fenced block has no closing fence, so it runs to the end of the document. */
function unclosedFence(state: EditorState, node: { name: string; from: number; to: number }): boolean {
  if (node.name !== 'FencedCode') return false;
  const open = state.doc.lineAt(node.from);
  const close = state.doc.lineAt(node.to);
  return close.number === open.number || !/^\s*(`{3,}|~{3,})\s*$/.test(close.text);
}

/**
 * Insert a horizontal rule (`---`) as its own block below the caret's line, or
 * below the whole block when the caret is in code. A fence with no closing line
 * runs to the end of the document, so there the rule goes above the block rather
 * than into the code. A blank line always separates it from text above, where
 * `---` would turn that text into a heading.
 */
export function insertDivider(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  let line = state.doc.lineAt(head);
  let above: Line | null = null;
  const inCode = formatStateAt(state, head).codeBlock;
  if (inCode) {
    for (let node: { name: string; from: number; to: number; parent: unknown } | null = syntaxTree(state).resolveInner(head, -1); node; node = node.parent as typeof node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        if (unclosedFence(state, node)) above = state.doc.lineAt(node.from);
        else line = state.doc.lineAt(node.to);
        break;
      }
    }
  }
  if (above) {
    const lead = above.number === 1 || state.doc.line(above.number - 1).text.trim() === '' ? '' : '\n';
    const insert = lead + '---\n\n';
    view.dispatch({ changes: { from: above.from, insert }, selection: { anchor: above.from + insert.length }, scrollIntoView: true });
    view.focus();
    return true;
  }
  const blank = !inCode && line.text.trim() === '';
  const prevBlank = line.number === 1 || state.doc.line(line.number - 1).text.trim() === '';
  const before = blank ? (prevBlank ? '' : '\n') : '\n\n';
  const at = blank ? line.from : line.to;
  // Below a line, a blank line that already follows it separates the rule from what comes next.
  const nextBlank = !blank && line.number < state.doc.lines && state.doc.line(line.number + 1).text.trim() === '';
  const insert = before + (nextBlank ? '---' : '---\n');
  view.dispatch({
    changes: { from: at, to: blank ? line.to : at, insert },
    selection: { anchor: at + insert.length + (nextBlank ? 1 : 0) },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

const MARKED: Record<string, string> = {
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  Highlight: 'HighlightMark',
  InlineCode: 'CodeMark',
};

/**
 * Remove inline formatting (bold, italic, strikethrough, highlight, inline code and
 * links, keeping link text) from the selection, or from the marks around the caret.
 * Only the markers are deleted, so the text itself is untouched.
 */
export function clearFormatting(view: EditorView): boolean {
  const { state } = view;
  const cuts = new Map<string, { from: number; to: number }>();
  const cut = (from: number, to: number): void => void cuts.set(`${from}:${to}`, { from, to });
  for (const range of state.selection.ranges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const touches = range.empty
          ? node.from < range.head && range.head < node.to
          : node.to > range.from && node.from < range.to;
        if (!touches) return;
        if (node.name === 'Link') {
          const marks = node.node.getChildren('LinkMark');
          if (marks.length >= 2) {
            cut(marks[0].from, marks[0].to);
            cut(marks[1].from, node.to);
          }
          return;
        }
        const markName = MARKED[node.name];
        if (markName) for (const m of node.node.getChildren(markName)) cut(m.from, m.to);
      },
    });
  }
  if (cuts.size) view.dispatch({ changes: [...cuts.values()] });
  view.focus();
  return true;
}

/**
 * Break the line without starting a new paragraph or list item: a backslash hard
 * break, with the new line indented to the list item's text or prefixed like the
 * quote it is in. In a code block this is a plain newline.
 *
 * **Shift+Enter never breaks a heading.** Markdown's ATX heading is one line by
 * definition, so there is no spelling for a line break inside one: a trailing `\`
 * there is literal text. That is a real constraint rather than something Sheaf has
 * not got around to, which is worth saying because the obvious alternatives keep
 * being proposed. A document app keeps one heading across two visual lines because
 * its heading is a styled block that can hold a break; Markdown's cannot.
 *
 * So, in a heading:
 *
 *   caret with text after it    nothing happens
 *   caret at the end            what Enter does, which starts the next block
 *
 * Splitting it was what happened before, and it turned half a heading into body
 * text. Making the halves two headings instead would be worse: Sheaf draws a
 * heading rail beside the text, so a cosmetic keystroke would visibly restructure
 * the document a panel away within the same second, and `## section` in lower case
 * is nonsense to everything that reads the file.
 *
 * The refusal is not a dead key. The person presses it watching for the line to
 * break and watches it not break, so the absence explains itself, which is the
 * difference between this and a setting whose effect was invisible to begin with.
 * Tab already declines the same way on a paragraph or a heading, for the same
 * reason: the alternative writes something wrong into the file.
 */
export function insertHardBreak(view: EditorView): boolean {
  const { state } = view;
  const inHeading = (pos: number): boolean => !!formatStateAt(state, pos).heading;
  if (state.selection.ranges.every((range) => inHeading(range.head))) {
    // Only at the end, where starting the next block is the one remaining reading of
    // the gesture. Anywhere else the key is taken and does nothing, because every way
    // of honouring it damages the heading.
    const atEnd = state.selection.ranges.every((range) => range.empty && range.head === state.doc.lineAt(range.head).to);
    if (!atEnd) return true;
    return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
  }
  /*
   * A hard break is still a break, so it owes a formatted run the same care Enter
   * does: it cannot land between a run's delimiters without ending the run, and at
   * a link's `](` join it cannot land at all. That logic is written once, for
   * Enter, and this defers to it rather than keeping a second copy that would
   * drift. False from it means the caret is nowhere special, and the backslash
   * below is the right answer.
   */
  // A callout's marker line is chrome, and a backslash written into `[!NOTE]` takes it apart
  // exactly as a typed character does. Asked before the run logic for the same reason it is
  // asked before it on Enter.
  if (breakOnAlertMarker(view)) return true;
  if (splitKeepingRuns(view)) return true;
  /*
   * Where this gesture owes a backslash, set by the one branch below that writes a break needing one.
   * Code carries no hard breaks and a heading's is a new block, so neither owes anything, and a break
   * with no text in front of it is a plain newline. Taken from the branch rather than recomputed
   * afterwards, because the conditions are already decided there and a second copy would drift.
   */
  let owed: number | null = null;
  view.dispatch(
    state.changeByRange((range) => {
      if (formatStateAt(state, range.head).codeBlock || inHeading(range.head)) {
        return { changes: { from: range.from, to: range.to, insert: '\n' }, range: EditorSelection.cursor(range.from + 1) };
      }
      const line = state.doc.lineAt(range.from);
      const m = /^(\s*(?:>\s?)*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line.text)!;
      const cont = (m[1] ?? '') + ' '.repeat((m[2] ?? '').length);
      /*
       * A hard break breaks something, so it needs text in front of it on the line. At
       * the very start of a paragraph there is none, and the backslash was written
       * anyway: it landed on a line of its own, where it draws as nothing and reads as
       * a blank line nobody can account for, and the next thing typed there went in
       * front of it. What the person asked for at that position is a line break, and a
       * plain newline is one.
       */
      const textStart = lineTextStart(state, range.from);
      /*
       * On a *marked* line the same reasoning applies and neither answer fits. A plain
       * newline leaves the marker alone on the line above and the words below it with
       * none, so a bullet becomes an empty bullet followed by a paragraph. The backslash
       * leaves a line holding `- [ ] ` or `> `, which draws as nothing at all. So the key
       * writes nothing here, which is what it already does in a heading anywhere a break
       * cannot go: where no answer honours the gesture, the honest one is to leave the
       * document alone rather than pick the least bad edit.
       *
       * Measured to the start of the line's text rather than to column 0, because the
       * text start is the first position a person can see the caret in on a marked line,
       * and the marker-only line is reachable from every position in front of it.
       * `lineTextStart` answers `line.from` inside code and in source mode, so a fence
       * and a revealed block keep the backslash, where the marker is the content.
       */
      if (textStart > line.from && range.from <= textStart) return { range };
      /*
       * A line that already ends in a hard break gets no second marker, because a line has one
       * ending and a second marker cannot add a second break.
       *
       * It made things worse rather than merely redundant. Sheaf writes the backslash spelling, so
       * its own documents collect lines ending in one, and a second backslash is an *escape* rather
       * than a break: `line\\` parses as `Escape` where `line\` parses as `HardBreak`. So the key
       * destroyed the break that was there, joined the two lines, and left a literal backslash in the
       * text. Two spaces then a backslash stays a break and was only redundant, and both are refused
       * here for the same reason.
       */
      if (range.empty && range.from === line.to && /\\$| {2,}$/.test(line.text)) return { range };
      const noTextBefore = range.from === line.from && textStart === line.from;
      /*
       * **The newline now and the backslash when there is something to break.**
       *
       * A trailing backslash is a hard break only when a line with content follows it. Written
       * immediately, as this used to, it sits in the file as a literal backslash for as long as the
       * person has not typed the second line yet — which is the normal case, because the key is
       * pressed *before* the sentence that follows it exists. Pause, change your mind, or click away,
       * and the document keeps a character nobody wrote, drawn here and shown by every other Markdown
       * reader. Pressing a key and then not typing should leave the document as it was.
       *
       * So the break is made in two steps. What is left meanwhile is a soft line break, which renders
       * as a space and changes nothing about what the paragraph says; `completeHardBreak` below adds
       * the backslash the moment content arrives on the new line.
       */
      /*
       * **A break with text after it is earned at once; one at the end of a line waits.**
       *
       * `A plai|n line.` breaks into two lines that both have content, so the backslash means what it
       * says the moment it is written. `A plain line.|` opens a line with nothing on it, and a
       * trailing backslash there is not a hard break at all: it is a literal backslash, which is what
       * CommonMark renders and what every other reader shows. That is the one this waits on, and it
       * is the common case, because the key is pressed before the line that follows it exists.
       */
      const earnedNow = range.to < line.to;
      if (!noTextBefore && !earnedNow && state.selection.ranges.length === 1) owed = range.from;
      const mark = noTextBefore || !earnedNow ? '' : '\\';
      const insert = mark + '\n' + cont;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    }),
    { scrollIntoView: true, effects: breakPending.of(owed) }
  );
  return true;
}

/** Where a hard break is waiting for something to break: the end of the line the caret left. */
const breakPending = StateEffect.define<number | null>();

/**
 * The line a pending break opened: the one after the owed position, in the state it is read from.
 *
 * The owed position sits at the end of the line the caret left, so the line that is waiting for
 * content is the next one. Both halves below locate it this way rather than comparing against the
 * bare position, because "after the break" also means every later line in the document.
 */
function openedLine(state: EditorState, at: number) {
  const n = state.doc.lineAt(at).number + 1;
  return n <= state.doc.lines ? state.doc.line(n) : null;
}

/**
 * The position a backslash is owed, or null.
 *
 * Held for exactly as long as the gesture is unfinished, which is one keystroke in the normal case.
 *
 * **Both ways out of that state are explicit, and leaving either implicit is a bug that writes into
 * the person's file.** Mapping the position through every change and never dropping it, as this did,
 * meant the completion fired again on each later keystroke: a second line of forty characters left
 * forty backslashes, and from the second one the run read as an escaped backslash rather than a hard
 * break, so it destroyed the break it had just made. So the filter below says `null` as part of the
 * transaction that writes the backslash, and a change that lands anywhere other than the opened line
 * clears it here, because a break nobody went on to make is not owed anything and a stale position
 * would put a backslash where the key was never pressed.
 */
const breakOwedAt = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(breakPending)) return e.value;
    if (value === null || !tr.docChanged) return value;
    const opened = openedLine(tr.startState, value);
    let elsewhere = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (!opened || toA < opened.from || fromA > opened.to) elsewhere = true;
    });
    // Mapped through, so the position still means the same place after the change that kept it.
    return elsewhere ? null : tr.changes.mapPos(value, -1);
  },
});

/**
 * Finish a hard break the moment the line it opened gets content.
 *
 * A transaction filter rather than a listener, so the backslash and the character that earns it land
 * as one change: one undo takes back one gesture, and nothing in between ever sees a document with a
 * break half made.
 */
export const hardBreakCompletion = [
  breakOwedAt,
  EditorState.transactionFilter.of((tr) => {
    const at = tr.startState.field(breakOwedAt, false);
    if (at === null || at === undefined || !tr.docChanged) return tr;
    if (tr.effects.some((e) => e.is(breakPending))) return tr;
    const opened = openedLine(tr.startState, at);
    if (!opened) return tr;
    let earns = false;
    tr.changes.iterChanges((fromA, _ta, _fb, _tb, inserted) => {
      /*
       * Content arriving on the line the break opened, located in the state this was read from.
       *
       * The test used to be `fromB > at`, which is every position after the break rather than the
       * one line waiting on it, so typing further down the document completed a break the person
       * had abandoned higher up.
       */
      if (inserted.length > 0 && fromA >= opened.from && fromA <= opened.to && inserted.sliceString(0).trim() !== '') earns = true;
    });
    if (!earns) return tr;
    return [
      tr,
      {
        changes: { from: at, insert: '\\' },
        // Said rather than left to the field's own clearing rule: this change lands on the line
        // *before* the opened one, which that rule would read as a reason to keep waiting.
        effects: breakPending.of(null),
        sequential: true,
        annotations: Transaction.addToHistory.of(false),
      },
    ];
  }),
];

/**
 * Ask for a link: open the popover over the link the selection is already in, or over the
 * words it is about to wrap.
 *
 * Nothing is written to the document here. It used to write `[text](url)` with `url`
 * selected, which put raw brackets and a placeholder on the screen in an editor whose whole
 * argument is that they are not, and left `[text](url)` in the file for anybody who clicked
 * away instead of typing. The address now arrives from the popover, and the markup is written
 * once, when there is an address to write.
 *
 * A link cannot cross a block, so a selection over several lines takes one span per paragraph
 * or heading and the one address fills them all. A selection over lines with no text, and a
 * range in a code block, are left alone.
 */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const link = inlineLinkAt(state, Math.min(sel.from + 1, sel.to));
  if (link) {
    editLinkInPopover(view, link, 'url');
    return true;
  }
  const spans: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    if (formatStateAt(state, range.from).codeBlock || formatStateAt(state, range.to).codeBlock) continue;
    if (range.empty) spans.push({ from: range.head, to: range.head });
    else if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) spans.push(...textSpans(state, range.from, range.to));
    else spans.push({ from: range.from, to: range.to });
  }
  if (!spans.length) {
    view.focus();
    return true;
  }
  // A bare caret has no words yet, so the words are what it asks for first; a selection has
  // them already and the address is the one thing missing.
  openNewLinkPopover(view, spans, spans.length === 1 && spans[0].from === spans[0].to ? 'text' : 'url');
  return true;
}

/**
 * Cmd+Shift+K: take the syntax off the link under the caret, or off every link the
 * selection reaches into, keeping the words. One undo step however many links there are.
 *
 * The key is consumed even when there is no link, because `Shift-Mod-k` is Delete Line
 * in CodeMirror's default keymap and Delete Line in VS Code as well. A miss that fell
 * through would take the line out of the document, which is the one outcome nobody
 * pressing an unlink shortcut is ready for. Taking the key means Delete Line is no
 * longer on it; it was never a shortcut Sheaf listed or documented.
 */
export function removeLinkAtSelection(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const links = sel.empty ? [inlineLinkAt(state, sel.head)].filter((l): l is InlineLink => l !== null) : inlineLinksIn(state, sel.from, sel.to);
  removeLinks(view, links);
  view.focus();
  return true;
}

/**
 * Cmd+Enter: open the link under the caret, through the same opener as Cmd-click, so a
 * relative `.md` address opens in Sheaf and everything else goes to the browser. An
 * autolink, a bare URL and a reference link all count, since all three are links a
 * reader would click.
 */
export function openLinkAtCaret(view: EditorView): boolean {
  const address = linkAddressAt(view.state, view.state.selection.main.head);
  if (address) openLink(address);
  return true;
}

/** The kinds of block a line can be turned into. */
export type BlockKind = 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';

/** The block kind of the line holding a format state. Every heading level has one, so a line is never unnamed. */
export function blockKindOf(fs: FormatState): BlockKind {
  if (fs.codeBlock) return 'code';
  if (fs.heading) return `h${fs.heading}` as BlockKind;
  if (fs.list) return fs.list;
  if (fs.quote) return 'quote';
  return 'text';
}

/** A line's indentation, quote markers, heading marker and list marker (with any task box). */
const BLOCK_PREFIX_RE = /^(\s*)((?:>\s?)*)\s*(#{1,6}\s+)?((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** Blocks whose lines cannot take a line marker: a marker on a table row breaks the table, and one on a code line changes the code. */
const UNMARKABLE_BLOCKS = new Set(['Table', 'FencedCode', 'CodeBlock', 'HorizontalRule', 'HTMLBlock']);

/** The numbers of the selected lines that lie in a table or a code block, read from the syntax tree. */
function unmarkableLines(state: EditorState): Set<number> {
  const skip = new Set<number>();
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    tree.iterate({
      from: state.doc.lineAt(range.from).from,
      to: state.doc.lineAt(range.to).to,
      enter: (node) => {
        if (!UNMARKABLE_BLOCKS.has(node.name)) return;
        const last = state.doc.lineAt(node.to).number;
        for (let n = state.doc.lineAt(node.from).number; n <= last; n++) skip.add(n);
        return false;
      },
    });
  }
  return skip;
}

/**
 * The selected lines of a code block, table, rule or HTML block that a quote
 * holds. They take no line marker of their own, but the `>` in front of them is
 * the quote's, so removing the quote takes it off them too; left behind it would
 * split the quote into pieces around the block.
 */
function quotedUnmarkableLines(state: EditorState): Line[] {
  const found = new Map<number, Line>();
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    tree.iterate({
      from: state.doc.line(first).from,
      to: state.doc.line(last).to,
      enter: (node) => {
        if (!UNMARKABLE_BLOCKS.has(node.name)) return;
        let quoted = false;
        for (let p = node.node.parent; p; p = p.parent) if (p.name === 'Blockquote') quoted = true;
        if (quoted) {
          const end = Math.min(state.doc.lineAt(node.to).number, last);
          for (let n = Math.max(state.doc.lineAt(node.from).number, first); n <= end; n++) found.set(n, state.doc.line(n));
        }
        return false;
      },
    });
  }
  return [...found.values()];
}

/**
 * Turn the selected lines into one kind of block, replacing whatever block markers
 * they carry. Unlike the toggles, choosing the kind a line already is leaves it
 * alone. Only the markers at the start of each line change; the text after them
 * is untouched. Inside a fenced code block, Text removes the fences and keeps
 * the code as it is; another kind removes the fences and then marks the selected
 * lines. Inside an indented code block, Text removes the selected lines' indent.
 * Rows of a table and lines of a code block that the selection only crosses keep
 * their bytes, since neither can take a line marker.
 */
export function turnInto(view: EditorView, kind: BlockKind): boolean {
  const head = view.state.selection.main.head;
  let code: string | null = null;
  for (let node: { name: string; parent: unknown } | null = syntaxTree(view.state).resolveInner(head, -1); node; node = node.parent as typeof node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      code = node.name;
      break;
    }
  }
  if (kind === 'code') return code ? true : toggleCodeBlock(view);
  if (code === 'CodeBlock') {
    return kind === 'text' ? transformLines(view, (text) => text.replace(/^(?: {1,4}|\t)/, '')) : true;
  }
  if (code === 'FencedCode') {
    toggleCodeBlock(view);
    if (kind === 'text') return true;
  }
  const { state } = view;
  const setext = setextHeadings(state);
  // Numbers count only the lines that take a marker, so blank lines and table rows leave no gap.
  let marked = 0;
  return writeLines(
    view,
    markableLines(state).map((line) => {
      const { text } = line;
      const number = ++marked;
      const m = BLOCK_PREFIX_RE.exec(text)!;
      const [, indent, quotes, heading, list] = m;
      const body = text.slice(m[0].length);
      // A heading's level, whether written with `#` or underlined with `===` or `---`.
      const level = setext.get(line.number)?.level ?? (heading ? heading.trim().length : 0);
      const to = (next: string, drop?: boolean): { line: Line; text: string; drop?: boolean } => ({ line, text: next, drop });
      // An alert's marker line is chrome; `alertChromeEdit` carries the rule and the reasoning,
      // and every path that marks lines asks it rather than keeping a copy. Plain text is the one
      // command that takes the quote off too, so it is the one that does not keep it.
      const chrome = alertChromeEdit(line, kind !== 'text');
      if (chrome) return chrome;
      switch (kind) {
        case 'text':
          return to(body, true);
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const wanted = Number(kind[1]);
          if (level === wanted && !list) return to(text, false);
          // A heading that only changes level stays in the quote it is in.
          return to((level && !list ? indent + quotes : '') + '#'.repeat(wanted) + ' ' + body, true);
        }
        case 'bullet':
          return to(list && /^[-*+]\s+$/.test(list) && !level ? text : `${indent}- ${body}`);
        case 'ordered':
          return to(list && /^\d/.test(list) && !level ? text : `${indent}${number}. ${body}`);
        case 'task':
          return to(list && /\[[ xX]\]/.test(list) && !level ? text : `${indent}- [ ] ${body}`);
        case 'quote':
          return to(quotes && !level && !list ? text : `> ${body}`);
      }
    })
  );
}

/**
 * Insert an empty fenced code block with the caret inside it: on a blank line it
 * takes that line, otherwise it goes below the caret's line (below the whole block
 * when the caret is already in code). A selection is wrapped instead.
 */
export function insertCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const inCode = formatStateAt(state, sel.head).codeBlock;
  if (!sel.empty && !inCode) return toggleCodeBlock(view);
  let line = state.doc.lineAt(sel.head);
  if (inCode) {
    for (let node: { name: string; to: number; parent: unknown } | null = syntaxTree(state).resolveInner(sel.head, -1); node; node = node.parent as typeof node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        line = state.doc.lineAt(node.to);
        break;
      }
    }
  }
  const blank = !inCode && line.text.trim() === '';
  const at = blank ? line.from : line.to;
  const lead = blank ? '' : '\n\n';
  const insert = lead + '```\n\n```';
  view.dispatch({
    changes: { from: at, to: blank ? line.to : at, insert },
    selection: { anchor: at + lead.length + 4 },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/* ---- Icons --------------------------------------------------------------- */

/*
 * Inline single-color SVGs (Lucide geometry), drawn with `currentColor` so they
 * inherit the button's themed text color. The list icons intentionally show
 * three rows, reading as an actual multi-item list.
 */
const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  clearFormatting: '<path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/>',
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><line x1="8" x2="21" y1="5" y2="5"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="19" y2="19"/>',
  listOrdered: '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  codeBlock: '<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  fileCode: '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 13-2 2 2 2"/><path d="m13 17 2-2-2-2"/>',
  lineNumbers: '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4l1.5-1.5A1 1 0 0 0 4 15"/>',
  listTree: '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
type IconName = keyof typeof ICONS;

function svg(name: IconName, cls = ''): string {
  return (
    `<svg class="sheaf-tb-icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${ICONS[name]}</svg>`
  );
}

/* ---- Toolbar model ------------------------------------------------------- */

interface DropdownOption {
  label: string;
  hintKey?: string;
  run: (view: EditorView) => void;
  /** Marks the option that describes the selection (shown checked). */
  current?: (fs: FormatState) => boolean;
  /** Draws a rule above this option, grouping the ones before it. */
  separator?: boolean;
}

type Item =
  | {
      kind: 'button';
      command: string;
      icon: IconName;
      label: string;
      hintKey?: string;
      run: (view: EditorView) => void;
      /** For formatting buttons: whether the formatting is on at the selection. */
      active?: (fs: FormatState) => boolean;
      /** Whether the button can act at all (undo and redo). */
      enabled?: (view: EditorView) => boolean;
    }
  | {
      kind: 'dropdown';
      command: string;
      icon: IconName;
      title: string;
      options: DropdownOption[];
      /** A text label for the trigger that follows the selection, in place of the icon. */
      label?: (fs: FormatState) => string;
      /** Whether the menu can act at all. Every option of a disabled dropdown is unreachable. */
      enabled?: (view: EditorView) => boolean;
    }
  | { kind: 'sep' };

const ITEMS: Item[] = [
  { kind: 'button', command: 'undo', icon: 'undo', label: 'Undo', hintKey: 'Mod-z', run: undo, enabled: (v) => undoDepth(v.state) > 0 },
  { kind: 'button', command: 'redo', icon: 'redo', label: 'Redo', hintKey: 'Mod-Shift-z', run: redo, enabled: (v) => redoDepth(v.state) > 0 },
  { kind: 'sep' },
  {
    kind: 'dropdown',
    command: 'heading',
    icon: 'plus',
    title: 'Text style',
    // Every option is a block kind, so the whole menu goes in a cell rather than each item.
    enabled: blocksApply,
    label: (fs) => (fs.heading ? `H${fs.heading}` : 'Text'),
    // Six levels, because Markdown has six. The last three carry no shortcut: the
    // run of Mod-Alt digits ends at Task list, and a chord invented for a level
    // this rare would cost more to learn than it saves. The slash menu is their
    // keyboard path.
    options: [
      { label: 'Text', hintKey: 'Mod-Alt-0', run: (v) => turnInto(v, 'text'), current: (fs) => !fs.heading },
      { label: 'Heading 1', hintKey: 'Mod-Alt-1', run: (v) => turnInto(v, 'h1'), current: (fs) => fs.heading === 1 },
      { label: 'Heading 2', hintKey: 'Mod-Alt-2', run: (v) => turnInto(v, 'h2'), current: (fs) => fs.heading === 2 },
      { label: 'Heading 3', hintKey: 'Mod-Alt-3', run: (v) => turnInto(v, 'h3'), current: (fs) => fs.heading === 3 },
      { label: 'Heading 4', run: (v) => turnInto(v, 'h4'), current: (fs) => fs.heading === 4, separator: true },
      { label: 'Heading 5', run: (v) => turnInto(v, 'h5'), current: (fs) => fs.heading === 5 },
      { label: 'Heading 6', run: (v) => turnInto(v, 'h6'), current: (fs) => fs.heading === 6 },
    ],
  },
  { kind: 'sep' },
  /*
   * The marks are unavailable where their delimiters would be text rather than
   * formatting: inside a code span, an autolink, a link's address or a footnote
   * reference. `toggleWrap` refuses there, and a control that can be pressed and
   * does nothing is its own defect, so the button says so first. Each mark asks
   * about its own construct, which is what keeps Inline code available inside a
   * code span, where it is used to turn one off.
   */
  { kind: 'button', command: 'bold', icon: 'bold', label: 'Bold', hintKey: 'Mod-b', run: (v) => toggleWrap(v, '**'), active: (fs) => fs.bold, enabled: (v) => marksApply(v, '**') },
  { kind: 'button', command: 'italic', icon: 'italic', label: 'Italic', hintKey: 'Mod-i', run: (v) => toggleWrap(v, '*'), active: (fs) => fs.italic, enabled: (v) => marksApply(v, '*') },
  { kind: 'button', command: 'strike', icon: 'strike', label: 'Strikethrough', hintKey: 'Mod-Shift-x', run: (v) => toggleWrap(v, '~~'), active: (fs) => fs.strike, enabled: (v) => marksApply(v, '~~') },
  { kind: 'button', command: 'highlight', icon: 'highlight', label: 'Highlight', hintKey: 'Mod-Shift-h', run: (v) => toggleWrap(v, '=='), active: (fs) => fs.highlight, enabled: (v) => marksApply(v, '==') },
  { kind: 'button', command: 'code', icon: 'code', label: 'Inline code', hintKey: 'Mod-e', run: (v) => toggleWrap(v, '`'), active: (fs) => fs.code, enabled: (v) => marksApply(v, '`') },
  /*
   * These two were the only buttons with nothing to say about when they apply, and they were the only
   * two left offered while a table's grid held focus and the other twelve were drawn unavailable.
   * Pressing Link there wrote a link at the outer caret, which is the first character of a freshly
   * opened document.
   *
   * The correlation is measured and the mechanism is not: I could not establish from reading which
   * pass disables the other twelve in that state, since the toolbar was being handed a perfectly
   * ordinary outer view at `{from: 0, to: 0}` and the predicates those twelve carry should all have
   * said yes. What is certain is that `enabled` is what gives a button a reflector, a button with no
   * reflector is never brought back up to date, and these two now follow whatever pass the rest do.
   *
   * `() => true` is the honest predicate rather than a placeholder. Both commands can act wherever
   * there is an editor to act on; what they cannot do is act when the toolbar has been handed none,
   * and `refreshToolbar(undefined)` is what answers that. Saying it here is what puts them on the same
   * pass as the other twelve, in both directions: unavailable when there is nothing to act on, and
   * available again the moment there is.
   */
  { kind: 'button', command: 'link', icon: 'link', label: 'Link', hintKey: 'Mod-k', run: insertLink, active: (fs) => fs.link, enabled: () => true },
  { kind: 'button', command: 'clearFormatting', icon: 'clearFormatting', label: 'Clear formatting', run: clearFormatting, enabled: () => true },
  { kind: 'sep' },
  { kind: 'button', command: 'bullet', icon: 'list', label: 'Bullet list', hintKey: 'Mod-Shift-8', run: toggleBullet, active: (fs) => fs.list === 'bullet', enabled: blocksApply },
  { kind: 'button', command: 'ordered', icon: 'listOrdered', label: 'Numbered list', hintKey: 'Mod-Shift-7', run: toggleOrdered, active: (fs) => fs.list === 'ordered', enabled: blocksApply },
  { kind: 'button', command: 'task', icon: 'task', label: 'Task list', hintKey: 'Mod-Alt-4', run: toggleTask, active: (fs) => fs.list === 'task', enabled: blocksApply },
  { kind: 'button', command: 'quote', icon: 'quote', label: 'Quote', hintKey: 'Mod-Shift-9', run: toggleQuote, active: (fs) => fs.quote, enabled: blocksApply },
  { kind: 'button', command: 'codeBlock', icon: 'codeBlock', label: 'Code block', hintKey: 'Mod-Alt-8', run: toggleCodeBlock, active: (fs) => fs.codeBlock, enabled: blocksApply },
  { kind: 'sep' },
  {
    kind: 'dropdown',
    command: 'insert',
    icon: 'plus',
    title: 'Insert',
    // A table, a CSV table, a fence, a divider and an image are all blocks, so this goes whole
    // in a cell too. Nothing here is an inline insertion; Link is a button of its own.
    enabled: blocksApply,
    options: [
      /*
       * The two table insertions are fetched when one is chosen, rather than imported here.
       *
       * They are two commands, and importing them brought the whole grid with them: `tables.ts` is
       * 82 KB raw and carries the kanban view and both column-measuring modules behind it. That
       * made every surface holding this toolbar pay for the grid, which for the `field` profile,
       * the cell editor, was 100 KB of the 132 KB it was over its budget by. The editor it lives
       * inside had already loaded all of it, so nothing was gained anywhere.
       *
       * This changes what a profile downloads and not what anybody sees. The dropdown keeps both
       * entries and keeps `blocksApply`, so they are still offered and still drawn unavailable in a
       * cell, which is what the comment above asks for. In a document the grid is loaded already,
       * so the import resolves from a chunk the page holds and the insertion is as immediate as it
       * was. Only a surface that has never drawn a table waits, once, and such a surface could not
       * have offered this button at all before.
       */
      { label: 'Markdown table', run: (view) => void import('./tables.js').then((m) => m.insertPipeTable(view)) },
      { label: 'CSV data table', run: (view) => void import('./tables.js').then((m) => m.insertCsvTable(view)) },
      { label: 'Code block', run: insertCodeBlock },
      { label: 'Divider', run: insertDivider },
      { label: 'Image', run: pickImage },
    ],
  },
];

/** A control that follows the selection, registered when the toolbar mounts. */
type Reflect = (view: EditorView, fs: FormatState) => void;
let reflectors: Reflect[] = [];
/*
 * Every control that can be drawn unavailable, for the case where there is no editor to ask at
 * all. Collected as the toolbar is built, because a reflector takes a view and so has nothing to
 * say when there is not one.
 */
let disablable: (HTMLButtonElement | HTMLInputElement)[] = [];

/** Reflect the formatting at the selection in the toolbar's buttons. */
/**
 * Bring every control up to date against the editor the toolbar is acting on.
 *
 * `undefined` means there is no such editor, which happens while a CSV or TSV cell has focus: a
 * data field is a plain text box holding data rather than Markdown, so there is nothing Bold
 * could be applied to. Everything is drawn unavailable, rather than left looking live from the
 * last refresh while every press does nothing, which is the same "it looks available and it is
 * not" this whole area was wrong about.
 */
export function refreshToolbar(view: EditorView | undefined): void {
  if (!reflectors.length) return;
  if (!view) {
    for (const el of disablable) el.disabled = true;
    return;
  }
  const fs = formatStateAt(view.state);
  for (const reflect of reflectors) reflect(view, fs);
}

const titleFor = (label: string, hintKey?: string): string => (hintKey ? `${label} (${hint(hintKey)})` : label);

/** A toolbar icon button that keeps editor focus/selection intact on click. */
function makeButton(icon: IconName, title: string, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sheaf-tb-btn' + (extraClass ? ' ' + extraClass : '');
  btn.innerHTML = svg(icon);
  btn.title = title;
  btn.setAttribute('aria-label', title);
  // Don't let the button steal the editor's selection when clicked.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  return btn;
}

/** A trigger and popup menu: the text style picker and the insert menu. */
function makeDropdown(item: Extract<Item, { kind: 'dropdown' }>, getView: () => EditorView | undefined): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sheaf-tb-dropdown';
  const canAct = item.enabled;
  // Registered below once the trigger exists, so a run with no editor can draw it unavailable.

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sheaf-tb-btn sheaf-tb-dd-trigger';
  trigger.dataset.command = item.command;
  const face = item.label ? `<span class="sheaf-tb-dd-label">Text</span>` : svg(item.icon);
  trigger.innerHTML = face + svg('chevron', 'sheaf-tb-caret');
  trigger.title = item.title;
  trigger.setAttribute('aria-label', item.title);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('mousedown', (e) => e.preventDefault());

  const menu = document.createElement('div');
  menu.className = 'sheaf-tb-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  // A menu opened with a click holds keyboard focus itself until an arrow key reaches an item.
  menu.tabIndex = -1;
  menu.style.outline = 'none';

  const entries = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('.sheaf-tb-menu-item'));
  /** Whether the open menu came from a pointer click rather than the keyboard. */
  let fromPointer = false;
  /** Close the menu; with `refocus`, focus returns to the editor for a menu opened with a click, else to the trigger. */
  const close = (refocus = false): void => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocDown);
    if (!refocus) return;
    if (fromPointer) getView()?.focus();
    else trigger.focus();
  };
  const onDocDown = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) close(fromPointer && menu.contains(document.activeElement));
  };
  /**
   * Open the menu. From the keyboard the first item takes focus. From a click the
   * menu itself does, so the arrow keys and Escape reach it; the trigger kept focus
   * in the editor on mousedown, and the editor's selection stays in its state.
   */
  const open = (focusFirst: boolean): void => {
    fromPointer = !focusFirst;
    menu.hidden = false;
    menu.style.left = '';
    menu.style.right = '';
    // Keep the menu inside the window when the trigger sits near its right edge.
    if (menu.getBoundingClientRect().right > window.innerWidth - 4) {
      menu.style.left = 'auto';
      menu.style.right = '0';
    }
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocDown);
    if (focusFirst) entries()[0]?.focus();
    else menu.focus({ preventScroll: true });
  };
  disablable.push(trigger);
  if (canAct) {
    /*
     * Asked once now rather than assumed available until the next refresh, for the reason the
     * buttons carry: a control whose usual answer is "yes" would otherwise be drawn wrong on
     * first paint. `disabled` on the trigger is enough, because a menu that cannot be opened
     * has no reachable options.
     */
    const view = getView();
    trigger.disabled = view ? !canAct(view) : true;
    reflectors.push((v) => void (trigger.disabled = !canAct(v)));
  }
  trigger.addEventListener('click', (e) => (menu.hidden ? open(e.detail === 0) : close(menu.contains(document.activeElement))));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && menu.hidden) {
      e.preventDefault();
      open(true);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = entries();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.length;
      // From the menu itself (no item focused yet), ArrowDown reaches the first item and ArrowUp the last.
      list[e.key === 'ArrowDown' ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  });

  const checks: { el: HTMLButtonElement; current: (fs: FormatState) => boolean }[] = [];
  for (const opt of item.options) {
    if (opt.separator) {
      const rule = document.createElement('div');
      rule.className = 'sheaf-tb-menu-sep';
      rule.setAttribute('role', 'separator');
      menu.appendChild(rule);
    }
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'sheaf-tb-menu-item';
    mi.setAttribute('role', opt.current ? 'menuitemradio' : 'menuitem');
    const label = document.createElement('span');
    label.textContent = opt.label;
    const keys = document.createElement('span');
    keys.className = 'sheaf-tb-menu-key';
    // Drawn for the eye, announced through `aria-keyshortcuts`. See the note in `contextmenu.ts`.
    keys.setAttribute('aria-hidden', 'true');
    if (opt.hintKey) {
      drawKeyHint(keys, opt.hintKey);
      mi.setAttribute('aria-keyshortcuts', keyShortcuts(opt.hintKey));
    }
    mi.append(label, keys);
    mi.addEventListener('mousedown', (e) => e.preventDefault());
    mi.addEventListener('click', () => {
      const view = getView();
      // A menu opened with a click gives focus back to the editor before the command runs.
      close(fromPointer);
      if (view) opt.run(view);
    });
    if (opt.current) checks.push({ el: mi, current: opt.current });
    menu.appendChild(mi);
  }

  if (item.label || checks.length) {
    const labelEl = trigger.querySelector('.sheaf-tb-dd-label');
    reflectors.push((_view, fs) => {
      if (item.label && labelEl) {
        const text = item.label(fs);
        labelEl.textContent = text;
        trigger.title = `${item.title}: ${text}`;
        trigger.setAttribute('aria-label', `${item.title}: ${text}`);
      }
      for (const c of checks) {
        const on = c.current(fs);
        c.el.classList.toggle('is-checked', on);
        c.el.setAttribute('aria-checked', String(on));
      }
    });
  }

  wrap.append(trigger, menu);
  return wrap;
}

/**
 * The table-of-contents button, and how it is drawn when the panel is on.
 *
 * Unlike the line-number toggle, this one does not decide its own state: the setting
 * does, and the setting comes back from the host after a round trip, so the button is
 * told what to show rather than flipping itself.
 */
let tocButton: HTMLButtonElement | undefined;

/** What the table of contents is drawn as: the three states the setting takes. */
export type TocButtonState = 'shown' | 'collapsed' | 'hidden';

/**
 * What the button says it is in, and what the next press will do.
 *
 * Three states and one button, so the state cannot be read off pressed-ness alone.
 * Pressed means drawn at all, the folded look is its own class, and the tooltip names
 * both where it is and what pressing it does next, because a cycling control that only
 * says its own name leaves the person to press it and find out.
 */
const TOC_TITLE: Record<TocButtonState, string> = {
  shown: 'Table of contents: showing. Fold the list away',
  collapsed: 'Table of contents: folded. Hide it',
  hidden: 'Table of contents: hidden. Show it',
};

/** The state one press moves to, and so the order the button cycles in. */
export function nextTocState(state: TocButtonState): TocButtonState {
  return state === 'shown' ? 'collapsed' : state === 'collapsed' ? 'hidden' : 'shown';
}

/**
 * What the button is currently drawn as, which is what a press moves on from.
 *
 * The setting is the truth, but it comes back from the host a round trip later, and two
 * presses in that window would both work out the same next state and the second would do
 * nothing. So the button keeps what it is showing, moves on its own press, and is
 * corrected by the next `reflectTableOfContents` if the host disagrees.
 */
let tocState: TocButtonState = 'hidden';

export function tocButtonState(): TocButtonState {
  return tocState;
}

/**
 * The line-number button, kept so its state can be redrawn from outside `mountToolbar`.
 *
 * Whether the gutter is on is a setting, so it can change without this editor having been
 * pressed: another editor's toggle, or an edit in the Settings pane. The button has to follow
 * that, or it says the opposite of what the gutter is doing.
 */
let lineNumbersButton: HTMLButtonElement | null = null;

/** Draw the line-number button to match whether the gutter is on. */
export function reflectLineNumbers(on: boolean): void {
  if (!lineNumbersButton) return;
  lineNumbersButton.classList.toggle('is-active', on);
  lineNumbersButton.setAttribute('aria-pressed', String(on));
}

/** Draw the table-of-contents button to match the state the panel is in. */
export function reflectTableOfContents(state: TocButtonState | boolean): void {
  if (!tocButton) return;
  const now: TocButtonState = state === true ? 'shown' : state === false ? 'hidden' : state;
  tocState = now;
  tocButton.classList.toggle('is-active', now !== 'hidden');
  tocButton.classList.toggle('is-folded', now === 'collapsed');
  tocButton.setAttribute('aria-pressed', String(now !== 'hidden'));
  tocButton.title = TOC_TITLE[now];
  // The name has to carry the state as well, because the tooltip is not read out and
  // pressed-ness cannot say which of three. `.sheaf-tb-toc` is what finds the button.
  tocButton.setAttribute('aria-label', TOC_TITLE[now]);
}

/**
 * Populate `container` with the formatting toolbar. Editing buttons run against
 * the current view (resolved lazily via `getView`, since the view mounts after
 * the toolbar). Trailing actions — open the raw Markdown and show keyboard
 * shortcuts — are pushed to the right edge by a flex spacer.
 */
export function mountToolbar(
  container: HTMLElement,
  getView: () => EditorView | undefined,
  onShowShortcuts: () => void,
  onOpenRaw: () => void,
  onToggleLineNumbers: () => boolean,
  lineNumbersOn: boolean,
  onToggleTableOfContents: () => void = () => {},
  tableOfContentsOn = false
): void {
  reflectors = [];
  disablable = [];
  for (const item of ITEMS) {
    if (item.kind === 'sep') {
      const sep = document.createElement('span');
      sep.className = 'sheaf-tb-sep';
      container.appendChild(sep);
    } else if (item.kind === 'dropdown') {
      container.appendChild(makeDropdown(item, getView));
    } else {
      const btn = makeButton(item.icon, titleFor(item.label, item.hintKey));
      btn.dataset.command = item.command;
      disablable.push(btn);
      btn.addEventListener('click', () => {
        const view = getView();
        if (view) item.run(view);
      });
      if (item.active) {
        const active = item.active;
        btn.setAttribute('aria-pressed', 'false');
        reflectors.push((_view, fs) => {
          const on = active(fs);
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-pressed', String(on));
        });
      }
      if (item.enabled) {
        const enabled = item.enabled;
        /*
         * Asked once now rather than assumed false until the next update. Undo and
         * Redo were the only buttons with this, and starting disabled happens to be
         * right for them, so nothing noticed. It is wrong for anything whose usual
         * answer is available: the marks would be drawn unavailable on first paint
         * and come back the moment the caret moved.
         */
        const view = getView();
        btn.disabled = view ? !enabled(view) : true;
        reflectors.push((v) => void (btn.disabled = !enabled(v)));
      }
      container.appendChild(btn);
    }
  }

  const spacer = document.createElement('span');
  spacer.className = 'sheaf-tb-spacer';
  container.appendChild(spacer);

  // View toggle: show/hide the line-number gutter. Reflects state via .is-active
  // and aria-pressed, updated from the boolean the toggle command returns.
  const lineNo = makeButton('lineNumbers', 'Toggle line numbers');
  lineNumbersButton = lineNo;
  reflectLineNumbers(lineNumbersOn);
  lineNo.addEventListener('click', () => reflectLineNumbers(onToggleLineNumbers()));
  container.appendChild(lineNo);

  // View toggle: the table of contents. What it is drawn as follows `sheaf.tableOfContents`,
  // so the button is drawn from `reflectTableOfContents` once the setting has been written.
  tocButton = makeButton('listTree', 'Table of contents', 'sheaf-tb-toc');
  tocButton.setAttribute('aria-pressed', 'false');
  reflectTableOfContents(tableOfContentsOn);
  tocButton.addEventListener('click', onToggleTableOfContents);
  container.appendChild(tocButton);

  const raw = makeButton('fileCode', 'Open raw Markdown');
  raw.addEventListener('click', onOpenRaw);
  container.appendChild(raw);

  const help = makeButton('keyboard', `Keyboard shortcuts (${hint('Mod-/')})`, 'sheaf-tb-help');
  help.addEventListener('click', onShowShortcuts);
  container.appendChild(help);

  watchWrapping(container);
}

/**
 * Mark the bar while its controls are on more than one row, so the stylesheet can
 * stop pushing the view buttons to the right edge.
 *
 * The spacer is what right-justifies them, and on one row that is the shape people
 * expect. Once the bar wraps it is the wrong one: the four view buttons are carried
 * to the end of the last row with a hole in front of them, reading as a set that has
 * come adrift rather than as the same toolbar continuing. Packed left, the rows read
 * as one run of controls that happens to fold.
 *
 * Measuring beats a width: what matters is whether the bar folded, and that depends
 * on the controls in it and the font the window draws them in, not on a number we
 * could pick here. Collapsing the spacer cannot change the answer, since a spacer is
 * zero wide until there is spare room to grow into, so there is no flapping between
 * the two states.
 */
function watchWrapping(container: HTMLElement): void {
  const check = (): void => {
    const controls = container.querySelectorAll<HTMLElement>('.sheaf-tb-btn');
    const first = controls[0];
    const last = controls[controls.length - 1];
    // jsdom has no layout and reports every offset as 0, which reads as one row.
    container.classList.toggle('is-wrapped', !!first && !!last && last.offsetTop > first.offsetTop);
  };
  check();
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => check()).observe(container);
}
