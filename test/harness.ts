/*
 * Shared harness for the prose editing tests: mounts the editor with the same
 * extensions the webview uses and drives it through its own key handlers.
 */

import { Extension, EditorSelection } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { editorExtensions } from '../src/webview/editorExtensions';

export interface Scenario {
  name: string;
  run: () => Promise<boolean> | boolean;
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
    const event = new G.KeyboardEvent('keydown', {
      key,
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
