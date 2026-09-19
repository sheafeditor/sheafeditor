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
import { history, undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { forceParsing } from '@codemirror/language';
import { SearchQuery, setSearchQuery, closeSearchPanel } from '@codemirror/search';
import { livePreview, revealField } from '../src/webview/livePreview';
import { revealBlockAt } from '../src/webview/revealBlock';
import { searchSupport, findNextMatch } from '../src/webview/search';
import { tables, tableRowSourceAt, tableActionsAt, insertPipeTable, insertCsvTable } from '../src/webview/tables';
import { notionTheme } from '../src/webview/theme';
import { mountContextMenu } from '../src/webview/contextmenu';
import { setLinkHost } from '../src/webview/linkTarget';

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
        markdown({ base: markdownLanguage, codeLanguages: languages }),
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
  ctrl: (label: string) => HTMLButtonElement | null;
  mousedown: (el: Element, opts?: any) => void;
  dblclick: (el: Element) => void;
  keydown: (el: Element, key: string, opts?: any) => void;
  input: (r: number, c: number) => HTMLInputElement | null;
  focusGrid: () => void;
  clipboard: (type: 'copy' | 'cut' | 'paste', text?: string) => { text: string; html: string };
  commit: () => Promise<string>;
  doc: () => string;
}

function mount(doc: string, extra: Extension[] = []): Harness {
  const view = mkView(doc, extra);
  const q = (sel: string): HTMLElement | null => view.dom.querySelector(sel);
  const root = (): HTMLElement | null => q('.sheaf-table');
  const grid = (): HTMLElement | null => q('.sheaf-table-grid');
  const cell = (r: number, c: number): HTMLElement | null =>
    view.dom.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`);
  const ctrl = (label: string): HTMLButtonElement | null => {
    const btns = Array.from(view.dom.querySelectorAll('.sheaf-table-ctrl')) as HTMLButtonElement[];
    return btns.find((b) => b.textContent === label) ?? null;
  };
  const mousedown = (el: Element, opts: any = {}): void => {
    el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true, ...opts }));
  };
  const dblclick = (el: Element): void => {
    el.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  };
  const keydown = (el: Element, key: string, opts: any = {}): void => {
    el.dispatchEvent(new G.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  };
  const input = (r: number, c: number): HTMLInputElement | null =>
    (cell(r, c)?.querySelector('input') as HTMLInputElement) ?? null;
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

async function scenario(name: string, fn: () => Promise<boolean> | boolean): Promise<Result> {
  try {
    const ok = await fn();
    return { name, ok, detail: ok ? '' : 'assertion failed' };
  } catch (e) {
    return { name, ok: false, detail: 'threw: ' + (e as Error).message };
  }
}

const PIPE = P + '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';

export async function runAll(): Promise<Result[]> {
  const results: Result[] = [];

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
      h.ctrl('+ Row')!.click();
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
      h.ctrl('+ Col')!.click();
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
      h.ctrl('− Row')!.click();
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
      h.ctrl('− Col')!.click();
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
      h.ctrl('+ Row')!.click();
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
      h.ctrl('− Row')!.click();
      const doc = await h.commit();
      h.view.destroy();
      return doc === RAGGED.replace('| apple | 3 |\n', '');
    })
  );

  results.push(
    await scenario('+ Col keeps existing cell segments', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(-1, 0)!);
      h.ctrl('+ Col')!.click();
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
      h.ctrl('− Col')!.click();
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
      h.ctrl('+ Row')!.click();
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
      const ok = cell.innerHTML === 'one<br>two' && cell.textContent === 'onetwo';
      h.view.destroy();
      return ok;
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
          'Insert row above|Insert row below|Duplicate row|Move row down|Delete row|Insert column left|Insert column right|Duplicate column|Move column right|Delete column|Sort column A to Z|Sort column Z to A|Align column left|Align column center|Align column right|Pad columns to line up' &&
        header ===
          'Insert row below|Insert column left|Insert column right|Duplicate column|Move column right|Delete column|Sort column A to Z|Sort column Z to A|Align column left|Align column center|Align column right|Pad columns to line up' &&
        outside === null
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
      const activeIsFocus = !!active && document.getElementById(active) === h.cell(1, 1);
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
        copied[0] === 'doc.md:6\n' &&
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
      const editingAfterRow = !!h.root()!.querySelector('input');
      h.keydown(h.grid()!, ' ', { ctrlKey: true });
      const column = h.root()!.querySelectorAll('.is-sel').length;
      const editingAfterColumn = !!h.root()!.querySelector('input');
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
      h.ctrl('+ Row')!.click();
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

  results.push(
    await scenario('an outside change inside a table after a row add keeps the added row', async () => {
      const h = mount(RAGGED);
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('+ Row')!.click();
      const at = h.doc().indexOf('|12|') + 1;
      remote(h, at, at + 2, '13');
      const rows = h.root()!.querySelectorAll('tbody tr').length;
      const doc = await h.commit();
      h.view.destroy();
      return rows === 3 && doc === RAGGED.replace('| apple | 3 |\n', '| apple | 3 |\n|       |     |\n').replace('|12|', '|13|');
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

  const C3 = P + '| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |';

  results.push(
    await scenario('dragging a column header moves the column and permutes its segments', async () => {
      let marked = '';
      const h = mount(C3);
      h.mousedown(h.cell(-1, 0)!, { clientX: 10 });
      h.cell(-1, 2)!.dispatchEvent(new G.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 90 }));
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
      return (
        at === '2,0' &&
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
        at === '2,0' &&
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
    await scenario('table controls delete and add beside a selected block', async () => {
      const h = mount(T4);
      h.mousedown(h.cell(1, 0)!);
      h.keydown(h.grid()!, 'ArrowDown', { shiftKey: true });
      h.ctrl('− Row')!.click();
      const rows = await h.commit();
      h.view.destroy();
      const a = mount(T4);
      a.mousedown(a.cell(0, 0)!);
      a.keydown(a.grid()!, 'ArrowDown', { shiftKey: true });
      a.ctrl('+ Row')!.click();
      const added = focusAt(a);
      a.view.destroy();
      const w = mount(P + '| x | y | z |\n| - | - | - |\n| 1 | 2 | 3 |');
      w.mousedown(w.cell(-1, 0)!);
      w.keydown(w.grid()!, 'ArrowRight', { shiftKey: true });
      w.ctrl('− Col')!.click();
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
      const fence = '```';
      return (
        block.copied === `doc.md:${at(block.lines, '| a | 1 |')}-${at(block.lines, '| b | 2 |')}\n\n${fence}\n| a | 1 |\n| b | 2 |\n${fence}\n` &&
        single.copied === `doc.md:${at(single.lines, '| d | 4 |')}\n`
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
    await scenario('Home and End place the caret in the cell editor', async () => {
      const h = mount(P + '| name |\n| - |\n| Alder Creek |');
      h.mousedown(h.cell(0, 0)!);
      h.keydown(h.grid()!, 'Enter');
      const input = h.root()!.querySelector('input') as HTMLInputElement;
      input.setSelectionRange(3, 3);
      h.keydown(input, 'End');
      const end = [input.selectionStart, input.selectionEnd].join();
      h.keydown(input, 'Home', { shiftKey: true });
      const shiftHome = [input.selectionStart, input.selectionEnd].join();
      h.keydown(input, 'Home');
      const home = [input.selectionStart, input.selectionEnd].join();
      const stillEditing = h.root()!.querySelector('input') === input;
      h.view.destroy();
      return end === '11,11' && shiftHome === '0,11' && home === '0,0' && stillEditing;
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
      h.ctrl('+ Row')!.click(); // written at once, so it has a line of its own
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
      r.ctrl('+ Row')!.click();
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
      v.cell(1, 2)!.querySelector('input')!.value = 'brown';
      v.keydown(v.cell(1, 2)!.querySelector('input')!, 'Enter');
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
      h.dblclick(h.cell(1, 0)!);
      h.keydown(h.input(1, 0)!, 'z', { ctrlKey: true }); // the cell editor's own text undo
      const stillEditing = !!h.input(1, 0);
      window.removeEventListener('keydown', listen);
      h.view.destroy();
      return edited !== RAGGED && undone && redone && redoneByY && stillEditing && seen.length === 0;
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

  results.push(
    await scenario("typing CJK into a padded cell keeps the row's pipes in line", async () => {
      const T = P + '| Name  | Qty |\n| ----- | --- |\n| abcde | 3   |';
      const h = mount(T);
      h.dblclick(h.cell(0, 0)!);
      h.input(0, 0)!.value = '日本';
      h.keydown(h.input(0, 0)!, 'Enter');
      h.mousedown(h.cell(0, 0)!);
      h.ctrl('+ Row')!.click();
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

  return results;
}
