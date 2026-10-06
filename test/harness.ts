/*
 * Shared harness for the prose editing tests: mounts the editor with the same
 * extensions the webview uses and drives it through its own key handlers.
 */

import { Extension, EditorSelection } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { editorExtensions } from '../src/webview/editorExtensions';
import katex from 'katex';
import { provideMaths } from '../src/webview/maths';
import { provideEmoji } from '../src/webview/emoji';
import { EMOJI_PAIRS } from '../src/webview/emojiTable';

export interface ScenarioResult {
  ok: boolean;
  detail?: string;
}

export interface Scenario {
  name: string;
  /** True when the check passed, or `{ ok, detail }` when it can say how it failed. */
  run: () => Promise<boolean | ScenarioResult> | boolean | ScenarioResult;
}

export interface Prose {
  view: EditorView;
  doc: () => string;
  /** Select from `anchor` to `head` (a caret when `head` is omitted). */
  select: (anchor: number, head?: number) => void;
  /** Press a key spec such as `Mod-Shift-h` through the editor's keymaps; true when a binding handled it. */
  press: (spec: string) => boolean;
  destroy: () => void;
}

const G: any = globalThis;

export function mountProse(doc: string, extra: Extension[] = []): Prose {
  // KaTeX and the emoji table are both fetched on demand in a real host, and these checks mount
  // and assert in the same breath, so a dynamic import has not resolved by the time a scenario
  // looks at an equation or a shortcode. Handing them over here says "these are available in this
  // check" once, for every suite that mounts through this, and leaves the shipping path lazy.
  provideMaths(katex);
  provideEmoji(EMOJI_PAIRS);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [editorExtensions(() => {}), ...extra] }),
    parent,
  });
  const press = (spec: string): boolean => {
    const parts = spec.split('-');
    const key = parts.pop() as string;
    const has = (m: string): boolean => parts.includes(m);
    /*
     * A letter held with Shift arrives from a real keyboard as the capital, with the
     * letter's own `keyCode` beside it, and CodeMirror needs both: it looks the plain
     * name up first and only tries the Shift- form once that misses. Sending `k` for
     * Mod-Shift-K instead ran whatever `Mod-k` is bound to, so a shortcut could be
     * "pressed" in a test and a different command would answer. `Mod-Shift-z` only
     * reached Redo because Undo had nothing left to undo and declined the key.
     */
    const letter = key.length === 1 && /[a-z]/i.test(key);
    const event = new G.KeyboardEvent('keydown', {
      key: letter && has('Shift') ? key.toUpperCase() : key,
      keyCode: letter ? key.toUpperCase().charCodeAt(0) : 0,
      bubbles: true,
      cancelable: true,
      // Outside macOS, CodeMirror reads Mod as Ctrl.
      ctrlKey: has('Mod') || has('Ctrl'),
      metaKey: has('Meta'),
      shiftKey: has('Shift'),
      altKey: has('Alt'),
    });
    return runScopeHandlers(view, event, 'editor');
  };
  return {
    view,
    doc: () => view.state.doc.toString(),
    select: (anchor, head) => view.dispatch({ selection: EditorSelection.single(anchor, head ?? anchor) }),
    press,
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}
