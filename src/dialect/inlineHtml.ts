/*
 * Inline HTML formatting tags in prose, such as `<kbd>F5</kbd>` or `H<sub>2</sub>O`.
 *
 * GitHub draws a small set of inline tags as formatting, and they are the
 * spelling people use for what Markdown has no syntax for: key caps,
 * subscript and superscript (the dialect leaves out Pandoc's `~sub~` and
 * `^sup^` because GitHub does not read them), abbreviations, and so on. This
 * module finds a matched pair of those tags so the live preview can hide the
 * tags and style what they wrap, exactly as it does for `**` or `==`.
 *
 * It is deliberately narrow. Only the tags below, with no attributes except an
 * abbreviation's `title`, and only an open and close pair on one line with no
 * other kind of tag between them. Everything else is left as written, because
 * guessing at arbitrary HTML is how an editor ends up drawing something the
 * file does not say. The parser never produces a tag node inside code, so a
 * tag in backticks or a code block is never seen here.
 */

/*
 * Both of these are `import type` rather than value imports, and that is a rule rather than tidiness.
 *
 * A value import of `@codemirror/state` here would put 45 KB of runtime dependency into a path that
 * wants only the type. **`import type` is what stands there**, at compile time, in this file,
 * whatever else changes around it. While the file lived in `src/webview/`, the thing holding that
 * line was a sentence in the importer saying it "imports only types", which somebody had to
 * re-verify by reading.
 *
 * Which checks would also catch it, measured rather than assumed, because the first version of this
 * comment named the wrong one and a correction to it named none:
 *
 *   `check-dialect-imports`  **no.** Its `FORBIDDEN` is `['@codemirror/view']` and nothing else, so
 *                            `state` passes it. `view` depends on `state` rather than the reverse,
 *                            so there is no transitive route either.
 *   `check-package`          **yes, indirectly.** Its `FORBIDDEN` does list `@codemirror/state`, and
 *                            this module is in `lib/index.js`'s and `lib/render.js`'s eager closures,
 *                            so the bytes would show up there. That is a check over a built metafile
 *                            reached through closure membership, which is a longer way round and one
 *                            a change to the bundling could move.
 *
 * So the compiler is the direct guarantee and the package check is a backstop that happens to cover
 * it today. That is the honest ordering and it is the argument for `import type` rather than against:
 * the claim is enforced here, where it is made.
 */
import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/** The class each formatting tag's content is drawn with, by tag name. */
const TAG_CLASSES: Record<string, string> = {
  kbd: 'tok-html-kbd',
  sub: 'tok-html-sub',
  sup: 'tok-html-sup',
  abbr: 'tok-html-abbr',
  mark: 'tok-html-mark',
  small: 'tok-html-small',
  ins: 'tok-html-ins',
  del: 'tok-html-del',
  s: 'tok-html-del',
  u: 'tok-html-u',
  // The HTML spellings of what `**` and `*` write, drawn as those are, so a line
  // mixing them with the tags above does not show some tags and hide others.
  strong: 'tok-strong',
  b: 'tok-strong',
  em: 'tok-em',
  i: 'tok-em',
  // Drawn as the same chip as backtick code, so it gets that class instead.
  code: 'tok-inline-code',
};

const OPEN = /^<([a-z]+)((?:\s+title\s*=\s*(?:"[^"]*"|'[^']*'))?)\s*>$/i;
const CLOSE = /^<\/([a-z]+)\s*>$/i;

interface ParsedTag {
  name: string;
  close: boolean;
  /** The raw `title` value, quotes removed and entities still encoded. */
  title?: string;
}

/** A tag from the set, or null for anything else: other names, other attributes, a self-closing tag. */
function parseTag(raw: string): ParsedTag | null {
  const close = CLOSE.exec(raw);
  if (close) {
    const name = close[1].toLowerCase();
    return name in TAG_CLASSES ? { name, close: true } : null;
  }
  const open = OPEN.exec(raw);
  if (!open) return null;
  const name = open[1].toLowerCase();
  if (!(name in TAG_CLASSES)) return null;
  if (!open[2]) return { name, close: false };
  // Only an abbreviation's title means anything to a reader here.
  if (name !== 'abbr') return null;
  const value = /=\s*(["'])([\s\S]*)\1\s*$/.exec(open[2]);
  return { name, close: false, title: value ? value[2] : '' };
}

export interface InlineHtmlPair {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  /** The class the content between the tags is drawn with. */
  cls: string;
  /** An abbreviation's title, entities still encoded. */
  title?: string;
}

/**
 * The formatting pair that `open` starts, or null when it starts none.
 *
 * `open` is an `HTMLTag` node. Its closing tag is looked for among the nodes
 * after it with the same parent, on the same line. A second opening tag of the
 * same name, or any tag outside the set, ends the search with no match, so
 * nesting the reader would have to guess at stays as source.
 */
export function inlineHtmlPairAt(open: SyntaxNode, doc: Text): InlineHtmlPair | null {
  const tag = parseTag(doc.sliceString(open.from, open.to));
  if (!tag || tag.close) return null;
  const lineEnd = doc.lineAt(open.from).to;
  for (let next = open.nextSibling; next && next.to <= lineEnd; next = next.nextSibling) {
    if (next.name !== 'HTMLTag') continue;
    const other = parseTag(doc.sliceString(next.from, next.to));
    if (!other) return null;
    if (other.name !== tag.name) continue;
    if (!other.close) return null;
    if (next.from === open.to) return null;
    return {
      openFrom: open.from,
      openTo: open.to,
      closeFrom: next.from,
      closeTo: next.to,
      cls: TAG_CLASSES[tag.name],
      title: tag.title,
    };
  }
  return null;
}
