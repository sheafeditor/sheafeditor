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
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { sheafMarkdown } from './markdownDialect';
import { markdownDialect } from '../dialect/markdown';
import { livePreview } from './livePreview';
import { revealField } from './revealState';
import { toggleWholeReveal } from './revealBlock';
import { selectionToolbar } from './selectionToolbar';
import { setDismissed, toolbarShown } from './floatingState';
import { inlineOnlyEditor } from './inlineOnly';
import { buildEditingKeymap } from './shortcuts';

/*
 * Which editor an open cell is, for the chrome that sits outside the table.
 *
 * The top toolbar is mounted once, against the document's own editor, and a cell opened for
 * editing is a *different* `EditorView` with its own state, its own history and its own
 * keymap. So a toolbar button pressed while a cell was open ran against the outer document
 * and formatted whatever had been selected there last, which in a long document is anywhere.
 * The word in the cell was untouched, the cell closed, and nothing said so.
 *
 * The keys were never affected, which is why this could go unnoticed: Cmd+B works in a cell
 * because the keymap is in the cell's own extensions, and the floating selection toolbar works
 * for the same reason. Only the chrome mounted once, outside, could reach the wrong editor.
 *
 * `null` means no cell has focus, so the outer editor is the right target. A returned record
 * means a cell does, and its `view` is the editor to act on, or `null` for a data cell, which
 * is a plain text box with no editor behind it and nothing a Markdown control can do to it.
 * The caller draws its controls unavailable in that case rather than acting somewhere else.
 */
// `inlineOnlyEditor`, which this editor declares below, is defined in `./inlineOnly` and imported
// there rather than re-exported from here. A re-export would leave the import that reaches this
// module from the chrome available to whoever writes the next one. See that file for why it matters.

interface FocusedCell {
  /** The cell's editor, or null for a data cell, which is a plain text box. */
  view: EditorView | null;
  /** The element focus lands on, which is the text box itself for a data cell. */
  host: HTMLElement;
}
let focusedCell: FocusedCell | null = null;
let cellActivity: (() => void) | null = null;

/**
 * The cell that is open for editing, or null when the outer editor is the right target.
 *
 * **An open cell, not a focused one, and that distinction is the whole of it.** Asking
 * `hasFocus` was the first version and it was wrong for the two dropdowns: their menu items
 * take focus when pressed, so by the time the handler ran the cell no longer had it, the outer
 * editor was handed back as the target, and Heading 1 put a `#` on the first line of the
 * document exactly as before. The buttons did not show this because each one cancels its own
 * `mousedown` to keep the selection, so focus never left them. One reading of the same control
 * surface, two answers, and only a probe that pressed every one of them found it.
 *
 * Being open is the honest signal in any case: the grid commits and destroys the editor when
 * focus leaves the table, so its lifetime is exactly the period during which the chrome should
 * be pointed at it, and nothing about which element happens to hold focus mid-gesture comes
 * into it.
 */
export function focusedCellEditor(): FocusedCell | null {
  if (!focusedCell) return null;
  return focusedCell.host.isConnected ? focusedCell : null;
}

/**
 * Register a callback for when the focused cell changes or its content does, so chrome showing
 * the state of a selection can follow it into the cell and back out.
 *
 * One callback rather than a list: there is one toolbar, and a second caller would be a sign
 * that this wants to be a facet on the view instead.
 */
export function onCellEditorActivity(cb: () => void): void {
  cellActivity = cb;
}
import { pendingMarks } from './pendingMarks';
import { HeldLink, contextMenuOnLink, pressOnLinkIn, releaseOnLinkIn } from './linkGesture';
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

