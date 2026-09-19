/*
 * Dragging a block by its grip. jsdom has no layout or pointer capture, so these
 * hover by dispatching mousemove on a line, drive the grip with the pointer events
 * a real drag would deliver, and read the drop line, the dimmed source lines and
 * the text. Heights come from CodeMirror's estimates, which is enough to tell one
 * gap from another.
 *
 * jsdom has no keyboard routing either: an event dispatched here reaches the window
 * whatever has focus, while a real webview is sent a key only while focus is inside
 * it. So the Escape checks below press the key only where the focus actually is,
 * and read the focus the press itself leaves behind, which is the part of the
 * behaviour jsdom can answer for.
 */

import { Scenario, Prose, mountProse } from '../harness';
import { blockDropTargets, blockRangeAt, moveBlockTo, nearestDropIndex } from '../../src/webview/blockModel';

const G: any = globalThis;

const DOC = '# Alpha\n\nFirst paragraph here.\n\n# Beta\n\nSecond paragraph here.\n';
const PARA = DOC.indexOf('First');

/** Let the handle's measure pass (requestAnimationFrame is a timeout here) run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const handleOf = (p: Prose): HTMLElement => p.view.scrollDOM.querySelector('.sheaf-block-handle') as HTMLElement;
const gripOf = (p: Prose): HTMLElement => p.view.scrollDOM.querySelector('.sheaf-block-grip') as HTMLElement;
const indicatorOf = (p: Prose): HTMLElement => p.view.scrollDOM.querySelector('.sheaf-block-drop') as HTMLElement;
const dimmed = (p: Prose): number => p.view.contentDOM.querySelectorAll('.sheaf-block-dragging').length;

function fire(el: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const event = new G.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

/** A viewport y inside the block that starts at `pos`, from the editor's height map. */
function yAt(p: Prose, pos: number): number {
  const block = p.view.lineBlockAt(pos);
  return p.view.documentTop + block.top + Math.min(4, block.height / 2);
}

/** Hover the line holding `pos` so the handle shows for its block. */
async function hoverBlock(p: Prose, pos: number): Promise<boolean> {
  await settle();
  const line = p.view.domAtPos(pos).node;
  const el = (line.nodeType === 1 ? line : line.parentElement) as Element;
  fire(el, 'mousemove', { clientX: 10, clientY: yAt(p, pos) });
  await settle();
  return !handleOf(p).hidden;
}

/** Press the grip and move with the button held to each y in turn. */
function pressAndMove(p: Prose, from: number, ys: number[]): void {
  const grip = gripOf(p);
  fire(grip, 'pointerdown', { clientY: from, buttons: 1 });
  for (const y of ys) fire(grip, 'pointermove', { clientY: y, buttons: 1 });
}

/** Put the keyboard focus outside the editor, as it is in a webview nobody has clicked in. */
function focusOutside(): HTMLElement {
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  outside.focus();
  return outside;
}

/** True while the keyboard focus is somewhere the webview's own window would hear a key. */
const focusInEditor = (p: Prose): boolean => {
  const active = document.activeElement;
  return !!active && p.view.dom.contains(active);
};

/**
 * Press Escape where the focus actually is. A webview is sent a key only while focus
 * is inside it, so with the focus outside the editor nothing is dispatched at all:
 * that key went to the editor around the webview, which is what the drag would see.
 */
