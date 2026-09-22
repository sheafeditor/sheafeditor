---
title: Find and replace
summary: Finding text anywhere in the document, including tables and link addresses, and replacing one match or all of them.
order: 12
---

# Find and replace

Press **Cmd+F** (Ctrl+F on Windows and Linux) to open the find bar above the document, filled in with any text you had selected. **Cmd+Alt+F** (Ctrl+Alt+F) opens it with the replace row showing.

| Key or button | Does |
| --- | --- |
| Enter, Shift+Enter | Go to the next or previous match |
| **Aa** | Match case |
| **ab** | Match whole words only |
| **.\*** | Treat what you typed as a regular expression |
| **Replace** | Replace the current match |
| **Replace all** (Cmd+Enter, Ctrl+Enter) | Replace every match |
| Escape | Close the bar |

The count beside the field reads "3 of 12" while you step through matches.

Find searches the Markdown itself, so it also finds text you do not see drawn, such as a link's address or a heading's `#`. Going to a match like that shows the Markdown of its lines until you move away. A table stays a grid: each cell holding a match is tinted, and going to a match makes its cell the table's active cell (see [Finding in a table](tables.md#finding-in-a-table)).

Replacing changes exactly the matched characters and nothing else in the file. With regular expressions off, what you type is matched as written, backslashes included.
