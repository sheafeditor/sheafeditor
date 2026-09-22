# Tier 1: CommonMark only

Everything in this file is [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) and nothing else. It should render identically in Sheaf, on GitHub, in Pandoc, and in any other conforming parser. If a construct here looks different in Sheaf from a reference renderer, that is a bug in Sheaf rather than a difference of dialect.

Deliberately absent: tables, task lists, strikethrough, bare URLs without angle brackets, alerts, footnotes, maths, and every data block. Those live in [github.md](github.md) and [sheaf.md](sheaf.md).

## Headings, both spellings

# Level 1
## Level 2
### Level 3
#### Level 4
##### Level 5
###### Level 6

Setext level 1
==============

Setext level 2
--------------

## Paragraphs and line breaks

One paragraph is a run of lines with no blank line between them, and the lines are joined with a space when it is drawn.

This line ends with two spaces,  
so the break is hard. This one uses a backslash,\
which is the other spelling of the same thing.

## Thematic breaks

All three spellings mean the same rule:

---

***

___

## Blockquotes

> A quote, which can run to several lines and is joined the same way a paragraph is.
>
> > A quote inside a quote, which is where quote handling usually goes wrong.
>
> Back to the outer level.

## Lists

Bullets, in all three markers:

- Hyphen
* Asterisk
+ Plus

Ordered, in both spellings, and one that does not start at 1:

1. First
2. Second

1) First again
2) Second again

7. Starts at seven
8. Eight

Nested, mixing markers and depths:

- Outer
  - Inner
    1. Deeper, ordered
    2. Still deeper
  - Back out
- Outer again

A loose list, where the blank lines between items make each one a paragraph:

- The first item, which is long enough to be a paragraph in its own right and is treated as one.

- The second item, separated by a blank line, which is what makes the list loose.

- The third.

A list item holding more than a line of text:

1. A step with a paragraph under it.

   This second paragraph belongs to the step, because it is indented to match.

2. A step with a quote under it.

   > Indented to the same column.

## Code

Indented four spaces, which is the older spelling:

    beaconctl status --once
    echo done

Fenced with backticks, with an info string:

```sh
beaconctl chain --select backup --confirm
```

Fenced with tildes, which is what you use when the content holds backticks:

~~~text
A line with `backticks` in it, and ``` for good measure.
~~~

Fenced with no info string at all:

```
Plain, unhighlighted.
```

## Inline

*Emphasis with asterisks* and _emphasis with underscores_.

**Strong with asterisks** and __strong with underscores__.

***Both at once***, and **nested *emphasis* inside strong**.

`Inline code`, and ``code holding a ` backtick``.

Backslash escapes, so these draw as characters rather than markup: \*not emphasis\*, \_not emphasis\_, \# not a heading, \[not a link\], \`not code\`.

Entity references, which stand for characters: &amp; &lt; &gt; &quot; &copy; &hellip; &#65; &#x1F41B;

## Links

An [inline link](https://example.com), and one [with a title](https://example.com "The title").

A [reference link][ref], a [collapsed one][], and a [shortcut].

An autolink in angle brackets: <https://example.com>, and an email one: <someone@example.com>.

A link whose address needs angle brackets because it holds a space: [like this](<a file with spaces.md>).

[ref]: https://example.com "Reference title"
[collapsed one]: https://example.com
[shortcut]: https://example.com

## Images

![A wide diagram, by inline address](../assets/wide-diagram.png)

![One by reference][img]

[img]: ../assets/terminal-dawn.png "An image title"

## Raw HTML

CommonMark passes HTML through without interpreting it as Markdown.

<div>
  A block-level element, whose contents are raw.
</div>

Inline, in the middle of a sentence: <span>a span</span>, <kbd>a key</kbd>, and <br> a break.

## Awkward but legal

A paragraph that begins with something list-like but is not one: 2024. It was a good year.

Emphasis inside a word works with asterisks, so un*frigging*believable, but not with underscores, so un_frigging_believable stays as it is typed.

A line that looks like a setext underline but follows a blank line is a thematic break instead:

---
