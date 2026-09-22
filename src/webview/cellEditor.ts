/*
 * The editor inside a table cell.
 *
 * Everywhere else in Sheaf typing happens in the rendered document. A pipe-table
 * cell was the one exception: the grid drew the cell's Markdown until it was
 * opened, and opening it laid a plain text box over the drawing holding the raw
 * source, so a bold word came back as asterisks and a link as brackets at the
 * moment someone started editing it. A cell now opens a small CodeMirror view over
 * the same text with the live-preview decorations on it, so it renders while it is
 * typed into exactly as a paragraph does, and the inline formatting keys, the
 * selection toolbar and the link popover all reach it because it is an editor
 * rather than a form control.
 *
 * A cell holds one line of inline Markdown and never a block, so the parser is
 * built without the block constructs (headings, lists, quotes, fences, rules,
 * reference definitions and tables), Enter commits the cell rather than opening a
 * line, and a line break arriving in one some other way becomes a space, which is
 * what the table's own writer makes of it anyway.
 *
 * A CSV or TSV field holds data rather than Markdown, and drawing it as Markdown
 * would be wrong, so it keeps the plain text box and the line breaks a field may
 * hold. Both kinds are built here and both answer to `CellEditor`, so the grid
 * talks to one thing.
 *
 * The keys the grid owns (Tab, Enter and Escape) are read from a capture listener
 * on the frame around the editor rather than from either editor's own handling.
 * Capture is what puts them ahead of CodeMirror's keymap, which would otherwise
 * open a line on Enter before the cell could commit, and one listener in one place
 * is what keeps the two kinds of cell answering the same keys the same way.
 */

import { EditorState, Extension } from '@codemirror/state';
import { EditorView, KeyBinding, keymap } from '@codemirror/view';
import { defaultKeymap, history, redo, undo } from '@codemirror/commands';
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { markdownDialect } from './markdownDialect';
import { livePreview, revealField } from './livePreview';
import { selectionToolbar } from './selectionToolbar';
import { setDismissed, toolbarShown } from './floatingState';
import { buildEditingKeymap } from './shortcuts';
import { pendingMarks } from './toolbar';
import { linkAddressAt, openLink } from './linkTarget';
import { installLinkPaste } from './linkPaste';

/** An open cell, whichever kind it is. The grid knows a cell through this and nothing else. */
export interface CellEditor {
  /** The frame laid over the cell, which carries `sheaf-table-input`. */
  readonly host: HTMLElement;
  /** Whether the editor draws the cell's Markdown, or shows the text as written. */
  readonly rendered: boolean;
  /** The cell's text as it now stands. */
  readonly value: string;
  /** Whether `node` is part of this editor. */
  contains: (node: Node | null) => boolean;
  /** Take the keyboard, without scrolling the page to do it. */
  focus: () => void;
  /** Let go of everything the editor holds. The cell's DOM is the caller's to replace. */
  destroy: () => void;
}

/** What the grid tells a cell editor, and what it wants told back. */
export interface CellEditorSpec {
  /** Markdown, as a pipe-table cell holds. False for a CSV or TSV field, which is data. */
  markdown: boolean;
  /** The text to open with. */
  value: string;
  /** Whether that text is selected on open, so the next keystroke replaces it. */
  selectAll: boolean;
  /** The field's accessible name. */
  label: string;
  /** The text changed: the cell may now ask for a different width. */
  onMeasure: (value: string) => void;
  /** The text changed other than under an input method: write it through. */
  onInput: () => void;
  /** An input method started (true) or finished (false) composing. */
  onComposing: (composing: boolean) => void;
  /** Enter, or Shift+Enter: commit and move a row. */
  onEnter: (back: boolean) => void;
  /** Tab, or Shift+Tab: commit and move a cell. */
  onTab: (back: boolean) => void;
  /** Escape: put the cell back as it was. */
  onEscape: () => void;
  /** A press inside the text, which the grid may grow into a cell range. */
  onPointerDown: () => void;
  /**
   * Undo (false) or redo (true) with nothing left to take back in the cell's own
   * history. The step is the document's, so the grid closes the cell and runs it.
   */
  onHistoryEnd: (redo: boolean) => void;
}

