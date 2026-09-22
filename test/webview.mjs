/*
 * The real webview, booted in its own jsdom window, for the checks that need to see
 * what `src/webview/main.ts` does with a document the host sends it.
 *
 * The sync suite's `mountWebview` is a stand-in built on CodeMirror's state alone, so
 * a fault in how `main.ts` takes a document in cannot show up there. This bundles
 * `main.ts` itself, evaluates it in a page shaped like the one the host serves, and
 * talks to it only the way the host does: messages in through `window`, messages out
 * through `acquireVsCodeApi().postMessage`.
 *
 * Typing is a transaction on the page's own editor, found through the DOM the way
 * CodeMirror's `EditorView.findFromDOM` finds it. jsdom has no input methods or layout, so this is the
 * edit a keystroke produces, not the keystroke itself.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

let bundled;

/** `main.ts` and everything it imports, as one script for the page. */
function webviewCode() {
  bundled ??= esbuild.buildSync({
    entryPoints: [path.join(here, '..', 'src', 'webview', 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'error',
  }).outputFiles[0].text;
  return bundled;
}

const CONFIG = { contentWidth: '708px', revealSyntaxOnLine: false, doubleClickToEditSource: false };

/**
 * Load the webview into a fresh page. `onPost` receives every message the webview
 * sends the host, as it sends it; each message is also kept in `posted`.
 */
export function bootWebview(onPost = () => {}) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="toolbar"></div><div id="editor"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  // jsdom has no layout, and CodeMirror's measuring asks ranges for rectangles.
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  const posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      posted.push(message);
      onPost(message);
    },
    getState: () => undefined,
    setState: () => {},
  });
  window.eval(webviewCode());

  const view = () => {
    const content = window.document.querySelector('.cm-content');
    // What `EditorView.findFromDOM` reads: the tile CodeMirror hangs on its content DOM.
    const found = content?.cmTile?.root?.view;
    if (!found) throw new Error('the webview has no editor yet');
    return found;
  };

  const webview = {
    window,
    posted,
    /** A message from the host, delivered the way the webview's listener receives it. */
    receive(data) {
      window.dispatchEvent(new window.MessageEvent('message', { data }));
    },
    /** Host to webview: the first document, as `init` carries it. */
    init(text) {
      webview.receive({ type: 'init', text, config: CONFIG, fileName: 'notes.md', resourceBaseUri: 'https://webview/ws/' });
    },
    /** Host to webview: the document changed. */
    setContent(text, tookTypedText) {
      webview.receive({ type: 'setContent', text, tookTypedText });
    },
    /**
     * A key pressed in the editor, as the keymap receives it: `press('Mod-z')`.
     *
     * CodeMirror reads `Mod` as Cmd on a Mac and as Ctrl everywhere else, from the
     * platform the page reports, and jsdom reports none. So both are sent, and only
     * the one this build is bound to matches anything; the check is whether the
     * document moved, and the second is skipped once the first has moved it.
     */
    press(key) {
      const v = view();
      const before = v.state.doc.toString();
      const parts = key.split('-');
      const name = parts.pop();
      for (const mod of ['ctrlKey', 'metaKey']) {
        const init = { key: name, bubbles: true, cancelable: true };
        for (const part of parts) {
          if (part === 'Mod') init[mod] = true;
          if (part === 'Ctrl') init.ctrlKey = true;
          if (part === 'Shift') init.shiftKey = true;
          if (part === 'Alt') init.altKey = true;
        }
        v.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', init));
        if (v.state.doc.toString() !== before) return true;
      }
      return false;
    },
    /** The text the webview holds. */
    doc: () => view().state.doc.toString(),
    /** The lines the webview shows. */
    lines: () => view().state.doc.toString().split('\n'),
    /** Where the caret is. */
    caret: () => view().state.selection.main.head,
    /** Put the caret somewhere, as clicking does. */
    click(at) {
      view().dispatch({ selection: { anchor: at } });
    },
    /** Select from `anchor` to `head`, as dragging across the text does. */
    select(anchor, head) {
      view().dispatch({ selection: { anchor, head } });
    },
    /** The page the webview is running in, for the parts of it that are not text. */
    document: () => window.document,
    /** A character typed at the caret, which the webview posts to the host as its whole text. */
    type(insert) {
      const v = view();
      v.dispatch(v.state.replaceSelection(insert), { userEvent: 'input.type' });
    },
    /** The `edit` messages the webview has sent, oldest first. */
    edits: () => posted.filter((m) => m.type === 'edit').map((m) => m.text),
    close: () => window.close(),
  };
  return webview;
}
