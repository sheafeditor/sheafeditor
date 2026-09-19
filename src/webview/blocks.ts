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
 */

import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
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
export { blockMenuItems, insertParagraphBelow, setBlockRefHost } from './blockHandle';
export type { BlockMenuItem, BlockRefHost } from './blockHandle';

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

export const blockEditing: Extension = [blockSelectionField, slashMenu, blockModeKeymap, caretKeymap, blockHandle];
