/*
 * Showing a block's raw Markdown: the Edit Markdown command behind Cmd+Alt+E and
 * the two menus, and the opt-in double-click that does the same thing.
 *
 * The range comes from the block model, so Edit Markdown, Reveal Syntax On Line
 * and the double-click all open exactly the same span: a list item on its own
 * with anything nested under it, and the whole construct for everything else.
 *
 * A reveal closes when the caret leaves it (livePreview drops it), which is why
 * revealing a block the caret is not in takes the caret there first.
 */

import { EditorView } from '@codemirror/view';
import { blockRangeAt } from './blockModel';
import { revealField, setReveal } from './revealState';

/** Show the raw Markdown of `range`, moving the caret into it when it is outside. */
export function revealRange(view: EditorView, range: { from: number; to: number }): void {
  const head = view.state.selection.main.head;
  const inside = head >= range.from && head <= range.to;
  view.dispatch({
    effects: setReveal.of({ from: range.from, to: range.to }),
    selection: inside ? undefined : { anchor: range.from },
    scrollIntoView: false,
  });
}

/** Show the raw Markdown of the block at `pos`. False when no block is there, as on a blank line. */
export function revealBlockAt(view: EditorView, pos: number): boolean {
  const block = blockRangeAt(view.state, pos);
  if (!block) return false;
  revealRange(view, block);
  return true;
}

/** Put the Markdown away, leaving the caret where it is. False when none was shown. */
export function closeReveal(view: EditorView): boolean {
  if (!view.state.field(revealField, false)) return false;
  view.dispatch({ effects: setReveal.of(null) });
  return true;
}

/**
 * Edit Markdown: show the caret's block as raw Markdown, or put it away again
 * when the block already shows it. The one command behind Cmd+Alt+E, the block
 * handle menu and the right-click menu.
 */
export function toggleBlockReveal(view: EditorView): boolean {
  const open = view.state.field(revealField, false);
  const head = view.state.selection.main.head;
  if (open && head >= open.from && head <= open.to) return closeReveal(view);
  return revealBlockAt(view, head);
}

/**
 * Edit Markdown one scope in, where the editor's whole document is the thing to show:
 * a table cell, which opens a CodeMirror view holding that one cell's inline Markdown.
 *
 * There is no block to find in a cell and no `blockRangeAt` answer to trust, because the
 * cell's parser is built without the block constructs. The range is `0` to the end, which
 * is the cell, and `revealField` maps it through edits with the bias that makes text typed
 * at either edge join it, so the source stays shown while the cell is typed into.
 *
 * Here rather than in the cell editor so that the key, the toolbar button and the
 * right-click item are one function: three surfaces that each toggled their own reveal
 * would disagree the moment one of them was changed.
 */
export function toggleWholeReveal(view: EditorView): boolean {
  if (view.state.field(revealField, false)) return closeReveal(view);
  view.dispatch({ effects: setReveal.of({ from: 0, to: view.state.doc.length }) });
  return true;
}

/**
 * The double-click reveal, for anyone who turns `sheaf.doubleClickToEditSource`
 * on. It selects the word under the pointer as well, so typing replaces the word
 * rather than landing inside it. False leaves the click to CodeMirror, whose own
 * double-click selects the word and changes nothing about what is shown.
 */
export function revealOnDoubleClick(view: EditorView, pos: number, enabled: boolean): boolean {
  if (!enabled) return false;
  const block = blockRangeAt(view.state, pos);
  if (!block) return false;
  const word = view.state.wordAt(pos);
  view.dispatch({
    effects: setReveal.of({ from: block.from, to: block.to }),
    selection: word ? { anchor: word.from, head: word.to } : { anchor: pos },
    scrollIntoView: false,
  });
  return true;
}
