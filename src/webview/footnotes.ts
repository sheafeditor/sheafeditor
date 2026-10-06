/*
 * How a footnote is drawn, and what following one does.
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
 * The grammar that produces the nodes this draws is `src/dialect/footnotes.ts`, which holds no
 * CodeMirror import so that the dialect can be parsed without an editor.
 */

import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Tree } from '@lezer/common';


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

