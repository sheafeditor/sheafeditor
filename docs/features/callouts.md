---
title: Callouts
summary: Quotes that open with a bracketed type are drawn as notes, tips, warnings and cautions.
order: 2
---

# Callouts

A blockquote whose first line is a bracketed type is an alert, and Sheaf draws it as one: the type's icon and label in place of the marker, and the quote's rule in that type's colour.

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

The type may be written in any case, so `[!note]` and `[!NOTE]` are the same callout.

## Titles, fold markers and other types

Callouts with a title, a fold marker or their own type are drawn too:

```markdown
> [!question]- Why does the snapshot change?
> Older replicas stored the index inline.
```

- **A title** after the marker, separated by a space, is the callout's label in place of the type's name.
- **A fold marker**, `+` or `-` straight after the `]`, is hidden with the rest of the marker. Every callout is drawn open.
- **Any other type** is labelled with its own name, as you wrote it, and takes the closest of the five styles:

| Types | Style |
| --- | --- |
| `info`, `todo`, `abstract`, `summary`, `tldr`, `example`, `quote`, `cite` | Note |
| `hint`, `success`, `check`, `done`, `question`, `help`, `faq` | Tip |
| `attention` | Warning |
| `danger`, `error`, `bug`, `failure`, `fail`, `missing` | Caution |

A type not in the table takes the Note style. Type names are letters, digits and hyphens.

## What stays an ordinary quote

The marker has to open the quote's first line, with the `!` inside the brackets. That rule is what keeps the rest of your writing safe from being read as a callout:

- `> [draft] notes` and `> [ ] x` keep their text, because there is no `!`.
- `> [!NOTE]title` keeps its text, because a title needs a space before it.
- A quote with `[1]` or `[!anything]` later in it, or on a later line, is untouched.
- A marker inside a quote nested in another quote is ordinary text.

## Colours

Every colour comes from your editor theme rather than from Sheaf, so callouts stay legible when you switch between light, dark and high-contrast themes, and they match the colours the rest of your editor already uses for information, warnings and errors.

## Editing the marker

The marker line is still in the file exactly as you wrote it. To see it and change it, put the caret in the callout and press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown** from the block menu or the right-click menu. Press it again to put the Markdown away.

Drawing a callout never changes your document. Opening a file full of them and moving through it leaves every byte as it was.
