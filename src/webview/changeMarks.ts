/*
 * Marks on the lines something outside the editor just wrote.
 *
 * When an agent, a branch switch or another editor writes the open file, the host
 * pushes the new text in and the document on screen quietly becomes a different
 * document. These marks say where it changed: every line the write inserted or
 * rewrote gets a bar in the margin beside it and a faint tint, and a write that only
 * took lines away leaves a short tick where they were.
 *
 * The marks are view state and nothing else. They are never written anywhere, they
 * live as long as this editor does, and closing the document clears them. A second
 * write adds its lines to the ones already marked. Editing a marked line clears that
 * line's mark, because the person has now read and changed it; edits elsewhere
 * leave the marks alone.
 *
 * What changed is worked out here, by comparing the document's lines before and
 * after the write. The host sends the new text whole, and the change the editor
 * applies for it is one contiguous replacement from the first difference to the
 * last, which would take in every untouched line between two separate edits.
 */

import { EditorState, Extension, RangeSetBuilder, StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';

/**
 * What a marked line is marked for.
 *
 * - `changed`: the write inserted this line or rewrote it.
 * - `deletedAbove`: the write removed lines just above this one and put nothing in
 *   their place.
 * - `deletedBelow`: the same, for lines removed from the end of the document, where
 *   there is no line after the gap to carry the tick.
 */
export type ArrivedKind = 'changed' | 'deletedAbove' | 'deletedBelow';

/** One marked line: the position its line starts at, and why it is marked. */
export interface ArrivedMark {
  readonly pos: number;
  readonly kind: ArrivedKind;
}

/**
 * Put on the transaction that applies a write from outside the editor, and on no
 * other. The field compares the document before and after that transaction and
 * marks the lines that differ. The first document an editor opens with is not a
 * write, and is never marked.
 */
export const outsideWrite = StateEffect.define<null>();

/** Lines that differ by more than this many insertions and deletions are all marked. */
const MAX_EDIT_DISTANCE = 1000;

/**
 * The lines an outside write left in place, as a map from each old line to the
 * new line it became, or -1 where the old line did not survive.
 *
 * Lines are compared whole. The common run at each end is trimmed first, so a
 * write that touches one place in a long document costs one pass over it; the
 * middle is compared with Myers' algorithm, which finds the fewest insertions and
 * deletions. A middle so different that the fewest is still very large is treated
 * as rewritten through, which is what it reads as anyway.
 */
export function keptLines(before: readonly string[], after: readonly string[]): Int32Array {
  const kept = new Int32Array(before.length).fill(-1);
  let head = 0;
  const shorter = Math.min(before.length, after.length);
  while (head < shorter && before[head] === after[head]) {
    kept[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < shorter - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    kept[before.length - 1 - tail] = after.length - 1 - tail;
    tail++;
  }
  const oldMiddle = before.slice(head, before.length - tail);
  const newMiddle = after.slice(head, after.length - tail);
  if (oldMiddle.length === 0 || newMiddle.length === 0) return kept;
  // Lines as small numbers, so the inner loop compares integers.
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  };
  const a = Int32Array.from(oldMiddle, idOf);
  const b = Int32Array.from(newMiddle, idOf);
  const pairs = shortestEdit(a, b, MAX_EDIT_DISTANCE);
  if (pairs) {
    for (let p = 0; p < pairs.length; p += 2) kept[head + pairs[p]] = head + pairs[p + 1];
  }
  return kept;
}

/**
 * Myers' shortest edit script between `a` and `b`, as the flat list of index pairs
 * `[i, j, i, j, ...]` the two have in common, or null when more than `limit`
 * insertions and deletions separate them.
 */
function shortestEdit(a: Int32Array, b: Int32Array, limit: number): number[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let end = -1;
  outer: for (let d = 0; d <= Math.min(max, limit); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        end = d;
        break outer;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (end < 0) return null;
  const pairs: number[] = [];
  let x = n;
  let y = m;
  for (let d = end; d > 0; d--) {
    // trace[d - 1] holds k from -(d - 1) to d - 1, at index k + d - 1.
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push(x, y);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push(x, y);
  }
  return pairs;
}

function linesOf(doc: Text): string[] {
  return doc.toString().split('\n');
}

/** Whether `changes` touch any of the old document from `from` to `to`, ends included. */
function touches(tr: Transaction, from: number, to: number): boolean {
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= to && toA >= from) hit = true;
  });
  return hit;
}

