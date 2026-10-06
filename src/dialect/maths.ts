/*
 * `$…$` inline maths as a grammar, and nothing about drawing it.
 *
 * **This half knows nothing about KaTeX**, which is the point of it being its own file. A module
 * that exports a `MarkdownConfig` may not import from `@codemirror/view`: the dialect is what Sheaf
 * reads, and a consumer that only wants to parse Markdown should not download an editor, let alone a
 * typesetter, to do it. Until 2026-10-04 this config sat beside the decorations and the lazy KaTeX
 * loader, so importing the dialect imported CodeMirror's view layer. `@lezer/highlight` tags belong
 * here, because they say what a node is rather than how it is painted.
 *
 * Typesetting, the loader and the error cache are `src/webview/maths.ts`.
 */

import { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

const DOLLAR = 36;
const BACKSLASH = 92;
const BACKTICK = 96;
const NEWLINE = 10;

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === NEWLINE || code === 13;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * `$…$` as a Lezer Markdown extension.
 *
 * The span is added as one element rather than as a pair of delimiters, so
 * nothing inside it is parsed as Markdown: `$a_i$` is a subscript and not the
 * start of emphasis, and `$a * b$` keeps its asterisk.
 *
 * `$$` is left alone here. Display maths is a block, and the block half of this
 * module reads it off the document rather than out of the tree.
 */
export const Maths: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: { 'InlineMath/...': tags.special(tags.content) } },
    { name: 'InlineMathMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        // `$$` opens display maths, which is a block, and `$$x$$` mid-sentence
        // is left as written rather than drawn as one.
        if (cx.char(pos + 1) === DOLLAR) return -1;
        if (pos > cx.offset && cx.char(pos - 1) === DOLLAR) return -1;
        const after = cx.char(pos + 1);
        if (after < 0 || isSpace(after)) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === BACKTICK) return -1;
          if (ch === BACKSLASH) {
            i++;
            continue;
          }
          if (ch !== DOLLAR) continue;
          if (isSpace(cx.char(i - 1))) continue;
          if (isDigit(cx.char(i + 1))) continue;
          return cx.addElement(
            cx.elt('InlineMath', pos, i + 1, [
              cx.elt('InlineMathMark', pos, pos + 1),
              cx.elt('InlineMathMark', i, i + 1),
            ])
          );
        }
        return -1;
      },
    },
  ],
};
