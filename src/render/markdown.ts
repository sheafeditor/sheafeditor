/*
 * Markdown to HTML, with no editor anywhere near it.
 *
 *   renderMarkdown('A **bold** word')  ->  { html: '<p>A <strong>bold</strong> word</p>', outOfScope: [] }
 *
 * **Why this exists rather than mounting an editor nobody types in.** A tracker showing fifty issue
 * titles wants fifty rendered strings; mounting fifty CodeMirror views is what makes a library of
 * this kind unusable at the size its consumers actually run at. A server rendering descriptions
 * cannot mount one at all. So this runs in plain Node against a string, and the check that says so
 * is `scripts/check-dialect-imports.mjs`, which refuses `@codemirror/view` anywhere this reaches.
 *
 * ## It must agree with the editor, and it does not share the editor's implementation
 *
 * The editor draws by hanging CodeMirror decorations over a document; this walks a tree and writes
 * tags. Those cannot be one implementation, and the risk that follows is the whole difficulty here:
 * a field that shows one thing unfocused and another thing focused is the most visible way a library
 * like this loses trust.
 *
 * What makes the two comparable is that the editor's rule, written down as Part 2 of the
 * specification, has exactly two mechanisms and no third. **A marker is either hidden, leaving the
 * text around it, or replaced by something the file does not contain.** `HIDDEN` below is the first
 * and `TAGS` and `HANDLERS` are the second, and every construct is in one or the other. The
 * comparison that proves they agree is per-line against `drawMap`, which reads the real editor under
 * jsdom.
 *
 * ## Profiles
 *
 * There are three, `field`, `notes` and `document`, and **`PROFILE_TABLE` is the one place this file
 * says which constructs each carries.** It mirrors the specification's "What each profile carries"
 * table row for row. Whether a construct is drawn is read from that table and from nothing else, so
 * a decision that widens a profile reaches this renderer as a changed row rather than as a change to
 * some other list that happens to decide the same thing.
 *
 * A construct this render does not draw comes back inside an element that names it, is listed in
 * `outOfScope`, and carries a `reason` that separates two situations calling for opposite actions:
 *
 *   - `profile`: the profile does not carry it. This is a decision. A richer profile may.
 *   - `unimplemented`: the profile carries it and this renderer has no drawing for it yet. This is
 *     a defect in the renderer, and a richer profile would not help.
 *
 * A consumer that gets back an empty `outOfScope` knows everything in its input was understood; one
 * that gets a list knows exactly what was not, and whether to upgrade the profile or file a bug.
 */
import { parser } from '@lezer/markdown';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { Text } from '@codemirror/state';
import { markdownDialect } from '../dialect/markdown';
/*
 * Where front matter ends, which constructs each profile carries, and where a `$$` block is: three
 * facts about the bytes, all from `src/dialect/`, which is where `../dialect/markdown` above already
 * goes. The dialect is the layer below both this path and the editor, so none of these widens a
 * boundary and none of them needs excusing.
 *
 * They are leaves rather than part of `dialect/markdown.ts` because the drawing layer asks each of
 * these questions too, and two answers to any of them is a surface that renders one thing before it
 * is focused and draws another after. `frontMatter.ts` and `blockMaths.ts` import only a type and
 * `profileConstructs.ts` nothing at all, so none of them costs this path an editor.
 */
import { frontMatterEnd } from '../dialect/frontMatter';
import { PROFILE_TABLE, carries as profileCarries } from '../dialect/profileConstructs';
import type { ConstructProfile, SurfaceProfile } from '../dialect/profileConstructs';
import { blockMathsIn, linesOf } from '../dialect/blockMaths';
import type { BlockMathRange } from '../dialect/blockMaths';
import { inlineHtmlPairAt } from '../dialect/inlineHtml';
import type { InlineHtmlPair } from '../dialect/inlineHtml';

/** The two profiles a mounted surface can be. */
export type Profile = SurfaceProfile;

/** Every profile the render path serves. `document` is the one the editor extension runs. */
export type RenderProfile = ConstructProfile;

/**
 * The profiles themselves, re-exported so a check driving this path takes its population from the
 * dialect rather than writing a list of its own. A type cannot be iterated at runtime, which is how
 * both render checks came to carry `['notes', 'document']` by hand and leave `field` undriven.
 */
export { PROFILES } from '../dialect/profileConstructs';

/** Why a construct came back as source: a decision about the profile, or a gap in this renderer. */
export type Reason = 'profile' | 'unimplemented';

/** A construct this render did not draw, left as source and named. */
export interface OutOfScope {
  construct: string;
  from: number;
  to: number;
  /**
   * `profile` when the profile does not carry the construct, which a richer profile may.
   * `unimplemented` when it does carry it and this renderer has no drawing for it, which no profile
   * will fix.
   */
  reason: Reason;
}

export interface RenderResult {
  html: string;
  outOfScope: OutOfScope[];
}

/**
 * The dialect as a configured parser.
 *
 * Exported because a caller that wants the tree should take this one rather than configure a second,
 * which would be the same dialect assembled twice and free to drift. `check-render-agrees.mjs` uses
 * it to say which constructs a compared line held.
 */
export const dialectParser = parser.configure(markdownDialect);

/*
 * Which profiles carry each construct, re-exported from the leaf that now holds it.
 *
 * It was defined here until the drawing layer needed the same answer, and a second list beside the
 * editor would have let a surface refuse a table before it was focused and draw a grid after. The
 * table is `src/dialect/profileConstructs.ts`, which imports nothing; this path reads it and
 * re-exports it so a reader who comes looking here still finds it.
 */
export { PROFILE_TABLE };

/**
 * Markers the editor hides, which here means emitting nothing for them.
 *
 * Every one of these is bytes a reader can still move a caret through in the editor, which is the
 * distinction Part 2 draws between hiding and replacing. In HTML the distinction does not survive —
 * there is no caret — so both become "the tag carries the meaning and the marker is gone".
 */
const HIDDEN = new Set([
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'HighlightMark',
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
]);

/*
 * Hidden only inside a link, which is where they are a destination or a delimiter rather than words.
 *
 * `URL` was in the set above until it ate every autolink in the corpus: GFM makes a bare
 * `https://example.com` in running text a link whose address *is* its text, so hiding the address
 * hides the sentence. Inside `[words](address)` the address is not text a reader sees; standing on
 * its own it is the only text there is.
 *
 * `LinkMark` joined them for the same reason and it was the larger one: `[1.9.4]` in a changelog
 * heading is a bracketed label with no definition anywhere, so it is not a link and the editor draws
 * the brackets. Hiding the mark wherever it appeared quietly deleted them, which was most of the
 * 4,512 lines where the editor left the source alone and this path changed it.
 */
const HIDDEN_IN_LINK = new Set(['URL', 'LinkTitle', 'LinkMark']);

