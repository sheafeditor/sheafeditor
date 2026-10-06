/*
 * Sheaf's whole dialect, as a CodeMirror language.
 *
 * One value, in its own module, because it is an **instance** and `markdownDialect.ts` is a
 * **builder**. Built at module scope from the full dialect, it references every construct the
 * grammar has — tables, emoji, maths, footnotes — so while it sat in the builder's file the bundler
 * could not separate the two, and a surface importing `sheafMarkdown` to compose a *narrower*
 * dialect got all of them anyway.
 *
 * Measured, on a `notes`-shaped entry built through the builder: 228 bytes of `dialect/emoji.ts`,
 * 1380 of `dialect/footnotes.ts`, 636 of `dialect/maths.ts` and 447 of `dialect/markdown.ts` in its
 * eager closure, and 91 KB gzipped against the 87 KB of a `notes` floor that configured the parser
 * by hand. A subset that came out the same size as the whole.
 *
 * It is the fourth module found holding a general thing and a specific one built from it, and the
 * fourth to be split for the same reason: `@codemirror/lang-markdown` held `markdown()` beside a
 * static `lang-html` import, `emoji.ts` held a parse rule beside a 47 KB table, and
 * `src/dialect/markdown.ts` held the dialect beside the language built from it. Each time the
 * consumer that wanted the general half paid for the specific one.
 *
 * **So nothing is added to this file.** A second value here would be a second thing the first one's
 * importers cannot avoid, which is the whole fault, one file along.
 */

import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDialect } from '../dialect/markdown';
import { sheafMarkdown } from './markdownDialect';

/**
 * That dialect as a language, for the places that need a parser or a small
 * detached editor rather than the whole editing surface. Fenced code is left
 * unparsed here; a caller that wants highlighted code blocks passes its own
 * `codeLanguages` to `sheafMarkdown()` with this as the base.
 */
export const sheafMarkdownLanguage = sheafMarkdown({ base: commonmarkLanguage, extensions: markdownDialect }).language;
