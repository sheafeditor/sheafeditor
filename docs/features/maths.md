---
title: Maths
summary: Equations written with dollar signs are typeset in place, and prices are left alone.
order: 5
---

# Maths

Maths written the way GitHub reads it is typeset where it sits:

```markdown
At $f = 8.45$ GHz the free-space loss is

$$
L_{fs} = 20\log_{10}(d) + 20\log_{10}(f) - 147.55
$$
```

`$…$` inside a sentence is drawn in the line. `$$…$$` on its own lines is drawn as a block, centred like the equation it is.

The fonts ship inside the extension, so this works with no network and nothing to configure.

## A price is still a price

A dollar sign is far commoner in these documents than an equation, so the rules for what counts as maths are narrow, and they are the ones GitHub uses:

- `It cost $20` and `$5 or $10 in the sale` are text.
- A `$` inside inline code or a fenced code block is text.
- `\$5` is text.
- There is no space directly inside the delimiters, so `$ x $` is text.
- A closing `$` is not followed by a digit, so `$x$5` is text.

If something you wrote is being read as maths when you meant a dollar sign, escape it as `\$`.

## While you are writing one

An equation that does not parse keeps its source on screen with a wavy underline, and the reason is in the tooltip. Every equation looks like that for a moment while it is being typed, so it is marked quietly rather than replaced with an error.

To see and change the source of an equation that is already drawn, put the caret in it and press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown**. Press it again to put the Markdown away.

## Wide equations

An equation wider than your text column scrolls inside its own box rather than stretching the column or being cut off. The box is a stop on the Tab key, so the scrolling is reachable from the keyboard.

Nothing here changes your document. Typesetting is drawing, and the file keeps the dollars exactly as you wrote them.
