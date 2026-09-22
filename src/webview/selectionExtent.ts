/*
 * How far a selection reaches, for everything that acts on the lines it covers.
 *
 * Selecting a whole line, by a triple-click or a drag to the end of it, takes in
 * the line break too, so the selection ends at the start of the next line. It
 * covers no character of that line, and nothing that works line by line should
 * treat it as touched: Copy ref names the lines before it, Reveal Syntax On Line
 * leaves it rendered, and the drawn highlight stops at the end of the text above.
 */

import { Text } from '@codemirror/state';

/**
 * The end of the text a selection covers. A non-empty selection that ends exactly
 * at the start of a line ends, for this purpose, at the end of the line before it,
 * never before its own start. Any other selection ends where it ends.
 */
export function coveredEnd(doc: Text, range: { from: number; to: number }): number {
  return range.to > range.from && range.to === doc.lineAt(range.to).from ? range.to - 1 : range.to;
}
