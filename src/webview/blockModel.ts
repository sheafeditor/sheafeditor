/*
 * The block model for prose: which construct encloses a position, which blocks are
 * its siblings, and the edits that move, duplicate, delete and convert blocks.
 *
 * A block is always a whole-line range. Moving blocks is a permutation of those
 * line ranges: the separator between two positions (usually a blank line) stays at
 * its position while the blocks trade places, so the file changes only in the lines
 * that moved. The one exception is a separator with no blank line that would let a
 * moved block run into its new neighbour (a paragraph landing directly above other
 * text, say); that seam gets a blank line, and only when a parse shows the merge.
 */

import { ChangeSet, EditorSelection, EditorState, StateEffect, StateField, Text, TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { isolateHistory } from '@codemirror/commands';
import type { SyntaxNode, Tree } from '@lezer/common';
import {
  clearHeading,
  toggleBullet,
  toggleCodeBlock,
  toggleHeading,
  toggleOrdered,
  toggleQuote,
  toggleTask,
} from './toolbar';

export type BlockKind = 'frontmatter' | 'heading' | 'paragraph' | 'list' | 'item' | 'code' | 'table' | 'quote' | 'rule' | 'html' | 'other';

/** A block's whole-line extent: `from` is its first line's start, `to` its last line's end. */
export interface BlockRange {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  kind: BlockKind;
  /**
   * False for position-dependent ranges, which no block operation may move,
   * duplicate or delete: front matter is only front matter on line 1. A setext
   * heading's underline is never a range on its own; it is always part of its heading.
   */
  movable: boolean;
}

interface Unit extends BlockRange {
  node: SyntaxNode | null;
}

interface Level {
  siblings: Unit[];
  index: number;
  ordered: boolean;
  /** True for the document's top-level blocks, false for the items of a list. */
  top: boolean;
}

/** A run of adjacent siblings, `i` to `j` inclusive, at one level. */
interface Group {
  siblings: Unit[];
  i: number;
  j: number;
  ordered: boolean;
  top: boolean;
  depth: number;
  chain: Level[];
}

function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

/** The line number closing YAML front matter that opens the document, or 0 when there is none. */
function frontMatterEnd(doc: Text): number {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== '---' || doc.line(2).text.trim() === '') return 0;
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === '---' || t === '...') return n;
  }
  return 0;
}

function unitFor(doc: Text, from: number, to: number, kind: BlockKind, node: SyntaxNode | null): Unit {
  const first = doc.lineAt(from);
  const last = doc.lineAt(Math.max(from, to - 1));
  return { from: first.from, to: last.to, startLine: first.number, endLine: last.number, kind, movable: kind !== 'frontmatter', node };
}

