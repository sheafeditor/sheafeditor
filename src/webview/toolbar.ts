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

import { EditorSelection, EditorState, ChangeSpec, Extension, Line, SelectionRange, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { undo, redo, undoDepth, redoDepth, insertNewlineAndIndent } from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { formatStateAt, FormatState } from './formatState';
import { hint } from './shortcuts';
import { insertPipeTable, insertCsvTable } from './tables';
import { pickImage } from './images';
import { inlineLinkAt } from './floatingState';
import { removeLink } from './linkPopover';

type TreeNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** The syntax node each inline marker produces. */
const MARK_NODE: Record<string, string> = {
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

/** Bold, italic and the other marks pressed with a bare caret outside any word, waiting for the next typed text. */
const setPendingMarks = StateEffect.define<{ pos: number; marks: string[] } | null>();
const pendingMarksField = StateField.define<{ pos: number; marks: string[] } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPendingMarks)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
});

/** Wraps the text typed at a caret with pending marks in those marks, so a mark pressed in empty space writes nothing until there is text. */
export const pendingMarks: Extension = [
  pendingMarksField,
  EditorView.inputHandler.of((view, from, to, text) => {
    const pending = view.state.field(pendingMarksField, false);
    if (!pending || from !== pending.pos || to !== pending.pos || view.composing) return false;
    const open = pending.marks.join('');
    const close = [...pending.marks].reverse().join('');
    view.dispatch({
      changes: { from, insert: open + text + close },
      selection: { anchor: from + open.length + text.length },
      userEvent: 'input.type',
    });
    return true;
  }),
];

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
function writeLines(view: EditorView, edits: { line: Line; text: string; drop?: boolean }[]): boolean {
  const setext = setextHeadings(view.state);
  const dropped = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const { line, text, drop } of edits) {
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
      const p = parsed[i];
      if (all) return { line, text: p.lead + p.rest };
      if (p.kind === 'bullet') return { line, text: line.text };
      if (p.kind === 'task') return { line, text: p.lead + p.marker + p.rest };
      return { line, text: p.lead + '- ' + p.rest };
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
      const p = parsed[i];
      if (all) return { line, text: p.lead + p.rest };
      const depth = p.lead.length;
      // A shallower line ends the deeper lists above it.
      for (const d of [...counts.keys()]) if (d > depth) counts.delete(d);
      const n = (counts.get(depth) ?? 0) + 1;
      counts.set(depth, n);
      return { line, text: `${p.lead}${n}. ${p.rest}` };
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
    return writeLines(view, all.map((line) => ({ line, text: line.text.replace(QUOTE_RE, '$1'), drop: false })));
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
      const p = parsed[i];
      if (allTasks) return { line, text: p.lead + p.rest };
      if (p.kind === 'task') return { line, text: line.text };
      if (p.kind === 'bullet') return { line, text: p.lead + p.marker + '[ ] ' + p.rest };
      return { line, text: p.lead + '- [ ] ' + p.rest };
    })
  );
}

/**
 * Wrap the selected lines in a fenced code block, or, with the caret inside one,
 * remove its fences and keep the code. The fence grows past any backtick run in
 * the code, and keeps the first line's indentation so a block in a list stays in it.
 */
