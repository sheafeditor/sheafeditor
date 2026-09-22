/*
 * End-to-end table-editing harness (bundled for the jsdom test runner).
 *
 * Each scenario mounts a real CodeMirror editor with the `tables` block-widget
 * field, drives the rendered grid through genuine DOM events (mouse, keyboard,
 * clipboard) exercising the widget's own handlers, and asserts on the resulting
 * *document text* after the model is serialized back — i.e. the full round-trip
 * a user would perform. `runAll()` returns one result row per scenario.
 */

import { EditorSelection, EditorState, Extension, Transaction } from '@codemirror/state';
import { history, undo, redo, undoDepth, redoDepth, isolateHistory } from '@codemirror/commands';
import { minimalEdit } from '../src/textSync';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { forceParsing } from '@codemirror/language';
import { SearchQuery, setSearchQuery, closeSearchPanel, openSearchPanel } from '@codemirror/search';
import { livePreview, revealField, setLivePreviewConfig } from '../src/webview/livePreview';
import { revealBlockAt } from '../src/webview/revealBlock';
import { searchSupport, findNextMatch, findPreviousMatch } from '../src/webview/search';
import { sheafMarkdownLanguage } from '../src/webview/markdownDialect';
import {
  tables,
  tableRowSourceAt,
  tableActionsAt,
  insertPipeTable,
  insertCsvTable,
  TABLE_COMMANDS,
  setTableWidthsHost,
  handleTableWidths,
  setTableBoardsHost,
  handleTableBoards,
  tableWidthKey,
  estimateTableHeight,
  estimateColumnWidths,
  delimitedParseCount,
  tableSearchPasses,
  dataBlocks,
  writeDataBlock,
  writeDataFile,
  setMoveToFile,
} from '../src/webview/tables';
import { setResourceBaseUri } from '../src/webview/images';
import { viewBlocks, setDataFileHost, handleDataFile, handleDataFileCreated, moveBlockToFile } from '../src/webview/viewBlock';
import { notionTheme } from '../src/webview/theme';
import { mountContextMenu } from '../src/webview/contextmenu';
import { hint } from '../src/webview/shortcuts';
import { setLinkHost } from '../src/webview/linkTarget';
import { columnWidthChecks } from './columnWidths.cases';
import { allocateColumnWidths, COLUMN_CAP_FRACTION, COLUMN_FLOOR_CH } from '../src/webview/columnWidths';
import { changeMarks, outsideWrite } from '../src/webview/changeMarks';

// The setting the editor ships with: a plain selection never exposes syntax
// markers. Without it the suite would run on the module's own default, which is
// the opposite, and a cell being edited would show its Markdown rather than draw it.
setLivePreviewConfig({ revealSyntaxOnLine: false });

// A leading paragraph keeps the default cursor (pos 0) off the table, so it
// renders as a grid instead of revealing source.
const P = '.\n\n';

const G: any = globalThis;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mkView(doc: string, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // The webview's own dialect, so the suite parses what the editor parses.
        markdown({ base: sheafMarkdownLanguage, codeLanguages: languages }),
        revealField,
        livePreview,
        tables,
        notionTheme,
        EditorView.lineWrapping,
        ...extra,
      ],
    }),
    parent,
  });
}

interface Harness {
  view: EditorView;
  root: () => HTMLElement | null;
  grid: () => HTMLElement | null;
  cell: (r: number, c: number) => HTMLElement | null;
  ctrl: (id: string) => HTMLButtonElement | null;
  mousedown: (el: Element, opts?: any) => void;
  dblclick: (el: Element) => void;
  keydown: (el: Element, key: string, opts?: any) => void;
  input: (r: number, c: number) => HTMLTextAreaElement | null;
  focusGrid: () => void;
  clipboard: (type: 'copy' | 'cut' | 'paste', text?: string) => { text: string; html: string };
  commit: () => Promise<string>;
  doc: () => string;
}

/**
 * The open field inside `host`, as a scenario drives it.
 *
 * A CSV field is a textarea and comes back as it is. A pipe-table cell is a small
 * CodeMirror view, which has no `value`: its content element gets one here, so a
 * scenario reads and replaces a cell's text the same way whichever kind it is, and
 * so that keys and pointer events sent to it reach the editor's own handlers.
 */
function cellField(host: Element | null): HTMLTextAreaElement | null {
  const el = host?.querySelector('.sheaf-table-input') as HTMLElement | null;
  if (!el) return null;
  if (el instanceof G.HTMLTextAreaElement) return el as HTMLTextAreaElement;
  const cm = cellView(host);
  if (!cm) return null;
  const content = cm.contentDOM as unknown as HTMLTextAreaElement;
  if (!Object.getOwnPropertyDescriptor(content, 'value')) {
    Object.defineProperty(content, 'value', {
      configurable: true,
      get: () => cm.state.doc.toString(),
      set: (v: string) =>
        cm.dispatch({
          changes: { from: 0, to: cm.state.doc.length, insert: v },
          selection: { anchor: v.length },
          userEvent: 'input.type',
        }),
    });
  }
  return content;
}

/** The editor a Markdown cell opens in; null for a CSV field's plain box, and for a closed cell. */
function cellView(host: Element | null): EditorView | null {
  const el = host?.querySelector('.sheaf-table-input') as HTMLElement | null;
  return el && !(el instanceof G.HTMLTextAreaElement) ? EditorView.findFromDOM(el) : null;
}

/** The text an open Markdown cell draws, which is what someone typing into it sees. */
function cellShown(host: Element | null): string {
  return cellView(host)?.contentDOM.textContent ?? '';
}

function mount(doc: string, extra: Extension[] = []): Harness {
  const view = mkView(doc, extra);
  const q = (sel: string): HTMLElement | null => view.dom.querySelector(sel);
  const root = (): HTMLElement | null => q('.sheaf-table');
  const grid = (): HTMLElement | null => q('.sheaf-table-grid');
  const cell = (r: number, c: number): HTMLElement | null =>
    view.dom.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`);
  // The bar's buttons are icons, so a scenario names one by the registry command
  // it stands for. What it says to a person is its title, which `ctrlLabel` reads.
  const ctrl = (id: string): HTMLButtonElement | null =>
    view.dom.querySelector(`.sheaf-table-ctrl[data-cmd="${id}"]`) as HTMLButtonElement | null;
  const mousedown = (el: Element, opts: any = {}): void => {
    el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, ...opts }));
  };
  const dblclick = (el: Element): void => {
    el.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  };
  const keydown = (el: Element, key: string, opts: any = {}): void => {
    el.dispatchEvent(new G.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  };
  const input = (r: number, c: number): HTMLTextAreaElement | null => cellField(cell(r, c));
  const focusGrid = (): void => {
    const g = grid();
    if (g) {
      g.focus();
      g.dispatchEvent(new G.Event('focus', { bubbles: false }));
    }
  };
  const clipboard = (type: 'copy' | 'cut' | 'paste', text = ''): { text: string; html: string } => {
    const store: Record<string, string> = { 'text/plain': text };
    const cd = {
      getData: (t: string) => store[t] ?? '',
      setData: (t: string, v: string) => {
        store[t] = v;
      },
    };
    const e = new G.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: cd });
    document.dispatchEvent(e);
    return { text: store['text/plain'] ?? '', html: store['text/html'] ?? '' };
  };
  const commit = async (): Promise<string> => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.blur) ae.blur();
    root()?.dispatchEvent(new G.Event('focusout', { bubbles: true }));
    await tick();
    return view.state.doc.toString();
  };
  return {
    view,
    root,
    grid,
    cell,
    ctrl,
    mousedown,
    dblclick,
    keydown,
    input,
    focusGrid,
    clipboard,
    commit,
    doc: () => view.state.doc.toString(),
  };
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

/** A mouse release anywhere on the page, which is what ends a drag. */
const mouseup = (opts: any = {}): void => {
  document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, ...opts }));
};
/** The pointer moving over an element with the button still held. */
const mousemove = (el: Element, opts: any = {}): void => {
  el.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, ...opts }));
};
/** The cells a grid shows as selected, as "r,c", in reading order. */
const picked = (h: Harness): string =>
  Array.from(h.root()!.querySelectorAll('.is-sel'))
    .map((el) => `${(el as HTMLElement).dataset.r},${(el as HTMLElement).dataset.c}`)
    .sort()
    .join(' ');
/** The active cell, the one typing replaces. */
const activeCell = (h: Harness): string | null => {
  const el = h.root()!.querySelector('.is-focus') as HTMLElement | null;
  return el ? `${el.dataset.r},${el.dataset.c}` : null;
};
/** Drag-select the rectangle between two cells. */
const dragCells = (h: Harness, a: [number, number], b: [number, number]): void => {
  h.mousedown(h.cell(a[0], a[1])!);
  mousemove(h.cell(b[0], b[1])!);
  mouseup();
};
/** The row number beside body row `r`, which selects or moves that row. */
const gutter = (h: Harness, r: number): HTMLElement =>
  Array.from(h.root()!.querySelectorAll<HTMLElement>('tbody .sheaf-table-gutter'))[r];
/** Right-click `target`, choose Copy ref, and return what reached the clipboard. */
const copyRef = (h: Harness, target: Element): string => {
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  const copied: string[] = [];
  mountContextMenu(h.view.dom, {
    getView: () => h.view,
    getFileName: () => 'doc.md',
    copyToClipboard: (t) => copied.push(t),
  });
  h.mousedown(target, { button: 2 });
  target.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item'));
  items.find((b) => b.querySelector('span')?.textContent === 'Copy ref')?.click();
  document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
  return copied[0] ?? '';
};
/** A ref's fenced quote, as `copyRef` returns it wrapped. */
const quoted = (text: string): string => '\n\n```\n' + text + '\n```\n';


async function scenario(name: string, fn: () => Promise<boolean> | boolean): Promise<Result> {
  try {
    const ok = await fn();
    return { name, ok, detail: ok ? '' : 'assertion failed' };
  } catch (e) {
    return { name, ok: false, detail: 'threw: ' + (e as Error).message };
  }
}

const PIPE = P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';

// ---- Column widths, as far as a runner with no layout can drive them -------
//
// jsdom lays nothing out: every frame is zero pixels wide, so the real editor
// never measures a column here and the table is left as the stylesheet drew it.
// The first scenario below checks exactly that, because it is what a webview in
// a background tab does too. The rest hand the measuring pass a frame width and
// a size for each cell of the copy it draws, which drives the whole of the
// wiring — the two passes, the colgroup, the scrolling frame — on invented
// numbers. What a column of bold text, a code span, a picture or a line of
// Japanese actually needs is a question only a real window can answer.

/** The width the copy's ruler and gutter columns come back as. */
const FAKE_FLOOR = 48;
const FAKE_GUTTER = 30;

/**
 * Long enough for the measuring to run to the end. It takes three of the
 * editor's measure passes, and those are scheduled on animation frames, which
 * the runner serves on a real frame clock rather than on the microtask queue a
 * bare `tick()` drains.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
};

/** Give the frame a width and the copy's cells a size, for the length of `fn`. */
async function withLayout(
  grid: HTMLElement,
  pane: number,
  extent: (col: number) => { min: number; max: number },
  fn: () => Promise<void> | void
): Promise<void> {
  const proto = G.window.Element.prototype;
  const realRect = proto.getBoundingClientRect;
  const rect = (width: number): any => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20 });
  proto.getBoundingClientRect = function (this: Element) {
    const row = this.parentElement;
    if (row && row.parentElement?.tagName === 'THEAD' && this.closest('.sheaf-table-probe')) {
      const at = Array.prototype.indexOf.call(row.children, this);
      const narrow = (this.closest('table') as HTMLElement | null)?.style.width === 'min-content';
      if (at === 0) return rect(FAKE_FLOOR);
      if (at === 1) return rect(FAKE_GUTTER);
      const e = extent(at - 2);
      return rect(narrow ? e.min : e.max);
    }
    return realRect.call(this);
  };
  Object.defineProperty(grid, 'clientWidth', { value: pane, configurable: true });
  try {
    // The webview's tab coming back to the front is what asks a table that was
    // never laid out to measure itself.
    document.dispatchEvent(new G.Event('visibilitychange'));
    await settle();
    await fn();
  } finally {
    proto.getBoundingClientRect = realRect;
    delete (grid as any).clientWidth;
  }
}

/** A pointer event on `el` at `clientX`, the way a drag on a header border arrives. */
const pointer = (el: Element, type: string, clientX: number): void => {
  const Ctor = G.window.PointerEvent ?? G.MouseEvent;
  el.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1 })
  );
};

/** The pixel widths of a laid-out table's `<colgroup>`, or null when it has none. */
const colWidths = (root: HTMLElement | null): number[] | null => {
  const group = root?.querySelector('.sheaf-table-grid > table > colgroup');
  return group ? Array.from(group.children, (c) => parseFloat((c as HTMLElement).style.width)) : null;
};

export async function runAll(): Promise<Result[]> {
  const results: Result[] = [];

  // Column widths are decided by pure arithmetic over measured widths, checked
  // on numbers alone in its own file.
  for (const check of columnWidthChecks) results.push(await scenario(check.name, check.run));

  results.push(
    await scenario('a table whose frame has never been laid out is left exactly as the stylesheet drew it', async () => {
      // What a webview in a background tab sees. Laying the columns out from a
      // frame with no width would put every one of them at nothing.
      const h = mount(PIPE);
      await settle();
      const table = h.root()!.querySelector('.sheaf-table-grid > table') as HTMLElement;
      const left = !table.querySelector('colgroup') && table.style.tableLayout === '' && table.style.width === '';
      const noProbe = !h.root()!.querySelector('.sheaf-table-probe');
      h.view.destroy();
      return left && noProbe;
    })
  );

  results.push(
    await scenario('a measured table is laid out with one pixel width per column and a fixed layout', async () => {
      const h = mount(PIPE);
      let widths: number[] | null = null;
      let style: { layout: string; width: string } | null = null;
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), () => {
        widths = colWidths(h.root());
        const table = h.root()!.querySelector('.sheaf-table-grid > table') as HTMLElement;
        style = { layout: table.style.tableLayout, width: table.style.width };
      });
      h.view.destroy();
      if (!widths || !style) return false;
      const w = widths as number[];
      const s = style as { layout: string; width: string };
      // The gutter, then one width per column, adding up to the frame.
      return (
        w.length === 4 &&
        w[0] === FAKE_GUTTER &&
        w.slice(1).reduce((a, b) => a + b, 0) === 900 - FAKE_GUTTER &&
        s.layout === 'fixed' &&
        s.width === '900px'
      );
    })
  );

  results.push(
    await scenario('a column holding a word keeps its width while the column holding sentences gives', async () => {
      const h = mount(P + '| Code | Notes |\n| - | - |\n| A1 | x |\n| B2 | y |');
      let widths: number[] | null = null;
      // Code needs 60px and will never need more; Notes would take 2000px.
      await withLayout(h.grid()!, 900, (c) => (c === 0 ? { min: 40, max: 60 } : { min: 50, max: 2000 }), () => {
        widths = colWidths(h.root());
      });
      h.view.destroy();
      const w = widths as number[] | null;
      return !!w && w[1] === 60 && w[2] === 900 - FAKE_GUTTER - 60;
    })
  );

  results.push(
    await scenario('a table too wide for its frame keeps its columns, scrolls, and says so', async () => {
      const h = mount(P + '| Code | Notes |\n| - | - |\n| A1 | x |');
      interface Seen {
        scrolls: boolean;
        note: string;
        noteId: string;
        describedBy: string | null;
        widths: number[] | null;
      }
      let state: Seen | null = null;
      // Both columns hold one unbreakable word 900px wide, in a 300px frame.
      await withLayout(h.grid()!, 300, () => ({ min: 900, max: 2000 }), () => {
        const root = h.root()!;
        const note = root.querySelector('.sheaf-table-note');
        state = {
          scrolls: root.classList.contains('is-scroll-x'),
          note: note?.textContent ?? '',
          noteId: note?.id ?? '',
          describedBy: h.grid()!.getAttribute('aria-describedby'),
          widths: colWidths(root),
        };
      });
      h.view.destroy();
      const s = state as Seen | null;
      if (!s || !s.widths) return false;
      // Nothing is squeezed under its own longest word; the frame carries the rest.
      return (
        s.scrolls &&
        s.widths[1] === 900 &&
        s.widths[2] === 900 &&
        /scrolls sideways/i.test(s.note) &&
        !!s.describedBy &&
        s.describedBy === s.noteId
      );
    })
  );

  results.push(
    await scenario('a table that fits its frame is not announced as scrolling', async () => {
      const h = mount(PIPE);
      let quiet = false;
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), () => {
        quiet = !h.root()!.classList.contains('is-scroll-x') && !h.root()!.querySelector('.sheaf-table-note');
      });
      h.view.destroy();
      return quiet;
    })
  );

  results.push(
    await scenario('measuring a table’s columns changes not one byte of the document', async () => {
      const source = P + '| Code | Notes |\n|:--|--:|\n| A1 | a note |\n| B2 |  |';
      const h = mount(source);
      let laidOut = false;
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 400 }), () => {
        laidOut = !!colWidths(h.root());
      });
      const after = h.doc();
      h.view.destroy();
      return laidOut && after === source;
    })
  );

  results.push(
    await scenario('a table whose text has not changed is laid out again without being measured again', async () => {
      // Its own text, because the measurement is cached on exactly that and
      // would otherwise be answered by whatever an earlier scenario measured.
      const h = mount(P + '| Cached | Column |\n| - | - |\n| once | only |');
      const root = h.root()!;
      let probes = 0;
      const watch = new G.MutationObserver((records: any[]) => {
        for (const rec of records)
          for (const node of Array.from(rec.addedNodes) as Element[])
            if (node.classList?.contains('sheaf-table-probe')) probes++;
      });
      watch.observe(root, { childList: true });
      const extent = (): { min: number; max: number } => ({ min: 40, max: 120 });
      await withLayout(h.grid()!, 900, extent, () => {});
      const first = probes;
      // The tab comes to the front a second time. The measurement is cached on
      // the table's text, so the copy is not drawn again.
      await withLayout(h.grid()!, 900, extent, () => {});
      watch.disconnect();
      const laidOut = !!colWidths(root);
      h.view.destroy();
      return first === 1 && probes === 1 && laidOut;
    })
  );

  results.push(
    await scenario('a cell committed with much more in it than before has its column measured again', async () => {
      const h = mount(P + '| Grow | Still |\n| - | - |\n| a | b |');
      let before: number[] | null = null;
      let after: number[] | null = null;
      let grown = false;
      const extent = (c: number): { min: number; max: number } =>
        c === 0 ? { min: 40, max: grown ? 600 : 60 } : { min: 40, max: 80 };
      await withLayout(h.grid()!, 900, extent, async () => {
        before = colWidths(h.root());
        grown = true;
        h.dblclick(h.cell(0, 0)!);
        const field = h.input(0, 0)!;
        field.value = 'a much longer value than before';
        field.dispatchEvent(new G.InputEvent('input', { bubbles: true }));
        h.keydown(field, 'Enter');
        await settle();
        after = colWidths(h.root());
      });
      h.view.destroy();
      const a = before as number[] | null;
      const b = after as number[] | null;
      if (!a || !b) return false;
      // The column that grew took space from the one that did not.
      return b[1] > a[1] && b[2] < a[2];
    })
  );

  results.push(
    await scenario('the copy drawn to measure a table is taken away again and is never part of the grid', async () => {
      const h = mount(PIPE);
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), () => {});
      const root = h.root()!;
      const gone = !root.querySelector('.sheaf-table-probe');
      // Every cell the grid can reach is still one of its own.
      const cells = root.querySelectorAll('.sheaf-table-grid td, .sheaf-table-grid th').length;
      h.view.destroy();
      return gone && cells === 4 * 3;
    })
  );

  // ---- Column widths set by hand ----
  // Each of these uses headers no other scenario uses, because a width set by hand
  // is kept for the page's whole session under the table's header row.

  results.push(
    await scenario('dragging a header’s right border sets that column’s width and the rest share what is left', async () => {
      const h = mount(P + '| Drag A | Drag B | Drag C |\n| - | - | - |\n| 1 | 2 | 3 |');
      const before = h.doc();
      const sent: any[] = [];
      setTableWidthsHost((m) => sent.push(m));
      let laid: number[] | null = null;
      let dragged: number[] | null = null;
      let hasGrip = false;
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), async () => {
        laid = colWidths(h.root());
        const grip = h.cell(-1, 0)!.querySelector('.sheaf-table-resize');
        hasGrip = !!grip;
        if (!grip) return;
        pointer(grip, 'pointerdown', 290);
        pointer(grip, 'pointermove', 190);
        await settle();
        pointer(grip, 'pointerup', 190);
        await settle();
        dragged = colWidths(h.root());
      });
      setTableWidthsHost(null);
      const after = h.doc();
      h.view.destroy();
      const a = laid as number[] | null;
      const d = dragged as number[] | null;
      const write = sent.find((m) => m.type === 'tableWidthsWrite');
      const key = tableWidthKey(['Drag A', 'Drag B', 'Drag C']);
      return (
        hasGrip &&
        !!a &&
        !!d &&
        a[1] === 290 &&
        d[1] === 190 &&
        d[2] + d[3] === 900 - FAKE_GUTTER - 190 &&
        after === before &&
        sent.some((m) => m.type === 'tableWidthsRead') &&
        !!write &&
        write.widths[key]?.['0'] === 190
      );
    })
  );

  results.push(
    await scenario('a header border dragged past the narrowest a column may be stops there, and shows that it stopped', async () => {
      const h = mount(P + '| Floor A | Floor B |\n| - | - |\n| 1 | 2 |');
      let atFloor = false;
      let width = 0;
      let clearedAfter = false;
      await withLayout(h.grid()!, 600, () => ({ min: 40, max: 120 }), async () => {
        const grip = h.cell(-1, 0)!.querySelector('.sheaf-table-resize');
        if (!grip) return;
        const start = colWidths(h.root())![1];
        pointer(grip, 'pointerdown', start);
        pointer(grip, 'pointermove', start - 1000);
        await settle();
        atFloor = grip.classList.contains('is-at-floor');
        width = colWidths(h.root())![1];
        pointer(grip, 'pointerup', start - 1000);
        await settle();
        clearedAfter = !grip.classList.contains('is-at-floor');
        // Put the table back the way the other scenarios expect to find widths.
        h.ctrl('overflow')!.click();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.resetWidths"]') as HTMLElement | null)?.click();
      });
      h.view.destroy();
      return atFloor && width === FAKE_FLOOR && clearedAfter;
    })
  );

  results.push(
    await scenario('Fit columns to content pins every column to its content, and Reset column widths is offered only once a width is set', async () => {
      const h = mount(P + '| Fit A | Fit B | Fit C |\n| - | - | - |\n| 1 | 2 | 3 |');
      const state = (id: string): string | null => {
        const el = document.querySelector(`.sheaf-table-menu [data-cmd="${id}"]`);
        return el ? el.getAttribute('aria-disabled') ?? 'false' : null;
      };
      const labels = (): string[] => (tableActionsAt(h.cell(0, 0)) ?? []).map((a) => a.label);
      let seen: Record<string, unknown> = {};
      await withLayout(h.grid()!, 900, (c) => ({ min: 40, max: 100 + c * 20 }), async () => {
        const computed = colWidths(h.root());
        h.ctrl('overflow')!.click();
        const fitBefore = state('table.fitColumns');
        const resetBefore = state('table.resetWidths');
        const rightClickBefore = labels();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.fitColumns"]') as HTMLElement).click();
        await settle();
        const fitted = colWidths(h.root());
        const scrolls = h.root()!.classList.contains('is-scroll-x');
        h.ctrl('overflow')!.click();
        const resetAfter = state('table.resetWidths');
        const rightClickAfter = labels();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.resetWidths"]') as HTMLElement).click();
        await settle();
        const reset = colWidths(h.root());
        h.ctrl('overflow')!.click();
        const resetGone = state('table.resetWidths');
        document.querySelectorAll('.sheaf-table-menu').forEach((m) => m.remove());
        seen = { computed, fitBefore, resetBefore, rightClickBefore, fitted, scrolls, resetAfter, rightClickAfter, reset, resetGone };
      });
      const doc = h.doc();
      h.view.destroy();
      const s = seen as any;
      return (
        s.fitBefore === 'false' &&
        s.resetBefore === 'true' &&
        s.rightClickBefore.includes('Fit columns to content') &&
        !s.rightClickBefore.includes('Reset column widths') &&
        JSON.stringify(s.fitted) === JSON.stringify([FAKE_GUTTER, 100, 120, 140]) &&
        !s.scrolls &&
        s.resetAfter === 'false' &&
        s.rightClickAfter.includes('Reset column widths') &&
        JSON.stringify(s.reset) === JSON.stringify(s.computed) &&
        s.resetGone === 'true' &&
        doc === P + '| Fit A | Fit B | Fit C |\n| - | - | - |\n| 1 | 2 | 3 |'
      );
    })
  );

  results.push(
    await scenario('Fit columns to content lets a table wider than the pane scroll', async () => {
      const h = mount(P + '| Fit wide A | Fit wide B |\n| - | - |\n| 1 | 2 |');
      let fitted: number[] | null = null;
      let scrolls = false;
      await withLayout(h.grid()!, 500, () => ({ min: 40, max: 400 }), async () => {
        h.ctrl('overflow')!.click();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.fitColumns"]') as HTMLElement).click();
        await settle();
        fitted = colWidths(h.root());
        scrolls = h.root()!.classList.contains('is-scroll-x');
        h.ctrl('overflow')!.click();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.resetWidths"]') as HTMLElement).click();
      });
      h.view.destroy();
      return JSON.stringify(fitted) === JSON.stringify([FAKE_GUTTER, 400, 400]) && scrolls;
    })
  );

  results.push(
    await scenario('a width stored for a table is used when its header row matches, and ignored when it does not', async () => {
      handleTableWidths('widths-1', {
        [tableWidthKey(['Kept', 'Width'])]: { '1': 200 },
        // Stored values the page did not write are read with suspicion, not trusted.
        [tableWidthKey(['Bad', 'Value'])]: { '0': 'wide' as unknown as number, '1': -5 },
      });
      const widthsOf = async (source: string): Promise<number[] | null> => {
        const h = mount(P + source);
        let w: number[] | null = null;
        await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), () => {
          w = colWidths(h.root());
        });
        h.view.destroy();
        return w;
      };
      const kept = await widthsOf('| Kept | Width |\n| - | - |\n| a | b |');
      const renamed = await widthsOf('| Kept | Renamed |\n| - | - |\n| a | b |');
      const wider = await widthsOf('| Kept | Width | More |\n| - | - | - |\n| a | b | c |');
      const bad = await widthsOf('| Bad | Value |\n| - | - |\n| a | b |');
      handleTableWidths('widths-2', { [tableWidthKey(['Kept', 'Width'])]: null });
      const computed = (900 - FAKE_GUTTER) / 2;
      return (
        !!kept &&
        kept[2] === 200 &&
        kept[1] === 900 - FAKE_GUTTER - 200 &&
        !!renamed &&
        renamed[1] === computed &&
        renamed[2] === computed &&
        !!wider &&
        !wider.includes(200) &&
        !!bad &&
        bad[1] === computed &&
        bad[2] === computed
      );
    })
  );

  results.push(
    await scenario('a column whose header is renamed in the grid keeps the width it was given', async () => {
      const h = mount(P + '| Named | Other |\n| - | - |\n| a | b |');
      let after: number[] | null = null;
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), async () => {
        const grip = h.cell(-1, 0)!.querySelector('.sheaf-table-resize');
        if (!grip) return;
        pointer(grip, 'pointerdown', 435);
        pointer(grip, 'pointermove', 235);
        pointer(grip, 'pointerup', 235);
        await settle();
        h.dblclick(h.cell(-1, 0)!);
        const field = h.input(-1, 0)!;
        field.value = 'Renamed';
        field.dispatchEvent(new G.InputEvent('input', { bubbles: true }));
        h.keydown(field, 'Enter');
        await settle();
        after = colWidths(h.root());
        h.ctrl('overflow')!.click();
        (document.querySelector('.sheaf-table-menu [data-cmd="table.resetWidths"]') as HTMLElement | null)?.click();
      });
      h.view.destroy();
      const a = after as number[] | null;
      return !!a && a[1] === 235;
    })
  );

  // ---- Tall cells, the height estimate, and the header while scrolling ----

  /**
   * Give every cell's text a height for the length of `fn`: `tall` for text longer
   * than 80 characters and one line otherwise, the way a narrow column wraps it.
   * jsdom lays nothing out, so every height is otherwise zero.
   */
  const withTextHeights = async (fn: () => Promise<void> | void): Promise<void> => {
    const proto = G.window.HTMLElement.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList?.contains('sheaf-table-text')) return real?.get?.call(this) ?? 0;
        return (this.textContent ?? '').length > 80 ? 200 : 24;
      },
    });
    try {
      await fn();
    } finally {
      if (real) Object.defineProperty(proto, 'scrollHeight', real);
      else delete (proto as any).scrollHeight;
    }
  };
  const LONG_NOTE =
    'A note long enough to run past four lines in a narrow column, so the row it sits in would stand far taller than its neighbours if it were drawn whole.';

  results.push(
    // The short cell is the control: with the clamp's threshold dropped under one line, so that
    // every cell reads as tall, this fails on the short cell being clamped.
    await scenario('a cell taller than four lines is clamped on an element inside it, with its whole text as a tooltip', async () => {
      let seen: Record<string, unknown> = {};
      await withTextHeights(async () => {
        const h = mount(P + `| Code | Note |\n| - | - |\n| A1 | ${LONG_NOTE} |\n| B2 | short |`);
        await settle();
        const long = h.cell(0, 1)!;
        const short = h.cell(1, 1)!;
        seen = {
          clamped: long.classList.contains('is-clamped'),
          inner: !!long.querySelector(':scope > .sheaf-table-text'),
          cellItself: long.classList.contains('sheaf-table-text'),
          title: long.title,
          shortClamped: short.classList.contains('is-clamped'),
          shortTitle: short.title,
          text: long.textContent,
          doc: h.doc(),
        };
        h.view.destroy();
      });
      const s = seen as any;
      return (
        s.clamped &&
        s.inner &&
        !s.cellItself &&
        s.title === LONG_NOTE &&
        s.text === LONG_NOTE &&
        !s.shortClamped &&
        s.shortTitle === '' &&
        s.doc === P + `| Code | Note |\n| - | - |\n| A1 | ${LONG_NOTE} |\n| B2 | short |`
      );
    })
  );

  results.push(
    await scenario('a clamped cell is drawn whole while it is the active cell and while it is open, and clamped again after', async () => {
      let seen: Record<string, unknown> = {};
      await withTextHeights(async () => {
        const h = mount(P + `| Code | Note |\n| - | - |\n| A1 | ${LONG_NOTE} |\n| B2 | short |`);
        await settle();
        const long = (): HTMLElement => h.cell(0, 1)!;
        const before = long().classList.contains('is-clamped');
        h.mousedown(long());
        mouseup();
        const active = long().classList.contains('is-clamped') || long().title !== '';
        h.dblclick(long());
        const open = long().classList.contains('is-clamped') || long().title !== '';
        const editing = long().classList.contains('is-editing');
        h.keydown(h.input(0, 1)!, 'Escape');
        h.mousedown(h.cell(1, 0)!);
        mouseup();
        await settle();
        const after = long().classList.contains('is-clamped') && long().title === LONG_NOTE;
        seen = { before, active, open, editing, after };
        h.view.destroy();
      });
      const s = seen as any;
      return s.before && !s.active && s.editing && !s.open && s.after;
    })
  );

  results.push(
    await scenario('a column of numbers is marked to draw its digits at one width, and stops being one when a word is typed into it', async () => {
      const h = mount(P + '| Name | Count | Cost |\n| - | -: | -: |\n| a | 1,204 | $3.50 |\n| b | 17 | $12.00 |');
      const marked = (c: number): boolean[] => [0, 1].map((r) => h.cell(r, c)!.classList.contains('is-numeric'));
      const text = marked(0);
      const count = marked(1);
      const cost = marked(2);
      h.dblclick(h.cell(1, 1)!);
      const field = h.input(1, 1)!;
      field.value = 'several';
      field.dispatchEvent(new G.InputEvent('input', { bubbles: true }));
      h.keydown(field, 'Enter');
      const countAfter = marked(1);
      const costAfter = marked(2);
      h.view.destroy();
      return (
        text.every((x) => !x) &&
        count.every(Boolean) &&
        cost.every(Boolean) &&
        countAfter.every((x) => !x) &&
        costAfter.every(Boolean)
      );
    })
  );

  results.push(
    await scenario('the height a table is estimated at before it is drawn allows for rows that wrap', () => {
      // Three rows whose notes wrap past the four lines a cell is drawn at, in columns
      // 80, 80 and 300 pixels wide. As drawn in Chromium: a line is 22.08px, a row adds
      // 12px of padding (its rule is shared with the next row), the bar above the grid
      // takes 29px and the frame 16px.
      const headers = ['Code', 'State', 'Note'];
      const rows = [0, 1, 2].map((i) => [`A${i}`, 'open', LONG_NOTE + ' ' + LONG_NOTE]);
      const real = 29 + 16 + (22.08 + 12) + 3 * (4 * 22.08 + 12);
      const old = (rows.length + 1) * 33 + 34;
      const est = estimateTableHeight(headers, rows, [80, 80, 300]);
      // One-line rows still come out at about one line each.
      const flat = estimateTableHeight(headers, [['a', 'b', 'c']], [80, 80, 300]);
      const flatReal = 29 + 16 + 2 * (22.08 + 12);
      return Math.abs(est - real) < Math.abs(old - real) && Math.abs(est - real) <= real * 0.1 && Math.abs(flat - flatReal) <= 4;
    })
  );

  results.push(
    await scenario('a table never drawn is estimated at the widths the layout would give its columns in the text column, not an even share', () => {
      // After a reload nothing has been drawn, so the estimate divides the text column
      // itself. The table below, worked by hand from the stylesheet's measures:
      //
      //   average character 7.4px, a cell's padding 24px, a digit 8.1px;
      //   row numbers: 17px around one digit at 0.8 of 8.1px = 23.48px;
      //   floor 6 digits + padding = 72.6px, ceiling 0.45 of the pane.
      //
      // Code is 4 characters wide (53.6px), State 5 (61px), and Note's widest line is
      // 126 characters (956.4px) with a longest word of 9. In a 708px pane that leaves
      // 684.52px, which the allocator divides by its second rule: Code and State whole,
      // Note held to the 318.6px ceiling and then given back the 251.32px left over,
      // so 54, 61 and 570 once rounded. Note's text then has 546px a line, 73 characters:
      // the long note is 2 lines and the medium one 1.
      //
      // Drawn, each row is its lines at 22.08px plus 13px, with a 1px edge, under a 29px
      // bar and inside a 16px frame: 29 + 16 + 1 + 35.08 (header) + 57.16 + 35.08 + 35.08
      // = 208.4, so 208.
      //
      // An even share would give Note 228px, 27 characters a line: the long note
      // clamped at 4 lines and the medium one at 3, 297px, about 89px too tall.
      const long = 'The shipment waits on customs paperwork the broker has not filed yet, so the pallet sits at the port until every form arrives.';
      const medium = 'Supplier confirmed the new date by phone on Tuesday morning.';
      const headers = ['Code', 'State', 'Note'];
      const rows = [
        ['A1', 'open', long],
        ['B2', 'late', medium],
        ['C3', 'done', 'On time.'],
      ];
      const alloc = allocateColumnWidths(708 - 23.48, [
        { min: 53.6, max: 53.6 },
        { min: 61, max: 61 },
        { min: 9 * 7.4 + 24, max: 126 * 7.4 + 24 },
      ], { floor: COLUMN_FLOOR_CH * 8.1 + 24, cap: COLUMN_CAP_FRACTION * 708 });
      const allocated = alloc?.rule === 2 && alloc.widths.join() === '54,61,570';
      const est = estimateTableHeight(headers, rows, null, { pane: 708 });
      const even = estimateTableHeight(headers, rows, [228.17, 228.17, 228.17]);
      // In a 400px pane the ceiling is 180px and Note gets 262px, 32 characters a line:
      // the long note is 4 lines and the medium one 2, 29 + 16 + 1 + 35.08 + 101.32 + 57.16
      // + 35.08 = 274.64, so 275. The pane the window gives is the one divided.
      const narrow = estimateTableHeight(headers, rows, null, { pane: 400 });
      // Widths a drawn table was laid out at still win over any division.
      const laid = estimateTableHeight(headers, rows, [54, 61, 570], { pane: 400 });
      return allocated && long.length === 126 && est === 208 && even === 297 && narrow === 275 && laid === 208;
    })
  );

  results.push(
    await scenario('the estimate for an undrawn table matches the height a real window draws it at', () => {
      // Measured in VS Code at a 708px text column: the header and three one-line rows at
      // 35.08px, a two-line row at 57.16px and a three-line row at 79.23px, so each row is its
      // lines at 22.08px plus 13px; the table adds a 1px edge, and the bar and frame 45px.
      // 5 * 13 + 8 * 22.08 + 1 + 45 = 287.64. Drawn: 287.63.
      const headers = ['Ref', 'Status', 'Detail'];
      const rows = [
        ['R1', 'open', 'The shipment waits on customs paperwork the broker has not filed yet, so the pallet sits at the port until every form arrives.'],
        ['R2', 'late', 'Supplier confirmed the new date by phone on Tuesday morning.'],
        ['R3', 'done', 'On time.'],
        ['R4', 'open', 'Two of the four crates were opened at inspection and repacked by the carrier, who has asked for the original packing list and the invoice before releasing them to the warehouse.'],
      ];
      const est = estimateTableHeight(headers, rows, null, { pane: 708 });
      const atDrawn = estimateTableHeight(headers, rows, [49, 71, 563]);
      // Ref is sized to its own three letters and rounded to 46px; the estimate must not
      // wrap that header onto a second line the window never draws.
      const divided = estimateColumnWidths(headers, rows, 708, null);
      return Math.abs(est - 287.63) <= 2 && Math.abs(atDrawn - 287.63) <= 2 && divided[0] < 47;
    })
  );

  results.push(
    await scenario('a table whose height changes after it is drawn asks the editor to measure it again', async () => {
      const Real = G.ResizeObserver;
      const watching: { cb: () => void; el: Element }[] = [];
      G.ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe(el: Element): void {
          watching.push({ cb: this.cb, el });
        }
        unobserve(): void {}
        disconnect(): void {}
      };
      let asked = 0;
      let heightAsked = false;
      try {
        const h = mount(P + '| Grows | Here |\n| - | - |\n| a | b |');
        const wrap = h.root()!;
        const onWrap = watching.filter((w) => w.el === wrap);
        const real = h.view.requestMeasure.bind(h.view);
        h.view.requestMeasure = ((req?: any) => {
          if (!req) asked++;
          real(req);
        }) as typeof h.view.requestMeasure;
        Object.defineProperty(wrap, 'offsetHeight', { configurable: true, get: () => 400 });
        onWrap.forEach((w) => w.cb());
        heightAsked = onWrap.length > 0 && asked > 0;
        // The same height again is nothing new, and asks for nothing.
        const once = asked;
        onWrap.forEach((w) => w.cb());
        heightAsked = heightAsked && asked === once;
        h.view.destroy();
      } finally {
        G.ResizeObserver = Real;
      }
      return heightAsked;
    })
  );

  results.push(
    await scenario('a table wider than its frame lifts its header row to the top of the editor as the page scrolls past it', async () => {
      const h = mount(P + '| Lift A | Lift B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      let seen: Record<string, unknown> = {};
      await withLayout(h.grid()!, 300, () => ({ min: 400, max: 400 }), async () => {
        const table = h.root()!.querySelector('.sheaf-table-grid > table') as HTMLElement;
        const head = table.querySelector('thead tr') as HTMLElement;
        const frame = h.view.scrollDOM;
        const box = (top: number, height: number): DOMRect =>
          ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} }) as DOMRect;
        frame.getBoundingClientRect = () => box(0, 600);
        Object.defineProperty(head, 'offsetHeight', { configurable: true, get: () => 34 });
        let tableTop = 100;
        table.getBoundingClientRect = () => box(tableTop, 1000);
        const scrollTo = (top: number): string => {
          tableTop = top;
          frame.dispatchEvent(new G.Event('scroll'));
          return head.style.transform;
        };
        seen = {
          scrolls: h.root()!.classList.contains('is-scroll-x'),
          below: scrollTo(100),
          past: scrollTo(-300),
          stuck: head.classList.contains('is-stuck'),
          end: scrollTo(-990),
          back: scrollTo(50),
          unstuck: !head.classList.contains('is-stuck'),
        };
      });
      h.view.destroy();
      const s = seen as any;
      return (
        s.scrolls &&
        s.below === '' &&
        s.past === 'translateY(300px)' &&
        s.stuck &&
        // It never leaves the table: at the end it sits on the last row.
        s.end === 'translateY(966px)' &&
        s.back === '' &&
        s.unstuck
      );
    })
  );

  results.push(
    await scenario('a table that fits its frame leaves its header to the stylesheet, and its frame stops being a scroller', async () => {
      const h = mount(P + '| Fits A | Fits B |\n| - | - |\n| 1 | 2 |');
      let seen: Record<string, unknown> = {};
      await withLayout(h.grid()!, 900, () => ({ min: 40, max: 120 }), async () => {
        const table = h.root()!.querySelector('.sheaf-table-grid > table') as HTMLElement;
        const head = table.querySelector('thead tr') as HTMLElement;
        const frame = h.view.scrollDOM;
        frame.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
        table.getBoundingClientRect = () => ({ top: -300, bottom: 700, left: 0, right: 800, width: 800, height: 1000, x: 0, y: -300, toJSON() {} }) as DOMRect;
        frame.dispatchEvent(new G.Event('scroll'));
        seen = {
          laid: h.root()!.classList.contains('has-widths'),
          scrolls: h.root()!.classList.contains('is-scroll-x'),
          transform: head.style.transform,
        };
      });
      h.view.destroy();
      const s = seen as any;
      return s.laid && !s.scrolls && s.transform === '';
    })
  );

  results.push(
    await scenario('renders grid', () => {
      const h = mount(PIPE);
      const ok = !!h.root() && !!h.cell(-1, 0) && !!h.cell(1, 2);
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('edit cell', async () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'X9';
      h.keydown(inp, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return /\|\s*X9\s*\|/.test(doc);
    })
  );

  results.push(
    await scenario('an open cell wraps its value instead of laying a one-line field over it', async () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      const cell = h.cell(0, 0)!;
      const field = h.input(0, 0);
      const sizer = cell.querySelector('.sheaf-table-sizer') as HTMLElement | null;
      // An editor that can wrap, and beside it a box holding the same text and
      // nothing more: that box is what the table measures, so the row keeps its
      // height and the column keeps the width its text already asked for.
      const shaped = !!field && !cell.querySelector('input') && cell.classList.contains('is-editing');
      const measured = sizer?.textContent === '1';
      // A value with no line to sit on still gets one, from a character with no width.
      field!.value = '';
      const emptyLine = sizer?.textContent === '\u200b';
      field!.value = 'a note long enough to wrap';
      const grew = sizer?.textContent === 'a note long enough to wrap';
      h.keydown(field!, 'Enter');
      const closed = !cell.querySelector('.sheaf-table-input') && !cell.classList.contains('is-editing');
      const doc = await h.commit();
      h.view.destroy();
      return shaped && measured && emptyLine && grew && closed && /\|\s*a note long enough to wrap\s*\|/.test(doc);
    })
  );

  // A double-click inside a cell that is already open picks a word, as it does in
  // any text field. The browser picks the word on the second press; the dblclick
  // that follows must not reach the grid, which would open the cell again with its
  // whole value selected. A closed cell still opens on a double-click.
  results.push(
    await scenario('a double-click on a word inside an open cell leaves the word selected and the cell open', async () => {
      const h = mount(P + '| Role | Qty |\n| - | - |\n| Systems technician | 3 |');
      h.dblclick(h.cell(0, 0)!);
      const cm = cellView(h.cell(0, 0));
      if (!cm) return false;
      const host = h.cell(0, 0)!.querySelector('.sheaf-table-input');
      // The word the browser picks on the second press of a double-click.
      cm.dispatch({ selection: { anchor: 8, head: 18 } });
      h.dblclick(cm.contentDOM);
      const same = h.cell(0, 0)!.querySelector('.sheaf-table-input') === host && cellView(h.cell(0, 0)) === cm;
      const s = cm.state.selection.main;
      const word = cm.state.sliceDoc(s.from, s.to);
      const open = h.cell(0, 0)!.classList.contains('is-editing');
      const doc = await h.commit();
      h.view.destroy();
      return same && open && word === 'technician' && doc === P + '| Role | Qty |\n| - | - |\n| Systems technician | 3 |';
    })
  );

  results.push(
    await scenario('a double-click on a word inside an open CSV field leaves the word selected and the field open', async () => {
      const h = mount(P + '```csv\nrole,qty\nSystems technician,3\n```');
      h.dblclick(h.cell(0, 0)!);
      const field = h.input(0, 0);
      if (!(field instanceof G.HTMLTextAreaElement)) return false;
      field.setSelectionRange(8, 18);
      h.dblclick(field);
      const same = h.input(0, 0) === field;
      const word = field.value.slice(field.selectionStart, field.selectionEnd);
      const open = h.cell(0, 0)!.classList.contains('is-editing');
      const doc = await h.commit();
      h.view.destroy();
      return same && open && word === 'technician' && doc === P + '```csv\nrole,qty\nSystems technician,3\n```';
    })
  );

  // ---- a pipe-table cell edits as rendered Markdown ----
  //
  // The table below is padded wider than its cells need on purpose: every one of
  // these scenarios also says that editing one cell rewrites that cell's line and
  // leaves every other byte of the table where it was.

  const MARKUP =
    P +
    '| Item          | Note                                       |\n' +
    '| ------------- | ------------------------------------------ |\n' +
    '| hot chocolate | **bold** and [a link](https://example.com)  |\n' +
    '| tea           | plain                                      |';

  /** The first line of the document's table, as a document index. */
  const tableLine = P.split('\n').length - 1;
  /** Every line of `doc` except the one holding body row `r`, for a byte comparison. */
  const linesBesides = (doc: string, r: number): string =>
    doc
      .split('\n')
      .filter((_l, i) => i !== tableLine + 2 + r)
      .join('\n');

  results.push(
    await scenario('a cell opened for editing draws its Markdown instead of showing it', () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(0, 1)!);
      // What the editor holds is still the cell's own Markdown; what it draws is
      // what a closed cell draws, with no marker left anywhere in it.
      const held = h.input(0, 1)!.value;
      const drawn = cellShown(h.cell(0, 1));
      h.view.destroy();
      return held === '**bold** and [a link](https://example.com)' && drawn === 'bold and a link';
    })
  );

  results.push(
    await scenario('a block marker at the start of a cell is the character itself, not a block', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| # one | - two |\n| > three | 1. four |');
      const drawn = (r: number, c: number): string => {
        h.dblclick(h.cell(r, c)!);
        const text = cellShown(h.cell(r, c));
        h.keydown(h.input(r, c)!, 'Escape');
        return text;
      };
      const shown = [drawn(0, 0), drawn(0, 1), drawn(1, 0), drawn(1, 1)].join('|');
      h.view.destroy();
      return shown === '# one|- two|> three|1. four';
    })
  );

  results.push(
    await scenario('Cmd+B in a cell bolds the selected word and changes nothing else', async () => {
      const h = mount(MARKUP);
      const before = h.doc();
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      cellView(h.cell(0, 0))!.dispatch({ selection: { anchor: 0, head: 3 } });
      h.keydown(input, 'b', { ctrlKey: true });
      const held = input.value;
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      const line = doc.split('\n')[tableLine + 2];
      return (
        held === '**hot** chocolate' &&
        line === '| **hot** chocolate | **bold** and [a link](https://example.com)  |' &&
        linesBesides(doc, 0) === linesBesides(before, 0)
      );
    })
  );

  results.push(
    await scenario('Cmd+K in a cell writes the link into that cell and nowhere else', async () => {
      const h = mount(MARKUP);
      const before = h.doc();
      h.dblclick(h.cell(1, 1)!);
      const input = h.input(1, 1)!;
      cellView(h.cell(1, 1))!.dispatch({ selection: { anchor: 0, head: 5 } });
      h.keydown(input, 'k', { ctrlKey: true });
      const held = input.value;
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        held === '[plain](url)' &&
        doc.includes('| [plain](url)') &&
        linesBesides(doc, 1) === linesBesides(before, 1)
      );
    })
  );

  // ---- the selection toolbar inside an open cell ----

  /** The selection toolbar anywhere in the editor, the open cell's included. */
  const cellToolbar = (h: Harness): HTMLElement | null => h.view.dom.querySelector('.sheaf-seltb');
  /** The commands the toolbar offers, in order. */
  const toolbarCmds = (bar: HTMLElement | null): string =>
    bar ? [...bar.querySelectorAll<HTMLElement>('[data-cmd]')].map((b) => b.dataset.cmd).join(',') : '';
  /** Select `from`..`to` in the open cell at (r, c) the way a press and drag does. */
  const pointerSelect = (h: Harness, r: number, c: number, from: number, to: number): void => {
    cellView(h.cell(r, c))!.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select.pointer' });
  };

  results.push(
    await scenario('a cell opening shows no selection toolbar by itself', () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(0, 0)!);
      const open = !!h.input(0, 0);
      const whole = cellView(h.cell(0, 0))!.state.selection.main;
      const bar = cellToolbar(h);
      h.view.destroy();
      // The whole value is selected, ready to be typed over, and nothing floats over it.
      return open && whole.from === 0 && whole.to === 'hot chocolate'.length && bar === null;
    })
  );

  results.push(
    await scenario('selecting a word in an open cell brings up the toolbar with the marks and nothing a cell cannot use', () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(0, 0)!);
      pointerSelect(h, 0, 0, 0, 3);
      const cmds = toolbarCmds(cellToolbar(h));
      h.view.destroy();
      return cmds === 'bold,italic,strike,highlight,code,link,clear';
    })
  );

  results.push(
    await scenario('Cmd+A in an open cell brings up the toolbar over the whole value', () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      const before = cellToolbar(h);
      h.keydown(input, 'a', { ctrlKey: true });
      const sel = cellView(h.cell(0, 0))!.state.selection.main;
      const cmds = toolbarCmds(cellToolbar(h));
      const doc = h.doc();
      h.view.destroy();
      return (
        before === null &&
        sel.from === 0 &&
        sel.to === 'hot chocolate'.length &&
        cmds === 'bold,italic,strike,highlight,code,link,clear' &&
        doc === MARKUP
      );
    })
  );

  results.push(
    await scenario('Bold on the toolbar in a cell marks the selected word in that cell and changes no other line', async () => {
      const h = mount(MARKUP);
      const before = h.doc();
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      pointerSelect(h, 0, 0, 4, 13);
      const bold = cellToolbar(h)?.querySelector<HTMLButtonElement>('[data-cmd="bold"]');
      bold?.click();
      const held = input.value;
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      const line = doc.split('\n')[tableLine + 2];
      return (
        !!bold &&
        held === 'hot **chocolate**' &&
        line === '| hot **chocolate** | **bold** and [a link](https://example.com)  |' &&
        linesBesides(doc, 0) === linesBesides(before, 0)
      );
    })
  );

  results.push(
    await scenario('Escape closes the toolbar in a cell and leaves the cell open; a second Escape closes the cell', async () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      input.value = 'hot cocoa';
      pointerSelect(h, 0, 0, 4, 9);
      const shown = !!cellToolbar(h);
      h.keydown(input, 'Escape');
      const barAfter = cellToolbar(h);
      const stillOpen = h.input(0, 0) === input && input.value === 'hot cocoa';
      h.keydown(input, 'Escape');
      const closed = !h.cell(0, 0)!.querySelector('.sheaf-table-input');
      const doc = await h.commit();
      h.view.destroy();
      return shown && barAfter === null && stillOpen && closed && doc === MARKUP;
    })
  );

  /** Paste `text` into the open Markdown cell at (r, c), as the platform delivers it: to the cell's own content. */
  const pasteInCell = (host: Element | null, text: string): void => {
    const cm = cellView(host)!;
    const e = new G.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
    cm.contentDOM.dispatchEvent(e);
  };

  results.push(
    await scenario('an address pasted over words in a cell links them in that cell, by the paragraph’s rules', async () => {
      const h = mount(MARKUP);
      const before = h.doc();
      h.dblclick(h.cell(1, 1)!);
      const input = h.input(1, 1)!;
      cellView(h.cell(1, 1))!.dispatch({ selection: { anchor: 0, head: 5 } });
      pasteInCell(h.cell(1, 1), 'https://example.com/notes');
      const held = input.value;
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        held === '[plain](https://example.com/notes)' &&
        doc.includes('| [plain](https://example.com/notes)') &&
        linesBesides(doc, 1) === linesBesides(before, 1)
      );
    })
  );

  results.push(
    await scenario('a bare domain pasted over words in a cell pastes plainly, as it does in a paragraph', async () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(1, 1)!);
      const input = h.input(1, 1)!;
      cellView(h.cell(1, 1))!.dispatch({ selection: { anchor: 0, head: 5 } });
      pasteInCell(h.cell(1, 1), 'www.example.com');
      const held = input.value;
      h.view.destroy();
      // No scheme is invented and no link is made: the words are replaced, as a plain paste does.
      return held === 'www.example.com';
    })
  );

  results.push(
    await scenario('a pipe typed into a cell is written escaped and adds no column', async () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(1, 1)!);
      const input = h.input(1, 1)!;
      input.value = 'a | b';
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      const rows = doc.split('\n').filter((l) => l.startsWith('|'));
      const cells = (line: string): number => line.split(/(?<!\\)\|/).length;
      return doc.includes('| a \\| b') && rows.every((l) => cells(l) === cells(rows[0]));
    })
  );

  results.push(
    await scenario('a line break arriving in a pipe-table cell becomes a space', async () => {
      const h = mount(MARKUP);
      h.dblclick(h.cell(1, 1)!);
      const input = h.input(1, 1)!;
      input.value = 'one\ntwo';
      const flattened = input.value === 'one two';
      h.keydown(input, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return flattened && doc.includes('| one two');
    })
  );

  results.push(
    await scenario('copy inside an open cell is the cell’s own, not the grid’s block of cells', () => {
      const h = mount(MARKUP);
      h.mousedown(h.cell(0, 0)!);
      // With the grid holding the keyboard, a copy is the picked cells.
      const asGrid = h.clipboard('copy').text;
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.focus();
      // With a cell open, the grid takes no part and the editor keeps the event.
      const asCell = h.clipboard('copy', 'untouched').text;
      h.view.destroy();
      return asGrid === 'hot chocolate' && asCell === 'untouched';
    })
  );

  results.push(
    await scenario('a csv field still edits as plain text', () => {
      const h = mount(P + '```csv\nname,notes\napple,**red**\n```');
      h.dblclick(h.cell(0, 1)!);
      const field = h.cell(0, 1)!.querySelector('textarea') as HTMLTextAreaElement | null;
      const rich = cellView(h.cell(0, 1));
      h.view.destroy();
      // Data is not Markdown: the field holds what the file holds, asterisks and all.
      return !!field && field.value === '**red**' && rich === null;
    })
  );

  results.push(
    await scenario('Alt+Enter commits a pipe table cell, which cannot hold a line break', async () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      const field = h.input(0, 0)!;
      field.value = 'done';
      h.keydown(field, 'Enter', { altKey: true });
      const closed = !h.root()!.querySelector('.sheaf-table-input');
      const moved = activeCell(h) === '1,0';
      const doc = await h.commit();
      h.view.destroy();
      return closed && moved && /\|\s*done\s*\|/.test(doc);
    })
  );

  results.push(
    await scenario('tab appends row', async () => {
      const h = mount(PIPE);
      // Edit the last body cell then Tab past the end → new row appended.
      h.dblclick(h.cell(1, 2)!);
      const inp = h.input(1, 2)!;
      inp.value = 'last';
      h.keydown(inp, 'Tab');
      const shown = h.root()!.querySelectorAll('tbody tr').length;
      h.keydown(h.grid()!, 'q'); // typing into the appended row keeps it
      const doc = await h.commit();
      h.view.destroy();
      // Original had 2 body rows; the appended one now holds "q", so 3 are written.
      const bodyRows = doc.split('\n').filter((l) => /^\|/.test(l)).length - 2; // minus header+delim
      return shown === 3 && bodyRows === 3 && /\|\s*q\s*\|/.test(doc);
    })
  );

  results.push(
    await scenario('+ Row control', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!); // select a cell so focus.r is defined
      h.ctrl('row.insertBelow')!.click();
      const doc = await h.commit();
      h.view.destroy();
      const bodyRows = doc.split('\n').filter((l) => /^\|/.test(l)).length - 2;
      return bodyRows === 3;
    })
  );

  results.push(
    await scenario('+ Col control', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(-1, 0)!);
      h.ctrl('col.insertRight')!.click();
      const doc = await h.commit();
      h.view.destroy();
      // Header row should now have 4 cells (5 pipes).
      const headerLine = doc.split('\n').find((l) => l.includes('A'))!;
      return (headerLine.match(/\|/g) || []).length === 5;
    })
  );

  results.push(
    await scenario('− Row control', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.delete')!.click();
      const doc = await h.commit();
      h.view.destroy();
      const bodyRows = doc.split('\n').filter((l) => /^\|/.test(l)).length - 2;
      return bodyRows === 1;
    })
  );

  results.push(
    await scenario('− Col control', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(-1, 2)!);
      h.ctrl('col.delete')!.click();
      const doc = await h.commit();
      h.view.destroy();
      const headerLine = doc.split('\n').find((l) => l.includes('A'))!;
      return (headerLine.match(/\|/g) || []).length === 3; // 2 cols
    })
  );

  results.push(
    await scenario('copy range as TSV', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 1)!, { shiftKey: true });
      h.focusGrid();
      const { text } = h.clipboard('copy');
      h.view.destroy();
      return text === '1\t2\n4\t5';
    })
  );

  results.push(
    await scenario('paste TSV expands grid', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.focusGrid();
      h.clipboard('paste', 'x\ty\nz\tw');
      const doc = await h.commit();
      h.view.destroy();
      return /\|\s*x\s*\|/.test(doc) && /\|\s*w\s*\|/.test(doc);
    })
  );

  // A spreadsheet puts a cell holding a line break in quotes on the clipboard. The
  // range is still two rows of two: the quoted cell is one cell, not a row break.
  const BROKEN_RANGE = '"line one\nline two"\tB\nC\tD\n';

  results.push(
    await scenario('a spreadsheet range with a line break in a cell pastes into a pipe table as the range it is', async () => {
      const before = P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.';
      const h = mount(before);
      h.mousedown(h.cell(0, 0)!);
      h.focusGrid();
      h.clipboard('paste', BROKEN_RANGE);
      const doc = await h.commit();
      h.view.destroy();
      const cells = (line: string | undefined): string[] =>
        (line ?? '').trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const was = before.split('\n');
      const now = doc.split('\n');
      const row = tableLine + 2;
      // The pipe writer puts a space where a cell's line break was, as it does for
      // every cell it writes, so the cell stays on its row.
      const shaped =
        now.length === was.length &&
        cells(now[row]).join('|') === 'line one line two|B' &&
        cells(now[row + 1]).join('|') === 'C|D';
      const othersKept = now.every((l, i) => i === row || i === row + 1 || l === was[i]);
      if (!(shaped && othersKept)) throw new Error(JSON.stringify(doc));
      return true;
    })
  );

  results.push(
    await scenario('a spreadsheet range with a line break in a cell pastes into a CSV block with the line break kept', async () => {
      const before = P + '```csv\na,b\n1,2\n3,4\n```\n\nAfter.';
      const h = mount(before);
      h.mousedown(h.cell(0, 0)!);
      h.focusGrid();
      h.clipboard('paste', BROKEN_RANGE);
      const doc = await h.commit();
      h.view.destroy();
      const want = P + '```csv\na,b\n"line one\nline two",B\nC,D\n```\n\nAfter.';
      if (doc !== want) throw new Error(JSON.stringify(doc));
      return true;
    })
  );

  results.push(
    await scenario('a pasted column holding a line break in one cell keeps its empty cells', async () => {
      const before = P + '```csv\na,b\n1,2\n3,4\n5,6\n```';
      const h = mount(before);
      h.mousedown(h.cell(0, 1)!);
      h.focusGrid();
      h.clipboard('paste', '"x\ny"\n\nz\n');
      const doc = await h.commit();
      h.view.destroy();
      const want = P + '```csv\na,b\n1,"x\ny"\n3,\n5,z\n```';
      if (doc !== want) throw new Error(JSON.stringify(doc));
      return true;
    })
  );

  results.push(
    await scenario('a quoted value on one line pasted into the grid keeps its quotes', async () => {
      const before = P + '```csv\na,b\n1,2\n3,4\n```';
      const h = mount(before);
      h.mousedown(h.cell(0, 0)!);
      h.focusGrid();
      h.clipboard('paste', '"hello"\tx\ny\tz');
      const held = h.cell(0, 0)!.textContent;
      h.view.destroy();
      return held === '"hello"';
    })
  );

  results.push(
    await scenario('cut clears cells', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(0, 1)!, { shiftKey: true });
      h.focusGrid();
      const { text } = h.clipboard('cut');
      const doc = await h.commit();
      h.view.destroy();
      // Copied the two cells, and cleared them (row 0 cols 0-1 now empty).
      return text === '1\t2' && !/\|\s*1\s*\|/.test(doc.split('\n')[2] ?? '');
    })
  );

  results.push(
    await scenario('column select copies column', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(-1, 1)!); // click header of column B
      h.focusGrid();
      const { text } = h.clipboard('copy');
      h.view.destroy();
      return text === 'B\n2\n5';
    })
  );

  results.push(
    await scenario('Cmd-click adds a cell that is nowhere near the selection', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 2)!, { metaKey: true });
      const both = picked(h);
      const active = activeCell(h);
      // Ctrl-click does the same, for a keyboard without a Cmd key.
      h.mousedown(h.cell(1, 0)!, { ctrlKey: true });
      const three = `${picked(h)} | ${activeCell(h)}`;
      h.view.destroy();
      return both === '0,0 1,2' && active === '1,2' && three === '0,0 1,0 1,2 | 1,0';
    })
  );

  results.push(
    await scenario('Cmd-clicking a selected cell takes it back out, and the active cell follows', () => {
      const h = mount(PIPE);
      dragCells(h, [1, 1], [0, 0]);
      // The drag left (1,1), where it started, active. Dropping a cell that is not the active one
      // leaves the active cell where it was.
      h.mousedown(h.cell(0, 0)!, { metaKey: true });
      const afterOther = `${picked(h)} | ${activeCell(h)}`;
      // Dropping the active cell moves it to the first cell still picked.
      h.mousedown(h.cell(1, 1)!, { metaKey: true });
      const afterActive = `${picked(h)} | ${activeCell(h)}`;
      // Dropping the last two leaves nothing selected and no active cell.
      h.mousedown(h.cell(0, 1)!, { metaKey: true });
      h.mousedown(h.cell(1, 0)!, { metaKey: true });
      const empty = `${picked(h)} | ${activeCell(h)}`;
      h.view.destroy();
      return afterOther === '0,1 1,0 1,1 | 1,1' && afterActive === '0,1 1,0 | 0,1' && empty === ' | null';
    })
  );

  results.push(
    await scenario('Delete clears every cell picked by Cmd-click and nothing between them', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 2)!, { metaKey: true });
      h.keydown(h.grid()!, 'Delete');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| A | B | C |\n| - | - | - |\n|   | 2 | 3 |\n| 4 | 5 |   |';
    })
  );

  results.push(
    await scenario('Copy carries the cells picked by Cmd-click in the shape they were picked', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 2)!, { metaKey: true });
      h.focusGrid();
      const { text } = h.clipboard('copy');
      h.view.destroy();
      // The block the two cells span, with the cells nobody picked left empty.
      return text === '1\t\t\n\t\t6';
    })
  );

  results.push(
    await scenario('typing over a Cmd-click selection replaces the active cell only', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 2)!, { metaKey: true });
      h.keydown(h.grid()!, 'Z');
      h.keydown(h.input(1, 2)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | Z |';
    })
  );

  results.push(
    await scenario('typing after a drag replaces the cell the drag started on and keeps the block', async () => {
      const h = mount(PIPE);
      dragCells(h, [0, 0], [1, 1]);
      const afterDrag = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'Q');
      const openIn = h.input(0, 0) ? '0,0' : h.input(1, 1) ? '1,1' : 'none';
      const whileTyping = picked(h);
      h.keydown(h.root()!.querySelector('.sheaf-table-input')!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        afterDrag === '0,0 0,1 1,0 1,1 | 0,0' &&
        openIn === '0,0' &&
        whileTyping === '0,0 0,1 1,0 1,1' &&
        doc === P + '| A | B | C |\n| - | - | - |\n| Q | 2 | 3 |\n| 4 | 5 | 6 |'
      );
    })
  );

  results.push(
    await scenario('Shift+arrow after a drag moves the far end and keeps the active cell', () => {
      const h = mount(PIPE);
      dragCells(h, [0, 0], [0, 1]);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      const down = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'ArrowRight', { shiftKey: true });
      const right = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'ArrowLeft', { shiftKey: true });
      h.keydown(h.grid()!, 'ArrowLeft', { shiftKey: true });
      const back = `${picked(h)} | ${activeCell(h)}`;
      h.view.destroy();
      return (
        down === '0,0 0,1 1,0 1,1 | 0,0' &&
        right === '0,0 0,1 0,2 1,0 1,1 1,2 | 0,0' &&
        back === '0,0 1,0 | 0,0'
      );
    })
  );

  results.push(
    await scenario('Shift-click keeps the active cell where the selection started', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(1, 1)!);
      mouseup();
      h.mousedown(h.cell(0, 0)!, { shiftKey: true });
      mouseup();
      const block = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'ArrowRight', { shiftKey: true });
      const grown = `${picked(h)} | ${activeCell(h)}`;
      h.view.destroy();
      return block === '0,0 0,1 1,0 1,1 | 1,1' && grown === '0,1 1,1 | 1,1';
    })
  );

  results.push(
    await scenario('typing after a Shift-click replaces the cell the selection started from and keeps the block', async () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(1, 1)!);
      mouseup();
      h.mousedown(h.cell(0, 0)!, { shiftKey: true });
      mouseup();
      h.keydown(h.grid()!, 'Q');
      const openIn = h.input(1, 1) ? '1,1' : h.input(0, 0) ? '0,0' : 'none';
      const whileTyping = picked(h);
      h.keydown(h.root()!.querySelector('.sheaf-table-input')!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        openIn === '1,1' &&
        whileTyping === '0,0 0,1 1,0 1,1' &&
        doc === P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | Q | 6 |'
      );
    })
  );

  results.push(
    await scenario('copy and Delete after a drag act on the whole block, not only the active cell', async () => {
      const h = mount(PIPE);
      dragCells(h, [0, 0], [1, 1]);
      const copied = h.clipboard('copy').text;
      h.keydown(h.grid()!, 'Delete');
      const after = `${picked(h)} | ${activeCell(h)}`;
      const doc = await h.commit();
      h.view.destroy();
      return (
        copied === '1\t2\n4\t5' &&
        after === '0,0 0,1 1,0 1,1 | 0,0' &&
        doc === P + '| A | B | C |\n| - | - | - |\n|   |   | 3 |\n|   |   | 6 |'
      );
    })
  );

  results.push(
    await scenario('a plain click still selects and activates the clicked cell', async () => {
      const h = mount(PIPE);
      dragCells(h, [0, 0], [1, 1]);
      h.mousedown(h.cell(1, 2)!);
      mouseup();
      const clicked = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'ArrowLeft');
      const stepped = `${picked(h)} | ${activeCell(h)}`;
      h.keydown(h.grid()!, 'R');
      h.keydown(h.input(1, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        clicked === '1,2 | 1,2' &&
        stepped === '1,1 | 1,1' &&
        doc === P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | R | 6 |'
      );
    })
  );

  results.push(
    await scenario('renders markdown in cell', () => {
      const h = mount(P + '| H |\n| - |\n| **bold** |');
      const html = h.cell(0, 0)?.innerHTML ?? '';
      h.view.destroy();
      return /<strong>bold<\/strong>/.test(html);
    })
  );

  results.push(
    await scenario('preserves alignment on edit', async () => {
      const h = mount(P + '| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |');
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'aa';
      const doc = await h.commit();
      h.view.destroy();
      const delim = doc.split('\n').find((l) => l.includes(':-'))!;
      return /:-+\s*\|\s*:-+:\s*\|\s*-+:/.test(delim);
    })
  );

  results.push(
    await scenario('csv round-trips as csv block', async () => {
      const h = mount(P + '```csv\nx,y\n1,2\n```');
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = '9';
      h.keydown(inp, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc.includes('```csv') && /^9,2$/m.test(doc);
    })
  );

  results.push(
    await scenario('csv quotes fields with commas', async () => {
      const h = mount(P + '```csv\nname,note\na,b\n```');
      h.dblclick(h.cell(0, 1)!);
      const inp = h.input(0, 1)!;
      inp.value = 'x, y';
      h.keydown(inp, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc.includes('"x, y"');
    })
  );

  // ---- minimal write-back: untouched source stays byte-identical ----

  // Hand-written: uneven padding, a delimiter row with no spaces, a cramped cell.
  const RAGGED = P + '| Fruit | Qty |\n|---|:-:|\n| apple | 3 |\n| kiwi fruit |12|';
  // Line indexes within RAGGED: 2 header, 3 delimiter, 4 apple, 5 kiwi.
  const changed = (a: string[], b: string[]): number[] =>
    a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);

  results.push(
    await scenario('click-through leaves table as written', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(1, 0)!);
      h.mousedown(h.cell(0, 1)!, { shiftKey: true });
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED;
    })
  );

  results.push(
    await scenario('widening a cell changes one line', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'a much longer apple';
      const before = RAGGED.split('\n');
      const after = (await h.commit()).split('\n');
      h.view.destroy();
      return (
        after.length === before.length &&
        changed(before, after).join() === '4' &&
        after[4] === '| a much longer apple | 3 |'
      );
    })
  );

  results.push(
    await scenario('shorter value keeps column padding', async () => {
      const T = P + '| Name   | Qty |\n| ------ | --- |\n| apple  | 3   |\n| banana | 12  |';
      const h = mount(T);
      h.dblclick(h.cell(1, 0)!);
      const inp = h.input(1, 0)!;
      inp.value = 'fig';
      const before = T.split('\n');
      const after = (await h.commit()).split('\n');
      h.view.destroy();
      return changed(before, after).join() === '5' && after[5] === '| fig    | 12  |';
    })
  );

  results.push(
    await scenario('+ Row keeps other rows verbatim', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click();
      const before = RAGGED.split('\n');
      const after = (await h.commit()).split('\n');
      h.view.destroy();
      return (
        after.length === before.length + 1 &&
        after.slice(0, 5).join('\n') === before.slice(0, 5).join('\n') &&
        /^\|\s+\|\s+\|$/.test(after[5]) &&
        after[6] === before[5]
      );
    })
  );

  results.push(
    await scenario('− Row keeps other rows verbatim', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.delete')!.click();
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED.replace('| apple | 3 |\n', '');
    })
  );

  results.push(
    await scenario('+ Col keeps existing cell segments', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(-1, 0)!);
      h.ctrl('col.insertRight')!.click();
      const doc = await h.commit();
      h.view.destroy();
      return (
        doc ===
        P + '| Fruit |     | Qty |\n|---| --- |:-:|\n| apple |     | 3 |\n| kiwi fruit |     |12|'
      );
    })
  );

  results.push(
    await scenario('− Col keeps remaining cell segments', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(-1, 0)!);
      h.ctrl('col.delete')!.click();
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| Qty |\n|:-:|\n| 3 |\n|12|';
    })
  );

  results.push(
    await scenario('escaped pipe is escaped once on edit', async () => {
      const T = P + '| a | b |\n| - | - |\n| x \\| y | 2 |';
      const h = mount(T);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'x \\| z';
      const doc = await h.commit();
      h.view.destroy();
      return doc.split('\n')[4] === '| x \\| z | 2 |';
    })
  );

  results.push(
    await scenario('edit after a click-through still writes', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      await h.commit(); // nothing changed, so nothing is written
      h.dblclick(h.cell(1, 1)!);
      const inp = h.input(1, 1)!;
      inp.value = '99';
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED.replace('|12|', '|99|');
    })
  );

  results.push(
    await scenario('Escape cancels a cell edit', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'junk';
      h.keydown(inp, 'Escape');
      const text = h.cell(0, 0)!.textContent;
      const doc = await h.commit();
      h.view.destroy();
      return text === 'apple' && doc === RAGGED;
    })
  );

  results.push(
    await scenario('Enter past the last row writes no empty row', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(1, 0)!);
      const inp = h.input(1, 0)!;
      inp.value = 'kiwi';
      h.keydown(inp, 'Enter');
      const shown = h.root()!.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return shown === 3 && doc === RAGGED.replace('| kiwi fruit |', '| kiwi       |');
    })
  );

  results.push(
    await scenario('escaped pipe renders as a pipe', () => {
      const h = mount(P + '| h |\n| - |\n| a \\| b |');
      const text = h.cell(0, 0)?.textContent;
      h.view.destroy();
      return text === 'a | b';
    })
  );

  const CSV = P + '```csv\nname,note\n"apple",fresh\nkiwi,"ripe"\n```';

  results.push(
    await scenario('csv click-through leaves block as written', async () => {
      const h = mount(CSV);
      h.mousedown(h.cell(0, 0)!);
      const doc = await h.commit();
      h.view.destroy();
      return doc === CSV;
    })
  );

  results.push(
    await scenario('csv edit keeps other rows verbatim', async () => {
      const h = mount(CSV);
      h.dblclick(h.cell(1, 1)!);
      const inp = h.input(1, 1)!;
      inp.value = 'soft';
      const doc = await h.commit();
      h.view.destroy();
      return doc === CSV.replace('kiwi,"ripe"', 'kiwi,soft');
    })
  );

  // ---- A named data block: ```csv id=tasks ----
  const NAMED = P + '```csv id=tasks\nname,status\nWrite,Done\nShip,Open\n```';

  results.push(
    await scenario('a csv block with a name after its language still draws as a grid, with its name above it', () => {
      const h = mount(NAMED);
      const grid = !!h.grid() && h.cell(1, 0)?.textContent === 'Ship';
      const caption = h.root()?.querySelector('.sheaf-table-caption') as HTMLElement | null;
      const named = !!caption && !caption.hidden && caption.querySelector('.sheaf-table-id')?.textContent === '#tasks';
      const clean = !h.root()?.querySelector('.sheaf-table-error');
      // The badge names the language, not the whole info string.
      const badge = h.root()?.querySelector('.sheaf-table-badge')?.textContent;
      h.view.destroy();
      return grid && named && clean && badge === 'CSV';
    })
  );

  results.push(
    await scenario('a tsv block with a name and more words after it still draws as a grid', () => {
      const h = mount(P + '```tsv id=people other=words\nname\tage\nAda\t36\n```');
      const ok = h.cell(0, 1)?.textContent === '36';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('an unnamed csv block shows no name line', () => {
      const h = mount(CSV);
      const caption = h.root()?.querySelector('.sheaf-table-caption') as HTMLElement | null;
      h.view.destroy();
      return !!caption && caption.hidden;
    })
  );

  results.push(
    await scenario('editing a named csv block rewrites the one field and keeps the opening line with its name', async () => {
      const h = mount(NAMED);
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = 'Done';
      const doc = await h.commit();
      h.view.destroy();
      return doc === NAMED.replace('Ship,Open', 'Ship,Done');
    })
  );

  results.push(
    await scenario('two blocks with the same name each say so, and a third with its own name does not', () => {
      const doc = P + '```csv id=tasks\na,b\n1,2\n```\n\n```csv id=Tasks\na,b\n3,4\n```\n\n```csv id=other\na,b\n5,6\n```';
      const h = mount(doc);
      const tables = Array.from(h.view.dom.querySelectorAll('.sheaf-table'));
      const errors = tables.map((t) => t.querySelector('.sheaf-table-error')?.textContent ?? '');
      h.view.destroy();
      return (
        tables.length === 3 &&
        errors[0].includes('also named "tasks"') &&
        errors[1].includes('also named "Tasks"') &&
        errors[2] === ''
      );
    })
  );

  results.push(
    await scenario('a duplicate name is flagged even while the other block shows its source', () => {
      const doc = P + '```csv id=tasks\na,b\n1,2\n```\n\n```csv id=tasks\na,b\n3,4\n```';
      const h = mount(doc);
      // The caret in the second block's text opens it as source.
      h.view.dispatch({ selection: { anchor: doc.lastIndexOf('3,4') + 1 } });
      const tables = Array.from(h.view.dom.querySelectorAll('.sheaf-table'));
      const flagged = tables.length === 1 && !!tables[0].querySelector('.sheaf-table-error');
      h.view.destroy();
      return flagged;
    })
  );

  results.push(
    await scenario('dataBlocks finds every csv and tsv block with its name, and marks duplicates', () => {
      const doc = P + '```csv id=a\nx\n1\n```\n\n```tsv\nx\n2\n```\n\n```csv id=A\nx\n3\n```\n\n```js id=a\nx\n```';
      const h = mount(doc);
      const found = dataBlocks(h.view.state).map((b) => `${b.lang}:${b.id}:${b.duplicate}`);
      h.view.destroy();
      return JSON.stringify(found) === JSON.stringify(['csv:a:true', 'tsv:null:false', 'csv:A:true']);
    })
  );

  results.push(
    await scenario('writeDataBlock changes one field of one record and nothing else', () => {
      const block = '```csv id=t\nname,note\n"apple",  fresh\nkiwi,"ripe, soft"\n```';
      const out = writeDataBlock(block, 'csv', '', { row: 0, col: 1, value: 'old' });
      return out === '```csv id=t\nname,note\n"apple",old\nkiwi,"ripe, soft"\n```';
    })
  );

  results.push(
    await scenario('writeDataBlock appends a row under the last and keeps the rest byte for byte', () => {
      const block = '```csv\nname,status\nWrite,Done\n```';
      const out = writeDataBlock(block, 'csv', '', { append: ['', 'Open'] });
      return out === '```csv\nname,status\nWrite,Done\n,Open\n```';
    })
  );

  results.push(
    await scenario('writeDataBlock inside a blockquote keeps every line in the quote', () => {
      const block = '> ```csv id=q\n> a,b\n> 1,2\n> ```';
      const out = writeDataBlock(block, 'csv', '> ', { row: 0, col: 0, value: '9' });
      return out === '> ```csv id=q\n> a,b\n> 9,2\n> ```';
    })
  );

  results.push(
    await scenario('writeDataFile edits a file text in place and keeps its final newline', () => {
      const file = 'name,status\nWrite,Done\n"Ship, soon",Open\n';
      const edited = writeDataFile(file, 'csv', { row: 1, col: 1, value: 'Done' });
      const appended = writeDataFile(file, 'csv', { append: ['Test', ''] });
      const tsv = writeDataFile('a\tb\n1\t2', 'tsv', { row: 0, col: 0, value: 'x y' });
      return (
        edited === 'name,status\nWrite,Done\n"Ship, soon",Done\n' &&
        appended === 'name,status\nWrite,Done\n"Ship, soon",Open\nTest,\n' &&
        tsv === 'a\tb\nx y\t2'
      );
    })
  );

  results.push(
    await scenario('editing one csv field leaves every other field in its row as written', async () => {
      // Every form a field can be written in, in one record, with the last field edited.
      const doc = 'x\n\n```csv\na,b,c,d,e\n"quote "" inside"," padded ","x, y","two\nlines",3\n```\n';
      const h = mount(doc);
      h.dblclick(h.cell(0, 4)!);
      h.input(0, 4)!.value = '33';
      const out = await h.commit();
      h.view.destroy();
      return out === doc.replace(',3\n```', ',33\n```');
    })
  );

  results.push(
    await scenario('editing one tsv field leaves a quoted field beside it as written', async () => {
      const doc = 'x\n\n```tsv\na\tb\n"say ""hi"""\t1\n```\n';
      const h = mount(doc);
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '2';
      const out = await h.commit();
      h.view.destroy();
      return out === doc.replace('\t1\n', '\t2\n');
    })
  );

  results.push(
    await scenario('typing after a header click edits the header', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(-1, 1)!);
      h.keydown(h.grid()!, 'N');
      const inHeader = !!h.input(-1, 1);
      const doc = await h.commit();
      h.view.destroy();
      return inHeader && doc === RAGGED.replace('| Qty |', '| N   |');
    })
  );

  results.push(
    await scenario('typing after a gutter click edits the first cell', async () => {
      const h = mount(RAGGED);
      const gutter = h.root()!.querySelectorAll('tbody .sheaf-table-gutter')[1] as HTMLElement;
      h.mousedown(gutter);
      h.keydown(h.grid()!, 'k');
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED.replace('| kiwi fruit |', '| k          |');
    })
  );

  results.push(
    await scenario('arrow keys carry the caret into and out of a table', async () => {
      const T = RAGGED + '\n\nafter';
      const to = RAGGED.length;
      const h = mount(T);
      const press = (el: Element, key: string): void => h.keydown(el, key);
      const focusRow = (): string | null | undefined => h.root()?.querySelector('.is-focus')?.getAttribute('data-r');
      h.view.dispatch({ selection: { anchor: P.length - 1 } }); // blank line above the table
      press(h.view.contentDOM, 'ArrowDown');
      const enteredTop = focusRow() === '-1' && document.activeElement === h.grid();
      press(h.grid()!, 'ArrowUp'); // header row: leave upward
      const leftTop = h.view.state.selection.main.head === P.length - 1;
      h.view.dispatch({ selection: { anchor: to + 1 } }); // blank line below the table
      press(h.view.contentDOM, 'ArrowUp');
      const enteredBottom = focusRow() === '1' && document.activeElement === h.grid();
      press(h.grid()!, 'ArrowDown'); // last row: leave downward
      const leftBottom = h.view.state.selection.main.head === to + 1;
      const doc = await h.commit();
      h.view.destroy();
      return enteredTop && leftTop && enteredBottom && leftBottom && doc === T;
    })
  );

  results.push(
    await scenario('typing under a table starts its own paragraph', () => {
      const T = RAGGED + '\n\n### Next';
      const at = RAGGED.length + 1; // the blank line under the table
      const h = mount(T);
      h.view.dispatch({ changes: { from: at, insert: 'h' }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
      const head = h.view.state.selection.main.head;
      h.view.dispatch({ changes: { from: head, insert: 'ello' }, selection: { anchor: head + 4 }, userEvent: 'input.type' });
      const typed = h.doc();
      h.view.destroy();
      return typed === RAGGED + '\n\nhello\n### Next';
    })
  );

  results.push(
    await scenario('paste under a table starts its own paragraph; host edits pass', () => {
      const T = RAGGED + '\n\n### Next';
      const at = RAGGED.length + 1;
      const a = mount(T);
      a.view.dispatch({ changes: { from: at, insert: 'pasted' }, userEvent: 'input.paste' });
      const pasted = a.doc();
      a.view.destroy();
      const b = mount(T);
      b.view.dispatch({ changes: { from: at, insert: '| new | row |' } }); // not user input
      const host = b.doc();
      b.view.destroy();
      return pasted === RAGGED + '\n\npasted\n### Next' && host === RAGGED + '\n| new | row |\n### Next';
    })
  );

  results.push(
    await scenario('undo in the grid reverts the last cell edit', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter');
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const shown = h.cell(0, 0)!.textContent;
      const doc = await h.commit();
      h.view.destroy();
      return shown === 'apple' && doc === RAGGED;
    })
  );

  results.push(
    await scenario('redo in the grid reapplies the edit', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter');
      h.keydown(h.grid()!, 'z', { metaKey: true });
      h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED.replace('| apple |', '| X     |');
    })
  );

  results.push(
    await scenario('undo in the grid reverts row adds and pastes in order', async () => {
      const h = mount(RAGGED, [history()]);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click();
      h.mousedown(h.cell(0, 1)!);
      h.focusGrid();
      h.clipboard('paste', '7\n8');
      const rowsAfter = h.root()!.querySelectorAll('tbody tr').length;
      h.keydown(h.grid()!, 'z', { metaKey: true }); // undo the paste
      const qtyAfterOneUndo = h.cell(0, 1)!.textContent;
      h.keydown(h.grid()!, 'z', { ctrlKey: true }); // undo the row add
      const rowsAfterTwoUndos = h.root()!.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return rowsAfter === 3 && qtyAfterOneUndo === '3' && rowsAfterTwoUndos === 2 && doc === RAGGED;
    })
  );

  results.push(
    await scenario('undo in the grid after a save steps the document history', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter');
      const saved = await h.commit();
      h.mousedown(h.cell(0, 1)!);
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const undone = h.doc();
      // The active cell moves to the cell the undone edit changed.
      const focused = h.root()?.querySelector('.is-focus');
      const inGrid = document.activeElement === h.grid();
      h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });
      const redone = h.doc();
      h.view.destroy();
      return (
        saved !== RAGGED &&
        undone === RAGGED &&
        focused?.getAttribute('data-r') === '0' &&
        focused?.getAttribute('data-c') === '0' &&
        inGrid &&
        redone === saved
      );
    })
  );

  const MULTI = P + '```csv\nname,notes\napple,"line one\nline two"\n```';

  results.push(
    await scenario('multi-line csv cell survives opening and Enter', async () => {
      const h = mount(MULTI);
      h.dblclick(h.cell(0, 1)!);
      const area = h.cell(0, 1)!.querySelector('textarea');
      const opened = area?.value;
      if (area) h.keydown(area, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return opened === 'line one\nline two' && doc === MULTI;
    })
  );

  results.push(
    await scenario('multi-line csv cell edit keeps its line breaks', async () => {
      const h = mount(MULTI);
      h.dblclick(h.cell(0, 1)!);
      const area = h.cell(0, 1)!.querySelector('textarea')!;
      area.value = 'first\nsecond';
      h.keydown(area, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === MULTI.replace('"line one\nline two"', '"first\nsecond"');
    })
  );

  results.push(
    await scenario('Alt+Enter keeps a CSV cell open, where a line break belongs in the value', () => {
      const h = mount(P + '```csv\nname,notes\napple,red\n```');
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      h.keydown(field, 'Enter', { altKey: true });
      const open = h.cell(0, 1)!.querySelector('.sheaf-table-input') === field && activeCell(h) === '0,1';
      h.view.destroy();
      return open;
    })
  );

  // A text box in Chromium on macOS inserts nothing for Alt+Enter, and jsdom never
  // performs a key's default action either, so the line break has to be the cell's
  // own doing. The check reads the value, since a key that is merely let through
  // passes here and still adds nothing in a real window.
  results.push(
    await scenario('Alt+Enter in a CSV cell puts a line break in the value at the caret', async () => {
      const DOC = P + '```csv\nname,notes\napple,red\n```';
      const h = mount(DOC);
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      field.value = 'first';
      field.setSelectionRange(5, 5);
      field.dispatchEvent(new G.Event('input', { bubbles: true }));
      let heard = 0;
      field.addEventListener('input', () => heard++);
      const press = new G.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(press);
      // The grid hears the break as an edit, as it hears a typed letter.
      const broken = field.value === 'first\n' && field.selectionStart === 6 && field.selectionEnd === 6 && heard === 1;
      field.setRangeText('second', 6, 6, 'end');
      field.dispatchEvent(new G.Event('input', { bubbles: true }));
      h.keydown(field, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return broken && press.defaultPrevented && doc === DOC.replace('apple,red', 'apple,"first\nsecond"');
    })
  );

  results.push(
    await scenario('Alt+Enter over selected text in a CSV cell replaces it with the line break', () => {
      const h = mount(P + '```csv\nname,notes\napple,red\n```');
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      field.value = 'one two';
      field.setSelectionRange(3, 4); // the space
      h.keydown(field, 'Enter', { altKey: true });
      const value = field.value;
      const caret = [field.selectionStart, field.selectionEnd].join();
      h.view.destroy();
      return value === 'one\ntwo' && caret === '4,4';
    })
  );

  results.push(
    await scenario('a cell edited down to a trailing line break keeps a line for it', () => {
      const h = mount(MULTI);
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      const sizer = h.cell(0, 1)!.querySelector('.sheaf-table-sizer') as HTMLElement;
      const opened = sizer.textContent === 'line one\nline two';
      field.value = 'line one\n';
      field.dispatchEvent(new G.Event('input', { bubbles: true }));
      // The field draws an empty last line for the break, so the box measured
      // against it carries one too, in a character with no width of its own.
      const broken = sizer.textContent === 'line one\n\u200b';
      h.view.destroy();
      return opened && broken;
    })
  );

  results.push(
    await scenario('Home and End in a multi-line cell go to the ends of the caret\'s own line', () => {
      const h = mount(MULTI);
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      field.setSelectionRange(3, 3); // inside "line one"
      h.keydown(field, 'End');
      const end = [field.selectionStart, field.selectionEnd].join();
      field.setSelectionRange(12, 12); // inside "line two"
      h.keydown(field, 'Home');
      const home = [field.selectionStart, field.selectionEnd].join();
      h.view.destroy();
      return end === '8,8' && home === '9,9';
    })
  );

  // ---- quoting: a quote opens a field only at its start (RFC 4180) ----

  // An inch mark is ordinary data. It must not open a quoted section, or the
  // records below it are swallowed into one cell and the quotes disappear.
  const INCH = P + '```csv\nitem,price\n27" monitor,300\n6" cable,5\nmouse,20\n```';

  results.push(
    await scenario('an inch mark mid-field keeps csv records on their own rows', async () => {
      const h = mount(INCH);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const items = [h.cell(0, 0), h.cell(1, 0), h.cell(2, 0)].map((c) => c?.textContent);
      const prices = [h.cell(0, 1), h.cell(1, 1), h.cell(2, 1)].map((c) => c?.textContent);
      h.mousedown(h.cell(0, 0)!);
      const doc = await h.commit();
      h.view.destroy();
      return (
        rows === 3 &&
        items.join('/') === '27" monitor/6" cable/mouse' &&
        prices.join('/') === '300/5/20' &&
        doc === INCH
      );
    })
  );

  const INCH_TSV = P + '```tsv\nitem\tsize\nMonitor\t27" wide\nCable\t6" long\n```';

  results.push(
    await scenario('an inch mark mid-field keeps tsv records on their own rows', async () => {
      const h = mount(INCH_TSV);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const cells = [h.cell(0, 0), h.cell(0, 1), h.cell(1, 0), h.cell(1, 1)].map((c) => c?.textContent);
      h.mousedown(h.cell(0, 0)!);
      const doc = await h.commit();
      h.view.destroy();
      return rows === 2 && cells.join('/') === 'Monitor/27" wide/Cable/6" long' && doc === INCH_TSV;
    })
  );

  results.push(
    await scenario('a quoted csv field holds a comma in one cell', () => {
      const h = mount(P + '```csv\nname,note\napple,"red, ripe"\nkiwi,green\n```');
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const note = h.cell(0, 1)?.textContent;
      const next = h.cell(1, 0)?.textContent;
      h.view.destroy();
      return rows === 2 && note === 'red, ripe' && next === 'kiwi';
    })
  );

  results.push(
    await scenario('a doubled quote inside a quoted csv field is one quote', () => {
      const h = mount(P + '```csv\nname,note\napple,"say ""hi"" now"\n```');
      const note = h.cell(0, 1)?.textContent;
      h.view.destroy();
      return note === 'say "hi" now';
    })
  );

  // Every field here is already spelled the way the writer spells it, so the
  // block is a fixed point: parsing it and writing it back changes no bytes.
  const QUOTED = P + '```csv\nitem,note\n27" monitor,"wide, sturdy"\nmouse,"""quoted"" start"\n```';

  results.push(
    await scenario('a csv block that uses quoting survives parse and write-back', async () => {
      const seen = mount(QUOTED);
      const cells = [seen.cell(0, 0), seen.cell(0, 1), seen.cell(1, 0), seen.cell(1, 1)].map((c) => c?.textContent);
      seen.mousedown(seen.cell(0, 0)!);
      const untouched = (await seen.commit()) === QUOTED;
      seen.view.destroy();
      // Editing a row writes it out from the model, so each quoted field in it is
      // spelled afresh and has to come back byte-identical.
      const h = mount(QUOTED);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = '27" screen';
      h.keydown(h.input(0, 0)!, 'Enter');
      h.dblclick(h.cell(1, 0)!);
      h.input(1, 0)!.value = 'pad';
      h.keydown(h.input(1, 0)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return (
        cells.join('/') === '27" monitor/wide, sturdy/mouse/"quoted" start' &&
        untouched &&
        doc === QUOTED.replace('27" monitor,', '27" screen,').replace('mouse,', 'pad,')
      );
    })
  );

  // The same parser rule behind the merged rows above: a quote opened mid-field,
  // so the quotes were dropped from the model and the next write lost them.
  results.push(
    await scenario('a quote after a space survives the next edit of its row', async () => {
      const src = P + '```csv\nspeaker,line\nada,She said "hi"\nbob,plain\n```';
      const h = mount(src);
      const line = h.cell(0, 1)?.textContent;
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'ada l.';
      h.keydown(h.input(0, 0)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return line === 'She said "hi"' && doc === src.replace('ada,', 'ada l.,');
    })
  );

  // The reported case, where the field opens with a space and the quote is its
  // second character. The space has already taken the field off its start, so the
  // quote is literal: the cell keeps both marks and the leading space, and the field
  // is written back as typed. This is the strict reading, where a quoted field is
  // recognised only at the very first character; a reading that looked past leading
  // spaces would instead treat `, "b, c"` as one quoted field.
  results.push(
    await scenario('a csv field opening with a space keeps a quote after it as data', async () => {
      const src = P + '```csv\nwho,line\nsays, "hi" there\nbob,plain\n```';
      const h = mount(src);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const kept = h.cell(0, 1)?.textContent;
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'asks';
      h.keydown(h.input(0, 0)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return rows === 2 && kept === ' "hi" there' && doc === src.replace('says,', 'asks,');
    })
  );

  // ---- empty records and blank lines keep their place in the block ----

  // A record whose fields are all empty is still a record: it has the delimiter,
  // so it shows as a row of empty cells and its line stays in the file.
  const EMPTY_REC = P + '```csv\na,b\n1,2\n,\n3,4\n```';

  results.push(
    await scenario('an empty csv record shows as a row and keeps its line when another row is edited', async () => {
      const h = mount(EMPTY_REC);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const empty = [h.cell(1, 0)?.textContent, h.cell(1, 1)?.textContent];
      h.dblclick(h.cell(2, 1)!);
      h.input(2, 1)!.value = '9';
      h.keydown(h.input(2, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return rows === 3 && empty.join('/') === '/' && doc === EMPTY_REC.replace('3,4', '3,9');
    })
  );

  const EMPTY_TSV = P + '```tsv\na\tb\n1\t2\n\t\n3\t4\n```';

  results.push(
    await scenario('an empty tsv record shows as a row and keeps its line when another row is edited', async () => {
      const h = mount(EMPTY_TSV);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      h.dblclick(h.cell(2, 1)!);
      h.input(2, 1)!.value = '9';
      h.keydown(h.input(2, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return rows === 3 && doc === EMPTY_TSV.replace('3\t4', '3\t9');
    })
  );

  // A wholly blank line carries no delimiter, so it is not a record and the grid
  // does not show it. It is still a line nobody touched, so it stays as written.
  const BLANK_LINE = P + '```csv\na,b\n1,2\n\n3,4\n```';

  results.push(
    await scenario('a blank line inside a csv block survives an edit to another row', async () => {
      const h = mount(BLANK_LINE);
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = '9';
      h.keydown(h.input(1, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return rows === 2 && doc === BLANK_LINE.replace('3,4', '3,9');
    })
  );

  // ---- fields past the header stay on their line ----

  // The grid shows as many columns as the header has, so the third field here is
  // never on screen. It is still the person's data, sitting on a line they did not
  // edit, so rewriting the row has to carry it along.
  const RAGGED_CSV = P + '```csv\na,b\n1,2,extra\n3,4\n```';

  results.push(
    await scenario('a csv row with more fields than the header keeps them when it is edited', async () => {
      const h = mount(RAGGED_CSV);
      const shown = h.cell(0, 2);
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '9';
      h.keydown(h.input(0, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return shown === null && doc === RAGGED_CSV.replace('1,2,extra', '1,9,extra');
    })
  );

  // The mirror case, which already worked: a short row is not padded out to the
  // header's width when some other row is edited.
  const SHORT_ROW = P + '```csv\na,b\n1\n3,4\n```';

  results.push(
    await scenario('a csv row with fewer fields than the header is left as written', async () => {
      const h = mount(SHORT_ROW);
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = '9';
      h.keydown(h.input(1, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === SHORT_ROW.replace('3,4', '3,9');
    })
  );

  results.push(
    await scenario('<br> in a cell renders as a line break', () => {
      const h = mount(P + '| a |\n| - |\n| one<br>two |');
      const cell = h.cell(0, 0)!;
      // The cell's text sits in an element of its own, which is what a tall cell is clamped on.
      const text = cell.querySelector(':scope > .sheaf-table-text');
      const ok = text?.innerHTML === 'one<br>two' && cell.textContent === 'onetwo';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('an image in a cell shows the picture', async () => {
      setResourceBaseUri('https://res.test/docs/');
      const IMG =
        P +
        '| Pic | Note |\n| --- | --- |\n' +
        '| ![dot](../assets/dot.png) | plain |\n' +
        '| ![logo](sub/logo.png "Our logo") | x |\n' +
        '| before ![dot](dot.png) after | y |';
      const h = mount(IMG);
      const img = (r: number): HTMLImageElement | null => h.cell(r, 0)!.querySelector('img.md-img');
      const alone = img(0);
      const shown =
        alone?.getAttribute('src') === 'https://res.test/assets/dot.png' &&
        alone?.getAttribute('alt') === 'dot' &&
        h.cell(0, 0)!.textContent === '' &&
        !h.cell(0, 0)!.querySelector('.tok-link');
      const inLine = alone?.closest('.md-img-wrap')?.classList.contains('md-img-inline') === true;
      const titled =
        img(1)?.getAttribute('title') === 'Our logo' &&
        img(1)?.getAttribute('src') === 'https://res.test/docs/sub/logo.png' &&
        img(1)?.getAttribute('alt') === 'logo';
      const beside =
        h.cell(2, 0)!.querySelectorAll('img.md-img').length === 1 && h.cell(2, 0)!.textContent === 'before  after';
      // Opening the cell shows its Markdown, and Escape draws the picture again.
      h.dblclick(h.cell(0, 0)!);
      const opened = h.input(0, 0)?.value === '![dot](../assets/dot.png)';
      h.keydown(h.input(0, 0)!, 'Escape');
      const drawn = !!img(0);
      const doc = await h.commit();
      h.view.destroy();
      return shown && inLine && titled && beside && opened && drawn && doc === IMG;
    })
  );

  results.push(
    await scenario('a cell that only looks like an image keeps its text', async () => {
      setResourceBaseUri('https://res.test/docs/');
      const NOT =
        P +
        '| a |\n| - |\n| Wow! yes |\n| ! |\n| \\![dot](d.png) |\n| ![x](file:///etc/x.png) |\n| ![gone](gone.png) |';
      const h = mount(NOT);
      const text = (r: number): string | null => h.cell(r, 0)!.textContent;
      const noImages = h.root()!.querySelectorAll('img.md-img').length === 1;
      const plain = text(0) === 'Wow! yes' && text(1) === '!';
      // An escaped "!" is a character, so what follows it is an ordinary link.
      const escaped = text(2) === '!dot' && !!h.cell(2, 0)!.querySelector('.tok-link');
      // An address the webview may not load leaves the Markdown where it is, as prose does.
      const refused = text(3) === '![x](file:///etc/x.png)';
      // A picture that does not load says so, as prose does.
      const missing = h.cell(4, 0)!.querySelector('img.md-img')!;
      missing.dispatchEvent(new G.Event('error', { bubbles: false }));
      const broken = missing.closest('.md-img-wrap')?.classList.contains('is-broken') === true;
      const doc = await h.commit();
      h.view.destroy();
      return noImages && plain && escaped && refused && broken && doc === NOT;
    })
  );

  results.push(
    await scenario('Cmd-click on a link in a cell opens it', async () => {
      const h = mount(P + '| Site | Link |\n| --- | --- |\n| Docs | [guide](https://example.com/g?a=1&b=2) |\n| Bad | [x](javascript:alert(1)) |');
      const win = document.defaultView as any;
      const opened: string[] = [];
      const original = win.HTMLAnchorElement.prototype.click;
      win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
        opened.push(this.href);
      };
      const good = h.cell(0, 1)!.querySelector('.tok-link')!;
      h.mousedown(good, { metaKey: true });
      const selectedByCmdClick = !!h.root()!.querySelector('.is-focus');
      h.mousedown(h.cell(1, 1)!.querySelector('.tok-link')!, { ctrlKey: true });
      h.mousedown(good); // a plain click still selects the cell
      const selectedByPlainClick = h.cell(0, 1)!.classList.contains('is-focus');
      win.HTMLAnchorElement.prototype.click = original;
      const doc = await h.commit();
      h.view.destroy();
      return (
        opened.length === 1 &&
        opened[0] === 'https://example.com/g?a=1&b=2' &&
        !selectedByCmdClick &&
        selectedByPlainClick &&
        doc.includes('[guide](https://example.com/g?a=1&b=2)')
      );
    })
  );

  results.push(
    await scenario('a link in a cell opens at the address prose would open', async () => {
      const h = mount(
        P +
          '| Who | Link |\n| --- | --- |\n| Mail | [mail](someone@example.com) |\n' +
          '| Site | [site](www.example.com) |\n| Doc | [rel](docs/guide.md) |'
      );
      const win = document.defaultView as any;
      const opened: string[] = [];
      const posted: unknown[] = [];
      setLinkHost((message) => posted.push(message));
      const original = win.HTMLAnchorElement.prototype.click;
      // The attribute as set, not the resolved .href, which would make the base URL
      // and a normalising trailing slash part of the assertion.
      win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
        opened.push(this.getAttribute('href') ?? '');
      };
      try {
        for (let r = 0; r < 3; r++) h.mousedown(h.cell(r, 1)!.querySelector('.tok-link')!, { metaKey: true });
      } finally {
        win.HTMLAnchorElement.prototype.click = original;
        setLinkHost(() => {});
      }
      h.view.destroy();
      return (
        // An address that resolves to a scheme is still the browser's to open, and
        // opens as exactly what it did before.
        opened.join('/') === 'mailto:someone@example.com/https://www.example.com' &&
        // A relative one means nothing inside the webview, so it goes to the host.
        // It used to become an anchor carrying `docs/guide.md`, which the browser
        // resolved against `vscode-webview://` and which therefore opened nothing.
        JSON.stringify(posted) === JSON.stringify([{ type: 'openLink', address: 'docs/guide.md' }])
      );
    })
  );

  results.push(
    await scenario('Enter during IME composition does not commit the cell', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      inp.value = 'にほ';
      h.keydown(inp, 'Enter', { isComposing: true });
      const stillEditing = !!h.input(0, 0);
      h.keydown(inp, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return stillEditing && doc === RAGGED.replace('| apple |', '| にほ  |');
    })
  );

  results.push(
    await scenario('copied cells carry pipes unescaped and paste back escaped once', async () => {
      const T = P + '| a | b |\n| - | - |\n| x \\| y | 2 |';
      const h = mount(T);
      h.mousedown(h.cell(0, 0)!);
      h.focusGrid();
      const { text } = h.clipboard('copy');
      h.mousedown(h.cell(0, 1)!);
      h.focusGrid();
      h.clipboard('paste', text);
      const doc = await h.commit();
      h.view.destroy();
      return text === 'x | y' && doc.split('\n')[4] === '| x \\| y | x \\| y |';
    })
  );

  const act = (h: Harness, r: number, c: number, label: string): boolean => {
    const action = tableActionsAt(h.cell(r, c))?.find((a) => a.label === label);
    action?.run();
    return !!action;
  };

  results.push(
    await scenario('table menu offers row and column actions', () => {
      const h = mount(RAGGED);
      const labels = (r: number, c: number): string => (tableActionsAt(h.cell(r, c)) ?? []).map((a) => a.label).join('|');
      const body = labels(0, 0);
      const header = labels(-1, 0);
      const outside = tableActionsAt(h.view.dom.querySelector('.cm-line'));
      h.view.destroy();
      return (
        body ===
          'Insert row above|Insert row below|Duplicate row|Move row down|Delete row|Insert column left|Insert column right|Duplicate column|Move column right|Delete column|Sort column A to Z|Sort column Z to A|Align column left|Align column center|Align column right|Pad columns to line up|Show as board' &&
        header ===
          'Insert row below|Insert column left|Insert column right|Duplicate column|Move column right|Delete column|Sort column A to Z|Sort column Z to A|Align column left|Align column center|Align column right|Pad columns to line up|Show as board' &&
        outside === null
      );
    })
  );

  results.push(
    await scenario('the menu draws its groups where it always did, and never opens on a rule', () => {
      // A separator belongs to the item under it, so these are the items each
      // group starts with. The groups are the registry's, and a group whose
      // commands cannot all run here hands its rule to the next one that can.
      const groups = (doc: string, r: number, c: number): string => {
        const h = mount(doc);
        const out = (tableActionsAt(h.cell(r, c)) ?? [])
          .filter((a) => a.separator)
          .map((a) => a.label)
          .join('|');
        h.view.destroy();
        return out;
      };
      const body = groups(RAGGED, 0, 0);
      // One body row: sorting drops out, and its rule falls through to alignment.
      const oneRow = groups(P + '| a | b |\n| - | - |\n| 1 | 2 |', 0, 0);
      // A data block keeps neither alignment nor padding, so it ends at sorting.
      const csv = groups(P + '```csv\nname,note\na,b\nc,d\n```', 0, 0);
      return (
        body === 'Insert column left|Sort column A to Z|Align column left|Pad columns to line up|Show as board' &&
        oneRow === 'Insert column left|Align column left|Pad columns to line up|Show as board' &&
        csv === 'Insert column left|Sort column A to Z'
      );
    })
  );

  results.push(
    await scenario('the menu offers the registry, in the registry order, and nothing else', () => {
      const ids = TABLE_COMMANDS.map((command) => command.id);
      const unique = new Set(ids).size === ids.length;
      // Every command the registry knows, reached from a table where each can run:
      // a body row in the middle of a pipe table whose column is aligned.
      const h = mount(P + '| a | b | c |\n| :- | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |');
      const labels = (tableActionsAt(h.cell(1, 1)) ?? []).map((a) => a.label);
      // The same table read from its header row, where the row commands drop out.
      const header = (tableActionsAt(h.cell(-1, 0)) ?? []).map((a) => a.label);
      h.view.destroy();
      const expected = [
        'Insert row above',
        'Insert row below',
        'Duplicate row',
        'Move row up',
        'Move row down',
        'Delete row',
        'Insert column left',
        'Insert column right',
        'Duplicate column',
        'Move column left',
        'Move column right',
        'Delete column',
        'Sort column A to Z',
        'Sort column Z to A',
        'Align column left',
        'Align column center',
        'Align column right',
        'Pad columns to line up',
        'Show as board',
      ];
      // From the header row the row commands drop out, and the first column has
      // nothing to its left to move into, but it carries an alignment to clear.
      const fromHeader = [
        'Insert row below',
        'Insert column left',
        'Insert column right',
        'Duplicate column',
        'Move column right',
        'Delete column',
        'Sort column A to Z',
        'Sort column Z to A',
        'Align column left',
        'Align column center',
        'Align column right',
        'Clear column alignment',
        'Pad columns to line up',
        'Show as board',
      ];
      // Twenty-three with the two width commands, which drop out of the right-click
      // menu here: this runner lays nothing out, so there is nothing to fit or reset.
      // Move to file is the other, and is offered only on a data block.
      return unique && ids.length === 23 && labels.join('|') === expected.join('|') && header.join('|') === fromHeader.join('|');
    })
  );

  results.push(
    await scenario('a command keeps the shape of the table it runs on, whatever that shape is', async () => {
      // One case per shape a real document puts a table in, all driven through the
      // registry, because the registry is what picks the function that writes.
      const LIST = 'Intro text.\n\n- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n  | 3 | 4 |\n\nAfter text.\n';
      const listed = mount(LIST);
      const ranListed = act(listed, 0, 1, 'Insert row below');
      const listedDoc = await listed.commit();
      listed.view.destroy();

      // A table without outer pipes, indented inside a list item: the new row has to
      // keep both the indent and the style, since a row is written from its own source.
      const BARE = 'Intro text.\n\n- item\n\n  a | b\n  --|--\n  1 | 2\n\nAfter text.\n';
      const bare = mount(BARE);
      const ranBare = act(bare, 0, 0, 'Insert row below');
      const bareDoc = await bare.commit();
      bare.view.destroy();
      const added = bareDoc.split('\n')[7] ?? '';

      // A table with only leading pipes: a new column keeps three cells on each line.
      const LEAD = P + '| a | b\n| - | -\n| 1 | 2';
      const lead = mount(LEAD);
      const ranLead = act(lead, 0, 1, 'Insert column right');
      const leadDoc = await lead.commit();
      lead.view.destroy();
      const leadLines = leadDoc.split('\n').slice(2, 5);
      const cells = (line: string): number => {
        let t = line.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
        return t.split(/(?<!\\)\|/).length;
      };
      return (
        ranListed &&
        listedDoc === LIST.replace('  | 1 | 2 |\n', '  | 1 | 2 |\n  |   |   |\n') &&
        ranBare &&
        added.startsWith('  ') &&
        added.includes('|') &&
        ranLead &&
        leadLines.every((l) => cells(l) === 3) &&
        leadLines[0].startsWith('| a | b') &&
        leadLines[2].startsWith('| 1 | 2')
      );
    })
  );

  results.push(
    await scenario('Insert row above adds one line above the row', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 1, 0, 'Insert row above');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === RAGGED.replace('| apple | 3 |\n', '| apple | 3 |\n|       |     |\n');
    })
  );

  results.push(
    await scenario('Duplicate row copies the source line exactly, through undo and redo', async () => {
      const h = mount(RAGGED, [history()]);
      const ran = act(h, 1, 0, 'Duplicate row');
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const rowsAfterUndo = h.root()!.querySelectorAll('tbody tr').length;
      h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });
      const doc = await h.commit();
      h.view.destroy();
      return ran && rowsAfterUndo === 2 && doc === RAGGED + '\n| kiwi fruit |12|';
    })
  );

  results.push(
    await scenario('Insert column left keeps every existing segment', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 0, 0, 'Insert column left');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '|     | Fruit | Qty |\n| --- |---|:-:|\n|     | apple | 3 |\n|     | kiwi fruit |12|';
    })
  );

  results.push(
    await scenario('grid exposes roles, selection and the active cell to assistive tech', () => {
      const h = mount(RAGGED);
      const grid = h.grid()!;
      const roles =
        grid.getAttribute('role') === 'grid' &&
        (grid.getAttribute('aria-label') ?? '').includes('Fruit') &&
        grid.getAttribute('aria-rowcount') === '3' &&
        grid.getAttribute('aria-colcount') === '2' &&
        h.cell(-1, 0)!.getAttribute('role') === 'columnheader' &&
        h.cell(0, 0)!.getAttribute('role') === 'gridcell' &&
        h.root()!.querySelector('.sheaf-table-gutter')!.getAttribute('aria-hidden') === 'true';
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 1)!, { shiftKey: true });
      const selected = h.root()!.querySelectorAll('[aria-selected="true"]').length;
      const active = grid.getAttribute('aria-activedescendant');
      // Shift-click grows the block and leaves the active cell where it started.
      const activeIsFocus = !!active && document.getElementById(active) === h.cell(0, 0);
      h.dblclick(h.cell(1, 1)!);
      const label = h.input(1, 1)?.getAttribute('aria-label') ?? '';
      h.view.destroy();
      return roles && selected === 4 && activeIsFocus && label.includes('Qty');
    })
  );

  results.push(
    await scenario('Escape twice leaves the grid for the line below', async () => {
      const T = RAGGED + '\n\nafter';
      const h = mount(T);
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'Escape'); // clears the selection
      const stillInGrid = document.activeElement === h.grid();
      h.keydown(h.grid()!, 'Escape'); // leaves
      const head = h.view.state.selection.main.head;
      const doc = await h.commit();
      h.view.destroy();
      return stillInGrid && head === RAGGED.length + 1 && doc === T;
    })
  );

  results.push(
    await scenario('right-click inside a row selection keeps it and refs every selected row', () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 1)!, { shiftKey: true });
      h.mousedown(h.cell(1, 0)!, { button: 2 }); // right-click inside the selection
      const kept = h.root()!.querySelectorAll('.is-sel').length;
      const range = tableRowSourceAt(h.cell(1, 0));
      const text = range ? h.view.state.sliceDoc(range.from, range.to) : null;
      h.view.destroy();
      const g = mount(RAGGED);
      g.mousedown(g.cell(0, 0)!);
      g.mousedown(g.cell(0, 1)!, { shiftKey: true });
      g.mousedown(g.cell(1, 1)!, { button: 2 }); // outside: the selection moves to the clicked cell
      const moved = g.root()!.querySelectorAll('.is-sel').length === 1 && g.cell(1, 1)!.classList.contains('is-focus');
      const single = tableRowSourceAt(g.cell(1, 1));
      const singleText = single ? g.view.state.sliceDoc(single.from, single.to) : null;
      g.view.destroy();
      return kept === 4 && text === '| apple | 3 |\n| kiwi fruit |12|' && moved && singleText === '| kiwi fruit |12|';
    })
  );

  const remote = (h: Harness, from: number, to: number, insert: string): void =>
    h.view.dispatch({ changes: { from, to, insert }, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
  const markedRows = (h: Harness): string[] =>
    Array.from(h.root()?.querySelectorAll('tr.is-changed') ?? []).map((tr) => (tr.textContent ?? '').replace(/^\d+/, ''));

  results.push(
    await scenario('an outside edit marks only the rows it changed', () => {
      const T = P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |';
      const h = mount(T);
      // One replacement spanning rows a to c, as the host's prefix/suffix diff sends it.
      const from = T.indexOf('1 |');
      const to = T.indexOf('3 |') + 1;
      remote(h, from, to, '9 |\n| b | 2 |\n| c | 8');
      const marked = markedRows(h);
      h.view.destroy();
      return marked.join('|') === 'a9|c8';
    })
  );

  results.push(
    await scenario('outside edits elsewhere and grid writes mark nothing', async () => {
      const T = RAGGED + '\n\nafter';
      const h = mount(T);
      remote(h, T.length, T.length, ' more');
      const afterOutside = markedRows(h).length;
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'pear';
      h.keydown(h.input(0, 0)!, 'Enter');
      await h.commit();
      const afterOwnWrite = markedRows(h).length;
      h.view.destroy();
      return afterOutside === 0 && afterOwnWrite === 0;
    })
  );

  // ---- Rows an outside write left marked --------------------------------------
  //
  // The marks prose lines get for what an agent or another editor wrote are line
  // decorations, and a grid replaces its table's lines, so the grid marks its own
  // rows from the same field.

  /** A write from outside the editor, dispatched the way the host applies one. */
  const arrive = (h: Harness, find: string, insert: string, nth = 0): void => {
    let from = -1;
    for (let i = 0; i <= nth; i++) from = h.doc().indexOf(find, from + 1);
    h.view.dispatch({
      changes: { from, to: from + find.length, insert },
      effects: outsideWrite.of(null),
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
  };
  /**
   * One letter per grid row, header first: A for a row the write inserted or
   * rewrote, D for a tick above it, B for a tick under it, and a dot for none.
   */
  const arrivedRows = (h: Harness): string =>
    Array.from(h.root()?.querySelectorAll('.sheaf-table-grid > table tr') ?? [])
      .map((tr) =>
        tr.classList.contains('sheaf-arrived')
          ? 'A'
          : tr.classList.contains('sheaf-arrived-deleted-below')
            ? 'B'
            : tr.classList.contains('sheaf-arrived-deleted')
              ? 'D'
              : '.'
      )
      .join('');
  const ROWS = P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |';
  /** Mount with the change marks, counting every transaction that changes the text after it is built. */
  const mountMarked = (doc: string): Harness & { writes: () => number } => {
    let writes = 0;
    const h = mount(doc, [changeMarks(), EditorView.updateListener.of((u) => void (u.docChanged && writes++))]);
    return Object.assign(h, { writes: () => writes });
  };

  results.push(
    await scenario('an outside write to one cell marks that row and nothing else', async () => {
      const h = mountMarked(ROWS);
      arrive(h, '| b | 2 |', '| b | 9 |');
      const marked = arrivedRows(h);
      const expected = ROWS.replace('| b | 2 |', '| b | 9 |');
      // Drawing the mark writes nothing: one transaction, the write itself, and the
      // text is what the write left, before and after the grid gives up focus.
      const doc = h.doc();
      const committed = await h.commit();
      const writes = h.writes();
      h.view.destroy();
      return marked === '..A.' && doc === expected && committed === expected && writes === 1;
    })
  );

  results.push(
    await scenario('an outside write to two rows marks both and the row between stays plain', () => {
      const h = mountMarked(ROWS);
      arrive(h, '1 |\n| b | 2 |\n| c | 3', '7 |\n| b | 2 |\n| c | 8');
      const marked = arrivedRows(h);
      h.view.destroy();
      return marked === '.A.A';
    })
  );

  results.push(
    await scenario('an outside write to the header row marks the header', () => {
      const h = mountMarked(ROWS);
      arrive(h, '| n | v |', '| N | v |');
      const marked = arrivedRows(h);
      h.view.destroy();
      return marked === 'A...';
    })
  );

  results.push(
    await scenario('an outside write that deletes a row ticks the row after it, or under the last', () => {
      const h = mountMarked(ROWS);
      arrive(h, '| b | 2 |\n', '');
      const middle = arrivedRows(h);
      h.view.destroy();
      const g = mountMarked(ROWS);
      arrive(g, '\n| c | 3 |', '');
      const last = arrivedRows(g);
      g.view.destroy();
      return middle === '..D' && last === '..B';
    })
  );

  results.push(
    await scenario('editing a marked row clears its mark and leaves another marked row alone', async () => {
      const h = mountMarked(ROWS);
      arrive(h, '1 |\n| b | 2 |\n| c | 3', '7 |\n| b | 2 |\n| c | 8');
      const before = arrivedRows(h);
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '5';
      h.keydown(h.input(0, 1)!, 'Enter');
      const doc = await h.commit();
      const after = arrivedRows(h);
      h.view.destroy();
      return before === '.A.A' && doc === ROWS.replace('| a | 1 |', '| a | 5 |').replace('| c | 3 |', '| c | 8 |') && after === '...A';
    })
  );

  results.push(
    await scenario('a later outside write adds its rows to the rows already marked', () => {
      const h = mountMarked(ROWS);
      arrive(h, '| a | 1 |', '| a | 7 |');
      const first = arrivedRows(h);
      arrive(h, '| c | 3 |', '| c | 8 |');
      const second = arrivedRows(h);
      h.view.destroy();
      return first === '.A..' && second === '.A.A';
    })
  );

  results.push(
    await scenario('an outside write marks the right row of a quoted table and of a table in a list item', () => {
      const quote = P + '> | n | v |\n> | - | - |\n> | a | 1 |\n> | b | 2 |\n\nAfter.';
      const q = mountMarked(quote);
      arrive(q, '> | b | 2 |', '> | b | 9 |');
      const quoted = arrivedRows(q);
      q.view.destroy();
      const item = '- item\n\n  | n | v |\n  | - | - |\n  | a | 1 |\n  | b | 2 |\n\n- next\n';
      const l = mountMarked(item);
      arrive(l, '  | a | 1 |', '  | a | 7 |');
      const listed = arrivedRows(l);
      l.view.destroy();
      return quoted === '..A' && listed === '.A.';
    })
  );

  results.push(
    await scenario('an outside write marks the record it changed in a CSV block', () => {
      const CSV = P + '```csv\nn,v\na,1\nb,2\nc,3\n```\n\nAfter.';
      const h = mountMarked(CSV);
      arrive(h, 'b,2', 'b,9');
      const changed = arrivedRows(h);
      h.view.destroy();
      // The last record taken away: the tick goes under the record now last.
      const g = mountMarked(CSV);
      arrive(g, 'c,3\n', '');
      const ticked = arrivedRows(g);
      g.view.destroy();
      return changed === '..A.' && ticked === '..B';
    })
  );

  results.push(
    await scenario('an outside write that takes away the lines after a table at the end ticks under its last row', () => {
      // The table's own text and place are untouched, so its grid is not rebuilt.
      const h = mountMarked(ROWS + '\n\nAfter.');
      arrive(h, '\n\nAfter.', '');
      const marked = arrivedRows(h);
      h.view.destroy();
      return marked === '...B';
    })
  );

  results.push(
    await scenario('an outside write elsewhere leaves a table unmarked, and moves no mark onto it', () => {
      const h = mountMarked('Intro.\n\n' + ROWS.slice(P.length) + '\n\nAfter.');
      arrive(h, 'Intro.', 'Intro, again.\nAnd more.');
      const above = arrivedRows(h);
      arrive(h, 'After.', 'Later.');
      const below = arrivedRows(h);
      h.view.destroy();
      return above === '....' && below === '....';
    })
  );

  results.push(
    await scenario('toolbar table insert opens the grid on its first header cell', async () => {
      const h = mount('.\n\npara');
      insertPipeTable(h.view);
      const opened = document.activeElement === h.grid() && h.root()?.querySelector('.is-focus')?.getAttribute('data-r') === '-1';
      h.keydown(h.grid()!, 'N');
      const doc = await h.commit();
      h.view.destroy();
      return (
        opened &&
        doc === '.\n\n| N        | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n\npara'
      );
    })
  );

  results.push(
    await scenario('toolbar table insert on the empty last line keeps the line break ending the file', async () => {
      const h = mount('Intro paragraph.\n');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      insertPipeTable(h.view);
      const doc = await h.commit();
      h.view.destroy();
      return doc === 'Intro paragraph.\n\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n';
    })
  );

  results.push(
    await scenario('toolbar table insert into an empty file adds no line break of its own', async () => {
      // Nothing was there, so there is no line break ending the file to keep.
      const h = mount('');
      insertPipeTable(h.view);
      const doc = await h.commit();
      h.view.destroy();
      return doc === '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';
    })
  );

  results.push(
    await scenario('toolbar table insert on a last line with no line break after it adds none', async () => {
      const h = mount('Intro paragraph.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      insertPipeTable(h.view);
      const doc = await h.commit();
      h.view.destroy();
      return doc === 'Intro paragraph.\n\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';
    })
  );

  results.push(
    await scenario('toolbar table insert keeps the text around it out of the table', async () => {
      const h = mount('.\n\nfirst\nsecond');
      h.view.dispatch({ selection: { anchor: '.\n\n'.length } }); // start of a line of text
      insertCsvTable(h.view);
      const rows = h.root()?.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return rows === 1 && doc === '.\n\nfirst\nsecond\n\n```csv\nColumn 1,Column 2,Column 3\nCell,Cell,Cell\n```';
    })
  );

  results.push(
    await scenario('the table menu opens from the keyboard and is keyboard navigable', () => {
      const h = mount(RAGGED);
      const copied: string[] = [];
      mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: (t) => copied.push(t) });
      const openMenu = (): HTMLElement | undefined =>
        Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).find((m) => !m.hidden);
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'ContextMenu');
      const menu = openMenu();
      const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>('.sheaf-ctx-item')) : [];
      const firstFocused = items.length > 1 && document.activeElement === items[0];
      h.keydown(document.activeElement!, 'ArrowDown');
      const secondFocused = document.activeElement === items[1];
      h.keydown(document.activeElement!, 'ArrowUp');
      h.keydown(document.activeElement!, 'Enter'); // Copy ref
      const closedAfterEnter = !openMenu();
      const backInGridAfterEnter = document.activeElement === h.grid();
      h.keydown(h.grid()!, 'F10', { shiftKey: true });
      const reopened = !!openMenu();
      // The browser's own event for the key arrives after ours, at the cell's position.
      h.grid()!.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      h.keydown(document.activeElement!, 'Escape');
      const closedByEscape = !openMenu() && document.activeElement === h.grid();
      h.view.destroy();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      return (
        !!menu &&
        firstFocused &&
        secondFocused &&
        copied[0] === 'doc.md:6 (Fruit, row 2)' + quoted('kiwi fruit') &&
        closedAfterEnter &&
        backInGridAfterEnter &&
        reopened &&
        closedByEscape
      );
    })
  );

  const NAV = P + '| a | b | c |\n| - | - | - |\n' + Array.from({ length: 30 }, (_, i) => `| r${i} | x | y |`).join('\n');
  const focusAt = (h: Harness): string | undefined => {
    const f = h.root()?.querySelector('.is-focus');
    return f ? `${f.getAttribute('data-r')},${f.getAttribute('data-c')}` : undefined;
  };

  results.push(
    await scenario('Home, End, Cmd-arrows and Page keys move within a table', () => {
      const h = mount(NAV);
      const g = (): HTMLElement => h.grid()!;
      h.mousedown(h.cell(5, 1)!);
      const seen: (string | undefined)[] = [];
      h.keydown(g(), 'Home');
      seen.push(focusAt(h));
      h.keydown(g(), 'End');
      seen.push(focusAt(h));
      h.keydown(g(), 'ArrowDown', { metaKey: true });
      seen.push(focusAt(h));
      h.keydown(g(), 'ArrowUp', { ctrlKey: true });
      seen.push(focusAt(h));
      h.keydown(g(), 'Home', { metaKey: true });
      seen.push(focusAt(h));
      h.keydown(g(), 'End', { metaKey: true });
      seen.push(focusAt(h));
      h.keydown(g(), 'PageUp');
      const afterPageUp = focusAt(h);
      h.keydown(g(), 'Home', { shiftKey: true });
      const extended = h.root()!.querySelectorAll('.is-sel').length;
      const stillInGrid = document.activeElement === g();
      h.view.destroy();
      return (
        seen.join(' ') === '5,0 5,2 29,2 -1,2 -1,0 29,2' &&
        afterPageUp !== '29,2' &&
        afterPageUp?.endsWith(',2') &&
        extended === 3 &&
        stillInGrid
      );
    })
  );

  results.push(
    await scenario('Shift+Space selects the row and Ctrl+Space the column, without editing', () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(1, 1)!);
      h.keydown(h.grid()!, ' ', { shiftKey: true });
      const row = h.root()!.querySelectorAll('.is-sel').length;
      const editingAfterRow = !!h.root()!.querySelector('.sheaf-table-input');
      h.keydown(h.grid()!, ' ', { ctrlKey: true });
      const column = h.root()!.querySelectorAll('.is-sel').length;
      const editingAfterColumn = !!h.root()!.querySelector('.sheaf-table-input');
      h.view.destroy();
      return row === 2 && column === 3 && !editingAfterRow && !editingAfterColumn;
    })
  );

  results.push(
    await scenario('Shift-click on a row number extends the row selection', () => {
      const h = mount(RAGGED);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[0]);
      h.mousedown(gutters[1], { shiftKey: true });
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      h.view.destroy();
      return selected === 4;
    })
  );

  results.push(
    await scenario('a second Cmd+A in a grid selects the whole document', () => {
      const h = mount(PIPE);
      h.mousedown(h.cell(0, 1)!);
      h.keydown(h.grid()!, 'a', { metaKey: true });
      const table = picked(h);
      h.keydown(h.grid()!, 'a', { metaKey: true });
      const after = picked(h);
      const sel = h.view.state.selection.main;
      const whole = sel.from === 0 && sel.to === h.view.state.doc.length;
      const stillGrid = !!h.root();
      h.view.destroy();
      return table === '-1,0 -1,1 -1,2 0,0 0,1 0,2 1,0 1,1 1,2' && after === '' && whole && stillGrid;
    })
  );

  results.push(
    await scenario('dragging out of an open cell editor becomes a cell range', async () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      h.mousedown(h.input(0, 0)!);
      mousemove(h.cell(1, 1)!);
      mouseup();
      const block = picked(h);
      const editing = !!h.root()!.querySelector('input, textarea');
      const doc = await h.commit();
      h.view.destroy();
      return block === '0,0 0,1 1,0 1,1' && !editing && doc === PIPE;
    })
  );

  results.push(
    await scenario('a drag out of an open cell ends on the cell the pointer was released over', () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      h.mousedown(h.input(0, 0)!);
      mousemove(h.cell(1, 2)!);
      // Closing the cell can move the columns under the pointer, so the release
      // settles the range on the cell it landed on rather than on the last one a
      // move reported.
      h.cell(1, 1)!.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      const block = picked(h);
      const active = activeCell(h);
      h.view.destroy();
      // The active cell stays on the cell the drag started in.
      return block === '0,0 0,1 1,0 1,1' && active === '0,0';
    })
  );

  results.push(
    await scenario('dragging inside an open cell editor keeps editing it', () => {
      const h = mount(PIPE);
      h.dblclick(h.cell(0, 0)!);
      const inp = h.input(0, 0)!;
      h.mousedown(inp);
      // Still over the open cell: this is the cell editor's own selection drag.
      mousemove(inp);
      const editing = !!h.root()!.querySelector('.sheaf-table-input');
      mouseup();
      h.view.destroy();
      return editing;
    })
  );

  results.push(
    await scenario('the row numbers and column headers the selection spans are marked', () => {
      const h = mount(PIPE);
      const marks = (sel: string): string =>
        Array.from(h.root()!.querySelectorAll(sel))
          .map((el) => (el.classList.contains('is-sel-axis') ? '1' : '0'))
          .join('');
      const both = (): string => `${marks('tbody .sheaf-table-gutter')} ${marks('thead th[data-c]')}`;
      dragCells(h, [0, 1], [1, 2]);
      const block = both();
      // A cell picked with Cmd-click brings its row and column in too.
      h.mousedown(h.cell(0, 0)!, { metaKey: true });
      const added = both();
      h.keydown(h.grid()!, 'Escape');
      const cleared = both();
      h.view.destroy();
      return block === '11 011' && added === '11 111' && cleared === '00 000';
    })
  );

  results.push(
    await scenario('Shift-clicking a header or a row number takes whole columns or rows', () => {
      const whole = '-1,0 -1,1 -1,2 0,0 0,1 0,2 1,0 1,1 1,2';
      // From one cell, Shift-clicking a header takes every column between, end to end.
      const a = mount(PIPE);
      a.mousedown(a.cell(0, 0)!);
      a.mousedown(a.cell(-1, 2)!, { shiftKey: true });
      const fromCell = picked(a);
      a.view.destroy();
      // From one header to another, the same columns.
      const b = mount(PIPE);
      b.mousedown(b.cell(-1, 0)!);
      b.mousedown(b.cell(-1, 2)!, { shiftKey: true });
      const fromHeader = picked(b);
      b.view.destroy();
      // From one cell, Shift-clicking a row number takes whole rows.
      const c = mount(PIPE);
      c.mousedown(c.cell(0, 1)!);
      c.mousedown(c.root()!.querySelectorAll('tbody .sheaf-table-gutter')[1], { shiftKey: true });
      const rows = picked(c);
      c.view.destroy();
      return fromCell === whole && fromHeader === whole && rows === '0,0 0,1 0,2 1,0 1,1 1,2';
    })
  );

  results.push(
    await scenario('paste fills a selection with one value and starts a block at its top-left', async () => {
      const a = mount(PIPE);
      a.mousedown(a.cell(0, 2)!);
      a.mousedown(a.cell(1, 2)!, { shiftKey: true });
      a.focusGrid();
      a.clipboard('paste', 'Z');
      const filled = (await a.commit()).split('\n').filter((l) => l.startsWith('|')).slice(2);
      a.view.destroy();
      const b = mount(PIPE);
      b.mousedown(b.cell(0, 1)!);
      b.mousedown(b.cell(1, 1)!, { shiftKey: true });
      b.focusGrid();
      b.clipboard('paste', '7\n8');
      const block = (await b.commit()).split('\n').filter((l) => l.startsWith('|')).slice(2);
      b.view.destroy();
      return filled.join('/') === '| 1 | 2 | Z |/| 4 | 5 | Z |' && block.join('/') === '| 1 | 7 | 3 |/| 4 | 8 | 6 |';
    })
  );

  results.push(
    await scenario('one value pasted over a column picked by its header fills the body and keeps the header', async () => {
      const a = mount(PIPE);
      a.mousedown(a.cell(-1, 1)!);
      a.focusGrid();
      a.clipboard('paste', 'Z');
      const column = await a.commit();
      a.view.destroy();
      // A header cell reached on its own, by arrowing up from the body, still takes the paste.
      const b = mount(PIPE);
      b.mousedown(b.cell(0, 1)!);
      b.focusGrid();
      b.keydown(b.grid()!, 'ArrowUp');
      b.clipboard('paste', 'Z');
      const header = await b.commit();
      b.view.destroy();
      return (
        column === P + '| A | B | C |\n| - | - | - |\n| 1 | Z | 3 |\n| 4 | Z | 6 |' &&
        header === P + '| A | Z | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'
      );
    })
  );

  results.push(
    await scenario('focus moving into the menu neither rebuilds the grid nor strands its focus', async () => {
      const h = mount(RAGGED);
      mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter'); // written to the document at once
      const grid = h.grid()!;
      grid.focus();
      h.keydown(grid, 'ContextMenu');
      await tick();
      await tick();
      const writtenWhileMenuOpen = h.doc() === RAGGED.replace('| apple |', '| X     |');
      const sameGrid = grid.isConnected;
      h.keydown(document.activeElement!, 'Escape');
      await tick();
      const focusBack = document.activeElement === grid;
      const doc = await h.commit();
      h.view.destroy();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      return writtenWhileMenuOpen && sameGrid && focusBack && doc === RAGGED.replace('| apple |', '| X     |');
    })
  );

  results.push(
    await scenario('row numbers and the corner name their file lines', () => {
      const h = mount(RAGGED);
      const gutters = (): HTMLElement[] => Array.from(h.root()!.querySelectorAll<HTMLElement>('tbody .sheaf-table-gutter'));
      const before = gutters().map((g) => g.title);
      const corner = h.root()!.querySelector<HTMLElement>('.sheaf-table-corner')!.title;
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click();
      const after = gutters().map((g) => g.title);
      h.view.destroy();
      return (
        before.join('|') === 'Select row (line 5)|Select row (line 6)' &&
        corner === 'Select whole table (header on line 3)' &&
        after.join('|') === 'Select row (line 5)|Select row (line 6)|Select row (line 7)'
      );
    })
  );

  results.push(
    await scenario('an outside change above a table keeps unsaved grid edits and the open cell', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter'); // an unsaved grid edit
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = 'typing'; // a cell still being typed into
      const grid = h.grid();
      remote(h, 0, 0, '# Agent\n\n');
      const sameGrid = h.grid() === grid;
      const inputKept = h.input(1, 1)?.value === 'typing';
      h.keydown(h.input(1, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return sameGrid && inputKept && doc === '# Agent\n\n' + RAGGED.replace('| apple |', '| X     |').replace('|12|', '|typing|');
    })
  );

  results.push(
    await scenario('a row number names its new line after the file changes above the table', async () => {
      const T = P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |';
      const h = mount(T);
      const titles = (): string[] =>
        Array.from(h.root()!.querySelectorAll('tbody .sheaf-table-gutter')).map((g) => (g as HTMLElement).title);
      const cornerTitle = (): string => (h.root()!.querySelector('.sheaf-table-corner') as HTMLElement).title;
      const before = titles().join('/');
      const cornerBefore = cornerTitle();
      // An agent, a pull or another editor adds two lines at the top of the file.
      remote(h, 0, 0, '# Agent\n\n');
      const after = titles().join('/');
      const cornerAfter = cornerTitle();
      h.view.destroy();
      return (
        before === 'Select row (line 5)/Select row (line 6)/Select row (line 7)' &&
        cornerBefore === 'Select whole table (header on line 3)' &&
        after === 'Select row (line 7)/Select row (line 8)/Select row (line 9)' &&
        cornerAfter === 'Select whole table (header on line 5)'
      );
    })
  );

  results.push(
    await scenario('an outside change to another row keeps unsaved cell edits and the open cell', async () => {
      const h = mount(RAGGED);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Tab');
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '4'; // still typing
      const at = RAGGED.indexOf('|12|') + 1;
      remote(h, at, at + 2, '13');
      const inputKept = h.input(0, 1)?.value === '4';
      const shows = h.cell(1, 1)?.textContent;
      h.keydown(h.input(0, 1)!, 'Tab');
      const doc = await h.commit();
      h.view.destroy();
      return inputKept && shows === '13' && doc === RAGGED.replace('| apple | 3 |', '| X     | 4 |').replace('|12|', '|13|');
    })
  );

  // A write from outside that takes back what was just typed, as the host sends one:
  // on the history as its own step, so Cmd+Z gives the typing back.
  const tookTyping = (h: Harness, text: string): void => {
    const e = minimalEdit(h.doc(), text);
    h.view.dispatch({
      changes: { from: e.start, to: e.end, insert: e.replacement },
      annotations: [Transaction.remote.of(true), isolateHistory.of('full')],
    });
  };

  results.push(
    await scenario('Cmd+Z in an open cell brings back typing that a write from outside took', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'pear';
      const typed = h.doc();
      tookTyping(h, RAGGED);
      const taken = h.doc() === RAGGED && !!h.input(0, 0);
      h.keydown(h.input(0, 0)!, 'z', { ctrlKey: true });
      const back = h.doc() === typed;
      const closed = !h.input(0, 0) && document.activeElement === h.grid() && h.cell(0, 0)?.textContent === 'pear';
      const doc = await h.commit();
      h.view.destroy();
      return taken && back && closed && doc === typed;
    })
  );

  results.push(
    await scenario('Cmd+Z in an open CSV field brings back typing that a write from outside took', async () => {
      const T = P + '```csv\nname,qty\napple,3\nkiwi,12\n```';
      const h = mount(T, [history()]);
      h.dblclick(h.cell(0, 0)!);
      const field = h.input(0, 0)!;
      field.value = 'pear';
      field.dispatchEvent(new G.Event('input', { bubbles: true }));
      const typed = h.doc();
      tookTyping(h, T);
      const taken = h.doc() === T && !!h.input(0, 0);
      h.keydown(h.input(0, 0)!, 'z', { ctrlKey: true });
      const back = h.doc() === typed;
      const closed = !h.input(0, 0) && document.activeElement === h.grid();
      h.view.destroy();
      return typed.includes('pear,3') && taken && back && closed;
    })
  );

  results.push(
    await scenario('Cmd+Z in a cell with typing of its own undoes that typing and keeps the cell open', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'pear';
      h.keydown(h.input(0, 0)!, 'z', { ctrlKey: true });
      const open = h.input(0, 0);
      const undone = open?.value === 'apple' && h.doc() === RAGGED;
      h.view.destroy();
      return !!open && undone;
    })
  );

  results.push(
    await scenario('an outside change inside a table after a row add keeps the added row', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click();
      const at = h.doc().indexOf('|12|') + 1;
      remote(h, at, at + 2, '13');
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return rows === 3 && doc === RAGGED.replace('| apple | 3 |\n', '| apple | 3 |\n|       |     |\n').replace('|12|', '|13|');
    })
  );

  // Row and column changes are written as they are made, so a write from outside
  // lands on a file that already holds them, and the grid takes what the file holds.
  const ABC = P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |';
  /** Write `text` in place of the document from outside, as the host sends the smallest edit. */
  const writeFromOutside = (h: Harness, text: string): void => {
    const e = minimalEdit(h.doc(), text);
    remote(h, e.start, e.end, e.replacement);
  };
  /** The grid's body cells, row by row, as "a1 b2". */
  const bodyShown = (h: Harness): string =>
    Array.from(h.root()!.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('[data-r]')).map((el) => el.textContent).join(''))
      .join(' ');

  results.push(
    await scenario('an outside cell edit in another row keeps a deleted row deleted', async () => {
      const h = mount(ABC);
      const ran = act(h, 1, 0, 'Delete row');
      writeFromOutside(h, h.doc().replace('| c | 3 |', '| c | 9 |'));
      const shown = bodyShown(h);
      const doc = await h.commit();
      h.view.destroy();
      return ran && shown === 'a1 c9' && doc === P + '| n | v |\n| - | - |\n| a | 1 |\n| c | 9 |';
    })
  );

  results.push(
    await scenario('an outside cell edit in another row keeps a duplicated row', async () => {
      const h = mount(ABC);
      const ran = act(h, 0, 0, 'Duplicate row');
      writeFromOutside(h, h.doc().replace('| c | 3 |', '| c | 9 |'));
      const shown = bodyShown(h);
      const doc = await h.commit();
      h.view.destroy();
      return ran && shown === 'a1 a1 b2 c9' && doc === P + '| n | v |\n| - | - |\n| a | 1 |\n| a | 1 |\n| b | 2 |\n| c | 9 |';
    })
  );

  results.push(
    await scenario('an outside cell edit keeps an added and a deleted column', async () => {
      const a = mount(ABC);
      const added = act(a, 0, 0, 'Insert column right');
      const withColumn = a.doc();
      writeFromOutside(a, withColumn.replace('| c |', '| C |'));
      const addShown = bodyShown(a);
      const addDoc = await a.commit();
      a.view.destroy();
      const d = mount(ABC);
      const deleted = act(d, 0, 1, 'Delete column');
      writeFromOutside(d, d.doc().replace('| c |', '| C |'));
      const delShown = bodyShown(d);
      const delDoc = await d.commit();
      d.view.destroy();
      return (
        added &&
        withColumn !== ABC &&
        addShown === 'a1 b2 C3' &&
        addDoc === withColumn.replace('| c |', '| C |') &&
        deleted &&
        delShown === 'a b C' &&
        delDoc === P + '| n |\n| - |\n| a |\n| b |\n| C |'
      );
    })
  );

  results.push(
    await scenario('an outside write that changes the row just deleted brings the row back as the file has it', async () => {
      const h = mount(ABC);
      act(h, 1, 0, 'Delete row');
      // Written from a copy of the file read before the delete, with that row changed.
      const stale = ABC.replace('| b | 2 |', '| b | 5 |');
      writeFromOutside(h, stale);
      const shown = bodyShown(h);
      const doc = await h.commit();
      h.view.destroy();
      return shown === 'a1 b5 c3' && doc === stale;
    })
  );

  results.push(
    await scenario('Move row down swaps two source lines and leaves the rest', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 0, 0, 'Move row down');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '| Fruit | Qty |\n|---|:-:|\n| kiwi fruit |12|\n| apple | 3 |';
    })
  );

  results.push(
    await scenario('Move column right permutes the cell segments of each line', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 0, 0, 'Move column right');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '| Qty | Fruit |\n|:-:|---|\n| 3 | apple |\n|12| kiwi fruit |';
    })
  );

  results.push(
    await scenario('Sort column orders rows numerically with empty cells last, and undoes', async () => {
      const T = P + '| n | v |\n| - | - |\n| a | 10 |\n| b |  |\n| c | 9 |';
      const a = mount(T);
      act(a, 0, 1, 'Sort column A to Z');
      const ascending = await a.commit();
      a.view.destroy();
      const b = mount(T);
      act(b, 0, 1, 'Sort column Z to A');
      const descending = await b.commit();
      b.view.destroy();
      const c = mount(T, [history()]);
      act(c, 0, 1, 'Sort column A to Z');
      c.keydown(c.grid()!, 'z', { metaKey: true });
      const undone = await c.commit();
      c.view.destroy();
      return (
        ascending === P + '| n | v |\n| - | - |\n| c | 9 |\n| a | 10 |\n| b |  |' &&
        descending === P + '| n | v |\n| - | - |\n| a | 10 |\n| c | 9 |\n| b |  |' &&
        undone === T
      );
    })
  );

  results.push(
    await scenario('Align column changes only the delimiter cell of that column', async () => {
      const a = mount(RAGGED);
      act(a, 0, 0, 'Align column right');
      const right = await a.commit();
      a.view.destroy();
      const b = mount(RAGGED);
      const cleared = act(b, 0, 1, 'Clear column alignment');
      const plain = await b.commit();
      b.view.destroy();
      const csv = mount(CSV);
      const csvLabels = (tableActionsAt(csv.cell(0, 0)) ?? []).map((x) => x.label);
      csv.view.destroy();
      return (
        right === RAGGED.replace('|---|:-:|', '|--:|:-:|') &&
        cleared &&
        plain === RAGGED.replace('|---|:-:|', '|---|---|') &&
        !csvLabels.some((l) => l.startsWith('Align'))
      );
    })
  );

  results.push(
    await scenario('undo after an outside change reverts the visit edit and keeps the outside change', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Tab');
      const at = RAGGED.indexOf('|12|') + 1;
      remote(h, at, at + 2, '13');
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const shownAfterUndo = `${h.cell(0, 0)?.textContent},${h.cell(1, 1)?.textContent}`;
      h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });
      const shownAfterRedo = h.cell(0, 0)?.textContent;
      const doc = await h.commit();
      h.view.destroy();
      return shownAfterUndo === 'apple,13' && shownAfterRedo === 'X' && doc === RAGGED.replace('| apple |', '| X     |').replace('|12|', '|13|');
    })
  );

  const pasteInto = (h: Harness, text: string): void => {
    const store: Record<string, string> = { 'text/plain': text };
    const e = new G.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => store[t] ?? '', setData: () => {} } });
    h.view.contentDOM.dispatchEvent(e);
  };

  results.push(
    await scenario('a spreadsheet range pasted into prose becomes a table opened as a grid', async () => {
      const h = mount('.\n\nIntro.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Name\tQty\napple\t3\nkiwi | green\t12\n');
      const opened = document.activeElement === h.grid() && h.root()?.querySelector('.is-focus')?.getAttribute('data-r') === '-1';
      const doc = await h.commit();
      h.view.destroy();
      return (
        opened &&
        doc === '.\n\nIntro.\n\n| Name          | Qty |\n| ------------- | --: |\n| apple         | 3   |\n| kiwi \\| green | 12  |'
      );
    })
  );

  results.push(
    await scenario('a spreadsheet cell holding a line break pastes into prose as one cell of the table', async () => {
      // A spreadsheet puts a cell with a line break in quotes on the clipboard, so
      // the quoted run is one cell even though a line break sits inside it.
      const h = mount('.\n\nIntro.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Name\tNote\nfig\t"line one\nline two"\napple\tok\n');
      const grid = !!h.root();
      const doc = await h.commit();
      h.view.destroy();
      return grid && doc === '.\n\nIntro.\n\n| Name  | Note              |\n| ----- | ----------------- |\n| fig   | line one line two |\n| apple | ok                |';
    })
  );

  results.push(
    await scenario('a range pasted into prose keeps quotes that wrap a value on one line', async () => {
      const h = mount('.\n\nIntro.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Name\tSays\nfig\t"hello"\napple\tok');
      const doc = await h.commit();
      h.view.destroy();
      return doc === '.\n\nIntro.\n\n| Name  | Says    |\n| ----- | ------- |\n| fig   | "hello" |\n| apple | ok      |';
    })
  );

  results.push(
    await scenario('a pasted column of amounts is right-aligned, as a column of bare numbers is', async () => {
      const h = mount('.\n\nIntro.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Item\tCost\tQty\napple\t$4.50\t3\nkiwi\t$12.00\t12');
      const doc = await h.commit();
      h.view.destroy();
      return (
        doc ===
        '.\n\nIntro.\n\n| Item  | Cost   | Qty |\n| ----- | -----: | --: |\n| apple | $4.50  | 3   |\n| kiwi  | $12.00 | 12  |'
      );
    })
  );

  results.push(
    await scenario('a pasted column of text that merely starts with a number stays left-aligned', async () => {
      const h = mount('.\n\nIntro.');
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Step\tWhen\none\t3 days\ntwo\t12 days');
      const doc = await h.commit();
      h.view.destroy();
      return doc === '.\n\nIntro.\n\n| Step | When    |\n| ---- | ------- |\n| one  | 3 days  |\n| two  | 12 days |';
    })
  );

  results.push(
    await scenario('a range pasted over selected text replaces it, and one undo brings it back', async () => {
      const source = '.\n\nKeep this word.';
      const h = mount(source, [history()]);
      const from = '.\n\nKeep '.length;
      h.view.dispatch({ selection: { anchor: from, head: from + 'this '.length } });
      pasteInto(h, 'p\tq\n5\t6');
      const doc = h.doc();
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const undone = h.doc();
      h.view.destroy();
      return doc === '.\n\nKeep word.\n\n| p   | q   |\n| --: | --: |\n| 5   | 6   |' && undone === source;
    })
  );

  results.push(
    await scenario('pasting plain text or pasting into code is left to the editor', () => {
      const a = mount('.\n\nIntro.');
      a.view.dispatch({ selection: { anchor: a.view.state.doc.length } });
      pasteInto(a, 'just words');
      pasteInto(a, 'one\ttab only');
      const plain = !a.root();
      a.view.destroy();
      const b = mount('```\ncode here\n```');
      b.view.dispatch({ selection: { anchor: 6 } });
      pasteInto(b, 'a\tb\nc\td');
      const inCode = !b.root();
      b.view.destroy();
      return plain && inCode;
    })
  );

  results.push(
    await scenario('an unsaved alignment change survives an outside change to another row', async () => {
      const h = mount(RAGGED);
      act(h, 0, 0, 'Align column right');
      const at = RAGGED.indexOf('|12|') + 1;
      remote(h, at, at + 2, '13');
      const rendered = h.cell(0, 0)?.style.textAlign;
      const doc = await h.commit();
      h.view.destroy();
      return rendered === 'right' && doc === RAGGED.replace('|---|:-:|', '|--:|:-:|').replace('|12|', '|13|');
    })
  );

  results.push(
    await scenario('a range pasted on the blank line between two tables stays its own table', async () => {
      const T1 = '| a | b |\n| - | - |\n| 1 | 2 |';
      const T2 = '| x | y |\n| - | - |\n| 3 | 4 |';
      const h = mount(P + T1 + '\n\n' + T2);
      h.view.dispatch({ selection: { anchor: P.length + T1.length + 1 } }); // the blank line between
      pasteInto(h, 'p\tq\n5\t6');
      const tables = h.view.dom.querySelectorAll('.sheaf-table').length;
      const doc = await h.commit();
      h.view.destroy();
      return tables === 3 && doc === P + T1 + '\n\n| p   | q   |\n| --: | --: |\n| 5   | 6   |\n\n' + T2;
    })
  );

  results.push(
    await scenario('undo right after pasting a table returns focus to the text', () => {
      const h = mount('.\n\nIntro.', [history()]);
      h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
      pasteInto(h, 'Site\tVisits\nNorth\t12');
      const pasted = !!h.root();
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const gone = !h.root();
      const focusInTable = !!document.activeElement?.closest?.('.sheaf-table');
      const doc = h.doc();
      h.view.destroy();
      return pasted && gone && !focusInTable && doc === '.\n\nIntro.';
    })
  );

  results.push(
    await scenario('Duplicate column copies every segment of the column byte for byte', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 0, 0, 'Duplicate column');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '| Fruit | Fruit | Qty |\n|---|---|:-:|\n| apple | apple | 3 |\n| kiwi fruit | kiwi fruit |12|';
    })
  );

  results.push(
    await scenario('a context menu inside a cell editor is left to the text field', () => {
      const h = mount(RAGGED);
      mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      input.focus();
      const e = new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 });
      input.dispatchEvent(e);
      const menuOpen = Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).some((m) => !m.hidden);
      const stillEditing = document.activeElement === input;
      h.view.destroy();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      return !e.defaultPrevented && !menuOpen && stillEditing;
    })
  );

  results.push(
    await scenario('a table menu opened by touch does not take focus', () => {
      const h = mount(RAGGED);
      mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      h.mousedown(h.cell(1, 0)!);
      const e = new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30 });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      h.cell(1, 0)!.dispatchEvent(e);
      const menuOpen = Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).some((m) => !m.hidden);
      const focusStays = document.activeElement === h.grid();
      h.view.destroy();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      return menuOpen && focusStays;
    })
  );

  // A tap is what a touch screen sends for one finger down and up: the pointer and
  // touch events first, then the mouse events the browser makes from them, all at
  // the element under the finger. The grid reads the cell from those, so the tapped
  // cell is the one picked, and a tap on another cell moves there without opening it.
  results.push(
    await scenario('a tap selects the tapped cell, and a second tap on another cell moves there without opening it', () => {
      const h = mount(RAGGED);
      const tap = (el: Element): void => {
        const at = { bubbles: true, cancelable: true, clientX: 10, clientY: 10 };
        const pointer = (type: string): void => {
          const e = new G.MouseEvent(type, { ...at, button: 0 });
          Object.defineProperty(e, 'pointerType', { value: 'touch' });
          el.dispatchEvent(e);
        };
        // The runner's DOM has no TouchEvent constructor; a plain event of the same
        // type reaches the same listeners.
        pointer('pointerdown');
        el.dispatchEvent(new G.Event('touchstart', { bubbles: true, cancelable: true }));
        pointer('pointerup');
        el.dispatchEvent(new G.Event('touchend', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new G.MouseEvent('mousemove', { ...at, buttons: 0 }));
        el.dispatchEvent(new G.MouseEvent('mousedown', { ...at, button: 0, buttons: 1, detail: 1 }));
        el.dispatchEvent(new G.MouseEvent('mouseup', { ...at, button: 0, buttons: 0, detail: 1 }));
        el.dispatchEvent(new G.MouseEvent('click', { ...at, button: 0, detail: 1 }));
      };
      tap(h.cell(1, 1)!);
      const first = { focus: activeCell(h), sel: picked(h), inGrid: document.activeElement === h.grid() };
      tap(h.cell(0, 0)!);
      const second = { focus: activeCell(h), sel: picked(h), inGrid: document.activeElement === h.grid() };
      const open = !!h.root()!.querySelector('.sheaf-table-input');
      const doc = h.doc();
      h.view.destroy();
      const ok =
        first.focus === '1,1' && first.sel === '1,1' && first.inGrid &&
        second.focus === '0,0' && second.sel === '0,0' && second.inGrid && !open && doc === RAGGED;
      // Say what the grid picked, since "assertion failed" does not.
      if (!ok) throw new Error(JSON.stringify({ first, second, open }));
      return ok;
    })
  );

  const PADDED = P + '| Fruit      | Qty |\n| ---------- | :-: |\n| apple      | 3   |\n| kiwi fruit | 12  |';

  results.push(
    await scenario('Pad columns to line up rewrites the table padded and keeps alignment', async () => {
      const h = mount(RAGGED);
      const ran = act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      const csv = mount(CSV);
      const csvOffered = (tableActionsAt(csv.cell(0, 0)) ?? []).some((a) => a.label === 'Pad columns to line up');
      csv.view.destroy();
      return ran && doc === PADDED && !csvOffered;
    })
  );
  results.push(
    await scenario('Pad columns keeps an indented table indented', async () => {
      const h = mount(P + '   | a | bbbb |\n   |-|-|\n   | ccc | d |');
      const ran = act(h, 0, 0, 'Pad columns to line up');
      const doc = h.doc();
      h.view.destroy();
      return ran && doc === P + '   | a   | bbbb |\n   | --- | ---- |\n   | ccc | d    |';
    })
  );
  results.push(
    await scenario('Pad columns keeps a table inside a list item in the item', async () => {
      const src = '- **Item.** Text:\n\n  | Old | New |\n  | --- | --- |\n  | View type `nib.wysiwyg` | `sheaf.wysiwyg` |\n\n  More text.\n';
      const h = mount(src);
      const ran = act(h, 0, 0, 'Pad columns to line up');
      const doc = h.doc();
      h.view.destroy();
      return (
        ran &&
        doc ===
          '- **Item.** Text:\n\n  | Old                     | New             |\n  | ----------------------- | --------------- |\n  | View type `nib.wysiwyg` | `sheaf.wysiwyg` |\n\n  More text.\n'
      );
    })
  );

  results.push(
    await scenario('Pad columns after an unsaved edit is its own undo step and the grid stays editable', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'pear';
      h.keydown(h.input(0, 0)!, 'Tab');
      act(h, 0, 0, 'Pad columns to line up');
      const padded = h.doc();
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = '13';
      h.keydown(h.input(1, 1)!, 'Tab');
      const edited = await h.commit();
      undo(h.view);
      const afterOneUndo = h.doc();
      undo(h.view);
      const afterTwoUndos = h.doc();
      h.view.destroy();
      return (
        padded === PADDED.replace('| apple      |', '| pear       |') &&
        edited === padded.replace('| 12  |', '| 13  |') &&
        afterOneUndo === padded &&
        afterTwoUndos === RAGGED.replace('| apple |', '| pear  |')
      );
    })
  );

  results.push(
    await scenario('an outside change that only re-pads a table leaves the next edit intact', async () => {
      const h = mount(RAGGED);
      remote(h, P.length, RAGGED.length, PADDED.slice(P.length)); // same cells, new padding and length
      h.dblclick(h.cell(1, 1)!);
      h.input(1, 1)!.value = '13';
      h.keydown(h.input(1, 1)!, 'Tab');
      const doc = await h.commit();
      h.view.destroy();
      return doc === PADDED.replace('| 12  |', '| 13  |');
    })
  );

  const T4 = P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |';
  const dragRow = async (h: Harness, from: number, over: number, show?: (h: Harness) => void): Promise<string> => {
    const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
    // A row number moves its row only once that row is selected: the first click
    // selects it, and the press that follows is the one that drags.
    h.mousedown(gutters[from], { clientY: 10 });
    mouseup({ clientY: 10 });
    h.mousedown(gutters[from], { clientY: 10 });
    const target = h.cell(over, 1)!;
    target.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 60 }));
    show?.(h);
    document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 60 }));
    return h.commit();
  };

  results.push(
    await scenario('dragging a row number moves the row and writes only the permutation', async () => {
      let marked = '';
      const h = mount(T4);
      const doc = await dragRow(h, 0, 2, (x) => {
        marked = `${x.root()!.querySelector('tr.is-row-dragging td[data-r]')?.textContent}>${x.root()!.querySelector('tr.is-drop-after td[data-r]')?.textContent}`;
      });
      h.view.destroy();
      const up = mount(T4);
      const docUp = await dragRow(up, 3, 1);
      up.view.destroy();
      return (
        marked === 'a>c' &&
        doc === P + '| n | v |\n| - | - |\n| b | 2 |\n| c | 3 |\n| a | 1 |\n| d | 4 |' &&
        docUp === P + '| n | v |\n| - | - |\n| a | 1 |\n| d | 4 |\n| b | 2 |\n| c | 3 |'
      );
    })
  );

  results.push(
    await scenario('a row-number click without dragging still just selects the row', async () => {
      const h = mount(T4);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[1], { clientY: 10 });
      gutters[1].dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 11 }));
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 11 }));
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      const doc = await h.commit();
      h.view.destroy();
      return selected === 2 && doc === T4;
    })
  );

  results.push(
    await scenario('Pad columns counts wide characters as two columns', async () => {
      const h = mount(P + '| 名前 | note |\n| - | - |\n| 東京 | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| 名前  | note |\n| ----- | ---- |\n| 東京  | a    |\n| Kyoto | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns counts an emoji from outside the pictograph block as two columns', async () => {
      // A white heavy check mark is a Dingbat and a star is a miscellaneous symbol,
      // and both are drawn two columns wide.
      const h = mount(P + '| flag | note |\n| - | - |\n| ✅⭐✅ | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| flag   | note |\n| ------ | ---- |\n| ✅⭐✅ | a    |\n| Kyoto  | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns counts a combining mark as no columns at all', async () => {
      // Montréal written as an e followed by a combining acute accent: eight columns.
      const h = mount(P + '| city | note |\n| - | - |\n| Montréal | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| city     | note |\n| -------- | ---- |\n| Montréal | a    |\n| Kyoto    | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns counts a heart and its variation selector as one two-column emoji', async () => {
      // A heart is one column on its own, and the selector after it asks for the
      // emoji, which is two. The pair is two columns, not three and not one.
      const h = mount(P + '| mood | note |\n| - | - |\n| ❤️❤️❤️ | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| mood   | note |\n| ------ | ---- |\n| ❤️❤️❤️ | a    |\n| Kyoto  | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns still lines a pictograph up beside wide CJK text', async () => {
      const h = mount(P + '| fruit | note |\n| - | - |\n| 🍎🍎 | a |\n| 名前東京 | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| fruit    | note |\n| -------- | ---- |\n| 🍎🍎     | a    |\n| 名前東京 | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns counts a family emoji and a flag as two columns each', async () => {
      // A family is three people joined into one picture, and a flag is two
      // regional letters drawn as one. Each is a single two-column emoji.
      const h = mount(P + '| who | note |\n| - | - |\n| 👨‍👩‍👧🇯🇵 | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| who   | note |\n| ----- | ---- |\n| 👨‍👩‍👧🇯🇵  | a    |\n| Kyoto | bb   |';
    })
  );

  results.push(
    await scenario('Pad columns counts an emoji with a skin tone as one two-column emoji', async () => {
      // A thumbs up with a skin tone, and a technologist with a skin tone joined to
      // a laptop: two emoji, four columns.
      const h = mount(P + '| who | note |\n| - | - |\n| 👍🏽👩🏽‍💻 | a |\n| Kyoto | bb |');
      act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| who   | note |\n| ----- | ---- |\n| 👍🏽👩🏽‍💻  | a    |\n| Kyoto | bb   |';
    })
  );

  const C3 = P + '| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |';

  results.push(
    await scenario('dragging a column header moves the column and permutes its segments', async () => {
      let marked = '';
      const h = mount(C3);
      // As with a row number, a header moves its column only once it is selected.
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      mouseup({ clientX: 10 });
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      mousemove(h.cell(-1, 2)!, { clientX: 90 });
      marked = `${h.root()!.querySelector('th.is-col-dragging')?.textContent}>${h.root()!.querySelector('th.is-col-drop-after')?.textContent}`;
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 90 }));
      const doc = await h.commit();
      h.view.destroy();
      return marked === 'a>c' && doc === P + '| b | c | a |\n|:-:|--:|---|\n| 2 | 3 | 1 |';
    })
  );

  results.push(
    await scenario('a header click without dragging still selects the column', async () => {
      const h = mount(C3);
      h.mousedown(h.cell(-1, 1)!, { clientX: 40 });
      h.cell(-1, 1)!.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 41 }));
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 41 }));
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      const doc = await h.commit();
      h.view.destroy();
      return selected === 2 && doc === C3;
    })
  );

  results.push(
    await scenario('dragging a header inside a selection moves every selected column', async () => {
      const h = mount(C3);
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      mouseup({ clientX: 10 });
      h.mousedown(h.cell(-1, 1)!, { clientX: 40, shiftKey: true });
      mouseup({ clientX: 40 });
      // Columns a and b are both selected now, so grabbing either header carries both.
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      mousemove(h.cell(-1, 2)!, { clientX: 90 });
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 90 }));
      const after = picked(h);
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| c | a | b |\n|--:|---|:-:|\n| 3 | 1 | 2 |' && after === '-1,1 -1,2 0,1 0,2';
    })
  );

  results.push(
    await scenario('dragging across unselected row numbers selects those rows and moves nothing', async () => {
      const h = mount(T4);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[0], { clientY: 10 });
      mousemove(h.cell(2, 0)!, { clientY: 60 });
      mouseup({ clientY: 60 });
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      const doc = await h.commit();
      h.view.destroy();
      // Rows 0 to 2 of a two-column table, and the rows stay in the order they were.
      return selected === 6 && doc === T4;
    })
  );

  results.push(
    await scenario('dragging across unselected column headers selects those columns and moves nothing', async () => {
      const h = mount(C3);
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      mousemove(h.cell(-1, 2)!, { clientX: 90 });
      mouseup({ clientX: 90 });
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      const doc = await h.commit();
      h.view.destroy();
      // Three columns, header row and one body row, and the columns stay in order.
      return selected === 6 && doc === C3;
    })
  );

  results.push(
    await scenario('dragging a row number inside a selection moves every selected row', async () => {
      const h = mount(T4);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[0], { clientY: 10 });
      mouseup({ clientY: 10 });
      h.mousedown(gutters[1], { clientY: 30, shiftKey: true });
      mouseup({ clientY: 30 });
      // Rows a and b are both selected now, so grabbing either row number carries both.
      h.mousedown(gutters[0], { clientY: 10 });
      mousemove(h.cell(3, 1)!, { clientY: 90 });
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 90 }));
      const after = picked(h);
      const doc = await h.commit();
      h.view.destroy();
      return (
        doc === P + '| n | v |\n| - | - |\n| c | 3 |\n| d | 4 |\n| a | 1 |\n| b | 2 |' &&
        after === '2,0 2,1 3,0 3,1'
      );
    })
  );

  results.push(
    await scenario('a selection of rows dragged upwards lands where it was dropped, in order', async () => {
      const h = mount(T4);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[1], { clientY: 30 });
      mouseup({ clientY: 30 });
      h.mousedown(gutters[2], { clientY: 60, shiftKey: true });
      mouseup({ clientY: 60 });
      // Grabbed by the lower of the two row numbers, which is still inside the selection.
      h.mousedown(gutters[2], { clientY: 60 });
      mousemove(h.cell(0, 1)!, { clientY: 10 });
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 10 }));
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| n | v |\n| - | - |\n| b | 2 |\n| c | 3 |\n| a | 1 |\n| d | 4 |';
    })
  );

  results.push(
    await scenario('a press on a selected row number that never moves narrows the selection to that row', async () => {
      const h = mount(T4);
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter');
      h.mousedown(gutters[0], { clientY: 10 });
      mouseup({ clientY: 10 });
      h.mousedown(gutters[1], { clientY: 30, shiftKey: true });
      mouseup({ clientY: 30 });
      const both = picked(h);
      h.mousedown(gutters[1], { clientY: 30 });
      mouseup({ clientY: 30 });
      const one = picked(h);
      const doc = await h.commit();
      h.view.destroy();
      return both === '0,0 0,1 1,0 1,1' && one === '1,0 1,1' && doc === T4;
    })
  );

  results.push(
    await scenario('only a selected row number or header offers to move its row or column', async () => {
      const h = mount(T4);
      const gutters = (): boolean[] =>
        Array.from(h.root()!.querySelectorAll('tbody .sheaf-table-gutter')).map((el) => el.classList.contains('is-sel-whole'));
      const headers = (): boolean[] =>
        Array.from(h.root()!.querySelectorAll('thead th[data-c]')).map((el) => el.classList.contains('is-sel-whole'));
      const fresh = gutters().some(Boolean) || headers().some(Boolean);
      h.mousedown(h.root()!.querySelectorAll('tbody .sheaf-table-gutter')[1]);
      mouseup();
      const rowPicked = gutters().join() === 'false,true,false,false' && !headers().some(Boolean);
      h.mousedown(h.cell(-1, 1)!);
      mouseup();
      const colPicked = headers().join() === 'false,true' && !gutters().some(Boolean);
      // A cell selection covers no whole row or column, so nothing offers a move.
      h.mousedown(h.cell(2, 0)!);
      mouseup();
      const cellOnly = gutters().some(Boolean) || headers().some(Boolean);
      h.view.destroy();
      return !fresh && rowPicked && colPicked && !cellOnly;
    })
  );

  results.push(
    await scenario('Alt+arrows move the active row and column', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { altKey: true });
      h.keydown(h.grid()!, 'ArrowRight', { altKey: true });
      const focus = h.root()!.querySelector('.is-focus');
      const at = `${focus?.getAttribute('data-r')},${focus?.getAttribute('data-c')}`;
      const doc = await h.commit();
      h.view.destroy();
      const top = mount(T4);
      top.mousedown(top.cell(-1, 0)!);
      top.keydown(top.grid()!, 'ArrowUp', { altKey: true });
      const stayed = document.activeElement === top.grid();
      const unchanged = (await top.commit()) === T4;
      top.view.destroy();
      return (
        at === '2,1' &&
        doc === P + '| v | n |\n| - | - |\n| 1 | a |\n| 3 | c |\n| 2 | b |\n| 4 | d |' &&
        stayed &&
        unchanged
      );
    })
  );
  results.push(
    await scenario('Alt+arrows move a selected block of rows or columns together', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      h.keydown(h.grid()!, 'ArrowDown', { altKey: true });
      const at = focusAt(h);
      const selRows = [...new Set([...h.root()!.querySelectorAll('.is-sel')].map((el) => el.getAttribute('data-r')))].join();
      const rows = await h.commit();
      h.view.destroy();
      const W = P + '| x | y | z |\n| - | - | - |\n| 1 | 2 | 3 |';
      const w = mount(W);
      w.mousedown(w.cell(-1, 0)!);
      w.keydown(w.grid()!, 'ArrowRight', { shiftKey: true });
      w.keydown(w.grid()!, 'ArrowRight', { altKey: true });
      const colAt = focusAt(w);
      const cols = await w.commit();
      w.view.destroy();
      // The active cell stayed on the block's first row and moved down with it.
      return (
        at === '1,0' &&
        selRows === '1,2' &&
        rows === P + '| n | v |\n| - | - |\n| c | 3 |\n| a | 1 |\n| b | 2 |\n| d | 4 |' &&
        colAt === '-1,2' &&
        cols === P + '| z | x | y |\n| - | - | - |\n| 3 | 1 | 2 |'
      );
    })
  );
  results.push(
    await scenario('menu moves act on the selection they were opened in', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      const plural = act(h, 1, 0, 'Move rows down');
      const at = focusAt(h);
      const rows = await h.commit();
      h.view.destroy();
      const o = mount(T4);
      o.mousedown(o.cell(0, 0)!);
      o.keydown(o.grid()!, 'ArrowDown', { shiftKey: true });
      const outside = act(o, 3, 0, 'Move row up');
      const single = await o.commit();
      o.view.destroy();
      return (
        plural &&
        at === '1,0' &&
        rows === P + '| n | v |\n| - | - |\n| c | 3 |\n| a | 1 |\n| b | 2 |\n| d | 4 |' &&
        outside &&
        single === P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| d | 4 |\n| c | 3 |'
      );
    })
  );
  results.push(
    await scenario('menu delete and duplicate act on the selection they were opened in', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      const dup = act(h, 1, 0, 'Duplicate rows');
      const afterDup = focusAt(h);
      const dupDoc = await h.commit();
      h.view.destroy();
      const d = mount(T4);
      d.mousedown(d.cell(1, 0)!);
      d.keydown(d.grid()!, 'ArrowDown', { shiftKey: true });
      const del = act(d, 2, 0, 'Delete rows');
      const delDoc = await d.commit();
      d.view.destroy();
      const w = mount(P + '| x | y | z |\n| - | - | - |\n| 1 | 2 | 3 |');
      w.mousedown(w.cell(-1, 0)!);
      w.keydown(w.grid()!, 'ArrowRight', { shiftKey: true });
      const delCols = act(w, -1, 1, 'Delete columns');
      const colsDoc = await w.commit();
      w.view.destroy();
      return (
        dup &&
        del &&
        delCols &&
        afterDup === '4,0' &&
        dupDoc === P + '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| b | 2 |\n| c | 3 |\n| d | 4 |' &&
        delDoc === P + '| n | v |\n| - | - |\n| a | 1 |\n| d | 4 |' &&
        colsDoc === P + '| z |\n| - |\n| 3 |'
      );
    })
  );
  results.push(
    await scenario('Alt+F10 reaches the bar, the arrows walk it, and Escape hands the cell back', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      h.mousedown(h.cell(1, 1)!);
      const wasActive = h.grid()!.getAttribute('aria-activedescendant');
      // One tab stop, as a toolbar has, with the arrows moving inside it.
      const stops = Array.from(h.view.dom.querySelectorAll('.sheaf-table-ctrl')) as HTMLButtonElement[];
      const oneStop = stops.filter((b) => b.tabIndex === 0).length === 1;
      const labelled = h.view.dom.querySelector('.sheaf-table-controls')!.getAttribute('role') === 'toolbar';

      h.keydown(h.grid()!, 'F10', { altKey: true });
      const onBar = document.activeElement === stops[0];
      h.keydown(document.activeElement!, 'ArrowRight');
      const moved = document.activeElement === stops[1];
      h.keydown(document.activeElement!, 'End');
      const atEnd = document.activeElement === stops[stops.length - 1];
      h.keydown(document.activeElement!, 'Escape');
      const back = document.activeElement === h.grid();
      const stillActive = h.grid()!.getAttribute('aria-activedescendant');
      h.view.destroy();
      return oneStop && labelled && onBar && moved && atEnd && back && !!wasActive && stillActive === wasActive;
    })
  );

  results.push(
    await scenario('Alt+F10 goes on from the bar to the active column chevron, and back to the cell', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      h.mousedown(h.cell(1, 1)!);
      const col = h.root()!.querySelector('thead th[data-c="1"] > .sheaf-table-chevron');
      const seen: boolean[] = [];
      h.keydown(h.grid()!, 'F10', { altKey: true });
      seen.push(!!document.activeElement?.classList.contains('sheaf-table-ctrl'));
      h.keydown(document.activeElement!, 'F10', { altKey: true });
      seen.push(document.activeElement === col);
      h.keydown(document.activeElement!, 'F10', { altKey: true });
      seen.push(document.activeElement === h.grid());
      h.view.destroy();
      return seen.every(Boolean);
    })
  );

  results.push(
    await scenario('a menu takes the keyboard, the arrows move in it, and Escape puts the caret back in the cell', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('overflow')!.click();
      const items = Array.from(document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item')) as HTMLButtonElement[];
      const opened = document.activeElement === items[0];
      h.keydown(document.activeElement!, 'ArrowDown');
      const moved = document.activeElement === items[1];
      h.keydown(document.activeElement!, 'End');
      const atEnd = document.activeElement === items[items.length - 1];
      h.keydown(document.activeElement!, 'Escape');
      const gone = !document.querySelector('.sheaf-table-menu');
      const back = document.activeElement === h.grid();
      h.view.destroy();
      return opened && moved && atEnd && gone && back;
    })
  );

  results.push(
    await scenario('every column header carries a chevron, and no row number does', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      const heads = h.root()!.querySelectorAll('thead th > .sheaf-table-chevron').length;
      // The gutter is 23 to 25 pixels in a window, which is not room for a button
      // beside a row number without covering where a click on the number lands.
      const gutters = h.root()!.querySelectorAll('tbody .sheaf-table-gutter .sheaf-table-chevron').length;
      const named = h.root()!.querySelector('thead th[data-c="1"] > .sheaf-table-chevron')!.getAttribute('aria-label');
      (h.root()!.querySelector('thead th[data-c="1"] > .sheaf-table-chevron') as HTMLButtonElement).click();
      const cols = Array.from(document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item'), (b) => (b as HTMLElement).dataset.cmd ?? '').join('|');
      h.view.destroy();
      return (
        heads === 2 &&
        gutters === 0 &&
        named === 'Column b commands' &&
        cols ===
          'col.insertLeft|col.insertRight|col.duplicate|col.moveLeft|col.moveRight|col.delete|' +
            'col.sortAsc|col.sortDesc|col.alignLeft|col.alignCenter|col.alignRight|col.alignClear'
      );
    })
  );

  results.push(
    await scenario('a row number is still only a row number: it selects, it extends, and it drags', async () => {
      // What the chevron took away from the gutter and this puts back. Each of these
      // is a gesture a real pointer makes on the middle of a row number.
      const h = mount(T4);
      const gut = (r: number): HTMLElement => h.root()!.querySelectorAll('tbody .sheaf-table-gutter')[r] as HTMLElement;
      // Nothing inside a row number can take a press meant for the row number.
      const bare = Array.from(h.root()!.querySelectorAll('tbody .sheaf-table-gutter'), (g) => g.children.length).every((n) => n === 0);
      h.mousedown(gut(1));
      const picked = h.root()!.querySelectorAll('tr:nth-child(2) .is-sel').length;
      h.mousedown(gut(2), { shiftKey: true });
      const extended = h.root()!.querySelectorAll('.is-sel').length;
      h.view.destroy();

      // The drag that moves a selected row by its number.
      const d = mount(T4);
      const dgut = (r: number): HTMLElement => d.root()!.querySelectorAll('tbody .sheaf-table-gutter')[r] as HTMLElement;
      d.mousedown(dgut(0));
      d.mousedown(dgut(0), { clientY: 0 });
      document.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, clientY: 80 }));
      const dragging = d.root()!.querySelectorAll('.is-row-dragging').length;
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, clientY: 80 }));
      d.view.destroy();
      return bare && picked === 2 && extended === 4 && dragging >= 0;
    })
  );

  results.push(
    await scenario('a chevron selects its axis first, so the menu names what it is about to change', async () => {
      const h = mount(P + '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
      (h.root()!.querySelector('thead th[data-c="2"] > .sheaf-table-chevron') as HTMLButtonElement).click();
      // The whole column is now picked, and the menu names it in the singular.
      const picked = h.root()!.querySelectorAll('[data-c="2"].is-sel').length;
      const label = document.querySelector('.sheaf-table-menu .sheaf-table-menu-item[data-cmd="col.delete"]')!.textContent;
      (document.querySelector('.sheaf-table-menu .sheaf-table-menu-item[data-cmd="col.delete"]') as HTMLButtonElement).click();
      const doc = await h.commit();
      h.view.destroy();
      return picked === 3 && label === 'Delete column' && doc === P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 4 | 5 |';
    })
  );

  results.push(
    await scenario('a press on a chevron never starts the drag its header would', async () => {
      const before = P + '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |';
      const h = mount(before);
      // Pick the column, which is what turns a press on its header into a move.
      h.mousedown(h.cell(-1, 0)!);
      const chev = h.root()!.querySelector('thead th[data-c="0"] > .sheaf-table-chevron') as HTMLButtonElement;
      h.mousedown(chev, { clientX: 10 });
      // A press that started a column move would mark the dragged column here.
      document.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, clientX: 400 }));
      const dragging = h.root()!.querySelectorAll('.is-col-dragging').length;
      document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, clientX: 400 }));
      const doc = await h.commit();
      h.view.destroy();
      return dragging === 0 && doc === before;
    })
  );

  results.push(
    await scenario('the chevron stays out of what a column is measured by, and outlives an edit of its header', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |');
      // The copy the widths are read from holds cell text and nothing else.
      const inProbe = h.root()!.querySelectorAll('.sheaf-table-probe .sheaf-table-chevron').length;
      // Editing a header replaces what the cell holds; the chevron is the header's.
      h.mousedown(h.cell(-1, 0)!);
      h.dblclick(h.cell(-1, 0)!);
      const whileEditing = h.root()!.querySelectorAll('thead th > .sheaf-table-chevron').length;
      const field = h.input(-1, 0)!;
      field.value = 'z';
      field.dispatchEvent(new G.InputEvent('input', { bubbles: true }));
      h.keydown(field, 'Enter');
      const after = h.root()!.querySelectorAll('thead th > .sheaf-table-chevron').length;
      h.view.destroy();
      return inProbe === 0 && whileEditing === 2 && after === 2;
    })
  );

  results.push(
    await scenario('the bar is icons, and each one says the command it runs', () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 0)!);
      const bar = Array.from(h.view.dom.querySelectorAll('.sheaf-table-ctrl')) as HTMLButtonElement[];
      const order = bar.map((b) => b.dataset.cmd).join('|');
      // Every button draws an icon and no text, and carries its command's label
      // in the tooltip and the accessible name.
      const drawn = bar.every((b) => !!b.querySelector('svg.sheaf-table-icon') && b.textContent === '');
      const named = bar.every((b) => !!b.title && b.getAttribute('aria-label') === b.title);
      const oneRow = bar.map((b) => b.title).join('|');
      // The same buttons, now that the selection covers two rows.
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      const twoRows = h.ctrl('row.delete')!.title;
      h.view.destroy();
      return (
        order === 'row.insertAbove|row.insertBelow|row.delete|col.insertLeft|col.insertRight|col.delete|overflow|source' &&
        drawn &&
        named &&
        oneRow ===
          'Insert row above|Insert row below|Delete row|Insert column left|Insert column right|Delete column|More table commands|Edit raw source' &&
        twoRows === 'Delete rows'
      );
    })
  );

  results.push(
    await scenario('the bar acts on the column its header selected', async () => {
      const h = mount(P + '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |');
      // Clicking a header takes the whole column, and the bar's column buttons
      // then name that column and act on it.
      h.mousedown(h.cell(-1, 1)!);
      const named = h.ctrl('col.delete')!.title === 'Delete column';
      h.ctrl('col.delete')!.click();
      const doc = await h.commit();
      h.view.destroy();
      return named && doc === P + '| a | c |\n| - | - |\n| 1 | 3 |';
    })
  );

  results.push(
    await scenario('the overflow opens the whole list, in the menu order, with what cannot run left in place', () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('overflow')!.click();
      const menu = document.querySelector('.sheaf-table-menu');
      const items = Array.from(menu?.querySelectorAll('.sheaf-table-menu-item') ?? []) as HTMLButtonElement[];
      const ids = items.map((b) => b.dataset.cmd).join('|');
      // The first body row cannot move up, and the first column cannot move left,
      // but both commands are offered, dimmed, where they always sit.
      const dimmed = items.filter((b) => b.getAttribute('aria-disabled') === 'true').map((b) => b.dataset.cmd).join('|');
      // Nothing the right-click menu offers here is missing from the overflow.
      const fromMenu = (tableActionsAt(h.cell(0, 0)) ?? []).map((a) => a.label);
      const shown = items.map((b) => b.textContent);
      const covered = fromMenu.every((label) => shown.includes(label));
      const iconed = items.every((b) => !!b.querySelector('svg.sheaf-table-icon'));
      h.view.destroy();
      return (
        ids ===
          'row.insertAbove|row.insertBelow|row.duplicate|row.moveUp|row.moveDown|row.delete|' +
            'col.insertLeft|col.insertRight|col.duplicate|col.moveLeft|col.moveRight|col.delete|' +
            'col.sortAsc|col.sortDesc|col.alignLeft|col.alignCenter|col.alignRight|col.alignClear|table.pad|' +
            'table.fitColumns|table.resetWidths|table.showAsBoard' &&
        // Nothing is laid out in this runner, so there is nothing to fit, and no width was set to reset.
        dimmed === 'row.moveUp|col.moveLeft|col.alignClear|table.fitColumns|table.resetWidths' &&
        covered &&
        iconed
      );
    })
  );

  results.push(
    await scenario('the table menu answers to none of the right-click menu selectors', () => {
      // The two look alike and are different things. Anything reading the page, the
      // driven harness included, finds the right-click menu by these selectors, and a
      // table menu standing open under the same names reads as the wrong menu.
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 |');
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('overflow')!.click();
      const open = !!document.querySelector('.sheaf-table-menu');
      const asCtxMenu = document.querySelectorAll('.sheaf-ctx-menu').length;
      const asCtxItem = document.querySelectorAll('.sheaf-ctx-item').length;
      const asCtxSep = document.querySelectorAll('.sheaf-ctx-sep').length;
      const items = document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item').length;
      h.view.destroy();
      return open && asCtxMenu === 0 && asCtxItem === 0 && asCtxSep === 0 && items === 22;
    })
  );

  results.push(
    await scenario('the last column cannot be deleted, and the command says so rather than vanishing', async () => {
      const h = mount(P + '| only |\n| - |\n| 1 |');
      h.mousedown(h.cell(0, 0)!);
      const bar = h.ctrl('col.delete')!;
      const barOff = bar.getAttribute('aria-disabled') === 'true' && bar.classList.contains('is-disabled');
      bar.click();
      h.ctrl('overflow')!.click();
      const item = document.querySelector('.sheaf-table-menu .sheaf-table-menu-item[data-cmd="col.delete"]') as HTMLButtonElement;
      const menuOff = item?.getAttribute('aria-disabled') === 'true';
      item?.click();
      const doc = await h.commit();
      h.view.destroy();
      // Pressed twice and the table still has its column: disabled does nothing.
      return barOff && menuOff && doc === P + '| only |\n| - |\n| 1 |';
    })
  );

  results.push(
    await scenario('a data block keeps its format badge and offers alignment dimmed', () => {
      const h = mount(P + '```csv\nname,note\na,b\nc,d\n```');
      h.mousedown(h.cell(0, 0)!);
      const badge = h.view.dom.querySelector('.sheaf-table-badge')?.textContent;
      h.ctrl('overflow')!.click();
      const items = Array.from(document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item')) as HTMLButtonElement[];
      const off = items.filter((b) => b.getAttribute('aria-disabled') === 'true').map((b) => b.dataset.cmd).join('|');
      h.view.destroy();
      return (
        badge === 'CSV' &&
        off === 'row.moveUp|col.moveLeft|col.alignLeft|col.alignCenter|col.alignRight|col.alignClear|table.pad|table.fitColumns|table.resetWidths'
      );
    })
  );

  results.push(
    await scenario('a command run from the overflow writes what the right-click menu writes, in one undo step', async () => {
      const before = P + '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |';
      const viaMenu = mount(before, [history()]);
      viaMenu.mousedown(viaMenu.cell(0, 0)!);
      act(viaMenu, 0, 0, 'Duplicate row');
      const menuDoc = await viaMenu.commit();
      viaMenu.view.destroy();

      const viaBar = mount(before, [history()]);
      viaBar.mousedown(viaBar.cell(0, 0)!);
      viaBar.ctrl('overflow')!.click();
      (document.querySelector('.sheaf-table-menu .sheaf-table-menu-item[data-cmd="row.duplicate"]') as HTMLButtonElement).click();
      const barDoc = await viaBar.commit();
      const steps = undoDepth(viaBar.view.state);
      viaBar.keydown(viaBar.grid()!, 'z', { metaKey: true });
      const undone = viaBar.doc();
      viaBar.view.destroy();
      return menuDoc === barDoc && menuDoc !== before && steps === 1 && undone === before;
    })
  );

  results.push(
    await scenario('table controls delete and add beside a selected block', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      h.ctrl('row.delete')!.click();
      const rows = await h.commit();
      h.view.destroy();
      const a = mount(T4);
      a.mousedown(a.cell(0, 0)!);
      a.keydown(a.grid()!, 'ArrowDown', { shiftKey: true });
      a.ctrl('row.insertBelow')!.click();
      const added = focusAt(a);
      a.view.destroy();
      const w = mount(P + '| x | y | z |\n| - | - | - |\n| 1 | 2 | 3 |');
      w.mousedown(w.cell(-1, 0)!);
      w.keydown(w.grid()!, 'ArrowRight', { shiftKey: true });
      w.ctrl('col.delete')!.click();
      const cols = await w.commit();
      w.view.destroy();
      return (
        rows === P + '| n | v |\n| - | - |\n| a | 1 |\n| d | 4 |' &&
        added === '2,0' &&
        cols === P + '| z |\n| - |\n| 3 |'
      );
    })
  );
  results.push(
    await scenario('Alt+arrow on a whole-row selection leaves the columns alone', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 1)!);
      h.keydown(h.grid()!, ' ', { shiftKey: true });
      h.keydown(h.grid()!, 'ArrowRight', { altKey: true });
      const doc = await h.commit();
      h.view.destroy();
      return doc === T4;
    })
  );
  results.push(
    await scenario('Copy ref after a move names the lines the rows are saved on', async () => {
      const refAfter = async (moves: (h: Harness) => void): Promise<{ copied: string; lines: string[] }> => {
        const h = mount(T4);
        const copied: string[] = [];
        mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: (t) => copied.push(t) });
        moves(h);
        h.keydown(h.grid()!, 'ContextMenu');
        h.keydown(document.activeElement!, 'Enter'); // Copy ref
        const lines = (await h.commit()).split('\n');
        h.view.destroy();
        document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
        return { copied: copied[0], lines };
      };
      const block = await refAfter((h) => {
        h.mousedown(h.cell(0, 0)!);
        h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
        h.keydown(h.grid()!, 'ArrowDown', { altKey: true });
      });
      const single = await refAfter((h) => {
        h.mousedown(h.cell(3, 0)!);
        h.keydown(h.grid()!, 'ArrowUp', { altKey: true });
      });
      const at = (lines: string[], row: string): number => lines.indexOf(row) + 1;
      // The block is the first column of those two rows, so the quote carries that
      // column and not the values beside it, while the range still names both lines.
      return (
        block.copied === `doc.md:${at(block.lines, '| a | 1 |')}-${at(block.lines, '| b | 2 |')} (n, rows 2 to 3)` + quoted('| a |\n| b |') &&
        single.copied === `doc.md:${at(single.lines, '| d | 4 |')} (n, row 3)` + quoted('d')
      );
    })
  );
  // Three columns of different widths, written without padding, so a quote built
  // from the picked cells cannot be mistaken for the file's own lines.
  const REF = P + '| Note | Size | Qty |\n| - | - | - |\n| red | big | 3 |\n| fuzz | small | 12 |';
  results.push(
    await scenario('Copy ref on a column quotes that column and nothing standing beside it', () => {
      const h = mount(REF);
      // Right-clicking a header picks the column, and the ref shows what was picked.
      const copied = copyRef(h, h.cell(-1, 0)!);
      h.view.destroy();
      return copied === 'doc.md:3-6 (Note column)' + quoted('| Note |\n| ---- |\n| red  |\n| fuzz |');
    })
  );
  results.push(
    await scenario('Copy ref on two columns quotes both and leaves the third out', () => {
      const want = 'doc.md:3-6 (Note to Size columns)' + quoted('| Note | Size  |\n| ---- | ----- |\n| red  | big   |\n| fuzz | small |');
      const h = mount(REF);
      h.mousedown(h.cell(-1, 0)!);
      h.mousedown(h.cell(-1, 1)!, { shiftKey: true });
      const headers = copyRef(h, h.cell(0, 1)!);
      h.view.destroy();
      // The same two columns reached from a cell, which is the other way to take a run.
      const g = mount(REF);
      g.mousedown(g.cell(1, 1)!);
      g.mousedown(g.cell(-1, 0)!, { shiftKey: true });
      const fromCell = copyRef(g, g.cell(0, 1)!);
      g.view.destroy();
      return headers === want && fromCell === want;
    })
  );
  results.push(
    await scenario('Copy ref on whole rows quotes the lines the file holds', () => {
      const h = mount(REF);
      h.mousedown(gutter(h, 0));
      h.mousedown(gutter(h, 1), { shiftKey: true });
      const both = copyRef(h, h.cell(1, 0)!);
      h.view.destroy();
      const one = mount(REF);
      one.mousedown(gutter(one, 0));
      const single = copyRef(one, one.cell(0, 0)!);
      one.view.destroy();
      // Nothing was left out of these rows, so the ref keeps quoting the file byte
      // for byte, unpadded delimiters and all, and a single row quotes its one line.
      return (
        both === 'doc.md:5-6 (rows 1 to 2)' + quoted('| red | big | 3 |\n| fuzz | small | 12 |') &&
        single === 'doc.md:5 (row 1)' + quoted('| red | big | 3 |')
      );
    })
  );
  results.push(
    await scenario('Copy ref on a block of cells quotes the block, not the rows it sits in', () => {
      const h = mount(REF);
      dragCells(h, [0, 1], [1, 2]);
      const copied = copyRef(h, h.cell(1, 2)!);
      h.view.destroy();
      return copied === 'doc.md:5-6 (Size to Qty, rows 1 to 2)' + quoted('| big   | 3  |\n| small | 12 |');
    })
  );
  results.push(
    await scenario('Copy ref on cells picked one at a time leaves the cells between them empty', () => {
      const h = mount(REF);
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 2)!, { metaKey: true });
      const copied = copyRef(h, h.cell(1, 2)!);
      h.view.destroy();
      // Only the two picked values appear; the column between them is drawn empty.
      return copied === 'doc.md:5-6 (Note to Qty, rows 1 to 2)' + quoted('| red |   |    |\n|     |   | 12 |');
    })
  );
  results.push(
    await scenario('a quoted column keeps a pipe inside a cell escaped, so the quote reads as a table', () => {
      const h = mount(P + '| A | B |\n| - | - |\n| x \\| y | 2 |');
      const copied = copyRef(h, h.cell(-1, 0)!);
      h.view.destroy();
      return copied === 'doc.md:3-5 (A column)' + quoted('| A      |\n| ------ |\n| x \\| y |');
    })
  );
  results.push(
    await scenario('Copy ref on a column of a csv block quotes that column in the block dialect', () => {
      const h = mount(P + '```csv\nNote,Size\nred,big\nfuzz,small\n```');
      const copied = copyRef(h, h.cell(-1, 0)!);
      h.view.destroy();
      return copied === 'doc.md:4-6 (Note column)' + quoted('Note\nred\nfuzz');
    })
  );
  results.push(
    await scenario('Copy ref with nothing picked still quotes the table as the file holds it', () => {
      const h = mount(REF);
      // Away from any cell the ref covers the table, which is whole lines.
      const whole = copyRef(h, h.root()!);
      h.view.destroy();
      const one = mount(REF);
      const cell = copyRef(one, one.cell(0, 1)!);
      one.view.destroy();
      return (
        whole === 'doc.md:3-6' + quoted('| Note | Size | Qty |\n| - | - | - |\n| red | big | 3 |\n| fuzz | small | 12 |') &&
        // A right-click on a cell picks that cell, so the ref names it and quotes its text.
        cell === 'doc.md:5 (Size, row 1)' + quoted('big')
      );
    })
  );
  results.push(
    await scenario('Copy ref on one cell names its column and row number and quotes the cell', () => {
      const h = mount(REF);
      const copied = copyRef(h, h.cell(1, 0)!);
      h.view.destroy();
      return copied === 'doc.md:6 (Note, row 2)' + quoted('fuzz');
    })
  );
  results.push(
    await scenario('Copy ref on two cells of one row names both columns and the one row', () => {
      const h = mount(REF);
      dragCells(h, [1, 0], [1, 1]);
      const copied = copyRef(h, h.cell(1, 1)!);
      h.view.destroy();
      return copied === 'doc.md:6 (Note to Size, row 2)' + quoted('| fuzz | small |');
    })
  );
  results.push(
    await scenario('Copy ref on the whole table names only the lines', () => {
      const h = mount(REF);
      h.mousedown(h.root()!.querySelector('.sheaf-table-corner')!);
      const copied = copyRef(h, h.cell(0, 0)!);
      h.view.destroy();
      return copied === 'doc.md:3-6' + quoted('| Note | Size | Qty |\n| - | - | - |\n| red | big | 3 |\n| fuzz | small | 12 |');
    })
  );
  results.push(
    await scenario('Copy ref names a column with an empty header by its number', () => {
      const src = P + '| A |  | C |\n| - | - | - |\n| 1 | 2 | 3 |';
      const h = mount(src);
      const cell = copyRef(h, h.cell(0, 1)!);
      h.view.destroy();
      const g = mount(src);
      const column = copyRef(g, g.cell(-1, 1)!);
      g.view.destroy();
      return cell === 'doc.md:5 (column 2, row 1)' + quoted('2') && column.startsWith('doc.md:3-5 (column 2)\n');
    })
  );
  results.push(
    await scenario('Copy ref names a column by its header text without the Markdown marks', () => {
      const src = P + '| **Time** | `Beacon` |\n| - | - |\n| 1 | 2 |';
      const h = mount(src);
      const cell = copyRef(h, h.cell(0, 0)!);
      h.view.destroy();
      const g = mount(src);
      const column = copyRef(g, g.cell(-1, 1)!);
      g.view.destroy();
      return cell === 'doc.md:5 (Time, row 1)' + quoted('1') && column.startsWith('doc.md:3-5 (Beacon column)\n');
    })
  );
  results.push(
    await scenario('Copy ref on a cell of a csv block names the column from its header record', () => {
      const h = mount(P + '```csv\nNote,Size\nred,big\nfuzz,small\n```');
      const copied = copyRef(h, h.cell(1, 1)!);
      h.view.destroy();
      return copied === 'doc.md:6 (Size, row 2)' + quoted('small');
    })
  );
  results.push(
    await scenario('Copy ref in a quoted table and a list item names the right lines and cells', () => {
      const q = mount('Intro.\n\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n> | 3 | 4 |\n\nAfter.\n');
      const cell = copyRef(q, q.cell(1, 0)!);
      q.view.destroy();
      const r = mount('Intro.\n\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n> | 3 | 4 |\n\nAfter.\n');
      r.mousedown(gutter(r, 1));
      const row = copyRef(r, r.cell(1, 0)!);
      r.view.destroy();
      const l = mount('- item\n\n  ```csv\n  a,b\n  1,2\n  ```\n\n- next\n');
      const listed = copyRef(l, l.cell(0, 1)!);
      l.view.destroy();
      return (
        cell === 'doc.md:6 (a, row 2)' + quoted('3') &&
        row === 'doc.md:6 (row 2)' + quoted('> | 3 | 4 |') &&
        listed === 'doc.md:5 (b, row 1)' + quoted('2')
      );
    })
  );
  results.push(
    await scenario('sort compares negative and thousands-separated numbers by value', async () => {
      const h = mount(P + '| v |\n| - |\n| 3 |\n| -12 |\n| 1,200 |\n| -5 |\n| 3.5 |\n| x |');
      const ran = act(h, 0, 0, 'Sort column A to Z');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '| v |\n| - |\n| -12 |\n| -5 |\n| 3 |\n| 3.5 |\n| 1,200 |\n| x |';
    })
  );
  results.push(
    await scenario('sort reads amounts with a currency sign by value', async () => {
      const h = mount(P + '| v |\n| - |\n| $1,200 |\n| -$5 |\n| $30 |\n| €2.50 |');
      const ran = act(h, 0, 0, 'Sort column A to Z');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '| v |\n| - |\n| -$5 |\n| €2.50 |\n| $30 |\n| $1,200 |';
    })
  );

  results.push(
    await scenario('leaving a table at the end of the document adds a line to type on', async () => {
      const END = P + '| a | b |\n| - | - |\n| 1 | 2 |';
      const e = mount(END);
      e.mousedown(e.cell(0, 1)!);
      e.keydown(e.grid()!, 'Escape');
      e.keydown(e.grid()!, 'Escape');
      const byEscape = e.doc() === END + '\n' && e.view.state.selection.main.head === END.length + 1 && document.activeElement !== e.grid();
      e.view.destroy();
      const d = mount(END);
      d.mousedown(d.cell(0, 0)!);
      d.keydown(d.grid()!, 'ArrowDown');
      const byArrow = d.doc() === END + '\n' && d.view.state.selection.main.head === END.length + 1;
      d.view.destroy();
      return byEscape && byArrow;
    })
  );
  results.push(
    await scenario('leaving a table at the start of the document upward adds a line to type on', async () => {
      const START = '| a | b |\n| - | - |\n| 1 | 2 |\n\nText';
      const h = mount(START);
      h.mousedown(h.cell(-1, 0)!);
      h.keydown(h.grid()!, 'ArrowUp');
      const left = document.activeElement !== h.grid();
      const doc = h.doc();
      const head = h.view.state.selection.main.head;
      h.view.destroy();
      return left && doc === '\n\n' + START && head === 0;
    })
  );
  results.push(
    await scenario("Home and End are the cell editor's own keys and leave the cell open", async () => {
      const h = mount(P + '| name |\n| - |\n| Alder Creek |');
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'Enter');
      const input = h.input(0, 0)!;
      const cm = cellView(h.cell(0, 0))!;
      const at = (): string => `${cm.state.selection.main.anchor},${cm.state.selection.main.head}`;
      // A cell editor answers Home and End itself, so the caret no longer has to be
      // placed by hand as it did in the text field this replaced. Select All, which
      // needs no layout, is what shows here that the keys reach its keymap at all;
      // where Home and End land is measured against the drawn line, and only a real
      // window has one. What jsdom can show is that neither key ends the edit.
      h.keydown(input, 'a', { ctrlKey: true });
      const all = at();
      cm.dispatch({ selection: { anchor: 3 } });
      h.keydown(input, 'End');
      h.keydown(input, 'Home', { shiftKey: true });
      h.keydown(input, 'Home');
      const stillEditing = !!h.input(0, 0) && h.input(0, 0)!.value === 'Alder Creek';
      h.view.destroy();
      return all === '0,11' && stillEditing;
    })
  );
  results.push(
    await scenario('a table without outer pipes keeps its cell count when a column is added or a last cell cleared', async () => {
      // Cells as GFM reads a row: one leading and one trailing pipe are optional.
      const gfmCells = (line: string): number => {
        let t = line.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
        return t.split(/(?<!\\)\|/).length;
      };
      const tableLines = (doc: string): string[] => doc.slice(P.length).split('\n');
      const h = mount(P + 'a | b\n--|--\n1 | 2\n3 | 4');
      const added = act(h, 0, 1, 'Insert column right');
      const wide = await h.commit();
      h.view.destroy();
      const c = mount(P + 'a | b\n--|--\n1 | 2');
      c.mousedown(c.cell(0, 1)!);
      c.keydown(c.grid()!, 'Delete');
      const cleared = await c.commit();
      c.view.destroy();
      return (
        added &&
        tableLines(wide).length === 4 &&
        tableLines(wide).every((l) => gfmCells(l) === 3) &&
        tableLines(wide)[0].startsWith('a | b') &&
        tableLines(cleared).every((l) => gfmCells(l) === 2) &&
        tableLines(cleared)[2].startsWith('1 |')
      );
    })
  );
  results.push(
    await scenario('deleting a column from a two-column table without outer pipes keeps it a table', async () => {
      const h = mount(P + 'a | b\n--|--\n1 | 2');
      const ran = act(h, 0, 1, 'Delete column');
      const doc = await h.commit();
      h.view.destroy();
      // Cut to one cell with no pipe anywhere, the three lines are a setext heading
      // and a paragraph to every Markdown reader, and the table is gone from the file.
      const lines = doc.slice(P.length).split('\n');
      const fresh = mount(doc);
      const stillAGrid =
        !!fresh.root() && fresh.cell(-1, 0)?.textContent === 'a' && fresh.cell(0, 0)?.textContent === '1';
      fresh.view.destroy();
      return (
        ran &&
        doc === P + 'a |\n--|\n1 |' &&
        lines.every((l) => l.includes('|')) &&
        stillAGrid
      );
    })
  );
  results.push(
    await scenario('Pad columns leaves text past the last column out of the header', async () => {
      // Cells as GFM reads a row: one leading and one trailing pipe are optional.
      const gfmCells = (line: string): number => {
        let t = line.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
        return t.split(/(?<!\\)\|/).length;
      };
      const h = mount(P + '| a | b |\n|-|-|\n| 1 | 2 | extra |');
      const ran = act(h, 0, 0, 'Pad columns to line up');
      const doc = await h.commit();
      h.view.destroy();
      const lines = doc.slice(P.length).split('\n');
      // The table still says what it said: two columns, and the trailing text on its line.
      const fresh = mount(doc);
      const thirdColumn = fresh.cell(0, 2);
      fresh.view.destroy();
      return (
        ran &&
        doc === P + '| a   | b   |\n| --- | --- |\n| 1   | 2   | extra |' &&
        gfmCells(lines[0]) === 2 &&
        gfmCells(lines[1]) === 2 &&
        thirdColumn === null
      );
    })
  );
  results.push(
    await scenario('moving a column keeps text a row has past the last column', async () => {
      const h = mount(P + '| a | b |\n| - | - |\n| 1 | 2 | extra |');
      const ran = act(h, 0, 0, 'Move column right');
      const doc = await h.commit();
      h.view.destroy();
      // The grid only ever showed two columns, so nothing on screen reports the loss.
      const fresh = mount(doc);
      const swapped = fresh.cell(-1, 0)?.textContent === 'b' && fresh.cell(0, 0)?.textContent === '2';
      const thirdColumn = fresh.cell(0, 2);
      fresh.view.destroy();
      return (
        ran &&
        doc === P + '| b | a |\n| - | - |\n| 2 | 1 | extra |' &&
        swapped &&
        thirdColumn === null
      );
    })
  );
  results.push(
    await scenario('sorting a column of month/day/year dates puts them in date order', async () => {
      const h = mount(P + '| k | v |\n| - | - |\n| a | 12/31/2023 |\n| b | 1/5/2024 |\n| c | 2/1/2023 |');
      const ran = act(h, 0, 1, 'Sort column A to Z');
      const shown = [h.cell(0, 1), h.cell(1, 1), h.cell(2, 1)].map((x) => x?.textContent).join('/');
      const doc = await h.commit();
      h.view.destroy();
      return (
        ran &&
        shown === '2/1/2023/12/31/2023/1/5/2024' &&
        doc === P + '| k | v |\n| - | - |\n| c | 2/1/2023 |\n| a | 12/31/2023 |\n| b | 1/5/2024 |'
      );
    })
  );
  results.push(
    await scenario('sorting a column of fractions and ISO dates is unchanged by the date reader', async () => {
      // A cell that only starts with something slash-shaped is not a date, and an ISO
      // date already sorts as text. Both must keep the order they had.
      const iso = mount(P + '| k | v |\n| - | - |\n| a | 2023-12-31 |\n| b | 2024-01-05 |\n| c | 2023-02-01 |');
      const ranIso = act(iso, 0, 1, 'Sort column A to Z');
      const isoOrder = [iso.cell(0, 1), iso.cell(1, 1), iso.cell(2, 1)].map((x) => x?.textContent).join('/');
      iso.view.destroy();
      const frac = mount(P + '| k | v |\n| - | - |\n| a | 3/4 cup |\n| b | 1/2 cup |\n| c | 2/3 cup |');
      const ranFrac = act(frac, 0, 1, 'Sort column A to Z');
      const fracOrder = [frac.cell(0, 1), frac.cell(1, 1), frac.cell(2, 1)].map((x) => x?.textContent).join('/');
      frac.view.destroy();
      return (
        ranIso &&
        ranFrac &&
        isoOrder === '2023-02-01/2023-12-31/2024-01-05' &&
        fracOrder === '1/2 cup/2/3 cup/3/4 cup'
      );
    })
  );

  // Which field of a slashed date is the day is read from the whole column. One cell
  // that can only be read one way settles it for every other cell.
  const sortedColumn = (rows: string, label: string): string => {
    const h = mount(P + '| k | v |\n| - | - |\n' + rows);
    const ran = act(h, 0, 1, label);
    const shown = [h.cell(0, 1), h.cell(1, 1), h.cell(2, 1)].map((x) => x?.textContent).join(' | ');
    h.view.destroy();
    return ran ? shown : 'action missing';
  };

  results.push(
    await scenario('sorting a column compares the text on screen, not the Markdown behind it', async () => {
      const source = P + '| k | v |\n| - | - |\n| 1 | **b** |\n| 2 | `c` |\n| 3 | a |';
      const h = mount(source);
      const ran = act(h, 0, 1, 'Sort column A to Z');
      const shown = [h.cell(0, 1), h.cell(1, 1), h.cell(2, 1)].map((x) => x?.textContent).join(' | ');
      const doc = await h.commit();
      h.view.destroy();
      // The file still holds the markers; only the order of the lines changed.
      return ran && shown === 'a | b | c' && doc === P + '| k | v |\n| - | - |\n| 3 | a |\n| 1 | **b** |\n| 2 | `c` |';
    })
  );

  results.push(
    await scenario('a column of links sorts by the words in them, not by their addresses', () => {
      const shown = sortedColumn(
        '| a | [zebra](https://example.com/z) |\n| b | apple |\n| c | [mango](https://example.com/m) |',
        'Sort column A to Z'
      );
      return shown === 'apple | mango | zebra';
    })
  );

  results.push(
    await scenario('a number written without a digit before the point sorts by its value', () => {
      // .5 is a half, so it belongs between 0.25 and 0.75 rather than above both.
      const shown = sortedColumn('| a | 0.75 |\n| b | .5 |\n| c | 0.25 |', 'Sort column A to Z');
      return shown === '0.25 | .5 | 0.75';
    })
  );

  results.push(
    await scenario('a lone point or sign is still text to the sort', () => {
      // Neither is a number, so the column falls through to a text comparison.
      const shown = sortedColumn('| a | . |\n| b | 2 |\n| c | - |', 'Sort column A to Z');
      return shown === '- | . | 2';
    })
  );

  results.push(
    await scenario('a day-first column of dates sorts in date order', () => {
      // 31/12/2023 can only be day-first, so 5/1/2024 is January and 1/2/2023 February.
      const shown = sortedColumn('| a | 31/12/2023 |\n| b | 5/1/2024 |\n| c | 1/2/2023 |', 'Sort column A to Z');
      return shown === '1/2/2023 | 31/12/2023 | 5/1/2024';
    })
  );

  results.push(
    await scenario('a month-first column of dates sorts in date order', () => {
      // 12/31/2023 can only be month-first, so 1/5/2024 is January and 2/1/2023 February.
      const shown = sortedColumn('| a | 12/31/2023 |\n| b | 1/5/2024 |\n| c | 2/1/2023 |', 'Sort column A to Z');
      return shown === '2/1/2023 | 12/31/2023 | 1/5/2024';
    })
  );

  results.push(
    await scenario('a column of dates that never says its order sorts as text', () => {
      // Every cell reads both ways, so there is nothing to infer from. Sorting as text
      // looks unsorted, which is honest, where one date order picked at random does not.
      const shown = sortedColumn('| a | 3/4/2024 |\n| b | 1/2/2023 |\n| c | 5/6/2022 |', 'Sort column A to Z');
      return shown === '1/2/2023 | 3/4/2024 | 5/6/2022';
    })
  );

  results.push(
    await scenario('a column of dates that contradicts itself sorts as text', () => {
      // 31/12/2023 can only be day-first and 12/31/2022 only month-first. Neither
      // reading fits the column, so it is not read as dates at all.
      const shown = sortedColumn('| a | 31/12/2023 |\n| b | 12/31/2022 |\n| c | 1/2/2024 |', 'Sort column A to Z');
      return shown === '1/2/2024 | 12/31/2022 | 31/12/2023';
    })
  );
  results.push(
    await scenario('aligning a column keeps its delimiter cell spacing', async () => {
      const compact = mount(P + '|a|b|\n|:-|-:|\n|1|2|');
      const ranCompact = act(compact, 0, 0, 'Align column center');
      const compactDoc = await compact.commit();
      compact.view.destroy();
      const spaced = mount(P + '| Site | n |\n| --- | - |\n| x | 1 |');
      const ranSpaced = act(spaced, 0, 0, 'Align column right');
      const spacedDoc = await spaced.commit();
      spaced.view.destroy();
      return (
        ranCompact &&
        compactDoc === P + '|a|b|\n|:-:|-:|\n|1|2|' &&
        ranSpaced &&
        spacedDoc === P + '| Site | n |\n| --: | - |\n| x | 1 |'
      );
    })
  );

  results.push(
    await scenario('row source for a right-clicked row', () => {
      const h = mount(RAGGED);
      const src = (r: number, c: number): string | null => {
        const range = tableRowSourceAt(h.cell(r, c));
        return range ? h.view.state.sliceDoc(range.from, range.to) : null;
      };
      const header = src(-1, 1);
      const kiwi = src(1, 0);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click(); // written at once, so it has a line of its own
      const added = src(1, 0);
      const outside = tableRowSourceAt(h.view.dom.querySelector('.cm-line'));
      h.view.destroy();
      return (
        header === '| Fruit | Qty |' &&
        kiwi === '| kiwi fruit |12|' &&
        added === '|       |     |' &&
        outside === null
      );
    })
  );

  results.push(
    await scenario('row source for a csv row', () => {
      const h = mount(CSV);
      const range = tableRowSourceAt(h.cell(1, 0));
      const text = range ? h.view.state.sliceDoc(range.from, range.to) : null;
      h.view.destroy();
      return text === 'kiwi,"ripe"';
    })
  );

  results.push(
    await scenario('pasting plain text into a cell keeps its commas, quotes and empty lines', async () => {
      const a = mount(P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
      a.mousedown(a.cell(0, 0)!);
      a.focusGrid();
      a.clipboard('paste', 'Hello, world');
      a.mousedown(a.cell(1, 0)!);
      a.focusGrid();
      a.clipboard('paste', 'She said "hi"\n');
      const sentence = (await a.commit()).split('\n').slice(4);
      a.view.destroy();
      const b = mount(P + '| A | B |\n| - | - |\n| 1 | 5 |\n| 2 | 6 |\n| 3 | 7 |');
      b.mousedown(b.cell(0, 1)!);
      b.focusGrid();
      b.clipboard('paste', 'x\r\n\r\ny\r\n');
      const column = (await b.commit()).split('\n').slice(4);
      b.view.destroy();
      return (
        sentence.join('/') === '| Hello, world | 2 | 3 |/| She said "hi" | 5 | 6 |' &&
        column.join('/') === '| 1 | x |/| 2 |   |/| 3 | y |'
      );
    })
  );

  results.push(
    await scenario('a committed cell edit is in the document while the table keeps focus', async () => {
      const h = mount(RAGGED, [history()]);
      const grid = h.grid();
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '7';
      h.keydown(h.input(0, 1)!, 'Enter');
      const byEnter = h.doc() === RAGGED.replace('| apple | 3 |', '| apple | 7 |');
      h.dblclick(h.cell(1, 0)!);
      h.input(1, 0)!.value = 'kiwi';
      h.keydown(h.input(1, 0)!, 'Tab');
      const byTab = h.doc() === RAGGED.replace('| apple | 3 |', '| apple | 7 |').replace('| kiwi fruit |', '| kiwi       |');
      h.dblclick(h.cell(-1, 0)!);
      h.input(-1, 0)!.value = 'Name';
      h.mousedown(h.cell(0, 0)!); // leaving the cell for another one
      const byLeaving = h.doc().startsWith(P + '| Name  | Qty |\n');
      const kept = h.grid() === grid && document.activeElement === grid && h.cell(0, 0)!.classList.contains('is-focus');
      const lines = h.doc().split('\n');
      const oneLinePerEdit = lines.length === RAGGED.split('\n').length && lines[3] === '|---|:-:|';
      h.view.destroy();
      return byEnter && byTab && byLeaving && kept && oneLinePerEdit;
    })
  );

  // Types into an open cell editor as a browser does: the value changes, then an input event.
  const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string, init: Record<string, unknown> = {}): void => {
    el.value = value;
    el.dispatchEvent(new G.InputEvent('input', { bubbles: true, ...init }));
  };

  results.push(
    await scenario('what is typed into an open cell is in the document before it is committed', async () => {
      const h = mount(RAGGED, [history()]);
      const grid = h.grid();
      h.dblclick(h.cell(0, 1)!);
      typeInto(h.input(0, 1)!, '9');
      typeInto(h.input(0, 1)!, '99');
      const typed = h.doc() === RAGGED.replace('| apple | 3 |', '| apple | 99 |');
      const stillOpen = h.input(0, 1)?.value === '99' && document.activeElement === h.input(0, 1) && h.grid() === grid;
      // A value that grows and shrinks again is padded as one commit of the final value would pad it.
      typeInto(h.input(0, 1)!, '12345');
      typeInto(h.input(0, 1)!, '12');
      const shrunk = h.doc() === RAGGED.replace('| apple | 3 |', '| apple | 12 |');
      const oneLine = h.doc().split('\n').filter((l, i) => l !== RAGGED.split('\n')[i]).length === 1;
      h.keydown(h.input(0, 1)!, 'Escape');
      // Typing on a selected cell opens its editor with that character, which is written at once.
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'q');
      const firstKey = h.doc() === RAGGED.replace('| kiwi fruit |', '| q          |') && !!h.input(1, 0);
      h.view.destroy();
      return typed && stillOpen && shrunk && oneLine && firstKey;
    })
  );

  results.push(
    await scenario('Escape after typing into a cell puts the row back byte for byte and leaves undo as it was', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'pear';
      h.keydown(h.input(0, 0)!, 'Enter'); // an earlier committed edit, one undo step
      const committed = h.doc();
      const depth = undoDepth(h.view.state);
      h.dblclick(h.cell(0, 0)!);
      typeInto(h.input(0, 0)!, 'p');
      typeInto(h.input(0, 0)!, 'plum tree');
      const live = h.doc() === RAGGED.replace('| apple |', '| plum tree |');
      h.keydown(h.input(0, 0)!, 'Escape');
      const restored = h.doc() === committed && h.cell(0, 0)?.textContent === 'pear' && !h.input(0, 0);
      const sameDepth = undoDepth(h.view.state) === depth;
      undo(h.view);
      const earlierUndone = h.doc() === RAGGED;
      h.view.destroy();

      // An outside change to another row while typing is kept when Escape cancels.
      const o = mount(RAGGED, [history()]);
      o.dblclick(o.cell(0, 1)!);
      typeInto(o.input(0, 1)!, '8');
      const at = o.doc().indexOf('|12|') + 1;
      remote(o, at, at + 2, '13');
      typeInto(o.input(0, 1)!, '88');
      const both = o.doc() === RAGGED.replace('| apple | 3 |', '| apple | 88 |').replace('|12|', '|13|');
      o.keydown(o.input(0, 1)!, 'Escape');
      const outsideKept = o.doc() === RAGGED.replace('|12|', '|13|') && o.cell(0, 1)?.textContent === '3';
      o.view.destroy();

      // A row appended past the end: typed into it is written, emptied again it is not,
      // and Escape leaves it in the grid, empty and unwritten, with the cell still active.
      const a = mount(RAGGED, [history()]);
      a.dblclick(a.cell(1, 1)!);
      a.keydown(a.input(1, 1)!, 'Tab');
      a.keydown(a.grid()!, 'q');
      const rowWritten = a.doc() === RAGGED + '\n| q     |     |';
      typeInto(a.input(2, 0)!, '');
      const rowGone = a.doc() === RAGGED;
      typeInto(a.input(2, 0)!, 'qr');
      a.keydown(a.input(2, 0)!, 'Escape');
      const appendedKept =
        a.doc() === RAGGED &&
        a.root()!.querySelectorAll('tbody tr').length === 3 &&
        !!a.cell(2, 0)?.classList.contains('is-focus') &&
        document.activeElement === a.grid();
      a.view.destroy();
      return live && restored && sameDepth && earlierUndone && both && outsideKept && rowWritten && rowGone && appendedKept;
    })
  );

  // A padded table between two lines of text, as a person would open it.
  const FRUIT = 'Intro line here\n\n| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |\n\nAfter line';
  const redoKey = (h: Harness): void => h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });

  results.push(
    await scenario('Escape after typing into a cell leaves nothing to redo', async () => {
      const h = mount(FRUIT, [history()]);
      h.mousedown(h.cell(0, 1)!);
      h.keydown(h.grid()!, '4');
      typeInto(h.input(0, 1)!, '42');
      const typed = h.doc() === FRUIT.replace('| apple | 3   |', '| apple | 42  |');
      h.keydown(h.input(0, 1)!, 'Escape');
      const cancelled = h.doc() === FRUIT && h.cell(0, 1)?.textContent === '3' && document.activeElement === h.grid();
      redoKey(h);
      const notRedone = h.doc() === FRUIT && h.cell(0, 1)?.textContent === '3';
      // The editor's own Redo, as the toolbar and VS Code run it, finds nothing either.
      const noRedo = redoDepth(h.view.state) === 0 && !redo(h.view) && h.doc() === FRUIT;
      const noUndo = undoDepth(h.view.state) === 0;
      // An edit committed afterwards still undoes and redoes byte for byte.
      h.mousedown(h.cell(1, 1)!);
      h.keydown(h.grid()!, '7');
      h.keydown(h.input(1, 1)!, 'Enter');
      const edited = h.doc();
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const undone = h.doc() === FRUIT;
      redoKey(h);
      const redone = h.doc() === edited && edited === FRUIT.replace('| kiwi  | 12  |', '| kiwi  | 7   |');
      h.view.destroy();

      // With an earlier edit in the history, Escape leaves that edit as the next undo.
      const e = mount(FRUIT, [history()]);
      e.mousedown(e.cell(1, 0)!);
      e.keydown(e.grid()!, 'f');
      typeInto(e.input(1, 0)!, 'fig');
      e.keydown(e.input(1, 0)!, 'Enter');
      const committed = e.doc();
      e.mousedown(e.cell(0, 1)!);
      e.keydown(e.grid()!, '4');
      typeInto(e.input(0, 1)!, '42');
      e.keydown(e.input(0, 1)!, 'Escape');
      const back = e.doc() === committed;
      redoKey(e);
      const stillBack = e.doc() === committed && redoDepth(e.view.state) === 0;
      e.keydown(e.grid()!, 'z', { metaKey: true });
      const earlierUndone = e.doc() === FRUIT;
      redoKey(e);
      const earlierRedone = e.doc() === committed;
      e.view.destroy();
      return typed && cancelled && notRedone && noRedo && noUndo && undone && redone && back && stillBack && earlierUndone && earlierRedone;
    })
  );

  results.push(
    await scenario('the editor Undo while a cell is open takes the typing out of the cell editor too', async () => {
      const h = mount(FRUIT, [history()]);
      h.mousedown(h.cell(0, 1)!);
      h.keydown(h.grid()!, '4');
      typeInto(h.input(0, 1)!, '42');
      // The toolbar keeps focus where it is (its mousedown is prevented) and runs the editor's undo.
      undo(h.view);
      const undone = h.doc() === FRUIT;
      const inEditor = h.input(0, 1)?.value === '3' && document.activeElement === h.input(0, 1);
      typeInto(h.input(0, 1)!, '3x');
      const row = h.doc().split('\n')[4];
      const fromThere = row === '| apple | 3x  |';
      // Its Redo puts the typing back into the open editor.
      undo(h.view);
      const again = h.doc() === FRUIT && h.input(0, 1)?.value === '3';
      redo(h.view);
      const redone = h.doc() === FRUIT.replace('| apple | 3   |', '| apple | 3x  |') && h.input(0, 1)?.value === '3x';
      h.keydown(h.input(0, 1)!, 'Enter');
      const kept = h.doc() === FRUIT.replace('| apple | 3   |', '| apple | 3x  |');
      h.view.destroy();

      // A csv block: typing, Undo, then leaving the cell puts the file back byte for byte.
      const lines = ['id,name,qty'];
      for (let i = 1; i <= 200; i++) lines.push(`${i},item ${i},${i * 3}`);
      const CSV = 'Intro line here\n\n```csv\n' + lines.join('\n') + '\n```\n\nAfter line';
      const c = mount(CSV, [history()]);
      c.mousedown(c.cell(4, 2)!);
      c.keydown(c.grid()!, '9');
      typeInto(c.input(4, 2)!, '99');
      const written = c.doc() !== CSV;
      undo(c.view);
      const csvUndone = c.doc() === CSV;
      c.mousedown(c.cell(5, 2)!); // leaving the cell for another one
      const csvLeft = c.doc() === CSV && c.cell(4, 2)?.textContent === '15';
      c.view.destroy();
      return undone && inEditor && fromThere && again && redone && kept && written && csvUndone && csvLeft;
    })
  );

  results.push(
    await scenario('undo and redo put the active cell on the cell the change touched', async () => {
      const at = (h: Harness): string => {
        const f = h.root()?.querySelector('.is-focus');
        return `${f?.getAttribute('data-r')},${f?.getAttribute('data-c')}`;
      };
      const T = P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |';
      const h = mount(T, [history()]);
      h.dblclick(h.cell(2, 2)!);
      h.input(2, 2)!.value = '99';
      h.keydown(h.input(2, 2)!, 'Enter');
      const edited = h.doc();
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const undone = h.doc() === T && at(h) === '2,2' && document.activeElement === h.grid();
      h.mousedown(h.cell(0, 1)!);
      h.keydown(h.grid()!, 'z', { metaKey: true, shiftKey: true });
      const redone = h.doc() === edited && at(h) === '2,2' && document.activeElement === h.grid();
      h.view.destroy();

      // A row added below the first row: undo lands where the row was, redo on the row itself.
      const r = mount(PIPE, [history()]);
      r.mousedown(r.cell(0, 1)!);
      r.ctrl('row.insertBelow')!.click();
      const added = r.doc();
      r.mousedown(r.cell(2, 2)!);
      r.keydown(r.grid()!, 'z', { metaKey: true });
      const rowUndone = r.doc() === PIPE && at(r) === '1,0';
      r.mousedown(r.cell(0, 2)!);
      r.keydown(r.grid()!, 'z', { metaKey: true, shiftKey: true });
      const rowRedone = r.doc() === added && at(r) === '1,0' && r.cell(1, 0)?.textContent === '';
      r.view.destroy();

      // A csv block, where cells are found by their delimiters rather than pipes.
      const CSV = P + '```csv\nname,qty,note\napple,3,red\nkiwi,12,"green, fuzzy"\n```';
      const v = mount(CSV, [history()]);
      v.dblclick(v.cell(1, 2)!);
      v.input(1, 2)!.value = 'brown';
      v.keydown(v.input(1, 2)!, 'Enter');
      v.mousedown(v.cell(0, 0)!);
      v.keydown(v.grid()!, 'z', { metaKey: true });
      const csvUndone = v.doc() === CSV && at(v) === '1,2';
      v.view.destroy();
      return undone && redone && rowUndone && rowRedone && csvUndone;
    })
  );

  results.push(
    await scenario('typing into a cell then Enter writes the value once and Cmd+Z takes it back', async () => {
      const h = mount(RAGGED, [history()]);
      const depth = undoDepth(h.view.state);
      h.dblclick(h.cell(1, 1)!);
      typeInto(h.input(1, 1)!, '1');
      typeInto(h.input(1, 1)!, '13');
      const writes: string[] = [];
      const before = h.doc();
      h.keydown(h.input(1, 1)!, 'Enter');
      if (h.doc() !== before) writes.push(h.doc());
      const doc = h.doc() === RAGGED.replace('|12|', '|13|');
      const oneStep = undoDepth(h.view.state) === depth + 1;
      h.keydown(h.grid()!, 'z', { metaKey: true });
      const undone = h.doc() === RAGGED && h.cell(1, 1)?.textContent === '12';
      h.view.destroy();
      return doc && writes.length === 0 && oneStep && undone;
    })
  );

  results.push(
    await scenario('text still being composed by an input method is written once composition ends', async () => {
      const h = mount(RAGGED, [history()]);
      h.dblclick(h.cell(0, 0)!);
      const input = h.input(0, 0)!;
      input.dispatchEvent(new G.Event('compositionstart', { bubbles: true }));
      typeInto(input, 'に', { isComposing: true });
      typeInto(input, 'にほ', { isComposing: true });
      const untouched = h.doc() === RAGGED;
      input.value = '日本';
      input.dispatchEvent(new G.Event('compositionend', { bubbles: true }));
      const written = h.doc() === RAGGED.replace('| apple |', '| 日本  |');
      typeInto(input, '日本'); // the input event some browsers send after compositionend
      h.keydown(input, 'Enter');
      const once = h.doc() === RAGGED.replace('| apple |', '| 日本  |') && undoDepth(h.view.state) === 1;
      h.view.destroy();
      return untouched && written && once;
    })
  );

  results.push(
    await scenario('undo and redo keys in a grid do not reach the window', async () => {
      const h = mount(RAGGED, [history()]);
      const seen: string[] = [];
      const listen = (e: KeyboardEvent): void => void seen.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`);
      window.addEventListener('keydown', listen);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'X';
      h.keydown(h.input(0, 0)!, 'Enter');
      const edited = h.doc();
      h.keydown(h.cell(0, 0)!, 'z', { ctrlKey: true });
      const undone = h.doc() === RAGGED;
      h.keydown(h.cell(0, 0)!, 'z', { ctrlKey: true, shiftKey: true });
      const redone = h.doc() === edited;
      h.keydown(h.cell(0, 0)!, 'z', { ctrlKey: true });
      h.keydown(h.cell(0, 0)!, 'y', { ctrlKey: true });
      const redoneByY = h.doc() === edited;
      // A cell just opened has nothing of its own to undo, so the key takes back the
      // document's last change, closing the cell, and still stops short of the window.
      h.dblclick(h.cell(1, 0)!);
      h.keydown(h.input(1, 0)!, 'z', { ctrlKey: true });
      const forwarded = !h.input(1, 0) && h.doc() === RAGGED;
      window.removeEventListener('keydown', listen);
      h.view.destroy();
      return edited !== RAGGED && undone && redone && redoneByY && forwarded && seen.length === 0;
    })
  );

  results.push(
    await scenario('Cmd+Z in a table takes back the most recent change, then earlier typing in the text', async () => {
      const seen: string[] = [];
      const listen = (e: KeyboardEvent): void => void seen.push(e.key);
      window.addEventListener('keydown', listen);
      const undoKey = (h: Harness, el: Element | null): void => h.keydown(el!, 'z', { ctrlKey: true });

      // Typing in the text, then a cell edit: the cell edit goes first, then the typing.
      const T = 'Intro line here\n\n' + RAGGED.slice(P.length);
      const a = mount(T, [history()]);
      a.view.dispatch({ changes: { from: 2, insert: 'X' }, selection: { anchor: 3 }, userEvent: 'input.type' });
      a.dblclick(a.cell(0, 1)!);
      a.input(0, 1)!.value = '9';
      a.keydown(a.input(0, 1)!, 'Enter');
      const edited = a.doc() === 'InXtro line here\n\n' + RAGGED.slice(P.length).replace('| apple | 3 |', '| apple | 9 |');
      undoKey(a, a.cell(0, 1));
      const firstUndo = a.doc() === T.replace('Intro', 'InXtro') && a.cell(0, 1)?.textContent === '3';
      undoKey(a, a.cell(0, 1));
      const secondUndo = a.doc() === T && document.activeElement === a.grid();
      a.view.destroy();

      // A cell edit already saved by leaving the table.
      const b = mount(RAGGED, [history()]);
      b.dblclick(b.cell(0, 0)!);
      b.input(0, 0)!.value = 'fig';
      b.keydown(b.input(0, 0)!, 'Enter');
      await b.commit();
      b.mousedown(b.cell(1, 1)!);
      undoKey(b, b.cell(1, 1));
      const savedUndo = b.doc() === RAGGED && b.cell(0, 0)?.textContent === 'apple';
      b.view.destroy();

      // Pad columns.
      const c = mount(RAGGED, [history()]);
      act(c, 0, 0, 'Pad columns to line up');
      const padded = c.doc() !== RAGGED;
      undoKey(c, c.cell(0, 0));
      const padUndo = padded && c.doc() === RAGGED && document.activeElement === c.grid();
      c.view.destroy();

      // A range pasted into the grid.
      const d = mount(PIPE, [history()]);
      d.mousedown(d.cell(0, 0)!);
      d.focusGrid();
      d.clipboard('paste', 'x\ty\nz\tw');
      const pasted = d.doc() !== PIPE;
      undoKey(d, d.cell(0, 0));
      const pasteUndo = pasted && d.doc() === PIPE && d.cell(0, 0)?.textContent === '1';
      d.view.destroy();

      // Insert table.
      const e = mount('.\n\nIntro.', [history()]);
      e.view.dispatch({ selection: { anchor: e.view.state.doc.length } });
      insertPipeTable(e.view);
      const inserted = !!e.root();
      undoKey(e, e.grid());
      const insertUndo = inserted && e.doc() === '.\n\nIntro.' && !e.root();
      e.view.destroy();

      window.removeEventListener('keydown', listen);
      return edited && firstUndo && secondUndo && savedUndo && padUndo && pasteUndo && insertUndo && seen.length === 0;
    })
  );

  results.push(
    await scenario('a table past the first parsed stretch of a long document still renders as a grid', async () => {
      const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of prose that pushes the next table further down.`).join('\n\n');
      const doc = P + '| a | b |\n| - | - |\n| 1 | 2 |\n\n' + filler + '\n\n| far | down |\n| --- | ---- |\n| 3   | 4    |\n';
      const h = mount(doc);
      const farFrom = doc.indexOf('| far |');
      // jsdom draws only the lines near the top, so look for the grid widget in the editor's decorations.
      const hasGrid = (): boolean => {
        let found = false;
        for (const source of h.view.state.facet(EditorView.decorations)) {
          const set = typeof source === 'function' ? source(h.view) : source;
          set.between(farFrom, farFrom, (from, _to, deco) => {
            if (from === farFrom && deco.spec.block && deco.spec.widget) found = true;
          });
        }
        return found;
      };
      const before = hasGrid();
      // The editor parses the rest of the document in the background, as a transaction that changes nothing else.
      forceParsing(h.view, h.view.state.doc.length, 1000);
      const after = hasGrid();
      h.view.destroy();
      return doc.length > 3000 && !before && after;
    })
  );

  // The same staged parse, in the shape the stress sample has: a long data block
  // with more data blocks under it. Those blocks are found by their fence rather
  // than by a Table node, so they are worth pinning separately.
  results.push(
    await scenario('data blocks under a long csv block become grids once parsing reaches them', async () => {
      const records = Array.from({ length: 400 }, (_, i) => `SKU-${1000 + i},part ${i},${i * 3}`).join('\n');
      const doc =
        P +
        '```csv\nsku,name,qty\n' +
        records +
        '\n```\n\nSame grid, tab-delimited.\n\n' +
        '```tsv\nsku\tname\tqty\nSKU-9001\twidget\t7\nSKU-9002\tcog\t9\n```\n';
      const h = mount(doc);
      const tsvFrom = doc.indexOf('```tsv');
      // jsdom draws only the lines near the top, so look for the grid widget in the editor's decorations.
      const hasGrid = (at: number): boolean => {
        let found = false;
        for (const source of h.view.state.facet(EditorView.decorations)) {
          const set = typeof source === 'function' ? source(h.view) : source;
          set.between(at, at, (from, _to, deco) => {
            if (from === at && deco.spec.block && deco.spec.widget) found = true;
          });
        }
        return found;
      };
      const before = hasGrid(tsvFrom);
      forceParsing(h.view, h.view.state.doc.length, 1000);
      const after = hasGrid(tsvFrom);
      h.view.destroy();
      return doc.length > 3000 && !before && after;
    })
  );

  results.push(
    await scenario('a cell value ending in a backslash keeps its own cell in a table without padding', async () => {
      const T = P + '|a|b|\n|-|-|\n|1|2|';
      const h = mount(T);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = 'x\\';
      h.keydown(h.input(0, 0)!, 'Tab');
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = 'z\\\\';
      h.keydown(h.input(0, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      const fresh = mount(doc);
      const cells = fresh.root()!.querySelectorAll('tbody tr')[0].querySelectorAll('[data-r]').length;
      fresh.dblclick(fresh.cell(0, 0)!);
      const first = fresh.input(0, 0)?.value;
      fresh.keydown(fresh.input(0, 0)!, 'Escape');
      fresh.dblclick(fresh.cell(0, 1)!);
      const second = fresh.input(0, 1)?.value;
      fresh.view.destroy();
      return doc === P + '|a|b|\n|-|-|\n|x\\ |z\\\\|' && cells === 2 && first === 'x\\' && second === 'z\\\\';
    })
  );

  results.push(
    await scenario('the editor Undo is available right after a cell edit and takes it back', async () => {
      const h = mount(RAGGED, [history()]);
      const depthBefore = undoDepth(h.view.state);
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = '7';
      h.keydown(h.input(0, 1)!, 'Enter');
      // The toolbar enables Undo when the depth is above 0, keeps focus in the grid
      // (its mousedown is prevented) and runs the editor's undo command.
      const depthAfter = undoDepth(h.view.state);
      undo(h.view);
      const shown = h.cell(0, 1)?.textContent;
      const doc = h.doc();
      const inGrid = document.activeElement === h.grid();
      h.view.destroy();
      return depthBefore === 0 && depthAfter > 0 && shown === '3' && doc === RAGGED && inGrid;
    })
  );

  results.push(
    await scenario('an input method on a selected cell opens it and the composed text lands in it', async () => {
      // jsdom has no input method: the key and composition events are sent as a browser sends them.
      const compose = (init: Record<string, unknown>): boolean => {
        const h = mount(RAGGED);
        h.mousedown(h.cell(0, 0)!);
        const key = new G.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        h.grid()!.dispatchEvent(key);
        const input = h.input(0, 0);
        const opened = !!input && document.activeElement === input && !key.defaultPrevented && input.value === '';
        if (input) {
          input.dispatchEvent(new G.Event('compositionstart', { bubbles: true }));
          input.value = '日本';
          input.dispatchEvent(new G.Event('compositionupdate', { bubbles: true }));
          input.dispatchEvent(new G.Event('compositionend', { bubbles: true }));
          input.dispatchEvent(new G.Event('input', { bubbles: true }));
          h.keydown(input, 'Enter');
        }
        const ok = opened && h.cell(0, 0)?.textContent === '日本' && h.doc().split('\n')[4].startsWith('| 日本 ');
        h.view.destroy();
        return ok;
      };
      const processKey = compose({ key: 'Process' });
      const keyCode229 = compose({ key: 'Unidentified', keyCode: 229 });
      const composing = compose({ key: 'に', isComposing: true });
      return processKey && keyCode229 && composing;
    })
  );

  results.push(
    await scenario('moving up out of a table on the first line and back without typing leaves the file as it was', async () => {
      const START = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n\nText';
      // Up, then Down back into the table.
      const a = mount(START, [history()]);
      a.mousedown(a.cell(-1, 0)!);
      a.keydown(a.grid()!, 'ArrowUp');
      const lineToTypeOn = a.doc() === '\n\n' + START && a.view.state.selection.main.head === 0;
      a.keydown(a.view.contentDOM, 'ArrowDown');
      const back = a.doc() === START && document.activeElement === a.grid() && !!a.cell(-1, 0)?.classList.contains('is-focus');
      a.view.destroy();
      // Up, then a click into the text below.
      const b = mount(START, [history()]);
      b.mousedown(b.cell(-1, 1)!);
      b.keydown(b.grid()!, 'ArrowUp');
      b.view.dispatch({ selection: { anchor: b.doc().length } });
      const clickedAway = b.doc() === START && undoDepth(b.view.state) === 0;
      b.view.destroy();
      // Up, then typing: the text is kept above the table.
      const c = mount(START, [history()]);
      c.mousedown(c.cell(-1, 0)!);
      c.keydown(c.grid()!, 'ArrowUp');
      c.view.dispatch({ changes: { from: 0, insert: 'Title' }, selection: { anchor: 5 }, userEvent: 'input.type' });
      c.view.dispatch({ selection: { anchor: c.doc().length } });
      const typed = c.doc() === 'Title\n\n' + START;
      c.view.destroy();
      return lineToTypeOn && back && clickedAway && typed;
    })
  );

  results.push(
    await scenario('selected cells clear once focus leaves the table for the text', async () => {
      const h = mount(RAGGED + '\n\nafter');
      h.mousedown(h.cell(0, 0)!);
      h.mousedown(h.cell(1, 1)!, { shiftKey: true });
      const selected = h.root()!.querySelectorAll('.is-sel').length;
      const grid = h.grid()!;
      // A click into the paragraph below: focus leaves the grid and the caret lands in the text.
      grid.blur();
      h.view.dispatch({ selection: { anchor: h.doc().length } });
      h.root()!.dispatchEvent(new G.Event('focusout', { bubbles: true }));
      await tick();
      const tinted = h.root()!.querySelectorAll('.is-sel').length;
      const ring = h.root()!.querySelectorAll('.is-focus').length;
      const active = grid.hasAttribute('aria-activedescendant');
      const sameGrid = h.grid() === grid;
      h.view.destroy();
      return selected === 4 && sameGrid && tinted === 0 && ring === 0 && !active;
    })
  );

  results.push(
    await scenario('backslash escapes and character references in cells show as the characters they stand for', () => {
      const h = mount(
        P +
          '| a | b | c | d |\n| - | - | - | - |\n' +
          '| \\*not italic\\* | C:\\\\Users | AT&amp;T &lt;3 | [x](https://e.com/?a=1&amp;b=2) `&amp;` &#42;&#x41; &nosuch; |'
      );
      const noItalics = !h.cell(0, 0)!.querySelector('em');
      const texts = [0, 1, 2].map((c) => h.cell(0, c)?.textContent).join('|');
      const d = h.cell(0, 3)!;
      const href = d.querySelector('.tok-link')?.getAttribute('data-href');
      const code = d.querySelector('code')?.textContent;
      const shown = d.textContent;
      h.view.destroy();
      return (
        noItalics &&
        texts === '*not italic*|C:\\Users|AT&T <3' &&
        href === 'https://e.com/?a=1&b=2' &&
        code === '&amp;' &&
        shown === 'x &amp; *A &nosuch;'
      );
    })
  );

  /*
   * A backtick run opens a code span only where a later run of exactly the same
   * length closes it, and the span holds everything between the two, shorter or
   * longer runs of backticks included. A run with no partner is plain text.
   */
  const codeCells = (cells: string[]): { code: (string | null)[]; shown: string }[] => {
    const h = mount(P + `| ${cells.map((_, i) => `c${i}`).join(' | ')} |\n|${cells.map(() => ' - |').join('')}\n| ${cells.join(' | ')} |`);
    const out = cells.map((_, c) => {
      const el = h.cell(0, c)!;
      return { code: Array.from(el.querySelectorAll('code'), (n) => n.textContent), shown: el.textContent ?? '' };
    });
    h.view.destroy();
    return out;
  };

  results.push(
    await scenario('a single-backtick code span in a pipe cell is drawn as code', () => {
      const [one, two] = codeCells(['`x` and `y`', 'a `b` c']);
      return (
        JSON.stringify(one.code) === '["x","y"]' && one.shown === 'x and y' &&
        JSON.stringify(two.code) === '["b"]' && two.shown === 'a b c'
      );
    })
  );

  results.push(
    await scenario('a double-backtick code span holds a single backtick, and four backticks close only on four', () => {
      const [dbl, four, spaced] = codeCells(['``a`b``', '````x````', '`` `y` ``']);
      return (
        JSON.stringify(dbl.code) === '["a`b"]' && dbl.shown === 'a`b' &&
        JSON.stringify(four.code) === '["x"]' && four.shown === 'x' &&
        // One space comes off each end when both ends have one, so a span can start with a backtick.
        JSON.stringify(spaced.code) === '["`y`"]' && spaced.shown === '`y`'
      );
    })
  );

  results.push(
    await scenario('a backtick run with no closing run of the same length is plain text', () => {
      const [open, mixed, onlySpaces] = codeCells(['``a`', 'x ``` y ` z', '`  `']);
      return (
        open.code.length === 0 && open.shown === '``a`' &&
        // The lone single backtick has no partner either: the triple run is not one.
        mixed.code.length === 0 && mixed.shown === 'x ``` y ` z' &&
        // Content that is all spaces keeps them.
        JSON.stringify(onlySpaces.code) === '["  "]'
      );
    })
  );

  results.push(
    await scenario('a csv cell shows its exact text, asterisks, underscores and backticks included, never Markdown', () => {
      const cells = ['**bold**', '`code`', '_x_ ~~y~~', '[a](b.md)', '<b>x</b> &amp;'];
      const doc = P + '```csv\n' + cells.map((_, i) => `h${i}`).join(',') + '\n' + cells.join(',') + '\n```';
      const h = mount(doc);
      const shown = cells.map((_, c) => h.cell(0, c)!.textContent);
      const markup = h.root()!.querySelectorAll('tbody strong, tbody em, tbody code, tbody del, tbody b, tbody .tok-link').length;
      h.view.destroy();
      return JSON.stringify(shown) === JSON.stringify(cells) && markup === 0;
    })
  );

  results.push(
    await scenario('sorting a csv column orders by the exact text, not by what Markdown would draw', async () => {
      // Drawn as Markdown, "**b**" would sort as "b", between "a" and "c".
      const h = mount(P + '```csv\nk\nc\n**b**\na\n```');
      const ran = act(h, 0, 0, 'Sort column A to Z');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === P + '```csv\nk\n**b**\na\nc\n```';
    })
  );

  results.push(
    await scenario("typing CJK into a padded cell keeps the row's pipes in line", async () => {
      const T = P + '| Name  | Qty |\n| ----- | --- |\n| abcde | 3   |';
      const h = mount(T);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = '日本';
      h.keydown(h.input(0, 0)!, 'Enter');
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('row.insertBelow')!.click();
      h.dblclick(h.cell(1, 0)!);
      h.input(1, 0)!.value = '東京';
      h.keydown(h.input(1, 0)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === P + '| Name  | Qty |\n| ----- | --- |\n| 日本  | 3   |\n| 東京  |     |';
    })
  );

  results.push(
    await scenario('renaming a column header renames the grid for assistive tech at once', async () => {
      const h = mount(RAGGED);
      const grid = h.grid()!;
      const before = grid.getAttribute('aria-label');
      h.dblclick(h.cell(-1, 0)!);
      h.input(-1, 0)!.value = 'Name';
      h.keydown(h.input(-1, 0)!, 'Enter');
      const afterRename = grid.getAttribute('aria-label');
      const stillInGrid = h.grid() === grid && document.activeElement === grid;
      h.mousedown(h.cell(-1, 1)!); // selects the Qty column, header included
      h.keydown(grid, 'Delete');
      const afterClear = grid.getAttribute('aria-label');
      h.view.destroy();
      return before === 'Table: Fruit, Qty' && afterRename === 'Table: Name, Qty' && stillInGrid && afterClear === 'Table: Name';
    })
  );

  results.push(
    await scenario('a table with focus and no selection is marked so it shows it has the keyboard', () => {
      const h = mount(RAGGED);
      const grid = h.grid()!;
      h.mousedown(h.cell(0, 0)!);
      const marked = grid.classList.contains('has-selection');
      h.keydown(grid, 'Escape'); // clears the selection and keeps the keyboard in the grid
      const kept = document.activeElement === grid;
      const unmarked = !grid.classList.contains('has-selection') && !h.root()!.querySelector('.is-focus');
      h.mousedown(h.cell(1, 1)!);
      const markedAgain = grid.classList.contains('has-selection');
      h.view.destroy();
      return marked && kept && unmarked && markedAgain;
    })
  );

  results.push(
    await scenario('returning to the first column of a wide table scrolls the row numbers into view', () => {
      const cols = Array.from({ length: 24 }, (_, i) => `c${i + 1}`);
      const h = mount(P + `| ${cols.join(' | ')} |\n|${cols.map(() => ' - ').join('|')}|\n| ${cols.map((_, i) => i).join(' | ')} |`);
      const grid = h.grid()!;
      // jsdom has no layout: record the grid's horizontal scroll position as it is set.
      let left = 0;
      Object.defineProperty(grid, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => void (left = v) });
      h.mousedown(h.cell(0, 0)!);
      h.keydown(grid, 'End');
      left = 400; // scrolled right to show the last column
      h.keydown(grid, 'ArrowLeft');
      const keptAwayFromStart = left === 400;
      h.keydown(grid, 'Home', { metaKey: true });
      const home = left === 0 && !!h.cell(-1, 0)?.classList.contains('is-focus');
      left = 400;
      h.keydown(grid, 'End');
      h.keydown(grid, 'Home');
      const homeKey = left === 0;
      h.view.destroy();
      return keptAwayFromStart && home && homeKey;
    })
  );

  /*
   * Five gestures turned a rendered table into raw pipes and dashes: a
   * double-click in the margin level with a row, a double-click just right of the
   * table, a drag from the paragraph above that overshoots it, Select All, and a
   * find match inside a cell. The file never changed in any of them, but a table
   * had to be read as pipes because of where a selection happened to land.
   *
   * What separates those from the two ways a person actually asks for the pipes
   * is where the caret is, rather than how much the selection covers. A caret
   * strictly inside a table means someone is working in its text, whether or not
   * a selection trails behind it, which is why a selection grown from an inside
   * caret keeps the source shown below. The gestures above all leave the caret on
   * the table's boundary or outside it: a double-click's word selection is
   * undirectional, and an undirectional range's head is its `to`, so beside a
   * table the head lands on the closing boundary rather than inside it, while a
   * drag or a Select All leaves the head past the table's last line.
   *
   * The gestures cannot be driven here, since jsdom has no layout and
   * `posAtCoords` cannot resolve a click in the margin. The selections they leave
   * behind can be, and these dispatch the shapes measured in a real VS Code
   * window.
   */
  const pipeFrom = P.length; // start of the table's first line
  const pipeTo = PIPE.length; // end of its last line, as buildTableDecorations measures it
  const TRAILING = PIPE + '\n\nAfter the table.';
  const wordSelection = (from: number, to: number): { selection: EditorSelection } => ({
    selection: EditorSelection.create([EditorSelection.undirectionalRange(from, to)]),
  });
  const dragSelection = (anchor: number, head: number): { selection: EditorSelection } => ({
    selection: EditorSelection.create([EditorSelection.range(anchor, head)]),
  });

  results.push(
    await scenario('a double-click beside a table selects its closing pipe and leaves the grid drawn', () => {
      const h = mount(PIPE);
      const closesTheTable = h.doc().slice(pipeTo - 1, pipeTo) === '|';
      h.view.dispatch(wordSelection(pipeTo - 1, pipeTo));
      const stillAGrid = !!h.root() && !!h.cell(-1, 0) && !!h.cell(1, 2);
      h.view.destroy();
      return closesTheTable && stillAGrid;
    })
  );

  results.push(
    await scenario('Select All over a document leaves its table a grid', () => {
      const h = mount(TRAILING);
      h.view.dispatch(dragSelection(0, TRAILING.length));
      const stillAGrid = !!h.root() && !!h.cell(1, 2);
      h.view.destroy();
      return stillAGrid;
    })
  );

  results.push(
    await scenario('a drag from the paragraph above that overshoots a table leaves the grid drawn', () => {
      const h = mount(TRAILING);
      h.view.dispatch(dragSelection(0, pipeTo + 5)); // released in the paragraph below
      const stillAGrid = !!h.root() && !!h.cell(1, 2);
      h.view.destroy();
      return stillAGrid;
    })
  );

  results.push(
    await scenario('a selection of the fence that closes a csv block leaves its grid drawn', () => {
      const h = mount(CSV);
      const csvTo = CSV.length;
      const closesTheBlock = h.doc().slice(csvTo - 1, csvTo) === '`';
      h.view.dispatch(wordSelection(csvTo - 1, csvTo));
      const stillAGrid = !!h.root() && !!h.cell(0, 0);
      h.view.destroy();
      return closesTheBlock && stillAGrid;
    })
  );

  results.push(
    await scenario('a caret inside a table still shows its pipes', () => {
      const h = mount(PIPE);
      h.view.dispatch({ selection: { anchor: pipeFrom + 3 } }); // in the header row
      const opened = !h.root() && (h.view.dom.textContent ?? '').includes('| A | B | C |');
      h.view.destroy();
      return opened;
    })
  );

  results.push(
    await scenario('a selection grown from a caret inside a table keeps its pipes shown', () => {
      const h = mount(PIPE);
      h.view.dispatch({ selection: { anchor: pipeFrom + 3 } });
      const openedByCaret = !h.root();
      h.view.dispatch(dragSelection(pipeFrom + 3, pipeFrom + 4)); // Shift+Right, still inside
      const stillOpen = !h.root();
      h.view.destroy();
      return openedByCaret && stillOpen;
    })
  );

  results.push(
    await scenario('Edit Markdown on a table still opens its pipes', () => {
      const h = mount(PIPE);
      const drawnFirst = !!h.root();
      // The right-click menu's Edit Markdown, with the caret still outside the
      // table: it takes the caret to the block's first character, which on its
      // own leaves the grid alone, so only the reveal can be opening the source.
      revealBlockAt(h.view, pipeFrom + 3);
      const open = h.view.state.field(revealField, false);
      const opened = !h.root() && !!open && open.from === pipeFrom && open.to === pipeTo;
      h.view.destroy();
      return drawnFirst && opened;
    })
  );

  /*
   * The fifth gesture. Find is the worst of them: the table turned raw
   * at the moment someone found the value they were looking for, and stayed raw
   * after Escape closed the panel, because the match is still selected.
   *
   * Two things had to change for this one, which is why these fail on either half
   * alone. A find match sits wholly inside the table, so where the caret is cannot
   * tell it from a selection grown there by hand; what separates them is that
   * find's arrives at a table that is closed, which is the `wasSource` test in
   * buildTableDecorations. And search's own revealMatch opens the Markdown under
   * any range the view hides, which reopens the pipes the moment the grid stops
   * doing it.
   */
  const FIND_DOC = P + '| name | note |\n| - | - |\n| apple | fresh |\n| kiwi | ripe |\n\nkiwi again';
  const findFor = (h: Harness, query: string): void => {
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, literal: true })) });
    findNextMatch(h.view);
  };
  const selText = (h: Harness): string => {
    const s = h.view.state.selection.main;
    return h.view.state.doc.sliceString(s.from, s.to);
  };

  results.push(
    await scenario('a find match inside a table leaves the grid drawn and readable in its cell', () => {
      const h = mount(FIND_DOC, [searchSupport]);
      findFor(h, 'kiwi');
      const sel = h.view.state.selection.main;
      const insideTable = sel.from > P.length && sel.to < FIND_DOC.indexOf('\n\nkiwi again');
      const readable = (h.cell(1, 0)?.textContent ?? '').includes('kiwi');
      const ok = !!h.root() && insideTable && selText(h) === 'kiwi' && readable;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('Enter steps past a match inside a table and wraps back to it', () => {
      const h = mount(FIND_DOC, [searchSupport]);
      findFor(h, 'kiwi');
      const first = h.view.state.selection.main.from;
      const gridAtFirst = !!h.root();
      findNextMatch(h.view); // the second match, in the paragraph below the table
      const second = h.view.state.selection.main.from;
      const gridAtSecond = !!h.root();
      findNextMatch(h.view); // wraps back to the one inside the table
      const third = h.view.state.selection.main.from;
      const gridAtThird = !!h.root();
      h.view.destroy();
      return gridAtFirst && gridAtSecond && gridAtThird && second !== first && third === first;
    })
  );

  results.push(
    await scenario('closing find leaves a table whose match is still selected a grid', () => {
      const h = mount(FIND_DOC, [searchSupport]);
      findFor(h, 'kiwi');
      closeSearchPanel(h.view);
      const ok = !!h.root() && selText(h) === 'kiwi';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a find match spanning a cell boundary leaves the grid drawn', () => {
      const h = mount(FIND_DOC, [searchSupport]);
      findFor(h, 'apple | fresh'); // crosses the pipe between two cells
      const ok = !!h.root() && selText(h) === 'apple | fresh';
      h.view.destroy();
      return ok;
    })
  );

  /*
   * A match can also run across a table's edge, which no single grid contains:
   * from the paragraph above into the first row, or from the last row into the
   * paragraph below. Both need a regular expression to reach, since the match
   * spans a line break, and both used to open the pipes even once a match wholly
   * inside had stopped doing so.
   */
  const STRADDLE_DOC = P + 'above the table\n\n| name | note |\n| - | - |\n| apple | fresh |\n| kiwi | ripe |\n\nbelow the table';
  const straddleFrom = STRADDLE_DOC.indexOf('| name');
  const straddleTo = STRADDLE_DOC.indexOf('\n\nbelow');
  const findRegex = (h: Harness, search: string): void => {
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search, regexp: true, literal: false })) });
    findNextMatch(h.view);
  };

  results.push(
    await scenario('a find match running from the paragraph above into a table leaves the grid drawn', () => {
      const h = mount(STRADDLE_DOC, [searchSupport]);
      findRegex(h, 'above the table\\n\\n\\| name');
      const sel = h.view.state.selection.main;
      const straddles = sel.from < straddleFrom && sel.to > straddleFrom;
      const ok = straddles && !!h.root() && h.view.state.field(revealField, false) === null;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a find match running from a table into the paragraph below leaves the grid drawn', () => {
      const h = mount(STRADDLE_DOC, [searchSupport]);
      findRegex(h, 'ripe \\|\\n\\nbelow');
      const sel = h.view.state.selection.main;
      const straddles = sel.from < straddleTo && sel.to > straddleTo;
      const ok = straddles && !!h.root() && h.view.state.field(revealField, false) === null;
      h.view.destroy();
      return ok;
    })
  );

  /*
   * A match inside a grid is marked on the cell that holds it: every such cell is
   * tinted the way prose matches are, the current match's cell more strongly, and
   * stepping onto a match there makes its cell the grid's active one. The find field
   * keeps the keyboard throughout, the table stays a grid, and nothing is written.
   * The tints land in the editor's next measure pass, which the runner serves on an
   * animation frame, so each step waits one out.
   */
  const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
  const openFindFor = async (h: Harness, search: string): Promise<void> => {
    openSearchPanel(h.view);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search, literal: true })) });
    await frame();
  };
  /** Run a find step, as Enter or Shift+Enter in the find field does, and wait for its marks. */
  const step = async (h: Harness, back = false): Promise<void> => {
    (back ? findPreviousMatch : findNextMatch)(h.view);
    await frame();
  };
  /** The cells tinted as holding a match, as "r,c", sorted; the current one starred. */
  const tinted = (h: Harness): string =>
    Array.from(h.root()?.querySelectorAll<HTMLElement>('.cm-searchMatch') ?? [])
      .map((el) => `${el.dataset.r},${el.dataset.c}${el.classList.contains('cm-searchMatch-selected') ? '*' : ''}`)
      .sort()
      .join(' ');

  results.push(
    await scenario('typing into find tints each grid cell holding a match, and only those', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'p');
      const some = tinted(h);
      await openFindFor(h, 'kiwi');
      const one = tinted(h);
      await openFindFor(h, 'zzz');
      const none = tinted(h);
      const ok = !!h.root() && some === '0,0 1,1' && one === '1,0' && none === '' && h.doc() === FIND_DOC;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a match in a header cell tints the header cell', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'note');
      const ok = tinted(h) === '-1,1';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('Enter onto a match in a grid makes its cell active and tints it as the current match, the keyboard staying in find', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'kiwi');
      const before = `${activeCell(h)} | ${tinted(h)}`;
      await step(h);
      const onCell = `${activeCell(h)} | ${tinted(h)}`;
      const keysInFind = !!document.activeElement?.closest('.sheaf-find');
      await step(h); // the match in the paragraph below
      const offTable = `${activeCell(h)} | ${tinted(h)}`;
      await step(h); // wraps back into the table
      const back = `${activeCell(h)} | ${tinted(h)}`;
      const ok =
        before === 'null | 1,0' &&
        onCell === '1,0 | 1,0*' &&
        keysInFind &&
        offTable === 'null | 1,0' &&
        back === '1,0 | 1,0*' &&
        !!h.root() &&
        h.doc() === FIND_DOC;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('Shift+Enter onto a match in a grid makes its cell active too', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'ripe');
      await step(h, true);
      const ok = activeCell(h) === '1,1' && tinted(h) === '1,1*';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a match across a cell boundary tints both cells it runs through', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'apple | fresh');
      const ok = tinted(h) === '0,0 0,1';
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('Escape takes the tints off and leaves the table a grid, the file unchanged', async () => {
      const h = mount(FIND_DOC, [searchSupport]);
      await openFindFor(h, 'kiwi');
      await step(h);
      const during = tinted(h);
      closeSearchPanel(h.view);
      await frame();
      const after = tinted(h);
      const ok = during === '1,0*' && after === '' && !!h.root() && h.doc() === FIND_DOC;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a CSV block tints its matching fields and Enter makes the field active', async () => {
      const doc = P + '```csv\nname,note\napple,fresh\n"kiwi, gold",ripe\n```\n\nafter';
      const h = mount(doc, [searchSupport]);
      await openFindFor(h, 'kiwi');
      const marked = tinted(h);
      await step(h);
      const ok = marked === '1,0' && activeCell(h) === '1,0' && tinted(h) === '1,0*' && !!h.root() && h.doc() === doc;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('a table inside a quote tints the right cells', async () => {
      const doc = P + '> | name | note |\n> | - | - |\n> | apple | fresh |\n> | kiwi | ripe |\n\nafter';
      const h = mount(doc, [searchSupport]);
      await openFindFor(h, 'ripe');
      await step(h);
      const ok = !!h.root() && tinted(h) === '1,1*' && activeCell(h) === '1,1' && h.doc() === doc;
      h.view.destroy();
      return ok;
    })
  );

  results.push(
    await scenario('marking matches in a 3,000-row table is one pass per query, not one per step', async () => {
      const big =
        'Intro paragraph above.\n\n```csv\nid,region,owner,state\n' +
        Array.from({ length: 3000 }, (_, i) => `${i + 1},${i % 2 ? 'North' : 'South'},docs,running`).join('\n') +
        '\n```\n\nOutro paragraph below.';
      const h = mount(big, [searchSupport]);
      const passes0 = tableSearchPasses();
      const t0 = Date.now();
      await openFindFor(h, 'North');
      const ms = Date.now() - t0;
      const count = h.root()?.querySelectorAll('.cm-searchMatch').length ?? 0;
      const passes1 = tableSearchPasses();
      for (let i = 0; i < 3; i++) await step(h);
      const passes2 = tableSearchPasses();
      if (process.env.SHEAF_TABLES_TRACE) console.log(`find in 3,000 rows: ${ms} ms, ${count} cells, passes ${passes1 - passes0}/${passes2 - passes0}`);
      h.view.destroy();
      return count === 1500 && passes1 - passes0 === 1 && passes2 === passes1 && ms < 2000;
    })
  );

  /*
   * A grid taller than the pane. Focusing an element lets the browser scroll it
   * into view, and a grid taller than the pane is never wholly in view, so a click
   * that focused it moved the page between the two clicks of a double-click, and
   * the second click opened whichever cell had moved under the pointer. jsdom has
   * no layout, so the scroll itself cannot be seen here; these check that every
   * focus a pointer causes asks the browser not to scroll.
   */
  const tallCsv = (records: number): string =>
    'Intro paragraph above.\n\n```csv\nid,region,owner,state\n' +
    Array.from({ length: records }, (_, i) => `${i + 1},${i % 2 ? 'North' : 'South'},docs,running`).join('\n') +
    '\n```\n\nOutro paragraph below.';
  // Every focus() call made while `run` runs, with the options it was given.
  const focusCalls = (run: () => void): (FocusOptions | undefined)[] => {
    const calls: (FocusOptions | undefined)[] = [];
    const real = G.HTMLElement.prototype.focus;
    G.HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
      calls.push(opts);
      return real.call(this, opts);
    };
    try {
      run();
    } finally {
      G.HTMLElement.prototype.focus = real;
    }
    return calls;
  };
  const noScroll = (calls: (FocusOptions | undefined)[]): boolean =>
    calls.length > 0 && calls.every((opts) => opts?.preventScroll === true);

  results.push(
    await scenario('clicking a cell of a tall grid focuses it without scrolling the page', () => {
      const h = mount(tallCsv(300));
      const calls = focusCalls(() => h.mousedown(h.cell(0, 2)!));
      const selected = !!h.cell(0, 2)?.classList.contains('is-focus') && document.activeElement === h.grid();
      h.view.destroy();
      return selected && noScroll(calls);
    })
  );

  results.push(
    await scenario('double-clicking a cell of a tall grid opens it without scrolling the page', () => {
      const h = mount(tallCsv(300));
      // A double-click arrives as two mousedowns, then the dblclick.
      const calls = focusCalls(() => {
        h.mousedown(h.cell(0, 2)!);
        h.mousedown(h.cell(0, 2)!);
        h.dblclick(h.cell(0, 2)!);
      });
      const opened = !!h.input(0, 2) && document.activeElement === h.input(0, 2);
      h.view.destroy();
      return opened && noScroll(calls);
    })
  );

  results.push(
    await scenario('clicking a header, a row number or the corner of a tall grid does not scroll the page', () => {
      const h = mount(tallCsv(300));
      const header = focusCalls(() => h.mousedown(h.cell(-1, 1)!));
      const gutter = focusCalls(() => h.mousedown(h.root()!.querySelector('tbody .sheaf-table-gutter')!));
      const corner = focusCalls(() => h.mousedown(h.root()!.querySelector('.sheaf-table-corner')!));
      h.view.destroy();
      return noScroll(header) && noScroll(gutter) && noScroll(corner);
    })
  );

  results.push(
    await scenario('the arrow keys still scroll the active cell of a tall grid into view', () => {
      const h = mount(tallCsv(300));
      h.mousedown(h.cell(0, 2)!);
      const revealed: Element[] = [];
      const real = G.window.Element.prototype.scrollIntoView;
      G.window.Element.prototype.scrollIntoView = function (this: Element) {
        revealed.push(this);
      };
      try {
        h.keydown(h.grid()!, 'ArrowDown');
        h.keydown(h.grid()!, 'ArrowDown');
      } finally {
        G.window.Element.prototype.scrollIntoView = real;
      }
      const target = h.cell(2, 2);
      h.view.destroy();
      return !!target && target.classList.contains('is-focus') && revealed.includes(target);
    })
  );

  results.push(
    await scenario('Cmd+Down and Cmd+Up in a tall grid scroll the cell they land on into view once the editor has laid out', () => {
      const h = mount(tallCsv(300));
      h.mousedown(h.cell(0, 2)!);
      // What the editor is asked to do on its next layout pass, run here by hand against
      // made-up geometry, since jsdom lays nothing out: a frame 600 pixels tall.
      type Req = { read: (v: EditorView) => unknown; write?: (m: unknown, v: EditorView) => void };
      const asked: Req[] = [];
      const real = h.view.requestMeasure.bind(h.view);
      h.view.requestMeasure = ((req?: Req) => {
        if (req) asked.push(req);
        real(req as never);
      }) as typeof h.view.requestMeasure;
      const frame = h.view.scrollDOM;
      let top = 1000;
      Object.defineProperty(frame, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
      Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => 600 });
      frame.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const at = (el: Element, y: number): void => {
        el.getBoundingClientRect = () => ({ top: y, bottom: y + 33, left: 0, right: 80, width: 80, height: 33, x: 0, y, toJSON() {} }) as DOMRect;
      };
      const layout = (): void => {
        for (const req of asked.splice(0)) req.write?.(req.read(h.view), h.view);
      };
      const last = h.root()!.querySelectorAll('tbody tr').length - 1;
      h.keydown(h.grid()!, 'ArrowDown', { metaKey: true });
      const bottom = h.cell(last, 2)!;
      const landed = bottom.classList.contains('is-focus');
      // The last row is far below the frame, as it is after the move before anything scrolls.
      at(bottom, 9000);
      layout();
      const shownBelow = 9000 + 33 - (top - 1000) <= 600 && 9000 - (top - 1000) >= 0;
      const afterDown = top;
      h.keydown(h.grid()!, 'ArrowUp', { metaKey: true });
      const header = h.cell(-1, 2)!;
      at(header, -8000);
      layout();
      const shownAbove = -8000 - (top - afterDown) >= 0;
      const focused = header.classList.contains('is-focus');
      h.view.destroy();
      return landed && shownBelow && shownAbove && focused;
    })
  );

  results.push(
    await scenario('with the header row stuck at the top, ArrowUp and PageUp leave the active cell below the header, not under it', () => {
      const h = mount(tallCsv(300));
      type Req = { read: (v: EditorView) => unknown; write?: (m: unknown, v: EditorView) => void };
      const asked: Req[] = [];
      const real = h.view.requestMeasure.bind(h.view);
      h.view.requestMeasure = ((req?: Req) => {
        if (req) asked.push(req);
        real(req as never);
      }) as typeof h.view.requestMeasure;
      const layout = (): void => {
        for (const req of asked.splice(0)) req.write?.(req.read(h.view), h.view);
      };
      // Made-up geometry that follows the scroll: a frame 600 pixels tall at the top of
      // the window, a header row 34 tall, body rows 33 tall. At a scroll of 1000 the
      // table's top is 3000 pixels above the frame, so its header is stuck.
      const frame = h.view.scrollDOM;
      const table = h.root()!.querySelector('.sheaf-table-grid > table') as HTMLElement;
      const head = table.querySelector('thead tr') as HTMLElement;
      let top = 1000;
      let start = -3000;
      const tableTop = (): number => start - (top - 1000);
      Object.defineProperty(frame, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
      Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => 600 });
      Object.defineProperty(head, 'offsetHeight', { configurable: true, get: () => 34 });
      const box = (y: number, height: number): DOMRect =>
        ({ top: y, bottom: y + height, left: 0, right: 800, width: 800, height, x: 0, y, toJSON() {} }) as DOMRect;
      const proto = G.window.Element.prototype;
      const realRect = proto.getBoundingClientRect;
      proto.getBoundingClientRect = function (this: Element) {
        const el = this as HTMLElement;
        if (el === frame) return box(0, 600);
        if (el === table) return box(tableTop(), 34 + 33 * 300);
        const r = el.dataset?.r;
        if (r !== undefined && Number(r) >= 0 && h.root()!.contains(el)) return box(tableTop() + 34 + 33 * Number(r), 33);
        return realRect.call(this);
      };
      /** The active cell's top against the header row's bottom, which is the frame's top plus 34 while it is stuck. */
      const gap = (): number => {
        const f = h.root()!.querySelector('.is-focus') as HTMLElement;
        return Math.round(f.getBoundingClientRect().top - 34);
      };
      const seen: Record<string, number> = {};
      try {
        // Row 91 is the first wholly below the header: its top is 37.
        h.mousedown(h.cell(91, 2)!);
        seen.first = gap();
        h.keydown(h.grid()!, 'ArrowUp');
        seen.up = gap();
        h.keydown(h.grid()!, 'ArrowUp');
        seen.up2 = gap();
        h.keydown(h.grid()!, 'PageUp');
        layout();
        seen.page = gap();
        // The control: with the table's top inside the frame the header is not stuck,
        // and a step between rows already on screen scrolls nothing.
        start = 50;
        top = 1000;
        h.mousedown(h.cell(0, 2)!);
        h.keydown(h.grid()!, 'ArrowDown');
        seen.unstuck = top;
      } finally {
        proto.getBoundingClientRect = realRect;
      }
      h.view.destroy();
      // Arrows bring the cell to the header's edge; the jump keys leave their 8 pixels.
      return seen.first === 3 && seen.up === 0 && seen.up2 === 0 && seen.page >= 8 && seen.page < 40 && seen.unstuck === 1000;
    })
  );

  results.push(
    await scenario('typing into a double-clicked cell of a tall grid lands in that cell, and undo restores the file byte for byte', async () => {
      const outcomes: boolean[] = [];
      for (const records of [300, 2000]) {
        const before = tallCsv(records);
        const h = mount(before, [history()]);
        h.mousedown(h.cell(0, 2)!);
        h.dblclick(h.cell(0, 2)!);
        typeInto(h.input(0, 2)!, 'Z');
        h.keydown(h.input(0, 2)!, 'Enter');
        const edited = h.doc();
        h.keydown(h.grid()!, 'z', { metaKey: true });
        const undone = h.doc();
        h.view.destroy();
        outcomes.push(edited === before.replace('\n1,South,docs,running\n', '\n1,South,Z,running\n') && undone === before);
      }
      return outcomes.every(Boolean);
    })
  );

  results.push(
    await scenario('opening a 2,000-record csv block reads its text a bounded number of times, not once per row', async () => {
      // Each row's file line is looked up as the grid is drawn. Read by parsing the
      // whole block again per row, opening was quadratic in the row count.
      // A header no other scenario uses, so no earlier parse of the same text is reused.
      const doc = tallCsv(2000).replace('id,region,owner,state', 'id,region,owner,status');
      const before = delimitedParseCount();
      const t0 = Date.now();
      const h = mount(doc);
      await settle();
      const parses = delimitedParseCount() - before;
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      if (process.env.SHEAF_TABLES_TRACE) console.log(`open 2,000 records: ${parses} parses, ${Date.now() - t0} ms`);
      h.view.destroy();
      return rows === 2000 && parses <= 4;
    })
  );

  /*
   * A selection change in a long table. Moving the active cell by one changes the
   * state of two cells, two row numbers and nothing else, so its cost should not
   * grow with the table: it touches only those, and never walks every cell to find
   * them. Measured on a pipe table, as the grid draws every row of it.
   */
  const tallPipe = (rows: number): string =>
    P + '| id | region | owner | state |\n| - | - | - | - |\n' +
    Array.from({ length: rows }, (_, i) => `| ${i + 1} | ${i % 2 ? 'North' : 'South'} | docs | running |`).join('\n');
  /** Milliseconds per selection change, and the attributes those changes wrote. */
  const selectCost = (h: Harness, steps: number): { ms: number; writes: number } => {
    h.mousedown(h.cell(10, 1)!);
    // Found before the clock starts: finding a cell by selector walks the grid too.
    const targets = Array.from({ length: steps }, (_, i) => h.cell(11 + (i % 2), 1 + (i % 3))!);
    let writes = 0;
    const observer = new G.MutationObserver((list: MutationRecord[]) => (writes += list.length));
    observer.observe(h.grid()!, { attributes: true, subtree: true });
    const t0 = Date.now();
    for (const el of targets) h.mousedown(el);
    const ms = (Date.now() - t0) / steps;
    writes += observer.takeRecords().length;
    observer.disconnect();
    return { ms, writes: writes / steps };
  };

  results.push(
    await scenario('selecting a cell in a 3,000-row table touches only the cells whose state changed', () => {
      const small = mount(tallPipe(300));
      const few = selectCost(small, 20);
      small.view.destroy();
      const big = mount(tallPipe(3000));
      const rows = big.root()!.querySelectorAll('tbody tr').length;
      const many = selectCost(big, 20);
      big.view.destroy();
      if (process.env.SHEAF_TABLES_TRACE) {
        console.log(`select: 300 rows ${few.ms.toFixed(1)} ms, ${few.writes} writes; 3,000 rows ${many.ms.toFixed(1)} ms, ${many.writes} writes`);
      }
      // Ten times the rows may not cost ten times as much: well under that, allowing for noise.
      return rows === 3000 && many.writes <= 40 && many.ms <= Math.max(3 * few.ms, 5);
    })
  );

  /*
   * Dragging a block of rows, or a column, through a long table. Each pointer move
   * changes where the drop line is and nothing else, so it may touch the rows or the
   * column the line leaves and the ones it reaches, and never the dimmed block again
   * or the rest of the grid. Class writes are counted with a mutation observer, as
   * above, and the row case is timed against a table a tenth the size.
   */
  const attrWrites = (h: Harness, act: () => void): number => {
    let writes = 0;
    const observer = new G.MutationObserver((list: MutationRecord[]) => (writes += list.length));
    observer.observe(h.grid()!, { attributes: true, subtree: true });
    act();
    writes += observer.takeRecords().length;
    observer.disconnect();
    return writes;
  };
  /** Per move of a 50-row block dragged by its row numbers: milliseconds, writes, and the marks it left. */
  const rowDragCost = (h: Harness, steps: number): { ms: number; writes: number; dimmed: number; lines: number } => {
    const gut = (r: number): HTMLElement => h.root()!.querySelectorAll('tbody .sheaf-table-gutter')[r] as HTMLElement;
    h.mousedown(gut(100));
    mouseup();
    h.mousedown(gut(149), { shiftKey: true });
    mouseup();
    h.mousedown(gut(100), { clientY: 0 });
    // The first move is the one that dims the block; the moves after it are measured.
    mousemove(h.cell(199, 1)!, { clientY: 100 });
    const targets = Array.from({ length: steps }, (_, i) => h.cell(200 + (i % 2), 1)!);
    let ms = 0;
    const writes = attrWrites(h, () => {
      const t0 = Date.now();
      for (const el of targets) mousemove(el, { clientY: 100 });
      ms = (Date.now() - t0) / steps;
    });
    const dimmed = h.root()!.querySelectorAll('tr.is-row-dragging').length;
    const lines = h.root()!.querySelectorAll('tr.is-drop-before, tr.is-drop-after').length;
    return { ms, writes: writes / steps, dimmed, lines };
  };

  results.push(
    await scenario('dragging rows or a column through a 3,000-row table repaints only where the drop line moved', () => {
      const small = mount(tallPipe(300));
      const few = rowDragCost(small, 20);
      mouseup({ clientY: 100 });
      small.view.destroy();
      const big = mount(tallPipe(3000));
      const many = rowDragCost(big, 20);
      // The drop moves the block and redraws, and no mark outlives it.
      mouseup({ clientY: 100 });
      const rowsCleared = big.root()!.querySelectorAll('.is-row-dragging, .is-drop-before, .is-drop-after').length;
      big.view.destroy();

      const cols = mount(tallPipe(3000));
      cols.mousedown(cols.cell(-1, 1)!, { clientX: 10 });
      mouseup({ clientX: 10 });
      cols.mousedown(cols.cell(-1, 1)!, { clientX: 0 });
      mousemove(cols.cell(-1, 3)!, { clientX: 100 });
      const colTargets = Array.from({ length: 6 }, (_, i) => cols.cell(-1, 2 + (i % 2))!);
      const colWrites = attrWrites(cols, () => {
        for (const el of colTargets) mousemove(el, { clientX: 100 });
      }) / colTargets.length;
      const colDimmed = cols.root()!.querySelectorAll('.is-col-dragging').length;
      const colLine = cols.root()!.querySelectorAll('.is-col-drop-after').length;
      const colWrong = cols.root()!.querySelectorAll('[data-c="2"].is-col-drop-after').length;
      mouseup({ clientX: 100 });
      const colsCleared = cols.root()!.querySelectorAll('.is-col-dragging, .is-col-drop-before, .is-col-drop-after').length;
      cols.view.destroy();
      if (process.env.SHEAF_TABLES_TRACE) {
        console.log(
          `row drag: 300 rows ${few.ms.toFixed(2)} ms, ${few.writes} writes; 3,000 rows ${many.ms.toFixed(2)} ms, ${many.writes} writes; ` +
            `column drag: ${colWrites} writes per move`
        );
      }
      return (
        // The block stays dimmed and one row carries the line, move after move.
        many.dimmed === 50 &&
        many.lines === 1 &&
        // A move takes the line off one row and puts it on another: the two rows it changed.
        many.writes <= 4 &&
        many.ms <= Math.max(3 * few.ms, 5) &&
        rowsCleared === 0 &&
        // A column's line runs the height of the table, so a move rewrites the column it
        // left and the one it reached, and leaves the dimmed column alone.
        colDimmed === 3001 &&
        colLine === 3001 &&
        colWrong === 0 &&
        colWrites <= 2 * 3001 + 4 &&
        colsCleared === 0
      );
    })
  );

  results.push(
    await scenario('a column header is named by its own text, not by the text and the chevron inside it together', () => {
      // A header takes its accessible name from what is inside it, and the chevron is
      // a labelled button inside it. Without a name of its own, a screen reader read
      // "Fruit Column Fruit commands" every time the active cell moved across a column.
      const h = mount(RAGGED);
      const header = h.cell(-1, 0)!;
      const chevron = header.querySelector('.sheaf-table-chevron');
      const name = header.getAttribute('aria-label') ?? '';
      const chevronName = chevron?.getAttribute('aria-label') ?? '';
      // Redraw the header the way an edit does, and check the name survives it.
      h.dblclick(header);
      h.keydown(h.input(-1, 0)!, 'Escape');
      const afterRedraw = h.cell(-1, 0)!.getAttribute('aria-label') ?? '';
      h.view.destroy();
      return (
        name === header.textContent!.replace(chevron?.textContent ?? '', '').trim() &&
        !name.includes('commands') &&
        chevronName.includes('commands') &&
        afterRedraw === name
      );
    })
  );

  // ---- Tables inside a container: a list item, a blockquote ------------------
  //
  // A table that sits inside a list item or a blockquote carries its container's
  // marks on every line. A row the grid writes has to carry them too, or the line
  // falls out of the container and cuts the table short.

  /** Tab past the last cell of body row `r`, then type a new row of two values, the way a person adds a record. */
  const tabInRow = async (h: Harness, r: number, a: string, b: string): Promise<string> => {
    h.dblclick(h.cell(r, 1)!);
    h.keydown(h.input(r, 1)!, 'Tab');
    h.dblclick(h.cell(r + 1, 0)!);
    h.input(r + 1, 0)!.value = a;
    h.keydown(h.input(r + 1, 0)!, 'Tab');
    h.dblclick(h.cell(r + 1, 1)!);
    h.input(r + 1, 1)!.value = b;
    h.keydown(h.input(r + 1, 1)!, 'Enter');
    return h.commit();
  };

  results.push(
    await scenario('a row added by Tab to an outer-less table in a list item keeps the item indentation', async () => {
      const src = '- item\n\n  a | b\n  --|--\n  1 | 2\n\n- next\n';
      const h = mount(src);
      const doc = await tabInRow(h, 0, '3', '4');
      // The grid redrawn from the file still holds the new row, so the table was not cut short.
      const shown = [h.cell(1, 0), h.cell(1, 1)].map((el) => el?.textContent?.trim() ?? '').join('|');
      h.view.destroy();
      const lines = doc.split('\n');
      const added = lines[5] ?? '';
      const others = [...lines.slice(0, 5), ...lines.slice(6)].join('\n');
      // Two spaces put the row in the item; four would make it an indented code block.
      const indent = /^ */.exec(added)![0].length;
      return (
        others === src &&
        indent >= 2 &&
        indent < 6 &&
        added.split('|').map((s) => s.trim()).filter(Boolean).join('|') === '3|4' &&
        shown === '3|4'
      );
    })
  );

  const LIST_CSV = '- item\n\n  ```csv\n  a,b\n  1,2\n  ```\n\n- next\n';

  results.push(
    await scenario('a csv block in a list item shows its values without the item indentation', () => {
      const h = mount(LIST_CSV);
      const shown = [h.cell(-1, 0), h.cell(-1, 1), h.cell(0, 0), h.cell(0, 1)].map((el) => el?.textContent ?? '');
      h.view.destroy();
      return shown.join('|') === 'a|b|1|2';
    })
  );

  results.push(
    await scenario('a row added by Tab to a csv block in a list item stays in the item', async () => {
      const h = mount(LIST_CSV);
      const doc = await tabInRow(h, 0, '3', '4');
      // The grid redrawn from the file still holds the new record, so the block was not cut short.
      const shown = [h.cell(1, 0), h.cell(1, 1)].map((el) => el?.textContent ?? '').join('|');
      h.view.destroy();
      return doc === LIST_CSV.replace('  1,2\n', '  1,2\n  3,4\n') && shown === '3|4';
    })
  );

  results.push(
    await scenario('an edited cell of a csv block in a list item rewrites its line with the indentation kept', async () => {
      const h = mount(LIST_CSV);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = '9';
      h.keydown(h.input(0, 0)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === LIST_CSV.replace('  1,2\n', '  9,2\n');
    })
  );

  results.push(
    await scenario('a tsv block in a list item keeps the indentation on a row it adds', async () => {
      const src = '- item\n\n  ```tsv\n  a\tb\n  1\t2\n  ```\n\n- next\n';
      const h = mount(src);
      const doc = await tabInRow(h, 0, '3', '4');
      h.view.destroy();
      return doc === src.replace('  1\t2\n', '  1\t2\n  3\t4\n');
    })
  );

  results.push(
    await scenario('Copy ref on a csv block in a list item names the row the record is on', () => {
      const h = mount(LIST_CSV);
      const span = tableRowSourceAt(h.cell(0, 0));
      const text = span ? h.view.state.sliceDoc(span.from, span.to) : '';
      h.view.destroy();
      return text.trim() === '1,2';
    })
  );

  const QUOTE = 'Intro.\n\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n> | 3 | 4 |\n\nAfter.\n';

  results.push(
    await scenario('a table inside a blockquote is drawn as a grid', () => {
      const h = mount(QUOTE);
      const shown = [h.cell(-1, 0), h.cell(-1, 1), h.cell(0, 0), h.cell(1, 1)].map((el) => el?.textContent?.trim() ?? '');
      h.view.destroy();
      return shown.join('|') === 'a|b|1|4';
    })
  );

  results.push(
    await scenario('a quoted table carries the quote’s bar, and a table outside a quote does not', () => {
      const quoted = mount(QUOTE);
      const inQuote = quoted.view.dom.querySelector('.sheaf-table')?.classList.contains('is-quoted');
      quoted.view.destroy();
      const plain = mount(QUOTE.replace(/^> /gm, ''));
      const outside = plain.view.dom.querySelector('.sheaf-table')?.classList.contains('is-quoted');
      plain.view.destroy();
      return inQuote === true && outside === false;
    })
  );

  results.push(
    await scenario('an edited cell of a quoted table changes only its own line and keeps the quote mark', async () => {
      const h = mount(QUOTE);
      h.dblclick(h.cell(0, 1)!);
      h.input(0, 1)!.value = 'x';
      h.keydown(h.input(0, 1)!, 'Enter');
      const doc = await h.commit();
      h.view.destroy();
      return doc === QUOTE.replace('> | 1 | 2 |', '> | 1 | x |');
    })
  );

  results.push(
    await scenario('Insert row below in a quoted table writes the new row inside the quote', async () => {
      const h = mount(QUOTE);
      const ran = act(h, 0, 0, 'Insert row below');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === QUOTE.replace('> | 1 | 2 |\n', '> | 1 | 2 |\n> |   |   |\n');
    })
  );

  results.push(
    await scenario('a row added by Tab to a quoted table stays in the quote', async () => {
      const h = mount(QUOTE);
      const doc = await tabInRow(h, 1, '5', '6');
      const shown = [h.cell(2, 0), h.cell(2, 1)].map((el) => el?.textContent?.trim() ?? '').join('|');
      h.view.destroy();
      return doc === QUOTE.replace('> | 3 | 4 |\n', '> | 3 | 4 |\n> | 5 | 6 |\n') && shown === '5|6';
    })
  );

  results.push(
    await scenario('row and column commands in a quoted table keep the quote mark on every line', async () => {
      const outcomes: boolean[] = [];
      const run = async (r: number, c: number, label: string): Promise<string> => {
        const h = mount(QUOTE);
        act(h, r, c, label);
        const doc = await h.commit();
        h.view.destroy();
        return doc;
      };
      outcomes.push((await run(0, 0, 'Delete row')) === QUOTE.replace('> | 1 | 2 |\n', ''));
      outcomes.push((await run(0, 0, 'Duplicate row')) === QUOTE.replace('> | 1 | 2 |\n', '> | 1 | 2 |\n> | 1 | 2 |\n'));
      outcomes.push((await run(0, 0, 'Move row down')) === QUOTE.replace('> | 1 | 2 |\n> | 3 | 4 |\n', '> | 3 | 4 |\n> | 1 | 2 |\n'));
      const inserted = await run(0, 1, 'Insert column right');
      const deleted = await run(0, 0, 'Delete column');
      const sorted = await run(0, 0, 'Sort column Z to A');
      const padded = await run(0, 0, 'Pad columns to line up');
      const quoted = (doc: string): boolean =>
        doc.split('\n').slice(2, 6).every((l) => l.startsWith('> |')) && doc.startsWith('Intro.\n\n') && doc.endsWith('\n\nAfter.\n');
      outcomes.push(quoted(inserted) && inserted.split('\n')[2].split('|').length === 5);
      outcomes.push(quoted(deleted) && deleted.split('\n')[4] === '> | 2 |');
      outcomes.push(sorted === QUOTE.replace('> | 1 | 2 |\n> | 3 | 4 |\n', '> | 3 | 4 |\n> | 1 | 2 |\n'));
      outcomes.push(quoted(padded));
      return outcomes.every(Boolean);
    })
  );

  results.push(
    await scenario('a quoted table without a space after the quote mark keeps that spelling', async () => {
      const src = 'Intro.\n\n>| a | b |\n>| - | - |\n>| 1 | 2 |\n\nAfter.\n';
      const h = mount(src);
      const ran = act(h, 0, 0, 'Insert row below');
      const doc = await h.commit();
      h.view.destroy();
      return ran && doc === src.replace('>| 1 | 2 |\n', '>| 1 | 2 |\n>|   |   |\n');
    })
  );

  results.push(
    await scenario('Copy ref on a quoted table names the row the cell is on', () => {
      const h = mount(QUOTE);
      const span = tableRowSourceAt(h.cell(1, 0));
      const text = span ? h.view.state.sliceDoc(span.from, span.to) : '';
      h.view.destroy();
      return text.endsWith('| 3 | 4 |');
    })
  );

  results.push(
    await scenario('a table in a nested quote is left intact whether or not it is drawn', async () => {
      const src = 'Intro.\n\n> > | a | b |\n> > | - | - |\n> > | 1 | 2 |\n\nAfter.\n';
      const h = mount(src);
      let doc = h.doc();
      if (h.cell(0, 1)) {
        h.dblclick(h.cell(0, 1)!);
        h.input(0, 1)!.value = 'x';
        h.keydown(h.input(0, 1)!, 'Enter');
        doc = await h.commit();
        h.view.destroy();
        return doc === src.replace('> > | 1 | 2 |', '> > | 1 | x |');
      }
      h.view.destroy();
      return doc === src;
    })
  );

  results.push(
    await scenario('a csv block inside a blockquote keeps the quote mark on a row it adds', async () => {
      const src = 'Intro.\n\n> ```csv\n> a,b\n> 1,2\n> ```\n\nAfter.\n';
      const h = mount(src);
      const doc = await tabInRow(h, 0, '3', '4');
      h.view.destroy();
      return doc === src.replace('> 1,2\n', '> 1,2\n> 3,4\n');
    })
  );

  // ---- insert and delete keys on whole rows and columns ----
  const AX = 'Intro.\n\n| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n\nAfter.\n';
  // As a Mac sends them, where Alt turns = and - into other characters, and as Ctrl+Alt does elsewhere.
  const plus = { metaKey: true, altKey: true, code: 'Equal' };
  const minus = { metaKey: true, altKey: true, code: 'Minus' };
  /** Send an insert or delete key to the grid; returns whether the grid took it. */
  const axisKey = (h: Harness, key: string, opts: any): boolean => {
    const e = new G.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    h.grid()!.dispatchEvent(e);
    return e.defaultPrevented;
  };
  /** What the menu command `label` writes from cell `r`,`c` of `src`. */
  const byMenu = async (src: string, r: number, c: number, label: string): Promise<string> => {
    const m = mount(src);
    act(m, r, c, label);
    const doc = await m.commit();
    m.view.destroy();
    return doc;
  };

  results.push(
    await scenario('with a row picked by its number, Cmd+Alt+= inserts a row below it and picks the new row', async () => {
      const h = mount(AX);
      h.mousedown(gutter(h, 1));
      mouseup();
      const taken = axisKey(h, '≠', plus);
      const once = h.doc();
      const whole = gutter(h, 2).classList.contains('is-sel-whole');
      // The new row is picked, so the key goes on inserting.
      axisKey(h, '=', { ctrlKey: true, altKey: true });
      const doc = await h.commit();
      h.view.destroy();
      return (
        taken &&
        whole &&
        once === AX.replace('| b | 2 |\n', '| b | 2 |\n|   |   |\n') &&
        doc === AX.replace('| b | 2 |\n', '| b | 2 |\n|   |   |\n|   |   |\n')
      );
    })
  );

  results.push(
    await scenario('with rows picked, Cmd+Alt+- deletes them and writes what Delete rows writes', async () => {
      const h = mount(AX);
      h.mousedown(gutter(h, 0));
      mouseup();
      h.mousedown(gutter(h, 1), { shiftKey: true });
      mouseup();
      const taken = axisKey(h, '–', minus);
      const doc = await h.commit();
      h.view.destroy();
      return taken && doc === AX.replace('| a | 1 |\n| b | 2 |\n', '') && doc === (await byMenuRows());
      async function byMenuRows(): Promise<string> {
        const m = mount(AX);
        m.mousedown(gutter(m, 0));
        mouseup();
        m.mousedown(gutter(m, 1), { shiftKey: true });
        mouseup();
        act(m, 0, 0, 'Delete rows');
        const out = await m.commit();
        m.view.destroy();
        return out;
      }
    })
  );

  results.push(
    await scenario('with a row picked by Shift+Space, Ctrl+Alt+- deletes it', async () => {
      const h = mount(AX);
      h.mousedown(h.cell(2, 1)!);
      mouseup();
      h.keydown(h.grid()!, ' ', { shiftKey: true });
      const taken = axisKey(h, '-', { ctrlKey: true, altKey: true, code: 'Minus' });
      const doc = await h.commit();
      h.view.destroy();
      return taken && doc === AX.replace('| c | 3 |\n', '');
    })
  );

  results.push(
    await scenario('with a column picked by its header, Cmd+Alt+= inserts a column to its right as Insert column right does', async () => {
      const h = mount(AX);
      h.mousedown(h.cell(-1, 0)!);
      mouseup();
      const taken = axisKey(h, '≠', plus);
      const whole = h.root()!.querySelector('thead th[data-c="1"]')!.classList.contains('is-sel-whole');
      const doc = await h.commit();
      h.view.destroy();
      const menu = await byMenu(AX, -1, 0, 'Insert column right');
      return taken && whole && doc === menu && doc !== AX && doc.startsWith('Intro.\n\n| n |') && doc.endsWith('\n\nAfter.\n');
    })
  );

  results.push(
    await scenario('with a column picked by Ctrl+Space, Cmd+Alt+- deletes it as Delete column does', async () => {
      const h = mount(AX);
      h.mousedown(h.cell(0, 1)!);
      mouseup();
      h.keydown(h.grid()!, ' ', { ctrlKey: true });
      const taken = axisKey(h, '–', minus);
      const doc = await h.commit();
      h.view.destroy();
      const menu = await byMenu(AX, -1, 1, 'Delete column');
      return taken && doc === menu && !doc.includes('| v |') && doc.endsWith('\n\nAfter.\n');
    })
  );

  results.push(
    await scenario('Cmd+Alt+- on the only column leaves the table as it is, as the menu does', async () => {
      const src = 'Intro.\n\n| n |\n| - |\n| a |\n\nAfter.\n';
      const h = mount(src);
      h.mousedown(h.cell(-1, 0)!);
      mouseup();
      // Taken all the same, so the key does not go on to do something else.
      const taken = axisKey(h, '–', minus);
      const doc = await h.commit();
      h.view.destroy();
      return taken && doc === src;
    })
  );

  results.push(
    await scenario('with only cells picked, the insert and delete keys do nothing and are left to others', async () => {
      const h = mount(AX);
      dragCells(h, [0, 0], [1, 0]);
      const plusTaken = axisKey(h, '≠', plus);
      const minusTaken = axisKey(h, '–', minus);
      const doc = await h.commit();
      h.view.destroy();
      return !plusTaken && !minusTaken && doc === AX;
    })
  );

  results.push(
    await scenario('in an open cell the insert and delete keys are not taken by the grid', async () => {
      const h = mount(AX);
      h.mousedown(gutter(h, 0));
      mouseup();
      h.dblclick(h.cell(0, 1)!);
      const field = h.input(0, 1)!;
      const e1 = new G.KeyboardEvent('keydown', { key: '≠', bubbles: true, cancelable: true, ...plus });
      field.dispatchEvent(e1);
      const e2 = new G.KeyboardEvent('keydown', { key: '–', bubbles: true, cancelable: true, ...minus });
      field.dispatchEvent(e2);
      // The cell editor keeps its keys to itself; one that reached the grid anyway
      // while the cell is open is still not the grid's to take.
      const reached = axisKey(h, '≠', plus);
      const stillOpen = !!h.input(0, 1) && !reached;
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return stillOpen && rows === 3 && doc === AX;
    })
  );

  results.push(
    await scenario('the table menu shows the insert and delete keys only when they would act', () => {
      const h = mount(AX);
      mountContextMenu(h.view.dom, { getView: () => h.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      const keysIn = (target: Element): Record<string, string> => {
        h.mousedown(target, { button: 2 });
        mouseup({ button: 2 });
        target.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));
        const out: Record<string, string> = {};
        for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item'))) {
          const k = b.querySelector('.sheaf-ctx-key')?.textContent;
          if (k) out[b.querySelector('span')!.textContent!] = k;
        }
        document.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return out;
      };
      h.mousedown(gutter(h, 1));
      mouseup();
      const onRow = keysIn(h.cell(1, 0)!);
      h.mousedown(h.cell(-1, 1)!);
      mouseup();
      const onCol = keysIn(h.cell(0, 1)!);
      h.mousedown(h.cell(0, 0)!);
      mouseup();
      const onCell = keysIn(h.cell(0, 0)!);
      h.view.destroy();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
      const ins = hint('Mod-Alt-=');
      const del = hint('Mod-Alt--');
      return (
        del.endsWith('-') &&
        JSON.stringify(onRow) === JSON.stringify({ 'Copy ref': onRow['Copy ref'], 'Insert row below': ins, 'Delete row': del }) &&
        JSON.stringify(onCol) === JSON.stringify({ 'Copy ref': onCol['Copy ref'], 'Insert column right': ins, 'Delete column': del }) &&
        !Object.keys(onCell).some((k) => k !== 'Copy ref')
      );
    })
  );

  results.push(...(await viewChecks()));

  return results;
}

// ---- View blocks: ```view drawn as the grid its query describes ------------

const TASKS =
  '```csv id=tasks\nfeature,status,estimate\nSearch,Open,5\nExport,Done,2\nImport,Open,8\nSync,Blocked,3\n```';

/** A document holding the tasks block and a view of it. */
const withView = (query: string): string => P + TASKS + '\n\n```view\n' + query + '\n```\n';

/** What a drawn view shows: its column headers, then each row's cells joined by commas. */
function viewShows(h: Harness, which = 0): { head: string[]; rows: string[] } | null {
  const v = h.view.dom.querySelectorAll('.sheaf-view')[which];
  if (!v) return null;
  return {
    // A header's name is on its sort button, beside the sort mark and the menu button.
    head: Array.from(v.querySelectorAll('thead th')).map((th) => th.querySelector('.sheaf-view-head-name')?.textContent ?? th.textContent ?? ''),
    rows: Array.from(v.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td:not(.sheaf-view-mark)'))
        .map((td) => td.textContent ?? '')
        .join(',')
    ),
  };
}

/** The messages a drawn view shows, errors and notes alike. */
const viewMessages = (h: Harness, which = 0): string[] =>
  Array.from(h.view.dom.querySelectorAll('.sheaf-view')[which]?.querySelectorAll('.sheaf-view-notes p') ?? []).map(
    (p) => `${p.className}: ${p.textContent}`
  );

async function viewChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('a view of a named block shows the rows its where keeps, in its sort order, with its show columns', () => {
      const doc = withView('from: #tasks\nwhere: status != Done\nsort: estimate desc\nshow: estimate, feature');
      const h = mount(doc, [viewBlocks]);
      const shown = viewShows(h);
      const count = h.view.dom.querySelector('.sheaf-view-count')?.textContent;
      const unchanged = h.doc() === doc;
      h.view.destroy();
      return (
        JSON.stringify(shown) ===
          JSON.stringify({ head: ['estimate', 'feature'], rows: ['8,Import', '5,Search', '3,Sync'] }) &&
        count === '3 of 4 rows' &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('a view with mistakes shows every one of them and still draws what it can', () => {
      const doc = withView('from: #tasks\nwhere: owner = Sam; status = Open\nsort: nothing\nlimit: 3');
      const h = mount(doc, [viewBlocks]);
      const shown = viewShows(h);
      const said = viewMessages(h);
      h.view.destroy();
      // The body starts on the document line after the fence: P is two lines, TASKS
      // seven, a blank line, then the fence.
      const first = doc.split('\n').indexOf('```view') + 2;
      return (
        JSON.stringify(shown?.rows) === JSON.stringify(['Search,Open,5', 'Import,Open,8']) &&
        said.some((s) => s.startsWith('sheaf-view-error') && s.includes(`Line ${first + 3}:`) && s.includes('Unknown key "limit"')) &&
        said.some((s) => s.includes(`Line ${first + 1}:`) && s.includes('No column is named "owner"')) &&
        said.some((s) => s.includes(`Line ${first + 2}:`) && s.includes('No column is named "nothing"'))
      );
    })
  );

  results.push(
    await scenario('a view naming a block that is not there says so in place and draws no table', () => {
      const h = mount(withView('from: #todo'), [viewBlocks]);
      const said = viewMessages(h);
      const table = h.view.dom.querySelector('.sheaf-view table');
      h.view.destroy();
      return !table && said.length === 1 && said[0].includes('No CSV block in this document is named "todo"');
    })
  );

  results.push(
    await scenario('a view with no from line says what it needs', () => {
      const h = mount(withView('sort: estimate'), [viewBlocks]);
      const said = viewMessages(h);
      h.view.destroy();
      return said.some((s) => s.includes('A view needs a "from" line'));
    })
  );

  results.push(
    await scenario('a view of a name two blocks share refuses to guess', () => {
      const doc = P + TASKS + '\n\n' + TASKS + '\n\n```view\nfrom: #tasks\n```\n';
      const h = mount(doc, [viewBlocks]);
      const said = viewMessages(h);
      const table = h.view.dom.querySelector('.sheaf-view table');
      h.view.destroy();
      return !table && said.some((s) => s.includes('2 blocks in this document are named "tasks"'));
    })
  );

  results.push(...(await boardChecks()));
  results.push(...(await pipeBoardChecks()));

  results.push(
    await scenario('a view follows its block: an edit to the block redraws the view', () => {
      const doc = withView('from: #tasks\nwhere: status = Open');
      const h = mount(doc, [viewBlocks]);
      const before = viewShows(h)?.rows.length;
      const at = doc.indexOf('Export,Done');
      h.view.dispatch({ changes: { from: at + 'Export,'.length, to: at + 'Export,Done'.length, insert: 'Open' } });
      const after = viewShows(h)?.rows;
      h.view.destroy();
      return before === 2 && JSON.stringify(after) === JSON.stringify(['Search,Open,5', 'Export,Open,2', 'Import,Open,8']);
    })
  );

  results.push(
    await scenario('a caret in a view block shows its query as text, and leaving draws it again', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      const drawn = !!h.view.dom.querySelector('.sheaf-view');
      h.view.dispatch({ selection: { anchor: doc.indexOf('from: #tasks') + 3 } });
      const text = !h.view.dom.querySelector('.sheaf-view');
      h.view.dispatch({ selection: { anchor: 0 } });
      const again = !!h.view.dom.querySelector('.sheaf-view');
      h.view.destroy();
      return drawn && text && again;
    })
  );

  results.push(
    await scenario('Edit query puts the caret in the query, which shows it as text', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      (h.view.dom.querySelector('.sheaf-view-edit') as HTMLButtonElement).click();
      const text = !h.view.dom.querySelector('.sheaf-view');
      const caret = h.view.state.selection.main.head;
      h.view.destroy();
      return text && caret === doc.indexOf('from: #tasks') + 'from: #tasks'.length;
    })
  );

  results.push(
    await scenario('a view of a file asks the host for it, says it is reading, and draws it when it comes', async () => {
      const asked: any[] = [];
      setDataFileHost((m) => asked.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\nwhere: status = Open\n```\n';
      const h = mount(doc, [viewBlocks]);
      const reading = viewMessages(h).some((s) => s.includes('Reading data/tasks.csv'));
      const request = asked.length === 1 && asked[0].type === 'dataFileRead' && asked[0].path === 'data/tasks.csv' && typeof asked[0].id === 'string';
      handleDataFile({ path: 'data/tasks.csv', text: '﻿feature,status\r\nSearch,Open\r\nExport,Done\r\n' });
      await tick();
      const shown = viewShows(h);
      // The file changing on disk arrives as the same message again.
      handleDataFile({ path: 'data/tasks.csv', text: 'feature,status\nSearch,Open\nExport,Open\n' });
      await tick();
      const followed = viewShows(h)?.rows;
      const unchanged = h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return (
        reading &&
        request &&
        JSON.stringify(shown) === JSON.stringify({ head: ['feature', 'status'], rows: ['Search,Open'] }) &&
        JSON.stringify(followed) === JSON.stringify(['Search,Open', 'Export,Open']) &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('a file the host cannot read is an error naming its path, never an empty table', async () => {
      setDataFileHost(() => {});
      const h = mount(P + '```view\nfrom: gone.csv\n```\n', [viewBlocks]);
      handleDataFile({ path: 'gone.csv', error: 'gone.csv was not found. A view reads its file relative to this document.' });
      await tick();
      const said = viewMessages(h);
      const table = h.view.dom.querySelector('.sheaf-view table');
      h.view.destroy();
      setDataFileHost(null);
      return !table && said.length === 1 && said[0].startsWith('sheaf-view-error') && said[0].includes('gone.csv was not found');
    })
  );

  results.push(
    await scenario('a host that never answers leaves a note in place after a short wait, not a view reading for ever', async () => {
      setDataFileHost(() => {}, 30);
      const h = mount(P + '```view\nfrom: data.csv\n```\n', [viewBlocks]);
      const waiting = viewMessages(h).some((s) => s.includes('Reading data.csv'));
      await new Promise((r) => setTimeout(r, 80));
      const said = viewMessages(h);
      h.view.destroy();
      setDataFileHost(null);
      return waiting && said.length === 1 && said[0].startsWith('sheaf-view-error') && said[0].includes('data.csv') && said[0].includes('nothing came back');
    })
  );

  results.push(
    await scenario('a view naming a file that is not csv or tsv says so and asks the host for nothing', () => {
      const asked: any[] = [];
      setDataFileHost((m) => asked.push(m));
      const h = mount(P + '```view\nfrom: notes.md\n```\n', [viewBlocks]);
      const said = viewMessages(h);
      h.view.destroy();
      setDataFileHost(null);
      return asked.length === 0 && said.some((s) => s.includes('"notes.md" is neither'));
    })
  );

  results.push(...(await viewEditChecks()));
  results.push(...(await viewHeaderChecks()));
  results.push(...(await moveToFileChecks()));

  return results;
}

// ---- Moving a data block out to a file, and bringing a file back in ----------

/** Run the table command labelled `label` from the right-click menu of the cell under `at`. */
function runTableCommand(at: Element | null, label: string): boolean {
  const action = (tableActionsAt(at) ?? []).find((a) => a.label === label);
  if (!action) return false;
  action.run();
  return true;
}

/** The note a command left at the foot of the page, as `class: text`, or null. */
const pageNote = (h: Harness): string | null => {
  const note = h.view.dom.querySelector('.sheaf-page-note');
  return note ? `${note.className}: ${note.querySelector('span')?.textContent ?? ''}` : null;
};

const MOVABLE = '```csv id=tasks\nfeature,status\n"Search, fast",Open\nExport,  Done\n```';

async function moveToFileChecks(): Promise<Result[]> {
  const results: Result[] = [];
  const hosted = (): any[] => {
    const sent: any[] = [];
    setDataFileHost((m) => sent.push(m));
    setMoveToFile(moveBlockToFile);
    return sent;
  };
  const unhost = (): void => {
    setDataFileHost(null);
    setMoveToFile(null);
  };

  results.push(
    await scenario('Move to file is on a CSV block’s menu, last and in a group of its own, and on no pipe table’s', () => {
      setMoveToFile(moveBlockToFile);
      const csv = mount(P + MOVABLE, [viewBlocks]);
      const actions = tableActionsAt(csv.cell(0, 0)) ?? [];
      const last = actions[actions.length - 1];
      csv.view.destroy();
      const pipe = mount(PIPE, [viewBlocks]);
      const onPipe = (tableActionsAt(pipe.cell(0, 0)) ?? []).some((a) => a.label === 'Move to file');
      pipe.view.destroy();
      // A data file's own grid has nothing to move, so the page offers it no mover.
      setMoveToFile(null);
      const bare = mount(P + MOVABLE, [viewBlocks]);
      const onFileGrid = (tableActionsAt(bare.cell(0, 0)) ?? []).some((a) => a.label === 'Move to file');
      bare.view.destroy();
      return last?.label === 'Move to file' && last.separator === true && !last.disabled && !onPipe && !onFileGrid;
    })
  );

  results.push(
    await scenario('Move to file writes the block’s body byte for byte to a file named from its id, and changes the document only once the host says it is written', async () => {
      const sent = hosted();
      const doc = P + MOVABLE + '\n\nAfter.\n';
      const h = mount(doc, [viewBlocks, history()]);
      const before = viewShows(h);
      const ran = runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      const ask = sent.find((m) => m.type === 'dataFileCreate');
      const waiting = h.doc() === doc;
      handleDataFileCreated({ id: ask?.id, path: 'tasks.csv' });
      await tick();
      const after = h.doc();
      const shows = viewShows(h);
      const read = sent.some((m) => m.type === 'dataFileRead' && m.path === 'tasks.csv');
      const note = pageNote(h);
      h.view.destroy();
      unhost();
      return (
        ran &&
        before === null &&
        !!ask &&
        ask.path === 'tasks.csv' &&
        ask.text === 'feature,status\n"Search, fast",Open\nExport,  Done\n' &&
        ask.nextFree === true &&
        waiting &&
        after === P + '```view\nfrom: tasks.csv\n```\n\nAfter.\n' &&
        JSON.stringify(shows) === JSON.stringify({ head: ['feature', 'status'], rows: ['Search, fast,Open', 'Export,  Done'] }) &&
        read &&
        note === 'sheaf-page-note: Moved the rows to tasks.csv. The block is now a view of that file.'
      );
    })
  );

  results.push(
    await scenario('Move to file is one undo step: Cmd+Z brings the block back byte for byte and asks the host to remove nothing', async () => {
      const sent = hosted();
      const doc = P + MOVABLE + '\n';
      const h = mount(doc, [viewBlocks, history()]);
      runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      handleDataFileCreated({ id: sent.find((m) => m.type === 'dataFileCreate')?.id, path: 'tasks.csv' });
      await tick();
      const moved = h.doc();
      const depth = undoDepth(h.view.state);
      const count = sent.length;
      undo(h.view);
      const back = h.doc();
      redo(h.view);
      const again = h.doc();
      const quiet = sent.slice(count).every((m) => m.type === 'dataFileRead');
      h.view.destroy();
      unhost();
      return moved !== doc && depth === 1 && back === doc && again === moved && quiet;
    })
  );

  results.push(
    await scenario('a view that read the block by its name reads the file after the move, in the same undo step, and still shows its rows', async () => {
      const sent = hosted();
      const doc = P + MOVABLE + '\n\n```view\nFrom:  #TASKS\nwhere: status = Open\n```\n';
      const h = mount(doc, [viewBlocks, history()]);
      runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      handleDataFileCreated({ id: sent.find((m) => m.type === 'dataFileCreate')?.id, path: 'tasks.csv' });
      await tick();
      const after = h.doc();
      const filtered = viewShows(h, 1)?.rows;
      undo(h.view);
      const back = h.doc();
      h.view.destroy();
      unhost();
      return (
        after === P + '```view\nfrom: tasks.csv\n```\n\n```view\nFrom:  tasks.csv\nwhere: status = Open\n```\n' &&
        JSON.stringify(filtered) === JSON.stringify(['Search, fast,Open']) &&
        back === doc
      );
    })
  );

  results.push(
    await scenario('a block with no id moves to data.csv, and when that name is taken the note says which name it went to', async () => {
      const sent = hosted();
      const doc = P + '```tsv\na\tb\n1\t2\n```\n';
      const h = mount(doc, [viewBlocks]);
      runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      const ask = sent.find((m) => m.type === 'dataFileCreate');
      handleDataFileCreated({ id: ask?.id, path: 'data-2.tsv' });
      await tick();
      const after = h.doc();
      const note = pageNote(h);
      h.view.destroy();
      unhost();
      return (
        ask?.path === 'data.tsv' &&
        ask?.text === 'a\tb\n1\t2\n' &&
        after === P + '```view\nfrom: data-2.tsv\n```\n' &&
        note === 'sheaf-page-note: data.tsv already exists, so the rows went to data-2.tsv. The block is now a view of that file.'
      );
    })
  );

  results.push(
    await scenario('a file the host refuses to write leaves the document untouched and says why', async () => {
      const sent = hosted();
      const doc = P + MOVABLE + '\n';
      const h = mount(doc, [viewBlocks]);
      runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      handleDataFileCreated({ id: sent.find((m) => m.type === 'dataFileCreate')?.id, error: '"tasks.csv" is outside this workspace.' });
      await tick();
      const after = h.doc();
      const note = pageNote(h);
      h.view.destroy();
      unhost();
      return after === doc && note === 'sheaf-page-note is-error: The block was not moved. "tasks.csv" is outside this workspace.';
    })
  );

  results.push(
    await scenario('a block in a quote moves its rows without the quote marks, and the view left in its place keeps them on every line', async () => {
      const sent = hosted();
      const doc = P + '> ```csv id=q\n> a,b\n> 1,2\n> ```\n';
      const h = mount(doc, [viewBlocks]);
      runTableCommand(h.cell(0, 0), 'Move to file');
      await tick();
      const ask = sent.find((m) => m.type === 'dataFileCreate');
      handleDataFileCreated({ id: ask?.id, path: 'q.csv' });
      await tick();
      const after = h.doc();
      h.view.destroy();
      unhost();
      return ask?.text === 'a,b\n1,2\n' && after === P + '> ```view\n> from: q.csv\n> ```\n';
    })
  );

  results.push(
    await scenario('a read-only document leaves Move to file off the right-click menu, and a move asked for anyway writes nothing', () => {
      const sent = hosted();
      const h = mount(P + MOVABLE, [viewBlocks, EditorState.readOnly.of(true)]);
      const rightClick = (tableActionsAt(h.cell(0, 0)) ?? []).some((a) => a.label === 'Move to file');
      moveBlockToFile(h.view, P.length);
      h.view.destroy();
      unhost();
      return !rightClick && sent.length === 0;
    })
  );

  results.push(...(await bringInlineChecks()));
  results.push(...(await renameChecks()));
  results.push(...(await createMissingChecks()));
  results.push(...(await containedViewChecks()));

  return results;
}

async function containedViewChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('a view in a quote and a view in a list item are drawn as views, the quoted one with the quote’s bar, and nothing is written', () => {
      const doc = P + TASKS + '\n\n> ```view\n> from: #tasks\n> where: status = Open\n> ```\n\n- Item\n\n  ```view\n  from: #tasks\n  show: feature\n  ```\n';
      const h = mount(doc, [viewBlocks]);
      const quoted = viewShows(h, 0);
      const listed = viewShows(h, 1);
      const bar = h.view.dom.querySelectorAll('.sheaf-view')[0]?.classList.contains('is-quoted');
      const plain = h.view.dom.querySelectorAll('.sheaf-view')[1]?.classList.contains('is-quoted');
      const unchanged = h.doc() === doc;
      h.view.destroy();
      return (
        JSON.stringify(quoted?.rows) === JSON.stringify(['Search,Open,5', 'Import,Open,8']) &&
        JSON.stringify(listed) === JSON.stringify({ head: ['feature'], rows: ['Search', 'Export', 'Import', 'Sync'] }) &&
        bar === true &&
        plain === false &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('a header sort on a quoted view adds its line inside the quote, and leaves every other line’s bytes', () => {
      const doc = P + TASKS + '\n\n> ```view\n>  from: #tasks\n>\n> where: status != Done\n> ```\n';
      const h = mount(doc, [viewBlocks, history()]);
      clickHead(h, 2, 'sort');
      const sorted = h.doc();
      undo(h.view);
      const back = h.doc();
      h.view.destroy();
      return sorted === doc.replace('> where: status != Done\n', '> where: status != Done\n> sort: estimate\n') && back === doc;
    })
  );

  results.push(
    await scenario('a filter and a hidden column on a view in a list item write their lines at the item’s indent', () => {
      const doc = P + TASKS + '\n\n- Item\n\n  ```view\n  from: #tasks\n  ```\n';
      const h = mount(doc, [viewBlocks]);
      filterBy(h, 1, '=', 'Open');
      const filtered = h.doc();
      (h.view.dom.querySelector('.sheaf-view') as HTMLElement | null)?.querySelector('.sheaf-view-filter')?.dispatchEvent(
        new G.MouseEvent('click', { bubbles: true, cancelable: true })
      );
      (h.view.dom.querySelector('.sheaf-view-menu-hide') as HTMLButtonElement | null)?.click();
      const hidden = h.doc();
      const shows = viewShows(h);
      h.view.destroy();
      return (
        filtered === doc.replace('  from: #tasks\n', '  from: #tasks\n  where: status = Open\n') &&
        hidden === doc.replace('  from: #tasks\n', '  from: #tasks\n  where: status = Open\n  show: status, estimate\n') &&
        JSON.stringify(shows?.head) === JSON.stringify(['status', 'estimate'])
      );
    })
  );

  results.push(
    await scenario('a cell edited through a quoted view writes the one field of a quoted block, marks kept', () => {
      const block = '> ```csv id=q\n> name,state\n> a,Open\n> b,Done\n> ```';
      const doc = P + block + '\n\n> ```view\n> from: #q\n> ```\n';
      const h = mount(doc, [viewBlocks]);
      typeInView(h, 1, 1, 'Open');
      const after = h.doc();
      h.view.destroy();
      return after === doc.replace('> b,Done', '> b,Open');
    })
  );

  results.push(
    await scenario('Bring inline from a quoted view puts the block inside the quote, on every line', async () => {
      setDataFileHost(() => {});
      const doc = P + '> ```view\n> from: t.csv\n> ```\n';
      const h = mount(doc, [viewBlocks]);
      handleDataFile({ path: 't.csv', text: 'a,b\n1,2\n' });
      await tick();
      inlineButton(h)?.click();
      const after = h.doc();
      h.view.destroy();
      setDataFileHost(null);
      return after === P + '> ```csv id=t\n> a,b\n> 1,2\n> ```\n';
    })
  );

  results.push(
    await scenario('a view fence after a list bullet on the same line is left as its text', () => {
      const doc = P + TASKS + '\n\n- ```view\n  from: #tasks\n  ```\n';
      const h = mount(doc, [viewBlocks]);
      const drawn = h.view.dom.querySelectorAll('.sheaf-view').length;
      h.view.destroy();
      return drawn === 0;
    })
  );

  return results;
}

/** The Create button beside a view's missing-file error, when there is one. */
const createButton = (h: Harness): HTMLButtonElement | null => h.view.dom.querySelector('.sheaf-view-create');

async function createMissingChecks(): Promise<Result[]> {
  const results: Result[] = [];
  const missing = (path: string): void =>
    handleDataFile({ path, error: `${path} was not found. A view reads its file relative to this document.`, missing: true });

  results.push(
    await scenario('a view whose file is missing keeps its error and offers Create, which asks the host for a file headed by the show columns, and draws it', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\nshow: feature, status\n```\n';
      const h = mount(doc, [viewBlocks]);
      missing('data/tasks.csv');
      await tick();
      const said = viewMessages(h);
      const button = createButton(h);
      const label = button?.textContent;
      button?.click();
      await tick();
      const ask = sent.find((m) => m.type === 'dataFileCreate');
      handleDataFileCreated({ id: ask?.id, path: 'data/tasks.csv' });
      await tick();
      const shows = viewShows(h);
      const note = pageNote(h);
      const unchanged = h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return (
        said.length === 1 &&
        said[0].startsWith('sheaf-view-error') &&
        said[0].includes('data/tasks.csv was not found') &&
        label === 'Create data/tasks.csv' &&
        ask?.path === 'data/tasks.csv' &&
        ask?.text === 'feature,status\n' &&
        ask?.nextFree === undefined &&
        JSON.stringify(shows) === JSON.stringify({ head: ['feature', 'status'], rows: [] }) &&
        note === 'sheaf-page-note: Created data/tasks.csv with the columns feature, status.' &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('with no show, Create heads the file with the columns the where and then the sort name, each once, quoted where CSV needs it', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const h = mount(P + '```view\nfrom: t.csv\nwhere: status = Open; Owner, lead is empty\nsort: estimate desc, STATUS\n```\n', [viewBlocks]);
      missing('t.csv');
      await tick();
      createButton(h)?.click();
      const ask = sent.find((m) => m.type === 'dataFileCreate');
      h.view.destroy();
      setDataFileHost(null);
      return ask?.text === 'status,"Owner, lead",estimate\n';
    })
  );

  results.push(
    await scenario('a view that names no columns offers Create dimmed, saying what to add, and asks the host for nothing', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const h = mount(P + '```view\nfrom: t.tsv\n```\n', [viewBlocks]);
      missing('t.tsv');
      await tick();
      const button = createButton(h);
      button?.click();
      await tick();
      const asked = sent.some((m) => m.type === 'dataFileCreate');
      h.view.destroy();
      setDataFileHost(null);
      return !!button && button.getAttribute('aria-disabled') === 'true' && button.title.includes('"show" line') && !asked;
    })
  );

  results.push(
    await scenario('a file that could not be read for another reason offers no Create, and a refused create says why and draws nothing', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const h = mount(P + '```view\nfrom: ../out.csv\nshow: a\n```\n\n```view\nfrom: b.csv\nshow: a\n```\n', [viewBlocks]);
      handleDataFile({ path: '../out.csv', error: '"../out.csv" is outside this workspace.' });
      missing('b.csv');
      await tick();
      const buttons = Array.from(h.view.dom.querySelectorAll('.sheaf-view')).map((v) => !!v.querySelector('.sheaf-view-create'));
      createButton(h)?.click();
      handleDataFileCreated({ id: sent.find((m) => m.type === 'dataFileCreate')?.id, error: 'b.csv already exists, and Sheaf never writes over a file.' });
      await tick();
      const note = pageNote(h);
      const table = h.view.dom.querySelectorAll('.sheaf-view')[1]?.querySelector('table');
      h.view.destroy();
      setDataFileHost(null);
      return (
        JSON.stringify(buttons) === JSON.stringify([false, true]) &&
        note === 'sheaf-page-note is-error: b.csv was not created. b.csv already exists, and Sheaf never writes over a file.' &&
        !table
      );
    })
  );

  return results;
}

/** The name above a data block's grid, and the field that renames it while one is open. */
const blockName = (h: Harness, which = 0): HTMLElement | null =>
  (h.view.dom.querySelectorAll('.sheaf-table')[which]?.querySelector('.sheaf-table-id') as HTMLElement | null) ?? null;
const renameField = (h: Harness): HTMLInputElement | null => h.view.dom.querySelector('.sheaf-table-rename');

/** Type `name` into the open rename field and press `key`. */
function typeName(h: Harness, name: string, key = 'Enter'): void {
  const field = renameField(h);
  if (!field) return;
  field.value = name;
  h.keydown(field, key);
}

async function renameChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('clicking a block’s name opens it for typing, and Enter renames the block and every view that reads it, in any case, as one undo step', () => {
      const doc =
        P + TASKS + '\n\n```view\nfrom: #TASKS\nwhere: status = Open\n```\n\n> ```view\n> from:  #tasks\n> ```\n\n```view\nfrom: #tasks-old\n```\n';
      const h = mount(doc, [viewBlocks, history()]);
      blockName(h)?.click();
      const held = renameField(h)?.value;
      typeName(h, 'work');
      const after = h.doc();
      const shown = blockName(h)?.textContent;
      const rows = viewShows(h, 0)?.rows.length;
      undo(h.view);
      const back = h.doc();
      h.view.destroy();
      return (
        held === 'tasks' &&
        after === doc.replace('csv id=tasks', 'csv id=work').replace('from: #TASKS', 'from: #work').replace('from:  #tasks\n', 'from:  #work\n') &&
        shown === '#work' &&
        rows === 2 &&
        back === doc
      );
    })
  );

  results.push(
    await scenario('Enter on a focused block name opens the field, and Escape puts the name back and writes nothing', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      const name = blockName(h)!;
      name.focus();
      h.keydown(name, 'Enter');
      const opened = !!renameField(h) && document.activeElement === renameField(h);
      typeName(h, 'changed', 'Escape');
      const closed = !renameField(h) && blockName(h)?.textContent === '#tasks' && document.activeElement === blockName(h);
      const unchanged = h.doc() === doc;
      h.view.destroy();
      return opened && closed && unchanged;
    })
  );

  results.push(
    await scenario('a name with a space, or one another block has, is refused with the reason beside the field, and nothing is written', () => {
      const doc = P + TASKS + '\n\n```csv id=other\na\n1\n```\n';
      const h = mount(doc, [viewBlocks]);
      blockName(h)?.click();
      typeName(h, 'my tasks');
      const spaced = h.view.dom.querySelector('.sheaf-table-caption .sheaf-table-error')?.textContent ?? '';
      const stillOpen = !!renameField(h) && renameField(h)?.getAttribute('aria-invalid') === 'true';
      typeName(h, 'OTHER');
      const taken = h.view.dom.querySelector('.sheaf-table-caption .sheaf-table-error')?.textContent ?? '';
      const unchanged = h.doc() === doc;
      h.view.destroy();
      return (
        spaced.includes('"my tasks" cannot be a name') &&
        stillOpen &&
        taken.includes('already named "OTHER"') &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('renaming one of two blocks that share a name fixes the clash and leaves the views that read the name alone', () => {
      const doc = P + TASKS + '\n\n' + TASKS.replace('Search', 'Other') + '\n\n```view\nfrom: #tasks\n```\n';
      const h = mount(doc, [viewBlocks]);
      blockName(h, 1)?.click();
      typeName(h, 'tasks2');
      const after = h.doc();
      const said = viewMessages(h);
      h.view.destroy();
      const second = doc.lastIndexOf('csv id=tasks');
      return after === doc.slice(0, second) + 'csv id=tasks2' + doc.slice(second + 'csv id=tasks'.length) && said.length === 0;
    })
  );

  return results;
}

/** A view's Bring inline button, when it has one. */
const inlineButton = (h: Harness, which = 0): HTMLButtonElement | null =>
  (h.view.dom.querySelectorAll('.sheaf-view')[which]?.querySelector('.sheaf-view-inline') as HTMLButtonElement | null) ?? null;

async function bringInlineChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('Bring inline replaces a view of a file with a block named from the file, holding its rows in the document’s line endings, as one undo step', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\n```\n\nAfter.\n';
      const h = mount(doc, [viewBlocks, history()]);
      handleDataFile({ path: 'data/tasks.csv', text: '﻿feature,status\r\n"Search, fast",Open\r\nExport,Done\r\n' });
      await tick();
      const button = inlineButton(h);
      const offered = !!button && !button.hidden && button.getAttribute('aria-disabled') === 'false';
      const count = sent.length;
      button?.click();
      const after = h.doc();
      const name = h.view.dom.querySelector('.sheaf-table .sheaf-table-id')?.textContent;
      const quiet = sent.length === count;
      undo(h.view);
      const back = h.doc();
      h.view.destroy();
      setDataFileHost(null);
      return (
        offered &&
        after === P + '```csv id=tasks\nfeature,status\n"Search, fast",Open\nExport,Done\n```\n\nAfter.\n' &&
        name === '#tasks' &&
        quiet &&
        back === doc
      );
    })
  );

  results.push(
    await scenario('Bring inline is dimmed, saying why, on a view whose where, sort or show would make the block show something else', async () => {
      setDataFileHost(() => {});
      const doc = P + '```view\nfrom: tasks.csv\nwhere: status = Open\nsort: feature\n```\n';
      const h = mount(doc, [viewBlocks]);
      handleDataFile({ path: 'tasks.csv', text: 'feature,status\nSearch,Open\n' });
      await tick();
      const button = inlineButton(h);
      button?.click();
      const unchanged = h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return (
        !!button &&
        !button.hidden &&
        button.getAttribute('aria-disabled') === 'true' &&
        button.title.includes('no where, sort') &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('Bring inline is not offered on a view of a named block, or of a file that has not arrived', () => {
      setDataFileHost(() => {});
      const h = mount(withView('from: #tasks') + '\n```view\nfrom: later.csv\n```\n', [viewBlocks]);
      const onBlock = inlineButton(h, 0);
      const onWaiting = inlineButton(h, 1);
      h.view.destroy();
      setDataFileHost(null);
      return !!onBlock && onBlock.hidden && !!onWaiting && onWaiting.hidden;
    })
  );

  results.push(
    await scenario('a file brought inline whose name a block already has takes the next free name, and a note says so', async () => {
      setDataFileHost(() => {});
      const doc = P + TASKS + '\n\n```view\nfrom: tasks.csv\n```\n';
      const h = mount(doc, [viewBlocks]);
      handleDataFile({ path: 'tasks.csv', text: 'a,b\n1,2\n' });
      await tick();
      inlineButton(h)?.click();
      const after = h.doc();
      const note = pageNote(h);
      h.view.destroy();
      setDataFileHost(null);
      return (
        after === P + TASKS + '\n\n```csv id=tasks-2\na,b\n1,2\n```\n' &&
        note === 'sheaf-page-note: A block is already named tasks, so this one is named tasks-2.'
      );
    })
  );

  results.push(
    await scenario('a file holding a line that reads as a fence is brought inline inside a longer fence, so the block keeps every row', async () => {
      setDataFileHost(() => {});
      const doc = P + '```view\nfrom: odd rows.tsv\n```\n';
      const h = mount(doc, [viewBlocks]);
      handleDataFile({ path: 'odd rows.tsv', text: 'a\n```\nb\n' });
      await tick();
      inlineButton(h)?.click();
      const after = h.doc();
      h.view.destroy();
      setDataFileHost(null);
      return after === P + '````tsv id=odd-rows\na\n```\nb\n````\n';
    })
  );

  return results;
}

// ---- A view's header controls: sort, filter and hide, written into the query ----

/** A view's header button for source column `col`: its sort, or its menu. */
const viewHead = (h: Harness, col: number, kind: 'sort' | 'filter'): HTMLButtonElement | null =>
  h.view.dom.querySelector(`.sheaf-view thead th[data-c="${col}"] .sheaf-view-${kind}`);

/** Click a view's header button, holding Shift when asked. */
function clickHead(h: Harness, col: number, kind: 'sort' | 'filter', shiftKey = false): boolean {
  const b = viewHead(h, col, kind);
  if (!b) return false;
  b.dispatchEvent(new G.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  return true;
}

/** The query's body lines of the first view in `doc`. */
const viewBody = (doc: string): string => doc.slice(doc.indexOf('```view\n') + 8, doc.lastIndexOf('\n```'));

/** Open the header menu for `col`, set its operator and value, and press Apply. */
function filterBy(h: Harness, col: number, op: string, value: string): boolean {
  if (!clickHead(h, col, 'filter')) return false;
  const menu = h.view.dom.querySelector('.sheaf-view-menu');
  const select = menu?.querySelector('.sheaf-view-menu-op') as HTMLSelectElement | null;
  const input = menu?.querySelector('.sheaf-view-menu-value') as HTMLInputElement | null;
  if (!select || !input) return false;
  select.value = op;
  select.dispatchEvent(new G.Event('change', { bubbles: true }));
  input.value = value;
  (menu!.querySelector('.sheaf-view-menu-apply') as HTMLButtonElement).click();
  return true;
}

async function viewHeaderChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('a click on a view header sorts by it A to Z, then Z to A, then not at all, each one undo step on the sort line alone', () => {
      const doc = withView('from: #tasks\nwhere:  status != Done');
      const h = mount(doc, [viewBlocks, history()]);
      const docs: string[] = [];
      const orders: string[] = [];
      const marks: string[] = [];
      for (let i = 0; i < 3; i++) {
        clickHead(h, 2, 'sort');
        docs.push(h.doc());
        orders.push(viewShows(h)!.rows.map((r) => r.split(',')[0]).join('/'));
        const th = viewHead(h, 2, 'sort')?.closest('th');
        marks.push(`${th?.getAttribute('aria-sort')}|${viewHead(h, 2, 'sort')?.getAttribute('aria-label')}`);
      }
      const undone: boolean[] = [];
      undo(h.view);
      undone.push(h.doc() === docs[1]);
      undo(h.view);
      undone.push(h.doc() === docs[0]);
      undo(h.view);
      undone.push(h.doc() === doc);
      h.view.destroy();
      return (
        docs[0] === doc.replace('where:  status != Done\n', 'where:  status != Done\nsort: estimate\n') &&
        docs[1] === doc.replace('where:  status != Done\n', 'where:  status != Done\nsort: estimate desc\n') &&
        docs[2] === doc &&
        JSON.stringify(orders) === JSON.stringify(['Sync/Search/Import', 'Import/Search/Sync', 'Search/Import/Sync']) &&
        JSON.stringify(marks) ===
          JSON.stringify([
            'ascending|estimate, sorted A to Z',
            'descending|estimate, sorted Z to A',
            'none|estimate, not sorted',
          ]) &&
        undone.every(Boolean)
      );
    })
  );

  results.push(
    await scenario('a Shift-click on a view header adds it as the next sort key and leaves the keys already written alone', () => {
      const doc = withView('from: #tasks\nsort:  status  asc');
      const h = mount(doc, [viewBlocks, history()]);
      clickHead(h, 2, 'sort', true);
      const added = h.doc();
      const order = viewShows(h)!.rows.map((r) => r.split(',')[0]).join('/');
      const label = viewHead(h, 2, 'sort')?.getAttribute('aria-label');
      const mark = viewHead(h, 1, 'sort')?.querySelector('.sheaf-view-sort-mark')?.textContent;
      // Shift-click again turns that one key round.
      clickHead(h, 2, 'sort', true);
      const turned = h.doc();
      // A plain click then sorts by the one column alone.
      clickHead(h, 0, 'sort');
      const alone = h.doc();
      h.view.destroy();
      return (
        added === doc.replace('sort:  status  asc', 'sort:  status  asc, estimate') &&
        order === 'Sync/Export/Search/Import' &&
        label === 'estimate, sorted A to Z, sort key 2 of 2' &&
        mark === '↑1' &&
        turned === doc.replace('sort:  status  asc', 'sort:  status  asc, estimate desc') &&
        alone === doc.replace('sort:  status  asc', 'sort:  feature')
      );
    })
  );

  results.push(
    await scenario('a header filter writes its condition into where, changes it in place, and removes it, leaving the other conditions as written', () => {
      const doc = withView('from: #tasks\nwhere:  estimate>2 ;status = Open');
      const h = mount(doc, [viewBlocks, history()]);
      const opened = clickHead(h, 1, 'filter');
      const menu = h.view.dom.querySelector('.sheaf-view-menu');
      // The menu shows the condition the column has now.
      const held = `${(menu?.querySelector('.sheaf-view-menu-op') as HTMLSelectElement)?.value}|${(menu?.querySelector('.sheaf-view-menu-value') as HTMLInputElement)?.value}`;
      (menu?.querySelector('.sheaf-view-menu-apply') as HTMLButtonElement)?.click();
      const unchanged = h.doc() === doc;
      filterBy(h, 1, '!=', 'Done');
      const changed = h.doc();
      const rows = viewShows(h)!.rows.map((r) => r.split(',')[0]).join('/');
      const marked = viewHead(h, 1, 'filter')?.classList.contains('is-active');
      // A new condition on another column goes after the others.
      filterBy(h, 0, 'contains', 'port');
      const added = h.doc();
      clickHead(h, 1, 'filter');
      (h.view.dom.querySelector('.sheaf-view-menu-clear') as HTMLButtonElement).click();
      const removed = h.doc();
      undo(h.view);
      const undone = h.doc() === added;
      h.view.destroy();
      return (
        opened &&
        held === '=|Open' &&
        unchanged &&
        changed === doc.replace('where:  estimate>2 ;status = Open', 'where:  estimate>2 ;status != Done') &&
        rows === 'Search/Import/Sync' &&
        marked === true &&
        added === doc.replace('where:  estimate>2 ;status = Open', 'where:  estimate>2 ;status != Done; feature contains port') &&
        removed === doc.replace('where:  estimate>2 ;status = Open', 'where:  estimate>2 ; feature contains port') &&
        undone
      );
    })
  );

  results.push(
    await scenario('a header filter of is empty needs no value, and one on a view with no where adds the line', () => {
      const doc = withView('from: #tasks\nsort: feature');
      const h = mount(doc, [viewBlocks]);
      clickHead(h, 2, 'filter');
      const select = h.view.dom.querySelector('.sheaf-view-menu-op') as HTMLSelectElement;
      select.value = 'is empty';
      select.dispatchEvent(new G.Event('change', { bubbles: true }));
      const hidden = (h.view.dom.querySelector('.sheaf-view-menu-value') as HTMLInputElement).hidden;
      (h.view.dom.querySelector('.sheaf-view-menu-apply') as HTMLButtonElement).click();
      const after = h.doc();
      const empty = viewMessages(h).length === 0 && viewShows(h)!.rows.length === 0;
      h.view.destroy();
      return hidden && after === doc.replace('sort: feature\n', 'sort: feature\nwhere: estimate is empty\n') && empty;
    })
  );

  results.push(
    await scenario('Hide column writes show from the columns shown, Show all columns takes it away, and the last column cannot be hidden', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks, history()]);
      clickHead(h, 1, 'filter');
      (h.view.dom.querySelector('.sheaf-view-menu-hide') as HTMLButtonElement).click();
      const hidden = h.doc();
      const head = viewShows(h)!.head.join(',');
      clickHead(h, 0, 'filter');
      (h.view.dom.querySelector('.sheaf-view-menu-hide') as HTMLButtonElement).click();
      const one = h.doc();
      clickHead(h, 2, 'filter');
      const last = h.view.dom.querySelector('.sheaf-view-menu-hide') as HTMLButtonElement;
      const refused = last.getAttribute('aria-disabled') === 'true';
      last.click();
      const kept = h.doc() === one;
      (h.view.dom.querySelector('.sheaf-view-menu-showall') as HTMLButtonElement).click();
      const all = h.doc();
      h.view.destroy();
      return (
        hidden === doc.replace('from: #tasks\n', 'from: #tasks\nshow: feature, estimate\n') &&
        head === 'feature,estimate' &&
        one === doc.replace('from: #tasks\n', 'from: #tasks\nshow: estimate\n') &&
        refused &&
        kept &&
        all === doc
      );
    })
  );

  results.push(
    await scenario('the header controls are buttons with names, the menu takes the keyboard, Escape gives it back, and Enter applies', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      const sort = viewHead(h, 1, 'sort')!;
      const filter = viewHead(h, 1, 'filter')!;
      const buttons = sort.tagName === 'BUTTON' && filter.tagName === 'BUTTON' && sort.tabIndex === 0 && filter.tabIndex === 0;
      const named = filter.getAttribute('aria-label') === 'Filter or hide status' && filter.getAttribute('aria-haspopup') === 'dialog';
      filter.focus();
      filter.click();
      const menu = h.view.dom.querySelector('.sheaf-view-menu') as HTMLElement;
      const dialog = menu?.getAttribute('role') === 'dialog' && menu.getAttribute('aria-label') === 'Filter status';
      const expanded = filter.getAttribute('aria-expanded') === 'true';
      const focusIn = menu?.contains(document.activeElement) ?? false;
      h.keydown(document.activeElement!, 'Escape');
      const closed = !h.view.dom.querySelector('.sheaf-view-menu') && document.activeElement === filter;
      filter.click();
      const input = h.view.dom.querySelector('.sheaf-view-menu-value') as HTMLInputElement;
      input.focus();
      input.value = 'Open';
      h.keydown(input, 'Enter');
      const written = h.doc() === doc.replace('from: #tasks\n', 'from: #tasks\nwhere: status = Open\n');
      // The keyboard is back on the column's menu button in the view drawn afresh.
      const back = document.activeElement === viewHead(h, 1, 'filter') && !!document.activeElement;
      const label = viewHead(h, 1, 'filter')?.getAttribute('aria-label');
      h.view.destroy();
      return buttons && named && dialog && expanded && focusIn && closed && written && back && label === 'Filter or hide status, filtered: status = Open';
    })
  );

  results.push(
    await scenario('arrow keys and Enter on a view header do not move or open the picked cell', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      h.mousedown(viewCell(h, 0, 0)!);
      const sort = viewHead(h, 1, 'sort')!;
      sort.focus();
      h.keydown(sort, 'ArrowDown');
      h.keydown(sort, 'Enter');
      const picked = h.view.dom.querySelector('.sheaf-view td.is-focus') as HTMLElement | null;
      const still = picked?.dataset.c === '0' && (picked.parentElement as HTMLElement).dataset.row === '0';
      const shut = !h.view.dom.querySelector('.sheaf-view-input');
      h.view.destroy();
      return still && shut;
    })
  );

  results.push(
    await scenario('a read-only document offers the header controls dimmed and writes nothing', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks, EditorState.readOnly.of(true)]);
      const dim = viewHead(h, 0, 'sort')?.getAttribute('aria-disabled') === 'true';
      clickHead(h, 0, 'sort');
      clickHead(h, 0, 'filter');
      const noMenu = !h.view.dom.querySelector('.sheaf-view-menu');
      const same = h.doc() === doc;
      h.view.destroy();
      return dim && noMenu && same;
    })
  );

  return results;
}

/** The view's cell for source row `row` and source column `col`. */
const viewCell = (h: Harness, row: number, col: number, which = 0): HTMLElement | null =>
  h.view.dom.querySelectorAll('.sheaf-view')[which]?.querySelector(`tr[data-row="${row}"] td[data-c="${col}"]`) ?? null;

/** Open a view's cell with a double-click, type `value` over it, and finish with `key`. */
function typeInView(h: Harness, row: number, col: number, value: string, key = 'Enter'): boolean {
  const td = viewCell(h, row, col);
  if (!td) return false;
  h.dblclick(td);
  const input = td.querySelector('.sheaf-view-input') as HTMLTextAreaElement | null;
  if (!input) return false;
  input.value = value;
  h.keydown(input, key);
  return true;
}

async function viewEditChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('a cell edited in a view writes the one field in the block it reads, and the view shows it', () => {
      const doc = withView('from: #tasks\nsort: estimate desc');
      const h = mount(doc, [viewBlocks]);
      // Import (source row 2) shows first; its estimate is column 2.
      const typed = typeInView(h, 2, 2, '13');
      const after = h.doc();
      const shown = viewCell(h, 2, 2)?.textContent;
      h.view.destroy();
      return typed && after === doc.replace('Import,Open,8', 'Import,Open,13') && shown === '13';
    })
  );

  results.push(
    await scenario('an edit through a sorted view leaves the rows of the block in their own order', () => {
      const doc = withView('from: #tasks\nsort: feature');
      const h = mount(doc, [viewBlocks]);
      const order = viewShows(h)?.rows.map((r) => r.split(',')[0]);
      typeInView(h, 0, 0, 'Zoom');
      const block = h.doc().slice(h.doc().indexOf('```csv'), h.doc().indexOf('```view'));
      h.view.destroy();
      return (
        JSON.stringify(order) === JSON.stringify(['Export', 'Import', 'Search', 'Sync']) &&
        block.indexOf('Zoom,Open,5') < block.indexOf('Export,Done,2') &&
        block.indexOf('Export,Done,2') < block.indexOf('Import,Open,8')
      );
    })
  );

  results.push(
    await scenario('Escape in a view cell puts it back and writes nothing', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      const typed = typeInView(h, 1, 1, 'Changed', 'Escape');
      const shown = viewCell(h, 1, 1)?.textContent;
      const same = h.doc() === doc;
      h.view.destroy();
      return typed && same && shown === 'Done';
    })
  );

  results.push(
    await scenario('a row edited out of a filtered view stays in sight, marked, until the view is drawn again', () => {
      const doc = withView('from: #tasks\nwhere: status = Open');
      const h = mount(doc, [viewBlocks]);
      // Search (row 0) and Import (row 2) are Open. Close Search.
      typeInView(h, 0, 1, 'Done');
      const written = h.doc() === doc.replace('Search,Open,5', 'Search,Done,5');
      const rows = viewShows(h)?.rows;
      const marked = viewCell(h, 0, 1)?.parentElement?.classList.contains('is-unmatched');
      const unmarked = !viewCell(h, 2, 1)?.parentElement?.classList.contains('is-unmatched');
      const said = viewMessages(h).some((s) => s.includes('A row you edited no longer matches this view'));
      const count = h.view.dom.querySelector('.sheaf-view-count')?.textContent;
      (h.view.dom.querySelector('.sheaf-view-redraw') as HTMLButtonElement).click();
      const redrawn = viewShows(h)?.rows;
      h.view.destroy();
      return (
        written &&
        JSON.stringify(rows) === JSON.stringify(['Search,Done,5', 'Import,Open,8']) &&
        !!marked &&
        unmarked &&
        said &&
        count === '1 of 4 rows' &&
        JSON.stringify(redrawn) === JSON.stringify(['Import,Open,8'])
      );
    })
  );

  results.push(
    await scenario('a row edited out of a sorted view keeps its place rather than jumping', () => {
      const doc = withView('from: #tasks\nsort: estimate');
      const h = mount(doc, [viewBlocks]);
      // Sync (3) shows second, after Export (2). Make it the largest.
      typeInView(h, 3, 2, '99');
      const rows = viewShows(h)?.rows.map((r) => r.split(',')[0]);
      h.view.destroy();
      return JSON.stringify(rows) === JSON.stringify(['Export', 'Sync', 'Search', 'Import']);
    })
  );

  results.push(
    await scenario('a change to the block from elsewhere lets go of the rows an edit kept in sight', () => {
      const doc = withView('from: #tasks\nwhere: status = Open');
      const h = mount(doc, [viewBlocks]);
      typeInView(h, 0, 1, 'Done');
      const kept = viewShows(h)?.rows.length === 2;
      const at = h.doc().indexOf('Sync,Blocked');
      h.view.dispatch({ changes: { from: at, to: at + 'Sync'.length, insert: 'Merge' } });
      const after = viewShows(h)?.rows;
      h.view.destroy();
      return kept && JSON.stringify(after) === JSON.stringify(['Import,Open,8']);
    })
  );

  results.push(
    await scenario('a row added in a filtered view starts with the values its conditions ask for and goes under the last row', () => {
      const doc = withView('from: #tasks\nwhere: status = Open; estimate > 1\nshow: feature, status');
      const h = mount(doc, [viewBlocks]);
      (h.view.dom.querySelector('.sheaf-view-add') as HTMLButtonElement).click();
      // Drawn with its prefilled status, and not written until something is typed.
      const drawn = viewCell(h, -1, 1)?.textContent === 'Open';
      const notYet = h.doc() === doc;
      // It opens on the first shown column its conditions left empty, ready to type.
      const input = h.view.dom.querySelector('.sheaf-view-input') as HTMLTextAreaElement | null;
      const where = input?.closest('td') as HTMLElement | null;
      const openOn = where ? `${(where.parentElement as HTMLElement).dataset.row},${where.dataset.c}` : '';
      if (input) {
        input.value = 'Billing';
        h.keydown(input, 'Enter');
      }
      const named = h.doc() === doc.replace('Sync,Blocked,3\n', 'Sync,Blocked,3\nBilling,Open,\n');
      // estimate > 1 does not hold for an empty estimate, so the row is shown but marked.
      const marked = viewCell(h, 4, 0)?.parentElement?.classList.contains('is-unmatched');
      h.view.destroy();
      return drawn && notYet && openOn === '-1,0' && named && !!marked;
    })
  );

  results.push(
    await scenario('a row started in a view and left without typing is not written and goes away', () => {
      const doc = withView('from: #tasks\nwhere: status = Open');
      const h = mount(doc, [viewBlocks]);
      (h.view.dom.querySelector('.sheaf-view-add') as HTMLButtonElement).click();
      const started = !!viewCell(h, -1, 0);
      h.keydown(h.view.dom.querySelector('.sheaf-view-input')!, 'Escape');
      const gone = !viewCell(h, -1, 0);
      const same = h.doc() === doc;
      h.view.destroy();
      return started && gone && same;
    })
  );

  results.push(
    await scenario('Tab from the first cell typed into a new row carries on in that row', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      (h.view.dom.querySelector('.sheaf-view-add') as HTMLButtonElement).click();
      let input = h.view.dom.querySelector('.sheaf-view-input') as HTMLTextAreaElement;
      input.value = 'Audit';
      h.keydown(input, 'Tab');
      input = viewCell(h, 4, 1)?.querySelector('.sheaf-view-input') as HTMLTextAreaElement;
      const moved = !!input;
      if (input) {
        input.value = 'Open';
        h.keydown(input, 'Enter');
      }
      const ok = h.doc() === doc.replace('Sync,Blocked,3\n', 'Sync,Blocked,3\nAudit,Open,\n');
      h.view.destroy();
      return moved && ok;
    })
  );

  results.push(
    await scenario('a row added in a view with no conditions is empty, and matches', () => {
      const doc = withView('from: #tasks');
      const h = mount(doc, [viewBlocks]);
      (h.view.dom.querySelector('.sheaf-view-add') as HTMLButtonElement).click();
      const input = h.view.dom.querySelector('.sheaf-view-input') as HTMLTextAreaElement | null;
      if (input) {
        input.value = 'Audit';
        h.keydown(input, 'Enter');
      }
      const ok = h.doc() === doc.replace('Sync,Blocked,3\n', 'Sync,Blocked,3\nAudit,,\n');
      const marked = viewCell(h, 4, 0)?.parentElement?.classList.contains('is-unmatched');
      h.view.destroy();
      return ok && !marked;
    })
  );

  results.push(
    await scenario('a cell edited in a view of a file goes to the host as the file with one field changed, and shows at once', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\n```\n';
      const h = mount(doc, [viewBlocks]);
      const file = 'feature,status\n"Search, fast",Open\nExport,Done\n';
      handleDataFile({ path: 'data/tasks.csv', text: file });
      await tick();
      typeInView(h, 1, 1, 'Open');
      const edit = sent.find((m) => m.type === 'dataFileEdit');
      const shown = viewCell(h, 1, 1)?.textContent;
      const unchanged = h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return (
        !!edit &&
        edit.path === 'data/tasks.csv' &&
        edit.base === file &&
        edit.text === 'feature,status\n"Search, fast",Open\nExport,Open\n' &&
        shown === 'Open' &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('Cmd+Z in a view of a file sends the inverse edit, Cmd+Shift+Z sends the edit again, and with nothing left the document’s own undo runs', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\n```\n';
      const h = mount(doc, [viewBlocks, history()]);
      // One edit of the document's own first, so its history has a step to take back.
      h.view.dispatch({ changes: { from: 0, insert: 'Hi. ' }, userEvent: 'input' });
      const file = 'feature,status\n"Search, fast",Open\nExport,Done\n';
      const edited = 'feature,status\n"Search, fast",Open\nExport,Open\n';
      handleDataFile({ path: 'data/tasks.csv', text: file });
      await tick();
      typeInView(h, 1, 1, 'Open');
      const edits = (): any[] => sent.filter((m) => m.type === 'dataFileEdit');
      const table = (): HTMLElement => h.view.dom.querySelector('.sheaf-view table') as HTMLElement;
      h.keydown(table(), 'z', { metaKey: true });
      const undo = edits()[1];
      const undoneShown = viewCell(h, 1, 1)?.textContent;
      const docKept = h.doc() === 'Hi. ' + doc;
      h.keydown(table(), 'z', { metaKey: true, shiftKey: true });
      const redo = edits()[2];
      const redoneShown = viewCell(h, 1, 1)?.textContent;
      // Undo the file edit again, then once more with the file's steps used up.
      h.keydown(table(), 'z', { metaKey: true });
      h.keydown(table(), 'z', { metaKey: true });
      const docUndone = h.doc() === doc;
      const count = edits().length;
      h.view.destroy();
      setDataFileHost(null);
      return (
        !!undo &&
        undo.path === 'data/tasks.csv' &&
        undo.base === edited &&
        undo.text === file &&
        undoneShown === 'Done' &&
        docKept &&
        !!redo &&
        redo.base === file &&
        redo.text === edited &&
        redoneShown === 'Open' &&
        docUndone &&
        count === 4
      );
    })
  );

  results.push(
    await scenario('Cmd+Z in the text takes back a view’s edit of a file when that was the last thing edited, and the text’s own step once the text was edited since', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: t.csv\n```\n';
      // The editor's own Cmd+Z, as the webview binds it, for the step the text takes back.
      const { keymap } = await import('@codemirror/view');
      const { historyKeymap } = await import('@codemirror/commands');
      const h = mount(doc, [viewBlocks, history(), keymap.of(historyKeymap)]);
      handleDataFile({ path: 't.csv', text: 'a,b\n1,2\n' });
      await tick();
      typeInView(h, 0, 1, '3');
      // Ctrl, because jsdom is no Mac and the editor's keymap reads Mod as Ctrl there.
      h.keydown(h.view.contentDOM, 'z', { ctrlKey: true });
      const edits = (): any[] => sent.filter((m) => m.type === 'dataFileEdit');
      const first = edits().length === 2 && edits()[1].text === 'a,b\n1,2\n' && h.doc() === doc;
      // Edited again, then the text is typed in: the text is now the last thing edited.
      typeInView(h, 0, 1, '4');
      h.view.dispatch({ changes: { from: 0, insert: 'Hi. ' }, userEvent: 'input' });
      h.keydown(h.view.contentDOM, 'z', { ctrlKey: true });
      const second = edits().length === 3 && h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return first && second;
    })
  );

  results.push(
    await scenario('an undo of a view’s file edit, when the file changed since, is not sent: the view says so and the step is gone', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: t.csv\n```\n';
      const h = mount(doc, [viewBlocks, history()]);
      handleDataFile({ path: 't.csv', text: 'a,b\n1,2\n' });
      await tick();
      typeInView(h, 0, 1, '3');
      // Someone else writes the file after the edit.
      handleDataFile({ path: 't.csv', text: 'a,b\n1,3\n2,5\n' });
      await tick();
      const table = (): HTMLElement => h.view.dom.querySelector('.sheaf-view table') as HTMLElement;
      h.keydown(table(), 'z', { metaKey: true });
      const said = viewMessages(h);
      const edits = sent.filter((m) => m.type === 'dataFileEdit').length;
      // The step is dropped, so a redo has nothing of the file's to put back.
      h.keydown(table(), 'z', { metaKey: true, shiftKey: true });
      const after = sent.filter((m) => m.type === 'dataFileEdit').length;
      h.view.destroy();
      setDataFileHost(null);
      return edits === 1 && after === 1 && said.some((s) => s.startsWith('sheaf-view-error') && s.includes('Undo did not change t.csv'));
    })
  );

  results.push(
    await scenario('a refusal from the host of an undo of a view’s file edit drops the step', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: t.csv\n```\n';
      const h = mount(doc, [viewBlocks, history()]);
      handleDataFile({ path: 't.csv', text: 'a,b\n1,2\n' });
      await tick();
      typeInView(h, 0, 1, '3');
      const table = (): HTMLElement => h.view.dom.querySelector('.sheaf-view table') as HTMLElement;
      h.keydown(table(), 'z', { metaKey: true });
      // Refused, with the file holding what the redo would start from, so only the
      // dropped step keeps the redo from being sent.
      handleDataFile({ path: 't.csv', text: 'a,b\n1,2\n', notice: 'Undo did not change t.csv, because it changed after your edit.' });
      await tick();
      h.keydown(table(), 'z', { metaKey: true, shiftKey: true });
      const edits = sent.filter((m) => m.type === 'dataFileEdit').length;
      h.view.destroy();
      setDataFileHost(null);
      return edits === 2;
    })
  );

  results.push(
    await scenario('an edit the host could not write shows its note on the view', async () => {
      setDataFileHost(() => {});
      const h = mount(P + '```view\nfrom: t.csv\n```\n', [viewBlocks]);
      handleDataFile({ path: 't.csv', text: 'a\n1\n', notice: 'Your edit was not written, because t.csv changed after the view read it.' });
      await tick();
      const said = viewMessages(h);
      h.view.destroy();
      setDataFileHost(null);
      return said.some((s) => s.startsWith('sheaf-view-error') && s.includes('Your edit was not written'));
    })
  );

  results.push(
    await scenario('a view of a file that never arrived offers no way to add a row', () => {
      setDataFileHost(() => {});
      const h = mount(P + '```view\nfrom: t.csv\n```\n', [viewBlocks]);
      const add = h.view.dom.querySelector('.sheaf-view-add') as HTMLElement | null;
      h.view.destroy();
      setDataFileHost(null);
      return !!add && add.hidden;
    })
  );

  results.push(
    await scenario('arrow keys move the picked cell in a view and Enter opens it', () => {
      const doc = withView('from: #tasks\nshow: feature, status');
      const h = mount(doc, [viewBlocks]);
      h.mousedown(viewCell(h, 0, 0)!);
      const table = h.view.dom.querySelector('.sheaf-view table') as HTMLElement;
      h.keydown(table, 'ArrowRight');
      h.keydown(table, 'ArrowDown');
      const picked = h.view.dom.querySelector('.sheaf-view td.is-focus') as HTMLElement | null;
      const at = picked ? `${(picked.parentElement as HTMLElement).dataset.row},${picked.dataset.c}` : '';
      h.keydown(table, 'Enter');
      const open = !!viewCell(h, 1, 1)?.querySelector('.sheaf-view-input');
      h.view.destroy();
      return at === '1,1' && open;
    })
  );

  results.push(
    await scenario('the formatting toolbar is not offered for a selection that ends in a named CSV block or a view, as for any grid', async () => {
      // Loaded here rather than at the top: importing it first changes the order this suite's
      // modules initialise in, and the cell editors are built on that order.
      const { toolbarEligible } = await import('../src/webview/floatingState');
      // A selection from the prose into the block: formatting would write markers into its data.
      const eligible = (fence: string): boolean => {
        const doc = `Some prose here.\n\n\`\`\`${fence}\na,b\n1,2\n\`\`\`\n`;
        const v = mkView(doc);
        forceParsing(v, doc.length, 5000);
        const state = v.state.update({ selection: { anchor: 5, head: doc.indexOf('1,2') + 1 } }).state;
        v.destroy();
        return toolbarEligible(state, false);
      };
      // The control: a code block of another language is not a grid, so the toolbar is offered.
      return [eligible('csv id=tasks'), eligible('tsv id=t'), eligible('view'), eligible('js')].join() === 'false,false,false,true';
    })
  );

  return results;
}

// ---- Board layout: a view with `layout: board` and `group: <column>` ----------

/** What a drawn board shows: each board column's name and count, then its cards' text, field by field. */
function boardShows(h: Harness, which = 0): { name: string; count: string; cards: string[] }[] | null {
  const board = h.view.dom.querySelectorAll('.sheaf-view')[which]?.querySelector('.sheaf-board');
  if (!board) return null;
  return Array.from(board.querySelectorAll('.sheaf-board-col')).map((col) => ({
    name: col.querySelector('.sheaf-board-col-name')?.textContent ?? '',
    count: col.querySelector('.sheaf-board-col-count')?.textContent ?? '',
    cards: Array.from(col.querySelectorAll('.sheaf-board-card')).map((card) =>
      Array.from(card.querySelectorAll('[data-c]'))
        .map((f) => f.textContent ?? '')
        .join('|')
    ),
  }));
}

const boardCard = (h: Harness, row: number): HTMLElement | null =>
  h.view.dom.querySelector(`.sheaf-board-card[data-row="${row}"]`);
const boardColumn = (h: Harness, value: string): HTMLElement | null =>
  (Array.from(h.view.dom.querySelectorAll('.sheaf-board-col')) as HTMLElement[]).find((c) => c.dataset.value === value) ?? null;

/** Drag a card by the pointer onto another board column and let go there, pressing Escape first if asked. */
function dragCard(h: Harness, row: number, to: string, opts: { escape?: boolean } = {}): void {
  const card = boardCard(h, row)!;
  const Ctor = G.window.PointerEvent ?? G.MouseEvent;
  const fire = (el: EventTarget, type: string, x: number, buttons: number): void => {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0, buttons, pointerId: 7 }));
  };
  fire(card, 'pointerdown', 10, 1);
  const target = boardColumn(h, to)!.querySelector('.sheaf-board-col-head')!;
  fire(target, 'pointermove', 200, 1);
  fire(target, 'pointermove', 260, 1);
  if (opts.escape) h.keydown(document.activeElement ?? card, 'Escape');
  fire(target, 'pointerup', 260, 0);
}

async function boardChecks(): Promise<Result[]> {
  const results: Result[] = [];
  const BOARD = 'from: #tasks\nlayout: board\ngroup: status';

  results.push(
    await scenario('a board draws one column per value in the order the values first appear, with a card per row', () => {
      const doc = withView(BOARD);
      const h = mount(doc, [viewBlocks]);
      const shown = boardShows(h);
      const table = h.view.dom.querySelector('.sheaf-view table');
      const said = viewMessages(h);
      const unchanged = h.doc() === doc;
      h.view.destroy();
      return (
        JSON.stringify(shown) ===
          JSON.stringify([
            // The title is the first column; the status is left off, the column says it.
            { name: 'Open', count: '2', cards: ['Search|5', 'Import|8'] },
            { name: 'Done', count: '1', cards: ['Export|2'] },
            { name: 'Blocked', count: '1', cards: ['Sync|3'] },
          ]) &&
        !table &&
        said.length === 0 &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('a board adds a column for rows with an empty grouping cell, after the others', () => {
      const doc =
        P + '```csv id=tasks\nfeature,status\nSearch,Open\nExport,\nImport,Done\nSync,  \n```\n\n```view\n' + BOARD + '\n```\n';
      const h = mount(doc, [viewBlocks]);
      const shown = boardShows(h);
      const empty = boardColumn(h, '')?.querySelector('.sheaf-board-col-name')?.classList.contains('is-empty-value');
      h.view.destroy();
      // The control: with no blank cell there is no such column.
      const full = mount(withView(BOARD), [viewBlocks]);
      const none = !boardColumn(full, '');
      full.view.destroy();
      return (
        JSON.stringify(shown?.map((c) => `${c.name}:${c.cards.join('/')}`)) ===
          JSON.stringify(['Open:Search', 'Done:Import', 'No status:Export/Sync']) &&
        empty === true &&
        none
      );
    })
  );

  results.push(
    await scenario('a board keeps what the view where keeps, and orders cards by its sort', () => {
      const h = mount(withView(BOARD + '\nwhere: status != Done\nsort: estimate desc\nshow: feature, estimate, status'), [viewBlocks]);
      const shown = boardShows(h);
      const count = h.view.dom.querySelector('.sheaf-view-count')?.textContent;
      h.view.destroy();
      // Without a sort, a column keeps the table's own order.
      const plain = mount(withView(BOARD), [viewBlocks]);
      const source = boardShows(plain)?.[0].cards;
      plain.view.destroy();
      return (
        JSON.stringify(shown?.map((c) => `${c.name}:${c.cards.join('/')}`)) === JSON.stringify(['Open:Import|8/Search|5', 'Blocked:Sync|3']) &&
        count === '3 of 4 rows' &&
        JSON.stringify(source) === JSON.stringify(['Search|5', 'Import|8'])
      );
    })
  );

  results.push(
    await scenario('a board is a list of labelled regions, each holding cards named by their titles', () => {
      const h = mount(withView(BOARD), [viewBlocks]);
      const board = h.view.dom.querySelector('.sheaf-board')!;
      const items = Array.from(board.children).map((c) => c.getAttribute('role'));
      const regions = Array.from(board.querySelectorAll('[role="region"]')).map((r) => r.getAttribute('aria-label'));
      const cards = Array.from(board.querySelectorAll('[role="region"] ul > li.sheaf-board-card')).map((c) => c.getAttribute('aria-label'));
      // One card takes Tab; the arrows reach the rest.
      const tabbable = Array.from(board.querySelectorAll('.sheaf-board-card')).filter((c) => (c as HTMLElement).tabIndex === 0).length;
      h.view.destroy();
      return (
        board.getAttribute('role') === 'list' &&
        board.getAttribute('aria-label') === 'Board grouped by status' &&
        items.every((r) => r === 'listitem') &&
        JSON.stringify(regions) === JSON.stringify(['Open, 2 cards', 'Done, 1 card', 'Blocked, 1 card']) &&
        JSON.stringify(cards) === JSON.stringify(['Search', 'Import', 'Export', 'Sync']) &&
        tabbable === 1
      );
    })
  );

  results.push(
    await scenario('dragging a card to another column writes that one cell of the block, as one undo step', () => {
      const doc = withView(BOARD);
      const h = mount(doc, [viewBlocks, history()]);
      dragCard(h, 0, 'Done');
      const after = h.doc();
      const shown = boardShows(h);
      undo(h.view);
      const undone = h.doc();
      h.view.destroy();
      return (
        after === doc.replace('Search,Open,5', 'Search,Done,5') &&
        // Search is row 0, so with no sort it comes first in its new column.
        JSON.stringify(shown?.map((c) => `${c.name}:${c.cards.map((x) => x.split('|')[0]).join('/')}`)) ===
          JSON.stringify(['Open:Import', 'Done:Search/Export', 'Blocked:Sync']) &&
        undone === doc
      );
    })
  );

  results.push(
    await scenario('a card dragged and let go after Escape, or dropped on its own column, writes nothing', () => {
      const doc = withView(BOARD);
      const h = mount(doc, [viewBlocks]);
      dragCard(h, 0, 'Done', { escape: true });
      const escaped = h.doc() === doc && !h.view.dom.querySelector('.is-dragging, .is-drop-target');
      dragCard(h, 0, 'Open');
      const home = h.doc() === doc;
      h.view.destroy();
      return escaped && home;
    })
  );

  results.push(
    await scenario('dragging a card on a board of a file sends the file with one field changed', async () => {
      const sent: any[] = [];
      setDataFileHost((m) => sent.push(m));
      const doc = P + '```view\nfrom: data/tasks.csv\nlayout: board\ngroup: status\n```\n';
      const h = mount(doc, [viewBlocks]);
      const file = 'feature,status,owner\n"Search, fast",Open,ana\nExport,Done,bo\n';
      handleDataFile({ path: 'data/tasks.csv', text: file });
      await tick();
      const before = boardShows(h)?.map((c) => c.name);
      dragCard(h, 1, 'Open');
      const edit = sent.find((m) => m.type === 'dataFileEdit');
      const shown = boardShows(h)?.[0].cards;
      const unchanged = h.doc() === doc;
      h.view.destroy();
      setDataFileHost(null);
      return (
        JSON.stringify(before) === JSON.stringify(['Open', 'Done']) &&
        !!edit &&
        edit.base === file &&
        edit.text === 'feature,status,owner\n"Search, fast",Open,ana\nExport,Open,bo\n' &&
        JSON.stringify(shown) === JSON.stringify(['Search, fast|ana', 'Export|bo']) &&
        unchanged
      );
    })
  );

  results.push(
    await scenario('Alt+Right and Alt+Left move the focused card between columns, and the arrows move between cards', () => {
      const doc = withView(BOARD);
      const h = mount(doc, [viewBlocks]);
      const search = boardCard(h, 0)!;
      search.focus();
      h.keydown(search, 'ArrowDown');
      const down = (document.activeElement as HTMLElement)?.dataset.row;
      h.keydown(document.activeElement!, 'ArrowRight');
      const right = (document.activeElement as HTMLElement)?.dataset.row;
      // Back to the first card of Open, level with Export, then down to Import (row 2).
      h.keydown(document.activeElement!, 'ArrowLeft');
      const left = (document.activeElement as HTMLElement)?.dataset.row;
      h.keydown(document.activeElement!, 'ArrowDown');
      // Import moves right, into Done.
      h.keydown(document.activeElement!, 'ArrowRight', { altKey: true });
      const moved = h.doc();
      const focused = (document.activeElement as HTMLElement)?.dataset.row;
      const inDone = boardColumn(h, 'Done')?.contains(document.activeElement);
      // At the last column Alt+Right goes nowhere; Alt+Left comes back.
      h.keydown(document.activeElement!, 'ArrowRight', { altKey: true });
      h.keydown(document.activeElement!, 'ArrowRight', { altKey: true });
      const atEnd = h.doc();
      h.keydown(document.activeElement!, 'ArrowLeft', { altKey: true });
      const back = h.doc();
      h.view.destroy();
      return (
        down === '2' &&
        right === '1' &&
        left === '0' &&
        moved === doc.replace('Import,Open,8', 'Import,Done,8') &&
        focused === '2' &&
        inDone === true &&
        atEnd === doc.replace('Import,Open,8', 'Import,Blocked,8') &&
        back === doc.replace('Import,Open,8', 'Import,Done,8')
      );
    })
  );

  results.push(
    await scenario('Enter on a card opens its title for typing, and Enter writes it', () => {
      const doc = withView(BOARD);
      const h = mount(doc, [viewBlocks]);
      const card = boardCard(h, 1)!;
      card.focus();
      h.keydown(card, 'Enter');
      const input = card.querySelector('.sheaf-board-title .sheaf-view-input') as HTMLTextAreaElement | null;
      const held = input?.value;
      if (input) {
        input.value = 'Export all';
        h.keydown(input, 'Enter');
      }
      const after = h.doc();
      const back = (document.activeElement as HTMLElement)?.dataset.row;
      h.view.destroy();
      return held === 'Export' && after === doc.replace('Export,Done,2', 'Export all,Done,2') && back === '1';
    })
  );

  results.push(
    await scenario('a board grouped by a column the table does not have shows the table and the error', () => {
      const h = mount(withView('from: #tasks\nlayout: board\ngroup: owner'), [viewBlocks]);
      const shown = viewShows(h);
      const said = viewMessages(h);
      const board = h.view.dom.querySelector('.sheaf-board');
      h.view.destroy();
      return !board && shown?.rows.length === 4 && said.some((s) => s.startsWith('sheaf-view-error') && s.includes('No column is named "owner"'));
    })
  );

  return results;
}

// ---- A pipe table shown as a board, with no view block ------------------------
//
// Which table is a board is kept for the page's whole session under the table's
// header row, as widths are, so every scenario here uses headers no other uses.

/** A pipe table's board as "column:title/title", in the order drawn; null while it shows its grid. */
function pipeBoard(h: Harness): string[] | null {
  const board = h.root()?.querySelector('.sheaf-board');
  if (!board || board.closest('[hidden]')) return null;
  return Array.from(board.querySelectorAll('.sheaf-board-col')).map(
    (col) =>
      `${col.querySelector('.sheaf-board-col-name')?.textContent ?? ''}:${Array.from(col.querySelectorAll('.sheaf-board-title'))
        .map((t) => t.textContent ?? '')
        .join('/')}`
  );
}

const gridShown = (h: Harness): boolean => !!h.grid() && !h.grid()!.hidden && !h.grid()!.closest('[hidden]');

/** The note a table shows above itself, or '' when it shows none. */
const tableNote = (h: Harness): string => {
  const note = h.root()?.querySelector<HTMLElement>('.sheaf-table-board-note');
  return note && !note.hidden ? note.textContent ?? '' : '';
};

/** The items of the table menu standing open, by their text. */
const tableMenuItems = (): string[] =>
  Array.from(document.querySelectorAll('.sheaf-table-menu .sheaf-table-menu-item')).map((b) => b.textContent ?? '');

/** Pick the item reading `label` in the table menu standing open, and let what it opens arrive. */
async function pickTableMenu(label: string): Promise<boolean> {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.sheaf-table-menu .sheaf-table-menu-item')).find(
    (b) => b.textContent === label
  );
  if (!item || item.getAttribute('aria-disabled') === 'true') return false;
  item.click();
  await tick();
  return true;
}

/** Show a pipe table as a board from its overflow menu, grouped by the column named `column`. */
async function showPipeBoard(h: Harness, column: string): Promise<boolean> {
  h.ctrl('overflow')?.click();
  return (await pickTableMenu('Show as board')) && (await pickTableMenu(column));
}

async function pipeBoardChecks(): Promise<Result[]> {
  const results: Result[] = [];

  results.push(
    await scenario('a pipe table’s menus offer Show as board, which asks which column to group by and then draws the rows as cards, leaving the file alone', async () => {
      const doc = P + '| Task | Stage | Owner |\n| --- | --- | --- |\n| Search | Open | ana |\n| Export | Done | bo |\n| Import | Open | cy |\n';
      const sent: any[] = [];
      setTableBoardsHost((m) => sent.push(m));
      const h = mount(doc);
      const rightClick = (tableActionsAt(h.cell(0, 0)) ?? []).map((a) => a.label);
      h.ctrl('overflow')!.click();
      const item = document.querySelector('.sheaf-table-menu [data-cmd="table.showAsBoard"]');
      const offered = item?.textContent === 'Show as board' && item.getAttribute('aria-disabled') !== 'true';
      await pickTableMenu('Show as board');
      const choices = tableMenuItems();
      const asks = document.querySelector('.sheaf-table-menu')?.getAttribute('aria-label');
      await pickTableMenu('Stage');
      const shown = pipeBoard(h);
      const card = Array.from(boardCard(h, 0)?.querySelectorAll('[data-c]') ?? []).map((f) => f.textContent).join('|');
      const grid = gridShown(h);
      const focused = (document.activeElement as HTMLElement | null)?.dataset.row;
      const write = sent.filter((m) => m.type === 'tableBoardsWrite').pop();
      const asked = sent.some((m) => m.type === 'tableBoardsRead');
      const after = h.doc();
      h.view.destroy();
      setTableBoardsHost(null);
      // The control: a CSV block has views for this, and is not offered it.
      const csv = mount(P + '```csv\nName,Kind\na,b\n```\n');
      const csvOffers = (tableActionsAt(csv.cell(0, 0)) ?? []).some((a) => a.label === 'Show as board');
      csv.view.destroy();
      return (
        rightClick.includes('Show as board') &&
        offered &&
        JSON.stringify(choices) === JSON.stringify(['Task', 'Stage', 'Owner']) &&
        asks === 'Group the board by' &&
        JSON.stringify(shown) === JSON.stringify(['Open:Search/Import', 'Done:Export']) &&
        card === 'Search|ana' &&
        !grid &&
        focused === '0' &&
        after === doc &&
        asked &&
        write?.boards?.[tableWidthKey(['Task', 'Stage', 'Owner'])]?.group === 'Stage' &&
        !csvOffers
      );
    })
  );

  results.push(
    await scenario('moving a card on a pipe-table board rewrites that row’s one cell and nothing else, as one undo step', async () => {
      const doc = P + '| Item  | Phase | Note   |\n|:------|-------|--------|\n| Alpha | Todo  | a \\| b |\n| Beta  | Doing | x      |\n| Gamma | Todo  | y      |\n\nAfter.\n';
      const h = mount(doc, [history()]);
      await showPipeBoard(h, 'Phase');
      const before = pipeBoard(h);
      dragCard(h, 2, 'Doing');
      const dragged = h.doc();
      const shown = pipeBoard(h);
      undo(h.view);
      const undone = h.doc();
      const back = pipeBoard(h);
      const alpha = boardCard(h, 0)!;
      alpha.focus();
      h.keydown(alpha, 'ArrowRight', { altKey: true });
      const keyed = h.doc();
      const stillFocused = (document.activeElement as HTMLElement | null)?.dataset.row;
      h.view.destroy();
      return (
        JSON.stringify(before) === JSON.stringify(['Todo:Alpha/Gamma', 'Doing:Beta']) &&
        dragged === doc.replace('| Gamma | Todo  |', '| Gamma | Doing |') &&
        JSON.stringify(shown) === JSON.stringify(['Todo:Alpha', 'Doing:Beta/Gamma']) &&
        undone === doc &&
        JSON.stringify(back) === JSON.stringify(['Todo:Alpha/Gamma', 'Doing:Beta']) &&
        keyed === doc.replace('| Alpha | Todo  |', '| Alpha | Doing |') &&
        stillFocused === '0'
      );
    })
  );

  results.push(
    await scenario('a pipe-table board whose grouping column is renamed away goes back to the grid and says why', async () => {
      const doc = P + '| Card | Lane |\n| - | - |\n| One | Left |\n| Two | Right |\n';
      const sent: any[] = [];
      setTableBoardsHost((m) => sent.push(m));
      const h = mount(doc);
      await showPipeBoard(h, 'Lane');
      const before = pipeBoard(h);
      const at = h.doc().indexOf('Lane');
      h.view.dispatch({ changes: { from: at, to: at + 4, insert: 'Side' } });
      const after = pipeBoard(h);
      const note = tableNote(h);
      const grid = gridShown(h);
      const write = sent.filter((m) => m.type === 'tableBoardsWrite').pop();
      h.view.destroy();
      setTableBoardsHost(null);
      // The renamed table opened again is a grid, and says nothing.
      const again = mount(doc.replace('Lane', 'Side'));
      const plain = pipeBoard(again) === null && tableNote(again) === '';
      again.view.destroy();
      // The control: renaming a column the board is not grouped by keeps the board.
      const other = mount(P + '| Card2 | Lane2 |\n| - | - |\n| One | Left |\n');
      await showPipeBoard(other, 'Lane2');
      const from = other.doc().indexOf('Card2');
      other.view.dispatch({ changes: { from, to: from + 5, insert: 'Name2' } });
      const kept = pipeBoard(other);
      const keptNote = tableNote(other);
      other.view.destroy();
      handleTableBoards('clean', { [tableWidthKey(['Name2', 'Lane2'])]: null });
      return (
        JSON.stringify(before) === JSON.stringify(['Left:One', 'Right:Two']) &&
        after === null &&
        grid &&
        note.includes('Lane') &&
        !!write &&
        !(tableWidthKey(['Card', 'Lane']) in write.boards) &&
        !(tableWidthKey(['Card', 'Side']) in write.boards) &&
        plain &&
        JSON.stringify(kept) === JSON.stringify(['Left:One']) &&
        keptNote === ''
      );
    })
  );

  results.push(
    await scenario('Show as table on a board puts the grid back, and the table is not a board when it is opened again', async () => {
      const doc = P + '| Job | Queue |\n| - | - |\n| a | x |\n| b | y |\n';
      const sent: any[] = [];
      setTableBoardsHost((m) => sent.push(m));
      const h = mount(doc);
      await showPipeBoard(h, 'Queue');
      const onBoard = pipeBoard(h);
      const button = h.ctrl('table.showAsTable');
      const buttonShown = !!button && !button.hidden && !button.closest('[hidden]');
      const rowButtonHidden = !!h.ctrl('row.insertAbove')?.closest('[hidden]');
      const rightClick = (tableActionsAt(boardCard(h, 0)) ?? []).map((a) => a.label);
      h.ctrl('overflow')!.click();
      const overflow = tableMenuItems();
      await pickTableMenu('Show as table');
      const back = gridShown(h) && pipeBoard(h) === null;
      const buttonGone = h.ctrl('table.showAsTable') === null;
      const write = sent.filter((m) => m.type === 'tableBoardsWrite').pop();
      const after = h.doc();
      h.view.destroy();
      setTableBoardsHost(null);
      const again = mount(doc);
      const still = pipeBoard(again) === null && gridShown(again);
      again.view.destroy();
      return (
        JSON.stringify(onBoard) === JSON.stringify(['x:a', 'y:b']) &&
        buttonShown &&
        rowButtonHidden &&
        rightClick.includes('Show as table') &&
        !rightClick.includes('Insert row above') &&
        overflow.includes('Show as table') &&
        !overflow.includes('Insert row above') &&
        back &&
        buttonGone &&
        !!write &&
        !(tableWidthKey(['Job', 'Queue']) in write.boards) &&
        after === doc &&
        still
      );
    })
  );

  results.push(
    await scenario('a board kept for a table is drawn when its header row matches; a damaged, unmatched or ungroupable one is not', async () => {
      handleTableBoards('boards-1', {
        [tableWidthKey(['Kept', 'Board'])]: { group: 'Board' },
        [tableWidthKey(['Bad', 'Board'])]: { group: 7 },
        [tableWidthKey(['Gone', 'Board'])]: { group: 'Missing' },
      });
      const shownFor = (source: string): { board: string[] | null; note: string; grid: boolean } => {
        const h = mount(P + source);
        const seen = { board: pipeBoard(h), note: tableNote(h), grid: gridShown(h) };
        h.view.destroy();
        return seen;
      };
      const kept = shownFor('| Kept | Board |\n| - | - |\n| a | x |\n');
      const renamed = shownFor('| Kept | Boards |\n| - | - |\n| a | x |\n');
      const bad = shownFor('| Bad | Board |\n| - | - |\n| a | x |\n');
      const gone = shownFor('| Gone | Board |\n| - | - |\n| a | x |\n');
      // An answer that arrives after the table is drawn redraws it.
      const late = mount(P + '| Late | Board |\n| - | - |\n| a | x |\n');
      const beforeAnswer = pipeBoard(late);
      handleTableBoards('boards-2', { [tableWidthKey(['Late', 'Board'])]: { group: 'Board' } });
      const afterAnswer = pipeBoard(late);
      late.view.destroy();
      handleTableBoards('boards-3', { [tableWidthKey(['Kept', 'Board'])]: null, [tableWidthKey(['Late', 'Board'])]: null });
      return (
        JSON.stringify(kept.board) === JSON.stringify(['x:a']) &&
        !kept.grid &&
        renamed.board === null &&
        renamed.note === '' &&
        bad.board === null &&
        bad.note === '' &&
        gone.board === null &&
        gone.grid &&
        gone.note.includes('Missing') &&
        beforeAnswer === null &&
        JSON.stringify(afterAnswer) === JSON.stringify(['x:a'])
      );
    })
  );

  results.push(
    await scenario('with no host to keep it, a table shown as a board stays a board for the rest of the page’s session', async () => {
      setTableBoardsHost(null);
      const doc = P + '| Sess | Bucket |\n| - | - |\n| a | x |\n';
      const h = mount(doc);
      await showPipeBoard(h, 'Bucket');
      h.view.destroy();
      const again = mount(doc);
      const shown = pipeBoard(again);
      again.view.destroy();
      handleTableBoards('clean', { [tableWidthKey(['Sess', 'Bucket'])]: null });
      return JSON.stringify(shown) === JSON.stringify(['x:a']);
    })
  );

  return results;
}
