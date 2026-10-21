/*
 * How tall a one-line `field` surface is, measured in a browser.
 *
 *   node scripts/check-field-height.mjs
 *
 * A `field` is the library's one-line surface: a title, a form input. It renders as one line of
 * text, and the editor that replaces it on first focus has to be one line too, or clicking into a
 * form resizes the page around the caret.
 *
 * ## Why this cannot be a jsdom check
 *
 * jsdom has no layout, so every element it is asked about is zero pixels tall and an assertion
 * about a height passes against any stylesheet at all. The height here comes from `40vh` and a
 * `56px` page inset resolved by a layout engine, so a real browser is the only instrument that can
 * read it. A jsdom check in this place would be a check that cannot fail.
 *
 * ## What it reads, and why the numbers are printed
 *
 * Five surfaces, at two viewport heights and two viewport widths, before and after focus:
 *
 *   - a `field` with no height of its own, which is what the integration instructions tell a
 *     consumer to write;
 *   - the same at the 280px width a form gives a control, because a side inset that is a
 *     proportion of the window costs a narrow field most and only a narrow one shows it;
 *   - the same again carrying the two properties the instructions name for putting the writing
 *     column's inset *back*, which is the opposite of what they used to say;
 *   - the same in a box with a border and padding, styled the way a form field usually is, which
 *     is the only one of the four fields that can see spacing *around* the text at all (below);
 *   - a `notes` surface in a 320px box, which is the other half of the same instructions;
 *   - a `document`, the profile the extension itself runs, served by Sheaf's own local server.
 *
 * The last two are the control, and it is read as the column rather than as a height. All three
 * profiles share one `.cm-scroller` padding declaration and one `.cm-content` measure in
 * `src/webview/theme.ts`, so the way to get the field wrong is to flatten the writing column for
 * everybody. A height-only reading passes straight over that: a flattened column changes where the
 * text starts and how wide it runs without changing how tall one line is. So `notes` and
 * `document` are checked on `.cm-content`'s own padding and `max-width`, and a field on the width
 * its text is actually given.
 *
 * Every row is printed with its numbers rather than a verdict. A line reading "the field is the
 * right height" cannot be read by somebody checking whether the run measured anything.
 *
 * ## Neither pair of viewports is a repetition
 *
 * The bottom inset is `40vh`, so a surface carrying it is a different height on a laptop and on a
 * monitor. Reading one viewport cannot tell a fixed 400px from a proportion of the window, and the
 * fault this check exists for was first reported as two numbers, 480 and 640, which is what gave
 * the cause away.
 *
 * ## A bare box cannot see spacing around the text, which is why one of the five has a border
 *
 * The four surfaces above all sat in elements with no padding and no border, and that is a blind
 * spot rather than a simplification. A rendered field's text is a `<p>`, which takes the page's own
 * paragraph spacing, and a surface is not a block formatting context, so in a bare box those
 * margins collapse straight out through it into the surrounding layout: the element reports its one
 * line, the box reports the same, and nothing anywhere shows the spacing. Put a border or any
 * padding on the box and the collapse stops, the margins are held inside, and the box is suddenly
 * much taller than the line in it until the first click replaces the `<p>` with a `.cm-line` that
 * has no margin at all.
 *
 * Measured in this page: the boxed field reads 32px rendered against 38px as an editor, and 64px
 * against 38px with the paragraph spacing left in, so the box moved 26px the first time anybody
 * clicked a title. **Every reading taken in a bare box said a field does not change size**, which
 * is how that reached a public instruction, so the boxed one is the row that can fail.
 *
 * The side inset was `clamp(24px, 8vw, 96px)` and is now `0px` for a field, which is the same
 * shape of fault lying down: a field's usable text width tracked the window rather than the box it
 * was given, so a 280px control was left 136px of it at one window and 88px at another. **One
 * width cannot see that.** A single green number is exactly what a restored gutter would produce,
 * so the reading that catches it is the same field measured at two viewport widths and required to
 * come out the same. Static numbers are checked too, and they are the weaker half here.
 *
 * ## It needs a browser
 *
 * Chromium and `playwright-core`, same as the other browser checks here. When either is missing
 * this says so and exits 0, because a missing browser is not a broken editor. A measurement that
 * runs and disagrees fails.
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/*
 * The heights are a laptop and a monitor, far enough apart that `40vh` between them is 160px.
 *
 * The widths straddle the `clamp(24px, 8vw, 96px)` a `notes` surface still carries: 8vw is 72px at
 * the first and clamps to 96px at the second, so a side inset that is still a proportion of the
 * window reads as two different numbers across the pair and a field's own 0px reads as one. 900 is
 * also where the side-inset fault was reported, so the old measurement is still comparable.
 */
