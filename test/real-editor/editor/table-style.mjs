// How a table is drawn, in real VS Code and in three themes: the half of the styling that only a
// window can answer, because a fill written as a percentage of the foreground resolves differently
// in each theme.
//   node test/real-editor/run-editor.mjs table-style [id]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const j = (x) => JSON.stringify(x);

const TABLE = ['| Part | Qty | Note |', '| --- | --- | --- |'].concat(
  Array.from({ length: 12 }, (_, i) => `| part ${i + 1} | ${i + 1} | note ${i + 1} |`)
).join('\n');
const DOC = `Intro paragraph.\n\n${TABLE}\n\nAfter line\n`;

const THEMES = [
  ['Default Light Modern', 'light'],
  ['Default Dark Modern', 'dark'],
  ['Default High Contrast', 'high contrast'],
];

/** Put a theme on through the profile, which VS Code watches. */
async function theme(S, name) {
  const path = join(S.run, 'user', 'User', 'settings.json');
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  cur['workbench.colorTheme'] = name;
  writeFileSync(path, JSON.stringify(cur, null, 2));
  await S.sleep(2000);
}

/** What the grid is painted with right now. */
const paint = (S) =>
  S.eval(() => {
    // A colour comes back either as `rgb(59, 59, 59)` or, once a color-mix is involved, as
    // `color(srgb 0.5 0.5 0.5 / 0.8)` with components from 0 to 1. Reading the second form as
    // 0-to-255 makes every mixed colour look black, which is how a check like this passes for the
    // wrong reason.
    const lum = (v) => {
      const n = (v.match(/[\d.]+/g) || []).map(Number);
      if (n.length < 3) return null;
      const scale = /color\(/.test(v) ? 255 : 1;
      const [r, g, b] = n.slice(0, 3).map((x) => x * scale);
      const a = n.length > 3 ? n[3] : 1;
      return a === 0 ? null : Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    };
    const rows = [...document.querySelectorAll('.sheaf-table tbody tr')];
    const cellBg = rows.map((tr) => getComputedStyle(tr.querySelector('td:not(.sheaf-table-gutter)')).backgroundColor);
    const gutter = rows[0].querySelector('.sheaf-table-gutter');
    const cell = rows[0].querySelector('td:not(.sheaf-table-gutter)');
    return {
      rows: rows.length,
      distinctCellBackgrounds: [...new Set(cellBg)],
      gutterBg: gutter ? getComputedStyle(gutter).backgroundColor : null,
      gutterColour: gutter ? getComputedStyle(gutter).color : null,
      gutterLum: gutter ? lum(getComputedStyle(gutter).color) : null,
      cellColour: getComputedStyle(cell).color,
      cellLum: lum(getComputedStyle(cell).color),
      editorBg: getComputedStyle(document.body).backgroundColor,
      editorBgLum: lum(getComputedStyle(document.body).backgroundColor),
      gutterBorder: gutter ? getComputedStyle(gutter).borderRightWidth : null,
    };
  });

/** The fill and text colour of the header and row number a one-cell selection marks, beside an unmarked pair. */
const axisPaint = (S) =>
  S.eval(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, marked: el.classList.contains('is-sel-axis') } : null;
    };
    return {
      header: cs('.sheaf-table [data-r="-1"][data-c="1"]'),
      otherHeader: cs('.sheaf-table [data-r="-1"][data-c="2"]'),
      gutter: cs('.sheaf-table tbody tr:nth-child(2) .sheaf-table-gutter'),
      otherGutter: cs('.sheaf-table tbody tr:nth-child(4) .sheaf-table-gutter'),
    };
  });

const themeScenarios = THEMES.map(([name, label], i) => ({
  id: `render.table-style.e0${i + 1}`,
  feature: 'render.table-style',
  name: `In a ${label} theme no row is tinted differently from any other, and the row numbers read quieter than the cell text`,
  run: async (S) => {
    await theme(S, name);
    await S.fresh(`tstyle-${label.replace(/\s+/g, '-')}`, DOC);
    await S.sleep(900);
    const m = await paint(S);
    const d = await S.disk();
    // One background across every body row is the stripe being gone. The row numbers have to be
    // quieter than the cell text and still drawn, and the gutter keeps its cell border, which is
    // what stands in for a fill where a 4% mix cannot be seen.
    const uniform = m.distinctCellBackgrounds.length === 1;
    // Quieter means between the page and the cell text, not merely different from it: a gutter
    // further from the background than the text would be louder, and the difference alone cannot
    // tell the two apart.
    const between =
      m.gutterLum !== null &&
      m.cellLum !== null &&
      m.editorBgLum !== null &&
      Math.abs(m.gutterLum - m.editorBgLum) < Math.abs(m.cellLum - m.editorBgLum) &&
      Math.abs(m.gutterLum - m.editorBgLum) > 20;
    const quieter = between;
    const framed = parseFloat(m.gutterBorder ?? '0') > 0;
    return {
      ok: uniform && quieter && framed && d === DOC,
      detail: `${m.rows} rows, ${m.distinctCellBackgrounds.length} background(s) ${j(m.distinctCellBackgrounds)}; page ${m.editorBgLum}, row numbers ${m.gutterLum}, cell text ${m.cellLum}; gutter fill ${m.gutterBg}, border ${m.gutterBorder}${d === DOC ? '' : '; the file changed'}`,
    };
  },
}));

