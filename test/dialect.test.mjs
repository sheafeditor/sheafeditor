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

const {
  parse,
  constructs,
  nodesNamed,
  has,
  census,
  blockMaths,
  renderMarkdown,
  scopeOf,
  unimplemented,
  PROFILE_TABLE,
  TAGS,
  HANDLERS,
  PROFILES,
  frontMatterEndOf,
  frontMatterOf,
} = createRequire(import.meta.url)('./dialect.bundle.cjs');

const j = (x) => JSON.stringify(x);

/** A node of `name` covering exactly `text`, which is the shape most rules take. */
const covers = (src, name, text) => {
  const found = nodesNamed(src, name);
  if (found.length === 1 && found[0].text === text) return true;
  return `${name} in ${j(src)} came out as ${j(found.map((n) => n.text))}, wanted exactly [${j(text)}]`;
};

/**
 * A node's own subtree as names and offsets relative to the node's start, which is the shape
 * two occurrences of one construct can be compared by.
 *
 * Relative rather than absolute, so the second reference in a document is comparable with the
 * first. Widths are included because a node could carry a number by growing rather than by
 * appearing, and the whole list is compared rather than searched, because a node added to
 * carry one could be named anything at all.
 */
const subtree = (src, node) =>
  parse(src)
    .filter((n) => n.from >= node.from && n.to <= node.to)
    .map((n) => `${n.name}+${n.from - node.from}+${n.to - n.from}`)
    .join(' ');

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
   * A run of three or more equals is text, matching strikethrough's rule for its own spelling.
   *
   * This case used to assert the opposite, with the disagreement written into its own name, because
   * `===x===` *was* a Highlight covering `==x===` and whether it should be was a product question.
   * It was decided and built on 2026-10-05, so the case now asserts the rule rather than the defect.
   *
   * What was wrong: `highlight.ts` refused a run of three only at the run's first character, so the
   * `=` at index 1 opened a delimiter because the character after its pair was `x`. It now does what
   * `strikethrough.ts` does, which is to let only the first of a run decide and to measure the whole
   * run rather than peek one character past the pair.
   */
  ['===x=== is text, because a run of three or more equals is', () => absent('===x===', 'Highlight')],
  ['====x==== is text too, which a rule peeking one character past the pair would miss', () => absent('====x====', 'Highlight')],
  [
    'the two spellings now agree: a run of three is text in both',
    () => {
      const tildes = has('~~~x~~~', 'Strikethrough');
      const equals = has('===x===', 'Highlight');
      if (!tildes && !equals) return true;
      return `~~~x~~~ has Strikethrough ${tildes} and ===x=== has Highlight ${equals}, so the two have parted again`;
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
  /*
   * ---- The five rules the specification states and nothing measured ------------------
   *
   * Each of these five is a sentence in `16-specification.md` that was written by reading a
   * module. The code is right about all five; what was missing is anything that would notice
   * the code changing underneath the sentence. The only party to have built a renderer from
   * that document got a construct wrong in exactly the way the document's silence invited,
   * and ate every autolink in an 85-document corpus, so a sentence with nothing behind it is
   * the shape of fault to care about here rather than a tidiness question.
   *
   * **All five pass against the tree as it stands, and that is the expected result rather
   * than a tell.** They are not a fix; they are the measurement under rules that already
   * hold. What separates a case that pins a behaviour from one that drives nothing is the
   * control, and each control is recorded in the commit that added these cases: what was
   * broken, what it printed, what had to be true for it to print anything, and that it was
   * put back.
   *
   * **Three of the five assert an ABSENCE, and an absence has no lever in the dialect**,
   * because the behaviour each one refuses — case folding, first-definition-wins, numbering
   * — is computed in `src/webview/footnotes.ts` when the document is drawn. Breaking the
   * drawing side is the wrong control: it would leave the parse exactly as these cases
   * assert, so they would pass while the drawing was wrong, and the control would read as
   * the check being useless. The honest control runs the other way, adding the behaviour to
   * the grammar.
   *
   * **What this harness can and cannot see about an absence.** It reads node names,
   * boundaries and the bytes each node covers. So it can show the tree holds no node that
   * carries a number and no node that distinguishes one case of a label from another. It
   * cannot show the tree holds no numbering *property*, and `parse` derives every node's
   * text by slicing the source, so "the label is not folded in the tree" is not falsifiable
   * here however the grammar behaves. Those two are conformance requirements on a
   * reimplementer, stated in Part 2, rather than measurements of this parser, and the cases
   * below assert only the falsifiable half.
   */

  // Case 1. Part 1's two doubled-dollar guards, which it stated as rules on 2026-10-05.
  [
    '$$x$$ mid-sentence is no InlineMath, which takes both of the doubled-dollar guards',
    () => {
      const src = 'a $$x$$ here';
      const found = nodesNamed(src, 'InlineMath');
      if (found.length === 0) return true;
      /*
       * Where the span opens says which guard went, because the two catch different
       * positions and a case that printed only "there is a span" would not separate them.
       */
      const at = found.map((n) => `${n.from}:${j(n.text)}`).join(', ');
      return (
        `InlineMath in ${j(src)} came out as ${at}, wanted none. A span opening at 2 is the ` +
        'guard on a `$` FOLLOWED by a `$`; one opening at 3 is the guard on a `$` PRECEDED by one.'
      );
    },
  ],
  /*
   * And the same sentence mid-sentence, so the case above is a refusal rather than inline
   * maths not parsing in the middle of a line at all. Without this, deleting the whole
   * `InlineMath` parser would leave case 1 green.
   */
  ['a $x$ in the middle of a sentence is an InlineMath, so the case above is a refusal', () => covers('a $x$ here', 'InlineMath', '$x$')],

  // Case 2. Part 1's label rule names the backslash since 2026-10-05.
  ['[^a\\b] is no FootnoteReference, because a backslash ends a label', () => absent('see [^a\\b] here\n', 'FootnoteReference')],
  /*
   * And what it becomes, which is the half that "it is text" loses. Part 1 says the three
   * rejected spellings are each still a bracket run the parser covers with a `Link`, and a
   * case asserting only the absence would pass if the whole bracket run vanished.
   */
  ['and [^a\\b] is a Link over the whole bracket run, which "it is text" does not say', () => covers('see [^a\\b] here\n', 'Link', '[^a\\b]')],
  ['see [^ab] here is a FootnoteReference, so the backslash is the lever and not the sentence', () => covers('see [^ab] here\n', 'FootnoteReference', '[^ab]')],

  /*
   * Case 3. Two definitions of one label both parse, and the parser picks no winner.
   *
   * **This replaces a case named "the first definition of a label wins", which asserted
   * nothing of the kind.** It read the first `FootnoteDefinition` in document order and
   * checked that it held the word `first`, which is true of any parser that reports nodes in
   * document order and would stay true if the grammar did no resolution at all — which is
   * what it does. So the case was named after a rule that lives in the
   * drawing pass, and a reader sweeping the suite for what backs Part 1's footnote paragraph
   * would have found it and stopped.
   */
  [
    'two definitions of one label both parse, and the parser picks no winner',
    () => {
      /*
       * The two notes are the same length on purpose. `subtree` carries each node's width,
       * so notes reading `first` and `second` differ in the trailing `Paragraph`'s width and
       * the comparison fails on the length of the prose rather than on anything ranking the
       * two. That is what the first spelling of this case did, and the message it printed
       * read exactly like the finding it was written to rule out.
       */
      const src = 'see [^a]\n\n[^a]: one\n\n[^a]: two\n';
      const defs = nodesNamed(src, 'FootnoteDefinition');
      if (defs.length !== 2)
        return `${defs.length} FootnoteDefinition(s) in ${j(src)}, wanted 2: a grammar that resolved labels would drop or merge one`;
      const texts = defs.map((d) => d.text);
      if (texts[0] !== '[^a]: one' || texts[1] !== '[^a]: two') return `the two definitions came out as ${j(texts)}`;
      // Nothing in the tree marks either one as the winner: the two carry the same node
      // names at the same offsets from their own start, so there is no winner to read off.
      if (subtree(src, defs[0]) !== subtree(src, defs[1]))
        return `the two definitions have different shapes, so something is ranking them: ${subtree(src, defs[0])} against ${subtree(src, defs[1])}`;
      return true;
    },
  ],

  /*
   * Case 4. `[^Note]` and `[^note]` parse identically, because the grammar folds no case.
   *
   * Asserted over names and boundaries, which is the falsifiable half: a grammar that folded
   * case in order to resolve a definition would have to put the result somewhere this can
   * see.
   *
   * **The third clause is the one a fold can actually break, and the first two are not.** A
   * document with one definition gives a fold nothing to do, so `[^Note]` and `[^note]`
   * parsing alike would stay true however hard the grammar folded; those two clauses pin the
   * boundaries and no more. Two definitions differing **only in case** is the document where
   * folding has a consequence, because folded resolution collapses them and the second stops
   * being a node. The control adds exactly that, and it fires here and on case 3 together,
   * which is what separates "the grammar picks no winner" from "the grammar does not fold".
   */
  [
    '[^Note] and [^note] parse identically, and two definitions differing only in case both parse',
    () => {
      const shape = (src) =>
        parse(src)
          .map((n) => `${n.name} ${n.from}-${n.to}`)
          .join(' | ');
      const matched = shape('see [^Note]\n\n[^Note]: n\n');
      const lower = shape('see [^note]\n\n[^note]: n\n');
      if (matched !== lower) return `[^Note] and [^note] parse differently:\n   ${matched}\n   ${lower}`;
      const mixed = shape('see [^Note]\n\n[^note]: n\n');
      if (mixed !== matched)
        return `a definition differing only in case parses differently from a matching one, so the grammar is folding:\n   ${matched}\n   ${mixed}`;
      const src = 'see [^a]\n\n[^a]: one\n\n[^A]: two\n';
      const defs = nodesNamed(src, 'FootnoteDefinition').map((n) => n.text);
      if (defs.length !== 2 || defs[0] !== '[^a]: one' || defs[1] !== '[^A]: two')
        return `[^a] and [^A] defined in one document came out as ${j(defs)}, wanted both: a grammar folding case would resolve them to one label and keep one`;
      return true;
    },
  ],

  /*
   * Case 5. No node carries a footnote's number.
   *
   * Two references in one document, whose only difference is the order they appear in, which
   * is where the drawn numbers come from. If the grammar numbered them, the first and the
   * second would differ somewhere in the tree. They do not: same node names, same offsets
   * from their own start, same widths.
   *
   * The node list is compared whole rather than searched for a number, because a numbering
   * node could be called anything. Any extra node under a reference fails this.
   */
  [
    'no node carries a footnote number: the first and second reference are the same shape',
    () => {
      const src = 'see [^a] and [^b]\n\n[^a]: one\n\n[^b]: two\n';
      const refs = nodesNamed(src, 'FootnoteReference');
      if (refs.length !== 2) return `${refs.length} FootnoteReference(s) in ${j(src)}, wanted 2`;
      const want = 'FootnoteReference+0+4 FootnoteMark+0+2 FootnoteLabel+2+1 FootnoteMark+3+1';
      for (const [i, ref] of refs.entries()) {
        if (subtree(src, ref) !== want)
          return `reference ${i + 1} is ${j(subtree(src, ref))}, wanted ${j(want)}: an extra node under a reference is where a number would go`;
      }
      return true;
    },
  ],
];

// ---- The render path: what each profile owes, and why a construct came back as source ------------

/** Run `body` with one entry of an exported table changed, and put it back whatever happens. */
const withEntry = (table, key, value, body) => {
  const had = Object.prototype.hasOwnProperty.call(table, key);
  const was = table[key];
  if (value === undefined) delete table[key];
  else table[key] = value;
  try {
    return body();
  } finally {
    if (had) table[key] = was;
    else delete table[key];
  }
};

/** What `outOfScope` says about `md` under `profile`, as `Construct/reason` strings. */
const reported = (md, profile) => renderMarkdown(md, profile).outOfScope.map((o) => `${o.construct}/${o.reason}`);

const reports = (md, profile, want) => {
  const got = reported(md, profile);
  return j(got) === j(want) ? true : `${j(md)} under ${profile} reported ${j(got)}, wanted ${j(want)}`;
};

/** Every profile must give the same answer, for a rule that does not depend on the profile. */
const reportsInEvery = (md, want) => {
  for (const profile of ['field', 'notes', 'document']) {
    const got = reports(md, profile, want);
    if (got !== true) return got;
  }
  return true;
};

const renderCases = [
  [
    'a construct only document carries comes back differently under notes and under document',
    () => {
      const notes = reports('a $x$ b', 'notes', ['InlineMath/profile']);
      if (notes !== true) return notes;
      return reports('a $x$ b', 'document', ['InlineMath/unimplemented']);
    },
  ],
  [
    'a construct the profile names and nothing draws is unimplemented, in every profile that names it',
    () => reportsInEvery(':rocket:', ['Emoji/unimplemented']),
  ],
  ['a construct no profile names is a profile decision in every profile', () => reportsInEvery('<div>x</div>', ['HTMLBlock/profile'])],
  [
    'a block construct typed into a field is a profile decision and comes back in an inline element',
    () => {
      const out = renderMarkdown('# x', 'field');
      const want = '<span class="sheaf-unrendered" data-construct="ATXHeading1"># x</span>';
      if (out.html !== want) return `${j('# x')} under field came back as ${j(out.html)}, wanted ${j(want)}`;
      return reports('# x', 'field', ['ATXHeading1/profile']);
    },
  ],
  [
    'CONTROL: a row added to the profile table is a reported gap with no other change',
    () => {
      const before = reports('a $x$ b', 'notes', ['InlineMath/profile']);
      if (before !== true) return `before the row was added: ${before}`;
      const added = withEntry(PROFILE_TABLE, 'InlineMath', ['notes', 'document'], () => reports('a $x$ b', 'notes', ['InlineMath/unimplemented']));
      if (added !== true) return `with the row added: ${added}`;
      return reports('a $x$ b', 'notes', ['InlineMath/profile']);
    },
  ],
  [
    'CONTROL: a tag removed from TAGS is a gap, where it used to read as a profile decision',
    () => {
      const present = reports('## x', 'notes', []);
      if (present !== true) return `with the tag present: ${present}`;
      const removed = withEntry(TAGS, 'ATXHeading2', undefined, () => reports('## x', 'notes', ['ATXHeading2/unimplemented']));
      if (removed !== true) return `with the tag removed: ${removed}`;
      return reports('## x', 'notes', []);
    },
  ],
  [
    'CONTROL: a handler removed is a gap too, and the construct it drew is listed by unimplemented()',
    () => {
      const present = reports('- [x] a', 'notes', []);
      if (present !== true) return `with the handler present: ${present}`;
      if (unimplemented('notes').includes('Task')) return 'unimplemented(notes) listed Task while its handler was present';
      const removed = withEntry(HANDLERS, 'Task', undefined, () => {
        const got = reports('- [x] a', 'notes', ['Task/unimplemented']);
        if (got !== true) return got;
        return unimplemented('notes').includes('Task') ? true : `unimplemented(notes) did not list Task with its handler removed: ${j(unimplemented('notes'))}`;
      });
      return removed;
    },
  ],
  [
    'the profile table names only profiles that exist',
    () => {
      const bad = Object.entries(PROFILE_TABLE).filter(([, ps]) => ps.some((p) => !['field', 'notes', 'document'].includes(p)));
      return bad.length === 0 ? true : `rows naming an unknown profile: ${j(bad)}`;
    },
  ],
  [
    'scopeOf separates the three answers for one construct across the three profiles',
    () => {
      const got = ['field', 'notes', 'document'].map((p) => scopeOf('InlineMath', p));
      return j(got) === j(['profile', 'profile', 'unimplemented']) ? true : `InlineMath across field, notes, document was ${j(got)}`;
    },
  ],
];
/*
 * The render path's answer about `$$` blocks, checked against the drawing rule above rather than
 * against a second copy of it.
 *
 * A `$$` block is not a node, so nothing in the render walk meets one and a display equation came
 * back as the paragraph text it parses as, with `outOfScope` empty: the delimiters and the formula
 * as running prose, reported as understood. Both forms did, the three-line one and the one-line one,
 * and the one-line one is the trap, because it sits one `trim` away from the inline span that must
 * stay as it is.
 *
 * The inputs are the ones the rules are stated on a few cases up. Asserting the boundaries again
 * here would be a second statement of "top level only, within one paragraph, not inside a fence",
 * free to agree with the rule while both were wrong; comparing the two answers cannot.
 */
const BLOCK_MATHS_INPUTS = [
  '$$E = mc^2$$\n',
  '$$\nE = mc^2\n$$\n',
  '```\n$$E = mc^2$$\n```\n',
  '$$\nE = mc^2\n\nA later paragraph.\n',
  '    $$E = mc^2$$\n',
  '> $$E = mc^2$$\n',
  'before $$x$$ after',
  'text above\n$$\nE = mc^2\n$$\n',
];

const blockMathsRenderCases = [
  [
    'the render path refuses exactly the $$ blocks the drawing rule finds, in every profile',
    () => {
      for (const md of BLOCK_MATHS_INPUTS) {
        const want = blockMaths(md).map((b) => `${b.from}-${b.to}`);
        for (const profile of ['field', 'notes', 'document']) {
          const got = renderMarkdown(md, profile)
            .outOfScope.filter((o) => o.construct === 'BlockMath')
            .map((o) => `${o.from}-${o.to}`);
          if (j(got) !== j(want)) return `${j(md)} under ${profile}: reported ${j(got)}, the rule finds ${j(want)}`;
        }
      }
      return true;
    },
  ],
  [
    'a three-line $$ block comes back as its own source inside a wrapper that names it',
    () =>
      renders(
        '$$\nx^2\n$$',
        'notes',
        '<p><span class="sheaf-unrendered" data-construct="BlockMath">$$\nx^2\n$$</span></p>',
        ['BlockMath/profile']
      ),
  ],
  [
    'a one-line $$ block does too, and in a field as well as in notes',
    () => {
      const want = '<p><span class="sheaf-unrendered" data-construct="BlockMath">$$E = mc^2$$</span></p>';
      const notes = renders('$$E = mc^2$$', 'notes', want, ['BlockMath/profile']);
      if (notes !== true) return notes;
      return renders('$$E = mc^2$$', 'field', want, ['BlockMath/profile']);
    },
  ],
  [
    'a paragraph that holds a block keeps the prose above it and refuses only the block',
    () =>
      renders(
        'text above\n$$\nx^2\n$$',
        'notes',
        '<p>text above\n<span class="sheaf-unrendered" data-construct="BlockMath">$$\nx^2\n$$</span></p>',
        ['BlockMath/profile']
      ),
  ],
  [
    'CONTROL: $$x$$ in the middle of a sentence stays plain text with nothing reported',
    () => renders('before $$x$$ after', 'notes', '<p>before $$x$$ after</p>', []),
  ],
  [
    'the document profile names a block too, as a gap in this path rather than a decision',
    () => reports('$$\nx^2\n$$', 'document', ['BlockMath/unimplemented']),
  ],
];
cases.push(...renderCases, ...blockMathsRenderCases);

// ---- The render path: what each construct becomes ---------------------------------------------

/** The html `md` renders to under `profile`, with nothing reported out of scope unless `oos` says so. */
const renders = (md, profile, want, oos = []) => {
  const out = renderMarkdown(md, profile);
  if (out.html !== want) return `${j(md)} under ${profile} rendered ${j(out.html)}, wanted ${j(want)}`;
  const got = out.outOfScope.map((o) => `${o.construct}/${o.reason}`);
  return j(got) === j(oos) ? true : `${j(md)} under ${profile} reported ${j(got)}, wanted ${j(oos)}`;
};

/**
 * One example of every construct the render path was asked to cover, each with the construct's own
 * name, the profile it is drawn in, and the exact html. `drawn` lists the constructs a profile's
 * list owes and this path must therefore never report as out of scope.
 */
const DRAWN = [
  ['SetextHeading1', 'Title *x*\n=====\n', 'notes', '<h1>Title <em>x</em>\n</h1>\n'],
  ['SetextHeading2', 'Sub\nline\n---\n', 'notes', '<h2>Sub\nline\n</h2>\n'],
  ['Autolink', 'see <https://e.com/a?x=1&y=2> now', 'field', '<p>see <a href="https://e.com/a?x=1&amp;y=2">https://e.com/a?x=1&amp;y=2</a> now</p>'],
  ['URL', 'see https://e.com/a now', 'field', '<p>see <a href="https://e.com/a">https://e.com/a</a> now</p>'],
  ['Image', '![alt *x*](p.png)', 'document', '<p><img src="p.png" alt="alt x"></p>'],
  ['FencedCode', '```js\nlet a = 1 < 2;\n```\n', 'notes', '<pre>\n<code class="language-js">let a = 1 &lt; 2;\n</code></pre>\n'],
  ['CodeBlock', '    code here\n    more\n', 'notes', '<pre><code>code here\nmore</code></pre>\n'],
  [
    'Table',
    '| a | *b* |\n|:--|--:|\n| 1 | 2 |\n',
    'document',
    '<table><thead><tr><th align="left">a</th><th align="right"><em>b</em></th></tr></thead>\n\n<tbody><tr><td align="left">1</td><td align="right">2</td></tr></tbody></table>\n',
  ],
  ['HorizontalRule', 'a\n\n---\n\nb', 'notes', '<p>a</p>\n\n<hr>\n\n<p>b</p>'],
  [
    'FootnoteReference',
    'see[^1]\n\n[^1]: the note\n',
    'notes',
    '<p>see<sup class="md-footnote-ref" title="the note">1</sup></p>\n\n<div class="md-footnote-def"><sup class="md-footnote-num">1</sup> the note</div>\n',
  ],
  ['Entity', 'a &amp; b &copy; &#35; &#x41;', 'field', '<p>a &amp; b © # A</p>'],
  ['Escape', 'a \\*b\\* c', 'field', '<p>a *b* c</p>'],
  ['HardBreak', 'a  \nb\\\nc', 'notes', '<p>a<br>\nb<br>\nc</p>'],
  ['HTMLTag', 'press <kbd>x</kbd> now', 'notes', '<p>press <span class="tok-html-kbd">x</span> now</p>'],
  // A definition is drawn as nothing, and its line stays so the output is the source's length.
  ['LinkReference', 'See [a][d]\n\n[d]: https://e.com "T"\n', 'notes', '<p>See <a href="https://e.com">a</a></p>\n\n\n'],
];

const drawnCases = DRAWN.map(([construct, md, profile, want]) => [
  `${construct} is drawn in ${profile}: ${j(md)}`,
  () => renders(md, profile, want),
]);

/** Every example, drawn under the richest profile, reports nothing: the document profile owes each one. */
const documentDrawsEach = [
  'every example above is drawn under document too, with nothing reported',
  () => {
    for (const [construct, md, , want] of DRAWN) {
      const got = renders(md, 'document', want);
      if (got !== true) return `${construct}: ${got}`;
    }
    return true;
  },
];

/**
 * Output is the source's number of lines, whatever a construct hides. The comparison against the
 * editor lines the two up by number, so one construct that swallowed a newline would put every line
 * below it against the wrong partner, and the report would read as thousands of disagreements about
 * text that agrees.
 */
const sameLines = [
  'every example is as many lines as its source',
  () => {
    for (const [construct, md, profile] of DRAWN) {
      const html = renderMarkdown(md, profile).html;
      if (html.split('\n').length !== md.split('\n').length) return `${construct}: ${j(md)} has ${md.split('\n').length} lines and ${j(html)} has ${html.split('\n').length}`;
    }
    return true;
  },
];

/**
 * The count a profile owes and cannot yet draw, as a committed expectation rather than a number
 * somebody maintains by hand. A construct added to the table without a drawing, or a drawing
 * removed, changes this list and fails here naming it.
 */
const owedCases = [
  [
    'document owes only what needs a subsystem: emoji, maths and callouts',
    () => {
      const got = unimplemented('document').sort();
      // `BlockMath` joined the list when it got a row of its own rather than being read off the
      // `InlineMath` one. It is owed for the same reason the inline form is: drawing an equation
      // needs KaTeX, which this path does not load, so the source comes back named instead.
      const want = ['BlockMath', 'Callout', 'Emoji', 'InlineMath', 'InlineMathMark'].sort();
      return j(got) === j(want) ? true : `unimplemented(document) was ${j(got)}, wanted ${j(want)}`;
    },
  ],
  [
    'notes owes emoji and nothing else',
    () => {
      const got = unimplemented('notes').sort();
      return j(got) === j(['Emoji']) ? true : `unimplemented(notes) was ${j(got)}, wanted ["Emoji"]`;
    },
  ],
];

/**
 * CONTROL for each drawing above: remove its handler and the construct is owed, reported as
 * `unimplemented`, where it was drawn and reported nothing. The lever is the handler and not the
 * output, so a drawing that was already wrong would still be caught going missing.
 */
const FOOTNOTE = 'see[^1]\n\n[^1]: the note\n';
const removalCases = [
  ...DRAWN.map(([construct, md]) => [construct, md]),
  // The construct the examples above cover through a neighbour: one example holds both footnote nodes.
  ['FootnoteDefinition', FOOTNOTE],
].map(([construct, md]) => [
  `CONTROL: removing the ${construct} handler makes it unimplemented and unimplemented() names it`,
  () => {
    const before = reported(md, 'document');
    if (before.length !== 0) return `with the handler present ${j(md)} reported ${j(before)}`;
    return withEntry(HANDLERS, construct, undefined, () => {
      const got = reported(md, 'document');
      if (!got.every((r) => r.endsWith('/unimplemented')) || got.length === 0) return `with the handler removed ${j(md)} reported ${j(got)}`;
      return unimplemented('document').includes(construct) ? true : `unimplemented(document) did not name ${construct} with its handler removed`;
    });
  },
]);

/*
 * The empty case, asserted rather than left to pass because nothing was compared.
 *
 * Every case above hands the renderer some construct, so a renderer that returned `<p></p>` for no
 * input, or threw on it, would pass all of them. An empty value is the commonest one a consumer
 * passes, a description nobody has written yet, so its answer is pinned in every profile: no
 * element and nothing reported. A value of only whitespace gives back exactly the whitespace, which
 * draws nothing in a page and keeps the source's line count, the property the cases above rely on.
 */
const BLANKS = ['', ' ', '\n', '   \n  ', '\n\n\n', '\t\n'];
const emptyCases = BLANKS.map((md) => [
  `${j(md)} renders as itself with nothing reported, in every profile`,
  () => {
    if (!PROFILES?.length) return `no profile to drive: PROFILES is ${j(PROFILES)}`;
    for (const profile of PROFILES) {
      const out = renderMarkdown(md, profile);
      if (out.html !== md || out.outOfScope.length !== 0) return `${j(md)} under ${profile} came back as ${j(out)}, wanted ${j({ html: md, outOfScope: [] })}`;
    }
    return true;
  },
]);

cases.push(...drawnCases, documentDrawsEach, sameLines, ...owedCases, ...removalCases, ...emptyCases);

/*
 * What must not become markup. Each of these puts a document's text where an attribute or an
 * element would be, and each must come back as text or as a refused destination.
 */
const hostileCases = [
  [
    'an image whose address runs script is refused and its description stays',
    () => renders('![alt](javascript:alert(1))', 'document', '<p>alt</p>'),
  ],
  [
    'an image address cannot leave its attribute',
    () => renders('![a](x"onerror="y)', 'document', '<p><img src="x&quot;onerror=&quot;y" alt="a"></p>'),
  ],
  [
    'an info string that is not a language word does not become a class',
    () => renders('```"><script>\nx\n```\n', 'notes', '<pre>\n<code>x\n</code></pre>\n'),
  ],
  [
    'an angled autolink with a scheme a browser runs is text, not an anchor',
    () => {
      const out = renderMarkdown('<javascript:alert(1)>', 'notes').html;
      return /<a /.test(out) ? `${j(out)} holds an anchor` : true;
    },
  ],
  [
    'an angled address with a scheme that fetches or runs something is text, whichever scheme it is',
    () => {
      for (const md of ['<vbscript:msgbox(1)>', '<data:text/html,x>', '<file:///etc/passwd>', '<irc://x.com/y>']) {
        const out = renderMarkdown(md, 'notes').html;
        if (/<a /.test(out)) return `${j(md)} rendered ${j(out)}, which holds an anchor`;
      }
      return true;
    },
  ],
  [
    'an inline html pair with an attribute is not drawn, so the attribute cannot ride along',
    () => renders('<kbd onclick="x">y</kbd>', 'notes', '<p><span class="sheaf-unrendered" data-construct="HTMLTag">&lt;kbd onclick=&quot;x&quot;&gt;</span>y<span class="sheaf-unrendered" data-construct="HTMLTag">&lt;/kbd&gt;</span></p>', ['HTMLTag/profile', 'HTMLTag/profile']),
  ],
  [
    'an abbreviation title is escaped',
    () => renders('<abbr title="a&amp;&quot;b">x</abbr>', 'notes', '<p><span class="tok-html-abbr" title="a&amp;&quot;b">x</span></p>'),
  ],
  [
    'a table cell cannot close the table around itself',
    () => {
      const out = renderMarkdown('| </td></tr></table><script>x</script> | b |\n|---|---|\n| 1 | 2 |\n', 'document').html;
      return /<script/i.test(out) ? `${j(out)} holds a script element` : true;
    },
  ],
  [
    'an entity cannot decode into markup',
    () => renders('&lt;script&gt;', 'field', '<p>&lt;script&gt;</p>'),
  ],
  ['an unknown entity name stays as written', () => renders('&nosuchentity;', 'field', '<p>&amp;nosuchentity;</p>')],
  ['a numeric entity outside Unicode is the replacement character', () => renders('&#0; &#x110000;', 'field', '<p>� �</p>')],
];
cases.push(...hostileCases);

// ---- Brackets that are not a link ---------------------------------------------------------------

/**
 * A bracket run the parser calls a link and the document never makes one. The brackets are text and
 * what is between them is drawn like any other text, which is what the editor does and what the
 * specification's rule says: the brackets render as written, not the content.
 */
const bracketCases = [
  ['marks inside brackets with no address are drawn', () => renders('[_italic_ in brackets]', 'notes', '<p>[<em>italic</em> in brackets]</p>')],
  ['the same in a field, which carries the marks', () => renders('[_a note_]', 'field', '<p>[<em>a note</em>]</p>')],
  ['doubled brackets keep both pairs and draw the mark', () => renders('[[_TOC_]]', 'notes', '<p>[[<em>TOC</em>]]</p>')],
  ['code, strong and strikethrough are drawn too', () => renders('[`c`] [**b**] [~~s~~]', 'notes', '<p>[<code>c</code>] [<strong>b</strong>] [<s>s</s>]</p>')],
  ['an escape inside is the character it stands for', () => renders('[\\*x\\*]', 'notes', '<p>[*x*]</p>')],
  ['an entity inside is the character it stands for', () => renders('[&copy; x]', 'notes', '<p>[© x]</p>')],
  ['an undefined label after the text is kept as written and the text is drawn', () => renders('[**b**][nope]', 'notes', '<p>[<strong>b</strong>][nope]</p>')],
  ['a bracketed number is unchanged', () => renders('[1.9.4]', 'notes', '<p>[1.9.4]</p>')],
  ['brackets nested in the text stay text', () => renders('[a [b] c]', 'notes', '<p>[a [b] c]</p>')],
  ['an address inside is a link of its own and the brackets stay', () => renders('[see https://e.com]', 'notes', '<p>[see <a href="https://e.com">https://e.com</a>]</p>')],
  ['an undefined reference image keeps its text and draws the marks', () => renders('![_a_ b][nope]', 'document', '<p>![<em>a</em> b][nope]</p>')],
  [
    'a link whose words are an address keeps the words and points at its own destination',
    () => renders('[https://e.com/a](https://e.com/b)', 'notes', '<p><a href="https://e.com/b">https://e.com/a</a></p>'),
  ],
  [
    'CONTROL: a real link is unchanged',
    () => renders('[_text_](https://e.com)', 'notes', '<p><a href="https://e.com"><em>text</em></a></p>'),
  ],
  [
    'CONTROL: a reference link, in its full, collapsed and shortcut forms, draws its text and resolves',
    () => {
      const defs = '\n\n[d]: https://e.com\n';
      const want = '<p><a href="https://e.com"><em>t</em></a></p>';
      for (const src of ['[_t_][d]', '[_t_][]', '[_t_]']) {
        // The collapsed and shortcut forms use their own text as the label, so those two define it.
        const md = src === '[_t_][d]' ? src + defs : `${src}\n\n[_t_]: https://e.com\n`;
        const got = renderMarkdown(md, 'notes').html.replace(/\n+$/, '');
        const text = got.split('\n')[0];
        if (text !== want) return `${j(md)} rendered ${j(got)}, wanted the first block ${j(want)}`;
      }
      return true;
    },
  ],
];
cases.push(...bracketCases);

// ---- Code spans ----------------------------------------------------------------------------------

/**
 * CommonMark takes one space off each end of a code span when the content begins and ends with one
 * and is not all spaces. The padding exists so a span can start or end with a backtick, which makes
 * it syntax and not content. Each case here is one clause of that rule.
 */
const code = (src, inner) => [`${j(src)} is a code span of ${j(inner)}`, () => renders(src, 'notes', `<p><code>${inner}</code></p>`)];
const codeCases = [
  code('`` a ` b ``', 'a ` b'),
  code('`` ` ``', '`'),
  code('` x `', 'x'),
  code('``  a  ``', ' a '),
  code('`x`', 'x'),
  code('` `', ' '),
  code('`  `', '  '),
  code('` a`', ' a'),
  code('`a `', 'a '),
  code('`\na\n`', '\na\n'.slice(1, -1)),
  code('`\n`', '\n'),
  ['padding is stripped the same in a field', () => renders('`` ` ``', 'field', '<p><code>`</code></p>')],
  ['what is inside a span is escaped, with or without padding', () => renders('` <b>&amp; ` and `<i>`', 'notes', '<p><code>&lt;b&gt;&amp;amp;</code> and <code>&lt;i&gt;</code></p>')],
];
cases.push(...codeCases);

// ---- A link with no text -------------------------------------------------------------------------

/**
 * `[](url)` has no words to click, so the address stands for itself, without the angle brackets of a
 * `<url>` destination. An empty anchor is in the page, counts as a link and cannot be seen.
 */
const emptyLinkCases = [
  ['an empty link shows its address as its text', () => renders('[](https://example.com)', 'notes', `<p>${A('https://example.com', 'https://example.com')}</p>`)],
  [
    'an empty link in angle brackets has them off in the address and in the text',
    () => renders('[](<https://example.com>)', 'notes', `<p>${A('https://example.com', 'https://example.com')}</p>`),
  ],
  ['an address with a space in it, in angle brackets, is the text and the destination', () => renders('[](<a file.md>)', 'notes', `<p>${A('a file.md', 'a file.md')}</p>`)],
  ['the text is escaped as the destination is', () => renders('[](https://e.com/?a=1&b=2)', 'notes', `<p>${A('https://e.com/?a=1&amp;b=2', 'https://e.com/?a=1&amp;b=2')}</p>`)],
  ['an empty link with no destination is not a link and leaves no anchor', () => renders('[]()', 'notes', '<p>[]()</p>')],
  [
    'an empty link whose destination is refused is its address as text, with no anchor',
    () => renders('[](javascript:alert(1))', 'notes', '<p>javascript:alert(1)</p>'),
  ],
  ['CONTROL: a link with text is unchanged', () => renders('[x](https://example.com)', 'notes', `<p>${A('https://example.com', 'x')}</p>`)],
  ['CONTROL: a link whose text is a space is unchanged', () => renders('[ ](https://example.com)', 'notes', `<p>${A('https://example.com', ' ')}</p>`)],
  [
    'CONTROL: the angle brackets of a definition come off too, from the other entry point',
    () => rendersTrimmed('[a][d]\n\n[d]: <https://example.com>\n', 'notes', `<p>${A('https://example.com', 'a')}</p>`),
  ],
  [
    'a field draws an empty link the same way',
    () => renders('[](<https://example.com>)', 'field', `<p>${A('https://example.com', 'https://example.com')}</p>`),
  ],
];
cases.push(...emptyLinkCases);

// ---- Link reference definitions ----------------------------------------------------------------

/** What `md` renders to with the whitespace at its end removed, which is all a removed block leaves. */
const rendersTrimmed = (md, profile, want, oos = []) => {
  const out = renderMarkdown(md, profile);
  const html = out.html.trimEnd();
  if (html !== want) return `${j(md)} under ${profile} rendered ${j(html)}, wanted ${j(want)}`;
  const got = out.outOfScope.map((o) => `${o.construct}/${o.reason}`);
  return j(got) === j(oos) ? true : `${j(md)} under ${profile} reported ${j(got)}, wanted ${j(oos)}`;
};

const A = (href, text) => `<a href="${href}">${text}</a>`;

const definitionCases = [
  [
    'every definition is gone from the output and the links that name them resolve',
    () =>
      rendersTrimmed(
        'See [the docs][d] and [the site][s].\n\nA second paragraph.\n\n[d]: https://e.com/docs\n[s]: https://e.com\n',
        'notes',
        `<p>See ${A('https://e.com/docs', 'the docs')} and ${A('https://e.com', 'the site')}.</p>\n\n<p>A second paragraph.</p>`
      ),
  ],
  [
    'a definition with a title is gone',
    () => rendersTrimmed('[a][d]\n\n[d]: https://e.com "The title"\n', 'notes', `<p>${A('https://e.com', 'a')}</p>`),
  ],
  [
    'a definition with its address in angle brackets is gone and its link has no brackets',
    () => rendersTrimmed('[a][d]\n\n[d]: <https://e.com/a b>\n', 'notes', `<p>${A('https://e.com/a b', 'a')}</p>`),
  ],
  ['a definition nothing refers to is gone too', () => rendersTrimmed('A paragraph.\n\n[z]: https://z.com\n', 'notes', '<p>A paragraph.</p>')],
  [
    'a definition inside a list item or a quote is gone',
    () => {
      const inList = rendersTrimmed('- item\n\n  [z]: https://z.com\n', 'notes', '<ul><li>item\n\n  </li></ul>');
      if (inList !== true) return inList;
      return rendersTrimmed('> [z]: https://z.com\n', 'notes', '<blockquote></blockquote>');
    },
  ],
  /*
   * The two guards against removing too much, asserted untrimmed.
   *
   * Over-eager removal eats content, which is a worse failure than printing a definition, so these
   * two take the whole output rather than the output with its trailing whitespace off: a fix that
   * stripped definition-shaped lines from the finished HTML would take the rest of the paragraph
   * with them, and trimming the end is the one place that damage could hide.
   */
  [
    'a line that only looks like a definition, in the middle of a sentence, is text',
    () => renders('See [a]: this is prose here\n', 'notes', '<p>See [a]: this is prose here</p>\n'),
  ],
  [
    'a line that looks like a definition and follows a line of its paragraph is text, because a definition cannot interrupt one',
    () => renders('Some text\n[a]: https://e.com\n', 'notes', `<p>Some text\n[a]: ${A('https://e.com', 'https://e.com')}</p>\n`),
  ],
  [
    'a definition inside a fenced block or an indented one is kept verbatim',
    () => {
      const fenced = rendersTrimmed('```\n[d]: https://e.com\n```\n', 'notes', '<pre>\n<code>[d]: https://e.com\n</code></pre>');
      if (fenced !== true) return fenced;
      return rendersTrimmed('    [d]: https://e.com\n', 'notes', '<pre><code>[d]: https://e.com</code></pre>');
    },
  ],
  [
    'a label matches whatever its case and spacing, and the first definition of it counts',
    () =>
      rendersTrimmed(
        '[Foo   Bar][foo bar] and [x]\n\n[FOO BAR]: https://first.com\n[foo bar]: https://second.com\n[x]: https://x.com\n',
        'notes',
        `<p>${A('https://first.com', 'Foo   Bar')} and ${A('https://x.com', 'x')}</p>`
      ),
  ],
  [
    'a definition inside a quote or a list item defines its label for the whole document',
    () => {
      const inQuote = rendersTrimmed('[a][d]\n\n> [d]: https://e.com\n', 'notes', `<p>${A('https://e.com', 'a')}</p>\n\n<blockquote></blockquote>`);
      if (inQuote !== true) return inQuote;
      return rendersTrimmed('[a][d]\n\n- [d]: https://e.com\n', 'notes', `<p>${A('https://e.com', 'a')}</p>\n\n<ul><li></li></ul>`);
    },
  ],
  [
    'a definition is not a thing a field carries, so it is a profile decision there and nothing resolves',
    () =>
      rendersTrimmed(
        '[a][d]\n\n[d]: https://e.com',
        'field',
        '<p>[a][d]</p>\n\n<span class="sheaf-unrendered" data-construct="LinkReference">[d]: https://e.com</span>',
        ['LinkReference/profile']
      ),
  ],
  [
    'a hostile address in a definition is refused wherever the definition sits',
    () => rendersTrimmed('[a][d]\n\n[d]: javascript:alert(1)\n', 'notes', '<p>a</p>'),
  ],
  /*
   * The whitespace a removed definition leaves behind, asserted rather than trimmed off.
   *
   * **A reader sees nothing**, and that is the whole reason nothing needs doing about it. The
   * newlines a removed block leaves sit between block elements, or trailing inside a list item,
   * and normal flow collapses them in both places: the rendered page is the same page whether
   * they are there or not. That holds with no checker anywhere in the picture. It is bounded by
   * the default handling of white-space, which is all a consumer gets unless it asks otherwise;
   * one that sets `white-space: pre-wrap` on the container would see them.
   *
   * The bytes still differ from what a reader of the promise would expect, which is why this is
   * written down rather than left as a leftover. Every case above goes through `rendersTrimmed`,
   * so what a definition leaves is the one thing none of them looks at.
   *
   * A convenience follows rather than justifies it: the output keeps the source's line count, so
   * the comparison against the editor can read the two a line at a time.
   *
   * So this is a guard rather than a verification. The plausible wrong fix is to strip the blank
   * line as well, which reads like finishing the job.
   */
  [
    'a removed definition leaves the source\'s line count, so the output still reads line for line',
    () => {
      const lineCount = (s) => s.split('\n').length;
      const docs = [
        'See [the docs][d] and [the site][s].\n\nA second paragraph.\n\n[d]: https://e.com/docs\n[s]: https://e.com\n',
        'A paragraph.\n\n[z]: https://z.com\n',
        '[a][d]\n\n[d]: https://e.com "The title"\n',
        // A line that only looks like a definition keeps its words, so its count holds for the
        // opposite reason: nothing was removed at all.
        'See [a]: this is prose here\n',
      ];
      for (const md of docs) {
        const html = renderMarkdown(md, 'notes').html;
        if (lineCount(html) !== lineCount(md)) {
          return `${j(md)} rendered ${lineCount(html)} line(s) where the source has ${lineCount(md)}: ${j(html)}`;
        }
      }
      return true;
    },
  ],
];
cases.push(...definitionCases);

// ---- Front matter ------------------------------------------------------------------------------

/*
 * The fields parser, asked what it returns rather than whether it threw.
 *
 * Every case here prints the whole answer when it fails, because the failure this parser exists to
 * prevent is a value that came back looking plausible and wrong. "It did not throw" is satisfied by
 * a nested map read as its first leaf, which is the exact misparse that puts a wrong tag on a card,
 * so a case that only caught an exception would pass over it.
 */

/** A document with `body` as its front matter and one line of prose under it. */
const fm = (body) => `---\n${body}\n---\n\nBody.\n`;

/** The fields and refusals `body` produces, as the two things a caller reads. */
const parsed = (body) => {
  const out = frontMatterOf(fm(body));
  return { fields: out.fields, refused: out.notUnderstood.map((n) => `${n.key ?? '(line)'}/${n.reason}`) };
};

/** `body`'s fields are exactly `fields` and it refused exactly `refused`. */
const gives = (body, fields, refused = []) => {
  const got = parsed(body);
  if (j(got.fields) === j(fields) && j(got.refused) === j(refused)) return true;
  return `${j(body)} gave fields ${j(got.fields)} and refused ${j(got.refused)}, wanted ${j(fields)} and ${j(refused)}`;
};

const scalar = (text) => ({ kind: 'scalar', text });
const list = (...items) => ({ kind: 'list', items });

const frontMatterCases = [
  // ---- Where the block ends, which the move must not disturb ----------------------------
  ['front matter opening line 1 ends at its closing fence', () => frontMatterEndOf('---\na: 1\n---\n\nx\n') === 3 || `got ${frontMatterEndOf('---\na: 1\n---\n\nx\n')}`],
  ['the `...` closing spelling is accepted', () => frontMatterEndOf('---\na: 1\n...\n\nx\n') === 3 || `got ${frontMatterEndOf('---\na: 1\n...\n\nx\n')}`],
  ['a rule in the body is a divider and not front matter', () => frontMatterEndOf('# T\n\n---\n\nx\n') === 0 || `got ${frontMatterEndOf('# T\n\n---\n\nx\n')}`],
  [
    '`---` with a blank line under it is a heading underline rather than an opening fence',
    () => frontMatterEndOf('---\n\n---\n') === 0 || `got ${frontMatterEndOf('---\n\n---\n')}`,
  ],

  // ---- The supported subset -------------------------------------------------------------
  ['two ordinary keys give two fields', () => gives('title: Ship it\nstatus: Todo', { title: scalar('Ship it'), status: scalar('Todo') })],
  ['a number and a boolean come back as the text that was written, because types are advisory', () => gives('estimate: 3\ndone: false', { estimate: scalar('3'), done: scalar('false') })],
  ['a value holding a colon with no space after it is one value', () => gives('url: https://example.com/a:b', { url: scalar('https://example.com/a:b') })],
  ['a quoted value containing a colon is read whole', () => gives("updated: '2025-09-06 21:22'", { updated: scalar('2025-09-06 21:22') })],
  ['a quoted date is its text without the quotes', () => gives("created: '2025-07-23'", { created: scalar('2025-07-23') })],
  ['a double-quoted value carries its escapes', () => gives('title: "a \\"b\\" c"', { title: scalar('a "b" c') })],
  ["`''` inside a single-quoted value is one quote", () => gives("title: 'it''s here'", { title: scalar("it's here") })],
  ['a flow sequence is one field with several values', () => gives('tags: [design, library]', { tags: list('design', 'library') })],
  ['an empty flow sequence is an empty list rather than the text `[]`', () => gives('assignee: []', { assignee: list() })],
  ['a quoted item in a flow sequence keeps its spaces and commas', () => gives('tags: ["a, b", c]', { tags: list('a, b', 'c') })],
  [
    'the indented `- item` form is a list, which is how the convention writes several values',
    () => gives('labels:\n  - enhancement\n  - developer-experience', { labels: list('enhancement', 'developer-experience') }),
  ],
  ['a block sequence of quoted items reads the same way', () => gives("deps:\n  - 'task-24.1'\n  - task-208", { deps: list('task-24.1', 'task-208') })],
  ['a key with nothing after it and nothing under it is an empty value', () => gives('status:', { status: scalar('') })],
  ['a trailing comment is a comment and not part of the value', () => gives('title: Ship it # later', { title: scalar('Ship it') })],
  ['a whole-line comment and a blank line are skipped', () => gives('# a note\n\ntitle: x', { title: scalar('x') })],
  [
    'a real file of the convention this reads parses whole',
    () =>
      gives(
        [
          'id: BACK-200',
          'title: Add Claude Code integration',
          'status: To Do',
          'assignee: []',
          "created_date: '2025-07-23'",
          "updated_date: '2025-09-06 21:22'",
          'labels:',
          '  - enhancement',
          '  - developer-experience',
          'dependencies:',
          '  - task-24.1',
          '  - task-208',
          'priority: medium',
        ].join('\n'),
        {
          id: scalar('BACK-200'),
          title: scalar('Add Claude Code integration'),
          status: scalar('To Do'),
          assignee: list(),
          created_date: scalar('2025-07-23'),
          updated_date: scalar('2025-09-06 21:22'),
          labels: list('enhancement', 'developer-experience'),
          dependencies: list('task-24.1', 'task-208'),
          priority: scalar('medium'),
        }
      ),
  ],

  // ---- What it refuses, with the value it returns rather than the absence of a throw -----
  ['a nested map yields no field for its key', () => gives('author:\n  name: Ada\n  role: writer', {}, ['author/nested map'])],
  ['a flow map yields no field for its key', () => gives('author: {name: Ada}', {}, ['author/nested map'])],
  ['a list of maps written over two lines each is refused whole', () => gives('people:\n  - name: a\n    role: b', {}, ['people/nested map'])],
  /*
   * The two shapes a half-read list takes, and they need separate cases because two different
   * guards refuse them. The first is caught by the indent check, since the map's second key sits
   * deeper than the item; these two are at one depth throughout, so only the test on the item
   * itself is left to refuse them. A case aimed at the first one passes with that test deleted.
   */
  ['a list of one-line maps is refused rather than coming back as an empty list', () => gives('people:\n  - name: a\n  - name: b', {}, ['people/nested map'])],
  ['a list of a scalar and a map is refused whole, rather than short by one', () => gives('tags:\n  - a\n  - name: b', {}, ['tags/nested map'])],
  ['a `|` multi-line scalar yields no field', () => gives('body: |\n  one\n  two', {}, ['body/multi-line scalar'])],
  ['a `>` multi-line scalar yields no field', () => gives('body: >\n  one\n  two', {}, ['body/multi-line scalar'])],
  ['a plain scalar folded over two lines yields no field', () => gives('title: one\n  two', {}, ['title/multi-line scalar'])],
  ['a quoted key containing a colon yields no field', () => gives('"a: b": x', {}, ['(line)/quoted key'])],
  ['a key written twice yields no field and is refused on both lines', () => gives('status: Todo\nstatus: Done', {}, ['status/duplicate key', 'status/duplicate key'])],
  [
    'a key written twice is refused even when the second copy would have been refused anyway',
    () => gives('a: 1\na:\n  b: 2', {}, ['a/duplicate key', 'a/duplicate key']),
  ],
  /*
   * Anchors and references, in every position they can be written, because the position is what
   * decides whether a refusal is reached at all. At the head of a value the first character is the
   * tell and it is cheap; *inside* a sequence it sits where a plain scalar would, so the item
   * reader has to ask before it takes the text. Reading `*defaults` as nine characters is a field
   * holding a plausible wrong value, which is worse than a field holding none.
   */
  ['an anchor yields no field', () => gives('a: &ref 1', {}, ['a/anchor or alias'])],
  ['a reference yields no field', () => gives('a: *ref', {}, ['a/anchor or alias'])],
  ['an anchor on a flow sequence refuses the key rather than the sequence', () => gives('tags: &defaults [a, b]', {}, ['tags/anchor or alias'])],
  [
    'an anchor on a block sequence is refused as an anchor, not as a folded scalar',
    () => gives('tags: &defaults\n  - a\n  - b', {}, ['tags/anchor or alias']),
  ],
  ['an anchor on a nested map is refused as an anchor', () => gives('defaults: &d\n  a: 1', {}, ['defaults/anchor or alias'])],
  ['a reference inside a flow sequence refuses the whole list', () => gives('tags: [*a, b]', {}, ['tags/anchor or alias'])],
  ['an anchor inside a flow sequence refuses the whole list', () => gives('tags: [&x a, b]', {}, ['tags/anchor or alias'])],
  ['a reference as a block sequence item refuses the whole list', () => gives('tags:\n  - *defaults\n  - b', {}, ['tags/anchor or alias'])],
  [
    'CONTROL: a quoted `*ref` is the literal string YAML says it is, and stays a field',
    () => gives("a: '*ref'\ntags: ['*a', b]", { a: scalar('*ref'), tags: list('*a', 'b') }),
  ],
  ['a merge key is not a key this parser reads', () => gives('<<: *defaults', {}, ['(line)/not a key'])],
  ['a tag yields no field', () => gives('a: !!str 1', {}, ['a/tag'])],
  ['a flow sequence that does not close on its line yields no field', () => gives('tags: [a, b', {}, ['tags/sequence'])],
  ['a nested flow sequence is refused rather than flattened', () => gives('tags: [a, [b, c]]', {}, ['tags/sequence'])],
  ['an unterminated quote yields no field', () => gives("title: 'a", {}, ['title/malformed scalar'])],
  ['an escape this parser does not carry yields no field rather than a guess', () => gives('title: "a\\u00e9"', {}, ['title/malformed scalar'])],
  ['a line that is not a key at all is reported as one', () => gives('title: x\njust some words', { title: scalar('x') }, ['(line)/not a key'])],
  ['a document whose front matter is a sequence has no fields', () => gives('- a\n- b', {}, ['(line)/sequence', '(line)/sequence'])],
  [
    'a readable key beside an unreadable one still gives its field, because a refusal is per key',
    () => gives('title: x\nauthor:\n  name: b\nstatus: Todo', { title: scalar('x'), status: scalar('Todo') }, ['author/nested map']),
  ],

  // ---- Non-vacuity: the empty answers, which must not read as a refusal ------------------
  [
    'CONTROL: a document with no front matter gives the empty answer rather than an error',
    () => {
      const out = frontMatterOf('# Title\n\nBody.\n');
      return (out.end === 0 && j(out.fields) === '{}' && out.notUnderstood.length === 0) || `got ${j(out)}`;
    },
  ],
  [
    'CONTROL: an unterminated opening `---` gives the empty answer, which is not the same as a refusal',
    () => {
      const out = frontMatterOf('---\ntitle: x\n\nBody with no closing fence.\n');
      return (out.end === 0 && j(out.fields) === '{}' && out.notUnderstood.length === 0) || `got ${j(out)}`;
    },
  ],
  [
    'CONTROL: an empty front-matter block gives the empty answer and refuses nothing',
    () => {
      const out = frontMatterOf('---\n\n---\n\nBody.\n');
      if (out.end !== 0) return `an opening fence over a blank line is not front matter, and this read end ${out.end}`;
      const spaced = frontMatterOf('---\n   \n---\n\nBody.\n');
      return (spaced.end === 0 && spaced.notUnderstood.length === 0) || `got ${j(spaced)}`;
    },
  ],
  [
    'CONTROL: the empty answer and a block that refused everything are different answers',
    () => {
      const none = frontMatterOf('# T\n\nBody.\n');
      const refused = frontMatterOf(fm('a:\n  b: 1'));
      if (none.notUnderstood.length !== 0) return `no front matter refused ${j(none.notUnderstood)}`;
      if (refused.notUnderstood.length !== 1) return `a block holding only a nested map refused ${j(refused.notUnderstood)}`;
      return none.end === 0 && refused.end === 4 ? true : `ends were ${none.end} and ${refused.end}`;
    },
  ],
  [
    'CONTROL: a refusal names the line it was written on',
    () => {
      const out = frontMatterOf(fm('title: x\nauthor:\n  name: b'));
      return j(out.notUnderstood) === j([{ line: 3, key: 'author', reason: 'nested map' }]) || `got ${j(out.notUnderstood)}`;
    },
  ],
];
cases.push(...frontMatterCases);

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

/*
 * The corpus, rendered, in every profile, with the count printed rather than asserted.
 *
 * The cases above give the renderer one construct at a time. This gives it every document in
 * `sample/` whole, which is where a construct meets its neighbours, and fails naming the document
 * and profile if any of them throws or comes back as something other than a string and a list.
 *
 * **The denominator is the baseline file, not the documents this run happened to read.** A count of
 * renders measured against the same directory listing that produced them could only ever read "all
 * of them", including when the listing came back empty. So the number printed is the documents read
 * against the documents the census baseline knows, and a run that rendered none fails.
 *
 * What the renderer owes and did not draw is printed per profile beside it. It is the corpus's view
 * of the same gap `unimplemented()` states for the table, and it is a reading rather than a ratchet:
 * the cases above already fail when the owed list changes.
 */
{
  const known = existsSync(BASELINE) ? Object.keys(JSON.parse(readFileSync(BASELINE, 'utf8'))).length : 0;
  const docs = Object.keys(seen);
  const threw = [];
  const owed = {};
  let renders = 0;
  for (const doc of docs) {
    const text = readFileSync(join(CORPUS, doc), 'utf8');
    for (const profile of PROFILES) {
      try {
        const out = renderMarkdown(text, profile);
        if (typeof out.html !== 'string' || !Array.isArray(out.outOfScope)) {
          threw.push(`${doc} under ${profile} returned ${j(Object.keys(out ?? {}))} rather than a string and a list`);
          continue;
        }
        renders++;
        for (const o of out.outOfScope) {
          if (o.reason !== 'unimplemented') continue;
          owed[profile] ??= {};
          owed[profile][o.construct] = (owed[profile][o.construct] ?? 0) + 1;
        }
      } catch (err) {
        threw.push(`${doc} under ${profile} threw: ${err?.message ?? err}`);
      }
    }
  }
  if (threw.length) {
    console.log(`\n❌ the render path failed on ${threw.length} document render(s):`);
    for (const line of threw.slice(0, 20)) console.log(`   ${line}`);
    if (threw.length > 20) console.log(`   ... and ${threw.length - 20} more`);
    failures.push('corpus render');
  } else if (renders === 0 || !PROFILES?.length) {
    console.log(`\n❌ the corpus render rendered nothing: ${docs.length} document(s) read, ${PROFILES?.length ?? 0} profile(s) to drive.`);
    failures.push('corpus render');
  } else {
    console.log(
      `\nrender: ${docs.length} of ${known} baseline documents rendered under ${PROFILES.join(', ')}, ` +
        `${renders} renders, none threw.`
    );
    for (const profile of PROFILES) {
      const names = Object.entries(owed[profile] ?? {}).sort((a, b) => b[1] - a[1]);
      const sum = names.reduce((n, [, c]) => n + c, 0);
      console.log(
        `   ${profile}: ${sum} construct(s) owed and not drawn` + (names.length ? `, ${names.map(([n, c]) => `${c} ${n}`).join(', ')}` : '')
      );
    }
  }
}

console.log(`\n${passed}/${cases.length} dialect checks passed`);
process.exit(failures.length === 0 && passed === cases.length ? 0 : 1);
