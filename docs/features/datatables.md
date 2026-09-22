---
title: Datatables and views
summary: Name a CSV block, then show and edit it filtered, sorted and trimmed to the columns you want with a view block.
order: 31
---

# Datatables and views

A CSV or TSV block in a document is already a grid you edit like a spreadsheet (see [Tables](tables.md)). A view block shows one of those tables, or a .csv or .tsv file beside the document, filtered, sorted and trimmed to the columns you care about. Showing a view never changes the table; editing a cell in one changes that cell in the table.

## Naming a block

A view finds its table by name. Write the name after the language on the block's opening line:

````
```csv id=tasks
feature,status,estimate
Search,Open,5
Export,Done,2
```
````

The block still draws as a grid, with `#tasks` shown above it. Other tools read the first word of that line as the language and ignore the rest, so on GitHub or in any other editor the block looks exactly as it did before.

A name is letters, digits, hyphens and underscores. Each name belongs to one block per document, compared without regard to case. When two blocks share a name, both show an error saying so until one is renamed.

To rename a block, click its `#name`, or press Enter while it has focus, and type the new name. Enter renames the block and every view that reads it by the old name, however that view spelt its case, as one edit and one undo step. A name with a space or another character a name cannot hold, or a name another block already has, is refused with the reason beside the field, and the field stays open so you can fix it. Escape leaves the name as it was.

## Writing a view

A view is a fenced block with the language `view`. Each line is a key, a colon and a value:

````
```view
from: #tasks
where: status != Done
sort: estimate desc
show: feature, estimate
```
````

