/*
 * Whether the render path and the editor draw the same thing.
 *
 *   node scripts/check-render-agrees.mjs            every document in sample/
 *   node scripts/check-render-agrees.mjs --verbose  every disagreeing line, not just the first few
 *
 * **This is the check the render path exists to survive.** `src/render/markdown.ts` walks a tree and
 * writes tags; the editor hangs CodeMirror decorations over a document. They cannot be one
 * implementation, and a field that shows one thing unfocused and another thing focused is the most
 * visible way a library of this kind loses trust. So the two are compared rather than reasoned about.
 *
 * ## The oracle is the editor, not a list of expectations
 *
 * `drawMap` in `test/engine.entry.ts` mounts the real editor under jsdom and returns, per line, the
 * text actually drawn. That is the editor's own answer, and Part 2 of the specification was derived
 * from it. Writing a fresh set of expectations here would be a third opinion to keep in step with
 * two, and the first thing it would do is agree with whichever of them was written last.
 *
 * ## What a disagreement means, and what it does not
 *
 * A line is compared only when both paths have an answer for it. Constructs outside the `field` and
 * `notes` profiles — tables, images, maths, fenced code, diagrams — are the `document` profile's,
 * and the renderer says so in `outOfScope` rather than guessing. Those lines are counted and named
 * rather than silently skipped, because a comparison that quietly drops what it cannot judge is the
 * failure mode this whole path is written to avoid: it would report agreement on an empty set.
 *
 * One known difference is excluded by name and said out loud. jsdom mounts no block widget the size
 * of a table, so `drawMap` reports a table's source as prose, which looks like a rule and is an
 * artefact of the harness. Tables are out of scope here anyway, so the two reasons agree.
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.argv.includes('--verbose');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const key of ['getComputedStyle', 'NodeFilter', 'Node', 'HTMLElement', 'DOMParser', 'Range', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment', 'Text']) {
  if (window[key]) globalThis[key] = window[key];
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
/*
 * The two jsdom leaves off a `Range`, and the global `Window` it does not export.
 *
 * CodeMirror's measure pass asks a range for its rectangles and asks `instanceof Window`, and jsdom
 * provides neither, so without these every document throws rather than drawing. Copied from
 * `scripts/check-render.mjs`, which is the other script that drives a whole document this way, and
 * each of these cost that script a run to find.
 */
const emptyRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (!window.Range.prototype.getClientRects) window.Range.prototype.getClientRects = () => [];
if (!window.Range.prototype.getBoundingClientRect) window.Range.prototype.getBoundingClientRect = emptyRect;
if (!globalThis.Window && window.Window) globalThis.Window = window.Window;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

/*
 * A window tall enough to hold any document, so CodeMirror's viewport takes all of it in.
 *
 * jsdom lays nothing out, so without this the editor draws one screenful and every line below it
 * reads as raw source. The first run of this check reported 47,046 disagreements over 85 documents
 * for that reason alone, which is what a harness artefact looks like when it is mistaken for a
 * finding. Lines keep jsdom's zero geometry, so none of them is mistaken for a tall one.
 */
const TALL = 1e7;
Object.defineProperty(window, 'innerHeight', { value: TALL, configurable: true });
Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
const realRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  const tall =
    this === window.document.body ||
    this === window.document.documentElement ||
    ['cm-editor', 'cm-scroller', 'cm-content'].some((c) => this.classList?.contains(c));
  return tall
    ? { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: TALL, width: 1200, height: TALL, toJSON() {} }
    : realRect.call(this);
};

const require = createRequire(import.meta.url);
const { drawMap } = require(join(REPO, 'test', 'bundle.cjs'));

// The render path, bundled from source so this measures what the repository holds rather than
// whatever was built last.
const RENDER = join(REPO, '.claude', 'scratch', 'render-agrees.cjs');
buildSync({ entryPoints: [join(REPO, 'src', 'render', 'markdown.ts')], bundle: true, format: 'cjs', outfile: RENDER, platform: 'node', logLevel: 'error', absWorkingDir: REPO });
const { renderMarkdown, dialectParser } = require(RENDER);

