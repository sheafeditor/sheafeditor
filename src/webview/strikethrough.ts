/*
 * `~~struck~~` and `~struck~` text, as a Lezer Markdown extension.
 *
 * GitHub reads a run of one tilde or two as strikethrough, so both are drawn
 * struck through here. The bundled GFM extension reads only two, which is why
 * this replaces it rather than sitting beside it. Three or more tildes in a row
 * are text, and a run is closed only by a run of the same length, so `~~a~`
 * stays as typed. Delimiters follow GFM's flanking rules, which is what keeps a
 * lone tilde in `~/notes` from opening anything: the tilde that would close it
 * has a space in front of it and so cannot close.
 *
 * Sheaf still writes `~~text~~`. This is about what Sheaf reads.
 */

import { DelimiterType, MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

const Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

/*
 * One delimiter type per run length. Lezer pairs delimiters by the identity of
 * their type object, so two separate objects are what stop a one-tilde opener
 * from resolving against a two-tilde closer.
 */
const SingleDelim: DelimiterType = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
const DoubleDelim: DelimiterType = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };

export const Strikethrough: MarkdownConfig = {
  defineNodes: [
    { name: 'Strikethrough', style: { 'Strikethrough/...': tags.strikethrough } },
    { name: 'StrikethroughMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Strikethrough',
      parse(cx, next, pos) {
        if (next !== 126 /* '~' */) return -1;
        // Only the first tilde of a run decides; the rest fall through as text.
        if (cx.slice(pos - 1, pos) === '~') return -1;
        let end = pos + 1;
        while (cx.char(end) === 126) end++;
        if (end - pos > 2) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(end, end + 1);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          end - pos === 1 ? SingleDelim : DoubleDelim,
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