const WIDTHS = [900, 1300];
const HEIGHTS = [1000, 1400];

/** The gutter a surface that still carries the writing column gets at a given viewport width. */
const clampedGutter = (width) => Math.min(96, Math.max(24, width * 0.08));

/** The box the instructions tell a consumer to give a `notes` surface. */
const NOTES_BOX = 320;

/** Every surface the library page mounts, in the order they are read. */
const SURFACES = ['wide', 'narrow', 'styled', 'boxed', 'notes'];

/*
 * A second field at the width a form actually gives one.
 *
 * The page-wide field above is where the fault was reported, and on its own it cannot see what the
 * side gutters do: a field narrow enough to be a form control has `8vw` taken off each side of it,
 * and the text that no longer fits wraps, so the surface is two lines tall for a reason that has
 * nothing to do with the insets above and below. One width would have reported a one-line field.
 */
const NARROW = 280;

/*
 * The inset the instructions name for a consumer who wants the writing column's gap back.
 *
 * A fixed length rather than the clamp, because what the document offers a consumer is a gap they
 * chose; the clamp is the `document` profile's own and is the thing a field no longer inherits.
 */
const INSET = 24;

/*
 * The box a form gives a field, which is the one shape that can see spacing around the text.
 *
 * Border-box with a border and padding, as the fault was reported. The width is fixed so this row
 * is comparable across viewport widths like `narrow` is.
 */
const BOXED = { width: 772, padding: '6px 10px', border: 1 };

/*
 * What a focused `field` may be. One 24px line box, and room for a border or a pixel of rounding
 * on top of it. The rendered state before focus is 18px in this page, so this also bounds the jump
 * a person sees when they click in; the jump is checked on its own below.
 */
const FIELD_CEILING = 32;

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

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  skip('playwright-core is not installed; set PLAYWRIGHT_CORE to its folder');
}

/*
 * The library bundle has to be newer than the sources it is built from.
 *
 * `serve-for-check.mjs` makes this refusal for `media/webview.js` and `dist/serve.js`, and says at
 * length why: a browser page loads whatever was last built, so a control run against a stale bundle
 * passes and reads as the check being unable to catch anything. `lib/` is a third bundle that file
 * does not know about, and it is the one this check loads, so the same refusal is made here.
 */
function filesUnder(path) {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return [{ path, at: stat.mtimeMs }];
    return readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = join(e.parentPath ?? e.path, e.name);
        return { path: file, at: statSync(file).mtimeMs };
      });
  } catch {
    return [];
  }
}

const LIB = join(REPO, 'lib', 'index.js');
if (!existsSync(LIB)) {
  console.log('lib/index.js is not built, so there is no library surface to measure. Run npm run build.');
  process.exit(1);
}
const libAt = statSync(LIB).mtimeMs;
const newer = [join(REPO, 'src', 'lib'), join(REPO, 'src', 'webview'), join(REPO, 'media', 'webview.css')]
  .flatMap(filesUnder)
  .filter((f) => f.at > libAt)
  .sort((a, b) => b.at - a.at);
if (newer.length) {
  const names = newer.slice(0, 3).map((f) => f.path.slice(REPO.length + 1));
  console.log(
    `lib/index.js is older than ${newer.length} of the sources it is built from, ` +
      `${names.join(', ')}${newer.length > 3 ? ' and others' : ''}. Run npm run build.`
  );
  process.exit(1);
}

/*
 * The consumer's page, as the integration instructions describe it: both stylesheets, fields with
 * no height, and a `notes` surface in a box. The only styling here is what those instructions tell
 * a consumer to write, because the question is what following them gets them.
 */
