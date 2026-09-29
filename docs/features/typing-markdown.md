---
title: Typing Markdown
summary: Type Markdown markers to make headings, lists, quotes, code blocks and tables, and use Enter, Shift+Enter and Tab the way Markdown expects.
order: 1.5
---

# Typing Markdown

If you already write Markdown, write it. A marker you type at the start of a line makes the block it names, and the file gets the characters you typed and nothing else.

## Start a block by typing its marker

Type the marker at the start of a line, then a space:

| Typed at the start of a line | Makes |
| --- | --- |
| `# ` through `###### ` | a heading, levels one to six |
| `- `, `* ` or `+ ` | a bullet |
| `1. `, or any number and a dot | a numbered item |
| `- [ ] ` | a task with an empty checkbox |
| `> ` | a quote |
| three backticks, and a language after them if you want one | a code block |
| a header row of pipes, and a row of dashes under it | a table |

The space is part of the marker. `#NotAHeading` has none, so Markdown reads it as text, and Sheaf draws it as text with its hash showing.

Most markers come off the screen once the block is made: a heading's hashes go, a quote's `>` goes, and a bullet's dash becomes a round bullet. A numbered item keeps its number, because the number is part of what the list says. [Formatting](formatting.md#see-the-markdown-behind-the-formatting) covers the marks inside a line, and how to see any marker again.


## Keep a list or a quote going

Press Enter at the end of an item. Sheaf writes the next marker for you, in a list, a task list or a quote. Type `- one`, Enter, `two`, and the file holds two bullets.

A numbered list counts up from whatever number it started at, so a list that opens at `5.` has `6.` as its second item.

## End a list or a quote

Press Enter on an item you have typed nothing into. The list, task list or quote ends and leaves a blank line, and what you type next is an ordinary paragraph.

## Leave a code block

Press Down to leave the block, then Enter to start a paragraph under it. Enter inside a code block adds another line of code, because inside code that is usually what you want.

## Break a line inside a paragraph

Press Shift+Enter. The line breaks where the caret is, and you stay in the same paragraph, list item or quote.

- In a list item, the new line starts under the item's text.
- In a quote, the new line stays inside the quote.
- At the start of a paragraph, you get a plain new line. A line break needs text in front of it to break, and there is none there.
- At the start of a bullet, a numbered item, a task or a quoted line, nothing happens. There is no text in front of the caret there either, and neither answer would leave the line readable: a plain new line would strand the marker above the words, and a break would leave a line holding nothing but the marker, which draws as blank.
- In a code block, Shift+Enter writes an ordinary new line.

The file gets a backslash at the end of the broken line, which is Markdown's spelling for a line break. The backslash stays off the screen.

### A heading cannot hold a line break

At the end of a heading, Shift+Enter does what Enter does and starts the next block, so a heading never gets a backslash. Anywhere else in a heading it does nothing at all.

This is Markdown rather than a gap. A heading written with `#` is one line by definition, so there is no way to spell a line break inside one: a backslash there is a backslash, and breaking the line would leave half the heading as ordinary text. A document app can keep one heading across two lines because its heading holds a break; Markdown's cannot.

## Nest a list item

Press Tab to nest a list item one level under the item above it, and Shift+Tab to bring it back out. With several items selected, they all move together.

In a numbered list, nesting an item starts the sub-list at 1, and the item below it takes the number the sub-list is no longer using, so a set of steps with detail under one of them reads 1, 2, then 1, 2 again, then 3. Bringing an item back out puts it back in the outer list's count. The outermost list still starts at whatever number you gave it.

Tab does nothing on a paragraph, a heading or the first item of a list, because in Markdown four spaces in front of a paragraph would turn it into code. Inside a code block, Tab indents the line.

## Keep a marker as a character

Type a backslash before it. `\*not italic\*` shows as `*not italic*`, with the backslashes in the file and off the screen.

## Complete a table or a fenced block

Sheaf writes no closing fence and no closing pipe for you. A code block ends where you type the second set of backticks, and a row ends where you type the last `|`.

A table is the one block that waits for you to move on. A row of dashes can be read as a table's second line before you have finished typing it, so the pipes and dashes stay on screen while the caret is on that row. Leave the line and the grid is drawn.

A block written between fences waits for its closing fence. A `csv`, `tsv` or `view` block, display maths and a diagram all stay as the lines you typed until the closing fence is there, and are drawn the moment it is. Until then, Markdown itself reads an opening fence as running to the end of the file, so drawing the block early would mean drawing over text you have not written yet.

## Edit at the left edge of a heading, quote or list item

The caret at the start of a block's words is at the left edge of the block, and three keys mean something particular there.

- **Type** and the letter joins the words, so a heading stays a heading. The `#` is not on the screen and nothing you type can land in front of it.
- **Backspace** takes the block's formatting: a heading becomes a paragraph and keeps its words where they are. Press it again and the line joins the one above, which is what Backspace does at the start of any other line.
- **Enter** opens a blank line above a heading and leaves the caret on the words. On a list item it makes an empty item above, because an empty item is something you can see and carry on typing into, and an empty heading is not.

## Put a divider under a paragraph

Leave a blank line under the paragraph, then type three dashes. Three dashes typed straight under a paragraph are the underline of a heading, which is what CommonMark says, so the paragraph above is drawn as a heading and no divider appears.

Sheaf keeps that blank line for you when you come at it from the other side. Type on the empty line above a divider and the blank line stays, so the divider is still a divider rather than becoming the heading's underline. Type against a divider itself, at either end of it, and you get a new line beside it with the divider untouched.

## Type against a code block's edge

A code block's fences are not on the screen, so the caret at the top or bottom edge of the block has nowhere sensible to put a character. Typing there writes a new line outside the block, above or below depending on which edge you are at, and the code is left alone. The one exception is the language: the position just past the opening fence is where `js` is written, and typing there edits it.

Backspace and Delete on a fence take the whole block's formatting, the way they do at the left edge of a heading. The code stays and stops being code. One Undo puts it back.

## Start a numbered list at another number

Leave a blank line above the list. Markdown lets `1.` interrupt a paragraph and no other number, so `5. five` typed straight under a paragraph is read as more of that paragraph. With a blank line between them, it is a list starting at five.

## Keys

| Key | What it does |
| --- | --- |
| Enter | Continues a list, task list or quote. On an empty item, ends it. At the left edge of a heading, opens a blank line above it. |
| Shift+Enter | Breaks the line and stays in the same block. Nothing inside a heading, which cannot hold a break. |
| Backspace | At the left edge of a block, takes the block's formatting and keeps the words |
| Tab | Nests a list item. In a code block, indents the line. |
| Shift+Tab | Brings a nested list item back out |
| Down | Leaves a code block |
| Home | Goes to the first character of the line's text, past the `#`, `>` or bullet |

## Good to know

- The file gets what you typed and nothing else. Every marker stays in the file, even the ones drawn off the screen.
- Home goes to where your text starts, not in front of the marker, so typing after it adds to the line instead of turning a bullet into an ordinary paragraph. On a wrapped line it goes to the start of the line you are looking at, as it does anywhere else.
- Three dashes under a paragraph, and a numbered list that starts past 1, surprise people. Both rules belong to Markdown, and Sheaf reads them the way Markdown does.
- A marker sits to the left of its words, and every item starts its text in the same place, so a bullet, a `1.`, a `10.` and a checkbox all line up. An item that runs onto a second line comes back under its own words.
- Nesting steps in evenly, read from the shape of the list rather than from how many spaces you typed. A quote steps in once per level and draws a rule for each. The lengths are GitHub's, so a document looks here as it will once pushed.
