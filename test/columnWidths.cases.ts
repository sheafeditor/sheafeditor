/*
 * Fixture checks for the column-width allocator.
 *
 * The allocator is pure arithmetic over measured widths, so these run on
 * numbers alone: no editor, no grid, no layout. They are registered from
 * `tables.entry.ts` and reported with the rest of the table checks.
 *
 * What they cannot cover is anything that needs a browser to have laid
 * something out. The minimum and maximum each column arrives with are read off
 * a probe table in the webview, and jsdom has no layout at all, so every width
 * there is zero. The measuring pass, the `<colgroup>` it writes and everything
 * about how a narrow pane looks are checked in a real window.
 */

import { allocateColumnWidths, ColumnExtent, COLUMN_CAP_FRACTION, COLUMN_FLOOR_CH } from '../src/webview/columnWidths';
import { probeRows } from '../src/webview/columnLayout';

export interface Check {
  name: string;
  run: () => boolean;
}

/** A column, written the way the fixtures below read best. */
const col = (min: number, max: number): ColumnExtent => ({ min, max });

/** The shipped starting values, at a plausible 8px `ch`. */
const CH = 8;
const FLOOR = COLUMN_FLOOR_CH * CH;
const cap = (w: number): number => COLUMN_CAP_FRACTION * w;
const opts = (w: number, pinned?: ReadonlyMap<number, number>) => ({ floor: FLOOR, cap: cap(w), pinned });

/**
 * A table with the shape the ceiling exists for: four columns that are short
 * whatever happens, and one holding sentences.
 */
const MIXED: ColumnExtent[] = [
  col(40, 56), // a short code
  col(48, 90), // State
  col(48, 120), // Owner
  col(56, 160), // Updated
  col(64, 900), // Notes
];

/** A wide table: twelve columns, none of them long enough to be the one that gives. */
const WIDE: ColumnExtent[] = Array.from({ length: 12 }, (_, i) => col(40 + i, 90 + i * 30));

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const base = (cols: readonly ColumnExtent[]): number[] => cols.map((c) => Math.min(c.max, Math.max(c.min, FLOOR)));
const near = (a: number, b: number, slack = 1.5): boolean => Math.abs(a - b) <= slack;

