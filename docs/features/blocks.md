---
title: Blocks
summary: Moving, duplicating, deleting and converting whole paragraphs, headings, list items, quotes, code blocks and tables.
order: 11
---

# Blocks

A block is one paragraph, heading, list item, quote, code block or table. Sheaf lets you work on whole blocks the way a block editor does, while the file stays ordinary Markdown: moving a block moves its lines, and nothing else in the file changes.

## The grip and the +

Hover a block and two controls appear in the left margin:

- **The grip** (six dots) opens the block's menu: **Turn into** (text, a heading, a list, a quote or a code block), **Edit Markdown**, **Duplicate**, **Move up**, **Move down**, **Delete** and **Copy ref**. The menu works from the keyboard too: the arrow keys, Home and End move, Enter or Space picks, the right arrow opens Turn into, and Escape closes it.
- **The +** adds an empty line below the block, or a new item below a list item, and opens the [slash menu](slash-menu.md) there so you can pick what it becomes.

## Dragging

Press the grip and move the pointer: the block fades, a line shows the gap it will land in, and letting go moves it there. A list item moves only among the items of its own list. Escape cancels the drag. With several blocks selected, dragging any of them carries all of them.

## From the keyboard

With the caret in text, press **Escape** to select the whole block around it. A click on a divider selects the divider the same way, so typing replaces it and **Edit Markdown** (Cmd+Alt+E) shows its `---`. Then:

| Key | Does |
| --- | --- |
| Up, Down | Select the block above or below instead |
| Shift+Up, Shift+Down | Extend the selection by the next block |
| Cmd+Shift+Up, Cmd+Shift+Down | Move the selected blocks |
| Cmd+D | Duplicate them |
| Backspace or Delete | Delete them |
| Enter or Escape | Go back to a caret |

**Alt+Up** and **Alt+Down** (Option on the Mac) move the block the caret is in past its neighbour without selecting it first. On a single line, inside code or in front matter they move one line, as they do in a text editor.

On Windows and Linux, Cmd is Ctrl. All of these are listed in the keyboard shortcuts overlay (Cmd+/).
