// Unit scenarios for the menus: right-click menu, its keyboard use, the selection
// toolbar, the link popover, the slash menu and find and replace. Each asserts
// what should be true; a failing scenario is a bug candidate.
import { undo } from '@codemirror/commands';
import { searchPanelOpen } from '@codemirror/search';
import { mountProse } from '../../harness';
import { mountContextMenu, ContextMenuDeps } from '../../../src/webview/contextmenu';
import { setClipboardHost } from '../../../src/webview/hostClipboard';
import { slashMenuOf } from '../../../src/webview/slashMenu';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}
type Prose = ReturnType<typeof mountProse>;

const G: any = globalThis;
if (!G.Window && G.window?.Window) G.Window = G.window.Window;
const j = (x: unknown): string => JSON.stringify(x);
const same = (got: string, want: string): Result => ({ ok: got === want, detail: got === want ? '' : `got ${j(got)}, want ${j(want)}` });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const key = (target: EventTarget, name: string, init: Record<string, unknown> = {}): KeyboardEvent => {
  const e = new G.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

/* ---- Right-click menu ---------------------------------------------------- */

interface Menu {
  copied: string[];
  opened: string[];
  visible: () => boolean;
  labels: () => string[];
  item: (label: string) => HTMLButtonElement | undefined;
  focusedLabel: () => string;
  cleanup: () => void;
}

const labelOf = (b: Element | null): string => (b?.querySelector('span')?.textContent ?? '');

/** Mount the menu on an editor. `open` dispatches the contextmenu event the keyboard path sends. */
function menuFor(p: Prose, extra: Partial<ContextMenuDeps> = {}): Menu & { open: () => void } {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  const copied: string[] = [];
  const opened: string[] = [];
  mountContextMenu(p.view.dom, {
    getView: () => p.view,
    getFileName: () => 'doc.md',
    copyToClipboard: (t) => copied.push(t),
    openLink: (u) => opened.push(u),
    ...extra,
  });
  const menus = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).filter((m) => !m.hidden);
  const all = (): HTMLButtonElement[] => menus().flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')));
  return {
    copied,
    opened,
    open: () => p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })),
    visible: () => menus().length > 0,
    labels: () => all().map(labelOf),
    item: (label) => all().find((b) => labelOf(b) === label),
    focusedLabel: () => (document.activeElement?.classList.contains('sheaf-ctx-item') ? labelOf(document.activeElement) : `<${(document.activeElement as HTMLElement)?.className || document.activeElement?.tagName}>`),
    // A menu left open keeps its document listeners, which would swallow later scenarios' keys: close it first.
    cleanup: () => {
      document.body.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
    },
  };
}

/** Mount `doc`, put the selection at [anchor, head], open the menu, run `fn`, return the document and the menu. */
async function withMenu(doc: string, anchor: number, head: number | undefined, fn: (m: Menu, p: Prose) => unknown, extra: Partial<ContextMenuDeps> = {}): Promise<{ doc: string; m: Menu; out: unknown }> {
  const p = mountProse(doc);
  p.select(anchor, head);
  const m = menuFor(p, extra);
  m.open();
  const out = await fn(m, p);
  const result = p.doc();
  m.cleanup();
  p.destroy();
  return { doc: result, m, out };
}

/** Open Turn into and click `label` in it. */
const turnInto = (m: Menu, label: string): void => {
  m.item('Turn into')!.click();
  const it = m.item(label);
  if (!it) throw new Error(`no ${label} in Turn into; offered ${j(m.labels())}`);
  it.click();
};

/* ---- Selection toolbar and link popover ---------------------------------- */

const seltb = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-seltb');
const popover = (p: Prose): HTMLElement | null => p.view.dom.querySelector<HTMLElement>('.sheaf-linkpop');
const block = (p: Prose, kind: string): HTMLButtonElement => seltb(p)!.querySelector<HTMLButtonElement>(`[data-block="${kind}"]`)!;

function toolbarTurn(doc: string, anchor: number, head: number, kind: string): string {
  const p = mountProse(doc);
  p.select(anchor, head);
  const bar = seltb(p);
  if (!bar) {
    p.destroy();
    return '<no toolbar>';
  }
  block(p, kind).click();
  const out = p.doc();
  p.destroy();
  return out;
}

function popoverEnter(doc: string, at: number, url: string): { doc: string; closed: boolean; shown: string | undefined } {
  const p = mountProse(doc);
  p.select(at);
  const pop = popover(p);
  if (!pop) {
    p.destroy();
    return { doc: '<no popover>', closed: false, shown: undefined };
  }
  const input = pop.querySelector<HTMLInputElement>('.sheaf-linkpop-url')!;
  const shown = input.value;
  input.value = url;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
  key(input, 'Enter');
  const out = { doc: p.doc(), closed: popover(p) === null, shown };
  p.destroy();
  return out;
}

/* ---- Slash menu ----------------------------------------------------------- */

/** Type text at the caret one character at a time, as keyboard input arrives. */
function type(p: Prose, text: string): void {
  for (const ch of text) {
    const head = p.view.state.selection.main.head;
    p.view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

const slashOpensAt = (doc: string, at: number): boolean => {
  const p = mountProse(doc);
  p.select(at);
  type(p, '/');
  const open = slashMenuOf(p.view.state) !== null;
  p.destroy();
  return open;
};

/* ---- Find ------------------------------------------------------------------ */

const findPanel = (p: Prose): HTMLElement | null => p.view.dom.querySelector('.cm-panels-top .sheaf-find');
const field = (p: Prose, name: string): HTMLInputElement => findPanel(p)!.querySelector(`[name=${name}]`) as HTMLInputElement;
const typeInto = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new G.Event('input', { bubbles: true }));
};
const clickNamed = (p: Prose, name: string): void => (findPanel(p)!.querySelector(`button[name=${name}]`) as HTMLButtonElement).click();
const countText = (p: Prose): string => findPanel(p)?.querySelector('.sheaf-find-count')?.textContent ?? '';

