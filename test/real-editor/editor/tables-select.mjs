// Click scenarios for selecting cells, rows, columns and the whole table in a grid, in real VS Code.
// Each scenario states what a person expects from a spreadsheet-style grid and reports what the grid did:
// which cells are marked selected, which one is active, whether a cell editor opened, and the file on disk.
//   node test/real-editor/run-editor.mjs tables-select [id]
import { show } from '../session.mjs';
import { readPng, apart, show as showColour } from '../pixels.mjs';

const TABLE = '| Fruit | Qty | Note |\n| ----- | --- | ---- |\n| apple | 3   | red  |\n| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |\n| plum  | 4   | dark |';
const DOC = `Intro paragraph here.\n\n${TABLE}\n\nAfter line\n`;
const j = (x) => JSON.stringify(x);

const cell = (r, c) => ({ sel: `.sheaf-table [data-r="${r}"][data-c="${c}"]` });
const gutter = (r) => ({ sel: '.sheaf-table tbody .sheaf-table-gutter', nth: r });
const corner = { sel: '.sheaf-table .sheaf-table-corner' };

/** What the grid shows as selected: the marked cells as "r,c", the active cell, an open editor, the gutters and headers lit. */
const grid = (S) =>
  S.eval(() => {
    const t = document.querySelector('.sheaf-table');
    if (!t) return { grids: 0 };
    const at = (el) => `${el.dataset.r},${el.dataset.c}`;
    const sel = [...t.querySelectorAll('.is-sel')].map(at);
    const focus = t.querySelector('.is-focus');
    const lit = (el) => {
      const cs = getComputedStyle(el);
      return cs.backgroundColor;
    };
    return {
      grids: document.querySelectorAll('.sheaf-table').length,
      sel,
      focus: focus ? at(focus) : null,
      editing: !!t.querySelector('input, textarea, .sheaf-table-input'),
      gutterBg: [...t.querySelectorAll('tbody .sheaf-table-gutter')].map(lit),
      headerBg: [...t.querySelectorAll('thead th[data-c]')].map(lit),
      plainGutterBg: lit(t.querySelector('tbody .sheaf-table-gutter')),
      docSel: (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view;
        const r = v.state.selection.main;
        return v.state.sliceDoc(r.from, r.to);
      })(),
    };
  });

/** Every "r,c" in a rectangle, header row as r = -1. */
const rect = (r1, c1, r2, c2) => {
  const out = [];
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(`${r},${c}`);
  return out;
};
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

async function fresh(S, name) {
  await S.fresh(`select-${name}`, DOC);
  await S.sleep(500);
}

