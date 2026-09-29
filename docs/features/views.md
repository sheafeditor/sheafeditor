---
title: Working in a view
summary: Sort, filter, hide columns and edit cells from a view, and the view writes its query and the table for you.
order: 31.1
---

# Working in a view

A view's column headers change its query for you, so you rarely need to type one. You can also edit the table's cells and add rows straight from the view, and each change goes to the table the view reads.

## Sort a view by a column

Click a column header to sort by that column A to Z. Click again for Z to A, and a third time to stop sorting by it. The header shows an arrow for the way it is sorted.

To sort by more than one column, Shift-click a second header. It sorts by that column as well, after the columns already sorted, and the arrows are numbered in the order the columns count.

## Filter a view by a column

1. Click the small button at the right of a header to open its menu.
2. Pick a condition: is, is not, contains, is empty or is not empty.
3. Type a value, and press Enter or **Apply**.

A column that already has a condition shows it in the menu, and **Remove filter** takes it away. A filtered column's button stays visible and names its condition.

## Hide a column

Open the header's menu and choose **Hide column** to hide it from the view. **Show all columns**, in the same menu, brings back every column the table has. The last column shown cannot be hidden.

## Use the header from the keyboard

Press Tab to reach each header's sort button and menu button, and Enter or Space to press them. The menu takes the keyboard when it opens, Enter in its value box applies the filter, and Escape closes it and puts you back on the header.

A screen reader hears each header's name with how it is sorted, and each menu button with the condition its column is filtered by.

## Edit a cell through a view

1. Click a cell to pick it, and move with the arrow keys.
2. Double-click it, or press Enter or F2, to type into it.
3. Press Enter to keep what you typed, or Tab to keep it and move to the next column. Escape puts the cell back.

The edit goes to the table the view reads: the named block in the document, or the data file. It changes that one field and nothing else, the same as typing into the table's own grid, so every other line of the table keeps its bytes.

A row you edit stays where it is, even when the edit means it no longer matches the view or sorts somewhere else. A row that no longer matches is shown set apart, with a note above the view, until you press **Draw again** or change the query.

## Add a row

Press **+ New row** under the view to start a row at the bottom of the table, and type into it.

In a filtered view the row starts with the values the view's `=` conditions ask for, so `where: status = Open` gives a new row whose status is already Open. The row is added to the table once you type into it. A row you start and leave empty is never written.

## Undo an edit

Press Cmd+Z to take back an edit, and Cmd+Shift+Z to put it back. On Windows and Linux, use Ctrl in place of Cmd.

An edit to a named block is part of the document's undo history. An edit to a file can be taken back too, a card moved on a board included. While the view has the keyboard, or an edit through a view was the last thing you did, Cmd+Z takes back the latest edit you made to a file during this visit. Once none are left, Cmd+Z carries on into the document's own history.

An undo is written the same way as the edit, as the one field it changes, and never over someone else's change. If the file changed after your edit, nothing is written, the view says so, and that edit can no longer be taken back from here.

## Good to know

- **A header control rewrites one line of the query.** Sorting, filtering and hiding change the `sort:`, `where:` or `show:` line, adding it if the view does not have it yet and taking it out when it is left empty. Only the part about that column changes, so the other conditions, sort columns and column names on the line keep the spelling and spacing you wrote them with, and every other line of the query stays as it was. Each change is one step of the document's undo history.
- **Sorting a view never moves the table's rows.** It orders what the view shows.
- **An edit to a file is saved with that file.** It is made in the file, and saved with it when auto-save is on and nobody has unsaved changes there.
- **A file that changed on disk is never overwritten.** If a data file changed on disk after the view read it, an edit to it is not written, because it would overwrite what changed. The view says so and shows the file as it now is.
