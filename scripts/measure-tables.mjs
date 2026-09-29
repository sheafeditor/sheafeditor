/*
 * What a wide table costs, measured in a real browser.
 *
 *   npm run measure:tables
 *
 * A table is one block widget, and CodeMirror virtualises blocks rather than the inside of
 * one, so every cell of a rendered table is in the DOM whether or not it is on screen. At
 * 200 columns by 200 rows that is forty thousand cells. This measures what that costs
 * before anyone decides whether to virtualise columns, because column virtualisation has to
 * keep the sticky header aligned, keep find working inside a cell that was never drawn, and
 * keep a copy of a range copying cells that do not exist, and none of that is worth paying
 * for on a guess.
 *
 * **Six shapes, and the two smallest decide the most.** 12x12 is the control, and without it
 * the rest are numbers with nothing to be large or small against: a first paint of 900ms
 * means nothing until the control says the same code paints a table in 100. 200x50 and
 * 50x200 are the other decisive pair, because they hold the same ten thousand cells in
 * opposite shapes, which is the only way to tell a cost that follows the cell count from one
 * that follows the row count. The remaining three stretch the range: 200x20 is columns alone,
 * 50x1000 is rows alone, and 200x200 is forty thousand cells.
 *
 * **What the keystroke figure is and is not.** It is wall time from pressing a key to the
 * second animation frame after it, driven through the browser from outside, so it carries
 * the driver's round trip and is an upper bound rather than the cost of the keystroke
 * itself. The round trip is the same for every shape, so the comparison against the control
 * is the signal and the absolute number is not. It is measured in a cell and again in the
 * paragraph above the table, because a keystroke that is slow in both is the document's
 * fault and one that is slow only in a cell is the table's.
 *
 * **Scrolling is measured as frame pacing, not as elapsed time.** Thirty frames of scrolling
 * are requested one per animation frame; if a frame takes 60ms the browser cannot keep up.
 * Elapsed time alone would say only that thirty frames happened.
 *
 * It needs Chrome and playwright-core, which a contributor may not have. When either is
 * missing this says so and exits 0, because a missing browser is not a slow table. It
 * measures and reports; it asserts nothing and fails nothing, so it is not a gate.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/** Wide enough that a 200-column table plainly overflows rather than nearly fitting. */
const VIEW = { width: 1200, height: 900 };

/**
 * The shapes, smallest first so a run that dies on the largest still reports the rest.
 *
 * `12x12` is the control. The rest separate columns from rows from their product: if 200x20
 * is cheap and the large shapes are dear, the cost is the cell count; if 200x20 alone is
 * dear, it is the column count and virtualising columns is the answer. Measured, it is the
 * cell count, and 200x20 is indistinguishable from the control.
 */
const SHAPES = [
  { name: '12x12', cols: 12, rows: 12 },
  { name: '200x20', cols: 200, rows: 20 },
  /*
   * These two hold the same ten thousand cells in opposite shapes, which is the only way to
   * tell a cost that follows the cell count from one that follows the row count. Without
   * the pair, 200x20 being cheap and 50x1000 being dear is explained equally well by either.
   */
  { name: '200x50', cols: 200, rows: 50 },
  { name: '50x200', cols: 50, rows: 200 },
  { name: '50x1000', cols: 50, rows: 1000 },
  { name: '200x200', cols: 200, rows: 200 },
];

/** Enough presses that one slow frame does not decide the median. */
const PRESSES = 15;
/** Frames of scrolling per measurement. Half a second at 60fps. */
const SCROLL_FRAMES = 30;
/** How long a table gets to appear before this gives up on that shape. */
const DRAW_MS = 90_000;

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

/*
 * One document per shape: a heading, a paragraph, and the table.
 *
 * The paragraph is what the in-prose keystroke is measured in, and it sits above the table
 * so that measuring it does not require scrolling past forty thousand cells first. Cell text
 * is short and carries its own coordinates, so a cell seen in a screenshot can be named.
 */
function tableDoc(cols, rows) {
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const head = row(Array.from({ length: cols }, (_, c) => `Column ${c + 1}`));
  const rule = row(Array.from({ length: cols }, () => '---'));
  const body = Array.from({ length: rows }, (_, r) =>
    row(Array.from({ length: cols }, (_, c) => `r${r + 1}c${c + 1}`))
  );
  return ['# Table measurement', '', 'A paragraph above the table, which the in-prose keystroke is measured in.', '', head, rule, ...body, ''].join('\n');
}

