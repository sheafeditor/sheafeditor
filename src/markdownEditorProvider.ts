import * as vscode from 'vscode';
import { DocumentSync, minimalEdit, planEdit, toWebviewText } from './textSync';
import { noticeAboutLostText, noticeAboutRestoredText, RecentTyping } from './recentTyping';

/** Messages sent extension host -> webview. */
type ToWebview =
  | {
      type: 'init';
      text: string;
      config: EditorConfig;
      fileName: string;
      resourceBaseUri: string;
      fragment?: string;
      /** Set when the file is a data file shown as one grid, rather than a Markdown document. */
      mode?: 'csv';
      /** Shown in place of the editor, for a file this editor will not open. */
      notice?: string;
    }
  | { type: 'setContent'; text: string; tookTypedText?: boolean; ownUndo?: boolean }
  | { type: 'revealFragment'; id: string }
  | { type: 'undoOutsideChange' }
  | { type: 'configChanged'; config: EditorConfig }
  | { type: 'imageSaved'; id: string; path?: string; error?: string }
  | { type: 'clipboardText'; id: string; text: string }
  | { type: 'workspaceFiles'; id: string; files: string[] }
  | { type: 'tableWidths'; id: string; widths: TableWidths }
  | { type: 'tableBoards'; id: string; boards: TableBoards }
  /**
   * A data file a view block reads, by the path the view wrote. Sent in answer to
   * `dataFileRead` with its `id`, and again without one whenever the file changes.
   */
  | {
      type: 'dataFile';
      id?: string;
      path: string;
      text?: string;
      error?: string;
      notice?: string;
      /** Set with `error` when the path is one Sheaf may read and there is simply no file there yet. */
      missing?: boolean;
    }
  /**
   * The answer to `dataFileCreate`: the path the file was written at, as the
   * document should name it, or why nothing was written.
   */
  | { type: 'dataFileCreated'; id: string; path?: string; error?: string }
  | { type: 'getSelection'; id: string }
  | { type: 'toggleSourceMode' };

/** Messages sent webview -> extension host. */
type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openAsText' }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; id: string }
  /** The workspace's files, for completing a link's address. */
  | { type: 'workspaceFilesRead'; id: string }
  /** The column widths set by hand in this document's tables, and keeping them. */
  | { type: 'tableWidthsRead'; id: string }
  | { type: 'tableWidthsWrite'; widths: TableWidths }
  /** The pipe tables in this document shown as boards, and keeping them. */
  | { type: 'tableBoardsRead'; id: string }
  | { type: 'tableBoardsWrite'; boards: TableBoards }
  /** A .csv or .tsv file a view block names, relative to the document. */
  | { type: 'dataFileRead'; id: string; path: string }
  /**
   * An edit made through a view of a data file: the whole of the file's new text,
   * and `base`, the text the edit was made against, both in the webview's line
   * endings and without a byte-order mark. Written as the one changed range.
   * `step` marks the undo or redo of an earlier such edit, sent as its inverse,
   * which only changes what a refusal says.
   */
  | { type: 'dataFileEdit'; path: string; base: string; text: string; step?: 'undo' | 'redo' }
  /**
   * A new .csv or .tsv file, relative to the document, holding `text` in the
   * webview's line endings. Never written over an existing file: with `nextFree`
   * the next free name is taken instead (`tasks-2.csv`), and without it the
   * request is refused. Answered with `dataFileCreated`.
   */
  | { type: 'dataFileCreate'; id: string; path: string; text: string; nextFree?: boolean }
  | { type: 'saveImage'; id: string; name: string; data: string }
  | { type: 'openLink'; address: string }
  | { type: 'setTableOfContents'; on: boolean }
  | { type: 'selection'; ranges: SelectionRange[]; ref: string; id?: string }
  | { type: 'runCommand'; command: string }
  /** Keyboard focus has left the page, to the tab bar or anywhere else in the window. */
  | { type: 'blur' };

/** The lines one of the webview's selected ranges covers, counted from one. */
interface SelectionRange {
  start: number;
  end: number;
}

/**
 * What the person has picked in a Sheaf editor, in the form the commands that hand it
 * to something else need: where it is, and what is written there.
 */
export interface DocumentSelection {
  /** The document's path, relative to the workspace folder it is in. */
  path: string;
  /** The first line the selection covers, counted from one. */
  start: number;
  /** The last line it covers; the same as `start` for a caret or a single line. */
  end: number;
  /** The reference Copy ref puts on the clipboard, built in the webview that has it. */
  ref: string;
}

/**
 * Column widths set by hand in one document's tables: by table key (the webview's
 * digest of a table's header row), then by column index, in pixels.
 */
type TableWidths = Record<string, Record<string, number>>;

/**
 * Where a document's column widths are kept: the workspace's own storage, which
 * belongs to this workspace on this machine and never travels with the file.
 */
const tableWidthsKey = (uri: vscode.Uri): string => `sheaf.tableWidths:${uri.toString()}`;

