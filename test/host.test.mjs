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
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const writes = [];
  const warnings = [];
  const messages = [];
  const executed = [];
  const handlers = new Map();

  const id = (section, key) => (section ? `${section}.${key}` : key);
  const effective = (key) => (key in scopes[WORKSPACE] ? scopes[WORKSPACE][key] : scopes[GLOBAL][key]);

  const getConfiguration = (section) => ({
    get(key, fallback) {
      const value = effective(id(section, key));
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
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      getWorkspaceFolder: () => undefined,
      asRelativePath: (uri) => uri.path.replace(/^\//, ''),
      fs: {
        async stat(uri) {
          if (!files.has(uri.path)) throw new Error(`no such file: ${uri.path}`);
          return { type: 1 };
        },
      },
      /** Apply an edit the way VS Code does, against the document it names. */
      applyEdit: async (edit) => {
        for (const { uri, range, text } of edit.edits) {
          const doc = documents.find((d) => d.uri.path === uri.path);
          if (!doc) return false;
          doc.text = doc.text.slice(0, range.start.offset) + text + doc.text.slice(range.end.offset);
          doc.isDirty = true;
        }
        return true;
      },
    },
    window: {
      activeTextEditor: undefined,
      showWarningMessage: (message) => warnings.push(message),
      showInformationMessage: (message) => messages.push(message),
      registerCustomEditorProvider: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, run) => {
        handlers.set(id, run);
        return { dispose() {} };
      },
      executeCommand: async (...args) => {
        executed.push(args);
      },
    },
  };

  return {
    vscode,
    writes,
    warnings,
    /** Notifications Sheaf showed the person. */
    messages,
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
    /** Put a plain text editor in front of the person. */
    focusText: (path) => {
      vscode.window.activeTextEditor = { document: { uri: { path } } };
    },
    /** Files that exist on disk, for an address that resolves to one. */
    addFile: (...paths) => paths.forEach((path) => files.add(path)),
    /** The files opened by address, in order, as `vscode.open` was asked for them. */
    openedByAddress: () =>
      executed.filter(([command]) => command === 'vscode.open').map(([, uri]) => uri.path),
    /** A Markdown file open in the window, which Sheaf can be resolved against. */
    openDocument: (path, text) => {
      const doc = {
        uri: file(path),
        text,
        eol: 1,
        isClosed: false,
        isDirty: false,
        isUntitled: false,
        /** How many times Sheaf wrote this document to disk. */
        saves: 0,
        getText: () => doc.text,
        positionAt: (offset) => ({ offset }),
        async save() {
          doc.saves++;
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
 * person does to it: type, click away, and close the tab.
 */
function makePanel() {
  const onMessage = [];
  const onViewState = [];
  const onDispose = [];
  const posted = [];
  const panel = {
    active: true,
    /** Everything the host sent the webview. */
    posted,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://sheaf',
      asWebviewUri: (uri) => ({ toString: () => `https://webview${uri.path}` }),
      postMessage: async (message) => posted.push(message),
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

/** The `when` clause VS Code is handed for the editor title's Open as Raw Markdown item. */
function editorTitleWhenClause() {
  const items = manifest().contributes.menus['editor/title'] ?? [];
  return items.find((item) => item.command === 'sheaf.openAsText')?.when ?? '';
}

/** The command IDs the manifest contributes. */
function contributedCommands() {
  return (manifest().contributes.commands ?? []).map((command) => command.command);
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

  check('auto-save: an edit and then the editor losing focus writes the file at once', async () => {
    const { document, panel, type } = await openInSheaf();
    await type('Some woZrds.\n');
    const beforeBlur = document.saves;
    panel.setActive(false);
    // The debounce has not run: this is the flush getting ahead of the close dialog.
    return beforeBlur === 0 && document.saves === 1 && document.isDirty === false;
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
    // nothing opens. Opening nothing and saying nothing is the failure this whole
    // issue was filed about, so this pins the message rather than the silence.
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

  check('links: a link naming no heading hands nothing on', async () => {
    const { win, ctx, panel } = await openInSheaf();
    win.addFile('/ws/signals.md');
    panel.receive({ type: 'openLink', address: 'signals.md' });
    await settle();
    const target = await openInSheaf('# Signals\n', '/ws/signals.md', ctx);
    target.ready();
    return target.init().fragment === undefined && target.panel.posted.every((m) => m.type !== 'revealFragment');
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

  check('manifest: the title bar escape hatch names the view type the provider registers', () => {
    // A fourth copy of the same value. Renamed in one place only, the escape hatch
    // out of Sheaf disappears from the title bar, and nothing about a missing button
    // points at a constant.
    const { MarkdownEditorProvider } = load(makeWindow());
    const viewType = MarkdownEditorProvider.viewType;
    const contributed = (manifest().contributes.customEditors ?? []).map((editor) => editor.viewType);
    const named = /^activeCustomEditorId == (\S+)$/.exec(editorTitleWhenClause());
    return contributed.includes(viewType) && named?.[1] === viewType;
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
