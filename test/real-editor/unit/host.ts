// Unit scenarios for how Sheaf lives inside VS Code: the default-editor setting,
// the open commands, source mode, auto-save, edit sync, outside changes, several
// editors on one file, live settings and themes. Each asserts what should be true;
// a failing scenario is a bug candidate.
//
// The host side (src/extension.ts, src/markdownEditorProvider.ts,
// src/defaultEditor.ts) imports `vscode`, which only exists inside VS Code. Those
// modules are compiled from the checkout at run time and handed a small stand-in
// for the `vscode` API. The stand-in follows two VS Code rules that matter here:
// a WorkspaceEdit is applied asynchronously and reported back through
// onDidChangeTextDocument, and an edit computed against a document version VS
// Code has already moved past is refused (applyEdit resolves false).
//
// The webview side is the real src/webview/main.ts bundle, mounted under jsdom
// and driven with the same messages the host posts.
import { planEdit, minimalEdit } from '../../../src/textSync';
import { toolbarEligible } from '../../../src/webview/floatingState';
import { EditorState } from '@codemirror/state';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}

// ---- Node access from inside the bundle ------------------------------------

// The runner loads this bundle as CommonJS in Node, so `require` and `__dirname` exist at run time.
const nodeRequire: any = eval('require');
const fs = nodeRequire('fs');
const pathMod = nodeRequire('path');
// Host modules, the webview entry and package files are loaded at run time from the checkout the runner names.
const REPO: string = eval('process').env.SHEAF_REPO || pathMod.resolve(eval('__dirname'), '..', '..', '..');
const esbuild = nodeRequire(pathMod.join(REPO, 'node_modules', 'esbuild'));

const j = (x: unknown): string => JSON.stringify(x);
const same = (got: unknown, want: unknown): Result => ({ ok: j(got) === j(want), detail: j(got) === j(want) ? '' : `got ${j(got)}, want ${j(want)}` });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 30): Promise<void> {
  for (let i = 0; i < 6; i++) await tick(0);
  if (ms) await tick(ms);
}

const tsCache = new Map<string, string>();
const loaded = new Map<string, unknown>();

/**
 * Compile a TypeScript module from the checkout and run it, with `deps` standing in
 * for the imports a scenario wants to control.
 *
 * A neighbour the caller says nothing about is compiled and run the same way rather
 * than refused. That matters more than it looks: this used to throw on any import it
 * had not been handed, so adding a module beside `extension.ts` broke every scenario
 * in the area at once, and the area reported a number nobody read as a failure. It
 * has happened twice, once when the browser session arrived and once when the
 * lost-typing record did, costing 45 scenarios each time.
 *
 * Only `vscode` has to be supplied, because it does not exist outside a window.
 * Anything else is the real code, which is what these scenarios are for.
 */
function loadTs(rel: string, deps: Record<string, unknown>, seen: Set<string> = new Set()): any {
  if (seen.has(rel)) return loaded.get(rel) ?? {};
  seen.add(rel);
  let code = tsCache.get(rel);
  if (!code) {
    code = esbuild.transformSync(fs.readFileSync(pathMod.join(REPO, rel), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2020' }).code as string;
    tsCache.set(rel, code);
  }
  const module = { exports: {} as any };
  loaded.set(rel, module.exports);
  const req = (id: string): unknown => {
    if (id in deps) return deps[id];
    if (!id.startsWith('.')) {
      // A package rather than a neighbour. Node can find those itself.
      return nodeRequire(pathMod.join(REPO, 'node_modules', id));
    }
    const dir = pathMod.dirname(rel);
    for (const ext of ['.ts', '.mjs', '.js', '/index.ts']) {
      const candidate = pathMod.normalize(pathMod.join(dir, id + ext));
      if (fs.existsSync(pathMod.join(REPO, candidate))) return loadTs(candidate, deps, seen);
    }
    throw new Error(`import ${id} from ${rel} is not a file in this checkout`);
  };
  new Function('require', 'module', 'exports', code)(req, module, module.exports);
  loaded.set(rel, module.exports);
  return module.exports;
}

// ---- A stand-in for the VS Code API ----------------------------------------

class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== fn)) };
  };
  fire(e: T): void {
    for (const f of [...this.listeners]) f(e);
  }
}

const uri = (path: string): any => ({ path, fsPath: path, scheme: 'file', toString: () => `file://${path}` });

interface Doc {
  uri: any;
  text: string;
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  saves: number;
  eol: number;
  getText(): string;
  positionAt(o: number): { offset: number };
  save(): Promise<boolean>;
}

