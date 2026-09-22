/*
 * Alerts: a blockquote that opens with `> [!NOTE]` and reads as a callout.
 *
 * What the reader sees is read back from the editor DOM, so every check moves
 * the caret out of the quote first: with "Reveal Syntax On Line" on, which is
 * the default these tests run under, a caret inside a block shows that block's
 * raw Markdown, and that is exactly what the reveal scenario below relies on.
 *
 * jsdom has no layout and no theme, so nothing here can see the colour a
 * callout is drawn in, the icon's shape, or where the label sits on the line.
 * These scenarios check which type each quote is recognised as, which text is
 * hidden and which is left alone, and that the document never changes; the
 * appearance is a real-window check.
 */

import { Scenario, mountProse } from '../harness';

type P = ReturnType<typeof mountProse>;

const lines = (p: P): HTMLElement[] => Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));

/** Rendered text of line `i` (0-based), with the space left by the hidden `>` trimmed off. */
const line = (p: P, i: number): string => (lines(p)[i]?.textContent ?? '').trim();

/** Whether line `i` (0-based) carries class `cls`. */
const hasClass = (p: P, i: number, cls: string): boolean => lines(p)[i]?.classList.contains(cls) ?? false;

const count = (p: P, selector: string): number => p.view.contentDOM.querySelectorAll(selector).length;

