/*
 * The existing hosts expressed in the contract's terms, to find out whether its signatures can carry
 * what they actually do.
 *
 * **Nothing here runs**, and these are the hosts written out as `SheafHost` literals, filled with what
 * each one does today. A host rewritten to *use* the contract would be a refactor of shipping code,
 * which risks behaviour to answer a question about types.
 *
 * **It is checked, by `npm run check-types:test`**, which compiles `test/` as well as `src/`. Until
 * that existed this file was an expression and not a check: `tsconfig.json` has `"include": ["src"]`,
 * esbuild strips types without reading them, and `npm run check-types` passing said nothing about any
 * of the 74 TypeScript files under `test/`. What found that is the control the gate now rests on:
 * `export const emptyHost: SheafHost = {}`, which cannot compile, because `value` and `applyEdit` are
 * required. It passed. Anybody changing how this file is compiled should add that line back, watch it
 * fail, and remove it.
 *
 * It has already earned itself. Writing the browser host out found six faults in the contract, four of
 * them omissions I would not have found by reading:
 *
 *   - a host speaks first, and the first version had no way to; so a consumer could not say the file
 *     had changed on disk, which is the one thing this product's argument rests on
 *   - `revealFragment` had no method
 *   - `getSelection` travels the other way from how it was declared: the host asks, the editor answers
 *   - `opened` carried no `config`, so the editor would have opened with no settings
 *   - and no `mode`, so a data file shown as one grid could not say so
 *
 * What it does not prove: that an adapter is *cheap*. It proves the shape fits.
 */
import type { EditorConfig, KeptKind, KeptState } from '../src/protocol';
import type { FileAnswer, HostSetting, ResolvedPath, SavedImage, SheafEditor, SheafHost } from '../src/hostContract';

/* -------------------------------------------------------------------------- */
/* The browser host, `src/server/host.ts`, read at f21707c.                     */
/* -------------------------------------------------------------------------- */

declare const fetchJson: (path: string, init?: unknown) => Promise<Record<string, unknown>>;
declare const localStore: { get(key: string): string | null; set(key: string, value: string): void };
declare const browserConfig: EditorConfig;

/**
 * A folder served to a browser tab.
 *
 * The three it does not implement are the three it has no way to do, and each is a decision already
 * recorded in that file: no palette asks it for a selection, no terminal is behind a tab, and it
 * cannot write a file beside the document it was opened on. It does implement `openAsText`, by showing
 * the whole document's Markdown instead, which is the same view by another route.
 */
export const browserHost: SheafHost = {
  connect(editor: SheafEditor): void {
    // `start()`: fetch the document, then `init`. The event stream then pushes the rest.
    void fetchJson('/api/doc').then((doc) =>
      editor.opened({
        text: doc.text as string,
        config: doc.config as EditorConfig,
        fileName: doc.fileName as string,
        resourceBaseUri: doc.resourceBaseUri as string,
        // A tab has no terminal, which is the one capability this host declares it lacks.
        lacks: ['terminal'],
      })
    );
  },

  value(): Promise<string> {
    return fetchJson('/api/doc').then((doc) => doc.text as string);
  },

  applyEdit(text: string): void {
    void fetchJson('/api/doc', { method: 'PUT', body: text });
  },

  // Presentation state in a tab, which is `localStorage` keyed per file and per kind.
  kept<K extends KeptKind>(kind: K): Promise<KeptState[K] | null> {
    const raw = localStore.get(`sheaf:kept:${kind}`);
    return Promise.resolve(raw ? (JSON.parse(raw) as KeptState[K]) : null);
  },
  keep<K extends KeptKind>(kind: K, value: KeptState[K]): void {
    localStore.set(`sheaf:kept:${kind}`, JSON.stringify(value));
  },

  file(path: string): Promise<FileAnswer> {
    return fetchJson(`/api/data?path=${path}`).then((r) => ({ text: r.text as string }));
  },

  /*
   * Refused out loud rather than dropped, which is what the protocol's answer to `dataFileEdit` is
   * for. The signature carries it: the promise resolves with a reason rather than rejecting, so the
   * editor says so and leaves the person's value on screen.
   */
  writeFile(path: string): Promise<{ error?: string }> {
    return Promise.resolve({
      error: `${path} was not written: a browser tab can read the document it was opened on and cannot write other files beside it.`,
    });
  },

  setting(change: HostSetting): void {
    // The host keeps the folder's settings and hands the whole of them back, which is why this returns
    // nothing and the push goes through `settingsChanged`.
    void change;
  },

  resolve(path: string): Promise<ResolvedPath> {
    return fetchJson(`/api/title?path=${path}`).then((r) => ({ address: r.address as string, title: r.title as string }));
  },
  files(): Promise<string[]> {
    return fetchJson('/api/files').then((r) => r.files as string[]);
  },

  saveImage(name: string, data: string): Promise<SavedImage> {
    void data;
    return fetchJson(`/api/image?name=${name}`, { method: 'POST' }).then((r) => ({ path: r.path as string }));
  },

  openLink(address: string): void {
    void address;
  },

  writeClipboard(text: string): void {
    void text;
  },

  // There is no second editor to reopen the file in, so this shows the document's own Markdown.
  openAsText(): void {
    // The host reaches the editor through what `connect` gave it.
  },

  blurred(): void {},

  // Not implemented, and each is a recorded decision rather than an omission:
  //   createFile  a tab cannot write a file beside the document
  //   runCommand  no terminal behind a tab, and the capability above says so
  //   selection   the editor answers this; a tab has no palette to ask
};

