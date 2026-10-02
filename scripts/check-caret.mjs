/*
 * Where the arrow keys put the caret, and what the next keystroke then writes.
 *
 *   node scripts/check-caret.mjs
 *
 * A heading's `# ` and a quote's `>` are hidden, so a line has two positions drawn in
 * the same place: in front of the marker and at the start of the words. Only one of them
 * is safe to type in. Which one an arrow key lands on is a question about what is drawn
 * and where, so jsdom cannot answer it: it has no layout, and the hidden markers are
 * hidden by decorations whose geometry is the whole point. It is measured here instead,
 * in Chromium against Sheaf's own local server.
 *
 * Every case ends by typing one letter and reading the file, because the position itself
 * is invisible and the file is the only place the difference shows. A check that only
 * asked where the caret was would have to trust the same geometry it is testing.
 *
 * Three of the cases are controls, and they are what stop this passing for the wrong
 * reason: Left in the middle of a word, Left at the start of a paragraph that has no
 * marker, and Right onto a heading's words. A fix that simply swallowed Left would pass
 * every other case here and fail those.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When either
 * is missing this says so and exits 0, because a missing browser is not a broken
 * document. A measurement that actually runs and disagrees fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

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

/**
 * Each case: the document, the line whose words the caret starts in, the keys pressed
 * before typing, and the line the file must hold afterwards.
 *
 * `keys` always begins with Home, which goes to the start of the words. The `d` typed at
 * the end is the probe: where it lands says which position the caret was really in.
 */