/** The labels drawn in place of marker lines, in document order. */
const labels = (p: P): string[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-alert-name')).map((e) => e.textContent ?? '');

export const scenarios: Scenario[] = [
  {
    name: 'each of the five markers renders as its callout, with its own type on every line of the quote',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE]\n> Body.\n\n> [!TIP]\n> Body.\n\n> [!IMPORTANT]\n> Body.\n\n> [!WARNING]\n> Body.\n\n> [!CAUTION]\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const kinds = ['note', 'tip', 'important', 'warning', 'caution'];
      const ok =
        labels(p).join(',') === 'Note,Tip,Important,Warning,Caution' &&
        count(p, '.md-alert-icon') === 5 &&
        // The marker line reads as the label alone: no `[!NOTE]` is left on it.
        kinds.every((kind, i) => line(p, 2 + i * 3) === ['Note', 'Tip', 'Important', 'Warning', 'Caution'][i]) &&
        // Marker line and body both carry the quote rule and the type's colour.
        kinds.every(
          (kind, i) =>
            hasClass(p, 2 + i * 3, 'tok-quote') &&
            hasClass(p, 2 + i * 3, 'tok-alert') &&
            hasClass(p, 2 + i * 3, `tok-alert-${kind}`) &&
            hasClass(p, 3 + i * 3, 'tok-quote') &&
            hasClass(p, 3 + i * 3, 'tok-alert') &&
            hasClass(p, 3 + i * 3, `tok-alert-${kind}`)
        ) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a lower-case marker is the same alert as an upper-case one',
    run: () => {
      const doc = 'Intro.\n\n> [!note]\n> Body.\n\n> [!Caution]\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Note,Caution' &&
        hasClass(p, 2, 'tok-alert-note') &&
        hasClass(p, 5, 'tok-alert-caution') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a title after the marker is the callout’s label, and the marker line reads as that title',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE] Before you start\n> Body.\n\n> [!warning]   Mind the gap  \n> Body.\n\n> [!tip] See **this** and [docs](x)\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        // A title is shown as written, Markdown and all, and the syntax inside it
        // does not break into the label.
        labels(p).join('|') === 'Before you start|Mind the gap|See **this** and [docs](x)' &&
        line(p, 8) === 'See **this** and [docs](x)' &&
        count(p, '.md-alert-icon') === 3 &&
        line(p, 2) === 'Before you start' &&
        line(p, 5) === 'Mind the gap' &&
        hasClass(p, 2, 'tok-alert-note') &&
        hasClass(p, 3, 'tok-alert-note') &&
        hasClass(p, 5, 'tok-alert-warning') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a fold marker after the type is hidden with the rest of the marker, and the callout is drawn open',
    run: () => {
      const doc = 'Intro.\n\n> [!TIP]-\n> Folded body.\n\n> [!WARNING]+ Open with a title\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Tip,Open with a title' &&
        line(p, 2) === 'Tip' &&
        line(p, 5) === 'Open with a title' &&
        hasClass(p, 2, 'tok-alert-tip') &&
        hasClass(p, 5, 'tok-alert-warning') &&
        // Drawn expanded: the body of a folded callout is still on screen.
        line(p, 3) === 'Folded body.' &&
        !/[+-]/.test(labels(p)[0]) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a type outside the five takes the nearest of their styles and is labelled with its own name',
    run: () => {
      const doc =
        'Intro.\n\n> [!question]\n> B.\n\n> [!example]\n> B.\n\n> [!quote]\n> B.\n\n> [!Danger]\n> B.\n\n> [!attention]\n> B.\n\n> [!success]\n> B.\n\n> [!my-type2]\n> B.';
      const p = mountProse(doc);
      p.select(2);
      const styles = ['tip', 'note', 'note', 'caution', 'warning', 'tip', 'note'];
      const ok =
        labels(p).join(',') === 'Question,Example,Quote,Danger,Attention,Success,My-type2' &&
        styles.every((kind, i) => hasClass(p, 2 + i * 3, `tok-alert-${kind}`) && hasClass(p, 3 + i * 3, `tok-alert-${kind}`)) &&
        count(p, '.md-alert-icon') === 7 &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a quote that merely opens with a bracketed word stays an ordinary quote, spelled as written',
    run: () => {
      const doc =
        'Intro.\n\n> [draft] notes\n> Body.\n\n> [ ] x\n> Body.\n\n> [!]\n> Body.\n\n> [!NOTE]title\n> Body.\n\n> See [!NOTE] later.\n> Body.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        count(p, '.md-alert-label') === 0 &&
        count(p, '.tok-alert') === 0 &&
        line(p, 2) === '[draft] notes' &&
        line(p, 5) === '[ ] x' &&
        line(p, 8) === '[!]' &&
        line(p, 11) === '[!NOTE]title' &&
        line(p, 14) === 'See [!NOTE] later.' &&
        [2, 5, 8, 11, 14].every((i) => hasClass(p, i, 'tok-quote')) &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret on a titled or folded marker line shows it as source, byte for byte',
    run: () => {
      const doc = 'Intro.\n\n> [!question]- Why this way?\n> Body text.';
      const p = mountProse(doc);
      p.select(2);
      const rendered = labels(p).join(',') === 'Why this way?' && line(p, 2) === 'Why this way?';
      p.select(doc.indexOf('question') + 2);
      const revealed =
        count(p, '.md-alert-label') === 0 &&
        line(p, 2) === '> [!question]- Why this way?' &&
        hasClass(p, 2, 'tok-alert-tip');
      p.select(2);
      const again = labels(p).join(',') === 'Why this way?';
      const ok = rendered && revealed && again && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'bracket text anywhere but the quote’s first line is left exactly as written',
    run: () => {
      const doc =
        'Intro.\n\n> [!NOTE]\n> See [1] and [!something] below.\n\n> A plain quote.\n> [!NOTE] here is just text.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Note' &&
        line(p, 3) === 'See [1] and [!something] below.' &&
        // The second quote never opens with a marker, so nothing in it changes.
        !hasClass(p, 5, 'tok-alert') &&
        !hasClass(p, 6, 'tok-alert') &&
        line(p, 6) === '[!NOTE] here is just text.' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the caret in an alert shows the marker line as source, and leaving it draws the callout again',
    run: () => {
      const doc = 'Intro.\n\n> [!WARNING]\n> Body text.';
      const p = mountProse(doc);
      p.select(2);
      const rendered = labels(p).join(',') === 'Warning' && line(p, 2) === 'Warning';
      // The caret goes into the body; the whole quote shows its Markdown.
      p.select(doc.indexOf('Body text.') + 2);
      const revealed =
        count(p, '.md-alert-label') === 0 &&
        line(p, 2) === '> [!WARNING]' &&
        // The colour stays on while the source shows, so the block does not jump.
        hasClass(p, 2, 'tok-alert-warning');
      // Back out to the paragraph.
      p.select(2);
      const again = labels(p).join(',') === 'Warning' && line(p, 2) === 'Warning';
      const ok = rendered && revealed && again && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an alert renders the Markdown in its body, and a lazy continuation line belongs to it',
    run: () => {
      const doc = 'Intro.\n\n> [!IMPORTANT]\n> **Bold** and *italic*.\nLazy continuation.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Important' &&
        count(p, '.tok-strong') === 1 &&
        count(p, '.tok-em') === 1 &&
        line(p, 3) === 'Bold and italic.' &&
        hasClass(p, 4, 'tok-alert-important') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an alert inside a list item renders, and a marker inside a nested quote stays text',
    run: () => {
      const doc =
        'Intro.\n\n- An item:\n\n  > [!TIP]\n  > Nested in a list.\n\n> [!NOTE]\n> Outer.\n>\n> > [!CAUTION]\n> > Inner.';
      const p = mountProse(doc);
      p.select(2);
      const ok =
        labels(p).join(',') === 'Tip,Note' &&
        hasClass(p, 4, 'tok-alert-tip') &&
        hasClass(p, 7, 'tok-alert-note') &&
        // A marker in a nested quote is ordinary text on GitHub, and it is here too:
        // the line keeps the outer alert's type and shows what is written.
        !hasClass(p, 10, 'tok-alert-caution') &&
        hasClass(p, 10, 'tok-alert-note') &&
        line(p, 4) === 'Tip' &&
        line(p, 10) === '[!CAUTION]' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'typing in an alert changes only what was typed, and the callout comes back',
    run: () => {
      const doc = 'Intro.\n\n> [!NOTE]\n> Body.';
      const p = mountProse(doc);
      const at = doc.indexOf('Body.') + 5;
      p.select(at);
      p.view.dispatch({ changes: { from: at, insert: ' More.' }, selection: { anchor: at + 6 }, userEvent: 'input.type' });
      const typed = p.doc() === 'Intro.\n\n> [!NOTE]\n> Body. More.';
      p.select(2);
      const ok = typed && labels(p).join(',') === 'Note' && line(p, 3) === 'Body. More.';
      p.destroy();
      return ok;
    },
  },
];
