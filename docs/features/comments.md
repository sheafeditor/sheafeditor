---
title: Comments
summary: Write notes into a document as HTML comments, and see them drawn as boxes you can collapse or put away.
order: 10
---

# Comments

A comment is a note to whoever is working on the document. You write it as an HTML comment, which nothing renders, and Sheaf draws it as a box you can collapse, edit or put away.

## Write a comment

Markdown has no spelling of its own for a comment, so write an HTML comment on its own lines:

```markdown
<!-- Ask the platform team before publishing this. -->
```

It may run over as many lines as you like:

```markdown
<!--
Two open questions before this ships:
the retry budget, and who owns the alert.
-->
```

Nothing renders it. It is invisible on GitHub, invisible in a static site, and invisible to anyone reading the finished page, which is the point.

Sheaf draws a comment that sits on its own lines as a box labelled **Comment**, in the same style as a [callout](callouts.md): a rule down the side, an icon, and the label.

## Collapse a comment

Press the chevron on the left of the box. It shuts the box down to its label and the comment's first line. Press it again to open it.

Which comments you have collapsed is remembered for this folder on this machine, so a note you put aside stays that way when you close the file and come back to it. It is remembered per document, and against the comment's own text: change the words and the comment opens again, which is right, because it is no longer the note you had read.

In a [browser tab](in-a-browser.md) there is no editor to remember anything, so a collapse lasts as long as the page.

## Hide every comment

Run **Sheaf: Toggle Comments** from the Command Palette. It flips the `sheaf.comments` setting between its two values, for every Markdown file you open in Sheaf:

| Value | What you get |
| --- | --- |
| `show` (default) | Every comment on its own lines is drawn as a box. |
| `hidden` | Every comment shrinks to a small marker. |

Hidden never means gone. Each comment leaves a marker where it is, so you can see that there is a note there. Press the marker to bring that one comment's box back for as long as you are reading. Turn comments back on to bring all of them back.

## Edit a comment

Do any of these:

- Click the box.
- Put the caret in the comment and press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux).
- Choose **Edit Markdown** from the block menu or the right-click menu.

The box goes away, the `<!--` and `-->` come back, and you can type between them. Move the caret out and the box is drawn again.

## Good to know

- Your file never changes. Drawing a comment, collapsing it, putting it away and opening the document again all leave every byte exactly as you typed it.
- Typing in a comment rewrites that comment's lines and nothing else.
- Nothing about a collapse goes into the file, so a teammate opening the same document sees every comment open, and a comment you collapse is still there for anyone reading the raw Markdown.
- A comment has to own its lines to become a box. These are left as they are:
  - A comment inside a sentence, as in `A line with <!-- an aside --> in it`. It keeps the styling it has always had, because a box in the middle of a paragraph would break the sentence in two.
  - A comment sharing a line with other text, as in `<!-- a note --> and more words`.
  - A comment that is never closed. Without its `-->` there is no telling where it ends.
  - A comment inside a fenced or indented code block. That is part of the example, and it keeps drawing as code.
