/*
 * Where a line's words start, across every marker and every nesting level, and how far apart
 * one line sits from the next.
 *
 *   node scripts/check-indent.mjs
 *
 * Both axes, in one file, because one Chromium probe reads both and a second browser launch to
 * ask the vertical half of the same question would double the slowest gate for nothing. The
 * horizontal section comes first and is the older one; the vertical section is at the end, under
 * its own heading, with its own document.
 *
 * A marker is drawn by a decoration and the indent is a computed padding, so where the
 * words actually land is a question about drawn pixels. jsdom has no layout and cannot
 * answer it: it can see that a depth reached the DOM and nothing about where that put
 * anything. Measured here instead, in Chromium against Sheaf's own local server.
 *
 * The measurement is a Range over the first character of an item's words, so what is read
 * is the glyph's own box rather than a container's. Everything is reported as an offset
 * from the line box's own left edge, which no rule here changes, so the numbers do not
 * move with the viewport or the centred column.
 *
 * Relationships rather than constants. Earlier numbers for this came from a mock with its
 * own origin and its own compensations, and pinning them here would pin the mock. What a
 * reader actually has is that every marker puts its words on one stop, that nesting steps
 * by an equal amount each level, and that a wrapped line comes back to the same stop as
 * the words above it. Those hold whatever the column is doing.
 *
 * Three controls, and they are what stop this passing for the wrong reason: a paragraph
 * with no marker, which must sit at the editor's own base padding and is untouched by any
 * of this; the second item of every list, which must land exactly where the first did; and
 * a flat quote, which must report one level rather than none. A fix that indented every
 * line equally would satisfy every alignment case above and fail the paragraph.
 *
 * It needs Chromium and playwright-core, which a contributor may not have. When either is
 * missing this says so and exits 0, because a missing browser is not a broken document. A
 * measurement that runs and disagrees fails.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';
import { readPng, apart, show as showColour } from '../test/real-editor/pixels.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/*
 * Tall enough to hold either fixture whole, which is not a detail.
 *
 * CodeMirror draws the viewport and a margin around it, not the document, so a line past the
 * fold has a line object and no box. At 900px the tail of the horizontal fixture stopped being
 * drawn the moment list items gained 4px each, and two of its measurements reported "was never
 * drawn" rather than failing — a check that quietly stops asking is worse than one that
 * disagrees. Nothing here reads the height: every horizontal figure is an offset from a line's
 * own left edge, and the one screenshot scales by width alone.
 */
const VIEW = { width: 1200, height: 2400 };

/* The designed steps, which are GitHub's own: 2em of list indent and 1em of quote padding
 * behind a 0.25em rule, at a 16px body. A Sheaf document is read on GitHub, so these are
 * the numbers that make the editor and the rendered page agree. */
const LIST_STEP = 32;
const QUOTE_STEP = 20;

/* One line of body text: 16px at 1.5 leading. Every line of the document is this tall,
 * whatever it holds, and that is the vertical section's whole subject. */
const LINE = 24;

/* Heading sizes, by level, also GitHub's own, and the one place here where a constant is
 * right rather than a relationship: these are published numbers and a Sheaf document is read
 * against them. h4 is deliberately body size and h5 and h6 deliberately below it, with rank
 * carried by weight and colour. */
const HEADING_SIZE = [32, 24, 20, 16, 14, 13.6];

/*
 * The slack allowed on a font size, which is none, against SLACK's three quarters of a pixel
 * for a position.
 *
 * A position is read off a Range's rectangle and the browser rounds one; a `font-size` is read
 * off `getComputedStyle` and is the value the cascade computed, exactly. So there is nothing for
 * a tolerance to absorb, and a loose one hides the differences that matter here: h6's old 14.4px
 * is 0.8px from GitHub's 13.6, and inline code's old 13.6px is 0.4px from a fence's 14. Measured
 * with a tolerance of half a pixel, both of those passed, and the code one printed "all 13.6px"
 * over three sizes that were not all anything. Caught by breaking it on purpose.
 */
const EXACT = 0.01;

/* Subpixel slack. A stop set by padding is exact to the pixel; this leaves room for the
 * browser's own rounding of a Range rect without leaving room for a wrong step. */
const SLACK = 0.75;

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

/*
 * The document. Every construct that decides a horizontal position appears once, and the
 * caret never moves off line 1, so every line below it is drawn as a reader sees it. Line 1
 * is therefore both the active line and the no-marker control, which it can be because it
 * has no marker to reveal.
 */
const DOC = `A plain paragraph with no marker at all.

- Bullet first item
- Bullet second item

1. Ordered first item
2. Ordered second item

9. Ordered ninth item
10. Ordered tenth item

- [x] Task done item
- [ ] Task open item

- Nest level one
  - Nest level two
    - Nest level three
      - Nest level four

> Quote level one with **bold** in it

> > Quote level two

> > > Quote level three

Unquoted prose beside the table

| A | B |
| - | - |
| 1 | 2 |

> Quoted prose above the table
>
> | Q | R |
> | - | - |
> | 1 | 2 |
>
> Quoted prose below the table

- Wrapping item whose words run on far enough that the browser has to break this single list item across more than one drawn row before it ends
`;

/*
 * Ten levels of nesting, the depth the stress corpus carries.
 *
 * Its own document, because a click has to be able to land on the deepest line and that is a
 * question about whether the words are still inside the column once ten steps of indent are
 * in front of them. Two spaces per level in the file, which is what the corpus uses, so the
 * depth has to come from the tree rather than from counting them.
 */
const DEEP = Array.from(
  { length: 10 },
  (_, i) => `${'  '.repeat(i)}- Level ${i + 1}: words enough to read at this depth`
).join('\n') + '\n';

/*
 * The vertical document. All six heading levels, so the air above one can be compared across
 * them, and one of every block that a blank line has to separate.
 *
 * Separate from `DOC` rather than folded into it, because the vertical question needs headings
 * and the horizontal one needs ten kinds of marker, and a fixture carrying both would be long
 * enough that neither section's reader could see what it was for. The caret stays on line 1 here
 * too, for the same reason.
 *
 * The long paragraph near the end is the wrap control and has to actually break at 1200px, which
 * is what makes it as long as it is.
 */
const VERT = `Intro paragraph one.

Intro paragraph two.

# Heading one

Body under h1.

## Heading two

Body under h2.

### Heading three

Body under h3.

#### Heading four

Body under h4.

##### Heading five

Body under h5.

###### Heading six

Body under h6.

> A quoted line of prose.

- List item one
- List item two
- List item three, whose words run on far enough that the browser has to break this one item across more than one drawn row before it ends
  - Nested first item
  - Nested second item

- Loose list one

- Loose list two

\`\`\`js
const x = 1;
\`\`\`

> A quoted line of prose with code under it
>
> \`\`\`js
> const quoted = 4;
> \`\`\`

A paragraph with \`inline code\` in it.

| A | B |
| - | - |
| 1 | 2 |

A wrapping paragraph whose words run on far enough that the browser has to break it across more than one drawn row before it reaches the end of what it has to say about anything at all.

<!-- A comment block
on two lines -->

$$
x = y + 1
$$

Trailing paragraph.
`;

/**
 * The x of the first character of `words`, and of the first character of each drawn row of
 * the line holding them, as offsets from that line's own left edge.
 *
 * The line's text is searched for `words` rather than assumed to start with it, because a
 * marker's own characters are text nodes on the same line and a list item's words begin
 * after them. A Range is then placed over exactly one character at that index.
 */
async function measure(page, words) {
  return page.evaluate((words) => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(words));
    if (!line) return null;
    const at = line.textContent.indexOf(words);

    // Walk the text nodes to turn a string index on the line into a node and an offset in it.
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node = null;
    let offset = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (seen + n.data.length > at) {
        node = n;
        offset = at - seen;
        break;
      }
      seen += n.data.length;
    }
    if (!node) return null;

    const box = line.getBoundingClientRect();

    const one = document.createRange();
    one.setStart(node, offset);
    one.setEnd(node, Math.min(offset + 1, node.data.length));
    const start = one.getBoundingClientRect().left - box.left;

    /*
     * Every drawn row of the words themselves.
     *
     * Over the whole line this does not work: `getClientRects` returns one rect per inline
     * fragment, and a marker box is a fragment of its own, so a short item that never wrapped
     * reported three rows. Ranged over the one text node holding the words, each rect is a
     * row of those words and nothing else, which is what a hang is a claim about.
     */
    const runs = document.createRange();
    runs.selectNodeContents(node);
    /*
     * Grouped by the row each rect sits on, taking the leftmost in each. One row can be
     * several rects: a trailing space at a break becomes a box of its own, which is why a
     * wrapped item once reported its second row starting at the far right of the column.
     * What a hang is a claim about is where each row begins, so that is what is kept.
     */
    const byRow = new Map();
    for (const r of runs.getClientRects()) {
      if (r.width <= 0) continue;
      const row = Math.round(r.top);
      byRow.set(row, Math.min(byRow.get(row) ?? Infinity, r.left - box.left));
    }
    const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, left]) => left);

    // The depths the editor computed for this line, printed rather than asserted: when a step
    // is wrong, whether the depth or the length is wrong is the first thing worth knowing.
    const css = getComputedStyle(line);
    const depth = {
      list: css.getPropertyValue('--md-list-depth').trim(),
      quote: css.getPropertyValue('--md-quote-depth').trim(),
    };

    return { start, rows, depth, text: line.textContent };
  }, words);
}

