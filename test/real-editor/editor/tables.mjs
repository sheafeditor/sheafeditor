// E2E scenarios for editing inside a table grid, driven by mouse and keyboard in real VS Code.
// Every scenario clicks; every edit is judged by the whole file on disk.
import { show } from '../session.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INTRO = 'Intro line here\n\n';
const OUTRO = '\n\nAfter line\n';
const T0 = '| Fruit | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |';
const T = INTRO + T0 + OUTRO;
const N0 = '| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n| 10 | 11 | 12 |';
const N = INTRO + N0 + OUTRO;
const SMALL = INTRO + '| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |' + OUTRO;

const cell = (r, c, t = 0) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]`, nth: t });
/** A cell of the grid whose cell ids start with `gid` (from tableId), for documents holding tables of different widths. */
const cellOf = (gid, r, c) => ({ sel: `#${gid}-r${r + 1}-c${c}` });
const gutter = (r) => ({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: r });

/**
 * Give the workbench the keyboard, then open a new file in Sheaf. Quick Open does not
 * open while a Sheaf webview holds the keyboard after some keys, which would fail
 * every later scenario, so the status bar is clicked first.
 */
async function open(S, name, text) {
  await reset(S);
  const path = await S.fresh(name, text);
  await S.sleep(300);
  return path;
}

/** Open a sample file the same way, from a window with no other editor open. */
async function openSample(S, rel) {
  await reset(S);
  const path = await S.open(rel);
  await S.sleep(300);
  return path;
}

/**
 * Close every editor so exactly one Sheaf webview exists: with several open, the
 * session's frame lookup can read a hidden one. The runner's own cleanup goes through
 * the Command Palette and silently does nothing when a Sheaf webview kept the keyboard.
 */
async function reset(S) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sb = await S.page.locator('.statusbar').boundingBox().catch(() => null);
    if (sb) await S.page.mouse.click(sb.x + 10, sb.y + sb.height / 2);
    await S.page.keyboard.press('Escape');
    const webviews = await S.page.evaluate(() => document.querySelectorAll('iframe.webview').length);
    if (webviews === 0) return;
    // A tab with unsaved changes makes Close All raise a native save dialog Playwright cannot answer: revert it first.
    if (await S.page.evaluate(() => !!document.querySelector('.tabs-container .tab.dirty')).catch(() => false)) {
      console.log('     note: the previous scenario left a tab with unsaved changes; reverting it before closing');
      await S.command('File: Revert File').catch(() => {});
      await S.sleep(600);
    }
    await S.command('View: Close All Editors').catch(() => {});
    await S.sleep(600);
    const dialog = S.page.locator('.monaco-dialog-box');
    if (await dialog.isVisible().catch(() => false)) {
      // A save prompt means the previous scenario left a document with unsaved changes; say so, then discard.
      const text = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      console.log(`     note: closing editors asked: ${text}`);
      const dontSave = dialog.locator('.monaco-button', { hasText: "Don't Save" }).first();
      if (await dontSave.isVisible().catch(() => false)) await dontSave.click();
      else await S.page.keyboard.press('Escape');
      await S.sleep(600);
    }
  }
  const left = await S.page.evaluate(() => document.querySelectorAll('iframe.webview').length);
  if (left) throw new Error(`HARNESS: ${left} webviews still open after closing all editors`);
}

/** Click inside a word of the last paragraph, so focus leaves the table the way a person leaves it. */
const clickOut = (S) => S.caret('After', 2);

/** The notifications VS Code has on screen, as a person reads them. */
const toasts = (S) =>
  S.page.$$eval('.notifications-toasts .notification-list-item-message', (els) => els.map((e) => e.textContent.trim()));

/** True when one of the notices names `text` as what a write from outside took. */
const saidItTook = (said, text) => said.some((t) => t.includes(`your last change is gone: "${text}"`));

/**
 * A tool writing the whole file from text it read before the person's last edit, once
 * that edit has reached disk. Written any sooner, the file is newer than the document,
 * VS Code refuses Sheaf's save, and the editor never takes the write at all.
 */
async function staleWrite(S, path, text, until) {
  await S.disk(path);
  writeFileSync(path, text);
  for (let i = 0; i < 120; i++) {
    const st = await S.state().catch(() => null);
    if (st && typeof st.doc === 'string' && st.doc.includes(until)) {
      await S.sleep(300); // The notice goes up a moment after the document arrives.
      return toasts(S);
    }
    await S.sleep(50);
  }
  throw new Error(`the write from outside never reached the editor (waiting for ${JSON.stringify(until)})`);
}

/** Double-click a cell, replace its value by typing, and press a key (Enter by default). */
async function typeInto(S, target, value, finish = 'Enter') {
  await S.dblclick(target);
  await S.page.keyboard.press('Meta+a');
  if (value) await S.type(value);
  else await S.press('Backspace');
  if (finish) await S.press(finish);
}

/** What the grid reports: active cell, selected cell count, focus owner, cell editor. */
const grid = (S) =>
  S.eval(() => {
    const f = document.querySelector('.sheaf-table .is-focus');
    const a = document.activeElement;
    return {
      focus: f ? `${f.dataset.r},${f.dataset.c}` : null,
      sel: document.querySelectorAll('.sheaf-table .is-sel').length,
      inGrid: !!a && a.classList.contains('sheaf-table-grid'),
      gridIndex: [...document.querySelectorAll('.sheaf-table-grid')].indexOf(a),
      // An open Markdown cell is an editor, not a text box, so its text comes from the editor's
      // document; a CSV field still has a value. Null when no cell is open.
      input: (() => {
        const el = document.querySelector('.sheaf-table-input');
        if (!el) return null;
        if ('value' in el) return el.value;
        const content = el.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        return (tile?.root?.view ?? tile?.view)?.state.doc.toString() ?? null;
      })(),
    };
  });