/*
 * Named by the profile table and drawn as part of the construct that holds them.
 *
 * A link's marks, label and title are read by the link, the image and the definition, and nothing
 * draws any of them on its own, so they have no handler. Listing them keeps the table a row-for-row
 * copy of the specification's without making them read as gaps. `URL` is not here: a bare address
 * standing alone is an autolink and wants a drawing of its own.
 */
const PARTS = new Set(['LinkMark', 'LinkLabel', 'LinkTitle']);

/** Nodes whose content is a line of text, so an element a construct is wrapped in there is inline. */
const INLINE_HOSTS = new Set([
  'Paragraph',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'TableCell',
]);

/*
 * A block marker takes the space after it with it.
 *
 * `# Head` parses as a `HeaderMark` covering `#` alone, so hiding the mark and nothing else leaves
 * the output starting with a space. The editor does not draw that space either: the marker and its
 * separator are one thing to a reader, and only the words are content. Inline marks are not in this
 * set, because `**bold**` has no separator to take.
 */
const BLOCK_MARKS = new Set(['HeaderMark', 'ListMark', 'QuoteMark', 'TaskMarker']);

/** The construct, and the element that carries its meaning once its markers are gone. */
/*
 * Exported so `scripts/check-render-safety.mjs` builds its allow-list of emittable elements from
 * this map rather than from a copy. A list typed into that file would hold whatever somebody
 * remembered, and the property it enforces — that nothing in a document can produce an element — is
 * only as good as the set it compares against.
 */
export const TAGS: Record<string, string> = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 's',
  InlineCode: 'code',
  Highlight: 'mark',
  Paragraph: 'p',
  Blockquote: 'blockquote',
  BulletList: 'ul',
  OrderedList: 'ol',
  ListItem: 'li',
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
};

/** Whether `profile` carries `name`, and if it does, whether this renderer can draw it. */
export type Scope = 'rendered' | 'unimplemented' | 'profile';

/**
 * What a construct is to a profile: drawn, owed and not drawn, or not the profile's at all.
 *
 * The middle answer is the one this exists to give. `unimplemented` means the profile's own list
 * names the construct and nothing here draws it, which is a bug to file. `profile` means the list
 * does not name it, which is a decision a richer profile may have made differently.
 */
export function scopeOf(name: string, profile: RenderProfile): Scope {
  const carriedBy = PROFILE_TABLE[name];
  if (!carriedBy || !carriedBy.includes(profile)) return 'profile';
  return name in TAGS || name in HANDLERS || HIDDEN.has(name) || PARTS.has(name) ? 'rendered' : 'unimplemented';
}

/**
 * The constructs `profile` carries that this renderer cannot draw, in the table's order.
 *
 * This is the number the profile's requirement to cover everything it carries is measured by, and
 * it is computed rather than counted by hand so it moves when a row or a handler does.
 */
export function unimplemented(profile: RenderProfile): string[] {
  return Object.keys(PROFILE_TABLE).filter((name) => scopeOf(name, profile) === 'unimplemented');
}

/*
 * Escaped on the way out, never on the way in.
 *
 * The input is somebody's Markdown and the output is HTML, so every character of text that reaches
 * the output goes through here. Raw HTML written in a Markdown document is therefore shown as the
 * characters it is rather than interpreted, which is also what `outOfScope` says about it: this is a
 * renderer for the dialect, and a consumer that wants a document's embedded HTML to run has asked
 * for something this deliberately does not do.
 */
const escape = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * A destination without the angle brackets CommonMark lets it be written in.
 *
 * One definition, used by `safeDestination` for the address that goes into an `href` and by a link
 * with no text for the address it shows, so the two cannot disagree about where the brackets end.
 * The scheme rule is still decided inside `safeDestination`, on what this returns.
 */
const unangle = (raw: string): string => (raw.length > 1 && raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw);

/**
 * The schemes a destination may carry. Everything else is refused.
 *
 * **An allow-list rather than a block-list, and that is not a style preference.** `javascript:` and
 * `vbscript:` and `data:` are the ones anybody lists, and the set of schemes a browser will act on
 * is open: a block-list is a promise to have thought of every future entry. What a document in a
 * repository legitimately links to is a short closed set, so the safe direction is to name it.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * A link destination, or `null` when it may not be emitted as one.
 *
 * `escape` above is correct and complete for **quoting**, and quoting is a different property from
 * scheme. With the destination quoted, no attribute can be injected and `[x](https://e.com" onclick=…)`
 * is neutralised; with the scheme unchecked, `[x](javascript:alert(1))` needed no injection at all,
 * because `href` is a place a browser runs code on purpose. The render path builds DOM a consumer
 * embeds in their own page, under their CSP or none, so every document was an XSS against them.
 *
 * **Do not move this into `escape`.** That function is used for text content everywhere and a scheme
 * rule has no business there; these are the only two attributes this path emits from document content.
 *
 * Three details that are the whole of the correctness here:
 *
 * **No scheme at all is allowed**, which is the common case in a repository: `other.md`, `./a.md`,
 * `#section`, `../up.md`. A rule that demanded a scheme would break every relative link in every
 * document, which is a larger defect than the one being fixed.
 *
 * **Whitespace and C0 controls are stripped before the scheme is read**, because a browser ignores
 * them when deciding what a URL is. `java\tscript:` is inert here today only because the parser
 * declines to make a link of it, which is an accident of the parser and not a defence, so this does
 * not rely on it.
 *
 * **A colon is not a scheme.** `./a:b.md` is a filename and is allowed, because a scheme has to be a
 * letter followed by letters, digits, `+`, `-` or `.` from the very start. A bare `a:b.md` does read
 * as a scheme and is refused, which is the honest answer: a browser reads it that way too.
 *
 * **The angle brackets come off here rather than at the call sites, and that placement is the
 * correctness.** CommonMark lets a destination be wrapped in `<...>` so it can hold spaces, with the
 * brackets as delimiters. They used to survive into the `href`, so every such link pointed at a file
 * literally named `<a file with spaces.md>` — measured on two corpus documents, which the editor
 * draws correctly, so the two paths disagreed.
 *
 * That is an ordinary bug and stripping them is an ordinary fix, and **a strip written anywhere
 * outside this function bypasses the scheme rule.** `<javascript:alert(1)>` does not match the
 * scheme pattern, because of the leading `<`, so it reads as "no scheme" and is allowed; it is inert
 * only because a browser cannot resolve `<javascript:...` either. Take the brackets off first in a
 * separate pass and the allow-list is satisfied by a destination that no longer exists, with
 * `javascript:` in the `href`. Doing both in one function is what makes that mistake unavailable.
 * `unangle` is that strip and is shared with the address a link with no words shows as text; no
 * `href` is built from it except through this function.
 *
 * What is deliberately not done is unescaping `\<` and `\>` inside the brackets. The editor does not
 * either — it draws the bytes the file holds — and a second difference would be a second thing for
 * the comparison against it to disagree about.
 */
