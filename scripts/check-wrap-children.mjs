/*
 * Every child of a table's frame lines up with the grid inside it, measured in a browser.
 *
 *   node scripts/check-wrap-children.mjs
 *
 * A table wide enough to use the pane escapes the writing column by negative margins on its frame,
 * so the frame's box reaches both pane edges. There is no other way: a block widget inside
 * `.cm-content`, which is centred by `margin: 0 auto`, cannot reach past that measure, and the two
 * alternatives are worse — absolute positioning hides the widget's height from CodeMirror, which
 * measures with `offsetHeight` and would then place clicks on the wrong line, and `100vw` ignores the
 * scrollbar. It is worth having: the scroll viewport becomes the pane rather than the column, 1440px
 * against 708px on the widest table in the corpus, so a wide table shows twice as much of itself.
 *
 * **What it costs is an obligation on every child of that frame, and this is the check for it.** Each
 * child's box starts at the pane's edge unless it takes the inset back as its own padding. Four
 * separate findings in one week were four children that did not, each found by somebody noticing the
 * thing looked wrong: the hover bar, the board, and the two labels. A fifth sat in the tree
 * throughout, and was in a session's own measurement four days before anybody read it as a defect.
 *
 * So the rule is stated once, here, and a new child of the frame fails rather than waiting to be
 * noticed.
 *
 * ## Against the grid, not against the prose
 *
 * The grid is what the children belong to, and where it sits depends on the table: at rest its
 * content lines up with the paragraph above, and once the table has taken the pane it moves to the
 * pane's own edge, because there the first column is where you begin reading and an inset would be
 * dead space. A rule written against the prose would be wrong in the second case, which is exactly
 * the state in which the caption defect read as correct for a week.
 *
 * The grid's own position is pinned separately, below. Without that, a grid laid out wrongly would
 * take every child with it and the whole check would agree with itself.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/** Wide enough that a twelve-column table takes the pane and a three-column one does not. */
const VIEW = { width: 1440, height: 900 };

/**
 * Children whose left edge is not theirs to get right, with the reason each one is here.
 *
 * A list with no reasons is a way of making a check pass. Each entry says what reconciles that child
 * instead, so an entry that stops being true is readable as one.
 */
const DELIBERATE = {
  'sheaf-table-controls':
    'absolutely positioned and reconciled by its right edge, from `--md-table-edge`: what matters about a bar is where it ends, and `::before { margin-left: auto }` means its left edge holds nothing',
};

/** Children that draw nothing a reader could line up against. */
const INVISIBLE = new Set([
  'sheaf-table-note', // position: absolute, clipped to 1px, read aloud and shown to nobody
  'sheaf-table-sizer', // visibility: hidden, the copy the column widths are measured on
]);

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

const root = mkdtempSync(join(tmpdir(), 'sheaf-wrapkids-'));

/* Two paragraphs above every table, so there is prose to line the grid up against and the frame is
   not against the top of the pane. */
const LEAD = 'A paragraph above the table.\n\nA second one, so there is prose to compare against.\n\n';

/* A named data block is the only construction that draws a caption, and the name is what a reader
   sees in the wrong place. Three columns, so the table fits its writing column. */
writeFileSync(
  join(root, 'named-narrow.md'),
  `${LEAD}\`\`\`csv id=tasks\nsku,description,warehouse\n${Array.from({ length: 6 }, (_, i) => `SKU-${2000 + i},ledger,Offshore`).join('\n')}\n\`\`\`\n`
);

/* The same, twelve columns with long headings, so the table takes the pane and the grid moves to 0.
   This is the state in which the caption read as correct, because there it agrees by accident. */
const wideCols = Array.from({ length: 12 }, (_, i) => `column_heading_number_${i + 1}`);
writeFileSync(
  join(root, 'named-wide.md'),
  `${LEAD}\`\`\`csv id=stock\n${wideCols.join(',')}\n${Array.from({ length: 6 }, (_, r) => wideCols.map((_, i) => `row ${r + 1} value in column ${i + 1}`).join(',')).join('\n')}\n\`\`\`\n`
);

/* A small pipe table, driven to a board below. Narrow on purpose: a board is drawn at its own width
   rather than the pane's, so the defect this check was written after was a narrow one. */
writeFileSync(
  join(root, 'board.md'),
  `${LEAD}| Task | Status |\n| --- | --- |\n| Draft the page | Open |\n| Review it | Done |\n| Ship it | Open |\n`
);

