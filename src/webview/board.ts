/*
 * A board: a table's rows drawn as cards, in one column per value of a grouping
 * column. Two things draw one. A view block with `layout: board` (viewBlock.ts)
 * draws the rows its query keeps, and a pipe table shown as a board (tables.ts)
 * draws all of its rows. Both hand this module their rows and a way to write the
 * grouping cell, and nothing here writes anything itself.
 *
 * Moving a card to another column, by dragging it or with Alt+Left and Alt+Right,
 * asks the owner to write that one cell of the row. The owner then draws the board
 * again from what the table holds.
 */

/** A board as drawn: its grouping column, each board column's value, and a card's fields, title first. */
export interface BoardState {
  group: number;
  values: string[];
  fields: number[];
}

/** What a board is drawn from. */
export interface BoardRows {
  /** Each column's name, as a card labels its fields. */
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  /** The columns a card shows, in order. The first one that is not the grouping column is its title. */
  columns: readonly number[];
  group: number;
  /** The rows to draw, by index into `rows`, in the order a column stacks them. */
  order: readonly number[];
  /** Rows drawn marked, with `unmatchedTitle` as their tooltip. */
  unmatched?: ReadonlySet<number>;
  unmatchedTitle?: string;
  /** Values that keep their board column even with no card left in it, in order. */
  keep?: readonly string[];
  /** The card that takes Tab, by row. */
  picked?: number | null;
  /** A cell's value as HTML. Absent, a value is drawn as its plain text. */
  render?: (value: string) => string;
  /** What the rows say when there are none to draw. */
  empty?: string;
}

/**
 * The board: one column per value of the grouping column, in the order the values
 * first appear in the table's rows, then a column for rows that leave it empty
 * when there are any. The cards in a column are in `order`.
 */
export function drawBoard(spec: BoardRows): { el: HTMLElement; state: BoardState } {
  const { headers, rows, columns, group, order } = spec;
  const valueOf = (r: number): string => (rows[r]?.[group] ?? '').trim();
  const kept = spec.keep ?? [];
  const values = kept.filter((v) => v !== '');
  const seen = new Set(values);
  let blank = kept.includes('');
  for (const r of [...order].sort((a, b) => a - b)) {
    const v = valueOf(r);
    if (!v) blank = true;
    else if (!seen.has(v)) {
      seen.add(v);
      values.push(v);
    }
  }
  if (blank) values.push('');
  const title = columns.find((c) => c !== group) ?? columns[0];
  const rest = columns.filter((c) => c !== group && c !== title);
  const state: BoardState = { group, values, fields: [title, ...rest] };

  const groupName = headers[group] ?? '';
  const el = document.createElement('div');
  el.className = 'sheaf-board';
  el.setAttribute('role', 'list');
  el.setAttribute('aria-label', `Board grouped by ${groupName}`);
  const byValue = new Map<string, number[]>(values.map((v) => [v, []]));
  for (const r of order) byValue.get(valueOf(r))?.push(r);
  for (const v of values) {
    const inColumn = byValue.get(v) ?? [];
    const label = v || `No ${groupName}`;
    const col = document.createElement('div');
    col.className = 'sheaf-board-col';
    col.setAttribute('role', 'listitem');
    col.dataset.value = v;
    const region = document.createElement('section');
    region.className = 'sheaf-board-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', `${label}, ${inColumn.length} ${inColumn.length === 1 ? 'card' : 'cards'}`);
    const head = document.createElement('div');
    head.className = 'sheaf-board-col-head';
    const name = document.createElement('span');
    name.className = v ? 'sheaf-board-col-name' : 'sheaf-board-col-name is-empty-value';
    name.textContent = label;
    const n = document.createElement('span');
    n.className = 'sheaf-board-col-count';
    n.textContent = String(inColumn.length);
    head.append(name, n);
    const list = document.createElement('ul');
    list.className = 'sheaf-board-cards';
    for (const r of inColumn) list.appendChild(drawCard(spec, rows[r], r, title, rest, !!spec.unmatched?.has(r)));
    region.append(head, list);
    col.appendChild(region);
    el.appendChild(col);
  }
  const home =
    (spec.picked != null && el.querySelector<HTMLElement>(`.sheaf-board-card[data-row="${spec.picked}"]`)) ||
    el.querySelector<HTMLElement>('.sheaf-board-card');
  if (home) home.tabIndex = 0;
  if (!order.length) {
    const empty = document.createElement('p');
    empty.className = 'sheaf-view-empty';
    empty.textContent = spec.empty ?? (rows.length ? 'No row matches this view.' : 'The table has no rows yet.');
    const box = document.createElement('div');
    box.append(el, empty);
    return { el: box, state };
  }
  return { el, state };
}

