---
title: Getting started
summary: Install Sheaf, open a Markdown file, and learn the three controls that matter.
order: 10
---

# Getting started

Sheaf is an editor for the Markdown files already in your project. You see the rendered document and type straight into it, and Sheaf writes ordinary Markdown back to the same file in the same place. This page takes you from installing it to your first edit in a few minutes.

## Install Sheaf

Sheaf is a VS Code extension, and it runs unchanged in editors built on Code OSS.

1. Open the Extensions view in your editor.
2. Search for Sheaf and install it.

Your editor installs it from the registry it already uses:

| Editor | Where it installs from |
| --- | --- |
| VS Code | Visual Studio Marketplace |
| Cursor, Windsurf, Kiro, VSCodium | Open VSX |

Every release goes to both registries as the same build.

## Open a Markdown file

Open any `.md` file. Sheaf registers itself as the default editor for `.md` and `.markdown`, so Markdown opens rendered as soon as the extension is installed. There is nothing to configure.

If you would rather open files in Sheaf one at a time, turn off [the default editor setting](settings.md#the-default-editor).

## Open a text file in Sheaf

A `.txt` opens in Sheaf only when you ask for it. Right-click it and choose **Open in Sheaf**, or use **Reopen Editor With**.

Double-clicking a `.txt` still opens the plain text editor, which is what a log or a fixture wants. This is for the notes people keep in a `.txt` that are Markdown in everything but the name. Sheaf reads one exactly as it reads a `.md`: a line starting with `#` is a heading, and a word in asterisks is emphasis. Nothing is written to the file unless you edit it, so opening one to look at it changes nothing.

## The three controls

These three get you from the rendered document to the Markdown underneath and back. Keys on this page use Cmd; on Windows and Linux, use Ctrl in its place.

**Edit Markdown** reveals the raw Markdown of the block your cursor is in.

1. Put your cursor in a block and press Cmd+Alt+E. You can also reach it from the block menu or the right-click menu.
2. Edit the Markdown.
3. Press Cmd+Alt+E again, press Escape, or move the cursor out of the block to put the Markdown away.

**Open as Raw Markdown (Text)** drops the whole file back to the plain text editor. Press the **Open raw Markdown** button at the right end of the formatting toolbar, or find it in the Command Palette under Sheaf.

**Toggle Whole-Document Source Mode** reveals the raw Markdown for every block at once, without leaving Sheaf. Find it in the Command Palette under Sheaf.

## What you get

- Headings, [formatting](features/formatting.md), code, [links](features/links.md), [images](features/images.md), quotes, [callouts](features/callouts.md), lists, task checkboxes, rules and [maths](features/maths.md), all rendered and all editable in place.
- [Tables as a grid](features/tables.md), with spreadsheet keys, selection, and copy and paste that a spreadsheet understands.
- A formatting toolbar, a [right-click menu](features/menus.md), a [slash menu](features/slash-menu.md) for inserting blocks, and [block moves](features/blocks.md) by dragging or from the keyboard.
- [Find and replace](features/find-and-replace.md) and an optional [table of contents](features/table-of-contents.md).
- Working with coding agents: [hand them the lines you picked](features/sharing.md), and [see what they changed](features/files-and-saving.md#see-what-changed) in the file you have open.
- [The same editor in a browser](features/in-a-browser.md), served from your own machine.
- Editorial typography on a centered text column, themed to your active colour theme. Light, dark and high contrast themes are all supported, and text, links and icons stay legible in each.
- Auto-save a beat after you stop typing.

## What to do next

1. Make a small edit in a document you know well, then run `git diff`. Only the characters you changed show up. [Files and saving](features/files-and-saving.md) says what else Sheaf promises about your file.
2. Open a document with a table and click into a cell. [Tables](features/tables.md) covers the keys.
3. Type `/` at the start of a line to see what the [slash menu](features/slash-menu.md) can insert.
4. Look through [Settings](settings.md) for the column width, auto-save and the rest.

## What Sheaf does not do

Sheaf edits the files your project already has. There is no vault to import into, no database, and no separate copy of your document. The file you open is the file it writes.

It is a Markdown editor, so it writes Markdown. A document that needs page layout, tracked changes or comment threads is not what Sheaf is for.
