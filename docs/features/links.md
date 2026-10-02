---
title: Links
summary: Follow a link, write one by picking a file or heading as you type its address, or paste an address over words.
order: 8
---

# Links

A Markdown link is a pair: the words in square brackets, and the address in parentheses after them. Sheaf draws it as the words alone, underlined, and keeps the brackets and the address out of your way until you ask for them.

## Follow a link

Click the link. Cmd-click does the same, and so does putting the caret in it and pressing Cmd+Enter. On Windows and Linux, press Ctrl wherever this page says Cmd.

- A web address opens in your browser.
- A path to another file opens that file in the editor.
- An address such as `#a-heading` scrolls to that heading in this document.
- A reference link opens the address its definition names.

An address with parentheses or spaces in it opens whole.

The same everywhere a link is drawn: in your text, in a table cell whether or not you are editing it, in a view, and on a board's cards.

**A drag that starts on a link selects instead of opening.** A click is a press and a release with nothing moving in between, so dragging through a link, or selecting a paragraph that contains one, works as it always did. Selecting a link's words with the mouse to retype them is fiddly, so to change them, right-click the link and edit the text field.

## Change a link

Right-click the link. Its panel opens with the words in one field and the address in the other, and you can change either. The panel also copies the address and removes the link.

A right-click on a link does not give you the ordinary menu, which is the one place in a document where that is true. Everywhere else, right-click works as it always has.

## Make a link

1. Select the words the link should carry, or put the caret where it should go.
2. Press Cmd+K, or **Link** on the toolbar or in the right-click menu.
3. A small panel appears with two fields. Type the address and press Enter.

Nothing is written to your file until you press Enter. Press Esc, or click somewhere else, and the file is exactly as it was.

With words selected, they arrive in the panel's text field and the caret is in the address field, so the address is the only thing left to type. With nothing selected, the caret starts in the text field: type the words, press Tab, type the address. An address entered with the text field left empty becomes its own words.

A link cannot cross a paragraph, so a selection over several paragraphs becomes one link per paragraph, each keeping its own words, all to the one address you typed.

The caret lands after the link, ready to carry on the sentence. One Undo takes the whole link back.

## Change a link's words or its address

Put the caret in the link, or rest the pointer on it, and a small panel appears under it with two fields: the link's words on top and its address below.

- Tab moves between the fields, and Enter saves both at once. Change the words, the address, or both, and press Enter in either field.
- Esc closes the panel and writes nothing.
- One Undo takes back the whole edit, words and address together.
- Cmd+K puts the caret straight in the address field, whether the panel is already showing or not.

Only the two spans you edited change in the file. The brackets, the parentheses and anything else on the line stay as they were.

The panel also carries three buttons: open the link, copy its address, and remove the link.

## Take a link off some words

Press Cmd+Shift+K with the caret in the link, or use **Remove link** on the link's panel or in the right-click menu. The words stay and the address goes. One Undo puts the link back.

With text selected, Cmd+Shift+K removes every link inside the selection, and that is one Undo as well.

## See a link's address

Put the caret in the link and press Cmd+Alt+E. The block you are in shows its source, address included.

## Link to a file or a heading

1. Type the link's words in square brackets, then `(`. Sheaf lists the files in your workspace.
2. Keep typing to narrow the list. A file whose name starts with what you typed comes first, and Markdown files come before other files.
3. Press Enter or Tab. Sheaf writes the highlighted file's path, relative to the document you are in, and closes the link.

```
typing:  see the [plan](pla
Enter:   see the [plan](../notes/plan.md)
```

To link to a heading in this document, type `#` straight after the `(`. The list shows this document's headings instead, each written as the anchor it answers to: `## Hazard flags` becomes `#hazard-flags`, and a second heading with the same name becomes `#hazard-flags-1`.

The list never types anything for you. The arrow keys move through it, Escape closes it and leaves what you typed, Backspace past the `(` closes it, and one Undo takes back a pick.

