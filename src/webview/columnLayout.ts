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
  tightestWidth,
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
   * Whether this grid may wrap its cells in order to stay in the writing column.
   *
   * True for a pipe table, which is usually prose: a column of sentences wrapping to two or
   * three lines is what a table of prose looks like, and holding it to the writing column keeps
   * the page's measure. False for a `csv` or `tsv` block and for a data file's own grid, which
   * are tabular data: the value of a row is reading across it, and squeezing six columns of
   * short values into the writing column so every row wraps to two lines makes it unreadable
   * for the sake of a margin it never had.
   *
   * It decides which width the fit test asks for, and the two differ by a lot. See `roomFor`.
   */
  wrapToFit?: () => boolean;
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

/**
 * The two widths a table's room is decided from, each read where it is defined.
 *
 * Deliberately not derived from the scroller's own padding. A table that takes the pane is drawn with
 * no gap before it, so the padding depends on which room was chosen; deriving the room from the
 * padding as well is a cycle, and two attempts at this change failed on exactly that.
 */
interface PaneRoom {
  /** The writing column: `.cm-content`'s content box, which is what a table that fits is laid out to. */
  column: number;
  /** `--md-gutter`, which is the space left after a table that takes the pane. */
  gutter: number;
}

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

/**
 * Measure every table on screen again, for a change that alters column widths without
 * altering any table's text.
 *
 * The cache is keyed by what a table holds, which is the right key for almost
 * everything and exactly the wrong one here: the row-number column narrows when the
 * document's line numbers go off and widens when they come back, and not a byte of any
 * table changes. Without this the digits come back into the strip that was sized for
 * none of them.
 */