const measure = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelector('.sheaf-table');
    if (!wrap) return { error: 'no .sheaf-table in the page' };
    const lead = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('A paragraph above'));
    const box = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const pad = parseFloat(s.paddingLeft) || 0;
      return {
        cls: (el.className || el.tagName.toLowerCase()).split(/\s+/)[0],
        frame: Math.round(r.left),
        pad: Math.round(pad),
        content: Math.round(r.left + pad),
        drawn: s.display !== 'none' && s.visibility !== 'hidden' && Math.round(r.width) > 2,
      };
    };
    return {
      prose: lead ? Math.round(lead.getBoundingClientRect().left) : null,
      usesPane: wrap.classList.contains('can-use-pane'),
      paneWide: wrap.classList.contains('is-pane-wide'),
      wrap: box(wrap),
      kids: [...wrap.children].map(box),
    };
  });

/**
 * Turn the one table on the page into a board, the way a person does, and say what stopped it.
 *
 * **By right-clicking a cell, not through the bar's own menu.** Showing a board asks which column to
 * group by, so the command needs a cell to start from, and the bar menu has no row context: it draws
 * the item in place and disabled. Clicked anyway it is a no-op that looks exactly like a command that
 * ran, so this asserts the item is enabled before clicking it rather than trusting the click.
 */
async function showAsBoard(page) {
  /*
   * A cell's own menu rather than the bar's, and a left click first so the right click lands on a
   * selected cell.
   *
   * Three classes, because three different menus are involved and each draws its items with its own:
   * a cell's context menu is `.sheaf-ctx-item`, the formatting bar's dropdowns are
   * `.sheaf-tb-menu-item`, and the table's own menu — which is the one that asks which column to
   * group a board by — is `.sheaf-table-menu-item`. All three are named here because picking the
   * class that looked right cost two runs: the first found no item at all, and the second clicked a
   * closed menu's leftover.
   */
  const ITEM = '.sheaf-ctx-item, .sheaf-tb-menu-item, .sheaf-table-menu-item';
  const cell = await page.$('.sheaf-table-grid td[data-r="0"][data-c="0"]');
  if (!cell) return 'no first cell to right-click';
  await cell.click();
  await page.waitForTimeout(250);
  await cell.click({ button: 'right' });
  await page.waitForTimeout(400);
  const candidates = await page.$$(`${ITEM}:has-text("Show as board")`);
  let item = null;
  for (const c of candidates) if (await c.isVisible()) item = c;
  if (!item) return 'the cell menu offers no visible "Show as board"';
  if ((await item.getAttribute('aria-disabled')) === 'true') {
    return '"Show as board" is drawn disabled, so clicking it would be a no-op that reads as a pass';
  }
  await item.click();
  await page.waitForTimeout(450);
  /* The grouping menu that follows: any column will do, so take the first offered. Filtered on
     visibility as well as on `aria-disabled`, because a menu that has been closed is still in the
     document: the Insert dropdown's five items are there from the moment the page loads, hidden, and
     taking the first match without asking waits thirty seconds to click one of them. */
  await page.waitForTimeout(450);
  const groups = await page.$$(ITEM);
  const offered = [];
  for (const g of groups) {
    if ((await g.getAttribute('aria-disabled')) === 'true') continue;
    if (!(await g.isVisible())) continue;
    offered.push(g);
  }
  if (!offered.length) return 'the grouping menu offered no visible, enabled column';
  await offered[0].click();
  await page.waitForTimeout(800);
  return null;
}

const CASES = [
  { file: 'named-narrow.md', paneWide: false, mustDraw: ['sheaf-table-caption'] },
  { file: 'named-wide.md', paneWide: true, mustDraw: ['sheaf-table-caption'] },
  { file: 'board.md', paneWide: false, mustDraw: ['sheaf-table-board'], board: true },
];

const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'Without it no table is drawn at all, and that would read as every child agreeing.',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];
let measured = 0;

