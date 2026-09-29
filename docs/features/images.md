---
title: Images
summary: Paste, drop or insert pictures that draw where they sit, then resize, align or caption them in place.
order: 9
---

# Images

An image in your document is drawn as the picture, where it sits in the text. You can paste or drop one in, and resize, align or caption it in place.

## Add an image

Do any of these:

- Paste an image with Cmd+V (Ctrl+V on Windows and Linux).
- Drop image files onto the document.
- Choose **Insert > Image** on the toolbar and pick files.

Each file is saved in an `assets` folder beside the document and linked from where you are writing with a relative path. The saved name keeps letters, digits, `.`, `_` and `-`, with anything else turned into a hyphen, and gets `-1`, `-2` and so on when the name is already taken.

If an image cannot be saved, Sheaf says why. That happens, for example, in a document that has never been saved, or where the `assets` folder cannot be created.

## Resize, align or caption an image

Hover an image, or select it, and a toolbar appears over it:

| Button | Does |
| --- | --- |
| **S**, **M**, **L** | Sets the width to 240, 420 or 640 pixels |
| **Full** | Takes the width off, so the picture fills the column |
| Align left, centre, right | Aligns the picture; pressing the one already on takes it off |

Left and right put the picture against that edge and let the text run up its side, which is what the same document does on GitHub. Centre gives the picture a band of its own, with the text above and below it.

| **Alt** | Edits the alternative text a screen reader reads |
| **Caption** | Adds or edits a caption under the picture |
| Replace image file | Picks a new file for the same image |

To resize by dragging, drag the corner grip at the bottom right of the picture. A selected image shows a ring around the picture and its caption.

## Edit an image's Markdown

Put the caret on the image's line and press **Edit Markdown** (Cmd+Alt+E). The image's source appears, and you can edit it directly.

## Good to know

Every way Markdown writes an image is drawn, including a path with spaces in angle brackets, a reference-style image, and an `<img>` tag, on its own or inside `<p align="center">` or a `<figure>`:

```markdown
![A chart](assets/chart.png)
![A chart](<assets/chart two.png>)
![A chart][chart]
<img src="assets/chart.png" alt="A chart" width="420">
```

- A file that cannot be found is drawn as a placeholder that says so, rather than as an empty space.
- An image written with a `height` and no `width` is drawn at that height, which is what you get when you paste an `<img>` in from elsewhere. Where a picture has both, the width is what Sheaf draws from and the height is kept in step with it.
- Markdown has no way to write a width, an alignment or a caption, so an image that has any of them is written as one line of HTML, which GitHub and most Markdown readers display.
- An image set back to Full with no alignment or caption goes back to plain Markdown.
- Only that image's line changes, and each change is one undo step.