/** Waits for the line holding `words` to be drawn, rather than sleeping for it. */
async function drawn(page, words) {
  try {
    await page.waitForFunction(
      (w) => [...document.querySelectorAll('.cm-line')].some((l) => l.textContent.includes(w)),
      words,
      { timeout: 15_000 }
    );
    return true;
  } catch {
    return false;
  }
}

const root = mkdtempSync(join(tmpdir(), 'sheaf-indent-'));
writeFileSync(join(root, 'i.md'), DOC);
writeFileSync(join(root, 'deep.md'), DEEP);
writeFileSync(join(root, 'vert.md'), VERT);

/*
 * A floated picture and enough prose to run up its side.
 *
 * `align="left"` and `align="right"` mean "float me" everywhere the markup is read, and Sheaf
 * writes that markup itself from its own alignment buttons, so a document laid out here has to
 * read the same way where it is published. Its own file because a float changes the line boxes
 * around it, and dropping one into a fixture that measures indent stops would make every number
 * there depend on where the picture happened to sit.
 */
cpSync(join(REPO, 'sample', 'wren-4', 'tour'), join(root, 'tour'), { recursive: true });
writeFileSync(
  join(root, 'float.md'),
  'Intro paragraph.\n\n<img src="tour/mast.svg" alt="floated left" width="180" align="left">\n\n' +
    'A paragraph long enough that its first line would visibly shorten if the picture beside it were taken out of the flow, which is what this is here to find out.\n\n' +
    '<img src="tour/mast.svg" alt="centred" width="180" align="center">\n\nTail paragraph.\n'
);
/*
 * Reveal syntax on the caret's line, turned on for the folder the way `check-caret.mjs` turns
 * on line numbers.
 *
 * It is off by default, and with it off the caret changes nothing about a line's geometry, so
 * the question below could not be asked at all. It is safe for every other measurement here
 * because the caret never leaves line 1 for them and line 1 is the no-marker paragraph: there
 * is nothing on it to reveal.
 */
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'sheaf.revealSyntaxOnLine': true }, null, 2));
const { server, base } = await serveForCheck({
  repo: REPO,
  root,
  whenAbsent: 'so where a line’s words start was not measured at all',
});
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];
const note = (s) => failures.push(s);

