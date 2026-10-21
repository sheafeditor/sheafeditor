/*
 * Where the caret lands on the first click into a mounted surface, measured in a real browser.
 *
 *   node scripts/check-mount-click.mjs
 *
 * A surface put in a page by `mount` is rendered HTML until somebody focuses it, and the focus is
 * what builds the editor. That makes the first click the whole gesture the arrangement is built
 * around, and the one click whose position has nowhere to go unless something carries it: the
 * focus event has no coordinates. It used to go nowhere, so a person's first sentence in a
 * description was inserted at the top of it however far down they had clicked, and every click
 * after that was correct.
 *
 * **The first click is measured against the text the person was looking at.** Before anything is
 * clicked, the browser is asked which character of the rendered surface is under the point, and
 * that text is found in the value. The caret has to land there. It is read from the page rather
 * than from anything Sheaf computes, which is what makes this a measurement rather than an opinion
 * about where a caret ought to be. The editor draws the value in a different place from the
 * rendered surface, so the same point is over different text in the two states, and comparing the
 * first click with a click into the built editor would compare two different targets.
 *
 * **A click into an editor that already exists is still in every case, as a control.** It is
 * converted by the editor's own layout and must still land somewhere the case recognises, so a fix
 * that moved the first click by breaking the second would fail here too.
 *
 * **Both numbers are printed, every run, pass or fail.** 0 is the answer the defect gives and 0 is
 * also the answer an unmeasured view gives, so a line reading "the caret moved correctly" cannot
 * be checked by the person reading it. Each case also refuses a control of 0 where 0 would make
 * the comparison vacuous, because two broken readings agree perfectly.
 *
 * The caret is read where it matters, which is where the person's text goes: the run types a
 * marker and reports the index it landed at in the value the consumer gets back.
 *
 * This measures the *library* host rather than the extension's own editor. jsdom cannot stand in
 * for it, having no layout at all, so the wiring half lives in the prose suite
 * (`test/prose/mountFocus.ts`) and the geometry half is here. It needs Chromium and
 * `playwright-core`, which a contributor may not have; when either is missing this says so and
 * exits 0, as the other browser-driven checks do.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  skip('playwright-core is not installed; set PLAYWRIGHT_CORE to its folder');
}

/*
 * The bundle this serves is built by somebody else, and a run against a stale one passes while
 * measuring bytes from before the edit under test, which reads as the check being unable to catch
 * anything. `serve-for-check.mjs` refuses for the same reason and says more about why; the sources
 * named here are the ones the library entries are built from. Modification times, not content, so
 * a branch switch that leaves a file byte-identical still asks for a build. Rebuilding costs
 * seconds and is the answer either way.
 */
const BUILT = join(REPO, 'lib', 'index.js');
if (!existsSync(BUILT)) {
  console.log('lib/index.js is not built, so there is no library to mount. Run npm run build.');
  process.exit(1);
}
const builtAt = statSync(BUILT).mtimeMs;
const newer = [join(REPO, 'src', 'lib'), join(REPO, 'src', 'render'), join(REPO, 'src', 'webview'), join(REPO, 'src', 'dialect')]
  .flatMap((dir) => {
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath ?? e.path, e.name));
    } catch {
      return [];
    }
  })
  .filter((f) => statSync(f).mtimeMs > builtAt);
if (newer.length) {
  console.log(
    `lib/index.js is older than ${newer.length} of the sources it is built from, ` +
      `${newer.slice(0, 3).map((f) => f.slice(REPO.length + 1)).join(', ')}${newer.length > 3 ? ' and others' : ''}. ` +
      'Run npm run build.'
  );
  process.exit(1);
}

/** Three paragraphs of prose, which is what a description holds. */
const PROSE = [
  'The first paragraph of a description, long enough to wrap once or twice in a',
  'narrow box so that a click ninety pixels down has real text under it.',
  '',
  'A second paragraph, so a click in the middle of the surface lands in the middle',
  'of the value rather than inside the only line there is.',
  '',
  'A third paragraph, for the same reason.',
  '',
].join('\n');

