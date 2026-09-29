/*
 * What the mouse does to a link in prose: a click opens it, a right-click edits it, and a drag
 * that starts on one selects instead.
 *
 * These drive `linkGesture.ts` directly, with `posAtCoords` stubbed. jsdom has no layout, so a
 * hit test there answers null for every point and the gesture would decline every press for a
 * reason that has nothing to do with the rule being checked. Stubbing it is what lets the real
 * decision run: which press opens, which release opens, and which does neither.
 */

import { Scenario, mountProse, Prose } from '../harness';
import { contextMenuOnLink, pressOnLinkIn, releaseOnLinkIn } from '../../src/webview/linkGesture';
import { setLinkHost } from '../../src/webview/linkTarget';
import { popoverLink } from '../../src/webview/floatingState';

const DOC = 'Read the [guide](https://example.com/g) and the [notes](https://example.com/n) today.\n';

/** Mount `DOC` with `posAtCoords` answering from the x coordinate, so a point names a position. */
function mounted(doc = DOC): { p: Prose; opened: string[]; at: (needle: string) => number } {
  const p = mountProse(doc);
  const opened: string[] = [];
  setLinkHost((message: any) => opened.push(message.url ?? message.address ?? JSON.stringify(message)));
  // The window's own anchor click is the other way a link is followed; catch both.
  const win = document.defaultView as any;
  const original = win.HTMLAnchorElement.prototype.click;
  win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    opened.push(this.getAttribute('href') ?? '');
  };
  (p as any).restoreAnchor = () => {
    win.HTMLAnchorElement.prototype.click = original;
    setLinkHost(null as any);
  };
  // x is the document position; y is ignored. Every coordinate in these scenarios is a position.
  (p.view as any).posAtCoords = ({ x }: { x: number }) => (x >= 0 && x <= doc.length ? x : null);
  return { p, opened, at: (needle: string) => doc.indexOf(needle) + 1 };
}

const press = (p: Prose, x: number, init: MouseEventInit = {}): { opened: boolean; hold: any } =>
  pressOnLinkIn(p.view, new MouseEvent('mousedown', { clientX: x, clientY: 0, button: 0, ...init }));

const release = (p: Prose, x: number, held: any): boolean =>
  releaseOnLinkIn(p.view, new MouseEvent('mouseup', { clientX: x, clientY: 0, button: 0 }), held);

