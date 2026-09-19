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

/** The document after choosing Paste from the right-click menu with `text` on the clipboard. */
async function menuPaste(doc: string, at: number, text: string): Promise<string> {
  const p = mountProse(doc);
  p.select(at);
  const m = openMenu(p, { readClipboard: async () => text });
  m.item('Paste')!.click();
  await tick();
  await tick();
  const out = p.doc();
  m.close();
  p.destroy();
  return out;
}

export const scenarios: Scenario[] = [
  {
    name: 'menu Paste turns a copied spreadsheet range into a pipe table, as Cmd+V does',
    run: async () => {
      const range = 'fruit\tqty\nkiwi\t2';
      const doc = 'Numbers below\n';
      const byMenu = await menuPaste(doc, doc.length, range);
      const byKeys = await keyboardPaste(doc, doc.length, range);
      const table = byMenu.includes('| fruit | qty |') && !byMenu.includes('\t') && byMenu === byKeys;
      // Inside a code block both leave the tab-separated text as it is.
      const code = '```\n\n```';
      const inCodeByMenu = await menuPaste(code, 4, range);
      const inCodeByKeys = await keyboardPaste(code, 4, range);
      const codeKept = inCodeByMenu === '```\nfruit\tqty\nkiwi\t2\n```' && inCodeByMenu === inCodeByKeys;
      // Plain text still lands at the caret.
      const plain = (await menuPaste('hello ', 6, 'world')) === 'hello world';
      return table && codeKept && plain;
    },
  },
  {
    name: 'the right-click menu closes when the document scrolls, and stays open while the menu itself scrolls',
    run: () => {
      const p = mountProse('# Title\n\nA paragraph of text.\n\n- [ ] a task');
      p.select(12);
      const m = openMenu(p);
      const openBefore = m.shown();
      // Scrolling a long submenu, or the menu itself, keeps it open.
      m.item('Turn into')!.click();
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
      p.view.scrollDOM.dispatchEvent(new G.Event('scroll'));
      const closedAgain = !m2.shown();
      m2.close();
      p.destroy();
      return openBefore && openAfterMenuScroll && closedOnScroll && reopened && closedAgain;
    },
  },
];
