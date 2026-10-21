/*
 * One editor, mounted into elements a caller gives it.
 *
 * **Everything this module needs comes from its arguments.** It reads no global, finds no element by
 * id, and appends nothing to `document.body` at import: a page that imports it and mounts nothing is
 * an unchanged page. `main.ts` is the first caller rather than a parallel implementation, which is
 * what makes the VS Code page a consumer of this surface and so a test of whether the surface is
 * sufficient: the editor it builds is the full `editorExtensions` set, and every message a host can
 * send arrives through `receive`.
 *
 * **The state of one mounted editor lives in `mount`'s closure.** That is the half of this file that
 * is content rather than motion: which document it is showing, whether it is a data file, what the
 * person has picked, and the re-entrancy flag held across writing a merged outside change back. All
 * of it was module-level, where a second mount would have shared it. `applyingRemote` is the one
 * worth naming: shared, one editor applying a change from outside would suppress the other's change
 * handling, so an edit in the editor nobody touched would not register, timing-dependent and
 * presenting as flakiness.
 *
 * What is **not** here is the page: the `acquireVsCodeApi` global, the two elements with literal ids,
 * the window's `message` and `blur` listeners, and where the editor's own files are served from.
 * Those belong to whoever builds the page, which in this bundle is `main.ts`.
 */

