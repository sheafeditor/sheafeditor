---
title: Data files
summary: Open a CSV or TSV file as a grid, show it in a document through a view, and move rows between blocks and files.
order: 31.3
---

# Data files

When a table grows past a few hundred rows, it reads better as a .csv or .tsv file of its own. You can edit that file as a grid, show it in a document through a view, and move rows between a block and a file in one step.

## Open a CSV or TSV file as a grid

1. Right-click the file's tab.
2. Choose **Reopen Editor With**, then **Sheaf (Grid)**.

A `.csv` or `.tsv` file opens in Sheaf as a grid, the whole file and nothing else. Sheaf is an option for these files, and they keep opening wherever they opened before. The same menu takes you back to the text editor.

The grid works like a CSV block in a document: you edit cells, move and sort rows and columns, copy and paste, and undo. See [Tables](tables.md). The formatting toolbar is hidden, since the file is data.

Copy ref names the line the record is on in the file itself, so the header of `data.csv` is `data.csv:1`.

## Show a file in a view

Write the file's path on the view's `from` line, as in `from: data/tasks.csv`. See [Datatables and views](datatables.md#write-a-view-by-hand) for the rest of the query.

The path is relative to the document, and must stay inside the workspace folder, or inside the document's own folder for a document opened outside any workspace. An absolute path is refused, because it would not name the same file for someone else who checks out the repository.

The view follows the file. When it changes on disk, from git or another program, or in another editor in the same window, the view redraws with what the file now holds.

## Create a missing file

When the file a view names is not there, the view says so, and beside the error offers **Create** with the path, as in **Create data/tasks.csv**. Press it.

It writes a new file whose header row is the view's `show` columns. With no `show`, the header is the columns its `where` and then its `sort` name, each once and in that order. A missing folder on the way is created too. The view then draws the new, empty table, ready for **+ New row**.

A view that names no columns has the button dimmed, saying to add a `show` line first.

## Move a block to a file

Choose **Move to file**, at the end of a CSV or TSV block's menu and its right-click menu. In one step:

1. The block's rows are written, byte for byte, to a new file beside the document, named from the block's name: `tasks.csv` for ```` ```csv id=tasks ````, or `data.csv` for a block with no name. A TSV block becomes a `.tsv` file. A block inside a list item or a quote is written without the list's indentation or the quote marks, which belong to the document.
2. Once the file is written, and only then, the block is replaced with a view of it, `from: tasks.csv`, so the page shows the same rows as before. A view that read the block by name, `from: #tasks`, reads the file from then on.

An existing file is never written over. When the name is taken, the next free one is used (`tasks-2.csv`, then `tasks-3.csv`), and a note at the foot of the editor says which.

The replacement is one step of the document's undo history. Undoing it brings the block back as it was and leaves the file where it is, so delete the file yourself if you no longer want it. If the file cannot be written, the document is not changed and a note says why.

## Bring a file into the document

Press **Bring inline**, in the line above a view of a file. It replaces the view with a CSV or TSV block holding every row of the file, named from the file: `data/tasks.csv` becomes ```` ```csv id=tasks ````, or `tasks-2` when a block already has that name, and a note says so. The rows come in with the document's line endings.

It is offered only on a view with no `where`, `sort` or `show` and the table layout, because the block shows every row and column of the file as they are, and a view that shows fewer would change what the page shows. On any other view of a file the button is dimmed and says which lines to take out first.

The change to the document is one undo step.

## Good to know

- **An edit rewrites only the record you changed.** In a file opened as a grid, every other line keeps its bytes, and the file keeps its quoting, its line endings and its byte-order mark if it has one. A file with no newline at its end still has none after you edit it.
- **Large files open as text.** A file of more than 2,000 rows opens with a note saying how many rows it has, and no grid. Use **Reopen Editor With** to edit it as text.
- **Nothing moves to a file unless you ask.** Sheaf never splits a document's data into another file on its own.
- **Create never writes over a file.** If one appeared at that path in the meantime, it is left as it is and a note says so. The document itself does not change.
- **Bringing a file inline deletes nothing.** The file stays where it is, and other views of it go on reading it.
- **Reading and writing files needs VS Code.** Reading a file for a view, and writing one with Move to file, needs Sheaf running in VS Code. In a browser tab served from a folder, the view says, after a moment, that nothing came back for the file. A view of a named block in the same document works there as it does everywhere.
