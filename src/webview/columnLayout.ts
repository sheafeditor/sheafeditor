/*
 * Measuring a table's columns and writing the result into the grid.
 *
 * `columnWidths.ts` decides how wide each column should be. This module finds
 * out what each column's content actually needs, hands those numbers over, and
 * writes the answer back as a `<colgroup>`.
 *
 * How the measuring works. A column's two interesting widths are the width at
 * which nothing in it wraps and the width below which a word would have to
 * break, and neither can be worked out from the cell's source text: bold is
 * wider than plain, a code span carries its own font, a picture is whatever it
 * is, and a line of Japanese is twice the width of the same number of Latin
 * letters. The browser knows all of it, and a table asked to be `max-content`
 * wide lays every column out at exactly the first number while a table asked to
 * be `min-content` wide lays every column out at exactly the second. So a
 * throwaway copy of the table, drawn with the same stylesheet, written once at
 * each of those widths and read once after each write, gives both vectors for
 * every column at once.
 *
 * What the copy contains. Every cell of a long table would be far too much to
 * draw, and almost all of it would be irrelevant: a column's two numbers come
 * from a handful of its cells. The copy holds the header row plus the few widest
 * cells of each column, ranked by the same display-width function the Markdown
 * padding uses, together with the cells holding each column's longest single
 * word, which is what the minimum turns on and is not always the widest cell.
 * An eight-hundred-row table is measured from about a hundred cells.
 *
 * What a pane drag costs. Nothing but arithmetic. The two numbers a column
 * arrives with do not depend on how wide the pane is, so dragging one never
 * re-measures anything: the cached pair is handed to the allocator again and
 * thirteen pixel widths are rewritten. That is why the width is taken exactly
 * rather than rounded to a step, which would leave the table standing a few
 * pixels short of its own pane for no gain.
 *
 * Why the answer is cached outside the widget. `TableWidget.eq` compares the
 * table's position as well as its text, so typing anywhere above a table builds
 * a new widget for it. A cache living in the widget, or keyed by position, would
 * re-measure on every keystroke. This one is keyed by the table's content, so it
 * survives every edit that did not change the table and is dropped when the font
 * or the device pixel ratio changes underneath it.
 *
 * What it refuses to do. A webview in a background tab is not laid out, so every
 * width there reads as zero. Rather than lay the table out at zero, a measurement
 * that cannot run leaves the table exactly as it is and asks again when the tab
 * comes back or the frame is resized.
 */

import { EditorView } from '@codemirror/view';
import {
  Allocation,
  ColumnExtent,
  COLUMN_CAP_FRACTION,
  COLUMN_FLOOR_CH,
  allocateColumnWidths,
} from './columnWidths';

/** The table as the grid holds it, which is all the measuring needs. */
export interface ColumnShape {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface ColumnLayoutOptions {
  /** The live `<table>`, or null while the grid has not drawn one. */
  table: () => HTMLTableElement | null;
  /** The table's current cells. */
  shape: () => ColumnShape;
  /** The table's content signature, which is what a measurement is cached under. */
  signature: () => string;
  /** A cell's Markdown as display HTML, so the copy is drawn the way the grid is. */
  render: (value: string) => string;
  /** How wide a string reads, for choosing which cells are worth drawing. */
  rank: (value: string) => number;
  /**
   * Columns held at a width someone set by hand, by index. Read every time the
   * columns are laid out, so a change to them takes effect on the next `refresh`.
   */
  pinned?: () => ReadonlyMap<number, number> | null;
  /** Told each time new widths have been written into the table. */
  onLayout?: () => void;
}

export interface ColumnLayout {
  /** Measure if needed and lay the columns out. Called after every draw. */
  refresh: () => void;
  /** Forget this table's measurement, for when a picture in it has finished loading. */
  remeasure: () => void;
  /**
   * What the columns' content was measured as, and the narrowest a column is made,
   * or null while the table has not been measured.
   */
  measured: () => { columns: readonly ColumnExtent[]; floor: number } | null;
  /** The width each column was last laid out at, or null while it has not been. */
  widths: () => readonly number[] | null;
  destroy: () => void;
}

/** How many of a column's widest cells are drawn in the copy. */
const PROBE_WIDEST = 4;

/** And how many of the cells holding its longest word. */
const PROBE_LONGEST_WORD = 2;

/** How many tables' measurements are kept. Beyond this the oldest is dropped. */
const CACHE_LIMIT = 48;

interface Measured {
  /** The row-number gutter's width, which is fixed rather than allocated. */
  gutter: number;
  /** The width of a column holding `COLUMN_FLOOR_CH` characters, which is the floor. */
  floor: number;
  columns: ColumnExtent[];
}

const cache = new Map<string, Measured>();
let cacheStamp = '';

/** Everything currently on screen, so a font or visibility change can reach it. */
const live = new Set<ColumnLayout>();

/** Ids for the screen-reader note, which several tables can be showing at once. */
let noteSeq = 0;

const doc: Document | undefined = typeof document === 'undefined' ? undefined : document;

/*
 * Nothing is measured before the fonts are in. A width read while the fallback
 * font is still drawing is wrong for every column at once, and it is wrong in
 * the direction that makes text wrap.
 */
let fontsReady = !doc || !(doc as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
if (!fontsReady && doc) {
  (doc as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready.then(() => {
    fontsReady = true;
    cache.clear();
    for (const layout of live) layout.refresh();
  });
}

if (doc) {
  // A hidden webview is not laid out, so a table drawn while its tab was in the
  // background has no widths at all. This is where it gets them.
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden) for (const layout of live) layout.refresh();
  });
}

