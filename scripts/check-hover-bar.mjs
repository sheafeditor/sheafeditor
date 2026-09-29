/*
 * Whether a table's hover bar can be pressed from any direction, and by a finger.
 *
 *   node scripts/check-hover-bar.mjs
 *
 * The bar floats above the table rather than holding a band in the flow, so a button's middle
 * is over the line above rather than over the table. Whether the button was alive then depended
 * on where the pointer had come from: the bar shows while the table is hovered, and a pointer
 * coming down the document reached the button before it reached anything that would raise it, so
 * the button had `pointer-events: none` and the click went through to the blank line and moved
 * the caret. Coming from inside the table worked, because the hover was already alive.
 *
 * Nothing about that fails in a way a check of the drawing could see. The bar is drawn, the
 * button is drawn, and the geometry is right. What is wrong is which element is on top at that
 * point and what it will accept, which is why this asks `elementFromPoint` and reads
 * `pointer-events` rather than looking at pixels.
 *
 * ## The direction is the whole measurement
 *
 * Every reading here is taken twice, once with the pointer arriving from above and once with it
 * arriving from inside the table, and the point pressed is identical. A check that moved the
 * pointer only one way is the check that would have passed throughout: arriving from the table
 * has always worked, and it is the path anybody writing a scenario reaches for first, because it
 * is how you get the bar to appear in order to click it.
 *
 * ## Three things it also holds, because the fix could buy one at the cost of another
 *
 * The strip is full width with its buttons pushed right, so making the *strip* take the pointer
 * would swallow every click on the line above a table. A point in the strip away from the buttons
 * must still reach the line.
 *
 * A hidden button is hit-testable for a pointer, which is safe only because arriving there is
 * what makes it visible. Under `pointer: coarse` there is no arrival, so a hidden button must
 * take no pointer at all or a tap would press something that is not on the screen.
 *
 * ## The touch half, and the reason it is here rather than assumed
 *
 * That last rule is only half a sentence. A button that takes no tap is safe and useless on its
 * own, and a browser tab on a phone is one of the two hosts this ships to: with nothing raising
 * the bar there, every command on it is out of reach and the table reads as a surface that
 * simply has no commands. The gesture that raises it is a tap in the table, which focuses the
 * grid and so matches `:focus-within`, the rule beside `:hover` at the top of the bar's styles.
 * This section presses that gesture and then reads the bar, its button, the header row under it,
 * the strip beside it, and whether the command runs.
 *
 * **Chromium leaves `:hover` on whatever a synthetic tap landed on.** So a touch page matches
 * `.sheaf-table:hover` and the bar is up for a reason a real finger never supplies. Measured
 * before the pointer was moved off: deleting the `:focus-within` opacity rule changed nothing
 * and every reading still passed, which is a control that cannot fail. The pointer is moved to
 * the corner first and `:hover` is asserted gone, so what is read is the focus rule.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

/* A paragraph above the table, so the bar overlaps a line that a click could otherwise reach. */
const DOC = 'Intro paragraph.\n\n| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n';

const root = mkdtempSync(join(tmpdir(), 'sheaf-hover-'));
writeFileSync(join(root, 't.md'), DOC);
const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so the hover bar was not measured' });
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