/*
 * A selection leaves its column's header and its row's number looking exactly as they did. In
 * the selection colour they read as links, and as more things selected beside the cells that
 * were. Each check compares the header and row number the selection spans against a neighbour
 * it does not, so it holds in whatever theme is on. Selecting a whole column by its header leaves
 * the header untinted too.
 */
const axisScenario = {
  id: 'render.table-style.e04',
  feature: 'render.table-style',
  name: 'Selecting cells, or a whole column, leaves the column headers and row numbers drawn as they were',
  run: async (S) => {
    await theme(S, THEMES[1][0]);
    await S.fresh('tstyle-axis', DOC);
    await S.sleep(900);
    await S.click({ sel: '.sheaf-table [data-r="1"][data-c="1"]' });
    await S.sleep(300);
    const m = await axisPaint(S);
    // Take the whole column by its header, with the pointer well off every header afterwards.
    await S.click({ sel: '.sheaf-table [data-r="-1"][data-c="2"]' });
    await S.sleep(300);
    await S.hover({ sel: '.sheaf-table [data-r="3"][data-c="1"]' });
    await S.sleep(200);
    const whole = await S.eval(() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null;
      };
      return { header: cs('.sheaf-table [data-r="-1"][data-c="2"]'), other: cs('.sheaf-table [data-r="-1"][data-c="0"]') };
    });
    const d = await S.disk();
    // Marked for the code that shows the column menu, and drawn the same as its neighbour.
    const same = (marked, other) => !!marked && !!other && marked.marked && !other.marked && marked.bg === other.bg && marked.color === other.color;
    const wholeSame = !!whole.header && !!whole.other && whole.header.bg === whole.other.bg && whole.header.color === whole.other.color;
    const ok = same(m.header, m.otherHeader) && same(m.gutter, m.otherGutter) && wholeSame && d === DOC;
    return { ok, detail: `one cell ${j(m)}; whole column ${j(whole)}${d === DOC ? '' : '; the file changed'}` };
  },
};

/*
 * A table's header row stays at the top of the editor while its rows scroll past, so
 * the columns keep their names. A header with nothing in it keeps nothing, and used to
 * ride down the table as an opaque band across whatever row it was over.
 */
