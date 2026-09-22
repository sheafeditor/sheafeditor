---
title: Links
summary: Writing a link by picking a file or heading as you type its address, or by pasting an address over the words that should carry it.
order: 8
---

# Links

A Markdown link is a pair: the words in square brackets, the address in parentheses after them. Sheaf draws it as the words alone, underlined, and keeps the brackets and the address out of your way until you ask for them. Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux) shows the source of the block you are in, address included.

## Completing an address

Type the words in brackets and then `(`, and Sheaf lists the files in your workspace. Keep typing to narrow the list: a file whose name starts with what you typed comes first, and Markdown files come before other files. Enter or Tab writes the highlighted file's path relative to the document you are in, and closes the link:

```
typing:  see the [plan](pla
Enter:   see the [plan](../notes/plan.md)
```

A path with a space in it is written inside angle brackets, as `<../my notes.md>`. Type `#` straight after the `(` and the list shows this document's headings instead, each written as the anchor it answers to: `## Hazard flags` becomes `#hazard-flags`, and a second heading with the same name becomes `#hazard-flags-1`.

The list never types anything for you. The arrow keys move through it, Escape closes it and leaves what you typed, Backspace past the `(` closes it, and one Undo takes back a pick. It does not open in code, in front matter or in a table's source. In a browser, where Sheaf cannot see a workspace, only headings are offered.

## Pasting an address over words

Copy an address in your browser, come back, select the words that should carry it, and paste. Sheaf writes the link around the words:

```
before:  see the release notes for details
         select "release notes", paste https://example.com/notes
after:   see the [release notes](https://example.com/notes) for details
```

The caret lands after the closing parenthesis, and a single Undo puts your words back exactly as they were, so a paste you meant to be plain costs one keystroke.

Marks inside the words are kept. Selecting `**bold** notes` and pasting an address leaves the bold intact inside the new link's label.

## When a paste stays a plain paste

A plain paste is never wrong, so Sheaf only writes a link when it is certain. Everything below pastes the text as it always did:

- **Nothing is selected.** There are no words to carry the link.
- **The clipboard holds more than one address**, or an address with anything else beside it. Two addresses are not one destination.
- **The address has no scheme.** `example.com` and `www.example.com` are pasted as text. Sheaf does not invent `https://` for you, because it cannot know whether you meant a web address at all.
- **The scheme is one a document must not run**, such as `javascript:` or `data:`.
- **The selection is inside code**, whether a fenced block or an inline span. Code is shown as it is written.
- **The selection is inside a link, or covers one.** Markdown has no link inside a link, and choosing between the two addresses for you would be guessing.
- **The selection crosses a line.** A link's words are one run of text in one block.

## What Sheaf writes

The Markdown it produces is the Markdown you would have typed, with two escapes so the result reads as a link rather than as markup:

- A `[` or `]` in the selected words is escaped, so the label does not end early.
- An address carrying a parenthesis, a space or a control character is written inside angle brackets, which is Markdown's spelling for exactly that:

```
read about [ferns](<https://example.com/Fern_(plant)>) today
```

An ordinary address is written bare.
