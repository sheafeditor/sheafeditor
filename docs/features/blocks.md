---
title: Blocks
summary: Move, duplicate, delete and convert whole paragraphs, headings, list items, quotes, code blocks and tables.
order: 11
---

# Blocks

A block is one paragraph, heading, list item, quote, code block or table. You can move, duplicate, delete and convert whole blocks the way you would in a block editor, and the file stays ordinary Markdown.

## Open a block's menu

Hover a block and two controls appear in the left margin. Press the grip (six dots) to open the block's menu:

- **Turn into**: text, a heading, a list, a quote or a code block
- **Edit Markdown**
- **Duplicate**
- **Move up** and **Move down**
- **Delete**
- **Copy ref**

The menu works from the keyboard too: the arrow keys, Home and End move, Enter or Space picks, the right arrow opens Turn into, and Escape closes it.

## Add a block below

Press the **+** beside the grip. It adds an empty line below the block, or a new item below a list item, and opens the [slash menu](slash-menu.md) there so you can pick what it becomes.

## Drag a block

1. Press the grip and move the pointer. The block fades, and a line shows the gap it will land in.
2. Let go to move the block there, or press Escape to cancel the drag.

With several blocks selected, dragging any of them carries all of them. A list item moves only among the items of its own list.

## Select blocks from the keyboard

1. With the caret in text, press Escape. The whole block around the caret is selected.
2. Press Up or Down to select the block above or below instead, or Shift+Up and Shift+Down to extend the selection by the next block.
3. Press Enter or Escape to go back to a caret.

A click on a divider selects the divider the same way, so typing replaces it and **Edit Markdown** (Cmd+Alt+E) shows its `---`. On Windows and Linux, Cmd is Ctrl throughout this page.

## Move a block from the keyboard

With blocks selected, press Cmd+Shift+Up or Cmd+Shift+Down to move them.

To move the block the caret is in without selecting it first, press Alt+Up or Alt+Down (Option on the Mac). It moves past its neighbour. On a single line, inside code or in front matter, these keys move one line instead, as they do in a text editor.

## Duplicate or delete blocks

Select the blocks, then press Cmd+D to duplicate them, or Backspace or Delete to delete them. **Duplicate** and **Delete** in the block's menu do the same for one block.

## Keys

With one or more blocks selected:

| Key | Does |
| --- | --- |
| Up, Down | Select the block above or below instead |
| Shift+Up, Shift+Down | Extend the selection by the next block |
| Cmd+Shift+Up, Cmd+Shift+Down | Move the selected blocks |
| Cmd+D | Duplicate them |
| Backspace or Delete | Delete them |
| Enter or Escape | Go back to a caret |

With the caret in text, Escape selects the block, and Alt+Up and Alt+Down move it. All of these are listed in the keyboard shortcuts overlay (Cmd+/).

## Good to know

- Moving a block moves its lines, and nothing else in the file changes.
- A list item can be dragged only among the items of its own list.
