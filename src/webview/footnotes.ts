/*
 * Footnotes, in the syntax github.com reads: a reference `[^label]` in the text
 * and a definition `[^label]: text` at the start of a block.
 *
 *   The beacon runs at 1420 MHz[^band] and has since 2229.
 *
 *   [^band]: The hydrogen line, chosen because every receiver already looks there.
 *
 * GitHub draws the reference as a small number and gathers the definitions into
 * a list at the foot of the page. An editor has no foot of the page, so the notes
 * are drawn where they are written: the reference as a superscript number, and
 * the definition with its `[^label]:` replaced by the same number, in a smaller,
 * muted style. Cmd-click (Ctrl-click) on either number goes to the other end.
 *
 * Nothing here writes to the document. The numbers are worked out on every redraw
 * from the order the references appear in, the way GitHub numbers them, and are
 * never stored.
 *
 * ## What is a footnote
 *
 *   - A label is one or more characters with no whitespace and no bracket, so
 *     `[^ spaced]` and `[^]` are text. Labels match whatever their case.
 *   - A reference whose label has no definition anywhere in the document stays
 *     as written, as it does on GitHub.
 *   - The first definition of a label is the one that counts.
 *   - A definition is a block. Lines indented four spaces under it belong to it,
 *     blank lines between them included, and a line that simply carries on its
 *     paragraph does too.
 *   - Code is parsed before this is, so `[^x]` in inline code or a fenced block
 *     is never a footnote.
 */

import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { MarkdownConfig, Line } from '@lezer/markdown';
import { Tree } from '@lezer/common';
import { tags } from '@lezer/highlight';

const OPEN = 91; // [
const CLOSE = 93; // ]
const CARET = 94; // ^
const COLON = 58; // :
const PAREN = 40; // (
const BACKSLASH = 92;

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

/**
 * Where the label that starts at `start` ends: the index of its closing `]`, or
 * -1 when what follows is not a label.
 */
function labelEnd(char: (i: number) => number, start: number, end: number): number {
  let i = start;
  for (; i < end; i++) {
    const c = char(i);
    if (c === CLOSE) break;
    if (c === OPEN || c === BACKSLASH || isSpace(c) || c < 0) return -1;
  }
  return i >= end || i === start ? -1 : i;
}

/** The column after `[^label]:` when `line` opens a definition, or -1. */
function definitionStart(line: Line): number {
  if (line.next !== OPEN || line.indent - line.baseIndent >= 4) return -1;
  const text = line.text;
  const start = line.pos;
  if (text.charCodeAt(start + 1) !== CARET) return -1;
  const close = labelEnd((i) => text.charCodeAt(i), start + 2, text.length);
  if (close < 0 || text.charCodeAt(close + 1) !== COLON) return -1;
  return close;
}

/**
 * `[^label]` and `[^label]: text` as a Lezer Markdown extension.
 *
 * A reference is a `FootnoteReference` holding its two `FootnoteMark`s and its
 * `FootnoteLabel`. A definition is a `FootnoteDefinition` block that opens with
 * the same three nodes and holds its note as ordinary blocks, the way a list
 * item holds its own. The parser cannot see whether a label is defined, so an
 * undefined reference is still a node; the decoration layer leaves it as text.
 */
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference' },
    {
      name: 'FootnoteDefinition',
      block: true,
      // A later line belongs to the definition when it is blank or indented four
      // columns past where the definition started, as a list item's lines do.
      composite(_cx, line) {
        if (line.next !== -1 && line.indent < line.baseIndent + 4) return false;
        line.moveBaseColumn(line.baseIndent + 4);
        return true;
      },
    },
    { name: 'FootnoteMark', style: tags.processingInstruction },
    { name: 'FootnoteLabel', style: tags.labelName },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      before: 'Blockquote',
      parse(cx, line) {
        const close = definitionStart(line);
        if (close < 0) return false;
        const from = cx.lineStart + line.pos;
        const end = cx.lineStart + close;
        cx.startComposite('FootnoteDefinition', line.pos);
        cx.addElement(cx.elt('FootnoteMark', from, from + 2));
        cx.addElement(cx.elt('FootnoteLabel', from + 2, end));
        cx.addElement(cx.elt('FootnoteMark', end, end + 2));
        line.moveBase(line.skipSpace(close + 2));
        return null;
      },
      // A definition ends the paragraph above it, so a note written straight
      // under the sentence it belongs to, or straight under another note, is
      // its own block rather than more of that paragraph.
      endLeaf(_cx, line) {
        return definitionStart(line) >= 0;
      },
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== CARET) return -1;
        const close = labelEnd((i) => cx.char(i), pos + 2, cx.end);
        if (close < 0) return -1;
        // `[^x](url)` is a link whose text happens to start with a caret.
        if (cx.char(close + 1) === PAREN) return -1;
        return cx.addElement(
          cx.elt('FootnoteReference', pos, close + 1, [
            cx.elt('FootnoteMark', pos, pos + 2),
            cx.elt('FootnoteLabel', pos + 2, close),
            cx.elt('FootnoteMark', close, close + 1),
          ])
        );
      },
    },
  ],
};

// ---- The document's footnotes ------------------------------------------------

/** A `[^label]` in the text whose label has a definition. */
export interface FootnoteRef {
  from: number;
  to: number;
  label: string;
}

/** The definition that counts for a label. */
export interface FootnoteDef {
  /** The start of `[^`. */
  from: number;
  /** The end of the whole definition, continuation lines included. */
  to: number;
  /** The end of `[^label]:`, the part a number stands in for. */
  markTo: number;
  /** Where the note's text starts, after the spaces that follow the colon. */
  textFrom: number;
  /** The note as one line of text, for a tooltip. */
  text: string;
}

