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
 * One selected cell marks its column's header and its row's number, in colour alone. A fill on
 * either read as two more selected things beside the one that was. Each check compares the marked
 * header and row number against an unmarked neighbour, so it holds in whatever theme is on.
 */
const axisScenario = {
  id: 'render.table-style.e04',
  feature: 'render.table-style',
  name: 'Selecting one cell colours its column header and row number without filling either',
  run: async (S) => {
    await theme(S, THEMES[1][0]);
    await S.fresh('tstyle-axis', DOC);
    await S.sleep(900);
    await S.click({ sel: '.sheaf-table [data-r="1"][data-c="1"]' });
    await S.sleep(300);
    const m = await axisPaint(S);
    const d = await S.disk();
    const pair = (marked, other) =>
      !!marked && !!other && marked.marked && !other.marked && marked.bg === other.bg && marked.color !== other.color;
    const ok = pair(m.header, m.otherHeader) && pair(m.gutter, m.otherGutter) && d === DOC;
    return { ok, detail: `${j(m)}${d === DOC ? '' : '; the file changed'}` };
  },
};

export const scenarios = [...themeScenarios, axisScenario];
