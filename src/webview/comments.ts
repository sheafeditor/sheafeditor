/*
 * Comments: a `<!-- … -->` that takes its own lines, drawn as a callout box.
 *
 * A comment is a note to whoever is working on the document. Markdown gives it
 * no shape of its own, so it used to run through the middle of the prose as one
 * long highlighted line and a reader had to step over it. Here it becomes a box
 * in the style the `> [!NOTE]` callouts already use: a rule down its side, an
 * icon, the label **Comment**, and a chevron that shuts it down to its label and
 * first line.
 *
 * Three things bound what this covers.
 *
 * **A comment that takes its own lines.** The box replaces whole lines, so the
 * comment has to own them: it starts at the beginning of its first line and ends
 * at the end of its last, and nothing else shares them. A comment written inside
 * a sentence keeps the styling it has always had, because a box in the middle of
 * a paragraph would break the sentence in two. A comment that shares a line with
 * other text, and one that is never closed, are left as they are written.
 *
 * **Code is code.** `<!-- -->` inside a fenced or indented code block is part of
 * the example, and the parser says so: it is code text rather than a comment
 * block, so nothing here ever sees it.
 *
 * **The bytes never move.** Drawing, collapsing, hiding and reloading are all
 * view state. Nothing in this file writes to the document, and the box is a
 * replace decoration over text that stays exactly as it was typed. The caret
 * coming into the comment puts the box away and shows the angle brackets, the
 * same way every other construct shows its source.
 *
 * Whether a comment is collapsed is kept by the host, outside the document, the
 * way hand-set column widths and boards are: keyed by the document and by a
 * digest of the comment's own text, asked for once when the page loads. A host
 * that does not answer, such as a browser tab, leaves a collapse to last as long
 * as the page does. Two identical comments in one document share a key and so
 * collapse together, which is the same trade the tables make.
 */

import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { EditorSelection, EditorState, Extension, Range, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { digest } from './columnLayout';
import { activeLines, setReveal, sourceModeOn } from './livePreview';
import { revealRange } from './revealBlock';

/** Whether comments are drawn in full or shrunk to a marker. */
export type CommentsMode = 'show' | 'hidden';

/** The word on every comment box. Comments have no types, so there is only one. */
const LABEL = 'Comment';

/** A speech bubble, stroked like the alert icons so it takes the label's colour. */
const ICON = 'M4.5 4.5h15v11h-9L6.5 19.5V15.5H4.5ZM8 9.3h8M8 12.3h5';

/** The chevron on the fold control: a `>` that the stylesheet turns downward when the box is open. */
const CHEVRON = 'M9 5l7 7-7 7';

/**
 * The stylesheet's measures for a comment box, in pixels, at the default font
 * size. CodeMirror places a block widget it has not drawn yet at the height the
 * widget estimates and corrects the document below once it is drawn, so an
 * estimate far from the truth makes the page jump as it scrolls into view.
 */
const EST = {
  /** One line of comment text: 0.95em at 16px, at a line height of 1.5. */
  line: 22.8,
  /** The label row, icon and chevron included. */
  head: 22,
  /** The box's padding above and below, its rules, and the gap either side of it. */
  frame: 34,
  /** The marker drawn in place of a box when comments are hidden. */
  marker: 22,
};

// ---- What counts as a comment ---------------------------------------------

/** One comment drawn as a box: where it is, what it says, and what it is kept under. */
export interface CommentBlock {
  /** The start of its first line. */
  from: number;
  /** The end of its last line. */
  to: number;
  /** The digest of its raw text, which is what a collapse is remembered by. */
  key: string;
  /** The text between the angle brackets, by line, with blank lines dropped. */
  lines: string[];
}

/** What a comment's collapse is kept under: a digest of the comment exactly as written. */
export function commentKeyFor(raw: string): string {
  return digest(raw);
}

/** The text between `<!--` and `-->`, as the lines a reader would see. */
function commentLines(raw: string): string[] {
  const inner = raw.slice(4, -3);
  const lines = inner.split('\n').map((l) => l.trim());
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Every comment in the document that takes its own lines.
 *
 * The parser reports a comment at block level as a `CommentBlock`. That node
 * runs to the end of the line the closing `-->` is on, so a comment with text
 * after it on the same line does not end in `-->` and is left alone; so is one
 * that is never closed, whose node runs to the end of the document.
 */
export function commentBlocks(state: EditorState): CommentBlock[] {
  const found: CommentBlock[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'CommentBlock') return;
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      // Whole lines and nothing else: a block decoration replaces lines, so a
      // comment indented into a quote or sharing a line with text stays source.
      if (node.from !== first.from || node.to !== last.to) return;
      const raw = doc.sliceString(node.from, node.to);
      if (!raw.startsWith('<!--') || !raw.endsWith('-->') || raw.length < 7) return;
      found.push({ from: node.from, to: node.to, key: commentKeyFor(raw), lines: commentLines(raw) });
    },
  });
  return found;
}