/** Keep only what can be a width, so a damaged or foreign value reads as none. */
function cleanTableWidths(value: unknown): TableWidths {
  const out: TableWidths = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, cols] of Object.entries(value as Record<string, unknown>)) {
    if (!cols || typeof cols !== 'object') continue;
    const kept: Record<string, number> = {};
    for (const [c, w] of Object.entries(cols as Record<string, unknown>)) {
      if (/^\d+$/.test(c) && typeof w === 'number' && Number.isFinite(w) && w > 0) kept[c] = w;
    }
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

/**
 * The pipe tables in one document shown as boards: by table key (the same digest
 * of the header row the widths use), the header text of the column each is
 * grouped by.
 */
type TableBoards = Record<string, { group: string }>;

/** Where a document's boards are kept: beside its widths, in the workspace's own storage. */
const tableBoardsKey = (uri: vscode.Uri): string => `sheaf.tableBoards:${uri.toString()}`;

/** The longest header text a board may be grouped by; anything longer is not a header the page wrote. */
const MAX_BOARD_GROUP = 1000;

/** Keep only what can be a board, so a damaged or foreign value reads as none. */
function cleanTableBoards(value: unknown): TableBoards {
  const out: TableBoards = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, board] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !board || typeof board !== 'object') continue;
    const group = (board as { group?: unknown }).group;
    if (typeof group === 'string' && group.length <= MAX_BOARD_GROUP) out[key] = { group };
  }
  return out;
}

/** Subfolder (relative to the document) where dropped/pasted images are saved. */
const IMAGE_FOLDER = 'assets';

/** The most files a link's address completion is offered from. */
const MAX_WORKSPACE_FILES = 5000;

/** The most names tried for a new data file, `tasks.csv` to `tasks-999.csv`, before giving up. */
const MAX_FREE_NAMES = 999;

/** How long one workspace search answers for before the next request searches again. */
const FILES_CACHE_MS = 5000;

interface EditorConfig {
  contentWidth: string;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  autoSave: boolean;
  tableOfContents: boolean;
}

/** How long to wait after the last edit before auto-saving. */
const AUTOSAVE_DEBOUNCE_MS = 700;

/** How long a key that names the selection waits for the webview to say what it is. */
const SELECTION_REPLY_MS = 250;

/** The one thing a person can do about text a write from outside took back. */
const UNDO = 'Undo';

/**
 * The most records a data file may hold and still open as a grid, header included.
 * The grid draws every row at once, and a few thousand is where opening one starts to
 * take long enough to read as a hang.
 */
export const GRID_MAX_ROWS = 2000;

/** What an editor shows: a Markdown document, or a .csv or .tsv file as one grid. */
export type EditorMode = 'markdown' | 'grid';

function readConfig(): EditorConfig {
  const cfg = vscode.workspace.getConfiguration('sheaf');
  return {
    contentWidth: cfg.get<string>('contentWidth', '708px'),
    revealSyntaxOnLine: cfg.get<boolean>('revealSyntaxOnLine', false),
    doubleClickToEditSource: cfg.get<boolean>('doubleClickToEditSource', false),
    autoSave: cfg.get<boolean>('autoSave', true),
    tableOfContents: cfg.get<boolean>('tableOfContents', false),
  };
}

/** Whether the table of contents is on, as the setting has it now. */
export function tableOfContentsOn(): boolean {
  return vscode.workspace.getConfiguration('sheaf').get<boolean>('tableOfContents', false);
}

/**
 * Turn the table of contents on or off, for every Sheaf editor and for next time.
 *
 * The write goes to user settings, the way View: Toggle Minimap writes
 * `editor.minimap.enabled`: a panel is something a person wants or does not want, not
 * something they want in one file. Every open editor hears about it through the
 * configuration-change listener each one already has, so none of them is told directly.
 */
