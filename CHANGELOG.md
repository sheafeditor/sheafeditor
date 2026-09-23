# Changelog

All notable changes to Sheaf are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A heading has space above it again.** The spacing the stylesheet defined for headings had never reached the page: CodeMirror's own rules outrank it, so every heading in every document was drawn with none. Sections separate properly now, with the space above a heading rather than below it, so a heading stays attached to what it introduces.
- **A document with a table no longer runs off the right edge of a phone screen.** The text column was being widened past the screen by the table's touch-sized command bar, which then never folded, because the room it measures is the column it had just widened. The column is the width of the window now, and anything wider than it scrolls inside its own frame.

### Changed

- **A code block no longer shows its ``` fences.** The block is drawn as a panel of code, and the language you wrote after the opening fence is a small label at the top right of it. The fences are still in the file; **Edit Markdown** on the block shows them, which is how you change the language. A block indented by four spaces is unchanged.

## [0.2.0] - 2026-09-23

### Added

- **Comments are notes you can read and put aside.** A `<!-- ... -->` on its own lines is drawn as a box labelled Comment, in the style of the callouts, with a chevron that shuts it to its first line. Which comments you have collapsed is remembered for the folder, and never written into the file. A comment written inside a sentence keeps the styling it had, and `<!-- -->` inside a code block is still code.
- **Sheaf: Toggle Comments** and the setting `sheaf.comments` put every comment away, leaving a small marker where each one is. Click a marker to read that comment.
- **Open in Sheaf is on the right-click menu of the editor's tab and of the text itself,** as well as the Explorer's. After turning Sheaf off as the default, or dropping one file to raw text, getting a document back is wherever you happen to right-click.

### Changed

- **Copy ref is on the toolbar that floats over a selection,** beside Edit Markdown, and its key is now **Cmd+Shift+C** (Ctrl+Shift+C). Selecting the lines and handing them to an agent is one gesture and then one click, instead of a chord with three modifiers or a trip through the right-click menu. The old Cmd+Shift+Alt+R still works.
- **The toolbar's view buttons pack with the rest once the bar folds onto a second row,** rather than sitting alone at the far right of it.
- **A blank line that only separates two blocks is drawn as the gap it is,** instead of as an empty line of text. Documents read tighter: a heading and the table under it sit about 18 px closer. The blank line is still in the file, untouched, and a caret on one gives it back its height.

## [0.1.0] - 2026-09-22

The first public release. Sheaf opens the Markdown files already in your repository as finished documents you can edit in place, with tables you edit like a spreadsheet. The file stays plain Markdown: an edit changes only the characters you changed, so `git diff` shows your words and nothing else.

### Writing

- **What you see is the document.** Headings, emphasis, links, lists, task lists, quotes, code, images, maths (`$…$` and `$$…$$`), callouts (`> [!NOTE]` and friends, including titles and folds) and inline HTML such as `<kbd>` and `<sub>` render as you type. Edit Markdown (Cmd+Alt+E, Ctrl+Alt+E) shows one block's source whenever you want it.
- **A block editor's moves.** A slash menu, a toolbar over selected text, a right-click menu that leads with Turn into and Edit Markdown, a grip to drag, duplicate and delete whole blocks, and Escape to select blocks from the keyboard.
- **Links that help.** Paste an address over selected words to link them, edit a link in place from a popover, and after `](` pick a file from your workspace or, after `](#`, a heading from the document.
- **Find and replace, a table of contents, line numbers,** and keyboard shortcuts for every block and mark, listed in one overlay (Cmd+/).

### Tables

- **Pipe tables and CSV or TSV blocks are grids.** Click a cell and type. Tab, Enter, the arrows and the spreadsheet keys move between cells, and cells render their Markdown while you edit them.
- **Every table command in one place.** A bar above each table and a right-click menu insert, duplicate, delete, move, sort, align and pad rows and columns. Drag rows and columns by their numbers and headers. Paste a range from a spreadsheet.
- **Tables where documents keep them:** inside list items and blockquotes, with or without outer pipes, and the lines you did not touch keep their exact bytes, quoting and padding included.
- **Columns sized to what they hold.** Short columns keep their width and prose shares the rest; drag a header's border to set a width, which VS Code keeps for you and never writes into the file. A long table keeps its header row in view as you scroll, and a tall cell shows four lines until you select it.
- **Find reaches into tables.** Cmd+F tints every cell that holds a match, and Enter makes the matched cell the active one.
- **Open a .csv or .tsv file as a grid.** Reopen Editor With, then Sheaf (Grid): the whole file is one editable grid, and an edit rewrites only the record you changed.

### Datatables

- **Name a CSV block and show it elsewhere.** Write ```` ```csv id=tasks ````, then a ```` ```view ```` block with `from: #tasks` (or `from: data/tasks.csv`) and optional `where`, `sort` and `show` lines draws just the rows and columns you asked for. Its headers sort and filter it for you, rewriting one line of the query.
- **Edit through a view.** A cell edited in a view is written to the block or file it reads, that one field and nothing else, and Cmd+Z takes it back. A new row starts with the values the filter asks for.
- **Boards.** `layout: board` with `group: status` shows the rows as cards in a column per value; drag a card, or press Alt+Left and Alt+Right, to change its status. A plain pipe table can be shown as a board from its own menu.
- **Move to file and back.** A block that has grown can move its rows to a `.csv` beside the document, leaving a view in its place, and a view of a file can bring the rows back inline. Nothing is ever split into a file unless you ask.

### Working with agents

- **Hand what you picked to an agent.** Copy ref (Cmd+Shift+Alt+R) puts the file, the lines and the text on the clipboard; in a table it names the cells. Send Selection to Terminal (Cmd+Shift+Alt+T) types `@file.md#L12-18` at your terminal's prompt.
- **See what an agent changed.** When anything outside the editor writes the open file, the lines it wrote are marked in the margin, and table rows are marked beside their numbers. If a write takes back something you had just typed, Sheaf says so and one Cmd+Z brings it back.

### Where it runs

- **VS Code and editors built on Code OSS.** Published to the Visual Studio Marketplace and to Open VSX, so Cursor, Windsurf, Kiro and VSCodium can install it.
- **Any browser, from your own machine.** **Sheaf: Open This Folder in a Browser**, or `sheaf` in a terminal, serves the folder at a local address with the same editor. Views of a .csv file need VS Code for now; views of a named block work in both.

### Trust

- **Your file is the only store.** No account, no server, no database. Delete Sheaf and your documents are exactly as they were.
- **Verifiable releases.** Each `.vsix` is built by GitHub Actions with a build provenance attestation tying it to the commit it came from.

## [0.0.1] - 2026-08-03

A preview build that was never published.

### Added

- Always-on WYSIWYG rendering for Markdown that you type directly into: headings, bold / italic / strikethrough, inline and fenced code, links, images, blockquotes, lists, task checkboxes, and horizontal rules.
- **Raw Markdown stays the source of truth.** Rendering is done with view-only CodeMirror 6 decorations rather than a document model, so prose you edit is never reserialized and your git diffs stay clean.
- **Double-click any rendered element** to reveal and edit its raw Markdown.
- **Reveal-on-cursor** (`sheaf.revealSyntaxOnLine`, off by default): show raw syntax markers for the block the cursor is on, and render everything else.
- Formatting toolbar and spreadsheet-style table editing.
- Editorial typography on a centered text column, width configurable via `sheaf.contentWidth` (default `708px`).
- Themed to your active VS Code color theme, dark mode included.
- Debounced auto-save (`sheaf.autoSave`, on by default).
- Commands: **Open in Sheaf**, **Open as Raw Markdown (Text)**, and **Toggle Whole-Document Source Mode**.

[Unreleased]: https://github.com/sheafeditor/sheafeditor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sheafeditor/sheafeditor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sheafeditor/sheafeditor/releases/tag/v0.1.0
