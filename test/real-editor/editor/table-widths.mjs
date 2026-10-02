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

/**
 * Drive a column's own menu: hover its header, open the chevron, choose a command by its id.
 *
 * Hovered first because the chevron is drawn only on a hovered header, and without it the harness
 * refuses the click and reports the header cell as covering it.
 */
async function chevron(S, col, cmd) {
  await S.hover({ sel: `.sheaf-table-grid thead th[data-c="${col}"]` });
  await S.sleep(400);
  await S.click({ sel: `.sheaf-table-grid thead th[data-c="${col}"] > .sheaf-table-chevron` });
  await S.sleep(400);
  await S.click({ sel: `.sheaf-table-menu-item[data-cmd="${cmd}"]` });
}

/** Drive the table's own bar: the overflow button, then a command by its id. */
async function tableMenu(S, cmd) {
  await S.click({ sel: '.sheaf-table-ctrl[data-cmd="overflow"]' });
  await S.sleep(400);
  await S.click({ sel: `.sheaf-table-menu-item[data-cmd="${cmd}"]` });
}

/**
 * Drive a row command from the first body row's right-click menu.
 *
 * The row number is clicked first: a row command is offered for the selected row, so without the
 * selection the item is absent or disabled and the gesture would silently do nothing.
 */
async function rowMenu(S, label, { select = true } = {}) {
  if (select) await S.click({ sel: '.sheaf-table tbody tr:first-child td.sheaf-table-gutter' });
  await S.sleep(300);
  // Right-clicked on a cell of the row rather than on its number, and chosen by label, because the
  // context menu's items carry their text and not a command id.
  await S.rightClick({ sel: '.sheaf-table tbody tr:first-child td[data-c="0"]' });
  await S.sleep(300);
  await S.menu(label);
}

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
      /*
       * The writing column: `.cm-content`'s own content box, its gutters being that element's
       * padding. The frame reaches past it to the pane's edge, so this is what a table that
       * fits is laid out to and the frame is not.
       */
      textColumn: (() => {
        const content = document.querySelector('.cm-content');
        if (!content) return null;
        const cs = getComputedStyle(content);
        return Math.round(content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      })(),
      /*
       * The room a table that takes the pane is laid out in: the frame, less the gap the
       * stylesheet leaves after the last column, less the one pixel `border-collapse: collapse`
       * puts outside the table's own box.
       *
       * The right padding, not the left. The pane-wide rule in `webview.css` sets
       * `padding-left: 0` with `padding-right: var(--md-gutter)`, and a table that cannot use
       * the pane takes that same right-hand gap, so in both states the gutter is on the right
       * and the left is zero. Reading the left padding, as this did, came from a version where a
       * frame reaching the pane held the inset on both sides; since that changed it has been
       * returning the whole frame and asking the table to fill a room a gutter wider than the
       * one it was given.
       */
      paneRoom: Math.round(grid.clientWidth - (parseFloat(getComputedStyle(grid).paddingRight) || 0) - 1),
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
      /*
       * Twelve columns of short words, whose floors alone will not fit the writing column, so
       * this is the table laid out to the pane.
       *
       * It used to be `DOC`, a three-column table of prose, on the reasoning that a column
       * holding a sentence does not fit. That was the old rule and it was the bug: the test
       * asked whether every column could be drawn at its no-wrap width, which a sentence never
       * can, so a table of prose took the pane however comfortably it would have wrapped. Now
       * the question is whether the columns fit at their *floors*, so `DOC` belongs to the
       * other half of this scenario and a table that will not fit has to be built.
       *
       * Short words rather than sentences, and that is the whole of why there are twelve
       * columns of `value` here. A column's floor is the longer of its longest word and the
       * 6ch minimum, so twelve short columns are twelve floors and their sum lands just past
       * the writing column while still fitting the pane, which is what "laid out to the pane"
       * means and what the assertion below measures. Twelve columns of *sentences* were tried
       * first and read 1935px against a 900px pane: past the pane as well, so the frame
       * scrolled and the table filled neither room. That case is `e03`'s.
       */
      const many = 12;
      const head = Array.from({ length: many }, (_, i) => `H${i + 1}`);
      const body = Array.from({ length: many }, () => 'value');
      const tooWide = `Intro paragraph.\n\n| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n| ${body.join(' | ')} |\n\nAfter line\n`;
      await S.fresh('widths-fill', tooWide);
      await S.sleep(1200);
      const wide = await columns(S);
      // And `DOC`, the three-column table of prose, which is the whole point of the change:
      // it fits at its floors, so it is laid out to the writing column and its cells wrap.
      await S.fresh('widths-fill-prose', DOC);
      await S.sleep(1200);
      const prose = await columns(S);
      if (!wide || !prose) return { ok: false, detail: 'no grid on screen' };
      const sum = wide.cols.reduce((a, b) => a + b, 0);
      /*
       * The colgroup's widths add up to the table, each table fills the room it was given,
       * and nothing the measuring pass built is still in the page afterwards.
       *
       * Two rooms, because there are two, and asserting either alone would pass on a version
       * that had only that one. A change that put every table back in the writing column
       * passes the prose half and fails the twelve-column half; a change that put every table
       * in the pane does the opposite. That pairing is the point of the scenario and it is why
       * the documents moved rather than the assertions.
       */
      const fillsPane = Math.abs(wide.tableWidth - (wide.paneRoom ?? 0)) <= 2;
      const fillsColumn = Math.abs(prose.tableWidth - (prose.textColumn ?? 0)) <= 2;
      return {
        ok: Math.abs(sum - wide.tableWidth) <= 2 && fillsPane && fillsColumn && wide.probes === 0 && prose.probes === 0,
        detail:
          `a table too wide to fit at its floors: columns ${j(wide.cols)} sum ${sum}, table ${wide.tableWidth}, ` +
          `pane room ${wide.paneRoom}, writing column ${wide.textColumn}, frame ${wide.frameWidth}; ` +
          `a three-column table of prose: table ${prose.tableWidth}, writing column ${prose.textColumn}, ` +
          `frame ${prose.frameWidth}; probes left ${wide.probes} and ${prose.probes}`,
      };
    },
  },
  {
    /*
     * A reading, not an assertion: every quantity `roomFor` uses, read in one window at one
     * moment, because inferring them one at a time produced two confident wrong answers.
     *
     * `columnLayout.ts` computes the room as `width - (usesPane ? gutter : inset) - 1`, where
     * `width` is the grid's `clientWidth`, `inset` is the grid's own left padding, `gutter` is
     * `--md-gutter` off the grid, and `usesPane` is the `can-use-pane` class. Each of those is
     * read here beside the width the table actually came out at, so whichever one disagrees
     * says so rather than being deduced from the others.
     */
    id: 'render.table-widths.e18',
    feature: 'render.table-widths',
    name: 'Reading: every quantity the room is computed from, for a table too wide for the writing column',
    run: async (S) => {
      await zoom(S, null);
      const many = 12;
      const head = Array.from({ length: many }, (_, i) => `H${i + 1}`);
      const body = Array.from({ length: many }, () => 'value');
      const doc = `Intro paragraph.\n\n| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n| ${body.join(' | ')} |\n\nAfter line\n`;
      await S.fresh('widths-room-reading', doc);
      await S.sleep(1200);
      const r = await S.eval(() => {
        const wrap = document.querySelector('.sheaf-table');
        const grid = wrap?.querySelector('.sheaf-table-grid');
        const table = grid?.querySelector('table');
        const content = document.querySelector('.cm-content');
        if (!wrap || !grid || !table || !content) return null;
        const gs = getComputedStyle(grid);
        const ccs = getComputedStyle(content);
        const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n) : null; };
        return {
          canUsePane: wrap.classList.contains('can-use-pane'),
          isPaneWide: wrap.classList.contains('is-pane-wide'),
          gridClientWidth: grid.clientWidth,
          padLeft: num(gs.paddingLeft),
          padRight: num(gs.paddingRight),
          gutterVar: num(gs.getPropertyValue('--md-gutter')),
          writingColumn: Math.round(content.clientWidth - (parseFloat(ccs.paddingLeft) || 0) - (parseFloat(ccs.paddingRight) || 0)),
          tableWidth: Math.round(table.getBoundingClientRect().width),
          cols: [...table.querySelectorAll('colgroup col')].map((c) => Math.round(c.getBoundingClientRect().width)),
        };
      });
      if (!r) return { ok: false, detail: 'no grid on screen, so nothing was read' };
      const inset = r.padLeft ?? 0;
      const roomIfPane = r.gridClientWidth - (r.gutterVar ?? 0) - 1;
      const roomIfInset = r.gridClientWidth - inset - 1;
      return {
        /*
         * One assertion, on the quantity that was wrong: `--md-gutter` has to read back as a
         * number. An unregistered custom property computes to its token stream, so this read
         * returned `NaN` and `columnLayout.ts` silently used the writing column's inset as the
         * gutter. Removing the `@property` block from `webview.css` fails this line, which is
         * how it was measured. Everything else is printed rather than asserted, so the four
         * quantities can be compared at one moment instead of inferred one at a time.
         */
        ok: r.gutterVar !== null && r.gutterVar > 0 && r.gridClientWidth > 0 && r.tableWidth > 0,
        detail:
          `can-use-pane ${r.canUsePane}, is-pane-wide ${r.isPaneWide}; ` +
          `grid clientWidth ${r.gridClientWidth}, padding ${r.padLeft}/${r.padRight}, --md-gutter ${r.gutterVar}; ` +
          `writing column ${r.writingColumn}; table ${r.tableWidth}; ` +
          `room if the gutter is used ${roomIfPane}, room if the inset is used ${roomIfInset}; ` +
          `cols ${j(r.cols)}`,
      };
    },
  },
  {
    /*
     * Fitting a row to its content, by a real double-click on its divider at real coordinates.
     *
     * Driven by the pointer rather than by calling a handler, because the divider is about seven
     * pixels across in the selector strip and whether a person can hit it is half the question. A
     * synthetic dispatch on the element would answer the other half and call it done.
     *
     * Three things it has to keep, and each is a separate reading below: the row goes back to the
     * clamp on a second double-click, because this is a flag and not a height; a row with nothing
     * to fit has no divider at all, which is what keeps the strip's click-to-select and drag-to-move
     * from competing with it; and clicking the strip itself still selects the row.
     */
    id: 'render.table-widths.e19',
    feature: 'render.table-widths',
    name: 'Double-clicking a row’s divider shows every line of its tallest cell, and doing it again puts the clamp back',
    run: async (S) => {
      await zoom(S, null);
      const long =
        'A note that runs well past four lines in a column this narrow, so the grid draws it clamped until the row is fitted to its content.';
      const doc = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | ${long} ${long} ${long} ${long} |\n| no | Drone | Short. |\n\nAfter line\n`;
      await S.fresh('row-fit', doc);
      await S.sleep(1300);
      /*
       * Window coordinates from one real click, because the webview's own rectangles are not the
       * window's. The same translation the sticky-header scenarios use.
       */
      const anchorAt = await S.click({ text: 'Intro paragraph', offset: 0 });
      const origin = await S.eval(() => {
        const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro paragraph'));
        const r = el?.getBoundingClientRect();
        return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
      });
      if (!origin) return { ok: false, detail: 'the intro line was not on screen, so there is no coordinate frame' };
      const dx = anchorAt.x - origin.x;
      const dy = anchorAt.y - origin.y;
      const read = () =>
        S.eval(() => {
          const rows = [...document.querySelectorAll('.sheaf-table tbody tr')];
          const tall = rows[0];
          const short = rows[1];
          if (!tall || !short) return null;
          const cell = tall.querySelector('td:nth-child(4)');
          // The divider is a zone at the bottom of the row-number cell, not an element of its own.
          const divider = tall.querySelector('.sheaf-table-gutter');
          const grid = document.querySelector('.sheaf-table-grid');
          const dr = divider?.getBoundingClientRect();
          return {
            clamped: !!cell?.classList.contains('is-clamped'),
            fitted: tall.classList.contains('is-fitted'),
            hasTall: tall.classList.contains('has-tall-cell'),
            shortHasTall: short.classList.contains('has-tall-cell'),
            tallHeight: Math.round(tall.getBoundingClientRect().height),
            shortTop: Math.round(short.getBoundingClientRect().top),
            // A table has no vertical scroll: fitting a row must make the row tall, never the frame scroll.
            framePagesVertically: !!grid && grid.scrollHeight > grid.clientHeight + 1,
            // The divider on the short row, which must not be drawn at all.
            // A row with nothing to fit has no divider drawn, which is the class the stylesheet keys on.
            shortDividerShown: short.classList.contains('has-tall-cell'),
            divider: dr ? { x: Math.round(dr.left + dr.width / 2), y: Math.round(dr.bottom - 3), w: Math.round(dr.width), h: 7 } : null,
            cursor: divider ? getComputedStyle(divider).cursor : null,
          };
        });
      const before = await read();
      if (!before || !before.divider) return { ok: false, detail: `no divider on the tall row: ${j(before)}` };
      const aim = { x: before.divider.x + dx, y: before.divider.y + dy };
      await S.page.mouse.move(aim.x, aim.y);
      await S.sleep(250);
      /*
       * The cursor read with the pointer in the zone, which is the only moment it means anything. The
       * divider is a zone at the cell's bottom edge rather than an element, so the cell carries the
       * strip's own `pointer` until `tables.ts` sees the pointer arrive and marks it. Read before the
       * move, as this was first written, it is always `pointer` and the promise is never tested.
       */
      const hovering = await S.eval(() => {
        const gut = document.querySelector('.sheaf-table tbody tr .sheaf-table-gutter');
        return gut
          ? { cursor: getComputedStyle(gut).cursor, marked: gut.classList.contains('is-at-divider'), title: gut.title }
          : null;
      });
      await S.page.mouse.dblclick(aim.x, aim.y);
      await S.sleep(700);
      const fitted = await read();
      /*
       * Aimed again from a fresh reading, not at the same point. Fitting the row makes it taller, so
       * its bottom edge and the divider on it move down by exactly the height that was gained, and
       * the first version of this clicked the old coordinates, which by then were inside the fitted
       * row. That read as the clamp refusing to come back.
       */
      if (!fitted?.divider) return { ok: false, detail: `the divider was gone after fitting: ${j(fitted)}` };
      const again = { x: fitted.divider.x + dx, y: fitted.divider.y + dy };
      await S.page.mouse.move(again.x, again.y);
      await S.sleep(250);
      await S.page.mouse.dblclick(again.x, again.y);
      await S.sleep(700);
      const back = await read();
      // And the strip's own gesture, which the divider must not have taken: a click selects the row.
      const selected = await S.eval(() => {
        const gut = document.querySelector('.sheaf-table tbody tr td.sheaf-table-gutter');
        const r = gut?.getBoundingClientRect();
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) } : null;
      });
      let selects = null;
      if (selected) {
        await S.page.mouse.click(selected.x + dx, selected.y + dy);
        await S.sleep(500);
        selects = await S.eval(() => document.querySelectorAll('.sheaf-table tbody tr:first-child td.is-sel, .sheaf-table tbody tr:first-child td[class*="is-sel"]').length);
      }
      const d = await S.disk();
      if (!fitted || !back) return { ok: false, detail: 'the table left the screen partway through' };
      return {
        ok:
          // The precondition: there has to be a clamped cell to release, and a row with nothing to fit to compare against.
          before.clamped &&
          before.hasTall &&
          before.shortHasTall === false &&
          before.shortDividerShown === false &&
          hovering?.marked === true &&
          /*
           * The gesture in words rather than a cursor. `row-resize` was asserted here and it was a false
           * promise: a row is never given a fixed height, so dragging the divider cannot be made to work
           * and did nothing. `pointer` would promise a single click, which is swallowed on purpose so that
           * aiming at the divider cannot pick the row up. There is no cursor for "double-click me", so what
           * is checked is that the cell says so while the pointer is in the zone, and that nothing has put
           * the drag promise back.
           */
          /double-click/i.test(hovering?.title ?? '') &&
          hovering?.cursor !== 'row-resize' &&
          // Fitted: the clamp is off, the row is taller, and what is below it moved down.
          fitted.fitted &&
          !fitted.clamped &&
          fitted.tallHeight > before.tallHeight + 10 &&
          fitted.shortTop > before.shortTop + 10 &&
          !fitted.framePagesVertically &&
          // And back, because this is a flag rather than a height.
          !back.fitted &&
          back.clamped &&
          Math.abs(back.tallHeight - before.tallHeight) <= 2 &&
          Math.abs(back.shortTop - before.shortTop) <= 2 &&
          (selects === null || selects > 0) &&
          d === doc,
        detail:
          `divider ${before.divider.w}x${before.divider.h} at ${before.divider.x},${before.divider.y} then at ` +
          `${fitted.divider?.x},${fitted.divider?.y}; cursor ${before.cursor} at rest and ` +
          `${hovering?.cursor} in the zone, marked ${hovering?.marked}, title ${j(hovering?.title)}; ` +
          `the short row has-tall-cell ${before.shortHasTall} and its divider shown ${before.shortDividerShown}; ` +
          `row height ${before.tallHeight} -> ${fitted.tallHeight} -> ${back.tallHeight}; ` +
          `the row below at ${before.shortTop} -> ${fitted.shortTop} -> ${back.shortTop}; ` +
          `clamped ${before.clamped} -> ${fitted.clamped} -> ${back.clamped}; ` +
          `frame pages vertically while fitted ${fitted.framePagesVertically}; ` +
          `a click on the strip selected ${selects} cell(s); file unchanged ${d === doc}`,
      };
    },
  },
  {
    /*
     * Two things the record claims about a fitted row that nothing had measured: that it is gone
     * after the document is reopened, which is the decision, and that it is still there after an
     * edit somewhere else in the table, which the decision says nothing about and a person would
     * notice at once.
     *
     * The second is the one worth a scenario. The flag lives on the row element, and a table
     * re-renders whenever its source changes, so the question is whether typing in another cell
     * silently re-clamps a row the reader opened. If it does, that is a defect rather than the
     * transience that was chosen: "not remembered across sessions" and "lost when you type" are
     * different promises.
     */
    id: 'render.table-widths.e20',
    feature: 'render.table-widths',
    name: 'A fitted row survives an edit elsewhere in the table, and is clamped again after the window reloads',
    run: async (S) => {
      await zoom(S, null);
      const long =
        'A note that runs well past four lines in a column this narrow, so the grid draws it clamped until the row is fitted to its content.';
      const doc = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | ${long} ${long} ${long} ${long} |\n| no | Drone | Short. |\n\nAfter line\n`;
      await S.fresh('row-fit-persist', doc);
      await S.sleep(1300);
      const state = () =>
        S.eval(() => {
          const tr = document.querySelector('.sheaf-table tbody tr');
          const cell = tr?.querySelector('td:nth-child(4)');
          if (!tr || !cell) return null;
          return {
            fitted: tr.classList.contains('is-fitted'),
            clamped: cell.classList.contains('is-clamped'),
            height: Math.round(tr.getBoundingClientRect().height),
          };
        });
      // Fitted the same way a person does it, through the divider, so this measures the real state.
      const anchorAt = await S.click({ text: 'Intro paragraph', offset: 0 });
      const origin = await S.eval(() => {
        const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro paragraph'));
        const r = el?.getBoundingClientRect();
        return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
      });
      const where = await S.eval(() => {
        const d = document.querySelector('.sheaf-table tbody tr .sheaf-table-gutter');
        const r = d?.getBoundingClientRect();
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) } : null;
      });
      if (!origin || !where) return { ok: false, detail: 'no divider or no coordinate frame' };
      await S.page.mouse.dblclick(where.x + (anchorAt.x - origin.x), where.y + (anchorAt.y - origin.y));
      await S.sleep(700);
      const fitted = await state();
      if (!fitted?.fitted) return { ok: false, detail: `the row did not fit, so neither half can be asked: ${j(fitted)}` };
      /*
       * An edit in another cell of the same table, which re-renders it.
       *
       * Opened with a double-click, because a single click only selects. Committed with **Tab** and
       * not Enter: Enter on the last row adds a row, which took the table's row count from 2 to 3 and
       * dropped the fitting on purpose, since a fitted row is an index and an inserted row makes that
       * index point at a different row. That read as the fitting being lost to typing, which is the
       * thing this scenario exists to tell apart. Escape would cancel, so no re-render would happen at
       * all and the scenario would pass having asked nothing.
       */
      await S.dblclick({ text: 'Drone' });
      await S.sleep(500);
      await S.press('End');
      await S.type('x');
      await S.sleep(300);
      await S.press('Tab');
      await S.sleep(1000);
      const afterEdit = await state();
      await S.command('Developer: Reload Window');
      await S.sleep(6000);
      await S.open('e2e/row-fit-persist.md');
      await S.sleep(1600);
      const reloaded = await state();
      const d = await S.disk();
      if (!afterEdit || !reloaded) return { ok: false, detail: 'the table left the screen partway through' };
      return {
        ok:
          /*
           * The precondition that cost two runs to find: the edit must not change how many rows the
           * table has. Committing with Enter adds a row, which takes the fitting with it on purpose,
           * and that reads exactly like the fitting being lost to typing. Asserted through the row
           * below keeping its place, since a row added at the end moves nothing above it but changes
           * the count, and `is-fitted` surviving is then meaningless.
           */
          afterEdit.height === fitted.height &&
          // Still open after an edit elsewhere: the reader's choice is not undone by typing.
          afterEdit.fitted &&
          !afterEdit.clamped &&
          // And clamped again after a reload, which is the decision: the clamp is the default view.
          !reloaded.fitted &&
          reloaded.clamped &&
          reloaded.height < fitted.height - 10 &&
          // The edit is in the file and the fitting is not.
          d.includes('Dronex'),
        detail:
          `fitted: ${j(fitted)}; after an edit in another cell: ${j(afterEdit)}; after a reload: ${j(reloaded)}; ` +
          `the edit reached the file ${d.includes('Dronex')}`,
      };
    },
  },
  {
    /*
     * The whole rule, one gesture per case, because checking it on a sort alone is what let it ship
     * wrong. The rule: anything that changes which row is where ends every fitting in that table, and a
     * column operation does not.
     *
     * Four of these were measured wrong on the first landing and three of the four were losses in
     * different directions, which is why the matrix is here rather than one case plus one control. A
     * sort ended the fittings correctly; a row *move* kept them, because the call went into `moveColsTo`
     * instead of `moveRowsTo` and nothing distinguished the two; moving a column ended them, for the
     * same reason inverted; and inserting a column ended them by a third mechanism, because the set was
     * keyed by `tableWidthKey`, a column identity, so a change in the column count stranded it under the
     * old key.
     *
     * So each row below is a case the product got wrong, and the three that must *keep* the fittings are
     * what stop a build that simply clears them on any table operation from passing.
     */
    id: 'render.table-widths.e21',
    feature: 'render.table-widths',
    name: 'Reordering rows ends every fitting; sorting, moving, renaming and adding columns each behave as the rule says',
    run: async (S) => {
      await zoom(S, null);
      const long =
        'A note that runs well past four lines in a column this narrow, so the grid draws it clamped until the row is fitted to its content.';
      const doc = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | ${long} ${long} ${long} ${long} |\n| no | Drone | Short. |\n\nAfter line\n`;
      const fittedCount = () => S.eval(() => document.querySelectorAll('.sheaf-table tbody tr.is-fitted').length);
      /** Fit the first row through its divider, which is the gesture a person uses. */
      const fitFirstRow = async () => {
        const anchorAt = await S.click({ text: 'Intro paragraph', offset: 0 });
        const origin = await S.eval(() => {
          const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro paragraph'));
          const r = el?.getBoundingClientRect();
          return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
        });
        const where = await S.eval(() => {
          const d = document.querySelector('.sheaf-table tbody tr .sheaf-table-gutter');
          const r = d?.getBoundingClientRect();
          return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) } : null;
        });
        if (!origin || !where) return false;
        await S.page.mouse.dblclick(where.x + (anchorAt.x - origin.x), where.y + (anchorAt.y - origin.y));
        await S.sleep(700);
        return (await fittedCount()) === 1;
      };
      /*
       * Each case gets a fresh document. Sharing one would let an earlier gesture's reordering decide a
       * later case's answer, and the cases disagree about what the right answer is.
       */
      const cases = [
        { what: 'Sort column A to Z', keeps: false, run: async () => chevron(S, 0, 'col.sortAsc') },
        { what: 'Move row down', keeps: false, run: async () => rowMenu(S, 'Move row down') },
        { what: 'Move column right', keeps: true, run: async () => chevron(S, 0, 'col.moveRight') },
        { what: 'Insert column right', keeps: true, run: async () => chevron(S, 0, 'col.insertRight') },
        { what: 'Fit columns to content', keeps: true, run: async () => tableMenu(S, 'table.fitColumns') },
      ];
      /*
       * One case is absent and cannot currently be written, which is worth saying rather than leaving the
       * matrix looking complete: a move that is invoked and moves nothing must keep the fittings.
       *
       * `moveRowsTo`'s bounds checks return **above** the `endFittingIn` call, so a no-op move never
       * reaches it and the behaviour is there to be tested. Reaching it needs a move that is enabled and
       * then declines, and every move that cannot act is a disabled menu item: `row.moveUp` is
       * `enabled: (t) => t.rowLo > 0`, so on the first row it is dimmed and clicking it runs nothing.
       *
       * Both ways of approaching it were measured and both are vacuous. Right-clicking a cell gives the
       * command that cell's row, so it moves and the case becomes a second copy of "Move row down", with
       * the file changing. Reaching it from the table's bar with nothing selected finds the item disabled,
       * so the fittings survive because nothing ran, which a build that cleared on invocation would pass
       * exactly as a correct one does.
       *
       * So the early return is **unexercised**, in this host and in the browser alike. That is the honest
       * record, and it is not a gap one more gesture closes.
       */
      const seen = [];
      for (const c of cases) {
        await S.fresh(`row-fit-rule-${c.what.replace(/[^a-z]+/gi, '-').toLowerCase()}`, doc);
        await S.sleep(1300);
        if (!(await fitFirstRow())) return { ok: false, detail: `could not fit a row before ${c.what}` };
        await c.run().catch((e) => ({ threw: String(e).slice(0, 60) }));
        await S.sleep(1000);
        const after = await fittedCount();
        const disk = await S.disk();
        // A case that must move nothing has to be shown to have moved nothing, or "the fitting stayed"
        // is a reading of a gesture that never happened.
        const moved = disk !== doc;
        const right = (c.keeps ? after === 1 : after === 0) && (c.moves === false ? !moved : true);
        seen.push({ what: c.what, keeps: c.keeps, after, moved, right });
      }
      const d = await S.disk();
      const wrong = seen.filter((r) => !r.right);
      return {
        ok: wrong.length === 0 && seen.length === cases.length,
        detail:
          seen
            .map((r) => `${r.what}: ${r.after} fitted, wanted ${r.keeps ? 1 : 0}, file moved ${r.moved} ${r.right ? 'ok' : 'WRONG'}`)
            .join('; ') + `; the last document ${d.includes('Keeper') ? 'still holds its rows' : 'lost a row'}`,
      };
    },
  },
  {
    /*
     * A reading of where a table's chrome sits against the table, in the VS Code host.
     *
     * The QA session measured both of these in a browser tab and flagged the both-hosts claim as a
     * reading of the CSS rather than a measurement. This is that measurement. The rule is in the shared
     * bundle with no host in it, so I expect it to hold here too, and expecting is what this replaces.
     *
     * Two quantities, because two things are positioned against the wrap's box rather than the table's:
     * the hover bar's buttons right-align to the pane, so a table that fits its writing column gets its
     * bar at the window's edge; and the board host took none of the inset the grid takes, so a board sat
     * at the pane's left edge while its heading sat 366px in.
     */
    id: 'render.table-widths.e22',
    feature: 'render.table-widths',
    name: 'The hover bar ends where the table ends, and a board starts where the prose starts',
    run: async (S) => {
      await zoom(S, null);
      await S.fresh('chrome-alignment', DOC);
      await S.sleep(1300);
      // Hovered, because the bar is drawn only then.
      await S.hover({ sel: '.sheaf-table-grid table' });
      await S.sleep(500);
      const r = await S.eval(() => {
        const wrap = document.querySelector('.sheaf-table');
        const table = wrap?.querySelector('.sheaf-table-grid table');
        const scroller = document.querySelector('.cm-scroller');
        const para = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) =>
          (l.textContent ?? '').startsWith('Intro paragraph')
        );
        if (!wrap || !table || !scroller || !para) return null;
        const t = table.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        const pane = scroller.getBoundingClientRect();
        const buttons = [...wrap.querySelectorAll('.sheaf-table-controls > *')]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.width > 0);
        const right = buttons.length ? Math.max(...buttons.map((b) => b.right)) : null;
        const prose = para.getBoundingClientRect();
        return {
          table: { left: Math.round(t.left), right: Math.round(t.right) },
          wrap: { left: Math.round(w.left), right: Math.round(w.right) },
          pane: { left: Math.round(pane.left), right: Math.round(pane.right) },
          proseLeft: Math.round(prose.left),
          buttons: buttons.length,
          barRight: right === null ? null : Math.round(right),
          // The two gaps the finding is about: how far the bar's last button is from the table's right
          // edge, and from the window's.
          fromTable: right === null ? null : Math.round(right - t.right),
          fromPane: right === null ? null : Math.round(pane.right - right),
        };
      });
      if (!r || r.barRight === null) return { ok: false, detail: `no hover bar on screen: ${j(r)}` };
      /*
       * Then the board half, from the same document: shown as a board, its lanes must start where the
       * prose does rather than at the pane's edge.
       */
      await tableMenu(S, 'table.showAsBoard');
      await S.sleep(400);
      // Shown as a board asks which column to group by before it draws anything, so the chooser has to be
      // answered or there are no lanes to measure and the reading comes back empty.
      await S.click({ sel: '.sheaf-table-menu-item[data-cmd="table.groupBy.1"]' });
      await S.sleep(1200);
      const board = await S.eval(() => {
        const lanes = [...document.querySelectorAll('.sheaf-board-col')].map((c) => c.getBoundingClientRect());
        const para = [...document.querySelectorAll('.cm-content > .cm-line')].find((l) =>
          (l.textContent ?? '').startsWith('Intro paragraph')
        );
        if (!lanes.length || !para) return null;
        return {
          lanes: lanes.length,
          left: Math.round(Math.min(...lanes.map((l) => l.left))),
          proseLeft: Math.round(para.getBoundingClientRect().left),
        };
      });
      const d = await S.disk();
      return {
        /*
         * Both halves asserted now that the measurement has settled what they should be. Before the fix
         * the bar ended at 1091 against a table ending at 901, and a board's lanes began at the pane's
         * edge while the prose began 192px in; either number alone reproduces one of the two bugs.
         */
        ok:
          r.buttons > 0 &&
          r.table.right > r.table.left &&
          Math.abs(r.fromTable) <= 3 &&
          !!board &&
          board.lanes > 0 &&
          Math.abs(board.left - board.proseLeft) <= 3 &&
          d === DOC,
        detail:
          `table ${r.table.left}..${r.table.right}, wrap ${r.wrap.left}..${r.wrap.right}, ` +
          `pane ${r.pane.left}..${r.pane.right}, prose starts ${r.proseLeft}; ` +
          `${r.buttons} bar buttons ending at ${r.barRight}, which is ${r.fromTable}px past the table's ` +
          `right edge and ${r.fromPane}px short of the pane's; ` +
          `as a board: ${board?.lanes} lanes starting at ${board?.left} against prose at ${board?.proseLeft}; ` +
          `file unchanged ${d === DOC}`,
      };
    },
  },
  {
    /*
     * A numeric column is measured the way it is drawn.
     *
     * `tables.ts` marks a column whose values are all numbers `is-numeric`, and the stylesheet gives that
     * `font-variant-numeric: tabular-nums` so the figures line up. The measuring probe in
     * `columnLayout.ts` built plain cells, so such a column was measured with proportional digits and drawn
     * with tabular ones, the measurement came in short, and the allocator handed the column less than it
     * needs. Every row of the corpus's 800-row table from 100 onward stood 61px instead of 37, because a
     * three-digit number wrapped in a content box a fraction of a pixel too narrow.
     *
     * **Driven against the corpus file the symptom was found in, not a fixture built to show it.** A
     * fixture written for this passed with the probe fix removed, because its numeric column sat at the
     * per-column floor of six characters rather than at its content width, so the measurement never bound
     * and the control could not fail. `stress/large-tables.md` is where the column is actually squeezed to
     * its measured maximum, which is the only place the shortfall decides anything.
     *
     * **Asserted as the claim, not as a digit count.** Tabular pays for the widest digit's advance, so the
     * shortfall depends on which digits rather than how many: across a ruler it is about 3px flat from two
     * digits to ten, and a column of eights loses almost nothing where a column of ones loses a great deal.
     * "Three digits do not wrap" would pass on a corpus of eights and fail on nothing.
     */
    id: 'render.table-widths.e23',
    feature: 'render.table-widths',
    name: 'A column of numbers is given room for the digits it is drawn with, not narrower proportional ones',
    run: async (S) => {
      await zoom(S, null);
      await S.open('stress/large-tables.md');
      await S.sleep(2000);
      const r = await S.eval(() => {
        const cells = [...document.querySelectorAll('.sheaf-table tbody td[data-c="0"]')];
        if (!cells.length) return null;
        /*
         * What the text needs in the cell's own font, from a Range over the cell's own text node, so the
         * cell's `font-variant-numeric` applies. Measuring in a cloned element or on a canvas would repeat
         * the very mistake this is about: a measurement taken somewhere the cell is not.
         */
        const read = cells.map((td) => {
          const cs = getComputedStyle(td);
          const box = td.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
          const text = td.querySelector('.sheaf-table-text') ?? td;
          const range = document.createRange();
          range.selectNodeContents(text);
          const rects = [...range.getClientRects()];
          return {
            value: (td.textContent ?? '').trim(),
            box: Math.round(box * 100) / 100,
            needs: Math.round(Math.max(0, ...rects.map((x) => x.width)) * 100) / 100,
            lines: rects.length,
          };
        });
        return { numeric: cells[0].classList.contains('is-numeric'), variant: getComputedStyle(cells[0]).fontVariantNumeric, read };
      });
      if (!r) return { ok: false, detail: 'no table on screen' };
      /*
       * `wrapped` is the assertion that discriminates and `tooNarrow` is a second, weaker lens, which the
       * control showed rather than my reasoning: with the probe fix removed, 701 of the 800 cells wrap and
       * `tooNarrow` still reports zero, because `needs` is measured from the text as drawn and a wrapped
       * line is narrower than the unwrapped one. So `tooNarrow` cannot see this fault; it catches the
       * different case of a box too small for a single line, and is kept for that.
       */
      const wrapped = r.read.filter((x) => x.lines > 1);
      const tooNarrow = r.read.filter((x) => x.box + 0.5 < x.needs);
      const threeDigits = r.read.filter((x) => x.value.length >= 3);
      const worst = r.read.reduce((a, b) => (b.needs - b.box > a.needs - a.box ? b : a), r.read[0]);
      return {
        ok:
          /*
           * The preconditions, both of which a passing run needs or it is reading an ordinary column. The
           * column has to be drawn with tabular digits, and the fixture has to actually contain the
           * three-digit values whose measurement is the tight one.
           */
          r.numeric === true &&
          r.variant.includes('tabular-nums') &&
          threeDigits.length > 0 &&
          wrapped.length === 0 &&
          tooNarrow.length === 0,
        detail:
          `is-numeric ${r.numeric}, font-variant-numeric ${j(r.variant)}, ${r.read.length} cells of which ` +
          `${threeDigits.length} have three digits or more; tightest is ${j(worst.value)} needing ${worst.needs} ` +
          `in a box of ${worst.box}; wrapped ${wrapped.length}, too narrow ${tooNarrow.length}` +
          (tooNarrow.length ? ` ${j(tooNarrow.slice(0, 3))}` : ''),
      };
    },
  },
  {
    /*
     * A row moved by dragging its number ends every fitting, which is the one route to the rule that
     * the matrix above drives through menus and could not reach.
     *
     * The drag was reported as undrivable three times before the recipe was worked out, and it fails
     * silently rather than loudly: without it the gesture completes with no `is-row-dragging` at all and
     * the row simply does not move, which reads as the product refusing to do it. Three parts matter and
     * all three are here: the row number is **clicked first**, because a press on an unselected one starts
     * a range select rather than a move; there is a **pause after the press**; and there are **enough
     * intermediate moves** for the drop marks to appear.
     */
    id: 'render.table-widths.e24',
    feature: 'render.table-widths',
    name: 'A row dragged by its number to a new place ends every fitted row in the table',
    run: async (S) => {
      await zoom(S, null);
      const long =
        'A note that runs well past four lines in a column this narrow, so the grid draws it clamped until the row is fitted to its content.';
      const doc = `Intro paragraph.\n\n| St | Role | Note |\n| -- | ---- | ---- |\n| ok | Keeper | ${long} ${long} ${long} ${long} |\n| no | Drone | Short. |\n| up | Rook | Brief. |\n\nAfter line\n`;
      await S.fresh('row-fit-strip-drag', doc);
      await S.sleep(1300);
      // One real click to get the window's coordinate frame, as the webview's rectangles are not the window's.
      const anchorAt = await S.click({ text: 'Intro paragraph', offset: 0 });
      const origin = await S.eval(() => {
        const el = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Intro paragraph'));
        const r = el?.getBoundingClientRect();
        return r ? { x: r.left + 10, y: r.top + r.height / 2 } : null;
      });
      if (!origin) return { ok: false, detail: 'no coordinate frame' };
      const dx = anchorAt.x - origin.x;
      const dy = anchorAt.y - origin.y;
      const geom = await S.eval(() => {
        const guts = [...document.querySelectorAll('.sheaf-table tbody tr td.sheaf-table-gutter')];
        if (guts.length < 3) return null;
        const r = (n) => guts[n].getBoundingClientRect();
        return {
          first: { x: Math.round(r(0).left + r(0).width / 2), y: Math.round(r(0).top + r(0).height / 2), bottom: Math.round(r(0).bottom) },
          third: { y: Math.round(r(2).top + r(2).height / 2) },
        };
      });
      if (!geom) return { ok: false, detail: 'fewer than three body rows on screen' };
      // Fit the first row through its divider, then confirm it took: the drag reading is worthless otherwise.
      await S.page.mouse.dblclick(geom.first.x + dx, geom.first.bottom - 3 + dy);
      await S.sleep(700);
      const fitted = await S.eval(() => document.querySelectorAll('.sheaf-table tbody tr.is-fitted').length);
      if (fitted !== 1) return { ok: false, detail: `the row did not fit, so the drag proves nothing: ${fitted} fitted` };
      /*
       * The recipe: select by clicking the number, press, pause, many small moves, release.
       *
       * The selecting click is the part I left out of the code while describing it in the comment above,
       * and the run said so: `is-row-dragging` 0 and the row order unchanged. A press on an *unselected*
       * row number starts a range select rather than a move, so the drag never begins.
       */
      /*
       * Re-read the geometry **after** fitting, which is the second thing I got wrong here. Fitting the
       * first row makes it about 72px taller, so every row below it shifts down and a drop target measured
       * beforehand lands in the wrong row: the drag started and the order did not change. The same mistake
       * as aiming a second double-click at a divider that had moved.
       */
      const now = await S.eval(() => {
        const guts = [...document.querySelectorAll('.sheaf-table tbody tr td.sheaf-table-gutter')];
        if (guts.length < 3) return null;
        const r = (n) => guts[n].getBoundingClientRect();
        return {
          first: { x: Math.round(r(0).left + r(0).width / 2), y: Math.round(r(0).top + r(0).height / 2) },
          third: { y: Math.round(r(2).bottom - 4) },
        };
      });
      if (!now) return { ok: false, detail: 'rows left the screen after fitting' };
      await S.click({ sel: '.sheaf-table tbody tr:first-child td.sheaf-table-gutter' });
      await S.sleep(300);
      await S.page.mouse.move(now.first.x + dx, now.first.y + dy);
      await S.page.mouse.down();
      await S.sleep(250);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const y = now.first.y + ((now.third.y - now.first.y) * i) / steps;
        await S.page.mouse.move(now.first.x + dx, y + dy);
        await S.sleep(40);
      }
      const dragging = await S.eval(() => document.querySelectorAll('.sheaf-table .is-row-dragging').length);
      await S.page.mouse.up();
      await S.sleep(900);
      const after = await S.eval(() => document.querySelectorAll('.sheaf-table tbody tr.is-fitted').length);
      const d = await S.disk();
      const order = d.split('\n').filter((l) => l.startsWith('| ')).map((l) => l.split('|')[1].trim());
      return {
        ok:
          /*
           * The precondition is the whole reason this case is hard: the drag has to have happened. Without
           * `is-row-dragging` and a changed row order, "no row is fitted" would be a reading of a gesture
           * that never ran, and the rule would look checked by a case that checked nothing.
           */
          dragging > 0 &&
          order[2] !== 'ok' &&
          after === 0,
        detail:
          `fitted before the drag ${fitted}; is-row-dragging seen ${dragging}; ` +
          `first column now ${j(order)}; fitted after ${after}`,
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
    name: 'After Developer: Reload Window, a table of wrapped rows is estimated at the height it is drawn at, so nothing under it moves for its sake',
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
      // The table's own block, estimated against drawn. The paragraph's distance is reported but
      // not judged: between the two sits a blank line, which the editor draws 8px tall and
      // estimates at a full line until it has been drawn once, so the paragraph moves about 16px
      // for that line whatever the table does. The estimate is corrected before anything is
      // painted, and a jump to a heading far down a long document lands on the heading, so a
      // reader never sees it; the table's estimate is what this scenario is for.
      const moved = after ? Math.abs(after.tableHeight - first.tableHeight) : Infinity;
      return {
        ok: first.widget && !!after?.drawn && moved <= 2 && d === doc,
        detail: `before drawing: table ${first.tableHeight}px, paragraph ${first.below}px below its top (widget ${first.widget}); drawn: table ${after?.tableHeight}px, paragraph ${after?.below}px below (drawn ${after?.drawn}); table moved ${moved}px; drawn parts ${j(parts)}${d === doc ? '' : '; the file changed'}`,
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
      /*
       * Fitted, every column holds its own content and none of them is sharing: the note
       * column takes its sentence and the two beside it are untouched. Reset, it is the table
       * it was, and the document never changed.
       *
       * What this used to read was `fitted.frameScrolls`: the fitted table wider than its
       * frame. That was a side effect of the frame being the writing column, and it is not
       * one any more — the frame reaches the pane, so whether a fitted table overflows it
       * depends on how wide the window happens to be. Measured both ways: on a 708px column
       * the fitted table is 897 and scrolls, and on a 899px column it is 897 and does not.
       * The same table, the same fit, two answers, and neither of them is about fitting.
       */
      const held = !!before && !!fitted && j(before.heads.slice(0, 3)) === j(fitted.heads.slice(0, 3));
      const took = !!before && !!fitted && fitted.heads[3] !== before.heads[3];
      return {
        ok: offBefore && !offAfter && held && took && !fitted?.clipped && !fitted?.paneScrolls && j(reset?.heads) === j(before?.heads) && d === DOC,
        detail:
          `before ${j(before?.heads)}, fitted ${j(fitted?.heads)} (frame scrolls ${fitted?.frameScrolls}, clipped ${fitted?.clipped}), ` +
          `reset ${j(reset?.heads)}; writing column ${before?.textColumn}; Reset dimmed before ${offBefore}, after ${offAfter}`,
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
  {
    id: 'render.table-widths.e17',
    feature: 'render.table-widths',
    name: 'Typing in a body cell holds every column still, and the column widens to fit once the cell closes',
    run: async (S) => {
      /*
       * Answered again on 2026-09-26: the typing being reported is in the body cells rather than
       * renaming headers. So hand-set widths are not what is being lost; their key is the header
       * row and a body edit cannot reach it.
       *
       * What a body edit does reach is the measurement. `columnLayout.ts` caches a table's measured
       * widths under a digest of the table's content, so a keystroke in any cell is a cache miss, a
       * fresh measurement, and a fresh run of the allocator. The allocator shares the pane's
       * surplus between the columns in proportion to what each one wants, so a letter that makes
       * one column want more takes width from every other column at the same time. That is a whole
       * grid moving under the caret, once per keystroke.
       *
       * This types six letters into one cell, a letter at a time, and reads the drawn `colgroup`
       * after each. What it reports is the largest amount any column moved between one keystroke
       * and the next, and which column it was. The threshold is 2px, which is about a third of a
       * character: below that nothing is visible, above it the grid is moving.
       *
       * The first reading, before any typing, is the control for the probe itself: two reads of an
       * untouched table have to agree, or the numbers say nothing about typing.
       *
       * **Holding the widths is half of it, and asserting only that half passes on a table whose
       * measurement is dead.** "Not while a cell is open" is the rule rather than "never": a column
       * whose content genuinely outgrew it still has to end up wider once the cell closes, or a
       * table filled in from empty keeps its placeholder widths for ever. `columnLayout.ts` says so
       * beside the guard itself, and watches for the close to remeasure. Delete that watcher and
       * the widths freeze permanently, which is a worse defect than the flicker this scenario was
       * written for, and a check that asserts only "nothing moved" reports it as a pass.
       *
       * So both halves are asserted: 0px between keystrokes while the cell is open, and a real
       * widening once it closes. The widening is required only when it is owed, which is measured
       * rather than assumed: the typed text is laid out off the page in the cell's own font and
       * compared against the column's width *before* the close. Asked against the width after it,
       * the test reads "the text fits" exactly when the widening worked, so a successful close
       * would erase its own evidence.
       *
       * Two further controls, both of which have caught a wrong reading of this behaviour. The
       * cell has to be seen open while the typing happens, or the 0px is a reading of a cell that
       * never opened. And it has to be seen closed afterwards, because a width held while a cell
       * is open is the design: a browser probe of this read 0px across the close and called the
       * close path broken, and what had actually happened was that its click to close the cell
       * landed on another row of the same table.
       */
      await zoom(S, null);
      await S.fresh('type-in-body', DOC);
      await S.sleep(1200);
      const still = [await columns(S), await columns(S)];
      /*
       * The cell that sets its column's width, and nothing else will do. The first version of
       * this typed into `Short.`, in a column whose width comes from the long note above it, so
       * the column's widest form never changed, nothing was asked to move, and five readings of
       * 0px passed a check that could not fail. The same fixture fooled the browser probe first.
       */
      const cell = { sel: '.sheaf-table-grid td[data-r="0"][data-c="1"]' };
      const textLen = () =>
        S.eval(() => {
          const td = document.querySelector('.sheaf-table-grid td[data-r="0"][data-c="1"]');
          return td ? td.innerText.length : null;
        });
      /* Whether a cell is open, read exactly as `columnLayout.ts`'s own `cellIsOpen()` reads it. */
      const cellOpen = () => S.eval(() => !!document.querySelector('.sheaf-table-input'));
      /* How wide the typed cell's text wants to be, laid out off the page in the cell's own font. */
      const wants = () =>
        S.eval(() => {
          const td = document.querySelector('.sheaf-table-grid td[data-r="0"][data-c="1"]');
          if (!td) return null;
          const span = document.createElement('span');
          span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(td).font}`;
          span.textContent = td.innerText;
          document.body.appendChild(span);
          const w = Math.round(span.getBoundingClientRect().width);
          span.remove();
          return w;
        });
      const before = await textLen();
      await S.dblclick(cell);
      await S.press('End');
      const openedAtAll = await cellOpen();
      const steps = [];
      for (const ch of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
        await S.type(ch);
        await S.sleep(500);
        steps.push(await columns(S));
      }
      const openWhileTyping = await cellOpen();
      // The cell is closed by putting the caret in the prose below the table, which is how a
      // person leaves one. Located by its text, never by arithmetic on a row's height: three
      // row-heights below the first row is still inside this table.
      await S.caret('After line', 3);
      await S.sleep(900);
      const closed = !(await cellOpen());
      const committed = await columns(S);
      const after = await textLen();
      const textWants = await wants();
      const worst = (a, b) => {
        if (!a || !b || a.cols.length !== b.cols.length) return { px: -1, col: -1 };
        let px = 0;
        let col = -1;
        a.cols.forEach((w, i) => {
          const d = Math.abs(w - b.cols[i]);
          if (d > px) {
            px = d;
            col = i;
          }
        });
        return { px, col };
      };
      const probeNoise = worst(still[0], still[1]);
      const moves = [];
      for (let i = 1; i < steps.length; i++) moves.push(worst(steps[i - 1], steps[i]));
      const whileTyping = moves.reduce((m, x) => (x.px > m.px ? x : m), { px: 0, col: -1 });
      const overCommit = worst(steps[steps.length - 1], committed);
      // The second control: the typing has to have landed in that cell, or every width below is
      // a reading of nothing happening.
      const typed = before !== null && after === before + 12;
      // The column the typing went into, as it stood before the cell closed. The widening is
      // owed only if the text outgrew that, and this fixture is built so that it does.
      const columnWas = still[0] && still[0].cols[2];
      const outgrew = textWants !== null && columnWas != null && textWants > columnWas;
      const widened = overCommit.px > 2;
      return {
        ok: probeNoise.px === 0 && typed && openedAtAll && openWhileTyping && closed && whileTyping.px <= 2 && outgrew && widened,
        detail:
          `cell text ${before} -> ${after} (${typed ? 'the typing landed' : 'THE TYPING DID NOT LAND, so every width here is meaningless'}); ` +
          `the cell opened ${openedAtAll}, was open while typing ${openWhileTyping}, closed afterwards ${closed}` +
          `${closed ? '' : ', SO THE HELD WIDTHS BELOW ARE THE DESIGN AND NOT A READING OF THE CLOSE'}; ` +
          `two reads of the untouched table differ by ${probeNoise.px}px; ` +
          `the widest move between two keystrokes was ${whileTyping.px}px, at column ${whileTyping.col}; ` +
          `per keystroke ${j(moves.map((m) => m.px))}; ` +
          `the typed text wants ${textWants}px and its column was ${columnWas}px, so a widening is ${outgrew ? 'owed' : 'NOT OWED AND THIS FIXTURE PROVES NOTHING'}; ` +
          `on leaving the cell the widest column moved ${overCommit.px}px${widened ? '' : ', SO THE COLUMN NEVER GREW TO FIT'}; ` +
          `columns ${j(still[0] && still[0].cols)} -> ${j(committed && committed.cols)}`,
      };
    },
  },
];