/**
 * The Markdown a cell may hold: everything inline, and no block at all. A cell is
 * one line inside a row, so a `#`, a `-` or a `>` at the start of one is the
 * character itself wherever the table is read, and a parser that made a heading, a
 * bullet or a quote of it would draw the cell as something no reader shows.
 */
const CELL_BLOCKS = [
  'ATXHeading',
  'SetextHeading',
  'FencedCode',
  'IndentedCode',
  'Blockquote',
  'HorizontalRule',
  'BulletList',
  'OrderedList',
  'TaskList',
  'HTMLBlock',
  'LinkReference',
  'Table',
];

const cellLanguage = markdown({
  base: commonmarkLanguage,
  extensions: [markdownDialect, { remove: CELL_BLOCKS }],
  addKeymap: false,
  // The document's own rules answer a pasted address, through installLinkPaste
  // below, so a cell and a paragraph a few pixels apart do the same thing.
  pasteURLAsLink: false,
});

/**
 * The formatting chords, taken from the one list of shortcuts the editor is built
 * from so a cell and a paragraph answer the same keys. The block chords are left
 * out: there is no heading, list or quote to make inside a row.
 *
 * Read on first use rather than at load, because the modules this reaches through
 * import each other and the answer is the same whenever it is asked for.
 */
const INLINE_CHORDS = new Set(['Mod-b', 'Mod-i', 'Mod-Shift-x', 'Mod-Shift-h', 'Mod-e', 'Mod-k']);
let inlineChords: KeyBinding[] | null = null;
function inlineFormattingKeymap(): KeyBinding[] {
  inlineChords ??= buildEditingKeymap(() => {}).filter((b) => !!b.key && INLINE_CHORDS.has(b.key));
  return inlineChords;
}

/**
 * Undo and redo inside a cell are the cell's own, as they were in the text box it
 * replaced. They stop here: the webview host forwards every Ctrl or Cmd with Z or Y
 * that reaches the window to VS Code, which would otherwise also undo the file.
 *
 * Once the cell has nothing left to take back, the key is the document's. A cell
 * that has only just opened has no history of its own, and that includes one the
 * grid reopened after a write from outside, which is where the step that gives the
 * person's typing back is waiting.
 */
function historyChords(spec: CellEditorSpec): KeyBinding[] {
  const step =
    (run: (view: EditorView) => boolean, again: boolean) =>
    (view: EditorView): boolean => {
      if (!run(view)) spec.onHistoryEnd(again);
      return true;
    };
  return [
    { key: 'Mod-z', run: step(undo, false), preventDefault: true, stopPropagation: true },
    { key: 'Mod-Shift-z', run: step(redo, true), preventDefault: true, stopPropagation: true },
    { key: 'Mod-y', run: step(redo, true), preventDefault: true, stopPropagation: true },
  ];
}

/** Whether a key is undo (false), redo (true), or neither (null). */
function historyKey(e: KeyboardEvent): boolean | null {
  const key = e.key.toLowerCase();
  if (key === 'z' && (e.metaKey || e.ctrlKey)) return e.shiftKey;
  if (key === 'y' && e.ctrlKey && !e.metaKey) return true;
  return null;
}

/**
 * A cell is one line. A line break arriving in one, from a paste or a drop, becomes
 * a space: that is what the table's writer would make of it, and leaving it in the
 * editor would draw a second line the row has nowhere to put.
 */
const oneLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let broken = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1) broken = true;
  });
  if (!broken) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString().replace(/\r\n?|\n/g, ' ') });
  });
  const set = tr.startState.changes(changes);
  return {
    changes: set,
    selection: { anchor: set.mapPos(tr.startState.selection.main.to, 1) },
    scrollIntoView: tr.scrollIntoView,
  };
});

/** Cmd/Ctrl-click on a rendered link in a cell opens it, as it does in prose. */
function openLinkUnder(e: MouseEvent, view: EditorView): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  let pos: number | null = null;
  try {
    pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  } catch {
    return false; // no layout to hit-test against
  }
  if (pos == null) return false;
  const url = linkAddressAt(view.state, pos);
  if (!url) return false;
  e.preventDefault();
  e.stopPropagation();
  openLink(url);
  return true;
}

