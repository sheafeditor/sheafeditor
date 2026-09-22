import { Scenario, mountProse, Prose } from '../harness';
import { mountContextMenu, ContextMenuDeps } from '../../src/webview/contextmenu';

const G: any = globalThis;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Menu {
  shown: () => boolean;
  item: (label: string) => HTMLButtonElement | undefined;
  close: () => void;
}

/** Open the prose menu at the caret the way the keyboard does. */
function openMenu(p: Prose, extra: Partial<ContextMenuDeps> = {}): Menu {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, {
    getView: () => p.view,
    getFileName: () => 'doc.md',
    copyToClipboard: () => {},
    ...extra,
  });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const menus = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu'));
  return {
    shown: () => menus().some((m) => !m.hidden),
    item: (label) =>
      menus()
        .flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')))
        .find((b) => b.querySelector('span')!.textContent === label),
    close: () => document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove()),
  };
}

/** The document after Cmd+V of `text` with the caret at `at`: a native paste event on the editor. */
async function keyboardPaste(doc: string, at: number, text: string): Promise<string> {
  const p = mountProse(doc);
  p.select(at);
  const e = new G.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : ''), types: ['text/plain'], files: [], items: [] } });
  p.view.contentDOM.dispatchEvent(e);
  await tick();
  const out = p.doc();
  p.destroy();
  return out;
}

export const scenarios: Scenario[] = [
  {
    name: 'Cmd+V turns a copied spreadsheet range into a pipe table, and the menu offers no Paste of its own',
    run: async () => {
      const range = 'fruit\tqty\nkiwi\t2';
      const doc = 'Numbers below\n';
      const byKeys = await keyboardPaste(doc, doc.length, range);
      const table = byKeys.includes('| fruit | qty |') && !byKeys.includes('\t');
      // Inside a code block the tab-separated text is left as it is.
      const code = '```\n\n```';
      const codeKept = (await keyboardPaste(code, 4, range)) === '```\nfruit\tqty\nkiwi\t2\n```';
      // Plain text still lands at the caret.
      const plain = (await keyboardPaste('hello ', 6, 'world')) === 'hello world';
      // Pasting is the keyboard's and the platform menu bar's, so the right-click menu drops it.
      const p = mountProse(doc);
      p.select(doc.length);
      const m = openMenu(p);
      const noItem = !m.item('Paste');
      m.close();
      p.destroy();
      return table && codeKept && plain && noItem;
    },
  },
  {
    name: 'the right-click menu closes when the document scrolls, and stays open while the menu itself scrolls',
    run: async () => {
      // The scrolls here are the person's, so each one waits past the grace the
      // menu gives the gesture that opened it. Scrolling inside that window is the
      // opening click's own doing and is covered by its own scenario.
      const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
      const p = mountProse('# Title\n\nA paragraph of text.\n\n- [ ] a task');
      p.select(12);
      const m = openMenu(p);
      const openBefore = m.shown();
      // Scrolling a long submenu, or the menu itself, keeps it open.
      m.item('Turn into')!.click();
      await settle();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu'))) {
        el.dispatchEvent(new G.Event('scroll'));
      }
      const openAfterMenuScroll = m.shown();
      // Scrolling the document (scroll events do not bubble).
      p.view.scrollDOM.dispatchEvent(new G.Event('scroll'));
      const closedOnScroll = !m.shown();
      // A menu opened again closes on the next scroll as well.
      const m2 = openMenu(p);
      const reopened = m2.shown();
      await settle();
      p.view.scrollDOM.dispatchEvent(new G.Event('scroll'));
      const closedAgain = !m2.shown();
      m2.close();
      p.destroy();
      return openBefore && openAfterMenuScroll && closedOnScroll && reopened && closedAgain;
    },
  },
];
