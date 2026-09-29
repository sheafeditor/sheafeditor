---
title: Slash menu
summary: Type a slash to insert a heading, a list, a table, a code block or a divider without leaving the keyboard.
order: 3
---

# Slash menu

Type `/` and a menu of blocks opens at the caret. You pick a heading, a list, a table, a code block or a divider by typing a few letters, and your hands never leave the keyboard.

## Insert a block

1. At the start of a line, or after a space, type `/`.
2. Keep typing to narrow the list, as in `/h2` or `/table`.
3. Move with Up and Down if the one you want is not highlighted.
4. Press Enter or Tab to insert it.

The typed query goes with it, so `/h2` followed by Enter leaves you on a second-level heading with nothing to clean up. All six heading levels are there, `/h1` through `/h6`.

Pressing the **+** beside a block's grip opens the same menu. See [Add a block below](blocks.md#add-a-block-below).

## Read the Markdown each item writes

Each row carries its icon on the left, and on the right the Markdown that picking it writes into the file: `#` for Heading 1, `######` for Heading 6, `- [ ]` for Task list, `|` for Table, `---` for Divider. Your document is Markdown, so those are the characters that land on disk. Read them a few times and you stop needing the menu.

Text and CSV data table show nothing on the right. Text writes no markers at all, and CSV data table opens a fenced block with a language on it, which has no single spelling short enough to be worth showing.

The Markdown on the right is there to be read. Typing it does not search for it: `/|` is not how you reach the table, `/table` is.

## Fix a typo in the query

Press Backspace. A query that matches nothing keeps the menu open and says so. One backspace back to a matching prefix brings the list straight back, with the first item highlighted and ready for Enter, so a typo costs one keystroke rather than retyping the command.

## Close the menu

Press Escape. The menu closes and leaves what you typed in the file.

The menu also closes for good at any sign you have gone back to writing: a leading space, a second space, a new line, or a query long enough that it is no longer a command.

## Keys

| Key | Does |
| --- | --- |
| `/` | Open the menu, at the start of a line or after a space |
| Up, Down | Move through the list |
| Enter or Tab | Insert the highlighted block |
| Backspace | Shorten the query |
| Escape | Close the menu and keep what you typed |

## Good to know

- The menu opens only where a slash could begin a command: at the start of a line, or after a space. Everywhere else a slash is just a slash, so none of these open it:
  - a path or a URL, as in `https://example.com` or `src/webview`
  - a slash inside a word, as in `and/or`
  - anywhere inside inline code, a fenced code block, YAML front matter or an HTML block
- Nothing is written until you pick. While the menu is open, the file holds exactly the characters you typed, `/` included. Picking an item is the first change to your document, and a single Undo takes it back.
