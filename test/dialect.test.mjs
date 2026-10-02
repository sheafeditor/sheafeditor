/*
 * The dialect conformance suite: Markdown in, construct boundaries out.
 *
 * Each case names the rule it is about and prints what it saw when it fails, because the
 * reason this suite exists is to find out where the written specification and the code
 * disagree. A case that failed and printed only its name would say that one of them is
 * wrong without saying which.
 *
 * A case returns `true`, or a string describing what it read.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { parse, constructs, nodesNamed, has, census, blockMaths } = createRequire(import.meta.url)('./dialect.bundle.cjs');

const j = (x) => JSON.stringify(x);

/** A node of `name` covering exactly `text`, which is the shape most rules take. */
const covers = (src, name, text) => {
  const found = nodesNamed(src, name);
  if (found.length === 1 && found[0].text === text) return true;
  return `${name} in ${j(src)} came out as ${j(found.map((n) => n.text))}, wanted exactly [${j(text)}]`;
};

/** No node of `name` anywhere in `text`. */
const absent = (src, name) => {
  if (!has(src, name)) return true;
  return `${name} in ${j(src)} came out as ${j(nodesNamed(src, name).map((n) => n.text))}, wanted none`;
};

const cases = [
  // ---- Strikethrough: a run of one tilde or two, which is wider than GFM's --------------
  ['~struck~ is a Strikethrough, which GFM alone would not read', () => covers('~struck~', 'Strikethrough', '~struck~')],
  ['~~struck~~ is a Strikethrough', () => covers('~~struck~~', 'Strikethrough', '~~struck~~')],
  ['~~~struck~~~ is text', () => absent('~~~struck~~~', 'Strikethrough')],
  ['~~a~ stays as typed', () => absent('~~a~', 'Strikethrough')],
  ['~/notes opens nothing', () => absent('a ~/notes path', 'Strikethrough')],

  // ---- Emoji: the shortcode shape, with the names GFM's own rule would drop -------------
  ...[':+1:', ':-1:', ':e-mail:', ':t-rex:', ':non-potable_water:'].map((src) => [
    `${src} is an Emoji node`,
    () => covers(src, 'Emoji', src),
  ]),
  [
    'a name no table holds is still an Emoji node, because parsing is shape and the lookup is separate',
    () => covers(':not_a_real_emoji_name:', 'Emoji', ':not_a_real_emoji_name:'),
  ],

  // ---- Highlight -----------------------------------------------------------------------
  ['==x== is a Highlight', () => covers('==x==', 'Highlight', '==x==')],
  /*
   * `===x===` **is** a Highlight, and the specification says it is not. The code is what this
   * records, with the disagreement named, because a suite that asserted the document would be
   * red about something nobody has decided to change.
   *
   * Why it happens. `highlight.ts` refuses a run of three only at the run's first character:
   * `cx.char(pos + 2) === 61` stops the `=` at index 0, and the `=` at index 1 then opens a
   * delimiter because the character after its pair is `x`. `strikethrough.ts` has two guards
   * this one lacks: it returns early when the previous character is a tilde, so only the first
   * of a run decides, and it measures the whole run and refuses anything longer than two.
   *
   * So the two spellings disagree with each other about the same shape, and `highlight.ts`'s
   * own comment says its delimiters "follow the same flanking rules as GFM strikethrough",
   * which is the sentence that is false. Filed rather than fixed here: whether `===x===`
   * should highlight is a product question.
   */
  [
    '===x=== is a Highlight today, which the specification denies and strikethrough refuses for its own spelling',
    () => covers('===x===', 'Highlight', '==x==='),
  ],
  [
    'the asymmetry itself: a run of three tildes is text and a run of three equals is not',
    () => {
      const tildes = has('~~~x~~~', 'Strikethrough');
      const equals = has('===x===', 'Highlight');
      if (!tildes && equals) return true;
      return `~~~x~~~ has Strikethrough ${tildes} and ===x=== has Highlight ${equals}, so the asymmetry has moved`;
    },
  ],

  // ---- Inline maths: github.com's narrow delimiter rules --------------------------------
  ['$5 or $10 is text, so prices are not equations', () => absent('$5 or $10', 'InlineMath')],
  ['$ 5 opens nothing, because a space after the dollar is not a delimiter', () => absent('$ 5 is not maths', 'InlineMath')],
  ['a $ span does not cross a line break', () => absent('$a\nb$', 'InlineMath')],
  ['a $ span never contains a backtick', () => absent('$a`b$', 'InlineMath')],
  [
    'an escaped dollar inside a span is a dollar sign rather than the end of it',
    () => {
      const src = '$a \\$ b$';
      const found = nodesNamed(src, 'InlineMath');
      if (found.length === 1 && found[0].text === src) return true;
      return `InlineMath in ${j(src)} came out as ${j(found.map((n) => n.text))}, wanted the whole span`;
    },
  ],
  ['a plain $x$ is an InlineMath, so the cases above are refusals rather than the rule being off', () => covers('$x$', 'InlineMath', '$x$')],

  // ---- Block maths, which is a drawing rule rather than a parse rule --------------------
  [
    '$$E = mc^2$$ on its own line is one block',
    () => {
      const got = blockMaths('$$E = mc^2$$\n');
      if (got.length === 1 && got[0].source === 'E = mc^2') return true;
      return `blockMaths read ${j(got)}`;
    },
  ],
  [
    'a $$ block inside a fence stays source',
    () => {
      const got = blockMaths('```\n$$E = mc^2$$\n```\n');
      return got.length === 0 ? true : `blockMaths read ${j(got)} inside a fence`;
    },
  ],
  [
    'an unclosed $$ leaves the rest of the document alone',
    () => {
      const got = blockMaths('$$\nE = mc^2\n\nA later paragraph.\n');
      return got.length === 0 ? true : `blockMaths read ${j(got)} for an unclosed opener`;
    },
  ],
  [
    'a $$ block indented four spaces is an indented code block, so its delimiters are text',
    () => {
      const got = blockMaths('    $$E = mc^2$$\n');
      return got.length === 0 ? true : `blockMaths read ${j(got)} four spaces in`;
    },
  ],
  [
    'a $$ block inside a quote is not one, because it is not at the top level',
    () => {
      const got = blockMaths('> $$E = mc^2$$\n');
      return got.length === 0 ? true : `blockMaths read ${j(got)} inside a quote`;
    },
  ],

  // ---- Brackets inside a link's text ----------------------------------------------------
  [
    '[link [with] brackets](url) is one link whose text holds the inner brackets',
    () => {
      const src = '[link [with] brackets](https://example.com)';
      const links = nodesNamed(src, 'Link');
      if (links.length !== 1 || links[0].text !== src) return `Link came out as ${j(links.map((n) => n.text))}`;
      return true;
    },
  ],

  // ---- The base is CommonMark, not the parser library's fuller dialect ------------------
  [
    '2^10^ is a literal pair of carets, which is what proves the base is CommonMark',
    () => {
      const got = constructs('2^10^');
      return got.includes('Superscript') ? `2^10^ parsed ${j(got)}, so the base is not CommonMark` : true;
    },
  ],
  [
    '~text~ is strikethrough rather than Pandoc subscript, the other half of the same proof',
    () => {
      const got = constructs('~text~');
      if (got.includes('Subscript')) return `~text~ parsed ${j(got)}, so the base is not CommonMark`;
      return got.includes('Strikethrough') ? true : `~text~ parsed ${j(got)}, with no Strikethrough`;
    },
  ],

  // ---- Footnotes -----------------------------------------------------------------------
  ['[^ spaced] is text', () => absent('[^ spaced]\n\n[^ spaced]: a note\n', 'FootnoteReference')],
  ['[^] is text', () => absent('[^]\n', 'FootnoteReference')],
  /*
   * A `[^label]` with no definition **is** a `FootnoteReference` node, and the specification
   * says it stays as written. Both are true of different layers, and the specification states
   * the wrong one as a dialect rule.
   *
   * The parser produces the node from shape alone: an opening `[^`, a label that ends, and no
   * `(` after the `]`. Whether a definition exists is decided when the document is drawn, which
   * is why `footnotes.ts` carries a separate `FootnoteRef` for "a `[^label]` in the text whose
   * label has a definition" and says at the top that the numbers are worked out on every
   * redraw. "Stays as written" is the drawing rule, not the parse.
   *
   * Same category error as the `$$` rules, which the specification also states as dialect.
   */
  [
    'a [^label] with no definition is still a FootnoteReference node, because the definition is a drawing question',
    () => covers('see [^nowhere] here\n', 'FootnoteReference', '[^nowhere]'),
  ],
  [
    'a [^label] with a definition is a FootnoteReference, so the refusals above are the rule and not its absence',
    () => covers('see [^a] here\n\n[^a]: a note\n', 'FootnoteReference', '[^a]'),
  ],
  [
    '[^x] inside inline code is never a footnote',
    () => absent('`[^x]` here\n\n[^x]: a note\n', 'FootnoteReference'),
  ],
  [
    '[^x] inside a fence is never a footnote',
    () => absent('```\n[^x]\n```\n\n[^x]: a note\n', 'FootnoteReference'),
  ],
  [
    'the first definition of a label wins',
    () => {
      const src = 'see [^a]\n\n[^a]: first\n\n[^a]: second\n';
      const defs = nodesNamed(src, 'FootnoteDefinition');
      if (defs.length === 0) return 'no FootnoteDefinition at all';
      return defs[0].text.includes('first') ? true : `the first definition read ${j(defs[0].text)}`;
    },
  ],
];

