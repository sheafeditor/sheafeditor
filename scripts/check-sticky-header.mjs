/*
 * Whether a tall table's header holds one place while the document scrolls past it.
 *
 *   node scripts/check-sticky-header.mjs
 *
 * A held header exists so a long table's columns keep their names. One that blinks costs more
 * attention than no header at all, so "it flickers" is the defect rather than a detail of it.
 *
 * ## Why this reads a sequence rather than a state
 *
 * Every frame of a flicker is individually correct: the header is either held or not, and both
 * are legitimate at some scroll position. What is wrong is the *order* of them. So this scrolls
 * in small steps and records a row per step, then asks about the run: the header should come on
 * once, hold one position, and go once, and any second appearance is the bug.
 *
 * ## Two causes that look identical in a screenshot
 *
 * A header that is destroyed and rebuilt by CodeMirror's block virtualisation looks exactly
 * like one that is merely repositioned, and they want different fixes. Each row therefore
 * carries whether the element is the same node as last time, which separates them: a rebuild
 * changes the node, a reposition does not.
 *
 * Two mechanisms hold a header and the rows say which is in play. A table that fits its frame
 * is held by `position: sticky` in the stylesheet. A table wider than the pane cannot use that,
 * because its frame scrolls sideways and an element that scrolls on one axis is a scroll
 * container on both, so a sticky row inside it sticks to the frame; that one is lifted from
 * script by a transform instead. A table that changed its mind about which it was mid-scroll
 * would flicker for that reason alone, so `is-scroll-x` is recorded too.
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

/* Taller than two screens, with text above and below so there is somewhere to scroll from and to. */
const rows = (n, cols) => Array.from({ length: n }, (_, r) => `| ${cols.map((_, i) => `r${r + 1}c${i + 1}`).join(' | ')} |`).join('\n');
const table = (cols, n) => `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n${rows(n, cols)}`;
const LEAD = 'Intro.\n\nA second paragraph.\n\nA third.\n\n';
const TAIL = '\n\nAfter the table.\n\nAnd more text below it.\n';

const root = mkdtempSync(join(tmpdir(), 'sheaf-sticky-'));
/* A table that fits the writing column: held by the stylesheet. */
writeFileSync(join(root, 'narrow.md'), LEAD + table(['St', 'Role', 'Note'], 90) + TAIL);
/* One wider than the pane: held from script, by a transform. */
writeFileSync(join(root, 'wide.md'), LEAD + table(Array.from({ length: 12 }, (_, i) => `Column heading ${i + 1}`), 90) + TAIL);
/* The control: shorter than the pane, so its header must never hold at all. */
writeFileSync(join(root, 'short.md'), LEAD + table(['St', 'Role', 'Note'], 3) + TAIL);

const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so the held header was not measured' });
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

/**
 * Scroll `file` from above the table to below it, a row of readings per step.
 *
 * The editor's own scroller is moved rather than the window's, because that is what the document
 * scrolls in. `steps` is deliberately many and small: a flicker is frames long, and a coarse
 * sweep steps straight over the positions where it happens.
 */
