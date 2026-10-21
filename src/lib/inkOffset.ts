/*
 * A place in a surface's text, counted in a way both of its states agree on.
 *
 * A mounted surface is drawn twice: once as HTML by the render path, and again by the editor that
 * replaces it on first focus. The two put the same text in different places on screen, because the
 * editor has its own padding and, in a `notes` surface, its own side gutter. So a point taken from
 * the rendered state and handed to the editor as coordinates lands on whatever the editor has drawn
 * there, which for a click 90 pixels into a three-paragraph value was the paragraph above the one the
 * person pointed at.
 *
 * **The point is carried as text rather than as a position on screen.** The rendered state is asked
 * what character was under the pointer, the answer is counted, and the editor is asked where that
 * count falls in what it has drawn.
 *
 * **The count is of visible characters that are not whitespace**, and each of the three words is
 * there for a reason:
 *
 *   - *Visible*: the editor hides a construct's markers, the `**` of a strong span and the `[`,
 *     `](…)` of a link, by taking them out of the DOM, and the render path never emits them. So the
 *     text both states have in the DOM is the same text, and what one has and the other lacks is
 *     drawn by a widget, which is skipped by the caller.
 *   - *Not whitespace*: HTML folds a run of spaces and the line break between two paragraphs, and
 *     the editor keeps every one of them, so whitespace is the one thing the two states disagree on
 *     for ordinary prose. Leaving it out of the count is what lets a count from one be found in the
 *     other.
 *   - *Characters*: UTF-16 code units, the same unit on both sides, so a character outside the
 *     Basic Multilingual Plane counts twice in each and the two still agree.
 *
 * Nothing here imports anything, because both states read it: `index.ts` must not reach the editor,
 * and `editor.ts` must not reach the render path.
 */

/** Whether a subtree is drawn by something other than the text, and is left out of the count. */
export type Skip = (el: Element) => boolean;

const SPACE = /\s/;

function ink(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (!SPACE.test(text[i])) n++;
  return n;
}

/**
 * How many visible non-whitespace characters of `root` come before the DOM point `(node, offset)`.
 *
 * `null` when the point is not inside `root`, which is what a caller gets for a pointer over
 * something that is not this surface's text, and should read as "no answer" rather than as 0.
 */
export function inkBefore(root: Node, node: Node, offset: number, skip?: Skip): number | null {
  if (node !== root && !root.contains(node)) return null;
  let count = 0;
  let found = false;
  const walk = (at: Node): void => {
    if (found) return;
    if (at.nodeType === 3) {
      const text = (at as Text).data;
      if (at === node) {
        count += ink(text.slice(0, offset));
        found = true;
        return;
      }
      count += ink(text);
      return;
    }
    if (at.nodeType === 1 && at !== root && skip?.(at as Element)) {
      if (at === node || at.contains(node)) found = true;
      return;
    }
    const children = at.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (at === node && i === offset) {
        found = true;
        return;
      }
      walk(children[i]);
      if (found) return;
    }
    if (at === node) found = true;
  };
  walk(root);
  return found ? count : null;
}

/**
 * Which side of the counted characters a point sits on, which the count alone cannot say.
 *
 * A count of `k` is the same for the end of one paragraph and the start of the next, because only
 * whitespace lies between them, and those are a line apart. So the rendered state also says whether
 * the point was against the text after it or against the text before it: `after` when what follows
 * the point is whitespace or nothing at all, which is a click past the end of a line, and `before`
 * otherwise, which is a click at the start of a word or a paragraph.
 */
export type Side = 'before' | 'after';

/** The side of `(node, offset)` a caller should carry with its count, as `Side` describes. */
export function sideOf(node: Node, offset: number): Side {
  if (node.nodeType !== 3) return 'before';
  const text = (node as Text).data;
  return offset >= text.length || SPACE.test(text[offset]) ? 'after' : 'before';
}

/**
 * The DOM point in `root` that `count` visible non-whitespace characters name, on `side`.
 *
 * `before` is the point just before character number `count + 1`: the start of whatever follows the
 * first `count` characters, so the start of a word or of a paragraph rather than the end of the
 * line above it. `after` is the point just after character number `count`: the end of the text a
 * click past the end of a line was beside, rather than the start of the next paragraph. `after`
 * with a count of 0 is the start, since there is nothing to be after.
 *
 * `null` when `root` holds too few such characters, so the caller can tell "the point is past what
 * is drawn" from a point it found. A caller whose drawing is complete reads that as the end of the
 * text; one that draws only part of a document does not know where the point is.
 */
export function inkPoint(root: Node, count: number, skip?: Skip, side: Side = 'before'): { node: Node; offset: number } | null {
  if (side === 'after' && count === 0) side = 'before';
  let seen = 0;
  let out: { node: Node; offset: number } | null = null;
  const walk = (at: Node): void => {
    if (out) return;
    if (at.nodeType === 3) {
      const text = (at as Text).data;
      for (let i = 0; i < text.length; i++) {
        if (SPACE.test(text[i])) continue;
        if (side === 'before' && seen === count) {
          out = { node: at, offset: i };
          return;
        }
        seen++;
        if (side === 'after' && seen === count) {
          out = { node: at, offset: i + 1 };
          return;
        }
      }
      return;
    }
    if (at.nodeType === 1 && at !== root && skip?.(at as Element)) return;
    const children = at.childNodes;
    for (let i = 0; i < children.length && !out; i++) walk(children[i]);
  };
  walk(root);
  return out;
}