/*
 * The corpus, parsed, as a ratchet rather than as assertions.
 *
 * A per-rule suite cannot catch a dialect change nobody intended, because nobody writes a
 * case for a construct they did not mean to change. A census of every document in `sample/`
 * does: the numbers are recorded here, and a change to any of them is a change to the
 * dialect that has to be explained or reverted.
 *
 * Counts rather than positions, because a position moves whenever anybody edits the corpus
 * and a count moves only when the parse does.
 */
const CORPUS = join(import.meta.dirname, '..', 'sample');

/*
 * Every `.md` at every depth, not just the top level.
 *
 * The first version read `readdirSync` without recursing and took 8 documents of 85. It then
 * reported that five of Sheaf's own dialect extensions appear nowhere in the corpus, which
 * would have been a real finding about the corpus and was a fact about the reader: `sample/`
 * has a `dialect/` directory, among others, and the additions are in it. The absence was mine.
 */
const markdownUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? markdownUnder(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []));

const corpusCensus = () => {
  const out = {};
  for (const path of markdownUnder(CORPUS)) {
    out[path.slice(CORPUS.length + 1)] = census(readFileSync(path, 'utf8'));
  }
  return out;
};

let passed = 0;
const failures = [];
for (const [name, check] of cases) {
  const got = check();
  if (got === true) passed++;
  else {
    failures.push(name);
    console.log(`❌ ${name}`);
    console.log(`   ${got}`);
  }
}

