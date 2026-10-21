/*
 * Who is acting, for a line break reaching a one-line surface.
 *
 * A `field` is one line, and three different things used to arrive at the same place: a person
 * pasting two lines of text, a consumer calling `setValue`, and a person pressing Enter. One
 * transaction filter caught all three and turned the break into a space, and its own comment names
 * only the first of them. So the rule is stated by actor rather than by surface:
 *
 * | A person pastes a break   | it becomes a space, the way a table cell already does |
 * | A consumer sets a value   | it is kept, byte for byte |
 * | A person presses a key the surface does not support | nothing is inserted |
 *
 * **The paste case is the control that matters.** The cheap way to satisfy the other two is to
 * delete the filter, which would pass every byte-identical case here while losing the case the
 * filter exists for. It is asserted first, and it asserted the same answer before this change as
 * after it.
 *
 * **Why this is in the prose suite rather than beside `planEdit`.** The behaviour is a property of
 * the surface a consumer mounts, not of a function: the filter is an editor extension and the
 * consumer's write reaches it through `mount`, so a case over either half alone would pass on the
 * defect. jsdom is enough because every claim here is about characters coming out of `value()`,
 * and nothing depends on layout or a real pointer.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** `text` with its endings written out, so a one-character difference is readable. */
const shown = (text: string): string =>
  text.replace(/\r\n/g, '<CRLF>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');

type Surface = ReturnType<typeof mount>;

/**
 * Mount `value` in `profile`, focus it so the editor is built, and hand the surface to `fn`.
 *
 * The focus is the precondition rather than a step: before it there is no editor, no filter and no
 * keymap, so every claim below would pass on a surface that does nothing at all. `editing()` is
 * read back for that reason.
 */
async function withEditor(
  value: string,
  profile: 'field' | 'notes',
  fn: (surface: Surface, view: EditorView) => Promise<ScenarioResult> | ScenarioResult,
  onChange?: (next: string) => void
): Promise<ScenarioResult> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value, profile, onChange });
  try {
    surface.focus();
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return { ok: false, detail: 'the editor was built but no view could be found in it' };
    return await fn(surface, view);
  } finally {
    surface.destroy();
    parent.remove();
  }
}

const G = globalThis as unknown as { Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };

/**
 * Paste `text` into `view`, the way the platform does it.
 *
 * A dispatched `paste` carrying a `clipboardData` stub, on the editor's own content element, so
 * the editor's clipboard handler is what inserts the text. Reaching for `view.dispatch` instead
 * would assert the filter against a transaction this check built, and the thing worth knowing is
 * that a person's paste still arrives at it.
 */
function paste(view: EditorView, text: string): void {
  const event = new G.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  });
  view.contentDOM.dispatchEvent(event);
}

/**
 * A keydown as the platform sends it, dispatched at the editor's content element.
 *
 * Returns whether a binding took the key, which is `defaultPrevented`: CodeMirror calls
 * `preventDefault` on a key one of its handlers returned true for and on nothing else.
 *
 * **Not `runScopeHandlers` beside this**, which is how the first version of these cases was
 * written. Dispatching the event *and* passing it to `runScopeHandlers` runs the binding twice, so
 * the baseline measured Enter as writing two spaces where the defect writes one, and a case
 * expecting one would have failed on a correct reading for a reason that was nothing to do with
 * the product.
 */
