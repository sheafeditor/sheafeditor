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

import { EditorView } from '@codemirror/view';

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig, setReveal } from '../../src/webview/revealState';

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

/** The end of document line `n`, 1-based, which is where End puts the caret. */
const atEndOfLine = (p: P, n: number): number => p.view.state.doc.line(n).to;

/**
 * Type `text` at `pos`, one character at a time, through the editor's own input
 * handlers, which is the path a key press and an input method both take. Falling
 * through to a plain insert is what CodeMirror itself does when no handler claims
 * the character, so a rule that is missing shows up as the character landing
 * exactly where it was typed.
 */
function type(p: P, pos: number, text: string): void {
  p.select(pos);
  for (const ch of text) {
    const { state } = p.view;
    const { from, to } = state.selection.main;
    let handled = false;
    for (const handler of state.facet(EditorView.inputHandler)) {
      if (handler(p.view, from, to, ch, () => state.update({ changes: { from, to, insert: ch } }))) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      p.view.dispatch(
        state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' })
      );
    }
  }
}

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
        // No leading spaces: a marker now takes the space after it with it, and the gap after
        // a bullet is drawn by the box it sits in rather than typed into the line.
        line(p, 5) === 'In a quote, first line' &&
        line(p, 6) === 'second line of the same quote.' &&
        line(p, 8) === '•In a list item, first line' &&
        line(p, 10) === '•A second item, first line' &&
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
      // The caret on the line is what this reads, so it needs reveal-on-line rather than
      // inheriting whatever ran before it. The runner resets the setting for each scenario.
      setLivePreviewConfig({ revealSyntaxOnLine: true });
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
  {
    name: 'Shift+Enter in a heading writes nothing, rather than splitting it into a heading and a paragraph',
    run: () => {
      const doc = P0 + '## Second section';
      const p = mountProse(doc);
      p.select(doc.indexOf('section'));
      p.press('Shift-Enter');
      const ok = p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Shift+Enter at the start of an unmarked line opens a plain blank line, with no backslash left on it',
    run: () => {
      const doc = P0 + 'Before bold after';
      const p = mountProse(doc);
      p.select(P0.length);
      p.press('Shift-Enter');
      // A break needs text in front of it, and there is none here, so what lands is an
      // ordinary blank line rather than one holding a hard-break marker that draws as
      // nothing. On a marked line the answer differs; the task item below covers that.
      const ok = p.doc() === P0 + '\nBefore bold after' && !screen(p).includes('\\');
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Shift+Enter against the text of a task item writes nothing, so no line holds just its checkbox',
    run: () => {
      const doc = P0 + '- [ ] Open task';
      const p = mountProse(doc);
      // Past the marker: the first position a person can see the caret in.
      p.select(P0.length + '- [ ] '.length);
      p.press('Shift-Enter');
      const ok = p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a break at the end of a quote line leaves the caret past the quote marker, so what is typed next joins the quote',
    run: () => {
      const doc = P0 + '> Quoted line';
      const p = mountProse(doc);
      p.select(doc.length);
      p.press('Shift-Enter');
      // The newline and the marker now; the backslash arrives with the words, which the scenario
      // above this one checks. What matters here is where the caret lands.
      const broke = p.doc() === P0 + '> Quoted line\n> ';
      const last = p.view.state.doc.line(p.view.state.doc.lines);
      // The new line's whole source is the quote's marker, so it draws as empty. Which side
      // of the marker the caret is on is what decides whether that matters: past it, the
      // next character joins the quote's text; in front of it, the character would land
      // before the `>` and the line would stop being a quote at all.
      const pastTheMarker = last.text === '> ' && p.view.state.selection.main.head === last.to;
      p.view.dispatch(p.view.state.replaceSelection('x'));
      const ok = broke && pastTheMarker && p.doc() === P0 + '> Quoted line\\\n> x';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Shift+Enter with text in front of the caret still writes the break',
    run: () => {
      const doc = P0 + 'Before bold after';
      const p = mountProse(doc);
      p.select(P0.length + 'Before'.length);
      p.press('Shift-Enter');
      /*
       * The backslash is written on the keystroke here, and that is the distinction worth holding:
       * this break has text after it, so it is a hard break the moment it exists. Only a break at the
       * end of a line, which opens a line with nothing on it, waits for something to break.
       */
      const ok = p.doc() === P0 + 'Before\\\n bold after';
      p.destroy();
      return ok;
    },
  },
  {
    /*
     * One backslash for one gesture, however much is typed afterwards.
     *
     * The owed position was held after the backslash was written, so every later keystroke was read
     * as earning the break again: a forty-character second line left forty backslashes. And from the
     * second one it was worse than untidy, because `\\` is an escaped backslash rather than a hard
     * break, so the run destroyed the break it had just made and left the characters in the text.
     */
    name: 'a second line typed after Shift+Enter earns exactly one backslash, not one per keystroke',
    run: () => {
      const doc = P0 + '- first bullet';
      const p = mountProse(doc);
      p.select(doc.length);
      p.press('Shift-Enter');
      const counts: number[] = [];
      for (const ch of 'second') {
        p.view.dispatch(p.view.state.replaceSelection(ch));
        counts.push((p.view.state.doc.line(p.view.state.doc.lines - 1).text.match(/\\/g) ?? []).length);
      }
      const ok = counts.every((n) => n === 1) && p.doc() === P0 + '- first bullet\\\n  second';
      p.destroy();
      return ok;
    },
  },
  {
    /*
     * A break the person walked away from stays unmade, wherever they go on typing.
     *
     * The waiting position was compared as "anywhere after the break", so typing further down the
     * document finished a gesture that had been abandoned, and the backslash landed on a line the
     * caret had long left. It is the line the break opened that is waiting, and only that line.
     */
    name: 'typing further down the document after an abandoned Shift+Enter leaves no backslash behind',
    run: () => {
      const doc = P0 + 'First para.\n\nSecond para.';
      const p = mountProse(doc);
      p.select(P0.length + 'First para.'.length);
      p.press('Shift-Enter');
      const opened = p.doc() === P0 + 'First para.\n\n\nSecond para.';
      p.select(p.doc().length);
      p.view.dispatch(p.view.state.replaceSelection('!'));
      const ok = opened && p.doc() === P0 + 'First para.\n\n\nSecond para.!';
      p.destroy();
      return ok;
    },
  },

  /*
   * Typing at the end of a line that already has a break.
   *
   * Both markers are drawn as nothing, so the end of the line and the end of the
   * words are the same place on the screen and End lands past the marker. A
   * character typed there is on the wrong side of it: the two spaces stop being
   * trailing, or the backslash turns up in the middle of the sentence, and either
   * way the break is gone. Worse than it looks, because Sheaf draws source lines
   * as rows and so still shows two lines; it is everywhere the document is
   * published that the paragraph silently joins up.
   *
   * With reveal-on-line on, the marker is on the screen and the person can see
   * what they are typing against, so the character lands where they put it. The
   * last case here is that one, and it is why these drive with it off.
   */
  {
    name: 'typing at the end of a line keeps a backslash break, the form Shift+Enter writes',
    run: () =>
      withRevealOnLine(false, () => {
        const p = mountProse(P0 + 'A line ending in a break\\\nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A line ending in a breakZ\\\nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'typing at the end of a line keeps a two-space break',
    run: () =>
      withRevealOnLine(false, () => {
        const p = mountProse(P0 + 'A line ending in a break  \nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A line ending in a breakZ  \nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a second character goes in beside the first, still in front of the marker',
    run: () =>
      withRevealOnLine(false, () => {
        const p = mountProse(P0 + 'A line ending in a break\\\nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        type(p, p.view.state.selection.main.head, 'Y');
        const ok = p.doc() === P0 + 'A line ending in a breakZY\\\nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a line with no break takes the character at the end of its words',
    run: () =>
      withRevealOnLine(false, () => {
        const p = mountProse(P0 + 'A line ending in a word\nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A line ending in a wordZ\nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a single trailing space is not a break, so the character lands past it',
    run: () =>
      withRevealOnLine(false, () => {
        const p = mountProse(P0 + 'A line ending in a space \nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A line ending in a space Z\nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a trailing backslash that is not a break is text, so the character lands past it',
    run: () =>
      withRevealOnLine(false, () => {
        // Nothing follows inside the paragraph, so CommonMark makes this a literal
        // backslash rather than a break, and it is on the screen as one.
        const p = mountProse(P0 + 'A paragraph ending in a backslash\\\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A paragraph ending in a backslash\\Z\n';
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'with the line showing its source the character lands where it was typed',
    run: () =>
      withRevealOnLine(true, () => {
        const p = mountProse(P0 + 'A line ending in a break\\\nand the line after it.\n');
        type(p, atEndOfLine(p, 3), 'Z');
        const ok = p.doc() === P0 + 'A line ending in a break\\Z\nand the line after it.\n';
        p.destroy();
        return ok;
      }),
  },
];
