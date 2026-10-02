/*
 * The one Markdown dialect Sheaf reads, defined in one place.
 *
 * It lives in its own module because both the editor and the block model need
 * it, and the block model is imported by the editor's own extensions: a parser
 * built in either of those files would be a cycle for the other to import.
 */

import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { Language, LanguageDescription, LanguageSupport, ParseContext } from '@codemirror/language';
import { Autolink, InlineContext, MarkdownConfig, MarkdownExtension, MarkdownParser, Table, TaskList, parseCode } from '@lezer/markdown';
import { Emoji } from './emoji';
import { Footnotes } from './footnotes';
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

/** What `sheafMarkdown` takes, which is the three things Sheaf asks of a Markdown language. */
export interface SheafMarkdownConfig {
  /** The language to build on, for its parser and its language data. CommonMark by default. */
  base?: Language;
  /**
   * The grammar for a fenced block: a lookup by the block's info string, or a list to match the
   * info string against by name. Code is left unparsed when absent.
   */
  codeLanguages?: ((info: string) => LanguageDescription | null) | readonly LanguageDescription[];
  /** Dialect extensions, usually `markdownDialect`. */
  extensions?: MarkdownExtension;
}

/**
 * The grammar a fenced block's info string asks for, as `parseCode` wants it.
 *
 * A grammar that is already loaded is handed over; one that is not is loaded while the block stays
 * unparsed, which is what `getSkippingParser` is for and is why over a hundred grammars can sit
 * behind dynamic imports.
 */
const codeParserFor =
  (languages: NonNullable<SheafMarkdownConfig['codeLanguages']>) =>
  (info: string) => {
    // Whatever follows the first word is the block's own business: ```js twoslash is JavaScript.
    const name = /\S*/.exec(info)?.[0] ?? '';
    if (!name) return null;
    const found = typeof languages === 'function' ? languages(name) : LanguageDescription.matchLanguageName(languages, name, true);
    if (!found) return null;
    return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
  };

/**
 * Sheaf's Markdown language, assembled here rather than taken from `markdown()`.
 *
 * **It exists for one reason: `@codemirror/lang-markdown` holds a static import of
 * `@codemirror/lang-html`.** Markdown can embed raw HTML, so `markdown()` defaults to an HTML parser
 * for it and offers completion for `<` tags, and `lang-html` imports `lang-css` and
 * `lang-javascript`, each of which pulls its Lezer grammar. That is 139 KB of minified JavaScript for
 * three languages nobody asked for, loaded before a document with no code in it is drawn, and it
 * cannot be shaken out while anything in the bundle calls `markdown()`: the default is a module-level
 * value the function closes over.
 *
 * What this gives up, measured on the syntax tree rather than guessed: an HTML block and an inline
 * tag keep their `HTMLBlock` and `HTMLTag` nodes and lose the HTML tree that used to be mounted
 * inside them, so a tag name and an attribute inside raw HTML are one colour instead of several.
 * Nothing else: Sheaf draws inline HTML with its own decorations, and `<` tag completion was never
 * wanted in a document.
 *
 * Also gone, and both were already switched off at every call site: Markdown's own Enter and
 * Backspace keymap, which `editorExtensions.ts` installs itself in the order it needs, and
 * `pasteURLAsLink`, which `linkPaste.ts` answers with rules that escape what they write.
 */
export function sheafMarkdown(config: SheafMarkdownConfig = {}): LanguageSupport {
  const { base = commonmarkLanguage, codeLanguages, extensions } = config;
  const parser = base.parser;
  if (!(parser instanceof MarkdownParser)) throw new RangeError('sheafMarkdown needs a Markdown parser to build on');
  const exts: MarkdownExtension[] = extensions ? [extensions] : [];
  exts.push(parseCode({ codeParser: codeLanguages ? codeParserFor(codeLanguages) : undefined }));
  // The base's own language data, so `commentTokens` and anything else it carries survive.
  return new LanguageSupport(new Language(base.data, parser.configure(exts), [], 'markdown'));
}

/**
 * That dialect as a language, for the places that need a parser or a small
 * detached editor rather than the whole editing surface. Fenced code is left
 * unparsed here; a caller that wants highlighted code blocks passes its own
 * `codeLanguages` to `sheafMarkdown()` with this as the base.
 */
export const sheafMarkdownLanguage = sheafMarkdown({ base: commonmarkLanguage, extensions: markdownDialect }).language;