function kindOf(node: SyntaxNode, doc: Text): BlockKind {
  const name = node.name;
  if (/Heading\d$/.test(name)) return 'heading';
  if (name === 'Paragraph') return 'paragraph';
  if (name === 'BulletList' || name === 'OrderedList') return 'list';
  if (name === 'Table') return 'table';
  if (name === 'Blockquote') return 'quote';
  if (name === 'HorizontalRule') return 'rule';
  if (name === 'HTMLBlock' || name === 'CommentBlock') return 'html';
  if (name === 'FencedCode') {
    const info = /^\s*(?:`{3,}|~{3,})\s*([\w-]*)/.exec(doc.sliceString(node.from, Math.min(node.to, doc.lineAt(node.from).to)));
    return info && /^(csv|tsv)$/i.test(info[1]) ? 'table' : 'code';
  }
  if (name === 'CodeBlock') return 'code';
  return 'other';
}

function topUnits(state: EditorState): Unit[] {
  const doc = state.doc;
  const fm = frontMatterEnd(doc);
  const units: Unit[] = [];
  if (fm) units.push(unitFor(doc, 0, doc.line(fm).to, 'frontmatter', null));
  for (let c = fullTree(state).topNode.firstChild; c; c = c.nextSibling) {
    if (doc.lineAt(c.from).number <= fm) continue;
    const unit = unitFor(doc, c.from, c.to, kindOf(c, doc), c);
    const last = units[units.length - 1];
    if (last && unit.startLine <= last.endLine) {
      // Two constructs sharing a line cannot be separated, so they are one block.
      units[units.length - 1] = { ...last, to: Math.max(last.to, unit.to), endLine: Math.max(last.endLine, unit.endLine), kind: 'other' };
      continue;
    }
    units.push(unit);
  }
  return units;
}

function itemsOf(list: SyntaxNode, doc: Text): Unit[] {
  const items: Unit[] = [];
  for (let c = list.firstChild; c; c = c.nextSibling) {
    if (c.name === 'ListItem') items.push(unitFor(doc, c.from, c.to, 'item', c));
  }
  return items;
}

/** The levels enclosing `line`, from the document's top-level blocks down to the innermost list item. */
function levelsAt(state: EditorState, line: number): Level[] {
  const doc = state.doc;
  const units = topUnits(state);
  const index = units.findIndex((u) => u.startLine <= line && line <= u.endLine);
  if (index < 0) return [];
  const chain: Level[] = [{ siblings: units, index, ordered: false, top: true }];
  let list: SyntaxNode | null = units[index].kind === 'list' ? units[index].node : null;
  while (list) {
    const items = itemsOf(list, doc);
    const j = items.findIndex((u) => u.startLine <= line && line <= u.endLine);
    if (j < 0) break;
    chain.push({ siblings: items, index: j, ordered: list.name === 'OrderedList', top: false });
    const item = items[j].node!;
    list = null;
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if ((c.name === 'BulletList' || c.name === 'OrderedList') && doc.lineAt(c.from).number <= line && line <= doc.lineAt(Math.max(c.from, c.to - 1)).number) {
        list = c;
      }
    }
  }
  return chain;
}

const publicRange = (u: Unit): BlockRange => ({ from: u.from, to: u.to, startLine: u.startLine, endLine: u.endLine, kind: u.kind, movable: u.movable });

/**
 * The enclosing block at `pos`: a list item (with its nested children) when the
 * line is in a list, otherwise the top-level construct, whole: a paragraph, a
 * heading, a fenced block with its fences, a table, a quote or callout with its
 * continuation lines, or the front matter. Null on a blank line between blocks.
 */
export function blockRangeAt(state: EditorState, pos: number): BlockRange | null {
  const chain = levelsAt(state, state.doc.lineAt(pos).number);
  if (!chain.length) return null;
  const last = chain[chain.length - 1];
  return publicRange(last.siblings[last.index]);
}

/** The innermost level at which some sibling starts at `from` and a later one ends at `to`. */
function groupFor(state: EditorState, from: number, to: number): Group | null {
  const chain = levelsAt(state, state.doc.lineAt(from).number);
  for (let depth = chain.length - 1; depth >= 0; depth--) {
    const level = chain[depth];
    const i = level.siblings.findIndex((u) => u.from === from);
    const j = level.siblings.findIndex((u) => u.to === to);
    if (i >= 0 && j >= i) return { siblings: level.siblings, i, j, ordered: level.ordered, top: level.top, depth, chain };
  }
  return null;
}

/** The parent block of a group: the list item or list that holds it, or null at the top level. */
function parentOf(group: Group): Unit | null {
  if (group.depth === 0) return null;
  const up = group.chain[group.depth - 1];
  return up.siblings[up.index];
}

// ---- Structure checks -------------------------------------------------------

/** Top-level blocks plus list items: a merge between neighbours lowers this count. */
function structureCount(state: EditorState, text: string): number {
  const parser = state.facet(language)?.parser ?? markdownLanguage.parser;
  const tree = parser.parse(text);
  let count = 0;
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) count++;
  tree.iterate({ enter: (n) => void (n.name === 'ListItem' && count++) });
  return count;
}

const hasBlankLine = (gap: string): boolean => /\n[ \t]*\n/.test(gap);

// ---- List item columns --------------------------------------------------------

/** The column `ws` ends at when it starts at column `start`, with tab stops every 4 columns. */
function columnAfter(ws: string, start = 0): number {
  let col = start;
  for (const ch of ws) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

/**
 * The column where the content of the list item opened on `line` starts, or null
 * when the line opens no list item. A task's checkbox is item content, so it does
 * not count; five or more spaces after the marker start indented code one column in.
 */
function listContentColumn(line: string): number | null {
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)(.?)/.exec(line);
  if (!m) return null;
  const markEnd = columnAfter(m[1]) + m[2].length;
  if (!m[4]) return markEnd + 1;
  if (!m[3]) return null;
  const gap = columnAfter(m[3], markEnd) - markEnd;
  return gap > 4 ? markEnd + 1 : markEnd + gap;
}

const firstLine = (text: string): string => text.split('\n', 1)[0];

/**
 * An item's source with the lines after its first shifted by the change from
 * `oldColumn` to `newColumn`, so nested items and continuation paragraphs stay
 * inside the item when its marker changes width. Blank lines and lazy continuation
 * lines (indented less than the old content column) keep their bytes, as does a
 * line whose indentation has too few trailing spaces to shrink.
 */
function shiftItemBody(text: string, oldColumn: number, newColumn: number): string {
  const delta = newColumn - oldColumn;
  if (!delta) return text;
  const lines = text.split('\n');
  for (let n = 1; n < lines.length; n++) {
    const lead = /^[ \t]*/.exec(lines[n])![0];
    if (lead.length === lines[n].length || columnAfter(lead) < oldColumn) continue;
    const rest = lines[n].slice(lead.length);
    if (delta > 0) lines[n] = lead + ' '.repeat(delta) + rest;
    else if (/ *$/.exec(lead)![0].length >= -delta) lines[n] = lead.slice(0, lead.length + delta) + rest;
  }
  return lines.join('\n');
}

/** `after` (an edit of item source `before`'s first line) with its body re-indented to follow the marker's new width. */
function followMarkerWidth(before: string, after: string): string {
  const oldColumn = listContentColumn(firstLine(before));
  const newColumn = listContentColumn(firstLine(after));
  return oldColumn === null || newColumn === null ? after : shiftItemBody(after, oldColumn, newColumn);
}

// ---- Move -------------------------------------------------------------------

const ORDINAL_RE = /^(\s*(?:>\s?)*)(\d+)([.)])/;

interface Arranged {
  from: number;
  to: number;
  insert: string;
  /** Where the moved group starts and ends in the new document. */
  groupFrom: number;
  groupTo: number;
}

/**
 * Move siblings `i..j` so they sit before sibling `t` (or after the last when `t`
 * is the sibling count). Null when that leaves the order unchanged, when a block in
 * the way is immovable, or when the target is the front matter's slot.
 */
function canArrange(g: Group, t: number): boolean {
  const { siblings: s, i, j } = g;
  if (t < 0 || t > s.length || (t >= i && t <= j + 1)) return false;
  for (let k = i; k <= j; k++) if (!s[k].movable) return false;
  return s[0].movable || t !== 0;
}

function arrange(state: EditorState, g: Group, t: number): Arranged | null {
  if (!canArrange(g, t)) return null;
  const { siblings: s, i, j } = g;
  const n = s.length;
  const doc = state.doc;
  const order = s.map((_, k) => k);
  const moved = order.splice(i, j - i + 1);
  order.splice(t > j ? t - moved.length : t, 0, ...moved);
  const k0 = Math.min(i, t);
  const k1 = Math.max(j, t - 1);
  const a = Math.max(0, k0 - 1);
  const b = Math.min(n - 1, k1 + 1);
  const gaps: string[] = [];
  for (let k = a; k < b; k++) gaps.push(doc.sliceString(s[k].to, s[k + 1].from));

  // An ordered list keeps its numbers in place: the first line of each moved item
  // takes the number of the slot it lands in, so a list still starts where it did.
  // A number with a different digit count moves the item's content column, so the
  // item's continuation and nested lines shift with it and stay inside the item.
  const texts = s.map((u) => doc.sliceString(u.from, u.to));
  if (g.ordered) {
    const nums = texts.slice(a, b + 1).map((x) => ORDINAL_RE.exec(x)?.[2] ?? null);
    if (nums.every((x) => x !== null)) {
      const renumbered = new Map<number, string>();
      for (let p = a; p <= b; p++) {
        const src = order[p];
        const text = texts[src].replace(ORDINAL_RE, (_m, lead: string, _num: string, delim: string) => lead + nums[p - a] + delim);
        renumbered.set(src, followMarkerWidth(texts[src], text));
      }
      for (const [src, text] of renumbered) texts[src] = text;
    }
  }

  /** Build the region, giving a blank line to each new seam without one for which `needsBlank(upper, gap, lower)` holds. */
  const build = (needsBlank: (upper: number, gap: string, lower: number) => boolean): Arranged => {
    let insert = '';
    let groupFrom = 0;
    let groupTo = 0;
    for (let p = a; p <= b; p++) {
      const src = order[p];
      if (src === i) groupFrom = insert.length;
      insert += texts[src];
      if (src === j) groupTo = insert.length;
      if (p < b) {
        let gap = gaps[p - a];
        const changed = order[p] !== p || order[p + 1] !== p + 1;
        if (changed && !hasBlankLine(gap) && needsBlank(src, gap, order[p + 1])) gap = '\n' + gap;
        insert += gap;
      }
    }
    const from = s[a].from;
    return { from, to: s[b].to, insert, groupFrom: from + groupFrom, groupTo: from + groupTo };
  };

  const plain = build(() => false);
  if (!g.top) return plain;
  const before = structureCount(state, doc.toString());
  const apply = (r: Arranged): string => doc.sliceString(0, r.from) + r.insert + doc.sliceString(r.to);
  if (structureCount(state, apply(plain)) === before) return plain;
  // A seam needs a blank line only where the two blocks meeting across it parse as
  // fewer blocks together than apart (a paragraph running on into the text below).
  // Every other seam keeps its separator as written.
  const joins = (upper: number, gap: string, lower: number): boolean =>
    structureCount(state, texts[upper] + gap + texts[lower]) < structureCount(state, texts[upper]) + structureCount(state, texts[lower]);
  const seamFixed = build(joins);
  if (structureCount(state, apply(seamFixed)) === before) return seamFixed;
  const allFixed = build(() => true);
  return structureCount(state, apply(allFixed)) === before ? allFixed : plain;
}

// ---- Block selection --------------------------------------------------------

export interface BlockSpan {
  from: number;
  to: number;
}

export interface BlockSelection {
  anchor: BlockSpan;
  head: BlockSpan;
}

export const setBlockSelection = StateEffect.define<BlockSelection | null>();

const spanOf = (b: BlockSelection): BlockSpan => ({ from: Math.min(b.anchor.from, b.head.from), to: Math.max(b.anchor.to, b.head.to) });

const blockSelectionLine = Decoration.line({ class: 'sheaf-block-selected' });

/**
 * Block selection mode. The editor's selection spans the selected blocks' lines, so
 * copy and the other selection commands keep working; this field remembers which
 * blocks those are and ends as soon as the selection stops matching them.
 */
export const blockSelectionField = StateField.define<BlockSelection | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlockSelection)) return e.value;
    if (!value) return null;
    if (tr.docChanged) {
      const map = (x: BlockSpan): BlockSpan => ({ from: tr.changes.mapPos(x.from, 1), to: tr.changes.mapPos(x.to, -1) });
      value = { anchor: map(value.anchor), head: map(value.head) };
    }
    const span = spanOf(value);
    const sel = tr.state.selection;
    if (sel.ranges.length !== 1 || sel.main.from !== span.from || sel.main.to !== span.to || span.from >= span.to) return null;
    return value;
  },
  provide: (f) => [
    EditorView.decorations.compute([f], (state) => {
      const value = state.field(f);
      if (!value) return Decoration.none;
      const span = spanOf(value);
      const lines = [];
      for (let n = state.doc.lineAt(span.from).number; n <= state.doc.lineAt(span.to).number; n++) {
        lines.push(blockSelectionLine.range(state.doc.line(n).from));
      }
      return Decoration.set(lines);
    }),
    EditorView.editorAttributes.compute([f], (state): Record<string, string> => (state.field(f) ? { class: 'sheaf-block-mode' } : {})),
  ],
});

/** The selected blocks' span, or null outside block selection mode. */
export function blockSelectionOf(state: EditorState): BlockSpan | null {
  const value = state.field(blockSelectionField, false);
  return value ? spanOf(value) : null;
}

/** A transaction that selects `anchor..head` as blocks. */
function selectBlocksSpec(anchor: BlockSpan, head: BlockSpan): TransactionSpec {
  const span = spanOf({ anchor, head });
  const forward = head.from >= anchor.from;
  return {
    selection: forward ? EditorSelection.single(span.from, span.to) : EditorSelection.single(span.to, span.from),
    effects: setBlockSelection.of({ anchor, head }),
    scrollIntoView: true,
  };
}

/** Enter block selection mode on the block at `pos`. False on a blank line. */
export function selectBlockAt(view: EditorView, pos: number): boolean {
  const range = blockRangeAt(view.state, pos);
  if (!range) return false;
  view.dispatch(selectBlocksSpec(range, range));
  return true;
}

/** The group the block commands act on: the block selection, or the caret's block. */
function currentGroup(state: EditorState): Group | null {
  const span = blockSelectionOf(state);
  if (span) return groupFor(state, span.from, span.to);
  const range = blockRangeAt(state, state.selection.main.head);
  return range ? groupFor(state, range.from, range.to) : null;
}

function groupForRange(state: EditorState, range: BlockSpan): Group | null {
  const span = blockSelectionOf(state);
  // A handle inside the block selection acts on every selected block.
  if (span && range.from >= span.from && range.to <= span.to) return groupFor(state, span.from, span.to);
  return groupFor(state, range.from, range.to);
}

/** Selection for the edit: the moved group as blocks in block mode, else the caret shifted with its block. */
function followSelection(state: EditorState, g: Group, groupFrom: number, groupTo: number): TransactionSpec {
  if (blockSelectionOf(state)) {
    const newSpan = { from: groupFrom, to: groupTo };
    return { selection: EditorSelection.single(groupFrom, groupTo), effects: setBlockSelection.of({ anchor: newSpan, head: newSpan }) };
  }
  const head = state.selection.main.head;
  const offset = Math.max(0, Math.min(head - g.siblings[g.i].from, groupTo - groupFrom));
  return { selection: EditorSelection.cursor(groupFrom + offset) };
}

function moveSpec(state: EditorState, g: Group, t: number): TransactionSpec | null {
  const r = arrange(state, g, t);
  if (!r) return null;
  // The replacement spans the whole region, so work out where the group lands in
  // the new document from the region's start rather than by mapping positions.
  return {
    changes: { from: r.from, to: r.to, insert: r.insert },
    ...followSelection(state, g, r.groupFrom, r.groupTo),
    scrollIntoView: true,
    userEvent: 'move.block',
  };
}

/** Move the selected blocks, or the caret's block, one sibling up (-1) or down (1). */
export function moveBlock(view: EditorView, dir: -1 | 1): boolean {
  const g = currentGroup(view.state);
  if (!g) return false;
  const spec = moveSpec(view.state, g, dir < 0 ? g.i - 1 : g.j + 2);
  if (spec) view.dispatch(spec);
  return true;
}

/**
 * The sibling list a dragged range reorders within, and the drop indices it may take.
 * `indices` includes the dragged blocks' own place: the gap directly above them and
 * the gap directly below, listed in `home`. Dropping there changes nothing, and
 * offering it means a pointer let go over the blocks themselves finds their own
 * place nearest instead of the closest gap that would move them.
 */
export function blockDropTargets(
  state: EditorState,
  range: BlockSpan
): { siblings: BlockRange[]; indices: number[]; home: number[] } | null {
  const g = groupForRange(state, range);
  if (!g) return null;
  const movable = g.siblings.slice(g.i, g.j + 1).every((u) => u.movable);
  const home = movable ? [g.i, g.j + 1] : [];
  const indices: number[] = [];
  for (let t = 0; t <= g.siblings.length; t++) if (canArrange(g, t) || home.includes(t)) indices.push(t);
  return { siblings: g.siblings.map(publicRange), indices, home };
}

/** The edit that drops `range` (or the block selection holding it) before sibling `index`. */
export function moveBlockTo(state: EditorState, range: BlockSpan, index: number): TransactionSpec | null {
  const g = groupForRange(state, range);
  return g ? moveSpec(state, g, index) : null;
}

/** The drop index whose indicator position is closest to the pointer's `y`. */
export function nearestDropIndex(targets: { index: number; y: number }[], y: number): number | null {
  let best: { index: number; y: number } | null = null;
  for (const t of targets) if (!best || Math.abs(t.y - y) < Math.abs(best.y - y)) best = t;
  return best ? best.index : null;
}

// ---- Duplicate and delete ---------------------------------------------------

function duplicateSpec(state: EditorState, g: Group): TransactionSpec | null {
  const { siblings: s, i, j } = g;
  for (let k = i; k <= j; k++) if (!s[k].movable) return null;
  const doc = state.doc;
  const text = doc.sliceString(s[i].from, s[j].to);
  let sep = j < s.length - 1 ? doc.sliceString(s[j].to, s[j + 1].from) : i > 0 ? doc.sliceString(s[i - 1].to, s[i].from) : g.top ? '\n\n' : '\n';
  const at = s[j].to;
  if (g.top && !hasBlankLine(sep)) {
    const before = structureCount(state, doc.toString());
    const withSep = (x: string): string => doc.sliceString(0, at) + x + text + doc.sliceString(at);
    const added = structureCount(state, text);
    if (structureCount(state, withSep(sep)) !== before + added) sep = '\n\n';
  }
  const copyFrom = at + sep.length;
  return {
    changes: { from: at, insert: sep + text },
    ...followSelection(state, g, copyFrom, copyFrom + text.length),
    scrollIntoView: true,
    userEvent: 'input.duplicate.block',
  };
}

function deleteSpec(state: EditorState, g: Group): TransactionSpec | null {
  const { siblings: s, i, j } = g;
  for (let k = i; k <= j; k++) if (!s[k].movable) return null;
  const doc = state.doc;
  const lead = i > 0 ? doc.sliceString(s[i - 1].to, s[i].from) : null;
  const trail = j < s.length - 1 ? doc.sliceString(s[j].to, s[j + 1].from) : null;
  let from: number;
  let to: number;
  let insert = '';
  let caret: number;
  if (lead !== null && trail !== null) {
    // Keep the larger separator between the neighbours that are left.
    from = s[i - 1].to;
    to = s[j + 1].from;
    insert = trail.length >= lead.length ? trail : lead;
    if (g.top && !hasBlankLine(insert)) {
      const before = structureCount(state, doc.toString());
      const removed = structureCount(state, doc.sliceString(s[i].from, s[j].to));
      const result = (x: string): string => doc.sliceString(0, from) + x + doc.sliceString(to);
      if (structureCount(state, result(insert)) !== before - removed) insert = '\n\n';
    }
    caret = from + insert.length;
  } else if (trail !== null) {
    from = s[i].from;
    to = s[j + 1].from;
    caret = from;
  } else if (lead !== null) {
    from = s[i - 1].to;
    to = s[j].to;
    caret = from;
  } else {
    from = s[i].from;
    to = s[j].to;
    if (to < doc.length) to++;
    else if (from > 0) from--;
    caret = from;
  }
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(caret),
    effects: setBlockSelection.of(null),
    scrollIntoView: true,
    userEvent: 'delete.block',
    annotations: isolateHistory.of('before'),
  };
}

/** Duplicate the selected blocks, or the caret's block, directly after the original. */
export function duplicateBlock(view: EditorView): boolean {
  const g = currentGroup(view.state);
  const spec = g && duplicateSpec(view.state, g);
  if (spec) view.dispatch(spec);
  return !!g;
}

/** Delete the selected blocks, or the caret's block, with one of their separators. */
export function deleteBlock(view: EditorView): boolean {
  const g = currentGroup(view.state);
  const spec = g && deleteSpec(view.state, g);
  if (spec) view.dispatch(spec);
  return !!g;
}

/** Move `range` (or the block selection holding it) one sibling up or down. */
export function moveRange(view: EditorView, range: BlockSpan, dir: -1 | 1): boolean {
  const g = groupForRange(view.state, range);
  const spec = g && moveSpec(view.state, g, dir < 0 ? g.i - 1 : g.j + 2);
  if (spec) view.dispatch(spec);
  return !!spec;
}

/** True when `range` can move one sibling in `dir`. */
export function canMoveRange(state: EditorState, range: BlockSpan, dir: -1 | 1): boolean {
  const g = groupForRange(state, range);
  return !!g && !!arrange(state, g, dir < 0 ? g.i - 1 : g.j + 2);
}

export function duplicateRange(view: EditorView, range: BlockSpan): boolean {
  const g = groupForRange(view.state, range);
  const spec = g && duplicateSpec(view.state, g);
  if (spec) view.dispatch(spec);
  return !!spec;
}

export function deleteRange(view: EditorView, range: BlockSpan): boolean {
  const g = groupForRange(view.state, range);
  const spec = g && deleteSpec(view.state, g);
  if (spec) view.dispatch(spec);
  return !!spec;
}

// ---- Navigation in block selection mode --------------------------------------

/** The block after (dir 1) or before (dir -1) `unit` in reading order, children included. */
function adjacentBlock(state: EditorState, unit: BlockRange, dir: -1 | 1): BlockRange | null {
  const doc = state.doc;
  if (dir > 0) {
    for (let n = unit.startLine + 1; n <= doc.lines; n++) {
      const r = blockRangeAt(state, doc.line(n).from);
      if (r && r.startLine > unit.startLine) return r;
    }
  } else {
    for (let n = unit.startLine - 1; n >= 1; n--) {
      const r = blockRangeAt(state, doc.line(n).from);
      if (r && r.startLine < unit.startLine) return r;
    }
  }
  return null;
}

/**
 * Arrow keys in block selection mode. Without `extend` the selection moves to the
 * block above or below. With `extend` it grows or shrinks by whole sibling blocks,
 * and past the first or last sibling it takes in the parent item or list.
 */
export function navigateBlocks(view: EditorView, dir: -1 | 1, extend: boolean): boolean {
  const { state } = view;
  const value = state.field(blockSelectionField, false);
  if (!value) return false;
  if (!extend) {
    const span = spanOf(value);
    const edge = blockRangeAt(state, dir > 0 ? value.head.from >= value.anchor.from ? value.head.from : value.anchor.from : span.from);
    const next = edge && adjacentBlock(state, edge, dir);
    if (next) view.dispatch(selectBlocksSpec(next, next));
    return true;
  }
  const g = groupFor(state, spanOf(value).from, spanOf(value).to);
  if (!g) return true;
  const s = g.siblings;
  const anchorIndex = s.findIndex((u) => u.from === value.anchor.from && u.to === value.anchor.to);
  const headIndex = s.findIndex((u) => u.from === value.head.from && u.to === value.head.to);
  if (anchorIndex < 0 || headIndex < 0) return true;
  const target = headIndex + dir;
  if (target >= 0 && target < s.length) {
    view.dispatch(selectBlocksSpec(s[anchorIndex], s[target]));
    return true;
  }
  const parent = parentOf(g);
  if (parent) view.dispatch(selectBlocksSpec(parent, parent));
  return true;
}

/** Leave block selection mode with a caret at the end of the head block. */
export function exitBlockSelection(view: EditorView): boolean {
  const value = view.state.field(blockSelectionField, false);
  if (!value) return false;
  view.dispatch({ selection: EditorSelection.cursor(value.head.to), effects: setBlockSelection.of(null), scrollIntoView: true });
  return true;
}

// ---- Turn into ----------------------------------------------------------------

export type TurnIntoKind = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';

export const TURN_INTO: { kind: TurnIntoKind; label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'h1', label: 'Heading 1' },
  { kind: 'h2', label: 'Heading 2' },
  { kind: 'h3', label: 'Heading 3' },
  { kind: 'bullet', label: 'Bullet list' },
  { kind: 'ordered', label: 'Numbered list' },
  { kind: 'task', label: 'Task list' },
  { kind: 'quote', label: 'Quote' },
  { kind: 'code', label: 'Code block' },
];

const CONVERTIBLE: BlockKind[] = ['paragraph', 'heading', 'item', 'quote', 'code'];

/** True when the handle menu offers Turn into for a block of this kind. */
export function canTurnInto(kind: BlockKind | null): boolean {
  return kind === null || CONVERTIBLE.includes(kind);
}

const LIST_MARK_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

/** What a block's source currently is, in Turn into terms. */
export function currentTurnInto(text: string, kind: BlockKind | null): TurnIntoKind {
  const first = text.split('\n')[0];
  if (kind === 'code') return 'code';
  const atx = /^\s{0,3}(#{1,6})[ \t]/.exec(first);
  if (atx) return atx[1].length === 1 ? 'h1' : atx[1].length === 2 ? 'h2' : atx[1].length === 3 ? 'h3' : 'text';
  if (/^\s{0,3}>/.test(first)) return 'quote';
  if (/^\s*[-*+][ \t]+\[[ xX]\][ \t]/.test(first)) return 'task';
  if (/^\s*[-*+][ \t]/.test(first)) return 'bullet';
  if (/^\s*\d+[.)][ \t]/.test(first)) return 'ordered';
  return 'text';
}

/** A block's source with its block markup removed, keeping the words. */
function stripToText(text: string, kind: BlockKind | null): string {
  let lines = text.split('\n');
  if (kind === 'code' && lines.length >= 2 && /^\s*(`{3,}|~{3,})/.test(lines[0])) {
    const closes = /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]);
    lines = lines.slice(1, closes ? -1 : undefined);
    return lines.join('\n');
  }
  if (kind === 'heading' && lines.length === 2 && /^\s{0,3}(=+|-+)\s*$/.test(lines[1])) return lines[0];
  if (lines.every((l) => /^\s{0,3}>/.test(l) || l.trim() === '')) lines = lines.map((l) => l.replace(/^\s{0,3}>[ \t]?/, ''));
  lines[0] = lines[0].replace(/^\s{0,3}#{1,6}(?:[ \t]+|$)/, '').replace(LIST_MARK_RE, '$1');
  return lines.join('\n');
}

