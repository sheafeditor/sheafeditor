---
title: Maths
summary: Write equations between dollar signs and see them typeset in place, while prices stay prices.
order: 5
---

# Maths

Write maths the way GitHub reads it, between dollar signs, and you see it typeset where it sits. A dollar sign in a price stays a dollar sign.

## Write an equation

Put `$…$` around maths inside a sentence to draw it in the line. Put `$$` on the lines above and below an equation to draw it as a block, centred like the equation it is.

```markdown
At $f = 8.45$ GHz the free-space loss is

$$
L_{fs} = 20\log_{10}(d) + 20\log_{10}(f) - 147.55
$$
```

## Write a price with a dollar sign

Write it as you normally would. A dollar sign is far commoner in these documents than an equation, so the rules for what counts as maths are narrow, and they are the ones GitHub uses:

- `It cost $20` and `$5 or $10 in the sale` are text.
- A `$` inside inline code or a fenced code block is text.
- `\$5` is text.
- There is no space directly inside the delimiters, so `$ x $` is text.
- A closing `$` is not followed by a digit, so `$x$5` is text.

If something you wrote is read as maths when you meant a dollar sign, escape it as `\$`.

## Fix an equation that will not draw

Hover over the wavy underline to read the reason in the tooltip. An equation that does not parse keeps its source on screen with that underline. Every equation looks like that for a moment while you type it, so it is marked quietly and never replaced with an error.

## Edit an equation

1. Put the caret in the equation.
2. Press Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), or choose **Edit Markdown**. The source appears.
3. Press it again to put the Markdown away.

## Scroll a wide equation

An equation wider than your text column scrolls inside its own box, so it neither stretches the column nor gets cut off. The box is a stop on the Tab key: press Tab to reach it, and scroll it from the keyboard.

## Good to know

- The fonts ship inside the extension, so maths works with no network and nothing to configure.
- Typesetting is drawing. The file keeps the dollars exactly as you wrote them.
