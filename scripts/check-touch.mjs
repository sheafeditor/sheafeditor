/*
 * What a document looks like on a phone, measured in a real browser.
 *
 *   node scripts/check-touch.mjs
 *
 * The rules that only apply on a touch screen live behind `(pointer: coarse)`,
 * and nothing else here can see them: jsdom has no layout, and a VS Code window
 * cannot be told it is a phone. So this serves `sample/` through Sheaf's own
 * local server and opens it in Chromium at a phone's size with touch on.
 *
 * What it holds is the one thing a person notices immediately: the document fits
 * the screen. A wide child inside the text column (a table, its command bar, a
 * long line of code) must scroll inside its own frame rather than widening the
 * column and taking the whole page sideways with it.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When
 * either is missing this says so and exits 0, because a missing browser is not a
 * broken document. A measurement that actually runs and disagrees fails.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/** A phone, and a pane wide enough for the centred column. */
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1200, height: 900 };
/** A document with a table in it, which is what made the column too wide. */
const DOC = 'wren-4/log/incident-2244-11-17.md';
/**
 * How long the local server gets to answer before this gives up and says so.
 *
 * Generous, because a cold start on a loaded machine is slow and a needless failure here
 * costs a whole gate run. It is a ceiling rather than a wait: the normal case ends as soon
 * as the port answers, which is well under a second.
 */
const SERVER_START_MS = 20_000;

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

/** The measurements a page reports about its own layout. */
const measure = (page) =>
  page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    const scroller = document.querySelector('.cm-scroller');
    const bar = document.querySelector('.sheaf-table-controls');
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      // Rounded: a fractional pixel is not a document running off the screen.
      content: content ? Math.round(content.getBoundingClientRect().width) : null,
      scrollWidth: scroller ? Math.round(scroller.scrollWidth) : null,
      pane: Math.round(document.documentElement.clientWidth),
      bar: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      barFolded: bar ? bar.classList.contains('is-collapsed') : null,
    };
  });

const { server, base } = await serveForCheck({
  repo: REPO,
  root: 'sample',
  whenAbsent: 'Without it every measurement below would fail against a refused connection and read as a layout fault.',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];
const say = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
};

try {
  for (const [name, viewport, touch] of [
    ['a phone', PHONE, true],
    ['a wide pane with a mouse', DESK, false],
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
    await page.goto(`${base}/edit/${DOC}`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const m = await measure(page);
    await page.close();

    if (m.content === null) {
      say(`${name}: the document loaded`, false, `no editor on the page: ${JSON.stringify(m)}`);
      continue;
    }
    // The column is the pane, never wider. This is the bug a person sees.
    say(
      `${name}: the text column fits the pane`,
      m.content <= m.pane && m.scrollWidth <= m.pane,
      `pane ${m.pane}px, column ${m.content}px, scroll width ${m.scrollWidth}px ${JSON.stringify(m)}`
    );
    if (touch) {
      say(`${name}: touch rules are the ones in force`, m.coarse === true, `(pointer: coarse) did not match`);
      // The bar folds when the pane is too narrow for it, which it can only do
      // once the column stops growing to fit it.
      say(
        `${name}: the table's bar folds rather than widening the column`,
        m.barFolded === true && m.bar !== null && m.bar <= m.pane,
        `bar ${m.bar}px, folded ${m.barFolded}`
      );
    } else {
      // Still the centred writing column, not the whole pane.
      say(`${name}: the column is still the writing measure`, m.content < m.pane, `column ${m.content}px in a ${m.pane}px pane`);
    }
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} touch check(s) failed`);
  process.exit(1);
}
console.log('\ntouch layout: the document fits the screen');
