---
title: Front matter
summary: Show your document's YAML front matter in full, as one line, or not at all, without any of it leaving the file.
order: 1.7
---

# Front matter

A document that opens with `---` has a block of YAML above its text: a title, a slug, tags, whatever the tool that reads the file wants. You choose how much of it you see, because that depends on why you opened the file.

## Choose how much you see

Front matter has three states:

- **Collapsed** is one strip that names the block and shows the document's `title`, with a chevron to open it. This is the default: you can see the metadata is there, and which document it belongs to, without reading it.
- **Shown** draws every line, as written, with a chevron at the start of the block that folds it back.
- **Hidden** draws nothing and takes no space. The text begins where it would in a file with no front matter at all, and the blank line under the block goes too, since it has nothing left to separate.

Twelve lines of metadata at the top of a document you came to read push the first heading off the screen. The same twelve lines are the whole point when you came to change the slug.

## Set a state for every document

Set `sheaf.frontMatter` in Settings, or run one of the three Command Palette entries: **Sheaf: Show Front Matter**, **Collapse Front Matter**, **Hide Front Matter**. Either way, that is what every document starts as.

To make what one document is doing the setting, right-click inside its block and choose **Use this everywhere**. Every other document opens that way too.

## Set a state for one document

Do either of these:

- Press the chevron. On a collapsed strip it opens the block; on an open one, in the same place, it folds it. If the caret was in the metadata it moves to the start of your text, so you are never left typing into something that is no longer drawn.
- Right-click inside the block and pick one of the three states for that document alone. The one it is in is greyed out.

A document you set that way keeps its state the next time you open it and stops following the setting. To hand it back, right-click and choose **Reset to default**. It drops the document's own state and lets it follow the setting again.

A hidden block has nothing on the page to right-click, so while it is hidden the same three items are in the menu anywhere in the document. That is the way back, along with the commands and the setting.

## Edit the front matter

Put the caret in the block. It opens, whatever the state says, because somebody editing the metadata needs to see it. Move the caret out and it goes back to the state you chose.

Sheaf draws the block as metadata, in a quiet monospace, with none of it read as Markdown. A `#` in there is a YAML comment, not a heading.

## Good to know

- The file never changes. The lines are still in the document, still saved, still there for the next tool that reads it, and `git diff` is empty whichever state you are in.
- Nothing is out of reach. Find matches inside hidden front matter, Cmd+A (Ctrl+A on Windows and Linux) selects it with the rest, and a write from outside the editor lands in it as it always would.
