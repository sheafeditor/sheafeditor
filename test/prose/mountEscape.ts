/*
 * What Escape does on a mounted surface, and what a consumer's own listener sees of it.
 *
 * A consumer's field commonly reverts on Escape, and the editor binds the key too: `defaultKeymap`
 * gives it to `simplifySelection`, which collapses a selection and declines the key when there is
 * none to collapse. So there are two halves, and `src/lib/README.md` states both:
 *
 *   - from a plain cursor the editor takes nothing, so the press is the consumer's: their listener
 *     runs, `defaultPrevented` is false, and the value is untouched;
 *   - with a selection the editor collapses it and marks the event handled, and the consumer's
 *     listener still runs, because answering a key prevents its default without stopping the event.
 *     `defaultPrevented` is what tells the consumer the press was spent on the selection.
 *
 * **Each half is asserted on what it could get wrong.** The plain-cursor case would pass in a
 * surface that swallowed every key if it only read the value, so it counts the listener's calls
 * and reads `defaultPrevented`. The selection case would pass in a surface that never bound
 * Escape if it only counted the listener, so it reads back that the selection was non-empty before
 * the press and empty after it.
 *
 * jsdom is enough: CodeMirror's key handling is DOM events and a keymap lookup, with no layout in
 * it, and `test/prose/fieldNewline.ts` asserts Enter the same way.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const G = globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent };

const VALUE = 'one two three';

type Surface = ReturnType<typeof mount>;

async function withEditor(
  profile: 'field' | 'notes',
  fn: (surface: Surface, view: EditorView) => ScenarioResult
): Promise<ScenarioResult> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: VALUE, profile });
  try {
    surface.focus();
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return { ok: false, detail: 'the editor was built but no view could be found in it' };
    return fn(surface, view);
  } finally {
    surface.destroy();
    parent.remove();
  }
}

/** Press Escape on the editor's content element and report what the consumer's listener saw. */
function escape(surface: Surface, view: EditorView): { seen: number; prevented: boolean | null } {
  let seen = 0;
  let prevented: boolean | null = null;
  // Bubble phase, after the editor's own handler, which is where a consumer reading
  // `defaultPrevented` has to listen to learn anything from it.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    seen++;
    prevented = event.defaultPrevented;
  };
  surface.element.addEventListener('keydown', onKey);
  try {
    view.contentDOM.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  } finally {
    surface.element.removeEventListener('keydown', onKey);
  }
  return { seen, prevented };
}

const cases = (profile: 'field' | 'notes'): Scenario[] => [
  {
    name: `${profile}: from a plain cursor Escape is the consumer's, and the editor takes nothing`,
    run: () =>
      withEditor(profile, (surface, view) => {
        view.dispatch({ selection: { anchor: 4 } });
        const { seen, prevented } = escape(surface, view);
        const sel = view.state.selection.main;
        const got = surface.value();
        return {
          ok: seen === 1 && prevented === false && got === VALUE && sel.empty && sel.head === 4,
          detail: `the listener ran ${seen} time(s) with defaultPrevented ${prevented}, the caret is at ${sel.head}, value() is ${JSON.stringify(got)}; wanted 1, false, 4 and the value unchanged`,
        };
      }),
  },
  {
    name: `${profile}: with a selection Escape collapses it, and the consumer's listener sees the press marked as taken`,
    run: () =>
      withEditor(profile, (surface, view) => {
        view.dispatch({ selection: { anchor: 4, head: 7 } });
        const before = view.state.selection.main;
        if (before.empty) return { ok: false, detail: 'the selection was empty before the press, so the case measured nothing' };
        const { seen, prevented } = escape(surface, view);
        const after = view.state.selection.main;
        const got = surface.value();
        return {
          ok: seen === 1 && prevented === true && after.empty && got === VALUE,
          detail: `selection ${before.from}-${before.to} before, ${after.from}-${after.to} after; the listener ran ${seen} time(s) with defaultPrevented ${prevented}; value() is ${JSON.stringify(got)}; wanted a collapsed selection, 1, true and the value unchanged`,
        };
      }),
  },
];

export const scenarios: Scenario[] = [
  ...cases('field'),
  ...cases('notes'),
  {
    name: 'notes: a capturing listener runs before the editor answers Escape, so it cannot read defaultPrevented',
    run: () =>
      /*
       * The README tells a consumer to listen in the bubble phase for Escape, and this is why. A
       * capturing listener on the element `mount` created runs on the way down to the editor's
       * content element, before the keymap has seen the key, so a selection the editor is about to
       * collapse reads as not handled. The bubble-phase reading beside it is the control: the same
       * press, the same selection, read after the editor answered.
       */
      withEditor('notes', (surface, view) => {
        view.dispatch({ selection: { anchor: 4, head: 7 } });
        let captured: boolean | null = null;
        let bubbled: boolean | null = null;
        const onCapture = (e: KeyboardEvent): void => void (captured = e.defaultPrevented);
        const onBubble = (e: KeyboardEvent): void => void (bubbled = e.defaultPrevented);
        surface.element.addEventListener('keydown', onCapture, true);
        surface.element.addEventListener('keydown', onBubble);
        try {
          view.contentDOM.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        } finally {
          surface.element.removeEventListener('keydown', onCapture, true);
          surface.element.removeEventListener('keydown', onBubble);
        }
        return {
          ok: captured === false && bubbled === true && view.state.selection.main.empty,
          detail: `capturing listener read defaultPrevented ${captured}, bubbling listener read ${bubbled}; wanted false and true`,
        };
      }),
  },
];