/** Marks in document order, each line and kind once. */
function normalise(marks: ArrivedMark[]): readonly ArrivedMark[] {
  marks.sort((x, y) => x.pos - y.pos || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
  return marks.filter((mark, i) => i === 0 || mark.pos !== marks[i - 1].pos || mark.kind !== marks[i - 1].kind);
}

/** The marks after an outside write: the old ones on lines it kept, and its own. */
function afterWrite(marks: readonly ArrivedMark[], tr: Transaction): readonly ArrivedMark[] {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const before = linesOf(oldDoc);
  const after = linesOf(newDoc);
  const kept = keptLines(before, after);
  const next: ArrivedMark[] = [];

  // Marks from earlier writes follow their line if this write left it alone. A line
  // it rewrote is marked again below; a line it removed takes its mark with it.
  for (const mark of marks) {
    const j = kept[oldDoc.lineAt(mark.pos).number - 1];
    if (j >= 0) next.push({ pos: newDoc.line(j + 1).from, kind: mark.kind });
  }

  const survived = new Uint8Array(after.length);
  for (const j of kept) if (j >= 0) survived[j] = 1;
  for (let j = 0; j < after.length; j++) {
    if (!survived[j]) next.push({ pos: newDoc.line(j + 1).from, kind: 'changed' });
  }

  // A run of removed lines with nothing written in their place leaves a tick on the
  // line after the gap. Walked in old-line order, a gap is removed lines between two
  // kept ones whose new positions are adjacent.
  let lastNew = -1;
  let removed = false;
  for (let i = 0; i <= before.length; i++) {
    const j = i < before.length ? kept[i] : after.length;
    if (j < 0) {
      removed = true;
      continue;
    }
    if (removed && j === lastNew + 1) {
      // `j` is the line after the gap, counted from zero. Where that is past the end
      // of the document, or the empty line a final line break leaves there, the tick
      // goes under the last line with something on it before the gap instead.
      const finalEmpty = (at: number): boolean => at === after.length - 1 && after[at] === '' && at > 0;
      if (j >= after.length || finalEmpty(j)) {
        let before = j - 1;
        if (finalEmpty(before)) before--;
        next.push({ pos: newDoc.line(before + 1).from, kind: 'deletedBelow' });
      } else {
        next.push({ pos: newDoc.line(j + 1).from, kind: 'deletedAbove' });
      }
    }
    removed = false;
    lastNew = j;
  }
  return normalise(next);
}

/** The marks after an ordinary transaction: the person's own edit, or undo. */
function afterEdit(marks: readonly ArrivedMark[], tr: Transaction): readonly ArrivedMark[] {
  const oldDoc = tr.startState.doc;
  const remote = tr.annotation(Transaction.remote) === true;
  const next: ArrivedMark[] = [];
  for (const mark of marks) {
    const line = oldDoc.lineAt(mark.pos);
    // An edit on a marked line means the person has been there: the mark goes.
    if (!remote && touches(tr, line.from, line.to)) continue;
    // Mapped forward, so text put in at the start of the line, a new line above
    // it included, leaves the mark on the line it was on.
    const pos = tr.changes.mapPos(mark.pos, 1);
    next.push({ pos: tr.newDoc.lineAt(pos).from, kind: mark.kind });
  }
  return normalise(next);
}

/**
 * The lines marked as written from outside, in document order, by the position
 * each line starts at.
 *
 * Exported so that a surface drawing lines of its own can show the same marks. A
 * table is drawn by a widget that replaces its lines, so the line decorations
 * built from this field do not appear inside one; the grid can read this field and
 * mark its rows itself.
 */
export const arrivedLines = StateField.define<readonly ArrivedMark[]>({
  create: () => [],
  update(marks, tr) {
    if (tr.effects.some((effect) => effect.is(outsideWrite))) return afterWrite(marks, tr);
    if (!tr.docChanged || marks.length === 0) return marks;
    return afterEdit(marks, tr);
  },
});

const classFor: Record<ArrivedKind, string> = {
  changed: 'sheaf-arrived',
  deletedAbove: 'sheaf-arrived-deleted',
  deletedBelow: 'sheaf-arrived-deleted sheaf-arrived-deleted-below',
};

function decorate(state: EditorState): DecorationSet {
  const marks = state.field(arrivedLines);
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 0; i < marks.length; ) {
    const pos = marks[i].pos;
    const classes: string[] = [];
    while (i < marks.length && marks[i].pos === pos) classes.push(classFor[marks[i++].kind]);
    builder.add(pos, pos, Decoration.line({ class: classes.join(' ') }));
  }
  return builder.finish();
}

/** The field and the line decorations drawn from it. */
export function changeMarks(): Extension {
  return [arrivedLines, EditorView.decorations.compute([arrivedLines], decorate)];
}
