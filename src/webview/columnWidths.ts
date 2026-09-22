/*
 * How a rendered table divides the pane between its columns.
 *
 * This module is pure arithmetic: it takes a container width and each column's
 * measured content widths and returns a pixel width per column. It touches no
 * DOM, so it can be read, reasoned about and tested on its own; `columnLayout.ts`
 * does the measuring and writes the result into a `<colgroup>`.
 *
 * Why not leave it to the browser. A table with `width: 100%` and no
 * `table-layout` runs the auto algorithm, which has two consequences a document
 * editor cannot live with. The table is laid out at the larger of the width it
 * was given and the sum of every column's longest word, so it squeezes until the
 * longest words no longer fit and then overflows the pane: the frame's
 * `overflow-x` never engages at any width in between. And every column is
 * interpolated between its narrowest and widest form with one shared weight, so
 * a six-character `State` column gives up the same proportion of itself as a
 * two-hundred-character `Notes` column, and in a narrow pane the columns that
 * had nothing to give are the first to break.
 *
 * The rules below fix the second problem with a ceiling. A column that is
 * already short is under the ceiling, so it is never asked for anything; the
 * columns holding prose are the ones that give.
 *
 *   1. Everything fits at its widest: each column takes its widest form and the
 *      surplus is shared out in proportion to it, so the table fills the pane.
 *   2. Everything fits once the wide columns are held to the ceiling: each
 *      column takes the smaller of its widest form and the ceiling, never less
 *      than its own minimum, and what is left over goes back to the columns the
 *      ceiling held. This is the rule that leaves the short columns alone.
 *   3. Everything fits at the per-column minimum: each column starts at that
 *      minimum and every column is moved the same fraction of the way toward its
 *      widest form.
 *   4. Nothing fits: every column sits at its minimum and the frame scrolls.
 *
 * A pinned column holds the width it was given and is taken out of the division
 * entirely; the rest run the same four rules over whatever the pane has left.
 */

/** A column's measured content widths, in pixels. */
export interface ColumnExtent {
  /** The narrowest the column can be drawn without a word having to break. */
  min: number;
  /** The width at which nothing in the column wraps. */
  max: number;
}

export interface AllocateOptions {
  /** The narrowest any column is made, in pixels, unless its content is narrower still. */
  floor: number;
  /** The widest any column is made before rule 2 asks it to share, in pixels. */
  cap: number;
  /** Columns held at a fixed width, by index. They are taken out of the division. */
  pinned?: ReadonlyMap<number, number> | null;
}

export interface Allocation {
  /** One pixel width per column, in column order, whole numbers. */
  widths: number[];
  /** Their sum, which is the width the table is laid out at. */
  total: number;
  /** True when the table is wider than the pane, so its frame has to scroll. */
  scrolls: boolean;
  /** Which of the four rules decided this, for tests and for reading a layout back. */
  rule: 1 | 2 | 3 | 4;
}

/*
 * The starting values, in one place, so there is one thing to change when a real
 * window says they are wrong.
 *
 * Both are guesses. No browser, UI toolkit or table library publishes a default
 * or minimum column width to borrow, and `6ch` is the only number with any
 * currency at all: it is roughly a short word or a formatted date, and narrower
 * than that a column is a stack of single syllables. The ceiling is a fraction
 * rather than a length because what makes a column too greedy is how much of the
 * pane it is taking, not how many pixels it is; slightly under half leaves room
 * for a second column of prose beside it.
 */

/** The per-column minimum, in `ch` of the table's own font. */
export const COLUMN_FLOOR_CH = 6;

/** The per-column ceiling, as a fraction of the container's width. */
export const COLUMN_CAP_FRACTION = 0.45;

/** Below this, two pixel widths are the same width. */
const EPS = 0.01;

/**
 * Hand out `amount` across the open columns in proportion to `weight`, without
 * letting any column past its `room`. A column that fills up is closed and what
 * it could not take is offered to the rest, so the proportion holds among the
 * columns that can still use it and nothing is given to a column that would only
 * pad it with whitespace.
 */
function share(amount: number, weight: readonly number[], room: readonly number[]): number[] {
  const out = weight.map(() => 0);
  const open: number[] = [];
  for (let i = 0; i < weight.length; i++) if (weight[i] > 0 && room[i] > EPS) open.push(i);
  let left = amount;
  while (left > EPS && open.length) {
    let total = 0;
    for (const i of open) total += weight[i];
    if (total <= 0) break;
    let given = 0;
    const filled: number[] = [];
    for (const i of open) {
      const got = Math.min((left * weight[i]) / total, room[i] - out[i]);
      out[i] += got;
      given += got;
      if (out[i] >= room[i] - EPS) filled.push(i);
    }
    left -= given;
    // Nothing hit its ceiling, so the whole amount went out and the loop is done.
    if (!filled.length) break;
    for (const i of filled) open.splice(open.indexOf(i), 1);
  }
  return out;
}

/**
 * Round fractional widths to whole pixels without losing or inventing any. Each
 * width is the step in the running total rather than a rounding of its own, so
 * the rounded widths add up to the rounded total and the table's own width is
 * the sum of its columns.
 */
