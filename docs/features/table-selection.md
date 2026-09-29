---
title: Selecting and pasting cells
summary: Select a block of cells or scattered ones, then clear, fill, copy, cut and paste them, to and from a spreadsheet.
order: 30.2
---

# Selecting and pasting cells

You select cells in a table the way you do in a spreadsheet, then clear, fill, copy or paste across all of them at once. Copied cells paste straight into a spreadsheet, and a range copied from one pastes into the grid or becomes a new table.

## Select a block of cells

- Click, Shift-click or drag to mark a rectangular block.
- Click a column header to take the column, or a row number to take the row.
- Click the corner cell, or press Cmd+A inside the grid, to take the whole table. On Windows and Linux, use Ctrl in place of Cmd everywhere on this page.
- Hold Shift with the arrow keys to extend the selection.

As in a spreadsheet, the cell a drag or Shift-click starts from stays the active cell, the one typing replaces, and Shift with the arrow keys moves the far corner of the block.

Every marked cell is drawn in the selection colour. The row numbers and column headers stay as they are, so they never look like links or like more cells selected.

Press Escape to clear the selection and leave the keyboard in the grid. Clicking out into the text leaves no highlight or focus ring behind on the table.

## Pick scattered cells

When the cells you want are not next to each other, Cmd-click each one to add it to the selection. Cmd-click a cell already picked to take it back out.

Picked cells are drawn as picked and the cells between them are drawn as not, so what the next keystroke will hit is visible. Delete, fill and copy act on exactly the cells you picked and nothing between them.

Press Escape to clear every pick. Cmd+A replaces the picks with the whole table.

## Clear cells

Select the cells and press Backspace or Delete. Every marked cell is cleared, and only their lines change.

**Emptying a whole column keeps its name.** Select a column by its header and press Delete: the values go and the name stays. A column's name is how the rest of the document refers to it, so a view that shows, sorts or groups by that column goes on working. To clear the name as well, select the header cell on its own, with Up from the first row of the column, and press Delete. In a table with no rows there is nothing to tell the two apart, so the name clears.

## Fill cells with one value

Copy a single value, select the cells, and paste. The value fills every cell in the selection.

## Copy and cut cells

Select the cells and press Cmd+C, or Cmd+X to cut. The selection goes on the clipboard twice over: as tab-separated text, which spreadsheets read, and as an HTML table, which rich editors read.

Cut followed by undo brings the cells back and leaves them on the clipboard.

## Paste into a table

Select the cell where the block should start and press Cmd+V. The paste starts at the top-left of the selection and grows the table by whatever rows and columns it needs.

Pasted text is split into cells on tabs and newlines only, so a sentence with commas, or a value in quotes, stays in one cell. A spreadsheet cell holding a line break arrives in quotes and stays one cell: in a pipe table its lines are joined by a space, and in a CSV block the line break is kept.

## Paste a spreadsheet range as a new table

Copy a range from a spreadsheet and paste it into the page, outside any table. It becomes a new table:

- The table goes on a block of its own, after the paragraph you are in.
- It is written with its columns lined up in the file, and a column of numbers aligned right.
- A spreadsheet cell holding a line break stays one cell, with its lines joined by a space.
- It opens on its first header cell, and one Cmd+Z takes the whole paste back.

A single column of lines is pasted as text, since one column is a list.

## Good to know

- **Selecting never writes the file.** Selecting by any of these gestures never moves a row or a column. Dragging a row number or header that is already selected moves it: see [Table rows and columns](table-commands.md#move-rows-and-columns).
- **One action, one undo.** Undo puts back everything a clear or a fill across several cells changed, in a single step, scattered picks included. See [Tables](tables.md#undo-a-change) for how undo moves through a table.
