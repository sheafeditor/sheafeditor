// E2E scenarios for table operations, driven by clicks, drags and right-clicks in
// real VS Code. Every check compares the whole file on disk, so a reformat of rows
// an operation should not touch shows up.
import { writeFileSync } from 'node:fs';
import { show } from '../session.mjs';

const inDoc = (t) => `Intro text.\n\n${t}\n\nAfter text.\n`;
const RAGGED = '| Fruit | Qty |\n|---|:-:|\n| apple | 3 |\n| kiwi fruit |12|';
const PADDED = '| Fruit      | Qty |\n| ---------- | :-: |\n| apple      | 3   |\n| kiwi fruit | 12  |';
const T4 = '| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |';
const T8 = '| k | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |\n| e | 5 |\n| f | 6 |\n| g | 7 |\n| h | 8 |';
const LIST = 'Intro text.\n\n- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n  | 3 | 4 |\n\nAfter text.\n';
const SKELETON = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';
const kv = (vals) => '| k | v |\n| - | - |\n' + vals.map((v, i) => `| ${String.fromCharCode(97 + i)} | ${v} |`).join('\n');

/** A grid cell; `t` picks the table when a file has several. Header cells have r = -1. */
const cell = (r, c, t = 0) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]`, nth: t });
/** A row number in the first table's gutter. */
const gutter = (r) => ({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: r });
/** Leave the table by clicking inside a word of the paragraph below it. */
const leave = (S) => S.caret('After', 2);
const same = (got, want) => ({ ok: got === want, detail: got === want ? '' : `got ${show(got)}\nwant ${show(want)}` });
const all = (checks, detail) => {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { ok: failed.length === 0, detail: failed.length ? `failed: ${failed.join(', ')}; ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '' };
};
function gfmCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Open the right-click menu on a target and choose an item. */
async function menuOn(S, target, label) {
  await S.rightClick(target);
  await S.sleep(200);
  await S.menu(label);
  await S.sleep(300);
}

/** The labels of the menu a right-click on `target` opens; the menu is closed again with Escape. */
async function menuItems(S, target) {
  await S.rightClick(target);
  await S.sleep(200);
  const items = await S.eval(() => [...document.querySelectorAll('.sheaf-ctx-menu:not([hidden]) .sheaf-ctx-item')].map((b) => b.textContent));
  await S.page.keyboard.press('Escape');
  await S.sleep(200);
  return items;
}

/** Copy ref from a right-click on `target`, returning what reached the system clipboard. */
async function copyRef(S, target) {
  await S.clipboard.write('before copy ref');
  await menuOn(S, target, 'Copy ref');
  for (let i = 0; i < 20 && (await S.clipboard.read()) === 'before copy ref'; i++) await S.sleep(100);
  return (await S.clipboard.read());
}

/** Rows each grid currently marks as changed from outside, as their cell text joined by pipes. */
const marks = (S) =>
  S.eval(() =>
    [...document.querySelectorAll('.sheaf-table')].map((g) => [...g.querySelectorAll('tr.is-changed')].map((tr) => [...tr.querySelectorAll('[data-r]')].map((c) => c.textContent).join('|')))
  );

/** Change the file from outside, wait until the editor holds `until`, and return the marks seen then. */
async function outside(S, path, text, until) {
  writeFileSync(path, text);
  for (let i = 0; i < 100; i++) {
    const st = await S.state().catch(() => null);
    if (st && typeof st.doc === 'string' && st.doc.includes(until)) return marks(S);
    await S.sleep(50);
  }
  throw new Error(`the outside change never reached the editor (waiting for ${JSON.stringify(until)})`);
}

/** The notifications VS Code has on screen, as a person reads them. */
const toasts = (S) =>
  S.page.$$eval('.notifications-toasts .notification-list-item-message', (els) => els.map((e) => e.textContent.trim()));

/** True when one of the notices names `text` as what a write from outside took. */
const saidItTook = (said, text) => said.some((t) => t.includes(`your last change is gone: "${text}"`));

/**
 * True when a notice says a write from outside took the person's last change, without
 * pinning what it quoted. An operation that rewrites rows loses a block of table
 * source, and the quote of it is cut short and has its whitespace collapsed; what
 * matters in those scenarios is that the person was told at all.
 */
const saidSomethingWasTaken = (said) => said.some((t) => t.includes('your last change is gone'));

/**
 * The race a person actually loses work in: what they typed reaches disk, and a tool
 * then writes the whole file from text it read before that. The write wins, and these
 * scenarios are about what Sheaf says and what Undo gives back.
 *
 * Waiting for the file to settle first is the whole point. Written while the edit is
 * still unsaved, the file is newer than the document, VS Code refuses Sheaf's save and
 * shows an error, and the editor never takes the write at all.
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

/** Take the write back the way the person does: leave the grid, then their own Undo key. */
async function pressUndo(S) {
  await leave(S);
  await S.press('Meta+z');
  await S.sleep(800);
}

/** Every mark seen over about a second. */
async function marksOverASecond(S) {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    seen.push(...(await marks(S)).flat());
    await S.sleep(80);
  }
  return seen;
}

/** Display columns of each unescaped pipe, counting wide characters and emoji as two. */
const WIDE = /\p{Emoji_Presentation}|️|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
function pipeColumns(line) {
  const gs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line), (x) => x.segment);
  const out = [];
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
const linedUp = (lines) => lines.every((l) => JSON.stringify(pipeColumns(l)) === JSON.stringify(pipeColumns(lines[0])));
const tableLines = (d) => d.split('\n').filter((l) => l.includes('|'));

/** A scenario that opens `doc`, runs `steps` (which must include a mouse action), leaves the table and compares the whole file. */
const fileCase = (id, name, file, doc, steps, want) => ({
  id,
  feature: id.replace(/\.e\d+$/, ''),
  name,
  run: async (S) => {
    await S.fresh(file, doc);
    await steps(S);
    await leave(S);
    return same(await S.disk(), want);
  },
});
/** Right-click `target`, choose `label`, leave the table, compare the whole file. */
const menuCase = (id, name, file, doc, target, label, want) => fileCase(id, name, file, doc, (S) => menuOn(S, target, label), want);
/** Right-click then Copy ref, comparing the clipboard. */
const refCase = (id, name, file, doc, steps, target, want) => ({
  id,
  feature: 'tables.copy-ref',
  name,
  run: async (S) => {
    await S.fresh(file, doc);
    await steps(S);
    return same(await copyRef(S, target), `e2e/${file}.md:${want}`);
  },
});
/** Undo right after an operation: `op` changes the file, Cmd+Z must give it back byte for byte. */
const undoCase = (id, name, file, doc, op, { leaveFirst = false } = {}) => ({
  id,
  feature: id.replace(/\.e\d+$/, ''),
  name,
  run: async (S) => {
    await S.fresh(file, doc);
    await op(S);
    if (leaveFirst) await leave(S);
    const changed = await S.disk();
    await S.press('Meta+z');
    // What the editor itself holds right after Cmd+Z, to tell an undo that never ran from one that did not reach the file.
    const editor = (await S.state().catch(() => ({}))).doc;
    if (!leaveFirst) await leave(S);
    const undone = await S.disk();
    return all({ changed: changed !== doc || !leaveFirst, undone: undone === doc }, { changed, editorAfterUndo: editor, undone });
  },
});

