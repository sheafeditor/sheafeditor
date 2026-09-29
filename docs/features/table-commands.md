---
title: Table rows and columns
summary: Add, delete, move, sort, align and resize a table's rows and columns from its bar, its menus or the keyboard.
order: 30.1
---

# Table rows and columns

Everything you do to a table's rows and columns is on its controls bar and in its right-click menu. You can insert, delete, duplicate, move, sort and align them, and set how wide each column is, with the file changing only in the lines each command touches.

## Find a table's commands

Every command a table has is on its own bar as well as in its right-click menu, so nothing is reachable only by right-clicking.

- **The bar** holds icons in groups: insert a row above or below and delete it, then insert a column left or right and delete it. In a pane too narrow for the whole bar, its row and column buttons fold into the overflow, so the bar never wraps or gets cut off.
- **The overflow button** at the end of the bar opens the full list, in the same order as the right-click menu: duplicating and moving rows and columns, sorting a column A to Z or Z to A, aligning a column, padding the columns so they line up in the file, fitting or resetting the column widths, and showing a pipe table as a board.
- **Each column header** has a chevron that shows when you hover the header or select the column. It opens that column's commands and selects the column as it does, so the menu always says what it acts on. Row numbers carry no chevron, because a row number is too narrow to hold one without covering the click that selects the row. The row commands are on the bar and in the right-click menu.

Every command acts on your selection if you have one, and on the row or column of the cell you are in if you do not.

A command that cannot run where you are stays in its place, dimmed. You cannot delete the only column, move the first column left, or align a CSV block, which has nowhere to keep alignment.

To reach the commands from the keyboard, press Alt+F10 inside a table. It moves to the bar, then to the chevron on the current column, then back to the grid. The arrow keys move along the bar and through a menu, and Escape puts you back in the cell you were in.

## Add or delete rows and columns from the keyboard

1. Select whole rows, by their row numbers or with Shift+Space, or whole columns, by their headers or with Ctrl+Space.
2. Press Cmd+Alt+= to insert a row below the selected rows, or a column to the right of the selected columns. Press Cmd+Alt+- to delete them. On Windows and Linux, use Ctrl in place of Cmd everywhere on this page.

The new row or column is selected, so pressing the key again adds another. The keys follow the menu's rules, so they will not delete the only column. With only some cells selected, or a cell open for typing, they do nothing. The right-click menu shows them beside Insert row below, Delete row, Insert column right and Delete column whenever they would act.

## Move rows and columns

1. Select the row or column by its row number or header. Select several to move them together as one block, keeping their order among themselves.
2. Drag the selected row number or header to its new place. It dims as it travels, and a line shows where it will land.

Dragging a row number or header that is not selected marks rows or columns and moves nothing. So selecting by dragging down the row numbers and then dragging them again to move them is two gestures, and the first one is safe.

From the keyboard, Alt+Up and Alt+Down move the selected rows one step, and Alt+Left and Alt+Right move the selected columns. They stay selected, so pressing again moves them further. At the edge of the table the key does nothing.

## Sort a column

Choose **Sort column A to Z** or **Sort column Z to A** from the column's chevron, the overflow menu or the right-click menu. The column sorts the way a person reads it:

- Numbers sort by value, including negative numbers, amounts with a currency sign, and percentages.
- Dates sort as dates. `2044-11-17` always does. A date with slashes, such as `17/11/2044` or `11/17/2044`, does once the column shows which comes first, the day or the month.
- Text sorts ignoring case, by the words a reader sees, ignoring any bold or link markup around them.
- Rows with equal values keep their order, and empty cells stay at the bottom whichever way you sort.

## Resize a column

Drag the right border of a column's header. Only that column changes: the ones beside it keep the width they had, so widening the column you care about does not take the room from all the others. The table grows by what you added, and scrolls sideways in its frame once it is wider than the pane. A column will not go narrower than about six characters: the border stops there, and turns the warning colour while you hold it past that point.

Until you drag one, Sheaf sizes each column to what it holds: a short column keeps its width, and the columns holding sentences share out the rest of the pane. Your first drag fixes every column where it is, which is what lets the one you are dragging move on its own. From then on the table keeps the widths you set rather than following the pane, and **Reset column widths** hands it back.

The table menu has two more commands for widths:

- **Fit columns to content** sets every column to the width of what it holds, so nothing in the table wraps. A table that comes out wider than the pane scrolls sideways in its frame.
- **Reset column widths** puts every column back to the width Sheaf chooses. It is dimmed until a width has been set by hand, so the menu tells you whether one has.

## Show a table as a board

Choose **Show as board** from the table's overflow menu or its right-click menu, and pick the column to group by. Each row becomes a card. See [Boards](boards.md#show-a-pipe-table-as-a-board).

## Keys

| Key | What it does |
| --- | --- |
| Alt+F10 | Move to the bar, then the column's chevron, then back to the grid |
| Shift+Space | Select the row |
| Ctrl+Space | Select the column |
| Cmd+Alt+= | Insert a row below the selected rows, or a column right of the selected columns |
| Cmd+Alt+- | Delete the selected rows or columns |
| Alt+Up, Alt+Down | Move the selected rows |
| Alt+Left, Alt+Right | Move the selected columns |

## Good to know

- **A command changes only the lines it has to.** Sorting changes only the order of the rows in the file: every row keeps its own bytes. A move is a single undo step, and it rewrites only the lines whose order changed.
- **Column widths never go into the file.** A width you set is a view preference. VS Code keeps it for this workspace on this machine, under the document and the table's header row, so it is there when you reopen the file and nobody gets it from the repository.
- **Widths follow the header row.** Renaming a header in the grid keeps the widths. If the header row changes some other way, or a column is added or removed, the table goes back to the widths Sheaf chooses.
- **In a browser tab**, widths last until you close the tab.