function makeHost(opts: { latency?: number; failUpdate?: string } = {}) {
  const user: Record<string, any> = {};
  const workspace: Record<string, any> = {};
  const configEvents = new Emitter<any>();
  const docEvents = new Emitter<any>();
  const docs = new Map<string, Doc>();
  const log = {
    tabListeners: [] as ((e: any) => void)[],
    updates: [] as any[],
    executed: [] as { id: string; args: any[] }[],
    info: [] as string[],
    warn: [] as string[],
    commands: {} as Record<string, (...a: any[]) => any>,
  };
  const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

  const effective = (key: string): any => {
    const u = user[key];
    const w = workspace[key];
    if (u && w && typeof u === 'object' && typeof w === 'object') return { ...u, ...w };
    return w !== undefined ? w : u;
  };
  const fireChange = (key: string): void => configEvents.fire({ affectsConfiguration: (s: string) => key === s || key.startsWith(`${s}.`) });

  const vscode: any = {
    ConfigurationTarget,
    EndOfLine: { LF: 1, CRLF: 2 },
    Uri: { joinPath: (u: any, ...p: string[]) => uri([u.path, ...p].join('/')) },
    Range: class {
      constructor(public start: any, public end: any) {}
    },
    WorkspaceEdit: class {
      edits: { u: any; r: any; t: string }[] = [];
      replace(u: any, r: any, t: string): void {
        this.edits.push({ u, r, t });
      }
    },
    workspace: {
      getConfiguration: (section?: string) => {
        const full = (k: string): string => (section ? `${section}.${k}` : k);
        return {
          get: (k: string, d?: any) => {
            const v = effective(full(k));
            return v === undefined ? d : v;
          },
          inspect: (k: string) => ({ globalValue: user[full(k)], workspaceValue: workspace[full(k)] }),
          update: async (k: string, v: any, target: number) => {
            if (opts.failUpdate) throw new Error(opts.failUpdate);
            const store = target === ConfigurationTarget.Workspace ? workspace : user;
            log.updates.push({ key: full(k), value: v, target });
            if (v === undefined) delete store[full(k)];
            else store[full(k)] = JSON.parse(JSON.stringify(v));
            await tick(0);
            fireChange(full(k));
          },
        };
      },
      onDidChangeConfiguration: configEvents.event,
      onDidChangeTextDocument: docEvents.event,
      applyEdit: async (edit: any) => {
        const pending = edit.edits.map((e: any) => {
          const d = docs.get(e.u.toString()) as Doc;
          return { d, version: d.version, e };
        });
        await tick(opts.latency ?? 0);
        for (const p of pending) if (p.d.version !== p.version) return false;
        for (const p of pending) {
          const { d, e } = p;
          d.text = d.text.slice(0, e.r.start.offset) + e.t + d.text.slice(e.r.end.offset);
          d.version++;
          d.isDirty = true;
          docEvents.fire({ document: d });
        }
        return true;
      },
      getWorkspaceFolder: () => undefined,
      asRelativePath: (u: any) => String(u.path).split('/').pop(),
      fs: { stat: async () => Promise.reject(new Error('missing')), writeFile: async () => {} },
    },
    window: {
      activeTextEditor: undefined as any,
      registerCustomEditorProvider: () => ({ dispose() {} }),
      showInformationMessage: async (m: string) => void log.info.push(m),
      showWarningMessage: async (m: string) => void log.warn.push(m),
      // The extension watches tab changes to explain a file it cannot show (a NUL byte, say).
      // Without this the whole activation throws and every host scenario fails for one missing stub.
      tabGroups: {
        all: [] as any[],
        onDidChangeTabs: (fn: (e: any) => void) => {
          log.tabListeners.push(fn);
          return { dispose() {} };
        },
      },
    },
    TabInputCustom: class TabInputCustom {
      constructor(
        public uri: any,
        public viewType: string
      ) {}
    },
    commands: {
      registerCommand: (id: string, fn: (...a: any[]) => any) => {
        log.commands[id] = fn;
        return { dispose() {} };
      },
      executeCommand: async (id: string, ...args: any[]) => {
        log.executed.push({ id, args });
        if (log.commands[id]) return log.commands[id](...args);
      },
    },
    env: { clipboard: { writeText: async () => {}, readText: async () => '' } },
  };

  const textSync = loadTs('src/textSync.ts', {});
  const provider = loadTs('src/markdownEditorProvider.ts', { vscode, './textSync': textSync });
  const defaultEditor = loadTs('src/defaultEditor.ts', { vscode });
  // The browser session starts a real HTTP server, which has nothing to do with the
  // decisions these scenarios check and would leave a port open behind each one. It is
  // covered by the server suite instead, so here it is a shape with no behaviour.
  const browserSession = {
    registerBrowserSession: () => [] as unknown[],
    stopServing: () => {},
    servingAt: () => undefined,
  };
  const extension = loadTs('src/extension.ts', {
    vscode,
    './markdownEditorProvider': provider,
    './defaultEditor': defaultEditor,
    './browserSession': browserSession,
  });
  const context = { subscriptions: [] as any[], extensionUri: uri('/ext') };

  function doc(name: string, text: string, { crlf = false } = {}): Doc {
    const d: Doc = {
      uri: uri(`/ws/${name}`),
      text,
      version: 1,
      isDirty: false,
      isClosed: false,
      saves: 0,
      eol: crlf ? 2 : 1,
      getText: () => d.text,
      positionAt: (o: number) => ({ offset: o }),
      save: async () => {
        d.saves++;
        d.isDirty = false;
        return true;
      },
    };
    docs.set(d.uri.toString(), d);
    return d;
  }

  /** The file changed from outside: on disk, in another editor, by git. */
  function outside(d: Doc, text: string): void {
    d.text = text;
    d.version++;
    docEvents.fire({ document: d });
  }

  function panel(): any {
    const recv = new Emitter<any>();
    const view = new Emitter<any>();
    const disposed = new Emitter<void>();
    const p: any = {
      posted: [] as any[],
      active: true,
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        postMessage: async (m: any) => {
          p.posted.push(m);
          return true;
        },
        onDidReceiveMessage: recv.event,
        asWebviewUri: (u: any) => ({ toString: () => `https://webview${u.path}` }),
      },
      onDidChangeViewState: view.event,
      onDidDispose: disposed.event,
      send: (m: any) => recv.fire(m),
      setActive: (active: boolean) => {
        p.active = active;
        view.fire({ webviewPanel: p });
      },
      dispose: () => disposed.fire(),
    };
    return p;
  }

  /** Open `d` in a new Sheaf editor, as VS Code does when a tab resolves. */
  async function open(d: Doc): Promise<any> {
    const p = panel();
    await new provider.MarkdownEditorProvider(context).resolveCustomTextEditor(d, p, {});
    p.send({ type: 'ready' });
    return p;
  }

  /** A person changes a setting in the Settings UI. */
  async function setSetting(key: string, value: any, scope: 'user' | 'workspace' = 'user'): Promise<void> {
    await vscode.workspace.getConfiguration().update(key, value, scope === 'workspace' ? ConfigurationTarget.Workspace : ConfigurationTarget.Global);
    await settle(10);
  }

  /** The editor VS Code would pick for a file name: the merged association, else Sheaf's contributed default. */
  function editorFor(name: string): string {
    const assoc = effective('workbench.editorAssociations') || {};
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const hit = assoc[`*${ext}`];
    if (hit) return hit;
    return ext === '.md' || ext === '.markdown' ? 'sheaf.wysiwyg' : 'default';
  }

  return { vscode, user, workspace, log, provider, defaultEditor, extension, context, doc, outside, open, setSetting, editorFor };
}

const edits = (p: any): any[] => p.posted.filter((m: any) => m.type === 'setContent');

// ---- The real webview, mounted under jsdom ----------------------------------

let mainCode: string | undefined;
interface Webview {
  root: HTMLElement;
  posted: any[];
  send: (msg: any) => void;
  view: () => any;
  rendered: () => string;
  caret: (pos: number) => void;
  type: (text: string) => void;
  destroy: () => void;
}
const WEBVIEW_CONFIG = { contentWidth: '708px', revealSyntaxOnLine: false, doubleClickToEditSource: true };