export function toggleCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  for (let node = syntaxTree(state).resolveInner(sel.head, -1) as { name: string; from: number; to: number; parent: unknown } | null; node; node = node.parent as typeof node) {
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
 * quote it is in. In a code block this is a plain newline. A heading cannot hold
 * a line break, so there it does what Enter does.
 */
export function insertHardBreak(view: EditorView): boolean {
  const { state } = view;
  const inHeading = (pos: number): boolean => !!formatStateAt(state, pos).heading;
  if (state.selection.ranges.every((range) => inHeading(range.head))) {
    return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
  }
  view.dispatch(
    state.changeByRange((range) => {
      if (formatStateAt(state, range.head).codeBlock || inHeading(range.head)) {
        return { changes: { from: range.from, to: range.to, insert: '\n' }, range: EditorSelection.cursor(range.from + 1) };
      }
      const line = state.doc.lineAt(range.from);
      const m = /^(\s*(?:>\s?)*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line.text)!;
      const cont = (m[1] ?? '') + ' '.repeat((m[2] ?? '').length);
      const insert = '\\\n' + cont;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    }),
    state.update({ scrollIntoView: true })
  );
  return true;
}

/**
 * Insert a `[text](url)` scaffold, selecting `url` for immediate typing, or
 * remove the link when the selection starts inside one, so a link is never
 * written inside another. A link cannot cross a block, so a selection over
 * several lines is linked per paragraph or heading, with every `url` selected so
 * one address fills them all; a selection over lines with no text is left
 * alone. A range in a code block is left alone.
 */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const link = inlineLinkAt(state, Math.min(sel.from + 1, sel.to));
  if (link) {
    removeLink(view, link);
    view.focus();
    return true;
  }
  const changes: ChangeSpec[] = [];
  // Each written link by where it ends in the current document, or a range kept as it is; in selection order.
  const out: ({ end: number } | { keep: SelectionRange })[] = [];
  let mainAt = 0;
  state.selection.ranges.forEach((range, i) => {
    if (i === state.selection.mainIndex) mainAt = out.length;
    if (formatStateAt(state, range.from).codeBlock || formatStateAt(state, range.to).codeBlock) {
      out.push({ keep: range });
      return;
    }
    if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) {
      const spans = textSpans(state, range.from, range.to);
      if (!spans.length) out.push({ keep: range });
      for (const span of spans) {
        changes.push({ from: span.from, insert: '[' }, { from: span.to, insert: '](url)' });
        out.push({ end: span.to });
      }
      return;
    }
    const text = state.doc.sliceString(range.from, range.to) || 'text';
    changes.push({ from: range.from, to: range.to, insert: `[${text}](url)` });
    out.push({ end: range.to });
  });
  const set = state.changes(changes);
  const ranges = out.map((o) => {
    if ('keep' in o) return o.keep.map(set);
    const after = set.mapPos(o.end, 1); // past "](url)"
    return EditorSelection.range(after - 4, after - 1);
  });
  if (!set.empty) view.dispatch({ changes: set, selection: EditorSelection.create(ranges, mainAt) });
  view.focus();
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
  { kind: 'button', command: 'bold', icon: 'bold', label: 'Bold', hintKey: 'Mod-b', run: (v) => toggleWrap(v, '**'), active: (fs) => fs.bold },
  { kind: 'button', command: 'italic', icon: 'italic', label: 'Italic', hintKey: 'Mod-i', run: (v) => toggleWrap(v, '*'), active: (fs) => fs.italic },
  { kind: 'button', command: 'strike', icon: 'strike', label: 'Strikethrough', hintKey: 'Mod-Shift-x', run: (v) => toggleWrap(v, '~~'), active: (fs) => fs.strike },
  { kind: 'button', command: 'highlight', icon: 'highlight', label: 'Highlight', hintKey: 'Mod-Shift-h', run: (v) => toggleWrap(v, '=='), active: (fs) => fs.highlight },
  { kind: 'button', command: 'code', icon: 'code', label: 'Inline code', hintKey: 'Mod-e', run: (v) => toggleWrap(v, '`'), active: (fs) => fs.code },
  { kind: 'button', command: 'link', icon: 'link', label: 'Link', hintKey: 'Mod-k', run: insertLink, active: (fs) => fs.link },
  { kind: 'button', command: 'clearFormatting', icon: 'clearFormatting', label: 'Clear formatting', run: clearFormatting },
  { kind: 'sep' },
  { kind: 'button', command: 'bullet', icon: 'list', label: 'Bullet list', hintKey: 'Mod-Shift-8', run: toggleBullet, active: (fs) => fs.list === 'bullet' },
  { kind: 'button', command: 'ordered', icon: 'listOrdered', label: 'Numbered list', hintKey: 'Mod-Shift-7', run: toggleOrdered, active: (fs) => fs.list === 'ordered' },
  { kind: 'button', command: 'task', icon: 'task', label: 'Task list', hintKey: 'Mod-Alt-4', run: toggleTask, active: (fs) => fs.list === 'task' },
  { kind: 'button', command: 'quote', icon: 'quote', label: 'Quote', hintKey: 'Mod-Shift-9', run: toggleQuote, active: (fs) => fs.quote },
  { kind: 'button', command: 'codeBlock', icon: 'codeBlock', label: 'Code block', hintKey: 'Mod-Alt-8', run: toggleCodeBlock, active: (fs) => fs.codeBlock },
  { kind: 'sep' },
  {
    kind: 'dropdown',
    command: 'insert',
    icon: 'plus',
    title: 'Insert',
    options: [
      { label: 'Markdown table', run: insertPipeTable },
      { label: 'CSV data table', run: insertCsvTable },
      { label: 'Code block', run: insertCodeBlock },
      { label: 'Divider', run: insertDivider },
      { label: 'Image', run: pickImage },
    ],
  },
];

/** A control that follows the selection, registered when the toolbar mounts. */
type Reflect = (view: EditorView, fs: FormatState) => void;
let reflectors: Reflect[] = [];

/** Reflect the formatting at the selection in the toolbar's buttons. */
export function refreshToolbar(view: EditorView): void {
  if (!reflectors.length) return;
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
    keys.textContent = opt.hintKey ? hint(opt.hintKey) : '';
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

/** Draw the table-of-contents button as pressed, or not, to match the setting. */
export function reflectTableOfContents(on: boolean): void {
  if (!tocButton) return;
  tocButton.classList.toggle('is-active', on);
  tocButton.setAttribute('aria-pressed', String(on));
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
        btn.disabled = true;
        reflectors.push((view) => void (btn.disabled = !enabled(view)));
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
  const reflect = (on: boolean): void => {
    lineNo.classList.toggle('is-active', on);
    lineNo.setAttribute('aria-pressed', String(on));
  };
  reflect(lineNumbersOn);
  lineNo.addEventListener('click', () => reflect(onToggleLineNumbers()));
  container.appendChild(lineNo);

  // View toggle: the table of contents. Pressed-ness follows `sheaf.tableOfContents`,
  // so the button is drawn from `reflectTableOfContents` once the setting has been written.
  tocButton = makeButton('listTree', 'Table of contents');
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
}
