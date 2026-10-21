/*
 * What the render path may emit from document content.
 *
 *   node scripts/check-render-safety.mjs
 *
 * `src/render/markdown.ts` turns a document into HTML that a consumer puts in their own page, under
 * their own CSP or none. So a document is untrusted input and this path is the boundary. Two
 * properties say that boundary holds, and **both have to be stated or the half that is written
 * reads as the whole**: no element the document supplied, and no destination a browser will run.
 *
 * This file holds the second. Until it existed, `[click](javascript:alert(1))` emitted
 * `<a href="javascript:alert(1)">`, and so did `vbscript:`, `data:text/html`, the mixed-case
 * spelling, and the reference form where the payload sits in a definition at the foot of the
 * document. Five live cases, and no injection needed by any of them: `href` is a place a browser
 * runs code on purpose, so quoting the value — which this path did correctly — protects nothing.
 *
 * ## Why the benign half is not padding
 *
 * A scheme rule is easy to write too tightly, and the expensive mistake is not a surviving payload
 * but a rule that kills `other.md`. A relative path with no scheme is the ordinary case in a
 * repository, so every document would lose every internal link. The benign cases below are
 * therefore assertions and not reassurance, and `#section`, `./a:b.md` and `../up.md` are each a
 * different way for a careless allow-list to go wrong.
 *
 * ## The non-vacuity assertion, which is the one that matters most here
 *
 * **A probe for hostile destinations finds none against a surface that emits no destinations at
 * all.** The editor is such a surface: it decorates text and builds no DOM from the document, so a
 * link in the live preview is styled text with no anchor element. A probe run there comes back clean
 * and reads as confirmation of a property it never tested. That happened while this defect was being
 * scoped.
 *
 * So this asserts that the surface it drove emitted anchors, and says how many. A future change that
 * stops the render path emitting anchors must fail this check rather than satisfy it.
 *
 * ## What is deliberately not used as evidence
 *
 * `java\tscript:` and `<javascript:…>` come back inert because the parser declines to make a link
 * of them, not because anything inspected a destination. They pass identically with the allow-list
 * removed, so they cannot be the control for it. Reported at the end as parser behaviour, excluded
 * from the verdict.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Destinations a browser will act on that a document may not ask for. */
const HOSTILE = [
  ['javascript, lower case', '[click](javascript:alert(1))'],
  ['javascript, mixed case', '[click](JaVaScRiPt:alert(1))'],
  ['vbscript', '[click](vbscript:msgbox(1))'],
  ['data, text/html', '[click](data:text/html,<script>alert(1)</script>)'],
  ['a reference definition', '[click][r]\n\nsome prose between them\n\n[r]: javascript:alert(1)'],
  ['a reference definition, mixed case', '[click][r]\n\n[r]: DATA:text/html,x'],
  ['leading space before the scheme', '[click]( javascript:alert(1))'],
  ['file', '[click](file:///etc/passwd)'],
  ['blob', '[click](blob:https://e.com/x)'],
  ['a bare scheme-shaped path', '[click](a:b.md)'],
  /*
   * In angle brackets, which CommonMark allows so a destination can hold spaces and which the
   * render path used to keep. Not one of the ten above is bracketed, so all of them agreed with a
   * rule that a bracketed destination walked straight past: `<javascript:alert(1)>` does not match
   * the scheme pattern, so it read as "no scheme" and was allowed.
   *
   * These are here because the brackets now come off **inside** `safeDestination`, before the
   * scheme is read. A later author who moves that strip to a separate pass, which is the obvious
   * tidy-up, puts `javascript:` into an `href` with the allow-list satisfied. These three are what
   * fails when the order is wrong, and the order is the whole of the correctness.
   */
  ['javascript in angle brackets', '[click](<javascript:alert(1)>)'],
  ['data in angle brackets, with a space', '[click](<data:text/html,<p>x >)'],
  ['a reference definition in angle brackets', '[click][r]\n\n[r]: <javascript:alert(1)>'],
  /*
   * An address in angle brackets standing alone. This was listed with the parser's own behaviour
   * below, as inert, and it was inert for the wrong reason: the render path drew no autolink at all,
   * so there was no anchor to be unsafe. The parser does make a link of it (`<javascript:alert(1)>` is
   * an `Autolink` node), the render path now draws autolinks, and what keeps it from an anchor is the
   * scheme rule, which is why it is here with the rest.
   */
  ['an address in angle brackets, javascript', '<javascript:alert(1)>'],
  ['an address in angle brackets, data', '<data:text/html,x>'],
  ['an address in angle brackets, vbscript', '<vbscript:msgbox(1)>'],
];

