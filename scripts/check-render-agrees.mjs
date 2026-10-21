/*
 * Whether the render path and the editor draw the same thing.
 *
 *   node scripts/check-render-agrees.mjs            every document in sample/
 *   node scripts/check-render-agrees.mjs --verbose  every disagreeing line, not just the first few
 *
 * **This builds both halves, every run, from this checkout.** The whole script is a comparison
 * between them, so one half taken from a prebuilt artefact compares two trees and reports the
 * difference as a disagreement between two implementations. The editor half used to come from
 * `test/bundle.cjs`, which a suite writes, so the oracle every line here is judged against was
 * whatever state of `src/` that suite last saw. The run says so below the heading, because a
 * comparison is only worth the claim that both sides came from the same bytes.
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
 *
 * Two differences are the two paths disagreeing on purpose, and each is counted on its own line of
 * the report rather than charged to the renderer. A **link reference definition** is drawn by the
 * editor and drawn by nothing here, so its line is taken out of the comparison; there is no part of
 * it left to compare. An **ordered item written `1)`** has its delimiter folded to the full stop
 * HTML draws, and its number and its words stay in the comparison, because only the one character
 * is a difference between the media. Each is explained where it is applied.
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleExports } from './lib/bundle.mjs';

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

/*
 * Both sides, one after the other, from the sources on disk now.
 *
 * The editor side is the engine suite's own entry and the oracle every comparison below is made
 * against. The render side is `src/render/markdown.ts`, bundled for Node because nothing in it
 * reaches the DOM: it walks a `@lezer/markdown` tree and writes tags. That is also why the
 * Markdown-language redirect the helper applies by default costs nothing here, since this half
 * never imports `@codemirror/lang-markdown` for it to act on.
 */
const { drawMap } = require(await bundleExports(REPO, { drawMap: 'test/engine.entry' }, 'render-agrees-editor'));
const { renderMarkdown, dialectParser } = require(
  await bundleExports(REPO, { 'renderMarkdown, dialectParser': 'src/render/markdown' }, 'render-agrees-render', { platform: 'node' })
);

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
    // A non-breaking space is written back as its entity by the DOM round trip in `withMarkers`, and
    // the renderer's own output holds the character, so the two spellings of one character agree here.
    .replace(/&nbsp;/g, ' ')
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
  /*
   * An HTML parser drops a newline that comes straight after `<pre>`, and the renderer writes one
   * there on purpose: it stands for the opening fence's line, so a code block takes as many output
   * lines as it took source lines and every line below it is still compared with its own. Parsing
   * the document here would delete it and shift everything after the first fence by one, which
   * reads as thousands of disagreements. A second newline is what the parser leaves behind as one.
   */
  const root = new window.DOMParser().parseFromString(`<body>${html.replace(/<pre>\n/g, '<pre>\n\n')}</body>`, 'text/html').body;
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
let definitionLines = 0;
/** Ordered items written `1)`, compared with their delimiter folded to the one HTML draws. */
let delimiterLines = 0;
let undrawn = 0;
const undrawnBy = new Map();
/** Every construct that appeared somewhere a line was actually compared. */
const seenConstructs = new Set();
const disagreements = [];
const skippedBy = new Map();
/**
 * Every document that could not be compared, with the reason. **Named in full at the end, because
 * a count is not an identification.**
 *
 * It used to be a bare counter, with only the *first* thrower named inline and the rest appearing
 * solely inside the disagreement list, which truncates at twelve without `--verbose`. Two
 * truncations over one fact: a second thrower was unnamed inline, and the corpus it came from
 * sorts last, so its row landed past the cap in any run with a dozen disagreements.
 *
 * That cost a real dispute. A run reported `2 document(s) threw` and the pass reading it could
 * identify only one, so whether the second was a new regression or had always thrown became an
 * argument rather than a lookup, with the two readings fitting the facts equally well. Neither
 * reader was careless; the instrument named one of two and counted the other.
 */
