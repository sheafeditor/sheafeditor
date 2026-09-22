// Unit scenarios for media: fenced CSV and TSV data blocks, and images. Each
// asserts what should be true; a failing scenario is a bug candidate, named in
// what a person would see go wrong.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { livePreview, revealField, setLivePreviewConfig } from '../../../src/webview/livePreview';
import { tables } from '../../../src/webview/tables';
import { notionTheme } from '../../../src/webview/theme';
import { planEdit } from '../../../src/textSync';
import { sheafMarkdownLanguage } from '../../../src/webview/markdownDialect';
import {
  parseMarkdownImage,
  parseHtmlImage,
  resolveImageSrc,
  setResourceBaseUri,
  setupImageIngestion,
  handleImageSaved,
  insertImageFiles,
  pickImage,
} from '../../../src/webview/images';

type Result = boolean | { ok: boolean; detail?: string };
interface Scenario {
  id: string;
  feature: string;
  name: string;
  run: () => Result | Promise<Result>;
}

const G: any = globalThis;
const j = (x: unknown): string => JSON.stringify(x);
const same = (got: string, want: string): Result => ({ ok: got === want, detail: got === want ? '' : `got ${j(got)}, want ${j(want)}` });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 1500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(5);
  }
  return fn();
}

// The document lives in /docs/, so ../assets resolves to /assets/.
const BASE = 'https://res.test/docs/';
setResourceBaseUri(BASE);

// A leading paragraph keeps the default caret (position 0) off the block under test,
// so tables render as grids and images as widgets.
const P = '.\n\n';

interface Mounted {
  view: EditorView;
  doc: () => string;
  destroy: () => void;
}

function mount(doc: string, caret = 0): Mounted {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [history(), markdown({ base: sheafMarkdownLanguage }), revealField, livePreview, tables, notionTheme, EditorView.lineWrapping],
    }),
    parent,
  });
  return {
    view,
    doc: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

// ---- Grid helpers ----------------------------------------------------------

const tableEl = (m: Mounted, t = 0): HTMLElement | null => (m.view.dom.querySelectorAll('.sheaf-table')[t] as HTMLElement) ?? null;
const cellEl = (m: Mounted, r: number, c: number, t = 0): HTMLElement | null =>
  (tableEl(m, t)?.querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement) ?? null;

/** What the grid shows: header cells and body rows, as text. */
function gridText(m: Mounted, t = 0): { headers: string[]; rows: string[][] } | null {
  const root = tableEl(m, t);
  if (!root) return null;
  const by = new Map<number, string[]>();
  root.querySelectorAll('[data-r][data-c]').forEach((node) => {
    const el = node as HTMLElement;
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    if (!by.has(r)) by.set(r, []);
    by.get(r)![c] = el.textContent ?? '';
  });
  const rows = [...by.keys()].filter((r) => r >= 0).sort((a, b) => a - b).map((r) => by.get(r)!);
  return { headers: by.get(-1) ?? [], rows };
}

async function commit(m: Mounted, t = 0): Promise<string> {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.blur) ae.blur();
  tableEl(m, t)?.dispatchEvent(new G.Event('focusout', { bubbles: true }));
  await tick();
  await tick();
  return m.doc();
}

/** Double-click a cell, replace its value, press Enter, and leave the grid. */
async function editCell(m: Mounted, r: number, c: number, value: string, t = 0): Promise<string> {
  const el = cellEl(m, r, c, t);
  if (!el) throw new Error(`no cell ${r},${c}`);
  el.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const input = el.querySelector('input, textarea') as HTMLInputElement | null;
  if (!input) throw new Error(`cell ${r},${c} did not open for editing`);
  input.value = value;
  input.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return commit(m, t);
}

/** Mount, edit one cell, return the whole document. */
async function csvEdit(doc: string, r: number, c: number, value: string): Promise<string> {
  const m = mount(doc);
  try {
    return await editCell(m, r, c, value);
  } finally {
    m.destroy();
  }
}

// ---- Image helpers ---------------------------------------------------------

const imgs = (m: Mounted): HTMLImageElement[] => Array.from(m.view.dom.querySelectorAll('img.md-img')) as HTMLImageElement[];
const wraps = (m: Mounted): HTMLElement[] => Array.from(m.view.dom.querySelectorAll('.md-img-wrap')) as HTMLElement[];

function imgButton(m: Mounted, title: string, n = 0): HTMLElement {
  const b = wraps(m)[n]?.querySelector(`.md-img-btn[title="${title}"]`) as HTMLElement | null;
  if (!b) throw new Error(`no image button ${j(title)} on image ${n} (images: ${wraps(m).length})`);
  return b;
}
const clickEl = (el: Element): void => {
  el.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new G.MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** Mount, click image toolbar buttons in order (re-finding each after the rewrite), return the document. */
function imageClicks(doc: string, titles: string[], n = 0, caret = 0): string {
  const m = mount(doc, caret);
  try {
    for (const t of titles) clickEl(imgButton(m, t, n));
    return m.doc();
  } finally {
    m.destroy();
  }
}

/** Mount, open the Alt or Caption editor, type a value, press Enter (or Escape), return the document. */
function imageText(doc: string, which: 'Edit alt text' | 'Edit caption', value: string, key = 'Enter', n = 0): { doc: string; m: Mounted } {
  const m = mount(doc);
  clickEl(imgButton(m, which, n));
  const input = wraps(m)[n].querySelector('.md-img-input') as HTMLInputElement | null;
  if (!input) throw new Error('the text editor did not open');
  input.value = value;
  input.dispatchEvent(new G.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { doc: m.doc(), m };
}

/** The image props written on the line that holds image markup. */
function writtenImage(doc: string) {
  const line = doc.split('\n').find((l) => /<img\b|!\[/.test(l)) ?? '';
  return parseHtmlImage(line) ?? parseMarkdownImage(line);
}

// ---- Ingestion helpers -----------------------------------------------------

const png = (name: string, type = 'image/png'): File => new G.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });

function clipboardEvent(type: string, files: File[], text = ''): Event {
  const e = new G.Event(type, { bubbles: true, cancelable: true });
  const dt = { getData: (t: string) => (t === 'text/plain' ? text : ''), files, items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })), types: files.length ? ['Files'] : [] };
  Object.defineProperty(e, 'clipboardData', { value: dt });
  return e;
}

