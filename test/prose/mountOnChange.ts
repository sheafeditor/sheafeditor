/*
 * When `onChange` is called, counted rather than sampled.
 *
 * The package's contract is one call per change a person makes, with the whole text, so a consumer
 * can save on each call, debounce it, or save on blur. `mountRoundTrip.ts` collects every call and
 * reads only the last, which says what the callback is handed and nothing about how often; this
 * file is the count.
 *
 * **The other half is the call that must not happen.** A `setValue` is the consumer's own write.
 * Reporting it back is an echo, and a consumer saving from `onChange` would send their server's
 * value straight back to it. It was also inconsistent: before the first focus there is no editor
 * and a `setValue` reported nothing, and after it the same call was reported. Both states are
 * asserted, because the defect was the difference between them.
 *
 * The typing is dispatched as the editor's own input transactions, one per character, which is
 * what a person's keystrokes produce. jsdom types no text from a keydown, so that is the closest a
 * suite without a real keyboard gets, and the count is the property under test rather than the
 * keyboard.
 */

import { Scenario, ScenarioResult } from '../harness';
import { EditorView } from '@codemirror/view';
import { mount } from '../../src/lib/index';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

type Surface = ReturnType<typeof mount>;

async function withEditor(
  profile: 'field' | 'notes',
  fn: (surface: Surface, view: EditorView, calls: string[]) => Promise<ScenarioResult> | ScenarioResult
): Promise<ScenarioResult> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const calls: string[] = [];
  const surface = mount(parent, { value: 'Start', profile, onChange: (next) => calls.push(next) });
  try {
    surface.focus();
    await settle();
    if (!surface.editing()) return { ok: false, detail: 'no editor was built, so nothing here was tested' };
    const view = EditorView.findFromDOM(surface.element);
    if (!view) return { ok: false, detail: 'the editor was built but no view could be found in it' };
    return await fn(surface, view, calls);
  } finally {
    surface.destroy();
    parent.remove();
  }
}

/** Type `text` at the end of the document, one input transaction per character. */
function type(view: EditorView, text: string): void {
  for (const ch of text) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: ch }, userEvent: 'input.type' });
  }
}

const cases = (profile: 'field' | 'notes'): Scenario[] => [
  {
    name: `${profile}: onChange is called once for each character typed, with the whole text each time`,
    run: () =>
      withEditor(profile, (surface, view, calls) => {
        type(view, ' typed');
        const wanted = ['Start ', 'Start t', 'Start ty', 'Start typ', 'Start type', 'Start typed'];
        const ok = calls.length === wanted.length && calls.every((c, i) => c === wanted[i]) && surface.value() === wanted[5];
        return { ok, detail: `onChange was called ${calls.length} time(s) for 6 characters: ${JSON.stringify(calls)}` };
      }),
  },
  {
    name: `${profile}: a setValue into a built editor is not reported back through onChange`,
    run: () =>
      withEditor(profile, (surface, view, calls) => {
        type(view, '!');
        if (calls.length !== 1) return { ok: false, detail: `typing one character made ${calls.length} call(s), so the listener is not the one this case reads` };
        surface.setValue('From the server');
        const after = calls.length - 1;
        const got = surface.value();
        return {
          ok: after === 0 && got === 'From the server',
          detail: `the setValue made ${after} call(s) and value() is ${JSON.stringify(got)}; wanted 0 and the value that was set`,
        };
      }),
  },
  {
    name: `${profile}: typing after a setValue is reported, with the value that was set under it`,
    run: () =>
      withEditor(profile, (surface, view, calls) => {
        surface.setValue('Set');
        type(view, 'x');
        return {
          ok: calls.length === 1 && calls[0] === 'Setx',
          detail: `onChange got ${JSON.stringify(calls)}, wanted exactly ["Setx"]`,
        };
      }),
  },
];

export const scenarios: Scenario[] = [
  ...cases('field'),
  ...cases('notes'),
  {
    name: 'mount: a setValue before the editor is built is not reported either',
    run: async () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const calls: string[] = [];
      const surface = mount(parent, { value: 'Start', profile: 'notes', onChange: (next) => calls.push(next) });
      try {
        surface.setValue('From the server');
        await settle();
        return {
          ok: calls.length === 0 && !surface.editing() && surface.value() === 'From the server',
          detail: `${calls.length} call(s), editing ${surface.editing()}, value() ${JSON.stringify(surface.value())}`,
        };
      } finally {
        surface.destroy();
        parent.remove();
      }
    },
  },
];
