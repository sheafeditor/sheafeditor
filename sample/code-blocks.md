# Code Blocks

Fenced code across languages (for nested-language highlighting) plus edge cases.

## JavaScript

```js
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
```

## TypeScript

```ts
interface Point {
  x: number;
  y: number;
}

const dist = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);
```

## Python

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

    def dist(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
```

## Rust

```rust
fn main() {
    let nums = vec![1, 2, 3, 4, 5];
    let sum: i32 = nums.iter().sum();
    println!("sum = {sum}");
}
```

## HTML

```html
<!DOCTYPE html>
<html>
  <body>
    <h1 class="title">Hello</h1>
  </body>
</html>
```

## CSS

```css
.sheaf {
  max-width: 740px;
  margin: 0 auto;
  line-height: 1.65;
}
```

## Shell

```bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "Processing $f"
done
```

## JSON

```json
{
  "editor": "codemirror6",
  "features": ["wysiwyg", "live-preview"],
  "nested": { "ok": true }
}
```

## Diff

```diff
- const old = true;
+ const updated = false;
```

## No language

```
Just a plain fenced block.
No highlighting. Spacing    preserved.
```

## Indented code block (4 spaces)

    This is an indented code block.
    It uses four leading spaces instead of fences.

## Inline vs block

Inline `code` should stay inline; the block below should be its own element:

```
block
```
