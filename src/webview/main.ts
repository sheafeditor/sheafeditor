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
import { setLivePreviewConfig } from './livePreview';
import { revealOnDoubleClick } from './revealBlock';
import { editorExtensions } from './editorExtensions';
import { mountToolbar, refreshToolbar } from './toolbar';
import { createShortcutsOverlay } from './shortcuts';
import { mountContextMenu } from './contextmenu';
import { setClipboardHost, handleClipboardText } from './hostClipboard';
import { setBlockRefHost } from './blocks';
import { setResourceBaseUri, setupImageIngestion, handleImageSaved } from './images';
import { headingPosition, linkAddressAt, openLink, setFragmentHost, setLinkHost } from './linkTarget';
import { minimalEdit } from '../textSync';

interface EditorConfig {
  contentWidth: string;
  revealSyntaxOnLine: boolean;
  doubleClickToEditSource: boolean;
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
    }
  | { type: 'setContent'; text: string }
  | { type: 'revealFragment'; id: string }
  | { type: 'configChanged'; config: EditorConfig }
  | { type: 'imageSaved'; id: string; path?: string; error?: string }
  | { type: 'clipboardText'; id: string; text: string }
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

mountToolbar(
  toolbarEl,
  () => view,
  shortcutsOverlay.toggle,
  () => vscode.postMessage({ type: 'openAsText' }),
  toggleLineNumbers,
  lineNumbersOn
);

// Workspace-relative path of the current document, used to build "Copy ref".
let fileName = '';

setClipboardHost((message) => vscode.postMessage(message));
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

mountContextMenu(rootEl, {
  getView: () => view,
  getFileName: () => fileName,
  copyToClipboard: (text) => vscode.postMessage({ type: 'clipboardWrite', text }),
});

setBlockRefHost({
  getFileName: () => fileName,
  copyToClipboard: (text) => vscode.postMessage({ type: 'clipboardWrite', text }),
});

let config: EditorConfig = {
  contentWidth: '708px',
  revealSyntaxOnLine: false,
  doubleClickToEditSource: false,
};

// Guards against echoing host-originated changes back to the host.
let applyingRemote = false;
let sourceMode = false;

const editableCompartment = new Compartment();

/** Marks transactions that originated from the host, so we don't echo them back. */
const remoteAnnotation = Transaction.remote;

function applyConfig(view: EditorView | undefined): void {
  rootEl.style.setProperty('--md-content-width', config.contentWidth);
  setLivePreviewConfig({ revealSyntaxOnLine: config.revealSyntaxOnLine });
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

function buildState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumberCompartment.of(lineNumbersOn ? lineNumbers() : []),
      editableCompartment.of(EditorView.editable.of(true)),
      editorExtensions(shortcutsOverlay.toggle),
      // Report user edits back to the host, and keep the toolbar's buttons current.
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingRemote && !update.transactions.some((tr) => tr.annotation(remoteAnnotation))) {
          vscode.postMessage({ type: 'edit', text: update.state.doc.toString() });
        }
        if (update.docChanged || update.selectionSet || update.focusChanged) refreshToolbar(update.view);
      }),
      // Cmd/Ctrl-click opens links; double-click reveals an element's raw source.
      // Both ride mousedown — see handleDoubleClick for why dblclick is too late.
      EditorView.domEventHandlers({
        mousedown: (event, view) => handleLinkClick(event, view) || handleDoubleClick(event, view),
      }),
    ],
  });
}

let view: EditorView | undefined;

function setContent(text: string): void {
  if (!view) {
    view = new EditorView({ state: buildState(text), parent: rootEl });
    setupImageIngestion(view, (message) => vscode.postMessage(message));
    return;
  }
  if (view.state.doc.toString() === text) return;
  applyingRemote = true;
  try {
    const change = diff(view.state.doc.toString(), text);
    view.dispatch({
      changes: change,
      // A change made outside this editor is not this editor's to undo: Cmd+Z takes
      // back the person's own last edit and keeps the outside one.
      annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
      // Keep the selection valid without yanking the viewport around.
      scrollIntoView: false,
    });
  } finally {
    applyingRemote = false;
  }
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

function setSourceMode(on: boolean): void {
  sourceMode = on;
  rootEl.classList.toggle('source-mode', on);
  setLivePreviewConfig({ revealSyntaxOnLine: config.revealSyntaxOnLine });
  // In source mode we want everything revealed: select-all-lines is heavy, so we
  // instead flip a class the CSS uses and let the engine keep rendering; a full
  // "raw only" mode is a Phase-2 refinement. For now toggle just restyles fonts.
  if (view) view.dispatch({});
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      config = msg.config;
      fileName = msg.fileName;
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
    case 'setContent':
      setContent(msg.text);
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
  }
});

// Tell the host we're mounted and ready for the initial content.
vscode.postMessage({ type: 'ready' });