export function remeasureAllTables(): void {
  for (const layout of live) layout.remeasure();
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
  /**
   * The frame's left inset: the room it gained on that side by reaching past the writing
   * column, held as padding inside the scroller so it scrolls away.
   *
   * Zero for a table that keeps the column — one in a quote or a list, and every table on a
   * pane no wider than the column — and then every width below is what it was before any of
   * this, which is what keeps a narrow window unchanged.
   */
  let frameInset = 0;
  /** The last reading of the two widths a room is chosen from. See `PaneRoom`. */
  let paneRoom: PaneRoom = { column: 0, gutter: 0 };
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
        /*
         * Drawn the way the cell it measures is drawn.
         *
         * `tables.ts` puts `is-numeric` on a column whose values are all numbers, and the stylesheet gives
         * that class `font-variant-numeric: tabular-nums`, so every digit takes the widest digit's
         * advance. That is the feature which makes a column of figures line up. This probe built a plain
         * cell, so a numeric column was **measured with proportional digits and drawn with tabular ones**,
         * the measurement came in short of what the cell needs, and the allocator handed the column that
         * short number. Measured on the corpus's 800-row table: `"477"` needs 27.89px proportional and
         * 29.30px tabular in a 29px content box, so it fitted the measurement and wrapped on the screen,
         * and every row from 100 onward stood 61px tall instead of 37.
         *
         * Copied off the real cell rather than re-derived from the values, so the probe cannot come to a
         * different answer from the thing it stands in for. The shortfall is not per digit: tabular pays
         * for the widest advance, so a column of ones loses a great deal and a column of eights almost
         * nothing, which is why no rule about digit counts would have caught this.
         */
        const real = grid.querySelector(`tbody td[data-c="${c}"]`);
        if (real) td.className = real.className;
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

  /**
   * The room this table's columns divide, which is one of two widths.
   *
   * The frame reaches past the writing column, so `width` is the pane. Handing that to the
   * allocator for every table would stretch a three-column table across the window — and
   * worse, it is circular: a table only reaches past the column because it did not fit, and
   * a wider container is one it fits.
   *
   * It comes apart by asking a width of the table that does not depend on the container.
   * Fits the column, lay it out in the column, exactly as before any of this. Does not fit,
   * lay it out in the pane, so the room becomes visible table rather than more scrolling.
   * Stable in both directions, because the question never reads the answer.
   *
   * **Which width, though.** This used to ask the table's *natural* width, the sum of the
   * columns' no-wrap maxima, and that made wrapping the trigger instead of overflow. One long
   * sentence sets its column's maximum to that sentence on a single line, so a table of prose
   * essentially never fits, and it took the pane every time however comfortably it would have
   * sat in the column with two-line cells. The common table was the one that lost the
   * document's measure, with the heading above it starting at the text's left edge and the
   * table running a long way past where that paragraph ends.
   *
   * So for a table that may wrap it asks the *tightest* width instead: every column at its
   * floor, every pinned column at its pinned width. That is exactly the case where the frame has
   * to scroll sideways, which is what breaking out of the column is for. Both sums are equally
   * independent of the container, so the circularity above still resolves. Expect fewer tables in
   * the pane, and the ones that are there to be the ones that need it.
   *
   * **A data grid asks the natural width, and that is the older rule kept on purpose.** A `csv`
   * or `tsv` block is tabular data: the value of a row is reading across it, and a column of
   * short values has nothing to gain from wrapping. Asking the tightest width for one squeezed a
   * six-column TSV of `sku / description / warehouse / on_hand / reserved / reorder_at` into the
   * writing column and wrapped all three hundred of its rows to two lines, doubling its height,
   * to earn a right margin it never had. Wrapping is what a table of prose does and what a
   * spreadsheet does not, so which width the fit test asks for follows that and nothing else.
   */
  const roomFor = (m: Measured, width: number, inset: number, env: PaneRoom): { width: number; tookPane: boolean } => {
    /*
     * A pixel of the room goes to the table's own border. `border-collapse: collapse` puts
     * half a border outside the table's box on each side, so a table laid out to exactly the
     * room it was given ends half a pixel past the frame. That never showed while the frame
     * sat inside the writing column, where 96px of gutter absorbed it; the frame now ends at
     * the pane's edge, a table that fits has `overflow-x: visible` for its sticky header, and
     * that half pixel reached the editor's own scrollbar. Measured on the corpus: a table at
     * 1200.5 in a pane of 1200, and a document that scrolled sideways.
     *
     * Only a frame that reaches the pane, which is what a non-zero inset says. A table with
     * no inset — one in a quote, one in a frame that never grew — is laid out exactly as it
     * always was, its overshoot still lands in a gutter, and taking a pixel off it would move
     * every existing table for a problem it does not have.
     */
    /*
     * **The pane is the whole frame, less the gutter left after the last column and the border
     * pixel.** It used to be the frame less one inset, which left a table that overflows resting an
     * inset in from its frame's left edge: measured at a 1200px pane, frame `0..1200` with the first
     * cell at `246`, so 246px of empty scroller padding before a table too wide to fit. That is the
     * dead space, and a table filling the frame is what removes it.
     *
     * The writing column comes from `.cm-content` rather than from `width - 2 * inset`. Those agree
     * while the padding is the inset on both sides and stop agreeing the moment an overflowing table
     * has its left padding taken away, which is this change. One value cannot be both the room a
     * table is laid out to and the space held before its content.
     *
     * A table that fits still gets the writing column, so it still lines up with the prose and is
     * still centred by the two equal insets around it.
     */
    const usesPane = wrap.classList.contains('can-use-pane');
    const pane = width - (usesPane ? env.gutter : inset) - (inset > 0 || usesPane ? 1 : 0);
    /*
     * The writing column only for a frame that reached the pane. A table in a quote, under a list
     * item, or in a frame that never grew has its own frame as its room, and that frame is narrower
     * than the writing column: reading the column for one of those laid a 709px table into a 688px
     * frame and then called it fitting, because it was compared against a room it never had.
     */
    const column = usesPane && env.column > 0 ? env.column : width - 2 * inset;
    if (column <= 0) return { width: pane, tookPane: true };
    const wants =
      m.gutter +
      (opts.wrapToFit?.() === false
        ? m.columns.reduce((sum, c) => sum + c.max, 0)
        : tightestWidth(m.columns, { floor: m.floor, cap: Infinity, pinned: opts.pinned?.() }));
    /*
     * Which room was chosen travels with the width, because the drawing depends on it and working it
     * out again beside this would be the same fact in two places. A table that took the pane is drawn
     * with no gap before it and a gutter after it; one that fits its column keeps a gap on both sides.
     */
    return wants <= column ? { width: column, tookPane: false } : { width: pane, tookPane: true };
  };

  /** Write the decided widths into the table as a `<colgroup>` of pixel lengths. */
  const lay = (m: Measured, frame: number, inset: number, env: PaneRoom): void => {
    const table = opts.table();
    if (!table) return;
    if (cellIsOpen() && lastWidths?.length) return;
    const { width, tookPane } = roomFor(m, frame, inset, env);
    // The class the stylesheet draws the gaps from. "Took the pane" rather than "scrolls": a table can
    // take the pane and still fit it, and what decides where its gaps go is which room it was given.
    wrap.classList.toggle('is-pane-wide', tookPane);
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
    /*
     * Where the table's right edge is inside the frame, so the chrome above it can align to the table
     * rather than to the frame.
     *
     * `.can-use-pane` puts negative margins on the wrap so its box reaches both pane edges, and the
     * controls bar is `left: 0; right: 0` inside that box with its buttons pushed right. So the buttons
     * right-aligned to the **pane**: measured in a VS Code window, a table drawn 192..901 had its bar
     * ending at 1091, which is 190px past the table and one pixel short of the pane. A closed issue says
     * the bar "floats over the table's top-right", and for a table that fits its column it did not.
     *
     * Published from the two numbers already in hand rather than measured back off the DOM, because this
     * runs in a write phase and reading a rectangle here would force a layout. The inset is the frame's
     * own left padding, which is where the table starts, and the rest is the width just set.
     */
    wrap.style.setProperty('--md-table-edge', `${inset + m.gutter + alloc.total}px`);
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
    | { kind: 'start'; width: number; inset: number; room: PaneRoom; env: string }
    | { kind: 'probe'; widths: number[] };

  const request = (): void => {
    if (dead) return;
    view.requestMeasure<Reading>({
      key,
      read: () => {
        if (dead || !wrap.isConnected) return { kind: 'stop' };
        if (phase === 'idle') {
          /*
           * The scroller's own left padding is the inset, and `roomFor` treats it as the same
           * on both sides, which is what `width - 2 * inset` says.
           *
           * That is true of a frame reaching the pane, where the stylesheet sets both paddings
           * to the inset. It is read from the left alone because the right one is not always
           * the inset: a table that cannot use the pane has no inset and takes a gutter of
           * right padding once it scrolls, purely so the end of the table is visible, and that
           * gap must not be taken out of the room the columns divide. `clientWidth` is the
           * padding box, so it is the room either way and neither padding changes it.
           *
           * This comment used to say the scroller had no right padding at all. That stopped
           * being true when a scrolled table gained its end gap, and a reader went on to
           * reason from it.
           */
          const style = getComputedStyle(grid);
          const pad = parseFloat(style.paddingLeft);
          /*
           * The writing column from the element that defines it, and the page gutter from its own
           * custom property, because `roomFor` may not read either off this scroller's padding any
           * more. The fallbacks are the old arithmetic, so a page with neither behaves as it did.
           */
          const content = grid.closest('.cm-content') ?? document.querySelector('.cm-content');
          const cs = content ? getComputedStyle(content) : null;
          const column =
            content && cs
              ? Math.max(0, content.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
              : 0;
          const gutter = parseFloat(style.getPropertyValue('--md-gutter'));
          const inset = Number.isFinite(pad) ? pad : 0;
          return {
            kind: 'start',
            width: grid.clientWidth,
            inset,
            room: { column, gutter: Number.isFinite(gutter) && gutter > 0 ? gutter : inset },
            env: environment(grid),
          };
        }
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
          frameInset = reading.inset;
          paneRoom = reading.room;
          const k = measureKey();
          const stamp = `${k}@${reading.width}#${pinStamp()}`;
          const known = cache.get(k);
          if (known) {
            if (stamp === applied && opts.table()?.querySelector(':scope > colgroup')) return;
            applied = stamp;
            return lay(known, reading.width, reading.inset, reading.room);
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
        lay(m, paneWidth, frameInset, paneRoom);
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
    /*
     * While a cell of this table is open, the widths are held where they were when it
     * opened, so a measurement cannot change anything and the whole cycle is skipped.
     *
     * `lay` holds the same rule and is the one that must not write a colgroup. This is
     * the same rule placed where the work begins rather than where it ends, and the
     * difference is the entire cost: the grid rewrites its source on every keystroke, so
     * the signature changes, so `measureKey` misses the width cache, so a throwaway copy
     * of the table is built and measured before `lay` is reached and returns without
     * using it. On a 200x200 table that copy is 40,000 cells, and it was 90ms of every
     * keystroke, about a third of the whole cost. The width cache is keyed on content
     * precisely so that editing invalidates it, which is right for a committed edit and
     * exactly wrong for each keystroke of one.
     *
     * Nothing about the layout changes, because nothing downstream of here was reaching
     * the table anyway. What was discarded after the work is now not done.
     *
     * A pane resized while a cell is open still holds its widths, as it did before: the
     * measurement used to run and be thrown away at `lay`, and now it does not run. The
     * cache is left without an entry for this keystroke's signature, which is what the
     * remeasure on close is for, and that pays for one copy rather than one per key.
     */
    if (cellIsOpen() && lastWidths?.length) return;
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

  /*
   * While a cell of this table is open for editing, its column widths are held exactly
   * where they were when it opened.
   *
   * Every keystroke in a cell changes what the table holds, so it was a fresh measurement
   * and a fresh allocation every time: the column being typed in widened and the one
   * beside it gave up the same pixels, so the text slid sideways under the caret, 3 to 9px
   * a keystroke, and the prose column rewrapped as it narrowed. Holding the widths is what
   * a hand-pinned column already does; while a cell is open, every column does it.
   *
   * The open editor is read from the grid rather than passed in by `tables.ts`, and that is
   * deliberate rather than convenient. The alternative was an option the widget filled in
   * from its own state, and the widget's `toDOM` is held to an exact line budget it may not
   * grow, because at three thousand lines nothing inside it can be reached from a test. A
   * decision this module can make for itself should not cost that closure two more lines.
   *
   * "Not while a cell is open" is the rule, not "never": a column whose content genuinely
   * outgrew it still has to end up wider, or a table filled in from empty would keep its
   * placeholder widths for ever. That is what the measurement on close is for.
   */
  const cellIsOpen = (): boolean => !!grid.querySelector('.sheaf-table-input');

  /*
   * And the close itself, which nothing else reports. The grid redraws the cell it was
   * editing, but that is not a layout, so without this the widths stay frozen at the
   * moment the cell opened for as long as the table is untouched afterwards.
   */
  let wasOpen = false;
  const watchEditor = new MutationObserver(() => {
    const open = cellIsOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) layout.remeasure();
  });
  watchEditor.observe(grid, { childList: true, subtree: true });

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    let seen = -1;
    observer = new ResizeObserver(() => {
      const w = grid.clientWidth;
      if (w === seen) return;
      seen = w;
      refresh();
    });
    /*
     * The border box, not the default content box, and the difference is a whole class of bug.
     *
     * The frame's inset is padding on both sides, so its content box is the writing column and
     * stays exactly that at every pane wide enough for the inset to be at its ceiling: 708px at a
     * pane of 1400 and 708px at a pane of 3000, while `clientWidth` goes 1400 and 3000. Watching
     * the content box, this observer therefore **never fired on a widening**, and only fired once
     * the pane was narrow enough to squeeze the column itself.
     *
     * So a table kept the widths it had been given in a narrower pane until something else forced
     * a re-layout. Measured: the same pane of 925px laid out at 1491px total when reached from
     * 1400 and at 1516px when reached from 700, both stable, because in the first case the last
     * layout had run at a frame of 1000 and never run again. That is the jump a person sees when
     * they drag the editor's edge, and it is why it looked like more than the pane had moved: it
     * is the accumulated difference catching up, not a step.
     *
     * The callback already compares `clientWidth` against the last value it acted on, so a box
     * that reports more often costs nothing.
     */
    observer.observe(grid, { box: 'border-box' });
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
      watchEditor.disconnect();
      grid.removeEventListener('scroll', onScroll);
      dropProbe();
      note?.remove();
      note = null;
    },
  };
  live.add(layout);
  return layout;
}