function webview(text: string, config: Partial<typeof WEBVIEW_CONFIG> = {}): Webview {
  if (!mainCode) {
    mainCode = esbuild.buildSync({
      entryPoints: [pathMod.join(REPO, 'src', 'webview', 'main.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      nodePaths: [pathMod.join(REPO, 'node_modules')],
    }).outputFiles[0].text as string;
  }
  const G: any = globalThis;
  const host = document.createElement('div');
  host.innerHTML = '<div id="toolbar"></div><div id="editor"></div>';
  document.body.appendChild(host);
  const posted: any[] = [];
  G.acquireVsCodeApi = () => ({ postMessage: (m: any) => posted.push(m), getState: () => undefined, setState: () => {} });
  const listeners: ((e: any) => void)[] = [];
  const win: any = window;
  const original = win.addEventListener;
  win.addEventListener = function (type: string, fn: any, o: any) {
    if (type === 'message') listeners.push(fn);
    else original.call(win, type, fn, o);
  };
  try {
    new Function(mainCode)();
  } finally {
    win.addEventListener = original;
  }
  const root = host.querySelector('#editor') as HTMLElement;
  // Free the ids so the next webview in this run finds its own elements.
  root.id = '';
  (host.querySelector('#toolbar') as HTMLElement).id = '';
  const send = (msg: any): void => listeners.forEach((fn) => fn({ data: msg }));
  send({ type: 'init', text, config: { ...WEBVIEW_CONFIG, ...config }, fileName: 'doc.md', resourceBaseUri: 'https://webview/ws/' });
  const view = (): any => {
    const content: any = root.querySelector('.cm-content');
    const tile = content && (content.cmTile || content.cmView);
    return tile && ((tile.root && tile.root.view) || tile.view);
  };
  return {
    root,
    posted,
    send,
    view,
    rendered: () => [...root.querySelectorAll('.cm-content > .cm-line')].map((l) => l.textContent).join('\n'),
    caret: (pos: number) => view().dispatch({ selection: { anchor: pos } }),
    type: (t: string) => {
      const v = view();
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: t }, selection: { anchor: at + t.length }, userEvent: 'input.type' });
    },
    destroy: () => {
      try {
        view()?.destroy();
      } catch {}
      host.remove();
    },
  };
}

const webviewEdits = (w: Webview): any[] => w.posted.filter((m) => m.type === 'edit');

/** Wire a webview to a provider panel the way VS Code's postMessage bridge does. */
function bridge(p: any, w: Webview): void {
  const seen = { host: 0, web: 0 };
  const pump = (): void => {
    while (seen.host < p.posted.length) {
      const m = p.posted[seen.host++];
      if (m.type === 'setContent' || m.type === 'configChanged' || m.type === 'toggleSourceMode') w.send(m);
    }
    while (seen.web < w.posted.length) {
      const m = w.posted[seen.web++];
      if (m.type === 'edit' || m.type === 'openAsText') p.send(m);
    }
  };
  const timer = setInterval(pump, 1);
  (w as any).stopBridge = () => clearInterval(timer);
}

const PKG = (): any => JSON.parse(fs.readFileSync(pathMod.join(REPO, 'package.json'), 'utf8'));
const CSS = (): string => fs.readFileSync(pathMod.join(REPO, 'media', 'webview.css'), 'utf8');
const THEME_TS = (): string => fs.readFileSync(pathMod.join(REPO, 'src', 'webview', 'theme.ts'), 'utf8');

/** Evaluate a menu `when` clause built from `resourceExtname == x` terms joined by `||`. */
function whenMatchesExt(when: string, ext: string): boolean {
  return when.split('||').some((term) => {
    const eq = /resourceExtname\s*==\s*(\S+)/.exec(term);
    if (eq) return eq[1] === ext;
    const re = /resourceExtname\s*=~\s*\/(.+)\/(\w*)/.exec(term);
    if (re) return new RegExp(re[1], re[2]).test(ext);
    return false;
  });
}

// ---- Scenarios ---------------------------------------------------------------

const DEF = 'sheaf.useAsDefaultMarkdownEditor';
const ASSOC = 'workbench.editorAssociations';