## Paste a path to another document

1. Copy another document's path, for example from the file tree.
2. Put the caret where the link should go, with nothing selected.
3. Paste. Sheaf writes a link whose words are that document's own title.

```
copy:    docs/launch-plan.md
paste:   see the [Launch plan](docs/launch-plan.md)
```

The title is the document's first heading. A document with no heading is linked by its file name without the extension, so `release-notes.md` reads as `release-notes`. The address is written relative to the document you are in.

A relative path, an absolute path and a `file:` URL all work, as long as the file is in your workspace and is Markdown. Anything else pastes as the text it is: a path outside the workspace would give you a link that works here and is broken for everyone who clones the repository. In a browser tab, which can see only the folder it was started in, only a path relative to the document works.

## Paste an address over words

1. Copy an address, for example in your browser.
2. Select the words that should carry it.
3. Paste. Sheaf writes the link around the words.

```
before:  see the release notes for details
         select "release notes", paste https://example.com/notes
after:   see the [release notes](https://example.com/notes) for details
```

The caret lands after the closing parenthesis. A single Undo puts your words back exactly as they were, so a paste you meant to be plain costs one keystroke.

Marks inside the words are kept. Select `**bold** notes`, paste an address, and the bold stays inside the new link's words.

The Markdown Sheaf writes is the Markdown you would have typed, with two escapes so the result reads as a link:

- A `[` or `]` in the selected words is escaped, so the link's words do not end early.
- An address carrying a parenthesis, a space or a control character is written inside angle brackets, which is Markdown's spelling for exactly that. An ordinary address is written bare.

```
read about [ferns](<https://example.com/Fern_(plant)>) today
```

## Keep a paste plain

A plain paste is never wrong, so Sheaf writes a link only when it is certain. In each of these cases the text pastes as it always did:

- Nothing is selected. There are no words to carry the link.
- The clipboard holds more than one address, or an address with anything else beside it. Two addresses are not one destination.
- The address has no scheme. `example.com` and `www.example.com` are pasted as text. Sheaf does not add `https://` for you, because it cannot know whether you meant a web address at all.
- The scheme is one a document must not run, such as `javascript:` or `data:`.
- The selection is inside code, whether a fenced block or an inline span. Code is shown as it is written.
- The selection is inside a link, or covers one. Markdown has no link inside a link, and choosing between the two addresses for you would be guessing.
- The selection crosses a line. A link's words are one run of text in one block.

## Keys

| Key | What it does |
| --- | --- |
| Click | Follows the link |
| Right-click | Opens the link's panel, with its words and its address |
| Cmd-click | Follows the link, as a plain click does |
| Cmd+Enter | Follows the link the caret is in |
| Cmd+K | Asks for a link over what you selected, or opens the address of the link you are in |
| Tab | Moves between the panel's two fields |
| Enter | Saves what the panel holds |
| Esc | Closes the panel and writes nothing |
| Cmd+Shift+K | Removes the link the caret is in, or every link in the selection |
| Cmd+Alt+E | Shows the source of the block, address included |
| Enter or Tab | Writes the highlighted file or heading into the link |
| Up and Down | Move through the list |
| Escape | Closes the list and leaves what you typed |
| Cmd+Z | Takes back a pick, or a link written by pasting |

## Good to know

- Besides links written with their words in brackets, and reference links, these show as links: a bare web address such as `https://example.com`, and an address or an email in angle brackets, `<https://example.com>` or `<name@example.com>`.
- A link whose brackets hold no words shows its address instead, so there is something to click.
- Square brackets that are not a link stay as you wrote them: `[1]`, `[draft]`, and a reference whose label nothing in the document defines.
- An address that would run code, such as one starting `javascript:`, `data:` or `vbscript:`, is never opened.
- The list of files and headings does not open in code, in front matter or in a table's source. In a browser, where Sheaf cannot see a workspace, it offers only headings.
- A path with a space in it is written inside angle brackets, as `<../my notes.md>`.
