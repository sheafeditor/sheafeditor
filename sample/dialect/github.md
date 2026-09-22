# Tier 2: GitHub Flavored Markdown

Everything in [commonmark.md](commonmark.md), plus what GitHub adds. This file holds only the additions, so it is short and every line in it is a place Sheaf and a plain CommonMark parser will disagree.

Two different things are collected here. The first five sections are the [GFM spec](https://github.github.com/gfm/), version 0.29, which is a published standard with a conformance suite. The rest are things github.com renders that the GFM spec does not mention, which makes them conventions rather than specification. The distinction matters when deciding whether a difference is a bug.

## Tables

| Left | Centre | Right | Default |
| :--- | :---: | ---: | --- |
| a | b | c | d |
| A longer cell | centred | 1,024 | plain |
| `code` | **bold** | [link](https://example.com) | *emphasis* |

A cell can hold inline markup but not a block. A pipe inside a cell is escaped: \| like this.

| Ragged | Rows |
| :--- | :--- |
| Fewer cells than the header |
| One | Two | Three, which is one too many |

## Task list items

- [ ] An open task
- [x] A completed task
- [X] A completed task with a capital X
- A plain item, in the same list
  - [ ] A nested task
  - [x] A nested completed task

## Strikethrough

~~Two tildes~~ is the GFM spelling, and it is the only one the spec defines.

## Autolinks, without the angle brackets

GFM recognises addresses in running text, which CommonMark does not: https://example.com, www.example.com, and someone@example.com are all links here and all plain text in tier 1.

A trailing parenthesis is handled, so https://example.com/thing_(parenthesised) keeps its bracket, and a sentence ending in a link stops at the full stop: see https://example.com.

## Disallowed raw HTML

GFM filters a handful of tags for safety, so these are drawn as text rather than passed through: <title>, <textarea>, <style>, <xmp>, <iframe>, <noembed>, <noframes>, <script>, <plaintext>.

Every other tag passes through as it does in CommonMark: <span>this one is raw</span>.

## Alerts

Not in the GFM spec, but rendered on github.com, and the form most people mean by a callout.

> [!NOTE]
> Useful information a reader should notice even when skimming.

> [!TIP]
> Helpful advice for doing things better.

> [!IMPORTANT]
> Key information a reader needs to achieve their goal.

> [!WARNING]
> Urgent information needing immediate attention.

> [!CAUTION]
> Advises about risks or negative outcomes.

## Footnotes

Not in the GFM spec either, and not rendered by Sheaf today. A reference looks like this[^1], and its definition sits at the foot of the file.

[^1]: The note itself, which github.com moves to the bottom of the page and links back from.

## Heading anchors

github.com gives every heading an id derived from its text, which is what makes [a link to a heading](#tables) work inside a document and [across documents](commonmark.md#lists) between them.

## What is deliberately not here

GitHub also renders Mermaid, maths, and several data formats. Those are not GFM, they are site features, and Sheaf treats them as its own layer. They are in [sheaf.md](sheaf.md).