/**
 * Run toolbar commands against a detached editor holding `text` alone, so a
 * conversion uses exactly the toolbar's rules and lands as one edit.
 */
function runOnText(text: string, caret: number, steps: ((v: EditorView) => void)[]): { text: string; caret: number } {
  const view = new EditorView({
    state: EditorState.create({ doc: text, selection: { anchor: Math.min(caret, text.length) }, extensions: [markdown({ base: markdownLanguage })] }),
  });
  try {
    for (const step of steps) step(view);
    return { text: view.state.doc.toString(), caret: view.state.selection.main.head };
  } finally {
    view.destroy();
  }
}

const selectAll = (v: EditorView): void => v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
const selectFirstLine = (v: EditorView): void => v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(1).to } });

/** The new source for `text` (a `kind` block) turned into `into`, and where the caret goes. */
export function convertText(text: string, kind: BlockKind | null, into: TurnIntoKind, caret: number): { text: string; caret: number } | null {
  if (currentTurnInto(text, kind) === into && !(into === 'text' && kind === 'heading')) return null;
  let plain = stripToText(text, kind);
  const atEnd = caret >= text.split('\n')[0].length;
  const steps: ((v: EditorView) => void)[] = [];
  switch (into) {
    case 'text':
      steps.push(selectAll, clearHeading);
      break;
    case 'h1':
    case 'h2':
    case 'h3':
      // A heading is one line, so a paragraph's lines join into it.
      if (kind === 'paragraph' || kind === 'heading' || kind === null) plain = plain.split('\n').map((l) => l.trim()).join(' ');
      steps.push(selectFirstLine, (v) => toggleHeading(v, Number(into[1])));
      break;
    case 'bullet':
      steps.push(selectFirstLine, toggleBullet);
      break;
    case 'ordered':
      steps.push(selectFirstLine, toggleOrdered);
      break;
    case 'task':
      steps.push(selectFirstLine, toggleTask);
      break;
    case 'quote':
      steps.push(selectAll, toggleQuote);
      break;
    case 'code':
      steps.push((v) => v.dispatch({ selection: plain.trim() === '' ? { anchor: 0 } : { anchor: 0, head: v.state.doc.length } }), toggleCodeBlock);
      break;
  }
  const out = runOnText(plain, 0, steps);
  // A list item that changes marker width moves its content column, so its nested
  // lines move with it; otherwise they would fall out of the item.
  out.text = followMarkerWidth(text, out.text);
  if (out.text === text) return null;
  const firstLineEnd = out.text.split('\n')[0].length;
  return { text: out.text, caret: into === 'code' && plain.trim() === '' ? out.caret : atEnd ? firstLineEnd : Math.min(caret, out.text.length) };
}

