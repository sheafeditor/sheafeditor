---
title: Files and saving
summary: Edit the file your project already has, keep writing while something else changes it, and see or undo what that change did.
order: 40
---

# Files and saving

You edit the file your project already has. There is no import step, no database and no second copy, so what you type is what ends up in your commit, and a tool, a teammate's pull or a coding agent can change the same file while you work.

## Edit without reformatting the file

Type as you would in any editor. Sheaf writes only the characters that changed, so fixing a word in the middle of a document makes `git diff` show that word and nothing else.

Tools that parse a document and print it back out reflow paragraphs and normalise list markers, which turns a one-word fix into a large diff. Sheaf does neither: nothing is reflowed, no list markers are normalised, and the spacing you chose stays yours.

Every keystroke reaches the file, however fast you type.

## Keep writing while something else edits the file

Markdown files get changed by things other than you: `git pull`, a formatter, a coding agent, another editor. Carry on typing when that happens. Sheaf shows the new content without losing your place on screen.

- If the change lands above where you are working, the text you were reading stays where it was, and your next keystroke still goes where your cursor is.
- Something deleted elsewhere in the file does not come back because you kept typing.
- If a change arrives before your own typing has been saved, you get VS Code's own save conflict, and neither version disappears quietly.
- A write made from a copy of the file read just before your own save keeps what you had typed. Something that reads a file, changes one line and writes it back has not seen the letter you added in between, so that letter is not treated as a line it meant to remove: you get both changes. A write that arrives well after your save is taken at its word, since by then it is as likely to mean the removal, and that case tells you what it took.
- A change that came from outside is never written back to the file as though Sheaf had made it, and the file's line endings survive it.

## See what changed

Look for the marks in the margin. Sheaf marks the lines an outside write put in, so you can see where the document changed without opening source control.

- Every line the write inserted or rewrote gets a bar in the margin beside it and a faint tint in your theme's colour for modified lines.
- A write that only removed lines leaves a short tick in the margin where they were.
- Each change is marked on its own lines. An agent that edits two paragraphs far apart marks those two and nothing in between.
- If another write arrives, its lines are added to the ones already marked.

In a table the marks go row by row. A row whose line the write inserted or rewrote gets the bar beside its row number and the tint across its cells, and a removed row leaves a tick on the row that followed it.

To clear a mark, edit the line. The rest stay until you edit them or close the document. Marks are never saved and never touch the file. Your own edits, and your own Undo and Redo, mark nothing, whether you use the keys or VS Code's Edit menu.

## Get back what an outside write took

Most of the time there is nothing to get back, because your text stands.

A write is measured against the text it was actually made from. Something that read your file a moment ago and wrote it back has an older copy of the line you were typing on, and that older copy does not displace what you typed: nobody typed it. So a write that changes another line stays a change to another line, and your letters stay yours, in the document and in the file. Nothing is said, because nothing was lost.

A write that arrives long enough after your typing is taken at its word. By then it is as likely to mean the deletion as to be behind, and Sheaf cannot tell those apart from the bytes. In that case it tells you what it took, quoting it, with an Undo on the notice. To bring your version back, do either of these:

1. Press **Undo** on the notice.
2. Press Cmd+Z (Ctrl+Z on Windows and Linux). The write goes on the undo stack, so one Cmd+Z brings your version back whether or not you used the notice.

Nothing is ever re-applied for you. Sheaf never writes text nobody typed: an edit replayed on top of a paragraph that has since been rewritten can read as nonsense, and that nonsense would then be saved. Undo puts you exactly where re-applying would have, by your own hand.

A write that leaves your work alone, or that changes a part of the file you never touched, says nothing at all.

## View the rendered file and the raw Markdown side by side

Open the same file as rendered Sheaf in one pane and plain text in the other, so you can watch the raw Markdown as you write, or the other way round.

1. Split the editor with **View: Split Editor Right**.
2. In one pane, press **Open raw Markdown** at the right end of the formatting toolbar.

Type in either pane and both show the change. Two Sheaf editors on the same file work the same way: they stay in step with each other and with the file.

## Good to know

- Line endings are preserved. A CRLF file stays a CRLF file, including on lines your edit adds.
- Text of every kind survives the round trip: emoji, CJK, an empty file, a file that ends without a newline.
- When and how the file is saved is set by [auto-save](../settings.md#auto-save).
- Closing a tab within a moment of typing can still ask whether to save, because the close comes before the save that was on its way. Whichever button you press, your text is kept.
