import { searchPanelOpen, findNext, getSearchQuery } from '@codemirror/search';
import { Scenario, mountProse, Prose } from '../harness';
import { revealField, setLivePreviewConfig } from '../../src/webview/livePreview';
import { mountToolbar, refreshToolbar } from '../../src/webview/toolbar';
import { mountContextMenu, ContextMenuDeps } from '../../src/webview/contextmenu';
import { setupImageIngestion, handleImageSaved, insertImageFiles } from '../../src/webview/images';

const G: any = globalThis;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/* ---- Find and replace ---- */

const findPanel = (p: Prose): HTMLElement | null => p.view.dom.querySelector('.cm-panels-top .sheaf-find');
const field = (p: Prose, name: string): HTMLInputElement => findPanel(p)!.querySelector(`[name=${name}]`) as HTMLInputElement;
const typeInto = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};
const clickNamed = (p: Prose, name: string): void => (findPanel(p)!.querySelector(`button[name=${name}]`) as HTMLButtonElement).click();

/* ---- Toolbar ---- */

const mountBar = (p: Prose): HTMLElement => {
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  mountToolbar(bar, () => p.view, () => {}, () => {}, () => false, false);
  return bar;
};
const pressed = (bar: HTMLElement, cmd: string): boolean => {
  const b = bar.querySelector(`[data-command="${cmd}"]`);
  return !!b && b.classList.contains('is-active') && b.getAttribute('aria-pressed') === 'true';
};

/* ---- Context menu ---- */

interface Menu {
  labels: () => string[];
  item: (label: string) => HTMLButtonElement | undefined;
  close: () => void;
}

/** Open the prose menu at the caret the way the keyboard does, and read what it offers. */
function openMenu(p: Prose, extra: Partial<ContextMenuDeps> = {}, copied: string[] = []): Menu {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  mountContextMenu(p.view.dom, {
    getView: () => p.view,
    getFileName: () => 'doc.md',
    copyToClipboard: (t) => copied.push(t),
    ...extra,
  });
  p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
  const visible = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).filter((m) => !m.hidden);
  const all = (): HTMLButtonElement[] => visible().flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')));
  return {
    labels: () => all().map((b) => b.querySelector('span')!.textContent ?? ''),
    item: (label) => all().find((b) => b.querySelector('span')!.textContent === label),
    close: () => document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove()),
  };
}

