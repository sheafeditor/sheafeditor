/*
 * Webview entry point.
 *
 * Boots a CodeMirror 6 editor whose document is the raw Markdown, layers the
 * live-preview decorations + Notion theme on top, and keeps it in sync with the
 * VS Code TextDocument via postMessage. Also implements double-click-to-edit-
 * source and Cmd/Ctrl-click link opening.
 */

import { EditorState, Transaction, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { isolateHistory, undo } from '@codemirror/commands';
import { setDocumentSourceMode, setLivePreviewConfig } from './livePreview';
import { revealOnDoubleClick } from './revealBlock';
import { paragraphTripleClick } from './paragraphSelect';
import { editorExtensions } from './editorExtensions';
import { mountToolbar, refreshToolbar, reflectTableOfContents } from './toolbar';
import { createTableOfContents } from './tableOfContents';
import { createShortcutsOverlay } from './shortcuts';
import { ContextMenuDeps, mountContextMenu } from './contextmenu';
import { setClipboardHost, handleClipboardText } from './hostClipboard';
import { setWorkspaceFilesHost, handleWorkspaceFiles, setLinkCompleteDocument } from './linkComplete';
import { setBlockRefHost } from './blocks';
import { setResourceBaseUri, setupImageIngestion, handleImageSaved } from './images';
import { headingPosition, linkAddressAt, openLink, setFragmentHost, setLinkHost } from './linkTarget';
import { contentWidth, DEFAULT_CONTENT_WIDTH } from './theme';
import { coveredEnd } from './selectionExtent';
import { buildRef, tableRowRef } from './contextmenu';
import { tableRowRefAt, setTableWidthsHost, handleTableWidths, setTableBoardsHost, handleTableBoards, setMoveToFile } from './tables';
import { viewBlocks, setDataFileHost, handleDataFile, handleDataFileCreated, moveBlockToFile } from './viewBlock';
import { minimalEdit, toWebviewText } from '../textSync';
import { outsideWrite } from './changeMarks';

interface EditorConfig {
  contentWidth: string;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
  tableOfContents: boolean;
}

type ToWebview =
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
  | { type: 'clipboardText'; id: string; text: string }
  /** The answer to `workspaceFilesRead`: the workspace's files, relative to its folder. */
  | { type: 'workspaceFiles'; id: string; files: string[] }
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
   * A data file a view reads: the answer to `dataFileRead` (carrying its `id`), or
   * sent again when the file changes. `text` is the file, or `error` says why not.
   */
  | { type: 'dataFile'; id?: string; path: string; text?: string; error?: string; notice?: string; missing?: boolean }
  /** The answer to `dataFileCreate`: the path written, or why nothing was. */
  | { type: 'dataFileCreated'; id: string; path?: string; error?: string }
  /** A key that names the selection is waiting on the answer, so it goes at once. */
  | { type: 'getSelection'; id: string }
  | { type: 'toggleSourceMode' };

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const rootEl = document.getElementById('editor') as HTMLElement;
const toolbarEl = document.getElementById('toolbar') as HTMLElement;
const shortcutsOverlay = createShortcutsOverlay(document.body);

// Line-number gutter, toggled on/off at runtime from the toolbar via a
// reconfigurable compartment (empty extension = no gutter).
let lineNumbersOn = false;
const lineNumberCompartment = new Compartment();

/** Flip the line-number gutter and return its new visibility (for the toolbar). */
function toggleLineNumbers(): boolean {
  lineNumbersOn = !lineNumbersOn;
  view?.dispatch({
    effects: lineNumberCompartment.reconfigure(lineNumbersOn ? lineNumbers() : []),
  });
  view?.focus();
  return lineNumbersOn;
}

// The table of contents: a rail of the document's headings, in the page margin beside
// the text. It goes in ahead of the editor so that Tab reaches it straight from the
// toolbar, and it is empty and hidden until `sheaf.tableOfContents` says otherwise.
const toc = createTableOfContents(rootEl, () => view);

/**
 * The toolbar button was pressed.
 *
 * Turning the panel on or off is a change to a setting rather than to this editor, so
 * the host makes it, in user settings, and every open Sheaf editor hears about it
 * through the configuration-change path it already has. The one press that is not a
 * setting change is the one that brings a panel back after it was closed on a narrow
 * pane, where the setting was on the whole time.
 */
function toggleTableOfContents(): void {
  if (toc.reopened()) return;
  vscode.postMessage({ type: 'setTableOfContents', on: !toc.enabled() });
}

mountToolbar(
  toolbarEl,
  () => view,
  shortcutsOverlay.toggle,
  () => vscode.postMessage({ type: 'openAsText' }),
  toggleLineNumbers,
  lineNumbersOn,
  toggleTableOfContents,
  false
);

// Workspace-relative path of the current document, used to build "Copy ref".
let fileName = '';

setClipboardHost((message) => vscode.postMessage(message));
setWorkspaceFilesHost((message) => vscode.postMessage(message));
setLinkHost((message) => vscode.postMessage(message));

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

setFragmentHost(revealFragment);

/*
 * Kept rather than passed inline, because what the menu offers depends on what
 * the host can actually do, and that is not known until `init` arrives. The
 * menu reads these each time it opens, so dropping one afterwards removes its
 * item. See the `capabilities` handling below.
 */
const contextMenuDeps: ContextMenuDeps = {
  getView: () => view,
  getFileName: () => fileName,
  copyToClipboard: (text) => vscode.postMessage({ type: 'clipboardWrite', text: fileRef(text) }),
  // The terminal lives in the extension host, so the menu asks for the command rather than doing
  // it. The host already knows the selection: the same message the shortcut reads.
  sendRefToTerminal: () => vscode.postMessage({ type: 'runCommand', command: 'sheaf.sendRefToTerminal' }),
};
mountContextMenu(rootEl, contextMenuDeps);

setBlockRefHost({
  getFileName: () => fileName,
  copyToClipboard: (text) => vscode.postMessage({ type: 'clipboardWrite', text: fileRef(text) }),
});

/* ---- A data file shown as a grid ------------------------------------------ */

/** True when the file is a .csv or .tsv file, framed by the host as one fenced block. */
let csvMode = false;

/** True when the host sent a notice instead of a document, and there is no editor to fill. */
let showingNotice = false;

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

/* ---- Telling the host where the person is -------------------------------- */

/** The lines one selected range covers, counted from one. */
interface SelectionRange {
  start: number;
  end: number;
}

/**
 * How long to wait after the last selection change before telling the host about it.
 * Dragging a selection, or holding an arrow key down, moves it many times on the way
 * to where the person meant to stop, and only where they stopped is worth a message.
 * Short enough that the selection is already there by the time a chord is pressed.
 */
const SELECTION_DEBOUNCE_MS = 100;

let selectionTimer: ReturnType<typeof setTimeout> | undefined;

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
function selectionReport(view: EditorView): { ranges: SelectionRange[]; ref: string } {
  // A table is drawn as one block widget, so the document position under a grid is
  // the table's own edge and names no row at all. The grid is asked instead, and it
  // answers with the lines the file will hold once it is saved, so a row moved in the
  // grid is named where it is going.
  const row = tableRowRefAt(document.activeElement);
  if (row) return { ranges: [{ start: fileLine(row.start), end: fileLine(row.end) }], ref: fileRef(tableRowRef(fileName, row)) };
  const { doc } = view.state;
  const { ranges, mainIndex } = view.state.selection;
  const lines = ranges.map((range) => ({
    start: fileLine(doc.lineAt(range.from).number),
    // A selection ending at the start of a line covers no character of that line, so
    // the range stops at the line before it. Copy ref reads the end the same way, and
    // a triple-clicked line is named as the one line it is.
    end: fileLine(doc.lineAt(coveredEnd(doc, range)).number),
  }));
  return {
    ranges: [lines[mainIndex], ...lines.filter((_, i) => i !== mainIndex)],
    ref: fileRef(buildRef(view, fileName)),
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
    if (view) vscode.postMessage({ type: 'selection', ...selectionReport(view) });
  }, SELECTION_DEBOUNCE_MS);
}