const root = mkdtempSync(join(tmpdir(), 'sheaf-tables-'));
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.lineNumbers': false }, null, 2));
for (const s of SHAPES) writeFileSync(join(root, `${s.name}.md`), tableDoc(s.cols, s.rows));

const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'so there is nothing to measure a table in.',
});

/** What the drawn document holds: the cells, the whole node count, and the heap. */
const shapeOfDom = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector('.sheaf-table-grid');
    return {
      cells: document.querySelectorAll('.sheaf-table-grid td, .sheaf-table-grid th').length,
      nodes: document.getElementsByTagName('*').length,
      // Chrome only, and absent behind a flag. Reported as null rather than guessed.
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      scrollWidth: grid ? grid.scrollWidth : null,
      clientWidth: grid ? grid.clientWidth : null,
    };
  });

/**
 * Wall time per keystroke, median and worst, from the press to the second frame after it.
 *
 * Two frames rather than one because the first can be scheduled before the work the
 * keystroke caused has run; one frame reported a table that relaid out every keystroke as
 * costing the same as one that did not.
 */
async function perKeystroke(page, watch) {
  const textOf = () => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, watch);
  const before = await textOf();
  const times = [];
  for (let i = 0; i < PRESSES; i++) {
    const t = Date.now();
    await page.keyboard.press('x');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    times.push(Date.now() - t);
  }
  const after = await textOf();
  const sorted = [...times].sort((a, b) => a - b);
  /*
   * Whether the typing reached the document, which decides whether the timing means
   * anything. A keystroke that lands nowhere still takes a measurable amount of time to
   * press and to wait two frames for, so without this the figure reads as a fast editor
   * when what it is measuring is an editor that ignored fifteen keys.
   */
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    worst: sorted.at(-1),
    landed: before !== null && after !== null && after !== before,
    grew: before !== null && after !== null ? after.length - before.length : null,
  };
}

/** Frame pacing while `selector` is scrolled by `dx`/`dy`, one step per animation frame. */
const scrollPacing = (page, selector, dx, dy, frames) =>
  page.evaluate(
    ({ selector, dx, dy, frames }) =>
      new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (!el) return resolve(null);
        const gaps = [];
        let last = performance.now();
        let n = 0;
        const step = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          el.scrollLeft += dx;
          el.scrollTop += dy;
          if (++n < frames) requestAnimationFrame(step);
          else {
            // The first gap is the wait for the first frame, not a frame of scrolling.
            const real = gaps.slice(1).sort((a, b) => a - b);
            resolve({
              median: Math.round(real[Math.floor(real.length / 2)] * 10) / 10,
              worst: Math.round(real.at(-1) * 10) / 10,
              moved: Math.round(dx ? el.scrollLeft : el.scrollTop),
            });
          }
        };
        requestAnimationFrame(step);
      }),
    { selector, dx, dy, frames }
  );

