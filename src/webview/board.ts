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
  /**
   * A cell's value as HTML. Absent, a value is drawn as its plain text.
   *
   * Which of the two a board wants follows from what its rows are, and the two callers
   * differ on purpose. A pipe table's board passes `renderInline`, because a pipe table is
   * prose: `[guide](…)` on a card is a link, the same as in its grid. A view's board passes
   * nothing, because a view reads a CSV or TSV block and a field there is a value, so
   * `**done**` is eight characters and a bracketed address is an address you can read, the
   * same as in that block's grid. Each board agrees with the grid of the thing it draws.
   *
   * Written here rather than at either call, because the difference reads as an oversight in
   * whichever board you meet second and was reported as one. `tables.entry.ts` pins the
   * view's half, and the rule is on the Datatables and Boards pages.
   */
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
  /**
   * Follow a link drawn on a card. Absent where nothing can be opened, and then a link on a
   * card is drawn and does nothing, which is what it did everywhere before.
   *
   * Passed in rather than reached for, the way `render` is, because this file draws a board
   * and knows nothing about what an address means. Where an address opens is one decision
   * and it is made in `linkTarget.ts`.
   */
  openLink?(href: string): void;
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
  /**
   * A card lifted out of the flow and carried under the pointer.
   *
   * The card is taken out of the layout with `position: fixed` and left where it was, then
   * translated by how far the pointer has moved, so whatever part of it was under the finger
   * stays under it. It never leaves its own column in the DOM: only `slot`, the gap it left,
   * moves around, so putting the card back is a matter of clearing the lift and needs no
   * record of where it came from.
   *
   * `slot` is also the answer to where the card will land, which a column-wide highlight
   * cannot give: it sits between the two cards the pointer is between.
   *
   * A lifted card takes no pointer events. It is under the pointer by definition, so leaving
   * it hit-testable would make `document.elementFromPoint` answer with the card on every move,
   * and the card is a DOM descendant of the column it started in, so every hit test would say
   * the home column and no card could ever be dropped anywhere.
   */
  interface CardLift {
    /** The gap in the flow, which is also where the card will land. */
    slot: HTMLElement;
    /** The list the card belongs to, and the card it sat before, for a drag back outside. */
    homeList: HTMLElement | null;
    homeBefore: Element | null;
  }
  /** A card on its way to another column under the pointer. */
  let cardDrag: {
    row: number;
    card: HTMLElement;
    home: HTMLElement | null;
    pointerId: number;
    /** Where the press landed, which every later position is measured against. */
    x: number;
    y: number;
    /** Where the pointer is now, so a board scrolling under a still finger can re-aim. */
    px: number;
    py: number;
    active: boolean;
    over: HTMLElement | null;
    lift: CardLift | null;
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
  const owningColumn = (el: Element | null | undefined): HTMLElement | null => {
    const col = el?.closest?.('.sheaf-board-col') as HTMLElement | null;
    return col && frame.contains(col) ? col : null;
  };
  const columnUnder = (e: PointerEvent): HTMLElement | null =>
    // Hit-tested where the pointer is: once the card holds the pointer, every event's target is the card.
    owningColumn(document.elementFromPoint?.(e.clientX, e.clientY)) ?? owningColumn(e.target as Element | null);
  const markOver = (over: HTMLElement | null): void => {
    const drag = cardDrag;
    if (!drag) return;
    const target = over === drag.home ? null : over;
    if (target === drag.over) return;
    drag.over?.classList.remove('is-drop-target');
    target?.classList.add('is-drop-target');
    drag.over = target;
  };

  /* ---- Carrying the card ---------------------------------------------------- */

  /** The element the board scrolls sideways in, or null where the whole board fits. */
  const boardScroller = (): HTMLElement | null => {
    for (let el: HTMLElement | null = frame; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollWidth > el.clientWidth) return el;
    }
    return null;
  };

  /** The card in `list` that `y` falls above, which is what the gap goes in front of. */
  const cardAfter = (list: HTMLElement, y: number, moving: HTMLElement): Element | null => {
    for (const card of cardEls(list)) {
      if (card === moving) continue;
      const r = card.getBoundingClientRect();
      if (y < r.top + r.height / 2) return card;
    }
    return null;
  };

  /**
   * Put the gap where the card would land: between the two cards the pointer is between, in
   * the column under it, or back where the card started when the pointer is outside every
   * column. Dropping there writes nothing, so the gap says so before the release does.
   */
  const placeSlot = (drag: NonNullable<typeof cardDrag>, over: HTMLElement | null): void => {
    const lift = drag.lift;
    if (!lift) return;
    const list = (over?.querySelector('.sheaf-board-cards') as HTMLElement | null) ?? lift.homeList;
    if (!list) return;
    const before = over ? cardAfter(list, drag.py, drag.card) : lift.homeBefore;
    if (lift.slot.parentElement === list && lift.slot.nextElementSibling === before) return;
    list.insertBefore(lift.slot, before && before.parentElement === list ? before : null);
  };

  /** Where the carried card is drawn: its own place, moved by however far the pointer has. */
  const carry = (drag: NonNullable<typeof cardDrag>): void => {
    drag.card.style.transform = `translate(${drag.px - drag.x}px, ${drag.py - drag.y}px)`;
  };

  /*
   * A drag towards a column past the edge of a board that scrolls sideways scrolls it, so a
   * card can reach a column that is not on the screen.
   *
   * On a frame timer rather than on the pointer's own events, because a person who has carried
   * the card to the edge and is waiting for the board to come to them is not moving the pointer,
   * and a move handler would scroll once and stop. The same timer re-aims the gap, since the
   * column under a still pointer changes as the board goes past under it.
   */
  const EDGE = 48;
  const STEP = 14;
  let scrolling: number | null = null;
  const stopScrolling = (): void => {
    if (scrolling !== null) cancelAnimationFrame(scrolling);
    scrolling = null;
  };
  const scrollTowards = (): void => {
    stopScrolling();
    const drag = cardDrag;
    const scroller = drag ? boardScroller() : null;
    if (!drag || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const dir = drag.px > r.right - EDGE ? 1 : drag.px < r.left + EDGE ? -1 : 0;
    if (!dir) return;
    const step = (): void => {
      const now = cardDrag;
      if (!now) return stopScrolling();
      const was = scroller.scrollLeft;
      scroller.scrollLeft += dir * STEP;
      if (scroller.scrollLeft === was) return stopScrolling();
      const over = owningColumn(document.elementFromPoint?.(now.px, now.py));
      markOver(over);
      placeSlot(now, over === now.home ? null : over);
      scrolling = requestAnimationFrame(step);
    };
    scrolling = requestAnimationFrame(step);
  };

  /** Lift the card out of the flow, leaving a gap the size of it where it was. */
  const lift = (drag: NonNullable<typeof cardDrag>): void => {
    const rect = drag.card.getBoundingClientRect();
    const slot = document.createElement('li');
    slot.className = 'sheaf-board-slot';
    slot.style.height = `${rect.height}px`;
    slot.setAttribute('aria-hidden', 'true');
    const homeList = drag.card.parentElement as HTMLElement | null;
    const homeBefore = drag.card.nextElementSibling;
    drag.card.after(slot);
    // Fixed, so the numbers are the pointer's own and no scrolling ancestor has to be
    // measured; the card is already where it was, so the translate starts at nothing.
    drag.card.style.left = `${rect.left}px`;
    drag.card.style.top = `${rect.top}px`;
    drag.card.style.width = `${rect.width}px`;
    drag.lift = { slot, homeList, homeBefore };
    carry(drag);
  };

  /** Put the card back in the flow. It never left its own column, so this is all it takes. */
  const drop = (drag: NonNullable<typeof cardDrag>): void => {
    stopScrolling();
    drag.lift?.slot.remove();
    drag.lift = null;
    drag.card.style.left = '';
    drag.card.style.top = '';
    drag.card.style.width = '';
    drag.card.style.transform = '';
  };
  const endDrag = (): void => {
    const drag = cardDrag;
    if (!drag) return;
    cardDrag = null;
    drop(drag);
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
    drag.px = e.clientX;
    drag.py = e.clientY;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.active = true;
      /*
       * The press became a drag, so it is no longer a click on whatever it started on.
       *
       * Mostly covered already: a drag ends somewhere else, and the release only follows a
       * link it landed on. What this catches is the drag that ends with the card under the
       * pointer again, in the column it was dropped into, where the release would land on
       * the same link. No check has been seen to fail without it.
       */
      pressedLink = null;
      drag.card.classList.add('is-dragging');
      frame.querySelector('.sheaf-board')?.classList.add('is-dragging');
      try {
        drag.card.setPointerCapture?.(drag.pointerId);
      } catch {
        // No active pointer with that id; the window listeners still see the drag.
      }
      // After the class, so the card is already `position: fixed` when it is measured.
      lift(drag);
    }
    carry(drag);
    const over = columnUnder(e);
    markOver(over);
    placeSlot(drag, over === drag.home ? null : over);
    scrollTowards();
  };
  const onCardUp = (e: PointerEvent): void => {
    const drag = cardDrag;
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    if (drag.active) {
      drag.px = e.clientX;
      drag.py = e.clientY;
      markOver(columnUnder(e) ?? drag.over);
    }
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
  /*
   * A link on a card opens on a plain click, as one in a grid cell does.
   *
   * The release rather than the press, because a press on a card that then moves is somebody
   * dragging the card to another column. `pressedLink` is cleared by any drag that becomes
   * active, so the two gestures cannot both happen from one press.
   */
  const linkOn = (target: EventTarget | null): HTMLElement | null =>
    ((target as Element | null)?.closest?.('.sheaf-board-card [data-href]') as HTMLElement | null) ?? null;
  let pressedLink: HTMLElement | null = null;
  frame.addEventListener('pointerup', (e) => {
    const link = pressedLink;
    pressedLink = null;
    if (link && linkOn(e.target) === link) host.openLink?.(link.dataset.href ?? '');
  });

  frame.addEventListener('pointerdown', (e) => {
    if (!host.current() || e.button !== 0) return;
    const card = (e.target as HTMLElement).closest?.('.sheaf-board-card') as HTMLElement | null;
    if (!card || !frame.contains(card)) return;
    // The modifier opens on the press, as it does in prose and in a grid cell.
    const link = linkOn(e.target);
    if (link && (e.metaKey || e.ctrlKey)) {
      host.openLink?.(link.dataset.href ?? '');
      return;
    }
    pressedLink = link;
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
      px: e.clientX,
      py: e.clientY,
      active: false,
      over: null,
      lift: null,
    };
    window.addEventListener('pointermove', onCardMove, true);
    window.addEventListener('pointerup', onCardUp, true);
    window.addEventListener('pointercancel', onCardCancel, true);
    window.addEventListener('keydown', onCardKey, true);
    window.addEventListener('blur', onCardCancel);
  });

  return { pickCard, picked: () => pickedCard, endDrag };
}
