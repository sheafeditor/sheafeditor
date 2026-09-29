#!/usr/bin/env node
/*
 * Every keystroke, at every place the caret can be, on every construct: what
 * does a reader see afterwards?
 *
 * Sheaf draws Markdown rather than showing it, so almost every construct has
 * characters in the document that are not on the screen. A heading's `# `, a
 * quote's `>`, a task's `[ ]`, the `**` around bold. Wherever that is true there
 * are two caret positions that draw in the same place and behave differently:
 * one in front of the hidden characters and one behind them. A person cannot see
 * which one they have, so a keystroke that reads the wrong one writes something
 * they did not ask for, and usually puts Markdown on the screen while it does it.
 *
 * That is one defect with many faces, and picking the faces off one at a time by
 * hand is how the editor came to have so many of them. So this is a matrix
 * instead: every fixture, at every caret position, under every gesture, judged
 * against the rules below rather than against a hand-written expected result.
 * Hand-written results do not scale to twenty thousand cells, and they encode
 * what the editor does rather than what a person wants.
 *
 *   npm run check-editing                 the whole matrix
 *   node scripts/check-editing.mjs --verbose        every cell, not just the failures
 *   node scripts/check-editing.mjs --fixture h1     one fixture
 *   node scripts/check-editing.mjs --update         rewrite the ledger below
 *   node scripts/check-editing.mjs --update --accept-worse   and accept new failures
 *   node scripts/check-editing.mjs --instrument     what this matrix measures, running nothing
 *
 * Run it through npm, as `npm run check-editing -- --verbose`, so the heap size
 * lives in one place. A hand-written `node --max-old-space-size=...` is how an
 * evening went on a V8 abort that was the flag being passed, not the matrix.
 *
 * ## What counts as right
 *
 * The rules a WYSIWYG editor owes its reader, as checks. None of them mentions
 * Markdown syntax, because the reader never asked for any:
 *
 *   no-leak        No keystroke puts a Markdown character on the screen. Counted
 *                  per character, before against after, so a fixture that draws
 *                  a punctuation mark on purpose is not mistaken for a leak.
 *   typed-once     Typing a character inserts that character and moves nothing
 *                  else. The strictest rule here, and the one a person would
 *                  state first if asked.
 *   kind-kept      Typing into a block leaves it the kind of block it was. A
 *                  heading that quietly stops being a heading is the same defect
 *                  as a visible `#`, one step earlier.
 *   delete-one     Backspace and Delete remove one thing. They may take a
 *                  construct's formatting instead of a character, which is what
 *                  a person means at the left edge of a heading, but they never
 *                  leave more on the screen than they found.
 *   nothing-hidden No line holds text that is not drawn. An empty heading is an
 *                  empty line with a `# ` in it: invisible, and the next thing
 *                  typed on it lands in front of the hash.
 *   undo-restores  One undo gives back exactly what was there, on the screen and
 *                  in the file.
 *   motion-is-read-only   An arrow key, Home or End writes nothing.
 *
 * ## The ledger
 *
 * The editor fails a lot of these today, so the run would be red from the first
 * commit and tell nobody anything. KNOWN_GAPS records how many cells each class
 * fails at now. The run fails when a count goes up, which is the regression this
 * exists to catch, and it also fails when a count goes down, which means someone
 * fixed something and the ledger is now a lie. `--update` rewrites it.
 *
 * `--update` will lower a count and remove a class freely, because that is a fix
 * being written down. It refuses to raise one or to add a class the ledger has
 * never seen, because that is a cost being accepted, and a cost is a decision
 * somebody makes rather than a number a tool writes. `--accept-worse` is how you
 * make it, and the reason belongs in a comment above the entry.
 *
 * Comments in the ledger are yours and are carried through a regeneration. A
 * `--update` used to delete them, and a paragraph explaining one of the classes
 * was lost that way and had to be written again from memory.
 *
 * Describe the gap in the note. No tracker references: this file ships.
 *
 * ## What this cannot see
 *
 * jsdom has no layout, so Up and Down have no geometry to move through and
 * clicking has no coordinates to land on. Both reach caret positions the arrow
 * walk here never visits, and both are how a person hits these defects in
 * practice. They belong in `test/real-editor/`, against a real window.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorUnderJsdom, settle, visibleText } from './lib/editorDom.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const UPDATE = argv.includes('--update');
const ONLY = (argv.find((a) => a.startsWith('--fixture=')) ?? '').slice('--fixture='.length) ||
  (argv.includes('--fixture') ? argv[argv.indexOf('--fixture') + 1] : '');

/* ------------------------------------------------------------- fixtures -- */

/*
 * One construct each, between a paragraph before and a paragraph after, so that
 * a gesture at either edge has a real neighbour to run into rather than the ends
 * of the document. The lead and tail hold no Markdown punctuation, so every mark
 * the leak check counts came from the construct.
 */
const LEAD = 'Lead in.';
const TAIL = 'Tail out.';

