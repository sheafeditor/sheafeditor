// Unit scenarios for table operations: rows and columns, move, sort, align, pad,
// Copy ref, row line tooltips, change marks, outside merges, range paste, table
// insertion and table shapes. Each mounts the editor with the webview's own
// extensions and the right-click menu, drives the grid through DOM events, and
// compares the whole document, so a reformat of rows an operation should not
// touch shows up. A failing scenario is a bug candidate, never a weakened check.
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { editorExtensions } from '../../../src/webview/editorExtensions';
import { tableActionsAt, insertPipeTable } from '../../../src/webview/tables';
import { mountContextMenu } from '../../../src/webview/contextmenu';
import { planEdit } from '../../../src/textSync';

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
const same = (got: string, want: string): Result => ({ ok: got === want, detail: got === want ? '' : `got ${j(got)}, want ${j(want)}` });
const all = (checks: Record<string, boolean>, detail: unknown): Result => {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: failed.length === 0, detail: failed.length ? `failed: ${failed.join(', ')}; ${typeof detail === 'string' ? detail : j(detail)}` : '' };
};

/** The table in a document with a paragraph above and below it. */
const inDoc = (table: string): string => `Intro.\n\n${table}\n\nAfter.\n`;

/**
 * What Copy ref should give for a single row on line `n` of `doc`: the location, then
 * that line quoted in a fence. Built from the document the scenario ends with rather
 * than written out, so a scenario asserts both that the right line is named and that
 * what is quoted is really on it. None of the rows these are used on holds a backtick,
 * so a three-backtick fence is the right one; the longer fence has its own scenario.
 */
const rowRef = (doc: string, n: number, label: string): string =>
  `doc.md:${n} (${label})\n\n\`\`\`\n${doc.split('\n')[n - 1]}\n\`\`\`\n`;

/**
 * What Copy ref should give for one cell whose row is on line `n` of `doc`: the
 * location with the cell's column and row, then the cell's text in a fence, or the
 * location alone for an empty cell. The line is checked to hold that text, so a
 * scenario still asserts that the right line is named.
 */
const cellRef = (doc: string, n: number, label: string, text: string): string => {
  const line = doc.split('\n')[n - 1] ?? '';
  if (!line.split('|').some((c) => c.trim() === text)) return `line ${n} does not hold ${JSON.stringify(text)}: ${line}`;
  return text === '' ? `doc.md:${n} (${label})\n` : `doc.md:${n} (${label})\n\n\`\`\`\n${text}\n\`\`\`\n`;
};

const RAGGED = '| Fruit | Qty |\n|---|:-:|\n| apple | 3 |\n| kiwi fruit |12|';
const T4 = '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |';
const SKELETON = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';

interface H {
  view: EditorView;
  copied: string[];
  doc: () => string;
  wraps: () => HTMLElement[];
  cell: (r: number, c: number, t?: number) => HTMLElement;
  grid: (t?: number) => HTMLElement;
  gutter: (r: number, t?: number) => HTMLElement;
  down: (el: Element, opts?: any) => void;
  key: (el: Element, key: string, opts?: any) => void;
  labels: (r: number, c: number, t?: number) => string[];
  act: (r: number, c: number, label: string, t?: number) => boolean;
  rightClick: (el: Element) => void;
  menu: (el: Element, label: string) => boolean;
  ref: (el: Element) => string | undefined;
  edit: (r: number, c: number, value: string, t?: number) => void;
  remote: (from: number, to: number, insert: string) => void;
  /**
   * Something else writes the whole file from the text it read when the document
   * was opened, with one change made at `from`..`to` of that original text. This is
   * how an agent or another editor actually writes: it has its own copy, not a
   * patch against whatever Sheaf is holding now. `remote` applies a positional patch
   * to the current text, which models a different and rarer thing.
   */
  outside: (from: number, to: number, insert: string) => void;
  marked: (t?: number) => string[];
  commit: () => Promise<string>;
  destroy: () => void;
}

