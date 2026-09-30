/*
 * What typing in a table cell does to the columns, measured in a real browser.
 *
 *   node scripts/check-table-widths.mjs
 *
 * A column's width comes from its widest cell, and the cell somebody is filling in is
 * usually that one, so every keystroke used to be a fresh measurement: the column being
 * typed in widened and the one beside it gave up exactly those pixels, three to nine a
 * keystroke. The text slid sideways under the caret and the prose column rewrapped as it
 * narrowed. The columns hold still now while a cell is open, and the table lays out again
 * when the edit finishes.
 *
 * It is measured here rather than in a suite because `createColumnLayout` is reached by no
 * test entry, and because the thing being asserted is a drawn width: jsdom has no layout,
 * so every column there is zero pixels wide and zero equals zero however the code behaves.
 *
 * Three measurements, and the second and third are what make the first mean anything:
 *
 *   1. Typing in an open cell moves no column at all.
 *   2. The same typing, with no cell open, does move them. Without this, a table that
 *      never measures anything passes the first: "the widths did not change" is what a
 *      broken allocator says too.
 *   3. Closing the cell lets the column take the width its new content needs, because
 *      "not while a cell is open" is the rule and "never" would leave a table filled in
 *      from empty at its placeholder widths for ever.
 *
 * Every reading also carries the length of the cell's own text. That is the control for a
 * different lie: a run where the keystrokes never landed reports perfectly still columns
 * and looks like a pass. The first version of the window scenario for this bug typed into
 * a cell whose column took its width from another row, so nothing was ever asked to move
 * and five keystrokes gave a clean zero.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When either is
 * missing this says so and exits 0, because a missing browser is not a broken document.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

const VIEW = { width: 1200, height: 900 };
/** Enough keystrokes that a three-pixel-a-time drift is unmistakable. */
const TYPED = 'aaaaaaaaaaaa';
/**
 * A three-column table: a short column, a middling one, and one of prose. The cell typed
 * into is the widest of the middle column, which is the only cell whose growth can move
 * anything.
 */
const DOC =
  'Intro.\n\n| St | Role | Note |\n| --- | --- | --- |\n' +
  '| ok | Writer | A note that runs on for a while so the column has something to fit to. |\n' +
  '| no | Reader | Short. |\n';

const CHROME = [
  process.env.SHEAF_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

function skip(why) {
  console.log(`skipped: ${why}`);
  process.exit(0);
}

if (!CHROME) skip('no Chrome or Chromium found; set SHEAF_CHROME to one');
if (!existsSync(join(REPO, 'dist', 'serve.js'))) skip('dist/serve.js is not built; run npm run build first');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  skip('playwright-core is not installed; set PLAYWRIGHT_CORE to its folder');
}

const root = mkdtempSync(join(tmpdir(), 'sheaf-tablewidths-'));
writeFileSync(join(root, 't.md'), DOC);
// The control needs a copy nothing has typed into yet: see where it is used.
writeFileSync(join(root, 'control.md'), DOC);

/* Three shapes for the geometry section: one that cannot fit the writing column, one that
   easily can, and one that belongs to a blockquote and keeps the quote's indent. */
const cols = (n) => Array.from({ length: n }, (_, i) => `Column heading ${i + 1}`);
/*
 * Several paragraphs above the table, not one. The grip moves up out of the rows when the
 * content scrolls under it, and a table against the top of the pane has nowhere above to move
 * to: with a single `Intro.` the grip landed behind the formatting toolbar, which is a real
 * case but the wrong one to make the default reading. The lead-in buys the room; the second
 * reading below scrolls the document to take it away again.
 */
const WIDE =
  'Intro.\n\nA second paragraph, so the table has room above it.\n\nA third, for the same reason.\n\n' +
  `| ${cols(12).join(' | ')} |\n| ${cols(12).map(() => '---').join(' | ')} |\n` +
  Array.from({ length: 40 }, (_, r) => `| ${cols(12).map((_, i) => `row ${r + 1} in column ${i + 1}`).join(' | ')} |`).join('\n') + '\n';
writeFileSync(join(root, 'wide.md'), WIDE);
writeFileSync(join(root, 'narrow.md'), 'Intro.\n\n| St | Role | Note |\n| --- | --- | --- |\n| ok | Writer | Short. |\n');
/* And a tall one that fits, for the sticky header: a table that fits keeps its header by
   `position: sticky`, and which tables fit is exactly what the two-width rule changes. */
writeFileSync(
  join(root, 'tall.md'),
  'Intro.\n\n| St | Role | Note |\n| --- | --- | --- |\n' +
    Array.from({ length: 40 }, (_, r) => `| ok | Writer | Row ${r + 1}. |`).join('\n') +
    '\n'
);
writeFileSync(
  join(root, 'aligned.md'),
  'Intro.\n\n| Month | Solar wind (km/s) | Flares |\n| :--- | ---: | ---: |\n| Jan | 412 | 7 |\n'
);
writeFileSync(
  join(root, 'quoted.md'),
  'Intro.\n\n> | St | Role |\n> | --- | --- |\n> | ok | Writer |\n'
);
/* And the same table attached to a list item, which is the ordinary way to hang a small
   table off one point in a list. Its lines carry the item's indent in the file. */
