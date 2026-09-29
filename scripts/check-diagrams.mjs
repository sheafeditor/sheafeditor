/*
 * A diagram draws, measured in a real browser.
 *
 *   node scripts/check-diagrams.mjs
 *
 * Mermaid is loaded from `media/mermaid/` at the moment a document first shows a
 * diagram, and finding that folder means knowing where the editor's own files are.
 * Nothing in the suites can check that: every jsdom scenario replaces the loader
 * with `setMermaidLoader`, because jsdom has no layout to draw an SVG with, so the
 * code that works out the address is the one part of diagrams no test ever ran.
 *
 * That is exactly how it broke. Splitting the editor into modules made
 * `document.currentScript` null, the address came out empty, and every diagram in
 * every host drew "the editor does not know where its files are". Nothing 404'd and
 * no policy refused anything, so the failure appeared in no request log and no
 * console: only on the screen, where no automated check was looking.
 *
 * Two documents, and the second is the control. A check that only asked whether an
 * SVG appeared would pass just as well if every fence drew one, so the second asks
 * that a diagram which cannot parse still reports itself as an error instead.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When
 * either is missing this says so and exits 0, because a missing browser is not a
 * broken document. A measurement that actually runs and disagrees fails.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

const VIEW = { width: 1200, height: 900 };
/** Mermaid is a large module fetched on demand, so this is a ceiling rather than a wait. */
const DRAW_MS = 20_000;

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

const root = mkdtempSync(join(tmpdir(), 'sheaf-diagrams-'));
writeFileSync(join(root, 'draws.md'), 'Before.\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\nAfter.\n');
writeFileSync(join(root, 'broken.md'), 'Before.\n\n```mermaid\nnot a diagram at all {{{\n```\n\nAfter.\n');
// Two labelled arrows, which is what the edge-label colour is read off. Two rather than one so a
// single label styled by accident cannot pass for every label being right.
writeFileSync(
  join(root, 'labelled.md'),
  '```mermaid\ngraph TD\n  A[Start] -- latched --> B[Locked]\n  B -- healthy --> C[Done]\n```\n'
);

/*
 * Where a click below a diagram lands. A diagram is drawn after the editor has measured the
 * block it sits in, so unless the editor is asked to read the heights again, its height map
 * keeps the small number it took before the drawing. Everything below the diagram is then
 * mapped short, and a click resolves past the end of the document.
 *
 * Four documents. The diagram one is the case; the table one and the plain one are the
 * controls, because a click that lands correctly in them and not here is what says the fault
 * is the diagram rather than the clicking. The two-diagram one is where the error would
 * accumulate if it were a drift rather than a stale block.
 */
const CLICK_DIAGRAM = 'Above here.\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nTarget line.\n\nTail one.\n';
const CLICK_TABLE = 'Above here.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nTarget line.\n\nTail one.\n';
const CLICK_PLAIN = 'Above here.\n\nA paragraph in between, no widget at all.\n\nTarget line.\n\nTail one.\n';
const CLICK_TWO =
  'Above here.\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nBetween them.\n\n```mermaid\ngraph TD;\nC-->D;\n```\n\nTarget line.\n\nTail one.\n';
writeFileSync(join(root, 'click-diagram.md'), CLICK_DIAGRAM);
writeFileSync(join(root, 'click-table.md'), CLICK_TABLE);
writeFileSync(join(root, 'click-plain.md'), CLICK_PLAIN);
writeFileSync(join(root, 'click-two.md'), CLICK_TWO);

/** What the page made of the fence, once it has had time to fetch Mermaid and draw. */
const drawn = async (page, base, file) => {
  await page.goto(`${base}/edit/${file}`);
  await page.waitForSelector('.md-mermaid', { timeout: 15_000 });
  const until = Date.now() + DRAW_MS;
  for (;;) {
    const state = await page.evaluate(() => {
      const box = document.querySelector('.md-mermaid');
      return {
        error: box?.classList.contains('md-mermaid-error') ?? null,
        message: document.querySelector('.md-mermaid-message')?.textContent?.trim() ?? null,
        svgs: document.querySelectorAll('.cm-content svg').length,
      };
    });
    // Settled once it has either drawn something or said why it could not.
    if (state.svgs > 0 || state.error) return state;
    if (Date.now() > until) return { ...state, timedOut: true };
    await page.waitForTimeout(250);
  }
};