/** `block` owns its line; `inline` sits in a paragraph; `raw` shows its syntax on purpose. */
const ALL_FIXTURES = [
  ['h1', 'block', '# Heading'],
  ['h2', 'block', '## Heading'],
  ['h6', 'block', '###### Heading'],
  ['quote', 'block', '> Quoted line'],
  ['quote-deep', 'block', '>> Deeper quote'],
  ['quote-item', 'block', '> - Item in a quote'],
  ['bullet-dash', 'block', '- Bullet item'],
  ['bullet-star', 'block', '* Star item'],
  ['bullet-plus', 'block', '+ Plus item'],
  ['ordered-dot', 'block', '1. Numbered item'],
  ['ordered-paren', 'block', '1) Bracket item'],
  ['task-open', 'block', '- [ ] Open task'],
  ['task-done', 'block', '- [x] Done task'],
  ['heading-bold', 'block', '## Heading with **bold**'],
  ['item-link', 'block', '- Item with [text](http://example.test)'],
  ['bold', 'inline', 'Before **bold** after'],
  ['italic', 'inline', 'Before *slanted* after'],
  ['bold-italic', 'inline', 'Before ***both*** after'],
  ['underscore-em', 'inline', 'Before _slanted_ after'],
  ['code', 'inline', 'Before `code` after'],
  ['strike', 'inline', 'Before ~~gone~~ after'],
  ['highlight', 'inline', 'Before ==lit== after'],
  ['link', 'inline', 'Before [text](http://example.test) after'],
  ['image', 'inline', 'Before ![alt](http://example.test/i.png) after'],
  ['autolink', 'inline', 'Before <http://example.test> after'],
  ['footref', 'inline', 'Before text[^1] after'],
  ['emoji', 'inline', 'Before :tada: after'],
  ['inline-html', 'inline', 'Before <kbd>Esc</kbd> after'],
  ['nested-marks', 'inline', 'Before **bold with `code`** after'],
  ['inline-math', 'inline', 'Before $x + 1$ after'],
  ['ref-link', 'inline', 'Before [text][ref] after'],
  // Constructs that span more than one line, where a gesture on the first line
  // can change what the second one means.
  ['setext', 'block', 'Title here\n=========='],
  ['alert', 'block', '> [!NOTE]\n> Something worth knowing'],
  ['nested-list', 'block', '- Outer item\n  - Inner item'],
  ['loose-list', 'block', '- First item\n\n- Second item'],
  ['footdef', 'block', '[^1]: The note itself'],
  ['table', 'raw', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['fence', 'raw', '```js\nconst a = 1;\n```'],
  ['hr', 'raw', '---'],
];

const FIXTURES = ALL_FIXTURES.filter(([name]) => !ONLY || name === ONLY)
  .map(([name, family, body]) => ({ name, family, body, doc: `${LEAD}\n\n${body}\n\n${TAIL}\n`, at: LEAD.length + 2 }));

/* ------------------------------------------------------------- gestures -- */

/*
 * `writes` is false for a gesture that must leave the document alone, `kind` is
 * false for one that may legitimately change the block's kind, and `adds` is true
 * for one that may legitimately put a character on the screen.
 */
const GESTURES = [
  { name: 'type', writes: true, kind: true, run: (h, p) => h.type(p, 'X') },
  { name: 'type-space', writes: true, kind: false, run: (h, p) => h.type(p, ' ') },
  { name: 'Backspace', writes: true, kind: false, run: (h, p) => p.press('Backspace') },
  { name: 'Delete', writes: true, kind: false, run: (h, p) => p.press('Delete') },
  { name: 'Enter', writes: true, kind: false, run: (h, p) => p.press('Enter') },
  { name: 'Shift-Enter', writes: true, kind: false, run: (h, p) => p.press('Shift-Enter') },
  { name: 'Bold', writes: true, kind: true, run: (h, p) => p.press('Mod-b') },
  { name: 'Italic', writes: true, kind: true, run: (h, p) => p.press('Mod-i') },
  { name: 'Tab', writes: true, kind: false, run: (h, p) => p.press('Tab') },
  { name: 'Shift-Tab', writes: true, kind: false, run: (h, p) => p.press('Shift-Tab') },
  { name: 'ArrowLeft', writes: false, kind: true, run: (h, p) => p.press('ArrowLeft') },
  { name: 'ArrowRight', writes: false, kind: true, run: (h, p) => p.press('ArrowRight') },
  { name: 'Home', writes: false, kind: true, run: (h, p) => p.press('Home') },
  { name: 'End', writes: false, kind: true, run: (h, p) => p.press('End') },
  // The word-sized deletions, which take a run of characters rather than one and
  // so can swallow a delimiter from further away than Backspace reaches.
  { name: 'DeleteWordBack', writes: true, kind: false, run: (h, p) => p.press('Mod-Backspace') },
  { name: 'DeleteWordForward', writes: true, kind: false, run: (h, p) => p.press('Mod-Delete') },
  { name: 'DeleteWordBackAlt', writes: true, kind: false, run: (h, p) => p.press('Alt-Backspace') },
  // Undo and redo as a pair, which must land back where the document started.
  { name: 'Undo-Redo', writes: true, kind: false, run: (h, p) => { h.type(p, 'X'); p.press('Mod-z'); p.press('Mod-Shift-z'); } },
  // With the construct's whole line selected: what a person does before retyping it.
  { name: 'select-line-type', writes: true, kind: false, select: 'line', run: (h, p) => h.type(p, 'X') },
  { name: 'select-line-Backspace', writes: true, kind: false, select: 'line', run: (h, p) => p.press('Backspace') },
  { name: 'select-line-Bold', writes: true, kind: false, select: 'line', run: (h, p) => p.press('Mod-b') },
];

/*
 * Turning one kind of thing into another. These are the commands behind the
 * toolbar and the slash menu, so between them and the gestures above a person
 * has no other way to change a document.
 *
 * `transform` is the kind of block the command is asking for, or 'inline' for a
 * command that wraps the selection instead. Both are run twice as well as once:
 * a command that is not idempotent turns a heading into a heading with a `#` in
 * its text, and one that does not undo itself leaves the text somewhere a person
 * cannot get back from.
 */
const TRANSFORMS = [
  { name: 'Strike', key: 'Mod-Shift-x', transform: 'inline' },
  { name: 'Highlight', key: 'Mod-Shift-h', transform: 'inline' },
  { name: 'InlineCode', key: 'Mod-e', transform: 'inline' },
  { name: 'Heading1', key: 'Mod-Alt-1', transform: 'h1' },
  { name: 'Heading2', key: 'Mod-Alt-2', transform: 'h2' },
  { name: 'Heading3', key: 'Mod-Alt-3', transform: 'h3' },
  { name: 'PlainText', key: 'Mod-Alt-0', transform: 'text' },
  { name: 'BulletList', key: 'Mod-Shift-8', transform: 'bullet' },
  { name: 'OrderedList', key: 'Mod-Shift-7', transform: 'ordered' },
  { name: 'Quote', key: 'Mod-Shift-9', transform: 'quote' },
  { name: 'TaskList', key: 'Mod-Alt-4', transform: 'task' },
  { name: 'CodeBlock', key: 'Mod-Alt-8', transform: 'code' },
];

/*
 * A block command acts on the line, so running it from every caret position on
 * that line asks the same question twenty times. Four places are enough: in
 * front of the marker, where the text starts, in the middle of a word and at the
 * end. An inline command does depend on where the caret is, but only in the same
 * four ways, and the matrix is large enough already: at every position, the
 * twelve commands below cost more cells than everything else put together.
 */
const FEW = 'few';

for (const t of TRANSFORMS) {
  GESTURES.push({ ...t, writes: true, kind: false, positions: FEW, run: (h, p) => p.press(t.key) });
  GESTURES.push({
    ...t,
    name: `${t.name}-twice`,
    writes: true,
    kind: false,
    positions: FEW,
    twice: true,
    step: (h, p) => p.press(t.key),
  });
  GESTURES.push({
    ...t,
    name: `${t.name}-then-PlainText`,
    writes: true,
    kind: false,
    positions: FEW,
    andBack: true,
    run: (h, p) => {
      p.press(t.key);
      p.press('Mod-Alt-0');
    },
  });
}

/* ------------------------------------------------------- the instrument -- */

/*
 * What this run measured, which is a different question from what it found.
 *
 * The matrix is a cross product and both sides of it grow. A count of failures
 * says nothing about which cross product produced it, so a green run on a branch
 * based before four gestures were added is not evidence about the branch it
 * lands on: 98 classes measured against 151 measured, both green, and the
 * smaller one cannot see what the larger one asks.
 *
 * So the shape is recorded and two different things are checked against it. One
 * check cannot catch both failures, and the first version of this issue argued
 * that it could.
 *
 *   Against INSTRUMENT below, in this same file. The ledger and the code have to
 *   describe the same matrix, which is what makes a stale `--update` fail rather
 *   than pass quietly. It cannot catch an old base: an old base carries the
 *   matching old ledger, the two agree, and the check is satisfied.
 *
 *   Against origin/main's copy of this file. A run that measures fewer fixtures
 *   or gestures than the branch it lands on is not evidence about that branch.
 *   This is the check that catches an old base, and it is only worth trusting
 *   because the first one holds on main.
 *
 * `--instrument` prints the shape and runs nothing, which is how two people
 * compare bases in a second rather than in twenty minutes.
 *
 * `--fixture` narrows the run on purpose, so neither check runs under it.
 */
const RUNNING = {
  fixtures: ALL_FIXTURES.map(([name]) => name).sort(),
  gestures: GESTURES.map((g) => g.name).sort(),
};

/*
 * The commit `--update` was last run on. Every count in KNOWN_GAPS is a claim
 * about this commit and about no other, which is a thing the file did not say
 * before and a lane found out the hard way: regenerated on a base that had been
 * reset, one run wrote four live regressions in as accepted and deleted six cells
 * that a fix on the real main had not made pass, so the ledger was wrong in both
 * directions at once with nothing in it to show that.
 */
const LEDGER_BASE = '36d0e454a62d95a5b25f6e87563c8839ebab45d0';

const INSTRUMENT = {
  fixtures: [
    "alert", "autolink", "bold", "bold-italic", "bullet-dash", "bullet-plus", "bullet-star",
    "code", "emoji", "fence", "footdef", "footref", "h1", "h2", "h6", "heading-bold",
    "highlight", "hr", "image", "inline-html", "inline-math", "italic", "item-link", "link",
    "loose-list", "nested-list", "nested-marks", "ordered-dot", "ordered-paren", "quote",
    "quote-deep", "quote-item", "ref-link", "setext", "strike", "table", "task-done",
    "task-open", "underscore-em"
  ],
  gestures: [
    "ArrowLeft", "ArrowRight", "Backspace", "Bold", "BulletList",
    "BulletList-then-PlainText", "BulletList-twice", "CodeBlock",
    "CodeBlock-then-PlainText", "CodeBlock-twice", "Delete", "DeleteWordBack",
    "DeleteWordBackAlt", "DeleteWordForward", "End", "Enter", "Heading1",
    "Heading1-then-PlainText", "Heading1-twice", "Heading2", "Heading2-then-PlainText",
    "Heading2-twice", "Heading3", "Heading3-then-PlainText", "Heading3-twice", "Highlight",
    "Highlight-then-PlainText", "Highlight-twice", "Home", "InlineCode",
    "InlineCode-then-PlainText", "InlineCode-twice", "Italic", "OrderedList",
    "OrderedList-then-PlainText", "OrderedList-twice", "PlainText",
    "PlainText-then-PlainText", "PlainText-twice", "Quote", "Quote-then-PlainText",
    "Quote-twice", "Shift-Enter", "Shift-Tab", "Strike", "Strike-then-PlainText",
    "Strike-twice", "Tab", "TaskList", "TaskList-then-PlainText", "TaskList-twice",
    "Undo-Redo", "select-line-Backspace", "select-line-Bold", "select-line-type", "type",
    "type-space"
  ],
};

/*
 * The lines a person wrote in the ledger, kept apart from the numbers a run
 * generates. Nothing in the file distinguished the two, so a `--update`
 * silently deleted a paragraph explaining one of the classes, and restoring it
 * meant rewriting it from memory rather than reverting.
 *
 * A comment block belongs to the entry it sits above, which is what a reader
 * assumes and what makes a comment beside the cell it explains worth having.
 */
function ledgerProse(src) {
  const block = /const KNOWN_GAPS = \{\n([\s\S]*?)\n\};/.exec(src);
  if (!block) return { above: new Map(), trailing: [] };
  const above = new Map();
  let pending = [];
  for (const line of block[1].split('\n')) {
    const entry = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(line);
    if (entry) {
      if (pending.length) above.set(JSON.parse(entry[1]), pending);
      pending = [];
    } else pending.push(line);
  }
  return { above, trailing: pending };
}

/** Wrapped so a name can be read; one array per line would be four hundred lines. */
function listLiteral(names) {
  const lines = [];
  let line = '';
  names.forEach((name, i) => {
    const piece = JSON.stringify(name) + (i === names.length - 1 ? '' : ',');
    if (line && line.length + 1 + piece.length > 88) {
      lines.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  });
  if (line) lines.push(line);
  return `[\n    ${lines.join('\n    ')}\n  ]`;
}

/*
 * Read the recorded shape out of a copy of this file. A regex rather than an
 * import because the copy being read is usually another commit's, handed over by
 * `git show`, and importing it would run it.
 */
function recordedInstrument(src) {
  const block = /const INSTRUMENT = \{[\s\S]*?\n\};/.exec(src);
  if (!block) return null;
  const fixtures = /fixtures:\s*(\[[\s\S]*?\])/.exec(block[0]);
  const gestures = /gestures:\s*(\[[\s\S]*?\])/.exec(block[0]);
  if (!fixtures || !gestures) return null;
  try {
    return { fixtures: JSON.parse(fixtures[1]), gestures: JSON.parse(gestures[1]) };
  } catch {
    return null;
  }
}

const missingFrom = (have, want) => want.filter((n) => !have.includes(n));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Is the commit the ledger was written on part of this history? A `false` means
 * the counts below describe work this checkout does not contain, which is not the
 * same as being merely out of date.
 */
function ledgerBaseIsHere() {
  if (!LEDGER_BASE) return { known: false };
  if (!git(['cat-file', '-e', `${LEDGER_BASE}^{commit}`]) && git(['rev-parse', '--git-dir']) === null) {
    return { known: false };
  }
  const here = git(['merge-base', '--is-ancestor', LEDGER_BASE, 'HEAD']) !== null;
  return { known: true, here, base: LEDGER_BASE, head: git(['rev-parse', '--short', 'HEAD']) };
}

function describeShape({ fixtures, gestures }) {
  return `${fixtures.length} fixtures x ${gestures.length} gestures`;
}

/*
 * The base comparison. `origin/main` rather than local `main`: local `main` was
 * reset once during a long evening and two branches were stranded against it,
 * so the ref a lane's work is measured against is the one the integrator pushes.
 *
 * `SHEAF_MATRIX_BASE` names a different ref, which is how this check is
 * controlled: point it at a commit that measures one more gesture and the run
 * must name that gesture, point it at one that measures the same and the run
 * must name nothing. A check that only ever complains passes the first half of
 * that pair on its own.
 */
function baseShape() {
  const refs = process.env.SHEAF_MATRIX_BASE ? [process.env.SHEAF_MATRIX_BASE] : ['origin/main', 'main'];
  for (const ref of refs) {
    let src;
    try {
      src = execFileSync('git', ['show', `${ref}:scripts/check-editing.mjs`], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 << 20,
      });
    } catch {
      continue;
    }
    const shape = recordedInstrument(src);
    if (shape) return { ref, shape };
    return { ref, shape: null, why: `${ref} has no INSTRUMENT recorded, so there is nothing to compare` };
  }
  return { ref: null, shape: null, why: 'no origin/main or main in this clone, so there is nothing to compare' };
}

/*
 * Both checks, before the matrix rather than after it: twenty thousand cells
 * measured with the wrong instrument is twenty minutes spent to learn nothing.
 */
/*
 * Said rather than enforced, deliberately. A lane whose base predates the last
 * `--update` will see the counts move and fail on the ledger comparison anyway,
 * so failing here as well would buy nothing and cost a rebase every time anybody
 * regenerates. What it buys is that a count nobody can account for stops being a
 * mystery: the first question is whether the ledger was even written on this
 * history, and until now the file could not answer it.
 */
function sayWhereTheLedgerCameFrom() {
  const at = ledgerBaseIsHere();
  if (!at.known) {
    console.log('ledger: no base commit recorded, so which commit these counts describe is unknown');
    return;
  }
  if (at.here) {
    console.log(`ledger: counts taken on ${at.base.slice(0, 7)}, which is in this history`);
    return;
  }
  /*
   * Factual and quiet, because the ordinary reason is that the commit was renamed: `--update` records a
   * commit; a rebase gives it a new name and so does the cherry-pick that lands it, so this
   * fires on main itself from the moment a ledger change lands there. A line that is usually a false
   * alarm gets ignored inside a day, which would take the real case with it.
   *
   * The real case is a count that moved on a history the ledger was not measured on, and
   * that is said loudly where the moved counts are printed rather than here.
   */
  console.log(`ledger: counts taken on ${at.base.slice(0, 7)}, not in this history (HEAD is ${at.head}); a rebase or cherry-pick does this`);
}

function checkInstrument() {
  console.log(`instrument: ${describeShape(RUNNING)}`);
  sayWhereTheLedgerCameFrom();
  if (ONLY) {
    console.log(`instrument: not compared, because --fixture ${ONLY} narrows the run on purpose`);
    return;
  }

  const ledgerGained = missingFrom(INSTRUMENT.fixtures, RUNNING.fixtures);
  const ledgerGainedG = missingFrom(INSTRUMENT.gestures, RUNNING.gestures);
  const ledgerLost = missingFrom(RUNNING.fixtures, INSTRUMENT.fixtures);
  const ledgerLostG = missingFrom(RUNNING.gestures, INSTRUMENT.gestures);
  if (ledgerGained.length || ledgerGainedG.length || ledgerLost.length || ledgerLostG.length) {
    console.log('\nThis file\'s ledger was written against a different matrix than this file runs.');
    console.log('Every count in KNOWN_GAPS below was measured on that other matrix, so none of');
    console.log('them is evidence about this one. Rewrite the ledger with --update.\n');
    for (const [label, names] of [
      ['fixtures this run has and the ledger does not', ledgerGained],
      ['gestures this run has and the ledger does not', ledgerGainedG],
      ['fixtures the ledger has and this run does not', ledgerLost],
      ['gestures the ledger has and this run does not', ledgerLostG],
    ]) {
      if (names.length) console.log(`  ${label}: ${names.join(', ')}`);
    }
    process.exit(1);
  }

  const base = baseShape();
  if (!base.shape) {
    console.log(`base: ${base.why}`);
    return;
  }
  const behindF = missingFrom(RUNNING.fixtures, base.shape.fixtures);
  const behindG = missingFrom(RUNNING.gestures, base.shape.gestures);
  const aheadF = missingFrom(base.shape.fixtures, RUNNING.fixtures);
  const aheadG = missingFrom(base.shape.gestures, RUNNING.gestures);

  if (aheadF.length || aheadG.length) {
    const added = [...aheadF, ...aheadG].join(', ');
    console.log(`base: this run measures ${added}, which ${base.ref} does not yet. Expected on a branch that adds to the matrix.`);
  }
  if (!behindF.length && !behindG.length) {
    console.log(`base: the same matrix as ${base.ref}, ${describeShape(base.shape)}`);
    return;
  }

  console.log(`\n${base.ref} measures things this run does not, so a green run here says nothing about it.`);
  if (behindF.length) console.log(`  fixtures missing here: ${behindF.join(', ')}`);
  if (behindG.length) console.log(`  gestures missing here: ${behindG.join(', ')}`);
  console.log(`\n  this run: ${describeShape(RUNNING)}`);
  console.log(`  ${base.ref}: ${describeShape(base.shape)}`);
  console.log(`\nRebase onto ${base.ref} and run again. SHEAF_ALLOW_STALE_MATRIX=1 accepts it instead,`);
  console.log('and says so in the output, which is the point of having it rather than nothing.');
  if (process.env.SHEAF_ALLOW_STALE_MATRIX !== '1') process.exit(1);
  console.log(`\nbase: accepted an older matrix than ${base.ref}, because SHEAF_ALLOW_STALE_MATRIX=1`);
}

if (argv.includes('--instrument')) {
  if (UPDATE) {
    const src = readFileSync(SELF, 'utf8');
    const body = `const INSTRUMENT = {\n  fixtures: ${listLiteral(RUNNING.fixtures)},\n  gestures: ${listLiteral(RUNNING.gestures)},\n};`;
    const next = src.replace(/const INSTRUMENT = \{[\s\S]*?\n\};/, body);
    if (next === src) {
      console.log('Could not find the INSTRUMENT block to rewrite.');
      process.exit(2);
    }
    writeFileSync(SELF, next);
    console.log(`INSTRUMENT rewritten: ${describeShape(RUNNING)}`);
    console.log('LEDGER_BASE is untouched, because nothing was measured. Run --update for that.');
    process.exit(0);
  }
  console.log(`instrument: ${describeShape(RUNNING)}`);
  console.log(`  fixtures: ${RUNNING.fixtures.join(' ')}`);
  console.log(`  gestures: ${RUNNING.gestures.join(' ')}`);
  const base = baseShape();
  console.log(base.shape ? `  ${base.ref}: ${describeShape(base.shape)}` : `  base: ${base.why}`);
  sayWhereTheLedgerCameFrom();
  process.exit(0);
}

if (!UPDATE) checkInstrument();

/* -------------------------------------------------------------- the gaps -- */

/*
 * How many cells each class fails at today. A count that moves in either
 * direction fails the run: up is a regression, down means this list is out of
 * date. Rewrite it with `--update`.
 */
const KNOWN_GAPS = {
  "delete-shrinks/autolink/Backspace": { count: 1, note: "at +8: deleting made the page longer: \"Before http://example.test> after\"" },
  "delete-shrinks/autolink/Delete": { count: 1, note: "at +7: deleting made the page longer: \"Before http://example.test> after\"" },
  // These three are the rule's heuristic meeting a tighter rendering, and a person is not
  // affected. Deleting can *invalidate* a marker, and an invalid marker is drawn as the text it
  // now is, which is more characters than the delete removed. Measured: Backspace after the
  // inner `-` of `- Outer item\n  - Inner item` gives `  -Inner item`, which is no longer a list
  // item, so drawing it literally is correct and is what the file says. The forward delete joins
  // the lines and the inner `- ` becomes mid-sentence text, likewise correct.
  //
  // They are new because the rendering got tighter rather than because deleting got worse. Before
  // a marker's trailing space was hidden with the marker, a bullet line drew `•  Outer item` and a
  // nested one `  •  Inner item`, six characters of stray spacing across the two, and that slack
  // is what kept `after <= before` true. Removing the stray spacing was the point of that work.
  //
  // The instrument's own leak detector agrees: `no-leak` does not fire on any of these, so no
  // syntax is appearing that should not. Only the length heuristic does.
  "delete-shrinks/loose-list/Backspace": { count: 1, note: "at +16: deleting made the page longer: \"•First item | | Second item\"" },
  "delete-shrinks/nested-list/Backspace": { count: 1, note: "at +17: deleting made the page longer: \"•Outer item | Inner item\"" },
  "delete-shrinks/nested-list/Delete": { count: 1, note: "at +12: deleting made the page longer: \"•Outer item - Inner item\"" },
  "delete-shrinks/nested-marks/Backspace": { count: 1, note: "at +9: deleting made the page longer: \"Before bold with code** after\"" },
  "delete-shrinks/nested-marks/Delete": { count: 3, note: "at +7: deleting made the page longer: \"Before bold with code** after\"" },
  "delete-shrinks/setext/Backspace": { count: 2, note: "at +11: deleting made the page longer: \"Title here==========\"" },
  "delete-shrinks/setext/Delete": { count: 1, note: "at +10: deleting made the page longer: \"Title here==========\"" },
  "delete-shrinks/table/Backspace": { count: 2, note: "at +33: deleting made the page longer: \"\"" },
  "delete-shrinks/table/Delete": { count: 3, note: "at +0: deleting made the page longer: \"\"" },
  "delete-shrinks/underscore-em/Backspace": { count: 3, note: "at +7: deleting made the page longer: \"Before_slanted_ after\"" },
  "delete-shrinks/underscore-em/Delete": { count: 3, note: "at +6: deleting made the page longer: \"Before_slanted_ after\"" },
  "kind-kept/footdef/type": { count: 3, note: "at +0: the block stopped being a other and became a paragraph" },
  "kind-kept/setext/type": { count: 2, note: "at +11: the block stopped being a heading and became a paragraph" },
  "kind-kept/table/type": { count: 1, note: "at +0: the block stopped being a table and became a paragraph" },
  "no-leak/alert/select-line-Bold": { count: 1, note: "at +0: []! now on screen: \" [!NOTE] | Something worth knowing\"" },
  // The seven autolink classes below are 73 of the cells in this ledger, and they
  // are one defect rather than seven. Every other inline construct has a closing
  // marker a keystroke can reopen, and an autolink's closing `>` has nothing to
  // pair with, so the answer that fixed Enter inside bold, italic, strike,
  // highlight, code and links did not reach this one. Fix the construct, not the
  // gestures: 20 of the 26 cells left in the whole Enter group are this one class.
  "no-leak/autolink/Backspace": { count: 1, note: "at +8: > now on screen: \"Before http://example.test> after\"" },
  "no-leak/autolink/Delete": { count: 1, note: "at +7: > now on screen: \"Before http://example.test> after\"" },
  "no-leak/autolink/DeleteWordBack": { count: 6, note: "at +11: >< now on screen: \"Before <p://example.test> after\"" },
  "no-leak/autolink/DeleteWordForward": { count: 5, note: "at +6: > now on screen: \"Beforehttp://example.test> after\"" },
  "no-leak/bold-italic/DeleteWordBack": { count: 4, note: "at +14: * now on screen: \"Before ** after\"" },
  "no-leak/bold-italic/DeleteWordBackAlt": { count: 3, note: "at +14: * now on screen: \"Before ** after\"" },
  "no-leak/bold-italic/DeleteWordForward": { count: 4, note: "at +6: * now on screen: \"Beforeboth*** after\"" },
  "no-leak/bold/DeleteWordBack": { count: 1, note: "at +16: * now on screen: \"Before **boldafter\"" },
  "no-leak/bold/DeleteWordForward": { count: 1, note: "at +6: * now on screen: \"Beforebold** after\"" },
  "no-leak/code/DeleteWordBack": { count: 1, note: "at +14: ` now on screen: \"Before `codeafter\"" },
  "no-leak/code/DeleteWordForward": { count: 1, note: "at +6: ` now on screen: \"Beforecode` after\"" },
  "no-leak/footdef/Bold": { count: 2, note: "at +2: * now on screen: \"[^**1**]: The note itself\"" },
  "no-leak/footdef/Italic": { count: 2, note: "at +2: * now on screen: \"[^*1*]: The note itself\"" },
  "no-leak/heading-bold/DeleteWordForward": { count: 1, note: "at +15: * now on screen: \"Heading withbold**\"" },
  "no-leak/highlight/DeleteWordBack": { count: 1, note: "at +15: = now on screen: \"Before ==litafter\"" },
  "no-leak/highlight/DeleteWordForward": { count: 1, note: "at +6: = now on screen: \"Beforelit== after\"" },
  "no-leak/image/DeleteWordBack": { count: 1, note: "at +41: ( now on screen: \"Before alt(http://example.test/i.pngafter\"" },
  "no-leak/image/DeleteWordForward": { count: 1, note: "at +6: ]( now on screen: \"Beforealt](http://example.test/i.png) after\"" },
  "no-leak/inline-html/DeleteWordBack": { count: 3, note: "at +15: >< now on screen: \"Before <kbd></kbd> after\"" },
  "no-leak/inline-html/DeleteWordBackAlt": { count: 1, note: "at +21: >< now on screen: \"Before <kbd></kbd> after\"" },
  "no-leak/inline-html/DeleteWordForward": { count: 3, note: "at +6: >< now on screen: \"BeforeEsc</kbd> after\"" },
  "no-leak/italic/DeleteWordBack": { count: 1, note: "at +17: * now on screen: \"Before *slantedafter\"" },
  "no-leak/italic/DeleteWordForward": { count: 1, note: "at +6: * now on screen: \"Beforeslanted* after\"" },
  "no-leak/item-link/DeleteWordForward": { count: 1, note: "at +11: ]( now on screen: \"• Item withtext](http://example.test)\"" },
  "no-leak/link/DeleteWordBack": { count: 1, note: "at +35: []( now on screen: \"Before [text](http://example.testafter\"" },
  "no-leak/link/DeleteWordForward": { count: 1, note: "at +6: ]( now on screen: \"Beforetext](http://example.test) after\"" },
  "no-leak/nested-marks/Backspace": { count: 1, note: "at +9: * now on screen: \"Before bold with code** after\"" },
  "no-leak/nested-marks/Delete": { count: 3, note: "at +7: * now on screen: \"Before bold with code** after\"" },
  "no-leak/nested-marks/DeleteWordBack": { count: 5, note: "at +13: * now on screen: \"Before ** with code** after\"" },
  "no-leak/nested-marks/DeleteWordBackAlt": { count: 3, note: "at +24: * now on screen: \"Before **bold with ** after\"" },
  "no-leak/nested-marks/DeleteWordForward": { count: 6, note: "at +6: * now on screen: \"Beforebold with code** after\"" },
  "no-leak/nested-marks/Undo-Redo": { count: 1, note: "at +27: * now on screen: \"Before **bold with code**X after\"" },
  "no-leak/nested-marks/type": { count: 1, note: "at +27: * now on screen: \"Before **bold with code**X after\"" },
  "no-leak/ref-link/Bold": { count: 4, note: "at +14: * now on screen: \"Before [text][**ref**] after\"" },
  "no-leak/ref-link/Enter": { count: 3, note: "at +9: [] now on screen: \"Before [t][ref] | [ext][ref] after\"" },
  "no-leak/ref-link/Italic": { count: 4, note: "at +14: * now on screen: \"Before [text][*ref*] after\"" },
  "no-leak/ref-link/Shift-Enter": { count: 3, note: "at +9: [] now on screen: \"Before [t][ref] | [ext][ref] after\"" },
  "no-leak/setext/Backspace": { count: 2, note: "at +11: = now on screen: \"Title here==========\"" },
  "no-leak/setext/Delete": { count: 1, note: "at +10: = now on screen: \"Title here==========\"" },
  "no-leak/setext/DeleteWordBack": { count: 2, note: "at +11: = now on screen: \"Title here==========\"" },
  "no-leak/setext/DeleteWordBackAlt": { count: 1, note: "at +21: = now on screen: \"Title here==========\"" },
  "no-leak/setext/DeleteWordForward": { count: 1, note: "at +10: = now on screen: \"Title here==========\"" },
  "no-leak/setext/Enter": { count: 2, note: "at +10: = now on screen: \"Title here | | ==========\"" },
  "no-leak/setext/Quote": { count: 3, note: "at +0: > now on screen: \" Title here | > \"" },
  "no-leak/setext/Shift-Enter": { count: 1, note: "at +10: = now on screen: \"Title here | | ==========\"" },
  "no-leak/setext/Undo-Redo": { count: 2, note: "at +11: = now on screen: \"Title here | X==========\"" },
  "no-leak/setext/select-line-Backspace": { count: 1, note: "at +0: = now on screen: \" | ==========\"" },
  "no-leak/setext/type": { count: 2, note: "at +11: = now on screen: \"Title here | X==========\"" },
  "no-leak/strike/DeleteWordBack": { count: 1, note: "at +16: ~ now on screen: \"Before ~~goneafter\"" },
  "no-leak/strike/DeleteWordForward": { count: 1, note: "at +6: ~ now on screen: \"Beforegone~~ after\"" },
  "no-leak/underscore-em/Backspace": { count: 3, note: "at +7: _ now on screen: \"Before_slanted_ after\"" },
  "no-leak/underscore-em/Delete": { count: 3, note: "at +6: _ now on screen: \"Before_slanted_ after\"" },
  "no-leak/underscore-em/DeleteWordBack": { count: 6, note: "at +9: _ now on screen: \"Before lanted_ after\"" },
  "no-leak/underscore-em/DeleteWordForward": { count: 6, note: "at +9: _ now on screen: \"Before _s after\"" },
  "no-leak/underscore-em/InlineCode": { count: 1, note: "at +11: _ now on screen: \"Before _slanted_ after\"" },
  "no-leak/underscore-em/InlineCode-then-PlainText": { count: 1, note: "at +11: _ now on screen: \"Before _slanted_ after\"" },
  "no-leak/underscore-em/Undo-Redo": { count: 2, note: "at +7: _ now on screen: \"Before X_slanted_ after\"" },
  "no-leak/underscore-em/type": { count: 2, note: "at +7: _ now on screen: \"Before X_slanted_ after\"" },
  "nothing-hidden/h1/DeleteWordBack": { count: 1, note: "at +9: line 3 holds \"# \" and draws as empty" },
  "nothing-hidden/h1/DeleteWordForward": { count: 1, note: "at +2: line 3 holds \"# \" and draws as empty" },
  "nothing-hidden/h2/DeleteWordBack": { count: 1, note: "at +10: line 3 holds \"## \" and draws as empty" },
  "nothing-hidden/h2/DeleteWordForward": { count: 1, note: "at +3: line 3 holds \"## \" and draws as empty" },
  "nothing-hidden/h6/DeleteWordBack": { count: 1, note: "at +14: line 3 holds \"###### \" and draws as empty" },
  "nothing-hidden/h6/DeleteWordForward": { count: 1, note: "at +7: line 3 holds \"###### \" and draws as empty" },
  // These two are the class reading drawn text on a line whose entire drawn content is a widget.
  // An empty task item draws its checkbox and nothing else, so it has no text at all. Measured
  // through the editor's own keymap: Enter at the end of a task item writes the next one, the
  // caret lands at column 6 after the marker rather than at 0 in front of it, and typing gives
  // `- [ ] Z`. So the consequence this class names for an empty heading, the next thing typed
  // landing in front of the marker, does not happen here. A prose scenario holds all three facts
  // and asserts the column, because column 0 is the failure and a checkbox alone is not.
  //
  // Recorded rather than fixed because telling "invisible" from "drawn entirely as a widget" is a
  // change to the instrument: they are the same thing for a heading's `# ` and opposite things
  // here. A `painted` signal was tried on main and reverted; the integrator is taking that up.
  "nothing-hidden/task-done/Enter": { count: 2, note: "at +6: line 3 holds \"- [x] \" and draws as empty" },
  "nothing-hidden/task-open/Enter": { count: 2, note: "at +6: line 3 holds \"- [ ] \" and draws as empty" },
  // The 27 `transform-keeps-text/alert/*` and `transform-twice-settles/alert/*` entries below
  // are one standards disagreement, not 27 defects, and it is older than any of them.
  //
  // The rule says the drawn words must survive a transform. An untitled callout's drawn label
  // is the word "Note", and that word is nowhere in the file: the file holds `[!NOTE]`, and the
  // label is generated from it. So the rule asks a block command to preserve a word nobody
  // typed, which it could only do by writing it into the document — the one thing the editor
  // must never do. The rule is therefore asking for something the product is forbidden to give.
  //
  // What the product does instead is treat that line as chrome and drop it, which is what
  // `blockModel.ts` has always done when reading a block's text and what every block command
  // now does through one predicate in `toolbar.ts`.
  //
  // Fixing this means telling a generated label from a typed one, and today they are the same
  // DOM element: `label: title || name` in `alerts.ts`. That is its own piece of work, with its
  // own issue, and it clears all 27 at once. Until then they sit here rather than being argued
  // about per class.
  "transform-keeps-text/alert/BulletList": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \" • [!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/BulletList-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/BulletList-twice": { count: 2, note: "at +2: the words changed: \"Note | Something worth knowing\" became \"•Something worth knowing\"" },
  "transform-keeps-text/alert/Heading1": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading1-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading1-twice": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading2": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading2-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading2-twice": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading3": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading3-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Heading3-twice": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Highlight-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/InlineCode-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/OrderedList": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \" 1. [!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/OrderedList-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/OrderedList-twice": { count: 2, note: "at +2: the words changed: \"Note | Something worth knowing\" became \"1.Something worth knowing\"" },
  "transform-keeps-text/alert/PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/PlainText-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/PlainText-twice": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Quote": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Quote-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/Quote-twice": { count: 2, note: "at +2: the words changed: \"Note | Something worth knowing\" became \"Something worth knowing\"" },
  "transform-keeps-text/alert/Strike-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/TaskList": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \" • [!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/TaskList-then-PlainText": { count: 2, note: "at +2: the words changed: \" Note | Something worth knowing\" became \"[!NOTE] | Something worth knowing\"" },
  "transform-keeps-text/alert/TaskList-twice": { count: 2, note: "at +2: the words changed: \"Note | Something worth knowing\" became \"Something worth knowing\"" },
  "transform-twice-settles/alert/BulletList-twice": { count: 2, note: "at +2: once gave \"Something worth knowing\", twice gave \"•Something worth knowing\", it started as \"Note | Something worth knowing\", and plain text woul" },
  "transform-twice-settles/alert/OrderedList-twice": { count: 2, note: "at +2: once gave \"Something worth knowing\", twice gave \"1.Something worth knowing\", it started as \"Note | Something worth knowing\", and plain text wou" },
  "transform-twice-settles/ordered-paren/OrderedList-twice": { count: 3, note: "at +0: once gave \"Bracket item\", twice gave \"1. Bracket item\", and it started as \"1) Bracket item\"" },
  "typed-once/nested-marks/type": { count: 1, note: "at +27: typing X gave \"Before **bold with code**X after\" where the line read \"Before bold with code after\"" },
  "typed-once/setext/type": { count: 2, note: "at +11: typing X gave \"Title here | X==========\" where the line read \"Title here | \"" },
  "typed-once/table/type": { count: 1, note: "at +0: typing X gave \"X| a | b | | | --- | --- | | | 1 | 2 |\" where the line read \"\"" },
  "typed-once/underscore-em/type": { count: 2, note: "at +7: typing X gave \"Before X_slanted_ after\" where the line read \"Before slanted after\"" },
  "undo-restores/setext/Highlight-then-PlainText": { count: 2, note: "at +0: undo left \"==Title== here\" where \"Title here\" was" },
  "undo-restores/setext/InlineCode-then-PlainText": { count: 2, note: "at +0: undo left \"`Title` here\" where \"Title here\" was" },
  "undo-restores/setext/Strike-then-PlainText": { count: 2, note: "at +0: undo left \"~~Title~~ here\" where \"Title here\" was" },
  "undo-restores/table/select-line-Backspace": { count: 1, note: "at +0: undo left \"| a | b |\" where \"| a | b |\" was" },
  "undo-restores/table/select-line-type": { count: 1, note: "at +0: undo left \"| a | b |\" where \"| a | b |\" was" },
};

/* --------------------------------------------------------- the machinery -- */

const mod = await editorUnderJsdom(REPO, {
  extra: { blockRangeAt: 'src/webview/blockModel' },
  name: 'check-editing',
});
const { mountProse, blockRangeAt, forceParsing, EditorView } = mod;

/** Type printable text the way CodeMirror's own input path does, input handlers included. */
function type(p, text) {
  const { state } = p.view;
  const { from, to } = state.selection.main;
  for (const handler of state.facet(EditorView.inputHandler)) {
    if (handler(p.view, from, to, text, () => state.update({ changes: { from, to, insert: text } }))) return;
  }
  p.view.dispatch(
    state.update({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    })
  );
}
const helpers = { type };

/*
 * The punctuation Markdown builds its constructs out of. Counted rather than
 * matched, so a construct that draws one of these on purpose, as an ordered
 * list draws its `1.`, is a baseline rather than a failure.
 *
 * The count is over the whole document, though, and that is not enough on its
 * own: pressing Enter on `1) Bracket item` makes a second item, whose marker is
 * *also* drawn, so a second `)` appears on the screen and is correct. Thirteen
 * cells of this rule were that, a new list item being read as leaked syntax.
 *
 * So `)` is not counted. Nothing is lost by it: every construct whose closing
 * paren could leak is a link or an image, and both announce themselves through
 * the `]` and `(` that come with it, which are counted and cannot be drawn on
 * purpose by anything. `(` stays for that reason and `)` has no such job.
 */
const SYNTAX = [...'#>*_~=`[](^|<!'];

/** How many of each syntax character the reader can see. */
function syntaxCounts(text) {
  const counts = new Map();
  for (const c of SYNTAX) counts.set(c, 0);
  for (const ch of text) if (counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  return counts;
}

/** The syntax characters that appeared on screen between `before` and `after`. */
function leaked(before, after) {
  const a = syntaxCounts(before);
  const b = syntaxCounts(after);
  return SYNTAX.filter((c) => b.get(c) > a.get(c));
}

/*
 * Lines that draw something other than their text, so an empty one is not a line
 * a reader has lost.
 *
 * Code and front matter show their own syntax on purpose, and a fence with no
 * language draws as a blank line by design. A quoted line carries the quote's
 * left bar, which the stylesheet gives `tok-quote` as a three-pixel border, so an
 * empty quoted line is a paragraph break inside the quote and looks like one:
 * the bar continues past it and it reads as part of the block rather than as a
 * gap between blocks.
 *
 * That last one was fifteen cells of this file being wrong rather than the
 * editor. The hidden-text rule reads `textContent`, which is the right question
 * for a `# ` that draws as nothing at all and the wrong one for a line whose
 * marker is drawn as a border. A rule that reads one channel has to say which.
 */
const CODE_LINE = /\b(tok-code-block|tok-code-fence|tok-frontmatter|tok-quote)\b/;

/**
 * The kind of block the construct is in, found by its own text rather than by the
 * line number it started on.
 *
 * A gesture may add a line above it, which the divider guard does on purpose, and
 * then line three is a blank line and the construct is on line four. Asking line
 * three what kind it is reported the divider as having stopped being a divider
 * when it had only moved down one, which is the measurement drifting rather than
 * the editor changing anything.
 *
 * Falls back to line three when the text cannot be found, which is what a gesture
 * that genuinely rewrote the construct leaves behind, and is the case the rule
 * exists to catch.
 */
function kindOfConstruct(state, firstLine) {
  for (let n = 1; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text === firstLine) return blockRangeAt(state, state.doc.line(n).from)?.kind ?? null;
  }
  if (state.doc.lines < 3) return null;
  return blockRangeAt(state, state.doc.line(3).from)?.kind ?? null;
}

/** Whether `after` is `before` with exactly the one character `ch` inserted. */
function insertedExactly(before, after, ch) {
  if (after.length !== before.length + 1) return false;
  let i = 0;
  while (i < before.length && before[i] === after[i]) i++;
  return after[i] === ch && after.slice(0, i) + after.slice(i + 1) === before;
}

/**
 * The same question asked of the words alone, with every blank line dropped.
 *
 * Typing next to something drawn as a widget has to be allowed to make a line.
 * The caret at the left edge of a horizontal rule is at the edge of a line that
 * has no text in it at all, and a letter typed there cannot go *into* that line
 * without destroying the rule, so it gets a line of its own with the blank line
 * the rule needs above it. Two lines appear and one character does, and the
 * stricter reading calls that a failure when it is the only correct answer.
 *
 * Dropping the blank lines and joining what is left keeps the rule strict about
 * the thing it is actually for: one character arrived among the words and
 * nothing else there moved. A fence broken by the same keystroke still fails it,
 * because its backticks come back as words.
 *
 * Written as a second reading rather than as an entry in the gap ledger, because
 * the ledger is a list of what is wrong and this is not wrong. A deliberate
 * behaviour recorded there reads as a defect to whoever picks the list up next,
 * and the value of the list is that its rows are true.
 */
function insertedAmongTheWords(before, after, ch) {
  const words = (t) => t.split('\n').filter((l) => l !== '').join('');
  return insertedExactly(words(before), words(after), ch);
}

/**
 * Roughly where a line's own text begins, for picking the handful of caret
 * positions a block command is worth running from. Deliberately its own small
 * rule rather than the editor's: this picks test inputs, and reading them off
 * the code under test would make the matrix agree with whatever that code says.
 */
function markerish(text) {
  return /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(text)?.[0].length ?? 0;
}

/** Every caret position an arrow walk stops at, going right from 0 and left from the end. */
function arrowStops(doc) {
  const stops = new Set();
  for (const [start, key] of [[0, 'ArrowRight'], [doc.length, 'ArrowLeft']]) {
    const p = mountProse(doc);
    settle(p, forceParsing);
    p.select(start);
    stops.add(start);
    for (let i = 0; i < doc.length + 5; i++) {
      const was = p.view.state.selection.main.head;
      p.press(key);
      const now = p.view.state.selection.main.head;
      if (now === was) break;
      stops.add(now);
    }
    p.destroy();
  }
  return [...stops].sort((a, b) => a - b);
}

/* ------------------------------------------------------------- the rules -- */

/*
 * Each rule reads one cell and returns null when it holds, or a one-line account
 * of how it did not. `c` carries the cell: the fixture, the gesture, where the
 * caret was, and the document and drawn text on both sides of the gesture.
 */
const RULES = [
  {
    name: 'no-leak',
    /*
     * Not for a command that asks for a code block, and not for a fixture that is
     * one. Code shows its source: turning `**bold**` into code is supposed to put
     * the asterisks back on the screen, and counting that as a leak marked two
     * hundred cells of correct behaviour as broken.
     */
    applies: (c) => c.fixture.family !== 'raw' && c.gesture.transform !== 'code',
    check: (c) => {
      const chars = leaked(c.before.visible, c.after.visible);
      return chars.length ? `${chars.join('')} now on screen: ${JSON.stringify(c.after.region)}` : null;
    },
  },
  {
    name: 'typed-once',
    /*
     * Not where the character lands somewhere that is not drawn. A link's address
     * is hidden, and the Link command leaves the caret inside one on purpose,
     * because that is how an address gets written: the letters go into the file
     * and none of them appears, which is correct and is the opposite of what this
     * rule is looking for. Same for a code fence's language.
     *
     * Told apart by the document rather than by the position: the file gained the
     * character and the screen did not. A keystroke that wrote nothing at all
     * still fails, because then the document is unchanged too.
     */
    applies: (c) =>
      c.gesture.name === 'type' &&
      !c.gesture.select &&
      !(c.after.visible === c.before.visible && c.after.doc.length === c.before.doc.length + 1),
    check: (c) =>
      insertedExactly(c.before.visible, c.after.visible, 'X') ||
      insertedAmongTheWords(c.before.visible, c.after.visible, 'X')
        ? null
        : `typing X gave ${JSON.stringify(c.after.region)} where the line read ${JSON.stringify(c.before.region)}`,
  },
  {
    name: 'kind-kept',
    applies: (c) => ['type', 'Bold', 'Italic'].includes(c.gesture.name) && !c.gesture.select,
    check: (c) =>
      c.before.kind === c.after.kind ? null : `the block stopped being a ${c.before.kind} and became a ${c.after.kind}`,
  },
  {
    name: 'delete-shrinks',
    applies: (c) => ['Backspace', 'Delete'].includes(c.gesture.name),
    check: (c) =>
      c.after.visible.length <= c.before.visible.length
        ? null
        : `deleting made the page longer: ${JSON.stringify(c.after.region)}`,
  },
  {
    name: 'nothing-hidden',
    applies: (c) => c.fixture.family !== 'raw' && c.after.aligned,
    check: (c) => {
      const source = c.after.doc.split('\n');
      const { drawn, classes } = c.after;
      for (let i = 0; i < drawn.length; i++) {
        if (CODE_LINE.test(classes[i])) continue;
        // A line of nothing but `=` or `-` is chrome for the block it belongs to:
        // the underline of a setext heading, which is drawn as the heading above
        // it, or a thematic break, which is drawn as a rule. Neither has text of
        // its own to lose, and reading them as hidden content marked one of them
        // as a defect in every cell of the fixture that holds one.
        if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(source[i] ?? '')) continue;
        if (source[i]?.trim() && !drawn[i].trim()) return `line ${i + 1} holds ${JSON.stringify(source[i])} and draws as empty`;
      }
      return null;
    },
  },
  {
    name: 'undo-restores',
    applies: (c) => c.gesture.writes && c.after.doc !== c.before.doc,
    check: (c) =>
      c.undo.doc === c.before.doc && c.undo.visible === c.before.visible
        ? null
        : `undo left ${JSON.stringify(c.undo.doc.split('\n')[2])} where ${JSON.stringify(c.before.doc.split('\n')[2])} was`,
  },
  {
    /*
     * Changing what a block is keeps what it says. Compared on the letters alone,
     * so the bullet a list draws, the number an ordered list draws and the space
     * a quote leaves in front of its text are all beside the point: what is being
     * asked is whether the words survived the command.
     */
    name: 'transform-keeps-text',
    /*
     * Not for the code block, whose whole job is to show the source that every
     * other block hides. Turning `:tada:` into code is supposed to put the
     * letters t, a, d and a back on the screen.
     */
    applies: (c) =>
      Boolean(c.gesture.transform) && c.gesture.transform !== 'code' && c.fixture.family !== 'raw',
    check: (c) => {
      const letters = (t) => t.replace(/[^A-Za-z]/g, '');
      const was = letters(c.before.visible);
      const now = letters(c.after.visible);
      return was === now ? null : `the words changed: ${JSON.stringify(c.before.region)} became ${JSON.stringify(c.after.region)}`;
    },
  },
  {
    /*
     * Running a command twice settles somewhere a person can name. There are
     * three such places and no fourth:
     *
     *   back where it started   a toggle, pressed on the kind it toggles
     *   where one press left it a command that sets a kind rather than toggling
     *   plain text             a toggle pressed on a different kind of list, which
     *                          makes it that kind and then takes the list away
     *
     * All three are accepted, because insisting on any one of them called
     * working commands failures: plain idempotence failed every toggle in the
     * editor, and adding only the round trip still failed Bullet on a numbered
     * item, which becomes a bullet and then a paragraph and is right to.
     *
     * What is left is the command that reached none of the three. Code block did
     * that until it was fixed: a second press wrapped the fence in another fence.
     */
    name: 'transform-twice-settles',
    applies: (c) => Boolean(c.gesture.twice) && c.fixture.family !== 'raw' && c.once && c.plain,
    check: (c) =>
      c.after.visible === c.before.visible ||
      c.after.visible === c.once.visible ||
      c.after.visible === c.plain.visible
        ? null
        : `once gave ${JSON.stringify(c.once.region)}, twice gave ${JSON.stringify(c.after.region)}, ` +
          `it started as ${JSON.stringify(c.before.region)}, and plain text would be ${JSON.stringify(c.plain.region)}`,
  },
  {
    name: 'motion-is-read-only',
    applies: (c) => !c.gesture.writes,
    check: (c) => (c.after.doc === c.before.doc ? null : `a motion key wrote ${JSON.stringify(c.after.doc.split('\n')[2])}`),
  },
];