/* -------------------------------------------------------------------------- */
/* The extension host, `src/markdownEditorProvider.ts`.                        */
/* -------------------------------------------------------------------------- */

declare const vscodeDoc: { getText(): string };
declare const vscodeApply: (text: string) => Promise<void>;
declare const workspaceState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): void };

/**
 * A VS Code window, which is the host that implements everything.
 *
 * It is the control for the other two: a gap here would mean the contract cannot express a host that
 * does all of it, which would be a fault in the contract rather than in a host.
 */
export const extensionHost: SheafHost = {
  connect(editor: SheafEditor): void {
    editor.opened({
      text: vscodeDoc.getText(),
      config: browserConfig,
      fileName: 'doc.md',
      resourceBaseUri: 'https://webview/',
      // No `lacks`: absence means it can do everything, which is this host.
    });
  },

  value(): string {
    return vscodeDoc.getText();
  },
  applyEdit(text: string): Promise<void> {
    return vscodeApply(text);
  },

  // Kept in the window's own `workspaceState`, which is where comment folds already live.
  kept<K extends KeptKind>(kind: K): Promise<KeptState[K] | null> {
    return Promise.resolve(workspaceState.get<KeptState[K]>(kind) ?? null);
  },
  keep<K extends KeptKind>(kind: K, value: KeptState[K]): void {
    workspaceState.update(kind, value);
  },

  file(): Promise<FileAnswer> {
    return Promise.resolve({ text: '' });
  },
  writeFile(): Promise<{ error?: string }> {
    return Promise.resolve({});
  },
  createFile(): Promise<SavedImage> {
    return Promise.resolve({ path: 'data/new.csv' });
  },

  setting(change: HostSetting): void {
    void change;
  },

  resolve(): Promise<ResolvedPath> {
    return Promise.resolve({ title: 'A document' });
  },
  files(): Promise<string[]> {
    return Promise.resolve([]);
  },

  saveImage(): Promise<SavedImage> {
    return Promise.resolve({ path: 'media/pasted.png' });
  },

  openLink(): void {},
  writeClipboard(): void {},
  openAsText(): void {},
  runCommand(): void {},
  blurred(): void {},
};

/* -------------------------------------------------------------------------- */
/* The site demo, `public/demo/host.js` in the site's repository.               */
/* -------------------------------------------------------------------------- */

/**
 * One fixed document on a static page, which is the smallest host there is.
 *
 * Written here from what `scripts/check-demo-host.mjs` reports it answers rather than from its source,
 * which is in a repository this one does not depend on. So this is the shape its 18 answered messages
 * take in the contract's terms, and it is the honest limit of this file: a change over there is caught
 * by that check, not by this one.
 */
export const demoHost: SheafHost = {
  connect(editor: SheafEditor): void {
    editor.opened({
      text: '# A demo\n',
      config: browserConfig,
      fileName: 'demo.md',
      resourceBaseUri: '/demo/',
      lacks: ['terminal'],
    });
  },
  value(): string {
    return '# A demo\n';
  },
  applyEdit(): void {
    // A static page keeps the text in memory and writes nothing.
  },
  kept<K extends KeptKind>(): Promise<KeptState[K] | null> {
    return Promise.resolve(null);
  },
  keep(): void {},
  writeClipboard(): void {},
  openLink(): void {},
};
