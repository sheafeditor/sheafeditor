# Changelog

All notable changes to Sheaf are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Double-click selects a word, and raw Markdown opens with a command.** Double-click selects a word and triple-click selects a line, the way they do everywhere else. To read or edit a block's raw Markdown, press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown** from the block menu or the right-click menu. Press it again, press Escape, or move the cursor out of the block to put the Markdown away. A list item opens on its own, with anything nested under it. If you prefer the old gesture, turn on `sheaf.doubleClickToEditSource`, which is off by default now.

- **The extension is now called Sheaf Editor.** A sheaf is a gathering of loose pages, which is what a folder of Markdown files is. It replaces the earlier working names ("MD Editor", and "Nib" before that), which were too generic to find and collided with the many extensions already called some variant of "markdown editor". Everything the extension contributes was renamed to match:

  | Old | New |
  | --- | --- |
  | View type `nib.wysiwyg` | `sheaf.wysiwyg` |
  | Commands `nib.*` | `sheaf.*` |
  | Settings `nib.*` | `sheaf.*` |

  If you set any setting by hand under an earlier prefix (`nib.*`, `md-editor.*`), rename it to `sheaf.*` — the old keys are no longer read. Sheaf still clears a stale `workbench.editorAssociations` entry left by any name it has shipped under, so **Use As Default Markdown Editor** keeps working across the rename.

### Added

- **`sheaf.useAsDefaultMarkdownEditor`** (on by default): a Settings UI toggle for whether `.md` and `.markdown` files open in Sheaf automatically. Turning it off sends Markdown to VS Code's plain text editor instead — you can still open single files with **Open in Sheaf** — and turning it back on restores Sheaf. It applies to files opened after the change; already-open editors are left as they are. Sheaf maintains `workbench.editorAssociations` on your behalf, and never overwrites an association you have pointed at some other editor.

- **Available in editors built on Code OSS.** Releases now publish to Open VSX alongside the Visual Studio Marketplace, so Kiro, Cursor, Windsurf and VSCodium can install Sheaf from the registry they search by default. It is the same extension and the same build in every one of them.

- **Verifiable releases.** Every release is now built by GitHub Actions and carries a build provenance attestation tying the `.vsix` to the commit and workflow that produced it. Since the Marketplace ships a bundled artifact rather than source, this is what lets you confirm the extension in your editor came from this repository. The README has the one `gh attestation verify` command that checks it.

- **Reach tables from the keyboard.** The down arrow on the line above a table moves into its header row, the up arrow on the line below moves into its last row, and the arrows at the grid's top and bottom edges move back out into the text.

- **Undo and redo inside a table.** Cmd+Z and Cmd+Shift+Z (Ctrl+Z and Ctrl+Y) step through the changes you made while the table has focus, then carry on into the document's history. Undoing everything leaves the file exactly as it was.

- **Open links in table cells.** Cmd-click (Ctrl-click) a link in a cell to open it, the same as in prose.

- **Row and column actions on right-click.** Right-click a table cell for Insert row above or below, Insert column left or right, Duplicate row, Duplicate column, Delete row and Delete column, next to Copy ref. A duplicated row or column is an exact copy of the original's text.

- **Move, sort and align from the right-click menu.** Move a row up or down, or a column left or right; sort a column A to Z or Z to A, with numbers compared by value (negative numbers, thousands separators and currency signs included) and empty cells kept at the bottom; and set or clear a column's alignment. With several rows or columns selected, right-clicking inside the selection moves, duplicates or deletes them all together, and inserts a new row or column beside the selection. Moving and sorting change only the order of the lines in the file, and alignment changes only the table's delimiter row.

- **Drag rows and columns to move them.** Press on a row number and drag up or down, or press on a column header and drag sideways: the row or column dims, a line shows where it will land, and releasing moves it there as one undo step. Only the order of the lines, or of the cells within each line, changes in the file.