const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'Without it the page would not load at all and that would read as a diagram fault.',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

try {
  const page = await browser.newPage({ viewport: VIEW });
  const refused = [];
  page.on('response', (r) => {
    if (!r.ok()) refused.push(`${r.status()} ${r.url().replace(base, '')}`);
  });

  const good = await drawn(page, base, 'draws.md');
  console.log(`  a mermaid fence: ${good.svgs} svg drawn, error box ${good.error}${good.message ? `, saying ${JSON.stringify(good.message)}` : ''}`);
  if (good.error || good.svgs < 1) {
    failures.push(
      `a mermaid fence drew no diagram${good.message ? `: ${good.message}` : ''}.\n` +
        `    Nothing here 404s when this breaks, so the refused-request list is ${refused.length ? refused.join(', ') : 'empty'} either way:\n` +
        `    finding Mermaid's folder is the part that fails, and it fails silently.`
    );
  }

  // The control. Without it, a check that reported "an svg is present" would pass on a
  // build that drew one for anything at all, and could not tell drawing from not failing.
  const bad = await drawn(page, base, 'broken.md');
  console.log(`  a fence that cannot parse: ${bad.svgs} svg drawn, error box ${bad.error}`);
  if (!bad.error) {
    failures.push(
      `CONTROL: a fence that is not a diagram did not report itself as an error, so this check cannot tell a drawn diagram from an undrawn one.`
    );
  }

  /* ---- An arrow's label sits on the page, not on a colour of Mermaid's choosing -------
   *
   * Mermaid gives `edgeLabelBackground` one value per theme, and neither is the colour the
   * diagram is actually drawn on. In a dark editor the words on an arrow came out on `#585858`
   * against a `#1f1f1f` page, so every labelled arrow carried a grey patch behind it.
   *
   * Two themes cannot cover this and that is the point: Sheaf borrows whatever theme the person
   * is using, so the background is a value rather than a choice between two. What is asserted is
   * therefore that the label's background *equals the page's*, in both schemes, rather than that
   * it is any particular colour.
   *
   * Both schemes, because one alone is not a check: the light value happened to be close enough
   * to white that a build ignoring the page entirely would have passed on light and failed only
   * where half the readers are.
   */
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: VIEW, colorScheme: scheme });
    const themed = await ctx.newPage();
    await themed.goto(`${base}/edit/labelled.md`);
    await themed.waitForSelector('.md-mermaid svg', { timeout: 15_000 });
    await themed.waitForTimeout(1200);
    const seen = await themed.evaluate(() => {
      const labels = [...document.querySelectorAll('.md-mermaid .edgeLabel')].filter((el) => el.textContent.trim());
      return {
        page: getComputedStyle(document.body).backgroundColor,
        labels: labels.length,
        backgrounds: [...new Set(labels.map((el) => getComputedStyle(el).backgroundColor))],
      };
    });
    await ctx.close();
    console.log(`  ${scheme}: page ${seen.page}, ${seen.labels} arrow labels on ${seen.backgrounds.join(' / ') || 'nothing'}`);
    if (seen.labels < 1) {
      failures.push(
        `${scheme}: the diagram drew no labelled arrows, so what its labels sit on was not measured. ` +
          `The fixture\n    has two; a diagram that draws none leaves this passing over the thing it is for.`
      );
    } else if (seen.backgrounds.length !== 1 || seen.backgrounds[0] !== seen.page) {
      failures.push(
        `${scheme}: an arrow's label sits on ${seen.backgrounds.join(' / ')} where the page is ${seen.page}.\n` +
          `    Mermaid's own per-theme value is not the colour the diagram is drawn on, and a theme Sheaf borrows` +
          `\n    from the person's editor is not one of its two. The label reads as a patch behind the words.`
      );
    }
  }
  /* ---- Where a click below a diagram lands ------------------------------- */

  /** Click the middle of `Target line.` and say which line the caret ended up on. */
  const clickTarget = async (file, waitMs) => {
    await page.goto(`${base}/edit/${file}`);
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await page.waitForTimeout(waitMs);
    const box = await page.evaluate(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent ?? '').startsWith('Target line'));
      if (!line) return null;
      const b = line.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    });
    if (!box) return { landed: 'the line was never drawn' };
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(250);
    return page.evaluate(
      (at) => {
        const content = document.querySelector('.cm-content');
        const tile = content && (content.cmTile || content.cmView);
        const view = tile && ((tile.root && tile.root.view) || tile.view);
        if (!view) return { landed: 'no editor view' };
        const head = view.state.selection.main.head;
        return { landed: view.state.doc.lineAt(head).text, y: at.y, text: view.state.doc.toString() };
      },
      box
    );
  };

  for (const [file, name, waitMs, source] of [
    ['click-diagram.md', 'below a diagram', 2500, CLICK_DIAGRAM],
    // Again, later: the first reading could be a race that time would settle, and this is
    // what says it is not. The original fault was unchanged at eight seconds.
    ['click-diagram.md', 'below a diagram, eight seconds in', 8000, CLICK_DIAGRAM],
    // Two diagrams is where the error would accumulate if it were a drift. Measured with the
    // re-measure taken out, this one still lands: the second diagram's own measurement happens
    // to catch the first. So it is a case that must not break rather than one that discriminates.
    ['click-two.md', 'below two diagrams', 3500, CLICK_TWO],
    ['click-table.md', 'below a table', 2000, CLICK_TABLE],
    ['click-plain.md', 'below a paragraph', 1500, CLICK_PLAIN],
  ]) {
    const got = await clickTarget(file, waitMs);
    console.log(`  a click on "Target line." ${name}: the caret landed on ${JSON.stringify(got.landed)}`);
    if (got.landed !== 'Target line.') {
      failures.push(
        `a click on the middle of "Target line." ${name} put the caret on ${JSON.stringify(got.landed)}.\n` +
          `    The drawing is right and the editor's height map is not: a person clicks where they want to type\n` +
          `    and starts typing somewhere else.`
      );
    }
    // This is geometry, so the file is never touched by looking at it or clicking in it.
    if (got.text !== undefined && got.text !== source) {
      failures.push(`the file changed while clicking ${name}: ${JSON.stringify(got.text)}`);
    }
  }

  // And the keyboard, which reads the same map: every line in order, from the top.
  await page.goto(`${base}/edit/click-diagram.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await page.waitForTimeout(2500);
  const walked = await page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    const tile = content && (content.cmTile || content.cmView);
    const view = tile && ((tile.root && tile.root.view) || tile.view);
    if (!view) return null;
    view.dispatch({ selection: { anchor: 0 } });
    view.focus();
    return true;
  });
  if (walked) {
    const seen = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('ArrowDown');
      seen.push(
        await page.evaluate(() => {
          const content = document.querySelector('.cm-content');
          const tile = content && (content.cmTile || content.cmView);
          const view = tile && ((tile.root && tile.root.view) || tile.view);
          return view.state.doc.lineAt(view.state.selection.main.head).number;
        })
      );
    }
    console.log(`  arrowing down from the first line reached lines ${seen.join(',')}`);
    if (!seen.includes(8) || !seen.includes(10)) {
      failures.push(
        `arrowing down from the top reached lines ${seen.join(',')}, missing the line under the diagram.\n` +
          `    The keyboard reads the same height map the pointer does.`
      );
    }
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} diagram measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log('\ndiagrams draw, and a fence that cannot parse says so instead.');
