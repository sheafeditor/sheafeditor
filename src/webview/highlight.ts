/*
 * `==highlighted==` text, as a Lezer Markdown extension.
 *
 * The spelling is the one Obsidian and several other Markdown tools read as a
 * highlight. GitHub and CommonMark do not, and show the equals signs as typed, so
 * the text stays readable everywhere.
 *
 * Delimiters follow the same flanking rules as GFM strikethrough, `==` must touch the text it wraps,
 * **and the same run-length rule: three or more equals in a row are text.** That sentence used to
 * claim only the flanking half, while the run rule differed, so `===x===` highlighted where
 * `~~~x~~~` does not. One spelling behaving unlike the other is a rule a reader has to learn rather
 * than work out.
 */

import { DelimiterType, MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };
const Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */) return -1;
        // Only the first equals of a run decides; the rest fall through as text.
        if (cx.slice(pos - 1, pos) === '=') return -1;
        /*
         * Measure the whole run rather than peeking one character past the pair.
         *
         * The old test was `cx.char(pos + 2) === 61`, which refused a run of three only at the run's
         * *first* character: for `===x===` it stopped the `=` at index 0, and the `=` at index 1 then
         * opened a delimiter because the character after *its* pair was `x`, giving a Highlight over
         * `==x===` with a stray equals either side. Measuring is also why this is strikethrough's form
         * and not the one in `maths.ts`: a peek works there because that delimiter is one character,
         * and here it would pass `===x===` while still failing on four.
         */
        let end = pos;
        while (cx.char(end) === 61) end++;
        if (end - pos !== 2) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(end, end + 1);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          end,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter)
        );
      },
      after: 'Emphasis',
    },
  ],
};
