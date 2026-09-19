/*
 * Right-click context menu.
 *
 * Renders a small popup at the cursor with common operations. The headline
 * action is "Copy ref" — it puts `path:line` (a line range when text spans
 * several lines) on the clipboard, followed by the selected text, so the result
 * pastes cleanly into an AI chat as a code reference. Clipboard reads/writes are
 * routed through the host (see markdownEditorProvider) rather than the webview's
 * restricted `navigator.clipboard`, and the remaining items reuse the same
 * editing commands as the toolbar and keyboard shortcuts.
 *
 * On prose the menu depends on what was clicked: a link adds open, copy address
 * and remove; a fenced code block adds Copy code and switches formatting off; a
 * task line adds Mark done or Mark not done. Turn into is a submenu.
 */

import { EditorState, StateEffect, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { toggleWrap, insertLink, clearFormatting, turnInto, blockKindOf, BlockKind } from './toolbar';
import { hint } from './shortcuts';
import { tableRowSourceAt, tableRowRefAt, tableActionsAt } from './tables';
import { formatStateAt } from './formatState';
import { readClipboardText } from './hostClipboard';
import { inFrontMatter } from './floatingState';
import { blockRangeAt } from './blockModel';
import { revealBlockAt } from './revealBlock';
import { linkAddress, linkAddressAt, openLink } from './linkTarget';

export interface ContextMenuDeps {
  getView: () => EditorView | undefined;
  /** Workspace-relative path of the document, for building refs. */
  getFileName: () => string;
  /** Send text to the host clipboard. */
  copyToClipboard: (text: string) => void;
  /** Read the clipboard's text; the host clipboard when omitted. */
  readClipboard?: () => Promise<string>;
  /** Open a link's target; a link click the host intercepts when omitted. */
  openLink?: (url: string) => void;
}

type MenuItem =
  | { kind: 'sep' }
  | {
      kind: 'item';
      label: string;
      keyHint?: string;
      run: () => void;
      disabled?: boolean;
      /** Set for items that show an on or off state. */
      checked?: boolean;
      /** A checked item that is one choice among several (Turn into). */
      radio?: boolean;
    }
  | { kind: 'submenu'; label: string; items: MenuItem[]; disabled?: boolean };

/** Build the `path:line` (or `path:start-end`) reference, plus any selected text. */
function buildRef(view: EditorView, fileName: string): string {
  const { doc } = view.state;
  const sel = view.state.selection.main;
  const startLine = doc.lineAt(sel.from).number;
  // A selection that ends at the start of a line (a triple-clicked line) covers
  // no character of that line, so the range stops at the line before it.
  const endAt = doc.lineAt(sel.to);
  const endLine = !sel.empty && sel.to === endAt.from ? Math.max(startLine, endAt.number - 1) : endAt.number;
  const range = !sel.empty && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
  let ref = `${fileName}:${range}\n`;
  if (!sel.empty) {
    ref += `\n${fence(doc.sliceString(sel.from, sel.to))}\n`;
  }
  return ref;
}

/** A `path:line` (or `path:start-end`) reference to a table row's source. */
function tableRowRef(fileName: string, ref: { start: number; end: number; text: string }): string {
  if (ref.start === ref.end) return `${fileName}:${ref.start}\n`;
  // Several rows: the line range, then those rows' source, as a prose selection gets.
  return `${fileName}:${ref.start}-${ref.end}\n\n${fence(ref.text)}\n`;
}

/**
 * Wrap `text` in a Markdown fenced code block. The fence is grown longer than
 * the longest backtick run inside the text so content containing ``` stays
 * intact, and a trailing newline is trimmed so the closing fence sits flush.
 */
function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const bars = '`'.repeat(Math.max(3, longest + 1));
  return `${bars}\n${text.replace(/\n$/, '')}\n${bars}`;
}

/* ---- What was clicked ---------------------------------------------------- */

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** The innermost-first chain of syntax nodes that contain `pos`. */
function nodesAt(state: EditorState, pos: number): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) out.push(node);
  return out;
}

interface LinkTarget {
  url: string | null;
  /** The marker ranges that removing the link deletes, keeping its text; null when it has none. */
  cuts: { from: number; to: number }[] | null;
}