const CASES = [
  {
    what: 'Left at the start of a heading on the first line stays out of the marker',
    doc: '# Welcome to Sheaf\n\nBody text here.\n',
    words: 'Welcome to Sheaf',
    keys: ['Home', 'ArrowLeft'],
    wants: '# dWelcome to Sheaf',
    why: 'there is no line above, so the caret stays on the words',
  },
  {
    // No blank line between them, which a heading does not need: it interrupts a
    // paragraph. That makes the line above the heading a line with words on it, so what
    // Left reaches is unambiguous. With a blank separator in between, Left correctly
    // reaches the blank line, which says less.
    what: 'Left at the start of a heading goes to the end of the line above',
    doc: 'Body above.\n## Second section\n\nBody below.\n',
    words: 'Second section',
    keys: ['Home', 'ArrowLeft'],
    wants: 'Body above.d',
    why: 'the end of the line above is where Left at the start of a line means',
  },
  {
    what: 'Left at the start of a quote leaves the marker alone',
    doc: 'Body above.\n\n> A quoted line.\n',
    words: 'A quoted line.',
    keys: ['Home', 'ArrowLeft'],
    wants: '> A quoted line.',
    why: 'the quote survives: the letter must not land between the > and its space',
  },
  {
    what: 'Left twice from a heading crosses the blank line and reaches the words above',
    doc: 'Body above.\n\n## Second section\n',
    words: 'Second section',
    keys: ['Home', 'ArrowLeft', 'ArrowLeft'],
    wants: 'Body above.d',
    why: 'the first Left reaches the blank separator, the second the line above it',
  },
  {
    what: 'CONTROL: Left in the middle of a heading still moves one character',
    doc: '# Welcome to Sheaf\n',
    words: 'Welcome to Sheaf',
    keys: ['Home', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft'],
    wants: '# WedlcomeERASEto Sheaf'.replace('ERASE', ' '),
    why: 'a fix that swallowed Left everywhere would fail here',
  },
  {
    what: 'CONTROL: Left at the start of a paragraph, which has no marker, is unchanged',
    doc: 'Body above.\nA plain paragraph.\n',
    words: 'A plain paragraph.',
    keys: ['Home', 'ArrowLeft'],
    wants: 'Body above.d',
    why: 'this case never went through a marker, and must behave exactly as it always did',
  },
  {
    what: 'Right from the end of the line above lands on the heading words, not in its marker',
    doc: 'Body above.\n## Second section\n',
    words: 'Body above.',
    keys: ['End', 'ArrowRight'],
    wants: '## dSecond section',
    why: 'the position in front of a marker must not be reachable forwards either',
  },
  /*
   * Up and Down, which are the two routes no key binding covers.
   *
   * Left and Right are answered by bindings that know where a marker is. Vertical
   * motion is not: it lands on whatever column the geometry gives it, and in front
   * of a hidden marker that is the same x as the start of the words. The selection
   * filter in `lineStart.ts` is the only thing holding these, and nothing else in
   * the repository can see it work. The editing matrix cannot: jsdom has no layout,
   * so its arrow walk never presses Up at all, and removing the filter altogether
   * leaves that matrix byte-for-byte identical. These two cases are the whole of the
   * evidence that it does anything, and without them it would be unprotected code
   * that looks protected.
   *
   * This is the route the defect was originally reported through: put the caret at
   * the left edge of a heading, press Enter, press Up, type.
   */
  {
    what: 'Up onto a heading lands on its words rather than in front of its marker',
    doc: 'Body above.\n\n## Second section\n\nBody below.\n',
    words: 'Body below.',
    keys: ['Home', 'ArrowUp', 'ArrowUp'],
    wants: '## dSecond section',
    why: 'the route the defect was reported through, and the only one no binding covers',
  },
  {
    what: 'Down onto a heading lands on its words rather than in front of its marker',
    doc: 'Body above.\n\n## Second section\n\nBody below.\n',
    words: 'Body above.',
    keys: ['Home', 'ArrowDown', 'ArrowDown'],
    wants: '## dSecond section',
    why: 'vertical motion reaches the bad position from both sides, as Left and Right did',
  },
  /*
   * The other end of a line, where the hidden marker is a hard break.
   *
   * A heading's marker is in front of the words and a hard break's is behind them, so End
   * is to a break what Home is to a heading: the key that lands on the far side of
   * something drawn as nothing. Both spellings of a break are hidden, so the end of the
   * line and the end of the words are one place on the screen, and only one of them is
   * safe to type in.
   *
   * This is the half of the document the first nine cases never reached, and it is worth
   * measuring here rather than only in jsdom for the reason the file's header gives: what
   * makes the two positions indistinguishable is that the marker is drawn as nothing, and
   * a check with no layout cannot see that it is.
   */
  {
    what: 'End on a line ending in a backslash break keeps the break',
    doc: 'A line ending in a break\\\nand the line after it.\n',
    words: 'A line ending in a break',
    keys: ['End'],
    wants: 'A line ending in a breakd\\',
    why: 'the backslash is the form Shift+Enter writes, so typing past it undoes Sheaf\'s own work',
  },
  {
    what: 'End on a line ending in a two-space break keeps the break',
    doc: 'A line ending in a break  \nand the line after it.\n',
    words: 'A line ending in a break',
    keys: ['End'],
    // Written as a join so the two trailing spaces cannot be lost to a tidying editor.
    wants: 'A line ending in a breakd' + '  ',
    why: 'the spaces stop being trailing the moment a character lands after them',
  },
  {
    what: 'CONTROL: End on a plain line writes at the end of its words',
    doc: 'A line ending in a word\nand the line after it.\n',
    words: 'A line ending in a word',
    keys: ['End'],
    wants: 'A line ending in a wordd',
    why: 'a fix that moved every End back a character would fail here',
  },
  {
    what: 'CONTROL: End on a line with one trailing space, which is no break, writes past it',
    doc: 'A line ending in a space \nand the line after it.\n',
    words: 'A line ending in a space',
    keys: ['End'],
    wants: 'A line ending in a space d',
    why: 'one space is not a break, so nothing is hidden and the character belongs at the end',
  },
];

/**
 * Which line of the file the caret is on, read from the line-number gutter rather than
 * inferred from the shape of the document. The gutter's first element is a hidden
 * zero-height spacer carrying a number of its own, level with the first line, and taken
 * for a line number it reported 999 on a 400-line document.
 */
const caretLine = (page) =>
  page.evaluate(() => {
    const s = getSelection();
    const el = s?.anchorNode ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) : null;
    const line = el?.closest?.('.cm-line');
    if (!line) return null;
    const top = line.getBoundingClientRect().top;
    const g = [...document.querySelectorAll('.cm-gutterElement')]
      .filter((e) => e.getBoundingClientRect().height > 0)
      .find((e) => Math.abs(e.getBoundingClientRect().top - top) < 2);
    const n = g ? Number(g.textContent.trim()) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    // The caret's own y, from the cursor Sheaf draws. The *line's* box was the first thing
    // tried and it cannot see this: a wrapped paragraph is one element spanning every row,
    // so its top is the same on every row and four presses read as four no-ops.
    const drawn = document.querySelector('.cm-cursor-primary') ?? document.querySelector('.cm-cursor');
    if (!drawn) return null;
    return { line: n, y: Math.round(drawn.getBoundingClientRect().top) };
  });