/**
 * One row as a card: its title, then each other column shown, named. The grouping
 * column is left off, since the board column already says it.
 */
function drawCard(spec: BoardRows, row: readonly string[], r: number, title: number, rest: readonly number[], unmatched: boolean): HTMLElement {
  const show = (el: HTMLElement, value: string): void => {
    if (spec.render) el.innerHTML = spec.render(value);
    else el.textContent = value;
  };
  const card = document.createElement('li');
  card.className = 'sheaf-board-card';
  card.dataset.row = String(r);
  card.tabIndex = -1;
  const head = document.createElement('div');
  head.className = 'sheaf-board-title';
  head.dataset.c = String(title);
  show(head, row[title] ?? '');
  card.setAttribute('aria-label', (head.textContent ?? '').trim() || 'Untitled');
  card.setAttribute('aria-keyshortcuts', 'Enter Alt+ArrowLeft Alt+ArrowRight');
  if (unmatched) {
    card.classList.add('is-unmatched');
    if (spec.unmatchedTitle) card.title = spec.unmatchedTitle;
  }
  card.appendChild(head);
  for (const c of rest) {
    const field = document.createElement('div');
    field.className = 'sheaf-board-field';
    const label = document.createElement('span');
    label.className = 'sheaf-board-label';
    label.textContent = spec.headers[c] ?? '';
    const value = document.createElement('span');
    value.className = 'sheaf-board-value';
    value.dataset.c = String(c);
    show(value, row[c] ?? '');
    field.append(label, value);
    card.appendChild(field);
  }
  return card;
}

/** What a board's owner tells the cards. */
export interface BoardHost {
  /** The board drawn in the frame now, or null while there is none or a card's field is open for typing. */
  current(): BoardState | null;
  /** Whether a card may be moved, which writes the table. */
  editable(): boolean;
  /** Write `row`'s grouping cell as `value`, the value of the board column it was moved to. */
  move(row: number, value: string): void;
  /** Open `row`'s field `col` for typing. Absent where a card's fields are not typed into. */
  open?(row: number, col: number): void;
}

/** A board's cards, as its owner reaches them. */
export interface BoardCards {
  /** Pick the card for `row` and give it the focus. */
  pickCard(row: number): void;
  /** The card picked, by row: the one Tab comes back to. */
  picked(): number | null;
  /** Let go of a card being dragged, which moves nothing. */
  endDrag(): void;
}

/**
 * The keys and the pointer on the cards of the board drawn in `frame`: the arrows
 * move between cards, Alt+Left and Alt+Right move the card to the next column, and
 * a card dragged to another column is moved there. Installed once per frame; the
 * frame's board can be drawn again any number of times under it.
 */