/*
 * **A tag ends at the `>` that closes it, not at the first `>` in it.**
 *
 * An attribute may legally hold a literal `>`: HTML requires only `&`, `"` and a non-breaking space
 * to be escaped inside a quoted value. So `/<[^>]*>/` ends a tag in the middle of an `href` and
 * leaks the rest of the attribute into the text, which is why one compared line read `">link`.
 *
 * It took `withMarkers` to make that reachable, and the shape of the false finding is the reason
 * this comment is long. The renderer emits `href="&lt;https://example.com/a b&gt;"`, correctly
 * escaped, and always has — every destination goes through `escape`. `withMarkers` round-trips the
 * HTML through the DOM to number an ordered list, and **jsdom's serialiser writes those entities
 * back as literal `<` and `>`**, because inside an attribute it is not obliged to escape them. The
 * old regex then broke on the `>` it had just been handed. So a correct renderer, read through two
 * correct-in-isolation steps, produced a line that looks exactly like a render path emitting
 * unescaped markup for an address — injection-shaped, in a path meant for other people to re-use.
 *
 * `textContent` on the parsed body is the obvious alternative and is worse: an HTML parser
 * restructures what it is given, and this corpus holds the CommonMark and GFM specifications, whose
 * examples are full of raw `<head>`, `<title>` and `<table>` fragments. Parsing the rendered
 * document and reading its text moved or swallowed enough of them to take the disagreement count
 * from 54 to 13,448. Measured, not predicted.
 */
