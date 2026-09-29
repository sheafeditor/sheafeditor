---
title: Formatting
summary: Make text bold, italic, struck, highlighted or code, write emoji by name, and write code blocks and inline HTML, drawn with their markers hidden.
order: 1
---

# Formatting

Mark up text the way you would in Markdown, and you see it the way it reads: bold is bold, code sits in a chip, and the asterisks and backticks that make it so are hidden. The file keeps every marker exactly as you wrote it.

## Make text bold, italic or code

Select the text and press the mark's key, or type the markers around it yourself.

| Written as | Shown as | Key |
| --- | --- | --- |
| `**bold**` or `__bold__` | **bold** | Cmd+B |
| `*italic*` or `_italic_` | *italic* | Cmd+I |
| `~~struck~~` or `~struck~` | struck through | Cmd+Shift+X |
| `==highlight==` | highlighted | Cmd+Shift+H |
| `` `code` `` | a code chip | Cmd+E |
| `[words](https://example.com)` | a link | Cmd+K |

On Windows and Linux, press Ctrl wherever this page says Cmd.

The key wraps the selected text in the mark's markers. Press it again on text that already has the mark to take the mark off. With nothing selected, the key works from the caret:

- Inside a mark, it takes that mark off.
- On a word, it marks the word.
- In empty space, it marks what you type next.

Cmd+K is the one that asks a question first: it opens a small panel for the link's words and its address, and nothing is written until you press Enter. See [Links](links.md#make-a-link).

The toolbar above the document, the [toolbar over a selection](menus.md) and the right-click menu offer the same marks.

## See the Markdown behind the formatting

1. Put the caret in the block.
2. Press Cmd+Alt+E, or choose **Edit Markdown**.

The block shows its markers. To see the markers on whichever line the caret is on, all the time, turn on [Reveal syntax on the current line](../settings.md#reveal-syntax-on-the-current-line).

## Keep a marker as a plain character

Type a backslash before it. `\*not italic\*` shows its asterisks, and the backslashes stay off the screen.

## Write a code block

Put the code between fences, with its language after the opening fence:

````markdown
```python
print("hello")
```
````

Sheaf draws the block as a panel of code, without the fence lines. The language you wrote after the opening fence is still in the file and still colours the code; to see it, or change it, show the block's Markdown as below.

## Change a code block's language

1. Put the caret in the code block.
2. Press Cmd+Alt+E, or choose **Edit Markdown**. The fences appear.
3. Change the word after the opening fence.

## Write a key cap, a subscript or an abbreviation

Markdown has no syntax for these, so write them as HTML, with the opening and closing tag on the same line. Sheaf draws these tags as their formatting and hides the tags:

| Written as | Shown as |
| --- | --- |
| `<kbd>F5</kbd>` | a key cap |
| `H<sub>2</sub>O`, `2<sup>10</sup>` | subscript, superscript |
| `<abbr title="Network Time Protocol">NTP</abbr>` | underlined, with the title on hover |
| `<mark>`, `<small>`, `<ins>`, `<u>` | highlighted, smaller, underlined |
| `<del>`, `<s>` | struck through |
| `<strong>`, `<b>`, `<em>`, `<i>` | bold, italic |
| `<code>` | a code chip |

## Write an emoji by name

Type the name between colons. `:warning:` draws as ⚠️, `:rocket:` as 🚀 and `:+1:` as 👍. The file keeps the colons and the name, so the same document shows the same characters anywhere else that reads shortcodes.

Sheaf knows the same names as the largest code-hosting sites, about 1,900 of them. A name it does not know stays on the screen as you typed it, colons and all, which is also what those sites do with it. That is what keeps a time like `10:30:45` and a word between colons that is nobody's shortcode from turning into a picture.

Put the caret on the line to see the name again, the same way as any other marker.

## Keys

| Key | What it does |
| --- | --- |
| Cmd+B | Bold |
| Cmd+I | Italic |
| Cmd+Shift+X | Strikethrough |
| Cmd+Shift+H | Highlight |
| Cmd+E | Inline code |
| Cmd+K | Ask for a link, or edit the link you are in |
| Cmd+Shift+K | Remove the link you are in |
| Cmd+Enter | Open the link you are in |
| Cmd+Alt+E | Show or hide the block's Markdown |

## Good to know

- Every marker stays in the file exactly as written. Hiding it only changes what is drawn.
- A mark key never writes empty markers.
- Marks work inside headings, list items, quotes, links and table cells, and they nest: `*a **b** c*` shows italic around bold.
- A character entity such as `&amp;` or `&mdash;` shows as the character it names.
- Everything between a code block's fences is left exactly as written, spacing included, and the fences stay in the file.
- A code block indented by four spaces has no fence to hide, and is drawn as it always was.
- The only HTML attribute Sheaf reads is an abbreviation's `title`. Any other tag, a tag with other attributes, an unmatched tag and any tag inside code are shown as written, so Sheaf never hides anything in the file it does not understand.
