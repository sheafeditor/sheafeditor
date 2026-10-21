/*
 * Where a document's `$$…$$` blocks are, which is the one rule in this file.
 *
 * **Beside the grammar, for the reason `maths.ts` beside it already gives**: a module that says what
 * a construct *is* may not import from `@codemirror/view`, because the dialect is what Sheaf reads
 * and a consumer that only wants to parse Markdown should not download an editor to do it. The
 * inline `$…$` form was split out of the editor on exactly that argument; this is the block form
 * arriving at the same place from the other side. Grammar below, drawing above.
 *
 * It is a leaf rather than part of `markdown.ts` because it is not a `MarkdownConfig`: a `$$` block
 * is not a node (see below), so there is no parser extension to add. Nothing in `markdown.ts`
 * imports it, so the dialect's own closure is unchanged.
 *
 * Two layers ask it and neither may load the other. The drawing layer asks so it can replace the
 * block with a typeset equation; the render path asks so it can refuse one, since a profile that
 * does not carry display maths has to say so rather than emit the delimiters as running text.
 * Typesetting, the loader and the error cache stay in `src/webview/maths.ts`.
 *
 * **A copy of it in each would drift, and the direction it would drift in is the expensive one.** A
 * surface that shows a rendered equation before it is focused and raw `$$` after it, or the reverse,
 * is the most visible way a library of this kind loses trust, and it is exactly what two answers to
 * "is this a block" produces. One definition, two callers, and a suite that runs the same cases
 * through both.
 *
 * **Why a line reader rather than a string.** The drawing layer calls this on every redraw with a
 * CodeMirror `Text` already in hand, and `doc.toString()` there would copy the whole document each
 * time. The render path has a string and builds the reader over it with `linesOf` below. The
 * interface is the subset of `Text` the rule uses, so `Text` satisfies it as it stands.
 *
 * **A `$$` block is not a parser node**, which is why the tree is a parameter rather than the whole
 * subject: the rule reads lines and asks the tree only whether the line sits in a top-level
 * paragraph. The specification states the `$$` rules beside the `$…$` ones as though both were parse
 * rules, and only the inline one is.
 */
import type { SyntaxNode, Tree } from '@lezer/common';

/** A `$$…$$` block: the whole of the lines it occupies, and the TeX inside it. */
export interface BlockMathRange {
  /** The start of the opening line. */
  from: number;
  /** The end of the closing line. */
  to: number;
  /** The TeX between the delimiters. */
  source: string;
}

/**
 * The lines of a document, which is all this rule reads of it.
 *
 * A CodeMirror `Text` satisfies this without an adapter, and `linesOf` builds one over a string.
 */
export interface LineReader {
  readonly lines: number;
  /** The line numbered `n`, counting from 1. */
  line(n: number): { from: number; to: number; text: string };
  /** The line holding `pos`. */
  lineAt(pos: number): { number: number };
  sliceString(from: number, to: number): string;
}

/**
 * A reader over a plain string, for a caller that has one rather than a document.
 *
 * Split on `\n` alone, and a `\r` before one stays in the line's text. Every test the rule makes on
 * a line's text goes through `trim`, so the carriage return changes no decision; leaving it in keeps
 * a position in a line equal to a position in the string, which is what the caller's other offsets
 * are measured in.
 */
export function linesOf(text: string): LineReader {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return {
    lines: starts.length,
    line: (n) => {
      const from = starts[n - 1];
      const end = n < starts.length ? starts[n] - 1 : text.length;
      return { from, to: end, text: text.slice(from, end) };
    },
    lineAt: (pos) => {
      let n = 1;
      while (n < starts.length && starts[n] <= pos) n++;
      return { number: n };
    },
    sliceString: (from, to) => text.slice(from, to),
  };
}

/**
 * The top-level paragraph containing `pos`, or null when what is there is any other kind of block: a
 * fence, a quote, a list, a table, or a paragraph nested inside one of those.
 */
function topLevelParagraph(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.parent && node.parent.name !== 'Document') node = node.parent;
  if (!node || !node.parent) return null;
  return node.name === 'Paragraph' ? node : null;
}

/** Every `$$…$$` block in the document, in order. */
export function blockMathsIn(doc: LineReader, tree: Tree): BlockMathRange[] {
  const found: BlockMathRange[] = [];

  for (let n = 1; n <= doc.lines; n++) {
    const open = doc.line(n);
    // Every line of the document passes through here on every redraw, so the
    // cheap test that allocates nothing comes before the ones that do.
    if (!open.text.includes('$$')) continue;
    const indent = open.text.length - open.text.trimStart().length;
    // Four spaces in is an indented code block, and its own delimiters are text.
    if (indent >= 4) continue;
    const trimmed = open.text.trim();
    if (!trimmed.startsWith('$$')) continue;
    const paragraph = topLevelParagraph(tree, open.from + indent);
    if (!paragraph) continue;

    // `$$E = mc^2$$`, written on one line.
    if (trimmed.length >= 4 && trimmed.endsWith('$$')) {
      const source = trimmed.slice(2, -2);
      if (source.trim() !== '') found.push({ from: open.from, to: open.to, source });
      continue;
    }

    // Otherwise the closer is a later line of the same paragraph that is `$$`
    // and nothing else. An empty pair is someone who has just typed the
    // delimiters, so it is left showing them rather than drawn as a blank.
    const last = doc.lineAt(paragraph.to).number;
    let close = 0;
    for (let m = n + 1; m <= last; m++) {
      if (doc.line(m).text.trim() === '$$') {
        close = m;
        break;
      }
    }
    if (!close) continue;
    const closeLine = doc.line(close);
    const source = doc.sliceString(open.from + indent + 2, closeLine.from);
    if (source.trim() !== '') found.push({ from: open.from, to: closeLine.to, source });
    n = close;
  }

  return found;
}