/* --------------------------------------------------------- the self test -- */

/*
 * A rule that never fires proves nothing, and three of these did not fire for a
 * week because of a mistake in this file rather than anything in the editor:
 * `aligned` was computed against a split on the newline instead of the editor's
 * own line count, came out false for every document ever passed to it, and
 * switched off the rule that depends on it. Nothing said so, because a rule that
 * is never asked and a rule that always passes read the same in the report.
 *
 * So each rule is shown one cell it must reject and one it must accept, and the
 * run refuses to go on if any rule cannot tell them apart. It costs no editor
 * mounts: the cells are written out by hand.
 */
function selfTest() {
  const snap = (over = {}) => ({
    doc: 'Lead in.\n\nHeading\n\nTail out.\n',
    drawn: ['Lead in.', '', 'Heading', '', 'Tail out.', ''],
    classes: ['', '', '', '', '', ''],
    visible: 'Lead in.\n\nHeading\n\nTail out.\n',
    line: 'Heading',
    region: 'Heading',
    kind: 'heading',
    aligned: true,
    ...over,
  });
  const cell = (over = {}) => ({
    fixture: { name: 'self', family: 'block', body: '# Heading' },
    gesture: { name: 'type', writes: true, kind: true },
    pos: 10,
    offset: 0,
    before: snap(),
    after: snap(),
    undo: snap(),
    once: snap(),
    plain: snap({ visible: 'plain text version' }),
    ...over,
  });

  /** For each rule, a cell it must reject and a cell it must accept. */
  const CASES = {
    'no-leak': [cell({ after: snap({ visible: 'X# Heading', region: 'X# Heading' }) }), cell()],
    'typed-once': [cell({ after: snap({ visible: 'X# Heading' }) }), cell({ after: snap({ visible: 'XLead in.\n\nHeading\n\nTail out.\n' }) })],
    'kind-kept': [cell({ after: snap({ kind: 'paragraph' }) }), cell()],
    'delete-shrinks': [
      cell({ gesture: { name: 'Backspace', writes: true }, after: snap({ visible: 'Lead in.\n\nHeading#\n\nTail out.\n' }) }),
      cell({ gesture: { name: 'Backspace', writes: true }, after: snap({ visible: 'Lead in.' }) }),
    ],
    'nothing-hidden': [
      cell({ after: snap({ doc: 'Lead in.\n\n# \nHeading\n\nTail out.\n', drawn: ['Lead in.', '', '', 'Heading', '', 'Tail out.'], classes: ['', '', '', '', '', ''] }) }),
      cell(),
    ],
    'undo-restores': [
      cell({ after: snap({ doc: 'changed' }), undo: snap({ doc: 'still changed' }) }),
      cell({ after: snap({ doc: 'changed' }) }),
    ],
    'motion-is-read-only': [
      cell({ gesture: { name: 'ArrowLeft', writes: false }, after: snap({ doc: 'changed' }) }),
      cell({ gesture: { name: 'ArrowLeft', writes: false } }),
    ],
    'transform-keeps-text': [
      cell({ gesture: { name: 'Heading1', transform: 'h1', writes: true }, after: snap({ visible: 'Lead in.' }) }),
      cell({ gesture: { name: 'Heading1', transform: 'h1', writes: true } }),
    ],
    'transform-twice-settles': [
      cell({
        gesture: { name: 'Heading1-twice', transform: 'h1', twice: true, writes: true },
        once: snap({ visible: 'once' }),
        after: snap({ visible: 'a third thing' }),
      }),
      cell({ gesture: { name: 'Heading1-twice', transform: 'h1', twice: true, writes: true }, once: snap({ visible: 'once' }) }),
    ],
  };

  const broken = [];
  for (const rule of RULES) {
    const pair = CASES[rule.name];
    if (!pair) {
      broken.push(`${rule.name}: no self test written for it`);
      continue;
    }
    const [mustFail, mustPass] = pair;
    if (!rule.applies(mustFail)) broken.push(`${rule.name}: skipped the cell it was meant to reject`);
    else if (!rule.check(mustFail)) broken.push(`${rule.name}: accepted a cell it was meant to reject`);
    if (rule.applies(mustPass) && rule.check(mustPass)) broken.push(`${rule.name}: rejected a cell it was meant to accept`);
  }
  return broken;
}