/** The smallest change turning `oldText` at `at` into `newText`. */
function minimalChange(at: number, oldText: string, newText: string): { from: number; to: number; insert: string } {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: at + start, to: at + endOld, insert: newText.slice(start, endNew) };
}

/** The line range a conversion at `pos` acts on: its block, or the bare line when it has none. */
export function convertibleRangeAt(state: EditorState, pos: number): { from: number; to: number; kind: BlockKind | null } {
  const range = blockRangeAt(state, pos);
  if (range) return range;
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to, kind: null };
}

/** Turn the block at `range` into another kind, as one edit. */
export function turnRangeInto(view: EditorView, range: { from: number; to: number; kind: BlockKind | null }, into: TurnIntoKind): boolean {
  const { state } = view;
  const text = state.doc.sliceString(range.from, range.to);
  const out = convertText(text, range.kind, into, 0);
  if (!out) return false;
  const inBlockMode = !!blockSelectionOf(state);
  const change = minimalChange(range.from, text, out.text);
  const newSpan = { from: range.from, to: range.from + out.text.length };
  view.dispatch({
    changes: change,
    ...(inBlockMode ? { selection: EditorSelection.single(newSpan.from, newSpan.to), effects: setBlockSelection.of({ anchor: newSpan, head: newSpan }) } : {}),
    userEvent: 'input.convert.block',
  });
  return true;
}

