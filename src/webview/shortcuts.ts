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
import { EditorState, Text } from '@codemirror/state';
import { indentMore, indentLess, undo, redo } from '@codemirror/commands';
import { indentUnit, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { formatStateAt } from './formatState';
import { isFenceLine } from './fenceLines';
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
  openLinkAtCaret,
  removeLinkAtSelection,
} from './toolbar';

const isMac = navigator.platform.toLowerCase().includes('mac');

/** A CodeMirror key spec (e.g. `Mod-Shift-x`) as the keys it names (`['⌘', '⇧', 'X']`). */
export function hintParts(key: string): string[] {
  // Split on the dashes between parts, so the minus key itself (`Mod-Alt--`) stays a part.
  return key.split(/-(?=.)/).map((part) => {
    switch (part) {
      case 'Mod':
        return isMac ? '⌘' : 'Ctrl';
      case 'Shift':
        return isMac ? '⇧' : 'Shift';
      case 'Alt':
        return isMac ? '⌥' : 'Alt';
      case 'Escape':
        return 'Esc';
      /*
       * The arrows, which are the one group of key names that are identifiers rather than words.
       *
       * A hint read `⌥ArrowUp` in the block menu while every other hint read like `⌘⇧X`, because
       * anything longer than one character fell through unchanged and `ArrowUp` is what the browser
       * calls the key rather than what a person does. The arrows get symbols on both platforms, not
       * only on a Mac: `↑` is what a Windows or Linux menu shows too, and "Arrow Up" is nobody's
       * name for it.
       *
       * `Enter`, `Tab`, `Backspace`, `Delete` and `Home` stay as they are on purpose. Those are the
       * words people use for those keys, so passing them through is already right, and `Escape`
       * above shows the house preference: it is spelled `Esc` rather than `⎋`, because a symbol
       * nobody recognises is worse than a word. `PageUp` and `PageDown` are camel-case like the
       * arrows and are the next candidates, and they are left alone here because choosing between
       * `⇞` and `Page Up` is a decision this issue did not ask for.
       */
      case 'ArrowUp':
        return '↑';
      case 'ArrowDown':
        return '↓';
      case 'ArrowLeft':
        return '←';
      case 'ArrowRight':
        return '→';
      default:
        return part.length === 1 ? part.toUpperCase() : part;
    }
  });
}

/** Render a CodeMirror key spec (e.g. `Mod-Shift-x`) as a display string (`⌘⇧X`). */
export function hint(key: string): string {
  return hintParts(key).join(isMac ? '' : '+');
}

/**
 * The same key spec as `aria-keyshortcuts` wants it: `Mod-Shift-x` becomes `Meta+Shift+X` on a Mac
 * and `Control+Shift+X` elsewhere.
 *
 * It lives beside `hintParts` on purpose, because the two are the same fact in two spellings and a
 * key that gained a symbol in one and not the other would read one way and announce another. The
 * split between them is the whole point: the visible hint is free to say `⌥↑`, which is what somebody
 * looking at the menu wants, while assistive technology is given the canonical form it can announce
 * in its own words, at the point in the announcement its user expects.
 *
 * Only the modifiers are mapped. Everything else is passed through as the browser's own key name,
 * which is what this attribute is specified in terms of: `ArrowUp` rather than `↑`.
 */