export const scenarios: Scenario[] = [
  {
    name: 'Mod-f opens find at the top of the editor, and replace all rewrites only the matches',
    run: () => {
      const p = mountProse('one kiwi, two kiwis\nkiwi');
      const handled = p.press('Mod-f');
      const open = searchPanelOpen(p.view.state) && !!findPanel(p);
      const focused = document.activeElement === field(p, 'search');
      typeInto(field(p, 'search'), 'kiwi');
      typeInto(field(p, 'replace'), 'pear');
      clickNamed(p, 'replaceAll');
      const replaced = p.doc() === 'one pear, two pears\npear';
      const closed = p.press('Escape') && !searchPanelOpen(p.view.state);
      p.destroy();
      return handled && open && focused && replaced && closed;
    },
  },
  {
    name: 'Mod-Alt-f opens find with the replace field focused; Mod-d and Mod-Shift-l stay unbound here',
    run: () => {
      const p = mountProse('alpha beta alpha');
      p.select(0, 5);
      const handled = p.press('Mod-Alt-f');
      const panel = findPanel(p);
      const replaceShown = !!panel && !field(p, 'replace').closest('[hidden]');
      const replaceFocused = document.activeElement === field(p, 'replace');
      const seeded = getSearchQuery(p.view.state).search === 'alpha';
      const count = panel?.querySelector('.sheaf-find-count')?.textContent ?? '';
      p.press('Escape');
      p.select(0, 5);
      const reserved = !p.press('Mod-d') && !p.press('Mod-Shift-l');
      p.destroy();
      return handled && replaceShown && replaceFocused && seeded && count === '1 of 2' && reserved;
    },
  },
  {
    // This scenario used to assert the opposite: that finding a match inside a
    // table turned it into raw pipes until the selection moved on. That was the
    // defect itself, since the table went raw at the moment
    // someone found the value they were after and stayed raw once Escape closed
    // the panel, the match still being selected. The grid now survives the match,
    // which is readable in its cell because that is what a grid draws.
    name: 'a match inside a table leaves it a grid, with the match readable in its cell',
    run: () => {
      const doc = '.\n\n| fruit | qty |\n| --- | --- |\n| kiwi | 2 |\n\nkiwi at the end';
      const p = mountProse(doc);
      const gridBefore = p.view.dom.querySelectorAll('.sheaf-table').length === 1;
      p.press('Mod-f');
      typeInto(field(p, 'search'), 'kiwi');
      findNext(p.view);
      const sel = p.view.state.selection.main;
      const onMatch = p.view.state.sliceDoc(sel.from, sel.to) === 'kiwi' && sel.from < doc.indexOf('\n\nkiwi at');
      const staysAGrid = p.view.dom.querySelectorAll('.sheaf-table').length === 1;
      const readable = Array.from(p.view.dom.querySelectorAll('.sheaf-table [data-r]')).some((c) =>
        (c.textContent ?? '').includes('kiwi')
      );
      findNext(p.view);
      const gridStill = p.view.dom.querySelectorAll('.sheaf-table').length === 1;
      const unchanged = p.doc() === doc;
      p.destroy();
      return gridBefore && onMatch && staysAGrid && readable && gridStill && unchanged;
    },
  },
  {
    name: 'a match inside hidden Markdown syntax reveals that line so the match can be seen',
    run: () => {
      // The webview's default: syntax is hidden even on the line holding the selection.
      setLivePreviewConfig({ revealSyntaxOnLine: false });
      const p = mountProse('intro\n\nsee [site](https://kiwi.example) now');
      p.press('Mod-f');
      typeInto(field(p, 'search'), 'site');
      clickNamed(p, 'next');
      const visibleNotRevealed = p.view.state.field(revealField) === null;
      typeInto(field(p, 'search'), 'example');
      clickNamed(p, 'next');
      const reveal = p.view.state.field(revealField);
      const line = p.view.state.doc.line(3);
      const ok = visibleNotRevealed && !!reveal && reveal.from === line.from && reveal.to === line.to;
      p.destroy();
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      return ok;
    },
  },
  {
    name: 'toolbar buttons show the formatting at the selection as pressed',
    run: () => {
      const p = mountProse('**bold [link](u)** and ==hi==\n## Title\n- [ ] task\n1. one\n> quote\n```\ncode\n```');
      const bar = mountBar(p);
      const s = p.view.state;
      const at = (pos: number): void => {
        p.select(pos);
        refreshToolbar(p.view);
      };
      at(9);
      const inLink = pressed(bar, 'bold') && pressed(bar, 'link') && !pressed(bar, 'italic');
      at(25);
      const inHighlight = pressed(bar, 'highlight') && !pressed(bar, 'bold');
      at(s.doc.line(2).from + 4);
      const heading = (bar.querySelector('[data-command="heading"]')?.textContent ?? '').includes('H2');
      at(s.doc.line(3).from + 8);
      const task = pressed(bar, 'task') && !pressed(bar, 'bullet');
      at(s.doc.line(4).from + 4);
      const ordered = pressed(bar, 'ordered');
      at(s.doc.line(5).from + 3);
      const quote = pressed(bar, 'quote') && (bar.querySelector('[data-command="heading"]')?.textContent ?? '').includes('Text');
      at(s.doc.line(7).from + 1);
      const code = pressed(bar, 'codeBlock') && !pressed(bar, 'quote');
      p.destroy();
      bar.remove();
      return inLink && inHighlight && heading && task && ordered && quote && code;
    },
  },
  {
    name: 'toolbar has highlight, task, clear formatting, undo and redo, and an insert menu',
    run: () => {
      const p = mountProse('word');
      const bar = mountBar(p);
      refreshToolbar(p.view);
      const undo = bar.querySelector<HTMLButtonElement>('[data-command="undo"]')!;
      const redo = bar.querySelector<HTMLButtonElement>('[data-command="redo"]')!;
      const idle = undo.disabled && redo.disabled;
      p.select(0, 4);
      bar.querySelector<HTMLButtonElement>('[data-command="highlight"]')!.click();
      const highlighted = p.doc() === '==word==';
      refreshToolbar(p.view);
      undo.click();
      refreshToolbar(p.view);
      const undone = p.doc() === 'word' && !redo.disabled;
      redo.click();
      const redone = p.doc() === '==word==';
      const present = ['task', 'clearFormatting'].every((c) => !!bar.querySelector(`[data-command="${c}"]`));
      const insert = Array.from(bar.querySelectorAll('[data-command="insert"] ~ .sheaf-tb-menu .sheaf-tb-menu-item span:first-child')).map(
        (s) => s.textContent
      );
      p.destroy();
      bar.remove();
      return idle && highlighted && undone && redone && present && insert.join('|') === 'Markdown table|CSV data table|Code block|Divider|Image';
    },
  },
  {
    name: 'an image chosen from the picker is saved by the host and linked at the caret',
    run: async () => {
      const p = mountProse('text');
      p.select(4);
      const sent: any[] = [];
      setupImageIngestion(p.view, (m) => sent.push(m));
      const file = { name: 'cat.png', type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as File;
      const done = insertImageFiles(p.view, [file]);
      await tick();
      const asked = sent[0]?.type === 'saveImage' && sent[0]?.name === 'cat.png';
      handleImageSaved(sent[0]?.id, 'assets/cat.png');
      await done;
      const ok = asked && p.doc() === 'text\n![cat](assets/cat.png)\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Send to terminal sits beside Copy ref, and is absent where the host cannot send one',
    run: () => {
      const sent: number[] = [];
      const p = mountProse('one\n\ntwo words\n\nthree');
      p.select(7);
      // With the host offering it: the item is there, next to Copy ref, and asks for the command.
      const withHost = openMenu(p, { sendRefToTerminal: () => sent.push(1) });
      const labels = withHost.labels();
      const beside = labels.indexOf('Send to terminal') === labels.indexOf('Copy ref') + 1;
      withHost.item('Send to terminal')!.click();
      withHost.close();
      // Without it: no item, rather than one that does nothing.
      const without = openMenu(p);
      const gone = !without.labels().includes('Send to terminal');
      without.close();
      const ok = beside && sent.length === 1 && gone && p.doc() === 'one\n\ntwo words\n\nthree';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Copy ref shows its key where the host binds it, and no key in a host that does not',
    run: () => {
      const p = mountProse('one\n\ntwo words\n\nthree');
      p.select(7);
      const key = (m: ReturnType<typeof openMenu>) => m.item('Copy ref')?.querySelector('.sheaf-ctx-key')?.textContent ?? null;
      // VS Code: the host offers Send to terminal, and binds both keys.
      const withHost = openMenu(p, { sendRefToTerminal: () => {} });
      const shown = key(withHost);
      const terminalKey = withHost.item('Send to terminal')?.querySelector('.sheaf-ctx-key')?.textContent ?? null;
      withHost.close();
      // A browser tab: no terminal, and nothing binds the key, so no hint claims one.
      const without = openMenu(p);
      const absent = key(without);
      without.close();
      p.destroy();
      // Copy ref is the plainer chord of the pair: it is the one reached all day, so it
      // carries one modifier fewer than Send to terminal rather than matching it.
      return (
        !!shown &&
        !!terminalKey &&
        /c$/i.test(shown) &&
        /t$/i.test(terminalKey) &&
        shown.length < terminalKey.length &&
        absent === null
      );
    },
  },
  {
    name: 'the prose menu leads with Turn into and Edit Markdown, then the marks, Copy ref and the link actions',
    run: () => {
      const opened: string[] = [];
      const copied: string[] = [];
      const p = mountProse('go to [the site](https://example.com) now');
      p.select(9);
      const m = openMenu(p, { openLink: (u) => opened.push(u) }, copied);
      const labels = m.labels();
      const order = ['Turn into', 'Edit Markdown', 'Highlight', 'Inline code', 'Clear formatting', 'Copy ref', 'Open link', 'Copy link address', 'Remove link'];
      const offered = order.every((l, i) => labels.indexOf(l) >= 0 && (i === 0 || labels.indexOf(l) > labels.indexOf(order[i - 1])));
      // Inside a link there is nothing to link, so Link is not offered a second time.
      const noSecondLink = !labels.includes('Link');
      m.item('Copy link address')!.click();
      const m2 = openMenu(p, { openLink: (u) => opened.push(u) }, copied);
      m2.item('Open link')!.click();
      const m3 = openMenu(p, {}, copied);
      m3.item('Remove link')!.click();
      const ok = offered && noSecondLink && copied[0] === 'https://example.com' && opened[0] === 'https://example.com' && p.doc() === 'go to the site now';
      m3.close();
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the prose menu copies a code block body, and disables formatting inside it',
    run: () => {
      const copied: string[] = [];
      const p = mountProse('```js\nlet a = 1;\nlet b = 2;\n```');
      p.select(8);
      const m = openMenu(p, {}, copied);
      const disabled = ['Highlight', 'Inline code', 'Link'].every((l) => m.item(l)?.disabled);
      m.item('Copy code')!.click();
      const ok = disabled && copied[0] === 'let a = 1;\nlet b = 2;';
      m.close();
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the prose menu marks a task done and not done',
    run: () => {
      const p = mountProse('- [ ] write tests');
      p.select(10);
      const m = openMenu(p);
      m.item('Mark done')!.click();
      const done = p.doc() === '- [x] write tests';
      const m2 = openMenu(p);
      const offersUndone = !!m2.item('Mark not done') && !m2.item('Mark done');
      m2.item('Mark not done')!.click();
      const ok = done && offersUndone && p.doc() === '- [ ] write tests';
      m2.close();
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the prose menu leaves cut, copy, paste and the three common marks to the keyboard and the selection toolbar',
    run: async () => {
      const p = mountProse('hello world');
      p.select(6, 11);
      const m = openMenu(p);
      const labels = m.labels();
      const gone = ['Cut', 'Copy', 'Paste', 'Bold', 'Italic', 'Strikethrough'].every((l) => !labels.includes(l));
      m.close();
      // The selection toolbar comes up on the same gesture and still carries the three marks.
      const bar = p.view.dom.querySelector('.sheaf-seltb');
      const onToolbar = ['bold', 'italic', 'strike'].every((c) => !!bar?.querySelector(`[data-cmd="${c}"]`));
      // And the paste the editor handles itself is untouched by the menu losing its item.
      const e = new G.Event('paste', { bubbles: true, cancelable: true });
      const data = { getData: (t: string) => (t === 'text/plain' ? 'there' : ''), types: ['text/plain'], files: [], items: [] };
      Object.defineProperty(e, 'clipboardData', { value: data });
      p.view.contentDOM.dispatchEvent(e);
      await tick();
      const pasted = p.doc() === 'hello there';
      p.destroy();
      return gone && onToolbar && pasted;
    },
  },
  {
    name: 'Turn into replaces the block kind of the line and marks the current kind',
    run: () => {
      const p = mountProse('- item\n> quoted');
      p.select(3);
      const m = openMenu(p);
      m.item('Turn into')!.click();
      const current = m.item('Bullet list')?.getAttribute('aria-checked') === 'true';
      m.item('Heading 2')!.click();
      const heading = p.doc() === '## item\n> quoted';
      p.select(p.doc().length);
      const m2 = openMenu(p);
      m2.item('Turn into')!.click();
      m2.item('Text')!.click();
      const text = p.doc() === '## item\nquoted';
      m2.close();
      p.destroy();
      // Out of a fenced code block, Text drops the fences and leaves the code's own lines alone.
      const q = mountProse('```\n- a\n# b\n```');
      q.select(5);
      const m3 = openMenu(q);
      m3.item('Turn into')!.click();
      const onlyTwo = m3.item('Heading 1')!.disabled && !m3.item('Text')!.disabled;
      m3.item('Text')!.click();
      const unfenced = q.doc() === '- a\n# b';
      m3.close();
      q.destroy();
      return current && heading && text && onlyTwo && unfenced;
    },
  },
  {
    name: 'Mod-Alt-4 toggles a task list and Mod-Alt-8 a code block',
    run: () => {
      const p = mountProse('todo');
      p.select(2);
      const task = p.press('Mod-Alt-4') && p.doc() === '- [ ] todo';
      p.select(8);
      const code = p.press('Mod-Alt-8') && p.doc() === '```\n- [ ] todo\n```';
      p.destroy();
      return task && code;
    },
  },
];