/**
 * A short first line, then prose long enough to make the rendered surface tall.
 *
 * The short line is the point: every wrapped line of a paragraph fills the column, so a click past
 * the end of the text needs a line that does not.
 */
const SHORT_FIRST = [
  'Short line.',
  '',
  'A long second paragraph that wraps across the narrow box several times so that there is plenty',
  'of text below the first line and the surface is tall enough when it is rendered as ordinary HTML.',
  '',
].join('\n');

/** A construct the render path draws rather than lays out as prose, with prose on both sides. */
const FENCED = ['A line before the fence.', '', '```js', 'const a = 1;', 'const b = 2;', 'const c = 3;', '```', '', 'After.', ''].join('\n');

/**
 * One line of inline Markdown for the `field` profile, longer than the box.
 *
 * A `field` is one line in both states and a value too long for it runs on past the right edge, so
 * the click has to be on that one line, a few pixels down, and on a word left of the edge.
 */
const FIELD =
  'A single line of **inline** Markdown that runs on for longer than the four hundred pixel box it is mounted in, past the right edge.';

/**
 * The box a surface is mounted in: fixed, so a click lands at the same point in every state.
 *
 * The height is given to a `notes` element and withheld from a `field`, which is what
 * `src/lib/README.md` tells a consumer to do: a `notes` surface does not size itself to its
 * content and a `field` is one line.
 */
const BOX = { width: 420, height: 320 };

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

/*
 * The page, which is a consumer's page and nothing more: the two stylesheets the instructions
 * name, an element with a height, and `mount`. `make` replaces the surface between cases so each
 * measurement starts from a mount nobody has touched.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/media/browser-theme.css">
<link rel="stylesheet" href="/media/webview.css">
<style>
  body { margin: 0; padding: 40px; }
  #host { width: ${BOX.width}px; }
</style>
<div id="host"></div>
<script type="module">
  import { mount } from '/lib/index.js';
  window.make = (value, profile) => {
    window.surface?.destroy();
    const host = document.getElementById('host');
    host.style.height = profile === 'field' ? '' : '${BOX.height}px';
    window.surface = mount(host, { value, profile });
  };
</script>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    return;
  }
  const file = join(REPO, path.replace(/^\/+/, ''));
  if (!file.startsWith(REPO + '/') || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('not here');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const complaints = [];
page.on('pageerror', (e) => complaints.push(`page error: ${e.message}`));
page.on('requestfailed', (r) => complaints.push(`request failed: ${r.url()}`));
page.on('response', (r) => void (r.status() >= 400 && complaints.push(`${r.status()} for ${r.url()}`)));
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.make);

/**
 * Mount `value`, click one screen point, type `marker`, and say where in the value it went.
 *
 * `at` is an absolute point in the page rather than an offset into the surface, and that is
 * deliberate: **the two states do not put the surface in the same place.** The rendered element's
 * first block has a top margin that collapses out through the consumer's box, so the surface sits
 * 16px lower before the editor exists than after. An offset measured in each state separately is
 * two different screen points, and the first version of this check compared one with the other and
 * reported a disagreement that was its own. Absent `at`, this measures the point in the state it
 * finds, which is the rendered one, and returns it for the control to reuse.
 *
 * `alreadyEditing` focuses the surface before the click, which is the control: the editor exists,
 * so the click is an ordinary one into a live view. Left off, the click is the one that builds it.
 */