export async function setTableOfContents(on: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('sheaf')
    .update('tableOfContents', on, vscode.ConfigurationTarget.Global);
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
  /** The editor offered for .csv and .tsv files, which shows the whole file as one grid. */
  public static readonly gridViewType = 'sheaf.csv';

  /** The most recently focused WYSIWYG webview panel, for command routing. */
  public static active: MarkdownEditorProvider | undefined;
  private static readonly instances = new Set<MarkdownEditorProvider>();

  static get activeUri(): vscode.Uri | undefined {
    return MarkdownEditorProvider.active?.document?.uri;
  }

  /**
   * True when a resolved Sheaf editor is showing this document. A tab can exist
   * without one: VS Code reads the file into a document before resolving the editor,
   * and a file it will not read as text never gets that far.
   */
  public static isShowing(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return [...MarkdownEditorProvider.instances].some(
      (editor) => editor.document?.uri.toString() === key
    );
  }

  public static register(context: vscode.ExtensionContext, mode: EditorMode = 'markdown'): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      mode === 'grid' ? MarkdownEditorProvider.gridViewType : MarkdownEditorProvider.viewType,
      new MarkdownEditorProviderFactory(context, mode),
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
  /** The text the webview is known to hold, in the webview's line endings. */
  private webviewText = '';
  /** The line the person is typing on, counted from zero, as their last edit left them. */
  private caretLine = 0;
  /** What the person has typed in the last few seconds, for saying when a write takes it. */
  private readonly typing = new RecentTyping();
  /**
   * Which notice about lost text is the current one, counted up for each.
   *
   * VS Code has no way to take a notification back once it is on screen, so a second
   * write while the first notice is still up leaves two of them there. This is what
   * keeps the older one from acting: its Undo belongs to a change that is no longer
   * the one the editor would take back, and pressing it does nothing.
   */
  private lostTextNotice = 0;
  /** The document's text when a save of Sheaf's own began, for as long as it runs. */
  private savingText?: string;
  /** The lines selected in this editor, as its webview last reported them. */
  private selectedRanges: SelectionRange[] = [];
  /** The reference for that selection, built by the webview that holds it. */
  private selectedRef = '';

  /** How a data file is framed for the webview; unset for a Markdown document. */
  private readonly frame?: DataFileFrame;
  /** Set when the file is too large to open as a grid, and the page says so instead. */
  private tooLarge = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    mode: EditorMode = 'markdown'
  ) {
    if (mode === 'grid') this.frame = new DataFileFrame();
  }

  public postMessage(message: ToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  /**
   * What the person has picked in this editor, and where. Undefined before the
   * webview has said, which is the moment between the tab opening and the editor
   * mounting.
   *
   * Several carets make several ranges. A reference names one place, so it is the
   * first of them, which the webview sends as the one the last gesture made.
   */
  public get selection(): DocumentSelection | undefined {
    const document = this.document;
    const first = this.selectedRanges[0];
    if (!document || !first) {
      return undefined;
    }
    return {
      path: vscode.workspace.asRelativePath(document.uri),
      start: first.start,
      end: first.end,
      ref: this.selectedRef,
    };
  }

  /** True while a change VS Code reports as Undo or Redo is being pushed to the webview. */
  private changeIsUndo = false;

  /** Replies to `freshSelection` still being waited for, by the id they were asked with. */
  private selectionWaiters = new Map<string, () => void>();
  private selectionAsked = 0;

  /**
   * The selection as the webview has it now, asked for rather than remembered.
   *
   * `selection` is what the webview last reported, and it reports on its own schedule:
   * a hundred milliseconds after a gesture finishes, so one pick does not become a
   * stream of messages. The keys that read it, Copy ref and Send to terminal, are
   * handled here in the extension host and reach it on a separate channel with no
   * ordering against the webview's reports. So a key pressed soon after a selection
   * could read the one before it, and right after a document opened that is the caret
   * where it opened, which is why a person sometimes got line 1 of the file instead of
   * what they had picked, sent to an agent as though it were right.
   *
   * So the key asks, the webview answers at once without the debounce, and this waits
   * a short while for the answer before falling back to what it last heard. The wait is
   * short because a person is waiting on the key; the fallback is no worse than before.
   */
  public async freshSelection(): Promise<DocumentSelection | undefined> {
    if (!this.webviewReady) return this.selection;
    const id = `sel-${++this.selectionAsked}`;
    const answered = new Promise<void>((resolve) => {
      this.selectionWaiters.set(id, resolve);
      this.postMessage({ type: 'getSelection', id });
    });
    const gaveUp = new Promise<void>((resolve) => setTimeout(resolve, SELECTION_REPLY_MS));
    await Promise.race([answered, gaveUp]);
    this.selectionWaiters.delete(id);
    return this.selection;
  }

  private panel?: vscode.WebviewPanel;

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.panel = webviewPanel;
    this.frame?.setFile(document.uri.path);
    this.webviewText = toWebviewText(document.getText());
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
      setContent: (text, tookTypedText) => {
        this.webviewText = text;
        if (this.tooLarge) return;
        this.postMessage({ type: 'setContent', text: this.shown(text), tookTypedText, ...(this.changeIsUndo ? { ownUndo: true } : {}) });
      },
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
      const text = e.document.getText();
      const outside = this.cameFromOutsideTheWebview(text);
      const arriving = this.keepTheLineBeingTyped(text);
      // Read before the push, because pushing is what replaces the webview's text.
      const lost = outside ? this.typing.dropped(this.webviewText, toWebviewText(arriving)) : undefined;
      // The other way a write undoes the person's work: it puts back what they deleted.
      const back = outside && lost === undefined ? this.typing.restored(this.webviewText, toWebviewText(arriving)) : undefined;
      // Undo and Redo from the Edit menu work on the document's own stack, so they reach
      // the webview the way a write from outside does. They are the person's own, and the
      // webview is told so, or it would mark the lines they restored as somebody else's.
      this.changeIsUndo = e.reason !== undefined;
      const reached = this.sync?.documentChanged(arriving, lost !== undefined || back !== undefined) ?? false;
      this.changeIsUndo = false;
      if (outside) {
        this.scheduleAutoSave(document);
      }
      if (outside && reached) {
        // Whatever was typed is either in this document or gone from it, so nothing
        // on record can be taken by a later write.
        this.typing.forget();
        if (lost !== undefined) {
          void this.sayWhatTheWriteTook(noticeAboutLostText(lost));
        } else if (back !== undefined) {
          void this.sayWhatTheWriteTook(noticeAboutRestoredText(back));
        }
      }
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
          const text = toWebviewText(document.getText());
          const rows = this.frame?.records(text) ?? 0;
          this.tooLarge = rows > GRID_MAX_ROWS;
          this.postMessage({
            type: 'init',
            text: this.tooLarge ? '' : this.shown(text),
            config: readConfig(),
            fileName: vscode.workspace.asRelativePath(document.uri),
            resourceBaseUri: baseUri.endsWith('/') ? baseUri : baseUri + '/',
            fragment,
            ...(this.frame ? { mode: 'csv' as const } : {}),
            ...(this.tooLarge ? { notice: tooLargeNotice(rows) } : {}),
          });
          break;
        }
        case 'edit': {
          if (this.tooLarge) break;
          const text = this.frame ? this.frame.unwrap(message.text, document.getText()) : message.text;
          if (text === undefined) {
            // The fence lines around a data file are the page's, not the file's, and an
            // edit that reached them cannot be read back as the file. Nothing is written,
            // and the webview is given back what it held before, as the person's own.
            this.postMessage({ type: 'setContent', text: this.shown(this.webviewText), ownUndo: true });
            break;
          }
          this.caretLine = lineAfterEdit(this.webviewText, text);
          this.typing.record(this.webviewText);
          this.webviewText = text;
          void this.sync?.edit(text);
          break;
        }
        case 'openAsText':
          // In the group this editor sits in: with the window split, the group that has
          // focus may be the other one, and the text would open over its document.
          void vscode.commands.executeCommand('sheaf.openAsText', document.uri, webviewPanel.viewColumn);
          break;
        case 'clipboardWrite':
          void vscode.env.clipboard.writeText(message.text);
          break;
        case 'clipboardRead':
          void vscode.env.clipboard.readText().then((text) => this.postMessage({ type: 'clipboardText', id: message.id, text }));
          break;
        case 'workspaceFilesRead':
          void this.workspaceFiles().then((files) => this.postMessage({ type: 'workspaceFiles', id: message.id, files }));
          break;
        case 'tableWidthsRead': {
          // Always answered, with nothing when nothing is kept, so the page never waits.
          const kept = this.context.workspaceState?.get<unknown>(tableWidthsKey(document.uri));
          this.postMessage({ type: 'tableWidths', id: message.id, widths: cleanTableWidths(kept) });
          break;
        }
        case 'tableWidthsWrite': {
          const widths = cleanTableWidths(message.widths);
          void this.context.workspaceState?.update(
            tableWidthsKey(document.uri),
            Object.keys(widths).length ? widths : undefined
          );
          break;
        }
        case 'tableBoardsRead': {
          // Answered like the widths: always, with nothing when nothing is kept.
          const kept = this.context.workspaceState?.get<unknown>(tableBoardsKey(document.uri));
          this.postMessage({ type: 'tableBoards', id: message.id, boards: cleanTableBoards(kept) });
          break;
        }
        case 'tableBoardsWrite': {
          const boards = cleanTableBoards(message.boards);
          void this.context.workspaceState?.update(
            tableBoardsKey(document.uri),
            Object.keys(boards).length ? boards : undefined
          );
          break;
        }
        case 'dataFileRead':
          if (typeof message.path === 'string') void this.answerDataFile(document.uri, docDir, message.path, message.id);
          break;
        case 'dataFileEdit':
          if (typeof message.path === 'string' && typeof message.base === 'string' && typeof message.text === 'string') {
            const step = message.step === 'undo' || message.step === 'redo' ? message.step : undefined;
            void this.editDataFile(document.uri, docDir, message.path, message.base, message.text, step);
          }
          break;
        case 'dataFileCreate':
          if (typeof message.id === 'string' && typeof message.path === 'string' && typeof message.text === 'string') {
            void this.createDataFile(document, docDir, message.id, message.path, message.text, message.nextFree === true);
          }
          break;
        case 'saveImage':
          void this.saveImage(docDir, message);
          break;
        case 'openLink':
          void this.openLink(document.uri, docDir, message.address);
          break;
        case 'setTableOfContents':
          void setTableOfContents(message.on);
          break;
        case 'selection':
          this.selectedRanges = message.ranges;
          this.selectedRef = message.ref;
          // An answer to freshSelection carries the id it was asked with.
          if (message.id) this.selectionWaiters.get(message.id)?.();
          break;
        case 'runCommand':
          // A menu item in the webview asking for one of Sheaf's own commands, which live in the
          // extension host because that is where the terminal and the clipboard are. The list is
          // closed on purpose: a message from a webview must not be able to run anything.
          if (message.command === 'sheaf.sendRefToTerminal') void vscode.commands.executeCommand(message.command);
          break;
        case 'blur':
          // Pressing the close button of the tab in front leaves this panel active until it
          // is gone, so the view-state flush above never runs and the close finds the file
          // dirty. Focus leaves the page on that press, before the close, and the page says
          // so. Anywhere else focus goes, this is VS Code's own save-on-focus-change.
          this.flushAutoSave(document);
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      this.flushAutoSave(document);
      changeSub.dispose();
      configSub.dispose();
      focusSub.dispose();
      msgSub.dispose();
      for (const watched of this.dataFiles.values()) watched.subs.forEach((s) => s.dispose());
      this.dataFiles.clear();
      MarkdownEditorProvider.instances.delete(this);
      if (MarkdownEditorProvider.active === this) {
        MarkdownEditorProvider.active = MarkdownEditorProvider.instances.values().next().value;
      }
    });
  }

  /**
   * The document as the webview is given it: a Markdown document as it is, and a data
   * file inside the fence that makes the webview draw it as a grid.
   */
  private shown(text: string): string {
    return this.frame ? this.frame.wrap(text) : text;
  }

  /**
   * The data files this editor's view blocks read, by the path the view wrote,
   * each watched for as long as the editor is open so a view follows the file.
   */
  private readonly dataFiles = new Map<string, { uri: vscode.Uri; subs: vscode.Disposable[] }>();

  /**
   * Answer a view block's request for a data file, and keep it current.
   *
   * The path is resolved against the document's folder and must stay inside the
   * workspace, or inside that folder for a document in no workspace. Anything else
   * is refused with a reason naming the path, which the view shows in place.
   */
  private async answerDataFile(documentUri: vscode.Uri, docDir: vscode.Uri, path: string, id?: string): Promise<void> {
    const target = resolveDataFile(documentUri, docDir, path);
    if ('problem' in target) {
      this.postMessage({ type: 'dataFile', id, path, error: target.problem });
      return;
    }
    this.watchDataFile(path, target.uri);
    await this.sendDataFile(path, target.uri, id);
  }

  /**
   * Write an edit made through a view into its data file.
   *
   * The webview sends the file's whole new text, and only the range that differs
   * is replaced, through the document VS Code holds for the file, so the edit is
   * one change in that file's undo history and any editor showing it follows. The
   * file keeps its line endings and its byte-order mark. If the file changed since
   * the view read it, nothing is written: the view is sent the file as it is now,
   * with a note saying the edit did not land, rather than overwriting what someone
   * else wrote. A file nobody else had unsaved changes in is saved straight away
   * when auto-save is on, so the edit reaches the disk the way an edit to the
   * document does.
   *
   * Cmd+Z on a view's file edit arrives here too, as the inverse edit, with `step`
   * saying so. It passes the same check, so an undo never writes over a change made
   * to the file after the edit it takes back.
   */
  private async editDataFile(
    documentUri: vscode.Uri,
    docDir: vscode.Uri,
    path: string,
    base: string,
    text: string,
    step?: 'undo' | 'redo'
  ): Promise<void> {
    const target = resolveDataFile(documentUri, docDir, path);
    if ('problem' in target) {
      this.postMessage({ type: 'dataFile', path, error: target.problem });
      return;
    }
    let file: vscode.TextDocument;
    try {
      file = await vscode.workspace.openTextDocument(target.uri);
    } catch {
      await this.sendDataFile(path, target.uri);
      return;
    }
    const current = file.getText();
    const bom = current.charCodeAt(0) === BOM ? '﻿' : '';
    if (toWebviewText(current.slice(bom.length)) !== base) {
      this.postMessage({
        type: 'dataFile',
        path,
        text: current,
        notice: step
          ? `${step === 'undo' ? 'Undo' : 'Redo'} did not change ${path}, because it changed after your edit. The view now shows the file as it is.`
          : `Your edit was not written, because ${path} changed after the view read it. The view now shows the file as it is.`,
      });
      return;
    }
    const plan = planEdit(current, bom + text, file.eol === vscode.EndOfLine.CRLF);
    if (!plan) return;
    const wasDirty = file.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, new vscode.Range(file.positionAt(plan.start), file.positionAt(plan.end)), plan.replacement);
    if (!(await vscode.workspace.applyEdit(edit))) {
      await this.sendDataFile(path, target.uri);
      return;
    }
    if (!wasDirty && readConfig().autoSave) await file.save();
    // A file not watched yet (an edit arriving before its read) is still sent back.
    if (!this.dataFiles.has(path)) await this.sendDataFile(path, target.uri);
  }

  /**
   * Write a new data file the person asked for: a block moved out of the document,
   * or the file a view names and does not find.
   *
   * The path goes through the same checks as a view's, so a file is only ever
   * written inside the workspace, or beside the document when it is in none. An
   * existing file is never written over. With `nextFree` the next free name is
   * taken (`tasks.csv`, then `tasks-2.csv`, `tasks-3.csv`), and without it the
   * request is refused, naming the file. The text arrives in the webview's line
   * endings and is written in the document's, so a block moved out of a CRLF
   * document keeps its bytes.
   */
  private async createDataFile(
    document: vscode.TextDocument,
    docDir: vscode.Uri,
    id: string,
    path: string,
    text: string,
    nextFree: boolean
  ): Promise<void> {
    const answer = (result: { path: string } | { error: string }): void =>
      this.postMessage({ type: 'dataFileCreated', id, ...result });
    if (this.frame) return answer({ error: 'A data file is written from a Markdown document, not from another data file.' });
    const written = path.trim();
    const dot = written.lastIndexOf('.');
    const stem = dot > 0 ? written.slice(0, dot) : written;
    const ext = dot > 0 ? written.slice(dot) : '';
    const bytes = new TextEncoder().encode(document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text);
    for (let n = 1; n <= MAX_FREE_NAMES; n++) {
      const candidate = n === 1 ? written : `${stem}-${n}${ext}`;
      const target = resolveDataFile(document.uri, docDir, candidate);
      if ('problem' in target) return answer({ error: target.problem });
      const open = (vscode.workspace.textDocuments ?? []).some((d) => d.uri.toString() === target.uri.toString());
      if (open || (await statOf(target.uri)) !== undefined) {
        if (!nextFree) {
          return answer({ error: `${candidate} already exists, and Sheaf never writes over a file. Open it, or name another file on the "from" line.` });
        }
        continue;
      }
      try {
        await vscode.workspace.fs.writeFile(target.uri, bytes);
      } catch (err) {
        return answer({ error: `${candidate} could not be written: ${reasonOf(err)}` });
      }
      return answer({ path: candidate });
    }
    answer({ error: `Every name from ${written} to ${stem}-${MAX_FREE_NAMES}${ext} is taken. Rename the block, or move some of those files.` });
  }

  /** Read a data file and send it, or say why it could not be read. */
  private async sendDataFile(path: string, uri: vscode.Uri, id?: string): Promise<void> {
    const read = await readTextFile(uri);
    this.postMessage(
      read === undefined
        ? {
            type: 'dataFile',
            id,
            path,
            error: `${path} was not found. A view reads its file relative to this document, so check the path on its "from" line.`,
            missing: true,
          }
        : { type: 'dataFile', id, path, text: read }
    );
  }

  /**
   * Send a data file again whenever it changes: on disk, from git or another
   * program, or in another editor in this window before it is saved.
   */
  private watchDataFile(path: string, uri: vscode.Uri): void {
    if (this.dataFiles.has(path)) return;
    const push = (): void => void this.sendDataFile(path, uri);
    const slash = uri.path.lastIndexOf('/');
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.slice(slash + 1))
    );
    const key = uri.toString();
    this.dataFiles.set(path, {
      uri,
      subs: [
        watcher,
        watcher.onDidChange(push),
        watcher.onDidCreate(push),
        watcher.onDidDelete(push),
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === key) push();
        }),
      ],
    });
  }

  /** The last workspace search, kept for a few seconds so typing several links in a row searches once. */
  private filesSearch?: { at: number; files: Promise<string[]> };

  /**
   * The workspace's files as workspace-relative paths, for completing a link's
   * address. Dependencies, Git's own folder and build output are left out, VS Code's
   * `files.exclude` still applies, and a very large workspace is cut off rather than
   * searched to the end, because a list that long is reached by typing anyway.
   */
  private workspaceFiles(): Promise<string[]> {
    const now = Date.now();
    if (this.filesSearch && now - this.filesSearch.at < FILES_CACHE_MS) return this.filesSearch.files;
    const files = Promise.resolve(vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**}', MAX_WORKSPACE_FILES))
      .then((uris) => uris.map((uri) => vscode.workspace.asRelativePath(uri).replace(/\\/g, '/')))
      .catch(() => []);
    this.filesSearch = { at: now, files };
    return files;
  }

  /**
   * Tell the person that the write which just landed took text they had typed, and
   * offer it back.
   *
   * Nothing is written here. The editor has already made that document its own undo
   * step, so this offer and the person's own Undo key do the same thing, and neither
   * of them puts back anything the person did not type. Saying nothing is the bug
   * this replaces: the text simply was not there any more, with no notice and nothing
   * in the undo history to reach for.
   */
  private async sayWhatTheWriteTook(message: string): Promise<void> {
    const notice = ++this.lostTextNotice;
    const answer = await vscode.window.showWarningMessage(message, UNDO);
    if (answer !== UNDO || notice !== this.lostTextNotice) {
      return;
    }
    this.postMessage({ type: 'undoOutsideChange' });
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
   *
   * Every way this can fail says why, in a notification and in the reply the
   * webview gets. A paste that quietly does nothing reads as an editor that
   * cannot take images at all, and the two common reasons are both something
   * the person can act on: a document that has never been saved has no folder
   * to put an image beside, and a plain file named `assets` sitting there
   * leaves nowhere to make the folder.
   */
  private async saveImage(
    docDir: vscode.Uri,
    msg: { id: string; name: string; data: string }
  ): Promise<void> {
    const refuse = (reason: string): void => {
      void vscode.window.showWarningMessage(reason);
      this.postMessage({ type: 'imageSaved', id: msg.id, error: reason });
    };

    if (!this.document || this.document.isUntitled) {
      refuse(
        'Sheaf: save the document before pasting images. They go into an assets folder beside it, ' +
          'and a document that has never been saved has no folder yet.'
      );
      return;
    }

    const assetsDir = vscode.Uri.joinPath(docDir, IMAGE_FOLDER);
    const where = vscode.workspace.asRelativePath(assetsDir);
    const folder = await statOf(assetsDir);
    if (folder && folder.type !== vscode.FileType.Directory) {
      refuse(
        `Sheaf: could not save the image, because ${where} is a file rather than a folder. ` +
          'Pasted images go into a folder of that name beside the document.'
      );
      return;
    }
    if (!folder) {
      try {
        await vscode.workspace.fs.createDirectory(assetsDir);
      } catch (err) {
        refuse(`Sheaf: could not create ${where} to save the image into. ${reasonOf(err)}`);
        return;
      }
    }

    const safe = sanitizeFileName(msg.name);
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';

    let name = safe;
    for (let i = 1; await uriExists(vscode.Uri.joinPath(assetsDir, name)); i++) {
      name = `${stem}-${i}${ext}`;
    }

    try {
      const target = vscode.Uri.joinPath(assetsDir, name);
      await vscode.workspace.fs.writeFile(target, Buffer.from(msg.data, 'base64'));
      this.postMessage({ type: 'imageSaved', id: msg.id, path: `${IMAGE_FOLDER}/${name}` });
    } catch (err) {
      refuse(`Sheaf: could not save the image into ${where}. ${reasonOf(err)}`);
    }
  }

  /**
   * True when a change to the document came from something other than this webview.
   *
   * VS Code's own Undo, in the Command Palette and in the Edit menu, does not reach a
   * custom editor's webview at all: it undoes the document's edit stack, which is
   * where every edit Sheaf makes is written. So does a formatter, a code action, or a
   * command any other extension runs. Sheaf shows the result, and unless the file is
   * written too, Undo leaves the person reading one document while the file on disk
   * still holds the edit they took back.
   *
   * Two changes are Sheaf's own and must not schedule a second save. An edit of this
   * webview's arrives holding exactly the text the webview already has, and a trim by
   * a save participant arrives while that save is still running.
   */
  private cameFromOutsideTheWebview(text: string): boolean {
    return this.savingText === undefined && toWebviewText(text) !== this.webviewText;
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
      this.save(document);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Write the document to disk, remembering what it held as the write began.
   *
   * Saving runs VS Code's save participants, which may edit the document on the
   * way out, and `keepTheLineBeingTyped` needs to know what they changed it from.
   */
  private save(document: vscode.TextDocument): void {
    if (!writable(document)) {
      return;
    }
    this.savingText = document.getText();
    void Promise.resolve(document.save()).finally(() => {
      this.savingText = undefined;
    });
  }

  /**
   * A document change with the whitespace the person is typing in left in place.
   *
   * `files.trimTrailingWhitespace` is applied by a save participant, so a space at
   * the end of a line is gone the moment the file is written. VS Code's own
   * editors are spared that: the participant reads the cursors of the text editors
   * showing the file and leaves the whitespace they sit in alone, which is why
   * typing `hello `, waiting for auto-save and carrying on with `world` gives
   * `hello world` there. A custom editor has no text editor behind it and so no
   * cursor for the participant to find, and Sheaf then took the trimmed text as
   * news from outside and sent it back to the webview, which is how the space
   * disappeared mid-word and ran `helloworld` together.
   *
   * So Sheaf makes the same exception for its own saves. The trim still reaches
   * the file, which is what the setting asked for; only the line the person is on
   * keeps what they typed, until they move off it and the next save takes it. A
   * trim by anything else, a formatter or another editor or a pull, is news and
   * goes through untouched.
   */
  private keepTheLineBeingTyped(text: string): string {
    const before = this.savingText;
    if (before === undefined || text === before) {
      return text;
    }
    // Anything but trailing whitespace means the participants did something else,
    // and whatever that was belongs in the webview as it stands.
    if (trimTrailingWhitespace(text) !== trimTrailingWhitespace(before)) {
      return text;
    }
    return withLineFrom(text, before, this.caretLine);
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
    this.save(document);
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
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mode: EditorMode
  ) {}
  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    return new MarkdownEditorProvider(this.context, this.mode).resolveCustomTextEditor(
      document,
      webviewPanel,
      token
    );
  }
}

