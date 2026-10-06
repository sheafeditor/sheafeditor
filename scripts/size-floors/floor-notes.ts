// What a `notes` surface reads: CommonMark plus the constructs its own dialect adds, inside
// CodeMirror, and nothing that draws.
//
// **This replaces a floor that measured the wrong thing.** The first version was the dialect plus
// CodeMirror plus `livePreview`, written the day before `notes` had a construct list at all. The
// list exists now and excludes tables, emoji, maths, footnotes, images, Mermaid and the slash menu,
// several of which `livePreview` reaches, so that number described a surface nobody specified. It
// also came out byte-identical to `floor-field`, which is how the import cycle behind both was
// found, so it earned its keep before being wrong.
//
// **The grammar is configured here rather than taken from `markdownDialect.ts`, and that is
// deliberate.** That module exports the builder *and* `sheafMarkdownLanguage`, an instance built
// from the whole dialect at module scope, so importing the builder brings tables, emoji, maths and
// footnotes with it: measured, 228 bytes of emoji, 1380 of footnotes and 636 of maths survived in a
// floor that imported it, which came out 45 bytes *larger* than the full dialect rather than
// smaller. Configuring the parser directly is what `floor-parse-only` already does.
//
// **Two things it leaves out, both stated rather than implied.** `BracketsInLinkText` is a `const`
// inside `markdown.ts` and is not separately importable, so it is absent; it is one inline rule and
// a floor is a lower bound, so that is honest rather than convenient. And the drawing layer is
// absent because there is no module that draws lists, quotes and headings without also drawing
// images, maths and tables — decorations arrive together in `livePreview.ts`. So this is what
// `notes` costs to *read*, and a lower bound on what it will cost to *draw*.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { Language, defineLanguageFacet, syntaxTree } from '@codemirror/language';
import { Autolink, TaskList, parser } from '@lezer/markdown';
import { Highlight } from '../../src/webview/highlight';
import { Strikethrough } from '../../src/webview/strikethrough';

const notesParser = parser.configure([TaskList, Strikethrough, Autolink, Highlight]);
const notesLanguage = new Language(defineLanguageFacet({}), notesParser, [], 'markdown');

export const floor = { EditorState, EditorView, keymap, syntaxTree, lang: notesLanguage };