// ---- What the page remembers ----------------------------------------------

/** The comments collapsed in this document, by comment key. */
const collapsed = new Set<string>();

/**
 * Comments a person asked to see again while `sheaf.comments` is `hidden`, by
 * key. Pressing a marker is about this one comment now, so it is not written
 * down anywhere: turning the setting back and forth clears it, and so does a
 * reload.
 */
const revealedWhileHidden = new Set<string>();

let mode: CommentsMode = 'show';

/**
 * Bumped whenever anything above changes. The field compares it on every
 * update, so the next transaction redraws with the new answer rather than
 * waiting for the document or the selection to change.
 */
let version = 0;

/** Every mounted editor's way to redraw when something outside a transaction changes. */
const redrawers = new Set<() => void>();

function changed(): void {
  version++;
  for (const redraw of redrawers) redraw();
}

/** Draw comments in full, or shrink each to a marker. */
export function setCommentsMode(next: CommentsMode): void {
  if (next === mode) return;
  mode = next;
  // A marker pressed under the old setting says nothing about the new one.
  revealedWhileHidden.clear();
  changed();
}

/** Whether comments are drawn in full, as the setting has it now. */
export function commentsMode(): CommentsMode {
  return mode;
}

// ---- Keeping a collapse ----------------------------------------------------

let foldsHost: ((message: unknown) => void) | null = null;
let foldsSeq = 0;

/**
 * Where the stored collapses come from and go to. Setting a host asks it for
 * this document's collapses straight away, which is before the document itself
 * arrives when the page asks first, so a comment is usually drawn collapsed
 * from the start rather than shutting a moment later.
 */
export function setCommentFoldsHost(send: ((message: unknown) => void) | null): void {
  foldsHost = send;
  send?.({ type: 'commentFoldsRead', id: `comments-${++foldsSeq}` });
}

/**
 * The host's answer: every comment collapsed in this document. It is the whole
 * set rather than a change to it, so a key the host does not name is open.
 * Anything that is not a key marked `true` is dropped, which is how a damaged
 * or foreign value reads as none.
 */
export function handleCommentFolds(_id: string, folds: unknown): void {
  collapsed.clear();
  if (folds && typeof folds === 'object' && !Array.isArray(folds)) {
    for (const [key, value] of Object.entries(folds as Record<string, unknown>)) {
      if (key && value === true) collapsed.add(key);
    }
  }
  changed();
}

/** Hand the host every collapse in this document, for it to keep. */
function saveFolds(): void {
  foldsHost?.({
    type: 'commentFoldsWrite',
    folds: Object.fromEntries(Array.from(collapsed, (key) => [key, true])),
  });
}

function setCollapsed(key: string, on: boolean): void {
  if (on) collapsed.add(key);
  else collapsed.delete(key);
  saveFolds();
  changed();
}

// ---- The box ---------------------------------------------------------------

