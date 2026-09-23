# Welcome to Sheaf

This is a **WYSIWYG Markdown editor** for VS Code, built on _CodeMirror 6_ and styled like a modern block editor. The file on disk stays plain Markdown, and what you see is a ~~preview pane~~ live rendering you can type into.

## How it works

Type straight into the document: the markers are hidden and what they mean is drawn instead. To see the Markdown behind a block, put the cursor in it and press **Cmd+Alt+E** (Ctrl+Alt+E on Windows and Linux); press it again to put it away. Everything is `inline code`-friendly.

### Lists

- A bullet list item
- Another one, with **bold** and a [link](https://codemirror.net)
- Task items:

- [x] Research the architecture
- [ ] Ship v1

1. Ordered lists work too
2. With numbers preserved

> Blockquotes get a quiet left rule. They can span multiple lines.

---

### Code

Inline `const x = 42` and fenced blocks with highlighting:

```ts
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

### Images

![CodeMirror logo](https://codemirror.net/style/logo.svg)

Happy writing.
