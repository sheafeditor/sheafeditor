/*
 * The block handle: hovering a block in prose shows a `+` and a drag grip in the
 * margin to the left of the text. `+` adds an empty paragraph below and opens the
 * slash menu there; clicking the grip opens the block menu; dragging it reorders
 * the block among its siblings, with a line marking where it will land and the
 * block itself dimmed until it is dropped. A release anywhere in the editor drops
 * at the line shown; Escape, or a drag whose release the editor never sees (let go
 * outside it, then the window loses focus or the pointer comes back with no button
 * held), cancels it and nothing moves. Pressing the grip takes the keyboard focus,
 * since a key is delivered to the webview only while the focus is inside it.
 *
 * Front matter gets no handle and nothing drops above it. A rendered table (a pipe
 * table or a ```csv block drawn as a grid) gets the same handle as any other block,
 * acting on the whole table; its row and column handles stay inside the grid.
 */

import { EditorSelection, Extension, StateEffect, StateField } from '@codemirror/state';
import { BlockType, Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import {
  BlockRange,
  TURN_INTO,
  blockDropTargets,
  blockRangeAt,
  blockSelectionOf,
  canMoveRange,
  canTurnInto,
  currentTurnInto,
  deleteRange,
  duplicateRange,
  moveBlockTo,
  moveRange,
  nearestDropIndex,
  turnRangeInto,
} from './blockModel';
import { openSlashMenuAtCaret } from './slashMenu';
import { revealRange } from './revealBlock';
import { hint } from './shortcuts';

// ---- Copy ref -----------------------------------------------------------------

export interface BlockRefHost {
  /** Workspace-relative path of the document. */
  getFileName: () => string;
  /** Put text on the clipboard through the host. */
  copyToClipboard: (text: string) => void;
}

let refHost: BlockRefHost | null = null;

/** Give the block menu a way to name the document and write the clipboard; Copy ref is hidden until then. */
export function setBlockRefHost(host: BlockRefHost | null): void {
  refHost = host;
}

/** `path:line` for a one-line block; `path:start-end` and the block's source for a longer one. */
function blockRef(view: EditorView, range: BlockRange, fileName: string): string {
  if (range.startLine === range.endLine) return `${fileName}:${range.startLine}\n`;
  const text = view.state.sliceDoc(range.from, range.to);
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const bars = '`'.repeat(Math.max(3, longest + 1));
  return `${fileName}:${range.startLine}-${range.endLine}\n\n${bars}\n${text}\n${bars}\n`;
}

// ---- Menu model -----------------------------------------------------------------

export interface BlockMenuItem {
  label: string;
  run?: () => void;
  children?: BlockMenuItem[];
  disabled?: boolean;
  /** Marks the Turn into entry the block already is. */
  current?: boolean;
  keyHint?: string;
  separator?: boolean;
}

/**
 * The block menu for `range`: Turn into, Edit Markdown, Duplicate, Move up, Move
 * down, Delete and Copy ref. Empty for a block no operation may touch (front matter).
 */
export function blockMenuItems(view: EditorView, range: BlockRange): BlockMenuItem[] {
  if (!range.movable) return [];
  const focus = (fn: () => unknown) => (): void => {
    fn();
    view.focus();
  };
  const items: BlockMenuItem[] = [];
  if (canTurnInto(range.kind)) {
    const now = currentTurnInto(view.state.sliceDoc(range.from, range.to), range.kind);
    items.push({
      label: 'Turn into',
      children: TURN_INTO.map((t) => ({
        label: t.label,
        current: t.kind === now,
        run: focus(() => turnRangeInto(view, range, t.kind)),
      })),
    });
  }
  items.push(
    { label: 'Edit Markdown', keyHint: 'Mod-Alt-e', run: focus(() => revealRange(view, range)), separator: items.length > 0 },
    { label: 'Duplicate', run: focus(() => duplicateRange(view, range)) },
    { label: 'Move up', keyHint: 'Alt-ArrowUp', disabled: !canMoveRange(view.state, range, -1), run: focus(() => moveRange(view, range, -1)) },
    { label: 'Move down', keyHint: 'Alt-ArrowDown', disabled: !canMoveRange(view.state, range, 1), run: focus(() => moveRange(view, range, 1)) },
    { label: 'Delete', run: focus(() => deleteRange(view, range)) }
  );
  if (refHost) {
    const host = refHost;
    items.push({ label: 'Copy ref', separator: true, run: () => host.copyToClipboard(blockRef(view, range, host.getFileName())) });
  }
  return items;
}

/**
 * The `+` button: an empty line below the block with the slash menu open on it.
 * Below a list item the new line is a sibling item with the same marker, since an
 * empty line directly under an item would join the item.
 */
export function insertParagraphBelow(view: EditorView, range: BlockRange): void {
  const { state } = view;
  const doc = state.doc;
  const at = range.to;
  let insert: string;
  let caret: number;
  if (range.kind === 'item') {
    const first = doc.lineAt(range.from).text;
    const m = /^(\s*)([-*+]|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/.exec(first);
    const marker = m ? m[1] + (m[3] ? String(Number(m[3]) + 1) + m[4] : m[2]) + ' ' + (m[6] ? '[ ] ' : '') : '- ';
    insert = '\n' + marker;
    caret = at + insert.length;
  } else {
    const nextLine = range.endLine < doc.lines ? doc.line(range.endLine + 1) : null;
    insert = nextLine && nextLine.text.trim() !== '' ? '\n\n\n' : '\n\n';
    caret = at + 2;
  }
  view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(caret), scrollIntoView: true, userEvent: 'input.block' });
  openSlashMenuAtCaret(view);
  view.focus();
}

