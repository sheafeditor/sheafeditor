/*
 * State shared by the floating selection toolbar and the link popover, and the
 * rules for when each may show. The rules read only editor state (the selection,
 * the syntax tree and the field below), so they hold without any layout.
 */

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { blockRangeAt, blockSelectionOf } from './blockModel';

export interface FloatingState {
  /** A mouse button is down in the text, so a selection may still be growing. */
  pointerDown: boolean;
  /** The editor shows raw Markdown (`.source-mode` on an ancestor). */
  sourceMode: boolean;
  /** Escape or a focus change closed the toolbar; it comes back when the selection changes or is made again. */
  toolbarDismissed: boolean;
  /** Escape or a focus change closed the link popover; it comes back when the selection changes. */
  popoverDismissed: boolean;
  /** Start of the rendered link the pointer rests on, if any. */
  hoverLink: number | null;
}

export const setPointerDown = StateEffect.define<boolean>();
export const setSourceMode = StateEffect.define<boolean>();
export const setDismissed = StateEffect.define<{ toolbar?: boolean; popover?: boolean }>();
export const setHoverLink = StateEffect.define<number | null>();

export const floatingField = StateField.define<FloatingState>({
  create: () => ({ pointerDown: false, sourceMode: false, toolbarDismissed: false, popoverDismissed: false, hoverLink: null }),
  update(value, tr) {
    let next = value;
    const patch = (change: Partial<FloatingState>): void => {
      next = { ...next, ...change };
    };
    if (tr.docChanged && next.hoverLink != null) patch({ hoverLink: tr.changes.mapPos(next.hoverLink, 1) });
    if (tr.selection && !tr.selection.eq(tr.startState.selection)) {
      patch({ toolbarDismissed: false, popoverDismissed: false, hoverLink: null });
    } else if (tr.selection && tr.isUserEvent('select')) {
      // Selecting again what is already selected (Cmd+A over text that is all
      // selected, a double-click on the selected word) is still a selection someone
      // made, so the toolbar comes back for it.
      patch({ toolbarDismissed: false });
    }
    for (const effect of tr.effects) {
      if (effect.is(setPointerDown)) patch({ pointerDown: effect.value });
      else if (effect.is(setSourceMode)) patch({ sourceMode: effect.value });
      else if (effect.is(setDismissed)) {
        const { toolbar, popover } = effect.value;
        if (toolbar !== undefined) patch({ toolbarDismissed: toolbar });
        if (popover !== undefined) patch(popover ? { popoverDismissed: true, hoverLink: null } : { popoverDismissed: false });
      } else if (effect.is(setHoverLink)) {
        patch(effect.value == null ? { hoverLink: null } : { hoverLink: effect.value, popoverDismissed: false });
      }
    }
    return next;
  },
});

type Node = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** The innermost node around `pos` (on either side of it) that `match` accepts. */
function enclosing(state: EditorState, pos: number, match: (node: Node) => boolean): Node | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: Node | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (match(node)) return node;
    }
  }
  return null;
}

/**
 * A pipe table, a ```csv / ```tsv block or a ```view block, each of which renders as a
 * grid. The language is the first word of the info string, so ```csv id=tasks counts.
 */
function isGrid(state: EditorState, node: Node): boolean {
  if (node.name === 'Table') return true;
  if (node.name !== 'FencedCode') return false;
  const m = /^\s*(?:`{3,}|~{3,})[ \t]*([^\n`]*)/.exec(state.sliceDoc(node.from, node.to));
  const lang = m ? m[1].trim().split(/[ \t]+/)[0].toLowerCase() : '';
  return lang === 'csv' || lang === 'tsv' || lang === 'view';
}

const isCode = (node: Node): boolean => node.name === 'FencedCode' || node.name === 'CodeBlock';

/**
 * Whether `pos` lies in the YAML front matter that opens the document. Front
 * matter is metadata, not prose, so no Markdown formatting may be written into it.
 */
export function inFrontMatter(state: EditorState, pos: number): boolean {
  // Front matter starts on line 1, so most documents answer without a block lookup.
  return state.doc.line(1).text.trimEnd() === '---' && blockRangeAt(state, pos)?.kind === 'frontmatter';
}

/**
 * Whether the main selection may carry the selection toolbar: it holds some text,
 * neither end lies in a table grid (whose widget has its own controls, and where
 * inline markers would break a row) or in front matter, it is not wholly inside
 * one code block, and the editor is not showing raw source.
 */
export function toolbarEligible(state: EditorState, sourceMode: boolean): boolean {
  const sel = state.selection.main;
  if (sel.empty || sourceMode) return false;
  // A block selection is for moving and converting whole blocks, not formatting text.
  if (blockSelectionOf(state)) return false;
  if (inFrontMatter(state, sel.from) || inFrontMatter(state, sel.to)) return false;
  if (state.sliceDoc(sel.from, sel.to).trim() === '') return false;
  if (enclosing(state, sel.from, (n) => isGrid(state, n)) || enclosing(state, sel.to, (n) => isGrid(state, n))) return false;
  const startCode = enclosing(state, sel.from, isCode);
  const endCode = enclosing(state, sel.to, isCode);
  return !(startCode && endCode && startCode.from === endCode.from);
}

/** The toolbar shows when its selection is eligible, the pointer is up and it was not dismissed. */
export function toolbarShown(state: EditorState): boolean {
  const f = state.field(floatingField, false);
  return !!f && !f.pointerDown && !f.toolbarDismissed && toolbarEligible(state, f.sourceMode);
}

/** An inline Markdown link, `[text](url "title")`, with the ranges an edit needs. */
export interface InlineLink {
  from: number;
  to: number;
  /** The link text, between `[` and `]`. */
  textFrom: number;
  textTo: number;
  /** The destination as written, angle brackets included; empty for `[text]()`. */
  urlFrom: number;
  urlTo: number;
  /** The destination without angle brackets. */
  url: string;
}

/**
 * The inline link around `pos`, or null. The position must be inside the link, not
 * touching its edge. Reference links (`[text][label]`) are not inline links, since
 * their address lives in a definition elsewhere in the document.
 */
export function inlineLinkAt(state: EditorState, pos: number): InlineLink | null {
  const node = enclosing(state, pos, (n) => n.name === 'Link' && n.from < pos && pos < n.to);
  if (!node) return null;
  const marks = node.getChildren('LinkMark');
  if (marks.length < 4 || state.sliceDoc(marks[2].from, marks[2].to) !== '(') return null;
  const dest = node.getChild('URL');
  const urlFrom = dest ? dest.from : marks[2].to;
  const urlTo = dest ? dest.to : marks[2].to;
  const raw = state.sliceDoc(urlFrom, urlTo);
  const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  return { from: node.from, to: node.to, textFrom: marks[0].to, textTo: marks[1].from, urlFrom, urlTo, url };
}

/**
 * The link the popover is for: the one under the pointer, else the one around a
 * bare caret. There is none while the pointer is down, after a dismissal, or
 * while the selection toolbar is showing.
 */
export function popoverLink(state: EditorState): InlineLink | null {
  const f = state.field(floatingField, false);
  if (!f || f.pointerDown || f.popoverDismissed || toolbarShown(state)) return null;
  if (f.hoverLink != null) {
    const hovered = inlineLinkAt(state, f.hoverLink + 1);
    if (hovered && hovered.from === f.hoverLink) return hovered;
  }
  const sel = state.selection.main;
  return sel.empty ? inlineLinkAt(state, sel.head) : null;
}
