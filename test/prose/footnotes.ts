/*
 * Footnotes: `[^label]` drawn as a superscript number, and `[^label]: text`
 * drawn with that number in place of its label, where it is written.
 *
 * What matters is that a note reads as a note, that brackets which are not a
 * footnote keep reading as the characters typed, that the numbers follow the
 * order of the references as they do on github.com, that Cmd-click goes from
 * one end of a note to the other, and that none of it writes to the document.
 *
 * jsdom has no layout and no stylesheet, so the size and colour of a note, and
 * where a real pointer lands, are real-window checks.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig } from '../../src/webview/livePreview';
import { sheafMarkdownLanguage } from '../../src/webview/markdownDialect';
import { footnoteIndex, footnoteJump } from '../../src/webview/footnotes';

type P = ReturnType<typeof mountProse>;

const G = globalThis as any;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => (lines(p)[i]?.textContent ?? '').trim();

const all = (p: P, selector: string): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>(selector));

/** The text of every node called `name` in `text`, as the dialect parses it. */
const spans = (text: string, name: string): string[] => {
  const out: string[] = [];
  sheafMarkdownLanguage.parser.parse(text).iterate({
    enter: (n) => {
      if (n.name === name) out.push(text.slice(n.from, n.to));
    },
  });
  return out;
};

