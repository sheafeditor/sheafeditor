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

const { parse, constructs, nodesNamed, has, census, blockMaths, renderMarkdown, scopeOf, unimplemented, PROFILE_TABLE, TAGS, HANDLERS } = createRequire(
  import.meta.url
)('./dialect.bundle.cjs');

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
cases.push(...renderCases);

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
      const want = ['Callout', 'Emoji', 'InlineMath', 'InlineMathMark'].sort();
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

cases.push(...drawnCases, documentDrawsEach, sameLines, ...owedCases, ...removalCases);

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
  [
    'a line that only looks like a definition, in the middle of a sentence, is text',
    () => rendersTrimmed('See [a]: this is prose here\n', 'notes', '<p>See [a]: this is prose here</p>'),
  ],
  [
    'a line that looks like a definition and follows a line of its paragraph is text, because a definition cannot interrupt one',
    () => rendersTrimmed('Some text\n[a]: https://e.com\n', 'notes', `<p>Some text\n[a]: ${A('https://e.com', 'https://e.com')}</p>`),
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
];
cases.push(...definitionCases);

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
