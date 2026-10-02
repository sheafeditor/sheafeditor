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

- **A table stays in your writing column and wraps.** A table of sentences ends where your paragraphs end, its cells two or three lines each. Only a table with too many columns to squeeze in takes the width of the pane, filling it edge to edge and scrolling sideways in its frame so the page stays still.
- **A long table** keeps its header row at the top of the editor as you scroll down past its top, until the table ends, so you can still see what each column holds.
- **A cell with more than four lines** shows the first four, so one long note does not make its row a screen tall. Hover it to read the rest in a tooltip. Select the cell, or open it to type, and it shows everything; move away and it goes back to four. To show a whole row at once, double-click the line at the bottom of that row in the strip down the left of the grid: every cell in the row shows all of its lines, and double-clicking again puts the row back. The line appears while you hover the row, and only on a row that has more to show, so it stays out of the way of clicking the strip to select a row or dragging it to move one. A row you have opened this way goes back to four lines when you next open the document, the way the cell you select does when you move away from it.
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

A committed edit reaches the file when focus leaves the table, including when you save and when you close the tab.

## Format text in a cell

Bold, italic, code and links work inside a cell, and a cell can show you the Markdown it is written in: see [The Markdown under a table](table-markdown.md).

## Move around a table

Spreadsheet keys move you from cell to cell, and into a table and out of it again: see [Moving around a table](table-navigation.md).

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

A whole table can be shown as the pipe text it is written in, and put back: see [The Markdown under a table](table-markdown.md).

## Keys

Every key for moving through a grid is on [Moving around a table](table-navigation.md). Rows, columns, sorting and widths are on [Table rows and columns](table-commands.md), and selecting and pasting on [Selecting and pasting cells](table-selection.md).

## Good to know

- **Opening a file and reading a table never writes to it.** Moving around never changes the file, and moving in and out of a table without editing anything leaves it alone.
- **An edit changes only its own row.** Editing one cell rewrites one line and leaves the rest of the file byte for byte, so the diff shows the row you changed and nothing else. Values that would break the row, such as a pipe, are escaped on the way to the file and shown unescaped in the grid.
- **A table stays a grid while you work in the text around it.** No click, drag, arrow or selection key in the surrounding prose turns it into raw Markdown, find included, and nothing in the file changes.
- **Revealing syntax skips tables.** With `sheaf.revealSyntaxOnLine` turned on, putting the cursor on the line above or below a table does not reveal the table.
- **CSV and TSV files** open as a grid too, when you choose to: see [Data files](data-files.md#open-a-csv-or-tsv-file-as-a-grid).