/** Mount with image ingestion wired to a fake host that saves each file to assets/<name>. */
function ingestMount(doc: string, caret: number, reply: (msg: any) => { path?: string; error?: string } = (msg) => ({ path: `assets/${msg.name}` })) {
  const m = mount(doc, caret);
  const posted: any[] = [];
  let answered = 0;
  setupImageIngestion(m.view, (msg) => posted.push(msg));
  /** Answer every save request as the host would, until `count` have been answered. */
  const serve = async (count: number): Promise<boolean> => {
    while (answered < count) {
      if (!(await until(() => posted.length > answered))) return false;
      const msg = posted[answered++];
      const r = reply(msg);
      handleImageSaved(msg.id, r.path, r.error);
      await tick();
    }
    await tick(10);
    return true;
  };
  return { m, posted, serve };
}

// ---- Data fixtures ---------------------------------------------------------

const QUOTING = '```csv\nname,note,qty\nplain,no quoting needed,1\n"comma, inside",still one field,2\n"quote "" inside",doubled quote escapes it,3\nempty next,,4\n"multi\nline",a field containing a newline,5\ntrailing spaces ,  leading spaces,6\n```';
const TSV = '```tsv\nMonth\tUsers\tRevenue\nJan\t1024\t$4,300\nFeb\t1180\t$5,120\nMar\t1342\t$6,780\n```';

function bigCsv(rows: number): string {
  const lines = ['id,timestamp,region,owner,state,attempts,duration_s,rows_in,rows_out,cost_usd'];
  const regions = ['North', 'South', 'East', 'West', 'Central'];
  for (let i = 1; i <= rows; i++) lines.push(`${i},2044-06-13T11:26:00Z,${regions[i % 5]},docs,running,${i % 9},464.47,1298176,1141175,105.6256`);
  return '```csv\n' + lines.join('\n') + '\n```';
}

