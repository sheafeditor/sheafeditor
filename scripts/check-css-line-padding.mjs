/*
 * Three rules about vertical space on an editor line, all of them enforced against
 * `media/webview.css`:
 *
 *   1. A padding must name `.cm-line`, or CodeMirror wins and the rule never reaches the screen.
 *   2. A vertical margin is not allowed at all, because CodeMirror cannot see one.
 *   3. A height is not allowed at all, because a line's height is what it holds.
 *
 * The first is the original subject of this check and the reason for everything below about
 * specificity. The second and third are stated beside it because they are the same question
 * asked of the two properties that do reach the screen, and both of them have already been got
 * wrong once in this stylesheet.
 *
 *   node scripts/check-css-line-padding.mjs
 *
 * CodeMirror's base theme declares `.ͼ1 .cm-line { padding: 0 2px 0 6px }` and injects it into
 * the document *after* the link to `media/webview.css`. Two classes to one, and later, so it
 * wins twice over: a bare `.tok-something { padding-left: ... }` is in a fight it loses, and it
 * loses silently. Nothing errors, nothing warns, and a reader of the stylesheet believes a
 * number the product ignores.
 *
 * That is not hypothetical. `.tok-quote { padding-left: 0.9em }` sat in the stylesheet and was
 * measured drawing at CodeMirror's 6px, so a quote had no gap of its own at all and only its
 * 3px border showed. The same mistake had already been made and fixed once for headings, which
 * is why the heading padding lives in `src/webview/theme.ts`: a theme rule carries the editor's
 * own class and is injected after the base theme, so it wins.
 *
 * ## Why only padding
 *
 * Because only a property CodeMirror also sets on `.cm-line` is at risk, and on a line that is
 * `padding`. A border is taken in full, which is why `.tok-quote`'s border always showed while
 * its padding never did. Widening this to every property would fire on rules that work, and a
 * check with a false positive in its first week earns an exception list and then gets ignored.
 *
 * ## The rule
 *
 * A rule whose selector names a *line* class may not declare padding unless it also names
 * `.cm-line`. Put it in the theme instead, beside the heading padding, or name `.cm-line` so the
 * specificity matches.
 *
 * ## Which classes are line classes, and why it is not every `.tok-`
 *
 * Only a class that goes on the line element is exposed. Most `.tok-` classes are inline marks
 * on a span inside the line, and CodeMirror sets nothing on those, so their padding works and
 * always has: `.tok-inline-code`'s chip, `.tok-highlight`, `.tok-html-kbd` and `.tok-html-mark`
 * all set padding correctly and none of them is a line. Keying this on the prefix reported all
 * four as faults on its first run, which is how a check earns an exception list and then gets
 * ignored, so it keys on the names instead.
 *
 * The list has to be maintained, and `LINE_DRIFT` below is what makes forgetting visible: it
 * reads the class names out of the `Decoration.line` calls in `src/webview/` and fails on any it
 * does not recognise. It cannot see a class assembled at run time, which is why `tok-rhythm` and
 * `tok-hang` are named here by hand; a new one of that shape has to be added here too, and the
 * failure it would otherwise cause is silence rather than a false alarm.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(REPO, 'media', 'webview.css');
const SRC = join(REPO, 'src', 'webview');

/** Classes that go on a `.cm-line`, so a padding on them is in a fight with CodeMirror's. */
const LINE_CLASSES = new Set([
  'tok-heading',
  'tok-h1',
  'tok-h2',
  'tok-h3',
  'tok-h4',
  'tok-h5',
  'tok-h6',
  'tok-quote',
  'tok-code-block',
  'tok-frontmatter',
  // Assembled at run time from a depth, so the drift guard below cannot see them.
  'tok-rhythm',
  'tok-hang',
  'tok-item-gap',
  'sheaf-code-fence-line',
  'sheaf-block-dragging',
  'sheaf-block-selected',
  'md-footnote-def',
  'md-math-error',
  'tok-alert',
  'tok-alert-note',
  'tok-alert-tip',
  'tok-alert-important',
  'tok-alert-warning',
  'tok-alert-caution',
]);

const css = readFileSync(FILE, 'utf8');