- **Pad columns to line up.** A table's right-click menu can pad every cell so the columns line up when the file is opened in a plain text editor, keeping each column's alignment and the table's indentation. It is the only table action that rewrites every line, it runs only when you choose it, and it is its own undo step.

- **Tables work with screen readers.** A table announces itself as a grid named by its columns, each cell is exposed with its column header, the selection is marked, and the active cell is announced as the arrow keys move it. The cell edit field is labeled with its column and row. Press Escape to clear a selection, and Escape again to return from the grid to the text below it.

- **Copy ref for a selection of rows.** Select several rows of a table, right-click inside the selection and choose Copy ref: the clipboard gets the rows' line range followed by their exact source, ready to paste into an agent chat. Right-clicking inside a selection now keeps it. Rows moved or added in the grid are named by the lines they will have once the table is saved.

- **See which rows changed when the file changes underneath you.** When an agent, a pull or another editor changes a table while it is on screen, the rows that actually changed flash briefly, so a one-row edit shows as one row. Edits you make in Sheaf are not marked.

- **Use the right-click menu from the keyboard.** Shift+F10 or the context-menu key opens it at the caret, or on the active cell in a table. The arrow keys, Home and End move between items, Enter runs one, and Escape closes the menu and puts focus back where it was.

- **Spreadsheet keys in tables.** Home and End go to the first and last cell of the row, Cmd+arrow (Ctrl+arrow) jumps to the table's edge, Cmd+Home and Cmd+End go to its corners, Page Up and Page Down move a screenful of rows, and Shift extends the selection with each. Shift+Space selects the row and Ctrl+Space the column, and Alt+arrow moves the selected rows up or down, or the selected columns left or right, keeping them selected.

- **Row numbers name their file lines.** Hovering a row number shows the line that row is on in the file, and the corner shows the header's line, so a grid row can be matched to a ref, a diff or an agent's message without counting. Rows added and not yet saved say so.

- **Tables on touch screens.** Double-tapping a cell to edit it no longer opens the table menu over the text field, a menu opened by touch no longer takes the keyboard focus, and the table's controls and menu items are large enough to tap. Right-clicking inside a cell you are editing shows the usual cut, copy and paste menu.

- **Highlight text.** Select text and press Cmd+Shift+H (Ctrl+Shift+H) to wrap it in `==`, which Sheaf shows as a highlight; press it again to remove the highlight. Obsidian and several other Markdown tools read `==text==` the same way. GitHub shows the equals signs as typed, so the text stays readable there.

- **Line breaks inside a paragraph.** Shift+Enter starts a new line in the same paragraph, list item or quote. It is written as a backslash at the end of the line, which Markdown readers treat as a line break, and in a code block it is an ordinary new line.

- **Paste a spreadsheet range into a document as a table.** Copy cells from Excel, Numbers or Google Sheets and paste them into the text: they become a Markdown table on its own block, opened as a grid on its first header cell. Columns of numbers are right-aligned.

- **Find and replace.** Cmd+F (Ctrl+F) opens a find bar above the document, filled in with any selected text. Enter and Shift+Enter step through the matches, and the bar shows which match you are on and how many there are, with options to match case, match whole words or use a regular expression. Cmd+Option+F (Ctrl+Alt+F) opens it with the replace field ready; Replace all changes every match as one undo step. Find searches the Markdown itself, so it also finds text inside tables and inside syntax that is normally hidden, such as a link's address: a table holding the current match shows as Markdown until you move on, and a hidden address is revealed on its line.

- **A fuller toolbar.** Undo and redo, highlight, task list, clear formatting and code block buttons join the toolbar, and an Insert menu adds a Markdown table, a CSV data table, a code block, a divider or an image from your computer, which is saved beside the document the same way a pasted image is. Formatting buttons show as on where the caret is, and the text style menu shows whether the line is text or a heading. In a narrow window the toolbar wraps onto a second row instead of hiding buttons. Cmd+Option+4 (Ctrl+Alt+4) toggles a task list and Cmd+Option+8 (Ctrl+Alt+8) a code block.