const stickyHeader = {
  id: 'render.table-style.e05',
  feature: 'render.table-style',
  name: 'A named header holds its place at the top of the pane with an edge under it, and an empty one scrolls away instead of covering a row',
  run: async (S) => {
    const rows = Array.from({ length: 30 }, (_, i) => `| Ship ${i + 1} | Holding at station ${i + 1} |`).join('\n');
    const doc = (header) => `# Report\n\n${header}\n| --- | --- |\n${rows}\n\nAfter.\n`;
    /**
     * Scroll the table's top well above the top of the editor and read its header row.
     * One table per document: CodeMirror draws the viewport, so a second table further
     * down the file is not in the DOM to be measured until it is scrolled to.
     */
    const readAfterScroll = async (name, header) => {
      await S.fresh(name, doc(header));
      await S.sleep(900);
      const scrolled = await S.eval(() => {
        const scroller = document.querySelector('.cm-scroller');
        const table = document.querySelector('.sheaf-table .sheaf-table-grid > table');
        if (!scroller || !table) return { error: 'no table on screen' };
        scroller.scrollTop = table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + 300;
        return {};
      });
      if (scrolled.error) return scrolled;
      await S.sleep(500);
      return S.eval(() => {
        const scroller = document.querySelector('.cm-scroller');
        const table = document.querySelector('.sheaf-table .sheaf-table-grid > table');
        const head = table?.tHead?.rows[0];
        if (!scroller || !table || !head) return { error: 'the table left the viewport' };
        const top = scroller.getBoundingClientRect().top;
        return {
          blank: head.classList.contains('is-blank'),
          stuck: head.classList.contains('is-stuck'),
          position: getComputedStyle(head).position,
          // Where the row sits, and where its table's top sits, both from the top of
          // the editor. A held row has stayed near the top while its table went up.
          fromTop: Math.round(head.getBoundingClientRect().top - top),
          tableTop: Math.round(table.getBoundingClientRect().top - top),
        };
      });
    };

    const named = await readAfterScroll('sticky-named', '| Vessel | Status |');
    const empty = await readAfterScroll('sticky-empty', '|  |  |');
    const d = await S.disk();
    return {
      ok:
        !named.error &&
        !empty.error &&
        // Held: the table's top is far above the editor's, and the header is not.
        named.blank === false &&
        named.tableTop < -200 &&
        named.fromTop - named.tableTop > 200 &&
        // And it is held at the top of the pane, not a padding's depth below it with
        // the rows above it still showing.
        Math.abs(named.fromTop) <= 2 &&
        // With its edge drawn. This was never set for a table that fits its pane,
        // so a row passed under the header with nothing between them.
        named.stuck === true &&
        // The empty one is marked, never stuck, and has gone up with its table.
        empty.blank === true &&
        empty.stuck === false &&
        empty.position === 'static' &&
        Math.abs(empty.fromTop - empty.tableTop) < 40 &&
        d === doc('|  |  |'),
      detail: `named ${JSON.stringify(named)}; empty ${JSON.stringify(empty)}${d === doc('|  |  |') ? '' : '; the file changed'}`,
    };
  },
};

/*
 * A table's commands appear over it when the pointer is on it, and take no room when they
 * are not showing. Held in the flow, the bar left a 29px band above every table, invisible
 * until hovered and never used at all on a touch screen. The grid now starts at its frame's
 * 8px padding, and the bar, when shown, sits over the top-right of the table with its
 * bottom at the grid's top edge, clear of every header cell.
 */
const floatingBar = {
  id: 'render.table-style.e06',
  feature: 'render.table-style',
  name: 'The hover bar takes no room above a table, and when it shows it sits right-aligned above the header without covering a header cell',
  run: async (S) => {
    await S.fresh('tstyle-bar', DOC);
    await S.sleep(900);
    const read = () =>
      S.eval(() => {
        const wrap = document.querySelector('.sheaf-table');
        const grid = wrap?.querySelector('.sheaf-table-grid');
        const bar = wrap?.querySelector('.sheaf-table-controls');
        if (!wrap || !grid || !bar) return { error: 'no table on screen' };
        // The last line of the paragraph above: "Intro paragraph." is the first line.
        const intro = document.querySelector('.cm-line');
        const r = (el) => el.getBoundingClientRect();
        const heads = [...wrap.querySelectorAll('thead th:not(.sheaf-table-corner)')].map((th) => r(th));
        const buttons = [...bar.querySelectorAll('.sheaf-table-ctrl')].filter((b) => b.offsetParent).map((b) => r(b));
        const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return {
          // From the frame's top to the grid's: the frame's padding and nothing else.
          frameToGrid: Math.round(r(grid).top - r(wrap).top),
          // From the paragraph above to the grid, for comparing against the old 29px band.
          introToGrid: Math.round(r(grid).top - r(intro).bottom),
          // The widget's height is its padding and its grid, and no bar.
          extra: Math.round(r(wrap).height - r(grid).height),
          opacity: getComputedStyle(bar).opacity,
          barBottomToGrid: Math.round(r(grid).top - r(bar).bottom),
          barRightToGrid: Math.round(r(grid).right - r(bar).right),
          rightmostButtonToGrid: buttons.length ? Math.round(r(grid).right - Math.max(...buttons.map((b) => b.right))) : null,
          buttons: buttons.length,
          coversHeader: buttons.some((b) => heads.some((h) => overlaps(b, h))),
          collapsed: bar.classList.contains('is-collapsed'),
          pageScrollsSideways: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
        };
      });
    // Hover the paragraph, well away from the table, and then a cell.
    await S.hover({ sel: '.cm-line' });
    await S.sleep(300);
    const idle = await read();
    await S.hover({ sel: '.sheaf-table [data-r="3"][data-c="1"]' });
    await S.sleep(300);
    const shown = await read();
    const d = await S.disk();
    const ok =
      !idle.error &&
      !shown.error &&
      // The frame's 0.5em, give or take a pixel, where it was 8px plus a 29px bar.
      Math.abs(idle.frameToGrid - 8) <= 1 &&
      Math.abs(idle.extra - 16) <= 1 &&
      idle.opacity === '0' &&
      // Showing the bar moves nothing.
      shown.frameToGrid === idle.frameToGrid &&
      shown.introToGrid === idle.introToGrid &&
      shown.opacity === '1' &&
      // Right-aligned with the grid, its bottom on the grid's top edge, no header cell under it.
      Math.abs(shown.barBottomToGrid) <= 1 &&
      Math.abs(shown.barRightToGrid) <= 1 &&
      shown.rightmostButtonToGrid !== null &&
      shown.rightmostButtonToGrid >= 0 &&
      shown.rightmostButtonToGrid <= 2 &&
      shown.buttons >= 3 &&
      !shown.coversHeader &&
      !shown.collapsed &&
      !shown.pageScrollsSideways &&
      d === DOC;
    return { ok, detail: `idle ${j(idle)}; hovered ${j(shown)}${d === DOC ? '' : '; the file changed'}` };
  },
};

