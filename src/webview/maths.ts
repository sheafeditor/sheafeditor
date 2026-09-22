/*
 * Maths: `$…$` typeset where it stands, `$$…$$` typeset as a block.
 *
 * A document that reads as equations everywhere else should read as equations
 * here. KaTeX does the typesetting, bundled with the extension along with its
 * stylesheet and fonts: it renders synchronously, so a block's height is known
 * by the time it is drawn and nothing below it shifts after paint, and nothing
 * is fetched over the network, so a document looks the same on a plane as it
 * does at a desk.
 *
 * Nothing here writes to the document. An equation is a decoration over the
 * bytes that are already there, exactly as every other rendered element is, and
 * the source comes back on the lines that are showing it.
 *
 * ## What is not maths
 *
 * A dollar sign in these documents is far more often money than an equation, so
 * the delimiter rules are the narrow ones github.com uses, and they are what
 * keeps a sentence about prices out of a half-drawn formula:
 *
 *   - No space directly inside the delimiters. `$ 5` cannot open and `y $`
 *     cannot close, which is most of what keeps "$ 5 or $ 10" text.
 *   - A closing `$` is not a closing `$` when a digit follows it, which is the
 *     rest of what keeps "$5 or $10" text.
 *   - A span never crosses a line break, so an opening `$` is looking for its
 *     closer on its own line and gives up at the end of it.
 *   - A span never contains a backtick. Code is parsed before this is, so a
 *     `$` inside `code` is already spoken for; the backtick rule is what stops
 *     an earlier stray `$` reaching across a code span and swallowing it.
 *   - `\$` is an escape and never reaches here at all, and a backslash inside a
 *     span is skipped with the character after it, so `\$` inside an equation
 *     is a dollar sign in the equation rather than its end.
 *
 * A `$$` block is recognised at the top level of the document, between a line
 * that opens with `$$` and a later line that is `$$` alone, and only within one
 * paragraph. Both halves of that matter. Staying inside a paragraph is how an
 * opening `$$` with no closer yet — the normal state two seconds after someone
 * types it — is left as written instead of swallowing the rest of the document.
 * Staying at the top level is how a `$$` inside a fenced block, a quote or a
 * list stays as written; that is narrower than github.com, and the cost of it
 * is source shown rather than something drawn wrongly.
 */

import { Decoration, WidgetType } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { MarkdownConfig } from '@lezer/markdown';
import { SyntaxNode, Tree } from '@lezer/common';
import { tags } from '@lezer/highlight';
import katex, { KatexOptions } from 'katex';

const DOLLAR = 36;
const BACKSLASH = 92;
const BACKTICK = 96;
const NEWLINE = 10;

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === NEWLINE || code === 13;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * `$…$` as a Lezer Markdown extension.
 *
 * The span is added as one element rather than as a pair of delimiters, so
 * nothing inside it is parsed as Markdown: `$a_i$` is a subscript and not the
 * start of emphasis, and `$a * b$` keeps its asterisk.
 *
 * `$$` is left alone here. Display maths is a block, and the block half of this
 * module reads it off the document rather than out of the tree.
 */
export const Maths: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: { 'InlineMath/...': tags.special(tags.content) } },
    { name: 'InlineMathMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        // `$$` opens display maths, which is a block, and `$$x$$` mid-sentence
        // is left as written rather than drawn as one.
        if (cx.char(pos + 1) === DOLLAR) return -1;
        if (pos > cx.offset && cx.char(pos - 1) === DOLLAR) return -1;
        const after = cx.char(pos + 1);
        if (after < 0 || isSpace(after)) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === BACKTICK) return -1;
          if (ch === BACKSLASH) {
            i++;
            continue;
          }
          if (ch !== DOLLAR) continue;
          if (isSpace(cx.char(i - 1))) continue;
          if (isDigit(cx.char(i + 1))) continue;
          return cx.addElement(
            cx.elt('InlineMath', pos, i + 1, [
              cx.elt('InlineMathMark', pos, pos + 1),
              cx.elt('InlineMathMark', i, i + 1),
            ])
          );
        }
        return -1;
      },
    },
  ],
};

// ---- Typesetting ----------------------------------------------------------

const options = (displayMode: boolean): KatexOptions => ({
  displayMode,
  // The fallback for maths that does not parse is this module's own, so KaTeX
  // is asked to throw rather than to draw its red error markup in place.
  throwOnError: true,
  // A document is not a LaTeX submission, and a warning in a console nobody has
  // open helps nobody.
  strict: 'ignore',
  // `\href` and `\includegraphics` stay off: a document should not be able to
  // put a link or an image into the page through an equation.
  trust: false,
});

/** KaTeX's own message for a source it refused, or a last-resort description. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/*
 * Whether a source typesets, remembered per source.
 *
 * The decoration layer asks this for every equation it can see, on every
 * redraw, and the answer for one string never changes. The cache is cleared
 * rather than trimmed once it is large, which costs one re-typeset of whatever
 * is on screen and keeps a long editing session from holding every half-typed
 * formula anyone ever passed through.
 */
const errors = new Map<string, string | null>();

