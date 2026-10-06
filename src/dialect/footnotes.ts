/*
 * Footnotes as a grammar: `[^label]` in the text and `[^label]: text` at the start of a block,
 * in the syntax github.com reads.
 *
 *   The beacon runs at 1420 MHz[^band] and has since 2229.
 *
 *   [^band]: The hydrogen line, chosen because every receiver already looks there.
 *
 * **This half knows nothing about drawing**, which is the whole reason it is its own file. A module
 * that exports a `MarkdownConfig` may not import from `@codemirror/view`: the dialect is what Sheaf
 * reads, and a consumer that wants to parse Markdown should not be made to download an editor to do
 * it. Until 2026-10-04 this config sat beside the decorations that draw it, so importing the dialect
 * imported CodeMirror's view layer, 91 KB gzipped. `@lezer/highlight` tags are fine and are here:
 * they say what a node *is*, not how it is painted. How a footnote is drawn is
 * `src/webview/footnotes.ts`.
 *
 * ## What is a footnote
 *
 *   - A label is one or more characters with no whitespace and no bracket, so
 *     `[^ spaced]` and `[^]` are text. Labels match whatever their case.
 *   - A reference whose label has no definition anywhere in the document stays
 *     as written, as it does on GitHub. The parser cannot see whether a label is
 *     defined, so it is still a node and the drawing half decides.
 *   - The first definition of a label is the one that counts.
 *   - A definition is a block. Lines indented four spaces under it belong to it,
 *     blank lines between them included, and a line that simply carries on its
 *     paragraph does too.
 *   - Code is parsed before this is, so `[^x]` in inline code or a fenced block
 *     is never a footnote.
 */

import { MarkdownConfig, Line } from '@lezer/markdown';
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
