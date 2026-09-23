/*
 * Block editing for prose: the enclosing block's line range, moving, duplicating,
 * deleting and converting blocks, block selection, the gutter handle and the
 * slash menu.
 *
 * Keys, and why each leaves ordinary editing alone:
 *   - Mod-Alt-e shows the caret's block as raw Markdown, and shows it again as a
 *     rendered block when it is already open.
 *   - Escape puts open raw Markdown away first, then selects the caret's block. Only
 *     a bare caret in prose selects a block, and menus, the search panel and table
 *     grids handle their own Escape first.
 *   - In block selection mode (and only there): arrows move to the next block,
 *     Shift+arrows extend by blocks, Mod-Shift-arrows and Alt-arrows move the
 *     blocks, Mod-d duplicates, Backspace or Delete deletes, Enter or Escape
 *     returns to a caret. Outside the mode every one of these keys keeps its usual
 *     text meaning.
 *   - Alt-ArrowUp and Alt-ArrowDown with a caret move the enclosing block past its
 *     neighbouring sibling, whatever the height of either, exactly as the handle's
 *     Move up and Move down do: an item goes past a whole item with its children, and
 *     nothing goes above front matter. Inside code, in front matter, on a blank line
 *     and with a text selection they still move lines, but never across a front
 *     matter fence, since a line crossing one changes what the front matter holds.
 *
 * One click enters block selection too: a click on a drawn rule selects the rule
 * as a block, since a caret beside its hidden characters would put typing inside
 * them.
 */

import { EditorSelection, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';
import { formatStateAt } from './formatState';
import { registerShortcutGroup } from './shortcuts';
import {
  blockRangeAt,
  blockSelectionField,
  deleteBlock,
  duplicateBlock,
  exitBlockSelection,
  moveBlock,
  navigateBlocks,
  selectBlockAt,
  setBlockSelection,
} from './blockModel';
import { slashMenu } from './slashMenu';
import { blockHandle } from './blockHandle';
import { closeReveal, toggleBlockReveal } from './revealBlock';

export {
  blockRangeAt,
  blockSelectionOf,
  moveBlock,
  duplicateBlock,
  deleteBlock,
  blockDropTargets,
  moveBlockTo,
  nearestDropIndex,
  selectBlockAt,
  turnRangeInto,
} from './blockModel';
export type { BlockRange, BlockKind, TurnIntoKind } from './blockModel';
export { slashMenuOf, filterSlashItems, SLASH_ITEMS } from './slashMenu';
export { blockMenuItems, insertParagraphBelow } from './blockHandle';
export type { BlockMenuItem } from './blockHandle';
export { setBlockRefHost } from './refs';
export type { BlockRefHost } from './refs';

registerShortcutGroup({
  title: 'Block editing',
  items: [
    { key: 'Mod-Alt-e', label: "Show the block's raw Markdown, or put it away" },
    { key: 'Escape', label: 'Put raw Markdown away, then select the block around the caret' },
    { key: 'ArrowDown', label: 'Selected block: select the next block' },
    { key: 'Shift-ArrowDown', label: 'Selected block: extend the selection by a block' },
    { key: 'Mod-Shift-ArrowUp', label: 'Selected block: move up' },
    { key: 'Mod-Shift-ArrowDown', label: 'Selected block: move down' },
    { key: 'Mod-d', label: 'Selected block: duplicate' },
    { key: 'Backspace', label: 'Selected block: delete' },
    { key: 'Enter', label: 'Selected block: back to the caret' },
    { key: 'Alt-ArrowUp', label: 'Move the block up' },
    { key: 'Alt-ArrowDown', label: 'Move the block down' },
    { key: '/', label: 'Insert menu, at a line start or after a space' },
  ],
});

const inBlockMode = (view: EditorView): boolean => !!view.state.field(blockSelectionField, false);

/** Run `fn` only in block selection mode, so the key keeps its text meaning otherwise. */
const blockModeOnly =
  (fn: (view: EditorView) => boolean) =>
  (view: EditorView): boolean =>
    inBlockMode(view) && fn(view);

/**
 * Escape puts away raw Markdown the block is showing, leaving the caret where it
 * is; with nothing shown, a bare caret selects the enclosing block. In block mode
 * it returns to the caret.
 */
function escape(view: EditorView): boolean {
  if (inBlockMode(view)) return exitBlockSelection(view);
  // The shortcuts overlay closes on its own Escape listener; do not also act here.
  if (document.querySelector('.sheaf-sc-backdrop:not([hidden])')) return false;
  if (closeReveal(view)) return true;
  const { selection } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  return selectBlockAt(view, selection.main.head);
}

/** True when a caret's block moves as a block, not as a line: any movable block outside code. */
function movesAsBlock(state: EditorState): boolean {
  const { selection } = state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const head = selection.main.head;
  const range = blockRangeAt(state, head);
  return !!range && range.movable && range.kind !== 'code' && !formatStateAt(state, head).codeBlock;
}

/**
 * True when moving the selected lines one line in `dir` would carry a line across a
 * fence of the front matter: the lines it touches must sit wholly between the fences
 * or wholly below the closing one.
 */
function lineMoveCrossesFrontMatter(state: EditorState, dir: -1 | 1): boolean {
  const front = blockRangeAt(state, 0);
  if (!front || front.kind !== 'frontmatter') return false;
  const { doc } = state;
  return state.selection.ranges.some((r) => {
    const first = doc.lineAt(r.from).number;
    const end = doc.lineAt(r.to);
    // As the line move does, a range ending at a line start does not take that line.
    const last = !r.empty && r.to === end.from ? end.number - 1 : end.number;
    const top = dir < 0 ? first - 1 : first;
    const bottom = dir < 0 ? last : last + 1;
    const inside = top > 1 && bottom < front.endLine;
    const below = top > front.endLine;
    return !inside && !below;
  });
}

/**
 * Alt-arrows: move the block in block mode or the caret's block, through the same
 * block model as the handle. Otherwise leave the key to the line move, unless that
 * would cross a front matter fence, in which case nothing moves.
 */
function altMove(dir: -1 | 1) {
  return (view: EditorView): boolean => {
    if (inBlockMode(view) || movesAsBlock(view.state)) return moveBlock(view, dir);
    return lineMoveCrossesFrontMatter(view.state, dir);
  };
}

const blockModeKeymap = Prec.high(
  keymap.of([
    { key: 'ArrowDown', run: blockModeOnly((v) => navigateBlocks(v, 1, false)), shift: blockModeOnly((v) => navigateBlocks(v, 1, true)) },
    { key: 'ArrowUp', run: blockModeOnly((v) => navigateBlocks(v, -1, false)), shift: blockModeOnly((v) => navigateBlocks(v, -1, true)) },
    { key: 'Mod-Shift-ArrowUp', run: blockModeOnly((v) => moveBlock(v, -1)) },
    { key: 'Mod-Shift-ArrowDown', run: blockModeOnly((v) => moveBlock(v, 1)) },
    { key: 'Mod-d', run: blockModeOnly(duplicateBlock) },
    { key: 'Backspace', run: blockModeOnly(deleteBlock) },
    { key: 'Delete', run: blockModeOnly(deleteBlock) },
    { key: 'Enter', run: blockModeOnly(exitBlockSelection) },
  ])
);

const caretKeymap = keymap.of([
  { key: 'Escape', run: escape },
  { key: 'Mod-Alt-e', run: toggleBlockReveal },
  { key: 'Alt-ArrowUp', run: altMove(-1) },
  { key: 'Alt-ArrowDown', run: altMove(1) },
]);

/**
 * The span a click on the line `target` is in selects, when that line draws a
 * rule: the rule's block, or for a rule inside a quote or a list item, where the
 * block is the whole quote or item, the rule's own characters. Null when the line
 * draws no rule. A line that draws a rule holds nothing else a press could be aimed
 * at, so the whole line counts, not only the thin `hr` inside it.
 */
function ruleClickSpan(view: EditorView, target: EventTarget | null): { from: number; to: number } | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  const line = el.closest('.cm-line');
  // A cell editor nested inside this one answers its own presses.
  if (!line || line.closest('.cm-content') !== view.contentDOM) return null;
  const hr = line.querySelector('hr.md-hr');
  if (!hr) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(hr);
  } catch {
    return null;
  }
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name !== 'HorizontalRule') continue;
    const block = blockRangeAt(view.state, node.from);
    return block && block.kind === 'rule' ? { from: block.from, to: block.to } : { from: node.from, to: node.to };
  }
  return null;
}

