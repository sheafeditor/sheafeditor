import * as vscode from 'vscode';
import { DocumentSync, mergeOutsideChange, minimalEdit, planEdit, toWebviewText } from './textSync';
import {
  readComments,
  readFrontMatter,
  readOutline,
  type CommentsSetting,
  type FrontMatterSetting,
  type OutlineSetting,
} from './settingValues';
import {
  noticeAboutLostText,
  noticeAboutOutsideChangeLost,
  noticeAboutRestoredText,
  RecentTyping,
} from './recentTyping';
import type {
  CommentFolds,
  EditorConfig,
  FromWebview,
  SelectionRange,
  TableBoards,
  TableWidths,
  ToWebview,
} from './protocol';
import { documentTitle, relativeLink } from './docLink';

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

/** Where a document's boards are kept: beside its widths, in the workspace's own storage. */
const tableBoardsKey = (uri: vscode.Uri): string => `sheaf.tableBoards:${uri.toString()}`;

/** The longest header text a board may be grouped by; anything longer is not a header the page wrote. */
const MAX_BOARD_GROUP = 1000;

/**
 * How long Sheaf's own save goes on counting as something a write cannot have known
 * about, and so how far back a merge may reach for the base a write was made from.
 *
 * Long enough to cover the gap the race lives in: a keystroke reaches the document at
 * once, auto-save writes it about 700ms later, and a tool that read the file before
 * that writes it back a moment after. Short enough that it is still the person's own
 * save that was the last thing to happen, which is the whole claim the number stands
 * on. Reopening a file an hour later and finding deleted text back is what a larger
 * number would buy.
 */
export const KEEP_AFTER_OWN_SAVE_MS = 2_500;

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

/** Where a document's collapsed comments are kept: beside its widths and boards. */
const commentFoldsKey = (uri: vscode.Uri): string => `sheaf.commentFolds:${uri.toString()}`;

/**
 * Where one document's own front matter state is kept, beside its widths, its boards
 * and its comment folds. The setting says what a document does by default; this says
 * what this one does, and it is here rather than in the file because how much metadata
 * somebody wants to look at is not something to write into their document.
 */
const frontMatterKey = (uri: vscode.Uri): string => `sheaf.frontMatter:${uri.toString()}`;

/** The same, for whether this document's heading list is folded away. */
const outlineKey = (uri: vscode.Uri): string => `sheaf.outline:${uri.toString()}`;

/** The longest comment key the webview writes; anything longer is not one of its digests. */
const MAX_COMMENT_KEY = 64;

/** Keep only what can be a collapsed comment, so a damaged or foreign value reads as none. */
function cleanCommentFolds(value: unknown): CommentFolds {
  const out: CommentFolds = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, folded] of Object.entries(value as Record<string, unknown>)) {
    if (key && key.length <= MAX_COMMENT_KEY && folded === true) out[key] = true;
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

export type { CommentsSetting, FrontMatterSetting, OutlineSetting };

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
    lineNumbers: cfg.get<boolean>('lineNumbers', false),
    revealSyntaxOnLine: cfg.get<boolean>('revealSyntaxOnLine', false),
    doubleClickToEditSource: cfg.get<boolean>('doubleClickToEditSource', false),
    tableOfContents: readOutline(cfg.get<unknown>('tableOfContents', 'hidden')),
    comments: readComments(cfg.get<unknown>('comments', 'show')),
    frontMatter: readFrontMatter(cfg.get<unknown>('frontMatter', 'collapsed')),
  };
}

/**
 * Whether a keystroke is written to disk on its own.
 *
 * Read on its own rather than carried in `EditorConfig`, because that type is what the
 * editor page is sent and the page has no use for this: the host decides when to save.
 * A setting in the page's config that the page never reads is one nobody can tell is
 * unread, which is how the two declarations of that type drift.
 */
function autoSaveOn(): boolean {
  return vscode.workspace.getConfiguration('sheaf').get<boolean>('autoSave', true);
}

/** How much of the heading list is drawn, as the setting has it now. */
export function outlineSetting(): OutlineSetting {
  return readOutline(vscode.workspace.getConfiguration('sheaf').get<unknown>('tableOfContents', 'hidden'));
}

/** Whether the heading list is on screen at all, as the setting has it now. */
export function tableOfContentsOn(): boolean {
  return outlineSetting() !== 'hidden';
}