// A table grid keeps its own selection, and moving between its cells is not a
// CodeMirror transaction, so the update listener never hears about it. Focus landing
// somewhere, a key coming back up and a pointer being let go cover the ways a person
// finishes picking rows; each goes through the same debounce as everything else.
// Capture, because the surfaces that most need reporting are the ones that stop these
// events: a grid keeps a pointer press to itself, and an open cell keeps its keys. On the
// way down the root hears them whatever they do afterwards.
for (const event of ['focusin', 'keyup', 'pointerup']) {
  rootEl.addEventListener(event, () => reportSelection(), true);
}

// The page losing keyboard focus, which is the one thing that happens before VS Code
// closes the tab in front when its close button is pressed: the panel stays active until
// it is gone, so the host hears nothing from its own side. The host writes a pending
// auto-save on this, so the close finds nothing unsaved to ask about.
window.addEventListener('blur', () => vscode.postMessage({ type: 'blur' }));

let config: EditorConfig = {
  contentWidth: DEFAULT_CONTENT_WIDTH,
  revealSyntaxOnLine: false,
  doubleClickToEditSource: false,
  tableOfContents: false,
};

// Guards against echoing host-originated changes back to the host.
let applyingRemote = false;
let sourceMode = false;

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

const editableCompartment = new Compartment();

/** Marks transactions that originated from the host, so we don't echo them back. */
const remoteAnnotation = Transaction.remote;

