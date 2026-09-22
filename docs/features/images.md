---
title: Images
summary: Pictures drawn where they sit, pasted or dropped into the document, and resized, aligned or captioned in place.
order: 9
---

# Images

An image in the document is drawn as the picture, where it sits in the text. Every way Markdown writes one is read, including a path with spaces in angle brackets, a reference-style image, and an `<img>` tag, on its own or inside `<p align="center">` or a `<figure>`:

```markdown
![A chart](assets/chart.png)
![A chart](<assets/chart two.png>)
![A chart][chart]
<img src="assets/chart.png" alt="A chart" width="420">
```

A file that cannot be found is drawn as a placeholder that says so, rather than as an empty space.

Press **Edit Markdown** (Cmd+Alt+E, Ctrl+Alt+E on Windows and Linux) on the line to see and edit the image's source.

## Adding an image

Paste an image with Cmd+V (Ctrl+V), drop image files onto the document, or choose **Insert > Image** on the toolbar to pick files. Each file is saved in an `assets` folder beside the document and linked from where you are writing with a relative path. The saved name keeps letters, digits, `.`, `_` and `-`, with anything else turned into a hyphen, and gets `-1`, `-2` and so on when the name is already taken.

If an image cannot be saved, for example in a document that has never been saved or where the `assets` folder cannot be created, Sheaf says why.

## Resizing, aligning and captioning

Hover an image, or select it, and a toolbar appears over it:

| Button | Does |
| --- | --- |
| **S**, **M**, **L** | Sets the width to 240, 420 or 640 pixels |
| **Full** | Takes the width off, so the picture fills the column |
| Align left, centre, right | Aligns the picture; pressing the one already on takes it off |
| **Alt** | Edits the alternative text a screen reader reads |
| **Caption** | Adds or edits a caption under the picture |
| Replace image file | Picks a new file for the same image |

The corner grip at the bottom right resizes the picture by dragging. A selected image shows a ring around the picture and its caption.

Markdown has no way to write a width, an alignment or a caption, so an image that has any of them is written as one line of HTML, which GitHub and most Markdown readers display. An image set back to Full with no alignment or caption goes back to plain Markdown. Only that image's line changes, and each change is one undo step.