/** The link at `pos`: a `[text](url)` link, an `<autolink>`, or a bare URL. */
function linkAt(state: EditorState, pos: number): LinkTarget | null {
  for (const node of nodesAt(state, pos)) {
    if (!(node.from <= pos && pos < node.to)) continue;
    if (node.name === 'Link') {
      const url = node.getChild('URL');
      const marks = node.getChildren('LinkMark');
      // A destination holding a space is written `<my notes.md>`; the brackets are syntax, not address.
      const raw = url ? state.sliceDoc(url.from, url.to) : null;
      return {
        // A reference link has no destination of its own; its definition supplies one.
        url: raw ? (raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw) : linkAddressAt(state, pos),
        cuts: marks.length >= 2 ? [{ from: marks[0].from, to: marks[0].to }, { from: marks[1].from, to: node.to }] : null,
      };
    }
    if (node.name === 'Autolink') {
      const url = node.getChild('URL');
      return { url: url ? state.sliceDoc(url.from, url.to) : null, cuts: null };
    }
    if (node.name === 'Image') return null;
    if (node.name === 'URL' && !/^(Link|Autolink|Image)$/.test(node.parent?.name ?? '')) {
      return { url: state.sliceDoc(node.from, node.to), cuts: null };
    }
  }
  return null;
}

/** The code inside the code block at `pos`, without its fences. */
function codeAt(state: EditorState, pos: number): string | null {
  for (const node of nodesAt(state, pos)) {
    if (node.name === 'FencedCode') {
      const text = node.getChild('CodeText');
      return text ? state.sliceDoc(text.from, text.to) : '';
    }
    if (node.name === 'CodeBlock') {
      return state
        .sliceDoc(node.from, node.to)
        .split('\n')
        .map((line) => line.replace(/^ {1,4}|^\t/, ''))
        .join('\n');
    }
  }
  return null;
}

/** The task checkbox on the line at `pos`: where its mark character sits and whether it is ticked. */
function taskAt(state: EditorState, pos: number): { at: number; done: boolean } | null {
  const line = state.doc.lineAt(pos);
  const m = /^(\s*(?:>\s?)*\s*[-*+]\s+\[)([ xX])\]/.exec(line.text);
  return m ? { at: line.from + m[1].length, done: m[2] !== ' ' } : null;
}

/**
 * Paste `text` the way Cmd+V does, by handing the editor a paste event that
 * carries it. The editor's own paste handling then runs unchanged: a range
 * copied from a spreadsheet becomes a table, and any other text goes in at the
 * selection. Focus moves to the editor first, since a pasted table takes focus
 * into its grid.
 */
function pasteText(view: EditorView | undefined, text: string): void {
  if (!view) return;
  view.focus();
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const data = { getData: (type: string) => (type === 'text/plain' ? text : ''), types: ['text/plain'], files: [], items: [] };
  Object.defineProperty(event, 'clipboardData', { value: data });
  view.contentDOM.dispatchEvent(event);
  // Nothing took the event, so there is no paste handling to share: insert the text as is.
  if (!event.defaultPrevented) {
    view.dispatch({ ...view.state.replaceSelection(text.replace(/\r\n?/g, '\n')), userEvent: 'input.paste', scrollIntoView: true });
  }
}

/** Screen coordinates of a document position, or null where there is no layout to measure. */
function coordsAt(view: EditorView, pos: number): { left: number; bottom: number } | null {
  try {
    return view.coordsAtPos(pos);
  } catch {
    return null;
  }
}

/**
 * Wire a context menu to `root`. The menu is created once and its items are
 * rebuilt on each open, since enablement depends on the current selection.
 */
