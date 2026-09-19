/*
 * The link popover while the file changes from outside: an address being typed
 * belongs to the link, not to the position the link started at.
 */

import { ChangeSpec, Transaction } from '@codemirror/state';
import { Scenario, mountProse, Prose } from '../harness';
import { setLinkHost } from '../../src/webview/linkTarget';

const G: any = globalThis;

const popover = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-linkpop');
const field = (p: Prose): HTMLInputElement | null => popover(p)?.querySelector<HTMLInputElement>('.sheaf-linkpop-url') ?? null;

/** Type `value` into the popover's address field the way a person does. */
const type = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};
const enter = (input: HTMLInputElement): void => {
  input.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};
/** A change made by another program, delivered the way the webview receives it. */
const remote = (p: Prose, changes: ChangeSpec, extra: { selection?: { anchor: number } } = {}): void => {
  p.view.dispatch({ changes, ...extra, annotations: Transaction.remote.of(true) });
};

const report = 'Plain words first.\n\nRead the [guide](https://a.io/g) first.';
const inGuide = report.indexOf('[guide') + 2;

export const scenarios: Scenario[] = [
  {
    name: 'an address being typed in the link popover survives text added or removed above the link',
    run: () => {
      const cases: [string, number, ChangeSpec, string][] = [
        ['x\n[a](u) z', 3, { from: 0, insert: 'ZZ' }, 'ZZx\n[a](https://new.io) z'],
        [report, inGuide, { from: 0, insert: 'Added by an agent.\n\n' }, 'Added by an agent.\n\nPlain words first.\n\nRead the [guide](https://new.io) first.'],
        [report, inGuide, { from: 0, to: 'Plain words first.\n\n'.length }, 'Read the [guide](https://new.io) first.'],
        ['x [a](u) z', 3, { from: 0, insert: 'ZZ' }, 'ZZx [a](https://new.io) z'],
      ];
      return cases.every(([doc, at, change, want]) => {
        const p = mountProse(doc);
        p.select(at);
        const input = field(p)!;
        type(input, 'https://new.io');
        remote(p, change);
        const after = field(p);
        const kept = after === input && after.value === 'https://new.io';
        enter(input);
        const got = p.doc();
        p.destroy();
        return kept && got === want;
      });
    },
  },
  {
    name: 'the link popover field still resets for a different link and closes when its link is deleted',
    run: () => {
      // The caret moves to another link after the file changed above both.
      const p1 = mountProse('[a](u) and [b](v)');
      p1.select(1);
      type(field(p1)!, 'typed');
      remote(p1, { from: 0, insert: 'ZZ' });
      const keptFirst = field(p1)?.value === 'typed';
      p1.select('ZZ[a](u) and [b'.length);
      const other = field(p1)?.value === 'v';
      p1.destroy();

      // The link is replaced by a new one at the same start with the same address.
      const p2 = mountProse('[a](u) z');
      p2.select(1);
      type(field(p2)!, 'typed');
      remote(p2, { from: 0, to: 6, insert: '[c](u)' }, { selection: { anchor: 1 } });
      const replaced = field(p2)?.value === 'u';
      p2.destroy();

      // The link is deleted from outside.
      const p3 = mountProse('x [a](u) z');
      p3.select(3);
      type(field(p3)!, 'typed');
      remote(p3, { from: 2, to: 8 });
      const closed = popover(p3) === null && p3.doc() === 'x  z';
      p3.destroy();

      return keptFirst && other && replaced && closed;
    },
  },
  {
    name: 'the popover open button takes the one opener, host routing and guard included',
    run: () => {
      // The fourth way to follow a link, and the only one with no seam to inject:
      // the button calls the shared opener directly, so driving it is the only way
      // to know it reaches the host and refuses a script address.
      const win = document.defaultView as any;
      const opened: string[] = [];
      const posted: unknown[] = [];
      const originalClick = win.HTMLAnchorElement.prototype.click;
      win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
        opened.push(this.getAttribute('href') ?? '');
      };
      setLinkHost((message) => posted.push(message));
      const press = (doc: string): void => {
        const p = mountProse(doc);
        // The caret inside a link is what opens the popover.
        p.select(doc.indexOf('[') + 2);
        popover(p)!.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
        p.destroy();
      };
      try {
        press('Read the [log](log/2244-11.md) now.');
        press('Read the [site](https://a.io/g) now.');
        press('Read the [bad](javascript:alert(1)) now.');
        return (
          // Relative: nothing in the webview can resolve it, so it goes to the host.
          JSON.stringify(posted) === JSON.stringify([{ type: 'openLink', address: 'log/2244-11.md' }]) &&
          // A scheme: still the browser's. The script address reached neither, which
          // is what the two lengths pin.
          JSON.stringify(opened) === JSON.stringify(['https://a.io/g'])
        );
      } finally {
        win.HTMLAnchorElement.prototype.click = originalClick;
        setLinkHost(() => {});
      }
    },
  },
];
