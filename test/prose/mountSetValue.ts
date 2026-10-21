/*
 * Where the caret is after a consumer sets a new value under it.
 *
 * `pkg.mount` R6 is three clauses: a new value is accepted into a live mount, the mount is not
 * destroyed, and the caret does not move. The first two had scenarios and the third had none, in a
 * file whose subject is line breaks, so the clause with an implementation written specifically for
 * it was the one clause nothing read. `editor.ts`'s `setValue` keeps a common prefix and suffix and
 * dispatches the smallest change between the two texts, with a comment saying that is what R6 is
 * for; these are the cases that would notice if it became a whole-document replace.
 *
 * **What breaks them, measured rather than predicted.** Replacing the change with
 * `{ from: 0, to: old.length, insert: text }` leaves the value correct and all three of these fail
 * while every `setValue` case in `fieldNewline.ts` goes on passing, which is the whole reason this
 * file exists: a byte-identical value is no evidence at all about a caret. The caret lands at 0,
 * not at the end of the inserted text, because CodeMirror maps a position inside a replaced range
 * to the start of what replaced it. Worth writing down, since "a replace moves the caret to the
 * end" is the plausible version and it is wrong.
 *
 * **What is not promised and is not asserted here.** A caret *inside* the span the change
 * rewrites has nowhere unmoved to be, and the implementation makes no claim about it. The two
 * positions below are chosen either side of the change for that reason.
 *
 * jsdom is enough: every claim is a document offset or a character, and none of it is geometry.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Mount `OLD` in a `field`, focus it so the editor is built, put the caret at `at`, and run `fn`.
 *
 * The focus is a precondition rather than a step: before it there is no editor and no selection to
 * move, so every case here would pass on a surface that does nothing. `editing()` is read back for
 * that reason, and so is the caret position, because a selection that never took is the other way
 * these cases could pass without measuring anything.
 */
async function withCaretAt(
  at: number,
  fn: (surface: ReturnType<typeof mount>, view: EditorView) => Promise<ScenarioResult> | ScenarioResult
): Promise<ScenarioResult> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: OLD, profile: 'field' });
  try {
    surface.focus();
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return { ok: false, detail: 'the editor was built but no view could be found in it' };
    view.dispatch({ selection: { anchor: at } });
    const put = view.state.selection.main.head;
    if (put !== at) return { ok: false, detail: `the caret could not be put at ${at}, it went to ${put}` };
    return await fn(surface, view);
  } finally {
    surface.destroy();
    parent.remove();
  }
}

/*
 * One edit, with unchanged text on both sides of it. `beta` at 6..10 becomes `B`, so the change is
 * three characters shorter and every position after it shifts by three. A same-length replacement
 * would have made the second case below pass on arithmetic that was never done.
 */
const OLD = 'alpha beta gamma';
const NEW = 'alpha B gamma';
/** Inside `alpha`, before the change. An unmoved caret is the same number. */
const BEFORE = 3;
/** The `g` of `gamma`, after the change. An unmoved caret is the same character, three earlier. */
const AFTER = 11;

export const scenarios: Scenario[] = [
  {
    name: 'mount: setValue leaves a caret before the changed span where it was',
    run: () =>
      withCaretAt(BEFORE, (surface, view) => {
        surface.setValue(NEW);
        const got = surface.value();
        const head = view.state.selection.main.head;
        return {
          ok: got === NEW && head === BEFORE,
          detail: `value() got ${JSON.stringify(got)} and the caret is at ${head}, wanted ${JSON.stringify(NEW)} and ${BEFORE}`,
        };
      }),
  },
  {
    name: 'mount: setValue carries a caret after the changed span onto the same character',
    run: () =>
      withCaretAt(AFTER, (surface, view) => {
        const was = OLD.slice(AFTER, AFTER + 5);
        surface.setValue(NEW);
        const got = surface.value();
        const head = view.state.selection.main.head;
        const now = view.state.doc.sliceString(head, head + 5);
        return {
          ok: got === NEW && now === was,
          detail: `the caret was on ${JSON.stringify(was)} and is now at ${head} on ${JSON.stringify(now)}, over value() ${JSON.stringify(got)}`,
        };
      }),
  },
  {
    name: 'mount: typing after a setValue goes in at the caret rather than at the end',
    run: () =>
      /*
       * The consequence the other two are about, and the one a consumer sees. `replaceSelection`
       * inserts wherever the editor holds the caret rather than at a number this case supplies,
       * so it measures the selection instead of restating it.
       */
      withCaretAt(BEFORE, (surface, view) => {
        surface.setValue(NEW);
        view.dispatch(view.state.replaceSelection('X'));
        const got = surface.value();
        const wanted = `${NEW.slice(0, BEFORE)}X${NEW.slice(BEFORE)}`;
        return { ok: got === wanted, detail: `value() got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}` };
      }),
  },
];
