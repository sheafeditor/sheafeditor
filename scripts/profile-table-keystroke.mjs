/*
 * Where a keystroke in a big table's cell actually spends its time.
 *
 *   npm run profile:keystroke            200 columns by 200 rows, the default
 *   npm run profile:keystroke -- 50 1000 any shape
 *
 * `measure-tables.mjs` establishes that a keystroke in a cell costs about 5 microseconds
 * per cell of the table, so a keystroke is doing work proportional to the whole table
 * rather than to the cell that changed. It cannot say which pass is doing that. This can:
 * it runs Chrome's sampling profiler across fifteen real keystrokes and reports self time
 * by function, which names the pass outright instead of inviting a guess at it.
 *
 * **Self time, not total.** A profile sorted by total time says `dispatch` and every frame
 * above it, which is true and useless. Self time is where the samples actually landed.
 *
 * **It profiles the keystrokes and nothing else.** The profiler starts after the document
 * has drawn, settled and had a cell opened, so the first paint and the width allocation on
 * open are outside the window. Those are separately slow and would otherwise dominate.
 *
 * Read it against a control: run it at a small shape too. A function that costs the same at
 * 12x12 and at 200x200 is a constant and not the problem, however high it sits in the list.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

const COLS = Number(process.argv[2] ?? 200);
const ROWS = Number(process.argv[3] ?? 200);
const PRESSES = 15;
const VIEW = { width: 1200, height: 900 };
/** Functions below this share of the window are noise in a fifteen-keystroke sample. */
const FLOOR_PERCENT = 0.8;

const CHROME = [
  process.env.SHEAF_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
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

const row = (cells) => `| ${cells.join(' | ')} |`;
const doc = [
  '# Keystroke profile',
  '',
  'A paragraph above the table.',
  '',
  row(Array.from({ length: COLS }, (_, c) => `Column ${c + 1}`)),
  row(Array.from({ length: COLS }, () => '---')),
  ...Array.from({ length: ROWS }, (_, r) => row(Array.from({ length: COLS }, (_, c) => `r${r + 1}c${c + 1}`))),
  '',
].join('\n');

const root = mkdtempSync(join(tmpdir(), 'sheaf-profile-'));
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.lineNumbers': false }, null, 2));
writeFileSync(join(root, 'doc.md'), doc);

const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so there is nothing to profile.' });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: VIEW });

console.log(`profiling ${PRESSES} keystrokes in a cell of a ${COLS}x${ROWS} table (${COLS * ROWS} cells)\n`);

await page.goto(`${base}/edit/doc.md`, { timeout: 120_000 });
await page.waitForSelector('.sheaf-table-grid td[role="gridcell"]', { timeout: 120_000 });
await page.waitForTimeout(2500);

// Open the cell before profiling, so opening it is not in the window.
await page.dblclick('.sheaf-table-grid td[role="gridcell"]');
const opened = await page
  .waitForSelector('.sheaf-table-input', { timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
if (!opened) {
  console.log('no cell editor opened, so there is nothing to profile');
  await browser.close();
  server.kill('SIGKILL');
  process.exit(1);
}
await page.waitForTimeout(400);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
// 100us between samples. The default 1ms is too coarse for a 260ms window.
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');

const before = await page.evaluate(() => document.querySelector('.sheaf-table-input')?.textContent ?? null);
for (let i = 0; i < PRESSES; i++) {
  await page.keyboard.press('x');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const after = await page.evaluate(() => document.querySelector('.sheaf-table-input')?.textContent ?? null);

const { profile } = await cdp.send('Profiler.stop');

/*
 * Self time per function, from the samples rather than from hit counts, because the
 * interval is not uniform: `timeDeltas[i]` is the microseconds before `samples[i]`.
 */
const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const us = profile.timeDeltas[i] ?? 0;
  if (us <= 0) continue;
  total += us;
  const f = byId.get(profile.samples[i]);
  if (!f) continue;
  const where = f.url ? `${f.url.split('/').at(-1)}:${f.lineNumber + 1}` : 'native';
  const key = `${f.functionName || '(anonymous)'}  ${where}`;
  self.set(key, (self.get(key) ?? 0) + us);
}

const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]);
const ms = (us) => Math.round(us / 100) / 10;

/*
 * Self time names the function that is slow. It does not name who called it, which is the
 * thing a fix needs: a pure helper like a string-width function is slow only because
 * something is calling it forty thousand times, and the caller is what changes. So the
 * chains below are the hot leaves with their callers above them, ranked by the same
 * self time, which is the shortest route from "this is slow" to "this is the line".
 */
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
const named = (id) => {
  const f = byId.get(id);
  if (!f) return null;
  const where = f.url ? `${f.url.split('/').at(-1)}:${f.lineNumber + 1}` : 'native';
  return `${f.functionName || '(anonymous)'} (${where})`;
};
const chains = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const us = profile.timeDeltas[i] ?? 0;
  if (us <= 0) continue;
  const frames = [];
  for (let id = profile.samples[i]; id !== undefined && frames.length < 5; id = parentOf.get(id)) {
    const label = named(id);
    if (label) frames.push(label);
  }
  if (!frames.length) continue;
  const key = frames.join('\n             <- ');
  chains.set(key, (chains.get(key) ?? 0) + us);
}

console.log(`typing ${before === after ? 'LANDED NOWHERE, so this profile is of nothing' : `landed, text grew by ${after.length - before.length}`}`);
console.log(`profiled window ${ms(total)}ms over ${PRESSES} keystrokes, ${ms(total / PRESSES)}ms each\n`);
console.log('self time  share   function');
for (const [key, us] of ranked) {
  const share = (us / total) * 100;
  if (share < FLOOR_PERCENT) break;
  console.log(`${String(ms(us) + 'ms').padStart(8)}  ${share.toFixed(1).padStart(5)}%  ${key}`);
}

console.log('\nhot paths, leaf first, which is where a fix goes\n');
for (const [key, us] of [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`${String(ms(us) + 'ms').padStart(8)}  ${key}\n`);
}

await browser.close();
server.kill('SIGKILL');