export const scenarios = [
  // ---- tables.rows-columns ------------------------------------------------
  menuCase('tables.rows-columns.e01', 'Right-click a row, Insert row below, click away: the file gains one line and nothing else changes', 'rc-insert-below', inDoc(RAGGED), cell(0, 0), 'Insert row below', inDoc(RAGGED.replace('| apple | 3 |\n', '| apple | 3 |\n|       |     |\n'))),
  menuCase('tables.rows-columns.e02', 'Right-click the first header cell, Delete column: every line loses only that column', 'rc-delete-col', inDoc(RAGGED), cell(-1, 0), 'Delete column', inDoc('| Qty |\n|:-:|\n| 3 |\n|12|')),
  fileCase(
    'tables.rows-columns.e03',
    'Click row number 2, Shift-click 3, right-click inside, Duplicate rows: both lines are copied exactly below',
    'rc-dup-rows',
    inDoc(T4),
    async (S) => {
      await S.click(gutter(1));
      await S.click(gutter(2), { modifiers: ['Shift'] });
      await menuOn(S, cell(2, 0), 'Duplicate rows');
    },
    inDoc(T4.replace('| c | 3 |\n', '| c | 3 |\n| b | 2 |\n| c | 3 |\n'))
  ),
  undoCase('tables.rows-columns.e04', 'Insert row above, click away, then Cmd+Z in the text: the file is byte-identical to before', 'rc-undo', inDoc(RAGGED), (S) => menuOn(S, cell(1, 1), 'Insert row above'), { leaveFirst: true }),
  {
    id: 'tables.rows-columns.e05',
    feature: 'tables.rows-columns',
    name: 'In a two-column table without outer pipes, Delete column leaves a table that still shows as a grid',
    run: async (S) => {
      await S.fresh('rc-outerless-delete', inDoc('a | b\n--|--\n1 | 2'));
      await menuOn(S, cell(0, 1), 'Delete column');
      await leave(S);
      const d = await S.disk();
      await S.sleep(300);
      const grid = await S.exists('.sheaf-table');
      await S.shot('rc-outerless-delete');
      return all({ everyLineHasAPipe: d.split('\n').slice(2, 5).every((l) => l.includes('|')), grid }, d);
    },
  },
  (() => {
    const crlf = inDoc(RAGGED).replace(/\n/g, '\r\n');
    return menuCase('tables.rows-columns.e06', 'In a CRLF file, Insert row below writes one CRLF line and leaves every other byte alone', 'rc-crlf', crlf, cell(0, 0), 'Insert row below', crlf.replace('| apple | 3 |\r\n', '| apple | 3 |\r\n|       |     |\r\n'));
  })(),
  menuCase('tables.rows-columns.e07', 'Right-click the first body row, Insert row above: one line appears under the delimiter row', 'rc-insert-above-first', inDoc(RAGGED), cell(0, 1), 'Insert row above', inDoc(RAGGED.replace('|---|:-:|\n', '|---|:-:|\n|       |     |\n'))),
  {
    id: 'tables.rows-columns.e08',
    feature: 'tables.rows-columns',
    name: 'In a table that ends the file with no line break, Insert row below the last row adds one line at the very end',
    run: async (S) => {
      await S.fresh('rc-insert-eof', 'Intro text.\n\n' + RAGGED);
      await menuOn(S, cell(1, 0), 'Insert row below');
      await S.caret('Intro', 2);
      return same(await S.disk(), 'Intro text.\n\n' + RAGGED + '\n|       |     |');
    },
  },
  menuCase('tables.rows-columns.e09', 'Right-click a header cell, Insert row below: the new row comes first', 'rc-insert-from-header', inDoc(RAGGED), cell(-1, 1), 'Insert row below', inDoc(RAGGED.replace('|---|:-:|\n', '|---|:-:|\n|       |     |\n'))),
  {
    id: 'tables.rows-columns.e10',
    feature: 'tables.rows-columns',
    name: 'Delete the only body row: the file keeps a header-only table that still shows as a grid',
    run: async (S) => {
      await S.fresh('rc-delete-only-row', inDoc('| a | b |\n| - | - |\n| 1 | 2 |'));
      await menuOn(S, cell(0, 0), 'Delete row');
      await leave(S);
      const d = await S.disk();
      await S.sleep(300);
      return all({ file: d === inDoc('| a | b |\n| - | - |'), grid: await S.exists('.sheaf-table') }, d);
    },
  },
  {
    id: 'tables.rows-columns.e11',
    feature: 'tables.rows-columns',
    name: 'In a one-column table the menu has no Delete column, and on the header it has no row delete, duplicate or move',
    run: async (S) => {
      await S.fresh('rc-one-column-menu', inDoc('| a |\n| - |\n| 1 |\n| 2 |'));
      const body = await menuItems(S, cell(0, 0));
      const header = await menuItems(S, cell(-1, 0));
      return all({ // Menu labels carry their key hint after the name, as in "Delete row⌘⌥-", so match the name.
      bodyNoDeleteColumn: !body.some((l) => l.startsWith('Delete column')), bodyHasDeleteRow: body.some((l) => l.startsWith('Delete row')), headerNoRowActions: !header.some((l) => /^(Delete|Duplicate|Move) row/.test(l)) }, { body, header });
    },
  },
  menuCase('tables.rows-columns.e12', 'Insert column right of the last column: each line only gains a cell at its end', 'rc-insert-col-last', inDoc(RAGGED), cell(0, 1), 'Insert column right', inDoc('| Fruit | Qty |     |\n|---|:-:| --- |\n| apple | 3 |     |\n| kiwi fruit |12|     |')),
  (() => {
    const T = '| k | v |\n| - | - |\n| 東京 \\| 大阪 |  x  |\n| b | 2 |';
    return menuCase('tables.rows-columns.e13', 'Duplicate row on a row with an escaped pipe and CJK text writes an exact copy below it', 'rc-dup-cjk', inDoc(T), cell(0, 1), 'Duplicate row', inDoc(T.replace('|  x  |\n', '|  x  |\n| 東京 \\| 大阪 |  x  |\n')));
  })(),
  fileCase(
    'tables.rows-columns.e14',
    'Click header x, Shift-click header y, right-click inside, Duplicate columns: both columns are copied byte for byte',
    'rc-dup-cols',
    inDoc('| x | y | z |\n|:-|-:|---|\n| 1 |2| 3 |'),
    async (S) => {
      await S.click(cell(-1, 0));
      await S.click(cell(-1, 1), { modifiers: ['Shift'] });
      await menuOn(S, cell(0, 0), 'Duplicate columns');
    },
    inDoc('| x | y | x | y | z |\n|:-|-:|:-|-:|---|\n| 1 |2| 1 |2| 3 |')
  ),

  // ---- tables.move ----------------------------------------------------------
  menuCase('tables.move.e01', 'Right-click a row with odd padding, Move row down: exactly the two lines swap', 'mv-menu-row', inDoc('| k | v |\n| - | - |\n| a \\| b |   1 |\n|c|2|\n| d | 3 |'), cell(0, 1), 'Move row down', inDoc('| k | v |\n| - | - |\n|c|2|\n| a \\| b |   1 |\n| d | 3 |')),
  fileCase(
    'tables.move.e02',
    'Drag row number 1 down onto row 3: the row lands after c and only row lines reorder',
    'mv-drag-row',
    inDoc(T4),
    async (S) => {
      // Moving takes a selected row: a drag on an unselected row number selects
      // instead, as it does in a spreadsheet.
      await S.click(gutter(0));
      await S.drag(gutter(0), cell(2, 1));
      await S.shot('mv-drag-row');
    },
    inDoc('| n | v |\n| - | - |\n| b | 2 |\n| c | 3 |\n| a | 1 |\n| d | 4 |')
  ),
  fileCase('tables.move.e03', 'Drag the first column header onto the last: segments and alignment colons move with it', 'mv-drag-col', inDoc('| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |'), async (S) => {
    await S.click(cell(-1, 0));
    await S.drag(cell(-1, 0), cell(-1, 2));
  }, inDoc('| b | c | a |\n|:-:|--:|---|\n| 2 | 3 | 1 |')),
  {
    id: 'tables.move.e04',
    feature: 'tables.move',
    name: 'Click a cell in row b, Alt+Down twice, then Alt+Down and Alt+Right at the edges: b ends last and nothing else moves',
    run: async (S) => {
      await S.fresh('mv-alt', inDoc(T4));
      await S.click(cell(1, 1));
      await S.press('Alt+ArrowDown');
      await S.press('Alt+ArrowDown');
      await S.press('Alt+ArrowDown');
      await S.press('Alt+ArrowRight');
      const focus = await S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus');
        return f ? `${f.dataset.r},${f.dataset.c}` : null;
      });
      await leave(S);
      const d = await S.disk();
      return all({ file: d === inDoc('| n | v |\n| - | - |\n| a | 1 |\n| c | 3 |\n| d | 4 |\n| b | 2 |'), focusFollowed: focus === '3,1' }, { focus, d });
    },
  },
  {
    id: 'tables.move.e05',
    feature: 'tables.move',
    name: 'Move column right on a table whose row has text past the last header column keeps that text',
    run: async (S) => {
      await S.fresh('mv-extra', inDoc('| a | b |\n| - | - |\n| 1 | 2 | extra |'));
      await menuOn(S, cell(0, 0), 'Move column right');
      await leave(S);
      const d = await S.disk();
      return all({ moved: d.includes('| b | a |'), extraKept: d.includes('extra') }, d);
    },
  },
  (() => {
    const crlf = inDoc(T4).replace(/\n/g, '\r\n');
    return menuCase('tables.move.e06', 'In a CRLF file, Move row up swaps two CRLF lines and changes nothing else', 'mv-crlf', crlf, cell(1, 0), 'Move row up', crlf.replace('| a | 1 |\r\n| b | 2 |', '| b | 2 |\r\n| a | 1 |'));
  })(),
  {
    id: 'tables.move.e07',
    feature: 'tables.move',
    name: 'The menu offers no move past an edge: first row up, last row down, last column right, or any row move on the header',
    run: async (S) => {
      await S.fresh('mv-edges', inDoc(T4));
      const first = await menuItems(S, cell(0, 0));
      const last = await menuItems(S, cell(3, 1));
      const header = await menuItems(S, cell(-1, 0));
      return all(
        {
          firstNoUp: !first.some((l) => l.startsWith('Move row up')) && first.some((l) => l.startsWith('Move row down')) && !first.some((l) => l.startsWith('Move column left')),
          lastNoDown: !last.some((l) => l.startsWith('Move row down')) && last.some((l) => l.startsWith('Move row up')) && !last.some((l) => l.startsWith('Move column right')),
          headerNoRowMove: !header.some((l) => l.startsWith('Move row')),
        },
        { first, last, header }
      );
    },
  },
  menuCase('tables.move.e08', 'Move column right in a table whose row is shorter than the header moves the cell the row has', 'mv-short-row', inDoc('| a | b | c |\n| - | - | - |\n| 1 |'), cell(-1, 0), 'Move column right', inDoc('| b | a | c |\n| - | - | - |\n|   | 1 |   |')),
  fileCase('tables.move.e09', 'Drag row number 2 up past row 1 onto the header: the row becomes first and the header stays', 'mv-drag-to-header', inDoc(T4), async (S) => {
    await S.click(gutter(1));
    await S.drag(gutter(1), cell(-1, 1));
  }, inDoc('| n | v |\n| - | - |\n| b | 2 |\n| a | 1 |\n| c | 3 |\n| d | 4 |')),
  fileCase('tables.move.e10', 'Drag the second column header past the first onto the row-number gutter: the column becomes first', 'mv-drag-to-gutter', inDoc(T4), async (S) => {
    await S.click(cell(-1, 1));
    await S.drag(cell(-1, 1), { sel: '.sheaf-table-corner' });
  }, inDoc('| v | n |\n| - | - |\n| 1 | a |\n| 2 | b |\n| 3 | c |\n| 4 | d |')),
  undoCase('tables.move.e11', 'Move row down, then Cmd+Z in the grid before leaving: the file is byte-identical', 'mv-grid-undo', inDoc(T4), (S) => menuOn(S, cell(1, 0), 'Move row down')),
  undoCase('tables.move.e12', 'Move column left, click away, then Cmd+Z in the text: the file is byte-identical', 'mv-doc-undo', inDoc(RAGGED), (S) => menuOn(S, cell(0, 1), 'Move column left'), { leaveFirst: true }),
  menuCase('tables.move.e13', 'In a table inside a list item, Move row up swaps the two indented lines whole', 'mv-list', LIST, cell(1, 0), 'Move row up', LIST.replace('  | 1 | 2 |\n  | 3 | 4 |', '  | 3 | 4 |\n  | 1 | 2 |')),
  {
    id: 'tables.move.e14',
    feature: 'tables.move',
    name: 'With row numbers 1 and 2 selected, the menu inside the selection offers Move rows down but not up',
    run: async (S) => {
      await S.fresh('mv-selection-menu', inDoc(T4));
      await S.click(gutter(0));
      await S.click(gutter(1), { modifiers: ['Shift'] });
      const items = await menuItems(S, cell(1, 0));
      return all({ down: items.some((l) => l.startsWith('Move rows down')), noUp: !items.some((l) => /^Move rows? up/.test(l)) }, items);
    },
  },

  // ---- tables.sort ----------------------------------------------------------
  menuCase('tables.sort.e01', 'Sort A to Z on amounts, negatives, a word and a blank: values in order, word next, blank last', 'sort-values', inDoc('| k | v |\n| - | - |\n| a | $1,200 |\n| b | -5 |\n| c | 30 |\n| d | €2.50 |\n| e |  |\n| f | apple |'), cell(2, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| b | -5 |\n| d | €2.50 |\n| c | 30 |\n| a | $1,200 |\n| f | apple |\n| e |  |')),
  menuCase('tables.sort.e02', 'Sort A to Z on month/day/year dates puts them in date order', 'sort-dates', inDoc(kv(['12/31/2023', '1/5/2024', '2/1/2023'])), cell(0, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| c | 2/1/2023 |\n| a | 12/31/2023 |\n| b | 1/5/2024 |')),
  undoCase('tables.sort.e03', 'Sort Z to A, then Cmd+Z in the grid and click away: the file is byte-identical', 'sort-undo', inDoc(T4), (S) => menuOn(S, cell(0, 1), 'Sort column Z to A')),
  {
    id: 'tables.sort.e04',
    feature: 'tables.sort',
    name: 'Sort A to Z on cells shown as bold, code and plain text orders them by the text on screen',
    run: async (S) => {
      await S.fresh('sort-marks', inDoc('| k | v |\n| - | - |\n| a | **b** |\n| b | a |\n| c | `c` |'));
      await menuOn(S, cell(0, 1), 'Sort column A to Z');
      const shown = await S.eval(() => [0, 1, 2].map((r) => document.querySelector(`.sheaf-table [data-r="${r}"][data-c="1"]`)?.textContent).join(','));
      await S.shot('sort-marks');
      await leave(S);
      const d = await S.disk();
      return all({ shown: shown === 'a,b,c', file: d === inDoc('| k | v |\n| - | - |\n| b | a |\n| a | **b** |\n| c | `c` |') }, { shown, d });
    },
  },
  menuCase('tables.sort.e05', 'Sort A to Z on 0.75, .5 and 0.25 orders them by value', 'sort-bare-decimal', inDoc(kv(['0.75', '.5', '0.25'])), cell(1, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| c | 0.25 |\n| b | .5 |\n| a | 0.75 |')),
  menuCase('tables.sort.e06', 'Sort A to Z keeps rows with equal values in their original order', 'sort-stable', inDoc(kv(['2', '1', '2', '1'])), cell(0, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| b | 1 |\n| d | 1 |\n| a | 2 |\n| c | 2 |')),
  menuCase('tables.sort.e07', 'Sort Z to A keeps a blank cell, then a row missing the cell, at the bottom as written', 'sort-blanks', inDoc('| k | v |\n| - | - |\n| a | 5 |\n| b |   |\n| c |\n| d | 1 |'), cell(0, 1), 'Sort column Z to A', inDoc('| k | v |\n| - | - |\n| a | 5 |\n| d | 1 |\n| b |   |\n| c |')),
  menuCase('tables.sort.e08', 'Sort A to Z on ISO dates puts them in date order', 'sort-iso', inDoc(kv(['2024-01-10', '2023-12-31', '2024-01-05'])), cell(0, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| b | 2023-12-31 |\n| c | 2024-01-05 |\n| a | 2024-01-10 |')),
  menuCase('tables.sort.e09', 'Sort A to Z on percentages orders them by value', 'sort-percent', inDoc(kv(['40%', '5%', '100%'])), cell(0, 1), 'Sort column A to Z', inDoc('| k | v |\n| - | - |\n| b | 5% |\n| a | 40% |\n| c | 100% |')),
  menuCase('tables.sort.e10', 'Sort Z to A on a ragged table writes only a reordering of its row lines', 'sort-ragged', inDoc('| Name | Score |\n|:--|--:|\n| zed |  3 |\n|amy|12|\n| Bo   | 7   |'), cell(0, 1), 'Sort column Z to A', inDoc('| Name | Score |\n|:--|--:|\n|amy|12|\n| Bo   | 7   |\n| zed |  3 |')),
  {
    id: 'tables.sort.e11',
    feature: 'tables.sort',
    name: 'A table with one body row offers no Sort in its menu',
    run: async (S) => {
      await S.fresh('sort-one-row', inDoc('| a | b |\n| - | - |\n| 1 | 2 |'));
      const items = await menuItems(S, cell(0, 0));
      return { ok: items.length > 0 && !items.some((l) => l.startsWith('Sort')), detail: JSON.stringify(items) };
    },
  },
  menuCase('tables.sort.e12', 'Sort Z to A on a table inside a list item keeps every row indented', 'sort-list', LIST, cell(0, 0), 'Sort column Z to A', LIST.replace('  | 1 | 2 |\n  | 3 | 4 |', '  | 3 | 4 |\n  | 1 | 2 |')),

  // ---- tables.align ---------------------------------------------------------
  {
    id: 'tables.align.e01',
    feature: 'tables.align',
    name: 'Right-click a header, Align column right: cells show right-aligned and only the delimiter cell changes',
    run: async (S) => {
      await S.fresh('align-right', inDoc(RAGGED));
      await menuOn(S, cell(-1, 0), 'Align column right');
      const aligned = await S.eval(() => getComputedStyle(document.querySelector('.sheaf-table [data-r="1"][data-c="0"]')).textAlign);
      await S.shot('align-right');
      await leave(S);
      const d = await S.disk();
      return all({ aligned: aligned === 'right', file: d === inDoc(RAGGED.replace('|---|:-:|', '|--:|:-:|')) }, { aligned, d });
    },
  },
  fileCase(
    'tables.align.e02',
    'Align a column, then double-click another row cell and retype it: only the delimiter and that row change',
    'align-then-edit',
    inDoc(RAGGED),
    async (S) => {
      await menuOn(S, cell(0, 1), 'Align column right');
      await S.dblclick(cell(1, 0));
      await S.type('kiwi');
      await S.press('Tab');
    },
    inDoc('| Fruit | Qty |\n|---|--:|\n| apple | 3 |\n| kiwi       |12|')
  ),
  menuCase('tables.align.e03', 'Clear column alignment on a centered column changes only its delimiter cell', 'align-clear', inDoc(RAGGED), cell(1, 1), 'Clear column alignment', inDoc(RAGGED.replace('|---|:-:|', '|---|---|'))),
  menuCase('tables.align.e04', 'Align column center on a one-dash delimiter cell writes :-: and nothing else', 'align-one-dash', inDoc('| a | b |\n|-|-|\n| 1 | 2 |'), cell(0, 0), 'Align column center', inDoc('| a | b |\n|:-:|-|\n| 1 | 2 |')),
  fileCase(
    'tables.align.e05',
    'Align column left, then Clear column alignment before leaving: the file is as written',
    'align-then-clear',
    inDoc(RAGGED),
    async (S) => {
      await menuOn(S, cell(0, 0), 'Align column left');
      await menuOn(S, cell(0, 0), 'Clear column alignment');
    },
    inDoc(RAGGED)
  ),
  {
    id: 'tables.align.e06',
    feature: 'tables.align',
    name: 'Clear column alignment shows in the menu only on a column that has an alignment',
    run: async (S) => {
      await S.fresh('align-clear-offered', inDoc(RAGGED));
      const plain = await menuItems(S, cell(0, 0));
      const centered = await menuItems(S, cell(0, 1));
      return all({ plainNoClear: !plain.includes('Clear column alignment'), centeredHasClear: centered.includes('Clear column alignment') }, { plain, centered });
    },
  },
  menuCase('tables.align.e07', 'Choosing Align column center on an already centered column leaves the file as written', 'align-same', inDoc(RAGGED), cell(0, 1), 'Align column center', inDoc(RAGGED)),
  menuCase('tables.align.e08', 'Align column right in a table without outer pipes changes only that delimiter cell', 'align-outerless', inDoc('a | b\n--|--\n1 | 2'), cell(0, 1), 'Align column right', inDoc('a | b\n--|-:\n1 | 2')),
  menuCase('tables.align.e09', 'Align column center in a table inside a list item keeps the delimiter row indented', 'align-list', LIST, cell(0, 0), 'Align column center', LIST.replace('  | - | - |', '  | :-: | - |')),
  undoCase('tables.align.e10', 'Align column right, click away, then Cmd+Z in the text: the file is byte-identical', 'align-undo', inDoc(RAGGED), (S) => menuOn(S, cell(0, 0), 'Align column right'), { leaveFirst: true }),
  fileCase(
    'tables.align.e11',
    'Insert column right, then Align column right on the new column: its new delimiter cell is right-aligned',
    'align-new-col',
    inDoc(RAGGED),
    async (S) => {
      await menuOn(S, cell(0, 1), 'Insert column right');
      await menuOn(S, cell(0, 2), 'Align column right');
    },
    inDoc('| Fruit | Qty |     |\n|---|:-:| --: |\n| apple | 3 |     |\n| kiwi fruit |12|     |')
  ),

  // ---- tables.pad -----------------------------------------------------------
  {
    id: 'tables.pad.e01',
    feature: 'tables.pad',
    name: 'Pad columns on a table with CJK, a pictograph emoji and an escaped pipe lines up every pipe in the file',
    run: async (S) => {
      await S.fresh('pad-cjk', inDoc('| name | icon |\n|-|:-:|\n| 東京 | 🍎 |\n| a \\| b | x |'));
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      const lines = tableLines(d);
      return all({ linedUp: linedUp(lines), fourLines: lines.length === 4, center: /\|\s*:-+:\s*\|$/.test(lines[1] ?? ''), around: d.startsWith('Intro text.\n\n') && d.endsWith('\n\nAfter text.\n') }, d);
    },
  },
  {
    id: 'tables.pad.e02',
    feature: 'tables.pad',
    name: 'Pad columns on a table with ✅ and ⭐ lines up every pipe in the file',
    run: async (S) => {
      await S.fresh('pad-emoji', inDoc('| s | n |\n|-|-|\n| ✅ | 1 |\n| ⭐ | 2 |\n| ok | 3 |'));
      await menuOn(S, cell(2, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      return { ok: linedUp(tableLines(d)), detail: d };
    },
  },
  menuCase('tables.pad.e03', 'Pad columns on a table inside a list item keeps every line indented under the item', 'pad-list', 'Intro text.\n\n- item\n\n  | a | bbbb |\n  |-|-|\n  | ccc | d |\n\nAfter text.\n', cell(0, 0), 'Pad columns to line up', 'Intro text.\n\n- item\n\n  | a   | bbbb |\n  | --- | ---- |\n  | ccc | d    |\n\nAfter text.\n'),
  undoCase('tables.pad.e04', 'Pad columns, then Cmd+Z in the grid: the file is byte-identical', 'pad-undo', inDoc(RAGGED), (S) => menuOn(S, cell(0, 0), 'Pad columns to line up')),
  {
    id: 'tables.pad.e05',
    feature: 'tables.pad',
    name: 'Pad columns on a two-column table whose row has text past the last column keeps two columns on screen and in the header',
    run: async (S) => {
      await S.fresh('pad-extra', inDoc('| a | b |\n|-|-|\n| 1 | 2 | extra |'));
      const before = await S.eval(() => document.querySelectorAll('.sheaf-table th[data-r="-1"]').length);
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      await S.sleep(300);
      const after = await S.eval(() => document.querySelectorAll('.sheaf-table th[data-r="-1"]').length);
      await S.shot('pad-extra');
      await leave(S);
      const d = await S.disk();
      return all({ columnsOnScreen: before === 2 && after === 2, headerTwoCells: gfmCells(d.split('\n')[2] ?? '').length === 2, extraKept: d.includes('extra') }, { before, after, d });
    },
  },
  {
    id: 'tables.pad.e06',
    feature: 'tables.pad',
    name: 'Pad columns on a table with an accent typed as a combining mark lines up every pipe',
    run: async (S) => {
      await S.fresh('pad-combining', inDoc('| word | n |\n|-|-|\n| café | 1 |\n| cafes | 2 |'));
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      return { ok: linedUp(tableLines(d)), detail: d };
    },
  },
  {
    id: 'tables.pad.e07',
    feature: 'tables.pad',
    name: 'Pad columns on a table without outer pipes lines it up and it still shows as a grid',
    run: async (S) => {
      await S.fresh('pad-outerless', inDoc('a | bb\n--|--\nccc | d'));
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      await S.sleep(300);
      const lines = d.split('\n').slice(2, 5);
      return all({ linedUp: linedUp(lines), cells: JSON.stringify(lines.filter((_, i) => i !== 1).map(gfmCells)) === JSON.stringify([['a', 'bb'], ['ccc', 'd']]), grid: await S.exists('.sheaf-table') }, d);
    },
  },
  menuCase('tables.pad.e08', 'Pad columns on an already padded table leaves the file as written', 'pad-noop', inDoc(PADDED), cell(0, 0), 'Pad columns to line up', inDoc(PADDED)),
  {
    id: 'tables.pad.e09',
    feature: 'tables.pad',
    name: 'Pad columns on a table with a row shorter than the header gives that row every cell, lined up',
    run: async (S) => {
      await S.fresh('pad-short-row', inDoc('| a | bbb |\n|-|-|\n| 1 |'));
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      const lines = tableLines(d);
      return all({ linedUp: linedUp(lines), rowCells: gfmCells(lines[2] ?? '').length === 2 }, d);
    },
  },
  {
    id: 'tables.pad.e10',
    feature: 'tables.pad',
    name: 'Pad columns from a header cell of a header-only table lines up the header and delimiter',
    run: async (S) => {
      await S.fresh('pad-header-only', inDoc('| long header | b |\n|-|-|'));
      await menuOn(S, cell(-1, 0), 'Pad columns to line up');
      await leave(S);
      const d = await S.disk();
      return all({ linedUp: linedUp(tableLines(d)), changed: d !== inDoc('| long header | b |\n|-|-|') }, d);
    },
  },

  // ---- tables.copy-ref ------------------------------------------------------
  // A ref carries the line it names, so a single row quotes its own source line.
  refCase('tables.copy-ref.e01', 'Right-click a body row, Copy ref: the clipboard names that row line and quotes it', 'ref-row', inDoc(T4), async () => {}, cell(2, 1), '7 (v, row 3)\n\n```\n3\n```\n'),
  refCase(
    'tables.copy-ref.e02',
    'Click row number 1, Shift-click 3, right-click inside, Copy ref: the range and those rows reach the clipboard',
    'ref-rows',
    inDoc(T4),
    async (S) => {
      await S.click(gutter(0));
      await S.click(gutter(2), { modifiers: ['Shift'] });
    },
    cell(1, 0),
    '5-7 (rows 1 to 3)\n\n```\n| a | 1 |\n| b | 2 |\n| c | 3 |\n```\n'
  ),
  {
    id: 'tables.copy-ref.e03',
    feature: 'tables.copy-ref',
    name: 'Drag row 1 below row 3, Copy ref on it, click away: the ref names the line the row is saved on',
    run: async (S) => {
      await S.fresh('ref-after-drag', inDoc(T4));
      await S.click(gutter(0));
      await S.drag(gutter(0), cell(2, 1));
      const ref = await copyRef(S, cell(2, 0));
      await leave(S);
      const d = await S.disk();
      const line = Number((/:(\d+)[ \n]/.exec(ref) ?? [])[1]);
      return all(
        // The drag leaves the moved row selected, so the ref is the row's: its number and its line.
        { ref: ref === 'e2e/ref-after-drag.md:7 (row 3)\n\n```\n| a | 1 |\n```\n', lineHoldsRow: d.split('\n')[line - 1] === '| a | 1 |' },
        { ref, d }
      );
    },
  },
  {
    id: 'tables.copy-ref.e04',
    feature: 'tables.copy-ref',
    name: 'After an outside change adds two lines above the table, Copy ref names the row new line',
    run: async (S) => {
      const path = await S.fresh('ref-after-outside', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      await outside(S, path, '# Agent\n\n' + inDoc(T4), '# Agent');
      return same(await copyRef(S, cell(0, 0)), 'e2e/ref-after-outside.md:7 (n, row 1)\n\n```\na\n```\n');
    },
  },
  // Right-clicking a header picks that column, and the ref quotes that column alone: the range
  // names the lines the column touches, the quote shows what was picked.
  refCase(
    'tables.copy-ref.e05',
    'Right-click a header cell, Copy ref: the range names the column lines and the quote holds only that column',
    'ref-header',
    inDoc(T4),
    async () => {},
    cell(-1, 1),
    '3-8 (v column)\n\n```\n| v   |\n| --- |\n| 1   |\n| 2   |\n| 3   |\n| 4   |\n```\n'
  ),
  // Reaching both columns leaves nothing out, so the quote is the file's own text.
  refCase(
    'tables.copy-ref.e06',
    'Click a cell in row 2, Shift-click the other header, Copy ref inside: every column is picked, so the quote is the file',
    'ref-from-header',
    inDoc(T4),
    async (S) => {
      await S.click(cell(1, 1));
      await S.click(cell(-1, 0), { modifiers: ['Shift'] });
    },
    cell(0, 0),
    '3-8\n\n```\n| n | v |\n| - | - |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |\n```\n'
  ),
  {
    id: 'tables.copy-ref.e13',
    feature: 'tables.copy-ref',
    name: 'Cells picked one at a time with Cmd-click: the quote holds those cells and leaves the ones between them empty',
    run: async (S) => {
      await S.fresh('ref-scattered', inDoc(T4));
      await S.click(cell(0, 0));
      await S.click(cell(2, 1), { modifiers: ['Meta'] });
      const ref = await copyRef(S, cell(2, 1));
      return same(ref, 'e2e/ref-scattered.md:5-7 (n to v, rows 1 to 3)\n\n```\n| a |   |\n|   |   |\n|   | 3 |\n```\n');
    },
  },
  refCase('tables.copy-ref.e07', 'Insert row below, then Copy ref on the new row: it names the line the row will be saved on', 'ref-inserted', inDoc(T4), (S) => menuOn(S, cell(0, 0), 'Insert row below'), cell(1, 0), '6 (n, row 2)\n'),
  refCase('tables.copy-ref.e08', 'Sort Z to A, then Copy ref on row a, now last: it names the last row line', 'ref-after-sort', inDoc(T4), (S) => menuOn(S, cell(0, 1), 'Sort column Z to A'), cell(3, 0), '8 (n, row 4)\n\n```\na\n```\n'),
  refCase('tables.copy-ref.e09', 'Copy ref on a row of a table inside a list item names that row line', 'ref-list', LIST, async () => {}, cell(1, 1), '8 (b, row 2)\n\n```\n4\n```\n'),
  refCase(
    'tables.copy-ref.e10',
    'Copy ref on two rows holding triple backticks fences them with four backticks',
    'ref-backticks',
    inDoc('| k | v |\n| - | - |\n| ```x``` | 1 |\n| b | 2 |'),
    async (S) => {
      await S.click(gutter(0));
      await S.click(gutter(1), { modifiers: ['Shift'] });
    },
    cell(0, 1),
    '5-6 (rows 1 to 2)\n\n````\n| ```x``` | 1 |\n| b | 2 |\n````\n'
  ),
  refCase('tables.copy-ref.e11', 'Right-click row number 4, Copy ref: the clipboard names that row line', 'ref-gutter', inDoc(T4), async () => {}, gutter(3), '8 (row 4)\n\n```\n| d | 4 |\n```\n'),
  refCase('tables.copy-ref.e12', 'Delete row 1, then Copy ref on row c: it names the line c will be saved on', 'ref-after-delete', inDoc(T4), (S) => menuOn(S, cell(0, 0), 'Delete row'), cell(1, 0), '6 (n, row 2)\n\n```\nc\n```\n'),

  // ---- tables.row-lines -----------------------------------------------------
  {
    id: 'tables.row-lines.e01',
    feature: 'tables.row-lines',
    name: 'Hovering row numbers and the corner of a table in a list item names their file lines',
    run: async (S) => {
      await S.fresh('lines-hover', LIST);
      await S.hover(gutter(1));
      const t = await S.eval(() => [...document.querySelectorAll('.sheaf-table-gutter, .sheaf-table-corner')].map((g) => g.title));
      return same(t.join(' / '), 'Select whole table (header on line 5) / Select row (line 7) / Select row (line 8)');
    },
  },
  {
    id: 'tables.row-lines.e02',
    feature: 'tables.row-lines',
    name: 'After an outside change adds two lines above the table, hovering a row number names its new line',
    run: async (S) => {
      const path = await S.fresh('lines-after-outside', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      await outside(S, path, '# Agent\n\n' + inDoc(T4), '# Agent');
      await S.hover(gutter(0));
      const t = await S.eval(() => document.querySelector('.sheaf-table tbody .sheaf-table-gutter')?.title);
      return same(t, 'Select row (line 7)');
    },
  },
  {
    id: 'tables.row-lines.e03',
    feature: 'tables.row-lines',
    name: 'After dragging row 1 below row 2, hovering the moved row names the line it will be saved on',
    run: async (S) => {
      await S.fresh('lines-after-drag', inDoc(T4));
      await S.drag(gutter(0), cell(1, 1));
      await S.hover(gutter(1));
      const t = await S.eval(() => document.querySelectorAll('.sheaf-table tbody .sheaf-table-gutter')[1]?.title);
      return same(t, 'Select row (line 6)');
    },
  },
  {
    id: 'tables.row-lines.e04',
    feature: 'tables.row-lines',
    name: 'After an outside change removes the two lines above the table, hovering a row number names its new line',
    run: async (S) => {
      const path = await S.fresh('lines-after-removal', inDoc(T4));
      await S.click({ text: 'After', offset: 2 });
      writeFileSync(path, T4 + '\n\nAfter text.\n');
      for (let i = 0; i < 100 && (await S.state()).doc.includes('Intro'); i++) await S.sleep(50);
      await S.hover(gutter(3));
      const t = await S.eval(() => [...document.querySelectorAll('.sheaf-table tbody .sheaf-table-gutter')].map((g) => g.title));
      return same(t.join(' / '), 'Select row (line 3) / Select row (line 4) / Select row (line 5) / Select row (line 6)');
    },
  },
  {
    id: 'tables.row-lines.e05',
    feature: 'tables.row-lines',
    name: 'A row inserted from the menu is in the file at once, and its row number names its line before and after leaving the table',
    run: async (S) => {
      // Insert row is written as it is made, so the new row has a line straight away; the
      // "not saved yet" label is for a row with no line of its own in the file.
      await S.fresh('lines-inserted', inDoc(T4));
      await menuOn(S, cell(0, 0), 'Insert row below');
      const written = await S.disk();
      await S.hover(gutter(1));
      const now = await S.eval(() => document.querySelectorAll('.sheaf-table tbody .sheaf-table-gutter')[1]?.title);
      await leave(S);
      await S.hover(gutter(1));
      const after = await S.eval(() => document.querySelectorAll('.sheaf-table tbody .sheaf-table-gutter')[1]?.title);
      const lines = written.split('\n');
      const inFile = lines.length === inDoc(T4).split('\n').length + 1 && /^\|\s*\|\s*\|\s*$/.test(lines[5]);
      return all({ inFile, now: now === 'Select row (line 6)', after: after === 'Select row (line 6)' }, { now, after, line6: lines[5] });
    },
  },

  // ---- tables.change-flash --------------------------------------------------
  {
    id: 'tables.change-flash.e01',
    feature: 'tables.change-flash',
    name: 'An outside change to one row marks that row and no other',
    run: async (S) => {
      const path = await S.fresh('flash-one', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      const m = await outside(S, path, inDoc(T4.replace('| c | 3 |', '| c | 33 |')), '| c | 33 |');
      await S.shot('flash-one');
      return same(JSON.stringify(m), JSON.stringify([['c|33']]));
    },
  },
  {
    id: 'tables.change-flash.e02',
    feature: 'tables.change-flash',
    name: 'An outside change that appends a row marks only the new row',
    run: async (S) => {
      const path = await S.fresh('flash-append', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      const m = await outside(S, path, inDoc(T4 + '\n| e | 5 |'), '| e | 5 |');
      return same(JSON.stringify(m), JSON.stringify([['e|5']]));
    },
  },
  {
    id: 'tables.change-flash.e03',
    feature: 'tables.change-flash',
    name: 'Editing a cell in Sheaf and clicking away marks no row',
    run: async (S) => {
      await S.fresh('flash-own', inDoc(T4));
      await S.dblclick(cell(1, 1));
      await S.type('22');
      await S.press('Tab');
      await leave(S);
      const d = await S.disk();
      const seen = await marksOverASecond(S);
      return all({ written: d.includes('| b | 22 |'), none: seen.length === 0 }, { seen, d });
    },
  },
  {
    id: 'tables.change-flash.e04',
    feature: 'tables.change-flash',
    name: 'An outside change to the header marks the header row and no body row',
    run: async (S) => {
      const path = await S.fresh('flash-header', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      const m = await outside(S, path, inDoc(T4.replace('| n | v |', '| name | v |')), '| name |');
      return same(JSON.stringify(m), JSON.stringify([['name|v']]));
    },
  },
  {
    id: 'tables.change-flash.e05',
    feature: 'tables.change-flash',
    name: 'An outside change that deletes a row marks nothing',
    run: async (S) => {
      const path = await S.fresh('flash-delete', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      writeFileSync(path, inDoc(T4.replace('| b | 2 |\n', '')));
      for (let i = 0; i < 100 && (await S.state()).doc.includes('| b | 2 |'); i++) await S.sleep(50);
      const seen = await marksOverASecond(S);
      return { ok: seen.length === 0, detail: JSON.stringify(seen) };
    },
  },
  {
    id: 'tables.change-flash.e06',
    feature: 'tables.change-flash',
    name: 'An outside change to the second of two tables marks its row and nothing in the first',
    run: async (S) => {
      const two = inDoc(T4 + '\n\n| x | y |\n| - | - |\n| 1 | 2 |');
      const path = await S.fresh('flash-two-tables', two);
      await S.click({ text: 'Intro', offset: 2 });
      const m = await outside(S, path, two.replace('| 1 | 2 |', '| 1 | 9 |'), '| 1 | 9 |');
      return same(JSON.stringify(m), JSON.stringify([[], ['1|9']]));
    },
  },
  {
    id: 'tables.change-flash.e07',
    feature: 'tables.change-flash',
    name: 'Pad columns chosen from the menu marks no row',
    run: async (S) => {
      await S.fresh('flash-pad', inDoc(RAGGED));
      await menuOn(S, cell(0, 0), 'Pad columns to line up');
      const seen = await marksOverASecond(S);
      const d = await S.disk();
      return all({ padded: d !== inDoc(RAGGED), none: seen.length === 0 }, { seen, d });
    },
  },
  {
    id: 'tables.change-flash.e08',
    feature: 'tables.change-flash',
    name: 'Retype a cell, and the file is then written from text read before it: the row the tool changed is marked and the notice names the cell',
    run: async (S) => {
      const path = await S.fresh('flash-while-editing', inDoc(T4));
      await S.dblclick(cell(0, 1));
      await S.type('X');
      await S.press('Tab');
      await S.disk(path);
      const m = await outside(S, path, inDoc(T4.replace('| c | 3 |', '| c | 33 |')), '| c | 33 |');
      await S.sleep(300);
      const said = await toasts(S);
      // The row the tool wrote is marked, as any change from outside is. Row a is
      // marked too, because the same write put `1` back where `X` had been, and the
      // notice is what says that one was the person's own.
      return all({ marked: m.flat().includes('c|33'), said: saidItTook(said, 'X') }, { m, said });
    },
  },
  {
    id: 'tables.change-flash.e09',
    feature: 'tables.change-flash',
    name: 'A mark fades, and an Insert row afterwards marks nothing again',
    run: async (S) => {
      const path = await S.fresh('flash-spent', inDoc(T4));
      await S.click({ text: 'Intro', offset: 2 });
      const m = await outside(S, path, inDoc(T4.replace('| c | 3 |', '| c | 33 |')), '| c | 33 |');
      await S.sleep(3000);
      const faded = (await marks(S)).flat();
      await menuOn(S, cell(0, 0), 'Insert row above');
      const redraw = await marksOverASecond(S);
      return all({ marked: JSON.stringify(m) === JSON.stringify([['c|33']]), faded: faded.length === 0, redraw: redraw.length === 0 }, { m, faded, redraw });
    },
  },

  // ---- tables.outside-merge -------------------------------------------------
  {
    id: 'tables.outside-merge.e01',
    feature: 'tables.outside-merge',
    name: 'Retype a cell, and the file is then written from text read before it: the notice names the cell and Undo brings it back',
    run: async (S) => {
      const path = await S.fresh('merge-other-row', inDoc(T4));
      await S.dblclick(cell(0, 1));
      await S.type('X');
      await S.press('Tab');
      const said = await staleWrite(S, path, inDoc(T4.replace('| d | 4 |', '| d | 44 |')), '| d | 44 |');
      // The write wins, the way it does in any editor. What is new is being told.
      const gone = (await S.state()).doc;
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('| a | X |'),
          said: saidItTook(said, 'X'),
          back: d === inDoc(T4.replace('| a | 1 |', '| a | X |')),
        },
        { said, gone, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e02',
    feature: 'tables.outside-merge',
    name: 'Retype a cell, and a row is then appended from text read before it: the notice names the cell and Undo brings it back',
    run: async (S) => {
      const path = await S.fresh('merge-append', inDoc(T4));
      await S.dblclick(cell(0, 1));
      await S.type('X');
      await S.press('Tab');
      const said = await staleWrite(S, path, inDoc(T4 + '\n| e | 5 |'), '| e | 5 |');
      const gone = (await S.state()).doc;
      await S.shot('merge-append');
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('| a | X |'),
          said: saidItTook(said, 'X'),
          back: d === inDoc(T4.replace('| a | 1 |', '| a | X |')),
        },
        { said, gone, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e03',
    feature: 'tables.outside-merge',
    name: 'Retype row a, and the rows are then swapped from text read before it: the notice names the cell and Undo brings it back',
    run: async (S) => {
      const path = await S.fresh('merge-swap', inDoc(T8));
      await S.dblclick(cell(0, 1));
      await S.type('X');
      await S.press('Tab');
      const swapped = inDoc(T8.replace('| a | 1 |\n| b | 2 |', '| b | 2 |\n| a | 1 |'));
      const said = await staleWrite(S, path, swapped, '| b | 2 |\n| a | 1 |');
      const gone = (await S.state()).doc;
      await S.shot('merge-swap');
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('| a | X |'),
          said: saidItTook(said, 'X'),
          // Undo takes the whole write back, so the rows are in the order they were in
          // and the edit is on row a again.
          back: d === inDoc(T8.replace('| a | 1 |', '| a | X |')),
        },
        { said, rows: tableLines(gone).slice(2, 4), d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e04',
    feature: 'tables.outside-merge',
    name: 'Insert row below, and the file is then written from text read before it: the notice says a change went and Undo brings the row back',
    run: async (S) => {
      // Nobody typed here. An inserted row is still the person's own work, and a write
      // made before it takes it back the same way a paragraph is taken back.
      const path = await S.fresh('merge-structural', inDoc(T4));
      await menuOn(S, cell(0, 0), 'Insert row below');
      const said = await staleWrite(S, path, inDoc(T4.replace('| d | 4 |', '| d | 44 |')), '| d | 44 |');
      const gone = (await S.state()).doc;
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('|   |   |'),
          said: saidSomethingWasTaken(said),
          back: d === inDoc(T4.replace('| a | 1 |', '| a | 1 |\n|   |   |')),
        },
        { said, gone, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e05',
    feature: 'tables.outside-merge',
    name: 'Retype a cell, and a line is then added below the table from text read before it: the notice names the cell and Undo brings it back',
    run: async (S) => {
      const path = await S.fresh('merge-below', inDoc(T4));
      await S.dblclick(cell(1, 1));
      await S.type('X');
      await S.press('Tab');
      const said = await staleWrite(S, path, inDoc(T4) + 'More.\n', 'More.');
      const gone = (await S.state()).doc;
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: !gone.includes('| b | X |'),
          said: saidItTook(said, 'X'),
          back: d === inDoc(T4.replace('| b | 2 |', '| b | X |')),
        },
        { said, gone, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e06',
    feature: 'tables.outside-merge',
    name: 'Retype a cell, and the file is then written with another value in that same cell: the notice names what was typed and Undo brings it back',
    run: async (S) => {
      const path = await S.fresh('merge-same-cell', inDoc(T4));
      await S.dblclick(cell(0, 1));
      await S.type('X');
      await S.press('Tab');
      const said = await staleWrite(S, path, inDoc(T4.replace('| a | 1 |', '| a | 7 |')), '| a | 7 |');
      const gone = (await S.state()).doc;
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: gone.includes('| a | 7 |'),
          said: saidItTook(said, 'X'),
          back: d === inDoc(T4.replace('| a | 1 |', '| a | X |')),
        },
        { said, gone, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e07',
    feature: 'tables.outside-merge',
    name: 'Right-click a row and the file is then written from outside: nobody typed, so nothing is said, and Move row down still works on what the file now holds',
    run: async (S) => {
      const path = await S.fresh('merge-menu-open', inDoc(T4));
      await S.rightClick(cell(0, 0));
      const said = await staleWrite(S, path, inDoc(T4.replace('| d | 4 |', '| d | 44 |')), '| d | 44 |');
      await menuOn(S, cell(0, 0), 'Move row down');
      await leave(S);
      const d = await S.disk(path);
      return all(
        {
          silent: said.length === 0,
          moved: d === inDoc('| n | v |\n| - | - |\n| b | 2 |\n| a | 1 |\n| c | 3 |\n| d | 44 |'),
        },
        { said, d }
      );
    },
  },
  {
    id: 'tables.outside-merge.e08',
    feature: 'tables.outside-merge',
    name: 'Sort Z to A, and the file is then written from text read before it: the notice says a change went and Undo brings the sort back',
    run: async (S) => {
      const path = await S.fresh('merge-sort', inDoc(T4));
      // Sorted from the first column, not the last. Both put the rows in the same order
      // here, and a right-click on a cell that is not already fully scrolled into view
      // opens the menu and a scroll closes it again in the same frame, so nothing is
      // there to click. The last column is the one that is short of visible, which is
      // what every scenario under tables.sort runs into.
      await menuOn(S, cell(0, 0), 'Sort column Z to A');
      const unsorted = inDoc(T4.replace('| a | 1 |', '| A | 1 |'));
      const said = await staleWrite(S, path, unsorted, '| A | 1 |');
      const gone = (await S.state()).doc;
      await pressUndo(S);
      const d = await S.disk(path);
      return all(
        {
          took: gone === unsorted,
          said: saidSomethingWasTaken(said),
          back: d === inDoc('| n | v |\n| - | - |\n| d | 4 |\n| c | 3 |\n| b | 2 |\n| a | 1 |'),
        },
        { said, gone, d }
      );
    },
  },

  // ---- tables.paste-range ---------------------------------------------------
  {
    id: 'tables.paste-range.e01',
    feature: 'tables.paste-range',
    name: 'Copy a spreadsheet range, click in a paragraph, Cmd+V: a padded table lands after it, opened on its first header cell',
    run: async (S) => {
      await S.fresh('paste-range', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('Name\tQty\nfig\t7\napple\t12');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      await S.sleep(300);
      const focus = await S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus');
        return f ? `${f.dataset.r},${f.dataset.c}` : null;
      });
      await S.shot('paste-range');
      const d = await S.disk();
      return all({ file: d === 'Intro text.\n\n| Name  | Qty |\n| ----- | --: |\n| fig   | 7   |\n| apple | 12  |\n\nAfter text.\n', focus: focus === '-1,0' }, { focus, d });
    },
  },
  {
    id: 'tables.paste-range.e02',
    feature: 'tables.paste-range',
    name: 'A range copied with Windows line endings and a trailing line break pastes the same table',
    run: async (S) => {
      await S.fresh('paste-range-crlf', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('Name\tQty\r\nfig\t7\r\napple\t12\r\n');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      return same(await S.disk(), 'Intro text.\n\n| Name  | Qty |\n| ----- | --: |\n| fig   | 7   |\n| apple | 12  |\n\nAfter text.\n');
    },
  },
  {
    id: 'tables.paste-range.e03',
    feature: 'tables.paste-range',
    name: 'Drag-select a word and Cmd+V a range: the selected word is replaced',
    run: async (S) => {
      await S.fresh('paste-range-over', 'Say hello now.\n\nAfter text.\n');
      await S.clipboard.write('a\tb\n1\t2');
      await S.select('hello');
      await S.press('Meta+v');
      const d = await S.disk();
      return all({ table: d.includes('| a   | b   |'), replaced: !d.includes('hello') }, d);
    },
  },
  {
    id: 'tables.paste-range.e04',
    feature: 'tables.paste-range',
    name: 'Paste a range, then Cmd+Z right away: the file is byte-identical',
    run: async (S) => {
      await S.fresh('paste-range-undo', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('a\tb\n1\t2');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      const pasted = await S.disk();
      await S.press('Meta+z');
      const editor = (await S.state().catch(() => ({}))).doc;
      const undone = await S.disk();
      return all({ pasted: pasted.includes('| a   | b   |'), undone: undone === 'Intro text.\n\nAfter text.\n' }, { pasted, editorAfterUndo: editor, undone });
    },
  },
  {
    id: 'tables.paste-range.e05',
    feature: 'tables.paste-range',
    name: 'A range with a quoted multi-line cell pastes as a two-row table with that cell whole',
    run: async (S) => {
      await S.fresh('paste-range-multiline', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('Name\tNote\nfig\t"line one\nline two"\napple\tok');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      const d = await S.disk();
      const rows = tableLines(d).slice(2);
      return all({ twoRows: rows.length === 2, whole: (rows[0] ?? '').includes('line one') && (rows[0] ?? '').includes('line two') }, d);
    },
  },
  {
    id: 'tables.paste-range.e06',
    feature: 'tables.paste-range',
    name: 'A range whose amounts carry currency signs pastes with that column right-aligned on screen and in the file',
    run: async (S) => {
      await S.fresh('paste-range-currency', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('Item\tCost\nTea\t$4.50\nCake\t$12.00');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      await S.sleep(300);
      const align = await S.eval(() => {
        const c = document.querySelector('.sheaf-table [data-r="0"][data-c="1"]');
        return c ? getComputedStyle(c).textAlign : null;
      });
      await S.shot('paste-range-currency');
      const d = await S.disk();
      return all({ screen: align === 'right', file: /:\s*\|$/.test(d.split('\n')[3] ?? '') }, { align, d });
    },
  },
  {
    id: 'tables.paste-range.e07',
    feature: 'tables.paste-range',
    name: 'Click a paragraph, arrow down to the blank line under it, Cmd+V a range: the table sits between the paragraphs',
    run: async (S) => {
      await S.fresh('paste-range-blank-line', 'One text.\n\n\nTwo text.\n');
      await S.clipboard.write('Name\tQty\nfig\t7\napple\t12');
      await S.caret('One', 1);
      await S.press('ArrowDown');
      await S.press('Meta+v');
      return same(await S.disk(), 'One text.\n\n| Name  | Qty |\n| ----- | --: |\n| fig   | 7   |\n| apple | 12  |\n\nTwo text.\n');
    },
  },
  {
    id: 'tables.paste-range.e08',
    feature: 'tables.paste-range',
    name: 'A range with empty cells, one of them at the end of a row, keeps them as empty cells',
    run: async (S) => {
      await S.fresh('paste-range-empty', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('a\tb\tc\n1\t\t3\n\t2\t');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      return same(await S.disk(), 'Intro text.\n\n| a   | b   | c   |\n| --: | --: | --: |\n| 1   |     | 3   |\n|     | 2   |     |\n\nAfter text.\n');
    },
  },
  {
    id: 'tables.paste-range.e09',
    feature: 'tables.paste-range',
    name: 'Pasting a single column of lines gives text, not a table',
    run: async (S) => {
      await S.fresh('paste-range-column', 'Intro text.\n\nAfter text.\n');
      await S.clipboard.write('red\ngreen\nblue');
      await S.caret('Intro', 2);
      await S.press('Meta+v');
      const d = await S.disk();
      return all({ pasted: d.includes('green'), noTable: !d.includes('|') && !(await S.exists('.sheaf-table')) }, d);
    },
  },

  // ---- tables.insert-new ----------------------------------------------------
  fileCase(
    'tables.insert-new.e01',
    'Insert > Markdown table from a paragraph, type a header, click away: the table sits after the paragraph',
    'insert-toolbar',
    'Intro text.\n\nAfter text.\n',
    async (S) => {
      await S.caret('Intro', 2);
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      await S.type('Name');
      await S.shot('insert-toolbar');
    },
    'Intro text.\n\n' + SKELETON.replace('| Column 1 |', '| Name     |') + '\n\nAfter text.\n'
  ),
  {
    id: 'tables.insert-new.e02',
    feature: 'tables.insert-new',
    name: 'Typing " /table" at the end of a paragraph and clicking Table inserts the table and removes only "/table" from the paragraph',
    run: async (S) => {
      await S.fresh('insert-slash', 'Intro text.\n\nAfter text.\n');
      await S.caret('text', 2);
      await S.press('End');
      await S.type(' /table');
      await S.sleep(300);
      await S.click({ sel: '.sheaf-slash-item', hasText: 'Table' });
      await S.sleep(300);
      // The space typed before the slash is the person's own text and stays.
      return same(await S.disk(), 'Intro text. \n\n' + SKELETON + '\n\nAfter text.\n');
    },
  },
  {
    id: 'tables.insert-new.e03',
    feature: 'tables.insert-new',
    name: 'Insert > Markdown table on the empty last line of a file keeps the file ending in a line break',
    run: async (S) => {
      await S.fresh('insert-eof', 'para text\n');
      await S.caret('para', 2);
      await S.press('ArrowDown');
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      return same(await S.disk(), 'para text\n\n' + SKELETON + '\n');
    },
  },
  {
    id: 'tables.insert-new.e04',
    feature: 'tables.insert-new',
    name: 'Insert > Markdown table, then Cmd+Z in the new grid: the file is byte-identical',
    run: async (S) => {
      await S.fresh('insert-undo', 'Intro text.\n\nAfter text.\n');
      await S.caret('Intro', 2);
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      const inserted = await S.disk();
      await S.press('Meta+z');
      const editor = (await S.state().catch(() => ({}))).doc;
      const undone = await S.disk();
      return all({ inserted: inserted.includes('Column 1'), undone: undone === 'Intro text.\n\nAfter text.\n' }, { inserted, editorAfterUndo: editor, undone });
    },
  },
  {
    id: 'tables.insert-new.e05',
    feature: 'tables.insert-new',
    name: 'Insert > Markdown table with the caret in a list item puts the table after the list and leaves the list alone',
    run: async (S) => {
      await S.fresh('insert-list', 'Intro text.\n\n- one\n- two\n\nAfter text.\n');
      await S.caret('one', 1);
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      return same(await S.disk(), 'Intro text.\n\n- one\n- two\n\n' + SKELETON + '\n\nAfter text.\n');
    },
  },
  {
    id: 'tables.insert-new.e06',
    feature: 'tables.insert-new',
    name: 'Insert > Markdown table in the paragraph above another table keeps the two tables apart',
    run: async (S) => {
      await S.fresh('insert-above-table', 'Intro text.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
      await S.caret('Intro', 2);
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      const d = await S.disk();
      await S.sleep(300);
      const grids = await S.eval(() => document.querySelectorAll('.sheaf-table').length);
      return all({ file: d === 'Intro text.\n\n' + SKELETON + '\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', twoGrids: grids === 2 }, { grids, d });
    },
  },
  {
    id: 'tables.insert-new.e07',
    feature: 'tables.insert-new',
    name: 'Click into an empty file, Insert > Markdown table: the file holds just the table and its first header cell is active',
    run: async (S) => {
      await S.fresh('insert-empty', '');
      await S.click('.cm-content');
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      const focus = await S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus');
        return f ? `${f.dataset.r},${f.dataset.c}` : null;
      });
      const d = await S.disk();
      return all({ file: d === SKELETON, focus: focus === '-1,0' }, { focus, d });
    },
  },
  {
    id: 'tables.insert-new.e08',
    feature: 'tables.insert-new',
    name: 'Insert > Markdown table with the caret in a heading puts the table after the heading with blank lines around it',
    run: async (S) => {
      await S.fresh('insert-heading', '# Title here\nText\n');
      await S.caret('Title', 2);
      await S.toolbar('Insert');
      await S.menu('Markdown table');
      return same(await S.disk(), '# Title here\n\n' + SKELETON + '\n\nText\n');
    },
  },

  // ---- tables.shapes --------------------------------------------------------
  menuCase('tables.shapes.e01', 'A table inside a list item: right-click, Insert row below adds one indented line', 'shape-list', LIST, cell(0, 1), 'Insert row below', LIST.replace('  | 1 | 2 |\n', '  | 1 | 2 |\n  |   |   |\n')),
  fileCase('tables.shapes.e02', 'A table without outer pipes: drag row number 1 below row 2 and only the two lines swap', 'shape-outerless', inDoc('a | b\n--|--\n1 | 2\n3 | 4'), async (S) => {
    await S.click(gutter(0));
    await S.drag(gutter(0), cell(1, 1));
  }, inDoc('a | b\n--|--\n3 | 4\n1 | 2')),
  {
    id: 'tables.shapes.e03',
    feature: 'tables.shapes',
    name: 'A table without outer pipes inside a list item: Insert row below keeps the new row indented',
    run: async (S) => {
      await S.fresh('shape-list-outerless', 'Intro text.\n\n- item\n\n  a | b\n  --|--\n  1 | 2\n\nAfter text.\n');
      await menuOn(S, cell(0, 0), 'Insert row below');
      await leave(S);
      const d = await S.disk();
      const added = d.split('\n')[7] ?? '';
      return all({ indented: added.startsWith('  ') && added.includes('|') }, d);
    },
  },
  {
    id: 'tables.shapes.e04',
    feature: 'tables.shapes',
    name: 'A table inside a blockquote shows as a grid',
    run: async (S) => {
      await S.fresh('shape-quote', inDoc('> | a | b |\n> | - | - |\n> | 1 | 2 |'));
      await S.caret('Intro', 2);
      await S.shot('shape-quote');
      return { ok: await S.exists('.sheaf-table'), detail: await S.rendered() };
    },
  },
  {
    id: 'tables.shapes.e05',
    feature: 'tables.shapes',
    name: 'A table with only leading pipes: Insert column right keeps three cells on every line in the same style',
    run: async (S) => {
      await S.fresh('shape-leading-pipes', inDoc('| a | b\n| - | -\n| 1 | 2'));
      await menuOn(S, cell(0, 1), 'Insert column right');
      await leave(S);
      const d = await S.disk();
      const lines = d.split('\n').slice(2, 5);
      return all({ cells: lines.every((l) => gfmCells(l).length === 3), prefix: lines[0].startsWith('| a | b') && lines[2].startsWith('| 1 | 2') }, d);
    },
  },
  menuCase('tables.shapes.e06', 'A table indented three spaces: Insert row below keeps the indentation on the new row', 'shape-indented', inDoc('   | a | b |\n   |-|-|\n   | 1 | 2 |'), cell(0, 0), 'Insert row below', inDoc('   | a | b |\n   |-|-|\n   | 1 | 2 |\n   |   |   |')),
  menuCase('tables.shapes.e07', 'A table inside a list item: Delete row removes only that indented line', 'shape-list-delete', LIST, cell(0, 0), 'Delete row', LIST.replace('  | 1 | 2 |\n', '')),
  (() => {
    const D = 'Intro text.\n\n1. item\n\n   | a | b |\n   | - | - |\n   | 1 | 2 |\n\nAfter text.\n';
    return menuCase('tables.shapes.e08', 'A table in a numbered list item: Duplicate row keeps the three-space indent', 'shape-numbered', D, cell(0, 0), 'Duplicate row', D.replace('   | 1 | 2 |\n', '   | 1 | 2 |\n   | 1 | 2 |\n'));
  })(),
  menuCase('tables.shapes.e09', 'A table on the first line of the file: Insert row above its first row leaves the header alone', 'shape-first-line', T4 + '\n\nAfter text.\n', cell(0, 0), 'Insert row above', T4.replace('| - | - |\n', '| - | - |\n|   |   |\n') + '\n\nAfter text.\n'),
  (() => {
    const D = 'Intro text.\n\n- outer\n  - inner\n\n    | k | v |\n    | - | - |\n    | b | 2 |\n    | a | 1 |\n\nAfter text.\n';
    return menuCase('tables.shapes.e10', 'A table in a nested list item: Sort A to Z keeps every row indented', 'shape-nested', D, cell(0, 0), 'Sort column A to Z', D.replace('    | b | 2 |\n    | a | 1 |', '    | a | 1 |\n    | b | 2 |'));
  })(),
];