function safeDestination(raw: string): string | null {
  // Delimiters off before anything reads the destination, including the scheme test below.
  const dest = unangle(raw);
  const probe = dest.replace(/[\u0000- ]/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return dest;
  return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? dest : null;
}

/** The text of a node's first child of that name, for a link's destination. */
function childText(node: SyntaxNode, name: string, text: string): string | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return text.slice(c.from, c.to);
  return null;
}

/*
 * The named references this path decodes, and the rule for every numeric one.
 *
 * **This is a short table on purpose and the editor's is not.** The editor asks the browser's own HTML
 * parser, which knows all 2,231 names; this path runs in Node with no DOM, and carrying the full table
 * would be several times the whole renderer's budget for names that appear in a specification about
 * entities and almost nowhere else. A name not in this list is left as written, with its ampersand
 * escaped, which is what the editor does with a name the browser does not know. So the two disagree
 * only on a real but uncommon name, and the disagreement is visible text rather than a lost character.
 *
 * A `Map` rather than an object, because a document can write `&constructor;` and an object answers
 * that with a function.
 */
const ENTITIES = new Map(
  Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", AMP: '&', LT: '<', GT: '>', QUOT: '"',
    nbsp: ' ', copy: '©', COPY: '©', reg: '®', REG: '®', trade: '™',
    hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
    times: '×', divide: '÷', deg: '°', plusmn: '±', micro: 'µ', para: '¶',
    sect: '§', cent: '¢', pound: '£', yen: '¥', euro: '€', larr: '←',
    rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', check: '✓',
    frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿', sup1: '¹',
    sup2: '²', sup3: '³', not: '¬', shy: '­', macr: '¯', acute: '´',
    uml: '¨', cedil: '¸', ordf: 'ª', ordm: 'º', curren: '¤', brvbar: '¦',
    sbquo: '‚', bdquo: '„', lsaquo: '‹', rsaquo: '›', dagger: '†', Dagger: '‡',
    permil: '‰', prime: '′', Prime: '″', infin: '∞', ne: '≠', le: '≤',
    ge: '≥', asymp: '≈', sum: '∑', minus: '−', radic: '√', part: '∂',
    nabla: '∇', isin: '∈', cap: '∩', cup: '∪', int: '∫', there4: '∴',
    lArr: '⇐', rArr: '⇒', hArr: '⇔', spades: '♠', clubs: '♣', diams: '♦',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', lambda: 'λ', mu: 'μ',
    pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ', Omega: 'Ω',
  })
);

/**
 * What an entity reference stands for, or the reference itself when it stands for nothing this path
 * knows. Numeric references follow CommonMark: zero, a surrogate and anything past U+10FFFF are the
 * replacement character.
 */
function decodeEntity(raw: string): string {
  const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));$/.exec(raw);
  if (!m) return raw;
  if (m[3] !== undefined) return ENTITIES.get(m[3]) ?? raw;
  const code = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
}

/**
 * Which labels are the same label: whatever the case, and with a run of spaces or a line break the
 * same as one space. The editor's index normalises the same way. An empty label matches nothing, so
 * a `[]` refers to no definition and `[a][]` falls back to its own text.
 */
const labelKey = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

/** The blocks a definition may sit in, besides the top of the document. */
const DEFINITION_HOSTS = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** A footnote label's key. Labels match whatever their case, as the editor's index has them. */
const footnoteKey = (label: string): string => label.toLowerCase();

interface Footnotes {
  /** The first definition of each label: where it starts, and its note as one line for a tooltip. */
  defs: Map<string, { from: number; note: string }>;
  /** Each referenced label's number, counted in order of first reference. */
  numbers: Map<string, number>;
}

/**
 * Which footnote references resolve and what number each takes.
 *
 * The same rules `src/webview/footnotes.ts` applies in the editor, which this file cannot import
 * because that module draws with CodeMirror: the first definition of a label counts, a reference
 * with no definition stays as written, and numbers are counted in order of first reference among
 * the references that resolve. A definition nothing refers to has no number and stays as written.
 */
function footnoteIndex(tree: Tree, md: string): Footnotes {
  const refs: string[] = [];
  const defs = new Map<string, { from: number; note: string }>();
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'FootnoteReference' && ref.name !== 'FootnoteDefinition') return;
      const label = ref.node.getChild('FootnoteLabel');
      if (!label) return;
      const key = footnoteKey(md.slice(label.from, label.to));
      if (ref.name === 'FootnoteReference') {
        refs.push(key);
        return;
      }
      if (defs.has(key)) return;
      let from = label.to + 2;
      while (from < ref.to && (md[from] === ' ' || md[from] === '\t')) from++;
      defs.set(key, { from: ref.from, note: md.slice(from, ref.to).replace(/\s+/g, ' ').trim() });
    },
  });
  const numbers = new Map<string, number>();
  for (const key of refs) if (defs.has(key) && !numbers.has(key)) numbers.set(key, numbers.size + 1);
  return { defs, numbers };
}

/**
 * The text a node stands for with every marker gone, for an image's description.
 *
 * An `alt` attribute is plain text, so emphasis marks, link brackets and the like have no place in
 * it and an escape or an entity is what it stands for rather than what it is written as.
 */
function plainText(node: SyntaxNode, md: string): string {
  if (node.name === 'Escape') return md.slice(node.from + 1, node.to);
  if (node.name === 'Entity') return decodeEntity(md.slice(node.from, node.to));
  let out = '';
  let pos = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    out += md.slice(pos, c.from);
    if (!HIDDEN.has(c.name) && !PARTS.has(c.name) && !(HIDDEN_IN_LINK.has(c.name) && (node.name === 'Link' || node.name === 'Image'))) out += plainText(c, md);
    pos = c.to;
  }
  return out + md.slice(pos, node.to);
}

/**
 * What a handler is given: the document, the labels it defines, and the walk itself.
 *
 * Handlers are module-level so that `scopeOf` can ask whether one exists without rendering
 * anything, and so a check can remove one and watch a construct move from drawn to owed.
 */
interface Ctx {
  md: string;
  profile: RenderProfile;
  /** Reference definitions by label, lower-cased, to the destination exactly as written. */
  defined: Map<string, string>;
  notes: Footnotes;
  /** The inline HTML pairs this document draws: opening tags by position, and the closing tags' positions. */
  pairs: { open: Map<number, InlineHtmlPair>; close: Set<number> };
  render(node: SyntaxNode): string;
  inner(node: SyntaxNode): string;
  /**
   * A construct named in `outOfScope` and emitted as its own source inside an element that says so.
   * The reason defaults to what the profile table says about the construct, and a handler that has
   * looked at one instance and found it outside the profile says so itself.
   */
  refuse(construct: string, node: SyntaxNode, reason?: Reason): string;
  /**
   * The `$$…$$` blocks this document holds, in order, and the paragraph renderer is the only caller.
   *
   * They are not nodes, so nothing in the walk below meets one: the specification says a block is
   * found by reading lines and asking the tree only whether the line sits in a top-level paragraph.
   * Without this a display equation reached the output as the paragraph text it parses as, with the
   * delimiters and the formula as running prose and `outOfScope` reporting that everything had been
   * understood, which is the one answer a consumer cannot act on.
   */
  mathBlocks: readonly BlockMathRange[];
  /** A node's children and text, with any block in `spans` emitted as its own source instead. */
  innerAround(node: SyntaxNode, spans: readonly BlockMathRange[]): string;
}