/**
 * Draw the front matter in full, as one line, or not at all, for every Sheaf editor
 * and for next time. Written to user settings rather than to the folder, because it
 * is how this person likes to read a document rather than anything about the project.
 */
export async function setFrontMatter(value: FrontMatterSetting): Promise<void> {
  await vscode.workspace.getConfiguration('sheaf').update('frontMatter', value, vscode.ConfigurationTarget.Global);
}

/** Whether comments are drawn in full, as the setting has it now. */
export function commentsSetting(): CommentsSetting {
  return readComments(vscode.workspace.getConfiguration('sheaf').get<unknown>('comments', 'show'));
}

/**
 * Show or hide comments, for every Sheaf editor and for next time.
 *
 * The write goes to user settings, beside the table of contents and for the same
 * reason: whether notes to the writer are in the way is something a person wants
 * or does not want while they are reading, rather than something a repository
 * decides for them. Every open editor hears about it through the
 * configuration-change listener each one already has.
 */
export async function setComments(value: CommentsSetting): Promise<void> {
  await vscode.workspace.getConfiguration('sheaf').update('comments', value, vscode.ConfigurationTarget.Global);
}

/**
 * Turn the table of contents on or off, for every Sheaf editor and for next time.
 *
 * The write goes to user settings, the way View: Toggle Minimap writes
 * `editor.minimap.enabled`: a panel is something a person wants or does not want, not
 * something they want in one file. Every open editor hears about it through the
 * configuration-change listener each one already has, so none of them is told directly.
 */
/**
 * Turn the line-number gutter on or off, for this document and every other.
 *
 * User settings, for the reason the heading list above gives: line numbers are something a
 * person wants or does not want, not something they want in one file. VS Code settles its
 * own the same way, in `editor.lineNumbers`, so somebody who wants them in both places sets
 * two settings rather than learning two mechanisms.
 *
 * It was a module variable in the webview before this, so turning them on lasted until the
 * document closed and every document opened without them.
 */
export async function setLineNumbers(on: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('sheaf').update('lineNumbers', on, vscode.ConfigurationTarget.Global);
}

