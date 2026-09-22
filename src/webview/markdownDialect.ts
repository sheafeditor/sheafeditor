/*
 * The one Markdown dialect Sheaf reads, defined in one place.
 *
 * It lives in its own module because both the editor and the block model need
 * it, and the block model is imported by the editor's own extensions: a parser
 * built in either of those files would be a cycle for the other to import.
 */

import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { Autolink, Emoji, InlineContext, MarkdownConfig, MarkdownExtension, Table, TaskList } from '@lezer/markdown';
import { Highlight } from './highlight';
import { Maths } from './maths';
import { Strikethrough } from './strikethrough';

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
 * The Markdown dialect Sheaf reads: CommonMark, GFM, emoji shortcodes, `$…$`
 * maths, and Sheaf's own `==highlight==` and strikethrough.
 *
 * It is assembled from CommonMark rather than taken from `markdownLanguage`,
 * which throws in Pandoc's `~subscript~` and `^superscript^` as well. Those two
 * disagree with github.com, the renderer Sheaf is judged against: there `2^10^`
 * is a literal pair of carets, and `~text~` is strikethrough. GFM's own
 * strikethrough reads two tildes and not one, so Sheaf's replaces it and reads
 * both. Everything else here is GFM as `@lezer/markdown` ships it.
 */
export const markdownDialect: MarkdownExtension = [Table, TaskList, Strikethrough, Autolink, Emoji, Highlight, Maths, BracketsInLinkText];

/**
 * That dialect as a language, for the places that need a parser or a small
 * detached editor rather than the whole editing surface. Fenced code is left
 * unparsed here; a caller that wants highlighted code blocks passes its own
 * `codeLanguages` to `markdown()` with this as the base.
 */
export const sheafMarkdownLanguage = markdown({ base: commonmarkLanguage, extensions: markdownDialect, addKeymap: false }).language;
