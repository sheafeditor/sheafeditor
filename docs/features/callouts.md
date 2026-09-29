---
title: Callouts
summary: Start a quote with a bracketed type to draw it as a note, tip, warning or caution, the way GitHub renders alerts.
order: 2
---

# Callouts

Start a blockquote with a bracketed type, and you see it drawn as an alert: the type's icon and label in place of the marker, and the quote's rule in that type's colour. Use one for a note, a tip or a warning a reader should not miss.

## Write a callout

Put the type in brackets, after a `!`, on the quote's first line:

```markdown
> [!WARNING]
> Replicas older than 0.9 cannot read the new snapshot format.
```

There are five styles, the same five GitHub renders:

| Marker | Drawn as |
| --- | --- |
| `[!NOTE]` | Note |
| `[!TIP]` | Tip |
| `[!IMPORTANT]` | Important |
| `[!WARNING]` | Warning |
| `[!CAUTION]` | Caution |

Write the type in any case: `[!note]` and `[!NOTE]` are the same callout.

## Give a callout a title

Write the title after the marker, separated by a space. It becomes the callout's label, in place of the type's name.

```markdown
> [!question]- Why does the snapshot change?
> Older replicas stored the index inline.
```

## Use a type of your own

Write any other type in the brackets. The callout is labelled with the type's name as you wrote it, and takes the closest of the five styles:

| Types | Style |
| --- | --- |
| `info`, `todo`, `abstract`, `summary`, `tldr`, `example`, `quote`, `cite` | Note |
| `hint`, `success`, `check`, `done`, `question`, `help`, `faq` | Tip |
| `attention` | Warning |
| `danger`, `error`, `bug`, `failure`, `fail`, `missing` | Caution |

A type not in the table takes the Note style. Type names are letters, digits and hyphens.

## Turn a callout into something else

Use any of the block commands on it: **Plain text**, **Heading**, **Bullet list**, **Numbered list**, **Task list** or **Quote**, from the Text style menu, the block menu or the slash menu.

The callout's first line goes with the callout. That line carries the `[!NOTE]` marker and nothing else you wrote, so turning a callout into a bullet list gives you a list of what it said, rather than a list whose first item is the word `[!NOTE]`.

A title is yours, so a titled callout keeps it. `> [!TIP] Worth knowing` becomes a line reading "Worth knowing", with the body after it.

Backspace and Delete on the label do the same thing: the callout becomes an ordinary quote and its words stay. So does delete-by-word. One Undo brings the callout back.

## Write in a callout by clicking its label

Type on the label and what you type goes at the top of the callout's body, where you meant it. Press Enter there and you get a new line in the body. The type marker is left exactly as you wrote it.

To change the type or the title instead, press **Edit Markdown** (Cmd+Alt+E, Ctrl+Alt+E on Windows and Linux) on the callout. The marker appears as you wrote it and you edit it directly.

## Keep a quote an ordinary quote

Leave out the `!`, or keep the marker off the quote's first line. The marker has to open the first line, with the `!` inside the brackets, and that rule keeps the rest of your writing from being read as a callout:

- `> [draft] notes` and `> [ ] x` keep their text, because there is no `!`.
- `> [!NOTE]title` keeps its text, because a title needs a space before it.
- A quote with `[1]` or `[!anything]` later in it, or on a later line, is untouched.
- A marker inside a quote nested in another quote is ordinary text.

## Edit the marker

1. Put the caret in the callout.
2. Press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown** from the block menu or the right-click menu. The marker line appears.
3. Press it again to put the Markdown away.

## Good to know

- A fold marker, `+` or `-` straight after the `]`, is hidden with the rest of the marker. Every callout is drawn open.
- Every colour comes from your editor theme. Callouts stay legible when you switch between light, dark and high-contrast themes, and they match the colours the rest of your editor uses for information, warnings and errors.
- The marker line stays in the file exactly as you wrote it. Drawing a callout never changes your document: opening a file full of them and moving through it leaves every byte as it was.