try {
  const page = await browser.newPage({ viewport: VIEW });
  for (const spec of CASES) {
    await page.goto(`${base}/edit/${spec.file}`);
    await page.waitForSelector('.sheaf-table-grid', { timeout: 15_000 });
    await page.waitForTimeout(2200);
    if (spec.board) {
      const stopped = await showAsBoard(page);
      if (stopped) {
        failures.push(`${spec.file}: the table was never shown as a board, so the board was never measured — ${stopped}`);
        continue;
      }
      await page.waitForTimeout(400);
    }

    const r = await measure(page);
    if (r.error) {
      failures.push(`${spec.file}: ${r.error}`);
      continue;
    }

    /* Preconditions. Each of these makes the readings below mean nothing rather than mean "fine", so
       they are failures rather than skips. */
    if (!r.usesPane) {
      failures.push(`${spec.file}: the frame has no \`can-use-pane\`, so there is no negative margin and nothing to reconcile`);
      continue;
    }
    if (r.paneWide !== spec.paneWide) {
      failures.push(
        `${spec.file}: written for is-pane-wide ${spec.paneWide} and the frame is ${r.paneWide}, so this is not the state the case is about`
      );
      continue;
    }
    if (r.prose === null) {
      failures.push(`${spec.file}: the lead paragraph was not found, so the grid's own position cannot be pinned`);
      continue;
    }
    for (const cls of spec.mustDraw) {
      if (!r.kids.some((k) => k.cls === cls && k.drawn)) {
        failures.push(`${spec.file}: \`${cls}\` is not drawn, so this case measured nothing about the child it exists for`);
      }
    }

    /*
     * What the other children line up with.
     *
     * The grid, when there is one: it is the table's content, and where it sits is the table's own
     * answer — level with the paragraph above at rest, and at the frame's edge once it has taken the
     * pane, where an inset would be dead space in front of the first column.
     *
     * The prose, when the grid is hidden, which is what a board does to it. A board is drawn at its
     * own width rather than the pane's, so it has taken nothing and belongs under its heading. That
     * is the whole of the earlier board finding: a two-lane board 490px wide sat at the pane's left
     * edge with 950px of nothing to its right.
     *
     * The grid's own position is pinned before anything is compared against it. Without that a grid
     * laid out wrongly would take every child with it and the readings would agree with each other
     * while all of them were wrong.
     */
    const grid = r.kids.find((k) => k.cls === 'sheaf-table-grid');
    let anchor;
    let anchorName;
    if (grid?.drawn) {
      const want = spec.paneWide ? r.wrap.frame : r.prose;
      const where = spec.paneWide ? "the frame's left edge" : 'the prose';
      if (grid.content !== want) {
        failures.push(
          `${spec.file}: the grid's content starts at ${grid.content} and ${where} is at ${want}, ${grid.content - want} out. ` +
            'Everything else here is measured against the grid, so this is checked first.'
        );
        continue;
      }
      anchor = grid.content;
      anchorName = 'the grid';
    } else {
      anchor = r.prose;
      anchorName = 'the prose';
    }

    console.log(
      `\n${spec.file}: can-use-pane, is-pane-wide ${r.paneWide}; prose ${r.prose}, frame ${r.wrap.frame}, lining up against ${anchorName} at ${anchor}`
    );
    for (const k of r.kids) {
      if (INVISIBLE.has(k.cls)) {
        console.log(`  ${k.cls.padEnd(24)} nothing drawn to line up`);
        continue;
      }
      if (!k.drawn) continue;
      const allow = DELIBERATE[k.cls];
      const off = k.content - anchor;
      if (allow) {
        console.log(
          `  ${k.cls.padEnd(24)} content ${String(k.content).padStart(5)}, ${off === 0 ? 'level with' : `${off} from`} ${anchorName}, allowed: ${allow}`
        );
        continue;
      }
      measured++;
      if (off !== 0) {
        failures.push(
          `${spec.file}: \`${k.cls}\` content starts at ${k.content}, ${anchorName} at ${anchor}, ${off} out.\n` +
            `    frame ${k.frame}, padding-left ${k.pad}${grid?.drawn ? `; the grid's padding-left is ${grid.pad}` : ''}.\n` +
            "    A child of `.can-use-pane` starts at the pane's edge unless it takes the inset back as its own\n" +
            "    padding. Give it the grid's pair of rules in `media/webview.css`, or add it to this check's\n" +
            '    deliberate list with the reason it is reconciled some other way.'
        );
      } else {
        console.log(`  ${k.cls.padEnd(24)} content ${String(k.content).padStart(5)}, level with ${anchorName}`);
      }
    }
  }
} finally {
  await browser.close();
  if (typeof server.close === 'function') server.close();
  else server.kill?.();
}

/*
 * The empty case. Every child could be hidden, or every one of them could be on the list above, and
 * the loop would then print nothing and exit 0, which reads exactly like a pass.
 */
if (measured === 0) {
  console.error(
    '\ncheck-wrap-children: no child of a table frame was actually compared, so nothing was checked.\n' +
      '  Either the fixtures drew no children, or every child is on the deliberate list. Both are faults.'
  );
  process.exit(1);
}

if (failures.length) {
  console.error(`\n${failures.length} child/children of a table frame do not line up with the grid inside it:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(
  `\n${measured} drawn children compared across ${CASES.length} tables, every one level with the grid inside its frame, or with the prose where a board has replaced the grid.`
);
console.log(`Reconciled some other way, with a reason each: ${Object.keys(DELIBERATE).join(', ')}.`);