/**
 * Image addresses, which `src` fetches and a `javascript:` or `data:` one must never reach. The
 * assertion is that no `img` element carries them; the benign half is that an ordinary one does, so
 * a render path that stopped drawing images would fail here rather than pass by drawing none.
 */
const IMAGE_HOSTILE = [
  ['javascript', '![x](javascript:alert(1))'],
  ['mixed case', '![x](JaVaScRiPt:alert(1))'],
  ['data', '![x](data:text/html,<script>alert(1)</script>)'],
  ['in angle brackets', '![x](<javascript:alert(1)>)'],
  ['a reference definition', '![x][r]\n\n[r]: javascript:alert(1)'],
];
const IMAGE_BENIGN = [
  ['an absolute address', '![x](https://example.com/p.png)', 'https://example.com/p.png'],
  ['a relative path', '![x](./p.png)', './p.png'],
  ['a reference definition', '![x][r]\n\n[r]: ../p.png', '../p.png'],
];

/** Destinations a document in a repository legitimately uses, every one of which must survive. */
const BENIGN = [
  ['an absolute address', '[click](https://example.com)', 'https://example.com'],
  ['the same, upper case', '[x](HTTPS://example.com)', 'HTTPS://example.com'],
  ['an explicit relative path', '[click](./other.md)', './other.md'],
  ['a bare relative path', '[click](other.md)', 'other.md'],
  ['a parent-relative path', '[x](../up.md)', '../up.md'],
  ['a colon inside a filename', '[x](./a:b.md)', './a:b.md'],
  ['a fragment', '[x](#section)', '#section'],
  ['a mail address', '[x](mailto:a@b.com)', 'mailto:a@b.com'],
  ['a reference definition', '[click][r]\n\n[r]: https://example.com', 'https://example.com'],
];

/** Inert because the parser declines the link, not because a destination was inspected. */
const PARSER_BEHAVIOUR = [['a tab inside the scheme', '[click](java\tscript:alert(1))']];

/**
 * Documents that try to put an element into the output, and ordinary ones that must not be refused.
 *
 * **The assertion is an allow-list of what Sheaf may emit, not a list of what an attacker may send.**
 * The open version — searching the output for `<script` — passes on `<ScRiPt`, on an attribute, and
 * on anything nobody thought of. The closed version enumerates the renderer's own vocabulary, which
 * is short, known, and changes only when somebody means it to.
 *
 * The last two are the ones that matter, because they are not attacks. `<kbd>` is the shape of the
 * feature request that would break this property: "render it properly" means passing a document's
 * own tag through, which is a sanitiser, which is a security component somebody owns forever. The
 * specification allows such a pair to be *drawn* and not to be *emitted*, and those look identical
 * on screen. This check is what keeps them apart.
 */
