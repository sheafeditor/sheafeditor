/*
 * Marks pressed with a bare caret outside any word, waiting for the next typed text.
 *
 * Bold with nothing selected and no word under the caret has nothing to wrap, and
 * writing `****` there would leave the person to type between two pairs of asterisks.
 * So the mark is remembered against that position instead, and the next text typed
 * arrives already wrapped in it.
 *
 * This lives in a module of its own because three places need it: the toolbar, which
 * is where a mark is pressed, and both editors that accept typing, the document and a
 * table's cell. The toolbar owning it made `cellEditor` import the toolbar while the
 * toolbar imported the tables that build the cell editor, which was the editor's only
 * import cycle. A cycle costs nothing until a module in it reads an imported binding
 * while it is still evaluating, and then it is `undefined` at run time with a correct
 * type and a passing suite behind it, so the answer is to not have one.
 */

import { Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Set or clear the marks waiting at a position. */
export const setPendingMarks = StateEffect.define<{ pos: number; marks: string[] } | null>();

/** The marks waiting at a position, dropped as soon as the document or the selection moves. */
export const pendingMarksField = StateField.define<{ pos: number; marks: string[] } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPendingMarks)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
});

/** Wraps the text typed at a caret with pending marks in those marks, so a mark pressed in empty space writes nothing until there is text. */
export const pendingMarks: Extension = [
  pendingMarksField,
  EditorView.inputHandler.of((view, from, to, text) => {
    const pending = view.state.field(pendingMarksField, false);
    if (!pending || from !== pending.pos || to !== pending.pos || view.composing) return false;
    const open = pending.marks.join('');
    const close = [...pending.marks].reverse().join('');
    view.dispatch({
      changes: { from, insert: open + text + close },
      selection: { anchor: from + open.length + text.length },
      userEvent: 'input.type',
    });
    return true;
  }),
];