/*
 * The census, compared against a committed baseline rather than printed.
 *
 * Printing it is not a ratchet: a reader has to notice the number moved, and nobody reads a
 * passing run. The baseline is `test/dialect.corpus.json`, written by `--accept`, and any
 * difference fails with the construct and both counts named. A dialect change nobody intended
 * is exactly what this catches, and it is the failure a per-rule suite cannot have a case for.
 */
const BASELINE = join(import.meta.dirname, 'dialect.corpus.json');
const seen = corpusCensus();
const total = Object.values(seen).reduce((n, doc) => n + Object.values(doc).reduce((m, c) => m + c, 0), 0);

/*
 * Half the corpus is gitignored, so this gate could not pass in a worktree.
 *
 * `sample/wild/files/` holds openly licensed Markdown written by other people, downloaded by
 * `scripts/fetch-wild-corpus.mjs` and never redistributed from here. The baseline keys 20 of its 85
 * documents under it. A fresh worktree therefore has 65, every count belonging to the other 20 drops
 * to zero, and this failed with hundreds of `N -> 0` rows while passing in the one checkout nobody
 * branches from. **A red line that cannot be green teaches whoever reads it to skip the line**, which
 * is the state in which a real dialect change arrives looking like the noise everybody scrolls past.
 * It also sent a reader to ask for a network download to fix something that was one `ls` away.
 *
 * So the absent documents are reported as absent rather than as changed, and the present ones ratchet
 * exactly as before.
 */
