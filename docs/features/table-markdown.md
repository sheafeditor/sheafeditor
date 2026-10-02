---
title: The Markdown under a table
summary: Format text inside a cell, and see the Markdown a cell or a whole table is written in.
order: 30.4
---

# The Markdown under a table

A grid is a view of ordinary Markdown. The text in a cell is Markdown too, so a word can be bold or a link inside a cell the same way it can in a paragraph, and you can see the markers underneath at any time: for one cell, or for the whole table at once.

## Format text in a cell

Select text inside an open cell and press Cmd+B, Cmd+I, Cmd+E or Cmd+K, or reach for the toolbar and the right-click [menus](menus.md), the same as in the text around the table. On Windows and Linux, use Ctrl in place of Cmd everywhere on this page.

A cell stays rendered while you type in it: bold stays bold, a link stays a link, and the markers are hidden.

- An escaped pipe (`\|`) shows as a pipe, and `<br>` in any casing shows as a line break.
- Markdown escapes and HTML entities show as the character they stand for, so `\*` is an asterisk and `&amp;` is an ampersand.
- Inline code follows CommonMark: a run of backticks opens a code span that only a run of the same length closes, so ``` ``a`b`` ``` shows `` a`b `` as code, and a run with no partner shows as backticks. When the code both starts and ends with a space, one space comes off each end.
- A cell holds one line, so `#`, `- ` and `> ` at the start of one are just those characters.

CJK text, emoji and input-method typing reach the cell as typed, including a composition you begin while a cell is only selected.

A `csv` or `tsv` block is a grid too, and its cells are data: they show and edit as plain text, spaces included, and what you type is what the file gets. `**x**` in a CSV cell is five characters, never bold, and sorting orders by that text.

## See a cell's Markdown

With a cell open, press Cmd+Alt+E to show the Markdown behind it. A cell reading the bold word **start** followed by `. hello world` shows `**start**. hello world`, so you can read the markers and edit them directly. Press Cmd+Alt+E again, or leave the cell, and it renders.

This shows the one cell you are in, and every other cell stays rendered, which is what makes it useful in a wide table.

## Show a table's Markdown

Press the `</>` button on the table's controls bar, or choose **Edit Markdown** from its right-click menu. Either shows the whole table, and leaving it restores the grid. With a cell open, that menu item and its Cmd+Alt+E key show the one cell instead, as **See a cell's Markdown** above describes.

A table you are typing out stays text until it is finished: while it is a header row and a delimiter row with the caret at the end, the next `|` lands on that row rather than under a new grid. Once that row is done the grid is drawn, holding the header you typed and no rows yet.

**A selection never opens a table that is drawn, and never closes one that is open.** Cmd+A before copying, a double-click level with a row, a drag from the paragraph above that overshoots it, and a find match inside a cell all leave the grid exactly as it was. Once a table is showing its Markdown, selecting inside it keeps the pipes, so you can work through them.
