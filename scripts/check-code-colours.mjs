/*
 * Whether code in a fenced block is actually coloured.
 *
 *   node scripts/check-code-colours.mjs
 *
 * Syntax colouring is the one feature that can be entirely absent while looking present. The
 * grammars attach, the line is split per token, every token gets a class, and a palette that
 * resolves to one grey throws all of it away. Nothing fails: the spans are there, the classes
 * are right, and the document reads as body text inside a box.
 *
 * That is what happened. Five token types named `var(--vscode-symbolIcon-*Foreground, <colour>)`
 * and VS Code defines those in every theme, as the grey of the suggest widget's type icons, so
 * the fallback beside each was never reached. `const`, `log`, `length` and every class name were
 * drawn four units from body prose across a channel.
 *
 * ## Why the predicate is a distance rather than a difference
 *
 * Four units is a difference. It is not a colour a person can see. A check asking whether a
 * token's colour differs from body prose passes on it, which is how this survived: the first
 * version of the staged scenario for it did exactly that and reported the bug as fixed.
 *
 * So the question is how far apart they are, and `VISIBLE` is the answer in channel units. It
 * is deliberately well above four and well below the real distances, which are 50 and up.
 *
 * ## Which of the two predicates actually catches it
 *
 * The distance from body prose catches the case the issue reported, where the grey landed four
 * units from a dark theme's body text. It does not catch it here: this fixture draws dark text on
 * a light background, so the same grey is 132 units away and passes comfortably.
 *
 * What catches it in any theme is the collision control, that the token types differ from *each
 * other*. The defect was three types resolving to one grey, and a palette that collapses fails
 * that wherever the background happens to sit. Both are kept, because they fail on different
 * things: one on a token the reader cannot pick out of the prose, the other on a palette that has
 * stopped distinguishing anything.
 *
 * ## What this cannot see
 *
 * Which palette a VS Code light theme selects, because that is chosen by a class VS Code puts on
 * the body and this runs against the folder server, where there is none. The light half is a
 * window check and belongs to whoever drives one.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForCheck } from './serve-for-check.mjs';
import { readPng } from '../test/real-editor/pixels.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(REPO, 'package.json'));

/** How far apart two colours must be, in the widest channel, to be different to a reader. */
const VISIBLE = 30;

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

/* One token of each kind the palette names, in one block, plus a paragraph to measure against. */
const DOC = `Body prose to measure the code against.

\`\`\`js
// a comment
const answer = "yes";
let count = 42;
function greet() {}
console.log(answer.length);
class Thing {}
\`\`\`
`;

/** The tokens, by the text that identifies each one on screen. */
const TOKENS = [
  ['keyword', 'const'],
  ['string', '"yes"'],
  ['number', '42'],
  ['comment', '// a comment'],
  ['function', 'greet'],
  ['property', 'length'],
  ['class', 'Thing'],
];

const rgb = (s) => {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s || '');
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
};
const apart = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
const show = (c) => `rgb(${c.r},${c.g},${c.b})`;