// ---- Drag source dimming -------------------------------------------------------

const setDragSource = StateEffect.define<{ from: number; to: number } | null>();
const dragLine = Decoration.line({ class: 'sheaf-block-dragging' });

const dragSourceField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDragSource)) return e.value;
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const value = state.field(f);
      if (!value) return Decoration.none;
      const lines = [];
      for (let n = state.doc.lineAt(value.from).number; n <= state.doc.lineAt(value.to).number; n++) lines.push(dragLine.range(state.doc.line(n).from));
      return Decoration.set(lines);
    }),
});

// ---- Handle view -----------------------------------------------------------------

const GRIP_ICON =
  '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor">' +
  '<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/>' +
  '<circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
const PLUS_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
  '<path d="M8 3v10M3 8h10"/></svg>';

interface Drag {
  range: BlockRange;
  pointerId: number;
  startY: number;
  active: boolean;
  index: number | null;
  targets?: ReturnType<typeof blockDropTargets>;
}

class BlockHandleView {
  readonly handle: HTMLElement;
  readonly add: HTMLButtonElement;
  readonly grip: HTMLButtonElement;
  readonly indicator: HTMLElement;
  menu: HTMLElement | null = null;
  submenu: HTMLElement | null = null;
  range: BlockRange | null = null;
  drag: Drag | null = null;
  hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly view: EditorView) {
    this.handle = document.createElement('div');
    this.handle.className = 'sheaf-block-handle';
    this.handle.hidden = true;
    this.add = this.button('sheaf-block-add', PLUS_ICON, 'Add a block below');
    this.grip = this.button('sheaf-block-grip', GRIP_ICON, 'Drag to move, click for block actions');
    this.grip.setAttribute('aria-haspopup', 'menu');
    this.handle.append(this.add, this.grip);
    this.indicator = document.createElement('div');
    this.indicator.className = 'sheaf-block-drop';
    this.indicator.hidden = true;
    view.scrollDOM.append(this.handle, this.indicator);

    view.scrollDOM.addEventListener('mousemove', this.onMouseMove);
    view.scrollDOM.addEventListener('mouseleave', this.onMouseLeave);
    this.handle.addEventListener('mouseenter', this.cancelHide);
    this.add.addEventListener('click', () => {
      if (this.range) insertParagraphBelow(this.view, this.range);
      this.hide();
    });
    this.grip.addEventListener('pointerdown', this.onPointerDown);
    this.grip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.openMenu(true);
      }
    });
  }

  button(className: string, icon: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.tabIndex = -1;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  }

  update(update: { docChanged: boolean; view: EditorView }): void {
    if (update.docChanged && !this.drag) this.hide();
  }

  // ---- hover ----

  onMouseMove = (event: MouseEvent): void => {
    if (this.drag || this.menu) return;
    const target = event.target as Element | null;
    if (target && this.handle.contains(target)) return;
    const view = this.view;
    const table = target?.closest?.('.sheaf-table');
    // A button held over the grid is the grid's own drag (a cell range, a row or a
    // column being moved); leave the margin as it is until that ends.
    if (table && event.buttons) return;
    let range: BlockRange | null = null;
    try {
      if (table && view.contentDOM.contains(table)) {
        // A rendered table is one block widget. Its source position comes from its
        // DOM, so any cell, header or control on the grid finds the table.
        range = blockRangeAt(view.state, view.posAtDOM(table));
      } else {
        // Text lines and block widgets (rendered tables) are blocks; a widget drawn
        // before or after a line is not.
        const line = view.lineBlockAtHeight(event.clientY - view.documentTop);
        if (line.type === BlockType.WidgetBefore || line.type === BlockType.WidgetAfter) return this.scheduleHide();
        range = blockRangeAt(view.state, line.from);
      }
    } catch {
      range = null;
    }
    if (!range || !range.movable) return this.scheduleHide();
    this.show(range);
  };

  onMouseLeave = (event: MouseEvent): void => {
    if (this.drag) return;
    if (event.relatedTarget && this.handle.contains(event.relatedTarget as Node)) return;
    this.scheduleHide();
  };

  cancelHide = (): void => {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  };

  scheduleHide(): void {
    if (this.hideTimer || this.handle.hidden || this.menu) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, 250);
  }

  hide(): void {
    this.cancelHide();
    if (this.menu) return;
    this.handle.hidden = true;
    this.range = null;
  }

  show(range: BlockRange): void {
    this.cancelHide();
    if (this.range && this.range.from === range.from && this.range.to === range.to && !this.handle.hidden) return;
    this.range = range;
    const view = this.view;
    view.requestMeasure({
      read: () => {
        const scroller = view.scrollDOM.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();
        const padLeft = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
        const line = view.lineBlockAt(range.from);
        const indent = view.coordsAtPos(range.from);
        const lineHeight = Math.min(line.height, view.defaultLineHeight * 1.6);
        // Beside a table the grip lines up with the header row, below the table's controls bar.
        const header = range.kind === 'table' ? this.tableAt(range.from)?.querySelector('tr')?.getBoundingClientRect() : undefined;
        return {
          top: header?.height
            ? header.top - scroller.top + view.scrollDOM.scrollTop + (header.height - 24) / 2
            : line.top + view.documentTop - scroller.top + view.scrollDOM.scrollTop + (Math.min(line.height, lineHeight * 2) - 24) / 2,
          left: Math.max(content.left + padLeft, indent ? indent.left : 0) - scroller.left + view.scrollDOM.scrollLeft,
        };
      },
      write: ({ top, left }) => {
        if (this.range !== range) return;
        this.handle.hidden = false;
        this.handle.style.top = `${Math.max(0, top)}px`;
        this.handle.style.left = `${left - this.handle.offsetWidth - 6}px`;
      },
    });
  }

  /** The rendered grid of the table whose source starts at `from`, if it is drawn. */
  tableAt(from: number): Element | undefined {
    return Array.from(this.view.contentDOM.querySelectorAll('.sheaf-table')).find((el) => {
      try {
        return this.view.posAtDOM(el) === from;
      } catch {
        return false;
      }
    });
  }

  // ---- drag ----

  onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.range) return;
    event.preventDefault();
    // The press is what would have moved the keyboard focus into the webview, and it
    // is prevented just above to leave the caret and its selection where they are. So
    // the grip takes the focus itself: without it a webview nobody has clicked in
    // never gets the keyboard, the Escape below is delivered to the editor around it,
    // and a drag the person asked to cancel carries on and drops on release. An
    // editor that already holds the keyboard keeps it, caret and all.
    if (!this.view.hasFocus) this.grip.focus({ preventScroll: true });
    this.closeMenu();
    this.drag = { range: this.range, pointerId: event.pointerId, startY: event.clientY, active: false, index: null };
    try {
      this.grip.setPointerCapture?.(event.pointerId);
    } catch {
      // No active pointer with that id; the window listeners below still see the drag.
    }
    // A release is not always delivered to the grip: without capture it lands on
    // whatever is under the pointer, and a release outside the webview arrives
    // nowhere. So the drag listens on the window, in the capture phase so nothing
    // inside can swallow the release, and ends on every sign that the button is up.
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('mousemove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('mouseup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.cancelDrag, true);
    window.addEventListener('blur', this.cancelDrag);
    this.grip.addEventListener('lostpointercapture', this.cancelDrag);
    window.addEventListener('keydown', this.onDragKey, true);
  };

  onPointerMove = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const id = (event as PointerEvent).pointerId;
    if (id !== undefined && drag.pointerId !== undefined && id !== drag.pointerId) return;
    // A move with no button held means the button went up where the drag could not
    // see it, outside the editor. Nothing moves for a release nobody saw.
    if (event.buttons === 0) return this.cancelDrag();
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 4) return;
      drag.active = true;
      const span = blockSelectionOf(this.view.state);
      const source = span && drag.range.from >= span.from && drag.range.to <= span.to ? span : drag.range;
      this.view.dispatch({ effects: setDragSource.of(source) });
      this.view.dom.classList.add('sheaf-block-drag-active');
    }
    this.placeIndicator(event.clientY);
  };

  /** Draw the drop line at the allowed gap nearest the pointer. */
  placeIndicator(clientY: number): void {
    const drag = this.drag!;
    const view = this.view;
    // The document does not change during a drag, so the slots are worked out once.
    if (drag.targets === undefined) drag.targets = blockDropTargets(view.state, drag.range);
    const targets = drag.targets;
    if (!targets) return;
    const s = targets.siblings;
    const scroller = view.scrollDOM.getBoundingClientRect();
    const ys = targets.indices.map((index) => {
      let y: number;
      if (index >= s.length) y = view.lineBlockAt(s[s.length - 1].to).bottom;
      else if (index === 0) y = view.lineBlockAt(s[0].from).top;
      else y = (view.lineBlockAt(s[index - 1].to).bottom + view.lineBlockAt(s[index].from).top) / 2;
      return { index, y: y + view.documentTop };
    });
    drag.index = nearestDropIndex(ys, clientY);
    const at = ys.find((t) => t.index === drag.index);
    // Over the block's own place a release changes nothing, so no line is drawn:
    // the dimmed block already marks where it will stay.
    if (!at || targets.home.includes(at.index)) {
      this.indicator.hidden = true;
      return;
    }
    const content = view.contentDOM.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
    const anchorBlock = s[Math.min(at.index, s.length - 1)];
    const indent = view.coordsAtPos(anchorBlock.from);
    const left = Math.max(content.left + padLeft, indent ? indent.left : 0);
    this.indicator.hidden = false;
    this.indicator.style.top = `${at.y - scroller.top + view.scrollDOM.scrollTop - 1}px`;
    this.indicator.style.left = `${left - scroller.left + view.scrollDOM.scrollLeft}px`;
    this.indicator.style.width = `${Math.max(40, content.right - padLeft - left)}px`;
  }

  /** A release the webview saw, on the grip or anywhere else in it: drop at the line shown. */
  onPointerUp = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const id = (event as PointerEvent).pointerId;
    if (id !== undefined && drag.pointerId !== undefined && id !== drag.pointerId) return;
    const wasDrag = drag.active;
    const index = drag.index;
    this.endDrag();
    if (!wasDrag) {
      this.openMenu(false);
      return;
    }
    const spec = index === null ? null : moveBlockTo(this.view.state, drag.range, index);
    if (spec) this.view.dispatch(spec);
    this.view.focus();
  };

  onDragKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag();
  };

  /** End the drag without moving anything: Escape, a cancelled pointer, or a release the webview never saw. */
  cancelDrag = (): void => {
    this.endDrag();
  };

  endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    // Cleared first, so a lostpointercapture fired while releasing finds no drag.
    this.drag = null;
    this.grip.removeEventListener('lostpointercapture', this.cancelDrag);
    try {
      this.grip.releasePointerCapture?.(drag.pointerId);
    } catch {
      // The pointer is already gone, and its capture with it.
    }
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('mousemove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('mouseup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.cancelDrag, true);
    window.removeEventListener('blur', this.cancelDrag);
    window.removeEventListener('keydown', this.onDragKey, true);
    this.indicator.hidden = true;
    this.view.dom.classList.remove('sheaf-block-drag-active');
    if (drag.active && this.view.state.field(dragSourceField, false)) this.view.dispatch({ effects: setDragSource.of(null) });
  }

  // ---- menu ----

  openMenu(focusFirst: boolean): void {
    const range = this.range;
    if (!range) return;
    const items = blockMenuItems(this.view, range);
    if (!items.length) return;
    this.closeMenu();
    const menu = this.renderMenu(items, 'sheaf-block-menu');
    this.menu = menu;
    const rect = this.grip.getBoundingClientRect();
    this.place(menu, rect.left, rect.bottom + 4);
    if (focusFirst) this.menuItems(menu)[0]?.focus();
    document.addEventListener('mousedown', this.onDocDown, true);
    document.addEventListener('keydown', this.onMenuKey, true);
    window.addEventListener('blur', this.closeMenuQuietly);
  }

  renderMenu(items: BlockMenuItem[], className: string): HTMLElement {
    const menu = document.createElement('div');
    menu.className = className;
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'sheaf-block-menu-sep';
        menu.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheaf-block-menu-item' + (item.current ? ' is-current' : '');
      btn.setAttribute('role', item.current !== undefined ? 'menuitemradio' : 'menuitem');
      if (item.current !== undefined) btn.setAttribute('aria-checked', String(item.current));
      btn.tabIndex = -1;
      btn.disabled = !!item.disabled;
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      const side = document.createElement('span');
      side.className = 'sheaf-block-menu-key';
      side.textContent = item.children ? '›' : item.keyHint ? hint(item.keyHint) : '';
      btn.appendChild(side);
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      if (item.children) {
        btn.setAttribute('aria-haspopup', 'menu');
        const children = item.children;
        const open = (focus: boolean): void => this.openSubmenu(btn, children, focus);
        btn.addEventListener('mouseenter', () => open(false));
        btn.addEventListener('click', () => open(true));
        (btn as HTMLButtonElement & { openSub?: (focus: boolean) => void }).openSub = open;
      } else {
        btn.addEventListener('mouseenter', () => {
          if (menu === this.menu) this.closeSubmenu();
        });
        btn.addEventListener('click', () => {
          this.closeMenu();
          item.run?.();
        });
      }
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    return menu;
  }

  openSubmenu(anchor: HTMLElement, items: BlockMenuItem[], focus: boolean): void {
    if (this.submenu) this.closeSubmenu();
    const sub = this.renderMenu(items, 'sheaf-block-menu sheaf-block-submenu');
    this.submenu = sub;
    const rect = anchor.getBoundingClientRect();
    this.place(sub, rect.right + 2, rect.top - 4);
    if (focus) (this.menuItems(sub).find((b) => b.classList.contains('is-current')) ?? this.menuItems(sub)[0])?.focus();
  }

  closeSubmenu(): void {
    this.submenu?.remove();
    this.submenu = null;
  }

  place(menu: HTMLElement, x: number, y: number): void {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  }

  menuItems(menu: HTMLElement): HTMLButtonElement[] {
    return Array.from(menu.querySelectorAll<HTMLButtonElement>('.sheaf-block-menu-item:not(:disabled)'));
  }

  onDocDown = (event: MouseEvent): void => {
    const t = event.target as Node;
    if (this.menu?.contains(t) || this.submenu?.contains(t) || this.grip.contains(t)) return;
    this.closeMenu();
  };

  closeMenuQuietly = (): void => this.closeMenu();

  onMenuKey = (event: KeyboardEvent): void => {
    const inSub = !!this.submenu && this.submenu.contains(document.activeElement);
    const menu = inSub ? this.submenu! : this.menu;
    if (!menu) return;
    const list = this.menuItems(menu);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const claim = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const key = event.key;
    if (key === 'Escape' || (key === 'ArrowLeft' && inSub)) {
      claim();
      if (inSub) {
        const anchor = this.menuItems(this.menu!).find((b) => b.getAttribute('aria-haspopup') === 'menu');
        this.closeSubmenu();
        anchor?.focus();
      } else {
        this.closeMenu();
        this.view.focus();
      }
    } else if (key === 'Tab') {
      claim();
      this.closeMenu();
      this.view.focus();
    } else if (key === 'ArrowRight' && i >= 0 && list[i].getAttribute('aria-haspopup') === 'menu') {
      claim();
      (list[i] as HTMLButtonElement & { openSub?: (focus: boolean) => void }).openSub?.(true);
    } else if ((key === 'Enter' || key === ' ') && i >= 0) {
      claim();
      list[i].click();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) && list.length) {
      claim();
      const n = list.length;
      const next = key === 'Home' ? 0 : key === 'End' ? n - 1 : key === 'ArrowDown' ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n;
      list[next].focus();
    }
  };

  closeMenu(): void {
    if (!this.menu) return;
    this.closeSubmenu();
    this.menu.remove();
    this.menu = null;
    document.removeEventListener('mousedown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onMenuKey, true);
    window.removeEventListener('blur', this.closeMenuQuietly);
    this.hide();
  }

  destroy(): void {
    this.endDrag();
    this.closeMenu();
    this.view.scrollDOM.removeEventListener('mousemove', this.onMouseMove);
    this.view.scrollDOM.removeEventListener('mouseleave', this.onMouseLeave);
    this.handle.remove();
    this.indicator.remove();
  }
}

export const blockHandle: Extension = [dragSourceField, ViewPlugin.fromClass(BlockHandleView)];
