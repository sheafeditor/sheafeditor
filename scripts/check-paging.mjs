/*
 * What a page of document is, measured in a real browser.
 *
 *   node scripts/check-paging.mjs
 *
 * The first thing asserted is what a reader notices: **paging down and back up returns
 * them to where they were, the caret as well as the view.** Twelve of each used to leave
 * them 546px, six sections, below where they started.
 *
 * All of it is layout: how tall each drawn row is, and how many fit on a screen. jsdom has
 * no answer to either, so nothing in the suites can check this. It is measured here
 * instead, by serving documents through Sheaf's own local server and driving them in
 * Chromium.
 *
 * Reversibility on its own is not enough, for a reason worth keeping in mind while reading
 * the rest: **a PageDown that did nothing at all would satisfy it perfectly.** So there is
 * also a measurement that a page moves the reader through the document, one that the caret
 * goes with the view rather than being left behind, and one that a reader who holds
 * PageDown arrives at the end of the file.
 *
 * And a page is a count of rows rather than a screenful of pixels, which is the one thing
 * every measurement above passes under either way. Two documents are served to tell them
 * apart: `flat.md` is plain paragraphs, whose rows are body height, and `tall.md` is
 * headings, whose rows are about twice that. A page of *rows* crosses the same count in
 * both and travels much further in pixels through the headings; a page of *pixels* travels
 * the same distance in both and crosses half as many rows. Both halves of that are
 * asserted, because a pixel page was written, measured, and found to return the view
 * exactly while leaving the caret 14 lines out.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When
 * either is missing this says so and exits 0, because a missing browser is not a
 * broken document. A measurement that actually runs and disagrees fails.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

const VIEW = { width: 1200, height: 900 };
/** Enough presses to make a per-press error visible, and few enough to stay inside the document. */
const PRESSES = 12;
/** A line of body text. Less than this is the browser's own sub-pixel rounding. */
const ALLOWED_DRIFT = 8;
/**
 * How much further a page must travel through headings than through prose before this is
 * satisfied that a page is counted in rows. A page of pixels gives exactly 1; the further
 * above 1 the measurement sits, the more plainly a page is being counted in rows.
 *
 * Both documents alternate a line with a blank separator, so the ratio is the ratio of those
 * pairs. `tall.md`'s is an h2 at 24px on 1.25 leading plus its 12px of heading space, 42px,
 * over a 24px separator: 66px for two rows. `flat.md`'s is 24 and 24: 48px. So 1.375, and the
 * measurement is 1.38.
 *
 * It was 1.82 when this was written, against a threshold of 1.4, and the difference is the
 * blank separator. One used to draw 8px rather than a full line, so the pair was 50 and 8
 * against 24 and 8, and the heading's own height counted for much more of it. Every line is one
 * line height now, which is a better document and a smaller ratio, because the thing being
 * divided is closer to the thing dividing it.
 *
 * 1.2 sits halfway between a page of pixels and what the geometry actually gives, so there is
 * as much room below the measurement as there is above the failure it is looking for. Note
 * that the assertion beside this one, that a page crosses the same count of lines in both
 * documents, catches a page of pixels directly and does not move when the design does. This
 * one is the same fact from the other side, and it is the side that has a number in it.
 */
const TALL_MUST_TRAVEL = 1.2;

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

const root = mkdtempSync(join(tmpdir(), 'sheaf-paging-'));
// Line numbers on, so the count of lines a page crosses is read from the gutter
// rather than inferred from the shape of the document.
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.lineNumbers': true }, null, 2));
writeFileSync(
  join(root, 'flat.md'),
  Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1} of this document holds one short sentence.`).join('\n\n') + '\n'
);
writeFileSync(join(root, 'tall.md'), Array.from({ length: 400 }, (_, i) => `## Section ${i + 1}`).join('\n\n') + '\n');