/**
 * The range a slash pick at `pos` converts. A slash command acts on the line it was
 * typed on, so inside a paragraph or a quote of several lines that line alone is
 * converted and the block's other lines keep their bytes, their quote markers
 * included. A later line of a quote or list item is handled by
 * `slashLineInContainer`; anywhere else the range is the whole block.
 */
function slashRangeAt(state: EditorState, pos: number): { from: number; to: number; kind: BlockKind | null } {
  const range = convertibleRangeAt(state, pos);
  const perLine = range.kind === 'paragraph' || range.kind === 'quote';
  if (!perLine || state.doc.lineAt(range.from).number === state.doc.lineAt(range.to).number) return range;
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to, kind: range.kind };
}

/**
 * The container prefix of line `lineNo`: the quote markers and list item indentation
 * of every quote and item that encloses the line and opened on an earlier line, plus
 * the spaces before the line's own text. `consumed` is how much of the line that
 * covers. `prefix` is what a line written inside those containers starts with: the
 * same bytes, except on a lazy continuation line, where the missing markers and
 * indentation are written out so the new line stays inside its containers.
 */
function containerPrefix(state: EditorState, lineNo: number): { consumed: number; prefix: string } | null {
  const doc = state.doc;
  const line = doc.line(lineNo);
  const containers: SyntaxNode[] = [];
  fullTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (n) => {
      if ((n.name === 'Blockquote' || n.name === 'ListItem') && n.from < line.from && n.to > line.from) containers.push(n.node);
    },
  });
  if (!containers.length) return null;
  const text = line.text;
  let at = 0;
  let prefix = '';
  let lazy = false;
  for (const c of containers) {
    if (c.name === 'Blockquote') {
      const m = lazy ? null : /^ {0,3}>[ \t]?/.exec(text.slice(at));
      if (m) {
        at += m[0].length;
        prefix += m[0];
      } else {
        lazy = true;
        prefix += '> ';
      }
      continue;
    }
    const first = doc.lineAt(c.from);
    const own = listContentColumn(first.text.slice(c.from - first.from));
    if (own === null) return null;
    const column = columnAfter(first.text.slice(0, c.from - first.from)) + own;
    if (!lazy) {
      const ws = /^[ \t]*/.exec(text.slice(at))![0];
      let k = 0;
      while (k < ws.length && columnAfter(prefix + ws.slice(0, k)) < column) k++;
      at += k;
      prefix += ws.slice(0, k);
      lazy = columnAfter(prefix) < column;
    }
    if (lazy) prefix += ' '.repeat(Math.max(0, column - columnAfter(prefix)));
  }
  const ws = /^[ \t]*/.exec(text.slice(at))![0];
  return { consumed: at + ws.length, prefix: prefix + ws };
}