/** Everything for one shape. Returns null, having said why, when the table never drew. */
async function measure(page, shape) {
  const began = Date.now();
  await page.goto(`${base}/edit/${shape.name}.md`, { timeout: DRAW_MS });
  try {
    await page.waitForSelector('.cm-content', { timeout: DRAW_MS });
  } catch {
    console.log(`  ${shape.name}: the editor never drew within ${DRAW_MS / 1000}s`);
    return null;
  }
  const contentMs = Date.now() - began;
  try {
    // A cell rather than the table: the table's own box appears before its contents do.
    await page.waitForSelector('.sheaf-table-grid td', { timeout: DRAW_MS });
  } catch {
    console.log(`  ${shape.name}: the table never drew within ${DRAW_MS / 1000}s`);
    return null;
  }
  const tableMs = Date.now() - began;

  /*
   * A settle before anything is measured. The width allocator runs after first paint, and
   * measuring a keystroke during it attributes the allocation to the keystroke.
   */
  await page.waitForTimeout(2000);
  const dom = await shapeOfDom(page);

  // In prose first, while nothing in the table is open.
  const PROSE = '.cm-content .cm-line:nth-of-type(2)';
  await page.click(PROSE);
  await page.waitForTimeout(250);
  const prose = await perKeystroke(page, PROSE);

  /*
   * Then in a cell, which takes a double click rather than a click: `tables.ts` opens the
   * editor on `dblclick`, and a single click only selects the cell. A first run of this
   * clicked once, found no editor, and reported the cell figure as unmeasured for all four
   * shapes, which is the right failure but was still the wrong gesture.
   *
   * If the editor still does not open, say so rather than reporting the prose figure twice
   * under a different name.
   */
  let cell = null;
  /*
   * `td[role="gridcell"]` rather than `td`, because the first `td` in the grid is the row
   * number in the gutter column, which carries no handler at all. A first run of this
   * double-clicked that one and reported the cell figure as unmeasured for every shape.
   */
  await page.dblclick('.sheaf-table-grid td[role="gridcell"]');
  const opened = await page
    .waitForSelector('.sheaf-table-input', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) {
    await page.waitForTimeout(250);
    cell = await perKeystroke(page, '.sheaf-table-input');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  const across = await scrollPacing(page, '.sheaf-table-grid', 40, 0, SCROLL_FRAMES);
  const down = await scrollPacing(page, '.cm-scroller', 0, 40, SCROLL_FRAMES);

  return { shape, contentMs, tableMs, dom, prose, cell, opened, across, down };
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: VIEW });

const results = [];
console.log(`measuring in ${CHROME.split('/').at(-1)} at ${VIEW.width}x${VIEW.height}\n`);
for (const shape of SHAPES) {
  console.log(`${shape.name} (${shape.cols} columns x ${shape.rows} rows, ${shape.cols * shape.rows} cells)`);
  const r = await measure(page, shape);
  if (r) {
    console.log(`  editor drawn      ${r.contentMs}ms`);
    console.log(`  table drawn       ${r.tableMs}ms`);
    console.log(`  cells in the DOM  ${r.dom.cells}   nodes ${r.dom.nodes}   heap ${r.dom.heapMB ?? 'n/a'}MB`);
    console.log(`  table width       scrollWidth ${r.dom.scrollWidth} against clientWidth ${r.dom.clientWidth}`);
    const landing = (k) => (k.landed ? `text grew by ${k.grew}` : 'THE TYPING LANDED NOWHERE, so this figure means nothing');
    console.log(`  keystroke, prose  median ${r.prose.median}ms   worst ${r.prose.worst}ms   (${landing(r.prose)})`);
    console.log(
      r.opened
        ? `  keystroke, cell   median ${r.cell.median}ms   worst ${r.cell.worst}ms   (${landing(r.cell)})`
        : `  keystroke, cell   no cell editor opened on double click, so not measured`
    );
    console.log(`  scroll across     median frame ${r.across?.median ?? 'n/a'}ms   worst ${r.across?.worst ?? 'n/a'}ms   moved ${r.across?.moved ?? 'n/a'}px`);
    console.log(`  scroll down       median frame ${r.down?.median ?? 'n/a'}ms   worst ${r.down?.worst ?? 'n/a'}ms   moved ${r.down?.moved ?? 'n/a'}px`);
    results.push(r);
  }
  console.log('');
}

/*
 * The summary, as one row per shape against the control, because the ratio is what a
 * decision about virtualising gets made on.
 */
const control = results.find((r) => r.shape.name === '12x12');
if (control && results.length > 1) {
  console.log('against the 12x12 control');
  console.log('shape      cells   table drawn   keystroke in cell   scroll across');
  for (const r of results) {
    const x = (n, d) => (d && n ? `${Math.round((n / d) * 10) / 10}x` : 'n/a');
    console.log(
      `${r.shape.name.padEnd(10)} ${String(r.dom.cells).padEnd(7)} ` +
        `${String(r.tableMs + 'ms').padEnd(8)} ${x(r.tableMs, control.tableMs).padEnd(5)} ` +
        `${String((r.cell?.median ?? 0) + 'ms').padEnd(8)} ${x(r.cell?.median, control.cell?.median).padEnd(10)} ` +
        `${String((r.across?.median ?? 0) + 'ms').padEnd(8)} ${x(r.across?.median, control.across?.median)}`
    );
  }
  console.log('');
}

await browser.close();
server.kill('SIGKILL');