const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/media/browser-theme.css">
<link rel="stylesheet" href="/media/webview.css">
<style>
  /* #wide gets no rule at all, which is what the instructions tell a consumer to give a field. */
  #narrow { width: ${NARROW}px; }
  /*
   * The two properties src/lib/README.md names for putting the writing column's inset back, for a
   * consumer who wants one. They are read inside a calc() in src/webview/theme.ts, so a value of
   * the wrong type here is dropped in silence; the document says so and this is that sentence,
   * run. A percentage on the gutter leaves the default in place and a "none" on the measure
   * removes it, which are opposite failures and neither announces itself.
   *
   * No backticks in this comment: it sits inside a template literal, and one ends the page.
   */
  #styled { width: ${NARROW}px; }
  #boxed {
    width: ${BOXED.width}px;
    padding: ${BOXED.padding};
    border: ${BOXED.border}px solid #888;
    box-sizing: border-box;
  }
  #styled .sheaf-surface-field { --md-gutter: ${INSET}px; --md-content-width: 708px; }
  #notes { height: ${NOTES_BOX}px; }
</style>
</head>
<body>
<div id="wide"></div>
<div id="narrow"></div>
<div id="styled"></div>
<div id="boxed"></div>
<div id="notes"></div>
<script type="module">
import { mount } from '/lib/index.js';
const title = 'Ship the **field** fix';
window.sheaf = {
  wide: mount(document.getElementById('wide'), { value: title, profile: 'field' }),
  narrow: mount(document.getElementById('narrow'), { value: title, profile: 'field' }),
  styled: mount(document.getElementById('styled'), { value: title, profile: 'field' }),
  boxed: mount(document.getElementById('boxed'), { value: title, profile: 'field' }),
  notes: mount(document.getElementById('notes'), { value: '# Notes\\n\\nA paragraph of prose.\\n', profile: 'notes' }),
};
window.sheafReady = true;
</script>
</body>
</html>
`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

/** Serves the built library and the stylesheets beside a page that mounts them. */
function serveLibrary() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (!/^\/(lib|media)\//.test(path) || path.includes('..')) {
      res.writeHead(404).end('no');
      return;
    }
    const file = join(REPO, path.slice(1));
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': `${TYPES[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/*
 * What is read back from one surface.
 *
 * The outer element is the consumer's own `<div>` and the inner one is the element `mount` created
 * inside it, because the two are not the same question: the inner one is what the editor sizes, and
 * the outer one is what moves the rest of the form. `padding` is asked for as the shorthand, which
 * is how the fault was reported.
 *
 * `textLeft` is the first line's own left edge rather than the content element's, because the two
 * differ by CodeMirror's own 6px and by the auto margins that centre the writing column, and the
 * question is where a reader sees the text start.
 *
 * `textWidth` is the same line's width, which is the quantity a side inset actually spends: a
 * field 280px wide whose text runs 136px has had 144px taken off it, and no height anywhere says
 * so. It is read off the line rather than computed from the gutter, because the gutter, the
 * measure and the auto margins all reach it and a derivation from one of the three would agree
 * with the stylesheet while disagreeing with the screen.
 *
 * `contentMaxWidth` is the measure as the engine resolved it, which is the other half of the
 * column and the one a `calc()` with an invalid term silently drops.
 */
function readSurface(id) {
  const outer = document.getElementById(id);
  const el = outer.firstElementChild;
  const scroller = el && el.querySelector('.cm-scroller');
  const content = el && el.querySelector('.cm-content');
  const line = el && el.querySelector('.cm-line');
  const box = (n) => (n ? Math.round(n.getBoundingClientRect().height * 100) / 100 : null);
  const wide = (n) => (n ? Math.round(n.getBoundingClientRect().width * 100) / 100 : null);
  const left = (n) => (n && el ? Math.round(n.getBoundingClientRect().left - el.getBoundingClientRect().left) : null);
  return {
    outer: box(outer),
    element: box(el),
    elementWidth: wide(el),
    editing: !!window.sheaf[id].editing(),
    scrollerPadding: scroller ? getComputedStyle(scroller).padding : null,
    contentPadding: content ? getComputedStyle(content).padding : null,
    contentMaxWidth: content ? getComputedStyle(content).maxWidth : null,
    textLeft: left(line),
    textWidth: wide(line),
  };
}

/** The same reading of the extension's own editor, which fills the page rather than an element. */
function readDocument() {
  const scroller = document.querySelector('.cm-scroller');
  const content = document.querySelector('.cm-content');
  const editor = document.querySelector('.cm-editor');
  const line = document.querySelector('.cm-line');
  const box = (n) => (n ? Math.round(n.getBoundingClientRect().height * 100) / 100 : null);
  const wide = (n) => (n ? Math.round(n.getBoundingClientRect().width * 100) / 100 : null);
  return {
    outer: box(editor),
    element: box(editor),
    elementWidth: wide(editor),
    editing: true,
    scrollerPadding: getComputedStyle(scroller).padding,
    contentPadding: getComputedStyle(content).padding,
    contentMaxWidth: getComputedStyle(content).maxWidth,
    textLeft: line ? Math.round(line.getBoundingClientRect().left - editor.getBoundingClientRect().left) : null,
    textWidth: wide(line),
  };
}

/** Two animation frames, which is what CodeMirror needs to have measured after a layout change. */
function settle() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
}

const rows = [];
const faults = [];

const { server: libServer, base: libBase } = await serveLibrary();
const browser = await chromium.launch({ executablePath: CHROME });

try {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(libBase);
      await page.waitForFunction('window.sheafReady === true');
      await page.evaluate(settle);

      for (const id of SURFACES) {
        rows.push({ profile: id, width, height, state: 'rendered', ...(await page.evaluate(readSurface, id)) });
      }

      for (const id of SURFACES) {
        await page.evaluate((which) => window.sheaf[which].focus(), id);
        await page.waitForFunction((which) => window.sheaf[which].editing() === true, id);
      }
      await page.evaluate(settle);

      for (const id of SURFACES) {
        rows.push({ profile: id, width, height, state: 'editor', ...(await page.evaluate(readSurface, id)) });
      }
      await page.close();
    }
  }
} finally {
  libServer.close();
}

