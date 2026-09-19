# Lists

All list variants, including nesting and mixed content.

## Unordered lists

- Dash bullet
* Star bullet
+ Plus bullet

- Item one
- Item two
- Item three

## Nested unordered

- Level 1
  - Level 2
    - Level 3
      - Level 4
  - Back to level 2
- Level 1 again

## Ordered lists

1. First
2. Second
3. Third

## Ordered starting at an offset

3. Three
4. Four
5. Five

## Nested ordered

1. First
   1. First-first
   2. First-second
2. Second
   1. Second-first
      1. Deep
3. Third

## Mixed nesting

1. Ordered parent
   - Unordered child
   - Another child
     1. Ordered grandchild
     2. Sibling grandchild
2. Second parent
   - [ ] With a task
   - [x] And a done task

## Task lists

- [ ] Unchecked
- [x] Checked
- [ ] Task with **bold** and `code`
- [x] Task with a [link](https://example.com)
- [ ] Parent task
  - [x] Subtask done
  - [ ] Subtask pending

## Lists with rich content

- A list item with a paragraph of text that is long enough to wrap onto a second line so we can confirm hanging indentation looks right in the rendered view.

- An item followed by a code block:

  ```js
  const inList = true;
  ```

- An item with a blockquote:

  > Quoted inside a list.
