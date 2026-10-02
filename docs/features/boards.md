---
title: Boards
summary: Show a table's rows as cards in columns grouped by one value, and move a card to change that value.
order: 31.2
---

# Boards

A board shows each row of a table as a card, in columns by the value of one column you pick. It suits a table of tasks with a status column, where you want to see what is in each state and move things along. Moving a card writes its new value into the table.

## Show a pipe table as a board

1. Choose **Show as board** from the table's overflow menu or its right-click menu.
2. A small menu lists the table's columns and asks which one to group by. Pick one.

The table draws as a board. Each different value in that column becomes a board column, in the order the values first appear in the table. Rows that leave it empty go in a last column named after it, such as **No Status**. A card's title is the first column other than the one you grouped by, and the other columns are listed under it by name.

## Show a view as a board

Press **Show as board** above a view. It asks which column to group the cards by, and writes two lines into the view's query:

````
```view
from: #tasks
layout: board
group: status
```
````

A view you made from the menu and one you typed are the same file. CSV and TSV blocks are shown as boards this way, through a view: see [Datatables and views](datatables.md#make-a-view).

Each different value in the `status` column becomes a board column, in the order the values first appear in the table. If any row leaves `status` empty, a last column named **No status** holds those rows. The heading of each board column shows how many cards it holds.

A card's title is the first column the view shows, other than the one it is grouped by. The other columns the view shows are listed under the title, each with its name. The grouping column is left off the card, since the board column already says it.

`where`, `sort` and `show` work on a board as they do on a table. A board shows only the rows `where` keeps, and a value no kept row has gets no column. Within each board column, cards are in the view's `sort` order, or in the table's own order when there is no `sort`.

## Move a card

Drag a card to another board column, with the mouse, a pen or a finger. The card comes with you, and a dashed outline shows where it will land: in the column under the pointer, between the two cards you are between. Where it came from holds its place, so nothing shifts under your hand. Carry it past the edge of a board too wide for its pane and the board scrolls to bring the next columns over.

Let go outside every column, or press Escape before letting go, and the card returns to where it was and nothing is written.

From the keyboard, give a card the keyboard and press **Alt+Right** or **Alt+Left** to move it to the next or previous board column. These are the same keys that move a selected column in a table.

Letting go writes the new value into that row's cell in the grouping column, and nothing else in the table changes. It is the same edit as typing the value into the cell. Moving a card into the empty-value column, such as **No status**, empties the cell.

Press Cmd+Z to take a move back. On Windows and Linux, use Ctrl in place of Cmd. On a pipe table, one Cmd+Z takes it back. On a view of a named block, the move is one step of the document's undo history. On a view of a data file, it is written to the file, and undone as described in [Working in a view](views.md#undo-an-edit).

On a view, a card you move stays in sight even when its new value means the view's `where` no longer keeps it. It is set apart until you press **Draw again**, as an edited row is in a table view.

## Move between cards

The arrow keys move between cards. On a view's board, Tab reaches the cards, Up and Down move within a board column, and Left and Right move to the nearest card in the next column.

## Edit a card

On a view's board:

1. Press Enter or F2 to open the focused card's title for typing, or double-click any field.
2. Press Tab to move on to the card's next field.
3. Press Escape to put the field back.

## Switch back to a table

Press **Show as table**. On a pipe table it is on the board's bar and in its menus, and the same menus have **Group by another column**, which asks for the column again. On a view it is the control above the board, and it takes both lines out of the query, because a board with no grouping is an error.

A board has no cells to select, so the row and column commands are on the grid only.

## Keys

| Key | What it does |
| --- | --- |
| Arrow keys | Move between cards |
| Alt+Right, Alt+Left | Move the focused card to the next or previous board column |
| Escape | While dragging, leave the card where it was |
| Enter, F2 | On a view's board, open the card's title for typing |
| Tab | On a view's board, reach the cards, or move to a card's next field |

## Good to know

- **A pipe table's board is a view preference.** Which table is a board, and what it is grouped by, is kept the way column widths are: never in the file, kept by VS Code for this workspace on this machine, under the document and the table's header row. The table is still a board when you reopen the file.
- **A pipe table goes back to a grid when its header changes.** If the header row changes while the file is closed, the table opens as a grid again. If the grouping column is renamed or removed while you have it open, the table goes back to a grid and a note above it says why.
- **In a browser tab**, a pipe table's board lasts as long as the page, and is gone when you reload or close the tab.
- **A view's board is written in its query**, as the `layout` and `group` lines, so it travels with the file.
- **A pipe table's cards draw Markdown; a view's cards show the field as written.** A `[guide](https://example.com)` on a pipe table's card is a link you can click. The same text in a CSV or TSV block is a value, so its card shows the brackets and the address, exactly as that block's own grid does. See [Datatables and views](datatables.md#good-to-know).
- **Cards keep their order.** A board cannot yet reorder cards within a column: their order always comes from `sort` or the table.
- **New rows come from the table.** Add them from the view's table layout, or from the table itself.
- **A missing grouping column shows the table.** When `group` names a column the table does not have, the view says so and shows the rows as a table instead.
- **Screen readers** hear a view's board as a list of board columns, each a region named by its value and card count, holding cards named by their titles.