function whole(widths: readonly number[]): number[] {
  const out: number[] = [];
  let running = 0;
  let placed = 0;
  for (const w of widths) {
    running += w;
    const upto = Math.round(running);
    out.push(Math.max(1, upto - placed));
    placed = upto;
  }
  return out;
}

/**
 * Divide `width` pixels between `columns`. Returns null when there is nothing to
 * divide or nothing to divide it between, which is the caller's signal to leave
 * the table exactly as it is rather than lay it out at zero.
 */
export function allocateColumnWidths(
  width: number,
  columns: readonly ColumnExtent[],
  opts: AllocateOptions
): Allocation | null {
  const n = columns.length;
  if (!n || !Number.isFinite(width) || width <= 0) return null;

  // A measurement that came back as nothing, or with a minimum wider than the
  // maximum, is a measurement taken while something was still loading. Make it
  // consistent rather than propagating it into the arithmetic below.
  const MIN: number[] = [];
  const MAX: number[] = [];
  for (const c of columns) {
    const min = Number.isFinite(c.min) && c.min > 0 ? c.min : 0;
    MIN.push(min);
    MAX.push(Number.isFinite(c.max) && c.max > min ? c.max : min);
  }

  const floor = Number.isFinite(opts.floor) && opts.floor > 0 ? opts.floor : 0;
  const cap = Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : Infinity;

  const held = new Map<number, number>();
  for (const [i, w] of opts.pinned ?? []) {
    if (Number.isInteger(i) && i >= 0 && i < n && Number.isFinite(w) && w > 0) held.set(i, w);
  }

  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!held.has(i)) free.push(i);
  let room = width;
  for (const w of held.values()) room -= w;

  // Every column's own minimum: its content's minimum, lifted to the floor, but
  // never past its maximum, since a column narrower than the floor to begin with
  // has nothing to gain from being widened to it.
  const base = free.map((i) => Math.min(MAX[i], Math.max(MIN[i], floor)));
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

  const used = new Array<number>(n);
  for (const [i, w] of held) used[i] = w;
  let rule: 1 | 2 | 3 | 4;

  if (!free.length) {
    rule = 1;
  } else if (room <= 0) {
    // The pinned columns have taken the pane on their own. The rest go to their
    // minimum and the frame scrolls.
    rule = 4;
    free.forEach((i, k) => (used[i] = base[k]));
  } else {
    const max = free.map((i) => MAX[i]);
    const sumMax = sum(max);
    if (sumMax <= room) {
      // Rule 1. Nothing has to wrap, so nothing has to be decided: hand each
      // column its widest form and spread the surplus over them in proportion.
      rule = 1;
      const extra = share(room - sumMax, max, max.map(() => Infinity));
      free.forEach((i, k) => (used[i] = max[k] + extra[k]));
    } else {
      // The ceiling holds a column back; it never pushes one under its own
      // minimum. Without the lift, a column whose longest word is wider than
      // the ceiling would be handed a width that word cannot fit in, and the
      // table would report that it fits the pane while breaking words to do it.
      const soft = max.map((m, k) => Math.max(base[k], Math.min(m, cap)));
      const sumSoft = sum(soft);
      if (sumSoft <= room) {
        // Rule 2. Only the columns above the ceiling give anything up, and what
        // the pane has left over goes straight back to them. A column already
        // under the ceiling is untouched, which is the whole point of the rule.
        rule = 2;
        const capped = max.map((m, k) => (m > soft[k] + EPS ? m : 0));
        const headroom = max.map((m, k) => m - soft[k]);
        const back = share(room - sumSoft, sum(capped) > 0 ? capped : max, headroom);
        free.forEach((i, k) => (used[i] = soft[k] + back[k]));
      } else {
        const sumBase = sum(base);
        if (sumBase <= room) {
          // Rule 3. Every column is past its ceiling's help, so they all move the
          // same fraction of the way from their minimum toward their widest form.
          //
          // Toward `soft`, the ceiling, rather than toward `max`. Two reasons, both
          // measured rather than argued. It makes this rule meet rule 2: at t = 1
          // every column is exactly where rule 2 would start it, so widening the pane
          // through the boundary moves nothing suddenly. Interpolating toward `max`
          // leaves a single width where a column of prose jumps by more than a
          // hundred pixels while the short columns jump the other way, which is what
          // a person dragging the editor's edge would see as a fault. And it keeps
          // the ceiling's whole purpose, which is that a short column should not give
          // up the same proportion as a column of prose, working at the widths where
          // the pane is tight rather than only where it is generous.
          rule = 3;
          const span = sumSoft - sumBase;
          const t = span > EPS ? Math.min(1, (room - sumBase) / span) : 0;
          free.forEach((i, k) => (used[i] = base[k] + t * (soft[k] - base[k])));
        } else {
          // Rule 4. Even the minimums do not fit. Nothing is squeezed below them:
          // the table keeps its shape and the frame scrolls sideways.
          rule = 4;
          free.forEach((i, k) => (used[i] = base[k]));
        }
      }
    }
  }

  const widths = whole(used);
  const total = sum(widths);
  return { widths, total, scrolls: total > width + EPS, rule };
}