/** KaTeX's message for `source`, or null when it typesets. */
export function mathError(source: string, display: boolean): string | null {
  // One character of prefix, so a display source and an inline one of the same
  // text are two entries rather than one.
  const key = (display ? 'd' : 'i') + source;
  let message = errors.get(key);
  if (message === undefined) {
    message = null;
    try {
      katex.renderToString(source, options(display));
    } catch (err) {
      message = messageOf(err);
    }
    if (errors.size > 500) errors.clear();
    errors.set(key, message);
  }
  return message;
}

/** Typeset `source` into `host`, falling back to the source itself. */
function typeset(host: HTMLElement, source: string, display: boolean): void {
  try {
    katex.render(source, host, options(display));
  } catch (err) {
    // The decoration layer only builds a widget for a source that typeset a
    // moment ago, so this is the belt to that braces. Either way the source is
    // what shows: an equation never silently disappears.
    host.classList.add('md-math-error');
    host.textContent = display ? `$$${source}$$` : `$${source}$`;
    host.title = messageOf(err);
  }
}

class InlineMathWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: InlineMathWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'md-math md-math-inline';
    typeset(span, this.source, false);
    return span;
  }
  ignoreEvent(): boolean {
    // Let a click place the caret, which is what Edit Markdown then works on.
    return false;
  }
}

class BlockMathWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: BlockMathWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'md-math md-math-block';
    // A block equation is easily wider than an editor pane, and an equation is
    // not something a reader can reflow, so the overflow scrolls inside the
    // block rather than clipping it or pushing the text column sideways. The
    // region is focusable so the scrolling is reachable without a pointer, and
    // named so a screen reader says what it is and that it moves.
    const region = document.createElement('div');
    region.className = 'md-math-scroll';
    region.tabIndex = 0;
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Equation, scrollable');
    typeset(region, this.source, true);
    wrap.appendChild(region);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** The decoration that draws `$source$` as typeset inline maths. */
export function inlineMath(source: string): Decoration {
  return Decoration.replace({ widget: new InlineMathWidget(source) });
}

/** The decoration that draws a `$$` block as a typeset equation. */
export function blockMath(source: string): Decoration {
  return Decoration.replace({ widget: new BlockMathWidget(source), block: true });
}

/**
 * How maths that does not typeset is drawn: as itself.
 *
 * Half-typed maths is the normal state while someone is writing it, so the
 * source stays exactly where it is, still editable, marked as not typesetting
 * and carrying KaTeX's own message. Replacing it with a widget that redrew the
 * same characters would have made the caret skip the formula being fixed.
 */
export function inlineMathError(message: string): Decoration {
  return Decoration.mark({ class: 'md-math-error', attributes: { title: message } });
}

/** The same, for a line of a `$$` block. */
export function blockMathError(message: string): Decoration {
  return Decoration.line({ class: 'md-math-error', attributes: { title: message } });
}

// ---- Block maths ----------------------------------------------------------

/** A `$$…$$` block: the whole of the lines it occupies, and the TeX inside it. */
export interface BlockMathRange {
  /** The start of the opening line. */
  from: number;
  /** The end of the closing line. */
  to: number;
  /** The TeX between the delimiters. */
  source: string;
}

/**
 * The top-level paragraph containing `pos`, or null when what is there is any
 * other kind of block: a fence, a quote, a list, a table, or a paragraph nested
 * inside one of those.
 */
function topLevelParagraph(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.parent && node.parent.name !== 'Document') node = node.parent;
  if (!node || !node.parent) return null;
  return node.name === 'Paragraph' ? node : null;
}

/** Every `$$…$$` block in the document, in order. */
export function blockMathRanges(state: EditorState): BlockMathRange[] {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const found: BlockMathRange[] = [];

  for (let n = 1; n <= doc.lines; n++) {
    const open = doc.line(n);
    // Every line of the document passes through here on every redraw, so the
    // cheap test that allocates nothing comes before the ones that do.
    if (!open.text.includes('$$')) continue;
    const indent = open.text.length - open.text.trimStart().length;
    // Four spaces in is an indented code block, and its own delimiters are text.
    if (indent >= 4) continue;
    const trimmed = open.text.trim();
    if (!trimmed.startsWith('$$')) continue;
    const paragraph = topLevelParagraph(tree, open.from + indent);
    if (!paragraph) continue;

    // `$$E = mc^2$$`, written on one line.
    if (trimmed.length >= 4 && trimmed.endsWith('$$')) {
      const source = trimmed.slice(2, -2);
      if (source.trim() !== '') found.push({ from: open.from, to: open.to, source });
      continue;
    }

    // Otherwise the closer is a later line of the same paragraph that is `$$`
    // and nothing else. An empty pair is someone who has just typed the
    // delimiters, so it is left showing them rather than drawn as a blank.
    const last = doc.lineAt(paragraph.to).number;
    let close = 0;
    for (let m = n + 1; m <= last; m++) {
      if (doc.line(m).text.trim() === '$$') {
        close = m;
        break;
      }
    }
    if (!close) continue;
    const closeLine = doc.line(close);
    const source = doc.sliceString(open.from + indent + 2, closeLine.from);
    if (source.trim() !== '') found.push({ from: open.from, to: closeLine.to, source });
    n = close;
  }

  return found;
}
