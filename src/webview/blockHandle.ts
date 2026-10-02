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
import { BlockType, Decoration, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
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
  dropAnchor,
  dropIndexNearPos,
  duplicateRange,
  moveBlockTo,
  moveRange,
  nearestDropIndex,
  turnRangeInto,
} from './blockModel';
import { fence, blockRefHost } from './refs';
import { openSlashMenuAtCaret } from './slashMenu';
import { revealRange } from './revealBlock';
import { drawKeyHint, keyShortcuts } from './shortcuts';

// ---- Copy ref -----------------------------------------------------------------

/** `path:line` for a one-line block; `path:start-end` and the block's source for a longer one. */
function blockRef(view: EditorView, range: BlockRange, fileName: string): string {
  // One line or many, the ref carries the block's source, so a paste says what is
  // there as well as where it is. A block with nothing in it has nothing to quote.
  const lines = range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
  const text = view.state.sliceDoc(range.from, range.to);
  return text === '' ? `${fileName}:${lines}\n` : `${fileName}:${lines}\n\n${fence(text)}\n`;
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
        separator: t.separator,
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
  // No key hint: the sharing key copies the selection, and this item copies the
  // whole block, so printing the chord here would name a key that does something else.
  const host = blockRefHost();
  if (host) {
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
    /*
     * Carried through a change rather than dropped by it.
     *
     * A write from outside lands while the button is still down, and dropping the value
     * took the dimming off the block being carried while the drop line stayed where it
     * was. The page then said two things at once: nothing is being carried, and it is
     * going here. Mapping keeps the block marked as the one in hand, wherever the change
     * moved it to.
     *
     * A block the change deleted maps to an empty range, and then there is nothing to
     * carry: the drag ends, which the view plugin does visibly.
     */
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      return to > from ? { from, to } : null;
    }
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

/** The grip's own height, which is what it has to be lifted by to clear a row. */
const GRIP_HEIGHT = 24;

/*
 * The four things that scroll sideways under the grip, and what to ask each of them.
 *
 * A block whose content can slide into the grip's margin needs the grip lifted clear of it, and
 * until now only a pipe table got that. The other three were written out of it by the selectors
 * rather than by a decision: a board has no `tr`, no `th` and no `td`, so both reads came back
 * undefined, the lift never engaged, and the grip drew on top of a card. Measured on a board
 * scrolled fully right, the grip's rectangle at 199..240 over a card at 220..448.
 *
 * `kind` is the cheap guard that keeps a paragraph from searching the DOM on every hover, and it
 * has to admit `code`: a view, a board and a `csv` block are all fenced blocks, so a view's board
 * was unreachable twice over. A `code` block that is really code matches no wrapper and falls
 * through to the ordinary line placement, as it did before.
 */
const SCROLLS_SIDEWAYS: ReadonlySet<string> = new Set(['table', 'code']);
/**
 * The scroller inside a grid or a board, whichever wrapper drew it.
 *
 * Three, and the third was missed on the first pass. A pipe table shown as a board puts its cards
 * in `.sheaf-table-board`, and that element is the scroller: `overflow-x: auto`, measured at 1990
 * against a client width of 1200. It is neither of the two grids, so the listener was attached to
 * nothing and a table-backed board scrolling under a still grip would not have moved it, even with
 * the placement above corrected. Found by measuring the second board site rather than by reading,
 * and the probe that first said "nothing scrolls" had the same blind spot as the code.
 */
const SCROLLER = '.sheaf-table-grid, .sheaf-view-grid, .sheaf-table-board';
/**
 * The strip the grip lines up with: a table's header row, a board's column heads.
 *
 * Both are the block's own chrome rather than its content, which is what makes the space above
 * them the one place with nothing in it at any scroll position.
 */
const HEADER_STRIP = 'tr, .sheaf-board-col-head';
/**
 * The leftmost thing that can arrive under the grip, which is what says content has scrolled into
 * its column. One rect answers it, because if the first one has passed the grip's right edge then
 * something is in the way; asking every cell would be a read per cell on every hover, and the
 * corpus has a 200-column table in it.
 */
const LEFTMOST_CONTENT = 'th, td, .sheaf-board-col-head, .sheaf-board-card';

/**
 * The first match that is actually drawn, rather than the first match.
 *
 * A pipe table shown as a board keeps its `<table>` in the DOM and hides it, putting the cards in a
 * `.sheaf-table-board` beside it. So `querySelector` on either selector above finds the hidden
 * `tr` first, whose rectangle is all zeros, and a zero height reads as "this block has no header
 * row" and takes the ordinary line placement. The lift would have gone on never engaging for the
 * one of the two board sites that is backed by a table, which is the half of this fault that
 * looks fixed from the other half.
 */
function firstDrawn(root: Element, selector: string): DOMRect | undefined {
  for (const el of root.querySelectorAll(selector)) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) return b;
  }
  return undefined;
}

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
  /** Where the pointer was last seen, so the drop line can be drawn again after a change. */
  lastY?: number;
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
  /** Takes the scroll listener off whichever table the grip is currently shown beside. */
  stopFollowing: (() => void) | null = null;

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

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    if (!this.drag) {
      this.hide();
      return;
    }
    /*
     * A change arriving mid-drag: a write from outside, which is the pairing Sheaf exists
     * for, or the person's own agent saving the file.
     *
     * The slots were worked out once when the drag began, on the reasoning that the
     * document does not change during one. It does. Left alone, the release acted on a
     * range that had moved and moved nothing at all, with no message and nothing to undo,
     * while the drop line went on promising a landing.
     *
     * So the block in hand is found again in the document as it is now, from where the
     * change carried its start, and the slots are worked out afresh. Where the block is
     * gone, or is no longer one that may be moved, the drag ends and takes its line with
     * it: better a gesture that visibly stops than a release that quietly does nothing.
     */
    const drag = this.drag;
    // Where the drop was aimed, as a position rather than a slot number: a change can add
    // or remove siblings, so the same number means a different gap afterwards.
    const aimed = drag.targets && drag.index !== null ? dropAnchor(drag.targets, drag.index) : null;
    const at = update.changes.mapPos(drag.range.from, 1);
    const now = blockRangeAt(update.state, at);
    if (!now || !now.movable) {
      this.cancelDrag();
      return;
    }
    drag.range = now;
    // Worked out again from the new document, not mapped: a change can add or remove the
    // gaps themselves, and a stale slot list is what put the line in the wrong place.
    drag.targets = undefined;
    drag.index = null;
    if (!drag.active) return;
    const aim = aimed === null ? null : update.changes.mapPos(aimed, 1);
    // The line is drawn from measurements, and those are not to be taken during an update.
    requestAnimationFrame(() => {
      if (this.drag !== drag || !drag.active) return;
      if (aim !== null) this.placeIndicator(drag.lastY ?? 0, aim);
      else if (drag.lastY !== undefined) this.placeIndicator(drag.lastY);
    });
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
    this.unfollowTableScroll();
    this.handle.hidden = true;
    this.range = null;
  }

  show(range: BlockRange): void {
    this.cancelHide();
    if (this.range && this.range.from === range.from && this.range.to === range.to && !this.handle.hidden) return;
    this.range = range;
    this.followTableScroll(range);
    this.placeHandle(range);
  }

  /**
   * Put the grip back where it belongs when a table scrolls sideways under it.
   *
   * `show` does nothing when it is called again for the range it already holds, which is what
   * keeps a mousemove from measuring on every pixel. The cost is that a table scrolling under
   * a grip that is already up never moved it: it stayed on the line it was placed on, and the
   * columns slid past beneath. One listener on the grid, for as long as the grip belongs to
   * that table, is what makes the placement follow.
   */
  followTableScroll(range: BlockRange): void {
    this.unfollowTableScroll();
    if (!SCROLLS_SIDEWAYS.has(range.kind)) return;
    const grid = this.gridAt(range.from)?.querySelector(SCROLLER);
    if (!grid) return;
    const onScroll = (): void => {
      if (this.range === range && !this.handle.hidden) this.placeHandle(range);
    };
    grid.addEventListener('scroll', onScroll, { passive: true });
    this.stopFollowing = () => grid.removeEventListener('scroll', onScroll);
  }

  /** Stop following whichever table the grip was last shown beside. */
  unfollowTableScroll(): void {
    this.stopFollowing?.();
    this.stopFollowing = null;
  }

  /** Measure and write the grip's place for `range`. Separate from `show` so a scroll can redo it. */
  placeHandle(range: BlockRange): void {
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
        const table = SCROLLS_SIDEWAYS.has(range.kind) ? this.gridAt(range.from) : undefined;
        const header = table ? firstDrawn(table, HEADER_STRIP) : undefined;
        /*
         * Unless that row has been scrolled under the grip, and then it goes up a line.
         *
         * A wide table's frame spans the pane with its left inset as padding inside the
         * scroller, so at rest the first column sits on the text's left edge and the grip has
         * the margin to itself. Scroll the table sideways and its content slides into that
         * margin by design, which is the whole of what makes the pane usable. The grip was
         * then drawn squarely on top of whichever column header had arrived under it: with
         * the table forty columns along it read as a stray glyph inside the data.
         *
         * The strip above the header row is the one place in the frame with no cells at any
         * scroll position, and it is where the table's own controls bar sits, which is to say
         * it is already understood as the table's chrome rather than its content. The grip
         * keeps its column, stays hoverable and stays pressable; only its line changes, and
         * only while the content is actually under it.
         *
         * Asked of the first cell's edge rather than of every cell, because this runs on every
         * hover and the corpus has a 200-column table in it. One rect answers it: if the first
         * cell has passed the grip's right edge, content is in the grip's column.
         */
        const firstCell = table ? firstDrawn(table, LEFTMOST_CONTENT) : undefined;
        const gripRight = Math.max(content.left + padLeft, indent ? indent.left : 0) - 6;
        const scrolledUnder = !!firstCell && firstCell.width > 0 && firstCell.left < gripRight;
        /*
         * And whether there is anywhere to put it. Every row of a scrolled table has a cell in
         * the grip's column, so the strip above the header is the only clear place: with the
         * table's first row against the top of the pane there is none, and lifting anyway puts
         * the grip behind the formatting toolbar, where a press reaches a toolbar button.
         *
         * Nothing at all is the honest answer there, and it is one of the two this was allowed:
         * beside the table, or not drawn while the table is scrolled. It comes back on the next
         * scroll, in either direction, because the scroll listener re-places it.
         */
        const noRoom = scrolledUnder && !!header && header.top - GRIP_HEIGHT - 2 < scroller.top;
        // Beside anything else it sits on the block's first line, centred on that line's
        // own height, so a long paragraph's handle points at where it starts, and a
        // heading's centres on the heading's larger type.
        const first = indent && indent.bottom > indent.top ? indent : undefined;
        return {
          top: header?.height
            ? /*
               * Centred on the header row, or clear above it when the content has scrolled
               * under the grip.
               *
               * Clear above means the grip's whole height plus a gap, not a fraction of the
               * bar's: the bar is `position: absolute` and lifted by `translateY(-100%)`, so it
               * is outside the frame's own box and the space above the header is the previous
               * line's rather than the table's. Clamping the lift to the table's box moved the
               * grip nine pixels and left it still over the header row, which measured as a
               * fix and looked like the bug.
               */
              header.top - (scrolledUnder ? GRIP_HEIGHT + 2 : (24 - header.height) / 2) - scroller.top + view.scrollDOM.scrollTop
            : first
              ? first.top - scroller.top + view.scrollDOM.scrollTop + (first.bottom - first.top - 24) / 2
              : line.top + view.documentTop - scroller.top + view.scrollDOM.scrollTop + (Math.min(line.height, lineHeight * 2) - 24) / 2,
          left: Math.max(content.left + padLeft, indent ? indent.left : 0) - scroller.left + view.scrollDOM.scrollLeft,
          noRoom,
        };
      },
      write: ({ top, left, noRoom }) => {
        if (this.range !== range) return;
        this.handle.hidden = noRoom;
        if (noRoom) return;
        this.handle.style.top = `${Math.max(0, top)}px`;
        this.handle.style.left = `${left - this.handle.offsetWidth - 6}px`;
      },
    });
  }

  /**
   * The rendered grid or board whose source starts at `from`, if it is drawn.
   *
   * Both wrappers, because four things draw a scrolling grid and the grip has to clear the content
   * of all of them: a pipe table and a `csv` block are `.sheaf-table`, a view and a board are
   * `.sheaf-view`. Asking only for `.sheaf-table` found the first two and left a view's board
   * drawing the grip on top of a card.
   */
  gridAt(from: number): Element | undefined {
    return Array.from(this.view.contentDOM.querySelectorAll('.sheaf-table, .sheaf-view')).find((el) => {
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
    drag.lastY = event.clientY;
    this.placeIndicator(event.clientY);
  };

  /**
   * Draw the drop line at the allowed gap nearest the pointer, or, when `aimAt` is given,
   * at the gap nearest that document position.
   *
   * `aimAt` is for a change that landed mid-drag. The person chose a place in the
   * document, not a coordinate on the screen, so when the text moves under a still
   * pointer the line goes with the text. Their next move re-aims it from the pointer
   * again, as any drag does.
   */
  placeIndicator(clientY: number, aimAt?: number): void {
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
    drag.index = aimAt === undefined ? nearestDropIndex(ys, clientY) : dropIndexNearPos(targets, aimAt);
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
      // Drawn for the eye, announced through `aria-keyshortcuts`. The submenu chevron is hidden for
      // the same reason and has nothing to announce. See the note in `contextmenu.ts`.
      side.setAttribute('aria-hidden', 'true');
      if (item.children) side.textContent = '›';
      else if (item.keyHint) {
        drawKeyHint(side, item.keyHint);
        btn.setAttribute('aria-keyshortcuts', keyShortcuts(item.keyHint));
      }
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
