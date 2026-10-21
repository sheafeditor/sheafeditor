/*
 * The real webview, booted in its own jsdom window, for the checks that need to see
 * what the shipping editor does with a document the host sends it.
 *
 * The sync suite's own `mountWebview` stand-in is built on CodeMirror's state alone, so a fault in
 * how the editor takes a document in cannot show up there. `bootWebview` bundles `main.ts` itself,
 * evaluates it in a page shaped like the one the host serves, and talks to it only the way the host
 * does: messages in through `window`, messages out through `acquireVsCodeApi().postMessage`.
 *
 * Typing is a transaction on the page's own editor, found through the DOM the way
 * CodeMirror's `EditorView.findFromDOM` finds it. jsdom has no input methods or layout, so this is the
 * edit a keystroke produces, not the keystroke itself.
 *
 * Two more boot the mount entry, `src/webview/mount.ts`, which is what `main.ts` calls.
 * `loadMountEntry` loads it in a page with no `acquireVsCodeApi` and no `#editor` and mounts
 * nothing, so a check can assert that loading the editor changes nothing until somebody asks for
 * one. `bootTwoMounts` puts two editors in one window, each with its own elements and its own host,
 * which is the only way to see state a module keeps for one editor rather than for the page.
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

let bundledMount;

/**
 * `mount.ts` and everything it imports, as one script exposing `SheafMount.mountWebview`.
 *
 * The entry rather than the page: this is what lets a check put **two** editors in one window, and
 * what lets one assert that loading the editor touches nothing until somebody mounts it. Bundling
 * `main.ts` could do neither, because `main.ts` is the page and reads the `acquireVsCodeApi` global
 * and two elements by id while it loads.
 */