/** An anchor for `dest`, or only the words when the destination may not be one. */
function anchor(dest: string, words: string): string {
  const safe = safeDestination(dest);
  return safe === null ? words : `<a href="${escape(safe)}">${words}</a>`;
}

/**
 * The anchor for an address that is its own text: a bare URL, one in angle brackets, an email.
 *
 * Where the address names no scheme it gets the one a reader would assume, `http` for `www.` and
 * `mailto` for an email. A scheme the text already carries goes to `safeDestination` as it stands,
 * so `javascript:alert(1)@x.com` is refused for its scheme and not accepted as an email.
 */
function autolink(url: string): string {
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
  const dest = hasScheme ? url : /^www\./i.test(url) ? `http://${url}` : url.includes('@') ? `mailto:${url}` : url;
  return anchor(dest, escape(url));
}

/**
 * What a `Link` node holds: the mark that closes the brackets, whether an opening parenthesis follows,
 * and the address written after it.
 *
 * The parser calls every bracket run a link. Which ones are is a question about the marks and not
 * about what is inside them: `[a](b)` has a parenthesis and an address, `[a][b]` and `[a]` have
 * neither and are links only if a definition says so. An address anywhere else in the node is text.
 */
function linkParts(
  node: SyntaxNode,
  md: string
): { close: SyntaxNode | null; paren: boolean; destination: string | null; empty: boolean } {
  let open: SyntaxNode | null = null;
  let close: SyntaxNode | null = null;
  let paren = false;
  let destination: string | null = null;
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name === 'LinkMark') {
      if (md[ch.from] === '[' && !open) open = ch;
      else if (md[ch.from] === ']' && !close) close = ch;
      else if (md[ch.from] === '(') paren = true;
    } else if (ch.name === 'URL' && paren && destination === null) destination = md.slice(ch.from, ch.to);
  }
  // Nothing at all between the brackets, as in `[](address)`. A space is text and does not count.
  return { close, paren, destination, empty: !!open && !!close && open.to === close.from };
}

/**
 * Brackets that are not a link, drawn as written.
 *
 * **The brackets are text and the content between them is drawn like any other text.** The editor's
 * rule reads "brackets that are not a link render as written", and this path took that to cover the
 * whole run, so `[_note_]` came back with its underscores showing, in a title as much as in a
 * document. The marks of the bracket pair and of a reference's second pair stay as typed; everything
 * inside goes through the walk, so emphasis, code, escapes and entities are drawn.
 */
function writtenBrackets(node: SyntaxNode, c: Ctx): string {
  let out = '';
  let pos = node.from;
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
    out += escape(c.md.slice(pos, ch.from));
    if (ch.name === 'LinkMark' || ch.name === 'LinkLabel') out += escape(c.md.slice(ch.from, ch.to));
    else if (ch.name === 'URL') out += autolink(c.md.slice(ch.from, ch.to));
    else out += c.render(ch);
    pos = ch.to;
  }
  return out + escape(c.md.slice(pos, node.to));
}

/** A code node's text: every `CodeText` piece, which leaves out a quote's or a list item's own prefix. */
const codeText = (node: SyntaxNode, md: string): string =>
  node.getChildren('CodeText').map((t) => md.slice(t.from, t.to)).join('');

type Handler = (node: SyntaxNode, ctx: Ctx) => string;

/**
 * The constructs drawn by something more than `<tag>inner</tag>`.
 *
 * A handler wins over `TAGS` for the same name, so a construct can keep its principal element in
 * `TAGS` for the safety check's allow-list and still have a drawing rule of its own here.
 */