function icon(path: string, cls: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const d = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  d.setAttribute('d', path);
  svg.appendChild(d);
  return svg;
}

/**
 * Where in the file a press on the box landed, or null when it landed on the box
 * itself rather than on one of the lines it draws.
 *
 * The box draws each line of the comment as its own element, in order, so the
 * line pressed is the line of the file at the same offset from the comment's
 * first. Finding the character within it is `indexOf`: the drawn text is the
 * file's line with the `<!--` or `-->` around it left off, so where the drawn
 * text sits in the real line is exactly what the box took off the front.
 *
 * Without this the caret would go to the start of the comment wherever the press
 * landed, and a press on the second line followed by a keystroke would write
 * into the first.
 */
function pressedAt(view: EditorView, e: MouseEvent, from: number): number | null {
  const target = e.target as HTMLElement | null;
  const lineEl = target?.closest?.('.md-comment-line') ?? null;
  const body = lineEl?.parentElement;
  if (!lineEl || !body) return null;
  const index = [...body.children].indexOf(lineEl);
  const { doc } = view.state;
  const number = doc.lineAt(from).number + index;
  if (index < 0 || number > doc.lines) return null;
  const line = doc.line(number);
  const drawn = lineEl.textContent ?? '';
  const prefix = line.text.indexOf(drawn);
  if (prefix < 0) return line.to;
  return line.from + prefix + Math.min(pressedColumn(lineEl, e), drawn.length);
}

/** The character of a drawn line the press was over; its end where the browser cannot say. */
function pressedColumn(lineEl: Element, e: MouseEvent): number {
  // Spelled out rather than named: `Range` here is CodeMirror's, not the DOM's.
  const doc = lineEl.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => { startContainer: Node; startOffset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
  if (range && lineEl.contains(range.startContainer)) return range.startOffset;
  return (lineEl.textContent ?? '').length;
}

class CommentWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly lines: readonly string[],
    readonly shut: boolean,
    readonly from: number,
    readonly to: number
  ) {
    super();
  }

  eq(other: CommentWidget): boolean {
    return (
      other.key === this.key &&
      other.shut === this.shut &&
      other.from === this.from &&
      other.to === this.to &&
      other.lines.length === this.lines.length &&
      other.lines.every((l, i) => l === this.lines[i])
    );
  }

  get estimatedHeight(): number {
    if (this.shut) return EST.frame + EST.head;
    return EST.frame + EST.head + Math.max(1, this.lines.length) * EST.line;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = this.shut ? 'md-comment is-collapsed' : 'md-comment';

    const head = document.createElement('div');
    head.className = 'md-comment-head';

    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'md-comment-fold';
    fold.setAttribute('aria-expanded', this.shut ? 'false' : 'true');
    const what = this.shut ? 'Show this comment' : 'Collapse this comment';
    fold.setAttribute('aria-label', what);
    fold.title = what;
    fold.appendChild(icon(CHEVRON, 'md-comment-chevron'));
    // The press stops here as well as the click. The box around it opens the comment
    // for editing on a press, and a press that reached it would throw this button
    // away before its own click ever arrived: the chevron would reveal the comment
    // instead of shutting it.
    fold.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    fold.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCollapsed(this.key, !this.shut);
      // The box has just changed height; without this the lines under it are
      // drawn at the old one until something else forces a measure.
      view.requestMeasure();
    });
    head.appendChild(fold);

    const label = document.createElement('span');
    label.className = 'md-alert-label';
    label.appendChild(icon(ICON, 'md-alert-icon'));
    const name = document.createElement('span');
    name.className = 'md-alert-name';
    name.textContent = LABEL;
    label.appendChild(name);
    head.appendChild(label);

    if (this.shut) {
      const peek = document.createElement('span');
      peek.className = 'md-comment-peek';
      // The label plus the first line, and a sign that there is more behind it.
      peek.textContent = (this.lines[0] ?? '') + (this.lines.length > 1 ? ' …' : '');
      head.appendChild(peek);
    }
    box.appendChild(head);

    if (!this.shut) {
      const body = document.createElement('div');
      body.className = 'md-comment-body';
      for (const text of this.lines.length ? this.lines : ['']) {
        const line = document.createElement('div');
        line.className = 'md-comment-line';
        line.textContent = text;
        body.appendChild(line);
      }
      box.appendChild(body);
    }

    // A press anywhere else in the box is a person asking to write in the
    // comment, so it shows what is written, exactly as Edit Markdown does, with
    // the caret where the press landed rather than at the top of the comment.
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const at = pressedAt(view, e, this.from);
      revealRange(view, { from: this.from, to: this.to });
      if (at !== null) view.dispatch({ selection: EditorSelection.cursor(at) });
      view.focus();
    });

    return box;
  }

  ignoreEvent(): boolean {
    // The box answers its own presses above; CodeMirror has nothing to add.
    return true;
  }
}