export const scenarios: Scenario[] = [
  {
    name: 'A plain press on a link opens nothing, and the release on the same link opens it once',
    run: () => {
      const { p, opened, at } = mounted();
      const guide = at('guide');
      const { opened: onPress, hold } = press(p, guide);
      const duringPress = opened.length;
      const followed = release(p, guide, hold);
      const after = opened.slice();
      (p as any).restoreAnchor();
      p.destroy();
      // The press must not open: it is also the start of a selection, and taking it would
      // make dragging through a link impossible.
      return !onPress && duringPress === 0 && !!hold && followed && after.length === 1 && after[0].includes('example.com/g');
    },
  },
  {
    name: 'A press on a link released four pixels away still opens, and twenty pixels away does not',
    run: () => {
      const { p, opened, at } = mounted();
      const guide = at('guide');
      /*
       * A press and release by hand moves a pixel or two, so requiring exactness would make the
       * gesture work for some people and not others. A deliberate drag always goes further.
       */
      const near = press(p, guide);
      const closeEnough = releaseOnLinkIn(
        p.view,
        new MouseEvent('mouseup', { clientX: guide + 3, clientY: 3, button: 0 }),
        near.hold
      );
      const afterNear = opened.length;
      const far = press(p, guide);
      const tooFar = releaseOnLinkIn(p.view, new MouseEvent('mouseup', { clientX: guide + 20, clientY: 0, button: 0 }), far.hold);
      const afterFar = opened.length;
      (p as any).restoreAnchor();
      p.destroy();
      return closeEnough && afterNear === 1 && !tooFar && afterFar === 1;
    },
  },
  {
    name: 'Pressing on one link and releasing on another opens neither',
    run: () => {
      const { p, opened, at } = mounted();
      const { hold } = press(p, at('guide'));
      const followed = release(p, at('notes'), hold);
      const count = opened.length;
      (p as any).restoreAnchor();
      p.destroy();
      return !!hold && !followed && count === 0;
    },
  },
  {
    name: 'A release with no press held on a link opens nothing, so a release that ends a selection is inert',
    run: () => {
      const { p, opened, at } = mounted();
      const followed = release(p, at('guide'), null);
      const count = opened.length;
      (p as any).restoreAnchor();
      p.destroy();
      return !followed && count === 0;
    },
  },
  {
    name: 'Cmd and a press opens the link there and then, with nothing held for the release',
    run: () => {
      const { p, opened, at } = mounted();
      const { opened: onPress, hold } = press(p, at('guide'), { metaKey: true });
      const after = opened.slice();
      (p as any).restoreAnchor();
      p.destroy();
      return onPress && hold === null && after.length === 1 && after[0].includes('example.com/g');
    },
  },
  {
    name: 'A press somewhere that is not a link holds nothing and opens nothing',
    run: () => {
      const { p, opened } = mounted();
      const { opened: onPress, hold } = press(p, DOC.indexOf('today') + 1);
      (p as any).restoreAnchor();
      p.destroy();
      return !onPress && hold === null && opened.length === 0;
    },
  },
  {
    name: 'A plain click on a picture opens nothing, though Cmd and a click still opens the file',
    run: () => {
      /*
       * `linkAddressAt` answers for an image as well as a link, which is right for the Cmd-click
       * that has always opened one and wrong for a plain click: a picture is a thing in the
       * document, and clicking it took the person to the editor's image preview and away from
       * what they were reading. Caught by a real-window scenario that drags a selection across a
       * picture and ended up with the `.png` open in a second tab.
       */
      const doc = 'Before.\n\n![Dawn](assets/dawn.png)\n\nAfter.\n';
      const { p, opened } = mounted(doc);
      const at = doc.indexOf('Dawn') + 1;
      const plain = press(p, at);
      const afterPlain = opened.length;
      const followed = release(p, at, plain.hold);
      const held = plain.hold;
      const withMod = press(p, at, { metaKey: true });
      const afterMod = opened.length;
      (p as any).restoreAnchor();
      p.destroy();
      if (held !== null || plain.opened || followed || afterPlain !== 0) {
        return { ok: false, detail: `a plain click on the picture held ${JSON.stringify(held)} and opened ${afterPlain}` };
      }
      return withMod.opened && afterMod === 1 ? true : { ok: false, detail: `Cmd-click opened ${afterMod}, and it should still open the file` };
    },
  },
  {
    name: 'A right-click on a link opens its popover over that link, with the address ready to change',
    run: () => {
      const { p, at } = mounted();
      const took = contextMenuOnLink(p.view, new MouseEvent('contextmenu', { clientX: at('notes'), clientY: 0, button: 2 }));
      const link = popoverLink(p.view.state);
      const url = p.view.dom.querySelector<HTMLInputElement>('.sheaf-linkpop-url');
      const text = p.view.dom.querySelector<HTMLInputElement>('.sheaf-linkpop-text');
      const doc = p.doc();
      (p as any).restoreAnchor();
      p.destroy();
      // Both fields, because editing the words is the action the right-click menu never had.
      return took && !!link && url?.value === 'https://example.com/n' && text?.value === 'notes' && doc === DOC;
    },
  },
  {
    name: 'CONTROL: a right-click on ordinary prose opens no popover, so the context menu still gets it',
    run: () => {
      const { p } = mounted();
      // Without this, a change that sent every right-click to the popover would pass the
      // scenario above and take the context menu away from the whole document.
      const took = contextMenuOnLink(p.view, new MouseEvent('contextmenu', { clientX: DOC.indexOf('today') + 1, clientY: 0, button: 2 }));
      const link = popoverLink(p.view.state);
      (p as any).restoreAnchor();
      p.destroy();
      return !took && link === null;
    },
  },
];
