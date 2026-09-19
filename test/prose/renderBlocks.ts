/*
 * Rendering of whole blocks: front matter, code, and how much of a block its
 * raw Markdown reveal covers. What the reader sees is read back from the editor
 * DOM, so every check moves the caret off the lines it reads unless the reveal
 * itself is under test.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig, setReveal } from '../../src/webview/livePreview';

type P = ReturnType<typeof mountProse>;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => lines(p)[i]?.textContent ?? '';

/** Whether line `i` (0-based) carries class `cls`. */
const hasClass = (p: P, i: number, cls: string): boolean => lines(p)[i]?.classList.contains(cls) ?? false;

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/** Type `text` at the caret, as a keystroke would. */
const type = (p: P, text: string): void => {
  const at = p.view.state.selection.main.head;
  p.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
};

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
    name: 'YAML front matter shows as plain metadata with no rule, heading or bullets',
    run: () => {
      const doc = '---\n# a YAML comment\ntitle: Hello\ncategories:\n  - reference\n---\n\nBody text.\n\n---\n\n## Real heading';
      const p = mountProse(doc);
      p.select(doc.indexOf('Body') + 2);
      const front = [0, 1, 2, 3, 4, 5];
      const ok =
        front.every((i) => hasClass(p, i, 'tok-frontmatter') && !hasClass(p, i, 'tok-heading')) &&
        line(p, 0) === '---' &&
        line(p, 1) === '# a YAML comment' &&
        line(p, 2) === 'title: Hello' &&
        line(p, 4) === '  - reference' &&
        line(p, 5) === '---' &&
        count(p, '.tok-bullet') === 0 &&
        // The rule after the body is a real one and still draws.
        count(p, '.md-hr') === 1 &&
        !hasClass(p, 7, 'tok-frontmatter') &&
        hasClass(p, 11, 'tok-h2') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'front matter closed with three dots shows as metadata and the body after it renders',
    run: () => {
      const doc = '---\ntitle: Hello\ndraft: true\n...\n\nBody *text* here.';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        [0, 1, 2, 3].every((i) => hasClass(p, i, 'tok-frontmatter') && !hasClass(p, i, 'tok-heading')) &&
        line(p, 3) === '...' &&
        count(p, '.md-hr') === 0 &&
        !hasClass(p, 5, 'tok-frontmatter') &&
        line(p, 5) === 'Body text here.' &&
        count(p, '.tok-em') === 1 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a rule that does not open the document is not front matter',
    run: () => {
      const doc = 'Intro.\n\n---\n\ntitle: Hello';
      const p = mountProse(doc);
      p.select(0);
      const ok = count(p, '.tok-frontmatter') === 0 && count(p, '.md-hr') === 1 && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'typing at the end of a double-clicked block keeps its Markdown revealed',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\nA **bold** word';
        const p = mountProse(doc);
        const from = doc.indexOf('A');
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.length }), selection: { anchor: doc.indexOf('word') + 1 } });
        const revealed = line(p, 2) === 'A **bold** word';
        p.select(doc.length);
        type(p, 'X');
        const one = line(p, 2);
        type(p, 'Y');
        const two = line(p, 2);
        const ok = revealed && one === 'A **bold** wordX' && two === 'A **bold** wordXY' && p.doc() === doc + 'XY';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'typing at the start of a double-clicked block keeps it revealed, and leaving the block hides it',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\nA **bold** word';
        const p = mountProse(doc);
        const from = doc.indexOf('A');
        p.view.dispatch({ effects: setReveal.of({ from, to: doc.length }), selection: { anchor: from } });
        type(p, 'Z');
        const typed = line(p, 2) === 'ZA **bold** word';
        p.select(0);
        const hidden = line(p, 2) === 'ZA bold word';
        const ok = typed && hidden && p.doc() === '.\n\nZA **bold** word';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'an indented code block is styled like fenced code',
    run: () => {
      const doc = 'Before.\n\n    function indented() {\n    }\n\nAfter.\n\n```\nfenced\n```';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        hasClass(p, 2, 'tok-code-block') &&
        hasClass(p, 3, 'tok-code-block') &&
        line(p, 2) === '    function indented() {' &&
        !hasClass(p, 0, 'tok-code-block') &&
        !hasClass(p, 5, 'tok-code-block') &&
        [7, 8, 9].every((i) => hasClass(p, i, 'tok-code-block')) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with reveal syntax on line, the caret reveals every line of its quote or list item and nothing outside it',
    run: () => {
      const doc = '.\n\n> first **line** here\n> second **line** here\n\n- item one\n  continued **here**\n- item two **x**\n\nPara **one**.';
      const p = mountProse(doc);
      p.select(doc.indexOf('first') + 2);
      const quote =
        line(p, 2) === '> first **line** here' &&
        line(p, 3) === '> second **line** here' &&
        line(p, 5) === '•  item one' &&
        line(p, 9) === 'Para one.';
      p.select(doc.indexOf('item one') + 2);
      const item =
        line(p, 5) === '- item one' &&
        line(p, 6) === '  continued **here**' &&
        line(p, 7) === '•  item two x' &&
        line(p, 2) === ' first line here' &&
        line(p, 3) === ' second line here';
      const ok = quote && item && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'with reveal syntax on line off, a caret in a quote reveals nothing',
    run: () =>
      withRevealOnLine(false, () => {
        const doc = '.\n\n> first **line** here\n> second **line** here';
        const p = mountProse(doc);
        p.select(doc.indexOf('first') + 2);
        const ok = line(p, 2) === ' first line here' && line(p, 3) === ' second line here' && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'changing reveal syntax on line updates the caret line at once without moving the caret',
    run: () =>
      withRevealOnLine(true, () => {
        const doc = '.\n\nA **bold** one here.';
        const p = mountProse(doc);
        p.select(doc.indexOf('bold') + 1);
        const before = line(p, 2) === 'A **bold** one here.';
        // The webview applies a settings change by updating the config and
        // dispatching an empty transaction; nothing else about the editor changes.
        setLivePreviewConfig({ revealSyntaxOnLine: false });
        p.view.dispatch({});
        const off = line(p, 2) === 'A bold one here.';
        setLivePreviewConfig({ revealSyntaxOnLine: true });
        p.view.dispatch({});
        const on = line(p, 2) === 'A **bold** one here.';
        const ok = before && off && on && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
];
