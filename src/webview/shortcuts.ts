/*
 * Keyboard-shortcut registry, keymap, and cheat-sheet overlay.
 *
 * A single declarative list (`GROUPS`) is the source of truth for three things:
 *   1. the CodeMirror keymap (`buildEditingKeymap`) — every binding sets
 *      preventDefault so the key never escapes the editor to the browser / VS Code
 *      (Tab, in particular, would otherwise move focus out of the editor);
 *   2. the `⌘K`-style hints shown in toolbar button tooltips (`hint`);
 *   3. the "Keyboard shortcuts" overlay (`createShortcutsOverlay`).
 *
 * Editing commands live in toolbar.ts; Tab is `indentListItem` below and
 * Shift-Tab is indentLess from @codemirror/commands. Two entries (Continue
 * list, Keyboard shortcuts) are bound elsewhere and appear in the overlay for
 * reference only.
 */

import { EditorView, KeyBinding } from '@codemirror/view';
import { indentMore, indentLess, undo, redo } from '@codemirror/commands';
import { indentUnit, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { formatStateAt } from './formatState';
import {
  toggleWrap,
  turnInto,
  toggleBullet,
  toggleOrdered,
  toggleQuote,
  toggleTask,
  toggleCodeBlock,
  insertLink,
  insertHardBreak,
} from './toolbar';

const isMac = navigator.platform.toLowerCase().includes('mac');

/** Render a CodeMirror key spec (e.g. `Mod-Shift-x`) as a display string (`⌘⇧X`). */
export function hint(key: string): string {
  // Split on the dashes between parts, so the minus key itself (`Mod-Alt--`) stays a part.
  return key
    .split(/-(?=.)/)
    .map((part) => {
      switch (part) {
        case 'Mod':
          return isMac ? '⌘' : 'Ctrl';
        case 'Shift':
          return isMac ? '⇧' : 'Shift';
        case 'Alt':
          return isMac ? '⌥' : 'Alt';
        case 'Escape':
          return 'Esc';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(isMac ? '' : '+');
}

/**
 * Tab: nest each selected list item under the item before it, by adding one
 * indent unit just before its marker (after any quote markers). A line with no
 * earlier item to nest under, such as a paragraph, a heading, a first item or a
 * continuation line, is left alone: four leading spaces there would turn prose
 * into an indented code block in the file. Inside a code block Tab indents the
 * line, as it always has. The key is consumed either way, so focus stays here.
 */
export function indentListItem(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.some((r) => formatStateAt(state, r.head).codeBlock)) return indentMore(view);
  const tree = syntaxTree(state);
  const at = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
      const line = state.doc.line(n);
      const marks: SyntaxNode[] = [];
      tree.iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
          if (node.name === 'ListMark' && node.from >= line.from) marks.push(node.node);
        },
      });
      // The innermost item that starts on this line.
      const mark = marks[marks.length - 1];
      if (!mark || mark.parent?.name !== 'ListItem') continue;
      // In a quote, the `>` of each line sits between the items, so look past it.
      let sibling = mark.parent.prevSibling;
      while (sibling && sibling.name !== 'ListItem') sibling = sibling.prevSibling;
      if (sibling) at.add(mark.from);
    }
  }
  if (at.size) {
    const unit = state.facet(indentUnit);
    view.dispatch({ changes: [...at].map((from) => ({ from, insert: unit })), userEvent: 'input.indent' });
  }
  return true;
}

/*
 * The two sharing keys, bound in the manifest and shown in four places: this
 * overlay, the right-click menu, the block menu and the selection toolbar. They
 * live here so the chord is written once and every surface says the same thing.
 * Copy ref is the plain one of the pair, since it is the one used all day.
 */
export const COPY_REF_KEY = 'Mod-Shift-c';
export const SEND_REF_KEY = 'Mod-Shift-Alt-t';