const LINE_KINDS: BlockKind[] = ['paragraph', 'heading', 'item', 'quote'];

/**
 * A slash pick on a later line of a quote or list item acts on that line alone and
 * keeps it inside its containers: the line's text after the container prefix is
 * converted as the block it is (a paragraph line, or a heading, list item or quote
 * that opens on this line), and the prefix goes in front of every line the pick
 * writes. Null anywhere else, and on a line that opens a block no pick converts.
 */
function slashLineInContainer(state: EditorState, pos: number): { from: number; text: string; prefix: string; consumed: number; kind: BlockKind } | null {
  const doc = state.doc;
  const range = convertibleRangeAt(state, pos);
  const line = doc.lineAt(pos);
  if ((range.kind !== 'quote' && range.kind !== 'item') || line.number === doc.lineAt(range.from).number) return null;
  const container = containerPrefix(state, line.number);
  if (!container || pos < line.from + container.consumed) return null;
  // The outermost block that opens on this line, below the containers that opened earlier.
  let kind: BlockKind = 'paragraph';
  for (let n: SyntaxNode | null = fullTree(state).resolveInner(line.from + container.consumed, 1); n && n.from >= line.from; n = n.parent) {
    const k = n.name === 'ListItem' ? 'item' : kindOf(n, doc);
    if (LINE_KINDS.includes(k)) kind = k;
    else if (k !== 'list' && k !== 'other') return null;
  }
  return { from: line.from, text: line.text, prefix: container.prefix, consumed: container.consumed, kind };
}

