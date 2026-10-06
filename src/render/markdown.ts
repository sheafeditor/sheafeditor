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
 * and `TAGS` is the second, and every construct is in one or the other. The comparison that proves
 * they agree is per-line against `drawMap`, which reads the real editor under jsdom.
 *
 * ## Profiles
 *
 * `field` carries the six inline constructs a title field has; `notes` adds the block constructs a
 * comment box has. Anything else — tables, images, maths, fenced code, diagrams — belongs to the
 * `document` profile, and this **names it in `outOfScope` and leaves its source as text** rather
 * than rendering it wrongly or dropping it. A consumer that gets back an empty `outOfScope` knows
 * everything in its input was understood; one that gets a list knows exactly what was not, which is
 * the answer a silent fallback cannot give.
 */
import { parser } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { markdownDialect } from '../dialect/markdown';
/*
 * Reaching into `src/webview/` for one rule, which is the wrong direction and is deliberate.
 *
 * `frontMatter.ts` is a leaf that imports nothing of Sheaf's and only a type from CodeMirror, so it
 * costs this path nothing, and it is the single definition of where a document's front matter ends.
 * Writing those six lines again here is what the module's own comment exists to prevent. The file
 * arguably belongs beside the dialect rather than in the editor, and moving it is dependency
 * direction, which is the CTO's.
 */
import { frontMatterEnd } from '../webview/frontMatter';

/** Which constructs exist, from `docs/14-editor-as-components.md`. */
export type Profile = 'field' | 'notes';

