---
title: Settings
summary: Every Sheaf setting, what it changes, and what it is set to out of the box.
order: 20
---

# Settings

Sheaf has five settings. Reach them in the Settings UI under Extensions, Sheaf, or edit `settings.json` directly. Every one of them applies to editors that are already open, so you can watch a change take effect.

## The default editor

`sheaf.useAsDefaultMarkdownEditor`, default `true`.

Sheaf makes itself the default editor for `.md` and `.markdown` files, so Markdown opens rendered right after you install it. The plain text editor stays one click away, at the right end of the formatting toolbar.

To opt in per file instead, turn it off:

```jsonc
"sheaf.useAsDefaultMarkdownEditor": false
```

Markdown then opens in the plain text editor. Open individual files in Sheaf with **Open in Sheaf**, which is also on the explorer right-click menu, or with **View: Reopen Editor With… → Sheaf (WYSIWYG)**.

The change applies to files you open afterwards. Editors that are already open keep the editor they were opened with.

## Content width

`sheaf.contentWidth`, default `"708px"`.

The width of the centered text column. Any CSS length works, so `"90ch"` sets the column by character count and `"100%"` fills the editor pane.

## Auto-save

`sheaf.autoSave`, default `true`.

Saves the file a short moment after you stop typing, the way a notes app does.

With it off, your edits still update the document, and you save manually with Cmd+S or leave it to VS Code's own `files.autoSave`.

## Reveal syntax on the current line

`sheaf.revealSyntaxOnLine`, default `false`.

Shows the raw Markdown markers for the block the cursor is on, so the block you are writing in shows its syntax while the rest of the document stays rendered.

With it off, a block shows its raw Markdown only while **Edit Markdown** (Cmd+Alt+E, or Ctrl+Alt+E on Windows and Linux) has it open.

## Double-click to edit source

`sheaf.doubleClickToEditSource`, default `false`.

Makes double-clicking a rendered element reveal its raw Markdown for editing.

It is off so that double-clicking selects a word, as it does everywhere else. **Edit Markdown** reveals the Markdown either way.

## Table of contents

`sheaf.tableOfContents`, default `false`.

Shows a panel of the document's headings beside the text, marking the one you are reading. It applies to every Markdown file you open in Sheaf, and the toolbar's list button turns it on and off. See [Table of contents](features/table-of-contents.md).

## Comments

`sheaf.comments`, default `show`.

How to draw the notes written into a document as `<!-- ... -->`. `show` draws each one that sits on its own lines as a box labelled Comment, with a chevron that collapses it. `hidden` shrinks each to a small marker you can click to read it. **Toggle Comments** flips between them. See [Comments](features/comments.md).

## Commands

All of them are in the Command Palette under Sheaf.

| Command | What it does |
| --- | --- |
| **Open in Sheaf** | Open the current file in the WYSIWYG editor |
| **Open as Raw Markdown (Text)** | Drop back to the plain text editor |
| **Toggle Whole-Document Source Mode** | Reveal raw Markdown for the whole document |
| **Toggle Table of Contents** | Show or hide the panel of headings |
| **Toggle Comments** | Draw the document's comments as boxes, or shrink each to a marker |
| **Copy Ref** (Cmd+Shift+C) | Put the file, the lines and the text you picked on the clipboard |
| **Send Selection to Terminal** (Cmd+Shift+Alt+T) | Type a reference to the lines you picked at your terminal's prompt |
| **Open This Folder in a Browser** | Serve this folder on this machine and give you the address |
| **Stop Serving to the Browser** | Stop it again |

On Windows and Linux the keys use Ctrl in place of Cmd. Copy Ref and Send Selection to Terminal are covered in [Sharing a reference](features/sharing.md), and the last two in [In a browser](features/in-a-browser.md).