- **A right-click menu for writing.** Right-clicking text offers Cut, Copy and Paste next to Copy ref; bold, italic, strikethrough, highlight, inline code, link and clear formatting, with a check beside formatting that is already on; and a Turn into submenu that makes the line text, a heading, a bullet, numbered or task list, a quote or a code block. It also fits what you clicked: on a link you can open it, copy its address, or remove the link and keep its text; in a code block you can copy the code; on a task you can mark it done or not done.

- **A formatting toolbar over selected text.** Select text and a small toolbar appears just above it, with bold, italic, strikethrough, highlight, inline code, link and clear formatting, and **Turn into** for making the selected lines text, a heading, a bullet, numbered or task list, a quote or a code block. Buttons show which formatting is already on. From the keyboard, Alt+F10 moves into the toolbar, the arrow keys move along it, and Esc returns to the text.

- **Edit a link where it is.** Put the caret inside a link, or rest the pointer on one, and a popover shows its address in a field you can edit: Enter saves the new address and changes nothing else on the line. Its buttons open the link, copy its address, or remove the link and keep its text.

- **Move, duplicate and delete whole blocks.** Hover a paragraph, heading, list item, code block, quote or table and a grip appears in the margin: drag it to put the block somewhere else, or click it for Turn into, Duplicate, Move up, Move down and Delete. A list item moves with its nested items and trades places with the items beside it, a table or CSV block moves with every line intact, and front matter stays at the top. Only the lines that moved change in the file, and each move is a single undo.

- **Select blocks from the keyboard.** Press Escape to select the block around the caret. Then the arrow keys select the next block, Shift+arrows select more blocks, Cmd+Shift+arrows (Ctrl+Shift+arrows) or Alt+arrows move them, Cmd+D (Ctrl+D) duplicates them, Backspace deletes them, and Enter goes back to typing. Outside a block selection those keys do what they always did. With the caret in a block that spans several lines, Alt+Up and Alt+Down move the whole block; inside a code block they still move single lines.

- **Slash menu.** Type `/` at the start of a line or after a space to pick a block to turn the line into: text, a heading, a bullet, numbered or task list, a quote or a code block, or to insert a table, a CSV data table or a divider. Keep typing to filter, use the arrows and Enter to choose, and press Escape to keep what you typed. A slash in the middle of a word, a URL or a path never opens the menu. The `+` beside the grip adds an empty line below the block with the same menu open.

### Fixed

- **Pressing Enter in a block you are editing renders it again.** Opening a heading's raw Markdown, typing at the end of it and pressing Enter left the `#` showing: the block stayed raw until you clicked somewhere else. The same happened in a paragraph, a list item and a quote. A typed line break now puts the Markdown away and leaves the caret on the new line, rendered. Typing anything else at the end of the block still joins it and keeps the Markdown shown, and pasting several lines into it leaves it open, since a paste is not Enter.

- **Escape cancels a block drag you start straight away.** Dragging a block by its grip before clicking anywhere in the text left Escape doing nothing: the block stayed faded, the drop line stayed drawn, and letting go moved the block anyway. Pressing the grip never gave the editor the keyboard, so Escape went to VS Code instead of to Sheaf. The grip now takes the keyboard when the editor does not already have it, and leaves your caret alone when it does.

- **Table actions stop changing what a table says.** Deleting a column from a two-column table written without outer pipes turned the table into a heading. Pad columns turned any text a row carried past the last column into a new, empty-headed column, which changes the table in every Markdown viewer. Moving a column deleted that trailing text from the file outright. Sorting a column of dates written `12/31/2023` ordered them by the number before the first slash, so a sorted column looked right and was not. Sheaf now works out the order from the column itself, using any date that can only be read one way, and sorts a column that never settles its order as text rather than guessing at it. And after anything above a table changed, hovering a row number named the line that row used to be on, so a line handed to an agent or looked for in a diff pointed at the wrong row.