const DOCUMENT_ONLY = ['table', 'thead', 'tbody', 'tr', 'th', 'td'];
const ELEMENT_CASES = [
  ['a script element', '<script>alert(1)</script>'],
  ['an event handler attribute', '<img src=x onerror=alert(1)>'],
  ['a div with a class', '<div class="x">inner</div>'],
  ['an unclosed tag', '<div><span>text'],
  ['an svg with a handler', '<svg onload=alert(1)></svg>'],
  ['an iframe', '<iframe src="https://e.com"></iframe>'],
  ['a mixed-case script', '<ScRiPt>alert(1)</ScRiPt>'],
  ['an inline pair a reader might want drawn', 'Press <kbd>Ctrl</kbd> now.'],
  ['a subscript pair', 'H<sub>2</sub>O'],
  /*
   * CONTROL, and it answers the same before and after the change that made it worth having, which a
   * reader needs to know rather than discover.
   *
   * An out-of-scope construct's source is now interpolated into an element rather than emitted beside
   * one, so a construct whose text contains `</div>` is the input shaped to close that wrapper from
   * inside and continue in markup. It passed before the wrapper existed, because the source was
   * already escaped and `escape` is what makes it safe either way. It must keep passing, and the
   * reason it is here is that the thing it guards changed underneath it: before, a stray `</div>`
   * could only have been loose text; now it reaches an element's content.
   *
   * The `"` is in it for the same reason one step further on: the construct's name goes into an
   * attribute, so a name carrying a quote would break out of it. No grammar node is named with one,
   * which is why this watches the source rather than the name.
   */
  ['a table whose cell closes the wrapper', '| </div><script>x</script> | "b" |\n|:--|--:|\n| 1 | 2 |', DOCUMENT_ONLY],
  /*
   * The drawings added with the document profile each put document text next to markup, and each
   * gets the input shaped to leave its element. A fourth item names the elements a case is entitled
   * to produce beyond the base set, because a table or an image is a thing the document asked for in
   * Markdown and the allow-list for the rest of the cases must not contain them: a document-supplied
   * `<img>` or `<table>` has to be caught, and cannot be if every case may emit either.
   */
  ['a table cell holding markup of its own', '| <img src=x onerror=alert(1)> | <b>y</b> |\n|---|---|\n| <script>x</script> | 2 |', DOCUMENT_ONLY],
  ['an image description holding markup', '![<script>x</script>"><img src=x onerror=y>](p.png)', ['img']],
  ['an image address that tries to leave its attribute', '![x](a"onerror="alert(1))', ['img']],
  ['a code fence whose info string is markup', '```"><script>alert(1)</script>\nx\n```'],
  ['a footnote whose note is markup', 'a[^1]\n\n[^1]: <script>x</script> "><img src=x>'],
  ['an abbreviation whose title is markup', '<abbr title="x&quot;><script>y</script>">z</abbr>'],
  ['an entity that decodes to markup', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['a link whose text is markup', '[<img src=x onerror=y>](https://e.com)'],
];

/** Ordinary documents, so the check is not simply refusing everything. */
const ORDINARY = [
  'A paragraph with **bold**, *italic*, `code`, ~~struck~~ and ==marked== text.',
  '# Heading one\n\n## Heading two\n\nText under it.',
  '- a bullet\n- another\n\n1. first\n2. second',
  '> a quote\n>\n> with two paragraphs',
  '- [x] a done task\n- [ ] an undone one',
  'A [link](https://example.com) and a [relative one](./other.md).',
];

const UNSAFE = /^\s*(javascript|vbscript|data|file|blob|about|vbs)\s*:/i;

const { outputFiles } = await build({
  entryPoints: [join(REPO, 'src', 'render', 'markdown.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  logLevel: 'error',
});
const module = { exports: {} };
new Function('module', 'exports', 'require', outputFiles[0].text)(module, module.exports, () => {
  throw new Error('check-render-safety: the render path asked for a runtime dependency, which it should not have');
});
const { renderMarkdown, TAGS, PROFILES } = module.exports;
/*
 * This catches an **empty** population and not an incomplete one, deliberately, and the limit is
 * worth stating because the summary below is thin rather than false if it is ever reached:
 * `PROFILES = ['notes']` passes this guard and the run truthfully reports "every profile the
 * dialect declares and none skipped" over one of three.
 *
 * What makes that safe today is not this guard. It is that `ALL` in `src/dialect/profileConstructs.ts`
 * aliases `PROFILES`, so the same constant drives `PROFILE_TABLE`, and a profile dropped from it
 * fails loudly over there long before the thinness here could matter. **So the guard is adequate
 * because the constant is load-bearing elsewhere**, which is a property of that file rather than of
 * this one. Anyone making `PROFILES` a check-only list would remove the thing holding this up
 * without touching this line, and should put a completeness assertion here in the same change.
 */
if (!Array.isArray(PROFILES) || PROFILES.length === 0) {
  console.error('check-render-safety: the render path exports no PROFILES, so there is no population to drive.');
  console.error('  Driving a hard-coded list instead is what left `field` unread by both render checks.');
  process.exit(1);
}

/*
 * What the renderer is entitled to emit: every tag in its own `TAGS` map, plus the four it writes
 * literally. Derived from the module rather than copied, so adding a construct cannot leave this
 * list behind, and the four extras are named here because they are not in that map.
 *
 *   a       a link
 *   input   a task's checkbox, the one replacement on this path
 *   span    an ordered list's marker, and an out-of-scope construct sitting inside a paragraph
 *   div     an out-of-scope construct at block level, wrapping its own source
 *
 * **This list answers "could the document have produced this element", and the four extras each cost
 * one element of that tripwire.** A document cannot produce any element, because `escape` turns its
 * angle brackets into entities before they reach the output, and that is the property this file
 * asserts. Naming `div` here does not widen what a document can become; it widens what the renderer
 * may emit, which is a different list that happens to be implemented as this one. What it costs is
 * that if escaping ever stopped, a document-supplied `div` would no longer be caught here.
 *
 * `div` is the right element to spend that on and `img` or `iframe` would not be: a `div` is inert,
 * with no `src`, no `href` and no event surface, so an unnoticed one does nothing. **If this list
 * ever grows past these four, that is the moment to ask whether it is still a tripwire or has become
 * a description of the output**, which would make it agree with the renderer by construction.
 *
 * **It has grown by four, and the four are inert in the same way `div` is.** Fenced code, rules,
 * hard breaks and footnote numbers are drawn on every profile that carries them, so a document that
 * supplied any of `pre`, `hr`, `br` or `sup` could no longer be told from one that asked for the
 * construct. None has a `src`, an `href` or an event surface. What it costs is the same as before and
 * it is named: if escaping ever stopped, those four would no longer be caught here.
 *
 * The elements with a surface are not on this list. `img`, and the table family a `document` draws,
 * are named per case below, where a case that asked for the construct in Markdown is entitled to
 * one. So a document-supplied `<img>` or `<table>` is still caught everywhere it was not requested.
 */
const EMITTABLE = new Set([...Object.values(TAGS), 'a', 'input', 'span', 'div', 'pre', 'hr', 'br', 'sup']);

const hrefOf = (markdown) => /<a href="([^"]*)"/.exec(renderMarkdown(markdown).html)?.[1] ?? null;
const srcOf = (markdown) => /<img src="([^"]*)"/.exec(renderMarkdown(markdown, 'document').html)?.[1] ?? null;

