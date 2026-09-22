---
title: Getting started
summary: Install Sheaf, open a Markdown file, and learn the three controls that matter.
order: 10
---

# Getting started

Sheaf is an editor for the Markdown files already in your project. It shows the rendered document and lets you type straight into it, and it writes ordinary Markdown back to the same file in the same place.

## Install

Sheaf is a VS Code extension, and it runs unchanged in editors built on Code OSS.

| Editor | Where it installs from |
| --- | --- |
| VS Code | Visual Studio Marketplace |
| Cursor, Windsurf, Kiro, VSCodium | Open VSX |

Every release goes to both registries as the same build. Search for Sheaf in the Extensions view and install it.

## Open a file

Open any `.md` file. Sheaf registers itself as the default editor for `.md` and `.markdown`, so Markdown opens rendered as soon as the extension is installed. There is nothing to configure.

If you would rather open files in Sheaf one at a time, see [making Sheaf the default](settings.md#the-default-editor).

## The three controls

**Edit Markdown** reveals the raw Markdown of the block your cursor is in. Press Cmd+Alt+E, or Ctrl+Alt+E on Windows and Linux. You can also reach it from the block menu or the right-click menu. Press it again, press Escape, or move the cursor out of the block to put the Markdown away.

**Open as Raw Markdown (Text)** drops the whole file back to the plain text editor. It is the **Open raw Markdown** button at the right end of the formatting toolbar, and it is in the Command Palette under Sheaf.

**Toggle Whole-Document Source Mode** reveals the raw Markdown for every block at once, without leaving Sheaf. It is in the Command Palette under Sheaf.

## What you get

- Headings, [formatting](features/formatting.md), code, [links](features/links.md), [images](features/images.md), quotes, [callouts](features/callouts.md), lists, task checkboxes, rules and [maths](features/maths.md), all rendered and all editable in place.
- [Tables as a grid](features/tables.md), with spreadsheet keys, selection, and copy and paste that a spreadsheet understands.
- A formatting toolbar, a [right-click menu](features/menus.md), a [slash menu](features/slash-menu.md) for inserting blocks, and [block moves](features/blocks.md) by dragging or from the keyboard.
- [Find and replace](features/find-and-replace.md) and an optional [table of contents](features/table-of-contents.md).
- Working with coding agents: [hand them the lines you picked](features/sharing.md), and [see what they changed](features/files-and-saving.md#seeing-what-changed) in the file you have open.
- [The same editor in a browser](features/in-a-browser.md), served from your own machine.
- Editorial typography on a centered text column, themed to your active colour theme. Light, dark and high contrast themes are all supported, and text, links and icons stay legible in each.
- Auto-save a beat after you stop typing.

## What Sheaf does not do

Sheaf edits the files your project already has. There is no vault to import into, no database, and no separate copy of your document. The file you open is the file it writes.

It is a Markdown editor, so it writes Markdown. A document that needs page layout, tracked changes or comment threads is not what Sheaf is for.
