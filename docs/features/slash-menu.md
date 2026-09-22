---
title: Slash menu
summary: Type a slash to insert a heading, a list, a table, a code block or a divider without leaving the keyboard.
order: 3
---

# Slash menu

Type `/` and a menu of blocks opens at the caret. Keep typing to narrow it, move with Up and Down, and press Enter or Tab to insert the highlighted one. The typed query goes with it, so `/h2` followed by Enter leaves you on a second-level heading with nothing to clean up.

Clicking the `+` beside a block's grip opens the same menu.

All six heading levels are there, `/h1` through `/h6`.

## The menu shows what it writes

Each row carries its icon on the left, and on the right the Markdown that picking it writes into the file: `#` for Heading 1, `######` for Heading 6, `- [ ]` for Task list, `|` for Table, `---` for Divider. Your document is Markdown, so those are the characters that land on disk. Read them a few times and you stop needing the menu.

Text and CSV data table show nothing on the right. One writes no markers at all, and the other opens a fenced block with a language on it, which has no single spelling short enough to be worth showing.

The Markdown on the right is there to be read. Typing it does not search for it: `/|` is not how you reach the table, `/table` is.

## Where it opens

The menu opens where a slash could begin a command: at the start of a line, or after a space. Everywhere else a slash is just a slash, so none of these open it:

- a path or a URL, as in `https://example.com` or `src/webview`
- a slash inside a word, as in `and/or`
- anywhere inside inline code, a fenced code block, YAML front matter or an HTML block

## When you mistype

A query that matches nothing keeps the menu open and says so. One backspace back to a matching prefix brings the list straight back, with the first item highlighted and ready for Enter, so a typo costs one keystroke rather than retyping the command.

What does close the menu for good is a sign you have gone back to writing: a leading space, a second space, a new line, or a query long enough that it is no longer a command. Escape closes it too, and leaves what you typed in the file.

## Nothing is written until you pick

While the menu is open, the file holds exactly the characters you typed, `/` included. Picking an item is the first change to your document, and a single Undo takes it back.