/*
 * Comments out first. The prose above and around these rules talks about padding and about
 * `.tok-` classes constantly, and a checker that reads its own documentation as code reports
 * whatever the last person wrote. Replaced with spaces rather than removed, so the line numbers
 * a failure reports are the line numbers in the file.
 */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const PADDING = /(^|[;{])\s*padding(-left|-right|-top|-bottom)?\s*:/;

/*
 * The two properties a line rule may not declare at all, whatever its specificity.
 *
 * `margin`, `margin-top` and `margin-bottom`: CodeMirror's height map reads each line's
 * offsetHeight, which counts padding and height and not margin, so vertical margin is space the
 * editor does not know exists. The map then disagrees with the page by that much, cumulatively
 * down the document, and `posAtCoords` sends a click to the wrong line. Naming `.cm-line` does
 * not help, because this is not a fight about which rule wins. The horizontal margins are not
 * at risk and are not matched.
 *
 * `height`, `min-height` and `max-height`: a line's height is what it holds, and nothing else.
 * That is the rule the blank-line shrinking broke, and it is stated here because the shrinking
 * was removed rather than fixed: a blank line drew a third of a line tall, grew when the caret
 * reached it, and shrank when it left, so a document moved while a person worked in it and no
 * gap could be read back to the file. Setting a line's height is the only way to do that again.
 */
const MARGIN = /(^|[;{])\s*margin(-top|-bottom)?\s*:/;
const HEIGHT = /(^|[;{])\s*(min-|max-)?height\s*:/;

/*
 * A pseudo-element's height is not the line's. `.sheaf-arrived-deleted::after` draws a 2px tick
 * in the margin where an outside write removed lines, and its height is the tick's. A selector
 * ending in `::before` or `::after` is styling something drawn inside the line, so the height
 * rule does not reach it. The margin rule does not either, for the same reason.
 */
const DRAWN_MARK = /::(before|after)\s*$/;

/*
 * The one line whose height is set on purpose, and the reason it stays that way.
 *
 * A fenced block's opening and closing lines draw 10px tall. The backticks are hidden and the
 * language is not drawn at all, so at full height each fence would be an empty line of body text
 * inside the block. That is the same trade the blank-line shrinking made, and it has the same
 * cost: a reader cannot tell the strip from a line of their file.
 *
 * **Decided, 2026-09-29: it stays at 10px.** The rule it breaks is that every line is one line
 * height whatever it holds, and the force behind that rule is movement — the blank line grew
 * when the caret arrived and shrank when it left, so the document shifted while somebody was
 * working in it. A fence line does not move: measured, the caret alone leaves it hidden and
 * 10px, and only Edit Markdown brings it back to full height. So the expensive half of the
 * argument does not reach it, and what is left is honesty alone.
 *
 * Against that, the two alternatives both cost more than the inconsistency does. A full line
 * puts two empty-looking lines inside every code block, which on a page of short snippets is a
 * great deal of air and invites a reader to treat them as blank lines they can type into. A
 * widget with no line of its own is the most honest and the largest: `posAtCoords`, arrow motion
 * in and out of the block, and the block handle all read line geometry, and it would be a
 * substantial change to the thing most of this editor's other geometry is measured against.
 *
 * So this is a decision rather than a deferral. Reverse it if somebody reports that a code
 * block's ends read as something they typed; until then, the set below stays at one entry and a
 * second one needs its own argument.
 */
const SET_HEIGHT_ON_PURPOSE = new Set(['sheaf-code-fence-line']);

/** The line number a character offset falls on, 1-based. */
const lineAt = (at) => bare.slice(0, at).split('\n').length;

/** The whole declaration a pattern matched, for a failure to quote back. */
const declared = (body, pattern) =>
  (body.match(new RegExp(pattern.source + '[^;]*')) || [''])[0].trim().replace(/^[;{]\s*/, '');

const offenders = [];
const vertical = [];
let lineRules = 0;

// Every `selector { ... }` at the top level, which is all this stylesheet's line rules are.
for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1].trim();
  const body = m[2];
  // A rule about an editor line: it names the line element, or one of the classes that go on
  // one. An inline mark's class is not a line and is not at risk.
  const named = [...selector.matchAll(/\.([a-z][\w-]*)/g)].map((c) => c[1]);
  if (!/\.cm-line/.test(selector) && !named.some((c) => LINE_CLASSES.has(c))) continue;
  lineRules++;
  const where = {
    line: lineAt(m.index + m[1].length),
    selector: selector.replace(/\s+/g, ' ').slice(0, 90),
  };
  if (!DRAWN_MARK.test(selector) && !named.some((c) => SET_HEIGHT_ON_PURPOSE.has(c))) {
    for (const pattern of [MARGIN, HEIGHT]) {
      if (pattern.test(body)) vertical.push({ ...where, declaration: declared(body, pattern) });
    }
  }
  if (!PADDING.test(body)) continue;
  if (/\.cm-line/.test(selector)) continue;
  offenders.push({ ...where, declaration: declared(body, PADDING) });
}

/*
 * A guard on the checker itself. If the parse stops matching this stylesheet, every rule
 * disappears and the run goes green while checking nothing, which is the failure mode a static
 * check is most prone to and the least likely to be noticed.
 */
if (lineRules < 5) {
  console.log(
    `found only ${lineRules} rules about an editor line in media/webview.css, which cannot be right: ` +
      `the parse has stopped matching the file, so this check is passing without checking anything.`
  );
  process.exit(1);
}

/*
 * The drift guard. A line class this check has never heard of is a class it is not protecting,
 * and the symptom would be silence rather than a failure, so the names are read back out of the
 * source and anything unrecognised fails here.
 *
 * Only the literal ones: a class assembled from a variable is invisible to this, which is why
 * the ones built at run time are named in `LINE_CLASSES` by hand with a comment saying so.
 */
const unknown = new Set();
for (const name of readdirSync(SRC)) {
  if (!name.endsWith('.ts')) continue;
  const src = readFileSync(join(SRC, name), 'utf8');
  for (const call of src.matchAll(/Decoration\.line\(\s*\{([^}]*)\}/g)) {
    for (const cls of call[1].matchAll(/['"`]([^'"`]*)['"`]/g)) {
      for (const one of cls[1].split(/\s+/)) {
        // `${...}` pieces of a template literal come through as fragments; skip anything that is
        // not a whole class name.
        if (!/^[a-z][\w-]*$/.test(one)) continue;
        if (!LINE_CLASSES.has(one)) unknown.add(`${one} (src/webview/${name})`);
      }
    }
  }
}
if (unknown.size) {
  console.log(
    `these classes are used in a Decoration.line and this check does not know them:\n` +
      [...unknown].map((u) => `  ${u}`).join('\n') +
      `\n\nAdd them to LINE_CLASSES in scripts/check-css-line-padding.mjs. Until they are there,` +
      `\na padding written for them in media/webview.css would be lost to CodeMirror with nothing` +
      `\nsaying so, which is the failure this check exists to prevent.`
  );
  process.exit(1);
}

if (vertical.length) {
  console.log(`${vertical.length} rule${vertical.length === 1 ? '' : 's'} set a vertical margin or a height on an editor line:\n`);
  for (const o of vertical) {
    console.log(`  media/webview.css:${o.line}`);
    console.log(`    ${o.selector} { ${o.declaration} ... }`);
  }
  console.log(
    `\nNeither reaches the screen the way it reads. CodeMirror's height map counts a line's` +
      `\npadding and height and not its margin, so a vertical margin is space the editor does not` +
      `\nknow about, and posAtCoords sends clicks further wrong the further down the document they` +
      `\nare. Use padding, in src/webview/theme.ts where a line rule wins.` +
      `\n\nA height is worse than lost: it works, and it makes a line a size the file does not say.` +
      `\nEvery line is one line height, whatever it holds and wherever the caret is. That is what` +
      `\nthe blank-line shrinking broke and why it was removed rather than tuned.`
  );
  process.exit(1);
}

if (offenders.length) {
  console.log(`${offenders.length} rule${offenders.length === 1 ? '' : 's'} set padding on an editor line without naming .cm-line:\n`);
  for (const o of offenders) {
    console.log(`  media/webview.css:${o.line}`);
    console.log(`    ${o.selector} { ${o.declaration} ... }`);
  }
  console.log(
    `\nCodeMirror's own '.ͼ1 .cm-line' carries two classes to one and is injected after this` +
      `\nstylesheet, so a padding declared this way never reaches the screen. Move it to` +
      `\nsrc/webview/theme.ts, beside the heading padding that is there for this reason, or name` +
      `\n.cm-line in the selector so the specificity matches.`
  );
  process.exit(1);
}

console.log(
  `${lineRules} rules about an editor line checked: none sets padding without naming .cm-line, ` +
    `and none sets a vertical margin or a height.`
);