- `from` names the table: `#tasks` for a named block in this document, or a path such as `data/tasks.csv` for a file, relative to the document.
- `where` keeps the rows that meet every condition, separated by semicolons. The operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `is empty` and `is not empty`. A value with a semicolon or quotes in it goes in double quotes.
- `sort` orders the rows by one or more columns, each optionally followed by `asc` or `desc`. Numbers and dates sort the way the grid's own Sort orders them, and empty cells go last.
- `show` lists the columns to show, in the order to show them. Without it the view shows every column.
- `layout` is `table`, the default, or `board`, which shows the rows as cards grouped by the column named in `group`. See [Board layout](#board-layout).

Column names match the table's header without regard to case. The line above the grid names the table and counts the rows, as in `3 of 4 rows`.

A view can sit inside a blockquote or a list item, like any fenced block, with the quote's `>` or the item's indentation at the start of each line. It is drawn as a view there too, a quoted one with the quote's bar beside it, and anything that rewrites its query, such as a header sort or filter, writes each line with those marks, so the view stays inside the quote or item. A fence that shares its line with a list bullet, as in `- ```view`, is left as text.

## Sorting and filtering from the header

A table view's column headers change the query for you, so you rarely need to type it.

- **Sort.** Click a header to sort by that column A to Z, click again for Z to A, and a third time to stop sorting by it. The header shows an arrow for the way it is sorted. Shift-click a second header to sort by it as well, after the columns already sorted; the arrows are numbered in the order the columns count.
- **Filter.** The small button at the right of a header opens its menu. Pick a condition (is, is not, contains, is empty or is not empty), type a value, and press Enter or **Apply**. A column that already has a condition shows it in the menu, and **Remove filter** takes it away. A filtered column's button stays visible and names its condition.
- **Hide column.** The same menu hides the column from the view. **Show all columns** brings back every column the table has. The last column shown cannot be hidden.

Each of these rewrites one line of the query: `sort:`, `where:` or `show:`, added if the view does not have it yet and taken out when it is left empty. Only the part about that column changes, so the other conditions, sort columns and column names on the line keep the spelling and spacing you wrote them with, and every other line of the query stays as it was. Each change is one step of the document's undo history.

From the keyboard, Tab reaches each header's sort button and menu button, and Enter or Space presses them. The menu takes the keyboard when it opens, Enter in its value box applies the filter, and Escape closes it and puts you back on the header. A screen reader hears each header's name with how it is sorted, and each menu button with the condition its column is filtered by.

## Editing through a view

A view edits the table it shows. Click a cell to pick it and move with the arrow keys; double-click it, or press Enter or F2, to type into it. Enter keeps what you typed, Tab keeps it and moves to the next column, and Escape puts the cell back.

The edit goes to the table the view reads: the named block in the document, or the data file. It changes that one field and nothing else, the same as typing into the table's own grid, so every other line of the table keeps its bytes. An edit to a block is part of the document's undo history. An edit to a file is made in that file, and saved with it when auto-save is on and nobody has unsaved changes there.

**+ New row** under the view starts a row at the bottom of the table. In a filtered view it starts with the values the view's `=` conditions ask for, so `where: status = Open` gives a new row whose status is already Open. The row is added to the table once you type into it; a row you start and leave empty is never written.

A row you edit stays where it is, even when the edit means it no longer matches the view or sorts somewhere else. A row that no longer matches is shown set apart, with a note above the view, until you press **Draw again** or change the query. Sorting a view orders what it shows and never moves the table's own rows.

If a data file changed on disk after the view read it, an edit to it is not written, because it would overwrite what changed. The view says so and shows the file as it now is.

Cmd+Z (Ctrl+Z on Windows and Linux) takes back an edit to a file too, a card moved on a board included. While the view has the keyboard, or an edit through a view was the last thing you did, Cmd+Z takes back the latest edit you made to a file during this visit, and Cmd+Shift+Z puts it back. Once none are left, Cmd+Z carries on into the document's own history. An undo is written the same way as the edit, as the one field it changes, and never over someone else's change: if the file changed after your edit, nothing is written, the view says so, and that edit can no longer be taken back from here.

## Board layout

A board shows each row of the table as a card, in columns by the value of one column of the table:

````
```view
from: #tasks
layout: board
group: status
```
````

Each different value in the `status` column becomes a board column, in the order the values first appear in the table. If any row leaves `status` empty, a last column named **No status** holds those rows. The heading of each board column shows how many cards it holds.

A card's title is the first column the view shows, other than the one it is grouped by. The other columns the view shows are listed under the title, each with its name. The grouping column is left off the card, since the board column already says it.

`where`, `sort` and `show` work on a board as they do on a table. A board shows only the rows `where` keeps, and a value no kept row has gets no column. Within each board column, cards are in the view's `sort` order, or in the table's own order when there is no `sort`.

**Moving a card.** Drag a card to another board column, with the mouse, a pen or a finger. Letting go writes the new value into that row's grouping cell, and nothing else in the table changes. It is the same edit as typing the value into the cell: in a named block it is one step of the document's undo history, and in a data file it is written to the file. Press Escape before letting go to leave the card where it was. Moving a card into **No status** empties the cell.

**From the keyboard.** Tab reaches the board's cards, and the arrow keys move between them: Up and Down within a board column, Left and Right to the nearest card in the next column. **Alt+Right** and **Alt+Left** move the focused card to the next or previous board column, the same keys that move a selected column in a table. Enter or F2 opens the card's title for typing, Tab moves on to its next field, and Escape puts the field back. Double-clicking a field opens it too.

A card you move stays in sight even when its new value means the view's `where` no longer keeps it, set apart until you press **Draw again**, as an edited row does in a table.

A screen reader hears the board as a list of board columns, each a region named by its value and card count, holding cards named by their titles.

A pipe table can be shown as the same board without a view, from its own menu: see [Tables as boards](tables.md#tables-as-boards).

A board cannot yet reorder cards within a column: their order always comes from `sort` or the table. New rows are added from the table layout, or from the table itself. When `group` names a column the table does not have, the view says so and shows the rows as a table instead.

## When something is wrong

Every mistake shows on the view in place, with the line it is on: an unknown key, a condition Sheaf cannot read, a column the table does not have. What can still be drawn is drawn, so a misspelt `sort` column leaves the filter working.

A `from` that finds nothing is an error naming what it looked for: no block with that name, a file that is not there, or a path Sheaf will not read. It is never an empty table that looks like a table with no rows.

## Views of a data file

A view whose `from` is a path reads that .csv or .tsv file. The path is relative to the document and must stay inside the workspace folder, or inside the document's own folder for a document opened outside any workspace. An absolute path is refused, because it would not name the same file for someone else who checks out the repository.

The view follows the file. When it changes on disk, from git or another program, or in another editor in the same window, the view redraws with what the file now holds.

When the file a view names is not there, the view says so, and beside the error offers **Create** with the path, as in **Create data/tasks.csv**. Pressing it writes a new file whose header row is the view's `show` columns, or, with no `show`, the columns its `where` and then its `sort` name, each once and in that order. A missing folder on the way is created too. The view then draws the new, empty table, ready for **+ New row**. A view that names no columns has the button dimmed, saying to add a `show` line first. Create never writes over a file: if one appeared at that path in the meantime, it is left as it is and a note says so. The document itself does not change.

Reading a file for a view needs Sheaf running in VS Code. In a browser tab served from a folder the view says, after a moment, that nothing came back for the file; a view of a named block in the same document works there as it does everywhere.

## Moving a block to a file

A block that has grown past a few hundred rows reads better as a file of its own. **Move to file**, at the end of a CSV or TSV block's menu and its right-click menu, does that in one step:

- The block's rows are written, byte for byte, to a new file beside the document, named from the block's name: `tasks.csv` for ```` ```csv id=tasks ````, or `data.csv` for a block with no name. A TSV block becomes a `.tsv` file. A block inside a list item or a quote is written without the list's indentation or the quote marks, which belong to the document.
- An existing file is never written over. When the name is taken, the next free one is used (`tasks-2.csv`, then `tasks-3.csv`), and a note at the foot of the editor says which.
- Once the file is written, and only then, the block is replaced with a view of it, `from: tasks.csv`, so the page shows the same rows as before. A view that read the block by name, `from: #tasks`, reads the file from then on.

The replacement is one step of the document's undo history. Undoing it brings the block back as it was and leaves the file where it is, so delete the file yourself if you no longer want it. If the file cannot be written, the document is not changed and a note says why.

Nothing moves to a file unless you ask: Sheaf never splits a document's data into another file on its own. Writing the file needs Sheaf running in VS Code, the same as reading one.

## Bringing a file into the document

**Bring inline**, in the line above a view of a file, goes the other way. It replaces the view with a CSV or TSV block holding every row of the file, named from the file: `data/tasks.csv` becomes ```` ```csv id=tasks ````, or `tasks-2` when a block already has that name, and a note says so. The rows come in with the document's line endings.

It is offered only on a view with no `where`, `sort` or `show` and the table layout, because the block shows every row and column of the file as they are, and a view that shows fewer would change what the page shows. On any other view of a file the button is dimmed and says which lines to take out first.

Bringing a file inline deletes nothing: the file stays where it is, and other views of it go on reading it. The change to the document is one undo step.

## What the file holds

A view is its query and nothing else. Drawing it never writes to the document or to the table it reads. A header control writes one line of the query and nothing else, and an edit to a cell writes only the field you edited. Off Sheaf the block is a code block showing the query, which tells a reader exactly which table it shows and how.
