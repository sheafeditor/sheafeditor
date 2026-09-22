/*
 * Inline HTML formatting tags in prose: `<kbd>`, `<sub>`, `<sup>` and the rest
 * of the small set GitHub draws as formatting. Off the caret's line a matched
 * pair shows its content with the formatting and without the tags; on it the
 * tags come back so they can be edited. Anything outside that set, and any tag
 * that is unmatched or inside code, stays exactly as written.
 *
 * Each document starts with a `.` line so the default caret (position 0)
 * leaves the lines under test inactive.
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
    name: 'a pair of kbd tags draws two key caps with the tags hidden',
    run: () => {
      const doc = P0 + 'Hold <kbd>Alt</kbd> + <kbd>Break</kbd> on the panel keypad for three seconds.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Hold Alt + Break on the panel keypad for three seconds.' &&
        same(texts(p, '.tok-html-kbd'), ['Alt', 'Break']) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'sub and sup draw as subscript and superscript',
    run: () => {
      const doc = P0 + 'Water is H<sub>2</sub>O and 2<sup>10</sup> is 1024.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Water is H2O and 210 is 1024.' &&
        same(texts(p, '.tok-html-sub'), ['2']) &&
        same(texts(p, '.tok-html-sup'), ['10']) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'mark, small, ins, del, s, u and code draw as their formatting',
    run: () => {
      const doc = P0 + '<mark>a</mark> <small>b</small> <ins>c</ins> <del>d</del> <s>e</s> <u>f</u> <code>g</code>';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'a b c d e f g' &&
        same(texts(p, '.tok-html-mark'), ['a']) &&
        same(texts(p, '.tok-html-small'), ['b']) &&
        same(texts(p, '.tok-html-ins'), ['c']) &&
        same(texts(p, '.tok-html-del'), ['d', 'e']) &&
        same(texts(p, '.tok-html-u'), ['f']) &&
        same(texts(p, '.tok-inline-code'), ['g']);
      p.destroy();
      return ok;
    },
  },
  {
    name: 'strong, b, em and i draw as bold and italic, the way ** and * do',
    run: () => {
      const doc = P0 + 'Text with <em>emphasis</em>, <strong>strength</strong>, <b>bold</b> and <i>slant</i>.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Text with emphasis, strength, bold and slant.' &&
        same(texts(p, '.tok-strong'), ['strength', 'bold']) &&
        same(texts(p, '.tok-em'), ['emphasis', 'slant']) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an abbr with a title shows the title as a tooltip',
    run: () => {
      const p = mountProse(P0 + 'The <abbr title="Network Time Protocol">NTP</abbr> server.');
      const el = p.view.contentDOM.querySelector('.tok-html-abbr');
      const ok = line(p, 2) === 'The NTP server.' && el?.textContent === 'NTP' && el.getAttribute('title') === 'Network Time Protocol';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret on the line shows the tags as written',
    run: () => {
      const doc = P0 + 'Press <kbd>F5</kbd> to start.';
      const p = mountProse(doc);
      const rendered = line(p, 2) === 'Press F5 to start.';
      p.select(P0.length + 2);
      const revealed = line(p, 2) === 'Press <kbd>F5</kbd> to start.';
      p.select(0);
      const again = line(p, 2) === 'Press F5 to start.';
      const ok = rendered && revealed && again && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an unmatched kbd tag stays as written',
    run: () => {
      const doc = P0 + 'Press <kbd>F5 to start.\n\nThen F6</kbd> to stop.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Press <kbd>F5 to start.' &&
        line(p, 4) === 'Then F6</kbd> to stop.' &&
        texts(p, '.tok-html-kbd').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a kbd tag inside backticks or a code block stays literal',
    run: () => {
      const doc = P0 + 'Write `<kbd>F5</kbd>` for a key.\n\n```\n<kbd>F5</kbd>\n```';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'Write <kbd>F5</kbd> for a key.' &&
        line(p, 5) === '<kbd>F5</kbd>' &&
        texts(p, '.tok-html-kbd').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'tags outside the set, unknown attributes and unknown tags inside stay as written',
    run: () => {
      const doc =
        P0 +
        'A <span>b</span> c.\n\n' +
        'Press <kbd class="x">F5</kbd> now.\n\n' +
        'Press <kbd><span>F5</span></kbd> now.';
      const p = mountProse(doc);
      const ok =
        line(p, 2) === 'A <span>b</span> c.' &&
        line(p, 4) === 'Press <kbd class="x">F5</kbd> now.' &&
        line(p, 6) === 'Press <kbd><span>F5</span></kbd> now.' &&
        texts(p, '.tok-html-kbd').length === 0;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'rendering inline HTML leaves the document byte-identical',
    run: () => {
      const doc = P0 + 'Hold <kbd>Alt</kbd> + <KBD>Break</KBD>, H<sub>2</sub>O, x<sup>2</sup>, <abbr title=\'A &amp; B\'>AB</abbr>.\n';
      const p = mountProse(doc);
      const drawn = line(p, 2) === 'Hold Alt + Break, H2O, x2, AB.';
      p.select(P0.length + 3);
      p.select(0);
      const ok = drawn && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
];