export const scenarios: Scenario[] = [
  // ===== data.csv-grid ======================================================
  {
    id: 'data.csv-grid.u01',
    feature: 'data.csv-grid',
    name: 'A csv block shows as a grid with its header, every row and a CSV badge',
    run: () => {
      const m = mount(P + '```csv\nRegion,Q1,Q2\nNorth,120,135\nSouth,98,110\n```\n');
      const g = gridText(m);
      const badge = tableEl(m)?.querySelector('.sheaf-table-badge')?.textContent;
      m.destroy();
      return { ok: j(g) === j({ headers: ['Region', 'Q1', 'Q2'], rows: [['North', '120', '135'], ['South', '98', '110']] }) && badge === 'CSV', detail: `${j(g)} badge ${j(badge)}` };
    },
  },
  {
    id: 'data.csv-grid.u02',
    feature: 'data.csv-grid',
    name: 'A tsv block splits on tabs, shows a TSV badge, and an edited cell with a comma is written unquoted',
    run: async () => {
      const m = mount(P + TSV + '\n');
      const g = gridText(m);
      const badge = tableEl(m)?.querySelector('.sheaf-table-badge')?.textContent;
      const d = await editCell(m, 1, 2, '$6,000');
      m.destroy();
      const want = P + TSV.replace('Feb\t1180\t$5,120', 'Feb\t1180\t$6,000') + '\n';
      return { ok: g?.rows[1]?.[2] === '$5,120' && g?.headers.length === 3 && badge === 'TSV' && d === want, detail: `grid ${j(g)} badge ${j(badge)} doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-grid.u03',
    feature: 'data.csv-grid',
    name: 'A one-column csv block shows as a grid and an edit changes only that line',
    run: async () => same(await csvEdit(P + '```csv\ncolor\nred\ngreen\n```\n', 1, 0, 'blue'), P + '```csv\ncolor\nred\nblue\n```\n'),
  },
  {
    id: 'data.csv-grid.u04',
    feature: 'data.csv-grid',
    name: 'An empty csv block stays a plain code block and the file is untouched',
    run: () => {
      const doc = P + '```csv\n```\n\nafter\n';
      const m = mount(doc);
      const hasGrid = !!tableEl(m);
      const d = m.doc();
      m.destroy();
      return { ok: !hasGrid && d === doc, detail: `grid ${hasGrid} doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-grid.u05',
    feature: 'data.csv-grid',
    name: 'A header-only csv block shows a grid with the header and no rows',
    run: () => {
      const m = mount(P + '```csv\na,b\n```\n');
      const g = gridText(m);
      m.destroy();
      return { ok: j(g) === j({ headers: ['a', 'b'], rows: [] }), detail: j(g) };
    },
  },
  {
    id: 'data.csv-grid.u06',
    feature: 'data.csv-grid',
    name: 'Clicking a cell and leaving the grid leaves the whole quoting block byte-identical',
    run: async () => {
      const doc = P + QUOTING + '\n';
      const m = mount(doc);
      cellEl(m, 2, 0)!.dispatchEvent(new G.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const d = await commit(m);
      m.destroy();
      return same(d, doc);
    },
  },
  {
    id: 'data.csv-grid.u07',
    feature: 'data.csv-grid',
    name: 'A row with fewer fields than the header stays as written when another row is edited',
    run: async () => same(await csvEdit(P + '```csv\na,b,c\n1,2\n3,4,5\n```\n', 1, 0, '9'), P + '```csv\na,b,c\n1,2\n9,4,5\n```\n'),
  },
  {
    id: 'data.csv-grid.u08',
    feature: 'data.csv-grid',
    name: 'Editing a cell in a row with more fields than the header keeps the extra field',
    run: async () => same(await csvEdit(P + '```csv\na,b\n1,2,extra\n3,4\n```\n', 0, 1, '9'), P + '```csv\na,b\n1,9,extra\n3,4\n```\n'),
  },
  {
    id: 'data.csv-grid.u09',
    feature: 'data.csv-grid',
    name: 'Editing a cell keeps a blank line inside the block',
    run: async () => same(await csvEdit(P + '```csv\na,b\n1,2\n\n3,4\n```\n', 1, 1, '9'), P + '```csv\na,b\n1,2\n\n3,9\n```\n'),
  },
  {
    id: 'data.csv-grid.u10',
    feature: 'data.csv-grid',
    name: 'A record of empty fields shows as a row and survives an edit to another row',
    run: async () => {
      const doc = P + '```csv\na,b\n1,2\n,\n3,4\n```\n';
      const m = mount(doc);
      const shown = gridText(m)?.rows.length;
      m.destroy();
      const d = await csvEdit(doc, shown === 3 ? 2 : 1, 1, '9');
      const want = P + '```csv\na,b\n1,2\n,\n3,9\n```\n';
      return { ok: shown === 3 && d === want, detail: `rows shown ${shown}, doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-grid.u11',
    feature: 'data.csv-grid',
    name: 'A row added by Tab to a csv block inside a list item keeps the block indented',
    run: async () => {
      const doc = '- item\n\n  ```csv\n  a,b\n  1,2\n  ```\n\n- next\n';
      const m = mount(doc);
      const header = gridText(m)?.headers[0];
      const last = cellEl(m, 0, 1)!;
      last.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      // A CSV field edits in a plain text area.
      const input = last.querySelector('input, textarea') as HTMLTextAreaElement;
      input.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const grid = tableEl(m)!.querySelector('.sheaf-table-grid')!;
      grid.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
      const d = await commit(m);
      m.destroy();
      const want = '- item\n\n  ```csv\n  a,b\n  1,2\n  q,\n  ```\n\n- next\n';
      return { ok: header === 'a' && d === want, detail: `header ${j(header)} doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-grid.u12',
    feature: 'data.csv-grid',
    name: 'A ~~~csv fence and an upper-case ```CSV fence both show as grids and keep their fences on edit',
    run: async () => {
      const a = await csvEdit(P + '~~~csv\na,b\n1,2\n~~~\n', 0, 1, '9');
      const b = await csvEdit(P + '```CSV\na,b\n1,2\n```\n', 0, 1, '9');
      return { ok: a === P + '~~~csv\na,b\n1,9\n~~~\n' && b === P + '```CSV\na,b\n1,9\n```\n', detail: `${j(a)} ${j(b)}` };
    },
  },
  {
    id: 'data.csv-grid.u13',
    feature: 'data.csv-grid',
    name: 'A csv block with no closing fence at the end of the file edits without gaining one',
    run: async () => same(await csvEdit(P + '```csv\na,b\n1,2', 0, 1, '9'), P + '```csv\na,b\n1,9'),
  },
  {
    id: 'data.csv-grid.u14',
    feature: 'data.csv-grid',
    name: 'In a CRLF file, editing one cell changes only that record and every line keeps CRLF',
    run: async () => {
      const disk = '.\r\n\r\n```csv\r\na,b\r\n1,2\r\n3,4\r\n```\r\n';
      const webview = await csvEdit(disk.replace(/\r\n/g, '\n'), 1, 1, '9');
      const plan = planEdit(disk, webview, true);
      const out = plan ? disk.slice(0, plan.start) + plan.replacement + disk.slice(plan.end) : disk;
      return same(out, '.\r\n\r\n```csv\r\na,b\r\n1,2\r\n3,9\r\n```\r\n');
    },
  },

  // ===== data.csv-quoting ===================================================
  {
    id: 'data.csv-quoting.u01',
    feature: 'data.csv-quoting',
    name: 'The quoting fixture shows each field as a person reads it',
    run: () => {
      const m = mount(P + QUOTING + '\n');
      const g = gridText(m);
      m.destroy();
      const want = {
        headers: ['name', 'note', 'qty'],
        rows: [
          ['plain', 'no quoting needed', '1'],
          ['comma, inside', 'still one field', '2'],
          ['quote " inside', 'doubled quote escapes it', '3'],
          ['empty next', '', '4'],
          ['multi\nline', 'a field containing a newline', '5'],
          ['trailing spaces ', '  leading spaces', '6'],
        ],
      };
      return { ok: j(g) === j(want), detail: j(g) };
    },
  },
  {
    id: 'data.csv-quoting.u02',
    feature: 'data.csv-quoting',
    name: 'Editing qty on the doubled-quote row writes that row with the quote escaped and leaves every other line alone',
    run: async () => same(await csvEdit(P + QUOTING + '\n', 2, 2, '33'), P + QUOTING.replace('doubled quote escapes it,3', 'doubled quote escapes it,33') + '\n'),
  },
  {
    id: 'data.csv-quoting.u03',
    feature: 'data.csv-quoting',
    name: 'Typing a value with a comma and quotes into a cell writes it quoted with doubled quotes',
    run: async () => same(await csvEdit(P + '```csv\nname,note\na,b\nc,d\n```\n', 0, 1, 'say "hi", ok'), P + '```csv\nname,note\na,"say ""hi"", ok"\nc,d\n```\n'),
  },
  {
    id: 'data.csv-quoting.u04',
    feature: 'data.csv-quoting',
    name: 'Opening a cell with a line break and pressing Enter leaves the file unchanged (regression check)',
    run: async () => {
      const doc = P + '```csv\nname,notes\napple,"line one\nline two"\n```\n';
      const m = mount(doc);
      cellEl(m, 0, 1)!.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const area = cellEl(m, 0, 1)!.querySelector('textarea');
      const opened = area?.value;
      area?.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const d = await commit(m);
      m.destroy();
      return { ok: opened === 'line one\nline two' && d === doc, detail: `opened ${j(opened)} doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.u05',
    feature: 'data.csv-quoting',
    name: 'Editing a multi-line cell to two other lines writes it quoted with its line break',
    run: async () => same(await csvEdit(P + '```csv\nname,notes\napple,"line one\nline two"\n```\n', 0, 1, 'first\nsecond'), P + '```csv\nname,notes\napple,"first\nsecond"\n```\n'),
  },
  {
    id: 'data.csv-quoting.u12',
    feature: 'data.csv-quoting',
    name: 'In a multi-line cell Alt+Enter puts a line break in the value and keeps the cell open, while Enter commits it',
    run: async () => {
      // A text box in Chromium on macOS inserts nothing for Alt+Enter and jsdom never
      // performs a key's default action, so the check reads the value the field holds
      // rather than whether the key was let through.
      const doc = P + '```csv\nname,notes\napple,"line one\nline two"\n```\n';
      const m = mount(doc);
      try {
        cellEl(m, 0, 1)!.dispatchEvent(new G.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        const area = cellEl(m, 0, 1)!.querySelector('textarea') as HTMLTextAreaElement | null;
        if (!area) return { ok: false, detail: 'no textarea' };
        const typed = (text: string): void => {
          area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
          area.dispatchEvent(new G.Event('input', { bubbles: true }));
        };
        area.setSelectionRange(0, area.value.length);
        typed('first');
        const alt = new G.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true });
        area.dispatchEvent(alt);
        const value = area.value;
        const stillOpen = cellEl(m, 0, 1)!.querySelector('textarea') === area;
        typed('second');
        const plain = new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        area.dispatchEvent(plain);
        const closed = !cellEl(m, 0, 1)!.querySelector('textarea');
        const d = await commit(m);
        const want = doc.replace('"line one\nline two"', '"first\nsecond"');
        return {
          ok: alt.defaultPrevented && value === 'first\n' && stillOpen && plain.defaultPrevented && closed && d === want,
          detail: `Alt+Enter prevented ${alt.defaultPrevented}, value ${j(value)}, cell still open ${stillOpen}; Enter prevented ${plain.defaultPrevented}, cell closed ${closed}; file ${j(d)}`,
        };
      } finally {
        m.destroy();
      }
    },
  },
  {
    id: 'data.csv-quoting.u06',
    feature: 'data.csv-quoting',
    name: 'A field with a quote after a space keeps its quotes on screen and in the file when the row is edited',
    run: async () => {
      const doc = P + '```csv\nx,y\nsays, "hi" there\n```\n';
      const m = mount(doc);
      const shown = gridText(m)?.rows[0]?.[1];
      m.destroy();
      const d = await csvEdit(doc, 0, 0, 'EDIT');
      const row = d.split('\n').find((l) => l.startsWith('EDIT')) ?? '';
      return { ok: shown === ' "hi" there' && /"hi"|""hi""/.test(row), detail: `shown ${j(shown)} row ${j(row)}` };
    },
  },
  {
    id: 'data.csv-quoting.u07',
    feature: 'data.csv-quoting',
    name: 'An inch mark inside a csv field does not swallow the rows below it',
    run: () => {
      const m = mount(P + '```csv\nitem,price\n27" monitor,300\n6" cable,5\nmouse,20\n```\n');
      const g = gridText(m);
      m.destroy();
      return { ok: j(g?.rows) === j([['27" monitor', '300'], ['6" cable', '5'], ['mouse', '20']]), detail: j(g) };
    },
  },
  {
    id: 'data.csv-quoting.u08',
    feature: 'data.csv-quoting',
    name: 'Editing a price below an inch-mark row changes only that price in the file',
    run: async () => same(await csvEdit(P + '```csv\nitem,price\n27" monitor,300\n6" cable,5\nmouse,20\n```\n', 2, 1, '25'), P + '```csv\nitem,price\n27" monitor,300\n6" cable,5\nmouse,25\n```\n'),
  },
  {
    id: 'data.csv-quoting.u09',
    feature: 'data.csv-quoting',
    name: 'A tsv block with a literal quote in a cell shows one row per line',
    run: () => {
      const m = mount(P + '```tsv\nitem\tsize\nMonitor\t27" wide\nCable\t6" long\n```\n');
      const g = gridText(m);
      m.destroy();
      return { ok: j(g?.rows) === j([['Monitor', '27" wide'], ['Cable', '6" long']]), detail: j(g) };
    },
  },
  {
    id: 'data.csv-quoting.u10',
    feature: 'data.csv-quoting',
    name: 'A trailing empty field shows as an empty cell and stays when another cell in the row is edited',
    run: async () => {
      const doc = P + '```csv\na,b,c\n1,2,\n```\n';
      const m = mount(doc);
      const g = gridText(m);
      m.destroy();
      const d = await csvEdit(doc, 0, 0, '9');
      return { ok: j(g?.rows) === j([['1', '2', '']]) && d === P + '```csv\na,b,c\n9,2,\n```\n', detail: `grid ${j(g)} doc ${j(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.u11',
    feature: 'data.csv-quoting',
    name: 'Leading and trailing spaces in an untouched cell survive an edit to its neighbour',
    run: async () => same(await csvEdit(P + '```csv\na,b\nx, y \n```\n', 0, 0, 'z'), P + '```csv\na,b\nz, y \n```\n'),
  },

  // ===== data.large-blocks ==================================================
  {
    id: 'data.large-blocks.u01',
    feature: 'data.large-blocks',
    name: 'A 2,000-row csv block shows every row, and editing row 1,000 changes only that line',
    run: async () => {
      const block = bigCsv(2000);
      const doc = P + block + '\n';
      const t0 = Date.now();
      const m = mount(doc);
      const mountMs = Date.now() - t0;
      const rows = tableEl(m)?.querySelectorAll('tbody tr').length;
      const t1 = Date.now();
      const d = await editCell(m, 999, 4, 'EDITED');
      const editMs = Date.now() - t1;
      m.destroy();
      const want = doc.replace('\n1000,2044-06-13T11:26:00Z,North,docs,running,', '\n1000,2044-06-13T11:26:00Z,North,docs,EDITED,');
      return { ok: rows === 2000 && d === want, detail: `rows ${rows}, mount ${mountMs} ms, edit ${editMs} ms (jsdom, no layout)${d === want ? '' : `, doc differs`}` };
    },
  },
  {
    id: 'data.large-blocks.u02',
    feature: 'data.large-blocks',
    name: 'Editing the last cell of a 2,000-row block and undoing restores the file exactly',
    run: async () => {
      const doc = P + bigCsv(2000) + '\n';
      const m = mount(doc);
      const d = await editCell(m, 1999, 9, '0');
      const edited = d !== doc && d.includes('\n2000,') && /,0\n```\n$/.test(d);
      undo(m.view);
      await tick();
      const back = m.doc();
      m.destroy();
      return { ok: edited && back === doc, detail: `edited ${edited}, undo restores ${back === doc}` };
    },
  },

  {
    id: 'data.large-blocks.u03',
    feature: 'data.large-blocks',
    name: 'A tsv block below a 2,000-row csv block shows as a grid once the file has finished parsing, without the caret moving',
    run: async () => {
      const tsv = '```tsv\nsku\tqty\nSKU-1\t4\nSKU-2\t5\n```';
      const doc = P + bigCsv(2000) + '\n\nSame grid, tab-delimited.\n\n' + tsv + '\n';
      const m = mount(doc);
      // Grid decorations held in editor state (jsdom draws only a small viewport, so the DOM cannot say).
      const grids = (): string[] => {
        const out: string[] = [];
        for (const source of m.view.state.facet(EditorView.decorations)) {
          const set = typeof source === 'function' ? source(m.view) : source;
          for (let it = set.iter(); it.value; it.next()) {
            const w: any = (it.value.spec as any).widget;
            if (w && (w.kind === 'csv' || w.kind === 'pipe')) out.push(`line ${m.view.state.doc.lineAt(it.from).number} ${w.lang || 'pipe'}`);
          }
        }
        return out;
      };
      const atOpen = grids();
      // Finish parsing the whole file, as the webview's background parser eventually does, then let a
      // transaction that moves nothing go through.
      const parsed = !!ensureSyntaxTree(m.view.state, m.view.state.doc.length, 20000);
      m.view.dispatch({});
      const afterParse = grids();
      // Moving the caret, as a click in the text does, rebuilds the grids.
      m.view.dispatch({ selection: { anchor: 1 } });
      const afterCaret = grids();
      m.destroy();
      return {
        ok: parsed && afterParse.some((g) => g.endsWith('tsv')),
        detail: `grids at open ${j(atOpen)}, after the parse finished ${j(afterParse)} (parsed ${parsed}), after a caret move ${j(afterCaret)}`,
      };
    },
  },

  // ===== images.render ======================================================
  {
    id: 'images.render.u01',
    feature: 'images.render',
    name: 'A Markdown image with a title parses to its src, alt and title',
    run: () => {
      const p = parseMarkdownImage('![A loaf on a board](../assets/rye-loaf.png "Seeded rye and buttermilk loaf")');
      return { ok: j(p) === j({ src: '../assets/rye-loaf.png', alt: 'A loaf on a board', title: 'Seeded rye and buttermilk loaf' }), detail: j(p) };
    },
  },
  {
    id: 'images.render.u02',
    feature: 'images.render',
    name: 'An image whose path has spaces, written in angle brackets, shows as a picture',
    run: () => {
      const m = mount(P + '![Spaces](<../assets/my dot.png>)\n');
      const src = imgs(m).map((i) => i.getAttribute('src'));
      m.destroy();
      return { ok: src.length === 1 && src[0] === 'https://res.test/assets/my%20dot.png', detail: j(src) };
    },
  },
  {
    id: 'images.render.u03',
    feature: 'images.render',
    name: 'An image whose file name has parentheses shows that file',
    run: () => {
      const m = mount(P + '![Paren](../assets/dot(1).png)\n');
      const src = imgs(m).map((i) => i.getAttribute('src'));
      m.destroy();
      return { ok: src.length === 1 && src[0] === 'https://res.test/assets/dot(1).png', detail: j(src) };
    },
  },
  {
    id: 'images.render.u04',
    feature: 'images.render',
    name: 'Relative paths resolve beside the document; https and data pass; file and javascript are refused',
    run: () => {
      const got = {
        rel: resolveImageSrc('../assets/dot.png'),
        sub: resolveImageSrc('assets/pasted.png'),
        https: resolveImageSrc('https://example.com/a.png'),
        data: resolveImageSrc('data:image/gif;base64,R0lGOD'),
        file: resolveImageSrc('file:///etc/a.png'),
        js: resolveImageSrc('javascript:alert(1)'),
      };
      const want = { rel: 'https://res.test/assets/dot.png', sub: 'https://res.test/docs/assets/pasted.png', https: 'https://example.com/a.png', data: 'data:image/gif;base64,R0lGOD', file: null, js: null };
      return { ok: j(got) === j(want), detail: j(got) };
    },
  },
  {
    id: 'images.render.u05',
    feature: 'images.render',
    name: 'A block image shows as a picture with its alt text and its source hidden; a missing file still gets an image element',
    run: () => {
      const m = mount(P + '![A ferry terminal at dawn](../assets/terminal-dawn.png)\n\n![Missing](../assets/does-not-exist.png)\n');
      const alts = imgs(m).map((i) => i.alt);
      const text = m.view.contentDOM.textContent ?? '';
      m.destroy();
      return { ok: j(alts) === j(['A ferry terminal at dawn', 'Missing']) && !text.includes('!['), detail: `alts ${j(alts)} text ${j(text)}` };
    },
  },
  {
    id: 'images.render.u06',
    feature: 'images.render',
    name: 'A one-line HTML img with width shows at that width',
    run: () => {
      const m = mount(P + '<img src="../assets/terminal-dawn.png" alt="Half width" width="320">\n');
      const w = imgs(m).map((i) => i.style.width);
      m.destroy();
      return { ok: j(w) === j(['320px']), detail: j(w) };
    },
  },
  {
    id: 'images.render.u07',
    feature: 'images.render',
    name: 'A centred image written over three lines as <p align="center"> shows as a centred picture',
    run: () => {
      const m = mount(P + '<p align="center">\n  <img src="../assets/rye-loaf.png" alt="Centred, 400px" width="400">\n</p>\n');
      const n = imgs(m).length;
      const centred = wraps(m).some((w) => w.classList.contains('md-img-align-center'));
      m.destroy();
      return { ok: n === 1 && centred, detail: `images ${n}, centred ${centred}` };
    },
  },
  {
    id: 'images.render.u08',
    feature: 'images.render',
    name: 'A figure with a caption written over several lines shows the picture and its caption',
    run: () => {
      const m = mount(P + '<figure>\n  <img src="../assets/conflict-inline.png" alt="An editor" width="560">\n  <figcaption>A caption.</figcaption>\n</figure>\n');
      const n = imgs(m).length;
      const cap = m.view.dom.querySelector('.md-figcaption')?.textContent;
      m.destroy();
      return { ok: n === 1 && cap === 'A caption.', detail: `images ${n}, caption ${j(cap)}` };
    },
  },
  {
    id: 'images.render.u09',
    feature: 'images.render',
    name: 'A reference-style image shows as a picture',
    run: () => {
      const m = mount(P + '![Terminal at dawn][dawn]\n\n[dawn]: ../assets/terminal-dawn.png "Reference-style image"\n');
      const src = imgs(m).map((i) => i.getAttribute('src'));
      m.destroy();
      return { ok: j(src) === j(['https://res.test/assets/terminal-dawn.png']), detail: j(src) };
    },
  },
  {
    id: 'images.render.u10',
    feature: 'images.render',
    name: 'Image markup inside a code fence stays text',
    run: () => {
      const m = mount(P + '```markdown\n![not rendered](../assets/terminal-dawn.png)\n<img src="../assets/dot.png" width="16">\n```\n');
      const n = imgs(m).length;
      m.destroy();
      return { ok: n === 0, detail: `images ${n}` };
    },
  },
  {
    id: 'images.render.u11',
    feature: 'images.render',
    name: 'Images inline in a list item, under a list item, in a quote and in a heading all show as pictures',
    run: () => {
      const m = mount(P + '- Item with an image: ![dot](../assets/dot.png)\n- Item with a block image:\n\n  ![Terminal](../assets/terminal-dawn.png)\n\n> ![quoted](../assets/dot.png)\n\n### A heading with ![inhead](../assets/dot.png) in it\n');
      const alts = imgs(m).map((i) => i.alt);
      m.destroy();
      return { ok: j(alts) === j(['dot', 'Terminal', 'quoted', 'inhead']), detail: j(alts) };
    },
  },
  {
    id: 'images.render.u12',
    feature: 'images.render',
    name: 'An image in a pipe table cell shows as a picture in the grid, without a stray "!"',
    run: () => {
      const m = mount(P + '| Preview | Name |\n| :---: | :--- |\n| ![dot](../assets/dot.png) | dot.png |\n');
      const cell = cellEl(m, 0, 0);
      const html = cell?.innerHTML ?? null;
      const hasImg = !!cell?.querySelector('img');
      m.destroy();
      return { ok: hasImg && !(cell?.textContent ?? '').includes('!'), detail: `cell html ${j(html)}` };
    },
  },
  {
    id: 'images.render.u13',
    feature: 'images.render',
    name: 'Remote https, data URI and SVG images get image widgets; a file: URL stays as source',
    run: () => {
      const m = mount(P + '![Remote](https://example.invalid/remote.png)\n\n![Data](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n\n![An SVG](../assets/logo.svg)\n\n![File](file:///tmp/a.png)\n');
      const alts = imgs(m).map((i) => i.alt);
      m.destroy();
      return { ok: j(alts) === j(['Remote', 'Data', 'An SVG']), detail: j(alts) };
    },
  },
  {
    id: 'images.render.u14',
    feature: 'images.render',
    name: 'With reveal-syntax-on-line on, the caret on an image line shows the Markdown source instead of the picture',
    run: () => {
      setLivePreviewConfig({ revealSyntaxOnLine: true });
      const doc = P + '![dot](../assets/dot.png)\n';
      const m = mount(doc, P.length + 2);
      const n = imgs(m).length;
      const text = m.view.contentDOM.textContent ?? '';
      m.destroy();
      return { ok: n === 0 && text.includes('![dot](../assets/dot.png)'), detail: `images ${n} text ${j(text)}` };
    },
  },
  {
    id: 'images.render.u17',
    feature: 'images.render',
    name: 'With reveal-syntax-on-line off (the VS Code default), the caret on an image line keeps the picture',
    run: () => {
      setLivePreviewConfig({ revealSyntaxOnLine: false });
      try {
        const m = mount(P + '![dot](../assets/dot.png)\n', P.length + 2);
        const n = imgs(m).length;
        m.destroy();
        return { ok: n === 1, detail: `images ${n}` };
      } finally {
        setLivePreviewConfig({ revealSyntaxOnLine: true });
      }
    },
  },
  {
    id: 'images.render.u15',
    feature: 'images.render',
    name: 'A linked image and a single-quoted upper-case IMG tag both show as pictures',
    run: () => {
      const m = mount(P + '[![linked](../assets/dot.png)](https://example.com)\n\n<IMG SRC=\'../assets/dot.png\' ALT=\'upper\'>\n');
      const alts = imgs(m).map((i) => i.alt);
      m.destroy();
      return { ok: j(alts) === j(['linked', 'upper']), detail: j(alts) };
    },
  },

  // ===== images.resize-align-caption ========================================
  {
    id: 'images.resize-align-caption.u01',
    feature: 'images.resize-align-caption',
    name: 'Width M on a Markdown image writes one HTML img with width 420 and nothing else changes',
    run: () => same(imageClicks(P + '![Dawn](../assets/terminal-dawn.png)\n\nafter\n', ['Width: M']), P + '<img src="../assets/terminal-dawn.png" alt="Dawn" width="420">\n\nafter\n'),
  },
  {
    id: 'images.resize-align-caption.u02',
    feature: 'images.resize-align-caption',
    name: 'Width Full on an HTML image with only a width writes it back as plain Markdown',
    run: () => same(imageClicks(P + '<img src="a.png" alt="A" width="320">\n', ['Width: Full']), P + '![A](a.png)\n'),
  },
  {
    id: 'images.resize-align-caption.u03',
    feature: 'images.resize-align-caption',
    name: 'Align center writes a centred paragraph, and Align center again gives the Markdown back',
    run: () => {
      const once = imageClicks(P + '![A](a.png)\n', ['Align center']);
      const twice = imageClicks(P + '![A](a.png)\n', ['Align center', 'Align center']);
      return { ok: once === P + '<p align="center"><img src="a.png" alt="A"></p>\n' && twice === P + '![A](a.png)\n', detail: `once ${j(once)} twice ${j(twice)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u04',
    feature: 'images.resize-align-caption',
    name: 'Align left on an image already written as HTML with align="right" changes only the align attribute',
    run: () => same(imageClicks(P + '<img src="a.png" alt="A" width="100" align="right">\n', ['Align left']), P + '<img src="a.png" alt="A" width="100" align="left">\n'),
  },
  {
    id: 'images.resize-align-caption.u05',
    feature: 'images.resize-align-caption',
    name: 'A caption with quotes, an ampersand and HTML is written escaped and shows exactly as typed',
    run: async () => {
      const typed = 'Say "hi" & <b>bold</b>';
      const { doc, m } = imageText(P + '![A](a.png)\n', 'Edit caption', typed);
      await tick();
      const shown = m.view.dom.querySelector('.md-figcaption')?.textContent;
      m.destroy();
      const want = P + '<figure><img src="a.png" alt="A"><figcaption>Say &quot;hi&quot; &amp; &lt;b&gt;bold&lt;/b&gt;</figcaption></figure>\n';
      return { ok: doc === want && shown === typed, detail: `doc ${j(doc)} shown ${j(shown)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u06',
    feature: 'images.resize-align-caption',
    name: 'Adding a caption to a centred image keeps it centred',
    run: () => {
      const { doc, m } = imageText(P + '<p align="center"><img src="a.png" alt="A"></p>\n', 'Edit caption', 'Cap');
      m.destroy();
      const p = writtenImage(doc);
      return { ok: p?.caption === 'Cap' && p?.align === 'center', detail: `doc ${j(doc)} parsed ${j(p)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u07',
    feature: 'images.resize-align-caption',
    name: 'Align center on a captioned image centres it and keeps the caption',
    run: () => {
      const before = P + '<figure><img src="a.png" alt="A"><figcaption>Cap</figcaption></figure>\n';
      const doc = imageClicks(before, ['Align center']);
      const p = writtenImage(doc);
      return { ok: doc !== before && p?.caption === 'Cap' && p?.align === 'center', detail: `doc ${j(doc)} parsed ${j(p)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u08',
    feature: 'images.resize-align-caption',
    name: 'Resizing an image that has a title keeps the title in the file',
    run: () => {
      const doc = imageClicks(P + '![A loaf](../assets/rye-loaf.png "Seeded rye")\n', ['Width: S']);
      return { ok: doc.includes('Seeded rye') && doc.includes('240'), detail: j(doc) };
    },
  },
  {
    id: 'images.resize-align-caption.u09',
    feature: 'images.resize-align-caption',
    name: 'Alt text with square brackets keeps the image an image',
    run: async () => {
      const a = imageText(P + '![A](a.png)\n', 'Edit alt text', 'see [1]');
      await tick();
      const balanced = { doc: a.doc, alts: imgs(a.m).map((i) => i.alt) };
      a.m.destroy();
      const b = imageText(P + '![A](a.png)\n', 'Edit alt text', 'a ] b');
      await tick();
      const lone = { doc: b.doc, alts: imgs(b.m).map((i) => i.alt) };
      b.m.destroy();
      return { ok: j(balanced.alts) === j(['see [1]']) && j(lone.alts) === j(['a ] b']), detail: `balanced ${j(balanced)} lone ${j(lone)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u10',
    feature: 'images.resize-align-caption',
    name: 'An image whose path has a space stays an image after Width Full and after an alt edit',
    run: async () => {
      const full = mount(P + '<img src="my dot.png" alt="A" width="100">\n');
      clickEl(imgButton(full, 'Width: Full'));
      await tick();
      const r1 = { doc: full.doc(), images: imgs(full).length };
      full.destroy();
      const alt = imageText(P + '![A](<my dot.png>)\n', 'Edit alt text', 'B');
      await tick();
      const r2 = { doc: alt.doc, images: imgs(alt.m).length };
      alt.m.destroy();
      return { ok: r1.images === 1 && r2.images === 1, detail: `full ${j(r1)} alt ${j(r2)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u11',
    feature: 'images.resize-align-caption',
    name: 'Width S on an image written with width and height does not leave the old height behind',
    run: () => {
      const doc = imageClicks(P + '<img src="dot.png" alt="Tiny" width="16" height="16">\n', ['Width: S']);
      return { ok: doc.includes('width="240"') && !doc.includes('height="16"'), detail: j(doc) };
    },
  },
  {
    id: 'images.resize-align-caption.u12',
    feature: 'images.resize-align-caption',
    name: 'Width S on an image inline in a sentence rewrites only the image',
    run: () => same(imageClicks(P + 'here is a dot ![dot](dot.png) mid-paragraph.\n', ['Width: S']), P + 'here is a dot <img src="dot.png" alt="dot" width="240"> mid-paragraph.\n'),
  },
  {
    id: 'images.resize-align-caption.u13',
    feature: 'images.resize-align-caption',
    name: 'One undo after Width M gives the file back byte-identical',
    run: () => {
      const doc = P + '![Dawn](../assets/terminal-dawn.png)\n\nafter\n';
      const m = mount(doc);
      clickEl(imgButton(m, 'Width: M'));
      const changed = m.doc() !== doc;
      undo(m.view);
      const back = m.doc();
      m.destroy();
      return { ok: changed && back === doc, detail: `changed ${changed} back ${j(back)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u14',
    feature: 'images.resize-align-caption',
    name: 'Clearing a caption writes the image back as Markdown; Escape in the caption box changes nothing',
    run: () => {
      const fig = P + '<figure><img src="a.png" alt="A"><figcaption>Cap</figcaption></figure>\n';
      const cleared = imageText(fig, 'Edit caption', '');
      cleared.m.destroy();
      const escaped = imageText(fig, 'Edit caption', 'Changed', 'Escape');
      escaped.m.destroy();
      return { ok: cleared.doc === P + '![A](a.png)\n' && escaped.doc === fig, detail: `cleared ${j(cleared.doc)} escaped ${j(escaped.doc)}` };
    },
  },
  {
    id: 'images.resize-align-caption.u15',
    feature: 'images.resize-align-caption',
    name: 'Align right on an HTML image followed by text on the same line changes only the markup',
    run: () =>
      same(
        imageClicks(P + '<img src="dot.png" alt="Tiny" width="16"> sized inline, next to text.\n', ['Align right']),
        P + '<img src="dot.png" alt="Tiny" width="16" align="right"> sized inline, next to text.\n'
      ),
  },
  {
    id: 'images.resize-align-caption.u16',
    feature: 'images.resize-align-caption',
    name: 'Width M on an image under a list item keeps the list and its indentation',
    // The caret in the last item, since one in the first would show that item's Markdown, image and all.
    run: () => same(imageClicks('- Item:\n\n  ![T](t.png)\n\n- Last\n', ['Width: M'], 0, 26), '- Item:\n\n  <img src="t.png" alt="T" width="420">\n\n- Last\n'),
  },

  // ===== images.paste-drop ==================================================
  {
    id: 'images.paste-drop.u01',
    feature: 'images.paste-drop',
    name: 'Pasting one image on an empty line asks the host to save it and links the saved file there',
    run: async () => {
      const doc = '.\n\n\nafter\n';
      const { m, posted, serve } = ingestMount(doc, 3);
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('shot.png')]));
      const ok = await serve(1);
      const d = m.doc();
      m.destroy();
      const msg = posted[0] ?? {};
      return { ok: ok && msg.type === 'saveImage' && msg.name === 'shot.png' && msg.data === 'iVBORw0KGgo=' && d === '.\n\n![shot](assets/shot.png)\n\nafter\n', detail: `msg ${j({ ...msg, id: undefined })} doc ${j(d)}` };
    },
  },
  {
    id: 'images.paste-drop.u02',
    feature: 'images.paste-drop',
    name: 'A paste that carries text as well as an image pastes the text and saves no file',
    run: async () => {
      const { m, posted } = ingestMount('.\n\n\n', 3);
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('shot.png')], 'hello'));
      await tick(30);
      m.destroy();
      return { ok: posted.length === 0, detail: `posted ${posted.length}` };
    },
  },
  {
    id: 'images.paste-drop.u03',
    feature: 'images.paste-drop',
    name: 'Pasting two images at once links both, in order, each on its own line',
    run: async () => {
      const { m, posted, serve } = ingestMount('.\n\n\nafter\n', 3);
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('a.png'), png('b.png')]));
      const ok = await serve(2);
      const d = m.doc();
      m.destroy();
      return { ok: ok && posted.map((p) => p.name).join() === 'a.png,b.png' && d === '.\n\n![a](assets/a.png)\n![b](assets/b.png)\n\nafter\n', detail: `names ${j(posted.map((p) => p.name))} doc ${j(d)}` };
    },
  },
  {
    id: 'images.paste-drop.u04',
    feature: 'images.paste-drop',
    name: 'Pasting an image with the caret mid-sentence puts the link on its own line and keeps every character',
    run: async () => {
      const { m, serve } = ingestMount('Say hello world\n', 10);
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('shot.png')]));
      await serve(1);
      const d = m.doc();
      m.destroy();
      return same(d, 'Say hello \n![shot](assets/shot.png)\nworld\n');
    },
  },
  {
    id: 'images.paste-drop.u05',
    feature: 'images.paste-drop',
    name: 'An unnamed pasted image is named pasted-image-NNNNNN with an extension from its type',
    run: async () => {
      const names: string[] = [];
      for (const type of ['image/png', 'image/svg+xml', 'image/jpeg']) {
        const { m, posted, serve } = ingestMount('.\n\n\n', 3);
        m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('', type)]));
        await serve(1);
        names.push(posted[0]?.name);
        m.destroy();
      }
      return { ok: /^pasted-image-\d{6}\.png$/.test(names[0]) && /^pasted-image-\d{6}\.svg$/.test(names[1]) && /^pasted-image-\d{6}\.(jpeg|jpg)$/.test(names[2]), detail: j(names) };
    },
  },
  {
    id: 'images.paste-drop.u06',
    feature: 'images.paste-drop',
    name: 'When the host cannot save the image the document is left unchanged',
    run: async () => {
      const doc = '.\n\n\nafter\n';
      const { m, serve } = ingestMount(doc, 3, () => ({ error: 'EACCES' }));
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('shot.png')]));
      await serve(1);
      const d = m.doc();
      m.destroy();
      return same(d, doc);
    },
  },
  {
    id: 'images.paste-drop.u07',
    feature: 'images.paste-drop',
    name: 'The alt text comes from the saved file name with dashes and underscores as spaces',
    run: async () => {
      const { m, serve } = ingestMount('.\n\n\n', 3, () => ({ path: 'assets/my-photo_1.png' }));
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [png('my photo 1.png')]));
      await serve(1);
      const d = m.doc();
      m.destroy();
      return same(d, '.\n\n![my photo 1](assets/my-photo_1.png)\n\n');
    },
  },
  {
    id: 'images.paste-drop.u08',
    feature: 'images.paste-drop',
    name: 'Pasting a non-image file with no text saves nothing',
    run: async () => {
      const { m, posted } = ingestMount('.\n\n\n', 3);
      m.view.contentDOM.dispatchEvent(clipboardEvent('paste', [new G.File(['hi'], 'notes.txt', { type: 'text/plain' })]));
      await tick(30);
      m.destroy();
      return { ok: posted.length === 0, detail: `posted ${posted.length}` };
    },
  },

  // ===== images.insert-picker ===============================================
  {
    id: 'images.insert-picker.u01',
    feature: 'images.insert-picker',
    name: 'Insert Image opens an image picker that allows several files, and only the chosen images are saved and linked',
    run: async () => {
      const { m, posted, serve } = ingestMount('.\n\n\nafter\n', 3);
      const proto = (window as any).HTMLInputElement.prototype;
      const original = proto.click;
      let opened: HTMLInputElement | null = null;
      proto.click = function (this: HTMLInputElement) {
        opened = this;
      };
      try {
        pickImage(m.view);
      } finally {
        proto.click = original;
      }
      const input = opened as HTMLInputElement | null;
      const attrs = input ? { type: input.type, accept: input.accept, multiple: input.multiple } : null;
      if (input) {
        Object.defineProperty(input, 'files', { value: [png('one.png'), new G.File(['x'], 'notes.txt', { type: 'text/plain' }), png('two.png')] });
        input.dispatchEvent(new G.Event('change'));
      }
      const ok = await serve(2);
      const d = m.doc();
      const left = document.querySelectorAll('input[type=file]').length;
      m.destroy();
      return {
        ok: j(attrs) === j({ type: 'file', accept: 'image/*', multiple: true }) && ok && posted.length === 2 && d === '.\n\n![one](assets/one.png)\n![two](assets/two.png)\n\nafter\n' && left === 0,
        detail: `input ${j(attrs)} posted ${j(posted.map((p) => p.name))} doc ${j(d)} inputs left ${left}`,
      };
    },
  },
  {
    id: 'images.insert-picker.u02',
    feature: 'images.insert-picker',
    name: 'Cancelling the picker removes it and leaves the document unchanged',
    run: async () => {
      const doc = '.\n\n\nafter\n';
      const { m, posted } = ingestMount(doc, 3);
      const proto = (window as any).HTMLInputElement.prototype;
      const original = proto.click;
      let opened: HTMLInputElement | null = null;
      proto.click = function (this: HTMLInputElement) {
        opened = this;
      };
      try {
        pickImage(m.view);
      } finally {
        proto.click = original;
      }
      (opened as HTMLInputElement | null)?.dispatchEvent(new G.Event('cancel'));
      await tick(20);
      const left = document.querySelectorAll('input[type=file]').length;
      const d = m.doc();
      m.destroy();
      return { ok: !!opened && left === 0 && posted.length === 0 && d === doc, detail: `opened ${!!opened} left ${left} posted ${posted.length} doc ${j(d)}` };
    },
  },
  {
    id: 'images.insert-picker.u04',
    feature: 'images.insert-picker',
    name: 'Replace image file saves the chosen file and swaps only the src, keeping width and alt',
    run: async () => {
      const doc = P + '<img src="../assets/terminal-dawn.png" alt="Dawn" width="300">\n\nafter\n';
      const { m, posted, serve } = ingestMount(doc, 0);
      const proto = (window as any).HTMLInputElement.prototype;
      const original = proto.click;
      let opened: HTMLInputElement | null = null;
      proto.click = function (this: HTMLInputElement) {
        opened = this;
      };
      try {
        clickEl(imgButton(m, 'Replace image file'));
      } finally {
        proto.click = original;
      }
      const input = opened as HTMLInputElement | null;
      if (input) {
        Object.defineProperty(input, 'files', { value: [png('swap.png')] });
        input.dispatchEvent(new G.Event('change'));
      }
      const ok = await serve(1);
      await tick(10);
      const d = m.doc();
      m.destroy();
      return { ok: !!input && ok && posted[0]?.name === 'swap.png' && d === P + '<img src="assets/swap.png" alt="Dawn" width="300">\n\nafter\n', detail: `opened ${!!input} posted ${j(posted.map((p) => p.name))} doc ${j(d)}` };
    },
  },
  {
    id: 'images.insert-picker.u03',
    feature: 'images.insert-picker',
    name: 'An image chosen with the caret at the end of a paragraph is linked on the next line without adding a blank line',
    run: async () => {
      const { m, serve } = ingestMount('Intro text\n\nafter\n', 10);
      const done = insertImageFiles(m.view, [png('pic.png')]);
      await serve(1);
      await done;
      const d = m.doc();
      m.destroy();
      return same(d, 'Intro text\n![pic](assets/pic.png)\n\nafter\n');
    },
  },
];