/**
 * Waits until a line whose drawn text starts with `words` is on the page, and says whether
 * it arrived. The ceiling is generous because a needless failure here costs a whole gate
 * run, and it is a ceiling rather than a wait: the normal case returns on the first ask.
 */
async function drawn(page, words) {
  const until = Date.now() + 15_000;
  for (;;) {
    const there = await page.evaluate(
      (w) => [...document.querySelectorAll('.cm-line')].some((l) => l.textContent.trim().startsWith(w)),
      words
    );
    if (there) return true;
    if (Date.now() > until) return false;
    await page.waitForTimeout(150);
  }
}

/** The caret's line after each of `count` presses of `key`. */
async function walk(page, key, count) {
  const seen = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(70);
    seen.push(await caretLine(page));
  }
  return seen;
}

const root = mkdtempSync(join(tmpdir(), 'sheaf-caret-'));
const file = join(root, 'c.md');
// Line numbers on, so the caret's line is read rather than inferred.
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.lineNumbers': true }, null, 2));
// Headings on lines 4k+1, paragraphs on 4k+3, blank separators on the even lines. That
// makes the blank above each heading, which is the line Up used to skip, a quarter of the
// file, and the line numbers say immediately which kind was missed.
const SECTION = (n) => `## Section ${n}\n\nParagraph ${n} of this document holds one short sentence.`;
writeFileSync(join(root, 'mixed.md'), Array.from({ length: 200 }, (_, i) => SECTION(i + 1)).join('\n\n') + '\n');
// One paragraph long enough to wrap to many rows in a 708px column.
const SENTENCE = (n) => `sentence number ${n} in a single very long paragraph that must wrap`;
writeFileSync(join(root, 'wrapped.md'), Array.from({ length: 40 }, (_, i) => SENTENCE(i + 1)).join(', ') + '.\n');
const { server, base } = await serveForCheck({ repo: REPO, root });
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

