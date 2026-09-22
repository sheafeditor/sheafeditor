---
title: Menus
summary: The right-click menu and the toolbar that appears over a selection, and what each is for.
order: 6
---

# Menus

Two surfaces act on the text in front of you. The toolbar appears when you select something; the right-click menu appears where you point.

## The toolbar over a selection

Select any text and a small toolbar opens just clear of it:

**Edit Markdown**, then Bold, Italic, Strikethrough, Highlight, Inline code, Link, Clear formatting, and a **Turn into** menu for changing what kind of block the lines are.

Edit Markdown comes first because it is the one thing here that no other editor gives you: it shows the raw Markdown of the block you selected in, so you can see and fix exactly what is written. The toolbar puts itself away when you use it, rather than sitting over the Markdown you asked to see. Cmd+Alt+E (Ctrl+Alt+E) does the same thing from the keyboard.

Inside a link, the Link button reads **Remove link** and does that instead.

From the keyboard: Alt+F10 moves into the toolbar, the arrow keys move along it, and Escape puts you back in the text.

The toolbar stays out of the way where it could not do anything: inside a code block, over front matter, and over a selection of only spaces.

## The right-click menu

Right-click (or Ctrl-click) anywhere in your text:

1. **Turn into**, for making the lines a heading, a list, a quote or a code block
2. **Edit Markdown**
3. Highlight, Inline code, Link, Clear formatting
4. **Copy ref**

Turn into leads, because changing what you clicked into something else is usually why you opened a menu on it. The submenu checks the kind the block already is. It carries all six heading levels, with a rule after Heading 3 separating the three you reach most often from the deeper ones. Cmd+Alt+1, 2 and 3 (Ctrl+Alt on Windows and Linux) set the first three from the keyboard; levels 4 to 6 have no shortcut, because those numbers already belong to other blocks.

**Copy ref** puts a reference to what you clicked on the clipboard: the file and line numbers, then the text itself in a fenced block, ready to paste into a chat with an agent.

Where the click lands adds to the menu. On a link: Open link, Copy link address, Remove link. In a code block: Copy code, which gives you the code without its fences. On a task: Mark done or Mark not done. Anything that cannot apply where you clicked is shown as unavailable rather than quietly missing, so front matter and code blocks both keep the menu's shape.

### What is not in it

Cut, Copy, Paste, Bold, Italic and Strikethrough are not in this menu. Every one of them has a keyboard shortcut you already know, and the last three are on the toolbar that appears the moment you select something, which is when they become useful. Leaving them out is what makes room for the commands that are specific to Sheaf.

### From the keyboard

Shift+F10 opens the menu at the caret. The arrow keys walk only the items you can actually use, Home and End jump to the first and last, Right opens Turn into and Left leaves it, and Escape closes the menu and puts the caret back where it was.

The menu closes if the document changes while it is open, so an item can never act on text that has moved underneath it.