/**
 * The keys the grid owns rather than the editor: Tab and Enter move between cells
 * and Escape backs out of the edit. `area` is the plain field, whose Home and End
 * need placing by hand; the Markdown editor places them itself.
 *
 * Returns whether the key was the grid's.
 */
function gridKey(e: KeyboardEvent, spec: CellEditorSpec, area: HTMLTextAreaElement | null): boolean {
  // Undo and redo in a plain field are the field's own; kept from the window, they
  // do not also run VS Code's undo on the file. The Markdown cell is read here on the
  // way down, and stopping the key now would keep it from the editor's own undo, so
  // that cell's history keys stop in its keymap instead.
  if (area && historyKey(e) !== null) e.stopPropagation();
  // Enter or Tab while an input method is composing belongs to the IME.
  if (e.isComposing || e.keyCode === 229) return false;
  const claim = (): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  if ((e.key === 'Home' || e.key === 'End') && !e.metaKey && !e.ctrlKey && !e.altKey && area) {
    // Chromium on macOS leaves the caret where it is for Home and End in a text
    // field inside the editor's content, so place it here; Shift extends. A CSV
    // cell can hold line breaks, so they go to the ends of the line the caret is
    // on, which for every other cell is the ends of the value.
    e.preventDefault();
    const caret = (area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd) ?? 0;
    const after = area.value.indexOf('\n', caret);
    const to =
      e.key === 'Home'
        ? area.value.lastIndexOf('\n', caret - 1) + 1
        : after === -1
          ? area.value.length
          : after;
    const from = e.shiftKey ? (area.selectionDirection === 'backward' ? area.selectionEnd : area.selectionStart) ?? to : to;
    area.setSelectionRange(Math.min(from, to), Math.max(from, to), to < from ? 'backward' : 'forward');
    return true;
  }
  if (e.key === 'Tab') {
    claim();
    spec.onTab(e.shiftKey);
    return true;
  }
  if (e.key === 'Enter') {
    // Alt+Enter adds a line break inside a CSV cell, as in a spreadsheet. A pipe
    // table's cell has no way to hold one, so there Enter commits however it is held.
    // The break is put in here: a text box in Chromium on macOS inserts nothing for
    // Alt+Enter, so a key let through to it added nothing to the value.
    if (e.altKey && !spec.markdown && area) {
      claim();
      area.setRangeText('\n', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null }));
      return true;
    }
    claim();
    spec.onEnter(e.shiftKey);
    return true;
  }
  if (e.key === 'Escape') {
    claim();
    spec.onEscape();
    return true;
  }
  return false;
}

/** The plain text box a CSV or TSV field edits in. */
function plainCell(spec: CellEditorSpec): CellEditor {
  // The field wraps its value the way the cell wraps its text, so a cell holding a
  // sentence opens at the size it was already drawn at. A one-line text input cannot
  // wrap: it collapsed the row to a single line and left most of the value scrolled
  // off to the right. A CSV field also holds line breaks of its own, which a text
  // input silently drops.
  const area = document.createElement('textarea');
  area.rows = 1;
  area.className = 'sheaf-table-input';
  area.setAttribute('aria-label', spec.label);
  area.value = spec.value;
  // The field's own undo history is the browser's and cannot be read, but it has
  // nothing in it until the field is first changed. Until then Undo and Redo are the
  // document's, as they are in a Markdown cell with nothing left to take back.
  let edited = false;
  area.addEventListener('keydown', (e) => {
    const again = historyKey(e);
    if (again !== null && !edited && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      spec.onHistoryEnd(again);
      return;
    }
    gridKey(e as KeyboardEvent, spec, area);
  });
  area.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    spec.onPointerDown();
  });
  area.addEventListener('compositionstart', () => spec.onComposing(true));
  area.addEventListener('compositionend', () => spec.onComposing(false));
  area.addEventListener('input', (e) => {
    edited = true;
    spec.onMeasure(area.value);
    if ((e as InputEvent).isComposing) return;
    spec.onInput();
  });
  return {
    host: area,
    rendered: false,
    get value() {
      return area.value;
    },
    contains: (node) => !!node && (area === node || area.contains(node)),
    focus: () => {
      area.focus({ preventScroll: true });
      if (spec.selectAll) area.select();
    },
    destroy: () => {
      /* nothing beyond the element, which the cell drops */
    },
  };
}

