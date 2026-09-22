/*
 * Maths: `$…$` drawn as typeset inline maths, `$$…$$` as a typeset block.
 *
 * Two halves matter equally here. One is that an equation reads as an equation.
 * The other is that a dollar sign in a sentence about money, in code, or escaped
 * keeps reading as a dollar sign, because a price is far commoner in these
 * documents than an equation and a sentence that turns into half an equation is
 * worse than one that was never typeset at all.
 *
 * jsdom has no layout, no fonts and no stylesheet, so nothing here can see the
 * shape of a fraction, the height of a block, whether a wide equation scrolls
 * inside its own region, or what colour any of it is drawn in. These scenarios
 * check which spans are recognised as maths, which are left alone, what the
 * reader gets back when the source is revealed, what an equation that does not
 * parse falls back to, and that the document is never written to. Appearance is
 * a real-window check.
 */

import { Scenario, mountProse } from '../harness';
import { setLivePreviewConfig } from '../../src/webview/livePreview';

type P = ReturnType<typeof mountProse>;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based). */
const line = (p: P, i: number): string => (lines(p)[i]?.textContent ?? '').trim();

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

const first = (p: P, selector: string): HTMLElement | null =>
  p.view.contentDOM.querySelector<HTMLElement>(selector);

/**
 * Run `fn` with "Reveal Syntax On Line" off, restoring the test default (on)
 * afterwards. It is the setting in the way whenever a check needs the caret on
 * a line that should still be showing its rendered form.
 */
const withoutRevealOnLine = (fn: () => boolean): boolean => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  try {
    return fn();
  } finally {
    setLivePreviewConfig({ revealSyntaxOnLine: true });
  }
};