async function sweep(page, file, steps = 60) {
  await page.goto(`${base}/edit/${file}`);
  await page.waitForSelector('.sheaf-table', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  const extent = await page.evaluate(() => {
    const s = document.querySelector('.cm-scroller');
    return s ? { max: s.scrollHeight - s.clientHeight, client: s.clientHeight } : null;
  });
  if (!extent || extent.max <= 0) return null;
  const seen = [];
  for (let i = 0; i <= steps; i++) {
    const to = Math.round((extent.max * i) / steps);
    await page.evaluate((to) => {
      const s = document.querySelector('.cm-scroller');
      if (s) s.scrollTop = to;
    }, to);
    await page.waitForTimeout(45);
    seen.push(
      await page.evaluate((to) => {
        const wrap = document.querySelector('.sheaf-table');
        const head = document.querySelector('.sheaf-table thead tr');
        const scroller = document.querySelector('.cm-scroller');
        if (!scroller) return { at: to, drawn: false };
        const frameTop = Math.round(scroller.getBoundingClientRect().top);
        if (!wrap || !head) return { at: to, drawn: false, frameTop };
        const cs = getComputedStyle(head);
        const r = head.getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        /*
         * Whether this is the same element as the previous step. CodeMirror virtualises block
         * widgets, so a table that leaves the drawn range is destroyed and rebuilt, and the
         * rebuilt header has none of the state script put on it. Stamped on the node rather
         * than compared by identity across `evaluate` calls, which cannot pass nodes back.
         */
        const fresh = !head.dataset.stickyProbe;
        head.dataset.stickyProbe = '1';
        return {
          at: to,
          drawn: true,
          frameTop,
          fresh,
          // Held, by either mechanism: the class the code sets, and the drawn position.
          stuck: head.classList.contains('is-stuck'),
          position: cs.position,
          transform: cs.transform === 'none' ? '' : cs.transform,
          headTop: Math.round(r.top),
          tableTop: Math.round(box.top),
          tableBottom: Math.round(box.bottom),
          scrollX: wrap.classList.contains('is-scroll-x'),
          // What a person sees: the header sitting at the top of the pane rather than with
          // rows above it. Two pixels of tolerance for subpixel layout.
          atTop: Math.abs(Math.round(r.top) - frameTop) <= 2,
        };
      }, to)
    );
  }
  return seen;
}

/** The runs of held and not-held through a sweep, which is what a flicker shows up in. */
function runs(seen) {
  const out = [];
  for (const row of seen) {
    const held = !!row.drawn && !!row.stuck;
    if (out.length && out[out.length - 1].held === held) out[out.length - 1].to = row.at;
    else out.push({ held, from: row.at, to: row.at });
  }
  return out;
}

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

  for (const [what, file] of [
    ['a table that fits the column', 'narrow.md'],
    ['a table wider than the pane', 'wide.md'],
  ]) {
    const seen = await sweep(page, file);
    if (!seen) {
      failures.push(`${what}: the document did not scroll, so nothing was measured`);
      continue;
    }
    const spells = runs(seen);
    const held = spells.filter((s) => s.held);
    const rebuilds = seen.filter((r) => r.drawn && r.fresh).length;
    const mechanism = seen.find((r) => r.drawn)?.scrollX ? 'a script transform' : 'the stylesheet';
    console.log(
      `  ${what} (${mechanism}): held over ${held.length} stretch(es) ${JSON.stringify(held.map((s) => `${s.from}..${s.to}`))}` +
        `, the header was rebuilt ${rebuilds} time(s), and it was never drawn at ${seen.filter((r) => !r.drawn).length} of ${seen.length} steps`
    );
    // Where it sat while held, which separates "holds the wrong place" from "will not hold".
    const tops = [...new Set(seen.filter((r) => r.stuck).map((r) => r.headTop - r.frameTop))];
    console.log(`    while held, its top sat ${JSON.stringify(tops)} from the top of the pane`);
    if (!held.length) {
      failures.push(`${what}: its header never held at all across the whole scroll, so a long table loses its column names.`);
    } else if (held.length > 1) {
      failures.push(
        `${what}: its header held over ${held.length} separate stretches, ${JSON.stringify(held.map((s) => `${s.from}..${s.to}`))}.\n` +
          `    It should come on once, hold, and go once; every stretch after the first is a blink.`
      );
    }
    if (rebuilds > 1) {
      console.log(`    (the header element was replaced ${rebuilds} times, so any flicker is a rebuild rather than a reposition)`);
    }
  }

  /* The control: a table shorter than the pane never holds its header at all. */
  const short = await sweep(page, 'short.md', 30);
  const shortHeld = short ? short.filter((r) => r.stuck).length : -1;
  console.log(`  CONTROL, a table shorter than the pane: held at ${shortHeld} of ${short?.length ?? 0} steps`);
  if (shortHeld !== 0) {
    failures.push(`CONTROL: a table shorter than the pane held its header at ${shortHeld} steps, and it has nothing to hold it for.`);
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} sticky header measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log('\nA tall table holds its header once, in one place, and a short one never holds it at all.');
