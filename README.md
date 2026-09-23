<h1 align="center">
  <img src="media/icon.png" width="96" height="96" alt="">
  <br>
  Sheaf Editor: think with agents
</h1>

<p align="center">
  <b>Work in docs inside your agentic coding app or your favourite code editor.</b><br>
  Strategy, research, specs and roadmaps, kept as files in the repo your agents can read at local lightning speeds.<br>
  <sub>VS Code · Kiro · Cursor · Windsurf · VSCodium</sub>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=sheafeditor.sheafeditor"><img src="https://img.shields.io/visual-studio-marketplace/v/sheafeditor.sheafeditor?label=Marketplace" alt="Visual Studio Marketplace"></a>
  <a href="https://open-vsx.org/extension/sheafeditor/sheafeditor"><img src="https://img.shields.io/open-vsx/v/sheafeditor/sheafeditor?label=Open%20VSX" alt="Open VSX"></a>
  <a href="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml"><img src="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

---

**Open source and MIT-licensed.** Every line of Sheaf is in this repository, so you can read it, and so can your agent: ask it to check what the extension does before you install it. Each release is built by GitHub Actions and carries a [build provenance attestation](#verifying-a-release), which ties the published file to the commit it came from.

Sheaf shows the rendered document and lets you type straight into it. Headings look like headings, tables are grids, and the file on disk stays ordinary Markdown: an edit changes only what you typed, so the diff shows your change and nothing else.

## Hand your agent the exact lines

Right-click any line. **Copy ref** and **Send to terminal** give your agent a quoted reference to exactly what you picked: the file, the lines and the text, and in a table the cells. When an agent writes the file back, the lines it changed are marked in the margin, and if a write takes back what you just typed, Sheaf says so and Cmd+Z brings it back.

## Select a block, like a spreadsheet

Click a cell and type, drag across a range, or paste one in from Excel, Numbers or Sheets. Spreadsheet keys move you around, columns size to what they hold, and a long table keeps its header row in view. On disk it stays a Markdown table, and one edited cell is one changed line.

Name a CSV block and a `view` block elsewhere in the document shows it filtered, sorted and trimmed to the columns you want, or shows a `.csv` file beside the document the same way. Show a view, or any table, as a board of cards and drag one to change its value.

## Every block, rendered as you write

Headings, callouts, task lists, maths and code look like the finished page while you type into them. A slash menu, a toolbar over selected text, a right-click menu and a drag grip cover the block moves. Press Cmd+Alt+E on any block to see and edit its Markdown, or **Open raw Markdown** to drop the whole file back to plain text.

## See the shape of a long document

Turn on the table of contents and the headings sit beside the text. Click one to jump there. Find and replace reaches into tables, tinting the cells that match.

## It is still just a folder of Markdown

- **No import step.** Your files, where they already are.
- **Only your changes change.** `git diff` shows exactly what you did.
- **Every commit, forever.** No plan tier expires your history.
- **Nothing to sign up for.** No account, no database, no cloud.
- **Never locked in.** One button drops back to plain text.

## Install

| Editor | Where it installs from |
| --- | --- |
| VS Code | [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sheafeditor.sheafeditor) |
| Cursor, Windsurf, Kiro, VSCodium | [Open VSX](https://open-vsx.org/extension/sheafeditor/sheafeditor) |

Every release goes to both as the same build. Install it, open any `.md` file, and there is nothing to configure.

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

Markdown then opens in the plain text editor, and you open a file in Sheaf with **Open in Sheaf**, on the Explorer's right-click menu, or with **View: Reopen Editor With… → Sheaf (WYSIWYG)**. The setting maintains `workbench.editorAssociations` for you. If you have pointed `*.md` at another editor there, Sheaf leaves your choice alone.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sheaf.useAsDefaultMarkdownEditor` | `true` | Open `.md` and `.markdown` files in Sheaf automatically. |
| `sheaf.contentWidth` | `708px` | Width of the centred text column. Any CSS length. |
| `sheaf.autoSave` | `true` | Save shortly after you stop typing. |
| `sheaf.revealSyntaxOnLine` | `false` | Show the Markdown of the block the cursor is in. |
| `sheaf.doubleClickToEditSource` | `false` | Double-click a rendered element to show its Markdown, instead of selecting a word. |
| `sheaf.tableOfContents` | `false` | Show a panel of the document's headings beside the text. |

## Verifying a release

An extension registry ships a bundled file, not source, so reading this repository tells you what the source says and nothing about the file running in your editor. Every release is built by GitHub Actions and carries a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) recording the commit and the workflow that produced it. Both registries receive the same file, so one check covers either:

```bash
gh attestation verify sheafeditor-<version>.vsix --repo sheafeditor/sheafeditor
```

Download the `.vsix` from the [releases page](https://github.com/sheafeditor/sheafeditor/releases) first. The command prints the commit and workflow the build came from. Anything else means the file did not come out of this repository's release pipeline.

## Building from source

Sheaf is maintained by one person. Bug reports and ideas are welcome as [issues](https://github.com/sheafeditor/sheafeditor/issues); code contributions are not accepted.

```bash
npm install
npm run watch      # rebuilds the extension and the editor on change
# then press F5 in VS Code to launch the Extension Development Host
```

`npm test` runs the test suites and `npm run package` builds a `.vsix`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including the one rule that is not negotiable: Sheaf never reserializes your Markdown.

## License

MIT © Brett Jones