const isWild = (doc) => doc.startsWith('wild/');
const sumOf = (docs, from) => docs.reduce((n, d) => n + Object.values(from[d] ?? {}).reduce((m, c) => m + c, 0), 0);

if (process.argv.includes('--accept')) {
  /*
   * **Refusing to record less than is already recorded, which is one rule rather than a list of the
   * ways a run can be partial.** The first spelling of this refused a checkout with no wild corpus,
   * which is the case that prompted it and is not the dangerous one: that run is already red, so
   * nobody reaches for `--accept` to make it pass. The dangerous one is the census quietly producing
   * nothing. Then the suite is red, accepting is what a person does when a baseline looks stale, and
   * one command records "no constructs anywhere" as the expected parse. Every run after that is green.
   *
   * So the question asked here is not which documents are missing but whether this run saw **less than
   * the file it is about to overwrite**. That covers the absent corpus, the broken census, a deleted
   * sample document and whatever the next one is, and it is the state the v0.2.0 failure was: not a
   * check that missed something, but a state nobody wanted written down as the expected one.
   *
   * A deliberate shrink is real, so there is a way through, and it has to be said out loud rather
   * than discovered: `--shrink` alongside `--accept`, in the same commit as whatever removed the
   * documents.
   */
  const typesSeen = new Set(Object.values(seen).flatMap((doc) => Object.keys(doc)));
  const before = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
  const was = before ? sumOf(Object.keys(before), before) : 0;
  const absentWild = before ? Object.keys(before).filter((d) => isWild(d) && !(d in seen)).length : 0;

  if (typesSeen.size === 0) {
    console.log('\nRefusing to write a baseline naming no construct types at all: whatever produced it,');
    console.log('the census is not reading the corpus, and recording this would make every later run');
    console.log('green against an empty expectation. Fix the census first.');
    failures.push('corpus census');
  } else if (before && total < was && !process.argv.includes('--shrink')) {
    console.log(`\nRefusing to record less than the baseline already holds: ${total} counts against ${was}, ${was - total} fewer.`);
    if (absentWild) {
      console.log(`${absentWild} wild document(s) are not in this checkout, which is the likely cause: they are`);
      console.log('gitignored and arrive through scripts/fetch-wild-corpus.mjs. Run that, then accept.');
    }
    console.log('If the corpus really did get smaller, pass --shrink as well, in the commit that removed it.');
    failures.push('corpus census');
  } else {
    writeFileSync(BASELINE, JSON.stringify(seen, null, 2) + '\n');
    console.log(`\ncorpus baseline written: ${Object.keys(seen).length} documents, ${total} constructs`);
  }
} else {
  const want = JSON.parse(readFileSync(BASELINE, 'utf8'));
  // Absent because the corpus was never fetched, which is not the same event as a count changing.
  const absent = Object.keys(want).filter((doc) => isWild(doc) && !(doc in seen));
  const compared = [...new Set([...Object.keys(want), ...Object.keys(seen)])].filter((doc) => !absent.includes(doc));
  const drift = [];
  for (const doc of compared) {
    const a = want[doc] ?? {};
    const b = seen[doc] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[name] ?? 0) !== (b[name] ?? 0)) drift.push(`${doc}: ${name} ${a[name] ?? 0} -> ${b[name] ?? 0}`);
    }
  }

  /*
   * The vacuous-pass guard, and it is about coverage rather than volume.
   *
   * A document count would be the obvious floor and it is the wrong one: the absent 20 carry **58% of
   * the counts**, so "65 of 85 compared" is a true sentence that sounds far better than it is. What
   * makes the smaller run worth anything is a measured fact about those 20: **every one of the 58
   * construct types in the baseline also appears in the tracked 65, and none appears only in a wild
   * document.** So the absent half adds weight and no coverage, and this gate still sees every
   * construct the dialect can produce.
   *
   * That is the thing to assert, because it is the thing that could stop being true. A type whose only
   * remaining example is in a gitignored file would make a worktree run blind to it while reporting
   * everything as matching.
   */
  /*
   * **Both lists come from the baseline file, and that is what makes the guard able to fail.**
   * Worth stating because the version that works and the version that cannot are indistinguishable
   * from outside, and only one of them is a check. `want` is every document the baseline knows,
   * including the 20 this run may not be able to read, so a type named only in those has no example
   * among the 65 and this fires. Derived instead from the documents the run *parsed*, the list would
   * be computed from the same documents it is then checked against, every type would be covered by
   * construction, and it would pass in exactly the configuration it exists for.
   *
   * `typesCompared` reads `want[doc]` rather than `seen[doc]` for the same reason, and the two agree
   * anyway wherever it matters: this runs only when `drift` is empty, which is to say only when the
   * compared documents parsed exactly as the baseline says.
   */
  const typesWanted = new Set(Object.values(want).flatMap((doc) => Object.keys(doc)));
  const typesCompared = new Set(compared.flatMap((doc) => Object.keys(want[doc] ?? seen[doc] ?? {})));
  const uncovered = [...typesWanted].filter((t) => !typesCompared.has(t)).sort();

  if (drift.length) {
    console.log(`\n❌ the corpus parses differently than the baseline, on ${drift.length} count(s):`);
    for (const line of drift.slice(0, 20)) console.log(`   ${line}`);
    if (drift.length > 20) console.log(`   ... and ${drift.length - 20} more`);
    console.log('   Explain the dialect change and run with --accept, or revert it.');
    failures.push('corpus census');
  } else if (typesWanted.size === 0) {
    /*
     * The empty case, which the guard above cannot distinguish from success on its own: with no types
     * named, nothing is uncovered and it would report that every one of zero types is covered.
     * "Covered nothing" and "nothing to cover" are different answers and collapsing them is what
     * failed the whole v0.2.0 release build.
     */
    console.log('\n❌ the baseline names no construct types at all, so nothing above could have failed.');
    console.log('   Either test/dialect.corpus.json is empty or the census stopped producing counts.');
    failures.push('corpus census');
  } else if (uncovered.length) {
    console.log(`\n❌ ${uncovered.length} construct type(s) exist only in documents this run could not read, so`);
    console.log(`   nothing here would notice them changing: ${uncovered.join(', ')}.`);
    console.log('   Add an example to a tracked document under sample/, or fetch the wild corpus.');
    failures.push('corpus census');
  } else if (absent.length) {
    const missed = sumOf(absent, want);
    console.log(
      `\ncorpus: ${compared.length} of ${Object.keys(want).length} documents compared, ` +
        `${total} of ${total + missed} counts, every one as the baseline has it.`
    );
    console.log(
      `   ${absent.length} not read, worth ${missed} counts (${Math.round((100 * missed) / (total + missed))}% of the census): ` +
        'the wild corpus is gitignored and this checkout has not fetched it.'
    );
    console.log('   All 58 construct types are still covered by the documents git carries, so this is weaker, not blind.');
  } else {
    console.log(`\ncorpus: ${Object.keys(seen).length} documents, ${total} constructs, every count as the baseline has it`);
  }
}

console.log(`\n${passed}/${cases.length} dialect checks passed`);
process.exit(failures.length === 0 && passed === cases.length ? 0 : 1);