export const HANDLERS: Record<string, Handler> = {
  Link(node, c) {
    const { md } = c;
    const { close, paren, destination, empty } = linkParts(node, md);
    /*
     * **A bracketed label with no address is not a link, and the editor draws its brackets.**
     *
     * The parser makes `[1.9.4]` in a changelog heading a `Link`, because it cannot see whether a
     * definition exists anywhere in the document and a reference link looks exactly like this.
     * Treating that as a link deleted the brackets from every such line, which was most of the
     * 4,512 lines where the editor left the source and this path changed it. With no address there
     * is nothing to link to, so the honest answer is the characters the file holds.
     *
     * **The address is the one after the opening parenthesis and no other.** A bare address inside
     * the brackets is text that happens to be an autolink, and `[see https://e.com]` used to be
     * taken for a link to that address with the words before it as its label.
     */
    if (!close || (paren && destination === null)) return writtenBrackets(node, c);
    let target = destination;
    if (target === null) {
      /*
       * A reference link, if this document defines its label. `[a][ref]` names it in a second
       * bracket pair, `[a][]` and `[a]` use their own text, and an undefined one is not a link at
       * all: the editor draws its brackets, so this does too.
       */
      const labels = [];
      for (let ch = node.firstChild; ch; ch = ch.nextSibling) if (ch.name === 'LinkLabel') labels.push(md.slice(ch.from + 1, ch.to - 1));
      const own = md.slice(node.from + 1, close.from);
      const label = labelKey(labels[labels.length - 1] || own);
      if (!c.defined.has(label)) return writtenBrackets(node, c);
      // A definition's destination is checked like any other. It is the nastier form of the two,
      // because the payload sits at the bottom of the document away from the words that carry it.
      target = c.defined.get(label) ?? '';
    }
    /*
     * Only the label, not the destination. A link's children are `[`, its words, `](`, the address,
     * an optional title and `)`, and the text between those last four is ordinary text as far as
     * the walk is concerned: hiding the address alone left the space before a title in the output,
     * so `[a](b "T")` drew as `a ` with a stray gap. The label ends at the mark that closes the
     * brackets, and nothing after it is content.
     */
    let label = '';
    let pos = node.from;
    for (let ch = node.firstChild; ch && ch.from < close.from; ch = ch.nextSibling) {
      label += escape(md.slice(pos, ch.from));
      // An address before the closing bracket is part of the words, not the destination: it is
      // written out as text, since an anchor inside an anchor is not valid HTML.
      label += ch.name === 'URL' ? escape(md.slice(ch.from, ch.to)) : c.render(ch);
      pos = ch.to;
    }
    // The words are the text before the closing mark, and stopping without taking them emptied every
    // plain `[words](address)` in the corpus.
    label += escape(md.slice(pos, close.from));
    /*
     * **A link with no words is its address.** `[](address)` has nothing to read or click, and an
     * anchor with no content is in the page, counts as a link and cannot be seen: the same failure
     * as a link that points at a fragment nothing defines, present, well formed and useless. The
     * specification's rule is that nothing stands in for the destination, so it stands for itself,
     * and the editor does this. Only the inline form: `[][label]` has a definition to take words
     * from and the editor draws it without.
     *
     * The angle brackets of `<address>` are delimiters and are not shown, as they are not in the
     * `href`.
     */
    if (empty && paren && destination !== null) label = escape(unangle(destination));
    /*
     * A refused destination drops the anchor and keeps the words.
     *
     * The alternative is an anchor with no `href`, which reads as a link, invites a click and does
     * nothing — the failure mode already filed once as a defect on this path. Text that was never
     * a link is the honest output, and the document is unchanged either way: this path writes
     * nothing back.
     */
    return anchor(target, label);
  },

  /*
   * **One space comes off each end of a code span that begins and ends with one, unless the span is
   * all spaces.** That is CommonMark's rule and the editor's, and it exists because it is the only
   * way to write a span whose content starts or ends with a backtick: `` ` `` is a backtick, and its
   * two spaces are syntax. Kept, they put a space inside every such span, where the element's
   * whitespace is visible.
   *
   * Three details are the whole of the correctness. One space, not all of them: two on each side
   * leaves one. Both ends, since a span padded on one side is content. And not all spaces, which is
   * the clause easiest to drop: `` ` ` `` is a single space and stays one. A line ending counts as a
   * space for the test, as CommonMark has it after turning line endings into spaces, and is stripped
   * as one; an interior line ending is left alone, because a browser folds it anyway and the output
   * keeps the source's lines.
   */
  InlineCode(node, c) {
    const marks = node.getChildren('CodeMark');
    const open = marks[0];
    const close = marks.length > 1 ? marks[marks.length - 1] : null;
    if (!open || !close) return `<code>${c.inner(node)}</code>`;
    let code = c.md.slice(open.to, close.from);
    const asSpaces = code.replace(/\r\n|\r|\n/g, ' ');
    if (asSpaces.length >= 2 && asSpaces.startsWith(' ') && asSpaces.endsWith(' ') && asSpaces.trim() !== '') {
      code = code.replace(/^(?:\r\n|[ \r\n])/, '').replace(/(?:\r\n|[ \r\n])$/, '');
    }
    return `<code>${escape(code)}</code>`;
  },

  /*
   * A task's checkbox is the one replacement in scope: `[x]` leaves the text and something the
   * file does not contain stands in its place. It is a `Task` wrapping the marker and the words,
   * inside the `ListItem`, rather than a property of the item.
   */
  Task(node, c) {
    const marker = childText(node, 'TaskMarker', c.md) ?? '[ ]';
    return `<input type="checkbox" disabled${/[xX]/.test(marker) ? ' checked' : ''}>${c.inner(node)}`;
  },

  /*
   * A callout is a quote that opens `> [!NOTE]`, and it belongs to the `document` profile.
   *
   * It is not in the grammar at all: the editor recognises the marker in its drawing layer, so the
   * tree here is an ordinary `Blockquote` and nothing would stop this rendering it as one. That is
   * the quiet wrong answer this path exists to avoid, because the editor draws a titled panel and
   * this would draw a quote whose first line reads `!NOTE`. Named and left as source instead.
   */
  Blockquote(node, c) {
    const first = c.md.slice(node.from, node.to).split('\n', 1)[0];
    if (/^\s*>?\s*\[![\w-]+\]/.test(first)) return c.refuse('Callout', node);
    return `<blockquote>${c.inner(node)}</blockquote>`;
  },

  /*
   * A paragraph inside a list item draws as the item's own line rather than as a block of its
   * own, which is both what the editor shows and what a tight list means. Wrapping it would put
   * a `<p>` in the output that the comparison against `drawMap` has nothing to match.
   *
   * A paragraph is also where a `$$…$$` block is found, because a block is not a node and the
   * paragraph is what the specification's rule requires one to sit in. A profile that does not carry
   * display maths gets the delimiters and the formula inside a wrapper that names the construct,
   * which is the same answer a table gets, rather than as prose.
   *
   * **The block wins over anything the parser found inside it**, which is what the editor does with
   * the same bytes: its decoration replaces the range whatever nodes are in it. So a construct that
   * overlaps a block at all is not drawn, and its uncovered bytes come out as source. `$$` wrapped
   * in emphasis is the only shape that reaches that rule and both layers now answer it the same way.
   */
  Paragraph(node, c) {
    const blocks = c.mathBlocks.filter((b) => b.from < node.to && b.to > node.from);
    const body = blocks.length > 0 ? c.innerAround(node, blocks) : c.inner(node);
    return node.parent?.name === 'ListItem' ? body : `<p>${body}</p>`;
  },

  /*
   * **An ordered list is numbered by the renderer, from the first item's own number.**
   *
   * This emitted the file's literal markers and suppressed the browser's, on the reasoning that
   * a number the file does not contain is content the file does not contain. That conflated two
   * jobs. The editor keeps the characters because it is an editor over the bytes; a renderer
   * renders what the document *means*, and CommonMark says an ordered list means "start at the
   * first item's number and count". So `1.` three times means 1, 2, 3, which is what GitHub
   * shows and what anybody hand-writing a list expects — and it is the most common way they are
   * written. Emitting the markers gave 1, 1, 1.
   */
  OrderedList(node, c) {
    const first = /^\s*(\d+)/.exec(c.md.slice(node.from, node.to));
    const start = first ? Number(first[1]) : 1;
    return `<ol${start === 1 ? '' : ` start="${start}"`}>${c.inner(node)}</ol>`;
  },

  /*
   * Both Setext spellings are headings and are drawn as the ATX ones are. The content runs to the
   * line before the underline, so what `inner` returns ends in the newline that separates them.
   * That newline stays: HTML collapses it, and it keeps the output the same number of lines as the
   * source, which is what lets `check-render-agrees.mjs` compare the two a line at a time.
   */
  SetextHeading1: (node, c) => `<h1>${c.inner(node)}</h1>`,
  SetextHeading2: (node, c) => `<h2>${c.inner(node)}</h2>`,

  /*
   * A definition has no drawing. It is bookkeeping for the links that name it, and CommonMark takes
   * it out of the document, so the output holds nothing for it. The editor draws it as the source
   * line it is, because a person editing needs to see it, and that is the one construct where the
   * two paths differ on purpose; `check-render-agrees.mjs` leaves those lines out by name.
   *
   * What it leaves behind is whitespace only: the text around a definition is kept as it is for
   * every other node, so the output stays the source's number of lines.
   */
  LinkReference: () => '',

  HorizontalRule: () => '<hr>',

  // The node covers the marker and the newline that follows it, so the newline is written back.
  HardBreak: () => '<br>\n',

  // A backslash before punctuation: the punctuation is the text and the backslash is gone.
  Escape: (node, c) => escape(c.md.slice(node.from + 1, node.to)),

  Entity: (node, c) => escape(decodeEntity(c.md.slice(node.from, node.to))),

  /*
   * **The language word becomes a class only when it is a word.** The info string is whatever
   * follows the opening fence, so it is document text going into an attribute. Escaping would keep
   * it inside the attribute, and the pattern keeps it to the characters a language name uses, so a
   * string meant to be something else yields no class at all instead of a strange one.
   */
  FencedCode(node, c) {
    const word = (childText(node, 'CodeInfo', c.md) ?? '').trim().split(/\s+/)[0];
    const cls = /^[A-Za-z0-9_+#.-]+$/.test(word) ? ` class="language-${word}"` : '';
    const text = codeText(node, c.md);
    /*
     * One output line for each source line, the fences' two included. A browser drops a newline that
     * comes straight after `<pre>`, so the opening fence's line costs nothing on screen, and the
     * newline before the closing tag is the one CommonMark writes after the last line of code. What
     * is left over is counted rather than assumed, because an unclosed fence has no closing line and
     * an empty one has no code.
     */
    const lines = (s: string): number => s.split('\n').length - 1;
    const pad = '\n'.repeat(Math.max(0, lines(c.md.slice(node.from, node.to)) - (1 + lines(text))));
    return `<pre>\n<code${cls}>${escape(text)}${pad}</code></pre>`;
  },

  CodeBlock: (node, c) => `<pre><code>${escape(codeText(node, c.md))}</code></pre>`,

  Autolink(node, c) {
    const url = childText(node, 'URL', c.md);
    return url === null ? escape(c.md.slice(node.from, node.to)) : autolink(url);
  },

  // A bare address in running text. One inside a link is hidden before it gets here.
  URL: (node, c) => autolink(c.md.slice(node.from, node.to)),

  /*
   * An image is its address and its description. The address goes through the same allow-list a
   * link's does, because `src` fetches whatever it names and a `javascript:` or `data:` address is
   * refused here for the same reason it is on a link. A refused image keeps its description as
   * text, which is the honest remainder: the words were the document's, the picture was not
   * permitted. The description is plain text with its marks gone, since an attribute has no
   * emphasis.
   */
  Image(node, c) {
    const { md } = c;
    const marks = node.getChildren('LinkMark');
    const open = marks[0];
    const close = marks.find((m) => md[m.from] === ']');
    if (!open || !close) return escape(md.slice(node.from, node.to));
    let alt = '';
    let pos = open.to;
    for (let ch = open.nextSibling; ch && ch.from < close.from; ch = ch.nextSibling) {
      alt += md.slice(pos, ch.from) + plainText(ch, md);
      pos = ch.to;
    }
    alt += md.slice(pos, close.from);
    let dest = childText(node, 'URL', md);
    if (dest === null) {
      // `![alt][ref]`, `![alt][]` and `![alt]` name their definition the way a reference link does.
      const label = node.getChild('LinkLabel');
      const key = labelKey(label && label.to - label.from > 2 ? md.slice(label.from + 1, label.to - 1) : md.slice(open.to, close.from));
      if (!c.defined.has(key)) return writtenBrackets(node, c);
      dest = c.defined.get(key) ?? '';
    }
    const safe = safeDestination(dest);
    return safe === null ? escape(alt) : `<img src="${escape(safe)}" alt="${escape(alt)}">`;
  },

  /*
   * A table is its header, its alignment row and its body. The dialect parses the whole structure,
   * so this reads cells off the delimiters rather than splitting the source on `|`, which would
   * split an escaped pipe and a pipe inside a cell's own markup.
   *
   * Alignment is the `align` attribute rather than a style, because a consumer's content-security
   * policy may forbid inline styles and this path has no business depending on one that does not.
   * A row shorter than the header is padded and a longer one is cut at it, as GFM says.
   */
  Table(node, c) {
    const { md } = c;
    const cellsOf = (row: SyntaxNode): string[] => {
      const text = md.slice(row.from, row.to);
      const segments: { from: number; to: number; cell: SyntaxNode | null }[] = [];
      let cur: { from: number; to: number; cell: SyntaxNode | null } = { from: row.from, to: row.to, cell: null };
      for (let ch = row.firstChild; ch; ch = ch.nextSibling) {
        if (ch.name === 'TableDelimiter') {
          cur.to = ch.from;
          segments.push(cur);
          cur = { from: ch.to, to: row.to, cell: null };
        } else if (ch.name === 'TableCell') cur.cell = ch;
      }
      segments.push(cur);
      // The empty segment outside a leading or trailing pipe is not a cell.
      if (/^\s*\|/.test(text) && md.slice(segments[0].from, segments[0].to).trim() === '') segments.shift();
      if (/\|\s*$/.test(text) && segments.length && md.slice(segments[segments.length - 1].from, segments[segments.length - 1].to).trim() === '') segments.pop();
      return segments.map((s) => (s.cell ? c.inner(s.cell).trim() : ''));
    };
    const header = node.getChild('TableHeader');
    const rule = node.getChild('TableDelimiter');
    if (!header || !rule) return c.refuse('Table', node, 'unimplemented');
    const heads = cellsOf(header);
    const aligns = md
      .slice(rule.from, rule.to)
      .split('|')
      .map((s) => s.trim())
      .filter((s, i, all) => !(s === '' && (i === 0 || i === all.length - 1)))
      .map((s) => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : ''));
    const cell = (tag: string, i: number, html: string): string => `<${tag}${aligns[i] ? ` align="${aligns[i]}"` : ''}>${html}</${tag}>`;
    const head = `<thead><tr>${heads.map((h, i) => cell('th', i, h)).join('')}</tr></thead>`;
    const rows = node.getChildren('TableRow').map((row) => {
      const cells = cellsOf(row);
      return `<tr>${heads.map((_, i) => cell('td', i, cells[i] ?? '')).join('')}</tr>`;
    });
    // A newline wherever the source has one, the alignment row's included, so that the output is
    // the source's number of lines. The browser sees whitespace between elements and ignores it.
    return `<table>${head}\n${rows.length ? `\n<tbody>${rows.join('\n')}</tbody>` : ''}</table>`;
  },

  /*
   * A footnote reference is drawn where it stands, as the editor draws it: a superscript number with
   * the note for a tooltip. Gathering the notes into a list at the foot of the output is the
   * convention on a page, and the editor has no foot of the page, so both draw the definition where
   * it was written. A reference or a definition that does not resolve stays as written.
   */
  FootnoteReference(node, c) {
    const label = childText(node, 'FootnoteLabel', c.md);
    const key = label === null ? '' : footnoteKey(label);
    const n = c.notes.numbers.get(key);
    if (n === undefined) return escape(c.md.slice(node.from, node.to));
    return `<sup class="md-footnote-ref" title="${escape(c.notes.defs.get(key)?.note ?? '')}">${n}</sup>`;
  },

  FootnoteDefinition(node, c) {
    const label = childText(node, 'FootnoteLabel', c.md);
    const key = label === null ? '' : footnoteKey(label);
    const n = c.notes.numbers.get(key);
    // Only the first definition of a label counts, and one nothing refers to has no number.
    if (n === undefined || c.notes.defs.get(key)?.from !== node.from) return escape(c.md.slice(node.from, node.to));
    let body = '';
    let pos = -1;
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      if (ch.name === 'FootnoteMark' || ch.name === 'FootnoteLabel') continue;
      // The text between two of the note's blocks is kept, so a note of several paragraphs is the
      // source's number of lines.
      if (pos >= 0) body += escape(c.md.slice(pos, ch.from));
      body += pos < 0 && ch.name === 'Paragraph' ? c.inner(ch) : c.render(ch);
      pos = ch.to;
    }
    return `<div class="md-footnote-def"><sup class="md-footnote-num">${n}</sup> ${body}</div>`;
  },

  /*
   * An inline HTML pair is drawn as its content with a class, and the document's own tag is never
   * written out. That is the specification's rule and `check-render-safety.mjs` is what holds it:
   * passing a tag through would make this a sanitiser, which is a component somebody owns for ever.
   * The opening tag becomes a `span` carrying the editor's class and the closing tag closes it.
   *
   * Which tags and which pairs is `inlineHtmlPairAt`'s answer, found for the whole document before
   * the walk, so a tag it does not pair (one with an attribute, an unmatched one, a tag on another
   * line) is a construct this profile does not draw and comes back as source.
   */
  HTMLTag(node, c) {
    if (c.pairs.close.has(node.from)) return '</span>';
    const pair = c.pairs.open.get(node.from);
    if (!pair) return c.refuse('HTMLTag', node, 'profile');
    const title = pair.title === undefined ? '' : ` title="${escape(pair.title.replace(/&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, decodeEntity))}"`;
    return `<span class="${escape(pair.cls)}"${title}>`;
  },
};

