/*
 * Rendering of inline Markdown on lines the caret is not on: what the reader
 * sees, read back from the editor DOM. Each document starts with a `.` line so
 * the default caret (position 0) leaves the lines under test inactive.
 */

import { Scenario, mountProse } from '../harness';

type P = ReturnType<typeof mountProse>;

const P0 = '.\n\n';

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => p.view.contentDOM.querySelectorAll('.cm-line')[i]?.textContent ?? '';

/** Rendered text of every element carrying `cls`, in document order. */
const texts = (p: P, cls: string): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll(cls)).map((el) => el.textContent ?? '');

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const scenarios: Scenario[] = [
  {
    name: 'a bare URL shows as a link',
    run: () => {
      const p = mountProse(P0 + 'The docs are at https://example.com/docs today.');
      const ok = line(p, 2) === 'The docs are at https://example.com/docs today.' && same(texts(p, '.tok-link'), ['https://example.com/docs']);
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an autolink in angle brackets shows its address without the brackets',
    run: () => {
      const doc = P0 + 'Mail <someone@example.com> or visit <https://example.com/path>.';
      const p = mountProse(doc);
      const rendered = line(p, 2) === 'Mail someone@example.com or visit https://example.com/path.';
      const links = same(texts(p, '.tok-link'), ['someone@example.com', 'https://example.com/path']);
      p.select(8);
      const revealed = line(p, 2) === 'Mail <someone@example.com> or visit <https://example.com/path>.';
      const ok = rendered && links && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a long bare URL on its own line is not hidden',
    run: () => {
      const url = 'https://example.com/' + 'segment/'.repeat(30) + 'end';
      const p = mountProse(P0 + url);
      const ok = line(p, 2) === url;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'square brackets with no matching definition keep their brackets and are not links',
    run: () => {
      const p = mountProse(P0 + 'A claim.[^1] See [1] and [draft].\n\n> [!NOTE]\n\n- [~] not valid');
      // The leading spaces are the ones after `>` and `-`, which quote and list rendering keep.
      const ok =
        line(p, 2) === 'A claim.[^1] See [1] and [draft].' &&
        line(p, 4) === ' [!NOTE]' &&
        line(p, 6) === '•  [~] not valid' &&
        texts(p, '.tok-link').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'task checkboxes and defined shortcut references still render alongside literal brackets',
    run: () => {
      const p = mountProse(P0 + '- [ ] open\n- [x] done\n\nSee [draft] and [nothing].\n\n[draft]: https://example.com/draft');
      const ok =
        p.view.contentDOM.querySelectorAll('.md-task').length === 2 &&
        line(p, 5) === 'See draft and [nothing].' &&
        same(texts(p, '.tok-link'), ['draft', 'https://example.com/draft']);
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a reference link shows only its text, and its definition line shows the address',
    run: () => {
      const doc = P0 + 'Read the [reference][ref] here.\n\n[ref]: https://example.com';
      const p = mountProse(doc);
      const rendered =
        line(p, 2) === 'Read the reference here.' &&
        line(p, 4) === '[ref]: https://example.com' &&
        same(texts(p, '.tok-link'), ['reference', 'https://example.com']);
      p.select(P0.length + 12);
      const revealed = line(p, 2) === 'Read the [reference][ref] here.';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'collapsed and shortcut references with a definition render as links',
    run: () => {
      const p = mountProse(P0 + 'Both [ref][] and [Ref] work.\n\n[ref]: https://example.com');
      const ok = line(p, 2) === 'Both ref and Ref work.' && same(texts(p, '.tok-link'), ['ref', 'Ref', 'https://example.com']);
      p.destroy();
      return ok;
    },
  },
  {
    name: 'inline code hides its backticks in prose and in headings',
    run: () => {
      const doc = P0 + 'Run `npm test` before you push.\n\n## Run `npm test` first';
      const p = mountProse(doc);
      const rendered =
        line(p, 2) === 'Run npm test before you push.' &&
        line(p, 4) === 'Run npm test first' &&
        same(texts(p, '.tok-inline-code'), ['npm test', 'npm test']);
      p.select(P0.length + 6);
      const revealed = line(p, 2) === 'Run `npm test` before you push.';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a multi-backtick code span hides its whole fence and one padding space, and code block fences stay',
    run: () => {
      const p = mountProse(P0 + 'Use `` a`b `` here.\n\n```js\nconst x = 1;\n```');
      const ok =
        line(p, 2) === 'Use a`b here.' &&
        same(texts(p, '.tok-inline-code'), ['a`b']) &&
        line(p, 4) === '```js' &&
        line(p, 6) === '```';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a backslash escape shows the character without its backslash',
    run: () => {
      const doc = P0 + '\\*not italic\\* and plain.';
      const p = mountProse(doc);
      const rendered = line(p, 2) === '*not italic* and plain.' && texts(p, '.tok-em').length === 0;
      p.select(P0.length + 4);
      const revealed = line(p, 2) === '\\*not italic\\* and plain.';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'HTML entities show as their characters, while unknown entities and code stay as written',
    run: () => {
      const doc = P0 + 'AT&amp;T &copy; 2044 &mdash; done. &#169; &#x2014; &bogus;\n\nUse `&amp; \\*` here.';
      const p = mountProse(doc);
      const rendered =
        line(p, 2) === 'AT&T © 2044 — done. © — &bogus;' &&
        same(texts(p, '.tok-inline-code'), ['&amp; \\*']);
      p.select(P0.length + 3);
      const revealed = line(p, 2) === 'AT&amp;T &copy; 2044 &mdash; done. &#169; &#x2014; &bogus;';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a link with a title shows its text with no trailing space in the link',
    run: () => {
      const doc = P0 + 'See [the site](https://example.com "Title") today.';
      const p = mountProse(doc);
      const rendered = line(p, 2) === 'See the site today.' && same(texts(p, '.tok-link'), ['the site']);
      p.select(P0.length + 6);
      const revealed = line(p, 2) === 'See [the site](https://example.com "Title") today.';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a link with empty text shows its address as the link',
    run: () => {
      const doc = P0 + 'Empty text: [](https://example.com) and [](<a b.md>) end.';
      const p = mountProse(doc);
      const rendered =
        line(p, 2) === 'Empty text: https://example.com and a b.md end.' &&
        same(texts(p, '.tok-link'), ['https://example.com', 'a b.md']);
      p.select(P0.length + 3);
      const revealed = line(p, 2) === 'Empty text: [](https://example.com) and [](<a b.md>) end.';
      const ok = rendered && revealed && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
];
