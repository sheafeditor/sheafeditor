/*
 * The Markdown dialect Sheaf reads, checked against github.com: strikethrough
 * spelled with one tilde or two, carets left as text, and the GFM constructs
 * that share the parser with them. Each document starts with a `.` line so the
 * default caret (position 0) leaves the lines under test inactive.
 */

import { syntaxTree } from '@codemirror/language';
import { Scenario, mountProse } from '../harness';

type P = ReturnType<typeof mountProse>;

const P0 = '.\n\n';

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => p.view.contentDOM.querySelectorAll('.cm-line')[i]?.textContent ?? '';

/** Rendered text of every element carrying `cls`, in document order. */
const texts = (p: P, cls: string): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll(cls)).map((el) => el.textContent ?? '');

/** Whether the syntax tree contains a node of this name. */
const hasNode = (p: P, name: string): boolean => {
  let found = false;
  syntaxTree(p.view.state).iterate({ enter: (n) => void (n.name === name && (found = true)) });
  return found;
};

export const scenarios: Scenario[] = [
  {
    name: 'one tilde and two both render struck through',
    run: () => {
      const doc = P0 + 'A ~one~ and a ~~two~~ here.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'A one and a two here.' &&
        texts(p, '.tok-strike').length === 2 &&
        hasNode(p, 'Strikethrough') &&
        !hasNode(p, 'Subscript') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a caret pair stays text and makes no superscript',
    run: () => {
      const doc = P0 + 'The answer is 2^10^ exactly.';
      const p = mountProse(doc);
      const ok = line(p, 2) === 'The answer is 2^10^ exactly.' && !hasNode(p, 'Superscript') && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a lone tilde in prose is just a tilde',
    run: () => {
      const doc = P0 + 'Look in ~/notes for it.\n\nIt took about 3~4 days.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Look in ~/notes for it.' &&
        line(p, 4) === 'It took about 3~4 days.' &&
        !hasNode(p, 'Strikethrough') &&
        texts(p, '.tok-strike').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'two home-directory paths on a line do not strike the text between them',
    run: () => {
      const doc = P0 + 'Copy ~/notes to ~/backup before you start.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Copy ~/notes to ~/backup before you start.' &&
        !hasNode(p, 'Strikethrough') &&
        texts(p, '.tok-strike').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a strikethrough stops at the next tilde rather than running to the end of the line',
    run: () => {
      // What github.com does with two stray tildes: the second closes the first.
      const doc = P0 + 'It took 3~4 days and 5~6 nights. Then it was over.';
      const p = mountProse(doc);
      const struck = texts(p, '.tok-strike');
      const ok =
        struck.length === 1 &&
        struck[0] === '4 days and 5' &&
        line(p, 2) === 'It took 34 days and 56 nights. Then it was over.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'three tildes in a row are text',
    run: () => {
      const doc = P0 + 'Write ~~~three~~~ to mean nothing.';
      const p = mountProse(doc);
      const ok = line(p, 2) === 'Write ~~~three~~~ to mean nothing.' && !hasNode(p, 'Strikethrough') && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the strikethrough shortcut writes two tildes and removes either spelling',
    run: () => {
      const plain = mountProse('word');
      plain.select(0, 4);
      const handled = plain.press('Mod-Shift-x');
      const wrapped = plain.doc();
      plain.press('Mod-Shift-x');
      const unwrapped = plain.doc();
      plain.destroy();

      const single = mountProse('~word~');
      single.select(1, 5);
      single.press('Mod-Shift-x');
      const cleared = single.doc();
      single.destroy();

      return handled && wrapped === '~~word~~' && unwrapped === 'word' && cleared === 'word';
    },
  },
  {
    name: 'task lists, tables, autolinks and highlights read the same as before',
    run: () => {
      const doc =
        P0 +
        '- [ ] open\n- [x] done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSee https://example.com and ==marked== text.';
      const p = mountProse(doc);
      const ok =
        p.view.contentDOM.querySelectorAll('.md-task').length === 2 &&
        hasNode(p, 'Table') &&
        hasNode(p, 'Highlight') &&
        texts(p, '.tok-link').length === 1 &&
        texts(p, '.tok-highlight').length === 1 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
];