export interface FootnoteIndex {
  /** Every reference that has a definition, in document order. */
  refs: FootnoteRef[];
  /** The first definition of each label. */
  defs: Map<string, FootnoteDef>;
  /** Each referenced label's number, counted in order of first reference. */
  numbers: Map<string, number>;
}

/** Labels match whatever their case, as they do on GitHub. */
export const footnoteKey = (label: string): string => label.toLowerCase();

const indexCache = new WeakMap<Tree, FootnoteIndex>();

/** The document's footnotes: which references resolve, and their numbers. */
export function footnoteIndex(state: EditorState): FootnoteIndex {
  const tree = syntaxTree(state);
  const cached = indexCache.get(tree);
  if (cached) return cached;
  const doc = state.doc;
  const found: FootnoteRef[] = [];
  const defs = new Map<string, FootnoteDef>();
  tree.iterate({
    enter: (node) => {
      const labelNode = node.name === 'FootnoteReference' || node.name === 'FootnoteDefinition' ? node.node.getChild('FootnoteLabel') : null;
      if (!labelNode) return;
      const label = footnoteKey(doc.sliceString(labelNode.from, labelNode.to));
      if (node.name === 'FootnoteReference') {
        found.push({ from: node.from, to: node.to, label });
        return;
      }
      if (!defs.has(label)) {
        const markTo = labelNode.to + 2;
        const first = doc.lineAt(markTo);
        let textFrom = markTo;
        while (textFrom < first.to && /[ \t]/.test(doc.sliceString(textFrom, textFrom + 1))) textFrom++;
        const text = doc.sliceString(textFrom, node.to).replace(/\s+/g, ' ').trim();
        defs.set(label, { from: node.from, to: node.to, markTo, textFrom, text });
      }
      // A definition's own note can hold references, so its children are walked.
    },
  });
  const refs = found.filter((r) => defs.has(r.label));
  const numbers = new Map<string, number>();
  for (const r of refs) if (!numbers.has(r.label)) numbers.set(r.label, numbers.size + 1);
  const index = { refs, defs, numbers };
  indexCache.set(tree, index);
  return index;
}

// ---- Drawing -----------------------------------------------------------------

class FootnoteNumberWidget extends WidgetType {
  constructor(
    readonly n: number,
    readonly role: 'ref' | 'def',
    readonly tip: string
  ) {
    super();
  }
  eq(other: FootnoteNumberWidget): boolean {
    return other.n === this.n && other.role === this.role && other.tip === this.tip;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement('sup');
    sup.className = this.role === 'ref' ? 'md-footnote-ref' : 'md-footnote-num';
    sup.textContent = String(this.n);
    sup.dataset.footnote = this.role;
    sup.title = this.tip;
    sup.setAttribute('aria-label', this.role === 'ref' ? `Footnote ${this.n}` : `Note ${this.n}`);
    return sup;
  }
  ignoreEvent(): boolean {
    // The editor takes the press: a plain click places the caret, and a
    // Cmd-click is followed by the handler below.
    return false;
  }
}

/** The superscript number drawn in place of a reference, carrying the note as its tooltip. */
export function footnoteRefDecoration(n: number, note: string): Decoration {
  return Decoration.replace({ widget: new FootnoteNumberWidget(n, 'ref', note) });
}

/** The number drawn in place of a definition's `[^label]:`. */
export function footnoteDefDecoration(n: number): Decoration {
  return Decoration.replace({
    widget: new FootnoteNumberWidget(n, 'def', 'Cmd-click to go back to the text (Ctrl-click on Windows and Linux)'),
  });
}

/** The line style for every line of a definition. */
export const footnoteDefLine = Decoration.line({ class: 'md-footnote-def' });

// ---- Following a footnote ----------------------------------------------------

/**
 * Where a Cmd-click at `pos` goes: from a reference to the start of its note,
 * from a definition's number back to the first reference. Null when `pos` is on
 * neither, or on a footnote that has nowhere to go.
 */
export function footnoteJump(state: EditorState, pos: number): number | null {
  const index = footnoteIndex(state);
  for (const ref of index.refs) {
    if (pos >= ref.from && pos < ref.to) return index.defs.get(ref.label)!.textFrom;
  }
  for (const [label, def] of index.defs) {
    if (pos < def.from || pos >= def.markTo) continue;
    const first = index.refs.find((r) => r.label === label);
    return first ? first.to : null;
  }
  return null;
}

/** Move the caret to the other end of the footnote at `pos`, and bring it into view. */
export function followFootnote(view: EditorView, pos: number): boolean {
  const target = footnoteJump(view.state, pos);
  if (target === null) return false;
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: 'center' }),
    userEvent: 'select.footnote',
  });
  view.focus();
  return true;
}

/**
 * Cmd-click (Ctrl-click) follows a footnote, the way it opens a link. On a drawn
 * number the position is the widget's own; on a reference showing its source it
 * is wherever the press landed.
 */
export const footnoteClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    // A press can land on a text node, which has no `closest`.
    const pressed = event.target as { closest?: (selector: string) => Element | null } | null;
    const target = typeof pressed?.closest === 'function' ? pressed.closest('[data-footnote]') : null;
    let pos: number | null = null;
    if (target && view.contentDOM.contains(target)) pos = view.posAtDOM(target);
    else pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null || !followFootnote(view, pos)) return false;
    event.preventDefault();
    return true;
  },
});
