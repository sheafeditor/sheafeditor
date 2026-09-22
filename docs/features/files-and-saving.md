---
title: Files and saving
summary: How Sheaf writes your file, what happens when something else changes it, and running both views at once.
order: 40
---

# Files and saving

Sheaf edits the file your project already has. There is no import step, no database and no second copy, so what this page describes is what ends up in your commit.

## How Sheaf writes the file

An edit changes only the characters that changed. Fix a word in the middle of a document and `git diff` shows that word, not a reformatted file. This is the difference between Sheaf and a WYSIWYG Markdown tool that parses your document and prints it back out: nothing is reflowed, no list markers are normalised, and the spacing you chose stays yours.

Line endings are preserved. A CRLF file stays a CRLF file, including on lines your edit adds.

Every keystroke reaches the file, however fast you type. Text of every kind survives the round trip: emoji, CJK, an empty file, a file that ends without a newline.

Saving itself is covered under [auto-save](../settings.md#auto-save).

## When something else changes the file

Markdown files get changed by things other than you: `git pull`, a formatter, a coding agent, another editor.

When that happens, Sheaf shows the new content without losing your place on screen. If the change lands above where you are working, the text you were reading stays where it was, and your next keystroke still goes where your cursor is. Something deleted elsewhere in the file does not come back because you kept typing.

If a change arrives before your own typing has been saved, you get VS Code's own save conflict rather than either version disappearing quietly.

A change that came from outside is never written back to the file as though Sheaf had made it, and a file's line endings survive it.

### Seeing what changed

Sheaf marks the lines an outside write put in, so you can see where the document changed without opening source control. Every line the write inserted or rewrote gets a bar in the margin beside it and a faint tint in your theme's colour for modified lines. A write that only removed lines leaves a short tick in the margin where they were.

Each change is marked on its own lines: an agent that edits two paragraphs far apart marks those two and nothing in between. If another write arrives, its lines are added to the ones already marked.

The marks go away as you work. Editing a marked line clears that line's mark, and the rest stay until you edit them or close the document. They are never saved and never touch the file. Your own edits, and your own Undo and Redo, mark nothing, whether you use the keys or VS Code's Edit menu.

A table shows the marks row by row: a row whose line the write inserted or rewrote gets the bar beside its row number and the tint across its cells, and a removed row leaves a tick on the row that followed it.

### When an outside write takes back what you just did

The write wins, because the loss happened on disk and showing you the file as it now is is what any editor does. What Sheaf adds is that it will not let that happen silently.

When a write takes back something you did in the last few seconds, Sheaf tells you what it took, quoting it, with an Undo on the notice. The write also goes on the undo stack, so one Cmd+Z (Ctrl+Z on Windows and Linux) brings your version back whether or not you used the notice.

Nothing is ever re-applied for you. Sheaf never writes text nobody typed: an edit replayed on top of a paragraph that has since been rewritten can read as nonsense, and that nonsense would then be saved. Undo puts you exactly where re-applying would have, by your own hand.

A write that leaves your work alone, or that changes a part of the file you never touched, says nothing at all.

## Both views at once

Split the editor and open the same file as rendered Sheaf in one pane and plain text in the other. Type in either and both show the change, so you can watch the raw Markdown as you write, or the other way round.

Two Sheaf editors on the same file work the same way: they stay in step with each other and with the file.

To set this up, split the editor (**View: Split Editor Right**), then in one pane press **Open raw Markdown** at the right end of the formatting toolbar.
