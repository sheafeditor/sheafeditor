/*
 * What the dialect suite is run against: the Markdown parser on its own.
 *
 * `sheafMarkdownLanguage` is the whole surface under test. No editor, no DOM and no
 * gesture: a construct's boundaries are a fact about bytes, and everything above the
 * parser is a separate question already asked by the other suites. The widget classes
 * the extension modules define are never instantiated here, which is why this bundles
 * for Node despite living under `src/webview/`.
 *
 * This exists because the specification's dialect section was written by reading those
 * modules and their comments, and a comment is a claim about code rather than a reading
 * of it.
 */

import { EditorState } from '@codemirror/state';
import { sheafMarkdownLanguage } from '../src/webview/markdownLanguage';
import { blockMathRanges } from '../src/webview/maths';

export interface Found {
  name: string;
  from: number;
  to: number;
  /** The bytes the node covers, which is what a rule about a dialect is actually about. */
  text: string;
}

/** Every node the parser finds, in document order. */
export function parse(text: string): Found[] {
  const tree = sheafMarkdownLanguage.parser.parse(text);
  const out: Found[] = [];
  const cur = tree.cursor();
  do {
    out.push({ name: cur.name, from: cur.from, to: cur.to, text: text.slice(cur.from, cur.to) });
  } while (cur.next());
  return out;
}

/*
 * The wrappers every document has, which say nothing about a dialect. Left out of
 * `constructs` so a case reads as the thing it is about, and still available through
 * `parse` for a case that needs to know where a paragraph ended.
 */
const WRAPPERS = new Set(['Document', 'Paragraph']);

/** The construct names in `text`, in document order, without the wrappers. */
export function constructs(text: string): string[] {
  return parse(text)
    .filter((n) => !WRAPPERS.has(n.name))
    .map((n) => n.name);
}

/** Every node of a given name, with the bytes it covers. */
export function nodesNamed(text: string, name: string): Found[] {
  return parse(text).filter((n) => n.name === name);
}

/** Whether `text` holds a node of `name`, which is the question most rules ask. */
export function has(text: string, name: string): boolean {
  return parse(text).some((n) => n.name === name);
}

/**
 * How many of each construct a document holds, for the corpus ratchet.
 *
 * A count per name rather than a list of positions: the ratchet is there to catch a
 * dialect change nobody intended, and a position moves whenever anybody edits the
 * corpus while a count only moves when the parse does.
 */
export function census(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of parse(text)) if (!WRAPPERS.has(n.name)) out[n.name] = (out[n.name] ?? 0) + 1;
  return out;
}

/*
 * `$$…$$` blocks, which are **not a dialect rule**, and that is worth stating here rather
 * than discovering twice.
 *
 * The specification states the `$$` rules beside the `$…$` ones as though both were
 * parse rules. Only the inline one is: `InlineMath` is a node the parser defines, while
 * `blockMathRanges` is a function over an `EditorState` and its tree, so "top level only"
 * and "within one paragraph only" are decisions taken when the document is drawn rather
 * than when it is parsed. A case written against `parse` would look for a node that does
 * not exist and read as the rule being absent.
 *
 * So this half goes through a real state. Still no DOM: `syntaxTree` works on a plain
 * `EditorState`, and the widget is never built.
 */
export function blockMaths(text: string): { from: number; to: number; source: string }[] {
  const state = EditorState.create({ doc: text, extensions: [sheafMarkdownLanguage] });
  return blockMathRanges(state);
}