import type { FromWebview } from '../protocol';
import { EditorState, Transaction, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { isolateHistory, undo } from '@codemirror/commands';
import { setDocumentSourceMode, setLivePreviewConfig } from './revealState';
import { revealOnDoubleClick } from './revealBlock';
import { paragraphTripleClick } from './paragraphSelect';
import { editorExtensions } from './editorExtensions';
import { mountToolbar, nextTocState, refreshToolbar, reflectLineNumbers, reflectTableOfContents, tocButtonState } from './toolbar';
import { focusedCellEditor, onCellEditorActivity } from './cellEditor';
import { createTableOfContents } from './tableOfContents';
import { createShortcutsOverlay } from './shortcuts';
import { ContextMenuDeps, mountContextMenu } from './contextmenu';
import { setClipboardHost } from './hostClipboard';
import { setWorkspaceFilesHost, handleWorkspaceFiles, setLinkCompleteDocument } from './linkComplete';
import { setBlockRefHost } from './blocks';
import { CommentsMode, handleCommentFolds, setCommentFoldsHost, setCommentsMode } from './comments';
import { FrontMatterMode, handleFrontMatterState, setFrontMatterHost, setFrontMatterMode } from './frontMatterView';
import { setResourceBaseUri } from './imageMarkup';
import { setupImageIngestion, handleImageSaved } from './imageIngest';
import { setDocTitleHost } from './linkPaste';
import { headingPosition, setFragmentHost, setLinkHost } from './linkTarget';
import { HeldLink, contextMenuOnLink, pressOnLinkIn, releaseOnLinkIn } from './linkGesture';
import { contentWidth, DEFAULT_CONTENT_WIDTH } from './theme';
import { coveredEnd } from './selectionExtent';
import { buildRef, setCellRefSource, tableRowRef } from './refs';
import { tableRowRefAt, setTableWidthsHost, handleTableWidths, setTableBoardsHost, handleTableBoards, setMoveToFile, setCreateView } from './tables';
import { remeasureAllTables } from './columnLayout';
import { setDataFileHost, handleDataFile, handleDataFileCreated, handleDataFileEdited, moveBlockToFile, createViewOf } from './viewBlock';
import { minimalEdit, toWebviewText } from '../textSync';
import { outsideWrite } from './changeMarks';
import { closeMount, mountExtension, openMount } from './mountScope';
import type { MountScope } from './mountScope';

export interface EditorConfig {
  contentWidth: string;
  /** Whether the line-number gutter is drawn. A setting, so it outlives a document. */
  lineNumbers?: boolean;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  tableOfContents: 'shown' | 'collapsed' | 'hidden' | boolean;
  comments: CommentsMode;
  frontMatter: FrontMatterMode;
}

export type ToWebview =
  | {
      type: 'init';
      text: string;
      config: EditorConfig;
      fileName: string;
      resourceBaseUri: string;
      /** A heading to scroll to, when this editor was opened by a link naming one. */
      fragment?: string;
      /**
       * What this host can do, where a host may not be able to do everything.
       * Absent means everything, which is VS Code. A browser sends
       * `terminal: false`, because a tab has no terminal behind it.
       */
      capabilities?: { terminal?: boolean };
      /**
       * `csv` when the file is a .csv or .tsv file rather than a document. The host
       * sends it framed as one fenced block, which the grid draws, and the page is that
       * grid and nothing else.
       */
      mode?: 'csv';
      /** Said in place of the editor, for a file the host will not open in one. */
      notice?: string;
    }
  | {
      type: 'setContent';
      text: string;
      /** True when this document drops text the person typed a moment ago. */
      tookTypedText?: boolean;
      /** True when this is the person's own Undo or Redo from the Edit menu, not a write from outside. */
      ownUndo?: boolean;
    }
  | { type: 'revealFragment'; id: string }
  | { type: 'undoOutsideChange' }
  | { type: 'configChanged'; config: EditorConfig }
  | { type: 'imageSaved'; id: string; path?: string; error?: string }
  /** The answer to `workspaceFilesRead`: the workspace's files, relative to its folder. */
  | { type: 'workspaceFiles'; id: string; files: string[] }
  /** The answer to `docTitleRead`: what a pasted path names, or nothing when it names nothing to link. */
  | { type: 'docTitle'; id: string; address?: string; title?: string }
  /**
   * The answer to `tableWidthsRead`: the column widths set by hand in this document's
   * tables, by table key, each by column index. A host that keeps none never answers.
   */
  | { type: 'tableWidths'; id: string; widths: Record<string, Record<string, number>> }
  /**
   * The answer to `tableBoardsRead`: the pipe tables in this document shown as boards,
   * by table key, each with the header text of the column it is grouped by.
   */
  | { type: 'tableBoards'; id: string; boards: Record<string, { group: string }> }
  /**
   * The answer to `commentFoldsRead`: every comment collapsed in this document, by
   * comment key. A host that keeps none never answers.
   */
  | { type: 'commentFolds'; id: string; folds: Record<string, true> }
  | { type: 'frontMatterState'; id: string; state: FrontMatterMode | null }
  | { type: 'outlineState'; id: string; state: 'shown' | 'collapsed' | 'hidden' | null }
  /**
   * A data file a view reads: the answer to `dataFileRead` (carrying its `id`), or
   * sent again when the file changes. `text` is the file, or `error` says why not.
   */
  | { type: 'dataFile'; id?: string; path: string; text?: string; error?: string; notice?: string; missing?: boolean }
  /** The answer to `dataFileCreate`: the path written, or why nothing was. */
  | { type: 'dataFileCreated'; id: string; path?: string; error?: string }
  | { type: 'dataFileEdited'; id: string; error?: string }
  /** A key that names the selection is waiting on the answer, so it goes at once. */
  | { type: 'getSelection'; id: string }
  | { type: 'toggleSourceMode' };

/** What a caller has to supply for one editor. Nothing here is found rather than given. */
export interface WebviewMountOptions {
  /** The element the editor is drawn into. */
  root: HTMLElement;
  /** The element the formatting toolbar is drawn into. */
  toolbar: HTMLElement;
  /**
   * Where the keyboard-shortcuts overlay is appended.
   *
   * Its own element rather than `document.body`, because the overlay is this editor's and a page
   * holding two of them would otherwise put both in the same place.
   */
  overlay: HTMLElement;
  /** How a message reaches the host behind this editor. */
  post: (message: FromWebview) => void;
}

/** One mounted editor, as its caller sees it. */
export interface WebviewMount {
  /** This mount's identity, which is what per-mount state in other modules is keyed by. */
  readonly scope: MountScope;
  /** A message from the host behind this editor. */
  receive(message: ToWebview): void;
  /**
   * The page lost keyboard focus, which is the one thing that happens before VS Code closes the
   * tab in front when its close button is pressed: the panel stays active until it is gone, so the
   * host hears nothing from its own side. The host writes a pending auto-save on this, so the
   * close finds nothing unsaved to ask about.
   *
   * The caller decides what counts, because what is listened to is a property of the page. In the
   * webview that is the window's `blur`.
   */
  blurred(): void;
  /** Take this editor down. */
  destroy(): void;
}

/**
 * What each setting is when no host says otherwise.
 *
 * Every host sends a `config` at `init`, and not every host sends all of it: the
 * website's demo sends three of these. So a host's config is merged over this rather
 * than replacing it, which is what makes these the settings' defaults rather than a
 * value nothing ever reads. Without the merge each default would live a second time
 * inside whichever `applyConfig` branch reads the setting, and the two copies would be
 * free to disagree.
 */
const DEFAULT_CONFIG: EditorConfig = {
  contentWidth: DEFAULT_CONTENT_WIDTH,
  revealSyntaxOnLine: false,
  doubleClickToEditSource: false,
  tableOfContents: 'hidden',
  comments: 'show',
  frontMatter: 'collapsed',
};

/**
 * How long to wait after the last selection change before telling the host about it.
 * Dragging a selection, or holding an arrow key down, moves it many times on the way
 * to where the person meant to stop, and only where they stopped is worth a message.
 * Short enough that the selection is already there by the time a chord is pressed.
 */
const SELECTION_DEBOUNCE_MS = 100;

/**
 * What a pasted path names, asked of the host. Only it can say: the page cannot read another
 * file, and cannot work out what a relative path is relative to.
 *
 * The timeout is what keeps a paste from being swallowed by a host that answers nothing. A
 * host with no such message ignores it, and an unanswered request resolves to null, so the
 * paste lands as text a quarter of a second later rather than never.
 */
const DOC_TITLE_TIMEOUT_MS = 250;

/** The lines one selected range covers, counted from one. */
interface SelectionRange {
  start: number;
  end: number;
}

/**
 * The setting's value as one of the three states. `true` and `false` are what it held
 * when it was a boolean and still mean shown and hidden, so nobody who set one has to
 * know the other two arrived.
 */
function outlineState(value: unknown): 'shown' | 'collapsed' | 'hidden' {
  if (value === true || value === 'shown') return 'shown';
  if (value === 'collapsed') return 'collapsed';
  return 'hidden';
}

/**
 * The single changed region between two strings, in the shape CodeMirror's `changes`
 * spec takes. Where that region may begin and end is one rule, held in `minimalEdit`,
 * so the host and the webview cannot come to disagree about what an edit covers.
 */
function diff(oldText: string, newText: string): { from: number; to: number; insert: string } {
  const { start, end, replacement } = minimalEdit(oldText, newText);
  return { from: start, to: end, insert: replacement };
}

/**
 * Where the caret goes when a document from the host puts text exactly where it is.
 *
 * Left to itself, CodeMirror maps a caret sitting on an insertion point to the left of
 * the text that arrives. That is right for something another person wrote: it appears
 * in front of you and you keep your place in what follows. In a fast burst it is wrong,
 * because the text arriving at the caret is the letter the person has just typed,
 * coming back after a document that was a step behind took it away. Left of it, the
 * next letter goes in ahead of it and the two come out in the other order: typing `Z2`
 * across that moment lands as `2Z`.
 *
 * So text arriving on the caret goes in front of it, with one thing held back: a line
 * break. A newline put in at the caret is the file being given the ending it is missing
 * (`files.insertFinalNewline`) or a block being separated out, and stepping over it
 * would carry the person onto the next line, taking the rest of the sentence they were
 * writing with them. Nothing arriving from outside may move somebody to another line,
 * so an insertion holding a line break keeps CodeMirror's own mapping, as does every
 * change that is not a plain insertion at an empty caret.
 */
function caretAfterRemoteText(
  state: EditorState,
  change: { from: number; to: number; insert: string }
): { anchor: number } | undefined {
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || !main.empty) return undefined;
  if (change.from !== change.to || change.from !== main.head) return undefined;
  if (/[\n\r]/.test(change.insert)) return undefined;
  return { anchor: main.head + change.insert.length };
}