interface Shortcut {
  /** CodeMirror key spec, or null for reference-only rows bound elsewhere. */
  key: string | null;
  label: string;
  /** The command to run; omitted for reference-only rows. */
  run?: (view: EditorView) => boolean;
  /**
   * What to print in the key column instead of a chord. A command with no binding of
   * its own still belongs in this list, and where it is reached is the useful thing to
   * say about it.
   */
  display?: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

/** Every editing shortcut, grouped for display. Order here drives the overlay. */
const GROUPS: Group[] = [
  {
    title: 'Formatting',
    items: [
      { key: 'Mod-b', label: 'Bold', run: (v) => toggleWrap(v, '**') },
      { key: 'Mod-i', label: 'Italic', run: (v) => toggleWrap(v, '*') },
      { key: 'Mod-Shift-x', label: 'Strikethrough', run: (v) => toggleWrap(v, '~~') },
      { key: 'Mod-Shift-h', label: 'Highlight', run: (v) => toggleWrap(v, '==') },
      { key: 'Mod-e', label: 'Inline code', run: (v) => toggleWrap(v, '`') },
      { key: 'Mod-k', label: 'Insert link', run: insertLink },
    ],
  },
  {
    title: 'Blocks',
    items: [
      // The same command as Text style in the toolbar and menus, so a list item or quote loses its marker too.
      { key: 'Mod-Alt-1', label: 'Heading 1', run: (v) => turnInto(v, 'h1') },
      { key: 'Mod-Alt-2', label: 'Heading 2', run: (v) => turnInto(v, 'h2') },
      { key: 'Mod-Alt-3', label: 'Heading 3', run: (v) => turnInto(v, 'h3') },
      { key: 'Mod-Alt-0', label: 'Text', run: (v) => turnInto(v, 'text') },
      { key: 'Mod-Shift-8', label: 'Bullet list', run: toggleBullet },
      { key: 'Mod-Shift-7', label: 'Numbered list', run: toggleOrdered },
      { key: 'Mod-Shift-9', label: 'Blockquote', run: toggleQuote },
      // Task list and code block continue the Mod-Alt-number family (4 and 8, as block editors number them).
      { key: 'Mod-Alt-4', label: 'Task list', run: toggleTask },
      { key: 'Mod-Alt-8', label: 'Code block', run: toggleCodeBlock },
    ],
  },
  {
    title: 'Editing',
    items: [
      // Bound here, ahead of historyKeymap, so the keys stop at the editor: VS Code's webview host
      // runs its own document undo for any Ctrl or Cmd with Z or Y that reaches the window.
      { key: 'Mod-z', label: 'Undo', run: undo },
      { key: 'Mod-Shift-z', label: 'Redo', run: redo },
      { key: 'Tab', label: 'Indent list item', run: indentListItem },
      { key: 'Shift-Tab', label: 'Outdent line / list item', run: indentLess },
      { key: null, label: 'Continue list / quote on new line' },
      { key: 'Shift-Enter', label: 'Line break within a paragraph', run: insertHardBreak },
      { key: 'Mod-/', label: 'Show keyboard shortcuts' },
    ],
  },
  {
    title: 'View',
    items: [
      // No chord: every free-looking one already belongs to VS Code. The command is
      // in the Command Palette, and anyone who wants a key can bind it there.
      { key: null, label: 'Toggle table of contents', display: 'Sheaf: Toggle Table of Contents' },
    ],
  },
  {
    title: 'Sharing',
    items: [
      // Bound in the manifest, not here: these keys belong to the window, and the
      // commands that answer them run in the extension host, outside this webview.
      { key: COPY_REF_KEY, label: 'Copy a reference to the selection' },
      { key: SEND_REF_KEY, label: 'Send the selected lines to the terminal' },
    ],
  },
];

/** Shortcut groups other modules add for the overlay; each module binds its own keys. */
const extraGroups: Group[] = [];

/** List a group of shortcuts in the overlay. Call at module load, before the overlay is created. */
export function registerShortcutGroup(group: { title: string; items: { key: string | null; label: string; display?: string }[] }): void {
  extraGroups.push(group);
}

/**
 * Build the editing keymap from `GROUPS`. Every binding sets preventDefault so
 * the keystroke is consumed by the editor and never triggers a browser default
 * (notably Tab focus-navigation), and stopPropagation so it never reaches VS
 * Code: the webview host listens for keydown on the window and forwards every
 * key it sees to the workbench, handled or not, so Mod-b would otherwise also
 * toggle the side bar and take the focus. `onShowShortcuts` wires Mod-/.
 */
export function buildEditingKeymap(onShowShortcuts: () => void): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  for (const group of GROUPS) {
    for (const item of group.items) {
      if (item.key && item.run) {
        bindings.push({ key: item.key, run: item.run, preventDefault: true, stopPropagation: true });
      }
    }
  }
  // Redo's other common spelling, for the same reason as Mod-z above. Not listed in the overlay.
  bindings.push({ key: 'Mod-y', run: redo, preventDefault: true, stopPropagation: true });
  bindings.push({
    key: 'Mod-/',
    run: () => {
      onShowShortcuts();
      return true;
    },
    preventDefault: true,
    stopPropagation: true,
  });
  return bindings;
}

