// E2E scenarios for media: fenced CSV and TSV data blocks, and images, driven by
// mouse clicks, drags and hovers in real VS Code. Results are checked on disk, in
// the workspace, and on screen.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { show, REPO, RUNS } from '../session.mjs';
import { readPng, apart, show as showColour } from '../pixels.mjs';

const NOTES = join(RUNS, 'media-notes');
mkdirSync(NOTES, { recursive: true });
const SAMPLE_ASSETS = join(REPO, 'sample', 'assets');
const j = (x) => JSON.stringify(x);

// ---- Helpers ---------------------------------------------------------------

/** Wait for the file to differ from `before`, then return it once it settles. */
async function diskChange(S, file, before, max = 8000) {
  const end = Date.now() + max;
  while (Date.now() < end) {
    if (readFileSync(file, 'utf8') !== before) break;
    await S.sleep(150);
  }
  return S.disk(file);
}

/** Wait long enough for any write and auto-save to land, then read the file. */
async function diskSettled(S, file) {
  await S.sleep(2000);
  return S.disk(file);
}

const cell = (r, c, nth = 0) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]`, nth });

/** Double-click a grid cell, type over its value, press Enter. */
async function typeInCell(S, r, c, text, nth = 0) {
  await S.dblclick(cell(r, c, nth));
  await S.sleep(150);
  await S.type(text);
  await S.press('Enter');
}

/** What each rendered grid shows, as text. */
const grids = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.sheaf-table')].map((t) => {
      const by = {};
      t.querySelectorAll('[data-r][data-c]').forEach((el) => {
        (by[el.dataset.r] ||= [])[Number(el.dataset.c)] = el.textContent;
      });
      const rows = Object.keys(by).map(Number).filter((r) => r >= 0).sort((a, b) => a - b).map((r) => by[r]);
      return { headers: by['-1'] || [], rows, badge: t.querySelector('.sheaf-table-badge')?.textContent ?? null };
    })
  );

/** Every rendered image widget: alt, whether it loaded, whether it shows as broken, its box. */
const images = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.md-img-wrap')].map((w) => {
      const img = w.querySelector('img.md-img');
      const r = img.getBoundingClientRect();
      return { alt: img.alt, src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, naturalWidth: img.naturalWidth, broken: w.classList.contains('is-broken'), cls: w.className, width: Math.round(r.width), left: Math.round(r.left), caption: w.querySelector('.md-figcaption')?.textContent ?? null };
    })
  );

async function waitImages(S, count, ms = 4000) {
  const end = Date.now() + ms;
  let list = [];
  while (Date.now() < end) {
    list = await images(S);
    if (list.length >= count && list.every((i) => i.loaded || i.broken)) break;
    await S.sleep(200);
  }
  return list;
}

/** Scroll the document with the mouse wheel until `text` is on screen. */
async function scrollTo(S, text, { far = 300, dir = 1 } = {}) {
  await S.hover({ sel: '.cm-scroller' });
  for (let i = 0; i < 150; i++) {
    const r = await S.eval((t) => {
      const content = document.querySelector('.cm-content');
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode()); ) {
        const k = n.data.indexOf(t);
        if (k < 0) continue;
        const range = document.createRange();
        range.setStart(n, k);
        range.setEnd(n, k + t.length);
        const b = range.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, vh: innerHeight };
      }
      return null;
    }, text);
    if (r && r.top > 60 && r.bottom < r.vh * 0.45) return true;
    // Not rendered yet: wheel a long way in the given direction; on screen or near it: wheel by the distance.
    await S.page.mouse.wheel(0, r ? Math.round(r.top - r.vh * 0.25) : far * dir);
    await S.sleep(150);
  }
  return false;
}

/** Hover an image by its position among rendered images, so its toolbar shows. */
const hoverImage = (S, nth = 0) => S.hover({ sel: 'img.md-img', nth });
/** Click an image toolbar button by its title (e.g. 'Width: M', 'Align center', 'Edit caption'). */
const imageButton = (S, title, nth = 0) => S.click({ sel: '.md-img-btn', hasText: title, nth });

/** Put a PNG on the clipboard, as a person copying an image would. */
const clipboardPng = (S, path) => S.clipboard.writeImage(path);

/** Every Markdown image link in a document. */
const links = (d) => [...d.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => ({ alt: m[1], path: m[2], line: m[0] }));

/** A PNG's pixel size, from its header. */
const pngSize = (p) => {
  const b = readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

/** Toast notifications VS Code is showing. */
const toasts = (S) => S.page.locator('.notifications-toasts .notification-toast').allTextContents().catch(() => []);

// ---- Data fixtures ---------------------------------------------------------

const QUOTING = '```csv\nname,note,qty\nplain,no quoting needed,1\n"comma, inside",still one field,2\n"quote "" inside",doubled quote escapes it,3\nempty next,,4\n"multi\nline",a field containing a newline,5\ntrailing spaces ,  leading spaces,6\n```';
const wrapDoc = (block) => `Intro paragraph above.\n\n${block}\n\nOutro paragraph below.\n`;
const leave = (S) => S.caret('Outro', 2);

export const scenarios = [
  // ===== data.csv-grid ======================================================
  {
    id: 'data.csv-grid.e01',
    feature: 'data.csv-grid',
    name: 'A csv block shows as a grid with a CSV badge; double-clicking a cell and typing changes only that value in the file',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nRegion,Q1,Q2\nNorth,120,135\nSouth,98,110\n```');
      const file = await S.fresh('csv-grid-edit', DOC);
      const g = (await grids(S))[0];
      await S.shot('csv-grid-e01-open');
      await typeInCell(S, 0, 2, '999');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const want = DOC.replace('North,120,135', 'North,120,999');
      return { ok: j(g) === j({ headers: ['Region', 'Q1', 'Q2'], rows: [['North', '120', '135'], ['South', '98', '110']], badge: 'CSV' }) && d === want, detail: `grid ${j(g)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-grid.e02',
    feature: 'data.csv-grid',
    name: 'A tsv block shows as a grid with a TSV badge; an edited value with a comma is written with tabs and no quotes',
    run: async (S) => {
      const DOC = wrapDoc('```tsv\nMonth\tUsers\tRevenue\nJan\t1024\t$4,300\nFeb\t1180\t$5,120\n```');
      const file = await S.fresh('tsv-grid-edit', DOC);
      const g = (await grids(S))[0];
      await typeInCell(S, 1, 2, '$6,000');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const want = DOC.replace('Feb\t1180\t$5,120', 'Feb\t1180\t$6,000');
      return { ok: g?.badge === 'TSV' && g?.rows[1]?.[2] === '$5,120' && d === want, detail: `grid ${j(g)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-grid.e03',
    feature: 'data.csv-grid',
    name: 'Clicking a cell of the quoting block and clicking back into the text leaves the file byte-identical',
    run: async (S) => {
      const DOC = wrapDoc(QUOTING);
      const file = await S.fresh('csv-click-through', DOC);
      await S.click(cell(2, 0));
      await S.click(cell(4, 1));
      await leave(S);
      const d = await diskSettled(S, file);
      return { ok: d === DOC, detail: show(d) };
    },
  },
  {
    id: 'data.csv-grid.e04',
    feature: 'data.csv-grid',
    name: 'Editing a cell in a row that has more fields than the header keeps the extra field in the file',
    run: async (S) => {
      const DOC = wrapDoc('```csv\na,b\n1,2,extra\n3,4\n```');
      const file = await S.fresh('csv-extra-field', DOC);
      await typeInCell(S, 0, 1, '9');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('1,2,extra', '1,9,extra'), detail: show(d) };
    },
  },
  {
    id: 'data.csv-grid.e05',
    feature: 'data.csv-grid',
    name: 'Editing a cell keeps a blank line written inside the block',
    run: async (S) => {
      const DOC = wrapDoc('```csv\na,b\n1,2\n\n3,4\n```');
      const file = await S.fresh('csv-blank-line', DOC);
      await typeInCell(S, 1, 1, '9');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('3,4', '3,9'), detail: show(d) };
    },
  },
  {
    id: 'data.csv-grid.e06',
    feature: 'data.csv-grid',
    name: 'A record of empty fields shows as a row, and survives an edit to the row below it',
    run: async (S) => {
      const DOC = wrapDoc('```csv\na,b\n1,2\n,\n3,4\n```');
      const file = await S.fresh('csv-empty-record', DOC);
      const g = (await grids(S))[0];
      await S.shot('csv-grid-e06-empty-record');
      // The last row is 3,4 wherever the grid puts it.
      const last = (g?.rows.length ?? 1) - 1;
      await typeInCell(S, last, 1, '9');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: g?.rows.length === 3 && d === DOC.replace('3,4', '3,9'), detail: `rows shown ${g?.rows.length} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-grid.e07',
    feature: 'data.csv-grid',
    name: 'Adding a row with Tab to a csv block inside a list item keeps the block indented under the item',
    run: async (S) => {
      const DOC = '- item\n\n  ```csv\n  a,b\n  1,2\n  ```\n\n- next item\n';
      const file = await S.fresh('csv-in-list', DOC);
      await S.command('View: Keep Editor');
      await S.dblclick(cell(0, 1));
      await S.press('Tab');
      await S.type('3');
      await S.press('Tab');
      await S.type('4');
      await S.press('Enter');
      await S.caret('next', 2);
      const d = await diskChange(S, file, DOC);
      await S.sleep(500);
      const g = (await grids(S))[0];
      await S.shot('csv-grid-e07-list');
      return { ok: d === '- item\n\n  ```csv\n  a,b\n  1,2\n  3,4\n  ```\n\n- next item\n', detail: `file ${show(d)} grid after ${j(g)}` };
    },
  },
  {
    id: 'data.csv-grid.e08',
    feature: 'data.csv-grid',
    name: 'In a CRLF file, editing one cell changes only that record and every line keeps CRLF',
    run: async (S) => {
      const LF = wrapDoc('```csv\na,b\n1,2\n3,4\n```');
      const DOC = LF.replace(/\n/g, '\r\n');
      const file = await S.fresh('csv-crlf', DOC);
      await typeInCell(S, 1, 0, '7');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('3,4', '7,4'), detail: show(d) };
    },
  },
  {
    id: 'data.csv-grid.e09',
    feature: 'data.csv-grid',
    name: 'In a file that starts with a byte order mark, editing a cell keeps the mark and changes only that record',
    run: async (S) => {
      const DOC = '﻿' + wrapDoc('```csv\na,b\n1,2\n```');
      const file = await S.fresh('csv-bom', DOC);
      await typeInCell(S, 0, 0, '5');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const bytes = readFileSync(file);
      return { ok: d === DOC.replace('1,2', '5,2') && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, detail: `first bytes ${[...bytes.subarray(0, 3)].join(',')} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-grid.e10',
    feature: 'data.csv-grid',
    name: 'A one-column block and a header-only block show as grids, an empty block stays a code block, and editing the one-column block changes one line',
    run: async (S) => {
      const DOC = 'Intro paragraph above.\n\n```csv\ncolor\nred\ngreen\n```\n\n```csv\nonly,header\n```\n\n```csv\n```\n\nOutro paragraph below.\n';
      const file = await S.fresh('csv-shapes', DOC);
      const g = await grids(S);
      await S.shot('csv-grid-e10-shapes');
      await typeInCell(S, 1, 0, 'teal');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const shapes = g.map((x) => [x.headers.length, x.rows.length]);
      return { ok: j(shapes) === j([[1, 2], [2, 0]]) && d === DOC.replace('red\ngreen', 'red\nteal'), detail: `grids ${j(shapes)} file ${show(d)}` };
    },
  },

  // ===== data.csv-quoting ===================================================
  {
    id: 'data.csv-quoting.e01',
    feature: 'data.csv-quoting',
    name: 'The quoting block shows every field as written, and editing qty on the doubled-quote row rewrites only that line',
    run: async (S) => {
      const DOC = wrapDoc(QUOTING);
      const file = await S.fresh('csv-quoting', DOC);
      const g = (await grids(S))[0];
      await S.shot('csv-quoting-e01');
      await typeInCell(S, 2, 2, '33');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const want = [['plain', 'no quoting needed', '1'], ['comma, inside', 'still one field', '2'], ['quote " inside', 'doubled quote escapes it', '3'], ['empty next', '', '4'], ['multi\nline', 'a field containing a newline', '5'], ['trailing spaces ', '  leading spaces', '6']];
      return { ok: j(g?.rows) === j(want) && d === DOC.replace('escapes it,3', 'escapes it,33'), detail: `grid ${j(g?.rows)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.e02',
    feature: 'data.csv-quoting',
    name: 'Double-clicking a cell with a line break and pressing Enter leaves the file unchanged (regression check)',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nname,notes\napple,"line one\nline two"\n```');
      const file = await S.fresh('csv-multiline-open', DOC);
      await S.dblclick(cell(0, 1));
      const opened = await S.eval(() => document.querySelector('.sheaf-table textarea')?.value ?? null);
      await S.press('Enter');
      await leave(S);
      const d = await diskSettled(S, file);
      return { ok: opened === 'line one\nline two' && d === DOC, detail: `editor held ${j(opened)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.e03',
    feature: 'data.csv-quoting',
    name: 'Typing a value with a comma and quotes into a cell writes it quoted with the quotes doubled',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nname,note\na,b\nc,d\n```');
      const file = await S.fresh('csv-type-quotes', DOC);
      await typeInCell(S, 0, 1, 'say "hi", ok');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('a,b', 'a,"say ""hi"", ok"'), detail: show(d) };
    },
  },
  {
    id: 'data.csv-quoting.e04',
    feature: 'data.csv-quoting',
    name: 'A field with a quote after a space shows its quotes and keeps them when another cell in the row is edited',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nx,y\nsays, "hi" there\n```');
      const file = await S.fresh('csv-quote-after-space', DOC);
      const shown = (await grids(S))[0]?.rows[0]?.[1];
      await typeInCell(S, 0, 0, 'EDIT');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      const row = d.split('\n').find((l) => l.startsWith('EDIT')) ?? '';
      return { ok: shown === ' "hi" there' && /"hi"|""hi""/.test(row), detail: `shown ${j(shown)} row ${j(row)}` };
    },
  },
  {
    id: 'data.csv-quoting.e05',
    feature: 'data.csv-quoting',
    name: 'An inch mark inside a csv field shows one row per line, and editing the last price changes only that price',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nitem,price\n27" monitor,300\n6" cable,5\nmouse,20\n```');
      const file = await S.fresh('csv-inch-mark', DOC);
      const g = (await grids(S))[0];
      await S.shot('csv-quoting-e05-inch');
      const last = (g?.rows.length ?? 1) - 1;
      await typeInCell(S, last, 1, '25');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: j(g?.rows) === j([['27" monitor', '300'], ['6" cable', '5'], ['mouse', '20']]) && d === DOC.replace('mouse,20', 'mouse,25'), detail: `grid ${j(g?.rows)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.e06',
    feature: 'data.csv-quoting',
    name: 'A tsv block with a literal quote in a cell shows one row per line',
    run: async (S) => {
      const DOC = wrapDoc('```tsv\nitem\tsize\nMonitor\t27" wide\nCable\t6" long\n```');
      await S.fresh('tsv-literal-quote', DOC);
      await S.click(cell(0, 0));
      const g = (await grids(S))[0];
      await S.shot('csv-quoting-e06-tsv-quote');
      return { ok: j(g?.rows) === j([['Monitor', '27" wide'], ['Cable', '6" long']]), detail: j(g?.rows) };
    },
  },
  {
    id: 'data.csv-quoting.e07',
    feature: 'data.csv-quoting',
    name: 'A trailing empty field and spaces around an untouched field survive an edit to the first cell of their row',
    run: async (S) => {
      const DOC = wrapDoc('```csv\na,b,c\n1, two ,\n```');
      const file = await S.fresh('csv-trailing-empty', DOC);
      const g = (await grids(S))[0];
      await typeInCell(S, 0, 0, '9');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: j(g?.rows) === j([['1', ' two ', '']]) && d === DOC.replace('1, two ,', '9, two ,'), detail: `grid ${j(g?.rows)} file ${show(d)}` };
    },
  },

  // ===== data.large-blocks ==================================================
  {
    id: 'data.large-blocks.e01',
    feature: 'data.large-blocks',
    name: 'The 2,000-row csv block opens as a grid within 3 s, a click selects a cell within 1 s, and an edit reaches the file as one changed line',
    run: async (S) => {
      const t0 = Date.now();
      const file = await S.open('stress/data-blocks.md');
      const before = readFileSync(file, 'utf8');
      let rows = 0;
      for (let i = 0; i < 100 && rows < 2000; i++) {
        rows = await S.eval(() => document.querySelector('.sheaf-table')?.querySelectorAll('tbody tr').length ?? 0);
        if (rows < 2000) await S.sleep(100);
      }
      // S.open spends 1.1 s in fixed waits of its own.
      const openMs = Date.now() - t0 - 1100;
      await S.shot('large-e01-open');
      const target = await S.locate(cell(0, 3));
      const t1 = Date.now();
      await S.page.mouse.click(target.x, target.y);
      let clickMs = null;
      for (let i = 0; i < 200; i++) {
        const on = await S.eval(() => document.querySelector('.sheaf-table [data-r="0"][data-c="3"]')?.classList.contains('is-focus'));
        if (on) {
          clickMs = Date.now() - t1;
          break;
        }
        await S.sleep(25);
      }
      await S.dblclick(cell(0, 3));
      await S.type('ops');
      await S.press('Enter');
      // Entering the grid scrolled the page; wheel back up to the paragraph above the block and click in it.
      await scrollTo(S, 'Structured data', { far: 4000, dir: -1 });
      await S.caret('Structured', 3);
      const t2 = Date.now();
      // Time to the first write, before S.disk's own wait for the file to go quiet.
      let writeMs = null;
      for (let i = 0; i < 150; i++) {
        if (readFileSync(file, 'utf8') !== before) {
          writeMs = Date.now() - t2;
          break;
        }
        await S.sleep(100);
      }
      const d = await S.disk(file);
      const a = before.split('\n');
      const b = d.split('\n');
      const changed = a.map((l, i) => (l !== b[i] ? i + 1 : 0)).filter(Boolean);
      const wantLine = a[8].split(',').map((v, i) => (i === 3 ? 'ops' : v)).join(',');
      const detail = `rows ${rows}, open ~${openMs} ms, click to selected ${clickMs} ms, leave to file ${writeMs} ms, lines changed ${j(changed)}, line 9 ${j(b[8])}`;
      return { ok: rows === 2000 && openMs <= 3000 && clickMs !== null && clickMs <= 1000 && writeMs <= 3000 && a.length === b.length && j(changed) === j([9]) && b[8] === wantLine, detail };
    },
  },
  {
    id: 'data.large-blocks.e02',
    feature: 'data.large-blocks',
    name: 'Wheeling past the 2,000-row block to the TSV below it and editing a TSV cell changes only that line',
    run: async (S) => {
      const file = await S.open('stress/data-blocks.md');
      const before = readFileSync(file, 'utf8');
      const reached = await scrollTo(S, 'Same grid, tab-delimited', { far: 6000 });
      await S.page.mouse.wheel(0, 150);
      await S.sleep(400);
      await S.shot('large-e02-tsv');
      const findTsv = () => S.eval(() => [...document.querySelectorAll('.sheaf-table')].findIndex((t) => t.querySelector('.sheaf-table-badge')?.textContent === 'TSV'));
      let tsvIndex = await findTsv();
      const waitStart = Date.now();
      for (let i = 0; i < 50 && tsvIndex < 0; i++) {
        await S.sleep(200);
        tsvIndex = await findTsv();
      }
      const waited = Date.now() - waitStart;
      const rawAfterWait = tsvIndex < 0 && (await S.rendered()).includes('```tsv');
      if (tsvIndex < 0) {
        // A person clicks into the text above the block; that moves the caret.
        await S.shot('large-e02-still-source');
        await S.caret('Same grid', 2);
        await S.sleep(600);
        tsvIndex = await findTsv();
        await S.shot('large-e02-after-click');
        if (tsvIndex < 0) {
          // Diagnostics from CodeMirror: how far the parser got, and where the TSV fence is.
          const diag = await S.eval(() => {
            const content = document.querySelector('.cm-content');
            const tile = content && (content.cmTile || content.cmView);
            const view = tile && ((tile.root && tile.root.view) || tile.view);
            if (!view) return { error: 'no view' };
            const docText = view.state.doc.toString();
            const lang = view.state.values.find((v) => v && typeof v === 'object' && v.context && typeof v.context.treeLen === 'number');
            // Table widgets held in editor state, whether or not the view drew them.
            const inState = [];
            for (const v of view.state.values) {
              if (!v || typeof v.iter !== 'function') continue;
              try {
                for (let it = v.iter(); it.value; it.next()) {
                  const w = it.value.spec && it.value.spec.widget;
                  if (w && (w.kind === 'csv' || w.kind === 'pipe')) inState.push(`${w.lang || 'pipe'}@${it.from}`);
                }
              } catch {}
            }
            return {
              docLength: docText.length,
              tsvFenceAt: docText.indexOf('```tsv'),
              treeLen: lang ? lang.context.treeLen : null,
              treeLength: lang && lang.tree ? lang.tree.length : null,
              viewport: [view.viewport.from, view.viewport.to],
              visibleRanges: view.visibleRanges.map((r) => [r.from, r.to]),
              caret: view.state.selection.main.head,
              gridsInState: inState,
              gridsInDom: document.querySelectorAll('.sheaf-table').length,
            };
          });
          return { ok: false, detail: `TSV block still source after scrolling (reached ${reached}), ${waited} ms and a click in the paragraph above; ${JSON.stringify(diag)}` };
        }
      }
      const gridNeededClick = rawAfterWait;
      // nth counts visible matches, so find this grid's cell among them.
      const nth = await S.eval((ti) => {
        const all = [...document.querySelectorAll('.sheaf-table [data-r="0"][data-c="3"]')];
        const want = document.querySelectorAll('.sheaf-table')[ti].querySelector('[data-r="0"][data-c="3"]');
        return all.filter((el) => el.getBoundingClientRect().width > 0).indexOf(want);
      }, tsvIndex);
      await typeInCell(S, 0, 3, '5000', nth);
      await S.caret('Same grid', 2);
      const d = await diskChange(S, file, before, 10000);
      const a = before.split('\n');
      const b = d.split('\n');
      const changed = a.map((l, i) => (l !== b[i] ? i + 1 : 0)).filter(Boolean);
      const idx = a.indexOf('SKU-2881\tephemeral ledger\tOffshore\t4075\t214\t25');
      return { ok: a.length === b.length && j(changed) === j([idx + 1]) && b[idx] === 'SKU-2881\tephemeral ledger\tOffshore\t5000\t214\t25', detail: `lines changed ${j(changed)} line ${j(b[idx])}` };
    },
  },

  // ===== images.render ======================================================
  {
    id: 'images.render.e01',
    feature: 'images.render',
    name: 'The plain Markdown images at the top of the images sample load and show, and hovering one shows its toolbar',
    run: async (S) => {
      await S.open('edge/images.md');
      const list = await waitImages(S, 4);
      await hoverImage(S, 1);
      const bar = await S.eval(() => getComputedStyle(document.querySelectorAll('.md-img-toolbar')[1]).opacity);
      await S.shot('render-e01-top');
      const want = ['dot', 'A ferry terminal at dawn', 'A loaf on a board'];
      const ok = want.every((a) => list.some((i) => i.alt === a && i.loaded && !i.broken));
      return { ok: ok && bar === '1', detail: `toolbar opacity ${bar}; images ${j(list.map((i) => [i.alt, i.loaded, i.broken]))}` };
    },
  },
  {
    id: 'images.render.e02',
    feature: 'images.render',
    name: 'Missing, remote and missing-SVG images show the "image not found" placeholder; the data URI and angle-bracket path load',
    run: async (S) => {
      await S.open('edge/images.md');
      await scrollTo(S, 'Broken and unusual sources');
      await S.sleep(1500);
      const list = await waitImages(S, 6, 8000);
      await S.shot('render-e02-broken');
      await S.click({ text: 'Missing file', offset: 2 });
      const by = (a) => list.find((i) => i.alt === a);
      const broken = ['This file does not exist', 'Also missing', 'Remote image', 'An SVG'].map((a) => [a, by(a)?.broken]);
      const loaded = ['Data URI', 'Spaces'].map((a) => [a, by(a)?.loaded]);
      return { ok: broken.every((x) => x[1] === true) && loaded.every((x) => x[1] === true), detail: `broken ${j(broken)} loaded ${j(loaded)}` };
    },
  },
  {
    id: 'images.render.e03',
    feature: 'images.render',
    name: 'Images with parentheses or spaces in the file name, an SVG and a 6000 px image all load; the huge one fits the page',
    run: async (S) => {
      const assets = join(S.ws, 'assets');
      copyFileSync(join(SAMPLE_ASSETS, 'dot.png'), join(assets, 'dot(1).png'));
      copyFileSync(join(SAMPLE_ASSETS, 'rye-loaf.png'), join(assets, 'rye loaf.png'));
      writeFileSync(join(assets, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#3a7"/></svg>');
      const huge = join(assets, 'huge.png');
      if (!existsSync(huge)) writeFileSync(huge, Buffer.from(await S.app.evaluate(({ nativeImage }, p) => nativeImage.createFromPath(p).resize({ width: 6000, height: 4000 }).toPNG().toString('base64'), join(SAMPLE_ASSETS, 'rye-loaf.png')), 'base64'));
      const DOC = 'Paren below.\n\n![Paren](../assets/dot(1).png)\n\nSpaces below.\n\n![Spaces](<../assets/rye loaf.png>)\n\nSVG below.\n\n![Logo](../assets/logo.svg)\n\nHuge below.\n\n![Huge](../assets/huge.png)\n\nEnd.\n';
      await S.fresh('render-names', DOC);
      await S.click({ text: 'Paren', offset: 2 });
      const list = await waitImages(S, 4, 8000);
      await S.shot('render-e03-names');
      const page = await S.eval(() => {
        const s = document.querySelector('.cm-scroller');
        const c = document.querySelector('.cm-content');
        return { scrollW: s.scrollWidth, clientW: s.clientWidth, contentW: Math.round(c.getBoundingClientRect().width) };
      });
      const by = (a) => list.find((i) => i.alt === a);
      const hugeFits = by('Huge') && by('Huge').loaded && by('Huge').width <= page.contentW && page.scrollW <= page.clientW + 1;
      const ok = ['Paren', 'Spaces', 'Logo'].every((a) => by(a)?.loaded) && hugeFits;
      return { ok, detail: `images ${j(list.map((i) => [i.alt, i.src, i.loaded, i.width]))} page ${j(page)}` };
    },
  },
  {
    id: 'images.render.e04',
    feature: 'images.render',
    name: 'The reference-style image in the images sample shows as a picture',
    run: async (S) => {
      await S.open('edge/images.md');
      await scrollTo(S, 'Reference-style');
      await S.click({ text: 'Reference-style', offset: 2 });
      await S.sleep(800);
      const list = await images(S);
      const text = await S.rendered();
      await S.shot('render-e04-reference');
      const shownAsText = text.includes('![Terminal at dawn][dawn]');
      return { ok: list.some((i) => i.alt === 'Terminal at dawn' && i.loaded), detail: `image widget ${list.some((i) => i.alt === 'Terminal at dawn')}, source shown as text ${shownAsText}` };
    },
  },
  {
    id: 'images.render.e05',
    feature: 'images.render',
    name: 'The centred image and the captioned figure, each written over several lines of HTML, show as pictures',
    run: async (S) => {
      await S.open('edge/images.md');
      await scrollTo(S, 'Sized and aligned');
      await S.click({ text: 'Sized and aligned', offset: 2 });
      await S.page.mouse.wheel(0, 200);
      await S.sleep(1200);
      const list = await images(S);
      const text = await S.rendered();
      await S.shot('render-e05-multiline-html');
      const centred = list.find((i) => i.alt === 'Centred, 400px');
      const figure = list.find((i) => i.alt === 'An editor showing an inline warning');
      return { ok: !!centred && /align-center/.test(centred.cls) && !!figure && figure.caption === 'A caption, which Markdown has no way to express.', detail: `centred ${j(centred)} figure ${j(figure)} raw html on screen ${text.includes('<p align="center">')}` };
    },
  },
  {
    id: 'images.render.e06',
    feature: 'images.render',
    name: 'Images in a list, a table cell, a quote and a heading all show as pictures',
    run: async (S) => {
      await S.open('edge/images.md');
      await scrollTo(S, 'Images in other containers');
      await S.click({ text: 'Images in other containers', offset: 2 });
      await S.page.mouse.wheel(0, 250);
      await S.sleep(1200);
      const list = await images(S);
      const g = await S.eval(() => {
        const t = document.querySelector('.sheaf-table');
        const c = t && t.querySelector('[data-r="0"][data-c="0"]');
        return c ? { html: c.innerHTML, hasImg: !!c.querySelector('img') } : null;
      });
      await S.shot('render-e06-containers');
      const alts = list.map((i) => i.alt);
      return { ok: ['Terminal'].every((a) => alts.includes(a)) && alts.filter((a) => a === 'dot').length >= 2 && g?.hasImg === true, detail: `alts ${j(alts)} table cell ${j(g)}` };
    },
  },
  {
    id: 'images.render.e07',
    feature: 'images.render',
    name: 'A 1600 px wide image scales to the page and nothing scrolls sideways; a tall image shows at full height',
    run: async (S) => {
      await S.open('edge/images.md');
      await scrollTo(S, 'Wider than any editor pane');
      await S.click({ text: 'Wider than any', offset: 2 });
      await S.sleep(1200);
      const list = await images(S);
      const page = await S.eval(() => {
        const s = document.querySelector('.cm-scroller');
        const c = document.querySelector('.cm-content');
        return { scrollW: s.scrollWidth, clientW: s.clientWidth, contentW: Math.round(c.getBoundingClientRect().width) };
      });
      await S.shot('render-e07-overflow');
      const wide = list.find((i) => i.alt === 'A very wide diagram');
      return { ok: !!wide && wide.loaded && wide.width <= page.contentW && page.scrollW <= page.clientW + 1, detail: `wide ${j(wide)} page ${j(page)}` };
    },
  },
  {
    id: 'images.render.e08',
    feature: 'images.render',
    name: 'Arrow Up from the last line steps one line at a time past four block images',
    run: async (S) => {
      const DOC = 'Top line of text\n\n![a](../assets/terminal-dawn.png)\n\n![b](../assets/rye-loaf.png)\n\n![c](../assets/watch-view.png)\n\n![d](../assets/terminal-dawn.png)\n\nLast line here\n';
      await S.fresh('render-caret-images', DOC);
      await S.command('View: Keep Editor');
      await waitImages(S, 4);
      await scrollTo(S, 'Last line here');
      await S.caret('Last', 2);
      const seen = [(await S.state()).line];
      for (let i = 0; i < 10; i++) {
        await S.press('ArrowUp');
        await S.sleep(150);
        seen.push((await S.state()).line);
      }
      const want = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      return { ok: j(seen) === j(want), detail: `lines ${j(seen)}` };
    },
  },

  // ===== images.resize-align-caption ========================================
  {
    id: 'images.resize-align-caption.e01',
    feature: 'images.resize-align-caption',
    name: 'Dragging the resize handle 200 px left writes that width into the file, and one Undo gives the file back byte-identical',
    run: async (S) => {
      const DOC = 'Before the picture.\n\n![Dawn](../assets/terminal-dawn.png)\n\nAfter the picture.\n';
      const file = await S.fresh('resize-drag', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      const start = (await images(S))[0].width;
      const h = await S.locate({ sel: '.md-img-handle' });
      await S.drag({ sel: '.md-img-handle' }, { x: h.x - 200, y: h.y });
      const d = await diskChange(S, file, DOC);
      await S.shot('resize-e01-dragged');
      const m = /^Before the picture\.\n\n<img src="\.\.\/assets\/terminal-dawn\.png" alt="Dawn" width="(\d+)">\n\nAfter the picture\.\n$/.exec(d);
      const width = m ? Number(m[1]) : null;
      await S.toolbar('Undo');
      const back = await diskChange(S, file, d);
      return { ok: width !== null && Math.abs(width - (start - 200)) <= 8 && back === DOC, detail: `start ${start}px, written ${width}, after drag ${show(d)} after undo ${show(back)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e02',
    feature: 'images.resize-align-caption',
    name: 'Width M on an HTML image writes width 420, and Width Full writes it back as Markdown',
    run: async (S) => {
      const DOC = 'Before.\n\n<img src="../assets/terminal-dawn.png" alt="Half width" width="320">\n\nAfter.\n';
      const file = await S.fresh('resize-presets', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Width: M');
      const m = await diskChange(S, file, DOC);
      await S.sleep(300);
      await hoverImage(S);
      await imageButton(S, 'Width: Full');
      const full = await diskChange(S, file, m);
      return { ok: m === DOC.replace('width="320"', 'width="420"') && full === 'Before.\n\n![Half width](../assets/terminal-dawn.png)\n\nAfter.\n', detail: `M ${show(m)} Full ${show(full)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e03',
    feature: 'images.resize-align-caption',
    name: 'Align center on an image already written as HTML centres it on screen and wraps only that image in a centred paragraph',
    run: async (S) => {
      const DOC = 'Before.\n\n<img src="../assets/terminal-dawn.png" alt="Half width" width="320">\n\nAfter.\n';
      const file = await S.fresh('align-center', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Align center');
      const d = await diskChange(S, file, DOC);
      await S.caret('After', 2);
      await S.sleep(500);
      const img = (await images(S))[0];
      const content = await S.eval(() => {
        const r = document.querySelector('.cm-content').getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width) };
      });
      await S.shot('align-e03-centred');
      const offCentre = img ? Math.abs(img.left + img.width / 2 - (content.left + content.width / 2)) : null;
      return { ok: d === DOC.replace('<img src="../assets/terminal-dawn.png" alt="Half width" width="320">', '<p align="center"><img src="../assets/terminal-dawn.png" alt="Half width" width="320"></p>') && offCentre !== null && offCentre < 30, detail: `file ${show(d)} image ${j(img)} content ${j(content)} off centre ${offCentre}px` };
    },
  },
  {
    id: 'images.resize-align-caption.e04',
    feature: 'images.resize-align-caption',
    name: 'Typing a caption with quotes and HTML writes it escaped and shows it exactly as typed',
    run: async (S) => {
      const DOC = 'Before.\n\n![Loaf](../assets/rye-loaf.png)\n\nAfter.\n';
      const file = await S.fresh('caption-escape', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Edit caption');
      const typed = 'Say "hi" & <b>bold</b>';
      await S.type(typed);
      await S.press('Enter');
      const d = await diskChange(S, file, DOC);
      await S.caret('After', 2);
      await S.sleep(500);
      const img = (await images(S))[0];
      await S.shot('caption-e04');
      return { ok: d === 'Before.\n\n<figure><img src="../assets/rye-loaf.png" alt="Loaf"><figcaption>Say &quot;hi&quot; &amp; &lt;b&gt;bold&lt;/b&gt;</figcaption></figure>\n\nAfter.\n' && img?.caption === typed, detail: `file ${show(d)} caption shown ${j(img?.caption)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e05',
    feature: 'images.resize-align-caption',
    name: 'Adding a caption to a centred image keeps it centred on screen and in the file',
    run: async (S) => {
      const DOC = 'Before.\n\n<p align="center"><img src="../assets/rye-loaf.png" alt="Loaf" width="300"></p>\n\nAfter.\n';
      const file = await S.fresh('caption-centred', DOC);
      await waitImages(S, 1);
      const was = (await images(S))[0];
      await hoverImage(S);
      await imageButton(S, 'Edit caption');
      await S.type('Cap');
      await S.press('Enter');
      const d = await diskChange(S, file, DOC);
      await S.caret('After', 2);
      await S.sleep(500);
      const now = (await images(S))[0];
      await S.shot('caption-e05-centred');
      return { ok: /align/.test(d) && d.includes('Cap') && /align-center/.test(now?.cls ?? ''), detail: `before ${j(was?.cls)} left ${was?.left}; after ${j(now?.cls)} left ${now?.left}; file ${show(d)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e06',
    feature: 'images.resize-align-caption',
    name: 'Width S on an image that has a title keeps the title in the file',
    run: async (S) => {
      const DOC = 'Before.\n\n![A loaf](../assets/rye-loaf.png "Seeded rye")\n\nAfter.\n';
      const file = await S.fresh('resize-title', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Width: S');
      const d = await diskChange(S, file, DOC);
      return { ok: d.includes('width="240"') && d.includes('Seeded rye'), detail: show(d) };
    },
  },
  {
    id: 'images.resize-align-caption.e07',
    feature: 'images.resize-align-caption',
    name: 'Alt text with square brackets keeps the image showing',
    run: async (S) => {
      const DOC = 'Before.\n\n![Loaf](../assets/rye-loaf.png)\n\nAfter.\n';
      const file = await S.fresh('alt-brackets', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Edit alt text');
      await S.press('Meta+a');
      await S.type('see [1]');
      await S.press('Enter');
      const d = await diskChange(S, file, DOC);
      await S.caret('After', 2);
      await S.sleep(600);
      const list = await images(S);
      const text = await S.rendered();
      await S.shot('alt-e07-brackets');
      return { ok: list.length === 1 && list[0].alt === 'see [1]', detail: `file ${show(d)} images ${j(list.map((i) => i.alt))} text ${j(text)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e08',
    feature: 'images.resize-align-caption',
    name: 'An image whose path has a space keeps showing after Width S then Width Full',
    run: async (S) => {
      copyFileSync(join(SAMPLE_ASSETS, 'rye-loaf.png'), join(S.ws, 'assets', 'rye loaf.png'));
      const DOC = 'Before.\n\n![Loaf](<../assets/rye loaf.png>)\n\nAfter.\n';
      const file = await S.fresh('resize-space-path', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Width: S');
      const small = await diskChange(S, file, DOC);
      await S.sleep(400);
      await hoverImage(S);
      await imageButton(S, 'Width: Full');
      const full = await diskChange(S, file, small);
      await S.caret('After', 2);
      await S.sleep(600);
      const list = await images(S);
      await S.shot('resize-e08-space-path');
      return { ok: list.length === 1 && list[0].loaded, detail: `S ${show(small)} Full ${show(full)} images ${j(list)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e09',
    feature: 'images.resize-align-caption',
    name: 'Width S on an image written with width and height does not leave the old height in the file',
    run: async (S) => {
      const DOC = 'Before.\n\n<img src="../assets/rye-loaf.png" alt="Loaf" width="280" height="160">\n\nAfter.\n';
      const file = await S.fresh('resize-height', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Width: S');
      const d = await diskChange(S, file, DOC);
      return { ok: d.includes('width="240"') && !d.includes('height="160"'), detail: show(d) };
    },
  },

  // ===== images.paste-drop ==================================================
  {
    id: 'images.paste-drop.e01',
    feature: 'images.paste-drop',
    name: 'Cmd+V with an image on the clipboard saves it in assets beside the document and links it on the next line',
    run: async (S) => {
      const DOC = 'Paste here\n\nAfter the image.\n';
      const file = await S.fresh('paste-one', DOC);
      await S.command('View: Keep Editor');
      const src = join(NOTES, 'clip-rye.png');
      copyFileSync(join(SAMPLE_ASSETS, 'rye-loaf.png'), src);
      await clipboardPng(S, src);
      await S.caret('here', 2);
      await S.press('End');
      const st = await S.state();
      if (!st.focused) return { ok: false, detail: `Sheaf did not have keyboard focus before Cmd+V (active ${j(st.active)})` };
      await S.press('Meta+v');
      const d = await diskChange(S, file, DOC);
      const found = links(d);
      const saved = found[0] ? join(dirname(file), found[0].path) : null;
      const size = saved && existsSync(saved) ? pngSize(saved) : null;
      await S.sleep(800);
      const list = await images(S);
      await S.shot('paste-e01');
      const want = found[0] ? `Paste here\n${found[0].line}\n\nAfter the image.\n` : null;
      return {
        ok: found.length === 1 && /^assets\/[^/\s()]+\.png$/.test(found[0].path) && size?.w === 560 && d === want,
        detail: `file ${show(d)} saved ${saved} exists ${!!size} size ${j(size)} rendered ${j(list.map((i) => [i.alt, i.loaded]))}`,
      };
    },
  },
  {
    id: 'images.paste-drop.e02',
    feature: 'images.paste-drop',
    name: 'Pasting the same image twice saves a second file instead of overwriting the first',
    run: async (S) => {
      const DOC = 'First paste\n\nSecond paste\n\nEnd.\n';
      const file = await S.fresh('paste-twice', DOC);
      await S.command('View: Keep Editor');
      const src = join(NOTES, 'clip-dawn.png');
      copyFileSync(join(SAMPLE_ASSETS, 'terminal-dawn.png'), src);
      await clipboardPng(S, src);
      await S.caret('First', 2);
      await S.press('End');
      await S.press('Meta+v');
      const one = await diskChange(S, file, DOC);
      const firstPath = links(one)[0] && join(dirname(file), links(one)[0].path);
      const firstBytes = firstPath && existsSync(firstPath) ? readFileSync(firstPath) : null;
      await S.caret('Second', 2);
      await S.press('End');
      const st = await S.state();
      await S.press('Meta+v');
      const two = await diskChange(S, file, one);
      const paths = links(two).map((l) => join(dirname(file), l.path));
      const distinct = new Set(paths).size === 2 && paths.every((p) => existsSync(p));
      const firstKept = firstBytes && firstPath && existsSync(firstPath) && readFileSync(firstPath).equals(firstBytes);
      return { ok: distinct && !!firstKept, detail: `focused before second paste ${st.focused}; links ${j(links(two).map((l) => l.path))}; first file unchanged ${!!firstKept}; file ${show(two)}` };
    },
  },
  {
    id: 'images.paste-drop.e03',
    feature: 'images.paste-drop',
    name: 'Dropping two image files at once (the drop is scripted) saves both beside the document and links each as valid Markdown',
    run: async (S) => {
      const DOC = 'Drop target\n\n\nAfter the drop.\n';
      const file = await S.fresh('drop-two', DOC);
      await S.hover({ text: 'target', offset: 2 });
      const files = [
        { name: 'My Photo (1).png', b64: readFileSync(join(SAMPLE_ASSETS, 'dot.png')).toString('base64') },
        { name: 'rye loaf.png', b64: readFileSync(join(SAMPLE_ASSETS, 'rye-loaf.png')).toString('base64') },
      ];
      await S.eval((list) => {
        const dt = new DataTransfer();
        for (const f of list) {
          const bin = atob(f.b64);
          const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          dt.items.add(new File([u], f.name, { type: 'image/png' }));
        }
        const line = document.querySelectorAll('.cm-content > .cm-line')[2];
        const r = line.getBoundingClientRect();
        const x = r.left + 20;
        const y = r.top + r.height / 2;
        const el = document.elementFromPoint(x, y);
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      }, files);
      // A drop scripted inside the frame leaves VS Code's webview cover up until the pointer
      // moves, which it always does after a real drop. Move it, or the frame reads as hidden.
      await S.page.mouse.move(300, 300);
      await S.page.mouse.move(700, 400);
      let d = await diskChange(S, file, DOC);
      for (let i = 0; i < 20 && links(d).length < 2; i++) d = await diskChange(S, file, d, 1000);
      const found = links(d);
      const saved = found.map((l) => join(dirname(file), l.path));
      const same = saved.map((p, i) => existsSync(p) && readFileSync(p).equals(Buffer.from(files[i].b64, 'base64')));
      await S.sleep(800);
      const list = await images(S);
      await S.shot('drop-e03');
      const want = found.length === 2 ? `Drop target\n\n${found[0].line}\n${found[1].line}\n\nAfter the drop.\n` : null;
      return {
        ok: found.length === 2 && same.every(Boolean) && found.every((l) => /^assets\/[^\s()<>]+$/.test(l.path)) && d === want && list.filter((i) => i.loaded).length === 2,
        detail: `file ${show(d)} saved ${j(saved.map((p) => p.slice(p.indexOf('/e2e/'))))} bytes match ${j(same)} rendered ${j(list.map((i) => [i.alt, i.loaded]))}`,
      };
    },
  },
  {
    id: 'images.paste-drop.e04',
    feature: 'images.paste-drop',
    name: 'When the image cannot be saved (a file named assets is in the way), pasting tells the person so',
    run: async (S) => {
      const dir = join(S.ws, 'e2e', 'blocked');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'assets'), 'not a folder\n');
      const DOC = 'Paste here\n\nAfter.\n';
      const file = join(dir, 'paste-blocked.md');
      writeFileSync(file, DOC);
      await S.sleep(300);
      await S.open('e2e/blocked/paste-blocked.md');
      await S.command('View: Keep Editor');
      const src = join(NOTES, 'clip-dot.png');
      copyFileSync(join(SAMPLE_ASSETS, 'watch-view.png'), src);
      await clipboardPng(S, src);
      await S.caret('here', 2);
      await S.press('End');
      const st = await S.state();
      await S.press('Meta+v');
      await S.sleep(2500);
      const d = await S.disk(file);
      const shown = await toasts(S);
      await S.shot('paste-e04-blocked', { clipToEditor: false });
      return { ok: d === DOC && shown.some((t) => /image|save|assets/i.test(t)), detail: `focused ${st.focused}; file ${show(d)}; notifications ${j(shown)}` };
    },
  },

  // ===== images.insert-picker ===============================================
  {
    id: 'images.insert-picker.e01',
    feature: 'images.insert-picker',
    name: 'Insert > Image opens a file picker; the chosen file is saved in assets beside the document and linked on the next line',
    run: async (S) => {
      const DOC = 'Intro text\n\nAfter\n';
      const file = await S.fresh('picker-insert', DOC);
      await S.command('View: Keep Editor');
      const pick = join(NOTES, 'Rye Loaf (2).png');
      copyFileSync(join(SAMPLE_ASSETS, 'rye-loaf.png'), pick);
      await S.caret('Intro', 2);
      await S.press('End');
      const chooser = S.page.waitForEvent('filechooser', { timeout: 6000 }).catch((e) => ({ error: String(e.message).split('\n')[0] }));
      await S.toolbar('Insert');
      await S.menu('Image');
      const fc = await chooser;
      if (!fc || fc.error) {
        await S.shot('picker-e01-no-chooser', { clipToEditor: false });
        await S.page.keyboard.press('Escape');
        return { ok: false, detail: `file chooser could not be intercepted in this Electron window: ${fc?.error}` };
      }
      await fc.setFiles([pick]);
      const d = await diskChange(S, file, DOC);
      const found = links(d);
      const saved = found[0] ? join(dirname(file), found[0].path) : null;
      const same = saved && existsSync(saved) && readFileSync(saved).equals(readFileSync(pick));
      await S.sleep(800);
      const list = await images(S);
      await S.shot('picker-e01');
      const want = found[0] ? `Intro text\n${found[0].line}\n\nAfter\n` : null;
      return { ok: found.length === 1 && !!same && /^assets\/[^\s()]+\.png$/.test(found[0].path) && d === want, detail: `multiple ${fc.isMultiple()} file ${show(d)} saved bytes match ${!!same} rendered ${j(list.map((i) => [i.alt, i.loaded]))}` };
    },
  },
  {
    id: 'images.insert-picker.e02',
    feature: 'images.insert-picker',
    name: 'Choosing nothing in the Insert > Image picker leaves the file unchanged',
    run: async (S) => {
      const DOC = 'Intro text\n\nAfter\n';
      const file = await S.fresh('picker-nothing', DOC);
      await S.caret('Intro', 2);
      const chooser = S.page.waitForEvent('filechooser', { timeout: 6000 }).catch((e) => ({ error: String(e.message).split('\n')[0] }));
      await S.toolbar('Insert');
      await S.menu('Image');
      const fc = await chooser;
      if (!fc || fc.error) {
        await S.page.keyboard.press('Escape');
        return { ok: false, detail: `file chooser could not be intercepted: ${fc?.error}` };
      }
      await fc.setFiles([]);
      const d = await diskSettled(S, file);
      const left = await S.eval(() => document.querySelectorAll('input[type=file]').length);
      return { ok: d === DOC, detail: `file ${show(d)} file inputs left in the page ${left}` };
    },
  },
  {
    id: 'images.insert-picker.e03',
    feature: 'images.insert-picker',
    name: 'Replace image file from the image toolbar swaps the picture and keeps its width',
    run: async (S) => {
      const DOC = 'Before.\n\n<img src="../assets/terminal-dawn.png" alt="Dawn" width="300">\n\nAfter.\n';
      const file = await S.fresh('picker-replace', DOC);
      const pick = join(NOTES, 'swap-e03.png');
      copyFileSync(join(SAMPLE_ASSETS, 'watch-view.png'), pick);
      await waitImages(S, 1);
      await hoverImage(S);
      const chooser = S.page.waitForEvent('filechooser', { timeout: 6000 }).catch((e) => ({ error: String(e.message).split('\n')[0] }));
      await imageButton(S, 'Replace image file');
      const fc = await chooser;
      if (!fc || fc.error) {
        await S.page.keyboard.press('Escape');
        return { ok: false, detail: `file chooser could not be intercepted: ${fc?.error}` };
      }
      await fc.setFiles([pick]);
      const d = await diskChange(S, file, DOC);
      const m = /<img src="([^"]+)" alt="Dawn" width="300">/.exec(d);
      const saved = m ? join(dirname(file), m[1]) : null;
      const same = saved && existsSync(saved) && readFileSync(saved).equals(readFileSync(pick));
      await S.sleep(800);
      const img = (await images(S))[0];
      return { ok: !!m && /^assets\/swap-e03(-\d+)?\.png$/.test(m[1]) && !!same && d === DOC.replace('../assets/terminal-dawn.png', m[1]) && img?.naturalWidth === 640, detail: `file ${show(d)} bytes match ${!!same} shown ${j(img)}` };
    },
  },

  // ===== Coverage added after the first runs ================================
  {
    id: 'data.csv-grid.e11',
    feature: 'data.csv-grid',
    name: 'A row with fewer fields than the header stays as written when another row is edited',
    run: async (S) => {
      const DOC = wrapDoc('```csv\na,b,c\n1,2\n3,4,5\n```');
      const file = await S.fresh('csv-fewer-fields', DOC);
      await typeInCell(S, 1, 1, '9');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('3,4,5', '3,9,5'), detail: show(d) };
    },
  },
  {
    id: 'data.csv-grid.e12',
    feature: 'data.csv-grid',
    name: 'A ~~~csv fence, an upper-case ```CSV fence and an unclosed fence at the end of the file all show as grids and keep their fences on edit',
    run: async (S) => {
      const DOC = 'Intro paragraph above.\n\n~~~csv\na,b\n1,2\n~~~\n\n```CSV\nc,d\n3,4\n```\n\nOutro paragraph below.\n\n```csv\ne,f\n5,6';
      const file = await S.fresh('csv-fences', DOC);
      const shown = (await grids(S)).map((g) => g.badge);
      await typeInCell(S, 0, 1, '9', 0);
      await typeInCell(S, 0, 1, '8', 1);
      await typeInCell(S, 0, 1, '7', 2);
      await S.caret('Outro', 2);
      const want = DOC.replace('1,2', '1,9').replace('3,4', '3,8').replace('5,6', '5,7');
      let d = await diskChange(S, file, DOC);
      for (let i = 0; i < 10 && d !== want; i++) d = await diskChange(S, file, d, 1000);
      return { ok: j(shown) === j(['CSV', 'CSV', 'CSV']) && d === want, detail: `badges ${j(shown)} file ${show(d)}` };
    },
  },
  {
    id: 'data.csv-quoting.e08',
    feature: 'data.csv-quoting',
    name: 'Typing two lines into a multi-line cell with Alt+Enter writes them quoted with the line break',
    run: async (S) => {
      const DOC = wrapDoc('```csv\nname,notes\napple,"line one\nline two"\n```');
      const file = await S.fresh('csv-multiline-type', DOC);
      await S.dblclick(cell(0, 1));
      await S.sleep(150);
      await S.type('first');
      await S.press('Alt+Enter');
      await S.type('second');
      await S.press('Enter');
      await leave(S);
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('"line one\nline two"', '"first\nsecond"'), detail: show(d) };
    },
  },
  {
    id: 'data.large-blocks.e03',
    feature: 'data.large-blocks',
    name: 'In a 2,000-row block, editing a cell and clicking Undo gives the file back byte-identical',
    run: async (S) => {
      const lines = ['id,region,owner,state'];
      for (let i = 1; i <= 2000; i++) lines.push(`${i},${['North', 'South', 'East', 'West'][i % 4]},docs,running`);
      const DOC = `Intro paragraph above.\n\n\`\`\`csv\n${lines.join('\n')}\n\`\`\`\n\nOutro paragraph below.\n`;
      const file = await S.fresh('large-undo', DOC);
      for (let i = 0; i < 50; i++) {
        if ((await S.eval(() => document.querySelector('.sheaf-table')?.querySelectorAll('tbody tr').length ?? 0)) >= 2000) break;
        await S.sleep(100);
      }
      await typeInCell(S, 0, 2, 'ops');
      await scrollTo(S, 'Intro paragraph', { far: 4000, dir: -1 });
      await S.caret('Intro', 2);
      const edited = await diskChange(S, file, DOC, 10000);
      await S.toolbar('Undo');
      const back = await diskChange(S, file, edited, 10000);
      return { ok: edited === DOC.replace('\n1,South,docs,running\n', '\n1,South,ops,running\n') && back === DOC, detail: `edited as expected ${edited === DOC.replace('\n1,South,docs,running\n', '\n1,South,ops,running\n')}, undo restores ${back === DOC}` };
    },
  },
  {
    id: 'images.render.e09',
    feature: 'images.render',
    name: 'Image markup inside a code fence stays text, and a file: URL image is not loaded',
    run: async (S) => {
      const DOC = 'Code below.\n\n```markdown\n![not rendered](../assets/terminal-dawn.png)\n<img src="../assets/dot.png" width="16">\n```\n\nFile URL below.\n\n![File](file:///tmp/a.png)\n\nEnd of file.\n';
      await S.fresh('render-code-file', DOC);
      await S.click({ text: 'End of', offset: 1 });
      await S.sleep(800);
      const list = await images(S);
      const text = await S.rendered();
      await S.shot('render-e09-code-file');
      return { ok: list.length === 0 && text.includes('![not rendered](../assets/terminal-dawn.png)'), detail: `images ${j(list)} text ${j(text)}` };
    },
  },
  {
    id: 'images.render.e10',
    feature: 'images.render',
    name: 'A selection across a block image rings the picture, and Edit Markdown shows the image source and puts it away again',
    run: async (S) => {
      // An image is drawn selected when a selection covers it, as a drag across it does; a click
      // alone does not select it. Edit Markdown is what shows a block's source. The ring is read
      // from the screenshot, against the same pixel with nothing selected.
      const DOC = 'Before.\n\n![Dawn](../assets/terminal-dawn.png)\n\nAfter.\n';
      const file = await S.fresh('render-select-image', DOC);
      await waitImages(S, 1);
      const figAt = () => S.eval(() => {
        const f = document.querySelector('.md-img-fig') ?? document.querySelector('img.md-img');
        const b = f.getBoundingClientRect();
        // Where the click on the start of "Before" lands, in the frame's coordinates, so the
        // window point S.click returns can be mapped back onto the screenshot.
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Before'));
        const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const t = walk.nextNode();
        const r = document.createRange();
        r.setStart(t, 0);
        r.setEnd(t, 1);
        const c = r.getBoundingClientRect();
        return { ring: { x: b.left - 3, y: b.top + b.height / 2 }, firstLine: { x: c.left + Math.min(1, c.width / 3), y: c.top + c.height / 2 } };
      });
      const p0 = await figAt();
      const anchor = await S.click({ text: 'Before', offset: 0 });
      const dx = anchor.x - p0.firstLine.x;
      const dy = anchor.y - p0.firstLine.y;
      await S.sleep(300);
      const plain = readPng(await S.shot('image-unselected', { clipToEditor: false }));
      await S.page.keyboard.down('Shift');
      await S.click({ text: 'After', offset: 6 });
      await S.page.keyboard.up('Shift');
      await S.sleep(400);
      const p1 = await figAt();
      const selected = await S.eval(() => !!document.querySelector('.md-img-wrap.is-selected'));
      const ringed = readPng(await S.shot('image-selected', { clipToEditor: false }));
      const before = plain.atCss(p0.ring.x + dx, p0.ring.y + dy);
      const after = ringed.atCss(p1.ring.x + dx, p1.ring.y + dy);
      await S.click({ text: 'After', offset: 2 });
      await S.sleep(300);
      const cleared = await S.eval(() => !document.querySelector('.md-img-wrap.is-selected'));
      await S.click({ sel: 'img.md-img' });
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const editing = { images: (await images(S)).length, source: (await S.rendered()).includes('![Dawn](../assets/terminal-dawn.png)') };
      await S.press('Meta+Alt+e');
      await S.sleep(500);
      const away = (await images(S)).length;
      const d = await diskSettled(S, file);
      const ring = selected && apart(before, after) > 40;
      return {
        ok: ring && cleared && editing.images === 0 && editing.source && away === 1 && d === DOC,
        detail: `ring pixel ${showColour(before)} -> ${showColour(after)} (selected ${selected}); ring gone after clicking away ${cleared}; with Edit Markdown ${j(editing)}; after putting it away images ${away}; file unchanged ${d === DOC}`,
      };
    },
  },
  {
    id: 'images.render.e11',
    feature: 'images.render',
    name: 'An image inside a sentence sits on the same line as the words around it',
    run: async (S) => {
      const DOC = 'Here is a dot ![dot](../assets/dot.png) mid-paragraph.\n\nNext paragraph.\n';
      await S.fresh('render-inline', DOC);
      await waitImages(S, 1);
      await S.click({ text: 'Next', offset: 2 });
      await S.sleep(400);
      const a = await S.locate({ text: 'Here', offset: 1 });
      const b = await S.locate({ text: 'mid-paragraph', offset: 1 });
      await S.shot('render-e11-inline');
      return { ok: Math.abs(a.y - b.y) < 6, detail: `"Here" at y ${Math.round(a.y)}, "mid-paragraph" at y ${Math.round(b.y)}` };
    },
  },
  {
    id: 'images.paste-drop.e06',
    feature: 'images.paste-drop',
    name: 'Cmd+V with both text and an image on the clipboard pastes the text and saves no image',
    run: async (S) => {
      const DOC = 'Paste here\n\nAfter.\n';
      const file = await S.fresh('paste-text-and-image', DOC);
      await S.command('View: Keep Editor');
      const src = join(NOTES, 'clip-both.png');
      copyFileSync(join(SAMPLE_ASSETS, 'dot.png'), src);
      await S.clipboard.writeImage(src, 'hello');
      const info = (await S.clipboard.formats()).join(', ');
      const assets = join(dirname(file), 'assets');
      const before = existsSync(assets) ? readdirSync(assets).length : 0;
      await S.caret('here', 2);
      await S.press('End');
      const st = await S.state();
      await S.press('Meta+v');
      const d = await diskChange(S, file, DOC);
      const after = existsSync(assets) ? readdirSync(assets).length : 0;
      return { ok: d === 'Paste herehello\n\nAfter.\n' && after === before, detail: `clipboard ${info}; focused ${st.focused}; file ${show(d)}; files in assets ${before} -> ${after}` };
    },
  },
  {
    id: 'images.paste-drop.e07',
    feature: 'images.paste-drop',
    name: 'Pasting an image with the caret mid-sentence puts the link on its own line and keeps every character',
    run: async (S) => {
      const DOC = 'Say hello world\n\nAfter.\n';
      const file = await S.fresh('paste-mid-sentence', DOC);
      await S.command('View: Keep Editor');
      const src = join(NOTES, 'clip-mid.png');
      copyFileSync(join(SAMPLE_ASSETS, 'dot.png'), src);
      await clipboardPng(S, src);
      await S.caret('world', 0);
      const st = await S.state();
      if (!st.focused) return { ok: false, detail: `Sheaf did not have keyboard focus before Cmd+V` };
      await S.press('Meta+v');
      const d = await diskChange(S, file, DOC);
      const found = links(d);
      const want = found[0] ? `Say hello \n${found[0].line}\nworld\n\nAfter.\n` : null;
      return { ok: found.length === 1 && existsSync(join(dirname(file), found[0].path)) && d === want, detail: `caret ${st.head}; file ${show(d)}` };
    },
  },
  {
    id: 'images.paste-drop.e08',
    feature: 'images.paste-drop',
    name: 'Dropping a text file (the drop is scripted) saves nothing in assets and adds no image link',
    run: async (S) => {
      const DOC = 'Drop target\n\n\nAfter the drop.\n';
      const file = await S.fresh('drop-text-file', DOC);
      await S.hover({ text: 'target', offset: 2 });
      const assets = join(dirname(file), 'assets');
      const before = existsSync(assets) ? readdirSync(assets) : [];
      await S.eval(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['hello notes'], 'notes.txt', { type: 'text/plain' }));
        const line = document.querySelectorAll('.cm-content > .cm-line')[2];
        const r = line.getBoundingClientRect();
        const x = r.left + 20;
        const y = r.top + r.height / 2;
        const el = document.elementFromPoint(x, y);
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      });
      // A scripted drop leaves VS Code's webview cover up until the pointer moves; move it so
      // the cover does not carry into the next scenario's frame lookup.
      await S.page.mouse.move(300, 300);
      await S.page.mouse.move(700, 400);
      const d = await diskSettled(S, file);
      const after = existsSync(assets) ? readdirSync(assets) : [];
      const added = after.filter((f) => !before.includes(f));
      return { ok: added.length === 0 && links(d).length === 0, detail: `new files in assets ${j(added)}; file ${show(d)}` };
    },
  },
  {
    id: 'images.insert-picker.e04',
    feature: 'images.insert-picker',
    name: 'Choosing two images and a text file in the picker links the two images in order and saves no text file',
    run: async (S) => {
      const DOC = 'Intro text\n\nAfter\n';
      const file = await S.fresh('picker-mixed', DOC);
      const one = join(NOTES, 'pick-one.png');
      const two = join(NOTES, 'pick-two.png');
      const txt = join(NOTES, 'pick-notes.txt');
      copyFileSync(join(SAMPLE_ASSETS, 'dot.png'), one);
      copyFileSync(join(SAMPLE_ASSETS, 'watch-view.png'), two);
      writeFileSync(txt, 'notes\n');
      // Caret at the start of "After", so the links go on their own lines above it.
      await S.caret('After', 0);
      const chooser = S.page.waitForEvent('filechooser', { timeout: 6000 }).catch((e) => ({ error: String(e.message).split('\n')[0] }));
      await S.toolbar('Insert');
      await S.menu('Image');
      const fc = await chooser;
      if (!fc || fc.error) {
        await S.page.keyboard.press('Escape');
        return { ok: false, detail: `file chooser could not be intercepted: ${fc?.error}` };
      }
      await fc.setFiles([one, txt, two]);
      let d = await diskChange(S, file, DOC);
      for (let i = 0; i < 10 && links(d).length < 2; i++) d = await diskChange(S, file, d, 1000);
      const found = links(d);
      const assets = readdirSync(join(dirname(file), 'assets'));
      const want = found.length === 2 ? `Intro text\n\n${found[0].line}\n${found[1].line}\nAfter\n` : null;
      return { ok: found.length === 2 && /pick-one/.test(found[0].path) && /pick-two/.test(found[1].path) && !assets.some((f) => /notes/.test(f)) && d === want, detail: `file ${show(d)} assets ${j(assets)}` };
    },
  },
  {
    id: 'images.resize-align-caption.e10',
    feature: 'images.resize-align-caption',
    name: 'Align left on an image written as HTML with align="right" changes only the align attribute',
    run: async (S) => {
      const DOC = 'Before.\n\n<img src="../assets/terminal-dawn.png" alt="Dawn" width="300" align="right">\n\nAfter.\n';
      const file = await S.fresh('align-left', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Align left');
      const d = await diskChange(S, file, DOC);
      return { ok: d === DOC.replace('align="right"', 'align="left"'), detail: show(d) };
    },
  },
  {
    id: 'images.resize-align-caption.e11',
    feature: 'images.resize-align-caption',
    name: 'Toolbar edits on an image in a sentence, an HTML image followed by text, and an image under a list item rewrite only that image',
    run: async (S) => {
      const DOC = 'Here is a dot ![dot](../assets/dot.png) mid-paragraph.\n\n<img src="../assets/dot.png" alt="Tiny" width="16"> sized inline, next to text.\n\n- Item:\n\n  ![T](../assets/terminal-dawn.png)\n\n- Last\n';
      const file = await S.fresh('toolbar-shapes', DOC);
      await waitImages(S, 3);
      await hoverImage(S, 0);
      await imageButton(S, 'Width: S', 0);
      let d = await diskChange(S, file, DOC);
      await S.sleep(400);
      await hoverImage(S, 1);
      await imageButton(S, 'Align right', 1);
      d = await diskChange(S, file, d);
      await S.sleep(400);
      await hoverImage(S, 2);
      await imageButton(S, 'Width: M', 2);
      d = await diskChange(S, file, d);
      const want = 'Here is a dot <img src="../assets/dot.png" alt="dot" width="240"> mid-paragraph.\n\n<img src="../assets/dot.png" alt="Tiny" width="16" align="right"> sized inline, next to text.\n\n- Item:\n\n  <img src="../assets/terminal-dawn.png" alt="T" width="420">\n\n- Last\n';
      return { ok: d === want, detail: show(d) };
    },
  },
  {
    id: 'images.resize-align-caption.e12',
    feature: 'images.resize-align-caption',
    name: 'Escape in the caption box changes nothing; clearing the caption writes the image back as Markdown',
    run: async (S) => {
      const DOC = 'Before.\n\n<figure><img src="../assets/rye-loaf.png" alt="Loaf"><figcaption>Cap</figcaption></figure>\n\nAfter.\n';
      const file = await S.fresh('caption-clear', DOC);
      await waitImages(S, 1);
      await hoverImage(S);
      await imageButton(S, 'Edit caption');
      await S.type('Changed');
      await S.press('Escape');
      const escaped = await diskSettled(S, file);
      await hoverImage(S);
      await imageButton(S, 'Edit caption');
      await S.press('Backspace');
      await S.press('Enter');
      const cleared = await diskChange(S, file, DOC);
      return { ok: escaped === DOC && cleared === 'Before.\n\n![Loaf](../assets/rye-loaf.png)\n\nAfter.\n', detail: `after Escape ${show(escaped)} after clearing ${show(cleared)}` };
    },
  },

  // Last, because it leaves an untitled editor that has to be reverted.
  {
    id: 'images.paste-drop.e05',
    feature: 'images.paste-drop',
    name: 'Pasting an image into a new document that has never been saved either links it or says to save first',
    run: async (S) => {
      await S.command('File: New Untitled Text File');
      await S.sleep(800);
      await S.page.keyboard.type('Draft note');
      await S.command('Sheaf: Open in Sheaf');
      let opened = true;
      try {
        await S.frame();
      } catch {
        opened = false;
      }
      if (!opened) {
        await S.shot('paste-e05-untitled', { clipToEditor: false });
        await S.command('File: Revert File');
        return { ok: false, detail: 'an untitled document could not be opened in Sheaf, so the case cannot be reached' };
      }
      const src = join(NOTES, 'clip-watch.png');
      copyFileSync(join(SAMPLE_ASSETS, 'watch-view.png'), src);
      await clipboardPng(S, src);
      await S.caret('Draft', 2);
      await S.press('End');
      const st = await S.state();
      await S.press('Meta+v');
      await S.sleep(3000);
      const after = await S.state();
      const shown = await toasts(S);
      await S.shot('paste-e05-untitled', { clipToEditor: false });
      await S.command('File: Revert File');
      const linked = /!\[[^\]]*\]\([^)]+\)/.test(after.doc ?? '');
      return { ok: linked || shown.some((t) => /save|image/i.test(t)), detail: `focused ${st.focused}; document ${j(after.doc)}; notifications ${j(shown)}` };
    },
  },
];