/**
 * A .csv or .tsv file framed as the one fenced block of a Markdown document, which is
 * what the webview already draws as a grid.
 *
 * The webview holds `` ```csv ``, a newline, the file, a newline and the closing
 * fence, and nothing else. Every text it posts back is read by taking exactly those
 * two lines off again, so the file is written from what lies between them and the
 * sync plans its edit against the file's own bytes. A posted text whose fence lines
 * are not the ones it was given is not read at all.
 *
 * A byte-order mark is the file's encoding, not a character of its first cell, so it
 * is left out of the frame and put back in front of whatever is read out of it.
 */
class DataFileFrame {
  private lang: 'csv' | 'tsv' = 'csv';
  /** The fence the webview was last given, which a posted text must still carry. */
  private fence = '```';

  /** Take the dialect from the file's extension. */
  setFile(path: string): void {
    this.lang = /\.tsv$/i.test(path) ? 'tsv' : 'csv';
  }

  wrap(text: string): string {
    const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
    this.fence = fenceFor(body);
    return `${this.fence}${this.lang}\n${body}\n${this.fence}`;
  }

  /** The file's text inside a posted frame, or undefined when the frame is not intact. */
  unwrap(shown: string, documentText: string): string | undefined {
    const open = `${this.fence}${this.lang}\n`;
    const close = `\n${this.fence}`;
    if (shown.length < open.length + close.length || !shown.startsWith(open) || !shown.endsWith(close)) {
      return undefined;
    }
    const body = shown.slice(open.length, shown.length - close.length);
    // A line inside that would close the fence ends the block early, and the rest of
    // the file would be read as Markdown below it.
    if (closingFence(this.fence).test(body)) return undefined;
    return (documentText.charCodeAt(0) === BOM ? '﻿' : '') + body;
  }

