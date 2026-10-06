/*
 * Mount Sheaf's editor under jsdom and read back what a reader sees.
 *
 * Two scripts need the same thing and for the same reason: an answer about the
 * product that only the drawn document can give. `check-render.mjs` asks whether
 * any Markdown is still showing where a construct should have been drawn, and
 * `check-editing.mjs` asks what a keystroke does to the drawn document. Neither
 * question can be answered from the source text, and neither needs a browser.
 *
 * Three things about jsdom have to be worked around, and getting any of them
 * wrong makes a run pass while checking almost nothing:
 *
 *   - There is no layout, so CodeMirror cannot tell how much of a document is on
 *     screen and draws one screenful. `tallViewport` reports a window and an
 *     editor large enough to hold any document, so the viewport takes in all of
 *     it. Lines keep jsdom's zero geometry, so no line is mistaken for a tall one.
 *   - The parser works lazily, to the viewport and then on idle time, which a
 *     script never gives it. `settle` parses to the end and runs the measure pass
 *     CodeMirror would otherwise schedule on an animation frame. Waiting on the
 *     frame instead gives a different answer each run.
 *   - The live preview module defaults to revealing syntax on the caret's line,
 *     and the webview turns that off on load. Left on, the caret's line reads raw
 *     and every check around it is answering a question nobody asked.
 *
 * Nothing here opens a window or downloads anything: the bundle is built with the
 * esbuild already in this checkout.
 */

import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Reported for the window and the editor so the whole document is in the viewport. */
const TALL = 1e7;

/**
 * Build a CommonJS bundle exporting `exports`, a map of local name to the module
 * path it comes from, relative to the repository root. `@codemirror/...` and other
 * package paths are passed through as written.
 */
async function bundleFor(repo, exports, name) {
  const req = createRequire(join(repo, 'package.json'));
  const esbuild = req('esbuild');
  /*
   * A directory of this process's own. It used to be `sheaf-${name}`, a fixed path
   * in the machine-wide temporary directory with nothing in it naming the checkout,
   * so every worktree on this machine wrote the same 3.7 MB `bundle.cjs`. Two runs
   * overlapping meant one esbuild writing the file while the other required it, and
   * the quieter half of that is worse than a crash: a run can load a bundle built
   * from another checkout's sources and report a perfectly green matrix about code
   * it never measured.
   *
   * Every other script here already does it this way, `mkdtempSync` in eight of
   * them, so this is the convention rather than a new idea. Removed on exit because
   * each directory holds a few megabytes and a night of runs is a few hundred.
   */
  const out = mkdtempSync(join(tmpdir(), `sheaf-${name}-`));
  process.on('exit', () => {
    try {
      rmSync(out, { recursive: true, force: true });
    } catch {
      // A temporary directory that outlives the run costs disk and nothing else.
    }
  });
  const entry = join(out, 'entry.ts');
  const spec = (from) => JSON.stringify(from.startsWith('@') || !from.includes('/') ? from : join(repo, from));
  writeFileSync(
    entry,
    Object.entries(exports)
      .map(([names, from]) => `export { ${names} } from ${spec(from)};`)
      .join('\n') + '\n'
  );
  const bundle = join(out, 'bundle.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    outfile: bundle,
    logLevel: 'warning',
    nodePaths: [join(repo, 'node_modules')],
  });
  return bundle;
}

/** Put a jsdom window on the globals CodeMirror reaches for. */
function installDom(repo) {
  const { JSDOM } = createRequire(join(repo, 'package.json'))('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  for (const key of [
    'getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event',
    'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'DocumentFragment', 'Text',
    'ClipboardEvent', 'DataTransfer', 'PointerEvent', 'FocusEvent',
  ]) {
    if (window[key]) globalThis[key] = window[key];
  }
  const noop = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = noop;
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = noop;
  const emptyRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
  if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = emptyRect;
  globalThis.window = window;
  if (!globalThis.Window && window.Window) globalThis.Window = window.Window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  return window;
}

/** Report the editor's own elements as tall enough to hold any document. */
function tallViewport(window) {
  Object.defineProperty(window, 'innerHeight', { value: TALL, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  const realRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    const tall =
      this === window.document.body ||
      this === window.document.documentElement ||
      ['cm-editor', 'cm-scroller', 'cm-content'].some((c) => this.classList?.contains(c));
    return tall
      ? { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: TALL, width: 1200, height: TALL, toJSON() {} }
      : realRect.call(this);
  };
}

/**
 * Mount the editor under jsdom and hand back the bundle's exports.
 *
 * `extra` adds exports beyond the ones every caller needs, as a map of local name
 * to the module the name comes from.
 */
export async function editorUnderJsdom(repo, { extra = {}, name = 'editor-dom' } = {}) {
  const bundle = await bundleFor(
    repo,
    {
      mountProse: 'test/harness',
      'setLivePreviewConfig, setDocumentSourceMode': 'src/webview/revealState',
      forceParsing: '@codemirror/language',
      EditorView: '@codemirror/view',
      EditorSelection: '@codemirror/state',
      ...extra,
    },
    name
  );
  const window = installDom(repo);
  tallViewport(window);
  const mod = createRequire(import.meta.url)(bundle);
  // What the webview does on load. Without it the caret's line reads raw and
  // every answer about that line is about a mode the product does not ship in.
  mod.setLivePreviewConfig({ revealSyntaxOnLine: false });
  return mod;
}

/**
 * Parse and draw the whole document, rather than the screenful jsdom's absent
 * layout would otherwise leave it at. False when the viewport still stops short,
 * which makes any reading off this editor only a partial answer.
 *
 * It also gives the editor the focus, which is not a detail. Several of Sheaf's
 * key handlers begin by asking `view.hasFocus`, because a focused grid, board or
 * menu answers its own keys and the editor must not answer them too. A mounted
 * editor nobody focused fails that test, so those handlers return false and the
 * key falls through to CodeMirror's own. A script driving an unfocused editor is
 * therefore measuring a different product from the one that ships, and measuring
 * it as worse: every defect those handlers exist to fix is still there.
 */
export function settle(p, forceParsing) {
  p.view.focus();
  forceParsing(p.view, p.view.state.doc.length, 10000);
  let last = -1;
  for (let i = 0; i < 100; i++) {
    p.view.measure();
    const to = p.view.viewport.to;
    if (to >= p.view.state.doc.length || to === last) break;
    last = to;
  }
  return p.view.viewport.from === 0 && p.view.viewport.to >= p.view.state.doc.length;
}

/** What a reader sees, one entry per drawn line, widgets included as their text. */
export function visibleLines(p) {
  return [...p.view.contentDOM.querySelectorAll(':scope > .cm-line')].map((el) => el.textContent ?? '');
}

/** The same, as one string. */
export function visibleText(p) {
  return visibleLines(p).join('\n');
}
