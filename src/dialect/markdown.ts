/*
 * The one Markdown dialect Sheaf reads, defined in one place and with no editor in it.
 *
 * **Nothing here may import from `@codemirror/view`**, which is the rule every module under
 * `src/dialect/` is held to and is checked by `scripts/check-dialect-imports.mjs`. The dialect is
 * what Sheaf *reads*; a consumer that wants to parse Markdown, render a list of rows on a server, or
 * draw an unfocused field should not be made to download an editor to do it.
 *
 * It used to live beside the CodeMirror language built from it, and because that language is
 * constructed at module scope, anything importing the dialect got the view layer with it: 90 KB
 * gzipped for a grammar. `src/webview/markdownDialect.ts` is now the half that builds the language,
 * and it imports this.
 */

import { Autolink, InlineContext, MarkdownConfig, MarkdownExtension, Table, TaskList } from '@lezer/markdown';
import { Emoji } from './emoji';
import { Footnotes } from './footnotes';
import { Highlight } from '../webview/highlight';
import { Maths } from './maths';
import { Strikethrough } from '../webview/strikethrough';

/**
 * Brackets inside a link's text: `[link [with] brackets](https://example.com)`.
 *
 * CommonMark reads that as one link whose text is `link [with] brackets`, because
 * `[with]` is only a link if a `[with]:` definition exists, and a link may not hold
 * another. The parser cannot see definitions, so it takes any closed `[with]` as a
 * possible reference link and gives up on every `[` before it, which left the whole
 * thing as source with only its address picked out.
 *
 * This runs before the parser's own `]`. When the `]` closes a bare `[...]` (nothing
 * after it that would make it an inline or full reference link) while an earlier `[`
 * is still open, the inner pair is left as text and the outer bracket stays live. A
 * bare `[...]` that sits inside no other bracket is left to the parser as before,
 * since on its own it may well be a reference to a definition.
 */
const BracketsInLinkText: MarkdownConfig = {
  parseInline: [
    {
      name: 'BracketsInLinkText',
      before: 'LinkEnd',
      parse(cx, next, start) {
        if (next !== 93 /* ']' */ || /[(\[]/.test(cx.slice(start + 1, start + 2))) return -1;
        const inner = cx.findOpeningDelimiter(InlineContext.linkStart);
        if (inner === null) return -1;
        // An image's `![` nearer than the link's `[` is the image's business.
        const image = cx.findOpeningDelimiter(InlineContext.imageStart);
        if (image !== null && image > inner) return -1;
        let outer = false;
        for (let j = 0; j < inner && !outer; j++) outer = cx.getDelimiterAt(j)?.type === InlineContext.linkStart;
        if (!outer) return -1;
        // Take everything from the inner `[` on, which drops that unmatched bracket
        // to text, put the rest back, and read this `]` as text too.
        for (const element of cx.takeContent(inner)) cx.addElement(element);
        return start + 1;
      },
    },
  ],
};

/**
 * The Markdown dialect Sheaf reads: CommonMark, GFM with its footnotes, emoji
 * shortcodes, `$…$` maths, and Sheaf's own `==highlight==` and strikethrough.
 *
 * It is assembled from CommonMark rather than taken from `markdownLanguage`,
 * which throws in Pandoc's `~subscript~` and `^superscript^` as well. Those two
 * disagree with github.com, the renderer Sheaf is judged against: there `2^10^`
 * is a literal pair of carets, and `~text~` is strikethrough. GFM's own
 * strikethrough reads two tildes and not one, so Sheaf's replaces it and reads
 * both, and its emoji rule stops at `[a-zA-Z_0-9]`, which would leave `:+1:` out,
 * so Sheaf's replaces that one too. Everything else here is GFM as
 * `@lezer/markdown` ships it.
 */
export const markdownDialect: MarkdownExtension = [Table, TaskList, Strikethrough, Autolink, Emoji, Highlight, Maths, Footnotes, BracketsInLinkText];