/** What is on top at a point, and whether the bar and its button will take a pointer there. */
const readAt = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.sheaf-table-controls');
    const b = document.querySelector('.sheaf-table-controls button.sheaf-table-ctrl');
    if (!bar || !b) return null;
    const r = b.getBoundingClientRect();
    const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}` : 'nothing');
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      opacity: getComputedStyle(bar).opacity,
      pointer: getComputedStyle(b).pointerEvents,
      topmost: name(top),
      // Whether the thing on top is the button itself, which is what a click would reach.
      isButton: !!top && top.closest('.sheaf-table-controls') !== null,
    };
  });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`${base}/edit/t.md`);
  await page.waitForSelector('.sheaf-table', { timeout: 15_000 });
  await page.waitForTimeout(700);

  const box = await page.evaluate(() => {
    const t = document.querySelector('.sheaf-table');
    const b = document.querySelector('.sheaf-table-controls button.sheaf-table-ctrl');
    if (!t || !b) return null;
    const tr = t.getBoundingClientRect(), br = b.getBoundingClientRect();
    return {
      table: { x: (tr.left + tr.right) / 2, y: (tr.top + tr.bottom) / 2, top: tr.top },
      btn: { x: (br.left + br.width / 2) - br.width / 2 + br.width / 2, y: (br.top + br.bottom) / 2, top: br.top, bottom: br.bottom },
    };
  });
  if (!box) {
    failures.push('no table or no bar button was drawn, so nothing was measured');
  } else {
    console.log(`  the button's middle is at y=${box.btn.y.toFixed(0)}, the table starts at y=${box.table.top.toFixed(0)}`);

    // ---- Arriving from above ------------------------------------------------------------
    //
    // The reported case. Out of the document first, then onto the line above, then down onto
    // the button, so the pointer genuinely crosses into it from outside the table.
    await page.mouse.move(600, 5);
    await page.waitForTimeout(120);
    await page.mouse.move(box.btn.x, box.btn.top - 20);
    await page.waitForTimeout(150);
    await page.mouse.move(box.btn.x, box.btn.y);
    await page.waitForTimeout(250);
    const above = await readAt(page);

    // ---- Arriving from inside the table -------------------------------------------------
    //
    // The path that always worked, kept as the control: if this ever fails the check is
    // measuring something other than direction.
    await page.mouse.move(box.table.x, box.table.y);
    await page.waitForTimeout(150);
    await page.mouse.move(box.btn.x, box.btn.y);
    await page.waitForTimeout(250);
    const fromTable = await readAt(page);

    for (const [how, r] of [['from above', above], ['from the table', fromTable]]) {
      if (!r) {
        failures.push(`the bar or its button went missing while arriving ${how}`);
        continue;
      }
      console.log(`  arriving ${how.padEnd(14)} topmost ${r.topmost.padEnd(26)} opacity ${r.opacity}  button pointer-events ${r.pointer}`);
      if (!r.isButton || r.pointer === 'none' || r.opacity === '0') {
        failures.push(
          `a button on the hover bar cannot be pressed when the pointer arrives ${how}: the topmost element at its own ` +
            `middle is ${r.topmost}, the bar's opacity is ${r.opacity} and the button's pointer-events is ${r.pointer}.\n` +
            `    A button that is drawn is a button that can be pressed, from whichever direction the pointer reaches it.`
        );
      }
    }
    if (above && fromTable && above.isButton && !fromTable.isButton) {
      failures.push('CONTROL: arriving from the table failed while arriving from above worked, so this is not measuring direction at all');
    }

    // ---- The strip still lets a click through -------------------------------------------
    //
    // The strip spans the table's width with its buttons pushed right, so if it took the
    // pointer itself every click on the line above a table would be swallowed. That is the
    // guarantee the original rule bought and the fix has to keep.
    const strip = await page.evaluate(() => {
      const bar = document.querySelector('.sheaf-table-controls');
      const r = bar.getBoundingClientRect();
      const e = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
      return e ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}` : 'nothing';
    });
    console.log(`  a point in the strip, away from the buttons, hits ${strip}`);
    if (strip.includes('sheaf-table-controls') || strip.includes('sheaf-table-ctrl')) {
      failures.push(
        `a click in the strip away from the buttons lands on ${strip} rather than on the line above.\n` +
          `    The strip is the table's full width, so taking the pointer there swallows every click on the line` +
          `\n    above a table. Only the buttons may take it.`
      );
    }
  }

  // ---- A hidden button takes no pointer where nothing hovers ---------------------------
  //
  // A pointer makes a hidden button safe by arriving on it. A finger does not arrive, so under
  // `pointer: coarse` a hidden button must take no pointer at all.
  const touch = await browser.newPage({ viewport: { width: 1200, height: 900 }, hasTouch: true, isMobile: true });
  await touch.goto(`${base}/edit/t.md`);
  await touch.waitForSelector('.sheaf-table', { timeout: 15_000 });
  await touch.waitForTimeout(700);
  const coarse = await touch.evaluate(() => {
    const bar = document.querySelector('.sheaf-table-controls');
    const b = document.querySelector('.sheaf-table-controls button.sheaf-table-ctrl');
    if (!bar || !b) return null;
    return { coarse: matchMedia('(pointer: coarse)').matches, opacity: getComputedStyle(bar).opacity, pointer: getComputedStyle(b).pointerEvents };
  });
  if (!coarse) {
    failures.push('no bar was drawn on a coarse pointer, so the tap case was not measured');
  } else if (!coarse.coarse) {
    failures.push('the coarse-pointer page did not report `pointer: coarse`, so the tap case was not measured at all');
  } else {
    console.log(`  coarse pointer, untouched: bar opacity ${coarse.opacity}, button pointer-events ${coarse.pointer}`);
    if (coarse.opacity === '0' && coarse.pointer !== 'none') {
      failures.push(
        `on a coarse pointer a hidden button takes the pointer (${coarse.pointer}) while the bar's opacity is ` +
          `${coarse.opacity}.\n    A tap has no arrival, so nothing raises the bar first and the tap would press a button` +
          `\n    that is not on the screen.`
      );
    }

    /* ---- A finger can raise the bar, and then press it ---------------------------------
     *
     * The other half of the same sentence. A hidden button that takes no tap is safe and
     * useless on its own: with no hover to raise the bar, every command on it is out of
     * reach, and the table reads as a surface that simply has no commands.
     *
     * The gesture is a tap in the table, which focuses the grid and so matches
     * `:focus-within`. It is the gesture a person already makes to say which table they
     * mean, so there is nothing new to learn and nothing new to discover.
     *
     * Tapped rather than focused by script, because `el.focus()` would satisfy
     * `:focus-within` whatever the tap actually does with focus, and what is in question
     * here is precisely whether a tap gets there.
     */
    const cellBox = await touch.evaluate(() => {
      const c = document.querySelector('.sheaf-table [role="gridcell"]');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!cellBox) {
      failures.push('no table cell was drawn on a coarse pointer, so the tap was not made');
    } else {
      await touch.tap('.sheaf-table [role="gridcell"]');
      await touch.waitForTimeout(400);
      /*
       * Take the hover off before reading anything, and this is the step the whole section
       * turns on. Chromium leaves `:hover` on the element a synthetic tap landed on, so a
       * page driven this way matches `.sheaf-table:hover` and the bar is up for a reason a
       * real finger never supplies. Measured: with the `:focus-within` opacity rule deleted,
       * every reading below still passed, which is a control that cannot fail.
       *
       * The pointer goes to the top-left corner, which is above the document's first line and
       * outside the table, and the read below asserts `:hover` is gone rather than assuming
       * this worked.
       */
      await touch.mouse.move(2, 2);
      await touch.waitForTimeout(250);
      const tapped = await touch.evaluate(() => {
        const bar = document.querySelector('.sheaf-table-controls');
        const b = document.querySelector('.sheaf-table-controls button.sheaf-table-ctrl');
        if (!bar || !b) return null;
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}` : 'nothing');
        return {
          opacity: getComputedStyle(bar).opacity,
          pointer: getComputedStyle(b).pointerEvents,
          topmost: name(top),
          isButton: !!top && top.closest('.sheaf-table-controls') !== null,
          // Where focus went, which is what `:focus-within` is reading.
          focus: name(document.activeElement),
          height: Math.round(b.getBoundingClientRect().height),
          /*
           * Which selector is actually live, and this is the reading that decides whether
           * any of the rest means anything. A synthetic tap leaves Chromium's hover on the
           * element it landed on, so `:hover` can be true on a touch page and the bar would
           * appear for a reason a real finger does not have. If focus is not what raised it,
           * the check is measuring the harness rather than the product.
           */
          byFocus: !!document.querySelector('.sheaf-table:focus-within'),
          byHover: !!document.querySelector('.sheaf-table:hover'),
        };
      });
      if (!tapped) {
        failures.push('the bar or its button went missing after a tap in the table');
      } else {
        console.log(
          `  coarse pointer, after a tap in the table: bar opacity ${tapped.opacity}, button pointer-events ` +
            `${tapped.pointer}, topmost ${tapped.topmost}, focus on ${tapped.focus}, button ${tapped.height}px tall` +
            ` (:focus-within ${tapped.byFocus}, :hover ${tapped.byHover})`
        );
        if (!tapped.byFocus) {
          failures.push(
            'a tap in the table did not put focus inside it, so `:focus-within` is not what raises the bar for a finger.\n' +
              '    Whatever else this section measured was measured for the wrong reason.'
          );
        }
        if (tapped.byHover) {
          failures.push(
            'the table still matched `:hover` after the pointer was moved off it, so every reading in this section\n' +
              '    could be the hover rule rather than the focus rule and none of them means anything.'
          );
        }
        if (tapped.opacity === '0' || tapped.pointer === 'none' || !tapped.isButton) {
          failures.push(
            `a finger cannot reach the hover bar: after a tap in the table the bar's opacity is ${tapped.opacity}, the ` +
              `button's pointer-events is ${tapped.pointer} and the topmost element at its middle is ${tapped.topmost}.\n` +
              `    A browser tab on a phone is one of the hosts this ships to, and with no hover there every command on` +
              `\n    the bar is unreachable: add and delete rows and columns, the overflow menu and the source toggle.`
          );
        }
        // A fingertip is about 9mm, which is the 40px minimum the coarse block sizes to.
        if (tapped.height < 40) {
          failures.push(`a bar button is ${tapped.height}px tall on a coarse pointer, which is smaller than a fingertip.`);
        }

        /*
         * The bar is raised, so it is on the screen, and the coarse block makes it 44px tall
         * against 26. A bar that grew downward would cover the header row it sits above, and
         * a tap meant for the first cell would press a command instead. It lifts by its own
         * height, so this asks the header rather than trusting that it still does.
         */
        const header = await touch.evaluate(() => {
          /*
           * The last header cell, not the first. The buttons are pushed to the right end of
           * the strip, so the right end is the only place a bar that grew the wrong way could
           * cover a header cell, and the first cell sits under the strip's empty half, where
           * `pointer-events: none` lets a tap through whatever the geometry does. Measured:
           * with the lift deleted so the bar sat squarely over the header row, the first cell
           * still reported itself and only the last one changed.
           */
          const all = [...document.querySelectorAll('.sheaf-table [role="columnheader"]')];
          const h = all[all.length - 1];
          if (!h) return null;
          const r = h.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            onBar: !!top && top.closest('.sheaf-table-controls') !== null,
            hits: top ? `${top.tagName.toLowerCase()}${top.className ? `.${String(top.className).split(' ')[0]}` : ''}` : 'nothing',
          };
        });
        console.log(`  a tap on the last header cell, the end the buttons sit at, hits ${header ? header.hits : 'nothing drawn'}`);
        if (!header) failures.push('no header cell was drawn on a coarse pointer, so the first-row tap was not measured');
        else if (header.onBar) {
          failures.push(
            `with the bar raised, a tap on the last header cell lands on ${header.hits}, which is the bar.\n` +
              `    The bar sits above the table rather than in it; a tap meant for the first row must reach the row.`
          );
        }

        /*
         * And the bar does something once pressed. Everything above is about reachability, and
         * a button that is visible, live and topmost can still be wired to nothing. The `</>`
         * toggle is the one to press: it changes what is on the screen without writing the file,
         * so this measures the command without the check having to undo anything.
         */
        /*
         * The one this must not trade away. Raising the bar on focus makes its buttons live
         * while the grid has focus, and the bar hangs over the line above the table, so a tap
         * on that line has to still reach the line.
         */
        const strip = await touch.evaluate(() => {
          const bar = document.querySelector('.sheaf-table-controls');
          if (!bar) return null;
          const r = bar.getBoundingClientRect();
          const e = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
          return e ? `${e.tagName.toLowerCase()}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}` : 'nothing';
        });
        console.log(`  a tap in the strip, away from the buttons, hits ${strip ?? 'no bar drawn'}`);
        if (strip === null) failures.push('the bar went missing before the strip could be tapped');
        else if (strip.includes('sheaf-table-controls') || strip.includes('sheaf-table-ctrl')) {
          failures.push(
            `with the bar raised by a tap, a tap in the strip away from the buttons lands on ${strip} rather than on` +
              `\n    the line above. The strip is the table's full width; only the buttons may take the pointer.`
          );
        }

        /*
         * And the bar does something once pressed. Everything above is about reachability, and
         * a button that is visible, live and topmost can still be wired to nothing. The `</>`
         * toggle is the one to press: it changes what is on the screen without writing the file.
         *
         * Last, because it takes the grid off the screen and the bar with it, so every reading
         * above has to be taken before it.
         */
        const source = '.sheaf-table-controls button[data-cmd="source"]';
        if (!(await touch.evaluate((s) => !!document.querySelector(s), source))) {
          failures.push('the bar has no source toggle, so pressing a bar command with a finger was not measured');
        } else {
          await touch.tap(source);
          await touch.waitForTimeout(400);
          const acted = await touch.evaluate(() => !document.querySelector('.sheaf-table-grid'));
          console.log(`  tapping the bar's source toggle turned the grid into text: ${acted}`);
          if (!acted) failures.push('tapping a bar button with a finger did nothing: the grid was still drawn afterwards.');
        }
      }
    }
  }
  await touch.close();
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} hover bar measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log(
  '\nThe hover bar is pressable from any direction, the strip still passes clicks through, a tap cannot press a hidden\n' +
    'button, and a tap in the table raises the bar and can then work it.'
);