function keydown(view: EditorView, key: string, shift = false): boolean {
  const event = new G.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

const TWO_LINES = 'one\ntwo';
const TWO_CRLF = 'one\r\ntwo';
const TWO_CR = 'one\rtwo';
/** A value with nothing in it to normalise, which is what stops the cases below being vacuous. */
const PLAIN = 'one two';

export const scenarios: Scenario[] = [
  {
    /*
     * **The control, and it is first on purpose.** Deleting the filter is the cheapest way to pass
     * every other case in this file, and this is the only one that notices.
     */
    name: 'CONTROL: pasting two lines into a field still gives one line with a space',
    run: () =>
      withEditor('', 'field', (surface, view) => {
        paste(view, TWO_LINES);
        const got = surface.value();
        return {
          ok: got === PLAIN && view.state.doc.lines === 1,
          detail: `value() got ${shown(got)} over ${view.state.doc.lines} line(s), wanted ${shown(PLAIN)} over 1`,
        };
      }),
  },
  {
    name: 'CONTROL: pasting a single line into a field inserts it unchanged',
    run: () =>
      /*
       * The positive complement to the case above: a filter that refused every paste, or flattened
       * text that held no break, would pass that one and fail here.
       */
      withEditor('', 'field', (surface, view) => {
        paste(view, PLAIN);
        const got = surface.value();
        return { ok: got === PLAIN, detail: `value() got ${shown(got)}, wanted ${shown(PLAIN)}` };
      }),
  },
  {
    name: 'field: setValue keeps a line break, before focus and after the editor is built',
    run: async () => {
      /*
       * Both halves, because the defect was precisely that they disagreed: the string came back
       * whole from a surface nobody had touched and came back with a space in it from the same
       * surface a moment after somebody clicked into it.
       *
       * **The two halves are two surfaces, and the first version made them one, which passed on
       * the defect.** Setting the value, focusing and setting the same value again does not reach
       * the filter at all: the editor is built from the value already held, so the second
       * `setValue` finds the document it wants and returns before it dispatches anything. The
       * second half has to write the break into an editor that does not hold one.
       */
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const unfocused = mount(parent, { value: '', profile: 'field' });
      let before: string;
      try {
        unfocused.setValue(TWO_LINES);
        before = unfocused.value();
        if (unfocused.editing()) return { ok: false, detail: 'an editor existed before anything focused the surface' };
      } finally {
        unfocused.destroy();
        parent.remove();
      }
      return withEditor(PLAIN, 'field', (surface, view) => {
        surface.setValue(TWO_LINES);
        const after = surface.value();
        /*
         * What the kept break costs, on screen, read off the DOM rather than reasoned from the
         * document. The integration instructions tell a consumer that a `field` holding a break
         * draws a second line, and that sentence should be a measurement.
         */
        const drawn = surface.element.querySelectorAll('.cm-line').length;
        return {
          ok: before === TWO_LINES && after === TWO_LINES && view.state.doc.lines === 2 && drawn === 2,
          detail: `before focus ${shown(before)}, after the editor ${shown(after)} over ${view.state.doc.lines} document line(s) drawn as ${drawn} line element(s), wanted ${shown(TWO_LINES)} for both over 2 and 2`,
        };
      });
    },
  },
  {
    name: 'field: setValue keeps a CRLF break',
    run: () =>
      withEditor('', 'field', (surface) => {
        surface.setValue(TWO_CRLF);
        const got = surface.value();
        return { ok: got === TWO_CRLF, detail: `value() got ${shown(got)}, wanted ${shown(TWO_CRLF)}` };
      }),
  },
  {
    name: 'field: setValue keeps a lone CR',
    run: () =>
      /*
       * The ending no flag can stand for. It survives because the value a consumer set is the
       * authority and the editor's document is reconciled against it, which is the arrangement the
       * round-trip work put in `mount`.
       */
      withEditor('', 'field', (surface) => {
        surface.setValue(TWO_CR);
        const got = surface.value();
        return { ok: got === TWO_CR, detail: `value() got ${shown(got)}, wanted ${shown(TWO_CR)}` };
      }),
  },
  {
    name: 'CONTROL: setValue on a field with nothing to normalise round-trips too',
    run: () =>
      /*
       * Without this, every `setValue` case above could be read as a check that two calls agree in
       * a case where neither does anything. This one has no break in it and must pass whatever the
       * filter does, so a fix that broke ordinary writes fails here and nowhere else in this file.
       */
      withEditor('', 'field', (surface) => {
        surface.setValue(PLAIN);
        const got = surface.value();
        return { ok: got === PLAIN, detail: `value() got ${shown(got)}, wanted ${shown(PLAIN)}` };
      }),
  },
  {
    name: 'field: the mount-time value keeps its break, which is the path that was already right',
    run: () =>
      /*
       * The control for the whole change, in the sense the decision names: two write paths that
       * disagreed could be made to agree by changing either one, and this is the one that must not
       * move. A check comparing `setValue` against `mount` alone would pass on the wrong fix.
       */
      withEditor(TWO_LINES, 'field', (surface) => {
        const got = surface.value();
        return { ok: got === TWO_LINES, detail: `value() got ${shown(got)}, wanted ${shown(TWO_LINES)}` };
      }),
  },
  {
    name: 'field: Enter inserts nothing, leaves the value byte-identical and fires no onChange',
    run: () => {
      /*
       * `onChange` is here because it is the half a consumer stores. The defect fired it with the
       * space in the value, so a consumer saving on change saved a character nobody typed, and a
       * check reading `value()` alone would pass on a surface that still told them about an edit.
       */
      const seen: string[] = [];
      return withEditor(
        PLAIN,
        'field',
        (surface, view) => {
          const took = keydown(view, 'Enter');
          const got = surface.value();
          return {
            ok: took && got === PLAIN && view.state.doc.lines === 1 && seen.length === 0,
            detail: `a binding ${took ? 'took' : 'declined'} the key, value() got ${shown(got)} at ${got.length} characters over ${view.state.doc.lines} line(s) and onChange ran ${seen.length} time(s), wanted ${shown(PLAIN)} at ${PLAIN.length} over 1 line with 0 onChange calls, taken by a binding`,
          };
        },
        (next) => void seen.push(next)
      );
    },
  },
  {
    name: 'field: Shift+Enter inserts nothing either',
    run: () =>
      /*
       * A separate binding in the default keymap, and the one a reader would most expect to write
       * a break, which is why it is asserted rather than assumed to follow.
       */
      withEditor(PLAIN, 'field', (surface, view) => {
        const took = keydown(view, 'Enter', true);
        const got = surface.value();
        return {
          ok: took && got === PLAIN,
          detail: `a binding ${took ? 'took' : 'declined'} the key and value() got ${shown(got)} at ${got.length} characters, wanted ${shown(PLAIN)} at ${PLAIN.length}`,
        };
      }),
  },
  {
    name: "field: a consumer's own Enter handler still sees the key",
    run: () =>
      /*
       * The half of the promise that taking the key could have broken. The editor answers Enter on
       * its own content element and a consumer listens on the element `mount` created, so what
       * matters is that declining to insert anything does not also stop the event: a handler that
       * returns true calls `preventDefault`, which is not `stopPropagation`.
       */
      withEditor(PLAIN, 'field', (surface, view) => {
        let seen = 0;
        const onKey = (): void => void seen++;
        surface.element.addEventListener('keydown', onKey);
        try {
          keydown(view, 'Enter');
          const got = surface.value();
          return {
            ok: seen === 1 && got === PLAIN,
            detail: `the element's listener ran ${seen} time(s) and value() got ${shown(got)}, wanted 1 and ${shown(PLAIN)}`,
          };
        } finally {
          surface.element.removeEventListener('keydown', onKey);
        }
      }),
  },
  {
    name: 'notes: Enter still inserts a line break, since both profiles share the keymap',
    run: () =>
      withEditor(PLAIN, 'notes', (surface, view) => {
        const took = keydown(view, 'Enter');
        const got = surface.value();
        return {
          ok: took && got.includes('\n'),
          detail: `a binding ${took ? 'took' : 'declined'} the key and value() got ${shown(got)} over ${view.state.doc.lines} line(s), wanted a line break in it`,
        };
      }),
  },
  {
    name: 'notes: setValue keeps a line break, unchanged by any of this',
    run: () =>
      withEditor('', 'notes', (surface) => {
        surface.setValue(TWO_LINES);
        const got = surface.value();
        return { ok: got === TWO_LINES, detail: `value() got ${shown(got)}, wanted ${shown(TWO_LINES)}` };
      }),
  },
  {
    name: 'field: typing after a setValue that kept a break reports the break and the typing',
    run: () =>
      /*
       * What a kept break costs, measured rather than reasoned about. The value a consumer set is
       * two lines in the editor's document, and the round trip the library is sold on has to
       * survive an edit made on top of it: without this, keeping the break could hold for an
       * untouched surface and lose the ending on the first keystroke, which is the shape the
       * round-trip work found in `onChange`.
       */
      withEditor('', 'field', (surface, view) => {
        surface.setValue(TWO_CRLF);
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
        const got = surface.value();
        const wanted = `${TWO_CRLF}x`;
        return { ok: got === wanted, detail: `value() got ${shown(got)}, wanted ${shown(wanted)}` };
      }),
  },
];