  /** How many records the file holds, header included, as the grid would count them. */
  records(text: string): number {
    return countRecords(text, this.lang === 'tsv' ? '\t' : ',');
  }
}

/** U+FEFF, the byte-order mark. */
const BOM = 0xfeff;

/** A line that would close a fence opened with `fence`. */
function closingFence(fence: string): RegExp {
  return new RegExp(`^ {0,3}${fence}\`*[ \\t]*\\r?$`, 'm');
}

/**
 * The shortest backtick fence no line of `body` can close: three, or one more than
 * the longest run of backticks any line opens with.
 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/^ {0,3}(`+)/gm)) longest = Math.max(longest, match[1].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The records in delimited text: its lines, less the blank ones, with a line break
 * inside a quoted field counted as part of the record it is in. A quote opens a
 * quoted field only at the start of one, which is how the grid reads it too.
 */
function countRecords(text: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  let fresh = true;
  let content = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      content = true;
    } else if (ch === delimiter) {
      fresh = true;
      content = true;
    } else if (ch === '\n') {
      if (content) count++;
      content = false;
      fresh = true;
    } else if (ch !== '\r') {
      fresh = false;
      if (ch.trim() !== '') content = true;
    }
  }
  return content ? count + 1 : count;
}

/** What the page says in place of a grid for a file with more rows than one can hold. */
function tooLargeNotice(rows: number): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  return (
    `This file has ${n(rows)} rows. Sheaf opens data files up to ${n(GRID_MAX_ROWS)} rows as a grid; ` +
    'use Reopen Editor With to edit it as text.'
  );
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
 * The data file a view block names, or why it names none Sheaf will read.
 *
 * A view names its file relative to the document, the way a link or an image
 * does, so the reference reads the same in the repository as it does here. An
 * absolute path would not, and neither would one that climbs out of the
 * workspace: both are refused rather than read, since a document that reaches
 * outside its repository is not one a teammate can open. Only .csv and .tsv
 * files are read at all.
 */
