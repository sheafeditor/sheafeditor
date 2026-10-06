/*
 * Whether a line opens or closes a fenced block, which is a question about the document rather than
 * about the screen.
 *
 * It lived in `livePreview.ts`, and that one import is why the formatting toolbar and the grid both
 * downloaded the whole decoration layer. `shortcuts.ts` needs it — a command acting on "a code
 * block" has to tell a fence line from the code between them — and `shortcuts.ts` is read by the
 * toolbar, so `toolbar.ts -> shortcuts.ts -> livePreview.ts` put 16 KB of decorations and, behind
 * them, the image widget into everything that wanted to know what Mod-B is called.
 *
 * Measured: `toolbar.ts` carried 6123 bytes of the image drawing half for this reason, and the
 * reason had nothing to do with images.
 *
 * Same shape and same cure as `inlineOnly.ts`: one fact, in its own module, below everything that
 * asks for it. The drawing layer may depend on a syntax question; a syntax question may not depend
 * on the drawing layer.
 */

import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/**
 * What may sit between the start of a line and the backtick run that opens a fence.
 *
 * Only a quote or list marker; anything else means the backticks are part of the code. Exported
 * because `livePreview.ts` reads it too when it collects a block's fence lines, and a second copy
 * would be a second answer to "is this line a fence" that would stop agreeing with this one.
 */
export const ONLY_MARKERS_BEFORE = /^[\s>]*(?:[-*+]|\d+[.)])?\s*$/;

/**
 * Whether `pos` is on a line that opens or closes a fenced block.
 *
 * Needed outside the drawing, because a command acting on "a code block" has to tell the fence lines
 * from the code between them. `formatStateAt(...).codeBlock` is true on all three, which is right for
 * deciding whether the caret is in a block and wrong for deciding what to write: indenting a fence by
 * four spaces stops it being a fence, and the closing one then opens a new block that swallows the
 * rest of the document.
 */
export function isFenceLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  let found = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (found || node.name !== 'CodeMark') return;
      if (node.node.parent?.name !== 'FencedCode') return;
      if (state.doc.lineAt(node.from).number !== line.number) return;
      if (!ONLY_MARKERS_BEFORE.test(line.text.slice(0, node.from - line.from))) return;
      found = true;
    },
  });
  return found;
}