async function probe({ value, profile, dx, dy, marker, alreadyEditing, at }) {
  await page.evaluate(([v, p]) => window.make(v, p), [value, profile]);
  const rendered = await page.locator('#host').boundingBox();
  const point = at ?? { x: Math.round(rendered.x + dx), y: Math.round(rendered.y + dy) };
  /*
   * What the rendered surface has under the point, read before anything is clicked, as the source
   * text either side of the browser's own caret position there. It is read from the page and not
   * from anything Sheaf computes, so it is the ground truth the first click is compared with.
   */
  const under = alreadyEditing
    ? null
    : await page.evaluate(([x, y]) => {
        const pos = document.caretPositionFromPoint(x, y);
        const host = document.getElementById('host');
        if (!pos || pos.offsetNode.nodeType !== 3 || !host.contains(pos.offsetNode)) return null;
        const data = pos.offsetNode.data;
        return { before: data.slice(Math.max(0, pos.offset - 16), pos.offset), after: data.slice(pos.offset, pos.offset + 16) };
      }, [point.x, point.y]);
  if (alreadyEditing) {
    await page.evaluate(() => window.surface.focus());
    await page.waitForFunction(() => window.surface.editing());
  }
  const was = await page.evaluate(() => window.surface.editing());
  await page.mouse.click(point.x, point.y);
  const built = await page
    .waitForFunction(() => window.surface.editing(), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!built) return { index: null, editingBefore: was, point, under, why: 'the click focused nothing, so no editor was built' };
  // A frame, so a position that had to wait for a measure has arrived before the typing does.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.type(marker);
  const typed = await page
    .waitForFunction((m) => window.surface.value().includes(m), marker, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!typed) return { index: null, editingBefore: was, point, under, why: `typing ${marker} reached no document` };
  const index = await page.evaluate((m) => window.surface.value().indexOf(m), marker);
  return { index, editingBefore: was, point, under };
}

/**
 * The source index the rendered text under a point names, or `null` with the reason.
 *
 * The text after the point is looked for in the value when there is any, which is a click on a
 * character; the text before it when there is none, which is a click past the end of a line and
 * names the end of that line. A context string found twice in the value is refused rather than
 * guessed between, so a fixture that repeats itself fails loudly here.
 */
function sourceIndex(value, under) {
  if (!under) return { index: null, why: 'the rendered surface had no text under the point' };
  const unique = (s) => s && value.indexOf(s) >= 0 && value.indexOf(s) === value.lastIndexOf(s);
  if (under.after.trim() && unique(under.after)) return { index: value.indexOf(under.after) };
  if (under.before.trim() && unique(under.before)) return { index: value.indexOf(under.before) + under.before.length };
  return { index: null, why: `neither ${JSON.stringify(under.before)} nor ${JSON.stringify(under.after)} is in the value exactly once` };
}