/**
 * A click on a drawn rule selects the rule as a block, as Escape on its line does.
 * The rule's characters are hidden, so a caret at either end of them is a caret
 * inside Markdown nobody can see: typing there wrote `Z---` and the rule became
 * text, and Edit Markdown had nothing to open because the press never reached the
 * editor. Selected, the rule shows it is selected, Edit Markdown shows its dashes,
 * typing replaces it, and Backspace deletes it.
 *
 * It is a selection style rather than a mousedown handler that dispatches, for the
 * reason given at paragraphTripleClick: a selection made inside CodeMirror's own
 * gesture is written to the DOM by CodeMirror, so nothing stale is read back after
 * it. ruleSelectedAsBlock then marks that selection as the rule's block. A drag
 * that starts on the rule and leaves it selects from the rule to the pointer. Only
 * a plain single click is taken; Shift, a modifier, or a second click is
 * CodeMirror's, as anywhere else.
 */
const ruleClick = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  const found = ruleClickSpan(view, event.target);
  if (!found) return null;
  let { from, to } = found;
  return {
    get: (e) => {
      const whole = EditorSelection.single(from, to);
      if (e.clientX === event.clientX && e.clientY === event.clientY) return whole;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null || (pos >= from && pos <= to)) return whole;
      return pos < from ? EditorSelection.single(to, pos) : EditorSelection.single(from, pos);
    },
    update: (update) => {
      if (update.docChanged) {
        from = update.changes.mapPos(from, 1);
        to = update.changes.mapPos(to, -1);
      }
      return false;
    },
  };
});

/** A pointer selection that is exactly a rule's block enters block selection mode on it. */
const ruleSelectedAsBlock = EditorState.transactionExtender.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent('select.pointer')) return null;
  const { ranges, main } = tr.selection;
  if (ranges.length !== 1 || main.empty) return null;
  const state = tr.startState;
  const line = state.doc.lineAt(main.from);
  if (line.from !== main.from || line.to !== main.to) return null;
  const block = blockRangeAt(state, main.from);
  if (!block || block.kind !== 'rule' || block.from !== main.from || block.to !== main.to) return null;
  const span = { from: block.from, to: block.to };
  return { effects: setBlockSelection.of({ anchor: span, head: span }) };
});

export const blockEditing: Extension = [
  blockSelectionField,
  slashMenu,
  blockModeKeymap,
  caretKeymap,
  blockHandle,
  ruleClick,
  ruleSelectedAsBlock,
];
