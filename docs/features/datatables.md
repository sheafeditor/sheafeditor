---
title: Datatables and views
summary: Name a CSV block, then show it filtered, sorted and trimmed to the columns you want with a view block.
order: 31
---

# Datatables and views

A CSV or TSV block in your document is already a grid you edit like a spreadsheet (see [Tables](tables.md)). Give it a name, and a view block can show it, or a .csv or .tsv file beside the document, filtered, sorted and trimmed to the columns you care about.

## Name a block

A view finds its table by name. Write the name after the language on the block's opening line:

````
```csv id=tasks
feature,status,estimate
Search,Open,5
Export,Done,2
```
````

The block still draws as a grid, with `#tasks` shown above it.

A block with no name shows **Name this table** above it when you point at it. Take the offer and the name goes onto the block's opening line, as one undo step. Escape writes nothing and leaves the block unnamed.

A name is letters, digits, hyphens and underscores. Each name belongs to one block per document, compared without regard to case. When two blocks share a name, both show an error saying so until one is renamed.

## Rename a block

1. Click the block's `#name`, or press Enter while it has focus.
2. Type the new name and press Enter.

Enter renames the block and every view that reads it by the old name, however that view spelt its case, as one edit and one undo step. Escape leaves the name as it was.

A name with a space or another character a name cannot hold, or a name another block already has, is refused with the reason beside the field. The field stays open so you can fix it.

## Make a view

Use any of these. None needs you to write the query by hand.

- **Create view** on a table's own menu, in the bar above it and in the right-click menu. It writes a view of that table below it, reading the table by name. A table with no name is named first, in the same field the caption offers, and the name and the view are written together. Escape at the name writes neither.
- **View of a table** in the slash menu. It writes a view reading the named table above where you are, so it draws rows at once. With no named table in the document, the `from:` line is left empty for you to fill in.
- Type the view yourself, in the shape under [Write a view by hand](#write-a-view-by-hand).

Everything these write is text you could have typed, so the file reads the same either way, and one undo takes the whole thing back.

Once a view is on the page, you can sort, filter and edit from it: see [Working in a view](views.md).

## Write a view by hand

A view is a fenced block with the language `view`. Each line is a key, a colon and a value:

````
```view
from: #tasks
where: status != Done
sort: estimate desc
show: feature, estimate
```
````

- `from` names the table: `#tasks` for a named block in this document, or a path such as `data/tasks.csv` for a file, relative to the document. See [Data files](data-files.md).
- `where` keeps the rows that meet every condition, separated by semicolons. The operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `is empty` and `is not empty`. A value with a semicolon or quotes in it goes in double quotes.
- `sort` orders the rows by one or more columns, each optionally followed by `asc` or `desc`. Numbers and dates sort the way the grid's own Sort orders them, and empty cells go last.
- `show` lists the columns to show, in the order to show them. Without it the view shows every column.
- `layout` is `table`, the default, or `board`, which shows the rows as cards grouped by the column named in `group`. See [Boards](boards.md#show-a-view-as-a-board).

Column names match the table's header without regard to case. The line above the grid names the table and counts the rows, as in `3 of 4 rows`.

A view can sit inside a blockquote or a list item, like any fenced block, with the quote's `>` or the item's indentation at the start of each line. It is drawn as a view there too, a quoted one with the quote's bar beside it. Anything that rewrites its query, such as a header sort or filter, writes each line with those marks, so the view stays inside the quote or item. A fence that shares its line with a list bullet, as in `- ```view`, is left as text.

## Fix a view that shows an error

Read the error on the view and correct the line it names. Every mistake shows on the view in place, with the line it is on: an unknown key, a condition Sheaf cannot read, a column the table does not have. What can still be drawn is drawn, so a misspelt `sort` column leaves the filter working.

A `from` that finds nothing is an error naming what it looked for: no block with that name, a file that is not there, or a path Sheaf will not read. It is never an empty table that looks like a table with no rows.

## Good to know

- **A name is invisible elsewhere.** Other tools read the first word of a block's opening line as the language and ignore the rest, so on GitHub or in any other editor a named block looks exactly as it did before.
- **A view is its query and nothing else.** Showing or drawing a view never writes to the document or to the table it reads. Off Sheaf the block is a code block showing the query, which tells a reader exactly which table it shows and how.
- **Editing through a view changes the table.** Editing a cell in a view changes that cell in the table it reads, and only the field you edited. A header control writes one line of the query and nothing else. See [Working in a view](views.md).