const failures = [];
const say = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     ${detail}`);
  if (!ok) failures.push(name);
};

/**
 * One case: the same click taken twice, once as the gesture that builds the editor and once into
 * an editor that was already there, with `wanted` deciding what a usable control looks like.
 */
async function compare({ name, value, profile = 'notes', dx, dy, wanted }) {
  const first = await probe({ value, profile, dx, dy, marker: 'AAA' });
  const control = await probe({ value, profile, dx, dy, marker: 'BBB', alreadyEditing: true, at: first.point });
  const where = `${profile}, clicked ${dx}px right, ${dy}px down; first click into a rendered surface landed at index ${first.index}, the identical click into an editor landed at index ${control.index} (value is ${value.length} characters)`;
  if (first.editingBefore) {
    say(name, false, `the first probe found an editor already built, so it measured no first click. ${where}`);
    return;
  }
  for (const [which, r] of [['first click', first], ['control', control]]) {
    if (r.index === null) {
      say(name, false, `the ${which} measured nothing: ${r.why}. ${where}`);
      return;
    }
  }
  /*
   * The control keeps its old job: a click into an editor that already exists is converted by the
   * editor's own layout, and it must still land somewhere this case recognises.
   */
  const usable = wanted(control.index, value);
  if (!usable.ok) {
    say(name, false, `the click into a built editor did not land where it used to: ${usable.why}. ${where}`);
    return;
  }
  /*
   * The first click is compared with the rendered text under the point, which is what the person
   * was looking at. It is not compared with the control: the editor draws the value in a different
   * place from the rendered surface, so the same screen point is over different text in the two
   * states, and "the first click agrees with the second" was the defect rather than the contract.
   */
  const truth = sourceIndex(value, first.under);
  if (truth.index === null) {
    say(name, false, `the rendered text under the point could not be read: ${truth.why}. ${where}`);
    return;
  }
  say(
    name,
    first.index === truth.index,
    `${where}; the rendered text there was ${JSON.stringify(first.under.before)}|${JSON.stringify(first.under.after)}, which is index ${truth.index}`
  );
}

try {
  /*
   * The case from the report: a click into the middle of a description. The control must be past
   * the start of the value, or "they agree" would be two readings of the defect agreeing.
   */
  await compare({
    name: 'a click in the middle of a description lands where it was clicked',
    value: PROSE,
    dx: 120,
    dy: 90,
    wanted: (at) => ({ ok: at > 0, why: `it landed at ${at}, which is where the defect puts a caret too` }),
  });

  /*
   * The same gesture in a `field`, which is the other profile a consumer can mount and has its own
   * extension set. The value and the point are chosen the way `FIELD` says.
   */
  await compare({
    name: 'a click in the middle of a field lands where it was clicked',
    value: FIELD,
    profile: 'field',
    dx: 160,
    dy: 8,
    wanted: (at) => ({ ok: at > 0, why: `it landed at ${at}, which is where the defect puts a caret too` }),
  });

  /*
   * A click past the end of the text on a line, which is the one a naive coordinate conversion
   * gets wrong in the other direction: the precise conversion answers nothing at all for a point
   * with no character under it, and the position nearest to it is the end of that line rather than
   * the start of the document.
   *
   * Past the end *of a line* rather than below the last one, which is not a gesture a first click
   * can make: the rendered surface is sized to its content, so the empty space under the text
   * inside a consumer's taller box belongs to the consumer's own element. A click there focuses
   * nothing and builds no editor, which `probe` reports rather than waiting out.
   */
  await compare({
    name: 'a click past the end of a line lands at the end of the line',
    value: SHORT_FIRST,
    dx: 340,
    dy: 52,
    wanted: (at, value) => ({
      ok: at === value.length || value[at] === '\n',
      why: `the control landed at ${at}, which is mid-line (${JSON.stringify(value.slice(Math.max(0, at - 6), at + 6))}) rather than at the end of one`,
    }),
  });

  /*
   * A click on a construct the two states draw differently. The renderer draws a fence as a `pre`
   * and the editor draws it as lines on a panel, further down the box, so the point under the
   * pointer holds different text in the two states. What has to hold is that the position is taken
   * from the editor the person ends up in, and that nothing throws on the way.
   *
   * **The point has to be on the rendered surface and on the fence in the editor, and the two
   * overlap by a band of about fifteen pixels.** Measured in Chromium at the box above: the rendered
   * surface runs 113px from the box's top (a line, the `pre`, a line), its last line sitting 95 to
   * 113 down, and the editor's three code lines run 98 to 161 down. The `pre` itself, 34 to 79 down,
   * is above anywhere the editor puts its fence, so no click can be on the `pre` and on the fence at
   * once. 104 is the middle of the band, where the rendered state holds the closing paragraph and
   * the editor holds the first line of code. A font or a default margin that moves the band would
   * leave the click focusing nothing, which `probe` reports as such rather than as a pass.
   *
   * So the two halves of this case check different text. The first click is checked against the
   * rendered paragraph under the point, which is what the person was looking at, and the control
   * click into the built editor is the half that checks a click inside a fence.
   */
  await compare({
    name: 'a click over a fence lands on the rendered text under it, and inside the fence once built',
    value: FENCED,
    dx: 120,
    dy: 104,
    wanted: (at, value) => ({
      ok: at > value.indexOf('```js') && at < value.lastIndexOf('```'),
      why: `the control landed at ${at}, which is outside the fence's own source (${value.indexOf('```js')} to ${value.lastIndexOf('```')})`,
    }),
  });

  say(
    'the page reported nothing broken',
    complaints.length === 0,
    complaints.length ? complaints.join('\n     ') : 'no page errors, no failed requests, no error responses'
  );
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} mounted-surface click check(s) failed`);
  process.exit(1);
}
console.log('\nmounted surfaces: the first click puts the caret on the text under the pointer');
