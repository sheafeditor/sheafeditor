import * as vscode from 'vscode';
import { DocumentSync, toWebviewText } from './textSync';

/** Messages sent extension host -> webview. */
type ToWebview =
  | {
      type: 'init';
      text: string;
      config: EditorConfig;
      fileName: string;
      resourceBaseUri: string;
      fragment?: string;
    }
  | { type: 'setContent'; text: string }
  | { type: 'revealFragment'; id: string }
  | { type: 'configChanged'; config: EditorConfig }
  | { type: 'imageSaved'; id: string; path?: string; error?: string }
  | { type: 'clipboardText'; id: string; text: string }
  | { type: 'toggleSourceMode' };

/** Messages sent webview -> extension host. */
type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openAsText' }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; id: string }
  | { type: 'saveImage'; id: string; name: string; data: string }
  | { type: 'openLink'; address: string };

/** Subfolder (relative to the document) where dropped/pasted images are saved. */
const IMAGE_FOLDER = 'assets';

interface EditorConfig {
  contentWidth: string;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  autoSave: boolean;
}

/** How long to wait after the last edit before auto-saving. */
const AUTOSAVE_DEBOUNCE_MS = 700;

function readConfig(): EditorConfig {
  const cfg = vscode.workspace.getConfiguration('sheaf');
  return {
    contentWidth: cfg.get<string>('contentWidth', '708px'),
    revealSyntaxOnLine: cfg.get<boolean>('revealSyntaxOnLine', false),
    doubleClickToEditSource: cfg.get<boolean>('doubleClickToEditSource', true),
    autoSave: cfg.get<boolean>('autoSave', true),
  };
}

