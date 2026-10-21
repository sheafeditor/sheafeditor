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
 * Five surfaces, at two viewport heights, before and after focus:
 *
 *   - a `field` with no height of its own, which is what the integration instructions tell a
 *     consumer to write;
 *   - the same at the 280px width a form gives a control, because the side gutters are a
 *     proportion of the window rather than of the field and only a narrow one shows what they cost;
 *   - the same again carrying the two properties the instructions name for the side inset;
 *   - a `notes` surface in a 320px box, which is the other half of the same instructions;
 *   - a `document`, the profile the extension itself runs, served by Sheaf's own local server.
 *
 * The last two are the control. All three profiles share one `.cm-scroller` padding declaration in
 * `src/webview/theme.ts`, so the way to get the field wrong is to flatten the writing column for
 * everybody. `notes` and `document` must keep the page inset and the room to scroll past the last
 * line, and this fails if either moves.
 *
 * Every row is printed with its numbers rather than a verdict. A line reading "the field is the
 * right height" cannot be read by somebody checking whether the run measured anything.
 *
 * ## The two viewport heights are not a repetition
 *
 * The bottom inset is `40vh`, so a surface carrying it is a different height on a laptop and on a
 * monitor. Reading one viewport cannot tell a fixed 400px from a proportion of the window, and the
 * fault this check exists for was first reported as two numbers, 480 and 640, which is what gave
 * the cause away.
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
 * 900 pixels wide, because the side gutters are `8vw` and the fault was reported at a 72px gutter.
 * The heights are a laptop and a monitor, far enough apart that `40vh` between them is 160px.
 */
const WIDTH = 900;
const HEIGHTS = [1000, 1400];

/** The box the instructions tell a consumer to give a `notes` surface. */
const NOTES_BOX = 320;

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
  /* The two properties src/lib/README.md tells a consumer to set for the side inset. */
  #styled .sheaf-surface-field { --md-gutter: 0px; --md-content-width: 100%; }
  #notes { height: ${NOTES_BOX}px; }
</style>
</head>
<body>
<div id="wide"></div>
<div id="narrow"></div>
<div id="styled"></div>
<div id="notes"></div>
<script type="module">
import { mount } from '/lib/index.js';
const title = 'Ship the **field** fix';
window.sheaf = {
  wide: mount(document.getElementById('wide'), { value: title, profile: 'field' }),
  narrow: mount(document.getElementById('narrow'), { value: title, profile: 'field' }),
  styled: mount(document.getElementById('styled'), { value: title, profile: 'field' }),
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
 */
function readSurface(id) {
  const outer = document.getElementById(id);
  const el = outer.firstElementChild;
  const scroller = el && el.querySelector('.cm-scroller');
  const content = el && el.querySelector('.cm-content');
  const line = el && el.querySelector('.cm-line');
  const box = (n) => (n ? Math.round(n.getBoundingClientRect().height * 100) / 100 : null);
  const left = (n) => (n && el ? Math.round(n.getBoundingClientRect().left - el.getBoundingClientRect().left) : null);
  return {
    outer: box(outer),
    element: box(el),
    editing: !!window.sheaf[id].editing(),
    scrollerPadding: scroller ? getComputedStyle(scroller).padding : null,
    contentPadding: content ? getComputedStyle(content).padding : null,
    textLeft: left(line),
  };
}

/** The same reading of the extension's own editor, which fills the page rather than an element. */
function readDocument() {
  const scroller = document.querySelector('.cm-scroller');
  const content = document.querySelector('.cm-content');
  const editor = document.querySelector('.cm-editor');
  const line = document.querySelector('.cm-line');
  const box = (n) => (n ? Math.round(n.getBoundingClientRect().height * 100) / 100 : null);
  return {
    outer: box(editor),
    element: box(editor),
    editing: true,
    scrollerPadding: getComputedStyle(scroller).padding,
    contentPadding: getComputedStyle(content).padding,
    textLeft: line ? Math.round(line.getBoundingClientRect().left - editor.getBoundingClientRect().left) : null,
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
  for (const height of HEIGHTS) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height } });
    await page.goto(libBase);
    await page.waitForFunction('window.sheafReady === true');
    await page.evaluate(settle);

    for (const id of ['wide', 'narrow', 'styled', 'notes']) {
      rows.push({ profile: id, height, state: 'rendered', ...(await page.evaluate(readSurface, id)) });
    }

    for (const id of ['wide', 'narrow', 'styled', 'notes']) {
      await page.evaluate((which) => window.sheaf[which].focus(), id);
      await page.waitForFunction((which) => window.sheaf[which].editing() === true, id);
    }
    await page.evaluate(settle);

    for (const id of ['wide', 'narrow', 'styled', 'notes']) {
      rows.push({ profile: id, height, state: 'editor', ...(await page.evaluate(readSurface, id)) });
    }
    await page.close();
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
  for (const height of HEIGHTS) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height } });
    await page.goto(`${docBase}/edit/doc.md`);
    await page.waitForSelector('.cm-content');
    await page.evaluate(settle);
    rows.push({ profile: 'document', height, state: 'editor', ...(await page.evaluate(readDocument)) });
    await page.close();
  }
} finally {
  docServer.kill('SIGKILL');
  await browser.close();
}