const broken = selfTest();
if (broken.length) {
  console.error('These rules cannot tell a failing cell from a passing one, so the run below would mean nothing:');
  for (const line of broken) console.error(`  ${line}`);
  process.exit(2);
}
if (argv.includes('--self-test')) {
  console.log(`All ${RULES.length} rules reject the cell they are meant to reject and accept the one they are not.`);
  process.exit(0);
}

/* ---------------------------------------------------------------- the run -- */

/** Read everything the rules ask about off a mounted editor. */
function snapshot(p, firstLine) {
  const els = [...p.view.contentDOM.querySelectorAll(':scope > .cm-line')];
  const drawn = els.map((el) => el.textContent ?? '');
  const doc = p.doc();
  return {
    doc,
    drawn,
    classes: els.map((el) => el.className ?? ''),
    visible: drawn.join('\n'),
    line: drawn[2] ?? '',
    // The drawn lines between the lead paragraph and the tail one: the construct
    // and whatever the gesture made of it. Quoting drawn[2] alone reported the
    // opening fence of a code block as the whole of it, which read as the text
    // having been destroyed when it was on the line below.
    region: drawn.slice(2, Math.max(3, drawn.length - 3)).join(' | '),
    kind: kindOfConstruct(p.view.state, firstLine),
    /*
     * One drawn line per document line. A block drawn as a single widget breaks
     * that, and comparing the two lists then compares unrelated lines.
     *
     * Counted against the editor's own line count, never against a split on the
     * newline. A document ending in a newline splits into one more piece than it
     * has lines, this was written to subtract that piece, and the subtraction was
     * on the wrong side: every document came out misaligned and the rule that
     * depends on this never ran once.
     */
    aligned: drawn.length === p.view.state.doc.lines,
  };
}