/** Run `fn` with "Reveal Syntax On Line" off, so a caret does not bring source back. */
const withoutRevealOnLine = (fn: () => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  try {
    return fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

const cmdPress = (el: Element | undefined, init: Record<string, unknown> = { metaKey: true }): void => {
  el?.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
};

const BEACON = 'The beacon runs at 1420 MHz[^band] and has since 2229.\n\n[^band]: The hydrogen line, chosen because every receiver already looks there.\n\nAfter.';

export const scenarios: Scenario[] = [
  {
    name: 'the parser reads [^label] as a footnote reference and leaves code, spaced labels and links alone',
    run: () =>
      spans('A claim[^a] and[^Long-label_2].', 'FootnoteReference').join('|') === '[^a]|[^Long-label_2]' &&
      spans('Code `[^a]` here.', 'FootnoteReference').length === 0 &&
      spans('```\nx[^a]\n```\n', 'FootnoteReference').length === 0 &&
      spans('    x[^a]\n', 'FootnoteReference').length === 0 &&
      spans('Not [^ spaced] nor [^] nor [^a b].', 'FootnoteReference').length === 0 &&
      spans('A [^x](https://example.com) link.', 'FootnoteReference').length === 0 &&
      spans('A [^x](https://example.com) link.', 'Link').length === 1,
  },
  {
    name: 'the parser reads [^label]: at the start of a block as a definition, with its indented lines',
    run: () => {
      const doc = 'Text[^a].\n[^a]: First line\ncarries on\n    indented more\n\n    second paragraph\n\nAfter.';
      const defs = spans(doc, 'FootnoteDefinition');
      return (
        defs.length === 1 &&
        defs[0] === '[^a]: First line\ncarries on\n    indented more\n\n    second paragraph' &&
        // The sentence above it stays its own paragraph, and `After.` is not the note's.
        spans(doc, 'Paragraph').includes('Text[^a].') &&
        spans(doc, 'Paragraph').includes('After.') &&
        // Two notes written one under the other are two notes.
        spans('[^a]: one\n[^b]: two', 'FootnoteDefinition').length === 2 &&
        // A one-word note is a note, not a link definition pointing at that word.
        spans('[^a]: Source.', 'FootnoteDefinition').length === 1 &&
        spans('[^a]: Source.', 'LinkReference').length === 0 &&
        // Four spaces in is code, and a definition inside a fence is code.
        spans('    [^a]: x', 'FootnoteDefinition').length === 0 &&
        spans('```\n[^a]: x\n```', 'FootnoteDefinition').length === 0 &&
        spans('[^a b]: x', 'FootnoteDefinition').length === 0
      );
    },
  },
  {
    name: 'a reference draws as a superscript number with the note as its tooltip, and its source is hidden',
    run: () =>
      withoutRevealOnLine(() => {
        const p = mountProse(BEACON);
        p.select(BEACON.length);
        const refs = all(p, '.md-footnote-ref');
        const ok =
          refs.length === 1 &&
          refs[0].tagName === 'SUP' &&
          refs[0].textContent === '1' &&
          refs[0].title === 'The hydrogen line, chosen because every receiver already looks there.' &&
          line(p, 0) === 'The beacon runs at 1420 MHz1 and has since 2229.' &&
          p.doc() === BEACON;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a definition draws its number in place of [^label]: and every line of it is styled as a note',
    run: () =>
      withoutRevealOnLine(() => {
        const doc = 'One[^n].\n\n[^n]: First line\n    second line\n\nAfter.';
        const p = mountProse(doc);
        p.select(doc.length);
        const noteLines = lines(p).filter((l) => l.classList.contains('md-footnote-def'));
        const num = all(p, '.md-footnote-num');
        const ok =
          noteLines.length === 2 &&
          num.length === 1 &&
          num[0].textContent === '1' &&
          line(p, 2) === '1 First line' &&
          !line(p, 2).includes('[^n]') &&
          !lines(p)[5].classList.contains('md-footnote-def') &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'notes are numbered in order of first reference, whatever order they are defined in and whatever case their labels use',
    run: () =>
      withoutRevealOnLine(() => {
        const doc = 'First[^b], then[^A], again[^B].\n\n[^a]: Alpha.\n\n[^b]: Bravo.';
        const p = mountProse(doc);
        p.select(doc.length);
        const refs = all(p, '.md-footnote-ref').map((r) => r.textContent).join(',');
        const nums = all(p, '.md-footnote-num').map((r) => r.textContent).join(',');
        const index = footnoteIndex(p.view.state);
        const ok = refs === '1,2,1' && nums === '2,1' && index.numbers.get('b') === 1 && index.numbers.get('a') === 2 && p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a reference with no definition stays as written, and so does a definition nothing refers to',
    run: () =>
      withoutRevealOnLine(() => {
        const doc = 'A claim[^nope] here.\n\n[^lonely]: Nobody cites this.';
        const p = mountProse(doc);
        p.select(doc.length);
        const ok =
          all(p, '.md-footnote-ref').length === 0 &&
          all(p, '.md-footnote-num').length === 0 &&
          line(p, 0) === 'A claim[^nope] here.' &&
          line(p, 2) === '[^lonely]: Nobody cites this.' &&
          p.doc() === doc;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'the caret on a line brings its footnote source back, and leaving puts it away again',
    run: () => {
      // The caret on the line is what this reads, so it needs reveal-on-line rather than
      // inheriting whatever ran before it. The runner resets the setting for each scenario.
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const p = mountProse(BEACON);
      p.select(BEACON.length);
      const before = line(p, 0).includes('[^band]');
      p.select(3);
      const onRef = line(p, 0).includes('[^band]') && all(p, '.md-footnote-ref').length === 0;
      const defAt = BEACON.indexOf('[^band]:');
      p.select(defAt + 12);
      const onDef = line(p, 2).startsWith('[^band]:') && all(p, '.md-footnote-num').length === 0;
      p.select(BEACON.length);
      const after = !line(p, 0).includes('[^band]') && !line(p, 2).includes('[^band]');
      const ok = !before && onRef && onDef && after && p.doc() === BEACON;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Cmd-click on a reference moves the caret to its note, and Cmd-click on the note number goes back',
    run: () =>
      withoutRevealOnLine(() => {
        const p = mountProse(BEACON);
        p.select(BEACON.length);
        const textFrom = BEACON.indexOf('The hydrogen');
        const refEnd = BEACON.indexOf('[^band]') + '[^band]'.length;
        cmdPress(all(p, '.md-footnote-ref')[0]);
        const toNote = p.view.state.selection.main.head === textFrom;
        cmdPress(all(p, '.md-footnote-num')[0], { ctrlKey: true });
        const back = p.view.state.selection.main.head === refEnd;
        const ok = toNote && back && p.doc() === BEACON;
        p.destroy();
        return ok;
      }),
  },
  {
    name: 'a footnote jump is worked out from the source too, and goes nowhere from ordinary text',
    run: () => {
      const p = mountProse(BEACON);
      const s = p.view.state;
      const ref = BEACON.indexOf('[^band]');
      const def = BEACON.indexOf('[^band]:');
      const ok =
        footnoteJump(s, ref + 2) === BEACON.indexOf('The hydrogen') &&
        footnoteJump(s, def + 1) === ref + '[^band]'.length &&
        footnoteJump(s, 0) === null &&
        footnoteJump(s, BEACON.indexOf('hydrogen')) === null;
      p.destroy();
      return ok;
    },
  },
];