/** The Markdown editor a pipe-table cell edits in. */
function markdownCell(spec: CellEditorSpec): CellEditor {
  const host = document.createElement('div');
  host.className = 'sheaf-table-input is-markdown';
  // Ahead of CodeMirror's own keymap, which would open a line on Enter before the
  // cell could commit. Capture reaches the key on its way down to the content.
  host.addEventListener(
    'keydown',
    (e) => {
      // With the selection toolbar up, Escape puts the toolbar away and the cell
      // stays open, as it does over a paragraph; the next Escape backs out of the edit.
      if ((e as KeyboardEvent).key === 'Escape' && toolbarShown(view.state)) {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({ effects: setDismissed.of({ toolbar: true }) });
        return;
      }
      gridKey(e as KeyboardEvent, spec, null);
    },
    true
  );
  host.addEventListener('mousedown', (e) => openLinkUnder(e as MouseEvent, view), true);
  host.addEventListener('mousedown', (e) => {
    // The cell keeps the press: the grid's own cell handler would end the edit.
    e.stopPropagation();
    spec.onPointerDown();
  });
  host.addEventListener('compositionstart', () => spec.onComposing(true));
  host.addEventListener('compositionend', () => spec.onComposing(false));
  // The cell's editor lives inside the document's editor, so every key it handles
  // would go on to be handled a second time by the document. Cmd+A is the one that
  // showed it: the cell selected its own text, the document selected all of itself,
  // and the next letter typed replaced the whole file. A key that has reached the
  // cell has been dealt with, so it stops here, on the way back up and after the
  // cell's own keymap has run. The keys the grid owns never get this far: the
  // capture listener above claims them on the way down.
  const keepInCell = (e: Event): void => e.stopPropagation();
  host.addEventListener('keydown', keepInCell);
  host.addEventListener('keypress', keepInCell);
  host.addEventListener('keyup', keepInCell);
  // Inside an open cell the platform's own cut, copy and paste menu is the right
  // one, as it is in the plain field. The table menu reads a right-click anywhere
  // in the editor's content and would open over the text instead, so the event
  // stops at the cell.
  host.addEventListener('contextmenu', (e) => e.stopPropagation());

  const extensions: Extension[] = [
    cellLanguage,
    history(),
    revealField,
    livePreview,
    selectionToolbar,
    pendingMarks,
    oneLine,
    EditorView.lineWrapping,
    // `tabindex` keeps the content out of the tab order, which the grid owns, and
    // leaves it focusable by script, which is how a cell is opened.
    EditorView.contentAttributes.of({ 'aria-label': spec.label, tabindex: '-1' }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      spec.onMeasure(update.state.doc.toString());
      spec.onInput();
    }),
    keymap.of([...inlineFormattingKeymap(), ...historyChords(spec)]),
    keymap.of(defaultKeymap),
  ];

  const view = new EditorView({
    state: EditorState.create({
      doc: spec.value,
      selection: spec.selectAll ? { anchor: 0, head: spec.value.length } : { anchor: spec.value.length },
      extensions,
    }),
    parent: host,
  });
  // A web address pasted over words links them, by the same rules as in a paragraph.
  installLinkPaste(view);
  // The toolbar belongs to a selection someone made, not to the whole value every
  // cell opens with, so it waits until someone selects: a drag, a double-click on
  // a word, or Cmd+A, which selects that same whole value on purpose.
  view.dispatch({ effects: setDismissed.of({ toolbar: true, popover: true }) });

  return {
    host,
    rendered: true,
    get value() {
      return view.state.doc.toString();
    },
    contains: (node) => !!node && (host === node || host.contains(node)),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

/**
 * Open a cell for editing. Markdown cells render while they are typed into; data
 * cells do not.
 *
 * A cell that cannot be built as an editor falls back to the plain box, which is
 * visibly a text field rather than a cell that would not open at all.
 */
export function createCellEditor(spec: CellEditorSpec): CellEditor {
  if (!spec.markdown) return plainCell(spec);
  try {
    return markdownCell(spec);
  } catch (err) {
    console.warn('Sheaf could not draw this table cell while editing it; editing it as plain text.', err);
    return plainCell(spec);
  }
}