const failures = new Map();
let cells = 0;
let checks = 0;

for (const fixture of FIXTURES) {
  const { doc, at, body } = fixture;
  const stops = arrowStops(doc).filter((s) => s >= at - 1 && s <= at + body.length + 1);
  const firstLine = body.split('\n')[0];
  const few = [at, at + markerish(firstLine), at + Math.floor(firstLine.length / 2), at + firstLine.length];
  for (const gesture of GESTURES) {
    // A gesture that works on a selection has one cell, not one per caret position;
    // a block command has the four that stand for the rest.
    const positions = gesture.select
      ? [at]
      : gesture.positions === FEW
        ? [...new Set(few.filter((n) => stops.includes(n)))]
        : stops;
    for (const pos of positions) {
      const p = mountProse(doc);
      settle(p, forceParsing);
      if (gesture.select === 'line') {
        const line = p.view.state.doc.lineAt(at);
        p.select(line.from, line.to);
      } else {
        p.select(pos);
      }
      const before = snapshot(p, firstLine);
      let threw = null;
      let once = null;
      let plain = null;
      if (gesture.twice) {
        // What Plain text alone would have made of this, which is the third place
        // two presses of a list command are allowed to settle.
        const q = mountProse(doc);
        settle(q, forceParsing);
        q.select(pos);
        q.press('Mod-Alt-0');
        settle(q, forceParsing);
        plain = snapshot(q, firstLine);
        q.destroy();
      }
      try {
        if (gesture.step) {
          gesture.step(helpers, p);
          settle(p, forceParsing);
          once = snapshot(p, firstLine);
          gesture.step(helpers, p);
        } else {
          gesture.run(helpers, p);
        }
      } catch (e) {
        threw = e;
      }
      settle(p, forceParsing);
      const after = snapshot(p, firstLine);
      p.press('Mod-z');
      settle(p, forceParsing);
      const undo = snapshot(p, firstLine);
      p.destroy();
      cells++;

      const cell = { fixture, gesture, pos, offset: pos - at, before, after, undo, once, plain };
      if (threw) {
        const key = `threw/${fixture.name}/${gesture.name}`;
        const entry = failures.get(key) ?? { count: 0, example: '' };
        entry.count++;
        entry.example ||= `at ${cell.offset}: ${threw.message}`;
        failures.set(key, entry);
        continue;
      }
      for (const rule of RULES) {
        if (!rule.applies(cell)) continue;
        checks++;
        const said = rule.check(cell);
        if (!said) continue;
        const key = `${rule.name}/${fixture.name}/${gesture.name}`;
        const entry = failures.get(key) ?? { count: 0, example: '' };
        entry.count++;
        entry.example ||= `at ${cell.offset >= 0 ? '+' : ''}${cell.offset}: ${said}`;
        failures.set(key, entry);
        if (VERBOSE) console.log(`FAIL ${key} at ${cell.offset}: ${said}`);
      }
    }
  }
}

