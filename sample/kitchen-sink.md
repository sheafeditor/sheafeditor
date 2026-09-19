# Kitchen Sink — Every Formatting Type

This document exercises every Markdown construct the editor renders. Open it in **Sheaf (WYSIWYG)** to see live preview; put your cursor on a line (or double-click an element) to reveal its raw Markdown.

## Headings

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Setexdt heading, level 1
=======================
    

Setext heading, level 2
-----------------------

## Inline text formatting

Plain paragraph text with **bold**, *italic*, ***bold italic***, and ~~strikethrough~~. You can also write `inline code` mid-sentence, and combine things like **bold with `code` inside** or *italic with a [link](https://example.com)*.

Here is `const x = 42;` as inline code, an em-dash — like this, and an ellipsis…

## Links

- Inline link: [OpenAI](https://openai.com).
- Link with title: [hover me](https://example.com "A title tooltip")
- Autolink: <https://www.codemirror.net>
- Reference link: [CodeMirror docs][cm]

[cm]: https://codemirror.net/docs/

## Images

![A placeholder image](https://placehold.co/600x200/png)

![Inline data image](data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='40'><rect width='120' height='40' fill='%234f46e5'/><text x='60' y='25' fill='white' font-family='sans-serif' font-size='14' text-anchor='middle'>SVG</text></svg>)

Hover an image for the toolbar (width presets S/M/L/Full, alignment, alt, caption), or drag the corner handle to resize. **Drag an image file in, or paste a screenshot**, and it's saved to `assets/` and inserted for you.

A sized, right-aligned image (HTML — set via the toolbar):

<img src="https://placehold.co/300x120/png" alt="Sized image" width="300" align="right">

A centered image with a caption (`<figure>`):

<figure><img src="https://placehold.co/400x140/png" alt="Captioned" width="400"><figcaption>A caption rendered under the image.</figcaption></figure>

## Blockquotes

> This is a blockquote. It can span multiple lines and contains **formatting**, `code`, and [links](https://example.com).
>
> > Nested blockquotes work too.

## Lists

### Unordered

- First item
- Second item
  - Nested item
  - Another nested item
    - Deeply nested
- Third item with **bold** and `code`

### Ordered

1. First step
2. Second step
   1. Sub-step A
   2. Sub-step B
3. Third step

### Task list

- [x] Completed task
- [ ] Pending task
- [ ] Task with a [link](https://example.com)
- [x] ~~Done and struck through~~

## Code blocks

```js
// JavaScript
function greet(name) {
  return `Hello, ${name}!`;
}
console.log(greet('world'));
```

```python
# Python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

```json
{
  "name": "sheafeditor",
  "wysiwyg": true,
  "engine": "codemirror6"
}
```

```
Plain code block with no language.
Indentation and spacing   are   preserved.
```

## Horizontal rules

Above the rule.

---

Between rules.

***

Below the rules. Testing


## Tables (GFM)

| Feature        | Supported | Notes                     |
| -------------- | :-------: | ------------------------- |
| Headings       |    ✅     | H1–H6 + setext            |
| Bold / italic  |    ✅     | plus strikethrough        |
| Task lists     |    ✅     | interactive checkboxes    |
| Tables         |    ✅     | pipe + CSV, double-click to edit |

Both pipe tables and CSV data blocks render as grids. Double-click a table to edit its raw source; click away to re-render.

## Tables (CSV data block)

```csv
Region,Q1,Q2,Q3,Q4
North,120,135,150,90
South,98,110,102,140
West,210,180,199,205
```

## Escapes and edge cases

- Escaped characters: \*not italic\*, \`not code\`, \# not a heading.
- A literal backtick in code: `` ` ``
- Emoji render as text: 🚀 ✨ 📝
- Hard line break (two trailing spaces):  
  this text is on a new line.

## Front matter

Some files begin with YAML front matter:

    ---
    title: Example
    tags: [markdown, wysiwyg]
    ---

That's the whole kitchen sink.
