/*
 * Where the caret lands on the first click into a mounted surface.
 *
 * A mounted surface is rendered HTML until somebody focuses it, and the focus is what builds the
 * editor. So the click that builds it is the one click whose position has nowhere to go unless
 * something carries it: `focusin` has no coordinates, and the new view starts at its default
 * selection, which is index 0. A person's first sentence in a description went to the top of it,
 * and every click after that was correct, which is the hardest shape of defect to notice in your
 * own product.
 *
 * **What these can and cannot see.** jsdom has no layout, so the coordinate conversion itself is
 * not checkable here: `posAtCoords` reads line geometry, and with every rectangle empty it answers
 * nothing useful whatever the point. `scripts/check-mount-click.mjs` is where that half is
 * measured, in Chromium, by clicking and printing the index. What is left for jsdom is the half
 * that is wiring rather than geometry, and it is the half that was missing: that the pointer's
 * position is taken from the gesture at all, that it reaches the new view's selection, that the
 * deferred path taken when the view has not been measured yet also reaches it, and that a focus
 * with no pointer behind it does not inherit a position.
 *
 * So `posAtCoords` is replaced for the length of a scenario, which stands in for layout and for
 * nothing else. The scenarios assert on the index that comes back out of the selection, and each
 * reports the index it got rather than a verdict, because 0 is both the answer the defect gives
 * and the answer an unlaid-out view gives, and a check that cannot print them apart invites the
 * reader to assume which one it saw.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

/** Three paragraphs, so a position in the middle of the value is not a position in its only line. */
const VALUE = 'The first paragraph.\n\nThe second paragraph.\n\nThe third paragraph.\n';

/** A point no real pointer is at, which is the point the stand-in below answers for. */
const POINT = { x: 120, y: 90 };

/** The index the stand-in maps `POINT` to. Inside the second paragraph, and nowhere near 0. */
const MAPPED = 30;

const G: typeof globalThis & { MouseEvent: typeof MouseEvent } = globalThis as never;

/**
 * Run `fn` with `posAtCoords` answering `MAPPED` for `POINT`, and count what it was asked.
 *
 * `answers` is how many of the early calls return `null` before `MAPPED` arrives, which is what
 * a view that has not been measured yet does: the precise form has no geometry to read. One of
 * them exercises the immediate path and the deferred path in turn, from the same stand-in.
 */
async function withCoords(
  nulls: number,
  fn: (surface: ReturnType<typeof mount>, parent: HTMLElement) => Promise<ScenarioResult>
): Promise<ScenarioResult> {
  const original = EditorView.prototype.posAtCoords;
  let asked = 0;
  (EditorView.prototype as { posAtCoords: unknown }).posAtCoords = function (
    coords: { x: number; y: number },
    precise = true
  ): number | null {
    asked++;
    if (coords.x !== POINT.x || coords.y !== POINT.y) return precise ? null : 0;
    if (asked <= nulls) return precise ? null : 0;
    return MAPPED;
  };
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value: VALUE, profile: 'notes' });
  try {
    const out = await fn(surface, parent);
    return { ...out, detail: `${out.detail ?? ''}${out.detail ? ', ' : ''}posAtCoords asked ${asked} time(s)` };
  } finally {
    surface.destroy();
    parent.remove();
    (EditorView.prototype as { posAtCoords: unknown }).posAtCoords = original;
  }
}

/** The index the built editor's caret is at, or `null` when there is no editor to ask. */
function caret(surface: ReturnType<typeof mount>): number | null {
  const view = EditorView.findFromDOM(surface.element);
  return view ? view.state.selection.main.head : null;
}

/** Click `surface` at `POINT` the way a browser does: the pointer event, then the focus it causes. */
function clickAt(surface: ReturnType<typeof mount>): void {
  surface.element.dispatchEvent(
    new G.MouseEvent('pointerdown', { bubbles: true, clientX: POINT.x, clientY: POINT.y })
  );
  surface.element.dispatchEvent(new G.MouseEvent('focusin', { bubbles: true }) as unknown as Event);
}

/** Let the dynamic import of the editor, and any measure it queued, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

export const scenarios: Scenario[] = [
  {
    name: 'mount: a click builds the editor',
    run: async () =>
      withCoords(0, async (surface) => {
        clickAt(surface);
        await settle();
        return { ok: surface.editing(), detail: `editing ${surface.editing()}` };
      }),
  },
  {
    name: 'mount: the first click reaches the selection',
    run: async () =>
      withCoords(0, async (surface) => {
        clickAt(surface);
        await settle();
        const at = caret(surface);
        return { ok: at === MAPPED, detail: `caret at ${at}, wanted ${MAPPED}` };
      }),
  },
  {
    name: 'mount: an unmeasured view still reaches it',
    run: async () =>
      /*
       * One `null` from the precise call, which is what a view built and focused in the same turn
       * answers before it has measured. The position has to arrive after the measure instead, and
       * this is the scenario that fails if that path is dropped for the one-line version.
       */
      withCoords(1, async (surface) => {
        clickAt(surface);
        await settle();
        const at = caret(surface);
        return { ok: at === MAPPED, detail: `caret at ${at}, wanted ${MAPPED}` };
      }),
  },
  {
    name: 'mount: a focus with no pointer starts at 0',
    run: async () =>
      /*
       * The complement, and it is the one that would fail if the position were remembered rather
       * than consumed. A consumer's `surface.focus()` and a Tab into the element point at nothing,
       * and the start of the value is the right answer for both.
       */
      withCoords(0, async (surface) => {
        surface.focus();
        await settle();
        const at = caret(surface);
        return { ok: at === 0, detail: `caret at ${at}, wanted 0` };
      }),
  },
];
