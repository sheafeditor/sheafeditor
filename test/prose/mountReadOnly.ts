/*
 * What `readOnly: true` takes away, and what it must not.
 *
 * `pkg.mount` R9: it removes the ability to edit rather than hiding the controls, and still draws
 * everything the profile carries. The option has been wired since the library landed, at
 * `src/lib/editor.ts`, as `EditorView.editable.of(!spec.readOnly)` and
 * `EditorState.readOnly.of(spec.readOnly)`. Until this file, `readOnly` appeared nowhere in `test/`
 * or `scripts/` outside generated bundles: a public option of `MountOptions` with no check at all.
 *
 * **Every case here is a comparison against the same mount without the option, because jsdom
 * cannot see most of what stops an edit.** jsdom performs no text input from a keystroke, so "a
 * keystroke left the value byte-identical" is true of a read-only surface, a writable one, and a
 * surface that does nothing whatever. A case asserting it alone would pass on a `readOnly` that was
 * never wired. What separates them is a gesture the *editor* acts on, where the writable side
 * changes and the read-only side does not, so each case prints both sides and their difference.
 *
 * The one thing measured directly rather than by comparison is `contentEditable`, which is the
 * literal form of "removes the ability": the browser is told the content cannot be typed into.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const G = globalThis as unknown as { Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };

/** A keydown as the platform sends it, at the editor's content element. */
function keydown(view: EditorView, key: string): boolean {
  const event = new G.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A paste carrying `text`, dispatched at the content element so the editor's own handler runs. */
function paste(view: EditorView, text: string): void {
  const event = new G.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') },
  });
  view.contentDOM.dispatchEvent(event);
}

type Built = { surface: ReturnType<typeof mount>; view: EditorView; done: () => void };

/**
 * Mount `value` with and without `readOnly`, focus both so their editors exist, and hand both to
 * `fn`. Both are built the same way in the same turn, so a difference between them is the option.
 */
async function bothWays(
  value: string,
  profile: 'notes' | 'field',
  fn: (ro: Built, rw: Built) => Promise<ScenarioResult> | ScenarioResult
): Promise<ScenarioResult> {
  const made: Built[] = [];
  const make = async (readOnly: boolean): Promise<Built | string> => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const surface = mount(parent, { value, profile, readOnly });
    surface.focus();
    await settle();
    if (!surface.editing()) return `no editor was built for readOnly=${readOnly}, so this tested nothing`;
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return `the editor was built for readOnly=${readOnly} but no view could be found`;
    const built = { surface, view, done: () => { surface.destroy(); parent.remove(); } };
    made.push(built);
    return built;
  };
  try {
    const ro = await make(true);
    if (typeof ro === 'string') return { ok: false, detail: ro };
    const rw = await make(false);
    if (typeof rw === 'string') return { ok: false, detail: rw };
    return await fn(ro, rw);
  } finally {
    for (const m of made) m.done();
  }
}

const PROSE = 'A line of prose.';
/* One of each construct the notes profile draws, so the second clause has something to count. */
const RICH = '# Heading\n\n- A list item\n- Another\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n`code` and **bold**.\n';

