<h1 align="center">
  <img src="media/icon.png" width="96" height="96" alt="">
  <br>
  Sheaf Editor: WYSIWYG Markdown for Code Editors
</h1>

<p align="center">
  <b>Write Markdown the way it looks.</b><br>
  The Markdown files already in your project, as finished documents you edit in place, with tables you edit like a spreadsheet.<br>
  <sub>VS Code · Kiro · Cursor · Windsurf · VSCodium</sub>
</p>

<p align="center">
  <a href="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml"><img src="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

---

Sheaf shows the rendered document and lets you type straight into it. Headings look like headings, tables are grids, and the file on disk stays ordinary Markdown: an edit changes only what you typed, so the diff shows your change and nothing else. Press Cmd+Alt+E on any block to see and edit its Markdown.

## Why Sheaf

Your editor shows Markdown as source code. A preview pane helps you read it, but then you write in one half of the window and read in the other, and neither half is the document.

Sheaf makes the editor the document. It renders as you type, and the Markdown is a keystroke away whenever you want it. There is no preview pane, no second app and no vault to import into. The files stay where your project keeps them, and Sheaf never rewrites the lines you did not touch.

## Documents

- **What you see is the document.** Headings, emphasis, links, lists, task lists, quotes, callouts, code with highlighting, images you can resize and caption, and maths, all drawn and all editable in place.
- **Block editing.** A slash menu, a toolbar over selected text, a right-click menu, and a grip to drag, duplicate or turn a block into another kind. Keyboard shortcuts for every block and mark, listed in one overlay (Cmd+/).
- **Links that help.** Paste an address over selected words to link them, and complete a link to any file in your workspace or any heading in the document.
- **Find and replace, a table of contents and line numbers.**
- **See the Markdown when you want it.** Cmd+Alt+E shows one block's Markdown; **Toggle Whole-Document Source Mode** shows it all; **Open raw Markdown** on the toolbar opens the plain text editor.

## Tables and datatables

- **Every table is a grid.** Pipe tables and CSV or TSV blocks edit like a spreadsheet: Tab, Enter, the arrows and the spreadsheet keys, selection, copy and paste a spreadsheet understands, and commands to insert, move, sort and align rows and columns.
- **Columns sized to what they hold.** Drag a header's border to set a width. A long table keeps its header row in view as you scroll.
- **Open a .csv or .tsv file as a grid** with Reopen Editor With, then Sheaf (Grid).
- **Views.** Name a CSV block, then show it elsewhere in the document filtered, sorted and trimmed to the columns you want with a `view` block, or show a .csv file beside the document the same way. Edit a cell in the view and that one field changes in the source.
- **Boards.** Show a view, or any pipe table, as cards grouped by one column, and drag a card to change it.

Every edit rewrites only the cells you changed, so two people editing different rows of one table merge cleanly.

## Working with agents

- **Hand what you picked to an agent.** Copy ref (Cmd+Shift+Alt+R) puts the file, lines and text on the clipboard; in a table it names the cells. Send Selection to Terminal (Cmd+Shift+Alt+T) types the reference at your terminal's prompt.
- **See what changed.** When something else writes the open file, the lines it changed are marked in the margin. If a write takes back what you just typed, Sheaf says so and Cmd+Z brings it back.

## Getting started

Sheaf is a VS Code extension, and it runs unchanged in editors built on Code OSS. VS Code installs it from the Visual Studio Marketplace. Kiro, Cursor, Windsurf and VSCodium install it from Open VSX. Every release goes to both as the same build.

Install Sheaf, then open any `.md` file. There is nothing to configure.

| Command | What it does |
| --- | --- |
| **Open in Sheaf** | Open the current file in Sheaf |
| **Open as Raw Markdown (Text)** | Open the plain text editor |
| **Toggle Whole-Document Source Mode** | Show the Markdown of every block at once |
| **Open This Folder in a Browser** | Serve the folder to a browser tab, with the same editor |

The [documentation](docs/README.md) has a page for every feature.

## Making Sheaf the default, or not

Sheaf is the default editor for `.md` and `.markdown` files, so Markdown opens rendered as soon as it is installed. To open files in Sheaf one at a time instead, turn off **Settings → Extensions → Sheaf → Use As Default Markdown Editor**, or in `settings.json`:

```jsonc
"sheaf.useAsDefaultMarkdownEditor": false
```

Markdown then opens in the plain text editor, and you open a file in Sheaf with **Open in Sheaf**, on the Explorer's right-click menu, or with **View: Reopen Editor With… → Sheaf (WYSIWYG)**. The change applies to files you open afterwards.

The setting maintains `workbench.editorAssociations` for you. If you have pointed `*.md` at another editor there, Sheaf leaves your choice alone.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sheaf.useAsDefaultMarkdownEditor` | `true` | Open `.md` and `.markdown` files in Sheaf automatically. |
| `sheaf.contentWidth` | `708px` | Width of the centred text column. Any CSS length. |
| `sheaf.autoSave` | `true` | Save shortly after you stop typing. |
| `sheaf.revealSyntaxOnLine` | `false` | Show the Markdown of the block the cursor is in. |
| `sheaf.doubleClickToEditSource` | `false` | Double-click a rendered element to show its Markdown, instead of selecting a word. |
| `sheaf.tableOfContents` | `false` | Show a panel of the document's headings beside the text. |

## Status

A first public release. Bug reports and feature requests are welcome on the [issue tracker](https://github.com/sheafeditor/sheafeditor/issues).

## Verifying a release

Every release is built by GitHub Actions and carries a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) recording the commit and the workflow that produced it.

An extension registry ships a bundled file, not source, so reading this repository tells you what the source says and nothing about the file running in your editor. Both registries receive the same file, so one check covers either. Download the `.vsix` from the [releases page](https://github.com/sheafeditor/sheafeditor/releases) and run:

```bash
gh attestation verify sheafeditor-<version>.vsix --repo sheafeditor/sheafeditor
```

It prints the commit and workflow the build came from. Anything else means the file did not come out of this repository's release pipeline.

## Building from source

Sheaf is maintained by one person. Bug reports and ideas are welcome as issues; code contributions are not accepted.

```bash
npm install
npm run watch      # rebuilds the extension and the editor on change
# then press F5 in VS Code to launch the Extension Development Host
```

`npm test` runs the test suites and `npm run package` builds a `.vsix`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including the one rule that is not negotiable: Sheaf never reserializes your Markdown.

## License

MIT © Brett Jones