- **Typing quickly no longer loses what you typed.** A fast burst of keystrokes, from a text expander, dictation, a held key or simply typing quickly, could leave Sheaf showing only the start of a sentence while the file held all of it. The next key then wrote the short version back and the rest was gone from disk. Sheaf sent each edit to VS Code without waiting for the one before, so every edit after the first was prepared against text that had already changed and VS Code refused it. Edits are now written one at a time, each worked out against the document as it stands, and a refused edit is prepared again rather than dropped.

- **A file with Windows line endings keeps them, and keeps its shape.** Opening a CRLF file and letting anything else change it, an agent, a pull, or a text editor open beside Sheaf, added a blank line at the end, and the next key you pressed wrote that line into the file. Two worse cases came out of the same cause and had not been reported: in a file with mixed line endings, or one holding a lone carriage return, a single keystroke rewrote the whole file from that point on, so one letter typed showed up in `git diff` as every line changed. Sheaf now reads and writes each file in its own line endings and changes only the part you edited.

- **Image controls appear only where they can act.** A reference-style image such as `![alt][label]` now draws as a picture, and it came with a hover toolbar whose buttons did nothing, because resizing and aligning cannot rewrite that form without replacing it with different Markdown. The controls are no longer offered on an image Sheaf cannot rewrite in place, rather than being offered and doing nothing.

- **Images show as pictures in the places they were only showing as markup.** A logo centred with a multi-line `<p align="center">` block, which is how most GitHub READMEs write one, showed its tags instead of the picture. A reference-style image showed its alt text and label. A file name with parentheses, such as `chart(1).png`, read as missing when the file was there. An image written inside a sentence broke the sentence onto three lines, and now sits in the line. Resizing an image no longer deletes its title from the file, and alt text holding brackets, or a path holding a space, is written in a form Markdown reads back as an image. Inserting an image no longer opens a blank line under it, and resizing one that carries both a width and a height scales the height to match, so other renderers stop showing it squashed.

- **A CSV block keeps the lines you did not edit.** Editing one cell used to delete blank lines and all-empty records elsewhere in the block, and to drop any fields a row had beyond the header's last column. Both are silent losses in the file on lines nobody touched. A blank line now stays where it sits, an empty record stays a record, and a row wider than the header keeps its extra fields.

- **A link in a table cell opens at the address prose opens.** Cells skipped the address resolver every other part of Sheaf goes through, so an email address in a cell did not open as mail and a `www.` address did not gain its scheme.

- **Quote, Divider and the slash menu respect the block they are used in.** Removing a quote from a quote that held a fenced code block used to leave the fence and the code lines still quoted, so the quote had to be finished by hand. Picking a heading from the slash menu on the first line of a multi-line quote used to drop the quote from every line below it; it now changes only the line you typed on. Insert Divider inside a code block whose fence is still open used to write the rule into the code, and now puts it above the block.

- **Text typed after a list or quote ends is a new paragraph.** Pressing Enter on an empty list item or quote line ends the block, but the text typed next landed on the very next line, so every Markdown reader outside Sheaf showed it as part of the last item. A blank line is now left behind, which is what makes it a paragraph of its own.

- **Open in Sheaf and the Sheaf commands act on the file in front of you.** Running **Open in Sheaf** from the Command Palette while a file was already open in Sheaf said there was no Markdown file to open. **Open as Raw Markdown** and **Toggle Whole-Document Source Mode**, run while you were working in a plain text editor, acted on a Sheaf tab left open in the background instead. Both now follow the editor that has focus. The Explorer's right-click menu offers **Open in Sheaf** for files named with capitals, such as `NOTES.MD`, and opens every Markdown file you have selected rather than only the one you right-clicked.

