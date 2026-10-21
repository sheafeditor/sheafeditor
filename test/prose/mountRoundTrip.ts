/*
 * What a mounted surface hands back, for a document whose line endings are not the editor's.
 *
 * The library is sold on one sentence: the value you put in comes back as the same bytes. That
 * held before anything focused the surface and stopped holding the moment an editor existed,
 * because the editor holds every ending as a single `\n`. CodeMirror's own default split consumes
 * `\r\n` and a lone `\r` when it builds a document, so a CRLF file read back out of the editor
 * came back converted with nothing typed, and three of the corpus's own files changed on a click.
 *
 * **jsdom can see all of this, which is why it is here rather than in Chromium.** Nothing below
 * depends on layout, geometry or a real pointer: the claim is about the characters that come out
 * of `value()`, and the editor builds and holds a document under jsdom exactly as it does
 * anywhere. The sibling file `mountFocus.ts` is the opposite case, where the half that mattered
 * was geometry and had to go to `scripts/check-mount-click.mjs`.
 *
 * **Why these scenarios mount rather than calling `planEdit` directly.** `planEdit` was always
 * correct and `src/lib/` simply never called it, so a case over that function alone would have
 * passed on the defect and on the fix alike. The thing worth asserting is that the surface
 * reaches it, which means going through `mount`.
 *
 * Each scenario reports the bytes it got rather than a verdict, because "the endings converted"
 * and "the document came back empty" both read as a failure and want different fixes.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Mount `value`, focus it so the editor is built, and hand the surface to `fn`.
 *
 * The focus is the whole point: before it there is no editor and `value()` returns the string it
 * was given, which is why this defect measured "equal" in every check that never clicked.
 */
async function withEditor(
  value: string,
  fn: (surface: ReturnType<typeof mount>) => Promise<ScenarioResult>,
  profile: 'notes' | 'field' = 'notes'
): Promise<ScenarioResult> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value, profile });
  try {
    surface.focus();
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    return await fn(surface);
  } finally {
    surface.destroy();
    parent.remove();
  }
}

/** `text` with its endings written so a failure is readable rather than invisible. */
const shown = (text: string): string => text.replace(/\r\n/g, '<CRLF>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');

/** Type `what` at the end of the editor's document, the way a person adds to a line. */
function typeAtEnd(surface: ReturnType<typeof mount>, what: string): void {
  const view = EditorView.findFromDOM(surface.element);
  if (!view) throw new Error('no editor to type into');
  view.dispatch({ changes: { from: view.state.doc.length, insert: what } });
}

const CRLF = 'One line.\r\nTwo lines.\r\nThree lines.\r\n';
const LONE_CR = 'One line.\rTwo lines.\rThree lines.\r';
const MIXED = 'Crlf here.\r\nLf here.\nLone cr here.\rEnd.\n';
const LF = 'One line.\nTwo lines.\nThree lines.\n';

export const scenarios: Scenario[] = [
  {
    name: 'mount: a CRLF document comes back as CRLF once the editor is built',
    run: async () =>
      withEditor(CRLF, async (surface) => {
        const got = surface.value();
        return { ok: got === CRLF, detail: `got ${shown(got)}, wanted ${shown(CRLF)}` };
      }),
  },
  {
    name: 'mount: a lone-CR document comes back as lone CR',
    run: async () =>
      /*
       * The harder half of the same claim, and the one a file-wide boolean cannot answer: there is
       * no flag that says CR, so this only comes out right because each ending is taken from the
       * span it replaces rather than from an answer about the file.
       */
      withEditor(LONE_CR, async (surface) => {
        const got = surface.value();
        return { ok: got === LONE_CR, detail: `got ${shown(got)}, wanted ${shown(LONE_CR)}` };
      }),
  },
  {
    name: 'mount: a document with mixed endings keeps each one where it was',
    run: async () =>
      withEditor(MIXED, async (surface) => {
        const got = surface.value();
        return { ok: got === MIXED, detail: `got ${shown(got)}, wanted ${shown(MIXED)}` };
      }),
  },
  {
    name: 'mount: an LF document is unchanged, which is the case that already worked',
    run: async () =>
      /*
       * The complement, and it is not decoration. A fix that reached for the endings too eagerly
       * would start writing CRLF into a file that never had one, and this is the only scenario
       * here that would catch it.
       */
      withEditor(LF, async (surface) => {
        const got = surface.value();
        return { ok: got === LF, detail: `got ${shown(got)}, wanted ${shown(LF)}` };
      }),
  },
  {
    name: 'mount: typing into a CRLF document reaches the value and leaves the other endings alone',
    run: async () =>
      /*
       * **The scenario that stops the others passing for the wrong reason.** A `value()` that
       * ignored the editor entirely and returned the string it was given would satisfy every
       * case above, and it would be a surface that never reports what anybody typed. This one
       * fails on that implementation and on the original defect both.
       */
      withEditor(CRLF, async (surface) => {
        typeAtEnd(surface, 'Four.');
        const got = surface.value();
        const wanted = `${CRLF}Four.`;
        return { ok: got === wanted, detail: `got ${shown(got)}, wanted ${shown(wanted)}` };
      }),
  },
  {
    name: 'mount: a field keeps a CRLF document too, not only notes',
    run: async () =>
      /*
       * The same claim in the other profile, because the requirement says both and the scenarios
       * above drive one.
       *
       * **This was predicted to pass before it was first run**, and the reasoning is worth keeping
       * because it is what makes the scenario informative rather than a formality: `upToDate` sits
       * in `mount` and knows nothing about the profile, and the field's one-line rule is a
       * *transaction* filter at `src/lib/editor.ts:87` that fires only where a change inserts more
       * than one line. The initial document is not a change, so the filter never sees it. If this
       * fails, the prediction was wrong and that is a finding rather than a broken test.
       *
       * It deliberately does not call `setValue`. That path flattens breaks to spaces in a field,
       * which is its own open defect, and a scenario reaching it would fail for a reason this
       * change is not about and read as the fix being incomplete.
       */
      withEditor(
        CRLF,
        async (surface) => {
          const got = surface.value();
          return { ok: got === CRLF, detail: `got ${shown(got)}, wanted ${shown(CRLF)}` };
        },
        'field'
      ),
  },
  {
    name: 'mount: onChange is handed the document bytes rather than the editor text',
    run: async () =>
      /*
       * The fourth door, and the one the defect's own diagnosis missed. A consumer that stores
       * what `onChange` gives it stores that, so handing over the editor's text converts the
       * document just as surely as a converted `value()` does, one keystroke later.
       */
      (async () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const seen: string[] = [];
        const surface = mount(parent, { value: CRLF, profile: 'notes', onChange: (next) => seen.push(next) });
        try {
          surface.focus();
          await settle();
          if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
          typeAtEnd(surface, 'Four.');
          await settle();
          const last = seen[seen.length - 1];
          const wanted = `${CRLF}Four.`;
          if (last === undefined) return { ok: false, detail: 'onChange was never called, so this tested nothing' };
          return { ok: last === wanted, detail: `onChange got ${shown(last)}, wanted ${shown(wanted)}` };
        } finally {
          surface.destroy();
          parent.remove();
        }
      })(),
  },
];
