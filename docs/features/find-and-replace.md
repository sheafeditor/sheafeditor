---
title: Find and replace
summary: Find text anywhere in the document, including tables and link addresses, and replace one match or all of them.
order: 12
---

# Find and replace

Press Cmd+F (Ctrl+F on Windows and Linux) to search the document you are in. You can find text anywhere in it, including tables and link addresses, and replace one match or all of them.

## Find text

1. Press Cmd+F. The find bar opens above the document, filled in with any text you had selected.
2. Type what you are looking for.
3. Press Enter for the next match, or Shift+Enter for the previous one. The count beside the field reads "3 of 12" while you step through.

Turn on **Aa** to match case, **ab** to match whole words only, or **.\*** to treat what you typed as a regular expression.

Find searches the Markdown itself, so it also finds text you do not see drawn, such as a link's address or a heading's `#`. Going to a match like that shows the Markdown of its lines until you move away.

## Replace text

1. Press Cmd+Alt+F. The find bar opens with the replace row showing.
2. Type what to find, and what to put in its place.
3. Press **Replace** to replace the current match, or **Replace all** (Cmd+Enter) to replace every match.

## Find in a table

Search as usual. A table stays a grid: each cell holding a match is tinted, and going to a match makes its cell the table's active cell. See [Find in a table](tables.md#find-in-a-table).

## Keys

| Key or button | Does |
| --- | --- |
| Cmd+F | Open the find bar |
| Cmd+Alt+F | Open the find bar with the replace row |
| Enter, Shift+Enter | Go to the next or previous match |
| **Aa** | Match case |
| **ab** | Match whole words only |
| **.\*** | Treat what you typed as a regular expression |
| **Replace** | Replace the current match |
| **Replace all** (Cmd+Enter) | Replace every match |
| Escape | Close the bar |

## Good to know

- Replacing changes exactly the matched characters and nothing else in the file.
- With regular expressions off, what you type is matched as written, backslashes included.