export async function setTableOfContents(on: boolean | OutlineSetting): Promise<void> {
  // `readOutline` rather than the same three cases written out here, which is what this
  // was: the file it comes from is already imported above, and the browser host needed
  // the identical reconciliation and had none, which is how a `true` from the toolbar
  // came to be stored out there in a field declared as one of three names. A string that
  // is none of the three now lands on `hidden` instead of being written to the settings
  // as given, which is the one behaviour this changes and the better of the two.
  await vscode.workspace
    .getConfiguration('sheaf')
    .update('tableOfContents', readOutline(on), vscode.ConfigurationTarget.Global);
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
  /**
   * The same editor, offered for .txt files and never the default for one.
   *
   * A second view type rather than another pattern on the first, because whether an
   * editor opens a file by itself is settled per view type and not per pattern. A
   * `.txt` is somebody's notes as often as it is a log or a fixture, so Sheaf is
   * there to be chosen and double-clicking one still opens the text editor.
   */
  public static readonly textViewType = 'sheaf.text';
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

  public static register(
    context: vscode.ExtensionContext,
    mode: EditorMode = 'markdown',
    viewType = mode === 'grid' ? MarkdownEditorProvider.gridViewType : MarkdownEditorProvider.viewType
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      viewType,
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
  /**
   * The texts this editor knows the file has held, oldest first: what it held when
   * the document opened, and every text handed to a save since.
   *
   * Two jobs, and the second is why this is a list rather than one text. The last of
   * them is the base a merge is made against, which is as close as there is to what
   * anything writing the file read. And finding the file's current contents anywhere
   * in the list is what says the write was Sheaf's own.
   *
   * That second job is not something a single text can do. A save resolves before
   * its bytes are always visible: reading the file right afterwards can still return
   * what it held before, and a document being typed into produces saves faster than
   * they land. Against one remembered text, every one of those reads looks like
   * somebody else's write, the person's own letters read as a conflict, and a notice
   * goes up about a write nobody made.
   */
  private readonly fileHasHeld: { text: string; at: number }[] = [];
  /** True while a change read back from the file is being written into the document. */
  private mergingOutsideChange = false;
  /**
   * True once the file has been found to have moved under what VS Code noted about
   * it, which is what makes it refuse to write this document at all.
   */
  private fileMovedUnderTheRecord = false;
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
    // A document that opens clean is the file. One that opens dirty, restored from a
    // previous session, is not, and nothing here knows what the file holds until the
    // first save settles it.
    if (!document.isDirty) this.rememberFile(document.getText());
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
      // Read before this text is remembered, so the newest text on record is still
      // Sheaf's own save and the one before it is what a write crossing that save read.
      const writerBase = this.textTheWriterRead();
      // A document that is clean after a change is one VS Code has just brought into
      // line with the file: reloaded because the file moved while nothing was unsaved,
      // or reverted. Either way this is the file, and it is the base a later merge needs.
      if (!e.document.isDirty) {
        this.rememberFile(text);
      }
      const outside = this.cameFromOutsideTheWebview(text);
      const asItArrived = this.keepTheLineBeingTyped(text);
      let arriving = asItArrived;
      if (outside) {
        arriving = this.keepTypingTheWriteCouldNotHaveSeen(writerBase, arriving, e.document);
        if (arriving !== asItArrived) {
          // Showing the page the merged text is not the same as the file getting it. The
          // document still holds what VS Code reloaded, and the save that follows writes the
          // document, so without this the letter stays on screen and never reaches disk:
          // the screen and the file disagree with nothing said, which is worse than the loss
          // it replaced, because that at least announced itself and offered Undo.
          void this.writeMergedIntoDocument(e.document, arriving);
        }
      }
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
          // Both sides of the edit: an edit's span is only knowable while it happens, and working
          // it out later from a baseline attributes anything that arrived from outside to the
          // person as well.
          this.typing.record(this.webviewText, text);
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
        case 'workspaceFilesRead':
          void this.workspaceFiles().then((files) => this.postMessage({ type: 'workspaceFiles', id: message.id, files }));
          break;
        case 'docTitleRead':
          // Always answered, with nothing when the path names nothing to link, so the page
          // never waits out its timeout for a paste it could have made plain at once.
          void this.docTitle(document.uri, message.path).then((answer) =>
            this.postMessage({ type: 'docTitle', id: message.id, ...answer })
          );
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
        case 'commentFoldsRead': {
          // Answered like the widths and the boards: always, with nothing when
          // nothing is kept, so the page never waits on an answer that never comes.
          const kept = this.context.workspaceState?.get<unknown>(commentFoldsKey(document.uri));
          this.postMessage({ type: 'commentFolds', id: message.id, folds: cleanCommentFolds(kept) });
          break;
        }
        case 'commentFoldsWrite': {
          const folds = cleanCommentFolds(message.folds);
          void this.context.workspaceState?.update(
            commentFoldsKey(document.uri),
            Object.keys(folds).length ? folds : undefined
          );
          break;
        }
        case 'frontMatterStateRead': {
          // Answered like the widths and the folds: always, with null when this
          // document has no state of its own, so the page never waits.
          const kept = this.context.workspaceState?.get<unknown>(frontMatterKey(document.uri));
          const state = kept === 'shown' || kept === 'collapsed' || kept === 'hidden' ? kept : null;
          this.postMessage({ type: 'frontMatterState', id: message.id, state });
          break;
        }
        case 'frontMatterStateWrite': {
          // Null is the page saying this document should follow the setting again.
          const value = message.state;
          void this.context.workspaceState?.update(
            frontMatterKey(document.uri),
            value === 'shown' || value === 'collapsed' || value === 'hidden' ? value : undefined
          );
          break;
        }
        case 'outlineStateRead': {
          const kept = this.context.workspaceState?.get<unknown>(outlineKey(document.uri));
          const state = kept === 'shown' || kept === 'collapsed' || kept === 'hidden' ? kept : null;
          this.postMessage({ type: 'outlineState', id: message.id, state });
          break;
        }
        case 'outlineStateWrite': {
          const value = message.state;
          void this.context.workspaceState?.update(
            outlineKey(document.uri),
            value === 'shown' || value === 'collapsed' || value === 'hidden' ? value : undefined
          );
          break;
        }
        case 'dataFileRead':
          if (typeof message.path === 'string') void this.answerDataFile(document.uri, docDir, message.path, message.id);
          break;
        case 'dataFileEdit':
          if (typeof message.path === 'string' && typeof message.base === 'string' && typeof message.text === 'string') {
            const step = message.step === 'undo' || message.step === 'redo' ? message.step : undefined;
            const { id, path } = message;
            /*
             * Answered when the work is done, with no error, because this host says what went wrong
             * through `dataFile` instead: a path it cannot resolve, a file it cannot open, and an
             * edit against a version the file no longer holds each send the view the file as it is
             * with a sentence attached. The acknowledgement's job here is to stop the editor's timer,
             * which otherwise fires on every successful edit and tells the person their edit may not
             * have landed when it did.
             *
             * An error on this message is for a host that has no other way to say so, which is what
             * a browser tab now uses it for.
             */
            void this.editDataFile(document.uri, docDir, path, message.base, message.text, step).then(() => {
              this.postMessage({ type: 'dataFileEdited', id });
            });
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
        case 'setLineNumbers':
          void setLineNumbers(message.on);
          break;
        case 'setTableOfContents':
          void setTableOfContents(message.on);
          break;
        case 'setFrontMatter':
          void setFrontMatter(message.state);
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
    if (!wasDirty && autoSaveOn()) await file.save();
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
   * What a pasted path names: the target written as an address relative to `from`, and the
   * target's own title.
   *
   * Only the host can answer this. The page cannot read another file, and it cannot work out
   * what a relative path is relative to — its own origin is `vscode-webview://`, which reaches
   * nothing.
   *
   * Nothing is answered for a path that leaves the workspace, names something that is not
   * Markdown, or names a file that is not there, and the editor pastes the text as text. The
   * workspace boundary is the one that matters: a path outside it resolves, reads and links
   * fine, and the link is then broken for everybody who clones the repository.
   */
  private async docTitle(from: vscode.Uri, pasted: string): Promise<{ address?: string; title?: string }> {
    const raw = pasted.trim();
    if (!/\.(md|markdown)$/i.test(raw)) return {};
    let target: vscode.Uri;
    try {
      if (/^file:/i.test(raw)) target = vscode.Uri.parse(raw);
      else if (/^(\/|[A-Za-z]:[\\/])/.test(raw)) target = vscode.Uri.file(raw);
      // `..` from the document itself is the folder it sits in, which is what a relative
      // path in a document is relative to.
      else target = vscode.Uri.joinPath(from, '..', raw.replace(/\\/g, '/'));
    } catch {
      return {};
    }
    if (!vscode.workspace.getWorkspaceFolder(target)) return {};
    let text: string;
    try {
      // Through the workspace rather than the file system, so a target already open with
      // unsaved changes gives the title it now has rather than the one on disk.
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
      text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    } catch {
      return {};
    }
    const address = relativeLink(from.path, target.path);
    return { address, title: documentTitle(text, target.path) };
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
   * Three changes are Sheaf's own and must not schedule a second save. An edit of
   * this webview's arrives holding exactly the text the webview already has, a trim
   * by a save participant arrives while that save is still running, and a change
   * written to the file arrives put together with what the person typed.
   *
   * That last one carries somebody else's work, so it is news to the webview and is
   * pushed there like any other. What it is not is a write that cost the person
   * anything: it is the merge, and the merge keeps their text by construction. Read
   * as an outside write it says the opposite, because their typing sits between the
   * two places an agent changed and the span from one to the other covers it. That
   * notice would be wrong every single time.
   *
   * A save being outstanding is not on that list, and reading it as though it were
   * took typed text off the screen with nothing said. The window between a save's
   * write landing and Sheaf hearing that its own save is done is real: the write and
   * the watcher event that follows it are separate turns of the event loop, so a
   * write from an agent a moment later is reported inside that window. Called an echo
   * of Sheaf's own save, it went into the webview unopposed, no notice was worked out
   * because none is worked out for Sheaf's own changes, and no save was scheduled to
   * carry anything back, so a letter the person had just typed was gone from the
   * screen and from the file at once. What makes a change the echo of a save is that
   * it holds the text handed to that save, give or take a participant's trim, and
   * nothing else does.
   */
  private cameFromOutsideTheWebview(text: string): boolean {
    if (this.mergingOutsideChange || toWebviewText(text) === this.webviewText) {
      return false;
    }
    return !this.isOurSavesTrim(text);
  }

  /**
   * True when `text` is the text a save handed over with trailing whitespace taken off,
   * which is a save participant's edit and so Sheaf's own work rather than news.
   *
   * Two callers ask this, and they are the same question with different consequences, which
   * is why it is one function rather than two copies of the comparison.
   * `cameFromOutsideTheWebview` asks it to decide whether a change is news, which governs
   * the notice, the save it would schedule, and whether the record of recent typing is
   * thrown away. `keepTheLineBeingTyped` asks it to decide what text the webview is given.
   *
   * Both are load-bearing, measured rather than assumed. Making the first answer false
   * always fails "a save of their own does not throw away the record of what they typed",
   * because the record of what the person typed is what lets the *next* write be recognised
   * as taking it. Removing the second fails two trailing-whitespace checks, because the
   * space under the person's own cursor disappears mid-word.
   */
  private isOurSavesTrim(text: string): boolean {
    const saving = this.savingText;
    return saving !== undefined && trimTrailingWhitespace(text) === trimTrailingWhitespace(saving);
  }

  /**
   * Auto-save the way a notes app does: after edits settle, persist the file to
   * disk. This runs on top of VS Code's own dirty/undo model, so undo still works
   * and hot exit is unaffected. Debounced so we save once per pause, not per
   * keystroke. Opt out with `sheaf.autoSave: false` (then normal save /
   * files.autoSave apply).
   */
  private scheduleAutoSave(document: vscode.TextDocument): void {
    if (!autoSaveOn()) {
      return;
    }
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = undefined;
      void this.saveKeepingOutsideChange(document);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * The debounced save, with anything written to the file meanwhile kept.
   *
   * Only this path reads the file first. The flush on losing focus and on dispose
   * stays as it is, because it runs in the moments before a document closes and its
   * whole reason for existing is to get the write in before VS Code asks about it;
   * waiting on a file read there would put the dialog back.
   */
  private async saveKeepingOutsideChange(document: vscode.TextDocument): Promise<void> {
    await this.keepOutsideChange(document);
    this.save(document);
  }

  /**
   * The save VS Code refused, done by hand.
   *
   * VS Code notes a file's modification time when it loads or saves a document, and
   * refuses to write one whose file has moved since: "The content of the file is
   * newer." It only ever brings that note up to date by reading the file again, and
   * it will not read the file into a document that has unsaved changes. So once
   * anything writes the file while somebody is typing, every save of that document
   * fails from then on. Auto-save is on, the tab says unsaved, closing it asks, and
   * none of it has anything to do with the person at the keyboard.
   *
   * What makes this safe to resolve without asking is that the write is read in
   * first. The refusal is itself the news that the file has moved, and it may have
   * moved after the last read, which is exactly why the save was refused, so the
   * file is read and put into the document again here before anything is written
   * over it. Only then is the document the file plus the letters typed since, rather
   * than a rival version of it.
   *
   * Reading first is not a precaution. Without it this wrote the document's own text
   * over whatever had just arrived, so a paragraph an agent deleted came back, in the
   * file and on screen, with nothing said: the very loss the merge exists to prevent,
   * reintroduced by the thing meant to finish the job.
   *
   * Then the document is reverted, which is what brings VS Code's note up to date.
   * The revert changes no text, because the file was just made to match, and the
   * person's own Undo is CodeMirror's inside the page rather than the document's
   * stack.
   *
   * Two things are left alone deliberately. The write goes ahead only while the
   * document still holds the text the refused save carried, so a keystroke that
   * arrived meanwhile is never written over: the next save carries it instead. And
   * the revert needs this editor to be the active one, because the command works on
   * whatever the person is looking at. When it is not, the file has still been
   * written and only the unsaved mark is left over, which the next save clears.
   */
  private async writeOverTheMovedFile(document: vscode.TextDocument, text: string): Promise<void> {
    if (document.isClosed || document.getText() !== text) {
      return;
    }
    await this.keepOutsideChange(document);
    if (document.isClosed) {
      return;
    }
    // The document after the merge, which is what the file is given: the write that
    // was refused carried the text from before it.
    const merged = document.getText();
    try {
      /*
       * A byte-order mark is not part of a document's text, so writing the text alone
       * would take the mark off a file that had one. VS Code's own save keeps it, and
       * a mark disappearing from a file nobody edited is exactly the kind of change
       * that turns a one-word edit into a whole-file diff.
       */
      const had = await vscode.workspace.fs.readFile(document.uri);
      // Read again after the merge, because writing is only safe over a file this
      // editor has read. A file that moved once can move twice, and the list of what
      // it has held is what says whether this is still the write just merged in.
      const hadText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(had);
      if (!this.fileHasHeld.some((held) => held.text === hadText)) {
        return; // Moved again. The next save reads that one in the same way.
      }
      const mark = had[0] === 0xef && had[1] === 0xbb && had[2] === 0xbf;
      const keeping = mark && !merged.startsWith('﻿') ? `﻿${merged}` : merged;
      await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(keeping));
      this.rememberFile(keeping);
    } catch {
      return; // Not writable by us either. VS Code has already said so.
    }
    this.fileMovedUnderTheRecord = true;
    if (document.isClosed || document.getText() !== merged || this.panel?.active !== true) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.files.revert');
    // The revert read the file, so what VS Code noted about it is current again and
    // ordinary saves work from here.
    if (!document.isDirty) {
      this.fileMovedUnderTheRecord = false;
    }
  }

  /**
   * Whether the file holds `text`, read back from disk.
   *
   * Compared in the webview's line endings, as every comparison between two of these
   * texts is, and with a byte-order mark ignored: the mark belongs to the file rather
   * than to the document's text, and VS Code puts it back on every save. Counting
   * either of those as a difference would send every save of a CRLF file, or of one
   * with a mark, down the path meant for a file something else has written.
   *
   * A file that cannot be read is not reported as a mismatch. Whatever is wrong with
   * it, writing over it by hand is not the answer, and the save itself has already
   * said so.
   */
  private async fileHolds(document: vscode.TextDocument, text: string): Promise<boolean> {
    try {
      const onDisk = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        await vscode.workspace.fs.readFile(document.uri)
      );
      return toWebviewText(onDisk.replace(/^﻿/, '')) === toWebviewText(text.replace(/^﻿/, ''));
    } catch {
      return true;
    }
  }

  /** Take back the newest remembered text, when a save of it was refused. */
  private forgetFile(text: string): void {
    if (this.fileHasHeld[this.fileHasHeld.length - 1]?.text === text) {
      this.fileHasHeld.pop();
    }
  }

  /** Remember a text the file holds or is being given, as the newest one. */
  private rememberFile(text: string): void {
    if (this.fileHasHeld[this.fileHasHeld.length - 1]?.text === text) {
      return;
    }
    this.fileHasHeld.push({ text, at: Date.now() });
    // Enough to cover the saves that can be in flight at once while somebody types.
    if (this.fileHasHeld.length > 8) {
      this.fileHasHeld.shift();
    }
  }

  /**
   * What the file held before the text it holds now, while that text is new enough
   * that something writing the file cannot be assumed to have known about it.
   *
   * This is the base a write was made from when the write and Sheaf's own save cross.
   * A tool reads the file, Sheaf saves the person's letter, and the tool writes back
   * what it read plus its own change. Measured against the newest text Sheaf wrote,
   * that write reads as deliberately removing the letter. Measured against what the
   * tool actually read, it is one change to one other line and the letter stands.
   *
   * The bound is a judgement and not a fact, and it is the whole of what keeps this
   * from resurrecting text on an ordinary reload. It models "the person could not
   * have known the file had moved": their own save is still the last thing that
   * happened, so they are still owed the letter it carried. Past it, a write that
   * removes text is taken at its word, because a write derived from an older copy and
   * a write that deliberately deletes are the same bytes and nothing here can tell
   * them apart. Wider than the auto-save debounce it has to cover, and far short of
   * how long a document stays open.
   */
  /**
   * The arriving document with typing put back that the write cannot have known about.
   *
   * Sheaf already keeps typing a write lands on top of while it is still unsaved. This
   * is the same promise one moment later, once the person's own save has carried the
   * letter to disk: there is then nothing unsaved to protect, and without this the file
   * is taken whole and the letter goes with a notice.
   *
   * Which side of the auto-save debounce the write falls on is invisible to the person
   * and decides nothing they could reason about, so the answer is the same on both.
   *
   * Refused where the merge keeps nothing of the write, which leaves today's behaviour
   * exactly as it is: the file stands and the notice says what it took. Taking a write
   * out of the document instead would be the other half of this race, and a worse
   * failure than the one being fixed here.
   */
  private keepTypingTheWriteCouldNotHaveSeen(
    base: string | undefined,
    arriving: string,
    document: vscode.TextDocument
  ): string {
    if (base === undefined) {
      return arriving;
    }
    const mine = this.webviewText;
    const theirs = toWebviewText(arriving);
    if (mine === theirs) {
      return arriving;
    }
    const { text: together } = mergeOutsideChange(toWebviewText(base), mine, theirs);
    if (together === mine || together === theirs) {
      return arriving;
    }
    // Back into the document's own line endings. Every newline in the merged text is
    // the webview's, because all three texts it was made from are, and VS Code gives a
    // document one ending whatever the file mixes.
    return document.eol === vscode.EndOfLine.CRLF ? together.replace(/\n/g, '\r\n') : together;
  }

  /**
   * Bring the document itself to the merged text, as one edit over what it changed.
   *
   * The merge that keeps a letter a write could not have seen happens while handling the
   * document's own change, and what it produces goes to the page. The document is not the
   * page: it holds whatever VS Code reloaded from the file, and it is the document that the
   * next save writes. So the merged text has to land here too, or the letter is kept on
   * screen and lost from the file with nothing said.
   *
   * `mergingOutsideChange` is held across the edit so the change this causes is not read as
   * news arriving from outside, which would work the merge a second time against itself.
   */
  private async writeMergedIntoDocument(document: vscode.TextDocument, merged: string): Promise<void> {
    const plan = planEdit(document.getText(), toWebviewText(merged), document.eol === vscode.EndOfLine.CRLF);
    if (!plan) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)),
      plan.replacement
    );
    this.mergingOutsideChange = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.mergingOutsideChange = false;
    }
  }

  private textTheWriterRead(): string | undefined {
    const newest = this.fileHasHeld[this.fileHasHeld.length - 1];
    const before = this.fileHasHeld[this.fileHasHeld.length - 2];
    if (newest === undefined || before === undefined) {
      return undefined;
    }
    return Date.now() - newest.at <= KEEP_AFTER_OWN_SAVE_MS ? before.text : undefined;
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
    const handedOver = document.getText();
    this.savingText = handedOver;
    this.rememberFile(handedOver);
    if (this.fileMovedUnderTheRecord) {
      // Asking VS Code to write this would fail and put its own notice on screen,
      // about changes being lost, at a moment when nothing is being lost at all.
      void this.writeOverTheMovedFile(document, handedOver).finally(() => {
        this.savingText = undefined;
      });
      return;
    }
    void Promise.resolve(document.save())
      .then(async (written) => {
        if (!written) {
          // Refused, so the file never held this text and must stop being remembered
          // as though it had. What it does hold is somebody else's write, and the last
          // text still on the list is the one they made it from, which is the base a
          // merge needs.
          this.forgetFile(handedOver);
          return this.writeOverTheMovedFile(document, handedOver);
        }
        /*
         * A save that reported success is not proof the file holds what was handed over.
         *
         * VS Code refuses a save whose file has moved since it last read it, and that
         * refusal is what the branch above recovers from. It only refuses when it noticed.
         * A write landing in the same handful of milliseconds as the save is not noticed
         * at all: the two reach the filesystem in whichever order they reach it, the later
         * one wins, and `save()` still answers true. Measured over four attempts in a real
         * window, with a write aimed at the moment of the save: one was refused and
         * recovered correctly, and in the other three the save reported success while the
         * file ended up holding one change or the other, never both, and nothing said so.
         *
         * Which one was lost varied. Twice the person's letter went, while the editor went
         * on showing it, so the screen and the file disagreed for as long as the document
         * stayed open. Once it was the agent's line, which is worse, because an agent does
         * not read its own write back and nothing else was ever going to notice.
         *
         * So the file is read back and compared. When it does not match, the save was
         * overtaken, and that is the same situation as a refusal: the remembered text is
         * withdrawn and the hand-written path merges what is actually there. Remembering it
         * is what would otherwise make the next read of the file look like Sheaf's own work.
         */
        if (document.isDirty) {
          // Typed into since the save began, so the document is ahead of the file by the
          // person's own letters and reading a difference as somebody else's write would be
          // wrong. There is nothing to settle here: the next save runs `keepOutsideChange`
          // first, and a dirty document is exactly the case that path is for.
          return undefined;
        }
        // What a participant's trim left, which is what actually reached the file, and so
        // what the file is compared against. Not the text handed over: with
        // `files.trimTrailingWhitespace` on, the two differ by design on every save.
        const reached = document.getText();
        if (!(await this.fileHolds(document, reached))) {
          this.forgetFile(handedOver);
          return this.writeOverTheMovedFile(document, reached);
        }
        this.rememberFile(reached);
        return undefined;
      }, () => undefined)
      .finally(() => {
        this.savingText = undefined;
      });
  }

  /**
   * A change written to the file while the person was typing, put into the document
   * before the next save writes over it.
   *
   * `DocumentSync` already does this for the browser host, where the editor and the
   * file are the same process and a write to the file is a write to the document.
   * VS Code is not that. It reloads a document that changed on disk only while the
   * document is clean, and one being typed into never is, so the document never
   * learns the file moved at all: `getText()` keeps answering with text read before
   * the write, and the next auto-save puts that text back over it. Nothing warns
   * anybody, and the agent's work is simply not there any more.
   *
   * So the file is read here, at the last moment before it is written. Where the two
   * changed different lines both are kept. Where they changed the same line the person
   * at the keyboard keeps theirs, and if that leaves nothing at all of what was
   * written, they are told, because they are about to save over a change they have
   * never seen.
   */
  private async keepOutsideChange(document: vscode.TextDocument): Promise<void> {
    const base = this.fileHasHeld[this.fileHasHeld.length - 1]?.text;
    if (base === undefined || document.isClosed) {
      return;
    }
    let onDisk: string;
    try {
      // `ignoreBOM` keeps a byte-order mark as a character rather than dropping it,
      // which is what makes this comparable with the text that was written. Decoded
      // the other way, every file with a mark reads back as different from what it
      // was given, and the mark is then quietly dropped from the next write.
      onDisk = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        await vscode.workspace.fs.readFile(document.uri)
      );
    } catch {
      return; // Gone, or never written. The save itself reports that.
    }
    if (document.isClosed) {
      return;
    }
    const mine = document.getText();
    // Compared in the webview's line endings, as every comparison between two of these
    // texts is. VS Code gives a document one line ending, whatever the file mixes, so
    // a file read straight back from disk can differ from the text that was written to
    // it in nothing but its endings, and reading that as a rewrite is how the document
    // ends up being put back to what the file held.
    const shown = toWebviewText(mine);
    const shownDisk = toWebviewText(onDisk);
    /*
     * Anything the file has held through this editor is Sheaf's own, whether that is
     * the save that just landed or one that has not caught up yet. Only a text from
     * nowhere in that list was written by something else.
     */
    if (this.fileHasHeld.some((held) => toWebviewText(held.text) === shownDisk)) {
      return;
    }
    if (shownDisk === shown) {
      // The same document, written with other line endings. Nothing to put together,
      // and the save about to run settles which endings the file keeps.
      this.rememberFile(onDisk);
      return;
    }
    /*
     * Nothing of the person's is waiting, so there is nothing here to protect. What is
     * on disk is then either news, which VS Code brings into a document itself, or a
     * save of ours that has not landed yet, and telling those apart from here is
     * guesswork. Writing the file's text into the document on a guess is how a save
     * still on its way gets read as an outside change and takes back the letters it
     * was carrying.
     */
    if (shown === toWebviewText(base)) {
      return;
    }
    const { text: together, dropped } = mergeOutsideChange(toWebviewText(base), shown, shownDisk);
    /*
     * Said only when none of the write survived, rather than whenever any of it was
     * dropped.
     *
     * A write from something that read the file a moment ago is behind on the line
     * being typed in, always: the letters typed since are not in its copy, so its
     * version of that line reads as a change to it and is dropped. Saying so every
     * time would put a notice on screen for every agent that ever writes while
     * somebody types, and what it would be reporting is the person's own letters
     * being kept. What deserves a notice is the write that is wholly gone, because
     * everything it touched is where the typing is.
     */
    if (dropped && together === shown) {
      void vscode.window.showWarningMessage(noticeAboutOutsideChangeLost());
    }
    // What the file holds is now part of the document, so a later read of it is not
    // news even if the save about to run has not landed by then.
    this.rememberFile(onDisk);
    // Something else wrote this file, which is what VS Code refuses to write over.
    // Knowing it now means the save can take the path that works rather than the one
    // that fails and says the person's changes are about to be lost.
    this.fileMovedUnderTheRecord = true;
    const plan = planEdit(mine, together, document.eol === vscode.EndOfLine.CRLF);
    if (!plan) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)),
      plan.replacement
    );
    this.mergingOutsideChange = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.mergingOutsideChange = false;
    }
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
    if (!this.isOurSavesTrim(text)) {
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
      // Mermaid's module, imported from `media/mermaid/` when a document has a
      // diagram, needs nothing more: a module imported by a script that carries
      // the nonce is fetched with that nonce, and so are its chunks.
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
  <!--
    A module, because the editor is split into chunks and only fetches a grammar when a
    fence asks for it. The nonce is what lets the chunks through: a module imported by a
    script carrying one is fetched with that nonce, and so are its own imports, which is
    the same path mermaid already takes from the media folder.
  -->
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
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
