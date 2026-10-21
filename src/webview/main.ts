/*
 * Webview entry point: the page, and nothing else.
 *
 * Everything the editor does is in `./mount`, which takes the elements it draws into and the way to
 * reach the host as arguments. This file is the first caller of it, and it is the whole of what a
 * host page has to supply: the `acquireVsCodeApi()` global, the two elements the page builds, where
 * the editor's own files are served from, and the two window events that are properties of the page
 * rather than of an editor.
 *
 * So this file is a consumer of the mount surface rather than a second implementation of it, which
 * is what makes it a test of whether that surface is sufficient: the editor behind this page is the
 * full `editorExtensions` set, and every message in `ToWebview` reaches it through `receive`.
 */

import type { FromWebview } from '../protocol';
import { moduleDirectory, setAssetBaseDefault } from './assetBase';
import { mountWebview } from './mount';
import type { ToWebview } from './mount';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/*
 * Where the editor's own files are, which is this directory.
 *
 * This file is the entry point, so the bundle it becomes is `media/webview.js` and `import.meta.url`
 * is that address. `media/mermaid/` is its neighbour, which is what the base is for and which is
 * true in all three hosts: every one of them loads this bundle as a module from the directory those
 * files sit in. Checked in each, since the whole of this rests on it: VS Code's
 * `asWebviewUri(media/webview.js)` behind `<script type="module">`, `/media/webview.js` from the
 * local server, and `/demo/webview.js` on the website, which Astro is told to leave alone.
 *
 * **The read belongs here and nowhere deeper.** Both builds split, so a module further in lands in
 * `media/editor/chunk-*.js` and its `import.meta.url` names that directory instead, which is
 * available, wrong, and wrong quietly. That is also why it is not in `./mount`: a mount is a thing a
 * page does, and this is a fact about where the page's own bundle was served from.
 *
 * Nothing a host writes into its page decides this any more. It was the address of the page's
 * `webview.css` until the stylesheet's name turned out to be a thing somebody else's build picks;
 * `src/webview/assetBase.ts` carries that history.
 *
 * The `@ts-expect-error` is TS1470 and is explained at `hereUrl` in `src/lib/index.ts`:
 * `module: Node16` reads every `.ts` here as building into CommonJS and refuses `import.meta`, while
 * esbuild emits this entry as an ES module where it is correct. An unused directive fails the type
 * check, so the day that configuration changes, both of these lines are named.
 */
// @ts-expect-error TS1470, which `module: Node16` raises and the ES module esbuild emits does not.
setAssetBaseDefault(moduleDirectory(import.meta.url));

const editor = mountWebview({
  root: document.getElementById('editor') as HTMLElement,
  toolbar: document.getElementById('toolbar') as HTMLElement,
  overlay: document.body,
  post: (message) => vscode.postMessage(message),
});

window.addEventListener('message', (e: MessageEvent<ToWebview>) => editor.receive(e.data));

// The page losing keyboard focus, which is the one thing that happens before VS Code
// closes the tab in front when its close button is pressed: the panel stays active until
// it is gone, so the host hears nothing from its own side. The host writes a pending
// auto-save on this, so the close finds nothing unsaved to ask about.
window.addEventListener('blur', () => editor.blurred());