export const scenarios: Scenario[] = [
  {
    name: 'a block equation is drawn in place of the lines it is written on',
    run: () => {
      const doc = 'Received power follows:\n\n$$\nP_r = P_t G_t G_r\n$$\n\nIn decibels.';
      const p = mountProse(doc);
      p.select(0);
      const block = first(p, '.md-math-block');
      const ok =
        count(p, '.md-math-block') === 1 &&
        // KaTeX has typeset it rather than the source being left on the line.
        (block?.querySelectorAll('.katex').length ?? 0) === 1 &&
        // The lines it is written on are gone from the text: no delimiters are
        // left behind. (What KaTeX draws still carries the source in the
        // MathML it renders for screen readers, so the text of the widget is
        // no test of this.)
        lines(p).every((l) => !(l.textContent ?? '').includes('$$')) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'inline maths is drawn where it stands and the sentence runs on through it',
    run: () => {
      const doc = 'At $f = 8.45$ GHz, $\\lambda \\approx 3.55$ cm.';
      const p = mountProse(doc);
      // A caret elsewhere: the sentence is one line, so the caret on it would
      // show the source under the test default.
      p.select(0);
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        return (
          count(p, '.md-math-inline') === 2 &&
          count(p, '.katex') === 2 &&
          line(p, 0).includes('GHz') &&
          line(p, 0).includes('cm.') &&
          !line(p, 0).includes('$') &&
          p.doc() === doc
        );
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Edit Markdown brings a block equation back as the source it is written as',
    run: () => {
      const doc = 'Before.\n\n$$\nP_r = P_t\n$$\n\nAfter.';
      const p = mountProse(doc);
      return withoutRevealOnLine(() => {
        p.select(0);
        const drawn = count(p, '.md-math-block') === 1;
        // Inside the equation, then Edit Markdown.
        p.select(doc.indexOf('P_r'));
        const stillDrawn = count(p, '.md-math-block') === 1;
        p.press('Mod-Alt-e');
        const revealed =
          count(p, '.md-math-block') === 0 &&
          lines(p).some((l) => (l.textContent ?? '').trim() === '$$') &&
          lines(p).some((l) => (l.textContent ?? '').includes('P_r = P_t'));
        const ok = drawn && stillDrawn && revealed && p.doc() === doc;
        p.destroy();
        return ok;
      });
    },
  },
  {
    name: 'Edit Markdown brings inline maths back as its dollars',
    run: () => {
      const doc = 'At $f = 8.45$ GHz.';
      const p = mountProse(doc);
      return withoutRevealOnLine(() => {
        p.select(doc.indexOf('GHz'));
        const drawn = count(p, '.md-math-inline') === 1;
        p.press('Mod-Alt-e');
        const revealed = count(p, '.md-math-inline') === 0 && line(p, 0) === 'At $f = 8.45$ GHz.';
        const ok = drawn && revealed && p.doc() === doc;
        p.destroy();
        return ok;
      });
    },
  },
  {
    name: 'a price is a price: one amount, and two in the same sentence',
    run: () => {
      const doc = 'It cost $20.\n\nA coffee is $5 or $10 depending on the airport.';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        count(p, '.md-math') === 0 &&
        count(p, '.katex') === 0 &&
        line(p, 0) === 'It cost $20.' &&
        line(p, 2) === 'A coffee is $5 or $10 depending on the airport.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a dollar inside inline code stays inside the code',
    run: () => {
      const doc = 'Run `echo $HOME` and then `cat $PATH` to see it.';
      const p = mountProse(doc);
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        return (
          count(p, '.md-math') === 0 &&
          count(p, '.tok-inline-code') === 2 &&
          line(p, 0) === 'Run echo $HOME and then cat $PATH to see it.' &&
          p.doc() === doc
        );
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a dollar inside a fenced block stays code',
    run: () => {
      const doc = 'Shell:\n\n```sh\nexport A=$1\nexport B=$2\n```\n';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        count(p, '.md-math') === 0 &&
        line(p, 3) === 'export A=$1' &&
        line(p, 4) === 'export B=$2' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an escaped dollar stays a dollar',
    run: () => {
      const doc = 'It cost \\$5 and then \\$10.';
      const p = mountProse(doc);
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        return count(p, '.md-math') === 0 && line(p, 0) === 'It cost $5 and then $10.' && p.doc() === doc;
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a space just inside the delimiters is not maths',
    run: () => {
      const doc = 'Spend $ 5 or $ 10, not maths.\n\nNor is $x + y $ with a space before the close.';
      const p = mountProse(doc);
      p.select(0);
      const ok = count(p, '.md-math') === 0 && count(p, '.katex') === 0 && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a closing dollar followed by a digit is not a closing dollar',
    run: () => {
      const doc = 'Between $x$5 and $y$7 there is no equation.';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        count(p, '.md-math') === 0 && line(p, 0) === 'Between $x$5 and $y$7 there is no equation.' && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'inline maths that does not parse keeps its source, with the message on it',
    run: () => {
      const doc = 'Half typed: $\\undefinedcmd{x}$ here.';
      const p = mountProse(doc);
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        const marked = first(p, '.md-math-error');
        return (
          // Nothing is typeset, and nothing is hidden either.
          count(p, '.katex') === 0 &&
          count(p, '.md-math-inline') === 0 &&
          line(p, 0) === 'Half typed: $\\undefinedcmd{x}$ here.' &&
          (marked?.getAttribute('title') ?? '').includes('KaTeX') &&
          p.doc() === doc
        );
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a block equation that does not parse keeps its source, with the message on it',
    run: () => {
      const doc = 'Before.\n\n$$\n\\undefinedcmd{x}\n$$\n\nAfter.';
      const p = mountProse(doc);
      p.select(0);
      const marked = first(p, '.cm-line.md-math-error');
      const ok =
        count(p, '.katex') === 0 &&
        count(p, '.md-math-block') === 0 &&
        line(p, 2) === '$$' &&
        line(p, 3) === '\\undefinedcmd{x}' &&
        (marked?.getAttribute('title') ?? '').includes('KaTeX') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an unclosed $$ is left as written rather than swallowing what follows',
    run: () => {
      const doc = 'Before.\n\n$$\nP_r = P_t\n\nAfter, a separate paragraph.';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        count(p, '.md-math-block') === 0 &&
        line(p, 2) === '$$' &&
        line(p, 3) === 'P_r = P_t' &&
        line(p, 5) === 'After, a separate paragraph.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a wide block equation gets its own scrollable region, reachable from the keyboard',
    run: () => {
      const doc = '$$\nP_r = P_t + G_t + G_r - 20\\log_{10}(d) - 20\\log_{10}(f) - 147.55\n$$';
      const p = mountProse(doc);
      // The equation is the whole document, so the caret is inside it wherever
      // it goes: this is the one check that has to have the setting off.
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        const region = first(p, '.md-math-scroll');
        return (
          !!region &&
          region.tabIndex === 0 &&
          region.getAttribute('role') === 'region' &&
          (region.getAttribute('aria-label') ?? '').toLowerCase().includes('scroll') &&
          region.querySelectorAll('.katex').length === 1 &&
          p.doc() === doc
        );
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the equations a real document is written with typeset rather than falling back',
    run: () => {
      // Both blocks, as written in the sample link budget.
      const doc =
        'Received power follows the Friis transmission equation:\n\n' +
        '$$\nP_r = P_t \\, G_t \\, G_r \\left( \\frac{\\lambda}{4 \\pi d} \\right)^2\n$$\n\n' +
        'In decibels, which is how anyone actually does it:\n\n' +
        '$$\nP_r\\,[\\mathrm{dBW}] = P_t + G_t + G_r - 20\\log_{10}\\!\\left(\\frac{4\\pi d}{\\lambda}\\right) - L_\\text{misc}\n$$\n';
      const p = mountProse(doc);
      p.select(0);
      const ok =
        count(p, '.md-math-block') === 2 &&
        count(p, '.katex') === 2 &&
        count(p, '.md-math-error') === 0 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a dollar that opens nothing is left alone, whatever follows it',
    run: () => {
      // The backtick spelling of inline maths is not read as maths: the code
      // span is parsed first, and the dollars around it stay as typed.
      const doc = 'A template is ${toc}, and code is $`\\sqrt{2}`$.';
      const p = mountProse(doc);
      const ok = withoutRevealOnLine(() => {
        p.select(0);
        return (
          count(p, '.md-math') === 0 &&
          count(p, '.katex') === 0 &&
          count(p, '.tok-inline-code') === 1 &&
          line(p, 0) === 'A template is ${toc}, and code is $\\sqrt{2}$.' &&
          p.doc() === doc
        );
      });
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a one-line $$ block is drawn as a block, and $$ with nothing in it is left alone',
    run: () => {
      const doc = '$$E = mc^2$$\n\n$$\n$$\n';
      const p = mountProse(doc);
      p.select(doc.length);
      const ok =
        count(p, '.md-math-block') === 1 &&
        count(p, '.katex') === 1 &&
        // The empty pair is what someone has just typed and not filled in yet.
        lines(p).filter((l) => (l.textContent ?? '').trim() === '$$').length === 2 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
];
