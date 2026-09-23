---
title: Formatting
summary: Bold, italic, strikethrough, highlight, inline code, code blocks and the inline HTML tags, drawn as formatting with their markers hidden.
order: 1
---

# Formatting

Text marked up in Markdown is shown the way it reads: bold is bold, code sits in a chip, and the asterisks and backticks that make it so are hidden. The file keeps every marker exactly as written. To see them, press **Edit Markdown** (Cmd+Alt+E, Ctrl+Alt+E on Windows and Linux) on the block, or turn on `sheaf.revealSyntaxOnLine` to see the markers on whichever line the caret is on.

## Marks

| Written as | Shown as | Key |
| --- | --- | --- |
| `**bold**` or `__bold__` | **bold** | Cmd+B |
| `*italic*` or `_italic_` | *italic* | Cmd+I |
| `~~struck~~` or `~struck~` | struck through | Cmd+Shift+X |
| `==highlight==` | highlighted | Cmd+Shift+H |
| `` `code` `` | a code chip | Cmd+E |
| `[words](https://example.com)` | a link | Cmd+K |

On Windows and Linux the keys use Ctrl in place of Cmd. Each key wraps the selected text in its markers, and pressing it again on text that already has them takes them off. With nothing selected, a key takes the mark off if the caret is inside it, applies it to the word under the caret, or, in empty space, applies it to what you type next. It never writes empty markers. The toolbar that appears over a selection and the right-click menu offer the same marks.

Marks work inside headings, list items, quotes, links and table cells, and they nest: `*a **b** c*` shows italic around bold.

A backslash before a marker makes it a plain character, so `\*not italic\*` shows its asterisks and no backslashes. A character entity such as `&amp;` or `&mdash;` shows as the character it names.

## Code blocks

A fenced block is drawn as a panel of code, without the ``` lines that make it one. The language you wrote after the opening fence is shown as a small label at the top right of the panel, so a reader can still see what the code is.

Everything between the fences is left exactly as written, spacing included, and the fences themselves are still in the file. **Edit Markdown** on the block shows them, which is how you change the language.

A block indented by four spaces has no fence to hide and is drawn as it always was.

## Inline HTML

Markdown has no syntax for a key cap, a subscript or an abbreviation, so documents write those as HTML. Sheaf draws these tags as their formatting and hides the tags:

| Written as | Shown as |
| --- | --- |
| `<kbd>F5</kbd>` | a key cap |
| `H<sub>2</sub>O`, `2<sup>10</sup>` | subscript, superscript |
| `<abbr title="Network Time Protocol">NTP</abbr>` | underlined, with the title on hover |
| `<mark>`, `<small>`, `<ins>`, `<u>` | highlighted, smaller, underlined |
| `<del>`, `<s>` | struck through |
| `<strong>`, `<b>`, `<em>`, `<i>` | bold, italic |
| `<code>` | a code chip |

The opening and closing tag have to be on the same line. The only attribute Sheaf reads is an abbreviation's `title`. Any other tag, a tag with other attributes, an unmatched tag, and any tag inside code is shown as written, so nothing in the file is ever hidden that Sheaf does not understand.
