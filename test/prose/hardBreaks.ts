/*
 * Hard line breaks: CommonMark ends a line inside a paragraph with a trailing
 * backslash or with two or more trailing spaces, and Sheaf's Shift+Enter writes
 * the backslash form. Both markers are syntax, so they are hidden off the
 * caret's line and come back when the block is revealed.
 *
 * The cases here are the ones in `sample/edge/hard-breaks.md`, which were
 * checked against a CommonMark parser. Half are breaks that must render; half
 * are look-alikes that must stay literal, because the difference between a
 * break and a stray backslash is one newline, and between a break and a typo is
 * one space.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig, setReveal } from '../../src/webview/livePreview';

type P = ReturnType<typeof mountProse>;

/** A first line that owns the caret, so the lines under test stay inactive. */
const P0 = '.\n\n';

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => p.view.contentDOM.querySelectorAll('.cm-line')[i]?.textContent ?? '';

/** Everything the editor shows. */
const screen = (p: P): string => p.view.contentDOM.textContent ?? '';

/** Rendered text of every element carrying `cls`, in document order. */
const texts = (p: P, cls: string): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll(cls)).map((el) => el.textContent ?? '');

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Run `fn` with "Reveal Syntax On Line" set to `on`, restoring the test default (on) afterwards. */
const withRevealOnLine = (on: boolean, fn: () => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: on });
  try {
    return fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

export const scenarios: Scenario[] = [
  {
    name: 'a trailing backslash ends the line without showing the backslash',
    run: () => {
      const doc = P0 + 'First line\\\nSecond line\\\nThird line';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'First line' &&
        line(p, 3) === 'Second line' &&
        line(p, 4) === 'Third line' &&
        !screen(p).includes('\\') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'two trailing spaces end the line, and the spaces stay in the file',
    run: () => {
      const doc = P0 + 'First line  \nSecond line  \nThird line';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'First line' &&
        line(p, 3) === 'Second line' &&
        line(p, 4) === 'Third line' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'five trailing spaces are one break, and both forms render in one paragraph',
    run: () => {
      const doc =
        P0 +
        'First line     \nSecond line\n\n**When:** 09:00 station time\\\n**Where:** the galley  \n**Who:** the whole crew';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'First line' &&
        line(p, 3) === 'Second line' &&
        line(p, 5) === 'When: 09:00 station time' &&
        line(p, 6) === 'Where: the galley' &&
        line(p, 7) === 'Who: the whole crew' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a break inside emphasis, a quote and a list item renders in each',
    run: () => {
      const doc =
        P0 +
        'Inside emphasis: *first line\\\nsecond line, still italic*\n\n' +
        '> In a quote, first line\\\n> second line of the same quote.\n\n' +
        '- In a list item, first line\\\n  second line of the same item.\n' +
        '- A second item, first line  \n  second line of the same item.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Inside emphasis: first line' &&
        line(p, 3) === 'second line, still italic' &&
        line(p, 5) === ' In a quote, first line' &&
        line(p, 6) === ' second line of the same quote.' &&
        line(p, 8) === '•  In a list item, first line' &&
        line(p, 10) === '•  A second item, first line' &&
        // The emphasis runs through the break rather than ending at it. A mark
        // that covers more than one line is drawn once per line, so the italic
        // text arrives as the two halves of the one span.
        same(texts(p, '.tok-em'), ['first line', 'second line, still italic']) &&
        !screen(p).includes('\\') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a backslash or trailing spaces that end a paragraph, heading, code span or fence stay as written',
    run: () => {
      const doc =
        P0 +
        'A plain paragraph for contrast. These two lines\njoin into one line when rendered.\n\n' +
        'A backslash at the very end of a paragraph is a literal backslash\\\n\n' +
        'Trailing spaces at the very end of a paragraph are dropped, not a break  \n\n' +
        '### A heading that ends in a backslash stays one line\\\n\n' +
        '`code with a trailing backslash\\`\n\n' +
        '```text\nInside a fence, a backslash is just a character\\\nand so are trailing spaces  \n```\n\n' +
        'One trailing space is not a break \nso these lines join.';
      const p = mountProse(doc);
      const ok =
        // A soft break is not a marker, so nothing about these two lines changes.
        line(p, 2) === 'A plain paragraph for contrast. These two lines' &&
        line(p, 3) === 'join into one line when rendered.' &&
        line(p, 5) === 'A backslash at the very end of a paragraph is a literal backslash\\' &&
        line(p, 7) === 'Trailing spaces at the very end of a paragraph are dropped, not a break  ' &&
        line(p, 9) === 'A heading that ends in a backslash stays one line\\' &&
        line(p, 11) === 'code with a trailing backslash\\' &&
        line(p, 14) === 'Inside a fence, a backslash is just a character\\' &&
        line(p, 15) === 'and so are trailing spaces  ' &&
        line(p, 18) === 'One trailing space is not a break ' &&
        line(p, 19) === 'so these lines join.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret on a line with a break shows the marker it is written with',
    run: () => {
      const doc = P0 + 'First line\\\nSecond line\n\nFirst line  \nSecond line';
      const p = mountProse(doc);
      p.select(P0.length + 3);
      const backslash = line(p, 2) === 'First line\\' && line(p, 3) === 'Second line';
      p.select(doc.indexOf('First line  ') + 3);
      const spaces = line(p, 5) === 'First line  ' && line(p, 2) === 'First line';
      const ok = backslash && spaces && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a block revealed with Edit Markdown shows the break marker it is written with',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = P0 + 'First line  \nSecond line\\\nThird line';
        const p = mountProse(doc);
        const from = doc.indexOf('First line');
        const rendered = line(p, 2) === 'First line' && line(p, 3) === 'Second line';
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.length }), selection: { anchor: from + 2 } });
        const revealed = line(p, 2) === 'First line  ' && line(p, 3) === 'Second line\\';
        const ok = rendered && revealed && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
];
