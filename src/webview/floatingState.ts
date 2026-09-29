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
  /**
   * Start of the link someone asked to edit, with Cmd+K or the Link button. The
   * popover shows for it whatever else would be showing, since the person pressed a
   * key to get at it; a bare caret or the pointer only *offers* the popover.
   */
  editLink: number | null;
  /**
   * A link someone asked for that is not written yet. The popover shows over the words
   * it will wrap, and the document is not touched until the address is entered, so a
   * person who changes their mind leaves no `[text](url)` behind.
   */
  newLink: PendingLink | null;
}

/** The words a link about to be written will wrap: one span per block, in document order. */
export interface PendingLink {
  spans: { from: number; to: number }[];
}

export const setPointerDown = StateEffect.define<boolean>();
export const setSourceMode = StateEffect.define<boolean>();
export const setDismissed = StateEffect.define<{ toolbar?: boolean; popover?: boolean }>();
export const setHoverLink = StateEffect.define<number | null>();
export const setEditLink = StateEffect.define<number | null>();
export const setNewLink = StateEffect.define<PendingLink | null>();

export const floatingField = StateField.define<FloatingState>({
  create: () => ({
    pointerDown: false,
    sourceMode: false,
    toolbarDismissed: false,
    popoverDismissed: false,
    hoverLink: null,
    editLink: null,
    newLink: null,
  }),
  update(value, tr) {
    let next = value;
    const patch = (change: Partial<FloatingState>): void => {
      next = { ...next, ...change };
    };
    if (tr.docChanged && next.hoverLink != null) patch({ hoverLink: tr.changes.mapPos(next.hoverLink, 1) });
    // The link's `[` keeps its place while its words and address are edited from the popover.
    if (tr.docChanged && next.editLink != null) patch({ editLink: tr.changes.mapPos(next.editLink, 1) });
    /*
     * The words a pending link will wrap follow an edit elsewhere in the file, the way the
     * address being typed already does. Each edge holds its side, so text typed against the
     * words is outside them: a link asked for over "release notes" is written around those
     * two words whatever else arrives while the address is being typed.
     */
    if (tr.docChanged && next.newLink) {
      patch({
        newLink: {
          spans: next.newLink.spans.map((s) => ({ from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) })),
        },
      });
    }
    if (tr.selection && !tr.selection.eq(tr.startState.selection)) {
      patch({ toolbarDismissed: false, popoverDismissed: false, hoverLink: null, editLink: null, newLink: null });
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
        // Escape closes a popover that was opened on purpose too, so both of those go with it.
        if (popover !== undefined) {
          patch(popover ? { popoverDismissed: true, hoverLink: null, editLink: null, newLink: null } : { popoverDismissed: false });
        }
      } else if (effect.is(setHoverLink)) {
        patch(effect.value == null ? { hoverLink: null } : { hoverLink: effect.value, popoverDismissed: false });
      } else if (effect.is(setEditLink)) {
        patch({ editLink: effect.value, popoverDismissed: false, hoverLink: null, newLink: null });
      } else if (effect.is(setNewLink)) {
        patch({ newLink: effect.value, popoverDismissed: false, hoverLink: null, editLink: null });
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

/** Whether the line `line` draws a divider, a `HorizontalRule` node, possibly inside a quote or a list item. */
function drawsRule(state: EditorState, line: { from: number; to: number }): boolean {
  let found = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (found) return false;
      if (node.name === 'HorizontalRule' && node.from >= line.from && node.to <= line.to) found = true;
      return undefined;
    },
  });
  return found;
}

/**
 * Whether the selection holds any text a formatting command could act on: a
 * character other than a space on a line that is not a divider. A divider's line
 * holds its dashes and at most the markers of the quote or list it sits in, and
 * none of those is text anyone reads, so bold, a link or Turn into has nothing
 * there to act on.
 */
