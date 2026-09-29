/*
 * Whether a card dragged across a board is actually carried, and lands where the board said.
 *
 *   node scripts/check-board-drag.mjs
 *
 * The drag worked long before it looked like anything. The card stayed exactly where it was at
 * `opacity: 0.45`, the destination column took a highlight, and on release the board was redrawn
 * with the card in its new place. Between press and release there was no card under the pointer,
 * so the gesture read as a click that teleported something.
 *
 * Nothing about that fails in a way the document can see, which is why it needed a browser. The
 * file ended up right the whole time. What was wrong was on the screen for the half-second in
 * between, so every reading here is taken *during* the drag, with the pointer held down.
 *
 * ## What it asks
 *
 * That the card is under the pointer, by measuring how far its box moved against how far the
 * pointer did. That the place it came from holds a gap of its height rather than closing up, so
 * nothing reflows under the hand. That the gap is in the column the card would land in, which is
 * a more precise answer than colouring the column. That releasing writes one cell and Escape
 * writes nothing. And that a board wider than its pane scrolls when the card is carried to the
 * edge, since a column off the screen is otherwise unreachable.
 *
 * ## Why the pointer is moved in steps
 *
 * A single jump from the card to the far column would pass against an implementation that only
 * positions the card once, on release, which is most of the way back to the bug. The pointer is
 * moved in several steps and the card is read at more than one of them, so standing still is
 * distinguishable from following.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

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
 * Three columns, which is the smallest board where a card can be dropped somewhere that is
 * neither its home nor the only other option, and enough cards that a gap in a column is
 * visibly between two of them rather than simply appended.
 */
const TASKS =
  '```csv id=tasks\nfeature,status,estimate\nSearch,Open,5\nExport,Done,2\nImport,Open,8\nSync,Blocked,3\nDeploy,Blocked,1\n```';
const DOC = `# Work\n\n${TASKS}\n\n\`\`\`view\nfrom: #tasks\nlayout: board\ngroup: status\n\`\`\`\n`;

/* A board of many columns, so it is wider than the pane and has somewhere to scroll to. */
const WIDE_ROWS = Array.from({ length: 9 }, (_, i) => `Task ${i},S${i},${i}`).join('\n');
const WIDE = `# Wide\n\n\`\`\`csv id=tasks\nfeature,status,estimate\n${WIDE_ROWS}\n\`\`\`\n\n\`\`\`view\nfrom: #tasks\nlayout: board\ngroup: status\n\`\`\`\n`;

const root = mkdtempSync(join(tmpdir(), 'sheaf-board-'));
writeFileSync(join(root, 'b.md'), DOC);
writeFileSync(join(root, 'wide.md'), WIDE);
const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so the board drag was not measured' });
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

/** The middle of the card for `row`, and the head of the column for `value`. */
const places = (page) =>
  page.evaluate(() => {
    const mid = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, left: r.left, height: r.height, width: r.width };
    };
    const col = (v) => [...document.querySelectorAll('.sheaf-board-col')].find((c) => c.dataset.value === v) ?? null;
    return {
      card0: mid(document.querySelector('.sheaf-board-card[data-row="0"]')),
      blocked: mid(col('Blocked')?.querySelector('.sheaf-board-col-head')),
      done: mid(col('Done')?.querySelector('.sheaf-board-col-head')),
    };
  });

