---
title: The toolbar
summary: Use the bar above the document to set text style, mark text, make lists, quotes and code blocks, insert blocks, clear formatting and undo.
order: 1.2
---

# The toolbar

The bar above the document holds everything you would otherwise type as Markdown. It follows the caret: the buttons for the marks and blocks you are in show pressed, and the text style reads the heading level, or Text. Every button writes the characters you could have typed, and one undo takes any of them back.

## Change the text style

Open the first control and choose H1 to H6, or Text. The control names the kind of line the caret is on. It counts a heading underlined with `===` or `---`, and a heading inside a quote, the same as one written with hashes.

## Mark text

Select the text, or put the caret on a word, and press Bold, Italic, Strikethrough, Highlight, Inline code or Link. The buttons work the way the keys in [Formatting](formatting.md#make-text-bold-italic-or-code) do. A mark's button shows pressed while the caret is inside that mark.

## Clear formatting

Select the text and press **Clear formatting**. Every mark comes off: bold, italic, strikethrough, highlight, inline code and links, however their markers are spelled. Every word stays. A link keeps its words and loses its address.

With nothing selected, it clears only the marks the caret is inside.

## Make a list, a quote or a code block

Select the lines, or put the caret on one line, and press the button:

| Button | Key | What it does |
| --- | --- | --- |
| Bullet list | Cmd+Shift+8 | Makes the lines bullets |
| Numbered list | Cmd+Shift+7 | Makes them a numbered list counting from 1 |
| Task list | Cmd+Alt+4 | Makes them tasks with empty checkboxes |
| Quote | Cmd+Shift+9 | Quotes them |
| Code block | Cmd+Alt+8 | Puts them between code fences |

On Windows and Linux, press Ctrl wherever this page says Cmd.

Press the button again on lines that already are that kind to turn them back into plain lines. A list of one kind turns into another in place, bullets to numbers and back, and a task that becomes a bullet leaves no empty checkbox behind.

The buttons keep the shape of what you selected:

- A nested item stays nested.
- Blank lines between paragraphs stay blank, so two paragraphs become two items with nothing empty between them.
- A quoted list gets its markers inside the quote.
- Quote makes separate paragraphs into one quote. On a nested quote, it takes off one level at a time.

Code block on an empty line opens an empty block with the caret inside. Inside a code block, it takes the fences away and leaves the code exactly as it was.

## Insert a block

Open the **+** menu and choose a Markdown table, a CSV data table, a code block, a divider or an image. The block goes below the caret. On an empty line it goes on that line, and in a code block it goes below the block, never inside it.

A divider is drawn as a rule and keeps a blank line above it, so the text above never becomes a heading by accident.

## Undo a change

Press the undo arrow to take back your last change, and the redo arrow to put it back. Both sit at the start of the bar. They do what Cmd+Z and Cmd+Shift+Z do, and what Undo and Redo in VS Code's Edit menu do. The arrows are dimmed when there is nothing to undo or redo.

A button or key command comes back in one step, and so does a run of typing. Undoing a formatting command puts your selection back where it was. Each open document keeps its own history.

## Use the buttons at the right end of the bar

Four buttons sit at the right end of the bar, apart from the formatting:

- **Toggle line numbers** shows a column of line numbers beside the text, below.
- **Table of contents** shows, folds or hides the panel of the document's headings. See [Table of contents](table-of-contents.md).
- **Open raw Markdown** opens the file in VS Code's own text editor, for when you want the source and nothing else.
- **Keyboard shortcuts** lists every key Sheaf answers, and Cmd+/ opens the same list.

## Show line numbers

Press **Toggle line numbers** to show a column of line numbers beside the text. Press it again to hide them.

Each line is numbered by its line in the file, so the number beside a paragraph under a long table is the line to look for in a diff or an error.

Sheaf remembers the answer, not for one file but for you: turn the numbers on once and every document you open has them, in this project and the next, and they are still there after you close the window. Working with line numbers on is a habit rather than something about one document, so you set it once. It is the `sheaf.lineNumbers` setting, so you can also set it in Settings without opening a document, and it travels with your other settings.

## Keys

| Key | What it does |
| --- | --- |
| Cmd+Shift+8 | Bullet list |
| Cmd+Shift+7 | Numbered list |
| Cmd+Alt+4 | Task list |
| Cmd+Shift+9 | Quote |
| Cmd+Alt+8 | Code block |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |

## Good to know

- Clear formatting leaves the markers of headings, lists, quotes and code blocks alone, and never touches the text of a code block.
- If the code in a code block has backticks of its own, the fence is written longer than any of them, so the block stays one block.
- Showing line numbers changes nothing in the file. Whether they are on is a setting, kept outside your documents.