function mountCode() {
  bundledMount ??= esbuild.buildSync({
    entryPoints: [path.join(here, '..', 'src', 'webview', 'mount.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SheafMount',
    /*
     * The assignment rather than the `globalName` alone. esbuild emits `"use strict"` at the top,
     * and a `var` in strict-mode `eval` binds inside that call rather than on the window, so the
     * page saw no `SheafMount` and the first run of these checks failed on the instrument.
     */
    footer: { js: 'globalThis.SheafMount = SheafMount;' },
    platform: 'browser',
    logLevel: 'error',
  }).outputFiles[0].text;
  return bundledMount;
}

let bundledTwo;

/**
 * The mount entry plus the two CodeMirror handles a check needs to reach inside one editor's own
 * update. `mountWebview` alone would put two editors in one window; `StateEffect.appendConfig` and
 * `EditorView.updateListener` are what let a check type into the second editor *during* the first
 * one's write, which is the only moment the re-entrancy flag is up.
 *
 * Written as `stdin` rather than as a file beside this one, so the repository gains no module whose
 * only reader is a bundler. A file here would also be a path no gate subject claims, which
 * `check-gate-tiers.mjs` refuses, and rightly: a tracked file nothing claims runs the cheap tier
 * alone.
 *
 * Separate from `mountCode` above, so the claim that loading the editor touches nothing is measured
 * against `src/webview/mount.ts` and nothing added for a test.
 */
function twoMountCode() {
  bundledTwo ??= esbuild.buildSync({
    stdin: {
      contents: [
        "export { mountWebview } from '../src/webview/mount';",
        // How many reads could not tell which mount they belonged to, so a check can assert that
        // none did while it ran. A fallback is right on a page with one editor and the defect on a
        // page with two, and the count is the only thing that tells a fallback from a resolution.
        "export { fallbackCount } from '../src/webview/mountScope';",
        "export { EditorView } from '@codemirror/view';",
        "export { StateEffect } from '@codemirror/state';",
      ].join('\n'),
      resolveDir: here,
      sourcefile: 'two-mounts.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SheafMount',
    footer: { js: 'globalThis.SheafMount = SheafMount;' },
    platform: 'browser',
    logLevel: 'error',
  }).outputFiles[0].text;
  return bundledTwo;
}

const CONFIG = { contentWidth: '708px', revealSyntaxOnLine: false, doubleClickToEditSource: false };

/** A jsdom window shaped enough for CodeMirror, with the page body `html` asks for. */
function page(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom has no layout, and CodeMirror's measuring asks ranges for rectangles.
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  return window;
}

/**
 * Load the mount entry into a page with **no** `acquireVsCodeApi` and **no** `#editor`, and mount
 * nothing.
 *
 * What it returns is what the page looked like before and after loading, so a caller can assert that
 * loading it changed nothing. `error` is the throw, where loading it threw.
 */
export function loadMountEntry() {
  const window = page('<p id="already-here">untouched</p>');
  const before = window.document.body.innerHTML;
  let error = null;
  try {
    window.eval(mountCode());
  } catch (e) {
    error = e;
  }
  const after = window.document.body.innerHTML;
  return {
    window,
    before,
    after,
    error,
    mounted: typeof window.SheafMount?.mountWebview === 'function',
    close: () => window.close(),
  };
}

/**
 * Two editors in one window, each with its own root, toolbar and host.
 *
 * Each returned editor carries the messages its own host was sent, which is the whole point: a
 * single-editor page cannot tell a module keeping state against the mount from one keeping it at
 * module scope, because there is nothing for the second to be confused with.
 */
export function bootTwoMounts() {
  const window = page(
    '<div id="tb-a"></div><div id="ed-a"></div><div id="ov-a"></div>' +
      '<div id="tb-b"></div><div id="ed-b"></div><div id="ov-b"></div>'
  );
  window.eval(twoMountCode());
  const { document } = window;
  const make = (suffix) => {
    const posted = [];
    const editor = window.SheafMount.mountWebview({
      root: document.getElementById(`ed-${suffix}`),
      toolbar: document.getElementById(`tb-${suffix}`),
      overlay: document.getElementById(`ov-${suffix}`),
      post: (message) => posted.push(message),
    });
    const view = () => {
      const content = document.getElementById(`ed-${suffix}`).querySelector('.cm-content');
      const found = content?.cmTile?.root?.view;
      if (!found) throw new Error(`mount ${suffix} has no editor yet`);
      return found;
    };
    return {
      editor,
      posted,
      view,
      init: (text, extra = {}) =>
        editor.receive({ type: 'init', text, config: CONFIG, fileName: `${suffix}.md`, resourceBaseUri: 'https://webview/ws/', ...extra }),
      setContent: (text, tookTypedText) => editor.receive({ type: 'setContent', text, tookTypedText }),
      doc: () => view().state.doc.toString(),
      type: (insert) => {
        const v = view();
        v.dispatch(v.state.replaceSelection(insert), { userEvent: 'input.type' });
      },
      edits: () => posted.filter((m) => m.type === 'edit').map((m) => m.text),
    };
  };
  const a = make('a');
  const b = make('b');
  return {
    window,
    a,
    b,
    /**
     * Run `fn` once, from inside the next document change in `which`'s own editor.
     *
     * This is how a check reaches the moment a module is in the middle of something. An update
     * listener appended after the mount, so only the change the check is about is caught.
     */
    duringNextChangeIn(which, fn) {
      const { EditorView, StateEffect } = window.SheafMount;
      let done = false;
      which.view().dispatch({
        effects: StateEffect.appendConfig.of(
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || done) return;
            done = true;
            fn();
          })
        ),
      });
      return () => done;
    },
    /** How many reads in this page have fallen back with both mounts open. */
    fallbacks: () => window.SheafMount.fallbackCount(),
    close: () => {
      a.editor.destroy();
      b.editor.destroy();
      window.close();
    },
  };
}

/**
 * Load the webview into a fresh page. `onPost` receives every message the webview
 * sends the host, as it sends it; each message is also kept in `posted`.
 */
export function bootWebview(onPost = () => {}) {
  const window = page('<div id="toolbar"></div><div id="editor"></div>');
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