const root = mkdtempSync(join(tmpdir(), 'sheaf-colours-'));
writeFileSync(join(root, 'c.md'), DOC);
const { server, base } = await serveForCheck({ repo: REPO, root, whenAbsent: 'so code colours were not measured' });
const browser = await chromium.launch({ executablePath: CHROME });
const failures = [];

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`${base}/edit/c.md`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });

  /*
   * The panel behind a code block, and whether it is a clean rectangle.
   *
   * It is painted per line as a `::before` that reaches 6px left and 12px right beyond the line
   * box, so the code sits inside a margin. The two fence lines carry `overflow: hidden`, which
   * is there to keep a 10px line from showing the fence characters it holds, and that clip cuts
   * their own strip back to the line box. The result is a notch at each of the four corners.
   *
   * Read from the pixels rather than from the rules. A `::before` has no box to measure, and
   * the rules are identical on every line: what differs is only what is painted.
   */
  await page.waitForTimeout(600);
  const where = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-line')].filter(
      (l) => l.classList.contains('tok-code-block') || l.classList.contains('sheaf-code-fence-line')
    );
    const fence = lines.filter((l) => l.classList.contains('sheaf-code-fence-line'));
    const body = lines.filter((l) => !l.classList.contains('sheaf-code-fence-line'));
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), y: Math.round(r.top + r.height / 2) };
    };
    return fence.length && body.length ? { top: mid(fence[0]), body: mid(body[Math.floor(body.length / 2)]), bottom: mid(fence[fence.length - 1]) } : null;
  });
  if (!where) failures.push('no code block was drawn, so the panel was not measured');
  else {
    const shot = join(root, 'panel.png');
    await page.screenshot({ path: shot });
    const png = readPng(shot);
    // Three pixels outside the line box on each side: inside the strip the body lines paint,
    // outside the one the fence lines are clipped to.
    const probe = (row) => ({
      left: png.atCss(row.left - 3, row.y),
      right: png.atCss(row.right + 3, row.y),
    });
    const top = probe(where.top);
    const body = probe(where.body);
    const bottom = probe(where.bottom);
    /*
     * The panel's colour is what a body line paints outside its own text box. Not a pixel
     * inside the block: the first attempt sampled 20px in and landed on a coloured token,
     * `rgb(82,82,251)`, so every comparison failed for the wrong reason.
     */
    const panel = body.left;
    // And the page behind everything, so "they match" cannot be satisfied by there being no
    // panel at all: if these two are the same colour nothing below can tell them apart.
    const behind = png.atCss(where.body.left - 3, where.body.y - 120);
    const painted = (c) => apart(c, panel) <= 6;
    console.log(
      `  the code panel: a body line paints ${show(body.left)} left and ${show(body.right)} right of its text; ` +
        `the top fence line ${show(top.left)} / ${show(top.right)}, the bottom ${show(bottom.left)} / ${show(bottom.right)}`
    );
    const notched = [
      ['top left', painted(top.left)],
      ['top right', painted(top.right)],
      ['bottom left', painted(bottom.left)],
      ['bottom right', painted(bottom.right)],
    ].filter(([, ok]) => !ok).map(([name]) => name);
    // The control: the body line must paint its strip out there, or there is no panel to notch
    // and every corner reads as clean for the wrong reason.
    if (apart(panel, behind) <= 6) {
      failures.push(
        `the code panel ${show(panel)} and the page behind it ${show(behind)} are the same colour, so nothing below can ` +
          `tell a painted corner from a bare one.`
      );
    } else if (!painted(body.right)) {
      failures.push(
        `a body line paints ${show(body.left)} on its left and ${show(body.right)} on its right, so its panel is not ` +
          `symmetric and the corners cannot be judged against it.`
      );
    } else if (notched.length) {
      failures.push(
        `the code panel has a notch at: ${notched.join(', ')}. The fence lines carry \`overflow: hidden\`, which clips\n` +
          `    the strip they paint back to their own line box while every other line paints 6px left and 12px right\n` +
          `    beyond it, so the block reads as a rectangle somebody has bitten the corners off.`
      );
    }
  }

  // The language loads on demand, so the tokens do not exist for a moment after the page does.
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span')].some((s) => s.textContent === 'const'), null, { timeout: 15_000 });
  } catch {
    failures.push('the grammar never attached: no span holding `const` was drawn, so no colour was measured');
  }

  /*
   * VS Code's own values for the variables the old palette borrowed, set here on purpose.
   *
   * Without this the check cannot fail on the defect it exists for, and the first version of it
   * did not: it ran green with the borrowed variables put back. The reason is that the bug lives
   * in one host only. `media/browser-theme.css` defines `symbolIcon-*` with the colours a reader
   * wants, so against the folder server the old palette resolved correctly and there was nothing
   * to see. VS Code defines the same names as the grey of the suggest widget's type icons, and a
   * fallback is reached only when a variable is undefined, so only there did the colours vanish.
   *
   * So the browser is the wrong place to ask unless the browser is made to answer as VS Code
   * does. These four lines are that: the condition reproduced rather than the symptom awaited.
   * A palette that names no borrowed variable is untouched by them, which is the whole point of
   * the fix, and one that names them goes grey here exactly as it does in an editor.
   */
  await page.addStyleTag({
    content: `:root {
      --vscode-symbolIcon-keywordForeground: #bfbfbf;
      --vscode-symbolIcon-propertyForeground: #bfbfbf;
      --vscode-symbolIcon-functionForeground: #bfbfbf;
      --vscode-symbolIcon-classForeground: #bfbfbf;
      --vscode-descriptionForeground: #8c8c8c;
    }`,
  });
  await page.waitForTimeout(150);

  const read = await page.evaluate((tokens) => {
    const body = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('Body prose'));
    const out = { body: body ? getComputedStyle(body).color : null, tokens: {} };
    for (const [name, text] of tokens) {
      const span = [...document.querySelectorAll('.cm-line span')].find((s) => s.textContent === text);
      out.tokens[name] = span ? getComputedStyle(span).color : null;
    }
    return out;
  }, TOKENS);

  const body = rgb(read.body);
  if (!body) {
    failures.push('the body paragraph was not drawn, so there was nothing to measure the code against');
  } else {
    console.log(`  body prose ${show(body)}`);
    const seen = [];
    for (const [name] of TOKENS) {
      const c = rgb(read.tokens[name]);
      if (!c) {
        failures.push(`no span was found for the ${name} token, so its colour was not measured`);
        continue;
      }
      const d = apart(c, body);
      console.log(`  ${name.padEnd(9)} ${show(c).padEnd(20)} ${String(d).padStart(3)} from body prose`);
      if (d < VISIBLE) {
        failures.push(
          `the ${name} token is ${show(c)}, only ${d} from body prose at ${show(body)} in its widest channel.\n` +
            `    Anything under ${VISIBLE} is not a colour a reader can see, so this token is not coloured at all.\n` +
            `    A check asking merely whether the two differ passes on this, which is how it shipped.`
        );
      }
      seen.push({ name, c });
    }
    /*
     * CONTROL. Every token being far from body prose is not enough: a palette that resolved to
     * one colour for all of them would satisfy every case above and still be the bug, which was
     * three token types landing on the same grey. So they have to differ from each other too.
     */
    const collisions = [];
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        if (apart(seen[i].c, seen[j].c) < VISIBLE) collisions.push(`${seen[i].name} and ${seen[j].name} are both ${show(seen[i].c)}`);
      }
    }
    if (collisions.length) {
      failures.push(
        `CONTROL: token types share a colour, so the palette is collapsing:\n` +
          collisions.map((c) => `      ${c}`).join('\n') +
          `\n    Three types landing on one grey was the defect. Every token being far from body prose` +
          `\n    would be true of that too, which is why this asks whether they differ from each other.`
      );
    } else {
      console.log(`  ok  ${seen.length} token types, each visible against body prose and distinct from the others`);
    }
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

if (failures.length) {
  console.log(`\n${failures.length} colour measurement${failures.length === 1 ? '' : 's'} disagree:`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log('\nCode is coloured: every token type is visible against body prose and distinct from the others.');
