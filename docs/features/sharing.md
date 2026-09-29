---
title: Sharing a reference
summary: Hand the lines you are looking at to an agent, by clipboard or straight to the terminal.
order: 7
---

# Sharing a reference

You can hand a coding agent the lines you are looking at, by clipboard or straight to its terminal. An agent picks up whatever you have selected in a text editor, and it cannot see a selection in Sheaf, so Sheaf hands the selection over itself.

The agent misses the selection because, as far as the rest of your editor is concerned, the editor you are typing in is not a text editor.

## Copy a reference

1. Select the lines you want. With nothing selected, the reference names the line your caret is on and quotes that line.
2. Press Cmd+Shift+C (Ctrl+Shift+C on Windows and Linux). You can also press the button beside Edit Markdown on the toolbar that floats over a selection, or choose **Copy ref** from the right-click menu. All three do the same thing, so use whichever is closer to hand.
3. Paste it to the agent. The clipboard holds the file and lines, then the text itself:

````
notes.md:12-18

```
The three lines you selected,
exactly as they are in the file,
fenced so they paste cleanly.
```
````

Cmd+Shift+Alt+R, the key earlier versions used, still works.

## Copy a reference to table cells

Pick cells, a row or a column in the grid and copy a reference the same way. A table reference names the lines and then the cells, by the column's header and the row number beside the grid, and quotes what you picked:

| You picked | The reference starts | It quotes |
|---|---|---|
| One cell | `notes.md:24 (Time, row 4)` | The cell's text |
| A block of cells | `notes.md:24-27 (Time to Beacon, rows 4 to 7)` | Those cells, laid out as you picked them |
| A row, by its number | `notes.md:24 (row 4)` | The row's line from the file |
| A column, by its header | `notes.md:12-40 (Beacon column)` | That column's cells |
| The whole table | `notes.md:12-40` | The table from the file |

A column with an empty header is named by its position, as in `column 3`. The row numbers are the ones the grid shows, which count from the first row under the header, so row 4 is the fourth row of data wherever the table sits in the file.

## Send a reference to the terminal

1. Select the lines you want.
2. Press Cmd+Shift+Alt+T (Ctrl+Shift+Alt+T on Windows and Linux), or choose it from the right-click menu, beside Copy ref. Sheaf types the reference at the prompt of your open terminal and stops:

```
@notes.md#L12-18 
```

3. Type what you want done and press Enter yourself.

Nothing is submitted for you. The terminal comes forward with the reference sitting in the prompt and the cursor after it. An agent running in that terminal reads the reference and opens those lines.

With no terminal open, Sheaf says so and does nothing, so the key is never silently swallowed.

## Keys

| Key | Does |
|---|---|
| Cmd+Shift+C | Copy a reference to what you picked |
| Cmd+Shift+Alt+R | The same, the key earlier versions used |
| Cmd+Shift+Alt+T | Send a reference to the terminal's prompt |

## Good to know

- Both commands are in the Command Palette, and both keys work, only while a Sheaf editor has focus. In a plain text editor they do not exist, so they cannot shadow anything you have bound there.
- Cmd+Shift+C opens an external terminal elsewhere in VS Code. In a Sheaf editor it copies a reference, and everywhere else it still opens the terminal.
- Neither command changes your document.
