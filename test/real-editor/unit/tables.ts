// Unit scenarios for editing inside a table grid: rendering, cell editing, keyboard
// reach, navigation, selection, clipboard, undo, cell content, accessibility and
// touch. Each mounts the editor with the webview's own extensions and drives the
// grid through DOM events on its real handlers. Every edit compares the whole
// document, so a reformat of an untouched row shows up.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import { editorExtensions } from '../../../src/webview/editorExtensions';
import { mountContextMenu } from '../../../src/webview/contextmenu';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}

const G: any = globalThis;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const j = (x: unknown): string => JSON.stringify(x);

interface Grid {
  view: EditorView;
  tables: () => HTMLElement[];
  grid: (t?: number) => HTMLElement;
  cell: (r: number, c: number, t?: number) => HTMLElement;
  gutter: (r: number, t?: number) => HTMLElement;
  corner: (t?: number) => HTMLElement;
  input: () => HTMLInputElement | HTMLTextAreaElement | null;
  /** The nested editor an open Markdown cell uses, or null for a CSV field's plain box. */
  cellEditor: () => EditorView | null;
  down: (el: Element, opts?: any) => void;
  move: (el: Element) => void;
  up: () => void;
  dbl: (el: Element) => void;
  key: (el: Element, key: string, opts?: any) => KeyboardEvent;
  /** Press a key on the grid that holds focus. */
  gkey: (key: string, opts?: any, t?: number) => KeyboardEvent;
  /** Open the cell editor by double-click, put `value` in it and press Enter (or leave it open). */
  type: (r: number, c: number, value: string, finish?: 'Enter' | 'Tab' | null, t?: number) => void;
  clip: (type: 'copy' | 'cut' | 'paste', text?: string) => { text: string; html: string; prevented: boolean };
  focus: () => string | null;
  sel: () => number;
  /** Focus leaves the table for the text, and the table writes. */
  leave: () => Promise<string>;
  doc: () => string;
  destroy: () => void;
}

