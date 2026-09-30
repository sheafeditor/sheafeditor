/*
 * What an open table cell gets from the chrome around it: its own source on Edit Markdown, and a
 * toolbar offering the commands that mean something in a cell and refusing the ones that do not.
 *
 *   node scripts/check-cell-source.mjs
 *
 * Two questions in one check because both need a cell open in a real browser, and a second
 * browser and folder server for the toolbar half would cost fifteen seconds of every gate run to
 * measure the same page.
 *
 * A cell is a real editor with the live-preview decorations on it, so a cell holding
 * `**start**. hello world` draws a bold word. Until now there was no way to find out what was
 * under it: `Mod-Alt-e` was not in the cell's keymap, and the table's own `</>` reveals the
 * whole table, which answers a different question and loses the one cell in a wall of pipes.
 *
 * **Three readings, and the two either side of the middle one are the control.** Asserting
 * only that the markers appear after the key would pass on a cell that always showed its raw
 * text, which is precisely the behaviour this replaced. Asserting only that they go away would
 * pass on one that never showed them. So the cell is read rendered, revealed, and rendered
 * again.
 *
 * **And the row below is read every time**, because "the cell's source" and "the table's
 * source" look identical when only one cell is examined. It holds a mark of its own and must
 * stay drawn throughout.
 *
 * It needs Chrome and playwright-core. When either is missing this says so and exits 0.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/*
 * Edit Markdown's chord, as this platform spells it.
 *
 * `Mod-` in the editor's own keymap is Cmd on a Mac and Ctrl everywhere else, and this
 * pressed `Meta+Alt+e` outright. On a Mac that is the binding and the check passed; on Linux
 * it is a chord nothing listens for, so the cell never revealed and the check reported the
 * product broken. It failed three release builds that way while every local run stayed green,
 * which is the whole cost of a check that only works where its author ran it.
 */