export function resolveDataFile(
  documentUri: vscode.Uri,
  docDir: vscode.Uri,
  path: string
): { uri: vscode.Uri } | { problem: string } {
  const written = path.trim();
  if (!/\.(csv|tsv)$/i.test(written)) {
    return { problem: `A view reads a .csv or .tsv file, and "${written}" is neither.` };
  }
  if (/^([a-zA-Z]:)?[\\/]/.test(written) || /^[a-zA-Z][\w+.-]*:/.test(written)) {
    return {
      problem: `"${written}" is an absolute path. Name the file relative to this document, as in "data/tasks.csv", so the view reads the same everywhere the repository is checked out.`,
    };
  }
  const uri = vscode.Uri.joinPath(docDir, written.replace(/\\/g, '/'));
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  const root = (folder?.uri ?? docDir).path.replace(/\/$/, '');
  if (!uri.path.startsWith(root + '/')) {
    return {
      problem: folder
        ? `"${written}" is outside this workspace. A view reads data files inside the workspace folder, so the document and its data travel together.`
        : `"${written}" is outside this document's folder. A document that is not in a workspace can read data files beside it or below it.`,
    };
  }
  return { uri };
}

/**
 * A text file's contents: from the editor holding it when one is open, so an
 * unsaved change is what a view shows, and from disk otherwise. Undefined when
 * there is no such file.
 */