/* ------------------------------------------------------------- the report -- */

const seen = [...failures.keys()].sort();
const known = Object.keys(KNOWN_GAPS).sort();
const regressed = [];
const improved = [];
const appeared = [];
const vanished = [];

for (const key of seen) {
  const now = failures.get(key).count;
  const was = KNOWN_GAPS[key]?.count;
  if (was === undefined) appeared.push([key, now]);
  else if (now > was) regressed.push([key, was, now]);
  else if (now < was) improved.push([key, was, now]);
}
for (const key of known) if (!failures.has(key)) vanished.push([key, KNOWN_GAPS[key].count]);

const total = [...failures.values()].reduce((n, f) => n + f.count, 0);
console.log(`${cells} cells, ${checks} checks, ${total} of them failing across ${failures.size} classes.\n`);

if (UPDATE) {
  /*
   * A ledger regenerated from whatever is failing right now records today's
   * regressions as tomorrow's baseline, and the ratchet runs backwards. One run
   * did exactly that: it accepted four cells of a live defect and, on a base that
   * had been reset, deleted six cells a fix elsewhere had not made pass, so the
   * ledger was wrong in both directions from a single command.
   *
   * So the two directions are treated differently, because they are different
   * claims. Fewer failures than the ledger records is a fix, and writing it down
   * is the whole point of `--update`. More failures, or a class the ledger has
   * never seen, is a cost being accepted, and accepting a cost is a decision
   * somebody makes rather than a number a tool writes.
   */
  const worse = [...appeared.map(([k, now]) => [k, 0, now]), ...regressed];
  if (worse.length && !argv.includes('--accept-worse')) {
    console.log('Refusing to write. These classes fail more cells than the ledger records,');
    console.log('and folding them in is how a live regression becomes an accepted cost:\n');
    for (const [key, was, now] of worse) {
      console.log(`  ${key}  ${was} -> ${now}`);
      console.log(`      ${failures.get(key).example}`);
    }
    console.log('\nFix them, or pass --accept-worse if they are a cost you are choosing, and write');
    console.log('a comment above each one saying why. Comments in the ledger are carried through');
    console.log('now, so that reason survives the next regeneration.');
    process.exit(1);
  }

  /*
   * Only when something actually moved. Writing identical counts against a base this
   * checkout does not contain encodes nothing new, and the one thing it does do is useful:
   * it re-stamps LEDGER_BASE onto a commit that exists here.
   *
   * That case is not rare, it is every landing. The integrator lands by cherry-picking, so
   * every commit gets a new name on the way in and LEDGER_BASE dangles on main immediately
   * afterwards, by construction. Refusing there blocked the integrator from re-stamping it
   * and left the only route through SHEAF_ALLOW_STALE_MATRIX=1, which is the wrong thing to
   * teach anybody to reach for.
   */
  const at = ledgerBaseIsHere();
  const moved = regressed.length + appeared.length + improved.length + vanished.length;
  if (moved && at.known && !at.here && process.env.SHEAF_ALLOW_STALE_MATRIX !== '1') {
    console.log(`Refusing to write. The ledger's counts were taken on ${at.base.slice(0, 7)}, which is not in`);
    console.log(`this history (HEAD is ${at.head}), so what looks like a fix here may be work this`);
    console.log('checkout simply does not contain. Rebase and run again, or set');
    console.log('SHEAF_ALLOW_STALE_MATRIX=1 if you mean to write a ledger for this history.');
    process.exit(1);
  }

  const src = readFileSync(SELF, 'utf8');
  const prose = ledgerProse(src);
  const lines = [];
  for (const key of seen) {
    const written = prose.above.get(key);
    if (written) lines.push(...written);
    const { count, example } = failures.get(key);
    const note = KNOWN_GAPS[key]?.note ?? example.replace(/\s+/g, ' ').slice(0, 150);
    lines.push(`  ${JSON.stringify(key)}: { count: ${count}, note: ${JSON.stringify(note)} },`);
  }
  // A comment whose class no longer fails is kept rather than dropped, because a
  // person wrote it and a tool deleting it is the defect this is fixing. It is
  // moved to the end and said out loud, which is the reader's cue to retire it.
  const orphaned = [...prose.above.entries()].filter(([key]) => !failures.has(key));
  if (orphaned.length) {
    lines.push('');
    lines.push('  // Written about classes that no longer fail. Kept because deleting a person\'s');
    lines.push('  // reasoning is what this generator used to do. Retire them by hand.');
    for (const [key, written] of orphaned) {
      lines.push(`  //   ${key}:`);
      for (const line of written) lines.push(line.trim().startsWith('//') ? `  ${line.trim()}` : `  // ${line.trim()}`);
    }
  }
  if (prose.trailing.some((l) => l.trim())) lines.push(...prose.trailing);

  const head = git(['rev-parse', 'HEAD']);
  // The instrument and the base commit go with the counts. Writing the counts
  // alone is how a ledger comes to describe a matrix, or a commit, that is no
  // longer there, which is the whole reason either is recorded.
  const shape = `const INSTRUMENT = {\n  fixtures: ${listLiteral(RUNNING.fixtures)},\n  gestures: ${listLiteral(RUNNING.gestures)},\n};`;
  const next = src
    .replace(/const KNOWN_GAPS = \{[\s\S]*?\n\};/, `const KNOWN_GAPS = {\n${lines.join('\n')}\n};`)
    .replace(/const INSTRUMENT = \{[\s\S]*?\n\};/, shape)
    .replace(/const LEDGER_BASE = '[^']*';/, `const LEDGER_BASE = '${head ?? ''}';`);
  writeFileSync(SELF, next);
  console.log(`Ledger rewritten with ${seen.length} classes, for ${describeShape(RUNNING)} on ${head ? head.slice(0, 7) : 'an unknown commit'}.`);
  if (improved.length || vanished.length) {
    console.log(`Lowered ${improved.length} and removed ${vanished.length}, which is what --update is for.`);
  }
  if (worse.length) console.log(`Accepted ${worse.length} class${worse.length > 1 ? 'es' : ''} that got worse, because --accept-worse was passed.`);
  if (orphaned.length) console.log(`Kept ${orphaned.length} written comment${orphaned.length > 1 ? 's' : ''} whose class no longer fails. Read the end of the ledger.`);
  console.log('Read the notes before committing them.');
  process.exit(0);
}