- **Turning Sheaf back on as the default Markdown editor works in every settings scope.** Turning it off writes an opt-out into whichever scope you set it in, and turning it back on used to clear that opt-out from one scope only, so the Settings UI showed the toggle on while every `.md` file kept opening as plain text. Both scopes are now cleared. An association you have pointed at some other editor is still left alone.

- **Copy link address copies the address, not its Markdown spelling.** An address written `https://example.com/a_\(b\)`, where the backslashes are Markdown's way of putting a bracket in a destination, was copied with the backslashes still in it, so it did not work when pasted anywhere else. The brackets a destination with spaces is wrapped in are dropped the same way. A bare email address is copied as the address, while Open link still opens it as mail.

- **A link whose address escapes its brackets opens the right page.** An address written `https://example.com/a_\(b\)`, which is how Markdown spells a bracket that is part of the address, opened with the backslashes still in it. The escapes are now read as the characters they stand for, in Cmd-click, Open link and the link popover alike.

- **Typing while the Keyboard shortcuts overlay is open no longer edits the document behind it.** The overlay left the caret in the text, so keys pressed while reading it landed in the file, out of sight, and were saved. Opening the overlay now takes focus into it, and closing it puts focus back where it was.

- **Swapping one emoji for another keeps the emoji.** Selecting 😀 and typing 😃 used to leave a `` in the file, and auto-save wrote it to disk with nothing on screen to say so. Sheaf worked out the smallest edit by UTF-16 code unit, and two emoji that differ only in their second half made an edit that started halfway through a character. Flags and multi-person emoji were damaged the same way. Edits now always begin and end on a whole character.

- **A quote inside a CSV or TSV field is data.** A field such as `27" monitor` used to start a quoted section, which swallowed the rows below it into one cell and dropped the quote marks, so a `csv` block showed values from different records on one line. A quote now opens a quoted field only at the start of a field, the way spreadsheets read it, and is kept as typed anywhere else.

- **Selected text stays readable in the high contrast themes.** Sheaf painted the selection in the theme's selection color and left the text its ordinary color on top, so in Default High Contrast selected words disappeared into a white background, and in Default High Contrast Light they sat dark on dark blue. Selected text now uses the selection foreground the theme provides, the way VS Code's own text editor draws it. Themes that do not set one, which is every standard light and dark theme, are unchanged: links, code and headings keep their colors while selected.

- **Inline code follows the theme instead of one fixed red.** `code` spans were drawn in the same red whatever theme you run, which measured 3.28:1 in Default Light Modern and 3.11:1 in Default High Contrast Light, below the 4.5:1 that ordinary text in those themes clears easily. Inline code now takes the color and chip background VS Code gives code spans in rendered Markdown, so each theme supplies a pair it has already checked.

- **Right-clicking past the end of a line targets that line.** A right-click in a blank line or beyond a line's text used to leave the caret where it was, so the menu acted on an earlier position.

- **Link, Inline code, Shift+Enter and the toolbar menus behave predictably.** Link or Cmd+K with the caret inside a link removes the link instead of nesting a second one, and Link over several paragraphs links each one instead of writing a broken link across the blank line. Inline code on text that holds a backtick writes a longer fence so the code stays in one span. Shift+Enter at the end of a heading starts a new line instead of leaving a backslash in the heading. A Text style or Insert menu opened with a click now takes the arrow keys and Escape.

- **The list, quote and heading buttons keep the document's structure.** Bullet, Numbered and Task list over separate paragraphs used to add an empty item on the blank line between them; the blank line now stays blank, and the same button removes the list again. The buttons no longer write Markdown into code blocks, Bullet list on a task item makes a plain bullet, nested items stay nested, lines in a quote get their list marker inside the quote, and Quote removes a quote of several paragraphs. The Text style menu reads headings underlined with `===` or `---`, and headings inside a quote, correctly, and choosing another style removes the underline.