export function mountContextMenu(root: HTMLElement, deps: ContextMenuDeps): void {
  const menu = document.createElement('div');
  menu.className = 'sheaf-ctx-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  const sub = document.createElement('div');
  sub.className = 'sheaf-ctx-menu sheaf-ctx-submenu';
  sub.hidden = true;
  sub.setAttribute('role', 'menu');
  document.body.appendChild(sub);
  let subTrigger: HTMLButtonElement | null = null;

  // Where focus was when the menu opened, to hand it back when the menu closes.
  let returnFocus: HTMLElement | null = null;

  // The items are worked out from the document as it was when the menu opened:
  // positions to rewrite, an address, a block of code. So the menu closes the
  // moment the editor it opened on changes its document, whether from typing or
  // from an edit arriving from disk, and never offers an action on text that has
  // moved.
  let openOn: EditorView | null = null;
  const watched = new WeakSet<EditorView>();
  function watch(view: EditorView): void {
    if (watched.has(view)) return;
    watched.add(view);
    const listener = EditorView.updateListener.of((update) => {
      if (update.docChanged && update.view === openOn) close(true);
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(listener) });
  }
  /** Whether `view` still shows the document `doc` a menu was built from. */
  const unchanged = (view: EditorView, doc: Text): boolean => deps.getView() === view && view.state.doc === doc;
  const itemsOf = (list: HTMLElement): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item:not(:disabled)'));

  const closeSub = (focusTrigger: boolean): void => {
    if (sub.hidden) return;
    sub.hidden = true;
    subTrigger?.setAttribute('aria-expanded', 'false');
    if (focusTrigger) subTrigger?.focus();
    subTrigger = null;
  };

  const close = (restoreFocus = false): void => {
    if (menu.hidden) return;
    closeSub(false);
    menu.hidden = true;
    openOn = null;
    const back = returnFocus;
    returnFocus = null;
    if (restoreFocus && back && back.isConnected && !menu.contains(back)) back.focus();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', closeQuietly);
    window.removeEventListener('resize', closeQuietly);
    document.removeEventListener('scroll', onScroll, true);
  };
  // Closing because the window lost focus or resized leaves focus alone.
  const closeQuietly = (): void => close(false);
  // The menu is placed where the text was when it opened, so scrolling the
  // document closes it rather than leaving it beside text that has moved away.
  // Scroll events do not bubble; listening while capturing sees any scroller.
  // Scrolling inside the menu or its submenu keeps it open.
  const onScroll = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || sub.contains(target))) return;
    close(false);
  };
  const onDocDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && !sub.contains(e.target as Node)) close();
  };

  /** Show a submenu beside its trigger, flipped to the left when it would leave the window. */
  function openSub(trigger: HTMLButtonElement, items: MenuItem[], focusFirst: boolean): void {
    if (subTrigger === trigger && !sub.hidden) {
      if (focusFirst) itemsOf(sub)[0]?.focus();
      return;
    }
    closeSub(false);
    render(items, sub);
    subTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    sub.style.left = '0px';
    sub.style.top = '0px';
    sub.hidden = false;
    const at = trigger.getBoundingClientRect();
    const parent = menu.getBoundingClientRect();
    const own = sub.getBoundingClientRect();
    const right = parent.right - 2;
    const left = right + own.width > window.innerWidth - 4 ? parent.left - own.width + 2 : right;
    const top = Math.min(at.top - 5, window.innerHeight - own.height - 4);
    sub.style.left = `${Math.max(4, left)}px`;
    sub.style.top = `${Math.max(4, top)}px`;
    if (focusFirst) itemsOf(sub)[0]?.focus();
  }

  // The menu keyboard: arrows, Home and End move between items (the first arrow
  // press moves focus into a menu opened by mouse), Enter or Space activates the
  // focused item, Right opens a submenu and Left or Escape leaves it, and Escape
  // or Tab closes the menu and returns focus.
  const onKeyDown = (e: KeyboardEvent): void => {
    const inSub = !sub.hidden && sub.contains(document.activeElement);
    const list = itemsOf(inSub ? sub : menu);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const focused = i >= 0 ? list[i] : null;
    const claim = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape' && inSub) {
      claim();
      closeSub(true);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      claim();
      close(true);
    } else if (e.key === 'ArrowLeft' && inSub) {
      claim();
      closeSub(true);
    } else if ((e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') && focused && subItems.has(focused)) {
      claim();
      openSub(focused, subItems.get(focused)!, true);
    } else if ((e.key === 'Enter' || e.key === ' ') && focused) {
      claim();
      focused.click();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && list.length) {
      claim();
      const n = list.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowDown' ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n;
      list[next].focus();
    }
  };

  function build(view: EditorView, pos: number): MenuItem[] {
    const { state } = view;
    const cmd =
      (fn: (v: EditorView) => void) =>
      (): void => {
        // An item from a menu whose document has since changed would act on the wrong text.
        if (unchanged(view, state.doc)) fn(view);
        close(true);
      };
    const selected = state.selection.ranges.filter((r) => !r.empty);
    const selectedText = (): string => selected.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
    const fs = formatStateAt(state, pos);
    const link = fs.codeBlock ? null : linkAt(state, pos);
    const code = fs.codeBlock ? codeAt(state, pos) : null;
    const task = fs.codeBlock ? null : taskAt(state, pos);

    const items: MenuItem[] = [
      {
        kind: 'item',
        label: 'Cut',
        keyHint: 'Mod-x',
        disabled: !selected.length,
        run: cmd((v) => {
          deps.copyToClipboard(selectedText());
          v.dispatch({ ...v.state.replaceSelection(''), userEvent: 'delete.cut', scrollIntoView: true });
        }),
      },
      { kind: 'item', label: 'Copy', keyHint: 'Mod-c', disabled: !selected.length, run: cmd(() => deps.copyToClipboard(selectedText())) },
      {
        kind: 'item',
        label: 'Paste',
        keyHint: 'Mod-v',
        run: cmd(() => {
          void (deps.readClipboard ?? readClipboardText)().then((text) => {
            const v = deps.getView();
            if (text) pasteText(v, text);
          });
        }),
      },
      { kind: 'item', label: 'Copy ref', run: cmd((v) => deps.copyToClipboard(buildRef(v, deps.getFileName()))) },
    ];

    const context: MenuItem[] = [];
    if (link?.url) {
      const url = link.url;
      context.push(
        { kind: 'item', label: 'Open link', run: cmd(() => (deps.openLink ?? openLink)(url)) },
        // The address as written, not the href: a copied address is pasted
        // somewhere else, where Markdown's escapes mean nothing, and where a
        // `mailto:` this document never held would be in the way.
        { kind: 'item', label: 'Copy link address', run: cmd(() => deps.copyToClipboard(linkAddress(url))) }
      );
    }
    if (link?.cuts) {
      const cuts = link.cuts;
      context.push({ kind: 'item', label: 'Remove link', run: cmd((v) => v.dispatch({ changes: cuts, userEvent: 'delete' })) });
    }
    if (code != null) context.push({ kind: 'item', label: 'Copy code', run: cmd(() => deps.copyToClipboard(code)) });
    if (task) {
      const { at, done } = task;
      context.push({
        kind: 'item',
        label: done ? 'Mark not done' : 'Mark done',
        run: cmd((v) => v.dispatch({ changes: { from: at, to: at + 1, insert: done ? ' ' : 'x' }, userEvent: 'input' })),
      });
    }
    if (context.length) items.push({ kind: 'sep' }, ...context);

    // Inside code, Markdown markers would be typed into the code as literal text.
    // Front matter is YAML, and a marker or block prefix written there breaks it.
    const frontMatter = state.selection.ranges.some((r) => inFrontMatter(state, r.from) || inFrontMatter(state, r.to)) || inFrontMatter(state, pos);
    const noInline = fs.codeBlock || frontMatter;
    const anyMark = fs.bold || fs.italic || fs.strike || fs.code || fs.highlight || fs.link;
    const mark = (label: string, keyHint: string, marker: string, on: boolean): MenuItem => ({
      kind: 'item',
      label,
      keyHint,
      checked: on,
      disabled: noInline,
      run: cmd((v) => toggleWrap(v, marker)),
    });
    items.push(
      { kind: 'sep' },
      mark('Bold', 'Mod-b', '**', fs.bold),
      mark('Italic', 'Mod-i', '*', fs.italic),
      mark('Strikethrough', 'Mod-Shift-x', '~~', fs.strike),
      mark('Highlight', 'Mod-Shift-h', '==', fs.highlight),
      mark('Inline code', 'Mod-e', '`', fs.code),
      ...(link ? [] : [{ kind: 'item', label: 'Link', keyHint: 'Mod-k', disabled: noInline, run: cmd(insertLink) } as MenuItem]),
      { kind: 'item', label: 'Clear formatting', disabled: noInline || (!selected.length && !anyMark), run: cmd(clearFormatting) }
    );

    const current = blockKindOf(fs);
    const into = (label: string, kind: BlockKind, keyHint?: string): MenuItem => ({
      kind: 'item',
      label,
      keyHint,
      checked: current === kind,
      radio: true,
      // From a code block the choices are to keep it or to turn it back into text.
      disabled: frontMatter || (fs.codeBlock && kind !== 'text' && kind !== 'code'),
      run: cmd((v) => turnInto(v, kind)),
    });
    items.push(
      { kind: 'sep' },
      {
        kind: 'item',
        label: 'Edit Markdown',
        keyHint: 'Mod-Alt-e',
        disabled: !blockRangeAt(state, pos),
        run: cmd((v) => void revealBlockAt(v, pos)),
      },
      {
        kind: 'submenu',
        label: 'Turn into',
        disabled: frontMatter,
        items: [
          into('Text', 'text', 'Mod-Alt-0'),
          into('Heading 1', 'h1', 'Mod-Alt-1'),
          into('Heading 2', 'h2', 'Mod-Alt-2'),
          into('Heading 3', 'h3', 'Mod-Alt-3'),
          into('Bullet list', 'bullet', 'Mod-Shift-8'),
          into('Numbered list', 'ordered', 'Mod-Shift-7'),
          into('Task list', 'task', 'Mod-Alt-4'),
          into('Quote', 'quote', 'Mod-Shift-9'),
          into('Code block', 'code', 'Mod-Alt-8'),
        ],
      }
    );
    return items;
  }

  /** Submenu triggers in the rendered main menu, with the items each opens. */
  const subItems = new Map<HTMLButtonElement, MenuItem[]>();

  function render(items: MenuItem[], into: HTMLElement = menu): void {
    into.replaceChildren();
    if (into === menu) subItems.clear();
    into.classList.toggle('has-checks', items.some((i) => i.kind === 'item' && i.checked !== undefined));
    for (const item of items) {
      if (item.kind === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'sheaf-ctx-sep';
        sep.setAttribute('role', 'separator');
        into.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheaf-ctx-item';
      btn.setAttribute('role', 'menuitem');
      btn.tabIndex = -1;
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      // Keep the editor selection intact until the command runs.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      if (item.kind === 'submenu') {
        btn.classList.add('sheaf-ctx-has-sub');
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        const arrow = document.createElement('span');
        arrow.className = 'sheaf-ctx-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        btn.appendChild(arrow);
        btn.disabled = !!item.disabled;
        // A disabled submenu stays in the menu, greyed out, and never opens.
        if (!item.disabled) {
          subItems.set(btn, item.items);
          btn.addEventListener('click', () => openSub(btn, item.items, false));
          btn.addEventListener('mouseenter', () => openSub(btn, item.items, false));
        }
        into.appendChild(btn);
        continue;
      }
      if (item.keyHint) {
        const keys = document.createElement('span');
        keys.className = 'sheaf-ctx-key';
        keys.textContent = hint(item.keyHint);
        btn.appendChild(keys);
      }
      if (item.checked !== undefined) {
        btn.setAttribute('role', item.radio ? 'menuitemradio' : 'menuitemcheckbox');
        btn.setAttribute('aria-checked', String(item.checked));
        btn.classList.toggle('is-checked', item.checked);
      }
      btn.disabled = !!item.disabled;
      btn.addEventListener('click', item.run);
      // Pointing at another item of the main menu puts its submenu away.
      if (into === menu) btn.addEventListener('mouseenter', () => closeSub(false));
      into.appendChild(btn);
    }
  }

  /** Position the menu at (x, y), clamped inside the viewport. */
  function place(x: number, y: number): void {
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
  }

  function open(view: EditorView, x: number, y: number, focusFirst: boolean): void {
    closeSub(false);
    watch(view);
    openOn = view;
    place(x, y);
    if (focusFirst) itemsOf(menu)[0]?.focus();
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', closeQuietly);
    window.addEventListener('resize', closeQuietly);
    document.addEventListener('scroll', onScroll, true);
  }

  root.addEventListener('contextmenu', (event) => {
    const view = deps.getView();
    if (!view) return;
    // Inside a text field (a table cell being edited) the platform's own cut, copy
    // and paste menu is the right one.
    if ((event.target as Element | null)?.closest?.('input, textarea')) return;
    event.preventDefault();
    // A menu opened from the keyboard (the context-menu key, Shift+F10, or the
    // grid's own shortcut) takes focus, and one with no pointer position opens at
    // the caret instead of the corner of the window. A macOS Ctrl-click is a mouse.
    // Touch and pen report button 0 as well, but the person is pointing, not typing.
    const pointerType = (event as PointerEvent).pointerType;
    const fromKeyboard = event.button !== 2 && !event.ctrlKey && pointerType !== 'touch' && pointerType !== 'pen';
    // The context-menu key also fires the browser's own event, after the one that
    // already opened the menu and moved focus into it. It is not a new request.
    if (fromKeyboard && !menu.hidden && (menu.contains(document.activeElement) || sub.contains(document.activeElement))) return;
    // Note where focus is now: rendering replaces the items, including a focused one.
    if (menu.hidden) returnFocus = document.activeElement as HTMLElement | null;
    let x = event.clientX;
    let y = event.clientY;
    if (fromKeyboard && x === 0 && y === 0) {
      const caret = coordsAt(view, view.state.selection.main.head);
      const anchor = (document.activeElement?.querySelector?.('.is-focus') ?? null)?.getBoundingClientRect();
      x = anchor?.left ?? caret?.left ?? 0;
      y = anchor?.bottom ?? caret?.bottom ?? 0;
    }

    // A table is one block widget, so the position under the pointer is the
    // table's edge rather than the row that was clicked. Offer a ref to that row
    // and the table's own row and column actions, and no text formatting: those
    // commands would type at the table's edge and break its source.
    const row = tableRowSourceAt(event.target);
    if (row) {
      // Taken now, before an action changes the table; it names the rows as they will be saved.
      const ref = tableRowRefAt(event.target) ?? {
        start: view.state.doc.lineAt(row.from).number,
        end: view.state.doc.lineAt(row.to).number,
        text: view.state.sliceDoc(row.from, row.to),
      };
      const actions = tableActionsAt(event.target) ?? [];
      const doc = view.state.doc;
      render([
        {
          kind: 'item',
          label: 'Copy ref',
          run: () => {
            if (unchanged(view, doc)) deps.copyToClipboard(tableRowRef(deps.getFileName(), ref));
            close(true);
          },
        },
        ...(actions.length ? [{ kind: 'sep' } as MenuItem] : []),
        ...actions.flatMap((a): MenuItem[] => [
          ...(a.separator ? [{ kind: 'sep' } as MenuItem] : []),
          {
            kind: 'item',
            label: a.label,
            run: () => {
              if (unchanged(view, doc)) a.run();
              close(true);
            },
          },
        ]),
      ]);
      open(view, x, y, fromKeyboard);
      return;
    }

    // Anchor the click: if it lands outside the current selection, move the
    // caret there so the ref/format targets what the user actually clicked.
    let pos = view.state.selection.main.head;
    if (!fromKeyboard) {
      let clicked: number | null = null;
      try {
        // Not precise: a click past the end of a line or in a blank line still names that line.
        clicked = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      } catch {
        clicked = null;
      }
      if (clicked != null) {
        const sel = view.state.selection.main;
        const insideSelection = !sel.empty && clicked >= sel.from && clicked <= sel.to;
        if (!insideSelection) view.dispatch({ selection: { anchor: clicked } });
        pos = clicked;
      }
    }

    render(build(view, pos));
    open(view, x, y, fromKeyboard);
  });

  // Shift+F10 and the context-menu key open the menu at the caret; not every
  // platform turns them into a contextmenu event. A table grid opens its own menu
  // on the active cell, so keys from inside a table are left to it.
  root.addEventListener('keydown', (event) => {
    if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
    if ((event.target as Element | null)?.closest?.('.sheaf-table')) return;
    const view = deps.getView();
    if (!view) return;
    event.preventDefault();
    const at = coordsAt(view, view.state.selection.main.head);
    view.contentDOM.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at?.left ?? 1, clientY: at?.bottom ?? 1 })
    );
  });
}
