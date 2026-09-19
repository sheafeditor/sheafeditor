import { Scenario, mountProse } from '../harness';
import { createShortcutsOverlay } from '../../src/webview/shortcuts';

/**
 * An editor with the caret in the text and the shortcuts overlay beside it, as
 * the webview has them: the toolbar button keeps the editor focused when it is
 * clicked, so the overlay opens with focus still in the document.
 */
function setup() {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const p = mountProse('Say hello to the world today.');
  p.select(7);
  p.view.focus();
  const overlay = createShortcutsOverlay(parent);
  const backdrop = parent.querySelector('.sheaf-sc-backdrop') as HTMLElement;
  return {
    p,
    overlay,
    backdrop,
    panel: parent.querySelector('.sheaf-sc-panel') as HTMLElement,
    /** Whether the keys someone types would go into the document. */
    inDocument: () => document.activeElement === p.view.contentDOM,
    inOverlay: () => !!document.activeElement && backdrop.contains(document.activeElement),
    destroy: () => {
      p.destroy();
      parent.remove();
    },
  };
}

export const scenarios: Scenario[] = [
  {
    name: 'opening the Keyboard shortcuts overlay takes focus out of the document, so a key typed while it is open cannot reach the text behind it',
    run: () => {
      const s = setup();
      const startedInDocument = s.inDocument();
      s.overlay.toggle();
      const ok = s.overlay.isOpen() && !s.inDocument() && s.inOverlay();
      // The panel is the dialog, so focus belongs to it or something inside it.
      const onPanel = s.panel.contains(document.activeElement);
      s.destroy();
      return startedInDocument && ok && onPanel;
    },
  },
  {
    name: 'closing the shortcuts overlay puts focus back where it was, whichever way it is closed',
    run: () => {
      // Esc, the ✕ button, a click on the backdrop, and the toolbar button again.
      const closers: ((s: ReturnType<typeof setup>) => void)[] = [
        (s) => s.panel.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
        (s) => (s.panel.querySelector('.sheaf-sc-close') as HTMLElement).click(),
        (s) => s.backdrop.dispatchEvent(new (globalThis as any).MouseEvent('mousedown', { bubbles: true, cancelable: true })),
        (s) => s.overlay.toggle(),
      ];
      return closers.every((close) => {
        const s = setup();
        s.overlay.toggle();
        const opened = s.overlay.isOpen() && !s.inDocument();
        close(s);
        const ok = opened && !s.overlay.isOpen() && s.inDocument();
        s.destroy();
        return ok;
      });
    },
  },
];
