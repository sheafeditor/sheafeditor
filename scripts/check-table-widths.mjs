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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
/*
 * The same content as a table of prose and as a data block, which are laid out by different
 * rules on purpose and are the pair that pins the difference.
 *
 * A pipe table may wrap its cells to stay in the writing column, because a column of sentences
 * wrapping is what a table of prose looks like. A `tsv` block may not: the value of a row is
 * reading across it, and six columns of short values squeezed into the writing column wrap every
 * row to two lines for the sake of a margin they never had. That happened, to a 300-row block in
 * the corpus, and doubled its height.
 *
 * Six columns matching `sample/stress/data-blocks.md`, so this is the shape that regressed.
 */
const DATA_COLS = ['sku', 'description', 'warehouse', 'on_hand', 'reserved', 'reorder_at'];
const DATA_ROWS = Array.from({ length: 40 }, (_, i) => `SKU-${2000 + i}\tephemeral ledger\tOffshore\t${4000 + i}\t214\t25`);
writeFileSync(
  join(root, 'datablock.md'),
  `Intro paragraph.\n\n\`\`\`tsv\n${DATA_COLS.join('\t')}\n${DATA_ROWS.join('\n')}\n\`\`\`\n`
);
/* Twelve columns, which cannot fit the writing column at their floors, so this is a table that is
   laid out to the pane and re-laid whenever the pane moves. Used for the both-directions check. */
const MANY = Array.from({ length: 12 }, (_, i) => `Heading ${i + 1}`);
writeFileSync(
  join(root, 'manycols.md'),
  `Intro paragraph.\n\n| ${MANY.join(' | ')} |\n| ${MANY.map(() => '---').join(' | ')} |\n` +
    `| ${MANY.map((_, i) => `A value in column ${i + 1}`).join(' | ')} |\n| ${MANY.map((_, i) => `Another value ${i + 1}`).join(' | ')} |\n`
);
/*
 * A board wide enough to scroll, for the block handle's placement beside one.
 *
 * Eight groups, so the board is far wider than the writing column and really has somewhere to
 * scroll to: the fault only shows once its cards have slid into the grip's margin. A view over a
 * named block rather than a pipe table shown as a board, because a view is a fenced block and its
 * range is `code`, which is the half of the fault that the selectors alone do not reach.
 */
const BOARD_GROUPS = ['Open', 'Doing', 'Blocked', 'Review', 'Done', 'Parked', 'Dropped', 'Waiting'];
writeFileSync(
  join(root, 'board-wide.md'),
  'Intro paragraph.\n\n```csv id=intake\nrequest,status,team,estimate\n' +
    BOARD_GROUPS.flatMap((s, i) => [`R${i}a,${s},Team ${i},${10 + i}`, `R${i}b,${s},Team ${i},${20 + i}`]).join('\n') +
    '\n```\n\n```view\nfrom: #intake\nlayout: board\ngroup: status\n```\n\nAfter line\n'
);
/* And a pipe table whose cells are sentences, which must go the other way. */
writeFileSync(
  join(root, 'prosetable.md'),
  'Intro paragraph.\n\n| Claim | Evidence | Consequence |\n| --- | --- | --- |\n' +
    '| The editor holds the writing column for prose | Every paragraph ends at the same right edge, which is what makes a page read as a page | A table that ignores it is the one element that breaks the measure |\n'
);
/* A quoted table with the same three columns as `DOC`, so the same grip selector reaches it and
   a drag on it can be compared against the unquoted case. A quoted table cannot use the pane,
   which is the whole point of it here. Its own file rather than widening `quoted.md`, whose
   column count another check's geometry is read against. */
