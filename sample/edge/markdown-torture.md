# Markdown Torture Test

Constructs that are legal, ambiguous, or actively hostile. Every block below has a *correct* rendering; the point is to notice when Sheaf picks a different one.

## Escapes

Escaped syntax characters should print literally, not format:

\*not italic\* · \_not italic\_ · \*\*not bold\*\* · \`not code\` · \# not a heading · \> not a quote · \[not a link\](x) · \| not a cell \| · \~\~not struck\~\~

A literal backslash before a real one: \\*this is italic*\\

Backslash at end of line forces a hard break:\
this is the next line.

Two trailing spaces also force a break:  
this is the line after that.

## Emphasis ambiguity

- `*single*` → *single*
- `**double**` → **double**
- `***triple***` → ***triple***
- `****quad****` → ****quad****
- `*a **b** c*` → *a **b** c*
- `**a *b* c**` → **a *b* c**
- Intraword underscores: snake_case_name stays plain, but *star*emphasis*bites*
- `a*b*c` → a*b*c · `a_b_c` → a_b_c
- Unmatched: *this never closes
- Closing without opening: this closes* here
- Emphasis around punctuation: **"quoted"** and *(parenthesised)* and _"both"_

## Inline code

- One backtick: `code`
- Backtick inside: `` a ` b ``
- Two backticks inside: ``` a `` b ```
- Leading/trailing space stripped: `` ` ``
- Code containing markdown: `**not bold** and [not a link](x)`
- Code containing a pipe inside a table cell is below, in the tables section.
- Unclosed span: `this backtick never closes

## Links and references

- Bare autolink: <https://example.com/path?a=1&b=2>
- Email autolink: <someone@example.com>
- Inline with title: [link](https://example.com "Title here")
- Inline with parens in URL: [link](https://example.com/a_(b)_c)
- Angle-bracket URL with a space: [link](<https://example.com/a b>)
- Reference: [reference link][ref]
- Collapsed: [ref][]
- Shortcut: [ref]
- Undefined reference: [missing][nope]
- Empty text: [](https://example.com)
- Nested brackets: [a [b] c](https://example.com)
- Link inside emphasis: **[bold link](https://example.com)**
- Emphasis inside link: [*italic* link](https://example.com)
- Link that looks like an image: [![alt](../assets/dot.png)](https://example.com)

[ref]: https://example.com/reference "Reference title"

## Images

- Inline: ![alt text](../assets/dot.png)
- With title: ![alt](../assets/dot.png "Image title")
- Reference: ![alt][img]
- Missing file: ![this file does not exist](../assets/nope.png)
- Empty alt: ![](../assets/dot.png)
- Remote (may not load offline): ![remote](https://example.invalid/image.png)

[img]: ../assets/dot.png

## Headings

# ATX 1
###### ATX 6
####### Seven hashes is not a heading
#No space after hash is not a heading
### Closed ATX ###
###   Extra spaces after hash

Setext level 1
==============

Setext level 2
--------------

A setext underline needs a paragraph above it. This one has a blank line, so the dashes below are a horizontal rule instead:

---

### Heading with `code`, **bold**, and [a link](https://example.com)

## Lists

Tight list:

- one
- two
- three

Loose list (blank lines between items):

- one

- two

- three

Markers that change mid-list start a new list:

- dash
* star
+ plus

Ordered variants:

1. one
1. also one
1. still one

7. starts at seven
8. eight

1) paren delimiter
2) also paren

Nested with mixed markers:

1. outer
   - inner dash
     1. inner ordered
        - deepest

List item containing a fence:

- item with code:

  ```js
  const x = 1;
  ```

- next item

Task lists:

- [ ] unchecked
- [x] checked
- [X] capital X
- [ ] with **bold** and `code`
- [~] not a valid marker, renders as text
  - [ ] nested task
    - [x] deeper task

A list interrupted by a paragraph:

- item
not a new item, this is a lazy continuation

## Blockquotes

> Simple.

> Lazy continuation
without the marker on this line.

> - a list
> - inside a quote
>
> ```sh
> echo "and a fence inside a quote"
> ```
>
> | and | a table |
> | :-- | :------ |
> | in  | a quote |

>No space after the marker.

> > > Triple, then back to:
> Single.

## Horizontal rules

---
***
___
- - -
* * *
_ _ _
   ---
Text immediately after a rule with no blank line:
---

## Code blocks

Indented code block (four spaces):

    function indented() {
      return "no fence";
    }

Fenced with no language:

```
plain text, no highlighting
```

Fenced with an unknown language:

```notalanguage
this should still render as code
```

Fenced with attributes after the info string:

```js title="example.js" {1,3-4}
const a = 1;
const b = 2;
```

Tilde fences:

~~~python
print("tildes work too")
~~~

A fence containing a fence (outer uses four backticks):

````markdown
```js
const nested = true;
```
````

Fence containing what looks like markdown:

```
# not a heading
- not a list
| not | a table |
```

Unclosed fence at the end of a section:

```js
const unclosed = true;
```

## Tables

Minimal:

| a |
| - |
| 1 |

Missing leading and trailing pipes:

a | b
--- | ---
1 | 2

Ragged rows — too few and too many cells:

| a | b | c |
| - | - | - |
| 1 |
| 1 | 2 | 3 | 4 |
| 1 | 2 | 3 |

Empty cells and empty header labels:

|  | b |  |
| - | - | - |
| 1 |  | 3 |
|  |  |  |

Escaped pipes and code spans containing pipes:

| expression | meaning |
| :--- | :--- |
| `a \| b` | bitwise or |
| a \| b | escaped outside code |
| `\|` | a lone pipe |

Alignment row variants:

| left | center | right | none |
| :--- | :---: | ---: | --- |
| a | b | c | d |

Inline markup inside cells:

| markup | rendered |
| :--- | :--- |
| `**bold**` | **bold** |
| `[link](https://example.com)` | [link](https://example.com) |
| `` `code` `` | `code` |
| `~~strike~~` | ~~strike~~ |
| `![img](../assets/dot.png)` | ![img](../assets/dot.png) |
| line<br>break | line<br>break |

Not a table (no delimiter row):

| a | b |
| 1 | 2 |

## HTML

Inline: this is <em>emphasised</em>, this is <strong>strong</strong>, this is <code>code</code>, x<sup>2</sup> and H<sub>2</sub>O, <kbd>Ctrl</kbd>+<kbd>S</kbd>, <mark>highlighted</mark>, <abbr title="as soon as possible">ASAP</abbr>.

Self-closing and void elements: line<br>break, <hr>, <img src="../assets/dot.png" alt="dot" width="16">.

Block:

<div align="center">
  <strong>Centred HTML block</strong>
</div>

<details>
<summary>A collapsed section containing Markdown</summary>

This paragraph is **inside** the details element.

- and a list
- with two items

</details>

An HTML comment follows and should not render:

<!-- invisible: this text must not appear -->

Entities: &amp; &lt; &gt; &quot; &copy; &mdash; &nbsp; &#8364; &#x1F6A2; &notanentity;

## Front matter that is not at the top

The following is a horizontal rule and a paragraph, not front matter, because it is not the first thing in the file:

---
title: not front matter
---

## Footnotes

A claim needing support.[^1] Another one.[^long-name] A third.[^1]

[^1]: The first footnote.
[^long-name]: A footnote with a longer identifier, **formatted text**, and a [link](https://example.com).

## Line endings and whitespace

Trailing whitespace on the next line (three spaces):   
A line with	a literal tab between words.
A line with    four leading spaces inside a paragraph is not a code block.

Consecutive blank lines follow this one:



…and the paragraph resumes here.
