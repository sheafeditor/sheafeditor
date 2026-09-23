# Contributing to Sheaf Editor

Thanks for taking a look. Sheaf is built and maintained by one person.

**Bug reports, questions and ideas are welcome as [issues](https://github.com/sheafeditor/sheafeditor/issues). Code contributions are not accepted, so please do not open pull requests.** The rest of this guide is for anyone building Sheaf from source or keeping a fork of their own.

## The one rule that is not negotiable

**Raw Markdown is the source of truth. Sheaf never reserializes your document.**

Rendering happens through view-only CodeMirror 6 decorations that hide syntax markers and draw widgets on top of the real text. The bytes on disk change only where the user actually typed.

This rules out the approach almost every other WYSIWYG Markdown editor takes — parse the file into a document model (ProseMirror, Milkdown, Tiptap), edit the model, serialize it back. That round-trip reflows lists, normalizes tables and rewrites emphasis characters, turning a one-word edit into a fifty-line diff. It is also, frankly, the easier way to build most features.

A change that introduces a parse-and-serialize round-trip breaks that rule, however convenient it is. If a feature seems to need one, there is another way to build it.

What this does *not* forbid is writing markup the user explicitly asked for. Resizing or captioning an image upgrades that one image to an inline HTML snippet, because Markdown cannot express it — a local edit to the range the user acted on. Untouched bytes elsewhere stay untouched. That is the actual rule.

## Getting set up

Requires Node 22+ and VS Code 1.90+.

```bash
git clone https://github.com/sheafeditor/sheafeditor.git
cd sheafeditor
npm install
npm run watch      # rebuilds the extension host and webview bundles on change
```

Then press <kbd>F5</kbd> in VS Code to launch the Extension Development Host. It opens [sample/welcome.md](sample/welcome.md) in Sheaf. The rest of the corpus lives alongside it — see [sample/README.md](sample/README.md) for the map. `sample/dialect/` is the fastest way to eyeball a change, and splits every construct into plain CommonMark, what GitHub adds and what Sheaf adds, so a difference against another renderer is easy to place; `sample/edge/` is where rendering bugs hide; `sample/stress/` holds the generated long documents and large tables you want before claiming something is fast.

The generated files are committed. Rebuild them with `npm run gen:corpus` after changing [scripts/gen-corpus.mjs](scripts/gen-corpus.mjs), and `npm run check-corpus` will tell you if what is committed has drifted from what the generator produces.

## Brand assets

The icons are generated, and committed. [scripts/build-icons.mjs](scripts/build-icons.mjs) holds the geometry and writes the extension's icons: the full mark and the small mark as SVG, and the icon PNG. The marketing site lives in its own repository; when its checkout sits beside this one as `sheaf-site`, or wherever `SHEAF_SITE_DIR` points, the script also writes the site's icon, touch icon and social card there, and skips them otherwise. Rebuild them with `npm run gen:icons`, and `npm run check-icons` will tell you if the committed SVGs have drifted. Rasterising needs Chrome, which the script finds for you or takes from `SHEAF_CHROME`, and the social card pulls its fonts from Google Fonts, so that step needs network.

The initial on the front sheet is an outline of the capital S of Young Serif, embedded as a path so that opening an SVG never depends on an installed font. If the display face changes, re-extract it with [scripts/extract-glyph.py](scripts/extract-glyph.py) and paste the result into the generator.

After editing webview code, reload the Extension Development Host window (<kbd>Cmd/Ctrl</kbd>+<kbd>R</kbd>) to pick up the rebuilt bundle.

## Checks

```bash
npm run check-types     # tsc --noEmit
npm test                # engine + table suites
npm run check-icons     # committed icons match the generator
npm run check-touch     # what a document looks like on a phone, in a real browser
npm run package         # builds a .vsix, catches bundling and .vscodeignore issues
```

`check-touch` needs Chromium and `playwright-core`, because the rules behind `(pointer: coarse)` cannot be seen any other way: jsdom has no layout and a desktop window cannot be told it is a phone. Without either it says so and passes.

CI runs the type-check, the tests and the package build on every push. Run at least the first two before pushing.

Tests are plain Node scripts under [test/](test/) driven by jsdom — no test framework. `test/engine.test.mjs` covers decoration building; `test/tables.test.mjs` covers table editing. Adding a case means adding an assertion to the relevant script, and the entry files (`*.entry.ts`) are bundled by esbuild so the tests can import webview modules directly.

## Project layout

| Path                            | What lives there                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/extension.ts`              | Activation, command registration                                                         |
| `src/markdownEditorProvider.ts` | The `CustomTextEditorProvider`: webview setup, two-way document sync, minimal-diff edits |
| `src/defaultEditor.ts`          | Maintains `workbench.editorAssociations` for the default-editor setting                  |
| `src/webview/livePreview.ts`    | The decoration engine — the heart of the renderer                                        |
| `src/webview/tables.ts`         | Interactive table editing                                                                |
| `src/webview/images.ts`         | Image rendering, resize/align/caption, paste ingestion                                   |
| `src/webview/toolbar.ts`        | Formatting toolbar; its commands are shared with shortcuts and the context menu          |
| `src/webview/shortcuts.ts`      | Keymap and cheat-sheet overlay                                                           |
| `src/webview/theme.ts`          | CodeMirror theme + Lezer highlight style                                                 |
| `media/webview.css`             | The rendered visual surface, themed via `--vscode-*` variables                           |

Two processes, one authoritative buffer: the extension host owns the `TextDocument`, the webview renders it and sends back minimal edits.

## Working on the renderer

The renderer is CodeMirror 6 decorations over the raw buffer, and it has a few constraints that are easy to rediscover painfully: block widgets must live in a `StateField` rather than a `ViewPlugin`, and `atomicRanges` only applies over replace and widget ranges. The module headers in `src/webview/*.ts` say what each file is responsible for; keep them true when you change one.

## Making changes

- One concern per change, with the user-visible behaviour it changes and how it was verified.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for user-visible changes, written for users rather than as a commit log.
- Match the surrounding code: TypeScript, no linter enforced, but follow the file's existing comment density and naming. The module-header comments in `src/webview/*.ts` explain what each file is responsible for — keep them true.
- User-facing strings (command titles, setting descriptions, errors) are product copy. Write them for someone who has never seen the extension.

## Reporting bugs

Open an issue with your VS Code version, your OS, and a minimal Markdown snippet that reproduces the problem. For rendering bugs, the raw Markdown matters more than a screenshot of it — paste the source.

If Sheaf ever changes bytes you did not type, that is a top-priority bug. Say so in the title and include the before/after diff.

## License

Sheaf is released under the [MIT License](LICENSE).