function mount(doc: string): Grid {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [editorExtensions(() => {})] }), parent });
  const tables = (): HTMLElement[] => Array.from(view.dom.querySelectorAll<HTMLElement>('.sheaf-table'));
  const need = <T,>(x: T | null | undefined, what: string): T => {
    if (x == null) throw new Error(`no ${what}`);
    return x;
  };
  const grid = (t = 0): HTMLElement => need(tables()[t]?.querySelector<HTMLElement>('.sheaf-table-grid'), `grid ${t}`);
  const cell = (r: number, c: number, t = 0): HTMLElement =>
    need(tables()[t]?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`), `cell ${r},${c} in table ${t}`);
  const gutter = (r: number, t = 0): HTMLElement => need(tables()[t]?.querySelectorAll<HTMLElement>('tbody .sheaf-table-gutter')[r], `gutter ${r}`);
  const corner = (t = 0): HTMLElement => need(tables()[t]?.querySelector<HTMLElement>('.sheaf-table-corner'), 'corner');
  /*
   * The open cell's field.
   *
   * A Markdown cell edits in a nested CodeMirror view, so there is no element with a `.value` to
   * read or write. A CSV field is still a plain text box. Both come back through one accessor:
   * for the nested view, the content element is given `value` on top of the editor's document, so
   * a scenario that sets or reads it drives the editor the way typing would.
   */
  const cellEditorAt = (el: HTMLElement | null): EditorView | null =>
    el && !(el instanceof G.HTMLTextAreaElement) && !(el instanceof G.HTMLInputElement) ? EditorView.findFromDOM(el) : null;
  const input = (): HTMLInputElement | HTMLTextAreaElement | null => {
    const el = view.dom.querySelector<HTMLElement>('.sheaf-table-input');
    if (!el) return null;
    if (el instanceof G.HTMLTextAreaElement || el instanceof G.HTMLInputElement) {
      return el as HTMLTextAreaElement;
    }
    const cm = cellEditorAt(el);
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
    if (!content.getAttribute('aria-label')) {
      const host = el.closest('[data-r]');
      const label = host?.getAttribute('aria-label') ?? host?.getAttribute('data-label');
      if (label) content.setAttribute('aria-label', label);
    }
    return content;
  };
  const cellEditor = (): EditorView | null => cellEditorAt(view.dom.querySelector<HTMLElement>('.sheaf-table-input'));
  const down = (el: Element, opts: any = {}): void => {
    el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...opts }));
  };
  const move = (el: Element): void => {
    el.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true }));
  };
  const up = (): void => {
    document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  };
  const dbl = (el: Element): void => {
    down(el);
    el.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  };
  const key = (el: Element, k: string, opts: any = {}): KeyboardEvent => {
    const { keyCode, ...rest } = opts;
    const e = new G.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...rest });
    if (keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: keyCode });
    el.dispatchEvent(e);
    return e;
  };
  const focusedGrid = (t?: number): HTMLElement => {
    if (t !== undefined) return grid(t);
    const ae = document.activeElement as HTMLElement | null;
    return ae?.classList?.contains('sheaf-table-grid') ? ae : grid(0);
  };
  const gkey = (k: string, opts: any = {}, t?: number): KeyboardEvent => key(focusedGrid(t), k, opts);
  const type = (r: number, c: number, value: string, finish: 'Enter' | 'Tab' | null = 'Enter', t = 0): void => {
    dbl(cell(r, c, t));
    const inp = need(input(), 'cell editor');
    inp.value = value;
    if (finish) key(inp, finish);
  };
  const clip = (type: 'copy' | 'cut' | 'paste', text = ''): { text: string; html: string; prevented: boolean } => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.classList?.contains('sheaf-table-grid')) ae.dispatchEvent(new G.Event('focus'));
    const store: Record<string, string> = { 'text/plain': text };
    const cd = { getData: (t: string) => store[t] ?? '', setData: (t: string, v: string) => void (store[t] = v) };
    const e = new G.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: cd });
    (ae ?? document).dispatchEvent(e);
    return { text: type === 'paste' ? '' : store['text/plain'] === text ? '' : store['text/plain'], html: store['text/html'] ?? '', prevented: e.defaultPrevented };
  };
  const focus = (): string | null => {
    const el = view.dom.querySelector<HTMLElement>('.sheaf-table .is-focus');
    return el ? `${el.dataset.r},${el.dataset.c}` : null;
  };
  const sel = (): number => view.dom.querySelectorAll('.sheaf-table .is-sel').length;
  const leave = async (): Promise<string> => {
    const ae = document.activeElement as HTMLElement | null;
    const wrap = ae?.closest?.('.sheaf-table');
    view.contentDOM.focus();
    (wrap ?? tables()[0])?.dispatchEvent(new G.Event('focusout', { bubbles: true }));
    await tick();
    await tick();
    return view.state.doc.toString();
  };
  return {
    view, tables, grid, cell, gutter, corner, input, cellEditor, down, move, up, dbl, key, gkey, type, clip, focus, sel, leave,
    doc: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      parent.remove();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
    },
  };
}

/** Mount, run, always destroy. */
async function withGrid(doc: string, fn: (g: Grid) => Result | Promise<Result>): Promise<Result> {
  const g = mount(doc);
  try {
    return await fn(g);
  } finally {
    g.destroy();
  }
}

const same = (got: string, want: string, extra = ''): Result => ({
  ok: got === want,
  detail: got === want ? '' : `${extra}got ${j(got)}, want ${j(want)}`,
});
const all = (checks: Record<string, boolean>, detail: unknown = ''): Result => {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: failed.length === 0, detail: failed.length ? `failed: ${failed.join(', ')} ${typeof detail === 'string' ? detail : j(detail)}` : '' };
};

// ---- documents ----
const INTRO = 'Intro\n\n';
const OUTRO = '\n\nAfter\n';
const T0 = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const T = INTRO + T0 + OUTRO;
const N0 = '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n| 10 | 11 | 12 |';
const N = INTRO + N0 + OUTRO;
const SMALL = INTRO + '| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |' + OUTRO;
const HEADER_ONLY0 = '| A | B |\n| - | - |';
const ONE0 = '| a |\n| - |\n| b |';
const Mod = { metaKey: true };

export const scenarios: Scenario[] = [
  // ---------------------------------------------------------------- tables.grid
  {
    id: 'tables.grid.u01', feature: 'tables.grid', name: 'A 1x1 table renders one header cell and one body cell',
    run: () => withGrid(INTRO + ONE0 + OUTRO, (g) => all({
      header: g.cell(-1, 0).textContent === 'a',
      body: g.cell(0, 0).textContent === 'b',
      noMore: !g.tables()[0].querySelector('[data-c="1"]') && !g.tables()[0].querySelector('[data-r="1"]'),
    })),
  },
  {
    id: 'tables.grid.u02', feature: 'tables.grid', name: 'A header-only table renders its header and no body rows',
    run: () => withGrid(INTRO + HEADER_ONLY0 + OUTRO, (g) => all({
      header: g.cell(-1, 1).textContent === 'B',
      noBody: g.tables()[0].querySelectorAll('tbody tr').length === 0,
      rowcount: g.grid().getAttribute('aria-rowcount') === '1',
    })),
  },
  {
    id: 'tables.grid.u03', feature: 'tables.grid', name: 'A table written without outer pipes renders as a grid',
    run: () => withGrid(INTRO + 'a | b\n--|--\n1 | 2' + OUTRO, (g) => all({
      grid: g.tables().length === 1,
      cells: g.cell(-1, 1).textContent === 'b' && g.cell(0, 0).textContent === '1',
    })),
  },
  {
    id: 'tables.grid.u04', feature: 'tables.grid', name: 'A table on the first line of the document renders as a grid when the file opens',
    run: () => withGrid(T0 + OUTRO, (g) => all({ grid: g.tables().length === 1, cell: g.cell(0, 0).textContent === 'apple' })),
  },
  {
    id: 'tables.grid.u05', feature: 'tables.grid', name: 'A table on the last line with no trailing newline renders as a grid',
    run: () => withGrid(INTRO + T0, (g) => all({ grid: g.tables().length === 1, cell: g.cell(1, 1).textContent === '12' })),
  },
  {
    id: 'tables.grid.u06', feature: 'tables.grid', name: 'Empty cells and a row shorter than the header render as blank cells in every column',
    run: () => withGrid(INTRO + '| a | b | c |\n| - | - | - |\n| 1 |   | 3 |\n| 4 |' + OUTRO, (g) => all({
      blank: g.cell(0, 1).textContent === '',
      short: g.cell(1, 0).textContent === '4' && g.cell(1, 1).textContent === '' && g.cell(1, 2).textContent === '',
    })),
  },
  {
    id: 'tables.grid.u07', feature: 'tables.grid', name: 'Center and right aligned columns render aligned',
    run: () => withGrid(INTRO + '| l | c | r |\n| :- | :-: | -: |\n| 1 | 2 | 3 |' + OUTRO, (g) => all({
      left: g.cell(0, 0).style.textAlign === 'left',
      center: g.cell(0, 1).style.textAlign === 'center',
      right: g.cell(0, 2).style.textAlign === 'right',
    })),
  },
  {
    id: 'tables.grid.u08', feature: 'tables.grid', name: 'Two tables separated by a blank line render as two grids',
    run: () => withGrid(INTRO + T0 + '\n\n' + N0 + OUTRO, (g) => all({ two: g.tables().length === 2, second: g.cell(3, 2, 1).textContent === '12' })),
  },
  {
    id: 'tables.grid.u09', feature: 'tables.grid', name: 'A table in a CRLF file renders the same cells',
    run: () => withGrid(T.replace(/\n/g, '\r\n'), (g) => all({ grid: g.tables().length === 1, cell: g.cell(1, 0).textContent === 'kiwi', rows: g.tables()[0].querySelectorAll('tbody tr').length === 2 })),
  },
  {
    id: 'tables.grid.u10', feature: 'tables.grid', name: 'Cell text that looks like HTML with a handler is shown as text and runs nothing',
    run: () => withGrid(INTRO + '| a |\n| - |\n| <img src=x onerror=alert(1)> |' + OUTRO, (g) => all({
      noImg: !g.cell(0, 0).querySelector('img'),
      text: g.cell(0, 0).textContent === '<img src=x onerror=alert(1)>',
    })),
  },
  {
    id: 'tables.grid.u11', feature: 'tables.grid', name: 'Emoji, CJK and numbers between spaces render exactly as written',
    run: () => withGrid(INTRO + '| a | b |\n| - | - |\n| 👨‍👩‍👧‍👦 | 名前 |\n| Top 10 of 20 | 한국어 |' + OUTRO, (g) => all({
      emoji: g.cell(0, 0).textContent === '👨‍👩‍👧‍👦',
      cjk: g.cell(0, 1).textContent === '名前',
      numbers: g.cell(1, 0).textContent === 'Top 10 of 20',
      korean: g.cell(1, 1).textContent === '한국어',
    })),
  },
  {
    id: 'tables.grid.u12', feature: 'tables.grid', name: 'A table only looked at is never written',
    run: () => withGrid(T, async (g) => same(await g.leave(), T)),
  },

  // ----------------------------------------------------------- tables.cell-edit
  {
    id: 'tables.cell-edit.u01', feature: 'tables.cell-edit', name: 'Typing on a selected cell replaces its value, Enter moves down, one line changes',
    run: () => withGrid(T, async (g) => {
      g.down(g.cell(0, 0));
      g.gkey('p');
      const inp = g.input()!;
      const started = inp?.value === 'p';
      inp.value = 'pear';
      g.key(inp, 'Enter');
      const moved = g.focus() === '1,0';
      const d = await g.leave();
      return all({ started, moved, file: d === T.replace('| apple | 3   |', '| pear  | 3   |') }, d);
    }),
  },
  {
    id: 'tables.cell-edit.u02', feature: 'tables.cell-edit', name: 'Tab past the last cell and typing adds exactly one line in the header style',
    run: () => withGrid(T, async (g) => {
      g.down(g.cell(1, 1));
      g.gkey('Tab');
      const at = g.focus();
      g.gkey('x');
      g.key(g.input()!, 'Enter');
      const d = await g.leave();
      return all({ newRow: at === '2,0', file: d === T.replace('| kiwi  | 12  |', '| kiwi  | 12  |\n| x     |     |') }, d);
    }),
  },
  {
    id: 'tables.cell-edit.u03', feature: 'tables.cell-edit', name: 'Tabbing past the last cell without typing leaves the file as it was',
    run: () => withGrid(T, async (g) => {
      g.down(g.cell(1, 1));
      g.gkey('Tab');
      g.gkey('Tab');
      g.gkey('Tab');
      return same(await g.leave(), T);
    }),
  },
  {
    id: 'tables.cell-edit.u04', feature: 'tables.cell-edit', name: 'Shift+Tab on the first header cell stays there and changes nothing',
    run: () => withGrid(T, async (g) => {
      g.dbl(g.cell(-1, 0));
      g.key(g.input()!, 'Tab', { shiftKey: true });
      const at = g.focus();
      const d = await g.leave();
      return all({ stays: at === '-1,0', file: d === T }, { at, d });
    }),
  },
  {
    id: 'tables.cell-edit.u05', feature: 'tables.cell-edit', name: 'Shift+Enter commits the cell and moves up',
    run: () => withGrid(T, async (g) => {
      g.dbl(g.cell(1, 0));
      g.input()!.value = 'fig';
      g.key(g.input()!, 'Enter', { shiftKey: true });
      const at = g.focus();
      const d = await g.leave();
      return all({ up: at === '0,0', file: d === T.replace('| kiwi  | 12  |', '| fig   | 12  |') }, { at, d });
    }),
  },
  {
    id: 'tables.cell-edit.u06', feature: 'tables.cell-edit', name: 'Escape after an edit started by typing puts the old value back',
    run: () => withGrid(T, async (g) => {
      g.down(g.cell(0, 0));
      g.gkey('z');
      g.input()!.value = 'zzz';
      g.key(g.input()!, 'Escape');
      const shown = g.cell(0, 0).textContent;
      const d = await g.leave();
      return all({ shown: shown === 'apple', file: d === T }, { shown, d });
    }),
  },
  {
    id: 'tables.cell-edit.u07', feature: 'tables.cell-edit', name: 'Double-click opens the cell with its whole value selected',
    run: () => withGrid(T, (g) => {
      g.dbl(g.cell(0, 0));
      const inp = g.input() as HTMLInputElement;
      // A Markdown cell edits in a nested editor, where "the whole value selected" is the editor's
      // own selection rather than a text box's selectionStart and selectionEnd.
      const cm = g.cellEditor();
      const sel = cm ? cm.state.selection.main : null;
      const whole = cm
        ? sel!.from === 0 && sel!.to === cm.state.doc.length
        : inp?.selectionStart === 0 && inp?.selectionEnd === 5;
      const hasFocus = cm ? cm.hasFocus || document.activeElement === inp : document.activeElement === inp;
      return all({ open: !!inp, value: inp?.value === 'apple', selected: whole, focused: hasFocus });
    }),
  },
  {
    id: 'tables.cell-edit.u08', feature: 'tables.cell-edit', name: 'Clicking another cell mid-edit keeps the typed value',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, 'plum', null);
      g.down(g.cell(1, 1));
      const shown = g.cell(0, 0).textContent;
      const d = await g.leave();
      return all({ shown: shown === 'plum', file: d === T.replace('| apple |', '| plum  |') }, d);
    }),
  },
  {
    id: 'tables.cell-edit.u09', feature: 'tables.cell-edit', name: 'Leaving the table mid-edit writes the typed value',
    run: () => withGrid(T, async (g) => {
      g.type(0, 1, '7', null);
      return same(await g.leave(), T.replace('| apple | 3   |', '| apple | 7   |'));
    }),
  },
  {
    id: 'tables.cell-edit.u10', feature: 'tables.cell-edit', name: 'A typed pipe is written escaped once and the row keeps its cells',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, 'a|b');
      return same(await g.leave(), T.replace('| apple |', '| a\\|b  |'));
    }),
  },
  {
    id: 'tables.cell-edit.u11', feature: 'tables.cell-edit', name: 'A value ending in a backslash in an unpadded table keeps the row its cells',
    run: async () => {
      const doc = INTRO + '|a|b|\n|-|-|\n|1|2|' + OUTRO;
      let written = '';
      await withGrid(doc, async (g) => {
        g.type(0, 0, 'x\\');
        written = await g.leave();
        return true;
      });
      return withGrid(written, (g) => all({ first: g.cell(0, 0).textContent === 'x\\', second: g.cell(0, 1).textContent === '2' }, written));
    },
  },
  {
    id: 'tables.cell-edit.u12', feature: 'tables.cell-edit', name: 'A value ending in a backslash in a padded table keeps the row its cells',
    run: async () => {
      let written = '';
      await withGrid(T, async (g) => {
        g.type(0, 0, 'x\\');
        written = await g.leave();
        return true;
      });
      return withGrid(written, (g) => all({ first: g.cell(0, 0).textContent === 'x\\', second: g.cell(0, 1).textContent === '3' }, written));
    },
  },
  {
    id: 'tables.cell-edit.u13', feature: 'tables.cell-edit', name: 'Editing a cell of a table without outer pipes changes only that cell',
    run: () => withGrid(INTRO + 'a | b\n--|--\n1 | 2\n3 | 4' + OUTRO, async (g) => {
      g.type(0, 0, 'x');
      return same(await g.leave(), INTRO + 'a | b\n--|--\nx | 2\n3 | 4' + OUTRO);
    }),
  },
  {
    id: 'tables.cell-edit.u14', feature: 'tables.cell-edit', name: 'Filling a cell past the end of a short row writes the missing cells in between',
    run: () => withGrid(INTRO + '| a | b | c |\n| - | - | - |\n| 1 |' + OUTRO, async (g) => {
      g.type(0, 2, 'z');
      return same(await g.leave(), INTRO + '| a | b | c |\n| - | - | - |\n| 1 |   | z |' + OUTRO);
    }),
  },
  {
    id: 'tables.cell-edit.u15', feature: 'tables.cell-edit', name: 'Editing a row with more cells than the header keeps the extra cells',
    run: () => withGrid(INTRO + '| a | b |\n| - | - |\n| 1 | 2 | 3 |' + OUTRO, async (g) => {
      g.type(0, 0, 'x');
      return same(await g.leave(), INTRO + '| a | b |\n| - | - |\n| x | 2 | 3 |' + OUTRO);
    }),
  },
  {
    id: 'tables.cell-edit.u16', feature: 'tables.cell-edit', name: 'Clearing a cell keeps the column width on that line',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, '');
      return same(await g.leave(), T.replace('| apple |', '|       |'));
    }),
  },
  {
    id: 'tables.cell-edit.u17', feature: 'tables.cell-edit', name: 'Double-clicking a header edits it and only the header line changes',
    run: () => withGrid(T, async (g) => {
      g.type(-1, 1, 'Count');
      return same(await g.leave(), T.replace('| Fruit | Qty |', '| Fruit | Count |'));
    }),
  },
  {
    id: 'tables.cell-edit.u18', feature: 'tables.cell-edit', name: 'Enter opens a selected cell and Enter again closes it unchanged without writing',
    run: () => withGrid(T, async (g) => {
      g.down(g.cell(0, 0));
      g.gkey('Enter');
      const opened = (g.input() as HTMLInputElement | null)?.value === 'apple';
      g.key(g.input()!, 'Enter');
      const at = g.focus();
      const d = await g.leave();
      return all({ opened, moved: at === '1,0', file: d === T }, { at, d });
    }),
  },
  {
    id: 'tables.cell-edit.u19', feature: 'tables.cell-edit', name: 'F2 opens the selected cell for editing',
    run: () => withGrid(T, (g) => {
      g.down(g.cell(1, 1));
      g.gkey('F2');
      return (g.input() as HTMLInputElement | null)?.value === '12';
    }),
  },
  {
    id: 'tables.cell-edit.u20', feature: 'tables.cell-edit', name: 'Spaces around a typed value are not written',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, '  pear  ');
      return same(await g.leave(), T.replace('| apple |', '| pear  |'));
    }),
  },
  {
    id: 'tables.cell-edit.u21', feature: 'tables.cell-edit', name: 'A cell edit in a CRLF document changes only that row',
    run: () => withGrid(T.replace(/\n/g, '\r\n'), async (g) => {
      g.type(1, 1, '13');
      return same(await g.leave(), T.replace('| 12  |', '| 13  |'));
    }),
  },

  // ------------------------------------------------------- tables.keyboard-reach
  {
    id: 'tables.keyboard-reach.u01', feature: 'tables.keyboard-reach', name: 'Down arrow from a heading directly above a table enters its header row',
    run: () => withGrid('## Head\n' + T0 + OUTRO, (g) => {
      g.view.dispatch({ selection: { anchor: 3 } });
      g.key(g.view.contentDOM, 'ArrowDown');
      return all({ header: g.focus() === '-1,0', focused: document.activeElement === g.grid() }, g.focus());
    }),
  },
  {
    id: 'tables.keyboard-reach.u02', feature: 'tables.keyboard-reach', name: 'A header-only table is entered from above and left below with the arrows',
    run: () => withGrid(INTRO + HEADER_ONLY0 + OUTRO, async (g) => {
      g.view.dispatch({ selection: { anchor: INTRO.length - 1 } });
      g.key(g.view.contentDOM, 'ArrowDown');
      const entered = g.focus() === '-1,0';
      g.gkey('ArrowDown');
      const head = g.view.state.selection.main.head;
      const d = await g.leave();
      return all({ entered, below: head === INTRO.length + HEADER_ONLY0.length + 1, file: d === INTRO + HEADER_ONLY0 + OUTRO }, { head, d });
    }),
  },
  {
    id: 'tables.keyboard-reach.u03', feature: 'tables.keyboard-reach', name: 'A header-only table is entered from below onto its header',
    run: () => withGrid(INTRO + HEADER_ONLY0 + OUTRO, (g) => {
      g.view.dispatch({ selection: { anchor: INTRO.length + HEADER_ONLY0.length + 1 } });
      g.key(g.view.contentDOM, 'ArrowUp');
      return all({ header: g.focus() === '-1,0', focused: document.activeElement === g.grid() }, g.focus());
    }),
  },
  {
    id: 'tables.keyboard-reach.u04', feature: 'tables.keyboard-reach', name: 'Down arrow walks a 1x1 table header, body, then out below',
    run: () => withGrid(INTRO + ONE0 + OUTRO, (g) => {
      g.view.dispatch({ selection: { anchor: INTRO.length - 1 } });
      g.key(g.view.contentDOM, 'ArrowDown');
      const a = g.focus();
      g.gkey('ArrowDown');
      const b = g.focus();
      g.gkey('ArrowDown');
      const head = g.view.state.selection.main.head;
      return all({ header: a === '-1,0', body: b === '0,0', out: head === INTRO.length + ONE0.length + 1 }, { a, b, head });
    }),
  },
  {
    id: 'tables.keyboard-reach.u05', feature: 'tables.keyboard-reach', name: 'Up from the header of a table on the first line puts the caret on a new line above it',
    run: () => withGrid(T0 + OUTRO, (g) => {
      g.down(g.cell(-1, 0));
      g.gkey('ArrowUp');
      const head = g.view.state.selection.main.head;
      return all({ caret: head === 0, focused: g.view.hasFocus || document.activeElement === g.view.contentDOM, table: g.view.state.doc.toString().endsWith(T0 + OUTRO) }, { head, d: g.doc() });
    }),
  },
  {
    id: 'tables.keyboard-reach.u06', feature: 'tables.keyboard-reach', name: 'Up out of a first-line table and back down without typing leaves the file as it was',
    run: () => withGrid(T0 + OUTRO, async (g) => {
      g.down(g.cell(-1, 0));
      g.gkey('ArrowUp');
      await tick();
      // Back down to the table: as many presses as it takes to reach the header.
      for (let i = 0; i < 4 && document.activeElement !== g.grid(); i++) g.key(g.view.contentDOM, 'ArrowDown');
      const d = await g.leave();
      return same(d, T0 + OUTRO);
    }),
  },
  {
    id: 'tables.keyboard-reach.u07', feature: 'tables.keyboard-reach', name: 'Down out of the last row of a table at the end of a file with no newline gives a line to type on',
    run: () => withGrid(INTRO + T0, (g) => {
      g.down(g.cell(1, 0));
      g.gkey('ArrowDown');
      const d = g.doc();
      return all({ file: d === INTRO + T0 + '\n', caret: g.view.state.selection.main.head === d.length }, d);
    }),
  },
  {
    id: 'tables.keyboard-reach.u08', feature: 'tables.keyboard-reach', name: 'Down out of one table then down again enters the next table below',
    run: () => withGrid(INTRO + T0 + '\n\n' + T0 + OUTRO, (g) => {
      g.down(g.cell(1, 0, 0));
      g.gkey('ArrowDown', {}, 0);
      const head = g.view.state.selection.main.head;
      const between = head === INTRO.length + T0.length + 1;
      g.key(g.view.contentDOM, 'ArrowDown');
      return all({ between, second: document.activeElement === g.grid(1), header: g.tables()[1].querySelector('.is-focus')?.getAttribute('data-r') === '-1' }, { head });
    }),
  },
  {
    id: 'tables.keyboard-reach.u09', feature: 'tables.keyboard-reach', name: 'Leaving the last row with Down after an edit writes it and leaves the caret on the line below',
    run: () => withGrid(T, async (g) => {
      g.type(1, 1, '1200');
      g.gkey('ArrowDown');
      await tick();
      await tick();
      const d = g.doc();
      const line = g.view.state.doc.lineAt(g.view.state.selection.main.head);
      return all({ file: d === T.replace('| kiwi  | 12  |', '| kiwi  | 1200 |'), line: line.number === 7 && line.text === '' }, { d, line: line.number });
    }),
  },

  // ---------------------------------------------------------- tables.navigation
  {
    id: 'tables.navigation.u01', feature: 'tables.navigation', name: 'Home, End and Cmd+Right in a one-column table stay on the only cell of the row',
    run: () => withGrid(INTRO + '| A |\n| - |\n| 1 |\n| 2 |' + OUTRO, (g) => {
      g.down(g.cell(1, 0));
      const seen: (string | null)[] = [];
      for (const [k, o] of [['Home', {}], ['End', {}], ['ArrowRight', Mod]] as const) {
        g.gkey(k, o);
        seen.push(g.focus());
      }
      return { ok: seen.every((s) => s === '1,0'), detail: j(seen) };
    }),
  },
  {
    id: 'tables.navigation.u02', feature: 'tables.navigation', name: 'Page Down and Cmd+End in a header-only table stay in the header row',
    run: () => withGrid(INTRO + HEADER_ONLY0 + OUTRO, (g) => {
      g.dbl(g.cell(-1, 0));
      g.key(g.input()!, 'Escape');
      g.gkey('PageDown');
      const a = g.focus();
      g.gkey('End', Mod);
      const b = g.focus();
      return all({ page: a === '-1,0', end: b === '-1,1' }, { a, b });
    }),
  },
  {
    id: 'tables.navigation.u03', feature: 'tables.navigation', name: 'Cmd+Right then Shift+Cmd+Left selects the whole row',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(1, 1));
      g.gkey('ArrowRight', Mod);
      const a = g.focus();
      g.gkey('ArrowLeft', { metaKey: true, shiftKey: true });
      // Shift grows the block from its far corner; the active cell stays where it was.
      return all({ edge: a === '1,2', focus: g.focus() === '1,2', row: g.sel() === 3 }, { a, f: g.focus(), sel: g.sel() });
    }),
  },
  {
    id: 'tables.navigation.u04', feature: 'tables.navigation', name: 'Cmd+End then Shift+Cmd+Home selects every cell including the header',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(1, 1));
      g.gkey('End', Mod);
      g.gkey('Home', { metaKey: true, shiftKey: true });
      return all({ focus: g.focus() === '3,2', count: g.sel() === 15 }, { f: g.focus(), sel: g.sel() });
    }),
  },
  {
    id: 'tables.navigation.u05', feature: 'tables.navigation', name: 'Right at the last column and Left at the first column stay put',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(2, 2));
      g.gkey('ArrowRight');
      const a = g.focus();
      g.gkey('Home');
      g.gkey('ArrowLeft');
      const b = g.focus();
      return all({ right: a === '2,2', left: b === '2,0' }, { a, b });
    }),
  },
  {
    id: 'tables.navigation.u06', feature: 'tables.navigation', name: 'Shift+Up past the header extends the selection and keeps focus in the grid',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 0));
      g.gkey('ArrowUp', { shiftKey: true });
      g.gkey('ArrowUp', { shiftKey: true });
      return all({ focus: g.focus() === '0,0', sel: g.sel() === 2, inGrid: document.activeElement === g.grid() }, { f: g.focus(), sel: g.sel() });
    }),
  },
  {
    id: 'tables.navigation.u07', feature: 'tables.navigation', name: 'Shift+Down past the last row extends and keeps focus in the grid',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(2, 1));
      g.gkey('ArrowDown', { shiftKey: true });
      g.gkey('ArrowDown', { shiftKey: true });
      return all({ focus: g.focus() === '2,1', sel: g.sel() === 2, inGrid: document.activeElement === g.grid() }, { f: g.focus(), sel: g.sel() });
    }),
  },
  {
    id: 'tables.navigation.u08', feature: 'tables.navigation', name: 'Page Down from the header of a short table stops on the last row',
    run: () => withGrid(N, (g) => {
      g.dbl(g.cell(-1, 1));
      g.key(g.input()!, 'Escape');
      g.gkey('PageDown');
      return same(String(g.focus()), '3,1');
    }),
  },
  {
    id: 'tables.navigation.u09', feature: 'tables.navigation', name: 'Tab at the end of a row wraps to the next row and Shift+Tab wraps back',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 2));
      g.gkey('Tab');
      const a = g.focus();
      g.gkey('Tab', { shiftKey: true });
      return all({ next: a === '1,0', back: g.focus() === '0,2' }, { a, b: g.focus() });
    }),
  },
  {
    id: 'tables.navigation.u10', feature: 'tables.navigation', name: 'Shift+Cmd+Down selects the rest of the column',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 1));
      g.gkey('ArrowDown', { metaKey: true, shiftKey: true });
      return all({ focus: g.focus() === '0,1', sel: g.sel() === 4 }, { f: g.focus(), sel: g.sel() });
    }),
  },
  {
    id: 'tables.navigation.u11', feature: 'tables.navigation', name: 'A run of navigation keys leaves the file as written',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(1, 1));
      for (const [k, o] of [['Home', {}], ['End', { shiftKey: true }], ['ArrowDown', Mod], ['PageUp', {}], ['Home', Mod], ['End', { metaKey: true, shiftKey: true }], ['Tab', {}], [' ', { shiftKey: true }]] as const) g.gkey(k, o);
      return same(await g.leave(), N);
    }),
  },

  // ----------------------------------------------------------- tables.selection
  {
    id: 'tables.selection.u01', feature: 'tables.selection', name: 'Shift-click up and to the left selects the rectangle back to the first cell',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(2, 2));
      g.down(g.cell(0, 0), { shiftKey: true });
      return all({ sel: g.sel() === 9, focus: g.focus() === '2,2' }, { sel: g.sel(), f: g.focus() });
    }),
  },
  {
    id: 'tables.selection.u02', feature: 'tables.selection', name: 'A drag that grows up-left and then comes back shrinks the selection to one cell',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(2, 2));
      g.move(g.cell(1, 1));
      const a = g.sel();
      g.move(g.cell(0, 0));
      const b = g.sel();
      g.move(g.cell(2, 2));
      const c = g.sel();
      g.up();
      return all({ grow: a === 4, more: b === 9, back: c === 1 }, { a, b, c });
    }),
  },
  {
    id: 'tables.selection.u03', feature: 'tables.selection', name: 'After the mouse is released, moving over other cells does not change the selection',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 0));
      g.move(g.cell(1, 1));
      g.up();
      g.move(g.cell(3, 2));
      return same(String(g.sel()), '4');
    }),
  },
  {
    id: 'tables.selection.u04', feature: 'tables.selection', name: 'Clicking the corner selects every cell and a later cell click collapses to that cell',
    run: () => withGrid(N, (g) => {
      g.down(g.corner());
      const allSel = g.sel();
      g.down(g.cell(1, 1));
      return all({ all: allSel === 15, one: g.sel() === 1 && g.focus() === '1,1' }, { allSel, sel: g.sel() });
    }),
  },
  {
    id: 'tables.selection.u05', feature: 'tables.selection', name: 'Cmd+A in the grid selects every cell of the table only',
    run: () => withGrid(INTRO + N0 + '\n\n' + T0 + OUTRO, (g) => {
      g.down(g.cell(1, 1, 0));
      g.gkey('a', Mod, 0);
      const inFirst = g.tables()[0].querySelectorAll('.is-sel').length;
      const inSecond = g.tables()[1].querySelectorAll('.is-sel').length;
      return all({ first: inFirst === 15, second: inSecond === 0, docSel: g.view.state.selection.main.empty }, { inFirst, inSecond });
    }),
  },
  {
    id: 'tables.selection.u06', feature: 'tables.selection', name: 'Clicking a header selects its column and Shift-clicking another header selects the columns between',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(-1, 0));
      const one = g.sel();
      g.down(g.cell(-1, 2), { shiftKey: true });
      return all({ column: one === 5, columns: g.sel() === 15 }, { one, sel: g.sel() });
    }),
  },
  {
    id: 'tables.selection.u07', feature: 'tables.selection', name: 'Clicking a row number selects that row',
    run: () => withGrid(N, (g) => {
      g.down(g.gutter(2));
      g.up();
      return all({ row: g.sel() === 3, cells: [0, 1, 2].every((c) => g.cell(2, c).classList.contains('is-sel')) }, g.sel());
    }),
  },
  {
    id: 'tables.selection.u08', feature: 'tables.selection', name: 'Shift+Right then Shift+Left past the start cell reverses the selection direction',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 1));
      g.gkey('ArrowRight', { shiftKey: true });
      const a = g.sel();
      g.gkey('ArrowLeft', { shiftKey: true });
      g.gkey('ArrowLeft', { shiftKey: true });
      return all({ right: a === 2, reversed: g.sel() === 2 && g.focus() === '0,1' && g.cell(0, 0).classList.contains('is-sel') }, { a, sel: g.sel(), f: g.focus() });
    }),
  },
  {
    id: 'tables.selection.u09', feature: 'tables.selection', name: 'Selecting by corner, drag and Shift-click never writes the file',
    run: () => withGrid(N, async (g) => {
      g.down(g.corner());
      g.down(g.cell(0, 0));
      g.move(g.cell(3, 2));
      g.up();
      g.down(g.cell(1, 0), { shiftKey: true });
      g.gkey(' ', { shiftKey: true });
      return same(await g.leave(), N);
    }),
  },
  {
    id: 'tables.selection.u10', feature: 'tables.selection', name: 'Backspace on a selected block empties those cells and changes only their lines',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.down(g.cell(1, 1), { shiftKey: true });
      g.gkey('Backspace');
      return same(await g.leave(), N.replace('| 1 | 2 | 3 |', '|   |   | 3 |').replace('| 4 | 5 | 6 |', '|   |   | 6 |'));
    }),
  },
  {
    id: 'tables.selection.u11', feature: 'tables.selection', name: 'Escape clears the selection and keeps focus in the grid',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 0));
      g.down(g.cell(1, 1), { shiftKey: true });
      g.gkey('Escape');
      return all({
        cleared: g.sel() === 0 && !g.focus(),
        aria: g.tables()[0].querySelectorAll('[aria-selected="true"]').length === 0,
        inGrid: document.activeElement === g.grid(),
      });
    }),
  },
  {
    id: 'tables.selection.u12', feature: 'tables.selection', name: 'Clicking into the text below takes the selection highlight off the table',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(1, 1));
      g.down(g.cell(2, 2), { shiftKey: true });
      await g.leave();
      return all({ noSel: g.sel() === 0, noFocusRing: !g.focus() }, { sel: g.sel(), focus: g.focus() });
    }),
  },

  // ----------------------------------------------------------- tables.clipboard
  {
    id: 'tables.clipboard.u01', feature: 'tables.clipboard', name: 'Copying a block selected up-left gives its rows top to bottom as TSV and HTML',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(1, 1));
      g.down(g.cell(0, 0), { shiftKey: true });
      const { text, html } = g.clip('copy');
      return all({ text: text === '1\t2\n4\t5', html: html === '<table><tr><td>1</td><td>2</td></tr><tr><td>4</td><td>5</td></tr></table>' }, { text, html });
    }),
  },
  {
    id: 'tables.clipboard.u02', feature: 'tables.clipboard', name: 'Copying the whole table includes the header row first',
    run: () => withGrid(N, (g) => {
      g.down(g.corner());
      const { text } = g.clip('copy');
      return same(text, 'A\tB\tC\n1\t2\t3\n4\t5\t6\n7\t8\t9\n10\t11\t12');
    }),
  },
  {
    id: 'tables.clipboard.u03', feature: 'tables.clipboard', name: 'Copied HTML escapes markup and ampersands while the text keeps them',
    run: () => withGrid(INTRO + '| a |\n| - |\n| x<br>&y |' + OUTRO, (g) => {
      g.down(g.cell(0, 0));
      const { text, html } = g.clip('copy');
      return all({ text: text === 'x<br>&y', html: html === '<table><tr><td>x&lt;br>&amp;y</td></tr></table>' }, { text, html });
    }),
  },
  {
    id: 'tables.clipboard.u04', feature: 'tables.clipboard', name: 'Pasting a sentence with a comma into a cell puts the whole sentence in that cell',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.clip('paste', 'Hello, world');
      const shown = g.cell(0, 0).textContent;
      return same(await g.leave(), N.replace('| 1 | 2 | 3 |', '| Hello, world | 2 | 3 |'), `cell shows ${j(shown)}; `);
    }),
  },
  {
    id: 'tables.clipboard.u05', feature: 'tables.clipboard', name: 'Pasting text with double quotes into a cell keeps the quotes',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.clip('paste', 'She said "hi"');
      return same(await g.leave(), N.replace('| 1 | 2 | 3 |', '| She said "hi" | 2 | 3 |'));
    }),
  },
  {
    id: 'tables.clipboard.u06', feature: 'tables.clipboard', name: 'Pasting a 3x3 block into a 2x2 table grows it by one row and one column and keeps the text around it',
    run: () => withGrid(SMALL, async (g) => {
      g.down(g.cell(0, 0));
      g.clip('paste', 'a\tb\tc\nd\te\tf\ng\th\ti');
      const selected = g.sel();
      const d = await g.leave();
      return all({ selected: selected === 9, file: d === INTRO + '| A | B |     |\n| - | - | --- |\n| a | b | c   |\n| d | e | f   |\n| g | h | i   |' + OUTRO }, d);
    }),
  },
  {
    id: 'tables.clipboard.u07', feature: 'tables.clipboard', name: 'A spreadsheet paste with CRLF line ends and a trailing newline adds no empty row',
    run: () => withGrid(SMALL, async (g) => {
      g.down(g.cell(0, 0));
      g.clip('paste', 'x\ty\r\nz\tw\r\n');
      return same(await g.leave(), INTRO + '| A | B |\n| - | - |\n| x | y |\n| z | w |' + OUTRO);
    }),
  },
  {
    id: 'tables.clipboard.u08', feature: 'tables.clipboard', name: 'A copied spreadsheet column with an empty cell pastes the empty cell in its place',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 0));
      g.clip('paste', 'x\r\n\r\ny\r\n');
      const col = [0, 1, 2].map((r) => g.cell(r, 0).textContent);
      return { ok: j(col) === j(['x', '', 'y']), detail: `column shows ${j(col)}` };
    }),
  },
  {
    id: 'tables.clipboard.u09', feature: 'tables.clipboard', name: 'Cut then undo puts the cells back and the file is unchanged',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.down(g.cell(0, 1), { shiftKey: true });
      const { text } = g.clip('cut');
      const emptied = g.cell(0, 0).textContent === '' && g.cell(0, 1).textContent === '';
      g.gkey('z', Mod);
      const d = await g.leave();
      return all({ copied: text === '1\t2', emptied, file: d === N }, { text, d });
    }),
  },
  {
    id: 'tables.clipboard.u10', feature: 'tables.clipboard', name: 'Pasting an empty clipboard changes nothing',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      const { prevented } = g.clip('paste', '');
      return all({ notPrevented: !prevented, file: (await g.leave()) === N });
    }),
  },
  {
    id: 'tables.clipboard.u11', feature: 'tables.clipboard', name: 'Paste while a cell is open lands in the cell rather than growing the grid',
    run: () => withGrid(N, (g) => {
      g.dbl(g.cell(0, 0));
      g.clip('paste', 'a\tb');
      // The open cell owns the paste now that it is an editor of its own, so it claims the event
      // rather than leaving it. What matters is where the text went: into the cell, and not into
      // new columns.
      const landed = (g.input()?.value ?? '').includes('a');
      return all({ landed, stillEditing: !!g.input(), noGrow: g.tables()[0].querySelectorAll('thead th').length === 4 });
    }),
  },
  {
    id: 'tables.clipboard.u12', feature: 'tables.clipboard', name: 'Copy with no cell selected leaves the clipboard alone',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(0, 0));
      g.gkey('Escape');
      const { text, html, prevented } = g.clip('copy');
      return all({ text: text === '', html: html === '', notPrevented: !prevented });
    }),
  },
  {
    id: 'tables.clipboard.u13', feature: 'tables.clipboard', name: 'Pasting one value over a column selected by its header fills the body without replacing the header',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(-1, 1));
      g.clip('paste', 'Z');
      return all({ header: g.cell(-1, 1).textContent === 'B', body: [0, 1, 2, 3].every((r) => g.cell(r, 1).textContent === 'Z') }, g.cell(-1, 1).textContent);
    }),
  },

  // --------------------------------------------------------------- tables.undo
  {
    id: 'tables.undo.u01', feature: 'tables.undo', name: 'Undo steps back through two cell edits newest first, and the file ends as written',
    run: () => withGrid(N, async (g) => {
      g.type(0, 0, 'x');
      g.type(0, 1, 'y');
      g.gkey('z', Mod);
      const one = [g.cell(0, 0).textContent, g.cell(0, 1).textContent];
      g.gkey('z', Mod);
      const two = [g.cell(0, 0).textContent, g.cell(0, 1).textContent];
      const d = await g.leave();
      return all({ newest: j(one) === j(['x', '2']), both: j(two) === j(['1', '2']), file: d === N }, { one, two, d });
    }),
  },
  {
    id: 'tables.undo.u02', feature: 'tables.undo', name: 'One undo restores every cell a Backspace emptied',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.down(g.cell(1, 2), { shiftKey: true });
      g.gkey('Backspace');
      g.gkey('z', Mod);
      return same(await g.leave(), N);
    }),
  },
  {
    id: 'tables.undo.u03', feature: 'tables.undo', name: 'Undoing a value typed into a row added by Tab leaves no empty row in the file',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(3, 2));
      g.gkey('Tab');
      g.gkey('q');
      g.key(g.input()!, 'Enter');
      g.gkey('z', Mod);
      g.gkey('z', Mod);
      return same(await g.leave(), N);
    }),
  },
  {
    id: 'tables.undo.u04', feature: 'tables.undo', name: 'Ctrl+Y redoes an undone cell edit',
    run: () => withGrid(N, async (g) => {
      g.type(2, 2, 'x');
      g.gkey('z', Mod);
      g.gkey('y', { ctrlKey: true });
      return same(await g.leave(), N.replace('| 7 | 8 | 9 |', '| 7 | 8 | x |'));
    }),
  },
  {
    id: 'tables.undo.u05', feature: 'tables.undo', name: 'A new edit after undo drops the undone edit from redo',
    run: () => withGrid(N, async (g) => {
      g.type(0, 0, 'x');
      g.gkey('z', Mod);
      g.type(1, 1, 'y');
      g.gkey('z', { metaKey: true, shiftKey: true });
      return same(await g.leave(), N.replace('| 4 | 5 | 6 |', '| 4 | y | 6 |'));
    }),
  },
  {
    id: 'tables.undo.u06', feature: 'tables.undo', name: 'Undo puts the active cell back on the cell that changed',
    run: () => withGrid(N, (g) => {
      g.type(2, 2, 'x');
      g.down(g.cell(0, 0));
      g.gkey('z', Mod);
      return same(String(g.focus()), '2,2');
    }),
  },
  {
    id: 'tables.undo.u07', feature: 'tables.undo', name: 'With no table edits left, undo reverts the text typed before entering the table and keeps focus in the grid',
    run: () => withGrid(N, (g) => {
      g.view.dispatch({ changes: { from: 5, insert: 'X' }, selection: { anchor: 6 }, userEvent: 'input.type' });
      g.down(g.cell(0, 0));
      g.gkey('z', Mod);
      return all({ file: g.doc() === N, inGrid: document.activeElement === g.grid() }, g.doc());
    }),
  },
  {
    id: 'tables.undo.u08', feature: 'tables.undo', name: 'Undo after a paste that filled a selection restores every cell',
    run: () => withGrid(N, async (g) => {
      g.down(g.cell(0, 0));
      g.down(g.cell(2, 1), { shiftKey: true });
      g.clip('paste', 'Z');
      g.gkey('z', Mod);
      return same(await g.leave(), N);
    }),
  },

  {
    id: 'tables.undo.u09', feature: 'tables.undo', name: 'Right after a cell edit the editor has something to undo, so the toolbar Undo button can act',
    run: () => withGrid(N, (g) => {
      const before = undoDepth(g.view.state);
      g.type(1, 1, 'x');
      const after = undoDepth(g.view.state);
      return { ok: after > before, detail: `undo depth before ${before}, after the edit ${after}` };
    }),
  },

  // -------------------------------------------------------- tables.cell-content
  {
    id: 'tables.cell-content.u01', feature: 'tables.cell-content', name: 'Inline code with an escaped pipe shows a pipe in code and is not rewritten',
    run: () => {
      const doc = INTRO + '| a | b |\n| - | - |\n| `x \\| y` | 2 |' + OUTRO;
      return withGrid(doc, async (g) => {
        const code = g.cell(0, 0).querySelector('code')?.textContent;
        g.down(g.cell(0, 0));
        const d = await g.leave();
        return all({ code: code === 'x | y', file: d === doc }, { code });
      });
    },
  },
  {
    id: 'tables.cell-content.u02', feature: 'tables.cell-content', name: 'A link cell shows its text and editing the next cell keeps the link line byte for byte',
    run: () => {
      const doc = INTRO + '| Site | n |\n| ---- | - |\n| [Sheaf](https://example.com/a_b_c?x=1&y=2) | 2 |' + OUTRO;
      return withGrid(doc, async (g) => {
        const text = g.cell(0, 0).textContent;
        g.type(0, 1, '9');
        const d = await g.leave();
        return all({ text: text === 'Sheaf', file: d === doc.replace('| 2 |', '| 9 |') }, { text, d });
      });
    },
  },
  {
    id: 'tables.cell-content.u03', feature: 'tables.cell-content', name: '<br>, <br/> and <BR> all show as line breaks',
    run: () => withGrid(INTRO + '| a | b | c |\n| - | - | - |\n| 1<br>2 | 3<br/>4 | 5<BR>6 |' + OUTRO, (g) => {
      const breaks = [0, 1, 2].map((c) => g.cell(0, c).querySelectorAll('br').length);
      return { ok: breaks.every((n) => n === 1), detail: j(breaks) };
    }),
  },
  {
    id: 'tables.cell-content.u04', feature: 'tables.cell-content', name: 'Typing <br> into a cell writes it as typed and shows a line break',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, 'a<br>b');
      const d = await g.leave();
      return all({ file: d === T.replace('| apple |', '| a<br>b |'), shown: g.cell(0, 0).querySelectorAll('br').length === 1 }, d);
    }),
  },
  {
    id: 'tables.cell-content.u05', feature: 'tables.cell-content', name: 'Backslash-escaped asterisks and backslashes show as the characters, not as italic or with backslashes',
    run: () => withGrid(INTRO + '| a | b |\n| - | - |\n| \\*not italic\\* | C:\\\\Users |' + OUTRO, (g) => {
      const a = g.cell(0, 0);
      const b = g.cell(0, 1);
      return all({ stars: a.textContent === '*not italic*', noEm: !a.querySelector('em'), backslash: b.textContent === 'C:\\Users' }, { a: a.innerHTML, b: b.textContent });
    }),
  },
  {
    id: 'tables.cell-content.u06', feature: 'tables.cell-content', name: 'An HTML entity in a cell shows as the character it names',
    run: () => withGrid(INTRO + '| a |\n| - |\n| AT&amp;T &lt;3 |' + OUTRO, (g) => same(String(g.cell(0, 0).textContent), 'AT&T <3')),
  },
  {
    id: 'tables.cell-content.u07', feature: 'tables.cell-content', name: 'Editing next to an emoji family keeps the emoji bytes',
    run: () => {
      const doc = INTRO + '| e | name   |\n| - | ------ |\n| 👨‍👩‍👧‍👦 | family |' + OUTRO;
      return withGrid(doc, async (g) => {
        g.type(0, 1, 'fam');
        return same(await g.leave(), doc.replace('| family |', '| fam    |'));
      });
    },
  },
  {
    id: 'tables.cell-content.u08', feature: 'tables.cell-content', name: 'A CJK value typed into a padded cell keeps the column lined up for a monospace reader',
    run: () => {
      const doc = INTRO + '| Name  | Qty |\n| ----- | --- |\n| apple | 3   |' + OUTRO;
      return withGrid(doc, async (g) => {
        g.type(0, 0, '日本');
        return same(await g.leave(), doc.replace('| apple |', '| 日本  |'));
      });
    },
  },
  {
    id: 'tables.cell-content.u09', feature: 'tables.cell-content', name: 'Tab and Escape while an input method is composing stay with the input method',
    run: () => withGrid(T, (g) => {
      g.dbl(g.cell(0, 0));
      const inp = g.input()!;
      inp.value = 'にほ';
      const tab = g.key(inp, 'Tab', { isComposing: true });
      const afterTab = g.input() === inp && g.focus() === '0,0';
      g.key(inp, 'Escape', { isComposing: true });
      const afterEsc = g.input() === inp;
      return all({ tabNotTaken: !tab.defaultPrevented, afterTab, afterEsc });
    }),
  },
  {
    id: 'tables.cell-content.u10', feature: 'tables.cell-content', name: 'Starting to type with an input method on a selected cell opens that cell for the composition',
    run: () => withGrid(T, (g) => {
      g.down(g.cell(0, 0));
      g.gkey('Process', { keyCode: 229 });
      const inp = g.input();
      return all({ opened: !!inp, focused: !!inp && document.activeElement === inp }, { active: (document.activeElement as HTMLElement)?.className });
    }),
  },
  {
    id: 'tables.cell-content.u11', feature: 'tables.cell-content', name: 'A pipe typed inside inline code is written escaped and shows as a pipe in code',
    run: () => withGrid(T, async (g) => {
      g.type(0, 0, '`a|b`');
      const d = await g.leave();
      return all({ file: d === T.replace('| apple |', '| `a\\|b` |'), code: g.cell(0, 0).querySelector('code')?.textContent === 'a|b' }, d);
    }),
  },

  // --------------------------------------------------------------- tables.a11y
  {
    id: 'tables.a11y.u01', feature: 'tables.a11y', name: 'Cells of two tables in one document have unique ids',
    run: () => withGrid(INTRO + T0 + '\n\n' + T0 + OUTRO, (g) => {
      const ids = Array.from(g.view.dom.querySelectorAll('.sheaf-table [id]')).map((e) => e.id);
      return { ok: ids.length === 12 && new Set(ids).size === ids.length, detail: `${ids.length} ids, ${new Set(ids).size} unique` };
    }),
  },
  {
    id: 'tables.a11y.u02', feature: 'tables.a11y', name: 'The active cell named to assistive tech exists after undo redraws the grid',
    run: () => withGrid(N, (g) => {
      g.type(1, 1, 'x');
      g.gkey('z', Mod);
      const id = g.grid().getAttribute('aria-activedescendant');
      const el = id ? document.getElementById(id) : null;
      return all({ exists: !!el, isFocus: !!el && el.classList.contains('is-focus') }, id);
    }),
  },
  {
    id: 'tables.a11y.u03', feature: 'tables.a11y', name: 'The row count told to assistive tech grows when Tab adds a row',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(3, 2));
      g.gkey('Tab');
      return same(String(g.grid().getAttribute('aria-rowcount')), '6');
    }),
  },
  {
    id: 'tables.a11y.u04', feature: 'tables.a11y', name: 'A table with blank headers is named Table and its cell editor names the column by number',
    run: () => withGrid(INTRO + '|   |   |\n| - | - |\n| 1 | 2 |' + OUTRO, (g) => {
      g.dbl(g.cell(0, 1));
      return all({ grid: g.grid().getAttribute('aria-label') === 'Table', input: g.input()?.getAttribute('aria-label') === 'Column 2, row 1' }, { grid: g.grid().getAttribute('aria-label'), input: g.input()?.getAttribute('aria-label') });
    }),
  },
  {
    id: 'tables.a11y.u05', feature: 'tables.a11y', name: 'A header cell editor is labeled as the header of its column',
    run: () => withGrid(T, (g) => {
      g.dbl(g.cell(-1, 0));
      return same(String(g.input()?.getAttribute('aria-label')), 'Header of Fruit');
    }),
  },
  {
    id: 'tables.a11y.u06', feature: 'tables.a11y', name: 'The grid name follows a header edited during the visit',
    run: () => withGrid(T, (g) => {
      g.type(-1, 0, 'Name');
      return same(String(g.grid().getAttribute('aria-label')), 'Table: Name, Qty');
    }),
  },
  {
    id: 'tables.a11y.u07', feature: 'tables.a11y', name: 'A column selected by its header marks the header and every body cell selected',
    run: () => withGrid(N, (g) => {
      g.down(g.cell(-1, 2));
      const selected = Array.from(g.tables()[0].querySelectorAll<HTMLElement>('[aria-selected="true"]')).map((e) => `${e.dataset.r},${e.dataset.c}`);
      return same(selected.join(' '), '-1,2 0,2 1,2 2,2 3,2');
    }),
  },
  {
    id: 'tables.a11y.u08', feature: 'tables.a11y', name: 'Rows exposed as rows match the row count and each holds one exposed cell per column',
    run: () => withGrid(N, (g) => {
      const rows = Array.from(g.tables()[0].querySelectorAll('[role="row"]'));
      const perRow = rows.map((r) => r.querySelectorAll('[role="gridcell"], [role="columnheader"]').length);
      return all({ rows: String(rows.length) === g.grid().getAttribute('aria-rowcount'), cols: perRow.every((n) => String(n) === g.grid().getAttribute('aria-colcount')) }, perRow);
    }),
  },
  {
    id: 'tables.a11y.u09', feature: 'tables.a11y', name: 'The cell editor names the same row number the row number column shows',
    run: () => withGrid(N, (g) => {
      g.dbl(g.cell(2, 0));
      const shown = g.gutter(2).textContent;
      return same(String(g.input()?.getAttribute('aria-label')), `A, row ${shown}`);
    }),
  },

  // -------------------------------------------------------------- tables.touch
  {
    id: 'tables.touch.u01', feature: 'tables.touch', name: 'A pen press-and-hold on a cell opens the table menu without taking focus from the grid',
    run: () => withGrid(T, (g) => {
      mountContextMenu(g.view.dom, { getView: () => g.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      g.down(g.cell(1, 0));
      const e = new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30 });
      Object.defineProperty(e, 'pointerType', { value: 'pen' });
      g.cell(1, 0).dispatchEvent(e);
      const menu = Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).find((m) => !m.hidden);
      return all({ menu: !!menu, rowActions: !!menu && /Insert row above/.test(menu.textContent ?? ''), focus: document.activeElement === g.grid() });
    }),
  },
  {
    id: 'tables.touch.u02', feature: 'tables.touch', name: 'A touch press-and-hold inside an open cell editor is left to the text field',
    run: () => withGrid(T, (g) => {
      mountContextMenu(g.view.dom, { getView: () => g.view, getFileName: () => 'doc.md', copyToClipboard: () => {} });
      g.dbl(g.cell(0, 0));
      const inp = g.input()!;
      const e = new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      inp.dispatchEvent(e);
      const menu = Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu')).some((m) => !m.hidden);
      return all({ notPrevented: !e.defaultPrevented, noMenu: !menu, editing: document.activeElement === inp });
    }),
  },
];
