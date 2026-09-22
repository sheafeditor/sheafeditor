// How wide a table's columns are, in real VS Code: the half the stylesheet and the fixtures cannot
// answer, because every width in them is invented. What a column is worth is measured from the
// drawn text, so only a window that draws it can say whether the measurement is right.
//   node test/real-editor/run-editor.mjs table-widths [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

// A short column, a middling one and a column of prose: the shape the ceiling exists for.
const ROWS = [
  ['ok', 'Systems technician', 'A note long enough to wrap more than once inside its own column, which is the point of it'],
  ['no', 'Maintenance drone', 'Short.'],
  ['ok', 'Beacon keeper', 'Another note, also long, so the column has something to give up when the pane narrows'],
];
const DOC = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n${ROWS.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n\nAfter line\n`;

/** Zoom the window, which is the only lever here that changes the pane's width in CSS pixels. */
async function zoom(S, level) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  if (level === null) delete cur['window.zoomLevel'];
  else cur['window.zoomLevel'] = level;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(1800);
}

/** The columns as drawn, the table's own box, and whether its frame scrolls. */
const columns = (S) =>
  S.eval(() => {
    const grid = document.querySelector('.sheaf-table-grid');
    const table = grid?.querySelector('table');
    if (!grid || !table) return null;
    const cols = [...table.querySelectorAll('colgroup col')].map((c) => Math.round(c.getBoundingClientRect().width));
    const heads = [...table.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width));
    const scroller = document.querySelector('.cm-scroller');
    return {
      cols,
      heads,
      tableWidth: Math.round(table.getBoundingClientRect().width),
      frameWidth: Math.round(grid.getBoundingClientRect().width),
      frameScrolls: grid.scrollWidth > grid.clientWidth + 2,
      paneScrolls: scroller.scrollWidth > scroller.clientWidth + 2,
      pane: Math.round(scroller.getBoundingClientRect().width),
      // Clipped means a cell's text is wider than the room inside the cell. The cell's own
      // scrollWidth also counts the resize grip that sits over a header's border, which is
      // not text, so the text box is measured against the cell's inner width instead.
      clipped: [...table.querySelectorAll('td, th')].some((c) => {
        const t = c.querySelector('.sheaf-table-text');
        if (!t) return c.scrollWidth > c.clientWidth + 2;
        const cs = getComputedStyle(c);
        const room = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return Math.max(t.scrollWidth, t.getBoundingClientRect().width) > room + 2;
      }),
      probes: document.querySelectorAll('.sheaf-table-probe, [data-probe]').length,
    };
  });

export const scenarios = [
  {
    id: 'render.table-widths.e01',
    feature: 'render.table-widths',
    name: 'A short column keeps its content width while the column of prose gives up the room',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-wide', DOC);
      await S.sleep(1200);
      const m = await columns(S);
      const d = await S.disk();
      if (!m) return { ok: false, detail: 'no grid on screen' };
      // The status column holds two characters and the note column holds a sentence: the first
      // must not have given up the same proportion as the second.
      const [status, role, note] = m.heads;
      return {
        ok: status < role && role < note && note > status * 3 && !m.clipped && d === DOC,
        detail: `pane ${m.pane}, table ${m.tableWidth}, columns ${j(m.heads)} (colgroup ${j(m.cols)}); clipped ${m.clipped}; frame scrolls ${m.frameScrolls}${d === DOC ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e02',
    feature: 'render.table-widths',
    name: 'The table fills the text column exactly, and leaves no probe behind',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-fill', DOC);
      await S.sleep(1200);
      const m = await columns(S);
      if (!m) return { ok: false, detail: 'no grid on screen' };
      const sum = m.cols.reduce((a, b) => a + b, 0);
      // The colgroup's widths add up to the table, and nothing the measuring pass built is still
      // in the page afterwards.
      return {
        ok: Math.abs(sum - m.tableWidth) <= 2 && Math.abs(m.tableWidth - m.frameWidth) <= 2 && m.probes === 0,
        detail: `columns ${j(m.cols)} sum ${sum}, table ${m.tableWidth}, frame ${m.frameWidth}, probes left ${m.probes}`,
      };
    },
  },
  {
    id: 'render.table-widths.e03',
    feature: 'render.table-widths',
    name: 'In a pane too narrow for the columns, the table scrolls inside its own frame and the document does not',
    run: async (S) => {
      await zoom(S, null);
      // Enough columns that their floors alone cannot fit a split pane: three columns of prose
      // still fit at 364px, so a table that scrolls has to be wider than that.
      const wide = `Intro paragraph.\n\n| ${'ABCDEFGH'.split('').join(' | ')} |\n| ${'ABCDEFGH'.split('').map(() => '---').join(' | ')} |\n| ${'ABCDEFGH'.split('').map((c) => `${c} value here`).join(' | ')} |\n\nAfter line\n`;
      await S.fresh('widths-narrow', wide);
      await S.sleep(900);
      await S.command('View: Split Editor Right');
      await S.sleep(1400);
      await S.command('View: Split Editor Right');
      await S.sleep(1600);
      const m = await columns(S);
      const d = await S.disk();
      if (!m) return { ok: false, detail: 'no grid on screen' };
      return {
        ok: m.frameScrolls && !m.clipped && d === wide,
        detail: `pane ${m.pane}, table ${m.tableWidth}, frame ${m.frameWidth}, columns ${j(m.heads)}; frame scrolls ${m.frameScrolls}, pane scrolls ${m.paneScrolls}, clipped ${m.clipped}`,
      };
    },
  },
  {
    id: 'render.table-widths.e04',
    feature: 'render.table-widths',
    name: 'Narrowing the pane moves the columns without a jump, and every width is reached',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-steps', DOC);
      await S.sleep(900);
      // Three pane widths from the same document, taken by zooming rather than by dragging: the
      // question is whether one step moves a column further than the step itself.
      const steps = [];
      for (const level of [-0.9, -0.45, 0, 0.45]) {
        await zoom(S, level);
        await S.sleep(600);
        const m = await columns(S);
        if (m) steps.push({ pane: m.pane, heads: m.heads, table: m.tableWidth, scrolls: m.frameScrolls });
      }
      await zoom(S, null);
      const d = await S.disk();
      // A short column must never grow as the pane narrows, and no single step may move a column
      // by more than the pane moved: that is what a discontinuity in the allocation looks like.
      let monotone = true;
      let biggestJump = 0;
      for (let i = 1; i < steps.length; i++) {
        const dPane = Math.abs(steps[i].pane - steps[i - 1].pane);
        for (let c = 0; c < steps[i].heads.length; c++) {
          const move = Math.abs(steps[i].heads[c] - steps[i - 1].heads[c]);
          biggestJump = Math.max(biggestJump, move - dPane);
          if (steps[i].pane < steps[i - 1].pane && steps[i].heads[c] > steps[i - 1].heads[c] + 2) monotone = false;
        }
      }
      return {
        ok: steps.length === 4 && monotone && biggestJump <= 0 && d === DOC,
        detail: `${j(steps)}; widest move beyond the pane's own ${biggestJump}px; columns never grow as the pane narrows: ${monotone}`,
      };
    },
  },
  {
    id: 'render.table-widths.e05',
    feature: 'render.table-widths',
    name: 'Dragging a header border sets that column’s width, the file does not change, and the width is there after closing and reopening',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-drag', DOC);
      await S.sleep(1200);
      const before = await columns(S);
      if (!before) return { ok: false, detail: 'no grid on screen' };
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip);
      await S.drag(grip, { x: at.x - 60, y: at.y });
      await S.sleep(600);
      const dragged = await columns(S);
      const d = await S.disk();
      // The Role column is the second data column: heads[0] is the row-number corner.
      const want = before.heads[2] - 60;
      await S.cleanup();
      await S.open('e2e/widths-drag.md');
      await S.sleep(1500);
      const reopened = await columns(S);
      const d2 = await S.disk();
      const near = (a, b) => Math.abs(a - b) <= 3;
      return {
        ok: !!dragged && !!reopened && near(dragged.heads[2], want) && near(reopened.heads[2], dragged.heads[2]) && d === DOC && d2 === DOC,
        detail: `role column ${before.heads[2]} -> ${dragged?.heads[2]} (wanted ${want}), after reopening ${reopened?.heads[2]}; file ${d === DOC && d2 === DOC ? 'unchanged' : 'changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e14',
    feature: 'render.table-widths',
    name: 'A width set by dragging a header border is still there after Developer: Reload Window',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-reload', DOC);
      await S.sleep(1200);
      const before = await columns(S);
      if (!before) return { ok: false, detail: 'no grid on screen' };
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip);
      await S.drag(grip, { x: at.x - 60, y: at.y });
      await S.sleep(800);
      const dragged = await columns(S);
      // A reload throws away the webview and the extension host; only VS Code's own storage
      // carries the width across, which is what this asks about.
      await S.command('Developer: Reload Window');
      await S.sleep(6000);
      await S.open('e2e/widths-reload.md');
      await S.sleep(1500);
      const reloaded = await columns(S);
      const d = await S.disk();
      const near = (a, b) => Math.abs(a - b) <= 3;
      return {
        ok: !!dragged && !!reloaded && near(dragged.heads[2], before.heads[2] - 60) && near(reloaded.heads[2], dragged.heads[2]) && d === DOC,
        detail: `role column ${before.heads[2]} -> ${dragged?.heads[2]}, after reloading the window ${reloaded?.heads[2]}; file ${d === DOC ? 'unchanged' : 'changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e15',
    feature: 'render.table-widths',
    name: 'After Developer: Reload Window, the paragraph under a table of wrapped rows does not move when the table is drawn',
    run: async (S) => {
      await zoom(S, null);
      // A table below the fold is not drawn until it scrolls into view, so until then the editor
      // places everything under it by the table's estimated height. After a reload no table has
      // been drawn and no widths are remembered, so the estimate has to divide the text column
      // itself. The lead-in pushes the table well past the first screen and the editor's own
      // margin beyond it, so the first reading is the estimate and nothing else.
      const lead = Array.from({ length: 70 }, (_, i) => `Lead-in paragraph ${i + 1}, a sentence to fill the first screens.`).join('\n\n');
      const rows = [
        ['R1', 'open', 'The shipment waits on customs paperwork the broker has not filed yet, so the pallet sits at the port until every form arrives.'],
        ['R2', 'late', 'Supplier confirmed the new date by phone on Tuesday morning.'],
        ['R3', 'done', 'On time.'],
        ['R4', 'open', 'Two of the four crates were opened at inspection and repacked by the carrier, who has asked for the original packing list and the invoice before releasing them to the warehouse.'],
      ];
      const doc = `${lead}\n\n| Ref | Status | Detail |\n| --- | ------ | ------ |\n${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n\nAfter the table.\n`;
      await S.fresh('widths-estimate-reload', doc);
      await S.sleep(800);
      // A reload throws the webview away, and with it every height and width a table was drawn at.
      await S.command('Developer: Reload Window');
      await S.sleep(6000);
      await S.open('e2e/widths-estimate-reload.md');

      // Where the paragraph sits against the table's top, from CodeMirror's own height map, so the
      // lead-in's estimated lines above the table cancel out and only the table's height counts.
      const read = () =>
        S.eval(() => {
          const content = document.querySelector('.cm-content');
          const tile = content && (content.cmTile || content.cmView);
          const view = tile && ((tile.root && tile.root.view) || tile.view);
          if (!view) return null;
          const text = view.state.doc.toString();
          const tableAt = text.indexOf('| Ref |');
          const paraAt = text.indexOf('After the table.');
          if (tableAt < 0 || paraAt < 0) return null;
          const table = view.lineBlockAt(tableAt);
          const para = view.lineBlockAt(paraAt);
          return {
            // One block from the header to the last row means the table is a widget, not raw lines.
            widget: table.to >= text.lastIndexOf('|', paraAt) && table.to < paraAt,
            drawn: !!document.querySelector('.sheaf-table-grid'),
            tableHeight: Math.round(table.height * 100) / 100,
            below: Math.round((para.top - table.top) * 100) / 100,
            paraTop: Math.round(para.top * 100) / 100,
            docTop: view.documentTop,
          };
        });

      const first = await read();
      if (!first) return { ok: false, detail: 'no editor view, or the document on screen is not this one' };
      if (first.drawn) return { ok: false, detail: `the table was already drawn at the first reading, so it measured nothing: ${j(first)}` };

      // Scroll the table into view, as a person reading down would, and let it draw and lay out.
      await S.eval(() => {
        const content = document.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile && ((tile.root && tile.root.view) || tile.view);
        const at = view.state.doc.toString().indexOf('| Ref |');
        const scroller = document.querySelector('.cm-scroller');
        scroller.scrollTop += view.lineBlockAt(at).top + view.documentTop - scroller.getBoundingClientRect().top - 40;
      });
      await S.sleep(1500);
      const after = await read();
      // What the drawn table is made of, to set beside the estimate's own measures when they
      // disagree: each row's height, its tallest cell in lines, the line height, the bar and
      // frame around the grid, and the column widths the layout chose.
      const parts = await S.eval(() => {
        const wrap = document.querySelector('.sheaf-table');
        const grid = wrap?.querySelector('.sheaf-table-grid');
        const table = grid?.querySelector('table');
        if (!wrap || !table) return null;
        const r2 = (n) => Math.round(n * 100) / 100;
        const text = table.querySelector('.sheaf-table-text');
        const lh = text ? parseFloat(getComputedStyle(text).lineHeight) : NaN;
        return {
          wrap: r2(wrap.getBoundingClientRect().height),
          grid: r2(grid.getBoundingClientRect().height),
          table: r2(table.getBoundingClientRect().height),
          lineHeight: r2(lh),
          rows: [...table.rows].map((tr) => ({
            h: r2(tr.getBoundingClientRect().height),
            lines: Math.max(...[...tr.querySelectorAll('.sheaf-table-text')].map((t) => Math.round(t.getBoundingClientRect().height / lh))),
          })),
          cols: [...table.querySelectorAll('colgroup col')].map((c) => r2(c.getBoundingClientRect().width)),
        };
      });
      const d = await S.disk();
      const moved = after ? Math.abs(after.below - first.below) : Infinity;
      return {
        ok: first.widget && !!after?.drawn && moved <= 2 && d === doc,
        detail: `before drawing: table ${first.tableHeight}px, paragraph ${first.below}px below its top (widget ${first.widget}); drawn: table ${after?.tableHeight}px, paragraph ${after?.below}px below (drawn ${after?.drawn}); moved ${moved}px; drawn parts ${j(parts)}${d === doc ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e06',
    feature: 'render.table-widths',
    name: 'A border dragged past the narrowest a column may be stops there while the pointer is still held',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-floor', DOC);
      await S.sleep(1200);
      const grip = { sel: '.sheaf-table-grid thead th[data-c="2"] > .sheaf-table-resize' };
      const at = await S.hover(grip);
      await S.page.mouse.move(at.x, at.y);
      await S.page.mouse.down();
      await S.page.mouse.move(at.x - 900, at.y, { steps: 20 });
      await S.sleep(300);
      const held = await S.eval(() => {
        const g = document.querySelector('.sheaf-table-grid thead th[data-c="2"] > .sheaf-table-resize');
        const th = document.querySelector('.sheaf-table-grid thead th[data-c="2"]');
        return { atFloor: !!g?.classList.contains('is-at-floor'), width: Math.round(th?.getBoundingClientRect().width ?? 0) };
      });
      await S.page.mouse.up();
      await S.sleep(400);
      const after = await columns(S);
      // Back to computed widths, so the next run of this scenario starts where this one did.
      await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.resetWidths"]' });
      const d = await S.disk();
      // The floor is a cell holding six characters of the table's font, its padding included:
      // about eighty pixels at the default size.
      return {
        ok: held.atFloor && held.width >= 50 && held.width <= 100 && after?.heads[3] === held.width && d === DOC,
        detail: `held past the floor: at floor ${held.atFloor}, width ${held.width}; after release ${after?.heads[3]}`,
      };
    },
  },
  {
    id: 'render.table-widths.e07',
    feature: 'render.table-widths',
    name: 'Fit columns to content puts every column at its content width, and Reset column widths puts them back',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-fit', DOC);
      await S.sleep(1200);
      const before = await columns(S);
      const resetOff = async () =>
        S.eval(() => {
          const item = document.querySelector('.sheaf-table-menu-item[data-cmd="table.resetWidths"]');
          return item?.getAttribute('aria-disabled') === 'true';
        });
      await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
      const offBefore = await resetOff();
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.fitColumns"]' });
      await S.sleep(600);
      const fitted = await columns(S);
      await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
      const offAfter = await resetOff();
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.resetWidths"]' });
      await S.sleep(600);
      const reset = await columns(S);
      const d = await S.disk();
      // Fitted, the note column holds its whole sentence on one line, so the table is wider than
      // the pane and scrolls in its frame; reset, it is the table it was.
      return {
        ok: offBefore && !offAfter && !!fitted && fitted.frameScrolls && !fitted.paneScrolls && j(reset?.heads) === j(before?.heads) && d === DOC,
        detail: `before ${j(before?.heads)}, fitted ${j(fitted?.heads)} (frame scrolls ${fitted?.frameScrolls}), reset ${j(reset?.heads)}; Reset dimmed before ${offBefore}, after ${offAfter}`,
      };
    },
  },
  {
    id: 'render.table-widths.e08',
    feature: 'render.table-widths',
    name: 'Scrolling down the 800-row table keeps its header row at the top of the editor, lined up with the columns under it',
    run: async (S) => {
      await zoom(S, null);
      await S.open('stress/large-tables.md');
      await S.sleep(2000);
      const before = await S.disk();
      const at = async (by) =>
        S.eval((scroll) => {
          const scroller = document.querySelector('.cm-scroller');
          const wrap = document.querySelector('.sheaf-table');
          const table = wrap?.querySelector('.sheaf-table-grid > table');
          if (!scroller || !table) return null;
          // Down to a point well inside the first table.
          scroller.scrollTop = table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + scroll;
          return null;
        }, by);
      const read = () =>
        S.eval(() => {
          const scroller = document.querySelector('.cm-scroller');
          const wrap = document.querySelector('.sheaf-table');
          const head = wrap?.querySelector('thead tr');
          const top = scroller.getBoundingClientRect().top;
          const h = head.getBoundingClientRect();
          const th = wrap.querySelector('thead th[data-c="3"]').getBoundingClientRect();
          // A body cell of the same column that is on screen right now.
          const td = [...wrap.querySelectorAll('tbody td[data-c="3"]')].find((el) => el.getBoundingClientRect().top > h.bottom);
          const hit = document.elementFromPoint(th.left + th.width / 2, top + 4);
          return {
            headTop: Math.round(h.top),
            frameTop: Math.round(top),
            onTop: !!hit && !!hit.closest('thead'),
            aligned: !!td && Math.abs(td.getBoundingClientRect().left - th.left) <= 1,
            scrollsSideways: wrap.classList.contains('is-scroll-x'),
          };
        });
      await at(4000);
      await S.sleep(500);
      const down = await read();
      // Sideways as well, for a table wider than the pane: the header goes with the columns.
      await S.eval(() => {
        const grid = document.querySelector('.sheaf-table .sheaf-table-grid');
        grid.scrollLeft = 200;
      });
      await S.sleep(300);
      const across = await read();
      const d = await S.disk();
      return {
        ok: !!down && Math.abs(down.headTop - down.frameTop) <= 2 && down.onTop && down.aligned && across.aligned && d === before,
        detail: `down: ${j(down)}; across: ${j(across)}${d === before ? '' : '; the file changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e13',
    feature: 'render.table-widths',
    name: 'With the header row stuck at the top, moving up from the top visible row keeps the active cell in sight below the header',
    run: async (S) => {
      await zoom(S, null);
      await S.open('stress/large-tables.md');
      await S.sleep(2000);
      const before = await S.disk();
      // Well inside the first table, so its header row is stuck at the top of the editor.
      await S.eval(() => {
        const scroller = document.querySelector('.cm-scroller');
        const table = document.querySelector('.sheaf-table .sheaf-table-grid > table');
        scroller.scrollTop = table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + 4000;
      });
      await S.sleep(500);
      // The first body cell wholly below the stuck header: the top row a person can see.
      const first = await S.eval(() => {
        const wrap = document.querySelector('.sheaf-table');
        const head = wrap.querySelector('thead tr').getBoundingClientRect();
        const td = [...wrap.querySelectorAll('tbody td[data-c="1"]')].find((el) => el.getBoundingClientRect().top >= head.bottom);
        return td ? `.sheaf-table [data-r="${td.dataset.r}"][data-c="1"]` : null;
      });
      if (!first) return { ok: false, detail: 'no body cell below the header' };
      await S.click({ sel: first });
      /** Where the active cell sits against the stuck header, after a move. */
      const place = () =>
        S.eval(() => {
          const wrap = document.querySelector('.sheaf-table');
          const f = wrap.querySelector('.is-focus');
          const head = wrap.querySelector('thead tr').getBoundingClientRect();
          const scroller = document.querySelector('.cm-scroller').getBoundingClientRect();
          if (!f) return null;
          const b = f.getBoundingClientRect();
          return { r: Number(f.dataset.r), gap: Math.round(b.top - head.bottom), onScreen: b.bottom <= scroller.bottom + 1 };
        });
      const steps = [];
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'PageUp']) {
        await S.press(key);
        await S.sleep(200);
        steps.push({ key, ...(await place()) });
      }
      const d = await S.disk();
      // A cell under the header has a negative gap: its top is hidden behind the header row.
      const ok = steps.every((s) => s.r !== undefined && s.gap >= -1 && s.onScreen) && d === before;
      return { ok, detail: `${j(steps)}${d === before ? '' : '; the file changed'}` };
    },
  },
  {
    id: 'render.table-widths.e09',
    feature: 'render.table-widths',
    name: 'A clamped cell opens whole, and the caret stays in view in it as typing makes the row taller',
    run: async (S) => {
      await zoom(S, null);
      const long = 'A note that runs well past four lines in a column this narrow, so the grid draws it clamped until it is opened for typing and read in full.';
      const doc = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | ${long} ${long} ${long} ${long} |\n| no | Drone | Short. |\n\nAfter line\n`;
      await S.fresh('clamp-grow', doc);
      await S.sleep(1200);
      const cell = { sel: '.sheaf-table-grid td[data-r="0"][data-c="2"]' };
      const clampedBefore = await S.eval(() => {
        const td = document.querySelector('.sheaf-table-grid td[data-r="0"][data-c="2"]');
        return { clamped: td.classList.contains('is-clamped'), title: td.title.length, height: Math.round(td.getBoundingClientRect().height) };
      });
      await S.dblclick(cell);
      await S.press('Meta+ArrowDown');
      await S.type(' More words typed at the end of the note, and more, until the row has grown by several lines.');
      await S.sleep(400);
      const open = await S.eval(() => {
        const td = document.querySelector('.sheaf-table-grid td[data-r="0"][data-c="2"]');
        const scroller = document.querySelector('.cm-scroller').getBoundingClientRect();
        const sel = document.getSelection();
        const caret = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
        const box = td.getBoundingClientRect();
        return {
          clamped: td.classList.contains('is-clamped'),
          editing: td.classList.contains('is-editing'),
          height: Math.round(box.height),
          caretInCell: !!caret && caret.top >= box.top - 1 && caret.bottom <= box.bottom + 1,
          caretOnScreen: !!caret && caret.top >= scroller.top && caret.bottom <= scroller.bottom,
        };
      });
      await S.press('Escape');
      const d = await S.disk();
      return {
        ok: clampedBefore.clamped && clampedBefore.title > 0 && !open.clamped && open.editing && open.height > clampedBefore.height && open.caretInCell && open.caretOnScreen,
        detail: `before ${j(clampedBefore)}; open ${j(open)}${d === doc ? '' : '; Escape left the file changed'}`,
      };
    },
  },
  {
    id: 'render.table-widths.e10',
    feature: 'render.table-widths',
    name: 'In a column of numbers the digits line up: 1111 and 8888 are drawn the same width, as they are not in a column of words',
    run: async (S) => {
      const doc = 'Intro.\n\n| Item | Cost |\n| --- | ---: |\n| n1111 | 1111 |\n| n8888 | 8888 |\n| bolt | 12 |\n\nAfter line\n';
      await S.fresh('tabular-figures', doc);
      await S.sleep(600);
      // The drawn width of the digits in a cell, read from the text itself so padding and
      // the cell's own width do not enter into it.
      const m = await S.eval(() => {
        const width = (r, c, digits) => {
          const el = document.querySelector(`.sheaf-table [data-r="${r}"][data-c="${c}"]`);
          if (!el) return null;
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const i = n.data.indexOf(digits);
            if (i < 0) continue;
            const range = document.createRange();
            range.setStart(n, i);
            range.setEnd(n, i + digits.length);
            return Math.round(range.getBoundingClientRect().width * 100) / 100;
          }
          return null;
        };
        return { num1: width(0, 1, '1111'), num8: width(1, 1, '8888'), word1: width(0, 0, '1111'), word8: width(1, 0, '8888') };
      });
      const numbersEven = m.num1 != null && Math.abs(m.num1 - m.num8) < 0.5;
      // The control: the same digits in the Item column, which is words, differ in width if the
      // font's digits are proportional. When they do not, this font cannot tell the two apart.
      const control = m.word1 != null && Math.abs(m.word1 - m.word8) >= 0.5;
      return { ok: numbersEven && control, detail: `number column 1111 ${m.num1}px, 8888 ${m.num8}px; word column 1111 ${m.word1}px, 8888 ${m.word8}px${control ? '' : ' (control inconclusive: this font draws digits at one width everywhere)'}` };
    },
  },
  {
    id: 'render.table-widths.e11',
    feature: 'render.table-widths',
    name: 'Renaming a header in the grid keeps a width set by hand',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-rename', DOC);
      await S.sleep(1200);
      const before = await columns(S);
      if (!before) return { ok: false, detail: 'no grid on screen' };
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip);
      await S.drag(grip, { x: at.x - 60, y: at.y });
      await S.sleep(600);
      const dragged = await columns(S);
      await S.dblclick({ sel: '.sheaf-table-grid thead th[data-c="1"]' });
      await S.sleep(300);
      await S.press('Meta+a');
      await S.type('Job');
      await S.press('Enter');
      await S.sleep(600);
      const renamed = await columns(S);
      const d = await S.disk();
      const near = (a, b) => Math.abs(a - b) <= 3;
      // The header row is padded to its column, so the new name may be followed by spaces.
      const headerRenamed = /^\| St \| Job\s*\|/m.test(d);
      return {
        ok: !!renamed && headerRenamed && near(renamed.heads[2], dragged.heads[2]) && !near(dragged.heads[2], before.heads[2]),
        detail: `role column ${before.heads[2]} -> dragged ${dragged?.heads[2]} -> after rename ${renamed?.heads[2]}; header renamed in the file ${headerRenamed}; header line ${JSON.stringify(d.split('\n')[2])}; changed lines ${JSON.stringify(d.split('\n').filter((l, i) => l !== DOC.split('\n')[i]))}`,
      };
    },
  },
  {
    id: 'render.table-widths.e12',
    feature: 'render.table-widths',
    name: 'Inserting a column after setting a width by hand puts the table back to computed widths',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('widths-insert', DOC);
      await S.sleep(1200);
      const grip = { sel: '.sheaf-table-grid thead th[data-c="1"] > .sheaf-table-resize' };
      const at = await S.hover(grip);
      await S.drag(grip, { x: at.x - 60, y: at.y });
      await S.sleep(600);
      const resetOff = async () => {
        await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
        const off = await S.eval(() => document.querySelector('.sheaf-table-menu-item[data-cmd="table.resetWidths"]')?.getAttribute('aria-disabled') === 'true');
        await S.press('Escape');
        await S.sleep(200);
        return off;
      };
      // Reset is dimmed exactly when no width is set by hand, so it says which widths are in force.
      const offAfterDrag = await resetOff();
      await S.rightClick({ sel: '.sheaf-table [data-r="0"][data-c="2"]' });
      await S.sleep(200);
      await S.menu('Insert column right');
      await S.sleep(600);
      const d = await S.disk();
      const inserted = d.split('\n').some((l) => /^\| St \| Role \| Note \|\s*\|/.test(l));
      const offAfterInsert = await resetOff();
      return {
        ok: !offAfterDrag && inserted && offAfterInsert,
        detail: `after the drag Reset dimmed ${offAfterDrag}; column inserted ${inserted}; after inserting Reset dimmed ${offAfterInsert}; header ${JSON.stringify(d.split('\n')[2])}`,
      };
    },
  },
];
