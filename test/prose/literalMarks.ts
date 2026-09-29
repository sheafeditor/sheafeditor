/*
 * Where a mark's delimiters would be text, the command refuses and the control
 * says so.
 *
 * Bold inside an inline code span wrote `**code**` onto the screen, because
 * inside code the asterisks are characters. The same inside an autolink destroyed
 * the link and showed its angle brackets, and on a footnote reference gave
 * `[^**1**]`. The address half of a `[text](address)` is not prose either, though
 * the text half is and bolding that is an ordinary thing to want.
 *
 * Refusing alone is not enough: a control that can be pressed and does nothing is
 * its own defect, and the context menu already drew formatting unavailable inside
 * a code *block* for exactly this reason. So the toolbar button is asked the same
 * question, and this checks the button rather than the command, because the
 * button is the part a person sees.
 *
 * Every case has its opposite in the same list. Without them a change that
 * disabled the marks everywhere would pass.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { mountToolbar, refreshToolbar } from '../../src/webview/toolbar';

/** Mount the toolbar over `p` and hand back the button for `command`. */
function button(p: Prose, command: string): { el: HTMLButtonElement; bar: HTMLElement } {
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false);
  return { el: bar.querySelector<HTMLButtonElement>(`[data-command="${command}"]`)!, bar };
}

/** Whether `command`'s button is available with `target` selected in `doc`. */
function available(doc: string, target: string, command: string): boolean {
  const p = mountProse(doc);
  const from = doc.indexOf(target);
  p.select(from, from + target.length);
  const { el, bar } = button(p, command);
  refreshToolbar(p.view);
  const on = !el.disabled;
  bar.remove();
  p.destroy();
  return on;
}

/** `[doc, what is selected, which button, whether it must be available, why]` */
const CASES: [string, string, string, boolean, string][] = [
  ['Before `snip` after', 'snip', 'bold', false, 'inside a code span the asterisks would be characters'],
  ['Before <http://example.test> after', 'example', 'bold', false, 'marking inside an autolink destroys the link'],
  ['Before [text](http://example.test) after', 'example', 'bold', false, 'the address half of a link is not prose'],
  ['Before text[^1] after', '1', 'bold', false, 'a footnote reference took the marks inside its brackets'],
  ['Before words after', 'words', 'bold', true, 'CONTROL: plain prose is what the button is for'],
  ['Before [text](http://example.test) after', 'text', 'bold', true, "CONTROL: a link's label is prose and bolding it is ordinary"],
  ['# Heading words here', 'words', 'bold', true, 'CONTROL: a heading holds marks like any other prose'],
  ['Before `snip` after', 'snip', 'code', true, 'CONTROL: inside a code span is where Inline code is used to turn one off'],
];

export const scenarios: Scenario[] = [
  {
    name: 'a mark is drawn unavailable where its delimiters would be text, and available everywhere else',
    run: () => {
      const wrong = CASES.filter(([doc, target, command, want]) => available(doc, target, command) !== want);
      return {
        ok: wrong.length === 0,
        detail:
          wrong.map(([, target, command, want, why]) => `${command} on ${JSON.stringify(target)} should be ${want ? 'available' : 'unavailable'} (${why})`).join('; ') ||
          `all ${CASES.length} cases as wanted`,
      };
    },
  },
];