export function renderMarkdown(markdown: string, profile: RenderProfile = 'notes'): RenderResult {
  const tree = dialectParser.parse(markdown);
  const outOfScope: OutOfScope[] = [];

  /*
   * **A document's YAML front matter is metadata, and the editor shows it as the bytes it is.**
   *
   * The dialect has no node for it, which is the trap: `title: x` over a closing `---` parses as a
   * Setext heading, so a renderer that trusts the tree turns a file's metadata into a heading and its
   * author list into bullets. That was 4,512 of the 5,550 lines this path disagreed with the editor
   * about, by a long way the largest cause, and every one of them read as a renderer bug when it was
   * one missing rule.
   */
  /*
   * What a profile carries decides whether a pass over the tree is worth making, and what a
   * construct does. Asked here because the definitions below are the first thing that needs it.
   */
  const carries = (name: string): boolean => profileCarries(name, profile);

  /*
   * The labels this document defines, so a reference link can be told from a bracketed phrase.
   *
   * Read off the tree's own `LinkReference` nodes rather than by matching `[x]:` with a pattern,
   * because what counts as a definition is the parser's question and a second answer here would be
   * the kind that drifts. Labels match as `labelKey` says, the first definition of a label is the
   * one that counts, and a definition can sit in a list item or a quote as well as at the top, which
   * is where the editor looks for them too.
   *
   * A profile that does not carry definitions defines nothing, so in a `field` a reference link has
   * nothing to resolve to and is text. Nothing could define a label there: a field is one line.
   */
  const defined = new Map<string, string>();
  const collect = (parent: SyntaxNode): void => {
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      if (DEFINITION_HOSTS.has(n.name)) collect(n);
      if (n.name !== 'LinkReference') continue;
      const label = n.getChild('LinkLabel');
      if (!label) continue;
      const key = labelKey(markdown.slice(label.from + 1, label.to - 1));
      // The definition's address, which is the whole point of reading these: a reference link that
      // resolves to its own label is a styled, clickable link pointing at a fragment nothing defines,
      // and it looks correct until somebody clicks it.
      if (key !== '' && !defined.has(key)) defined.set(key, childText(n, 'URL', markdown) ?? '');
    }
  };
  if (carries('LinkReference')) collect(tree.topNode);

  const lines = markdown.split('\n');
  const matterEnd = frontMatterEnd({ lines: lines.length, line: (n) => ({ text: lines[n - 1] ?? '' }) });
  let matterTo = -1;
  if (matterEnd > 0) {
    matterTo = lines.slice(0, matterEnd).join('\n').length;
    outOfScope.push({ construct: 'FrontMatter', from: 0, to: matterTo, reason: 'profile' });
  }

  /**
   * A construct this render does not draw, named in `outOfScope` and emitted as its own source
   * inside an element that says what it is.
   *
   * Three answers were available and two of them are worse. **Dropping it** makes a table that
   * vanishes indistinguishable from a table nobody wrote, which is the one outcome a consumer cannot
   * recover from. **Emitting the source bare**, which is what this did until now, hands back loose
   * text a consumer cannot select, style or hide: the pipes of an unrendered table arrive mixed into
   * the prose around them with nothing to tell them apart.
   *
   * So: the source, visible, inside something that names the construct. `data-construct` carries the
   * same name `outOfScope` reports, so the structured answer and the output agree and a consumer
   * holding one can find the other.
   *
   * **An element that claims nothing.** A `pre` would say the content is preformatted code, which is
   * a rendering decision about content this path has just said it did not understand. A `div` and a
   * `span` claim only that there is a box.
   *
   * **Which of the two depends on where the construct sits, and that is about valid HTML rather than
   * about meaning.** A `div` inside a `p` ends the paragraph, and an out-of-scope construct is not
   * always a block: an image or a run of inline maths sits inside a paragraph, so a `div` there would
   * produce output a browser restructures. Anything under a `Paragraph`, a heading or a table cell
   * is wrapped in a `span`; everything else, which is the block case a table is the example of, in a
   * `div`. A `field` is one
   * line of inline content wherever a consumer puts it, so every wrapper in one is a `span`: a
   * heading marker typed into a title is a construct the field does not carry, and it must not
   * become a block in the middle of a line.
   *
   * The source is escaped, as it already was. A construct whose text contains `</div>` is the input
   * shaped to close the wrapper from inside, and `escape` turns its angle brackets into entities
   * before it reaches an element at all.
   */
  const unrendered = (construct: string, node: SyntaxNode, reason: Reason): string => {
    let inline = profile === 'field';
    for (let p = node.parent; p; p = p.parent) if (INLINE_HOSTS.has(p.name)) inline = true;
    return unrenderedSpan(construct, node.from, node.to, reason, inline);
  };

  /**
   * The same, for a construct that is not a node and so has a span rather than one.
   *
   * `node.parent` is what decides the wrapper's element above, and a construct found by reading
   * lines has no parent to ask, so the caller says which it is. Everything else is one answer: the
   * source, escaped, inside an element carrying the name `outOfScope` reports.
   */
  const unrenderedSpan = (construct: string, from: number, to: number, reason: Reason, inline: boolean): string => {
    outOfScope.push({ construct, from, to, reason });
    const el = inline ? 'span' : 'div';
    return `<${el} class="sheaf-unrendered" data-construct="${escape(construct)}">${escape(markdown.slice(from, to))}</${el}>`;
  };

  /** A node's children rendered in order, with the text between them escaped. */
  const inner = (node: SyntaxNode): string => {
    let out = '';
    let pos = node.from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      // An indented code block's node starts after its indentation, so the gap before it ends in the
      // four spaces that made it code. Left in, they would sit in the output in front of the `pre`.
      out += escape(c.name === 'CodeBlock' ? markdown.slice(pos, c.from).replace(/[ \t]+$/, '') : markdown.slice(pos, c.from));
      out += render(c);
      pos = c.to;
      if (BLOCK_MARKS.has(c.name)) while (pos < node.to && (markdown[pos] === ' ' || markdown[pos] === '\t')) pos++;
    }
    return out + escape(markdown.slice(pos, node.to));
  };

  /**
   * `inner`, with a set of spans whose bytes are emitted as their own source instead of rendered.
   *
   * It exists for the one construct that is not a node, so there is nothing in the walk to refuse.
   * The spans are whole lines and the only thing that produces them today is `$$…$$`.
   *
   * It is a second walk rather than a flag on `inner` because the two differ in what they do with a
   * child, and `inner` runs over every node in the document while this runs over the paragraphs that
   * hold a block. The two pieces `inner` has that this does not are an indented code block's own
   * indentation and the space after a block marker, and neither can be inside a paragraph.
   */
  const innerAround = (node: SyntaxNode, spans: readonly BlockMathRange[]): string => {
    const overlaps = (from: number, to: number): boolean => spans.some((s) => from < s.to && to > s.from);
    let out = '';
    let pos = node.from;
    let next = 0;
    /* The source from `pos` to `to`, with any span starting inside it emitted as its wrapper. */
    const plain = (to: number): void => {
      while (next < spans.length && spans[next].from < to) {
        const span = spans[next];
        if (span.from > pos) out += escape(markdown.slice(pos, span.from));
        out += unrenderedSpan('BlockMath', span.from, span.to, blockMathReason, true);
        pos = span.to;
        next++;
      }
      if (pos < to) out += escape(markdown.slice(pos, to));
    };
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.to <= pos) continue;
      if (c.from > pos) plain(c.from);
      // Swallowed by a block, or overlapping one: the block wins and these bytes are source, which
      // `plain` emits on its next call rather than this loop skipping them.
      if (c.from < pos || overlaps(c.from, c.to)) continue;
      out += render(c);
      pos = c.to;
    }
    plain(node.to);
    return out;
  };

  /*
   * What footnotes resolve and which inline HTML pairs are drawn, found for the whole document before
   * the walk because each needs to see nodes that come later: a reference is numbered by where it
   * stands among the others, and an opening tag is paired with a closing one further along. A
   * profile that does not carry the construct skips the pass, since it would be reading nodes that
   * are about to be refused.
   */
  const notes = carries('FootnoteReference') ? footnoteIndex(tree, markdown) : { defs: new Map(), numbers: new Map() };
  const pairs = { open: new Map<number, InlineHtmlPair>(), close: new Set<number>() };
  if (carries('HTMLTag')) {
    const doc = {
      sliceString: (from: number, to?: number) => markdown.slice(from, to),
      lineAt: (pos: number) => {
        const end = markdown.indexOf('\n', pos);
        return { to: end < 0 ? markdown.length : end };
      },
    } as unknown as Text;
    tree.iterate({
      enter: (tag) => {
        if (tag.name !== 'HTMLTag') return;
        const pair = inlineHtmlPairAt(tag.node, doc);
        if (!pair) return;
        pairs.open.set(pair.openFrom, pair);
        pairs.close.add(pair.closeFrom);
      },
    });
  }

  /*
   * The display-maths blocks, and the reason they come back as source.
   *
   * Found for every profile, because no profile draws one: `field` and `notes` do not carry display
   * maths and this path has no drawing for it in `document` either, so the answer is the same bytes
   * and a different `reason`. `scopeOf` is what splits the two, exactly as it does for a callout,
   * which is the other construct in the table with no node behind it.
   *
   * A block inside the front matter is not one. Everything that starts in there is metadata and
   * comes back as its own bytes already, so refusing it as well would report a construct twice.
   */
  const blockMathScope = scopeOf('BlockMath', profile);
  const blockMathReason: Reason = blockMathScope === 'profile' ? 'profile' : 'unimplemented';
  const mathBlocks =
    blockMathScope === 'rendered' ? [] : blockMathsIn(linesOf(markdown), tree).filter((b) => b.from >= matterTo);

  const ctx: Ctx = {
    md: markdown,
    profile,
    defined,
    notes,
    pairs,
    mathBlocks,
    innerAround,
    render: (n) => render(n),
    inner,
    refuse: (construct, node, reason) =>
      unrendered(construct, node, reason ?? (scopeOf(construct, profile) === 'profile' ? 'profile' : 'unimplemented')),
  };

  const render = (node: SyntaxNode): string => {
    const name = node.name;
    // Inside the front matter, which is metadata rather than prose: its own bytes, nothing else.
    if (matterTo >= 0 && node.from < matterTo && name !== 'Document') return escape(markdown.slice(node.from, Math.min(node.to, matterTo)));

    if (name === 'Document') return inner(node);
    if (HIDDEN.has(name)) return '';
    if (HIDDEN_IN_LINK.has(name) && node.parent?.name === 'Link') return '';

    /*
     * Out of scope, and said so rather than guessed at, with the reason it is.
     *
     * The profile table decides, and the renderer's own ability to draw only splits the answer: a
     * construct the profile does not name is a decision, and one it names that nothing here draws is
     * a gap. Before that split an omission and a decision were the same value.
     */
    const scope = scopeOf(name, profile);
    if (scope !== 'rendered') return unrendered(name, node, scope);

    const handler = HANDLERS[name];
    if (handler) return handler(node, ctx);
    const tag = TAGS[name];
    if (tag) return `<${tag}>${inner(node)}</${tag}>`;
    return inner(node);
  };

  return { html: render(tree.topNode), outOfScope };
}