try {
  const page = await browser.newPage({ viewport: VIEW });
  for (const c of CASES) {
    writeFileSync(file, c.doc);
    await page.goto(`${base}/edit/c.md`);
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await page.waitForTimeout(1000);
    // Put the caret inside the named line's drawn words, one character in, so `Home` has
    // somewhere to come back from and the line is unambiguously the active one.
    //
    // Polled rather than slept on. A fixed wait passed every time this was run on its own
    // and failed inside `npm run gates`, where the machine has just finished the suites,
    // the build and three browser checks: seven cases reported "the line was not drawn",
    // which reads as a defect and was a clock. Asking for the line until it is there costs
    // nothing when it is already drawn.
    const placed = await drawn(page, c.words);
    if (!placed) {
      failures.push(`${c.what}\n    the line starting ${JSON.stringify(c.words)} was never drawn, so nothing was measured`);
      continue;
    }
    await page.evaluate((words) => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.trim().startsWith(words));
      if (!line) return false;
      const node = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
      if (!node) return false;
      const r = document.createRange();
      r.setStart(node, Math.min(1, node.data.length));
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    }, c.words);
    await page.waitForTimeout(200);
    for (const key of c.keys) await page.keyboard.press(key);
    await page.keyboard.type('d');
    await page.waitForTimeout(1400);
    const after = readFileSync(file, 'utf8');
    if (!after.split('\n').includes(c.wants)) {
      failures.push(
        `${c.what}\n    wanted a line ${JSON.stringify(c.wants)} (${c.why})\n    file holds ${JSON.stringify(after)}`
      );
    } else {
      console.log(`  ok  ${c.what}`);
    }
  }
  // ---- Up and Down visit the same lines in both directions -----------------------
  //
  // Up used to skip the blank line above every heading, so one line in four could not be
  // reached going up and Up then Down did not return. The test is symmetry rather than a
  // list of expected numbers, because the numbers depend on the document and symmetry is
  // the property a reader has.
  await page.goto(`${base}/edit/mixed.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  if (!(await drawn(page, 'Section 1'))) failures.push('mixed.md never drew its first heading, so the arrow symmetry was not measured');
  await page.click('.cm-content');
  // Start well inside the document so neither end clamps.
  await walk(page, 'ArrowDown', 40);
  const STEPS = 20;
  const down = await walk(page, 'ArrowDown', STEPS);
  const up = await walk(page, 'ArrowUp', STEPS);
  const lines = (w) => w.map((s) => (s ? s.line : null));
  const downLines = lines(down);
  const upLines = lines(up);
  console.log(`  down ${JSON.stringify(downLines)}`);
  console.log(`  up   ${JSON.stringify(upLines)}`);
  if (downLines.includes(null) || upLines.includes(null)) {
    failures.push('the caret line could not be read from the gutter, so the arrow symmetry was not measured at all');
  } else {
    // Coming back up must retrace the way down: the lines seen going up are the ones seen
    // going down, in reverse, ending where the walk began.
    const wanted = [...downLines.slice(0, -1).reverse(), downLines[0] - 1];
    if (JSON.stringify(upLines) !== JSON.stringify(wanted)) {
      const skipped = downLines.filter((n) => !upLines.includes(n) && n !== downLines.at(-1));
      failures.push(
        `Up did not retrace Down.\n    down ${JSON.stringify(downLines)}\n    up   ${JSON.stringify(upLines)}\n` +
          `    wanted ${JSON.stringify(wanted)}${skipped.length ? `\n    lines Down visited that Up never did: ${JSON.stringify(skipped)}` : ''}`
      );
    } else {
      console.log(`  ok  Up retraces Down over ${STEPS} presses, visiting every line both ways`);
    }
  }

  // CONTROL. Inside one long wrapped paragraph, Down moves by drawn rows and stays on the
  // same line of the file. A fix that stepped by lines of the file instead of rows would
  // jump the whole paragraph here, and every case above would still pass.
  await page.goto(`${base}/edit/wrapped.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  if (!(await drawn(page, 'sentence number 1'))) failures.push('wrapped.md never drew its paragraph, so the row control was not measured');
  await page.click('.cm-content');
  const rows = await walk(page, 'ArrowDown', 4);
  const onOneLine = rows.every((r) => r && r.line === 1);
  const movedDown = rows.length > 1 && rows.at(-1).y > rows[0].y;
  console.log(`  rows within one wrapped paragraph: ${JSON.stringify(rows)}`);
  if (!onOneLine || !movedDown) {
    failures.push(
      `CONTROL: inside one wrapped paragraph, four Downs should stay on line 1 and move down the screen. ` +
        `Got ${JSON.stringify(rows)}, which means a row step is being read as a line of the file.`
    );
  } else {
    console.log(`  ok  CONTROL: Down inside a wrapped paragraph moves by rows, not by lines of the file`);
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} of ${CASES.length} caret measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log(`\n${CASES.length} caret positions measured by what the next keystroke wrote, controls included.`);
