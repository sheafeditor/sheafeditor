# Welcome to Sheaf

This is a **WYSIWYG Markdown editor** for VS Code, built on _CodeMirror 6_ and styled like a modern block editor. The file on disk stays plain Markdown — what you see is a ~~preview pane~~ live rendering you can type into.

## How it works

Put your cursor on a line to reveal its raw Markdown; move away and it renders again. **Double-click** any element to edit its source. Everything is `inline code`-friendly.

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
