/*
 * Extension-host checks: the editor association sync in src/defaultEditor.ts and the
 * command routing in src/extension.ts.
 *
 * That code is TypeScript, and it imports `vscode`, which only exists inside a
 * running VS Code window. The `pretest` step bundles it into `test/host.bundle.cjs`
 * with `vscode` left external, and each check evaluates that bundle again against its
 * own stand-in for the module: a plain object holding the settings, the editors and
 * the commands a window would have. Evaluating it once per check keeps what one check
 * sets up from reaching the next one.
 *
 * What a stand-in cannot tell us is how VS Code itself behaves — which editor a click
 * in the Explorer opens, or which scope a settings write lands in. Those are checked
 * in a real window; these checks cover the decisions Sheaf makes.
 *
 * A few checks put the real webview behind the panel (`test/webview.mjs`), so a
 * document goes from the stand-in's text through the host and into `main.ts` and
 * back again, the whole way a keystroke travels.
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWebview } from './webview.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** The host code, bundled by `pretest` with `vscode` left for a check to supply. */
const BUNDLE = path.join(here, 'host.bundle.cjs');

/** vscode.ConfigurationTarget. */
const GLOBAL = 1;
const WORKSPACE = 2;

const ASSOCIATIONS = 'workbench.editorAssociations';
const SETTING = 'sheaf.useAsDefaultMarkdownEditor';

/**
 * A VS Code window: two settings scopes, and a record of everything Sheaf wrote,
 * opened or said.
 */
