/*
 * `:warning:` and the rest of the emoji shortcodes: the parser rule that finds
 * them, and the table that says what each one draws as.
 *
 * `@lezer/markdown` ships an `Emoji` extension of its own, and this replaces it
 * for one reason: its character class is `[a-zA-Z_0-9]`, which leaves out `:+1:`
 * and `:-1:` — two of the most-typed shortcodes on github.com — along with
 * `:e-mail:`, `:t-rex:` and `:non-potable_water:`. Everything else about the rule
 * is the same, and the node keeps the name `Emoji` so the tree reads as before.
 *
 * The rule takes any `:name:` as a candidate rather than only the names in the
 * table. That keeps parsing a matter of shape, leaves the lookup to whatever
 * draws the document, and means a name the table does not hold stays exactly as
 * it was typed, which is also what github.com does with it.
 */

import { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';
import { EMOJI_PAIRS } from './emojiTable';

export const Emoji: MarkdownConfig = {
  defineNodes: [{ name: 'Emoji', style: tags.character }],
  parseInline: [
    {
      name: 'Emoji',
      parse(cx, next, pos) {
        if (next !== 58 /* ':' */) return -1;
        const match = /^[a-zA-Z0-9_+-]+:/.exec(cx.slice(pos + 1, cx.end));
        if (!match) return -1;
        return cx.addElement(cx.elt('Emoji', pos, pos + 1 + match[0].length));
      },
    },
  ],
};

let table: Map<string, string> | null = null;

/**
 * The character `:name:` stands for, or `undefined` for a name github.com does
 * not draw either.
 *
 * The table is built on the first call, not at module load, because a document
 * with no shortcode in it never needs one. `name` is the text between the
 * colons; a caller holding the whole `:name:` span should strip them first.
 */
export function emojiFor(name: string): string | undefined {
  if (!table) {
    table = new Map();
    for (const pair of EMOJI_PAIRS.split('\n')) {
      const space = pair.indexOf(' ');
      if (space > 0) table.set(pair.slice(0, space), pair.slice(space + 1));
    }
  }
  return table.get(name);
}