function applyConfig(view: EditorView | undefined): void {
  rootEl.style.setProperty('--md-content-width', contentWidth(config.contentWidth));
  setLivePreviewConfig({ revealSyntaxOnLine: config.revealSyntaxOnLine });
  // A data file has no headings to list.
  toc.setEnabled(config.tableOfContents === true && !csvMode);
  reflectTableOfContents(config.tableOfContents === true);
  if (view) {
    // Force a decoration rebuild by dispatching an empty selection-preserving tx.
    view.dispatch({});
  }
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

function buildState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumberCompartment.of(lineNumbersOn ? lineNumbers() : []),
      editableCompartment.of(EditorView.editable.of(true)),
      csvMode ? fenceGuard : [],
      editorExtensions(shortcutsOverlay.toggle),
      viewBlocks,
      // Report user edits back to the host, and keep the toolbar's buttons current.
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingRemote && !update.transactions.some((tr) => tr.annotation(remoteAnnotation))) {
          vscode.postMessage({ type: 'edit', text: update.state.doc.toString() });
          // The person has changed the document since, so the write that took their
          // text is no longer the step Undo would take back.
          outsideChangeIsOnTop = false;
        }
        if (update.docChanged || update.selectionSet || update.focusChanged) refreshToolbar(update.view);
        // The host keeps the latest selection so its commands can name it. A document
        // change counts as well as a selection change: text put in above the caret
        // moves it to another line without the selection itself being set.
        if (update.selectionSet || update.docChanged) reportSelection();
        // A heading typed, retitled or deleted changes the rail. It is rebuilt on the
        // next frame rather than on the keystroke, so a burst of typing costs one pass.
        if (update.docChanged) toc.documentChanged();
      }),
      // Cmd/Ctrl-click opens links, and double-click reveals an element's raw
      // source. Both ride mousedown: see handleDoubleClick for why dblclick is
      // too late. Triple-click goes through a selection style instead, so that
      // CodeMirror runs it as its own gesture; paragraphSelect.ts says why.
      paragraphTripleClick,
      EditorView.domEventHandlers({
        mousedown: (event, view) => handleLinkClick(event, view) || handleDoubleClick(event, view),
      }),
    ],
  });
}

let view: EditorView | undefined;

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
    setupImageIngestion(view, (message) => vscode.postMessage(message));
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

/** Cmd/Ctrl + click on a rendered link opens it, wherever it points. */
function handleLinkClick(event: MouseEvent, view: EditorView): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const url = linkAddressAt(view.state, pos);
  if (url) {
    event.preventDefault();
    openLink(url);
    return true;
  }
  return false;
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
function handleDoubleClick(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || event.detail !== 2) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  if (!revealOnDoubleClick(view, pos, config.doubleClickToEditSource)) return false;
  event.preventDefault();
  view.focus();
  return true;
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

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      config = msg.config;
      fileName = msg.fileName;
      setLinkCompleteDocument(msg.fileName);
      // A host that cannot do a thing must not be offered as though it could.
      // Only a browser sends this, and it sends `terminal: false`, because there
      // is no terminal on the other side of a tab to send anything to. VS Code
      // sends nothing, so everything stays available.
      if (msg.capabilities?.terminal === false) contextMenuDeps.sendRefToTerminal = undefined;
      if (msg.mode === 'csv') {
        // The page is the grid: the formatting toolbar, the block handle and the rest of
        // what edits prose have nothing to act on, and the stylesheet hides them.
        csvMode = true;
        document.body.classList.add('sheaf-csv-mode');
      }
      // A block is moved out to a file beside a Markdown document. The grid of a data
      // file is already the file, so it has nothing to move.
      setMoveToFile(csvMode ? null : moveBlockToFile);
      if (msg.notice !== undefined) {
        showingNotice = true;
        const notice = document.createElement('p');
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
      handleImageSaved(msg.id, msg.path, msg.error);
      break;
    case 'clipboardText':
      handleClipboardText(msg.id, msg.text);
      break;
    case 'workspaceFiles':
      handleWorkspaceFiles(msg.id, msg.files);
      break;
    case 'tableWidths':
      handleTableWidths(msg.id, msg.widths);
      break;
    case 'tableBoards':
      handleTableBoards(msg.id, msg.boards);
      break;
    case 'dataFile':
      handleDataFile(msg);
      break;
    case 'dataFileCreated':
      handleDataFileCreated(msg);
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
      config = msg.config;
      applyConfig(view);
      break;
    case 'toggleSourceMode':
      setSourceMode(!sourceMode);
      break;
    case 'getSelection':
      // Skips the debounce in reportSelection: the host is holding a key until this arrives.
      if (view) vscode.postMessage({ type: 'selection', ...selectionReport(view), id: msg.id });
      break;
  }
});

// Column widths set by hand are kept by the host, outside the file. Asked for ahead
// of `ready`, so the answer comes back before the document and its tables are drawn
// at those widths from the start. A host that keeps none never answers, and the
// widths then last as long as this page.
setTableWidthsHost((message) => vscode.postMessage(message));

// Which pipe tables are shown as boards is kept the same way, outside the file, and
// asked for ahead of `ready` for the same reason. With no answer a board lasts as
// long as this page.
setTableBoardsHost((message) => vscode.postMessage(message));

// A view block naming a .csv or .tsv file asks the host for it. A host that cannot
// read files never answers, and the view says so in place after a short wait.
setDataFileHost((message) => vscode.postMessage(message));

// Tell the host we're mounted and ready for the initial content.
vscode.postMessage({ type: 'ready' });