export const scenarios: Scenario[] = [
  {
    name: 'readOnly: the content element is not editable, and without the option it is',
    run: () =>
      bothWays(PROSE, 'notes', (ro, rw) => {
        /*
         * The **attribute**, not the `contentEditable` property, and the difference is the whole
         * reason this comment exists. jsdom does not implement the IDL property: it reads
         * `undefined` on both surfaces, which fails as "no evidence" rather than as "both
         * editable" and is the right failure to get, since a property that is always undefined
         * cannot tell the two apart either way. CodeMirror writes `contenteditable` as a content
         * attribute from `EditorView.editable`, and the attribute is there to be read.
         */
        const got = {
          readOnly: ro.view.contentDOM.getAttribute('contenteditable'),
          writable: rw.view.contentDOM.getAttribute('contenteditable'),
        };
        return {
          ok: got.readOnly === 'false' && got.writable === 'true',
          detail: `the contenteditable attribute is ${JSON.stringify(got.readOnly)} with readOnly and ${JSON.stringify(got.writable)} without, wanted "false" and "true"`,
        };
      }),
  },
  {
    name: 'readOnly: Enter inserts nothing, where without the option it inserts a line break',
    run: () =>
      bothWays(PROSE, 'notes', (ro, rw) => {
        /*
         * Enter rather than an ordinary character, because jsdom types no text from a keydown and
         * Enter is a *command*: `insertNewlineAndIndent` consults `EditorState.readOnly` and
         * declines, so the writable side moves and the read-only side does not. That difference is
         * what makes this case able to fail on an unwired option.
         */
        const tookRo = keydown(ro.view, 'Enter');
        const tookRw = keydown(rw.view, 'Enter');
        const after = { readOnly: ro.surface.value(), writable: rw.surface.value() };
        return {
          ok: after.readOnly === PROSE && after.writable !== PROSE,
          detail: `a binding ${tookRo ? 'took' : 'declined'} Enter with readOnly, leaving ${JSON.stringify(after.readOnly)}; ${tookRw ? 'took' : 'declined'} it without, leaving ${JSON.stringify(after.writable)}. Wanted the first unchanged and the second not`,
        };
      }),
  },
  {
    name: 'readOnly: a paste inserts nothing, where without the option it inserts the text',
    run: () =>
      bothWays(PROSE, 'notes', (ro, rw) => {
        paste(ro.view, ' pasted');
        paste(rw.view, ' pasted');
        const after = { readOnly: ro.surface.value(), writable: rw.surface.value() };
        return {
          ok: after.readOnly === PROSE && after.writable !== PROSE,
          detail: `after the same paste: readOnly ${JSON.stringify(after.readOnly)}, writable ${JSON.stringify(after.writable)}. Wanted the first unchanged and the second not`,
        };
      }),
  },
  {
    name: 'readOnly: a value from the consumer still goes in, because that is not somebody typing',
    run: () =>
      bothWays(PROSE, 'notes', (ro) => {
        /*
         * The clause `README.md` now states, asserted because it is public documentation rather
         * than because it was in doubt. `EditorState.readOnly` is consulted by commands, so it
         * stops a keystroke and a paste and does not stop a dispatch, which is what `setValue` is.
         * A consumer whose server hands them a new value must get it into a read-only surface, or
         * the option is unusable for the display case it exists for.
         */
        const next = 'A different line of prose.';
        ro.surface.setValue(next);
        const got = ro.surface.value();
        return { ok: got === next, detail: `after setValue on a readOnly surface, value() got ${JSON.stringify(got)}, wanted ${JSON.stringify(next)}` };
      }),
  },
  {
    name: 'readOnly: the surface draws what the profile carries, element for element',
    run: () =>
      bothWays(RICH, 'notes', (ro, rw) => {
        /*
         * The half of R9 that says what must *not* change. "Removes the ability to edit rather than
         * hiding the controls" is only a promise if something reads the drawing, and the cheapest
         * honest reading is the two surfaces against each other: same tags in the same order and
         * the same text, for the same value.
         */
        const shape = (view: EditorView): string =>
          [...view.contentDOM.querySelectorAll('*')].map((n) => n.tagName.toLowerCase()).join(',');
        const got = { ro: shape(ro.view), rw: shape(rw.view) };
        const text = { ro: ro.view.contentDOM.textContent ?? '', rw: rw.view.contentDOM.textContent ?? '' };
        if (got.rw.length === 0) return { ok: false, detail: 'the writable surface drew no elements, so there was nothing to compare against' };
        return {
          ok: got.ro === got.rw && text.ro === text.rw,
          detail:
            got.ro === got.rw && text.ro === text.rw
              ? `both surfaces drew the same ${got.ro.split(',').length} element(s) over the same ${text.ro.length} characters`
              : `readOnly drew ${got.ro.split(',').length} element(s) and writable ${got.rw.split(',').length}; text lengths ${text.ro.length} and ${text.rw.length}`,
        };
      }),
  },
];