/** Where the view and the caret are, and which line of the file the caret is on. */
const look = (page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    const box = scroller.getBoundingClientRect();
    const s = getSelection();
    const el = s?.anchorNode ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) : null;
    const caretLine = el?.closest?.('.cm-line') ?? null;
    const rect = caretLine?.getBoundingClientRect();
    // The gutter element level with the caret's line carries that line's number. The
    // gutter's first child is a hidden spacer of zero height that sizes the column and
    // holds a number of its own, sitting at the same top as the first line: taken for a
    // line number it reported 999 on a 400-line document.
    const numbers = [...document.querySelectorAll('.cm-gutterElement')].filter((e) => e.getBoundingClientRect().height > 0);
    const number = rect
      ? (() => {
          const g = numbers.find((e) => Math.abs(e.getBoundingClientRect().top - rect.top) < 2);
          const n = g ? Number(g.textContent.trim()) : NaN;
          return Number.isFinite(n) && n > 0 ? n : null;
        })()
      : null;
    return {
      scrollTop: Math.round(scroller.scrollTop * 100) / 100,
      screen: scroller.clientHeight,
      gutter: numbers.length,
      atBottom: scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1,
      line: number,
      caretOnScreen: !!rect && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
      caretOffset: rect ? Math.round(rect.top - box.top) : null,
      lastLineDrawn: !!caretLine && caretLine === [...document.querySelectorAll('.cm-line')].at(-1),
    };
  });