function mount(doc: string, anchor = 0): H {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor }, extensions: [editorExtensions(() => {})] }),
    parent,
  });
  const copied: string[] = [];
  mountContextMenu(view.dom, { getView: () => view, getFileName: () => 'doc.md', copyToClipboard: (t) => copied.push(t), readClipboard: async () => '' });
  const wraps = (): HTMLElement[] => Array.from(view.dom.querySelectorAll<HTMLElement>('.sheaf-table'));
  const need = <T,>(el: T | null | undefined, what: string): T => {
    if (!el) throw new Error(`no ${what}`);
    return el;
  };
  const cell = (r: number, c: number, t = 0): HTMLElement => need(wraps()[t]?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`), `cell ${r},${c} in table ${t}`);
  const grid = (t = 0): HTMLElement => need(wraps()[t]?.querySelector<HTMLElement>('.sheaf-table-grid'), `grid ${t}`);
  const gutter = (r: number, t = 0): HTMLElement => need(wraps()[t]?.querySelectorAll<HTMLElement>('tbody .sheaf-table-gutter')[r], `gutter ${r}`);
  const down = (el: Element, opts: any = {}): void => {
    el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...opts }));
    if (!opts.keepDown) document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  };
  const key = (el: Element, k: string, opts: any = {}): void => {
    el.dispatchEvent(new G.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  };
  const labels = (r: number, c: number, t = 0): string[] => (tableActionsAt(cell(r, c, t)) ?? []).map((a) => a.label);
  const act = (r: number, c: number, label: string, t = 0): boolean => {
    const action = tableActionsAt(cell(r, c, t))?.find((a) => a.label === label);
    action?.run();
    return !!action;
  };
  const rightClick = (el: Element): void => {
    el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
    document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 2 }));
    el.dispatchEvent(new G.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));
  };
  const item = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>('.sheaf-ctx-menu'))
      .filter((m) => !m.hidden)
      .flatMap((m) => Array.from(m.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-item')))
      .find((b) => b.querySelector('span')?.textContent === label);
  const menu = (el: Element, label: string): boolean => {
    rightClick(el);
    const b = item(label);
    b?.click();
    return !!b;
  };
  const ref = (el: Element): string | undefined => {
    const before = copied.length;
    menu(el, 'Copy ref');
    return copied.length > before ? copied[copied.length - 1] : undefined;
  };
  /**
   * Open a cell by double-click, replace its text and leave it with Tab.
   *
   * A Markdown cell edits in a nested editor of its own rather than in an input, so
   * this reaches whichever the cell opened: a plain field for a CSV or TSV block, a
   * nested editor otherwise. Looking only for an input made every scenario that
   * types into a pipe table throw before it reached anything it was checking.
   */
  const edit = (r: number, c: number, value: string, t = 0): void => {
    const el = cell(r, c, t);
    el.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const host = need(cell(r, c, t).querySelector<HTMLElement>('input, textarea, .sheaf-table-input'), `editor in ${r},${c}`);
    if (host instanceof G.HTMLInputElement || host instanceof G.HTMLTextAreaElement) {
      (host as HTMLInputElement).value = value;
      key(host, 'Tab');
      return;
    }
    const cm = need(EditorView.findFromDOM(host), `a cell editor in ${r},${c}`);
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: value }, selection: { anchor: value.length }, userEvent: 'input.type' });
    key(cm.contentDOM, 'Tab');
  };
  const remote = (from: number, to: number, insert: string): void =>
    view.dispatch({ changes: { from, to, insert }, annotations: Transaction.remote.of(true) });
  const outside = (from: number, to: number, insert: string): void => {
    const written = doc.slice(0, from) + insert + doc.slice(to);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: written }, annotations: Transaction.remote.of(true) });
  };
  const marked = (t = 0): string[] =>
    Array.from(wraps()[t]?.querySelectorAll('tr.is-changed') ?? []).map((tr) =>
      Array.from(tr.querySelectorAll('[data-r]'), (c) => c.textContent ?? '').join('')
    );
  const commit = async (): Promise<string> => {
    const ae = document.activeElement as HTMLElement | null;
    ae?.blur?.();
    for (const w of wraps()) w.dispatchEvent(new G.Event('focusout', { bubbles: true }));
    await tick();
    await tick();
    return view.state.doc.toString();
  };
  return {
    view,
    copied,
    doc: () => view.state.doc.toString(),
    wraps,
    cell,
    grid,
    gutter,
    down,
    key,
    labels,
    act,
    rightClick,
    menu,
    ref,
    edit,
    remote,
    outside,
    marked,
    commit,
    destroy: () => {
      view.destroy();
      parent.remove();
      document.querySelectorAll('.sheaf-ctx-menu').forEach((m) => m.remove());
    },
  };
}

/** Mount, run `fn`, and always tear down. */
async function withDoc(doc: string, fn: (h: H) => Result | Promise<Result>, anchor = 0): Promise<Result> {
  const h = mount(doc, anchor);
  try {
    return await fn(h);
  } finally {
    h.destroy();
  }
}

/** Mount, run one table action, leave the table and compare the whole file. */
const actDoc = (doc: string, r: number, c: number, label: string, want: string): Promise<Result> =>
  withDoc(doc, async (h) => {
    const ran = h.act(r, c, label);
    const got = await h.commit();
    return ran ? same(got, want) : { ok: false, detail: `no "${label}" in ${j(h.labels(r, c))}` };
  });

/** Cells as GFM reads a row: one leading and one trailing pipe are optional. */
function gfmCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Names of syntax nodes covering `pos`, innermost first, after a full parse. */
function nodesAt(view: EditorView, pos: number): string[] {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  const out: string[] = [];
  for (let n: any = tree?.resolveInner(pos, 1); n; n = n.parent) out.push(n.name);
  return out;
}

/** The body lines of the first pipe table in `doc`. */
function bodyLines(doc: string): string[] {
  const lines = doc.split('\n');
  const head = lines.findIndex((l) => l.includes('|'));
  const out: string[] = [];
  for (let i = head + 2; i < lines.length && lines[i].trim() !== ''; i++) out.push(lines[i]);
  return out;
}

/** The first cell of each body row, the order a sort produced. */
const order = (doc: string): string => bodyLines(doc).map((l) => gfmCells(l)[0]).join(',');

/** A key/value table with keys a, b, c... and the given values. */
const kv = (vals: string[]): string => '| k | v |\n| - | - |\n' + vals.map((v, i) => `| ${String.fromCharCode(97 + i)} | ${v} |`).join('\n');

/** Sort column v of `vals` and report the key order. */
const sortOrder = (vals: string[], label: string, want: string): Promise<Result> =>
  withDoc(inDoc(kv(vals)), async (h) => {
    const ran = h.act(0, 1, label);
    const got = await h.commit();
    const lines = got.split('\n');
    const original = inDoc(kv(vals)).split('\n');
    const permutation = [...lines].sort().join('\n') === [...original].sort().join('\n');
    return all({ ran, order: order(got) === want, permutation }, `order ${order(got)}, want ${want}; ${j(got)}`);
  });

// Display width for checking padding the way a monospace editor lays it out:
// one per grapheme, two for East Asian wide characters and emoji.
const WIDE = /\p{Emoji_Presentation}|️|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
function graphemes(s: string): string[] {
  const Seg = (Intl as any).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), (x: any) => x.segment) : Array.from(s);
}
/** Display columns at which each unescaped pipe of a line sits. */
function pipeColumns(line: string): number[] {
  const gs = graphemes(line);
  const out: number[] = [];
  let col = 0;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i] === '\\' && i + 1 < gs.length) {
      col += 1 + (WIDE.test(gs[i + 1]) ? 2 : 1);
      i++;
      continue;
    }
    if (gs[i] === '|') out.push(col);
    col += WIDE.test(gs[i]) ? 2 : 1;
  }
  return out;
}
/** True when every line's pipes sit at the same display columns. */
const linedUp = (lines: string[]): boolean => lines.every((l) => j(pipeColumns(l)) === j(pipeColumns(lines[0])));

/** Pad `table` in a document and check it lines up, keeps its cells and leaves the rest of the file alone. */
const padCheck = (table: string, extra: (lines: string[], h: H) => Record<string, boolean> = () => ({}), at: [number, number] = [0, 0]): Promise<Result> =>
  withDoc(inDoc(table), async (h) => {
    const ran = h.act(at[0], at[1], 'Pad columns to line up');
    const got = await h.commit();
    const lines = got.split('\n');
    const tableLines = lines.slice(2, lines.length - 3);
    // A row padded out to the header's width gains blank cells; compare without trailing blanks.
    const trimCells = (l: string): string => {
      const c = gfmCells(l);
      while (c.length && c[c.length - 1] === '') c.pop();
      return c.join(' ');
    };
    const cellsBefore = table.split('\n').filter((_, i) => i !== 1).map(trimCells);
    const cellsAfter = tableLines.filter((_, i) => i !== 1).map(trimCells);
    return all(
      {
        ran,
        linedUp: linedUp(tableLines),
        cellsKept: j(cellsBefore) === j(cellsAfter),
        around: got.startsWith('Intro.\n\n') && got.endsWith('\n\nAfter.\n'),
        ...extra(tableLines, h),
      },
      got
    );
  });

const pasteInto = (h: H, text: string): void => {
  const store: Record<string, string> = { 'text/plain': text };
  const e = new G.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => store[t] ?? '', setData: () => {}, types: ['text/plain'], files: [], items: [] } });
  h.view.contentDOM.dispatchEvent(e);
};

const T8 = '| k | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |\n| e | 5 |\n| f | 6 |\n| g | 7 |\n| h | 8 |';
const LIST = 'Intro.\n\n- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n  | 3 | 4 |\n\nAfter.\n';

export const scenarios: Scenario[] = [
  // ---- tables.rows-columns ------------------------------------------------
  {
    id: 'tables.rows-columns.u01',
    feature: 'tables.rows-columns',
    name: 'Insert row above on the first body row adds one line under the delimiter and nothing else',
    run: () => actDoc(inDoc(RAGGED), 0, 0, 'Insert row above', inDoc(RAGGED.replace('|---|:-:|\n', '|---|:-:|\n|       |     |\n'))),
  },
  {
    id: 'tables.rows-columns.u02',
    feature: 'tables.rows-columns',
    name: 'Insert row below on the last row of a table that ends the file adds one line at the end',
    run: () => actDoc('Intro.\n\n' + RAGGED, 1, 0, 'Insert row below', 'Intro.\n\n' + RAGGED + '\n|       |     |'),
  },
  {
    id: 'tables.rows-columns.u03',
    feature: 'tables.rows-columns',
    name: 'Insert row below from a header cell puts the new row first',
    run: () => actDoc(inDoc(RAGGED), -1, 0, 'Insert row below', inDoc(RAGGED.replace('|---|:-:|\n', '|---|:-:|\n|       |     |\n'))),
  },
  {
    id: 'tables.rows-columns.u04',
    feature: 'tables.rows-columns',
    name: 'Deleting the only body row leaves a header-only table that still shows as a grid',
    run: () =>
      withDoc(inDoc('| a | b |\n| - | - |\n| 1 | 2 |'), async (h) => {
        const ran = h.act(0, 0, 'Delete row');
        const got = await h.commit();
        return all({ ran, file: got === inDoc('| a | b |\n| - | - |'), grid: h.wraps().length === 1 }, got);
      }),
  },
  {
    id: 'tables.rows-columns.u05',
    feature: 'tables.rows-columns',
    name: 'A one-column table offers no Delete column, and the header offers no row delete, duplicate or move',
    run: () =>
      withDoc(inDoc('| a |\n| - |\n| 1 |\n| 2 |'), (h) => {
        const body = h.labels(0, 0);
        const header = h.labels(-1, 0);
        return all(
          {
            bodyNoDeleteColumn: !body.includes('Delete column'),
            bodyHasDeleteRow: body.includes('Delete row'),
            headerNoRowActions: !header.some((l) => /^(Delete|Duplicate|Move) row/.test(l)),
          },
          { body, header }
        );
      }),
  },
  {
    id: 'tables.rows-columns.u06',
    feature: 'tables.rows-columns',
    name: 'Deleting a column of a two-column table without outer pipes leaves a table that still reads as a table',
    run: () =>
      withDoc(inDoc('a | b\n--|--\n1 | 2'), async (h) => {
        const ran = h.act(0, 1, 'Delete column');
        const got = await h.commit();
        const lines = got.split('\n').slice(2, 5);
        return all(
          {
            ran,
            everyLineHasAPipe: lines.every((l) => l.includes('|')),
            parsesAsTable: nodesAt(h.view, got.indexOf('a')).includes('Table'),
            stillAGrid: h.wraps().length === 1,
          },
          got
        );
      }),
  },
  {
    id: 'tables.rows-columns.u07',
    feature: 'tables.rows-columns',
    name: 'Insert column right of the last column only appends to each line',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        const ran = h.act(0, 1, 'Insert column right');
        const got = await h.commit();
        const before = RAGGED.split('\n');
        const after = got.split('\n').slice(2, 6);
        return all(
          {
            ran,
            prefixes: after.every((l, i) => l.startsWith(before[i]) && l.length > before[i].length),
            threeCells: after.every((l) => gfmCells(l).length === 3),
            around: got.startsWith('Intro.\n\n') && got.endsWith('\n\nAfter.\n'),
          },
          got
        );
      }),
  },
  {
    id: 'tables.rows-columns.u08',
    feature: 'tables.rows-columns',
    name: 'Duplicate row on a row with an escaped pipe and CJK text writes an exact copy below it',
    run: () => {
      const T = '| k | v |\n| - | - |\n| 東京 \\| 大阪 |  x  |\n| b | 2 |';
      return actDoc(inDoc(T), 0, 0, 'Duplicate row', inDoc(T.replace('|  x  |\n', '|  x  |\n| 東京 \\| 大阪 |  x  |\n')));
    },
  },
  {
    id: 'tables.rows-columns.u09',
    feature: 'tables.rows-columns',
    name: 'Duplicate columns on a two-column selection copies both columns byte for byte beside it',
    run: () =>
      withDoc(inDoc('| x | y | z |\n|:-|-:|---|\n| 1 |2| 3 |'), async (h) => {
        h.down(h.cell(-1, 0));
        h.key(h.grid(), 'ArrowRight', { shiftKey: true });
        const ran = h.act(0, 0, 'Duplicate columns');
        const got = await h.commit();
        return ran ? same(got, inDoc('| x | y | x | y | z |\n|:-|-:|:-|-:|---|\n| 1 |2| 1 |2| 3 |')) : { ok: false, detail: j(h.labels(0, 0)) };
      }),
  },
  {
    id: 'tables.rows-columns.u10',
    feature: 'tables.rows-columns',
    name: 'Insert row, leave the table, then one Undo gives the file back byte for byte',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 0, 'Insert row below');
        const written = await h.commit();
        undo(h.view);
        return all({ written: written !== inDoc(RAGGED), undone: h.doc() === inDoc(RAGGED) }, h.doc());
      }),
  },
  {
    id: 'tables.rows-columns.u11',
    feature: 'tables.rows-columns',
    name: 'In a CRLF file, inserting a row sends one new line to the host and keeps CRLF everywhere',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 0, 'Insert row below');
        const got = await h.commit();
        const crlf = inDoc(RAGGED).replace(/\n/g, '\r\n');
        const plan = planEdit(crlf, got, true);
        return all(
          {
            plan: !!plan,
            allCrlf: !!plan && !/[^\r]\n/.test(plan.text),
            // The host trims a common prefix and suffix, so the edit may start mid-line; it must still be one line long.
            oneLine: !!plan && plan.start === plan.end && plan.replacement.length === '|       |     |\r\n'.length,
            text: !!plan && plan.text === got.replace(/\n/g, '\r\n'),
          },
          plan
        );
      }),
  },
  {
    id: 'tables.rows-columns.u12',
    feature: 'tables.rows-columns',
    name: 'Insert row below in a table inside a list item keeps the list indentation on the new line',
    run: () => actDoc(LIST, 0, 0, 'Insert row below', LIST.replace('  | 1 | 2 |\n', '  | 1 | 2 |\n  |   |   |\n')),
  },
  {
    id: 'tables.rows-columns.u13',
    feature: 'tables.rows-columns',
    name: 'Insert row below in a table without outer pipes inside a list item keeps the indentation',
    run: () =>
      withDoc('Intro.\n\n- item\n\n  a | b\n  --|--\n  1 | 2\n\nAfter.\n', async (h) => {
        const ran = h.act(0, 0, 'Insert row below');
        const got = await h.commit();
        const added = got.split('\n')[7] ?? '';
        return all({ ran, indented: added.startsWith('  ') && added.includes('|'), rest: got.endsWith('\n\nAfter.\n') }, got);
      }),
  },

  {
    id: 'tables.rows-columns.u14',
    feature: 'tables.rows-columns',
    name: 'Insert row below on a body row adds one line under it and nothing else',
    run: () => actDoc(inDoc(RAGGED), 0, 0, 'Insert row below', inDoc(RAGGED.replace('| apple | 3 |\n', '| apple | 3 |\n|       |     |\n'))),
  },
  {
    id: 'tables.rows-columns.u15',
    feature: 'tables.rows-columns',
    name: 'Delete column on the first header cell removes only that column segment from every line',
    run: () => actDoc(inDoc(RAGGED), -1, 0, 'Delete column', inDoc('| Qty |\n|:-:|\n| 3 |\n|12|')),
  },
  {
    id: 'tables.rows-columns.u16',
    feature: 'tables.rows-columns',
    name: 'Duplicate rows on a two-row gutter selection copies both lines exactly below them',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.down(h.gutter(1));
        h.down(h.gutter(2), { shiftKey: true });
        const ran = h.act(2, 0, 'Duplicate rows');
        const got = await h.commit();
        return ran ? same(got, inDoc(T4.replace('| c | 3 |\n', '| c | 3 |\n| b | 2 |\n| c | 3 |\n'))) : { ok: false, detail: j(h.labels(2, 0)) };
      }),
  },

  // ---- tables.move ----------------------------------------------------------
  {
    id: 'tables.move.u01',
    feature: 'tables.move',
    name: 'Moves past an edge are not offered: first row up, header, last row down, first column left, last column right',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const first = h.labels(0, 0);
        const header = h.labels(-1, 1);
        const last = h.labels(3, 1);
        return all(
          {
            firstNoUp: !first.includes('Move row up') && first.includes('Move row down'),
            headerNoRowMove: !header.some((l) => l.startsWith('Move row')),
            lastNoDown: !last.includes('Move row down') && last.includes('Move row up'),
            firstColNoLeft: !first.includes('Move column left') && first.includes('Move column right'),
            lastColNoRight: !last.includes('Move column right') && last.includes('Move column left'),
          },
          { first, header, last }
        );
      }),
  },
  {
    id: 'tables.move.u02',
    feature: 'tables.move',
    name: 'Move row down on a row with an escaped pipe and odd padding swaps the two lines and nothing else',
    run: () => {
      const T = '| k | v |\n| - | - |\n| a \\| b |   1 |\n|c|2|\n| d | 3 |';
      return actDoc(inDoc(T), 0, 0, 'Move row down', inDoc('| k | v |\n| - | - |\n|c|2|\n| a \\| b |   1 |\n| d | 3 |'));
    },
  },
  {
    id: 'tables.move.u03',
    feature: 'tables.move',
    name: 'Move column right carries its alignment colons and each cell segment with it',
    run: () => actDoc(inDoc('| L | C | R |\n|:--|:-:|--:|\n| a \\| x |  b|c |'), 0, 0, 'Move column right', inDoc('| C | L | R |\n|:-:|:--|--:|\n|  b| a \\| x |c |')),
  },
  {
    id: 'tables.move.u04',
    feature: 'tables.move',
    name: 'Moving a column keeps text a row has past the last header column',
    run: () =>
      withDoc(inDoc('| a | b |\n| - | - |\n| 1 | 2 | extra |'), async (h) => {
        const ran = h.act(0, 0, 'Move column right');
        const got = await h.commit();
        return all({ ran, moved: got.includes('| b | a |'), extraKept: got.includes('extra') }, got);
      }),
  },
  {
    id: 'tables.move.u05',
    feature: 'tables.move',
    name: 'Moving a column in a row shorter than the header moves the cell the row has',
    run: () => actDoc(inDoc('| a | b | c |\n| - | - | - |\n| 1 |'), -1, 0, 'Move column right', inDoc('| b | a | c |\n| - | - | - |\n|   | 1 |   |')),
  },
  {
    id: 'tables.move.u06',
    feature: 'tables.move',
    name: 'Alt+Down on the last row and Alt+Right on the last column leave the file as it was',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.down(h.cell(3, 1));
        h.key(h.grid(), 'ArrowDown', { altKey: true });
        h.key(h.grid(), 'ArrowRight', { altKey: true });
        return same(await h.commit(), inDoc(T4));
      }),
  },
  {
    id: 'tables.move.u07',
    feature: 'tables.move',
    name: 'Dragging row number 2 up past row 1 onto the header puts the row first and leaves the header alone',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        // A drag on a row number that is not selected marks rows; one already selected moves.
        h.down(h.gutter(1), { clientY: 60 });
        h.down(h.gutter(1), { clientY: 60, keepDown: true });
        h.cell(0, 0).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 30 }));
        h.cell(-1, 0).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 5 }));
        document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 5 }));
        return same(await h.commit(), inDoc('| n | v |\n| - | - |\n| b | 2 |\n| a | 1 |\n| c | 3 |\n| d | 4 |'));
      }),
  },
  {
    id: 'tables.move.u08',
    feature: 'tables.move',
    name: 'Dragging the second column header past the first onto the row-number gutter puts the column first',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        // A drag on a header that is not selected marks columns; one already selected moves.
        h.down(h.cell(-1, 1), { clientX: 80 });
        h.down(h.cell(-1, 1), { clientX: 80, keepDown: true });
        h.cell(-1, 0).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 40 }));
        h.gutter(0).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 2 }));
        document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 2 }));
        return same(await h.commit(), inDoc('| v | n |\n| - | - |\n| 1 | a |\n| 2 | b |\n| 3 | c |\n| 4 | d |'));
      }),
  },
  {
    id: 'tables.move.u09',
    feature: 'tables.move',
    name: 'Move row down then Cmd+Z in the grid writes nothing when leaving',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.act(1, 0, 'Move row down');
        h.key(h.grid(), 'z', { metaKey: true });
        return same(await h.commit(), inDoc(T4));
      }),
  },
  {
    id: 'tables.move.u10',
    feature: 'tables.move',
    name: 'Move column left, leave, then one document Undo restores the file byte for byte',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 1, 'Move column left');
        const written = await h.commit();
        undo(h.view);
        return all({ moved: written.includes('| Qty | Fruit |'), undone: h.doc() === inDoc(RAGGED) }, { written, after: h.doc() });
      }),
  },
  {
    id: 'tables.move.u11',
    feature: 'tables.move',
    name: 'Moving a row in a table inside a list item swaps the indented lines whole',
    run: () => actDoc(LIST, 1, 0, 'Move row up', LIST.replace('  | 1 | 2 |\n  | 3 | 4 |', '  | 3 | 4 |\n  | 1 | 2 |')),
  },
  {
    id: 'tables.move.u12',
    feature: 'tables.move',
    name: 'A two-row selection that includes the first row offers Move rows down but not up',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.down(h.gutter(0));
        h.down(h.gutter(1), { shiftKey: true });
        const l = h.labels(1, 0);
        return all({ down: l.includes('Move rows down'), noUp: !l.includes('Move rows up') && !l.includes('Move row up') }, l);
      }),
  },
  {
    id: 'tables.move.u13',
    feature: 'tables.move',
    name: 'In a CRLF file, Move row down sends the host an edit made only of the two swapped lines',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.act(0, 0, 'Move row down');
        const got = await h.commit();
        const plan = planEdit(inDoc(T4).replace(/\n/g, '\r\n'), got, true);
        const lines = plan ? plan.replacement.split('\r\n').filter(Boolean) : [];
        return all({ plan: !!plan, onlySwapped: lines.every((l) => ['| a | 1 |', '| b | 2 |'].some((x) => x.includes(l))), allCrlf: !!plan && !/[^\r]\n/.test(plan.text) }, plan);
      }),
  },

  {
    id: 'tables.move.u14',
    feature: 'tables.move',
    name: 'Dragging row number 1 down onto row 3 puts the row after c and writes only the reordering',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        // Select the row first: only a selected row number drags its row.
        h.down(h.gutter(0), { clientY: 10 });
        h.down(h.gutter(0), { clientY: 10, keepDown: true });
        h.cell(1, 1).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 40 }));
        h.cell(2, 1).dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 70 }));
        document.dispatchEvent(new G.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientY: 70 }));
        return same(await h.commit(), inDoc('| n | v |\n| - | - |\n| b | 2 |\n| c | 3 |\n| a | 1 |\n| d | 4 |'));
      }),
  },

  // ---- tables.sort ----------------------------------------------------------
  {
    id: 'tables.sort.u01',
    feature: 'tables.sort',
    name: 'Sort A to Z puts numbers first by value, then words ignoring letter case',
    run: () => sortOrder(['banana', '10', 'Apple', '9', 'cherry'], 'Sort column A to Z', 'd,b,c,a,e'),
  },
  {
    id: 'tables.sort.u02',
    feature: 'tables.sort',
    name: 'Rows with equal values keep their original order in both directions',
    run: async () => {
      const up = await sortOrder(['2', '1', '2', '1'], 'Sort column A to Z', 'b,d,a,c');
      const downR = await sortOrder(['2', '1', '2', '1'], 'Sort column Z to A', 'a,c,b,d');
      const ok = (r: Result): boolean => r === true || (typeof r === 'object' && r.ok);
      return { ok: ok(up) && ok(downR), detail: j({ up, down: downR }) };
    },
  },
  {
    id: 'tables.sort.u03',
    feature: 'tables.sort',
    name: 'Blank cells, whitespace-only cells and a row missing the cell stay at the bottom in both directions',
    run: async () => {
      const T = '| k | v |\n| - | - |\n| a | 5 |\n| b |   |\n| c |\n| d | 1 |';
      const run = (label: string) =>
        withDoc(inDoc(T), async (h) => {
          h.act(0, 1, label);
          const got = await h.commit();
          return { ok: true, detail: `${order(got)}|${bodyLines(got).includes('| c |')}` };
        });
      const up = (await run('Sort column A to Z')) as any;
      const dn = (await run('Sort column Z to A')) as any;
      return { ok: up.detail === 'd,a,b,c|true' && dn.detail === 'a,d,b,c|true', detail: `A-Z ${up.detail}, Z-A ${dn.detail}` };
    },
  },
  {
    id: 'tables.sort.u04',
    feature: 'tables.sort',
    name: 'ISO dates sort in date order',
    run: () => sortOrder(['2024-01-10', '2023-12-31', '2024-01-05'], 'Sort column A to Z', 'b,c,a'),
  },
  {
    id: 'tables.sort.u05',
    feature: 'tables.sort',
    name: 'Month/day/year dates sort in date order',
    run: () => sortOrder(['12/31/2023', '1/5/2024', '2/1/2023'], 'Sort column A to Z', 'c,a,b'),
  },
  {
    id: 'tables.sort.u06',
    feature: 'tables.sort',
    name: 'Percentages sort by value',
    run: () => sortOrder(['40%', '5%', '100%'], 'Sort column A to Z', 'b,a,c'),
  },
  {
    id: 'tables.sort.u07',
    feature: 'tables.sort',
    name: 'A decimal written without a leading zero sorts by value among other decimals',
    run: () => sortOrder(['0.75', '.5', '0.25'], 'Sort column A to Z', 'c,b,a'),
  },
  {
    id: 'tables.sort.u08',
    feature: 'tables.sort',
    name: 'Sorting a ragged table writes only a reordering of its row lines',
    run: () =>
      withDoc(inDoc('| Name | Score |\n|:--|--:|\n| zed |  3 |\n|amy|12|\n| Bo   | 7   |'), async (h) => {
        const ran = h.act(0, 1, 'Sort column Z to A');
        const got = await h.commit();
        return all({ ran }, '') && same(got, inDoc('| Name | Score |\n|:--|--:|\n|amy|12|\n| Bo   | 7   |\n| zed |  3 |'));
      }),
  },
  {
    id: 'tables.sort.u09',
    feature: 'tables.sort',
    name: 'Sort is not offered on a table with one body row',
    run: () => withDoc(inDoc('| a | b |\n| - | - |\n| 1 | 2 |'), (h) => ({ ok: !h.labels(0, 0).some((l) => l.startsWith('Sort')), detail: j(h.labels(0, 0)) })),
  },
  {
    id: 'tables.sort.u10',
    feature: 'tables.sort',
    name: 'Sort, leave, then one document Undo restores the file byte for byte',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.act(0, 1, 'Sort column Z to A');
        const written = await h.commit();
        undo(h.view);
        return all({ sorted: order(written) === 'd,c,b,a', undone: h.doc() === inDoc(T4) }, { written, after: h.doc() });
      }),
  },
  {
    id: 'tables.sort.u11',
    feature: 'tables.sort',
    name: 'Cells with bold or code sort by the text a person reads',
    run: () => sortOrder(['**b**', 'a', '`c`'], 'Sort column A to Z', 'b,a,c'),
  },
  {
    id: 'tables.sort.u12',
    feature: 'tables.sort',
    name: 'Sorting a table inside a list item keeps every row indented',
    run: () => actDoc(LIST, 0, 0, 'Sort column Z to A', LIST.replace('  | 1 | 2 |\n  | 3 | 4 |', '  | 3 | 4 |\n  | 1 | 2 |')),
  },

  // ---- tables.align ---------------------------------------------------------
  {
    id: 'tables.align.u01',
    feature: 'tables.align',
    name: 'Align center on a one-dash delimiter cell writes a valid center delimiter and nothing else',
    run: () => actDoc(inDoc('| a | b |\n|-|-|\n| 1 | 2 |'), 0, 0, 'Align column center', inDoc('| a | b |\n|:-:|-|\n| 1 | 2 |')),
  },
  {
    id: 'tables.align.u02',
    feature: 'tables.align',
    name: 'Align a column, then edit a cell in another row: only the delimiter and the edited row change',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 1, 'Align column right');
        h.edit(1, 0, 'kiwi');
        return same(await h.commit(), inDoc('| Fruit | Qty |\n|---|--:|\n| apple | 3 |\n| kiwi       |12|'));
      }),
  },
  {
    id: 'tables.align.u03',
    feature: 'tables.align',
    name: 'Align then Clear column alignment in the same visit leaves the file as written',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        const a = h.act(0, 0, 'Align column left');
        const b = h.act(0, 0, 'Clear column alignment');
        const got = await h.commit();
        return all({ a, b, same: got === inDoc(RAGGED) }, got);
      }),
  },
  {
    id: 'tables.align.u04',
    feature: 'tables.align',
    name: 'Clear column alignment is offered only on a column that has an alignment',
    run: () => withDoc(inDoc(RAGGED), (h) => ({ ok: !h.labels(0, 0).includes('Clear column alignment') && h.labels(0, 1).includes('Clear column alignment'), detail: j([h.labels(0, 0), h.labels(0, 1)]) })),
  },
  {
    id: 'tables.align.u05',
    feature: 'tables.align',
    name: 'Choosing the alignment a column already has changes nothing and adds no undo step',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 1, 'Align column center');
        const got = await h.commit();
        return all({ same: got === inDoc(RAGGED), noUndo: undoDepth(h.view.state) === 0 }, got);
      }),
  },
  {
    id: 'tables.align.u06',
    feature: 'tables.align',
    name: 'Align right in a table without outer pipes changes only that delimiter cell',
    run: () => actDoc(inDoc('a | b\n--|--\n1 | 2'), 0, 1, 'Align column right', inDoc('a | b\n--|-:\n1 | 2')),
  },
  {
    id: 'tables.align.u07',
    feature: 'tables.align',
    name: 'Align in a table inside a list item keeps the delimiter row indented',
    run: () => actDoc(LIST, 0, 0, 'Align column center', LIST.replace('  | - | - |', '  | :-: | - |')),
  },
  {
    id: 'tables.align.u08',
    feature: 'tables.align',
    name: 'Align, leave, then one document Undo restores the file byte for byte',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 0, 'Align column right');
        const written = await h.commit();
        undo(h.view);
        return all({ written: written.includes('|--:|:-:|'), undone: h.doc() === inDoc(RAGGED) }, { written, after: h.doc() });
      }),
  },
  {
    id: 'tables.align.u09',
    feature: 'tables.align',
    name: 'Aligning a column inserted in the same visit writes that alignment in its new delimiter cell',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 1, 'Insert column right');
        const ran = h.act(0, 2, 'Align column right');
        const got = await h.commit();
        return ran ? same(got, inDoc('| Fruit | Qty |     |\n|---|:-:| --: |\n| apple | 3 |     |\n| kiwi fruit |12|     |')) : { ok: false, detail: j(h.labels(0, 2)) };
      }),
  },
  {
    id: 'tables.align.u10',
    feature: 'tables.align',
    name: 'The grid shows the new alignment on the header and body cells right away',
    run: () =>
      withDoc(inDoc(RAGGED), (h) => {
        h.act(0, 0, 'Align column right');
        return { ok: h.cell(-1, 0).style.textAlign === 'right' && h.cell(1, 0).style.textAlign === 'right', detail: `${h.cell(-1, 0).style.textAlign}/${h.cell(1, 0).style.textAlign}` };
      }),
  },

  {
    id: 'tables.align.u11',
    feature: 'tables.align',
    name: 'Clear column alignment on a centered column changes only its delimiter cell',
    run: () => actDoc(inDoc(RAGGED), 1, 1, 'Clear column alignment', inDoc(RAGGED.replace('|---|:-:|', '|---|---|'))),
  },

  // ---- tables.pad -----------------------------------------------------------
  {
    id: 'tables.pad.u01',
    feature: 'tables.pad',
    name: 'Pad columns lines up a table holding CJK, a pictograph emoji and an escaped pipe, keeping alignment',
    run: () => padCheck('| name | icon |\n|-|:-:|\n| 東京 | 🍎 |\n| a \\| b | x |', (lines) => ({ center: /^\|\s*-+\s*\|\s*:-+:\s*\|$/.test(lines[1]) })),
  },
  {
    id: 'tables.pad.u02',
    feature: 'tables.pad',
    name: 'Pad columns counts ✅ and ⭐, which are emoji, as two columns wide',
    run: () => padCheck('| s | n |\n|-|-|\n| ✅ | 1 |\n| ⭐ | 2 |\n| ok | 3 |'),
  },
  {
    id: 'tables.pad.u03',
    feature: 'tables.pad',
    name: 'Pad columns lines up a cell whose accent is a combining mark',
    run: () => padCheck('| word | n |\n|-|-|\n| café | 1 |\n| cafes | 2 |'),
  },
  {
    id: 'tables.pad.u04',
    feature: 'tables.pad',
    name: 'Pad columns on a table without outer pipes lines it up and keeps it a table',
    run: () => padCheck('a | bb\n--|--\nccc | d', (_l, h) => ({ table: nodesAt(h.view, 'Intro.\n\n'.length + 2).includes('Table') })),
  },
  {
    id: 'tables.pad.u05',
    feature: 'tables.pad',
    name: 'Pad columns on an already padded table changes nothing and adds no undo step',
    run: () => {
      const PADDED = '| Fruit      | Qty |\n| ---------- | :-: |\n| apple      | 3   |\n| kiwi fruit | 12  |';
      return withDoc(inDoc(PADDED), async (h) => {
        const ran = h.act(0, 0, 'Pad columns to line up');
        const got = await h.commit();
        return all({ ran, same: got === inDoc(PADDED), noUndo: undoDepth(h.view.state) === 0 }, got);
      });
    },
  },
  {
    id: 'tables.pad.u06',
    feature: 'tables.pad',
    name: 'Pad columns on a table inside a list item keeps it inside the item',
    run: () =>
      withDoc('Intro.\n\n- item\n\n  | a | bbbb |\n  |-|-|\n  | ccc | d |\n\nAfter.\n', async (h) => {
        const ran = h.act(0, 0, 'Pad columns to line up');
        const got = await h.commit();
        const lines = got.split('\n').slice(4, 7);
        return all({ ran, indented: lines.every((l) => l.startsWith('  |')), linedUp: linedUp(lines), inItem: nodesAt(h.view, got.indexOf('ccc')).includes('ListItem') }, got);
      }),
  },
  {
    id: 'tables.pad.u07',
    feature: 'tables.pad',
    name: 'Pad columns does not turn text past the last header column into a new column',
    run: () =>
      withDoc(inDoc('| a | b |\n|-|-|\n| 1 | 2 | extra |'), async (h) => {
        const ran = h.act(0, 0, 'Pad columns to line up');
        const got = await h.commit();
        const lines = got.split('\n');
        return all({ ran, headerTwoCells: gfmCells(lines[2]).length === 2, delimiterTwoCells: gfmCells(lines[3]).length === 2, extraKept: got.includes('extra') }, got);
      }),
  },
  {
    id: 'tables.pad.u08',
    feature: 'tables.pad',
    name: 'Pad columns fills out a row that has fewer cells than the header',
    run: () => padCheck('| a | bbb |\n|-|-|\n| 1 |', () => ({})).then((r) => r),
  },
  {
    id: 'tables.pad.u09',
    feature: 'tables.pad',
    name: 'Pad, leave, then one document Undo restores the file byte for byte',
    run: () =>
      withDoc(inDoc(RAGGED), async (h) => {
        h.act(0, 0, 'Pad columns to line up');
        const written = await h.commit();
        undo(h.view);
        return all({ padded: written !== inDoc(RAGGED), undone: h.doc() === inDoc(RAGGED) }, { written, after: h.doc() });
      }),
  },
  {
    id: 'tables.pad.u10',
    feature: 'tables.pad',
    name: 'Pad columns on a header-only table lines up the header and delimiter',
    run: () => padCheck('| long header | b |\n|-|-|', () => ({}), [-1, 0]),
  },

  // ---- tables.copy-ref ------------------------------------------------------
  {
    id: 'tables.copy-ref.u01',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a body row names that row line and quotes it',
    run: () => withDoc(inDoc(T4), (h) => same(h.ref(h.cell(2, 1)) ?? '', cellRef(h.doc(), 7, 'v, row 3', '3'))),
  },
  {
    id: 'tables.copy-ref.u02',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a header cell names its column and quotes only that column',
    run: () =>
      // A press on a header is a column gesture: it selects the column, so a right-click
      // there refers to the column rather than to the header line alone. The quote
      // holds the picked cells and leaves the rest out, the rule for any picked set.
      withDoc(inDoc(T4), (h) =>
        same(h.ref(h.cell(-1, 0)) ?? '', 'doc.md:3-8 (n column)\n\n```\n| n   |\n| --- |\n| a   |\n| b   |\n| c   |\n| d   |\n```\n')
      ),
  },
  {
    id: 'tables.copy-ref.u03',
    feature: 'tables.copy-ref',
    name: 'Copy ref inside a three-row selection names the range and carries those rows',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.down(h.gutter(0));
        h.down(h.gutter(2), { shiftKey: true });
        return same(h.ref(h.cell(1, 0)) ?? '', 'doc.md:5-7 (rows 1 to 3)\n\n```\n| a | 1 |\n| b | 2 |\n| c | 3 |\n```\n');
      }),
  },
  {
    id: 'tables.copy-ref.u04',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a selection Shift-clicked up to a header starts at the header line and covers the columns it took',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        // Shift on a header takes every column from the one the selection started in
        // to this one, each end to end, the way Shift on a row number takes whole rows.
        // So this is two whole columns, header to last row, and the ref says so.
        h.down(h.cell(1, 1));
        h.down(h.cell(-1, 0), { shiftKey: true });
        return same(
          h.ref(h.cell(0, 0)) ?? '',
          'doc.md:3-8\n\n```\n| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |\n```\n'
        );
      }),
  },
  {
    id: 'tables.copy-ref.u05',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a row inserted in this visit names the line it will be saved on and quotes it',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.act(0, 0, 'Insert row below');
        return same(h.ref(h.cell(1, 0)) ?? '', cellRef(h.doc(), 6, 'n, row 2', ''));
      }),
  },
  {
    id: 'tables.copy-ref.u06',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a row moved by Move row down names its line after the move and quotes it',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.act(0, 0, 'Move row down');
        return same(h.ref(h.cell(1, 0)) ?? '', cellRef(h.doc(), 6, 'n, row 2', 'a'));
      }),
  },
  {
    id: 'tables.copy-ref.u07',
    feature: 'tables.copy-ref',
    name: 'Copy ref after Sort Z to A names the sorted position',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.act(0, 1, 'Sort column Z to A');
        const where = [0, 1, 2, 3].find((r) => h.cell(r, 0).textContent === 'a');
        return same(where === undefined ? 'row a not found' : h.ref(h.cell(where, 0)) ?? '', cellRef(h.doc(), 8, 'n, row 4', 'a'));
      }),
  },
  {
    id: 'tables.copy-ref.u08',
    feature: 'tables.copy-ref',
    name: 'Copy ref in a table inside a list item names the row line',
    run: () => withDoc(LIST, (h) => same(h.ref(h.cell(1, 1)) ?? '', cellRef(h.doc(), 8, 'b, row 2', '4'))),
  },
  {
    id: 'tables.copy-ref.u09',
    feature: 'tables.copy-ref',
    name: 'Copy ref after an outside change added lines above the table names the row new line',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.remote(0, 0, '# Agent\n\n');
        return same(h.ref(h.cell(0, 0)) ?? '', cellRef(h.doc(), 7, 'n, row 1', 'a'));
      }),
  },
  {
    id: 'tables.copy-ref.u10',
    feature: 'tables.copy-ref',
    name: 'Copy ref on rows holding triple backticks fences them with a longer fence',
    run: () =>
      withDoc(inDoc('| k | v |\n| - | - |\n| ```x``` | 1 |\n| b | 2 |'), (h) => {
        h.down(h.gutter(0));
        h.down(h.gutter(1), { shiftKey: true });
        return same(h.ref(h.cell(0, 1)) ?? '', 'doc.md:5-6 (rows 1 to 2)\n\n````\n| ```x``` | 1 |\n| b | 2 |\n````\n');
      }),
  },
  {
    id: 'tables.copy-ref.u11',
    feature: 'tables.copy-ref',
    name: 'Copy ref from a right-click on a row number names that row',
    run: () => withDoc(inDoc(T4), (h) => same(h.ref(h.gutter(3)) ?? '', rowRef(h.doc(), 8, 'row 4'))),
  },
  {
    id: 'tables.copy-ref.u12',
    feature: 'tables.copy-ref',
    name: 'Copy ref on a row below a row deleted in this visit names its saved line',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.act(0, 0, 'Delete row');
        return same(h.ref(h.cell(1, 0)) ?? '', cellRef(h.doc(), 6, 'n, row 2', 'c'));
      }),
  },

  // ---- tables.row-lines -----------------------------------------------------
  {
    id: 'tables.row-lines.u01',
    feature: 'tables.row-lines',
    name: 'Row numbers and the corner of a table inside a list item name their file lines',
    run: () =>
      withDoc(LIST, (h) => {
        const titles = [0, 1].map((r) => h.gutter(r).title);
        const corner = h.wraps()[0].querySelector<HTMLElement>('.sheaf-table-corner')!.title;
        return all({ rows: j(titles) === j(['Select row (line 7)', 'Select row (line 8)']), corner: corner === 'Select whole table (header on line 5)' }, { titles, corner });
      }),
  },
  {
    id: 'tables.row-lines.u02',
    feature: 'tables.row-lines',
    name: 'After an outside change adds two lines above the table, row numbers name the rows new lines',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.remote(0, 0, '# Agent\n\n');
        const titles = [0, 1, 2, 3].map((r) => h.gutter(r).title);
        const corner = h.wraps()[0].querySelector<HTMLElement>('.sheaf-table-corner')!.title;
        return all({ rows: titles[0] === 'Select row (line 7)' && titles[3] === 'Select row (line 10)', corner: corner.includes('line 5') }, { titles, corner });
      }),
  },
  {
    id: 'tables.row-lines.u03',
    feature: 'tables.row-lines',
    name: 'After an outside change removes the lines above the table, row numbers name the rows new lines',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.remote(0, 'Intro.\n\n'.length, '');
        const titles = [0, 3].map((r) => h.gutter(r).title);
        return { ok: j(titles) === j(['Select row (line 3)', 'Select row (line 6)']), detail: j(titles) };
      }),
  },
  {
    id: 'tables.row-lines.u04',
    feature: 'tables.row-lines',
    name: 'After leaving the table, a row inserted in the grid names its saved line',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        // A grid edit is written to the document as it is made, so the new row has
        // its line straight away, and keeps it once the table is left.
        h.act(0, 0, 'Insert row below');
        const pending = h.gutter(1).title;
        await h.commit();
        const titles = [0, 1, 2].map((r) => h.gutter(r).title);
        return all({ pending: pending === 'Select row (line 6)', saved: j(titles) === j(['Select row (line 5)', 'Select row (line 6)', 'Select row (line 7)']) }, { pending, titles });
      }),
  },
  {
    id: 'tables.row-lines.u05',
    feature: 'tables.row-lines',
    name: 'After Move row down, the moved row number names the line it will be saved on',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.act(0, 0, 'Move row down');
        return same(h.gutter(1).title, 'Select row (line 6)');
      }),
  },

  // ---- tables.change-flash --------------------------------------------------
  {
    id: 'tables.change-flash.u01',
    feature: 'tables.change-flash',
    name: 'An outside change to the header marks the header row and no body row',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const at = inDoc(T4).indexOf('| n |');
        h.remote(at, at + 5, '| name |');
        const head = h.wraps()[0].querySelector('thead tr')!.classList.contains('is-changed');
        return all({ head, body: h.wraps()[0].querySelectorAll('tbody tr.is-changed').length === 0 }, h.marked());
      }),
  },
  {
    id: 'tables.change-flash.u02',
    feature: 'tables.change-flash',
    name: 'An outside change that appends a row marks only the new row',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const at = inDoc(T4).indexOf('| d | 4 |') + 9;
        h.remote(at, at, '\n| e | 5 |');
        return same(h.marked().join('|'), 'e5');
      }),
  },
  {
    id: 'tables.change-flash.u03',
    feature: 'tables.change-flash',
    name: 'An outside change that deletes a row marks nothing',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const at = inDoc(T4).indexOf('| b | 2 |');
        h.remote(at, at + 10, '');
        return all({ none: h.marked().length === 0, rows: h.wraps()[0].querySelectorAll('tbody tr').length === 3 }, h.marked());
      }),
  },
  {
    id: 'tables.change-flash.u04',
    feature: 'tables.change-flash',
    name: 'An outside change to one of two tables marks rows in that table only',
    run: () =>
      withDoc(inDoc(T4 + '\n\n| x | y |\n| - | - |\n| 1 | 2 |'), (h) => {
        const doc = h.doc();
        const at = doc.indexOf('| 1 | 2 |');
        h.remote(at + 6, at + 7, '9');
        return all({ first: h.marked(0).length === 0, second: h.marked(1).join('|') === '19' }, [h.marked(0), h.marked(1)]);
      }),
  },
  {
    id: 'tables.change-flash.u05',
    feature: 'tables.change-flash',
    name: 'Pad columns chosen in Sheaf marks nothing',
    run: () =>
      withDoc(inDoc(RAGGED), (h) => {
        h.act(0, 0, 'Pad columns to line up');
        return { ok: h.marked().length === 0 && h.doc() !== inDoc(RAGGED), detail: j(h.marked()) };
      }),
  },
  {
    id: 'tables.change-flash.u06',
    feature: 'tables.change-flash',
    name: 'An outside change while a cell edit is unsaved still marks the changed row',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        h.edit(0, 1, 'X');
        const at = inDoc(T4).indexOf('| c | 3 |');
        h.remote(at + 6, at + 7, '8');
        return same(h.marked().join('|'), 'c8');
      }),
  },
  {
    id: 'tables.change-flash.u07',
    feature: 'tables.change-flash',
    name: 'A mark is spent: its fade end clears it, and a later redraw of the grid marks nothing',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const at = inDoc(T4).indexOf('| c | 3 |');
        h.remote(at + 6, at + 7, '8');
        const before = h.marked().length;
        const tr = h.wraps()[0].querySelector('tr.is-changed');
        tr?.dispatchEvent(new G.Event('animationend', { bubbles: true }));
        const afterFade = h.marked().length;
        h.act(0, 0, 'Insert row above');
        return all({ before: before === 1, afterFade: afterFade === 0, afterRedraw: h.marked().length === 0 }, { before, afterFade, redraw: h.marked() });
      }),
  },

  {
    id: 'tables.change-flash.u08',
    feature: 'tables.change-flash',
    name: 'An outside change to one row marks that row and no other',
    run: () =>
      withDoc(inDoc(T4), (h) => {
        const at = inDoc(T4).indexOf('| c | 3 |');
        h.remote(at, at + 9, '| c | 33 |');
        return same(h.marked().join('|'), 'c33');
      }),
  },
  {
    id: 'tables.change-flash.u09',
    feature: 'tables.change-flash',
    name: 'Editing a cell in Sheaf and leaving the table marks no row',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.edit(1, 1, '22');
        const got = await h.commit();
        return all({ written: got.includes('| b | 22 |'), none: h.marked().length === 0 }, { got, marked: h.marked() });
      }),
  },

  // ---- tables.outside-merge -------------------------------------------------
  {
    id: 'tables.outside-merge.u01',
    feature: 'tables.outside-merge',
    name: 'An outside change below the table keeps an unsaved cell edit and saves both',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.edit(1, 1, 'X');
        h.remote(h.doc().length, h.doc().length, 'More.\n');
        return same(await h.commit(), inDoc(T4).replace('| b | 2 |', '| b | X |') + 'More.\n');
      }),
  },
  {
    id: 'tables.outside-merge.u02',
    feature: 'tables.outside-merge',
    name: 'A write from outside to the very cell the person edited wins, and what they typed is not written back',
    run: () =>
      // The case the old model was built for, and the one the decision turned on:
      // keeping what the person typed here means writing text over somebody else's
      // write to the same cell. The write wins, and the person gets a notice and an
      // undo step from the host rather than a silent re-application.
      withDoc(inDoc(T4), async (h) => {
        h.edit(0, 1, 'X');
        const at = inDoc(T4).indexOf('| a | 1 |');
        h.outside(at + 6, at + 7, '7');
        return same(await h.commit(), inDoc(T4).replace('| a | 1 |', '| a | 7 |'));
      }),
  },
  {
    id: 'tables.outside-merge.u03',
    feature: 'tables.outside-merge',
    name: 'A write from outside that swaps two rows wins, and the edit made before it is not replayed onto either row',
    run: () =>
      withDoc(inDoc(T8), async (h) => {
        h.edit(0, 1, 'X');
        const at = inDoc(T8).indexOf('| a | 1 |');
        h.outside(at, at + 19, '| b | 2 |\n| a | 1 |');
        const got = await h.commit();
        // The rows are in the writer's order and hold the writer's values. An edit
        // replayed onto a row somebody else has since moved is exactly the text
        // nobody wrote that the decision exists to prevent.
        return all(
          { swapped: bodyLines(got).slice(0, 2).join('|') === '| b | 2 ||| a | 1 |', notReplayed: !got.includes('X') },
          bodyLines(got).slice(0, 2)
        );
      }),
  },
  {
    id: 'tables.outside-merge.u04',
    feature: 'tables.outside-merge',
    name: 'An outside change that appends a row keeps an unsaved cell edit and saves both',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.edit(0, 1, 'X');
        const at = inDoc(T4).indexOf('| d | 4 |') + 9;
        h.remote(at, at, '\n| e | 5 |');
        return same(await h.commit(), inDoc(T4.replace('| a | 1 |', '| a | X |') + '\n| e | 5 |'));
      }),
  },
  {
    id: 'tables.outside-merge.u05',
    feature: 'tables.outside-merge',
    name: 'A write from outside made from the file as it was opened wins over an inserted row, and Sheaf does not put the row back',
    run: () =>
      // Last writer wins, and Sheaf never re-applies a change of the person's on its
      // own: a row replayed onto a table somebody else has since rewritten can land
      // anywhere, and would then be saved. What the person gets instead is a notice
      // and an undo step, which the host decides and the host suite checks.
      withDoc(inDoc(T4), async (h) => {
        h.act(0, 0, 'Insert row below');
        const at = inDoc(T4).indexOf('| d | 4 |');
        h.outside(at + 6, at + 7, '9');
        return same(await h.commit(), inDoc(T4.replace('| d | 4 |', '| d | 9 |')));
      }),
  },
  {
    id: 'tables.outside-merge.u06',
    feature: 'tables.outside-merge',
    name: 'A write from outside arriving while the table menu is open closes it, and Move row down from the menu opened again moves the row in what the file now holds',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        // The menu closes when the document changes under it, so none of its items
        // can act on rows that have moved. Opening it again offers the same actions
        // on the file as it now is.
        h.rightClick(h.cell(0, 0));
        const at = inDoc(T4).indexOf('| d | 4 |');
        h.outside(at + 6, at + 7, '9');
        const open = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item'));
        const closed = open().length === 0;
        const ran = h.menu(h.cell(0, 0), 'Move row down');
        const got = await h.commit();
        // Reported apart: a failing `all` is an object, and objects are truthy.
        const want = inDoc('| n | v |\n| - | - |\n| b | 2 |\n| a | 1 |\n| c | 3 |\n| d | 9 |');
        return all({ closed, ran, moved: got === want }, { got });
      }),
  },
  {
    id: 'tables.outside-merge.u07',
    feature: 'tables.outside-merge',
    name: 'A write from outside made from the file as it was opened wins over a sort, and Sheaf does not sort it again',
    run: () =>
      // The outside writer never saw the sort, so what it writes is the original
      // order with its own change in it. That is the file now. Re-sorting on the
      // person's behalf would be writing a change nobody made to the text that is there.
      withDoc(inDoc(T4), async (h) => {
        h.act(0, 1, 'Sort column Z to A');
        const at = inDoc(T4).indexOf('| a | 1 |');
        h.outside(at + 2, at + 3, 'A');
        return same(await h.commit(), inDoc(T4.replace('| a | 1 |', '| A | 1 |')));
      }),
  },

  {
    id: 'tables.outside-merge.u08',
    feature: 'tables.outside-merge',
    name: 'An outside change to another row keeps an unsaved cell edit, shows both, and saves both',
    run: () =>
      withDoc(inDoc(T4), async (h) => {
        h.edit(0, 1, 'X');
        const at = inDoc(T4).indexOf('| d | 4 |');
        h.remote(at, at + 9, '| d | 44 |');
        const shown = `${h.cell(0, 1).textContent},${h.cell(3, 1).textContent}`;
        const got = await h.commit();
        return all({ shown: shown === 'X,44', file: got === inDoc(T4.replace('| a | 1 |', '| a | X |').replace('| d | 4 |', '| d | 44 |')) }, { shown, got });
      }),
  },

  // ---- tables.paste-range ---------------------------------------------------
  {
    id: 'tables.paste-range.u01',
    feature: 'tables.paste-range',
    name: 'A range pasted on a blank line between paragraphs becomes a padded table there, right-aligning numbers',
    run: () =>
      withDoc('One.\n\n\nTwo.\n', (h) => {
        h.view.dispatch({ selection: { anchor: 6 } });
        pasteInto(h, 'Name\tQty\nfig\t7\napple\t12');
        return all({ grid: h.wraps().length === 1 }, '') && same(h.doc(), 'One.\n\n| Name  | Qty |\n| ----- | --: |\n| fig   | 7   |\n| apple | 12  |\n\nTwo.\n');
      }),
  },
  {
    id: 'tables.paste-range.u02',
    feature: 'tables.paste-range',
    name: 'A range with Windows line endings and a trailing line break pastes the same table',
    run: () =>
      withDoc('One.\n\n\nTwo.\n', (h) => {
        h.view.dispatch({ selection: { anchor: 6 } });
        pasteInto(h, 'Name\tQty\r\nfig\t7\r\napple\t12\r\n');
        return same(h.doc(), 'One.\n\n| Name  | Qty |\n| ----- | --: |\n| fig   | 7   |\n| apple | 12  |\n\nTwo.\n');
      }),
  },
  {
    id: 'tables.paste-range.u03',
    feature: 'tables.paste-range',
    name: 'A range with empty cells, including one at the end of a row, keeps them as empty cells',
    run: () =>
      withDoc('One.', (h) => {
        h.view.dispatch({ selection: { anchor: 4 } });
        pasteInto(h, 'a\tb\tc\n1\t\t3\n\t2\t');
        const lines = h.doc().split('\n').slice(2);
        return all({ four: lines.length === 4, cells: j(lines.map((l) => gfmCells(l))) === j([['a', 'b', 'c'], ['---', '---', '---'].map((x, i) => lines[1] ? gfmCells(lines[1])[i] : x), ['1', '', '3'], ['', '2', '']]) }, h.doc());
      }),
  },
  {
    id: 'tables.paste-range.u04',
    feature: 'tables.paste-range',
    name: 'A column of amounts with currency signs is right-aligned like other numbers',
    run: () =>
      withDoc('One.', (h) => {
        h.view.dispatch({ selection: { anchor: 4 } });
        pasteInto(h, 'Item\tCost\nTea\t$4.50\nCake\t$12.00');
        const delim = h.doc().split('\n')[3] ?? '';
        return { ok: /:\s*\|$/.test(delim), detail: h.doc() };
      }),
  },
  {
    id: 'tables.paste-range.u05',
    feature: 'tables.paste-range',
    name: 'A single column of lines pastes as text, not a table',
    run: () =>
      withDoc('One.', (h) => {
        h.view.dispatch({ selection: { anchor: 4 } });
        pasteInto(h, 'red\ngreen\nblue');
        return { ok: h.wraps().length === 0 && !h.doc().includes('|'), detail: h.doc() };
      }),
  },
  {
    id: 'tables.paste-range.u06',
    feature: 'tables.paste-range',
    name: 'A range with a quoted multi-line cell pastes as a table with that cell whole',
    run: () =>
      withDoc('One.', (h) => {
        h.view.dispatch({ selection: { anchor: 4 } });
        pasteInto(h, 'Name\tNote\nfig\t"line one\nline two"\napple\tok');
        const body = bodyLines(h.doc());
        return all({ grid: h.wraps().length === 1, twoRows: body.length === 2, figWhole: body[0]?.includes('line one') && body[0]?.includes('line two') }, h.doc());
      }),
  },
  {
    id: 'tables.paste-range.u07',
    feature: 'tables.paste-range',
    name: 'Pasting a range over selected text replaces the selected text',
    run: () =>
      withDoc('Say hello now.', (h) => {
        h.view.dispatch({ selection: { anchor: 4, head: 9 } });
        pasteInto(h, 'a\tb\n1\t2');
        return all({ grid: h.wraps().length === 1, replaced: !h.doc().includes('hello') }, h.doc());
      }),
  },
  {
    id: 'tables.paste-range.u08',
    feature: 'tables.paste-range',
    name: 'Pasting a range with the caret mid-paragraph keeps the paragraph whole and puts the table after it',
    run: () =>
      withDoc('First line of a\nparagraph here.\n\nNext.\n', (h) => {
        h.view.dispatch({ selection: { anchor: 6 } });
        pasteInto(h, 'a\tb\n1\t2');
        return same(h.doc(), 'First line of a\nparagraph here.\n\n| a   | b   |\n| --: | --: |\n| 1   | 2   |\n\nNext.\n');
      }),
  },
  {
    id: 'tables.paste-range.u09',
    feature: 'tables.paste-range',
    name: 'Cmd+Z in the pasted grid right away gives the file back byte for byte',
    run: () =>
      withDoc('One.\n\nTwo.\n', (h) => {
        h.view.dispatch({ selection: { anchor: 4 } });
        pasteInto(h, 'a\tb\n1\t2');
        const pasted = h.wraps().length === 1;
        h.key(h.grid(), 'z', { metaKey: true });
        return all({ pasted, undone: h.doc() === 'One.\n\nTwo.\n' }, h.doc());
      }),
  },

  // ---- tables.insert-new ----------------------------------------------------
  {
    id: 'tables.insert-new.u01',
    feature: 'tables.insert-new',
    name: 'Insert table on the empty last line of a file keeps the file ending in a line break',
    run: () =>
      withDoc('para\n', (h) => {
        insertPipeTable(h.view);
        return all({ grid: h.wraps().length === 1 }, '') && same(h.doc(), 'para\n\n' + SKELETON + '\n');
      }, 5),
  },
  {
    id: 'tables.insert-new.u02',
    feature: 'tables.insert-new',
    name: 'Insert table with the caret in a list item puts the table after the list and leaves the list lines alone',
    run: () =>
      withDoc('Intro.\n\n- one\n- two\n\nAfter.\n', (h) => {
        insertPipeTable(h.view);
        return same(h.doc(), 'Intro.\n\n- one\n- two\n\n' + SKELETON + '\n\nAfter.\n');
      }, 11),
  },
  {
    id: 'tables.insert-new.u03',
    feature: 'tables.insert-new',
    name: 'Insert table on the blank line above another table keeps the two tables apart',
    run: () =>
      withDoc('Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', (h) => {
        insertPipeTable(h.view);
        return all({ two: h.wraps().length === 2 }, '') && same(h.doc(), 'Intro.\n\n' + SKELETON + '\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
      }, 7),
  },
  {
    id: 'tables.insert-new.u04',
    feature: 'tables.insert-new',
    name: 'Insert table in an empty file opens the grid on its first header cell',
    run: () =>
      withDoc('', (h) => {
        insertPipeTable(h.view);
        const focus = h.wraps()[0]?.querySelector('.is-focus');
        return all({ doc: h.doc() === SKELETON, focus: focus?.getAttribute('data-r') === '-1' && focus?.getAttribute('data-c') === '0', focused: document.activeElement === h.grid() }, h.doc());
      }),
  },
  {
    id: 'tables.insert-new.u05',
    feature: 'tables.insert-new',
    name: 'Insert table, type two headers with Tab, leave: only the new table lines differ from the file',
    run: () =>
      withDoc('Intro.\n\nAfter.\n', async (h) => {
        insertPipeTable(h.view);
        h.key(h.grid(), 'N');
        // A Markdown cell opens a nested editor rather than an input; Tab leaves it.
        const host = h.cell(-1, 0).querySelector<HTMLElement>('input, textarea, .sheaf-table-input');
        const cm = host && EditorView.findFromDOM(host);
        if (!cm) return { ok: false, detail: 'typing N on the selected header cell opened no cell editor' };
        h.key(cm.contentDOM, 'Tab');
        h.key(h.grid(), 'Q');
        const got = await h.commit();
        return same(got, 'Intro.\n\n| N        | Q        | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n\nAfter.\n');
      }, 3),
  },
  {
    id: 'tables.insert-new.u06',
    feature: 'tables.insert-new',
    name: 'Insert table then Cmd+Z in the grid gives the file back byte for byte',
    run: () =>
      withDoc('Intro.\n\nAfter.\n', (h) => {
        insertPipeTable(h.view);
        h.key(h.grid(), 'z', { metaKey: true });
        return all({ gone: h.wraps().length === 0 }, '') && same(h.doc(), 'Intro.\n\nAfter.\n');
      }, 3),
  },
  {
    id: 'tables.insert-new.u07',
    feature: 'tables.insert-new',
    name: 'Insert table on a heading line puts the table after the heading with blank lines around it',
    run: () =>
      withDoc('# Title\nText\n', (h) => {
        insertPipeTable(h.view);
        return same(h.doc(), '# Title\n\n' + SKELETON + '\n\nText\n');
      }, 3),
  },

  // ---- tables.shapes --------------------------------------------------------
  {
    id: 'tables.shapes.u01',
    feature: 'tables.shapes',
    name: 'A table without outer pipes shows as a grid and Move row down swaps only its lines',
    run: () => actDoc(inDoc('a | b\n--|--\n1 | 2\n3 | 4'), 0, 0, 'Move row down', inDoc('a | b\n--|--\n3 | 4\n1 | 2')),
  },
  {
    id: 'tables.shapes.u02',
    feature: 'tables.shapes',
    name: 'A table with only leading pipes keeps three cells on every line after Insert column right',
    run: () =>
      withDoc(inDoc('| a | b\n| - | -\n| 1 | 2'), async (h) => {
        const ran = h.act(0, 1, 'Insert column right');
        const got = await h.commit();
        const lines = got.split('\n').slice(2, 5);
        return all({ ran, cells: lines.every((l) => gfmCells(l).length === 3), prefix: lines[0].startsWith('| a | b') && lines[2].startsWith('| 1 | 2') }, got);
      }),
  },
  {
    id: 'tables.shapes.u03',
    feature: 'tables.shapes',
    name: 'A table indented three spaces keeps its indentation on a new row',
    run: () => actDoc(inDoc('   | a | b |\n   |-|-|\n   | 1 | 2 |'), 0, 0, 'Insert row below', inDoc('   | a | b |\n   |-|-|\n   | 1 | 2 |\n   |   |   |')),
  },
  {
    id: 'tables.shapes.u04',
    feature: 'tables.shapes',
    name: 'A pipe table inside a list item shows as a grid and Delete row removes only that line',
    run: () =>
      withDoc(LIST, async (h) => {
        const grid = h.wraps().length === 1;
        const ran = h.act(0, 0, 'Delete row');
        const got = await h.commit();
        return all({ grid, ran }, '') && same(got, LIST.replace('  | 1 | 2 |\n', ''));
      }),
  },
  {
    id: 'tables.shapes.u05',
    feature: 'tables.shapes',
    name: 'A table inside a blockquote shows as a grid',
    run: () => withDoc(inDoc('> | a | b |\n> | - | - |\n> | 1 | 2 |'), (h) => ({ ok: h.wraps().length === 1, detail: `grids ${h.wraps().length}` })),
  },
  {
    id: 'tables.shapes.u06',
    feature: 'tables.shapes',
    name: 'A table in a numbered list item keeps its three-space indent on Duplicate row',
    run: () => {
      const D = 'Intro.\n\n1. item\n\n   | a | b |\n   | - | - |\n   | 1 | 2 |\n\nAfter.\n';
      return actDoc(D, 0, 0, 'Duplicate row', D.replace('   | 1 | 2 |\n', '   | 1 | 2 |\n   | 1 | 2 |\n'));
    },
  },
  {
    id: 'tables.shapes.u07',
    feature: 'tables.shapes',
    name: 'A table on the first line of the file takes Insert row above its first row without touching the header',
    run: () => actDoc(T4 + '\n', 0, 0, 'Insert row above', T4.replace('| - | - |\n', '| - | - |\n|   |   |\n') + '\n'),
  },
  {
    id: 'tables.shapes.u08',
    feature: 'tables.shapes',
    name: 'A table in a nested list item keeps every row indented on Sort',
    run: () => {
      const D = 'Intro.\n\n- outer\n  - inner\n\n    | k | v |\n    | - | - |\n    | b | 2 |\n    | a | 1 |\n\nAfter.\n';
      return actDoc(D, 0, 0, 'Sort column A to Z', D.replace('    | b | 2 |\n    | a | 1 |', '    | a | 1 |\n    | b | 2 |'));
    },
  },
];