for (const r of rows) {
  console.log(
    `${r.profile.padEnd(8)} ${String(r.height).padStart(4)}px viewport  ${r.state.padEnd(8)}` +
      `  element ${String(r.element).padStart(7)}px  outer ${String(r.outer).padStart(7)}px` +
      `  scroller padding ${String(r.scrollerPadding ?? '-').padEnd(18)}` +
      `  content padding ${String(r.contentPadding ?? '-').padEnd(12)}` +
      `  text starts ${String(r.textLeft ?? '-').padStart(4)}px in`
  );
}

const pick = (profile, state, height) => rows.find((r) => r.profile === profile && r.state === state && r.height === height);

const FIELDS = ['wide', 'narrow', 'styled'];

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
  for (const height of HEIGHTS) {
    const r = pick(id, 'editor', height);
    if (!r.editing || r.scrollerPadding === null) {
      faults.push(`the ${id} surface at a ${height}px viewport has no editor behind it, so nothing below it was measured`);
    }
  }
}

/* 1. A focused field is one line, at any width and in any window. */
for (const id of FIELDS) {
  for (const height of HEIGHTS) {
    const r = pick(id, 'editor', height);
    if (r.element > FIELD_CEILING) {
      faults.push(`the ${id} field is ${r.element}px tall at a ${height}px viewport, over the ${FIELD_CEILING}px a one-line surface may be, with its scroller padded ${r.scrollerPadding}`);
    }
  }
}

/* 2. And it is the same height whatever the window is, which is what says no `vh` is left in it. */
for (const id of FIELDS) {
  const [a, b] = HEIGHTS.map((h) => pick(id, 'editor', h));
  if (a.element !== b.element) {
    faults.push(`the ${id} field is ${a.element}px at a ${HEIGHTS[0]}px viewport and ${b.element}px at a ${HEIGHTS[1]}px one, so its height still follows the window`);
  }
}

/* 3. Clicking into a field does not resize the form around it. */
for (const id of FIELDS) {
  for (const height of HEIGHTS) {
    const before = pick(id, 'rendered', height);
    const after = pick(id, 'editor', height);
    const jump = Math.abs(after.outer - before.outer);
    if (jump > 8) {
      faults.push(`the ${id} field jumps from ${before.outer}px to ${after.outer}px on first focus at a ${height}px viewport, a ${jump}px move of everything under it`);
    }
  }
}

/*
 * 4. The side inset a consumer can take off themselves, which is the one thing
 * `src/lib/README.md` now tells them to set. It is checked here because a sentence in a public
 * document telling somebody to write two declarations should be a sentence somebody has run.
 */
for (const height of HEIGHTS) {
  const r = pick('styled', 'editor', height);
  if (r.textLeft !== 0) {
    faults.push(`a field carrying the two properties the instructions name starts its text ${r.textLeft}px in rather than at its own left edge, so the instructions are wrong`);
  }
}

/*
 * 5. The control. `notes` and `document` keep the writing column: the page inset above the first
 * line, and the room to scroll past the last one, which is a proportion of the window and so
 * differs between the two viewports.
 */
for (const profile of ['notes', 'document']) {
  for (const height of HEIGHTS) {
    const r = pick(profile, 'editor', height);
    const wants = `56px 0px ${Math.round(height * 0.4)}px`;
    if (r.scrollerPadding !== wants) {
      faults.push(`${profile} at a ${height}px viewport has its scroller padded ${r.scrollerPadding}, not the ${wants} of the writing column`);
    }
  }
}

if (faults.length) {
  console.log('');
  for (const f of faults) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('\nA field is one line at both viewport heights, and the writing column is where it was.');