/** A scenario: act, then judge the grid against the cells a person expects, with the file unchanged unless `file` says otherwise. */
function sc(id, name, act, want, { file = DOC } = {}) {
  return {
    id: `tables.select.${id}`,
    feature: 'tables.selection',
    name,
    run: async (S) => {
      await fresh(S, id);
      await act(S);
      await S.sleep(300);
      const g = await grid(S);
      const d = await S.disk();
      const checks = {
        cells: want.sel ? sameSet(g.sel, want.sel) : true,
        active: want.focus === undefined ? true : g.focus === want.focus,
        noEditor: want.editing === undefined ? !g.editing : g.editing === want.editing,
        file: typeof file === 'function' ? file(d) : d === file,
        stillGrid: g.grids === 1,
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      const seen = { sel: g.sel, focus: g.focus, editing: g.editing, docSel: g.docSel };
      return { ok: failed.length === 0, detail: `${failed.length ? `failed: ${failed.join(', ')}; ` : ''}saw ${j(seen)}${d === DOC ? '' : `; file now ${show(d)}`}` };
    },
  };
}

export const scenarios = [
  sc('click-cell', 'Clicking a cell selects that one cell, with no editor open', (S) => S.click(cell(1, 0)), { sel: ['1,0'], focus: '1,0' }),
  sc('shift-click', 'Shift-clicking a second cell selects the rectangle between them', async (S) => {
    await S.click(cell(0, 0));
    await S.click(cell(2, 1), { modifiers: ['Shift'] });
  }, { sel: rect(0, 0, 2, 1), focus: '0,0' }),
  sc('drag-cells', 'Dragging from one cell to another selects the rectangle and keeps the start cell active', (S) => S.drag(cell(0, 1), cell(2, 2)), { sel: rect(0, 1, 2, 2), focus: '0,1' }),
  sc('drag-past-bottom', 'Dragging from a cell down past the table into the text below keeps a cell range out to the column under the pointer and selects no text', (S) => S.drag(cell(1, 1), { text: 'After line', offset: 3 }), { sel: rect(1, 0, 3, 1) }),
  sc('header-click', 'Clicking a column header selects the whole column, header included', (S) => S.click(cell(-1, 1)), { sel: rect(-1, 1, 3, 1) }),
  sc('header-shift-click', 'Clicking one header, then Shift-clicking another, selects every column between', async (S) => {
    await S.click(cell(-1, 0));
    await S.click(cell(-1, 2), { modifiers: ['Shift'] });
  }, { sel: rect(-1, 0, 3, 2) }),
  sc('header-drag', 'Dragging across the column headers selects those columns and moves nothing', (S) => S.drag(cell(-1, 0), cell(-1, 2)), { sel: rect(-1, 0, 3, 2) }),
  sc('cell-then-shift-header', 'With a cell selected, Shift-clicking a column header selects whole columns from that cell\'s column to it', async (S) => {
    await S.click(cell(1, 0));
    await S.click(cell(-1, 2), { modifiers: ['Shift'] });
  }, { sel: rect(-1, 0, 3, 2) }),
  sc('row-click', 'Clicking a row number selects that row', (S) => S.click(gutter(1)), { sel: rect(1, 0, 1, 2) }),
  sc('row-shift-click', 'Clicking one row number, then Shift-clicking another, selects every row between', async (S) => {
    await S.click(gutter(0));
    await S.click(gutter(2), { modifiers: ['Shift'] });
  }, { sel: rect(0, 0, 2, 2) }),
  sc('row-drag', 'Dragging down the row numbers selects those rows and moves nothing', (S) => S.drag(gutter(0), gutter(2)), { sel: rect(0, 0, 2, 2) }),
  sc('cell-then-shift-row', 'With a cell selected, Shift-clicking a row number selects whole rows from that cell\'s row to it', async (S) => {
    await S.click(cell(0, 1));
    await S.click(gutter(2), { modifiers: ['Shift'] });
  }, { sel: rect(0, 0, 2, 2) }),
  sc('corner', 'Clicking the corner selects the whole table', (S) => S.click(corner), { sel: rect(-1, 0, 3, 2) }),
  sc('cmd-a', 'Cmd+A with a cell selected selects the whole table', async (S) => {
    await S.click(cell(1, 1));
    await S.press('Meta+a');
  }, { sel: rect(-1, 0, 3, 2) }),
  {
    id: 'tables.select.cmd-a-twice',
    feature: 'tables.selection',
    name: 'A second Cmd+A, with the whole table already selected, selects the whole document',
    run: async (S) => {
      await fresh(S, 'cmd-a-twice');
      await S.click(cell(1, 1));
      await S.press('Meta+a');
      await S.press('Meta+a');
      await S.sleep(300);
      const g = await grid(S);
      const whole = g.docSel.length >= DOC.length - 1;
      return { ok: whole && g.grids === 1, detail: `document selection ${g.docSel.length}/${DOC.length} characters; grid cells ${g.sel.length}; grids ${g.grids}` };
    },
  },
  sc('shift-arrows', 'Shift+Right, Shift+Down from a cell grows a 2 by 2 block', async (S) => {
    await S.click(cell(0, 0));
    await S.press('Shift+ArrowRight Shift+ArrowDown');
  }, { sel: rect(0, 0, 1, 1), focus: '0,0' }),
  sc('shift-arrows-reverse', 'Shift+Right twice then Shift+Left twice shrinks back to the one cell', async (S) => {
    await S.click(cell(0, 0));
    await S.press('Shift+ArrowRight Shift+ArrowRight Shift+ArrowLeft Shift+ArrowLeft');
  }, { sel: ['0,0'], focus: '0,0' }),
  sc('shift-cmd-down', 'Shift+Cmd+Down selects to the bottom of the column', async (S) => {
    await S.click(cell(0, 1));
    await S.press('Shift+Meta+ArrowDown');
  }, { sel: rect(0, 1, 3, 1) }),
  sc('shift-space', 'Shift+Space selects the active cell\'s row', async (S) => {
    await S.click(cell(2, 1));
    await S.press('Shift+Space');
  }, { sel: rect(2, 0, 2, 2) }),
  sc('ctrl-space', 'Ctrl+Space selects the active cell\'s column', async (S) => {
    await S.click(cell(2, 1));
    await S.press('Control+Space');
  }, { sel: rect(-1, 1, 3, 1) }),
  sc('escape', 'Escape clears the selection', async (S) => {
    await S.drag(cell(0, 0), cell(1, 1));
    await S.press('Escape');
  }, { sel: [], focus: null }),
  sc('type-over-range', 'Typing with a block selected replaces only the active cell, and the block collapses to it', async (S) => {
    await S.drag(cell(0, 0), cell(1, 1));
    await S.type('Z');
    await S.press('Enter');
  }, {}, { file: (d) => d.includes('| Z ') && d.includes('kiwi') && d.includes('| 3 ') }),
  // The cell a drag or Shift-click starts from is the active cell: typing replaces it, and the far corner keeps its value.
  sc('drag-then-type-replaces-start-cell', 'Dragging from lime down-right to 4, then typing Q and Enter, replaces lime and leaves 4 alone', async (S) => {
    await S.drag(cell(2, 0), cell(3, 1));
    await S.type('Q');
    await S.press('Enter');
  }, {}, { file: (d) => /\|\s*Q\s*\|\s*7\s*\|\s*sour/.test(d) && /\|\s*plum\s*\|\s*4\s*\|\s*dark/.test(d) }),
  sc('shift-click-then-type-replaces-start-cell', 'Clicking 4, Shift-clicking lime, then typing Q and Enter, replaces 4 and leaves lime alone', async (S) => {
    await S.click(cell(3, 1));
    await S.click(cell(2, 0), { modifiers: ['Shift'] });
    await S.type('Q');
    await S.press('Enter');
  }, {}, { file: (d) => /\|\s*lime\s*\|\s*7\s*\|\s*sour/.test(d) && /\|\s*plum\s*\|\s*Q\s*\|\s*dark/.test(d) }),
  sc('shift-arrow-after-drag-moves-far-corner', 'After a drag from apple to 3, Shift+Down grows the block by a row and apple stays the active cell', async (S) => {
    await S.drag(cell(0, 0), cell(0, 1));
    await S.press('Shift+ArrowDown');
  }, { sel: rect(0, 0, 1, 1), focus: '0,0' }),
  sc('delete-range', 'Delete with a block selected clears exactly those cells', async (S) => {
    await S.drag(cell(0, 1), cell(1, 2));
    await S.press('Delete');
  }, {}, { file: (d) => /\|\s*apple\s*\|\s*\|\s*\|/.test(d) && /\|\s*kiwi\s*\|\s*\|\s*\|/.test(d) && /lime\s*\|\s*7\s*\|\s*sour/.test(d) }),
  {
    id: 'tables.select.copy-range',
    feature: 'tables.selection',
    name: 'Cmd+C on a block copies those cells as tab-separated rows',
    run: async (S) => {
      await fresh(S, 'copy-range');
      await S.clipboard.write('before');
      await S.drag(cell(0, 0), cell(1, 1));
      await S.press('Meta+c');
      await S.sleep(300);
      const got = await S.clipboard.read();
      return { ok: got === 'apple\t3\nkiwi\t12', detail: `clipboard ${j(got)}` };
    },
  },
  {
    id: 'tables.select.drag-out-of-cell-editor',
    feature: 'tables.selection',
    name: 'Dragging from the text of an open cell into another cell turns into a cell range',
    run: async (S) => {
      await fresh(S, 'drag-out-of-editor');
      await S.dblclick(cell(0, 0));
      await S.sleep(300);
      // The open cell's text: a nested editor for a Markdown cell, a text box for a CSV field.
      const input = { sel: '.sheaf-table .sheaf-table-input .cm-content, .sheaf-table input, .sheaf-table textarea' };
      await S.drag(input, cell(1, 1));
      await S.sleep(300);
      // Opening a cell changes the column widths, so the cell under the pointer when it is released is
      // not always the one the drag aimed at. The range must reach that cell, whichever it turned out to be.
      const seen = await S.eval((pt) => {
        const t = document.querySelector('.sheaf-table');
        const at = (el) => (el ? `${el.dataset.r},${el.dataset.c}` : null);
        return {
          sel: [...t.querySelectorAll('.is-sel')].map(at),
          focus: at(t.querySelector('.is-focus')),
          under: at(document.elementFromPoint(pt.x, pt.y)?.closest('[data-r]')),
          editing: !!t.querySelector('.sheaf-table-input, input, textarea'),
        };
      }, await S.eval(() => {
        const b = document.querySelector('.sheaf-table [data-r="1"][data-c="1"]').getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      }));
      const [r, c] = (seen.under ?? '0,0').split(',').map(Number);
      const want = rect(0, 0, Math.max(0, r), Math.max(0, c));
      const d = await S.disk();
      // The cell the drag started in stays the active one.
      const ok = sameSet(seen.sel, want) && seen.focus === '0,0' && !seen.editing && d === DOC;
      return { ok, detail: `released over ${seen.under}; ${j(seen)}${d === DOC ? '' : `; file now ${show(d)}`}` };
    },
  },
  {
    id: 'tables.select.selected-row-still-moves',
    feature: 'tables.selection',
    name: 'Clicking a row number and then dragging it still moves that row',
    run: async (S) => {
      await fresh(S, 'row-moves');
      await S.click(gutter(0));
      await S.sleep(200);
      await S.drag(gutter(0), gutter(2));
      const d = await S.disk();
      const want = DOC.replace('| apple | 3   | red  |\n| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |', '| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |\n| apple | 3   | red  |');
      return { ok: d === want, detail: d === want ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.select.selected-column-still-moves',
    feature: 'tables.selection',
    name: 'Clicking a column header and then dragging it still moves that column',
    run: async (S) => {
      await fresh(S, 'col-moves');
      await S.click(cell(-1, 0));
      await S.sleep(200);
      await S.drag(cell(-1, 0), cell(-1, 2));
      const d = await S.disk();
      const moved = d.includes('| Qty | Note | Fruit |') || d.includes('| Qty   | Note | Fruit |');
      return { ok: moved, detail: moved ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.select.every-cell-tinted',
    feature: 'tables.selection',
    name: 'Every selected cell is painted with the selection colour, on striped rows as well as plain ones',
    run: async (S) => {
      await fresh(S, 'every-cell-tinted');
      // Read the screen rather than the styles: a colour moved to a pseudo-element reads as transparent
      // though it is painted, and a colour under an opaque neighbour reads as set though nobody sees it.
      const anchor = await S.click(cell(-1, 1));
      await S.sleep(400);
      const mids = await S.eval(() => {
        const mid = (r, c) => {
          const b = document.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`).getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        };
        return { header: mid(-1, 1), selected: [0, 1, 2, 3].map((r) => mid(r, 1)), plain: [0, 1, 2, 3].map((r) => mid(r, 0)) };
      });
      const dx = anchor.x - mids.header.x;
      const dy = anchor.y - mids.header.y;
      const img = readPng(await S.shot('every-cell-tinted', { clipToEditor: false }));
      const at = (p) => img.atCss(p.x + dx, p.y + dy);
      const sel = mids.selected.map(at);
      const plain = mids.plain.map(at);
      const untinted = sel.map((c, i) => (apart(c, plain[i]) > 8 ? null : i + 1)).filter(Boolean);
      const shades = new Set(sel.map(showColour));
      return {
        ok: untinted.length === 0 && shades.size === 1,
        detail: `selected cells painted ${sel.map(showColour).join(' ')}; unselected ${plain.map(showColour).join(' ')}${untinted.length ? `; rows painted like an unselected cell: ${j(untinted)}` : ''}`,
      };
    },
  },
  {
    id: 'tables.select.selected-row-still-moves',
    feature: 'tables.selection',
    name: 'Clicking a row number and then dragging it still moves that row',
    run: async (S) => {
      await fresh(S, 'row-moves');
      await S.click(gutter(0));
      await S.sleep(200);
      await S.drag(gutter(0), gutter(2));
      const d = await S.disk();
      const want = DOC.replace('| apple | 3   | red  |\n| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |', '| kiwi  | 12  | fuzz |\n| lime  | 7   | sour |\n| apple | 3   | red  |');
      return { ok: d === want, detail: d === want ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.select.selected-column-still-moves',
    feature: 'tables.selection',
    name: 'Clicking a column header and then dragging it still moves that column',
    run: async (S) => {
      await fresh(S, 'col-moves');
      await S.click(cell(-1, 0));
      await S.sleep(200);
      await S.drag(cell(-1, 0), cell(-1, 2));
      const d = await S.disk();
      const moved = d.includes('| Qty | Note | Fruit |') || d.includes('| Qty   | Note | Fruit |');
      return { ok: moved, detail: moved ? '' : `file now ${show(d)}` };
    },
  },
  {
    id: 'tables.select.long-table-select-speed',
    feature: 'tables.selection',
    name: 'In a 3,000-row table a click selects its cell within 300 ms, an arrow key moves the active cell within 100 ms, and Cmd+Down lands on the last row',
    run: async (S) => {
      const rows = Array.from({ length: 3000 }, (_, i) => `| ${i + 1} | ${i % 2 ? 'North' : 'South'} | docs | running |`);
      const doc = `Intro paragraph here.\n\n| id | region | owner | state |\n| - | - | - | - |\n${rows.join('\n')}\n\nAfter line\n`;
      await S.fresh('select-long-table', doc);
      let drawn = 0;
      for (let i = 0; i < 100 && drawn < 3000; i++) {
        drawn = await S.eval(() => document.querySelector('.sheaf-table')?.querySelectorAll('tbody tr').length ?? 0);
        if (drawn < 3000) await S.sleep(100);
      }
      const focusAt = () => S.eval(() => {
        const f = document.querySelector('.sheaf-table .is-focus');
        return f ? `${f.dataset.r},${f.dataset.c}` : null;
      });
      /** Milliseconds from `act` until the active cell is `want`, or null past two seconds. */
      const timed = async (act, want) => {
        const t0 = Date.now();
        await act();
        for (let i = 0; i < 200; i++) {
          if ((await focusAt()) === want) return Date.now() - t0;
          await S.sleep(10);
        }
        return null;
      };
      // Timed on the bare gesture. S.click and S.press sleep after acting (250 ms, and 270 ms a key),
      // which put the harness's own waits into every figure; the cell is found before the clock starts.
      const at = await S.locate(cell(2, 1));
      const clickMs = await timed(() => S.page.mouse.click(at.x, at.y), '2,1');
      const arrows = [];
      for (let r = 3; r <= 7; r++) arrows.push(await timed(() => S.page.keyboard.press('ArrowDown'), `${r},1`));
      const landed = await timed(() => S.page.keyboard.press('Meta+ArrowDown'), '2999,1');
      const d = await S.disk();
      const arrowOk = arrows.every((ms) => ms !== null && ms <= 100);
      const ok = drawn === 3000 && clickMs !== null && clickMs <= 300 && arrowOk && landed !== null && d === doc;
      return { ok, detail: `rows ${drawn}, click to selected ${clickMs} ms, arrows ${j(arrows)} ms, Cmd+Down ${landed} ms${d === doc ? '' : ', file changed'}` };
    },
  },
];