export const columnWidthChecks: Check[] = [
  {
    name: 'a pane wider than the widest table fills with every column at its full width',
    run: () => {
      const cols = [col(40, 100), col(40, 200), col(40, 100)];
      const a = allocateColumnWidths(1000, cols, opts(1000));
      if (!a || a.rule !== 1 || a.scrolls) return false;
      return cols.every((c, i) => a.widths[i] >= c.max) && a.total === 1000;
    },
  },
  {
    name: 'the surplus in a wide pane is shared in proportion to how wide each column wants to be',
    run: () => {
      const a = allocateColumnWidths(800, [col(10, 100), col(10, 200)], opts(800));
      if (!a || a.rule !== 1) return false;
      // 300px wanted and 800px to hand out: each column ends at 800/300 of its own width.
      return near(a.widths[0], 800 / 3) && near(a.widths[1], 1600 / 3) && a.total === 800;
    },
  },
  {
    name: 'a short column keeps its full width while the column holding sentences gives up the space',
    run: () => {
      const a = allocateColumnWidths(1100, MIXED, opts(1100));
      if (!a || a.rule !== 2) return false;
      // The four short columns are under the ceiling, so none of them gives anything.
      const shortKept = [0, 1, 2, 3].every((i) => a.widths[i] === MIXED[i].max);
      // Notes is the only column that was asked, and it is the only one that wrapped.
      return shortKept && a.widths[4] < MIXED[4].max && !a.scrolls && a.total === 1100;
    },
  },
  {
    name: 'what the ceiling holds back goes to the columns it held, and the table still fills the pane',
    run: () => {
      const a = allocateColumnWidths(1100, MIXED, opts(1100));
      // Nothing else is above the ceiling, so all 179px left over land on Notes.
      return !!a && a.rule === 2 && a.widths[4] > cap(1100) && a.total === 1100;
    },
  },
  {
    name: 'giving that space back never makes a column wider than it asked to be',
    run: () => {
      // The trap: sharing what is left over in proportion to how wide each column
      // wants to be would push the narrower of the two held columns past its own
      // content and pad it with whitespace.
      const cols = [col(20, 101), col(20, 4000)];
      const a = allocateColumnWidths(500, cols, { floor: FLOOR, cap: 100 });
      if (!a || a.rule !== 2) return false;
      return a.widths[0] <= cols[0].max && a.total === 500;
    },
  },
  {
    name: 'the ceiling never takes a column under its own minimum, and the table scrolls instead',
    run: () => {
      // Two columns of long unbreakable text in a narrow pane. A ceiling applied
      // without regard for the minimum would hand each column less than its
      // longest word and then report that the table fits.
      const cols = [col(900, 2000), col(900, 2000)];
      const a = allocateColumnWidths(270, cols, opts(300));
      if (!a || a.rule !== 4 || !a.scrolls) return false;
      return a.widths[0] === 900 && a.widths[1] === 900;
    },
  },
  {
    name: 'a pane too narrow for the ceiling moves every column the same fraction toward its ceiling',
    run: () => {
      const cols = [col(40, 200), col(40, 400), col(40, 600)];
      const width = 700;
      const a = allocateColumnWidths(width, cols, opts(width));
      if (!a || a.rule !== 3) return false;
      const b = base(cols);
      // Toward the ceiling rather than toward the full width, so this rule lands exactly where
      // the ceiling's own rule starts and the two meet without a step.
      const cap = width * 0.45;
      const soft = cols.map((c, i) => Math.max(b[i], Math.min(c.max, cap)));
      const t = cols.map((c, i) => (a.widths[i] - b[i]) / (soft[i] - b[i]));
      return t.every((x) => near(x, t[0], 0.02)) && a.total === 700;
    },
  },
  {
    name: 'a column whose own minimum is above the floor is never taken below it',
    run: () => {
      // The third column holds one long unbroken word, so its minimum is wide;
      // squeezing it further could only break the word part-way through.
      const cols = [col(20, 300), col(20, 300), col(220, 400)];
      return [300, 420, 560, 900].every((w) => {
        const a = allocateColumnWidths(w, cols, opts(w));
        return !!a && a.widths[2] >= cols[2].min - 1;
      });
    },
  },
  {
    name: 'a pane too narrow for the minimums leaves the table at its minimum and says it scrolls',
    run: () => {
      const a = allocateColumnWidths(200, MIXED, opts(200));
      if (!a || a.rule !== 4 || !a.scrolls) return false;
      const b = base(MIXED);
      return MIXED.every((_, i) => near(a.widths[i], b[i])) && a.total > 200;
    },
  },
  {
    name: 'a column narrower than the floor is left at its own width rather than widened to the floor',
    run: () => {
      // A tick-box column holding one character has nothing to gain from six.
      const cols = [col(14, 18), col(40, 900), col(40, 900)];
      // Wide enough to hold the ceiling, tight enough to interpolate, too tight for either.
      return [600, 240, 120, 100].every((w) => {
        const a = allocateColumnWidths(w, cols, opts(w));
        return !!a && a.rule !== 1 && a.widths[0] <= 19;
      });
    },
  },
  {
    name: 'widening the pane never makes a column narrower while the same rule is deciding',
    run: () => {
      let prev: { widths: number[]; rule: number } | null = null;
      for (let w = 240; w <= 2400; w++) {
        const a = allocateColumnWidths(w, MIXED, opts(w));
        if (!a) return false;
        if (prev && prev.rule === a.rule && a.widths.some((x, i) => x < prev!.widths[i] - 1)) return false;
        prev = a;
      }
      return true;
    },
  },
  {
    name: 'no column ever narrows as the pane widens, at any width',
    run: () => {
      // This is what interpolating toward the ceiling buys. Before it, there was exactly one
      // width where the short columns jumped to their full size and the column of sentences
      // dropped back by more than a hundred pixels in the same step, which is what a person
      // dragging the editor's edge would read as a fault. A pixel-by-pixel walk is the only
      // honest way to say there is no such width: sampling would have missed the one there was.
      for (const cols of [MIXED, WIDE]) {
        let prev: number[] | null = null;
        for (let w = 240; w <= 2400; w++) {
          const a = allocateColumnWidths(w, cols, opts(w));
          if (!a) return false;
          if (prev && a.widths.some((x, i) => x < prev![i] - 1)) return false;
          prev = a.widths;
        }
      }
      return true;
    },
  },
  {
    name: 'the table is exactly as wide as the pane until the minimums stop fitting, and wider after',
    run: () => {
      for (const cols of [MIXED, WIDE]) {
        for (let w = 200; w <= 2000; w += 20) {
          const a = allocateColumnWidths(w, cols, opts(w));
          if (!a) return false;
          if (a.rule === 4 ? !a.scrolls || a.total <= w : a.scrolls || a.total !== w) return false;
        }
      }
      return true;
    },
  },
  {
    name: 'the rules are taken in order as the pane narrows and never taken out of it',
    run: () => {
      const seen: number[] = [];
      for (let w = 3000; w >= 200; w -= 10) {
        const a = allocateColumnWidths(w, MIXED, opts(w));
        if (!a) return false;
        if (seen[seen.length - 1] !== a.rule) seen.push(a.rule);
      }
      return seen.join() === '1,2,3,4';
    },
  },
  {
    name: 'a table of twelve columns scrolls in a narrow pane instead of squeezing every column',
    run: () => {
      const a = allocateColumnWidths(320, WIDE, opts(320));
      if (!a || a.rule !== 4 || !a.scrolls) return false;
      // Every column is still at least a short word wide, and the frame carries the rest.
      return a.widths.every((x, i) => x >= Math.min(WIDE[i].max, FLOOR) - 1) && a.total > 320;
    },
  },
  {
    name: 'the same twelve columns fill a wide pane without scrolling',
    run: () => {
      const a = allocateColumnWidths(1100, WIDE, opts(1100));
      return !!a && !a.scrolls && a.total === 1100 && a.widths.every((x) => x >= FLOOR - 1);
    },
  },
  {
    name: 'a pinned column keeps the width it was given and the rest divide what is left',
    run: () => {
      const a = allocateColumnWidths(1100, MIXED, opts(1100, new Map([[2, 300]])));
      if (!a) return false;
      const free = a.widths.filter((_, i) => i !== 2);
      return a.widths[2] === 300 && near(sum(free), 800) && a.total === 1100;
    },
  },
  {
    name: 'a pinned column is held at its width whether that is wider or narrower than its content',
    run: () =>
      [30, 900].every((width) => {
        const a = allocateColumnWidths(1100, MIXED, opts(1100, new Map([[4, width]])));
        return !!a && a.widths[4] === width;
      }),
  },
  {
    name: 'pinned columns that fill the pane on their own leave the rest at their minimums, scrolling',
    run: () => {
      const a = allocateColumnWidths(400, MIXED, opts(400, new Map([[3, 200], [4, 260]])));
      if (!a || a.rule !== 4 || !a.scrolls) return false;
      return a.widths[3] === 200 && a.widths[4] === 260 && a.total > 400;
    },
  },
  {
    name: 'pinning every column lays the table out at exactly those widths',
    run: () => {
      const want = MIXED.map((_, i) => 100 + i * 10);
      const pinned = new Map(want.map((w, i) => [i, w] as [number, number]));
      const a = allocateColumnWidths(1100, MIXED, opts(1100, pinned));
      return !!a && a.widths.join() === want.join();
    },
  },
  {
    name: 'a pin naming a column that is not there is ignored rather than throwing',
    run: () => {
      const a = allocateColumnWidths(900, MIXED, opts(900, new Map([[99, 200], [-1, 50]])));
      return !!a && a.widths.length === MIXED.length && a.total === 900;
    },
  },
  {
    name: 'every width is a whole number of pixels and they add up to the width the table is laid out at',
    run: () => {
      for (let w = 213; w <= 1999; w += 37) {
        const a = allocateColumnWidths(w, MIXED, opts(w));
        if (!a) return false;
        if (a.widths.some((x) => !Number.isInteger(x) || x < 1)) return false;
        if (sum(a.widths) !== a.total) return false;
      }
      return true;
    },
  },
  {
    name: 'a pane with no width, or a table with no columns, allocates nothing at all',
    run: () => {
      const none = [
        allocateColumnWidths(0, MIXED, opts(600)),
        allocateColumnWidths(-10, MIXED, opts(600)),
        allocateColumnWidths(NaN, MIXED, opts(600)),
        allocateColumnWidths(600, [], opts(600)),
      ];
      return none.every((a) => a === null);
    },
  },
  {
    name: 'a measurement that came back incoherent still produces a usable layout',
    run: () => {
      // A minimum wider than the maximum, and widths that are not numbers at
      // all, are what a measurement taken while a picture was still loading
      // looks like.
      const cols = [col(200, 50), { min: NaN, max: NaN }, col(0, 0), col(40, 300)];
      const a = allocateColumnWidths(600, cols, opts(600));
      return !!a && a.widths.length === 4 && a.widths.every((x) => Number.isInteger(x) && x >= 1);
    },
  },
  {
    name: 'the shape of the answer at the three pane widths the starting numbers were picked against',
    run: () => {
      // 320 is a side panel, 600 a split editor, 1100 a maximised window. What
      // this pins down is the shape of the answer at each, not the pixels; the
      // numbers themselves are a guess until a real window says otherwise.
      const narrow = allocateColumnWidths(320, MIXED, opts(320));
      const middle = allocateColumnWidths(600, MIXED, opts(600));
      const wide = allocateColumnWidths(1100, MIXED, opts(1100));
      if (!narrow || !middle || !wide) return false;
      // Narrow and middle: it fits, and no column is under a short word.
      if (narrow.scrolls || middle.scrolls) return false;
      if (![narrow, middle].every((a) => a.widths.every((x, i) => x >= Math.min(MIXED[i].max, FLOOR) - 1))) return false;
      // Wide: the four short columns are whole and Notes has taken the rest.
      return wide.rule === 2 && [0, 1, 2, 3].every((i) => wide.widths[i] === MIXED[i].max);
    },
  },

  // ---- Which cells are worth drawing to measure a column ------------------
  //
  // Choosing them is arithmetic over the cell text and runs anywhere. Drawing
  // them, and reading a width back, needs a browser.

  {
    name: 'a long table is measured from a handful of cells rather than all of them',
    run: () => {
      const headers = Array.from({ length: 12 }, (_, c) => `Column ${c}`);
      const rows = Array.from({ length: 800 }, (_, r) => headers.map((_, c) => `r${r} c${c} ${'x'.repeat(r % 30)}`));
      const picked = probeRows({ headers, rows }, (s) => s.length);
      // Twelve columns' worth of candidates, six rows at the outside: the copy
      // is under a hundred cells where the table is nine thousand six hundred.
      return picked.length > 0 && picked.length <= 6 && picked.every((row) => row.length === 12);
    },
  },
  {
    name: 'the widest cell of each column is among the ones drawn',
    run: () => {
      const headers = ['A', 'B'];
      const rows = [['short', 'x'], ['a much longer cell than the others', 'y'], ['mid', 'z']];
      const picked = probeRows({ headers, rows }, (s) => s.length);
      return picked.some((row) => row[0] === 'a much longer cell than the others');
    },
  },
  {
    name: 'the cell holding a column’s longest word is drawn even when it is not the widest cell',
    run: () => {
      // The minimum a column can be squeezed to is its longest word, and the
      // cell holding that word is often nowhere near the widest cell.
      const long = 'https://example.com/a/very/long/unbroken/path/that/cannot/wrap';
      const headers = ['Notes'];
      const rows = [
        [long],
        ...Array.from({ length: 40 }, () => ['many short words in a row '.repeat(6)]),
      ];
      const picked = probeRows({ headers, rows }, (s) => s.length);
      return picked.some((row) => row[0] === long);
    },
  },
  {
    name: 'a column with nothing in it asks for nothing to be drawn',
    run: () => {
      const picked = probeRows({ headers: ['A', 'B'], rows: [['', 'x'], ['', 'y']] }, (s) => s.length);
      return picked.every((row) => row[0] === '') && picked.some((row) => row[1] !== '');
    },
  },
  {
    name: 'a table with no rows at all is still something the copy can be built from',
    run: () => probeRows({ headers: ['A', 'B'], rows: [] }, (s) => s.length).length === 0,
  },
];
