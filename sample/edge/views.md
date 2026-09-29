# View queries that are wrong

A view's query is text somebody typed, so every way of getting it wrong is a case the block has to explain rather than drawing an empty grid or nothing at all. The working constructs are in [`../views.md`](../views.md).

```csv id=intake
request,team,status
Export to CSV,Platform,Open
Rename a column,Tables,Done
```

A name no block in the document has:

```view
from: #nothing-is-called-this
```

A file that is not beside the document:

```view
from: data/not-here.csv
```

A column the table does not have, to sort by:

```view
from: #intake
sort: priority desc
```

A column the table does not have, to filter by:

```view
from: #intake
where: priority = high
```

A column the table does not have, to group a board by:

```view
from: #intake
layout: board
group: priority
```

A layout that is neither table nor board:

```view
from: #intake
layout: gallery
```

A key that is not a key:

```view
from: #intake
orderby: request
```

No `from:` at all, so there is nothing to show:

```view
where: status = Open
```

An empty query:

```view
```

A `from:` naming the view's own document rather than a table:

```view
from: views.md
```

Two names where one is expected:

```view
from: #intake #other
```