/** Put one Sheaf editor in the elements `options` names, and wire it to the host behind them. */
export function mountWebview(options: WebviewMountOptions): WebviewMount {
  const { root: rootEl, toolbar: toolbarEl, post } = options;
  const scope = openMount(rootEl);
  const shortcutsOverlay = createShortcutsOverlay(options.overlay);

  /* ---- This editor's own state ------------------------------------------- */

  /** The editor itself, once the first document has arrived. */
  let view: EditorView | undefined;
  /** Workspace-relative path of the current document, used to build "Copy ref". */
  let fileName = '';
  /** True when the file is a .csv or .tsv file, framed by the host as one fenced block. */
  let csvMode = false;
  /** True when the host sent a notice instead of a document, and there is no editor to fill. */
  let showingNotice = false;
  let sourceMode = false;
  /**
   * This document's own heading-list state, when it has one, which wins over the setting.
   * Kept by the host under the document's own key, as the front matter's is.
   */
  let ownOutline: 'shown' | 'collapsed' | 'hidden' | null = null;
  let outlineSeq = 0;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let config: EditorConfig = { ...DEFAULT_CONFIG };
  /** Guards against echoing host-originated changes back to the host. */
  let applyingRemote = false;
  /**
   * True while the last thing that happened to the document is a write from outside
   * that took back text the person had just typed.
   *
   * It is what the notice's Undo goes by. Cmd+Z needs nothing from it, because such a
   * write is put on this editor's undo history as its own step and the key already
   * takes back the step on top. The offer in the notice can be pressed much later,
   * though, by which time the person may have typed again, and taking back their new
   * work instead is the one thing it must never do.
   */
  let outsideChangeIsOnTop = false;
  /** The link this editor's last press landed on, for the release to decide about. */
  let heldLink: HeldLink | null = null;
  const docTitleAsked = new Map<string, (answer: { address: string; title: string } | null) => void>();
  let docTitleSeq = 0;

  /*
   * Line-number gutter, drawn through a reconfigurable compartment so it can go on and off
   * without rebuilding the editor (an empty extension is no gutter).
   *
   * Whether it is on belongs to `config`, which is the setting, and not to a variable here.
   * It used to be one, and the cost was that turning them on lasted until the document closed:
   * every document opened without them and anybody who works with them on turned them back on
   * every time. The toolbar asks the host to write the setting, the host writes it globally,
   * and every open editor hears about it through the configuration-change listener it already
   * has, which is also how a second editor stays in step with the first.
   */
  const lineNumberCompartment = new Compartment();
  const editableCompartment = new Compartment();
  /** Marks transactions that originated from the host, so we don't echo them back. */
  const remoteAnnotation = Transaction.remote;

  // `config` arrives with `init`, and the editor is built from the same message, so this is
  // read once before it is set. Off until the setting says otherwise is the right default and
  // the same one the setting declares.
  const lineNumbersOn = (): boolean => config?.lineNumbers === true;

  /**
   * Says on the editor's root whether line numbers are on, so a table's row numbers can
   * follow the document's.
   *
   * A class rather than a message into `tables.ts`, because what changes is only what is
   * drawn: the row-number column is also how a row is selected and how rows are dragged,
   * so the cell stays exactly where it is and the stylesheet decides whether it shows a
   * number. `columnLayout.ts` measures a stand-in carrying that same class, inside the
   * table it is laying out, so the width it reserves narrows with the real thing and
   * nothing has to be told twice.
   */
  function reflectLineNumbersOnRoot(on: boolean): void {
    if (!rootEl || rootEl.classList.contains('line-numbers') === on) return;
    rootEl.classList.toggle('line-numbers', on);
    // The column widths are cached against what each table holds, and none of that has
    // changed, so they have to be told the gutter beside them has.
    remeasureAllTables();
  }

  /** Ask for the line-number gutter to flip, and say what it will become (for the toolbar). */
  function toggleLineNumbers(): boolean {
    const next = !lineNumbersOn();
    // Drawn here rather than waiting for the setting to come back, so the button and the
    // gutter answer the press together. `applyConfig` reconfigures to the same thing when the
    // change arrives, and to the setting's value if the write did not land.
    view?.dispatch({ effects: lineNumberCompartment.reconfigure(next ? lineNumbers() : []) });
    reflectLineNumbersOnRoot(next);
    view?.focus();
    post({ type: 'setLineNumbers', on: next });
    return next;
  }

  // The table of contents: a rail of the document's headings, in the page margin beside
  // the text. It goes in ahead of the editor so that Tab reaches it straight from the
  // toolbar, and it is empty and hidden until `sheaf.tableOfContents` says otherwise.
  const toc = createTableOfContents(rootEl, () => view, (state) => {
    // The header was pressed: this document, from now on. The toolbar button has to follow,
    // or it would go on saying the list is showing and its next press would be wrong.
    ownOutline = state;
    reflectTableOfContents(state, scope);
    post({ type: 'outlineStateWrite', state });
  });

  /**
   * Set the rail's state for this document, or hand the document back to the setting with
   * `null`. The header's own press goes through the callback above; this is for the menu,
   * which can also reset, and which has to draw the result itself because no configuration
   * change is coming to do it.
   */
  function setOutlineForDocument(state: 'shown' | 'collapsed' | 'hidden' | null): void {
    ownOutline = state;
    post({ type: 'outlineStateWrite', state });
    const drawn = state ?? outlineState(config.tableOfContents);
    toc.setState(drawn);
    reflectTableOfContents(drawn, scope);
  }

  /**
   * The toolbar button was pressed.
   *
   * Which of the three states the panel is in is a setting rather than a property of this
   * editor, so the host makes the change, in user settings, and every open Sheaf editor
   * hears about it through the configuration-change path it already has. The one press that
   * is not a setting change is the one that brings a panel back after it was closed on a
   * narrow pane, where the setting was on the whole time.
   */
  function toggleTableOfContents(): void {
    if (toc.reopened()) return;
    // Three states, so the button cycles: showing, folded, gone, showing. It writes the
    // setting, and it drops this document's own state at the same time. A document that
    // kept its own would go on ignoring the setting, and the press would look like it did
    // nothing at all.
    const next = nextTocState(tocButtonState(scope));
    if (ownOutline !== null) {
      ownOutline = null;
      post({ type: 'outlineStateWrite', state: null });
    }
    // Drawn and folded straight away, rather than waiting for the setting to come back: a
    // control that does nothing for a round trip reads as a control that did not work.
    toc.setState(next);
    reflectTableOfContents(next, scope);
    post({ type: 'setTableOfContents', on: next });
  }

  /*
   * The editor the top toolbar acts on and reports the state of.
   *
   * Usually the document's own. While a table cell is open for editing it is that cell's editor,
   * which is a separate `EditorView` with its own state and history: without this the toolbar ran
   * against the outer document and formatted whatever had last been selected there, so a button
   * pressed while looking at a cell changed a line somewhere else, left the cell's own word
   * alone, and said nothing. Undo and Redo were the worst of it, because they read the outer
   * history and would have stepped the document's while the person was inside a cell.
   *
   * `undefined` while a *data* cell has focus. A CSV or TSV field is a plain text box holding
   * data rather than Markdown, so there is no editor to act on and nothing Bold could mean; the
   * toolbar draws itself unavailable, which is the ticket's rule that a control unable to reach
   * the current selection says so rather than acting somewhere else.
   */
  /*
   * And `undefined` while a table's **grid** holds focus with a cell picked, which is a third state
   * neither branch below covered. A single click on a cell picks it and leaves focus on the grid, with
   * no cell editor open at all, so `focusedCellEditor()` is null and the outer view was handed over.
   * The outer caret is then wherever it was last left, which on a freshly opened document is the first
   * character of the file: measured as `{from: 0, to: 0}` at `"Intro paragr"` while a data cell in a
   * `csv` block three paragraphs down was the thing on screen. A button pressed there writes into prose
   * the person is not looking at, which is the same fault one state along from the one the paragraph
   * above describes.
   */
  const toolbarTarget = (): EditorView | undefined => {
    const cell = focusedCellEditor();
    if (cell) return cell.view ?? undefined;
    // Only a grid of this editor's own counts. Focus is the page's, so on a page holding two
    // editors the element with it may belong to the other one, and this toolbar has nothing to
    // say about that.
    const active = rootEl.ownerDocument.activeElement;
    if (active && rootEl.contains(active) && active.classList.contains('sheaf-table-grid')) return undefined;
    return view;
  };

  /**
   * The file's own line for a line of the framed text. The opening fence is line 1 of
   * what the editor holds and no line of the file at all, so the file's first record,
   * which the editor holds on line 2, is line 1. A fence line names the record beside it.
   */
  function fileLine(line: number): number {
    if (!csvMode) return line;
    const last = Math.max(1, (view?.state.doc.lines ?? 3) - 2);
    return Math.min(Math.max(line - 1, 1), last);
  }

  /**
   * A reference as a data file names it: `data.csv:3` for what the editor holds on line
   * 4. References are built by the builders every document uses, which count the lines
   * of the text the editor holds; in a data file that is one line more than the file's.
   */
  function fileRef(ref: string): string {
    const prefix = `${fileName}:`;
    if (!csvMode || !ref.startsWith(prefix)) return ref;
    const rest = ref.slice(prefix.length);
    const lines = /^(\d+)(?:-(\d+))?/.exec(rest);
    if (!lines) return ref;
    const start = fileLine(Number(lines[1]));
    const end = lines[2] ? fileLine(Number(lines[2])) : start;
    return `${prefix}${end !== start ? `${start}-${end}` : start}${rest.slice(lines[0].length)}`;
  }

  /**
   * Keep an edit inside the fence of a data file.
   *
   * The first and last lines of what the editor holds are the frame the host put around
   * the file, and the host reads each edit by taking exactly those two lines off again.
   * Typing on either of them, or in front of the first or after the last, would write
   * something that is not the file, so a change that reaches them is not made at all.
   * Changes from the host are its own frame and always go through.
   */
  const fenceGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(Transaction.remote)) return tr;
    const before = tr.startState.doc;
    const after = tr.newDoc;
    const open = before.line(1);
    const close = before.line(before.lines);
    let outside = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      // Ends on the opening fence line, or starts inside or after the closing one. A row
      // added under the last one goes in at the start of the closing line, which is
      // inside the fence; what it leaves on that line is checked below.
      if (toA <= open.to || fromA > close.from) outside = true;
    });
    if (
      outside ||
      after.lines < 2 ||
      after.line(1).text !== open.text ||
      after.line(after.lines).text !== close.text
    ) {
      return [];
    }
    return tr;
  });

  /* ---- Telling the host where the person is ------------------------------ */

  /**
   * What the host is told about a selection: the lines it covers, and the reference a
   * person copying it would get.
   *
   * The reference is built here, by the builder the right-click menu uses, so the
   * command and the menu can never come to say two things about one selection. The
   * lines are the same selection counted a second way, for the shorter form a terminal
   * takes. The first range is the main one, the one the person's last gesture made, so
   * both commands name the same place when there are several carets.
   */
  function selectionReport(target: EditorView): { ranges: SelectionRange[]; ref: string } {
    // A table is drawn as one block widget, so the document position under a grid is
    // the table's own edge and names no row at all. The grid is asked instead, and it
    // answers with the lines the file will hold once it is saved, so a row moved in the
    // grid is named where it is going.
    const active = rootEl.ownerDocument.activeElement;
    const row = active && rootEl.contains(active) ? tableRowRefAt(active) : null;
    if (row) return { ranges: [{ start: fileLine(row.start), end: fileLine(row.end) }], ref: fileRef(tableRowRef(fileName, row)) };
    const { doc } = target.state;
    const { ranges, mainIndex } = target.state.selection;
    const lines = ranges.map((range) => ({
      start: fileLine(doc.lineAt(range.from).number),
      // A selection ending at the start of a line covers no character of that line, so
      // the range stops at the line before it. Copy ref reads the end the same way, and
      // a triple-clicked line is named as the one line it is.
      end: fileLine(doc.lineAt(coveredEnd(doc, range)).number),
    }));
    return {
      ranges: [lines[mainIndex], ...lines.filter((_, i) => i !== mainIndex)],
      ref: fileRef(buildRef(target, fileName)),
    };
  }

  /**
   * Tell the host what the person has picked.
   *
   * VS Code gives a custom editor no way to report its selection, so anything outside
   * this webview that wants to name what the person is looking at has nothing to read.
   * The commands that hand the selection on run in the extension host, and this is how
   * they learn what to name.
   */
  function reportSelection(): void {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = undefined;
      if (view) post({ type: 'selection', ...selectionReport(view) });
    }, SELECTION_DEBOUNCE_MS);
  }

  function applyConfig(target: EditorView | undefined): void {
    rootEl.style.setProperty('--md-content-width', contentWidth(config.contentWidth));
    // The setting is where the gutter's state lives, so this is what makes a change made in
    // one editor, or in the Settings pane, show in this one. Reconfiguring to what is already
    // configured costs nothing, which is why it is unconditional.
    if (target) {
      target.dispatch({ effects: lineNumberCompartment.reconfigure(lineNumbersOn() ? lineNumbers() : []) });
      // And the button, so it does not say the opposite of what the gutter is doing.
      reflectLineNumbers(lineNumbersOn(), scope);
      reflectLineNumbersOnRoot(lineNumbersOn());
    }
    setLivePreviewConfig({ revealSyntaxOnLine: config.revealSyntaxOnLine });
    // Anything but `hidden` shows comments. A setting nobody can read must never end
    // in a comment being drawn as nothing at all.
    setCommentsMode(config.comments === 'hidden' ? 'hidden' : 'show', scope);
    // And the same care for front matter: anything unreadable collapses rather than
    // hides, so a person can always see that the metadata is there.
    setFrontMatterMode(config.frontMatter === 'shown' || config.frontMatter === 'hidden' ? config.frontMatter : 'collapsed', scope);
    // A data file has no headings to list, so the rail is nothing there whatever the
    // setting says. This document's own state comes first, then the setting, which is the
    // default for the rest.
    const outline = ownOutline ?? outlineState(config.tableOfContents);
    toc.setState(csvMode ? 'hidden' : outline);
    reflectTableOfContents(csvMode ? 'hidden' : outline, scope);
    if (target) {
      // Force a decoration rebuild by dispatching an empty selection-preserving tx.
      target.dispatch({});
    }
  }

  /**
   * A press on a rendered link. The modifier opens it now; a plain press only remembers it,
   * and the release opens it if nothing moved, so a drag that starts on a link still selects.
   *
   * False for a plain press, on purpose, so CodeMirror goes on to place the caret and begin a
   * selection exactly as it would anywhere else in the text.
   */
  function handleLinkClick(event: MouseEvent, target: EditorView): boolean {
    const { opened, hold } = pressOnLinkIn(target, event);
    heldLink = hold;
    return opened;
  }

  /**
   * Double-click selects a word, as it does anywhere else, and CodeMirror is what
   * does that. Only when `sheaf.doubleClickToEditSource` is on does Sheaf claim
   * the click and reveal the block's raw Markdown instead.
   *
   * This runs on the second `mousedown`, not on `dblclick`. By the time `dblclick`
   * fires, two word-selections have already been made: CodeMirror's, dispatched
   * from its own mousedown handler, and the browser's native one in the
   * contenteditable. Both overwrite what this dispatches, and the native one
   * survives in the DOM to be read back asynchronously, so a reveal dispatched
   * from `dblclick` gets clobbered after the handler returns. Claiming the mousedown prevents both
   * before either happens. Returning true makes CodeMirror call `preventDefault`
   * and skip its built-in handler; that also suppresses the default focus, which
   * is why focus is taken explicitly below.
   */
  function handleDoubleClick(event: MouseEvent, target: EditorView): boolean {
    if (event.button !== 0 || event.detail !== 2) return false;
    const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    if (!revealOnDoubleClick(target, pos, config.doubleClickToEditSource)) return false;
    event.preventDefault();
    target.focus();
    return true;
  }

  function buildState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        // Which mount this editor belongs to, so every module keeping state about one editor can
        // find its own. It goes in first, because a field's `create` may read it.
        mountExtension(scope),
        lineNumberCompartment.of(lineNumbersOn() ? lineNumbers() : []),
        editableCompartment.of(EditorView.editable.of(true)),
        csvMode ? fenceGuard : [],
        editorExtensions(shortcutsOverlay.toggle),
        // Report user edits back to the host, and keep the toolbar's buttons current.
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingRemote && !update.transactions.some((tr) => tr.annotation(remoteAnnotation))) {
            post({ type: 'edit', text: update.state.doc.toString() });
            // The person has changed the document since, so the write that took their
            // text is no longer the step Undo would take back.
            outsideChangeIsOnTop = false;
          }
          // Against whichever editor the toolbar is acting on, or the buttons would go on
          // reporting the outer selection's state while a cell has focus, which is the same
          // defect read rather than pressed.
          if (update.docChanged || update.selectionSet || update.focusChanged) refreshToolbar(toolbarTarget(), scope);
          // The host keeps the latest selection so its commands can name it. A document
          // change counts as well as a selection change: text put in above the caret
          // moves it to another line without the selection itself being set.
          if (update.selectionSet || update.docChanged) reportSelection();
          // A heading typed, retitled or deleted changes the rail. It is rebuilt on the
          // next frame rather than on the keystroke, so a burst of typing costs one pass.
          if (update.docChanged) toc.documentChanged();
        }),
        // A click opens a link, and double-click reveals an element's raw source.
        // Both ride mousedown: see handleDoubleClick for why dblclick is too late.
        // A plain click opens on the release instead, so a drag that starts on a
        // link still selects; linkGesture.ts holds both halves. Triple-click goes
        // through a selection style instead, so that CodeMirror runs it as its own
        // gesture; paragraphSelect.ts says why.
        paragraphTripleClick,
        EditorView.domEventHandlers({
          mousedown: (event, target) => handleLinkClick(event, target) || handleDoubleClick(event, target),
          mouseup: (event, target) => {
            const held = heldLink;
            heldLink = null;
            return releaseOnLinkIn(target, event, held);
          },
          // A right-click on a link opens its popover rather than the context menu.
          contextmenu: (event, target) => contextMenuOnLink(target, event),
        }),
      ],
    });
  }

  /**
   * Take a document from the host, as the first one or as a change to the one shown.
   *
   * CodeMirror breaks lines on CRLF, a lone CR and LF alike and holds every one as LF,
   * so the text it holds never has a carriage return in it. The incoming text is put in
   * those line endings before anything is compared. Compared as sent, a CRLF file differs
   * from what the editor holds at every line, the change runs to the end of the document,
   * and the carriage return it leaves behind the last kept newline becomes one more line
   * break: the document grows an empty last line, the caret is thrown to where the
   * change began, and the next keystroke writes that line into the file. The host sends
   * this form already; doing it here as well means the result never depends on that.
   */
  function setContent(incoming: string, tookTypedText = false, ownUndo = false): void {
    if (showingNotice) return;
    const text = toWebviewText(incoming);
    if (!view) {
      view = new EditorView({ state: buildState(text), parent: rootEl });
      setupImageIngestion(view, post);
      toc.attach(view);
      // Nothing has been selected yet, and the caret still sits somewhere: an editor
      // just opened is as much a place to name as one somebody has been reading.
      reportSelection();
      return;
    }
    if (view.state.doc.toString() === text) return;
    applyingRemote = true;
    try {
      const change = diff(view.state.doc.toString(), text);
      view.dispatch({
        changes: change,
        // Text landing on the caret goes in front of it, so what the person types next
        // still follows what they typed last. Everything else keeps CodeMirror's mapping.
        selection: caretAfterRemoteText(view.state, change),
        // A change made outside this editor is not this editor's to undo: Cmd+Z takes
        // back the person's own last edit and keeps the outside one. The exception is a
        // write that took back what they had just typed, which goes on the history as
        // its own step, so Cmd+Z gives them their words again. Sheaf puts nothing back
        // by itself; the key, or the Undo on the notice, is the whole of it.
        annotations: tookTypedText
          ? [remoteAnnotation.of(true), isolateHistory.of('full')]
          : [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
        // Mark the lines this write inserted or rewrote, so the person can see where
        // the document changed under them. A write that took back their typing is
        // marked like any other. Undo or Redo from the Edit menu arrives the same way but
        // is the person's own, so it marks nothing.
        effects: ownUndo ? [] : outsideWrite.of(null),
        // Keep the selection valid without yanking the viewport around.
        scrollIntoView: false,
      });
    } finally {
      applyingRemote = false;
    }
    outsideChangeIsOnTop = tookTypedText;
  }

  /**
   * Take back the write that overwrote what the person typed, as their own Undo would.
   *
   * Only while that write is still the step on top. Once they have typed again, the
   * offer in the notice is about a change the editor no longer has in front of it, and
   * running Undo then would take away the work they have done since.
   */
  function undoOutsideChange(): void {
    if (!view || !outsideChangeIsOnTop) return;
    undo(view);
  }

  /**
   * Scroll to the heading a fragment names and leave the caret there, so the place
   * the link pointed at is both visible and where typing would go.
   */
  function revealFragment(id: string): void {
    if (!view) return;
    const pos = headingPosition(view.state, id);
    if (pos == null) return;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    });
    view.focus();
  }

  /**
   * Toggle Whole-Document Source Mode: show the file as it is written, then show
   * it as a document again.
   *
   * Before the document has arrived there is no editor to tell, so only the class
   * is set. A mounting editor reads that class and puts the mode into its own
   * state, so a toggle sent that early still takes.
   */
  function setSourceMode(on: boolean): void {
    sourceMode = on;
    if (view) setDocumentSourceMode(view, rootEl, on);
    else rootEl.classList.toggle('source-mode', on);
  }

  /** The host's answer to `docTitleRead`, by the id it was asked with. */
  function handleDocTitle(id: string, address?: string, title?: string): void {
    const done = docTitleAsked.get(id);
    if (!done) return;
    docTitleAsked.delete(id);
    done(address && title !== undefined ? { address, title } : null);
  }

  /* ---- Wiring ------------------------------------------------------------- */

  /*
   * A cell gaining or losing focus, and typing or selecting inside one, all change what the
   * buttons should be showing, and none of them is an update to the outer editor, so none of them
   * reaches the listener in `buildState`.
   */
  onCellEditorActivity(() => refreshToolbar(toolbarTarget(), scope));

  mountToolbar(
    toolbarEl,
    toolbarTarget,
    shortcutsOverlay.toggle,
    () => post({ type: 'openAsText' }),
    toggleLineNumbers,
    lineNumbersOn(),
    toggleTableOfContents,
    false,
    scope
  );

  setClipboardHost((message) => post(message), scope);
  setWorkspaceFilesHost((message) => post(message), scope);
  setLinkHost((message) => post(message), scope);
  setFragmentHost(revealFragment, scope);

  setDocTitleHost(
    (path) =>
      new Promise((resolve) => {
        const id = `doctitle-${++docTitleSeq}`;
        const timer = setTimeout(() => {
          docTitleAsked.delete(id);
          resolve(null);
        }, DOC_TITLE_TIMEOUT_MS);
        docTitleAsked.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        post({ type: 'docTitleRead', id, path });
      }),
    scope
  );

  /*
   * Kept rather than passed inline, because what the menu offers depends on what
   * the host can actually do, and that is not known until `init` arrives. The
   * menu reads these each time it opens, so dropping one afterwards removes its
   * item. See the `capabilities` handling in `receive`.
   */
  const contextMenuDeps: ContextMenuDeps = {
    getView: () => view,
    getFileName: () => fileName,
    copyToClipboard: (text) => post({ type: 'clipboardWrite', text: fileRef(text) }),
    // The terminal lives in the extension host, so the menu asks for the command rather than doing
    // it. The host already knows the selection: the same message the shortcut reads.
    sendRefToTerminal: () => post({ type: 'runCommand', command: 'sheaf.sendRefToTerminal' }),
    // The rail is this page's, not the document's, so the menu is told what it is doing.
    outline: {
      state: () => toc.state(),
      isOwn: () => ownOutline !== null,
      setForDocument: setOutlineForDocument,
      everywhere: () => {
        // The setting, and this document handed back to it, so the document the person set
        // it from is not the one document that goes on ignoring it.
        post({ type: 'setTableOfContents', on: toc.state() });
        setOutlineForDocument(null);
      },
      reset: () => setOutlineForDocument(null),
    },
  };
  mountContextMenu(rootEl, contextMenuDeps);

  setBlockRefHost(
    {
      getFileName: () => fileName,
      copyToClipboard: (text) => post({ type: 'clipboardWrite', text: fileRef(text) }),
      // The sharing keys are bound by the editor window, and the same hosts that have
      // that window are the ones with a terminal to send to. So the menu's own test for
      // the terminal answers this too, rather than a second flag that could disagree.
      hasEditorKeys: () => contextMenuDeps.sendRefToTerminal !== undefined,
    },
    scope
  );

  // What Copy ref names inside an open table cell. The grid answers, because a cell's
  // own editor counts from line 1 of that cell; this is the builder the right-click
  // menu and the chord already use, so every surface names one cell one way.
  setCellRefSource((el) => {
    const row = tableRowRefAt(el);
    return row ? tableRowRef(fileName, row) : null;
  }, scope);

  // The root reports the person's selection on the ways of finishing a pick that are not a
  // CodeMirror transaction. A table grid keeps its own selection, and moving between its cells
  // is not one, so the update listener never hears about it. Focus landing somewhere, a key
  // coming back up and a pointer being let go cover the ways a person finishes picking rows;
  // each goes through the same debounce as everything else.
  // Capture, because the surfaces that most need reporting are the ones that stop these
  // events: a grid keeps a pointer press to itself, and an open cell keeps its keys. On the
  // way down the root hears them whatever they do afterwards.
  const onRootActivity = (): void => reportSelection();
  for (const event of ['focusin', 'keyup', 'pointerup']) {
    rootEl.addEventListener(event, onRootActivity, true);
  }

  // Column widths set by hand are kept by the host, outside the file. Asked for ahead
  // of `ready`, so the answer comes back before the document and its tables are drawn
  // at those widths from the start. A host that keeps none never answers, and the
  // widths then last as long as this page.
  setTableWidthsHost((message) => post(message), scope);

  // Which pipe tables are shown as boards is kept the same way, outside the file, and
  // asked for ahead of `ready` for the same reason. With no answer a board lasts as
  // long as this page.
  setTableBoardsHost((message) => post(message), scope);

  // Which comments are collapsed is kept the same way, outside the file, and asked for
  // ahead of `ready` so a collapsed comment is drawn collapsed rather than shutting a
  // moment after it appears. With no answer a collapse lasts as long as this page.
  setCommentFoldsHost((message) => post(message), scope);
  // And a document's own front matter state, kept the same way, outside the file.
  setFrontMatterHost((message) => post(message), scope);
  // The heading list's, asked for at the same moment and for the same reason: a document
  // left folded should be drawn folded rather than flickering through the setting first.
  post({ type: 'outlineStateRead', id: `outline-${++outlineSeq}` });

  // A view block naming a .csv or .tsv file asks the host for it. A host that cannot
  // read files never answers, and the view says so in place after a short wait.
  setDataFileHost((message) => post(message), undefined, scope);

  function receive(msg: ToWebview): void {
    switch (msg.type) {
      case 'init':
        config = { ...DEFAULT_CONFIG, ...msg.config };
        fileName = msg.fileName;
        setLinkCompleteDocument(msg.fileName, scope);
        // A host that cannot do a thing must not be offered as though it could.
        // Only a browser sends this, and it sends `terminal: false`, because there
        // is no terminal on the other side of a tab to send anything to. VS Code
        // sends nothing, so everything stays available.
        if (msg.capabilities?.terminal === false) contextMenuDeps.sendRefToTerminal = undefined;
        if (msg.mode === 'csv') {
          // The page is the grid: the formatting toolbar, the block handle and the rest of
          // what edits prose have nothing to act on, and the stylesheet hides them.
          csvMode = true;
          /*
           * On the page's body, because that is what `media/webview.css` names.
           *
           * **It is the one thing this mount still writes outside its own elements**, and on a page
           * holding two editors it would reach the other one. Narrowing it is a change to the
           * stylesheet's selectors rather than to this file, so it is written down here rather
           * than half-done: the class goes on the root as well, which is what a narrowed selector
           * would read, and the body class stays until the stylesheet stops needing it.
           */
          rootEl.classList.add('sheaf-csv-mode');
          rootEl.ownerDocument.body.classList.add('sheaf-csv-mode');
        }
        // A block is moved out to a file beside a Markdown document. The grid of a data
        // file is already the file, so it has nothing to move.
        setMoveToFile(csvMode ? null : moveBlockToFile, scope);
        // A data file's own grid is the file; a view of it belongs in a document, not here.
        setCreateView(csvMode ? null : createViewOf, scope);
        if (msg.notice !== undefined) {
          showingNotice = true;
          const notice = rootEl.ownerDocument.createElement('p');
          notice.className = 'sheaf-notice';
          notice.setAttribute('role', 'status');
          notice.textContent = msg.notice;
          rootEl.replaceChildren(notice);
          break;
        }
        setResourceBaseUri(msg.resourceBaseUri);
        applyConfig(undefined);
        setContent(msg.text);
        applyConfig(view);
        // Opened by a link naming a heading: go to it once the document is there.
        if (msg.fragment) revealFragment(msg.fragment);
        break;
      case 'imageSaved':
        handleImageSaved(msg.id, msg.path, msg.error, scope);
        break;
      case 'workspaceFiles':
        handleWorkspaceFiles(msg.id, msg.files, scope);
        break;
      case 'docTitle':
        handleDocTitle(msg.id, msg.address, msg.title);
        break;
      case 'tableWidths':
        handleTableWidths(msg.id, msg.widths, scope);
        break;
      case 'tableBoards':
        handleTableBoards(msg.id, msg.boards, scope);
        break;
      case 'commentFolds':
        handleCommentFolds(msg.id, msg.folds, scope);
        break;
      case 'frontMatterState':
        handleFrontMatterState(msg.id, msg.state, scope);
        break;
      case 'outlineState':
        ownOutline = msg.state === 'shown' || msg.state === 'collapsed' || msg.state === 'hidden' ? msg.state : null;
        applyConfig(view);
        break;
      case 'dataFile':
        handleDataFile(msg);
        break;
      case 'dataFileCreated':
        handleDataFileCreated(msg, scope);
        break;

      case 'dataFileEdited':
        handleDataFileEdited(msg, scope);
        break;
      case 'setContent':
        setContent(msg.text, msg.tookTypedText === true, msg.ownUndo === true);
        break;
      case 'undoOutsideChange':
        undoOutsideChange();
        break;
      case 'revealFragment':
        revealFragment(msg.id);
        break;
      case 'configChanged':
        config = { ...DEFAULT_CONFIG, ...msg.config };
        applyConfig(view);
        break;
      case 'toggleSourceMode':
        setSourceMode(!sourceMode);
        break;
      case 'getSelection':
        // Skips the debounce in reportSelection: the host is holding a key until this arrives.
        if (view) post({ type: 'selection', ...selectionReport(view), id: msg.id });
        break;
    }
  }

  // Tell the host we're mounted and ready for the initial content.
  post({ type: 'ready' });

  return {
    scope,
    receive,
    blurred: () => post({ type: 'blur' }),
    /**
     * Take this editor down.
     *
     * **It is not a full teardown and says so rather than looking like one.** What it covers is what
     * this file put there: the editor, the listeners on the root, the debounce in flight, the host
     * registrations keyed by this mount, and the one class it writes on the page. What it does not
     * is `createShortcutsOverlay`, which appends an element and registers a `document` keydown
     * listener and offers nothing to undo either with; that is a change to `shortcuts.ts`, and the
     * consumer surface it belongs to is a question of its own rather than this one's to answer.
     */
    destroy: () => {
      if (selectionTimer) clearTimeout(selectionTimer);
      for (const event of ['focusin', 'keyup', 'pointerup']) {
        rootEl.removeEventListener(event, onRootActivity, true);
      }
      setCommentFoldsHost(null, scope);
      if (csvMode) {
        rootEl.classList.remove('sheaf-csv-mode');
        /*
         * Only when no other editor on the page is a data file, because the class is the body's and
         * the stylesheet reads it there. Taking it off while another grid still needs it would give
         * that grid a formatting toolbar it has nothing to act on.
         */
        const others = Array.from(rootEl.ownerDocument.querySelectorAll('.sheaf-csv-mode')).filter((el) => el !== rootEl.ownerDocument.body);
        if (others.length === 0) rootEl.ownerDocument.body.classList.remove('sheaf-csv-mode');
      }
      view?.destroy();
      view = undefined;
      closeMount(scope);
    },
  };
}