async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  const open = (vscode.workspace.textDocuments ?? []).find((d) => d.uri.toString() === key);
  if (open) return open.getText();
  try {
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * True when a document is Sheaf's to save: still open, actually changed, and backed
 * by a file. Saving an untitled document opens a Save As dialog, which is the same
 * surprise auto-save exists to avoid.
 */
function writable(document: vscode.TextDocument): boolean {
  return !document.isClosed && !document.isUntitled && document.isDirty;
}

/**
 * The line the caret is on once the webview's text has become `after`, counted
 * from zero. The webview posts its whole document rather than the caret, and the
 * end of the one run of characters that changed is where the person just typed.
 */
function lineAfterEdit(before: string, after: string): number {
  const edit = minimalEdit(before, after);
  const upTo = after.slice(0, edit.start + edit.replacement.length);
  let line = 0;
  for (let i = 0; i < upTo.length; i++) {
    if (upTo.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** `text` with every run of spaces and tabs at the end of a line removed. */
function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, '');
}

/**
 * `text` with one line taken from `source` instead, counted from zero.
 *
 * Only whitespace may come back this way, and only onto the end of the line that
 * lost it. Anything else means the two texts are not the pair this was meant for,
 * and `text` is returned as it is rather than guessed at.
 */
function withLineFrom(text: string, source: string, line: number): string {
  const lines = text.split('\n');
  const from = source.split('\n');
  if (line >= lines.length || line >= from.length) {
    return text;
  }
  // Splitting a CRLF document on its newlines leaves the carriage return at the
  // end of each piece, where it sits behind the whitespace being compared.
  const withoutReturn = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);
  const trimmed = withoutReturn(lines[line]);
  const original = withoutReturn(from[line]);
  if (!original.startsWith(trimmed) || /[^ \t]/.test(original.slice(trimmed.length))) {
    return text;
  }
  lines[line] = from[line];
  return lines.join('\n');
}

/** Strip path separators and unsafe characters from an uploaded filename. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'image';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'image.png';
}

/** True if a file/folder exists at the given URI. */
async function uriExists(uri: vscode.Uri): Promise<boolean> {
  return (await statOf(uri)) !== undefined;
}

/** What is at the given URI, or undefined when there is nothing there. */
async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/** The part of a thrown error worth putting in front of a person. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
