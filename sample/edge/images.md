# Images

Every way an image can appear, including the ones Sheaf upgrades to inline HTML.

Markdown itself has no syntax for size, alignment, or captions. Sheaf writes the HTML for exactly the image you acted on and leaves every other byte alone — so a resized image looks like the block below, and the rest of the file is untouched.

## Plain Markdown images

Inline in a sentence: here is a dot ![dot](../assets/dot.png) mid-paragraph.

Block image on its own line:

![A ferry terminal at dawn](../assets/terminal-dawn.png)

With a title attribute:

![A loaf on a board](../assets/rye-loaf.png "Seeded rye and buttermilk loaf")

Empty alt text (decorative):

![](../assets/dot.png)

Reference-style:

![Terminal at dawn][dawn]

[dawn]: ../assets/terminal-dawn.png "Reference-style image"

Linked image — clicking should follow the link, not open the editor:

[![dot](../assets/dot.png)](https://example.com)

## Sized and aligned (HTML upgrade)

<img src="../assets/terminal-dawn.png" alt="Half width" width="320">

<p align="center">
  <img src="../assets/rye-loaf.png" alt="Centred, 400px" width="400">
</p>

<img src="../assets/dot.png" alt="Tiny" width="16" height="16"> — sized inline, next to text.

<figure>
  <img src="../assets/conflict-inline.png" alt="An editor showing an inline warning" width="560">
  <figcaption>A caption, which Markdown has no way to express.</figcaption>
</figure>

## Overflow

Wider than any editor pane — should scale down or scroll, never push the layout sideways:

![A very wide diagram](../assets/wide-diagram.png)

Taller than the pane:

![A tall chart](../assets/tall-chart.png)

## Broken and unusual sources

Missing file:

![This file does not exist](../assets/does-not-exist.png)

Missing file, with a title:

![Also missing](../assets/nope.png "Should show a placeholder, not vanish")

Absolute remote URL (will not load offline):

![Remote image](https://example.invalid/remote.png)

Data URI — a 1×1 transparent GIF:

![Data URI](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)

SVG by path:

![An SVG](../assets/does-not-exist.svg)

Path with spaces and parentheses:

![Spaces](<../assets/dot.png>)

## Images in other containers

In a list:

- First item
- Item with an image: ![dot](../assets/dot.png)
- Item with a block image below it:

  ![Terminal](../assets/terminal-dawn.png)

- Last item

In a table:

| Preview | Name | Size |
| :---: | :--- | ---: |
| ![dot](../assets/dot.png) | dot.png | 16×16 |
| ![dot](../assets/dot.png) | dot.png again | 16×16 |
| ![missing](../assets/nope.png) | missing.png | — |

In a blockquote:

> ![dot](../assets/dot.png)
>
> An image inside a quote.

In a heading:

### A heading with ![dot](../assets/dot.png) in it

Inside a code fence — this must render as text, not as an image:

```markdown
![not rendered](../assets/terminal-dawn.png)
<img src="../assets/dot.png" width="16">
```