/**
 * WYSIWYG Markdown editor backed by a plain-text TextDocument.
 *
 * The raw Markdown file is always the source of truth. The webview renders it
 * with CodeMirror 6 and posts back the full document text on every edit; the
 * host writes that text back into the TextDocument via a WorkspaceEdit so that
 * VS Code owns undo/redo, save, hot-exit and file watching.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'sheaf.wysiwyg';

  /** The most recently focused WYSIWYG webview panel, for command routing. */
  public static active: MarkdownEditorProvider | undefined;
  private static readonly instances = new Set<MarkdownEditorProvider>();

  static get activeUri(): vscode.Uri | undefined {
    return MarkdownEditorProvider.active?.document?.uri;
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProviderFactory(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  /**
   * Headings waiting for the editor that will show them, keyed by document URI. A
   * link naming one is followed before the editor for that document exists, so the
   * fragment is left here for its `init` to collect.
   */
  private static readonly pendingFragments = new Map<string, string>();

  private document?: vscode.TextDocument;
  /**
   * True once this editor's webview has asked for its content. Before that it has no
   * listener attached, so anything posted to it is dropped rather than queued.
   */
  private webviewReady = false;
  /** The queue that writes the webview's text into the document. */
  private sync?: DocumentSync;
  /** Pending debounced auto-save timer. */
  private autoSaveTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postMessage(message: ToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private panel?: vscode.WebviewPanel;

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.panel = webviewPanel;
    this.sync = new DocumentSync({
      getText: () => document.getText(),
      crlf: () => document.eol === vscode.EndOfLine.CRLF,
      applyEdit: async (start, end, replacement) => {
        const edit = new vscode.WorkspaceEdit();
        // Replace only the changed region, to keep undo granular and cursor mapping
        // sane for other open editors. The positions are resolved here rather than
        // when the edit was planned, so they belong to the document as it reads now.
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(start), document.positionAt(end)),
          replacement
        );
        return vscode.workspace.applyEdit(edit);
      },
      setContent: (text) => this.postMessage({ type: 'setContent', text }),
      onEdited: () => this.scheduleAutoSave(document),
    });
    MarkdownEditorProvider.instances.add(this);
    MarkdownEditorProvider.active = this;

    // Allow the webview to load bundled assets, plus images referenced from the
    // document's own folder and anywhere in its workspace folder.
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media'), docDir];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      roots.push(workspaceFolder.uri);
    }
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // Push external document edits (from other editors / formatters / git) into the webview.
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      this.sync?.documentChanged(e.document.getText());
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sheaf')) {
        this.postMessage({ type: 'configChanged', config: readConfig() });
      }
    });

    const focusSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        MarkdownEditorProvider.active = this;
      } else {
        // Focus has left this editor, which is the last moment Sheaf hears about
        // before the person can reach the tab's close button.
        this.flushAutoSave(document);
      }
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage((message: FromWebview) => {
      switch (message.type) {
        case 'ready': {
          this.webviewReady = true;
          const baseUri = webviewPanel.webview.asWebviewUri(docDir).toString();
          const key = document.uri.toString();
          const fragment = MarkdownEditorProvider.pendingFragments.get(key);
          MarkdownEditorProvider.pendingFragments.delete(key);
          this.postMessage({
            type: 'init',
            text: toWebviewText(document.getText()),
            config: readConfig(),
            fileName: vscode.workspace.asRelativePath(document.uri),
            resourceBaseUri: baseUri.endsWith('/') ? baseUri : baseUri + '/',
            fragment,
          });
          break;
        }
        case 'edit':
          void this.sync?.edit(message.text);
          break;
        case 'openAsText':
          void vscode.commands.executeCommand('sheaf.openAsText', document.uri);
          break;
        case 'clipboardWrite':
          void vscode.env.clipboard.writeText(message.text);
          break;
        case 'clipboardRead':
          void vscode.env.clipboard.readText().then((text) => this.postMessage({ type: 'clipboardText', id: message.id, text }));
          break;
        case 'saveImage':
          void this.saveImage(docDir, message);
          break;
        case 'openLink':
          void this.openLink(document.uri, docDir, message.address);
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      this.flushAutoSave(document);
      changeSub.dispose();
      configSub.dispose();
      focusSub.dispose();
      msgSub.dispose();
      MarkdownEditorProvider.instances.delete(this);
      if (MarkdownEditorProvider.active === this) {
        MarkdownEditorProvider.active = MarkdownEditorProvider.instances.values().next().value;
      }
    });
  }

  /**
   * Open an address the document points at, such as `signals.md#detections` or
   * `../log/2244-11.md`.
   *
   * Only the host can do this. The webview has no idea where the document it is
   * showing lives, so a relative address there resolves against the webview's own
   * `vscode-webview://` origin and reaches nothing at all. Here it resolves against
   * the document's own folder, the way every other Markdown tool reads it.
   */
  private async openLink(documentUri: vscode.Uri, docDir: vscode.Uri, address: string): Promise<void> {
    const target = resolveDocumentLink(documentUri, docDir, address);
    if (!target) {
      return;
    }
    // Saying nothing would read as a link that simply does not work, which is the bug
    // this replaces. Every way of failing to follow one says what was looked for.
    if ('problem' in target) {
      void vscode.window.showWarningMessage(target.problem);
      return;
    }
    const uri = target.uri;
    if (!(await uriExists(uri))) {
      void vscode.window.showWarningMessage(`Sheaf: ${address} was not found.`);
      return;
    }
    const hash = address.indexOf('#');
    const fragment = hash === -1 ? '' : address.slice(hash + 1);
    const key = uri.toString();
    if (fragment) {
      // Left for the editor that is about to resolve, which reads it in `init`.
      MarkdownEditorProvider.pendingFragments.set(key, fragment);
    }
    // `vscode.open` goes through the editor association, so a Markdown file opens in
    // Sheaf and anything else opens in whatever handles it.
    await vscode.commands.executeCommand('vscode.open', uri);
    if (!fragment) {
      return;
    }
    // Opening leaves the document in one of three states, and only one of them can
    // be told anything. There may be no editor for it yet; there may be one that has
    // resolved while opening was still running, whose webview has not loaded and is
    // listening for nothing; or there may be one already showing it, which is brought
    // forward without resolving again and so will never send another `init`.
    //
    // Only the last can be posted to. For the other two the fragment stays pending
    // and the `init` each of them sends collects it. Posting to an editor that is not
    // listening loses the message and, worse, consumes the fragment that its own
    // `init` was about to ask for, which leaves the document open at the top.
    const listening = [...MarkdownEditorProvider.instances].filter(
      (editor) => editor.document?.uri.toString() === key && editor.webviewReady
    );
    if (listening.length === 0) {
      return;
    }
    MarkdownEditorProvider.pendingFragments.delete(key);
    for (const editor of listening) {
      editor.postMessage({ type: 'revealFragment', id: fragment });
    }
  }

  /**
   * Persist a dropped/pasted image into the document's `assets/` folder, then
   * tell the webview the workspace-relative path to insert. Filenames are
   * sanitised and de-duplicated so nothing is silently overwritten.
   */
  private async saveImage(
    docDir: vscode.Uri,
    msg: { id: string; name: string; data: string }
  ): Promise<void> {
    try {
      const assetsDir = vscode.Uri.joinPath(docDir, IMAGE_FOLDER);
      const safe = sanitizeFileName(msg.name);
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';

      let name = safe;
      for (let i = 1; await uriExists(vscode.Uri.joinPath(assetsDir, name)); i++) {
        name = `${stem}-${i}${ext}`;
      }

      const target = vscode.Uri.joinPath(assetsDir, name);
      // writeFile creates the assets/ directory if it doesn't exist yet.
      await vscode.workspace.fs.writeFile(target, Buffer.from(msg.data, 'base64'));
      this.postMessage({ type: 'imageSaved', id: msg.id, path: `${IMAGE_FOLDER}/${name}` });
    } catch (err) {
      this.postMessage({ type: 'imageSaved', id: msg.id, error: String(err) });
    }
  }

  /**
   * Auto-save the way a notes app does: after edits settle, persist the file to
   * disk. This runs on top of VS Code's own dirty/undo model, so undo still works
   * and hot exit is unaffected. Debounced so we save once per pause, not per
   * keystroke. Opt out with `sheaf.autoSave: false` (then normal save /
   * files.autoSave apply).
   */
  private scheduleAutoSave(document: vscode.TextDocument): void {
    if (!readConfig().autoSave) {
      return;
    }
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = undefined;
      if (writable(document)) {
        void document.save();
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Write a pending save now instead of on the debounce.
   *
   * VS Code asks "Do you want to save the changes" as soon as a tab is closed, and
   * it asks before the editor is disposed, so a save still sitting on the debounce
   * becomes a dialog nobody expected in an editor that saves by itself. Someone who
   * reads it as a stray prompt answers Don't Save and loses what they just typed.
   *
   * Losing focus is the last moment Sheaf hears about before the close, so that is
   * where the dialog is headed off, which is also what VS Code's own
   * `files.autoSave: onFocusChange` does. Dispose is the backstop for an editor that
   * goes away without losing focus first: it cannot prevent the dialog, because by
   * then the dialog has already been answered, and it is there so that a pending
   * save is never simply dropped. The two are not redundant.
   */
  private flushAutoSave(document: vscode.TextDocument): void {
    if (!this.autoSaveTimer) {
      return; // Nothing of ours was pending.
    }
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
    if (writable(document)) {
      void document.save();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css')
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Sheaf</title>
</head>
<body>
  <div class="sheaf-app">
    <div id="toolbar" class="sheaf-toolbar" role="toolbar" aria-label="Formatting"></div>
    <div id="editor" class="sheaf-root"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * The registration API hands VS Code a single provider object, but we want one
 * provider instance per resolved editor so state (document, syncedText) does not
 * collide across tabs. This factory delegates resolve to a fresh instance.
 */
class MarkdownEditorProviderFactory implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}
  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    return new MarkdownEditorProvider(this.context).resolveCustomTextEditor(
      document,
      webviewPanel,
      token
    );
  }
}

/** Where a relative address points, or why it points nowhere. */
type LinkTarget = { uri: vscode.Uri } | { problem: string } | null;

/**
 * The file a relative address in a document names.
 *
 * The fragment is split off first, so `../beacon.md#pulse-format` names a file and a
 * heading inside it. A leading slash means the workspace root, the way a site does,
 * and there is nothing to resolve it against when the document belongs to no
 * workspace folder: resolving it against the document's own folder instead would
 * quietly open the wrong file. That case comes back as something to say, because a
 * link that does nothing and explains nothing is the whole of what this replaced.
 *
 * Null is for an address with no path at all, which is a fragment naming this
 * document. The webview keeps those, so none should arrive here, and nothing is said
 * if one does.
 */
function resolveDocumentLink(
  documentUri: vscode.Uri,
  docDir: vscode.Uri,
  address: string
): LinkTarget {
  const hash = address.indexOf('#');
  const path = hash === -1 ? address : address.slice(0, hash);
  if (!path) {
    return null;
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A stray percent sign is a literal one, so the path is used as written.
  }
  if (decoded.startsWith('/')) {
    const folder = vscode.workspace.getWorkspaceFolder(documentUri);
    return folder
      ? { uri: vscode.Uri.joinPath(folder.uri, decoded.slice(1)) }
      : {
          problem: `Sheaf: ${address} starts at the workspace root, and this file is not in a workspace folder.`,
        };
  }
  return { uri: vscode.Uri.joinPath(docDir, decoded) };
}

/**
 * True when a document is Sheaf's to save: still open, actually changed, and backed
 * by a file. Saving an untitled document opens a Save As dialog, which is the same
 * surprise auto-save exists to avoid.
 */
function writable(document: vscode.TextDocument): boolean {
  return !document.isClosed && !document.isUntitled && document.isDirty;
}

/** Strip path separators and unsafe characters from an uploaded filename. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'image';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'image.png';
}

/** True if a file/folder exists at the given URI. */
async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
