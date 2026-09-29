# Views and boards

A view shows a table somewhere else in the document, or in a file beside it, sorted and filtered without touching the table itself. A board is the same view drawn as columns of cards. Both are written as a fenced block, so a reader without Sheaf sees the query rather than nothing.

Sibling of [`tables.md`](tables.md), which covers the grids these read from.

## A named table for views to read

A view reads a table by the name on its fence line. Without a name there is nothing to point at, which is why the table menu offers to give one.

```csv id=intake
request,team,status,estimate
Export to CSV,Platform,Open,5
Rename a column,Tables,In progress,2
Undo a board drag,Tables,Done,3
Dark theme contrast,Design,Open,1
Keyboard for the toolbar,Access,In progress,8
Footnote hover card,Prose,Done,2
Filter by date,Tables,Open,13
Read-only documents,Platform,Done,1
```

## The same table as a view

Sorted by one column, filtered by another, and showing three of the four. The table above is untouched; everything here lives in the query.

```view
from: #intake
where: status != Done
sort: estimate desc
show: request, team, estimate
```

## The same view as a board

One line different: `layout: board` with the column to group by. Every card is a row of the table above, and dragging one between columns writes that row's `status` cell and nothing else.

```view
from: #intake
layout: board
group: status
```

## A board of a filtered view

Grouping and filtering together, so a column can be empty and still show.

```view
from: #intake
where: team = Tables
layout: board
group: status
```

## A view of a file beside this one

`from:` takes a path as well as a name, which is how a table too long to read in a document still gets a view. [`data/releases.csv`](data/releases.csv) opens in its own grid as well.

```view
from: data/releases.csv
where: channel = stable
sort: version desc
show: version, shipped, notes
```

## A pipe table a view can read

A pipe table is named the same way, and the name goes above it rather than on a fence line it does not have.

| owner | open | done |
| :--- | ---: | ---: |
| Platform | 1 | 1 |
| Tables | 2 | 1 |
| Design | 1 | 0 |
| Access | 1 | 0 |

Queries that are wrong in one way or another live in [`edge/views.md`](edge/views.md), with the rest of the input worth being careful about.