export function keyShortcuts(key: string): string {
  return key
    .split(/-(?=.)/)
    .map((part) => {
      switch (part) {
        case 'Mod':
          return isMac ? 'Meta' : 'Control';
        case 'Ctrl':
          return 'Control';
        case 'Alt':
          return 'Alt';
        case 'Shift':
          return 'Shift';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join('+');
}

/**
 * Draw a shortcut into `el`, one element per key.
 *
 * `⌘`, `⌥` and `⇧` are not in every font a menu might be drawn in, so a browser
 * falls back for those glyphs alone and sets them on the fallback's own metrics:
 * beside a letter drawn from the asked-for font they sat visibly higher, and a
 * hint read as three characters at three heights. Each key is its own box here,
 * and `.sheaf-keys` lines the boxes up along their bottoms, so they stay level
 * whatever font each glyph comes from. The element's text is unchanged, so
 * anything reading `textContent` still sees `⌘⇧X`.
 */
export function drawKeyHint(el: HTMLElement, key: string): void {
  el.classList.add('sheaf-keys');
  const parts = hintParts(key);
  const nodes: Node[] = [];
  parts.forEach((part, i) => {
    if (i && !isMac) nodes.push(document.createTextNode('+'));
    const one = document.createElement('span');
    one.className = 'sheaf-key';
    one.textContent = part;
    nodes.push(one);
  });
  el.replaceChildren(...nodes);
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
  /*
   * A fence line takes no indent, which is the fourth position of a class already fixed for a
   * paragraph, a heading and a list's first item.
   *
   * `codeBlock` is true on the fence lines as well as the code between them, so this used to hand them
   * to `indentMore`. Four spaces is one more than a fence may carry, so the opening fence stopped
   * being one, the closing fence then opened a block of its own, and everything after it became code
   * text. One keystroke, and nothing on screen looked wrong at the time.
   */
  if (state.selection.ranges.some((r) => isFenceLine(state, r.head))) return true;
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

/** A numbered item's leading whitespace and quote markers, its number, and the delimiter after it. */
const ORDERED_ITEM = /^((?:[ \t]*>[ \t]?)*[ \t]*)(\d{1,9})([.)])(?=[ \t])/;

/** A line that belongs to a list block: an item, or a line indented under one. */
const LIST_BLOCK_LINE = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:[-*+][ \t]|\d{1,9}[.)][ \t]|[ \t])/;

/**
 * Renumber the ordered lists an indent change moves an item between, so each nesting
 * level counts on its own.
 *
 * Nesting an item changes which list it belongs to, and nothing on that path said so.
 * The number comes from CodeMirror's list continuation on Enter, which counts the list
 * the caret is in, and the indent commands move the marker and leave the digits alone.
 * So `1, 2`, Tab, two items, Shift-Tab, one more read `1, 2, 3, 4, 5` down the page with
 * the middle two indented, where a reader expects `1, 2`, then `1, 2` again, then `3`.
 *
 * The outermost level keeps the number it opens at, because a list may open at `5.` and
 * that is something a person chose. A deeper level starts at 1, and that is the one
 * decision here rather than arithmetic: a nested list deliberately opened at another
 * number is renumbered when an indent changes in its block, and nothing in the text
 * tells that apart from the case this exists to fix.
 *
 * Only numbers that actually change are written, so an indent that renumbers nothing
 * leaves every byte alone. A number whose digit count changes moves the item's content
 * column and its continuation lines are not shifted to follow, which shows on a list
 * crossing ten items; `blockModel.ts` solves that for a moved item and does not export
 * the helper.
 */
function orderedRenumberChanges(doc: Text, lines: number[]): Array<{ from: number; to: number; insert: string }> {
  const inBlock = (n: number): boolean => {
    const text = doc.line(n).text;
    return text.trim() !== '' && LIST_BLOCK_LINE.test(text);
  };
  let first = Math.min(...lines);
  let last = Math.max(...lines);
  while (first > 1 && inBlock(first - 1)) first--;
  while (last < doc.lines && inBlock(last + 1)) last++;

  /** One counter per nesting level, outermost first, each holding the indent it sits at. */
  const levels: Array<{ indent: number; next: number }> = [];
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    const m = ORDERED_ITEM.exec(line.text);
    if (!m) continue;
    const indent = m[1].length;
    while (levels.length && levels[levels.length - 1].indent > indent) levels.pop();
    const top = levels[levels.length - 1];
    let number: number;
    if (!top || top.indent < indent) {
      // A level this walk has not seen. The outermost keeps what the author wrote.
      number = levels.length === 0 ? Number(m[2]) : 1;
      levels.push({ indent, next: number + 1 });
    } else {
      number = top.next;
      top.next = number + 1;
    }
    if (String(number) !== m[2]) {
      const from = line.from + m[1].length;
      changes.push({ from, to: from + m[2].length, insert: String(number) });
    }
  }
  return changes;
}

/**
 * The renumbering, added to the indent's own transaction rather than dispatched after it.
 *
 * It has to be the same transaction, because an indent is one thing a person did and
 * `prose.indent` R6 says one undo takes it back. Renumbering in a second dispatch made
 * two history entries, so the first undo put the old numbers back and left the item
 * nested, which is a document nobody asked for. `sequential` applies these changes to
 * the document the indent produced.
 *
 * A filter rather than a wrapper around each command, so every path that indents is
 * covered by construction: Tab through `indentListItem`, Shift-Tab through CodeMirror's
 * `indentLess`, and anything either of them grows into later.
 */
export const orderedListRenumbering = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!tr.isUserEvent('input.indent') && !tr.isUserEvent('delete.dedent')) return tr;
  const lines = new Set<number>();
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    lines.add(tr.newDoc.lineAt(fromB).number);
    lines.add(tr.newDoc.lineAt(toB).number);
  });
  if (!lines.size) return tr;
  const changes = orderedRenumberChanges(tr.newDoc, [...lines]);
  return changes.length ? [tr, { changes, sequential: true }] : tr;
});

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
      { key: 'Mod-k', label: 'Insert or edit link', run: insertLink },
      { key: 'Mod-Shift-k', label: 'Remove link', run: removeLinkAtSelection },
      { key: 'Mod-Enter', label: 'Open link', run: openLinkAtCaret },
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
      if (item.display === undefined && item.key) drawKeyHint(keys, item.key);
      else keys.textContent = item.display ?? 'Enter';
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