/*
 * Where the column-header chevron sits, which nothing checked before.
 *
 * Two things have to hold at once and they pull against each other. It should be inset from
 * the column's right border on the same rhythm as the heading text, so it reads as part of the
 * cell. And its left edge must stay clear of the middle of the cell, because a click aimed at
 * the middle of a narrow column belongs to the header and not to the menu.
 *
 * Only a window can answer either: both are positions after layout, and jsdom has none. The
 * second needs a column narrower than any allocation produces, so it is forced through the
 * colgroup, which is what sizes a column. An inline width on the `th` is ignored, and setting
 * one reads as a pass while testing nothing.
 */
const chevronInset = {
  id: 'render.table-style.e07',
  feature: 'render.table-style',
  name: 'The column chevron is inset from the column border like the heading, and never covers the middle of a narrow column',
  run: async (S) => {
    await S.fresh('tstyle-chevron', DOC);
    await S.sleep(900);
    const read = () =>
      S.eval(async () => {
        const table = document.querySelector('.sheaf-table table');
        const ths = [...(table?.querySelectorAll('thead th:not(.sheaf-table-corner)') ?? [])];
        if (!table || ths.length < 2) return { error: 'no table header on screen' };
        const box = (el) => el.getBoundingClientRect();
        /** Hover a header and report where its chevron landed. */
        const measure = async (th) => {
          th.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
          th.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 140));
          const c = th.querySelector('.sheaf-table-chevron');
          if (!c) return null;
          const t = box(th);
          const b = box(c);
          const heading = th.firstElementChild ?? th;
          return {
            cell: Math.round(t.width),
            // From the cell's right border to the button's right edge.
            inset: Math.round(t.right - b.right),
            width: Math.round(b.width),
            // Positive means the left edge is right of the cell's centre, which is the rule.
            pastCentre: Math.round(b.left - (t.left + t.width / 2)),
            textInset: Math.round(box(heading).left - t.left),
          };
        };
        const natural = await measure(ths[0]);
        // Forced narrow, through the colgroup: the allocation never goes below about 85px, so
        // the clearance rule is unreachable on any real table and would be untested without this.
        const index = [...ths[0].parentElement.children].indexOf(ths[1]);
        const col = table.querySelectorAll(':scope > colgroup > col')[index];
        const forced = [];
        if (col) {
          for (const w of [40, 30, 24]) {
            col.style.width = `${w}px`;
            const m = await measure(ths[1]);
            if (m) forced.push(m);
          }
          col.style.width = '';
        }
        return { natural, forced };
      });
    const m = await read();
    const d = await S.disk();
    if (m.error || !m.natural) {
      return { ok: false, detail: `${m.error ?? 'no chevron appeared on hover'}` };
    }
    const ok =
      // Inset on the cell's own rhythm rather than on its border: half the 12px padding,
      // give or take the border itself.
      m.natural.inset >= 4 &&
      m.natural.inset <= 8 &&
      m.natural.inset < m.natural.textInset &&
      // Never over the middle, at any width the formula can reach.
      m.natural.pastCentre > 0 &&
      m.forced.length === 3 &&
      m.forced.every((f) => f.pastCentre > 0) &&
      // And nothing about drawing it may write to the file.
      d === DOC;
    return {
      ok,
      detail: `natural ${j(m.natural)}; forced narrow ${j(m.forced)}${d === DOC ? '' : '; the file changed'}`,
    };
  },
};

export const scenarios = [...themeScenarios, axisScenario, stickyHeader, floatingBar, chevronInset];