/** The small stand-in drawn for a comment while `sheaf.comments` is `hidden`. */
class CommentMarkerWidget extends WidgetType {
  constructor(readonly key: string) {
    super();
  }

  eq(other: CommentMarkerWidget): boolean {
    return other.key === this.key;
  }

  get estimatedHeight(): number {
    return EST.marker;
  }

  toDOM(view: EditorView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'md-comment-marker-row';
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'md-comment-marker';
    marker.setAttribute('aria-label', 'Show this comment');
    marker.title = 'Show this comment';
    marker.appendChild(icon(ICON, 'md-alert-icon'));
    marker.addEventListener('mousedown', (e) => e.preventDefault());
    marker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealedWhileHidden.add(this.key);
      changed();
      view.requestMeasure();
    });
    row.appendChild(marker);
    return row;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---- The field -------------------------------------------------------------

function buildCommentDecorations(state: EditorState): DecorationSet {
  // In source mode the angle brackets are what the reader asked to see.
  if (sourceModeOn(state)) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLines(state);

  for (const comment of commentBlocks(state)) {
    const first = doc.lineAt(comment.from).number;
    const last = doc.lineAt(comment.to).number;
    let shown = false;
    for (let n = first; n <= last; n++) if (active.has(n)) shown = true;
    // The caret is in it, or a reveal covers it: it shows its own text instead.
    if (shown) continue;
    const hidden = mode === 'hidden' && !revealedWhileHidden.has(comment.key);
    const widget = hidden
      ? new CommentMarkerWidget(comment.key)
      : new CommentWidget(comment.key, comment.lines, collapsed.has(comment.key), comment.from, comment.to);
    decos.push(Decoration.replace({ widget, block: true }).range(comment.from, comment.to));
  }

  return Decoration.set(decos, true);
}

interface CommentDecorations {
  version: number;
  decorations: DecorationSet;
}

const commentField = StateField.define<CommentDecorations>({
  create: (state) => ({ version, decorations: buildCommentDecorations(state) }),
  update(value, tr) {
    // A long document is parsed in stages, so a comment further down can enter
    // the syntax tree in a transaction that changes nothing else.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setReveal)) ||
      value.version !== version ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return { version, decorations: buildCommentDecorations(tr.state) };
    }
    return { version: value.version, decorations: value.decorations.map(tr.changes) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // Cursor motion glides over a drawn box as one unit, as it does over every
    // other block widget.
    EditorView.atomicRanges.of((view) => view.state.field(f).decorations),
  ],
});

/**
 * How a change made outside a transaction — the setting, or the host's answer
 * about what is collapsed — reaches every editor on the page. The empty
 * transaction carries nothing; the field redraws because the version moved.
 */
const commentRedraw = ViewPlugin.define((view) => {
  const redraw = (): void => view.dispatch({});
  redrawers.add(redraw);
  return { destroy: () => redrawers.delete(redraw) };
});

/** Comments drawn as callout boxes, collapsed, or shrunk to a marker. */
export const comments: Extension = [commentField, commentRedraw];
