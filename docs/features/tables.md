---
title: Tables
summary: Read and edit Markdown tables as a grid, with spreadsheet keys, selection, copy and paste.
order: 30
---

# Tables

Every GFM pipe table in a Markdown file opens as a grid. You click a cell and type into it, move around with the keys you already use in a spreadsheet, and the file on disk stays ordinary Markdown that GitHub renders the same way.

## Reading a table

A table becomes a grid wherever it sits in the document, including below the first screen and on the first line of the file. Each grid has a row-number column down the left, a corner cell, and a controls bar that appears when you hover it.

Every table shape Markdown allows renders: a single cell, a header with no rows, rows without outer pipes, rows shorter than the header, and empty cells. Column alignment set by the `:---`, `:---:` and `---:` delimiter row shows in the cells.

A table wider than the page scrolls sideways inside its own frame, so the page itself stays still while you look across it.

When you scroll down past the top of a long table, its header row stays at the top of the editor until the table ends, so you can still see what each column holds.

A cell with more than four lines of text shows the first four, so one long note does not make its whole row a screen tall. Hover the cell to read all of it in a tooltip. The cell shows everything once you select it or open it to type, and goes back to four lines when you move away. Columns of numbers draw every digit at the same width, so figures line up down the column.

Opening a file and reading a table never writes to it.

## Column widths

Sheaf sizes each column to what it holds: a short column keeps its width, and the columns holding sentences share out the rest of the pane.

To set a column's width yourself, drag the right border of its header. The column keeps that width and the other columns divide what is left. A column will not go narrower than about six characters: the border stops there, and turns the warning colour while you hold it past that point.

The table menu has two commands for widths. **Fit columns to content** sets every column to the width of what it holds, so nothing in the table wraps, and a table that comes out wider than the pane scrolls sideways in its frame. **Reset column widths** puts every column back to the width Sheaf chooses. It is dimmed until a width has been set by hand, so the menu tells you whether one has.

A width you set is a view preference and never goes into the file. VS Code keeps it for this workspace on this machine, under the document and the table's header row, so it is there when you reopen the file and nobody gets it from the repository. Renaming a header in the grid keeps the widths. If the header row changes some other way, or a column is added or removed, the table goes back to the widths Sheaf chooses. In a browser tab, widths last until you close the tab.

## Tables as boards

A pipe table can be shown as a board: each row becomes a card, in columns by the value of one column you pick. It suits a table of tasks with a status column, where you want to see what is in each state and move things along.

Choose **Show as board** from the table's overflow menu or its right-click menu. A small menu lists the table's columns and asks which one to group by. Pick one and the table draws as a board. Each different value in that column becomes a board column, in the order the values first appear in the table, and rows that leave it empty go in a last column named after it, such as **No Status**. A card's title is the first column other than the one you grouped by, and the other columns are listed under it by name.

Drag a card to another board column to move it, with the mouse, a pen or a finger, or give a card the keyboard and press **Alt+Right** or **Alt+Left**. The arrow keys move between cards. Moving a card writes the new value into that row's cell in the grouping column and changes nothing else in the table, the same edit as typing the value into the cell, and one Cmd+Z (Ctrl+Z on Windows and Linux) takes it back. Moving a card into the empty-value column empties the cell. Press Escape before letting go of a dragged card to leave it where it was.

**Show as table**, on the board's bar and in its menus, puts the grid back. The same menus have **Group by another column**, which asks again. A board has no cells to select, so the row and column commands are on the grid only.

Which table is a board, and what it is grouped by, is a view preference kept the way column widths are: never in the file, kept by VS Code for this workspace on this machine, under the document and the table's header row, so the table is still a board when you reopen the file. If the header row changes while the file is closed, the table opens as a grid again. If the column a board is grouped by is renamed or removed while you have it open, the table goes back to a grid and a note above it says why. In a browser tab, a board lasts until you close the tab.