const problems = [];
let anchors = 0;

/*
 * Two assertions per hostile case, and the second is why `a bare scheme-shaped path` is in this list
 * at all.
 *
 * The first is the safety property, tested against a **block-list** of schemes a browser acts on.
 * That is deliberately not the allow-list the fix uses: a check that re-implements the rule it is
 * checking agrees with it by construction, including when the rule is wrong.
 *
 * The second is the chosen output, that a refused destination emits no anchor. It exists because the
 * first assertion is silent for a scheme that is merely unknown — `a:b.md` is refused and is not an
 * XSS, so a block-list has nothing to say about it, and that entry would have sat here looking like
 * an assertion while being unable to fail. Which is the shape this file's own comment warns about.
 *
 * If the product decision changes to "an anchor with no href", the second assertion is the one that
 * changes, and it should change loudly rather than being loosened to cover both.
 */
for (const [name, markdown] of HOSTILE) {
  const href = hrefOf(markdown);
  if (href !== null && UNSAFE.test(href)) problems.push(`${name}: emitted href="${href}"`);
  else if (href !== null) problems.push(`${name}: emitted an anchor, href="${href}", where the destination should have been refused`);
}

for (const [name, markdown, expected] of BENIGN) {
  const href = hrefOf(markdown);
  if (href === null) problems.push(`${name}: emitted no anchor at all, so this destination was refused`);
  else {
    anchors++;
    if (href !== expected) problems.push(`${name}: emitted href="${href}", expected "${expected}"`);
  }
}

/*
 * The same two assertions for an image, with the same empty case: the hostile addresses are measured
 * against a render path that does draw an image from a benign one, so a path that stopped drawing
 * images fails the benign half instead of passing the hostile one by drawing none.
 */
let images = 0;
for (const [name, markdown] of IMAGE_HOSTILE) {
  const src = srcOf(markdown);
  if (src !== null) problems.push(`image, ${name}: emitted src="${src}", where the address should have been refused`);
}
for (const [name, markdown, expected] of IMAGE_BENIGN) {
  const src = srcOf(markdown);
  if (src === null) problems.push(`image, ${name}: emitted no image at all, so this address was refused`);
  else {
    images++;
    if (src !== expected) problems.push(`image, ${name}: emitted src="${src}", expected "${expected}"`);
  }
}
if (images === 0) {
  console.error('check-render-safety: the render path drew no image for any benign address.');
  console.error('  So the hostile image addresses prove nothing: a surface that draws no images has no unsafe ones.');
  process.exit(1);
}

/*
 * The empty case. With no anchors from the benign set there is nothing for the hostile set to have
 * been measured against, and a clean report would mean only that the probe found no links.
 */
if (anchors === 0) {
  console.error('check-render-safety: the render path emitted no anchors for any benign destination.');
  console.error('  So the hostile cases prove nothing: a surface with no links has no unsafe links.');
  console.error('  Either the render path stopped emitting anchors or this check is driving the wrong thing.');
  process.exit(1);
}