/** A dismissable overlay listing every shortcut, toggled from the keymap/toolbar. */
export interface ShortcutsOverlay {
  toggle: () => void;
  isOpen: () => boolean;
}

/**
 * Create (hidden) the keyboard-shortcuts overlay and append it to `parent`.
 * Clicking the backdrop, pressing Esc, or re-toggling closes it.
 */
export function createShortcutsOverlay(parent: HTMLElement): ShortcutsOverlay {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheaf-sc-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'sheaf-sc-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Keyboard shortcuts');
  // The panel takes focus while it is open, so it has to be focusable itself:
  // it holds no field, and its only other focus stop is the close button.
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'sheaf-sc-header';
  const title = document.createElement('h2');
  title.className = 'sheaf-sc-title';
  title.textContent = 'Keyboard shortcuts';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sheaf-sc-close';
  close.textContent = '✕';
  close.title = 'Close (Esc)';
  header.append(title, close);
  panel.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'sheaf-sc-grid';
  for (const group of [...GROUPS, ...extraGroups]) {
    const col = document.createElement('div');
    col.className = 'sheaf-sc-group';
    const h = document.createElement('h3');
    h.className = 'sheaf-sc-group-title';
    h.textContent = group.title;
    col.appendChild(h);
    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'sheaf-sc-row';
      const name = document.createElement('span');
      name.className = 'sheaf-sc-label';
      name.textContent = item.label;
      const keys = document.createElement('span');
      keys.className = 'sheaf-sc-keys';
      keys.textContent = item.display ?? (item.key ? hint(item.key) : 'Enter');
      row.append(name, keys);
      col.appendChild(row);
    }
    grid.appendChild(col);
  }
  panel.appendChild(grid);
  backdrop.appendChild(panel);
  parent.appendChild(backdrop);

  // Where focus was when the overlay opened, to put it back on the way out.
  let returnFocus: HTMLElement | null = null;

  /**
   * Opening moves focus into the panel. The toolbar button deliberately leaves the
   * caret in the text, so without this the overlay covers a document that is still
   * taking every key someone types, and the edit lands out of sight and is saved.
   */
  const open = () => {
    returnFocus = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    panel.focus();
  };
  const hide = () => {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    const previous = returnFocus;
    returnFocus = null;
    previous?.focus?.();
  };
  const toggle = () => (backdrop.hidden ? open() : hide());

  // Dismiss on backdrop click (but not clicks inside the panel), Esc, or ✕.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) hide();
  });
  close.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (backdrop.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return;
    }
    // The shortcut that opened this has to close it from here, because opening
    // moved focus into the panel and the editor's keymap is only offered keys the
    // editor still has. Without this the one key someone would reach for is the
    // one key that does nothing, which reads as the overlay being stuck.
    if (e.key === '/' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      // The webview host forwards every key it sees to the workbench, handled or
      // not, so a key answered here still has to be stopped from reaching it.
      e.stopPropagation();
      hide();
    }
  });

  return { toggle, isOpen: () => !backdrop.hidden };
}
