/*
 * The one Markdown dialect Sheaf reads, defined in one place.
 *
 * It lives in its own module because both the editor and the block model need
 * it, and the block model is imported by the editor's own extensions: a parser
 * built in either of those files would be a cycle for the other to import.
 */

import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { Language, LanguageSupport } from '@codemirror/language';
import { MarkdownExtension, MarkdownParser } from '@lezer/markdown';


/** What `sheafMarkdown` takes, which is the two things Sheaf asks of a Markdown language. */
export interface SheafMarkdownConfig {
  /** The language to build on, for its parser and its language data. CommonMark by default. */
  base?: Language;
  /**
   * Dialect extensions, usually `markdownDialect`.
   *
   * Highlighting inside a fenced block is one of these now, `fencedCode(...)` from
   * `fencedCode.ts`, rather than a `codeLanguages` option here. It used to be installed on every
   * caller whether they asked or not, and `parseCode` is a static import, so a surface that draws no
   * code blocks paid 2.5 KB gzipped for mixed-language parsing with no parser to delegate to.
   */
  extensions?: MarkdownExtension;
}

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
  const { base = commonmarkLanguage, extensions } = config;
  const parser = base.parser;
  if (!(parser instanceof MarkdownParser)) throw new RangeError('sheafMarkdown needs a Markdown parser to build on');
  const exts: MarkdownExtension[] = extensions ? [extensions] : [];
  // The base's own language data, so `commentTokens` and anything else it carries survive.
  return new LanguageSupport(new Language(base.data, parser.configure(exts), [], 'markdown'));
}

/*
 * Sheaf's own dialect as a language is **not** here, and that is the point of this file.
 *
 * It is `sheafMarkdownLanguage` in `markdownLanguage.ts`. Built at module scope it references every
 * construct the grammar has, so while it sat below this function anything importing the function to
 * compose a narrower dialect got all of them: a `notes`-shaped entry came out 91 KB against the
 * 87 KB of one that configured the parser by hand, a subset the size of the whole.
 *
 * So this file holds the builder and the shape of its config, and nothing built from either. A value
 * added here is a value this function's importers cannot avoid.
 */