/** What the board looks like right now, read while the pointer is still down at (px, py). */
const during = (page, px, py) =>
  page.evaluate(
    ({ px, py }) => {
      const card = document.querySelector('.sheaf-board-card[data-row="0"]');
      const slot = document.querySelector('.sheaf-board-slot');
      const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}` : 'nothing');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const s = slot?.getBoundingClientRect();
      /*
       * What a hit test at the pointer answers, which is the question the board itself asks on
       * every move to find the column to drop into. Read here rather than inferred: a carried
       * card sits under the pointer, so whether it is hit-testable decides whether this says a
       * column or says the card.
       */
      const hit = document.elementFromPoint(px, py);
      return {
        lifted: card.classList.contains('is-dragging'),
        cardLeft: Math.round(r.left),
        cardTop: Math.round(r.top),
        cardWidth: Math.round(r.width),
        takesPointer: getComputedStyle(card).pointerEvents !== 'none',
        underPointer: name(hit),
        // Whether the hit landed on the card being carried, which answers for its home column.
        hitTheCard: !!hit && card.contains(hit),
        gap: !!slot,
      gapHeight: s ? Math.round(s.height) : null,
      gapIn: slot?.closest('.sheaf-board-col')?.dataset.value ?? null,
      // Which cards the gap sits between, so "in the column" can be told from "at its end".
        gapAt: slot ? [...(slot.parentElement?.children ?? [])].indexOf(slot) : null,
        inColumn: slot ? (slot.parentElement?.children.length ?? 0) - 1 : null,
        target: document.querySelector('.sheaf-board-col.is-drop-target')?.dataset.value ?? null,
      };
    },
    { px, py }
  );

const read = () => readFileSync(join(root, 'b.md'), 'utf8');

/** Press on `from`, walk to `to` in `steps`, reading the board at each one. */
async function walk(page, from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const seen = [];
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    seen.push(await during(page, x, y));
  }
  return seen;
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(`${base}/edit/b.md`);
  await page.waitForSelector('.sheaf-board-card', { timeout: 15_000 });
  await page.waitForTimeout(700);

  const at = await places(page);
  if (!at.card0 || !at.blocked) {
    failures.push('no board card or no Blocked column was drawn, so nothing was measured');
  } else {
    const before = read();
    const seen = await walk(page, at.card0, at.blocked, 4);
    const last = seen[seen.length - 1];
    const first = seen[0];

    console.log(`  the card starts at x=${Math.round(at.card0.left)}, the Blocked column head at x=${Math.round(at.blocked.x)}`);
    for (const [i, s] of seen.entries()) {
      console.log(
        `  step ${i + 1}: card left ${s ? s.cardLeft : '-'}, lifted ${s ? s.lifted : '-'}, gap ${s ? `${s.gapHeight}px in ${s.gapIn}` : 'none'}` +
          `, at ${s ? `${s.gapAt} of ${s.inColumn}` : '-'}, under the pointer ${s ? s.underPointer : '-'}`
      );
    }

    if (!last || !first) {
      failures.push('the card went missing mid-drag');
    } else {
      if (!last.lifted) failures.push('the card is not marked as being dragged at the end of the drag');
      /*
       * Two different strengths of claim, and they are kept apart on purpose.
       *
       * `hitTheCard` is the defect itself: the board hit-tests at the pointer on every move to
       * find the column, the carried card sits under the pointer, and it is a DOM descendant of
       * the column it started in, so a hit that lands on it names the home column.
       *
       * `takesPointer` is the rule that keeps that from arising. Measured, the carried card does
       * not win the hit test even with `pointer-events` on, because it is inside a stacking
       * context of the editor's own and its `z-index` does not reach out of it. So this half is a
       * guard rather than a reproduction, and it is worth pinning precisely because the thing
       * saving it is paint order in somebody else's layout.
       */
      const blind = seen.filter((s) => s && s.hitTheCard).length;
      if (blind) {
        failures.push(
          `the hit test at the pointer landed on the carried card at ${blind} of ${seen.length} steps. The card is a\n` +
            `    descendant of the column it started in, so those moves name the home column and the drop goes nowhere.`
        );
      } else if (last.takesPointer) {
        failures.push(
          'the carried card is hit-testable. It did not win the hit test in this layout, so nothing is broken yet,\n' +
            '    and that is the point: the card is under the pointer and whether it answers for the home column is\n' +
            '    left to paint order. `pointer-events: none` on `.sheaf-board-card.is-dragging` settles it.'
        );
      }
      /*
       * The card followed the pointer. Measured as a proportion of the distance rather than to
       * the pixel, because the card is positioned from the press point and a few pixels of
       * rounding or of scrollbar is not the question being asked.
       */
      const wanted = at.blocked.x - at.card0.x;
      const got = last.cardLeft - Math.round(at.card0.left);
      console.log(`  the pointer travelled ${Math.round(wanted)}px and the card moved ${got}px`);
      if (Math.abs(got - wanted) > 12) {
        failures.push(
          `the card moved ${got}px while the pointer moved ${Math.round(wanted)}px, so it is not under the pointer.\n` +
            `    A card that stays where it was reads as a click that teleported something.`
        );
      }
      // And it moved as the pointer did, rather than jumping once at the end.
      if (first.cardLeft === last.cardLeft) {
        failures.push('the card was in the same place at the first step and the last, so it is not being carried.');
      }
      if (!last.gap) failures.push('there is no gap where the card came from, so the column closed up under the hand');
      else {
        if (last.gapHeight !== Math.round(at.card0.height)) {
          failures.push(`the gap is ${last.gapHeight}px tall against a card of ${Math.round(at.card0.height)}px.`);
        }
        if (last.gapIn !== 'Blocked') {
          failures.push(`the gap is in ${last.gapIn ?? 'no column'} rather than Blocked, so it does not say where the card will land.`);
        }
      }
      if (last.target !== 'Blocked') failures.push(`the drop target is ${last.target ?? 'no column'} rather than Blocked.`);
    }

    await page.mouse.up();
    await page.waitForTimeout(900);
    const after = read();
    const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
    console.log(`  releasing over Blocked changed ${changed.length} line(s): ${JSON.stringify(changed)}`);
    if (changed.length !== 1 || !changed[0].startsWith('Search,Blocked')) {
      failures.push(`releasing over another column should change one line to Search,Blocked; it changed ${JSON.stringify(changed)}`);
    }

    /* ---- Escape puts it back ------------------------------------------------------------ */
    const back = await places(page);
    const beforeEsc = read();
    await walk(page, back.card0, back.done, 3);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const escaped = await during(page, back.done.x, back.done.y);
    await page.mouse.up();
    await page.waitForTimeout(700);
    console.log(`  after Escape: lifted ${escaped?.lifted}, gap ${escaped?.gap}, file unchanged ${read() === beforeEsc}`);
    if (escaped?.lifted || escaped?.gap) failures.push('Escape mid-drag left the card lifted or the gap in place');
    if (read() !== beforeEsc) failures.push('Escape mid-drag wrote to the file, and it must write nothing');
  }

  /* ---- A board wider than its pane scrolls to the column being reached for --------------- */
  //
  // Held at the edge rather than moved past it: a person waiting for the board to come to them
  // is not moving the pointer, so a scroll driven by the move handler alone would take one step
  // and stop. This holds still for most of a second and reads how far it went.
  const wide = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await wide.goto(`${base}/edit/wide.md`);
  await wide.waitForSelector('.sheaf-board-card', { timeout: 15_000 });
  await wide.waitForTimeout(700);
  const room = await wide.evaluate(() => {
    const board = document.querySelector('.sheaf-board');
    for (let el = board; el; el = el.parentElement) {
      const o = getComputedStyle(el).overflowX;
      if ((o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth) {
        const r = el.getBoundingClientRect();
        return { right: r.right, y: r.top + 40, scroll: el.scrollLeft, over: el.scrollWidth - el.clientWidth };
      }
    }
    return null;
  });
  if (!room) {
    failures.push('the wide board did not scroll sideways, so carrying a card to an offscreen column was not measured');
  } else {
    const card = await wide.evaluate(() => {
      const r = document.querySelector('.sheaf-board-card')?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    await wide.mouse.move(card.x, card.y);
    await wide.mouse.down();
    await wide.mouse.move(room.right - 20, room.y);
    await wide.mouse.move(room.right - 12, room.y);
    await wide.waitForTimeout(900);
    const scrolled = await wide.evaluate(() => {
      for (let el = document.querySelector('.sheaf-board'); el; el = el.parentElement) {
        const o = getComputedStyle(el).overflowX;
        if (o === 'auto' || o === 'scroll') return el.scrollLeft;
      }
      return 0;
    });
    await wide.keyboard.press('Escape');
    await wide.mouse.up();
    console.log(`  a card held at the right edge of a wide board scrolled it from ${room.scroll} to ${scrolled} (of ${room.over})`);
    if (scrolled <= room.scroll) {
      failures.push(
        `holding a carried card at the right edge scrolled the board from ${room.scroll} to ${scrolled}.\n` +
          `    A column past the edge is unreachable otherwise, and a person waiting there is not moving the pointer.`
      );
    }
  }
  await wide.close();
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} board drag measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log('\nA dragged card is carried under the pointer, leaves a gap where it will land, drops into one cell, and Escape puts it back.');