/*
 * The `document` profile, which `mount` cannot reach: it is the extension's own editor, so it is
 * measured where it runs, in a page the local server renders.
 */
const root = mkdtempSync(join(tmpdir(), 'sheaf-field-height-'));
writeFileSync(join(root, 'doc.md'), '# A document\n\nA paragraph of prose, and another line under it.\n');
const { server: docServer, base: docBase } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'so the document profile was not measured and the control is missing',
});

try {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${docBase}/edit/doc.md`);
      await page.waitForSelector('.cm-content');
      await page.evaluate(settle);
      rows.push({ profile: 'document', width, height, state: 'editor', ...(await page.evaluate(readDocument)) });
      await page.close();
    }
  }
} finally {
  docServer.kill('SIGKILL');
  await browser.close();
}

for (const r of rows) {
  console.log(
    `${r.profile.padEnd(8)} ${String(r.width).padStart(4)}x${String(r.height).padEnd(4)}  ${r.state.padEnd(8)}` +
      `  element ${String(r.element).padStart(7)}px  outer ${String(r.outer).padStart(7)}px` +
      `  scroller padding ${String(r.scrollerPadding ?? '-').padEnd(18)}` +
      `  content padding ${String(r.contentPadding ?? '-').padEnd(12)}` +
      `  measure ${String(r.contentMaxWidth ?? '-').padEnd(9)}` +
      `  text starts ${String(r.textLeft ?? '-').padStart(4)}px in, runs ${String(r.textWidth ?? '-').padStart(7)}px` +
      `  of a ${String(r.elementWidth ?? '-').padStart(7)}px surface`
  );
}

const pick = (profile, state, height, width = WIDTHS[0]) =>
  rows.find((r) => r.profile === profile && r.state === state && r.height === height && r.width === width);

const FIELDS = ['wide', 'narrow', 'styled', 'boxed'];

/** The ones a consumer's own box has a fixed width for, so a reading is comparable across windows. */
const FIXED_WIDTH = ['narrow', 'styled', 'boxed'];

/** The ones whose text should start at the box's own edge and run all of it. */
const NO_INSET = ['wide', 'narrow', 'boxed'];

/*
 * 0. The precondition, asserted rather than written down.
 *
 * A surface nobody focused is a rendered string, 18px tall, with no `.cm-scroller` in it at all,
 * and it would satisfy every height assertion below while measuring nothing. The run waits on
 * `editing()` before reading, so today a surface that failed to build ends the run rather than
 * passing it, but that is a property of the waiting rather than of the checking. This says it where
 * the reading is used.
 */
for (const id of [...FIELDS, 'notes']) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const r = pick(id, 'editor', height, width);
      if (!r.editing || r.scrollerPadding === null) {
        faults.push(`the ${id} surface at ${width}x${height} has no editor behind it, so nothing below it was measured`);
      }
      if (r.textWidth === null || r.textWidth === 0) {
        faults.push(`the ${id} surface at ${width}x${height} has no drawn line to measure, so every width reading below it is vacuous`);
      }
    }
  }
}

/* 1. A focused field is one line, at any width and in any window. */
for (const id of FIELDS) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const r = pick(id, 'editor', height, width);
      if (r.element > FIELD_CEILING) {
        faults.push(`the ${id} field is ${r.element}px tall at ${width}x${height}, over the ${FIELD_CEILING}px a one-line surface may be, with its scroller padded ${r.scrollerPadding}`);
      }
    }
  }
}

/* 2. And it is the same height whatever the window is, which is what says no `vh` is left in it. */
for (const id of FIELDS) {
  for (const width of WIDTHS) {
    const [a, b] = HEIGHTS.map((h) => pick(id, 'editor', h, width));
    if (a.element !== b.element) {
      faults.push(`the ${id} field is ${a.element}px at a ${HEIGHTS[0]}px viewport and ${b.element}px at a ${HEIGHTS[1]}px one, ${width}px wide, so its height still follows the window`);
    }
  }
}

/* 3. Clicking into a field does not resize the form around it. */
for (const id of FIELDS) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const before = pick(id, 'rendered', height, width);
      const after = pick(id, 'editor', height, width);
      const jump = Math.abs(after.outer - before.outer);
      if (jump > 8) {
        faults.push(`the ${id} field jumps from ${before.outer}px to ${after.outer}px on first focus at ${width}x${height}, a ${jump}px move of everything under it`);
      }
    }
  }
}

/*
 * 4. A field's text starts at its own left edge and runs the width of the box.
 *
 * This is where the side inset used to go, and it is read as a width rather than as a position
 * because a position alone cannot tell an inset from a centred column: both move the text right,
 * and only one of them also takes room away.
 */
for (const id of NO_INSET) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const r = pick(id, 'editor', height, width);
      if (r.textLeft !== 0) {
        faults.push(`the ${id} field starts its text ${r.textLeft}px in from its own left edge at ${width}x${height}, so it is carrying a side inset`);
      }
      const lost = Math.round((r.elementWidth - r.textWidth) * 100) / 100;
      if (Math.abs(lost) > 8) {
        faults.push(`the ${id} field is ${r.elementWidth}px wide and gives its text ${r.textWidth}px of that at ${width}x${height}, ${lost}px spent on an inset or a measure`);
      }
    }
  }
}

/*
 * 5. The viewport reading, and it is the one that catches a restored gutter.
 *
 * A field's usable width must not follow the window. The inset this replaced was `clamp(24px, 8vw,
 * 96px)`, so a 280px control was given 136px of itself at one window and 88px at another, and
 * **either number read on its own looks like a field with an inset somebody chose.** The pair is
 * what says the inset is not the box's. `narrow`, `styled` and `boxed` are the ones with a width
 * of their own, so they are the ones whose text width is comparable across viewports at all;
 * `wide` fills the page and is meant to change.
 */
for (const id of FIXED_WIDTH) {
  for (const height of HEIGHTS) {
    const [a, b] = WIDTHS.map((w) => pick(id, 'editor', height, w));
    if (a.textWidth !== b.textWidth) {
      faults.push(
        `the ${id} field gives its text ${a.textWidth}px at a ${WIDTHS[0]}px window and ${b.textWidth}px at a ${WIDTHS[1]}px one, ` +
          `in a box that is ${a.elementWidth}px and ${b.elementWidth}px, so its usable width still follows the window`
      );
    }
  }
}

/*
 * 6. The inset a consumer can put back, which is what `src/lib/README.md` now offers them.
 *
 * Checked here because a sentence in a public document telling somebody to write two declarations
 * should be a sentence somebody has run, and because both of them are read inside a `calc()` where
 * a value of the wrong type is dropped in silence.
 */
for (const width of WIDTHS) {
  for (const height of HEIGHTS) {
    const r = pick('styled', 'editor', height, width);
    if (r.textLeft !== INSET) {
      faults.push(`a field carrying the inset the instructions name starts its text ${r.textLeft}px in rather than ${INSET}px at ${width}x${height}, so the instructions are wrong`);
    }
    const wants = NARROW - 2 * INSET;
    if (Math.abs(r.textWidth - wants) > 8) {
      faults.push(`a field carrying the inset the instructions name gives its text ${r.textWidth}px of its ${r.elementWidth}px box at ${width}x${height}, not the ${wants}px two ${INSET}px insets leave`);
    }
  }
}

/*
 * 7. The control. `notes` and `document` keep the writing column, and it is read as the column
 * rather than as a height: the page inset above the first line and the room to scroll past the
 * last one, which is a proportion of the window, and then the side gutters and the text measure,
 * which a height cannot see. Flattening the column for everybody is the way to get the field
 * right and the product wrong, and that is the shape this refuses.
 */
/*
 * A length read off the page, and `NaN` when what came back was not one.
 *
 * **The `NaN` has to be refused where it is used, because a comparison against it is `false` and a
 * `false` here means "no fault".** `max-width` computes to the keyword `none` when the measure is
 * gone, `parseFloat('none')` is `NaN`, and `Math.abs(NaN - 852) > 1` is `false`, so the assertion
 * below silently passed in exactly the case it exists for. That is not a hypothetical spelling:
 * the note on `.sheaf-surface-field` in `media/webview.css` singles `none` out as the value that
 * "would quietly remove the reading column" on a `notes` surface, so the one state this check is
 * here to catch was the one state it could not report. The two assertions beside this one compare
 * strings and fail correctly; only a number routed through `parseFloat` can go quiet this way.
 *
 * Measured both ways with `--md-content-width: none` on the `notes` fixture: without the finite
 * check the run exits 0 while the column is plainly gone, its text running 756px at a 900px window
 * and 1108px at a 1300px one against the 708px it should be; with it, four faults naming `none`.
 */
const px = (v) => parseFloat(String(v));
for (const profile of ['notes', 'document']) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const r = pick(profile, 'editor', height, width);
      const wants = `56px 0px ${Math.round(height * 0.4)}px`;
      if (r.scrollerPadding !== wants) {
        faults.push(`${profile} at ${width}x${height} has its scroller padded ${r.scrollerPadding}, not the ${wants} of the writing column`);
      }
      const gutter = clampedGutter(width);
      const wantsPad = `0px ${gutter}px`;
      if (r.contentPadding !== wantsPad) {
        faults.push(`${profile} at ${width}x${height} has its content padded ${r.contentPadding}, not the ${wantsPad} of the writing column's side gutters`);
      }
      const wantsMeasure = 708 + 2 * gutter;
      const measure = px(r.contentMaxWidth);
      if (!Number.isFinite(measure) || Math.abs(measure - wantsMeasure) > 1) {
        faults.push(`${profile} at ${width}x${height} measures ${r.contentMaxWidth}, not the ${wantsMeasure}px of a 708px column inside ${gutter}px gutters`);
      }
    }
  }
}

if (faults.length) {
  console.log('');
  for (const f of faults) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log(
  '\nA field is one line at both viewport heights, gives its text the whole box at both viewport widths,\n' +
    'and the writing column `notes` and `document` are written in is where it was.'
);