/** A construct this profile does not carry, left as source and named. */
export interface OutOfScope {
  construct: string;
  from: number;
  to: number;
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

/** The six a `field` carries. Everything else in `TAGS` is `notes` and above. */
const FIELD_ONLY = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Highlight', 'Link', 'Paragraph']);

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
 *
 * What is deliberately not done is unescaping `\<` and `\>` inside the brackets. The editor does not
 * either — it draws the bytes the file holds — and a second difference would be a second thing for
 * the comparison against it to disagree about.
 */
function safeDestination(raw: string): string | null {
  // Delimiters off before anything reads the destination, including the scheme test below.
  const dest = raw.length > 1 && raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
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

export function renderMarkdown(markdown: string, profile: Profile = 'notes'): RenderResult {
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
   * The labels this document defines, so a reference link can be told from a bracketed phrase.
   *
   * Read off the tree's own `LinkReference` nodes rather than by matching `[x]:` with a pattern,
   * because what counts as a definition is the parser's question and a second answer here would be
   * the kind that drifts. Labels match whatever their case, as CommonMark says.
   */
  const defined = new Map<string, string>();
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'LinkReference') continue;
    let label: string | null = null;
    let url = '';
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === 'LinkLabel') label = markdown.slice(c.from + 1, c.to - 1).toLowerCase();
      // The definition's address, which is the whole point of reading these: a reference link that
      // resolves to its own label is a styled, clickable link pointing at a fragment nothing defines,
      // and it looks correct until somebody clicks it.
      if (c.name === 'URL') url = markdown.slice(c.from, c.to);
    }
    if (label !== null) defined.set(label, url);
  }

  const lines = markdown.split('\n');
  const matterEnd = frontMatterEnd({ lines: lines.length, line: (n) => ({ text: lines[n - 1] ?? '' }) });
  let matterTo = -1;
  if (matterEnd > 0) {
    matterTo = lines.slice(0, matterEnd).join('\n').length;
    outOfScope.push({ construct: 'FrontMatter', from: 0, to: matterTo });
  }

  const carried = (name: string): boolean => (profile === 'field' ? FIELD_ONLY.has(name) : name in TAGS || name === 'Link');

  /**
   * A construct this profile does not carry, named in `outOfScope` and emitted as its own source
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
   * produce output a browser restructures. Anything under a `Paragraph` is wrapped in a `span`;
   * everything else, which is the block case a table is the example of, in a `div`.
   *
   * The source is escaped, as it already was. A construct whose text contains `</div>` is the input
   * shaped to close the wrapper from inside, and `escape` turns its angle brackets into entities
   * before it reaches an element at all.
   */
  const unrendered = (construct: string, node: SyntaxNode): string => {
    outOfScope.push({ construct, from: node.from, to: node.to });
    let inline = false;
    for (let p = node.parent; p; p = p.parent) if (p.name === 'Paragraph') inline = true;
    const el = inline ? 'span' : 'div';
    return `<${el} class="sheaf-unrendered" data-construct="${escape(construct)}">${escape(markdown.slice(node.from, node.to))}</${el}>`;
  };

  /** A node's children rendered in order, with the text between them escaped. */
  const inner = (node: SyntaxNode): string => {
    let out = '';
    let pos = node.from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      out += escape(markdown.slice(pos, c.from));
      out += render(c);
      pos = c.to;
      if (BLOCK_MARKS.has(c.name)) while (pos < node.to && (markdown[pos] === ' ' || markdown[pos] === '\t')) pos++;
    }
    return out + escape(markdown.slice(pos, node.to));
  };

  const render = (node: SyntaxNode): string => {
    const name = node.name;
    // Inside the front matter, which is metadata rather than prose: its own bytes, nothing else.
    if (matterTo >= 0 && node.from < matterTo && name !== 'Document') return escape(markdown.slice(node.from, Math.min(node.to, matterTo)));


    if (HIDDEN.has(name)) return '';

    if (HIDDEN_IN_LINK.has(name) && node.parent?.name === 'Link') return '';

    if (name === 'Link' && carried('Link')) {
      const href = childText(node, 'URL', markdown);
      /*
       * **A bracketed label with no address is not a link, and the editor draws its brackets.**
       *
       * The parser makes `[1.9.4]` in a changelog heading a `Link`, because it cannot see whether a
       * definition exists anywhere in the document and a reference link looks exactly like this.
       * Treating that as a link deleted the brackets from every such line, which was most of the
       * 4,512 lines where the editor left the source and this path changed it. With no address there
       * is nothing to link to, so the honest answer is the characters the file holds.
       */
      if (href === null) {
        /*
         * A reference link, if this document defines its label. `[a][ref]` names it in a second
         * bracket pair, `[a][]` and `[a]` use their own text, and an undefined one is not a link at
         * all: the editor draws its brackets, so this does too.
         */
        const labels = [];
        for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkLabel') labels.push(markdown.slice(c.from + 1, c.to - 1));
        const own = markdown.slice(node.from + 1, markdown.indexOf(']', node.from));
        const label = (labels[labels.length - 1] || own).toLowerCase();
        if (!defined.has(label)) return escape(markdown.slice(node.from, node.to));
        const target = defined.get(label) ?? '';
        let text = '';
        let at = node.from;
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'LinkMark' && markdown[c.from] === ']') {
            text += escape(markdown.slice(at, c.from));
            break;
          }
          text += escape(markdown.slice(at, c.from)) + render(c);
          at = c.to;
        }
        // A definition's destination is checked like any other. It is the nastier form of the two,
        // because the payload sits at the bottom of the document away from the words that carry it.
        const safeTarget = safeDestination(target);
        return safeTarget === null ? text : `<a href="${escape(safeTarget)}">${text}</a>`;
      }
      /*
       * Only the label, not the destination. A link's children are `[`, its words, `](`, the address,
       * an optional title and `)`, and the text between those last four is ordinary text as far as
       * the walk is concerned: hiding the address alone left the space before a title in the output,
       * so `[a](b "T")` drew as `a ` with a stray gap. The label ends at the mark that opens the
       * destination, and nothing after it is content.
       */
      let label = '';
      let pos = node.from;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === 'LinkMark' && markdown[c.from] === ']') {
          // The words are the text before this mark, and breaking without taking them emptied every
          // plain `[words](address)` in the corpus.
          label += escape(markdown.slice(pos, c.from));
          break;
        }
        label += escape(markdown.slice(pos, c.from));
        label += render(c);
        pos = c.to;
      }
      /*
       * A refused destination drops the anchor and keeps the words.
       *
       * The alternative is an anchor with no `href`, which reads as a link, invites a click and does
       * nothing — the failure mode already filed once as a defect on this path. Text that was never
       * a link is the honest output, and the document is unchanged either way: this path writes
       * nothing back.
       */
      const safeHref = safeDestination(href);
      return safeHref === null ? label : `<a href="${escape(safeHref)}">${label}</a>`;
    }

    /*
     * A task's checkbox is the one replacement in scope: `[x]` leaves the text and something the
     * file does not contain stands in its place. It is a `Task` wrapping the marker and the words,
     * inside the `ListItem`, rather than a property of the item.
     */
    if (name === 'Task' && profile !== 'field') {
      const marker = childText(node, 'TaskMarker', markdown) ?? '[ ]';
      return `<input type="checkbox" disabled${/[xX]/.test(marker) ? ' checked' : ''}>${inner(node)}`;
    }

    /*
     * A callout is a quote that opens `> [!NOTE]`, and it belongs to the `document` profile.
     *
     * It is not in the grammar at all: the editor recognises the marker in its drawing layer, so the
     * tree here is an ordinary `Blockquote` and nothing would stop this rendering it as one. That is
     * the quiet wrong answer this path exists to avoid, because the editor draws a titled panel and
     * this would draw a quote whose first line reads `!NOTE`. Named and left as source instead.
     */
    if (name === 'Blockquote') {
      const first = markdown.slice(node.from, node.to).split('\n', 1)[0];
      if (/^\s*>?\s*\[![\w-]+\]/.test(first)) return unrendered('Callout', node);
    }

    const tag = TAGS[name];
    if (tag && carried(name)) {
      /*
       * A paragraph inside a list item draws as the item's own line rather than as a block of its
       * own, which is both what the editor shows and what a tight list means. Wrapping it would put
       * a `<p>` in the output that the comparison against `drawMap` has nothing to match.
       */
      if (name === 'Paragraph' && node.parent?.name === 'ListItem') return inner(node);
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
      if (name === 'OrderedList') {
        const first = /^\s*(\d+)/.exec(markdown.slice(node.from, node.to));
        const start = first ? Number(first[1]) : 1;
        return `<ol${start === 1 ? '' : ` start="${start}"`}>${inner(node)}</ol>`;
      }
      return `<${tag}>${inner(node)}</${tag}>`;
    }

    /*
     * Out of scope, and said so rather than guessed at.
     *
     * There used to be two branches here, one testing `node.firstChild === null` and one not, with
     * the same body. The second subsumes the first, so the first never decided anything; collapsed
     * rather than left as a distinction a reader would look for a reason behind.
     */
    if (name !== 'Document' && !tag) return unrendered(name, node);
    return inner(node);
  };

  return { html: render(tree.topNode), outOfScope };
}