/** The slash conversion at `pos`: the source it replaces, starting at `from`, and the new source with its caret. */
function slashConversion(state: EditorState, pos: number, into: TurnIntoKind): { from: number; text: string; out: { text: string; caret: number } } | null {
  const inner = slashLineInContainer(state, pos);
  if (inner) {
    const out = convertText(inner.text.slice(inner.consumed), inner.kind, into, pos - inner.from - inner.consumed);
    if (!out) return null;
    const lines = out.text.split('\n');
    const caretLine = out.text.slice(0, out.caret).split('\n').length - 1;
    const caretColumn = out.caret - (out.text.lastIndexOf('\n', out.caret - 1) + 1);
    let caret = 0;
    for (let k = 0; k < caretLine; k++) caret += inner.prefix.length + lines[k].length + 1;
    caret += inner.prefix.length + caretColumn;
    return { from: inner.from, text: inner.text, out: { text: lines.map((l) => inner.prefix + l).join('\n'), caret } };
  }
  const range = slashRangeAt(state, pos);
  const text = state.doc.sliceString(range.from, range.to);
  const out = convertText(text, range.kind, into, pos - range.from);
  return out && { from: range.from, text, out };
}

/**
 * Remove `from..to` (a typed `/query`) and turn the line or block around it into
 * `into`, as a single edit with the caret at the end of the converted line.
 */
export function replaceAndConvert(view: EditorView, from: number, to: number, into: TurnIntoKind): void {
  const { state } = view;
  const removal = state.changes({ from, to });
  const mid = state.update({ changes: removal }).state;
  const conversion = slashConversion(mid, from, into);
  if (!conversion) {
    view.dispatch({ changes: removal, selection: EditorSelection.cursor(from), userEvent: 'delete.slash' });
    return;
  }
  const { from: at, text, out } = conversion;
  const second = ChangeSet.of(minimalChange(at, text, out.text), mid.doc.length);
  view.dispatch({
    changes: removal.compose(second),
    selection: EditorSelection.cursor(at + out.caret),
    scrollIntoView: true,
    userEvent: 'input.convert.block',
  });
}