- **Links, brackets, code and escapes render as they read everywhere else.** A bare URL or an `<...>` autolink used to vanish from the page; it now shows as a link. Square brackets that are not links, such as `[1]` or `> [!NOTE]`, keep their brackets. Reference links show only their text, and their definition lines show the address. Inline code hides its backticks, backslash escapes and HTML entities show the characters they stand for, a link with a title no longer underlines a stray space, and a link with empty text shows its address. Code fenced with a short language name such as `py`, `rs` or `kt` now gets the same syntax colours as the full name. Cmd-click and the link menus open a bare email address as an email and a `www.` address as a web page, and a reference link opens the address its definition gives.

- **Undo, Tab, Enter and the heading shortcuts behave as they should.** Cmd+Z after typing used to take back one character at a time and Cmd+Shift+Z could not bring it back; it now undoes the typing in one step, and Undo and Redo appear in the Keyboard shortcuts list. Tab on a paragraph or heading no longer writes four spaces that turn it into a code block everywhere else; it nests list items only. Enter on an empty second list item or an empty quote line now ends the list or quote. Cmd+Alt+1 to 3 on a list item or quote make a real heading instead of one that shows `- ` or `> ` as text. The heading shortcuts now do exactly what the Text style menu does, so pressing one on a heading that is already that level leaves it alone; Cmd+Alt+0 turns any heading, list item or quote back into plain text.

- **Front matter, indented code and revealed Markdown display correctly.** YAML front matter at the top of a page used to show as a rule, a large heading and bullets; it now shows as plain muted metadata. An indented code block is styled like fenced code. After double-clicking a block to see its Markdown, typing at the end of it no longer hides the Markdown again. With Reveal Syntax On Line on, a click in a quote or list item reveals every line of it, and changing the setting takes effect at once instead of after the caret moves.

- **Table edits are saved as you make them.** A cell edit used to reach the file only when focus left the table, so Cmd+S saved without it and closing the tab lost it with no prompt. Every edit is now written to the document at once, including text still being typed into an open cell, and Cmd+Z in a table takes back the most recent change and returns to the cell it changed, including Pad columns, a pasted range and Insert table, without also running VS Code's own undo. Changes made to the file from outside Sheaf are no longer part of the undo history, so Cmd+Z only takes back your own edits.

- **Tables render and edit more faithfully.** Every table in a long document now renders as a grid, not only the ones near the top. Pasting text with commas or quotes into a cell keeps it as written, a value ending in a backslash keeps its own cell, and escapes and HTML entities in cells show as their characters. Typing Japanese, Chinese or Korean on a selected cell opens it, and CJK text keeps the row's pipes in line. Passing above a table on the first line no longer adds blank lines, selected cells clear when you click into the text, a table with the keyboard shows an outline, returning to the first column of a wide table shows the row numbers, and renaming a column header is announced to screen readers at once.

- **Tables get the block grip.** Hovering a table or a CSV data block used to show no grip, so a table could not be dragged or moved from the block menu. The grip now appears beside tables as it does beside paragraphs, and its menu and drag move the whole table. Letting go of a dragged block over its own place leaves it where it was, and a drag let go outside the editor is cancelled instead of leaving the block faded with the drop line on screen.

- **Moving and converting list items keeps the list's structure.** Turning a bullet with nested items into a numbered item used to leave the nested items indented too little to belong to it, and moving item 10 above item 9 made the list start at 10. Nested lines now follow the new marker width, and numbers stay in place when items trade places. Moving a block among lines with no blank lines between them no longer adds blank lines between blocks that did not move.

- **The right-click menu is safer to use.** Copy ref on a triple-clicked line names only that line. The menu closes if the document changes while it is open, so Remove link and Mark done can no longer act on characters that have moved. Turn into and the formatting items are disabled on YAML front matter, and the selection toolbar no longer appears there. Copy link address and Open link work on an address written as `<my notes.md>`. Paste from the menu turns a copied spreadsheet range into a table, as Cmd+V does, and the menu closes when the document scrolls instead of floating away from the text it acts on.