export function wireBoard(frame: HTMLElement, host: BoardHost): BoardCards {
  let pickedCard: number | null = null;
  /** A card on its way to another column under the pointer. */
  let cardDrag: {
    row: number;
    card: HTMLElement;
    home: HTMLElement | null;
    pointerId: number;
    x: number;
    y: number;
    active: boolean;
    over: HTMLElement | null;
  } | null = null;

  const cardEls = (within: ParentNode = frame): HTMLElement[] =>
    Array.from(within.querySelectorAll<HTMLElement>('.sheaf-board-card'));
  const cardEl = (row: number): HTMLElement | null =>
    frame.querySelector<HTMLElement>(`.sheaf-board-card[data-row="${row}"]`);
  const boardColumns = (): HTMLElement[] => Array.from(frame.querySelectorAll<HTMLElement>('.sheaf-board-col'));

  const pickCard = (row: number): void => {
    pickedCard = row;
    const el = cardEl(row);
    if (!el) return;
    for (const other of cardEls()) other.tabIndex = other === el ? 0 : -1;
    el.focus({ preventScroll: false });
  };

  /** Move a card to the board column for `value`, unless it is already there. */
  const moveCard = (row: number, value: string): void => {
    if (!host.current() || !host.editable()) return;
    host.move(row, value);
    pickCard(row);
  };

  frame.addEventListener('keydown', (e) => {
    const board = host.current();
    if (!board) return;
    const card = (e.target as HTMLElement).closest?.('.sheaf-board-card') as HTMLElement | null;
    if (!card || !frame.contains(card)) return;
    const row = Number(card.dataset.row);
    const columns = boardColumns();
    const home = card.closest('.sheaf-board-col') as HTMLElement;
    const at = columns.indexOf(home);
    const inColumn = cardEls(home);
    const i = inColumn.indexOf(card);
    const k = e.key;
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      // Alt+Left and Alt+Right move the card, as they move a column in a table.
      const to = columns[at + (k === 'ArrowLeft' ? -1 : 1)];
      if (to) moveCard(row, to.dataset.value ?? '');
    } else if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
      return;
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      const next = inColumn[i + (k === 'ArrowUp' ? -1 : 1)];
      if (next) pickCard(Number(next.dataset.row));
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      // To the card level with this one in the nearest column that has any.
      const step = k === 'ArrowLeft' ? -1 : 1;
      for (let j = at + step; j >= 0 && j < columns.length; j += step) {
        const there = cardEls(columns[j]);
        if (!there.length) continue;
        pickCard(Number(there[Math.min(i, there.length - 1)].dataset.row));
        break;
      }
    } else if ((k === 'Enter' || k === 'F2') && host.open) {
      // The card's title opens for typing, as Enter opens a cell.
      host.open(row, board.fields[0]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  frame.addEventListener('dblclick', (e) => {
    const board = host.current();
    if (!board || !host.open) return;
    const target = e.target as HTMLElement;
    const card = target.closest?.('.sheaf-board-card') as HTMLElement | null;
    if (!card) return;
    // The field double-clicked, or the title for a double-click anywhere else on the card.
    const value = target.closest?.('[data-c]') as HTMLElement | null;
    host.open(Number(card.dataset.row), value && card.contains(value) ? Number(value.dataset.c) : board.fields[0]);
  });

  // A card is dragged with pointer events, so a pen or a finger moves it as a mouse does.
  const columnUnder = (e: PointerEvent): HTMLElement | null => {
    const owned = (el: Element | null | undefined): HTMLElement | null => {
      const col = el?.closest?.('.sheaf-board-col') as HTMLElement | null;
      return col && frame.contains(col) ? col : null;
    };
    // Hit-tested where the pointer is: once the card holds the pointer, every event's target is the card.
    return owned(document.elementFromPoint?.(e.clientX, e.clientY)) ?? owned(e.target as Element | null);
  };
  const markOver = (over: HTMLElement | null): void => {
    const drag = cardDrag;
    if (!drag) return;
    const target = over === drag.home ? null : over;
    if (target === drag.over) return;
    drag.over?.classList.remove('is-drop-target');
    target?.classList.add('is-drop-target');
    drag.over = target;
  };
  const endDrag = (): void => {
    const drag = cardDrag;
    if (!drag) return;
    cardDrag = null;
    drag.card.classList.remove('is-dragging');
    drag.over?.classList.remove('is-drop-target');
    frame.querySelector('.sheaf-board')?.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onCardMove, true);
    window.removeEventListener('pointerup', onCardUp, true);
    window.removeEventListener('pointercancel', onCardCancel, true);
    window.removeEventListener('keydown', onCardKey, true);
    window.removeEventListener('blur', onCardCancel);
  };
  const onCardMove = (e: PointerEvent): void => {
    const drag = cardDrag;
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    // No button held: it went up somewhere the drag could not hear, so nothing moves.
    if (e.buttons === 0) return endDrag();
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.active = true;
      drag.card.classList.add('is-dragging');
      frame.querySelector('.sheaf-board')?.classList.add('is-dragging');
      try {
        drag.card.setPointerCapture?.(drag.pointerId);
      } catch {
        // No active pointer with that id; the window listeners still see the drag.
      }
    }
    markOver(columnUnder(e));
  };
  const onCardUp = (e: PointerEvent): void => {
    const drag = cardDrag;
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    if (drag.active) markOver(columnUnder(e) ?? drag.over);
    const to = drag.active ? drag.over : null;
    endDrag();
    if (to) moveCard(drag.row, to.dataset.value ?? '');
  };
  const onCardCancel = (): void => endDrag();
  const onCardKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !cardDrag) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
  };
  frame.addEventListener('pointerdown', (e) => {
    if (!host.current() || e.button !== 0) return;
    const card = (e.target as HTMLElement).closest?.('.sheaf-board-card') as HTMLElement | null;
    if (!card || !frame.contains(card)) return;
    const row = Number(card.dataset.row);
    pickCard(row);
    if (!host.editable()) return;
    endDrag();
    cardDrag = {
      row,
      card,
      home: card.closest('.sheaf-board-col') as HTMLElement | null,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      active: false,
      over: null,
    };
    window.addEventListener('pointermove', onCardMove, true);
    window.addEventListener('pointerup', onCardUp, true);
    window.addEventListener('pointercancel', onCardCancel, true);
    window.addEventListener('keydown', onCardKey, true);
    window.addEventListener('blur', onCardCancel);
  });

  return { pickCard, picked: () => pickedCard, endDrag };
}