const TAG = /<\/?[a-zA-Z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*\s*\/?>/g;
const textOf = (html) =>
  html
    .replace(TAG, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/*
 * **Put an ordered item's number into the string, because on this side a browser draws it.**
 *
 * The renderer emits `<ol start="N">` and no marker text, which is what CommonMark means by an
 * ordered list and what the browser then numbers from; the editor's line carries the file's own
 * `2.`. Both show a number and only one has it in the text, so without this every ordered item in
 * the corpus reads as a disagreement — 631 of them, which is five times the real total and would
 * have been read as a renderer that had stopped numbering.
 *
 * The bullet case above does the opposite and strips the editor's side, and the asymmetry is the
 * point: a bullet carries no information, so dropping it from both costs nothing, while a number
 * does. Stripping the numbers would make the comparison silent about exactly the thing that was
 * wrong here — a list starting at 3 rendered as 1 would agree. So they are put in and compared.
 *
 * Counted from `start` the way a browser does rather than from the file's markers, because that is
 * the claim being checked: the file's second marker is routinely `1.` again, and matching it would
 * be asserting the bug.
 */
function withMarkers(html) {
  if (!/<ol[ >]/.test(html)) return html;
  const root = new window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  for (const ol of root.querySelectorAll('ol')) {
    let n = Number(ol.getAttribute('start') ?? 1);
    for (const li of ol.children) {
      if (li.tagName !== 'LI') continue;
      li.insertBefore(root.ownerDocument.createTextNode(`${n++}.`), li.firstChild);
    }
  }
  return root.innerHTML;
}

/** Every Markdown document under `sample/`, which is the corpus the dialect census also reads. */
function corpus(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) corpus(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const files = corpus(join(REPO, 'sample')).sort();

/*
 * **Say which corpus this is, because part of it is not in the commit.**
 *
 * `sample/wild/files/` is gitignored and produced by `npm run fetch:wild`: twenty documents and
 * about 69,000 lines, the CommonMark and GFM specifications among them. A checkout that has not
 * fetched them — a fresh worktree, a clean clone, CI — compares 6,517 lines where this machine
 * compares 40,969, and reports a disagreement count six times smaller for a renderer that has not
 * changed.
 *
 * That is not hypothetical. Two sessions measured the same commit on the same evening and got 7 and
 * 120, and neither number was wrong. Nothing in the output said so: one run printed `85 document(s)`
 * and the other `65`, and a reader has no reason to read either as a warning. So the denominator is
 * stated beside the result, the way a coverage figure names the population it is over.
 */
const wild = files.filter((f) => f.includes(`${join('sample', 'wild', 'files')}`)).length;
const corpusLine = wild
  ? `${files.length} document(s), including the ${wild} fetched into sample/wild/files/`
  : `${files.length} document(s). **sample/wild/files/ is empty**, so about 69,000 lines of the corpus are not being compared. Run npm run fetch:wild for the full population`;
let compared = 0;
let skipped = 0;
let undrawn = 0;
const undrawnBy = new Map();
/** Every construct that appeared somewhere a line was actually compared. */
const seenConstructs = new Set();
const disagreements = [];
const skippedBy = new Map();
let threw = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let drawn;
  let rendered;
  try {
    drawn = drawMap(text);
    rendered = renderMarkdown(text);
  } catch (e) {
    // Said as it happens rather than collected, because a run where everything throws exits at the
    // empty-set guard below and would otherwise print the count and none of the reasons.
    if (threw === 0) console.log(`${relative(REPO, file)} threw: ${e.message}\n`);
    threw++;
    disagreements.push({ file: relative(REPO, file), line: 0, detail: `threw: ${e.message}` });
    continue;
  }

  /*
   * A line is out of scope when any construct the renderer refused overlaps it. Computed from the
   * ranges it reported rather than from the construct's name, so a table's every line is excluded
   * and the paragraph after it is not.
   */
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const refused = new Set();
  for (const o of rendered.outOfScope) {
    skippedBy.set(o.construct, (skippedBy.get(o.construct) ?? 0) + 1);
    for (let n = 0; n < lineStarts.length; n++) {
      const from = lineStarts[n];
      const to = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : text.length;
      if (o.from < to && o.to > from) refused.add(n + 1);
    }
  }

  /*
   * Split the way the editor counts lines, which is on any of the three endings.
   *
   * This path keeps the file's bytes, so a document using lone CRs came back as one long line here
   * while the editor had already split it. It is the right split to make and it was a small cause:
   * two lines of the 123 that remained, not the large class the first examples suggested.
   */
  const mine = textOf(withMarkers(rendered.html)).split(/\r\n|\r|\n/);

  /** The construct names the parser found on a given line, for the coverage report above. */
  const treeByLine = new Map();
  {
    const c = dialectParser.parse(text).cursor();
    do {
      let n = 1;
      for (let i = 0; i < c.from && i < text.length; i++) if (text[i] === '\n') n++;
      if (!treeByLine.has(n)) treeByLine.set(n, new Set());
      treeByLine.get(n).add(c.name);
    } while (c.next());
  }
  const constructsOnLine = (n) => treeByLine.get(n) ?? [];
  for (const row of drawn) {
    if (refused.has(row.line)) {
      skipped++;
      continue;
    }
    /*
     * One normalisation, named rather than quietly applied, because it is a difference between the
     * two media rather than between the two implementations.
     *
     * An unordered item's `- ` is replaced by a bullet widget in the editor, so its drawn text begins
     * with a literal bullet character. In HTML that same bullet is the list marker a browser draws
     * from `<li>`, and it is not text at all. Both show a bullet; only one has it in the string. An
     * ordered item needs nothing here, because there the number is the file's own characters in both.
     */
    /*
     * And one more, on both sides equally: the whitespace between an ordered item's marker and its
     * words goes, however much of it there is.
     *
     * The two media put a different amount there and neither amount is a rendering decision. The
     * editor hides exactly one space, which is the one the marker's syntax carries, so an item
     * written `1.  How much` draws with the second space still on screen. HTML collapses runs of
     * whitespace, so the browser shows one space whatever the file holds, and the string this path
     * produces holds the file's own run. So `1. How much` and `1.  How much` are the same rendering
     * described in two media, and 68 items in the two specification documents disagreed on nothing
     * else. Applied to both sides rather than one, because a normalisation that touches only the
     * side being tested is how a comparison stops being one.
     *
     * The indent in front of a nested item's marker goes the same way and for the same reason. The
     * editor hides those spaces and draws the step as computed padding, since drawn spaces would add
     * their own width on top of it; HTML nests one `<ol>` inside another and the browser indents it.
     * Both show a sublist one step in, and only one has the step in the string.
     */
    const markerGap = /^\s*(\d+\.)\s+/;
    const theirs = row.drawn.replace(/^\s*\u2022\s*/, '').replace(markerGap, '$1');
    const ours = (mine[row.line - 1] ?? '').replace(markerGap, '$1');
    /*
     * A line the editor could not draw is not a disagreement, and counting it as one puts a fifth of
     * this number on the renderer's account. `drawMap` says so in as many words, so this reads its
     * answer rather than inferring: no line element means the instrument declined, and the honest
     * place for that is its own total.
     */
    if (row.drawn === '(no line element)') {
      undrawn++;
      undrawnBy.set(relative(REPO, file), (undrawnBy.get(relative(REPO, file)) ?? 0) + 1);
      continue;
    }
    compared++;
    for (const c of constructsOnLine(row.line)) seenConstructs.add(c);
    if (ours.trim() !== theirs.trim()) {
      disagreements.push({ file: relative(REPO, file), line: row.line, source: row.source, theirs, ours });
    }
  }
}

/*
 * **The denominator is the profile's construct list, not what this path happens to handle.**
 *
 * Without this the comparison asks only about constructs both sides draw, which is a set the
 * implementation chooses: a render path handling paragraphs alone would compare every line it
 * produced, agree on all of them, and report success. A quantifier whose scope is set by the thing
 * being measured cannot fail, and it reads as rigorous precisely because it names a comparison.
 *
 * So the constructs `notes` carries are listed here, from `docs/14-editor-as-components.md`, with fenced
 * code added to that profile by a later decision, and any that never appeared in a compared line is named. A
 * construct the corpus does not exercise is as invisible to this as one the renderer ignores.
 */
const NOTES_CONSTRUCTS = [
  'StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link', 'Highlight',
  'BulletList', 'OrderedList', 'ListItem', 'Task', 'Blockquote',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'FencedCode',
];
const unseen = NOTES_CONSTRUCTS.filter((c) => !seenConstructs.has(c));

console.log(`The render path against the editor, over ${corpusLine}:\n`);
if (unseen.length) {
  console.log(`  ${unseen.length} of ${NOTES_CONSTRUCTS.length} constructs the notes profile carries never reached a compared line:`);
  console.log(`      ${unseen.join(', ')}`);
  console.log('  Those are silent here whatever the renderer does with them.\n');
} else {
  console.log(`  all ${NOTES_CONSTRUCTS.length} constructs the notes profile carries reached a compared line\n`);
}
console.log(`  ${compared} line(s) compared`);
console.log(`  ${skipped} line(s) out of scope, named rather than dropped:`);
for (const [c, n] of [...skippedBy].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${c}`);
if (threw) console.log(`  ${threw} document(s) threw`);
if (undrawn) {
  console.log(`  ${undrawn} line(s) the editor could not draw, which is the instrument rather than the renderer:`);
  for (const [f, n] of [...undrawnBy].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`      ${String(n).padStart(4)}  ${f}`);
}

if (!compared) {
  console.log('\nNothing was compared, which is a failure rather than a pass: a comparison over an empty');
  console.log('set agrees with anything. Check that sample/ is present and that drawMap is returning rows.');
  process.exit(1);
}

if (disagreements.length) {
  console.log(`\n${disagreements.length} line(s) disagree:\n`);
  for (const d of (VERBOSE ? disagreements : disagreements.slice(0, 12))) {
    if (d.detail) {
      console.log(`  ${d.file}: ${d.detail}`);
      continue;
    }
    console.log(`  ${d.file}:${d.line}`);
    console.log(`      source   ${JSON.stringify(d.source)}`);
    console.log(`      editor   ${JSON.stringify(d.theirs)}`);
    console.log(`      render   ${JSON.stringify(d.ours)}`);
  }
  if (!VERBOSE && disagreements.length > 12) console.log(`  … and ${disagreements.length - 12} more. Run with --verbose.`);
  process.exit(1);
}

console.log('\nEvery line in scope draws the same in both, so an unfocused field and a focused one show');
console.log('the same text.');
