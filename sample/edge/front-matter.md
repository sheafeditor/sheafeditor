---
# YAML front matter, exercising most of the type system
title: "Front matter: every shape"
subtitle: 'Single quoted, with a colon: inside'
draft: true
weight: 42
ratio: 0.618
published: 2044-05-14
updated: 2044-05-14T09:30:00Z
tags: [markdown, front-matter, sample]
categories:
  - reference
  - edge cases
authors:
  - name: A. Okonkwo
    role: editor
  - name: M. Lindqvist
    role: reviewer
redirects:
  - /old/path
  - /older/path
nested:
  level_one:
    level_two:
      level_three: deep value
      list: [1, 2, 3]
empty_value:
null_value: null
bool_yes: yes
bool_true: true
multiline_folded: >
  This is folded scalar text. Newlines
  become spaces when it is parsed.
multiline_literal: |
  This is a literal block.
  Line breaks are preserved.
      Including indentation.
quoted_special: "a string with --- three dashes and a # hash"
unicode: "日本語, עברית, emoji 🚢"
---

# Front Matter

The block above is YAML front matter: metadata for the tools that consume this file, not content. It must render as a metadata block (or as hidden syntax) but never as a horizontal rule followed by a mangled paragraph, and it must survive editing the body below without being reformatted.

## Rules worth checking

1. Front matter only counts when the file **starts** with `---` on line 1 — no blank line, no BOM before it.
2. The closing delimiter can be `---` or `...`.
3. Anything after the closing delimiter is ordinary Markdown.
4. A `---` later in the document is a horizontal rule, not a second front-matter block.

Here is that fourth case:

---

That was a horizontal rule.

## Other front-matter dialects

Different tools use different delimiters. Only the first block in a file is front matter; the ones below are content, and this file shows how each renders when it is *not* in the leading position.

TOML front matter, used by Hugo — delimited by `+++`:

```toml
+++
title = "TOML front matter"
date = 2044-05-14T09:30:00Z
draft = false
weight = 42

[taxonomies]
tags = ["markdown", "sample"]

[extra]
toc = true
+++
```

JSON front matter, used by a few static site generators:

```json
{
  "title": "JSON front matter",
  "date": "2044-05-14",
  "tags": ["markdown", "sample"],
  "draft": false
}
```

MultiMarkdown metadata — no delimiters at all, just key-value pairs before the first blank line:

```text
Title:    MultiMarkdown metadata
Author:   A. Okonkwo
Date:     2044-05-14
Keywords: markdown, sample
```

## Body content

Ordinary Markdown resumes and behaves normally: **bold**, `code`, a [link](https://example.com), and a table.

| Field | Type | Required |
| :--- | :--- | :---: |
| `title` | string | yes |
| `draft` | boolean | no |
| `weight` | integer | no |
| `tags` | string[] | no |

- [ ] Editing this list must not reformat the front matter above
- [ ] Adding a key to the front matter must not reflow the body