const notCompared = [];
let threw = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let drawn;
  let rendered;
  try {
    drawn = drawMap(text);
    rendered = renderMarkdown(text);
  } catch (e) {
    // Said as it happens as well as collected, because a run where everything throws exits at the
    // empty-set guard below and would otherwise print the count and none of the reasons. The
    // inline line is still only the first, to keep a corpus-wide failure from scrolling past; every
    // one of them is named in full at the end, which is the part that was missing.
    if (threw === 0) console.log(`${relative(REPO, file)} threw: ${e.message}\n`);
    threw++;
    notCompared.push({ file: relative(REPO, file), why: e.message });
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
   * The one construct the two paths differ on deliberately: a link reference definition.
   *
   * The editor draws it as the source line it is, because a person editing needs to see it. The
   * renderer leaves it out, because it is bookkeeping for the links that name it and CommonMark
   * removes it from the document. So the editor's line holds `[d]: https://e.com` and this path's
   * holds nothing, on every definition in the corpus, and counting those as disagreements would put
   * a decision on the renderer's account. They are counted on their own and named in the report.
   *
   * Found from the tree rather than from the text, so a line that only looks like a definition, in
   * the middle of a paragraph, is still compared.
   */
  const dropped = new Set();
  /*
   * And the lines where an ordered item's delimiter is a `)`, which the two media spell differently
   * with nothing wrong on either side.
   *
   * CommonMark allows `1.` and `1)`. The editor keeps the file's own characters, because an ordered
   * marker is **boxed** and boxing is the one mechanism of the three that restyles the bytes in
   * place; so the editor's line reads `1)First again`. The renderer emits `<ol>` and no marker at
   * all, and the browser draws the marker from `list-style-type`, which writes a full stop whatever
   * the file holds. `withMarkers` puts that full stop into the string on this side for exactly that
   * reason, so the two strings differ by one character on every such line.
   *
   * **Neither side is wrong and the renderer has nothing to fix.** Part 2's own rule for the third
   * mechanism is that boxing cannot be followed by an implementation with no caret, and that a
   * reimplementer should ask what its output format already provides rather than emit the source
   * characters. HTML provides the marker. Emitting the file's `1)` as content beside an `<ol>` that
   * draws its own marker is the double-numbering defect that was already found and removed from this
   * path once.
   *
   * So the delimiter is folded rather than the line dropped. A dropped line would take its words out
   * of the comparison with it, and the words are the part either side could still get wrong: the
   * number is compared through the fold, so a list starting at 3 that rendered as 1 still fails.
   *
   * Found from the marker in the tree rather than by matching `^\d+\)` over the text, so a line that
   * only looks like one — a year at the start of a sentence, a `)` inside an indented code block —
   * is compared as it stands.
   */
  const parenMarker = new Set();
  const lineOf = (pos) => {
    for (let n = 0; n < lineStarts.length; n++) {
      const from = lineStarts[n];
      const to = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : text.length;
      if (pos >= from && pos <= to) return n + 1;
    }
    return 1;
  };
  {
    const cursor = dialectParser.parse(text).cursor();
    do {
      if (cursor.name === 'ListMark' && /^\d+\)$/.test(text.slice(cursor.from, cursor.to))) parenMarker.add(lineOf(cursor.from));
      if (cursor.name !== 'LinkReference') continue;
      for (let n = 0; n < lineStarts.length; n++) {
        const from = lineStarts[n];
        const to = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : text.length;
        if (cursor.from < to && cursor.to > from) dropped.add(n + 1);
      }
    } while (cursor.next());
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
    if (dropped.has(row.line)) {
      definitionLines++;
      continue;
    }
    /*
     * One normalisation, named rather than quietly applied, because it is a difference between the
     * two media rather than between the two implementations.
     *
     * An unordered item's `- ` is replaced by a bullet widget in the editor, so its drawn text begins
     * with a literal bullet character. In HTML that same bullet is the list marker a browser draws
     * from `<li>`, and it is not text at all. Both show a bullet; only one has it in the string. An
     * ordered item needs no strip, because both sides carry a number in the string: the editor's is
     * the file's own and this side's is put there by `withMarkers`. Its *delimiter* does need a fold,
     * and that is `sameDelimiter` below rather than this one.
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
    /*
     * The editor's bullet is stripped only from a line that has a list marker to draw one for. A line
     * that begins with a literal bullet character, as a Project Gutenberg licence indents its terms,
     * is text, and in an indented code block it is code: stripping it from the editor's side alone
     * made every such line read as the renderer inventing a bullet. Until indented code was drawn
     * those lines were out of scope and never reached this.
     */
    const hasMarker = /^[\s>]*[-*+]\s/.test(row.source);
    /*
     * An ordered marker's delimiter, folded to the one HTML draws, on a line the tree says carries a
     * `)` marker. Put through both sides rather than one, though only the editor's string holds a
     * `)`: the fold is a fact about the two media and not a correction to either implementation, and
     * a reader of this line should not have to work out which side it was aimed at.
     */
    let folded = false;
    const sameDelimiter = (s) => {
      if (!parenMarker.has(row.line)) return s;
      const out = s.replace(/^(\s*\d+)\)/, '$1.');
      folded ||= out !== s;
      return out;
    };
    const theirs = sameDelimiter(hasMarker ? row.drawn.replace(/^\s*\u2022\s*/, '') : row.drawn).replace(markerGap, '$1');
    const ours = sameDelimiter(mine[row.line - 1] ?? '').replace(markerGap, '$1');
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
    /*
     * Counted when the fold actually changed a string, and after the line is known to have been
     * compared. Counting the lines it was *offered* would report a number whatever the fold did,
     * which is the shape of a figure that cannot fall: with the fold disabled on purpose the report
     * went on saying six.
     */
    if (folded) delimiterLines++;
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
/*
 * Said in the output rather than left to the reader, because the one thing that invalidates every
 * number below is the two halves having come from different trees, and nothing in a disagreement
 * count shows it.
 */
console.log('  both halves were bundled from this checkout in this run, so every difference below is');
console.log('  between the two implementations rather than between two trees\n');
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
if (definitionLines) {
  console.log(`  ${definitionLines} line(s) of link reference definitions, left out of the comparison by name:`);
  console.log('      the editor draws a definition as its source and the renderer draws nothing, on purpose');
}
if (delimiterLines) {
  console.log(`  ${delimiterLines} ordered item(s) written "1)", compared with the delimiter folded to "1.":`);
  console.log('      the editor keeps the file\'s own delimiter, because an ordered marker is boxed; HTML');
  console.log('      draws the marker from the <ol> and writes a full stop whatever the file holds. The');
  console.log('      number and the words either side of it are still compared.');
}
/*
 * The denominator, every run, whether or not anything went wrong.
 *
 * `compared` against the population is the number a reader needs to know what a pass is worth, and
 * a run that quietly compares fewer documents than the last one should not look like a run that
 * compared them all. Each document that was not compared is named with its reason, outside the
 * disagreement list so the twelve-row cap cannot hide one.
 */
console.log(
  `  ${files.length - notCompared.length} of ${files.length} document(s) compared` +
    (notCompared.length ? `, ${notCompared.length} not:` : ', none skipped.')
);
for (const { file, why } of notCompared) console.log(`      ${file}  —  ${why}`);
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
