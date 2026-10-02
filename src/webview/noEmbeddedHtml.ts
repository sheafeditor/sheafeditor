/*
 * What `@codemirror/lang-markdown` gets instead of `@codemirror/lang-html`.
 *
 * **This module exists for the bundle rather than for the editor**, and it is wired in by the
 * `embedded HTML` plugin in `esbuild.mjs`, which resolves `@codemirror/lang-html` here when and only
 * when the importer is `@codemirror/lang-markdown`. Everywhere else, including the `html` entry in
 * `@codemirror/language-data` that a ```html fence loads, the real package is used and nothing about
 * it changes.
 *
 * ## Why
 *
 * Markdown can hold raw HTML, so `markdown()` offers an HTML parser for it and completion for `<`
 * tags. That import costs 139 KB of minified JavaScript before any document is drawn: `lang-html`
 * brings `lang-css` and `lang-javascript`, and each of those brings its Lezer grammar. Sheaf does not
 * call `markdown()` at all any more (see `sheafMarkdown` in `markdownDialect.ts`), and the one caller
 * left in the bundle is `language-data`'s own Markdown entry, for a ```markdown fence inside a
 * document. Dropping the import there costs a nested fence its tag colours. Keeping it costs every
 * reader three languages they did not ask for.
 *
 * ## Why a redirect rather than deleting the call
 *
 * Measured, because three other explanations looked right first. `language-data` reaches
 * `lang-markdown` with `import('@codemirror/lang-markdown').then(m => m.markdown())`, and a dynamic
 * import of a namespace keeps **every** export of that module alive, `markdown` included. The editor
 * also needs `commonmarkLanguage` and Markdown's Enter and Backspace commands from the same module,
 * so it lands in the eager graph with `markdown` still in it, and `markdown` is what references the
 * HTML language. Taking the call out of `language-data` is not enough either: with `markdown` shaken
 * out, esbuild still keeps `import "@codemirror/lang-html"` for its side effects, because
 * `@lezer/html` does not declare itself side-effect-free and so the package it is imported by counts
 * as having side effects too. The redirect answers both at once, since this file has no side effects
 * at all and esbuild can see that.
 *
 * ## What it has to be
 *
 * `markdown()` reads two things off whatever `html()` returns, `support` and `language.parser`, and
 * hands the parser to `parseCode` for an HTML block. So this needs a real language, and the cheapest
 * honest one is a stream language that takes each line as one token: an HTML block parses to plain
 * text, which is what it drew before CodeMirror had an HTML grammar.
 */
import { LanguageSupport, StreamLanguage } from '@codemirror/language';

/**
 * A language that reads anything as plain text.
 *
 * Deliberately not `null` or a thrown error: `markdown()` builds its HTML support at module scope,
 * so anything that fails there fails at load, a long way from here.
 */
const plainText = StreamLanguage.define<unknown>({
  name: 'html (not parsed)',
  token(stream) {
    stream.skipToEnd();
    return null;
  },
});

/** `html()` as `lang-markdown` uses it: a language for an embedded block, with no completion. */
export function html(): LanguageSupport {
  return new LanguageSupport(plainText);
}

/** `htmlCompletionSource()` as `lang-markdown` uses it, for `<` tag completion Sheaf does not offer. */
export function htmlCompletionSource(): null {
  return null;
}
