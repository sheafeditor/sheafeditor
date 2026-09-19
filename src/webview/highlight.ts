/*
 * `==highlighted==` text, as a Lezer Markdown extension.
 *
 * The spelling is the one Obsidian and several other Markdown tools read as a
 * highlight. GitHub and CommonMark do not, and show the equals signs as typed, so
 * the text stays readable everywhere. Delimiters follow the same flanking rules
 * as GFM strikethrough: `==` must touch the text it wraps.
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
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter)
        );
      },
      after: 'Emphasis',
    },
  ],
};