/** A short, stable stand-in for a long table's text, so the cache holds keys and not documents. */
export function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${s.length.toString(36)}`;
}

/** What every measurement in the cache was taken under. A change throws them all out. */
function environment(el: Element): string {
  const cs = getComputedStyle(el);
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  return `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.letterSpacing}|${dpr}`;
}

/**
 * The cells worth drawing for each column: its widest few, plus the ones holding
 * its longest single word, which is what decides how narrow it can go and is
 * often not the same cell. Returned as rows so they can be drawn as a table;
 * a column's widths depend only on which strings are in it, not on which row
 * each one came from, so pairing them up across columns costs nothing.
 */
export function probeRows(shape: ColumnShape, rank: (value: string) => number): string[][] {
  const cols = shape.headers.length;
  const picked: string[][] = [];
  const word = (value: string): number => {
    let best = 0;
    for (const part of value.split(/\s+/)) {
      const w = rank(part);
      if (w > best) best = w;
    }
    return best;
  };
  for (let c = 0; c < cols; c++) {
    // Two small leaderboards rather than a sort: an eight-hundred-row table
    // should cost one pass over its cells, not a sort of every column.
    const widest: { value: string; score: number }[] = [];
    const longest: { value: string; score: number }[] = [];
    const offer = (into: typeof widest, limit: number, value: string, score: number): void => {
      if (score <= 0) return;
      if (into.length >= limit && score <= into[into.length - 1].score) return;
      const at = into.findIndex((e) => score > e.score);
      into.splice(at < 0 ? into.length : at, 0, { value, score });
      if (into.length > limit) into.pop();
    };
    for (const row of shape.rows) {
      const value = row[c] ?? '';
      if (value === '') continue;
      offer(widest, PROBE_WIDEST, value, rank(value));
      offer(longest, PROBE_LONGEST_WORD, value, word(value));
    }
    const seen = new Set<string>();
    const take: string[] = [];
    for (const e of [...widest, ...longest]) {
      if (seen.has(e.value)) continue;
      seen.add(e.value);
      take.push(e.value);
    }
    picked.push(take);
  }
  const height = picked.reduce((n, p) => Math.max(n, p.length), 0);
  const rows: string[][] = [];
  for (let r = 0; r < height; r++) rows.push(picked.map((p) => p[r] ?? ''));
  return rows;
}

export function createColumnLayout(
  view: EditorView,
  wrap: HTMLElement,
  grid: HTMLElement,
  opts: ColumnLayoutOptions
): ColumnLayout {
  // The two probe columns that are not data: a ruler holding the floor's worth
  // of characters, and a stand-in for the row-number gutter.
  const EXTRA = 2;
  const key = { table: wrap };
  let dead = false;
  let phase: 'idle' | 'max' | 'min' = 'idle';
  let probe: HTMLElement | null = null;
  let maxes: number[] = [];
  let paneWidth = 0;
  let lastSig = '';
  let cacheKey = '';
  let applied = '';
  let again = false;
  let note: HTMLElement | null = null;
  let lastMeasured: Measured | null = null;
  let lastWidths: number[] | null = null;

  const measureKey = (): string => {
    const sig = opts.signature();
    // Identical by reference until the grid adopts new text, so the digest is
    // taken once per change rather than once per resize.
    if (sig !== lastSig) {
      lastSig = sig;
      cacheKey = digest(sig);
    }
    return cacheKey;
  };

  const dropProbe = (): void => {
    probe?.remove();
    probe = null;
    phase = 'idle';
  };

  /** Draw the throwaway copy: ruler, gutter, then the cells worth measuring. */
  const buildProbe = (): void => {
    dropProbe();
    const shape = opts.shape();
    const host = document.createElement('div');
    host.className = 'sheaf-table-probe';
    host.setAttribute('aria-hidden', 'true');
    const table = document.createElement('table');
    table.setAttribute('role', 'presentation');
    table.style.tableLayout = 'auto';
    table.style.width = 'max-content';
    const head = document.createElement('tr');
    // The ruler's characters go in a body cell and not in this header, because a
    // header is drawn bold and the floor is a width for ordinary cell text.
    head.appendChild(document.createElement('th'));
    const corner = document.createElement('th');
    corner.className = 'sheaf-table-corner';
    head.appendChild(corner);
    for (const h of shape.headers) {
      const th = document.createElement('th');
      th.innerHTML = opts.render(h);
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const body = document.createElement('tbody');
    const rows = probeRows(shape, opts.rank);
    // The widest row number the gutter will ever hold.
    const gutter = String(Math.max(1, shape.rows.length));
    for (let r = 0; r < Math.max(1, rows.length); r++) {
      const tr = document.createElement('tr');
      const ruler = document.createElement('td');
      ruler.textContent = r === 0 ? '0'.repeat(COLUMN_FLOOR_CH) : '';
      tr.appendChild(ruler);
      const gut = document.createElement('td');
      gut.className = 'sheaf-table-gutter';
      gut.textContent = r === 0 ? gutter : '';
      tr.appendChild(gut);
      for (let c = 0; c < shape.headers.length; c++) {
        const td = document.createElement('td');
        td.innerHTML = opts.render(rows[r]?.[c] ?? '');
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    host.appendChild(table);
    // Beside the grid, never inside it: the grid's own selectors walk its rows.
    wrap.appendChild(host);
    probe = host;
  };

  /** Read one width per column off the copy, from the header row, which always has every column. */
  const readProbe = (): number[] => {
    const head = probe?.querySelector('thead tr');
    if (!head) return [];
    return Array.from(head.children, (cell) => Math.ceil(cell.getBoundingClientRect().width));
  };

  /** Say in words what the edge shading shows, without adding anything to tab through. */
  const describe = (scrolls: boolean): void => {
    if (!scrolls) {
      note?.remove();
      note = null;
      grid.removeAttribute('aria-describedby');
      return;
    }
    if (note) return;
    note = document.createElement('span');
    note.className = 'sheaf-table-note';
    note.id = `sheaf-table-note-${++noteSeq}`;
    note.textContent = 'This table is wider than the pane and scrolls sideways.';
    wrap.appendChild(note);
    grid.setAttribute('aria-describedby', note.id);
  };

  /** Which edges have more table beyond them, for the shading on each side. */
  const edges = (): void => {
    const over = grid.scrollWidth - grid.clientWidth;
    wrap.classList.toggle('is-scroll-start', over > 1 && grid.scrollLeft > 1);
    wrap.classList.toggle('is-scroll-end', over > 1 && grid.scrollLeft < over - 1);
  };

  /** The pins as they stand, written out so two sets of them can be compared. */
  const pinStamp = (): string => {
    const pins = opts.pinned?.();
    if (!pins || !pins.size) return '';
    return Array.from(pins, ([c, w]) => `${c}:${w}`).join(',');
  };

  /** Write the decided widths into the table as a `<colgroup>` of pixel lengths. */
  const lay = (m: Measured, width: number): void => {
    const table = opts.table();
    if (!table) return;
    const alloc: Allocation | null = allocateColumnWidths(Math.max(0, width - m.gutter), m.columns, {
      floor: m.floor,
      cap: COLUMN_CAP_FRACTION * width,
      // A column someone set the width of by hand is held there, and the rest
      // divide what it leaves.
      pinned: opts.pinned?.() ?? null,
    });
    if (!alloc) return;
    lastMeasured = m;
    lastWidths = alloc.widths;
    const group = document.createElement('colgroup');
    for (const w of [m.gutter, ...alloc.widths]) {
      const c = document.createElement('col');
      c.style.width = `${w}px`;
      group.appendChild(c);
    }
    table.querySelector(':scope > colgroup')?.remove();
    table.insertBefore(group, table.firstChild);
    // Fixed layout is only fixed when the width is a length. `table-layout:
    // fixed` with `width: auto` or `width: max-content` is defined as auto mode,
    // and the colgroup would be a suggestion the browser is free to ignore.
    table.style.tableLayout = 'fixed';
    table.style.width = `${m.gutter + alloc.total}px`;
    wrap.classList.toggle('is-scroll-x', alloc.scrolls);
    describe(alloc.scrolls);
    edges();
    opts.onLayout?.();
  };

  const store = (k: string, m: Measured): void => {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(k, m);
  };

  type Reading =
    | { kind: 'stop' }
    | { kind: 'start'; width: number; env: string }
    | { kind: 'probe'; widths: number[] };

  const request = (): void => {
    if (dead) return;
    view.requestMeasure<Reading>({
      key,
      read: () => {
        if (dead || !wrap.isConnected) return { kind: 'stop' };
        if (phase === 'idle') return { kind: 'start', width: grid.clientWidth, env: environment(grid) };
        return { kind: 'probe', widths: readProbe() };
      },
      write: (reading) => {
        if (dead || reading.kind === 'stop') {
          again = false;
          return dropProbe();
        }
        if (reading.kind === 'start') {
          // No layout to read: a background tab, or a frame with no width yet.
          // Leave the table as the stylesheet drew it and wait to be asked again.
          if (reading.width <= 0) {
            again = false;
            return dropProbe();
          }
          if (reading.env !== cacheStamp) {
            cacheStamp = reading.env;
            cache.clear();
          }
          paneWidth = reading.width;
          const k = measureKey();
          const stamp = `${k}@${reading.width}#${pinStamp()}`;
          const known = cache.get(k);
          if (known) {
            if (stamp === applied && opts.table()?.querySelector(':scope > colgroup')) return;
            applied = stamp;
            return lay(known, reading.width);
          }
          applied = '';
          buildProbe();
          phase = 'max';
          return request();
        }
        const cols = opts.shape().headers.length;
        // The table changed under the copy. Start over rather than lay the
        // columns out from a measurement of a table that is no longer there.
        if (reading.widths.length !== cols + EXTRA) {
          dropProbe();
          return request();
        }
        if (phase === 'max') {
          maxes = reading.widths;
          const table = probe?.querySelector('table') as HTMLElement | null;
          if (!table) {
            again = false;
            return dropProbe();
          }
          table.style.width = 'min-content';
          phase = 'min';
          return request();
        }
        const mins = reading.widths;
        dropProbe();
        const m: Measured = {
          floor: maxes[0],
          gutter: maxes[1],
          columns: maxes.slice(EXTRA).map((max, i) => ({ min: mins[i + EXTRA], max })),
        };
        const k = measureKey();
        store(k, m);
        applied = `${k}@${paneWidth}#${pinStamp()}`;
        lay(m, paneWidth);
        // The frame was resized, or the text changed, while the copy was being
        // drawn. What just landed is the answer to the old question.
        if (again) {
          again = false;
          request();
        }
      },
    });
  };

  const refresh = (): void => {
    if (dead || !fontsReady) return;
    // A measurement is already in flight. Asking again now would read the copy
    // as though it were the grid; it is asked again as soon as that one lands.
    if (phase !== 'idle') {
      again = true;
      return;
    }
    request();
  };

  const onScroll = (): void => edges();
  grid.addEventListener('scroll', onScroll, { passive: true });

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    let seen = -1;
    observer = new ResizeObserver(() => {
      const w = grid.clientWidth;
      if (w === seen) return;
      seen = w;
      refresh();
    });
    observer.observe(grid);
  }

  const layout: ColumnLayout = {
    refresh,
    remeasure: () => {
      cache.delete(measureKey());
      applied = '';
      refresh();
    },
    measured: () => (lastMeasured ? { columns: lastMeasured.columns, floor: lastMeasured.floor } : null),
    widths: () => lastWidths,
    destroy: () => {
      dead = true;
      live.delete(layout);
      observer?.disconnect();
      observer = null;
      grid.removeEventListener('scroll', onScroll);
      dropProbe();
      note?.remove();
      note = null;
    },
  };
  live.add(layout);
  return layout;
}
