---
title: Comments
summary: Notes written into a document as HTML comments, drawn as boxes you can collapse or put away.
order: 10
---

# Comments

A comment is a note to whoever is working on the document. Markdown has no spelling of its own for one, so people write an HTML comment:

```markdown
<!-- Ask the platform team before publishing this. -->
```

Nothing renders it. It is invisible on GitHub, invisible in a static site, and invisible to anyone reading the finished page, which is the point.

Sheaf draws a comment that sits on its own lines as a box labelled **Comment**, in the same style as a [callout](callouts.md): a rule down the side, an icon, and the label. A chevron on the left shuts the box down to its label and the comment's first line, and opens it again.

Your file never changes. Drawing a comment, collapsing it, putting it away and opening the document again all leave every byte exactly as you typed it.

## What becomes a box

A comment has to own its lines. It may run over as many as you like:

```markdown
<!--
Two open questions before this ships:
the retry budget, and who owns the alert.
-->
```

These are left as they are:

- **A comment inside a sentence.** `A line with <!-- an aside --> in it` keeps the styling it has always had, because a box in the middle of a paragraph would break the sentence in two.
- **A comment sharing a line with other text**, as in `<!-- a note --> and more words`.
- **A comment that is never closed.** Without its `-->` there is no telling where it ends.
- **A comment inside a fenced or indented code block.** That is part of the example, and it keeps drawing as code.

## Collapsing

Press the chevron to shut a comment down to its label and first line, and press it again to open it.

Which comments you have collapsed is remembered for this folder on this machine, so a note you put aside stays that way when you close the file and come back to it. It is remembered per document, and against the comment's own text: change the words and the comment opens again, which is right, because it is no longer the note you had read.

Nothing about a collapse goes into the file, so a teammate opening the same document sees every comment open, and a comment you collapse is still there for anyone reading the raw Markdown.

In a [browser tab](in-a-browser.md) there is no editor to remember anything, so a collapse lasts as long as the page.

## Putting every comment away

The setting `sheaf.comments` takes two values:

| Value | What you get |
| --- | --- |
| `show` (default) | Every comment on its own lines is drawn as a box. |
| `hidden` | Every comment shrinks to a small marker. |

**Sheaf: Toggle Comments** in the Command Palette flips between them, for every Markdown file you open in Sheaf.

Hidden never means gone. Each comment leaves a marker where it is, so you can see that there is a note there, and pressing the marker brings that one comment's box back for as long as you are reading. Turning comments back on brings all of them back.

## Editing a comment

The comment is in your file exactly as you typed it. To see it and change it, click the box, or put the caret in the comment and press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown** from the block menu or the right-click menu. The box goes away, the `<!--` and `-->` come back, and you can type between them. Move the caret out and the box is drawn again.

Typing in a comment rewrites that comment's lines and nothing else.