function holdsProse(state: EditorState, from: number, to: number): boolean {
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    const text = state.sliceDoc(Math.max(from, line.from), Math.min(to, line.to));
    if (text.trim() !== '' && !drawsRule(state, line)) return true;
    pos = line.to + 1;
  }
  return false;
}

/**
 * Whether the main selection may carry the selection toolbar: it holds some text
 * (a divider's dashes are not text), neither end lies in a table grid (whose widget
 * has its own controls, and where inline markers would break a row) or in front
 * matter, it is not wholly inside one code block, and the editor is not showing raw
 * source.
 */
export function toolbarEligible(state: EditorState, sourceMode: boolean): boolean {
  const sel = state.selection.main;
  if (sel.empty || sourceMode) return false;
  // A block selection is for moving and converting whole blocks, not formatting text.
  if (blockSelectionOf(state)) return false;
  if (inFrontMatter(state, sel.from) || inFrontMatter(state, sel.to)) return false;
  if (!holdsProse(state, sel.from, sel.to)) return false;
  if (enclosing(state, sel.from, (n) => isGrid(state, n)) || enclosing(state, sel.to, (n) => isGrid(state, n))) return false;
  const startCode = enclosing(state, sel.from, isCode);
  const endCode = enclosing(state, sel.to, isCode);
  return !(startCode && endCode && startCode.from === endCode.from);
}

/**
 * The toolbar shows when its selection is eligible, the pointer is up and it was not
 * dismissed. A link opened for editing takes the space instead: the Link button is on
 * the toolbar, so leaving both up would put the popover over the button that opened it.
 */
export function toolbarShown(state: EditorState): boolean {
  const f = state.field(floatingField, false);
  if (!f || editedLink(state) || pendingLink(state)) return false;
  return !f.pointerDown && !f.toolbarDismissed && toolbarEligible(state, f.sourceMode);
}

/** The link `editLink` names, if it is still a link; null once an edit has ended it. */
export function editedLink(state: EditorState): InlineLink | null {
  const f = state.field(floatingField, false);
  if (!f || f.editLink == null) return null;
  const link = inlineLinkAt(state, f.editLink + 1);
  return link && link.from === f.editLink ? link : null;
}

/** The link that has been asked for and not written yet, if there is one. */
export function pendingLink(state: EditorState): PendingLink | null {
  return state.field(floatingField, false)?.newLink ?? null;
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
  return node ? linkFromNode(state, node) : null;
}

/** A `Link` node as the ranges an edit needs, or null when it is a reference rather than an inline link. */
function linkFromNode(state: EditorState, node: Node): InlineLink | null {
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
 * Every inline link that `from..to` reaches into, in document order. A link the range
 * only touches at an edge is not one of them, which is the rule `inlineLinkAt` uses
 * for a caret: a selection ending just before a link has not selected it.
 */
export function inlineLinksIn(state: EditorState, from: number, to: number): InlineLink[] {
  const found: InlineLink[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'Link' || node.from >= to || node.to <= from) return undefined;
      const link = linkFromNode(state, node.node);
      if (link) found.push(link);
      return undefined;
    },
  });
  return found;
}

/**
 * The link the popover is for: the one someone asked to edit, else the one under the
 * pointer, else the one around a bare caret. Only the last two are withheld while the
 * pointer is down, after a dismissal, or while the selection toolbar is showing.
 */
export function popoverLink(state: EditorState): InlineLink | null {
  const asked = editedLink(state);
  if (asked) return asked;
  const f = state.field(floatingField, false);
  if (!f || f.pointerDown || f.popoverDismissed || toolbarShown(state)) return null;
  if (f.hoverLink != null) {
    const hovered = inlineLinkAt(state, f.hoverLink + 1);
    if (hovered && hovered.from === f.hoverLink) return hovered;
  }
  const sel = state.selection.main;
  return sel.empty ? inlineLinkAt(state, sel.head) : null;
}