- **Alt+Up and Alt+Down move whole blocks.** A one-line list item moved with Alt+Up used to take the nested items of the item above it as its own, and the first line under YAML front matter could be moved inside the front matter. A one-line block now moves past whole neighbouring blocks, the same way the grip's Move up and Move down do, and nothing moves into or above front matter.

- **A slash command on one line of a paragraph changes only that line.** Typing `/h2` at the start of a paragraph's second line used to join the whole paragraph into one heading. Headings, lists, quotes and code blocks picked from the slash menu now apply to the line the slash was typed on, and on a later line of a quote or list item the result stays inside that quote or item.

- **A link address you are typing survives outside edits.** When an agent or another editor changed the file above a link while its address was being edited, the address field snapped back to the old address. The typed address now stays, and Enter writes it to the link.

- **Find and replace take backslashes as typed.** With regular expressions off, searching for `C:\new` used to find nothing, and a replacement containing `\n` wrote a line break. Both fields are now taken exactly as written unless regular expressions are on.

- **Turn into leaves tables and code alone.** Turning a selection that crossed a table or a code block into a heading or list used to put a marker on every table row and code line, which broke the table. Those lines are now skipped, and a numbered list made across blank lines is numbered 1, 2, 3 without gaps.

- **Formatting shortcuts no longer also run VS Code commands.** Cmd+B (Ctrl+B) used to bold the text and also hide the side bar, Cmd+Shift+X opened the Extensions view and Cmd+Shift+H opened Search, and each took the keyboard away from the document. Sheaf's own shortcuts now stay in the editor, and keys Sheaf does not use still reach VS Code.

- **Bold, Italic, Strikethrough, Highlight and Inline code toggle cleanly.** With no text selected they used to write empty markers such as `****` on every press. They now remove the formatting the caret is in, apply to the word under the caret, or, in empty space, apply to what you type next. Italic on bold text adds italic instead of replacing the bold. Unbolding part of a bold word, or a selection that includes the markers, removes bold instead of adding asterisks. Spaces at the edges of a selection stay outside the markers, and a selection across paragraphs, list items or headings formats each one on its own.

- **Editing a table changes only what you edited.** Clicking into a table and away used to realign every row to a common column width, and changing one cell could re-pad every other row, so a one-word edit showed up as a whole-table diff. A table you only click through is now left exactly as written, an edited cell changes only its own line, and adding or removing a row or column leaves the spacing of every other row alone. A cell containing an escaped pipe (`\|`) no longer gains a second backslash when it is edited.

- **Edits made after clicking through a table are saved.** Clicking into a table and away without changing anything left the table unable to save, so every later edit showed in the grid and never reached the file.

- **Escape cancels a cell edit.** Pressing Escape while typing in a cell kept what you had typed. It now puts the cell back the way it was.

- **Pressing Tab or Enter past the last row no longer saves an empty row.** The new row still appears so you can type into it, but if you leave it empty it is not written to the file.

- **Escaped pipes display as pipes.** A cell written as `a \| b` in the file shows `a | b` in the grid instead of showing the backslash.

- **The right-click menu no longer breaks tables.** Choosing Bold, Italic, Inline code or Link on a table cell typed the markup onto the end of the table and broke it. A right-click inside a table now offers Copy ref, and the ref names the row you clicked instead of the table's last line.

- **Typing under a table starts a new paragraph.** Text typed or pasted on the empty line directly under a table became a new table row, and the rest of the typing landed on the front of the next line. It now goes on its own line below the table.

- **The caret moves to the right line around tables.** The up and down arrows near a table could skip past it or land a line away from where they should.

- **Clicking a column header or row number and typing edits that header or row.** Typing used to change the bottom cell of the column or the last cell of the row.

