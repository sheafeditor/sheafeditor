# Size floors

Entry points that exist only to be measured, by `node scripts/check-bundle-size.mjs --floors`.

Each holds the smallest set of imports that reaches a particular layer, so the cost of that layer is a
number rather than an estimate. They are built with the same esbuild settings as the editor and
nothing in the product imports them.

They exist because a budget argued from the editor's own size cannot tell you whether the budget is
reachable. The editor is 407 KB gzipped and nobody could say, before these, how much of that was
CodeMirror, how much was the Markdown language layer and how much was Sheaf.