export const scenarios: Scenario[] = [
  // host.default-editor
  {
    id: 'host.default-editor.u01',
    feature: 'host.default-editor',
    name: 'Turning the setting off sends .md and .markdown files to the text editor',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false);
      return same([h.editorFor('notes.md'), h.editorFor('notes.markdown'), h.user[ASSOC]], ['default', 'default', { '*.md': 'default', '*.markdown': 'default' }]);
    },
  },
  {
    id: 'host.default-editor.u02',
    feature: 'host.default-editor',
    name: 'Turning the setting back on opens Markdown in Sheaf again and leaves no association behind',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false);
      await h.setSetting(DEF, true);
      return same([h.editorFor('notes.md'), h.editorFor('notes.markdown'), h.user[ASSOC]], ['sheaf.wysiwyg', 'sheaf.wysiwyg', {}]);
    },
  },
  {
    id: 'host.default-editor.u03',
    feature: 'host.default-editor',
    name: 'An association the person pointed at another editor survives turning the setting off and on',
    run: async () => {
      const h = makeHost();
      h.user[ASSOC] = { '*.md': 'vscode.markdown.preview.editor', '*.txt': 'default' };
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false);
      const off = { ...h.user[ASSOC] };
      await h.setSetting(DEF, true);
      return same([off, h.user[ASSOC]], [
        { '*.md': 'vscode.markdown.preview.editor', '*.txt': 'default', '*.markdown': 'default' },
        { '*.md': 'vscode.markdown.preview.editor', '*.txt': 'default' },
      ]);
    },
  },
  {
    id: 'host.default-editor.u04',
    feature: 'host.default-editor',
    name: 'An association left by an earlier name (nib.wysiwyg, md-editor.wysiwyg) is cleared at startup so Markdown opens in Sheaf',
    run: async () => {
      const h = makeHost();
      h.user[ASSOC] = { '*.md': 'nib.wysiwyg', '*.markdown': 'md-editor.wysiwyg' };
      h.extension.activate(h.context);
      await settle();
      return same([h.editorFor('a.md'), h.editorFor('a.markdown')], ['sheaf.wysiwyg', 'sheaf.wysiwyg']);
    },
  },
  {
    id: 'host.default-editor.u05',
    feature: 'host.default-editor',
    name: 'Starting VS Code with nothing to change writes nothing to settings, and turning off twice writes once',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      const atStart = h.log.updates.length;
      await h.setSetting(DEF, false);
      const afterOff = h.log.updates.filter((u) => u.key === ASSOC).length;
      // The person sets it off again (a second window, or a settings sync).
      await h.defaultEditor.syncDefaultEditorAssociation();
      await settle();
      const afterAgain = h.log.updates.filter((u) => u.key === ASSOC).length;
      return same([atStart, afterOff, afterAgain], [0, 1, 1]);
    },
  },
  {
    id: 'host.default-editor.u06',
    feature: 'host.default-editor',
    name: 'Turning the setting off for one workspace writes the association there and leaves user settings alone',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false, 'workspace');
      return same([h.workspace[ASSOC], h.user[ASSOC], h.editorFor('a.md')], [{ '*.md': 'default', '*.markdown': 'default' }, undefined, 'default']);
    },
  },
  {
    id: 'host.default-editor.u07',
    feature: 'host.default-editor',
    name: 'Resetting a workspace-level opt-out (removing the setting) opens Markdown in Sheaf again',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false, 'workspace');
      await h.setSetting(DEF, undefined, 'workspace');
      return {
        ok: h.editorFor('a.md') === 'sheaf.wysiwyg',
        detail: `setting now reads ${h.vscode.workspace.getConfiguration('sheaf').get('useAsDefaultMarkdownEditor', true)}; .md opens in ${h.editorFor('a.md')}; workspace associations ${j(h.workspace[ASSOC])}`,
      };
    },
  },
  {
    id: 'host.default-editor.u08',
    feature: 'host.default-editor',
    name: 'Off in user settings but on for this workspace opens Markdown in Sheaf in this workspace',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false, 'user');
      await h.setSetting(DEF, true, 'workspace');
      return {
        ok: h.editorFor('a.md') === 'sheaf.wysiwyg',
        detail: `setting reads ${h.vscode.workspace.getConfiguration('sheaf').get('useAsDefaultMarkdownEditor', true)}; .md opens in ${h.editorFor('a.md')}; user ${j(h.user[ASSOC])} workspace ${j(h.workspace[ASSOC])}`,
      };
    },
  },
  {
    id: 'host.default-editor.u09',
    feature: 'host.default-editor',
    name: 'When settings cannot be written, the person gets a warning and nothing throws',
    run: async () => {
      const h = makeHost({ failUpdate: 'settings.json is read-only' });
      h.user[DEF] = false;
      await h.defaultEditor.syncDefaultEditorAssociation();
      return { ok: h.log.warn.length === 1 && /read-only/.test(h.log.warn[0]), detail: j(h.log.warn) };
    },
  },
  {
    id: 'host.default-editor.u10',
    feature: 'host.default-editor',
    name: 'An association naming Sheaf itself is rewritten to the text editor when the setting is off',
    run: async () => {
      const h = makeHost();
      h.user[ASSOC] = { '*.md': 'sheaf.wysiwyg' };
      h.extension.activate(h.context);
      await settle();
      await h.setSetting(DEF, false);
      return same(h.editorFor('a.md'), 'default');
    },
  },

  // host.open-in-sheaf
  {
    id: 'host.open-in-sheaf.u01',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf on a file from the Explorer opens that file with Sheaf',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.log.commands['sheaf.openWithWysiwyg'](uri('/ws/a.md'));
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && [call.args[0].path, call.args[1]], ['/ws/a.md', 'sheaf.wysiwyg']);
    },
  },
  {
    id: 'host.open-in-sheaf.u02',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf from the Command Palette opens the Markdown file in the active text editor',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      h.vscode.window.activeTextEditor = { document: { uri: uri('/ws/b.md') } };
      await h.log.commands['sheaf.openWithWysiwyg']();
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && [call.args[0].path, call.args[1]], ['/ws/b.md', 'sheaf.wysiwyg']);
    },
  },
  {
    id: 'host.open-in-sheaf.u03',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf with no editor open says there is nothing to open and opens nothing',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.log.commands['sheaf.openWithWysiwyg']();
      return same([h.log.info.length, h.log.executed.filter((c) => c.id === 'vscode.openWith').length], [1, 0]);
    },
  },
  {
    id: 'host.open-in-sheaf.u04',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf from the Command Palette while a Sheaf editor is active does not claim there is no Markdown file',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.open(h.doc('a.md', '# A\n'));
      await h.log.commands['sheaf.openWithWysiwyg']();
      return { ok: !h.log.info.some((m) => /no Markdown file/i.test(m)), detail: `messages ${j(h.log.info)}` };
    },
  },
  {
    id: 'host.open-in-sheaf.u05',
    feature: 'host.open-in-sheaf',
    name: 'The Explorer offers Open in Sheaf for every file name Sheaf opens, uppercase extensions included',
    run: () => {
      const item = PKG().contributes.menus['explorer/context'].find((m: any) => m.command === 'sheaf.openWithWysiwyg');
      const exts = ['.md', '.markdown', '.MD', '.Markdown'];
      const offered = exts.map((e) => whenMatchesExt(item.when, e));
      return { ok: offered.every(Boolean), detail: `when ${j(item.when)}: ${exts.map((e, i) => `${e}=${offered[i]}`).join(' ')}` };
    },
  },
  {
    id: 'host.open-in-sheaf.u06',
    feature: 'host.open-in-sheaf',
    name: 'Open in Sheaf on two files selected in the Explorer opens both',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const a = uri('/ws/a.md');
      const b = uri('/ws/b.md');
      await h.log.commands['sheaf.openWithWysiwyg'](a, [a, b]);
      const opened = h.log.executed.filter((c) => c.id === 'vscode.openWith').map((c) => c.args[0].path);
      return same(opened, ['/ws/a.md', '/ws/b.md']);
    },
  },

  // host.open-raw
  {
    id: 'host.open-raw.u01',
    feature: 'host.open-raw',
    name: 'The title bar button reopens its own file in the text editor',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.log.commands['sheaf.openAsText'](uri('/ws/a.md'));
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && [call.args[0].path, call.args[1]], ['/ws/a.md', 'default']);
    },
  },
  {
    id: 'host.open-raw.u02',
    feature: 'host.open-raw',
    name: "The toolbar's Open raw Markdown button reopens the file that editor shows",
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.open(h.doc('a.md', 'A\n'));
      const pb = await h.open(h.doc('b.md', 'B\n'));
      const pa = await h.open(h.doc('c.md', 'C\n'));
      void pa;
      pb.send({ type: 'openAsText' });
      await settle();
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && [call.args[0].path, call.args[1]], ['/ws/b.md', 'default']);
    },
  },
  {
    id: 'host.open-raw.u03',
    feature: 'host.open-raw',
    name: 'From the Command Palette it reopens the Sheaf editor the person last focused',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const pa = await h.open(h.doc('a.md', 'A\n'));
      const pb = await h.open(h.doc('b.md', 'B\n'));
      pb.setActive(false);
      pa.setActive(true);
      await h.log.commands['sheaf.openAsText']();
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && call.args[0].path, '/ws/a.md');
    },
  },
  {
    id: 'host.open-raw.u04',
    feature: 'host.open-raw',
    name: 'After the focused Sheaf editor closes, the command goes to a Sheaf editor that is still open',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      await h.open(h.doc('a.md', 'A\n'));
      const pb = await h.open(h.doc('b.md', 'B\n'));
      pb.dispose();
      await h.log.commands['sheaf.openAsText']();
      const call = h.log.executed.find((c) => c.id === 'vscode.openWith');
      return same(call && call.args[0].path, '/ws/a.md');
    },
  },
  {
    id: 'host.open-raw.u05',
    feature: 'host.open-raw',
    name: 'With no Sheaf editor open, the command opens nothing and does not throw',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const pa = await h.open(h.doc('a.md', 'A\n'));
      pa.dispose();
      await h.log.commands['sheaf.openAsText']();
      return same(h.log.executed.filter((c) => c.id === 'vscode.openWith').length, 0);
    },
  },
  {
    id: 'host.open-raw.u06',
    feature: 'host.open-raw',
    name: 'From the Command Palette while a text editor on another file is active, it does not reopen a background Sheaf file',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const pa = await h.open(h.doc('a.md', 'A\n'));
      // The person switches to a text editor on c.md; the Sheaf tab for a.md is no longer the active editor.
      pa.setActive(false);
      h.vscode.window.activeTextEditor = { document: { uri: uri('/ws/c.md') } };
      await h.log.commands['sheaf.openAsText']();
      const opened = h.log.executed.filter((c) => c.id === 'vscode.openWith').map((c) => c.args[0].path);
      return { ok: !opened.includes('/ws/a.md'), detail: `opened ${j(opened)}` };
    },
  },
  {
    id: 'host.open-raw.u07',
    feature: 'host.open-raw',
    name: 'The way out of Sheaf is the toolbar and the palette, and nothing sits in the editor title bar',
    run: () => {
      const pkg = PKG();
      const inTitleBar = (pkg.contributes.menus['editor/title'] ?? []).length;
      const command = (pkg.contributes.commands ?? []).find((c: any) => c.command === 'sheaf.openAsText');
      return { ok: inTitleBar === 0 && !!command, detail: `${inTitleBar} title bar items, command contributed ${!!command}` };
    },
  },

  // host.source-mode
  {
    id: 'host.source-mode.u01',
    feature: 'host.source-mode',
    name: 'Source mode shows the Markdown markers of every line',
    run: async () => {
      const w = webview('A **bold** word and a [link](https://x.y).\n\n## Heading\n');
      const before = w.rendered();
      w.send({ type: 'toggleSourceMode' });
      await settle();
      const after = w.rendered();
      w.destroy();
      return { ok: after.includes('**bold**') && after.includes('[link](https://x.y)') && after.includes('## Heading'), detail: `before ${j(before)} after ${j(after)}` };
    },
  },
  {
    id: 'host.source-mode.u02',
    feature: 'host.source-mode',
    name: 'Toggling source mode twice hides the markers again and posts no edit',
    run: async () => {
      const w = webview('A **bold** word.\n');
      const before = w.rendered();
      w.send({ type: 'toggleSourceMode' });
      await settle();
      w.send({ type: 'toggleSourceMode' });
      await settle();
      const after = w.rendered();
      const n = webviewEdits(w).length;
      const cls = w.root.classList.contains('source-mode');
      w.destroy();
      return same([after, n, cls], [before, 0, false]);
    },
  },
  {
    id: 'host.source-mode.u03',
    feature: 'host.source-mode',
    name: 'Typing in source mode edits the document at the caret',
    run: async () => {
      const w = webview('One two\n');
      w.send({ type: 'toggleSourceMode' });
      await settle();
      w.caret(3);
      w.type('Z');
      await settle();
      const e = webviewEdits(w).at(-1);
      w.destroy();
      return same(e && e.text, 'OneZ two\n');
    },
  },
  {
    id: 'host.source-mode.u04',
    feature: 'host.source-mode',
    name: 'The command goes only to the active Sheaf editor',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const pa = await h.open(h.doc('a.md', 'A\n'));
      const pb = await h.open(h.doc('b.md', 'B\n'));
      h.log.commands['sheaf.toggleSourceMode']();
      const count = (p: any): number => p.posted.filter((m: any) => m.type === 'toggleSourceMode').length;
      return same([count(pa), count(pb)], [0, 1]);
    },
  },
  {
    id: 'host.source-mode.u05',
    feature: 'host.source-mode',
    name: 'Source mode stays on when the file changes from outside',
    run: async () => {
      const w = webview('A **bold** word.\n');
      w.send({ type: 'toggleSourceMode' });
      await settle();
      w.send({ type: 'setContent', text: 'A **bold** word.\n\nAdded *later*.\n' });
      await settle();
      const on = w.root.classList.contains('source-mode');
      const r = w.rendered();
      w.destroy();
      return { ok: on && r.includes('*later*'), detail: `class ${on}, rendered ${j(r)}` };
    },
  },
  {
    id: 'host.source-mode.u06',
    feature: 'host.source-mode',
    name: 'A table shows as its pipe rows in source mode',
    run: async () => {
      const w = webview('Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nOutro\n');
      w.send({ type: 'toggleSourceMode' });
      await settle();
      const r = w.rendered();
      w.destroy();
      return { ok: r.includes('| a | b |') && r.includes('| 1 | 2 |'), detail: j(r) };
    },
  },
  {
    id: 'host.source-mode.u07',
    feature: 'host.source-mode',
    name: 'The floating formatting toolbar is not offered for a selection in source mode',
    run: () => {
      const state = EditorState.create({ doc: 'hello world', selection: { anchor: 0, head: 5 } });
      return same([toolbarEligible(state, false), toolbarEligible(state, true)], [true, false]);
    },
  },
  {
    id: 'host.source-mode.u08',
    feature: 'host.source-mode',
    name: 'With the Toggle command run from a text editor, a background Sheaf editor is not switched',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const pa = await h.open(h.doc('a.md', 'A\n'));
      pa.setActive(false);
      h.vscode.window.activeTextEditor = { document: { uri: uri('/ws/c.md') } };
      h.log.commands['sheaf.toggleSourceMode']();
      const n = pa.posted.filter((m: any) => m.type === 'toggleSourceMode').length;
      return { ok: n === 0, detail: `background a.md editor received ${n} toggle message(s)` };
    },
  },

  // host.autosave
  {
    id: 'host.autosave.u01',
    feature: 'host.autosave',
    name: 'One edit is saved once, shortly after typing stops',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle(300);
      const early = d.saves;
      await tick(700);
      return same([early, d.saves, d.isDirty, d.text], [0, 1, false, 'Hello!\n']);
    },
  },
  {
    id: 'host.autosave.u02',
    feature: 'host.autosave',
    name: 'Typing steadily saves once after the last keystroke, not once per keystroke',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'H\n');
      const p = await h.open(d);
      let t = 'H';
      for (let i = 0; i < 6; i++) {
        t += 'i';
        p.send({ type: 'edit', text: `${t}\n` });
        await settle(150);
      }
      const during = d.saves;
      await tick(900);
      return same([during, d.saves, d.text], [0, 1, 'Hiiiiii\n']);
    },
  },
  {
    id: 'host.autosave.u03',
    feature: 'host.autosave',
    name: 'With sheaf.autoSave off, edits reach the document but it is left unsaved',
    run: async () => {
      const h = makeHost();
      h.user['sheaf.autoSave'] = false;
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle(1000);
      return same([d.text, d.isDirty, d.saves], ['Hello!\n', true, 0]);
    },
  },
  {
    id: 'host.autosave.u04',
    feature: 'host.autosave',
    name: 'Turning sheaf.autoSave back on takes effect for the next edit without reopening',
    run: async () => {
      const h = makeHost();
      h.user['sheaf.autoSave'] = false;
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle(100);
      await h.setSetting('sheaf.autoSave', true);
      p.send({ type: 'edit', text: 'Hello!!\n' });
      await settle(1000);
      return same([d.text, d.saves, d.isDirty], ['Hello!!\n', 1, false]);
    },
  },
  {
    id: 'host.autosave.u05',
    feature: 'host.autosave',
    name: 'An edit made just before the editor is closed is still saved',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle(100);
      p.dispose();
      await tick(1000);
      return { ok: d.saves === 1 && !d.isDirty, detail: `saves ${d.saves}, document still unsaved ${d.isDirty}` };
    },
  },
  {
    id: 'host.autosave.u06',
    feature: 'host.autosave',
    name: 'A webview message with unchanged text neither edits nor saves',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello\n' });
      await settle(1000);
      return same([d.version, d.saves, d.isDirty], [1, 0, false]);
    },
  },
  {
    id: 'host.autosave.u07',
    feature: 'host.autosave',
    name: 'A document the person already saved by hand is not saved a second time',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle(50);
      await d.save();
      await tick(1000);
      return same(d.saves, 1);
    },
  },

  // host.edit-sync
  {
    id: 'host.edit-sync.u01',
    feature: 'host.edit-sync',
    name: 'Typing at the very start and very end of a file is a one-character edit each',
    run: () => {
      const a = planEdit('alpha\nomega', 'Xalpha\nomega', false);
      const b = planEdit('alpha\nomega', 'alpha\nomegaX', false);
      return same([a && [a.start, a.end, a.replacement], b && [b.start, b.end, b.replacement]], [[0, 0, 'X'], [11, 11, 'X']]);
    },
  },
  {
    id: 'host.edit-sync.u02',
    feature: 'host.edit-sync',
    name: 'An empty file filled, and a full file emptied, give exactly the new text',
    run: () => {
      const fill = planEdit('', 'new text', false);
      const empty = planEdit('a\r\nb\r\n', '', true);
      return same([fill && fill.text, empty && [empty.start, empty.end, empty.replacement, empty.text]], ['new text', [0, 6, '', '']]);
    },
  },
  {
    id: 'host.edit-sync.u03',
    feature: 'host.edit-sync',
    name: 'CRLF file: joining two lines with Backspace removes only that CRLF',
    run: () => {
      const e = planEdit('one\r\ntwo\r\nthree\r\n', 'one\ntwothree\n', true);
      return same(e && [e.start, e.end, e.replacement, e.text], [8, 10, '', 'one\r\ntwothree\r\n']);
    },
  },
  {
    id: 'host.edit-sync.u04',
    feature: 'host.edit-sync',
    name: 'CRLF file: pasting text that already has CRLF does not double the carriage returns',
    run: () => {
      const e = planEdit('a\r\nb\r\n', 'a\r\nx\r\ny\nb\n', true);
      return same(e && e.text, 'a\r\nx\r\ny\r\nb\r\n');
    },
  },
  {
    id: 'host.edit-sync.u05',
    feature: 'host.edit-sync',
    name: 'Replacing one emoji with another yields exactly the new text',
    run: () => {
      const old = 'A \u{1F600} B';
      const next = 'A \u{1F603} B';
      const e = minimalEdit(old, next);
      const applied = old.slice(0, e.start) + e.replacement + old.slice(e.end);
      return same(applied, next);
    },
  },
  {
    id: 'host.edit-sync.u11',
    feature: 'host.edit-sync',
    name: 'Replacing one emoji with another sends an edit whose range does not start or end inside an emoji',
    run: () => {
      const old = 'A \u{1F600} B';
      const next = 'A \u{1F603} B';
      const e = planEdit(old, next, false);
      const inside = (s: string, i: number): boolean => i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]) && /[\uD800-\uDBFF]/.test(s[i - 1]);
      const bad = !!e && (inside(old, e.start) || inside(old, e.end));
      return { ok: !!e && !bad, detail: `range ${e && [e.start, e.end]} replacement ${j(e && e.replacement)} (code units ${e && [...e.replacement].map((c) => c.charCodeAt(0).toString(16))})` };
    },
  },
  {
    id: 'host.edit-sync.u06',
    feature: 'host.edit-sync',
    name: 'A one-character edit in a 2 MB file is planned in under 50 ms and replaces one character',
    run: () => {
      const line = 'The quick brown fox jumps over the lazy dog, again and again.\n';
      const big = line.repeat(Math.ceil(2_000_000 / line.length));
      const mid = Math.floor(big.length / 2);
      const next = big.slice(0, mid) + 'Z' + big.slice(mid);
      const t0 = Date.now();
      const e = planEdit(big, next, false);
      const ms = Date.now() - t0;
      return { ok: ms < 50 && !!e && e.end === e.start && e.replacement === 'Z', detail: `${ms} ms, ${j(e && [e.start, e.end, e.replacement])}` };
    },
  },
  {
    id: 'host.edit-sync.u07',
    feature: 'host.edit-sync',
    name: 'Through the provider, a CRLF document gets a one-character edit and keeps every CRLF',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'one\r\ntwo\r\n', { crlf: true });
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'one\ntwoZ\n' });
      await settle();
      return same([d.text, d.version], ['one\r\ntwoZ\r\n', 2]);
    },
  },
  {
    id: 'host.edit-sync.u08',
    feature: 'host.edit-sync',
    name: 'An edit from Sheaf is not echoed back into the same Sheaf editor',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'Hello!\n' });
      await settle();
      return same(edits(p).length, 0);
    },
  },
  {
    id: 'host.edit-sync.u09',
    feature: 'host.edit-sync',
    name: 'Two keystrokes that reach the host before VS Code has applied the first both end up in the document',
    run: async () => {
      const h = makeHost({ latency: 5 });
      const d = h.doc('a.md', 'a');
      const p = await h.open(d);
      p.send({ type: 'edit', text: 'ab' });
      p.send({ type: 'edit', text: 'abc' });
      await settle(50);
      return { ok: d.text === 'abc', detail: `document ${j(d.text)}; posted back to the webview ${j(edits(p).map((m) => m.text))}` };
    },
  },
  {
    id: 'host.edit-sync.u10',
    feature: 'host.edit-sync',
    name: 'Typing fast in the real webview, bridged to the provider, leaves the file equal to what the webview shows',
    run: async () => {
      const h = makeHost({ latency: 3 });
      const d = h.doc('a.md', 'Start\n');
      const p = await h.open(d);
      const w = webview('Start\n');
      bridge(p, w);
      w.caret(5);
      for (const ch of ' quick typing') {
        w.type(ch);
        await tick(1);
      }
      await settle(100);
      const shown = w.view().state.doc.toString();
      (w as any).stopBridge();
      w.destroy();
      return { ok: d.text === 'Start quick typing\n' && shown === d.text, detail: `document ${j(d.text)}, webview ${j(shown)}` };
    },
  },

  // host.outside-change
  {
    id: 'host.outside-change.u01',
    feature: 'host.outside-change',
    name: 'A change to the file from outside is sent to the Sheaf editor',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      h.outside(d, 'Hello from git\n');
      return same(edits(p).map((m) => m.text), ['Hello from git\n']);
    },
  },
  {
    id: 'host.outside-change.u02',
    feature: 'host.outside-change',
    name: 'Text inserted above the caret from outside leaves the caret in the same words',
    run: async () => {
      const w = webview('first\n\nsecond line here\n');
      const at = 'first\n\nsecond '.length;
      w.caret(at);
      w.send({ type: 'setContent', text: 'new top\n\nfirst\n\nsecond line here\n' });
      await settle();
      const s = w.view().state;
      const head = s.selection.main.head;
      const out = { word: s.doc.sliceString(head, head + 4), edits: webviewEdits(w).length };
      w.destroy();
      return same(out, { word: 'line', edits: 0 });
    },
  },
  {
    id: 'host.outside-change.u03',
    feature: 'host.outside-change',
    name: 'The line holding the caret deleted from outside leaves a valid caret and the outside text',
    run: async () => {
      const w = webview('keep\n\ndelete me\n\nkeep too\n');
      w.caret('keep\n\ndelete'.length);
      w.send({ type: 'setContent', text: 'keep\n\nkeep too\n' });
      await settle();
      const s = w.view().state;
      const out = { doc: s.doc.toString(), valid: s.selection.main.head <= s.doc.length };
      w.destroy();
      return same(out, { doc: 'keep\n\nkeep too\n', valid: true });
    },
  },
  {
    id: 'host.outside-change.u04',
    feature: 'host.outside-change',
    name: 'An outside write of identical bytes sends nothing to the editor',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      h.outside(d, 'Hello\n');
      return same(edits(p).length, 0);
    },
  },
  {
    id: 'host.outside-change.u05',
    feature: 'host.outside-change',
    name: 'CRLF file: a change from outside above the caret leaves the caret in the same words',
    run: async () => {
      // The host sends document.getText(), which keeps the file's CRLF line endings.
      const w = webview('first\r\n\r\nsecond line here\r\n');
      const at = 'first\n\nsecond '.length;
      w.caret(at);
      w.send({ type: 'setContent', text: 'FIRST\r\n\r\nsecond line here\r\n' });
      await settle();
      const s = w.view().state;
      const head = s.selection.main.head;
      const out = { doc: s.doc.toString(), word: s.doc.sliceString(head, head + 4) };
      w.destroy();
      return same(out, { doc: 'FIRST\n\nsecond line here\n', word: 'line' });
    },
  },
  {
    id: 'host.outside-change.u06',
    feature: 'host.outside-change',
    name: 'An outside change does not come back to the file as an edit from Sheaf',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const p = await h.open(d);
      const w = webview('Hello\n');
      bridge(p, w);
      h.outside(d, 'Hello\nWorld\n');
      await settle(50);
      const v = d.version;
      (w as any).stopBridge();
      const shown = w.view().state.doc.toString();
      w.destroy();
      return same([shown, v, webviewEdits(w).length], ['Hello\nWorld\n', 2, 0]);
    },
  },
  {
    id: 'host.outside-change.u07',
    feature: 'host.outside-change',
    name: 'An outside change arriving while a Sheaf keystroke is still being applied leaves Sheaf showing the file',
    run: async () => {
      const h = makeHost({ latency: 5 });
      const d = h.doc('a.md', 'top\n\nbody\n');
      const p = await h.open(d);
      const w = webview('top\n\nbody\n');
      bridge(p, w);
      w.caret('top\n\nbody'.length);
      w.type('!');
      await tick(2);
      h.outside(d, 'TOP\n\nbody\n');
      await settle(100);
      const shown = w.view().state.doc.toString();
      (w as any).stopBridge();
      w.destroy();
      return { ok: shown === d.text, detail: `file ${j(d.text)}, Sheaf shows ${j(shown)}` };
    },
  },

  // host.split-editors
  {
    id: 'host.split-editors.u01',
    feature: 'host.split-editors',
    name: 'Typing in one of two Sheaf editors on a file updates the other and not itself',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const pa = await h.open(d);
      const pb = await h.open(d);
      pa.send({ type: 'edit', text: 'Hello A\n' });
      await settle();
      return same([edits(pa).length, edits(pb).map((m) => m.text)], [0, ['Hello A\n']]);
    },
  },
  {
    id: 'host.split-editors.u02',
    feature: 'host.split-editors',
    name: 'A change typed in the text editor reaches both Sheaf editors on the file',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const pa = await h.open(d);
      const pb = await h.open(d);
      h.outside(d, 'Hello text editor\n');
      return same([edits(pa).map((m) => m.text), edits(pb).map((m) => m.text)], [['Hello text editor\n'], ['Hello text editor\n']]);
    },
  },
  {
    id: 'host.split-editors.u03',
    feature: 'host.split-editors',
    name: 'Closing one of two Sheaf editors leaves the other updating and auto-saving',
    run: async () => {
      const h = makeHost();
      const d = h.doc('a.md', 'Hello\n');
      const pa = await h.open(d);
      const pb = await h.open(d);
      pa.dispose();
      pb.send({ type: 'edit', text: 'Hello B\n' });
      await settle(1000);
      h.outside(d, 'Hello B outside\n');
      return same([d.saves, edits(pb).map((m) => m.text)], [1, ['Hello B outside\n']]);
    },
  },
  {
    id: 'host.split-editors.u04',
    feature: 'host.split-editors',
    name: 'Two real webviews on one file: typing in one shows in the other and the file matches both',
    run: async () => {
      const h = makeHost({ latency: 2 });
      const d = h.doc('a.md', 'Shared words\n');
      const pa = await h.open(d);
      const pb = await h.open(d);
      const wa = webview('Shared words\n');
      const wb = webview('Shared words\n');
      bridge(pa, wa);
      bridge(pb, wb);
      wa.caret(6);
      wa.type(' A');
      await settle(40);
      wb.caret(wb.view().state.doc.length - 1);
      wb.type(' B');
      await settle(60);
      const a = wa.view().state.doc.toString();
      const b = wb.view().state.doc.toString();
      (wa as any).stopBridge();
      (wb as any).stopBridge();
      wa.destroy();
      wb.destroy();
      return same([d.text, a, b], ['Shared A words B\n', 'Shared A words B\n', 'Shared A words B\n']);
    },
  },
  {
    id: 'host.split-editors.u05',
    feature: 'host.split-editors',
    name: 'Commands follow the Sheaf editor the person focused last',
    run: async () => {
      const h = makeHost();
      h.extension.activate(h.context);
      const d = h.doc('a.md', 'Hello\n');
      const pa = await h.open(d);
      const pb = await h.open(d);
      pb.setActive(false);
      pa.setActive(true);
      h.log.commands['sheaf.toggleSourceMode']();
      const n = (p: any): number => p.posted.filter((m: any) => m.type === 'toggleSourceMode').length;
      return same([n(pa), n(pb)], [1, 0]);
    },
  },

  // host.settings-live
  {
    id: 'host.settings-live.u01',
    feature: 'host.settings-live',
    name: 'Changing a sheaf setting sends every open Sheaf editor the new values; other settings send nothing',
    run: async () => {
      const h = makeHost();
      const pa = await h.open(h.doc('a.md', 'A\n'));
      const pb = await h.open(h.doc('b.md', 'B\n'));
      await h.setSetting('editor.fontSize', 20);
      await h.setSetting('sheaf.contentWidth', '90ch');
      const cfg = (p: any): any[] => p.posted.filter((m: any) => m.type === 'configChanged').map((m: any) => m.config.contentWidth);
      return same([cfg(pa), cfg(pb)], [['90ch'], ['90ch']]);
    },
  },
  {
    id: 'host.settings-live.u02',
    feature: 'host.settings-live',
    name: 'A new content width reaches the page column without reopening',
    run: async () => {
      const w = webview('Text\n');
      const before = w.root.style.getPropertyValue('--md-content-width');
      w.send({ type: 'configChanged', config: { ...WEBVIEW_CONFIG, contentWidth: '420px' } });
      const after = w.root.style.getPropertyValue('--md-content-width');
      w.destroy();
      return same([before, after], ['708px', '420px']);
    },
  },
  {
    id: 'host.settings-live.u03',
    feature: 'host.settings-live',
    name: 'Turning reveal-on-line on shows the markers on the caret line without moving the caret',
    run: async () => {
      const w = webview('A **bold** word.\n\nNext line.\n');
      w.caret(4);
      await settle();
      const before = w.rendered().split('\n')[0];
      w.send({ type: 'configChanged', config: { ...WEBVIEW_CONFIG, revealSyntaxOnLine: true } });
      await settle();
      const after = w.rendered().split('\n')[0];
      w.destroy();
      return { ok: !before.includes('**') && after.includes('**bold**'), detail: `before ${j(before)} after ${j(after)}` };
    },
  },
  {
    id: 'host.settings-live.u04',
    feature: 'host.settings-live',
    name: 'Turning reveal-on-line off hides the markers on the caret line without moving the caret',
    run: async () => {
      const w = webview('A **bold** word.\n\nNext line.\n', { revealSyntaxOnLine: true });
      w.caret(4);
      await settle();
      const before = w.rendered().split('\n')[0];
      w.send({ type: 'configChanged', config: { ...WEBVIEW_CONFIG, revealSyntaxOnLine: false } });
      await settle();
      const after = w.rendered().split('\n')[0];
      w.destroy();
      return { ok: before.includes('**bold**') && !after.includes('**'), detail: `before ${j(before)} after ${j(after)}` };
    },
  },
  {
    id: 'host.settings-live.u05',
    feature: 'host.settings-live',
    name: 'Reveal-on-line turned on applies once the caret moves to another line',
    run: async () => {
      const w = webview('Plain start.\n\nA **bold** word.\n');
      w.send({ type: 'configChanged', config: { ...WEBVIEW_CONFIG, revealSyntaxOnLine: true } });
      w.caret('Plain start.\n\nA **'.length);
      await settle();
      const line = w.rendered().split('\n')[2];
      w.destroy();
      return { ok: line.includes('**bold**'), detail: j(line) };
    },
  },
  {
    id: 'host.settings-live.u06',
    feature: 'host.settings-live',
    name: 'A workspace value for a sheaf setting is the one sent to the editor',
    run: async () => {
      const h = makeHost();
      h.user['sheaf.contentWidth'] = '600px';
      const p = await h.open(h.doc('a.md', 'A\n'));
      await h.setSetting('sheaf.contentWidth', '900px', 'workspace');
      const init = p.posted.find((m: any) => m.type === 'init');
      const changed = p.posted.filter((m: any) => m.type === 'configChanged').at(-1);
      return same([init.config.contentWidth, changed && changed.config.contentWidth], ['600px', '900px']);
    },
  },

  // host.theme
  {
    id: 'host.theme.u01',
    feature: 'host.theme',
    name: 'The page, toolbar and text take their colors from the VS Code theme',
    run: () => {
      const css = CSS();
      const body = /html,\s*body\s*\{[^}]*\}/.exec(css)?.[0] || '';
      const toolbar = /\.sheaf-toolbar\s*\{[^}]*\}/.exec(css)?.[0] || '';
      const ok = /background:\s*var\(--vscode-editor-background\)/.test(body) && /--md-text:\s*var\(--vscode-editor-foreground\)/.test(css) && /background:\s*var\(--vscode-editor-background\)/.test(toolbar);
      return { ok, detail: `${j(body)} ${j(toolbar.slice(0, 200))}` };
    },
  },
  {
    id: 'host.theme.u02',
    feature: 'host.theme',
    name: 'Selected text uses the theme selection foreground, so it stays readable where the theme sets one (high contrast)',
    run: () => {
      const all = CSS() + THEME_TS();
      return { ok: /--vscode-editor-selectionForeground/.test(all), detail: 'no rule in webview.css or theme.ts reads --vscode-editor-selectionForeground' };
    },
  },
  {
    id: 'host.theme.u03',
    feature: 'host.theme',
    name: 'Every code highlight color reads a theme variable',
    run: () => {
      const src = THEME_TS();
      const block = src.slice(src.indexOf('HighlightStyle.define'), src.indexOf('export const notionTheme'));
      const colors = [...block.matchAll(/color:\s*'([^']+)'/g)].map((m) => m[1]);
      const bad = colors.filter((c) => c !== 'inherit' && !c.startsWith('var(--vscode-'));
      return { ok: colors.length > 5 && bad.length === 0, detail: `${colors.length} colors, not themed: ${j(bad)}` };
    },
  },
  {
    id: 'host.theme.u04',
    feature: 'host.theme',
    name: "Sheaf's menus draw a border from the theme, which high contrast themes rely on",
    run: () => {
      const css = CSS();
      const menu = /\.sheaf-tb-menu\s*\{[^}]*\}/.exec(css)?.[0] || '';
      const ctx = /\.sheaf-ctx-menu\s*\{[^}]*border[^}]*\}/.exec(css)?.[0] || '';
      const rule = /--md-rule:\s*var\(--vscode-widget-border/.test(css);
      return { ok: /border:\s*1px solid var\(--md-rule\)/.test(menu) && /border:\s*1px solid var\(--md-rule\)/.test(ctx) && rule, detail: `${j(menu.slice(0, 160))} ${j(ctx.slice(0, 160))}` };
    },
  },
  {
    id: 'host.theme.u05',
    feature: 'host.theme',
    name: 'Inline code text takes its color from the theme instead of one fixed color for every theme',
    run: () => {
      const rule = /\.tok-inline-code\s*\{[^}]*\}/.exec(CSS())?.[0] || '';
      const color = /(?:^|[;\s{])color:\s*([^;]+);/.exec(rule)?.[1]?.trim() || '';
      return { ok: color.includes('var(--'), detail: `.tok-inline-code color is ${j(color)}` };
    },
  },
];