/*
 * The element half, read as a tree rather than as a string.
 *
 * jsdom parses the output the way a browser would, so an unclosed tag, a mixed-case name and an
 * attribute all arrive as whatever the browser would actually build — which is the only reading that
 * answers the question. A regex over the text answers a different one.
 */
const { JSDOM } = await import('jsdom');
let elements = 0;
/*
 * Every case under every profile, taken from the dialect's own `PROFILES` rather than listed here.
 *
 * Running `document` is what exercises the table and image drawings with hostile text in them;
 * running `notes` is what shows those same inputs coming back as a named wrapper where the profile
 * does not carry the construct. **`field` was missing until 2026-10-17 and nothing said so**, which
 * is the reason the list is now derived: it is the narrowest profile, it wraps every construct it
 * does not carry in a `span` rather than a `div`, and a `span` is a different escape surface from a
 * `div`. It is also the profile whose rendering changed for 62 of 65 corpus documents on
 * 2026-10-13, so it was the one the hostile corpus had least recently been read against.
 */
for (const profile of PROFILES) {
  const cases = [...ELEMENT_CASES.map(([n, m, extra]) => [n, m, extra ?? []]), ...ORDINARY.map((m, i) => [`ordinary document ${i + 1}`, m, []])];
  for (const [name, markdown, extra] of cases) {
    const { html } = renderMarkdown(markdown, profile);
    const body = new JSDOM(`<!doctype html><body>${html}`).window.document.body;
    const seen = [...body.querySelectorAll('*')].map((el) => el.tagName.toLowerCase());
    elements += seen.length;
    const allowed = new Set([...EMITTABLE, ...extra]);
    const stray = [...new Set(seen.filter((tag) => !allowed.has(tag)))];
    if (stray.length) problems.push(`${name} (${profile}): emitted ${stray.map((t) => `<${t}>`).join(', ')}, which the renderer may not produce`);
    // An event handler on an element Sheaf *is* allowed to emit would pass an element check, so the
    // attributes are read too. This is the half the issue predicted it would get wrong.
    for (const el of body.querySelectorAll('*')) {
      const handlers = [...el.attributes].map((a) => a.name).filter((n) => n.toLowerCase().startsWith('on'));
      if (handlers.length) problems.push(`${name} (${profile}): emitted <${el.tagName.toLowerCase()}> carrying ${handlers.join(', ')}`);
    }
  }
}

/*
 * The empty case again, for the element half. A corpus that produced no elements would satisfy every
 * rule above by producing nothing, and the ordinary documents are there to make that impossible.
 */
if (elements === 0) {
  console.error('check-render-safety: the render path produced no elements for any document, hostile or ordinary.');
  console.error('  So the element rules prove nothing. Either the renderer stopped emitting HTML or this is driving the wrong thing.');
  process.exit(1);
}

if (problems.length) {
  console.error(`The render path's output is wrong in ${problems.length} case(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nTwo rules, and the message above says which one went:' +
      '\n  A destination with no scheme, or http, https or mailto, is emitted. Anything else drops the' +
      '\n  anchor and keeps the words. See `safeDestination` in src/render/markdown.ts.' +
      '\n  Nothing a document supplies may become an element. The renderer emits its own `TAGS` plus' +
      '\n  the few it writes literally, listed in this file, and a document\'s tags are text. See the walk' +
      '\n  in the same file.' +
      '\n\nIf this failed because a construct should now be drawn, drawing it is allowed and passing the' +
      "\ndocument's own tag through is not: apply a class to text, as the editor does."
  );
  process.exit(1);
}

console.log(
  `No unsafe link destination survives the render path: ${HOSTILE.length} refused, ` +
    `${anchors} of ${BENIGN.length} benign destinations emitted unchanged.`
);
console.log(
  `  ${IMAGE_HOSTILE.length} image addresses refused, ${images} of ${IMAGE_BENIGN.length} benign ones emitted unchanged.`
);
console.log(
  `  Nothing a document supplied became an element: ${elements} elements read as a tree across ` +
    `${ELEMENT_CASES.length} hostile and ${ORDINARY.length} ordinary documents under ${PROFILES.join(', ')}, ` +
    `which is every profile the dialect declares and none skipped, ` +
    `all within the ${EMITTABLE.size} the renderer may emit (and, per case, the image or table it was asked for), ` +
    `none carrying an event handler.`
);
console.log(
  `  parser behaviour rather than a filter, excluded from the verdict: ` +
    PARSER_BEHAVIOUR.map(([n, md]) => `${n} -> ${hrefOf(md) === null ? 'no link' : 'link'}`).join(', ')
);
