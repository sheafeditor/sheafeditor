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
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootWebview } from './webview.mjs';
import { eagerOutputs } from '../scripts/eager-closure.mjs';

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
  /**
   * The extension id the registry knows, and the version it reports for it.
   *
   * Not a constant, because a build does not always carry the published name: a development
   * build is installed under its own id so it and the published one are two rows in the
   * Extensions pane instead of a version race. Everything Sheaf does with its own id has to
   * follow the host's answer rather than a string in the source, and the only way to show
   * that is a window where the two differ.
   */
  let extensionId = 'sheafeditor.sheafeditor';
  let installedVersion = '0.2.0';
  /** Who is told when the extension registry moves, which an install does. */
  const registryListeners = new Set();
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
  /** The folders open in the window, which is where the workspace ends. */
  const workspaceRoots = [];
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
    Uri: {
      joinPath: (uri, ...parts) => file(resolvePath(uri.path, parts)),
      /** A path on disk. Windows separators become the one a URI's path uses. */
      file: (p) => file(String(p).replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')),
      /** A `file:` URL, which is what a file manager puts on the clipboard. */
      parse: (s) => {
        const url = new URL(String(s));
        if (url.protocol !== 'file:') throw new Error(`not a file URL: ${s}`);
        return file(decodeURIComponent(url.pathname));
      },
    },
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
      /**
       * The folder a file belongs to, or undefined for one outside every folder.
       *
       * It answered undefined for everything until a check needed it, which was fine while
       * nothing read it and is not fine now: a host that resolves a pasted path has to know
       * where the workspace ends, and a stand-in that says "nowhere" for every path would let
       * a check pass over the boundary it exists to enforce. `workspaceRoots` is what the
       * checks set; empty means no folder is open, which is a real state too.
       */
      getWorkspaceFolder: (uri) => {
        const root = workspaceRoots.find((r) => uri.path === r || uri.path.startsWith(`${r.replace(/\/$/, '')}/`));
        return root === undefined ? undefined : { uri: file(root), name: root.split('/').filter(Boolean).pop() ?? root, index: 0 };
      },
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
      // Returns the taken offer, as the warning above does, because About and the
      // newer-build notice both put buttons on an information message and what
      // happens next is the behaviour under test.
      showInformationMessage: async (message, ...rest) => {
        messages.push(message);
        // A modal flag may sit between the message and the buttons.
        const items = rest.filter((r) => typeof r === 'string');
        return items.find((item) => item === answer);
      },
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
      appName: 'Visual Studio Code',
      // Set by a check that wants the About line to name a remote, which is how
      // Sheaf is usually run here: the extension lives on the far side of the link.
      remoteName: undefined,
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
        readText: async () => copied[copied.length - 1] ?? '',
      },
    },
    version: '1.90.0',
    /*
     * The extension registry, which is how a window learns a newer build is on disk.
     * VS Code refreshes it on install and leaves the loaded code running, so the
     * version here and the one compiled into the bundle disagree exactly then.
     */
    extensions: {
      getExtension: (id) => (id === extensionId ? { packageJSON: { version: installedVersion } } : undefined),
      onDidChange: (fn) => {
        registryListeners.add(fn);
        return { dispose: () => registryListeners.delete(fn) };
      },
    },
    commands: {
      registerCommand: (id, run) => {
        handlers.set(id, run);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
        // Revert reads the file again, which is the only thing that brings what VS
        // Code noted about it up to date. It works on whatever editor is in front of
        // the person, and there is one document here.
        if (id === 'workbench.action.files.revert') {
          const doc = documents.find((d) => !d.isClosed && contents.has(d.uri.path));
          if (doc) {
            doc.text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(contents.get(doc.uri.path));
            doc.fileWas = doc.text;
            doc.isDirty = false;
            changed(doc);
          }
          return undefined;
        }
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
    /** Every command Sheaf ran, in order: `[id, ...args]` each. */
    executed,
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
    /** Folders open in the window, so a path can be inside the workspace or outside it. */
    addWorkspaceRoots: (...roots) => workspaceRoots.push(...roots),
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
    /** The id this build was installed under, which a development build changes. */
    installedAs: (id) => {
      extensionId = id;
    },
    /** The same, read back, because activation has to be told what the registry knows. */
    get extensionId() {
      return extensionId;
    },
    /** A build installed while this window was open, as `--install-extension` does. */
    installBuild: async (version) => {
      installedVersion = version;
      for (const fn of registryListeners) await fn();
    },
    /** Sheaf running over a remote link, which is the usual shape here. */
    overRemote: (name) => {
      vscode.env.remoteName = name;
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
      // The file moved and VS Code brought the document into line with it, which it
      // does while the document is clean. Both hold the write afterwards, and reading
      // it is what brought what VS Code noted about the file up to date.
      files.add(doc.uri.path);
      contents.set(doc.uri.path, new TextEncoder().encode(text));
      doc.text = text;
      doc.fileWas = text;
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
    /**
     * The file behind a document changed, and the document did not.
     *
     * This is the case VS Code leaves alone: it reloads a document that changed on
     * disk only while that document is clean, so a file written while somebody is
     * typing in it leaves the document holding text from before the write, with
     * nothing in the editor saying so. Reading the file is the only way to find out.
     */
    writeFileFromOutside: (doc, text) => {
      files.add(doc.uri.path);
      contents.set(doc.uri.path, new TextEncoder().encode(text));
    },
    /** What the file behind a document holds, as bytes on disk rather than as a document. */
    fileBehind: (doc) => {
      const bytes = contents.get(doc.uri.path);
      return bytes === undefined ? undefined : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    },
    /** A Markdown file open in the window, which Sheaf can be resolved against. */
    openDocument: (path, text, { eol = 1, languageId = 'markdown', bom = false } = {}) => {
      // A document is a file the window opened, so the file is there too, holding what
      // the document does. Without that, code that reads the file rather than the
      // document finds nothing where every real document has something.
      //
      // `bom` is the one place the two differ. A byte-order mark belongs to the file
      // rather than to a document's text: VS Code leaves it out of `getText` and puts
      // it back on every save, so anything writing the file itself has to do the same.
      const onDisk = bom ? `﻿${text}` : text;
      files.add(path);
      contents.set(path, new TextEncoder().encode(onDisk));
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
        /**
         * What the file held when this document last read or wrote it, which is what
         * VS Code notes in order to refuse a write to a file that has moved since.
         */
        fileWas: onDisk,
        /** True when the file carries a byte-order mark the document's text does not. */
        bom,
        /** Runs at the top of every save, for a file that moves at that moment. */
        beforeSave: null,
        /**
         * Runs at the end of a successful save, for a file that moves in the window
         * between the write landing and Sheaf hearing that its own save is done.
         *
         * That window is real and it is not small. A watcher event and a save's promise
         * resolving are separate turns of the event loop, so a write that arrives a
         * moment after Sheaf's own is reported while Sheaf still believes every change
         * it hears about is the echo of what it just wrote.
         */
        afterSave: null,
        getText: () => doc.text,
        positionAt: (offset) => ({ offset }),
        async save() {
          // A file can move at any moment, this one included: between Sheaf reading it
          // and handing the document over to be written. That ordering is the one that
          // refuses a save over a write nothing has read yet.
          doc.beforeSave?.();
          /*
           * "The content of the file is newer." VS Code compares the file against what
           * it noted when it last read or wrote it, and refuses rather than write over
           * a change it has not seen. It brings that note up to date only by reading
           * the file, and it will not read into a document with unsaved changes, so
           * once this refuses it refuses every time.
           */
          const onDisk = contents.has(path)
            ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(contents.get(path))
            : undefined;
          if (onDisk !== undefined && onDisk !== doc.fileWas) {
            return false;
          }
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
          /*
           * VS Code's other save participant, and the one that matters to the rule about
           * what counts as the echo of a save: it changes something other than trailing
           * whitespace. `files.insertFinalNewline` adds a line break at the end of a file
           * that has none, so the text the document holds after a save differs from the
           * text handed to it by a character that no amount of trimming accounts for.
           *
           * Modelled here because the checks about a write arriving during a save could
           * not tell the two directions of that rule apart without it: with only trimming
           * modelled, widening the rule to call every change during a save an outside
           * write failed nothing.
           */
          const files = getConfiguration('files', { uri: doc.uri, languageId: doc.languageId });
          if (files.get('insertFinalNewline', false) && doc.text !== '' && !doc.text.endsWith('\n')) {
            doc.text = `${doc.text}\n`;
            changed(doc);
          }
          /*
           * The one that takes characters away. `files.trimFinalNewlines` leaves a single
           * line break at the end and removes the rest, so what the document holds after a
           * save is shorter than what was handed to it. A rule that reads a save's own echo
           * as somebody else's write has something to call lost here, which the participant
           * that adds a newline does not.
           */
          if (files.get('trimFinalNewlines', false)) {
            const kept = doc.text.replace(/\n+$/, '\n');
            if (kept !== doc.text) {
              doc.text = kept;
              changed(doc);
            }
          }
          doc.isDirty = false;
          // The write itself, which is what anything reading the file afterwards sees,
          // with the file's own byte-order mark put back as VS Code puts it back.
          const written = doc.bom ? `﻿${doc.text}` : doc.text;
          contents.set(doc.uri.path, new TextEncoder().encode(written));
          doc.fileWas = written;
          doc.afterSave?.();
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

  /**
   * Load the host code into a window and activate the extension in it.
   *
   * `extension` is what VS Code puts on the context, and it is how an extension learns what
   * it was installed as. Reading it live rather than closing over it, so a window that sets
   * the id before starting gets the id it set.
   */
  const start = (win = makeWindow()) => {
    const host = load(win);
    host.activate({ subscriptions: [], extensionUri: file('/extension'), extension: { id: win.extensionId } });
    return { host, win };
  };

  const cases = [];
  const check = (name, run) => cases.push({ name, run });

  check('tables: nothing gives a table frame a vertical scrollbar, so a tall table is the document', () => {
    /*
     * A tall table's rows are the document. Capping the frame and scrolling inside it would
     * put rows behind a scrollbar that the editor's own scrollbar already handles, and a
     * person looking for row 400 would have two scrollbars to choose between.
     *
     * True today by omission: the frame sets `overflow-x` and nothing sets `overflow-y` or
     * a height. Omission is not an invariant, so this says it.
     *
     * Asked of the stylesheet rather than of a rendered table, because the rendered version
     * cannot be asked where the suites can reach it: jsdom has no layout, so `scrollHeight`
     * and `clientHeight` are both 0 and 0 === 0 would pass whatever the CSS said. A
     * rendered check belongs in the real-window suite.
     */
    const css = readFileSync(path.join(here, '..', 'media', 'webview.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, sel, body]) => ({ sel: sel.trim(), body }))
      .filter((r) => r.sel.includes('.sheaf-table-grid'));
    if (!rules.length) {
      return { ok: false, detail: 'no rule in webview.css mentions .sheaf-table-grid, so this check is reading the wrong thing' };
    }
    const bad = [];
    for (const r of rules) {
      for (const [, prop, value] of r.body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) {
        const v = value.trim();
        if (prop === 'overflow-y' && v !== 'visible') bad.push(`${r.sel} sets overflow-y: ${v}`);
        // The shorthand sets both axes, so anything but `visible` on the y half counts.
        if (prop === 'overflow' && !/^visible(\s+\S+)?$/.test(v)) bad.push(`${r.sel} sets overflow: ${v}, which sets the vertical axis too`);
        if (prop === 'max-height' || prop === 'height') bad.push(`${r.sel} sets ${prop}: ${v}, which would make the rows overflow`);
      }
    }
    return {
      ok: bad.length === 0,
      detail: bad.length ? `${bad.join('; ')}, so a tall table would scroll inside its own frame rather than as part of the document` : '',
    };
  });

  check('settings: a setting a host does not send reads as its default, not as nothing', () => {
    /*
     * Every host sends a `config` at `init` and not every host sends all of it: the
     * website's demo sends three of the seven, and this suite's own harness sends the same
     * three. So the page merges a host's config over the `DEFAULT_CONFIG` it declares.
     * Without that merge each default lives a second time inside whichever `applyConfig`
     * branch reads the setting, the two copies are free to disagree, and the demo gets a
     * different page from the editor for a setting nobody thought about.
     *
     * The subject is `tableOfContents` and the reason is the instrument. Booting this page
     * and reading it straight afterwards can see the outline rail and cannot see
     * `frontMatter`, `comments`, `revealSyntaxOnLine` or `contentWidth`: all four render
     * identically at init, because their decorations need what `scripts/check-render.mjs`
     * does about the first screen and the lazy parse. So this check proves the rule for the
     * one setting it can watch, and says so rather than implying the other four.
     */
    const DOC = '---\ntitle: A note\n---\n\n# Heading\n\nText, with a <!-- remark --> in it.\n\n## Second\n';
    const BASE = { contentWidth: '708px', revealSyntaxOnLine: false, doubleClickToEditSource: false };
    const render = (config) => {
      const w = bootWebview();
      w.receive({ type: 'init', text: DOC, config, fileName: 'notes.md', resourceBaseUri: 'https://webview/ws/' });
      const doc = w.document();
      return {
        page: (doc.querySelector('#editor')?.innerHTML ?? '') + (doc.querySelector('#toolbar')?.innerHTML ?? ''),
        text: w.doc(),
      };
    };
    // The instrument first: two configs that must produce different pages. If they do not,
    // this check can see nothing and everything below it would agree by accident.
    const hidden = render({ ...BASE, tableOfContents: 'hidden' });
    const shown = render({ ...BASE, tableOfContents: 'shown' });
    if (!hidden.page || hidden.text !== DOC) {
      return { ok: false, detail: `a boot produced ${hidden.page.length} characters and ${hidden.text === DOC ? 'the document' : 'the wrong document'}, so this check is reading the wrong thing` };
    }
    if (hidden.page === shown.page) {
      return { ok: false, detail: 'hiding and showing the outline render the same page, so this check cannot see the setting it is about' };
    }
    // The rule: a host that leaves tableOfContents out gets what a host that sends its
    // default gets, rather than whatever an absent value happens to do.
    const absent = render(BASE);
    return {
      ok: absent.page === hidden.page,
      detail:
        absent.page === hidden.page
          ? ''
          : `a host that sends no tableOfContents gets a different page from one sending its default of hidden, so an absent setting is not reading as its default`,
    };
  });

  check('commands: every command Sheaf offers is one activation registers, and it registers no other', () => {
    /*
     * `package.json` is what a person sees in the Command Palette and `registerCommand` is
     * what happens when they pick one, and nothing held the two together. A command in the
     * manifest with no registration is an entry that answers "command not found"; a
     * registration with no manifest entry is a feature nobody can reach.
     *
     * Asked of activation rather than of the source text, because six of these are
     * registered in a loop over a table of names, and a check that greps for
     * `registerCommand('...')` reports those six as missing. Activating against the stub
     * and reading back what registered is the only version of this that is true.
     */
    const { win } = start();
    const declared = new Set(manifest().contributes.commands.map((c) => c.command));
    const registered = new Set(win.registered().filter((id) => id.startsWith('sheaf.')));
    if (declared.size < 10 || registered.size < 10) {
      return { ok: false, detail: `${declared.size} commands declared and ${registered.size} registered, so this check is reading the wrong thing` };
    }
    const unreachable = [...declared].filter((id) => !registered.has(id));
    const hidden = [...registered].filter((id) => !declared.has(id));
    const wrong = [];
    if (unreachable.length) wrong.push(`the Command Palette offers ${unreachable.join(', ')} and activation registers no handler, so picking it says the command does not exist`);
    if (hidden.length) wrong.push(`activation registers ${hidden.join(', ')} and package.json declares no such command, so nothing can reach it`);
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('commands: the docs name every command the Command Palette offers, and promise no key that is not bound', () => {
    /*
     * `docs/settings.md` carries a table of every command, and the site renders it, so a
     * command added without a row is one a person cannot find out about and a row left
     * behind names something that no longer exists. Anything in `contributes.commands` is
     * in the Command Palette, so there is no such thing as one that does not need a row.
     *
     * The keys are held one way only. A key the docs print has to be bound, or the page
     * teaches a shortcut that does nothing. A binding the docs leave out is allowed:
     * `copyRef` has a second one for keyboards where the first is taken, and saying so
     * would cost more than it explains.
     */
    const { contributes } = manifest();
    const doc = readFileSync(path.join(here, '..', 'docs', 'settings.md'), 'utf8');
    const rows = [...doc.matchAll(/^\| \*\*(.+?)\*\*(.*?)\|/gm)].map((m) => ({ title: m[1], rest: m[2] }));
    if (rows.length < 10) {
      return { ok: false, detail: `${rows.length} command rows found in docs/settings.md, so this check is reading the wrong thing` };
    }
    const titles = new Map(contributes.commands.map((c) => [c.title, c.command]));
    const printed = new Set(rows.map((r) => r.title));
    const wrong = [];
    for (const title of titles.keys()) {
      if (!printed.has(title)) wrong.push(`the Command Palette offers "${title}" and docs/settings.md has no row for it`);
    }
    for (const row of rows) {
      if (!titles.has(row.title)) wrong.push(`docs/settings.md has a row for "${row.title}" and no command has that title`);
    }
    // A key the docs print, against what package.json binds for that command, on this
    // platform's spelling: the page says to use Ctrl in Cmd's place elsewhere.
    for (const row of rows) {
      const promised = /\(([^)]*(?:Cmd|Ctrl|Alt|Shift)[^)]*)\)/.exec(row.rest);
      if (!promised) continue;
      const id = titles.get(row.title);
      const bound = contributes.keybindings
        .filter((k) => k.command === id)
        .map((k) => (k.mac ?? k.key).toLowerCase());
      const want = promised[1].toLowerCase();
      if (!bound.includes(want)) {
        wrong.push(`docs/settings.md promises ${promised[1]} for "${row.title}" and package.json binds ${bound.length ? bound.join(' and ') : 'nothing'}`);
      }
    }
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

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

  check('open in Sheaf: a selection opens each file with the view type for it, and leaves the rest alone', async () => {
    // A .txt goes through its own view type, because a view type only opens what it is
    // contributed for. An image is not something this editor reads at all.
    const { win, host } = start();
    const selection = [file('/ws/a.md'), file('/ws/notes.txt'), file('/ws/logo.png'), file('/ws/NOTES.MD')];
    await win.run('sheaf.openWithWysiwyg', selection[0], selection);
    return same(win.opened(), [
      { path: '/ws/a.md', viewType: SHEAF },
      { path: '/ws/notes.txt', viewType: host.MarkdownEditorProvider.textViewType },
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
  const sheafWindow = (settings) => {
    const win = makeWindow(settings);
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

  /*
   * An agent writing the file while somebody is typing in it.
   *
   * VS Code reloads a document that changed on disk only while the document is clean,
   * and one being typed into never is, so the document goes on holding text read
   * before the write and the next auto-save puts it straight back over the top. The
   * agent's work is gone and nothing has said a word about it. These are the checks
   * for reading the file back before that save.
   */
  const OPEN_TABLE = 'Notes.\n\n| Task | State |\n| --- | --- |\n| Ship | Open |\n\nTail.\n';

  check('outside write: a cell an agent changed while the person was typing is still there afterwards', async () => {
    const { win, document, panel, type } = await openInSheaf(OPEN_TABLE);
    await type(`${OPEN_TABLE}More typing.\n`); // The person, at the end of the document.
    await pause(AFTER_THE_PAUSE); // Auto-save, so the file and the document agree.
    // The agent reads the file, changes a cell three paragraphs from the caret, writes
    // it back. The document knows nothing about it.
    win.writeFileFromOutside(document, `${OPEN_TABLE.replace('Open', 'Done')}More typing.\n`);
    await type(`${OPEN_TABLE}More typing here.\n`); // And the person types on.
    await pause(AFTER_THE_PAUSE);
    panel.close();
    const both = `${OPEN_TABLE.replace('Open', 'Done')}More typing here.\n`;
    return document.text === both && win.fileBehind(document) === both && win.warnings.length === 0;
  });

  check('outside write: a write to the very characters being typed leaves the person’s text, and says so', async () => {
    const { win, document, panel, type } = await openInSheaf(OPEN_TABLE);
    await type(`${OPEN_TABLE}More typing.\n`);
    await pause(AFTER_THE_PAUSE);
    // The control for the check above: same shape, but the agent wrote the same line
    // the person is typing in, so there is no answer and the person keeps theirs.
    win.writeFileFromOutside(document, `${OPEN_TABLE}More typing, rewritten entirely.\n`);
    await type(`${OPEN_TABLE}More typing here.\n`);
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return (
      document.text === `${OPEN_TABLE}More typing here.\n` &&
      same(win.warnings, [
        'Sheaf: something wrote to this file where you were typing, and your text was kept. The change that was written is in your file history, not in the document.',
      ])
    );
  });

  check('outside write: a file nobody else touched is read, matched and saved without a word', async () => {
    // The ordinary case, which has to stay silent and has to still write the file.
    const { win, document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return (
      document.saves === 1 &&
      win.fileBehind(document) === 'Some woZrds.\n' &&
      win.warnings.length === 0
    );
  });

  check('outside write: the save VS Code refuses is made by hand, and the document stops being unsaved', async () => {
    /*
     * Once the file has moved, VS Code refuses to write the document at all: it
     * compares the file against what it noted when it last read or wrote it, and it
     * brings that note up to date only by reading the file, which it will not do into
     * a document with unsaved changes. So every save from then on fails.
     *
     * Safe to settle here rather than ask, because the document is not a rival version
     * of the file by this point: the write has already been read and put into it. So
     * the file is written directly, and the revert that follows changes no text and
     * brings VS Code's note up to date.
     */
    const { win, document, panel, type } = await openInSheaf(OPEN_TABLE);
    await type(`${OPEN_TABLE}More typing.\n`);
    await pause(AFTER_THE_PAUSE);
    win.writeFileFromOutside(document, `${OPEN_TABLE.replace('Open', 'Done')}More typing.\n`);
    await type(`${OPEN_TABLE}More typing here.\n`);
    await pause(AFTER_THE_PAUSE);
    const both = `${OPEN_TABLE.replace('Open', 'Done')}More typing here.\n`;
    const reverted = win.executed.some(([command]) => command === 'workbench.action.files.revert');
    panel.close();
    return (
      win.fileBehind(document) === both && document.isDirty === false && reverted && win.warnings.length === 0
    );
  });

  check('outside write: a write that lands after the file was read is still read before anything is written over it', async () => {
    /*
     * The ordering that made the by-hand write dangerous. Sheaf reads the file, finds
     * nothing new, hands the document to VS Code, and the write lands in between. VS
     * Code refuses that save, because the file has moved, and the recovery then wrote
     * the document straight over it: a paragraph an agent had deleted came back, in
     * the file and on screen, with nothing said about it.
     *
     * So the refusal is treated as the news it is, and the file is read again and put
     * into the document before a byte of it is written over.
     */
    const three = 'Top line.\n\nMiddle line.\n\nBottom line.\n';
    const { win, document, panel, type } = await openInSheaf(three);
    await type(three.replace('Bottom', 'BoZZttom'));
    await pause(AFTER_THE_PAUSE); // Saved, so the file and the document agree.
    // The agent deletes a whole paragraph, as the save of the next keystroke is handed over.
    document.beforeSave = () => {
      document.beforeSave = null;
      win.writeFileFromOutside(document, 'Top line.\n\nBottom line.\n');
    };
    await type(three.replace('Bottom', 'BoZZYYttom'));
    await pause(AFTER_THE_PAUSE);
    panel.close();
    const both = 'Top line.\n\nBoZZYYttom line.\n';
    return win.fileBehind(document) === both && document.getText() === both && win.warnings.length === 0;
  });

  check('outside write: a file with a byte-order mark still has it after the save is made by hand', async () => {
    // The mark is the file's, not the document's, so writing the document's text over
    // the file would take it off a file nobody edited. That is the whole-file diff this
    // editor exists to avoid.
    const win = makeWindow();
    const { MarkdownEditorProvider } = load(win);
    const document = win.openDocument('/ws/notes.md', OPEN_TABLE, { bom: true });
    const panel = makePanel();
    await new MarkdownEditorProvider({ extensionUri: file('/extension') }).resolveCustomTextEditor(
      document,
      panel,
      {}
    );
    panel.receive({ type: 'edit', text: `${OPEN_TABLE}More typing.\n` });
    await settle();
    await pause(AFTER_THE_PAUSE);
    win.writeFileFromOutside(document, `﻿${OPEN_TABLE.replace('Open', 'Done')}More typing.\n`);
    panel.receive({ type: 'edit', text: `${OPEN_TABLE}More typing here.\n` });
    await settle();
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return win.fileBehind(document) === `﻿${OPEN_TABLE.replace('Open', 'Done')}More typing here.\n`;
  });

  check('outside write: nothing is written by hand while the file is one VS Code will take', async () => {
    // The control for writing by hand at all. No outside write, so the ordinary save
    // works and the recovery must stay out of it: a revert here would be throwing away
    // the document's own history for nothing.
    const { win, document, panel, type } = await openInSheaf(OPEN_TABLE);
    await type(`${OPEN_TABLE}More typing.\n`);
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return (
      document.saves === 1 &&
      win.fileBehind(document) === `${OPEN_TABLE}More typing.\n` &&
      !win.executed.some(([command]) => command === 'workbench.action.files.revert')
    );
  });

  check('outside write: two places changed in one write are both kept, with the person typing between them', async () => {
    // One write, several places, which is what an agent does. Both of the agent's
    // cells are three paragraphs from each other with the person's line in between.
    const grid = 'Notes.\n\n| Task | State |\n| --- | --- |\n| Ship | Open |\n\nMiddle.\n\n| Docs | Open |\n\nTail.\n';
    const { win, document, panel, type } = await openInSheaf(grid);
    await type(grid.replace('Middle.', 'Middle typing.'));
    await pause(AFTER_THE_PAUSE);
    win.writeFileFromOutside(document, grid.replace('Middle.', 'Middle typing.').replaceAll('Open', 'Done'));
    await type(grid.replace('Middle.', 'Middle typing more.'));
    await pause(AFTER_THE_PAUSE);
    panel.close();
    return (
      document.text === grid.replace('Middle.', 'Middle typing more.').replaceAll('Open', 'Done') &&
      win.warnings.length === 0
    );
  });

  /*
   * The same trigger as the checks above, with one difference that turns out to be the
   * whole of it: the person stops typing. Every check above types again after the
   * write, and that later keystroke is what carries their earlier letters to disk. A
   * person who types a word and reads on is the ordinary case, and the save they are
   * owed is the one already on the debounce when the write landed.
   */
  const THREE_LINES = 'Top line.\n\nMiddle line here.\n\nBottom line.\n';
  const AGENT_CHANGED_THE_TOP = 'Top line changed by an agent.\n\nMiddle line here.\n\nBottom line.\n';
  const BOTH_CHANGES = 'Top line changed by an agent.\n\nZMiddle line here.\n\nBottom line.\n';

  check('outside write: a letter typed just before the write reaches the file with nothing typed after it', async () => {
    const { win, document, panel, type } = await openInSheaf(THREE_LINES);
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    // Inside the 700ms debounce, so the save the letter is riding on has not run yet
    // and the write lands under it.
    await pause(300);
    win.writeFileFromOutside(document, AGENT_CHANGED_THE_TOP);
    await pause(AFTER_THE_PAUSE);
    // Read before closing: closing flushes a pending save, which would answer a
    // different question from the one this asks.
    const onDisk = win.fileBehind(document);
    const inDocument = document.text;
    panel.close();
    return onDisk === BOTH_CHANGES && inDocument === BOTH_CHANGES && win.warnings.length === 0;
  });

  check('outside write: a save that reports success but was overtaken is not believed', async () => {
    /*
     * The fourth ordering, and the one that had no handling at all. VS Code refuses a save
     * whose file it noticed moving, and the check below recovers from that refusal. It only
     * refuses when it noticed: a write landing in the same handful of milliseconds reaches
     * the filesystem alongside the save, the later one wins, and `save()` still answers true.
     *
     * Measured in a real window before this was written, over four attempts with the write
     * aimed at the moment of the save: one was refused and recovered, and the other three
     * reported success while the file held one change or the other and never both. Twice the
     * person's letter went while the editor went on showing it, so the screen and the file
     * disagreed for as long as the document stayed open; once it was the agent's line, which
     * nothing was ever going to notice.
     *
     * Here the file is overwritten from underneath at the moment the save finishes, with the
     * document's own record of what the file held left alone, which is what an overtaking
     * write looks like from the extension's side.
     */
    const { win, document, panel, type } = await openInSheaf(THREE_LINES);
    document.afterSave = () => {
      document.afterSave = null;
      // The file only. `writeFromOutside` would also reload the document, which is the case
      // the check below this one covers; this is the one where nothing tells the editor.
      win.writeFileFromOutside(document, AGENT_CHANGED_THE_TOP);
    };
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    await pause(AFTER_THE_PAUSE);
    const onDisk = win.fileBehind(document);
    panel.close();
    // Both changes, because the merge had a base to work from and nothing had been recorded
    // as Sheaf's own that was not.
    return onDisk === BOTH_CHANGES;
  });

  check('outside write: a write landing while Sheaf’s save is being refused still keeps the letter', async () => {
    // The third ordering. The write arrives before VS Code reads the file for the save,
    // so the save is refused, and the hand-written one that follows is the path that has
    // to put the two together.
    const { win, document, panel, type } = await openInSheaf(THREE_LINES);
    document.beforeSave = () => {
      document.beforeSave = null;
      win.writeFileFromOutside(document, AGENT_CHANGED_THE_TOP);
    };
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    await pause(AFTER_THE_PAUSE);
    const onDisk = win.fileBehind(document);
    panel.close();
    return onDisk === BOTH_CHANGES && win.warnings.length === 0;
  });

  check('outside write: a write landing in the moment after Sheaf’s own save is news, not the echo of that save', async () => {
    /*
     * The letter is saved, and the write arrives immediately afterwards, carrying a
     * copy of the file from before it. VS Code reloads the document, because it is
     * clean again, and reports that while Sheaf still has a save outstanding.
     *
     * Read as an echo of Sheaf's own save, the write goes into the webview unopposed:
     * no notice is worked out, because none is worked out for Sheaf's own changes, and
     * the letter leaves the screen with nothing said and no way back but a Cmd+Z the
     * person has no reason to press.
     *
     * What the write takes is a separate question, answered by whoever owns what the
     * merge promises. This is about the write being seen at all.
     *
     * The control is that this check fails on the rule it was written for: called an
     * echo, the write reaches the webview with no notice and nothing marked.
     *
     * The other direction is covered too, by "a save of their own does not throw away the
     * record of what they typed" further down, and it took finding that the reasoning
     * written here first was wrong. It said the missing piece was a save participant
     * changing something other than trailing whitespace. Three participants were modelled
     * and none of them discriminated, because the two effects anyone looks at are both
     * repaired: `writable` refuses the spurious save on a clean document, and
     * `keepTheLineBeingTyped` repairs the text before the notice is worked out.
     *
     * The effect nothing repairs is `this.typing.forget()`. The record of what the person
     * typed is what lets the *next* write be recognised as taking it, so the cost of
     * calling a save's own echo somebody else's write is not paid at the save at all. It is
     * paid by the write after it, which really does take their letter and now says nothing.
     */
    const { win, ctx, document, panel, type } = await openInSheaf(THREE_LINES);
    const pastTheWindow = ctx.host.KEEP_AFTER_OWN_SAVE_MS + 300;
    document.afterSave = () => {
      document.afterSave = null; // Once: this is one write, not a write per save.
      // Past the window in which the person's own save is still the last thing that
      // happened, so the letter is taken and reported rather than kept. Inside that
      // window the check below keeps it, and the two together are what say the bound
      // bounds anything: with it removed this one reports nothing taken and fails.
      setTimeout(() => win.writeFromOutside(document, AGENT_CHANGED_THE_TOP), pastTheWindow);
    };
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    await pause(pastTheWindow + AFTER_THE_PAUSE);
    const tookTypedText = panel.posted.filter((m) => m.type === 'setContent').at(-1)?.tookTypedText;
    panel.close();
    return (
      // Said, rather than passed off as Sheaf's own work.
      same(win.warnings, [
        'Sheaf: this file changed outside the editor, and your last change is gone: "Z". Undo brings it back.',
      ]) &&
      // And marked as the person's own, which is what makes their Undo reach it.
      tookTypedText === true
    );
  });

  check('outside write: a letter Sheaf had already saved is kept when the write was made from a copy read before that save', async () => {
    /*
     * The setup is the check above's, and only the question differs. There it is whether
     * the write is seen at all; here it is what the write is allowed to take.
     *
     * The letter reached disk under Sheaf's own save, so nothing is unsaved and the path
     * that protects unsaved typing has nothing to protect. The write carries a copy of
     * the file from before that save, so measured against the text its author actually
     * read it changes one other line and the letter stands.
     *
     * The control is the rule this was written for: with the base still chosen as the
     * newest text Sheaf wrote, the two texts agree, nothing is merged, and the file is
     * taken whole. That fails here on the document and on the notice at once.
     */
    const { win, document, panel, type } = await openInSheaf(THREE_LINES);
    document.afterSave = () => {
      document.afterSave = null; // Once: one write, not a write per save.
      win.writeFromOutside(document, AGENT_CHANGED_THE_TOP);
    };
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    await pause(AFTER_THE_PAUSE);
    // What the webview is shown, which is where the merge lands. Carrying it on to the
    // file is the auto-save path and is covered by the checks above.
    const shown = panel.posted.filter((m) => m.type === 'setContent').at(-1)?.text;
    panel.close();
    // Both changes, and nothing to report: on this side of the debounce as on the other.
    return shown === BOTH_CHANGES && win.warnings.length === 0;
  });

  check('outside write: the letter a merge kept is written to the file, not only shown', async () => {
    /*
     * The check above asks what the webview is shown and passes. This asks what the file
     * holds, and they are not the same question: the merge posts `setContent` to the page
     * and never edits the document, so the save that follows writes what VS Code reloaded
     * from the file, which is the text without the letter.
     *
     * Measured in a real window over six delays, three runs each, with nobody touching the
     * keyboard afterwards: the letter reaches the file at 100ms and 300ms, sometimes at
     * 500ms, and never at 700ms or beyond. The screen keeps it in all eighteen and no
     * notice fires in any of them. At 1500ms it had already been written to disk by Sheaf's
     * own save before the write landed, so a completed save is being undone and not redone.
     *
     * Which makes the screen and the file disagree with nothing said, and that is worse
     * than the loss it replaced: before the merge the letter left the screen and a notice
     * offered Undo.
     */
    const { win, document, panel, type } = await openInSheaf(THREE_LINES);
    await type('Top line.\n\nZMiddle line here.\n\nBottom line.\n');
    // Past the debounce, so the letter is on disk before the write arrives.
    await pause(1500);
    win.writeFromOutside(document, AGENT_CHANGED_THE_TOP);
    await pause(AFTER_THE_PAUSE * 3);
    const onDisk = win.fileBehind(document);
    const shown = panel.posted.filter((m) => m.type === 'setContent').at(-1)?.text;
    panel.close();
    return {
      ok: onDisk === BOTH_CHANGES,
      detail: `file ${JSON.stringify(onDisk)}; the page was shown ${JSON.stringify(shown)}; notices ${JSON.stringify(win.warnings)}`,
    };
  });

  check('outside write: a save participant trimming blank lines is still the echo of that save', async () => {
    /*
     * The control the check above says it lacks, now that a participant changing
     * something other than trailing whitespace is modelled.
     *
     * `files.trimFinalNewlines` is ordinary: many people have it on. It edits the
     * document on the way out of a save, taking blank lines off the end, and
     * `savingText` is captured before any participant runs. The rule that decides whether a change came from outside
     * compares the two after trimming spaces and tabs from line ends, which accounts
     * for the other participant and not for this one, so this save's own echo is read
     * as somebody else's write.
     *
     * What that costs the person is a notice saying their file changed outside the
     * editor and their last change is gone, at the moment they saved it themselves,
     * with nothing having changed outside anything.
     *
     * Nothing arrives from outside here. The only write is Sheaf's own save.
     */
    const trims = { user: { '[markdown]': { 'files.trimFinalNewlines': true } } };
    const { win, document, panel, type } = await openInSheaf('Top line.\n\n\n', '/ws/notes.md', sheafWindow(trims));
    // Blank lines at the end, so the participant has something to take away. Asserted
    // below rather than assumed: with nothing to trim this check proves nothing.
    await type('Top line and more.\n\n\n');
    await pause(AFTER_THE_PAUSE);
    const participantActed = document.text === 'Top line and more.\n';
    const notices = [...win.warnings];
    const tookTypedText = panel.posted.filter((m) => m.type === 'setContent').at(-1)?.tookTypedText;
    panel.close();
    if (!participantActed) throw new Error('the final-newline participant did not run, so this check asks nothing');
    if (notices.length) throw new Error(`a save of their own told the person: ${JSON.stringify(notices)}`);
    if (tookTypedText) throw new Error('the editor was told its own save took the typed text');
    return true;
  });

  check('outside write: a save of their own does not throw away the record of what they typed', async () => {
    /*
     * The control the check above says it lacks, found by reading what `outside` is used
     * for rather than by guessing at a participant.
     *
     * A change read as coming from outside does three things, and two of them hide the
     * mistake. The notice is worked out from `arriving`, which `keepTheLineBeingTyped`
     * has already repaired, so there is nothing to report; and the save it schedules is
     * refused on a clean document. The third is `this.typing.forget()`, and nothing
     * repairs that: the record of what the person typed is what lets the *next* write be
     * recognised as taking it, and once it is thrown away the next write is silent.
     *
     * So the cost of calling a save's own echo somebody else's write is not paid at the
     * save. It is paid by the write after it, which is the one that really does take the
     * person's letter and now says nothing about it.
     *
     * The shape needed to see it: whitespace trimmed on a line the person is not typing
     * on. `keepTheLineBeingTyped` restores only their own line, so the arriving text
     * differs from the webview's elsewhere, which is what makes the change reach the
     * webview at all and the record be forgotten. A trim on their own line alone is
     * repaired end to end and reaches nothing.
     */
    const trims = { user: { '[markdown]': { 'files.trimTrailingWhitespace': true } } };
    // The trailing space on the first line is the file's, not theirs.
    const { win, document, panel, type } = await openInSheaf('Start \n\nTail\n', '/ws/notes.md', sheafWindow(trims));
    await type('Start \n\nZTail\n');
    await pause(AFTER_THE_PAUSE);
    // Their own save has been and gone, and the participant trimmed the first line.
    const trimmedByTheSave = document.text === 'Start\n\nZTail\n';
    // Now a write that really does take the letter, well inside the ten seconds a
    // keystroke goes on counting for.
    win.writeFromOutside(document, 'Start\n\nTail\n');
    await pause(AFTER_THE_PAUSE);
    const notices = [...win.warnings];
    panel.close();
    if (!trimmedByTheSave) {
      throw new Error(`the save participant did not trim the first line, so this check asks nothing: ${JSON.stringify(document.text)}`);
    }
    if (!notices.some((w) => w.includes('your last change is gone') && w.includes('"Z"'))) {
      throw new Error(`the write took their letter and said nothing that named it: ${JSON.stringify(notices)}`);
    }
    return true;
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

  /*
   * What a pasted path names, which only the host can answer: the page cannot read another
   * file, and its own origin is `vscode-webview://`, so it cannot resolve a relative path
   * either. Every case below is one the editor then writes into somebody's document, so the
   * two that matter most are the ones where the answer must be *nothing*.
   */
  const titleReply = (panel) => panel.posted.filter((m) => m.type === 'docTitle');

  /** Ask what `pasted` names, from a document at `/ws/docs/notes.md`. */
  const askTitle = async (pasted, set = () => {}) => {
    const ctx = sheafWindow();
    ctx.win.addWorkspaceRoots('/ws');
    set(ctx.win);
    const { panel } = await openInSheaf('Some words.\n', '/ws/docs/notes.md', ctx);
    panel.receive({ type: 'docTitleRead', id: 'title-1', path: pasted });
    await settle();
    await settle();
    const [reply] = titleReply(panel);
    return reply ? { address: reply.address, title: reply.title } : null;
  };

  const withPlan = (text) => (win) => win.addFileHolding('/ws/docs/notes/plan.md', text);

  check('pasted path: a path relative to the document is answered with the document’s own title', async () => {
    const reply = await askTitle('notes/plan.md', withPlan('# Launch plan\n\nBody.\n'));
    return (
      same(reply, { address: 'notes/plan.md', title: 'Launch plan' }) || `got ${JSON.stringify(reply)}`
    );
  });

  check('pasted path: an absolute path and a file: URL in the workspace are answered, made relative to the document', async () => {
    const absolute = await askTitle('/ws/plan.md', (win) => win.addFileHolding('/ws/plan.md', '# Launch plan\n'));
    const url = await askTitle('file:///ws/plan.md', (win) => win.addFileHolding('/ws/plan.md', '# Launch plan\n'));
    // The document is in `/ws/docs`, so a file at the root is one level up.
    const want = { address: '../plan.md', title: 'Launch plan' };
    return (
      (same(absolute, want) && same(url, want)) || `absolute ${JSON.stringify(absolute)}, url ${JSON.stringify(url)}`
    );
  });

  check('pasted path: a file with no heading is answered with its file name', async () => {
    const reply = await askTitle('notes/plan.md', withPlan('Body with no heading.\n'));
    return same(reply, { address: 'notes/plan.md', title: 'plan' }) || `got ${JSON.stringify(reply)}`;
  });

  check('pasted path: a document already open answers with the title it now has, not the one on disk', async () => {
    const reply = await askTitle('notes/plan.md', (win) => {
      // Opening a document puts its text on disk too, so the bytes are written after, which
      // is what "unsaved changes" means: the document and the file say different things.
      win.openDocument('/ws/docs/notes/plan.md', '# Renamed while open\n');
      win.addFileHolding('/ws/docs/notes/plan.md', '# On disk\n');
    });
    return same(reply, { address: 'notes/plan.md', title: 'Renamed while open' }) || `got ${JSON.stringify(reply)}`;
  });

  check('pasted path: a path outside the workspace, one that is not Markdown, and one that is not there are answered with nothing', async () => {
    // The workspace boundary is the one that matters. A path outside it resolves, reads and
    // links fine, and the link is then broken for everybody who clones the repository.
    const outside = await askTitle('/elsewhere/plan.md', (win) => win.addFileHolding('/elsewhere/plan.md', '# Launch plan\n'));
    const notMarkdown = await askTitle('notes/plan.txt', (win) => win.addFileHolding('/ws/docs/notes/plan.txt', '# Launch plan\n'));
    const missing = await askTitle('notes/gone.md');
    const empty = { address: undefined, title: undefined };
    return (
      (same(outside, empty) && same(notMarkdown, empty) && same(missing, empty)) ||
      `outside ${JSON.stringify(outside)}, not markdown ${JSON.stringify(notMarkdown)}, missing ${JSON.stringify(missing)}`
    );
  });

  check('pasted path: every request is answered, so the page never waits out its timeout', async () => {
    // Answered with nothing rather than not answered. The page gives up after a quarter of a
    // second and pastes the path as text, and a paste that takes that long to land reads as
    // a stutter even though what it finally does is right.
    const ctx = sheafWindow();
    ctx.win.addWorkspaceRoots('/ws');
    const { panel } = await openInSheaf('Some words.\n', '/ws/docs/notes.md', ctx);
    for (const [i, pasted] of ['notes/gone.md', 'notes/plan.txt', 'https://example.com/a.md', ''].entries()) {
      panel.receive({ type: 'docTitleRead', id: `title-${i}`, path: pasted });
    }
    await settle();
    await settle();
    // Sorted: each answer carries the id it was asked with, so four requests in flight at
    // once come back in whatever order their reads finish in and the editor does not care.
    const ids = titleReply(panel)
      .map((m) => m.id)
      .sort();
    return same(ids, ['title-0', 'title-1', 'title-2', 'title-3']) || `answered ${JSON.stringify(ids)}`;
  });

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

  /*
   * The chrome's type scale: four named steps and nothing else.
   *
   * A count rather than a list, because the point is that the set does not grow. It had 55
   * declarations holding 15 values, two of them 12.5px against the 12px fifteen other rules
   * used, and the way that happened is one rule at a time with nobody counting.
   *
   * The document's own typography is exempt and stays in `em` and `--md-code-size`: a heading
   * is a multiple of the body text by definition, and the chrome is the opposite case, where
   * inheriting from whatever you are nested inside is the bug.
   */
  check('stylesheet: the chrome takes four named type steps, all from one base, and no chrome rule sets a size of its own', () => {
    const css = readFileSync(path.join(here, '..', 'media', 'webview.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const strays = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, ' ');
      // The document's own typography, and the one token block that defines the steps.
      if (/^:root$|^@|\.tok-|\.md-|\.cm-line\.|\.sheaf-root\.source-mode/.test(selector)) continue;
      for (const decl of m[2].split(';')) {
        const at = decl.indexOf(':');
        if (at < 0 || decl.slice(0, at).trim() !== 'font-size') continue;
        const value = decl.slice(at + 1).trim();
        if (/^var\(--sheaf-ui-(row|secondary|label|title)\)$/.test(value)) continue;
        // A table's cells, a view's rows and a board's cards show document content, so they
        // are sized against the document and named here rather than left to a pattern.
        if (/^(\.sheaf-table table|\.sheaf-view table|\.sheaf-board|\.sheaf-frontmatter-fold)$/.test(selector)) continue;
        // A row number and the corner sit beside the rows and are sized against them, or the
        // numbers would not line up with the text they number.
        if (/\.sheaf-table-gutter|\.sheaf-table-corner/.test(selector)) continue;
        strays.push(`${selector} => ${value}`);
      }
    }
    if (strays.length) return { ok: false, detail: `off the four steps: ${strays.join('; ')}` };
    /*
     * Read straight out of the file rather than through `cssRule`, which cannot see the first
     * `:root` block. Its regex takes everything since the previous `}` as the selector, and the
     * `@import` above that block comes with it, so the selector reads `@import url('katex.css');
     * :root` and matches nothing. The later `:root` blocks it does read are why that has gone
     * unnoticed.
     */
    const declared = (name) => (new RegExp(`--${name}:\\s*([^;]+);`).exec(css) ?? [])[1]?.trim() ?? null;
    // All four from one base, which is what makes the chrome one knob rather than four.
    const derived = ['row', 'secondary', 'label', 'title'].filter((k) => !/var\(--sheaf-ui-step\)/.test(declared(`sheaf-ui-${k}`) ?? ''));
    if (derived.length) return { ok: false, detail: `these steps do not derive from --sheaf-ui-step: ${derived.join(', ')}` };
    /*
     * Named for the host's UI size, with a browser tab's size behind it, and **13px is still what a
     * browser tab gets** — which is the thing this asserts rather than the spelling it is written in.
     *
     * It used to compare the declaration against the exact string `var(--vscode-font-size, 13px)`.
     * That pinned the text while the comment above it described the value, so naming the fallback as
     * a token failed the check without changing a pixel. A check that cares about a number and reads
     * a string says so only when somebody writes the number a second way.
     *
     * So the fallback is followed: written inline or as a Sheaf token, it has to arrive at 13px.
     */
    const step = declared('sheaf-ui-step');
    const base = /^var\(\s*--vscode-font-size\s*,\s*(.+?)\s*\)$/.exec(step ?? '');
    if (!base) return { ok: false, detail: `--sheaf-ui-step is ${step}, not the host's UI size with a fallback` };
    const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(base[1]);
    const browser = token ? declared(token[1].slice(2)) : base[1];
    return browser === '13px'
      ? true
      : { ok: false, detail: `a browser tab's UI size resolves to ${browser}, from --sheaf-ui-step ${step}` };
  });

  check('stylesheet: the header row sticks to the top of the editor, and a table that fits its frame lets it', () => {
    const head = cssRule('.sheaf-table thead tr');
    const frame = cssRule('.sheaf-table.has-widths:not(.is-scroll-x) > .sheaf-table-grid');
    // A sticky `top` is measured inside the scroller's padding, so the row has to
    // undo the space above the first line to reach the top of the pane. `top: 0`
    // held it that far down, with rows still showing above it.
    return (
      head.position === 'sticky' &&
      head.top === 'calc(-1 * var(--sheaf-page-top) - 1px)' &&
      cssRule(':root')['--sheaf-page-top'] === '56px' &&
      !!head['z-index'] &&
      !!head.background &&
      frame['overflow-x'] === 'visible'
    );
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

  check('explorer menu: Open in Sheaf is offered for Markdown and .txt, and nothing else', () => {
    // `.txt` is offered because a person keeping notes in one has no other way in, and
    // the editor never opens one by itself. `.mdx`, `.cmd` and `.text` only look like
    // the three. The clause reads `resourceExtname`, which is the last extension and
    // nothing more, so those are the only strings it is ever asked about.
    const offered = whenRegex(explorerWhenClause());
    return (
      offered !== undefined &&
      ['.md', '.markdown', '.txt'].every((ext) => offered.test(ext)) &&
      ['.cmd', '.mdx', '.text', ''].every((ext) => !offered.test(ext))
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
    return init().config.tableOfContents === 'hidden';
  });

  check('table of contents: with the setting on, every editor opened is told so, not just the one that turned it on', async () => {
    const ctx = sheafWindow();
    // `true` is what this setting held when it was a boolean, and it still means shown:
    // every editor is told the state it names rather than the value as written.
    ctx.win.vscode.workspace.getConfiguration().update(TOC, true, GLOBAL);
    const first = await openInSheaf('# One\n', '/ws/one.md', ctx);
    const second = await openInSheaf('# Two\n', '/ws/two.md', ctx);
    first.ready();
    second.ready();
    return first.init().config.tableOfContents === 'shown' && second.init().config.tableOfContents === 'shown';
  });

  check('table of contents: the toolbar button writes it on in user settings, where it holds for every file', async () => {
    const { win, webview } = await openWithWebview('# One\n\nWords.\n');
    webview.window.document.querySelector('.sheaf-tb-toc').click();
    await settle();
    webview.close();
    return (
      same(win.writesTo(GLOBAL), [{ key: TOC, target: GLOBAL }]) &&
      win.writesTo(WORKSPACE).length === 0 &&
      load(win).tableOfContentsOn() === true
    );
  });

  check('table of contents: the toolbar button cycles the three states and says which one it is in', async () => {
    const { win, webview } = await openWithWebview('# One\n\nWords.\n', undefined, { user: { [TOC]: true } });
    const button = webview.window.document.querySelector('.sheaf-tb-toc');
    const drawn = () => ({
      pressed: button.getAttribute('aria-pressed'),
      folded: button.classList.contains('is-folded'),
      name: button.getAttribute('aria-label'),
    });
    const states = [];
    const looks = [drawn()];
    // Three presses, so the third has to come back to where it started.
    for (let i = 0; i < 3; i++) {
      button.click();
      await settle();
      states.push(load(win).outlineSetting());
      looks.push(drawn());
    }
    webview.close();
    return (
      same(states, ['collapsed', 'hidden', 'shown']) &&
      // Pressed means drawn at all, and the folded look is the middle one. The name has
      // to differ in all three, because it is the only thing that is read out.
      same(
        looks.map((l) => `${l.pressed}${l.folded ? '/folded' : ''}`),
        ['true', 'true/folded', 'false', 'true']
      ) &&
      new Set(looks.slice(0, 3).map((l) => l.name)).size === 3 &&
      win.writesTo(WORKSPACE).length === 0
    );
  });

  check('line numbers: the toolbar’s toggle writes a user setting, so a reopened document still has them', async () => {
    /*
     * The gutter was a module variable in the webview, so turning it on lasted until the
     * document closed and every document opened without it. It is a setting now, written
     * globally, for the reason the heading list is: it is a habit of the person rather than a
     * property of one file, and VS Code settles its own `editor.lineNumbers` the same way.
     *
     * The reopen is what the issue is about, so it is what this asks: a second editor,
     * opened after the toggle, has to be told the gutter is on.
     */
    const { win, panel, ready, init } = await openInSheaf();
    ready();
    await settle();
    const before = init().config.lineNumbers;
    panel.receive({ type: 'setLineNumbers', on: true });
    await settle();
    // Global, not workspace: a workspace write would leave it behind in one folder.
    const wrote = win.writesTo(GLOBAL).filter((w) => w.key === 'sheaf.lineNumbers');
    // A document opened afterwards, which is the case the issue names.
    const second = await openInSheaf('Other words.\n', '/ws/other.md', win === undefined ? undefined : { win, host: load(win) });
    second.ready();
    await settle();
    return (
      before === false &&
      wrote.length === 1 &&
      second.init().config.lineNumbers === true &&
      win.writesTo(WORKSPACE).length === 0
    );
  });

  check('table of contents: the command turns it on, and turns it off again', async () => {
    const { host, win } = start();
    await win.run('sheaf.toggleTableOfContents');
    const on = host.tableOfContentsOn();
    await win.run('sheaf.toggleTableOfContents');
    return on === true && host.tableOfContentsOn() === false && win.writesTo(WORKSPACE).length === 0;
  });

  check('table of contents: the three commands each write their own state, collapsed included', async () => {
    const { host, win } = start();
    const after = [];
    for (const command of ['sheaf.showTableOfContents', 'sheaf.collapseTableOfContents', 'sheaf.hideTableOfContents']) {
      await win.run(command);
      after.push(host.outlineSetting());
    }
    // Collapsed is the state toggling cannot reach, which is why the three exist.
    return (
      same(after, ['shown', 'collapsed', 'hidden']) &&
      same(
        win.writesTo(GLOBAL).map((w) => w.key),
        [TOC, TOC, TOC]
      ) &&
      win.writesTo(WORKSPACE).length === 0
    );
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
    const button = webview.window.document.querySelector('.sheaf-tb-toc');
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

  check('manifest: activating the extension registers all three of Sheaf’s editors', () => {
    // Three view types and two editors: the Markdown one is registered twice, once for
    // the files it opens by itself and once for .txt, which it never does.
    const { host, win } = start();
    return same(win.editorProviders, [
      SHEAF,
      host.MarkdownEditorProvider.textViewType,
      host.MarkdownEditorProvider.gridViewType,
    ]);
  });

  check('manifest: the two reference keys answer inside a Sheaf editor, a document or a data file, and nowhere else', () => {
    const onlyInSheaf = `activeCustomEditorId == '${SHEAF}' || activeCustomEditorId == 'sheaf.text' || activeCustomEditorId == 'sheaf.csv'`;
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

  check('manifest: the table of contents starts off, still takes the two values it used to, and names no other product', () => {
    // Three states now, and the two booleans it held before them are still accepted,
    // because a person who wrote one into their settings should not have to know.
    const setting = manifest().contributes.configuration.properties[TOC];
    const copy = `${setting?.description ?? ''} ${(manifest().contributes.commands ?? []).map((c) => c.title).join(' ')}`;
    return (
      same(setting?.type, ['string', 'boolean']) &&
      same(setting?.enum, ['shown', 'collapsed', 'hidden', true, false]) &&
      setting.default === 'hidden' &&
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
    const ours = [viewType, MarkdownEditorProvider.textViewType, MarkdownEditorProvider.gridViewType];
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

  /*
   * Which build is running.
   *
   * The bundle these drive is stamped by `scripts/run-tests.mjs` with a fixed
   * commit, so what they read is the real path through `src/buildStamp.ts` rather
   * than its fallback.
   */

  /** The first line of an About message, which is the part meant for a bug report. */
  const aboutLine = (message) => message.split('\n')[0];

  check('about: the line names the version, the commit and the host, and Copy puts it on the clipboard', async () => {
    const { win } = start();
    win.answerWith('Copy');
    await win.run('sheaf.about');
    const line = win.messages[win.messages.length - 1];
    const named = line.includes('Sheaf 0.2.0') && line.includes('abc1234') && line.includes('Visual Studio Code 1.90.0');
    return named && win.copied[win.copied.length - 1] === line && !line.includes('built from a modified tree');
  });

  check('about: in a window that is behind, About says so and Copy still takes only the build line', async () => {
    const { win } = start();
    // Stale on purpose, which is the only state where About has two things to say.
    // With the window up to date the two strings are identical and a check on this
    // could not fail, which is how the first draft of it passed for nothing.
    win.answerWith('Copy');
    await win.installBuild('0.2.809');
    await win.run('sheaf.about');
    const shown = win.messages[win.messages.length - 1];
    const copied = win.copied[win.copied.length - 1];
    // A bug report wants the build, not a note about this window needing a reload.
    return shown.includes('0.2.809 is installed') && shown.includes('reload') && copied === aboutLine(shown) && !copied.includes('installed');
  });

  check('about: over a remote link the line says so, because the extension runs on the far side', async () => {
    const win = makeWindow();
    win.overRemote('ssh-remote');
    start(win);
    await win.run('sheaf.about');
    return win.messages[win.messages.length - 1].includes('over ssh-remote');
  });

  check('about: a build installed while the window is open offers a reload, and taking it reloads', async () => {
    const { win } = start();
    win.answerWith('Reload Window');
    await win.installBuild('0.2.809');
    const said = win.messages.some((m) => m.includes('0.2.809') && m.includes('0.2.0'));
    const reloaded = win.executed.some(([id]) => id === 'workbench.action.reloadWindow');
    return said && reloaded;
  });

  check('about: the same installed build is mentioned once, however often the registry moves', async () => {
    const { win } = start();
    const before = win.messages.length;
    await win.installBuild('0.2.809');
    await win.installBuild('0.2.809');
    await win.installBuild('0.2.809');
    // A notification that comes back every few seconds is worse than none at all.
    return win.messages.length - before === 1;
  });

  check('about: a window running the build that is installed says nothing on its own', async () => {
    const { win } = start();
    // The registry agrees with the stamp, which is every ordinary window.
    await win.installBuild('0.2.0');
    return win.messages.length === 0;
  });

  check('about: a build installed under its own id still notices a newer one, because the id comes from the host', async () => {
    /*
     * A development build is installed as a different extension so that it and the published
     * one are two rows in the Extensions pane rather than a version race, and the pane can
     * say which is which. Everything else about it is the published build.
     *
     * The notice below is what that could have broken, and it would have broken by going
     * quiet: the lookup is by id, a hardcoded id finds nothing under any other name, and a
     * notification that never appears looks exactly like a window that is up to date. It is
     * also the one thing standing between asking for a change and not knowing whether you
     * are looking at it, so it is worth a scenario of its own.
     *
     * The control: with the id left at the published one, this window's registry answers for
     * nothing and no notice appears. Run that way it fails, which is how the check is known
     * to be reading the id rather than passing for its own reasons.
     */
    const win = makeWindow();
    win.installedAs('sheafeditor.sheaf-dev');
    start(win);
    await win.installBuild('0.2.812');
    return win.messages.some((m) => m.includes('0.2.812') && m.includes('0.2.0'));
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

  /*
   * The changelog says it follows Keep a Changelog, where a version heading with a
   * date means that version shipped. One was written ahead of its release: forty
   * entries sat under `## [0.3.0] - 2026-09-26` while the only tag in the repository
   * was v0.1.0, so the public repository advertised a release nobody had cut, and
   * anybody reading `[Unreleased]` to see what the next one held was short by forty.
   *
   * Two readings, because neither covers the other. The tag is what makes a version
   * real, and the manifest is what the release workflow checks the tag against.
   */
  const datedHeadings = () => {
    const text = readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8');
    const found = [];
    for (const line of text.split('\n')) {
      const m = /^##\s*\[(\d+\.\d+\.\d+)\]\s*-\s*(\S+)/.exec(line);
      if (m) found.push({ version: m[1], date: m[2] });
    }
    return found;
  };

  /** -1, 0 or 1, comparing two `x.y.z` strings numerically rather than as text. */
  const compareVersions = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return 0;
  };

  check('every dated version in the changelog is a version that was tagged', () => {
    const dated = datedHeadings();
    if (!dated.length) return { ok: false, detail: 'the changelog has no dated version heading at all, so this check is measuring nothing' };
    const listed = spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/tags'], {
      cwd: path.join(here, '..'),
      encoding: 'utf8',
    });
    if (listed.status !== 0) return { ok: true, detail: 'git could not list tags here, so there is nothing to compare' };
    const tags = new Set(listed.stdout.split('\n').map((t) => t.trim()).filter(Boolean));
    // A clone with no tags cannot answer this, and saying so is better than passing
    // quietly: a check that reports the same thing when it works and when it cannot
    // run is the failure this suite has already been bitten by once.
    if (!tags.size) return { ok: true, detail: `no tags in this clone, so the ${dated.length} dated headings are unchecked` };
    /*
     * Only versions from the first tag onwards. 0.0.1 has a dated heading and no tag
     * because it went out before releases were tagged at all, and an exception list
     * for it would be the first entry in a list that eventually excuses everything.
     * The rule instead is that once this project started tagging, a dated heading
     * means a tag, which is stated rather than enumerated.
     */
    const versions = [...tags].filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
    const first = versions.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
    const inScope = dated.filter((d) => compareVersions(d.version, first) >= 0);
    const missing = inScope.filter((d) => !tags.has(`v${d.version}`)).map((d) => `${d.version} dated ${d.date}`);
    return {
      ok: missing.length === 0,
      detail: missing.length
        ? `the changelog says ${JSON.stringify(missing)} shipped and no tag of that name exists, so the entries under it belong under [Unreleased] until it does`
        : `${inScope.length} dated headings from v${first} onwards, every one tagged; ${dated.length - inScope.length} older than the first tag and out of scope`,
    };
  });

  check('the manifest is at or ahead of the newest version the changelog says shipped', () => {
    const dated = datedHeadings();
    if (!dated.length) return { ok: false, detail: 'the changelog has no dated version heading at all' };
    const newest = dated.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b));
    const version = manifest().version;
    return {
      ok: compareVersions(version, newest.version) >= 0,
      detail: compareVersions(version, newest.version) >= 0
        ? `package.json ${version} against the newest shipped ${newest.version}`
        : `package.json says ${version} and the changelog says ${newest.version} shipped, so one of them is wrong about what the last release was`,
    };
  });

  /*
   * What the `.vsix` carries, decided per top-level path rather than left to whatever
   * `.vscodeignore` happens to cover. Packaging takes minutes, so the artefact itself cannot
   * be a gate; what can be is that nothing arrived at the top of the repository without
   * somebody deciding whether it ships.
   *
   * The failure this catches is a new directory shipping silently. `.vscodeignore` excludes
   * by pattern, so a directory nobody thought about is included by default, and the only
   * place that shows is a package listing nobody reads.
   *
   * Verified against the artefact on 2026-09-27: a clean export of HEAD packages 265 files
   * and 2.68 MB, and its only top-level entries are dist/, media/, package.json, readme.md,
   * changelog.md, LICENSE.txt and the two files vsce writes itself. So this table is a record
   * of a measurement rather than of an intention.
   */
  const SHIPS = ['dist', 'media', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'];
  const STAYS = [
    '.claude', '.github', '.vscode', '.gitattributes', '.gitignore', '.gitleaksignore',
    '.vscodeignore', 'CLAUDE.md', 'CONTRIBUTING.md', 'docs', 'esbuild.mjs', 'sample',
    'scripts', 'src', 'test', 'tsconfig.json', 'tsconfig.test.json', 'package-lock.json',
  ];
  /* `vsce` drops this one itself, with `--no-dependencies`, so `.vscodeignore` never names it. */
  const DROPPED_BY_VSCE = ['package-lock.json'];

  /*
   * What the unreleased entries name has to exist. A changelog entry is written when work
   * lands and read again only when it becomes the release body and both store listings, so an
   * entry that goes false because another issue removed what it described is wrong
   * permanently rather than until somebody notices.
   *
   * That happened: an entry ended "`sheaf` in a terminal lists `.txt` files too", written
   * while a `bin` entry existed in the manifest, and the issue that correctly deleted that
   * entry left the sentence behind. A reader following it reaches an unrelated npm package.
   *
   * Three shapes, each resolved exactly. What is deliberately **not** checked is a bolded
   * in-editor name, and the reason is worth stating rather than leaving as an omission: of
   * nineteen bolded spans in the unreleased section without terminal punctuation, twelve are
   * names and five are ordinary prose fragments, and two of the twelve are abbreviations of a
   * command's title rather than the title ("Show" for "Show Front Matter"). No rule I would
   * trust separates those, and a check whose exception list grows every release is worse than
   * a narrower one that always means what it says.
   */
  /**
   * Judge one `[Unreleased]` section against what the product declares, or say there is
   * nothing there to judge.
   *
   * The distinction is the whole of this function. An empty section resolves no setting,
   * command or chord for exactly the same reason a parse broken by a stray backtick does,
   * and the first is the file's normal state for as long as it takes the next change to
   * land: stamping a version moves every accumulated line under the new heading and leaves
   * the accumulator bare. Reading that as a broken parse failed the release that had just
   * stamped it, and it would have failed every release after it, because a release is the
   * one moment the section is guaranteed to be empty.
   */
  function judgeUnreleased(notes, { settings, titles, chords }) {
    const named = { settings: [], commands: [], chords: [] };
    const missing = [];

    for (const [, token] of notes.matchAll(/`(sheaf\.[A-Za-z][A-Za-z0-9.]*)`/g)) {
      named.settings.push(token);
      if (!settings.has(token)) missing.push(`setting \`${token}\``);
    }
    for (const [, title] of notes.matchAll(/\*\*(Sheaf: [^*]+?)\*\*/g)) {
      named.commands.push(title);
      // The notes write the category with the title, as the palette shows it.
      const bare = title.replace(/^Sheaf: /, '');
      if (!titles.has(bare)) missing.push(`command **${title}**`);
    }
    /*
     * A chord anywhere inside a bold span, rather than one that is the whole of a bold span.
     *
     * The pattern was anchored to the span's edges, and a bolded lead sentence that mentions a
     * chord can never satisfy that, because Markdown has no nested bold. So the one entry shape
     * this file uses most — a bold sentence saying what a reader now gets — was unsatisfiable
     * alongside it, and the next author to name a key in one walks into the same wall. It failed
     * `main` rather than the branch that wrote it, because the entry landed in a changelog-only
     * commit and the gates were not re-run after it: the same shape as the release that failed
     * because nobody ran them after `npm version` stamped the file.
     *
     * The loose detector below is unaffected and keeps doing what its own control describes,
     * catching a chord written as prose with no bold around it at all. This only widens what
     * counts as bolded, so every chord the old pattern resolved is still resolved here.
     */
    for (const [, span] of notes.matchAll(/\*\*([^*]+?)\*\*/g)) {
      for (const [, chord] of span.matchAll(/\b((?:Cmd|Ctrl|Alt|Shift|Opt)(?:\+[A-Za-z0-9]+)+)/g)) {
        named.chords.push(chord);
        if (!chords.has(chord.toLowerCase().replace(/opt/g, 'alt'))) missing.push(`chord **${chord}**`);
      }
    }

    const found = named.settings.length + named.commands.length + named.chords.length;
    const written = notes.split('\n').filter((l) => l.trim()).length;

    // Nothing written, so nothing to resolve. Said out loud rather than passed quietly.
    if (!written) return { ok: true, detail: '[Unreleased] is empty, which is what it holds from a release until the next change lands' };

    /*
     * Three states here rather than two, and the third is why this is not simply `!found`.
     *
     * **"Resolved nothing" and "nothing to resolve" are different facts.** A release note
     * about layout names no setting, no command and no chord, and there is nothing wrong with
     * it: the note that caught this was a table staying in the writing column instead of
     * running to the edge of the pane. Failing that is a guard refusing a correct entry, and
     * the only way past it is to write an identifier into the changelog for the checker's
     * sake, which is worse than not checking.
     *
     * A note that *mentions* one and fails to resolve it is the parse break this exists for,
     * where a stray backtick turns `sheaf.foo` into prose the matcher slides past.
     *
     * So the discriminator is whether anything identifier-shaped is in the text at all, looked
     * for loosely and outside the strict patterns above. Loose on purpose: what it is hunting
     * is the near miss, the shape the strict pattern was meant to catch and did not.
     *
     * This is the same mistake as the empty-section one directly above, one step along, and
     * both were mine: an empty section and a section with no identifiers both resolve nothing,
     * and neither is a broken parse. Collapsing the first pair failed a tagged release build.
     * Collapsing this pair failed the first ordinary bug-fix note written after that.
     */
    const mentions = /sheaf\.[A-Za-z]|Sheaf:\s|\b(?:Cmd|Ctrl|Alt|Shift|Opt)\+[A-Za-z0-9]/.test(notes);
    if (!found && mentions) {
      return {
        ok: false,
        detail: `read ${written} written lines of [Unreleased] that mention something setting-, command- or chord-shaped and resolved none of it, so a pattern slid past what it was meant to catch and this proved nothing`,
      };
    }
    if (!found) {
      return {
        ok: true,
        detail: `${written} written lines naming no setting, command or chord, and nothing identifier-shaped in them for the patterns to have missed`,
      };
    }

    return {
      ok: missing.length === 0,
      detail: missing.length
        ? `the unreleased notes name ${JSON.stringify(missing)}, which neither the manifest nor the editor's shortcut registry declares; the notes become the release body and both store listings, so this is wrong permanently once tagged`
        : `${named.settings.length} settings, ${named.commands.length} commands, ${named.chords.length} chords, all declared`,
    };
  }

  check('every setting, command and chord the unreleased notes name exists', () => {
    const text = readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8');
    const section = /## \[Unreleased\]\n([\s\S]*?)\n## \[/.exec(text);
    if (!section) return { ok: false, detail: 'no [Unreleased] section found, so nothing was read' };
    const notes = section[1];

    const m = manifest().contributes;
    const settings = new Set(Object.keys(m.configuration?.properties ?? {}));
    const titles = new Set((m.commands ?? []).map((c) => c.title));
    const chords = new Set(
      (m.keybindings ?? []).flatMap((k) => [k.key, k.mac].filter(Boolean).map((s) => s.toLowerCase()))
    );

    /*
     * Most of Sheaf's shortcuts are the editor's rather than the workbench's, so they are
     * declared in the webview's own registry and appear in no manifest. Reading only the
     * manifest made this check wrong for the majority of them, which does not make the
     * notes wrong: it made naming a real shortcut in bold the thing that failed.
     */
    const registry = readFileSync(path.join(here, '..', 'src', 'webview', 'shortcuts.ts'), 'utf8');
    const specs = [...registry.matchAll(/\bkey: '([^']+)'/g)].map(([, spec]) => spec);
    if (!specs.length) return { ok: false, detail: 'read no key specs from src/webview/shortcuts.ts, so the editor half of this proved nothing' };
    for (const spec of specs) {
      const parts = spec.split('-').map((p) => p.toLowerCase());
      for (const mod of ['cmd', 'ctrl']) chords.add(parts.map((p) => (p === 'mod' ? mod : p)).join('+'));
    }

    return judgeUnreleased(notes, { settings, titles, chords });
  });

  /*
   * CONTROL for the check above, because the check itself passes on an empty section now and
   * an empty section is what it will read for most of a release cycle. Without this, a change
   * that made it pass on everything would look identical from the outside.
   *
   * The release it was written from is the first case: a section holding one blank line, which
   * the guard read as a parse failure and failed the tagged build on.
   */
  check('CONTROL: an empty or identifier-free [Unreleased] passes, a missed pattern fails, and a wrong name still fails', () => {
    const declared = { settings: new Set(['sheaf.lineNumbers']), titles: new Set(['Open Raw Markdown']), chords: new Set(['cmd+b']) };
    const cases = {
      empty: judgeUnreleased('\n', declared),
      blanksOnly: judgeUnreleased('\n   \n\n', declared),
      /*
       * A note naming nothing, which is an ordinary bug-fix entry and passes. This case
       * expected a failure until 2026-09-30, and that was wrong: the first real note written
       * against it was a table staying in the writing column, which names no setting, no
       * command and no chord, and the guard refused it.
       */
      namesNothing: judgeUnreleased('\n### Fixed\n\n- A table drawn under a list item sits under the item.\n', declared),
      /*
       * And the parse break the guard is actually for, in its three shapes: a setting whose
       * backticks were lost, a command title that was not bolded, a chord written as prose.
       * Each mentions something the strict patterns should have caught and did not.
       */
      settingUnticked: judgeUnreleased('\n- sheaf.lineNumbers is off by default now.\n', declared),
      commandUnbolded: judgeUnreleased('\n- Sheaf: Open Raw Markdown is on the toolbar.\n', declared),
      chordUnbolded: judgeUnreleased('\n- Cmd+B still bolds the selection.\n', declared),
      allDeclared: judgeUnreleased('\n- `sheaf.lineNumbers` is off by default, and **Cmd+B** still bolds.\n', declared),
      undeclared: judgeUnreleased('\n- `sheaf.notAThing` was added, and **Sheaf: Nowhere** opens it.\n', declared),
      /*
       * The shape this file actually writes, and the gap that let a red `main` through.
       *
       * Every case above puts a chord on its own between the asterisks, and the pattern was
       * anchored to them, so a bolded lead sentence mentioning a chord was unsatisfiable and
       * nothing here said so. Markdown has no nested bold, so there was no way to write the
       * entry correctly either. So `chordInBoldSentence` is the discriminating one: reverting
       * the widening turns it false and fails this control.
       *
       * `undeclaredInBoldSentence` answers false both ways, by the loose detector before and by
       * the chord lookup after, and is here for the opposite risk. It is what would fail if the
       * widening were ever loosened into resolving whatever it found, which is the way this
       * check could be turned off while still reporting that it ran.
       */
      chordInBoldSentence: judgeUnreleased('\n- **Pressing Cmd+B bolds what you have selected.** And it did not before.\n', declared),
      undeclaredInBoldSentence: judgeUnreleased('\n- **Pressing Cmd+Shift+J does nothing at all.** Which is the point.\n', declared),
    };
    const want = {
      empty: true,
      blanksOnly: true,
      namesNothing: true,
      settingUnticked: false,
      commandUnbolded: false,
      chordUnbolded: false,
      allDeclared: true,
      undeclared: false,
      chordInBoldSentence: true,
      undeclaredInBoldSentence: false,
    };
    const wrong = Object.keys(want).filter((k) => cases[k].ok !== want[k]);
    return {
      ok: wrong.length === 0,
      detail: wrong.length
        ? `${JSON.stringify(wrong)} judged the wrong way: ${wrong.map((k) => `${k} → ${cases[k].ok} (${cases[k].detail})`).join('; ')}`
        : 'empty, blank-only and identifier-free sections pass; a setting, command or chord the patterns missed fails; an undeclared name still fails',
    };
  });

  check('every path at the top of the repository is decided: it ships, or it is excluded', () => {
    /*
     * The index and the untracked-but-not-ignored files, rather than `ls-tree HEAD`. HEAD is
     * the previous commit, so reading it would let a new directory pass its own landing and
     * only fail the run after, which is a commit too late to be useful. A control of mine did
     * exactly that: a new directory was invisible to the check and read as the check not
     * working.
     */
    const repo = path.join(here, '..');
    const ask = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const inIndex = ask(['ls-files']);
    const untracked = ask(['ls-files', '--others', '--exclude-standard']);
    if (inIndex.status !== 0) return { ok: false, detail: 'git could not list the index, so nothing was checked' };
    const tops = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => p.split('/')[0]);
    const tracked = [...new Set([...tops(inIndex.stdout), ...tops(untracked.status === 0 ? untracked.stdout : '')])];
    if (tracked.length < 10) return { ok: false, detail: `git listed only ${tracked.length} paths, which is not this repository` };

    const undecided = tracked.filter((p) => !SHIPS.includes(p) && !STAYS.includes(p));
    if (undecided.length) {
      return {
        ok: false,
        detail: `${JSON.stringify(undecided)} is at the top of the repository and nothing here says whether it belongs in the .vsix. Add it to SHIPS or to STAYS, and if it stays, exclude it in .vscodeignore.`,
      };
    }

    /*
     * And the exclusions are real rather than recorded. A `.vscodeignore` line removed while
     * the entry stays on the list above would ship a directory with this check still green,
     * which is the same shape as a ledger describing a matrix that no longer exists.
     */
    const ignore = readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const excluded = (name) =>
      DROPPED_BY_VSCE.includes(name) ||
      ignore.some((line) => {
        // The four shapes `.vscodeignore` actually uses: the bare name, a directory, an
        // extension anywhere, and a filename anywhere. Deliberately not a glob engine: a
        // pattern this cannot read is one to add here rather than one to approximate.
        if (line === name || line === `${name}/**` || line === `${name}/` || line === `**/${name}`) return true;
        const ext = /^(?:\*\*\/)?\*(\.[A-Za-z0-9]+)$/.exec(line);
        return Boolean(ext) && name.endsWith(ext[1]);
      });
    const leaking = STAYS.filter((name) => tracked.includes(name) && !excluded(name));
    return {
      ok: leaking.length === 0,
      detail: leaking.length
        ? `${JSON.stringify(leaking)} is listed here as not shipping and .vscodeignore does not exclude it, so it is in the .vsix`
        : `${SHIPS.length} ship, ${STAYS.length} excluded, ${tracked.length} tracked at the top`,
    };
  });

  check('only one shipping page mentions a `sheaf` command, and it is the one that says there is none', () => {
    /*
     * Installing the extension puts nothing on anybody's path, and `sheaf` on npm is an
     * unrelated package, so a reader who follows a promise of that command reaches a
     * stranger's code. `docs/features/in-a-browser.md` says exactly that, and two changelog
     * entries said the opposite, one of them in a section that had already shipped and is
     * on the Marketplace listing today.
     *
     * So the rule is one statement in one place. The denial is the statement; anywhere else
     * mentioning the command is a second answer to a question that has one. The paired check
     * above asserts the manifest declares no `bin`, which is the same claim from the other
     * side: this one is about what a reader is told, that one about what the package says.
     *
     * The browser host is reached as `node <extension dir>/dist/serve.js <folder>`, which is
     * a developer's invocation and belongs on that page rather than in release notes.
     */
    const answersIt = path.join('docs', 'features', 'in-a-browser.md');
    const prose = ['CHANGELOG.md', 'README.md', 'CONTRIBUTING.md'];
    const docsDir = path.join(here, '..', 'docs');
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []
      );
    for (const page of walk(docsDir)) prose.push(path.relative(path.join(here, '..'), page));

    const said = [];
    for (const rel of prose) {
      let text;
      try {
        text = readFileSync(path.join(here, '..', rel), 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (!/`sheaf`/.test(line)) return;
        if (rel === answersIt) return;
        said.push(`${rel}:${i + 1}`);
      });
    }
    // The denial has to be there, or this check passes by the page having been deleted.
    const denial = readFileSync(path.join(here, '..', answersIt), 'utf8');
    if (!/`sheaf`/.test(denial) || !/no `sheaf` command/.test(denial)) {
      return { ok: false, detail: `${answersIt} no longer says there is no \`sheaf\` command, so nothing tells a reader the npm package is somebody else's` };
    }
    return {
      ok: said.length === 0,
      detail: said.length
        ? `${JSON.stringify(said)} mention a \`sheaf\` command, which nothing provides; ${answersIt} is where that question is answered`
        : `${prose.length} shipping pages checked; only ${answersIt} mentions it`,
    };
  });

  check('the manifest claims no command on anybody\'s path, which is what the docs promise', () => {
    /*
     * `package.json` declared `"bin": { "sheaf": "./dist/serve.js" }`. VS Code ignores
     * `bin`, so it put nothing on anybody's path, and `docs/features/in-a-browser.md`
     * tells a reader in as many words that there is no `sheaf` command and that the
     * `sheaf` package on npm belongs to somebody else and should not be installed
     * expecting this one. So the manifest and the page disagreed, in a public
     * repository, about a name that resolves to a stranger's code.
     *
     * `dist/serve.js` stays: it ships, it has a working shebang, and the check scripts
     * run it directly. It is the mapping that claimed a name, not the file.
     *
     * If a CLI is ever published it goes out under a name the organisation owns, and
     * this check is the place that will say so when somebody adds the entry back.
     */
    const bin = manifest().bin;
    if (!bin) return { ok: true, detail: 'no bin entry' };
    const names = Object.keys(bin);
    return {
      ok: false,
      detail: `package.json maps ${JSON.stringify(names)} onto a path, which VS Code ignores and which claims an npm name; the browser host is reached as "node <extension dir>/dist/serve.js <folder>"`,
    };
  });

  check('the files both hosts share reach neither vscode nor node, so the browser can load them', () => {
    /*
     * `src/protocol.ts` and `src/settingValues.ts` exist so that one fact is declared once and
     * read by the extension host, the browser host and the editor. What makes that possible is
     * that the browser bundles them, so the moment either reaches `vscode` or a Node builtin it
     * stops being importable out there and the fact goes back to being declared twice. That is
     * what was behind the line-numbers button in a browser tab turning them on and never off:
     * three declarations of `EditorConfig`, one per host and one in the editor, with nothing
     * comparing them, so a host could carry a setting the editor drew a button for.
     *
     * The rule was written as "imports nothing from this repository" and the correct code breaks
     * it: `protocol.ts` imports `settingValues.ts`, which is right, because the alternative is
     * copying the setting value spaces into it. So the rule is about what the closure may
     * **reach**, not about whether a file has imports, and it is stated that way here because
     * the prose version was wrong on its first real use.
     *
     * Transitive on purpose. A leaf importing a leaf is fine; a leaf importing a leaf that
     * imports `vscode` is the same failure two steps away, and two steps is where nobody looks.
     */
    const SHARED = ['src/protocol.ts', 'src/settingValues.ts'];
    const root = path.join(here, '..');
    const seen = new Set();
    const reached = [];
    const walk = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      let text;
      try {
        text = readFileSync(path.join(root, rel), 'utf8');
      } catch {
        reached.push(`${rel} does not exist`);
        return;
      }
      for (const [, spec] of text.matchAll(/from\s+'([^']+)'/g)) {
        if (spec === 'vscode' || spec.startsWith('vscode/')) {
          reached.push(`${rel} imports ${spec}`);
          continue;
        }
        if (spec.startsWith('node:')) {
          reached.push(`${rel} imports ${spec}`);
          continue;
        }
        if (!spec.startsWith('.')) continue; // a package, which the browser bundles too
        const next = path.relative(root, path.resolve(path.dirname(path.join(root, rel)), spec));
        walk(next.endsWith('.ts') ? next : `${next}.ts`);
      }
    };
    for (const f of SHARED) walk(f);
    // A walk that read nothing would pass while proving nothing, which is the failure this
    // suite has met four times in a week.
    if (seen.size < SHARED.length) {
      return { ok: false, detail: `the walk read ${seen.size} files from ${SHARED.length} roots, so it found none of them` };
    }
    return {
      ok: reached.length === 0,
      detail: reached.length
        ? `${JSON.stringify(reached)}, so the browser host can no longer import it and the fact it holds goes back to being declared twice`
        : `${seen.size} files in the closure of ${SHARED.join(' and ')}, none reaching vscode or node`,
    };
  });

  check('security: every action a workflow runs is pinned to a commit, not to a tag', () => {
    /*
     * `release.yml` reaches every machine that has Sheaf: it holds `id-token: write`,
     * `contents: write` and `attestations: write`, and it publishes to both registries.
     * Every action it runs executes with those permissions.
     *
     * A tag is mutable. `actions/checkout@v7` is whatever the owner of that repository
     * last pointed `v7` at, and nothing here would notice it moving. Pinning to a commit
     * means an upstream account compromise cannot reach this pipeline without somebody
     * changing a line in this repository.
     *
     * The version stays as a trailing comment, because a bare 40-character hash tells a
     * reader nothing about what it is or whether it is current, and the thing that makes
     * pinning rot is nobody being able to tell.
     */
    const dir = path.join(here, '..', '.github', 'workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const uses = [];
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (m) uses.push({ file, line: i + 1, ref: m[1], rest: m[2] });
      }
    }
    // A parse that found almost nothing would agree with anything.
    if (uses.length < 5) {
      return { ok: false, detail: `${uses.length} action references found across ${files.length} workflow files, so this check is reading the wrong thing` };
    }
    const wrong = [];
    for (const u of uses) {
      // A local action, `./path`, is this repository's own and needs no pin.
      if (u.ref.startsWith('./')) continue;
      const at = u.ref.lastIndexOf('@');
      const rev = at < 0 ? '' : u.ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(rev)) {
        wrong.push(`${u.file}:${u.line} runs ${u.ref}, which is a tag or a branch and can be moved by whoever owns it`);
      } else if (!/#\s*\S/.test(u.rest)) {
        wrong.push(`${u.file}:${u.line} is pinned but says no version, so nobody can tell what it is or whether it is current`);
      }
    }
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('security: CI runs read-only and the release workflow runs alone', () => {
    /*
     * `release.yml` is the one thing here that reaches other people's machines. It holds
     * `id-token: write`, `contents: write` and `attestations: write`, it reaches both
     * publish tokens through the `release` environment, and what it builds installs for
     * everyone who has Sheaf.
     *
     * Two things it can be held to here. `ci.yml` declares read-only permissions, because
     * without a `permissions:` block a job inherits the repository default and hands that
     * token to every step, `npm ci` and its three hundred packages included. And the
     * release workflow has a concurrency group, so two tags pushed close together queue
     * instead of publishing twice.
     *
     * Read as text rather than parsed, so this needs no YAML package to keep working.
     */
    const dir = path.join(here, '..', '.github', 'workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
    if (files.length < 2) return { ok: false, detail: `${files.length} workflow files found, so this check is looking in the wrong place` };
    const ci = readFileSync(path.join(dir, 'ci.yml'), 'utf8');
    const release = readFileSync(path.join(dir, 'release.yml'), 'utf8');
    const wrong = [];
    if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(ci)) wrong.push('ci.yml does not declare read-only permissions, so its token is whatever the repository default is');
    if (!/^concurrency:\s*\n\s+group:/m.test(release)) wrong.push('release.yml has no concurrency group, so two tags can publish at once');
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('security: the webview policy keeps a document from running script or sending anything anywhere', async () => {
    /*
     * The content security policy is the boundary. A Markdown document can put almost
     * anything on the page: inline HTML that Sheaf renders, an image address, a cell of a
     * table drawn as HTML. What stops any of it from running as code, or from carrying
     * what it read back out, is this one string in `getHtml`, and until now nothing asked
     * what it said. Widening it is a one-word edit that every gate would have passed.
     *
     * Four properties, each for a different way out:
     *
     * `default-src 'none'` is the floor, so a directive nobody thought to write is closed
     * rather than open. **No `connect-src`** then matters as much as anything present: it
     * falls back to the floor, so the editor cannot fetch, post or open a socket at all.
     * That is what makes "no server, no account, no cloud copy" a property of the page
     * rather than an intention, and a `connect-src` appearing here would end it quietly.
     *
     * `script-src` carries a nonce and nothing else. `'unsafe-inline'` there would let an
     * inline handler in a document's own HTML run; `'unsafe-eval'` would let a string
     * become code; a host or scheme would let a remote file become code.
     *
     * `img-src` is the one that cannot be closed, because documents legitimately show
     * pictures, so it is held to what the code already permits: this webview's own
     * source, `https:` and `data:`. A `*` or an `http:` here is a downgrade rather than a
     * hole, and an `http:` image in a document the editor serves over `https:` is a mixed-content
     * mismatch besides.
     */
    const { panel } = await openInSheaf();
    const html = panel.webview.html;
    const csp = /content="([^"]*)"/.exec(/<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)?.[0] ?? '')?.[1];
    if (!csp) return { ok: false, detail: `no Content-Security-Policy meta tag in the ${html.length}-character page: this check is proving nothing` };
    const directive = (name) => new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`).exec(csp)?.[1]?.trim();
    const script = directive('script-src') ?? '';
    const img = directive('img-src') ?? '';
    const wrong = [];
    if (directive('default-src') !== `'none'`) wrong.push(`default-src is "${directive('default-src')}" rather than 'none', so a directive nobody wrote is open`);
    if (directive('connect-src') !== undefined) wrong.push(`connect-src is present ("${directive('connect-src')}"), so the editor can reach the network; with none it inherits 'none' and cannot`);
    if (!/^'nonce-[^']+'$/.test(script)) wrong.push(`script-src is "${script}" rather than a nonce alone`);
    for (const bad of [`'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, 'http:', '*']) {
      if (img.includes(bad)) wrong.push(`img-src allows ${bad}`);
    }
    if (!img.includes('https:') || !img.includes('data:')) wrong.push(`img-src is "${img}", which no longer covers the addresses images are written with`);
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('shape: no widget builds its DOM in a closure bigger than it already is', () => {
    /*
     * Ten widget classes draw the editor's blocks, and eight of them keep `toDOM` between
     * 6 and 43 lines by doing the work in functions at module scope, which a suite can
     * call directly. Two went the other way, and the sizes say the rest of the story:
     *
     *     tables.ts      3274        images.ts        43
     *     viewBlock.ts    780        mermaid.ts       39
     *                               livePreview.ts     6
     *                               maths.ts           6
     *
     * A closure that size is an object written as a function. `tables.ts` holds 203 local
     * declarations and 153 nested functions in there, registering 35 listeners over 18
     * event types, and nothing outside the method can reach any of it, so the only way to
     * exercise one of those functions is to mount the widget and drive the DOM. That is
     * why a table fix is expensive to verify, and tables are about half of every bug
     * filed on this project.
     *
     * The eight small ones are the argument that this is a choice rather than the nature
     * of a widget. So the two large ones are held where they are: the closure may shrink
     * and may not grow, and a new widget starts with no budget at all here, which is the
     * point at which it is cheapest to not do this.
     *
     * Each budget is exact, so it fails in both directions. Over it is the growth this is
     * for. Under it matters too, because a passing check prints nothing: this runner
     * reports a name only when it fails, so "lower the budget" in the detail of a pass is
     * a sentence nobody reads, and the number would drift above the real size until it
     * held nothing.
     */
    const BUDGETS = [
      // 3266: the first drag on a table freezes every column, and the call that does it is one
      // line. The decision itself is `frozenWidths` at module scope, which is what this check
      // asks for; what is left in the closure is the call and nothing else.
      //
      // 3267: whether a grid may wrap its cells to stay in the writing column, which a pipe table
      // may and a data block may not. Same shape as the line above it: `wrapsToFit` is at module
      // scope and takes its input explicitly, and the closure carries the call. Raised by one
      // deliberately rather than worked around, because the alternative was reading the answer off
      // the frame's `is-csv` class, and a layout rule decided from a CSS class is policy in a
      // transport, where no test can see it.
      //
      // 3266: and back down, the same day. `gridToTSV` moved out of the closure to module scope so
      // a test could reach it, which paid back the line `wrapsToFit` borrowed. This is the ratchet
      // working: it caught the closure shrinking and refused to let the number drift above the real
      // size, which is the half of it that a passing run would never have mentioned.
      //
      // 3271: a double-click on a column's divider fits that column to its content, which the grip's
      // `dblclick` listener used to swallow. Five lines of listener, and both decisions are at module
      // scope taking their inputs explicitly: `widthsFittedToContent` works out the pins, and
      // `columnsToFit` works out which columns a gesture acts on.
      //
      // Raised from 3266 in two steps rather than one, and the first attempt is the useful part. The
      // decision started inside the closure, 58 lines of it with the reasoning in comments, and this
      // check refused it and said where to put it. Moving the arithmetic out took it to 3282, moving
      // the selection out to 3278, and the comments to module scope to 3271. So the budget did not
      // only measure the growth, it drove the shape: what is left in the closure is a listener that
      // calls two functions and stores the answer.
      // 3292: a double-click on a row's divider fits that row to its content, which is the other axis of
      // the gesture at 3271 and almost none of the same work. The column half had a grip to listen on and
      // a width already measured; the row half had no target at all, and the thing it changes is a clamp
      // released rather than a number pinned.
      //
      // Twenty-one lines, all of them wiring: `fitKey`, one `wireRowDivider` call with four hooks, and
      // one line each for the clamp predicate, the fittable-row marking, the press guard and the read at
      // render. Five decisions are at module scope taking their inputs explicitly: `dividerUnder` says
      // which row's boundary a pointer is on, `fittedRowsIn` and `toggleFittedRow` hold the per-table
      // set, `markFittableRows` says which rows have anything to fit, and `cellWantsClamp` says whether a
      // cell is drawn clamped.
      //
      // This check earned its keep twice over on the way. It refused the first version at 3391 and the
      // second at 3328, and each refusal named a function to extract rather than a line to delete. Two
      // other checks shaped the same work: a row-number cell must have zero element children, which is
      // why the divider is a pseudo-element read by coordinate instead of a `<span>`; and dragging rows
      // through a 3,000-row table must repaint only where the drop line moved, which is why the hover
      // does nothing during a drag and writes only when the marked cell changes.
      //
      // 3294: and two more, for the rule that any reordering of a table's rows ends every fitting in it.
      // One call in `sortRows` and one in `moveRowsTo`, which are the two places row order changes; the
      // rule itself and why it is the rule are in `endFittingIn` at module scope. A column operation
      // adds nothing here, because columns do not change which row is which.
      //
      // 3295: and one more, for the line that remembers which key a table's fitted rows are under.
      // They were keyed by `tableWidthKey`, which is a column identity, so inserting or deleting a column
      // stranded the set under the old key and the fittings silently ended. `fittedKeyFollow` at module
      // scope migrates them; the closure keeps the `let` that holds where they currently are.
      //
      // 3297: and two more, for the table menu drawing the axis keys it had been computing and throwing
      // away. One line names the label's span so the label can be read apart from a row that also holds
      // an icon and now a hint, and one calls the drawer. Both are wiring: `menuActions` already decided
      // whether the keys apply to what is picked, and `drawMenuShortcut` at module scope holds the rule
      // that the hint is `aria-hidden` while the row carries `aria-keyshortcuts`. This check refused the
      // first version at 3322, which was the same code with its reasoning inside the closure, and moving
      // the explanation to the function it explains is what the refusal was asking for.
      //
      // 3299: and two more at the end of a column drag, one comment and one `columns.remeasure()`.
      // A table that crosses the pane threshold mid-gesture must not move under the pointer, so
      // `is-pane-wide` is frozen while a drag is in flight; removing `is-resizing` ends the freeze and
      // something has to recompute what was frozen, or the table keeps the class it started with until
      // an unrelated measure happens. The decision is in `columnLayout.ts`, where the class is chosen;
      // what is here is the one call that says the gesture is over, which cannot live anywhere else.
      // 3302: and three more, for which cell a typed character goes into. Clearing a selection and
      // pasting over one both already ask whether a column was picked whole, and typing was the third
      // input to the same selection and the only one that did not: both gestures that pick a column
      // whole leave the focus on the header, so typing renamed the column and changed none of the cells
      // underneath it. The rule is `pasteStartRow` at module scope, which the paste path already calls
      // and whose comment now carries all three inputs; here is one call, one line that moves the focus
      // into the body, and one line pointing at the function. Refused at 3319 first, which was the same
      // code with its reasoning in the closure — the same refusal the 3297 entry records, and the same
      // answer: the explanation belongs beside the rule it explains.
      ['tables.ts', 3302],
      ['viewBlock.ts', 780],
    ];
    const over = [];
    const under = [];
    const lost = [];
    for (const [file, budget] of BUDGETS) {
      const lines = readFileSync(path.join(here, '..', 'src', 'webview', file), 'utf8').split('\n');
      const start = lines.findIndex((line) => /^ {2}toDOM\(/.test(line));
      const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && line === '  }');
      // A rename or a reformat must fail loudly rather than pass by finding nothing.
      if (start === -1 || end === -1) {
        lost.push(file);
        continue;
      }
      const span = end - start + 1;
      if (span > budget) over.push(`${file}'s toDOM is ${span} lines, over its ${budget}-line budget`);
      else if (span < budget) under.push(`${file}'s toDOM is ${span} lines, ${budget - span} under budget, which is good: change its entry here to ${span}`);
    }
    return {
      ok: over.length === 0 && under.length === 0 && lost.length === 0,
      detail: lost.length
        ? `no \`  toDOM(\` and closing \`  }\` in ${lost.join(', ')}: this check lost its anchor and is proving nothing`
        : over.length
          ? `${over.join('; ')}. Put the decision it adds at module scope as a function taking its inputs explicitly, the way the eight small widgets do, and leave only the DOM wiring in the closure.`
          : under.length
            ? under.join('; ')
            : '',
    };
  });

  const withoutComments = (text) => text.replace(/\/\*[^]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  /**
   * The messages a `type X =` union declares, each with its field names. Fields are read
   * at the variant's own level only, so `terminal` inside `capabilities: { terminal?: … }`
   * is not mistaken for a message field.
   */
  const messagesIn = (source, name) => {
    const text = withoutComments(source);
    const start = text.search(new RegExp(`\\btype ${name} =`));
    if (start < 0) return null;
    let depth = 0;
    let end = text.length;
    for (let i = text.indexOf('=', start); i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      else if (text[i] === ';' && depth === 0) {
        end = i;
        break;
      }
    }
    const body = text.slice(start, end);
    const out = new Map();
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '{') continue;
      let d = 1;
      let j = i + 1;
      const fields = new Set();
      let type = null;
      for (; j < body.length && d > 0; j++) {
        if (body[j] === '{') d++;
        else if (body[j] === '}') d--;
        else if (d === 1) {
          const rest = body.slice(j);
          const m = /^(\w+)(\??):/.exec(rest);
          if (m && /[\s{;]/.test(body[j - 1] ?? '{')) {
            if (m[1] === 'type') {
              const value = /^type\??:\s*'([^']+)'/.exec(rest);
              if (value) type = value[1];
            } else fields.add(m[1] + m[2]);
          }
        }
      }
      if (type) out.set(type, fields);
      i = j - 1;
    }
    return out;
  };

  check('shape: every setting the host sends is one the editor page reads, and neither side is alone', () => {
    /*
     * `EditorConfig` is still declared twice: once in `src/protocol.ts`, which every host
     * reads, and once in `webview/main.ts` for what the page accepts. The protocol check
     * above compares the messages, and `config` is one field of `init`, so what is inside
     * it is not held by that check at all. This is the inside.
     *
     * The page's copy is the one left to remove. It stays for now because it is not this
     * check's job to remove it, and while it stays this is what holds the two together.
     *
     * Both directions, and no exception, which is why `autoSave` no longer lives in the
     * host's copy: it is read by the host when it decides to save and the page has no use
     * for it, and a field in the page's config that the page never reads is one nobody can
     * tell is unread. The folder server proved it was not needed by never sending it.
     *
     * Optionality is held one way. A field the host may omit and the page requires is a
     * bug; the reverse is fine, since a page may tolerate more than one host sends.
     */
    const read = (...parts) => readFileSync(path.join(here, '..', ...parts), 'utf8');
    const fieldsOf = (source, declaration) => {
      const text = withoutComments(source);
      const at = text.indexOf(declaration);
      if (at < 0) return null;
      const body = text.slice(at + declaration.length, text.indexOf('\n}\n', at));
      const out = new Map();
      for (const m of body.matchAll(/^\s{2}(\w+)(\??):/gm)) out.set(m[1], m[2] === '?');
      return out;
    };
    const host = fieldsOf(read('src', 'protocol.ts'), 'interface EditorConfig {');
    const page = fieldsOf(read('src', 'webview', 'main.ts'), 'interface EditorConfig {');
    for (const [side, parsed] of [
      ['the host', host],
      ['the page', page],
    ]) {
      if (!parsed || !parsed.has('contentWidth')) {
        return { ok: false, detail: `${side}'s EditorConfig parsed ${parsed ? parsed.size : 0} fields and contentWidth is not among them, so this check is reading the wrong thing` };
      }
    }
    const wrong = [];
    for (const [name, optional] of host) {
      if (!page.has(name)) {
        wrong.push(`the host sends ${name} and the editor page reads no such setting`);
      } else if (optional && !page.get(name)) {
        wrong.push(`the host may omit ${name} and the page requires it`);
      }
    }
    for (const name of page.keys()) {
      if (!host.has(name)) wrong.push(`the editor page reads ${name} and the VS Code host never sends it`);
    }
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('shape: every message the page can send is one the host answers, and the host answers no other', () => {
    /*
     * `FromWebview` is declared once, in `src/protocol.ts`, so no two sides can disagree
     * about its shape.
     * What they can disagree about is whether a message is acted on: a variant with no
     * `case` in the provider's switch is accepted, matched by the type, and dropped. The
     * other direction matters as much, because a `case` for a message the union does not
     * declare is a handler nothing can ever reach.
     */
    const source = readFileSync(path.join(here, '..', 'src', 'markdownEditorProvider.ts'), 'utf8');
    const declared = messagesIn(readFileSync(path.join(here, '..', 'src', 'protocol.ts'), 'utf8'), 'FromWebview');
    if (!declared || !declared.has('edit')) {
      return { ok: false, detail: `the FromWebview union parsed ${declared ? declared.size : 0} messages, so this check is reading the wrong thing` };
    }
    const at = source.indexOf('onDidReceiveMessage');
    if (at < 0) return { ok: false, detail: 'no onDidReceiveMessage in the provider, so there is no switch to read' };
    const handled = new Set([...withoutComments(source.slice(at)).matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));
    const ignored = [...declared.keys()].filter((name) => !handled.has(name));
    const unreachable = [...handled].filter((name) => !declared.has(name));
    const wrong = [];
    if (ignored.length) wrong.push(`the page can send ${ignored.join(', ')} and the host has no case for ${ignored.length > 1 ? 'them' : 'it'}`);
    if (unreachable.length) wrong.push(`the host has a case for ${unreachable.join(', ')} and the page can send no such message`);
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('shape: every message the host can send is one the editor page declares, field for field', () => {
    /*
     * `ToWebview` is declared in `src/protocol.ts` for what a host sends, and again in
     * `webview/main.ts` for what the page accepts.
     *
     * The reasoning here used to be that one declaration was impossible, because sharing it
     * would mean the page importing from host code and the boundary check exists to stop
     * that. That was wrong, and `src/protocol.ts` is the counter-example: a leaf that
     * imports nothing is below all three hosts rather than inside one of them, so everybody
     * can read it and no arrow points the wrong way. The page's copy is simply the one not
     * yet removed, and until it is, this holds the two together.
     *
     * The rule is not symmetry. The page may accept a message field no VS Code host sends,
     * because the folder server is a host too: `init.capabilities` is exactly that. What
     * must not happen is the host sending a message, or a field, the page does not declare,
     * because the page would ignore it in silence.
     */
    const read = (...parts) => readFileSync(path.join(here, '..', ...parts), 'utf8');
    const host = messagesIn(read('src', 'protocol.ts'), 'ToWebview');
    const page = messagesIn(read('src', 'webview', 'main.ts'), 'ToWebview');
    // A parse that quietly found nothing would agree with anything, so it has to say so.
    for (const [side, parsed] of [
      ['the host', host],
      ['the page', page],
    ]) {
      if (!parsed) return { ok: false, detail: `no ToWebview union found for ${side}, so this check is reading the wrong thing` };
      for (const always of ['init', 'setContent']) {
        if (!parsed.has(always)) {
          return { ok: false, detail: `${side}'s union parsed ${parsed.size} messages and ${always} is not among them, so the parse is wrong` };
        }
      }
    }
    const wrong = [];
    for (const [name, fields] of host) {
      const theirs = page.get(name);
      if (!theirs) {
        wrong.push(`the host sends ${name} and the page declares no such message`);
        continue;
      }
      const missing = [...fields].filter((f) => !theirs.has(f));
      if (missing.length) wrong.push(`the host sends ${name} with ${missing.join(', ')} and the page does not declare ${missing.length > 1 ? 'those' : 'that'}`);
    }
    for (const name of page.keys()) {
      if (!host.has(name)) wrong.push(`the page declares ${name} and the host's union has no such message`);
    }
    return { ok: wrong.length === 0, detail: wrong.join('; ') };
  });

  check('shape: VS Code sends every message the wire declares, because it is the host with nothing to degrade', () => {
    /*
     * The browser host carries a record of what it sends, message by message, and a check
     * beside it that the record and the code agree. VS Code has no such record and should
     * not need one: it is the host every other host is a reduction of, so the honest
     * statement about it is that it sends all of them. Nothing said so, and nothing
     * compared it to anything.
     *
     * What that leaves open is the mirror of the defect the other record was built for. A
     * message added to `ToWebview` that only a browser tab ever sends is a feature missing
     * from VS Code, silently, with the editor drawing whatever reads it in both places.
     * The browser side of that is now a compile error; this side was not even a claim.
     *
     * Absolute rather than a list with exceptions. If a message genuinely belongs to one
     * host only, this fails and somebody has to say so out loud and decide whether the
     * difference belongs in the editor at all, which is the conversation `CLAUDE.md` asks
     * for when a host starts differing. An exception list would let it be settled by
     * whoever added the message, on their own.
     */
    const read = (...parts) => readFileSync(path.join(here, '..', ...parts), 'utf8');
    const declared = messagesIn(read('src', 'protocol.ts'), 'ToWebview');
    if (!declared?.has('init')) {
      return { ok: false, detail: 'no ToWebview union found in protocol.ts, so this check is reading the wrong thing' };
    }

    /*
     * The extension host is `src/` without the two host-specific folders and without the
     * wire's own declaration, which names every message and would answer this question
     * with itself. `\s*` rather than a space because `init` is sent as a multi-line object
     * literal, and a one-line regex silently found the other fifteen and not that one.
     */
    const files = readdirSync(path.join(here, '..', 'src')).filter((f) => f.endsWith('.ts') && f !== 'protocol.ts');
    const sent = new Set();
    for (const file of files) {
      for (const [, name] of read('src', file).matchAll(/postMessage\(\{\s*type: '(\w+)'/g)) sent.add(name);
    }
    if (!sent.size) return { ok: false, detail: 'no sends found in the extension host at all, so this check is reading the wrong thing' };

    const never = [...declared.keys()].filter((name) => !sent.has(name)).sort();
    const notOnTheWire = [...sent].filter((name) => !declared.has(name)).sort();
    return {
      ok: never.length === 0 && notOnTheWire.length === 0,
      detail:
        `${declared.size} declared, ${sent.size} sent from ${files.length} files` +
        (never.length ? `; declared and never sent by VS Code ${JSON.stringify(never)}` : '') +
        (notOnTheWire.length ? `; sent and not on the wire ${JSON.stringify(notOnTheWire)}` : ''),
    };
  });

  check('shape: the editor gains no new import cycle, since a cycle fails at run time and nothing else would say so', () => {
    /*
     * 55 modules under `src/webview/` and no cycle among them.
     *
     * A cycle costs nothing until a module in it reads an imported binding while that
     * module is still evaluating, and then it is `undefined` at run time, which in a
     * webview is a blank editor and a console message. Nothing else sees it coming: the
     * types are correct, the imports resolve, and only the order esbuild happens to
     * choose decides whether it breaks. So the count is held at zero rather than at
     * whatever it happens to be.
     *
     * There was one, `cellEditor` to `toolbar` to `tables` and back, which `pendingMarks`
     * closed by living in the toolbar while both editors needed it. It has its own module
     * now. KNOWN is the way back if a cycle ever has to be lived with for a while; an
     * entry in it that no longer exists fails too, so it cannot be left behind.
     */
    const KNOWN = [];
    const dir = path.join(here, '..', 'src', 'webview');
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3));
    const has = new Set(names);
    const edges = new Map(names.map((n) => [n, new Set()]));
    for (const name of names) {
      const source = readFileSync(path.join(dir, `${name}.ts`), 'utf8');
      for (const m of source.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"]\.\/([A-Za-z0-9_.-]+)['"]/gm)) {
        const dep = m[1].replace(/\.ts$/, '');
        if (has.has(dep) && dep !== name) edges.get(name).add(dep);
      }
    }
    // Every strongly connected component of more than one module is a cycle.
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const found = [];
    let next = 0;
    const walk = (v) => {
      index.set(v, next);
      low.set(v, next);
      next += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of edges.get(v)) {
        if (!index.has(w)) {
          walk(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) === index.get(v)) {
        const part = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          part.push(w);
          if (w === v) break;
        }
        if (part.length > 1) found.push(part.sort());
      }
    };
    for (const n of names) if (!index.has(n)) walk(n);

    // The graph has to have been read, or an empty one passes while proving nothing.
    const totalEdges = [...edges.values()].reduce((sum, set) => sum + set.size, 0);
    if (names.length < 20 || totalEdges < 50) {
      return { ok: false, detail: `read ${names.length} modules and ${totalEdges} imports, which is too few to be the editor` };
    }
    const asText = (c) => c.join(' -> ');
    const known = new Set(KNOWN.map((c) => asText([...c].sort())));
    const fresh = found.filter((c) => !known.has(asText(c)));
    const goneStale = [...known].filter((k) => !found.some((c) => asText(c) === k));
    return {
      ok: fresh.length === 0 && goneStale.length === 0,
      detail: fresh.length
        ? `new import cycle: ${fresh.map(asText).join('; ')}. A cycle works only while every binding in it is read inside a function; move what is shared into a module both sides import.`
        : goneStale.length
          ? `the known cycle ${goneStale.join('; ')} is gone: take it out of KNOWN in this check so no cycle is allowed at all`
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

  check('shape: what the editor parses when a document opens does not grow', async () => {
    /*
     * The cost a person feels is the script parsed and evaluated every time a document
     * opens. That was 2,158 KB before the editor was split, and 1,036 KB of it was
     * grammars for languages nobody writes in a Markdown fence.
     *
     * **The entry's own size is the wrong measure, which a control caught.** With
     * splitting, a new static import can land in a chunk the entry imports eagerly, so
     * the entry stays the same size while the page parses more. What counts is the
     * closure: the entry plus every chunk reachable from it by an import statement. A
     * dynamic import is what makes a grammar cost nothing until a fence asks for it, so
     * only those are excluded here.
     *
     * Built in memory, so the figure does not depend on whether the last build was a
     * production one.
     *
     * A band rather than an exact figure, and the reason is the process rather than the
     * code. An exact figure means every commit that touches the editor carries a one-line
     * edit here, builders landing in parallel conflict on that line, and a number bumped
     * to get an unrelated branch green is bumped without anyone reading it. So the ceiling
     * has room for ordinary growth and the floor catches a real improvement: under it, the
     * check fails asking to be lowered, because a passing check prints nothing and "you
     * could lower this" in the detail of a pass is a sentence nobody reads.
     *
     * The band is wide next to what this exists to catch. `@codemirror/language-data`
     * going eager again is a thousand kilobytes, forty times the headroom.
     */
    const CEILING_KB = 958;
    const FLOOR_KB = 908;
    /*
     * Moved up 25 KB on 2026-09-29, after a run of features took the closure from 1,222 to
     * 1,226 KB. Checked before moving it, which is the point of the check: the closure is the
     * same eight files it has always been, no new library is reached by a static import, and
     * the growth is Sheaf's own code in the entry. A band that is raised without that reading
     * is a band that means nothing.
     */
    const built = await esbuild.build({
      entryPoints: [path.join(here, '..', 'src', 'webview', 'main.ts')],
      bundle: true, write: false, minify: true, splitting: true, format: 'esm',
      platform: 'browser', target: 'es2020', metafile: true, logLevel: 'silent',
      outdir: path.join(here, '..', 'media'), entryNames: 'webview', chunkNames: 'editor/[name]-[hash]',
      absWorkingDir: path.join(here, '..'),
    });
    const outputs = built.metafile.outputs;
    const entry = Object.keys(outputs).find((f) => f.endsWith('media/webview.js'));
    if (!entry) return { ok: false, detail: 'no media/webview.js in the build, so this check lost its subject' };
    /*
     * The walk is `scripts/eager-closure.mjs`, shared with `check-bundle-size.mjs`, which asks the
     * same question of the metafile the real build writes. The two metafiles are different because
     * this check runs before anything is built and that one runs after; one closure defined twice
     * would have been a second answer nobody chose.
     */
    const eager = eagerOutputs(built.metafile, entry);
    const deferred = Object.keys(outputs).length - eager.size;
    // Nothing deferred would mean splitting stopped working, and the total would be
    // under budget for the worst possible reason.
    if (deferred < 50) return { ok: false, detail: `only ${deferred} files load on demand, so the editor is no longer split and this number means nothing` };
    const kb = Math.round([...eager].reduce((sum, f) => sum + outputs[f].bytes, 0) / 1024);
    return {
      ok: kb <= CEILING_KB && kb >= FLOOR_KB,
      detail:
        kb > CEILING_KB
          ? `${kb} KB is parsed when a document opens, over the ${CEILING_KB} KB ceiling, across ${eager.size} files. Something new is reached by a static import; ${deferred} files already wait for a dynamic one.`
          : kb < FLOOR_KB
            ? `${kb} KB is parsed when a document opens, ${FLOOR_KB - kb} KB under the floor, which is good: move CEILING_KB and FLOOR_KB here down to ${kb + 25} and ${kb - 25}`
            : '',
    };
  });

  check('packaging: everything the build writes under media/ is ignored by git', () => {
    /*
     * `media/` holds both kinds of file: a handful that are source, the stylesheets and
     * the icon, and a great many the build writes. Every generated one has to be ignored,
     * or a session running `git add -A` commits it, and generated files in a repository
     * rot on the next build and conflict on every branch that rebuilt them.
     *
     * This was written because the editor's chunk directory was not ignored when it was
     * added: `.gitignore` named `webview.js`, its map, the KaTeX files and mermaid, and
     * the 124 new files sat there as untracked additions waiting for somebody's `add -A`.
     * Nothing failed, because nothing was looking.
     *
     * Asked of `git check-ignore` rather than by reading `.gitignore`, so a pattern that
     * looks right and does not match is caught the same as a missing line.
     *
     * The paths are named here as well as read off the disk, because `media/` in a
     * checkout nobody has built yet holds the source files and nothing else. Reading the
     * disk alone, the check found no generated entry, decided it was looking in the wrong
     * place and failed, so `npm run gates` could not pass in a fresh clone or a new
     * worktree: the suites run before the build. `git check-ignore` answers about a path
     * rather than a file, so naming them works in either state, and the disk is still
     * read on top of the list, which is what catches an output nobody added to the list.
     */
    const dir = path.join(here, '..', 'media');
    // The stylesheets and the icon are source; everything else here is written by a build.
    const SOURCE = ['webview.css', 'browser-theme.css', 'icon.svg', 'icon-small.svg', 'icon.png'];
    // What the build writes, whether or not it has run in this checkout yet. A new output
    // belongs on this list the same as it belongs in `.gitignore`.
    const WRITES = [
      'media/webview.js',
      'media/webview.js.map',
      'media/editor/',
      'media/katex.css',
      'media/katex-fonts/',
      'media/katex-LICENSE.txt',
      'media/mermaid/',
    ];
    const present = readdirSync(dir, { withFileTypes: true });
    // The guard the list needs: if `media/` moved or the source files were renamed, the
    // names above describe somewhere else and everything past here would pass on nothing.
    const missing = SOURCE.filter((name) => !present.some((e) => e.name === name));
    if (missing.length) {
      return { ok: false, detail: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in media/, so this check is looking in the wrong place` };
    }
    const generated = new Set(WRITES);
    for (const e of present) {
      if (!SOURCE.includes(e.name)) generated.add(e.isDirectory() ? `media/${e.name}/` : `media/${e.name}`);
    }
    const notIgnored = [...generated].filter((rel) => {
      const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: path.join(here, '..') });
      return r.status !== 0;
    });
    return {
      ok: notIgnored.length === 0,
      detail: notIgnored.length
        ? `${notIgnored.join(', ')} ${notIgnored.length === 1 ? 'is' : 'are'} written by the build and not ignored, so a \`git add -A\` would commit ${notIgnored.length === 1 ? 'it' : 'them'}`
        : '',
    };
  });

  check('packaging: the editor\'s own chunks are built and nothing keeps them out of the package', () => {
    /*
     * The editor is split, so `media/webview.js` is an entry that fetches a grammar from
     * `media/editor/` when a fence asks for one. A packaging rule that dropped that folder
     * would leave every fenced code block unhighlighted, and nothing would fail at build
     * time: the entry still builds, still loads, and still edits text.
     *
     * Both halves are checked, because either alone would pass while the other was broken:
     * the build has to emit the chunks, and the package has to carry them.
     */
    const build = readFileSync(path.join(here, '..', 'esbuild.mjs'), 'utf8');
    const emits = /splitting:\s*true/.test(build) && /chunkNames:\s*'editor\//.test(build);
    const ignore = readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    // A rule naming the folder, or one sweeping up every .js, would take the chunks with it.
    const excluded = ignore.some((rule) => !rule.startsWith('!') && (/editor/i.test(rule) || /(^|\/)\*+\.js$/.test(rule) || /^media(\/\*+)?$/.test(rule)));
    return {
      ok: emits && !excluded,
      detail: !emits
        ? 'esbuild.mjs no longer splits the editor into chunks under media/editor/'
        : excluded
          ? 'a .vscodeignore rule would keep the editor\'s chunks out of the package, so every fenced code block would lose its highlighting'
          : '',
    };
  });

  check('packaging: the diagram library, its chunks and its licence are built and nothing keeps them out of the package', () => {
    // Mermaid ships as its published module and the chunks it imports by relative
    // path. A packaging rule that dropped `.mjs` files, or the folder, would leave
    // every diagram showing a loading error with nothing failing at build time.
    const build = readFileSync(path.join(here, '..', 'esbuild.mjs'), 'utf8');
    const copied =
      /mermaid\.esm\.min\.mjs/.test(build) &&
      /chunks', 'mermaid\.esm\.min'/.test(build) &&
      /join\(to, 'LICENSE\.txt'\)/.test(build);
    const ignore = readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    // A rule naming Mermaid, one dropping every module (`*.mjs`, `**/*.mjs`), or one
    // dropping the media folder. `esbuild.mjs` is one file, and not one of these.
    const excluded = ignore.some(
      (rule) => !rule.startsWith('!') && (/mermaid/i.test(rule) || /(^|\/)\*+\.mjs$/.test(rule) || /^media\/?\**$/.test(rule))
    );
    // The editor looks for the module beside itself, under the same name the build writes.
    const source = readFileSync(path.join(here, '..', 'src', 'webview', 'mermaid.ts'), 'utf8');
    const sameName = source.includes("'mermaid/mermaid.esm.min.mjs'");
    return copied && !excluded && sameName;
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

  check('front matter: a state one editor keeps is handed to the next editor on that document, and to no other', async () => {
    // The same store as the folds and the widths, for the same reason: how much
    // metadata somebody wants to look at is not something to write into their file.
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const reply = (panel) => panel.posted.filter((message) => message.type === 'frontMatterState');
    const first = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    first.panel.receive({ type: 'frontMatterStateWrite', state: 'shown' });
    await settle();
    first.panel.close();
    const again = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    again.panel.receive({ type: 'frontMatterStateRead', id: 'frontmatter-1' });
    const other = await openWithStorage(ctx, state, '/ws/other.md', NOTED);
    other.panel.receive({ type: 'frontMatterStateRead', id: 'frontmatter-1' });
    await settle();
    return (
      same(reply(again.panel), [{ type: 'frontMatterState', id: 'frontmatter-1', state: 'shown' }]) &&
      // Null rather than a state, which is the page's word for "follow the setting".
      same(reply(other.panel), [{ type: 'frontMatterState', id: 'frontmatter-1', state: null }]) &&
      again.document.text === NOTED
    );
  });

  check('the heading list: a fold one editor keeps is handed to the next editor on that document, and to no other', async () => {
    // Two elements, two keys, one store. They are separate messages rather than one
    // carrying an element name, which is worth revisiting if a third ever arrives.
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const reply = (panel) => panel.posted.filter((message) => message.type === 'outlineState');
    const first = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    first.panel.receive({ type: 'outlineStateWrite', state: 'collapsed' });
    await settle();
    first.panel.close();
    const again = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    again.panel.receive({ type: 'outlineStateRead', id: 'outline-1' });
    const other = await openWithStorage(ctx, state, '/ws/other.md', NOTED);
    other.panel.receive({ type: 'outlineStateRead', id: 'outline-1' });
    await settle();
    return (
      same(reply(again.panel), [{ type: 'outlineState', id: 'outline-1', state: 'collapsed' }]) &&
      same(reply(other.panel), [{ type: 'outlineState', id: 'outline-1', state: null }]) &&
      again.document.text === NOTED
    );
  });

  check('front matter: a state nobody could have written is read as none, and null forgets one', async () => {
    const ctx = sheafWindow();
    const state = workspaceMemento();
    const reply = (panel) => panel.posted.filter((message) => message.type === 'frontMatterState');
    const { panel } = await openWithStorage(ctx, state, '/ws/notes.md', NOTED);
    // Whatever else is in that storage, a state Sheaf does not know is not one to act on.
    panel.receive({ type: 'frontMatterStateWrite', state: 'enormous' });
    await settle();
    panel.receive({ type: 'frontMatterStateRead', id: 'frontmatter-1' });
    await settle();
    panel.receive({ type: 'frontMatterStateWrite', state: 'hidden' });
    await settle();
    panel.receive({ type: 'frontMatterStateWrite', state: null });
    await settle();
    panel.receive({ type: 'frontMatterStateRead', id: 'frontmatter-2' });
    await settle();
    return same(reply(panel), [
      { type: 'frontMatterState', id: 'frontmatter-1', state: null },
      { type: 'frontMatterState', id: 'frontmatter-2', state: null },
    ]);
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

  /*
   * The value `livePreview.ts` starts from must be the manifest's default.
   *
   * A host sends the config at `init`, so the initial value is overwritten before anybody
   * sees a document and nothing in the product depends on it. Nothing sends one in a test,
   * so it is the value every scenario inherits when it says nothing, and the two had come
   * apart: the module started at `revealSyntaxOnLine: true` while the setting defaults to
   * `false`. Scenarios that said nothing were written for a state a person has to turn on
   * deliberately, and the guard they lean on cannot see that state either, so the pair was
   * consistent and both halves were wrong.
   *
   * This reads the source text rather than importing the module, because the initial value
   * is private and what is being pinned is two literals agreeing. That is exactly the claim:
   * nothing else compared them.
   */
  check('the live-preview config starts at the manifest default, so a test inherits what a person has', () => {
    const source = readFileSync(path.join(here, '..', 'src', 'webview', 'revealState.ts'), 'utf8');
    const found = /let currentConfig: LivePreviewConfig = \{ revealSyntaxOnLine: (true|false) \};/.exec(source);
    if (!found) {
      return { ok: false, detail: 'could not find the initial currentConfig in revealState.ts, so nothing was compared' };
    }
    const declared = manifest().contributes.configuration.properties['sheaf.revealSyntaxOnLine']?.default;
    if (typeof declared !== 'boolean') {
      return { ok: false, detail: 'sheaf.revealSyntaxOnLine has no boolean default in the manifest, so there is nothing to pin to' };
    }
    const started = found[1] === 'true';
    return {
      ok: started === declared,
      detail:
        started === declared
          ? `both ${String(declared)}`
          : `livePreview.ts starts at ${String(started)} and the manifest default is ${String(declared)}, so a scenario that sets nothing runs in a state no person has`,
    };
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
    /*
     * A check says true or false, or it says `{ ok, detail }` and explains itself.
     * This took the second shape as a pass, because an object is truthy, so every
     * check written that way reported what it found and passed regardless. One of
     * them held that the editor bundle is the same bytes in both hosts, which is the
     * guarantee the whole host split rests on, and it could not have failed.
     */
    const result = await run();
    if (result && typeof result === 'object') {
      ok = result.ok === true;
      if (result.detail) detail = ` ${result.detail}`;
    } else {
      ok = result === true;
    }
  } catch (err) {
    detail = ` threw: ${err.message}`;
  }
  if (ok) passed++;
  else console.log(`❌ ${name}${detail}`);
}
console.log(`${passed}/${cases.length} host checks passed`);
process.exit(passed === cases.length ? 0 : 1);