/** Put the caret two characters into the first line, as a reader who clicked there. */
async function caretAtTop(page) {
  await page.click('.cm-content');
  await page.evaluate(() => {
    const line = document.querySelector('.cm-line');
    const node = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(node, Math.min(2, node.data.length));
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.waitForTimeout(300);
}

/** Page down `PRESSES` times and back up, reporting every step. */
async function roundTrip(page, file) {
  await page.goto(`${base}/edit/${file}`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await caretAtTop(page);
  // Three pages in before the measurement starts. At the very top the view cannot
  // scroll further up, so a page up there is clamped rather than travelled, and a
  // round trip beginning on line 1 measures the clamp as drift. A reader looking
  // ahead and coming back is in the middle of a document, which is where the
  // reversibility has to hold.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(300);

  const start = await look(page);
  const down = [];
  for (let i = 0; i < PRESSES; i++) {
    const was = await look(page);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(160);
    const now = await look(page);
    down.push({ pixels: Math.round(now.scrollTop - was.scrollTop), lines: now.line !== null && was.line !== null ? now.line - was.line : null });
  }
  const bottom = await look(page);
  for (let i = 0; i < PRESSES; i++) {
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(600);
  const back = await look(page);
  return { start, down, bottom, back };
}

const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'Without it every measurement below would fail against a refused connection and read as a paging fault.',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];
const said = [];

try {
  const page = await browser.newPage({ viewport: VIEW });
  const flat = await roundTrip(page, 'flat.md');
  const tall = await roundTrip(page, 'tall.md');

  // The gutter is how the count of lines is read, so a missing one would leave every
  // line measurement below as null and silently unchecked.
  for (const [name, r] of [
    ['flat.md', flat],
    ['tall.md', tall],
  ]) {
    if (!r.start.gutter || r.start.line === null) {
      failures.push(`${name}: no line-number gutter, so the count of lines a page crosses could not be read and nothing below about lines was measured`);
    }
  }

  for (const [name, r] of [
    ['flat.md', flat],
    ['tall.md', tall],
  ]) {
    const drift = Math.round(Math.abs(r.back.scrollTop - r.start.scrollTop) * 100) / 100;
    const lines = r.down.map((d) => d.lines);
    const pixels = r.down.map((d) => d.pixels);
    said.push(
      `${name}: line ${r.start.line} -> ${r.bottom.line} -> ${r.back.line}; view moved ${drift}px over the round trip; ` +
        `a page crossed ${[...new Set(lines)].join('/')} lines and ${[...new Set(pixels)].join('/')}px of a ${r.start.screen}px screen`
    );

    // 1. The round trip, which is what this exists for.
    if (drift > ALLOWED_DRIFT) {
      failures.push(
        `${name}: ${PRESSES} PageDown and ${PRESSES} PageUp left the view ${drift}px from where it started, so a reader who looked further on and came back has lost their place.\n` +
          `    lines per page ${JSON.stringify(lines)}\n    pixels per page ${JSON.stringify(pixels)}`
      );
    }
    // The caret, not only the view. An earlier version of paging scrolled by an exact
    // number of pixels and put the caret back by asking which line was under a screen
    // point; the view returned exactly and the caret did not, because a line is not a
    // point, so it landed 14 lines out over this round trip. Counting rows returns both.
    if (r.back.line !== null && r.start.line !== null && r.back.line !== r.start.line) {
      failures.push(
        `${name}: the caret left line ${r.start.line} and came back to line ${r.back.line}, ${Math.abs(r.back.line - r.start.line)} out, ` +
          `so a reader who was typing would carry on in the wrong place even though the view looks right`
      );
    }

    // 2. The control. A PageDown that did nothing at all would satisfy the round trip
    //    above perfectly, so the round trip on its own proves nothing: a page has to
    //    move the reader through the document.
    const crossed = lines.filter((n) => n !== null);
    const least = crossed.length ? Math.min(...crossed) : null;
    if (least === null) {
      failures.push(`${name}: how many lines a page crossed could not be read at all, so nothing here measured whether PageDown does anything`);
    } else if (least < 2) {
      failures.push(`${name}: a page crossed as few as ${least} line, so PageDown is doing nothing a reader would call turning a page`);
    }

    // 3. The caret goes with the view and is still where it was on the screen.
    if (!r.bottom.caretOnScreen) {
      failures.push(`${name}: after paging down the caret's line is off the screen, at ${r.bottom.caretOffset}px of a ${r.bottom.screen}px screen`);
    }
    if (r.start.caretOffset !== null && r.bottom.caretOffset !== null && Math.abs(r.bottom.caretOffset - r.start.caretOffset) > ALLOWED_DRIFT) {
      said.push(
        `${name}: the caret sat ${r.start.caretOffset}px down the screen and ${r.bottom.caretOffset}px after ${PRESSES} pages, drifting ${Math.abs(r.bottom.caretOffset - r.start.caretOffset)}px down it`
      );
    }
  }

  // 4. A page is a count of rows, not a screenful of pixels, and this is the measurement
  //    that tells the two apart. Headings are about twice a body row, so a page of *rows*
  //    crosses the same count in both documents and travels much further in pixels through
  //    the headings; a page of *pixels* travels the same distance in both and crosses half
  //    as many lines. Every case above passes under either definition, so without this the
  //    definition would be held by nothing.
  const px = (r) => r.down[1]?.pixels ?? 0;
  const ln = (r) => r.down[1]?.lines ?? null;
  const ratio = px(flat) > 0 ? Math.round((px(tall) / px(flat)) * 100) / 100 : null;
  said.push(`a page travelled ${px(tall)}px through headings and ${px(flat)}px through prose, a ratio of ${ratio}, crossing ${ln(tall)} and ${ln(flat)} lines`);
  if (ratio === null || ratio < TALL_MUST_TRAVEL) {
    failures.push(
      `a page travelled ${px(tall)}px through headings and ${px(flat)}px through prose, a ratio of ${ratio}, under the ${TALL_MUST_TRAVEL} a page counted in rows must reach.\n` +
        `    A ratio near 1 is a page of pixels, which cannot be reversible while rows differ in height.`
    );
  }
  if (ln(flat) !== null && ln(tall) !== null && ln(flat) !== ln(tall)) {
    failures.push(`a page crossed ${ln(flat)} lines of prose and ${ln(tall)} lines of headings; a page is a count of rows, so the count is the same in both`);
  }

  // 5. Paging to the bottom arrives at the end rather than stopping short of it.
  await page.goto(`${base}/edit/tall.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await page.waitForTimeout(1000);
  await caretAtTop(page);
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(30);
    if ((await look(page)).atBottom) break;
  }
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(300);
  const end = await look(page);
  said.push(`held down to the end, the caret reached line ${end.line}${end.lastLineDrawn ? ', the last line of the file' : ''}`);
  if (!end.atBottom) failures.push(`pressing PageDown 200 times never reached the bottom of the document`);
  if (!end.lastLineDrawn) failures.push(`paging to the bottom left the caret on line ${end.line} rather than the last line, so a reader cannot page to the end`);
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

for (const line of said) console.log(`  ${line}`);
if (failures.length) {
  console.log(`\n${failures.length} paging measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log(`\na page is a count of rows, the same count through prose and headings, paging down and back returns both the view and the caret, and holding it down reaches the end.`);
