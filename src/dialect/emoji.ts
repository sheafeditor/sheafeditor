/*
 * `:warning:` and the rest of the emoji shortcodes: the parser rule that finds them.
 *
 * `@lezer/markdown` ships an `Emoji` extension of its own, and this replaces it for one reason: its
 * character class is `[a-zA-Z_0-9]`, which leaves out `:+1:` and `:-1:` — two of the most-typed
 * shortcodes on github.com — along with `:e-mail:`, `:t-rex:` and `:non-potable_water:`. Everything
 * else about the rule is the same, and the node keeps the name `Emoji` so the tree reads as before.
 *
 * The rule takes any `:name:` as a candidate rather than only the names in the table. That keeps
 * parsing a matter of shape, leaves the lookup to whatever draws the document, and means a name the
 * table does not hold stays exactly as it was typed, which is also what github.com does with it.
 *
 * **The table is deliberately not here.** What each name draws as lives in `../webview/emoji`,
 * because it is 47 KB of generated data and the grammar never reads it: the rule above matches on
 * shape alone. Keeping them in one module put that 47 KB into the dialect, and so into every
 * profile that parses Markdown at all, including a render path that draws no emoji and a one-line
 * field that has none in its feature list.
 */

import { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

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