const REVEAL = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Alt+e`;

const VIEW = { width: 1200, height: 900 };

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

// Both cells in the second column carry a mark, so revealing one can be told from revealing all.
const doc = [
  '# Cell source',
  '',
  'Intro paragraph.',
  '',
  '| Item | Note |',
  '| --- | --- |',
  '| bolt | **start**. hello world |',
  '| washer | **other**. second row |',
  '',
].join('\n');

const root = mkdtempSync(join(tmpdir(), 'sheaf-cellsource-'));
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.lineNumbers': false }, null, 2));
writeFileSync(join(root, 'cell.md'), doc);

const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so no cell can be opened.' });

/*
 * Which top-toolbar controls may act on an open cell, by `data-command`.
 *
 * A cell holds one line of inline content, so the marks apply and the block commands do not: a
 * heading, a list, a quote, a fence or a divider has no meaning there, and running one wrote its
 * marker into the value, turning `needs review` into `> needs review`. The two dropdowns are
 * block-only throughout, Text style being six heading levels and Insert being a table, a CSV
 * table, a fence, a divider and an image, so each goes whole rather than item by item.
 */
const INLINE_LIVE = ['bold', 'italic', 'strike', 'highlight', 'code', 'link', 'clearFormatting'];
const BLOCK_DEAD = ['bullet', 'ordered', 'task', 'quote', 'codeBlock', 'heading', 'insert'];

/** Each named control's `disabled`, or null where no such control is on the toolbar. */
const availability = (page, commands) =>
  page.evaluate((commands) => {
    const out = {};
    for (const c of commands) {
      const el = document.querySelector(`.sheaf-toolbar [data-command="${c}"]`);
      out[c] = el ? el.disabled === true : null;
    }
    return out;
  }, commands);

const failures = [];
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: VIEW });
  await page.goto(`${base}/edit/cell.md`, { timeout: 30_000 });
  await page.waitForSelector('.sheaf-table-grid td[role="gridcell"]', { timeout: 30_000 });
  await page.waitForTimeout(1200);

  /* What the open cell draws, and what the cell below it draws. */
  const read = () =>
    page.evaluate(() => {
      const at = (r, c) => document.querySelector(`.sheaf-table-grid [data-r="${r}"][data-c="${c}"]`);
      const open = at(0, 1)?.querySelector('.sheaf-table-input .cm-content') ?? null;
      const below = at(1, 1);
      return {
        drawn: open ? open.textContent : null,
        /*
         * An open cell draws bold as a live-preview decoration, `.tok-strong`, and a closed
         * one as real `<strong>` from `renderInline`. Asking either of them for the other's
         * spelling reports no bold at all, which is how this check first failed against a
         * working fix.
         */
        bold: open ? open.querySelectorAll('.tok-strong').length : null,
        belowDrawn: below ? below.textContent : null,
        belowStrong: below ? below.querySelectorAll('strong').length : null,
      };
    });

  /*
   * The toolbar with no cell open, which is the control for the readings after one is. Without it
   * "the block controls are unavailable" would pass just as well on a toolbar that never enables
   * them, or on one whose controls are missing and read as null.
   */
  await page.click('.cm-content .cm-line:nth-of-type(2)');
  await page.waitForTimeout(400);
  const inProse = await availability(page, [...INLINE_LIVE, ...BLOCK_DEAD]);
  console.log(`  with the caret in prose:  ${Object.entries(inProse).map(([c, d]) => `${c}=${d === null ? 'absent' : d ? 'off' : 'on'}`).join(' ')}`);
  for (const c of BLOCK_DEAD) {
    if (inProse[c] !== false) {
      failures.push(
        `CONTROL: ${c} should be available with the caret in prose, and it read ${inProse[c] === null ? 'absent from the toolbar' : 'unavailable'}. ` +
          `Every reading below is worthless if this control is never available anywhere.`
      );
    }
  }

  await page.dblclick('.sheaf-table-grid [data-r="0"][data-c="1"]');
  const opened = await page
    .waitForSelector('.sheaf-table-input .cm-content', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    failures.push('double-clicking the cell opened no editor, so this check never reached the behaviour it is about');
  } else {
    await page.waitForTimeout(400);

    const inCell = await availability(page, [...INLINE_LIVE, ...BLOCK_DEAD]);
    console.log(`  with a cell open:         ${Object.entries(inCell).map(([c, d]) => `${c}=${d === null ? 'absent' : d ? 'off' : 'on'}`).join(' ')}`);
    for (const c of BLOCK_DEAD) {
      if (inCell[c] !== true) {
        failures.push(
          `${c} should be unavailable while a cell is open, and it read ${inCell[c] === null ? 'absent' : 'available'}. ` +
            `A block command run in a cell writes its marker into the value.`
        );
      }
    }
    for (const c of INLINE_LIVE) {
      if (inCell[c] !== false) {
        failures.push(
          `${c} should stay available while a cell is open, and it read ${inCell[c] === null ? 'absent' : 'unavailable'}. ` +
            `The marks do apply to a cell, and disabling them would be the opposite mistake.`
        );
      }
    }

    const rendered = await read();
    await page.keyboard.press(REVEAL);
    await page.waitForTimeout(400);
    const revealed = await read();
    await page.keyboard.press(REVEAL);
    await page.waitForTimeout(400);
    const again = await read();

    console.log(`  rendered: ${JSON.stringify(rendered.drawn)} (${rendered.bold} bold)`);
    console.log(`  revealed: ${JSON.stringify(revealed.drawn)} (${revealed.bold} bold)`);
    console.log(`  rendered again: ${JSON.stringify(again.drawn)} (${again.bold} bold)`);
    console.log(`  the row below, throughout: ${JSON.stringify(again.belowDrawn)} (${again.belowStrong} strong)`);

    const hidden = (m) => m.drawn != null && !m.drawn.includes('**') && m.bold === 1;
    const shown = (m) => m.drawn != null && m.drawn.includes('**start**');

    if (!hidden(rendered)) {
      failures.push(
        `an open cell should draw its Markdown rendered before anything is pressed, and it drew ${JSON.stringify(rendered.drawn)} with ${rendered.bold} bold span(s)`
      );
    }
    if (!shown(revealed)) {
      failures.push(
        `Mod-Alt-e in an open cell should show that cell's source, and the cell drew ${JSON.stringify(revealed.drawn)}, which does not contain \`**start**\``
      );
    }
    if (!hidden(again)) {
      failures.push(
        `CONTROL: Mod-Alt-e again should render the cell, and it drew ${JSON.stringify(again.drawn)} with ${again.bold} bold span(s). ` +
          `Without this a cell that showed its raw text at all times would satisfy the reading above.`
      );
    }
    for (const [when, m] of [
      ['before', rendered],
      ['while revealed', revealed],
      ['after', again],
    ]) {
      if (m.belowDrawn == null || m.belowDrawn.includes('**') || m.belowStrong !== 1) {
        failures.push(
          `CONTROL: the cell below should stay rendered ${when}, and it drew ${JSON.stringify(m.belowDrawn)} with ${m.belowStrong} strong. ` +
            `A reveal of the whole table rather than the one cell reads exactly like a pass when only the open cell is examined.`
        );
      }
    }
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} cell-source measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log(
  "\nEdit Markdown in a cell shows that cell's source, renders it again, and leaves the rest of the table drawn;\n" +
    'the toolbar keeps its marks available there and draws its block commands unavailable.'
);
