/*
 * The first click into a rendered surface puts the caret at the text that was under the pointer.
 *
 * `mountFocus.ts` is the half that carries the pointer's coordinates into the new editor, and the
 * coordinates turned out to be the wrong thing to carry: the editor draws the value with its own
 * padding and, in a `notes` surface, its own side gutter, so the same screen point is over
 * different text in the two states. Measured in Chromium, a click on the second paragraph of a
 * rendered value put the caret in the first paragraph of the editor. So the rendered state is now
 * asked which character is under the pointer at `pointerdown`, before it is replaced, and the
 * editor is told where that character is in what it draws.
 *
 * **What jsdom can and cannot see.** It has no layout, so it cannot say which character is under a
 * point, and `caretPositionFromPoint` is replaced here for the length of a scenario. That stands in
 * for the one question layout answers and for nothing else: the count of characters before the
 * answer, the editor's search for that count among what it drew, and the caret landing there are
 * all the product's own code running on real DOM. `scripts/check-mount-click.mjs` is where the
 * geometry half is clicked in Chromium.
 *
 * Each case names the source index it expected and the one it got, because "the caret is
 * somewhere sensible" is the bar this replaced and it could not fail.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

const VALUE =
  'The first paragraph of the value.\n\n' +
  'A second paragraph, the one a person clicks into.\n\n' +
  'The third, with **bold** and a [link](https://example.com) in it.\n';

const G: typeof globalThis & { MouseEvent: typeof MouseEvent } = globalThis as never;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * The document as a bag of optional properties, so the caret query can be stood in for and removed
 * again. jsdom has none, and the DOM's own types declare it as always present.
 */
type Doc = { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };

/** The rendered text node holding `needle`, and the offset of its first character in that node. */
function findRendered(root: HTMLElement, needle: string): { node: Text; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const i = n.data.indexOf(needle);
    if (i >= 0) return { node: n, offset: i };
  }
  return null;
}

/**
 * Mount `value`, answer the caret query with the rendered position of `needle`, click, and report
 * the source index the caret ended at against the one `needle` starts at.
 */
async function clickOn(
  value: string,
  needle: string,
  profile: 'notes' | 'field' = 'notes',
  /** Point at the end of `needle` rather than its start, which is a click past the end of a line. */
  pastEnd = false
): Promise<ScenarioResult> {
  const doc = document as unknown as Doc;
  const had = Object.prototype.hasOwnProperty.call(doc, 'caretPositionFromPoint');
  const original = doc.caretPositionFromPoint;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = mount(parent, { value, profile });
  try {
    const at = findRendered(surface.element, needle);
    if (!at) return { ok: false, detail: `${JSON.stringify(needle)} is not in the rendered surface, so nothing was clicked` };
    let asked = 0;
    const offset = pastEnd ? at.offset + needle.length : at.offset;
    doc.caretPositionFromPoint = () => {
      asked++;
      return { offsetNode: at.node, offset };
    };
    surface.element.dispatchEvent(new G.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    surface.element.dispatchEvent(new G.MouseEvent('focusin', { bubbles: true }) as unknown as Event);
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    const view = EditorView.findFromDOM(surface.element);
    const head = view ? view.state.selection.main.head : null;
    const wanted = value.indexOf(needle) + (pastEnd ? needle.length : 0);
    return {
      ok: asked === 1 && head === wanted,
      detail: `caret at ${head}, wanted ${wanted}, the ${pastEnd ? 'end' : 'start'} of ${JSON.stringify(needle)}; the caret query was asked ${asked} time(s)`,
    };
  } finally {
    surface.destroy();
    parent.remove();
    if (had) doc.caretPositionFromPoint = original;
    else delete doc.caretPositionFromPoint;
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'mount: a first click on the second paragraph puts the caret in the second paragraph',
    run: () => clickOn(VALUE, 'one a person clicks'),
  },
  {
    name: 'mount: a first click at the start of a paragraph lands at its start, not the end of the one above',
    run: () => clickOn(VALUE, 'The third'),
  },
  {
    name: 'mount: a first click past the end of a paragraph lands at its end, not the start of the next',
    /*
     * The count alone cannot tell these apart: only whitespace lies between the end of one
     * paragraph and the start of the next, so both are the same number of characters in. What
     * separates them is which side of the count the rendered point was on, and this is the case
     * that fails if that is dropped.
     */
    run: () => clickOn(VALUE, 'The first paragraph of the value.', 'notes', true),
  },
  {
    name: 'mount: a first click on bold text lands inside the markers the editor hides',
    run: () => clickOn(VALUE, 'bold'),
  },
  {
    name: 'mount: a first click on a link lands on its text, past the bracket the editor hides',
    run: () => clickOn(VALUE, 'link'),
  },
  {
    name: 'mount: a first click into a field lands on the word under it',
    run: () => clickOn('Ship the **field** fix before the cut', 'before', 'field'),
  },
  {
    name: 'mount: a first click with no caret query falls back to the coordinates, as before',
    run: async () => {
      /*
       * The complement: an engine with neither query, which is what jsdom is when nothing stands
       * in for it. The click still builds the editor and the caret is placed by `posAtCoords`,
       * which here has no layout to read and answers the start. `mountFocus.ts` asserts the
       * coordinate path itself; this asserts that the text path stepping aside leaves it reached.
       */
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const surface = mount(parent, { value: VALUE, profile: 'notes' });
      try {
        const doc = document as unknown as Doc;
        if (typeof doc.caretPositionFromPoint === 'function') return { ok: false, detail: 'this jsdom has a caret query, so the fallback was not reached' };
        surface.element.dispatchEvent(new G.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
        surface.element.dispatchEvent(new G.MouseEvent('focusin', { bubbles: true }) as unknown as Event);
        await settle();
        const view = EditorView.findFromDOM(surface.element);
        return { ok: surface.editing() && !!view, detail: `editing ${surface.editing()}, caret at ${view?.state.selection.main.head}` };
      } finally {
        surface.destroy();
        parent.remove();
      }
    },
  },
  {
    name: 'field: the editor does not wrap, so a long value is one line that scrolls; notes still wraps',
    run: async () => {
      /*
       * The configuration half of a one-line `field`, which is what jsdom can see. The heights it
       * produces are measured in Chromium, where a 40-character title in a 280px box was two lines
       * tall before this and is one line now. `notes` is the control: prose in a description wraps,
       * and a change that took wrapping off every surface would pass the field half alone.
       */
      const read = async (profile: 'field' | 'notes'): Promise<boolean | null> => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const surface = mount(parent, { value: 'A title long enough that it would wrap in a narrow box if it could', profile });
        try {
          surface.focus();
          await settle();
          return EditorView.findFromDOM(surface.element)?.lineWrapping ?? null;
        } finally {
          surface.destroy();
          parent.remove();
        }
      };
      const field = await read('field');
      const notes = await read('notes');
      return { ok: field === false && notes === true, detail: `field wraps: ${field}; notes wraps: ${notes}; wanted false and true` };
    },
  },
];