CSV and TSV blocks are shown as boards through a view instead: see [Board layout](datatables.md#board-layout).

## The table's commands

Every command a table has is on its own bar as well as in its right-click menu, so nothing is reachable only by right-clicking.

The bar holds icons in groups: insert a row above or below and delete it, then insert a column left or right and delete it. After them an overflow button opens the full list, in the same order as the right-click menu: duplicating and moving rows and columns, sorting a column A to Z or Z to A, aligning a column, padding the columns so they line up in the file, fitting or resetting the column widths, and showing a pipe table as a board. Every command acts on your selection if you have one, and on the row or column of the cell you are in if you do not.

Each column header has a chevron that shows when you hover the header or select the column. It opens that column's commands and selects the column as it does, so the menu always says what it acts on. Row numbers carry no chevron: a row number is too narrow to hold one without covering the click that selects the row, and the row commands are on the bar and in the right-click menu.

A command that cannot run where you are stays in its place, dimmed, instead of disappearing. You cannot delete the only column, move the first column left, or align a CSV block, which has nowhere to keep alignment.

In a pane too narrow for the whole bar, its row and column buttons fold into the overflow rather than wrapping or being cut off.

From the keyboard, Alt+F10 inside a table moves to the bar, then to the chevron on the current column, then back to the grid. The arrow keys move along the bar and through a menu, and Escape puts you back in the cell you were in.

With whole rows selected, by their row numbers or with Shift+Space, Cmd+Alt+= inserts a row below them and Cmd+Alt+- deletes them. With whole columns selected, by their headers or with Ctrl+Space, the same keys insert a column to the right and delete the columns. The new row or column is selected, so pressing the key again adds another. The keys follow the menu's rules, so they will not delete the only column, and with only some cells selected, or a cell open for typing, they do nothing. The right-click menu shows them beside Insert row below, Delete row, Insert column right and Delete column whenever they would act. Use Ctrl+Alt in place of Cmd+Alt on Windows and Linux.

## Changing a value

Click a cell to select it, then type to replace what is there. To edit rather than replace, double-click the cell, or press Enter or F2, which opens it with the value selected.

| Key | What it does |
| --- | --- |
| Enter | Commit and move down |
| Shift+Enter | Commit and move up |
| Tab | Commit and move right, adding a row past the last cell |
| Shift+Tab | Commit and move left |
| Escape | Cancel, leaving the value as it was |

A cell stays rendered while you type in it. Bold stays bold, a link stays a link, and Cmd+B, Cmd+I, Cmd+E and Cmd+K (Ctrl on Windows and Linux) apply to the selection inside the cell, the same as in the text around the table. A cell holds one line, so `#`, `- ` and `> ` at the start of one are just those characters.

A committed edit reaches the file when focus leaves the table, including when you save and when you close the tab.

Editing one cell rewrites one line. The rest of the file is left byte for byte, so the diff shows the row you changed and nothing else. Values that would otherwise break the row, such as a pipe, are escaped on the way to the file and shown unescaped in the grid.

## Moving around a table

With a cell selected, the keys are the spreadsheet ones.

| Key | Where it goes |
| --- | --- |
| Arrows | One cell |
| Home, End | Start and end of the row |
| Cmd+arrow | The table's edge in that direction |
| Cmd+Home, Cmd+End | First and last cell |
| Page Up, Page Down | A screenful |
| Tab, Shift+Tab | Next and previous cell, wrapping at a row's ends |

Hold Shift with any of them to extend the selection instead of moving. A key that would take you out of the table at its edge leaves you where you are and keeps the keyboard in the grid. Whatever you move to is scrolled into view with the row numbers still readable, and moving around never changes the file.

Use Ctrl in place of Cmd on Windows and Linux.

## Moving in and out

Press Down on the line above a table to enter its header row, and Up on the line below to enter its last row. Press Up on the header row or Down on the last row to leave the table and carry on in the text. If there is no line below the table to leave onto, Sheaf adds one.

Moving in and out without editing anything leaves the file alone. Moving out after an edit writes that edit.

## Selecting cells

Click, Shift-click or drag to mark a rectangular block. Click a column header to take the column, a row number to take the row, the corner cell to take the whole table, and Cmd+A inside the grid to take the table. Shift with the arrow keys extends the selection. As in a spreadsheet, the cell a drag or Shift-click starts from stays the active cell, the one typing replaces, and Shift with the arrow keys moves the far corner of the block.

Every marked cell is drawn in the selection colour, and the row numbers and column headers the block spans are marked with it, so you can see the extent of the selection without counting.

Backspace or Delete clears every marked cell and changes only their lines. Escape clears the selection and leaves the keyboard in the grid. Clicking out into the text leaves no highlight or focus ring behind on the table.

Selecting by any of these gestures never moves a row or a column and never writes the file.

## Picking scattered cells

When the cells you want are not next to each other, Cmd-click adds a cell to the selection, and Cmd-click on a cell already picked takes it back out. Picked cells are drawn as picked and the cells between them are drawn as not, so what the next keystroke will hit is visible.

Delete, fill and copy act on exactly the cells you picked and nothing between them, and undo puts back everything one of those actions changed in a single step. Escape clears every pick, and Cmd+A replaces the picks with the whole table.

## Moving rows and columns

Drag a row number, or a column header, that is already selected, and the row or column moves. It dims as it travels and a line shows where it will land.

Select several rows or columns first and they move together as one block, keeping their order among themselves.

Dragging a row number or header that is *not* selected marks rows or columns instead of moving anything, and writes nothing. So selecting by dragging down the row numbers and then dragging them again to move is two gestures, and the first one is safe.

A move is a single undo step, and it rewrites only the lines whose order changed.

## Copy and paste

Copying a selection puts it on the clipboard twice over: as tab-separated text, which spreadsheets read, and as an HTML table, which rich editors read.

Pasting a block starts at the top-left of the selection and grows the table by whatever rows and columns it needs. Pasted text is split into cells on tabs and newlines only, so a sentence with commas, or a value in quotes, stays in one cell. A spreadsheet cell holding a line break arrives in quotes and stays one cell: in a pipe table its lines are joined by a space, and in a CSV block the line break is kept. Paste a single value over a selection to fill every cell in it.

A range copied from a spreadsheet and pasted into the page, outside any table, becomes a new table. A spreadsheet cell holding a line break stays one cell, with its lines joined by a space.

Cut followed by undo brings the cells back and leaves them on the clipboard.

## Undo

Cmd+Z takes back the last change to the table and Cmd+Shift+Z puts it back, one step at a time. Undo walks this visit's table changes in the order you made them and then carries on into the document's own history, so it does not stop at the edge of the grid.

An action over several cells, such as clearing a block or filling a selection, is undone in one step. The toolbar's Undo and Redo buttons do the same as the keys.

In an open cell, Cmd+Z first takes back what you typed in that cell. Once there is nothing left to take back there, the cell closes and Cmd+Z carries on into the document, so a change made to the file from outside while the cell was open, one that took back what you had just typed, is undone by the same key.

## What a cell can hold

A cell renders the inline Markdown inside it, with the markers hidden: bold, italic, strikethrough, inline code and links. An escaped pipe (`\|`) shows as a pipe, and `<br>` in any casing shows as a line break. Markdown escapes and HTML entities show as the character they stand for, so `\*` is an asterisk and `&amp;` is an ampersand.

Inline code follows CommonMark: a run of backticks opens a code span that only a run of the same length closes, so ``` ``a`b`` ``` shows `` a`b `` as code, and a run with no partner shows as backticks. When the code both starts and ends with a space, one space comes off each end.

CJK text, emoji and input-method typing reach the cell as typed, including a composition you begin while a cell is selected rather than open.

A `csv` or `tsv` block is a grid too, and its cells are data rather than Markdown: they show and edit as plain text, exactly as written, spaces included, and what you type is what the file gets. `**x**` in a CSV cell is five characters, never bold, and sorting orders by that text.

## Screen readers

A table is exposed as a grid named by its columns, with cells as gridcells under their column headers. The cell you are on and the cells you have selected are marked as they move, so a screen reader announces position and selection as you navigate.

The cell editor is labelled with its column and row, and a header cell's editor says that it is a header. A grid that has the keyboard shows a visible focus indicator, including when nothing is selected.

## Touch and pen

Tap a cell to select it and double tap to open it for editing. Press and hold opens the table menu, and never on top of the cell you are editing. On a touch screen or with a pen, the controls and menu items are at least 40 px tall.

## Finding in a table

With the find bar open, every cell that holds a match is tinted in the same colour as matches in the text, and the cell holding the current match is tinted more strongly. Enter and Shift+Enter in the find field step through the matches. When one lands in a table, its cell becomes the active cell, with its ring, and the table scrolls to show it, below the header row if that row is held at the top of the editor. The keyboard stays in the find field, so the next Enter goes on to the next match.

This works in pipe tables and CSV and TSV blocks. A view block's cells are not tinted: a value a view shows is found, and tinted, in the table the view reads from, when that table is in the same document.

## Tables stay grids

A table stays a grid while you work in the text around it. No click, double-click, triple-click or drag in the surrounding prose turns it into raw Markdown, and neither does any arrow or selection key, including Cmd+A over the whole document. Find leaves the table a grid during the search and after you press Escape, and nothing in the file changes.

With `sheaf.revealSyntaxOnLine` turned on, putting the cursor on the line above or below a table does not reveal the table.

One control shows a table's Markdown on purpose: the `</>` button on the controls bar.

## CSV and TSV files

A `.csv` or `.tsv` file opens in Sheaf as a grid, the whole file and nothing else. Sheaf is an option for these files, and they keep opening wherever they opened before. To use the grid, right-click the file's tab, choose **Reopen Editor With**, then **Sheaf (Grid)**. The same menu takes you back to the text editor.

The grid works like a CSV block in a document: you edit cells, move and sort rows and columns, copy and paste, and undo. The formatting toolbar is hidden, since the file is data.

An edit rewrites only the record you changed. Every other line keeps its bytes, and the file keeps its quoting, its line endings and its byte-order mark if it has one. A file with no newline at its end still has none after you edit it.

Copy ref names the line the record is on in the file itself, so the header of `data.csv` is `data.csv:1`.

A file of more than 2,000 rows opens with a note saying how many rows it has, and no grid. Use **Reopen Editor With** to edit it as text.