writeFileSync(
  join(root, 'quoted-drag.md'),
  `Intro.\n\n${DOC.split('\n\n')[1].split('\n').map((l) => `> ${l}`).join('\n')}\n`
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
  /*
   * Every document here opens as one nobody has arranged, which is what this file's checks mean
   * by "a table nobody has dragged".
   *
   * The browser host keeps a document's column widths in `localStorage`, as the extension host
   * keeps them in VS Code's own store, so without this the width one check drags is still set
   * when a later check opens the same document and four measurements disagree: a table reads
   * 235px short of its content box, and the control for automatic layout finds identical widths
   * at two pane sizes because the widths are pinned rather than computed. All four were correct
   * readings of a document somebody had arranged.
   *
   * An init script rather than a `localStorage.clear()` after navigating, because the editor
   * reads the kept widths while the page boots and anything after `goto` is already too late.
   */
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // A browser that keeps nothing is already the state this wants.
    }
  });
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
  /*
   * A wide table begins at its frame's left edge, which **replaces** the assertion that it begins
   * where the prose does.
   *
   * That one was right for as long as a table that took the pane rested an inset in from its frame,
   * and the inset was the dead space: frame `0..1200` with the first cell at `246`, so 246px of empty
   * scroller padding before a table too wide to fit, and the table running off the right. Retired
   * rather than loosened, because the behaviour it described is the behaviour that was changed.
   *
   * A table that *fits* still lines up with the prose and is still centred, and `narrow.md` below is
   * where that is measured. The two together are what say this is about wide tables only.
   */
  if (!near(wide.firstCell?.left, wide.frame?.left)) {
    failures.push(
      `a wide table's first column starts at ${wide.firstCell?.left} and its frame at ${wide.frame?.left}. ` +
        `A table too wide to fit fills the pane from its frame's edge: the inset before it was dead space, ` +
        `and the gap that marks the end is the one after the last column.`
    );
  }
  /*
   * **And the prose does not start there, which is the reading that makes the one above discriminate.**
   *
   * Two numbers agreeing is not enough on its own: a build where the frame and the first column were
   * both wrong together would pass, and so would one that happened to centre the table. The third
   * number is the paragraph above the table, which stays in the writing column, so the assertion is
   * that the table agrees with the pane *and* parts company with the prose. That is a state the old
   * build cannot produce, because there the two agreed with each other and not with the pane.
   *
   * It is also the sentence `render.table-widths` R12 is written around, and the thing somebody
   * restoring the old inset would break first.
   */
  if (near(wide.firstCell?.left, wide.para?.left)) {
    failures.push(
      `a wide table's first column and the paragraph above it both start at ${wide.para?.left}, so the table is ` +
        `still held to the writing column.\n` +
        `    Agreeing with the frame is only half of it: this is the reading that tells the landed build from one ` +
        `where the frame and the first column are wrong together.`
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
    const gs = getComputedStyle(grid);
    const inset = parseFloat(gs.paddingLeft) || 0;
    return {
      atEnd: Math.round(grid.scrollLeft),
      gap: last ? Math.round(f.right - last.right) : null,
      lastVisible: !!last && last.right <= f.right + 1 && last.left >= f.left - 1,
      inset: Math.round(inset),
      // The room the allocator is handed, from the same two quantities it reads: the padding box,
      // less the gutter left after the last column, less the pixel `border-collapse: collapse`
      // puts outside the table's box.
      frame: grid.clientWidth,
      gutter: Math.round(parseFloat(gs.getPropertyValue('--md-gutter')) || 0),
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
  /*
   * Two checks, because two different things can go wrong here.
   *
   * The gutter has to resolve to a length. An unregistered custom property computes to its token
   * stream, so `columnLayout.ts`'s `parseFloat` of `--md-gutter` returned `NaN` and it fell back
   * to the writing column's inset, which in the pane-wide state is zero: the allocator was handed
   * the entire frame and left no gap after the last column. `webview.css` registers the property
   * with `@property` so it computes to pixels. Remove that block and this line fails, which is how
   * it was measured.
   *
   * Then the total, as a baseline rather than a formula. This table does not fit, so rule 4 in
   * `columnWidths.ts` sets its columns by interpolating from their minimums toward their content
   * widths as the room falls short, and there is no short expression for where that lands. The
   * number is here to be compared against by eye when this geometry next changes.
   *
   * It moved from 1404 to 1286 when the gutter became readable: the room fell by the 96px gutter
   * and the border pixel, and rule 4 handed the columns 118px less between them. 1404 held only
   * while the gutter read as zero.
   */
  const room = end ? end.frame - end.gutter - 1 : null;
  if (room !== null) console.log(`  the room it was handed: frame ${end.frame} less a ${end.gutter}px gutter less the border pixel = ${room}px`);
  if (!end || !(end.gutter > 0)) {
    failures.push(
      `the gutter after the last column measured ${end?.gutter}px.\n` +
        `    Zero means \`--md-gutter\` did not resolve to a length, so \`columnLayout.ts\` is using its inset fallback and the table is laid out in the whole frame.`
    );
  }
  if (wideCols.length !== 13) failures.push(`the wide table laid out ${wideCols.length} columns rather than 13, so its widths were not measured`);
  else if (Math.abs(wideTotal - 1286) > 24) {
    failures.push(
      `the wide table's columns total ${wideTotal}px against the 1286px this geometry was last measured at (frame ${end?.frame}, gutter ${end?.gutter}, room ${room}).\n` +
        `    Padding is outside \`clientWidth\`, so the frame does not move when padding does; a change this size means the allocator is seeing a different pane.`
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
  /*
   * **A table that takes the pane keeps its grip above it, at rest as well as scrolled**, and that is
   * the decided trade rather than a regression.
   *
   * `blocks.handle` R1 is written for it: in the margin beside the block's first line, and clear above
   * the block where the block leaves no margin to sit in. A table whose first column begins at the
   * frame's edge leaves none, so there is nowhere beside it that is not the document, and R4 — never
   * cover a character — is the harder of the two.
   *
   * This is deliberately a **separate** case from the board's lift, which is transient: a board drops
   * its grip back beside the column heads when it is scrolled home. A check that could not tell them
   * apart would pass when this permanent one regressed to the transient behaviour, which is exactly
   * the shape of a check that cannot fail.
   *
   * The reading that says it is lifted rather than lost: the grip is still drawn, and it is above the
   * header row rather than level with it.
   */
  if (!rested) failures.push('the grip went away when the table was scrolled back to rest, and a lifted grip is still a drawn grip');
  else if (rested.gripTop >= rested.headerTop - 2) {
    failures.push(
      `back at rest the grip is at ${rested.gripTop} with the header row at ${rested.headerTop}, so it is beside the ` +
        `header rather than above it.\n` +
        `    A table that takes the pane begins at its frame's edge, so the margin the grip used to rest in is ` +
        `document now. Level with the header means it is over a cell, which is what R4 forbids.`
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
    /*
     * The grip is found again rather than assumed to be where the last drag left it.
     *
     * It used to press at `gripAt.x + 120`, which was where the first drag had pushed it. That holds
     * only while the table's left edge never moves, and it does now: a table dragged past its writing
     * column takes the pane, and a pane-wide table begins at its frame's edge, so on release the whole
     * table shifts left by one inset and the grip with it. Pressing the remembered coordinate then
     * lands on a cell, nothing is dragged, and the check reported "the drag did not take the table past
     * the pane" — a true statement about a drag that never happened.
     *
     * Re-reading it is also what a person does: they look for the grip. The shift on release is the
     * accepted cost of removing the dead space, and holding it still *during* the gesture is what
     * `is-resizing` is for.
     */
    const grip2 = await page.evaluate((col) => {
      const g = document.querySelector(`.sheaf-table th:nth-child(${col + 1}) .sheaf-table-resize`);
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, 2);
    if (!grip2) failures.push('the resize grip could not be found for the second drag, so the overflow case asked nothing');
    const from = grip2 ?? { x: gripAt.x + 120, y: gripAt.y };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 780, from.y, { steps: 8 });
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

    /*
     * The table holds still under the pointer while a column is being dragged.
     *
     * This is the one thing nothing measured, and it is what three build-and-revert cycles on the
     * flush-left change came down to. A table dragged past its writing column takes the pane, and a
     * pane-wide table begins at its frame's edge, so applying that mid-gesture moved the content from
     * 246 to 0 — with the grip on it. The pointer was then on a cell, and the rest of the drag reached
     * nothing: measured as a further 400px of movement changing the width not at all.
     *
     * A gesture that stops answering is a different category from a thing that moves, because the
     * obvious next move is to drag again and that does nothing either. `:not(.is-resizing)` holds the
     * old padding across the gesture so the new edge is found on release.
     *
     * Read while the button is still down, which is the only moment the fault exists. A reading taken
     * after the release sees the new edge and cannot tell the two builds apart.
     */
    /*
     * **A fresh document, because the fault only exists on the crossing.** Written without this the
     * check passed with the mitigation removed: by the time it ran the table was already pane-wide and
     * already at the frame's edge, so a further drag crossed no threshold and moved nothing. The
     * reading was `sat at 0 and was at 0` either way, which is a check that cannot fail.
     *
     * So it starts from a table that fits its writing column, at an inset, not pane-wide, and drags it
     * across. The assertion below is then about the one moment the table changes which room it is in.
     */
    await openDoc('t.md');
    const wasFitting = await page.evaluate(() => {
      const w = document.querySelector('.sheaf-table');
      const t = document.querySelector('.sheaf-table table');
      return w && t ? { paneWide: w.classList.contains('is-pane-wide'), left: Math.round(t.getBoundingClientRect().left) } : null;
    });
    if (wasFitting?.paneWide !== false) {
      failures.push(
        `the drag-stillness case needs a table that is not yet pane-wide and got ${j(wasFitting)}, so it would ` +
          `cross no threshold and could not fail.`
      );
    }
    const before = wasFitting?.left ?? null;
    const grip3 = await page.evaluate((col) => {
      const g = document.querySelector(`.sheaf-table th:nth-child(${col + 1}) .sheaf-table-resize`);
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, 2);
    if (grip3 && before !== null) {
      await page.mouse.move(grip3.x, grip3.y);
      await page.mouse.down();
      await page.mouse.move(grip3.x + 160, grip3.y, { steps: 6 });
      const whilePressed = await page.evaluate(() => {
        const t = document.querySelector('.sheaf-table table');
        return t ? Math.round(t.getBoundingClientRect().left) : null;
      });
      await page.mouse.up();
      await page.waitForTimeout(500);
      console.log(`  the table sat at ${before} and was at ${whilePressed} while a column was being dragged`);
      if (whilePressed !== null && Math.abs(whilePressed - before) > 2) {
        failures.push(
          `the table moved from ${before} to ${whilePressed} while a column was being dragged, so the grip ` +
            `went out from under the pointer and the rest of the gesture reaches nothing.\n` +
            `    A pane-wide table starts at its frame's edge; applying that mid-drag is what moves it, and ` +
            `\`is-resizing\` is meant to hold the old padding until the drag ends.`
        );
      }
    }
  }

  /*
   * Scrolled fully right, there is a gap after the last column, for a table that can use the
   * pane and for one that cannot.
   *
   * Both, because the two get it from different rules and only one of them was ever checked.
   * A table reaching the pane takes its right padding from the inset; a quoted or list-indented
   * table has no inset, so it took none, and a column dragged past its frame left the last
   * column flush against the edge. The frame did scroll, correctly, and nothing said the table
   * had ended: the only signal was that it stopped moving, which is what the gap exists to
   * replace.
   *
   * The unquoted reading is the control. A change that gave every frame the same padding
   * unconditionally would satisfy the quoted line and take a fitting table's last column out of
   * view, because padding comes out of the content box while the layout divides `clientWidth`.
   */
  const endGap = async (name, gripCol) => {
    await page.goto(`${base}/edit/${name}`);
    await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
    await page.waitForTimeout(2000);
    const sel = `.sheaf-table-grid thead th[data-c="${gripCol}"] > .sheaf-table-resize`;
    const at = await page.locator(sel).first().boundingBox();
    if (!at) return { name, error: 'no resize grip' };
    /*
     * At rest, where the table's right edge sits against the frame's.
     *
     * Not `scrollWidth - clientWidth`, which was the first version of this and could not fail:
     * a table that fits is `overflow-x: visible`, so it is not a scroll container and its
     * scrollWidth is its clientWidth whatever the table is doing inside it.
     *
     * Nor the distance to the frame's own right edge, which was the second version and failed
     * the table that can use the pane. That one legitimately ends an inset short of its frame,
     * because the inset is padding on both sides and the table is laid out to the writing column
     * inside it. Measured at 245px short, correctly.
     *
     * What holds for both is that the right padding never takes room away from the columns. So
     * the reading is the table's right edge against the *content box's*, and the table may sit
     * at it or past it, never short of it. A pane table sits on it; a quoted table overruns it,
     * because the layout divides `clientWidth` and the padding is simply overrun while nothing
     * is clipping.
     */
    const rest = await page.evaluate(() => {
      const wrap = document.querySelector('.sheaf-table');
      const grid = document.querySelector('.sheaf-table-grid');
      const table = grid?.querySelector('table');
      const padRight = parseFloat(getComputedStyle(grid).paddingRight) || 0;
      const contentRight = grid.getBoundingClientRect().right - padRight;
      return {
        scrollX: !!wrap?.classList.contains('is-scroll-x'),
        pad: getComputedStyle(grid).paddingRight,
        pastContentBox: Math.round(table.getBoundingClientRect().right - contentRight),
      };
    });
    /*
     * Dragged three times rather than once, reading the end gap after each.
     *
     * The reported requirement was that resizing "always keeps the right padding (or you can't move it more
     * right)", and both halves of that are claims about repetition: a margin that survives one
     * drag can still be eaten by the third, once the total has grown past whatever the frame was
     * sized for. A single drag cannot tell the two apart. The grip is re-measured each round
     * because it has moved with the column it belongs to.
     */
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const grip = await page.locator(sel).first().boundingBox();
      if (!grip) return { name, error: `the resize grip was gone after ${i} drag(s)` };
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + 300, grip.y + grip.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(600);
      rounds.push(
        await page.evaluate(() => {
          const grid = document.querySelector('.sheaf-table-grid');
          const table = grid?.querySelector('table');
          grid.scrollLeft = grid.scrollWidth;
          const cols = [...table.querySelectorAll('colgroup col')].map((c) => Math.round(parseFloat(c.style.width) || 0));
          return {
            cols,
            total: cols.reduce((a, b) => a + b, 0),
            gap: Math.round(grid.getBoundingClientRect().right - table.getBoundingClientRect().right),
          };
        })
      );
    }
    return {
      name,
      rest,
      rounds,
      ...(await page.evaluate(() => {
        const wrap = document.querySelector('.sheaf-table');
        const grid = document.querySelector('.sheaf-table-grid');
        const table = grid?.querySelector('table');
        grid.scrollLeft = grid.scrollWidth;
        return {
          canUsePane: !!wrap?.classList.contains('can-use-pane'),
          scrollX: !!wrap?.classList.contains('is-scroll-x'),
          padRight: Math.round(parseFloat(getComputedStyle(grid).paddingRight) || 0),
          gap: Math.round(grid.getBoundingClientRect().right - table.getBoundingClientRect().right),
        };
      })),
    };
  };

  /*
   * A table of prose holds the writing column and wraps; a data block takes the room its columns
   * want and draws one line a row.
   *
   * Both, because either alone passes on a version that treats every grid the same. Asking the
   * tightest width for everything keeps the prose table in the column and squeezes the data block
   * in beside it; asking the natural width for everything lets the data block have its room and
   * throws the prose table out to the pane, which is the bug that started this. Only the pair
   * fails both ways.
   */
  for (const [name, expect] of [['prosetable.md', 'column'], ['datablock.md', 'room']]) {
    await page.goto(`${base}/edit/${name}`);
    await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-line')];
      const para = lines.find((l) => (l.textContent ?? '').startsWith('Intro paragraph')) ?? lines[0];
      const wrap = document.querySelector('.sheaf-table');
      const grid = document.querySelector('.sheaf-table-grid');
      const table = grid?.querySelector('table');
      const first = table?.querySelector('tbody tr');
      if (!para || !wrap || !table) return null;
      return {
        isCsv: wrap.classList.contains('is-csv'),
        textRight: Math.round(para.getBoundingClientRect().right),
        // The writing column's own width, which is what a table's width is judged against.
        textWidth: Math.round(para.getBoundingClientRect().width),
        tableRight: Math.round(table.getBoundingClientRect().right),
        total: [...table.querySelectorAll('colgroup col')].reduce((a, c) => a + Math.round(parseFloat(c.style.width) || 0), 0),
        // One line a row is the whole point for data. 24px of line plus 13px of padding and rule.
        rowHeight: first ? Math.round(first.getBoundingClientRect().height) : null,
      };
    });
    if (!m) {
      failures.push(`${name}: no table drawn, so the layout rule was not measured`);
      continue;
    }
    /*
     * Measured as the table's **width** against the writing column's, not as where its right edge
     * lands.
     *
     * It was `tableRight <= textRight + 2`, a position test standing in for a width test, and it broke
     * the moment a wide table stopped starting at the writing column's left edge: the data block kept
     * its 953px and simply moved left, so its right edge came back inside the text's and the check
     * reported it squeezed. The table had not changed at all. A width compared against a width cannot
     * be fooled by the table moving.
     */
    const inColumn = (m.total ?? 0) <= (m.textWidth ?? m.textRight) + 2;
    console.log(
      `  ${name}: is-csv ${m.isCsv}, total ${m.total}, writing column ${m.textWidth}, table ends ${m.tableRight}, ` +
        `fits the writing column ${inColumn}, first row ${m.rowHeight}px`
    );
    if (expect === 'column' && !inColumn) {
      failures.push(`${name}: a table of prose ends at ${m.tableRight} against text ending at ${m.textRight}, so it left the writing column and the page has two right edges`);
    }
    if (expect === 'room') {
      if (inColumn) failures.push(`${name}: a data block was squeezed into the writing column, so its rows wrap for a margin they never had`);
      // A row of short values on one line is 37px here. Two lines is 61px, which is the regression.
      if ((m.rowHeight ?? 0) > 45) failures.push(`${name}: a data block's first row is ${m.rowHeight}px, which is more than one line of values`);
    }
  }

  for (const [name, gripCol] of [['t.md', 2], ['quoted-drag.md', 2]]) {
    const r = await endGap(name, gripCol);
    if (r.error) {
      failures.push(`${name}: ${r.error}, so the end gap was not measured`);
      continue;
    }
    console.log(
      `  ${name}: at rest is-scroll-x ${r.rest.scrollX} padRight ${r.rest.pad} table ends ${r.rest.pastContentBox}px past its content box; ` +
        `dragged 900px wider, can-use-pane ${r.canUsePane}, is-scroll-x ${r.scrollX}, padRight ${r.padRight}px, gap after the last column ${r.gap}px`
    );
    if (r.rounds) {
      console.log(`    across three drags: ${r.rounds.map((x) => `total ${x.total} gap ${x.gap}`).join(', ')}`);
      const grew = r.rounds.every((x, i) => i === 0 || x.total > r.rounds[i - 1].total);
      const kept = r.rounds.every((x) => x.gap >= 8);
      if (!grew) {
        // The other half the requirement allows: the drag may simply stop. Then the total holds
        // still, which is a pass, and the gap still has to be there.
        const held = r.rounds.every((x, i) => i === 0 || x.total === r.rounds[i - 1].total);
        if (!held) failures.push(`${name}: three drags moved the total ${JSON.stringify(r.rounds.map((x) => x.total))}, neither growing each time nor stopping`);
      }
      if (!kept) failures.push(`${name}: the gap after the last column went ${JSON.stringify(r.rounds.map((x) => x.gap))} across three drags, so a repeated resize eats the right margin`);
      /*
       * And every other column held still, which is the independence claim measured on a table
       * that scrolls. It had only ever been measured on one that does not, and a scrolling table
       * is the only place independence meets the margin: widening a column moves the total, which
       * moves where the end is, which is where the margin lives. The grip is on column 2, and
       * `cols[0]` is the row-number gutter, so the column the grip belongs to is `gripCol + 1`.
       * Written as `gripCol` first, which reported the dragged column itself as having moved: the
       * 300px it gained each round, correctly, read as a neighbour being disturbed.
       *
       * **This one has not been seen to fail and is a claim rather than a check.** Breaking the
       * freeze, so only the dragged column is pinned and the rest share the room as they did
       * before independent widths, fails the single-drag check on `narrow.md` with
       * "moved 2 other column(s) by [-50,-70]" and leaves this block passing: by the time a table
       * is at the pane and overflowing, growth is not bounded by the room, so the neighbours have
       * nothing to give up. So independence has a working control on a table that fits, and on one
       * that scrolls it has an assertion that would catch a regression nobody has yet produced.
       */
      const moved = [];
      for (let i = 1; i < r.rounds.length; i++) {
        const before = r.rounds[i - 1].cols;
        const after = r.rounds[i].cols;
        for (let c = 0; c < after.length; c++) {
          if (c === gripCol + 1 && after.length === before.length) continue;
          if (Math.abs((after[c] ?? 0) - (before[c] ?? 0)) > 1) moved.push(`round ${i + 1} column ${c}: ${before[c]} -> ${after[c]}`);
        }
      }
      if (moved.length) {
        failures.push(
          `${name}: dragging column ${gripCol} moved other columns on a scrolling table: ${JSON.stringify(moved)}.\n` +
            `    Widths are meant to be independent, so the dragged column takes the room and its neighbours keep what they had.`
        );
      }
    }
    if (!r.scrollX) failures.push(`${name}: a column dragged 900px wider did not make the frame scroll, so the gap after the last column proves nothing`);
    else if (r.gap < 8) failures.push(`${name}: scrolled fully right leaves ${r.gap}px after the last column, so nothing says the table has ended`);
    if (r.rest.scrollX) failures.push(`${name}: the table was already scrolling before the drag, so this measured the wrong thing`);
    // Short of the content box means the right padding was taken out of the room the columns
    // divide, which is how a fix for a table that does not fit would break one that does.
    if (r.rest.pastContentBox < -2) failures.push(`${name}: at rest the table ends ${-r.rest.pastContentBox}px short of its content box, so the right padding is being taken out of the columns' room`);
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
  /*
   * The same question of a board, which the reading above cannot answer.
   *
   * The table case is asked of `th` and `td`, and a board has neither: it is a flex row of
   * `.sheaf-board-col` divs holding `.sheaf-board-card`s. So every part of the table's fix read
   * undefined for a board, the lift never engaged, and the grip drew on top of the first card.
   * Measured before the fix: the grip's rectangle at 199..240 over a card at 220..448.
   *
   * A view's board rather than a pipe table's, because a view is a fenced block and so its range
   * is `code` rather than `table`, which put it outside the guard as well as outside the
   * selectors. Fixing the selectors alone would have left this one exactly as it was.
   *
   * At rest and scrolled, because the two are different states and only the second was ever
   * wrong: at rest the content starts at the text's left edge and the grip has the margin to
   * itself, which is the reading that says this is a scrolling fault and not a placement one.
   */
  const boardHandle = async (scrollFully) => {
    await page.goto(`${base}/edit/board-wide.md`);
    await page.waitForSelector('.sheaf-board', { timeout: 15_000 });
    await page.waitForTimeout(2200);
    /* The board is below the first screen, so bring it onto it before reading any rectangle. */
    await page.evaluate(() => document.querySelector('.sheaf-board')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    if (scrollFully) {
      await page.evaluate(() => {
        const host = document.querySelector('.sheaf-view-grid');
        if (host) host.scrollLeft = host.scrollWidth;
      });
      await page.waitForTimeout(300);
    }
    /*
     * Moved to a point inside the frame rather than hovered by selector: `hover()` scrolls the
     * element into view and undoes the scroll this is about. That cost two readings before it was
     * noticed, both of them showing no overlap because the board had been scrolled back to 0.
     */
    const at = await page.evaluate(() => {
      const g = document.querySelector('.sheaf-view-grid')?.getBoundingClientRect();
      return g ? { x: Math.round(g.left + 300), y: Math.round(g.top + Math.min(g.height / 2, 120)) } : null;
    });
    if (!at) return { error: 'no board frame on screen' };
    await page.mouse.move(at.x - 220, at.y);
    await page.waitForTimeout(120);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const handle = document.querySelector('.sheaf-block-handle:not([hidden])');
      const host = document.querySelector('.sheaf-view-grid');
      if (!handle) return { handle: null, scrollLeft: Math.round(host?.scrollLeft ?? 0) };
      const r = handle.getBoundingClientRect();
      const over = [...document.querySelectorAll('.sheaf-board-card, .sheaf-board-col-head')]
        .map((c) => ({ c, b: c.getBoundingClientRect() }))
        .filter(({ b }) => b.width > 0 && b.right > r.left + 1 && b.left < r.right - 1 && b.bottom > r.top + 1 && b.top < r.bottom - 1)
        .map(({ c, b }) => `${(c.textContent ?? '').trim().slice(0, 14) || '(empty)'} at ${Math.round(b.left)}`);
      const head = document.querySelector('.sheaf-board-col-head')?.getBoundingClientRect();
      return {
        handle: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) },
        over,
        headTop: head ? Math.round(head.top) : null,
        contentFrom: Math.round(document.querySelector('.sheaf-board-card')?.getBoundingClientRect().left ?? 0),
        scrollLeft: Math.round(host?.scrollLeft ?? 0),
      };
    });
  };

  /*
   * And the grip follows when the board scrolls under it with the pointer held still.
   *
   * `show` does nothing when called again for the range it already holds, which is what keeps a
   * mousemove from measuring on every pixel, and the cost is that a block scrolling under a grip
   * that is already up never moved it. A listener on the scroller is what makes the placement
   * follow, and it used to be attached to `.sheaf-table-grid` alone, so a board's scroller had
   * none. Scrolled here without touching the pointer, which is the only way to tell the listener
   * from the re-placement a mousemove would have done anyway.
   */
  {
    await page.goto(`${base}/edit/board-wide.md`);
    await page.waitForSelector('.sheaf-board', { timeout: 15_000 });
    await page.waitForTimeout(2200);
    await page.evaluate(() => document.querySelector('.sheaf-board')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    const at = await page.evaluate(() => {
      const g = document.querySelector('.sheaf-view-grid')?.getBoundingClientRect();
      return g ? { x: Math.round(g.left + 300), y: Math.round(g.top + Math.min(g.height / 2, 120)) } : null;
    });
    if (!at) failures.push('the board frame was not on screen, so the scroll listener was not measured');
    else {
      await page.mouse.move(at.x - 220, at.y);
      await page.waitForTimeout(120);
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(700);
      const before = await page.evaluate(() => {
        const h = document.querySelector('.sheaf-block-handle:not([hidden])');
        return h ? Math.round(h.getBoundingClientRect().top) : null;
      });
      // The pointer is not touched from here on.
      await page.evaluate(() => {
        const host = document.querySelector('.sheaf-view-grid');
        if (host) host.scrollLeft = host.scrollWidth;
      });
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => {
        const h = document.querySelector('.sheaf-block-handle:not([hidden])');
        const host = document.querySelector('.sheaf-view-grid');
        if (!h) return { top: null, scrollLeft: Math.round(host?.scrollLeft ?? 0), over: [] };
        const r = h.getBoundingClientRect();
        const over = [...document.querySelectorAll('.sheaf-board-card, .sheaf-board-col-head')]
          .map((c) => c.getBoundingClientRect())
          .filter((b) => b.width > 0 && b.right > r.left + 1 && b.left < r.right - 1 && b.bottom > r.top + 1 && b.top < r.bottom - 1);
        return { top: Math.round(r.top), scrollLeft: Math.round(host?.scrollLeft ?? 0), over: over.map((b) => Math.round(b.left)) };
      });
      console.log(`  the grip when a board scrolls under a still pointer: top ${before} -> ${after.top}, scrollLeft ${after.scrollLeft}, over ${after.over.length ? JSON.stringify(after.over) : 'nothing'}`);
      if (before === null) failures.push('no grip was up before the board was scrolled, so the scroll listener was not measured');
      else if (after.scrollLeft === 0) failures.push('the board did not scroll, so the scroll listener was not measured');
      else if (after.over.length) {
        failures.push(
          `a board scrolled under a still pointer left the grip over ${after.over.length} card(s) at ${JSON.stringify(after.over)}.\n` +
            `    Placement alone is not enough: the grip is only re-placed by a listener on the board's own scroller.`
        );
      } else if (after.top === before) {
        failures.push(
          `the grip stayed at top ${before} while the board scrolled to ${after.scrollLeft}, so nothing re-placed it.\n` +
            `    It happens to clear the cards at this scroll position, which is why this asserts the move and not only the overlap.`
        );
      }
    }
  }

  for (const [label, scrollFully] of [['at rest', false], ['scrolled fully right', true]]) {
    const b = await boardHandle(scrollFully);
    if (b.error) {
      failures.push(`the board handle ${label}: ${b.error}, so it was not measured`);
      continue;
    }
    console.log(
      `  the block handle beside a board, ${label}: ${JSON.stringify(b.handle)}, scrollLeft ${b.scrollLeft}, ` +
        `cards from ${b.contentFrom}, column heads at ${b.headTop}, drawn over ${b.over?.length ? JSON.stringify(b.over) : 'no card'}`
    );
    if (!b.handle) {
      failures.push(`no block handle appeared beside a board ${label}, so whether it covers a card was not measured at all`);
    } else if (b.over?.length) {
      failures.push(
        `the block handle is drawn over ${b.over.length} thing(s) on a board ${label}: ${JSON.stringify(b.over)}.\n` +
          `    Its rectangle is ${b.handle.left}..${b.handle.right} and the cards start at ${b.contentFrom}. A press still reaches the\n` +
          `    grip, which is why asking what a press hits reported this as working while it was visible on screen.`
      );
    }
    if (scrollFully && b.scrollLeft === 0) {
      failures.push(`the board did not scroll, so "scrolled fully right" measured the same state as at rest and proves nothing`);
    }
  }

  /*
   * The same pane width lays a table out the same way whichever direction it is reached from.
   *
   * The frame's inset is padding on both sides, so its content box is the writing column and holds
   * at exactly that for every pane wide enough for the inset to be at its ceiling: 708px at a pane
   * of 1400 and 708px at 3000. A `ResizeObserver` watches the content box by default, so the one
   * on the grid never fired on a widening and a table kept the widths it was given in a narrower
   * pane. Measured before the fix: a pane of 925 laid out at 1491 when reached from 1400 and at
   * 1516 when reached from 700, both stable, because the last layout had run at a frame of 1000
   * and never run again.
   *
   * **Both directions, because one direction cannot see it.** A sweep that only narrows reads a
   * monotone series and passes; the fault is entirely in what a widening fails to do. That also
   * explains the symptom as reported, a jump "by more than the pane moved": it is the accumulated
   * difference catching up on the first narrowing that does force a re-layout, not a step.
   *
   * Twelve columns, because a table that fits the writing column is laid out to the column at
   * every pane and cannot show this.
   */
  {
    const target = 925;
    const at = async (from) => {
      await page.setViewportSize({ width: from, height: 900 });
      await page.waitForTimeout(700);
      await page.setViewportSize({ width: target, height: 900 });
      await page.waitForTimeout(900);
      return page.evaluate(() => {
        const t = document.querySelector('.sheaf-table table');
        const cols = [...t.querySelectorAll('colgroup col')].map((c) => Math.round(parseFloat(c.style.width) || 0));
        return { total: cols.reduce((a, b) => a + b, 0), cols };
      });
    };
    await page.goto(`${base}/edit/manycols.md`);
    await page.waitForSelector('.sheaf-table table', { timeout: 15_000 });
    await page.waitForTimeout(2200);
    const fromWide = await at(1500);
    const fromNarrow = await at(700);
    console.log(
      `  a table of twelve columns at a pane of ${target}: reached from 1500 total ${fromWide.total}, from 700 total ${fromNarrow.total}`
    );
    if (!fromWide.total || !fromNarrow.total) {
      failures.push('the twelve-column table was not laid out, so the two approaches were not compared');
    } else if (Math.abs(fromWide.total - fromNarrow.total) > 2) {
      failures.push(
        `the same pane of ${target}px lays the table out at ${fromWide.total} coming from a wider pane and ` +
          `${fromNarrow.total} coming from a narrower one, so its widths depend on the pane's history.\n` +
          `    Widening leaves the frame's content box unchanged, so whatever watches it has to watch the border box.\n` +
          `    From 1500: ${JSON.stringify(fromWide.cols)}\n    From  700: ${JSON.stringify(fromNarrow.cols)}`
      );
    }
    await page.setViewportSize(VIEW);
  }

  /*
   * Does `is-scroll-x` agree with whether the frame actually scrolls, at every pane width?
   *
   * The class is not cosmetic. `media/webview.css` gives a fitting table `overflow-x: visible`
   * only while it is *not* marked, and that is what keeps its frame from being a scroll container,
   * which is what lets its header row stick to the editor rather than to the frame. So a table
   * wrongly marked loses its sticky header, and the table is the one case where the header is the
   * whole point of scrolling down.
   *
   * It is swept across widths rather than read at one because the disagreement is specific to a
   * narrow pane and invisible at the 1200 every other check here uses. The reason is a near
   * equality: a table that fits is laid out to the writing column, which is exactly the room the
   * allocator was handed, so whether it reports scrolling comes down to whether the rounded sum of
   * its columns lands a pixel over the number it was given. At a wide pane the column is far from
   * the frame's edge and the question never arises.
   *
   * The reading is `scrollWidth - clientWidth` on the frame, which is what scrolling means, taken
   * against the class rather than against the allocator's own arithmetic. Asking the code what it
   * decided would agree with itself whatever it decided.
   */
  {
    /*
     * Coarse widths and then a fine run around the narrow end, because the coarse list on its own
     * reports this fault at one width and that reading is wrong.
     *
     * Swept at 1200, 900, 760, 640 and 560 it showed only at 640, and the obvious conclusion is
     * that 640 is special. Swept at five-pixel steps it is live at 645, 640 and 620 and clear at
     * 650, 635, 630 and 600: particular widths rather than one, with a pixel of overflow at each.
     * The coarse list simply steps over two of them. A fix bounded to the width the coarse sweep
     * found would have shipped two live widths, which is the argument for fixing the threshold
     * rather than the case.
     *
     * Third time this has cost something here: a 100px sweep of table widths reported steady growth
     * where a 1px sweep found 154px between adjacent samples, and the same thing again on a timing
     * threshold. An interval is part of a measurement, and a sweep that finds one instance of a
     * rounding fault has almost certainly found the one it happened to sample.
     */
    const PANES = [1200, 900, 760, 650, 645, 640, 635, 630, 620, 600, 560];
    const frames = () =>
      page.evaluate(() => {
        const out = [];
        for (const wrap of document.querySelectorAll('.sheaf-table, .sheaf-view')) {
          const grid = wrap.querySelector('.sheaf-table-grid, .sheaf-view-grid');
          const table = wrap.querySelector('table');
          if (!grid) continue;
          const style = getComputedStyle(grid);
          out.push({
            name: (table?.querySelector('thead tr')?.textContent ?? '?').replace(/\s+/g, ' ').trim().slice(0, 28),
            marked: wrap.classList.contains('is-scroll-x'),
            pane: wrap.classList.contains('can-use-pane'),
            widths: wrap.classList.contains('has-widths'),
            table: table ? Math.round(table.getBoundingClientRect().width) : null,
            client: grid.clientWidth,
            over: grid.scrollWidth - grid.clientWidth,
            padL: Math.round(parseFloat(style.paddingLeft) || 0),
            padR: Math.round(parseFloat(style.paddingRight) || 0),
            overflowX: style.overflowX,
          });
        }
        return out;
      });

    for (const doc of ['tall.md', 'prosetable.md', 'manycols.md', 'datablock.md']) {
      for (const width of PANES) {
        await page.setViewportSize({ width, height: VIEW.height });
        await openDoc(doc);
        const read = await frames();
        for (const f of read) {
          /*
           * A pixel, not `EPS`. The question the class answers is whether a scrollbar is drawn,
           * and the browser does not draw one for half a pixel of overflow: a table laid out to
           * exactly its room routinely lands a fraction over it, because `border-collapse` puts
           * half a border outside the table's box and the column widths are whole numbers that
           * have to sum to a width that is not. The same distinction, on the same near equality,
           * was already needed for the height estimate.
           */
          const scrolls = f.over > 1;
          console.log(
            `  ${doc} at ${width}: ${f.name} table ${f.table} in ${f.client} (pad ${f.padL}/${f.padR}, ${f.overflowX}), ` +
              `overflow ${f.over}, is-scroll-x ${f.marked}, really scrolls ${scrolls}`
          );
          if (f.marked !== scrolls) {
            failures.push(
              `at a ${width}px pane, ${doc}'s "${f.name}" table is marked is-scroll-x ${f.marked} while its frame ` +
                `overflows by ${f.over}px, so it really scrolls ${scrolls}.\n` +
                `    The table is ${f.table}px inside a ${f.client}px frame.\n` +
                `    A table wrongly marked loses \`overflow-x: visible\`, becomes a scroll container on both axes, ` +
                `and its header row then sticks to its own frame instead of to the editor.`
            );
          }
        }
      }
    }

    /*
     * The same question against the corpus rather than against fixtures written for it.
     *
     * `sample/edge/markdown-torture.md` is where this was found, and it holds eight tables of
     * shapes nobody designed for a check: one column, two, three, an empty first header cell, every
     * alignment marker, and two of prose. Seven of the eight were wrongly marked at 640.
     *
     * It has to be stepped rather than read once. CodeMirror draws the viewport and a margin, not
     * the document, so a single reading at either end of a long file finds almost no tables at all
     * and reports a clean pass over work it never did. Each table is collected the first time it is
     * drawn, keyed by its header text.
     *
     * **The control, run rather than reasoned about.** With `Allocation.scrolls` comparing against
     * `EPS` instead of a pixel, this reports `8 tables drawn, 7 marked, 7 disagreements` at 640 and
     * `0 marked, 0 disagreements` at 1200, and the header reading below goes from 36 to 38 with the
     * frame's `overflow-x` from `visible` to `auto`. With the pixel it is 0 and 0 at both widths.
     * So the check discriminates, and on the corpus rather than on a fixture built to fail.
     */
    const torture = join(root, 'torture.md');
    writeFileSync(torture, readFileSync(join(REPO, 'sample', 'edge', 'markdown-torture.md'), 'utf8'));
    for (const width of [1200, 640]) {
      await page.setViewportSize({ width, height: VIEW.height });
      /*
       * Not `openDoc`, which waits for a grid to be visible. The torture document opens on prose
       * and its first table is below the fold, so that wait never resolves and the check dies on a
       * timeout rather than on anything about widths. The same fact that makes the stepping
       * necessary is what makes the wait wrong.
       */
      await page.goto(`${base}/edit/torture.md`);
      await page.waitForSelector('.cm-content', { timeout: 15_000 });
      await page.waitForTimeout(2000);
      const seen = new Map();
      for (let step = 0; step < 40; step++) {
        for (const f of await frames()) if (!seen.has(f.name)) seen.set(f.name, f);
        const more = await page.evaluate((h) => {
          const s = document.querySelector('.cm-scroller');
          if (!s) return false;
          const was = s.scrollTop;
          s.scrollTop = was + h * 0.8;
          return s.scrollTop > was;
        }, VIEW.height);
        await page.waitForTimeout(250);
        if (!more) break;
      }
      for (const f of await frames()) if (!seen.has(f.name)) seen.set(f.name, f);
      const wrong = [...seen.values()].filter((f) => f.marked !== f.over > 1);
      console.log(
        `  the torture sample at ${width}: ${seen.size} tables drawn, ${[...seen.values()].filter((f) => f.marked).length} marked, ${wrong.length} disagreements`
      );
      // Zero tables would be the stepping having failed, which reads exactly like a pass.
      if (seen.size < 6) {
        failures.push(
          `only ${seen.size} tables of the torture sample were ever drawn at a ${width}px pane, so this check ` +
            `compared almost nothing. CodeMirror keeps the viewport and a margin; the document has to be stepped.`
        );
      }
      for (const f of wrong) {
        failures.push(
          `at a ${width}px pane, the torture sample's "${f.name}" table is marked is-scroll-x ${f.marked} while ` +
            `its frame overflows by ${f.over}px. The table is ${f.table}px inside a ${f.client}px frame.`
        );
      }
    }

    /*
     * And the header itself, at the narrow pane, because the paragraph above is an argument about
     * what the class costs and this is the cost. A fitting table forty rows long, scrolled past:
     * the header row holds at the top of the editor or it does not.
     *
     * Read before and after the fix, and it held both times: 38 against a pane top of 37 while the
     * table was wrongly marked, 36 against 37 once it was not. So the wrong class is a real defect
     * in its own right and **not** the explanation for either sticky-header issue. That is worth
     * stating rather than leaving implied, because the wrong class looks like exactly the cause a
     * person would stop at.
     */
    await page.setViewportSize({ width: 640, height: VIEW.height });
    await openDoc('tall.md');
    await page.evaluate(() => document.querySelector('.cm-scroller')?.scrollTo({ top: 600 }));
    await page.waitForTimeout(500);
    const narrowHead = await page.evaluate(() => {
      const row = document.querySelector('.sheaf-table thead tr');
      const scroller = document.querySelector('.cm-scroller');
      const wrap = document.querySelector('.sheaf-table');
      const grid = document.querySelector('.sheaf-table-grid');
      if (!row || !scroller || !grid) return null;
      return {
        rowTop: Math.round(row.getBoundingClientRect().top),
        paneTop: Math.round(scroller.getBoundingClientRect().top),
        marked: wrap?.classList.contains('is-scroll-x') ?? null,
        overflowX: getComputedStyle(grid).overflowX,
      };
    });
    console.log(
      `  a fitting table at a 640px pane, scrolled past: header row at ${narrowHead?.rowTop}, pane top ` +
        `${narrowHead?.paneTop}, is-scroll-x ${narrowHead?.marked}, frame overflow-x ${narrowHead?.overflowX}`
    );
    if (narrowHead && Math.abs(narrowHead.rowTop - narrowHead.paneTop) > 2) {
      failures.push(
        `at a 640px pane, a fitting table's header row is at ${narrowHead.rowTop} with the pane top at ` +
          `${narrowHead.paneTop}, so it did not hold. Forty rows in, that table has no column names.`
      );
    }
    await page.setViewportSize(VIEW);
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