function pressEscapeWhereFocusIs(p: Prose): void {
  if (!focusInEditor(p)) return;
  document.activeElement!.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

export const scenarios: Scenario[] = [
  {
    name: "a dragged block's own place is a drop slot, and it is the one nearest the block itself",
    run: () => {
      const p = mountProse(DOC);
      const para = blockRangeAt(p.view.state, PARA)!;
      const targets = blockDropTargets(p.view.state, para)!;
      const s = targets.siblings;
      const view = p.view;
      const ys = targets.indices.map((index) => {
        let y: number;
        if (index >= s.length) y = view.lineBlockAt(s[s.length - 1].to).bottom;
        else if (index === 0) y = view.lineBlockAt(s[0].from).top;
        else y = (view.lineBlockAt(s[index - 1].to).bottom + view.lineBlockAt(s[index].from).top) / 2;
        return { index, y };
      });
      const middle = (view.lineBlockAt(para.from).top + view.lineBlockAt(para.to).bottom) / 2;
      const nearest = nearestDropIndex(ys, middle);
      const home = targets.home ?? [];
      const stays = home.every((i) => moveBlockTo(p.view.state, para, i) === null);
      p.destroy();
      return (
        targets.indices.join(',') === '0,1,2,3,4' && home.join(',') === '1,2' && nearest !== null && home.includes(nearest) && stays
      );
    },
  },
  {
    name: 'letting go of a dragged block over its own place leaves the file unchanged and shows no drop line',
    run: async () => {
      const p = mountProse(DOC);
      const shown = await hoverBlock(p, PARA);
      const y = yAt(p, PARA);
      pressAndMove(p, y, [y + 10, y + 40, y]);
      const lineHidden = indicatorOf(p).hidden;
      const wasDimmed = dimmed(p) > 0;
      fire(gripOf(p), 'pointerup', { clientY: y });
      const doc = p.doc();
      const clean = dimmed(p) === 0 && indicatorOf(p).hidden;
      p.destroy();
      return shown && wasDimmed && lineHidden && clean && doc === DOC;
    },
  },
  {
    name: 'dragging a block past its neighbour still moves it there',
    run: async () => {
      const p = mountProse(DOC);
      const shown = await hoverBlock(p, PARA);
      const y = yAt(p, PARA);
      const end = p.view.documentTop + p.view.lineBlockAt(p.view.state.doc.length).bottom + 20;
      pressAndMove(p, y, [y + 10, end]);
      const lineShown = !indicatorOf(p).hidden;
      fire(gripOf(p), 'pointerup', { clientY: end });
      const doc = p.doc();
      p.destroy();
      return shown && lineShown && doc === '# Alpha\n\n# Beta\n\nSecond paragraph here.\n\nFirst paragraph here.\n';
    },
  },
  ...(
    [
      ['the window losing focus', (p: Prose) => fire(window, 'blur')],
      ['the next pointer move with no button held', (p: Prose) => fire(document.body, 'pointermove', { clientY: 5, buttons: 0 })],
      ['the next mouse move with no button held', (p: Prose) => fire(p.view.contentDOM, 'mousemove', { clientY: 5, buttons: 0 })],
      ['the grip losing pointer capture', (p: Prose) => fire(gripOf(p), 'lostpointercapture')],
    ] as [string, (p: Prose) => void][]
  ).map(
    ([signal, end]): Scenario => ({
      name: `a drag let go outside the editor ends on ${signal}: the block is drawn normally, the drop line goes and nothing moves`,
      run: async () => {
        const p = mountProse(DOC);
        const shown = await hoverBlock(p, PARA);
        const y = yAt(p, PARA);
        const far = p.view.documentTop + p.view.lineBlockAt(p.view.state.doc.length).bottom + 20;
        pressAndMove(p, y, [y + 10, far]);
        const midDrag = dimmed(p) > 0 && !indicatorOf(p).hidden;
        end(p);
        const ended = dimmed(p) === 0 && indicatorOf(p).hidden && !p.view.dom.classList.contains('sheaf-block-drag-active');
        // A late release on the grip belongs to no drag and moves nothing.
        fire(gripOf(p), 'pointerup', { clientY: far });
        const doc = p.doc();
        const noMenu = !document.querySelector('.sheaf-block-menu');
        p.destroy();
        return shown && midDrag && ended && doc === DOC && noMenu;
      },
    })
  ),
  {
    name: 'pressing the grip in an editor nobody has clicked in puts the keyboard focus inside it',
    run: async () => {
      const p = mountProse(DOC);
      const outside = focusOutside();
      const shown = await hoverBlock(p, PARA);
      const before = focusInEditor(p);
      const y = yAt(p, PARA);
      pressAndMove(p, y, [y + 10, y + 40]);
      const after = focusInEditor(p);
      p.destroy();
      outside.remove();
      return shown && !before && after;
    },
  },
  {
    name: 'Escape cancels a drag begun before any click in the text: the drop line goes, the block is drawn normally and letting go moves nothing',
    run: async () => {
      const p = mountProse(DOC);
      const outside = focusOutside();
      const shown = await hoverBlock(p, PARA);
      const y = yAt(p, PARA);
      const far = p.view.documentTop + p.view.lineBlockAt(p.view.state.doc.length).bottom + 20;
      pressAndMove(p, y, [y + 10, far]);
      const midDrag = dimmed(p) > 0 && !indicatorOf(p).hidden;
      pressEscapeWhereFocusIs(p);
      const cancelled = dimmed(p) === 0 && indicatorOf(p).hidden && !p.view.dom.classList.contains('sheaf-block-drag-active');
      fire(gripOf(p), 'pointerup', { clientY: far });
      const doc = p.doc();
      const noMenu = !document.querySelector('.sheaf-block-menu');
      p.destroy();
      outside.remove();
      return shown && midDrag && cancelled && doc === DOC && noMenu;
    },
  },
  {
    name: 'pressing the grip leaves the focus alone in an editor that already has it, so the caret and its selection stay drawn',
    run: async () => {
      const p = mountProse(DOC);
      // jsdom always answers that no document has focus, and that is half of what
      // CodeMirror reads to tell whether the editor holds the keyboard. Answering
      // yes for this check is the only way to ask what the grip does to an editor
      // that is already being typed in.
      const real = document.hasFocus;
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
      try {
        p.select(PARA + 2);
        p.view.focus();
        const editorHadIt = p.view.hasFocus;
        const shown = await hoverBlock(p, PARA);
        const y = yAt(p, PARA);
        pressAndMove(p, y, [y + 10, y + 40]);
        const keptIt = p.view.hasFocus && document.activeElement === p.view.contentDOM;
        return shown && editorHadIt && keptIt;
      } finally {
        Object.defineProperty(document, 'hasFocus', { value: real, configurable: true });
        p.destroy();
      }
    },
  },
  ...(['pointerup', 'mouseup'] as const).map(
    (type): Scenario => ({
      name: `a ${type} anywhere in the editor ends a drag and drops the block at the line shown`,
      run: async () => {
        const p = mountProse(DOC);
        const shown = await hoverBlock(p, PARA);
        const y = yAt(p, PARA);
        const far = p.view.documentTop + p.view.lineBlockAt(p.view.state.doc.length).bottom + 20;
        pressAndMove(p, y, [y + 10, far]);
        fire(document.body, type, { clientY: far });
        const ended = dimmed(p) === 0 && indicatorOf(p).hidden;
        const doc = p.doc();
        p.destroy();
        return shown && ended && doc === '# Alpha\n\n# Beta\n\nSecond paragraph here.\n\nFirst paragraph here.\n';
      },
    })
  ),
];
