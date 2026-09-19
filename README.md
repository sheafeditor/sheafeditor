<h1 align="center">
  <img src="media/icon.png" width="96" height="96" alt="">
  <br>
  Sheaf Editor — WYSIWYG Markdown for Code Editors
</h1>

<p align="center">
  <b>Write Markdown the way it looks.</b><br>
  A block editor for the Markdown files already in your project.<br>
  <sub>VS Code · Kiro · Cursor · Windsurf · VSCodium</sub>
</p>

<p align="center">
  <a href="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml"><img src="https://github.com/sheafeditor/sheafeditor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

---

Sheaf always shows the rendered document and lets you edit straight into it. Headings look like headings, tables look like tables, and you type directly into all of it. Press Cmd+Alt+E on any block to reveal and edit its raw Markdown.

## Why Sheaf

Your editor shows Markdown as source code. You can open a preview pane, but then you're reading in one half of the window and writing in the other, and neither half is the document.

Sheaf makes the editor itself the document. One surface: it renders as you type, it looks like something you'd actually want to read, and the raw syntax is a keystroke away whenever you want it back. No preview pane, no second app, no vault to import into — the files stay exactly where your project already keeps them.

## Features

- **Always-on rendering you can type into** — headings, bold / italic / strikethrough, inline and fenced code, links, images, blockquotes, lists, task checkboxes, and rules.
- **Edit the raw Markdown of any block** — press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown** from the block menu or the right-click menu. Press it again, press Escape, or move the cursor out of the block to put the Markdown away.
- **Formatting toolbar** and **spreadsheet-style table editing** — tab between cells, add and reorder rows and columns.
- **Reveal-on-cursor** — optionally show raw syntax for the block the cursor sits on. Off by default; enable `sheaf.revealSyntaxOnLine`.
- **Editorial typography** on a centered 708px text column, themed to your active color theme. Dark mode included.
- **Auto-save** a beat after you stop typing, so it feels like a notes app.
- **The raw editor is always one click away** — hit *Open as Raw Markdown (Text)* in the editor title bar.

## Getting started

Sheaf is a VS Code extension and it runs unchanged in editors built on Code OSS. VS Code installs it from the Visual Studio Marketplace. Kiro, Cursor, Windsurf and VSCodium install it from Open VSX, the registry those editors search by default. Every release goes to both, as the same build.

Install Sheaf, then open any `.md` file. That's it — no configuration required.

| Command                               | What it does                                |
| ------------------------------------- | ------------------------------------------- |
| **Open in Sheaf**                  | Open the current file in the WYSIWYG editor |
| **Open as Raw Markdown (Text)**       | Drop back to the plain text editor          |
| **Toggle Whole-Document Source Mode** | Reveal raw Markdown for the entire document |

## Making Sheaf the default (or not)

Sheaf registers itself as the **default** editor for `.md` and `.markdown` files, so Markdown opens rendered right after you install it. The plain text editor is always one click away via **Open as Raw Markdown (Text)**.

Prefer to opt in per file instead? Turn it off in the Settings UI — **Settings → Extensions → Sheaf → Use As Default Markdown Editor** — or in `settings.json`:

```jsonc
"sheaf.useAsDefaultMarkdownEditor": false
```

Markdown then opens in the plain text editor, and you open individual files in Sheaf with **Open in Sheaf** (also on the explorer right-click menu) or **View: Reopen Editor With… → Sheaf (WYSIWYG)**. The change applies to files you open afterwards; editors that are already open keep the editor they were opened with.

Under the hood this setting maintains `workbench.editorAssociations` for you, since that is what overrides an extension's contributed default editor. If you have pointed `*.md` at some *other* editor there, Sheaf leaves your choice alone.

## Settings

| Setting                               | Default | Description                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------- |
| `sheaf.useAsDefaultMarkdownEditor` | `true`  | Open `.md` and `.markdown` files in Sheaf automatically. |
| `sheaf.contentWidth`               | `708px` | Width of the centered text column. Any CSS length.          |
| `sheaf.autoSave`                   | `true`  | Save shortly after you stop typing.                         |
| `sheaf.revealSyntaxOnLine`         | `false` | Reveal raw syntax on the cursor's block.                    |
| `sheaf.doubleClickToEditSource`    | `false` | Double-click a rendered element to reveal its raw Markdown, instead of selecting a word. |

## Status

Early. Phase 1 — the core WYSIWYG MVP — is what ships today. Bug reports and feature requests are welcome on the [issue tracker](https://github.com/sheafeditor/sheafeditor/issues).

## Verifying a release

Every release is built by GitHub Actions and carries a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) recording the commit and the workflow that produced it.

This matters because an extension registry ships a bundled artifact, not source. Reading this repository tells you what the source says, and nothing about the file running in your editor. The two are otherwise connected only by trust in whoever uploaded it. Both registries receive the byte-identical file, so one verification covers either. To check for yourself, download the `.vsix` from the [releases page](https://github.com/sheafeditor/sheafeditor/releases) and run:

```bash
gh attestation verify sheafeditor-<version>.vsix --repo sheafeditor/sheafeditor
```

It prints the commit and workflow the build came from. Anything else means the file did not come out of this repository's release pipeline.

## Contributing

```bash
npm install
npm run watch      # rebuilds extension + webview on change
# then press F5 in VS Code to launch the Extension Development Host
```

`npm test` runs the engine and table test suites. `npm run package` builds a `.vsix`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide — including the one rule that is not negotiable: Sheaf never reserializes your Markdown, which rules out the document-model approach most WYSIWYG editors take.

The module headers in `src/` and `src/webview/` say what each file is responsible for.

## License

MIT © Sheaf