writeFileSync(
  join(root, 'listed.md'),
  'Intro.\n\n- one\n\n  | St | Role |\n  | --- | --- |\n  | ok | Writer |\n\n- two\n'
);

/** The drawn column widths, and the length of the cell being typed into. */
const read = (page) =>
  page.evaluate(() => ({
    cols: [...document.querySelectorAll('.sheaf-table col')].map((c) => Math.round(parseFloat(c.style.width) || 0)),
    cell: document.querySelector('.sheaf-table-grid td[data-r="0"][data-c="1"]')?.textContent?.length ?? -1,
  }));

const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'Without it no table would be drawn at all and that would read as a width fault.',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

try {
  const page = await browser.newPage({ viewport: VIEW });
  await page.goto(`${base}/edit/t.md`);
  await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
  await page.waitForTimeout(2500);

  // 1. Typing with the cell open.
  const before = await read(page);
  await page.dblclick('.sheaf-table-grid td[data-r="0"][data-c="1"]');
  await page.waitForTimeout(500);
  const seen = new Set();
  for (const ch of TYPED) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(110);
    seen.add((await read(page)).cols.join(','));
  }
  const open = await read(page);
  console.log(`  with a cell open: ${seen.size} width vector${seen.size === 1 ? '' : 's'} across ${TYPED.length} keystrokes, cell text ${before.cell} -> ${open.cell}`);
  if (open.cell <= before.cell) {
    failures.push(`the typing never landed: the cell's text went from ${before.cell} to ${open.cell}, so still columns prove nothing`);
  } else if (seen.size !== 1) {
    failures.push(`with a cell open the columns took ${seen.size} different widths while typing: ${[...seen].join('  |  ')}`);
  }

  // 3. Closing it lets the column take its new width.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const closed = await read(page);
  console.log(`  on closing the cell: ${JSON.stringify(before.cols)} -> ${JSON.stringify(closed.cols)}`);
  if (closed.cols.join(',') === before.cols.join(',')) {
    failures.push(
      `closing the cell left every column at its old width, ${JSON.stringify(closed.cols)}. ` +
        `The rule is "not while a cell is open", not "never": a table filled in from empty would keep its placeholder widths for ever.`
    );
  }

  // 2. The control, on its own untouched copy of the document. Reusing the first one is
  //    what this check caught itself doing: by then the column was already at the width
  //    the typing had given it, so nothing further could move and the control read as a
  //    dead allocator. A control that cannot move is not a control.
  await page.goto(`${base}/edit/control.md`);
  await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
  await page.waitForTimeout(2000);
  const plain = await read(page);
  const moved = new Set([plain.cols.join(',')]);
  // A longer value each round, each committed before the next is typed, so every reading
  // is taken with no cell open and the allocator has been asked each time. Lengthening
  // rather than repeating, because a double-click selects the cell's text and typing
  // replaces it: three rounds of the same four characters set the same width three times
  // and read as an allocator that never moves, which is what this control exists to rule
  // out. It caught itself doing exactly that.
  for (const value of ['bbbb', 'bbbbbbbbbbbb', 'bbbbbbbbbbbbbbbbbbbbbbbb']) {
    await page.dblclick('.sheaf-table-grid td[data-r="0"][data-c="1"]');
    await page.waitForTimeout(400);
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    moved.add((await read(page)).cols.join(','));
  }
  console.log(`  CONTROL, a longer value committed each round: ${moved.size} width vector${moved.size === 1 ? '' : 's'} from ${JSON.stringify(plain.cols)}`);
  if (moved.size < 2) {
    failures.push(
      `CONTROL: committing a longer value each round moved the columns to ${moved.size} width vector${moved.size === 1 ? '' : 's'}. ` +
        `This table never re-measures at all, so the first measurement above cannot tell a held width from a dead allocator.`
    );
  }
  /* ---- Where a table sits: the pane, not the writing column ---------------- */

  /*
   * Measured here rather than asserted from the stylesheet, because the number that makes
   * it work is not in the stylesheet: the room outside `.cm-content` comes from its
   * `margin: 0 auto`, and `paneWidth.ts` measures it and publishes it. A rule reading a
   * property nobody sets resolves to its fallback and draws exactly as it did before, so
   * the CSS would pass a reading of itself while the table sat where it always sat.
   */
  const geometry = () =>
    page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      const frame = document.querySelector('.sheaf-table');
      const grid = document.querySelector('.sheaf-table-grid');
      const scroller = document.querySelector('.cm-scroller');
      const editor = document.querySelector('.cm-editor');
      const para = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent ?? '').startsWith('Intro'));
      return {
        frame: box(frame),
        para: box(para),
        // The table element itself, not its first data cell: the cell sits past the row-number
        // gutter column, and what should line up with the prose is where the table starts.
        firstCell: box(grid?.querySelector('table')),
        // The scroller's own right edge inside any vertical scrollbar, which is the pane.
        paneRight: scroller ? Math.round(scroller.getBoundingClientRect().left) + scroller.clientWidth : null,
        overhang: editor ? getComputedStyle(editor).getPropertyValue('--md-pane-overhang').trim() : '',
        total: [...document.querySelectorAll('.sheaf-table col')].reduce((s, c) => s + (parseFloat(c.style.width) || 0), 0),
        scrollLeft: grid ? Math.round(grid.scrollLeft) : -1,
        // The editor's own sideways scroll, which must never appear: the table scrolls.
        docOverflow: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
      };
    });

  const near = (a, b, slack = 2) => a !== null && b !== null && Math.abs(a - b) <= slack;

  const openDoc = async (name) => {
    await page.goto(`${base}/edit/${name}`);
    await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
    await page.waitForTimeout(2000);
    return geometry();
  };

  const wide = await openDoc('wide.md');
  console.log(
    `  a 12-column table: frame ${wide.frame?.left}..${wide.frame?.right}, pane right ${wide.paneRight}, ` +
      `first cell at ${wide.firstCell?.left}, text at ${wide.para?.left}, overhang ${wide.overhang}`
  );
  if (!near(wide.frame?.right, wide.paneRight)) {
    failures.push(
      `a wide table's frame ends at ${wide.frame?.right} and the pane at ${wide.paneRight}. ` +
        `The gutter beside it is the empty space this was meant to give to the table.`
    );
  }
  if (!near(wide.firstCell?.left, wide.para?.left)) {
    failures.push(
      `a wide table's first column starts at ${wide.firstCell?.left} and the paragraph above it at ${wide.para?.left}. ` +
        `At rest they line up; the room the frame gained is padding inside the scroller, not a shift of the content.`
    );
  }
  if (wide.overhang === '' || wide.overhang === '0px') {
    failures.push(
      `--md-pane-overhang is ${JSON.stringify(wide.overhang)} on a ${VIEW.width}px pane, where the writing column is far narrower. ` +
        `Nothing published it, so every rule reading it fell back and the table was drawn exactly as it was before.`
    );
  }
  if (wide.docOverflow > 0) {
    failures.push(`the editor itself scrolls sideways by ${wide.docOverflow}px. The table scrolls; the document never does.`);
  }

  // Scrolled right, the content crosses into the left margin: that is what the inset being
  // padding inside the scroller buys, and a margin outside it could not do.
  await page.evaluate(() => {
    const grid = document.querySelector('.sheaf-table-grid');
    if (grid) grid.scrollLeft = 200;
  });
  await page.waitForTimeout(400);
  const scrolled = await geometry();
  console.log(`  scrolled right by ${scrolled.scrollLeft}px: first cell at ${scrolled.firstCell?.left}, text at ${scrolled.para?.left}`);
  if (!(scrolled.scrollLeft > 100 && scrolled.firstCell !== null && scrolled.firstCell.left < (scrolled.para?.left ?? 0) - 50)) {
    failures.push(
      `scrolled right by ${scrolled.scrollLeft}px the first column is at ${scrolled.firstCell?.left}, with the text at ${scrolled.para?.left}. ` +
        `It should have passed into the left margin, so the whole pane is table.`
    );
  }

  /*
   * What the frame took from the left margin, which is the thing this geometry could break
   * without looking any different. The frame spans the pane, so it lies over the margin the
   * block handle and the line-number gutter live in, and a press there has to reach them
   * rather than the table.
   */
  /*
   * Hovered by moving the pointer to a point, not by `page.hover(selector)`, which scrolls the
   * element into view first. That scroll put the table's header against the top of the pane,
   * which is the one position where the grip has nowhere above to move to, so the reading was
   * always the fallback and never the behaviour.
   */
  const tableBox = await page.evaluate(() => {
    const r = document.querySelector('.sheaf-table-grid table')?.getBoundingClientRect();
    return r ? { x: r.left + Math.min(r.width / 2, 300), y: r.top + Math.min(r.height / 2, 120) } : null;
  });
  if (!tableBox) failures.push('the wide table was not on the screen, so the block handle was not measured');
  else {
    await page.mouse.move(tableBox.x, tableBox.y);
    await page.waitForTimeout(500);
  }
  const margin = await page.evaluate(() => {
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'nothing';
      const named = el.closest('.sheaf-block-handle, .sheaf-table') ?? el;
      return `${named.tagName.toLowerCase()}.${(named.className || '').toString().split(' ')[0]}`;
    };
    const handle = document.querySelector('.sheaf-block-handle:not([hidden])');
    if (!handle) return { handle: null };
    const r = handle.getBoundingClientRect();
    /*
     * What the handle's rectangle is drawn *over*, which is a different question from what a
     * press at its middle reaches and is the one a screenshot fails.
     *
     * The handle is above the table in paint order, so it answers the press wherever it is
     * put, including squarely on top of a column header in the middle of the data. Those two
     * readings come apart exactly when the frame spans the margin, which is the condition the
     * press reading reports as satisfied. Measured against the cells rather than against the
     * frame: the frame reaching under the handle is the design, a cell under it is the bug.
     */
    const over = [...document.querySelectorAll('.sheaf-table th, .sheaf-table td')]
      .map((c) => ({ c, b: c.getBoundingClientRect() }))
      .filter(({ b }) => b.width > 0 && b.right > r.left + 1 && b.left < r.right - 1 && b.bottom > r.top + 1 && b.top < r.bottom - 1)
      .map(({ c, b }) => `${(c.textContent ?? '').trim().slice(0, 12) || '(empty)'} at ${Math.round(b.left)}`);
    return {
      handle: { left: Math.round(r.left), width: Math.round(r.width) },
      // The handle's own middle: it has to answer for itself, whatever the frame under it does.
      onHandle: at(r.left + r.width / 2, r.top + r.height / 2),
      over,
      // Where the grid's own content starts on screen, so a handle inside the data is obvious.
      cellsFrom: Math.round(document.querySelector('.sheaf-table th, .sheaf-table td')?.getBoundingClientRect().left ?? 0),
      // The grip's line against the header row's, so a grip that should have gone up onto the
      // controls bar and did not is distinguishable from one that is simply in the wrong column.
      gripTop: Math.round(r.top),
      headerTop: Math.round(document.querySelector('.sheaf-table tr')?.getBoundingClientRect().top ?? 0),
    };
  });
  console.log(
    `  the block handle beside a scrolled table: ${JSON.stringify(margin?.handle)}, a press on it lands on ${margin?.onHandle}, ` +
      `drawn over ${margin?.over?.length ? JSON.stringify(margin.over) : 'no cell'}; grip top ${margin?.gripTop}, header top ${margin?.headerTop}`
  );
  if (!margin?.handle) {
    failures.push(
      `no block handle appeared beside a table, so whether the frame reaching into the margin takes its clicks was not measured at all.`
    );
  } else if (!/sheaf-block-handle/.test(margin.onHandle ?? '')) {
    failures.push(
      `a press on the block handle beside a scrolled table lands on ${margin.onHandle}. ` +
        `The frame now spans that margin, and the handle has to stay above it.`
    );
  }
  if (margin?.over?.length) {
    failures.push(
      `the block handle is drawn over ${margin.over.length} cell(s) of a scrolled table: ${JSON.stringify(margin.over)}.\n` +
        `    Its own left edge is ${margin.handle.left} and the grid's cells start at ${margin.cellsFrom}. The grip belongs in the\n` +
        `    margin beside the table; on top of a column header it reads as a stray glyph inside the data.`
    );
  }
  if (margin?.handle && margin.gripTop >= margin.headerTop) {
    failures.push(
      `the grip is at ${margin.gripTop} with the header row at ${margin.headerTop}, so it is still on the rows.\n` +
        `    Every row of a scrolled table has a cell in the grip's column; the strip above the header is the only clear place.`
    );
  }

  /*
   * Scrolled to the far end: the margin that says this is the end.
   *
   * The scroller's inset is padding on both sides, so at rest the right one sits beyond the
   * table in the scroll extent and is invisible, and scrolled fully right it is the gap after
   * the last column. Read as the distance from the last cell's right edge to the frame's, which
   * is what a person sees, rather than as the declaration.
   *
   * `scrollLeft` is set past the end on purpose and read back: the browser clamps it to the
   * maximum, so this cannot depend on knowing what that maximum is.
   */
  const end = await page.evaluate(() => {
    const grid = document.querySelector('.sheaf-table-grid');
    const frame = document.querySelector('.sheaf-table');
    if (!grid || !frame) return null;
    grid.scrollLeft = 1e6;
    const cells = [...grid.querySelectorAll('th')];
    const last = cells[cells.length - 1]?.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(grid).paddingLeft) || 0;
    return {
      atEnd: Math.round(grid.scrollLeft),
      gap: last ? Math.round(f.right - last.right) : null,
      lastVisible: !!last && last.right <= f.right + 1 && last.left >= f.left - 1,
      inset: Math.round(inset),
    };
  });
  await page.waitForTimeout(300);
  console.log(`  scrolled fully right (${end?.atEnd}px): ${end?.gap}px after the last column, against a left inset of ${end?.inset}px`);
  /*
   * And the widths the columns were laid out at, printed so the next change to this geometry
   * can be compared against them by eye. The right inset is padding, and `roomFor` reads
   * `clientWidth`, which is the padding box and does not grow when padding is added, so adding
   * it moved nothing: this is that claim written down rather than reasoned about.
   */
  const wideCols = await page.evaluate(() =>
    [...document.querySelectorAll('.sheaf-table col')].map((c) => Math.round(parseFloat(c.style.width) || 0))
  );
  // Thirteen, because the row-number gutter is a column of the table too and is the 17px one.
  const wideTotal = wideCols.reduce((a, b) => a + b, 0);
  console.log(`  its columns: ${JSON.stringify(wideCols)}, totalling ${wideTotal}px`);
  if (wideCols.length !== 13) failures.push(`the wide table laid out ${wideCols.length} columns rather than 13, so its widths were not measured`);
  else if (Math.abs(wideTotal - 1404) > 24) {
    failures.push(
      `the wide table's columns total ${wideTotal}px against the 1404px measured with and without the right inset.\n` +
        `    Padding is outside the width the allocator is handed; if that has changed, the allocator is seeing a different pane.`
    );
  }
  if (!end || end.gap === null) failures.push('the wide table had no header cells to measure at its far end');
  else {
    if (end.gap < end.inset - 2) {
      failures.push(
        `scrolled fully right the last column ends ${end.gap}px from the frame's right edge, against a left inset of ${end.inset}px.\n` +
          `    With no margin after it, the end of the table looks exactly like a table with more past the edge.`
      );
    }
    if (!end.lastVisible) failures.push(`scrolled fully right the last column is not fully inside the frame`);
  }

  /*
   * Scrolled back, the grip goes back. The placement follows the table's scroll now, and a
   * listener that only ever moved the grip one way would leave it hanging above the table for
   * the rest of the document's life.
   */
  await page.evaluate(() => {
    const grid = document.querySelector('.sheaf-table-grid');
    if (grid) grid.scrollLeft = 0;
  });
  await page.waitForTimeout(400);
  const rested = await page.evaluate(() => {
    const h = document.querySelector('.sheaf-block-handle:not([hidden])');
    const row = document.querySelector('.sheaf-table tr');
    if (!h || !row) return null;
    const r = h.getBoundingClientRect();
    const t = row.getBoundingClientRect();
    return { gripTop: Math.round(r.top), headerTop: Math.round(t.top), headerBottom: Math.round(t.bottom) };
  });
  console.log(`  scrolled back to rest: grip top ${rested?.gripTop}, header row ${rested?.headerTop}..${rested?.headerBottom}`);
  if (!rested) failures.push('the grip went away when the table was scrolled back to rest, and at rest it belongs beside the header row');
  else if (rested.gripTop < rested.headerTop - 2) {
    failures.push(
      `back at rest the grip is at ${rested.gripTop} with the header row at ${rested.headerTop}, so it stayed lifted.\n` +
        `    At rest the first column is on the text's left edge and the margin is the grip's again.`
    );
  }

  /*
   * And the control 674 names. A fix that hid or moved the grip near any table would pass
   * every reading above; a table that fits the writing column has nothing scrolling under
   * anything, and its grip has to be exactly where it has always been.
   */
  await page.goto(`${base}/edit/narrow.md`);
  await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
  await page.waitForTimeout(900);
  const narrowBox = await page.evaluate(() => {
    const r = document.querySelector('.sheaf-table-grid table')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (narrowBox) await page.mouse.move(narrowBox.x, narrowBox.y);
  await page.waitForTimeout(500);
  const narrowGrip = await page.evaluate(() => {
    const h = document.querySelector('.sheaf-block-handle:not([hidden])');
    const row = document.querySelector('.sheaf-table tr');
    if (!h || !row) return null;
    const r = h.getBoundingClientRect();
    const t = row.getBoundingClientRect();
    return { gripMid: Math.round(r.top + r.height / 2), headerMid: Math.round(t.top + t.height / 2) };
  });
  console.log(`  CONTROL, a narrow table that does not scroll: grip middle ${narrowGrip?.gripMid}, header row middle ${narrowGrip?.headerMid}`);
  if (!narrowGrip) {
    failures.push('CONTROL: no grip beside a narrow table at all, so the fix took the handle away from tables that never scroll');
  } else if (Math.abs(narrowGrip.gripMid - narrowGrip.headerMid) > 3) {
    failures.push(
      `CONTROL: beside a narrow table the grip's middle is at ${narrowGrip.gripMid} against the header row's ${narrowGrip.headerMid}.\n` +
        `    A table that fits the writing column has nothing scrolling under anything and must be untouched.`
    );
  }

  /*
   * Dragging one column's divider changes that column and nothing else.
   *
   * The drag pins one column, and the allocator takes a pinned column out of the division and
   * runs its rules over what is left, so every pixel the dragged column gained used to be a
   * pixel the rest gave up. Read at each step of the drag rather than only at the end, because
   * "the others moved" and "the others moved and moved back" are different things.
   */
  await page.goto(`${base}/edit/narrow.md`);
  await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  const gripAt = await page.evaluate(() => {
    // The divider on the second column's header, which has columns either side of it.
    const g = [...document.querySelectorAll('.sheaf-table th .sheaf-table-resize')][1];
    const r = g?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  const cols = () => page.evaluate(() => [...document.querySelectorAll('.sheaf-table col')].map((c) => Math.round(parseFloat(c.style.width) || 0)));
  if (!gripAt) {
    failures.push('no resize grip was drawn on the narrow table, so a column drag was not measured');
  } else {
    const start = await cols();
    await page.mouse.move(gripAt.x, gripAt.y);
    await page.mouse.down();
    const during = [];
    for (const step of [40, 80, 120]) {
      await page.mouse.move(gripAt.x + step, gripAt.y);
      await page.waitForTimeout(120);
      during.push(await cols());
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    const end = await cols();
    const sum = (v) => v.reduce((a, b) => a + b, 0);
    console.log(`  a column dragged 120px wider: ${JSON.stringify(start)} -> ${JSON.stringify(end)}`);
    console.log(`    totals ${sum(start)} -> ${during.map(sum).join(' -> ')} -> ${sum(end)}`);
    /*
     * Which columns moved, other than the one being dragged. The grip sits on the second
     * header, and the first `col` is the row-number gutter, so the dragged column is index 2.
     */
    const dragged = 2;
    const others = start.map((w, i) => (i === dragged ? null : end[i] - w)).filter((d, i) => d !== null && Math.abs(d) > 1 && i !== dragged);
    const gained = end[dragged] - start[dragged];
    console.log(`    the dragged column gained ${gained}px; ${others.length} other column(s) moved by ${JSON.stringify(others)}`);
    if (gained < 100) {
      failures.push(`the dragged column gained ${gained}px from a 120px drag, so the drag itself did not take, and the rest proves nothing`);
    } else if (others.length) {
      failures.push(
        `dragging one column 120px wider moved ${others.length} other column(s) by ${JSON.stringify(others)}.\n` +
          `    Widening the column you cared about should not take the space from all the others; getting two of\n` +
          `    them right then means dragging back and forth.`
      );
    }
    // And the table grew by what the drag added, rather than holding the pane's width.
    if (sum(end) - sum(start) < 100) {
      failures.push(`the table's total went ${sum(start)} -> ${sum(end)} across a 120px drag, so the width is still a fixed budget`);
    }

    /*
     * Dragged past the pane, the table's own frame scrolls and the document does not.
     *
     * Independent widths mean the total is no longer bounded by the pane, so this is the case
     * the freeze creates: without somewhere to overflow to, widening a column past the
     * remaining room has nowhere to go. The editor's own horizontal scrollbar appearing would
     * be the wrong answer and is asked about separately.
     */
    await page.mouse.move(gripAt.x + 120, gripAt.y);
    await page.mouse.down();
    await page.mouse.move(gripAt.x + 900, gripAt.y);
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(700);
    const past = await page.evaluate(() => {
      const wrap = document.querySelector('.sheaf-table');
      const grid = document.querySelector('.sheaf-table-grid');
      const scroller = document.querySelector('.cm-scroller');
      return {
        total: [...document.querySelectorAll('.sheaf-table col')].reduce((a, c) => a + Math.round(parseFloat(c.style.width) || 0), 0),
        pane: Math.round(grid?.clientWidth ?? 0),
        scrollX: !!wrap?.classList.contains('is-scroll-x'),
        frameScrolls: (grid?.scrollWidth ?? 0) > (grid?.clientWidth ?? 0) + 1,
        docScrolls: (scroller?.scrollWidth ?? 0) > (scroller?.clientWidth ?? 0) + 1,
      };
    });
    console.log(
      `  dragged past the pane: total ${past.total} against a ${past.pane}px grid, is-scroll-x ${past.scrollX}, ` +
        `the frame scrolls ${past.frameScrolls}, the document scrolls sideways ${past.docScrolls}`
    );
    if (past.total <= past.pane) failures.push(`the drag did not take the table past the pane (${past.total} of ${past.pane}), so the overflow was not measured`);
    else {
      if (!past.frameScrolls) failures.push(`a table wider than its pane does not scroll inside its frame, so its last columns are unreachable`);
      if (!past.scrollX) failures.push(`a table wider than its pane is not marked is-scroll-x, which is what its header row is held by`);
      if (past.docScrolls) failures.push(`the document scrolls sideways: the table has to scroll inside its own frame, never widen the editor`);
    }
  }

  /*
   * The control, and the issue names it as the one that matters: a table nobody has dragged
   * still lays out automatically and still follows the pane.
   *
   * Freezing every column on the first drag is safe only because it happens on the drag. A fix
   * that pinned a table when it was drawn would pass every reading above and quietly stop every
   * table in every document from ever responding to a pane again, which nothing else here asks
   * about. Measured on a fresh page, so no drag has touched it.
   */
  await page.goto(`${base}/edit/narrow.md`);
  await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  const wide1200 = await cols();
  await page.setViewportSize({ width: 820, height: VIEW.height });
  await page.waitForTimeout(1200);
  const narrow820 = await cols();
  await page.setViewportSize(VIEW);
  await page.waitForTimeout(900);
  console.log(`  CONTROL, a table nobody dragged, pane 1200 -> 820: ${JSON.stringify(wide1200)} -> ${JSON.stringify(narrow820)}`);
  if (JSON.stringify(wide1200) === JSON.stringify(narrow820)) {
    failures.push(
      `CONTROL: a table nobody has dragged kept the identical widths ${JSON.stringify(wide1200)} across a pane of 1200 and one of 820.\n` +
        `    Automatic layout is for tables nobody has set by hand, and it has to keep following the pane.`
    );
  }

  /*
   * What a table's header does when the document scrolls past it. Read and printed rather
   * than asserted, because it does not stick in a tab at all today and this geometry is not
   * why: measured at -450 with the pane at 37..900, identically with the frame reaching the
   * pane and with that taken out, on a table that fits and on one that does not. Filed as a
   * gap of its own.
   *
   * It is printed here because this is where somebody changing the geometry will look. The
   * rule is `overflow-x: visible` on a fitting table, so its frame is not a scroll container
   * and the header sticks to the editor — and which table fits is exactly what the two-width
   * rule above changes.
   */
  await openDoc('tall.md');
  await page.evaluate(() => document.querySelector('.cm-scroller')?.scrollTo({ top: 600 }));
  await page.waitForTimeout(500);
  const stuck = await page.evaluate(() => {
    /*
     * The header **row**, not the `<thead>`.
     *
     * `position: sticky` is on `.sheaf-table thead tr`, and a `<thead>` whose child row is
     * sticky does not move itself: its own box stays with the table and scrolls away. Reading
     * the `<thead>` therefore reports a header that never sticks, whatever the row does, and
     * that reading is what a whole issue was filed on. Both are printed here so the next
     * person can see the difference rather than pick one.
     */
    const row = document.querySelector('.sheaf-table thead tr');
    const head = document.querySelector('.sheaf-table thead');
    const frame = document.querySelector('.sheaf-table');
    const scroller = document.querySelector('.cm-scroller');
    if (!row || !scroller) return null;
    return {
      rowTop: Math.round(row.getBoundingClientRect().top),
      headTop: head ? Math.round(head.getBoundingClientRect().top) : null,
      paneTop: Math.round(scroller.getBoundingClientRect().top),
      scrolls: frame?.classList.contains('is-scroll-x') ?? null,
      sticky: getComputedStyle(row).position,
    };
  });
  console.log(
    `  a fitting table scrolled past: header row at ${stuck?.rowTop} (${stuck?.sticky}), pane top ${stuck?.paneTop}, ` +
      `its <thead> box at ${stuck?.headTop}, frame scrolls sideways ${stuck?.scrolls}`
  );
  // The row holds at the top of the pane, within a pixel of subpixel layout.
  if (stuck && Math.abs(stuck.rowTop - stuck.paneTop) > 2) {
    failures.push(
      `a fitting table's header row is at ${stuck.rowTop} with the pane top at ${stuck.paneTop}, so it did not hold.\n` +
        `    Forty rows in, a table whose header has scrolled away has no column names.`
    );
  }
  if (stuck?.scrolls !== false) {
    failures.push(
      `the tall three-column table came out with is-scroll-x ${stuck?.scrolls}. It fits the writing column, ` +
        `so it should not be a scrolling frame: that is what lets its header stick to the editor.`
    );
  }
  await page.evaluate(() => document.querySelector('.cm-scroller')?.scrollTo({ top: 0 }));
  await page.waitForTimeout(400);

  const narrow = await openDoc('narrow.md');
  console.log(`  a 3-column table: total ${Math.round(narrow.total)}px, frame ${narrow.frame?.left}..${narrow.frame?.right}, text at ${narrow.para?.left}`);
  if (!near(narrow.firstCell?.left, narrow.para?.left)) {
    failures.push(`a narrow table's first column is at ${narrow.firstCell?.left} and the text at ${narrow.para?.left}; it should sit in the column with the prose.`);
  }
  if (narrow.total > (narrow.para?.width ?? 0) + 2) {
    failures.push(
      `a narrow table was laid out ${Math.round(narrow.total)}px wide against a writing column of ${narrow.para?.width}px. ` +
        `The allocator was handed the pane, which is the circularity: a table only reaches past the column because it did not fit it.`
    );
  }

  /*
   * The header chevron has room beside the label rather than over it.
   *
   * It sits in the cell's right padding, which is empty on a left-aligned header and is
   * where a right-aligned label ends — and numeric columns are right-aligned by default, so
   * in exactly the tables people keep it landed against the last character and read as a
   * glyph in the column's name rather than as a control.
   *
   * Measured on a right-aligned header and a left-aligned one in the same table, because a
   * reading of the left one alone was always clear and says nothing.
   */
  await openDoc('aligned.md');
  await page.hover('.sheaf-table-grid thead th[data-c="1"]');
  await page.waitForTimeout(400);
  const chevrons = await page.evaluate(() =>
    [...document.querySelectorAll('.sheaf-table-grid thead th[data-c]')].map((th) => {
      const text = th.querySelector('.sheaf-table-text');
      const chev = th.querySelector('.sheaf-table-chevron');
      const t = text?.getBoundingClientRect();
      const c = chev?.getBoundingClientRect();
      return {
        label: (text?.textContent ?? '').trim().slice(0, 20),
        align: getComputedStyle(th).textAlign,
        gap: t && c ? Math.round(c.left - t.right) : null,
      };
    })
  );
  console.log(`  the header chevron: ${chevrons.map((c) => `${JSON.stringify(c.label)} ${c.align} gap ${c.gap}px`).join(', ')}`);
  const right = chevrons.find((c) => c.align === 'right');
  const left = chevrons.find((c) => c.align === 'left');
  if (!right || !left) {
    failures.push(`the aligned fixture drew ${JSON.stringify(chevrons.map((c) => c.align))}, so a right-aligned header was never measured`);
  } else if (!(right.gap >= 4)) {
    failures.push(
      `on the right-aligned header ${JSON.stringify(right.label)} the chevron sits ${right.gap}px from the label. ` +
        `Against the last character it reads as a glyph in the column's name rather than as a control.`
    );
  }

  const quoted = await openDoc('quoted.md');
  console.log(`  a quoted table: frame ${quoted.frame?.left}..${quoted.frame?.right}, text at ${quoted.para?.left}`);

  /*
   * And a table attached to a list item, which should start where that item's text starts,
   * the way a quoted one starts where the quote's text starts.
   *
   * Measured against the item's own words rather than against a number: the indent a list
   * gives its content is the thing being matched, so reading it from the item is what makes
   * this a comparison rather than a second copy of the same guess.
   */
  await openDoc('listed.md');
  const listed = await page.evaluate(() => {
    // The bullet is drawn into the line's own text, so it reads '•one' rather than 'one'.
    const item = [...document.querySelectorAll('.cm-line')].find((l) => /one$/.test(l.textContent.trim()));
    const frame = document.querySelector('.sheaf-table');
    const firstCell = document.querySelector('.sheaf-table th, .sheaf-table td');
    if (!item || !frame) return null;
    // Where the item's words begin, not where its bullet does: a marker is drawn in the
    // indent, so the text's own left edge is what the table has to line up with.
    const walk = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let wordsLeft = null;
    for (let n; (n = walk.nextNode()); ) {
      const i = n.data.indexOf('one');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 3);
      wordsLeft = Math.round(r.getBoundingClientRect().left);
      break;
    }
    return {
      itemLeft: Math.round(item.getBoundingClientRect().left),
      wordsLeft,
      frameLeft: Math.round(frame.getBoundingClientRect().left),
      cellLeft: firstCell ? Math.round(firstCell.getBoundingClientRect().left) : null,
      usesPane: frame.classList.contains('can-use-pane'),
      itemDepth: getComputedStyle(item).getPropertyValue('--md-list-depth').trim() || null,
      frameLineDepth: (() => {
        const line = frame.closest('.cm-line');
        return line ? getComputedStyle(line).getPropertyValue('--md-list-depth').trim() || null : 'no cm-line';
      })(),
      step: getComputedStyle(document.documentElement).getPropertyValue('--md-indent-step').trim(),
    };
  });
  console.log(
    `  a table under a list item: the item's line at ${listed?.itemLeft}, its words at ${listed?.wordsLeft}, ` +
      `the table's first cell at ${listed?.cellLeft} (can-use-pane ${listed?.usesPane}, item depth ${listed?.itemDepth}, table line depth ${listed?.frameLineDepth}, step ${listed?.step})`
  );
  if (!listed || listed.wordsLeft === null || listed.wordsLeft === undefined) {
    failures.push(`the list fixture drew no item to measure the table against: ${JSON.stringify(listed)}`);
  } else {
    /*
     * Measured against the item's own words, not against a number written here. The indent a
     * list gives its content is the thing being matched, so reading it off the item is what
     * makes this a comparison rather than a second copy of the same guess.
     *
     * Two assertions, because either alone passes something wrong. A table drawn at the right
     * place while still claiming the pane would overhang the item it belongs to; a table that
     * gave up the pane and stayed at the bullets would still be drawn in the wrong place.
     */
    if (Math.abs(listed.cellLeft - listed.wordsLeft) > 2) {
      failures.push(
        `a table under a list item starts at ${listed.cellLeft} while the item's own words start at ${listed.wordsLeft}.`
      );
    }
    if (listed.usesPane) {
      failures.push('a table under a list item may not take the pane: it belongs to the item, not to the document.');
    }
  }
  if (quoted.frame !== null && quoted.frame.left < (quoted.para?.left ?? 0)) {
    failures.push(
      `a table inside a blockquote starts at ${quoted.frame.left}, left of the prose at ${quoted.para?.left}. ` +
        `It belongs to the quote and starts where the quote's text starts.`
    );
  }

  // A pane no wider than the writing column: the overhang is nothing and everything above
  // comes out where it was before any of this, which is what a phone and a split editor get.
  await page.setViewportSize({ width: 700, height: VIEW.height });
  await page.waitForTimeout(600);
  const small = await openDoc('wide.md');
  console.log(`  on a 700px pane: overhang ${small.overhang}, frame ${small.frame?.left}..${small.frame?.right}, pane right ${small.paneRight}`);
  if (small.overhang !== '0px') {
    failures.push(`--md-pane-overhang is ${JSON.stringify(small.overhang)} on a pane narrower than the writing column, where there is no room outside it.`);
  }
  if (small.docOverflow > 0) {
    failures.push(`on a narrow pane the editor scrolls sideways by ${small.docOverflow}px.`);
  }
  await page.setViewportSize(VIEW);
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} table-width measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log('\ncolumns hold still while a cell is open, take their new width when it closes, and do move when the table is measured.');