function makeWindow({ user = {}, workspace = {} } = {}) {
  const scopes = { [GLOBAL]: { ...user }, [WORKSPACE]: { ...workspace } };
  const documents = [];
  const files = new Set();
  /** What a file on disk holds, for the code that reads bytes rather than a document. */
  const contents = new Map();
  /** Folders that exist on disk, which `stat` tells apart from files. */
  const folders = new Set();
  /** Which offer on a notification the person takes, when one is put in front of them. */
  let answer;
  /** Who is told when a tab opens, as `tabGroups.onDidChangeTabs` tells them. */
  const tabListeners = new Set();
  /** Every file Sheaf wrote, in order: `{ path, bytes }` each. */
  const saved = [];
  const writes = [];
  const warnings = [];
  const messages = [];
  /** Everything Sheaf put on the clipboard, oldest first. */
  const copied = [];
  const executed = [];
  const handlers = new Map();
  /** Who is told when a document's text changes, as `onDidChangeTextDocument` tells them. */
  const changeListeners = new Set();
  /** Every replacement written into a document through `applyEdit`, in order. */
  const applied = [];
  /** The files a workspace search finds, and every search that was run: `{ include, exclude, maxResults }` each. */
  const workspaceFiles = [];
  const searches = [];
  /** The view type of every custom editor the extension registered, in order. */
  const editorProviders = [];
  /** File watchers still open: `{ path, listeners }` each, `path` the one file watched. */
  const watchers = new Set();
  /** Every path `fs.readFile` was asked for, in order. */
  const reads = [];
  /** `reason` is VS Code's TextDocumentChangeReason: 1 for Undo, 2 for Redo, absent otherwise. */
  const changed = (doc, reason) => changeListeners.forEach((fn) => fn({ document: doc, reason }));

  const id = (section, key) => (section ? `${section}.${key}` : key);
  const effective = (key) => (key in scopes[WORKSPACE] ? scopes[WORKSPACE][key] : scopes[GLOBAL][key]);

  /**
   * A setting written under a language's own heading, as `"[markdown]": { … }` in
   * settings.json. It wins over the same setting written plainly, which is how a
   * person turns one on for Markdown alone.
   */
  const override = (languageId, full) => {
    for (const target of [WORKSPACE, GLOBAL]) {
      const block = scopes[target][`[${languageId}]`];
      if (block && full in block) return block[full];
    }
    return undefined;
  };

  const getConfiguration = (section, scope) => ({
    get(key, fallback) {
      const full = id(section, key);
      const forLanguage = scope?.languageId === undefined ? undefined : override(scope.languageId, full);
      const value = forLanguage === undefined ? effective(full) : forLanguage;
      return value === undefined ? fallback : value;
    },
    inspect(key) {
      const full = id(section, key);
      return { key: full, globalValue: scopes[GLOBAL][full], workspaceValue: scopes[WORKSPACE][full] };
    },
    async update(key, value, target) {
      const full = id(section, key);
      writes.push({ key: full, target });
      if (value === undefined) {
        delete scopes[target][full];
      } else {
        scopes[target][full] = value;
      }
    },
  });

  const vscode = {
    ConfigurationTarget: { Global: GLOBAL, Workspace: WORKSPACE, WorkspaceFolder: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Range: class {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    WorkspaceEdit: class {
      constructor() {
        this.edits = [];
      }
      replace(uri, range, text) {
        this.edits.push({ uri, range, text });
      }
    },
    Uri: { joinPath: (uri, ...parts) => file(resolvePath(uri.path, parts)) },
    /** A glob under a folder; the watchers here only ever watch one file by name. */
    RelativePattern: class {
      constructor(base, pattern) {
        this.baseUri = base;
        this.pattern = pattern;
      }
    },
    /** The tab input VS Code gives a tab showing a custom editor. */
    TabInputCustom: class {
      constructor(uri, viewType) {
        this.uri = uri;
        this.viewType = viewType;
      }
    },
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeTextDocument: (fn) => {
        changeListeners.add(fn);
        return { dispose: () => changeListeners.delete(fn) };
      },
      getWorkspaceFolder: () => undefined,
      /** The documents open in the window, which is where an unsaved change to a file lives. */
      get textDocuments() {
        return documents;
      },
      /** The document for a file; the checks open the ones Sheaf writes to first. */
      openTextDocument: async (uri) => {
        const doc = documents.find((d) => d.uri.path === uri.path);
        if (!doc) throw new Error(`no such file: ${uri.path}`);
        return doc;
      },
      /** A watcher on the one file a relative pattern names, told when it changes on disk. */
      createFileSystemWatcher: (pattern) => {
        const listeners = { change: new Set(), create: new Set(), delete: new Set() };
        const watcher = { path: `${pattern.baseUri.path.replace(/\/$/, '')}/${pattern.pattern}`, listeners };
        watchers.add(watcher);
        const on = (kind) => (fn) => {
          listeners[kind].add(fn);
          return { dispose: () => listeners[kind].delete(fn) };
        };
        return {
          onDidChange: on('change'),
          onDidCreate: on('create'),
          onDidDelete: on('delete'),
          dispose: () => watchers.delete(watcher),
        };
      },
      asRelativePath: (uri) => uri.path.replace(/^\//, ''),
      /** The workspace's files, as a search over the window finds them. */
      findFiles: async (include, exclude, maxResults) => {
        searches.push({ include, exclude, maxResults });
        return workspaceFiles.map(file);
      },
      fs: {
        async stat(uri) {
          if (folders.has(uri.path)) return { type: 2 };
          if (!files.has(uri.path)) throw new Error(`no such file: ${uri.path}`);
          return { type: 1 };
        },
        async readFile(uri) {
          reads.push(uri.path);
          const bytes = contents.get(uri.path);
          if (!bytes) throw new Error(`no such file: ${uri.path}`);
          return bytes;
        },
        async createDirectory(uri) {
          if (files.has(uri.path)) throw new Error(`EEXIST: file already exists, mkdir '${uri.path}'`);
          folders.add(uri.path);
        },
        async writeFile(uri, bytes) {
          const parent = uri.path.slice(0, uri.path.lastIndexOf('/'));
          if (files.has(parent)) throw new Error(`ENOTDIR: not a directory, open '${uri.path}'`);
          files.add(uri.path);
          contents.set(uri.path, bytes);
          saved.push({ path: uri.path, bytes });
        },
      },
      /** Apply an edit the way VS Code does, against the document it names. */
      applyEdit: async (edit) => {
        for (const { uri, range, text } of edit.edits) {
          const doc = documents.find((d) => d.uri.path === uri.path);
          if (!doc) return false;
          doc.text = doc.text.slice(0, range.start.offset) + text + doc.text.slice(range.end.offset);
          doc.isDirty = true;
          applied.push({ path: uri.path, start: range.start.offset, end: range.end.offset, text });
          changed(doc);
        }
        return true;
      },
    },
    window: {
      activeTextEditor: undefined,
      showWarningMessage: async (message, ...items) => {
        warnings.push(message);
        return items.find((item) => item === answer);
      },
      showInformationMessage: (message) => messages.push(message),
      registerCustomEditorProvider: (viewType) => {
        editorProviders.push(viewType);
        return { dispose() {} };
      },
      /** The terminal the person is working in; undefined when the panel is closed. */
      activeTerminal: undefined,
      tabGroups: {
        onDidChangeTabs: (fn) => {
          tabListeners.add(fn);
          return { dispose: () => tabListeners.delete(fn) };
        },
      },
    },
    env: {
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
        readText: async () => copied[copied.length - 1] ?? '',
      },
    },
    commands: {
      registerCommand: (id, run) => {
        handlers.set(id, run);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
        // A command the extension registered runs, the way it does in a window. VS
        // Code's own (`vscode.open`, `vscode.openWith`) have nothing behind them here
        // and are only recorded.
        const handler = handlers.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
  };

  return {
    vscode,
    writes,
    warnings,
    /** Notifications Sheaf showed the person. */
    messages,
    /** Everything Sheaf put on the clipboard, oldest first. */
    copied,
    /** The associations stored in one scope, or undefined when that scope has none. */
    associations: (target) => scopes[target][ASSOCIATIONS],
    /** Writes that landed in one scope. */
    writesTo: (target) => writes.filter((w) => w.target === target),
    /** Run a command the extension registered, the way the Command Palette would. */
    run: (id, ...args) => handlers.get(id)(...args),
    /** The commands the extension registered when it activated. */
    registered: () => [...handlers.keys()],
    /** The files opened in an editor, in order: `{ path, viewType }` each. */
    opened: () =>
      executed
        .filter(([command]) => command === 'vscode.openWith')
        .map(([, uri, viewType]) => ({ path: uri.path, viewType })),
    /** The same, with the editor group each was aimed at: undefined means the active one. */
    openedIn: () =>
      executed
        .filter(([command]) => command === 'vscode.openWith')
        .map(([, uri, viewType, column]) => ({ path: uri.path, viewType, column })),
    /** Put a plain text editor in front of the person. */
    focusText: (path) => {
      vscode.window.activeTextEditor = { document: { uri: { path } } };
    },
    /**
     * A terminal open and in front of the person. It records what was typed into it,
     * whether that was submitted, and how often Sheaf brought it forward.
     */
    openTerminal: () => {
      const terminal = {
        /** `{ text, submit }` for every `sendText`, in order. */
        sent: [],
        shown: 0,
        sendText: (text, submit) => terminal.sent.push({ text, submit }),
        show: () => terminal.shown++,
      };
      vscode.window.activeTerminal = terminal;
      return terminal;
    },
    /** Files that exist on disk, for an address that resolves to one. */
    addFile: (...paths) => paths.forEach((path) => files.add(path)),
    /** Files a workspace search finds. */
    addWorkspaceFiles: (...paths) => workspaceFiles.push(...paths),
    /** Every workspace search Sheaf ran. */
    searches,
    /** The view type of every custom editor the extension registered. */
    editorProviders,
    /** A file on disk with bytes in it, for the code that reads a file rather than a document. */
    addFileHolding: (path, text) => {
      files.add(path);
      contents.set(path, Buffer.from(text, 'utf8'));
    },
    /** Every path read from disk as bytes, in order. */
    reads,
    /** How many file watchers are open. */
    openWatchers: () => watchers.size,
    /**
     * A file on disk changing under the window, from git or another program: its
     * bytes change and every watcher on it is told, as VS Code tells them.
     */
    changeOnDisk: (path, text) => {
      const existed = files.has(path);
      if (text === undefined) {
        files.delete(path);
        contents.delete(path);
      } else {
        files.add(path);
        contents.set(path, Buffer.from(text, 'utf8'));
      }
      const kind = text === undefined ? 'delete' : existed ? 'change' : 'create';
      for (const w of watchers) if (w.path === path) w.listeners[kind].forEach((fn) => fn(file(path)));
    },
    /** The offer the person takes on the next notification that makes one. */
    answerWith: (label) => {
      answer = label;
    },
    /** A tab opening on a file, in the editor named by `viewType`. */
    openTab: (path, viewType = SHEAF) => {
      const opened = [{ input: new vscode.TabInputCustom(file(path), viewType) }];
      tabListeners.forEach((fn) => fn({ opened, closed: [], changed: [] }));
    },
    /** Folders that exist on disk, which a file of the same name is not. */
    addFolder: (...paths) => paths.forEach((path) => folders.add(path)),
    /** Every file Sheaf wrote to disk: `{ path, bytes }` each. */
    saved,
    /** The files opened by address, in order, as `vscode.open` was asked for them. */
    openedByAddress: () =>
      executed.filter(([command]) => command === 'vscode.open').map(([, uri]) => uri.path),
    /** Every replacement Sheaf wrote into a document: `{ path, start, end, text }` each. */
    applied,
    /**
     * The document's text changed from outside Sheaf: another editor, an agent, a pull.
     * Those who asked are told, as VS Code tells them.
     */
    writeFromOutside: (doc, text) => {
      doc.text = text;
      changed(doc);
    },
    /**
     * The document was edited by something other than Sheaf's webview and now differs
     * from the file: a command run from the Command Palette, a formatter, a code
     * action. This is what VS Code's own Undo does to a custom editor, which undoes
     * the document's edit stack rather than anything inside the webview.
     */
    editFromOutside: (doc, text) => {
      doc.text = text;
      doc.isDirty = true;
      changed(doc);
    },
    /** Undo or Redo from VS Code's Edit menu: the document's own stack, reported with its reason. */
    undoFromMenu: (doc, text, redo = false) => {
      doc.text = text;
      doc.isDirty = true;
      changed(doc, redo ? 2 : 1);
    },
    /** A Markdown file open in the window, which Sheaf can be resolved against. */
    openDocument: (path, text, { eol = 1, languageId = 'markdown' } = {}) => {
      const doc = {
        uri: file(path),
        text,
        eol,
        languageId,
        isClosed: false,
        isDirty: false,
        isUntitled: false,
        /** How many times Sheaf wrote this document to disk. */
        saves: 0,
        getText: () => doc.text,
        positionAt: (offset) => ({ offset }),
        async save() {
          doc.saves++;
          // VS Code's own trailing-whitespace save participant, which every save
          // runs. It spares the whitespace a text editor's cursor is sitting in,
          // and a custom editor has no text editor behind it for the participant
          // to read a cursor from, so here it takes every line's.
          const trimming = getConfiguration('files', { uri: doc.uri, languageId: doc.languageId }).get(
            'trimTrailingWhitespace',
            false
          );
          const trimmed = trimming ? doc.text.replace(/[ \t]+$/gm, '') : doc.text;
          if (trimmed !== doc.text) {
            doc.text = trimmed;
            changed(doc);
          }
          doc.isDirty = false;
          return true;
        },
      };
      documents.push(doc);
      return doc;
    },
  };
}

/** Resolve `parts` against `base`, the way `vscode.Uri.joinPath` does. */
function resolvePath(base, parts) {
  const segments = base.split('/').filter(Boolean);
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`;
}

/**
 * The webview panel a custom editor is resolved into, with the three things a
 * person does to it: type, click away, and close the tab. `deliver` receives what
 * the host posts to the webview, a turn later, the way a real post arrives.
 */
function makePanel(deliver) {
  const onMessage = [];
  const onViewState = [];
  const onDispose = [];
  const posted = [];
  const panel = {
    active: true,
    /** The editor group the panel sits in; a check that splits the window sets it. */
    viewColumn: undefined,
    /** Everything the host sent the webview. */
    posted,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://sheaf',
      asWebviewUri: (uri) => ({ toString: () => `https://webview${uri.path}` }),
      postMessage: async (message) => {
        posted.push(message);
        if (deliver) setTimeout(() => deliver(message), 0);
      },
      onDidReceiveMessage: (fn) => {
        onMessage.push(fn);
        return { dispose() {} };
      },
    },
    onDidChangeViewState: (fn) => {
      onViewState.push(fn);
      return { dispose() {} };
    },
    onDidDispose: (fn) => {
      onDispose.push(fn);
      return { dispose() {} };
    },
    /** A message from the webview, such as an edit the person typed. */
    receive: (message) => onMessage.forEach((fn) => fn(message)),
    /** The editor gaining or losing focus. */
    setActive: (active) => {
      panel.active = active;
      onViewState.forEach((fn) => fn({ webviewPanel: panel }));
    },
    /** The tab closing. */
    close: () => onDispose.forEach((fn) => fn()),
  };
  return panel;
}

/** Let everything already queued settle: the edit queue writes across a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A file, as far as the host code is concerned. */
const file = (path) => ({ path, toString: () => `file://${path}` });

const SHEAF = 'sheaf.wysiwyg';

/** The extension manifest, as VS Code reads it. */
function manifest() {
  return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
}

/** The `when` clause VS Code is handed for the Explorer's Open in Sheaf item. */
function explorerWhenClause() {
  const items = manifest().contributes.menus['explorer/context'] ?? [];
  return items.find((item) => item.command === 'sheaf.openWithWysiwyg')?.when ?? '';
}

/**
 * Every view type named in a `when` clause anywhere in the manifest, quoted or not.
 * Menus and keybindings both gate on `activeCustomEditorId`, and each one is another
 * copy of a value that lives in the provider.
 */
function whenClauseViewTypes() {
  const m = manifest();
  const clauses = [
    ...Object.values(m.contributes.menus ?? {}).flat(),
    ...(m.contributes.keybindings ?? []),
  ]
    .map((item) => item.when)
    .filter(Boolean);
  return clauses.flatMap((clause) => [...clause.matchAll(/activeCustomEditorId\s*==\s*'?([\w.]+)'?/g)].map((m) => m[1]));
}

/** The command IDs the manifest contributes. */
function contributedCommands() {
  return (manifest().contributes.commands ?? []).map((command) => command.command);
}

/** The keybinding the manifest contributes for one command, if it contributes any. */
function contributedKeybinding(command) {
  return (manifest().contributes.keybindings ?? []).find((binding) => binding.command === command);
}

/** The command palette's own entry for one command, which decides when it is offered. */
function paletteEntry(command) {
  const items = manifest().contributes.menus?.commandPalette ?? [];
  return items.find((item) => item.command === command);
}

/** The command IDs the manifest's menu items run. */
function menuCommands() {
  const menus = manifest().contributes.menus ?? {};
  return Object.values(menus)
    .flat()
    .map((item) => item.command)
    .filter(Boolean);
}

/** The filename patterns the manifest contributes Sheaf's editor for. */
function customEditorPatterns() {
  const editors = manifest().contributes.customEditors ?? [];
  const sheaf = editors.find((editor) => editor.viewType === SHEAF);
  return (sheaf?.selector ?? []).map((selector) => selector.filenamePattern).filter(Boolean);
}

/** `*.md` is the manifest's spelling of the extension `.md`. */
const asExtension = (pattern) => pattern.replace(/^\*/, '');

const sorted = (list) => [...list].sort();

/**
 * Read that clause the way VS Code reads it: `key =~ /pattern/flags` builds a regular
 * expression, which the menu item then stands or falls by.
 */
function whenRegex(clause) {
  const parsed = /^resourceExtname =~ \/(.*)\/([a-z]*)$/.exec(clause);
  return parsed ? new RegExp(parsed[1], parsed[2]) : undefined;
}

const same = (value, expected) => JSON.stringify(value) === JSON.stringify(expected);

const OPTED_OUT = { '*.md': 'default', '*.markdown': 'default' };

/**
 * Build the host bundle once, then hand back the checks. Each one evaluates the
 * bundle again against its own window.
 */
async function hostCases() {
  const code = readFileSync(BUNDLE, 'utf8');

  /** Evaluate the bundle, handing it one window as its `vscode` module. */
  const load = (window) => {
    const module = { exports: {} };
    const supply = (id) => (id === 'vscode' ? window.vscode : require(id));
    new Function('module', 'exports', 'require', code)(module, module.exports, supply);
    return module.exports;
  };

  /** Load the host code into a window and activate the extension in it. */
  const start = (win = makeWindow()) => {
    const host = load(win);
    host.activate({ subscriptions: [], extensionUri: file('/extension') });
    return { host, win };
  };

  const cases = [];
  const check = (name, run) => cases.push({ name, run });

  check('default editor: turning Sheaf off for a workspace points Markdown at the text editor in workspace settings', async () => {
    const win = makeWindow({ workspace: { [SETTING]: false } });
    await load(win).syncDefaultEditorAssociation();
    return same(win.associations(WORKSPACE), OPTED_OUT) && win.associations(GLOBAL) === undefined;
  });

  check('default editor: resetting the workspace setting clears the opt-out it left in workspace settings', async () => {
    const win = makeWindow({ workspace: { [ASSOCIATIONS]: { ...OPTED_OUT } } });
    await load(win).syncDefaultEditorAssociation();
    return same(win.associations(WORKSPACE), {});
  });

  check('default editor: turning Sheaf on for a workspace clears the opt-out left in user settings', async () => {
    const win = makeWindow({
      user: { [SETTING]: false, [ASSOCIATIONS]: { ...OPTED_OUT } },
      workspace: { [SETTING]: true },
    });
    await load(win).syncDefaultEditorAssociation();
    return same(win.associations(GLOBAL), {}) && win.associations(WORKSPACE) === undefined;
  });

  check('default editor: turning Sheaf off and on again in user settings leaves no opt-out behind', async () => {
    const win = makeWindow({ user: { [SETTING]: false } });
    const host = load(win);
    await host.syncDefaultEditorAssociation();
    const optedOut = same(win.associations(GLOBAL), OPTED_OUT);
    win.vscode.workspace.getConfiguration().update(SETTING, true, GLOBAL);
    await host.syncDefaultEditorAssociation();
    return optedOut && same(win.associations(GLOBAL), {});
  });

  check('default editor: an association left over from an earlier name is cleared from either scope', async () => {
    const win = makeWindow({
      user: { [ASSOCIATIONS]: { '*.md': 'nib.wysiwyg' } },
      workspace: { [ASSOCIATIONS]: { '*.markdown': 'md-editor.wysiwyg' } },
    });
    await load(win).syncDefaultEditorAssociation();
    return same(win.associations(GLOBAL), {}) && same(win.associations(WORKSPACE), {});
  });

  check('default editor: an association the user pointed at another editor is left alone', async () => {
    const other = { '*.md': 'vscode.markdown.preview.editor' };
    const win = makeWindow({ user: { [ASSOCIATIONS]: { ...other } } });
    await load(win).syncDefaultEditorAssociation();
    return same(win.associations(GLOBAL), other) && win.writes.length === 0;
  });

  check('default editor: a scope holding nothing of Sheaf’s is never written to', async () => {
    const win = makeWindow();
    await load(win).syncDefaultEditorAssociation();
    return win.writes.length === 0;
  });

  check('open in Sheaf: run from a Sheaf editor, it opens nothing and reports nothing', async () => {
    const { host, win } = start();
    host.MarkdownEditorProvider.active = { document: { uri: file('/ws/a.md') } };
    await win.run('sheaf.openWithWysiwyg');
    return win.opened().length === 0 && win.messages.length === 0;
  });

  check('open in Sheaf: run with no editor open, it reports there is no Markdown file', async () => {
    const { win } = start();
    await win.run('sheaf.openWithWysiwyg');
    return win.opened().length === 0 && same(win.messages, ['Sheaf: no Markdown file to open.']);
  });

  check('open in Sheaf: run from a text editor, it opens that file even with a Sheaf editor in the background', async () => {
    const { host, win } = start();
    host.MarkdownEditorProvider.active = { document: { uri: file('/ws/background.md') } };
    win.focusText('/ws/front.md');
    await win.run('sheaf.openWithWysiwyg');
    return same(win.opened(), [{ path: '/ws/front.md', viewType: SHEAF }]) && win.messages.length === 0;
  });

  check('open as raw Markdown: run from a text editor, it opens nothing', async () => {
    const { host, win } = start();
    host.MarkdownEditorProvider.active = { document: { uri: file('/ws/background.md') } };
    win.focusText('/ws/front.md');
    await win.run('sheaf.openAsText');
    return win.opened().length === 0;
  });

  check('open as raw Markdown: run from a Sheaf editor, it opens that document as text', async () => {
    const { host, win } = start();
    host.MarkdownEditorProvider.active = { document: { uri: file('/ws/a.md') } };
    await win.run('sheaf.openAsText');
    return same(win.opened(), [{ path: '/ws/a.md', viewType: 'default' }]);
  });

  check('open as raw Markdown: handed a file, it opens that file whatever has focus', async () => {
    const { host, win } = start();
    host.MarkdownEditorProvider.active = { document: { uri: file('/ws/background.md') } };
    win.focusText('/ws/front.md');
    await win.run('sheaf.openAsText', file('/ws/asked-for.md'));
    return same(win.opened(), [{ path: '/ws/asked-for.md', viewType: 'default' }]);
  });

  check('source mode: run from a text editor, no Sheaf editor is told to toggle', async () => {
    const { host, win } = start();
    const posted = [];
    host.MarkdownEditorProvider.active = {
      document: { uri: file('/ws/background.md') },
      postMessage: (message) => posted.push(message),
    };
    win.focusText('/ws/front.md');
    await win.run('sheaf.toggleSourceMode');
    return posted.length === 0;
  });

  check('source mode: run from a Sheaf editor, that editor toggles', async () => {
    const { host, win } = start();
    const posted = [];
    host.MarkdownEditorProvider.active = {
      document: { uri: file('/ws/a.md') },
      postMessage: (message) => posted.push(message),
    };
    await win.run('sheaf.toggleSourceMode');
    return same(posted, [{ type: 'toggleSourceMode' }]);
  });

  check('open in Sheaf: every Markdown file selected in the Explorer opens, not only the one clicked', async () => {
    const { win } = start();
    const a = file('/ws/a.md');
    const b = file('/ws/b.md');
    await win.run('sheaf.openWithWysiwyg', b, [a, b]);
    return same(win.opened(), [
      { path: '/ws/a.md', viewType: SHEAF },
      { path: '/ws/b.md', viewType: SHEAF },
    ]);
  });

  check('open in Sheaf: a right-click with one file selected opens that file', async () => {
    const { win } = start();
    const a = file('/ws/a.md');
    await win.run('sheaf.openWithWysiwyg', a, [a]);
    return same(win.opened(), [{ path: '/ws/a.md', viewType: SHEAF }]);
  });

  check('open in Sheaf: a selection holding a file Sheaf does not open leaves that file alone', async () => {
    const { win } = start();
    const selection = [file('/ws/a.md'), file('/ws/notes.txt'), file('/ws/NOTES.MD')];
    await win.run('sheaf.openWithWysiwyg', selection[0], selection);
    return same(win.opened(), [
      { path: '/ws/a.md', viewType: SHEAF },
      { path: '/ws/NOTES.MD', viewType: SHEAF },
    ]);
  });

  /**
   * Open a document in Sheaf: a window, a document, and a resolved editor over it.
   * `type` puts a whole document back the way the webview does after a keystroke.
   */
  /**
   * One window with the host code loaded into it. Several editors share it, which is
   * what makes a document that is already open distinguishable from one that is not.
   */
  const sheafWindow = () => {
    const win = makeWindow();
    return { win, host: load(win) };
  };

  const openInSheaf = async (text = 'Some words.\n', path = '/ws/notes.md', ctx = sheafWindow()) => {
    const { win, host } = ctx;
    const document = win.openDocument(path, text);
    const panel = makePanel();
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    const type = async (whole) => {
      panel.receive({ type: 'edit', text: whole });
      await settle();
    };
    /** What the webview asks for once it has mounted. */
    const ready = () => panel.receive({ type: 'ready' });
    const init = () => panel.posted.find((message) => message.type === 'init');
    return { win, ctx, document, panel, type, ready, init };
  };

  /**
   * A document open in Sheaf with the real webview behind the panel: the host code and
   * `src/webview/main.ts` talking through the panel's messages and nothing else.
   */
  const openWithWebview = async (text, eol, settings) => {
    const win = makeWindow(settings);
    const host = load(win);
    const document = win.openDocument('/ws/notes.md', text, { eol });
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    webview = bootWebview((message) => panel.receive(message));
    await settle(); // `ready` went out as the page loaded; `init` comes back a turn later.
    /** Two characters into `word`, in what the webview holds. */
    const into = (word) => webview.doc().indexOf(word) + 2;
    return { win, document, panel, webview, into };
  };

  const CRLF_EOL = 2;

  check('open as raw Markdown from the toolbar opens the text editor in the Sheaf editor’s own group, not the focused one', async () => {
    // Two groups side by side, the right one focused, and the left file's toolbar pressed.
    // An activated window, so the command the toolbar runs is registered.
    const { win, panel } = await openInSheaf('Left file words.\n', '/ws/left.md', start());
    panel.viewColumn = 1;
    panel.receive({ type: 'openAsText' });
    await settle();
    return same(win.openedIn(), [{ path: '/ws/left.md', viewType: 'default', column: 1 }]);
  });

  check('CRLF file: a write from outside shows the file’s lines in the webview, keeps the caret, and the next keystroke writes only itself', async () => {
    const { win, document, webview, into } = await openWithWebview('First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n', CRLF_EOL);
    webview.click(into('Third'));
    win.writeFromOutside(document, 'First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n');
    await settle();
    const lines = webview.lines();
    const caretKept = webview.caret() === into('Third');
    webview.click(into('Second'));
    webview.type('Z');
    await settle();
    webview.close();
    return (
      same(lines, ['First line changed.', '', 'Second line.', '', 'Third line.', '']) &&
      caretKept &&
      document.text === 'First line changed.\r\n\r\nSeZcond line.\r\n\r\nThird line.\r\n' &&
      same(win.applied, [{ path: '/ws/notes.md', start: 25, end: 25, text: 'Z' }])
    );
  });

  check('CRLF file: a letter typed in the text editor beside Sheaf and then one typed in Sheaf each write only themselves', async () => {
    const { win, document, webview, into } = await openWithWebview('One line.\r\n\r\nTwo line.\r\n', CRLF_EOL);
    win.writeFromOutside(document, 'OXne line.\r\n\r\nTwo line.\r\n');
    await settle();
    webview.click(into('Two') - 1);
    webview.type('Y');
    await settle();
    webview.close();
    return (
      document.text === 'OXne line.\r\n\r\nTYwo line.\r\n' &&
      same(win.applied, [{ path: '/ws/notes.md', start: 15, end: 15, text: 'Y' }])
    );
  });

  check('LF file: a write from outside shows the file’s lines in the webview, keeps the caret, and the next keystroke writes only itself', async () => {
    const { win, document, webview, into } = await openWithWebview('First line.\n\nSecond line.\n\nThird line.\n', 1);
    webview.click(into('Third'));
    win.writeFromOutside(document, 'First line changed.\n\nSecond line.\n\nThird line.\n');
    await settle();
    const lines = webview.lines();
    const caretKept = webview.caret() === into('Third');
    webview.click(into('Second'));
    webview.type('Z');
    await settle();
    webview.close();
    return (
      same(lines, ['First line changed.', '', 'Second line.', '', 'Third line.', '']) &&
      caretKept &&
      document.text === 'First line changed.\n\nSeZcond line.\n\nThird line.\n' &&
      same(win.applied, [{ path: '/ws/notes.md', start: 23, end: 23, text: 'Z' }])
    );
  });

  /**
   * Long enough for the auto-save debounce to have run. These checks are about what
   * a save does to what the person is still typing, so the pause has to be real.
   */
  const AFTER_THE_PAUSE = 1000;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** `"[markdown]": { "files.trimTrailingWhitespace": true }`, as a person writes it. */
  const TRIMS_MARKDOWN = { user: { '[markdown]': { 'files.trimTrailingWhitespace': true } } };

  check('trailing whitespace: a space typed before the pause is still there when typing carries on', async () => {
    const { document, webview } = await openWithWebview('Start \n', 1, TRIMS_MARKDOWN);
    webview.click(webview.doc().indexOf('\n'));
    webview.type('hello ');
    await settle();
    await pause(AFTER_THE_PAUSE);
    const heldAfterTheSave = webview.doc();
    webview.type('world');
    await settle();
    // The save itself must still have happened, and the file must still have been
    // trimmed: this keeps the person's line, it does not switch the setting off.
    const savedOnce = document.saves === 1 && document.text === 'Start hello world\n';
    await pause(AFTER_THE_PAUSE);
    webview.close();
    return (
      heldAfterTheSave === 'Start hello \n' &&
      savedOnce &&
      document.saves === 2 &&
      document.text === 'Start hello world\n'
    );
  });

  check('trailing whitespace: a space left on another line is trimmed by the save, and the save is not held up', async () => {
    const { document, webview } = await openWithWebview('Start \n\nTail  \n', 1, TRIMS_MARKDOWN);
    webview.click(webview.doc().indexOf('\n'));
    webview.type('hello');
    await settle();
    await pause(AFTER_THE_PAUSE);
    const held = webview.doc();
    webview.close();
    return document.saves === 1 && document.text === 'Start hello\n\nTail\n' && held === 'Start hello\n\nTail\n';
  });

  check('trailing whitespace: the editor losing focus keeps the space the person is typing in', async () => {
    const { document, panel, webview } = await openWithWebview('Start \n', 1, TRIMS_MARKDOWN);
    webview.click(webview.doc().indexOf('\n'));
    webview.type('hello ');
    await settle();
    panel.setActive(false);
    await settle();
    const heldAfterTheSave = webview.doc();
    webview.type('world');
    await settle();
    webview.close();
    return heldAfterTheSave === 'Start hello \n' && document.text === 'Start hello world\n';
  });

  check('trailing whitespace: with the setting off, a space typed before the pause reaches the file', async () => {
    const { document, webview } = await openWithWebview('Start \n', 1);
    webview.click(webview.doc().indexOf('\n'));
    webview.type('hello ');
    await settle();
    await pause(AFTER_THE_PAUSE);
    const held = webview.doc();
    webview.type('world');
    await settle();
    webview.close();
    return held === 'Start hello \n' && document.saves === 1 && document.text === 'Start hello world\n';
  });

  check('trailing whitespace: a write from outside that trims the file reaches the webview', async () => {
    // Another editor, a formatter or a pull may trim the same whitespace, and that
    // is news the webview has to be told. Only Sheaf's own save is excused.
    const { win, document, webview } = await openWithWebview('Start \n', 1, TRIMS_MARKDOWN);
    webview.click(webview.doc().indexOf('\n'));
    webview.type('hello ');
    await settle();
    win.writeFromOutside(document, 'Start hello\n');
    await settle();
    const held = webview.doc();
    webview.close();
    return held === 'Start hello\n';
  });

  /*
   * A write from outside that was made from text read before the person's last
   * keystroke. The write wins, the way it does in any editor, and these are about
   * Sheaf saying so and leaving the person's words one key away.
   */

  /** A document with a paragraph to type into, and the stale text a tool writes back. */
  const BEFORE_THE_KEYSTROKE = 'Intro.\n\nSome words.\n';
  const STALE_WRITE = 'Intro changed.\n\nSome words.\n';
  const WITH_TYPING = 'Intro.\n\nSome ZZwords.\n';

  /** Type `ZZ` in front of `words`, the way the person does just before the tool writes. */
  const typeInProse = async (webview) => {
    webview.click(webview.doc().indexOf('words'));
    webview.type('ZZ');
    await settle();
  };

  check('lost text: a write made before the keystroke says what it took, and Undo brings it back', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    await typeInProse(webview);
    win.writeFromOutside(document, STALE_WRITE);
    await settle();
    const gone = webview.doc();
    const said = win.warnings.slice();
    // The person's own Undo, on the key. Nothing has been put back before this.
    const took = webview.press('Mod-z');
    await settle();
    const back = webview.doc();
    webview.close();
    return (
      gone === STALE_WRITE &&
      same(said, [
        'Sheaf: this file changed outside the editor, and your last change is gone: "ZZ". Undo brings it back.',
      ]) &&
      took &&
      back === WITH_TYPING &&
      // The restored text is the person's own, and it reaches the file.
      document.text === WITH_TYPING
    );
  });

  /** A document with a line to delete, and what a write from before the delete puts back. */
  const BEFORE_THE_DELETE = 'Intro.\n\nKeep this.\n\nDrop this line.\n\nEnd.\n';
  const AFTER_THE_DELETE = 'Intro.\n\nKeep this.\n\nEnd.\n';
  const deleteTheLine = async (webview) => {
    const doc = webview.doc();
    const at = doc.indexOf('Drop this line.');
    webview.select(at, at + 'Drop this line.\n\n'.length);
    webview.press('Backspace');
    await settle();
  };

  check('lost text: a write from before a delete, putting the deleted line back, says so, and Undo removes it again', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_DELETE, 1);
    await deleteTheLine(webview);
    const deleted = webview.doc();
    win.writeFromOutside(document, BEFORE_THE_DELETE.replace('Intro.', 'Intro changed.'));
    await settle();
    const said = win.warnings.slice();
    webview.press('Mod-z');
    await settle();
    const back = webview.doc();
    webview.close();
    return (
      deleted === AFTER_THE_DELETE &&
      same(said, [
        'Sheaf: this file changed outside the editor, and put back what you just removed: "Drop this line.". Undo removes it again.',
      ]) &&
      // Undo takes back the write, as it does for lost typing, which leaves the delete as it was.
      back === AFTER_THE_DELETE
    );
  });

  check('lost text: a write that keeps a delete the person just made says nothing', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_DELETE, 1);
    await deleteTheLine(webview);
    win.writeFromOutside(document, AFTER_THE_DELETE.replace('Intro.', 'Intro changed.'));
    await settle();
    const said = win.warnings.slice();
    webview.close();
    return said.length === 0;
  });

  check('lost text: the Undo on the notice does what the key does', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    win.answerWith('Undo');
    await typeInProse(webview);
    win.writeFromOutside(document, STALE_WRITE);
    await settle();
    await settle(); // The answer comes back, then the message reaches the webview.
    await settle();
    const back = webview.doc();
    webview.close();
    return back === WITH_TYPING && document.text === WITH_TYPING;
  });

  check('lost text: a write that leaves the typing alone says nothing and is not the editor’s to undo', async () => {
    // The tool read the file after the keystroke, so what the person typed is in what
    // it wrote. Nothing was taken, and Cmd+Z stays what it always is: their own edit.
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    await typeInProse(webview);
    win.writeFromOutside(document, 'Intro changed.\n\nSome ZZwords.\n');
    await settle();
    const shown = webview.doc();
    const took = webview.press('Mod-z');
    await settle();
    const afterUndo = webview.doc();
    webview.close();
    return (
      win.warnings.length === 0 &&
      shown === 'Intro changed.\n\nSome ZZwords.\n' &&
      // Undo takes back the person's own typing, not the write from outside.
      took &&
      afterUndo === 'Intro changed.\n\nSome words.\n'
    );
  });

  check('lost text: a write to a part of the file the person never touched says nothing', async () => {
    const { win, document, webview } = await openWithWebview('Intro.\n\nSome words.\n\nTail.\n', 1);
    webview.click(webview.doc().indexOf('words'));
    webview.type('ZZ');
    await settle();
    win.writeFromOutside(document, 'Intro.\n\nSome ZZwords.\n\nTail changed.\n');
    await settle();
    const shown = webview.doc();
    webview.close();
    return win.warnings.length === 0 && shown === 'Intro.\n\nSome ZZwords.\n\nTail changed.\n';
  });

  check('lost text: a write with nobody typing says nothing', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    win.writeFromOutside(document, 'Quite another document.\n');
    await settle();
    const shown = webview.doc();
    webview.close();
    return win.warnings.length === 0 && shown === 'Quite another document.\n';
  });

  check('lost text: a second write leaves the first notice’s Undo doing nothing', async () => {
    // VS Code cannot take a notification back once it is up, so the older one stays on
    // screen. What it must not do is act: the change it offered to undo is not the one
    // the editor has in front of it any more.
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    let pressUndoOnTheFirst;
    win.vscode.window.showWarningMessage = (message, ...items) => {
      win.warnings.push(message);
      // The person reads the first notice and presses its Undo only after a second
      // write has landed, which is the moment that offer went stale.
      return pressUndoOnTheFirst === undefined
        ? new Promise((resolve) => (pressUndoOnTheFirst = () => resolve(items[0])))
        : Promise.resolve(undefined);
    };
    await typeInProse(webview);
    win.writeFromOutside(document, STALE_WRITE);
    await settle();
    // They carry on typing into what the write left, and a second write takes that too.
    webview.click(webview.doc().indexOf('words'));
    webview.type('QQ');
    await settle();
    const second = 'Intro changed again.\n\nSome words.\n';
    win.writeFromOutside(document, second);
    await settle();
    pressUndoOnTheFirst();
    await settle();
    await settle();
    const shown = webview.doc();
    webview.close();
    return win.warnings.length === 2 && shown === second && document.text === second;
  });

  /*
   * Marks on the lines a write from outside put in, seen in the real webview. The prose
   * suite covers what gets marked; these cover the message path and the file.
   */

  /** The text of every line the webview shows marked with `cls`. */
  const markedLines = (webview, cls = 'sheaf-arrived') =>
    Array.from(webview.document().querySelectorAll(`.cm-line.${cls}`)).map((el) => el.textContent);

  const FOUR_PARAGRAPHS = 'One.\n\nTwo.\n\nThree.\n\nFour.\n';

  check('arriving changes: a write from outside marks the lines it changed and nothing else, and the file keeps its bytes', async () => {
    const { win, document, webview } = await openWithWebview(FOUR_PARAGRAPHS, 1);
    const atOpen = markedLines(webview).length + markedLines(webview, 'sheaf-arrived-deleted').length;
    const written = 'One, changed.\n\nTwo.\n\nThree.\n\nFour, changed.\n';
    win.writeFromOutside(document, written);
    await settle();
    const marked = markedLines(webview);
    // A second write adds to the marks rather than replacing them.
    const second = 'One, changed.\n\nTwo.\n\nThree, changed too.\n\nFour, changed.\n';
    win.writeFromOutside(document, second);
    await settle();
    const accumulated = markedLines(webview);
    const edits = webview.edits().length;
    webview.close();
    return (
      atOpen === 0 &&
      same(marked, ['One, changed.', 'Four, changed.']) &&
      same(accumulated, ['One, changed.', 'Three, changed too.', 'Four, changed.']) &&
      // Marks are drawn, never written: the file is exactly what the outside write left.
      document.text === second &&
      win.applied.length === 0 &&
      edits === 0 &&
      document.saves === 0
    );
  });

  check('arriving changes: typing on a marked line clears its mark, and the keystroke is all that reaches the file', async () => {
    const { win, document, webview } = await openWithWebview(FOUR_PARAGRAPHS, 1);
    win.writeFromOutside(document, 'One, changed.\n\nTwo.\n\nThree.\n\nFour, changed.\n');
    await settle();
    webview.click(webview.doc().indexOf('changed.'));
    webview.type('Z');
    await settle();
    const marked = markedLines(webview);
    webview.close();
    return (
      same(marked, ['Four, changed.']) &&
      document.text === 'One, Zchanged.\n\nTwo.\n\nThree.\n\nFour, changed.\n' &&
      same(win.applied, [{ path: '/ws/notes.md', start: 5, end: 5, text: 'Z' }])
    );
  });

  check('arriving changes: a write that took back typed text still marks its lines, and the notice is unchanged', async () => {
    const { win, document, webview } = await openWithWebview(BEFORE_THE_KEYSTROKE, 1);
    await typeInProse(webview);
    win.writeFromOutside(document, STALE_WRITE);
    await settle();
    const marked = markedLines(webview);
    const said = win.warnings.slice();
    webview.close();
    return (
      same(marked, ['Intro changed.', 'Some words.']) &&
      same(said, [
        'Sheaf: this file changed outside the editor, and your last change is gone: "ZZ". Undo brings it back.',
      ])
    );
  });

  check("arriving changes: the person's own Undo and Redo mark nothing", async () => {
    const { document, webview } = await openWithWebview(FOUR_PARAGRAPHS, 1);
    webview.click(webview.doc().indexOf('Two') + 3);
    webview.type(' typed');
    await settle();
    const undone = webview.press('Mod-z');
    await settle();
    const afterUndo = markedLines(webview).length + markedLines(webview, 'sheaf-arrived-deleted').length;
    const redone = webview.press('Mod-Shift-z');
    await settle();
    const afterRedo = markedLines(webview).length + markedLines(webview, 'sheaf-arrived-deleted').length;
    webview.close();
    return undone && redone && afterUndo === 0 && afterRedo === 0 && document.text === 'One.\n\nTwo typed.\n\nThree.\n\nFour.\n';
  });

  check('arriving changes: Undo and Redo from the Edit menu are the person’s own, and mark nothing', async () => {
    // The Edit menu works on the document's own stack and reaches the webview the way a
    // write from outside does. VS Code says why the document changed, and the host
    // passes that on, so the person's own undo is not drawn as somebody else's write.
    const { win, document, webview } = await openWithWebview(FOUR_PARAGRAPHS, 1);
    win.undoFromMenu(document, 'One.\n\nTwo restored.\n\nThree.\n\nFour.\n');
    await settle();
    const afterUndo = markedLines(webview);
    win.undoFromMenu(document, FOUR_PARAGRAPHS, true);
    await settle();
    const afterRedo = markedLines(webview);
    // The same change with no reason is a write from outside, and is marked.
    win.editFromOutside(document, 'One.\n\nTwo restored.\n\nThree.\n\nFour.\n');
    await settle();
    const outside = markedLines(webview);
    webview.close();
    return same(afterUndo, []) && same(afterRedo, []) && same(outside, ['Two restored.']);
  });

  check('auto-save: an edit and then the editor losing focus writes the file at once', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    const beforeBlur = document.saves;
    panel.setActive(false);
    // The debounce has not run: this is the flush getting ahead of the close dialog.
    return beforeBlur === 0 && document.saves === 1 && document.isDirty === false;
  });

  // Clicking the close button of the tab in front leaves the panel active until it is
  // gone, so VS Code reports no change of view state and the flush above never runs.
  // Focus does leave the page on that press, and the page says so.
  check('auto-save: focus leaving the page writes a pending edit at once, before the panel reports anything', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    const before = document.saves;
    panel.receive({ type: 'blur' });
    await settle();
    const dirtyWhenAsked = document.isDirty;
    // A second blur with nothing pending writes nothing more.
    panel.receive({ type: 'blur' });
    await settle();
    return before === 0 && dirtyWhenAsked === false && document.saves === 1;
  });

  check('auto-save: the page itself reports losing focus, so a typed letter is written before a close can ask', async () => {
    const { document, webview, into } = await openWithWebview('Some words.\n', 1);
    webview.click(into('words'));
    webview.type('Z');
    await settle();
    const before = document.saves;
    webview.window.dispatchEvent(new webview.window.FocusEvent('blur'));
    await settle();
    webview.close();
    return before === 0 && document.saves === 1 && document.isDirty === false && document.text === 'Some woZrds.\n';
  });

  check('auto-save: losing focus and then closing writes once, and leaves the close nothing to ask about', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    // Focus leaves the editor. This is the moment the flush gets ahead of the close.
    panel.setActive(false);
    // What VS Code reads when it decides whether to ask about saving. A real save is
    // disk I/O and this stand-in's is not, so this pins that the write has been
    // started and the document given up, rather than that it has landed in time.
    const dirtyWhenAsked = document.isDirty;
    const savedBeforeClose = document.saves;
    panel.close();
    // Both call sites run on this path, and only one of them may write.
    return dirtyWhenAsked === false && savedBeforeClose === 1 && document.saves === 1;
  });

  check('auto-save: an edit taken back on the document from outside the webview is written to the file', async () => {
    // What VS Code's built-in Undo does to a custom editor: it undoes the document's
    // own edit stack, which is where the edits Sheaf makes are written. The webview is
    // shown the result, and the file has to follow it, or Undo leaves the person
    // looking at one document and the file holding another.
    const { win, document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    await pause(AFTER_THE_PAUSE);
    const theEditWasSaved = document.saves === 1 && document.text === 'Some woZrds.\n';
    win.editFromOutside(document, 'Some words.\n');
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return theEditWasSaved && document.saves === 2 && document.text === 'Some words.\n' && document.isDirty === false;
  });

  check('auto-save: a document reloaded from disk is not written back', async () => {
    // A pull, a branch switch or an agent writing the file leaves the document
    // matching what is on disk. There is nothing to save, and saving anyway would
    // rewrite a file Sheaf was only shown.
    const { win, document, panel } = await openInSheaf();
    win.writeFromOutside(document, 'Other words.\n');
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return document.saves === 0;
  });

  check('auto-save: an editor losing focus with nothing pending writes nothing', async () => {
    const { document, panel } = await openInSheaf();
    panel.setActive(false);
    panel.setActive(true);
    panel.setActive(false);
    return document.saves === 0;
  });

  check('auto-save: closing the editor writes a save that was still pending', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    panel.close();
    return document.saves === 1;
  });

  check('auto-save: a document that has already closed is not written', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    document.isClosed = true;
    panel.close();
    return document.saves === 0;
  });

  check('auto-save: an untitled document is never written, which would ask where to put it', async () => {
    const { document, panel, type } = await openInSheaf();
    document.isUntitled = true;
    await type('Some woZrds.\n');
    panel.setActive(false);
    return document.saves === 0;
  });

  check('auto-save: turned off, neither losing focus nor closing writes anything', async () => {
    const win = makeWindow({ user: { 'sheaf.autoSave': false } });
    const { MarkdownEditorProvider } = load(win);
    const document = win.openDocument('/ws/notes.md', 'Some words.\n');
    const panel = makePanel();
    await new MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    panel.receive({ type: 'edit', text: 'Some woZrds.\n' });
    await settle();
    panel.setActive(false);
    panel.close();
    return document.saves === 0 && document.text === 'Some woZrds.\n';
  });

  /** A pasted image arriving from the webview, as `setupImageIngestion` sends it. */
  const paste = (panel, name = 'shot.png') =>
    panel.receive({ type: 'saveImage', id: 'img-1', name, data: Buffer.from('png').toString('base64') });

  /** What the host told the webview about the image it was asked to save. */
  const imageReply = (panel) => panel.posted.find((message) => message.type === 'imageSaved');

  check('pasting an image: into a saved document, it lands in the assets folder beside that document', async () => {
    const { win, panel } = await openInSheaf();
    paste(panel);
    await settle();
    return (
      same(
        win.saved.map((f) => f.path),
        ['/ws/assets/shot.png']
      ) &&
      same(imageReply(panel), { type: 'imageSaved', id: 'img-1', path: 'assets/shot.png' }) &&
      win.warnings.length === 0
    );
  });

  check('pasting an image: into a document that was never saved, it says to save the document first', async () => {
    const { win, document, panel } = await openInSheaf();
    // Open in Sheaf on an untitled file: there is no folder beside it to write into.
    document.isUntitled = true;
    paste(panel);
    await settle();
    // Saying nothing at all is the bug this replaces, so the reason is what is pinned.
    return (
      win.saved.length === 0 &&
      same(win.warnings, [
        'Sheaf: save the document before pasting images. They go into an assets folder beside it, and a document that has never been saved has no folder yet.',
      ]) &&
      imageReply(panel)?.error !== undefined &&
      imageReply(panel)?.path === undefined
    );
  });

  check('pasting an image: with a file sitting where the assets folder would go, it says which name is taken', async () => {
    const { win, panel } = await openInSheaf();
    win.addFile('/ws/assets');
    paste(panel);
    await settle();
    return (
      win.saved.length === 0 &&
      same(win.warnings, [
        'Sheaf: could not save the image, because ws/assets is a file rather than a folder. Pasted images go into a folder of that name beside the document.',
      ]) &&
      imageReply(panel)?.path === undefined
    );
  });

  check('pasting an image: when the folder cannot be created, it says so and names the folder', async () => {
    const { win, panel } = await openInSheaf();
    win.vscode.workspace.fs.createDirectory = async () => {
      throw new Error('EACCES: permission denied');
    };
    paste(panel);
    await settle();
    return (
      win.saved.length === 0 &&
      win.warnings.length === 1 &&
      win.warnings[0].startsWith('Sheaf: could not create ws/assets to save the image into.') &&
      win.warnings[0].includes('EACCES: permission denied') &&
      imageReply(panel)?.path === undefined
    );
  });

  /**
   * A window whose extension has a workspace store, as VS Code gives every extension,
   * and a way to open a document in Sheaf there. `store` is what the store holds.
   */
  const withWorkspaceStore = (held = {}) => {
    const win = makeWindow();
    const host = load(win);
    const store = new Map(Object.entries(held));
    const workspaceState = {
      get: (key) => store.get(key),
      update: async (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    };
    const open = async (path = '/ws/notes.md') => {
      const document = win.openDocument(path, 'Plan.\n\n| Task | Status |\n| - | - |\n| a | Open |\n');
      const panel = makePanel();
      await new host.MarkdownEditorProvider({ extensionUri: file('/extension'), workspaceState }).resolveCustomTextEditor(document, panel, {});
      return panel;
    };
    return { store, open };
  };
  /** The host's answer to a request for the boards, as the page gets it. */
  const boardsReply = async (panel, id) => {
    panel.receive({ type: 'tableBoardsRead', id });
    await settle();
    return panel.posted.find((message) => message.type === 'tableBoards' && message.id === id);
  };
  const BOARDS_KEY = 'sheaf.tableBoards:file:///ws/notes.md';

  check('table boards: which tables are boards is kept in the workspace store under the document, never in the file, and the next page that asks gets it back', async () => {
    const { store, open } = withWorkspaceStore();
    const first = await open();
    const none = await boardsReply(first, 'boards-1');
    first.receive({ type: 'tableBoardsWrite', boards: { 'k1.2': { group: 'Status' } } });
    await settle();
    const kept = store.get(BOARDS_KEY);
    const second = await open();
    const back = await boardsReply(second, 'boards-2');
    // Another document keeps its own, and has none yet.
    const other = await boardsReply(await open('/ws/other.md'), 'boards-3');
    // A page that has no boards left takes the entry away rather than keeping an empty one.
    second.receive({ type: 'tableBoardsWrite', boards: {} });
    await settle();
    return (
      same(none, { type: 'tableBoards', id: 'boards-1', boards: {} }) &&
      same(kept, { 'k1.2': { group: 'Status' } }) &&
      same(back, { type: 'tableBoards', id: 'boards-2', boards: { 'k1.2': { group: 'Status' } } }) &&
      same(other?.boards, {}) &&
      !store.has(BOARDS_KEY) &&
      !first.posted.some((message) => message.type === 'setContent')
    );
  });

  check('table boards: a damaged or foreign stored value reads as no board, and a damaged write is cleaned before it is kept', async () => {
    const { store, open } = withWorkspaceStore({
      [BOARDS_KEY]: {
        'k1.2': { group: 'Status' },
        'k2.2': { group: 7 },
        'k3.2': 'Status',
        'k4.2': null,
        'k5.2': { group: 'x'.repeat(5000) },
        'k6.2': { group: 'Owner', rows: ['a', 'b'] },
        '': { group: 'Status' },
      },
    });
    const panel = await open();
    const read = await boardsReply(panel, 'boards-1');
    // Not an object of boards at all.
    const { open: openWrong } = withWorkspaceStore({ [BOARDS_KEY]: ['Status'] });
    const wrong = await boardsReply(await openWrong(), 'boards-2');
    panel.receive({ type: 'tableBoardsWrite', boards: { 'k7.2': { group: 'Stage', rows: [['a']] }, 'k8.2': { group: false } } });
    await settle();
    return (
      same(read?.boards, { 'k1.2': { group: 'Status' }, 'k6.2': { group: 'Owner' } }) &&
      same(wrong?.boards, {}) &&
      same(store.get(BOARDS_KEY), { 'k7.2': { group: 'Stage' } })
    );
  });

  /** What the host told the webview about the workspace's files. */
  const filesReply = (panel) => panel.posted.filter((message) => message.type === 'workspaceFiles');

  check('link completion: the host answers a file-list request with workspace-relative paths, leaving out dependencies and build output', async () => {
    const { win, panel } = await openInSheaf();
    win.addWorkspaceFiles('/ws/notes.md', '/ws/docs/plan.md', '/ws/img/logo.png');
    panel.receive({ type: 'workspaceFilesRead', id: 'files-1' });
    await settle();
    const [search] = win.searches;
    return (
      same(filesReply(panel), [{ type: 'workspaceFiles', id: 'files-1', files: ['ws/notes.md', 'ws/docs/plan.md', 'ws/img/logo.png'] }]) &&
      win.searches.length === 1 &&
      ['node_modules', '.git', 'dist'].every((name) => String(search.exclude).includes(name)) &&
      typeof search.maxResults === 'number' &&
      search.maxResults <= 5000
    );
  });

  check('link completion: a second request a moment later is answered without searching the workspace again', async () => {
    const { win, panel } = await openInSheaf();
    win.addWorkspaceFiles('/ws/notes.md', '/ws/docs/plan.md');
    panel.receive({ type: 'workspaceFilesRead', id: 'files-1' });
    await settle();
    panel.receive({ type: 'workspaceFilesRead', id: 'files-2' });
    await settle();
    const replies = filesReply(panel);
    return win.searches.length === 1 && replies.length === 2 && replies[1].id === 'files-2' && same(replies[1].files, replies[0].files);
  });

  check('link completion: typing [spec]( in Sheaf lists the workspace’s files, and Enter writes the path relative to the document', async () => {
    const win = makeWindow();
    const host = load(win);
    win.addWorkspaceFiles('/ws/docs/notes.md', '/ws/plan.md', '/ws/docs/my notes.md');
    const document = win.openDocument('/ws/docs/notes.md', 'See \n');
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    webview = bootWebview((message) => panel.receive(message));
    await settle();
    webview.click(4);
    for (const ch of '[spec](') webview.type(ch);
    // The request goes out a turn later, the host searches, and the answer comes back a turn after that.
    for (let i = 0; i < 4; i++) await settle();
    const rows = Array.from(webview.document().querySelectorAll('.sheaf-link-complete .sheaf-slash-label')).map((el) => el.textContent);
    const unchanged = document.text === 'See [spec](\n';
    webview.press('Enter');
    await settle();
    await settle();
    webview.close();
    return same(rows, ['../plan.md', 'my notes.md']) && unchanged && document.text === 'See [spec](../plan.md)\n';
  });

  /**
   * The workspace's own storage, as `ExtensionContext.workspaceState` gives it: a
   * key-value store that belongs to the workspace and to no file in it.
   */
  const workspaceMemento = () => {
    const store = new Map();
    return {
      store,
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      update: async (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => [...store.keys()],
    };
  };
  /** An editor on `path` whose extension context keeps `state` as its workspace storage. */
  const openWithStorage = async (ctx, state, path, text = '| A | B |\n| - | - |\n| 1 | 2 |\n') => {
    const document = ctx.win.openDocument(path, text);
    const panel = makePanel();
    const context = state ? { extensionUri: file('/extension'), workspaceState: state } : { extensionUri: file('/extension') };
    await new ctx.host.MarkdownEditorProvider(context).resolveCustomTextEditor(document, panel, {});
    return { document, panel };
  };
  const widthsReply = (panel) => panel.posted.filter((message) => message.type === 'tableWidths');

  check('column widths: widths one editor keeps are handed to the next editor on that document, and to no other', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const first = await openWithStorage(ctx, state, '/ws/notes.md');
    first.panel.receive({ type: 'tableWidthsWrite', widths: { k1: { 0: 180, 2: 96 } } });
    await settle();
    first.panel.close();
    const again = await openWithStorage(ctx, state, '/ws/notes.md');
    again.panel.receive({ type: 'tableWidthsRead', id: 'widths-1' });
    const other = await openWithStorage(ctx, state, '/ws/other.md');
    other.panel.receive({ type: 'tableWidthsRead', id: 'widths-1' });
    await settle();
    return (
      same(widthsReply(again.panel), [{ type: 'tableWidths', id: 'widths-1', widths: { k1: { 0: 180, 2: 96 } } }]) &&
      same(widthsReply(other.panel), [{ type: 'tableWidths', id: 'widths-1', widths: {} }])
    );
  });

  check('column widths: keeping widths writes nothing into the document or beside it', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const text = '| A | B |\n| - | - |\n| 1 | 2 |\n';
    const { document, panel } = await openWithStorage(ctx, state, '/ws/notes.md', text);
    panel.receive({ type: 'tableWidthsWrite', widths: { k1: { 1: 240 } } });
    await settle();
    return (
      document.text === text &&
      !document.isDirty &&
      ctx.win.applied.length === 0 &&
      ctx.win.saved.length === 0 &&
      state.store.size === 1 &&
      [...state.store.keys()][0].includes('file:///ws/notes.md')
    );
  });

  check('column widths: writing none clears what was kept, and what was kept is read with suspicion', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const { panel } = await openWithStorage(ctx, state, '/ws/notes.md');
    panel.receive({ type: 'tableWidthsWrite', widths: { k1: { 0: 180 } } });
    await settle();
    panel.receive({ type: 'tableWidthsWrite', widths: {} });
    await settle();
    const cleared = state.store.size === 0;
    // Whatever else put something under this document's key, only widths come back.
    state.store.set('sheaf.tableWidths:file:///ws/notes.md', { k1: { 0: 'wide', 1: 120, x: 5 }, k2: 'nothing', k3: { 0: -4 } });
    panel.receive({ type: 'tableWidthsRead', id: 'widths-2' });
    await settle();
    return cleared && same(widthsReply(panel), [{ type: 'tableWidths', id: 'widths-2', widths: { k1: { 1: 120 } } }]);
  });

  check('column widths: an editor with no workspace storage still answers, with no widths', async () => {
    const ctx = sheafWindow();
    const { panel } = await openWithStorage(ctx, null, '/ws/notes.md');
    panel.receive({ type: 'tableWidthsWrite', widths: { k1: { 0: 180 } } });
    panel.receive({ type: 'tableWidthsRead', id: 'widths-3' });
    await settle();
    return same(widthsReply(panel), [{ type: 'tableWidths', id: 'widths-3', widths: {} }]);
  });

  check('column widths: the page asks for its widths before it asks for the document, so they arrive first', async () => {
    const win = makeWindow();
    const host = load(win);
    const state = workspaceMemento();
    const document = win.openDocument('/ws/notes.md', '| A | B |\n| - | - |\n| 1 | 2 |\n');
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension'), workspaceState: state }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    panel.receive({ type: 'tableWidthsWrite', widths: { k1: { 0: 150 } } });
    await settle();
    webview = bootWebview((message) => panel.receive(message));
    await settle();
    const sent = webview.posted.map((message) => message.type);
    const received = panel.posted.map((message) => message.type);
    const reply = widthsReply(panel)[0];
    webview.close();
    return (
      sent.indexOf('tableWidthsRead') >= 0 &&
      sent.indexOf('tableWidthsRead') < sent.indexOf('ready') &&
      received.indexOf('tableWidths') >= 0 &&
      received.indexOf('tableWidths') < received.indexOf('init') &&
      same(reply?.widths, { k1: { 0: 150 } }) &&
      document.text === '| A | B |\n| - | - |\n| 1 | 2 |\n'
    );
  });

  /**
   * The declarations of every rule in the webview's stylesheet whose selector list
   * names `selector` exactly, merged, as `{ property: value }`. jsdom applies no
   * stylesheet, so what a rule says is read from the file.
   */
  const cssRule = (selector) => {
    const css = readFileSync(path.join(here, '..', 'media', 'webview.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const out = {};
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
      if (!selectors.includes(selector)) continue;
      for (const decl of m[2].split(';')) {
        const at = decl.indexOf(':');
        if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
      }
    }
    return out;
  };

  check('stylesheet: a tall cell is clamped to four lines on its text, both spellings, and never on the cell', () => {
    const clamp = cssRule('.sheaf-table .is-clamped > .sheaf-table-text');
    const cell = cssRule('.sheaf-table td');
    return (
      clamp['-webkit-line-clamp'] === '4' &&
      clamp['line-clamp'] === '4' &&
      clamp.display === '-webkit-box' &&
      clamp['-webkit-box-orient'] === 'vertical' &&
      clamp.overflow === 'hidden' &&
      !('-webkit-line-clamp' in cell) &&
      !('line-clamp' in cell) &&
      cell['vertical-align'] === 'top'
    );
  });

  check('stylesheet: a column of numbers draws its digits at one width', () => {
    return cssRule('.sheaf-table td.is-numeric')['font-variant-numeric'] === 'tabular-nums';
  });

  check('stylesheet: the header row sticks to the top of the editor, and a table that fits its frame lets it', () => {
    const head = cssRule('.sheaf-table thead tr');
    const frame = cssRule('.sheaf-table.has-widths:not(.is-scroll-x) > .sheaf-table-grid');
    return head.position === 'sticky' && head.top === '0' && !!head['z-index'] && !!head.background && frame['overflow-x'] === 'visible';
  });

  check('links: an address beside the document opens the file it names', async () => {
    const { win, panel } = await openInSheaf();
    win.addFile('/ws/signals.md', '/ws/log/2244-11.md');
    panel.receive({ type: 'openLink', address: 'log/2244-11.md' });
    await settle();
    return same(win.openedByAddress(), ['/ws/log/2244-11.md']) && win.warnings.length === 0;
  });

  check('links: an address reaching out of the document’s folder resolves from there, not from the workspace', async () => {
    const { win, panel } = await openInSheaf('# Log\n', '/ws/log/2244-11.md');
    win.addFile('/ws/maintenance.md');
    // The fragment rides along and names a heading; the file is what opens.
    panel.receive({ type: 'openLink', address: '../maintenance.md#work-plan' });
    await settle();
    return same(win.openedByAddress(), ['/ws/maintenance.md']);
  });

  check('links: an address naming a file that is not there opens nothing and says which one', async () => {
    const { win, panel } = await openInSheaf();
    panel.receive({ type: 'openLink', address: 'runbooks/beacon-silent.md' });
    await settle();
    return (
      win.openedByAddress().length === 0 &&
      same(win.warnings, ['Sheaf: runbooks/beacon-silent.md was not found.'])
    );
  });

  check('links: an address written with percent escapes opens the file those escapes name', async () => {
    const { win, panel } = await openInSheaf();
    win.addFile('/ws/my notes.md');
    panel.receive({ type: 'openLink', address: 'my%20notes.md' });
    await settle();
    return same(win.openedByAddress(), ['/ws/my notes.md']);
  });

  check('links: an address from the workspace root says why it cannot be followed outside a workspace', async () => {
    const { win, panel } = await openInSheaf();
    win.addFile('/ws/docs/notes.md', '/docs/notes.md');
    // Resolving it against the document's own folder would open the wrong file, so
    // nothing opens. Opening nothing and saying nothing is the failure this check
    // exists for, so it pins the message rather than the silence.
    panel.receive({ type: 'openLink', address: '/docs/notes.md' });
    await settle();
    return (
      win.openedByAddress().length === 0 &&
      same(win.warnings, [
        'Sheaf: /docs/notes.md starts at the workspace root, and this file is not in a workspace folder.',
      ])
    );
  });

  check('links: a link naming a heading hands it to the editor that opens the file', async () => {
    const { win, ctx, panel } = await openInSheaf();
    win.addFile('/ws/signals.md');
    panel.receive({ type: 'openLink', address: 'signals.md#detections' });
    await settle();
    // Opening the file resolves an editor for it, which asks for its content and is
    // given the heading to go to along with it.
    const target = await openInSheaf('# Signals\n\n## Detections\n', '/ws/signals.md', ctx);
    target.ready();
    return same(win.openedByAddress(), ['/ws/signals.md']) && target.init().fragment === 'detections';
  });

  check('links: a document already open is told to go to the heading, since it never resolves again', async () => {
    const ctx = sheafWindow();
    const target = await openInSheaf('# Signals\n\n## Detections\n', '/ws/signals.md', ctx);
    target.ready();
    const from = await openInSheaf('See [it](signals.md#detections).\n', '/ws/notes.md', ctx);
    ctx.win.addFile('/ws/signals.md');
    from.panel.receive({ type: 'openLink', address: 'signals.md#detections' });
    await settle();
    return same(
      target.panel.posted.filter((message) => message.type === 'revealFragment'),
      [{ type: 'revealFragment', id: 'detections' }]
    );
  });

  check('links: a heading reaches an editor that has opened but not yet asked for its content', async () => {
    const ctx = sheafWindow();
    const from = await openInSheaf('See [it](signals.md#detections).\n', '/ws/notes.md', ctx);
    ctx.win.addFile('/ws/signals.md');
    // Opening a file resolves its editor while the command is still running, and the
    // webview inside it has not loaded yet. It is listening for nothing, so anything
    // posted to it now is dropped, and a real editor spends time in this state.
    const target = await openInSheaf('# Signals\n\n## Detections\n', '/ws/signals.md', ctx);
    from.panel.receive({ type: 'openLink', address: 'signals.md#detections' });
    await settle();
    const spokenToTooEarly = target.panel.posted.length;
    // The webview finishes loading and asks for its content.
    target.ready();
    return spokenToTooEarly === 0 && target.init().fragment === 'detections';
  });

  check('capabilities: VS Code names none, because absence is what means it can do everything', async () => {
    // The webview reads `capabilities` to decide what the menus may offer, and a host
    // that cannot do a thing says so. VS Code says nothing at all, deliberately: if it
    // ever started sending a list of its own, every ability would depend on somebody
    // remembering to add it there, and forgetting would quietly take a command away.
    // A browser is the host that sends one, and that is checked in the server suite.
    const { ready, init } = await openInSheaf();
    ready();
    const message = init();
    return 'capabilities' in message === false && message.fileName !== undefined;
  });

  check('links: a link naming no heading hands nothing on', async () => {
    const { win, ctx, panel } = await openInSheaf();
    win.addFile('/ws/signals.md');
    panel.receive({ type: 'openLink', address: 'signals.md' });
    await settle();
    const target = await openInSheaf('# Signals\n', '/ws/signals.md', ctx);
    target.ready();
    return target.init().fragment === undefined && target.panel.posted.every((m) => m.type !== 'revealFragment');
  });

  /**
   * A tab that opened on a file VS Code refuses to read as text. Sheaf's editor is
   * never resolved for one, so nothing inside the editor can say what happened; the
   * tab arriving is the whole of what Sheaf hears. Long enough for the grace period
   * an editor has to resolve in.
   */
  const AFTER_THE_TAB_OPENED = 600;

  /** A Markdown file with a NUL byte in the third line, as `sample/edge/bytes` holds one. */
  const WITH_A_NUL = '# Control characters\n\nA NUL here:   and the rest of the line.\n';

  const RAW = 'Open as Raw Markdown (Text)';

  check('a file that cannot be shown: opening one with a NUL byte in it names the byte and the line', async () => {
    const { win } = start();
    win.addFileHolding('/ws/control.md', WITH_A_NUL);
    win.openTab('/ws/control.md');
    await pause(AFTER_THE_TAB_OPENED);
    // Saying nothing leaves VS Code's own "could not be opened" placeholder, which
    // names nothing and leads nowhere. This pins what is said, not that anything is.
    return same(win.warnings, [
      'Sheaf: ws/control.md cannot be shown, because it holds a NUL byte (U+0000) on line 3. A file with one in it is read as binary rather than as text.',
    ]);
  });

  check('a file that cannot be shown: taking the offer opens it in the plain text editor', async () => {
    const { win } = start();
    win.addFileHolding('/ws/control.md', WITH_A_NUL);
    win.answerWith(RAW);
    win.openTab('/ws/control.md');
    await pause(AFTER_THE_TAB_OPENED);
    // The plain text editor has VS Code's own binary guard behind it, with the Open
    // Anyway button. That is the way on, and it is why the offer points there.
    return same(win.opened(), [{ path: '/ws/control.md', viewType: 'default' }]);
  });

  check('a file that cannot be shown: turning the offer down opens nothing', async () => {
    const { win } = start();
    win.addFileHolding('/ws/control.md', WITH_A_NUL);
    win.openTab('/ws/control.md');
    await pause(AFTER_THE_TAB_OPENED);
    return win.opened().length === 0;
  });

  check('a file that cannot be shown: a document that did open is left alone', async () => {
    const ctx = start();
    ctx.win.addFileHolding('/ws/notes.md', 'Some words.\n');
    await openInSheaf('Some words.\n', '/ws/notes.md', ctx);
    ctx.win.openTab('/ws/notes.md');
    await pause(AFTER_THE_TAB_OPENED);
    return ctx.win.warnings.length === 0 && ctx.win.opened().length === 0;
  });

  check('a file that cannot be shown: a NUL byte past the bytes VS Code reads is left alone', async () => {
    const { win } = start();
    // VS Code decides a file is binary from the first 512 bytes. A NUL after those
    // opens fine, and saying it cannot be shown would be a warning about nothing.
    win.addFileHolding('/ws/late.md', `${'x'.repeat(600)}\n \n`);
    win.openTab('/ws/late.md');
    await pause(AFTER_THE_TAB_OPENED);
    return win.warnings.length === 0;
  });

  check('a file that cannot be shown: a tab opened in another editor is not Sheaf’s to explain', async () => {
    const { win } = start();
    win.addFileHolding('/ws/control.md', WITH_A_NUL);
    win.openTab('/ws/control.md', 'default');
    await pause(AFTER_THE_TAB_OPENED);
    return win.warnings.length === 0;
  });

  check('explorer menu: Open in Sheaf is offered for a Markdown extension written in any case', () => {
    const offered = whenRegex(explorerWhenClause());
    return (
      offered !== undefined &&
      ['.md', '.MD', '.Md', '.markdown', '.Markdown', '.MARKDOWN'].every((ext) => offered.test(ext))
    );
  });

  check('explorer menu: Open in Sheaf is offered for nothing but Markdown', () => {
    const offered = whenRegex(explorerWhenClause());
    return (
      offered !== undefined && ['.txt', '.cmd', '.mdx', '.md.txt', ''].every((ext) => !offered.test(ext))
    );
  });

  /*
   * The table of contents.
   *
   * What a person sees in the rail is checked in the webview's own suite; what is held
   * here is the part only the host can answer: that the panel is off until somebody asks
   * for it, that asking for it writes the setting to *user* settings rather than to this
   * one file, and that both ways of asking — the toolbar button and the Command Palette
   * — write the same thing.
   */
  const TOC = 'sheaf.tableOfContents';

  check('table of contents: an editor in a window that has never been told otherwise opens with it off', async () => {
    const { ready, init } = await openInSheaf();
    ready();
    return init().config.tableOfContents === false;
  });

  check('table of contents: with the setting on, every editor opened is told so, not just the one that turned it on', async () => {
    const ctx = sheafWindow();
    ctx.win.vscode.workspace.getConfiguration().update(TOC, true, GLOBAL);
    const first = await openInSheaf('# One\n', '/ws/one.md', ctx);
    const second = await openInSheaf('# Two\n', '/ws/two.md', ctx);
    first.ready();
    second.ready();
    return first.init().config.tableOfContents === true && second.init().config.tableOfContents === true;
  });

  check('table of contents: the toolbar button writes it on in user settings, where it holds for every file', async () => {
    const { win, webview } = await openWithWebview('# One\n\nWords.\n');
    webview.window.document.querySelector('[aria-label="Table of contents"]').click();
    await settle();
    webview.close();
    return (
      same(win.writesTo(GLOBAL), [{ key: TOC, target: GLOBAL }]) &&
      win.writesTo(WORKSPACE).length === 0 &&
      load(win).tableOfContentsOn() === true
    );
  });

  check('table of contents: the toolbar button of an editor already showing it writes it off again', async () => {
    const { win, webview } = await openWithWebview('# One\n\nWords.\n', undefined, { user: { [TOC]: true } });
    webview.window.document.querySelector('[aria-label="Table of contents"]').click();
    await settle();
    webview.close();
    return same(win.writesTo(GLOBAL), [{ key: TOC, target: GLOBAL }]) && load(win).tableOfContentsOn() === false;
  });

  check('table of contents: the command turns it on, and turns it off again', async () => {
    const { host, win } = start();
    await win.run('sheaf.toggleTableOfContents');
    const on = host.tableOfContentsOn();
    await win.run('sheaf.toggleTableOfContents');
    return on === true && host.tableOfContentsOn() === false && win.writesTo(WORKSPACE).length === 0;
  });

  check('table of contents: the command needs no editor in front of the person, since the setting is the window’s', async () => {
    const { host, win } = start();
    win.focusText('/ws/plain.md');
    await win.run('sheaf.toggleTableOfContents');
    return host.tableOfContentsOn() === true;
  });

  check('table of contents: a heading typed into the document reaches the rail', async () => {
    const { webview } = await openWithWebview('# One\n\nWords.\n', undefined, { user: { [TOC]: true } });
    const rail = webview.window.document.querySelector('.sheaf-toc');
    const listed = () => [...rail.querySelectorAll('.sheaf-toc-entry')].map((e) => e.textContent);
    const before = listed();
    webview.click(webview.doc().length);
    webview.type('\n## Two\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = listed();
    webview.close();
    return !rail.hidden && same(before, ['One']) && same(after, ['One', 'Two']);
  });

  check('table of contents: with the setting off the document has no rail in it at all', async () => {
    const { webview } = await openWithWebview('# One\n\nWords.\n');
    const rail = webview.window.document.querySelector('.sheaf-toc');
    const button = webview.window.document.querySelector('[aria-label="Table of contents"]');
    const ok = rail.hidden && rail.querySelectorAll('.sheaf-toc-entry').length === 0 && button.getAttribute('aria-pressed') === 'false';
    webview.close();
    return ok;
  });

  /**
   * A Sheaf editor in front of the person, with the real webview behind it and the
   * extension's commands registered: what a command run from the Command Palette or
   * a keystroke finds when it goes looking for where the person is.
   */
  const openForCommands = async (text) => {
    const win = makeWindow();
    const host = load(win);
    host.activate({ subscriptions: [], extensionUri: file('/extension') });
    const document = win.openDocument('/ws/notes.md', text);
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    webview = bootWebview((message) => panel.receive(message));
    await settle(); // `ready` went out as the page loaded; `init` comes back a turn later.
    return { win, document, panel, webview };
  };

  /** Long enough for the webview's debounced selection to have reached the host. */
  const reported = () => new Promise((resolve) => setTimeout(resolve, 200));

  /** A few paragraphs, so a selection has lines above and below it to get wrong. */
  const NOTES = '# Wren\n\nFirst.\n\nSecond.\n\nThird.\n\nFourth.\n';

  /** A table whose header sits on line 3 and whose last row sits on line 6. */
  const TABLE = '# Wren\n\n| Signal | Band |\n| --- | --- |\n| Alpha | 12 |\n| Beta | 14 |\n';

  check('send to terminal: the lines the person picked are typed at the prompt, and nothing is submitted', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    const doc = webview.doc();
    // `First.` through `Third.`: lines 3 to 7, blank lines and all.
    webview.select(doc.indexOf('First.'), doc.indexOf('Third.') + 'Third.'.length);
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L3-7 ', submit: false }]) && terminal.shown === 1;
  });

  check('send to terminal: a caret with nothing selected names the one line it sits on', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    webview.click(webview.doc().indexOf('Second.') + 3);
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L5 ', submit: false }]);
  });

  check('send to terminal: a line taken whole names that line, not the empty one after it', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    const at = webview.doc().indexOf('First.');
    // What a triple-click leaves behind: the line and the break that ends it.
    webview.select(at, at + 'First.\n'.length);
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L3 ', submit: false }]);
  });

  // The key arrives before the webview's own report of the selection has. Without
  // asking, the host read the selection from when the document opened, line 1, and
  // typed it at the prompt as though it were what the person had picked.
  check('send to terminal: a key pressed the moment a selection is made names that selection', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    webview.click(webview.doc().indexOf('Third.') + 2);
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L7 ', submit: false }]);
  });

  check('copy ref: a key pressed the moment a selection is made copies that selection', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const doc = webview.doc();
    webview.select(doc.indexOf('Second.'), doc.indexOf('Second.') + 'Second.'.length);
    await win.run('sheaf.copyRef');
    webview.close();
    return same(win.copied, [`ws/notes.md:5\n\n${'```'}\nSecond.\n${'```'}\n`]);
  });

  check('send to terminal: with no terminal open the person is told what to do about it', async () => {
    const { win, webview } = await openForCommands(NOTES);
    webview.click(webview.doc().indexOf('Second.'));
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    const said = win.messages.join(' ');
    return (
      win.messages.length === 1 &&
      /terminal/i.test(said) &&
      said.length > 40 &&
      // The notice says what Sheaf does, and names nobody else.
      !/notion|obsidian|typora|bear|ulysses|google docs|quip|copilot|cursor|claude|chatgpt/i.test(said)
    );
  });

  check('send to terminal: a plain text editor in front of the person is left to report its own selection', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    webview.click(webview.doc().indexOf('Second.'));
    await reported();
    win.focusText('/ws/other.md');
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return terminal.sent.length === 0 && win.messages.length === 0;
  });

  check('send to terminal: typing above the caret moves the line the reference names', async () => {
    const { win, document, webview } = await openForCommands(NOTES);
    const terminal = win.openTerminal();
    webview.click(webview.doc().indexOf('Third.') + 2);
    await reported();
    // Another editor adds a paragraph above, so everything below it is a line lower.
    win.writeFromOutside(document, `# Wren\n\nNew.\n\nFirst.\n\nSecond.\n\nThird.\n\nFourth.\n`);
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L9 ', submit: false }]);
  });

  check('send to terminal: a table names the lines a save will write its rows on', async () => {
    const { win, webview } = await openForCommands(TABLE);
    const terminal = win.openTerminal();
    // A table is one block widget, so the document position under it is the table's
    // own edge. Working in the grid has to name the rows, not the line the widget
    // starts on: standing in the grid with no cell picked names the whole of it.
    webview.document().querySelector('.sheaf-table-grid').focus();
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L3-6 ', submit: false }]);
  });

  check('send to terminal: the row the person is standing in is the row the reference names', async () => {
    const { win, webview } = await openForCommands(TABLE);
    const terminal = win.openTerminal();
    const grid = webview.document().querySelector('.sheaf-table-grid');
    grid.focus();
    // Down twice from the header: the second body row, which the file holds on line 6.
    for (let i = 0; i < 2; i++) {
      grid.dispatchEvent(
        new webview.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      );
    }
    grid.dispatchEvent(new webview.window.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    await reported();
    await win.run('sheaf.sendRefToTerminal');
    webview.close();
    return same(terminal.sent, [{ text: '@ws/notes.md#L6 ', submit: false }]);
  });

  /** A reference as Copy ref writes it: where it is, a blank line, then what is there. */
  const quoted = (location, text) => `${location}\n\n${'```'}\n${text}\n${'```'}\n`;

  /**
   * Open the right-click menu and take its Copy ref, the way a person does. The event
   * is the one the context-menu key sends: no pointer position, so the menu builds on
   * the selection that is already there instead of moving the caret to a click.
   */
  const copyRefFromMenu = (webview, target) => {
    const page = webview.document();
    const on = target ?? page.querySelector('.cm-content');
    on.dispatchEvent(
      new webview.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 })
    );
    // By its label, since the item also carries its key.
    const item = [...page.querySelectorAll('.sheaf-ctx-item')].find((b) => b.querySelector('span')?.textContent === 'Copy ref');
    if (!item) throw new Error('the menu offered no Copy ref');
    item.click();
  };

  check('copy ref: a selection of several lines is copied as its location and its text', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const doc = webview.doc();
    webview.select(doc.indexOf('First.'), doc.indexOf('Third.') + 'Third.'.length);
    await reported();
    await win.run('sheaf.copyRef');
    // The menu's own Copy ref, on the same selection, has to put the same thing there.
    copyRefFromMenu(webview);
    webview.close();
    return (
      same(win.copied, [
        quoted('ws/notes.md:3-7', 'First.\n\nSecond.\n\nThird.'),
        quoted('ws/notes.md:3-7', 'First.\n\nSecond.\n\nThird.'),
      ])
    );
  });

  check('copy ref: a caret carries the line it sits on, not its number alone', async () => {
    const { win, webview } = await openForCommands(NOTES);
    webview.click(webview.doc().indexOf('Second.') + 3);
    await reported();
    await win.run('sheaf.copyRef');
    copyRefFromMenu(webview);
    webview.close();
    return same(win.copied, [quoted('ws/notes.md:5', 'Second.'), quoted('ws/notes.md:5', 'Second.')]);
  });

  check('copy ref: an empty line has nothing to quote and is copied as its location', async () => {
    const { win, webview } = await openForCommands(NOTES);
    // Line 2, the blank one between the heading and the first paragraph.
    webview.click(webview.doc().indexOf('\n\nFirst.') + 1);
    await reported();
    await win.run('sheaf.copyRef');
    copyRefFromMenu(webview);
    webview.close();
    return same(win.copied, ['ws/notes.md:2\n', 'ws/notes.md:2\n']);
  });

  check('copy ref: a line taken whole is copied as the one line it covers', async () => {
    const { win, webview } = await openForCommands(NOTES);
    const at = webview.doc().indexOf('First.');
    webview.select(at, at + 'First.\n'.length);
    await reported();
    await win.run('sheaf.copyRef');
    copyRefFromMenu(webview);
    webview.close();
    return same(win.copied, [quoted('ws/notes.md:3', 'First.'), quoted('ws/notes.md:3', 'First.')]);
  });

  check('copy ref: the cell the person is standing in is copied by its column and row, with its text', async () => {
    const { win, webview } = await openForCommands(TABLE);
    const grid = webview.document().querySelector('.sheaf-table-grid');
    grid.focus();
    for (let i = 0; i < 2; i++) {
      grid.dispatchEvent(
        new webview.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      );
    }
    grid.dispatchEvent(new webview.window.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    await reported();
    await win.run('sheaf.copyRef');
    // The menu opened on that row, which is how a person reaches the same reference.
    copyRefFromMenu(webview, webview.document().querySelector('.sheaf-table [data-r="1"]'));
    webview.close();
    const want = quoted('ws/notes.md:6 (Signal, row 2)', 'Beta');
    return same(win.copied, [want, want]);
  });

  check('copy ref: a cell open for editing is named by its column and row', async () => {
    const { win, webview } = await openForCommands(TABLE);
    const grid = webview.document().querySelector('.sheaf-table-grid');
    grid.focus();
    const press = (key) =>
      grid.dispatchEvent(new webview.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press('ArrowDown');
    press('ArrowDown');
    // Enter opens the cell in an editor of its own, which takes focus away from the
    // grid. What is focused then is that editor's text, still inside the same row.
    press('Enter');
    await reported();
    const focused = webview.document().activeElement;
    // Focus really left the grid for the cell's own editor: what has it is inside a
    // cell, and is not the grid that owned it a moment ago.
    const inACellEditor = !!focused?.closest('[data-r]') && !focused.classList.contains('sheaf-table-grid');
    await win.run('sheaf.copyRef');
    webview.close();
    return inACellEditor && same(win.copied, [quoted('ws/notes.md:6 (Signal, row 2)', 'Beta')]);
  });

  check('copy ref: what was just typed into a cell is what the reference quotes', async () => {
    const { win, webview } = await openForCommands(TABLE);
    const grid = webview.document().querySelector('.sheaf-table-grid');
    grid.focus();
    const press = (key) =>
      grid.dispatchEvent(new webview.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    // A key pressed inside an open cell stops at the cell, so nothing this webview
    // listens for on the way up reports the selection. What typing there does do is
    // write the table back into the document, and that is heard.
    const content = webview.document().activeElement;
    const cell = content.cmTile.root.view;
    cell.dispatch(cell.state.replaceSelection('Delta'));
    await reported();
    await win.run('sheaf.copyRef');
    webview.close();
    return same(win.copied, [quoted('ws/notes.md:6 (Signal, row 2)', 'Delta')]);
  });

  check('copy ref: a plain text editor in front of the person copies nothing', async () => {
    const { win, webview } = await openForCommands(NOTES);
    webview.click(webview.doc().indexOf('Second.'));
    await reported();
    win.focusText('/ws/other.md');
    await win.run('sheaf.copyRef');
    webview.close();
    return win.copied.length === 0;
  });

  /**
   * A .csv or .tsv file open in Sheaf's grid editor, with the real webview behind it
   * and the extension's commands registered.
   */
  const openGrid = async (filePath, text, { eol = 1 } = {}) => {
    const win = makeWindow();
    const host = load(win);
    host.activate({ subscriptions: [], extensionUri: file('/extension') });
    const document = win.openDocument(filePath, text, { eol, languageId: 'plaintext' });
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }, 'grid').resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    webview = bootWebview((message) => panel.receive(message));
    await settle();
    const page = webview.document();
    const grid = () => page.querySelector('.sheaf-table-grid');
    /** Move to a cell with the arrow keys from where the grid starts, the way a person does. */
    const press = (key) =>
      grid().dispatchEvent(new webview.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    /** Open the body row `row` (from one) in the first column and replace what it holds with `text`. */
    const typeInto = async (row, text) => {
      grid().focus();
      for (let i = 0; i < row; i++) press('ArrowDown');
      press('Enter');
      // A data cell holds plain text, so it opens in a plain text field. Enter there
      // commits what was typed, the way a person finishes a cell.
      const field = page.activeElement;
      if (!field?.classList.contains('sheaf-table-input')) throw new Error('no cell opened');
      field.value = text;
      field.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
      field.dispatchEvent(new webview.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settle();
      await settle();
    };
    return { win, host, document, panel, webview, page, grid, press, typeInto };
  };

  const fenced = (lang, body) => `${'```'}${lang}\n${body}\n${'```'}`;

  const BANDS = 'name,band\n"Alpha, the first",12\nBeta,14\n';

  check('data file: a .csv file opens as a grid, with the file as the whole of the page and no formatting toolbar', async () => {
    const { webview, page, grid } = await openGrid('/ws/data.csv', BANDS);
    const held = webview.doc();
    const shown = !!grid();
    const csvPage = page.body.classList.contains('sheaf-csv-mode');
    webview.close();
    return held === fenced('csv', BANDS) && shown && csvPage;
  });

  check('data file: a .tsv file opens as a tab-separated grid', async () => {
    const { webview, grid } = await openGrid('/ws/data.tsv', 'name\tband\nAlpha\t12\n');
    const held = webview.doc();
    const shown = !!grid();
    webview.close();
    return held === fenced('tsv', 'name\tband\nAlpha\t12\n') && shown;
  });

  check('data file: a Markdown file keeps its toolbar and is not shown as a data file', async () => {
    const { webview } = await openWithWebview('# Notes\n\nWords.\n', 1);
    const csvPage = webview.document().body.classList.contains('sheaf-csv-mode');
    const held = webview.doc();
    webview.close();
    return !csvPage && held === '# Notes\n\nWords.\n';
  });

  check('data file: a cell edit writes that record and leaves every other byte, quoting included', async () => {
    const { document, webview, win, typeInto } = await openGrid('/ws/data.csv', BANDS);
    await typeInto(2, 'Delta');
    webview.close();
    const beta = BANDS.indexOf('Beta');
    return (
      document.text === 'name,band\n"Alpha, the first",12\nDelta,14\n' &&
      win.applied.length > 0 &&
      win.applied.every((a) => a.start >= beta && a.end <= beta + 'Beta'.length)
    );
  });

  check('data file: CRLF line endings and a byte-order mark survive a cell edit', async () => {
    const text = '﻿name,band\r\n"Alpha, the first",12\r\nBeta,14\r\n';
    const { document, webview, typeInto } = await openGrid('/ws/data.csv', text, { eol: CRLF_EOL });
    const held = webview.doc();
    await typeInto(2, 'Delta');
    webview.close();
    return (
      // The mark is the file's, not a character of the grid's first cell.
      held === fenced('csv', 'name,band\n"Alpha, the first",12\nBeta,14\n') &&
      document.text === '﻿name,band\r\n"Alpha, the first",12\r\nDelta,14\r\n'
    );
  });

  check('data file: a file with no final newline is written back without one', async () => {
    const { document, webview, typeInto } = await openGrid('/ws/data.csv', 'name,band\nAlpha,12\nBeta,14');
    const held = webview.doc();
    await typeInto(2, 'Delta');
    webview.close();
    return held === fenced('csv', 'name,band\nAlpha,12\nBeta,14') && document.text === 'name,band\nAlpha,12\nDelta,14';
  });

  check('data file: an empty file opens, and what is typed into it is the whole of the file', async () => {
    const { document, webview } = await openGrid('/ws/empty.csv', '');
    const held = webview.doc();
    // The one line between the fences is where the file's first row goes.
    webview.click('```csv\n'.length);
    webview.type('a,b');
    await settle();
    await settle();
    webview.close();
    return held === fenced('csv', '') && document.text === 'a,b';
  });

  check('data file: a write from outside reaches the grid', async () => {
    const { win, document, webview, page } = await openGrid('/ws/data.csv', BANDS);
    win.writeFromOutside(document, BANDS.replace('Beta', 'Gamma'));
    await settle();
    await settle();
    const held = webview.doc();
    const drawn = page.querySelector('.sheaf-table')?.textContent ?? '';
    webview.close();
    return held === fenced('csv', BANDS.replace('Beta', 'Gamma')) && drawn.includes('Gamma') && !drawn.includes('Beta');
  });

  check('data file: an edit that damages either fence line writes nothing and puts the grid back', async () => {
    const { document, webview, panel, win } = await openGrid('/ws/data.csv', BANDS);
    const damaged = [
      fenced('csv', BANDS).replace('```csv', '```csvx'),
      fenced('csv', BANDS).slice(0, -1),
      `${fenced('csv', BANDS)}\nafter`,
      BANDS,
    ];
    const answers = [];
    for (const text of damaged) {
      const before = panel.posted.length;
      panel.receive({ type: 'edit', text });
      await settle();
      answers.push(panel.posted.slice(before).find((m) => m.type === 'setContent')?.text);
    }
    webview.close();
    return (
      document.text === BANDS &&
      win.applied.length === 0 &&
      answers.every((text) => text === fenced('csv', BANDS))
    );
  });

  check('data file: typing outside the grid, before or after it, changes nothing', async () => {
    const { document, webview } = await openGrid('/ws/data.csv', BANDS);
    webview.click(0);
    webview.type('x');
    webview.click(webview.doc().length);
    webview.type('y');
    webview.press('Enter');
    await settle();
    const held = webview.doc();
    const edits = webview.edits().length;
    webview.close();
    return held === fenced('csv', BANDS) && edits === 0 && document.text === BANDS;
  });

  check('data file: Copy ref names the file and the line the record is on in it', async () => {
    const { win, webview, grid, press } = await openGrid('/ws/data.csv', BANDS);
    const terminal = win.openTerminal();
    grid().focus();
    press('ArrowDown');
    press('ArrowDown');
    grid().dispatchEvent(new webview.window.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    await reported();
    await win.run('sheaf.copyRef');
    await win.run('sheaf.sendRefToTerminal');
    copyRefFromMenu(webview, webview.document().querySelector('.sheaf-table [data-r="1"]'));
    webview.close();
    // Beta is on line 3 of the file: the header is line 1.
    const want = quoted('ws/data.csv:3 (name, row 2)', 'Beta');
    return same(win.copied, [want, want]) && same(terminal.sent, [{ text: '@ws/data.csv#L3 ', submit: false }]);
  });

  /** A file of `records` lines: a header and the rest data. */
  const rows = (records) => ['id,value', ...Array.from({ length: records - 1 }, (_, i) => `${i},v${i}`)].join('\n') + '\n';

  check('data file: a file past the row limit opens with a notice and no grid', async () => {
    const { webview, page } = await openGrid('/ws/big.csv', rows(2001));
    const said = page.body.textContent;
    const noGrid = !page.querySelector('.sheaf-table') && !page.querySelector('.cm-editor');
    webview.close();
    return (
      noGrid &&
      said.includes('This file has 2,001 rows.') &&
      said.includes('up to 2,000 rows') &&
      said.includes('Reopen Editor With')
    );
  });

  check('data file: a file at the row limit still opens as a grid', async () => {
    const { webview, page, grid } = await openGrid('/ws/big.csv', rows(2000));
    const shown = !!grid();
    const said = page.body.textContent;
    webview.close();
    return shown && !said.includes('Reopen Editor With');
  });

  check('manifest: Sheaf is offered for .csv and .tsv files without taking them over', () => {
    const { MarkdownEditorProvider } = load(makeWindow());
    const editors = manifest().contributes.customEditors ?? [];
    const grid = editors.find((editor) => editor.viewType === MarkdownEditorProvider.gridViewType);
    const patterns = sorted((grid?.selector ?? []).map((s) => s.filenamePattern));
    return (
      grid !== undefined &&
      grid.viewType !== SHEAF &&
      grid.priority === 'option' &&
      same(patterns, ['*.csv', '*.tsv']) &&
      grid.displayName === 'Sheaf (Grid)'
    );
  });

  check('manifest: activating the extension registers both of Sheaf’s editors', () => {
    const { host, win } = start();
    return same(win.editorProviders, [SHEAF, host.MarkdownEditorProvider.gridViewType]);
  });

  check('manifest: the two reference keys answer inside a Sheaf editor, a document or a data file, and nowhere else', () => {
    const onlyInSheaf = `activeCustomEditorId == '${SHEAF}' || activeCustomEditorId == 'sheaf.csv'`;
    // Chords that VS Code or a coding agent extension already answers. One of those
    // here would do one thing in Sheaf and something else a tab away.
    const spokenFor = [
      'alt+k',
      'ctrl+alt+k',
      'cmd+alt+k',
      'ctrl+alt+f',
      'ctrl+alt+t',
      'cmd+alt+c',
      'cmd+alt+f',
      'cmd+alt+l',
      'cmd+alt+r',
      'cmd+alt+s',
      'cmd+alt+w',
      'ctrl+shift+t',
      'cmd+shift+t',
      'ctrl+escape',
      'cmd+escape',
    ];
    const chords = new Set();
    for (const command of ['sheaf.copyRef', 'sheaf.sendRefToTerminal']) {
      const binding = contributedKeybinding(command);
      if (!binding || binding.when !== onlyInSheaf) return false;
      if (paletteEntry(command)?.when !== onlyInSheaf) return false;
      for (const chord of [binding.key, binding.mac]) {
        if (spokenFor.includes(chord.toLowerCase())) return false;
        chords.add(chord.toLowerCase());
      }
    }
    // Four distinct chords: two commands, two platforms, none of them each other's.
    return chords.size === 4;
  });

  check('manifest: the table of contents is a boolean setting that starts off, and names no other product', () => {
    const setting = manifest().contributes.configuration.properties[TOC];
    const copy = `${setting?.description ?? ''} ${(manifest().contributes.commands ?? []).map((c) => c.title).join(' ')}`;
    return (
      setting?.type === 'boolean' &&
      setting.default === false &&
      typeof setting.description === 'string' &&
      setting.description.length > 40 &&
      !/notion|obsidian|typora|bear|ulysses|google docs|quip/i.test(copy)
    );
  });

  check('manifest: the editor patterns, the association patterns and the command extensions are one list', () => {
    // Three places name the files Sheaf opens, and nothing but this check holds them
    // together. Left to drift, the symptom months later is Sheaf quietly not opening
    // a file it is contributed for.
    const { PATTERNS, MARKDOWN_EXTENSIONS } = load(makeWindow());
    const contributed = customEditorPatterns();
    return (
      contributed.length > 0 &&
      same(sorted(contributed), sorted(PATTERNS)) &&
      same(sorted(contributed.map(asExtension)), sorted(MARKDOWN_EXTENSIONS))
    );
  });

  check('manifest: every file the editor is contributed for is offered the Explorer menu item', () => {
    const offered = whenRegex(explorerWhenClause());
    return (
      offered !== undefined &&
      customEditorPatterns().every((pattern) => offered.test(asExtension(pattern)))
    );
  });

  check('manifest: every gate on the active editor names the view type the provider registers', () => {
    // More copies of the same value, one per menu item and keybinding. Renamed in one
    // place only, a keystroke or a menu entry stops firing inside Sheaf, and nothing
    // about a shortcut that does nothing points at a constant.
    const { MarkdownEditorProvider } = load(makeWindow());
    const viewType = MarkdownEditorProvider.viewType;
    const contributed = (manifest().contributes.customEditors ?? []).map((editor) => editor.viewType);
    const named = whenClauseViewTypes();
    const ours = [viewType, MarkdownEditorProvider.gridViewType];
    return contributed.includes(viewType) && named.length > 0 && named.every((id) => ours.includes(id));
  });

  check('manifest: Sheaf puts nothing in the editor title bar', () => {
    // That bar is VS Code's, and a command contributed without an icon renders as its
    // whole title, which is a wall of text across the widest control in the window. The
    // way out of Sheaf is the toolbar button and the Command Palette entry, both of
    // which cost no chrome at all.
    return (manifest().contributes.menus['editor/title'] ?? []).length === 0;
  });

  check('manifest: the commands the manifest contributes are the commands the extension registers', () => {
    // A command ID in the manifest with nothing registered behind it is a Command
    // Palette entry that looks right and does nothing, which reads as the extension
    // being broken rather than as a typo.
    const { win } = start();
    return same(sorted(contributedCommands()), sorted(win.registered()));
  });

  check('manifest: every menu item runs a command the manifest contributes', () => {
    const contributed = contributedCommands();
    const inMenus = menuCommands();
    return inMenus.length > 0 && inMenus.every((command) => contributed.includes(command));
  });

  check('packaging: the editor bundle is the same bytes in both hosts, so nothing host-specific can reach it', async () => {
    /*
     * Sheaf runs in a VS Code webview and in a browser tab, and the editor it
     * serves them is one bundle. That is the whole reason the browser version can
     * be trusted not to drift: there is no second copy to fall behind.
     *
     * Anything that should exist in one host and not the other belongs beside the
     * editor rather than inside it, which in practice means `src/server/`. A panel
     * under `src/webview/` that must never render in VS Code would end the
     * guarantee, and it would end it quietly, because both hosts would still work.
     *
     * Asked of the real bundle rather than of the imports, so a module reached
     * through three others is caught the same as a direct one.
     */
    const root = path.join(here, '..');
    const built = await esbuild.build({
      entryPoints: [path.join(root, 'src', 'webview', 'main.ts')],
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      logLevel: 'silent',
      absWorkingDir: root,
    });
    const inputs = Object.keys(built.metafile.inputs);
    const fromServer = inputs.filter((f) => f.startsWith('src/server/'));
    // A bundle that read nothing would pass the test above while proving nothing.
    const reallyBuilt = inputs.includes('src/webview/main.ts') && inputs.some((f) => f.startsWith('src/webview/tables'));
    return {
      ok: reallyBuilt && fromServer.length === 0,
      detail: !reallyBuilt
        ? `the bundle read ${inputs.length} files and none of them look like the editor`
        : fromServer.length
          ? `the editor bundle pulls in ${JSON.stringify(fromServer)}`
          : '',
    };
  });

  check('packaging: the maths library\'s licence notice is built and nothing keeps it out of the package', () => {
    // The typesetting library is MIT, which requires its notice to travel with the
    // copy. The build writes it beside the code it covers, and the only way it could
    // go missing from a release is a packaging rule excluding it, which is silent.
    const build = readFileSync(path.join(here, '..', 'esbuild.mjs'), 'utf8');
    const copied = /katex-LICENSE\.txt/.test(build);
    const ignore = readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const excluded = ignore.some((rule) => /katex/i.test(rule) && !rule.startsWith('!'));
    return copied && !excluded;
  });

  // ---- View blocks: the data files they read, through the host ----

  /** What the host sent the webview about data files, oldest first. */
  const dataFilesSent = (panel) => panel.posted.filter((m) => m.type === 'dataFile');

  /** Ask for a data file the way a view block does, and let the answer arrive. */
  const askForDataFile = async (panel, path, id = 'data-1') => {
    panel.receive({ type: 'dataFileRead', id, path });
    await settle();
    await settle();
  };

  check('view blocks: a data file a view names is read relative to the document and sent with the id it was asked with', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    win.addFileHolding('/ws/docs/data/tasks.csv', 'feature,status\nSearch,Open\n');
    await askForDataFile(panel, 'data/tasks.csv', 'data-7');
    return same(dataFilesSent(panel), [
      { type: 'dataFile', id: 'data-7', path: 'data/tasks.csv', text: 'feature,status\nSearch,Open\n' },
    ]);
  });

  check('view blocks: a missing data file comes back as an error naming the path, not as an empty file', async () => {
    const { panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    await askForDataFile(panel, 'data/gone.csv');
    const [sent] = dataFilesSent(panel);
    return sent.text === undefined && /data\/gone\.csv was not found/.test(sent.error);
  });

  check('view blocks: a path out of the document’s folder, an absolute path and a file that is not csv or tsv are refused without being read', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    win.addFileHolding('/ws/secret.csv', 'a\n1\n');
    win.addFileHolding('/etc/passwd.csv', 'a\n1\n');
    win.addFileHolding('/ws/docs/notes.md', '# notes\n');
    await askForDataFile(panel, '../secret.csv', 'a');
    await askForDataFile(panel, '/etc/passwd.csv', 'b');
    await askForDataFile(panel, 'notes.md', 'c');
    await askForDataFile(panel, 'data/../../secret.csv', 'd');
    const sent = dataFilesSent(panel);
    return (
      win.reads.length === 0 &&
      win.openWatchers() === 0 &&
      sent.length === 4 &&
      sent.every((m) => m.text === undefined && typeof m.error === 'string') &&
      /outside this document's folder/.test(sent[0].error) &&
      /absolute path/.test(sent[1].error) &&
      /\.csv or \.tsv file, and "notes\.md" is neither/.test(sent[2].error) &&
      /outside/.test(sent[3].error)
    );
  });

  check('view blocks: a data file that changes on disk is sent again, and closing the editor stops the watching', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    win.addFileHolding('/ws/tasks.csv', 'a\n1\n');
    await askForDataFile(panel, 'tasks.csv');
    // Asked twice, as two views of one file would, it is still watched once.
    await askForDataFile(panel, 'tasks.csv', 'data-2');
    const watching = win.openWatchers();
    win.changeOnDisk('/ws/tasks.csv', 'a\n2\n');
    await settle();
    await settle();
    const pushed = dataFilesSent(panel).at(-1);
    panel.close();
    const afterClose = win.openWatchers();
    win.changeOnDisk('/ws/tasks.csv', 'a\n3\n');
    await settle();
    await settle();
    return (
      watching === 1 &&
      same(pushed, { type: 'dataFile', path: 'tasks.csv', text: 'a\n2\n' }) &&
      afterClose === 0 &&
      dataFilesSent(panel).length === 3
    );
  });

  check('view blocks: a data file created after the view asked for it is sent once it exists', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    await askForDataFile(panel, 'later.csv');
    win.changeOnDisk('/ws/later.csv', 'x\n1\n');
    await settle();
    await settle();
    const sent = dataFilesSent(panel);
    return sent.length === 2 && sent[0].error && sent[1].text === 'x\n1\n';
  });

  check('view blocks: the real webview asks for the file a view names and draws its rows, and the document is not written', async () => {
    const win = makeWindow();
    const host = load(win);
    const text = 'Plan.\n\n```view\nfrom: data/tasks.csv\nwhere: status = Open\n```\n';
    const document = win.openDocument('/ws/plan.md', text);
    win.addFileHolding('/ws/data/tasks.csv', 'feature,status\nSearch,Open\nExport,Done\nImport,Open\n');
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    webview = bootWebview((message) => panel.receive(message));
    for (let i = 0; i < 6; i++) await settle();
    const rows = Array.from(webview.document().querySelectorAll('.sheaf-view tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td:not(.sheaf-view-mark)')).map((td) => td.textContent).join(',')
    );
    win.changeOnDisk('/ws/data/tasks.csv', 'feature,status\nSearch,Done\nExport,Done\nImport,Open\n');
    for (let i = 0; i < 4; i++) await settle();
    const after = Array.from(webview.document().querySelectorAll('.sheaf-view tbody tr')).length;
    webview.close();
    return (
      same(rows, ['Search,Open', 'Import,Open']) &&
      after === 1 &&
      document.text === text &&
      win.applied.length === 0 &&
      webview.edits().length === 0
    );
  });

  check('view blocks: an edit through a view of a file replaces only the changed field, keeps the file’s CRLF and byte-order mark, and saves it', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    const onDisk = '﻿feature,status\r\nSearch,Open\r\nExport,Done\r\n';
    const csv = win.openDocument('/ws/tasks.csv', onDisk, { eol: 2, languageId: 'plaintext' });
    await askForDataFile(panel, 'tasks.csv');
    panel.receive({
      type: 'dataFileEdit',
      path: 'tasks.csv',
      base: 'feature,status\nSearch,Open\nExport,Done\n',
      text: 'feature,status\nSearch,Open\nExport,Open\n',
    });
    for (let i = 0; i < 4; i++) await settle();
    const at = onDisk.indexOf('Done');
    return (
      same(win.applied, [{ path: '/ws/tasks.csv', start: at, end: at + 4, text: 'Open' }]) &&
      csv.text === '﻿feature,status\r\nSearch,Open\r\nExport,Open\r\n' &&
      csv.saves === 1 &&
      // The view hears the file back as it now reads.
      dataFilesSent(panel).at(-1)?.text === csv.text
    );
  });

  check('view blocks: an edit made against an older copy of the file writes nothing and sends the file back with a note', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    const csv = win.openDocument('/ws/tasks.csv', 'a,b\n1,2\n', { languageId: 'plaintext' });
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: 'a,b\n1,1\n', text: 'a,b\n1,9\n' });
    for (let i = 0; i < 4; i++) await settle();
    const [sent] = dataFilesSent(panel);
    return (
      win.applied.length === 0 &&
      csv.text === 'a,b\n1,2\n' &&
      sent?.text === 'a,b\n1,2\n' &&
      /Your edit was not written, because tasks\.csv changed/.test(sent?.notice ?? '')
    );
  });

  check('view blocks: an undo of an edit to a file is one range holding only the bytes the edit changed, and the file is back byte for byte', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    const onDisk = '﻿feature,status\r\nSearch,Open\r\nExport,Done\r\n';
    const csv = win.openDocument('/ws/tasks.csv', onDisk, { eol: 2, languageId: 'plaintext' });
    await askForDataFile(panel, 'tasks.csv');
    const before = 'feature,status\nSearch,Open\nExport,Done\n';
    const after = 'feature,status\nSearch,Open\nExport,Open\n';
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: before, text: after });
    for (let i = 0; i < 4; i++) await settle();
    // The inverse, as the webview sends it on Cmd+Z: the text before as the text, the text after as the base.
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: after, text: before, step: 'undo' });
    for (let i = 0; i < 4; i++) await settle();
    const at = onDisk.indexOf('Done');
    return (
      same(win.applied, [
        { path: '/ws/tasks.csv', start: at, end: at + 4, text: 'Open' },
        { path: '/ws/tasks.csv', start: at, end: at + 4, text: 'Done' },
      ]) &&
      csv.text === onDisk &&
      !dataFilesSent(panel).some((m) => m.notice)
    );
  });

  check('view blocks: an undo of an edit to a file that changed since is refused, writes nothing, and says Undo did not change it', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    const csv = win.openDocument('/ws/tasks.csv', 'a,b\n1,2\n', { languageId: 'plaintext' });
    await askForDataFile(panel, 'tasks.csv');
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: 'a,b\n1,2\n', text: 'a,b\n1,3\n' });
    for (let i = 0; i < 4; i++) await settle();
    // Someone else writes the file after the edit.
    csv.text = 'a,b\n1,3\n2,4\n';
    const written = win.applied.length;
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: 'a,b\n1,3\n', text: 'a,b\n1,2\n', step: 'undo' });
    for (let i = 0; i < 4; i++) await settle();
    const sent = dataFilesSent(panel).at(-1);
    return (
      win.applied.length === written &&
      csv.text === 'a,b\n1,3\n2,4\n' &&
      sent?.text === 'a,b\n1,3\n2,4\n' &&
      /^Undo did not change tasks\.csv, because it changed after your edit/.test(sent?.notice ?? '')
    );
  });

  check('view blocks: Cmd+Z in the real webview’s view of a file takes the edit back out of the file, and Cmd+Shift+Z puts it in again', async () => {
    const win = makeWindow();
    const host = load(win);
    const text = 'Plan.\n\n```view\nfrom: tasks.csv\n```\n';
    const document = win.openDocument('/ws/plan.md', text);
    const original = 'feature,status\r\nSearch,Open\r\nExport,Done\r\n';
    const csv = win.openDocument('/ws/tasks.csv', original, { eol: 2, languageId: 'plaintext' });
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    webview = bootWebview((message) => panel.receive(message));
    for (let i = 0; i < 6; i++) await settle();
    const page = webview.document();
    const W = webview.window;
    const cell = page.querySelector('.sheaf-view tr[data-row="1"] td[data-c="1"]');
    cell.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const input = page.querySelector('.sheaf-view-input');
    input.value = 'Open';
    input.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await settle();
    const edited = csv.text;
    const table = page.querySelector('.sheaf-view table');
    table.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await settle();
    const undone = csv.text;
    page.querySelector('.sheaf-view table').dispatchEvent(
      new W.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    );
    for (let i = 0; i < 6; i++) await settle();
    const redone = csv.text;
    webview.close();
    return (
      edited === original.replace('Done', 'Open') &&
      undone === original &&
      redone === edited &&
      document.text === text
    );
  });

  check('view blocks: an edit to a file someone has unsaved changes in is left unsaved with theirs', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    const csv = win.openDocument('/ws/tasks.csv', 'a,b\n1,2\n', { languageId: 'plaintext' });
    csv.isDirty = true;
    panel.receive({ type: 'dataFileEdit', path: 'tasks.csv', base: 'a,b\n1,2\n', text: 'a,b\n1,3\n' });
    for (let i = 0; i < 4; i++) await settle();
    return csv.text === 'a,b\n1,3\n' && csv.saves === 0;
  });

  check('view blocks: an edit naming a path outside the document’s folder is refused and writes nothing', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    const csv = win.openDocument('/ws/secret.csv', 'a\n1\n', { languageId: 'plaintext' });
    panel.receive({ type: 'dataFileEdit', path: '../secret.csv', base: 'a\n1\n', text: 'a\n2\n' });
    for (let i = 0; i < 4; i++) await settle();
    return win.applied.length === 0 && csv.text === 'a\n1\n' && /outside/.test(dataFilesSent(panel)[0]?.error ?? '');
  });

  check('view blocks: a cell edited in the real webview’s view of a file reaches the file as the one changed field', async () => {
    const win = makeWindow();
    const host = load(win);
    const text = 'Plan.\n\n```view\nfrom: tasks.csv\nsort: status desc\n```\n';
    const document = win.openDocument('/ws/plan.md', text);
    const csv = win.openDocument('/ws/tasks.csv', 'feature,status\nSearch,Open\nExport,Done\n', { languageId: 'plaintext' });
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    webview = bootWebview((message) => panel.receive(message));
    for (let i = 0; i < 6; i++) await settle();
    const page = webview.document();
    const W = webview.window;
    // Sorted by status descending, Search (Open) shows first: its status cell is row 0, column 1.
    const cell = page.querySelector('.sheaf-view tr[data-row="0"] td[data-c="1"]');
    cell.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const input = page.querySelector('.sheaf-view-input');
    input.value = 'Blocked';
    input.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await settle();
    webview.close();
    const at = 'feature,status\nSearch,'.length;
    return (
      csv.text === 'feature,status\nSearch,Blocked\nExport,Done\n' &&
      same(win.applied, [{ path: '/ws/tasks.csv', start: at, end: at + 4, text: 'Blocked' }]) &&
      document.text === text
    );
  });

  // ---- Data files written at the person's request: Move to file, and a view's missing file ----

  /** What the host answered about files it was asked to write, oldest first. */
  const createdSent = (panel) => panel.posted.filter((m) => m.type === 'dataFileCreated');
  /** Every file written to disk, as `{ path, text }`. */
  const savedText = (win) => win.saved.map(({ path, bytes }) => ({ path, text: Buffer.from(bytes).toString('utf8') }));

  /** Ask the host to write a data file, the way Move to file does, and let it answer. */
  const askToCreate = async (panel, path, text, nextFree = true, id = 'create-1') => {
    panel.receive({ type: 'dataFileCreate', id, path, text, ...(nextFree ? { nextFree: true } : {}) });
    for (let i = 0; i < 4; i++) await settle();
  };

  check('data files: a file asked for is written beside the document, byte for byte, and the answer names it', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    const body = 'feature,status\n"Search, fast",Open\nExport,  Done\n';
    await askToCreate(panel, 'tasks.csv', body, true, 'create-4');
    return (
      same(savedText(win), [{ path: '/ws/docs/tasks.csv', text: body }]) &&
      same(createdSent(panel), [{ type: 'dataFileCreated', id: 'create-4', path: 'tasks.csv' }])
    );
  });

  check('data files: a file written from a CRLF document has CRLF line endings, as the block had', async () => {
    const { win, host } = sheafWindow();
    const document = win.openDocument('/ws/plan.md', 'Words.\r\n', { eol: 2 });
    const panel = makePanel();
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    await askToCreate(panel, 'tasks.csv', 'a,b\n1,2\n');
    return same(savedText(win), [{ path: '/ws/tasks.csv', text: 'a,b\r\n1,2\r\n' }]);
  });

  check('data files: a name already taken, on disk or in an open editor, is never written over; the next free name is', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    win.addFileHolding('/ws/tasks.csv', 'keep,me\n');
    win.openDocument('/ws/tasks-2.csv', 'unsaved,too\n', { languageId: 'plaintext' });
    await askToCreate(panel, 'tasks.csv', 'a\n1\n');
    return (
      same(savedText(win), [{ path: '/ws/tasks-3.csv', text: 'a\n1\n' }]) &&
      createdSent(panel)[0]?.path === 'tasks-3.csv'
    );
  });

  check('data files: without asking for the next free name, a file that exists is refused, naming it', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/plan.md');
    win.addFileHolding('/ws/data/tasks.csv', 'keep,me\n');
    await askToCreate(panel, 'data/tasks.csv', 'a\n1\n', false);
    const [answer] = createdSent(panel);
    return win.saved.length === 0 && answer.path === undefined && /data\/tasks\.csv already exists/.test(answer.error);
  });

  check('data files: a path outside the workspace, an absolute one, or one that is not csv or tsv is refused and nothing is written', async () => {
    const { win, panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    await askToCreate(panel, '../out.csv', 'a\n', true, 'a');
    await askToCreate(panel, '/tmp/out.csv', 'a\n', true, 'b');
    await askToCreate(panel, 'out.md', 'a\n', true, 'c');
    const sent = createdSent(panel);
    return (
      win.saved.length === 0 &&
      sent.length === 3 &&
      sent.every((m) => m.path === undefined && typeof m.error === 'string') &&
      /outside/.test(sent[0].error) &&
      /absolute path/.test(sent[1].error) &&
      /is neither/.test(sent[2].error)
    );
  });

  check('data files: Move to file in the real webview writes the file, then replaces the block with a view as one range of the document', async () => {
    const win = makeWindow();
    const host = load(win);
    const text = 'Plan.\n\n```csv id=tasks\nfeature,status\nSearch,Open\nExport,Done\n```\n\nAfter.\n';
    const document = win.openDocument('/ws/plan.md', text);
    let webview;
    const panel = makePanel((message) => webview.receive(message));
    await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
    webview = bootWebview((message) => panel.receive(message));
    for (let i = 0; i < 6; i++) await settle();
    const page = webview.document();
    page.querySelector('.sheaf-table-ctrl[data-cmd="overflow"]').click();
    page.querySelector('.sheaf-table-menu-item[data-cmd="table.moveToFile"]').click();
    for (let i = 0; i < 12; i++) await settle();
    const rows = Array.from(page.querySelectorAll('.sheaf-view tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent).join(',')
    );
    webview.close();
    const at = 'Plan.\n\n'.length;
    const block = '```csv id=tasks\nfeature,status\nSearch,Open\nExport,Done\n```';
    const onDocument = win.applied.filter((a) => a.path === '/ws/plan.md');
    const replaced = text.slice(0, onDocument[0]?.start) + (onDocument[0]?.text ?? '') + text.slice(onDocument[0]?.end);
    return (
      same(savedText(win), [{ path: '/ws/tasks.csv', text: 'feature,status\nSearch,Open\nExport,Done\n' }]) &&
      document.text === text.replace(block, '```view\nfrom: tasks.csv\n```') &&
      onDocument.length === 1 &&
      onDocument[0].start >= at &&
      replaced === document.text &&
      same(rows, ['Search,Open', 'Export,Done'])
    );
  });

  check('data files: Bring inline in the real webview puts the file’s rows into a CRLF document with CRLF line endings, and leaves the file as it was', async () => {
    const text = 'Plan.\r\n\r\n```view\r\nfrom: tasks.csv\r\n```\r\n';
    const { win, document, webview } = await openWithWebview(text, CRLF_EOL);
    // The file arrives on disk after the view first asked, as it would from a checkout.
    win.changeOnDisk('/ws/tasks.csv', '﻿feature,status\nSearch,Open\n');
    for (let i = 0; i < 6; i++) await settle();
    webview.document().querySelector('.sheaf-view-inline').click();
    for (let i = 0; i < 12; i++) await settle();
    webview.close();
    return (
      document.text === 'Plan.\r\n\r\n```csv id=tasks\r\nfeature,status\r\nSearch,Open\r\n```\r\n' &&
      win.saved.length === 0 &&
      win.applied.filter((a) => a.path === '/ws/notes.md').length === 1
    );
  });

  check('data files: a file that is not there is said to be missing, which a path Sheaf refuses to read is not', async () => {
    const { panel } = await openInSheaf('Words.\n', '/ws/docs/plan.md');
    await askForDataFile(panel, 'data/gone.csv', 'a');
    await askForDataFile(panel, '../out.csv', 'b');
    const [gone, out] = dataFilesSent(panel);
    return gone.missing === true && out.missing === undefined && typeof out.error === 'string';
  });

  check('data files: Create in the real webview writes the missing file with the view’s columns, draws it, and leaves the document alone', async () => {
    const text = 'Plan.\n\n```view\nfrom: data/new.csv\nshow: feature, status\n```\n';
    const { win, document, webview } = await openWithWebview(text, 1);
    for (let i = 0; i < 6; i++) await settle();
    const page = webview.document();
    const button = page.querySelector('.sheaf-view-create');
    const label = button?.textContent;
    button?.click();
    for (let i = 0; i < 12; i++) await settle();
    const head = Array.from(page.querySelectorAll('.sheaf-view thead th')).map((th) => th.querySelector('.sheaf-view-head-name')?.textContent);
    const errors = page.querySelectorAll('.sheaf-view-error').length;
    webview.close();
    return (
      label === 'Create data/new.csv' &&
      same(savedText(win), [{ path: '/ws/data/new.csv', text: 'feature,status\n' }]) &&
      same(head, ['feature', 'status']) &&
      errors === 0 &&
      document.text === text &&
      win.applied.length === 0
    );
  });

  check('view blocks: a view in a quote is drawn in the real webview, and a header sort reaches the document inside the quote', async () => {
    const text = 'Plan.\n\n> ```csv id=q\n> name,n\n> b,2\n> a,1\n> ```\n>\n> ```view\n> from: #q\n> ```\n';
    const { document, webview } = await openWithWebview(text, 1);
    for (let i = 0; i < 4; i++) await settle();
    const page = webview.document();
    const W = webview.window;
    const drawn = page.querySelectorAll('.sheaf-view.is-quoted tbody tr').length;
    page.querySelector('.sheaf-view th[data-c="0"] .sheaf-view-sort').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 12; i++) await settle();
    webview.close();
    return drawn === 2 && document.text === text.replace('> from: #q\n', '> from: #q\n> sort: name\n');
  });

  check('data blocks: renaming a block in the real webview reaches the document as its new name and the views that read it, and nothing else', async () => {
    const text = 'Plan.\n\n```csv id=tasks\na,b\n1,2\n```\n\n```view\nfrom: #tasks\n```\n';
    const { document, webview } = await openWithWebview(text, 1);
    for (let i = 0; i < 4; i++) await settle();
    const page = webview.document();
    const W = webview.window;
    page.querySelector('.sheaf-table-id').click();
    const field = page.querySelector('.sheaf-table-rename');
    field.value = 'work';
    field.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 12; i++) await settle();
    webview.close();
    return document.text === text.replace('id=tasks', 'id=work').replace('#tasks', '#work');
  });

  /*
   * Comments: a `<!-- … -->` on its own lines is drawn as a callout box, and
   * whether it is collapsed is kept where the column widths and the boards are
   * kept — the workspace's own storage, which belongs to this workspace on this
   * machine and never travels with the file.
   */

  const NOTED = 'Plan.\n\n<!-- A note to the writer. -->\n';
  const COMMENT_KEY = 'sheaf.commentFolds:file:///ws/notes.md';
  const foldsReply = (panel) => panel.posted.filter((message) => message.type === 'commentFolds');

  check('comments: a collapse one editor keeps is handed to the next editor on that document, and to no other', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const first = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    first.panel.receive({ type: 'commentFoldsWrite', folds: { 'q3x.1f': true } });
    await settle();
    first.panel.close();
    // A second editor over the same file, as after a reload: it asks, and is told.
    const again = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    again.panel.receive({ type: 'commentFoldsRead', id: 'comments-1' });
    const other = await openWithStorage(ctx, state, '/ws/other.md', NOTED);
    other.panel.receive({ type: 'commentFoldsRead', id: 'comments-1' });
    await settle();
    return (
      same(foldsReply(again.panel), [{ type: 'commentFolds', id: 'comments-1', folds: { 'q3x.1f': true } }]) &&
      same(foldsReply(other.panel), [{ type: 'commentFolds', id: 'comments-1', folds: {} }])
    );
  });

  check('comments: keeping a collapse writes nothing into the document or beside it', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const { document, panel } = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    panel.receive({ type: 'commentFoldsWrite', folds: { 'q3x.1f': true } });
    await settle();
    return (
      document.text === NOTED &&
      !document.isDirty &&
      ctx.win.applied.length === 0 &&
      ctx.win.saved.length === 0 &&
      state.store.size === 1 &&
      [...state.store.keys()][0] === COMMENT_KEY
    );
  });

  check('comments: opening every comment again clears what was kept, and what was kept is read with suspicion', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const { panel } = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    panel.receive({ type: 'commentFoldsWrite', folds: { 'q3x.1f': true } });
    await settle();
    panel.receive({ type: 'commentFoldsWrite', folds: {} });
    await settle();
    const cleared = state.store.size === 0;
    // Nothing that is not a key marked collapsed survives being read back.
    for (const damaged of ['a string', 42, null, ['q3x.1f'], { 'q3x.1f': 'yes' }, { 'q3x.1f': 1 }, { '': true }, { ['k'.repeat(200)]: true }]) {
      state.store.set(COMMENT_KEY, damaged);
      panel.posted.length = 0;
      panel.receive({ type: 'commentFoldsRead', id: 'comments-2' });
      await settle();
      if (!same(foldsReply(panel), [{ type: 'commentFolds', id: 'comments-2', folds: {} }])) return false;
    }
    // One usable key among the rubbish is the one key that comes back.
    state.store.set(COMMENT_KEY, { 'q3x.1f': true, bad: 'yes', worse: 0 });
    panel.posted.length = 0;
    panel.receive({ type: 'commentFoldsRead', id: 'comments-3' });
    await settle();
    return cleared && same(foldsReply(panel), [{ type: 'commentFolds', id: 'comments-3', folds: { 'q3x.1f': true } }]);
  });

  check('comments: an editor with no workspace storage still answers, with nothing collapsed', async () => {
    const ctx = sheafWindow();
    const { panel } = await openWithStorage(ctx, null, '/ws/notes.md', NOTED);
    panel.receive({ type: 'commentFoldsWrite', folds: { 'q3x.1f': true } });
    panel.receive({ type: 'commentFoldsRead', id: 'comments-4' });
    await settle();
    return same(foldsReply(panel), [{ type: 'commentFolds', id: 'comments-4', folds: {} }]);
  });

  check('comments: the setting is offered and scoped exactly as the rest of Sheaf’s view settings are', () => {
    const properties = manifest().contributes.configuration.properties;
    const comments = properties['sheaf.comments'];
    const like = properties['sheaf.tableOfContents'];
    return (
      !!comments &&
      comments.type === 'string' &&
      same(comments.enum, ['show', 'hidden']) &&
      comments.default === 'show' &&
      typeof comments.description === 'string' &&
      comments.description.length > 0 &&
      // The same scope as the settings it sits beside, so a person turning
      // comments off gets the same reach they get from the panel toggle.
      comments.scope === like.scope
    );
  });

  check('comments: Toggle Comments is contributed and flips the setting between showing and hiding, in user settings', async () => {
    const contributed = manifest().contributes.commands.find((command) => command.command === 'sheaf.toggleComments');
    const { win } = start();
    await win.run('sheaf.toggleComments');
    const hidden = win.vscode.workspace.getConfiguration('sheaf').get('comments', 'show');
    const target = win.writes.filter((write) => write.key === 'sheaf.comments').pop()?.target;
    await win.run('sheaf.toggleComments');
    const shown = win.vscode.workspace.getConfiguration('sheaf').get('comments', 'show');
    return (
      !!contributed &&
      contributed.title === 'Toggle Comments' &&
      contributed.category === 'Sheaf' &&
      hidden === 'hidden' &&
      shown === 'show' &&
      target === GLOBAL
    );
  });

  check('comments: the setting reaches the page with the document, and an unreadable value leaves comments showing', async () => {
    const opened = async (setting) => {
      const { win, host } = sheafWindow();
      if (setting !== undefined) win.vscode.workspace.getConfiguration().update('sheaf.comments', setting, GLOBAL);
      const document = win.openDocument('/ws/notes.md', 'Plan.\n\n<!-- A note. -->\n');
      const panel = makePanel();
      await new host.MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(document, panel, {});
      panel.receive({ type: 'ready' });
      return panel.posted.find((message) => message.type === 'init')?.config.comments;
    };
    return (
      (await opened('hidden')) === 'hidden' &&
      (await opened('show')) === 'show' &&
      (await opened(undefined)) === 'show' &&
      // Anything else is not a setting Sheaf wrote, and comments stay visible:
      // never drawing a comment at all is the one thing this must not do.
      (await opened('off')) === 'show' &&
      (await opened(true)) === 'show'
    );
  });

  return cases;
}

const cases = await hostCases();
let passed = 0;
for (const { name, run } of cases) {
  let ok = false;
  let detail = '';
  try {
    ok = await run();
  } catch (err) {
    detail = ` threw: ${err.message}`;
  }
  if (ok) passed++;
  else console.log(`❌ ${name}${detail}`);
}
console.log(`${passed}/${cases.length} host checks passed`);
process.exit(passed === cases.length ? 0 : 1);
