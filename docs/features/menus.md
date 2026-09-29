---
title: Menus
summary: Use the toolbar that opens over a selection and the right-click menu that opens where you point.
order: 6
---

# Menus

Two menus act on the text in front of you. The toolbar appears when you select something, and the right-click menu appears where you point.

## Format a selection from the toolbar

Select any text and a small toolbar opens just clear of it. It holds, in order:

1. **Edit Markdown**, with **Copy ref** beside it
2. Bold, Italic, Strikethrough, Highlight, Inline code, Link and Clear formatting
3. A **Turn into** menu, for changing what kind of block the lines are

Inside a link, the Link button reads **Edit link** and opens the link's panel, with its words and its address in fields you can change. To take the link off, use **Remove link** on that panel or in the right-click menu, or press Cmd+Shift+K.

From the keyboard, Alt+F10 moves into the toolbar, the arrow keys move along it, and Escape puts you back in the text.

The toolbar stays out of the way where it could not do anything: inside a code block, over front matter, over a selected divider, and over a selection of only spaces.

## See the Markdown you selected

Press **Edit Markdown** on the toolbar, or Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux). It shows the raw Markdown of the block you selected in, so you can see and fix exactly what is written. The toolbar puts itself away when you use it, rather than sitting over the Markdown you asked to see.

Edit Markdown comes first on the toolbar and again at the top of the right-click menu, because it is the one thing in either of them that no other editor gives you.

## Open the right-click menu

Right-click (or Ctrl-click) anywhere in your text. The menu holds:

1. **Edit Markdown**
2. **Copy ref**, and **Send to terminal** under it wherever there is a terminal to send to (not in a browser tab)
3. A **Turn into** menu, for making the lines a heading, a list, a quote or a code block
4. Highlight, Inline code, Link, Clear formatting

Where the click lands adds to the menu:

- On a link: nothing, because a right-click on a link opens its own panel instead, with the words and the address both editable. Copying the address and removing the link are on that panel. See [Links](links.md).
- In a code block: Copy code, which gives you the code without its fences.
- On a task: Mark done or Mark not done.

Anything that cannot apply where you clicked is shown as unavailable rather than quietly missing, so front matter and code blocks both keep the menu's shape.

To open the menu from the keyboard, press Shift+F10. It opens at the caret.

## Format a table cell from either menu

Open a table cell and both menus follow you into it, acting on that cell rather than on the document around it. They hold the same items in the same order, minus **Turn into**: a cell holds one line of text, so a heading marker written into one is a character of the value.

**Edit Markdown** shows the Markdown of the one cell you are in, and every other cell stays rendered. **Copy ref** names the row as the file will hold it, which is the reference the grid's own menu gives you, rather than a line number counted inside the cell.

A `csv` or `tsv` cell holds data instead of Markdown, so right-clicking one gives you your system's own cut, copy and paste menu.

## Turn a block into something else

Choose **Turn into** from the right-click menu or the toolbar, then pick the kind of block.

The submenu checks the kind the block already is. It carries all six heading levels, with a rule after Heading 3 separating the three you reach most often from the deeper ones. Cmd+Alt+1, 2 and 3 set the first three from the keyboard. Levels 4 to 6 have no shortcut, because those numbers already belong to other blocks.

## Copy a reference to what you clicked

Choose **Copy ref** from the right-click menu, or from the toolbar over a selection. It puts the file and line numbers on the clipboard, then the text itself in a fenced block, ready to paste into a chat with an agent. **Send to terminal** hands the same reference straight to the terminal instead. [Sharing a reference](sharing.md) has the details.

## Keys

| Key | Does |
| --- | --- |
| Cmd+Alt+E | Edit Markdown |
| Alt+F10 | Move into the selection toolbar |
| Shift+F10 | Open the right-click menu at the caret |
| Arrow keys | Move along the toolbar, or walk only the menu items you can actually use |
| Home, End | Jump to the first or last menu item |
| Right, Left | Open Turn into, or leave it |
| Escape | Leave the toolbar, or close the menu and put the caret back where it was |
| Cmd+Alt+1, 2, 3 | Turn the block into Heading 1, 2 or 3 |

## Good to know

- Cut, Copy, Paste, Bold, Italic and Strikethrough are not in the right-click menu. Every one of them has a keyboard shortcut you already know, and the last three are on the toolbar that appears the moment you select something, which is when they become useful. Leaving them out makes room for the commands that are specific to Sheaf.
- The right-click menu closes if the document changes while it is open, so an item can never act on text that has moved underneath it.
