---
title: Table of contents
summary: Show a panel of the document's headings beside the text, and jump around a long document from it.
order: 4
---

# Table of contents

A long document is hard to see the shape of. Turn on the table of contents and a panel of the document's headings sits beside the text, so you can read the outline and jump to any part of it. It is off until you ask for it.

## Turn it on

Do either of these:

- Press the table of contents button in the toolbar. It cycles three states: showing, folded, gone.
- Run **Sheaf: Toggle Table of Contents** from the Command Palette. It turns the panel on or off.

Three more commands go straight to one state, where the button goes through them in turn: **Sheaf: Show Table of Contents**, **Collapse Table of Contents** and **Hide Table of Contents**. From the Command Palette, Collapse is the only way to ask for the folded one.

The choice is remembered, and it applies to every document you open in Sheaf, not just the one in front of you. You can also set **Sheaf: Table of Contents** in Settings, which takes the same three values: `shown`, `collapsed` and `hidden`.

There is no shortcut on it by default, because every obvious chord is already taken by the editor. To bind one yourself, search for the command in Keyboard Shortcuts.

## Fold the list away

Press the panel's header, **Contents**, to fold the list away, and press it again to bring it back. Folded, the header stays, so you can see the document has an outline and one press opens it. The text column does not move either way, so nothing you are reading shifts under you.

Folding is remembered for that document, so one long file can keep its list folded while every other one opens the way the setting says. The setting itself takes `collapsed` too, for anyone who wants the header there and the list out of the way in every document.

## Set it for one document or for all of them

Right-click the panel. It offers all three states for the document in front of you, and two items that say how far the choice reaches:

- **Use this everywhere** makes what this document is doing the setting.
- **Reset to default** hands the document back to the setting.

The toolbar button always sets the default: press it and this document stops overriding it, so the press does something you can see. Its tooltip names the state it is in and what the next press does.

## Jump to a heading

Click an entry. That heading comes to the top of the editor and the caret lands at the first character of the heading text, so you can start typing there.

From the keyboard, press Tab to reach the panel, Up and Down to move between headings, and Enter to jump to one. Escape puts you back in the text where your caret was.

The heading you are currently under is marked, and the mark moves as you scroll. If it scrolls out of sight, the panel scrolls to keep it visible.

## Use it in a narrow pane

When there is no room for a panel beside the text, it covers the right edge of the editor instead. Picking a heading puts it away again, and the toolbar button brings it back. Turning the panel on never moves your text: the column stays exactly where it was.

## Keys

| Key | Does |
| --- | --- |
| Tab | Reach the panel |
| Up, Down | Move between headings |
| Enter | Jump to the heading |
| Escape | Go back to the text where your caret was |

## Good to know

Each entry reads as the heading reads, rather than as it is written. This heading is listed as "Pricing and plans":

```markdown
## **Pricing** and [plans](https://example.com/plans)
```

- The panel lists headings from level 1 to level 3, indented by level. Setext headings (the kind underlined with `===` or `---`) are listed the same as the `#` kind.
- A `#` line inside a code block, inside front matter or inside an HTML block is not a heading, so it is not listed.
- A long heading is cut short with an ellipsis, and hovering it shows the whole thing.
- The list follows the document as you write: a heading you type appears, and one you delete goes. A document with no headings says so rather than showing you an empty panel.
- Jumping to a heading changes nothing in the document and adds nothing to undo.
