---
title: Sharing a reference
summary: Hand the lines you are looking at to an agent, by clipboard or straight to the terminal.
order: 7
---

# Sharing a reference

A coding agent in your editor picks up whatever you have selected in a text editor. It cannot see a selection in Sheaf, because the editor you are typing in is not a text editor as far as the rest of the editor is concerned. So Sheaf hands the selection over itself, two ways.

## Copy ref

**Cmd+Shift+Alt+R** (Ctrl+Shift+Alt+R) puts a reference to what you picked on the clipboard:

```
notes.md:12-18

```
The three lines you selected,
exactly as they are in the file,
fenced so they paste cleanly.
```
```

It is the same thing **Copy ref** in the right-click menu gives you, so use whichever is closer to hand. With nothing selected it names the line your caret is on and quotes that line.

### In a table

A table ref names the lines and then the cells, by the column's header and the row number beside the grid, and quotes what you picked:

| You picked | The ref starts | It quotes |
|---|---|---|
| One cell | `notes.md:24 (Time, row 4)` | The cell's text |
| A block of cells | `notes.md:24-27 (Time to Beacon, rows 4 to 7)` | Those cells, laid out as you picked them |
| A row, by its number | `notes.md:24 (row 4)` | The row's line from the file |
| A column, by its header | `notes.md:12-40 (Beacon column)` | That column's cells |
| The whole table | `notes.md:12-40` | The table from the file |

A column with an empty header is named by its position, as in `column 3`. The row numbers are the ones the grid shows, which count from the first row under the header, so row 4 is the fourth row of data wherever the table sits in the file.

## Send to terminal

**Cmd+Shift+Alt+T** (Ctrl+Shift+Alt+T) types the reference at the prompt of your open terminal and stops:

```
@notes.md#L12-18 
```

Nothing is submitted. The terminal comes forward with the reference sitting in the prompt and the cursor after it, so you can type what you want done and press Enter yourself. An agent running in that terminal reads the reference and opens those lines.

It is also in the right-click menu, beside Copy ref.

With no terminal open, Sheaf says so and does nothing, rather than silently swallowing the key.

## Where they work

Both commands are in the Command Palette, and both keys work, only while a Sheaf editor has focus. In a plain text editor they do not exist, so they cannot shadow anything you have bound there.

Neither command changes your document.
