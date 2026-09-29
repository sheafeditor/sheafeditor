---
title: Tables
summary: Read and edit a Markdown table as a grid, moving through it with the keys you already use in a spreadsheet.
order: 30
---

# Tables

Every GFM pipe table in your document opens as a grid. You click a cell and type into it, move around with spreadsheet keys, and the file on disk stays ordinary Markdown that GitHub renders the same way.

## Read a table

A table becomes a grid wherever it sits, including below the first screen and on the file's first line. Each grid has a selector column down the left, a corner cell, and a controls bar that appears on hover. The selector column carries row numbers when line numbers are on and is a narrow blank strip when they are off, which is the default; either way, clicking it selects a row and dragging it moves rows.

Every table shape Markdown allows renders: a single cell, a header with no rows, rows without outer pipes, rows shorter than the header, and empty cells. Column alignment set by the `:---`, `:---:` and `---:` delimiter row shows in the cells.

- **A wide table takes the width of the pane.** It starts where your text starts and runs to the pane's right edge, then scrolls sideways inside its own frame, so the page stays still while you look across it. A table that fits your writing column stays in the column with the prose.
- **A long table** keeps its header row at the top of the editor as you scroll down past its top, until the table ends, so you can still see what each column holds.
- **A cell with more than four lines** shows the first four, so one long note does not make its row a screen tall. Hover it to read the rest in a tooltip. Select the cell, or open it to type, and it shows everything; move away and it goes back to four.
- **A column of numbers** draws every digit at the same width, so figures line up down the column.

## Change a value

1. Click a cell to select it.
2. Type to replace what is there. To edit the value instead, double-click the cell, or press Enter or F2, which opens it with the value selected.
3. Press Enter to keep the value, or Escape to leave it as it was.

| Key | What it does |
| --- | --- |
| Enter | Commit and move down |
| Shift+Enter | Commit and move up |
| Tab | Commit and move right, adding a row past the last cell |
| Shift+Tab | Commit and move left |
| Escape | Cancel, leaving the value as it was |
| Cmd+Alt+E | Show this cell's Markdown, and show it rendered again |

A committed edit reaches the file when focus leaves the table, including when you save and when you close the tab. Editing one cell rewrites one line.

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

This shows the one cell you are in, and every other cell stays rendered, which is what makes it useful in a wide table: the markers for the value you are working on, without reading the whole table as pipes. For the whole table's Markdown, use the `</>` button on its toolbar.

## Move around a table

With a cell selected, use the spreadsheet keys in the table under **Keys**. Hold Shift with any of them to extend the selection instead of moving.

A key that would take you out of the table at its edge leaves you where you are and keeps the keyboard in the grid. Whatever you move to is scrolled into view, clear of the header row above it.

## Move in and out of a table

- Press Down on the line above a table to enter its header row.
- Press Up on the line below a table to enter its last row.
- Press Up on the header row, or Down on the last row, to leave the table and carry on in the text. If there is no line below the table to leave onto, Sheaf adds one.

Moving out after an edit writes that edit.

## Undo a change

Press Cmd+Z to take back the last change to the table, and Cmd+Shift+Z to put it back, one step at a time. The toolbar's Undo and Redo buttons do the same as the keys.

Undo walks this visit's table changes in the order you made them, then carries on into the document's own history, so it does not stop at the edge of the grid. An action over several cells, such as clearing a block or filling a selection, is undone in one step.

In an open cell, Cmd+Z first takes back what you typed in that cell. Once there is nothing left to take back there, the cell closes and Cmd+Z carries on into the document. So a change made to the file from outside while the cell was open, one that took back what you had just typed, is undone by the same key.

## Find in a table

Open the find bar and type. Every cell that holds a match is tinted in the same colour as matches in the text, and the cell holding the current match is tinted more strongly.

Press Enter or Shift+Enter in the find field to step through the matches. When one lands in a table, its cell becomes the active cell, with its ring, and the table scrolls to show it, below the header row if that row is held at the top of the editor. The keyboard stays in the find field, so the next Enter goes on to the next match.

This works in pipe tables and in CSV and TSV blocks. A view block's cells are not tinted: a value a view shows is found, and tinted, in the table the view reads from, when that table is in the same document. See [Datatables and views](datatables.md).

## Use a table by touch or pen

Tap a cell to select it, which also brings the table's controls up above the table, and double tap to open the cell for editing. Press and hold to open the table menu, which never opens on top of the cell you are editing. Controls and menu items are at least 40 px tall.

## Use a table with a screen reader

A table is exposed as a grid named by its columns, with cells as gridcells under their column headers. The cell you are on and the cells you have selected are marked as they move, so a screen reader announces position and selection as you navigate.

The cell editor is labelled with its column and row, and a header cell's editor says that it is a header. A grid that has the keyboard shows a visible focus indicator, including when nothing is selected.

## Show a table's Markdown

Press the `</>` button on the table's controls bar. It is the one control that shows a table's Markdown on purpose.

## Keys

| Key | Where it goes |
| --- | --- |
| Arrows | One cell |
| Home, End | Start and end of the row |
| Cmd+arrow | The table's edge in that direction |
| Cmd+Home, Cmd+End | First and last cell |
| Page Up, Page Down | A screenful |
| Tab, Shift+Tab | Next and previous cell, wrapping at a row's ends |
| Shift with any of these | Extends the selection |
| Cmd+Z, Cmd+Shift+Z | Undo, redo |

Rows, columns, sorting and widths have keys of their own: see [Table rows and columns](table-commands.md). Selecting, copying and pasting are on [Selecting and pasting cells](table-selection.md).

## Good to know

- **Opening a file and reading a table never writes to it.** Moving around never changes the file, and moving in and out of a table without editing anything leaves it alone.
- **An edit changes only its own row.** Editing one cell rewrites one line, and the rest of the file is left byte for byte, so the diff shows the row you changed and nothing else. Values that would otherwise break the row, such as a pipe, are escaped on the way to the file and shown unescaped in the grid.
- **A table stays a grid while you work in the text around it.** No click, double-click, triple-click or drag in the surrounding prose turns it into raw Markdown, and neither does any arrow or selection key, including Cmd+A over the whole document. Find leaves the table a grid during the search and after you press Escape, and nothing in the file changes.
- **Revealing syntax skips tables.** With `sheaf.revealSyntaxOnLine` turned on, putting the cursor on the line above or below a table does not reveal the table.
- **CSV and TSV files** open as a grid too, when you choose to: see [Data files](data-files.md#open-a-csv-or-tsv-file-as-a-grid).