function findIn(doc: string, fn: (p: Prose) => unknown): { doc: string; out: unknown } {
  const p = mountProse(doc);
  p.press('Mod-Alt-f');
  const out = fn(p);
  const result = p.doc();
  p.destroy();
  return { doc: result, out };
}

export const scenarios: Scenario[] = [
  /* ==== menus.context-prose ==== */
  {
    id: 'menus.context-prose.u01',
    feature: 'menus.context-prose',
    name: 'On a link written with an angle-bracket address, Copy link address and Open link use the address without the brackets',
    run: async () => {
      const { m } = await withMenu('see [a file](<my file.md>) now', 6, undefined, (m) => {
        m.item('Copy link address')?.click();
      });
      const { m: m2 } = await withMenu('see [a file](<my file.md>) now', 6, undefined, (m) => {
        m.item('Open link')?.click();
      });
      return { ok: m.copied[0] === 'my file.md' && m2.opened[0] === 'my file.md', detail: `copied ${j(m.copied)}, opened ${j(m2.opened)}` };
    },
  },
  {
    id: 'menus.context-prose.u02',
    feature: 'menus.context-prose',
    name: 'Typing inside a link while its menu is open, then Remove link, keeps every letter of the link text',
    run: async () => {
      const { doc, out } = await withMenu('go [site](https://a.io) now', 6, undefined, (m, p) => {
        p.view.dispatch({ changes: { from: 6, insert: 'Z' }, selection: { anchor: 7 }, userEvent: 'input.type' });
        if (!m.visible()) return 'closed';
        m.item('Remove link')!.click();
        return 'clicked';
      });
      return { ok: out === 'closed' || doc === 'go siZte now', detail: `${out}: ${j(doc)}` };
    },
  },
  {
    id: 'menus.context-prose.u03',
    feature: 'menus.context-prose',
    name: 'When the file changes above a task while its menu is open, Mark done still ticks that task',
    run: async () => {
      const { doc, out } = await withMenu('intro\n- [ ] write', 13, undefined, (m, p) => {
        p.view.dispatch({ changes: { from: 0, insert: 'ZZ' } });
        if (!m.visible()) return 'closed';
        m.item('Mark done')!.click();
        return 'clicked';
      });
      return { ok: out === 'closed' || doc === 'ZZintro\n- [x] write', detail: `${out}: ${j(doc)}` };
    },
  },
  {
    id: 'menus.context-prose.u04',
    feature: 'menus.context-prose',
    name: 'Copy ref on a whole line selected the way a triple-click selects it (up to the start of the next line) names only that line',
    run: async () => {
      const { m } = await withMenu('one\ntwo\nthree', 4, 8, (m) => m.item('Copy ref')!.click());
      return { ok: (m.copied[0] ?? '').startsWith('doc.md:2\n'), detail: j(m.copied) };
    },
  },
  {
    id: 'menus.context-prose.u05',
    feature: 'menus.context-prose',
    name: 'Copy ref on a selection holding a code fence names the line range and grows its own fence past the one inside',
    run: async () => {
      const doc = 'a\n```js\nx\n```\nb';
      const { m } = await withMenu(doc, 0, doc.length, (m) => m.item('Copy ref')!.click());
      return same(m.copied[0] ?? '', 'doc.md:1-5\n\n````\na\n```js\nx\n```\nb\n````\n');
    },
  },
  {
    id: 'menus.context-prose.u06',
    feature: 'menus.context-prose',
    name: 'Turn into Heading 1 on a YAML front matter line leaves the front matter as it was',
    run: async () => {
      const doc = '---\ntitle: Notes\n---\n\nBody';
      const { doc: got, out } = await withMenu(doc, 8, undefined, (m) => {
        // Turn into is disabled outright on front matter, so its submenu never opens and there is
        // no Heading 1 to reach. Read the items that are there, and take the route anyway in case
        // a later change re-enables it: the document must be unchanged either way.
        const turn = m.item('Turn into');
        turn?.click();
        const h1 = m.item('Heading 1');
        const mark = m.item('Highlight');
        const state = {
          turnDisabled: turn ? turn.disabled : null,
          h1Enabled: h1 ? !h1.disabled : false,
          markEnabled: mark ? !mark.disabled : false,
        };
        if (h1 && !h1.disabled) h1.click();
        return state;
      });
      const state = out as { turnDisabled: boolean | null; h1Enabled: boolean; markEnabled: boolean };
      return {
        ok: got === doc && state.turnDisabled === true && !state.h1Enabled && !state.markEnabled,
        detail: `${j(out)} -> ${j(got)}`,
      };
    },
  },
  {
    id: 'menus.context-prose.u07',
    feature: 'menus.context-prose',
    name: 'Turn into Bullet list over two paragraphs leaves the blank line between them blank',
    run: async () => same((await withMenu('one\n\ntwo', 0, 8, (m) => turnInto(m, 'Bullet list'))).doc, '- one\n\n- two'),
  },
  {
    id: 'menus.context-prose.u08',
    feature: 'menus.context-prose',
    name: 'Turn into Numbered list over two paragraphs numbers them 1 and 2',
    run: async () => same((await withMenu('one\n\ntwo', 0, 8, (m) => turnInto(m, 'Numbered list'))).doc, '1. one\n\n2. two'),
  },
  {
    id: 'menus.context-prose.u09',
    feature: 'menus.context-prose',
    name: 'Turn into Heading 1 over a selection that spans a table leaves the table rows untouched',
    run: async () => {
      const table = '| a | b |\n| - | - |\n| 1 | 2 |';
      const doc = `intro\n\n${table}\n\nend`;
      const { doc: got } = await withMenu(doc, 0, doc.length, (m) => turnInto(m, 'Heading 1'));
      return { ok: got.includes(`\n${table}\n`), detail: j(got) };
    },
  },
  {
    id: 'menus.context-prose.u10',
    feature: 'menus.context-prose',
    name: 'With the caret in a highlighted word, Highlight shows a check and choosing it takes the highlight off',
    run: async () => {
      // Bold, Italic and Strikethrough left this menu for the selection toolbar, which appears on
      // the gesture that makes them meaningful. Highlight is the mark the menu still carries, and
      // it is the same check-and-toggle path.
      const { doc, out } = await withMenu('say ==hello== now', 8, undefined, (m) => {
        const checked = m.item('Highlight')!.getAttribute('aria-checked');
        m.item('Highlight')!.click();
        return checked;
      });
      return { ok: out === 'true' && doc === 'say hello now', detail: `checked ${out}, doc ${j(doc)}` };
    },
  },
  {
    id: 'menus.context-prose.u11',
    feature: 'menus.context-prose',
    name: 'Clear formatting is disabled on plain text and removes the markers around a caret in bold',
    run: async () => {
      const plain = await withMenu('plain **bold**', 2, undefined, (m) => m.item('Clear formatting')!.disabled);
      const bold = await withMenu('plain **bold**', 9, undefined, (m) => {
        const disabled = m.item('Clear formatting')!.disabled;
        m.item('Clear formatting')!.click();
        return disabled;
      });
      return { ok: plain.out === true && bold.out === false && bold.doc === 'plain bold', detail: `plain disabled ${plain.out}, bold disabled ${bold.out}, doc ${j(bold.doc)}` };
    },
  },
  {
    id: 'menus.context-prose.u12',
    feature: 'menus.context-prose',
    name: 'Copy code in an indented code block copies the code without its four-space indent',
    run: async () => {
      const { m, out } = await withMenu('para\n\n    let a = 1;\n    let b;\n\nafter', 12, undefined, (m) => {
        const has = !!m.item('Copy code');
        m.item('Copy code')?.click();
        return has;
      });
      return { ok: out === true && m.copied[0] === 'let a = 1;\nlet b;', detail: `offered ${out}, copied ${j(m.copied)}` };
    },
  },
  {
    id: 'menus.context-prose.u13',
    feature: 'menus.context-prose',
    name: 'On a bare URL the menu offers Open link and Copy link address, and no Remove link',
    run: async () => {
      const { m, out } = await withMenu('see https://example.com now', 8, undefined, (m) => {
        const labels = m.labels();
        m.item('Copy link address')?.click();
        return labels;
      });
      const labels = out as string[];
      return { ok: labels.includes('Open link') && !labels.includes('Remove link') && m.copied[0] === 'https://example.com', detail: `${j(labels)} copied ${j(m.copied)}` };
    },
  },
  {
    id: 'menus.context-prose.u14',
    feature: 'menus.context-prose',
    name: 'The menu leaves cut, copy and paste to the keyboard, which already binds all three',
    run: async () => {
      // The menu used to carry them, and its Paste had its own clipboard read to normalise Windows
      // line endings. Both are gone: the editor's own paste handler does that, and the three
      // commands need no menu to be found.
      const { doc, out } = await withMenu('x', 1, undefined, (m) => m.labels());
      const gone = ['Cut', 'Copy', 'Paste'].filter((label) => (out as string[]).includes(label));
      return { ok: gone.length === 0 && doc === 'x', detail: `still offered ${j(gone)}; menu ${j(out)}` };
    },
  },
  {
    id: 'menus.context-prose.u15',
    feature: 'menus.context-prose',
    name: 'Remove link on a link with a title keeps only the link text',
    run: async () => same((await withMenu('go [see](https://a.io "T") now', 5, undefined, (m) => m.item('Remove link')!.click())).doc, 'go see now'),
  },
  {
    id: 'menus.context-prose.u16',
    feature: 'menus.context-prose',
    name: 'Mark done works on a task inside a blockquote',
    run: async () => same((await withMenu('> - [ ] x', 8, undefined, (m) => m.item('Mark done')!.click())).doc, '> - [x] x'),
  },
  {
    id: 'menus.context-prose.u17',
    feature: 'menus.context-prose',
    name: 'Link on a selected word wraps it and selects the url placeholder',
    run: async () => {
      const p = mountProse('hello world');
      p.select(6, 11);
      const m = menuFor(p);
      m.open();
      m.item('Link')!.click();
      const sel = p.view.state.selection.main;
      const ok = p.doc() === 'hello [world](url)' && p.view.state.sliceDoc(sel.from, sel.to) === 'url';
      const detail = `${j(p.doc())} selected ${j(p.view.state.sliceDoc(sel.from, sel.to))}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.context-prose.u18',
    feature: 'menus.context-prose',
    name: 'On a Heading 4 line Turn into checks Heading 4, and Heading 1 replaces the four hashes',
    run: async () => {
      const { doc, out } = await withMenu('#### Deep', 6, undefined, (m) => {
        m.item('Turn into')!.click();
        const labels = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];
        const checked = labels.filter((l) => m.item(l)!.getAttribute('aria-checked') === 'true');
        m.item('Heading 1')!.click();
        return checked;
      });
      return { ok: (out as string[]).join('|') === 'Heading 4' && doc === '# Deep', detail: `checked ${j(out)} doc ${j(doc)}` };
    },
  },

  /* ==== menus.context-keyboard ==== */
  {
    id: 'menus.context-keyboard.u01',
    feature: 'menus.context-keyboard',
    name: 'Shift+F10 opens the menu and focuses its first enabled item, Turn into',
    run: () => {
      const p = mountProse('hello world');
      p.select(3);
      const m = menuFor(p);
      const e = key(p.view.contentDOM, 'F10', { shiftKey: true });
      const ok = m.visible() && m.focusedLabel() === 'Turn into' && e.defaultPrevented;
      const detail = `visible ${m.visible()} focused ${m.focusedLabel()} prevented ${e.defaultPrevented}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.context-keyboard.u02',
    feature: 'menus.context-keyboard',
    name: 'Arrow keys skip disabled items and wrap, and Home and End jump to the first and last item',
    run: () => {
      const p = mountProse('hello world');
      p.select(3);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      const seen: string[] = [m.focusedLabel()];
      key(document.activeElement!, 'ArrowUp');
      seen.push(m.focusedLabel());
      key(document.activeElement!, 'ArrowDown');
      seen.push(m.focusedLabel());
      key(document.activeElement!, 'End');
      seen.push(m.focusedLabel());
      key(document.activeElement!, 'Home');
      seen.push(m.focusedLabel());
      key(document.activeElement!, 'ArrowDown');
      seen.push(m.focusedLabel());
      m.cleanup();
      p.destroy();
      // With a bare caret in plain text the enabled items are Turn into, Edit Markdown, Highlight,
      // Inline code, Link and Copy ref; Clear formatting is disabled, and the three commonest marks
      // and the clipboard commands are not in this menu at all.
      return same(seen.join('|'), 'Turn into|Copy ref|Turn into|Copy ref|Turn into|Edit Markdown');
    },
  },
  {
    id: 'menus.context-keyboard.u03',
    feature: 'menus.context-keyboard',
    name: 'Right opens Turn into on Text, Escape closes the submenu onto Turn into, and a second Escape closes the menu and gives focus back',
    run: () => {
      const p = mountProse('hello world');
      p.select(3);
      p.view.contentDOM.focus();
      const before = document.activeElement;
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      // Home, not End: Turn into leads the menu now, and End reaches Copy ref at the bottom.
      key(document.activeElement!, 'Home');
      key(document.activeElement!, 'ArrowRight');
      const inSub = m.focusedLabel();
      key(document.activeElement!, 'Escape');
      const back = m.focusedLabel();
      const subOpen = document.querySelectorAll('.sheaf-ctx-submenu:not([hidden])').length;
      key(document.activeElement!, 'Escape');
      const ok = inSub === 'Text' && back === 'Turn into' && subOpen === 0 && !m.visible() && document.activeElement === before;
      const detail = `sub ${inSub} back ${back} subOpen ${subOpen} visible ${m.visible()} focusReturned ${document.activeElement === before}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.context-keyboard.u04',
    feature: 'menus.context-keyboard',
    name: 'Enter on Highlight with a word selected marks it and closes the menu',
    run: () => {
      // Two steps down from Turn into: Edit Markdown, then Highlight. Bold left this menu for the
      // selection toolbar, and Highlight is the mark the menu carries.
      const p = mountProse('hello world');
      p.select(0, 5);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      const path = [m.focusedLabel()];
      for (let i = 0; i < 2; i++) {
        key(document.activeElement!, 'ArrowDown');
        path.push(m.focusedLabel());
      }
      key(document.activeElement!, 'Enter');
      const ok = p.doc() === '==hello== world' && !m.visible();
      const detail = `${path.join('>')} doc ${j(p.doc())} visible ${m.visible()}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.context-keyboard.u05',
    feature: 'menus.context-keyboard',
    name: 'Tab closes the menu without running anything',
    run: () => {
      const p = mountProse('hello world');
      p.select(0, 5);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      const e = key(document.activeElement!, 'Tab');
      const ok = !m.visible() && p.doc() === 'hello world' && e.defaultPrevented;
      m.cleanup();
      p.destroy();
      return { ok, detail: `visible ${m.visible()}` };
    },
  },
  {
    id: 'menus.context-keyboard.u06',
    feature: 'menus.context-keyboard',
    name: 'Opening from the keyboard keeps a two-line selection, and Copy ref names both lines',
    run: () => {
      const p = mountProse('a\nb\nc');
      p.select(0, 3);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      const sel = p.view.state.selection.main;
      // End rather than a count of steps: Copy ref is the last item, and counting down the list
      // breaks every time the menu's contents change.
      key(document.activeElement!, 'End');
      const on = m.focusedLabel();
      key(document.activeElement!, 'Enter');
      const ok = sel.from === 0 && sel.to === 3 && on === 'Copy ref' && m.copied[0] === 'doc.md:1-2\n\n```\na\nb\n```\n';
      const detail = `sel ${sel.from}-${sel.to} on ${on} copied ${j(m.copied)}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.context-keyboard.u07',
    feature: 'menus.context-keyboard',
    name: 'The browser contextmenu event that follows the context-menu key does not reset focus in the open menu',
    run: () => {
      const p = mountProse('hello world');
      p.select(3);
      const m = menuFor(p);
      key(p.view.contentDOM, 'ContextMenu');
      key(document.activeElement!, 'ArrowDown');
      const moved = m.focusedLabel();
      p.view.contentDOM.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
      const after = m.focusedLabel();
      m.cleanup();
      p.destroy();
      // One step down from Turn into, which now leads the menu.
      return { ok: moved === 'Edit Markdown' && after === 'Edit Markdown', detail: `${moved} then ${after}` };
    },
  },
  {
    id: 'menus.context-keyboard.u08',
    feature: 'menus.context-keyboard',
    name: 'In a code block, Down in Turn into skips the disabled headings and lists and lands on Code block',
    run: () => {
      const p = mountProse('```\ncode\n```');
      p.select(6);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      const first = m.focusedLabel();
      // Home, not End: Turn into leads the menu now.
      key(document.activeElement!, 'Home');
      key(document.activeElement!, 'ArrowRight');
      const sub = m.focusedLabel();
      key(document.activeElement!, 'ArrowDown');
      const next = m.focusedLabel();
      m.cleanup();
      p.destroy();
      return { ok: first === 'Turn into' && sub === 'Text' && next === 'Code block', detail: `${first} ${sub} ${next}` };
    },
  },
  {
    id: 'menus.context-keyboard.u09',
    feature: 'menus.context-keyboard',
    name: 'Left in the submenu returns to Turn into and keeps the menu open',
    run: () => {
      const p = mountProse('hello');
      p.select(2);
      const m = menuFor(p);
      key(p.view.contentDOM, 'F10', { shiftKey: true });
      // Home, not End: Turn into leads the menu now.
      key(document.activeElement!, 'Home');
      key(document.activeElement!, 'ArrowRight');
      key(document.activeElement!, 'ArrowDown');
      key(document.activeElement!, 'ArrowLeft');
      const ok = m.focusedLabel() === 'Turn into' && m.visible() && document.querySelectorAll('.sheaf-ctx-submenu:not([hidden])').length === 0;
      const detail = `${m.focusedLabel()} visible ${m.visible()}`;
      m.cleanup();
      p.destroy();
      return { ok, detail };
    },
  },

  /* ==== menus.selection-toolbar ==== */
  {
    id: 'menus.selection-toolbar.u01',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Bullet list over two paragraphs leaves the blank line between them blank',
    run: () => same(toolbarTurn('one\n\ntwo', 0, 8, 'bullet'), '- one\n\n- two'),
  },
  {
    id: 'menus.selection-toolbar.u02',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Heading 2 over two paragraphs leaves the blank line between them blank',
    run: () => same(toolbarTurn('one\n\ntwo', 0, 8, 'h2'), '## one\n\n## two'),
  },
  {
    id: 'menus.selection-toolbar.u03',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Task list over two paragraphs leaves the blank line between them blank',
    run: () => same(toolbarTurn('one\n\ntwo', 0, 8, 'task'), '- [ ] one\n\n- [ ] two'),
  },
  {
    id: 'menus.selection-toolbar.u04',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Heading 1 over a selection that spans a table leaves the table rows untouched',
    run: () => {
      const table = '| a | b |\n| - | - |\n| 1 | 2 |';
      const doc = `intro\n\n${table}\n\nend`;
      const got = toolbarTurn(doc, 0, doc.length, 'h1');
      return { ok: got === '<no toolbar>' || got.includes(`\n${table}\n`), detail: j(got) };
    },
  },
  {
    id: 'menus.selection-toolbar.u05',
    feature: 'menus.selection-toolbar',
    name: 'Selecting text in YAML front matter does not offer formatting that would write Markdown into it',
    run: () => {
      const p = mountProse('---\ntitle: Notes\n---\n\nBody');
      p.select(11, 16);
      const bar = seltb(p);
      p.destroy();
      return { ok: bar === null, detail: bar ? 'toolbar shown over front matter' : '' };
    },
  },
  {
    id: 'menus.selection-toolbar.u06',
    feature: 'menus.selection-toolbar',
    name: 'Turn into shows the keyboard shortcut for Task list and Code block, as the right-click menu does',
    run: () => {
      const p = mountProse('hello world');
      p.select(0, 5);
      const keys = ['task', 'code'].map((k) => block(p, k).querySelector('.sheaf-tb-menu-key')?.textContent ?? '');
      p.destroy();
      return { ok: keys.every((k) => k !== ''), detail: `task ${j(keys[0])} code ${j(keys[1])}` };
    },
  },
  {
    id: 'menus.selection-toolbar.u07',
    feature: 'menus.selection-toolbar',
    name: 'A selection of only spaces, or one that ends inside a table, shows no toolbar',
    run: () => {
      const a = mountProse('a    b');
      a.select(1, 5);
      const spaces = seltb(a);
      a.destroy();
      const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |';
      const t = mountProse(doc);
      t.select(2, doc.length - 3);
      const intoTable = seltb(t);
      t.destroy();
      return { ok: spaces === null && intoTable === null, detail: `spaces ${!!spaces} intoTable ${!!intoTable}` };
    },
  },
  {
    id: 'menus.selection-toolbar.u08',
    feature: 'menus.selection-toolbar',
    name: 'Clear formatting on a selection with bold, a link and inline code keeps only the words',
    run: () => {
      const p = mountProse('**a** [b](u) `c` d');
      p.select(0, p.doc().length);
      seltb(p)!.querySelector<HTMLButtonElement>('[data-cmd="clear"]')!.click();
      const out = p.doc();
      p.destroy();
      return same(out, 'a b c d');
    },
  },
  {
    id: 'menus.selection-toolbar.u09',
    feature: 'menus.selection-toolbar',
    name: 'On a Heading 4 line the Turn into trigger reads Heading 4 and Heading 4 is the choice that is checked',
    run: () => {
      const p = mountProse('#### Deep');
      p.select(5, 9);
      const trigger = seltb(p)!.querySelector('[data-cmd="turn-into"]')!.textContent;
      const checked = Array.from(seltb(p)!.querySelectorAll('[data-block][aria-checked="true"]')).map((el) => el.getAttribute('data-block'));
      p.destroy();
      return { ok: trigger === 'Heading 4' && checked.join('|') === 'h4', detail: `trigger ${j(trigger)} checked ${j(checked)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.u10',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Code block on a two-item list gives the same file from the toolbar and from the right-click menu',
    run: async () => {
      const doc = '- a\n- b';
      const fromToolbar = toolbarTurn(doc, 0, doc.length, 'code');
      const fromMenu = (await withMenu(doc, 0, doc.length, (m) => turnInto(m, 'Code block'))).doc;
      return { ok: fromToolbar === fromMenu, detail: `toolbar ${j(fromToolbar)} menu ${j(fromMenu)}` };
    },
  },
  {
    id: 'menus.selection-toolbar.u11',
    feature: 'menus.selection-toolbar',
    name: 'Turn into Numbered list over two paragraphs numbers them 1 and 2',
    run: () => same(toolbarTurn('one\n\ntwo', 0, 8, 'ordered'), '1. one\n\n2. two'),
  },

  /* ==== menus.link-popover ==== */
  {
    id: 'menus.link-popover.u01',
    feature: 'menus.link-popover',
    name: 'An address with balanced parentheses is written bare, and one with an unbalanced parenthesis in angle brackets',
    run: () => {
      const a = popoverEnter('[w](u) x', 1, 'https://en.wikipedia.org/wiki/Foo_(bar)');
      const b = popoverEnter('[w](u) x', 1, 'https://a.io/x)y');
      return { ok: a.doc === '[w](https://en.wikipedia.org/wiki/Foo_(bar)) x' && b.doc === '[w](<https://a.io/x)y>) x', detail: `${j(a.doc)} ${j(b.doc)}` };
    },
  },
  {
    id: 'menus.link-popover.u02',
    feature: 'menus.link-popover',
    name: 'On an angle-bracket link the field shows the address without brackets, and Enter without a change leaves the file alone',
    run: () => {
      const doc = 'see [a](<my file.md>) now';
      const r = popoverEnter(doc, 5, 'my file.md');
      return { ok: r.shown === 'my file.md' && r.doc === doc && r.closed, detail: j(r) };
    },
  },
  {
    id: 'menus.link-popover.u03',
    feature: 'menus.link-popover',
    name: 'An address typed into the field survives the file changing above the link, and Enter writes it to that link',
    run: () => {
      const p = mountProse('x\n[a](u) z');
      p.select(3);
      const input = popover(p)!.querySelector<HTMLInputElement>('.sheaf-linkpop-url')!;
      input.value = 'https://new.io';
      input.dispatchEvent(new G.Event('input', { bubbles: true }));
      p.view.dispatch({ changes: { from: 0, insert: 'ZZ' } });
      const live = popover(p)?.querySelector<HTMLInputElement>('.sheaf-linkpop-url');
      const kept = live?.value;
      if (live) key(live, 'Enter');
      const out = p.doc();
      p.destroy();
      return { ok: kept === 'https://new.io' && out === 'ZZx\n[a](https://new.io) z', detail: `field ${j(kept)} doc ${j(out)}` };
    },
  },
  {
    id: 'menus.link-popover.u04',
    feature: 'menus.link-popover',
    name: 'Clearing the address of a link with a title writes an empty <> so the title stays a title',
    run: () => same(popoverEnter('[a](u "T") z', 1, '').doc, '[a](<> "T") z'),
  },
  {
    id: 'menus.link-popover.u05',
    feature: 'menus.link-popover',
    name: 'A caret in a reference link or an autolink shows no popover, since there is no inline address to edit',
    run: () => {
      const r = mountProse('[a][r]\n\n[r]: https://x.io');
      r.select(1);
      const ref = popover(r);
      r.destroy();
      const a = mountProse('go <https://x.io> now');
      a.select(8);
      const auto = popover(a);
      a.destroy();
      return { ok: ref === null && auto === null, detail: `ref ${!!ref} auto ${!!auto}` };
    },
  },
  {
    id: 'menus.link-popover.u06',
    feature: 'menus.link-popover',
    name: 'Remove link inside bold keeps the bold and the text',
    run: () => {
      const p = mountProse('**[a](u)** x');
      p.select(3);
      popover(p)!.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
      const out = p.doc();
      p.destroy();
      return same(out, '**a** x');
    },
  },
  {
    id: 'menus.link-popover.u07',
    feature: 'menus.link-popover',
    name: 'A pasted address with a line break in it is written on one line',
    run: () => same(popoverEnter('[a](u) z', 1, 'https://a\n.io').doc, '[a](https://a.io) z'),
  },
  {
    id: 'menus.link-popover.u08',
    feature: 'menus.link-popover',
    name: 'Copy on an angle-bracket link sends the address without brackets',
    run: () => {
      const posted: unknown[] = [];
      setClipboardHost((message) => posted.push(message));
      const p = mountProse('see [a](<my file.md>) now');
      p.select(5);
      popover(p)!.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
      p.destroy();
      setClipboardHost(null as unknown as (m: unknown) => void);
      return { ok: j(posted) === j([{ type: 'clipboardWrite', text: 'my file.md' }]), detail: j(posted) };
    },
  },
  {
    id: 'menus.link-popover.u09',
    feature: 'menus.link-popover',
    name: 'After typing in the field and pressing Escape, the popover shows the original address when it opens again',
    run: () => {
      const p = mountProse('[see](https://a.io) more');
      p.select(2);
      const input = popover(p)!.querySelector<HTMLInputElement>('.sheaf-linkpop-url')!;
      input.value = 'typo';
      input.dispatchEvent(new G.Event('input', { bubbles: true }));
      key(input, 'Escape');
      p.select(3);
      const again = popover(p)?.querySelector<HTMLInputElement>('.sheaf-linkpop-url')?.value;
      const out = p.doc();
      p.destroy();
      return { ok: again === 'https://a.io' && out === '[see](https://a.io) more', detail: `field ${j(again)} doc ${j(out)}` };
    },
  },

  /* ==== menus.slash ==== */
  {
    id: 'menus.slash.u01',
    feature: 'menus.slash',
    name: 'A slash after a space inside inline code, in front matter or in an HTML block does not open the menu',
    run: () => {
      const code = slashOpensAt('see `a  b` end', 7);
      const front = slashOpensAt('---\ntitle: \n---\n\nbody', 11);
      const html = slashOpensAt('<div>\nhi \n</div>', 9);
      return { ok: !code && !front && !html, detail: `inline code ${code} front matter ${front} html ${html}` };
    },
  },
  {
    id: 'menus.slash.u02',
    feature: 'menus.slash',
    name: 'A slash right after an opening parenthesis does not open the menu',
    run: () => ({ ok: !slashOpensAt('see (', 5), detail: '' }),
  },
  {
    id: 'menus.slash.u03',
    feature: 'menus.slash',
    name: 'Heading 2 from a slash typed at the start of a paragraph\'s second line turns only that line into a heading',
    run: () => {
      const p = mountProse('first line\nsecond line');
      p.select(11);
      type(p, '/h2');
      p.press('Enter');
      const out = p.doc();
      p.destroy();
      return same(out, 'first line\n## second line');
    },
  },
  {
    id: 'menus.slash.u04',
    feature: 'menus.slash',
    name: 'Typing a path such as /usr/local keeps the text, and Enter breaks the line as it would anywhere else',
    run: () => {
      const p = mountProse('');
      type(p, '/usr/local');
      // Nothing matches, so the menu stays open saying so, with nothing to insert.
      const menu = slashMenuOf(p.view.state);
      const out = { doc: p.doc(), open: menu !== null, items: menu ? menu.items.length : -1 };
      p.press('Enter');
      const after = p.doc();
      p.destroy();
      return { ok: out.doc === '/usr/local' && out.open && out.items === 0 && after === '/usr/local\n', detail: `${j(out)} after Enter ${j(after)}` };
    },
  },
  {
    id: 'menus.slash.u05',
    feature: 'menus.slash',
    name: 'Up from the first item wraps to Divider, and Enter replaces the slash with a divider',
    run: () => {
      const p = mountProse('');
      type(p, '/');
      p.press('ArrowUp');
      const sel = slashMenuOf(p.view.state);
      const label = sel ? sel.items[sel.selected].label : null;
      p.press('Enter');
      const out = p.doc();
      p.destroy();
      return { ok: label === 'Divider' && out === '---\n', detail: `${label} ${j(out)}` };
    },
  },
  {
    id: 'menus.slash.u06',
    feature: 'menus.slash',
    name: 'Table from a slash at the end of a sentence removes /table and puts the table after the paragraph',
    run: () => {
      const p = mountProse('Hello ');
      p.select(6);
      type(p, '/table');
      p.press('Enter');
      const out = p.doc();
      p.destroy();
      return { ok: !out.includes('/table') && out.startsWith('Hello') && /\n\| Column 1 \| Column 2 \| Column 3 \|\n/.test(out), detail: j(out) };
    },
  },
  {
    id: 'menus.slash.u07',
    feature: 'menus.slash',
    name: 'Undo right after picking Heading 2 brings back the typed /h2',
    run: () => {
      const p = mountProse('');
      type(p, '/h2');
      p.press('Enter');
      const picked = p.doc();
      undo(p.view);
      const once = p.doc();
      p.destroy();
      return { ok: picked === '## ' && once === '/h2', detail: `picked ${j(picked)} undo ${j(once)}` };
    },
  },
  {
    id: 'menus.slash.u08',
    feature: 'menus.slash',
    name: 'Tab picks the highlighted item',
    run: () => {
      const p = mountProse('');
      type(p, '/bul');
      p.press('Tab');
      const out = p.doc();
      p.destroy();
      return same(out, '- ');
    },
  },
  {
    id: 'menus.slash.u09',
    feature: 'menus.slash',
    name: 'Quote from a slash on a line that is already a quote only removes the typed /quote',
    run: () => {
      const p = mountProse('> quoted ');
      p.select(9);
      type(p, '/quote');
      p.press('Enter');
      const out = p.doc();
      p.destroy();
      return same(out, '> quoted ');
    },
  },
  {
    id: 'menus.slash.u10',
    feature: 'menus.slash',
    name: 'Moving the caret to another line closes the menu and keeps the typed slash',
    run: () => {
      const p = mountProse('top\n');
      p.select(4);
      type(p, '/he');
      p.select(1);
      const open = slashMenuOf(p.view.state) !== null;
      const out = p.doc();
      p.destroy();
      return { ok: !open && out === 'top\n/he', detail: `open ${open} ${j(out)}` };
    },
  },

  /* ==== menus.find-replace ==== */
  {
    id: 'menus.find-replace.u01',
    feature: 'menus.find-replace',
    name: 'A plain (not regular expression) search for C:\\new finds that text as written',
    run: () => {
      const { out } = findIn('path C:\\new here', (p) => {
        typeInto(field(p, 'search'), 'C:\\new');
        return countText(p);
      });
      return { ok: out === '1 match', detail: `count ${j(out)}` };
    },
  },
  {
    id: 'menus.find-replace.u02',
    feature: 'menus.find-replace',
    name: 'Replace all with C:\\notes writes the backslash, not a line break',
    run: () => {
      const { doc } = findIn('a X b', (p) => {
        typeInto(field(p, 'search'), 'X');
        typeInto(field(p, 'replace'), 'C:\\notes');
        clickNamed(p, 'replaceAll');
      });
      return same(doc, 'a C:\\notes b');
    },
  },
  {
    id: 'menus.find-replace.u03',
    feature: 'menus.find-replace',
    name: 'With regular expressions on, a group in the pattern can be used as $1 in the replacement',
    run: () => {
      const { doc } = findIn('ann@x.io and bob@x.io', (p) => {
        (findPanel(p)!.querySelector('button[name=regexp]') as HTMLButtonElement).click();
        typeInto(field(p, 'search'), '(\\w+)@x\\.io');
        typeInto(field(p, 'replace'), '$1@y.org');
        clickNamed(p, 'replaceAll');
      });
      return same(doc, 'ann@y.org and bob@y.org');
    },
  },
  {
    id: 'menus.find-replace.u04',
    feature: 'menus.find-replace',
    name: 'Replace all then one undo gives back the whole document',
    run: () => {
      const doc = 'kiwi one\n\n| kiwi | 2 |\n| --- | --- |\n\nlast kiwi';
      const { doc: got, out } = findIn(doc, (p) => {
        typeInto(field(p, 'search'), 'kiwi');
        typeInto(field(p, 'replace'), 'pear');
        clickNamed(p, 'replaceAll');
        const replaced = p.doc();
        undo(p.view);
        return replaced;
      });
      return { ok: out === doc.replace(/kiwi/g, 'pear') && got === doc, detail: `replaced ${j(out)} undone ${j(got)}` };
    },
  },
  {
    id: 'menus.find-replace.u05',
    feature: 'menus.find-replace',
    name: 'No matches reads No results, an invalid pattern reads Invalid pattern, and Replace all then changes nothing',
    run: () => {
      const doc = 'alpha beta';
      const { doc: got, out } = findIn(doc, (p) => {
        typeInto(field(p, 'search'), 'zzz');
        const none = countText(p);
        (findPanel(p)!.querySelector('button[name=regexp]') as HTMLButtonElement).click();
        typeInto(field(p, 'search'), '(');
        typeInto(field(p, 'replace'), 'x');
        const invalid = countText(p);
        clickNamed(p, 'replaceAll');
        return `${none}|${invalid}`;
      });
      return { ok: out === 'No results|Invalid pattern' && got === doc, detail: `${out} ${j(got)}` };
    },
  },
  {
    id: 'menus.find-replace.u06',
    feature: 'menus.find-replace',
    name: 'Match case and Match whole word narrow the count as they are switched on',
    run: () => {
      const { out } = findIn('Cat cat concat cat', (p) => {
        typeInto(field(p, 'search'), 'cat');
        const plain = countText(p);
        (findPanel(p)!.querySelector('button[name=case]') as HTMLButtonElement).click();
        const cased = countText(p);
        (findPanel(p)!.querySelector('button[name=word]') as HTMLButtonElement).click();
        const word = countText(p);
        return `${plain}|${cased}|${word}`;
      });
      return same(String(out), '4 matches|3 matches|2 matches');
    },
  },
  {
    id: 'menus.find-replace.u07',
    feature: 'menus.find-replace',
    name: 'Replace on a match inside a table changes only that cell and leaves the match below alone',
    run: () => {
      const doc = '| fruit | qty |\n| --- | --- |\n| kiwi | 2 |\n\nkiwi end';
      const { doc: got } = findIn(doc, (p) => {
        typeInto(field(p, 'search'), 'kiwi');
        typeInto(field(p, 'replace'), 'pear');
        clickNamed(p, 'next');
        clickNamed(p, 'replace');
      });
      return same(got, '| fruit | qty |\n| --- | --- |\n| pear | 2 |\n\nkiwi end');
    },
  },
  {
    id: 'menus.find-replace.u08',
    feature: 'menus.find-replace',
    name: 'Replace all with a replacement that contains the search text replaces each match once',
    run: () => {
      const { doc } = findIn('a b a', (p) => {
        typeInto(field(p, 'search'), 'a');
        typeInto(field(p, 'replace'), 'aa');
        clickNamed(p, 'replaceAll');
      });
      return same(doc, 'aa b aa');
    },
  },
  {
    id: 'menus.find-replace.u09',
    feature: 'menus.find-replace',
    name: 'Escape in the find field closes the panel and leaves the current match selected in the text',
    run: () => {
      const p = mountProse('one kiwi two');
      p.press('Mod-f');
      typeInto(field(p, 'search'), 'kiwi');
      key(field(p, 'search'), 'Enter');
      key(field(p, 'search'), 'Escape');
      const sel = p.view.state.selection.main;
      const ok = !searchPanelOpen(p.view.state) && p.view.state.sliceDoc(sel.from, sel.to) === 'kiwi';
      const detail = `open ${searchPanelOpen(p.view.state)} selected ${j(p.view.state.sliceDoc(sel.from, sel.to))}`;
      p.destroy();
      return { ok, detail };
    },
  },
  {
    id: 'menus.find-replace.u10',
    feature: 'menus.find-replace',
    name: 'More than a thousand matches reads 1000+ matches',
    run: () => {
      const { out } = findIn('x '.repeat(1200), (p) => {
        typeInto(field(p, 'search'), 'x');
        return countText(p);
      });
      return same(String(out), '1000+ matches');
    },
  },
  {
    id: 'menus.find-replace.u11',
    feature: 'menus.find-replace',
    name: 'Enter in the find field steps to the next match and the count reads which one',
    run: () => {
      const { out } = findIn('kiwi a kiwi b kiwi', (p) => {
        typeInto(field(p, 'search'), 'kiwi');
        key(field(p, 'search'), 'Enter');
        key(field(p, 'search'), 'Enter');
        const second = countText(p);
        key(field(p, 'search'), 'Enter', { shiftKey: true });
        return `${second}|${countText(p)}`;
      });
      return same(String(out), '2 of 3|1 of 3');
    },
  },
];