// `sheafMarkdown` installs no paste handler of its own, which is what a cell wants: the document's
// own rules answer a pasted address, through installLinkPaste below, so a cell and a paragraph a few
// pixels apart do the same thing.
const cellLanguage = sheafMarkdown({
  base: commonmarkLanguage,
  extensions: [markdownDialect, { remove: CELL_BLOCKS }],
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
 * Mod-Alt-e shows the cell's own raw Markdown, and shows it again as a rendered cell.
 *
 * It is the same key that shows a paragraph's source, doing the same thing one scope in.
 * A cell holding `**start**. hello world` drew a bold word with no way to find out what was
 * under it: the key was not in the cell's keymap, and the table's own `</>` reveals the whole
 * table, which answers a different question and loses the cell in a wall of pipes.
 *
 * **The range is the whole cell, which is the whole document here**, because a cell editor's
 * document is that one cell. `toggleWholeReveal` is that, and it is shared with the cell's
 * toolbar button and its right-click item so the three cannot drift apart.
 *
 * Leaving the cell needs nothing here, because leaving it destroys the editor and the next
 * open builds a fresh one with no reveal.
 *
 * The table's `</>` is untouched and still opens the table's source.
 */
function revealChord(): KeyBinding[] {
  return [{ key: 'Mod-Alt-e', run: toggleWholeReveal }];
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
  /*
   * A data cell has no editor behind it, so it registers itself with a null view. That is what
   * tells the chrome outside to draw its Markdown controls unavailable rather than run them
   * against the outer document, which is what they did before and what nobody could see.
   */
  focusedCell = { view: null, host: area };
  cellActivity?.();
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
      // Nothing beyond the element, which the cell drops. The registration goes with it, so
      // the chrome outside stops treating a removed text box as the thing with focus.
      if (focusedCell?.host === area) focusedCell = null;
      cellActivity?.();
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
      /*
       * A key typed in the link popover belongs to the popover. The popover is a tooltip of the
       * cell's own editor, so it sits inside this host and this listener sees its keys on the way
       * down, before the popover does. All three keys the grid claims were wrong there: Enter
       * committed the cell instead of saving the link, Escape closed the cell instead of the
       * popover, and Tab stepped to the next cell instead of moving between the two fields.
       */
      const target = e.target as Element | null;
      if (typeof target?.closest === 'function' && target.closest('.sheaf-linkpop')) return;
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
  /*
   * A click on a link in an open cell opens it, as one in prose does. The press only
   * remembers the link and lets the editor place the caret; the release opens it if nothing
   * moved, so a drag that starts on a link still selects. `linkGesture.ts` holds both halves
   * and the closed cell's version of the same reasoning is `pressOnLink` in `tables.ts`.
   */
  let heldInCell: HeldLink | null = null;
  host.addEventListener(
    'mousedown',
    (e) => {
      const { opened, hold } = pressOnLinkIn(view, e as MouseEvent);
      heldInCell = hold;
      if (opened) e.stopPropagation();
    },
    true
  );
  host.addEventListener(
    'mouseup',
    (e) => {
      const held = heldInCell;
      heldInCell = null;
      if (releaseOnLinkIn(view, e as MouseEvent, held)) e.stopPropagation();
    },
    true
  );
  // And a right-click on one opens its popover rather than any menu.
  host.addEventListener('contextmenu', (e) => contextMenuOnLink(view, e as MouseEvent), true);
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
  /*
   * No `contextmenu` listener, deliberately. A right-click here goes on to the document's
   * own menu, which recognises an open cell ahead of the grid and builds itself against
   * the cell's editor: Edit Markdown, Copy ref, the marks and Clear formatting.
   *
   * It used to stop here so the platform's cut, copy and paste menu opened instead. That
   * was the lesser of two wrongs: the alternative at the time was the table's row and
   * column menu opening over text somebody was typing, because the cell sits inside the
   * grid. A data cell is a plain text box and the menu still leaves those to the platform.
   */

  const extensions: Extension[] = [
    cellLanguage,
    inlineOnlyEditor.of(true),
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
    /*
     * Tell the chrome outside the table which editor it should be acting on and showing the
     * state of. Focus decides the target; a change or a new selection inside the cell is what
     * makes a button's own drawn state stale.
     */
    EditorView.domEventHandlers({
      focusin: () => {
        cellActivity?.();
        return false;
      },
      focusout: () => {
        cellActivity?.();
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) cellActivity?.();
    }),
    keymap.of([...revealChord(), ...inlineFormattingKeymap(), ...historyChords(spec)]),
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

  // Open, so the chrome outside the table acts on this cell until it is destroyed.
  focusedCell = { view, host };
  cellActivity?.();

  return {
    host,
    rendered: true,
    get value() {
      return view.state.doc.toString();
    },
    contains: (node) => !!node && (host === node || host.contains(node)),
    focus: () => view.focus(),
    destroy: () => {
      // The chrome outside must stop targeting an editor that is going away, or a button
      // pressed afterwards would run against a destroyed view.
      if (focusedCell?.view === view) focusedCell = null;
      view.destroy();
      cellActivity?.();
    },
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
