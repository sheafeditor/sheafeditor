# Inline Text Formatting

Every inline construct, isolated for testing the reveal-on-cursor behavior.

## Emphasis

- Bold with asterisks: **bold**
- Bold with underscores: __bold__
- Italic with asterisks: *italic*
- Italic with underscores: _italic_
- Bold italic: ***bold italic***
- Strikethrough: ~~struck~~
- Nested: **bold containing *italic* and `code`**
- Adjacent runs: **one****two** and *a**b***

## Inline code

- Simple: `code`
- With special chars: `a > b && c < d`
- Containing a backtick: `` use ` here ``
- Code that looks like markup: `<div class="x">`

## Links

- Bare inline: [example](https://example.com)
- With title: [example](https://example.com "Example Domain")
- Relative link: [see the readme](../README.md)
- Anchor link: [jump to code](#inline-code)
- Autolink: <https://codemirror.net>
- Email autolink: <hello@example.com>
- Reference style: [reference][ref-1] and collapsed [ref-1][]

[ref-1]: https://example.com/reference

## Mixed sentence

The quick **brown** fox *jumps* over the ~~lazy~~ `sleeping` dog, then reads [the docs](https://example.com) — all in ***one*** line to stress the parser.

## Special characters

- Em dash — en dash – hyphen -
- Ellipsis…
- Escaped: \*literal asterisks\*, \_literal underscores\_, \`literal backticks\`
- Ampersand & angle brackets < > that must not break rendering
