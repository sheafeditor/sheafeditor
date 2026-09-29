---
title: Settings
summary: Change what Sheaf opens, how wide the text runs, when it saves, and how much Markdown, front matter and structure it shows.
order: 20
---

# Settings

Sheaf has eight settings, and this page has an entry for each, headed by the name you see in the Settings UI. Reach them in the Settings UI under Extensions, Sheaf, or edit `settings.json` directly. Every one applies to editors that are already open, so you can watch a change take effect.

Keys on this page use Cmd. On Windows and Linux, use Ctrl in its place.

## The default editor

`sheaf.useAsDefaultMarkdownEditor`, default `true`.

**On:** Sheaf is the default editor for `.md` and `.markdown` files, so Markdown opens rendered right after you install it. The plain text editor stays one click away, at the right end of the formatting toolbar.

**Off:** Markdown opens in the plain text editor, and you open individual files in Sheaf yourself. Use this to opt in per file:

```jsonc
"sheaf.useAsDefaultMarkdownEditor": false
```

Then open a file in Sheaf with **Open in Sheaf**, which is also on the explorer right-click menu, or with **View: Reopen Editor With… → Sheaf (WYSIWYG)**.

The change applies to files you open afterwards. Editors that are already open keep the editor they were opened with.

## Content width

`sheaf.contentWidth`, default `"708px"`.

Sets the width of the centered text column. Any CSS length works:

- `"90ch"` sets the column by character count.
- `"100%"` fills the editor pane.

## Auto-save

`sheaf.autoSave`, default `true`.

**On:** Sheaf saves the file a short moment after you stop typing, the way a notes app does.

**Off:** your edits still update the document, and you save with Cmd+S or leave it to VS Code's own `files.autoSave`.

## Reveal syntax on the current line

`sheaf.revealSyntaxOnLine`, default `false`.

**On:** the block the cursor is on shows its raw Markdown markers, so the block you are writing in shows its syntax while the rest of the document stays rendered.

**Off:** a block shows its raw Markdown only while **Edit Markdown** (Cmd+Alt+E) has it open.

A quote's `>` is the one marker this leaves hidden. Everything else on a quoted line shows as written, asterisks and backticks and link brackets included. The `>` stays away because a quote's indent already leaves room for it, so drawing it would shift the words sideways as you moved the cursor onto the line and back as you left. **Edit Markdown** shows it, as it shows everything.

## Double-click to edit source

`sheaf.doubleClickToEditSource`, default `false`.

**On:** double-clicking a rendered element reveals its raw Markdown for editing.

**Off:** double-clicking selects a word, as it does everywhere else. **Edit Markdown** reveals the Markdown either way.

## Front matter

`sheaf.frontMatter`, default `"collapsed"`.

Sets how much of a document's YAML front matter Sheaf draws. The lines stay in the file and are saved in every state.

- `"collapsed"`: one strip naming the front matter and the document's title, with a chevron that opens it.
- `"shown"`: every line of the front matter, as written.
- `"hidden"`: nothing, taking no height, so the text begins where it would in a file with no front matter.

Putting the caret in the block opens it whatever this says. **Show Front Matter**, **Collapse Front Matter** and **Hide Front Matter** set it from the Command Palette. See [Front matter](features/front-matter.md).

## Table of contents

`sheaf.tableOfContents`, default `"hidden"`.

Sets whether a panel of the document's headings shows beside the text, marking the one you are reading. It applies to every Markdown file you open in Sheaf.

- `"shown"`: the panel lists the headings.
- `"collapsed"`: the panel shows its Contents header with the list folded away.
- `"hidden"`: no panel, and the margin is left to the text.

`true` and `false` still work, and mean `"shown"` and `"hidden"`. The toolbar's list button turns the panel on and off. See [Table of contents](features/table-of-contents.md).

## Comments

`sheaf.comments`, default `show`.

Sets how Sheaf draws the notes written into a document as `<!-- ... -->`.

- `show`: each comment that sits on its own lines is drawn as a box labelled Comment, with a chevron that collapses it.
- `hidden`: each comment shrinks to a small marker you can click to read it.

**Toggle Comments** flips between them. See [Comments](features/comments.md).

## Commands

All of them are in the Command Palette under Sheaf.

| Command | What it does |
| --- | --- |
| **Open in Sheaf** | Open the current file in the WYSIWYG editor |
| **Open as Raw Markdown (Text)** | Drop back to the plain text editor |
| **Toggle Whole-Document Source Mode** | Reveal raw Markdown for the whole document |
| **Toggle Table of Contents** | Show or hide the panel of headings |
| **Show Table of Contents** | Show the panel of headings |
| **Collapse Table of Contents** | Show the panel's header with the list folded away |
| **Hide Table of Contents** | Hide the panel of headings |
| **Toggle Comments** | Draw the document's comments as boxes, or shrink each to a marker |
| **Show Front Matter** | Draw every line of the front matter |
| **Collapse Front Matter** | Draw the front matter as one strip |
| **Hide Front Matter** | Draw no front matter |
| **Copy Ref** (Cmd+Shift+C) | Put the file, the lines and the text you picked on the clipboard |
| **Send Selection to Terminal** (Cmd+Shift+Alt+T) | Type a reference to the lines you picked at your terminal's prompt |
| **Open This Folder in a Browser** | Serve this folder on this machine and give you the address |
| **Stop Serving to the Browser** | Stop it again |
| **About** | Say which build of Sheaf this window is running, with a button to copy it |

Copy Ref and Send Selection to Terminal are covered in [Sharing a reference](features/sharing.md), and the two browser commands in [In a browser](features/in-a-browser.md).

## Which build you are running

Run **Sheaf: About**. It shows the version, the commit it was built from, and the editor it is running in, with a **Copy** button that puts that one line on the clipboard. Paste it into a bug report and whoever reads it knows exactly what you were using.

A build made from a modified copy of the source says so, because its commit alone does not describe what is running.

If a newer build of Sheaf is installed while your window is open, the window keeps running the one it started with until it reloads. Sheaf notices and offers you a **Reload Window** button, once, so a change you were told about is not invisible while you look straight at it. Nothing reloads without you asking.

In a browser tab there is no Extensions pane to consult, so the same line sits in the footer of the folder page.
