---
title: Block Elements
tags: [markdown, sample]
author: Sheaf
---

# Block Elements

This file leads with YAML front matter (above) and exercises block-level constructs: headings, blockquotes, rules, tables, and callout-style quotes.

## Blockquotes

> A single-line quote.

> A multi-line quote that keeps going onto a second line and a third line so we can see how the left rule renders down the whole block.

> Quote with **bold**, *italic*, `code`, and a [link](https://example.com).

> Level one
> > Level two
> > > Level three

## Callout-style (blockquote + emoji lead)

> 💡 **Tip:** This is a lightweight callout built from a blockquote with an emoji and bold lead-in — the pattern block-based editors use for callouts.

> ⚠️ **Warning:** Careful with this one.

## Horizontal rules

Three ways to write a rule:

---

***

___

## Tables

Basic table:

| Name  | Role      | Active |
| ----- | --------- | ------ |
| Ada   | Engineer  | yes    |
| Alan  | Theorist  | yes    |
| Grace | Admiral   | no     |

Aligned columns:

| Left | Center | Right |
| :--- | :----: | ----: |
| a    |   b    |     c |
| dd   |   ee   |    ff |

Table with formatting in cells:

| Feature | Example                       |
| ------- | ----------------------------- |
| Bold    | **strong**                    |
| Code    | `inline()`                    |
| Link    | [docs](https://example.com)   |

## Heading rhythm

# H1 sets the top rhythm

Paragraph after H1.

## H2 follows

Paragraph after H2.

### H3 for subsections

Paragraph after H3, with a final line to close the document.