for (const [label, rows] of [
  ['Classes that fail more cells than the ledger records. This is the regression:', regressed],
  ['Classes the ledger has never seen. Either a regression or a gap nobody wrote down:', appeared],
]) {
  if (!rows.length) continue;
  console.log(label);
  for (const row of rows) {
    const [key] = row;
    const { example } = failures.get(key);
    console.log(`  ${key}  ${row.length === 3 ? `${row[1]} -> ${row[2]}` : `${row[1]} cells`}`);
    console.log(`      ${example}`);
  }
  console.log();
}

for (const [label, rows] of [
  ['These now fail fewer cells than the ledger says. Lower the counts with --update:', improved],
  ['These no longer fail at all. Take them out of KNOWN_GAPS with --update:', vanished],
]) {
  if (!rows.length) continue;
  console.log(label);
  for (const row of rows) console.log(`  ${row[0]}  ${row.length === 3 ? `${row[1]} -> ${row[2]}` : `${row[1]} -> 0`}`);
  console.log();
}

const held = known.filter((k) => failures.has(k) && failures.get(k).count === KNOWN_GAPS[k].count);
if (held.length && VERBOSE) {
  console.log('Known gaps, unchanged:');
  for (const key of held) console.log(`  ${key}  ${KNOWN_GAPS[key].count} cells: ${KNOWN_GAPS[key].note}`);
  console.log();
}

const bad = regressed.length + appeared.length + improved.length + vanished.length;
if (!bad) console.log(`Every class matches the ledger: ${held.length} known gaps, nothing new.`);

/*
 * Only where a count has actually moved. A ledger measured on a commit this checkout does
 * not contain is harmless while every class matches, because the counts are then
 * demonstrably right for the tree in front of you whatever they were taken on. It stops
 * being harmless the moment one of them moves, because then there are two explanations and
 * the reader cannot tell them apart from the numbers.
 */
if (bad) {
  const at = ledgerBaseIsHere();
  if (at.known && !at.here) {
    console.log(`The ledger's counts were taken on ${at.base.slice(0, 7)}, which is not in this history (HEAD is ${at.head}).`);
    console.log('So a class above may have moved because of work this checkout does not contain rather');
    console.log('than because of anything you did. Rebase and run again before believing either.');
    console.log();
  }
}
process.exit(bad ? 1 : 0);
