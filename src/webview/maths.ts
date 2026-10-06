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

import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode, Tree } from '@lezer/common';
import type { KatexOptions } from 'katex';

/**
 * KaTeX is fetched when a document first shows an equation, not when the editor loads.
 *
 * It was imported at module scope, and `markdownDialect.ts` imports this file for the `Maths`
 * parser extension, so every document in every host paid 77 KB gzipped for maths rendering
 * whether it held an equation or not. The parser needs none of it: only `mathError` and
 * `typeset` do, and both are reached only once something looks like maths.
 *
 * `await import('katex')` rather than a URL, deliberately. It keeps KaTeX inside the dependency
 * graph, so esbuild splits it into a chunk that `scripts/check-bundle-size.mjs` still counts.
 * Fetching it by URL from the media folder, which is how Mermaid does it because it ships as a
 * separate asset, would move the bytes out of the closure the gate measures and read as a win
 * of 77 KB that is only a change in where they are recorded.
 */
type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let pending: Promise<void> | null = null;
let wanted = false;
let attempts = 0;
let load: () => Promise<Katex> = async () => (await import('katex')).default;

/**
 * How many times a failed fetch is started again before KaTeX is called lost.
 *
 * **This replaces a decision to never retry, and the reason that decision gave was right about the
 * thing it was weighing.** It said: "A failed load leaves `katex` null for ever rather than
 * retrying per pass, so a document full of equations does not become a document full of requests."
 * `loadMaths` is called from the view plugin's `update`, which runs on every transaction, so an
 * uncapped retry really is one request per keystroke on a page whose policy blocks the chunk.
 *
 * What it did not weigh is that one flake then costs the rest of the session: `katex` stays null,
 * every equation draws as its own source, and nothing anywhere knows why. The choice was framed as
 * permanence against flooding, and a small cap is neither. A flake recovers on the next update, and
 * a blocked chunk is asked for three times and then left alone.
 *
 * The same number is in `emoji.ts`, for the same shape of fetch, and the two were copied from each
 * other — which is why the discarded rejection was in both.
 */
const ATTEMPTS = 3;

/**
 * Hand KaTeX over directly, already loaded. For an offline check that mounts the editor and
 * asserts in the same breath.
 *
 * Making maths lazy turned "is KaTeX here" into a question every *synchronous* observer has to
 * answer, and the jsdom suites are synchronous observers: they mount, assert, and a dynamic
 * import has not resolved. Three prose scenarios failed on exactly that, correctly.
 *
 * `setMathsLoader` cannot serve them, because a loader still resolves on a later tick, so every
 * such check would gain an await and a tick of its own. This hands the module over with no
 * promise in the path, so a suite says "maths is available here" in one line and the shipping
 * path stays lazy.
 */
export function provideMaths(api: Katex): void {
  katex = api;
  pending = null;
  attempts = 0;
}

/** Replace the loader. For tests; forgets anything already loaded or remembered. */
export function setMathsLoader(loader: () => Promise<Katex>): void {
  load = loader;
  katex = null;
  pending = null;
  // Including the attempt count, or a check that drove the loader to exhaustion would leave the
  // next one unable to fetch at all, and it would read as the new loader never being called.
  attempts = 0;
  // `wanted` stays as it is. It records that this document has maths in it, which replacing the
  // loader does not change, and clearing it would leave a test that swapped the loader waiting
  // for a request the builders have already made.
  errors.clear();
}

/**
 * Whether maths can be drawn yet.
 *
 * **Callers ask this before `mathError` or before building a widget**, and that order is what
 * keeps `errors` a cache of permanent facts. Whether a source typesets is a property of the
 * source; whether KaTeX has arrived is a property of the clock. Folding the second into
 * `mathError`'s answer stores a fact about the clock in a map that is never revisited.
 *
 * The damage lands on a source KaTeX rejects, which is why the separation is worth a function of
 * its own. Measured by introducing a third answer and asking in that order: `\frac{1}` asked
 * before the library arrives caches as having no error, so it renders as a valid equation for the
 * rest of the session, while the same source asked a moment later is correctly reported as
 * "Unexpected end of input in a macro argument". Two identical equations then disagree according
 * to which was first looked at, and the one that is wrong never corrects itself. That is worse
 * than maths failing to draw, because nothing about it looks like a failure.
 *
 * The shipping path throws instead, from `api()` placed outside `mathError`'s try block, so
 * breaking this contract is loud rather than caught and stored as KaTeX's opinion of the source.
 */
export function mathsReady(): boolean {
  return katex !== null;
}

/**
 * Whether KaTeX is not coming: every attempt was made and every one failed.
 *
 * The third state, for the same reason `emojiLost()` exists: a caller that can only ask
 * `mathsReady()` cannot tell an equation still waiting for the library from one that will never
 * typeset. Both false together mean in flight, or not yet asked for.
 *
 * It says nothing about whether a *source* typesets, which is `mathError`'s question and is a
 * property of the source rather than of the clock. The separation above is the whole reason that
 * cache holds permanent facts.
 */
export function mathsLost(): boolean {
  return katex === null && pending === null && attempts >= ATTEMPTS;
}

/** Dispatched once KaTeX has arrived, so the fields that draw maths rebuild. */
export const mathsLoaded = StateEffect.define<null>();

/**
 * Start fetching KaTeX, and redraw when it lands.
 *
 * Safe to call on every pass, which it is: one fetch is in flight at a time, a call with KaTeX
 * already here does nothing, and a call after `ATTEMPTS` failures does nothing. See `ATTEMPTS`
 * above for why that is a small number rather than one or none.
 *
 * What a person sees while it is in flight, and after it is lost, is every equation as its own
 * source. That is what they see while typing one and is the same fallback `typeset` already uses.
 */
/**
 * Say that this document holds maths, so it is worth fetching KaTeX.
 *
 * Separate from `loadMaths` because the two halves sit on different sides of CodeMirror's own
 * boundary. The block builder is a `StateField`, which is given a state and may not dispatch;
 * the inline builder is given a view and may. So the state side records the need and the view
 * side acts on it, and neither has to pretend to be the other.
 *
 * Costs a redraw at worst: if a document holds only block maths, the field sets this and the
 * view plugin picks it up on the following update, which the dispatch on load then follows with
 * a rebuild anyway.
 */
export function requestMaths(): void {
  wanted = true;
}

export function loadMaths(view: EditorView): void {
  if (!wanted || katex || pending || attempts >= ATTEMPTS) return;
  attempts++;
  pending = load().then(
    (loaded) => {
      katex = loaded;
      pending = null;
      view.dispatch({ effects: mathsLoaded.of(null) });
    },
    // Cleared rather than discarded: a settled promise is still a promise, so leaving it here made
    // one failure permanent. `mathsLost()` is the fact a caller acts on, so the error is not kept.
    () => {
      pending = null;
    }
  );
}

/**
 * KaTeX, for the two functions that need it.
 *
 * Throws rather than returning anything, because every value it could return is a lie a caller
 * would act on: null reads as "this equation is fine" and a widget gets built that cannot draw.
 * **Called outside `mathError`'s try block on purpose**, so a contract breach propagates instead
 * of being caught and cached as KaTeX's opinion of the equation.
 */
function api(): Katex {
  if (!katex) throw new Error('maths: KaTeX is not loaded. Ask mathsReady() before mathError() or before building a widget.');
  return katex;
}


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
    // Outside the try, so a caller that skipped `mathsReady` is a loud bug rather than an
    // equation remembered for ever as broken.
    const k = api();
    message = null;
    try {
      k.renderToString(source, options(display));
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
    api().render(source, host, options(display));
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