try {
  const page = await browser.newPage({ viewport: VIEW });
  await page.goto(`${base}/edit/i.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  if (!(await drawn(page, 'Bullet first item'))) {
    note('the document never drew its first list item, so nothing below was measured');
  }
  await page.waitForTimeout(800);

  const WANTED = [
    'A plain paragraph',
    'Bullet first item',
    'Bullet second item',
    'Ordered first item',
    'Ordered second item',
    'Ordered ninth item',
    'Ordered tenth item',
    'Task done item',
    'Task open item',
    'Nest level one',
    'Nest level two',
    'Nest level three',
    'Nest level four',
    'Quote level one',
    'Quote level two',
    'Quote level three',
    'Wrapping item whose words',
  ];

  const at = {};
  for (const w of WANTED) {
    const m = await measure(page, w);
    if (!m) {
      note(`the line holding ${JSON.stringify(w)} was never drawn, so it was not measured`);
      continue;
    }
    at[w] = m;
  }

  console.log('  text starts, as offsets from each line’s own left edge:');
  for (const w of WANTED) {
    if (!at[w]) continue;
    const d = at[w].depth;
    console.log(
      `    ${at[w].start.toFixed(2).padStart(7)}  ` +
        `list ${(d.list || '-').padStart(2)}  quote ${(d.quote || '-').padStart(2)}  ` +
        `${at[w].rows.length > 1 ? `${at[w].rows.length} rows  ` : '       '}${w}`
    );
  }

  const have = (w) => at[w] && typeof at[w].start === 'number';
  const near = (a, b) => Math.abs(a - b) <= SLACK;

  // ---- CONTROL: a paragraph with no marker sits at the editor's own base padding -------
  //
  // Nothing in this ticket touches a line with no marker on it. If this moves, the indent
  // has been applied to every line rather than to the lines that have a marker, and every
  // alignment case below would still agree with itself.
  const BASE = have('A plain paragraph') ? at['A plain paragraph'].start : null;
  if (BASE === null) {
    note('CONTROL: the no-marker paragraph was not measured, so there is no origin to compare against');
  } else if (BASE > LIST_STEP / 2) {
    note(
      `CONTROL: a paragraph with no marker starts ${BASE.toFixed(2)}px into its own line box. ` +
        `It carries no marker and no indent rule, so it should sit at the editor's small base padding. ` +
        `A number near a list stop means the indent is being applied to every line.`
    );
  } else {
    console.log(`  ok  CONTROL: a paragraph with no marker sits at ${BASE.toFixed(2)}px, the editor's own base`);
  }

  // ---- Every marker puts its words on one stop ----------------------------------------
  //
  // A bullet, a one-digit number, a two-digit number and a task checkbox are four
  // different widths. Right-aligned in a box of one step, all four leave the words at the
  // same place, which is what `list-style-position: outside` buys on the web.
  const ONE_STEP = [
    'Bullet first item',
    'Ordered first item',
    'Ordered ninth item',
    'Ordered tenth item',
    'Task done item',
  ].filter(have);
  if (ONE_STEP.length < 5) {
    note(`only ${ONE_STEP.length} of the 5 depth-one markers were measured, so their alignment was not tested`);
  } else {
    const xs = ONE_STEP.map((w) => at[w].start);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread > SLACK) {
      note(
        `five markers at the same depth put their words at ${xs.length} different places, ${spread.toFixed(2)}px apart:\n` +
          ONE_STEP.map((w) => `      ${at[w].start.toFixed(2).padStart(7)}  ${w}`).join('\n') +
          `\n    A bullet, 1., 9., 10. and a checkbox are four different widths. Boxed and right-aligned they` +
          `\n    all leave the words on one stop; drawn inline each one pushes its own line along.`
      );
    } else if (BASE !== null && Math.abs(xs[0] - (BASE + LIST_STEP)) > SLACK) {
      /*
       * And the stop they agree on is the designed one, which this did not ask until it passed
       * on a wrong answer.
       *
       * Every assertion here is about markers agreeing with each other, so a change that moved
       * all five together satisfied the lot. One did: writing the marker box's gap as padding
       * under `box-sizing: border-box` turned a 32px advance into 24px, every item's words moved
       * 8px left, and this printed `ok` at the new figure. The number is derivable rather than
       * pinned — the editor's own base plus one list step — so asking for it costs nothing and
       * is not the mock-pinning this file warns about.
       */
      note(
        `a depth-one marker puts its words at ${xs[0].toFixed(2)}px, where the base is ${BASE.toFixed(2)}px and a list` +
          ` step is ${LIST_STEP}px,\n    so they belong at ${(BASE + LIST_STEP).toFixed(2)}px. Every other measurement here compares markers` +
          `\n    with each other, so a change that moved all of them together passes them all: this is the one that` +
          `\n    says which stop is right rather than that they share one.`
      );
    } else {
      console.log(`  ok  five markers of four different widths all start their words at ${xs[0].toFixed(2)}px, the base plus one step`);
    }
  }

  // ---- CONTROL: the second item of a list lands where the first did --------------------
  for (const [first, second] of [
    ['Bullet first item', 'Bullet second item'],
    ['Ordered first item', 'Ordered second item'],
    ['Task done item', 'Task open item'],
  ]) {
    if (!have(first) || !have(second)) continue;
    if (!near(at[first].start, at[second].start)) {
      note(
        `CONTROL: ${JSON.stringify(second)} starts at ${at[second].start.toFixed(2)}px and ` +
          `${JSON.stringify(first)} at ${at[first].start.toFixed(2)}px. Two items of one list must agree.`
      );
    }
  }
  console.log('  ok  CONTROL: the second item of each list starts where the first does');

  // ---- Nesting steps by one list step per level ---------------------------------------
  const NEST = ['Nest level one', 'Nest level two', 'Nest level three', 'Nest level four'];
  if (NEST.every(have)) {
    const steps = [1, 2, 3].map((i) => at[NEST[i]].start - at[NEST[i - 1]].start);
    const bad = steps.filter((s) => !near(s, LIST_STEP));
    console.log(`  nesting steps: ${steps.map((s) => s.toFixed(2)).join(', ')} (wanted ${LIST_STEP} each)`);
    if (bad.length) {
      note(
        `four nesting levels step by ${steps.map((s) => s.toFixed(2)).join(', ')}px where each should be ${LIST_STEP}px.\n` +
          `    Depth read off the leading whitespace in a proportional font gives a step that is neither` +
          `\n    designed nor even; depth read off the syntax tree gives this one.`
      );
    } else {
      console.log(`  ok  four nesting levels each step by ${LIST_STEP}px`);
    }
  } else {
    note('the four nesting levels were not all measured, so the list step was not tested');
  }

  // ---- A quote steps by one quote step per level --------------------------------------
  const QUOTES = ['Quote level one', 'Quote level two', 'Quote level three'];
  if (QUOTES.every(have)) {
    const steps = [1, 2].map((i) => at[QUOTES[i]].start - at[QUOTES[i - 1]].start);
    console.log(`  quote steps: ${steps.map((s) => s.toFixed(2)).join(', ')} (wanted ${QUOTE_STEP} each)`);
    if (steps.some((s) => !near(s, QUOTE_STEP))) {
      note(
        `three quote levels step by ${steps.map((s) => s.toFixed(2)).join(', ')}px where each should be ${QUOTE_STEP}px.\n` +
          `    One shared class applied once per line at every depth draws > > > exactly like >, because` +
          `\n    the same class twice is no class at all.`
      );
    } else {
      console.log(`  ok  three quote levels each step by ${QUOTE_STEP}px`);
    }
  } else {
    note('the three quote levels were not all measured, so the quote step was not tested');
  }

  // ---- A wrapped row hangs to the same stop as the words above it ----------------------
  const WRAP = 'Wrapping item whose words';
  if (have(WRAP)) {
    const { start, rows } = at[WRAP];
    if (rows.length < 2) {
      note(
        `the wrapping item drew on ${rows.length} row, so the hang was not measured. ` +
          `It needs a viewport narrow enough, or words longer than these, to break.`
      );
    } else {
      const second = rows[1];
      console.log(`  wrapped item: words start at ${start.toFixed(2)}px, second row at ${second.toFixed(2)}px`);
      if (!near(second, start)) {
        note(
          `a wrapped line starts at ${second.toFixed(2)}px where its own first row's words start at ${start.toFixed(2)}px.\n` +
            `    With no hang the wrap returns to the margin, level with the marker, and the marker stops` +
            `\n    reading as a marker: it reads as part of the sentence.`
        );
      } else {
        console.log(`  ok  a wrapped row hangs to the same stop as the words above it`);
      }
    }
  }

  /* ---- An item does not move when the caret lands on it ---------------------------------
   *
   * The requirement this protects was ruled on after a regression that every other assertion in
   * this file passed straight through. Giving lists a computed 32px step while the source
   * whitespace it replaces was still drawn on the caret's line meant the two never cancelled: a
   * space is about 4.2px, so an item jumped 20.6px at level one and 66.3px at level four as the
   * caret arrived and back as it left. Everything above measures a *rendered* line, so none of it
   * could see it, and it was caught by another session's probe rather than by this check.
   *
   * Measured by clicking into the line, which is what a person does, rather than by setting a
   * selection: a click is the gesture the ruling is about.
   *
   * The control is that the line must actually swap to its source. Without that this passes for
   * the wrong reason the moment the setting stops applying, because a line that never reveals
   * anything cannot move.
   */
  /*
   * Four levels is the case that discriminates, and the first level cannot.
   *
   * Measured while breaking this on purpose: with the indent dropped on the caret's line, a
   * depth-one item still reported 38.00px both ways, because the marker box is one step wide and
   * one step is exactly the indent a depth-one line loses. The two cancel at depth one and only
   * at depth one. Level four reported -96.00px, which is the three steps that do not cancel. So
   * a list here that held only depth-one cases would pass through the regression it exists for.
   */
  /*
   * What counts as "the line revealed its source" differs by row, and a quote is why.
   *
   * For a list the revealed marker is the proof: a rendered line has no `-` or `1.` on it, so
   * their presence says the swap happened. A quote is the one marker in Sheaf deliberately kept
   * hidden on the caret's line, because the indent has already accounted for its width and
   * drawing it moved the words. So for a quote the proof is the *other* syntax on the same line,
   * the asterisks of its bold, together with the `>` being absent.
   *
   * Without the second half of that a quote row would pass on a fix that stopped revealing
   * anything at all, which is the failure this control exists to catch.
   */
  const HELD = [
    { words: 'Nest level one', shown: (t) => /^\s*-\s/.test(t), proof: 'its own marker' },
    { words: 'Nest level four', shown: (t) => /^\s*-\s/.test(t), proof: 'its own marker' },
    { words: 'Ordered first item', shown: (t) => /^\s*\d+[.)]\s/.test(t), proof: 'its own number' },
    {
      words: 'Quote level one',
      shown: (t) => t.includes('**bold**'),
      proof: 'the asterisks of its bold, since its own `>` is deliberately kept hidden',
      /*
       * Separate from the reveal proof, and the separation matters. Folding "the `>` is gone"
       * into `shown` made the control report "did not show its Markdown" when the old behaviour
       * was restored, which was false: the line had revealed, and the `>` being drawn is the
       * cause of the movement rather than evidence of no reveal. Two facts, two assertions, two
       * messages.
       */
      absent: '>',
    },
  ];
  const failuresBefore = failures.length;
  for (const { words: w, shown, proof, absent } of HELD) {
    if (!have(w)) {
      note(`${JSON.stringify(w)} was not measured, so whether it holds still was not tested`);
      continue;
    }
    const away = at[w].start;
    const point = await page.evaluate((words) => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(words));
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!t.data.includes(words.slice(0, 4))) continue;
        const r = document.createRange();
        const i = t.data.indexOf(words.slice(0, 4)) + 1;
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    }, w);
    if (!point) {
      note(`no point inside ${JSON.stringify(w)} could be found to click, so whether it holds still was not tested`);
      continue;
    }
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(250);
    const on = await measure(page, w);
    if (!on) {
      note(`${JSON.stringify(w)} was not drawn once the caret was on it`);
      continue;
    }
    // CONTROL: the line is showing its own Markdown now, judged by what this row's proof is.
    const revealed = shown(on.text);
    const moved = Math.abs(on.start - away) > SLACK;
    console.log(
      `  ${w}: away ${away.toFixed(2)}px, with the caret on it ${on.start.toFixed(2)}px` +
        `  (moved ${(on.start - away).toFixed(2)}px, source shown: ${revealed})`
    );
    if (!revealed) {
      note(
        `CONTROL: ${JSON.stringify(w)} did not show its Markdown when the caret landed on it, so whether it` +
          ` moves was not tested.\n    Its proof of revealing is ${proof}, and its drawn text is` +
          ` ${JSON.stringify(on.text)}. A line that reveals\n    nothing cannot move, so this would pass whatever` +
          ` the indent did.`
      );
    } else if (absent && on.text.includes(absent)) {
      /*
       * A quote's `>` must stay hidden on the caret's line, which is the one marker in Sheaf that
       * does. Its width is already accounted for by the computed indent, so drawing it is exactly
       * what moves the words, and this names that cause rather than leaving the movement figure to
       * be interpreted.
       */
      note(
        `${JSON.stringify(w)} shows ${JSON.stringify(absent)} on the caret's line, and that marker is the one that` +
          ` must stay hidden there.\n    Its width is already in the computed indent, so drawing it moves the words:` +
          ` this line reads ${JSON.stringify(on.text)}\n    and sits ${(on.start - away).toFixed(2)}px from where it` +
          ` does when the caret is elsewhere.`
      );
    } else if (moved) {
      note(
        `${JSON.stringify(w)} moves ${(on.start - away).toFixed(2)}px when the caret lands on it, and must not move at all.\n` +
          `    Something drawn on the caret's line is taking room the indent has already accounted for. For a list` +
          `\n    that is the marker, which has to take the same advance as the hidden form; for a quote it is the` +
          `\n    \`>\` itself, which is why that one stays hidden where every other marker is shown.`
      );
    }
  }
  // Only when nothing above recorded a failure. An `ok` printed beside a disagreement it had
  // just recorded is worse than no `ok` at all, and this line printed one on its first run.
  if (failures.length === failuresBefore) {
    console.log(`  ok  an item does not move when the caret lands on it, at one level, four levels, ordered and a quote`);
  }

  /* ---- A quoted table lines up with the quoted prose around it -------------------------
   *
   * Left for a person to look at for a long time, because a table inside a quote is drawn as a
   * widget with its own border and padding rather than as a line with a computed indent. Two
   * different mechanisms have to agree on one number.
   *
   * They read the same property now, `--md-quote-step`, where the table used to carry a
   * hand-copied `0.9em` that was one of three copies. This is what says they still agree.
   *
   * Measured against the prose *below* the table as well as above it, because a table is a
   * block widget and the quote's lines resume after it: if only the line above were used, a
   * fix that indented the table to match its predecessor and lost the rest would pass.
   *
   * **What lines up is the shift, not the position.** Comparing a quoted cell's text against
   * quoted prose was the first version of this and it is the wrong comparison: a grid carries a
   * row-number gutter and cell padding that a paragraph does not, so its text begins 24px further
   * in whether or not anything is quoted. The invariant that means anything is that quoting moves
   * a table by the same amount it moves prose, so both are measured against their unquoted twins
   * and the two shifts have to agree.
   */
  const quoted = await page.evaluate(() => {
    const lineFor = (words) => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(words));
    const firstTextX = (el) => {
      if (!el) return null;
      const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = t.nextNode(); n; n = t.nextNode()) {
        if (!n.data.trim()) continue;
        const r = document.createRange();
        const i = n.data.search(/\S/);
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        return r.getBoundingClientRect().left;
      }
      return null;
    };
    /*
     * The header cell holding a named letter. A grid's first `th` is the corner above the
     * row-number column and is empty, so `querySelector('th, td')` measured a cell with no text in
     * it and reported that nothing had been drawn.
     */
    const headed = (letter) => {
      for (const t of document.querySelectorAll('.sheaf-table')) {
        const cell = [...t.querySelectorAll('th, td')].find((c) => c.textContent && c.textContent.trim() === letter);
        if (cell) return { cell, quoted: t.classList.contains('is-quoted') };
      }
      return null;
    };
    const plain = headed('A');
    const quoted = headed('Q');
    return {
      proseUnquoted: firstTextX(lineFor('Unquoted prose beside')),
      proseAbove: firstTextX(lineFor('Quoted prose above')),
      proseBelow: firstTextX(lineFor('Quoted prose below')),
      tablePlain: plain ? firstTextX(plain.cell) : null,
      tableQuoted: quoted ? firstTextX(quoted.cell) : null,
      isQuoted: !!quoted && quoted.quoted,
      plainNotQuoted: !!plain && !plain.quoted,
    };
  });
  const missing = Object.entries(quoted).filter(([, v]) => v === null).map(([k]) => k);
  if (!quoted.isQuoted || !quoted.plainNotQuoted) {
    note(
      `the fixture did not draw one quoted table and one unquoted one, so the shift was not measured: ` +
        `quoted ${quoted.isQuoted}, unquoted ${quoted.plainNotQuoted}`
    );
  } else if (missing.length) {
    note(`these were not drawn, so the shift was not measured: ${missing.join(', ')}`);
  } else {
    const proseShift = quoted.proseAbove - quoted.proseUnquoted;
    const tableShift = quoted.tableQuoted - quoted.tablePlain;
    const belowShift = quoted.proseBelow - quoted.proseUnquoted;
    console.log(
      `  quoting shifts prose by ${proseShift.toFixed(2)}px (${belowShift.toFixed(2)}px below the table) ` +
        `and a table by ${tableShift.toFixed(2)}px`
    );
    if (Math.abs(proseShift - QUOTE_STEP) > 1 || Math.abs(belowShift - QUOTE_STEP) > 1) {
      note(
        `quoting moves prose by ${proseShift.toFixed(2)}px above the table and ${belowShift.toFixed(2)}px below it, ` +
          `where a quote's step is ${QUOTE_STEP}px.\n    The lines resume after the table, so a different figure below` +
          ` means the table has disturbed the quote it sits in.`
      );
    } else if (Math.abs(tableShift - proseShift) > 1) {
      note(
        `quoting moves a table by ${tableShift.toFixed(2)}px and the prose around it by ${proseShift.toFixed(2)}px, ` +
          `so a quoted table does not line up with its own quote.\n    A quoted line takes a computed indent and a` +
          ` quoted table takes a border and padding, so the two have to read the\n    same step. They did not when the` +
          ` table carried its own copy of the length.`
      );
    } else {
      console.log(`  ok  quoting shifts a table and the prose around it by the same ${QUOTE_STEP}px, above and below`);
    }
  }

  // Back to a line with nothing to reveal, so the pixel reads below are of rendered lines.
  await page.mouse.click(10, 10);
  await page.waitForTimeout(200);

  // ---- The quote's rule is painted, not merely declared ---------------------------------
  //
  // A quote's rule is a repeating gradient rather than a border, one band per level. Nothing
  // above would notice if it stopped painting: the indent is padding and the steps would still
  // measure 20px with no rule beside them at all. And reading `background-image` back would
  // only say the declaration survived, which is the mistake that makes a check useless, so
  // this reads the drawn pixel out of a screenshot.
  //
  // The control is the no-marker paragraph at the same x. It must be background, or this is
  // measuring the page rather than the rule.
  const shot = join(root, 'quote.png');
  const probe = await page.evaluate(() => {
    const find = (words) => [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(words));
    const box = (words) => {
      const el = find(words);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, mid: r.top + r.height / 2 };
    };
    return { quote: box('Quote level one'), deep: box('Quote level three') };
  });
  if (!probe.quote || !probe.deep) {
    note('a quote line was not on screen, so the rule was not read');
  } else {
    await page.screenshot({ path: shot });
    const png = readPng(shot);
    const ratio = png.width / VIEW.width;
    /*
     * Two pixels on the same quote line, which is what makes this a control rather than a
     * comparison of two unrelated things. A band is a 4px rule followed by 16px of nothing, so
     * 2px in is inside the rule and 12px in is the gap after it. Reading a paragraph instead
     * was the first version of this and it was wrong: at that x a paragraph has its own words,
     * so it compared a rule against a glyph and would have passed with no rule at all.
     */
    const inRule = probe.quote.left + 6 + 2;
    const inGap = probe.quote.left + 6 + 12;
    /*
     * Guarded, because `readPng`'s `at` throws for a pixel outside the image rather than
     * returning anything, and a quote below the fold of a short window has a perfectly good
     * rectangle whose `top` is past the bottom of the screenshot. Unguarded this check died with
     * a stack trace and the word "failed", which says nothing about the indent and reads as a
     * defect in the editor. Measured: at a 400px viewport it asked for pixel 254,465 of a
     * 1200x400 image.
     */
    const pixel = (x, y) => {
      try {
        return png.at(x * ratio, y * ratio);
      } catch (e) {
        return null;
      }
    };
    const ruled = pixel(inRule, probe.quote.mid);
    const gap = pixel(inGap, probe.quote.mid);
    // The third level's third band, which exists only if a band is drawn per level.
    const third = pixel(probe.deep.left + 6 + 40 + 2, probe.deep.mid);
    if (!ruled || !gap || !third) {
      note(
        `a quote line sits outside the ${png.width}x${png.height} screenshot, so the rule was not read. ` +
          `The window is too short to draw the whole document; this is a fact about the viewport rather ` +
          `than about the indent.`
      );
    } else {
      console.log(
        `  quote rule ${showColour(ruled)}, the gap beside it ${showColour(gap)}, ` +
          `a third level's third band ${showColour(third)}`
      );
      if (apart(ruled, gap) < 6) {
      note(
        `the quote's rule is not painted: 2px into the band reads ${showColour(ruled)} and 12px in, which is the gap ` +
          `after the rule, reads ${showColour(gap)}, only ${apart(ruled, gap)} apart.\n` +
          `    The rule is a repeating gradient now rather than a border, so a declaration that survives and a rule` +
          `\n    that paints are different questions, and every step measured above would be correct either way.`
      );
      } else if (apart(third, gap) < 6) {
        note(
          `a three-level quote draws fewer bands than it has levels: its third band reads ${showColour(third)} where ` +
            `the first reads ${showColour(ruled)}.\n    One rule however deep the quote is was the defect this replaced.`
        );
      } else {
        console.log(
          `  ok  the quote's rule is painted, ${apart(ruled, gap)} apart from the gap beside it, and a third level draws a third band`
        );
      }
    }
  }

  // ---- Ten levels deep, the words are still reachable -----------------------------------
  //
  // Each level steps 32px, so a tenth-level item's words begin over 300px in. If that pushes
  // them out of the column, or under something else, the line is unclickable: a person can see
  // it and cannot put the caret in it. Asked the way a click asks, with elementFromPoint, so
  // the answer is about what is actually on top at that point rather than about a rectangle.
  await page.goto(`${base}/edit/deep.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  if (!(await drawn(page, 'Level 10'))) {
    note('the ten-level document never drew its deepest line, so reachability was not measured');
  } else {
    await page.waitForTimeout(500);
    const deep = await page.evaluate(() => {
      const out = [];
      for (const n of [1, 10]) {
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(`Level ${n}:`));
        if (!line) {
          out.push({ n, drawn: false });
          continue;
        }
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = null;
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          if (t.data.includes(`Level ${n}:`)) {
            node = t;
            break;
          }
        }
        if (!node) {
          out.push({ n, drawn: true, text: false });
          continue;
        }
        /*
         * Scrolled into view first, and that is not a convenience.
         *
         * `elementFromPoint` is asked about the viewport, so a line below the fold has a
         * perfectly good rectangle and nothing painted at its middle. Without this the check
         * would report a tenth-level item as unreachable whenever the window was short enough to
         * push it off screen, which is a fact about the viewport and not about the indent: the
         * real-editor suite chased exactly that failure and the x never exceeded 697px at any
         * width, so the indent was never involved. Scrolling first makes the question the one
         * this is for, whether the words are still inside the column.
         */
        line.scrollIntoView({ block: 'center' });
        // The fourth character of the words, which is where a click would be aimed.
        const at = node.data.indexOf(`Level ${n}:`) + 3;
        const r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + 1);
        const rect = r.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        out.push({
          n,
          drawn: true,
          text: true,
          x: Math.round(x),
          right: Math.round(document.documentElement.clientWidth),
          inLine: hit ? hit.closest('.cm-line') === line : false,
          hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}`.slice(0, 40) : 'nothing',
        });
      }
      return out;
    });
    for (const d of deep) {
      console.log(`  level ${String(d.n).padStart(2)}: ${d.drawn ? `x=${d.x} of ${d.right}  hit ${d.hit}` : 'not drawn'}`);
    }
    const bad = deep.filter((d) => !d.inLine);
    if (bad.length) {
      note(
        `at ${bad.map((d) => `level ${d.n}`).join(' and ')} a click aimed at the words lands on ${bad.map((d) => d.hit).join(', ')} ` +
          `rather than on the line itself.\n` +
          `    Ten levels is 320px of indent. Words pushed out of the column, or under something else, make a line` +
          `\n    a person can read and cannot put a caret in.`
      );
    } else {
      console.log(`  ok  a click aimed at the words lands on the line at level 1 and at level 10`);
    }
  }
  /* ==== Vertical: how far apart one line sits from the next ===============================
   *
   * One rule decides all of this: **every line is one line height, whatever it holds and
   * wherever the caret is**, and the space between blocks is the blank lines the file holds.
   *
   * It was not always. A blank line separating two blocks drew a third of a line tall, grew to
   * full height when the caret reached it and shrank again when it left, with four carve-outs
   * keeping full height inside a fenced block, inside front matter, inside a data block and at
   * either end of the document. The spacing it bought was real; what it cost was that the
   * document moved while a person worked in it, and that no gap on screen could be read back to
   * the file. Two blank lines looked like about one and a half.
   *
   * So the separation comes from the file now, and only a heading adds anything of its own.
   * Which makes the controls below the important half of this section: the assertions say the
   * numbers are what they should be, and the controls say a document of equal-height lines was
   * not reached by flattening everything to nothing or by giving every line the same padding.
   */
  await page.goto(`${base}/edit/vert.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  if (!(await drawn(page, 'Heading six'))) {
    note('the vertical document never drew its last heading, so nothing vertical was measured');
  } else {
    await page.waitForTimeout(800);
    console.log('\n  vertical:');

    /*
     * Every drawn line's box and the type in it, plus the rows each line breaks onto.
     *
     * `rows` is per line rather than per document: a wrapped paragraph is one `.cm-line` drawn on
     * two rows, and the distance between those two rows is a separate question from the distance
     * between two lines.
     *
     * Two things make this harder than counting rects, and both were measured rather than guessed.
     *
     * `getClientRects` returns one rect per inline fragment, and a fragment's top is its own, so
     * distinct rounded tops reported every list item and every line holding inline code as two
     * rows. Hence the clustering: two rects belong to one row unless they are at least half a line
     * apart, which no two fragments of one row ever are and no two real rows ever are not.
     *
     * And a marker box is not a row of text. A bullet's `.tok-marker-box` span is drawn at the
     * full 24px line height while the glyphs beside it are an 18px run, so on a wrapped item the
     * topmost rect of the first row is the marker at +4 and the text of the second row is at +31:
     * 27px, and the item read as having rows 3px too far apart when its text rows were exactly
     * 24px. So the rows come from the line's text nodes with the marker boxes left out, which is
     * what the horizontal `measure` above does for the same reason.
     */
    const v = await page.evaluate((LINE) =>
      [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => {
        const s = getComputedStyle(l);
        const r = l.getBoundingClientRect();
        const rects = [];
        const walk = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.data.length) continue;
          if (n.parentElement?.closest('.tok-marker-box')) continue;
          const one = document.createRange();
          one.selectNodeContents(n);
          rects.push(...one.getClientRects());
        }
        const tops = [];
        for (const rect of rects.sort((a, b) => a.top - b.top)) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (!tops.length || rect.top - tops[tops.length - 1] >= LINE / 2) tops.push(rect.top);
        }
        return {
          text: l.textContent,
          cls: l.className,
          top: r.top,
          bottom: r.bottom,
          height: r.height,
          padTop: parseFloat(s.paddingTop),
          padBottom: parseFloat(s.paddingBottom),
          size: parseFloat(s.fontSize),
          /*
           * The line's own leading, resolved to pixels by the browser. Body prose is 16px at 1.5,
           * which is the 24px everything below is measured against, but a heading is 1.25 of a
           * larger size and a code block 1.5 of a smaller one, so "a whole number of line heights"
           * has to mean the line's own rather than the document's. Asserting against 24px reported
           * h4 as wrong at 20px, which is exactly what 1.25 of 16px should be.
           */
          leading: parseFloat(s.lineHeight),
          rows: tops.map((t) => Math.round(t)),
        };
      }), LINE
    );
    const line = (words) => v.find((l) => l.text.includes(words));
    const vhave = (words) => !!line(words);

    // ---- Every heading is GitHub's size for its level ---------------------------------
    const heads = HEADING_SIZE.map((want, i) => ({ level: i + 1, want, at: line(`Heading ${['one', 'two', 'three', 'four', 'five', 'six'][i]}`) }));
    const unseen = heads.filter((h) => !h.at);
    if (unseen.length) {
      note(`${unseen.length} of the six headings were not drawn, so the type scale was not measured`);
    } else {
      console.log(
        `    heading sizes: ${heads.map((h) => `h${h.level} ${h.at.size}px`).join(', ')} ` +
          `(wanted ${HEADING_SIZE.join(', ')})`
      );
      const offScale = heads.filter((h) => Math.abs(h.at.size - h.want) > EXACT);
      if (offScale.length) {
        note(
          `${offScale.length} heading level${offScale.length === 1 ? '' : 's'} not at GitHub's size: ` +
            offScale.map((h) => `h${h.level} is ${h.at.size}px, wanted ${h.want}px`).join('; ') +
            `\n    A Sheaf document is read on GitHub once it is pushed, so a different scale here gives it a` +
            `\n    different structure there.`
        );
      } else {
        console.log(`  ok  all six heading levels report GitHub's size, within a pixel`);
      }

      // ---- The air above a heading is the same at every level -------------------------
      //
      // It used to be an em of the heading's own size, so 32px above an h1 and 21px above an
      // h6: air that shrank as the heading got smaller, when a deeper heading is the harder
      // one to spot. This is the assertion that says it is flat, and it is the one the fix
      // was for.
      const pads = heads.map((h) => h.at.padTop);
      const spread = Math.max(...pads) - Math.min(...pads);
      console.log(`    space a heading adds above itself: ${pads.map((p) => `${p}px`).join(', ')}`);
      if (spread > 0.5) {
        note(
          `a heading adds ${Math.min(...pads)}px to ${Math.max(...pads)}px above itself depending on its level, ` +
            `and it should be one figure.\n    Stated as an em of the heading's own size it shrinks with the` +
            ` heading, which is backwards: the smaller\n    heading is the one that needs finding.`
        );
      } else if (pads[0] <= 0) {
        note(
          `a heading adds ${pads[0]}px above itself, so it sits exactly as far below the block above it as ` +
            `another paragraph would.\n    A heading opens a section and has to read as opening one.`
        );
      } else {
        console.log(`  ok  a heading adds the same ${pads[0]}px above itself at all six levels`);
      }

      // ---- A heading belongs to the body under it, not to the section above ------------
      //
      // The asymmetry, and the reason a heading declares nothing below itself: the blank line
      // under a heading is already a full line, so anything added there pushes a heading away
      // from the text it titles. Above, the same blank line plus the heading's own padding.
      const below = heads.filter((h) => h.at.padBottom > 0.5);
      if (below.length) {
        note(
          `${below.length} heading level${below.length === 1 ? '' : 's'} add space below themselves: ` +
            below.map((h) => `h${h.level} ${h.at.padBottom}px`).join('; ') +
            `\n    The blank line under a heading is already a full line of separation. More on top of it moves a` +
            `\n    heading away from the body it titles, which reads as the heading belonging to the section above.`
        );
      } else {
        console.log(`  ok  no heading adds space below itself; the blank line under it does that`);
      }
    }

    /* ---- CONTROL: every line is one line height ------------------------------------------
     *
     * The invariant, and the control for everything above it. A blank line, a paragraph, a list
     * item and a quoted line are four different things in the file and are all one line tall.
     *
     * It is a control and not only an assertion because of what it rules out. A document whose
     * lines were all flattened to nothing would satisfy every gap measured above, since every
     * gap is a difference. A document that gave every line the same padding would too. This
     * pins the height itself, against the one number that is not free: 16px at 1.5 leading.
     *
     * Restricted to lines at body size, which is what leaves the headings and the code block
     * out. Their line boxes are taller and shorter respectively because their type is, which is
     * the same rule rather than an exception to it.
     */
    /*
     * Every drawn line, of every size, and this is the strongest form of the invariant.
     *
     * It began as "lines at body size, unpadded", which excluded a heading and a list item: the
     * only two kinds of line that carry padding, and so the only two whose height could have gone
     * wrong. What is true of all of them is that a line's *content* box is a whole number of its
     * own leading, with its padding beside rather than inside that. A heading is taller because
     * its type is, a code line shorter because its type is, and a padded line taller by exactly
     * its padding. None of those is an exception to "every line is one line height"; they are what
     * it means once type is allowed to differ.
     */
    const body = v;
    /*
     * Four kinds of line that are four different things in the file and one height on the screen.
     *
     * The list item is deliberately the *second* one. The first item of a list carries no gap of
     * its own, so naming it here made this pass on a document where the gap was being applied to
     * every line of every item — caught by breaking exactly that. The second item is the one that
     * does carry a gap, so it is the one that tests whether the gap has been kept out of the
     * line's own height.
     */
    const kinds = {
      'a paragraph': line('Intro paragraph one.'),
      'a blank line': v.find((l) => l.text === '' && !/tok-/.test(l.cls)),
      'a list item': line('List item two'),
      'a quoted line': line('A quoted line of prose'),
    };
    const missingKind = Object.entries(kinds).filter(([, l]) => !l).map(([k]) => k);
    if (missingKind.length) {
      note(`these were not drawn, so the one-line-height control could not run: ${missingKind.join(', ')}`);
    } else {
      const box = (l) => Math.round((l.height - l.padTop - l.padBottom) * 100) / 100;
      console.log(
        `    line heights: ${Object.entries(kinds)
          .map(([k, l]) => `${k} ${box(l)}px${l.padTop || l.padBottom ? ` + ${l.padTop}/${l.padBottom} pad` : ''}`)
          .join(', ')}`
      );
      const wrong = Object.entries(kinds).filter(([, l]) => Math.abs(box(l) - LINE) > 0.5);
      if (wrong.length) {
        note(
          `CONTROL: ${wrong.map(([k, l]) => `${k} draws ${box(l)}px`).join(' and ')}, where every line of body text ` +
            `is ${LINE}px.\n    A line's height is what it holds and nothing else. A line drawn a size the file does` +
            ` not say is the\n    behaviour that was removed: a reader cannot tell it from a line they typed.` +
            `\n    Padding is excluded and reported separately: a list item's gap sits above its line rather than` +
            ` inside it, and\n    a gap that reached the line's own height would be that behaviour coming back.`
        );
      } else {
        console.log(
          `  ok  CONTROL: a paragraph, a blank line, a list item and a quoted line each draw ${LINE}px of line`
        );
      }
      /*
       * Then the same of every line in the document, in whole line heights rather than in one.
       * A wrapping paragraph is one line of the file drawn on two rows and is 48px tall, which is
       * the rule holding rather than breaking, so what is asserted is that a line's height is an
       * exact number of line heights and never a fraction of one. `Math.max(1, ...)` because a
       * blank line has no text rects to count rows from and is one row.
       */
      const content = (l) => Math.round((l.height - l.padTop - l.padBottom) * 100) / 100;
      const odd = body.filter((l) => l.leading > 0 && Math.abs(content(l) - l.leading * Math.max(1, l.rows.length)) > 0.5);
      if (odd.length) {
        note(
          `${odd.length} line${odd.length === 1 ? '' : 's'} draw a content box that is not a whole number of their own leading:\n` +
            odd
              .map(
                (l) =>
                  `      ${content(l)}px over ${Math.max(1, l.rows.length)} row(s) at ${l.leading}px leading` +
                  `, from ${l.height}px less ${l.padTop}+${l.padBottom} padding  ${JSON.stringify(l.text.slice(0, 40))}  [${l.cls}]`
              )
              .join('\n')
        );
      } else {
        console.log(
          `  ok  all ${body.length} drawn lines are a whole number of their own leading, padding aside`
        );
      }
    }

    /* ---- CONTROL: a blank line separates two blocks, and two of them separate twice -------
     *
     * Measured between the boxes rather than by reading a blank line's height, because what a
     * reader has is the distance from the bottom of one paragraph to the top of the next, and a
     * padding anywhere in between would change that without changing any line's height.
     */
    const [p1, p2] = [line('Intro paragraph one.'), line('Intro paragraph two.')];
    if (!p1 || !p2) {
      note('the two intro paragraphs were not both drawn, so the paragraph gap was not measured');
    } else {
      const gap = p2.top - p1.bottom;
      console.log(`    two paragraphs one blank line apart: ${gap}px`);
      if (Math.abs(gap - LINE) > 0.5) {
        note(
          `two paragraphs with one blank line between them sit ${gap}px apart, where one blank line is ${LINE}px.\n` +
            `    The blank line is the separation. Anything else in the gap is space a reader cannot account for by` +
            `\n    looking at their file.`
        );
      } else {
        console.log(`  ok  CONTROL: one blank line between two paragraphs is exactly ${LINE}px of separation`);
      }
    }

    /* ---- CONTROL: a wrapped paragraph's rows are one line height apart ---------------------
     *
     * Named as a control on the issue this section is from, and it is the right one: a change
     * that added vertical padding per line rather than per block would leave every gap above
     * correct and pull a wrapped paragraph's own rows apart, which no assertion about blocks can
     * see.
     */
    const wrapped = line('A wrapping paragraph whose words');
    if (!wrapped) {
      note('the wrapping paragraph was not drawn, so the wrapped-row control did not run');
    } else if (wrapped.rows.length < 2) {
      note(
        `the wrapping paragraph drew on ${wrapped.rows.length} row, so its rows were not measured. ` +
          `It needs a narrower viewport or longer words.`
      );
    } else {
      const steps = wrapped.rows.slice(1).map((t, i) => t - wrapped.rows[i]);
      console.log(`    wrapped paragraph rows: ${wrapped.rows.length}, ${steps.map((s) => `${s}px`).join(', ')} apart`);
      if (steps.some((s) => Math.abs(s - LINE) > 1)) {
        note(
          `CONTROL: a wrapped paragraph's rows sit ${steps.map((s) => `${s}px`).join(', ')} apart where a line is ` +
            `${LINE}px.\n    Its rows are one line of the file. Space between them is leading, and it is not a place` +
            ` block spacing\n    may reach.`
        );
      } else {
        console.log(`  ok  CONTROL: a wrapped paragraph's own rows stay ${LINE}px apart`);
      }
    }

    /* ---- A list has more vertical texture than prose ---------------------------------------
     *
     * A tight list, which is how nearly every list is written, has no blank lines in its source,
     * so nothing in the block spacing can reach between its items: six task items read as a
     * paragraph with boxes in it. So an item takes a small gap above itself, which is GitHub's
     * `li + li { margin-top: .25em }` translated from margin to padding, because a margin is
     * space CodeMirror's height map cannot see.
     *
     * Three things asserted rather than one, and the second and third are why this is not just
     * "items are further apart than lines":
     *
     *   - two items are further apart than one line height, or the gap is not there at all;
     *   - a wrapped item's own rows are NOT, which is what makes the gap per item rather than
     *     per drawn row, and is the case that would fall apart first;
     *   - the first item of the list takes no gap, since the blank line above the list already
     *     separates it from the prose.
     *
     * The wrapped-row half is checked again on a paragraph further down, deliberately: this one
     * says a wrapped *item* holds together, that one says block spacing has not leaked into
     * leading anywhere.
     */
    const [i1, i2] = [line('List item one'), line('List item two')];
    const wrappedItem = line('List item three, whose words');
    if (!i1 || !i2 || !wrappedItem) {
      note('the list fixture was not fully drawn, so item spacing was not measured');
    } else {
      /*
       * Between the words, not between the boxes, and the difference is the whole measurement.
       *
       * The gap is padding at the top of the *second* item's own line, so that item's box starts
       * exactly where the first one's ends and `top - top` is one line height whatever the padding
       * is. Measured that way this reported 24px with a 4px gap plainly in place. What a reader
       * sees is where the words are, so the first drawn row of each item is what is compared.
       */
      const apartBy = i2.rows[0] - i1.rows[0];
      const rowSteps = wrappedItem.rows.slice(1).map((t, i) => t - wrappedItem.rows[i]);
      console.log(
        `    list items ${apartBy}px apart, first item's own pad ${i1.padTop}px, ` +
          `a wrapped item's ${wrappedItem.rows.length} rows ${rowSteps.map((s) => `${s}px`).join(', ')} apart`
      );
      if (apartBy <= LINE + 0.5) {
        note(
          `two list items sit ${apartBy}px apart, which is one ${LINE}px line and no more, so a tight list has no` +
            ` air in it.\n    Its source has no blank lines by definition, so nothing in the block spacing can` +
            ` separate its items and\n    a six-item list reads as a paragraph with markers in it.`
        );
      } else if (rowSteps.some((s) => Math.abs(s - LINE) > 1)) {
        note(
          `a wrapped list item's own rows sit ${rowSteps.map((s) => `${s}px`).join(', ')} apart where a line is` +
            ` ${LINE}px.\n    The gap belongs to the item, not to each row it draws on. An item is one \`.cm-line\`` +
            ` however many rows it\n    takes, so a gap that reaches its rows has been applied to the wrong thing` +
            ` and a long item falls apart.`
        );
      } else if (i1.padTop > 0.5) {
        note(
          `the first item of the list adds ${i1.padTop}px above itself. The blank line above the list already` +
            ` separates it\n    from the prose, so a gap on top of that makes the list stand off from the` +
            ` paragraph by more than its own\n    items stand apart from each other.`
        );
      } else {
        console.log(
          `  ok  two list items are ${apartBy}px apart against a ${LINE}px line, a wrapped item's rows stay ${LINE}px, ` +
            `and the first item adds nothing`
        );
      }

      /*
       * The nested list's first item, which is the one case the "first item takes no gap" rule
       * must not reach, and the reason the decision needs the syntax tree rather than a class.
       *
       * It is the first item of its own list, so a rule keyed on that alone would give it
       * nothing. But it has no blank line above it: it sits directly under the text of its parent
       * item. Without a gap it reads tighter against its parent than its own sibling reads
       * against it, which is this whole section's complaint one level down.
       */
      const [n1, n2] = [line('Nested first item'), line('Nested second item')];
      if (!n1 || !n2) {
        note('the nested items were not drawn, so a nested list\'s rhythm was not measured');
      } else if (Math.abs(n1.padTop - n2.padTop) > 0.5) {
        note(
          `a nested list's first item adds ${n1.padTop}px above itself and its sibling ${n2.padTop}px, so a nested list` +
            ` opens\n    tighter than it continues. The first item of an *outermost* list takes no gap, because the` +
            ` blank line\n    above the list does that job; a nested list has no blank line above it and its first` +
            ` item needs the gap\n    like any other.`
        );
      } else {
        console.log(`  ok  a nested list's first item takes the same ${n1.padTop}px as its siblings`);
      }

      /*
       * A loose list, written with blank lines between its items, must not end up with two gaps
       * between every pair.
       *
       * It is the case where the two mechanisms meet: the blank line is doing the separating the
       * way it does between any two blocks, and the item's own gap is doing it again on top. One
       * of each is right — a loose list should read looser than a tight one, which is what the
       * author asked for by writing it that way. Two gaps, or a gap doubled, is not.
       *
       * So what is asserted is the arithmetic rather than a figure: loose comes to tight plus
       * exactly one blank line, no more. A fix that suppressed the gap on an item with a blank
       * line above it would fail this by coming out one gap short, which is also worth catching:
       * it would make a loose list read as tight plus a line rather than as a looser list.
       */
      const [g1, g2] = [line('Loose list one'), line('Loose list two')];
      if (!g1 || !g2) {
        note('the loose list was not drawn, so whether its gaps compound was not measured');
      } else {
        const looseBy = g2.rows[0] - g1.rows[0];
        const want = apartBy + LINE;
        console.log(`    a loose list's items ${looseBy}px apart, against ${apartBy}px tight plus one ${LINE}px blank line`);
        if (Math.abs(looseBy - want) > 0.5) {
          note(
            `two items of a loose list sit ${looseBy}px apart where a tight pair sits ${apartBy}px and the blank line` +
              ` between them\n    is ${LINE}px, so ${want}px. ` +
              (looseBy > want
                ? `More than that is the item's gap counted twice: the blank line already separates them.`
                : `Less than that is the gap dropped on an item with a blank line above it, which makes a loose` +
                  ` list read as a\n    tight one with a line in it rather than as the looser list its author wrote.`)
          );
        } else {
          console.log(`  ok  a loose list is a tight one plus its blank lines, with no gap counted twice`);
        }
      }
    }

    // ---- One size for everything monospaced, and a table is not one of them ------------
    //
    // Four sizes had accumulated below body: 13.6 inline, 14.08 in a fence, 14.4 for h6 and
    // 14.72 in a table, so the same snippet rendered at two sizes depending on where it was
    // written. The headings are the type scale above; these are the rest.
    const code = await page.evaluate(() => {
      const size = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
      };
      return {
        'inline code': size('.tok-inline-code'),
        'a code block': size('.tok-code-block'),
        'a fence line': size('.sheaf-code-fence-line'),
        'a table': size('.sheaf-table table'),
      };
    });
    console.log(`    ${Object.entries(code).map(([k, s]) => `${k} ${s === null ? 'not drawn' : `${s}px`}`).join(', ')}`);
    const mono = ['inline code', 'a code block', 'a fence line'].map((k) => code[k]);
    if (mono.some((s) => s === null)) {
      note('not every kind of code was drawn, so whether they share one size was not measured');
    } else if (Math.max(...mono) - Math.min(...mono) > EXACT) {
      note(
        `code is drawn at ${mono.join(', ')}px depending on where it is written, and it should be one size.\n` +
          `    The same snippet reading differently inline and in a fence is the whole of this: what matters as much` +
          `\n    as which number it is, is that there is one of it.`
      );
    } else {
      console.log(`  ok  inline code, a code block and a fence line are all ${mono[0]}px`);
    }
    if (code['a table'] === null) {
      note('no table was drawn, so its size was not measured');
    } else if (Math.abs(code["a table"] - 16) > EXACT) {
      note(
        `a table's text is ${code['a table']}px where body text is 16px. A table is not code: its cells hold the ` +
          `same prose\n    the paragraphs do and are read the same way, which is why GitHub gives a cell body size` +
          ` and Sheaf\n    follows it here.`
      );
    } else {
      console.log(`  ok  a table's text is body size, not one of the code sizes`);
    }

    /* ---- A fenced block's panel frames the code without moving it ----------------------
     *
     * The panel is a `::before` on every line of the block. It used to be `inset: 0`, exactly the
     * line, which left CodeMirror's own 6px on one side and 2px on the other: the first character
     * all but touched the edge, so a block read as text with a background rather than as code in
     * a frame.
     *
     * Two things have to hold together, and either alone is easy to get while losing the other.
     * The panel reaches past the code — that is the point — **and** the code keeps the column the
     * paragraph above it starts on, which is what makes the two read as one document. Padding on
     * the line would give the first and break the second, which is why the box grows outward
     * instead.
     *
     * The quoted block is the third assertion and the one that catches the easy version. A line's
     * indent is padding, so the line box is the full column at every depth, and a panel drawn on
     * it reaches out past a quote's rule and into the page. Its left edge has to come from the
     * line's own depth.
     */
    /*
     * Every figure here is a client x, read in one call.
     *
     * Not from the `rows` the vertical section collects, which are the *tops* of a line's drawn
     * rows: comparing one of those against a panel's left edge produced a 1190px code column
     * against a 96px paragraph and read as a spectacular layout fault. The two sections measure
     * different axes and their numbers do not mix.
     */
    const edges = await page.evaluate(() => {
      const lineFor = (needle) =>
        [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes(needle)) ?? null;
      const glyph = (el) => {
        if (!el) return null;
        const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = t.nextNode(); n; n = t.nextNode()) {
          const i = n.data.search(/\S/);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          return r.getBoundingClientRect().left;
        }
        return null;
      };
      const panel = (el) => {
        if (!el) return null;
        const before = getComputedStyle(el, '::before');
        if (before.content === 'none') return null;
        const r = el.getBoundingClientRect();
        return { left: r.left + parseFloat(before.left), right: r.right - parseFloat(before.right) };
      };
      const code = lineFor('const x = 1;');
      const quoted = lineFor('const quoted = 4;');
      return {
        top: panel(code),
        quoted: panel(quoted),
        codeGlyph: glyph(code),
        proseGlyph: glyph(lineFor('Intro paragraph one.')),
        quotedGlyph: glyph(quoted),
      };
    });
    const codeLine = edges.codeGlyph !== null ? { x: edges.codeGlyph } : null;
    const codePara = edges.proseGlyph !== null ? { x: edges.proseGlyph } : null;
    const quotedCode = edges.quotedGlyph !== null ? { x: edges.quotedGlyph } : null;
    const quotedProse = quotedCode;
    if (!codeLine || !codePara || !edges.top) {
      note('the fenced block or the paragraph above it was not drawn, so the code panel was not measured');
    } else {
      const room = codeLine.x - edges.top.left;
      const aligned = Math.abs(codeLine.x - codePara.x) <= SLACK;
      console.log(
        `    code panel: ${Math.round(room)}px of room beside the code, code at ${codeLine.x}px against prose at ${codePara.x}px`
      );
      if (!aligned) {
        note(
          `a fenced block's code starts at ${codeLine.x}px and the paragraph above it at ${codePara.x}px.\n` +
            `    The panel is meant to grow outward, so that the frame gains room without the code moving. Padding on` +
            `\n    the line gives the room and takes the column, which is the failure this pairs against.`
        );
      } else if (room < 8) {
        note(
          `a fenced block's panel leaves ${Math.round(room)}px beside the code, so the first character all but touches` +
            ` its edge.\n    A block then reads as text with a background rather than as code in a frame.`
        );
      } else {
        console.log(`  ok  a code panel frames its code by ${Math.round(room)}px and leaves the column alone`);
      }
      // And the quoted one, which is where a panel drawn on the line box shows itself.
      if (!quotedCode || !quotedProse || !edges.quoted) {
        note('the quoted fenced block was not drawn, so whether its panel respects the quote was not measured');
      } else if (edges.quoted.left <= edges.top.left + 1) {
        note(
          `a quoted fenced block's panel starts at ${Math.round(edges.quoted.left)}px, no further in than an unquoted` +
            ` one at ${Math.round(edges.top.left)}px.\n    A line's indent is padding and its box is the full column at` +
            ` every depth, so a panel positioned on that box reaches\n    out past the quote's rule. Its left edge has to` +
            ` come from the line's own depth.`
        );
      } else {
        console.log(
          `  ok  a quoted block's panel sits inside the quote, at ${Math.round(edges.quoted.left)}px against ${Math.round(edges.top.left)}px`
        );
      }
    }

    /* ---- No block widget spaces itself with a vertical margin --------------------------
     *
     * A table, a comment, a block equation, a diagram, a data grid and a view are each drawn as
     * one widget in place of their lines. CodeMirror measures a widget like that with
     * `offsetHeight`, which counts padding and height and not margin, so a vertical margin on one
     * is space the height map does not know exists, and every position below it is off by that
     * much. What a person gets is a click landing on the wrong line.
     *
     * **Found, fixed and then found again.** The table had it, was measured and moved to padding,
     * and the commit wrote the rule down on that one rule. Nothing asked the same question of the
     * other five, and three of them had it: a comment at 8px, a block equation at 11.2px and a
     * diagram at 11.2px. Measured on each: a click aimed at the middle of the line under one
     * landed on the blank line after it, while the table's landed correctly.
     *
     * Asked structurally rather than by name, which is what makes it hold for the next widget
     * nobody has written yet: a block widget is a direct child of `.cm-content` that is not a
     * `.cm-line`, and that is true by construction rather than by a list somebody maintains.
     */
    const widgets = await page.evaluate(() =>
      [...document.querySelector('.cm-content').children]
        .filter((el) => !el.classList.contains('cm-line'))
        .map((el) => {
          const cs = getComputedStyle(el);
          return {
            what: `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]}`,
            top: parseFloat(cs.marginTop),
            bottom: parseFloat(cs.marginBottom),
          };
        })
    );
    const margined = widgets.filter((w) => Math.abs(w.top) > 0.5 || Math.abs(w.bottom) > 0.5);
    console.log(`    block widgets drawn: ${widgets.map((w) => w.what).join(', ') || 'none'}`);
    if (widgets.length < 3) {
      note(
        `only ${widgets.length} block widgets were drawn, so the margin rule was checked against almost nothing. ` +
          `The fixture\n    has to hold several: a widget that does not render leaves this passing over it.`
      );
    } else if (margined.length) {
      note(
        `${margined.length} block widget${margined.length === 1 ? '' : 's'} space themselves with a vertical margin:\n` +
          margined.map((w) => `      ${w.what}  ${w.top}px / ${w.bottom}px`).join('\n') +
          `\n    CodeMirror measures a block widget with offsetHeight, which counts padding and not margin, so this` +
          `\n    is space the height map cannot see and every position below it is off by it. A click aimed at the` +
          `\n    line under one lands somewhere else. Use padding; the table widget carries the same note.`
      );
    } else {
      console.log(`  ok  none of the ${widgets.length} block widgets spaces itself with a vertical margin`);
    }
  }

  /* ==== A picture aligned left or right floats, and the words run up its side ==============
   *
   * `align="left"` and `align="right"` mean "float me" in every renderer that reads them, and
   * Sheaf writes that markup itself from its own alignment buttons — so a document laid out here
   * and published elsewhere has to read the same in both. It did not: all three alignments were
   * drawn with automatic margins, which moves a block to an edge without taking it out of the
   * flow, so nothing wrapped and each picture took a band of its own with empty page beside it.
   *
   * Measured rather than read off the rule, because `float: left` in the stylesheet says nothing
   * about whether the text beside it actually moved: what is asked is where the paragraph's first
   * character is. Under the picture means it did not wrap.
   *
   * Centre is the control and must *not* float. It is the one alignment whose meaning is a band
   * of its own, and a change that floated everything would satisfy the first assertion and quietly
   * break the one alignment that was right to begin with.
   */
  await page.goto(`${base}/edit/float.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const floated = await page.evaluate(() => {
    const glyph = (el) => {
      if (!el) return null;
      const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = t.nextNode(); n; n = t.nextNode()) {
        const i = n.data.search(/\S/);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        return r.getBoundingClientRect().left;
      }
      return null;
    };
    const lineFor = (needle) =>
      [...document.querySelectorAll('.cm-content > .cm-line')].find((l) => l.textContent.includes(needle)) ?? null;
    const wrapFor = (alt) => document.querySelector(`img[alt="${alt}"]`)?.closest('.md-img-wrap') ?? null;
    const left = wrapFor('floated left');
    const centre = wrapFor('centred');
    const beside = lineFor('A paragraph long enough');
    const content = document.querySelector('.cm-content').getBoundingClientRect();
    return {
      leftFloat: left ? getComputedStyle(left).float : null,
      centreFloat: centre ? getComputedStyle(centre).float : null,
      pictureRight: left ? left.getBoundingClientRect().right : null,
      pictureBottom: left ? left.getBoundingClientRect().bottom : null,
      besideGlyph: glyph(beside),
      contentBottom: content.bottom,
    };
  });
  if (!floated.leftFloat || floated.besideGlyph === null) {
    note('the floated picture or the prose beside it was not drawn, so wrapping was not measured');
  } else {
    console.log(
      `  a left-aligned picture: float ${floated.leftFloat}, its right edge at ${Math.round(floated.pictureRight)}px, ` +
        `the prose beside it starting at ${Math.round(floated.besideGlyph)}px`
    );
    if (floated.besideGlyph < floated.pictureRight - SLACK) {
      note(
        `the paragraph after a left-aligned picture starts at ${Math.round(floated.besideGlyph)}px, left of the` +
          ` picture's right edge at ${Math.round(floated.pictureRight)}px,\n    so the words are under it rather than` +
          ` beside it. An automatic margin moves a block to an edge without taking it out of\n    the flow, and then` +
          ` nothing wraps.`
      );
    } else if (floated.centreFloat !== 'none') {
      note(
        `CONTROL: a centred picture reports float ${floated.centreFloat}, and centre is the one alignment that means a` +
          ` band of its own.\n    A change that floated every alignment satisfies the wrapping above and breaks the one` +
          ` that was already right.`
      );
    } else if (floated.pictureBottom > floated.contentBottom + 1) {
      note(
        `a floated picture reaches ${Math.round(floated.pictureBottom - floated.contentBottom)}px past the bottom of the` +
          ` document's content.\n    A float that escapes its container draws over whatever follows and cannot be` +
          ` scrolled to.`
      );
    } else {
      console.log(`  ok  a left-aligned picture floats and the prose runs up its side; a centred one does not float`);
    }
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log(
  '\nEvery marker puts its words on one stop, nesting and quotes step evenly, and a wrap hangs.' +
    '\nEvery line is one line height, a heading adds the same air above itself at every level, and' +
    '\ncode is one size. Controls included on both axes.'
);
