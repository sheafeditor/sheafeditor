/*
 * Highlighting inside a fenced block, as a dialect extension a surface asks for.
 *
 * It lived in `markdownDialect.ts`, where the builder installed it on every caller:
 *
 *     exts.push(parseCode({ codeParser: codeLanguages ? codeParserFor(codeLanguages) : undefined }));
 *
 * With no `codeLanguages` that is mixed-language parsing with no parser to delegate to, and because
 * `parseCode` is a static import, making the push conditional would not have shaken it out — the
 * module is in the closure the moment the file is. Measured by adding one import at a time to a
 * `notes`-shaped entry: `parseCode` is 7,400 bytes raw and 2,517 gzipped on its own, where every
 * other import in that file is under 1 KB.
 *
 * So a surface that draws no code blocks never names this module, and one that does passes
 * `fencedCode(...)` among its extensions. Same cure as four other modules that bundled a capability
 * with the thing a consumer wanted: the capability gets its own file, below everybody who asks.
 *
 * `codeParserFor` lives here rather than beside the builder for the same reason. It is 400 bytes of
 * info-string handling that only a surface with code blocks has any use for.
 */

import { LanguageDescription, ParseContext } from '@codemirror/language';
import { MarkdownExtension, parseCode } from '@lezer/markdown';

/**
 * The grammars a fenced block's info string may ask for: a lookup by name, or a list to match
 * against.
 */
export type CodeLanguages = ((info: string) => LanguageDescription | null) | readonly LanguageDescription[];

/**
 * The grammar a fenced block's info string asks for, as `parseCode` wants it.
 *
 * A grammar that is already loaded is handed over; one that is not is loaded while the block stays
 * unparsed, which is what `getSkippingParser` is for and is why over a hundred grammars can sit
 * behind dynamic imports.
 */
const codeParserFor = (languages: CodeLanguages) => (info: string) => {
  // Whatever follows the first word is the block's own business: ```js twoslash is JavaScript.
  const name = /\S*/.exec(info)?.[0] ?? '';
  if (!name) return null;
  const found = typeof languages === 'function' ? languages(name) : LanguageDescription.matchLanguageName(languages, name, true);
  if (!found) return null;
  return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
};

/** Parse the contents of a fenced block with the grammar its info string names. */
export function fencedCode(languages: CodeLanguages): MarkdownExtension {
  return parseCode({ codeParser: codeParserFor(languages) });
}
