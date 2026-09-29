---
title: Footnotes
summary: Write footnotes the way GitHub reads them, and see them as numbered notes where you wrote them, with the note a hover away.
order: 8.5
---

# Footnotes

Write a footnote the way GitHub reads it, and you see a small raised number in the sentence and a numbered note where you wrote it. Hover over the number to read the note without leaving your place.

## Write a footnote

A footnote has two parts: a marker in the sentence, and the note on a line of its own that starts with the same marker and a colon.

```markdown
The beacon runs at 1420 MHz[^band] and has since 2229.

[^band]: The hydrogen line, chosen because every receiver already looks there.
```

Sheaf draws the marker as a small raised number, and the note with that number in front of it, in smaller, quieter text.

The label you write is only a name: `[^band]`, `[^1]` and `[^Hydrogen-Line]` are all fine, and a label matches whatever its capitals.

## Write a note over several lines

Indent the following lines by four spaces under the note, and they belong to it. A second paragraph indented the same way after a blank line belongs to it too.

## Choose where the notes go

Put each note wherever it suits you. Most people put their notes at the end of the document, or straight under the paragraph that uses them, and either works on GitHub too.

GitHub gathers every note into a list at the foot of the page. An editor has no foot of the page, so Sheaf shows each note where it is written.

## Jump between a note and its marker

Cmd-click the number in the sentence to jump to its note. Cmd-click the number in front of a note to go back to the first place that refers to it. On Windows and Linux, press Ctrl wherever this page says Cmd.

## See the marker behind a number

Put the caret on its line and press Cmd+Alt+E, or choose **Edit Markdown**. The label appears, and you can change it.

## Good to know

- Notes are numbered in the order they are first referred to, which is how GitHub numbers them. Add a note in the middle of a document and the notes after it renumber themselves.
- The file keeps your labels exactly as you wrote them. The numbers are only drawn.
- A marker whose note does not exist anywhere in the document, such as `[^missing]`, stays as typed, as it does on GitHub.
- A note nothing refers to keeps its label, so you can see it is not being used.
- A label with a space in it, such as `[^two words]`, is not a footnote.
- A marker inside inline code or a code block is code.
