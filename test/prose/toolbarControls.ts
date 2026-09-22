/*
 * What the toolbar puts in the bar, and how much of it there is.
 *
 * The bar holds a fixed set of controls, so it has a fixed width, and the stylesheet
 * keeps it on one row by tightening its spacing before it lets it wrap. That tightening
 * buys a fixed number of pixels, which means the headroom is spent by every control
 * added to the bar. jsdom has no layout, so the width itself is only judged in a real
 * window; what is held here is the count the spacing was sized against, so adding a
 * control is a deliberate act rather than a row appearing under someone's document.
 *
 * The second scenario is the promise the bar makes to somebody who does not use a
 * mouse: every control in it is a button in the document, reachable by tabbing, and
 * none of them is behind a pointer-only gesture.
 */

import { Scenario, mountProse } from '../harness';
import { mountToolbar } from '../../src/webview/toolbar';

/** The bar, mounted over an empty document, with the controls it puts in it. */
function mountBar(): { bar: HTMLElement; controls: HTMLElement[]; remove: () => void } {
  const p = mountProse('Hello.\n');
  const bar = document.createElement('div');
  bar.className = 'sheaf-toolbar';
  document.body.appendChild(bar);
  mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false, () => {}, false);
  // The controls that take room on the row: the buttons and the dropdown triggers.
  // A dropdown's menu items sit in a popup and cost the row nothing.
  const controls = Array.from(bar.querySelectorAll<HTMLElement>('.sheaf-tb-btn'));
  return {
    bar,
    controls,
    remove: () => {
      bar.remove();
      p.destroy();
    },
  };
}

export const scenarios: Scenario[] = [
  {
    name: 'the toolbar holds the number of controls its spacing is sized for',
    run: () => {
      const { controls, remove } = mountBar();
      const count = controls.length;
      remove();
      return count === 20;
    },
  },
  {
    name: 'every toolbar control is a button in the bar, so tabbing reaches all of them',
    run: () => {
      const { bar, controls, remove } = mountBar();
      const ok =
        controls.length > 0 &&
        controls.every(
          (el) =>
            el.tagName === 'BUTTON' &&
            bar.contains(el) &&
            !el.hasAttribute('hidden') &&
            el.getAttribute('tabindex') !== '-1' &&
            !!(el.getAttribute('aria-label') || el.title)
        );
      remove();
      return ok;
    },
  },
];