- **Table cells keep words whole.** A long value, or a narrow window, no longer splits other columns' words mid-word. A table too wide for the page scrolls sideways inside its own frame.

- **Line breaks inside CSV cells survive editing.** Opening a CSV cell that contains a line break and pressing Enter used to join the lines into one.

- **`<br>` in a table cell shows as a line break.**

- **The active cell stays in view.** Moving it with the arrows or Tab scrolls the table or the page to keep it on screen.

- **Paste lands where you expect in a table.** A pasted block starts at the top-left of the selection instead of the active cell, and a single copied value fills every selected cell. Shift-clicking a row number extends the row selection.

- **A table re-padded outside Sheaf is no longer corrupted by the next edit.** If a formatter or an agent changed only a table's spacing, the next cell edit in Sheaf wrote over the table's old, shorter range and left broken, duplicated lines behind.

- **Unsaved table edits survive changes made to the file from outside Sheaf.** When an agent, a pull or another editor changes the file above a table, or changes another row of a table, while you are editing it, your unsaved cell edits and the text you are typing into a cell are kept and saved along with the outside change. If you had added or removed rows or columns and not yet left the table, the file's version of that table still wins.

- **Inserting a table from the toolbar opens it ready to type.** The new table opens as a grid with its first header cell selected, so typing replaces the placeholder and Tab moves to the next one. It is placed after the paragraph the caret was in, with a blank line on both sides, instead of splitting the paragraph or swallowing the line under it.
- **Tables written without outer pipes stay tables.** In a table like `a | b` with no pipe at either end of its rows, adding a column or clearing the last cell of a row left a blank cell that GitHub and other Markdown readers drop, so the header and delimiter rows no longer matched and the table stopped rendering. Sheaf now adds the one pipe such a row needs beside a blank cell at its edge.

- **Home and End move the caret while you edit a table cell.** On macOS they did nothing inside a cell, so pressing End to add to a value and then typing replaced the whole value. Shift+Home and Shift+End select to the start or end.

- **Editing a file with Windows line endings changes only what you edited.** In a file saved with CRLF line endings, every keystroke reached VS Code as a replacement of nearly the whole file, which other open editors, extensions and undo all saw as a whole-document change. Sheaf now matches the file's line endings before working out what changed.

## [0.0.1] - 2026-08-03

Initial public release — Phase 1, the core WYSIWYG MVP.

### Added

- Always-on WYSIWYG rendering for Markdown that you type directly into: headings, bold / italic / strikethrough, inline and fenced code, links, images, blockquotes, lists, task checkboxes, and horizontal rules.
- **Raw Markdown stays the source of truth.** Rendering is done with view-only CodeMirror 6 decorations rather than a document model, so prose you edit is never reserialized and your git diffs stay clean.
- **Double-click any rendered element** to reveal and edit its raw Markdown.
- **Reveal-on-cursor** (`sheaf.revealSyntaxOnLine`, off by default): show raw syntax markers for the block the cursor is on, Obsidian Live Preview style.
- Formatting toolbar and spreadsheet-style table editing.
- Editorial typography on a centered text column, width configurable via `sheaf.contentWidth` (default `708px`).
- Themed to your active VS Code color theme, dark mode included.
- Debounced auto-save (`sheaf.autoSave`, on by default).
- Commands: **Open in Sheaf**, **Open as Raw Markdown (Text)**, and **Toggle Whole-Document Source Mode**.

### Notes

- Sheaf registers itself as the **default** editor for `.md` and `.markdown` files. To go back to the plain text editor for a single file, use the **Open as Raw Markdown (Text)** button in the editor title bar. To change it globally, see "Making Sheaf the default (or not)" in the README.

[Unreleased]: https://github.com/sheafeditor/sheafeditor/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/sheafeditor/sheafeditor/releases/tag/v0.0.1