const cellText = (S, r, c, t = 0) => S.eval(([r, c, t]) => document.querySelectorAll(`.sheaf-table [data-r="${r}"][data-c="${c}"]`)[t]?.textContent ?? null, [r, c, t]);
const setClipboard = (S, text) => S.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
const readClipboard = (S) => S.app.evaluate(({ clipboard }) => clipboard.readText());
const res = (ok, detail) => ({ ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
/** A CDP session on the window, for touch and input-method events Playwright has no call for. */
const cdpOf = async (S) => S.page.context().newCDPSession(S.page);

/**
 * The editor draws only the tables near the viewport, so a table's position among the
 * tables on screen depends on scrolling. Scroll from the top until the table whose grid
 * is named `label` is drawn, centre it, and return its index for `cell(r, c, index)`.
 */
/** How far the document is scrolled, summed over every scrolling ancestor of the editor content. */
const scrolled = (S, axis = 'top') =>
  S.eval((axis) => {
    let n = 0;
    for (let el = document.querySelector('.cm-content'); el; el = el.parentElement) n += axis === 'top' ? el.scrollTop : el.scrollLeft;
    const se = document.scrollingElement;
    return n + (se ? (axis === 'top' ? se.scrollTop : se.scrollLeft) : 0) + (axis === 'top' ? window.scrollY : window.scrollX);
  }, axis);

/** Turn the mouse wheel over the text column, as a person scrolls the document. */
async function wheel(S, dy) {
  const box = await S.locate({ sel: '#toolbar' });
  await S.page.mouse.move(box.x, box.y + 300);
  await S.page.mouse.wheel(0, dy);
  await S.sleep(350);
}

async function tableIndex(S, label) {
  await wheel(S, -200000);
  const find = (l) => S.eval((l) => [...document.querySelectorAll('.sheaf-table-grid')].findIndex((x) => x.getAttribute('aria-label') === l), l);
  for (let k = 0; k < 80; k++) {
    if ((await find(label)) >= 0) {
      await S.eval((l) => [...document.querySelectorAll('.sheaf-table-grid')].find((x) => x.getAttribute('aria-label') === l).scrollIntoView({ block: 'center' }), label);
      await S.sleep(400);
      const i = await find(label);
      if (i >= 0) return i;
    }
    const before = await scrolled(S);
    await wheel(S, 500);
    if ((await scrolled(S)) === before) break;
  }
  throw new Error(`no table named ${label} in the document`);
}

/** Scroll the table named `label` into view and return the prefix of its cell ids, for cellOf. */
async function tableId(S, label) {
  const i = await tableIndex(S, label);
  return S.eval((i) => document.querySelectorAll('.sheaf-table-grid')[i].querySelector('[data-r]').id.replace(/-r\d+-c\d+$/, ''), i);
}

/** Scroll through the whole document with the wheel and return every table's grid name and first body row. */
async function collectTables(S) {
  const seen = {};
  await wheel(S, -200000);
  for (let k = 0; k < 120; k++) {
    const tables = await S.eval(() => [...document.querySelectorAll('.sheaf-table-grid')].map((g) => [g.getAttribute('aria-label'), [...g.querySelectorAll('[data-r="0"]')].map((c) => c.textContent)]));
    for (const [label, row] of tables) seen[label] = row;
    const before = await scrolled(S);
    await wheel(S, 500);
    if ((await scrolled(S)) === before) {
      const last = await S.eval(() => [...document.querySelectorAll('.sheaf-table-grid')].map((g) => [g.getAttribute('aria-label'), [...g.querySelectorAll('[data-r="0"]')].map((c) => c.textContent)]));
      for (const [label, row] of last) seen[label] = row;
      break;
    }
  }
  return seen;
}

export const scenarios = [
  // ---------------------------------------------------------------- tables.grid
  {
    id: 'tables.grid.e01',
    feature: 'tables.grid',
    name: 'Opening sample/tables.md shows every pipe table and data block as a grid, and hovering one shows its controls',
    run: async (S) => {
      await openSample(S,'tables.md');
      const path = join(S.ws, 'tables.md');
      const before = readFileSync(path, 'utf8');
      const labels = Object.keys(await collectTables(S));
      const gid = await tableId(S, 'Table: Key, Value');
      await S.hover(cellOf(gid, 0, 1));
      const controls = await S.eval((gid) => getComputedStyle(document.getElementById(`${gid}-r1-c0`).closest('.sheaf-table').querySelector('.sheaf-table-controls')).opacity, gid);
      await S.shot('grid-e01-tables-sample');
      await S.click(cellOf(gid, 0, 0));
      await S.caret('Alignment', 3);
      const after = await S.disk(path);
      return res(labels.length === 13 && controls === '1' && after === before, { labels, controls, unchanged: after === before });
    },
  },
  {
    id: 'tables.grid.e02',
    feature: 'tables.grid',
    name: 'A first-line table, a 1x1 table, a table without outer pipes and a header-only table all render, and clicking through them writes nothing',
    run: async (S) => {
      const doc = T0 + '\n\n| a |\n| - |\n| b |\n\nx | y\n--|--\n1 | 2\n\n| H1 | H2 |\n| -- | -- |' + OUTRO;
      const path = await open(S, 'grid-shapes', doc);
      const info = await S.eval(() => [...document.querySelectorAll('.sheaf-table')].map((t) => [...t.querySelectorAll('[data-r]')].map((c) => c.textContent).join(',')));
      for (let t = 0; t < 3; t++) await S.click(cell(0, 0, t));
      // The 1x1 table has no second column, so the header-only table's second header is the third one on screen.
      await S.click(cell(-1, 1, 2));
      await S.shot('grid-e02-shapes');
      await clickOut(S);
      const d = await S.disk(path);
      const want = ['Fruit,Qty,apple,3,kiwi,12', 'a,b', 'x,y,1,2', 'H1,H2'];
      return res(JSON.stringify(info) === JSON.stringify(want) && d === doc, { info, unchanged: d === doc });
    },
  },
  {
    id: 'tables.grid.e03',
    feature: 'tables.grid',
    name: 'A table too wide for the page scrolls inside its own frame under the mouse wheel, and the page does not',
    run: async (S) => {
      const cols = Array.from({ length: 24 }, (_, i) => `Column number ${i + 1}`);
      const doc = INTRO + `| ${cols.join(' | ')} |\n|${cols.map(() => ' --- ').join('|')}|\n| ${cols.map((_, i) => `value ${i + 1}`).join(' | ')} |` + OUTRO;
      await open(S, 'grid-wide', doc);
      await S.hover(cell(0, 1));
      const pageBefore = await scrolled(S, 'left');
      await S.page.mouse.wheel(600, 0);
      await S.sleep(500);
      const m = await S.eval(() => {
        const g = document.querySelector('.sheaf-table-grid');
        return { gridScroll: g.scrollLeft, gridWider: g.scrollWidth > g.clientWidth };
      });
      m.pageScroll = (await scrolled(S, 'left')) - pageBefore;
      await S.shot('grid-e03-wide');
      return res(m.gridWider && m.gridScroll > 0 && m.pageScroll === 0, m);
    },
  },
  {
    id: 'tables.grid.e04',
    feature: 'tables.grid',
    name: 'CJK, Korean and emoji tables in the i18n sample show their cells exactly as the file has them',
    run: async (S) => {
      await openSample(S,'edge/unicode-and-i18n.md');
      const texts = await collectTables(S);
      const gid = await tableId(S, 'Table: 名前, 部署, 状態, 備考');
      await S.hover(cellOf(gid, 0, 0));
      await S.shot('grid-e04-unicode');
      const flat = JSON.stringify(texts);
      return res(flat.includes('"田中","運行管理","稼働","通常運転"') && flat.includes('"승객 수","10,480","명"') && flat.includes('"🚢","ship","4"'), texts);
    },
  },

  // ----------------------------------------------------------- tables.cell-edit
  {
    id: 'tables.cell-edit.e01',
    feature: 'tables.cell-edit',
    name: 'Double-click a cell, type a new value, Enter, click into the text: only that line changes',
    run: async (S) => {
      const path = await open(S, 'edit-basic', T);
      await typeInto(S, cell(0, 0), 'pear');
      const g = await grid(S);
      await clickOut(S);
      const d = await S.disk(path);
      return res(g.focus === '1,0' && d === T.replace('| apple |', '| pear  |'), { g, d: show(d) });
    },
  },
  {
    id: 'tables.cell-edit.e13',
    feature: 'tables.cell-edit',
    name: 'Committing a cell edit leaves the rest of the document on screen',
    run: async (S) => {
      // A cell edits in an editor of its own now. This is the check that closing one gives the
      // document back: every other cell-edit scenario clicks into the prose afterwards, so a
      // document that stopped rendering would show up as a click that cannot find its text.
      const path = await open(S, 'edit-still-there', T);
      const before = await S.rendered();
      await typeInto(S, cell(0, 0), 'pear');
      await S.sleep(500);
      const after = await S.rendered();
      const d = await S.disk(path);
      // The table is a widget, so its cells are not in the rendered lines: what this asks is that
      // the prose around it is still there, and that the edit went into the file rather than over it.
      return res(after.includes('After line') && after.includes('Intro line here') && d === T.replace('| apple |', '| pear  |'), {
        before: show(before.split('\n').slice(0, 3)),
        after: show(after.split('\n').slice(0, 8)),
        d: show(d),
      });
    },
  },
  {
    id: 'tables.cell-edit.e02',
    feature: 'tables.cell-edit',
    name: 'Click a cell, type to replace it, Tab, type into the next cell: both land in the file',
    run: async (S) => {
      const path = await open(S, 'edit-tab', T);
      await S.click(cell(0, 0));
      await S.type('plum');
      await S.press('Tab');
      await S.type('9');
      await S.press('Enter');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === T.replace('| apple | 3   |', '| plum  | 9   |'), show(d));
    },
  },
  {
    id: 'tables.cell-edit.e03',
    feature: 'tables.cell-edit',
    name: 'Typing in a cell and pressing Escape puts the old value back and leaves the file alone',
    run: async (S) => {
      const path = await open(S, 'edit-escape', T);
      await typeInto(S, cell(1, 0), 'junk', 'Escape');
      const shown = await cellText(S, 1, 0);
      await clickOut(S);
      const d = await S.disk(path);
      return res(shown === 'kiwi' && d === T, { shown, d: show(d) });
    },
  },
  {
    id: 'tables.cell-edit.e04',
    feature: 'tables.cell-edit',
    name: 'Tab past the last cell without typing writes nothing; typing into the new row adds one line',
    run: async (S) => {
      const path = await open(S, 'edit-tab-past', T);
      await S.click(cell(1, 1));
      await S.press('Tab Tab Tab');
      await clickOut(S);
      const first = await S.disk(path);
      await S.click(cell(1, 1));
      await S.press('Tab');
      await S.type('x');
      await S.press('Enter');
      await clickOut(S);
      const second = await S.disk(path);
      return res(first === T && second === T.replace('| kiwi  | 12  |', '| kiwi  | 12  |\n| x     |     |'), { first: show(first), second: show(second) });
    },
  },
  {
    id: 'tables.cell-edit.e05',
    feature: 'tables.cell-edit',
    name: 'Clicking another cell while typing keeps what was typed',
    run: async (S) => {
      const path = await open(S, 'edit-click-away', T);
      await typeInto(S, cell(0, 0), 'plum', null);
      await S.click(cell(1, 1));
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === T.replace('| apple |', '| plum  |'), show(d));
    },
  },
  {
    id: 'tables.cell-edit.e06',
    feature: 'tables.cell-edit',
    name: 'A single click selects a cell without opening it; a double-click opens it with the value selected',
    run: async (S) => {
      await open(S, 'edit-click-vs-dbl', T);
      await S.click(cell(0, 0));
      const one = await grid(S);
      await S.dblclick(cell(0, 0));
      const two = await S.eval(() => {
        const i = document.querySelector('.sheaf-table-input');
        if (!i) return null;
        if ('value' in i) {
          return { value: i.value, all: i.selectionStart === 0 && i.selectionEnd === i.value.length, focused: document.activeElement === i };
        }
        // A Markdown cell: the whole value selected is the nested editor's own selection, and focus
        // sits on its content element rather than on the cell.
        const content = i.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile?.root?.view ?? tile?.view ?? null;
        const sel = view?.state.selection.main;
        return {
          value: view ? view.state.doc.toString() : null,
          all: !!sel && sel.from === 0 && sel.to === view.state.doc.length,
          focused: !!view && (view.hasFocus || i.contains(document.activeElement)),
        };
      });
      await S.shot('cell-edit-e06-open');
      return res(one.input === null && one.focus === '0,0' && two?.value === 'apple' && two.all && two.focused, { one, two });
    },
  },
  {
    id: 'tables.cell-edit.e07',
    feature: 'tables.cell-edit',
    name: 'After typing in a cell and pressing Enter, Cmd+S saves the edit to the file while the table still has focus',
    run: async (S) => {
      const path = await open(S, 'edit-save', T);
      await typeInto(S, cell(0, 0), 'pear');
      await S.sleep(2000);
      const beforeSave = await S.disk(path);
      await S.page.keyboard.press('Meta+s');
      await S.sleep(1500);
      const afterSave = await S.disk(path);
      return res(afterSave === T.replace('| apple |', '| pear  |'), { beforeSave: beforeSave.includes('pear'), afterSave: show(afterSave) });
    },
  },
  {
    id: 'tables.cell-edit.e12',
    feature: 'tables.cell-edit',
    name: 'After typing in a cell and pressing Enter, closing the tab with its close button keeps the edit in the file',
    run: async (S) => {
      const path = await open(S, 'edit-close-tab', T);
      await typeInto(S, cell(0, 0), 'pear');
      await S.sleep(1000);
      const tab = S.page.locator('.tabs-container .tab', { hasText: 'edit-close-tab.md' }).first();
      await tab.hover();
      await tab.locator('.codicon-close, .action-label').first().click();
      await S.sleep(1500);
      const dialog = await S.page.locator('.monaco-dialog-box').isVisible().catch(() => false);
      if (dialog) await S.page.keyboard.press('Escape');
      const d = await S.disk(path);
      return res(d === T.replace('| apple |', '| pear  |'), { dialog, d: show(d) });
    },
  },
  {
    id: 'tables.cell-edit.e08',
    feature: 'tables.cell-edit',
    name: 'In a CRLF file, a cell edit changes only that row and every line keeps CRLF',
    run: async (S) => {
      const crlf = T.replace(/\n/g, '\r\n');
      const path = await open(S, 'edit-crlf', crlf);
      await typeInto(S, cell(1, 1), '13');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === crlf.replace('| 12  |', '| 13  |'), show(d));
    },
  },
  {
    id: 'tables.cell-edit.e09',
    feature: 'tables.cell-edit',
    name: 'A typed pipe shows as a pipe in the grid and is written escaped once',
    run: async (S) => {
      const path = await open(S, 'edit-pipe', T);
      await typeInto(S, cell(0, 0), 'a|b');
      await clickOut(S);
      const d = await S.disk(path);
      const shown = await cellText(S, 0, 0);
      return res(d === T.replace('| apple |', '| a\\|b  |') && shown === 'a|b', { shown, d: show(d) });
    },
  },
  {
    id: 'tables.cell-edit.e10',
    feature: 'tables.cell-edit',
    name: 'A cell typed into, and the file then written above the table from text read before it: the notice names the cell and Undo brings it back',
    run: async (S) => {
      const path = await open(S, 'edit-outside', T);
      await typeInto(S, cell(0, 0), 'pears');
      const said = await staleWrite(S, path, T.replace('Intro line here', 'Intro line changed'), 'Intro line changed');
      const gone = (await S.state()).doc;
      await clickOut(S);
      await S.press('Meta+z');
      await S.sleep(800);
      const d = await S.disk(path);
      return res(
        !gone.includes('| pears |') && saidItTook(said, 'pears') && d === T.replace('| apple |', '| pears |'),
        { said, gone: show(gone), d: show(d) }
      );
    },
  },
  {
    id: 'tables.cell-edit.e12',
    feature: 'tables.cell-edit',
    name: 'The same, with another cell left open when the write lands: Cmd+Z in that cell still brings the typing back',
    run: async (S) => {
      const path = await open(S, 'edit-outside-open', T);
      await typeInto(S, cell(0, 0), 'pears');
      // A cell open and untouched, holding the keyboard, when the write arrives.
      await S.dblclick(cell(1, 1));
      const said = await staleWrite(S, path, T.replace('Intro line here', 'Intro line changed'), 'Intro line changed');
      const gone = (await S.state()).doc;
      await S.press('Meta+z');
      await S.sleep(800);
      await clickOut(S);
      await S.sleep(800);
      const d = await S.disk(path);
      return res(
        !gone.includes('| pears |') && saidItTook(said, 'pears') && d === T.replace('| apple |', '| pears |'),
        { said, gone: show(gone), d: show(d) }
      );
    },
  },
  {
    id: 'tables.keys.e01',
    feature: 'tables.keys',
    name: 'Cmd+Alt+= on a row picked by its number adds a row below it, and Cmd+Alt+- on a column picked by its header deletes it',
    run: async (S) => {
      const path = await open(S, 'row-col-keys', T);
      await S.click(gutter(0));
      await S.sleep(300);
      await S.press('Meta+Alt+Equal');
      await S.sleep(600);
      const added = await S.disk(path);
      await S.click(cell(-1, 1));
      await S.sleep(300);
      await S.press('Meta+Alt+Minus');
      await S.sleep(600);
      await clickOut(S);
      const d = await S.disk(path);
      const rowAdded = added.split('\n').length === T.split('\n').length + 1 && /\| apple \| 3 {3}\|\n\|[ |]+\|\n\| kiwi/.test(added);
      const colGone = !d.includes('Qty') && d.includes('| Fruit |');
      return res(rowAdded && colGone, { added: show(added), d: show(d) });
    },
  },
  {
    id: 'tables.cell-edit.e11',
    feature: 'tables.cell-edit',
    name: 'A value ending in a backslash typed into an unpadded table keeps the row its two cells',
    run: async (S) => {
      const doc = INTRO + '|a|b|\n|-|-|\n|1|2|' + OUTRO;
      const path = await open(S, 'edit-backslash', doc);
      await typeInto(S, cell(0, 0), 'x\\');
      await clickOut(S);
      const d = await S.disk(path);
      const row = await S.eval(() => [...document.querySelectorAll('.sheaf-table td[data-r="0"]')].map((c) => c.textContent));
      await S.shot('cell-edit-e11-backslash');
      return res(JSON.stringify(row) === JSON.stringify(['x\\', '2']), { row, d: show(d) });
    },
  },

  // ------------------------------------------------------- tables.keyboard-reach
  {
    id: 'tables.keyboard-reach.e01',
    feature: 'tables.keyboard-reach',
    name: 'From a click in the paragraph above, Down twice reaches the header row and Up twice returns to that paragraph',
    run: async (S) => {
      const path = await open(S, 'reach-down', T);
      await S.caret('Intro', 2);
      await S.press('ArrowDown ArrowDown');
      const inGrid = await grid(S);
      await S.press('ArrowUp ArrowUp');
      const st = await S.state();
      const d = await S.disk(path);
      return res(inGrid.inGrid && inGrid.focus === '-1,0' && st.line === 1 && st.focused && d === T, { inGrid, line: st.line, focused: st.focused });
    },
  },
  {
    id: 'tables.keyboard-reach.e02',
    feature: 'tables.keyboard-reach',
    name: 'From a click in the paragraph below, Up twice reaches the last row, Down leaves, and a typed letter lands below the table',
    run: async (S) => {
      const path = await open(S, 'reach-up', T);
      await S.caret('After', 2);
      await S.press('ArrowUp ArrowUp');
      const inGrid = await grid(S);
      await S.press('ArrowDown');
      await S.type('Z');
      const d = await S.disk(path);
      return res(inGrid.inGrid && inGrid.focus === '1,0' && d === INTRO + T0 + '\n\nZ\nAfter line\n', { inGrid, d: show(d) });
    },
  },
  {
    id: 'tables.keyboard-reach.e03',
    feature: 'tables.keyboard-reach',
    name: 'Down from a heading directly above a table enters the table in sample/tables.md',
    run: async (S) => {
      await openSample(S,'tables.md');
      await S.caret('Smallest', 3);
      await S.press('ArrowDown');
      const g = await grid(S);
      return res(g.inGrid && g.gridIndex === 0 && g.focus === '-1,0', g);
    },
  },
  {
    id: 'tables.keyboard-reach.e04',
    feature: 'tables.keyboard-reach',
    name: 'Down out of the last row of one table and Down again enters the next table',
    run: async (S) => {
      await open(S, 'reach-two', INTRO + T0 + '\n\n' + T0 + OUTRO);
      await S.click(cell(1, 0, 0));
      await S.press('ArrowDown');
      const between = await S.state();
      await S.press('ArrowDown');
      const g = await grid(S);
      return res(between.line === INTRO.split('\n').length + T0.split('\n').length && g.gridIndex === 1 && g.focus === '-1,0', { line: between.line, g });
    },
  },
  {
    id: 'tables.keyboard-reach.e05',
    feature: 'tables.keyboard-reach',
    name: 'Up from the header of a first-line table and straight back Down, without typing, leaves the file as it was',
    run: async (S) => {
      const doc = T0 + OUTRO;
      const path = await open(S, 'reach-first-line', doc);
      await S.click(cell(-1, 0));
      await S.press('ArrowUp');
      const above = await S.state();
      for (let i = 0; i < 3 && !(await grid(S)).inGrid; i++) await S.press('ArrowDown');
      await S.click(cell(0, 0));
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === doc, { caretLineAbove: above.line, d: show(d) });
    },
  },
  {
    id: 'tables.keyboard-reach.e06',
    feature: 'tables.keyboard-reach',
    name: 'Up from the header of a first-line table and typing puts the text above the table',
    run: async (S) => {
      const doc = T0 + OUTRO;
      const path = await open(S, 'reach-first-type', doc);
      await S.click(cell(-1, 1));
      await S.press('ArrowUp');
      await S.type('Title');
      const d = await S.disk(path);
      return res(d === 'Title\n\n' + doc, show(d));
    },
  },

  // ---------------------------------------------------------- tables.navigation
  {
    id: 'tables.navigation.e01',
    feature: 'tables.navigation',
    name: 'In a wide table, End brings the last column into view and Cmd+Home scrolls back to the first',
    run: async (S) => {
      const cols = Array.from({ length: 24 }, (_, i) => `Column number ${i + 1}`);
      const doc = INTRO + `| ${cols.join(' | ')} |\n|${cols.map(() => ' --- ').join('|')}|\n| ${cols.map((_, i) => `value ${i + 1}`).join(' | ')} |\n| ${cols.map((_, i) => `second ${i + 1}`).join(' | ')} |` + OUTRO;
      const path = await open(S, 'nav-wide', doc);
      await S.click(cell(0, 0));
      await S.press('End');
      const end = await S.eval(() => {
        const g = document.querySelector('.sheaf-table-grid').getBoundingClientRect();
        const f = document.querySelector('.sheaf-table .is-focus');
        const r = f.getBoundingClientRect();
        return { focus: `${f.dataset.r},${f.dataset.c}`, visible: r.left >= g.left - 1 && r.right <= g.right + 1 };
      });
      await S.shot('navigation-e01-end');
      await S.press('ArrowDown');
      await S.press('Meta+Home');
      const home = await S.eval(() => ({ focus: document.querySelector('.sheaf-table .is-focus')?.dataset.c, scroll: document.querySelector('.sheaf-table-grid').scrollLeft }));
      await S.shot('navigation-e01-home');
      await clickOut(S);
      const d = await S.disk(path);
      return res(end.focus === '0,23' && end.visible && home.focus === '0' && home.scroll === 0 && d === doc, { end, home });
    },
  },
  {
    id: 'tables.navigation.e02',
    feature: 'tables.navigation',
    name: 'Page Down from a middle row of the sample tall table stops on its last row, and Shift+Page Up selects back up',
    run: async (S) => {
      await openSample(S,'tables.md');
      const gid = await tableId(S, 'Table: n, square, cube');
      await S.click(cellOf(gid, 2, 1));
      await S.press('PageDown');
      const down = await grid(S);
      await S.press('Shift+PageUp');
      const up = await grid(S);
      // Rows 9 up to the header row are 11 cells of the column. Shift grows the block
      // from its far end, and the active cell stays on row 9.
      return res(down.focus === '9,1' && up.focus === '9,1' && up.sel === 11, { down, up });
    },
  },
  {
    id: 'tables.navigation.e03',
    feature: 'tables.navigation',
    name: 'In the 800-row stress table, Cmd+Down reaches the last row and shows it on screen',
    run: async (S) => {
      await openSample(S,'stress/large-tables.md');
      await S.click(cell(0, 1, 0));
      const t0 = Date.now();
      await S.press('Meta+ArrowDown');
      await S.sleep(800);
      const ms = Date.now() - t0;
      // "On screen" means a person can read the cell, so ask about its text rather
      // than its border. The border check this replaced failed by less than a pixel on
      // a row scrolled flush to the bottom of the frame: the last row's bottom edge
      // landed at 786 and a fraction in a window 786 tall. It had passed for a while
      // only because of where a row happened to end, not because it was right, and it
      // stopped passing when the rows got taller and the driver reported a different
      // window height. Nothing in the product moved.
      const r = await S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus');
        const range = document.createRange();
        range.selectNodeContents(f);
        const text = range.getBoundingClientRect();
        const box = f.getBoundingClientRect();
        return {
          focus: `${f.dataset.r},${f.dataset.c}`,
          onScreen: text.height > 0 && text.top >= 0 && text.bottom <= window.innerHeight,
          textTop: Math.round(text.top),
          textBottom: Math.round(text.bottom),
          boxBottom: box.bottom,
          innerHeight: window.innerHeight,
        };
      });
      await S.shot('navigation-e03-large');
      return res(r.focus === '799,1' && r.onScreen, { ...r, ms });
    },
  },
  {
    id: 'tables.navigation.e04',
    feature: 'tables.navigation',
    name: 'A run of Home, End, Cmd+arrow, Page and Shift keys after a click leaves the file unchanged',
    run: async (S) => {
      const path = await open(S, 'nav-nowrite', N);
      await S.click(cell(1, 1));
      await S.press('Home Shift+End Meta+ArrowDown PageUp Meta+Home Shift+Meta+End Tab Shift+Tab');
      const g = await grid(S);
      await clickOut(S);
      const d = await S.disk(path);
      return res(g.inGrid && d === N, { g, d: show(d) });
    },
  },

  // ----------------------------------------------------------- tables.selection
  {
    id: 'tables.selection.e01',
    feature: 'tables.selection',
    name: 'Dragging from the bottom-right cell up to the top-left selects the whole block',
    run: async (S) => {
      await open(S, 'sel-drag-reverse', N);
      await S.drag(cell(2, 2), cell(0, 0));
      const g = await grid(S);
      await S.shot('selection-e01-drag');
      // The cell the drag started in stays the active one.
      return res(g.sel === 9 && g.focus === '2,2', g);
    },
  },
  {
    id: 'tables.selection.e02',
    feature: 'tables.selection',
    name: 'Shift-click extends, the corner selects all, a header selects its column and a row number its row',
    run: async (S) => {
      await open(S, 'sel-clicks', N);
      await S.click(cell(2, 2));
      await S.click(cell(0, 1), { modifiers: ['Shift'] });
      const shift = await grid(S);
      await S.click('.sheaf-table-corner');
      const corner = await grid(S);
      await S.click(cell(-1, 2));
      const column = await grid(S);
      await S.click(gutter(3));
      const row = await grid(S);
      return res(shift.sel === 6 && corner.sel === 15 && column.sel === 5 && column.focus === '-1,2' && row.sel === 3, { shift, corner, column, row });
    },
  },
  {
    id: 'tables.selection.e03',
    feature: 'tables.selection',
    name: 'A drag released over the text below keeps the cells it covered, and moving the mouse afterwards changes nothing',
    run: async (S) => {
      await open(S, 'sel-drag-out', N);
      const a = await S.locate(cell(0, 0));
      const b = await S.locate(cell(1, 1));
      const out = await S.locate({ text: 'After line' });
      await S.page.mouse.move(a.x, a.y);
      await S.page.mouse.down();
      await S.page.mouse.move(b.x, b.y, { steps: 8 });
      await S.page.mouse.move(out.x, out.y, { steps: 8 });
      await S.page.mouse.up();
      await S.sleep(300);
      const released = await grid(S);
      await S.hover(cell(3, 2));
      const later = await grid(S);
      return res(released.sel === 4 && later.sel === 4, { released, later });
    },
  },
  {
    id: 'tables.selection.e04',
    feature: 'tables.selection',
    name: 'Clicking into the text after selecting cells takes the selection highlight off the table',
    run: async (S) => {
      await open(S, 'sel-click-out', N);
      await S.click(cell(1, 1));
      await S.click(cell(2, 2), { modifiers: ['Shift'] });
      await clickOut(S);
      const g = await grid(S);
      await S.shot('selection-e04-after-click-out');
      return res(g.sel === 0 && g.focus === null, g);
    },
  },
  {
    id: 'tables.selection.e05',
    feature: 'tables.selection',
    name: 'Cmd+A in a clicked table selects that table and keeps the document shown as rendered',
    run: async (S) => {
      const path = await open(S, 'sel-cmd-a', N);
      await S.click(cell(1, 1));
      await S.press('Meta+a');
      await S.sleep(400);
      const g = await grid(S);
      const tables = await S.eval(() => document.querySelectorAll('.sheaf-table').length);
      await S.shot('selection-e05-cmd-a');
      await clickOut(S);
      const d = await S.disk(path);
      return res(g.sel === 15 && tables === 1 && d === N, { g, tables });
    },
  },
  {
    id: 'tables.selection.e06',
    feature: 'tables.selection',
    name: 'Backspace after a drag selection empties those cells and only their lines change',
    run: async (S) => {
      const path = await open(S, 'sel-backspace', N);
      await S.drag(cell(0, 0), cell(1, 1));
      await S.press('Backspace');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === N.replace('| 1 | 2 | 3 |', '|   |   | 3 |').replace('| 4 | 5 | 6 |', '|   |   | 6 |'), show(d));
    },
  },

  // ----------------------------------------------------------- tables.clipboard
  {
    id: 'tables.clipboard.e01',
    feature: 'tables.clipboard',
    name: 'Selecting a block by drag and pressing Cmd+C puts its rows on the clipboard as tab-separated text',
    run: async (S) => {
      await open(S, 'clip-copy', N);
      await setClipboard(S, 'before');
      await S.drag(cell(1, 1), cell(0, 0));
      await S.press('Meta+c');
      await S.sleep(400);
      const text = await readClipboard(S);
      return res(text === '1\t2\n4\t5', JSON.stringify(text));
    },
  },
  {
    id: 'tables.clipboard.e02',
    feature: 'tables.clipboard',
    name: 'A 3x3 spreadsheet range pasted into a 2x2 table with Cmd+V grows the table and leaves the text around it',
    run: async (S) => {
      const path = await open(S, 'clip-paste-grow', SMALL);
      await setClipboard(S, 'a\tb\tc\r\nd\te\tf\r\ng\th\ti\r\n');
      await S.click(cell(0, 0));
      await S.press('Meta+v');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === INTRO + '| A | B |     |\n| - | - | --- |\n| a | b | c   |\n| d | e | f   |\n| g | h | i   |' + OUTRO, show(d));
    },
  },
  {
    id: 'tables.clipboard.e03',
    feature: 'tables.clipboard',
    name: 'Pasting a copied sentence with a comma into a cell puts the sentence in that cell and leaves its neighbour alone',
    run: async (S) => {
      const path = await open(S, 'clip-comma', N);
      await setClipboard(S, 'Hello, world');
      await S.click(cell(0, 0));
      await S.press('Meta+v');
      const row = await S.eval(() => [...document.querySelectorAll('.sheaf-table td[data-r="0"]')].map((c) => c.textContent));
      await S.shot('clipboard-e03-comma');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === N.replace('| 1 | 2 | 3 |', '| Hello, world | 2 | 3 |'), { row, d: show(d) });
    },
  },
  {
    id: 'tables.clipboard.e04',
    feature: 'tables.clipboard',
    name: 'Cmd+X on two cells then Cmd+Z puts them back and the file is unchanged',
    run: async (S) => {
      const path = await open(S, 'clip-cut-undo', N);
      await setClipboard(S, 'before');
      await S.drag(cell(0, 0), cell(0, 1));
      await S.press('Meta+x');
      await S.sleep(300);
      const cut = await S.eval(() => [...document.querySelectorAll('.sheaf-table td[data-r="0"]')].map((c) => c.textContent));
      const text = await readClipboard(S);
      await S.press('Meta+z');
      await S.sleep(300);
      await clickOut(S);
      const d = await S.disk(path);
      return res(JSON.stringify(cut) === JSON.stringify(['', '', '3']) && text === '1\t2' && d === N, { cut, text, d: show(d) });
    },
  },
  {
    id: 'tables.clipboard.e05',
    feature: 'tables.clipboard',
    name: 'One copied value pasted over a dragged selection fills every selected cell',
    run: async (S) => {
      const path = await open(S, 'clip-fill', N);
      await setClipboard(S, 'Z');
      await S.drag(cell(0, 2), cell(2, 2));
      await S.press('Meta+v');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === N.replace('| 1 | 2 | 3 |', '| 1 | 2 | Z |').replace('| 4 | 5 | 6 |', '| 4 | 5 | Z |').replace('| 7 | 8 | 9 |', '| 7 | 8 | Z |'), show(d));
    },
  },
  {
    id: 'tables.clipboard.e06',
    feature: 'tables.clipboard',
    name: 'A copied spreadsheet column with an empty cell pastes with the empty cell kept in its row',
    run: async (S) => {
      await open(S, 'clip-blank-cell', N);
      await setClipboard(S, 'x\r\n\r\ny\r\n');
      await S.click(cell(0, 0));
      await S.press('Meta+v');
      const col = await S.eval(() => [0, 1, 2].map((r) => document.querySelector(`.sheaf-table [data-r="${r}"][data-c="0"]`).textContent));
      return res(JSON.stringify(col) === JSON.stringify(['x', '', 'y']), col);
    },
  },

  // --------------------------------------------------------------- tables.undo
  {
    id: 'tables.undo.e01',
    feature: 'tables.undo',
    name: 'Cmd+Z right after a cell edit shows the old value, and leaving writes nothing',
    run: async (S) => {
      const path = await open(S, 'undo-cell', T);
      await typeInto(S, cell(0, 0), 'pear');
      await S.press('Meta+z');
      await S.sleep(500);
      const shown = await cellText(S, 0, 0);
      await clickOut(S);
      const d = await S.disk(path);
      return res(shown === 'apple' && d === T, { shown, d: show(d) });
    },
  },
  {
    id: 'tables.undo.e02',
    feature: 'tables.undo',
    name: 'After two cell edits, Cmd+Z takes back only the second and Cmd+Shift+Z brings it back',
    run: async (S) => {
      const path = await open(S, 'undo-two', N);
      await typeInto(S, cell(0, 0), 'x');
      await typeInto(S, cell(2, 2), 'y');
      await S.press('Meta+z');
      await S.sleep(300);
      const one = [await cellText(S, 0, 0), await cellText(S, 2, 2)];
      await S.press('Meta+Shift+z');
      await S.sleep(300);
      await clickOut(S);
      const d = await S.disk(path);
      return res(JSON.stringify(one) === JSON.stringify(['x', '9']) && d === N.replace('| 1 | 2 | 3 |', '| x | 2 | 3 |').replace('| 7 | 8 | 9 |', '| 7 | 8 | y |'), { one, d: show(d) });
    },
  },
  {
    id: 'tables.undo.e03',
    feature: 'tables.undo',
    name: 'Typing in the text, then a cell edit, then Cmd+Z twice takes back both in order',
    run: async (S) => {
      const path = await open(S, 'undo-prose-then-cell', T);
      await S.caret('Intro', 2);
      await S.type('X');
      await S.sleep(600);
      await typeInto(S, cell(1, 1), '99');
      await S.press('Meta+z');
      await S.sleep(500);
      const afterOne = { cell: await cellText(S, 1, 1), line1: (await S.state()).doc.split('\n')[0] };
      await S.press('Meta+z');
      await S.sleep(800);
      const afterTwo = { line1: (await S.state()).doc.split('\n')[0], g: await grid(S) };
      await clickOut(S);
      const d = await S.disk(path);
      return res(afterOne.cell === '12' && afterOne.line1 === 'InXtro line here' && afterTwo.line1 === 'Intro line here' && d === T, { afterOne, afterTwo, d: show(d) });
    },
  },
  {
    id: 'tables.undo.e04',
    feature: 'tables.undo',
    name: 'After a cell edit is saved by leaving, clicking back into the table and pressing Cmd+Z restores the file',
    run: async (S) => {
      const path = await open(S, 'undo-after-leave', T);
      await typeInto(S, cell(0, 1), '7');
      await clickOut(S);
      const saved = await S.disk(path);
      await S.click(cell(1, 0));
      await S.press('Meta+z');
      await S.sleep(800);
      const g = await grid(S);
      const shown = await cellText(S, 0, 1);
      const dirty = await S.page.evaluate(() => !!document.querySelector('.tabs-container .tab.active.dirty'));
      await clickOut(S);
      const d = await S.disk(path);
      return res(saved === T.replace('| 3   |', '| 7   |') && d === T && g.inGrid, { saved: show(saved), shownAfterUndo: shown, dirtyAfterUndo: dirty, d: show(d), g });
    },
  },
  {
    id: 'tables.undo.e05',
    feature: 'tables.undo',
    name: 'Clicking the toolbar Undo button right after a cell edit takes the cell edit back',
    run: async (S) => {
      const path = await open(S, 'undo-toolbar', T);
      await typeInto(S, cell(1, 0), 'fig');
      const button = await S.eval(() => {
        const b = [...document.querySelectorAll('#toolbar button')].find((x) => (x.title || '').startsWith('Undo'));
        return b ? { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') } : null;
      });
      console.log(`     note: Undo button before the click ${JSON.stringify(button)}`);
      await S.toolbar('Undo');
      await S.sleep(600);
      const shown = await cellText(S, 1, 0);
      await clickOut(S);
      const d = await S.disk(path);
      return res(shown === 'kiwi' && d === T, { shown, d: show(d) });
    },
  },

  // -------------------------------------------------------- tables.cell-content
  {
    id: 'tables.cell-content.e01',
    feature: 'tables.cell-content',
    name: 'Bold, italic, inline code and link cells in sample/tables.md show formatted text without markers',
    run: async (S) => {
      await openSample(S,'tables.md');
      const i = await tableIndex(S, 'Table: Left, Center, Right');
      await S.hover(cell(0, 1, i));
      const r = await S.eval((i) => {
        const t = document.querySelectorAll('.sheaf-table')[i];
        const c = (r, k) => t.querySelector(`[data-r="${r}"][data-c="${k}"]`);
        return { strong: c(4, 1).querySelector('strong')?.textContent, em: c(5, 1).querySelector('em')?.textContent, code: c(6, 1).querySelector('code')?.textContent, link: c(7, 1).querySelector('.tok-link')?.textContent, linkText: c(7, 1).textContent };
      }, i);
      await S.shot('cell-content-e01-inline');
      return res(r.strong === 'strong' && r.em === 'emphasis' && r.code === 'inline()' && r.link === 'Sheaf' && r.linkText === 'Sheaf', r);
    },
  },
  {
    id: 'tables.cell-content.e02',
    feature: 'tables.cell-content',
    name: 'An escaped pipe shows as a pipe, opens as written, and closing it unchanged writes nothing',
    run: async (S) => {
      const doc = INTRO + '| a | b |\n| - | - |\n| x \\| y | 2 |' + OUTRO;
      const path = await open(S, 'content-escaped-pipe', doc);
      const shown = await cellText(S, 0, 0);
      await S.dblclick(cell(0, 0));
      const opened = (await grid(S)).input;
      await S.press('Enter');
      await clickOut(S);
      const d = await S.disk(path);
      return res(shown === 'x | y' && opened === 'x \\| y' && d === doc, { shown, opened, d: show(d) });
    },
  },
  {
    id: 'tables.cell-content.e03',
    feature: 'tables.cell-content',
    name: 'Typing a<br>b into a cell writes the tag and shows two lines in the cell',
    run: async (S) => {
      const path = await open(S, 'content-br', T);
      await typeInto(S, cell(0, 0), 'a<br>b');
      await clickOut(S);
      const d = await S.disk(path);
      const breaks = await S.eval(() => document.querySelector('.sheaf-table [data-r="0"][data-c="0"]').querySelectorAll('br').length);
      await S.shot('cell-content-e03-br');
      return res(d === T.replace('| apple |', '| a<br>b |') && breaks === 1, { breaks, d: show(d) });
    },
  },
  {
    id: 'tables.cell-content.e04',
    feature: 'tables.cell-content',
    name: 'Typing Japanese into a cell of the i18n sample changes only that line of the file',
    run: async (S) => {
      await openSample(S,'edge/unicode-and-i18n.md');
      const path = join(S.ws, 'edge/unicode-and-i18n.md');
      const before = readFileSync(path, 'utf8');
      const gid = await tableId(S, 'Table: 名前, 部署, 状態, 備考');
      await typeInto(S, cellOf(gid, 0, 3), '東京');
      await S.caret('Column alignment', 3);
      const d = await S.disk(path);
      // Padding of a wide-character value is its own case (cell-content.e08); this one checks the text and that no other line moved.
      const a = before.split('\n');
      const b = d.split('\n');
      const k = a.indexOf('| 田中 | 運行管理 | 稼働 | 通常運転 |');
      const ok = k >= 0 && a.length === b.length && /^\| 田中 \| 運行管理 \| 稼働 \| 東京 *\|$/.test(b[k]) && a.every((l, i) => i === k || l === b[i]);
      return res(ok, { line: b[k] });
    },
  },
  {
    id: 'tables.cell-content.e05',
    feature: 'tables.cell-content',
    name: 'Composing with an input method in an open cell and confirming it keeps the confirmed text',
    run: async (S) => {
      const path = await open(S, 'content-ime', T);
      await S.dblclick(cell(1, 0));
      await S.page.keyboard.press('Meta+a');
      const cdp = await cdpOf(S);
      await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
      await S.sleep(200);
      await cdp.send('Input.insertText', { text: '日本' });
      await S.sleep(200);
      const value = (await grid(S)).input;
      await S.press('Enter');
      await clickOut(S);
      const d = await S.disk(path);
      // Padding of a wide-character value is its own case (cell-content.e08); this one checks the text.
      const lines = d.split('\n');
      const others = T.split('\n');
      const rowOk = /^\| 日本 +\| 12  \|$/.test(lines[5] ?? '');
      const restOk = lines.length === others.length && lines.every((l, k) => k === 5 || l === others[k]);
      return res(value === '日本' && rowOk && restOk, { value, d: show(d) });
    },
  },
  {
    id: 'tables.cell-content.e06',
    feature: 'tables.cell-content',
    name: 'Starting an input method composition on a clicked cell types into that cell',
    run: async (S) => {
      await open(S, 'content-ime-select', T);
      await S.click(cell(0, 0));
      const cdp = await cdpOf(S);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyN', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await S.sleep(200);
      await cdp.send('Input.insertText', { text: '日' });
      await S.sleep(300);
      const g = await grid(S);
      return res(g.input === '日', g);
    },
  },
  {
    id: 'tables.cell-content.e07',
    feature: 'tables.cell-content',
    name: 'Backslash escapes and HTML entities in cells show as the characters they stand for',
    run: async (S) => {
      await open(S, 'content-escapes', INTRO + '| a | b | c |\n| - | - | - |\n| \\*not italic\\* | C:\\\\Users | AT&amp;T |' + OUTRO);
      await S.hover(cell(0, 0));
      const row = await S.eval(() => [...document.querySelectorAll('.sheaf-table td[data-r="0"]')].map((c) => c.textContent));
      await S.shot('cell-content-e07-escapes');
      return res(JSON.stringify(row) === JSON.stringify(['*not italic*', 'C:\\Users', 'AT&T']), row);
    },
  },

  {
    id: 'tables.cell-content.e08',
    feature: 'tables.cell-content',
    name: 'A Japanese value typed into a padded cell keeps the column lined up when the file is read in a monospace editor',
    run: async (S) => {
      const doc = INTRO + '| Name  | Qty |\n| ----- | --- |\n| apple | 3   |' + OUTRO;
      const path = await open(S, 'content-cjk-pad', doc);
      await typeInto(S, cell(0, 0), '日本');
      await clickOut(S);
      const d = await S.disk(path);
      return res(d === doc.replace('| apple |', '| 日本  |'), show(d));
    },
  },

  // --------------------------------------------------------------- tables.a11y
  {
    id: 'tables.a11y.e01',
    feature: 'tables.a11y',
    name: 'The accessibility tree shows a grid named by its columns with headers and cells, and a clicked cell becomes selected',
    run: async (S) => {
      await open(S, 'a11y-tree', T);
      await S.click(cell(1, 1));
      const f = await S.frame();
      const snap = await f.locator('.sheaf-table-grid').first().ariaSnapshot();
      const active = await S.eval(() => {
        const g = document.querySelector('.sheaf-table-grid');
        return document.getElementById(g.getAttribute('aria-activedescendant'))?.textContent;
      });
      return res(/grid "Table: Fruit, Qty"/.test(snap) && /columnheader "Fruit"/.test(snap) && /gridcell "12" \[selected\]/.test(snap) && active === '12', { snap, active });
    },
  },
  {
    id: 'tables.a11y.e02',
    feature: 'tables.a11y',
    name: 'The arrows move the active cell announced to assistive tech, and an open cell editor is labeled with its column and row',
    run: async (S) => {
      await open(S, 'a11y-arrows', T);
      await S.click(cell(0, 0));
      await S.press('ArrowRight ArrowDown');
      const active = await S.eval(() => document.getElementById(document.querySelector('.sheaf-table-grid').getAttribute('aria-activedescendant'))?.textContent);
      await S.press('Enter');
      const f = await S.frame();
      const snap = await f.locator('.sheaf-table-grid').first().ariaSnapshot();
      return res(active === '12' && /textbox "Qty, row 2"/.test(snap), { active, snap });
    },
  },
  {
    id: 'tables.a11y.e03',
    feature: 'tables.a11y',
    name: 'After Escape clears the selection, the grid that still has the keyboard shows a visible focus indicator',
    run: async (S) => {
      await open(S, 'a11y-focus-visible', T);
      await S.click(cell(0, 0));
      await S.press('Escape');
      const r = await S.eval(() => {
        const g = document.querySelector('.sheaf-table-grid');
        const cs = getComputedStyle(g);
        return { inGrid: document.activeElement === g, outline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px', ring: !!document.querySelector('.sheaf-table .is-focus'), boxShadow: cs.boxShadow };
      });
      await S.shot('a11y-e03-after-escape');
      return res(r.inGrid && (r.outline || r.ring || r.boxShadow !== 'none'), r);
    },
  },

  {
    id: 'tables.a11y.e04',
    feature: 'tables.a11y',
    name: 'After renaming a header by double-click and Enter, the grid is announced by its new column name',
    run: async (S) => {
      await open(S, 'a11y-renamed-header', T);
      await typeInto(S, cell(-1, 0), 'Name');
      const g = await grid(S);
      const f = await S.frame();
      const snap = await f.locator('.sheaf-table-grid').first().ariaSnapshot();
      return res(g.inGrid && /grid "Table: Name, Qty"/.test(snap), { g, first: snap.split('\n')[0] });
    },
  },

  // -------------------------------------------------------------- tables.touch
  // There is no e01. It sent raw Input.dispatchTouchEvent points, and in this window the
  // compatibility mouse press they produce arrives at about half the aimed coordinates, so it
  // measured the emulation rather than the grid. A tap is driven as a tap gesture instead.
  {
    // A single tap through the tap gesture, the path e02 shows lands on the cell it aims at.
    id: 'tables.touch.e03',
    feature: 'tables.touch',
    name: 'With touch emulated, a single tap gesture selects the tapped cell and a second one moves the selection without opening an editor',
    run: async (S) => {
      const path = await open(S, 'touch-tap-gesture', T);
      await S.hover(cell(0, 0));
      const cdp = await cdpOf(S);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const tap = async (target) => {
        const p = await S.locate(target);
        await cdp.send('Input.synthesizeTapGesture', { x: p.x, y: p.y, tapCount: 1, gestureSourceType: 'touch' });
        await S.sleep(700);
      };
      try {
        await tap(cell(1, 1));
        const first = await grid(S);
        await tap(cell(0, 0));
        const second = await grid(S);
        await S.shot('touch-e03-tap');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await clickOut(S);
        const d = await S.disk(path);
        return res(first.focus === '1,1' && first.sel === 1 && second.focus === '0,0' && second.sel === 1 && second.input === null && d === T, { first, second });
      } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      }
    },
  },
  {
    id: 'tables.touch.e02',
    feature: 'tables.touch',
    name: 'With touch emulated, a double tap opens the cell and typed text lands in the file',
    run: async (S) => {
      const path = await open(S, 'touch-double-tap', T);
      await S.hover(cell(0, 0));
      const cdp = await cdpOf(S);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      try {
        const p = await S.locate(cell(0, 1));
        await cdp.send('Input.synthesizeTapGesture', { x: p.x, y: p.y, tapCount: 2, gestureSourceType: 'touch' });
        await S.sleep(600);
        const g = await grid(S);
        const menu = await S.eval(() => [...document.querySelectorAll('.sheaf-ctx-menu')].some((m) => !m.hidden));
        await S.page.keyboard.press('Meta+a');
        await S.type('8');
        await S.press('Enter');
        await S.shot('touch-e02-double-tap');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await clickOut(S);
        const d = await S.disk(path);
        return res(g.input !== null && !menu && d === T.replace('| 3   |', '| 8   |'), { g, menu, d: show(d) });
      } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      }
    },
  },
];
