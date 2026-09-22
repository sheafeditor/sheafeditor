---
title: Table of contents
summary: An optional panel of the document's headings, for moving around a long document.
order: 4
---

# Table of contents

A long document is hard to see the shape of. Turn the table of contents on and a panel of the document's headings sits beside the text, so you can read the outline and jump to any part of it.

It is off until you ask for it.

## Turning it on

Either of these turns it on, and either turns it off again:

- the table of contents button in the toolbar
- **Sheaf: Toggle Table of Contents** in the Command Palette

There is no shortcut on it by default, because every obvious chord is already taken by the editor. Bind one yourself if you want it: search for the command in Keyboard Shortcuts.

The choice is remembered, and it applies to every document you open in Sheaf, not just the one in front of you. You can also set **Sheaf: Table of Contents** in Settings.

## What it lists

Headings from level 1 to level 3, indented by level. Setext headings (the kind underlined with `===` or `---`) are listed the same as the `#` kind. A `#` line inside a code block, inside front matter or inside an HTML block is not a heading, so it is not listed.

Each entry reads as the heading reads, rather than as it is written. This heading:

```markdown
## **Pricing** and [plans](https://example.com/plans)
```

is listed as "Pricing and plans". A long heading is cut short with an ellipsis, and hovering it shows the whole thing.

The list follows the document as you write: a heading you type appears, and one you delete goes. A document with no headings says so rather than showing you an empty panel.

## Reading and jumping

The heading you are currently under is marked, and the mark moves as you scroll. If it scrolls out of sight, the panel scrolls to keep it visible.

Clicking an entry brings that heading to the top of the editor and puts the caret at the first character of the heading text, so you can start typing there. It changes nothing in the document and adds nothing to undo.

From the keyboard, Tab reaches the panel, Up and Down move between headings, Enter jumps to one, and Escape puts you back in the text where your caret was.

## In a narrow pane

When there is no room for a panel beside the text, it covers the right edge of the editor instead. Picking a heading puts it away again, and the toolbar button brings it back. Turning the panel on never moves your text: the column stays exactly where it was.
