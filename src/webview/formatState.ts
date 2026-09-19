/*
 * The formatting in effect at a position: which inline marks enclose it and what
 * kind of block its line is. The toolbar, the selection toolbar and the menus read
 * this to show which formatting is on.
 */

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export interface FormatState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  highlight: boolean;
  link: boolean;
  /** Heading level 1 to 6, or 0 for a line that is not a heading. */
  heading: number;
  list: 'bullet' | 'ordered' | 'task' | null;
  quote: boolean;
  codeBlock: boolean;
}

const INLINE: Record<string, keyof FormatState> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Highlight: 'highlight',
  Link: 'link',
};

/**
 * The formatting at `pos`, which defaults to the main selection. For a non-empty
 * selection the state is read just inside its start, so a selection that begins
 * at a mark's opening delimiter still counts as inside the mark.
 */
export function formatStateAt(state: EditorState, pos?: number): FormatState {
  const sel = state.selection.main;
  const at = pos ?? (sel.empty ? sel.head : Math.min(sel.from + 1, sel.to));
  const out: FormatState = {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    highlight: false,
    link: false,
    heading: 0,
    list: null,
    quote: false,
    codeBlock: false,
  };
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(at, side); node; node = node.parent) {
      const key = INLINE[node.name];
      // A caret touching a mark from outside is not inside it.
      if (key && node.from < at && at < node.to) (out[key] as boolean) = true;
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') out.codeBlock = true;
      if (node.name === 'Blockquote') out.quote = true;
    }
  }
  const line = state.doc.lineAt(at);
  if (!out.codeBlock) {
    // Read from the tree, so a heading underlined with === or --- counts on either of its lines, and one inside a quote counts too.
    tree.iterate({
      from: line.from,
      to: line.to,
      enter: (node) => {
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
        if (heading && node.from <= line.to && node.to >= line.from) out.heading = Number(heading[1]);
      },
    });
  }
  const body = line.text.replace(/^\s*(>\s?)*/, '');
  if (!out.codeBlock) {
    if (/^[-*+]\s+\[[ xX]\]\s/.test(body)) out.list = 'task';
    else if (/^[-*+]\s/.test(body)) out.list = 'bullet';
    else if (/^\d+[.)]\s/.test(body)) out.list = 'ordered';
  }
  return out;
}
